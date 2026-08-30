/**
 * clipboard-watcher.js bench — v1.0.6.
 *
 * The bug (found in a real 2026-08-30 log, not by reading code): start()
 * reset `lastHash` to '', so the first poll after starting the watcher
 * always emitted whatever was ALREADY in the clipboard. The log shows the
 * same stale text — Tuhua's own debug logs, straight from the "Copiar logs"
 * button — translated three times in three minutes, each time exactly one
 * polling interval after `[Clipboard] Status: watching`.
 *
 * Runs the REAL ClipboardWatcher with a fake clipboard reader injected
 * (options.readClipboard), driving `_tick()` by hand instead of sleeping on
 * timers — so these checks are deterministic and need no Electron.
 *
 *   node scripts/test-clipboard-watcher.js
 *   node scripts/test-clipboard-watcher.js --quiet
 */
const path = require('path');
const ClipboardWatcher = require(path.join('..', 'src', 'services', 'clipboard-watcher.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

/**
 * A watcher whose clipboard is a variable this file controls, with every
 * emitted line recorded. `poll(n)` stands in for n timer ticks.
 */
function fakeWatcher(initialClipboard = '') {
  let clipboardText = initialClipboard;
  const watcher = new ClipboardWatcher({ readClipboard: () => clipboardText });
  const emitted = [];
  watcher.on('text', (t) => emitted.push(t));
  return {
    watcher,
    emitted,
    copy: (t) => { clipboardText = t; },
    poll: (n = 1) => { for (let i = 0; i < n; i++) watcher._tick(); },
    // start() installs a real setInterval; stop it so the process can exit.
    startAndDisarm: () => { watcher.start(); clearInterval(watcher.timer); watcher.timer = null; }
  };
}

check('the-reported-bug-starting-does-not-translate-what-was-already-copied', () => {
  const w = fakeWatcher("Tuhua's own debug log, copied with the Logs button");
  w.startAndDisarm();
  w.poll(3);
  return { pass: w.emitted.length === 0, actual: { emitted: w.emitted.length, first: w.emitted[0] } };
}, 'session log 2026-08-30 00:35:37 / 00:38:18 / 00:38:51 — three identical re-translations of stale clipboard content, one polling interval after each "watching".');

check('a-genuinely-new-copy-after-start-is-still-emitted', () => {
  const w = fakeWatcher('old text nobody wants translated again');
  w.startAndDisarm();
  w.poll();
  w.copy('新しい行');
  w.poll();
  return { pass: w.emitted.length === 1 && w.emitted[0] === '新しい行', actual: w.emitted };
}, 'The whole point of the watcher — seeding must silence the stale line only, never the next real one.');

check('toggling-pause-play-does-not-re-translate-the-last-line', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.copy('Valessa: Yeah, something else is going on here.');
  w.poll();
  w.watcher.stop();
  w.startAndDisarm(); // the ▶/⏸ button: stop() + start()
  w.poll(3);
  return { pass: w.emitted.length === 1, actual: w.emitted };
}, 'Pause/resume is the most common way a user hits this — the line is still sitting in the clipboard when the watcher comes back.');

check('changing-the-polling-interval-does-not-re-translate', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.copy('Ulric: Join the club.');
  w.poll();
  w.watcher.setInterval(1000); // internally stop() + start()
  clearInterval(w.watcher.timer);
  w.watcher.timer = null;
  w.poll(3);
  return { pass: w.emitted.length === 1, actual: { emitted: w.emitted, interval: w.watcher.interval } };
}, 'setInterval() restarts the watcher, so before the fix a settings change re-translated the current line as a side effect.');

check('repeated-polls-with-an-unchanged-clipboard-emit-once', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.copy('same line');
  w.poll(5);
  return { pass: w.emitted.length === 1, actual: w.emitted };
}, 'Pre-existing dedup behavior — pinned here so the seeding change can never be "fixed" by weakening it.');

check('the-same-text-copied-again-later-is-emitted-again', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.copy('line A');
  w.poll();
  w.copy('line B');
  w.poll();
  w.copy('line A');
  w.poll();
  return { pass: w.emitted.join('|') === 'line A|line B|line A', actual: w.emitted };
}, 'Dedup is against the PREVIOUS text only, not a history — a game repeating a line must still translate it.');

check('a-clipboard-that-throws-on-start-falls-back-to-the-old-behavior', () => {
  const watcher = new ClipboardWatcher({ readClipboard: () => { throw new Error('clipboard busy'); } });
  const emitted = [];
  watcher.on('text', (t) => emitted.push(t));
  watcher.start();
  clearInterval(watcher.timer);
  watcher.timer = null;
  const seededEmpty = watcher.lastHash === '';
  watcher._tick(); // still throwing — must be swallowed, not crash the timer
  return { pass: seededEmpty && emitted.length === 0, actual: { lastHash: watcher.lastHash, emitted } };
}, 'Windows clipboards are lockable by other processes: an unreadable clipboard must degrade to the pre-fix behavior, never throw out of start().');

check('an-empty-clipboard-at-start-is-seeded-as-empty-and-the-first-copy-still-fires', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.poll(2);
  w.copy('first real line');
  w.poll();
  return { pass: w.emitted.length === 1 && w.emitted[0] === 'first real line', actual: w.emitted };
});

check('copying-tuhuas-own-logs-does-not-translate-them', () => {
  const logDump = '[2026-08-30 00:29:14.484] [info] [WindowManager] Hiding output overlay\n[info] [Pipeline] updateSettings';
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.watcher.ignoreNext(logDump);   // ipc-handlers.js's get-debug-logs does this
  w.copy(logDump);                 // …and then the renderer writes it
  w.poll(3);
  return { pass: w.emitted.length === 0, actual: w.emitted };
}, 'The "Copiar logs" button is the bug-report path — it must not feed the log file back into the translator, nor into the context window / TM / history.');

check('the-ignore-slot-is-one-shot-and-does-not-swallow-the-next-real-line', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.watcher.ignoreNext('log dump text');
  w.copy('log dump text');
  w.poll();
  w.copy('Ulric: Join the club.');
  w.poll();
  return { pass: w.emitted.length === 1 && w.emitted[0] === 'Ulric: Join the club.', actual: w.emitted };
});

check('an-ignored-write-still-counts-as-seen-for-deduplication', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.watcher.ignoreNext('log dump text');
  w.copy('log dump text');
  w.poll(4); // several ticks with the dump still sitting in the clipboard
  return { pass: w.emitted.length === 0 && w.watcher.lastText === 'log dump text', actual: { emitted: w.emitted, lastText: w.watcher.lastText } };
}, 'Absorbing must update lastHash, not just skip once — otherwise the very next tick sees "new" text and translates the dump anyway.');

check('a-game-line-arriving-before-the-copy-is-still-translated', () => {
  const w = fakeWatcher('');
  w.startAndDisarm();
  w.watcher.ignoreNext('log dump text');
  w.copy('Valessa: something else is going on here.');
  w.poll();
  w.copy('log dump text');
  w.poll();
  return { pass: w.emitted.length === 1 && w.emitted[0].startsWith('Valessa'), actual: w.emitted };
}, 'The slot matches on content, not on "the next thing that happens" — a pending ignore must never blank out real dialogue.');

check('status-events-still-fire-on-start-and-stop', () => {
  const w = fakeWatcher('anything');
  const statuses = [];
  w.watcher.on('status', (s) => statuses.push(s));
  w.startAndDisarm();
  w.watcher.stop();
  return { pass: statuses.join('|') === 'watching|stopped', actual: statuses };
}, 'src/main/index.js maps these straight onto the connection badge — seeding must not have moved or swallowed them.');

run('clipboard-watcher.js bench', CHECKS);
