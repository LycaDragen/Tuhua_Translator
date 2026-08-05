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
    this._preprocessing = {
      grayscale: true,
      threshold: false,
      thresholdValue: 128,
      contrast: false,
      contrastValue: 1.5
    };
    this._autoCaptureMs = 3500; // v3.9.9: reduced from 7000ms for faster scanning
    // v3.13.08: Lowered from 55 to 0 — same philosophy as PaddleOCR path:
    // the translation engine handles imperfect OCR better than no input.
    // A 55% threshold was rejecting RPG battle text and low-quality scans.
    // Users can override via the 'ocrMinConfidence' store key.
    this._minConfidence = 0;
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
   * v3.13.01: Get PaddleOCR download progress
   */
  getPaddleDownloadProgress() {
    return this._paddleEngine.getStatus().downloadProgress;
  }

  /**
   * v3.13.01: Delete PaddleOCR model files to free disk space
   */
  async deletePaddleModels() {
    await this._paddleEngine.deleteModels();
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

      this._worker = await Tesseract.createWorker(this._language, 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            this.emit('progress', m.progress);
          }
          log.debug(`[OCR] Tesseract: ${m.status} (${Math.round((m.progress || 0) * 100)}%)`);
        }
      });

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
      return this._recognizePaddle(imageBuffer);
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
  async _recognizePaddle(imageBuffer) {
    if (this._isBusy) {
      log.warn('[OCR] Busy, skipping PaddleOCR request');
      return { text: '', confidence: 0, regions: 0, regionStages: null, recModel: null };
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
        return { text: '', confidence: result.confidence, regions: result.regions, regionStages: result.regionStages, recModel: result.recModel };
      }

      // Log low confidence but still pass through — translation engine may handle it
      if (result.confidence < 0.15) {
        log.info(`[OCR/Paddle] Low confidence (${(result.confidence * 100).toFixed(1)}%) but passing through: "${text.substring(0, 60)}"`);
      }

      // Similarity dedup (same as Tesseract path)
      if (this._lastEmittedText && this._isSimilarText(text, this._lastEmittedText)) {
        const similarity = this._computeSimilarity(text, this._lastEmittedText);
        log.info(`[OCR/Paddle] Similar text skipped (${(similarity * 100).toFixed(0)}% similar): "${text.substring(0, 50)}"`);
        this.emit('status', 'ready');
        return { text, confidence: result.confidence, regions: result.regions, regionStages: result.regionStages, recModel: result.recModel };
      }

      this._lastEmittedText = text;
      log.info(`[OCR/Paddle] Recognized text (${(result.confidence * 100).toFixed(1)}%): "${text.substring(0, 80)}"`);
      this.emit('text', text);
      this.emit('status', 'ready');
      return { text, confidence: result.confidence, regions: result.regions, regionStages: result.regionStages, recModel: result.recModel };
    } catch (err) {
      log.error('[OCR/Paddle] Recognition error:', err.message);
      this.emit('error', err);
      this.emit('status', 'error');
      return { text: '', confidence: 0, regions: 0, regionStages: null, recModel: null };
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
      let processedImage = imageBuffer;
      if (this._preprocessing.grayscale || this._preprocessing.threshold || this._preprocessing.contrast) {
        processedImage = await this._preprocessImage(imageBuffer);
      }

      const result = await this._worker.recognize(processedImage);
      let rawText = result.data.text.trim();
      let confidence = result.data.confidence;

      // v3.13.10: Auto-detect language switching for Tesseract.
      // When sourceLang is 'auto', Tesseract defaults to English (eng) which
      // can't read CJK/Korean at all. If the result is empty or garbage but
      // the image clearly contains text, try switching to Japanese (jpn) or
      // Korean (kor) model. This follows the same pattern as PaddleOCR's
      // _maybeSwitchModelForAutoDetect() but for Tesseract.
      if (this._sourceLang === 'auto' && this._language === 'eng') {
        const switched = await this._maybeSwitchTesseractLangForAutoDetect(rawText, confidence, imageBuffer);
        if (switched) {
          // Re-recognize with the new language model
          try {
            const reResult = await this._worker.recognize(processedImage);
            rawText = reResult.data.text.trim();
            confidence = reResult.data.confidence;
            log.info(`[OCR] Re-recognized with ${this._language}: "${rawText.substring(0, 60)}" (${confidence.toFixed(1)}%)`);
          } catch (reErr) {
            log.warn(`[OCR] Re-recognition with ${this._language} failed: ${reErr.message}`);
          }
        }
      }

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
        return { text: '', confidence };
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
        this.emit('status', 'ready');
        return { text: '', confidence };
      }

      // v3.9.8: SIMILARITY-BASED DEDUP — don't re-emit text that is >80%
      // similar to the last emitted text. This is the key improvement:
      // OCR produces slightly different readings each scan (e.g., "woke up
      // and g" vs "woke up and got"), but they represent the same game text.
      // Only emit when the text is genuinely NEW (different game dialogue).
      if (this._lastEmittedText && this._isSimilarText(text, this._lastEmittedText)) {
        const similarity = this._computeSimilarity(text, this._lastEmittedText);
        log.info(`[OCR] Similar text skipped (${(similarity * 100).toFixed(0)}% similar to last): "${text.substring(0, 50)}"`);
        this.emit('status', 'ready');
        return { text, confidence };
      }

      this._lastEmittedText = text;
      log.info(`[OCR] Recognized text (${confidence.toFixed(1)}% confidence): "${text.substring(0, 80)}"`);
      this.emit('text', text);

      this.emit('status', 'ready');
      return { text, confidence };
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

  setPreprocessing(options) {
    this._preprocessing = { ...this._preprocessing, ...options };
    log.info('[OCR] Preprocessing updated:', JSON.stringify(this._preprocessing));
  }

  setChangeThreshold(threshold) {
    this._changeThreshold = Math.max(0, Math.min(100, threshold));
  }

  /**
   * v3.13.08: Set the minimum Tesseract confidence threshold.
   * Default is 0 (no minimum — let translation engine handle imperfect OCR).
   * Can be raised via the 'ocrMinConfidence' store key for users who prefer
   * stricter filtering.
   * @param {number} threshold - Minimum confidence (0-100)
   */
  setMinConfidence(threshold) {
    this._minConfidence = Math.max(0, Math.min(100, Number(threshold) || 0));
    log.info(`[OCR] Min confidence set to: ${this._minConfidence}`);
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
      ocrEngine: this._ocrEngine,
      minConfidence: this._minConfidence,  // v3.13.08: Expose current threshold
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

  async _preprocessImage(imageBuffer) {
    try {
      if (this._worker) {
        const params = {};
        if (this._preprocessing.threshold) {
          params.tessedit_thresholding_method = '1';
          params.tessedit_threshold_value = String(this._preprocessing.thresholdValue || 128);
        }
        if (Object.keys(params).length > 0) {
          await this._worker.setParameters(params);
        }
      }
    } catch (err) {
      log.warn('[OCR] Preprocessing parameter error:', err.message);
    }
    return imageBuffer;
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
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ]\s+/g, ' ');
    cleaned = cleaned.replace(/^[bcdefghjklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ]\s+/g, '');
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ]$/g, '');

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
    cleaned = cleaned.replace(/([a-zA-Z])1\b/g, '$1l');

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
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ]\s+/g, ' ');
    cleaned = cleaned.replace(/^[bcdefghjklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ]\s+/g, '');
    cleaned = cleaned.replace(/\s+[bcdefghjklmnopqrstuvwxyzBCDEFGHIJKLMNOPQRSTUVWXYZ]$/g, '');

    // Step 11: Fix truncated word at the end of text.
    cleaned = cleaned.replace(/\s+[a-zA-Z]{1,2}$/g, '');

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

    const commonShort = new Set([
      'i', 'a', 'an', 'am', 'be', 'do', 'go', 'he', 'in', 'is',
      'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up',
      'us', 'we', 'as', 'at', 'by', 'if', 'no', 'ok', 'oh'
    ]);

    if (w.length <= 2) return !commonShort.has(w.toLowerCase());

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
    if (!text || text.length < 5) return true;

    // v3.13.08-fix: CJK-aware garbled check. For text containing CJK characters,
    // skip the garbled word check entirely — vowel/consonant heuristics are designed
    // for English/Latin text and produce false positives for CJK characters.
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
    if (cjkCount > 0) return false; // CJK text is never "garbled" by Latin heuristics

    const words = text.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length > 0);
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

    // If Tesseract produced empty or very low quality output, it likely
    // encountered non-English text. In a VN/translation context, Japanese
    // is the most common language, so try that first. Korean is second.
    if (isEmpty || isMostlyGarbled || isVeryLowConfidence || hasHangul) {
      // Determine which language to try first
      const targetLang = hasHangul ? 'kor' : 'jpn';
      const targetLangName = hasHangul ? 'Korean' : 'Japanese';

      log.info(`[OCR] Auto-detect: English Tesseract produced ${isEmpty ? 'empty' : isMostlyGarbled ? 'garbled' : isVeryLowConfidence ? 'low confidence' : 'hangul-containing'} text (${confidence.toFixed(1)}%) — switching to ${targetLangName} model`);

      try {
        // Terminate current worker and reinitialize with new language
        if (this._worker) {
          try { await this._worker.terminate(); } catch (e) { /* ignore */ }
          this._worker = null;
        }

        this._language = targetLang;
        this._worker = await Tesseract.createWorker(this._language, 1, {
          logger: (m) => {
            if (m.status === 'recognizing text') {
              this.emit('progress', m.progress);
            }
            log.debug(`[OCR] Tesseract: ${m.status} (${Math.round((m.progress || 0) * 100)}%)`);
          }
        });

        log.info(`[OCR] Switched Tesseract to ${targetLangName} model for auto-detect`);
        return true;
      } catch (err) {
        log.warn(`[OCR] Failed to switch Tesseract to ${targetLangName}: ${err.message}`);
        // Try the other language as fallback
        const fallbackLang = hasHangul ? 'jpn' : 'kor';
        const fallbackLangName = hasHangul ? 'Japanese' : 'Korean';
        try {
          if (this._worker) {
            try { await this._worker.terminate(); } catch (e) { /* ignore */ }
            this._worker = null;
          }

          this._language = fallbackLang;
          this._worker = await Tesseract.createWorker(this._language, 1, {
            logger: (m) => {
              if (m.status === 'recognizing text') {
                this.emit('progress', m.progress);
              }
            }
          });

          log.info(`[OCR] Switched Tesseract to ${fallbackLangName} model as fallback`);
          return true;
        } catch (fbErr) {
          log.warn(`[OCR] Fallback to ${fallbackLangName} also failed: ${fbErr.message}`);
          // Stay with English — at least we can try to read some Latin characters
          return false;
        }
      }
    }

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
