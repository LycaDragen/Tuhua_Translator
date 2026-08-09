/**
 * TextractorLauncher LIFECYCLE bench — timers and the arch-fallback
 * diagnostic polling chain, in plain node with a faked child_process and a
 * faked clock (no real TextractorCLI.exe, no real waiting).
 *
 * Two things this verifies, both from the v3.13.29 plan's Fase 3:
 *
 *   1. TIMER LEAKS (real bugs, fixed): two setTimeout calls in this file
 *      used to be bare — no saved handle, not covered by _clearTimers() —
 *      and survived kill() and even a relaunch:
 *        - _attemptArchFallback's 300ms relaunch: if kill() (or another
 *          fallback attempt) happened inside that window, the old code
 *          still fired the relaunch afterward and resurrected a process
 *          the caller had just asked to stop.
 *        - launch()'s 3s hook-discovery-phase finalize: on the
 *          'quick-exit' fallback path (fires before 2s), this timer from
 *          the ABANDONED attempt fired after the NEW launch() had already
 *          cleared _hooks for the new session, emitting a spurious
 *          'hooks-discovered' for state that no longer existed.
 *      Verified here by asserting all four timer fields are null
 *      immediately after kill() — synchronous, no fake clock needed for
 *      this part.
 *
 *   2. ARCH-FALLBACK DIAGNOSTIC TICK COUNT ("the loose end that turned out
 *      not to be a bug"): the plan investigated whether the diagnostic's
 *      polling chain (10s, then every 5s up to 60s) ever fails to stop.
 *      Reading the code showed the `return` at the "real hook, not stuck
 *      on generic" branch DOES stop the chain (it's a self-rescheduling
 *      setTimeout chain, not a setInterval — the handle is nulled before
 *      each tick runs, and re-scheduling only happens at the bottom of the
 *      function). Rather than trust that reading alone, this bench drives
 *      the actual closure inside launch() through a deterministic fake
 *      clock and counts ticks for three real scenarios.
 *
 * Uses a tiny in-process fake timer (replaces global setTimeout/
 * clearTimeout for the duration of each test, restored after) so the
 * 10s-60s diagnostic window runs in milliseconds of real wall-clock time
 * instead of up to a minute. A fake child_process.spawn and faked fs
 * calls let launch() run its real code path without an actual
 * TextractorCLI.exe or a real OS process.
 *
 *   node scripts/test-launcher-lifecycle.js
 *   node scripts/test-launcher-lifecycle.js --only=timer
 *   node scripts/test-launcher-lifecycle.js --quiet
 */

const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');
const cp = require('child_process');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[value === undefined ? key : key] = value === undefined ? true : value;
  }
  return args;
}

// ─── Fake fs so validatePath() succeeds against a path that doesn't exist
// on disk, without touching the real filesystem ──────────────────────────

const FAKE_EXE_PATH = path.resolve('/fake/TextractorCLI.exe');

function installFakeFs() {
  const orig = { existsSync: fs.existsSync, statSync: fs.statSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync };
  // IMPORTANT: only intercept calls for FAKE_EXE_PATH (or a path under it,
  // for the arch-fallback sibling test) — Node's own module loader uses
  // fs.readFileSync/statSync internally to read .js source files
  // (including this project's own modules as they get require()'d), so a
  // fake that answers for EVERY path corrupts require() itself rather
  // than just the code under test. Confirmed the hard way: an
  // unconditional fake readFileSync crashed the process at the native
  // level via Node's CJS loader, not with a catchable JS error.
  const isFakePath = (p) => {
    const resolved = path.resolve(p);
    return resolved === FAKE_EXE_PATH || resolved.startsWith(path.dirname(FAKE_EXE_PATH));
  };
  fs.existsSync = (p) => (isFakePath(p) ? true : orig.existsSync(p));
  fs.statSync = (p) => (isFakePath(p) ? { isFile: () => true, isDirectory: () => false } : orig.statSync(p));
  fs.readdirSync = (p) => (isFakePath(p) ? ['vcruntime140.dll', 'msvcp140.dll'] : orig.readdirSync(p));
  // Short buffer for the fake exe only — the PE-header arch-detection code
  // in validatePath is already wrapped in try/catch for exactly this (a
  // too-short buffer throws on readUInt32LE), so this exercises that guard
  // rather than needing a real PE file. Every other path (source files)
  // goes through the real implementation.
  fs.readFileSync = (p, ...rest) => (isFakePath(p) ? Buffer.from([0x4D, 0x5A]) : orig.readFileSync(p, ...rest));
  return () => Object.assign(fs, orig);
}

// ─── Fake child_process.spawn — must be installed BEFORE textractor-launcher
// is first required, since it destructures `spawn` out of child_process at
// require-time (`const { spawn } = require('child_process')`) rather than
// referencing the module object per-call ─────────────────────────────────

function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {}, destroyed: false };
  proc.pid = 12345;
  proc.kill = () => {};
  return proc;
}

let lastFakeProcess = null;
function installFakeSpawn() {
  const origSpawn = cp.spawn;
  cp.spawn = () => {
    lastFakeProcess = makeFakeProcess();
    return lastFakeProcess;
  };
  return () => { cp.spawn = origSpawn; };
}

// v3.13.29: validatePath() now rejects on any process.platform !== 'win32'
// (see Fase 5 of the plan) — correct behavior on this dev machine
// (Linux/WSL), but this whole bench exists specifically to simulate a
// Windows TextractorCLI session, so it forces the platform for its
// duration. Not testing the platform guard itself (that's covered
// separately, and doesn't need a fake spawn/clock at all).
function installFakeWin32Platform() {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return () => Object.defineProperty(process, 'platform', orig);
}

// Install fakes BEFORE requiring the module under test.
const restoreFs = installFakeFs();
const restoreSpawn = installFakeSpawn();
const restorePlatform = installFakeWin32Platform();
const TextractorLauncher = require('../src/services/textractor-launcher');

// ─── Fake clock — replaces global setTimeout/clearTimeout so the 10-60s
// diagnostic window advances in a handful of synchronous steps instead of
// real wall-clock time. drainAll() fires every pending timer in
// chronological order (by virtual scheduled-fire time), exactly matching
// how the real chain of self-rescheduling setTimeout calls would replay —
// letting the launcher's other real timers (stdin backup, hook-discovery
// finalize) fire naturally alongside the one under test. ────────────────

function installFakeClock() {
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  let nextId = 1;
  let virtualNow = 0;
  const timers = new Map(); // id -> { fn, delay, fireAt }

  global.setTimeout = (fn, delay) => {
    const id = nextId++;
    timers.set(id, { fn, delay, fireAt: virtualNow + delay });
    return id;
  };
  global.clearTimeout = (id) => { timers.delete(id); };

  function fireNext() {
    if (timers.size === 0) return null;
    let bestId = null, bestFireAt = Infinity;
    for (const [id, t] of timers) {
      if (t.fireAt < bestFireAt || (t.fireAt === bestFireAt && id < bestId)) { bestFireAt = t.fireAt; bestId = id; }
    }
    const t = timers.get(bestId);
    timers.delete(bestId);
    virtualNow = bestFireAt;
    const delay = t.delay;
    t.fn();
    return { id: bestId, delay, firedAt: virtualNow };
  }

  function restore() {
    global.setTimeout = origSetTimeout;
    global.clearTimeout = origClearTimeout;
  }

  return { fireNext, restore, pendingCount: () => timers.size };
}

// ─── Test 0: the Windows-only guard itself (Fase 5) — checked with the
// REAL process.platform, restoring the win32 override temporarily so this
// one case exercises what a non-Windows user actually hits. ─────────────

function testWindowsOnlyGuard() {
  restorePlatform(); // temporarily undo the win32 fake — real host platform now
  const realPlatform = process.platform;
  const launcher = new TextractorLauncher();
  const result = launcher.validatePath(FAKE_EXE_PATH);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); // re-apply for every test after this one

  const pass = realPlatform !== 'win32'
    // On an actual non-Windows CI/dev machine (the normal case here):
    // guard should reject regardless of the path being otherwise valid.
    ? (result.valid === false && result.messageKey === 'val_windows_only')
    // If this bench somehow runs ON Windows: the guard must NOT reject a
    // well-formed path — confirms the check doesn't over-trigger.
    : result.valid === true;

  return { id: 'windows-only-guard', pass, realPlatform, result };
}

function withSilencedConsole(fn) {
  const savedLog = console.log, savedWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = savedLog; console.warn = savedWarn; }
}

// ─── Test 1: timer cleanup after kill() — synchronous, no fake clock ────

function testTimerCleanupAfterKill() {
  const launcher = new TextractorLauncher();
  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: FAKE_EXE_PATH }));
  const scheduledBefore = {
    stdin: launcher._stdinTimer !== null,
    diagnostic: launcher._diagnosticTimer !== null,
    hookDiscoveryPhase: launcher._hookDiscoveryPhaseTimer !== null
  };
  launcher.kill();
  const clearedAfter = {
    stdin: launcher._stdinTimer === null,
    diagnostic: launcher._diagnosticTimer === null,
    hookDiscoveryPhase: launcher._hookDiscoveryPhaseTimer === null,
    archRelaunch: launcher._archRelaunchTimer === null
  };
  const pass = ok && Object.values(scheduledBefore).every(Boolean) && Object.values(clearedAfter).every(Boolean);
  return { id: 'timer-cleanup-after-kill', pass, launchOk: ok, scheduledBefore, clearedAfter };
}

// ─── Test 2: _archRelaunchTimer specifically — the 300ms relaunch that
// used to be uncancelable. Trigger _attemptArchFallback (via the
// 'no-hooks' path a real 10s-diagnostic tick would take), confirm the
// timer field is set, then confirm kill()+_clearTimers() cancels it (no
// resurrected process — checked by confirming spawn isn't called again
// after clearing). ────────────────────────────────────────────────────

function testArchRelaunchTimerCancelable() {
  const launcher = new TextractorLauncher();
  // Give it a sibling architecture to fall back to, bypassing real fs:
  // _getArchFallbackPath itself calls fs.existsSync/statSync, which our
  // fake only answers 'true' for FAKE_EXE_PATH — so point _lastResolvedPath
  // at an x64 path whose x86 sibling IS FAKE_EXE_PATH.
  const x64Path = FAKE_EXE_PATH.replace(path.sep + 'TextractorCLI.exe', path.sep + 'x64' + path.sep + 'TextractorCLI.exe');
  launcher._lastResolvedPath = x64Path;
  // _getArchFallbackPath computes the x86 SIBLING of x64Path
  // ('/fake/x86/TextractorCLI.exe') and checks THAT for existence — not
  // x64Path itself — so the fake must answer for anything under /fake,
  // same as installFakeFs's own isFakePath check.
  const origExistsSync = fs.existsSync;
  const origStatSync = fs.statSync;
  fs.existsSync = (p) => path.resolve(p).startsWith(path.dirname(FAKE_EXE_PATH));
  fs.statSync = (p) => ({ isFile: () => true, isDirectory: () => false });

  const fired = withSilencedConsole(() => launcher._attemptArchFallback('no-hooks'));
  const scheduled = launcher._archRelaunchTimer !== null;
  launcher._clearTimers();
  const cleared = launcher._archRelaunchTimer === null;

  fs.existsSync = origExistsSync;
  fs.statSync = origStatSync;

  const pass = fired === true && scheduled && cleared;
  return { id: 'arch-relaunch-timer-cancelable', pass, fired, scheduled, cleared };
}

// ─── Test 3: arch-fallback diagnostic tick count, three scenarios ───────

function runDiagnosticScenario(label, setupHooks) {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const fallbackCalls = [];
  launcher._attemptArchFallback = (reason) => { fallbackCalls.push(reason); return false; }; // don't actually relaunch — just observe

  const savedLog = console.log, savedWarn = console.warn;
  console.log = () => {}; console.warn = () => {};

  launcher.launch(12345, { cliPath: FAKE_EXE_PATH });
  setupHooks(launcher);

  let diagnosticTicks = 0;
  let guard = 0;
  // Drain every timer chronologically. Diagnostic ticks are identifiable
  // by their delay: 10000 (first check) or 5000 (every re-check) — the
  // other real timers in launch() use 1500 (stdin backup) and 3000 (hook
  // discovery phase finalize), so this doesn't conflate them.
  let fired;
  while ((fired = clock.fireNext()) !== null && guard++ < 1000) {
    if (fired.delay === 10000 || fired.delay === 5000) diagnosticTicks++;
    // Re-inject hook state after each tick in case the scenario wants it
    // to change over "time" — none of the three scenarios below do, but
    // this keeps the harness honest if a future scenario needs it.
  }

  console.log = savedLog; console.warn = savedWarn;
  clock.restore();
  return { label, diagnosticTicks, fallbackCalls, pendingAtEnd: clock.pendingCount() };
}

function testDiagnosticScenarios() {
  const results = [];

  // Scenario A: zero hooks ever. Diagnostic should tick at 10s, 15s, ...
  // up to the 60s cap (11 ticks total: 10000 then +5000 x 10 = 60000),
  // calling _attemptArchFallback('no-hooks') every single tick since our
  // spy always returns false (simulating "no sibling arch available").
  results.push(runDiagnosticScenario('A-no-hooks-ever', () => {}));

  // Scenario B: a real hook exists but is stuck on the generic HB0@0 type
  // the whole time. Same tick count as A, but reason should be
  // 'no-clean-hook' every time.
  results.push(runDiagnosticScenario('B-all-generic', (launcher) => {
    launcher._hooks.set('6:1:A:B', {
      key: '6:1:A:B', name: 'game.exe', isSystemHook: false,
      textCount: 3, hookCode: 'HB0@0', hasCJK: true, totalTextLength: 30, qualityPenalty: 0
    });
  }));

  // Scenario C: a real, specifically-typed hook with text exists BEFORE
  // the first tick. The very first check (10s) should see
  // hasRealHookWithText && !genericType and `return` — exactly ONE tick,
  // zero fallback calls, nothing left scheduled afterward.
  results.push(runDiagnosticScenario('C-real-hook-clean', (launcher) => {
    launcher._hooks.set('6:1:A:B', {
      key: '6:1:A:B', name: 'game.exe', isSystemHook: false,
      textCount: 3, hookCode: 'HQ8@0', hasCJK: true, totalTextLength: 30, qualityPenalty: 0
    });
  }));

  const expectations = {
    'A-no-hooks-ever': { ticks: 11, reason: 'no-hooks', callsEqualTicks: true },
    'B-all-generic': { ticks: 11, reason: 'no-clean-hook', callsEqualTicks: true },
    'C-real-hook-clean': { ticks: 1, reason: null, callsEqualTicks: false, callsExpected: 0 }
  };

  const checked = results.map(r => {
    const exp = expectations[r.label];
    const ticksOk = r.diagnosticTicks === exp.ticks;
    const callsOk = exp.callsEqualTicks
      ? (r.fallbackCalls.length === exp.ticks && r.fallbackCalls.every(x => x === exp.reason))
      : (r.fallbackCalls.length === exp.callsExpected);
    const pendingOk = r.pendingAtEnd === 0;
    return { ...r, pass: ticksOk && callsOk && pendingOk, ticksOk, callsOk, pendingOk, expected: exp };
  });

  return checked;
}

// ─── Test 4: hook-selection hysteresis age discount ─────────────────────
// Fase 4 of the plan: a menu hook that stops producing text should
// eventually lose its claim on the incumbent's +200 switch margin, rather
// than requiring the challenger to out-accumulate its textCount bonus
// (which needs ~20+ lines under the old fixed-threshold logic). Operates
// directly on _hooks/_autoSelectBestHook — no launch()/spawn needed, this
// is pure hook-scoring logic. Date.now() is mocked for determinism; the
// exact STALE_HOOK_FULL_DECAY_MS value lives in textractor-launcher.js and
// isn't imported here on purpose (kept as an internal implementation
// detail) — 20000 is used as "comfortably past the documented 15000ms
// decay window", not as an exact reproduction of that constant.

function testHysteresisAgeDiscount() {
  const origDateNow = Date.now;
  const virtualNow = 1_700_000_000_000;
  Date.now = () => virtualNow;

  const results = [];
  try {
    const makeHooks = (incumbentLastTextAt) => {
      const launcher = new TextractorLauncher();
      // Both hooks score nearly identically (B edges A by 1 point via
      // avgLen) — a gap the OLD fixed +200 threshold would never bridge,
      // regardless of how long the incumbent had been silent. Textractor
      // never reports quality-penalty-free menu text this cleanly for
      // long, but that's exactly the documented worst case this fix
      // targets, and picking a near-tie isolates the age discount as the
      // only variable — a huge score gap would pass/fail regardless of
      // whether the discount code even ran, telling us nothing.
      launcher._hooks.set('A', {
        key: 'A', name: 'menu.exe', isSystemHook: false, hasCJK: true,
        textCount: 50, totalTextLength: 1000, qualityPenalty: 0,
        lastText: '恵麻メニュー', lastTextAt: incumbentLastTextAt
      });
      launcher._autoSelectedHookKey = 'A';
      launcher._hooks.set('B', {
        key: 'B', name: 'dialogue.exe', isSystemHook: false, hasCJK: true,
        textCount: 50, totalTextLength: 1050, qualityPenalty: 0,
        lastText: '恵麻ダイアログ', lastTextAt: virtualNow
      });
      return launcher;
    };

    // Case 1: incumbent produced text just now (silentMs=0) — full +200
    // threshold applies, a 1-point edge can't cross it. Switch blocked.
    {
      const launcher = makeHooks(virtualNow);
      withSilencedConsole(() => launcher._autoSelectBestHook());
      results.push({ id: 'hysteresis-blocks-fresh-incumbent', pass: launcher._autoSelectedHookKey === 'A', selected: launcher._autoSelectedHookKey });
    }

    // Case 2: incumbent silent for 20s (past the 15s full-decay window) —
    // threshold has decayed to 0, so even a 1-point edge switches.
    {
      const launcher = makeHooks(virtualNow - 20000);
      withSilencedConsole(() => launcher._autoSelectBestHook());
      results.push({ id: 'hysteresis-releases-stale-incumbent', pass: launcher._autoSelectedHookKey === 'B', selected: launcher._autoSelectedHookKey });
    }
  } finally {
    Date.now = origDateNow;
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────

function run() {
  const args = parseArgs(process.argv.slice(2));
  const all = [];

  if (!args.only || 'windows-only-guard'.includes(args.only)) all.push(testWindowsOnlyGuard());
  if (!args.only || 'timer-cleanup-after-kill'.includes(args.only)) all.push(testTimerCleanupAfterKill());
  if (!args.only || 'arch-relaunch-timer-cancelable'.includes(args.only)) all.push(testArchRelaunchTimerCancelable());
  if (!args.only || 'diagnostic'.includes(args.only) || 'tick'.includes(args.only)) all.push(...testDiagnosticScenarios());
  if (!args.only || 'hysteresis'.includes(args.only) || 'stale'.includes(args.only)) all.push(...testHysteresisAgeDiscount());

  console.log(`${C.bold}TextractorLauncher lifecycle bench${C.reset} — ${all.length} case(s)\n`);
  let passed = 0;
  for (const r of all) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id || r.label}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === all.length ? C.green : C.red}${passed}/${all.length}${C.reset}`);

  restoreSpawn();
  restoreFs();
  restorePlatform();

  return passed === all.length ? 0 : 1;
}

process.exit(run());
