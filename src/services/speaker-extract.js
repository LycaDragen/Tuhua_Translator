/**
 * Speaker name extraction — LLM engine overhaul, Fase 7a.
 *
 * The speaker's name is destroyed TWICE before it ever reaches the pipeline
 * today: `builtin-remove-angle-brackets` (regex-filter.js) strips
 * `<Narumi>Hello` down to `Hello`, and `builtin-extract-japanese-quotes`
 * strips `名前「こんにちは」` down to `こんにちは`. Neither filter is wrong
 * to run — both are legitimate cleanup for the TEXT that gets translated —
 * but nothing captured the name on the way out. This module runs BEFORE
 * those filters (see ipc-handlers.js's _handleText) and pulls the speaker
 * out with the dialogue text left completely intact, so the filters still
 * do their job unchanged afterward.
 *
 * Knowing who's speaking is what lets an LLM pick the right pronoun and
 * register — the single most visible problem translating Japanese, which
 * elides the subject constantly.
 *
 * Pure, no I/O, no Electron — requireable from a plain-Node bench.
 */

// Markup/formatting tags seen in VN/Textractor hook text that use the same
// <...> shape as a speaker tag but aren't a name — a closing tag, or a
// bare keyword with no '=' (color=red IS caught by the '=' check below;
// these are the ones that would slip through it).
const MARKUP_KEYWORDS = new Set([
  'b', 'i', 'u', 's', 'ruby', 'rb', 'rt', 'rp', 'plain', 'br', 'nobr',
  'center', 'left', 'right', 'wait', 'cr', 'r', 'w', 'clear', 'font'
]);

/**
 * Whether `candidate` (the content of a `<...>` tag) looks like it could be
 * a speaker's name rather than markup.
 */
function looksLikeSpeakerName(candidate) {
  if (!candidate) return false;
  if (candidate.length > 30) return false; // names aren't paragraphs
  if (candidate.includes('=')) return false; // color=red, size=12, ...
  if (candidate.startsWith('/')) return false; // closing tag </color>
  if (/[<>]/.test(candidate)) return false; // shouldn't itself contain a tag
  if (MARKUP_KEYWORDS.has(candidate.trim().toLowerCase())) return false;
  return true;
}

/**
 * Extracts a speaker name and the dialogue text from one line of raw hook
 * text, trying two shapes in order:
 *
 * 1. `<Name>dialogue` — an angle-bracket prefix, name has no `=`/`/` and
 *    isn't a known markup keyword, and the dialogue doesn't immediately
 *    start with ANOTHER tag (that shape reads as nested markup, e.g.
 *    `<b><color=red>...`, not `<Name>dialogue`).
 * 2. `Name「dialogue」` — a short prefix before an opening Japanese quote,
 *    with the quote running all the way to the end of the line (trailing
 *    whitespace tolerated). A quote that does NOT reach the end (e.g. a
 *    quote in the middle of a longer sentence) is not treated as a
 *    name-prefix shape — that's just dialogue that happens to contain a
 *    quotation, not `Name「...」`.
 *
 * @param {string} rawText
 * @returns {{speaker: string|null, text: string}} `text` is `rawText`
 *   completely unmodified when no speaker is found.
 */
function extractSpeaker(rawText) {
  if (typeof rawText !== 'string' || !rawText) {
    return { speaker: null, text: rawText };
  }

  const angleMatch = rawText.match(/^<([^>]*)>([\s\S]*)$/);
  if (angleMatch) {
    const candidate = angleMatch[1].trim();
    const rest = angleMatch[2];
    if (looksLikeSpeakerName(candidate) && !/^\s*</.test(rest)) {
      return { speaker: candidate, text: rest };
    }
  }

  const jpQuoteMatch = rawText.match(/^([^「」\n]{1,30})「([^」]*)」\s*$/);
  if (jpQuoteMatch) {
    const candidate = jpQuoteMatch[1].trim();
    if (candidate) {
      return { speaker: candidate, text: jpQuoteMatch[2] };
    }
  }

  return { speaker: null, text: rawText };
}

module.exports = { extractSpeaker, looksLikeSpeakerName };
