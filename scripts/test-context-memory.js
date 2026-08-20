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
 *   --mode=preset-divergence
 *                    A different experiment (see the "Preset-divergence
 *                    mode" section below) — measures whether retranslating
 *                    the same line under different prompt presets actually
 *                    produces different output, and whether the line being
 *                    translated leaks into its own context window. Always
 *                    targets local-llm; requires LOCAL_LLM_ENDPOINT and
 *                    LOCAL_LLM_MODEL, ignores --engine/--window/--json's
 *                    context-corpus meaning:
 *   XDG_CONFIG_HOME=$(mktemp -d) LOCAL_LLM_ENDPOINT=http://localhost:11434/v1 \
 *     LOCAL_LLM_MODEL=qwen2.5:3b-instruct \
 *     node scripts/test-context-memory.js --mode=preset-divergence
 *   --mode=unit
 *                    Plain-Node unit checks for context-memory.js's push()/
 *                    getExcluding() — no engine, no network, no ground
 *                    truth file needed: `node scripts/test-context-memory.js --mode=unit`
 */

const fs = require('fs');
const path = require('path');

const TranslationPipeline = require('../src/services/translation/pipeline');
const { PROMPT_PRESETS } = require('../src/services/translation/prompt-presets');

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
    // v3.13.58 (Fase 3) moved the openai engine's key source from the flat
    // `openaiKey` setting to the provider-keyed `llmProviderKeys` map —
    // this bench predates that and was still setting the now-unread key,
    // silently failing every openai call with "API key is required" ever
    // since. `openaiKey` kept here too since it's still harmless/ignored.
    openaiKey: process.env.OPENAI_API_KEY,
    llmProviderKeys: { openai: process.env.OPENAI_API_KEY },
    llmProvider: 'openai',
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

// ─── Offline unit checks for context-memory.js ───────────────────────────────
//
// v3.13.6x (Fase 9 testing follow-up, ronda 6): context-memory.js had zero
// dedicated unit coverage before this — every existing check in this file
// exercises it only indirectly, through a full pipeline + real engine call.
// These are plain Node, no engine, no network — pin push()'s new
// replace-and-promote behavior and getExcluding() (the two changes that fix
// the context-poisoning bug) in isolation from everything else that could
// possibly go wrong in a real translation call.

function runUnitChecks(quiet) {
  const ContextMemory = require('../src/services/translation/context-memory');
  const results = [];
  const unitCheck = (id, fn, note) => {
    let outcome;
    try { outcome = fn(); } catch (e) { outcome = { pass: false, error: e.message }; }
    results.push({ id, note, ...outcome });
  };

  unitCheck('push-of-an-existing-source-replaces-and-promotes-instead-of-duplicating', () => {
    const cm = new ContextMemory(5);
    cm.push('A', 'a1');
    cm.push('B', 'b1');
    cm.push('A', 'a2'); // same source again — must replace, not append a 2nd copy
    const entries = cm.get();
    const aEntries = entries.filter((e) => e.source === 'A');
    const pass = entries.length === 2 && aEntries.length === 1 && aEntries[0].translation === 'a2' && entries[entries.length - 1].source === 'A';
    return { pass, actual: entries };
  }, 'The direct fix for duplicate-poisoning: a repeated push must overwrite AND move to the most-recent slot ("promote"), not grow the window with copies.');

  unitCheck('five-retranslates-of-one-line-leave-a-window-of-size-one', () => {
    const cm = new ContextMemory(5);
    for (let i = 0; i < 5; i++) cm.push('X', `t${i}`);
    const entries = cm.get();
    return { pass: entries.length === 1 && entries[0].translation === 't4', actual: entries };
  }, "This is literally what happened in Lyca's real sessions: retranslating the same on-screen line via ↻ repeatedly used to leave 5 duplicate pairs, evicting every OTHER line of real scene context.");

  unitCheck('getExcluding-omits-only-exact-source-matches', () => {
    const cm = new ContextMemory(5);
    cm.push('こんにちは', 't1');
    cm.push('こんにちわ', 't2'); // one character different — must survive, not be fuzzy-excluded
    const excluded = cm.getExcluding('こんにちは');
    return { pass: excluded.length === 1 && excluded[0].source === 'こんにちわ', actual: excluded };
  }, "Deliberately NOT fuzzy — see getExcluding()'s own header comment for why a near-identical prior line is legitimate context, not a duplicate to drop.");

  unitCheck('getExcluding-on-an-empty-window-returns-an-empty-array', () => {
    const cm = new ContextMemory(5);
    const excluded = cm.getExcluding('anything');
    return { pass: Array.isArray(excluded) && excluded.length === 0, actual: excluded };
  });

  unitCheck('get-still-returns-the-raw-unfiltered-window', () => {
    const cm = new ContextMemory(5);
    cm.push('A', 'a');
    cm.push('B', 'b');
    const all = cm.get();
    return { pass: all.length === 2, actual: all };
  }, "get() is untouched by this fix on purpose — _tryEngine() is the only caller that needs the current-line exclusion, and get() is what this bench's own with-context/no-context legs snapshot to build incomingWindow.");

  unitCheck('getExcluding-does-not-mutate-the-underlying-window', () => {
    const cm = new ContextMemory(5);
    cm.push('A', 'a1');
    cm.getExcluding('A');
    return { pass: cm.get().length === 1 && cm.get()[0].translation === 'a1', actual: cm.get() };
  });

  unitCheck('maxSize-0-still-drops-everything-including-a-replace-and-promote-push', () => {
    const cm = new ContextMemory(0);
    cm.push('A', 'a1');
    cm.push('A', 'a2');
    return { pass: cm.get().length === 0, actual: cm.get() };
  });

  console.log(`${C.bold}context-memory.js unit checks${C.reset} — ${results.length} case(s)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }
  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  return passed === results.length ? 0 : 1;
}

// ─── Preset-divergence mode ──────────────────────────────────────────────────
//
// v3.13.6x (Fase 9 testing follow-up, ronda 6): a SEPARATE experiment from the
// "does context help" bench above — this one exists to settle a specific,
// disputed question: why did retranslating the same line under 4 different
// prompt presets (plus a hand-written custom template) produce BYTE-IDENTICAL
// output against real OpenAI, across three real testing sessions? Two
// competing explanations were on the table: (1) the four presets share ~95%
// of their text and just don't diverge enough at low temperature, or (2)
// something is forcing convergence regardless of what the prompt says. This
// mode measures both, on the same line, against a real LLM (Ollama — the only
// one reachable from this sandbox), so the answer isn't an assumption.
//
// The decisive assertion doesn't depend on what the model replies at all: it
// inspects the ACTUAL request sent to the LLM and checks whether the line
// being translated appears inside its own "recent lines for continuity"
// block — i.e. whether the model was handed the answer to the question it's
// being asked. See context-memory.js's getExcluding() (once it exists) for
// the fix this either proves necessary or clears.
//
// Capture point: `engine._httpClient.post` is wrapped to RECORD the request
// body's `messages[0].content` (the rendered system prompt) as a pure
// side-effect, then delegates to the real client with the SAME arguments and
// returns whatever it returns, completely unmodified — no `.then()`, no
// awaiting, no touching `response.data`. This only ever inspects the
// REQUEST side of the call, never the response, so it stays correct even if
// streaming (`stream: true`, a Node stream in `response.data`) is ever added
// to llm-base.js later — confirmed today there's no streaming anywhere in
// src/services/translation/engines/ (grep for "stream"/"responseType" turns
// up nothing), but this wrapper doesn't rely on that staying true.

const DIVERGENCE_LINE = 'それはとても奇妙な言い回しだったが、彼女はまったく気にしていないようだった。';
const DIVERGENCE_CUSTOM_TEMPLATE = 'Translate the following Japanese line into Spanish using very informal internet slang, as if texting a close friend. Output ONLY the translation, nothing else.\n\n{sentence}';

function buildDivergencePipeline(windowSize) {
  const settings = {
    engine: 'local-llm',
    sourceLang: 'ja',
    targetLang: 'es',
    customEndpoint: process.env.LOCAL_LLM_ENDPOINT,
    customModel: process.env.LOCAL_LLM_MODEL,
    promptTemplate: PROMPT_PRESETS[0].template,
    llmTemperature: 0,
    llmFewShot: true,
    maxContextHistory: windowSize,
    // Real data lives at ~/.config/tuhua-translator/ — this bench never
    // touches that (see the file header), but belt-and-braces: skip the
    // persistent TranslationMemory store entirely for this mode, since
    // legs deliberately reuse the same line and a warm TM would answer
    // from a previous leg/run instead of calling the engine.
    enableTranslationMemory: false
  };
  const pipeline = new TranslationPipeline(settings);
  if (!pipeline.getEngine('local-llm')) {
    throw new Error(`local-llm engine failed to construct — check LOCAL_LLM_ENDPOINT/LOCAL_LLM_MODEL`);
  }
  return pipeline;
}

// Wraps the CURRENT local-llm engine instance's http client to record every
// system-prompt sent. Must be re-called after every updateSettings(), since
// that clears pipeline.engines (pipeline.js's updateSettings()) and the next
// getEngine('local-llm') call constructs a brand new instance with its own
// fresh axios default — wrapping the old instance would silently stop
// capturing anything.
function wrapEngineCapture(pipeline) {
  const engine = pipeline.getEngine('local-llm');
  const realPost = engine._httpClient.post.bind(engine._httpClient);
  const captured = [];
  engine._httpClient.post = (url, body, config) => {
    captured.push(body.messages[0].content);
    return realPost(url, body, config);
  };
  return captured;
}

async function runDivergenceLeg(legName, windowSize, sequence, quiet) {
  const pipeline = buildDivergencePipeline(windowSize);
  pipeline.cache.clear();
  pipeline.clearContext();

  const outputs = [];
  const prompts = [];
  const lineLeakedIntoOwnContext = [];

  for (const step of sequence) {
    pipeline.updateSettings({ promptTemplate: step.template });
    const captured = wrapEngineCapture(pipeline);

    const translation = await pipeline.translateNow(DIVERGENCE_LINE, {
      source: 'ja', target: 'es', engine: 'local-llm'
    });

    const systemPrompt = captured[captured.length - 1] || '';
    prompts.push(systemPrompt);
    outputs.push(translation);

    // The decisive, model-independent check: does the request this call
    // actually sent contain the very line it's being asked to translate,
    // anywhere AFTER the "recent lines for continuity" header? A match
    // here means the model was handed its own prior answer as "context".
    const headerIdx = systemPrompt.indexOf('Recent lines for continuity');
    const afterHeader = headerIdx >= 0 ? systemPrompt.slice(headerIdx) : '';
    lineLeakedIntoOwnContext.push(afterHeader.includes(DIVERGENCE_LINE));

    if (!quiet) {
      console.log(`${C.dim}[${legName}]${C.reset} preset=${step.id}  leaked=${lineLeakedIntoOwnContext[lineLeakedIntoOwnContext.length - 1] ? C.red + 'YES' + C.reset : C.green + 'no' + C.reset}  → "${translation}"`);
    }
  }

  const distinctOutputs = new Set(outputs).size;
  return { legName, windowSize, outputs, prompts, lineLeakedIntoOwnContext, distinctOutputs };
}

async function runPresetDivergence(args) {
  if (!process.env.LOCAL_LLM_ENDPOINT || !process.env.LOCAL_LLM_MODEL) {
    console.error(`${C.red}--mode=preset-divergence requires LOCAL_LLM_ENDPOINT and LOCAL_LLM_MODEL (it always targets local-llm — Ollama is the only real LLM reachable from this sandbox).${C.reset}`);
    console.error(`${C.dim}Run: LOCAL_LLM_ENDPOINT=http://localhost:11434/v1 LOCAL_LLM_MODEL=qwen2.5:3b-instruct node scripts/test-context-memory.js --mode=preset-divergence${C.reset}`);
    return 1;
  }

  const presetSequence = PROMPT_PRESETS.map(p => ({ id: p.id, template: p.template }));
  const customSequence = [
    { id: 'balanced', template: PROMPT_PRESETS[0].template },
    { id: 'custom', template: DIVERGENCE_CUSTOM_TEMPLATE }
  ];
  const controlSequence = [0, 1, 2, 3].map(() => ({ id: 'balanced', template: PROMPT_PRESETS[0].template }));

  console.log(`${C.bold}Preset-divergence bench${C.reset} — engine=local-llm, model=${process.env.LOCAL_LLM_MODEL}, line="${DIVERGENCE_LINE}"\n`);

  const legs = {};
  legs.controlNoise = await runDivergenceLeg('control-ruido', 0, controlSequence, args.quiet);
  legs.ctxOff = await runDivergenceLeg('ctx-off', 0, presetSequence, args.quiet);
  legs.ctxOn = await runDivergenceLeg('ctx-on', 5, presetSequence, args.quiet);
  legs.ctxOnCustom = await runDivergenceLeg('ctx-on-custom', 5, customSequence, args.quiet);

  console.log(`\n${C.bold}${'─'.repeat(72)}${C.reset}`);
  console.log(`${C.bold}B1 control-ruido${C.reset} (4x mismo preset, sin contexto): ${legs.controlNoise.distinctOutputs} salida(s) distinta(s) de 4 ${legs.controlNoise.distinctOutputs === 1 ? C.green + '(sin ruido de muestreo, como se espera)' : C.yellow + '(hay ruido — temperature no está en 0 de verdad, o el modelo no es determinista)'}${C.reset}`);
  console.log(`${C.bold}B2 ctx-off${C.reset} (4 presets, sin contexto): ${legs.ctxOff.distinctOutputs} salida(s) distinta(s) de 4 ${legs.ctxOff.distinctOutputs >= 2 ? C.green + '(los presets SÍ se distinguen)' : C.red + '(los presets NO se distinguen — el problema sería de contenido, no de plumbing)'}${C.reset}`);
  console.log(`${C.bold}B3 ctx-on${C.reset}  (4 presets, contexto=5): ${legs.ctxOn.distinctOutputs} salida(s) distinta(s) de 4`);
  console.log(`${C.bold}B5 ctx-on-custom${C.reset} (balanced vs plantilla custom, contexto=5): ${legs.ctxOnCustom.distinctOutputs} salida(s) distinta(s) de 2`);

  const anyLeak = [...legs.ctxOn.lineLeakedIntoOwnContext, ...legs.ctxOnCustom.lineLeakedIntoOwnContext].some(Boolean);
  console.log(`\n${C.bold}P1 — la línea se filtra a su propio contexto (ctx-on):${C.reset} ${anyLeak ? C.red + 'SÍ, al menos una vez — éste es el bug' + C.reset : C.green + 'no' + C.reset}`);

  const isBugPattern = legs.ctxOff.distinctOutputs >= 2 && legs.ctxOn.distinctOutputs === 1 && anyLeak;
  const isFixedPattern = !anyLeak && legs.ctxOff.distinctOutputs >= 2 && legs.ctxOn.distinctOutputs === legs.ctxOff.distinctOutputs;
  const verdict = isBugPattern
    ? `${C.red}${C.bold}Reproducido: los presets SÍ divergen sin contexto, pero convergen a 1 sola salida con contexto encendido, y la línea se filtra a su propio bloque de contexto. Confirma la hipótesis de envenenamiento de contexto.${C.reset}`
    : (legs.ctxOff.distinctOutputs < 2
      ? `${C.yellow}${C.bold}Los presets no divergen incluso SIN contexto — la explicación de "los presets se parecen demasiado" está viva, revisar prompt-presets.js antes que el plumbing.${C.reset}`
      : (isFixedPattern
        ? `${C.green}${C.bold}Compuerta go/no-go: PASA. Sin fuga (P1=no) y ctx-on (${legs.ctxOn.distinctOutputs}) == ctx-off (${legs.ctxOff.distinctOutputs}) — el contexto ya no fuerza convergencia.${C.reset}`
        : `${C.green}${C.bold}No se reprodujo el patrón exacto del bug con esta corrida — ver el detalle de cada leg arriba antes de sacar conclusiones.${C.reset}`));
  console.log(`\n${verdict}`);

  const report = {
    generatedAt: new Date().toISOString(),
    model: process.env.LOCAL_LLM_MODEL,
    line: DIVERGENCE_LINE,
    legs
  };
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\n${C.dim}Report written to ${args.json}${C.reset}`);

  return 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'preset-divergence') {
    if (args.json === path.join(__dirname, 'context-report.json')) {
      args.json = path.join(__dirname, 'preset-divergence-report.json');
    }
    return runPresetDivergence(args);
  }

  if (args.mode === 'unit') {
    return runUnitChecks(args.quiet);
  }

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
