/**
 * prompt-template.js bench — LLM engine overhaul, Fase 4. Pure Node, no
 * network, no Electron.
 *
 * The single most important case here is the collapse-rule family: a line
 * built only from auto-collapsible variables (see prompt-template.js's own
 * AUTO_COLLAPSIBLE_VARS doc comment) must disappear ENTIRELY — literal
 * label text included — when those variables are empty, rather than
 * leaving a dangling "- Title: " with nothing after it. Getting this wrong
 * either way is real: leave it un-collapsed and every user without a
 * glossary/game-title/speaker sees empty labels forever; collapse too
 * eagerly (e.g. treating `{inputMethod}` as collapsible) and a line that
 * should always be present silently vanishes.
 *
 *   node scripts/test-prompt-template.js
 *   node scripts/test-prompt-template.js --quiet
 */
const path = require('path');
const { renderPromptTemplate, AUTO_COLLAPSIBLE_VARS } = require(path.join('..', 'src', 'services', 'translation', 'prompt-template.js'));
const {
  DEFAULT_TEMPLATE, PROMPT_PRESETS, matchPresetId, seedPromptTemplateFromLegacySystemPrompt
} = require(path.join('..', 'src', 'services', 'translation', 'prompt-presets.js'));
const { FEWSHOT_EXAMPLES, getFewshotExamples } = require(path.join('..', 'src', 'services', 'translation', 'fewshot-examples.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

// ─── basic substitution ───────────────────────────────────────────────────
check('substitutes-simple-variables', () => {
  const { text } = renderPromptTemplate('Translate from {srclang} to {tgtlang}.', { srclang: 'Japanese', tgtlang: 'Spanish' });
  return { pass: text === 'Translate from Japanese to Spanish.', actual: text };
});

check('substitutes-language-codes', () => {
  const { text } = renderPromptTemplate('{srclangcode}->{tgtlangcode}', { srclangcode: 'ja', tgtlangcode: 'es' });
  return { pass: text === 'ja->es', actual: text };
});

check('sentence-variable-is-tracked-via-containsSentence', () => {
  const withSentence = renderPromptTemplate('Line: {sentence}', { sentence: 'hi' });
  const withoutSentence = renderPromptTemplate('No sentence here', {});
  return {
    pass: withSentence.containsSentence === true && withoutSentence.containsSentence === false,
    actual: { withSentence: withSentence.containsSentence, withoutSentence: withoutSentence.containsSentence }
  };
}, "This is what llm-base.js reads to decide whether to append the real line as a separate final `user` turn — the rule that kills the v3.13.55 {TEXT} bug at the root.");

// ─── the collapse rule (the load-bearing one) ────────────────────────────
check('line-with-only-an-empty-auto-collapsible-variable-and-a-label-disappears-entirely', () => {
  const { text } = renderPromptTemplate('Header\n- Title: {vnTitle}\nFooter', { vnTitle: '' });
  return { pass: text === 'Header\nFooter', actual: text };
}, 'The literal "- Title: " label must NOT survive when vnTitle is unset — that dangling label is exactly what the collapse rule exists to prevent.');

check('line-with-a-non-empty-auto-collapsible-variable-is-kept', () => {
  const { text } = renderPromptTemplate('Header\n- Title: {vnTitle}\nFooter', { vnTitle: 'Nekopara' });
  return { pass: text === 'Header\n- Title: Nekopara\nFooter', actual: text };
});

check('standalone-glossary-line-collapses-when-empty', () => {
  const { text } = renderPromptTemplate('Before\n{glossary}\nAfter', { glossary: '' });
  return { pass: text === 'Before\nAfter', actual: text };
});

check('standalone-glossary-line-survives-when-populated', () => {
  const { text } = renderPromptTemplate('Before\n{glossary}\nAfter', { glossary: 'Glossary — apply these:\n- 灰音 → Haine' });
  return { pass: text === 'Before\nGlossary — apply these:\n- 灰音 → Haine\nAfter', actual: text };
});

check('inputMethod-is-NOT-auto-collapsible-even-when-empty', () => {
  const { text } = renderPromptTemplate('Source: {inputMethod}.', {});
  return { pass: text === 'Source: .', actual: text };
}, "Deliberately NOT collapsed: inputMethod is always-known data once Fase 7 wires it (never legitimately optional the way a game's title is) — collapsing it would hide a real bug if it were ever actually empty in production.");

check('sentence-is-NOT-auto-collapsible-even-when-empty', () => {
  const { text } = renderPromptTemplate('Line: {sentence}', { sentence: '' });
  return { pass: text === 'Line: .' || text === 'Line:', actual: text };
});

check('mixed-line-with-one-collapsible-empty-and-one-non-collapsible-is-kept', () => {
  // From the real default template: "Source text comes from {inputMethod}.{ocrNote}"
  const { text } = renderPromptTemplate('Source text comes from {inputMethod}.{ocrNote}', { inputMethod: 'hook', ocrNote: '' });
  return { pass: text === 'Source text comes from hook.', actual: text };
}, 'ocrNote (collapsible, empty) contributes nothing; inputMethod (not collapsible) keeps the line alive — this is the exact mixed case the default template relies on.');

check('runs-of-blank-lines-left-by-collapses-are-tidied-to-one-blank-line', () => {
  const { text } = renderPromptTemplate('A\n\n{glossary}\n\nB', { glossary: '' });
  return { pass: text === 'A\n\nB', actual: text };
});

// ─── unknown variables ────────────────────────────────────────────────────
check('unknown-variable-is-left-literal-and-reported-as-a-warning', () => {
  const { text, warnings } = renderPromptTemplate('Hello {TEXT}', {});
  return {
    pass: text === 'Hello {TEXT}' && warnings.length === 1 && warnings[0].includes('TEXT'),
    actual: { text, warnings }
  };
}, 'Regression guard, in spirit, for the v3.13.55 bug this whole system exists to prevent from happening again: a typo must be VISIBLE (literal + warned), never silently swallowed.');

// ─── context formatting ───────────────────────────────────────────────────
const CONTEXT = [
  { source: 'おはよう', translation: 'Buenos días' },
  { source: 'ただいま', translation: 'Ya llegué' },
  { source: 'こんにちは', translation: 'Hola' }
];

check('contextBoth-formats-source-arrow-translation-pairs-oldest-first', () => {
  const { text } = renderPromptTemplate('{contextBoth}', { context: CONTEXT });
  return { pass: text === 'おはよう → Buenos días\nただいま → Ya llegué\nこんにちは → Hola', actual: text };
});

check('contextOriginal-and-contextTranslation-format-just-their-own-side', () => {
  const original = renderPromptTemplate('{contextOriginal}', { context: CONTEXT }).text;
  const translation = renderPromptTemplate('{contextTranslation}', { context: CONTEXT }).text;
  return {
    pass: original === 'おはよう\nただいま\nこんにちは' && translation === 'Buenos días\nYa llegué\nHola',
    actual: { original, translation }
  };
});

check('contextBoth-with-N-keeps-only-the-N-most-recent-pairs', () => {
  const { text } = renderPromptTemplate('{contextBoth[2]}', { context: CONTEXT });
  return { pass: text === 'ただいま → Ya llegué\nこんにちは → Hola', actual: text };
}, 'Context is oldest-first (ContextMemory.get()) — [N] must keep the TAIL (most recent), not the head.');

check('context-variable-with-empty-window-collapses-its-line', () => {
  const { text } = renderPromptTemplate('Before\n{contextBoth}\nAfter', { context: [] });
  return { pass: text === 'Before\nAfter', actual: text };
});

check('context-variable-with-undefined-window-collapses-its-line', () => {
  const { text } = renderPromptTemplate('Before\n{contextBoth}\nAfter', {});
  return { pass: text === 'Before\nAfter', actual: text };
}, 'Forward-compatible with pipeline.js not passing `context` at all, same as any other unset variable.');

// ─── multiple variables in one line ──────────────────────────────────────
check('multiple-variables-on-one-line-all-substitute-correctly', () => {
  const { text } = renderPromptTemplate('{srclang}->{tgtlang}: {sentence}', { srclang: 'Japanese', tgtlang: 'Spanish', sentence: 'こんにちは' });
  return { pass: text === 'Japanese->Spanish: こんにちは', actual: text };
}, 'Back-to-front substitution must not corrupt earlier matches on the same line when replacement lengths differ from the placeholders.');

// ─── real default template smoke test ────────────────────────────────────
check('default-template-renders-cleanly-with-only-fase-4-available-context', () => {
  // Simulates exactly what pipeline.js can provide TODAY (Fase 4) — game/
  // vnTitle/speaker/glossary/inputMethod/ocrNote are all Fase 5/7 concerns
  // and simply absent here, same as they will be in production until then.
  const { text, warnings } = renderPromptTemplate(DEFAULT_TEMPLATE, {
    sentence: 'こんにちは、元気？',
    srclang: 'Japanese',
    tgtlang: 'Spanish',
    srclangcode: 'ja',
    tgtlangcode: 'es',
    context: []
  });
  const pass = warnings.length === 0
    && !text.includes('{')
    && !text.includes('Title:')
    && !text.includes('speaker:')
    && text.includes('Rules — follow every one of them:')
    && text.includes('Japanese')
    && text.includes('Spanish');
  return { pass, actual: { text, warnings } };
}, 'No unresolved {variable} placeholders, no dangling "Title:"/"speaker:" labels, and the rules block survives — this is the exact shape production sees before Fase 5/7 land.');

check('default-template-does-not-reference-sentence-so-the-final-user-turn-is-still-appended', () => {
  const { containsSentence } = renderPromptTemplate(DEFAULT_TEMPLATE, { sentence: 'x', srclang: 'Japanese', tgtlang: 'Spanish' });
  return { pass: containsSentence === false, actual: containsSentence };
}, "The plan's default template puts the line to translate in a separate final `user` message, not embedded in the system prompt — this pins that it stays that way.");

check('auto-collapsible-set-does-not-include-always-present-variables', () => {
  const offenders = ['sentence', 'srclang', 'tgtlang', 'srclangcode', 'tgtlangcode', 'inputMethod'].filter((v) => AUTO_COLLAPSIBLE_VARS.has(v));
  return { pass: offenders.length === 0, actual: offenders };
});

// ─── prompt-presets.js ────────────────────────────────────────────────────
check('every-preset-renders-cleanly-with-no-warnings-and-no-leftover-placeholders', () => {
  const failures = PROMPT_PRESETS.map((preset) => {
    const { text, warnings } = renderPromptTemplate(preset.template, {
      sentence: 'x', srclang: 'Japanese', tgtlang: 'Spanish', srclangcode: 'ja', tgtlangcode: 'es', context: []
    });
    return { id: preset.id, ok: warnings.length === 0 && !/\{[A-Za-z]+\}/.test(text) };
  }).filter((r) => !r.ok);
  return { pass: failures.length === 0, actual: failures };
}, 'All 4 presets share the same variable set as DEFAULT_TEMPLATE — this catches a typo in any of them (e.g. a preset referencing a variable prompt-template.js does not recognize).');

check('presets-differ-from-each-other-in-rule-5-and-7-but-share-rules-1-4-6-8-9', () => {
  const balanced = PROMPT_PRESETS.find((p) => p.id === 'balanced').template;
  const literal = PROMPT_PRESETS.find((p) => p.id === 'literal').template;
  const localized = PROMPT_PRESETS.find((p) => p.id === 'localized').template;
  const uncensored = PROMPT_PRESETS.find((p) => p.id === 'uncensored').template;
  const allDistinct = new Set([balanced, literal, localized, uncensored]).size === 4;
  // The header through rule 4 is shared verbatim across all four.
  const sharedHeader = balanced.split('\n5.')[0];
  const allShareHeader = [literal, localized, uncensored].every((t) => t.startsWith(sharedHeader));
  return { pass: allDistinct && allShareHeader, actual: { allDistinct, allShareHeader } };
});

check('matchPresetId-identifies-each-preset-by-exact-text-and-falls-back-to-custom', () => {
  const matchesSelf = PROMPT_PRESETS.every((p) => matchPresetId(p.template) === p.id);
  const customFallback = matchPresetId('something the user typed by hand') === 'custom';
  const emptyIsCustom = matchPresetId('') === 'custom';
  return { pass: matchesSelf && customFallback && emptyIsCustom, actual: { matchesSelf, customFallback, emptyIsCustom } };
}, "Empty string is deliberately 'custom', not 'balanced' — it resolves to DEFAULT_TEMPLATE at render time (llm-base.js), but as stored text it isn't byte-identical to any preset.");

check('default-template-is-exactly-the-balanced-preset', () => {
  const balanced = PROMPT_PRESETS.find((p) => p.id === 'balanced');
  return { pass: DEFAULT_TEMPLATE === balanced.template, actual: DEFAULT_TEMPLATE === balanced.template };
}, 'A fresh install and explicitly selecting "Balanced" must be byte-identical, not two separately-maintained copies of the same text.');

// ─── seedPromptTemplateFromLegacySystemPrompt (migration) ────────────────
check('migration-seeds-promptTemplate-from-a-non-empty-legacy-systemPrompt-verbatim', () => {
  const result = seedPromptTemplateFromLegacySystemPrompt({ systemPrompt: 'Translate literally, word for word.' });
  return { pass: result === 'Translate literally, word for word.', actual: result };
});

check('migration-is-a-no-op-when-already-migrated', () => {
  const result = seedPromptTemplateFromLegacySystemPrompt({ systemPrompt: 'old text', promptTemplate: 'already set' });
  return { pass: result === null, actual: result };
});

check('migration-is-a-no-op-when-there-is-nothing-to-migrate', () => {
  const result = seedPromptTemplateFromLegacySystemPrompt({ systemPrompt: '' });
  return { pass: result === null, actual: result };
});

// ─── fewshot-examples.js ───────────────────────────────────────────────────
check('fewshot-lookup-is-keyed-by-language-code-pair-not-by-english-name', () => {
  const jaEs = getFewshotExamples('ja', 'es');
  const missing = getFewshotExamples('xx', 'yy');
  return { pass: jaEs.length > 0 && missing.length === 0, actual: { jaEsCount: jaEs.length, missingCount: missing.length } };
});

check('every-fewshot-pair-has-both-a-user-and-an-assistant-string', () => {
  const offenders = [];
  for (const [pairKey, examples] of Object.entries(FEWSHOT_EXAMPLES)) {
    examples.forEach((ex, i) => {
      if (typeof ex.user !== 'string' || !ex.user || typeof ex.assistant !== 'string' || !ex.assistant) {
        offenders.push(`${pairKey}[${i}]`);
      }
    });
  }
  return { pass: offenders.length === 0, actual: offenders };
});

// ─── v1.0.5: el preset 'local' ────────────────────────────────────────────
// Existe porque los otros cuatro comparten PROMPT_HEADER + 9 reglas, ~700
// tokens que viajan en cada línea. Medido con granite-4.0-h-tiny: el
// 'balanced' no sólo cuesta prefill, multiplica por 6.6 la SALIDA (21 -> 139
// tokens) porque un modelo pequeño con nueve reglas encima se pone a
// elaborar en vez de traducir. Ver el comentario de LOCAL_TEMPLATE.

check('local-preset-exists-and-round-trips-through-matchPresetId', () => {
  const preset = PROMPT_PRESETS.find((p) => p.id === 'local');
  const pass = !!preset && matchPresetId(preset.template) === 'local';
  return { pass, actual: preset ? matchPresetId(preset.template) : 'preset ausente' };
});

check('local-preset-is-materially-shorter-than-balanced', () => {
  const local = PROMPT_PRESETS.find((p) => p.id === 'local').template;
  const balanced = PROMPT_PRESETS.find((p) => p.id === 'balanced').template;
  // El umbral es del 70% y no una cifra exacta: lo que hay que proteger es
  // la INTENCIÓN (que siga siendo corto), no una longitud concreta que
  // cualquier reescritura legítima cambiaría. Si alguien le añade reglas
  // hasta acercarlo al 'balanced', este check cae y obliga a releer por qué
  // existe el preset.
  const ratio = local.length / balanced.length;
  return { pass: ratio < 0.7, actual: { localChars: local.length, balancedChars: balanced.length, ratio: Number(ratio.toFixed(2)) } };
}, 'Un preset "para modelo pequeño" que crece hasta el tamaño del general deja de tener sentido.');

check('local-preset-does-not-send-the-previous-lines', () => {
  // El contexto es la variable cuyo coste CRECE con la partida: cada turno
  // añade tokens a cada petición siguiente. Es la primera que se quita en
  // un modelo local, y quitarla es media razón de ser del preset.
  const local = PROMPT_PRESETS.find((p) => p.id === 'local').template;
  const offenders = ['{contextBoth}', '{contextOriginal}', '{contextTranslation}'].filter((v) => local.includes(v));
  return { pass: offenders.length === 0, actual: offenders };
});

check('local-preset-renders-with-no-unknown-variable-warnings', () => {
  const local = PROMPT_PRESETS.find((p) => p.id === 'local').template;
  const rendered = renderPromptTemplate(local, {
    sentence: 'x', srclang: 'English', tgtlang: 'Spanish',
    srclangcode: 'en', tgtlangcode: 'es', context: []
  });
  return { pass: rendered.warnings.length === 0, actual: rendered.warnings };
}, 'Una variable mal escrita no se borra en silencio: viajaría literal al modelo.');

check('local-preset-collapses-its-optional-lines-when-empty', () => {
  const local = PROMPT_PRESETS.find((p) => p.id === 'local').template;
  const rendered = renderPromptTemplate(local, {
    sentence: 'x', srclang: 'English', tgtlang: 'Spanish',
    srclangcode: 'en', tgtlangcode: 'es', context: []
  });
  // Sin hablante ni glosario, la etiqueta "Speaker:" no puede quedar colgando.
  const pass = !rendered.text.includes('Speaker:');
  return { pass, actual: rendered.text.slice(0, 120) };
});

check('every-preset-labelkey-exists-in-all-8-locales', () => {
  // Hueco previo que este commit cierra de paso: test-llm-providers.js hace
  // esta comprobación para CLOUD_PROVIDERS y LOCAL_ENDPOINT_PRESETS, pero
  // los labelKey de PROMPT_PRESETS no los miraba nadie — los cuatro
  // originales tampoco.
  const i18nPath = path.join(__dirname, '..', 'renderer', 'main', 'i18n.js');
  const translations = require(i18nPath);
  const locales = Object.keys(translations);
  const missing = [];
  for (const locale of locales) {
    for (const preset of PROMPT_PRESETS) {
      if (!(preset.labelKey in translations[locale])) missing.push(`${locale}.${preset.labelKey}`);
      const descKey = `${preset.labelKey}_desc`;
      if (!(descKey in translations[locale])) missing.push(`${locale}.${descKey}`);
    }
  }
  return { pass: locales.length === 8 && missing.length === 0, actual: { localeCount: locales.length, missing } };
}, 'Un preset seleccionable cuyo nombre se renderiza en blanco es peor que no ofrecerlo.');
run("prompt-template.js bench", CHECKS);
