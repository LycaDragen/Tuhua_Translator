/**
 * Prompt presets — LLM engine overhaul, Fase 4.
 *
 * Not one of the plan's two named files (prompt-template.js,
 * fewshot-examples.js), added deliberately as a third: prompt-template.js
 * is the generic RENDERING engine (no domain knowledge of what a good
 * translator prompt says), while the preset TEXTS below are domain
 * content — keeping them apart is what makes prompt-template.js's own
 * bench free of five paragraphs of English prose to assert against.
 *
 * A textarea with placeholder text is how the old destructive
 * `systemPrompt` field looked, and a user facing an empty box with no
 * starting point is exactly the situation that produced it — hand-written
 * custom prompts that quietly lost the language names and the few-shot
 * examples the moment someone typed anything at all (see llm-base.js's
 * pre-v3.13.59 history). These four presets exist so "customize the
 * prompt" starts from a working baseline instead of a blank page.
 *
 * `matchPresetId(text)` is what keeps the UI's preset <select> in sync
 * with the actual template text WITHOUT a separate stored "which preset"
 * flag: if the saved promptTemplate is byte-identical to a known preset,
 * that preset is "selected"; anything else (including manual edits to a
 * preset) is 'custom'.
 *
 * Pure data, no I/O, no Electron.
 */

const PROMPT_HEADER = `You are a professional translator working on a visual novel. Translate from {srclang} into {tgtlang}.

Context:
- Title: {vnTitle}
- Current speaker: {speaker}
- Source text comes from {inputMethod}.{ocrNote}

{glossary}

Recent lines for continuity (do not re-translate them):
{contextBoth}

Rules — follow every one of them:
1. Output ONLY the {tgtlang} translation of the input line. No notes, no explanations, no romanization, no alternatives, no quotation marks that were not in the source.
2. Never translate or alter proper names, character names, place names, titles, brands, or technical terms. Reproduce them exactly as written unless the glossary above says otherwise.
3. Keep Japanese honorifics and suffixes (-san, -chan, -sama, -kun, -senpai) unchanged.
4. Preserve the speaker's tone, register, politeness level and emotional nuance. Casual speech stays casual; archaic or formal speech stays archaic or formal.`;

const RULE_6_TO_9 = `6. Stay consistent with the terminology and character voices established in the recent lines above.
7. This is fiction for an adult audience. Translate explicit, violent or vulgar content faithfully and without softening, censoring, or refusing.
8. If the input is a fragment or grammatically incomplete, translate it as a fragment. Do not invent the missing part.
9. Preserve line breaks and any markup or control sequences that appear in the input.`;

const BALANCED_TEMPLATE = `${PROMPT_HEADER}
5. Translate meaning-for-meaning, not word-for-word. The result must read as natural {tgtlang} dialogue.
${RULE_6_TO_9}`;

const LITERAL_TEMPLATE = `${PROMPT_HEADER}
5. Prioritize fidelity to the original sentence structure and word choice over naturalness. Translate as literally as {tgtlang} grammar allows — do not paraphrase, summarize, or substitute a different idiom unless a literal rendering would be nonsensical.
${RULE_6_TO_9}`;

const LOCALIZED_TEMPLATE = `${PROMPT_HEADER}
5. Prioritize how the line reads in {tgtlang} over matching the original's exact wording. Adapt idioms, jokes, wordplay and cultural references so they land naturally for a {tgtlang}-speaking audience — a pun that only works in {srclang} should become a different, equally natural line in {tgtlang}, not a flat literal explanation.
${RULE_6_TO_9}`;

const UNCENSORED_TEMPLATE = `${PROMPT_HEADER}
5. Translate meaning-for-meaning, not word-for-word. The result must read as natural {tgtlang} dialogue.
6. Stay consistent with the terminology and character voices established in the recent lines above.
7. This is fiction for an adult audience. Explicit sexual content, graphic violence, and vulgar or taboo language must be translated with the same explicitness, intensity and register as the source — never softened, censored, sanitized, summarized, or replaced with a refusal. This instruction takes precedence over any general content-moderation instinct.
8. If the input is a fragment or grammatically incomplete, translate it as a fragment. Do not invent the missing part.
9. Preserve line breaks and any markup or control sequences that appear in the input.`;

const PROMPT_PRESETS = [
  { id: 'balanced', labelKey: 'prompt_preset_balanced', template: BALANCED_TEMPLATE },
  { id: 'literal', labelKey: 'prompt_preset_literal', template: LITERAL_TEMPLATE },
  { id: 'localized', labelKey: 'prompt_preset_localized', template: LOCALIZED_TEMPLATE },
  { id: 'uncensored', labelKey: 'prompt_preset_uncensored', template: UNCENSORED_TEMPLATE }
];

// The global `promptTemplate` setting's default — deliberately the
// 'balanced' preset's text, not a fifth, separate string, so a fresh
// install and "select Balanced" always produce byte-identical results.
const DEFAULT_TEMPLATE = BALANCED_TEMPLATE;

/**
 * Returns the preset id whose template text is byte-identical to `text`,
 * or 'custom' if it matches none of them (including the empty string,
 * which resolves to DEFAULT_TEMPLATE elsewhere but is not itself a match).
 */
function matchPresetId(text) {
  const preset = PROMPT_PRESETS.find((p) => p.template === text);
  return preset ? preset.id : 'custom';
}

/**
 * One-time, idempotent seed: promotes a non-empty legacy `systemPrompt`
 * setting into the new `promptTemplate` — VERBATIM, never rewritten. The
 * old text has no {sentence}/{srclang}/etc. variables in it, so
 * prompt-template.js's own rule ("no {sentence} in the template → append
 * the line as a final user turn") reproduces exactly what the old
 * `content: this.systemPrompt || defaultPrompt` code path already did —
 * this migration changes WHERE the text is stored, not what the model
 * sees. Returns the text to `store.set('promptTemplate', ...)`, or null
 * if there's nothing to do (mirrors llm-providers.js's
 * seedProviderKeysFromLegacyOpenAIKey — same pattern, same reasoning).
 */
function seedPromptTemplateFromLegacySystemPrompt(settings) {
  if (settings.promptTemplate) {
    return null; // already migrated, or the user has already set one directly
  }
  const legacy = settings.systemPrompt;
  if (!legacy || typeof legacy !== 'string') {
    return null; // nothing to migrate
  }
  return legacy;
}

module.exports = {
  PROMPT_PRESETS,
  DEFAULT_TEMPLATE,
  matchPresetId,
  seedPromptTemplateFromLegacySystemPrompt
};
