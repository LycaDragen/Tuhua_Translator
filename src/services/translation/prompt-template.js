/**
 * Prompt template engine — LLM engine overhaul, Fase 4.
 *
 * Before this, the system prompt was one hardcoded string, and a custom
 * `systemPrompt` setting REPLACED it entirely — which meant a user who
 * wrote their own prompt silently lost the source/target language names
 * (never interpolated anywhere else) AND the few-shot examples (gated on
 * `if (!this.systemPrompt)` — see llm-base.js pre-v3.13.59). This module
 * is what makes a custom prompt additive instead of destructive: variables
 * for everything the old hardcoded prompt only had access to internally,
 * plus new ones (game title, speaker, glossary, input method) that Fases
 * 5-7 will start actually populating — until then those simply resolve
 * empty and their line collapses away (see the collapse rule below), so
 * writing the default template now doesn't require waiting for later
 * Fases to land.
 *
 * Pure, no I/O, no Electron — requireable from a plain-Node bench.
 */

// Variables that are legitimately allowed to be empty (no game title set,
// no glossary matches, no speaker parsed, empty context window, ...) — a
// template LINE composed entirely of these (see the collapse rule in
// renderPromptTemplate) disappears rather than leaving a dangling label
// like "- Title: " with nothing after it.
//
// Deliberately NOT in this set: `sentence` (never legitimately empty —
// llm-base.js throws before rendering if it were), `srclang`/`tgtlang`/
// `srclangcode`/`tgtlangcode` (always known), `inputMethod` (always known
// once Fase 7 wires it — never optional data the way a game's title is).
const AUTO_COLLAPSIBLE_VARS = new Set([
  'contextBoth', 'contextOriginal', 'contextTranslation',
  'glossary', 'game', 'vnTitle', 'speaker', 'ocrNote'
]);

const VARIABLE_RE = /\{(\w+)(?:\[(\d+)\])?\}/g;

/**
 * Formats the raw context window (same shape as ContextMemory.get():
 * oldest-first `{source, translation}` pairs) for one of the three context
 * variables. `limit` (from the `[N]` template syntax) keeps only the N
 * MOST RECENT pairs — context is oldest-first, so that's the tail.
 */
function formatContext(contextPairs, limit, mode) {
  if (!Array.isArray(contextPairs) || contextPairs.length === 0) return '';
  const slice = limit !== undefined ? contextPairs.slice(-limit) : contextPairs;
  if (slice.length === 0) return '';
  return slice
    .map((pair) => {
      if (mode === 'source') return pair.source;
      if (mode === 'translation') return pair.translation;
      return `${pair.source} → ${pair.translation}`;
    })
    .join('\n');
}

/**
 * Resolves one `{name}` or `{name[index]}` reference to its string value.
 * Unknown variable names are left LITERAL (not silently dropped) and
 * reported in `warnings` — silencing a typo is exactly what produced the
 * v3.13.55 `{TEXT}` bug this whole system exists to prevent from
 * happening again in a new form.
 */
function resolveVariable(name, index, vars, warnings) {
  switch (name) {
    case 'sentence': return vars.sentence ?? '';
    case 'srclang': return vars.srclang ?? '';
    case 'tgtlang': return vars.tgtlang ?? '';
    case 'srclangcode': return vars.srclangcode ?? '';
    case 'tgtlangcode': return vars.tgtlangcode ?? '';
    case 'contextBoth': return formatContext(vars.context, index, 'both');
    case 'contextOriginal': return formatContext(vars.context, index, 'source');
    case 'contextTranslation': return formatContext(vars.context, index, 'translation');
    case 'glossary': return vars.glossary ?? '';
    case 'game': return vars.game ?? '';
    case 'vnTitle': return vars.vnTitle ?? '';
    case 'speaker': return vars.speaker ?? '';
    case 'inputMethod': return vars.inputMethod ?? '';
    case 'ocrNote': return vars.ocrNote ?? '';
    default:
      warnings.push(`Unknown template variable: {${name}}`);
      return `{${name}}`;
  }
}

/**
 * Renders a prompt template against a set of variables.
 *
 * @param {string} template
 * @param {object} vars
 * @param {string} [vars.sentence] - the line to translate
 * @param {string} [vars.srclang] [vars.tgtlang] - full language names
 * @param {string} [vars.srclangcode] [vars.tgtlangcode] - language codes
 * @param {Array<{source:string,translation:string}>} [vars.context] - oldest-first
 * @param {string} [vars.glossary] [vars.game] [vars.vnTitle] [vars.speaker]
 * @param {string} [vars.inputMethod] [vars.ocrNote]
 * @returns {{text: string, warnings: string[], containsSentence: boolean}}
 */
function renderPromptTemplate(template, vars = {}) {
  const warnings = [];
  const sourceLines = (template || '').split('\n');
  const outputLines = [];
  let containsSentence = false;

  for (const line of sourceLines) {
    const matches = [...line.matchAll(VARIABLE_RE)];
    if (matches.length === 0) {
      outputLines.push(line);
      continue;
    }

    const resolvedValues = matches.map((m) => {
      const name = m[1];
      const index = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
      if (name === 'sentence') containsSentence = true;
      return resolveVariable(name, index, vars, warnings);
    });

    // The collapse rule: if EVERY variable on this line is both
    // auto-collapsible and resolved to '', the whole line — including any
    // literal label text around the variable(s), e.g. "- Title: " — is
    // dropped. A line mixing a non-collapsible variable (or literal text
    // next to a NON-empty variable) is kept with substitutions applied.
    const allCollapsibleAndEmpty = matches.every((m, i) => AUTO_COLLAPSIBLE_VARS.has(m[1]) && resolvedValues[i] === '');
    if (allCollapsibleAndEmpty) {
      continue;
    }

    let renderedLine = line;
    // Replace back-to-front so earlier match indices in the same line
    // don't shift as substitutions change the line's length.
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      renderedLine = renderedLine.slice(0, m.index) + resolvedValues[i] + renderedLine.slice(m.index + m[0].length);
    }
    outputLines.push(renderedLine);
  }

  // Collapsed lines can leave behind runs of blank lines (a collapsed line
  // that sat between two intentional blank spacer lines) — tidy those up
  // the same way llm-output.js's sanitizer does, without touching single
  // intentional blank lines.
  const text = outputLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { text, warnings, containsSentence };
}

module.exports = {
  renderPromptTemplate,
  AUTO_COLLAPSIBLE_VARS
};
