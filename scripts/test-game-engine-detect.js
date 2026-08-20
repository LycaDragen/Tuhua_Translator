/**
 * detectGameEngine bench — pure marker-matching logic, no Electron, no disk I/O.
 * See src/services/game-engine-detect.js for the full rationale (the Amorous/
 * FNA case that motivated this, the precedence order, the anti-annoyance rule).
 *
 *   node scripts/test-game-engine-detect.js
 *   node scripts/test-game-engine-detect.js --quiet
 */
const path = require('path');
const { detectGameEngine } = require(path.join('..', 'src', 'services', 'game-engine-detect.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

// ─── Fake filesystem: a plain map of dirPath -> entry names, no disk touched ──
// Posix-style paths on purpose ('/game/...') so this runs identically on the
// Linux/WSL dev box and wherever CI lands — the real production paths are
// Windows, but that's exercised through `path`'s own join/dirname/basename,
// not through these fixtures.
function makeFakeFs(tree) {
  return {
    readdirSync: (dir) => {
      if (!(dir in tree)) {
        const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return tree[dir];
    },
    existsSync: (p) => {
      if (p in tree) return true; // p is itself a known directory
      const dir = path.dirname(p);
      const base = path.basename(p);
      return dir in tree && tree[dir].includes(base);
    }
  };
}

const throwingDeps = {
  readdirSync: () => { throw new Error('fixture: fs unavailable'); },
  existsSync: () => { throw new Error('fixture: fs unavailable'); }
};

const LEGACY_FIELDS = ['isUnity', 'gameDir', 'gameName', 'dataDir', 'hasUnityPlayer', 'hasManaged', 'isIL2CPP'];

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const CASES = [
  // ─── The real case that motivated this module ───────────────────────────
  { id: 'fna-amorous-real-case',
    exePath: '/game/Amorous.exe',
    fs: makeFakeFs({ '/game': ['Amorous.exe', 'FNA.dll', 'Squid.dll', 'SDL2.dll', 'FAudio.dll', 'FNA3D.dll', 'Content'] }),
    expected: { engine: 'fna', family: 'xna', confidence: 'high', recommendedMethod: 'ocr', textractorWorks: false, adviceKey: 'engine_advice_xna' },
    note: 'Amorous itself — FNA.dll present, plus its corroborants. Squid.dll is deliberately NOT a marker (third-party UI lib, does not identify the engine).' },

  { id: 'monogame',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'MonoGame.Framework.dll'] }),
    expected: { engine: 'monogame', family: 'xna', recommendedMethod: 'ocr', adviceKey: 'engine_advice_xna' } },

  { id: 'monogame-desktopgl-variant-name',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'MonoGame.Framework.DesktopGL.dll'] }),
    expected: { engine: 'monogame' },
    note: 'the regex must match MonoGame.Framework.*.dll, not just the exact base filename.' },

  { id: 'xna-4',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Microsoft.Xna.Framework.dll', 'Microsoft.Xna.Framework.Game.dll'] }),
    expected: { engine: 'xna', family: 'xna', recommendedMethod: 'ocr', adviceKey: 'engine_advice_xna' } },

  // ─── Unity ────────────────────────────────────────────────────────────────
  { id: 'unity-mono',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({
      '/game': ['Game.exe', 'Game_Data', 'UnityPlayer.dll'],
      '/game/Game_Data': ['Managed'],
      '/game/Game_Data/Managed': ['Assembly-CSharp.dll']
    }),
    expected: { engine: 'unity-mono', family: 'unity', recommendedMethod: 'xuat', textractorWorks: null, adviceKey: 'engine_advice_unity', isUnity: true, isIL2CPP: false, hasManaged: true } },

  { id: 'unity-il2cpp-gameassembly',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Game_Data', 'GameAssembly.dll'], '/game/Game_Data': [] }),
    expected: { engine: 'unity-il2cpp', isIL2CPP: true } },

  { id: 'unity-il2cpp-metadata-only',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({
      '/game': ['Game.exe', 'Game_Data'],
      '/game/Game_Data': [], // deliberately does NOT list il2cpp_data — pins the 4th (deepest) detection check independently of the 3rd
      '/game/Game_Data/il2cpp_data/Metadata/global-metadata.dat': []
    }),
    expected: { engine: 'unity-il2cpp', isIL2CPP: true } },

  { id: 'unity-il2cpp-case-insensitive',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Game_Data'], '/game/Game_Data': ['IL2CPPAssemblies'] }),
    expected: { engine: 'unity-il2cpp', isIL2CPP: true },
    note: 'pins the .toLowerCase() matching carried over from the pre-v3.13.76 detectUnityGame.' },

  { id: 'unity-wins-over-stray-monogame-dll',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Game_Data', 'MonoGame.Framework.dll'], '/game/Game_Data': [] }),
    expected: { engine: 'unity-mono' },
    note: 'THE false positive the precedence order exists to prevent — Game_Data/ is checked before the XNA family, so it wins even with a stray MonoGame DLL sitting in the folder.' },

  // ─── Ren'Py / Godot ───────────────────────────────────────────────────────
  { id: 'renpy',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Game.py', 'renpy', 'game', 'lib'] }),
    expected: { engine: 'renpy', family: 'renpy', recommendedMethod: 'ocr', adviceKey: 'engine_advice_renpy' } },

  { id: 'godot',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Game.pck'] }),
    expected: { engine: 'godot', family: 'godot', recommendedMethod: 'ocr', adviceKey: 'engine_advice_godot' } },

  // ─── Anti-annoyance rule: no advice without high confidence ─────────────
  { id: 'no-advice-on-medium-confidence',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'Content'], '/game/Content': ['music.xnb'] }),
    expected: { engine: 'unknown', family: 'xna', confidence: 'medium', adviceKey: null, recommendedMethod: null },
    note: 'compiled .xnb content but no engine DLL matched — corroborant-only evidence must NOT trigger the advisory (the whole point of the confidence tier).' },

  { id: 'unknown-bare-dir',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe'] }),
    expected: { engine: 'unknown', confidence: 'low', adviceKey: null } },

  { id: 'unknown-kirikiri',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({ '/game': ['Game.exe', 'data.xp3'] }),
    expected: { engine: 'unknown', adviceKey: null },
    note: 'pin: v1 does not invent an advisory for engines it does not cover (Textractor DOES work here — silence is correct, not a gap).' },

  // ─── Failure mode ─────────────────────────────────────────────────────────
  { id: 'fs-throws-does-not-propagate',
    exePath: '/game/Game.exe',
    fs: throwingDeps,
    expected: { engine: 'unknown', adviceKey: null },
    expectErrorPresent: true,
    note: 'a fully broken fs (permissions, race with the game process exiting) must degrade to unknown+error, never throw out of detectGameEngine — same contract as _checkPidIsRunning\'s null return.' },

  // ─── Compatibility guard for the xuat-installer.js refactor ─────────────
  { id: 'legacy-shape-compat',
    exePath: '/game/Game.exe',
    fs: makeFakeFs({
      '/game': ['Game.exe', 'Game_Data', 'UnityPlayer.dll'],
      '/game/Game_Data': ['Managed'],
      '/game/Game_Data/Managed': []
    }),
    checkLegacyShape: true,
    note: 'runFullInstall and the xuat-detect-game IPC handler only ever read these 7 fields off the old detectUnityGame() — this pins the delegate shim keeps them present with the right types.' }
];

function run() {
  const args = parseArgs(process.argv.slice(2));
  const results = CASES.map((c) => {
    const actual = detectGameEngine(c.exePath, c.fs);
    const failures = [];

    if (c.checkLegacyShape) {
      if (typeof actual.isUnity !== 'boolean') failures.push('isUnity not boolean');
      if (typeof actual.gameDir !== 'string') failures.push('gameDir not string');
      if (typeof actual.gameName !== 'string') failures.push('gameName not string');
      if (actual.dataDir !== null && typeof actual.dataDir !== 'string') failures.push('dataDir not string|null');
      if (typeof actual.hasUnityPlayer !== 'boolean') failures.push('hasUnityPlayer not boolean');
      if (typeof actual.hasManaged !== 'boolean') failures.push('hasManaged not boolean');
      if (typeof actual.isIL2CPP !== 'boolean') failures.push('isIL2CPP not boolean');
      for (const f of LEGACY_FIELDS) if (!(f in actual)) failures.push(`missing legacy field: ${f}`);
    } else {
      for (const [key, val] of Object.entries(c.expected || {})) {
        const got = actual[key];
        const ok = Array.isArray(val) ? arraysEqual(got, val) : got === val;
        if (!ok) failures.push(`${key}: expected ${JSON.stringify(val)}, got ${JSON.stringify(got)}`);
      }
      if (c.expectErrorPresent && !actual.error) failures.push('expected `error` field to be present');
    }

    return { id: c.id, pass: failures.length === 0, failures, actual, note: c.note };
  });

  console.log(`${C.bold}detectGameEngine bench${C.reset} — ${results.length} case(s)\n`);
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
