/**
 * textractor-path-detect.js bench (settings UX audit, Fase 5) — the
 * auto-detection candidate list, glob expansion, and validation-injection
 * logic behind "found Textractor at X" on first launch. Pure/fake-fs
 * testable end to end; whether app.getPath('exe')/process.env resolve to
 * something sane, and whether TextractorLauncher#validatePath's real PE
 * parsing accepts a genuine install, can only be verified on real Windows.
 *
 *   node scripts/test-textractor-path-detect.js
 *   node scripts/test-textractor-path-detect.js --quiet
 */
const posixPath = require('path');
// v3.13.8x: path.win32 (NOT the platform-default posixPath above) — see
// textractor-path-detect.js's own header comment for why. This test
// constructs the SAME expected strings the source module builds, so it
// needs the same forced win32 semantics: plain `path.join` on a Linux/WSL
// dev host would silently produce mixed \/ separators and desync from
// what the source actually returns. Kept as a separate identifier from
// posixPath above because the require() call right below needs REAL
// (POSIX-style, on this host) path joining to find the module on disk —
// win32-joining a relative require path would break it.
const path = require('path').win32;
const {
  buildCandidates, resolveCandidateDirs, findTextractorInstall, autoDetectTextractorPath, computeBases
} = require(posixPath.join('..', 'src', 'services', 'textractor-path-detect.js'));

const { makeEagerCheckRegistry } = require('./lib/bench.js');
const { check, report } = makeEagerCheckRegistry();

// A minimal in-memory fake filesystem: {existsSync, readdirSync} backed by
// a plain object mapping directory path -> array of entry names. A path
// present as a key exists; anything else doesn't. No real disk touched.
function fakeFs(tree) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(tree, p),
    readdirSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(tree, p)) throw new Error('ENOENT: ' + p);
      return tree[p];
    }
  };
}

// ─── buildCandidates: pure, no fs ───────────────────────────────────────
check('build-candidates-with-all-bases-returns-seven-in-search-order', () => {
  const c = buildCandidates({
    homedir: 'C:\\Users\\lyca',
    localAppData: 'C:\\Users\\lyca\\AppData\\Local',
    programFiles: 'C:\\Program Files',
    programFilesX86: 'C:\\Program Files (x86)',
    tuhuaDir: 'C:\\Tuhua'
  });
  const pass = c.length === 7
    && c[0].type === 'glob' && c[0].dir === path.join('C:\\Users\\lyca', 'Downloads')
    && c[1].type === 'glob' && c[1].dir === path.join('C:\\Users\\lyca', 'Desktop')
    && c[2].type === 'exact' && c[2].dir === 'C:\\Textractor'
    && c[3].dir === path.join('C:\\Program Files', 'Textractor')
    && c[4].dir === path.join('C:\\Program Files (x86)', 'Textractor')
    && c[5].dir === path.join('C:\\Users\\lyca\\AppData\\Local', 'Programs', 'Textractor')
    && c[6].dir === path.join('C:\\Tuhua', 'Textractor');
  return { pass, actual: c };
}, 'Downloads/Desktop first (the two most common real-world cases per the plan), C:\\Textractor next (what the manual field\'s own placeholder suggests), then the rest.');

check('build-candidates-with-no-bases-still-includes-the-hardcoded-c-textractor', () => {
  const c = buildCandidates({});
  return { pass: c.length === 1 && c[0].dir === 'C:\\Textractor', actual: c };
}, 'A missing env var (localAppData, programFiles, etc.) drops that candidate silently, never throws — the one base-less candidate always survives.');

check('build-candidates-with-undefined-argument-does-not-throw', () => {
  const c = buildCandidates();
  return { pass: Array.isArray(c) && c.length === 1, actual: c };
});

// ─── resolveCandidateDirs: fake-fs, glob expansion ──────────────────────
check('exact-candidate-that-exists-is-resolved', () => {
  const fs = fakeFs({ 'C:\\Textractor': [] });
  const dirs = resolveCandidateDirs([{ type: 'exact', dir: 'C:\\Textractor' }], fs);
  return { pass: dirs.length === 1 && dirs[0] === 'C:\\Textractor', actual: dirs };
});

check('exact-candidate-that-does-not-exist-is-dropped', () => {
  const fs = fakeFs({});
  const dirs = resolveCandidateDirs([{ type: 'exact', dir: 'C:\\Textractor' }], fs);
  return { pass: dirs.length === 0, actual: dirs };
});

check('glob-candidate-matches-case-insensitive-prefix-and-ignores-others', () => {
  const fs = fakeFs({
    'C:\\Users\\lyca\\Downloads': ['Textractor-5.4.0', 'TEXTRACTOR_master', 'my-textractor-fork', 'RandomGame', 'textra']
  });
  const dirs = resolveCandidateDirs([{ type: 'glob', dir: 'C:\\Users\\lyca\\Downloads', prefix: 'textractor' }], fs);
  // "my-textractor-fork" doesn't START with the prefix — real GitHub
  // release folders always do, and this avoids matching an unrelated
  // "some-other-textractor-based-tool" someone also has in Downloads.
  const pass = dirs.length === 2
    && dirs.includes(path.join('C:\\Users\\lyca\\Downloads', 'Textractor-5.4.0'))
    && dirs.includes(path.join('C:\\Users\\lyca\\Downloads', 'TEXTRACTOR_master'));
  return { pass, actual: dirs };
});

check('glob-candidate-whose-parent-directory-does-not-exist-yields-nothing', () => {
  const fs = fakeFs({});
  const dirs = resolveCandidateDirs([{ type: 'glob', dir: 'C:\\Users\\lyca\\Downloads', prefix: 'textractor' }], fs);
  return { pass: dirs.length === 0, actual: dirs };
}, 'A user with no Downloads folder indexed (unusual, but possible on a locked-down profile) degrades to "no match here," not a crash.');

check('readdir-throwing-mid-scan-is-swallowed-not-propagated', () => {
  const fs = {
    existsSync: () => true,
    readdirSync: () => { throw new Error('EPERM'); }
  };
  const dirs = resolveCandidateDirs([{ type: 'glob', dir: 'C:\\Locked', prefix: 'textractor' }], fs);
  return { pass: dirs.length === 0, actual: dirs };
}, 'This runs unattended (app startup, an input-method switch) — a permissions hiccup on one candidate must not take down auto-detection for the rest.');

check('resolveCandidateDirs-preserves-candidate-order-across-mixed-types', () => {
  const fs = fakeFs({
    'C:\\Users\\lyca\\Downloads': ['Textractor'],
    'C:\\Textractor': []
  });
  const dirs = resolveCandidateDirs([
    { type: 'glob', dir: 'C:\\Users\\lyca\\Downloads', prefix: 'textractor' },
    { type: 'exact', dir: 'C:\\Textractor' }
  ], fs);
  return { pass: dirs.length === 2 && dirs[0] === path.join('C:\\Users\\lyca\\Downloads', 'Textractor') && dirs[1] === 'C:\\Textractor', actual: dirs };
});

// ─── findTextractorInstall: injected validatePath, first-match-wins ────
check('first-candidate-that-validatePath-accepts-wins-even-if-later-ones-would-too', () => {
  const fs = fakeFs({ 'C:\\Textractor': [], 'C:\\Program Files\\Textractor': [] });
  const candidates = [{ type: 'exact', dir: 'C:\\Textractor' }, { type: 'exact', dir: 'C:\\Program Files\\Textractor' }];
  const validate = (dir) => ({ valid: true, resolved: path.join(dir, 'x64', 'TextractorCLI.exe') });
  const r = findTextractorInstall(candidates, fs, validate);
  return { pass: r.found === true && r.path === path.join('C:\\Textractor', 'x64', 'TextractorCLI.exe'), actual: r };
});

check('a-resolved-dir-that-validatePath-rejects-is-skipped-in-favor-of-the-next-one', () => {
  // The real-world case this guards: a stale "Textractor" folder left
  // over from a reinstall (dir exists, exe is gone) must not be returned
  // as if it were a working install — see the plan's own "no ghost paths"
  // requirement for this Fase.
  const fs = fakeFs({ 'C:\\Textractor': [], 'C:\\Program Files\\Textractor': [] });
  const candidates = [{ type: 'exact', dir: 'C:\\Textractor' }, { type: 'exact', dir: 'C:\\Program Files\\Textractor' }];
  const validate = (dir) => dir === 'C:\\Textractor'
    ? { valid: false, message: 'Path not found: C:\\Textractor\\x64\\TextractorCLI.exe' }
    : { valid: true, resolved: path.join(dir, 'x64', 'TextractorCLI.exe') };
  const r = findTextractorInstall(candidates, fs, validate);
  return { pass: r.found === true && r.path === path.join('C:\\Program Files\\Textractor', 'x64', 'TextractorCLI.exe'), actual: r };
});

check('no-candidate-resolving-to-a-valid-install-returns-found-false', () => {
  const fs = fakeFs({});
  const r = findTextractorInstall([{ type: 'exact', dir: 'C:\\Textractor' }], fs, () => ({ valid: true, resolved: 'x' }));
  return { pass: r.found === false, actual: r };
});

check('validatePath-throwing-on-one-candidate-does-not-abort-the-search', () => {
  const fs = fakeFs({ 'C:\\Textractor': [], 'C:\\Program Files\\Textractor': [] });
  const candidates = [{ type: 'exact', dir: 'C:\\Textractor' }, { type: 'exact', dir: 'C:\\Program Files\\Textractor' }];
  let calls = 0;
  const validate = (dir) => {
    calls++;
    if (dir === 'C:\\Textractor') throw new Error('unexpected PE parse error');
    return { valid: true, resolved: path.join(dir, 'x64', 'TextractorCLI.exe') };
  };
  const r = findTextractorInstall(candidates, fs, validate);
  return { pass: r.found === true && calls === 2, actual: r };
});

// ─── autoDetectTextractorPath: the full wrapper ─────────────────────────
check('autoDetectTextractorPath-wires-build-plus-resolve-plus-find-together', () => {
  const fs = fakeFs({ 'C:\\Users\\lyca\\Downloads': ['Textractor-5.4.0'] });
  const validate = (dir) => ({ valid: true, resolved: path.join(dir, 'x64', 'TextractorCLI.exe') });
  const r = autoDetectTextractorPath({ homedir: 'C:\\Users\\lyca' }, validate, fs);
  return { pass: r.found === true && r.path === path.join('C:\\Users\\lyca\\Downloads', 'Textractor-5.4.0', 'x64', 'TextractorCLI.exe'), actual: r };
});

// ─── computeBases: real env, shape-only checks ──────────────────────────
check('compute-bases-derives-tuhuaDir-as-the-parent-of-the-exe-path', () => {
  const bases = computeBases({ tuhuaExePath: 'C:\\Tuhua\\Tuhua.exe' });
  return { pass: bases.tuhuaDir === 'C:\\Tuhua', actual: bases };
});

check('compute-bases-without-a-tuhuaExePath-leaves-tuhuaDir-undefined', () => {
  const bases = computeBases({});
  return { pass: bases.tuhuaDir === undefined, actual: bases };
});

check('compute-bases-always-returns-a-real-homedir-string', () => {
  const bases = computeBases({});
  return { pass: typeof bases.homedir === 'string' && bases.homedir.length > 0, actual: bases };
}, 'os.homedir() resolves on any OS — only the CALLERS gate this behind a Windows check.');

report();
