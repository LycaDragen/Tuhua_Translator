/**
 * parseProcessListJson (src/services/game-process-list.js) bench — the
 * pure half of the `list-game-processes` IPC handler (Fase 4 of the
 * settings UX audit: the process picker that replaces "open Task Manager
 * and type the PID by hand"). Icon resolution (app.getFileIcon) and the
 * actual PowerShell call can only be exercised on real Windows — this
 * covers the one piece of logic that's genuinely Node-testable: turning
 * PowerShell's ConvertTo-Json stdout into a stable array shape.
 *
 *   node scripts/test-game-process-list.js
 *   node scripts/test-game-process-list.js --quiet
 */
const path = require('path');
const { parseProcessListJson, isKnownLauncherProcess } = require(path.join('..', 'src', 'services', 'game-process-list.js'));

const { makeEagerCheckRegistry } = require('./lib/bench.js');
const { check, report } = makeEagerCheckRegistry();

check('empty-string-yields-empty-array', () => {
  const r = parseProcessListJson('');
  return { pass: Array.isArray(r) && r.length === 0, actual: r };
});

check('null-input-yields-empty-array', () => {
  const r = parseProcessListJson(null);
  return { pass: Array.isArray(r) && r.length === 0, actual: r };
}, 'exec() resolves the raw stdout to null on a PowerShell failure — see the handler in ipc-handlers.js.');

check('whitespace-only-yields-empty-array', () => {
  const r = parseProcessListJson('   \n  ');
  return { pass: Array.isArray(r) && r.length === 0, actual: r };
});

check('malformed-json-yields-empty-array-not-a-throw', () => {
  const r = parseProcessListJson('{not valid json');
  return { pass: Array.isArray(r) && r.length === 0, actual: r };
}, 'A picker that shows "no processes found" on a parse failure is correct, calm degradation — one that throws leaves a blank dropdown with an error the user cannot act on.');

check('single-object-from-convertto-json-is-wrapped-into-an-array', () => {
  // The exact quirk this module exists to hide: ConvertTo-Json returns a
  // bare object, not a one-element array, when exactly one row matches.
  const raw = JSON.stringify({ Id: 4242, ProcessName: 'Nekopara', MainWindowTitle: 'Nekopara Vol. 1', Path: 'C:\\Games\\Nekopara\\Nekopara.exe' });
  const r = parseProcessListJson(raw);
  const pass = Array.isArray(r) && r.length === 1
    && r[0].pid === 4242 && r[0].name === 'Nekopara'
    && r[0].windowTitle === 'Nekopara Vol. 1' && r[0].exePath === 'C:\\Games\\Nekopara\\Nekopara.exe';
  return { pass, actual: r };
}, 'The one case that would silently break on a bare JSON.parse().length lookup.');

check('real-array-of-multiple-processes-passes-through', () => {
  const raw = JSON.stringify([
    { Id: 1001, ProcessName: 'chrome', MainWindowTitle: 'GitHub — Google Chrome', Path: 'C:\\chrome.exe' },
    { Id: 2002, ProcessName: 'Nekopara', MainWindowTitle: 'Nekopara Vol. 1', Path: 'C:\\Nekopara.exe' }
  ]);
  const r = parseProcessListJson(raw);
  return { pass: Array.isArray(r) && r.length === 2 && r[0].pid === 1001 && r[1].pid === 2002, actual: r };
});

check('a-row-missing-path-is-dropped-not-crashed-on', () => {
  // Belt-and-suspenders — the PowerShell filter (`-and $_.Path`) already
  // excludes these, but a row without a resolvable exe path is useless to
  // the picker (nothing to launch, nothing to fetch an icon for) even if
  // one somehow slipped through.
  const raw = JSON.stringify([
    { Id: 1001, ProcessName: 'chrome', MainWindowTitle: 'Chrome', Path: 'C:\\chrome.exe' },
    { Id: 3003, ProcessName: 'protected', MainWindowTitle: 'Something', Path: '' }
  ]);
  const r = parseProcessListJson(raw);
  return { pass: r.length === 1 && r[0].pid === 1001, actual: r };
});

check('a-row-with-a-non-integer-id-is-dropped', () => {
  const raw = JSON.stringify([{ Id: 'not-a-pid', ProcessName: 'weird', MainWindowTitle: 'x', Path: 'C:\\x.exe' }]);
  const r = parseProcessListJson(raw);
  return { pass: r.length === 0, actual: r };
});

check('missing-mainwindowtitle-defaults-to-empty-string-not-undefined', () => {
  // PowerShell can emit `null` for a genuinely empty title depending on
  // serialization quirks — the renderer's row template does
  // `p.windowTitle || p.name`, but this module's own contract is a real
  // string, never undefined, so a consumer never needs an extra guard.
  const raw = JSON.stringify([{ Id: 5005, ProcessName: 'game', MainWindowTitle: null, Path: 'C:\\game.exe' }]);
  const r = parseProcessListJson(raw);
  return { pass: r.length === 1 && r[0].windowTitle === '', actual: r };
});

check('itch-io-launcher-is-excluded-from-the-process-list', () => {
  // v3.13.88: real bug (Lyca, 2026-08-24) — the itch.io desktop client
  // qualifies for the picker's own filter (real window + real path) just
  // like the VN it launches, so it showed up as a pickable "game" and got
  // linked by mistake, poisoning both the profile suggestion and
  // Textractor's PID auto-connect.
  const raw = JSON.stringify([
    { Id: 31000, ProcessName: 'itch', MainWindowTitle: 'itch', Path: 'C:\\Users\\sebag\\AppData\\Local\\itch\\app-26.18.0\\itch.exe' },
    { Id: 35040, ProcessName: 'TemptationsBallad', MainWindowTitle: "Temptation's Ballad", Path: 'D:\\Itch.io\\temptations-ballad\\TemptationsBallad-0.2.8-pc\\TemptationsBallad.exe' }
  ]);
  const r = parseProcessListJson(raw);
  return { pass: r.length === 1 && r[0].pid === 35040, actual: r };
});

check('isKnownLauncherProcess-matches-itch-install-path-shape', () => {
  const cases = [
    ['C:\\Users\\sebag\\AppData\\Local\\itch\\app-26.18.0\\itch.exe', true],
    ['C:\\Users\\sebag\\AppData\\Local\\itch\\app-1.0.0\\itch.exe', true],
    ['D:\\Games\\SomeVN\\itch.exe', false],   // bare exeName alone must NOT be enough
    ['D:\\Itch.io\\temptations-ballad\\TemptationsBallad-0.2.8-pc\\TemptationsBallad.exe', false],
    [undefined, false],
    ['', false]
  ];
  const pass = cases.every(([exePath, expected]) => isKnownLauncherProcess(exePath) === expected);
  return { pass, actual: cases.map(([exePath]) => [exePath, isKnownLauncherProcess(exePath)]) };
});

report();
