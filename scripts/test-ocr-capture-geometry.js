/**
 * capture-geometry.js bench — pins the crop-rectangle math behind a real
 * regression (v3.13.112, Ronda 4d → fixed in v3.13.114, hardened in
 * v3.13.116). Confirmed by Lyca on real Windows: PaddleOCR detecting a
 * degenerate 32x32 input ("0 regions"), and an uncaught Tesseract crash
 * ("Error attempting to read image" / leptonica's "truncated file") while
 * reading a screen capture.
 *
 * Root cause, straight from Electron's own docs (electron.d.ts,
 * DesktopCapturerSource#thumbnail): "There is no guarantee that the size
 * of the thumbnail is the same as the thumbnailSize... The actual size
 * depends on the scale of the screen or window." Code that assumes the
 * returned thumbnail matches the requested size — instead of measuring
 * what it actually got — can compute a crop rectangle that lands outside
 * the real thumbnail, which forces a NEGATIVE width/height into
 * NativeImage.crop(). That's the actual mechanism: this bench never opens
 * a window or calls desktopCapturer, it only exercises the pure math with
 * a deliberately mismatched "requested vs actual" thumbnail size — that
 * mismatch is real, undetectable from WSL (single display, sizes always
 * matched by coincidence — see capability-electron-runs-in-wsl memory),
 * and is exactly why this shipped once already with WSL-only verification.
 *
 *   node scripts/test-ocr-capture-geometry.js
 *   node scripts/test-ocr-capture-geometry.js --quiet
 */
const path = require('path');
const { computeCaptureCropRect } = require(path.join('..', 'src', 'services', 'capture-geometry.js'));
const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

check('matched-size-produces-the-naive-scale-factor-crop', () => {
  // thumbnail came back at EXACTLY the requested size (the common case,
  // and the only case WSL's single-display setup ever exercises) —
  // scale factor 1.25, capture area at (100,100,600,150).
  const rect = computeCaptureCropRect({
    bounds: { x: 100, y: 100, width: 600, height: 150 },
    titleBarHeight: 28,
    screenWidth: 1920,
    screenHeight: 1080,
    thumbWidth: 1920 * 1.25,
    thumbHeight: 1080 * 1.25
  });
  const expected = { x: 125, y: 160, width: 750, height: 153 };
  return { pass: JSON.stringify(rect) === JSON.stringify(expected), actual: rect };
});

check('thumbnail-smaller-than-requested-still-lands-inside-its-real-bounds', () => {
  // THE REGRESSION: requested at scale 1.25 (a 125% Windows DPI setting),
  // but the real thumbnail Electron returned came back at scale 1.0 —
  // exactly the documented "no guarantee" case. The old (v3.13.112)
  // formula, which multiplied bounds by the ASSUMED scaleFactor (1.25)
  // instead of the ACHIEVED one, would compute a crop origin/size assuming
  // a 2400x1350 canvas that doesn't exist — landing outside the real
  // 1920x1080 thumbnail.
  const rect = computeCaptureCropRect({
    bounds: { x: 100, y: 100, width: 600, height: 150 },
    titleBarHeight: 28,
    screenWidth: 1920,
    screenHeight: 1080,
    thumbWidth: 1920, // actual scale 1.0, not the assumed 1.25
    thumbHeight: 1080
  });
  const withinBounds = rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= 1920 && rect.y + rect.height <= 1080 &&
    rect.width >= 0 && rect.height >= 0;
  return { pass: withinBounds, actual: rect };
}, 'The whole point of the fix: scale against the REAL thumbnail size, not the requested one.');

check('extreme-mismatch-never-produces-a-negative-width-or-height', () => {
  // Reproduces the exact numbers that proved the OLD math's failure mode
  // during this investigation: a capture area near the right edge of a
  // 1920-wide screen, requested at scale 2.0 (a 200% DPI setting, e.g. a
  // second monitor with different scaling than the primary), but the
  // real thumbnail came back at scale 1.0. The old inline formula
  // (cropX = Math.round(bounds.x * scaleFactor), unclamped before
  // subtracting from thumbWidth) computed cropX=2800 against a
  // thumbWidth of 1920 — width becomes NEGATIVE (-880), which is exactly
  // the kind of malformed rectangle that produces a corrupt/empty
  // NativeImage crop (crashes Tesseract, degenerates PaddleOCR detection).
  const rect = computeCaptureCropRect({
    bounds: { x: 1400, y: 100, width: 600, height: 150 },
    titleBarHeight: 28,
    screenWidth: 1920,
    screenHeight: 1080,
    thumbWidth: 1920, // actual scale 1.0, requested assumed 2.0
    thumbHeight: 1080
  });
  return {
    pass: rect.width >= 0 && rect.height >= 0,
    actual: rect
  };
}, 'This exact scenario produced width=-880 with the pre-v3.13.114 formula.');

check('capture-area-positioned-fully-off-screen-clamps-to-an-empty-crop-not-a-negative-one', () => {
  // A pathological but real-possible case (capture area dragged past the
  // screen edge, or a stale position from a since-disconnected second
  // monitor) — origin itself lands past the thumbnail's bounds.
  const rect = computeCaptureCropRect({
    bounds: { x: 5000, y: 5000, width: 600, height: 150 },
    titleBarHeight: 28,
    screenWidth: 1920,
    screenHeight: 1080,
    thumbWidth: 1920,
    thumbHeight: 1080
  });
  return {
    pass: rect.x <= 1920 && rect.y <= 1080 && rect.width === 0 && rect.height === 0,
    actual: rect
  };
});

check('larger-real-thumbnail-than-requested-still-lands-inside-its-real-bounds', () => {
  // The mismatch can go the other way too — thumbnail bigger than assumed
  // (e.g. a HiDPI display where Electron's actual capture scale exceeds
  // what scaleFactor reported). Correctness shouldn't depend on which
  // direction the mismatch goes.
  const rect = computeCaptureCropRect({
    bounds: { x: 100, y: 100, width: 600, height: 150 },
    titleBarHeight: 28,
    screenWidth: 1920,
    screenHeight: 1080,
    thumbWidth: 1920 * 3, // actual scale 3.0, assumed 1.0 implicitly (no scaleFactor passed in bounds' own scale)
    thumbHeight: 1080 * 3
  });
  const withinBounds = rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= 1920 * 3 && rect.y + rect.height <= 1080 * 3 &&
    rect.width >= 0 && rect.height >= 0;
  return { pass: withinBounds, actual: rect };
});

check('title-bar-height-is-excluded-from-the-crop-top', () => {
  // The capture area's own 28px title bar (the "OCR" label) must never
  // be included in what gets OCR'd — regression check independent of the
  // scale-mismatch fix above.
  const rect = computeCaptureCropRect({
    bounds: { x: 0, y: 0, width: 600, height: 150 },
    titleBarHeight: 28,
    screenWidth: 1920,
    screenHeight: 1080,
    thumbWidth: 1920,
    thumbHeight: 1080
  });
  return { pass: rect.y === 28 && rect.height === 122, actual: rect };
});

run('capture-geometry.js bench', CHECKS);
