/**
 * LLM output sanitizer — LLM engine overhaul, Fase 2.
 *
 * Before this, the entire "parsing" of an LLM's response was
 * `response.data?.choices?.[0]?.message?.content?.trim()` (see llm-base.js
 * pre-v3.13.57). Everything else — preambles ("Here is the translation:"),
 * markdown fences, unclosed <think> blocks from reasoning models, a flat
 * refusal ("I can't assist with that"), or a response truncated by
 * max_tokens — passed straight through to the overlay and got cached for
 * 24h as if it were a real translation.
 *
 * Pure, no I/O, no Electron — requireable from a plain-Node bench exactly
 * like glossary.js/context-memory.js.
 *
 * Design principle: every heuristic here is deliberately conservative.
 * A missed bad output is an annoyance the user can retranslate past; a
 * FALSE positive that mangles a legitimate translation (e.g. stripping
 * quotes off dialogue that's supposed to be quoted) is worse — it looks
 * like a Tuhua bug, not an LLM one. Each step only fires on a fairly
 * specific shape, and several require two independent signals before
 * acting (see isLikelyRefusal below) for exactly this reason.
 */

// ─── script classification (used by the refusal and passthrough checks) ──
// v3.13.57: intentionally coarse. This only needs to distinguish "the
// output is in roughly the right alphabet for the target language" from
// "it's not" — it is NOT a language identifier. Anything not CJK/Hangul/
// Cyrillic defaults to 'latin', which is a real simplification (Arabic,
// Thai, Hindi etc. all fall through to 'latin' and get no signal from
// this), acceptable because Tuhua's primary use case is JA/ZH/KO/RU <-> a
// Latin-script target language — extending this table is cheap if a wider
// case shows up.
const EXPECTED_SCRIPT_BY_LANG = { ja: 'cjk', zh: 'cjk', lzh: 'cjk', ko: 'hangul', ru: 'cyrillic' };

function expectedScriptFor(langCode) {
  return EXPECTED_SCRIPT_BY_LANG[langCode] || 'latin';
}

function dominantScript(text) {
  const counts = { cjk: 0, cyrillic: 0, hangul: 0, latin: 0 };
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x3040 && code <= 0x30FF) || (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
      counts.cjk++; total++;
    } else if (code >= 0x0400 && code <= 0x052F) {
      counts.cyrillic++; total++;
    } else if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)) {
      counts.hangul++; total++;
    } else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A) || (code >= 0x00C0 && code <= 0x024F)) {
      counts.latin++; total++;
    }
  }
  if (total === 0) return 'none';
  let best = 'none', bestCount = 0;
  for (const [script, count] of Object.entries(counts)) {
    if (count > bestCount) { best = script; bestCount = count; }
  }
  return best;
}

// ─── step 6: wrapping quotes ──────────────────────────────────────────────
const QUOTE_PAIRS = [
  ['"', '"'], ["'", "'"],
  ['“', '”'], // “ ”
  ['‘', '’'], // ‘ ’
  ['「', '」'], // 「 」
  ['『', '』']  // 『 』
];

function isWrappedInQuotes(s) {
  if (!s || s.length < 2) return false;
  const first = s[0];
  const last = s[s.length - 1];
  return QUOTE_PAIRS.some(([open, close]) => first === open && last === close);
}

function stripWrappingQuotesIfSafe(text, sourceText, actions) {
  if (!isWrappedInQuotes(text)) return text;
  // The falsePositiveIf-obvious case this guards: a Japanese line in 「」
  // legitimately becomes a quoted "..." line in Spanish/English — that is
  // NOT a stray wrapper to strip, it's the correct translation of quoted
  // speech. Only strip when the SOURCE wasn't itself quoted.
  if (isWrappedInQuotes(sourceText || '')) return text;
  actions.push('stripped-wrapping-quotes');
  return text.slice(1, -1).trim();
}

// ─── step 7: refusal detection ────────────────────────────────────────────
// Anchored to the START of the (already preamble/quote-stripped) text —
// real dialogue that happens to contain one of these phrases mid-sentence
// must not match. Covers the common English refusal openers plus a few
// Japanese ones; deliberately not exhaustive (an over-broad phrase table is
// itself a false-positive risk).
//
// v3.13.6x (Fase 9 testing follow-up): found by real testing (Lyca,
// Nekopara Vol.1) — a GPT refusal in SPANISH ("Lo siento, no puedo ayudar
// con eso.") sailed through completely undetected. The model tends to
// refuse IN the target language it was asked to translate into, not
// English — this table was English/Japanese-only, so any Latin-script
// target (es/fr/de/pt/it/...) had zero phrase coverage AND signal 2b
// (script mismatch) can never fire for those either, since the target
// script IS Latin. Added openers for the other Latin-script targets Tuhua
// ships translations into. Non-Latin targets (zh/ko/ru/ar/th/hi/uk/...)
// already had a safety net via signal 2b regardless of phrase coverage.
const REFUSAL_PATTERNS = [
  /^i\s*(?:can'?t|cannot|won'?t)\s*(?:assist|help|continue|comply|provide|translate)/i,
  /^i'?m\s*(?:sorry|unable|not able)/i,
  /^as an ai\b/i,
  /^i must decline/i,
  /^unfortunately,?\s*i\s*(?:can'?t|cannot)/i,
  /^(?:申し訳ございません|申し訳ありません|お手伝いできません|対応できません)/,
  // Spanish
  /^lo siento/i,
  /^no puedo ayudar/i,
  // French
  /^je suis désolé/i,
  /^je ne peux pas/i,
  // German
  /^es tut mir leid/i,
  /^ich kann (?:dir|ihnen)? ?nicht/i,
  // Portuguese
  /^(?:me )?desculpe/i,
  /^não posso ajudar/i,
  // Italian
  /^mi dispiace/i,
  /^non posso aiutart[ei]/i
];

// v3.13.6x (Fase 9 testing follow-up): a small set of FULL refusal clauses
// (not mere openers) specific enough that a real character saying this
// verbatim as dialogue is implausible — matching one of these is treated
// as sufficient on its own, skipping the corroboration signals below.
// Exists because the corroboration signals both assume a refusal is
// LONGER than the dialogue it displaces; a terse refusal responding to an
// unusually long source (garbled Textractor hook noise, not real
// dialogue) is neither disproportionately long NOR script-mismatched for
// a Latin-script target, so it would otherwise never be caught — exactly
// the reproduced case ("no puedo ayudar con eso", 36 chars, answering an
// 80+ char garbled "CClCliClicClick..." hook-buffer artifact).
//
// Anchored to the WHOLE string (allowing only a short apologetic lead-in,
// e.g. "Lo siento, ") rather than a bare substring search — skipping
// corroboration is already a stronger claim than the opener patterns
// above, so this stays as narrow as the reproduced case actually needs:
// a short, standalone, non-continuing sentence. A real line of dialogue
// that mentions this clause mid-paragraph (continuing after it) does not
// match.
const LEAD_IN = '(?:.{0,30}[,.]\\s*)?';
const REFUSAL_PATTERNS_UNCONDITIONAL = [
  new RegExp(`^${LEAD_IN}no puedo ayudar (?:con|en) (?:eso|esto)\\.?\\s*$`, 'i'),
  new RegExp(`^${LEAD_IN}can'?t help (?:you )?with that\\.?\\s*$`, 'i'),
  new RegExp(`^${LEAD_IN}ne peux pas (?:vous )?aider avec (?:ça|cela)\\.?\\s*$`, 'i'),
  new RegExp(`^${LEAD_IN}kann (?:dir|ihnen)? ?nicht (?:dabei )?helfen\\.?\\s*$`, 'i'),
  new RegExp(`^${LEAD_IN}não posso ajudar com isso\\.?\\s*$`, 'i'),
  new RegExp(`^${LEAD_IN}non posso aiutart[ei] con questo\\.?\\s*$`, 'i')
];

// Signal 2c (v3.13.6x, Fase 9 testing, ronda 4): refusal-specific TOPIC
// phrases near the start of the output. Found by real testing (Lyca,
// Nekopara Vol.1): a Clipboard hook briefly picked up an unrelated,
// LONG paragraph of pasted text as "game text" — GPT refused in Spanish
// ("Lo siento, no puedo proporcionar contenido adicional o modificar...")
// and it sailed straight to the overlay uncaught. Neither existing signal
// could have caught it: 2a assumes a refusal is LONGER than the dialogue
// it displaces, which inverts when the SOURCE itself is the noisy/long
// side (garbled hook buffer, or here, unrelated pasted text); 2b never
// applies to a Latin-script target. This signal is independent of length
// on both sides — it looks for what a refusal talks ABOUT (providing/
// generating content, policies) rather than how long it or the source is.
// Deliberately phrase-level (2+ words), not single keywords: "contenido"
// alone is an everyday Spanish word (e.g. "tengo mucho contenido que
// estudiar") that would false-positive constantly if matched bare.
const REFUSAL_TOPIC_RE = new RegExp(
  '(?:proporcionar|generar|crear|producir)\\s+(?:ese\\s+tipo\\s+de\\s+|dicho\\s+)?(?:contenido|texto)' +
  '|(?:provide|generate|create|produce)\\s+(?:that\\s+(?:type|kind)\\s+of\\s+)?(?:content|text)' +
  '|pol[ií]tica(?:s)?\\s+de\\s+(?:contenido|uso)' +
  '|content\\s+policy|usage\\s+policy' +
  '|(?:violar|infringir)\\s+(?:las\\s+|sus\\s+)?(?:normas|pol[ií]ticas|directrices)' +
  '|violat\\w*\\s+(?:the\\s+)?(?:polic|guideline)',
  'i'
);

function isLikelyRefusal(text, sourceText, targetLangCode) {
  if (REFUSAL_PATTERNS_UNCONDITIONAL.some((re) => re.test(text))) return true;
  if (!REFUSAL_PATTERNS.some((re) => re.test(text))) return false;

  // Signal 2a: the output is disproportionately LONGER than the source.
  // A real character who says "I'm sorry, I can't" produces a translation
  // roughly as short as the line they said; a full refusal boilerplate
  // ("I cannot assist with this request as it may contain...") does not.
  const srcLen = (sourceText || '').length;
  const lengthDisproportionate = text.length > 40 && text.length > srcLen * 3;

  // Signal 2b: the output isn't even in the expected script for the
  // target language — catches an English refusal when translating INTO
  // Japanese/Chinese/Korean/Russian regardless of length, since a real
  // translation into those languages should be overwhelmingly non-Latin.
  const expected = expectedScriptFor(targetLangCode);
  const dominant = dominantScript(text);
  const scriptMismatch = expected !== 'latin' && dominant !== 'none' && dominant !== expected && text.length > 20;

  const topicMatch = REFUSAL_TOPIC_RE.test(text.slice(0, 250));

  return lengthDisproportionate || scriptMismatch || topicMatch;
}

// ─── step 8: passthrough (model echoed the source instead of translating) ─
const { combinedSimilarity } = require('./fuzzy-matcher');

function isLikelyPassthrough(text, sourceText, sourceLangCode, targetLangCode) {
  if (!sourceText || text.length < 4) return false;
  const srcScript = expectedScriptFor(sourceLangCode);
  const tgtScript = expectedScriptFor(targetLangCode);
  // If source and target share an expected script (e.g. en->es, both
  // 'latin'), high textual similarity is completely normal for a CORRECT
  // translation (cognates, shared names, short lines) — this check can
  // only be trusted when the scripts genuinely differ, so a JA source
  // surviving untranslated into an ES output is unambiguous.
  if (srcScript === tgtScript) return false;
  return combinedSimilarity(sourceText, text) >= 0.9;
}

// ─── the pipeline itself ──────────────────────────────────────────────────
/**
 * @param {string} raw - the LLM's raw message content, untrimmed
 * @param {object} meta
 * @param {string} [meta.sourceText] - the text that was sent to the model
 * @param {string} [meta.sourceLangCode]
 * @param {string} [meta.targetLangCode]
 * @param {string|null} [meta.finishReason] - e.g. 'stop' | 'length' | null
 * @returns {{text: string, actions: string[], verdict: 'ok'|'truncated'|'refusal'|'passthrough'}}
 */
function sanitizeLLMOutput(raw, { sourceText = '', sourceLangCode = '', targetLangCode = '', finishReason = null } = {}) {
  const actions = [];
  let text = (raw || '').trim();
  let verdict = 'ok';

  if (!text) {
    // llm-base.js already throws before ever calling this on an empty
    // response — this branch exists so the module is safe to call
    // standalone (bench, future callers) without that upstream guard.
    return { text: '', actions: ['empty'], verdict: 'refusal' };
  }

  // 2. finish_reason === 'length': the response was cut off by max_tokens.
  // Still run the rest of the pipeline below for the cleanest possible
  // display text, but the verdict marks it as unfit for caching/TM/context
  // — pipeline.js is what actually enforces that (see there).
  if (finishReason === 'length') {
    verdict = 'truncated';
    actions.push('finish-reason-length');
  }

  // 3. code fences wrapping the WHOLE output only — a fenced snippet
  // embedded mid-response is left alone (that's the model's content, not
  // formatting cruft around it).
  const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
    actions.push('stripped-code-fence');
  }

  // 4. reasoning blocks (<think>/<thinking>) from reasoning models
  // (DeepSeek-R1, QwQ, and derivatives commonly served through Ollama).
  const beforeReasoning = text;
  text = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
  if (text !== beforeReasoning) {
    actions.push('stripped-reasoning-block');
  }
  // An opening tag with no matching close means the response was cut off
  // mid-thought (almost always alongside finish_reason==='length', but
  // checked independently in case a provider doesn't report it).
  if (/<think(?:ing)?>/i.test(text)) {
    verdict = 'truncated';
    actions.push('unclosed-reasoning-block');
  }

  // 5. a labeled preamble on the first line, only stripped if there's
  // still real content after it — never strip the ENTIRE output because
  // it happened to start with a word from this list.
  const preambleMatch = text.match(/^(?:here(?:'s| is)?(?: the)? translation:?|translation:|translated text:|output:|翻訳[:：]|訳[:：])\s*([\s\S]+)$/i);
  if (preambleMatch && preambleMatch[1].trim()) {
    text = preambleMatch[1].trim();
    actions.push('stripped-preamble');
  } else {
    // v1.0.4: la lista de arriba sólo cubre inglés y japonés, pero el modelo
    // escribe su preámbulo en el idioma DESTINO — un usuario con destino
    // español recibía "Aquí tienes la traducción al español:\n\nNo puedo
    // creer que hayas hecho eso." Es el mismo agujero que ya había tenido la
    // detección de rechazos (ver REFUSAL_PATTERNS, v3.13.6x): una tabla de
    // frases en inglés no cubre a un modelo que responde en el idioma al que
    // se le pidió traducir. Enumerar los 20 destinos no escala ni envejece
    // bien, así que esta regla se apoya en la FORMA, no en las palabras.
    //
    // Las tres condiciones juntas son lo que la hace segura frente al
    // diálogo de visual novel, donde "???: Good to know we're on the same
    // page." es contenido legítimo:
    //   1. los dos puntos CIERRAN la línea (en el diálogo van a mitad);
    //   2. sigue una línea EN BLANCO;
    //   3. la línea es corta — un preámbulo, no un párrafo.
    const shapedPreamble = text.match(/^([^\n]{1,80}[:：])\r?\n\s*\r?\n([\s\S]+)$/);
    if (shapedPreamble && shapedPreamble[2].trim()) {
      text = shapedPreamble[2].trim();
      actions.push('stripped-preamble');
    }
  }

  // 6. wrapping quotes the model added around its own output.
  text = stripWrappingQuotesIfSafe(text, sourceText, actions);

  // 7. refusal — two independent signals required, see isLikelyRefusal.
  if (verdict === 'ok' && isLikelyRefusal(text, sourceText, targetLangCode)) {
    verdict = 'refusal';
    actions.push('detected-refusal');
  }

  // 8. passthrough — the model echoed the source instead of translating.
  if (verdict === 'ok' && isLikelyPassthrough(text, sourceText, sourceLangCode, targetLangCode)) {
    verdict = 'passthrough';
    actions.push('detected-passthrough');
  }

  // 9. a trailing translator's note in a separate paragraph.
  const notesMatch = text.match(/\n\s*\n\s*(?:note:|tl note|翻訳者注|\*)/i);
  if (notesMatch) {
    text = text.slice(0, notesMatch.index).trim();
    actions.push('stripped-trailing-note');
  }

  // 10. final cleanup.
  text = text.trim().replace(/\n{3,}/g, '\n\n');

  return { text, actions, verdict };
}

/**
 * Thrown by llm-base.js when sanitizeLLMOutput() returns verdict:'refusal'.
 * Deliberately NOT retryable (see pipeline.js _isRetryable) — retrying the
 * same engine with the same prompt will refuse again; the pipeline's
 * existing fallback chain is what should handle it instead.
 */
class LLMRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMRefusalError';
  }
}

/**
 * Thrown by llm-base.js when sanitizeLLMOutput() returns
 * verdict:'passthrough' — the model returned the source text essentially
 * untranslated. Same non-retryable reasoning as LLMRefusalError.
 */
class LLMPassthroughError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMPassthroughError';
  }
}

module.exports = {
  sanitizeLLMOutput,
  LLMRefusalError,
  LLMPassthroughError,
  // exported for the bench and for any future step that needs script
  // classification (e.g. glossary-prompt.js's word-boundary guard, Fase 5)
  expectedScriptFor,
  dominantScript
};
