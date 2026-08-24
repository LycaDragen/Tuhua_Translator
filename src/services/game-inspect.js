/**
 * Game Inspect — composes detectGameEngine() + detectExeArch() into one
 * stable summary (auto-configuración de juegos, Fase C).
 *
 * Written pure on purpose — no Electron, fs injectable — exactly like the
 * two modules it wraps (game-engine-detect.js, pe-arch.js). Exists as its
 * own module rather than inlined at each call site because THREE different
 * callers need the same result and must never be allowed to disagree about
 * its shape: TextractorLauncher's proactive engine advisory
 * (_detectAndEmitGameEngine), the `inspect-game` IPC handler the game
 * picker/scan-known-games call from the renderer, and the `engine`/`arch`
 * snapshot written onto profile.game at link time (game-identity.js's
 * buildGameRecord). Before this module, only the launcher called
 * detectGameEngine() directly; a second call site copy-pasting the same
 * logic is exactly how the launcher's `_lastEngineAdvice`
 * (detectGameEngine's raw, wider shape) and a profile's cached `game.engine`
 * (whatever a second implementation happened to produce) would eventually
 * drift into two different shapes for "the same" advisory.
 *
 * toEngineSummary() is deliberately narrower than detectGameEngine()'s full
 * return value (which also carries Unity-specific legacy fields consumed by
 * xuat-installer.js/ipc-handlers.js's xuat-detect-game — those keep calling
 * detectGameEngine() directly, unchanged) — it emits exactly the fields
 * renderer.js's renderEngineAdvice() reads (engine, engineLabel,
 * recommendedMethod, adviceKey), plus family/confidence/textractorWorks for
 * the profile-card badge and future callers, and nothing else.
 */

const path = require('path');
const { detectGameEngine } = require('./game-engine-detect');
const { detectExeArch } = require('./pe-arch');

/**
 * Narrows a detectGameEngine() result to the stable summary shape shared
 * by the profile's `game.engine` field and every renderer advisory. The
 * anti-annoyance confidence gate (adviceKey only set at confidence:'high')
 * already lives in detectGameEngine() itself — this is a pure projection,
 * it doesn't re-derive or second-guess that gate.
 *
 * @param {ReturnType<typeof detectGameEngine>} detectResult
 * @returns {{engine:string, engineLabel:string|null, family:string|null, confidence:string, recommendedMethod:string|null, textractorWorks:boolean|null, adviceKey:string|null}}
 */
function toEngineSummary(detectResult) {
  return {
    engine: detectResult.engine,
    engineLabel: detectResult.engineLabel,
    family: detectResult.family,
    confidence: detectResult.confidence,
    recommendedMethod: detectResult.recommendedMethod,
    textractorWorks: detectResult.textractorWorks,
    adviceKey: detectResult.adviceKey
  };
}

/**
 * The one-stop inspection for a game .exe: engine summary + PE
 * architecture. Never throws — both underlying detectors are fail-silent
 * by design (detectGameEngine catches internally and falls back to
 * 'unknown'; detectExeArch returns null on any I/O/parse failure), so this
 * degrades the same way: an unreadable/nonexistent path yields
 * `engine.engine === 'unknown'` and `arch === null`, never an exception.
 *
 * @param {string} exePath
 * @param {{existsSync?:Function, readdirSync?:Function, fsImpl?:object}} [deps] - injectable, for tests
 * @returns {{exePath:string, exeName:string, dirName:string, engine: ReturnType<typeof toEngineSummary>, arch: 'x86'|'x64'|null}}
 */
function inspectGame(exePath, deps = {}) {
  const engineDetectDeps = {};
  if (deps.existsSync) engineDetectDeps.existsSync = deps.existsSync;
  if (deps.readdirSync) engineDetectDeps.readdirSync = deps.readdirSync;

  const detectResult = detectGameEngine(exePath, engineDetectDeps);
  const arch = detectExeArch(exePath, deps.fsImpl);

  return {
    exePath,
    exeName: path.win32.basename(exePath).toLowerCase(),
    dirName: path.win32.basename(path.win32.dirname(exePath)).toLowerCase(),
    engine: toEngineSummary(detectResult),
    arch
  };
}

module.exports = { toEngineSummary, inspectGame };
