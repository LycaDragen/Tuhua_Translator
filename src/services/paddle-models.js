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
 *   models are language-specific:
 *   - Chinese (ch_PP-OCRv4_rec): Default, supports CJK + Latin + digits (6625 chars)
 *   - Japanese (japan_mobile_v2.0_rec): Dedicated JP model with proper kana/kanji support
 *   - Korean (korean_mobile_v2.0_rec): Dedicated KR model with hangul support
 *
 *   When sourceLang is set to 'ja', the Japanese recognition model is auto-selected.
 *   When sourceLang is 'ko', the Korean model is used. For 'zh' or 'auto', the
 *   Chinese model (which has the broadest character coverage) is used.
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
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { app } = require('electron');
const log = require('electron-log');

// Try to load onnxruntime-node — graceful degradation if not available
let ort = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  log.warn('[PaddleOCR] onnxruntime-node not available:', e.message);
  log.warn('[PaddleOCR] PaddleOCR engine will not be available. Falling back to Tesseract.');
}

// ─── Language-specific model definitions ─────────────────────────────────────

// Detection model (shared across all languages — finds text regions regardless of script)
const DET_MODEL = {
  id: 'det',
  urls: [
    'https://cdn.jsdelivr.net/npm/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_det_infer.onnx',
    'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx',
    'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx'
  ],
  filename: 'ch_PP-OCRv4_det_mobile.onnx'
};

// Recognition models (one per language group)
// Following Luna Translator's model zoo structure:
// https://github.com/HIllya51/LunaTranslator/tree/main/LunaTranslator/ocr
const REC_MODELS = {
  zh: {
    id: 'rec-zh',
    urls: [
      'https://cdn.jsdelivr.net/npm/paddle-ocr-onnx-models@0.2.0/models/ch_PP-OCRv4_rec_infer.onnx',
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx',
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx'
    ],
    filename: 'ch_PP-OCRv4_rec_mobile.onnx',
    dictUrls: [
      'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt',
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile/ppocr_keys_v1.txt'
    ],
    dictFilename: 'ppocr_keys_v1.txt',
    description: 'Chinese (broad CJK support — kanji, kana, Latin, digits)'
  },
  ja: {
    id: 'rec-ja',
    urls: [
      // v3.13.08: jsDelivr does NOT include Japanese model — removed (was 404)
      // v3.13.08: ModelScope unreliable for Japanese model — removed
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv1/japan_rec_crnn.onnx',
      // v3.13.08: Alternative source — monkt/paddleocr-onnx repo
      'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/japanese/rec.onnx'
    ],
    filename: 'japan_mobile_v2.0_rec_mobile.onnx',
    dictUrls: [
      // v3.13.08: Corrected path — PaddleOCR moved dicts to ppocr/utils/dict/
      'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/japan_dict.txt',
      'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/japanese/dict.txt'
    ],
    dictFilename: 'japan_dict.txt',
    description: 'Japanese (proper kana + kanji readings)'
  },
  ko: {
    id: 'rec-ko',
    urls: [
      // v3.13.08-fix: Primary source — monkt/paddleocr-onnx (most reliable for Korean)
      'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/korean/rec.onnx',
      // v3.13.08-fix: Alternative — SWHL/RapidOCR PP-OCRv1 folder
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv1/korean_mobile_v2.0_rec_infer.onnx',
      // v3.13.08-fix: Third fallback — RapidAI ModelScope (Chinese mirror)
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv1/rec/korean_mobile_v2.0_rec_infer.onnx'
    ],
    filename: 'korean_mobile_v2.0_rec_mobile.onnx',
    // v3.13.16: dictUrls[0] MUST match whichever model URL actually succeeds.
    // urls[0] (monkt/paddleocr-onnx rec.onnx) is the one that has been
    // downloading successfully — introspecting the .onnx file shows it has
    // 11947 output classes. The previous dictUrls[0] (PaddlePaddle's official
    // korean_dict.txt, 3688 lines / 3690 with blank+space) belongs to a
    // DIFFERENT Korean model and was silently mismatched with it: nearly
    // every predicted class index landed outside dictionary.length and
    // decodeRecognition() dropped it, producing empty text with no error.
    // Fetched monkt's dict.txt directly to confirm: 11945 lines / 11947 with
    // blank+space — exact match for the model that is actually in use.
    //
    // Known fragility: urls[] and dictUrls[] are each tried independently in
    // order, so if urls[0] (monkt) becomes unavailable and download falls
    // back to urls[1]/[2] (the official PP-OCRv1 model), this pairing breaks
    // again — the fallback model wants the PaddlePaddle dict, not monkt's.
    // A real fix would fetch model+dict as one pinned pair instead of two
    // independently-ordered fallback lists. Flagging for Phase 2/3 rather
    // than restructuring the download system as part of this hotfix.
    dictUrls: [
      'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/korean/dict.txt',
      'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/korean_dict.txt'
    ],
    dictFilename: 'korean_dict.txt',
    description: 'Korean (hangul + CJK + Latin)'
  }
};

// Map from app sourceLang to recognition model key
// 'auto' defaults to 'zh' because the Chinese model has the broadest CJK coverage
// v3.13.10: Added 'KR', 'kor', 'jpn' mappings for robustness
const LANG_TO_REC_MODEL = {
  'zh': 'zh',
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'ja': 'ja',
  'jpn': 'ja',     // v3.13.10: Accept Tesseract-style code
  'ko': 'ko',
  'KR': 'ko',      // v3.13.10: Map 'KR' (common Korean code) to Korean model
  'kor': 'ko',     // v3.13.10: Accept Tesseract-style code
  'lzh': 'zh',    // v3.13.08-fix: Classical Chinese uses Chinese model
  'auto': 'zh',   // Default: Chinese model for broadest coverage
  'en': 'zh',     // English text works fine with Chinese model (has Latin subset)
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
 * @returns {string} Model key: 'zh', 'ja', or 'ko'
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
   * Check if onnxruntime-node is available
   */
  isRuntimeAvailable() {
    return ort !== null;
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
   * @param {string} langKey - 'zh', 'ja', or 'ko'
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
   * @returns {string[]} Array of downloaded model keys (e.g. ['zh', 'ja'])
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
   * Ensure the detection model and the default (Chinese) recognition model are downloaded.
   * Other language models are downloaded on-demand via ensureRecModel().
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

    // Download default (Chinese) recognition model + dictionary
    const zhModel = REC_MODELS.zh;
    await this._ensureFile(zhModel.id, zhModel.urls, path.join(dir, zhModel.filename), onProgress);
    await this._ensureFile('dict-zh', zhModel.dictUrls, path.join(dir, zhModel.dictFilename), onProgress);

    this._downloading = false;
  }

  /**
   * v3.13.04: Ensure a specific language's recognition model is downloaded.
   * Called on-demand when the user selects a language that needs a different model.
   * @param {string} langKey - 'zh', 'ja', or 'ko'
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

    // Download recognition model
    await this._ensureFile(model.id, model.urls, path.join(dir, model.filename), onProgress);
    // Download dictionary
    await this._ensureFile(`dict-${langKey}`, model.dictUrls, path.join(dir, model.dictFilename), onProgress);

    this._downloading = false;
    log.info(`[PaddleOCR] ${model.description} model ready`);
  }

  /**
   * Download a single file if it doesn't exist, trying multiple URLs with fallback.
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
      const sourceLabel = i === 0 ? 'jsDelivr' : (i === 1 ? 'ModelScope' : 'HuggingFace');
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
   * Load detection session and the default (Chinese) recognition session.
   * Call ensureModels() first.
   * @param {object} options - Session options
   */
  async loadSessions(options = {}) {
    if (!ort) {
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

    // Load default (Chinese) recognition model
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
   * @param {string} langKey - 'zh', 'ja', or 'ko'
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
    // input height. Introspecting the downloaded .onnx files showed the 'ja'
    // model has a FIXED height of 32 (not the 48 this pipeline used to
    // hardcode for every model), which crashed every single 'ja' recognition
    // call with "Got invalid dimensions for input: x ... Got: 48 Expected: 32".
    // Read the real requirement from the session itself instead of assuming.
    this._recInputHeights[langKey] = this._detectInputHeight(this._recSessions[langKey]);
    log.info(`[PaddleOCR] ${langKey} recognition model input height: ${this._recInputHeights[langKey]}`);

    // Load dictionary
    await this._loadDictionary(langKey, dir);
  }

  /**
   * v3.13.16: Read the required input height from a loaded recognition
   * session's input shape. dims are [batch, channels, height, width]; batch
   * and width are dynamic ("" or a symbolic name) for every model observed,
   * but height may be a fixed number (e.g. the 'ja' model requires exactly
   * 32) or also dynamic (e.g. 'zh', which accepts 48). Falls back to 48 —
   * the PP-OCRv4 default — when the model reports a dynamic/unreadable
   * height, since that is what this pipeline has always used successfully
   * for 'zh' and 'ko'.
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
   * @param {string} langKey - 'zh', 'ja', or 'ko'
   * @returns {number}
   */
  getRecInputHeight(langKey) {
    return this._recInputHeights[langKey] || 48;
  }

  /**
   * v3.13.04: Switch the active recognition model to a different language.
   * Downloads the model on-demand if not yet available.
   * @param {string} langKey - 'zh', 'ja', or 'ko'
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
   * Load character dictionary for a specific language.
   * Tries ONNX model metadata first, falls back to file.
   * @private
   */
  async _loadDictionary(langKey, dir) {
    const model = REC_MODELS[langKey];
    const session = this._recSessions[langKey];

    // Try model metadata first
    try {
      const metadata = session.modelMetadata;
      if (metadata && metadata.customMetadataMap && metadata.customMetadataMap.character) {
        this._dictionaries[langKey] = ['blank', ...metadata.customMetadataMap.character.split(/\r?\n/), ' '];
        log.info(`[PaddleOCR] ${langKey} dictionary loaded from model metadata (${this._dictionaries[langKey].length} chars)`);
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
      this._dictionaries[langKey] = ['blank', ...lines, ' '];
      log.info(`[PaddleOCR] ${langKey} dictionary loaded from file (${this._dictionaries[langKey].length} chars)`);
    } else {
      throw new Error(`${langKey} character dictionary not found at ${dictPath}`);
    }
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
   * Check if models are loaded and ready for inference
   */
  isReady() {
    return this._initialized && this._detSession &&
           (this._recSessions['zh'] || this._recSessions[this._activeRecLang]) &&
           (this._dictionaries['zh'] || this._dictionaries[this._activeRecLang]);
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
