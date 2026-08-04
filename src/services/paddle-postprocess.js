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

module.exports = {
  decodeDetection,
  decodeRecognition
};
