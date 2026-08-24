/**
 * Game Identity — pure decision logic for "which profile does this running
 * process belong to?" (auto-configuración de juegos, Fase A/B/D).
 *
 * Written pure on purpose — no Electron, no I/O, no fs — so it's testable
 * in plain Node (scripts/test-game-identity.js) exactly like
 * game-engine-detect.js and pe-arch.js. This module never touches the
 * filesystem itself; game-inspect.js (which composes detectGameEngine +
 * detectExeArch) is the module that does, and callers pass its output in.
 *
 * Two independent jobs live here:
 *
 * 1. Process <-> profile matching (buildGameRecord / matchRunningProcesses)
 *    — exact path first, exeName as a Windows-only fallback, dirName only
 *    to disambiguate a shared generic exeName (`Game.exe`). A name-only
 *    match NEVER auto-resolves — see matchRunningProcesses' own doc
 *    comment for why.
 *
 * 2. Title normalization/comparison (normalizeTitle / compareTitles) — for
 *    Fase D's "does this window title look like this profile's VNDB cover
 *    title?" suggestion. Deliberately NOT fuzzy matching (no Levenshtein,
 *    no token-set scoring) — see compareTitles' own doc comment for the
 *    asymmetric-cost argument against it.
 */

const path = require('path');

// ─── Process <-> profile matching ──────────────────────────────────────

/**
 * Normalizes an exe path for COMPARISON only — never for display or
 * storage (profile.game.exePath is kept verbatim, exactly as PowerShell
 * returned it, so the user sees the same casing/slashes they'd see in
 * Explorer). Lowercased, forward slashes folded to backslashes (Textractor
 * and PowerShell both live in Windows path-land, but defend against a
 * stray `/` anyway), trailing slash stripped.
 *
 * @param {string} exePath
 * @returns {string}
 */
function normalizeExePath(exePath) {
  if (typeof exePath !== 'string') return '';
  return exePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Lowercased basename — the fallback match key when a game moves folders
 * or gets reinstalled to a different drive.
 *
 * Windows-only optimization, by construction: `list-game-processes` (the
 * only real source of the `process` argument this feeds into) is itself
 * gated to `process.platform === 'win32'` (ipc-handlers.js), and the
 * lowercasing here assumes a case-insensitive filesystem. On a
 * case-sensitive one (WSL/Linux — Lyca's own dev environment when running
 * Tuhua under WSLg) this fallback tier may simply never fire for two
 * differently-cased names that Windows would treat as identical — that's
 * fine, because the PRIMARY match key (normalizeExePath, exact path) is
 * unaffected by casing semantics either way and is what actually carries
 * this feature end to end.
 *
 * @param {string} exePath
 * @returns {string}
 */
function normalizeExeName(exePath) {
  if (typeof exePath !== 'string' || !exePath) return '';
  return path.win32.basename(exePath).toLowerCase();
}

/**
 * Lowercased basename of the PARENT directory — exists purely to
 * disambiguate the degenerate case of two profiles both linked to a
 * generic exeName like `Game.exe` (RPG Maker, older engines). Without
 * this tier, two such profiles would permanently shadow each other's
 * name-based match with no way to tell them apart.
 *
 * @param {string} exePath
 * @returns {string}
 */
function normalizeDirName(exePath) {
  if (typeof exePath !== 'string' || !exePath) return '';
  return path.win32.basename(path.win32.dirname(exePath)).toLowerCase();
}

/**
 * Builds the `game` record to write onto a profile (see
 * profile-schema.js's `game` field doc comment for the full shape
 * rationale). `process` is the shape list-game-processes/the picker
 * already produces: {pid, name, windowTitle, exePath}. `inspection` is
 * game-inspect.js's inspectGame() result (or null if unavailable) —
 * kept as a separate param rather than re-derived here because this
 * module never touches the filesystem.
 *
 * @param {{exePath:string, windowTitle?:string, name?:string}} proc
 * @param {{engine?: object|null, arch?: string|null}} [inspection]
 * @returns {object} matches profile-schema.js's `game` shape
 */
function buildGameRecord(proc, inspection = {}) {
  return {
    exePath: proc.exePath,
    exeName: normalizeExeName(proc.exePath),
    dirName: normalizeDirName(proc.exePath),
    windowTitle: typeof proc.windowTitle === 'string' ? proc.windowTitle : '',
    processName: typeof proc.name === 'string' ? proc.name : '',
    engine: inspection.engine || null,
    arch: inspection.arch || null,
    detectedAt: Date.now()
  };
}

/**
 * Matches a list of running processes (list-game-processes' shape) against
 * a list of profiles (each possibly carrying a `game` link) and produces
 * the small verdict scan-known-games hands back to the renderer.
 *
 * Precedence, most-confident first:
 *   exact path match  -> resolved (if the matching profile is ACTIVE) or
 *                        suggestion (if it's a DIFFERENT profile)
 *   exeName + dirName -> needsPathConfirm (the game moved folders/drives)
 *   exeName alone,
 *     exactly one profile candidate -> needsPathConfirm
 *   exeName alone,
 *     >= 2 profile candidates, none disambiguated by dirName -> ambiguous
 *
 * A NAME-ONLY match NEVER produces `resolved`, by design (Lyca's explicit
 * decision) — re-pointing a profile at a different exe silently, just
 * because the filename matches, is exactly the kind of "helpful" auto-link
 * that turns into a permanently-wrong PID/glossary/context association the
 * user never asked for. It always surfaces as `needsPathConfirm`, which
 * requires an explicit click before anything is written.
 *
 * Two `moved` candidates for the SAME exeName never produce two competing
 * confirmation banners: if dirName disambiguates, there's exactly one
 * candidate and one banner; if it doesn't, the result is `ambiguous` and
 * NOTHING is proposed — asking the user to guess between two mutually
 * exclusive re-links would be worse than proposing nothing.
 *
 * @param {Array<{pid:number, name:string, windowTitle:string, exePath:string}>} processes
 * @param {Array<object>} profiles - full profile objects (id, name, game, cover, ...)
 * @param {string|null} activeProfileId
 * @returns {{
 *   resolved: object|null,
 *   needsPathConfirm: object|null,
 *   suggestion: object|null,
 *   ambiguous: Array<{profileId:string, profileName:string}>
 * }}
 */
function matchRunningProcesses(processes, profiles, activeProfileId) {
  const linked = profiles.filter((p) => p && p.game && typeof p.game === 'object');

  // ─── Tier 1: exact path match ────────────────────────────────────────
  for (const proc of processes) {
    const procPathNorm = normalizeExePath(proc.exePath);
    const match = linked.find((p) => normalizeExePath(p.game.exePath) === procPathNorm);
    if (!match) continue;
    if (match.id === activeProfileId) {
      return {
        resolved: {
          pid: proc.pid,
          exePath: proc.exePath,
          exeName: proc.name,
          windowTitle: proc.windowTitle,
          engine: match.game.engine || null,
          arch: match.game.arch || null
        },
        needsPathConfirm: null,
        suggestion: null,
        ambiguous: []
      };
    }
    return {
      resolved: null,
      needsPathConfirm: null,
      suggestion: {
        profileId: match.id,
        profileName: match.name,
        coverUrl: (match.cover && match.cover.url) || null,
        pid: proc.pid,
        windowTitle: proc.windowTitle,
        exePath: proc.exePath
      },
      ambiguous: []
    };
  }

  // ─── Tier 2/3: exeName fallback, dirName as tiebreaker ────────────────
  for (const proc of processes) {
    const procExeName = normalizeExeName(proc.exePath);
    const procDirName = normalizeDirName(proc.exePath);
    if (!procExeName) continue;
    const nameCandidates = linked.filter((p) => p.game.exeName === procExeName);
    if (nameCandidates.length === 0) continue;

    const dirMatch = nameCandidates.find((p) => p.game.dirName === procDirName);
    if (dirMatch) {
      return {
        resolved: null,
        needsPathConfirm: {
          profileId: dirMatch.id,
          profileName: dirMatch.name,
          savedExePath: dirMatch.game.exePath,
          foundExePath: proc.exePath,
          pid: proc.pid,
          windowTitle: proc.windowTitle,
          // v3.13.85 (Fase B): carried so the renderer can build a full
          // {pid,name,windowTitle,exePath} process object for
          // set-profile-game's "Actualizar y conectar" action without a
          // second list-game-processes round-trip.
          processName: proc.name
        },
        suggestion: null,
        ambiguous: []
      };
    }

    if (nameCandidates.length === 1) {
      return {
        resolved: null,
        needsPathConfirm: {
          profileId: nameCandidates[0].id,
          profileName: nameCandidates[0].name,
          savedExePath: nameCandidates[0].game.exePath,
          foundExePath: proc.exePath,
          pid: proc.pid,
          windowTitle: proc.windowTitle,
          processName: proc.name
        },
        suggestion: null,
        ambiguous: []
      };
    }

    // >= 2 candidates share this exeName and none disambiguates by
    // dirName — genuinely ambiguous, propose nothing.
    return {
      resolved: null,
      needsPathConfirm: null,
      suggestion: null,
      ambiguous: nameCandidates.map((p) => ({ profileId: p.id, profileName: p.name }))
    };
  }

  return { resolved: null, needsPathConfirm: null, suggestion: null, ambiguous: [] };
}

// ─── Title normalization/comparison (Fase D) ───────────────────────────

// Runtime noise tokens that show up in real window titles but never in a
// VNDB canonical title: architecture/graphics-backend tags, version
// strings, storefront branding, and transient window states. Stripped
// before comparison so "NEKOPARA Vol. 1 — v1.03 [Steam]" and "Nekopara
// Vol.1" normalize to the same string without needing fuzzy scoring.
const TITLE_NOISE_RE = /\b(x64|x86|win32|win64|directx\s?\d*|direct3d\s?\d*|opengl|vulkan|steam|v?\d+(\.\d+)+|demo|trial|paused|not responding)\b/gi;

// A window title's "real" title is almost always the FIRST segment before
// a separator (`"<Title> - <detail>"`), essentially never the reverse —
// covers "Game - Direct3D 11", "Nekopara Vol. 1 - Chapter 3", etc.
const TITLE_SEPARATOR_RE = /\s[-–—|:]\s/;

/**
 * Normalizes a title for comparison: Unicode NFKC (VN titles are often
 * full-width Latin / wave-dash heavy), lowercase, strip a trailing
 * bracketed/parenthesized annotation, strip runtime noise tokens, cut at
 * the first separator and keep only the leading segment, then collapse
 * everything non-alphanumeric to a single space.
 *
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  if (typeof title !== 'string' || !title) return '';
  let s = title.normalize('NFKC').toLowerCase();
  s = s.replace(/[\[（(【][^\]）)】]*[\]）)】]\s*$/g, '');
  s = s.replace(TITLE_NOISE_RE, ' ');
  const sepMatch = s.match(TITLE_SEPARATOR_RE);
  if (sepMatch) s = s.slice(0, sepMatch.index);
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s;
}

// Below this length a "prefix" match is too likely to be coincidental
// (e.g. a two-letter common word) to act as a signal — see compareTitles.
const PREFIX_MATCH_MIN_LEN_LATIN = 6;
const PREFIX_MATCH_MIN_LEN_CJK = 3;

function isMostlyCJK(s) {
  const cjk = s.match(/[぀-ヿ㐀-鿿가-힯]/g);
  return !!cjk && cjk.length >= s.replace(/\s/g, '').length / 2;
}

/**
 * Compares two ALREADY-NORMALIZED-OR-RAW titles and returns how strong the
 * resemblance is. Deliberately NOT fuzzy (no Levenshtein distance, no
 * token-set/Jaccard scoring): normalizeTitle() already resolves the cases
 * a fuzzy matcher would buy ("NEKOPARA Vol. 1" vs "Nekopara Vol.1" ->
 * identical after NFKC+lowercase+punctuation folding). What a fuzzy
 * matcher adds ON TOP of that is almost entirely false positives, and the
 * cost here is asymmetric: a wrong suggestion invites linking the profile
 * for "Steins;Gate" to the process for "Steins;Gate 0" — and once linked,
 * Fase B's PID auto-resolution applies that mistake FOREVER, with
 * glossary/context crossed between two different games. The failure mode
 * of a strict prefix check is just "doesn't suggest anything" -> two
 * clicks. That is the correct trade here, not a shortcut.
 *
 * The digit guard below exists BECAUSE of that exact example: raw
 * startsWith() alone would call "Steins;Gate" a prefix of "Steins;Gate 0"
 * (a different game in the same franchise) exactly as readily as it calls
 * "Nekopara" a prefix of "Nekopara Vol. 1" (the SAME game, base title vs.
 * full title). What tells these apart is what immediately follows the
 * shorter title: a bare number ("0", "2", "II") signals a distinct
 * numbered entry/sequel, while a word ("Vol.", "After Story"-style
 * continuations starting with a letter) signals the same title spelled
 * more fully. So: if the longer string continues with a digit right after
 * the shared prefix (ignoring one space), that's a DIFFERENT title, never
 * a match — checked before the length/CJK threshold below.
 *
 * @param {string} a
 * @param {string} b
 * @returns {'exact'|'prefix'|null}
 */
function compareTitles(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return null;
  if (na === nb) return 'exact';
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (!longer.startsWith(shorter)) return null;
  const rest = longer.slice(shorter.length).replace(/^\s+/, '');
  if (/^\d/.test(rest)) return null;
  const minLen = isMostlyCJK(shorter) ? PREFIX_MATCH_MIN_LEN_CJK : PREFIX_MATCH_MIN_LEN_LATIN;
  return shorter.length >= minLen ? 'prefix' : null;
}

/**
 * v3.13.87 (Fase D): sibling to normalizeTitle(), for the ONE place a
 * title needs to survive being shown to the user or sent to an external
 * search — the VNDB search seed and the "Crear sin VNDB" profile name.
 * normalizeTitle() is comparison-only (lowercased, punctuation collapsed
 * to spaces): fine for `===`/prefix checks, useless as a search query or
 * a profile name — "nekopara vol 1" reads worse than "NEKOPARA Vol. 1"
 * and searches worse too (confirmed against vndb.js's searchVN(): it
 * forwards the query string as-is to VNDB's `search` filter with no
 * noise-stripping of its own, so a raw windowTitle like "NEKOPARA Vol. 1
 * — v1.03 [Steam]" would search VNDB with that whole suffix attached).
 *
 * Same runtime-noise stripping and separator cut as normalizeTitle(), but
 * skips the NFKC-lowercase and the final collapse-to-alphanumeric step —
 * casing and punctuation (periods, apostrophes) survive.
 *
 * @param {string} title
 * @returns {string}
 */
// v3.13.87 (Fase D follow-up): itch.io-exported games (common for indie
// Ren'Py/Godot titles — exactly the audience VNDB coverage is weakest
// for) very often ship their window title as "{Title} by {Creator}",
// copying the convention of the itch.io page itself. Confirmed real: a
// window titled "Lust Shards by MindOfFur" searched VNDB with the whole
// string attached and returned nothing until the "by MindOfFur" part was
// deleted by hand. cleanDisplayTitle-only (NOT TITLE_SEPARATOR_RE, which
// compareTitles/normalizeTitle also use) — this is a display/search-seed
// heuristic, not an identity-matching rule, so it stays out of the
// higher-stakes comparison path entirely.
const TITLE_BY_AUTHOR_RE = /\s+by\s+\S/i;

// v3.13.87 (Fase D follow-up): "Chapter"/"Episode" + a number is a
// release marker, not part of the canonical title — same reasoning as
// stripping version numbers, but "chapter"/"episode" aren't in
// TITLE_NOISE_RE because that regex is shared with normalizeTitle()/
// compareTitles(), where "Lust Shards" needs to keep matching "Lust
// Shards Chapter 2" as the same game (it already does — the digit right
// after "Chapter" doesn't trip the Steins;Gate-style sequel guard, since
// that guard only fires on a digit immediately after the shared prefix,
// not after a whole extra word). Deliberately does NOT include "Vol"/
// "Volume": "NEKOPARA Vol. 1" is only ever the FULL canonical title for
// that franchise, never a suffix to strip (see the bench case for it).
const TITLE_CHAPTER_RE = /\s+(chapter|episode)\s*\d+\b/i;

function cleanDisplayTitle(title) {
  if (typeof title !== 'string' || !title) return '';
  let s = title.normalize('NFKC');
  s = s.replace(/[\[（(【][^\]）)】]*[\]）)】]\s*$/g, '');
  s = s.replace(TITLE_NOISE_RE, ' ');
  const sepMatch = s.match(TITLE_SEPARATOR_RE);
  if (sepMatch) s = s.slice(0, sepMatch.index);
  const byMatch = s.match(TITLE_BY_AUTHOR_RE);
  if (byMatch) s = s.slice(0, byMatch.index);
  const chapterMatch = s.match(TITLE_CHAPTER_RE);
  if (chapterMatch) s = s.slice(0, chapterMatch.index);
  return s.replace(/\s+/g, ' ').trim();
}

module.exports = {
  normalizeExePath,
  normalizeExeName,
  normalizeDirName,
  buildGameRecord,
  matchRunningProcesses,
  normalizeTitle,
  compareTitles,
  cleanDisplayTitle
};
