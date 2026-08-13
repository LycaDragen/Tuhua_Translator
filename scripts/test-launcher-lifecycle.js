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
  // v3.13.35: `writes` captures every chunk handed to stdin.write(), in
  // order — the old stub (`write: () => {}`) accepted anything silently,
  // which is exactly how the encoding bug this bench now guards against
  // (plain-string writes that TextractorCLI's UTF-16-mode stdin parser
  // can never match a line ending in) went undetected for several real
  // investigation sessions. Tests read proc.stdin.writes directly rather
  // than adding a separate spy, so there's one source of truth for "what
  // actually left the process" matching how _writeStdinCommand's own hex
  // dump describes itself.
  proc.stdin = { writes: [], write(chunk) { this.writes.push(chunk); }, destroyed: false };
  proc.pid = 12345;
  proc.kill = () => {};
  return proc;
}

let lastFakeProcess = null;
// v3.13.32: every spawned exe path, in call order — lets the arch-fallback
// tests below assert not just THAT a relaunch happened but which
// architecture it actually spawned (x64 vs its x86 sibling), and how many
// times spawn() was called in total. Reset per-test via spawnCalls.length=0.
let spawnCalls = [];
function installFakeSpawn() {
  const origSpawn = cp.spawn;
  cp.spawn = (exePath) => {
    // v3.13.32: kill() also calls spawn('taskkill', ...) on a win32
    // platform (which this bench always fakes) to terminate the process
    // by PID. That call must NOT be recorded as a TextractorCLI (re)launch
    // — spawnCalls/lastFakeProcess are read by the arch-fallback tests
    // specifically to inspect the relaunched TextractorCLI process, and a
    // 'taskkill' entry between two real launches threw those counts and
    // "is this the new process" checks off.
    if (exePath === 'taskkill') {
      return makeFakeProcess();
    }
    spawnCalls.push(exePath);
    lastFakeProcess = makeFakeProcess();
    return lastFakeProcess;
  };
  return () => { cp.spawn = origSpawn; };
}

// v3.13.31: fakes the `tasklist` call inside _checkPidIsRunning. Same
// require-order caveat as installFakeSpawn — textractor-launcher.js
// destructures `execSync` out of child_process at require-time, so this
// must be installed before that require, not after. Controlled via the
// mutable `execSyncBehavior` object so individual test cases can pick a
// mode without re-installing the fake.
let execSyncBehavior = { mode: 'pid-found' };
function installFakeExecSync() {
  const origExecSync = cp.execSync;
  cp.execSync = (cmd) => {
    if (execSyncBehavior.mode === 'throw') {
      throw new Error(execSyncBehavior.message || 'tasklist is not recognized');
    }
    if (execSyncBehavior.mode === 'pid-not-found') {
      // tasklist's real (English) message when nothing matches the
      // filter; deliberately does NOT contain any PID number, which is
      // exactly what _checkPidIsRunning relies on.
      return 'INFO: No tasks are running which match the specified criteria.\r\n';
    }
    // 'pid-found' (default): echo back whichever PID was actually
    // requested, parsed out of the command string, rather than a fixed
    // value — so launch() calls in OTHER tests (which trigger this check
    // as a side effect with their own PIDs) don't spuriously see "not
    // found" just because this fake doesn't recognize their PID.
    const match = /PID eq (\d+)/.exec(cmd);
    const pid = match ? match[1] : '0';
    return `"TextractorCLI.exe","${pid}","Console","1","10,000 K"\r\n`;
  };
  return () => { cp.execSync = origExecSync; };
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
const restoreExecSync = installFakeExecSync();
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

// ─── Test: PID liveness check (Fase "diagnosticar sin GUI", v3.13.31) ──
// _checkPidIsRunning is a thin wrapper around a faked `tasklist` call —
// exercises all three return values (true/false/null) via
// execSyncBehavior, synchronous, no clock needed.

function testPidLivenessCheck() {
  const launcher = new TextractorLauncher();
  const results = [];

  execSyncBehavior = { mode: 'pid-found' };
  results.push({ id: 'pid-check-found', pass: launcher._checkPidIsRunning(11860) === true });

  execSyncBehavior = { mode: 'pid-not-found' };
  results.push({ id: 'pid-check-not-found', pass: launcher._checkPidIsRunning(99999) === false });

  execSyncBehavior = { mode: 'throw' };
  const undetermined = withSilencedConsole(() => launcher._checkPidIsRunning(11860));
  results.push({ id: 'pid-check-error-undetermined', pass: undetermined === null });

  // Reset to the default used by the other tests in this file (their
  // launch() calls trigger the same PID check as a side effect and
  // shouldn't see a stale 'throw' mode bleed in from this test).
  execSyncBehavior = { mode: 'pid-found' };

  return results;
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

// ─── Tests 2b-2f (v3.13.32): the arch-fallback HANDOVER itself — the race
// between the dying process's late 'close' and the 300ms relaunch, the
// status the UI sees during that window, generation-based isolation of a
// stale process's events, and the user-kill paths that must NOT be
// mistaken for (or interrupted by) that handover. Unlike the tests above,
// these actually call launch() and let the fake spawn/clock drive a real
// end-to-end relaunch, so they need x64Path/x86Path — note that unlike
// testArchRelaunchTimerCancelable above, no local fs override is needed
// here: the module-scope installFakeFs()'s isFakePath already answers for
// anything under path.dirname(FAKE_EXE_PATH) ('/fake'), which covers both
// '/fake/x64/TextractorCLI.exe' and '/fake/x86/TextractorCLI.exe'. ───────

function archSiblingPaths() {
  const x64Path = FAKE_EXE_PATH.replace(path.sep + 'TextractorCLI.exe', path.sep + 'x64' + path.sep + 'TextractorCLI.exe');
  const x86Path = x64Path.replace(path.sep + 'x64' + path.sep, path.sep + 'x86' + path.sep);
  return { x64Path, x86Path };
}

function collectStatuses(launcher) {
  const statuses = [];
  launcher.on('status', (s) => statuses.push(s));
  return statuses;
}

// Fire pending fake-clock timers one at a time until `predicate()` is true
// or there's nothing left to fire — used instead of draining everything so
// these tests don't also have to run the new session's full 10s-60s
// diagnostic chain just to observe the 300ms relaunch handover.
function drainUntil(clock, predicate, maxTicks = 30) {
  let guard = 0;
  while (!predicate() && clock.pendingCount() > 0 && guard++ < maxTicks) {
    withSilencedConsole(() => clock.fireNext());
  }
}

function testRelaunchSurvivesLateClose() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  // A synthetic 'close' with a non-zero code can make launch()'s close
  // handler build and emit a real 'error' when the arch-fallback retry
  // it also tries returns false (already attempted) — Node throws on an
  // unhandled 'error' event, so every test below that emits 'close' needs
  // a listener here even when the error itself isn't what's under test.
  launcher.on('error', () => {});
  const { x64Path, x86Path } = archSiblingPaths();
  spawnCalls.length = 0;

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  const oldProcess = lastFakeProcess;

  withSilencedConsole(() => launcher._attemptArchFallback('no-hooks'));
  const relaunchScheduledBeforeClose = launcher._archRelaunchTimer !== null;

  // The bug this reproduces: the dying process's 'close' arriving WITHIN
  // the 300ms relaunch window, before the timer has fired. The old
  // unconditional _clearTimers() inside that close handler cancelled
  // _archRelaunchTimer right back out — no x86 relaunch, no error, just a
  // UI back on "Launch".
  withSilencedConsole(() => oldProcess.emit('close', 1, null));
  const relaunchSurvivedClose = launcher._archRelaunchTimer !== null;

  drainUntil(clock, () => spawnCalls.length >= 2);
  clock.restore();

  const pass = ok && relaunchScheduledBeforeClose && relaunchSurvivedClose
    && spawnCalls.length === 2 && spawnCalls[1] === x86Path;
  return { id: 'relaunch-survives-late-close', pass, relaunchScheduledBeforeClose, relaunchSurvivedClose, spawnCalls: [...spawnCalls] };
}

function testStatusMappingDuringRelaunch() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  // A synthetic 'close' with a non-zero code can make launch()'s close
  // handler build and emit a real 'error' when the arch-fallback retry
  // it also tries returns false (already attempted) — Node throws on an
  // unhandled 'error' event, so every test below that emits 'close' needs
  // a listener here even when the error itself isn't what's under test.
  launcher.on('error', () => {});
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  // Start collecting only from here — the initial launch's own 'launched'
  // isn't part of what this test is asserting about.
  const statuses = collectStatuses(launcher);

  withSilencedConsole(() => launcher._attemptArchFallback('no-hooks'));
  drainUntil(clock, () => statuses.includes('launched'));
  clock.restore();

  const noRealStop = !statuses.includes('killed') && !statuses.includes('exited');
  const sawRelaunching = statuses.includes('relaunching');
  const sawSecondLaunched = statuses.includes('launched');
  const pass = ok && spawnCalls.length === 2 && noRealStop && sawRelaunching && sawSecondLaunched;
  return { id: 'status-mapping-during-relaunch', pass, statuses: [...statuses], spawnCallCount: spawnCalls.length };
}

function testStaleCloseIgnored() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  // A synthetic 'close' with a non-zero code can make launch()'s close
  // handler build and emit a real 'error' when the arch-fallback retry
  // it also tries returns false (already attempted) — Node throws on an
  // unhandled 'error' event, so every test below that emits 'close' needs
  // a listener here even when the error itself isn't what's under test.
  launcher.on('error', () => {});
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  const oldProcess = lastFakeProcess;

  withSilencedConsole(() => launcher._attemptArchFallback('no-hooks'));
  drainUntil(clock, () => spawnCalls.length >= 2);
  const newProcess = lastFakeProcess;
  const relaunchHappened = spawnCalls.length === 2 && newProcess !== oldProcess;

  // The stale process's 'close' arrives AFTER the new session already
  // exists — must be a complete no-op against current-session state.
  const hooksBeforeStaleClose = launcher._hooks.size;
  withSilencedConsole(() => oldProcess.emit('close', 1, null));
  const stillRunning = launcher.isRunning === true;
  const stillOnNewProcess = launcher.process === newProcess;
  const hooksUnaffected = launcher._hooks.size === hooksBeforeStaleClose;

  // And — the one guard in this whole change with real data-loss risk if
  // misplaced — the CURRENT session's own stdout must still process
  // normally after the stale event was ignored, not just "nothing broke".
  const hookLine = '[6:12345:AAAA:BBBB:0::HQ8@0:nekopara.exe] test dialogue\n';
  withSilencedConsole(() => newProcess.stdout.emit('data', Buffer.from(hookLine, 'utf16le')));
  const newSessionStillProcesses = launcher._hooks.size > hooksBeforeStaleClose;

  clock.restore();

  const pass = ok && relaunchHappened && stillRunning && stillOnNewProcess && hooksUnaffected && newSessionStillProcesses;
  return { id: 'stale-close-ignored', pass, relaunchHappened, stillRunning, stillOnNewProcess, hooksUnaffected, newSessionStillProcesses };
}

function testUserKillCancelsRelaunch() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  // A synthetic 'close' with a non-zero code can make launch()'s close
  // handler build and emit a real 'error' when the arch-fallback retry
  // it also tries returns false (already attempted) — Node throws on an
  // unhandled 'error' event, so every test below that emits 'close' needs
  // a listener here even when the error itself isn't what's under test.
  launcher.on('error', () => {});
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  withSilencedConsole(() => launcher._attemptArchFallback('no-hooks'));
  const relaunchScheduled = launcher._archRelaunchTimer !== null;

  // The USER stops it now — plain kill(), no options. Must cancel the
  // pending relaunch outright (the v3.13.29 "resurrected process" fix,
  // kept working here) and must not leave _relaunchInProgress stuck true.
  withSilencedConsole(() => launcher.kill());
  const relaunchCancelled = launcher._archRelaunchTimer === null;
  const notStuckRelaunching = launcher._relaunchInProgress === false;

  // Drain whatever's left — if the cancellation failed, this would fire
  // the stale 300ms timer and spawn a third time.
  drainUntil(clock, () => false, 20);
  clock.restore();

  const pass = ok && relaunchScheduled && relaunchCancelled && notStuckRelaunching && spawnCalls.length === 1;
  return { id: 'user-kill-cancels-relaunch', pass, relaunchScheduled, relaunchCancelled, notStuckRelaunching, spawnCallCount: spawnCalls.length };
}

function testUserKillDoesNotTriggerFallback() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  // A synthetic 'close' with a non-zero code can make launch()'s close
  // handler build and emit a real 'error' when the arch-fallback retry
  // it also tries returns false (already attempted) — Node throws on an
  // unhandled 'error' event, so every test below that emits 'close' needs
  // a listener here even when the error itself isn't what's under test.
  launcher.on('error', () => {});
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;
  const fallbackEvents = [];
  launcher.on('arch-fallback', (e) => fallbackEvents.push(e));

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  const proc = lastFakeProcess;

  // The user stops it almost immediately — well within the runTime<2s
  // window the 'quick-exit' heuristic uses.
  withSilencedConsole(() => launcher.kill());
  // The real OS process's 'close' arrives after kill(), with a non-zero
  // exit code — exactly what taskkill /f produces.
  withSilencedConsole(() => proc.emit('close', 1, null));

  clock.restore();

  const pass = ok && fallbackEvents.length === 0 && spawnCalls.length === 1;
  return { id: 'user-kill-does-not-trigger-fallback', pass, fallbackEventCount: fallbackEvents.length, spawnCallCount: spawnCalls.length };
}

// ─── Tests: _archAttemptMemory — the actual loop-breaker (v3.13.32) ─────
// Unlike the diagnostic-scenario tests above (which stub out
// _attemptArchFallback to just observe reasons), these let it run for
// real end-to-end: a launch() with zero hooks the whole time drains its
// OWN full 10s-60s window, triggers a real relaunch onto the sibling
// architecture, and THAT session also drains its own full window with
// zero hooks — reaching _concludeArchFallback for real, which is what
// marks (install, PID) exhausted. Drains both windows via drainUntil
// rather than a fixed tick count so this doesn't silently stop verifying
// anything if ARCH_FALLBACK_CHECK_MAX_MS/INTERVAL_MS ever change.

function driveOnePidToExhaustion(launcher, clock, x64Path, fallbackEvents, errorEvents) {
  withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  // First window (x64, zero hooks) ends in exactly one real relaunch.
  drainUntil(clock, () => fallbackEvents.length >= 1, 15);
  // Second window (x86, also zero hooks — nothing here simulates the
  // relaunched process producing any hooks) ends in the terminal error
  // that marks this (install, PID) exhausted.
  drainUntil(clock, () => errorEvents.length >= 1, 30);
}

function testArchMemoryBlocksSecondLoop() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;
  const fallbackEvents = [];
  const errorEvents = [];
  launcher.on('arch-fallback', (e) => fallbackEvents.push(e));
  launcher.on('error', (e) => errorEvents.push(e));

  driveOnePidToExhaustion(launcher, clock, x64Path, fallbackEvents, errorEvents);
  const fallbacksAfterFirstCycle = fallbackEvents.length;
  const errorsAfterFirstCycle = errorEvents.length;
  const spawnsAfterFirstCycle = spawnCalls.length;

  // A second MANUAL launch, SAME PID, SAME install. Before
  // _archAttemptMemory existed, this reset _archFallbackAttempted (every
  // non-retry launch() does, deliberately — see its own comment) with
  // nothing remembering the first cycle ever happened, buying another
  // full pair of 60s waits — confirmed the actual mechanism behind a real
  // reported "infinite loop of intentando x86".
  withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  drainUntil(clock, () => false, 30); // drain whatever this launch schedules, fully

  clock.restore();

  const pass = fallbacksAfterFirstCycle === 1 && errorsAfterFirstCycle === 1 && spawnsAfterFirstCycle === 2
    // The second launch spawns once (the manual relaunch itself) but must
    // NOT trigger a second automatic arch-fallback, and must NOT report a
    // second (redundant) terminal error for the same exhausted key.
    && spawnCalls.length === 3 && fallbackEvents.length === 1 && errorEvents.length === 1;
  return {
    id: 'arch-memory-blocks-second-loop', pass,
    fallbacksAfterFirstCycle, errorsAfterFirstCycle, spawnsAfterFirstCycle,
    spawnCallCountFinal: spawnCalls.length, fallbackEventCountFinal: fallbackEvents.length, errorEventCountFinal: errorEvents.length
  };
}

function testArchMemoryScopedByPid() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;
  const fallbackEvents = [];
  const errorEvents = [];
  launcher.on('arch-fallback', (e) => fallbackEvents.push(e));
  launcher.on('error', (e) => errorEvents.push(e));

  driveOnePidToExhaustion(launcher, clock, x64Path, fallbackEvents, errorEvents);
  const fallbacksAfterFirstPid = fallbackEvents.length;

  // A DIFFERENT PID (different game) against the SAME install — must get
  // its own fresh attempt, not be silently blocked by the first PID's
  // exhausted memory. _archAttemptKey is (PID, install) precisely for this.
  withSilencedConsole(() => launcher.launch(999, { cliPath: x64Path }));
  drainUntil(clock, () => fallbackEvents.length > fallbacksAfterFirstPid, 15);

  clock.restore();

  const pass = fallbacksAfterFirstPid === 1 && fallbackEvents.length === 2
    && fallbackEvents[1].to === fallbackEvents[0].to; // same sibling-arch swap, just for the new PID
  return { id: 'arch-memory-scoped-by-pid', pass, fallbacksAfterFirstPid, fallbackEventCountFinal: fallbackEvents.length };
}

// ─── Tests: fewer attaches (v3.13.32) — the 1.5s backup attach becoming
// conditional, and _sendKnownGoodHooks moving from "every launch" to "only
// once the diagnostic actually sees the generic-hook failure mode". Both
// are about how many times this file injects into the game process per
// launch, not about hook selection or timing — getStats()'s new
// attachSendCount/hookInsertCount exist specifically so these can assert
// exact counts instead of just "at least one". ──────────────────────────

function testAttachSentOnceWhenAcked() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const { x64Path } = archSiblingPaths();

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  const proc = lastFakeProcess;

  // A real hook line arrives before the 1.5s backup timer fires — this is
  // what _attachWasAcknowledged() is meant to detect.
  const hookLine = '[6:12345:AAAA:BBBB:0::HQ8@0:nekopara.exe] test dialogue\n';
  withSilencedConsole(() => proc.stdout.emit('data', Buffer.from(hookLine, 'utf16le')));

  // Drain enough to fire the 1.5s backup timer (and whatever else is
  // pending soon after) without running the full 10s-60s diagnostic.
  drainUntil(clock, () => false, 3);
  clock.restore();

  const stats = launcher.getStats();
  const pass = ok && stats.attachSendCount === 1;
  return { id: 'attach-sent-once-when-acked', pass, attachSendCount: stats.attachSendCount, hookLinesProcessed: stats.hookLinesProcessed };
}

function testAttachResentWhenSilent() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const { x64Path } = archSiblingPaths();

  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  // Nothing acknowledges the immediate attach — fire just the 1.5s timer
  // (the earliest pending one) and stop before the 10s diagnostic.
  drainUntil(clock, () => false, 1);
  clock.restore();

  const stats = launcher.getStats();
  const pass = ok && stats.attachSendCount === 2;
  return { id: 'attach-resent-when-silent', pass, attachSendCount: stats.attachSendCount };
}

// ─── Tests: stdin UTF-16LE encoding (v3.13.35) ──────────────────────────
// TextractorCLI's own stdin is UTF-16 text mode (host/CLI/main.cpp:
// _setmode(_fileno(stdin), _O_U16TEXT) + fgetws + swscanf). A plain-string
// write is single-byte-per-char and never contains the wide newline
// fgetws is scanning for, so the command is silently never parsed — not
// an error, not a rejection, just a process that looks alive and mute
// forever. None of the OTHER benches (attachSendCount, hookInsertCount)
// would ever catch a regression back to plain-string writes, since they
// only count that a write was ATTEMPTED, never what bytes it contained —
// exactly the gap that let this bug hide across several real Windows
// investigation sessions. These tests read proc.stdin.writes directly.

function testStdinIsUtf16le() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const ok = withSilencedConsole(() => launcher.launch(12345, { cliPath: FAKE_EXE_PATH }));
  const proc = lastFakeProcess;
  clock.restore();

  const first = proc.stdin.writes[0];
  const isBuffer = Buffer.isBuffer(first);
  const decoded = isBuffer ? first.toString('utf16le') : null;
  // The defining check: a UTF-16LE-encoded ASCII command has a 0x00 byte
  // after every character. A plain-string write (the bug) would not.
  const hasNullPadding = isBuffer && first.length >= 2 && first[1] === 0x00;

  const pass = ok && isBuffer && hasNullPadding && decoded === 'attach -P12345\n';
  return { id: 'stdin-is-utf16le', pass, isBuffer, hasNullPadding, decoded };
}

function testStdinDetachIsUtf16le() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  withSilencedConsole(() => launcher.launch(12345, { cliPath: FAKE_EXE_PATH }));
  const proc = lastFakeProcess;
  proc.stdin.writes.length = 0; // isolate the detach write from the launch-time attaches
  withSilencedConsole(() => launcher.kill());
  clock.restore();

  const detachWrite = proc.stdin.writes.find(w => Buffer.isBuffer(w) && w.toString('utf16le').startsWith('detach'));
  const pass = !!detachWrite && detachWrite.toString('utf16le') === 'detach -P12345\n';
  return { id: 'stdin-detach-is-utf16le', pass, writes: proc.stdin.writes.map(w => Buffer.isBuffer(w) ? w.toString('utf16le').trim() : w) };
}

function testStdinRejectsHookCodeWithSpace() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  withSilencedConsole(() => launcher.launch(12345, { cliPath: FAKE_EXE_PATH }));
  const proc = lastFakeProcess;
  const writesBefore = proc.stdin.writes.length;

  // A space here would truncate TextractorCLI's own `%500s` match — see
  // STDIN_COMMAND_RE's doc. insertHookCode() must reject this BEFORE it
  // ever reaches stdin, not rely on TextractorCLI to survive it.
  const result = withSilencedConsole(() => launcher.insertHookCode('bad code with spaces'));
  clock.restore();

  const pass = result.success === false && proc.stdin.writes.length === writesBefore;
  return { id: 'stdin-rejects-hook-code-with-space', pass, result, writesAdded: proc.stdin.writes.length - writesBefore };
}

function testKnownGoodHooksOnlyOnGeneric() {
  // Generic case (mirrors diagnostic scenario B): the known-good hook
  // codes SHOULD fire exactly once, on the first 'no-clean-hook' tick.
  const clockA = installFakeClock();
  const launcherA = new TextractorLauncher();
  launcherA.on('error', () => {});
  launcherA._attemptArchFallback = () => false; // observe only, don't relaunch
  withSilencedConsole(() => launcherA.launch(12345, { cliPath: FAKE_EXE_PATH }));
  launcherA._hooks.set('6:1:A:B', {
    key: '6:1:A:B', name: 'game.exe', isSystemHook: false,
    textCount: 3, hookCode: 'HB0@0', hasCJK: true, totalTextLength: 30, qualityPenalty: 0
  });
  drainUntil(clockA, () => launcherA.getStats().hookInsertCount > 0, 5);
  clockA.restore();
  const generic = launcherA.getStats();

  // Clean case (mirrors diagnostic scenario C): a real, non-generic hook
  // exists from the start — known-good hooks must never fire.
  const clockB = installFakeClock();
  const launcherB = new TextractorLauncher();
  launcherB.on('error', () => {});
  withSilencedConsole(() => launcherB.launch(12345, { cliPath: FAKE_EXE_PATH }));
  launcherB._hooks.set('6:1:A:B', {
    key: '6:1:A:B', name: 'game.exe', isSystemHook: false,
    textCount: 3, hookCode: 'HQ8@0', hasCJK: true, totalTextLength: 30, qualityPenalty: 0
  });
  drainUntil(clockB, () => false, 5);
  clockB.restore();
  const clean = launcherB.getStats();

  const pass = generic.hookInsertCount === 1 && generic.attachSendCount === 1 && clean.hookInsertCount === 0;
  return { id: 'known-good-hooks-only-on-generic', pass, generic: { hookInsertCount: generic.hookInsertCount, attachSendCount: generic.attachSendCount }, clean: { hookInsertCount: clean.hookInsertCount } };
}

// ─── Tests: persisting the winning architecture (v3.13.32) — once a
// fallback's relaunch actually produces real hook text, launch() should
// reuse that architecture on the NEXT session instead of re-discovering it
// from scratch every time, but only within the SAME Textractor install. ──

function testArchPreferenceReused() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  launcher.on('error', () => {});
  const { x64Path, x86Path } = archSiblingPaths();
  spawnCalls.length = 0;
  const archResolvedEvents = [];
  launcher.on('arch-resolved', (e) => archResolvedEvents.push(e));

  withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  drainUntil(clock, () => spawnCalls.length >= 2, 15); // x64 -> x86 relaunch
  const x86Process = lastFakeProcess;

  // A real, non-system hook produces text on x86 — this is what proves the
  // architecture and triggers _markArchSuccess.
  const hookLine = '[6:12345:AAAA:BBBB:0::HQ8@0:nekopara.exe] hola mundo\n';
  withSilencedConsole(() => x86Process.stdout.emit('data', Buffer.from(hookLine, 'utf16le')));

  // A fresh MANUAL launch, pointed at x64 again (as if the user never
  // touched settings) — must reuse the proven x86 path instead of
  // re-discovering it from a brand new 60s window.
  withSilencedConsole(() => launcher.kill());
  withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));

  clock.restore();

  const pass = spawnCalls.length === 3 && spawnCalls[2] === x86Path && archResolvedEvents.length === 1;
  return { id: 'arch-preference-reused', pass, spawnCalls: [...spawnCalls], archResolvedEventCount: archResolvedEvents.length };
}

function testArchPreferenceNotCrossingInstalls() {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  launcher.on('error', () => {});
  const { x64Path } = archSiblingPaths();
  spawnCalls.length = 0;

  withSilencedConsole(() => launcher.launch(12345, { cliPath: x64Path }));
  drainUntil(clock, () => spawnCalls.length >= 2, 15);
  const x86Process = lastFakeProcess;
  const hookLine = '[6:12345:AAAA:BBBB:0::HQ8@0:nekopara.exe] hola mundo\n';
  withSilencedConsole(() => x86Process.stdout.emit('data', Buffer.from(hookLine, 'utf16le')));
  withSilencedConsole(() => launcher.kill());

  // A DIFFERENT install entirely (not the x64/x86 pair just proven) — the
  // preference for the first install must not leak here; an explicit
  // pointer at a different Textractor folder always wins.
  const otherInstallPath = FAKE_EXE_PATH.replace(path.sep + 'TextractorCLI.exe', path.sep + 'other' + path.sep + 'TextractorCLI.exe');
  withSilencedConsole(() => launcher.launch(12345, { cliPath: otherInstallPath }));

  clock.restore();

  const pass = spawnCalls.length === 3 && spawnCalls[2] === otherInstallPath; // used as-is, no swap
  return { id: 'arch-preference-not-crossing-installs', pass, spawnCalls: [...spawnCalls] };
}

// ─── Test 3: arch-fallback diagnostic tick count, three scenarios ───────

function runDiagnosticScenario(label, setupHooks) {
  const clock = installFakeClock();
  const launcher = new TextractorLauncher();
  const fallbackCalls = [];
  launcher._attemptArchFallback = (reason) => { fallbackCalls.push(reason); return false; }; // don't actually relaunch — just observe
  // v3.13.32: with the spy above always returning false, any scenario
  // where the window ends with !hasAnyRealHook now reaches
  // _concludeArchFallback(), which emits a real 'error' — Node throws on
  // an unhandled one, so this needs a listener even in scenarios that
  // don't expect an error (the array just stays empty for those).
  const errorEvents = [];
  launcher.on('error', (e) => errorEvents.push(e));

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
  return { label, diagnosticTicks, fallbackCalls, errorEvents, pendingAtEnd: clock.pendingCount() };
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

  // Scenario D: only a SYSTEM hook (Console/Clipboard) ever registers —
  // no real hook of any kind, the whole 60s window. v3.13.30 regression
  // guard, added after a real Windows session log showed exactly this:
  // `_hooks.size` is 1 (the system hook) from the very first tick, so the
  // old code's `_hooks.size === 0` fast-path never matched, and
  // `hasRealHookWithText` never matched either (a system hook doesn't
  // count) — the diagnostic ran all 11 ticks with ZERO fallback attempts
  // and just gave up. The fix's last-resort branch should fire exactly
  // once, on the final (60s) tick, with reason 'no-real-hook'.
  results.push(runDiagnosticScenario('D-only-system-hooks-forever', (launcher) => {
    launcher._hooks.set('1:0:0', {
      key: '1:0:0', name: 'Portapapeles', isSystemHook: true,
      textCount: 1, hookCode: 'HB0@0', hasCJK: false, totalTextLength: 5, qualityPenalty: 0
    });
  }));

  // Scenario E (v3.13.36): hooks discovered from REAL stdout lines with a
  // HEX PID (59C4) — the exact case the old `(\d+)` capture group in the
  // pre-canonical parser couldn't match. Before this version those two
  // lines fell through to the generic bracket fallback (hookCode: ''),
  // which made `hasRealHookWithText` true but the old
  // `_allRealHooksAreGenericType()` false (empty string !== 'HB0@0') —
  // landing in the bare-`return` branch after exactly ONE tick, with
  // KNOWN_GOOD_HOOK_CODES never sent and the arch-fallback never
  // attempted. Routing the lines through the REAL `_parseHookLine` +
  // `_processHookLine` (not hand-built hook objects, unlike A-D above) is
  // what actually exercises the parser bug this scenario guards against.
  results.push(runDiagnosticScenario('E-hex-pid-all-single-byte', (launcher) => {
    const lines = [
      '[2:59C4:7567B3D0:731BE89A:0::HB0@0:nekopara_vol1_trial.exe] k0n0g0k0n0g0k0n0',
      '[8:59C4:6380E0:63A140:1A::HB0@0:nekopara_vol1_trial.exe] k0k0n0k0n0g0n0k0'
    ];
    for (const line of lines) {
      const parsed = launcher._parseHookLine(line);
      if (parsed) launcher._processHookLine(parsed);
    }
  }));

  // Scenario F: same shape as E, but the degraded signal comes from
  // CONTENT (garbage ratio), not TYPE — the one real hook is HW8@0
  // (unicode type, so _allRealHooksAreSingleByteType() is false on its
  // own) yet still emits the UTF-16-as-bytes garbage pattern. Proves the
  // content signal catches what the structural signal alone would miss:
  // a unicode-typed hook pointed at the wrong parameter (documented
  // elsewhere in this file, see KNOWN_GOOD_HOOK_CODES, as a real
  // failure mode, not hypothetical).
  results.push(runDiagnosticScenario('F-content-degraded-non-byte-type', (launcher) => {
    const line = '[2:59C4:7567B3D0:731BE89A:0::HW8@0:nekopara_vol1_trial.exe] k0n0g0k0n0g0k0n0';
    const parsed = launcher._parseHookLine(line);
    if (parsed) launcher._processHookLine(parsed);
  }));

  const expectations = {
    // v3.13.32: A and D now ALSO end in exactly one terminal error via
    // _concludeArchFallback — both are "the 60s window ended with no real
    // hook" cases (A: hasAnyRealHook was never true at all; D: same, a
    // system hook doesn't count). B doesn't (a real, if generic, hook DOES
    // exist — hasAnyRealHook is true — so !hasAnyRealHook never matches
    // and _concludeArchFallback is never reached). C stops after one tick
    // with a real, non-generic hook — nothing to conclude either.
    'A-no-hooks-ever': { ticks: 11, expectedReasons: Array(11).fill('no-hooks'), expectedErrors: 1 },
    // v3.13.32: 10, not 11 — the FIRST 'no-clean-hook' tick now sends the
    // known-good hook codes instead of escalating straight to arch
    // fallback (see the diagnostic's 'no-clean-hook' branch), so only the
    // remaining 10 ticks actually call _attemptArchFallback. This changed
    // count IS the assertion that the cheap-fix-before-expensive-fix
    // ordering landed — not a loosened expectation.
    'B-all-generic': { ticks: 11, expectedReasons: Array(10).fill('no-clean-hook'), expectedErrors: 0 },
    'C-real-hook-clean': { ticks: 1, expectedReasons: [], expectedErrors: 0 },
    'D-only-system-hooks-forever': { ticks: 11, expectedReasons: ['no-real-hook'], expectedErrors: 1 },
    // v3.13.36: same shape as B — this IS the regression test. Before the
    // parser fix these hex-PID lines produced exactly C's shape (1 tick,
    // 0 fallback calls) because they silently fell through to FORMAT D.
    'E-hex-pid-all-single-byte': { ticks: 11, expectedReasons: Array(10).fill('no-clean-hook'), expectedErrors: 0 },
    'F-content-degraded-non-byte-type': { ticks: 11, expectedReasons: Array(10).fill('no-clean-hook'), expectedErrors: 0 }
  };

  const checked = results.map(r => {
    const exp = expectations[r.label];
    const ticksOk = r.diagnosticTicks === exp.ticks;
    const callsOk = r.fallbackCalls.length === exp.expectedReasons.length
      && r.fallbackCalls.every((x, i) => x === exp.expectedReasons[i]);
    const errorsOk = r.errorEvents.length === exp.expectedErrors
      && r.errorEvents.every(e => e.messageKey === 'err_arch_fallback_exhausted');
    const pendingOk = r.pendingAtEnd === 0;
    return { ...r, pass: ticksOk && callsOk && errorsOk && pendingOk, ticksOk, callsOk, errorsOk, pendingOk, expected: exp };
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

// ─── Test: hook-line parser (v3.13.36) ──────────────────────────────────
// Pure — no launch()/spawn/clock needed, just _parseHookLine against real
// line shapes. See HOOK_LINE_RE's doc in textractor-launcher.js for the
// printf these are transcribed from (Artikash/Textractor, host/CLI/main.cpp).

function testHookLineParsing() {
  const launcher = new TextractorLauncher();
  const results = [];

  // The exact line from a real session that exposed the bug: PID 59C4
  // has a letter in it, which the old `(\d+)` capture group could not
  // match — no backtrack possible, falls through to the generic bracket
  // fallback with hookCode: ''.
  {
    const p = launcher._parseHookLine('[2:59C4:7567B3D0:731BE89A:0::HB0@0:nekopara_vol1_trial.exe] texto');
    const pass = !!p && p.hookKey === '2:59C4:7567B3D0:731BE89A'
      && p.hookCode === 'HB0@0:nekopara_vol1_trial.exe'
      && p.hookCodeType === 'byte' && p.isSystemHook === false
      && p.hookIndex === 2 && p.text === 'texto';
    results.push({ id: 'parse-real-hex-pid', pass, parsed: p });
  }

  // ctx2 (the 5th field) is hex too — 1A, not a decimal 26.
  {
    const p = launcher._parseHookLine('[8:59C4:6380E0:63A140:1A::HB0@0:nekopara_vol1_trial.exe] t');
    const pass = !!p && p.ctx2Addr === '1A' && p.hookCode === 'HB0@0:nekopara_vol1_trial.exe';
    results.push({ id: 'parse-hex-ctx2', pass, parsed: p });
  }

  // System hooks (pid === 0) — name is present, hookCode has no suffix.
  {
    const p = launcher._parseHookLine('[0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:Consola:HB0@0] t');
    const pass = !!p && p.isSystemHook === true && p.hookName === 'Consola' && p.hookCode === 'HB0@0';
    results.push({ id: 'parse-system-hook-console', pass, parsed: p });
  }
  {
    const p = launcher._parseHookLine('[1:0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:Portapapeles:HB0@0] t');
    const pass = !!p && p.isSystemHook === true && p.hookName === 'Portapapeles';
    results.push({ id: 'parse-system-hook-clipboard', pass, parsed: p });
  }

  // The detection must be structural (pid === 0), not a name allowlist —
  // a differently-localized Textractor UI shouldn't stop being detected.
  {
    const p = launcher._parseHookLine('[1:0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:UnknownLocalizedName:HB0@0] t');
    const pass = !!p && p.isSystemHook === true;
    results.push({ id: 'parse-system-hook-by-pid-not-name', pass, parsed: p });
  }

  // hookCode itself contains ':' — the old `[^:]+` group could never
  // capture this.
  {
    const p = launcher._parseHookLine('[6:59C4:7567B3D0:731BE89A:0::HQ8@0:gdi32.dll:GetTextExtentPoint32W:nekopara.exe] t');
    const pass = !!p && p.hookCode === 'HQ8@0:gdi32.dll:GetTextExtentPoint32W:nekopara.exe' && p.hookCodeType === 'unicode';
    results.push({ id: 'parse-hookcode-with-colons', pass, parsed: p });
  }

  // Text itself can contain ']' — hookCode must not cross it.
  {
    const p = launcher._parseHookLine('[2:59C4:7567B3D0:731BE89A:0::HB0@0:nekopara.exe] some[thing] weird');
    const pass = !!p && p.text === 'some[thing] weird';
    results.push({ id: 'parse-text-with-bracket', pass, parsed: p });
  }

  // The reported symptom, directly: 13 real hooks with different `addr`
  // used to collapse into indistinguishable entries once they fell
  // through to the generic fallback. Distinct addr -> distinct displayName.
  {
    const addrs = ['7567B3D0', '7791AF50', '6380E0', '7791B850', '7791B370', '4E80E0', 'AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE', 'FFFFFF', '111111'];
    const parsed = addrs.map((addr, i) =>
      launcher._parseHookLine(`[${i.toString(16)}:59C4:${addr}:731BE89A:0::HB0@0:nekopara_vol1_trial.exe] t`));
    const names = new Set(parsed.map(p => p.displayName));
    results.push({ id: 'parse-distinct-display-names', pass: parsed.every(Boolean) && names.size === addrs.length, count: names.size });
  }

  // hookKey stability: same thread (handle:pid:addr:ctx), different text
  // -> same key, so hook state accumulates on one entry, not a new one
  // per line.
  {
    const p1 = launcher._parseHookLine('[2:59C4:7567B3D0:731BE89A:0::HB0@0:nekopara.exe] first');
    const p2 = launcher._parseHookLine('[2:59C4:7567B3D0:731BE89A:0::HB0@0:nekopara.exe] second');
    const pass = !!p1 && !!p2 && p1.hookKey === p2.hookKey && p1.hookKey === '2:59C4:7567B3D0:731BE89A';
    results.push({ id: 'parse-hookkey-stable', pass, key: p1 && p1.hookKey });
  }

  // Legacy fallback still works for a shape the canonical regex doesn't match.
  {
    const before = launcher._legacyParseCount;
    const p = launcher._parseHookLine('[0x1234:5:MiHook] t');
    const pass = !!p && launcher._legacyParseCount === before + 1;
    results.push({ id: 'parse-legacy-still-works', pass, parsed: p });
  }

  return results;
}

// ─── Test: hookCodeType (v3.13.36) ──────────────────────────────────────
// Pure static method — see its doc in textractor-launcher.js for the
// letter-to-type mapping, sourced from host/hookcode.cpp (ParseHCode).

function testHookCodeType() {
  const table = [
    ['HB0@0', 'byte'],
    ['HB0@0:nekopara_vol1_trial.exe', 'byte'],
    ['HA0@0', 'byte'],
    ['HS0@0', 'byte'],
    ['HQ8@0:gdi32.dll:GetTextExtentPoint32W', 'unicode'],
    ['HW8@0', 'unicode'],
    ['HW-8*14:-8*0@1A2B', 'unicode'],
    ['HV0@0', 'utf8'],
    ['HM0@0', 'hexdump'],
    ['', 'unknown'],
    ['garbage', 'unknown'],
    ['RS0@0', 'byte']
  ];
  const results = table.map(([code, expected]) => {
    const got = TextractorLauncher.hookCodeType(code);
    return { id: `hookcode-type-${code || 'empty'}`, pass: got === expected, code, expected, got };
  });

  // The bug this whole signal exists to fix: the real hookCode always
  // carries a module suffix, and the type check must not care.
  {
    const got = TextractorLauncher.hookCodeType('HB0@0:nekopara_vol1_trial.exe');
    results.push({ id: 'hookcode-type-ignores-module-suffix', pass: got === 'byte', got });
  }

  return results;
}

// ─── Test: _allRealHooksAreSingleByteType (v3.13.36) ────────────────────

function testAllRealHooksAreSingleByteType() {
  const results = [];

  {
    const launcher = new TextractorLauncher();
    launcher._hooks.set('a', { isSystemHook: false, textCount: 3, hookCode: 'HB0@0:nekopara_vol1_trial.exe' });
    launcher._hooks.set('b', { isSystemHook: false, textCount: 2, hookCode: 'HB0@0:other.exe' });
    // This is the direct reproduction of Bug 2: with the OLD exact-string
    // check (`hookCode !== 'HB0@0'`), a real hookCode WITH a module
    // suffix would make this evaluate to false — the trigger was dead
    // even with hookCode present, independent of the parser bug.
    results.push({ id: 'all-real-hooks-single-byte-with-module-suffix', pass: launcher._allRealHooksAreSingleByteType() === true });
  }
  {
    const launcher = new TextractorLauncher();
    launcher._hooks.set('a', { isSystemHook: false, textCount: 3, hookCode: 'HB0@0:x.exe' });
    launcher._hooks.set('b', { isSystemHook: false, textCount: 2, hookCode: 'HQ8@0:gdi32.dll:GetTextExtentPoint32W' });
    results.push({ id: 'mixed-types-not-all-single-byte', pass: launcher._allRealHooksAreSingleByteType() === false });
  }
  {
    const launcher = new TextractorLauncher();
    launcher._hooks.set('a', { isSystemHook: true, textCount: 3, hookCode: 'HB0@0' });
    results.push({ id: 'system-hooks-dont-count', pass: launcher._allRealHooksAreSingleByteType() === false });
  }

  return results;
}

// ─── Test: UTF-16-as-bytes garbage detection + dedup + CJK ratio (v3.13.36)

function testUtf16GarbageDetection() {
  const launcher = new TextractorLauncher();
  const results = [];

  // Strong garbage — a real line's worth of the k0/n0/g0 pattern.
  {
    const penalty = launcher._textQualityPenalty('k0n0g0k0n0g0k0n0');
    results.push({ id: 'utf16-garbage-penalty-strong', pass: penalty >= 1400, penalty });
  }

  // Real Japanese with digits must NOT trip the detector.
  const clean = ['2020年10月30日', '残り10分です', 'HP:100 MP:50', 'Lv.30 → Lv.40', 'あ0'];
  for (const text of clean) {
    const ratio = launcher._utf16ByteGarbageRatio(text);
    results.push({ id: `utf16-garbage-no-false-positive-${text}`, pass: ratio === 0, text, ratio });
  }

  // Pure digit strings are excluded explicitly (not dialogue anyway).
  {
    const ratio = launcher._utf16ByteGarbageRatio('20201030');
    results.push({ id: 'utf16-garbage-ignores-pure-digits', pass: ratio === 0, ratio });
  }

  // textCount dedup: a growing buffer counts as ONE piece of content.
  {
    const hook = {
      key: 'x', name: 'game.exe', isSystemHook: false, lastText: '',
      textCount: 0, emitCount: 0, cjkChars: 0, scoredChars: 0, hasCJK: false,
      looksUtf16Garbled: false, totalTextLength: 0, qualityPenalty: 0,
      lastTextAt: 0, _recentHashes: new Set(), _recentHashOrder: []
    };
    for (const t of ['あい', 'あいう', 'あいうえ']) {
      const isNew = launcher._isNewHookContent(hook, t);
      hook.lastText = t;
      hook.emitCount++;
      if (isNew) { hook.textCount++; hook.totalTextLength += t.length; }
    }
    results.push({ id: 'textcount-dedup-growing-buffer', pass: hook.textCount === 1 && hook.emitCount === 3, textCount: hook.textCount, emitCount: hook.emitCount });
  }

  // Exact repeats also dedup.
  {
    const hook = {
      lastText: '', textCount: 0, emitCount: 0, _recentHashes: new Set(), _recentHashOrder: []
    };
    for (let i = 0; i < 5; i++) {
      const isNew = launcher._isNewHookContent(hook, 'こんにちは');
      hook.lastText = 'こんにちは';
      hook.emitCount++;
      if (isNew) hook.textCount++;
    }
    results.push({ id: 'textcount-dedup-exact-repeat', pass: hook.textCount === 1, textCount: hook.textCount });
  }

  // Genuinely different text each time all counts as new.
  {
    const hook = { lastText: '', textCount: 0, _recentHashes: new Set(), _recentHashOrder: [] };
    for (const t of ['おはよう', 'こんばんは', 'さようなら']) {
      const isNew = launcher._isNewHookContent(hook, t);
      hook.lastText = t;
      if (isNew) hook.textCount++;
    }
    results.push({ id: 'textcount-counts-new-content', pass: hook.textCount === 3, textCount: hook.textCount });
  }

  // CJK ratio is no longer sticky: a mostly-garbage hook with one
  // accidental katakana character must NOT collect the full +1000.
  {
    const hook = {
      name: 'x.exe', isSystemHook: false, lastText: '', textCount: 1,
      cjkChars: 1, scoredChars: 40, totalTextLength: 40, qualityPenalty: 0, hasCJK: true
    };
    const score = launcher._scoreHook(hook);
    results.push({ id: 'cjk-ratio-not-sticky', pass: score < 800, score });
  }

  // Real Japanese dialogue still gets the full CJK bonus.
  {
    const text = '今日はいい天気ですね';
    const hook = {
      name: 'x.exe', isSystemHook: false, lastText: text, textCount: 1,
      cjkChars: text.length, scoredChars: text.length, totalTextLength: text.length,
      qualityPenalty: 0, hasCJK: true
    };
    const score = launcher._scoreHook(hook);
    results.push({ id: 'cjk-ratio-full-for-japanese', pass: score >= 1000, score });
  }

  // Backward compat: a hook built with only the OLD `hasCJK` field (no
  // cjkChars/scoredChars — exactly what testHysteresisAgeDiscount's
  // fixtures and any pre-v3.13.36 hook object look like) must still get
  // the full CJK bonus, not silently lose it. lastText/totalTextLength
  // deliberately long enough (>=3 chars) to avoid tripping the separate,
  // pre-existing "avgLen < 3 -> -200" short-text penalty, which would
  // otherwise mask the exact thing this case is checking.
  {
    const hook = {
      name: 'x.exe', isSystemHook: false, lastText: '恵麻さん', textCount: 1,
      totalTextLength: 4, qualityPenalty: 0, hasCJK: true
    };
    const score = launcher._scoreHook(hook);
    results.push({ id: 'score-back-compat-legacy-hook-object', pass: score >= 1000, score });
  }

  // The integration case, reproducing the real session's numbers: a hook
  // that re-emits a growing garbage buffer must lose to a hook that
  // emits clean text once, by more than HOOK_SWITCH_THRESHOLD (200).
  {
    const l = new TextractorLauncher();
    const garbageHook = {
      key: 'garbage', name: 'nekopara_vol1_trial.exe', isSystemHook: false, hookCode: 'HB0@0:nekopara_vol1_trial.exe',
      lastText: '', textCount: 0, emitCount: 0, cjkChars: 0, scoredChars: 0, hasCJK: false,
      looksUtf16Garbled: false, totalTextLength: 0, qualityPenalty: 0, discoveredAt: Date.now(),
      lastTextAt: 0, _recentHashes: new Set(), _recentHashOrder: []
    };
    withSilencedConsole(() => {
      let buf = '';
      for (let i = 0; i < 30; i++) {
        buf += 'k0n0';
        const parsed = { hookKey: 'garbage', hookName: garbageHook.name, displayName: garbageHook.name, text: buf, fullName: '', hookCode: garbageHook.hookCode, funcAddr: '', processName: garbageHook.name, hookIndex: 1, isSystemHook: false };
        l._hooks.set('garbage', garbageHook);
        l._processHookLine(parsed);
      }
      const cleanParsed = { hookKey: 'clean', hookName: 'clean.exe', displayName: 'clean.exe', text: 'こんにちは、世界！', fullName: '', hookCode: 'HQ8@0:gdi32.dll:GetTextExtentPoint32W', funcAddr: '', processName: 'clean.exe', hookIndex: 2, isSystemHook: false };
      l._processHookLine(cleanParsed);
    });
    const g = l._hooks.get('garbage');
    const c = l._hooks.get('clean');
    const scoreDiff = l._scoreHook(c) - l._scoreHook(g);
    results.push({
      id: 'garbage-hook-loses-to-clean-hook',
      pass: scoreDiff > 200,
      scoreDiff, garbageScore: l._scoreHook(g), cleanScore: l._scoreHook(c)
    });
  }

  return results;
}

function testStalenessPenalty() {
  const launcher = new TextractorLauncher();
  const results = [];

  const baseHook = (overrides) => ({
    name: 'x.exe', isSystemHook: false, lastText: 'abc', textCount: 1,
    totalTextLength: 10, qualityPenalty: 0, cjkChars: 0, scoredChars: 0, hasCJK: false,
    ...overrides
  });

  // Below NOVELTY_MIN_EMITS: no penalty applied, regardless of how stale
  // the ratio would otherwise look — protects freshly-discovered hooks
  // from being scored down before there's enough signal.
  {
    const noPenaltyScore = launcher._scoreHook(baseHook({ emitCount: 0 }));
    const belowFloorScore = launcher._scoreHook(baseHook({ emitCount: 3 }));
    results.push({ id: 'staleness-below-evidence-floor-unpenalized', pass: belowFloorScore === noPenaltyScore, noPenaltyScore, belowFloorScore });
  }

  // At/above the floor with a low novelty ratio (repeats far more than
  // it says anything new): penalized.
  {
    const staleScore = launcher._scoreHook(baseHook({ emitCount: 10 })); // ratio 1/10 = 0.1
    const freshScore = launcher._scoreHook(baseHook({ emitCount: 0 }));
    results.push({ id: 'staleness-penalizes-low-novelty-ratio', pass: freshScore - staleScore > 0 && freshScore - staleScore <= 700, diff: freshScore - staleScore });
  }

  // Penalty is capped at NOVELTY_STALENESS_PENALTY_MAX even for extreme
  // repetition — a menu hammering the same frame 50 times shouldn't
  // score more negatively than a hook that's merely "quite stale", and
  // neither should ever exceed the cap.
  {
    const extreme = launcher._scoreHook(baseHook({ emitCount: 50 })); // ratio 1/50 = 0.02
    const moderate = launcher._scoreHook(baseHook({ emitCount: 10 })); // ratio 1/10 = 0.1
    const freshScore = launcher._scoreHook(baseHook({ emitCount: 0 }));
    results.push({
      id: 'staleness-penalty-capped',
      pass: (freshScore - extreme) <= 700 && extreme <= moderate,
      extremePenalty: freshScore - extreme, moderatePenalty: freshScore - moderate
    });
  }

  // A hook with a couple of fresh emissions of genuinely new content
  // (novelty ratio 1.0) must not be penalized at all — dialogue that's
  // just getting started shouldn't lose to an established, stale menu
  // on a technicality.
  {
    const newDialogue = launcher._scoreHook(baseHook({ emitCount: 2, textCount: 2 }));
    const noPenaltyBaseline = launcher._scoreHook(baseHook({ emitCount: 0, textCount: 2 }));
    results.push({ id: 'staleness-fresh-full-novelty-unpenalized', pass: newDialogue === noPenaltyBaseline, newDialogue, noPenaltyBaseline });
  }

  // Real dialogue that occasionally repeats a short line ("...") a
  // couple of times out of many emissions keeps a high enough novelty
  // ratio to clear NOVELTY_RATIO_FLOOR — must not be penalized.
  {
    const mostlyNovel = launcher._scoreHook(baseHook({ emitCount: 10, textCount: 6 })); // ratio 0.6 > floor 0.5
    const noPenaltyBaseline = launcher._scoreHook(baseHook({ emitCount: 0, textCount: 6 }));
    results.push({ id: 'staleness-mostly-novel-dialogue-unpenalized', pass: mostlyNovel === noPenaltyBaseline, mostlyNovel, noPenaltyBaseline });
  }

  // Back-compat: hook objects without an emitCount field at all (older
  // fixtures, or any hook object built before v3.13.37) must not throw
  // and must not be penalized — `hook.emitCount || 0` treats missing as
  // 0, below the evidence floor.
  {
    const legacyHook = { name: 'x.exe', isSystemHook: false, lastText: 'abc', textCount: 1, totalTextLength: 10, qualityPenalty: 0, hasCJK: false };
    const score = launcher._scoreHook(legacyHook);
    const noPenaltyBaseline = launcher._scoreHook(baseHook({ emitCount: 0 }));
    results.push({ id: 'staleness-missing-emitcount-backcompat', pass: score === noPenaltyBaseline, score, noPenaltyBaseline });
  }

  // Integration, reproducing the real session's pattern end-to-end via
  // _processHookLine: a menu hook re-rendering the SAME text on every
  // frame must lose to a dialogue hook that only emitted once with NEW
  // content, by more than HOOK_SWITCH_THRESHOLD (200) — before this fix
  // both hooks capped textCount at 1 (v3.13.36 dedup) and scored within
  // a few points of each other regardless of emitCount.
  {
    const l = new TextractorLauncher();
    const menuHook = {
      key: 'menu', name: 'game.exe', isSystemHook: false, hookCode: 'HQ8@0:gdi32.dll:GetTextExtentPoint32W',
      lastText: '', textCount: 0, emitCount: 0, cjkChars: 0, scoredChars: 0, hasCJK: false,
      looksUtf16Garbled: false, totalTextLength: 0, qualityPenalty: 0, discoveredAt: Date.now(),
      lastTextAt: 0, _recentHashes: new Set(), _recentHashOrder: []
    };
    withSilencedConsole(() => {
      const menuText = 'ファイル 画面 言語設定';
      for (let i = 0; i < 5; i++) {
        const parsed = { hookKey: 'menu', hookName: menuHook.name, displayName: menuHook.name, text: menuText, fullName: '', hookCode: menuHook.hookCode, funcAddr: '', processName: menuHook.name, hookIndex: 1, isSystemHook: false };
        l._hooks.set('menu', menuHook);
        l._processHookLine(parsed);
      }
      const dialogueParsed = { hookKey: 'dialogue', hookName: 'dialogue.exe', displayName: 'dialogue.exe', text: '猫耳が人間社会に溶け込んでいる', fullName: '', hookCode: 'HW-8*14:-8*0@F80E0', funcAddr: '', processName: 'dialogue.exe', hookIndex: 2, isSystemHook: false };
      l._processHookLine(dialogueParsed);
    });
    const menu = l._hooks.get('menu');
    const dialogue = l._hooks.get('dialogue');
    const menuScore = l._scoreHook(menu);
    const dialogueScore = l._scoreHook(dialogue);
    results.push({
      id: 'staleness-integration-menu-loses-to-new-dialogue',
      pass: (dialogueScore - menuScore) > 200,
      menuScore, dialogueScore, menuEmitCount: menu.emitCount, menuTextCount: menu.textCount
    });
  }

  return results;
}

// ─── Test: repetition penalty + terminal punctuation (v3.13.38) ─────────────
// Every string here is verbatim from the real Nekopara Vol.1 / KiriKiriZ x86
// session (session16.log) where the auto-selector picked the wrong hook.
function testRepetitionAndTerminalPunct() {
  const launcher = new TextractorLauncher();
  const results = [];

  // Mirrors HOOK_SWITCH_THRESHOLD in textractor-launcher.js, which is
  // module-private. A challenger must beat the incumbent by MORE than this
  // to take over while the incumbent is still fresh.
  const SWITCH_THRESHOLD = 200;

  const IDEO = String.fromCharCode(0x3000);
  const DIALOGUE_LONG = '冠詞が『Le』ではなく『La』の『Soleil(太陽)』。';
  const DIALOGUE_SHORT = '「…これからは一人で頑張らないとな」';
  const MENU = 'ファイル(画面(テキスト言語(進行制御(ヘルプ(';
  const KIRIKIRIZ = '冠冠冠冠冠冠冠冠詞詞冠詞冠冠詞詞がが冠詞が冠冠詞詞がが『『冠詞が『';
  const PER_CHAR = '目目目目目標標標標標来来来来来人人人人人';

  // THE new capability. Measured against HEAD before the change: this exact
  // string scored 0 — rule 1's even-index pair test is diluted below 0.6 by
  // the interleaving, and rule 7 needs the "<char>0" byte signature. It was
  // the one garbage family with no signal at all, which is why it won.
  {
    const p = launcher._textQualityPenalty(KIRIKIRIZ);
    results.push({ id: 'repeat-run-penalizes-kirikiriz-redraw', pass: p >= 900, p });
  }

  // Rule 8 must NOT stack on top of an earlier rule. Both of these already
  // scored exactly 800 from rule 1 before v3.13.38 (verified against HEAD);
  // if the "penalty === 0" guard were dropped they would jump to 1700.
  {
    const p = launcher._textQualityPenalty(PER_CHAR);
    results.push({ id: 'repeat-run-does-not-stack-on-per-char-repeat', pass: p === 800, p });
  }
  {
    // A Japanese stretched-vowel scream is LEGITIMATE dialogue with run
    // coverage 0.905 — the case REPEAT_RUN_DISTINCT_MIN exists for. It has
    // distinct 1, so rule 8 skips it on its own merits too. qualityPenalty
    // is sticky (worst-seen), so a false positive would condemn a good hook
    // for the whole session.
    const p = launcher._textQualityPenalty('きゃああああああああああああああああああ');
    results.push({ id: 'repeat-run-no-false-positive-on-stretched-vowel', pass: p === 800, p });
  }

  // Must stay completely clean: the CORRECT dialogue hook (which emits every
  // sentence twice), and prose in both scripts.
  {
    const p = launcher._textQualityPenalty(DIALOGUE_LONG + IDEO + DIALOGUE_LONG);
    results.push({ id: 'repeat-run-no-false-positive-on-doubled-dialogue', pass: p === 0, p });
  }
  {
    const p = launcher._textQualityPenalty('She smiled and said nothing at all, letting the silence settle between us.');
    results.push({ id: 'repeat-run-no-false-positive-on-english-prose', pass: p === 0, p });
  }
  {
    const p = launcher._textQualityPenalty('今日はいい天気ですね');
    results.push({ id: 'repeat-run-no-false-positive-on-japanese-prose', pass: p === 0, p });
  }

  const mk = (t) => ({
    name: 'x.exe', isSystemHook: false, lastText: t, textCount: 1, emitCount: 1,
    cjkChars: launcher._countCJK(t), scoredChars: t.length, totalTextLength: t.length,
    qualityPenalty: launcher._textQualityPenalty(t)
  });

  // The reported bug, as one assertion: the menu hook was the incumbent at
  // 1034 holding a fresh +200 hysteresis claim, so real dialogue had to clear
  // 1234 to take over. Uses the SHORTER (worst-scoring) real dialogue line.
  {
    const dlg = launcher._scoreHook(mk(DIALOGUE_SHORT + IDEO + DIALOGUE_SHORT));
    const menu = launcher._scoreHook(mk(MENU));
    results.push({ id: 'terminal-punct-dialogue-beats-menu-past-threshold', pass: dlg - menu > SWITCH_THRESHOLD, dlg, menu, diff: dlg - menu });
  }

  // Terminal punctuation is a BONUS, never a penalty: the menu hook's score
  // must be byte-identical to what it was before v3.13.38 (1034 in the log).
  {
    const menu = launcher._scoreHook(mk(MENU));
    results.push({ id: 'terminal-punct-never-penalizes-menu', pass: menu === 1034, menu });
  }

  // The whole session in one case: all four real hook families side by side,
  // scored exactly as _processHookLine would score them. The dialogue hook
  // must beat every other one by more than the switch threshold.
  {
    const dlg = launcher._scoreHook(mk(DIALOGUE_SHORT + IDEO + DIALOGUE_SHORT));
    const menu = launcher._scoreHook(mk(MENU));
    const kiri = launcher._scoreHook(mk(KIRIKIRIZ.repeat(4)));
    const perChar = launcher._scoreHook(mk(PER_CHAR));
    results.push({
      id: 'nekopara-session-picks-dialogue-hook',
      pass: (dlg - menu) > SWITCH_THRESHOLD &&
            (dlg - kiri) > SWITCH_THRESHOLD &&
            (dlg - perChar) > SWITCH_THRESHOLD,
      dlg, menu, kiri, perChar
    });
  }

  // v3.13.38: the growing-buffer hole. _textQualityPenalty used to run ONLY
  // under isNewContent, and a growing buffer is never "new" after its first
  // emission — so the quality path only ever saw the first, shortest frame.
  // Measured against HEAD: this fixture ended the loop with qualityPenalty 0
  // even though the buffer it grew into scores 1400.
  {
    const l = new TextractorLauncher();
    withSilencedConsole(() => {
      let buf = '';
      for (let i = 0; i < 30; i++) {
        buf += 'k0n0';
        l._processHookLine({
          hookKey: 'g', hookName: 'g.exe', displayName: 'g.exe', text: buf, fullName: '',
          hookCode: 'HB0@0', funcAddr: '', processName: 'g.exe', hookIndex: 1, isSystemHook: false
        });
      }
    });
    const h = l._hooks.get('g');
    results.push({ id: 'quality-penalty-sees-grown-buffer', pass: h.qualityPenalty >= 1400, p: h.qualityPenalty, longest: h.longestScoredLength });
  }

  // lastNewTextAt must advance only on NEW content — a hook re-emitting one
  // identical line forever kept its incumbency claim because lastTextAt
  // advanced on every emission. Date.now() mocked (same pattern as
  // testHysteresisAgeDiscount) rather than relying on real elapsed
  // milliseconds between three back-to-back calls, which was flaky: three
  // synchronous _processHookLine calls can land in the same millisecond,
  // making lastNewTextAt === lastTextAt instead of strictly less.
  {
    const origDateNow = Date.now;
    let virtualNow = 1_700_000_000_000;
    Date.now = () => virtualNow;
    let h;
    try {
      const l = new TextractorLauncher();
      withSilencedConsole(() => {
        for (let i = 0; i < 3; i++) {
          l._processHookLine({
            hookKey: 'm', hookName: 'm.exe', displayName: 'm.exe', text: MENU, fullName: '',
            hookCode: 'HQ18@0', funcAddr: '', processName: 'm.exe', hookIndex: 1, isSystemHook: false
          });
          virtualNow += 1000;
        }
      });
      h = l._hooks.get('m');
    } finally {
      Date.now = origDateNow;
    }
    results.push({
      id: 'last-new-text-at-frozen-by-repeated-content',
      pass: h.emitCount === 3 && h.textCount === 1 && h.lastNewTextAt < h.lastTextAt,
      emitCount: h.emitCount, textCount: h.textCount, frozen: h.lastNewTextAt < h.lastTextAt
    });
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────

function run() {
  const args = parseArgs(process.argv.slice(2));
  const all = [];

  if (!args.only || 'windows-only-guard'.includes(args.only)) all.push(testWindowsOnlyGuard());
  if (!args.only || 'pid-check'.includes(args.only) || 'pid-liveness'.includes(args.only)) all.push(...testPidLivenessCheck());
  if (!args.only || 'timer-cleanup-after-kill'.includes(args.only)) all.push(testTimerCleanupAfterKill());
  if (!args.only || 'arch-relaunch-timer-cancelable'.includes(args.only)) all.push(testArchRelaunchTimerCancelable());
  if (!args.only || 'relaunch-survives-late-close'.includes(args.only)) all.push(testRelaunchSurvivesLateClose());
  if (!args.only || 'status-mapping-during-relaunch'.includes(args.only)) all.push(testStatusMappingDuringRelaunch());
  if (!args.only || 'stale-close-ignored'.includes(args.only)) all.push(testStaleCloseIgnored());
  if (!args.only || 'user-kill-cancels-relaunch'.includes(args.only)) all.push(testUserKillCancelsRelaunch());
  if (!args.only || 'user-kill-does-not-trigger-fallback'.includes(args.only)) all.push(testUserKillDoesNotTriggerFallback());
  if (!args.only || 'arch-memory-blocks-second-loop'.includes(args.only)) all.push(testArchMemoryBlocksSecondLoop());
  if (!args.only || 'arch-memory-scoped-by-pid'.includes(args.only)) all.push(testArchMemoryScopedByPid());
  if (!args.only || 'attach-sent-once-when-acked'.includes(args.only)) all.push(testAttachSentOnceWhenAcked());
  if (!args.only || 'attach-resent-when-silent'.includes(args.only)) all.push(testAttachResentWhenSilent());
  if (!args.only || 'stdin-is-utf16le'.includes(args.only)) all.push(testStdinIsUtf16le());
  if (!args.only || 'stdin-detach-is-utf16le'.includes(args.only)) all.push(testStdinDetachIsUtf16le());
  if (!args.only || 'stdin-rejects-hook-code-with-space'.includes(args.only)) all.push(testStdinRejectsHookCodeWithSpace());
  if (!args.only || 'known-good-hooks-only-on-generic'.includes(args.only)) all.push(testKnownGoodHooksOnlyOnGeneric());
  if (!args.only || 'arch-preference-reused'.includes(args.only)) all.push(testArchPreferenceReused());
  if (!args.only || 'arch-preference-not-crossing-installs'.includes(args.only)) all.push(testArchPreferenceNotCrossingInstalls());
  if (!args.only || 'diagnostic'.includes(args.only) || 'tick'.includes(args.only)) all.push(...testDiagnosticScenarios());
  if (!args.only || 'hysteresis'.includes(args.only) || 'stale'.includes(args.only)) all.push(...testHysteresisAgeDiscount());
  if (!args.only || 'parse'.includes(args.only)) all.push(...testHookLineParsing());
  if (!args.only || 'hookcode-type'.includes(args.only)) all.push(...testHookCodeType());
  if (!args.only || 'single-byte'.includes(args.only)) all.push(...testAllRealHooksAreSingleByteType());
  if (!args.only || 'garbage'.includes(args.only) || 'utf16'.includes(args.only)) all.push(...testUtf16GarbageDetection());
  if (!args.only || 'staleness'.includes(args.only) || 'novelty'.includes(args.only)) all.push(...testStalenessPenalty());
  if (!args.only || 'repetition'.includes(args.only) || 'terminal'.includes(args.only)) all.push(...testRepetitionAndTerminalPunct());

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
  restoreExecSync();
  restoreFs();
  restorePlatform();

  return passed === all.length ? 0 : 1;
}

process.exit(run());
