/**
 * Pure geometry for cropping an OCR capture region out of a full-screen
 * thumbnail — split out of ipc-handlers.js's _captureScreenRegionImage()
 * (v3.13.114) so the exact math that caused a real regression can be
 * pinned by a test bank (scripts/test-ocr-capture-geometry.js) without
 * needing Electron/desktopCapturer at all.
 *
 * v3.13.112 (Ronda 4d) removed a resize() call assuming the thumbnail
 * `desktopCapturer.getSources()` returns always comes back at exactly the
 * requested `thumbnailSize` (screenWidth*scaleFactor × screenHeight*
 * scaleFactor). Electron's own docs say otherwise (electron.d.ts,
 * DesktopCapturerSource#thumbnail): "There is no guarantee that the size
 * of the thumbnail is the same as the thumbnailSize... The actual size
 * depends on the scale of the screen or window." On a mismatch, computing
 * the crop rectangle from the ASSUMED size instead of the thumbnail's
 * REAL size can push x/y past the thumbnail's own bounds, which forces a
 * negative width/height into NativeImage.crop() — confirmed as the root
 * cause of a Tesseract crash ("Error attempting to read image") and
 * PaddleOCR detecting a degenerate 32x32 input on Lyca's real Windows
 * machine (v3.13.114).
 */

/**
 * @param {object} params
 * @param {{x:number,y:number,width:number,height:number}} params.bounds -
 *   capture area window bounds, in LOGICAL (CSS) pixels.
 * @param {number} params.titleBarHeight - logical pixels to skip at the
 *   top of `bounds` (the capture area's own title bar, not game content).
 * @param {number} params.screenWidth - logical width of the display
 *   `desktopCapturer` was asked to capture (screen.getPrimaryDisplay().size.width).
 * @param {number} params.screenHeight - logical height, same source.
 * @param {number} params.thumbWidth - the ACTUAL width of the returned
 *   thumbnail (thumbnail.getSize().width) — NOT the requested thumbnailSize.
 * @param {number} params.thumbHeight - the ACTUAL height, same caveat.
 * @returns {{x:number,y:number,width:number,height:number}} a rectangle
 *   guaranteed to stay within [0, thumbWidth] × [0, thumbHeight] as long as
 *   `bounds` describes a region that overlaps the screen at all — width/
 *   height can be 0 (empty crop) but never negative.
 */
function computeCaptureCropRect({ bounds, titleBarHeight, screenWidth, screenHeight, thumbWidth, thumbHeight }) {
  // The scale ACTUALLY achieved by desktopCapturer, derived from what it
  // really returned — not assumed from screen.getPrimaryDisplay().scaleFactor.
  const actualScaleX = thumbWidth / screenWidth;
  const actualScaleY = thumbHeight / screenHeight;

  const rawX = Math.round(bounds.x * actualScaleX);
  const rawY = Math.round((bounds.y + titleBarHeight) * actualScaleY);
  const rawWidth = Math.round(bounds.width * actualScaleX);
  const rawHeight = Math.round((bounds.height - titleBarHeight) * actualScaleY);

  // Clamp into the thumbnail's real bounds. x/y themselves are clamped
  // first (a capture area positioned off-screen must not produce a
  // negative origin), THEN width/height against what's left from that
  // clamped origin — this is what keeps width/height from ever going
  // negative, the exact failure mode of the v3.13.112 regression.
  const x = Math.max(0, Math.min(rawX, thumbWidth));
  const y = Math.max(0, Math.min(rawY, thumbHeight));
  const width = Math.max(0, Math.min(rawWidth, thumbWidth - x));
  const height = Math.max(0, Math.min(rawHeight, thumbHeight - y));

  return { x, y, width, height };
}

module.exports = { computeCaptureCropRect };
