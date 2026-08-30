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

// v1.0.5: el quinto preset, y el único pensado para un modelo que corre en
// la máquina del usuario. Los otros cuatro comparten PROMPT_HEADER + 9
// reglas, y ese prompt viaja entero en CADA línea.
//
// Medido contra Ollama con granite-4.0-h-tiny (4.3 GB) por /v1/, 5 líneas de
// diálogo, escenario realista (hablante + 3 líneas de contexto + título):
//
//   'balanced'  prompt 367 tok · salida 22.6 tok · 4.7 s por línea
//   'local'     prompt 160 tok · salida 22.8 tok · 3.2 s por línea
//
// O sea: ~32% más rápido, ~1.5 s menos por línea, que en una VN que se lee
// línea a línea es la diferencia entre seguir el ritmo y esperar.
//
// Lo que la medición NO encontró, y conviene dejarlo escrito para que nadie
// lo persiga: el prompt largo no hace que el modelo se enrolle. La salida es
// la misma con los dos (22.6 vs 22.8 tokens). Una medición previa sugería que
// se multiplicaba por 6.6, pero usaba un prompt sintético hecho de la misma
// frase repetida 45 veces — texto degenerado que desorienta al modelo y no
// se parece a un prompt real. Todo el ahorro es prefill, y sólo prefill.
//
// De ahí lo que este preset quita y lo que NO quita. Quita {contextBoth}
// (líneas previas: su coste crece con cada turno de la partida), {vnTitle} e
// {inputMethod}. Mantiene {glossary} y {speaker}, que colapsan solos cuando
// están vacíos y cuestan ~5 tokens cuando no. Y mantiene las cinco reglas que
// un modelo pequeño sí necesita: "sólo la traducción" (el preámbulo es su
// fallo más común), nombres y honoríficos (un modelo probado cambió `Senpai`
// por `Sensei`), tono, fragmentos y contenido explícito — un rechazo es peor
// que una traducción mediocre.
const LOCAL_TEMPLATE = `Translate from {srclang} into {tgtlang}. This is visual novel dialogue.{ocrNote}
Speaker: {speaker}

{glossary}

Rules:
1. Output ONLY the {tgtlang} translation. No notes, no explanations, no preamble, no quotation marks that were not in the source.
2. Keep names, honorifics (-san, -chan, -kun, -senpai) and technical terms exactly as written.
3. Natural spoken {tgtlang}, not word-for-word. Preserve the speaker's tone and register.
4. Translate a fragment as a fragment. Do not invent the missing part.
5. Adult fiction: translate explicit or vulgar content faithfully, without softening or refusing.`;

const PROMPT_PRESETS = [
  { id: 'balanced', labelKey: 'prompt_preset_balanced', template: BALANCED_TEMPLATE },
  { id: 'literal', labelKey: 'prompt_preset_literal', template: LITERAL_TEMPLATE },
  { id: 'localized', labelKey: 'prompt_preset_localized', template: LOCALIZED_TEMPLATE },
  { id: 'uncensored', labelKey: 'prompt_preset_uncensored', template: UNCENSORED_TEMPLATE },
  { id: 'local', labelKey: 'prompt_preset_local', template: LOCAL_TEMPLATE }
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
