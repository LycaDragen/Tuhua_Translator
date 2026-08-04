/**
 * PaddleOCR Engine — ONNX-based OCR pipeline for Tuhua Translator
 *
 * Pipeline: Image → Detection (DB) → Crop+Rotate → Recognition (CRNN+CTC) → Text
 *
 * No classification model — vertical text is detected heuristically
 * (height ≥ 1.5× width → rotate 90° CCW), following Luna Translator's approach.
 *
 * v3.13.01: Initial implementation
 * v3.13.02: Vertical text rotation, tuned detection/recognition parameters
 * v3.13.03: Multi-region filtering and merging, outlier region removal,
 *           max region limit to avoid confusion from too many detected areas
 * v3.13.04: Multi-language recognition model support. Automatically selects
 *           the correct recognition model based on sourceLang:
 *           - 'ja' → Japanese model (proper kana + kanji readings)
 *           - 'ko' → Korean model (hangul support)
 *           - 'zh', 'auto', others → Chinese model (broadest CJK coverage)
 *           Models are downloaded on-demand when their language is first needed.
 *           Also improved RPG Battle region filtering with dynamic thresholds.
 * v3.13.05: Japanese/Korean vertical text reading order (right-to-left columns),
 *           improved region sorting for RPG battle screens with mixed directions.
 * v3.13.07: Further lowered thresholds — recMinConfidence (0.20→0.10),
 *   crowdedRegionThresh (8→12), crowdedMinConf (0.35→0.25). Even with
 *   v3.13.06's lowered values, RPG battle text and low-quality scans were
 *   still being filtered out. The translation engine can handle imperfect
 *   OCR better than no input at all.
 * v3.13.08-fix: Removed recMinConfidence threshold entirely (0.10→0) — even
 *   very low confidence PaddleOCR results can contain translatable text.
 *   Raised crowdedRegionThresh (12→20) and lowered crowdedMinConf (0.25→0.10)
 *   to allow more regions through on busy screens. Added graceful fallback:
 *   when Korean/Japanese model fails, Chinese model is used instead of
 *   falling back all the way to Tesseract.
 * v3.13.12: Pre-download ALL recognition models (zh+ja+ko) during initialize()
 *   when sourceLang='auto', instead of only the Chinese model. This eliminates
 *   the delay when auto-detect first encounters Korean/Japanese text and needs
 *   to download the model on-demand. Following Luna Translator's approach of
 *   having all models ready at startup.
 */

const EventEmitter = require('events');
const log = require('electron-log');

let ort = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  // Will be handled by PaddleModelManager
}

const { PaddleModelManager, getRecModelKeyForLang, REC_MODELS } = require('./paddle-models');
const { preprocessForDetection, preprocessForRecognition, cropRegion, isVerticalText, rotate90CCW } = require('./paddle-preprocess');
const { decodeDetection, decodeRecognition } = require('./paddle-postprocess');

class PaddleOCREngine extends EventEmitter {
  constructor() {
    super();
    this._modelManager = new PaddleModelManager();
    this._isReady = false;
    this._isBusy = false;
    this._initialized = false;
    this._sourceLang = 'auto';  // v3.13.04: Track source language for model selection
    this._options = {
      maxSideLen: 1280,
      detBinThresh: 0.3,
      detBoxThresh: 0.3,
      detUnclipRatio: 2.0,
      recMinConfidence: 0,    // v3.13.08-fix: Removed threshold — same as Tesseract path, let translation engine decide
      // v3.13.03: Multi-region filtering and merging options
      minRegionArea: 100,
      mergeRegionGap: 15,
      maxRegions: 15,
      // v3.13.04: Dynamic region filtering for crowded screens (RPG battles)
      // v3.13.08-fix: Further relaxed — previous values still filtered out too many
      // regions on RPG battle screens and low-quality scans. The translation engine
      // (Google/DeepL) handles imperfect OCR better than no input at all.
      // v3.13.14: Further relaxed following VN Translator and Luna Translator's
      // approach of passing ALL detected regions through to the translation engine.
      // The translation engine is much better at handling imperfect OCR text than
      // our heuristics are at filtering it. Only filter truly noise-level regions.
      crowdedRegionThresh: 50, // v3.13.14: Raised from 30 — allow even more regions before filtering
      crowdedMinConf: 0.02     // v3.13.14: Lowered from 0.05 — only filter absolute noise
    };
  }

  /**
   * Check if the PaddleOCR engine is available (onnxruntime-node installed)
   */
  static isAvailable() {
    return ort !== null;
  }

  /**
   * v3.13.04: Set the source language for recognition model selection.
   * If the language requires a different model (ja/ko), it will be
   * downloaded and loaded on the next recognize() call.
   * @param {string} lang - Source language code ('ja', 'ko', 'zh', 'auto', etc.)
   */
  setSourceLang(lang) {
    const prevLang = this._sourceLang;
    this._sourceLang = lang || 'auto';
    if (prevLang !== this._sourceLang) {
      log.info(`[PaddleOCR] Source language changed: ${prevLang} → ${this._sourceLang}`);
    }
  }

  /**
   * v3.13.04: Get available (downloaded) recognition models
   * @returns {string[]} Array of model keys like ['zh', 'ja', 'ko']
   */
  getDownloadedModels() {
    return this._modelManager.getDownloadedRecModels();
  }

  /**
   * Initialize the PaddleOCR engine.
   * Downloads models if needed, then loads ONNX sessions.
   * v3.13.04: Also downloads and loads the language-specific recognition
   * model if sourceLang is set to ja/ko.
   *
   * @param {function} onProgress - Progress callback { stage, file, percent }
   * @param {string} sourceLang - Source language for model selection (optional)
   */
  async initialize(onProgress, sourceLang) {
    if (this._initialized && this._isReady) {
      log.info('[PaddleOCR] Already initialized');
      return;
    }

    if (!ort) {
      throw new Error('onnxruntime-node is not installed. PaddleOCR requires onnxruntime-node.');
    }

    // v3.13.04: Track source language
    if (sourceLang) {
      this._sourceLang = sourceLang;
    }

    try {
      this.emit('status', 'downloading');

      // Step 1: Download default models (det + zh rec)
      if (onProgress) onProgress({ stage: 'download', percent: 0 });
      await this._modelManager.ensureModels((progress) => {
        if (onProgress) onProgress({ stage: 'download', file: progress.file, percent: progress.percent });
      });

      // v3.13.12: Pre-download ALL recognition models when sourceLang='auto'.
      // Previously, only the Chinese model was downloaded at startup, and
      // Korean/Japanese models were downloaded on-demand when auto-detect
      // first encountered their text. This caused a multi-second delay on
      // the first recognition pass with Korean text. Following Luna Translator's
      // approach of having all models ready at startup.
      const recKey = getRecModelKeyForLang(this._sourceLang);
      if (this._sourceLang === 'auto') {
        log.info('[PaddleOCR] Auto-detect mode: pre-downloading all recognition models (ja, ko)...');
        for (const langKey of ['ja', 'ko']) {
          try {
            if (!this._modelManager.isRecModelDownloaded(langKey)) {
              log.info(`[PaddleOCR] Pre-downloading ${langKey} model for auto-detect...`);
              await this._modelManager.ensureRecModel(langKey, (progress) => {
                if (onProgress) onProgress({ stage: 'download', file: progress.file, percent: progress.percent });
              });
            }
          } catch (downloadErr) {
            log.warn(`[PaddleOCR] Failed to pre-download ${langKey} model: ${downloadErr.message} — will download on-demand later`);
          }
        }
      } else if (recKey !== 'zh') {
        // Step 2: Download language-specific model if needed (non-auto)
        log.info(`[PaddleOCR] Source language ${this._sourceLang} requires ${recKey} model, downloading...`);
        await this._modelManager.ensureRecModel(recKey, (progress) => {
          if (onProgress) onProgress({ stage: 'download', file: progress.file, percent: progress.percent });
        });
      }

      // Step 3: Load ONNX sessions
      this.emit('status', 'loading');
      if (onProgress) onProgress({ stage: 'loading', percent: 0 });
      await this._modelManager.loadSessions({ numThreads: 4 });

      // Step 4: Switch to language-specific recognition model if needed
      if (recKey !== 'zh') {
        await this._modelManager.switchRecModel(recKey);
      }

      this._isReady = true;
      this._initialized = true;
      this.emit('status', 'ready');
      if (onProgress) onProgress({ stage: 'ready', percent: 100 });

      log.info(`[PaddleOCR] Engine initialized and ready (rec model: ${recKey})`);
    } catch (err) {
      this._isReady = false;
      this.emit('status', 'error');
      this.emit('error', err);
      log.error('[PaddleOCR] Initialization failed:', err.message);
      throw err;
    }
  }

  /**
   * v3.13.04: Ensure the correct recognition model is loaded for the current sourceLang.
   * Called before each recognition pass. Downloads and switches models on-demand.
   * v3.13.06: When sourceLang='auto', detect from the image text whether we need
   *   a Korean or Japanese model. The Chinese model can't read hangul at all, so
   *   if the image contains Korean text, we must switch to the Korean model.
   * @private
   */
  async _ensureCorrectRecModel() {
    const recKey = getRecModelKeyForLang(this._sourceLang);
    const currentLang = this._modelManager.getActiveRecLang();

    // v3.13.06: For auto-detect mode, we initially use the Chinese model (broadest
    // CJK coverage for detection). But after the first recognition pass, if the
    // text is empty or very low confidence with 0 CJK chars but some detected
    // regions, we should try the Korean model (hangul can't be read by Chinese model).
    // This is handled in _maybeSwitchModelForAutoDetect() after recognition.
    if (recKey === currentLang) return; // Already using the right model

    log.info(`[PaddleOCR] Switching recognition model: ${currentLang} → ${recKey}`);

    // Download if needed
    if (!this._modelManager.isRecModelDownloaded(recKey)) {
      this.emit('status', 'downloading');
      log.info(`[PaddleOCR] Downloading ${recKey} recognition model on-demand...`);
      try {
        await this._modelManager.ensureRecModel(recKey, (progress) => {
          log.info(`[PaddleOCR] Download ${recKey} model: ${progress.percent}%`);
        });
      } catch (downloadErr) {
        // v3.13.08-fix: If Korean/Japanese model download fails, fall back to
        // Chinese model (which has broad CJK coverage) instead of crashing or
        // falling all the way to Tesseract. The Chinese model can still read
        // some Korean hangul and Japanese kanji via CJK Unified Ideographs.
        log.warn(`[PaddleOCR] Failed to download ${recKey} model: ${downloadErr.message}`);
        log.info(`[PaddleOCR] Falling back to Chinese model (broad CJK coverage)`);
        // Make sure Chinese model is available
        if (currentLang === 'zh') return; // Already on Chinese model
        try {
          await this._modelManager.switchRecModel('zh');
        } catch (switchErr) {
          log.warn(`[PaddleOCR] Failed to switch to Chinese model: ${switchErr.message}`);
        }
        this.emit('status', 'ready');
        return;
      }
    }

    // Switch model
    try {
      await this._modelManager.switchRecModel(recKey);
    } catch (switchErr) {
      // v3.13.08-fix: If model switching fails (e.g., incompatible ONNX), fall back
      log.warn(`[PaddleOCR] Failed to switch to ${recKey} model: ${switchErr.message}`);
      log.info(`[PaddleOCR] Staying with current model (${currentLang}) as fallback`);
    }
    this.emit('status', 'ready');
  }

  /**
   * v3.13.06: When sourceLang='auto', check if the recognition result suggests
   * we should be using a different model. If the Chinese model produces empty
   * or very low-quality results but regions were detected, try Korean model.
   * Called after recognition completes.
   * @param {string} text - Recognized text
   * @param {number} confidence - Recognition confidence
   * @param {number} regionCount - Number of detected text regions
   * @private
   */
  async _maybeSwitchModelForAutoDetect(text, confidence, regionCount) {
    if (this._sourceLang !== 'auto') return; // Only for auto-detect mode
    if (this._modelManager.getActiveRecLang() !== 'zh') return; // Already switched

    // v3.13.10: Improved Korean detection — check for hangul Jamo (U+1100-11FF)
    // and compatibility hangul (U+3130-318F) in addition to syllable block hangul.
    // The Chinese model may produce garbled nonsense instead of empty text
    // when encountering Korean, so we also check for low-quality output.
    const hasHangul = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text);
    const hasLowQuality = text.length > 0 && confidence < 0.15 && regionCount > 0;
    const hasNoText = text.length === 0 && regionCount > 0;
    // v3.13.10: Check if text looks like garbled CJK (Chinese model misreading hangul)
    // Pattern: mostly CJK ideographs but with unusual repetition or no recognizable words
    // v3.13.14: Raised confidence threshold from 0.30 to 0.40 — the Chinese model
    // can misread Korean hangul as CJK ideographs with moderate confidence (0.25-0.35),
    // producing garbled text that looks plausible but is completely wrong. Following
    // VN Translator's approach of trying Korean first when confidence is below 0.40
    // and there's significant CJK content (likely a misread).
    const hasGarbledCJK = text.length > 0 && regionCount > 0 &&
      (text.match(/[\u4e00-\u9fff]/g) || []).length > text.length * 0.5 &&
      confidence < 0.40;

    // v3.13.14: Also detect Korean by checking for repeated short CJK sequences.
    // When the Chinese model misreads Korean hangul, it often produces the same
    // wrong character repeatedly (e.g., "口口口" or "〇〇〇"). If we see 3+ repeated
    // identical CJK characters in a row, that's a strong signal of Korean misread.
    const hasRepeatedMisread = text.length > 0 && regionCount > 0 && confidence < 0.40 &&
      /([\u4e00-\u9fff])\1{2,}/.test(text);

    // v3.13.14: Also try Korean when there are many short regions with low-moderate
    // confidence. Korean text often gets split into many small regions by the
    // detection model because hangul characters have a different aspect ratio
    // than what the Chinese model expects. If we have many regions and the
    // average confidence is below 0.50, Korean model might be better.
    const hasManyLowConfRegions = regionCount >= 3 && confidence < 0.50 && text.length > 0;

    if (hasNoText || hasHangul || hasLowQuality || hasGarbledCJK || hasRepeatedMisread || hasManyLowConfRegions) {
      const reason = hasNoText ? 'no text' : hasHangul ? 'hangul detected' : hasLowQuality ? 'low quality' : hasRepeatedMisread ? 'repeated misread characters' : hasGarbledCJK ? 'garbled CJK' : 'many low-confidence regions';
      log.info(`[PaddleOCR] Auto-detect: Chinese model may be wrong for this text (${reason}, ${regionCount} regions, conf=${(confidence * 100).toFixed(1)}%) — trying Korean model`);
      try {
        if (!this._modelManager.isRecModelDownloaded('ko')) {
          this.emit('status', 'downloading');
          await this._modelManager.ensureRecModel('ko', (progress) => {
            log.info(`[PaddleOCR] Download ko model: ${progress.percent}%`);
          });
        }
        await this._modelManager.switchRecModel('ko');
        log.info('[PaddleOCR] Switched to Korean model for auto-detect');
        this.emit('status', 'ready');
      } catch (err) {
        log.warn(`[PaddleOCR] Failed to switch to Korean model for auto-detect: ${err.message}`);
        // v3.13.10: Also try Japanese model as fallback (better for some CJK text)
        try {
          if (!this._modelManager.isRecModelDownloaded('ja')) {
            this.emit('status', 'downloading');
            await this._modelManager.ensureRecModel('ja', (progress) => {
              log.info(`[PaddleOCR] Download ja model: ${progress.percent}%`);
            });
          }
          await this._modelManager.switchRecModel('ja');
          log.info('[PaddleOCR] Switched to Japanese model for auto-detect (Korean failed)');
          this.emit('status', 'ready');
        } catch (jaErr) {
          log.warn(`[PaddleOCR] Failed to switch to Japanese model too: ${jaErr.message}`);
        }
      }
    }
  }

  /**
   * Run OCR on an image buffer.
   *
   * @param {Buffer} imageBuffer - PNG/JPEG image buffer (from screen capture)
   * @returns {{ text: string, confidence: number, regions: number }}
   */
  async recognize(imageBuffer) {
    if (!this._isReady) {
      throw new Error('PaddleOCR engine not initialized. Call initialize() first.');
    }

    if (this._isBusy) {
      log.warn('[PaddleOCR] Busy, skipping recognition request');
      return { text: '', confidence: 0, regions: 0 };
    }

    this._isBusy = true;
    this.emit('status', 'recognizing');

    try {
      // v3.13.04: Ensure correct recognition model for current sourceLang
      await this._ensureCorrectRecModel();

      // v3.13.10: Track the active recognition model before recognition
      // so we can detect if auto-detect switched models mid-pass
      const currentRecLang = this._modelManager.getActiveRecLang();

      const startTime = Date.now();

      // Step 1: Detection — find text regions
      const detResult = await this._runDetection(imageBuffer);
      log.info(`[PaddleOCR] Detection found ${detResult.boxes.length} regions in ${Date.now() - startTime}ms`);

      if (detResult.boxes.length === 0) {
        this.emit('status', 'ready');
        this._isBusy = false;
        return { text: '', confidence: 0, regions: 0 };
      }

      // v3.13.03+04: Filter and merge detected regions before recognition
      let boxes = detResult.boxes;

      // Filter: remove very small regions (likely noise/icons)
      boxes = boxes.filter(box => {
        const area = (box.x2 - box.x1) * (box.y2 - box.y1);
        return area >= this._options.minRegionArea;
      });

      // Filter: remove regions that are too wide/short (likely horizontal rules/borders)
      boxes = boxes.filter(box => {
        const w = box.x2 - box.x1;
        const h = box.y2 - box.y1;
        if (w > 0 && h > 0 && w / h > 20) return false;
        return true;
      });

      // Merge: combine overlapping or very close regions on the same line
      boxes = this._mergeNearbyBoxes(boxes);

      // v3.13.04: Dynamic filtering for crowded screens (RPG battles, menus, etc.)
      // When many regions survive filtering, apply stricter confidence threshold
      // to keep only the most likely dialogue text, discarding UI elements.
      if (boxes.length > this._options.crowdedRegionThresh) {
        const prevCount = boxes.length;
        boxes = boxes.filter(box => box.score >= this._options.crowdedMinConf);
        if (boxes.length < prevCount) {
          log.info(`[PaddleOCR] Crowded screen filtering: ${prevCount} → ${boxes.length} regions (score ≥ ${this._options.crowdedMinConf})`);
        }
      }

      // Limit: only process top N regions by score (avoids confusion)
      boxes.sort((a, b) => b.score - a.score);
      if (boxes.length > this._options.maxRegions) {
        log.info(`[PaddleOCR] Too many regions (${detResult.boxes.length}), limiting to top ${this._options.maxRegions}`);
        boxes = boxes.slice(0, this._options.maxRegions);
      }

      // Re-sort by reading order after filtering/merging
      // v3.13.05: Japanese/Korean reading order support.
      // Japanese traditional text reads top-to-bottom, right-to-left (縦書き).
      // Korean also uses vertical text in some contexts.
      // For CJK languages, when text regions are in a vertical layout
      // (many tall narrow regions), use right-to-left ordering.
      // For horizontal layout (wide regions), use standard left-to-right.
      const isCJKLang = ['ja', 'ko', 'zh'].includes(this._sourceLang);
      if (isCJKLang) {
        // Detect dominant text direction: if most regions are taller than wide,
        // it's likely vertical text (manga/VN style)
        const tallRegions = boxes.filter(b => (b.y2 - b.y1) > (b.x2 - b.x1));
        const isVerticalDominant = tallRegions.length > boxes.length * 0.4;

        if (isVerticalDominant) {
          // Vertical Japanese/Korean: right-to-left, top-to-bottom
          // Columns are defined by x position, within each column sort by y
          boxes.sort((a, b) => {
            const dx = a.x1 - b.x1;
            if (Math.abs(dx) > 20) return dx; // Different columns — rightmost first? No, leftmost first for RTL reading
            // Wait: right-to-left means higher x values come first in reading order
            // Actually for vertical Japanese: rightmost column first, then left
            return b.x1 - a.x1; // Higher x first (right column reads first)
            // Within same column (similar x), top to bottom
          });
          // Now re-sort within same-column groups for top-to-bottom
          boxes.sort((a, b) => {
            const dx = b.x1 - a.x1;
            if (Math.abs(a.x1 - b.x1) > 20) return dx; // Different columns
            return a.y1 - b.y1; // Same column: top to bottom
          });
        } else {
          // Horizontal CJK: standard top-to-bottom, left-to-right
          boxes.sort((a, b) => {
            const dy = a.y1 - b.y1;
            if (Math.abs(dy) > 10) return dy;
            return a.x1 - b.x1;
          });
        }
      } else {
        // Standard LTR reading order
        boxes.sort((a, b) => {
          const dy = a.y1 - b.y1;
          if (Math.abs(dy) > 10) return dy;
          return a.x1 - b.x1;
        });
      }

      log.info(`[PaddleOCR] Processing ${boxes.length} regions (filtered from ${detResult.boxes.length})`);

      // Step 2: For each detected region, crop and recognize
      const textParts = [];
      const regionResults = [];
      let totalConf = 0;
      let validRegions = 0;

      for (const box of boxes) {
        try {
          const croppedBuffer = cropRegion(imageBuffer, box);
          if (!croppedBuffer) continue;

          // v3.13.02: Handle vertical text — rotate 90° CCW for recognition
          let recBuffer = croppedBuffer;
          if (isVerticalText(box)) {
            try {
              recBuffer = rotate90CCW(croppedBuffer);
              log.info(`[PaddleOCR] Vertical text detected, rotated region ${(box.x2 - box.x1).toFixed(0)}×${(box.y2 - box.y1).toFixed(0)}`);
            } catch (rotErr) {
              log.warn('[PaddleOCR] Rotation failed, using unrotated crop:', rotErr.message);
              recBuffer = croppedBuffer;
            }
          }

          // Step 3: Recognition — convert region to text
          const recResult = await this._runRecognition(recBuffer);
          // v3.13.08-fix: recMinConfidence is now 0 — pass all results through.
          // The translation engine (Google/DeepL) handles imperfect OCR better
          // than no input at all. Only skip truly empty results.
          if (recResult.text) {
            textParts.push(recResult.text);
            regionResults.push({ text: recResult.text, confidence: recResult.confidence });
            totalConf += recResult.confidence;
            validRegions++;
          }
        } catch (err) {
          log.warn('[PaddleOCR] Recognition error for region:', err.message);
        }
      }

      // v3.13.03: If we have multiple regions, filter out low-quality outlier regions
      // v3.13.14: Lowered threshold from 50% to 25% of average confidence. RPG battle
      // screens often have regions with varying confidence — UI elements like HP bars
      // and status text have lower confidence but still contain translatable text.
      // Following VN Translator's approach of keeping more regions rather than fewer.
      let text = '';
      if (regionResults.length > 1) {
        const avgConf = totalConf / validRegions;
        const threshold = avgConf * 0.25;
        const goodResults = regionResults.filter(r => r.confidence >= threshold);
        if (goodResults.length > 0 && goodResults.length < regionResults.length) {
          log.info(`[PaddleOCR] Filtered ${regionResults.length - goodResults.length} low-quality outlier regions (avgConf=${(avgConf * 100).toFixed(1)}%, thresh=${(threshold * 100).toFixed(1)}%)`);
          text = goodResults.map(r => r.text).join('\n');
          totalConf = goodResults.reduce((sum, r) => sum + r.confidence, 0);
          validRegions = goodResults.length;
        } else {
          text = textParts.join('\n');
        }
      } else {
        text = textParts.join('\n');
      }
      const confidence = validRegions > 0 ? totalConf / validRegions : 0;
      const elapsed = Date.now() - startTime;

      log.info(`[PaddleOCR] Recognition complete in ${elapsed}ms: "${text.substring(0, 60)}" (${validRegions} regions, ${(confidence * 100).toFixed(1)}%)`);

      // v3.13.06: For auto-detect mode, check if we should switch to a different
      // recognition model based on the results (e.g. Korean model for hangul text)
      await this._maybeSwitchModelForAutoDetect(text, confidence, validRegions);

      // v3.13.10: Second-pass recognition if auto-detect switched models.
      // When the Chinese model produced empty/garbled text and we switched to
      // Korean/Japanese model, re-run recognition with the correct model.
      const newActiveLang = this._modelManager.getActiveRecLang();
      if (newActiveLang !== 'zh' && newActiveLang !== currentRecLang && detResult.boxes.length > 0) {
        log.info(`[PaddleOCR] Model switched from ${currentRecLang} to ${newActiveLang}, re-running recognition`);
        // Re-recognize all regions with the new model
        const textParts2 = [];
        let totalConf2 = 0;
        let validRegions2 = 0;
        for (const box of boxes) {
          try {
            const croppedBuffer = cropRegion(imageBuffer, box);
            if (!croppedBuffer) continue;
            let recBuffer = croppedBuffer;
            if (isVerticalText(box)) {
              try { recBuffer = rotate90CCW(croppedBuffer); } catch (e) { recBuffer = croppedBuffer; }
            }
            const recResult2 = await this._runRecognition(recBuffer);
            if (recResult2.text) {
              textParts2.push(recResult2.text);
              totalConf2 += recResult2.confidence;
              validRegions2++;
            }
          } catch (err) {
            log.warn('[PaddleOCR] Re-recognition error for region:', err.message);
          }
        }
        if (textParts2.length > 0) {
          text = textParts2.join('\n');
          confidence = validRegions2 > 0 ? totalConf2 / validRegions2 : 0;
          log.info(`[PaddleOCR] Re-recognition with ${newActiveLang} model: "${text.substring(0, 60)}" (${validRegions2} regions, ${(confidence * 100).toFixed(1)}%)`);
        }
      }

      this.emit('status', 'ready');
      this._isBusy = false;
      return { text, confidence, regions: validRegions };
    } catch (err) {
      log.error('[PaddleOCR] Recognition error:', err.message);
      this.emit('status', 'error');
      this.emit('error', err);
      this._isBusy = false;
      return { text: '', confidence: 0, regions: 0 };
    }
  }

  /**
   * Run text detection on an image.
   * @private
   */
  async _runDetection(imageBuffer) {
    const session = this._modelManager.getDetSession();
    if (!session) throw new Error('Detection session not loaded');

    const { tensor, shape, ratio, origW, origH } = preprocessForDetection(
      imageBuffer,
      this._options.maxSideLen
    );

    const inputTensor = new ort.Tensor('float32', tensor, shape);
    const inputName = session.inputNames[0];
    const results = await session.run({ [inputName]: inputTensor });
    const outputName = session.outputNames[0];
    const output = results[outputName];

    const boxes = decodeDetection(
      output.data,
      output.dims,
      origW,
      origH,
      ratio,
      {
        binThresh: this._options.detBinThresh,
        boxThresh: this._options.detBoxThresh,
        unclipRatio: this._options.detUnclipRatio
      }
    );

    return { boxes };
  }

  /**
   * Run text recognition on a cropped image region.
   * v3.13.04: Uses the currently active recognition model (may be ja/ko/zh).
   * @private
   */
  async _runRecognition(imageBuffer) {
    const session = this._modelManager.getRecSession();
    if (!session) throw new Error('Recognition session not loaded');

    const { tensor, shape } = preprocessForRecognition(imageBuffer);
    const inputTensor = new ort.Tensor('float32', tensor, shape);
    const inputName = session.inputNames[0];
    const results = await session.run({ [inputName]: inputTensor });
    const outputName = session.outputNames[0];
    const output = results[outputName];

    const dictionary = this._modelManager.getDictionary();
    const result = decodeRecognition(output.data, output.dims, dictionary);

    return result;
  }

  /**
   * v3.13.03: Merge nearby/overlapping bounding boxes.
   * @private
   */
  _mergeNearbyBoxes(boxes) {
    if (boxes.length <= 1) return boxes;

    const gap = this._options.mergeRegionGap;
    const merged = [];
    const used = new Set();

    const sorted = [...boxes].sort((a, b) => {
      const dy = a.y1 - b.y1;
      if (Math.abs(dy) > 10) return dy;
      return a.x1 - b.x1;
    });

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;

      let current = { ...sorted[i] };
      used.add(i);

      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(j)) continue;

        const other = sorted[j];

        const vOverlap = Math.min(current.y2, other.y2) - Math.max(current.y1, other.y1);
        const minHeight = Math.min(current.y2 - current.y1, other.y2 - other.y1);
        const isSameLine = vOverlap > minHeight * 0.5;

        if (!isSameLine) continue;

        const hGap = Math.max(0, other.x1 - current.x2);
        if (hGap <= gap) {
          current.x1 = Math.min(current.x1, other.x1);
          current.y1 = Math.min(current.y1, other.y1);
          current.x2 = Math.max(current.x2, other.x2);
          current.y2 = Math.max(current.y2, other.y2);
          current.score = Math.max(current.score, other.score);
          used.add(j);
        }
      }

      merged.push(current);
    }

    return merged;
  }

  /**
   * Update detection/recognition options
   */
  setOptions(options) {
    this._options = { ...this._options, ...options };
  }

  /**
   * Get current engine status
   */
  getStatus() {
    return {
      ready: this._isReady,
      busy: this._isBusy,
      initialized: this._initialized,
      sourceLang: this._sourceLang,
      activeRecModel: this._modelManager.getActiveRecLang(),
      downloadedModels: this._modelManager.getDownloadedRecModels(),
      modelsDownloaded: this._modelManager.areModelsDownloaded(),
      runtimeAvailable: PaddleOCREngine.isAvailable(),
      downloadProgress: this._modelManager.getDownloadProgress()
    };
  }

  /**
   * Terminate the engine and release resources
   */
  async terminate() {
    await this._modelManager.release();
    this._isReady = false;
    this._initialized = false;
    this._isBusy = false;
    this.emit('status', 'terminated');
    log.info('[PaddleOCR] Engine terminated');
  }

  /**
   * Delete downloaded model files
   */
  async deleteModels() {
    await this._modelManager.deleteModels();
  }
}

module.exports = PaddleOCREngine;
