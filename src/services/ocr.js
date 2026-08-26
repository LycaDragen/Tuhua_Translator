/**
 * OCR Service - Tesseract.js + PaddleOCR Integration
 *
 * Provides text recognition from screen captures using tesseract.js or PaddleOCR.
 * Supports language mapping, pre-processing, and auto-capture with change detection.
 *
 * v3.9.8: Text similarity dedup — if new OCR text is >80% similar to the last
 *         emitted text, it is NOT re-emitted for translation. This prevents
 *         re-translating the same game dialogue when OCR produces slightly
 *         different readings (e.g., "woke up and g" vs "woke up and got").
 *         Also strips Unicode smart quotes, fixes truncated word boundaries,
 *         and normalizes punctuation for cleaner output.
 * v3.13.03: CJK-aware minimum character count filter (fixes 世界 being skipped),
 *           improved PaddleOCR text cleaning for Japanese, multi-region filtering.
 * v3.13.05: Lowered OCR confidence thresholds to allow low-quality text through
 *           to translation engine. Added furigana cleanup in _cleanPaddleOcrText()
 *           (removes ruby annotations, parenthetical kana readings, "En Kanji"
 *           noise). Improved Korean text detection in confidence filters.
 * v3.13.07: Removed hard confidence threshold for PaddleOCR results. The
 *   translation engine handles imperfect OCR better than no input. Only skip
 *   truly empty results. Previous thresholds (v3.13.06: CJK: 0.05, Latin: 0.10)
 *   still rejected too many partially correct results (RPG battle, low-quality).
 *   NOTE: Tesseract _minConfidence was NOT lowered in v3.13.07 — this was a
 *   bug causing tests 09/10 to fail. Fixed in v3.13.08 by lowering Tesseract
 *   threshold to 0 and making it configurable via ocrMinConfidence store key.
 * v3.13.08-fix: Raised garbled text ratio from 0.6 to 0.8 — only skip if >80%
 *   of words are garbled (was 60%). Made _isMostlyGarbled() CJK-aware: for text
 *   containing CJK characters, the garbled word check is skipped entirely since
 *   vowel/consonant heuristics don't apply to Chinese/Japanese/Korean. Also raised
 *   _cleanOcrText() garbled line ratio from 0.4 to 0.6 to match. Added 'lzh'
 *   (Classical Chinese) to LANG_MAP.
 */
const Tesseract = require('tesseract.js');
const EventEmitter = require('events');
const log = require('electron-log');
const PaddleOCREngine = require('./ocr-paddle');

// Map from app language codes to tesseract language codes
// v3.13.10: Added 'KR', 'kor', 'jpn', 'chi_sim' reverse mappings for robustness
const LANG_MAP = {
  'ja': 'jpn',
  'jpn': 'jpn',    // v3.13.10: Accept Tesseract-style codes too
  'en': 'eng',
  'eng': 'eng',    // v3.13.10: Accept Tesseract-style codes too
  'zh': 'chi_sim',
  'zh-CN': 'chi_sim',  // v3.13.10: Accept common locale codes
  'zh-TW': 'chi_sim',
  'lzh': 'chi_sim',  // v3.13.08-fix: Classical Chinese uses simplified Chinese Tesseract model
  'ko': 'kor',
  'KR': 'kor',     // v3.13.10: Map 'KR' (common Korean code) to Tesseract 'kor'
  'kor': 'kor',    // v3.13.10: Accept Tesseract-style code
  'ru': 'rus',
  'fr': 'fra',
  'de': 'deu',
  'es': 'spa',
  'pt': 'por',
  'it': 'ita',
  'th': 'tha',
  'vi': 'vie',
  'id': 'ind',
  'ar': 'ara',
  'hi': 'hin',
  'tr': 'tur',
  'nl': 'nld',
  'pl': 'pol',
  'uk': 'ukr',
  'auto': 'eng'  // Default to English for OCR — more universal, cleaner results
};

// v3.13.79: short English words that are real words on their own, not OCR
// garbage — shared by _isGarbledWord() (per-word classification) and
// _cleanOcrText()'s Step 11 (trailing-word truncation), which used to
// blindly strip ANY 1-2 letter word at the end of a capture ("It is OK" →
// "It is", "12:45 PM" → "12:45"). Single source of truth so the two checks
// can't drift apart.
const COMMON_SHORT_WORDS = new Set([
  'i', 'a', 'an', 'am', 'be', 'do', 'go', 'he', 'in', 'is',
  'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up',
  'us', 'we', 'as', 'at', 'by', 'if', 'ok', 'oh',
  'pm', 'hi', 'ah', 'eh', 'um'
]);

// v3.13.79: the lone-single-letter-noise filter (the class right below this
// deletes stray single Latin characters left over from decorative UI/border
// artifacts) has the exact same blind spot the 'I' bug had: a real single
// uppercase letter that's meaningful on its own gets swept up too — most
// commonly a button-prompt idiom ("Press X to skip", "Hold A", "Y to jump").
// Rather than exempting a fixed set of letters (any of A/B/X/Y/L/R/Z could
// be the real prompt letter, and exempting them all would gut the filter
// for genuinely stray capitals elsewhere), this checks CONTEXT: a letter is
// protected only when a prompt verb sits right before it or a prompt
// continuation sits right after it. Everything else keeps being filtered as
// before.
const BUTTON_PROMPT_BEFORE = /\b(?:press|hold|tap|hit)\s*$/i;
const BUTTON_PROMPT_AFTER = /^\s*(?:to|key|button)\b/i;

function isProtectedButtonLetter(fullText, matchIndex, matchLength) {
  const before = fullText.slice(0, matchIndex);
  const after = fullText.slice(matchIndex + matchLength);
  return BUTTON_PROMPT_BEFORE.test(before) || BUTTON_PROMPT_AFTER.test(after);
}

/**
 * v3.13.77 (Stage 4, OCR-refinement round): BT.601 luma grayscale, in place,
 * over a BGRA bitmap (electron's nativeImage.toBitmap() format — B,G,R,A
 * byte order). Alpha is left untouched. Both PaddleOCR's DB detection head
 * and Tesseract's LSTM do their own internal normalization, so this is
 * expected to be close to a no-op quality-wise — it mainly matters for
 * making the `grayscale: true` preprocessing option (previously a
 * declared-but-inert flag with zero code behind it) actually do what it
 * claims. Module-level, not a class method: it has no dependency on OcrService
 * state, and scripts/test-ocr-images.js can reuse it directly if needed.
 */
function grayscaleBGRA(bitmap) {
  for (let i = 0; i < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    const luma = Math.round(0.114 * b + 0.587 * g + 0.299 * r);
    bitmap[i] = luma;
    bitmap[i + 1] = luma;
    bitmap[i + 2] = luma;
  }
}

/**
 * v3.13.77 (Stage 4, OCR-refinement round): Otsu's method — finds the
 * threshold that maximizes between-class variance of an ALREADY-GRAYSCALE
 * BGRA bitmap (call grayscaleBGRA() first), then binarizes in place (0 or
 * 255 per pixel). Off by default (`otsuThreshold: false`) — real VN
 * dialogue text with an outline or drop shadow loses those soft edges to a
 * hard binarization; kept as an explicit opt-in for games whose text is
 * flat-colored with no outline, where it may help on a noisy background.
 */
function otsuThresholdBGRA(bitmap) {
  const histogram = new Array(256).fill(0);
  const pixelCount = bitmap.length / 4;
  for (let i = 0; i < bitmap.length; i += 4) {
    histogram[bitmap[i]]++; // already grayscale — B/G/R are identical
  }

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t];

  let sumB = 0;
  let weightB = 0;
  let maxVariance = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightB += histogram[t];
    if (weightB === 0) continue;
    const weightF = pixelCount - weightB;
    if (weightF === 0) break;

    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  for (let i = 0; i < bitmap.length; i += 4) {
    const v = bitmap[i] >= threshold ? 255 : 0;
    bitmap[i] = v;
    bitmap[i + 1] = v;
    bitmap[i + 2] = v;
  }
}

class OcrService extends EventEmitter {
  constructor() {
    super();
    this._worker = null;
    this._language = 'eng';
    this._sourceLang = 'auto';
    this._isReady = false;
    this._isBusy = false;
    this._captureTimeout = null;
    this._isAutoCapturing = false;
    this._lastImageData = null;
    this._changeThreshold = 5;
    // v3.13.77 (Stage 4, OCR-refinement round): replaces the old
    // `_preprocessing` shape ({grayscale, threshold, thresholdValue,
    // contrast, contrastValue}), which was almost entirely cosmetic —
    // grayscale/contrast had zero code branches (pure no-ops), and
    // `threshold` set `tessedit_threshold_value`, which isn't a real
    // Tesseract variable name. These are the options that actually do
    // something now, tuned by sweeping scripts/test-ocr-images.js
    // --tess-upscale=/--tess-psm= against the bench (see the plan for the
    // grid results): upscaleFactor resamples the crop before Tesseract sees
    // it, psm sets tessedit_pageseg_mode, otsuThreshold applies a real
    // Otsu binarization (off by default — real VN text with outline/
    // antialiasing tends to lose strokes to it; only worth enabling if a
    // specific game's bench numbers ask for it).
    this._tesseractOptions = {
      upscaleFactor: 1.0,
      psm: '6', // Tesseract's own compiled default (SINGLE_BLOCK)
      otsuThreshold: false
    };
    this._preprocessing = { grayscale: true };
    this._autoCaptureMs = 3500; // v3.9.9: reduced from 7000ms for faster scanning
    this._initialized = false;
    this._lastEmittedText = '';
    this._captureFn = null;
    // v3.9.8: Similarity threshold for text dedup.
    // If new text shares >80% of words with last emitted text, skip it.
    this._similarityThreshold = 0.80;
    // v3.13.01: PaddleOCR engine support
    this._ocrEngine = 'tesseract'; // 'tesseract' or 'paddle'
    this._paddleEngine = new PaddleOCREngine();
    // v3.13.04: Track source language for PaddleOCR model selection
    this._paddleSourceLang = 'auto';
    // v3.13.79 (Fase 3, round-3 plan): rolling window of the last 10
    // Tesseract quality samples (garbled-vs-good, plus confidence), used to
    // suggest switching to PaddleOCR when a game's typography is
    // persistently readable to Paddle but not Tesseract — same real-world
    // gap the round-2 bench measured for Echo/Lust Shards (95-100% on
    // Paddle vs 79-92% on Tesseract). See _trackTesseractQualityAndMaybeAdvise().
    this._tesseractQualityWindow = [];
    this._engineAdviceEmitted = false;
    // v3.13.79: consecutive-frame counter for Tesseract auto-detect (see
    // _maybeSwitchTesseractLangForAutoDetect()) — a single bad frame (e.g. a
    // clock/counter Tesseract-English can't read) used to be enough to
    // switch the whole session to Japanese/Korean. Now non-hangul evidence
    // has to repeat for a few frames before it's trusted; a real hangul
    // sighting is still immediate (see the function for why).
    this._autoDetectFailStreak = 0;
  }

  /**
   * v3.13.01: Set the OCR engine ('tesseract' or 'paddle')
   */
  setOcrEngine(engine) {
    if (engine !== 'tesseract' && engine !== 'paddle') {
      log.warn(`[OCR] Unknown engine: ${engine}, defaulting to tesseract`);
      engine = 'tesseract';
    }
    if (engine === 'paddle' && !PaddleOCREngine.isAvailable()) {
      log.warn('[OCR] PaddleOCR not available (onnxruntime-node missing), falling back to tesseract');
      engine = 'tesseract';
    }
    this._ocrEngine = engine;
    log.info(`[OCR] Engine set to: ${this._ocrEngine}`);
    // v3.13.79: an engine switch (in either direction) makes the rolling
    // quality window stale — a window built while reading Tesseract output
    // shouldn't judge Paddle, or vice versa, and a user who already
    // switched to Paddle doesn't need to be told to switch to Paddle.
    this._tesseractQualityWindow = [];
    this._engineAdviceEmitted = false;
  }

  /**
   * v3.13.01: Get the current OCR engine name
   */
  getOcrEngine() {
    return this._ocrEngine;
  }

  /**
   * v3.13.01: Check if PaddleOCR is available
   */
  isPaddleAvailable() {
    return PaddleOCREngine.isAvailable();
  }

  /**
   * v3.13.79 (Fase 3, round-3 plan): feed one Tesseract recognition outcome
   * into the rolling quality window and, at most once per session, suggest
   * switching to PaddleOCR when the window is persistently bad AND Paddle
   * is actually available to switch to. Deliberately only fed from the
   * garbled-text-skip path and the successful-emit path in
   * _recognizeTesseract() — NOT the empty-result path, since an empty
   * capture usually just means no dialogue is on screen right now (normal
   * between VN lines), not that Tesseract failed to read text that was
   * there. Mixing that in would make the window mostly noise.
   * @private
   */
  _trackTesseractQualityAndMaybeAdvise(confidence, isGood) {
    if (this._ocrEngine !== 'tesseract') return;

    this._tesseractQualityWindow.push({ confidence, isGood });
    if (this._tesseractQualityWindow.length > 10) this._tesseractQualityWindow.shift();

    if (this._engineAdviceEmitted) return;
    if (this._tesseractQualityWindow.length < 10) return;
    if (!PaddleOCREngine.isAvailable()) return;

    const badCount = this._tesseractQualityWindow.filter((s) => !s.isGood).length;
    const meanConfidence = this._tesseractQualityWindow.reduce((sum, s) => sum + s.confidence, 0) / this._tesseractQualityWindow.length;
    // Heuristic thresholds, same status as the Fase 2 validation floors —
    // a starting point, not something measured against real captures yet.
    const persistentlyBad = badCount >= 5 || meanConfidence < 40;

    if (persistentlyBad) {
      this._engineAdviceEmitted = true;
      log.info(`[OCR] Tesseract quality persistently low over the last ${this._tesseractQualityWindow.length} captures (badCount=${badCount}/10, meanConfidence=${meanConfidence.toFixed(1)}) — suggesting PaddleOCR`);
      this.emit('engine-advice', { reason: 'low-quality', badCount, meanConfidence: Math.round(meanConfidence) });
    }
  }

  /**
   * v3.13.01: Get PaddleOCR download progress
   */
  getPaddleDownloadProgress() {
    return this._paddleEngine.getStatus().downloadProgress;
  }

  /**
   * v3.13.16: Forward detection/recognition option overrides to the PaddleOCR
   * engine (e.g. { enhance: true } for the Phase 1 median-denoise + auto-invert
   * pass on recognition crops — see PaddleOCREngine._options and
   * preprocessForRecognition() in paddle-preprocess.js). No-op for Tesseract.
   */
  setPaddleOptions(options) {
    this._paddleEngine.setOptions(options);
  }

  async initialize(lang) {
    this._sourceLang = lang || 'ja';
    // v3.13.04: Update PaddleOCR source language for model selection
    this._paddleSourceLang = this._sourceLang;
    this._paddleEngine.setSourceLang(this._sourceLang);

    // v3.13.01: If using PaddleOCR, initialize it instead of Tesseract
    if (this._ocrEngine === 'paddle') {
      return this._initializePaddle();
    }

    return this._initializeTesseract();
  }

  /**
   * v3.13.01-fix: Initialize PaddleOCR engine with auto-fallback to Tesseract.
   * If PaddleOCR fails (model download error, runtime error, etc.), automatically
   * switches to Tesseract so the OCR pipeline keeps working.
   * @private
   */
  async _initializePaddle() {
    if (this._paddleEngine.getStatus().ready) {
      log.info('[OCR] PaddleOCR already initialized');
      this._isReady = true;
      this._initialized = true;
      this.emit('status', 'ready');
      return;
    }

    try {
      this.emit('status', 'initializing');
      log.info('[OCR] Initializing PaddleOCR engine...');

      // Forward PaddleOCR status events
      this._paddleEngine.removeAllListeners('status');
      this._paddleEngine.on('status', (status) => {
        this.emit('status', status);
      });
      this._paddleEngine.removeAllListeners('error');
      this._paddleEngine.on('error', (err) => {
        this.emit('error', err);
      });

      // v3.13.04: Pass source language so the correct recognition model is loaded
      await this._paddleEngine.initialize((progress) => {
        if (progress.stage === 'download') {
          this.emit('progress', progress.percent / 100);
        }
      }, this._paddleSourceLang);

      this._isReady = true;
      this._initialized = true;
      this.emit('status', 'ready');
      log.info('[OCR] PaddleOCR engine initialized successfully');
    } catch (err) {
      this._isReady = false;
      log.error('[OCR] Failed to initialize PaddleOCR:', err.message);
      log.info('[OCR] Auto-falling back to Tesseract engine...');

      // Auto-fallback: switch to Tesseract so OCR keeps working
      this._ocrEngine = 'tesseract';
      try {
        await this._initializeTesseract();
        log.info('[OCR] Successfully fell back to Tesseract');
        // Emit a special event so the UI knows PaddleOCR failed and fell back
        this.emit('paddle-fallback', { reason: err.message });
      } catch (tessErr) {
        log.error('[OCR] Tesseract fallback also failed:', tessErr.message);
        this.emit('status', 'error');
        this.emit('error', new Error(`PaddleOCR failed: ${err.message}. Tesseract fallback also failed: ${tessErr.message}`));
      }
    }
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): single place to create a
   * tesseract.js worker, used by _initializeTesseract() and by the two
   * auto-detect re-creation sites in _maybeSwitchTesseractLangForAutoDetect().
   * Previously each of those three call sites duplicated the same options
   * object with no `cachePath` — tesseract.js defaults to caching
   * traineddata under the process CWD, which on a packaged Windows install
   * is frequently non-writable, so the ~15-30MB model silently re-downloaded
   * every session (write failures there are caught and swallowed inside
   * tesseract.js itself). `app.getPath('userData')` is always writable and
   * is exactly where PaddleOCR already caches its own models
   * (paddle-models.js), so this makes the two engines consistent.
   * @private
   */
  async _createTesseractWorker(lang) {
    const { app } = require('electron');
    return Tesseract.createWorker(lang, 1, {
      cachePath: app.getPath('userData'),
      logger: (m) => {
        if (m.status === 'recognizing text') {
          this.emit('progress', m.progress);
        }
        log.debug(`[OCR] Tesseract: ${m.status} (${Math.round((m.progress || 0) * 100)}%)`);
      }
    });
  }

  /**
   * v3.13.79: single place that swaps the live Tesseract worker for a
   * different language — terminate → create → re-apply psm/dpi params.
   * Extracted out of _maybeSwitchTesseractLangForAutoDetect() so the same
   * sequence can also be used to REVERT to English (see
   * _attemptAutoDetectSwitch()'s final-fallback path and the validation
   * step in _recognizeTesseract()), not just to switch away from it.
   * Throws if worker creation fails — callers decide how to handle that.
   * @private
   */
  async _switchTesseractLang(lang) {
    if (this._worker) {
      try { await this._worker.terminate(); } catch (e) { /* ignore */ }
      this._worker = null;
    }
    this._language = lang;
    this._worker = await this._createTesseractWorker(lang);
    await this._applyTesseractParameters();
  }

  /**
   * v3.13.79: try switching to `targetLang`, falling back to `fallbackLang`
   * if that fails, exactly like the old inline try/catch in
   * _maybeSwitchTesseractLangForAutoDetect() — extracted so the bug that
   * lived here (see below) has one fix site instead of two near-duplicates.
   *
   * BUG FIXED: if BOTH attempts threw, the old code left `_worker = null`
   * with `_isReady` still `true`. The next recognize() call would throw
   * 'OCR worker not initialized. Call initialize() first.' with no way to
   * recover short of an external initialize() call. Now it tries to
   * restore an English worker as a last resort so the service stays usable;
   * only if THAT also fails does it give up and mark `_isReady = false`,
   * which is at least an honest, checkable state instead of a silent trap.
   * @private
   */
  async _attemptAutoDetectSwitch(targetLang, targetLangName, fallbackLang, fallbackLangName) {
    try {
      await this._switchTesseractLang(targetLang);
      log.info(`[OCR] Switched Tesseract to ${targetLangName} model for auto-detect`);
      return true;
    } catch (err) {
      log.warn(`[OCR] Failed to switch Tesseract to ${targetLangName}: ${err.message}`);
      try {
        await this._switchTesseractLang(fallbackLang);
        log.info(`[OCR] Switched Tesseract to ${fallbackLangName} model as fallback`);
        return true;
      } catch (fbErr) {
        log.warn(`[OCR] Fallback to ${fallbackLangName} also failed: ${fbErr.message}`);
        try {
          await this._switchTesseractLang('eng');
          log.info('[OCR] Restored English Tesseract worker after failed auto-detect switch');
        } catch (revertErr) {
          log.error(`[OCR] Could not restore English worker after failed auto-detect switch: ${revertErr.message}`);
          this._isReady = false;
        }
        return false;
      }
    }
  }

  /**
   * Initialize Tesseract worker
   * @private
   */
  async _initializeTesseract() {
    if (this._initialized && this._worker) {
      const tessLang = LANG_MAP[this._sourceLang] || LANG_MAP['ja'];
      if (tessLang === this._language && this._isReady) {
        log.info('[OCR] Already initialized with language:', this._language);
        return;
      }
      await this.terminate();
    }

    this._language = LANG_MAP[this._sourceLang] || 'jpn';

    try {
      this.emit('status', 'initializing');
      log.info(`[OCR] Initializing tesseract worker with language: ${this._language}`);

      this._worker = await this._createTesseractWorker(this._language);
      await this._applyTesseractParameters();

      this._isReady = true;
      this._initialized = true;
      this.emit('status', 'ready');
      log.info('[OCR] Tesseract worker initialized successfully');
    } catch (err) {
      this._isReady = false;
      this.emit('status', 'error');
      this.emit('error', err);
      log.error('[OCR] Failed to initialize tesseract worker:', err.message);
    }
  }

  async recognize(imageBuffer, options = {}) {
    // v3.13.01: Route to PaddleOCR or Tesseract based on engine setting
    if (this._ocrEngine === 'paddle' && this._paddleEngine.getStatus().ready) {
      return this._recognizePaddle(imageBuffer, options);
    }
    return this._recognizeTesseract(imageBuffer, options);
  }

  /**
   * v3.13.02: Recognize text using PaddleOCR engine with text cleaning.
   * Previously, PaddleOCR output was used raw — only trimmed and filtered by
   * length/confidence. Now applies _cleanPaddleOcrText() for CJK-safe cleaning:
   * Unicode normalization, artifact stripping, garbled line removal, whitespace cleanup.
   * @private
   */
  async _recognizePaddle(imageBuffer, options = {}) {
    if (this._isBusy) {
      log.warn('[OCR] Busy, skipping PaddleOCR request');
      return { text: '', confidence: 0, regions: 0, regionStages: null, recModel: null, detGeometry: null, detectedBoxes: null };
    }

    this._isBusy = true;
    this.emit('status', 'recognizing');

    try {
      const result = await this._paddleEngine.recognize(imageBuffer);
      const rawText = result.text.trim();

      // v3.13.02: Apply CJK-safe text cleaning pipeline
      const text = this._cleanPaddleOcrText(rawText);

      // v3.13.03: CJK-aware minimum character count filter.
      // CJK characters carry much more meaning per character than Latin —
      // a single kanji can be a valid word, and 2-character CJK words like
      // 世界 ("world") or 今日 ("today") are completely valid results.
      // The old `text.length < 3` filter was incorrectly rejecting these
      // high-confidence short CJK results.
      const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
      const hasCJK = cjkCount >= 1;
      const hasHangul = (text.match(/[\uac00-\ud7af]/g) || []).length >= 1;
      const minCharsMet = hasCJK ? cjkCount >= 1 : text.length >= 3;
      // v3.13.07: Removed hard confidence threshold — the translation engine
      // (Google/DeepL) can handle imperfect OCR input better than no input at all.
      // Even partial sentences produce usable translations. Only skip if there's
      // absolutely no meaningful text (empty after cleaning).
      // Previous thresholds (0.05/0.10) still rejected RPG battle text and
      // low-quality scans that produced partially correct but translatable text.
      if (!minCharsMet) {
        log.info(`[OCR/Paddle] Skipping empty result (0 meaningful chars): "${text.substring(0, 60)}"`);
        this.emit('status', 'ready');
        return { text: '', confidence: result.confidence, regions: result.regions, regionStages: result.regionStages, recModel: result.recModel, detGeometry: result.detGeometry, detectedBoxes: result.detectedBoxes };
      }

      // Log low confidence but still pass through — translation engine may handle it
      if (result.confidence < 0.15) {
        log.info(`[OCR/Paddle] Low confidence (${(result.confidence * 100).toFixed(1)}%) but passing through: "${text.substring(0, 60)}"`);
      }

      // Similarity dedup (same as Tesseract path) — skipped when forced
      // (manual capture button: user explicitly asked to rescan, so a
      // result identical to the last one should still be re-emitted)
      if (!options.force && this._lastEmittedText && this._isSimilarText(text, this._lastEmittedText)) {
        const similarity = this._computeSimilarity(text, this._lastEmittedText);
        log.info(`[OCR/Paddle] Similar text skipped (${(similarity * 100).toFixed(0)}% similar): "${text.substring(0, 50)}"`);
        this.emit('status', 'ready');
        return { text, confidence: result.confidence, regions: result.regions, regionStages: result.regionStages, recModel: result.recModel, detGeometry: result.detGeometry, detectedBoxes: result.detectedBoxes };
      }

      this._lastEmittedText = text;
      log.info(`[OCR/Paddle] Recognized text (${(result.confidence * 100).toFixed(1)}%): "${text.substring(0, 80)}"`);
      this.emit('text', text, { force: !!options.force });
      this.emit('status', 'ready');
      return { text, confidence: result.confidence, regions: result.regions, regionStages: result.regionStages, recModel: result.recModel, detGeometry: result.detGeometry, detectedBoxes: result.detectedBoxes };
    } catch (err) {
      log.error('[OCR/Paddle] Recognition error:', err.message);
      this.emit('error', err);
      this.emit('status', 'error');
      return { text: '', confidence: 0, regions: 0, regionStages: null, recModel: null, detGeometry: null, detectedBoxes: null };
    } finally {
      this._isBusy = false;
    }
  }

  /**
   * Recognize text using Tesseract engine
   * @private
   */
  async _recognizeTesseract(imageBuffer, options = {}) {
    if (!this._worker || !this._isReady) {
      throw new Error('OCR worker not initialized. Call initialize() first.');
    }

    if (this._isBusy) {
      log.warn('[OCR] Busy, skipping recognition request');
      return { text: '', confidence: 0 };
    }

    this._isBusy = true;
    this.emit('status', 'recognizing');

    try {
      // v3.13.77 (Stage 4, OCR-refinement round): _preprocessImage() now does
      // real pixel work (upscale, BT.601 grayscale, optional Otsu) instead of
      // being a no-op gated on flags that had no code behind them. Only skip
      // it entirely when every knob is at its true no-op setting, so the
      // common case (grayscale on, no upscale) still avoids decode/reencode
      // when nothing would change.
      let processedImage = imageBuffer;
      if (this._tesseractOptions.upscaleFactor !== 1.0 || this._preprocessing.grayscale || this._tesseractOptions.otsuThreshold) {
        processedImage = await this._preprocessImage(imageBuffer);
      }

      // v3.13.77: request only {text, blocks} instead of tesseract.js's
      // default {blocks, text, hocr, tsv} — hocr/tsv are never read anywhere
      // in this codebase, and generating them costs real time on every
      // ~3.5s auto-capture tick. `blocks` is what exposes word-level
      // confidence (result.data.words doesn't actually exist despite the
      // published .d.ts claiming it does — verified against the shipped
      // 5.1.1 source in node_modules/tesseract.js/src/worker-script/utils/
      // dump.js, which only ever populates `blocks`; words/lines/paragraphs
      // must be walked via blocks[].paragraphs[].lines[].words[]).
      const recognizeOutput = { text: true, blocks: true };
      const result = await this._worker.recognize(processedImage, {}, recognizeOutput);
      let rawText = result.data.text.trim();
      let confidence = result.data.confidence;
      let wordLines = this._extractTesseractLines(result.data.blocks);

      // v3.13.10: Auto-detect language switching for Tesseract.
      // When sourceLang is 'auto', Tesseract defaults to English (eng) which
      // can't read CJK/Korean at all. If the result is empty or garbage but
      // the image clearly contains text, try switching to Japanese (jpn) or
      // Korean (kor) model. This follows the same pattern as PaddleOCR's
      // _maybeSwitchModelForAutoDetect() but for Tesseract.
      if (this._sourceLang === 'auto' && this._language === 'eng') {
        const switched = await this._maybeSwitchTesseractLangForAutoDetect(rawText, confidence, imageBuffer);
        if (switched) {
          // v3.13.79 (2.1): the pre-switch English result is the baseline
          // to validate against — capture it before rawText/confidence get
          // reassigned below.
          const baselineText = rawText;
          const baselineConfidence = confidence;
          // Re-recognize with the new language model
          try {
            const reResult = await this._worker.recognize(processedImage, {}, recognizeOutput);
            const newText = reResult.data.text.trim();
            const newConfidence = reResult.data.confidence;

            // v3.13.79 (2.1): validate the switch actually helped before
            // committing to it. This is what catches the case the round-3
            // plan was built around: a clock/counter ("35:97") switches to
            // Japanese and the model hallucinates a couple of characters
            // ("2 に") at low confidence — technically non-empty, but worse
            // than staying in English, not better.
            //
            // Primary criterion is COMPARATIVE (new result has to beat the
            // English baseline on both length and confidence) — robust,
            // no magic numbers. The absolute floors below are a secondary
            // path for the case where English produced nothing at all to
            // compare against (baseline length 0); their exact values are
            // heuristic placeholders, EXPLICITLY PENDING CALIBRATION against
            // real main.log data from Windows (see the round-3 plan) — the
            // instrumentation log line below exists specifically to gather
            // that data before the floors get tuned.
            const newLen = newText.replace(/\s/g, '').length;
            const baselineLen = baselineText.replace(/\s/g, '').length;
            const newIsMostlyGarbled = this._isMostlyGarbled(newText);
            const isComparativelyBetter = newLen > baselineLen && newConfidence > baselineConfidence;
            const MIN_CHARS_FLOOR = 4;
            const MIN_CONFIDENCE_FLOOR = 40;
            const passesAbsoluteFloor = newLen >= MIN_CHARS_FLOOR && newConfidence >= MIN_CONFIDENCE_FLOOR && !newIsMostlyGarbled;
            const switchWorked = isComparativelyBetter || passesAbsoluteFloor;
            const digitRatio = baselineText.length > 0
              ? (baselineText.match(/[0-9]/g) || []).length / baselineText.length
              : 0;

            log.info(`[OCR] Auto-detect validation: lang=${this._language} baselineLen=${baselineLen} baselineConf=${baselineConfidence.toFixed(1)} baselineDigitRatio=${digitRatio.toFixed(2)} newLen=${newLen} newConf=${newConfidence.toFixed(1)} streak=${this._autoDetectFailStreak} comparative=${isComparativelyBetter} absoluteFloor=${passesAbsoluteFloor} decision=${switchWorked ? 'KEEP' : 'REVERT'}`);

            if (switchWorked) {
              rawText = newText;
              confidence = newConfidence;
              wordLines = this._extractTesseractLines(reResult.data.blocks);
              log.info(`[OCR] Re-recognized with ${this._language}: "${rawText.substring(0, 60)}" (${confidence.toFixed(1)}%)`);
            } else {
              log.info(`[OCR] Auto-detect switch to ${this._language} did not beat the English baseline — reverting`);
              try {
                await this._switchTesseractLang('eng');
              } catch (revertErr) {
                log.error(`[OCR] Failed to revert Tesseract to English: ${revertErr.message}`);
                this._isReady = false;
              }
              // rawText/confidence/wordLines stay at the pre-switch English values.
            }
          } catch (reErr) {
            log.warn(`[OCR] Re-recognition with ${this._language} failed: ${reErr.message}`);
            try {
              await this._switchTesseractLang('eng');
            } catch (revertErr) {
              log.error(`[OCR] Failed to revert Tesseract to English: ${revertErr.message}`);
              this._isReady = false;
            }
          }
        }
      }

      // v3.13.77 (Stage 4, OCR-refinement round): drop low-confidence
      // outlier WORDS (garbage from UI clutter caught by an oversized
      // capture region) before cleaning/emitting, using a threshold relative
      // to this run's own mean word confidence — see
      // _filterTesseractWordsByConfidence()'s docstring for why relative,
      // not absolute.
      const wordFilterResult = this._filterTesseractWordsByConfidence(wordLines);
      if (wordFilterResult) {
        log.info(`[OCR] Word confidence filter: "${rawText.substring(0, 40)}" -> "${wordFilterResult.text.substring(0, 40)}"`);
        rawText = wordFilterResult.text;
        confidence = wordFilterResult.confidence;
      }

      // v3.13.77 (Stage 4, OCR-refinement round): diagnostic stats for the
      // bench's --tess-upscale=/--tess-psm= sweep (median word-line height,
      // kept-vs-dropped confidence separation) — computed on the RAW word
      // list regardless of whether the filter above actually changed
      // anything, so the sweep can see the filter's discrimination even on
      // inputs where the "never empty everything" guard left it a no-op.
      const wordStats = this._computeTesseractWordStats(wordLines);

      const text = this._cleanOcrText(rawText);

      // v3.13.08: Unified quality filtering — same approach as PaddleOCR path.
      // Instead of a hard confidence cutoff that silently discards results,
      // we log low confidence but still pass the text through. The translation
      // engine (Google/DeepL) can handle imperfect OCR better than no input.
      // Only skip if there's genuinely no meaningful text.
      // v3.13.10: Further relaxed — even single CJK characters or 2+ Latin chars
      // are passed through. Low-quality OCR still beats no translation at all.
      const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
      const hasCJK = cjkCount >= 1;
      const latinLetterCount = (text.match(/[a-zA-Z]/g) || []).length;
      const minCharsMet = hasCJK ? cjkCount >= 1 : (latinLetterCount >= 2 || text.length >= 2);

      if (!minCharsMet) {
        log.info(`[OCR] Skipping empty/meaningless result (${confidence.toFixed(1)}%, ${text.length} chars, ${cjkCount} CJK, ${latinLetterCount} Latin): "${text.substring(0, 60)}"`);
        this.emit('status', 'ready');
        return { text: '', confidence, wordStats };
      }

      // Log low confidence but still pass through (same as PaddleOCR path)
      if (confidence < 30) {
        log.info(`[OCR] Low confidence (${confidence.toFixed(1)}%) but passing through: "${text.substring(0, 60)}"`);
      }

      // v3.9.8: Garbled-word ratio check
      // v3.13.08-fix: Raised to 0.8 — only skip if >80% garbled (was 60%).
      // Low-quality OCR often has some garbled words mixed with real text that
      // is still translatable. The previous 60% threshold was too aggressive for
      // RPG battle text and low-quality scans.
      // v3.13.10: Raised to 0.9 — only skip if >90% garbled. Even text that is
      // 80% garbled may contain a recognizable phrase that produces a usable
      // translation. Luna Translator and VN Translator both pass all OCR output
      // through to the translation engine without garbled-text filtering.
      // v3.13.08-fix: For CJK text, skip garbled check entirely — vowel/consonant
      // heuristics don't apply to Chinese/Japanese/Korean characters.
      const hasCJKChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length > 0;
      if (!hasCJKChars && this._isMostlyGarbled(text)) {
        log.info(`[OCR] Skipping garbled text (high garbled-word ratio): "${text.substring(0, 60)}"`);
        this._trackTesseractQualityAndMaybeAdvise(confidence, false);
        this.emit('status', 'ready');
        return { text: '', confidence, wordStats };
      }

      // v3.9.8: SIMILARITY-BASED DEDUP — don't re-emit text that is >80%
      // similar to the last emitted text. This is the key improvement:
      // OCR produces slightly different readings each scan (e.g., "woke up
      // and g" vs "woke up and got"), but they represent the same game text.
      // Only emit when the text is genuinely NEW (different game dialogue).
      if (!options.force && this._lastEmittedText && this._isSimilarText(text, this._lastEmittedText)) {
        const similarity = this._computeSimilarity(text, this._lastEmittedText);
        log.info(`[OCR] Similar text skipped (${(similarity * 100).toFixed(0)}% similar to last): "${text.substring(0, 50)}"`);
        this._trackTesseractQualityAndMaybeAdvise(confidence, true);
        this.emit('status', 'ready');
        return { text, confidence, wordStats };
      }

      this._lastEmittedText = text;
      log.info(`[OCR] Recognized text (${confidence.toFixed(1)}% confidence): "${text.substring(0, 80)}"`);
      this._trackTesseractQualityAndMaybeAdvise(confidence, true);
      this.emit('text', text, { force: !!options.force });

      this.emit('status', 'ready');
      return { text, confidence, wordStats };
    } catch (err) {
      log.error('[OCR] Recognition error:', err.message);
      this.emit('error', err);
      this.emit('status', 'error');
      return { text: '', confidence: 0 };
    } finally {
      this._isBusy = false;
    }
  }

  async setLanguage(lang) {
    const tessLang = LANG_MAP[lang] || 'jpn';
    // v3.13.04: Always update source language for PaddleOCR model selection
    this._sourceLang = lang;
    this._paddleSourceLang = lang;
    this._paddleEngine.setSourceLang(lang);
    if (tessLang === this._language && this._ocrEngine !== 'paddle') return;
    log.info(`[OCR] Changing language from ${this._language} to ${tessLang}`);
    await this.initialize(lang);
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): tune the Tesseract path's real
   * preprocessing knobs. Test-bench-facing (scripts/test-ocr-images.js sweeps
   * upscaleFactor x psm to pick data-backed defaults) — there is no
   * settings-panel UI for this, matching the fact that these values are the
   * same for every user rather than a per-user preference.
   * @param {object} options - { upscaleFactor, psm, otsuThreshold }
   */
  setTesseractOptions(options) {
    this._tesseractOptions = { ...this._tesseractOptions, ...options };
    log.info('[OCR] Tesseract options updated:', JSON.stringify(this._tesseractOptions));
    // Best-effort: a worker may not exist yet (applied lazily at init via
    // _applyTesseractParameters() in _initializeTesseract()).
    this._applyTesseractParameters().catch((err) => {
      log.warn('[OCR] Failed to apply Tesseract options:', err.message);
    });
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): push the current
   * upscaleFactor/psm onto the live worker as real Tesseract variables
   * (tessedit_pageseg_mode, user_defined_dpi). Split out from
   * _preprocessImage() because these are worker-level parameters set once
   * (at init, or when setTesseractOptions() changes them) — re-sending them
   * on every single capture would cost a WASM round-trip every ~3.5s for
   * values that essentially never change mid-session.
   * @private
   */
  async _applyTesseractParameters() {
    if (!this._worker) return;
    await this._worker.setParameters({
      tessedit_pageseg_mode: this._tesseractOptions.psm,
      // v3.13.77: tell Tesseract the EFFECTIVE dpi after _preprocessImage()'s
      // upscale, not the screen's raw ~96 DPI. A capture upscaled 2x really
      // is closer to 192 DPI as far as the LSTM's input is concerned.
      user_defined_dpi: String(Math.round(96 * this._tesseractOptions.upscaleFactor))
    });
  }

  startAutoCapture(captureFn, intervalMs) {
    this.stopAutoCapture();
    this._captureFn = captureFn;
    this._autoCaptureMs = intervalMs || this._autoCaptureMs;
    log.info(`[OCR] Starting auto-capture every ${this._autoCaptureMs}ms (sequential loop)`);
    this._isAutoCapturing = true;
    this.emit('status', 'auto-capturing');
    this._scheduleNextCapture();
  }

  _scheduleNextCapture() {
    if (!this._isAutoCapturing) return;

    this._captureTimeout = setTimeout(async () => {
      if (!this._isAutoCapturing) return;

      try {
        const imageBuffer = await this._captureFn();
        if (!imageBuffer) {
          this._scheduleNextCapture();
          return;
        }

        if (this._lastImageData && !this._hasSignificantChange(imageBuffer)) {
          this._scheduleNextCapture();
          return;
        }

        this._lastImageData = imageBuffer;
        await this.recognize(imageBuffer);
      } catch (err) {
        log.error('[OCR] Auto-capture error:', err.message);
      }

      this._scheduleNextCapture();
    }, this._autoCaptureMs);
  }

  stopAutoCapture() {
    if (this._captureTimeout) {
      clearTimeout(this._captureTimeout);
      this._captureTimeout = null;
    }
    this._isAutoCapturing = false;
    this._lastImageData = null;
    this._lastEmittedText = '';
    // v3.13.79 (Fase 3): the engine-advice window/flag are scoped to one
    // auto-capture session — a fresh session (new game, new capture region)
    // deserves its own read on Tesseract's quality rather than inheriting a
    // stale one, and the "once per session" promise wouldn't mean much
    // otherwise.
    this._tesseractQualityWindow = [];
    this._engineAdviceEmitted = false;
    // v3.13.79 (2.5): if auto-detect drifted the Tesseract model away from
    // English during this session, don't let the NEXT startAutoCapture()
    // silently inherit it. startAutoCapture() itself never calls
    // initialize()/setLanguage() (only load-profile and save-settings do),
    // so without this, stopping and restarting auto-capture mid-session
    // (e.g. switching to a different capture region on the same game) would
    // keep reading English dialogue with a Japanese/Korean model from
    // whatever the last drift left behind. Fire-and-forget: this method is
    // synchronous everywhere it's called from, and the reset only needs to
    // land before the next recognize() call actually happens, not before
    // this one returns.
    if (this._sourceLang === 'auto' && this._ocrEngine === 'tesseract' && this._language !== 'eng') {
      this._autoDetectFailStreak = 0;
      log.info('[OCR] Auto-capture stopped mid-drift — resetting Tesseract back to English in the background');
      this._switchTesseractLang('eng').catch((err) => {
        log.error(`[OCR] Failed to reset Tesseract language on stopAutoCapture: ${err.message}`);
      });
    }
    log.info('[OCR] Auto-capture stopped');
    if (this._isReady) {
      this.emit('status', 'ready');
    }
  }

  get isAutoCapturing() {
    return this._isAutoCapturing;
  }

  getStatus() {
    return {
      ready: this._isReady,
      busy: this._isBusy,
      language: this._language,
      sourceLang: this._sourceLang,
      autoCapturing: this.isAutoCapturing,
      preprocessing: { ...this._preprocessing },
      tesseractOptions: { ...this._tesseractOptions },
      ocrEngine: this._ocrEngine,
      paddleAvailable: PaddleOCREngine.isAvailable(),
      paddleStatus: this._paddleEngine.getStatus()
    };
  }

  _hasSignificantChange(newImage) {
    if (!this._lastImageData) return true;

    const oldLen = this._lastImageData.length;
    const newLen = newImage.length;

    if (Math.abs(oldLen - newLen) > oldLen * 0.05) return true;

    const sampleCount = 200;
    let changedPixels = 0;
    const step = Math.max(1, Math.floor(Math.min(oldLen, newLen) / sampleCount));

    for (let i = 0; i < Math.min(oldLen, newLen); i += step) {
      if (this._lastImageData[i] !== newImage[i]) {
        changedPixels++;
      }
    }

    const changePercent = (changedPixels / sampleCount) * 100;
    return changePercent >= this._changeThreshold;
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): flatten tesseract.js's
   * blocks[].paragraphs[].lines[].words[] tree into a flat array of lines
   * (each still holding its own .words), for _filterTesseractWordsByConfidence().
   * There is no shortcut — result.data.words/.lines/.paragraphs described in
   * the package's .d.ts do not actually exist in the shipped 5.1.1 runtime
   * (verified against worker-script/utils/dump.js); only .blocks is real.
   * @private
   */
  _extractTesseractLines(blocks) {
    const lines = [];
    if (!blocks) return lines;
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          if (line.words && line.words.length) lines.push(line);
        }
      }
    }
    return lines;
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): drop low-confidence outlier
   * words, mirroring the relative-threshold outlier filter already used on
   * the Paddle path (ocr-paddle.js: `threshold = avgConf * 0.25`) instead of
   * a fixed cutoff. Tesseract's confidence is not calibrated across
   * preprocessing configs — an aggressive upscale genuinely raises the
   * LSTM's confidence on every word, garbage included, so a fixed absolute
   * threshold would need re-tuning every time upscaleFactor/psm change. A
   * threshold relative to this run's own mean confidence moves with it.
   *
   * Two guards, both mirrored from the Paddle version: never filter on a
   * single word (nothing to compare against), and never let filtering empty
   * the result — if the relative threshold would drop every word, it isn't
   * discriminating anything useful on this input, so the caller should keep
   * the original unfiltered text/confidence instead.
   *
   * A third guard, found by testing rather than anticipated by the plan:
   * skip entirely if any word contains CJK characters. Tesseract's "word"
   * segmentation for Chinese/Japanese/Korean does not carry the same
   * per-word confidence semantics it does for space-separated Latin text —
   * confirmed by reproduction against test10-low-quality.png (bench, ja),
   * where this filter dropped 表れ (a real, meaningful part of "遅れました")
   * as a low-confidence "outlier" relative to the rest of the line, turning
   * a already-imperfect 80% similarity result into 60%. Mirrors the same
   * CJK skip _isMostlyGarbled() already applies for the same underlying
   * reason (a heuristic tuned on Latin word statistics doesn't transfer).
   *
   * @param {Array<{words: Array}>} lines - from _extractTesseractLines()
   * @returns {{text: string, confidence: number}|null} null means "don't
   *   change anything" (too few words, filtering would remove everything,
   *   or the text contains CJK)
   * @private
   */
  _filterTesseractWordsByConfidence(lines) {
    const allWords = [];
    for (const line of lines) {
      for (const word of line.words) allWords.push({ ...word, _line: line });
    }
    if (allWords.length <= 1) return null;

    const hasCJK = allWords.some(w => /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(w.text || ''));
    if (hasCJK) return null;

    const avgConf = allWords.reduce((sum, w) => sum + w.confidence, 0) / allWords.length;
    const threshold = avgConf * 0.25;
    const kept = allWords.filter(w => w.confidence >= threshold);
    if (kept.length === 0 || kept.length === allWords.length) return null;

    const keptTextByLine = new Map();
    for (const w of kept) {
      if (!keptTextByLine.has(w._line)) keptTextByLine.set(w._line, []);
      keptTextByLine.get(w._line).push(w.text);
    }
    const rebuiltLines = [];
    for (const line of lines) {
      const words = keptTextByLine.get(line);
      if (words && words.length) rebuiltLines.push(words.join(' '));
    }

    return {
      text: rebuiltLines.join('\n'),
      confidence: kept.reduce((sum, w) => sum + w.confidence, 0) / kept.length
    };
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): diagnostic stats for
   * scripts/test-ocr-images.js's --tess-upscale=/--tess-psm= sweep — median
   * word-line height (to pick an upscale factor by target glyph height
   * rather than a blind multiplier) and the same relative-threshold split
   * used by _filterTesseractWordsByConfidence(), reported as the mean
   * confidence of the words on each side of it. A config whose "kept" and
   * "dropped" means move together (both rising with a bigger upscale, say)
   * isn't actually discriminating garbage from real text — it's just
   * inflating confidence uniformly — which the raw similarity score alone
   * would not reveal.
   * @private
   */
  _computeTesseractWordStats(lines) {
    const words = [];
    for (const line of lines) for (const w of line.words) words.push(w);
    if (words.length === 0) return null;

    const heights = words
      .map(w => w.bbox.y1 - w.bbox.y0)
      .filter(h => h > 0)
      .sort((a, b) => a - b);
    const medianLineHeightPx = heights.length ? heights[Math.floor(heights.length / 2)] : null;

    if (words.length <= 1) {
      return { medianLineHeightPx, meanConfidenceKept: words[0].confidence, meanConfidenceDropped: null, totalWords: 1, droppedWords: 0 };
    }

    const avgConf = words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
    const threshold = avgConf * 0.25; // same ratio as _filterTesseractWordsByConfidence()
    const kept = words.filter(w => w.confidence >= threshold);
    const dropped = words.filter(w => w.confidence < threshold);

    return {
      medianLineHeightPx,
      meanConfidenceKept: kept.length ? kept.reduce((sum, w) => sum + w.confidence, 0) / kept.length : null,
      meanConfidenceDropped: dropped.length ? dropped.reduce((sum, w) => sum + w.confidence, 0) / dropped.length : null,
      totalWords: words.length,
      droppedWords: dropped.length
    };
  }

  /**
   * v3.13.77 (Stage 4, OCR-refinement round): REAL pixel preprocessing for
   * the Tesseract path — decode -> optional upscale -> optional grayscale ->
   * optional Otsu binarization -> re-encode. Replaces the old version, which
   * never touched a pixel and only (mis)set `tessedit_threshold_value`,
   * which isn't a real Tesseract variable (Tesseract's own SetVariable call
   * would have silently no-op'd on an unrecognized name). Follows the same
   * nativeImage decode -> toBitmap -> mutate -> createFromBitmap pattern
   * paddle-preprocess.js already uses for the Paddle path, so this needs no
   * new dependency (no sharp/jimp/canvas).
   * @private
   */
  async _preprocessImage(imageBuffer) {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(imageBuffer);
    const size = img.getSize();
    const factor = this._tesseractOptions.upscaleFactor;

    let working = img;
    if (factor !== 1.0) {
      working = img.resize({
        width: Math.max(1, Math.round(size.width * factor)),
        height: Math.max(1, Math.round(size.height * factor))
      });
    }

    if (this._preprocessing.grayscale || this._tesseractOptions.otsuThreshold) {
      const { width, height } = working.getSize();
      const bitmap = working.toBitmap();
      grayscaleBGRA(bitmap);
      if (this._tesseractOptions.otsuThreshold) {
        otsuThresholdBGRA(bitmap);
      }
      working = nativeImage.createFromBitmap(bitmap, { width, height });
    }

    return working.toPNG();
  }

  /**
   * v3.13.02: CJK-safe text cleaning for PaddleOCR output.
   * Unlike _cleanOcrText() which is English-focused (garbled word heuristics,
   * l↔1/0↔o fixes), this method is designed for CJK text where:
   *   - Vowel/consonant heuristics don't apply (CJK characters have no vowels)
   *   - Character-level noise is more common than word-level
   *   - Unicode normalization and artifact stripping are the most impactful steps
   *
   * v3.13.03 improvements:
   *   - Better Japanese character handling (preserve katakana middle dot, prolonged sound)
   *   - Smarter garbled line detection with Japanese-aware ratio
   *   - Preserve common Japanese punctuation patterns (。「」、 etc.)
   *   - Don't remove lone single CJK chars (they can be valid words: 設定, 図書館 etc.)
   *
   * Steps applied:
   *   1. Unicode punctuation normalization
   *   2. Garbled line removal (CJK-aware ratio check)
   *   3. OCR artifact stripping (~|`)
   *   4. Whitespace normalization
   *   5. Trailing/leading dot noise removal
   *   6. Stray Latin character removal (preserve CJK)
   *   7. Stray punctuation cleanup
   *   8. Final trim
   *
   * @param {string} text - Raw PaddleOCR text
   * @returns {string} Cleaned text
   */
  _cleanPaddleOcrText(text) {
    if (!text) return '';

    // Step 0: v3.13.05: Remove furigana annotations.
    // Furigana appears as small kana readings above/beside kanji in Japanese text.
    // OCR often reads them as separate text segments, producing noise like:
    //   "En Kanji" (reading the furigana label), or kana fragments mixed with kanji.
    //
    // v3.13.18: These 4 patterns target INLINE ruby markup ({kanji|reading},
    // kanji(reading), kanji[reading]) — formats that image OCR never actually
    // produces, since furigana arrives from detection as its own separate
    // region, not as markup inside a recognized string. The real mechanism
    // for image OCR is geometric: filterFuriganaBoxes() in
    // paddle-postprocess.js drops the furigana box before recognition even
    // runs, based on its size/position relative to its kanji line. Kept here
    // (rather than removed) in case a future input source ever does produce
    // literal ruby markup in text form.
    // Pattern 1: Ruby annotations {kanji|reading} — common in some OCR outputs
    text = text.replace(/\{[^|]+\|([^}]+)\}/g, '$1');
    // Pattern 2: Parenthetical kana readings after kanji: 漢字(かんじ)
    text = text.replace(/([\u4e00-\u9fff]+)\(([\u3040-\u309f\u30a0-\u30ff]+)\)/g, '$1');
    // Pattern 3: Kana in brackets after kanji: 漢字[かんじ]
    text = text.replace(/([\u4e00-\u9fff]+)\[([\u3040-\u309f\u30a0-\u30ff]+)\]/g, '$1');
    // Pattern 4: "In Kanji" / "En Kanji" / furigana labels that OCR sometimes produces
    // instead of actual text content (the OCR reads the furigana notation itself)
    text = text.replace(/^(In|En|On)\s+Kanji\s*/i, '');

    // Step 1: Normalize Unicode punctuation to ASCII/standard equivalents
    text = text
      .replace(/[\u201C\u201D]/g, '"')   // Smart double quotes → "
      .replace(/[\u2018\u2019]/g, "'")   // Smart single quotes → '
      .replace(/[\u2013\u2014\u2015]/g, '-')  // En/em/horizontal dash → -
      .replace(/\u2026/g, '...')          // Ellipsis → ...
      .replace(/[\u00AB\u00BB]/g, '"')   // Guillemets → "
      .replace(/[\u3000]/g, ' ')          // Ideographic space → regular space
      .replace(/[\u3001]/g, '\u3001')     // Keep CJK comma (、)
      .replace(/[\u3002]/g, '\u3002')     // Keep CJK period (。)
      .replace(/[\uFF01]/g, '!')          // Fullwidth !
      .replace(/[\uFF1F]/g, '?')          // Fullwidth ?
      .replace(/[\uFF08\uFF09]/g, '(')    // Fullwidth parens
      .replace(/[\uFF0C]/g, ',')          // Fullwidth comma
      .replace(/[\uFF0E]/g, '.')          // Fullwidth period
      .replace(/[\uFF1A]/g, ':')          // Fullwidth colon
      .replace(/[\uFF1B]/g, ';')          // Fullwidth semicolon
      .replace(/[\u30FB]/g, '\u30FB')    // Keep Katakana middle dot
      .replace(/[\u30FC]/g, '\u30FC')    // Keep Katakana prolonged sound
      .replace(/[\uFF5E]/g, '~')          // Fullwidth tilde
      .replace(/[\uFF0D]/g, '-');         // Fullwidth hyphen-minus

    // Step 2: Remove lines that are mostly garbled (CJK-aware)
    // v3.13.03: Lowered ratio threshold to 0.2 since PaddleOCR can produce
    // mixed CJK + noise lines that still have valid content. Also, Japanese
    // text often contains kana which counts as "real" characters.
    const lines = text.split('\n');
    const goodLines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      // Count real characters: CJK ideographs, kana, Latin letters, digits, common punctuation
      const realChars = trimmed.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z0-9\u00C0-\u024F.,!?;:'"()\-\u3001\u3002\uff01\uff1f\u300c\u300d\u300e\u300f\u30fb\u30fc\uFF5E]/g);
      const realCount = realChars ? realChars.length : 0;
      const ratio = realCount / trimmed.length;
      return ratio >= 0.5; // v3.13.10: Lowered from 0.6 — accept more content with mixed real/noise text
    });

    let cleaned = goodLines.join(' ').trim();

    // Step 3: Strip OCR artifact characters
    // ~ : Line separator / decorative border artifact
    // | : Vertical border artifact
    // ` : Misread quote mark
    // But preserve ~ when between CJK characters (it can be a valid CJK dash)
    // v3.13.03: Also preserve ~ when adjacent to Japanese punctuation
    cleaned = cleaned.replace(/(?<![\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u3001\u3002\uFF5E])~(?![\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u3001\u3002\uFF5E])/g, ' ');
    cleaned = cleaned.replace(/[|`]/g, ' ');

    // v3.13.12: Remove decorative game symbols that OCR picks up from UI elements.
    // These characters appear in RPG/VN dialogue boxes as decorative markers,
    // speaker indicators, or bullet points and should not be in the translation text.
    // Following Luna Translator's approach of stripping UI decoration characters.
    cleaned = cleaned.replace(/[◇◆▪●○◎★☆♠♦♣☐☑☒▲△▼▽◀◀▶▷⇒⇔→←↑↓✦✧✵✶♪♫♬†‡§¶]/g, ' ');

    // Step 4: Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Step 5: Strip trailing/leading dot noise
    cleaned = cleaned.replace(/\s*\.{2,}\s*$/g, '');
    cleaned = cleaned.replace(/^\s*\.{2,}\s*/g, '');
    cleaned = cleaned.replace(/\s+\./g, '.');
    cleaned = cleaned.replace(/\s+,/g, ',');

    // Step 6: Remove single-character noise (Latin only, preserve CJK)
    // v3.13.03: DON'T remove lone CJK characters — a single kanji or kana
    // is a valid word (e.g. 設 = setting, 図 = diagram). Only remove lone
    // Latin single chars except 'I' and 'a'.
    // v3.13.79: the class below still had 'I' in it despite the comment —
    // it was deleting the English pronoun "I" from every capture where it
    // stood alone. Fixed by removing 'I' from the class. Also protect
    // button-prompt letters ("Press X to skip") via context — see
    // isProtectedButtonLetter() above.
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHJKLMNOPQRSTUVWXYZ]\s+/g,
      (m, offset) => isProtectedButtonLetter(cleaned, offset, m.length) ? m : ' ');
    cleaned = cleaned.replace(/^[bcdefghjklmnopqrstuvwxyzBCDEFGHJKLMNOPQRSTUVWXYZ]\s+/g,
      (m, offset) => isProtectedButtonLetter(cleaned, offset, m.length) ? m : '');
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHJKLMNOPQRSTUVWXYZ]$/g,
      (m, offset) => isProtectedButtonLetter(cleaned, offset, m.length) ? m : '');

    // Step 7: Remove stray punctuation-only fragments at start/end
    cleaned = cleaned.replace(/^\s*[.\-,;:!?]+\s+(?=[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ffa-zA-Z])/g, '');
    cleaned = cleaned.replace(/(?<=[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ffa-zA-Z])\s+[.\-,;:!?]+\s*$/g, '');

    // Step 8: Final whitespace cleanup
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
  }

  /**
   * Clean OCR text output — comprehensive cleaning pipeline.
   * v3.9.10 improvements:
   *   - Strip ~ and | characters (OCR artifacts for line breaks/decorations)
   *   - Fix l→1 misread: "Textl" → "Text 1" (Tesseract reads 1 as l)
   *   - Strip stray quote marks mid-sentence
   *   - Normalize all dashes to simple hyphen
   * @param {string} text - Raw OCR text
   * @returns {string} Cleaned text
   */
  _cleanOcrText(text) {
    if (!text) return '';

    // Step 1: Normalize Unicode punctuation to ASCII equivalents.
    text = text
      .replace(/[\u201C\u201D]/g, '"')   // Smart double quotes → "
      .replace(/[\u2018\u2019]/g, "'")   // Smart single quotes → '
      .replace(/[\u2013\u2014\u2015]/g, '-')  // En/em/horizontal dash → -
      .replace(/\u2026/g, '...')          // Ellipsis → ...
      .replace(/\u00AB\u00BB/g, '"')      // Guillemets → "
      .replace(/[\u00BF\u00A1]/g, '');    // Inverted ¿¡ — remove (OCR noise for eng)

    // Step 2: Remove lines that are mostly garbled
    const lines = text.split('\n');
    const goodLines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      const realChars = trimmed.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z0-9\u00C0-\u024F.,!?;:'"()\-\u3001\u3002\uff01\uff1f\u300c\u300d\u300e\u300f\u30fb\u30fc]/g);
      const realCount = realChars ? realChars.length : 0;
      const ratio = realCount / trimmed.length;
      return ratio >= 0.5; // v3.13.10: Lowered from 0.6 — accept more content with mixed real/noise text
    });

    let cleaned = goodLines.join(' ').trim();

    // Step 3: Strip OCR artifact characters that are NEVER real game dialogue.
    // ~ : Tesseract uses this for line separators, decorative borders, em-dashes.
    // | : Pipe character is almost never in game text, it's a vertical border artifact.
    // ` : Backtick is often a misread quote mark.
    cleaned = cleaned.replace(/[~|`]/g, ' ');

    // v3.13.12: Remove decorative game symbols that OCR picks up from UI elements.
    // Same set as _cleanPaddleOcrText — RPG/VN dialogue decorations, speaker markers, bullets.
    cleaned = cleaned.replace(/[◇◆▪●○◎★☆♠♦♣☐☑☒▲△▼▽◀◀▶▷⇒⇔→←↑↓✦✧✵✶♪♫♬†‡§¶]/g, ' ');

    // Step 4: Strip non-ASCII for English model, but keep basic Latin + accented.
    // v3.13.10: Also keep CJK/hangul characters even with English model — the
    // auto-detect language switch may have just happened, and the text may contain
    // CJK characters that were recognized by the newly loaded model. Also, even
    // when English Tesseract encounters CJK text, it sometimes produces valid
    // CJK characters that should be preserved for the translation engine.
    // Note: ~ was already removed in step 3, so it won't survive here either.
    if (this._language === 'eng') {
      cleaned = cleaned.replace(/[^\x20-\x7E\u00C0-\u024F\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3001\u3002\u300c-\u300f\u30fb\u30fc\uff01\uff1f]/g, ' ');
    }

    // Step 5: Normalize whitespace (combine all multi-spaces from removals)
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Step 6: Fix common OCR misreads — BIDIRECTIONAL.
    // 6a: 1→l when 1 appears between or after letters (Tesseract sees l as 1)
    //     e.g., "trans1ate" → "translate", "Underta1e" → "Undertale"
    cleaned = cleaned.replace(/([a-zA-Z])1(?=[a-zA-Z])/g, '$1l');
    // v3.13.79: the trailing-boundary variant used to match ANY letter before
    // a final "1" (e.g. "Level1" → "Levell", "F1" → "Fl", "A1 B2 C3" →
    // "Al B2 C3") — it was destroying real numbers/callsigns, not just fixing
    // misreads. The one case it's actually meant for is "ll" misread as "l1"
    // (wil1→will, al1→all, fal1→fall), so restrict the preceding letter to
    // l/L. Case-insensitive on purpose — WIL1→WILL should still work.
    cleaned = cleaned.replace(/([lL])1\b/g, '$1l');

    // 6b: l→1 when l appears in a NUMBER context (Tesseract sees 1 as l)
    //     Pattern: word ending in 'l' followed by dash/colon/period suggests
    //     it was originally "1" — e.g., "Textl-" → "Text 1-", "Chapterl:" → "Chapter 1:"
    //     Only apply when the 'l' is the LAST character of the word and the
    //     next character is a separator.
    cleaned = cleaned.replace(/([a-zA-Z]{2,})l\s*([\-:—–])/g, '$1 1 $2');

    // 6c: Also handle "Textl Simple" (l followed by space then capitalized word)
    //     If a word ends in 'l' and the next word starts with a capital,
    //     and the word before 'l' is a common noun/label, convert l→1.
    //     e.g., "Textl Simple" → "Text 1 Simple"
    cleaned = cleaned.replace(/([a-zA-Z]{2,})l\s+([A-Z][a-z])/g, (match, prefix, next) => {
      // Common words that precede numbers: Text, Chapter, Part, Section, Page, Step, Book, Level
      const numberPrefixes = ['text', 'chapter', 'part', 'section', 'page', 'step', 'book', 'level', 'test', 'quiz', 'lesson', 'unit', 'module', 'exercise', 'problem', 'question'];
      if (numberPrefixes.includes(prefix.toLowerCase())) {
        return prefix + ' 1 ' + next;
      }
      return match;
    });

    // 6d: 0→o/O between letters
    cleaned = cleaned.replace(/([a-z])0(?=[a-z])/g, '$1o');
    cleaned = cleaned.replace(/([A-Z])0(?=[A-Z])/g, '$1O');

    // Step 7: Strip stray quotation marks that appear mid-sentence.
    // OCR produces random " marks from decorative elements or screen artifacts.
    // A quote in the middle of a sentence (not at start/end) is likely noise.
    // Strategy: remove standalone " surrounded by letters/spaces.
    cleaned = cleaned.replace(/(\w)\s*"\s*(\w)/g, '$1 $2');

    // Step 8: Strip trailing/leading dot noise
    cleaned = cleaned.replace(/\s*\.{2,}\s*$/g, '');
    cleaned = cleaned.replace(/^\s*\.{2,}\s*/g, '');
    // Strip space before period/comma
    cleaned = cleaned.replace(/\s+\./g, '.');
    cleaned = cleaned.replace(/\s+,/g, ',');

    // Step 9: Strip garbled prefix
    cleaned = this._stripGarbledPrefix(cleaned);

    // Step 10: Remove stray single-character noise words.
    // Preserve 'I' and 'a' — they are real English words.
    // v3.13.79: the class below still had 'I' in it despite the comment —
    // fixed by removing 'I' from the class (mirrors _cleanPaddleOcrText).
    // Also protect button-prompt letters ("Press X to skip") via context —
    // see isProtectedButtonLetter() above.
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHJKLMNOPQRSTUVWXYZ]\s+/g,
      (m, offset) => isProtectedButtonLetter(cleaned, offset, m.length) ? m : ' ');
    cleaned = cleaned.replace(/^[bcdefghjklmnopqrstuvwxyzBCDEFGHJKLMNOPQRSTUVWXYZ]\s+/g,
      (m, offset) => isProtectedButtonLetter(cleaned, offset, m.length) ? m : '');
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHJKLMNOPQRSTUVWXYZ]$/g,
      (m, offset) => isProtectedButtonLetter(cleaned, offset, m.length) ? m : '');

    // Step 11: Fix truncated word at the end of text.
    // v3.13.79: used to blindly strip ANY trailing 1-2 letter word, which
    // destroyed real short words at the end of a line ("It is OK" → "It is",
    // "12:45 PM" → "12:45"). Only strip it when it's actually garbled —
    // COMMON_SHORT_WORDS (shared with _isGarbledWord()) is the same list
    // that already protects "I"/"a"/"to" elsewhere in this pipeline. Also
    // check isProtectedButtonLetter(): without it, a single button-prompt
    // letter Step 10 just preserved ("Press X") gets stripped right back
    // here when it's the very last token and has no "to"/"key" after it.
    cleaned = cleaned.replace(/\s+([a-zA-Z]{1,2})$/g, (match, word, offset) => {
      if (COMMON_SHORT_WORDS.has(word.toLowerCase())) return match;
      if (word.length === 1 && isProtectedButtonLetter(cleaned, offset, match.length)) return match;
      return '';
    });

    // Step 12: Final whitespace cleanup
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
  }

  /**
   * Strip garbled word prefixes from OCR text.
   * @param {string} text
   * @returns {string}
   */
  _stripGarbledPrefix(text) {
    if (!text || text.length < 10) return text;

    const sentenceEnders = text.match(/[.!?]+\s+/g);
    if (sentenceEnders && sentenceEnders.length > 0) {
      const firstEnd = text.indexOf(sentenceEnders[0]) + sentenceEnders[0].length;
      const firstSentence = text.substring(0, text.indexOf(sentenceEnders[0])).trim();

      if (firstSentence.length < 8 && firstSentence.length > 0) {
        const remaining = text.substring(firstEnd).trim();
        if (remaining.length > 0) return remaining;
      }

      const englishWords = firstSentence.match(/[a-zA-Z]{3,}/g);
      if (!englishWords || englishWords.length === 0) {
        const remaining = text.substring(firstEnd).trim();
        if (remaining.length > 0) return remaining;
      }
    }

    // Check if first several words are garbled
    const words = text.split(/\s+/);
    if (words.length >= 4) {
      let garbledCount = 0;
      let firstGoodIndex = -1;

      for (let i = 0; i < Math.min(words.length, 8); i++) {
        if (this._isGarbledWord(words[i])) {
          garbledCount++;
        } else {
          if (firstGoodIndex === -1) firstGoodIndex = i;
        }
      }

      if (garbledCount >= 2 && garbledCount >= firstGoodIndex && firstGoodIndex > 0) {
        const remaining = words.slice(firstGoodIndex).join(' ');
        if (remaining.length >= 10) return remaining;
      }
    }

    return text;
  }

  /**
   * Check if a word looks garbled (OCR noise).
   * @param {string} word
   * @returns {boolean}
   */
  _isGarbledWord(word) {
    if (!word) return true;
    const w = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
    if (w.length === 0) return false;

    if (w.length <= 2) return !COMMON_SHORT_WORDS.has(w.toLowerCase());

    const hasVowel = /[aeiouyAEIOUY]/.test(w);
    if (!hasVowel) return true;

    const consonantClusters = w.match(/[^aeiouyAEIOUY]{4,}/g);
    if (consonantClusters) return true;

    return false;
  }

  /**
   * Check if the overall text is mostly garbled.
   * @param {string} text
   * @returns {boolean}
   */
  _isMostlyGarbled(text) {
    if (!text) return true;

    // v3.13.79: dropped the old "text.length < 5 -> garbled" floor. It ran
    // BEFORE the CJK exemption below, so it was blanket-killing every short
    // real result regardless of script: common English interjections
    // ("Well", "Stop", "Nice" — all 4 chars) and even short CJK replies
    // ("はい", 2 chars). The upstream min-chars gate (ocr.js, before this
    // call) already requires >=2 real chars (or >=1 CJK char), and the
    // per-word heuristics below already correctly judge short text on its
    // own merits (real short words via the commonShort Set in
    // _isGarbledWord, real noise via the vowel/consonant checks) — so this
    // extra length floor was redundant on top of them, not a needed safety
    // net.

    // v3.13.08-fix: CJK-aware garbled check. For text containing CJK characters,
    // skip the garbled word check entirely — vowel/consonant heuristics are designed
    // for English/Latin text and produce false positives for CJK characters.
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
    if (cjkCount > 0) return false; // CJK text is never "garbled" by Latin heuristics

    const words = text.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length > 0);
    // v3.13.79: a string with zero Latin "words" but real digits (clocks,
    // counters, HP/scores) isn't garbled \u2014 it's just not Latin prose. Only
    // the CJK/word-heuristic path below is meant for Latin noise detection.
    if (words.length === 0 && /[0-9]/.test(text)) return false;
    if (words.length === 0) return true;

    let garbledCount = 0;
    for (const word of words) {
      if (this._isGarbledWord(word)) garbledCount++;
    }

    // v3.13.08-fix: Raised from 0.6 to 0.8 — only skip if >80% of words are garbled.
    // The previous 60% threshold was still too aggressive, rejecting RPG battle text
    // and low-quality scans that had some real words mixed with OCR noise.
    // The translation engine can handle partially garbled input.
    // v3.13.10: Raised from 0.8 to 0.9 — only skip if >90% garbled. Following
    // Luna Translator and VN Translator's approach of passing through most OCR
    // output, since translation engines can often extract meaning from even
    // heavily garbled text.
    // v3.13.14: Raised to 0.95 — essentially disabled. Only skip if >95% garbled.
    // Low-quality images and RPG battle screens produce partially garbled text
    // that still contains translatable fragments. The translation engine is
    // better at making sense of this than our garbled-word heuristics.
    return (garbledCount / words.length) > 0.95;
  }

  /**
   * v3.13.10: Auto-detect language switching for Tesseract.
   * When sourceLang='auto', Tesseract uses English (eng) which can't read CJK/Korean.
   * After the first recognition pass, if the result is empty or very low quality,
   * try switching to Japanese (jpn) or Korean (kor) model.
   * 
   * This mirrors PaddleOCR's _maybeSwitchModelForAutoDetect() but for Tesseract.
   * Tesseract's language data is downloaded from its CDN automatically on initialization.
   * 
   * @param {string} text - Raw Tesseract text output
   * @param {number} confidence - Tesseract confidence (0-100)
   * @param {Buffer} imageBuffer - Original image buffer (for potential re-recognition)
   * @returns {boolean} true if language was switched and worker reinitialized
   * @private
   */
  async _maybeSwitchTesseractLangForAutoDetect(text, confidence, imageBuffer) {
    if (this._sourceLang !== 'auto') return false;
    if (this._language !== 'eng') return false; // Only switch from English default

    const trimmedText = (text || '').trim();
    const isMostlyGarbled = this._isMostlyGarbled(trimmedText);
    const isVeryLowConfidence = confidence < 15;
    const isEmpty = trimmedText.length < 2;

    // Check for hangul characters that Tesseract-English can't read at all
    const hasHangul = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(trimmedText);

    // v3.13.79 (2.3): a pure digit/punctuation capture (a clock, a counter,
    // "35:97") has NO letters of any script, so _isMostlyGarbled() below
    // classifies it as "mostly garbled" purely because it has zero
    // alphabetic words to check — not because it's actually CJK. That was
    // the real cause of the log line this round's plan was built around:
    // "35:97" -> switched to Japanese -> hallucinated "2 に" at 24%
    // confidence. A frame like this is genuinely inconclusive (could be a
    // timer, could be a scoreboard) — treat it as neither good nor bad
    // evidence rather than guessing, and leave the fail streak untouched.
    const hasAnyLetters = /[a-zA-Z\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(trimmedText);
    const isMostlyDigitsOrPunct = trimmedText.length > 0 && !hasAnyLetters;
    if (isMostlyDigitsOrPunct) {
      log.info(`[OCR] Auto-detect: ignoring digit/punctuation-only capture as evidence: "${trimmedText.substring(0, 30)}"`);
      return false;
    }

    // v3.13.79 (2.2): hangul showing up in English-model output is direct,
    // unambiguous evidence (the model has no way to produce those code
    // points on its own) so it still acts immediately, same as before this
    // round. Everything else (empty/garbled/low-confidence) is much weaker
    // evidence on its own — a single bad frame used to be enough to switch
    // the whole session to Japanese and never come back. Now non-hangul
    // evidence has to repeat for 3 consecutive frames before it's trusted.
    if (hasHangul) {
      this._autoDetectFailStreak = 0;
      log.info(`[OCR] Auto-detect: English Tesseract produced hangul-containing text (${confidence.toFixed(1)}%) — switching to Korean model`);
      return this._attemptAutoDetectSwitch('kor', 'Korean', 'jpn', 'Japanese');
    }

    if (isEmpty || isMostlyGarbled || isVeryLowConfidence) {
      this._autoDetectFailStreak++;
      const reason = isEmpty ? 'empty' : isMostlyGarbled ? 'garbled' : 'low confidence';
      log.info(`[OCR] Auto-detect: English Tesseract produced ${reason} text (${confidence.toFixed(1)}%) — streak ${this._autoDetectFailStreak}/3: "${trimmedText.substring(0, 30)}"`);
      if (this._autoDetectFailStreak < 3) return false;

      this._autoDetectFailStreak = 0;
      log.info('[OCR] Auto-detect: 3 consecutive bad English frames — switching to Japanese model');
      return this._attemptAutoDetectSwitch('jpn', 'Japanese', 'kor', 'Korean');
    }

    // A good English frame — whatever streak was building resets.
    this._autoDetectFailStreak = 0;
    return false;
  }

  /**
   * v3.9.8: Compute text similarity between two OCR texts.
   * Uses word overlap ratio (Jaccard-like) combined with prefix matching.
   * Returns a value between 0 (completely different) and 1 (identical).
   *
   * This is the KEY improvement: when OCR produces slightly different readings
   * of the same game text (e.g., "woke up and g" vs "woke up and got"),
   * they share most words and should be considered the same text.
   *
   * @param {string} textA
   * @param {string} textB
   * @returns {number} similarity 0-1
   */
  _computeSimilarity(textA, textB) {
    if (!textA || !textB) return 0;
    if (textA === textB) return 1;

    const wordsA = textA.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const wordsB = textB.toLowerCase().split(/\s+/).filter(w => w.length > 0);

    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    // Method 1: Word set overlap (Jaccard-like)
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    const jaccardSimilarity = union > 0 ? intersection / union : 0;

    // Method 2: Prefix similarity — how much of the shorter text
    // matches the beginning of the longer text.
    // This catches cases where one text is a truncated version of the other.
    const shorter = wordsA.length < wordsB.length ? wordsA : wordsB;
    const longer = wordsA.length < wordsB.length ? wordsB : wordsA;
    let prefixMatch = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] === longer[i]) {
        prefixMatch++;
      } else {
        break; // Stop at first mismatch
      }
    }
    const prefixSimilarity = shorter.length > 0 ? prefixMatch / shorter.length : 0;

    // Combine: use the MAX of both methods.
    // - Jaccard catches rephrasings/reorderings
    // - Prefix catches truncations
    return Math.max(jaccardSimilarity, prefixSimilarity);
  }

  /**
   * v3.9.8: Check if two OCR texts are similar enough to be considered
   * the same game dialogue. Uses _computeSimilarity with the threshold.
   * @param {string} newText
   * @param {string} lastText
   * @returns {boolean} true if texts are similar (should skip translation)
   */
  _isSimilarText(newText, lastText) {
    const similarity = this._computeSimilarity(newText, lastText);
    return similarity >= this._similarityThreshold;
  }

  async terminate() {
    this.stopAutoCapture();
    if (this._worker) {
      try {
        await this._worker.terminate();
      } catch (err) {
        log.warn('[OCR] Error terminating worker:', err.message);
      }
      this._worker = null;
    }
    // v3.13.01: Also terminate PaddleOCR engine
    if (this._paddleEngine) {
      try {
        await this._paddleEngine.terminate();
      } catch (err) {
        log.warn('[OCR] Error terminating PaddleOCR:', err.message);
      }
    }
    this._isReady = false;
    this._initialized = false;
    this._isBusy = false;
    this.emit('status', 'terminated');
    log.info('[OCR] Service terminated');
  }
}

module.exports = OcrService;
