/**
 * PaddleOCR Postprocessing
 * Implements DB decode (text detection) and CTC decode (text recognition).
 *
 * DB Decode: Threshold probability map → find connected components → bounding boxes
 * CTC Decode: Argmax → remove duplicates → remove blanks → character lookup
 *
 * v3.13.01: Initial implementation
 *   - Simplified DB decode without OpenCV (uses flood-fill connected components)
 *   - No traditional NMS — score filtering replaces it (following Luna Translator)
 *   - Standard CTC greedy decode
 * v3.13.02: Added softmax normalization in CTC decode for accurate confidence values
 *   (REVERTED — softmax over 6625 classes produces tiny probabilities that fail all thresholds)
 * v3.13.03: No changes to postprocessing — improvements are in region filtering (ocr-paddle.js)
 * v3.13.16: Added detectScript() for auto-detect model switching (see docstring below).
 * v3.13.18: Added filterFuriganaBoxes() for geometric furigana detection (see
 *   docstring below) — replaces the inline-ruby regex patterns in ocr.js's
 *   _cleanPaddleOcrText(), which target a text format ({kanji|reading},
 *   kanji(reading)) that image OCR never actually produces. Furigana arrives
 *   from detection as its own separate box, not as markup inside a string, so
 *   it has to be filtered geometrically, before recognition even runs.
 */

/**
 * DB Post-process: Convert detection model output to bounding boxes.
 *
 * @param {Float32Array} output - Detection model output [1, 1, H, W]
 * @param {number[]} outputShape - Shape of the output tensor
 * @param {number} origW - Original image width
 * @param {number} origH - Original image height
 * @param {number} ratio - Resize ratio used in preprocessing
 * @param {object} options - Detection options
 * @param {number} options.binThresh - Binarization threshold (default: 0.3)
 * @param {number} options.boxThresh - Minimum box score threshold (default: 0.5)
 * @param {number} options.maxCandidates - Maximum number of candidate boxes (default: 1000)
 * @param {number} options.minArea - Minimum box area in pixels (default: 9)
 * @param {number} options.unclipRatio - Box expansion ratio (default: 1.6)
 * @returns {Array<{ x1: number, y1: number, x2: number, y2: number, score: number }>}
 */
function decodeDetection(output, outputShape, origW, origH, ratio, options = {}) {
  const binThresh = options.binThresh || 0.3;
  const boxThresh = options.boxThresh || 0.5;
  const maxCandidates = options.maxCandidates || 1000;
  const minArea = options.minArea || 9;
  const unclipRatio = options.unclipRatio || 1.6;

  // Output shape is [1, 1, H, W]
  const outH = outputShape[2];
  const outW = outputShape[3];

  // Step 1: Create probability map and binary map
  const probMap = new Float32Array(outH * outW);
  const binaryMap = new Uint8Array(outH * outW);

  for (let i = 0; i < outH * outW; i++) {
    probMap[i] = output[i];
    binaryMap[i] = output[i] > binThresh ? 1 : 0;
  }

  // Step 2: Morphological dilation (2×2 kernel) to merge nearby regions
  const dilatedMap = dilate(binaryMap, outW, outH);

  // Step 3: Find connected components using flood fill
  const components = findConnectedComponents(dilatedMap, outW, outH, maxCandidates);

  // Step 4: Extract bounding boxes with scores
  const boxes = [];
  for (const comp of components) {
    // Compute score: mean probability inside the bounding box
    const score = computeBoxScore(probMap, outW, comp.minX, comp.minY, comp.maxX, comp.maxY);

    if (score < boxThresh) continue;

    // Compute area
    const boxW = comp.maxX - comp.minX + 1;
    const boxH = comp.maxY - comp.minY + 1;
    if (boxW * boxH < minArea) continue;

    // Unclip: expand box by unclipRatio
    const centerX = (comp.minX + comp.maxX) / 2;
    const centerY = (comp.minY + comp.maxY) / 2;
    const halfW = (boxW * unclipRatio) / 2;
    const halfH = (boxH * unclipRatio) / 2;

    // Map back to original image coordinates
    const x1 = Math.max(0, Math.round((centerX - halfW) / ratio));
    const y1 = Math.max(0, Math.round((centerY - halfH) / ratio));
    const x2 = Math.min(origW, Math.round((centerX + halfW) / ratio));
    const y2 = Math.min(origH, Math.round((centerY + halfH) / ratio));

    if (x2 - x1 < 3 || y2 - y1 < 3) continue;

    boxes.push({ x1, y1, x2, y2, score });
  }

  // Step 5: Sort by reading order (top-to-bottom, left-to-right)
  boxes.sort((a, b) => {
    const dy = a.y1 - b.y1;
    if (Math.abs(dy) > 10) return dy; // Different rows
    return a.x1 - b.x1; // Same row: left to right
  });

  return boxes;
}

/**
 * CTC Post-process: Convert recognition model output to text.
 *
 * v3.13.02: Reverted softmax — with 6625+ dictionary classes, softmax
 *   probabilities are extremely small even for correct predictions (e.g. 2-5%),
 *   causing ALL results to be filtered by the confidence threshold.
 *   RapidOCR and other PP-OCRv4 implementations use raw argmax values as
 *   relative confidence measures — these work well with fixed thresholds
 *   because the model's logit scale is consistent across predictions.
 *   The argmax character decoding is identical either way (softmax is monotonic).
 *
 * @param {Float32Array} output - Recognition model output [1, T, C]
 * @param {number[]} outputShape - Shape of the output tensor
 * @param {string[]} dictionary - Character dictionary (index 0 = CTC blank)
 * @returns {{ text: string, confidence: number }}
 */
function decodeRecognition(output, outputShape, dictionary) {
  const timeSteps = outputShape[1];
  const numClasses = outputShape[2];

  let text = '';
  let lastIndex = 0;
  let totalConf = 0;
  let charCount = 0;

  for (let t = 0; t < timeSteps; t++) {
    // Find argmax for this time step
    let maxIdx = 0;
    let maxVal = output[t * numClasses];
    for (let c = 1; c < numClasses; c++) {
      const val = output[t * numClasses + c];
      if (val > maxVal) {
        maxVal = val;
        maxIdx = c;
      }
    }

    // CTC merge: skip blank (index 0) and consecutive duplicates
    if (maxIdx > 0 && maxIdx !== lastIndex) {
      if (maxIdx < dictionary.length) {
        text += dictionary[maxIdx];
        totalConf += maxVal;
        charCount++;
      }
    }
    lastIndex = maxIdx;
  }

  const confidence = charCount > 0 ? totalConf / charCount : 0;

  return { text, confidence };
}

/**
 * Morphological dilation with a 2×2 rectangular kernel.
 * Merges nearby text regions that were split by binarization.
 *
 * @private
 */
function dilate(binaryMap, width, height) {
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const idx = y * width + x;
      if (binaryMap[idx] || binaryMap[idx + 1] ||
          binaryMap[idx + width] || binaryMap[idx + width + 1]) {
        result[idx] = 1;
        result[idx + 1] = 1;
        result[idx + width] = 1;
        result[idx + width + 1] = 1;
      }
    }
  }
  return result;
}

/**
 * Find connected components using flood fill (4-connectivity).
 * Returns bounding boxes for each component.
 *
 * @private
 */
function findConnectedComponents(binaryMap, width, height, maxCandidates) {
  const visited = new Uint8Array(width * height);
  const components = [];

  for (let y = 0; y < height && components.length < maxCandidates; y++) {
    for (let x = 0; x < width && components.length < maxCandidates; x++) {
      const idx = y * width + x;
      if (binaryMap[idx] && !visited[idx]) {
        // Flood fill from this pixel
        const comp = floodFill(binaryMap, visited, width, height, x, y);
        if (comp) {
          components.push(comp);
        }
      }
    }
  }

  return components;
}

/**
 * Flood fill to find a connected component.
 * Uses a stack-based approach for efficiency.
 * Returns the bounding box of the component.
 *
 * @private
 */
function floodFill(binaryMap, visited, width, height, startX, startY) {
  const stack = [[startX, startY]];
  let minX = startX, maxX = startX;
  let minY = startY, maxY = startY;
  let pixelCount = 0;

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const idx = y * width + x;

    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (visited[idx] || !binaryMap[idx]) continue;

    visited[idx] = 1;
    pixelCount++;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    // 4-connectivity neighbors
    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }

  if (pixelCount < 3) return null; // Skip tiny noise

  return { minX, minY, maxX, maxY, pixelCount };
}

/**
 * Compute mean probability score inside a bounding box.
 *
 * @private
 */
function computeBoxScore(probMap, width, minX, minY, maxX, maxY) {
  let sum = 0;
  let count = 0;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      sum += probMap[y * width + x];
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

/**
 * v3.13.16: Detect which CJK script a recognized text is predominantly written
 * in, by counting Unicode codepoint ranges. Replaces the old hangul-only check
 * in ocr-paddle.js's _maybeSwitchModelForAutoDetect(), which could detect
 * "this might be Korean" but had no way to detect "this might be Japanese" —
 * confirmed against the test-images bench: under sourceLang='auto', Japanese
 * screens (menus, dialogue, RPG battle text) stayed on the zh model forever,
 * scoring markedly worse than the same images recognized with sourceLang='ja'
 * explicitly (e.g. test08: 40% similarity on 'ja' vs 28% on 'auto').
 *
 * Hangul is decisive on its own: neither the zh nor the ja recognition
 * model's dictionary contains hangul at all, so ANY hangul in the output is
 * unambiguous evidence of Korean, regardless of surrounding noise.
 *
 * Kana (hiragana/katakana) is the next-strongest signal — Chinese text does
 * not use kana, so its presence reliably indicates Japanese. Pure CJK
 * ideographs are left classified as 'zh', the broadest-coverage default,
 * since they're ambiguous between zh/ja-kanji-only/lzh.
 *
 * KNOWN LIMITATION: this only works when at least one genuine kana character
 * survives in the zh model's misreading. In practice the zh model often
 * substitutes a lookalike CJK ideograph from ITS OWN dictionary for katakana
 * it can't represent well — e.g. it read タワー ("tower") as 夕一 (two
 * unrelated kanji: "evening" + "one") in one of the bench images, leaving
 * zero kana in the output for this function to find. detectScript() cannot
 * recover a signal that the wrong model already destroyed; it only helps
 * when some kana happens to survive misrecognition.
 *
 * @param {string} text - Recognized text to classify
 * @returns {{ lang: 'ko'|'ja'|'zh', hangul: number, kana: number, cjk: number, latin: number }}
 */
function detectScript(text) {
  const hangul = (text.match(/[가-힣ᄀ-ᇿ㄰-㆏]/g) || []).length;
  const kana = (text.match(/[぀-ゟ゠-ヿ]/g) || []).length;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;

  let lang = 'zh';
  if (hangul > 0) lang = 'ko';
  else if (kana > 0) lang = 'ja';

  return { lang, hangul, kana, cjk, latin };
}

/**
 * v3.13.18: Detect and drop furigana boxes — small kana readings printed above
 * kanji in Japanese text. Detection finds them as their own independent
 * region, distinct from the kanji line they annotate, so left unfiltered
 * their text (usually one or two kana) gets concatenated into the output
 * with no context: "が 漢字の上にぶりが" instead of "漢字の上にぶりが".
 *
 * A box A is dropped as furigana of box B when ALL of these hold — every
 * threshold below was set against real detection boxes from the bench
 * (test-images/), not guessed:
 *
 *   1. A is short relative to B: A.h / B.h < heightRatioMax (default 0.60).
 *      Measured furigana: 0.51. Closest real false-positive risk (test05,
 *      a short line stacked over a much taller one): 0.71. There is real
 *      margin on both sides of 0.60 — this is NOT a knife's-edge threshold.
 *
 *   2. A sits horizontally inside B: at least minHorizontalOverlap (default
 *      0.80) of A's width falls within B's x-range. Measured furigana: 100%.
 *      The nearest false-positive risk (test05 again) is only 43% contained
 *      — a short menu label stacked over a wider one, not nested inside it.
 *
 *   3. A is above B: A.y1 < B.y1. Furigana is printed above its kanji, never
 *      below — this alone rules out unrelated boxes that happen to be small
 *      and narrow but sit below or beside their neighbor (e.g. speaker names,
 *      which sit ABOVE their dialogue in the bench but are excluded by
 *      criterion 1, not this one — kept as a second, independent guard since
 *      a name box could in principle be narrow enough to pass 1 and 2 in a
 *      different layout).
 *
 *   4. A is vertically adjacent to B, INCLUDING overlap: B.y1 - A.y2 must
 *      fall within [-vOverlapMax * A.h, +vGapMax * A.h] (defaults -0.5, 1.0).
 *      Measured furigana actually OVERLAPS its base line by 7px (B.y1=342,
 *      A.y2=349) — an artifact of unclipRatio inflating every box. A naive
 *      non-overlap check (A.y2 <= B.y1) would silently miss the real case.
 *
 * Each of the 4 checks is independently necessary: dropping any one of them
 * lets through at least one of the bench's near-miss cases (speaker names in
 * test08/test04, a stacked-but-not-nested menu line in test05).
 *
 * @param {Array<{x1,y1,x2,y2,score}>} boxes - Detected regions (post
 *   min-area/aspect-ratio filtering, pre-merge)
 * @param {object} options
 * @param {number} options.heightRatioMax - Max A.h/B.h to count as furigana (default 0.60)
 * @param {number} options.minHorizontalOverlap - Min fraction of A's width inside B's x-range (default 0.80)
 * @param {number} options.vOverlapMax - Max allowed overlap of A into B, as a fraction of A.h (default 0.5)
 * @param {number} options.vGapMax - Max allowed gap between A and B, as a fraction of A.h (default 1.0)
 * @returns {{ kept: Array, dropped: Array<{box: object, baseBox: object, heightRatio: number, horizontalOverlap: number}> }}
 */
function filterFuriganaBoxes(boxes, options = {}) {
  const heightRatioMax = options.heightRatioMax ?? 0.60;
  const minHorizontalOverlap = options.minHorizontalOverlap ?? 0.80;
  const vOverlapMax = options.vOverlapMax ?? 0.5;
  const vGapMax = options.vGapMax ?? 1.0;

  const dropped = [];
  const droppedIndices = new Set();

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    const aH = a.y2 - a.y1;
    const aW = a.x2 - a.x1;
    if (aH <= 0 || aW <= 0) continue;

    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      const b = boxes[j];
      const bH = b.y2 - b.y1;
      if (bH <= 0) continue;

      // 1. Short relative to the candidate base line
      const heightRatio = aH / bH;
      if (heightRatio >= heightRatioMax) continue;

      // 2. Horizontally nested inside the base line
      const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const horizontalOverlap = Math.max(0, overlapX) / aW;
      if (horizontalOverlap < minHorizontalOverlap) continue;

      // 3. Above the base line
      if (a.y1 >= b.y1) continue;

      // 4. Vertically adjacent to the base line, tolerating overlap
      const gap = b.y1 - a.y2; // negative = overlap
      if (gap < -vOverlapMax * aH || gap > vGapMax * aH) continue;

      dropped.push({ box: a, baseBox: b, heightRatio, horizontalOverlap });
      droppedIndices.add(i);
      break; // one matching base line is enough to drop A
    }
  }

  const kept = boxes.filter((_, i) => !droppedIndices.has(i));
  return { kept, dropped };
}

module.exports = {
  decodeDetection,
  decodeRecognition,
  detectScript,
  filterFuriganaBoxes
};
