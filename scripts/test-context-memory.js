/**
 * Context Memory test bench for Tuhua Translator — measures whether feeding
 * previous lines as context to the translation engine actually improves
 * cross-line coherence, and guards against the known-broken plumbing
 * (see scripts/context-ground-truth.json's "_meta" and per-line "note"
 * fields for the full reasoning).
 *
 * Runs in plain node — no Electron required. Verified: TranslationPipeline
 * and its engines (electron-log, electron-store) all load and construct
 * fine outside Electron; electron-store just writes to
 * ~/.config/electron-store-nodejs/ instead of the app's userData dir, so
 * this never touches real app state.
 *
 *   DEEPL_API_KEY=xxx node scripts/test-context-memory.js --engine=deepl --window=2
 *   OPENAI_API_KEY=xxx node scripts/test-context-memory.js --engine=openai
 *   LOCAL_LLM_ENDPOINT=http://localhost:11434/v1 LOCAL_LLM_MODEL=llama3 \
 *     node scripts/test-context-memory.js --engine=local-llm
 *
 * Each engine needs its own env var(s) — the bench refuses to guess and
 * silently fall back to pipeline.js's defaults (meant for a human using the
 * Settings UI, not a script): DEEPL_API_KEY, OPENAI_API_KEY, or
 * LOCAL_LLM_ENDPOINT + LOCAL_LLM_MODEL (Ollama's OpenAI-compatible endpoint
 * is :11434/v1, not LM Studio's default :1234/v1 — get the exact model name
 * from `ollama list`, it must match what's actually loaded).
 *
 * local-llm specifically can only be run from wherever the server is
 * actually reachable — if it's on a different machine than this checkout
 * (e.g. Ollama on Windows, this bench run from a remote/cloud shell), there
 * is no way around that; run it from a shell that can actually reach the
 * endpoint.
 *
 * v3.13.19 (Fase 1): Context Memory moved from per-engine state into
 * pipeline.contextMemory (see context-memory.js). This bench reads the
 * window from there now, and doubles as the regression test for that
 * refactor — the "Known-bug guards" section at the end reports whether the
 * cache-hit-doesn't-feed-the-window bug and the reset-precondition are still
 * broken, so a future change that reintroduces either shows up as a
 * regression here instead of silently.
 *
 * What this bench does NOT do:
 *   - It does not exercise Google/Bing — confirmed by a real spike (not
 *     assumed) that they provide no cross-sentence context benefit even when
 *     prior sentences are concatenated into the same request; see
 *     plan-context-memory.md's Fase 3 section.
 *
 * Flags:
 *   --engine=deepl   Engine to test: deepl, openai, or local-llm (the three
 *                    that read options.context — see CONTEXT_CAPABLE_ENGINES
 *                    below).
 *   --window=N       Context window size for the "with-context" leg.
 *                    Default: ground truth's _meta.windowSize. The
 *                    "no-context" leg always runs with window=0.
 *   --json=PATH      Report output path (default scripts/context-report.json)
 *   --quiet          Suppress per-line detail, print summary only
 */

const fs = require('fs');
const path = require('path');

const TranslationPipeline = require('../src/services/translation/pipeline');

const ROOT = path.resolve(__dirname, '..');
const GROUND_TRUTH = path.join(__dirname, 'context-ground-truth.json');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { engine: 'deepl', json: path.join(__dirname, 'context-report.json') };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (value === undefined) args[key] = true;
    else args[key] = value;
  }
  return args;
}

// ─── Text matching ───────────────────────────────────────────────────────────

// Case/diacritic-insensitive substring match — the black-box assertions check
// for a word's presence, not an exact translation, so "Yuki" vs "yuki" or a
// stray accent shouldn't flip an assertion.
function normalize(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function containsWord(haystack, needle) {
  return normalize(haystack).includes(normalize(needle));
}

// ─── Pipeline construction ───────────────────────────────────────────────────

// Engines that actually read options.context in their translate() — see
// pipeline.js's _tryEngine(). Google/Bing ignore it entirely, so pointing
// this bench at them would just measure the no-op case.
const CONTEXT_CAPABLE_ENGINES = ['deepl', 'openai', 'local-llm'];

function buildPipeline(engineName, windowSize, meta) {
  const settings = {
    engine: engineName,
    sourceLang: meta.sourceLang,
    targetLang: meta.targetLang,
    deeplKey: process.env.DEEPL_API_KEY,
    deeplUsePro: process.env.DEEPL_USE_PRO === 'true',
    openaiKey: process.env.OPENAI_API_KEY,
    // No default here on purpose — pipeline.js's own default
    // (http://localhost:1234/v1, LM Studio's port) would silently point at
    // the wrong server for Ollama (11434) and produce a confusing
    // connection-refused instead of a clear "you forgot to set this" error.
    customEndpoint: process.env.LOCAL_LLM_ENDPOINT,
    customModel: process.env.LOCAL_LLM_MODEL,
    // v3.13.19: pipeline.js's ContextMemory now checks `!== undefined`
    // instead of `settings.maxContextHistory || N`, so an explicit 0
    // correctly produces a true zero-context baseline — no workaround needed
    // here anymore (see context-memory.js and pipeline.js's constructor).
    maxContextHistory: windowSize
  };
  const pipeline = new TranslationPipeline(settings);
  if (!pipeline.getEngine(engineName)) {
    throw new Error(`Unknown engine '${engineName}'`);
  }
  return { pipeline };
}

function hasContextSupport(engineName) {
  return CONTEXT_CAPABLE_ENGINES.includes(engineName);
}

// ─── Assertion evaluation ────────────────────────────────────────────────────

/**
 * Evaluates one line's assertions against what actually happened.
 * `incomingWindow` is the context window snapshot taken BEFORE this line was
 * translated (i.e. what the engine actually had available for this call) —
 * that is the honest thing to check, not the window after this line's own
 * push.
 */
function evaluateAssertions(line, incomingWindow, translation, linesById) {
  const results = [];
  for (const a of line.assertions || []) {
    let pass, detail;
    switch (a.type) {
      case 'contextWindowEmpty':
        pass = incomingWindow.length === 0;
        detail = `window=[${incomingWindow.join(' | ')}]`;
        break;
      case 'contextWindowContains': {
        const refLine = linesById.get(a.ref);
        const refSource = refLine ? refLine.source : a.ref;
        pass = incomingWindow.includes(refSource);
        detail = `expected "${a.ref}" in window=[${incomingWindow.join(' | ')}]`;
        break;
      }
      case 'mustContain':
        pass = containsWord(translation, a.text);
        detail = `expected "${a.text}" in "${translation}"`;
        break;
      case 'mustNotContain':
        pass = !containsWord(translation, a.text);
        detail = `expected NOT "${a.text}" in "${translation}"`;
        break;
      default:
        pass = false;
        detail = `unknown assertion type '${a.type}'`;
    }
    results.push({ type: a.type, ref: a.ref, text: a.text, pass, detail });
  }
  return results;
}

// ─── Leg runner ──────────────────────────────────────────────────────────────

async function runLeg(legName, engineName, windowSize, groundTruth, quiet) {
  const { pipeline } = buildPipeline(engineName, windowSize, groundTruth._meta);

  // Persistent electron-store caches survive across process runs (TTL 24h) —
  // start every leg from a clean slate, or a warm cache from a previous run
  // (or from leg A running before leg B) would make the "with-context" leg
  // hit cache/TM instead of calling the engine at all, measuring nothing.
  pipeline.cache.clear();
  pipeline.translationMemory.clear();
  pipeline.clearContext();

  const linesById = new Map();
  for (const scene of groundTruth.scenes) {
    for (const line of scene.lines) linesById.set(line.id, line);
  }

  const lineResults = [];

  for (const scene of groundTruth.scenes) {
    if (scene.resetContextBefore) {
      pipeline.clearContext();
    }

    for (const line of scene.lines) {
      const incomingWindow = pipeline.contextMemory.get().map(h => h.source);

      const cacheHitsBefore = pipeline.stats.cacheHits;
      const tmHitsBefore = pipeline.stats.tmHits;
      const fallbacksBefore = pipeline.stats.fallbacks;

      let translation, error = null;
      try {
        translation = await pipeline.translateNow(line.source, {
          source: groundTruth._meta.sourceLang,
          target: groundTruth._meta.targetLang,
          engine: engineName
        });
      } catch (err) {
        error = err.message;
        translation = '';
      }

      // If the requested engine failed and the pipeline silently fell back
      // to another one (e.g. local-llm unreachable → google-free), every
      // assertion below would still evaluate — just against the WRONG
      // engine's output, with no indication in the report. This bit us
      // directly while validating this bench: pointing --engine=local-llm
      // at an endpoint this shell can't reach still produced full, readable
      // output, because google-free answered instead. Silent success here is
      // worse than a loud crash.
      if (pipeline.stats.fallbacks > fallbacksBefore) {
        const realCause = pipeline._lastError?.message || '(no error captured)';
        throw new Error(
          `Line ${line.id} (leg "${legName}") fell back away from '${engineName}' — the primary engine call failed and the pipeline silently used a fallback engine instead. This bench refuses to report on whatever answered a fallback question, ` +
          `since it's not the engine you asked for. Underlying error from '${engineName}': ${realCause}. Most likely cause if that's a connection error: '${engineName}' isn't reachable from this shell (wrong LOCAL_LLM_ENDPOINT, server not running, or it's on a different machine than this one).`
        );
      }

      const wasHit = pipeline.stats.cacheHits > cacheHitsBefore || pipeline.stats.tmHits > tmHitsBefore;
      const expectedHit = !!line.expectCacheHit;

      if (wasHit !== expectedHit) {
        const msg = expectedHit
          ? `Line ${line.id} (leg "${legName}") was expected to be a cache/TM hit but the engine was called live. The corpus assumption (verbatim repeat should hit) is broken — fix the corpus before trusting this leg's results.`
          : `Line ${line.id} (leg "${legName}") was UNEXPECTEDLY served from cache/TM. Either the corpus has an accidental duplicate line, or the cache carried over from a previous leg/run. Aborting — this leg's results would not be trustworthy.`;
        throw new Error(msg);
      }

      const assertions = evaluateAssertions(line, incomingWindow, translation, linesById);

      lineResults.push({
        scene: scene.id,
        id: line.id,
        source: line.source,
        translation,
        error,
        wasCacheOrTMHit: wasHit,
        incomingWindow,
        assertions
      });

      if (!quiet) printLine(legName, lineResults[lineResults.length - 1]);
    }
  }

  const passed = lineResults.reduce((s, r) => s + r.assertions.filter(a => a.pass).length, 0);
  const total = lineResults.reduce((s, r) => s + r.assertions.length, 0);

  return { legName, windowSize, lineResults, passed, total, stats: { ...pipeline.stats } };
}

// ─── Printing ────────────────────────────────────────────────────────────────

function printLine(legName, r) {
  const tag = `${C.dim}[${legName}]${C.reset}`;
  const hitTag = r.wasCacheOrTMHit ? `${C.cyan}(cache/TM hit)${C.reset} ` : '';
  console.log(`${tag} ${C.bold}${r.scene}/${r.id}${C.reset} ${hitTag}"${r.source}" → "${r.translation}"`);
  for (const a of r.assertions) {
    const mark = a.pass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`      ${mark} ${a.type}${a.ref ? `(${a.ref})` : ''}${a.text ? `("${a.text}")` : ''}  ${C.dim}${a.detail}${C.reset}`);
  }
  if (r.error) console.log(`      ${C.red}error: ${r.error}${C.reset}`);
}

function printLegSummary(leg) {
  const failed = leg.total - leg.passed;
  const color = failed === 0 ? C.green : (leg.passed === 0 ? C.red : C.yellow);
  console.log(`${C.bold}[${leg.legName}]${C.reset} window=${leg.windowSize}  ${color}${leg.passed}/${leg.total} assertions passed${C.reset}  ` +
    `${C.dim}(engine calls=${leg.stats.totalTranslations}, cache hits=${leg.stats.cacheHits}, TM hits=${leg.stats.tmHits})${C.reset}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));
  const windowSize = args.window !== undefined ? parseInt(args.window, 10) : groundTruth._meta.windowSize;

  // Required config per engine — checked explicitly instead of falling
  // through to pipeline.js's own defaults, which exist for the app's
  // Settings UI (a human picks values there) and would otherwise silently
  // point this bench at the wrong thing (e.g. LM Studio's port for what's
  // actually an Ollama setup) instead of failing loudly.
  const REQUIRED_ENV = {
    deepl: [['DEEPL_API_KEY', 'a real DeepL call']],
    openai: [['OPENAI_API_KEY', 'a real OpenAI call']],
    'local-llm': [
      ['LOCAL_LLM_ENDPOINT', "your local server's OpenAI-compatible base URL — Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1"],
      ['LOCAL_LLM_MODEL', 'the exact model name your server has loaded (e.g. an `ollama list` name)']
    ]
  };
  const requiredForEngine = REQUIRED_ENV[args.engine] || [];
  const missing = requiredForEngine.filter(([envVar]) => !process.env[envVar]);
  if (missing.length > 0) {
    for (const [envVar, why] of missing) {
      console.error(`${C.red}${envVar} is not set. This bench needs ${why} to measure anything.${C.reset}`);
    }
    const envAssignments = requiredForEngine.map(([envVar]) => `${envVar}=xxx`).join(' ');
    console.error(`${C.dim}Run: ${envAssignments} node scripts/test-context-memory.js --engine=${args.engine}${C.reset}`);
    return 1;
  }

  buildPipeline(args.engine, windowSize, groundTruth._meta); // throws on unknown engine name
  if (!hasContextSupport(args.engine)) {
    console.error(`${C.red}Engine '${args.engine}' doesn't read options.context — it can't be measured by this bench (Google/Bing have no context API at all; see Fase 3 in the plan).${C.reset}`);
    return 1;
  }

  console.log(`${C.bold}Context Memory bench${C.reset} — engine=${args.engine}, target=${groundTruth._meta.targetLang}, window(context leg)=${windowSize}`);
  console.log(`${C.dim}Two legs: "no-context" (window=0, always) and "with-context" (window=${windowSize}). Comparing the two is the number that matters.${C.reset}\n`);

  const legs = [];
  legs.push(await runLeg('no-context', args.engine, 0, groundTruth, args.quiet));
  legs.push(await runLeg('with-context', args.engine, windowSize, groundTruth, args.quiet));

  console.log(`\n${C.bold}${'─'.repeat(64)}${C.reset}`);
  for (const leg of legs) printLegSummary(leg);

  const [noCtx, withCtx] = legs;
  const delta = withCtx.passed - noCtx.passed;
  const deltaColor = delta > 0 ? C.green : (delta < 0 ? C.red : C.dim);
  console.log(`${C.bold}Delta${C.reset}: ${deltaColor}${delta >= 0 ? '+' : ''}${delta} assertions${C.reset} from adding context (${withCtx.passed}/${withCtx.total} vs ${noCtx.passed}/${noCtx.total})`);

  // Bug A / Bug C status, read directly off the with-context leg's own
  // assertion results rather than re-deriving it — these are the specific
  // assertions the corpus was built to pin down (see context-ground-truth.json).
  const byId = id => withCtx.lineResults.find(r => r.id === id);
  const bugAStatus = [byId('A6'), byId('B7')].map(r => {
    const a = r.assertions.find(x => x.type === 'contextWindowContains');
    return { id: r.id, pass: a ? a.pass : null };
  });
  const bugCStatus = byId('B1').assertions.find(a => a.type === 'contextWindowEmpty');

  console.log(`\n${C.bold}Known-bug guards (with-context leg):${C.reset}`);
  for (const b of bugAStatus) {
    const label = b.pass ? `${C.green}FIXED${C.reset}` : `${C.yellow}STILL BROKEN${C.reset}`;
    console.log(`  Bug A (cache hit doesn't feed the context window) @ ${b.id}: ${label}`);
  }
  if (bugCStatus) {
    const label = bugCStatus.pass ? `${C.green}clearContext() works when invoked${C.reset}` : `${C.red}clearContext() itself is broken${C.reset}`;
    console.log(`  Bug C precondition @ B1: ${label} ${C.dim}(this only tests the method works — it's never called in production, see the plan for Fase 2)${C.reset}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: args.engine,
    targetLang: groundTruth._meta.targetLang,
    legs
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
