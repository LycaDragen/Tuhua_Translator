/**
 * stdout DECODING bench for Tuhua Translator — measures
 * TextractorLauncher._processStdoutData() against
 * scripts/stdout-decoding-ground-truth.json.
 *
 * Runs in plain node — no Electron, no network, no API keys, no real
 * TextractorCLI process. Unlike scripts/test-hook-cleaning.js (which
 * measures text CLEANING judgment calls, some rows red on purpose), this
 * bench asserts DECODING IDENTITY: encode a reference line to known raw
 * bytes, feed those bytes to the real _processStdoutData() method split at
 * every possible chunk boundary, and the lines the launcher emits via its
 * 'output' event must equal the originals EXACTLY. Any mismatch is a
 * decoder bug, full stop — there is no ambiguity to score.
 *
 * Root cause this exists to pin down (see the ground truth file's _meta
 * for the full chain): a first stdout chunk of 1 or 3 raw bytes defeats
 * the `data.length >= 4` gate the old decoder used to decide encoding, so
 * that chunk decodes as the wrong default AND drops its trailing odd byte
 * — desyncing every chunk after it, including the one the detector
 * finally samples, locking the whole session to the wrong encoding.
 * _sanitizeLine then strips the resulting null bytes, so ASCII survives
 * perfectly while Japanese decodes to private-use-area garbage in the
 * SAME string — exactly the reported symptom.
 *
 *   node scripts/test-stdout-decoding.js
 *   node scripts/test-stdout-decoding.js --group=2 --quiet
 *   node scripts/test-stdout-decoding.js --only=S3_jp_first
 *   node scripts/test-stdout-decoding.js --mode=tiny
 *   node scripts/test-stdout-decoding.js --max-splits=200
 *   node scripts/test-stdout-decoding.js --json=PATH
 *
 * Modes fed to each stream (see MODES below for exactly how each builds
 * its chunk boundaries):
 *   whole    one case: the entire stream in a single chunk (sanity baseline)
 *   tiny     first chunk of 1, 2, then 3 bytes, rest in one following chunk
 *            — the direct repro of the confirmed bug above
 *   bytes    one case: every byte delivered as its own 1-byte chunk —
 *            defeats any `data.length >= N` gate entirely
 *   splits   exhaustive: one case per possible 2-way split offset
 *   hostile  same offsets as splits, but each chunk is handed over as a
 *            freshly allocated Buffer that gets poison-filled (0xFF)
 *            immediately after being passed to _processStdoutData —
 *            simulates a stream implementation that reuses its read
 *            buffer between 'data' events. A decoder that retains a VIEW
 *            into the chunk it was given (as the old _rawByteCarry did,
 *            via Buffer#subarray) fails every odd offset here even though
 *            Node 20/Linux measured 0 such reuses in practice — the
 *            pattern was unsafe regardless of whether it had fired yet.
 *   random   5 deterministic pseudo-random chunkings (fixed seeds 1-5, via
 *            a small inline PRNG) — cheap extra coverage of boundary
 *            combinations the exhaustive modes above don't hit directly
 *            (three or more chunks in a single stream).
 *
 * Streams with `expectEncodingWarning` (the UTF-16BE cases) assert that an
 * 'encoding-warning' event fires with that encoding, not that the text
 * decodes correctly — Node has no built-in UTF-16BE decoder, and
 * Textractor never emits BE in practice, so a positive detection here is
 * meant to surface as a symptom of something else being wrong upstream,
 * not to produce clean text.
 *
 * A note on baselines: this bench is designed to run UNCHANGED against
 * the code both before and after the Fase 2 fix (see the plan). Before
 * the fix it MUST fail on: tiny (offsets 1 and 3), bytes, hostile (every
 * odd offset), S3_jp_first (no-ASCII-header Japanese), S10_subminimum_sniff
 * (nothing calls a flush path yet), and both S8/S9 UTF-16BE cases (the
 * encoding-warning event doesn't exist yet). If a fresh checkout comes up
 * all-green before any Fase 2 code has been written, the bench itself is
 * broken, not the (unfixed) decoder — see --json baseline capture below.
 */

const fs = require('fs');
const path = require('path');

const TextractorLauncher = require('../src/services/textractor-launcher');

const GROUND_TRUTH = path.join(__dirname, 'stdout-decoding-ground-truth.json');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    json: path.join(__dirname, 'stdout-decoding-report.json'),
    maxSplits: Infinity
  };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (value === undefined) args[key] = true;
    else args[key] = value;
  }
  if (args['max-splits'] !== undefined) args.maxSplits = parseInt(args['max-splits'], 10);
  return args;
}

// ─── Deterministic PRNG for the 'random' mode ───────────────────────────────
// mulberry32 — tiny, dependency-free, fully deterministic from an integer
// seed so any failure is reproducible by re-running with the same seed
// printed in the failure detail.

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRanges(len, seed) {
  const rng = mulberry32(seed);
  const numCuts = Math.max(1, Math.floor(len / 5));
  const cutSet = new Set([0, len]);
  for (let i = 0; i < numCuts; i++) cutSet.add(1 + Math.floor(rng() * (len - 1)));
  const cuts = Array.from(cutSet).sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i] !== cuts[i + 1]) ranges.push([cuts[i], cuts[i + 1]]);
  }
  return ranges;
}

// ─── Chunk-boundary generators ──────────────────────────────────────────────
// Each yields { label, ranges } — one test case per yield, `ranges` being
// the full list of [start, end) byte ranges that together cover the buffer.

function* rangeCases(mode, len, maxSplits) {
  if (len === 0) return;
  if (mode === 'whole') {
    yield { label: 'whole', ranges: [[0, len]] };
    return;
  }
  if (mode === 'bytes') {
    yield { label: 'bytes', ranges: Array.from({ length: len }, (_, i) => [i, i + 1]) };
    return;
  }
  if (mode === 'tiny') {
    for (const k of [1, 2, 3]) {
      if (k < len) yield { label: `tiny${k}`, ranges: [[0, k], [k, len]] };
    }
    return;
  }
  if (mode === 'splits' || mode === 'hostile') {
    const n = len - 1; // number of possible 2-way split points
    if (n <= 0) return;
    const step = (Number.isFinite(maxSplits) && n > maxSplits) ? Math.ceil(n / maxSplits) : 1;
    for (let i = 0; i < n; i += step) {
      yield { label: `${mode}@${i + 1}`, ranges: [[0, i + 1], [i + 1, len]] };
    }
    return;
  }
  if (mode === 'random') {
    for (let seed = 1; seed <= 5; seed++) {
      yield { label: `random#${seed}`, ranges: randomRanges(len, seed) };
    }
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

const ALL_MODES = ['whole', 'tiny', 'bytes', 'splits', 'hostile', 'random'];

// ─── Building raw stream bytes from ground truth ────────────────────────────

function buildStreamBytes(streamDef, linesById) {
  const text = streamDef.lines.map(id => linesById[id].text).join('\n') + '\n';

  let body;
  if (streamDef.encoding === 'utf16be') {
    // Node has no native utf16be encoder — build LE then swap byte pairs.
    const le = Buffer.from(text, 'utf16le');
    body = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      body[i] = le[i + 1];
      body[i + 1] = le[i];
    }
  } else {
    body = Buffer.from(text, streamDef.encoding);
  }

  let bom = Buffer.alloc(0);
  if (streamDef.bom) {
    if (streamDef.encoding === 'utf16le') bom = Buffer.from([0xFF, 0xFE]);
    else if (streamDef.encoding === 'utf16be') bom = Buffer.from([0xFE, 0xFF]);
    else if (streamDef.encoding === 'utf8') bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  }

  return {
    buf: Buffer.concat([bom, body]),
    expectedLines: streamDef.lines.map(id => linesById[id].text)
  };
}

// ─── Feeders ─────────────────────────────────────────────────────────────────

function feedPlain(launcher, buf, ranges) {
  for (const [s, e] of ranges) {
    launcher._processStdoutData(buf.subarray(s, e));
  }
}

// Hands each chunk over as a freshly allocated Buffer, then immediately
// poison-fills it (0xFF) — simulating a stream implementation that reuses
// its read buffer between 'data' events. Any decoder holding a VIEW into
// the chunk it was given (rather than copying it) fails deterministically
// here, regardless of whether the platform it's actually running on
// happens to reuse buffers today.
function feedHostile(launcher, buf, ranges) {
  for (const [s, e] of ranges) {
    const copy = Buffer.from(buf.subarray(s, e));
    launcher._processStdoutData(copy);
    copy.fill(0xFF);
  }
}

// ─── Console silencing (the launcher logs per line; fuzzing is thousands
// of cases) ───────────────────────────────────────────────────────────────

function silence(fn) {
  const savedLog = console.log;
  const savedWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = savedLog;
    console.warn = savedWarn;
  }
}

// ─── Reset between cases ─────────────────────────────────────────────────────
// Prefers _resetStreamState() (the Fase 2 refactor's single source of
// truth) when present, falls back to the pre-fix field set otherwise — so
// this same bench runs unmodified against both the baseline and the fix.

function resetLauncherForCase(launcher) {
  if (typeof launcher._resetStreamState === 'function') {
    launcher._resetStreamState();
  } else {
    launcher._stdoutBuffer = '';
    launcher._detectedEncoding = null;
    launcher._rawByteCarry = null;
    launcher._lastTextHash = '';
    launcher._dataEventCount = 0;
    launcher._hexDumpCount = 0;
  }
  launcher._hooks.clear();
  launcher._selectedHookKey = null;
  launcher._autoSelectedHookKey = null;
  launcher._hookDiscoveryPhase = false;
  launcher._totalLinesProcessed = 0;
  launcher._hookLinesProcessed = 0;
  if (typeof launcher._clearTimers === 'function') launcher._clearTimers();
}

// Detects the PUA (Private Use Area) or replacement-character corruption
// signature this whole bench exists to catch. Written as a codepoint scan
// rather than a regex literal to avoid escape-mangling ambiguity in source
// (BMP PUA: E000-F8FF; replacement char FFFD; the two supplementary PUA
// planes: F0000-FFFFD and 100000-10FFFD).
function containsPuaOrReplacement(str) {
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === 0xFFFD) return true;
    if (cp >= 0xE000 && cp <= 0xF8FF) return true;
    if (cp >= 0xF0000 && cp <= 0xFFFFD) return true;
    if (cp >= 0x100000 && cp <= 0x10FFFD) return true;
  }
  return false;
}

// ─── Running one case ────────────────────────────────────────────────────────

function runCase(launcher, streamDef, linesById, mode, rc) {
  resetLauncherForCase(launcher);

  const got = [];
  let warning = null;
  let detectedEncoding = null;
  const onOutput = (l) => got.push(l);
  const onWarning = (w) => { warning = w; };
  // Listening for 'encoding-detected' rather than reading launcher._detectedEncoding
  // directly: _flushStdout (post-fix) resets that field back to null as its
  // last step, so a field read after a flush-driven decision (the
  // sub-minimum-sniff case) can't observe what was decided — the event
  // fires at the moment of decision regardless of what happens after.
  const onDetected = (d) => { detectedEncoding = d.encoding; };
  launcher.on('output', onOutput);
  launcher.on('encoding-warning', onWarning);
  launcher.on('encoding-detected', onDetected);

  const { buf, expectedLines } = buildStreamBytes(streamDef, linesById);
  const feeder = mode === 'hostile' ? feedHostile : feedPlain;

  silence(() => {
    feeder(launcher, buf, rc.ranges);
    if (typeof launcher._flushStdout === 'function') launcher._flushStdout('bench');
  });

  launcher.removeListener('output', onOutput);
  launcher.removeListener('encoding-warning', onWarning);
  launcher.removeListener('encoding-detected', onDetected);

  // Fallback for the pre-fix baseline run, which has no 'encoding-detected'
  // event at all — read the field directly (best-effort; may be stale on
  // that code path, but that code path also has no flush to go stale from).
  if (detectedEncoding === null && typeof launcher._resetStreamState !== 'function') {
    detectedEncoding = launcher._detectedEncoding;
  }

  if (streamDef.expectEncodingWarning) {
    const pass = !!warning && warning.encoding === streamDef.expectEncodingWarning;
    return { pass, kind: 'warning', warning, detectedEncoding };
  }

  const linesMatch = got.length === expectedLines.length && got.every((l, i) => l === expectedLines[i]);
  const noPua = got.every(l => !containsPuaOrReplacement(l));
  const encodingMatch = !streamDef.expectEncoding || detectedEncoding === streamDef.expectEncoding;
  const pass = linesMatch && noPua && encodingMatch;

  return { pass, kind: 'lines', got, expectedLines, linesMatch, noPua, encodingMatch, detectedEncoding };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run() {
  const args = parseArgs(process.argv.slice(2));
  const groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));

  const linesById = {};
  for (const l of groundTruth.lines) linesById[l.id] = l;

  let streams = groundTruth.streams;
  if (args.group !== undefined) {
    const g = parseInt(args.group, 10);
    streams = streams.filter(s => s.group === g);
  }
  if (args.only) {
    streams = streams.filter(s => s.id.includes(args.only));
  }
  const modes = args.mode ? [args.mode] : ALL_MODES;

  if (streams.length === 0) {
    console.error(`${C.red}No streams matched the given filters.${C.reset}`);
    return 1;
  }

  console.log(`${C.bold}stdout decoding bench${C.reset} — ${streams.length} stream(s) × modes [${modes.join(', ')}]\n`);

  const launcher = new TextractorLauncher();
  const streamResults = [];

  for (const streamDef of streams) {
    const caseResults = [];
    for (const mode of modes) {
      const { buf } = buildStreamBytes(streamDef, linesById);
      for (const rc of rangeCases(mode, buf.length, args.maxSplits)) {
        const result = runCase(launcher, streamDef, linesById, mode, rc);
        caseResults.push({ mode, label: rc.label, ...result });
      }
    }

    const total = caseResults.length;
    const passed = caseResults.filter(r => r.pass).length;
    const failed = caseResults.filter(r => !r.pass);
    streamResults.push({ id: streamDef.id, group: streamDef.group, note: streamDef.note, total, passed, failed });

    if (!args.quiet) {
      const color = passed === total ? C.green : (passed === 0 ? C.red : C.yellow);
      console.log(`${C.bold}[G${streamDef.group}] ${streamDef.id}${C.reset}  ${color}${passed}/${total}${C.reset}`);
      if (failed.length > 0) {
        // Show at most 5 distinct failure shapes per stream to keep output readable
        const byModeSample = new Map();
        for (const f of failed) {
          if (!byModeSample.has(f.mode)) byModeSample.set(f.mode, f);
        }
        for (const f of byModeSample.values()) {
          if (f.kind === 'warning') {
            console.log(`      ${C.red}${f.mode}${C.reset} (${f.label}): expected encoding-warning(${streamDef.expectEncodingWarning}), got ${f.warning ? JSON.stringify(f.warning) : 'none'}`);
          } else {
            console.log(`      ${C.red}${f.mode}${C.reset} (${f.label}): detected=${f.detectedEncoding} linesMatch=${f.linesMatch} noPua=${f.noPua}`);
            if (!f.linesMatch) console.log(`        ${C.dim}got:      ${JSON.stringify(f.got)}${C.reset}`);
            if (!f.linesMatch) console.log(`        ${C.dim}expected: ${JSON.stringify(f.expectedLines)}${C.reset}`);
          }
        }
        const modesFailing = new Set(failed.map(f => f.mode));
        console.log(`      ${C.dim}${failed.length}/${total} cases failed, across modes: ${Array.from(modesFailing).join(', ')}${C.reset}`);
      }
    }
  }

  console.log(`\n${C.bold}${'─'.repeat(64)}${C.reset}`);
  let grandTotal = 0, grandPassed = 0;
  for (const g of [1, 2, 3, 4]) {
    const gr = streamResults.filter(r => r.group === g);
    if (gr.length === 0) continue;
    const total = gr.reduce((a, r) => a + r.total, 0);
    const passed = gr.reduce((a, r) => a + r.passed, 0);
    grandTotal += total; grandPassed += passed;
    const color = passed === total ? C.green : (passed === 0 ? C.red : C.yellow);
    console.log(`${C.bold}Group ${g}${C.reset}  ${color}${passed}/${total}${C.reset}`);
  }

  const overallColor = grandPassed === grandTotal ? C.green : (grandPassed === 0 ? C.red : C.yellow);
  console.log(`${C.bold}Overall${C.reset}  ${overallColor}${grandPassed}/${grandTotal}${C.reset}`);

  const report = {
    generatedAt: new Date().toISOString(),
    filters: { group: args.group || null, only: args.only || null, mode: args.mode || null, maxSplits: Number.isFinite(args.maxSplits) ? args.maxSplits : null },
    streams: streamResults.map(r => ({
      id: r.id, group: r.group, total: r.total, passed: r.passed,
      failingModes: Array.from(new Set(r.failed.map(f => f.mode)))
    })),
    total: grandTotal,
    passed: grandPassed
  };
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\n${C.dim}Report written to ${args.json}${C.reset}`);

  return grandPassed === grandTotal ? 0 : 1;
}

process.exit(run());
