/**
 * OCR Service - Tesseract.js Integration
 *
 * Provides text recognition from screen captures using tesseract.js.
 * Supports language mapping, pre-processing, and auto-capture with change detection.
 *
 * v3.9.8: Text similarity dedup — if new OCR text is >80% similar to the last
 *         emitted text, it is NOT re-emitted for translation. This prevents
 *         re-translating the same game dialogue when OCR produces slightly
 *         different readings (e.g., "woke up and g" vs "woke up and got").
 *         Also strips Unicode smart quotes, fixes truncated word boundaries,
 *         and normalizes punctuation for cleaner output.
 */
const Tesseract = require('tesseract.js');
const EventEmitter = require('events');
const log = require('electron-log');

// Map from app language codes to tesseract language codes
const LANG_MAP = {
  'ja': 'jpn',
  'en': 'eng',
  'zh': 'chi_sim',
  'ko': 'kor',
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
    this._minConfidence = 55;
    this._initialized = false;
    this._lastEmittedText = '';
    this._captureFn = null;
    // v3.9.8: Similarity threshold for text dedup.
    // If new text shares >80% of words with last emitted text, skip it.
    this._similarityThreshold = 0.80;
  }

  async initialize(lang) {
    if (this._initialized && this._worker) {
      const tessLang = LANG_MAP[lang] || LANG_MAP['ja'];
      if (tessLang === this._language && this._isReady) {
        log.info('[OCR] Already initialized with language:', this._language);
        return;
      }
      await this.terminate();
    }

    this._sourceLang = lang || 'ja';
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
      const rawText = result.data.text.trim();
      const confidence = result.data.confidence;

      const text = this._cleanOcrText(rawText);

      if (text.length < 3 || confidence < this._minConfidence) {
        log.info(`[OCR] Skipping low quality result (${confidence.toFixed(1)}%, min=${this._minConfidence}%, ${text.length} chars): "${text.substring(0, 60)}"`);
        this.emit('status', 'ready');
        return { text: '', confidence };
      }

      // v3.9.8: Garbled-word ratio check
      if (this._isMostlyGarbled(text)) {
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
    if (tessLang === this._language) return;
    log.info(`[OCR] Changing language from ${this._language} to ${tessLang}`);
    this._sourceLang = lang;
    await this.initialize(lang);
  }

  setPreprocessing(options) {
    this._preprocessing = { ...this._preprocessing, ...options };
    log.info('[OCR] Preprocessing updated:', JSON.stringify(this._preprocessing));
  }

  setChangeThreshold(threshold) {
    this._changeThreshold = Math.max(0, Math.min(100, threshold));
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
      preprocessing: { ...this._preprocessing }
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
      return ratio >= 0.4;
    });

    let cleaned = goodLines.join(' ').trim();

    // Step 3: Strip OCR artifact characters that are NEVER real game dialogue.
    // ~ : Tesseract uses this for line separators, decorative borders, em-dashes.
    // | : Pipe character is almost never in game text, it's a vertical border artifact.
    // ` : Backtick is often a misread quote mark.
    cleaned = cleaned.replace(/[~|`]/g, ' ');

    // Step 4: Strip non-ASCII for English model, but keep basic Latin + accented.
    // Note: ~ was already removed in step 3, so it won't survive here either.
    if (this._language === 'eng') {
      cleaned = cleaned.replace(/[^\x20-\x7E\u00C0-\u024F]/g, ' ');
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

    const words = text.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length > 0);
    if (words.length === 0) return true;

    let garbledCount = 0;
    for (const word of words) {
      if (this._isGarbledWord(word)) garbledCount++;
    }

    return (garbledCount / words.length) > 0.4;
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
    this._isReady = false;
    this._initialized = false;
    this._isBusy = false;
    this.emit('status', 'terminated');
    log.info('[OCR] Service terminated');
  }
}

module.exports = OcrService;
