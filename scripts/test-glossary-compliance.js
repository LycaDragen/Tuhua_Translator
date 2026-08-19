/**
 * Glossary compliance bench — LLM engine overhaul, Fase 5, Paso 0.
 *
 * The plan's Fase 5 is explicit: glossary-as-prompt-instruction is NOT
 * implemented blind. It's measured first, against a real engine, with a
 * threshold decided BEFORE looking at the number:
 *
 *   >= 90% compliance  → prompt-only glossary mode is fine on its own.
 *   <  90% compliance  → hybrid mode (prompt instruction + a post-hoc pass
 *                        that literally replaces any expected term the
 *                        model dropped) is the fallback design.
 *
 * Two legs, same corpus, same engine:
 *   - "literal": today's production path — glossary.applyPreTranslation()
 *     substitutes the term into the source text BEFORE it ever reaches the
 *     engine (pipeline.translateNow(), unmodified). The model receives a
 *     line that already contains the target string.
 *   - "prompt": the term stays in the source language; instead the engine
 *     receives a `{glossary}` block (glossary-prompt.js's
 *     buildGlossaryPrompt()) telling it what to do with the term. This
 *     calls the engine directly, bypassing pipeline.js's literal
 *     pre/post-processing entirely — pipeline.js has no prompt-mode wiring
 *     yet (that wiring is exactly what this measurement decides the shape
 *     of), so there is no production code path to point at yet.
 *
 * Compliance metric: % of (case × expectedTerm) pairs where the term
 * appears (case/diacritic-insensitive) in the model's output. The literal
 * leg's baseline is expected to sit near 100% by construction — it's a
 * substring replacement, so the term is already in what gets sent — but the
 * bench measures it anyway, for the qualitative comparison the plan asks
 * for (a term landing correctly mid-sentence with correct grammar vs. an
 * awkwardly unconjugated drop-in is the actual reason to prefer prompt mode
 * even where both hit 100%).
 *
 *   OPENAI_API_KEY=xxx node scripts/test-glossary-compliance.js --engine=openai
 *   LOCAL_LLM_ENDPOINT=http://localhost:11434/v1 LOCAL_LLM_MODEL=llama3 \
 *     node scripts/test-glossary-compliance.js --engine=local-llm
 *
 * Flags:
 *   --engine=openai   Engine to test: openai or local-llm.
 *   --json=PATH       Report output path (default scripts/glossary-compliance-report.json)
 *   --quiet           Suppress per-line detail, print summary only
 */

const fs = require('fs');
const path = require('path');

const TranslationPipeline = require('../src/services/translation/pipeline');
const GlossaryService = require('../src/services/translation/glossary');
const { buildGlossaryPrompt } = require('../src/services/translation/glossary-prompt');

const ROOT = path.resolve(__dirname, '..');
const GROUND_TRUTH = path.join(__dirname, 'glossary-compliance-ground-truth.json');
const COMPLIANCE_THRESHOLD = 90;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { engine: 'openai', json: path.join(__dirname, 'glossary-compliance-report.json') };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (value === undefined) args[key] = true;
    else args[key] = value;
  }
  return args;
}

// ─── Text matching (same normalize/containsWord as test-context-memory.js) ──

function normalize(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function containsWord(haystack, needle) {
  return normalize(haystack).includes(normalize(needle));
}

// ─── Engine construction ─────────────────────────────────────────────────────

const REQUIRED_ENV = {
  openai: [['OPENAI_API_KEY', 'a real OpenAI call']],
  'local-llm': [
    ['LOCAL_LLM_ENDPOINT', "your local server's OpenAI-compatible base URL — Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1"],
    ['LOCAL_LLM_MODEL', 'the exact model name your server has loaded (e.g. an `ollama list` name)']
  ]
};

function buildPipeline(engineName, meta, glossaryEntries, glossaryMode) {
  const glossary = new GlossaryService({ get: (k, d) => (k === 'entries' ? glossaryEntries : d), set: () => {} });
  const settings = {
    engine: engineName,
    sourceLang: meta.sourceLang,
    targetLang: meta.targetLang,
    openaiKey: process.env.OPENAI_API_KEY,
    llmProviderKeys: { openai: process.env.OPENAI_API_KEY },
    llmProvider: 'openai',
    customEndpoint: process.env.LOCAL_LLM_ENDPOINT,
    customModel: process.env.LOCAL_LLM_MODEL,
    // No context window in play here — this bench isolates glossary
    // compliance, not cross-line coherence (that's test:context-memory).
    maxContextHistory: 0,
    // Explicit, not left to pipeline.js's own 'prompt' default — the
    // "literal" leg below must exercise literal substitution even after
    // Fase 5 made 'prompt' the pipeline's default mode, or this bench
    // would silently stop measuring what its own name says it measures.
    glossaryMode
  };
  const pipeline = new TranslationPipeline(settings, { glossary });
  if (!pipeline.getEngine(engineName)) {
    throw new Error(`Unknown engine '${engineName}'`);
  }
  return pipeline;
}

// ─── Leg runners ──────────────────────────────────────────────────────────────

/**
 * "literal" leg — today's production path, completely unmodified:
 * pipeline.translateNow() applies glossary.applyPreTranslation() before the
 * engine ever sees the line.
 */
async function runLiteralLeg(engineName, groundTruth, quiet) {
  const pipeline = buildPipeline(engineName, groundTruth._meta, groundTruth.glossary, 'literal');
  pipeline.cache.clear();
  pipeline.translationMemory.clear();

  const caseResults = [];
  for (const c of groundTruth.cases) {
    const cacheHitsBefore = pipeline.stats.cacheHits;
    const fallbacksBefore = pipeline.stats.fallbacks;

    let translation, error = null;
    try {
      translation = await pipeline.translateNow(c.source, { engine: engineName });
    } catch (err) {
      error = err.message;
      translation = '';
    }

    if (pipeline.stats.fallbacks > fallbacksBefore) {
      const realCause = pipeline._lastError?.message || '(no error captured)';
      throw new Error(`Case ${c.id} (leg "literal") fell back away from '${engineName}': ${realCause}. Refusing to report on a fallback engine's output.`);
    }
    if (pipeline.stats.cacheHits > cacheHitsBefore) {
      throw new Error(`Case ${c.id} (leg "literal") was served from cache — the corpus should never repeat a line verbatim within one run.`);
    }

    const termResults = c.expectedTerms.map((term) => ({ term, present: containsWord(translation, term) }));
    caseResults.push({ id: c.id, source: c.source, translation, error, termResults });
    if (!quiet) printCase('literal', c, translation, termResults, error);
  }
  return summarize('literal', caseResults);
}

/**
 * "prompt" leg — calls the engine directly with the glossary formatted as a
 * `{glossary}` prompt block via options.glossary, bypassing pipeline.js's
 * literal pre/post-processing entirely (source text travels unmodified).
 */
async function runPromptLeg(engineName, groundTruth, quiet) {
  // 'prompt' here is nominal — this leg calls engine.translate() directly
  // (see below), bypassing pipeline.js's mode decision entirely, so the
  // pipeline instance's own glossaryMode is never actually consulted.
  const pipeline = buildPipeline(engineName, groundTruth._meta, groundTruth.glossary, 'prompt');
  const engine = pipeline.getEngine(engineName);
  const compileCache = new Map();

  const caseResults = [];
  for (const c of groundTruth.cases) {
    const glossaryBlock = buildGlossaryPrompt(groundTruth.glossary, c.source, { compileCache });

    let translation, error = null;
    try {
      const result = await engine.translate(c.source, {
        sourceLang: groundTruth._meta.sourceLang,
        targetLang: groundTruth._meta.targetLang,
        sourceLangName: 'Japanese',
        targetLangName: 'Spanish',
        context: [],
        glossary: glossaryBlock
      });
      translation = result.text;
    } catch (err) {
      error = err.message;
      translation = '';
    }

    const termResults = c.expectedTerms.map((term) => ({ term, present: containsWord(translation, term) }));
    caseResults.push({ id: c.id, source: c.source, glossaryBlock, translation, error, termResults });
    if (!quiet) printCase('prompt', c, translation, termResults, error, glossaryBlock);
  }
  return summarize('prompt', caseResults);
}

function summarize(legName, caseResults) {
  const allTerms = caseResults.flatMap((c) => c.termResults);
  const compliant = allTerms.filter((t) => t.present).length;
  const total = allTerms.length;
  const pct = total === 0 ? 100 : (compliant / total) * 100;
  return { legName, caseResults, compliant, total, pct };
}

// ─── Printing ────────────────────────────────────────────────────────────────

function printCase(legName, c, translation, termResults, error, glossaryBlock) {
  const tag = `${C.dim}[${legName}]${C.reset}`;
  console.log(`${tag} ${C.bold}${c.id}${C.reset} "${c.source}" → "${translation}"`);
  if (glossaryBlock !== undefined) {
    console.log(`      ${C.dim}glossary block: ${glossaryBlock ? glossaryBlock.replace(/\n/g, ' / ') : '(empty — no terms present)'}${C.reset}`);
  }
  for (const t of termResults) {
    const mark = t.present ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`      ${mark} expected "${t.term}"`);
  }
  if (error) console.log(`      ${C.red}error: ${error}${C.reset}`);
}

function printLegSummary(leg) {
  const color = leg.pct >= COMPLIANCE_THRESHOLD ? C.green : (leg.pct >= 50 ? C.yellow : C.red);
  console.log(`${C.bold}[${leg.legName}]${C.reset} ${color}${leg.compliant}/${leg.total} terms compliant (${leg.pct.toFixed(1)}%)${C.reset}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));

  const requiredForEngine = REQUIRED_ENV[args.engine] || [];
  const missing = requiredForEngine.filter(([envVar]) => !process.env[envVar]);
  if (missing.length > 0) {
    for (const [envVar, why] of missing) {
      console.error(`${C.red}${envVar} is not set. This bench needs ${why} to measure anything.${C.reset}`);
    }
    const envAssignments = requiredForEngine.map(([envVar]) => `${envVar}=xxx`).join(' ');
    console.error(`${C.dim}Run: ${envAssignments} node scripts/test-glossary-compliance.js --engine=${args.engine}${C.reset}`);
    return 1;
  }

  console.log(`${C.bold}Glossary compliance bench${C.reset} — engine=${args.engine}, target=${groundTruth._meta.targetLang}, threshold=${COMPLIANCE_THRESHOLD}%`);
  console.log(`${C.dim}Two legs on the same corpus: "literal" (today's applyPreTranslation) and "prompt" ({glossary} instruction). The prompt leg's % is the number the Fase 5 decision hinges on.${C.reset}\n`);

  const literalLeg = await runLiteralLeg(args.engine, groundTruth, args.quiet);
  const promptLeg = await runPromptLeg(args.engine, groundTruth, args.quiet);

  console.log(`\n${C.bold}${'─'.repeat(64)}${C.reset}`);
  printLegSummary(literalLeg);
  printLegSummary(promptLeg);

  const decision = promptLeg.pct >= COMPLIANCE_THRESHOLD
    ? `${C.green}PROMPT-ONLY${C.reset} — ${promptLeg.pct.toFixed(1)}% >= ${COMPLIANCE_THRESHOLD}% threshold, adopt glossaryMode:'prompt' as designed.`
    : `${C.yellow}HYBRID${C.reset} — ${promptLeg.pct.toFixed(1)}% < ${COMPLIANCE_THRESHOLD}% threshold, need glossaryMode:'hybrid' (prompt + post-hoc literal fill-in for missed terms).`;
  console.log(`\n${C.bold}Decision (fixed threshold, not adjusted after seeing the number):${C.reset} ${decision}`);

  const missedTerms = promptLeg.caseResults.flatMap((c) =>
    c.termResults.filter((t) => !t.present).map((t) => ({ case: c.id, term: t.term, translation: c.translation }))
  );
  if (missedTerms.length && !args.quiet) {
    console.log(`\n${C.bold}Terms the prompt leg missed (qualitative review):${C.reset}`);
    for (const m of missedTerms) {
      console.log(`  ${m.case}: expected "${m.term}", got "${m.translation}"`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: args.engine,
    targetLang: groundTruth._meta.targetLang,
    threshold: COMPLIANCE_THRESHOLD,
    literalLeg,
    promptLeg,
    decision: promptLeg.pct >= COMPLIANCE_THRESHOLD ? 'prompt' : 'hybrid'
  };
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\n${C.dim}Report written to ${args.json}${C.reset}`);

  return 0;
}

run()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`\n${C.red}${C.bold}Bench aborted:${C.reset} ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
