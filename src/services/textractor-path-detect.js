/**
 * v3.13.8x (settings UX audit, Fase 5): auto-detects an existing
 * Textractor install so a first-time Textractor user doesn't have to
 * manually browse to it — see the plan's Fase 5 for the reasoning behind
 * each candidate. Textractor (github.com/Artikash/Textractor) ships as a
 * bare ZIP with no installer, so there's no registry key or fixed install
 * location to query; this is a short, deliberately curated list of where
 * people actually put it, not a disk crawl.
 *
 * Split into three pure/testable layers so the one thing that genuinely
 * needs real Windows to verify (does `validatePath()` actually accept
 * what gets found) stays isolated from the parts that don't:
 *   1. buildCandidates() — pure, no fs access at all.
 *   2. resolveCandidateDirs() — fs-dependent but takes an injectable fs,
 *      so it's testable with a fake filesystem.
 *   3. findTextractorInstall() — takes an injectable validatePath function
 *      (TextractorLauncher#validatePath in production) so a resolved
 *      candidate is verified through the EXACT same check
 *      `textractor-browse-cli` already runs on a manually-picked path —
 *      this is what guards against a stale/dead path surviving a
 *      reinstall (see this file's own header note in the plan).
 */
// v3.13.8x: `path.win32`, not the platform-default `path` — every path
// this module builds (C:\Textractor, %LOCALAPPDATA%\...) is unambiguously
// a Windows path regardless of what OS actually runs this code (it's only
// ever invoked in production behind the win32 guards in its callers, but
// forcing win32 semantics here means the module behaves identically when
// developed/tested from Linux/WSL too — plain `path.join` silently
// produces mixed \/ separators on a POSIX host, which is exactly the kind
// of bug that stays invisible until someone runs the real thing on
// Windows).
const path = require('path').win32;
const fs = require('fs');
const os = require('os');

/**
 * Computes the `bases` object autoDetectTextractorPath() needs, from real
 * env vars — shared by both call sites (app startup, the save-settings
 * input-method-switch handler) so the actual base-path logic lives in one
 * place. `os.homedir()`/`process.env` resolve to something on any OS, but
 * this is only ever meaningfully CALLED behind a `process.platform ===
 * 'win32'` guard in production, same as every other Textractor path in
 * this codebase — not guarded here too, since a caller on a non-Windows
 * dev machine harmlessly gets bases that just won't match anything real.
 * `tuhuaExePath` is `app.getPath('exe')` — passed in rather than required
 * directly so this file never needs `electron` itself, keeping it plain-
 * Node testable (see the bench in scripts/test-textractor-path-detect.js).
 */
function computeBases({ tuhuaExePath } = {}) {
  return {
    homedir: os.homedir(),
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env['ProgramFiles'],
    programFilesX86: process.env['ProgramFiles(x86)'],
    tuhuaDir: tuhuaExePath ? path.dirname(tuhuaExePath) : undefined
  };
}

/**
 * Pure — no fs access, so a straight list-equality test covers it
 * completely. Order is the actual search/preference order: first valid
 * match wins (see findTextractorInstall()). Two entries are glob PREFIXES
 * (folder name starts with "textractor", case-insensitive) rather than
 * exact paths, since the GitHub release ZIP doesn't unpack to one fixed
 * name (e.g. "Textractor-master", "Textractor 5.4.0", plain "Textractor").
 * All the base paths are optional — a caller missing one (an env var not
 * set) just gets fewer candidates, never a thrown error.
 */
function buildCandidates({ homedir, localAppData, programFiles, programFilesX86, tuhuaDir } = {}) {
  const candidates = [];
  if (homedir) {
    candidates.push({ type: 'glob', dir: path.join(homedir, 'Downloads'), prefix: 'textractor' });
    candidates.push({ type: 'glob', dir: path.join(homedir, 'Desktop'), prefix: 'textractor' });
  }
  candidates.push({ type: 'exact', dir: 'C:\\Textractor' });
  if (programFiles) candidates.push({ type: 'exact', dir: path.join(programFiles, 'Textractor') });
  if (programFilesX86) candidates.push({ type: 'exact', dir: path.join(programFilesX86, 'Textractor') });
  if (localAppData) candidates.push({ type: 'exact', dir: path.join(localAppData, 'Programs', 'Textractor') });
  if (tuhuaDir) candidates.push({ type: 'exact', dir: path.join(tuhuaDir, 'Textractor') });
  return candidates;
}

/**
 * Expands buildCandidates()'s output into real, existing directory paths.
 * `fsImpl` defaults to real `fs` in production but accepts a fake
 * `{existsSync, readdirSync}` for tests — no real disk access needed to
 * verify the glob-matching/ordering logic. A directory that doesn't exist,
 * or a readdir that throws (permissions, race with deletion), is silently
 * skipped rather than surfaced — this runs unattended at startup/on an
 * input-method switch, not in response to a user action that deserves its
 * own error.
 */
function resolveCandidateDirs(candidates, fsImpl = fs) {
  const dirs = [];
  for (const c of candidates) {
    if (c.type === 'exact') {
      if (fsImpl.existsSync(c.dir)) dirs.push(c.dir);
      continue;
    }
    if (!fsImpl.existsSync(c.dir)) continue;
    let entries;
    try {
      entries = fsImpl.readdirSync(c.dir);
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith(c.prefix)) {
        dirs.push(path.join(c.dir, entry));
      }
    }
  }
  return dirs;
}

/**
 * Runs `validatePathFn` (TextractorLauncher#validatePath in production —
 * the identical function `textractor-browse-cli`'s manual "Examinar" flow
 * already uses) against each resolved candidate directory, in order,
 * returning the first one that checks out. A candidate that resolves to a
 * directory but has no real Textractor(CLI).exe inside it (a stale folder
 * left over from a reinstall, an unrelated app someone also named
 * "Textractor") is never returned — `validatePathFn` itself is what
 * verifies the .exe is real, so this can't produce a ghost path any more
 * than the manual browse flow can.
 */
function findTextractorInstall(candidates, fsImpl, validatePathFn) {
  const dirs = resolveCandidateDirs(candidates, fsImpl);
  for (const dir of dirs) {
    let result;
    try {
      result = validatePathFn(dir);
    } catch (e) {
      continue;
    }
    if (result && result.valid) {
      return { found: true, path: result.resolved };
    }
  }
  return { found: false };
}

/**
 * Convenience wrapper combining all three layers for production callers —
 * both integration points (app startup in src/main/index.js, and the
 * save-settings input-method-switch handler in ipc-handlers.js) go through
 * this rather than calling the three pieces separately.
 */
function autoDetectTextractorPath(bases, validatePathFn, fsImpl = fs) {
  const candidates = buildCandidates(bases);
  return findTextractorInstall(candidates, fsImpl, validatePathFn);
}

/**
 * Full orchestration shared by both call sites — app startup
 * (src/main/index.js) and the save-settings input-method-switch handler
 * (ipc-handlers.js): compute bases, search, and on a match PERSIST it
 * (store.set) and CONFIGURE the live launcher — the exact same two side
 * effects a manual "Examinar" pick already triggers, so an auto-detected
 * path behaves identically to a hand-picked one from this point on.
 * Returns `{found, path?}` either way so the caller can surface it (a
 * toast, or nothing if the caller decides silence is fine for its
 * trigger) — this function itself never touches the renderer.
 */
function runAutoDetectAndPersist({ store, textractorLauncher, tuhuaExePath }) {
  const bases = computeBases({ tuhuaExePath });
  const result = autoDetectTextractorPath(bases, textractorLauncher.validatePath.bind(textractorLauncher));
  if (result.found) {
    store.set({ ...store.get(), textractorCliPath: result.path });
    textractorLauncher.configure(result.path);
  }
  return result;
}

module.exports = {
  buildCandidates, resolveCandidateDirs, findTextractorInstall, autoDetectTextractorPath, computeBases,
  runAutoDetectAndPersist
};
