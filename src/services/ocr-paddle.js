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
 *           - 'ja' → Chinese+Japanese model (unified since v3.13.17, see below)
 *           - 'ko' → Korean model (hangul support)
 *           - 'zh', 'auto', others → Chinese+Japanese model (broadest CJK coverage)
 *           Models are downloaded on-demand when their language is first needed.
 *           Also improved RPG Battle region filtering with dynamic thresholds.
 * v3.13.17: Migrated the recognition model to unified PP-OCRv5 (zh+ja in one
 *           model — see paddle-models.js). There is no separate 'ja' model key
 *           anymore; 'ja'/'jpn' map straight to 'zh' in LANG_TO_REC_MODEL.
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

const { PaddleModelManager, getRecModelKeyForLang } = require('./paddle-models');
const { preprocessForDetection, preprocessForRecognition, cropRegion, isVerticalText, rotate90CCW } = require('./paddle-preprocess');
const { decodeDetection, decodeRecognition, detectScript, filterFuriganaBoxes } = require('./paddle-postprocess');

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
      // v3.13.77 (Stage 3, OCR-refinement round): floor for detection input
      // size, mirrored against maxSideLen. Confirmed a no-op on every bench
      // CJK image (all have maxSide >= 1152); only engages on captures
      // smaller than the bench has tested, e.g. the app's default 600x122
      // capture area. See preprocessForDetection() in paddle-preprocess.js.
      detMinSideLen: 960,
      detMaxUpscale: 2.0,
      detBinThresh: 0.3,
      detBoxThresh: 0.3,
      // v3.13.77 (Stage 2, OCR-refinement round): re-defaulted 2.0 -> 1.5.
      // The old value was tuned against a completely different (and wrong)
      // formula — center-scaling the box 2x per axis (4x the area) — so it
      // cannot be carried over now that decodeDetection() uses a real
      // Vatti-style outward margin (see paddle-postprocess.js). Upstream
      // PP-OCR's det_db_unclip_ratio default is 1.5; RapidOCR uses 1.5-1.6.
      // Swept {1.2, 1.5, 1.8, 2.0} against the bench (both cjk and latin
      // groups, plus the padding sweep) before picking this value.
      detUnclipRatio: 1.5,
      recMinConfidence: 0,    // v3.13.08-fix: Removed threshold — same as Tesseract path, let translation engine decide
      // v3.13.03: Multi-region filtering and merging options
      minRegionArea: 100,
      mergeRegionGap: 15,
      // v3.13.79: raised from 15 to 40. Measured against the 57-image real-world
      // bench (round 2): this cap truncated exactly ONE run out of 57 (a busy
      // Ren'Py menu, 16→15 regions), and the median real capture has only 4
      // regions after merge. The cap was an arbitrary top-N-by-score cut that
      // almost never fires; crowdedMinConf below is the filter that's actually
      // meant to separate signal from noise. Kept > crowdedRegionThresh so the
      // confidence filter still gets a chance to run before this cap does.
      maxRegions: 40,
      // v3.13.04: Dynamic region filtering for crowded screens (RPG battles)
      // v3.13.08-fix: Further relaxed — previous values still filtered out too many
      // regions on RPG battle screens and low-quality scans. The translation engine
      // (Google/DeepL) handles imperfect OCR better than no input at all.
      // v3.13.14: Further relaxed following VN Translator and Luna Translator's
      // approach of passing ALL detected regions through to the translation engine.
      // The translation engine is much better at handling imperfect OCR text than
      // our heuristics are at filtering it. Only filter truly noise-level regions.
      // v3.13.79: lowered from 50 to 25 (paired with the maxRegions raise above) —
      // at 50 this filter was unreachable in practice, since maxRegions used to cut
      // in first at 15. Now the confidence-based filter gets first pass on
      // moderately busy screens (16-40 regions) instead of a blind top-N cut.
      crowdedRegionThresh: 25,
      crowdedMinConf: 0.02,    // v3.13.14: Lowered from 0.05 — only filter absolute noise
      // v3.13.16 Phase 1 (scoped): median denoise + auto-invert on recognition
      // crops. Off by default — see preprocessForRecognition() in
      // paddle-preprocess.js for why, and enable via setOptions({enhance: true})
      // to A/B against the test-images bench.
      enhance: false,
      // v3.13.18: Geometric furigana detection (see filterFuriganaBoxes() in
      // paddle-postprocess.js). On by default — thresholds were set against
      // real detection boxes from the bench, with margin on both sides
      // against the closest false-positive risk (see that function's
      // docstring). The bench only has one furigana image though, so a real
      // game could use a size that falls in the gap between the furigana
      // case (0.51) and the nearest false positive (0.71) — these are
      // exposed via setOptions() so a bad call can be tuned without a code
      // change, and every drop is logged with its metrics for the same reason.
      furiganaFilter: true,
      furiganaHeightRatioMax: 0.60,
      furiganaMinHorizontalOverlap: 0.80,
      furiganaVOverlapMax: 0.5,
      furiganaVGapMax: 1.0
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

      // v3.13.12: Pre-download recognition models when sourceLang='auto', so
      // switching mid-session (e.g. to Korean on hangul detection) doesn't hit
      // a multi-second download delay on the first occurrence.
      // v3.13.17: Only 'ko' needs pre-downloading now — 'zh' (which also covers
      // Japanese, see paddle-models.js) is already fetched by ensureModels()
      // above, and there is no separate 'ja' model left to pre-download.
      const recKey = getRecModelKeyForLang(this._sourceLang);
      if (this._sourceLang === 'auto') {
        log.info('[PaddleOCR] Auto-detect mode: pre-downloading Korean model...');
        try {
          if (!this._modelManager.isRecModelDownloaded('ko')) {
            await this._modelManager.ensureRecModel('ko', (progress) => {
              if (onProgress) onProgress({ stage: 'download', file: progress.file, percent: progress.percent });
            });
          }
        } catch (downloadErr) {
          log.warn(`[PaddleOCR] Failed to pre-download ko model: ${downloadErr.message} — will download on-demand later`);
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
   * we should be using a different model. Called after recognition completes.
   *
   * v3.13.17: Simplified now that zh and ja are the same model (see
   * paddle-models.js) — detectScript() returning 'ja' is no longer actionable
   * here, since the currently-active zh model already IS the right model for
   * kana. Only hangul still means "switch models", because ko remains
   * separate. This also removes the fallback-to-ja path entirely: there is
   * no 'ja' model left to fall back to if switching to ko fails.
   * @param {string} text - Recognized text
   * @param {number} confidence - Recognition confidence
   * @param {number} regionCount - Number of detected text regions
   * @private
   */
  async _maybeSwitchModelForAutoDetect(text, confidence, regionCount) {
    if (this._sourceLang !== 'auto') return; // Only for auto-detect mode
    const currentLang = this._modelManager.getActiveRecLang();
    if (currentLang !== 'zh') return; // Already switched once — don't oscillate further

    // Confidence-based heuristics remain removed (see v3.13.16 note in git
    // history) — decodeRecognition() returns raw CTC logits, not calibrated
    // probabilities, so a fixed confidence threshold isn't a reliable signal.
    const hasNoText = text.length === 0 && regionCount > 0;
    const script = detectScript(text);
    const hasHangul = script.hangul > 0;

    if (!hasNoText && !hasHangul) return; // zh output looks right, or is ambiguous CJK-only

    const reason = hasNoText ? 'no text' : `hangul detected (${script.hangul})`;
    log.info(`[PaddleOCR] Auto-detect: zh model may be wrong for this text (${reason}, ${regionCount} regions, conf=${(confidence * 100).toFixed(1)}%) — trying Korean model`);
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
      // v3.13.17: No 'ja' model left to fall back to — zh is already the
      // broadest-coverage default, so just stay on it.
      log.warn(`[PaddleOCR] Failed to switch to Korean model for auto-detect: ${err.message}`);
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

      // v3.13.17: Per-stage region telemetry. Every filter below can silently
      // drop a region that the detector DID find, and until now the only number
      // that escaped this method was the final count — so "the detector never
      // found it" and "our own thresholds discarded it" were indistinguishable
      // from outside. Those two have completely different fixes (swap the
      // detection model vs. tune our thresholds), so the bench needs to tell
      // them apart. Populated as we go and returned alongside the text.
      const regionStages = {
        detected: detResult.boxes.length,
        afterMinArea: 0,
        afterAspectRatio: 0,
        afterFurigana: 0,
        afterMerge: 0,
        afterCrowdedFilter: 0,
        afterMaxRegions: 0,
        recognized: 0,      // produced non-empty text
        afterOutlierFilter: 0
      };

      if (detResult.boxes.length === 0) {
        this.emit('status', 'ready');
        this._isBusy = false;
        return { text: '', confidence: 0, regions: 0, regionStages, recModel: currentRecLang, detGeometry: detResult.geometry, detectedBoxes: [] };
      }

      // v3.13.03+04: Filter and merge detected regions before recognition
      let boxes = detResult.boxes;

      // Filter: remove very small regions (likely noise/icons)
      //
      // v3.13.77 (Stage 2, OCR-refinement round): measure against box.raw
      // (pre-unclip component bounds), not the unclipped x1/y1/x2/y2.
      // minRegionArea:100 was calibrated against boxes inflated ~4x in area
      // by the old center-scaling unclip — with the Vatti-style margin now
      // used for cropping, the same real text would measure ~4x smaller here
      // and sit right at the cutoff. Using raw decouples this threshold from
      // whatever unclipRatio happens to mean.
      boxes = boxes.filter(box => {
        const r = box.raw || box;
        const area = (r.x2 - r.x1) * (r.y2 - r.y1);
        return area >= this._options.minRegionArea;
      });
      regionStages.afterMinArea = boxes.length;

      // Filter: remove regions that are too wide/short (likely horizontal rules/borders)
      //
      // v3.13.17: Added an absolute-height guard alongside the ratio check.
      // Ratio alone couldn't tell a decorative hairline rule apart from a
      // legitimate long single line of dialogue — a full-width CJK line
      // cropped tightly to its own line height easily exceeds w/h > 20 too
      // (e.g. ~14 characters at typical VN font size). Confirmed against the
      // bench: test08's longest dialogue line (因書館に本を返しに行くの。)
      // was being discarded here, at the ONLY stage that dropped it
      // (detected=4 → afterAspectRatio=3, with zero further loss at merge or
      // recognition). A decorative rule is thin in absolute terms, not just
      // in ratio — a real glyph line is bounded below by font size — so
      // requiring BOTH a high ratio AND a small absolute height (<12px, well
      // under any plausible line height in these bench images) targets the
      // actual distinguishing feature instead of guessing a larger ratio
      // number that could still misfire in either direction.
      // v3.13.77: measured against box.raw for the same reason as
      // minRegionArea above — the <12px absolute-height guard is meant to
      // catch a genuinely thin decorative rule, and the old unclip inflation
      // roughly doubled every box's height, silently loosening this filter.
      boxes = boxes.filter(box => {
        const r = box.raw || box;
        const w = r.x2 - r.x1;
        const h = r.y2 - r.y1;
        if (w > 0 && h > 0 && h < 12 && w / h > 20) return false;
        return true;
      });
      regionStages.afterAspectRatio = boxes.length;

      // v3.13.18: Drop furigana boxes — small kana readings printed above
      // kanji, detected as their own separate region. Left in, they show up
      // as unrelated single-kana fragments in the output (e.g. "が 漢字の上
      // にぶりが" instead of "漢字の上にぶりが"). Must run BEFORE merge:
      // the furigana box overlaps its base line vertically (see
      // filterFuriganaBoxes()'s docstring for why), which is close to what
      // _mergeNearbyBoxes() itself looks for — a future change to that
      // function could otherwise start absorbing furigana into its base
      // line instead of dropping it. Runs after the aspect-ratio filter so
      // it only has to consider boxes that already look like real text.
      if (this._options.furiganaFilter) {
        const { kept, dropped } = filterFuriganaBoxes(boxes, {
          heightRatioMax: this._options.furiganaHeightRatioMax,
          minHorizontalOverlap: this._options.furiganaMinHorizontalOverlap,
          vOverlapMax: this._options.furiganaVOverlapMax,
          vGapMax: this._options.furiganaVGapMax
        });
        if (dropped.length > 0) {
          for (const d of dropped) {
            log.info(`[PaddleOCR] Dropped furigana-like region (height ratio ${d.heightRatio.toFixed(2)}, horizontal overlap ${d.horizontalOverlap.toFixed(2)})`);
          }
          boxes = kept;
        }
      }
      regionStages.afterFurigana = boxes.length;

      // Merge: combine overlapping or very close regions on the same line
      boxes = this._mergeNearbyBoxes(boxes);
      regionStages.afterMerge = boxes.length;

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
      regionStages.afterCrowdedFilter = boxes.length;

      // Limit: only process top N regions by score (avoids confusion)
      boxes.sort((a, b) => b.score - a.score);
      if (boxes.length > this._options.maxRegions) {
        log.info(`[PaddleOCR] Too many regions (${detResult.boxes.length}), limiting to top ${this._options.maxRegions}`);
        boxes = boxes.slice(0, this._options.maxRegions);
      }
      regionStages.afterMaxRegions = boxes.length;

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
          // Vertical Japanese/Korean (縦書き): rightmost column first, then leftward;
          // within each column, top to bottom.
          //
          // v3.13.16: This was previously TWO consecutive sort() calls. The second
          // call completely overwrote the first — Array.sort() re-orders the whole
          // array, it doesn't refine the previous ordering. The leftover comments
          // ("rightmost first? No, leftmost first" / "Wait:") show the intent was
          // never settled. Replaced with a single comparator that does both keys.
          const COLUMN_TOLERANCE = 20; // px — boxes within this x distance share a column
          boxes.sort((a, b) => {
            if (Math.abs(a.x1 - b.x1) > COLUMN_TOLERANCE) {
              return b.x1 - a.x1; // Different columns: higher x (rightmost) reads first
            }
            return a.y1 - b.y1;   // Same column: top to bottom
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
      regionStages.recognized = validRegions;

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
      regionStages.afterOutlierFilter = validRegions;
      // v3.13.16: MUST be `let` — the auto-detect second pass below reassigns this.
      // Previously `const`, which made that reassignment throw
      // `TypeError: Assignment to constant variable.` The throw was swallowed by
      // recognize()'s catch block, so EVERY auto-detect model switch returned
      // empty text even though the first pass had recognized it correctly.
      let confidence = validRegions > 0 ? totalConf / validRegions : 0;
      const elapsed = Date.now() - startTime;

      log.info(`[PaddleOCR] Recognition complete in ${elapsed}ms: "${text.substring(0, 60)}" (${validRegions} regions, ${(confidence * 100).toFixed(1)}%)`);

      // v3.13.06: For auto-detect mode, check if we should switch to a different
      // recognition model based on the results (e.g. Korean model for hangul text)
      //
      // v3.13.16: Pass boxes.length (regions DETECTED), not validRegions (regions
      // successfully RECOGNIZED by the current model). _maybeSwitchModelForAutoDetect's
      // own docstring has always said "Number of detected text regions", but this call
      // site passed validRegions instead — and validRegions is 0 by construction
      // whenever text is empty (a region only counts as valid if it produced
      // non-empty text). That made hasNoText's `regionCount > 0` guard impossible to
      // satisfy in exactly the case it exists to catch: the wrong model completely
      // failing to read the script (e.g. zh model on Korean input, which has no
      // hangul in its dictionary and reliably produces empty output for every
      // region). Confirmed against the test-images bench: test03 (Korean) under
      // sourceLang='auto' stayed on the zh model and returned empty, while the same
      // image under an explicit sourceLang='ko' recognized correctly.
      await this._maybeSwitchModelForAutoDetect(text, confidence, boxes.length);

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
          validRegions = validRegions2;
          regionStages.recognized = validRegions2;
          regionStages.afterOutlierFilter = validRegions2;
          log.info(`[PaddleOCR] Re-recognition with ${newActiveLang} model: "${text.substring(0, 60)}" (${validRegions2} regions, ${(confidence * 100).toFixed(1)}%)`);
        }
      }

      this.emit('status', 'ready');
      this._isBusy = false;
      return {
        text,
        confidence,
        regions: validRegions,
        regionStages,
        recModel: this._modelManager.getActiveRecLang(),
        // v3.13.77 (Stage 1, OCR-refinement round): geometry + the boxes
        // actually sent to cropRegion(), for the bench's --dump-boxes and
        // for diagnosing Stage 2's coordinate-mapping fix. `detectedBoxes`
        // are POST-unclip coordinates (what cropRegion used), not the raw
        // component bounds — that distinction is why Stage 2 introduces a
        // separate `raw` field per box.
        detGeometry: detResult.geometry,
        detectedBoxes: boxes
      };
    } catch (err) {
      log.error('[PaddleOCR] Recognition error:', err.message);
      this.emit('status', 'error');
      this.emit('error', err);
      this._isBusy = false;
      return { text: '', confidence: 0, regions: 0, regionStages: null, recModel: null, detGeometry: null, detectedBoxes: null };
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
      this._options.maxSideLen,
      this._options.detMinSideLen,
      this._options.detMaxUpscale
    );

    const inputTensor = new ort.Tensor('float32', tensor, shape);
    const inputName = session.inputNames[0];
    const results = await session.run({ [inputName]: inputTensor });
    const outputName = session.outputNames[0];
    const output = results[outputName];

    // v3.13.77 (Stage 1, OCR-refinement round): confirm empirically whether
    // the DB output map is full input resolution or reduced by stride,
    // BEFORE Stage 2 relies on that for the per-axis coordinate scale-back
    // (decodeDetection currently divides by the single scalar `ratio`
    // instead, which is the anisotropic-resize bug the round is fixing).
    // This repo has already been burned once by an unverified model-shape
    // assumption — see the rec input height history in
    // paddle-preprocess.js's preprocessForRecognition docstring. Logged once
    // per distinct input size, not every call, since this runs on every
    // capture in production (~every 3.5s).
    const dstH = shape[2];
    const dstW = shape[3];
    const outH = output.dims[2];
    const outW = output.dims[3];
    const sizeKey = `${dstW}x${dstH}`;
    if (this._loggedDetGeometryFor !== sizeKey) {
      const strideX = dstW / outW;
      const strideY = dstH / outH;
      log.info(`[PaddleOCR] Detection geometry: input ${dstW}x${dstH} -> output map ${outW}x${outH} (stride ${strideX.toFixed(2)}x${strideY.toFixed(2)}, expect 1.00x1.00 for a full-resolution DB head)`);
      this._loggedDetGeometryFor = sizeKey;
    }

    const boxes = decodeDetection(
      output.data,
      output.dims,
      origW,
      origH,
      {
        binThresh: this._options.detBinThresh,
        boxThresh: this._options.detBoxThresh,
        unclipRatio: this._options.detUnclipRatio
      }
    );

    return { boxes, geometry: { origW, origH, dstW, dstH, ratio, outW, outH } };
  }

  /**
   * Run text recognition on a cropped image region.
   * v3.13.04: Uses the currently active recognition model (may be ja/ko/zh).
   * @private
   */
  async _runRecognition(imageBuffer) {
    const session = this._modelManager.getRecSession();
    if (!session) throw new Error('Recognition session not loaded');

    // v3.13.16: Use the active model's real required input height (e.g. 32
    // for 'ja') instead of the hardcoded 48 that used to crash every 'ja'
    // recognition call. See PaddleModelManager.getRecInputHeight().
    const targetH = this._modelManager.getRecInputHeight(this._modelManager.getActiveRecLang());
    const { tensor, shape } = preprocessForRecognition(imageBuffer, targetH, this._options.enhance);
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
   *
   * v3.13.17: Fixed an unbounded transitive-merge cascade. The old version
   * tested each candidate's gap against `current`'s ever-EXPANDING envelope
   * (current.x2/y1/y2 grow with every absorbed box), so merging box A into
   * current moved the boundary closer to box C even if A and C were never
   * within `gap` of each other directly. On a row of UI elements with modest
   * gaps (e.g. an RPG battle menu: たたかう | まほう | にげる | どうく),
   * each merge widened the reach for the next one, chain-reacting across
   * boxes that should stay distinct. Confirmed against the bench: test09
   * collapsed 7 detected regions to 2 at this exact stage (zero loss
   * before or after it), and the surviving text shows the four menu labels
   * concatenated with no separator ("たたかうまほうにげるどうく") — the
   * signature of this cascade.
   *
   * Fix: gap and same-line checks now compare the candidate against the
   * LAST box actually absorbed into the group (`lastAbsorbed`), not against
   * the group's accumulated bounding envelope. Each individual hop still has
   * to be within `gap`/vertically-aligned on its own merits; the envelope
   * (`current.x1/y1/x2/y2`) is still tracked and returned for cropping, but
   * no longer used to decide what merges next.
   *
   * v3.13.77 (Stage 2, OCR-refinement round): the same-line and gap checks
   * now measure `box.raw` (pre-unclip component bounds) instead of the
   * unclipped x1/y1/x2/y2. `mergeRegionGap:15` is an absolute pixel gap —
   * under the old 4x-area unclip inflation, real gaps between adjacent
   * words/labels shrank (sometimes into overlap), so lines merged that
   * shouldn't have and vice versa depending on layout. Measuring on raw
   * bounds makes this threshold mean "15px between the actual glyphs" again,
   * independent of whatever unclipRatio happens to be. `current.raw` is
   * unioned alongside the unclipped envelope so any later stage that still
   * wants the un-inflated bounds of a merged group has them.
   * @private
   */
  _mergeNearbyBoxes(boxes) {
    if (boxes.length <= 1) return boxes;

    const gap = this._options.mergeRegionGap;
    const merged = [];
    const used = new Set();
    const rawOf = box => box.raw || box;

    const sorted = [...boxes].sort((a, b) => {
      const dy = a.y1 - b.y1;
      if (Math.abs(dy) > 10) return dy;
      return a.x1 - b.x1;
    });

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;

      let current = { ...sorted[i], raw: { ...rawOf(sorted[i]) } };
      let lastAbsorbed = sorted[i]; // v3.13.17: compare against this, not `current`'s envelope
      used.add(i);

      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(j)) continue;

        const other = sorted[j];
        const lastRaw = rawOf(lastAbsorbed);
        const otherRaw = rawOf(other);

        const vOverlap = Math.min(lastRaw.y2, otherRaw.y2) - Math.max(lastRaw.y1, otherRaw.y1);
        const minHeight = Math.min(lastRaw.y2 - lastRaw.y1, otherRaw.y2 - otherRaw.y1);
        const isSameLine = vOverlap > minHeight * 0.5;

        if (!isSameLine) continue;

        const hGap = Math.max(0, otherRaw.x1 - lastRaw.x2);
        if (hGap <= gap) {
          current.x1 = Math.min(current.x1, other.x1);
          current.y1 = Math.min(current.y1, other.y1);
          current.x2 = Math.max(current.x2, other.x2);
          current.y2 = Math.max(current.y2, other.y2);
          current.score = Math.max(current.score, other.score);
          current.raw.x1 = Math.min(current.raw.x1, otherRaw.x1);
          current.raw.y1 = Math.min(current.raw.y1, otherRaw.y1);
          current.raw.x2 = Math.max(current.raw.x2, otherRaw.x2);
          current.raw.y2 = Math.max(current.raw.y2, otherRaw.y2);
          lastAbsorbed = other;
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
