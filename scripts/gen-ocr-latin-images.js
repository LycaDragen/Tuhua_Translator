/**
 * Latin OCR test image generator — writes the `latin` group of test-images/
 * for the OCR-refinement round (v3.13.77+, see docs/... TODO or the plan).
 *
 * Why a generator instead of committed PNGs: test-images/ is gitignored (see
 * .gitignore:80), so a versioned script that regenerates the images on demand
 * is strictly better than binary assets that would either bypass gitignore or
 * live nowhere. It also means the text content is documented in one place
 * (this file + ocr-ground-truth.json) instead of buried in image pixels.
 *
 * MUST run under Electron, not plain node — uses a BrowserWindow + capturePage()
 * to rasterize CSS-styled text, same execution model as test-ocr-images.js:
 *   pnpm exec electron scripts/gen-ocr-latin-images.js
 *
 * Sizes are chosen to be app-realistic AND deliberately non-multiples-of-32.
 * This matters: the existing cjk bench images (1344x768, 768x1344, 864x1152)
 * all happen to land exactly or almost exactly on a multiple of 32, which
 * makes that bench blind to the anisotropic-resize / scalar-ratio-mapping bug
 * (see paddle-postprocess.js's decodeDetection and the round's plan). Sizes
 * here mirror real capture-area dimensions (window-manager.js's default is
 * 600x150 minus a 28px title bar = 600x122).
 *
 * Font rasterization differs between this WSL machine and Windows (where
 * Lyca actually runs the app) — absolute similarity scores are therefore NOT
 * comparable across machines. That's fine: the expected text is known by
 * construction, and every comparison that matters (before/after a pipeline
 * change, pad0 vs pad100) happens on one machine in one session. Do not try
 * to embed a font to force byte-determinism across machines — out of scope.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// v3.13.77: under WSLg the GPU process crashes/restarts across repeated
// BrowserWindow creation ("Exiting GPU process due to errors during
// initialization"), which reliably breaks the SECOND window's loadFile() in
// a run (ERR_FAILED) even though the first one works. This script only
// rasterizes flat CSS text — no need for GPU compositing — so disabling
// hardware acceleration outright avoids the crash instead of chasing it.
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'test-images');

// Each entry's `text` must match the `expected` field for the same file in
// ocr-ground-truth.json exactly (modulo the whitespace/NFKC normalization
// test-ocr-images.js already applies) — keep the two in sync by hand.
const IMAGES = [
  {
    file: 'lat01-tight-dialogue.png',
    width: 600, height: 122,
    text: "I never thought I'd see you again.",
    style: 'tight-dark'
  },
  {
    file: 'lat02-padded-dialogue.png',
    width: 1200, height: 400,
    text: "I never thought I'd see you again.",
    style: 'tight-dark',
    // Same font-size/text as lat01 (see 'tight-dark' below) — this is the
    // A/B control pair. Only the canvas grows; the text box is pinned to the
    // same absolute size and centered, so the surrounding capture region is
    // mostly empty, reproducing "capture window bigger than the text".
    pinTextBoxTo: { width: 600, height: 122 }
  },
  {
    file: 'lat03-visual-novel-serif.png',
    width: 900, height: 150,
    text: 'The old library still smelled of dust and rain.',
    style: 'renpy-serif'
  },
  {
    file: 'lat04-outlined-noisy.png',
    width: 1000, height: 220,
    text: 'Are you sure about this?',
    style: 'outlined-noisy'
  },
  {
    file: 'lat05-speaker-dialogue.png',
    width: 800, height: 180,
    text: "Maya\nDon't wait up for me tonight.",
    style: 'speaker-label'
  },
  {
    file: 'lat06-small-text.png',
    width: 600, height: 122,
    text: 'You should get some rest before tomorrow.',
    style: 'small-font'
  },
  {
    file: 'lat07-punctuation.png',
    width: 900, height: 150,
    text: '"Wait—don’t go," she said, her voice barely a whisper.',
    style: 'tight-dark'
  },
  {
    file: 'lat08-ui-menu.png',
    width: 1000, height: 300,
    text: ['New Game', 'Continue', 'Settings', 'Gallery', 'Quit'],
    style: 'ui-menu'
  }
];

/**
 * Build the HTML for one test image. Each `style` mirrors a real VN/game
 * look the bench cares about (see ground truth notes for the reasoning per
 * image).
 */
function buildHtml(spec) {
  const { width, height, text, style } = spec;

  if (style === 'ui-menu') {
    const labels = text.map((t, i) => `<div class="label" style="top:${20 + i * 50}px; left:${40 + (i % 2) * 480}px">${t}</div>`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:#1b1f27;overflow:hidden;}
      .label{position:absolute;font:600 28px "DejaVu Sans","Liberation Sans",sans-serif;color:#eee;text-shadow:0 1px 2px #000;}
    </style></head><body>${labels}</body></html>`;
  }

  if (style === 'speaker-label') {
    const [name, line] = text.split('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:#14161c;overflow:hidden;}
      .wrap{position:absolute;top:20px;left:30px;width:${width - 60}px;}
      .name{font:700 26px "DejaVu Sans","Liberation Sans",sans-serif;color:#ffd479;margin-bottom:10px;}
      .line{font:400 30px "DejaVu Sans","Liberation Sans",sans-serif;color:#f5f5f5;line-height:1.3;}
    </style></head><body><div class="wrap"><div class="name">${name}</div><div class="line">${line}</div></div></body></html>`;
  }

  if (style === 'renpy-serif') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:#ffffff;overflow:hidden;
        display:flex;align-items:center;justify-content:center;}
      .line{font:400 30px "DejaVu Serif","Liberation Serif",serif;color:#111;padding:0 30px;text-align:center;}
    </style></head><body><div class="line">${text}</div></body></html>`;
  }

  if (style === 'outlined-noisy') {
    // A CSS gradient stands in for "busy noisy background" — real sensor
    // noise isn't reproducible via CSS without a canvas element, and a
    // gradient is enough to stress low local contrast around the glyphs.
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;
        background:repeating-linear-gradient(45deg,#3a3a3a,#3a3a3a 4px,#565656 4px,#565656 8px),
                    radial-gradient(circle at 30% 40%, #777 0%, #2b2b2b 70%);
        display:flex;align-items:center;justify-content:center;}
      .line{font:700 34px "DejaVu Sans","Liberation Sans",sans-serif;color:#fff;
        text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 2px 4px rgba(0,0,0,.8);}
    </style></head><body><div class="line">${text}</div></body></html>`;
  }

  if (style === 'small-font') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:#0d0d12;overflow:hidden;
        display:flex;align-items:center;justify-content:center;}
      .line{font:400 12px "DejaVu Sans","Liberation Sans",sans-serif;color:#e8e8e8;padding:0 16px;text-align:center;}
    </style></head><body><div class="line">${text}</div></body></html>`;
  }

  // 'tight-dark' — the default VN dialogue-box look, and the A/B control pair.
  const boxW = spec.pinTextBoxTo ? spec.pinTextBoxTo.width : width;
  const boxH = spec.pinTextBoxTo ? spec.pinTextBoxTo.height : height;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:#1a1a1a;overflow:hidden;
      display:flex;align-items:center;justify-content:center;}
    .box{width:${boxW}px;height:${boxH}px;background:rgba(20,20,20,0.85);
      display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0 16px;}
    .line{font:400 28px "DejaVu Sans","Liberation Sans",sans-serif;color:#f5f5f5;text-align:center;}
  </style></head><body><div class="box"><div class="line">${text}</div></div></body></html>`;
}

async function generateOne(spec) {
  const win = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    show: false,
    frame: false,
    webPreferences: { offscreen: false }
  });

  // v3.13.77: loadURL('data:...') under WSLg intermittently threw ERR_FAILED
  // on the second+ window in a run (GPU process churn from repeated
  // BrowserWindow creation, confirmed by the "Exiting GPU process" log lines
  // preceding it) — writing a real temp .html file and loadFile()-ing it is
  // more robust and is what every other "load local content" pattern in
  // Electron docs recommends anyway.
  const tmpHtmlPath = path.join(IMAGES_DIR, `.gen-tmp-${spec.file}.html`);
  fs.writeFileSync(tmpHtmlPath, buildHtml(spec));
  try {
    await win.loadFile(tmpHtmlPath);
    // Let fonts/layout settle before capturing — a fixed short delay is
    // simplest and this only runs a handful of times, not in the hot OCR loop.
    await new Promise(resolve => setTimeout(resolve, 150));

    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    fs.writeFileSync(path.join(IMAGES_DIR, spec.file), png);
    return png.length;
  } finally {
    fs.unlinkSync(tmpHtmlPath);
    win.destroy();
  }
}

async function run() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // v3.13.77: destroying the only open BrowserWindow fires 'window-all-closed',
  // whose default handler quits the app — which silently killed this loop
  // after the first image (no error, no further output) before this fix.
  // A tiny window kept alive for the whole run prevents that.
  const keepAlive = new BrowserWindow({ width: 10, height: 10, show: false });

  console.log(`Generating ${IMAGES.length} Latin test images into ${IMAGES_DIR}...`);
  for (const spec of IMAGES) {
    const bytes = await generateOne(spec);
    console.log(`  ${spec.file}  ${spec.width}x${spec.height}  ${bytes} bytes`);
  }
  keepAlive.destroy();
  console.log('Done. Remember: absolute OCR scores from these images are only comparable');
  console.log('within this machine/session — font rasterization differs on Windows.');
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await run();
  } catch (err) {
    console.error('Generation failed:', err.message);
    console.error(err.stack);
    code = 1;
  }
  app.exit(code);
});
