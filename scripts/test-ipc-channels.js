/**
 * IPC-channel and i18n-parity bench — Node-only, no Electron, no
 * TextractorCLI, no filesystem writes. Reads the actual source files as
 * text and checks two static invariants that have both already caused a
 * real bug in this project:
 *
 *   1. ALLOWLIST COMPLETENESS: every channel `windowManager.sendToMainWindow`
 *      is called with anywhere under src/ must be present in
 *      src/preload/main-preload.js's ALLOWED_RECEIVE_CHANNELS. `secureOn`
 *      silently drops any channel not in that Set — no error, no log, the
 *      renderer listener just never fires. Confirmed real, not
 *      hypothetical: 'textractor-cli-pid-warning' was emitted by
 *      TextractorLauncher since v3.13.31 but missing from the allowlist
 *      until v3.13.32, so the PID-liveness warning it carries — meant to
 *      stop a stale PID from being mistaken for an architecture mismatch —
 *      never reached the UI in three released versions. This bench is
 *      what would have caught that at the time, and is what stops the next
 *      one from shipping unnoticed the same way.
 *
 *   2. I18N KEY PARITY: every locale in renderer/main/i18n.js has exactly
 *      the same set of keys as `en` (the reference locale) — no fewer, no
 *      extra. A missing key means translateHintKey/t.<key> falls through
 *      to English (or undefined) for that language; an extra key is
 *      harmless but usually means a locale drifted out of sync during a
 *      copy-paste and should be reconciled rather than silently ignored.
 *
 *   3. BADGE STATUS VALUES ARE PAINTABLE (v3.13.39): every status string
 *      deriveBadgeStatus() (src/services/badge-state.js) can return has a
 *      matching `case` in updateConnectionStatus()'s switch
 *      (renderer/main/renderer.js), and every `t.status_*` key that switch
 *      reads exists in the reference locale. Catches the realistic
 *      regression: adding a new derived status without a case (silently
 *      falls to the red "Disconnected" default) or a typo'd i18n key
 *      (silently renders undefined).
 *
 *   4. REPLAYABLE CHANNELS ARE ALLOWLISTED (v3.13.39): every channel in
 *      window-manager.js's REPLAYABLE_CHANNELS is also in
 *      ALLOWED_RECEIVE_CHANNELS. A replay on a non-allowlisted channel is
 *      dropped by secureOn exactly as silently as the original
 *      'textractor-cli-pid-warning' bug case 1 above documents — the
 *      generic allowlist check already covers this in practice (anything
 *      reachable via sendToMainWindow is checked), but this pins the
 *      specific invariant the dom-ready replay depends on.
 *
 *   node scripts/test-ipc-channels.js
 *   node scripts/test-ipc-channels.js --quiet
 *   node scripts/test-ipc-channels.js --json=PATH
 */

const fs = require('fs');
const path = require('path');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[key] = value === undefined ? true : value;
  }
  return args;
}

const ROOT = path.resolve(__dirname, '..');

/**
 * Recursively lists every .js file under `dir`, skipping node_modules and
 * dist — this project has no build step for src/, so "every .js file
 * under src/" is exactly "every file that could call sendToMainWindow".
 */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extracts every literal channel name passed as the first argument to a
 * `sendToMainWindow(...)` call, from any of `.sendToMainWindow(`,
 * `windowManager.sendToMainWindow(`, `this.windowManager.sendToMainWindow(`
 * — i.e. anchored on the method name itself, not a specific receiver, so
 * this doesn't need updating if a new caller accesses windowManager
 * differently. Only matches a STRING LITERAL first argument (single or
 * double quoted) — a dynamically-computed channel name would need a
 * different check and none exist in this codebase today (verified: every
 * real call site uses a literal).
 */
function extractSentChannels(sourceText) {
  const re = /\bsendToMainWindow\(\s*(['"])([^'"]+)\1/g;
  const channels = new Set();
  let m;
  while ((m = re.exec(sourceText)) !== null) {
    channels.add(m[2]);
  }
  return channels;
}

/**
 * Extracts the ALLOWED_RECEIVE_CHANNELS Set literal from main-preload.js's
 * source text — a small hand-rolled parse rather than requiring the file,
 * since main-preload.js runs in Electron's preload context and pulls in
 * `electron` at require-time, which isn't available in this plain-Node
 * bench (same constraint that makes the launcher's own benches read files
 * or fake modules instead of requiring Electron-dependent code directly).
 */
function extractAllowedChannels(sourceText) {
  const anchor = 'ALLOWED_RECEIVE_CHANNELS = new Set([';
  const start = sourceText.indexOf(anchor);
  if (start === -1) {
    throw new Error('Could not find ALLOWED_RECEIVE_CHANNELS in main-preload.js — has it been renamed or restructured?');
  }
  const closeIdx = sourceText.indexOf(']);', start);
  if (closeIdx === -1) {
    throw new Error('Could not find the closing "]);" for ALLOWED_RECEIVE_CHANNELS.');
  }
  let body = sourceText.slice(start + anchor.length, closeIdx);
  // Strip comments before scanning for quoted strings — several entries
  // have an explanatory // comment on the line above them, and an
  // apostrophe inside one of those (e.g. "the renderer's listener") reads
  // as an opening single-quote to a naive scan, silently merging comment
  // prose with the real array entries and corrupting everything after it.
  // Not a full JS parser — safe here because this file is trusted source
  // this project controls, not untrusted input.
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const channels = new Set();
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    channels.add(m[1]);
  }
  return channels;
}

function runAllowlistCheck() {
  const preloadPath = path.join(ROOT, 'src', 'preload', 'main-preload.js');
  const allowed = extractAllowedChannels(fs.readFileSync(preloadPath, 'utf8'));

  const srcDir = path.join(ROOT, 'src');
  const sentByFile = new Map(); // channel -> Set(relative file paths)
  for (const file of listJsFiles(srcDir)) {
    // main-preload.js itself doesn't call sendToMainWindow, and
    // window-manager.js DEFINES the method (its own body isn't a call
    // site) — neither would match the regex anyway, no special-casing
    // needed, just documenting why they're harmlessly included in the
    // file walk.
    const text = fs.readFileSync(file, 'utf8');
    for (const ch of extractSentChannels(text)) {
      if (!sentByFile.has(ch)) sentByFile.set(ch, new Set());
      sentByFile.get(ch).add(path.relative(ROOT, file));
    }
  }

  const missing = [];
  for (const [channel, files] of sentByFile) {
    if (!allowed.has(channel)) {
      missing.push({ channel, files: [...files] });
    }
  }

  return {
    id: 'allowlist-completeness',
    pass: missing.length === 0,
    allowedCount: allowed.size,
    sentChannelCount: sentByFile.size,
    missing
  };
}

function runI18nParityCheck() {
  const i18nPath = path.join(ROOT, 'renderer', 'main', 'i18n.js');
  // Safe to require (not preload/main-only code) — i18n.js is plain data
  // with a Node-compatible module.exports guard already at its end,
  // confirmed by reading it: `if (typeof module !== 'undefined' &&
  // module.exports) { module.exports = translations; }`.
  delete require.cache[require.resolve(i18nPath)];
  const translations = require(i18nPath);

  const locales = Object.keys(translations);
  if (!locales.includes('en')) {
    throw new Error('renderer/main/i18n.js has no "en" locale to use as the parity reference.');
  }
  const referenceKeys = new Set(Object.keys(translations.en));

  const perLocale = [];
  let allOk = true;
  for (const locale of locales) {
    if (locale === 'en') continue;
    const keys = new Set(Object.keys(translations[locale]));
    const missing = [...referenceKeys].filter(k => !keys.has(k)).sort();
    const extra = [...keys].filter(k => !referenceKeys.has(k)).sort();
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) allOk = false;
    perLocale.push({ locale, keyCount: keys.size, missing, extra, ok });
  }

  return {
    id: 'i18n-key-parity',
    pass: allOk,
    referenceLocale: 'en',
    referenceKeyCount: referenceKeys.size,
    localeCount: locales.length,
    perLocale
  };
}

/**
 * v3.13.39: cross-checks deriveBadgeStatus's possible return values against
 * updateConnectionStatus's switch cases, and that switch's t.status_* reads
 * against the reference locale's actual keys.
 */
function runBadgeStatusValuesCheck() {
  const badgeStatePath = path.join(ROOT, 'src', 'services', 'badge-state.js');
  const badgeStateSrc = fs.readFileSync(badgeStatePath, 'utf8');
  const returned = new Set();
  {
    const re = /return\s+'([a-z]+)'/g;
    let m;
    while ((m = re.exec(badgeStateSrc)) !== null) returned.add(m[1]);
  }

  const rendererPath = path.join(ROOT, 'renderer', 'main', 'renderer.js');
  const rendererSrc = fs.readFileSync(rendererPath, 'utf8');
  const switchStart = rendererSrc.indexOf('function updateConnectionStatus(status) {');
  if (switchStart === -1) {
    throw new Error('Could not find updateConnectionStatus(status) in renderer.js — has it been renamed?');
  }
  const switchBodyStart = rendererSrc.indexOf('switch (status) {', switchStart);
  const switchBodyEnd = rendererSrc.indexOf('badge.className', switchBodyStart);
  if (switchBodyStart === -1 || switchBodyEnd === -1) {
    throw new Error('Could not locate updateConnectionStatus\'s switch body — has its structure changed?');
  }
  const switchBody = rendererSrc.slice(switchBodyStart, switchBodyEnd);

  const cased = new Set();
  {
    const re = /case\s+'([a-z]+)':/g;
    let m;
    while ((m = re.exec(switchBody)) !== null) cased.add(m[1]);
  }
  // 'disconnected' is intentionally handled by `default:`, not an explicit
  // case — it's the fallback for both a real disconnected state AND any
  // future status nobody wrote a case for. Only count it as covered if
  // that default branch actually exists (otherwise a switch with no
  // default at all would wrongly pass).
  if (/default:/.test(switchBody)) cased.add('disconnected');

  const readKeys = new Set();
  {
    const re = /t\.(status_[a-zA-Z_]+)/g;
    let m;
    while ((m = re.exec(switchBody)) !== null) readKeys.add(m[1]);
  }

  const i18nPath = path.join(ROOT, 'renderer', 'main', 'i18n.js');
  delete require.cache[require.resolve(i18nPath)];
  const translations = require(i18nPath);
  const enKeys = new Set(Object.keys(translations.en));

  const unpaintable = [...returned].filter((s) => !cased.has(s)).sort();
  const missingI18nKeys = [...readKeys].filter((k) => !enKeys.has(k)).sort();

  return {
    id: 'badge-status-values-are-paintable',
    pass: unpaintable.length === 0 && missingI18nKeys.length === 0,
    returnedByDeriveBadgeStatus: [...returned].sort(),
    casedInUpdateConnectionStatus: [...cased].sort(),
    unpaintable,
    missingI18nKeys
  };
}

/**
 * v3.13.39: every REPLAYABLE_CHANNELS entry (window-manager.js) must be in
 * ALLOWED_RECEIVE_CHANNELS (main-preload.js) — a replay on a channel
 * secureOn drops is silently swallowed, same failure mode as case 1 above.
 */
function runReplayableChannelsCheck() {
  const wmPath = path.join(ROOT, 'src', 'main', 'window-manager.js');
  const wmSrc = fs.readFileSync(wmPath, 'utf8');
  const anchor = 'REPLAYABLE_CHANNELS = new Set([';
  const start = wmSrc.indexOf(anchor);
  if (start === -1) {
    throw new Error('Could not find REPLAYABLE_CHANNELS in window-manager.js — has it been renamed?');
  }
  const closeIdx = wmSrc.indexOf(']);', start);
  const body = wmSrc.slice(start + anchor.length, closeIdx)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const replayable = new Set();
  {
    const re = /['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(body)) !== null) replayable.add(m[1]);
  }

  const preloadPath = path.join(ROOT, 'src', 'preload', 'main-preload.js');
  const allowed = extractAllowedChannels(fs.readFileSync(preloadPath, 'utf8'));

  const missing = [...replayable].filter((ch) => !allowed.has(ch)).sort();

  return {
    id: 'replayable-channels-are-allowlisted',
    pass: missing.length === 0,
    replayable: [...replayable].sort(),
    missing
  };
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const all = [];

  if (!args.only || 'allowlist'.includes(args.only) || 'channels'.includes(args.only)) all.push(runAllowlistCheck());
  if (!args.only || 'i18n'.includes(args.only) || 'parity'.includes(args.only)) all.push(runI18nParityCheck());
  if (!args.only || 'badge'.includes(args.only)) all.push(runBadgeStatusValuesCheck());
  if (!args.only || 'replay'.includes(args.only)) all.push(runReplayableChannelsCheck());

  console.log(`${C.bold}IPC-channel / i18n-parity bench${C.reset} — ${all.length} case(s)\n`);
  let passed = 0;
  for (const r of all) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) {
      passed++;
    } else if (!args.quiet) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === all.length ? C.green : C.red}${passed}/${all.length}${C.reset}`);

  const reportPath = args.json || path.join(__dirname, 'ipc-channels-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results: all }, null, 2));
  console.log(`${C.dim}Report written to ${reportPath}${C.reset}`);

  return passed === all.length ? 0 : 1;
}

process.exit(run());
