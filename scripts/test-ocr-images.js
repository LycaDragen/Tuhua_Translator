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
 *   --auto           Also run each `alsoTestAuto` image under sourceLang='auto'
 *   --json=PATH      Report output path (default scripts/ocr-report.json)
 *   --quiet          Suppress per-image detail, print summary only
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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
  return args;
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
  if (quiet) {
    console.log(`  ${colorVerdict(r.verdict).padEnd(20)} ${r.file}  sim=${(r.similarity * 100).toFixed(0)}%`);
    return;
  }
  console.log(`\n${C.bold}${r.file}${C.reset} ${C.dim}[lang=${r.lang}, ${r.difficulty}]${C.reset}`);
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
    console.log(`  ${C.dim}stages     : detected=${s.detected} → minArea=${s.afterMinArea} → aspect=${s.afterAspectRatio} → merge=${s.afterMerge} → crowded=${s.afterCrowdedFilter} → maxRegions=${s.afterMaxRegions} → recognized=${s.recognized} → outlier=${s.afterOutlierFilter}${C.reset}`);
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
  if (entries.length === 0) {
    console.error(`${C.red}No images matched --only=${args.only}${C.reset}`);
    return 1;
  }

  // Build the run list: each image once at its own language, plus an extra
  // 'auto' pass for the cases that exercise the model-switch path.
  const runs = [];
  for (const entry of entries) {
    runs.push({ entry, lang: args.lang || entry.lang });
    if (args.auto && entry.alsoTestAuto && !args.lang) {
      runs.push({ entry, lang: 'auto' });
    }
  }

  console.log(`${C.bold}Tuhua OCR bench${C.reset} — ${runs.length} runs over ${entries.length} images, engine=${args.engine}`);

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

  if (args.enhance) {
    console.log(`${C.dim}--enhance: median denoise + auto-invert enabled on recognition crops${C.reset}`);
    ocr.setPaddleOptions({ enhance: true });
  }

  const results = [];

  for (const { entry, lang } of runs) {
    const imagePath = path.join(IMAGES_DIR, entry.file);
    if (!fs.existsSync(imagePath)) {
      console.error(`${C.red}missing: ${entry.file}${C.reset}`);
      continue;
    }

    // Read as a buffer — these files are JPEG despite the .png extension.
    const buffer = fs.readFileSync(imagePath);

    const result = {
      file: entry.file,
      lang,
      difficulty: entry.difficulty,
      expected: entry.expected,
      knownUnreadable: entry.knownUnreadable || [],
      actual: '',
      confidence: 0,
      regions: null,
      regionStages: null,
      activeModel: '?',
      elapsedMs: 0,
      similarity: 0,
      charRecall: 0,
      furiganaLeaked: [],
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
      result.confidence = res.confidence || 0;

      if (args.engine === 'paddle') {
        // v3.13.17: OcrService._recognizePaddle() now forwards regions/regionStages/
        // recModel from PaddleOCREngine.recognize() on every return path (previously
        // only { text, confidence } escaped, so "detection never found it" and "our
        // own thresholds discarded it" were indistinguishable from outside).
        result.activeModel = res.recModel || ocr._paddleEngine.getStatus().activeRecModel || '?';
        result.regions = typeof res.regions === 'number' ? res.regions : null;
        result.regionStages = res.regionStages || null;
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

  const leaks = results.filter(r => r.furiganaLeaked.length);
  if (leaks.length) {
    console.log(`${C.yellow}Furigana leaked in ${leaks.length} run(s): ${leaks.map(r => r.file).join(', ')}${C.reset}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: args.engine,
    counts,
    meanSimilarity: avgSim,
    emptyOutput: emptyCount,
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
