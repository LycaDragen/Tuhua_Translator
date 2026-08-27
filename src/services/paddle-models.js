/**
 * PaddleOCR Model Manager
 * Handles downloading, caching, and loading ONNX models for PaddleOCR.
 *
 * Models are stored in the Electron user data directory under paddle-ocr-models/.
 * Each model is downloaded once and cached by filename.
 *
 * v3.13.01-fix: Replaced single ModelScope URLs with multi-source fallback system.
 * v3.13.04: Multi-language recognition model support. The detection model is shared
 *   across all languages (it finds text regions regardless of language). Recognition
 *   models were originally language-specific (one model per language).
 *
 *   Models are downloaded on-demand when their language is first selected.
 *   Following Luna Translator and VN Translator's approach of language-specific
 *   recognition models for best accuracy.
 *
 * v3.13.08: Fixed Korean/Japanese model URLs — changed from PP-OCRv4/ to PP-OCRv1/ on
 *   HuggingFace, corrected dictionary paths from ppocr/utils/ to ppocr/utils/dict/,
 *   removed non-working jsDelivr/ModelScope sources for JA/KO models.
 * v3.13.08-fix: Added minimum file size validation for model files (corrupt/too-small
 *   files are deleted and re-downloaded). Added 'lzh' (Classical Chinese) mapping.
 *   Improved Korean model URLs — added RapidOCR CDN alternative. When Korean/Japanese
 *   model download fails, the Chinese model is used as a fallback instead of falling
 *   all the way to Tesseract (Chinese model has broad CJK coverage including some
 *   Korean hangul via CJK Unified Ideographs).
 * v3.13.16: Fixed a real production bug from this exact fallback design: `urls[]` and
 *   `dictUrls[]` were tried independently, so the Korean model that actually downloaded
 *   (monkt/paddleocr-onnx, 11947 output classes) ended up paired with the official
 *   PaddlePaddle dictionary (3690 entries) — a completely different vocabulary. Nearly
 *   every predicted class index landed outside dictionary.length and got silently
 *   dropped, producing empty text with no error.
 * v3.13.17: Eliminated that bug class by construction. `REC_MODELS[key].sources` is now
 *   an array of `{ url, dictUrl }` pairs tried together — a fallback always moves both
 *   halves at once, so a model and dictionary from different sources can no longer end
 *   up paired. `_loadDictionary()` also validates the pairing at load time (see
 *   `_buildDictionary()`): it checks the model's real output class count against the
 *   dictionary and fails loudly if neither the blank-only nor blank+space convention
 *   matches, instead of silently loading a mismatched dictionary. This also catches
 *   stale cached files — `_ensureFile()`/`_ensurePairedFiles()` skip re-downloading
 *   when a file already exists, so a bad pairing left on disk from a previous version
 *   would otherwise persist across upgrades undetected.
 *
 *   Also migrated `zh`+`ja` to a single unified PP-OCRv5 mobile recognition model
 *   (ilaylow/PP_OCRv5_mobile_onnx, a paddle2onnx conversion of the official
 *   PaddlePaddle/PP-OCRv5_mobile_rec + _det). Verified empirically before switching:
 *   the mobile rec model (15.8 MB) and a much larger "server"-scale rec model from
 *   monkt/paddleocr-onnx (84.5 MB) both report exactly 18385 output classes — same
 *   vocabulary, smaller network — so mobile was chosen. Its dictionary (from
 *   monkt/paddleocr-onnx languages/chinese/dict.txt, 18383 lines) was confirmed to
 *   contain hiragana/katakana (86+94 entries, includes を and ー) and traditional
 *   Chinese characters, not just simplified — so `ja` no longer needs (or has) its own
 *   entry in REC_MODELS; `LANG_TO_REC_MODEL` maps it straight to `zh`. The previous
 *   'ja' model (PP-OCRv1, fixed 32px input height, 4400 classes) is gone. The shared
 *   detection model was upgraded to the matching PP-OCRv5 mobile det (4.6 MB — smaller
 *   than the PP-OCRv4 det it replaces), so `ko` (already on a v5 rec model since
 *   v3.13.08-fix) is no longer paired with a det model from a different generation.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { app } = require('electron');
const log = require('electron-log');

// v3.13.112 (Ronda 4c): same fix as ocr-paddle.js — the require() below
// used to run at module load time unconditionally (dlopen of a few hundred
// MB native binding on every app startup, even when the user only ever
// uses Tesseract). Deferred to first real use, memoized. See loadSessions()
// below, the sole gate every other method that touches `ort` sits behind.
let ort = null;
let _ortLoadAttempted = false;
function getOrt() {
  if (!_ortLoadAttempted) {
    _ortLoadAttempted = true;
    try {
      ort = require('onnxruntime-node');
    } catch (e) {
      log.warn('[PaddleOCR] onnxruntime-node not available:', e.message);
      log.warn('[PaddleOCR] PaddleOCR engine will not be available. Falling back to Tesseract.');
    }
  }
  return ort;
}

// ─── Language-specific model definitions ─────────────────────────────────────

// Detection model (shared across all languages — finds text regions regardless of
// script). No dictionary to pair, so this stays a plain URL fallback list rather
// than the {url, dictUrl} source pairing used for recognition models below.
const DET_MODEL = {
  id: 'det',
  urls: [
    'https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_det.onnx',
    'https://cdn.jsdelivr.net/npm/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_det_infer.onnx',
    'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx'
  ],
  filename: 'ch_PP-OCRv5_det_mobile.onnx' // v3.13.17: new filename — see note below
};

// Recognition models. Each language key's `sources` array holds {url, dictUrl} pairs
// tried together in order — see the v3.13.17 changelog note above for why this
// replaced two independently-ordered urls[]/dictUrls[] lists.
//
// v3.13.17: `filename`/`dictFilename` changed for `zh` (still v3.13.16-cached
// dictionary content differs) and there is no longer a `ja` entry at all. New
// filenames are used deliberately — `_ensureFile()`/`_ensurePairedFiles()` skip
// downloading when a file already exists at that path, so reusing the old v4/v1
// filenames would silently keep serving the old model to upgrading users instead of
// fetching the new one. This is the same lesson v3.13.16 learned the hard way with
// the Korean dictionary: a stale cached file at a familiar path is invisible until
// someone deletes it by hand.
const REC_MODELS = {
  zh: {
    id: 'rec-zh',
    sources: [
      {
        url: 'https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx',
        dictUrl: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/chinese/dict.txt'
      },
      {
        // Fallback: same vocabulary (18385 classes, verified), larger "server"-scale
        // network. Only used if the mobile source above is unreachable.
        url: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/chinese/rec.onnx',
        dictUrl: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/chinese/dict.txt'
      }
    ],
    filename: 'ch_ja_PP-OCRv5_mobile_rec.onnx',
    dictFilename: 'ppocrv5_chinese_dict.txt',
    description: 'Chinese + Japanese (PP-OCRv5 unified — kanji, kana, Latin, digits, traditional & simplified)'
  },
  ko: {
    id: 'rec-ko',
    sources: [
      {
        // v3.13.08-fix: monkt/paddleocr-onnx — the source that has actually been
        // downloading successfully. 11947 output classes, verified.
        url: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/korean/rec.onnx',
        dictUrl: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/korean/dict.txt'
      },
      {
        // Fallback: a DIFFERENT Korean model (official PP-OCRv1, 3690-class
        // vocabulary) with its own matching dictionary — this is why sources are
        // paired instead of two independent lists. Falling back to urls[1] used to
        // mean "new model, old dict" silently; now a fallback always brings its own
        // matching dict with it.
        url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv1/korean_mobile_v2.0_rec_infer.onnx',
        dictUrl: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/korean_dict.txt'
      }
    ],
    filename: 'korean_mobile_v2.0_rec_mobile.onnx',
    dictFilename: 'korean_dict.txt',
    description: 'Korean (hangul + CJK + Latin)'
  }
};

// Map from app sourceLang to recognition model key
// v3.13.17: 'ja'/'jpn' now map to 'zh' — the unified PP-OCRv5 model covers both, so
// there is no separate Japanese model to select. 'auto' also defaults to 'zh' since
// it has the broadest coverage (now including Japanese).
// v3.13.10: Added 'KR', 'kor' mappings for robustness
const LANG_TO_REC_MODEL = {
  'zh': 'zh',
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'ja': 'zh',      // v3.13.17: unified into the zh model, no separate 'ja' entry
  'jpn': 'zh',     // v3.13.10: Accept Tesseract-style code
  'ko': 'ko',
  'KR': 'ko',      // v3.13.10: Map 'KR' (common Korean code) to Korean model
  'kor': 'ko',     // v3.13.10: Accept Tesseract-style code
  'lzh': 'zh',    // v3.13.08-fix: Classical Chinese uses the zh model (v5 covers traditional too)
  'auto': 'zh',   // Default: broadest coverage (zh+ja unified)
  'en': 'zh',     // English text works fine with the zh model (has Latin subset)
  'ru': 'zh',
  'es': 'zh',
  'fr': 'zh',
  'de': 'zh',
  'pt': 'zh',
  'it': 'zh'
};

/**
 * Get the recognition model key for a given source language
 * @param {string} sourceLang - App source language code
 * @returns {string} Model key: 'zh' or 'ko'
 */
function getRecModelKeyForLang(sourceLang) {
  return LANG_TO_REC_MODEL[sourceLang] || 'zh';
}

class PaddleModelManager {
  constructor() {
    this._modelsDir = null;
    this._detSession = null;
    this._recSessions = {};   // v3.13.04: Multiple rec sessions keyed by language
    this._dictionaries = {};  // v3.13.04: Multiple dictionaries keyed by language
    this._recInputHeights = {}; // v3.13.16: Required input height per rec model (see getRecInputHeight)
    this._activeRecLang = null; // v3.13.04: Currently active recognition model language
    this._initialized = false;
    this._downloading = false;
    this._downloadProgress = { det: 0 };
    // v3.13.04: Track per-language download progress
    for (const key of Object.keys(REC_MODELS)) {
      this._downloadProgress[`rec-${key}`] = 0;
      this._downloadProgress[`dict-${key}`] = 0;
    }
  }

  /**
   * Get the models directory path (in Electron user data)
   */
  getModelsDir() {
    if (!this._modelsDir) {
      this._modelsDir = path.join(app.getPath('userData'), 'paddle-ocr-models');
    }
    return this._modelsDir;
  }

  /**
   * Check if the detection model and the Chinese (default) recognition model are downloaded.
   * v3.13.04: Other language models are checked separately via isRecModelDownloaded().
   */
  areModelsDownloaded() {
    const dir = this.getModelsDir();
    // Detection model must always be present
    if (!fs.existsSync(path.join(dir, DET_MODEL.filename))) return false;
    // Chinese rec model (default) must be present
    const zhModel = REC_MODELS.zh;
    if (!fs.existsSync(path.join(dir, zhModel.filename))) return false;
    if (!fs.existsSync(path.join(dir, zhModel.dictFilename))) return false;
    return true;
  }

  /**
   * v3.13.04: Check if a specific language's recognition model is downloaded.
   * v3.13.08-fix: Also validates minimum file size — corrupt/too-small files
   * (e.g., LFS pointers, error pages) are treated as not downloaded and will
   * be deleted and re-downloaded on next ensureRecModel() call.
   * @param {string} langKey - 'zh' or 'ko'
   * @returns {boolean}
   */
  isRecModelDownloaded(langKey) {
    const model = REC_MODELS[langKey];
    if (!model) return false;
    const dir = this.getModelsDir();
    const modelPath = path.join(dir, model.filename);
    const dictPath = path.join(dir, model.dictFilename);

    // v3.13.08-fix: Validate file sizes — ONNX models should be at least 100KB,
    // dictionary files should be at least 500 bytes
    const MIN_MODEL_SIZE = 100 * 1024; // 100KB
    const MIN_DICT_SIZE = 500;

    if (fs.existsSync(modelPath)) {
      const stat = fs.statSync(modelPath);
      if (stat.size < MIN_MODEL_SIZE) {
        log.warn(`[PaddleOCR] ${langKey} model file too small (${stat.size} bytes), deleting corrupt file`);
        try { fs.unlinkSync(modelPath); } catch (e) { /* ignore */ }
        return false;
      }
    } else {
      return false;
    }

    if (fs.existsSync(dictPath)) {
      const stat = fs.statSync(dictPath);
      if (stat.size < MIN_DICT_SIZE) {
        log.warn(`[PaddleOCR] ${langKey} dict file too small (${stat.size} bytes), deleting corrupt file`);
        try { fs.unlinkSync(dictPath); } catch (e) { /* ignore */ }
        return false;
      }
    } else {
      return false;
    }

    return true;
  }

  /**
   * v3.13.04: Get list of available (downloaded) recognition models.
   * @returns {string[]} Array of downloaded model keys (e.g. ['zh', 'ko'])
   */
  getDownloadedRecModels() {
    return Object.keys(REC_MODELS).filter(key => this.isRecModelDownloaded(key));
  }

  /**
   * Get download progress for UI display
   */
  getDownloadProgress() {
    return { ...this._downloadProgress };
  }

  /**
   * Ensure the detection model and the default (Chinese+Japanese) recognition
   * model are downloaded. Other language models (Korean) are downloaded
   * on-demand via ensureRecModel().
   * @param {function} onProgress - Callback with progress info { file, percent }
   */
  async ensureModels(onProgress) {
    const dir = this.getModelsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._downloading = true;

    // Download detection model
    await this._ensureFile(DET_MODEL.id, DET_MODEL.urls, path.join(dir, DET_MODEL.filename), onProgress);

    // Download default (Chinese+Japanese) recognition model + its paired dictionary
    await this.ensureRecModel('zh', onProgress);

    this._downloading = false;
  }

  /**
   * v3.13.04: Ensure a specific language's recognition model is downloaded.
   * Called on-demand when the user selects a language that needs a different model.
   * v3.13.17: Downloads the model and its dictionary as a paired unit — see
   * _ensurePairedFiles() for why.
   * @param {string} langKey - 'zh' or 'ko'
   * @param {function} onProgress - Callback with progress info { file, percent }
   */
  async ensureRecModel(langKey, onProgress) {
    const model = REC_MODELS[langKey];
    if (!model) {
      throw new Error(`Unknown recognition model: ${langKey}`);
    }

    const dir = this.getModelsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._downloading = true;

    await this._ensurePairedFiles(
      langKey,
      model.sources,
      path.join(dir, model.filename),
      path.join(dir, model.dictFilename),
      onProgress
    );

    this._downloading = false;
    log.info(`[PaddleOCR] ${model.description} model ready`);
  }

  /**
   * Download a single file if it doesn't exist, trying multiple URLs with fallback.
   * Used for the detection model, which has no dictionary to keep paired.
   * @private
   */
  async _ensureFile(key, urls, destPath, onProgress) {
    if (fs.existsSync(destPath)) {
      this._downloadProgress[key] = 100;
      if (onProgress) onProgress({ file: key, percent: 100 });
      return;
    }

    const errors = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const sourceLabel = `source[${i}]`;
      try {
        log.info(`[PaddleOCR] Downloading ${key} from ${sourceLabel}...`);
        await this._downloadFile(url, destPath, (percent) => {
          this._downloadProgress[key] = percent;
          if (onProgress) onProgress({ file: key, percent });
        });
        log.info(`[PaddleOCR] Downloaded ${key} from ${sourceLabel}`);
        return;
      } catch (err) {
        log.warn(`[PaddleOCR] ${sourceLabel} failed for ${key}: ${err.message}`);
        errors.push(`${sourceLabel}: ${err.message}`);
        if (fs.existsSync(destPath)) {
          try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        }
      }
    }
    throw new Error(`Failed to download ${key} from any source. Tried: ${errors.join('; ')}`);
  }

  /**
   * v3.13.17: Download a recognition model and its character dictionary as a
   * paired unit, trying each {url, dictUrl} source in order.
   *
   * This replaces the old design of two independently-ordered fallback lists
   * (urls[] and dictUrls[]), which is how the v3.13.16 Korean bug happened: the
   * model download succeeded from source A while the dictionary download
   * succeeded from source B, and nothing connected those two outcomes — they
   * were just "whichever URL responded first" in each list, unrelated to each
   * other. A model and its dictionary describe the same fixed vocabulary; they
   * are not independently substitutable, so they must not be selected
   * independently either.
   *
   * On failure from a source, BOTH files are deleted (even if only one of the
   * two downloads actually failed) before trying the next source, so a
   * mismatched pair can never be left on disk mid-fallback.
   * @private
   */
  async _ensurePairedFiles(langKey, sources, modelPath, dictPath, onProgress) {
    const modelKey = `rec-${langKey}`;
    const dictKey = `dict-${langKey}`;

    if (fs.existsSync(modelPath) && fs.existsSync(dictPath)) {
      this._downloadProgress[modelKey] = 100;
      this._downloadProgress[dictKey] = 100;
      if (onProgress) onProgress({ file: modelKey, percent: 100 });
      return;
    }

    const errors = [];
    for (let i = 0; i < sources.length; i++) {
      const { url, dictUrl } = sources[i];
      const sourceLabel = `source[${i}]`;
      try {
        if (!fs.existsSync(modelPath)) {
          log.info(`[PaddleOCR] Downloading ${modelKey} model from ${sourceLabel}...`);
          await this._downloadFile(url, modelPath, (percent) => {
            this._downloadProgress[modelKey] = percent;
            if (onProgress) onProgress({ file: modelKey, percent });
          });
        }
        if (!fs.existsSync(dictPath)) {
          log.info(`[PaddleOCR] Downloading ${dictKey} from ${sourceLabel}...`);
          await this._downloadFile(dictUrl, dictPath, (percent) => {
            this._downloadProgress[dictKey] = percent;
            if (onProgress) onProgress({ file: dictKey, percent });
          });
        }
        log.info(`[PaddleOCR] ${langKey} model+dictionary ready from ${sourceLabel}`);
        return;
      } catch (err) {
        log.warn(`[PaddleOCR] ${sourceLabel} failed for ${langKey}: ${err.message}`);
        errors.push(`${sourceLabel}: ${err.message}`);
        // v3.13.17: Delete BOTH files on any failure, not just the one that
        // failed — this is the step that prevents a mismatched pair from
        // surviving a partial failure mid-fallback.
        if (fs.existsSync(modelPath)) { try { fs.unlinkSync(modelPath); } catch (e) { /* ignore */ } }
        if (fs.existsSync(dictPath)) { try { fs.unlinkSync(dictPath); } catch (e) { /* ignore */ } }
      }
    }
    throw new Error(`Failed to download ${langKey} model+dictionary from any source. Tried: ${errors.join('; ')}`);
  }

  /**
   * Load detection session and the default (Chinese+Japanese) recognition session.
   * Call ensureModels() first.
   * @param {object} options - Session options
   */
  async loadSessions(options = {}) {
    if (!getOrt()) {
      throw new Error('onnxruntime-node is not available');
    }

    if (!this.areModelsDownloaded()) {
      throw new Error('Models not downloaded. Call ensureModels() first.');
    }

    const dir = this.getModelsDir();
    const numThreads = options.numThreads || 4;

    const sessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: numThreads,
      interOpNumThreads: numThreads
    };

    // Load detection model
    log.info('[PaddleOCR] Loading detection model...');
    this._detSession = await ort.InferenceSession.create(
      path.join(dir, DET_MODEL.filename),
      sessionOptions
    );
    log.info('[PaddleOCR] Detection model loaded');

    // Load default (Chinese+Japanese) recognition model
    await this._loadRecSession('zh', sessionOptions);

    this._initialized = true;
    this._activeRecLang = 'zh';
    log.info('[PaddleOCR] All models loaded and ready');
  }

  /**
   * v3.13.04: Load a recognition session for a specific language.
   * If the session is already loaded, just switch to it.
   * If the model file exists but isn't loaded, load it.
   * If the model file doesn't exist, throw (caller should download first).
   * @param {string} langKey - 'zh' or 'ko'
   * @param {object} sessionOptions - ONNX session options (optional, uses defaults if not provided)
   * @private
   */
  async _loadRecSession(langKey, sessionOptions) {
    if (!sessionOptions) {
      sessionOptions = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: 4,
        interOpNumThreads: 4
      };
    }

    const model = REC_MODELS[langKey];
    if (!model) throw new Error(`Unknown recognition model: ${langKey}`);

    const dir = this.getModelsDir();

    // Load recognition model
    log.info(`[PaddleOCR] Loading ${model.description} recognition model...`);
    this._recSessions[langKey] = await ort.InferenceSession.create(
      path.join(dir, model.filename),
      sessionOptions
    );
    log.info(`[PaddleOCR] ${model.description} recognition model loaded`);

    // v3.13.16: PP-OCR recognition models don't all share the same required
    // input height. Read the real requirement from the session itself instead
    // of assuming a constant.
    this._recInputHeights[langKey] = this._detectInputHeight(this._recSessions[langKey]);
    log.info(`[PaddleOCR] ${langKey} recognition model input height: ${this._recInputHeights[langKey]}`);

    // Load dictionary (v3.13.17: validated against the model's real class count)
    await this._loadDictionary(langKey, dir);
  }

  /**
   * v3.13.16: Read the required input height from a loaded recognition
   * session's input shape. dims are [batch, channels, height, width]; batch
   * and width are dynamic ("" or a symbolic name) for every model observed,
   * but height may be a fixed number (e.g. the old PP-OCRv1 'ja' model
   * required exactly 32) or also dynamic (e.g. the PP-OCRv5 models, which
   * accept 48). Falls back to 48 — what this pipeline has always used
   * successfully — when the model reports a dynamic/unreadable height.
   * @private
   */
  _detectInputHeight(session) {
    try {
      const shape = session.inputMetadata[0].shape;
      const height = shape[2];
      if (typeof height === 'number' && height > 0) return height;
    } catch (e) {
      log.debug('[PaddleOCR] Could not read input height from model metadata:', e.message);
    }
    return 48;
  }

  /**
   * v3.13.16: Get the required recognition input height for a language.
   * @param {string} langKey - 'zh' or 'ko'
   * @returns {number}
   */
  getRecInputHeight(langKey) {
    return this._recInputHeights[langKey] || 48;
  }

  /**
   * v3.13.17: Read the number of output classes from a loaded recognition
   * session — used to validate the character dictionary against the model
   * that will actually produce predictions. Output shape is
   * [batch, timesteps, classes]; classes is the last dimension.
   * @private
   */
  _getOutputClassCount(session) {
    try {
      const shape = session.outputMetadata[0].shape;
      const numClasses = shape[shape.length - 1];
      if (typeof numClasses === 'number' && numClasses > 0) return numClasses;
    } catch (e) {
      log.debug('[PaddleOCR] Could not read output class count from model metadata:', e.message);
    }
    return null;
  }

  /**
   * v3.13.17: Build the CTC dictionary array from raw character lines,
   * choosing between the 'blank'-only and 'blank'+trailing-space conventions
   * based on which one actually matches the model's real output class count
   * — instead of always appending a trailing space and hoping, which is what
   * this pipeline did before.
   *
   * That "always append ' '" assumption was harmlessly wrong for the old
   * Japanese model (4399 dict lines + blank = 4400, matching its class count
   * exactly; the space made it 4401, one dead unreachable entry) but is not
   * safe to assume for every future model. More importantly, this is also
   * where the class-count-vs-dictionary mismatch from v3.13.16 gets caught:
   * if NEITHER convention matches, that means the model and dictionary
   * describe different vocabularies — most likely a stale cached file from a
   * previous version, or (like the Korean bug) a source mismatch. Failing
   * loudly here beats decodeRecognition() silently dropping most predictions
   * because their class index falls outside dictionary.length.
   *
   * @param {string[]} lines - Raw dictionary lines (one character per line)
   * @param {number|null} numClasses - The model's real output class count, or
   *   null if it couldn't be read
   * @param {string} label - For log/error messages, e.g. "zh (file)"
   * @returns {string[]}
   * @private
   */
  _buildDictionary(lines, numClasses, label) {
    const withBlankOnly = ['blank', ...lines];
    const withBlankAndSpace = ['blank', ...lines, ' '];

    if (numClasses === null) {
      log.warn(`[PaddleOCR] ${label}: could not read the model's output class count — ` +
        `defaulting to the blank+space convention unverified. If recognition produces ` +
        `mostly empty/garbled text, this pairing may be wrong.`);
      return withBlankAndSpace;
    }

    if (withBlankAndSpace.length === numClasses) {
      log.info(`[PaddleOCR] ${label} dictionary loaded (${withBlankAndSpace.length} chars, blank+space convention, matches model's ${numClasses} classes)`);
      return withBlankAndSpace;
    }

    if (withBlankOnly.length === numClasses) {
      log.info(`[PaddleOCR] ${label} dictionary loaded (${withBlankOnly.length} chars, blank-only convention, matches model's ${numClasses} classes)`);
      return withBlankOnly;
    }

    // v3.13.17: Neither convention matches — this is exactly how the v3.13.16
    // Korean bug manifested (dictionary.length=3690 vs model classes=11947).
    throw new Error(
      `${label}: dictionary/model mismatch — model has ${numClasses} output classes, ` +
      `but the dictionary has ${lines.length} character lines (${withBlankOnly.length} ` +
      `entries with blank, ${withBlankAndSpace.length} with blank+space). Neither matches. ` +
      `The cached model and dictionary files most likely came from different sources or a ` +
      `previous app version — delete them from the model cache directory (${this.getModelsDir()}) ` +
      `and let them re-download.`
    );
  }

  /**
   * Load character dictionary for a specific language.
   * Tries ONNX model metadata first, falls back to file.
   * v3.13.17: Now validated against the model's real output class count via
   * _buildDictionary() — see its docstring for why.
   * @private
   */
  async _loadDictionary(langKey, dir) {
    const model = REC_MODELS[langKey];
    const session = this._recSessions[langKey];
    const numClasses = this._getOutputClassCount(session);

    // Try model metadata first
    try {
      const metadata = session.modelMetadata;
      if (metadata && metadata.customMetadataMap && metadata.customMetadataMap.character) {
        const lines = metadata.customMetadataMap.character.split(/\r?\n/);
        this._dictionaries[langKey] = this._buildDictionary(lines, numClasses, `${langKey} (model metadata)`);
        return;
      }
    } catch (e) {
      log.debug(`[PaddleOCR] Could not read ${langKey} dictionary from model metadata:`, e.message);
    }

    // Fallback: load from file
    const dictPath = path.join(dir, model.dictFilename);
    if (fs.existsSync(dictPath)) {
      const content = fs.readFileSync(dictPath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(line => line.length > 0);
      this._dictionaries[langKey] = this._buildDictionary(lines, numClasses, `${langKey} (file)`);
    } else {
      throw new Error(`${langKey} character dictionary not found at ${dictPath}`);
    }
  }

  /**
   * v3.13.04: Switch the active recognition model to a different language.
   * Downloads the model on-demand if not yet available.
   * @param {string} langKey - 'zh' or 'ko'
   * @param {function} onProgress - Download progress callback (if download needed)
   */
  async switchRecModel(langKey, onProgress) {
    if (langKey === this._activeRecLang) return; // Already active

    const model = REC_MODELS[langKey];
    if (!model) {
      log.warn(`[PaddleOCR] Unknown language model: ${langKey}, keeping current`);
      return;
    }

    // Check if model is downloaded
    if (!this.isRecModelDownloaded(langKey)) {
      log.info(`[PaddleOCR] ${langKey} model not downloaded, downloading now...`);
      await this.ensureRecModel(langKey, onProgress);
    }

    // Check if already loaded in memory
    if (!this._recSessions[langKey]) {
      await this._loadRecSession(langKey);
    }

    this._activeRecLang = langKey;
    log.info(`[PaddleOCR] Switched to ${model.description} recognition model`);
  }

  /**
   * Get the detection ONNX session
   */
  getDetSession() {
    return this._detSession;
  }

  /**
   * Get the currently active recognition ONNX session
   */
  getRecSession() {
    return this._recSessions[this._activeRecLang] || this._recSessions['zh'];
  }

  /**
   * Get the currently active character dictionary
   */
  getDictionary() {
    return this._dictionaries[this._activeRecLang] || this._dictionaries['zh'];
  }

  /**
   * Get the currently active recognition model language key
   */
  getActiveRecLang() {
    return this._activeRecLang;
  }


  /**
   * Release all ONNX sessions
   */
  async release() {
    this._detSession = null;
    this._recSessions = {};
    this._dictionaries = {};
    this._activeRecLang = null;
    this._initialized = false;
    log.info('[PaddleOCR] Sessions released');
  }

  /**
   * Delete all downloaded model files
   */
  async deleteModels() {
    await this.release();
    const dir = this.getModelsDir();
    if (fs.existsSync(dir)) {
      // Delete all known model files
      const filesToDelete = [DET_MODEL.filename];
      for (const model of Object.values(REC_MODELS)) {
        filesToDelete.push(model.filename);
        filesToDelete.push(model.dictFilename);
      }
      for (const filename of filesToDelete) {
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      // Reset progress
      this._downloadProgress = { det: 0 };
      for (const key of Object.keys(REC_MODELS)) {
        this._downloadProgress[`rec-${key}`] = 0;
        this._downloadProgress[`dict-${key}`] = 0;
      }
      log.info('[PaddleOCR] All model files deleted');
    }
  }

  /**
   * Download a file with progress tracking and redirect support.
   * Handles cross-protocol redirects (HTTP↔HTTPS) and relative URLs.
   * @private
   */
  _downloadFile(url, destPath, onProgress, _maxRedirects = 10) {
    return new Promise((resolve, reject) => {
      let redirectCount = 0;

      const request = (currentUrl) => {
        if (redirectCount >= _maxRedirects) {
          reject(new Error(`Too many redirects (${_maxRedirects})`));
          return;
        }

        const currentProtocol = currentUrl.startsWith('https') ? https : http;

        const req = currentProtocol.get(currentUrl, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            redirectCount++;
            let redirectUrl = response.headers.location;
            if (!redirectUrl.startsWith('http')) {
              const parsed = new URL(currentUrl);
              if (redirectUrl.startsWith('/')) {
                redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
              } else {
                redirectUrl = `${parsed.protocol}//${parsed.host}/${redirectUrl}`;
              }
            }
            log.debug(`[PaddleOCR] Redirect ${response.statusCode}: ${currentUrl} → ${redirectUrl}`);
            response.resume();
            request(redirectUrl);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode} for ${currentUrl}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'], 10) || 0;
          let downloadedSize = 0;
          const chunks = [];

          response.on('data', (chunk) => {
            chunks.push(chunk);
            downloadedSize += chunk.length;
            if (totalSize > 0 && onProgress) {
              onProgress(Math.round((downloadedSize / totalSize) * 100));
            }
          });

          response.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (buffer.length < 1024) {
              reject(new Error(`Downloaded file too small (${buffer.length} bytes), likely an error page`));
              return;
            }
            fs.writeFileSync(destPath, buffer);
            if (onProgress) onProgress(100);
            resolve();
          });

          response.on('error', (err) => {
            reject(err);
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.setTimeout(30000, () => {
          req.destroy(new Error('Connection timeout (30s)'));
        });
      };

      request(url);
    });
  }
}

module.exports = { PaddleModelManager, getRecModelKeyForLang, REC_MODELS };
