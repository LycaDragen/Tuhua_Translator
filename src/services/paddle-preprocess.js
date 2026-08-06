/**
 * PaddleOCR Preprocessing
 * Converts NativeImage or raw pixel data to ONNX input tensors.
 *
 * Detection model input: [1, 3, H, W] float32 — H,W multiples of 32, symmetric norm
 * Recognition model input: [1, 3, 48, W] float32 — height 48, variable width, symmetric norm
 *
 * Normalization (RapidOCR PP-OCRv4 models):
 *   pixel = (pixel / 255.0 - 0.5) / 0.5   → maps [0,255] to [-1,1]
 *
 * v3.13.01: Initial implementation
 * v3.13.02: Implemented rotate90CCW() for vertical text rotation
 */

/**
 * Preprocess image for detection model.
 * Resizes to fit within maxSideLen (rounded to multiple of 32),
 * normalizes with symmetric normalization, and creates NCHW tensor.
 *
 * @param {Buffer} imageBuffer - Raw image data (PNG/JPEG buffer)
 * @param {number} maxSideLen - Maximum side length for resize (default: 960)
 * @returns {{ tensor: Float32Array, shape: number[], ratio: number, padH: number, padW: number }}
 */
function preprocessForDetection(imageBuffer, maxSideLen = 960) {
  // Decode image using Electron's NativeImage
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(imageBuffer);
  const size = img.getSize();
  const origW = size.width;
  const origH = size.height;

  // Calculate resize ratio
  let ratio = 1.0;
  const maxSide = Math.max(origW, origH);
  if (maxSide > maxSideLen) {
    ratio = maxSideLen / maxSide;
  }

  let dstW = Math.round(origW * ratio);
  let dstH = Math.round(origH * ratio);

  // Round to multiples of 32 (required by DB model architecture)
  dstW = Math.max(32, Math.ceil(dstW / 32) * 32);
  dstH = Math.max(32, Math.ceil(dstH / 32) * 32);

  // Resize image using Electron's NativeImage
  const resized = img.resize({ width: dstW, height: dstH });

  // Get raw BGRA pixel data
  const bitmap = resized.toBitmap();
  const numPixels = dstW * dstH;

  // Convert BGRA → RGB Float32Array in NCHW format with symmetric normalization
  // Normalization: (pixel / 255.0 - 0.5) / 0.5
  const tensor = new Float32Array(3 * numPixels);
  const channelSize = numPixels;

  for (let i = 0; i < numPixels; i++) {
    const srcIdx = i * 4; // BGRA
    const r = bitmap[srcIdx + 2] / 255.0; // BGR → RGB
    const g = bitmap[srcIdx + 1] / 255.0;
    const b = bitmap[srcIdx + 0] / 255.0;

    // Symmetric normalization: (val - 0.5) / 0.5
    tensor[0 * channelSize + i] = (r - 0.5) / 0.5; // R channel
    tensor[1 * channelSize + i] = (g - 0.5) / 0.5; // G channel
    tensor[2 * channelSize + i] = (b - 0.5) / 0.5; // B channel
  }

  return {
    tensor,
    shape: [1, 3, dstH, dstW],
    ratio,
    origW,
    origH
  };
}

/**
 * Preprocess a cropped text region for recognition model.
 * Resizes to targetH (maintaining aspect ratio), pads width,
 * normalizes with symmetric normalization, creates NCHW tensor.
 *
 * v3.13.16: targetH is now a parameter, not hardcoded. PP-OCR recognition
 * models do NOT all share the same required input height — introspecting the
 * downloaded .onnx files directly showed the 'ja' model (SWHL/RapidOCR
 * PP-OCRv1 japan_rec_crnn.onnx) has a FIXED input height of 32, not 48. It
 * was silently crashing on every call
 * ("Got invalid dimensions for input: x ... Got: 48 Expected: 32") because
 * this function used to hardcode 48 for every model. 'zh' (PP-OCRv4) accepts
 * a dynamic height and 'ko' happens to be fixed at 48, which is why only 'ja'
 * threw. Callers should pass the active model's real input height — see
 * PaddleModelManager.getRecInputHeight() in paddle-models.js, which reads it
 * from the loaded session's inputMetadata instead of assuming a constant.
 *
 * @param {Buffer} imageBuffer - Cropped region as image buffer
 * @param {number} targetH - Required input height for the active recognition model (default: 48)
 * @param {boolean} enhance - v3.13.16: apply denoise + auto-invert (see below). Default off.
 * @returns {{ tensor: Float32Array, shape: number[] }}
 */
function preprocessForRecognition(imageBuffer, targetH = 48, enhance = false) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(imageBuffer);
  const size = img.getSize();
  const origW = size.width;
  const origH = size.height;

  // Resize to targetH, maintain aspect ratio
  const scale = targetH / origH;
  let dstW = Math.round(origW * scale);

  // Round up width to multiple of 4 (required by the model)
  dstW = Math.max(4, Math.ceil(dstW / 4) * 4);

  const resized = img.resize({ width: dstW, height: targetH });
  const bitmap = resized.toBitmap();
  const numPixels = dstW * targetH;

  // v3.13.16 Phase 1 (scoped): optional enhancement for hard cases — light
  // text on a noisy dark background (e.g. test06 in the bench: vertical text
  // over a grainy scene, 30% similarity). Applied here, AFTER resize to the
  // model's target height, so it runs on a small bitmap instead of the
  // full-resolution crop. Off by default — must not touch the 11 other bench
  // images that already recognize correctly without it.
  if (enhance) {
    medianDenoiseBGRA(bitmap, dstW, targetH);
    autoInvertBGRA(bitmap, dstW, targetH);
  }

  // Convert BGRA → RGB Float32Array in NCHW format with symmetric normalization
  const tensor = new Float32Array(3 * numPixels);
  const channelSize = numPixels;

  for (let i = 0; i < numPixels; i++) {
    const srcIdx = i * 4; // BGRA
    const r = bitmap[srcIdx + 2] / 255.0;
    const g = bitmap[srcIdx + 1] / 255.0;
    const b = bitmap[srcIdx + 0] / 255.0;

    tensor[0 * channelSize + i] = (r - 0.5) / 0.5;
    tensor[1 * channelSize + i] = (g - 0.5) / 0.5;
    tensor[2 * channelSize + i] = (b - 0.5) / 0.5;
  }

  return {
    tensor,
    shape: [1, 3, targetH, dstW]
  };
}

/**
 * Crop a text region from the original image buffer.
 * Returns the cropped region as a PNG buffer.
 *
 * @param {Buffer} imageBuffer - Original full image buffer
 * @param {object} box - Bounding box { x1, y1, x2, y2 }
 * @returns {Buffer} Cropped image as PNG buffer
 */
function cropRegion(imageBuffer, box) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(imageBuffer);
  const size = img.getSize();

  // Ensure bounds are within image
  const x = Math.max(0, Math.round(box.x1));
  const y = Math.max(0, Math.round(box.y1));
  const w = Math.min(Math.round(box.x2 - box.x1), size.width - x);
  const h = Math.min(Math.round(box.y2 - box.y1), size.height - y);

  if (w <= 0 || h <= 0) return null;

  // Use Electron's nativeImage crop
  const cropped = img.crop({ x, y, width: w, height: h });
  return cropped.toPNG();
}

/**
 * Rotate an image 90° counter-clockwise (for vertical text).
 * Used when detected text region has height ≥ 1.5× width.
 *
 * v3.13.02: Properly implemented using raw BGRA pixel rotation.
 *   Electron's NativeImage doesn't have a rotate method, so we
 *   manipulate the raw bitmap data directly.
 *   90° CCW rotation: pixel at (x, y) in original → (y, W-1-x) in rotated.
 *
 * @param {Buffer} imageBuffer - Image buffer to rotate
 * @returns {Buffer} Rotated image as PNG buffer
 */
function rotate90CCW(imageBuffer) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(imageBuffer);
  const size = img.getSize();
  const origW = size.width;
  const origH = size.height;

  // Skip rotation for very small images or non-rotatable sizes
  if (origW < 4 || origH < 4) return imageBuffer;

  const bitmap = img.toBitmap();

  // After 90° CCW rotation: new dimensions are (origH, origW)
  const newW = origH;
  const newH = origW;
  const rotated = Buffer.alloc(newW * newH * 4);

  // 90° CCW: pixel at (x, y) → (y, origW - 1 - x)
  // BGRA format: 4 bytes per pixel
  for (let y = 0; y < origH; y++) {
    for (let x = 0; x < origW; x++) {
      const srcIdx = (y * origW + x) * 4;
      const dstX = y;
      const dstY = origW - 1 - x;
      const dstIdx = (dstY * newW + dstX) * 4;
      rotated[dstIdx] = bitmap[srcIdx];         // B
      rotated[dstIdx + 1] = bitmap[srcIdx + 1]; // G
      rotated[dstIdx + 2] = bitmap[srcIdx + 2]; // R
      rotated[dstIdx + 3] = bitmap[srcIdx + 3]; // A
    }
  }

  // Create a new NativeImage from the rotated bitmap and return as PNG
  const rotatedImg = nativeImage.createFromBitmap(rotated, { width: newW, height: newH });
  return rotatedImg.toPNG();
}

/**
 * Check if a text region should be treated as vertical text.
 * Heuristic from Luna Translator: if height ≥ 1.5× width, it's vertical.
 *
 * @param {object} box - Bounding box { x1, y1, x2, y2 }
 * @returns {boolean}
 */
function isVerticalText(box) {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  return h >= w * 1.5;
}

/**
 * v3.13.16: 3x3 median filter on a BGRA bitmap, applied per-channel (B, G, R
 * independently; alpha untouched). Mutates `bitmap` in place.
 *
 * Chosen over a box blur or CLAHE for this specific problem: the noise in
 * test06 (the bench's remaining vertical-text failure) is speckle/grain, not
 * uneven illumination. CLAHE increases LOCAL contrast per tile, which
 * amplifies speckle rather than suppressing it — it's the wrong tool for
 * this noise pattern even though it was the original plan's default choice.
 * A median filter is the standard fix for salt-and-pepper-style noise and
 * preserves edges (thin text strokes) better than averaging would.
 *
 * Reads from a snapshot of the original bitmap so filtering one pixel never
 * uses another pixel's already-filtered value.
 *
 * @param {Buffer} bitmap - BGRA pixel buffer, mutated in place
 * @param {number} width
 * @param {number} height
 */
function medianDenoiseBGRA(bitmap, width, height) {
  const src = Buffer.from(bitmap);
  const windowVals = new Array(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) { // B, G, R
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(width - 1, Math.max(0, x + dx));
            windowVals[n++] = src[(ny * width + nx) * 4 + c];
          }
        }
        windowVals.sort((a, b) => a - b);
        bitmap[(y * width + x) * 4 + c] = windowVals[4]; // median of 9
      }
    }
  }
}

/**
 * v3.13.16: Invert a BGRA bitmap's RGB channels in place, but only when the
 * region's mean luma indicates a dark background. PP-OCR recognition models
 * are trained mostly on dark text over a light background (documents,
 * natural scene text); light text on a dark background — common in VN/game
 * dialogue boxes and menus (test05, test06, test08, test09 in the bench) —
 * is the inverse of what they expect. Flipping it is a cheap, reversible
 * normalization toward the training distribution.
 *
 * No-op (returns false) when the crop is already light-background, so this
 * is safe to leave on for crops the pipeline already handles correctly.
 *
 * @param {Buffer} bitmap - BGRA pixel buffer, mutated in place if inverted
 * @param {number} width
 * @param {number} height
 * @returns {boolean} true if the bitmap was inverted
 */
function autoInvertBGRA(bitmap, width, height) {
  const numPixels = width * height;
  let sum = 0;
  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    // BT.601 luma from BGRA order (B, G, R, A)
    sum += 0.114 * bitmap[idx] + 0.587 * bitmap[idx + 1] + 0.299 * bitmap[idx + 2];
  }
  const meanLuma = sum / numPixels;
  if (meanLuma >= 128) return false; // Already a light background — leave as-is

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    bitmap[idx] = 255 - bitmap[idx];
    bitmap[idx + 1] = 255 - bitmap[idx + 1];
    bitmap[idx + 2] = 255 - bitmap[idx + 2];
    // Alpha (idx + 3) untouched
  }
  return true;
}

module.exports = {
  preprocessForDetection,
  preprocessForRecognition,
  cropRegion,
  rotate90CCW,
  isVerticalText,
  medianDenoiseBGRA,
  autoInvertBGRA
};
