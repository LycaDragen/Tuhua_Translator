/**
 * Verbatim snapshot of Tuhua's current (scattered) HOOK text-cleaning logic,
 * ported to plain JS so the Fase 0 bench can run it outside Electron.
 *
 * This is NOT new code and NOT the Fase 1 consolidation — every function
 * below is a byte-for-byte transcription of a method that still lives in
 * its real production file (see the @source comment on each). The point of
 * this file is to let scripts/test-hook-cleaning.js measure what production
 * actually does TODAY, including its inconsistencies between routes, before
 * anything gets consolidated. When Fase 1 happens, this file is what gets
 * edited in place into the real src/services/text-cleaning.js — diffing a
 * bench run against this snapshot's output is how Fase 1 proves it didn't
 * silently change behavior.
 *
 * Two routes are composed at the bottom exactly as production wires them
 * (verified by reading the call sites, not assumed):
 *   - TCP (src/services/textractor.js):   stripHookPrefix -> _handleText's
 *     inline cleaning (control chars + deduplicateText). No _cleanGameText,
 *     no doubled-text fix — confirmed gap.
 *   - Launcher/stdout (src/services/textractor-launcher.js): _cleanGameText
 *     (which itself runs a digit-segment dedup + doubled-text fix), THEN
 *     the SAME _handleText inline cleaning runs again on the already-clean
 *     result — confirmed double application, not assumed.
 */

// ─── Shared: control-char strip ─────────────────────────────────────────────
// @source src/main/ipc-handlers.js:1677 (identical regex also inlined at
// src/services/textractor-launcher.js:909, step 1 of _cleanGameText)
//
// Built from explicit charcodes (not a /.../ regex literal) rather than
// typed \u escapes, so it can't fall victim to escape-sequence text getting
// silently reinterpreted as literal embedded control bytes when this file
// is edited — this construction stays unambiguous regardless.
// Matches: U+0000, U+0001-U+0008, U+000B, U+000C, U+000E-U+001F, U+FEFF (BOM)
var CONTROL_CHAR_CODES_START = [0, 1, 11, 12, 14, 0xFEFF];
var CONTROL_CHAR_CODES_END = [0, 8, 11, 12, 31, 0xFEFF]; // same index = single char (start===end)

function buildControlCharsRegex() {
  var cls = '';
  for (var i = 0; i < CONTROL_CHAR_CODES_START.length; i++) {
    var start = CONTROL_CHAR_CODES_START[i];
    var end = CONTROL_CHAR_CODES_END[i];
    cls += String.fromCharCode(start);
    if (end !== start) cls += '-' + String.fromCharCode(end);
  }
  return new RegExp('[' + cls + ']', 'g');
}

var CONTROL_CHARS_REGEX = buildControlCharsRegex();

function stripControlChars(text) {
  return text.replace(CONTROL_CHARS_REGEX, '');
}

// ─── TCP route: hook-prefix stripping ───────────────────────────────────────
// @source src/services/textractor.js:233-248 (Textractor._stripHookPrefix)
function stripHookPrefix(text) {
  const hookMatch = text.match(/^\[0x[0-9A-Fa-f]+:\d+:[^\]]*\]\s*(.*)$/);
  if (hookMatch) {
    const gameText = hookMatch[1].trim();
    if (!gameText) return null;
    if (/^[0-9A-Fa-f\s]+$/.test(gameText)) return null;
    if (/^[-=_*#.\s]+$/.test(gameText)) return null;
    if (gameText.includes('Textractor') && gameText.length < 30) return null;
    return gameText;
  }
  return null;
}

// ─── _handleText's inline dedup (applies to every non-OCR route) ───────────
// @source src/main/ipc-handlers.js:1816-1969 (IpcHandlers._deduplicateText)
// Includes _removeIncrementalPattern verbatim (ipc-handlers.js:1977-2010) —
// confirmed by direct execution (not just reading) to return null on every
// canonical growing/shrinking pattern tested, including the function's own
// docstring example. Kept as-is here since Fase 0 measures current
// behavior, warts included; the ground truth marks its rows as expected-fail.
function removeIncrementalPattern(text) {
  if (!text || text.length < 4) return text;
  for (let baseLen = Math.min(50, Math.floor(text.length / 2)); baseLen >= 2; baseLen--) {
    const base = text.substring(0, baseLen);
    let pos = 0;
    let expected = base;
    let found = true;
    while (pos < text.length) {
      if (text.substring(pos, pos + expected.length) === expected) {
        pos += expected.length;
        if (pos < text.length) {
          expected = text.substring(0, Math.min(baseLen + (expected.length - baseLen) + 1, text.length - pos + expected.length));
        }
      } else {
        found = false;
        break;
      }
      if (expected.length > text.length) break;
    }
    if (found && pos >= text.length * 0.8) {
      return base;
    }
  }
  return null;
}

function deduplicateText(text) {
  if (!text || text.length < 3) return text;

  // Strategy 1: CJK-only character-level deduplication (3+ consecutive)
  let result = text.replace(/([぀-ゟ゠-ヿ一-鿿가-힯])\1{2,}/g, '$1');

  // Strategy 2: full-line repetition, CJK-gated
  for (let unitLen = 1; unitLen <= Math.floor(result.length / 2); unitLen++) {
    const unit = result.substring(0, unitLen);
    const repeated = unit.repeat(Math.floor(result.length / unitLen));
    if (repeated.length >= result.length * 0.8 && result.startsWith(repeated.substring(0, repeated.length))) {
      const fullRepeats = Math.floor(result.length / unitLen);
      if (fullRepeats >= 2) {
        const candidate = result.substring(0, unitLen);
        const hasCJK = /[぀-ゟ゠-ヿ一-鿿가-힯]/.test(candidate);
        if (candidate.trim().length >= 2 && !/^(.)\1*$/.test(candidate.trim()) && hasCJK) {
          let isRepetition = true;
          for (let i = 1; i < fullRepeats; i++) {
            if (result.substring(i * unitLen, (i + 1) * unitLen) !== candidate) {
              isRepetition = false;
              break;
            }
          }
          if (isRepetition) {
            result = candidate;
            break;
          }
        }
      }
    }
  }

  // Strategy 3: incremental pattern (confirmed non-functional, see above)
  if (result.length > 10) {
    const incrementalCleaned = removeIncrementalPattern(result);
    if (incrementalCleaned && incrementalCleaned.length < result.length) {
      result = incrementalCleaned;
    }
  }

  // Strategy 4: digit-delimiter dedup, WITH the v3.12.07 duplicatesFound guard
  const segments = result.split(/\d+/).map(s => s.trim()).filter(s => s.length >= 2);
  if (segments.length > 1) {
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
      }
      if (isDupe) duplicatesFound = true; else unique.push(seg);
    }
    if (duplicatesFound) {
      if (unique.length === 1) return unique[0];
      result = unique.join(' ');
    }
  }

  const hasLetters = /[a-zA-Z぀-ゟ゠-ヿ一-鿿가-힯Ѐ-ԯ]/.test(result);
  if (hasLetters) {
    // v3.13.20 patch (already applied to production on 2026-08-06): lookahead
    // instead of unconditional \s* — only strips when the digit is glued
    // directly to more text, not when followed by a space+legitimate word
    // ("3 hours" no longer loses its "3").
    result = result.replace(/^[\d.]+(?=\S)/, '');
    if (!/[:：]\s*\d+\s*$/.test(result)) {
      result = result.replace(/\d+\s*$/, '');
    }
  }
  return result.trim();
}

// ─── Launcher/stdout route: _cleanGameText and its helpers ─────────────────
// @source src/services/textractor-launcher.js:989-1070 (_deduplicateSegments)
// Includes the v3.13.20 duplicatesFound patch (already applied to production
// on 2026-08-06, ported here verbatim since this file mirrors current state).
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

// @source src/services/textractor-launcher.js:1076-1090
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

// @source src/services/textractor-launcher.js:1096-1113
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

// @source src/services/textractor-launcher.js:903-970 (_cleanGameText)
// Includes the v3.13.20 colon-guard patch on trailing digit strip (already
// applied to production on 2026-08-06).
function cleanGameText(text) {
  if (!text) return text;
  let cleaned = text;

  // 1. control chars
  cleaned = stripControlChars(cleaned);

  // 2. progressive counter lines
  cleaned = cleaned.split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (/^\d+$/.test(trimmed) && trimmed.length <= 3) return false;
      if (/^\s*$/.test(line)) return false;
      return true;
    })
    .join(' ');

  // 3. digit-delimiter dedup
  cleaned = deduplicateSegments(cleaned);

  // 4. doubled characters
  if (isDoubledText(cleaned)) {
    const unDoubled = unDoubleText(cleaned);
    if (unDoubled && unDoubled.length > 0) {
      cleaned = unDoubled;
    }
  }

  // 5. whitespace normalize
  cleaned = cleaned.replace(/[ \t]+/g, ' ').trim();
  cleaned = cleaned.replace(/\n+/g, ' ');

  // 6. leading/trailing garbage digits
  cleaned = cleaned.replace(/^\d+(?=[A-Za-z])/, '');
  cleaned = cleaned.replace(/^\d*\.\s+/, '');
  cleaned = cleaned.replace(/^\.{2,}\s*/, '');
  if (!/[:：]\s*\d+\s*$/.test(cleaned)) {
    cleaned = cleaned.replace(/\d+\s*$/, '');
  }

  // 7. final trim
  cleaned = cleaned.trim();
  return cleaned;
}

// ─── Composed routes, exactly as production wires them ─────────────────────

/**
 * TCP route: src/services/textractor.js emits stripHookPrefix(raw), then
 * src/main/ipc-handlers.js's _handleText runs control-char strip +
 * deduplicateText on it. No _cleanGameText, no doubled-text fix on this path
 * — confirmed by reading the call sites, not assumed.
 * `raw` should include the `[0xADDR:N:Name]` wrapper; pass
 * `hasHookPrefix: false` to skip that step for inputs that don't have one.
 */
function cleanViaTcpRoute(raw, options) {
  var hasHookPrefix = !options || options.hasHookPrefix !== false;
  let text = raw;
  if (hasHookPrefix) {
    text = stripHookPrefix(text);
    if (text === null) return null;
  }
  text = stripControlChars(text);
  text = deduplicateText(text);
  return text;
}

/**
 * Launcher/stdout route: textractor-launcher.js emits cleanGameText(raw),
 * and that already-cleaned text ALSO goes through _handleText's inline
 * control-char strip + deduplicateText — confirmed double application by
 * reading src/main/index.js's `textractorLauncher.on('text', ...)` wiring.
 */
function cleanViaLauncherRoute(raw) {
  let text = cleanGameText(raw);
  text = stripControlChars(text);
  text = deduplicateText(text);
  return text;
}

module.exports = {
  stripControlChars,
  stripHookPrefix,
  deduplicateText,
  removeIncrementalPattern,
  deduplicateSegments,
  isDoubledText,
  unDoubleText,
  cleanGameText,
  cleanViaTcpRoute,
  cleanViaLauncherRoute
};
