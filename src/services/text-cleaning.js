/**
 * HOOK text cleaning — single owner for the dedup/artifact-removal logic
 * that runs on text arriving from Textractor (TCP and launcher/stdout),
 * clipboard, and manual translate. OCR has its own cleaning
 * (ocr.js's _cleanPaddleOcrText/_cleanOcrText) and is not touched here.
 *
 * Before this module existed, the same handful of algorithms were
 * duplicated across ipc-handlers.js's _deduplicateText and
 * textractor-launcher.js's _cleanGameText/_deduplicateSegments, applied
 * inconsistently per route:
 *   - the TCP route never got the doubled-character fix
 *     (_isDoubledText/_unDoubleText) at all — "NNooww tthhaatt" passed
 *     through untouched on TCP, but was fixed to "Now that" on the
 *     launcher route.
 *   - the launcher route ran its own digit-delimiter dedup
 *     (_deduplicateSegments) and THEN _handleText's near-identical copy
 *     (Strategy 4) ran a second time on the already-cleaned text.
 *   - three separate active data-loss bugs existed in these duplicated
 *     copies independently (documented in plan-hook-text-cleaning's Fase 0
 *     section): digit-delimiter dedup eating "HP:100 MP:50" on the
 *     launcher route, the same trailing-digit strip doing it a second way,
 *     and the leading-digit strip eating "3 hours" -> "hours" on both
 *     routes. All three were patched before this consolidation, verified
 *     against the real production classes at the time.
 *
 * This module is applied ONCE, from a single call site in
 * ipc-handlers.js's _handleText, to text from every route that reaches it.
 * See scripts/test-hook-cleaning.js for the regression bench (exact-match
 * ground truth, not similarity) that verifies routes now produce identical
 * output for identical input.
 */

// ─── Control-char strip ─────────────────────────────────────────────────────
// Built from explicit charcodes (not a /.../ regex literal typed with \u
// escapes) — typing those escapes as source text got silently corrupted
// into literal embedded control bytes during this module's own development
// (see scripts/lib/hook-cleaning-snapshot.js's history). This construction
// can't suffer that.
// Matches: U+0000, U+0001-U+0008, U+000B, U+000C, U+000E-U+001F, U+FEFF (BOM)
const CONTROL_CHAR_RANGES = [
  [0, 0], [1, 8], [11, 11], [12, 12], [14, 31], [0xFEFF, 0xFEFF]
];

function buildControlCharsRegex() {
  let cls = '';
  for (const [start, end] of CONTROL_CHAR_RANGES) {
    cls += String.fromCharCode(start);
    if (end !== start) cls += '-' + String.fromCharCode(end);
  }
  return new RegExp('[' + cls + ']', 'g');
}

const CONTROL_CHARS_REGEX = buildControlCharsRegex();

function stripControlChars(text) {
  return text.replace(CONTROL_CHARS_REGEX, '');
}

const CJK_CHAR_CLASS = '぀-ゟ゠-ヿ一-鿿가-힯';
const CJK_CHAR_REGEX = new RegExp('[' + CJK_CHAR_CLASS + ']');
const HAS_LETTERS_REGEX = /[a-zA-Z぀-ゟ゠-ヿ一-鿿가-힯Ѐ-ԯ]/;

// ─── Strategy 1: collapse a single character repeated 3+ times ─────────────
// cjkOnly defaults true: Latin repeats ("AAAAA", "HAHAHAHA", "NONONONO")
// are legitimate emphasis, not Textractor artifacts — confirmed only CJK
// repetition is a real hook artifact (see plan's Fase-0 audit). Relaxing
// this is a Fase-3 decision, gated on the regression bench, not made here.
function collapseRepeatedChars(text, options = {}) {
  const cjkOnly = options.cjkOnly !== false;
  const charClass = cjkOnly ? CJK_CHAR_CLASS : '.';
  const regex = cjkOnly
    ? new RegExp('([' + CJK_CHAR_CLASS + '])\\1{2,}', 'g')
    : /(.)\1{2,}/g;
  return text.replace(regex, '$1');
}

// ─── Strategy 2: collapse a full repeated line/sentence ─────────────────────
function collapseRepeatedLine(text, options = {}) {
  const cjkOnly = options.cjkOnly !== false;
  let result = text;
  for (let unitLen = 1; unitLen <= Math.floor(result.length / 2); unitLen++) {
    const unit = result.substring(0, unitLen);
    const repeated = unit.repeat(Math.floor(result.length / unitLen));
    if (repeated.length >= result.length * 0.8 && result.startsWith(repeated.substring(0, repeated.length))) {
      const fullRepeats = Math.floor(result.length / unitLen);
      if (fullRepeats >= 2) {
        const candidate = result.substring(0, unitLen);
        const hasCJK = CJK_CHAR_REGEX.test(candidate);
        const passesGate = cjkOnly ? hasCJK : true;
        if (candidate.trim().length >= 2 && !/^(.)\1*$/.test(candidate.trim()) && passesGate) {
          let isRepetition = true;
          for (let i = 1; i < fullRepeats; i++) {
            if (result.substring(i * unitLen, (i + 1) * unitLen) !== candidate) {
              isRepetition = false;
              break;
            }
          }
          if (isRepetition) {
            return candidate;
          }
        }
      }
    }
  }
  return result;
}

// ─── Growing-prefix pattern (Luna #12 shape) ────────────────────────────────
// v3.13.22 (Fase 3): rewritten. The original implementation (inherited from
// ipc-handlers.js's _removeIncrementalPattern) was a fuzzy heuristic that
// claimed to handle Luna #11 ("ABCDBCDCDD", a shrinking suffix) but was
// verified by direct execution to be inert on every tested case, including
// its own docstring's example — see Fase 1's plan section. This version
// uses an EXACT structural check instead of a fuzzy 80%-coverage heuristic:
// "A"+"AB"+"ABC"+...+"ABC...N" has length 1+2+...+N = N(N+1)/2. Given a
// string of that exact length, there is exactly one candidate N (solving
// the quadratic), and the reconstruction either matches byte-for-byte or it
// doesn't — no fuzzy threshold, no false-positive risk on text that merely
// happens to look similar.
function detectGrowingPrefix(text) {
  if (!text) return null;
  const len = text.length;
  const n = Math.floor((-1 + Math.sqrt(1 + 8 * len)) / 2);
  if (n < 2 || n * (n + 1) / 2 !== len) return null;
  const full = text.substring(len - n);
  let expected = '';
  for (let i = 1; i <= n; i++) expected += full.substring(0, i);
  return expected === text ? full : null;
}

// ─── Shrinking-suffix pattern (Luna #11 shape) ──────────────────────────────
// v3.13.22 (Fase 3): new. "ABCD"+"BCD"+"CD"+"D" — progressive substring
// calls where the parameter length DECREASES each time (dropping one
// character from the front), the mirror image of detectGrowingPrefix above.
// Same exact-length-based verification, no fuzzy threshold.
function detectShrinkingSuffix(text) {
  if (!text) return null;
  const len = text.length;
  const n = Math.floor((-1 + Math.sqrt(1 + 8 * len)) / 2);
  if (n < 2 || n * (n + 1) / 2 !== len) return null;
  const base = text.substring(0, n);
  let expected = '';
  for (let drop = 0; drop < n; drop++) expected += base.substring(drop);
  return expected === text ? base : null;
}

// ─── Variable-refresh multi-run pattern (Luna #10 shape) ───────────────────
// v3.13.22 (Fase 3): new, and the hardest of the three — Luna's own docs
// call the equivalent feature "complex deduplication logic" and expose a
// manual repetition-count override because auto-detection isn't reliable.
// "S1S1S1S2S2S2" -> "S1S2": two DIFFERENT multi-character units, each
// repeated some number of times (not necessarily the same count on both
// sides — verified against 2x+4x, 4x+2x, and 5x+2x/coprime cases, not just
// the balanced 3x+3x case), filling the string with nothing left over.
//
// cjkOnly (default true, same as collapseRepeatedChars/collapseRepeatedLine)
// is NOT optional here — it's the fix for a real false-positive found while
// testing this: without it, "HAHAHAHA" splits into "HAHA"+"HAHA" (two valid
// 2-char-unit runs) and "NONONONO" into "NONO"+"NONO", both misfiring on
// the exact Latin-emphasis regression cases Group 2 exists to protect.
// minUnitLen=2 also matters: it keeps this step from re-doing Strategy 1's
// job (single-character repeats), which already ran earlier in the
// pipeline and has its own, separately-tuned protections.
function detectVariableRefreshRun(text, options = {}) {
  const cjkOnly = options.cjkOnly !== false;
  if (!text || text.length < 8) return null;
  const n = text.length;
  for (let split = 4; split <= n - 4; split++) {
    const leftRun = _exactRepeatedUnit(text.substring(0, split), 2);
    if (!leftRun) continue;
    const rightRun = _exactRepeatedUnit(text.substring(split), 2);
    if (!rightRun) continue;
    if (cjkOnly && !(CJK_CHAR_REGEX.test(leftRun.unit) && CJK_CHAR_REGEX.test(rightRun.unit))) continue;
    return leftRun.unit + rightRun.unit;
  }
  return null;
}

// Finds the SMALLEST unit (>= minUnitLen) that repeats 2+ times and exactly
// fills `text`, with nothing left over. Smallest-first matters: searching
// largest-first can find an accidental "sub-multiple" instead of the real
// unit — e.g. for a 4x-repeated 3-char unit, an 8x-repeat's first half is
// ALSO exactly representable as a 6-char unit repeated 2x, which is the
// wrong answer. Verified empirically against 2x/4x/5x-repeat cases before
// picking this direction, not assumed.
function _exactRepeatedUnit(text, minUnitLen) {
  const n = text.length;
  for (let unitLen = minUnitLen; unitLen <= Math.floor(n / 2); unitLen++) {
    if (n % unitLen !== 0) continue;
    const count = n / unitLen;
    if (count < 2) continue;
    const unit = text.substring(0, unitLen);
    if (unit.repeat(count) === text) return { unit, count };
  }
  return null;
}

// ─── Doubled-character fix (Luna #8, exact-2x shape) ────────────────────────
// Strategy 1 only collapses 3+ occurrences (\1{2,} requires the char to
// appear at least 3 times total). A clean 2x double ("桜桜咲咲久久" ->
// "桜咲久") falls through Strategy 1 untouched — this catches that case.
// MUST run after collapseRepeatedChars, not before: on a short string that
// IS a genuine 3x+ repeat with no surrounding text (e.g. "恵恵恵麻麻麻"
// alone), isDoubledText's 60%-of-pairs heuristic can misfire true on the
// raw text and unDoubleText would produce "恵恵麻麻" instead of the
// correct "恵麻" — confirmed by direct testing, not assumed. Running
// Strategy 1 first collapses the genuine 3x+ case down to 2 characters,
// which then fails isDoubledText's own 6-character minimum-length guard,
// so the two algorithms don't fight over the same input.
function isDoubledText(text) {
  if (!text || text.length < 6) return false;
  const stripped = text.replace(/\s+/g, '');
  if (stripped.length < 6) return false;
  let doubledPairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < stripped.length - 1; i += 2) {
    totalPairs++;
    if (stripped[i] === stripped[i + 1]) doubledPairs++;
  }
  if (totalPairs < 3) return false;
  return (doubledPairs / totalPairs) > 0.6;
}

function unDoubleText(text) {
  if (!text) return text;
  let result = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (i + 1 < text.length && text[i + 1] === ch) {
      result += ch;
      i += 2;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

// ─── Strategy 4: digit-delimiter segment dedup ──────────────────────────────
// Single consolidated copy — this used to be duplicated near-verbatim as
// IpcHandlers._deduplicateText's "Strategy 4" and
// TextractorLauncher._deduplicateSegments. `duplicatesFound` tracking is
// load-bearing, not decorative: without it, "HP:100 MP:50" splits into
// ["HP:", "MP:"] (two segments that are NOT duplicates of each other), and
// naively joining "unique" segments back together silently drops both
// numbers. This was an active data-loss bug on the launcher route, patched
// 2026-08-06 before this consolidation existed.
function deduplicateSegments(text) {
  if (!text || text.length < 4) return text;
  const segments = text.split(/\d+/).map(s => s.trim()).filter(s => s.length >= 2);
  if (segments.length <= 1) return text;

  const unique = [];
  let duplicatesFound = false;
  for (const seg of segments) {
    let isDupe = false;
    for (let i = 0; i < unique.length; i++) {
      const existing = unique[i];
      if (existing.toLowerCase() === seg.toLowerCase()) { isDupe = true; break; }
      if (existing.toLowerCase().startsWith(seg.toLowerCase()) || seg.toLowerCase().startsWith(existing.toLowerCase())) {
        if (seg.length > existing.length) unique[i] = seg;
        isDupe = true;
        break;
      }
      if (existing.toLowerCase().endsWith(seg.toLowerCase()) || seg.toLowerCase().endsWith(existing.toLowerCase())) {
        if (seg.length > existing.length) unique[i] = seg;
        isDupe = true;
        break;
      }
      if (seg.length > 5 && existing.length > 5) {
        const shorter = seg.length < existing.length ? seg : existing;
        const longer = seg.length < existing.length ? existing : seg;
        let matchCount = 0;
        for (let j = 0; j < shorter.length; j++) {
          if (shorter[j].toLowerCase() === longer[j].toLowerCase()) matchCount++;
        }
        if (matchCount / shorter.length > 0.85) {
          if (seg.length > existing.length) unique[i] = seg;
          isDupe = true;
          break;
        }
      }
    }
    if (isDupe) duplicatesFound = true; else unique.push(seg);
  }

  if (!duplicatesFound) return text;
  if (unique.length === 1) return unique[0];
  return unique.join(' ');
}

// ─── The consolidated pipeline ──────────────────────────────────────────────

/**
 * Single entry point, applied once to text from every non-OCR input route
 * (Textractor TCP, Textractor launcher/stdout, clipboard, manual translate).
 *
 * Options (all default to enabled/CJK-only, reproducing Fase 1's fixed
 * pipeline exactly for the original five — see hook-cleaning-settings.js,
 * which is the only thing that should ever pass non-default values here):
 *   enableCollapseRepeatedChars, enableCollapseRepeatedLine,
 *   enableVariableRefresh, enableShrinkingSuffix, enableGrowingPrefix,
 *   enableUndouble, enableDedupSegments — per-step on/off.
 *   collapseRepeatedCharsCjkOnly, collapseRepeatedLineCjkOnly,
 *   variableRefreshCjkOnly — CJK gate, independently for the three steps
 *   that have one (detectShrinkingSuffix/detectGrowingPrefix don't need
 *   one — their exact-length structural check has no fuzzy-match surface
 *   for Latin emphasis text to accidentally trigger).
 *
 * The seven steps run in a FIXED order regardless of which are enabled —
 * unlike regex-filter.js's fully user-reorderable entries, several of these
 * have a proven interdependency (see isDoubledText's comment: running it
 * before collapseRepeatedChars can misfire on a short pure 3x+ repeat and
 * corrupt it, verified empirically). Order is deliberately NOT exposed as
 * a setting for this reason.
 */
function cleanHookText(text, options = {}) {
  if (!text || text.length < 3) return text;

  let result = stripControlChars(text);

  // Strategy 1 must run before the doubled-text fix — see that function's
  // comment for why (short pure 3x+ repeats can otherwise be misread as
  // "doubled" and mangled). This ordering constraint is exactly why the
  // five steps below are individually toggleable but NOT reorderable.
  if (options.enableCollapseRepeatedChars !== false) {
    result = collapseRepeatedChars(result, { cjkOnly: options.collapseRepeatedCharsCjkOnly });
  }
  if (options.enableCollapseRepeatedLine !== false) {
    result = collapseRepeatedLine(result, { cjkOnly: options.collapseRepeatedLineCjkOnly });
  }

  // v3.13.22 (Fase 3): variable-refresh (#10), shrinking-suffix (#11), and
  // growing-prefix (#12) all target structurally different total-length
  // shapes (2-run split vs. an exact N(N+1)/2 triangular length), so they
  // don't compete for the same input — order among these three doesn't
  // matter the way Strategy-1-before-doubled-fix does. Placed here (after
  // the two whole-string strategies, before the doubled-text fix) so any
  // multi-run text they collapse can't be misread as "doubled" first.
  if (options.enableVariableRefresh !== false && result.length > 10) {
    const collapsed = detectVariableRefreshRun(result, { cjkOnly: options.variableRefreshCjkOnly });
    if (collapsed && collapsed.length < result.length) {
      result = collapsed;
    }
  }

  if (options.enableShrinkingSuffix !== false && result.length > 10) {
    const shrinkingSuffix = detectShrinkingSuffix(result);
    if (shrinkingSuffix && shrinkingSuffix.length < result.length) {
      result = shrinkingSuffix;
    }
  }

  if (options.enableGrowingPrefix !== false && result.length > 10) {
    const growingPrefix = detectGrowingPrefix(result);
    if (growingPrefix && growingPrefix.length < result.length) {
      result = growingPrefix;
    }
  }

  if (options.enableUndouble !== false && isDoubledText(result)) {
    const unDoubled = unDoubleText(result);
    if (unDoubled && unDoubled.length > 0) {
      result = unDoubled;
    }
  }

  if (options.enableDedupSegments !== false) {
    result = deduplicateSegments(result);
  }

  const hasLetters = HAS_LETTERS_REGEX.test(result);
  if (hasLetters) {
    // Only strip a leading digit run when it's glued DIRECTLY to a Latin
    // letter with nothing in between ("3text", "0I softly murmured...") —
    // no dots in the quantified part, on purpose. An earlier version of
    // this fix used /^[\d.]+(?=\S)/ (dots included, lookahead for any
    // non-whitespace) to protect "3 hours" -> "hours" from an even earlier
    // active-data-loss bug (bare \s* stripping ANY leading digit run
    // regardless of what followed) — but that version had its own bug:
    // on input like "0... Now that..." the greedy [\d.]+ backtracks past
    // the failing 4-char lookahead (next char is a space) down to a
    // 3-char match "0.." whose next character is ANOTHER dot — which
    // satisfies \S — silently mangling "0... Now" into ". Now". Confirmed
    // by tracing the regex step by step, not just reading it. This
    // \d+(?=[A-Za-z])-only form has no dots to backtrack into, so no such
    // ambiguity is possible — verified against the same case plus every
    // row in the Fase-0 ground truth. It also happens to match what
    // textractor-launcher.js's _cleanGameText was already doing correctly
    // all along (its own docstring claimed "1.Hello" -> "Hello", which
    // direct testing showed was never actually true — "1.Hello" was left
    // untouched by the real code; the comment was aspirational, not
    // descriptive, same class of drift as _removeIncrementalPattern's
    // Luna #11 claim above).
    result = result.replace(/^\d+(?=[A-Za-z])/, '');
    // Trailing digits: only strip if NOT preceded by a colon, since game
    // stats like "HP:100" or "MP:50" have meaningful trailing digits.
    if (!/[:：]\s*\d+\s*$/.test(result)) {
      result = result.replace(/\d+\s*$/, '');
    }
  }

  return result.trim();
}

module.exports = {
  stripControlChars,
  collapseRepeatedChars,
  collapseRepeatedLine,
  detectVariableRefreshRun,
  detectShrinkingSuffix,
  detectGrowingPrefix,
  isDoubledText,
  unDoubleText,
  deduplicateSegments,
  cleanHookText
};
