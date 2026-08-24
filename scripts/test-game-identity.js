/**
 * game-identity.js bench — pure decision table, no Electron, no fs.
 * See src/services/game-identity.js for the full rationale.
 *
 * The load-bearing case here is
 * 'name-only-match-never-produces-resolved': this is what closes the class
 * of bug where a coincidental exeName match (two different games both
 * shipping `Game.exe`) would silently re-point a profile's PID resolution
 * at the wrong process. Lyca's explicit decision: a name-only match always
 * requires a click, never resolves on its own.
 *
 *   node scripts/test-game-identity.js
 *   node scripts/test-game-identity.js --quiet
 */
const path = require('path');
const {
  normalizeExePath,
  normalizeExeName,
  normalizeDirName,
  buildGameRecord,
  matchRunningProcesses,
  normalizeTitle,
  compareTitles
} = require(path.join('..', 'src', 'services', 'game-identity.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

const CHECKS = [];
function check(id, fn, note) {
  CHECKS.push({ id, fn, note });
}

function profileWithGame(id, name, game, extra = {}) {
  return { id, name, game, cover: null, ...extra };
}

// ─── normalizeExePath ───────────────────────────────────────────────────
check('normalize-exe-path-case-insensitive', () => {
  const pass = normalizeExePath('C:\\Games\\Nekopara\\Nekopara.exe') === normalizeExePath('c:\\games\\nekopara\\nekopara.exe');
  return { pass };
});

check('normalize-exe-path-folds-forward-slashes', () => {
  const pass = normalizeExePath('C:/Games/Nekopara/nekopara.exe') === normalizeExePath('C:\\Games\\Nekopara\\nekopara.exe');
  return { pass };
});

check('normalize-exe-path-strips-trailing-slash', () => {
  const pass = normalizeExePath('C:\\Games\\x.exe\\') === normalizeExePath('C:\\Games\\x.exe');
  return { pass };
});

check('normalize-exe-path-different-drive-does-not-match', () => {
  const pass = normalizeExePath('C:\\Games\\x.exe') !== normalizeExePath('D:\\Games\\x.exe');
  return { pass };
});

check('normalize-exe-path-non-string-returns-empty', () => {
  const pass = normalizeExePath(null) === '' && normalizeExePath(undefined) === '';
  return { pass };
});

// ─── normalizeExeName / normalizeDirName ───────────────────────────────
check('normalize-exe-name-is-lowercase-basename', () => {
  const pass = normalizeExeName('C:\\Games\\Nekopara\\Nekopara.EXE') === 'nekopara.exe';
  return { pass, actual: normalizeExeName('C:\\Games\\Nekopara\\Nekopara.EXE') };
});

check('normalize-dir-name-is-lowercase-parent-basename', () => {
  const pass = normalizeDirName('C:\\Games\\Nekopara\\Game.exe') === 'nekopara';
  return { pass, actual: normalizeDirName('C:\\Games\\Nekopara\\Game.exe') };
});

// ─── buildGameRecord ────────────────────────────────────────────────────
check('build-game-record-shape', () => {
  const proc = { pid: 1234, name: 'nekopara', windowTitle: 'NEKOPARA Vol. 1', exePath: 'C:\\Games\\Nekopara\\nekopara.exe' };
  const rec = buildGameRecord(proc, { engine: { id: 'renpy' }, arch: 'x86' });
  const pass = rec.exePath === proc.exePath && rec.exeName === 'nekopara.exe' && rec.dirName === 'nekopara'
    && rec.windowTitle === 'NEKOPARA Vol. 1' && rec.processName === 'nekopara'
    && rec.engine.id === 'renpy' && rec.arch === 'x86' && typeof rec.detectedAt === 'number';
  return { pass, actual: rec };
});

check('build-game-record-defaults-engine-and-arch-to-null', () => {
  const rec = buildGameRecord({ exePath: 'C:\\Games\\x.exe' });
  return { pass: rec.engine === null && rec.arch === null, actual: rec };
});

check('build-game-record-preserves-exepath-verbatim', () => {
  // exePath is stored AS-IS for display — normalization only happens at
  // compare time (normalizeExePath), never on the stored record.
  const rec = buildGameRecord({ exePath: 'C:\\Games\\Nekopara\\Nekopara.EXE' });
  return { pass: rec.exePath === 'C:\\Games\\Nekopara\\Nekopara.EXE', actual: rec.exePath };
});

// ─── matchRunningProcesses: exact path ─────────────────────────────────
check('exact-path-match-on-active-profile-resolves', () => {
  const game = { exePath: 'C:\\Games\\Nekopara\\nekopara.exe', exeName: 'nekopara.exe', dirName: 'nekopara', engine: { id: 'renpy' }, arch: 'x86' };
  const profiles = [profileWithGame('p1', 'Nekopara', game)];
  const processes = [{ pid: 42, name: 'nekopara', windowTitle: 'NEKOPARA Vol. 1', exePath: 'C:\\Games\\Nekopara\\nekopara.exe' }];
  const result = matchRunningProcesses(processes, profiles, 'p1');
  const pass = result.resolved !== null && result.resolved.pid === 42
    && result.resolved.engine.id === 'renpy' && result.resolved.arch === 'x86'
    && result.suggestion === null && result.needsPathConfirm === null && result.ambiguous.length === 0;
  return { pass, actual: result };
});

check('exact-path-match-case-insensitive', () => {
  const game = { exePath: 'C:\\Games\\Nekopara\\nekopara.exe', exeName: 'nekopara.exe', dirName: 'nekopara' };
  const profiles = [profileWithGame('p1', 'Nekopara', game)];
  const processes = [{ pid: 42, name: 'nekopara', windowTitle: 'X', exePath: 'C:\\GAMES\\NEKOPARA\\NEKOPARA.EXE' }];
  const result = matchRunningProcesses(processes, profiles, 'p1');
  return { pass: result.resolved !== null && result.resolved.pid === 42, actual: result };
});

check('exact-path-match-on-other-profile-is-a-suggestion-not-a-switch', () => {
  const game = { exePath: 'C:\\Games\\Nekopara\\nekopara.exe', exeName: 'nekopara.exe', dirName: 'nekopara' };
  const profiles = [
    profileWithGame('p1', 'Nekopara', game, { cover: { url: 'https://t.vndb.org/cv/1.jpg' } }),
    profileWithGame('p2', 'Fate', null)
  ];
  const processes = [{ pid: 42, name: 'nekopara', windowTitle: 'X', exePath: 'C:\\Games\\Nekopara\\nekopara.exe' }];
  const result = matchRunningProcesses(processes, profiles, 'p2');
  const pass = result.resolved === null && result.suggestion !== null
    && result.suggestion.profileId === 'p1' && result.suggestion.coverUrl === 'https://t.vndb.org/cv/1.jpg';
  return { pass, actual: result };
}, 'matchRunningProcesses only ever produces a SUGGESTION for a non-active profile — the actual profile switch is a separate, explicit action (loadProfile), never triggered by this function.');

check('no-match-when-no-profile-has-game', () => {
  const profiles = [profileWithGame('p1', 'Nekopara', null)];
  const processes = [{ pid: 42, name: 'x', windowTitle: 'X', exePath: 'C:\\Games\\x.exe' }];
  const result = matchRunningProcesses(processes, profiles, 'p1');
  const pass = result.resolved === null && result.suggestion === null && result.needsPathConfirm === null && result.ambiguous.length === 0;
  return { pass, actual: result };
});

check('undefined-game-on-profile-never-matches-or-throws', () => {
  // A raw profile that predates the `game` field (before seedGameField ran)
  // must be inert, not throw on `.exePath` of undefined.
  const profiles = [{ id: 'p1', name: 'Old' }];
  const processes = [{ pid: 42, name: 'x', windowTitle: 'X', exePath: 'C:\\Games\\x.exe' }];
  let threw = false;
  let result;
  try { result = matchRunningProcesses(processes, profiles, 'p1'); } catch (e) { threw = true; }
  return { pass: !threw && result.resolved === null, actual: result };
});

// ─── matchRunningProcesses: name-only match NEVER resolves ─────────────
check('name-only-match-never-produces-resolved', () => {
  const game = { exePath: 'D:\\OldLocation\\nekopara.exe', exeName: 'nekopara.exe', dirName: 'oldlocation' };
  const profiles = [profileWithGame('p1', 'Nekopara', game)];
  const processes = [{ pid: 42, name: 'nekopara', windowTitle: 'X', exePath: 'C:\\NewLocation\\nekopara.exe' }];
  const result = matchRunningProcesses(processes, profiles, 'p1');
  const pass = result.resolved === null && result.needsPathConfirm !== null
    && result.needsPathConfirm.profileId === 'p1'
    && result.needsPathConfirm.savedExePath === 'D:\\OldLocation\\nekopara.exe'
    && result.needsPathConfirm.foundExePath === 'C:\\NewLocation\\nekopara.exe'
    && result.needsPathConfirm.processName === 'nekopara';
  return { pass, actual: result };
}, "Lyca's explicit decision, blindable regression: a filename-only coincidence must NEVER silently re-point a profile at a different exe — always needsPathConfirm, always a click. processName is carried so the renderer can build a full process object for set-profile-game without a second round-trip.");

check('name-match-with-dirname-tiebreak-disambiguates-two-candidates', () => {
  const gameA = { exePath: 'C:\\Games\\ProjA\\Game.exe', exeName: 'game.exe', dirName: 'proja' };
  const gameB = { exePath: 'D:\\Games\\ProjB\\Game.exe', exeName: 'game.exe', dirName: 'projb' };
  const profiles = [profileWithGame('a', 'Project A', gameA), profileWithGame('b', 'Project B', gameB)];
  // The game moved but kept the SAME parent dir name ("proja") on a
  // different drive letter — dirName should disambiguate to profile A.
  const processes = [{ pid: 7, name: 'game', windowTitle: 'X', exePath: 'E:\\Relocated\\ProjA\\Game.exe' }];
  const result = matchRunningProcesses(processes, profiles, 'a');
  const pass = result.needsPathConfirm !== null && result.needsPathConfirm.profileId === 'a' && result.ambiguous.length === 0;
  return { pass, actual: result };
});

check('name-match-two-candidates-no-dirname-tiebreak-is-ambiguous-not-two-banners', () => {
  const gameA = { exePath: 'C:\\Games\\ProjA\\Game.exe', exeName: 'game.exe', dirName: 'proja' };
  const gameB = { exePath: 'D:\\Games\\ProjB\\Game.exe', exeName: 'game.exe', dirName: 'projb' };
  const profiles = [profileWithGame('a', 'Project A', gameA), profileWithGame('b', 'Project B', gameB)];
  // Neither profile's dirName ("proja"/"projb") matches this process's
  // ("elsewhere") — genuinely ambiguous, nothing should be proposed.
  const processes = [{ pid: 7, name: 'game', windowTitle: 'X', exePath: 'E:\\Elsewhere\\Game.exe' }];
  const result = matchRunningProcesses(processes, profiles, 'a');
  const pass = result.resolved === null && result.needsPathConfirm === null && result.suggestion === null
    && result.ambiguous.length === 2
    && result.ambiguous.some((c) => c.profileId === 'a') && result.ambiguous.some((c) => c.profileId === 'b');
  return { pass, actual: result };
}, 'Two mutually-exclusive re-link candidates must never surface as two competing confirmation banners — ambiguous means propose NOTHING, not guess.');

check('active-profile-wins-over-other-profile-on-tie', () => {
  // Two DIFFERENT processes present, one matching the active profile
  // exactly, one matching another — the active one's exact match must be
  // found (order of iteration favors whichever process appears first that
  // has ANY match; this fixture puts the active match first to pin that
  // the function does not need to scan every process before deciding).
  const activeGame = { exePath: 'C:\\Games\\Active\\a.exe', exeName: 'a.exe', dirName: 'active' };
  const otherGame = { exePath: 'C:\\Games\\Other\\b.exe', exeName: 'b.exe', dirName: 'other' };
  const profiles = [profileWithGame('active', 'Active', activeGame), profileWithGame('other', 'Other', otherGame)];
  const processes = [
    { pid: 1, name: 'a', windowTitle: 'X', exePath: 'C:\\Games\\Active\\a.exe' },
    { pid: 2, name: 'b', windowTitle: 'Y', exePath: 'C:\\Games\\Other\\b.exe' }
  ];
  const result = matchRunningProcesses(processes, profiles, 'active');
  return { pass: result.resolved !== null && result.resolved.pid === 1, actual: result };
});

// ─── normalizeTitle ─────────────────────────────────────────────────────
check('normalize-title-case-and-punctuation-insensitive', () => {
  const pass = normalizeTitle('NEKOPARA Vol. 1') === normalizeTitle('Nekopara Vol.1');
  return { pass, actual: [normalizeTitle('NEKOPARA Vol. 1'), normalizeTitle('Nekopara Vol.1')] };
});

check('normalize-title-strips-runtime-noise-tokens', () => {
  const noisy = normalizeTitle('Nekopara Vol. 1 - v1.03 [Steam]');
  const clean = normalizeTitle('Nekopara Vol. 1');
  return { pass: noisy === clean, actual: [noisy, clean] };
});

check('normalize-title-cuts-at-first-separator', () => {
  const pass = normalizeTitle('Game - Direct3D 11') === normalizeTitle('Game');
  return { pass, actual: [normalizeTitle('Game - Direct3D 11'), normalizeTitle('Game')] };
});

check('normalize-title-strips-paused-suffix', () => {
  const pass = normalizeTitle('MyGame (Paused)') === normalizeTitle('MyGame');
  return { pass, actual: [normalizeTitle('MyGame (Paused)'), normalizeTitle('MyGame')] };
});

check('normalize-title-full-width-latin-nfkc', () => {
  // Full-width Latin ("Ｎｅｋｏｐａｒａ") is common in JP-sourced window
  // titles — NFKC must fold it to the same normal form as regular ASCII.
  const pass = normalizeTitle('Ｎｅｋｏｐａｒａ') === normalizeTitle('Nekopara');
  return { pass, actual: [normalizeTitle('Ｎｅｋｏｐａｒａ'), normalizeTitle('Nekopara')] };
});

// ─── compareTitles: strict, no fuzzy ────────────────────────────────────
check('compare-titles-exact-after-normalization', () => {
  const pass = compareTitles('NEKOPARA Vol. 1', 'Nekopara Vol.1 - v1.03 [Steam]') === 'exact';
  return { pass };
});

check('compare-titles-prefix-with-enough-length', () => {
  const pass = compareTitles('Nekopara', 'Nekopara Vol. 1') === 'prefix';
  return { pass };
});

check('compare-titles-rejects-steinsgate-vs-steinsgate-zero', () => {
  // THE case that justifies not using fuzzy matching, and the digit guard
  // in compareTitles: after normalizeTitle folds punctuation, "steins
  // gate" IS a raw string-prefix of "steins gate 0" — but these are TWO
  // DIFFERENT GAMES in the same franchise, not the same title spelled more
  // fully (contrast with 'compare-titles-prefix-with-enough-length' below,
  // where "Nekopara" -> "Nekopara Vol. 1" IS the same game). A wrong
  // suggestion here would let a profile's PID resolution silently attach
  // to the wrong title forever.
  const result = compareTitles('Steins;Gate', 'Steins;Gate 0');
  return { pass: result === null, actual: result };
}, 'The digit-guard in compareTitles: a bare number immediately following the shared prefix signals a distinct numbered entry, not a fuller spelling of the same title.');

check('compare-titles-short-prefix-below-threshold-rejected', () => {
  const result = compareTitles('Ao', 'Aokana');
  return { pass: result === null, actual: result };
}, 'A 2-character prefix is far too short to be a signal — below PREFIX_MATCH_MIN_LEN_LATIN.');

check('compare-titles-unrelated-titles-null', () => {
  const result = compareTitles('Nekopara', 'Fate/Stay Night');
  return { pass: result === null, actual: result };
});

check('compare-titles-empty-string-is-null', () => {
  const pass = compareTitles('', 'Nekopara') === null && compareTitles('Nekopara', '') === null;
  return { pass };
});

check('compare-titles-cjk-prefix-shorter-threshold', () => {
  // CJK titles carry far more information per character — a 3-character
  // CJK prefix is a much stronger signal than 3 Latin characters.
  const result = compareTitles('ネコぱら', 'ネコぱらVol.1');
  return { pass: result === 'prefix', actual: result };
});

function run() {
  const args = parseArgs(process.argv.slice(2));
  const results = CHECKS.map((c) => {
    let outcome;
    try {
      outcome = c.fn();
    } catch (e) {
      outcome = { pass: false, error: e.message };
    }
    return { id: c.id, note: c.note, ...outcome };
  });

  console.log(`${C.bold}game-identity.js bench${C.reset} — ${results.length} case(s)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  process.exit(passed === results.length ? 0 : 1);
}

run();
