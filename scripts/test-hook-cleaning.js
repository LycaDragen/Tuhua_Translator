/**
 * HOOK text-cleaning bench for Tuhua Translator — measures the scattered
 * dedup/cleanup logic that sits between Textractor and the translation
 * pipeline against scripts/hook-cleaning-ground-truth.json.
 *
 * Runs in plain node — no Electron, no network, no API keys. Unlike the OCR
 * and Context Memory benches, ground truth here is EXACT (garbage in, one
 * correct clean string out — no paraphrase, no ambiguity), so scoring is
 * exact string match, not similarity or assertions. Fast enough to run on
 * every change.
 *
 *   node scripts/test-hook-cleaning.js
 *   node scripts/test-hook-cleaning.js --group=3 --quiet
 *   node scripts/test-hook-cleaning.js --only=L11
 *
 * v3.13.20 (Fase 1): now tests the REAL production modules directly —
 * src/services/text-cleaning.js (the consolidated dedup pipeline),
 * src/services/textractor-launcher.js's _cleanGameText (launcher-specific
 * framing + delegates to text-cleaning.js), and src/services/textractor.js's
 * _stripHookPrefix. None of the three need Electron to construct, so this
 * runs in plain node. Before Fase 1, this bench ran against
 * scripts/lib/hook-cleaning-snapshot.js, a verbatim port of the
 * then-scattered/duplicated cleaning code — that file is kept as a frozen
 * historical record of pre-Fase-1 behavior (every function in it was
 * cross-checked byte-for-byte against the real classes at the time) but is
 * no longer used by this bench.
 *
 * Composes two routes exactly as production wires them:
 *   - tcp:      stripHookPrefix -> text-cleaning.js's cleanHookText
 *   - launcher: _cleanGameText (framing + delegates to the same
 *               cleanHookText internally) -> cleanHookText again in
 *               _handleText. This double application is intentional, not
 *               a bug: cleanHookText is confirmed idempotent (see the
 *               plan's Fase 1 section), so calling it twice on
 *               launcher-sourced text is harmless — simpler than trying to
 *               track which route already cleaned a given string.
 *
 * A few rows are EXPECTED to fail today, by design — this bench measures a
 * known-incomplete system, it doesn't pretend everything is solved yet:
 *   - Group 1: L10, L11, L12 (Luna's #10-#12 patterns — L11/L12 confirmed
 *     dead code, not just missing; L10 never implemented — Fase 3 work)
 *   - Group 1: L9_latin_gap, Group 3: G3b (cjkOnly restriction — deliberate
 *     default, a Fase 3 decision gated on the regression bench, not a bug)
 *   - Group 2: G2_scream_single (a narrower, separate, undecided bug in
 *     _stripHookPrefix treating any all-hex-alphabet line as noise — see
 *     the plan's Fase 0 section; deliberately not fixed by this consolidation)
 * A bench that started fully green here would prove nothing was measured.
 *
 * Flags:
 *   --group=N     Only run entries in group N (1, 2, or 3)
 *   --only=TEXT   Substring filter on entry id
 *   --json=PATH   Report output path (default scripts/hook-cleaning-report.json)
 *   --quiet       Suppress per-entry detail, print summary only
 */

const fs = require('fs');
const path = require('path');

const textCleaning = require('../src/services/text-cleaning');
const Textractor = require('../src/services/textractor');
const TextractorLauncher = require('../src/services/textractor-launcher');

// Neither class needs Electron to construct — both are plain EventEmitters
// with no Electron imports at module load time (verified: this bench would
// throw at require() time otherwise, and it doesn't).
const textractorInstance = new Textractor();
const launcherInstance = new TextractorLauncher();

const GROUND_TRUTH = path.join(__dirname, 'hook-cleaning-ground-truth.json');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { json: path.join(__dirname, 'hook-cleaning-report.json') };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (value === undefined) args[key] = true;
    else args[key] = value;
  }
  return args;
}

// ─── Running one entry through both routes ──────────────────────────────────

function runEntry(entry) {
  // TCP route: stripHookPrefix -> cleanHookText (mirrors _handleText, which
  // has no other TCP-specific step before calling the consolidated cleaner).
  const tcpInput = entry.hookPrefixed ? entry.input : '[0x1:1:T] ' + entry.input;
  const tcpStripped = textractorInstance._stripHookPrefix(tcpInput);
  const tcpOutput = tcpStripped === null ? null : textCleaning.cleanHookText(tcpStripped);

  // Launcher route: _cleanGameText (framing + cleanHookText internally),
  // then cleanHookText AGAIN — mirrors _handleText running on whatever the
  // launcher emitted. Intentional double call, not a mistake: see the
  // idempotence note in this file's header comment.
  const launcherInput = entry.hookPrefixed
    ? entry.input.replace(/^\[0x[0-9A-Fa-f]+:\d+:[^\]]*\]\s*/, '')
    : entry.input;
  const launcherEmitted = launcherInstance._cleanGameText(launcherInput);
  const launcherOutput = textCleaning.cleanHookText(launcherEmitted);

  return {
    id: entry.id,
    group: entry.group,
    input: entry.input,
    expected: entry.expected,
    appliesTo: entry.appliesTo,
    note: entry.note,
    tcp: { output: tcpOutput, pass: tcpOutput === entry.expected },
    launcher: { output: launcherOutput, pass: launcherOutput === entry.expected },
    routesAgree: tcpOutput === launcherOutput
  };
}

// ─── Printing ────────────────────────────────────────────────────────────────

function printEntry(r) {
  const mark = (pass) => pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
  const agree = r.routesAgree ? '' : `  ${C.yellow}(routes disagree)${C.reset}`;
  console.log(`${C.bold}[G${r.group}] ${r.id}${C.reset}  tcp=${mark(r.tcp.pass)}  launcher=${mark(r.launcher.pass)}${agree}`);
  console.log(`      input:    ${C.dim}${JSON.stringify(r.input)}${C.reset}`);
  console.log(`      expected: ${JSON.stringify(r.expected)}`);
  if (!r.tcp.pass) console.log(`      tcp ->      ${C.red}${JSON.stringify(r.tcp.output)}${C.reset}`);
  if (!r.launcher.pass) console.log(`      launcher -> ${C.red}${JSON.stringify(r.launcher.output)}${C.reset}`);
}

function printGroupSummary(groupNum, results) {
  const tcpPass = results.filter(r => r.tcp.pass).length;
  const launcherPass = results.filter(r => r.launcher.pass).length;
  const total = results.length;
  const color = (n) => n === total ? C.green : (n === 0 ? C.red : C.yellow);
  console.log(`${C.bold}Group ${groupNum}${C.reset}  tcp: ${color(tcpPass)}${tcpPass}/${total}${C.reset}  launcher: ${color(launcherPass)}${launcherPass}/${total}${C.reset}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run() {
  const args = parseArgs(process.argv.slice(2));
  const groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));

  let entries = groundTruth.entries;
  if (args.group !== undefined) {
    const g = parseInt(args.group, 10);
    entries = entries.filter(e => e.group === g);
  }
  if (args.only) {
    entries = entries.filter(e => e.id.includes(args.only));
  }
  if (entries.length === 0) {
    console.error(`${C.red}No entries matched the given filters.${C.reset}`);
    return 1;
  }

  console.log(`${C.bold}HOOK text-cleaning bench${C.reset} — ${entries.length} entries, exact match, both routes\n`);

  const results = entries.map(runEntry);
  if (!args.quiet) {
    for (const r of results) printEntry(r);
    console.log('');
  }

  console.log(`${C.bold}${'─'.repeat(64)}${C.reset}`);
  for (const groupNum of [1, 2, 3]) {
    const groupResults = results.filter(r => r.group === groupNum);
    if (groupResults.length > 0) printGroupSummary(groupNum, groupResults);
  }

  const tcpTotal = results.filter(r => r.tcp.pass).length;
  const launcherTotal = results.filter(r => r.launcher.pass).length;
  const disagreements = results.filter(r => !r.routesAgree);

  console.log(`${C.bold}Overall${C.reset}  tcp: ${tcpTotal}/${results.length}  launcher: ${launcherTotal}/${results.length}`);
  if (disagreements.length > 0) {
    console.log(`${C.yellow}${disagreements.length} entr${disagreements.length === 1 ? 'y' : 'ies'} where tcp and launcher disagree with each other: ${disagreements.map(r => r.id).join(', ')}${C.reset}`);
    console.log(`${C.dim}This is the direct measurement of route inconsistency — after Fase 1's consolidation, this list should be empty except by explicit, documented design (e.g. a route that genuinely can't apply a given step).${C.reset}`);
  } else {
    console.log(`${C.green}tcp and launcher produce identical output on every entry — routes are consistent.${C.reset}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    filters: { group: args.group || null, only: args.only || null },
    groupSummaries: [1, 2, 3].map(g => {
      const gr = results.filter(r => r.group === g);
      return gr.length ? {
        group: g,
        tcpPass: gr.filter(r => r.tcp.pass).length,
        launcherPass: gr.filter(r => r.launcher.pass).length,
        total: gr.length
      } : null;
    }).filter(Boolean),
    tcpPass: tcpTotal,
    launcherPass: launcherTotal,
    total: results.length,
    routeDisagreements: disagreements.map(r => r.id),
    results
  };
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\n${C.dim}Report written to ${args.json}${C.reset}`);

  return 0;
}

process.exit(run());
