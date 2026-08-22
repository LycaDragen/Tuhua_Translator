/**
 * OCR test bench for Tuhua Translator — test-images/ regression harness.
 *
 * v3.13.16: Initial implementation.
 *
 * MUST run under Electron, not plain node:
 *   pnpm exec electron scripts/test-ocr-images.js
 *
 * The pipeline depends on Electron APIs that do not exist in plain node —
 * paddle-preprocess.js uses nativeImage for decode/resize/crop, and
 * paddle-models.js resolves its model cache via app.getPath('userData').
 * No BrowserWindow is created; nativeImage works without one.
 *
 * Flags:
 *   --lang=ja        Override source language for every image
 *   --engine=paddle  'paddle' (default) or 'tesseract'
 *   --only=test03    Substring filter on filename
 *   --group=latin    Only run images whose ground-truth `group` matches (cjk|latin|real)
 *   --auto           Also run each `alsoTestAuto` image under sourceLang='auto'
 *   --pad=0,25,50,100  v3.13.77: for each image, also synthesize a padded variant
 *                    with N px of background-colored margin added on every side
 *                    before running OCR, and report a per-image "padding
 *                    degradation slope" (similarity@pad0 - similarity@maxPad).
 *                    This is the OCR-refinement round's acceptance number — see
 *                    the plan: a bigger-than-the-text capture window should not
 *                    hurt recognition once the geometry bugs are fixed.
 *   --json=PATH      Report output path (default scripts/ocr-report.json)
 *   --dump-boxes     v3.13.77: write each image's final detected boxes as a
 *                    red-outline overlay PNG into scripts/box-dumps/, so the
 *                    anisotropic-resize coordinate drift (or its absence,
 *                    post-fix) is visible instead of only inferred from
 *                    similarity scores.
 *   --tess-upscale=1.0,1.5,2.0,2.5,3.0
 *                    v3.13.77 (Stage 4): --engine=tesseract only. Sweeps
 *                    OcrService's upscaleFactor. Combines with --tess-psm=
 *                    as a full grid (every upscale x every psm), each run
 *                    reported with its resulting median word-line height in
 *                    px and its word-confidence "separation" (mean
 *                    confidence of words kept vs dropped by the relative
 *                    outlier filter) — a config that raises confidence on
 *                    kept AND dropped words together isn't actually
 *                    discriminating, no matter how good its similarity
 *                    looks. Omit to run once at the engine's current default
 *                    (upscaleFactor=1.0).
 *   --tess-psm=3,6,11
 *                    v3.13.77 (Stage 4): --engine=tesseract only. Sweeps
 *                    tessedit_pageseg_mode (3=AUTO, 6=SINGLE_BLOCK — the
 *                    default, 11=SPARSE_TEXT). See --tess-upscale=.
 *   --tess-otsu      v3.13.77 (Stage 4): --engine=tesseract only. Enables
 *                    Otsu binarization on top of whichever upscale/psm point
 *                    is being measured — a single on/off toggle, not swept
 *                    as a grid dimension (it's expected to be situational,
 *                    not a universal win — see OcrService's docstring).
 *   --quiet          Suppress per-image detail, print summary only
 */

const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'test-images');
const GROUND_TRUTH = path.join(__dirname, 'ocr-ground-truth.json');

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { engine: 'paddle', json: path.join(__dirname, 'ocr-report.json') };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (value === undefined) args[key] = true;
    else args[key] = value;
  }
  if (args.pad) {
    args.padValues = String(args.pad).split(',').map(v => parseInt(v, 10)).filter(n => Number.isFinite(n) && n >= 0);
    if (!args.padValues.includes(0)) args.padValues.unshift(0); // pad0 is the slope's reference point
  }
  // v3.13.77 (Stage 4): --tess-upscale=/--tess-psm= sweep grid, tesseract-only.
  args.tessUpscaleValues = args['tess-upscale']
    ? String(args['tess-upscale']).split(',').map(v => parseFloat(v)).filter(n => Number.isFinite(n) && n > 0)
    : [1.0];
  args.tessPsmValues = args['tess-psm']
    ? String(args['tess-psm']).split(',').map(v => v.trim()).filter(Boolean)
    : ['6'];
  args.tessOtsu = Boolean(args['tess-otsu']);
  return args;
}

// ─── Padding synthesis (v3.13.77 — OCR refinement round) ────────────────────

/**
 * Add `padPx` of background-colored margin on every side of an image, then
 * re-encode as PNG. Used to reproduce Lyca's real-world complaint ("capture
 * window bigger than the text hurts recognition") on images we already have
 * ground truth for, without needing new source material for every pad level.
 *
 * The background color is sampled from the image's own 1px border (median of
 * B/G/R independently) rather than assumed black/white, so this works on both
 * the cjk bench (mixed light/dark scenes) and the latin set (mostly dark VN
 * dialogue boxes) without per-image configuration.
 *
 * Follows the same nativeImage decode -> toBitmap -> mutate -> createFromBitmap
 * pattern already used in paddle-preprocess.js, so it needs no new dependency.
 *
 * @param {Buffer} imageBuffer - source image (PNG or JPEG data)
 * @param {number} padPx - margin to add on each side, in pixels
 * @returns {Buffer} new PNG buffer, (w+2*padPx) x (h+2*padPx)
 */
function padImageBuffer(imageBuffer, padPx) {
  if (padPx <= 0) return imageBuffer;

  const src = nativeImage.createFromBuffer(imageBuffer);
  const { width: w, height: h } = src.getSize();
  const srcBitmap = src.toBitmap(); // BGRA

  // Median border color, per channel, from the outermost ring of pixels.
  const borderSamples = { b: [], g: [], r: [] };
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const idx = (y * w + x) * 4;
      borderSamples.b.push(srcBitmap[idx]);
      borderSamples.g.push(srcBitmap[idx + 1]);
      borderSamples.r.push(srcBitmap[idx + 2]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const idx = (y * w + x) * 4;
      borderSamples.b.push(srcBitmap[idx]);
      borderSamples.g.push(srcBitmap[idx + 1]);
      borderSamples.r.push(srcBitmap[idx + 2]);
    }
  }
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const bgB = median(borderSamples.b);
  const bgG = median(borderSamples.g);
  const bgR = median(borderSamples.r);

  const dstW = w + 2 * padPx;
  const dstH = h + 2 * padPx;
  const dstBitmap = Buffer.alloc(dstW * dstH * 4);
  for (let i = 0; i < dstW * dstH; i++) {
    dstBitmap[i * 4] = bgB;
    dstBitmap[i * 4 + 1] = bgG;
    dstBitmap[i * 4 + 2] = bgR;
    dstBitmap[i * 4 + 3] = 255;
  }

  // Blit the original centered into the padded canvas.
  for (let y = 0; y < h; y++) {
    const srcRowStart = y * w * 4;
    const dstRowStart = ((y + padPx) * dstW + padPx) * 4;
    srcBitmap.copy(dstBitmap, dstRowStart, srcRowStart, srcRowStart + w * 4);
  }

  const dstImage = nativeImage.createFromBitmap(dstBitmap, { width: dstW, height: dstH });
  return dstImage.toPNG();
}

/**
 * Draw a 2px red rectangle outline for each box onto a copy of the image —
 * for --dump-boxes, to SEE the coordinate drift the Stage 1 telemetry
 * predicts (boxes should visibly hug the text; if the anisotropic-resize bug
 * is live, they'll drift down/right by a few percent, worse on tall/wide
 * non-multiple-of-32 images).
 *
 * @param {Buffer} imageBuffer
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} boxes
 * @returns {Buffer} PNG with boxes overlaid
 */
function drawBoxesOverlay(imageBuffer, boxes) {
  const img = nativeImage.createFromBuffer(imageBuffer);
  const { width: w, height: h } = img.getSize();
  const bitmap = img.toBitmap(); // BGRA, mutate in place — this is a fresh decode, safe to mutate

  const setPx = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = (y * w + x) * 4;
    bitmap[idx] = 0; bitmap[idx + 1] = 0; bitmap[idx + 2] = 255; bitmap[idx + 3] = 255; // BGRA red
  };

  for (const box of boxes) {
    const x1 = Math.round(box.x1), y1 = Math.round(box.y1);
    const x2 = Math.round(box.x2), y2 = Math.round(box.y2);
    for (let t = 0; t < 2; t++) {
      for (let x = x1; x <= x2; x++) { setPx(x, y1 + t); setPx(x, y2 - t); }
      for (let y = y1; y <= y2; y++) { setPx(x1 + t, y); setPx(x2 - t, y); }
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: w, height: h }).toPNG();
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Levenshtein distance over Unicode code points (not UTF-16 units) so that
 * CJK and any astral-plane characters count as one edit, not two.
 */
function levenshtein(a, b) {
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

/**
 * Normalize before comparing: OCR line breaks and spacing are not what we are
 * testing here, character recovery is. Keeps CJK punctuation intact.
 */
function normalizeForCompare(text) {
  return (text || '')
    .replace(/\s+/g, '')
    .normalize('NFKC')
    .trim();
}

function similarity(expected, actual) {
  const e = normalizeForCompare(expected);
  const a = normalizeForCompare(actual);
  if (e.length === 0 && a.length === 0) return 1;
  if (e.length === 0 || a.length === 0) return 0;
  const dist = levenshtein(e, a);
  return Math.max(0, 1 - dist / Math.max(Array.from(e).length, Array.from(a).length));
}

/** Per-character recall: how much of the expected text was actually recovered. */
function charRecall(expected, actual) {
  const e = Array.from(normalizeForCompare(expected));
  if (e.length === 0) return 1;
  const pool = new Map();
  for (const ch of Array.from(normalizeForCompare(actual))) {
    pool.set(ch, (pool.get(ch) || 0) + 1);
  }
  let hit = 0;
  for (const ch of e) {
    const n = pool.get(ch) || 0;
    if (n > 0) { hit++; pool.set(ch, n - 1); }
  }
  return hit / e.length;
}

/**
 * Furigana leakage: kana listed in ground truth that must NOT appear.
 * Only meaningful when the character is absent from the expected text itself.
 *
 * v3.13.18: This is a literal-character check, so it misses a leak whenever
 * recognition misreads the furigana into something else — which is common
 * (test11's か/で come out as が). Use result.furiganaBoxesDropped (from
 * regionStages) for a ground-truth-independent signal that doesn't depend on
 * recognition getting the leaked text exactly right.
 */
function furiganaLeak(entry, actual) {
  if (!entry.furigana || entry.furigana.length === 0) return [];
  const a = normalizeForCompare(actual);
  const e = normalizeForCompare(entry.expected);
  return entry.furigana.filter(ch => a.includes(ch) && !e.includes(ch));
}

function verdictFor(sim, recall) {
  if (sim >= 0.85) return 'PASS';
  if (sim >= 0.50 || recall >= 0.60) return 'PARTIAL';
  return 'FAIL';
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

function colorVerdict(v) {
  if (v === 'PASS') return `${C.green}PASS${C.reset}`;
  if (v === 'PARTIAL') return `${C.yellow}PARTIAL${C.reset}`;
  if (v === 'ERROR') return `${C.red}${C.bold}ERROR${C.reset}`;
  return `${C.red}FAIL${C.reset}`;
}

function printResult(r, quiet) {
  const padTag = r.pad ? ` pad=${r.pad}` : '';
  if (quiet) {
    console.log(`  ${colorVerdict(r.verdict).padEnd(20)} ${r.file}${padTag}  sim=${(r.similarity * 100).toFixed(0)}%`);
    return;
  }
  console.log(`\n${C.bold}${r.file}${padTag}${C.reset} ${C.dim}[lang=${r.lang}, ${r.difficulty}]${C.reset}`);
  console.log(`  verdict    : ${colorVerdict(r.verdict)}   similarity ${(r.similarity * 100).toFixed(1)}%   recall ${(r.charRecall * 100).toFixed(1)}%`);
  console.log(`  expected   : ${C.cyan}${r.expected.replace(/\n/g, ' / ')}${C.reset}`);
  console.log(`  actual     : ${r.actual ? r.actual.replace(/\n/g, ' / ') : C.dim + '(empty)' + C.reset}`);
  console.log(`  ${C.dim}engine     : ${r.regions === null ? 'N/A' : r.regions} regions, conf ${(r.confidence * 100).toFixed(1)}%, model '${r.activeModel}', ${r.elapsedMs}ms${C.reset}`);
  // v3.13.17: Per-stage region counts — tells apart "the detector never found
  // it" (detected is already low) from "we discarded it ourselves" (detected
  // is healthy but a later stage drops it). That distinction picks the fix:
  // swap the detection model vs. tune our own thresholds in ocr-paddle.js.
  if (r.regionStages) {
    const s = r.regionStages;
    console.log(`  ${C.dim}stages     : detected=${s.detected} → minArea=${s.afterMinArea} → aspect=${s.afterAspectRatio} → furigana=${s.afterFurigana} → merge=${s.afterMerge} → crowded=${s.afterCrowdedFilter} → maxRegions=${s.afterMaxRegions} → recognized=${s.recognized} → outlier=${s.afterOutlierFilter}${C.reset}`);
  }
  // v3.13.77 (Stage 1): input/output map dims + the scalar ratio, so a
  // stride != 1.00 or a non-square dstW/dstH-vs-origW/origH mismatch is
  // visible without re-running with extra flags.
  if (r.detGeometry) {
    const g = r.detGeometry;
    const sx = (g.dstW / g.outW).toFixed(2), sy = (g.dstH / g.outH).toFixed(2);
    console.log(`  ${C.dim}detection  : orig=${g.origW}x${g.origH} → resized=${g.dstW}x${g.dstH} (ratio=${g.ratio.toFixed(4)}) → outputMap=${g.outW}x${g.outH} (stride ${sx}x${sy})${C.reset}`);
  }
  if (r.furiganaLeaked.length) {
    console.log(`  ${C.yellow}furigana leaked into output: ${r.furiganaLeaked.join(' ')}${C.reset}`);
  }
  if (r.knownUnreadable && r.knownUnreadable.length) {
    console.log(`  ${C.dim}excluded (unreadable in source): ${r.knownUnreadable.join(' ')}${C.reset}`);
  }
  if (r.error) {
    console.log(`  ${C.red}${C.bold}threw: ${r.error}${C.reset}`);
    if (r.errorStack) console.log(`${C.dim}${r.errorStack}${C.reset}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const quiet = Boolean(args.quiet);

  if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`${C.red}test-images/ not found at ${IMAGES_DIR}${C.reset}`);
    return 1;
  }

  const groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));
  let entries = groundTruth.images;
  if (args.only) entries = entries.filter(e => e.file.includes(args.only));
  if (args.group) entries = entries.filter(e => e.group === args.group);
  if (entries.length === 0) {
    console.error(`${C.red}No images matched --only=${args.only}${args.group ? ` --group=${args.group}` : ''}${C.reset}`);
    return 1;
  }

  // Build the run list: each image once at its own language, plus an extra
  // 'auto' pass for the cases that exercise the model-switch path, times one
  // pass per --pad value (just [0] i.e. no padding, if --pad wasn't given),
  // times one pass per --tess-upscale=/--tess-psm= grid point (just the
  // engine's current default, tesseract-only, if neither was given).
  const padValues = args.padValues || [0];
  const tessSweep = args.engine === 'tesseract'
    ? args.tessUpscaleValues.flatMap(upscaleFactor => args.tessPsmValues.map(psm => ({ upscaleFactor, psm })))
    : [null];
  const runs = [];
  for (const entry of entries) {
    for (const pad of padValues) {
      for (const tess of tessSweep) {
        runs.push({ entry, lang: args.lang || entry.lang, pad, tess });
        if (args.auto && entry.alsoTestAuto && !args.lang) {
          runs.push({ entry, lang: 'auto', pad, tess });
        }
      }
    }
  }

  console.log(`${C.bold}Tuhua OCR bench${C.reset} — ${runs.length} runs over ${entries.length} images, engine=${args.engine}${args.group ? `, group=${args.group}` : ''}${args.padValues ? `, pad=${padValues.join(',')}` : ''}`);

  const OcrService = require('../src/services/ocr');
  const PaddleOCREngine = require('../src/services/ocr-paddle');

  if (args.engine === 'paddle' && !PaddleOCREngine.isAvailable()) {
    console.error(`\n${C.red}${C.bold}onnxruntime-node is not loadable — PaddleOCR is unavailable.${C.reset}`);
    console.error(`It is an optionalDependency, so 'pnpm install' does NOT fail when it`);
    console.error(`cannot be built. Verify with:  node -e "require('onnxruntime-node')"`);
    return 1;
  }

  const ocr = new OcrService();
  ocr.setOcrEngine(args.engine);
  ocr.on('error', () => { /* per-run errors are captured below */ });

  // setOcrEngine() silently downgrades to tesseract if paddle is unavailable,
  // so confirm what we actually got rather than what we asked for.
  if (ocr.getOcrEngine() !== args.engine) {
    console.error(`${C.yellow}Requested engine '${args.engine}' but service is using '${ocr.getOcrEngine()}'.${C.reset}`);
    args.engine = ocr.getOcrEngine();
  }

  // v3.13.77: OcrService.setLanguage() (used per-run below) skips calling
  // initialize() whenever the requested language's Tesseract code already
  // matches the constructor default ('eng') AND the engine isn't paddle —
  // it assumes a worker already exists to switch. In production that's
  // always true (ipc-handlers.js calls ocrService.initialize(sourceLang)
  // once at OCR-session start), but this bench never did, so any
  // --engine=tesseract run whose FIRST image has lang='en'/'eng' (true for
  // every image in the `latin` group) hit that guard on run #1 and the
  // Tesseract worker was simply never created — every recognize() call then
  // threw "OCR worker not initialized." An explicit initialize() call here
  // guarantees the worker (or the Paddle engine) exists before the loop,
  // regardless of which language happens to run first.
  await ocr.initialize(runs[0] ? runs[0].lang : 'ja');

  if (args.enhance) {
    console.log(`${C.dim}--enhance: median denoise + auto-invert enabled on recognition crops${C.reset}`);
    ocr.setPaddleOptions({ enhance: true });
  }

  const results = [];

  for (const { entry, lang, pad, tess } of runs) {
    const imagePath = path.join(IMAGES_DIR, entry.file);
    if (!fs.existsSync(imagePath)) {
      console.error(`${C.red}missing: ${entry.file}${C.reset}`);
      continue;
    }

    // Read as a buffer — these files are JPEG despite the .png extension.
    let buffer = fs.readFileSync(imagePath);
    if (pad) buffer = padImageBuffer(buffer, pad);

    // v3.13.77 (Stage 4): apply this run's sweep point before recognizing.
    if (tess) {
      ocr.setTesseractOptions({
        upscaleFactor: tess.upscaleFactor,
        psm: tess.psm,
        otsuThreshold: args.tessOtsu
      });
    }

    const result = {
      file: entry.file,
      group: entry.group || null,
      lang,
      pad: pad || 0,
      tessUpscale: tess ? tess.upscaleFactor : null,
      tessPsm: tess ? tess.psm : null,
      difficulty: entry.difficulty,
      expected: entry.expected,
      knownUnreadable: entry.knownUnreadable || [],
      actual: '',
      confidence: 0,
      wordStats: null,
      regions: null,
      regionStages: null,
      activeModel: '?',
      elapsedMs: 0,
      similarity: 0,
      charRecall: 0,
      furiganaLeaked: [],
      furiganaBoxesDropped: null,
      detGeometry: null,
      detectedBoxes: null,
      verdict: 'ERROR',
      error: null,
      errorStack: null
    };

    const started = Date.now();
    try {
      await ocr.setLanguage(lang);

      // Each image is an independent sample — clear the dedup memory so that
      // similar consecutive images don't get suppressed as "already emitted".
      ocr._lastEmittedText = '';

      const res = await ocr.recognize(buffer);
      result.actual = (res.text || '').trim();
      result.wordStats = res.wordStats || null;
      result.confidence = res.confidence || 0;

      if (args.engine === 'paddle') {
        // v3.13.17: OcrService._recognizePaddle() now forwards regions/regionStages/
        // recModel from PaddleOCREngine.recognize() on every return path (previously
        // only { text, confidence } escaped, so "detection never found it" and "our
        // own thresholds discarded it" were indistinguishable from outside).
        result.activeModel = res.recModel || ocr._paddleEngine.getStatus().activeRecModel || '?';
        result.regions = typeof res.regions === 'number' ? res.regions : null;
        result.regionStages = res.regionStages || null;
        // v3.13.77 (Stage 1, OCR-refinement round): detection geometry (input
        // size, DB output map size, the scalar `ratio`) and the final boxes
        // actually cropped — for --dump-boxes and for diagnosing the
        // anisotropic-resize / unclip fixes in Stage 2.
        result.detGeometry = res.detGeometry || null;
        result.detectedBoxes = res.detectedBoxes || null;
        // v3.13.18: furiganaLeak() below only catches a leak if the exact
        // ground-truth character survives into the output — but recognition
        // regularly misreads furigana into something else entirely (test11's
        // か/で come out as が), so that check reports zero leaks even when
        // one happened. regionStages gives a ground-truth-independent signal
        // instead: did the furigana filter actually drop a box this run.
        if (result.regionStages) {
          const s = result.regionStages;
          result.furiganaBoxesDropped = s.afterAspectRatio - s.afterFurigana;
        }

        if (args['dump-boxes'] && result.detectedBoxes && result.detectedBoxes.length > 0) {
          const dumpDir = path.join(__dirname, 'box-dumps');
          if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
          const dumpName = `${entry.file.replace(/\.png$/, '')}${pad ? `-pad${pad}` : ''}.png`;
          fs.writeFileSync(path.join(dumpDir, dumpName), drawBoxesOverlay(buffer, result.detectedBoxes));
        }
      }
    } catch (err) {
      // The pipeline swallows internal throws and returns {text:''}, which makes
      // "recognized nothing" and "crashed" look identical in production. Anything
      // that still escapes to here is recorded rather than silently scored as FAIL.
      result.error = err.message;
      result.errorStack = err.stack;
    }
    result.elapsedMs = Date.now() - started;

    result.similarity = similarity(entry.expected, result.actual);
    result.charRecall = charRecall(entry.expected, result.actual);
    result.furiganaLeaked = furiganaLeak(entry, result.actual);
    if (!result.error) result.verdict = verdictFor(result.similarity, result.charRecall);

    results.push(result);
    printResult(result, quiet);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, ERROR: 0 };
  for (const r of results) counts[r.verdict]++;
  const avgSim = results.reduce((s, r) => s + r.similarity, 0) / (results.length || 1);
  const emptyCount = results.filter(r => !r.actual).length;

  console.log(`\n${C.bold}${'─'.repeat(64)}${C.reset}`);
  console.log(`${C.bold}Summary${C.reset}  ${C.green}${counts.PASS} pass${C.reset}  ${C.yellow}${counts.PARTIAL} partial${C.reset}  ${C.red}${counts.FAIL} fail${C.reset}  ${C.red}${C.bold}${counts.ERROR} error${C.reset}   (${results.length} runs)`);
  console.log(`Mean similarity: ${(avgSim * 100).toFixed(1)}%`);
  console.log(`Empty output   : ${emptyCount}/${results.length}${emptyCount ? `  ${C.dim}— empty output on an image with visible text points at the pipeline, not the model${C.reset}` : ''}`);

  // v3.13.77: per-group means — a single mixed mean can hide a cjk regression
  // behind a latin gain, exactly the failure mode the OCR-refinement round is
  // exposed to (see the plan). Only the pad=0 runs count here; padded
  // variants are summarized separately below so they don't skew the headline
  // number quietly.
  const groupNames = [...new Set(results.map(r => r.group).filter(Boolean))];
  const groupSummary = {};
  if (groupNames.length > 1) {
    console.log(`\n${C.bold}Per group (pad=0 only)${C.reset}`);
    for (const g of groupNames) {
      const gr = results.filter(r => r.group === g && r.pad === 0);
      if (gr.length === 0) continue;
      const gSim = gr.reduce((s, r) => s + r.similarity, 0) / gr.length;
      const gPass = gr.filter(r => r.verdict === 'PASS').length;
      groupSummary[g] = { meanSimilarity: gSim, pass: gPass, total: gr.length };
      console.log(`  ${g.padEnd(6)} mean similarity ${(gSim * 100).toFixed(1)}%   ${gPass}/${gr.length} pass`);
    }
  }

  // v3.13.77: padding-degradation slope — the round's acceptance number. For
  // every (file, lang) pair run at more than one pad level, report
  // similarity@pad0 minus similarity@maxPad. Today this should be clearly
  // positive (bigger empty margin around the text hurts); after the Stage 2
  // geometry fix it should collapse toward zero. See the plan's Stage 0a.
  let padSlopeReport = null;
  if (args.padValues && args.padValues.length > 1) {
    const maxPad = Math.max(...args.padValues);
    const byKey = new Map();
    for (const r of results) {
      const key = `${r.file}::${r.lang}`;
      if (!byKey.has(key)) byKey.set(key, {});
      byKey.get(key)[r.pad] = r.similarity;
    }
    console.log(`\n${C.bold}Padding-degradation slope (sim@pad0 − sim@pad${maxPad})${C.reset}`);
    let slopeSum = 0, slopeCount = 0;
    const perImage = {};
    for (const [key, byPad] of byKey) {
      if (!(0 in byPad) || !(maxPad in byPad)) continue;
      const slope = byPad[0] - byPad[maxPad];
      perImage[key] = slope;
      slopeSum += slope;
      slopeCount++;
      const tag = slope > 0.05 ? C.red : (slope < -0.02 ? C.yellow : C.green);
      console.log(`  ${tag}${(slope * 100).toFixed(1).padStart(6)}%${C.reset}  ${key}`);
    }
    const meanSlope = slopeCount > 0 ? slopeSum / slopeCount : null;
    if (meanSlope !== null) {
      console.log(`  ${C.bold}mean slope: ${(meanSlope * 100).toFixed(1)}%${C.reset}  ${C.dim}(positive = padding hurts; target ~0 after the geometry fix)${C.reset}`);
    }
    padSlopeReport = { maxPad, meanSlope, perImage };
  }

  const leaks = results.filter(r => r.furiganaLeaked.length);
  if (leaks.length) {
    console.log(`${C.yellow}Furigana leaked in ${leaks.length} run(s): ${leaks.map(r => r.file).join(', ')}${C.reset}`);
  }
  // v3.13.18: The ground-truth-independent signal — see furiganaLeak()'s docstring.
  const furiganaDrops = results.filter(r => r.furiganaBoxesDropped > 0);
  if (furiganaDrops.length) {
    console.log(`${C.dim}Furigana boxes dropped by the geometric filter: ${furiganaDrops.map(r => `${r.file}=${r.furiganaBoxesDropped}`).join(', ')}${C.reset}`);
  }

  // v3.13.77 (Stage 4, OCR-refinement round): tesseract sweep grid summary —
  // one row per (upscaleFactor, psm) point actually run, at pad=0 only (the
  // sweep and the padding sweep are orthogonal; combining both would make an
  // already-large grid unreadable). Reports mean similarity alongside median
  // line height and the kept/dropped confidence separation, because a config
  // that wins on similarity but shows kept/dropped confidence converging
  // (see OcrService._computeTesseractWordStats()'s docstring) is winning by
  // inflating confidence uniformly, not by discriminating real text from
  // clutter — exactly the failure mode the plan flagged for this sweep.
  let tessSweepReport = null;
  if (args.engine === 'tesseract' && (args.tessUpscaleValues.length > 1 || args.tessPsmValues.length > 1)) {
    console.log(`\n${C.bold}Tesseract sweep (pad=0 only)${C.reset}`);
    tessSweepReport = [];
    for (const upscaleFactor of args.tessUpscaleValues) {
      for (const psm of args.tessPsmValues) {
        const cell = results.filter(r => r.pad === 0 && r.tessUpscale === upscaleFactor && r.tessPsm === psm);
        if (cell.length === 0) continue;
        const cellSim = cell.reduce((s, r) => s + r.similarity, 0) / cell.length;
        const withStats = cell.filter(r => r.wordStats);
        const meanLineHeight = withStats.length
          ? withStats.reduce((s, r) => s + (r.wordStats.medianLineHeightPx || 0), 0) / withStats.length
          : null;
        const keptConfs = withStats.map(r => r.wordStats.meanConfidenceKept).filter(v => v != null);
        const droppedConfs = withStats.map(r => r.wordStats.meanConfidenceDropped).filter(v => v != null);
        const meanKept = keptConfs.length ? keptConfs.reduce((s, v) => s + v, 0) / keptConfs.length : null;
        const meanDropped = droppedConfs.length ? droppedConfs.reduce((s, v) => s + v, 0) / droppedConfs.length : null;
        const separation = (meanKept != null && meanDropped != null) ? meanKept - meanDropped : null;
        const row = { upscaleFactor, psm, meanSimilarity: cellSim, meanLineHeightPx: meanLineHeight, meanConfidenceKept: meanKept, meanConfidenceDropped: meanDropped, confidenceSeparation: separation, n: cell.length };
        tessSweepReport.push(row);
        const sepStr = separation != null ? `${separation >= 0 ? '+' : ''}${separation.toFixed(1)}` : 'n/a';
        console.log(`  upscale=${String(upscaleFactor).padEnd(4)} psm=${psm.padEnd(2)}  sim=${(cellSim * 100).toFixed(1)}%  lineHeight=${meanLineHeight != null ? meanLineHeight.toFixed(1) + 'px' : 'n/a'}  kept=${meanKept != null ? meanKept.toFixed(1) : 'n/a'}  dropped=${meanDropped != null ? meanDropped.toFixed(1) : 'n/a'}  separation=${sepStr}  ${C.dim}(n=${cell.length})${C.reset}`);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: args.engine,
    counts,
    meanSimilarity: avgSim,
    emptyOutput: emptyCount,
    groupSummary,
    padSlope: padSlopeReport,
    tessSweep: tessSweepReport,
    results
  };
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`${C.dim}Report written to ${args.json}${C.reset}`);
  console.log(`${C.dim}Compare against a previous run to tell a real improvement from a threshold that merely moved the failures around.${C.reset}`);

  try { await ocr.terminate(); } catch (e) { /* best effort */ }

  return counts.ERROR > 0 ? 1 : 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    console.error(`\n${C.red}${C.bold}Bench failed:${C.reset} ${err.message}`);
    console.error(err.stack);
  }
  app.exit(code);
});
