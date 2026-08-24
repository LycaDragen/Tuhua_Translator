/**
 * game-inspect.js bench — composition of detectGameEngine + detectExeArch,
 * no Electron. See src/services/game-inspect.js for the full rationale
 * (why this exists as its own module: three call sites — the launcher's
 * proactive advisory, the `inspect-game` IPC handler, and profile.game's
 * cached engine/arch snapshot — must never be allowed to drift into
 * different shapes for "the same" advisory).
 *
 * The load-bearing assertion here is
 * 'to-engine-summary-emits-exactly-what-renderEngineAdvice-reads': if this
 * drifts, either the advisory silently stops rendering (a field it needs
 * got dropped) or a stray field leaks through that a future edit might
 * start relying on without the anti-annoyance confidence gate applying to
 * it.
 *
 *   node scripts/test-game-inspect.js
 *   node scripts/test-game-inspect.js --quiet
 */
const path = require('path');
const { toEngineSummary, inspectGame } = require(path.join('..', 'src', 'services', 'game-inspect.js'));
const { detectGameEngine } = require(path.join('..', 'src', 'services', 'game-engine-detect.js'));

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

// Same fake-fs shape as test-game-engine-detect.js (posix-style paths —
// path.dirname/basename semantics, not the win32 module).
function makeFakeEngineFs(tree) {
  return {
    readdirSync: (dir) => {
      if (!(dir in tree)) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return tree[dir];
    },
    existsSync: (p) => {
      if (p in tree) return true;
      const dir = path.dirname(p);
      const base = path.basename(p);
      return dir in tree && tree[dir].includes(base);
    }
  };
}

// Same fake-fs shape as test-pe-arch.js's detectExeArch fixtures.
function makeFakePeFs(files) {
  return {
    openSync(p) {
      if (!(p in files)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return p;
    },
    readSync(fd, buffer, offset, length, position) {
      const data = files[fd];
      const n = Math.min(length, data.length - position);
      data.copy(buffer, offset, position, position + Math.max(0, n));
      return Math.max(0, n);
    },
    closeSync() { /* no-op */ }
  };
}

function buildPeBuffer({ peOffset = 0x80, machine } = {}) {
  const buf = Buffer.alloc(0x200);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE', peOffset, 'ascii');
  buf.writeUInt16LE(machine, peOffset + 4);
  return buf;
}

const MACHINE_I386 = 0x14c;

// ─── toEngineSummary: the load-bearing shape contract ──────────────────
check('to-engine-summary-emits-exactly-what-renderEngineAdvice-reads', () => {
  // renderEngineAdvice() (renderer.js) reads: adviceKey, engineLabel,
  // engine, recommendedMethod. applyEngineAdvice() reads recommendedMethod.
  // family/confidence/textractorWorks are the extra fields the profile
  // card / future callers use — nothing beyond this set should exist.
  const detectResult = detectGameEngine('/game/renpy/x.exe', makeFakeEngineFs({
    '/game/renpy': ['renpy', 'game']
  }));
  const summary = toEngineSummary(detectResult);
  const expectedKeys = ['engine', 'engineLabel', 'family', 'confidence', 'recommendedMethod', 'textractorWorks', 'adviceKey'].sort();
  const actualKeys = Object.keys(summary).sort();
  return { pass: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys), actual: actualKeys, expected: expectedKeys };
});

check('to-engine-summary-renpy-carries-the-advice', () => {
  const detectResult = detectGameEngine('/game/renpy/x.exe', makeFakeEngineFs({
    '/game/renpy': ['renpy', 'game']
  }));
  const summary = toEngineSummary(detectResult);
  const pass = summary.engine === 'renpy' && summary.engineLabel === "Ren'Py"
    && summary.recommendedMethod === 'clipboard' && summary.textractorWorks === false
    && summary.adviceKey === 'engine_advice_renpy';
  return { pass, actual: summary };
});

check('to-engine-summary-unknown-never-carries-an-advice-key', () => {
  const detectResult = detectGameEngine('/game/plain/x.exe', makeFakeEngineFs({ '/game/plain': [] }));
  const summary = toEngineSummary(detectResult);
  const pass = summary.engine === 'unknown' && summary.adviceKey === null;
  return { pass, actual: summary };
});

check('to-engine-summary-medium-confidence-corroborant-never-carries-an-advice-key', () => {
  // Content/*.xnb with no engine DLL — corroborant-only evidence,
  // confidence:'medium', deliberately silent (game-engine-detect.js's own
  // anti-annoyance rule). This must survive the narrowing projection.
  const detectResult = detectGameEngine('/game/plain/x.exe', makeFakeEngineFs({
    '/game/plain': ['Content'],
    '/game/plain/Content': ['music.xnb']
  }));
  const summary = toEngineSummary(detectResult);
  const pass = summary.confidence === 'medium' && summary.adviceKey === null;
  return { pass, actual: summary };
});

// ─── inspectGame: composition, never throws ────────────────────────────
check('inspect-game-composes-engine-and-arch', () => {
  const engineFs = makeFakeEngineFs({ '/game/renpy': ['renpy', 'game'] });
  const peBuf = buildPeBuffer({ machine: MACHINE_I386 });
  const peFs = makeFakePeFs({ '/game/renpy/x.exe': peBuf });
  const result = inspectGame('/game/renpy/x.exe', { ...engineFs, fsImpl: peFs });
  const pass = result.engine.engine === 'renpy' && result.arch === 'x86' && result.exePath === '/game/renpy/x.exe';
  return { pass, actual: result };
});

check('inspect-game-exe-name-and-dir-name-are-lowercased-basenames', () => {
  // Deliberately a Windows-style backslash path, unlike the posix-style
  // fixtures elsewhere in this file — this test is specifically about
  // inspectGame()'s OWN win32 basename/dirname parsing (exeName/dirName),
  // which uses path.win32 explicitly regardless of host platform, not
  // about game-engine-detect.js's internal marker matching (which uses
  // the default `path` module and, on this Linux/WSL dev box, can't
  // resolve a backslash path — harmless here since it only ever falls
  // back to an ENOENT-logged 'unknown' engine, which this test ignores).
  const engineFs = makeFakeEngineFs({});
  const result = inspectGame('C:\\Games\\Nekopara\\Nekopara.EXE', engineFs);
  const pass = result.exeName === 'nekopara.exe' && result.dirName === 'nekopara';
  return { pass, actual: result };
});

check('inspect-game-arch-is-null-when-pe-unreadable-without-throwing', () => {
  const engineFs = makeFakeEngineFs({ '/game/plain': [] });
  const peFs = makeFakePeFs({}); // exe not present in the fake PE fs
  let threw = false;
  let result;
  try {
    result = inspectGame('/game/plain/x.exe', { ...engineFs, fsImpl: peFs });
  } catch (e) { threw = true; }
  return { pass: !threw && result.arch === null, actual: result };
});

check('inspect-game-nonexistent-dir-yields-unknown-engine-without-throwing', () => {
  const engineFs = makeFakeEngineFs({}); // readdirSync throws ENOENT for any dir
  let threw = false;
  let result;
  try {
    result = inspectGame('/nowhere/x.exe', engineFs);
  } catch (e) { threw = true; }
  return { pass: !threw && result.engine.engine === 'unknown' && result.engine.adviceKey === null, actual: result };
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

  console.log(`${C.bold}game-inspect.js bench${C.reset} — ${results.length} case(s)\n`);
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
