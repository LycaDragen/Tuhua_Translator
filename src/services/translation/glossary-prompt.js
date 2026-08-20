/**
 * Glossary → prompt-block formatter — LLM engine overhaul, Fase 5.
 *
 * Turns the merged glossary (glossary.getEffective()) into the `{glossary}`
 * variable prompt-template.js already reads (see llm-base.js's translate(),
 * which passes `glossary: options.glossary` straight through). Before this,
 * a VNDB import with hundreds of `source===target` character-name entries
 * had zero effect on LLM output — they're no-op string replacements
 * (glossary.js's `_applyEntry`), and no code path ever showed the glossary
 * to the model at all.
 *
 * Pure, no I/O, no Electron — requireable from a plain-Node bench (same
 * pattern as prompt-template.js).
 */

const MAX_ENTRIES = 20;
const MAX_CHARS = 1200;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Hiragana/Katakana + CJK Unified Ideographs (+ Extension A) + Hangul —
// same ranges pipeline.js's detectLanguageSimple already uses. `.test()`
// against a whole string (no ^/$ anchors) means "contains at least one CJK
// character", which is what every use below actually wants.
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;

function containsCJK(str) {
  return CJK_RE.test(str || '');
}

/**
 * Whether `entry` should get a word-boundary guard when checked against
 * `text`: the term contains no CJK characters AND the line itself uses
 * spaces (i.e. is space-separated text, not CJK). Without this guard, an
 * entry `art -> arte` would fire on the substring inside `start`, and the
 * model would receive an instruction (or, worse, a masked placeholder — see
 * maskKeepUnchanged below) for a term that isn't actually there.
 *
 * v3.13.6x: this was originally gated on "is the term ALL-Latin"
 * (`/^[A-Za-z0-9'-]+$/`) instead of "does the term contain no CJK" — caught
 * testing non-CJK-non-Latin languages (Lyca asked specifically not to limit
 * testing to well-known languages): a Cyrillic term "арт" fell through to
 * plain substring matching exactly like a CJK term would, and matched
 * inside "старт" (Russian for "start") — the EXACT same bug the guard
 * exists to prevent, just in a different script, and worse for masking
 * specifically: it would have sliced a real word in half before ever
 * sending it to the engine. The fix isn't only widening which terms get
 * boundary-guarded: plain regex `\b` is ASCII-only in JS (`\w` without
 * Unicode awareness) and silently fails around non-Latin letters —
 * confirmed directly: `/\bart\b/`-style boundaries around a Cyrillic term
 * do not fire at all, for a standalone word OR a substring, since Cyrillic
 * characters are `\W` under ASCII-only `\w` semantics, and `\b` needs a
 * `\w`/`\W` transition it never finds. `buildBoundaryRegex()` below uses a
 * Unicode-aware lookaround (`(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])`) instead
 * of `\b`, which correctly works for Cyrillic, Greek, Devanagari, Arabic,
 * and every other script `\p{L}` recognizes — not just ASCII Latin.
 *
 * CJK terms/lines still fall through to a plain substring test: CJK has no
 * word-boundary concept the way space-separated scripts do (this is also
 * why the guard is gated on the TERM having no CJK, not on the term being
 * "Latin" — any non-CJK script benefits equally).
 */
function needsWordBoundaryGuard(entry, text) {
  return !containsCJK(entry.source) && /\s/.test(text);
}

// Unicode-aware equivalent of `\b...\b` — see needsWordBoundaryGuard's doc
// comment for why plain `\b` (ASCII \w only) silently fails for Cyrillic,
// Greek, Devanagari, Arabic, and any other non-Latin script.
function buildBoundaryRegex(entry, flags) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(entry.source)}(?![\\p{L}\\p{N}])`, `${flags}u`);
}

/**
 * Whether `entry` should be considered "present" in `text`.
 *
 * `regex` entries are excluded outright — a regex isn't a term a prompt
 * instruction can meaningfully act on. They keep working via the existing
 * literal replacement path (glossary.js), untouched by this module.
 */
function matchesLine(entry, text, compileCache) {
  if (entry.mode === 'regex') return false;

  if (needsWordBoundaryGuard(entry, text)) {
    const cacheKey = `${entry.mode} ${entry.source}`;
    let re = compileCache.get(cacheKey);
    if (re === undefined) {
      re = buildBoundaryRegex(entry, entry.mode === 'case-insensitive' ? 'i' : '');
      compileCache.set(cacheKey, re);
    }
    return re.test(text);
  }

  if (entry.mode === 'case-insensitive') {
    return text.toLowerCase().includes(entry.source.toLowerCase());
  }
  return text.includes(entry.source);
}

/**
 * Builds the `{glossary}` prompt block for one line of text.
 *
 * @param {Array<{source:string,target:string,mode:string,enabled?:boolean}>} entries
 *   The merged, effective glossary (glossary.getEffective()'s output).
 * @param {string} text - the line about to be translated.
 * @param {object} [opts]
 * @param {number} [opts.maxEntries] - cap on entries included, default 20.
 * @param {number} [opts.maxChars] - cap on total formatted characters, default 1200.
 * @param {Map} [opts.compileCache] - reused across calls to avoid recompiling
 *   a word-boundary regex per entry per line — pass the same Map across a
 *   session's translation calls (mirrors glossary.js's own instance-level
 *   caching pattern). A fresh Map is used if omitted.
 * @param {boolean} [opts.includeKeepUnchanged] - default true. pipeline.js
 *   sets this false when maskKeepUnchanged() (below) already protected the
 *   source===target entries via placeholder — asking the model to "keep
 *   unchanged" a term it can no longer even see (it's been replaced by a
 *   ⟦N⟧ token before this text ever reaches the engine) is redundant at
 *   best, confusing at worst. Renderings are unaffected — masking only ever
 *   applies to source===target entries.
 * @returns {string} formatted block, or '' if nothing in the glossary
 *   appears in `text` — resolveVariable('glossary') in prompt-template.js
 *   treats '' as auto-collapsible, so an empty result cleanly disappears
 *   from the rendered prompt rather than leaving a dangling header.
 */
function buildGlossaryPrompt(entries, text, opts = {}) {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const compileCache = opts.compileCache || new Map();
  const includeKeepUnchanged = opts.includeKeepUnchanged ?? true;

  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((e) => e.enabled !== false)
    .filter((e) => includeKeepUnchanged || e.source !== e.target)
    .filter((e) => matchesLine(e, text, compileCache))
    // Longest source first: with caps in play, a more specific/longer term
    // (e.g. a full character name) should survive the cutoff before a
    // shorter, more generic one competing for the same budget.
    .sort((a, b) => b.source.length - a.source.length)
    .slice(0, maxEntries);

  const renderings = [];
  const keepUnchanged = [];
  let usedChars = 0;

  for (const entry of candidates) {
    const isKeepUnchanged = entry.source === entry.target;
    const line = isKeepUnchanged ? `- ${entry.source}` : `- ${entry.source} → ${entry.target}`;
    // +1 accounts for the newline the line will occupy once joined.
    if (usedChars + line.length + 1 > maxChars) break;
    usedChars += line.length + 1;
    (isKeepUnchanged ? keepUnchanged : renderings).push(line);
  }

  const blocks = [];
  if (renderings.length) {
    blocks.push(`Glossary — apply these renderings exactly:\n${renderings.join('\n')}`);
  }
  if (keepUnchanged.length) {
    blocks.push(`Keep these unchanged (proper nouns):\n${keepUnchanged.join('\n')}`);
  }
  return blocks.join('\n\n');
}

// U+27E6/U+27E7 MATHEMATICAL WHITE SQUARE BRACKET — not real dialogue
// punctuation in any language Tuhua translates, so it can't collide with
// genuine VN text, and visually reads as "not part of the sentence" if the
// restore step ever fails and one leaks into the overlay.
const PLACEHOLDER_OPEN = '⟦';
const PLACEHOLDER_CLOSE = '⟧';

function buildMatchRegex(entry, useWordBoundary, flags) {
  return useWordBoundary ? buildBoundaryRegex(entry, flags) : new RegExp(escapeRegex(entry.source), flags);
}

/**
 * Masks "keep unchanged" glossary entries (source===target) with opaque
 * placeholder tokens before the text ever reaches the engine, and returns a
 * `restore()` function to put the real term back into the engine's output.
 *
 * Why this exists, separate from the `{glossary}` prompt instruction: on a
 * real local model (Qwen2.5-3B-Instruct via Ollama — see
 * scripts/test-glossary-compliance.js's report), the model followed
 * "translate X as Y" instructions perfectly but ignored "leave X unchanged"
 * and transliterated the proper noun anyway. Literal string-replacement
 * (glossary.js) can't help here either — source===target makes it a no-op
 * by construction, the exact bug this whole Fase exists to fix. Masking
 * sidesteps the problem entirely instead of asking a model to obey an
 * instruction: it never sees the real term, so it can't mistranslate what
 * it never saw. Only source===target entries are eligible — a rendering
 * entry (source≠target) still needs the model to actually see the source
 * text to know where to substitute, and `regex` entries are excluded, same
 * as `matchesLine`, for the same reason (not a term a placeholder swap can
 * meaningfully act on).
 *
 * @param {Array} entries - the merged, effective glossary.
 * @param {string} text - the text about to be sent to the engine (may
 *   already have rendering entries literally substituted — hybrid mode
 *   does that upstream; masking only ever touches source===target matches,
 *   so the order between the two never conflicts).
 * @param {object} [opts]
 * @param {Map} [opts.compileCache] - same cache instance buildGlossaryPrompt uses.
 * @returns {{maskedText: string, hasMasks: boolean, restore: (output: string) => string}}
 */
function maskKeepUnchanged(entries, text, opts = {}) {
  const compileCache = opts.compileCache || new Map();
  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((e) => e.enabled !== false && e.mode !== 'regex' && e.source === e.target)
    // Longest source first — same reasoning as buildGlossaryPrompt's cap
    // order: a longer, more specific term should claim its characters
    // before a shorter one that might otherwise partially overlap it.
    .sort((a, b) => b.source.length - a.source.length);

  let maskedText = text;
  const placeholders = new Map(); // placeholder token -> original term
  let counter = 0;

  for (const entry of candidates) {
    const useWordBoundary = needsWordBoundaryGuard(entry, maskedText);
    const flags = 'g' + (entry.mode === 'case-insensitive' ? 'i' : '');
    const cacheKey = `mask ${entry.mode} ${entry.source} ${useWordBoundary}`;
    let regex = compileCache.get(cacheKey);
    if (regex === undefined) {
      regex = buildMatchRegex(entry, useWordBoundary, flags);
      compileCache.set(cacheKey, regex);
    }
    regex.lastIndex = 0;
    if (!regex.test(maskedText)) continue;
    counter += 1;
    const token = `${PLACEHOLDER_OPEN}${counter}${PLACEHOLDER_CLOSE}`;
    placeholders.set(token, entry.source);
    regex.lastIndex = 0;
    maskedText = maskedText.replace(regex, token);
  }

  return {
    maskedText,
    hasMasks: placeholders.size > 0,
    restore(output) {
      let restored = output || '';
      for (const [token, original] of placeholders) {
        let idx;
        while ((idx = restored.indexOf(token)) !== -1) {
          const before = restored.slice(0, idx);
          const after = restored.slice(idx + token.length);
          // v3.13.6x: measured against a real local model (Qwen2.5-3B via
          // Ollama) — it reliably keeps the placeholder token intact, but
          // doesn't reliably surround it with the space its own
          // space-using target language needs, since it has no idea the
          // token represents a word at all. Confirmed NOT CJK-specific: the
          // exact same glued-together artifact reproduced on a plain
          // English glossary term restored into Spanish ("aNekoparu
          // Academy") — so the fix has to fire at any letter/digit
          // boundary, not just a CJK one. The one case it must NOT fire is
          // two CJK neighbors (Japanese/Chinese legitimately has no spaces
          // between words at all — adding one there would be a new bug,
          // not a fix), so the rule is "needs a space" everywhere EXCEPT
          // between two CJK characters.
          restored = before + spaceIfNeeded(before, original) + original + spaceIfNeeded(original, after) + after;
        }
      }
      return restored;
    }
  };
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isCJKChar(ch) {
  return !!ch && CJK_RE.test(ch);
}

function isWordChar(ch) {
  return !!ch && WORD_CHAR_RE.test(ch);
}

/**
 * Whether a space is needed at the join between `left` and `right` text.
 * True whenever both neighboring characters are letters/digits (a genuine
 * word-adjacency the model glued together with no separator) EXCEPT when
 * both are CJK — Japanese/Chinese legitimately has no spaces between words
 * at all, so that specific case must be left alone. Anything that isn't a
 * letter/digit on either side (an existing space, punctuation, a quote,
 * start/end of string) already needs no fixing.
 */
function spaceIfNeeded(left, right) {
  const leftChar = (left || '').slice(-1);
  const rightChar = (right || '').slice(0, 1);
  if (!isWordChar(leftChar) || !isWordChar(rightChar)) return '';
  if (isCJKChar(leftChar) && isCJKChar(rightChar)) return '';
  return ' ';
}

/**
 * Fixes the same glued-word-boundary artifact `maskKeepUnchanged`'s
 * `restore()` fixes, but for text that was never masked — DeepL's OWN
 * native glossary (Fase 6) has the identical problem: verified against a
 * real translation ("桜花学園" kept via `glossary_id` came back as
 * "a la桜花学園", no space), the exact same shape of bug on a completely
 * different, non-LLM engine. Since DeepL applies its glossary server-side
 * with no placeholder step Tuhua controls, this scans `text` for each
 * literal `term` and inserts a space at any CJK↔non-CJK (or
 * Latin↔Latin-adjacent, see spaceIfNeeded) boundary it finds around an
 * occurrence — same rule, applied by scanning instead of by substitution.
 *
 * @param {string} text - engine output to fix.
 * @param {string[]} terms - literal strings to look for (glossary "keep
 *   unchanged" entries' `source`, i.e. what should appear verbatim).
 */
function fixTermSpacing(text, terms) {
  let result = text || '';
  const uniqueTerms = [...new Set((terms || []).filter(Boolean))]
    // Longest first: a shorter term that happens to be a substring of a
    // longer one (rare, but glossaries aren't guaranteed disjoint) must not
    // get processed first and fragment the longer term's own boundary.
    .sort((a, b) => b.length - a.length);

  for (const term of uniqueTerms) {
    let searchFrom = 0;
    while (true) {
      const idx = result.indexOf(term, searchFrom);
      if (idx === -1) break;
      const before = result.slice(0, idx);
      const after = result.slice(idx + term.length);
      const spaceBefore = spaceIfNeeded(before, term);
      const spaceAfter = spaceIfNeeded(term, after);
      if (spaceBefore || spaceAfter) {
        result = before + spaceBefore + term + spaceAfter + after;
      }
      // Advance past this occurrence (+ any space just inserted) so the
      // same spot isn't matched again on the next indexOf.
      searchFrom = idx + spaceBefore.length + term.length + spaceAfter.length;
    }
  }
  return result;
}

module.exports = {
  buildGlossaryPrompt,
  maskKeepUnchanged,
  matchesLine,
  containsCJK,
  spaceIfNeeded,
  fixTermSpacing,
  PLACEHOLDER_OPEN,
  PLACEHOLDER_CLOSE,
  MAX_ENTRIES,
  MAX_CHARS
};
