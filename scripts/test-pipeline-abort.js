/**
 * pipeline.js bench — LLM engine overhaul, Fase 9. Proves the AbortController
 * wiring end-to-end against the REAL TranslationPipeline (not a re-implemented
 * model of it) with a fake engine injected via `pipeline.engines[name]` —
 * `getEngine()` returns whatever's already there before it would construct a
 * real one, so this needs no API keys and makes no network calls.
 *
 * The bug this Fase fixes: translate()'s debounce already rejected the OLD
 * promise when superseded by new text (v3.13.55's SUPERSEDED error), but did
 * nothing to the underlying HTTP request — a slow LLM call kept running (and
 * billing tokens) for a translation nobody would ever see. These checks pin
 * that the in-flight request is now actually cancelled, AND that a cancelled
 * primary attempt doesn't fall through to the fallback chain or paint an
 * `error` event — both of which llm-base.js's own bench (test-llm-base.js)
 * can't see, since they're pipeline.js's job, not the engine's.
 *
 *   node scripts/test-pipeline-abort.js
 *   node scripts/test-pipeline-abort.js --quiet
 */
const path = require('path');
const TranslationPipeline = require(path.join('..', 'src', 'services', 'translation', 'pipeline.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

const CHECKS = [];
function check(id, fn, note) {
  CHECKS.push({ id, fn, note });
}

// Mimics the one thing about real axios cancellation that matters here:
// a translate() call that never settles on its own, but rejects with an
// ERR_CANCELED-coded error the moment options.signal aborts — exactly what
// llm-base.js's own real-server check (test-llm-base.js) proved axios does.
function fakeHangingEngine() {
  const calls = [];
  return {
    calls,
    name: 'openai',
    displayName: 'Fake OpenAI',
    capabilities: { prompt: true, context: 'prompt-template', glossaryPrompt: true, abort: true },
    supportedLanguages: [],
    translate(text, options) {
      calls.push({ text, options });
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal) {
          if (signal.aborted) {
            const e = new Error('canceled');
            e.code = 'ERR_CANCELED';
            reject(e);
            return;
          }
          signal.addEventListener('abort', () => {
            const e = new Error('canceled');
            e.code = 'ERR_CANCELED';
            reject(e);
          });
        }
        // Deliberately never resolves on its own — only the abort listener
        // above (or a real caller never aborting, which these checks don't
        // exercise) ever settles this promise.
      });
    }
  };
}

function fakeSpyEngine(name) {
  const calls = [];
  return {
    calls,
    name,
    displayName: `Fake ${name}`,
    capabilities: { prompt: false, glossaryPrompt: false },
    supportedLanguages: [],
    async translate(text, options) {
      calls.push({ text, options });
      return { text: `[${name}] ${text}`, detectedLang: null, engine: name };
    }
  };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function freshPipeline() {
  // v3.13.6x: debounceMs kept short so these checks run fast, not because
  // production ever sets it this low — the default (300ms) is untouched.
  const pipeline = new TranslationPipeline({ engine: 'openai', debounceMs: 15, sourceLang: 'ja', targetLang: 'es' });
  // v3.13.6x (Fase 9 testing follow-up, ronda 6): this pipeline constructs
  // REAL on-disk cache/TM stores (electron-store) — without clearing them,
  // the new context/bypassMemory checks below would be nondeterministic
  // across runs (a leftover entry from a previous run answering a
  // "unique" text isn't actually unique against disk state).
  pipeline.cache.clear();
  pipeline.translationMemory.clear();
  return pipeline;
}

check('a-superseding-translate-call-aborts-the-in-flight-primary-request', async () => {
  const pipeline = freshPipeline();
  const primary = fakeHangingEngine();
  const fallback = fakeSpyEngine('google-free');
  pipeline.engines['openai'] = primary;
  pipeline.engines['google-free'] = fallback;

  const uniqueText = `abort-test-${Date.now()}-${Math.random()}`;
  const p1 = pipeline.translate(uniqueText, {});
  p1.catch(() => {}); // asserted below; avoid an unhandled-rejection warning if the check throws first

  const reachedEngine = await waitFor(() => primary.calls.length > 0);
  const p2 = pipeline.translate(`${uniqueText}-two`, {});
  p2.catch(() => {}); // deliberately left hanging (same fake engine, no supersession fires for it) — only p1's outcome is under test

  let p1Error = null;
  try {
    await p1;
  } catch (e) {
    p1Error = e;
  }

  const pass = reachedEngine && p1Error && p1Error.code === 'SUPERSEDED';
  return { pass, actual: { reachedEngine, p1ErrorCode: p1Error?.code, p1ErrorMessage: p1Error?.message } };
}, "The OLD promise must reject with the SAME 'SUPERSEDED' code the pre-Fase-9 debounce path already used — ipc-handlers.js's existing silent-discard handling (v3.13.55) covers this without any change there.");

check('an-aborted-primary-does-not-fall-through-to-the-fallback-chain', async () => {
  const pipeline = freshPipeline();
  const primary = fakeHangingEngine();
  const fallback = fakeSpyEngine('google-free');
  pipeline.engines['openai'] = primary;
  pipeline.engines['google-free'] = fallback;

  const uniqueText = `abort-fallback-test-${Date.now()}-${Math.random()}`;
  const p1 = pipeline.translate(uniqueText, {});
  p1.catch(() => {});

  await waitFor(() => primary.calls.length > 0);
  pipeline.translate(`${uniqueText}-two`, {}).catch(() => {});
  try { await p1; } catch (e) { /* asserted in the check above */ }

  // Give _doTranslate's (now-unwound) call stack a moment to prove it does
  // NOT keep running past the throw — if it did, the fallback call would
  // show up here shortly after.
  await new Promise((r) => setTimeout(r, 30));

  const pass = fallback.calls.length === 0;
  return { pass, actual: { fallbackCallCount: fallback.calls.length } };
}, "Before Fase 9, ANY primary-engine failure (including a real network error) already fell through to the fallback chain — that's correct for a real failure, but an abort isn't one: the text is already stale, so translating it with google-free too would just waste a second call for the same discarded line.");

check('an-aborted-primary-does-not-emit-an-error-event', async () => {
  const pipeline = freshPipeline();
  const primary = fakeHangingEngine();
  pipeline.engines['openai'] = primary;
  pipeline.engines['google-free'] = fakeSpyEngine('google-free');

  let errorEmitted = false;
  pipeline.on('error', () => { errorEmitted = true; });

  const uniqueText = `abort-no-error-event-test-${Date.now()}-${Math.random()}`;
  const p1 = pipeline.translate(uniqueText, {});
  p1.catch(() => {});

  await waitFor(() => primary.calls.length > 0);
  pipeline.translate(`${uniqueText}-two`, {}).catch(() => {});
  try { await p1; } catch (e) { /* asserted above */ }
  await new Promise((r) => setTimeout(r, 30));

  const pass = errorEmitted === false;
  return { pass, actual: { errorEmitted } };
}, 'Same discipline as v3.13.55\'s SUPERSEDED fix for the debounce-only case: routine, expected supersession must never paint `[Error] ...` on the overlay — see ipc-handlers.js\'s _handleText catch.');

check('a-superseding-translateNow-call-aborts-the-previous-translateNow-call', async () => {
  // Real bug found testing the prompt-preset comparison workflow (change
  // preset → click ↻, repeated): translate()'s debounce entry point
  // aborted a stale in-flight request since Fase 9, but translateNow() —
  // what the ↻ button / Ctrl+Shift+R actually call via
  // _retranslateCurrent() — never did. Two translateNow() calls fired
  // close together both ran to completion uncancelled; whichever response
  // arrived LAST silently won, unrelated to which was requested last.
  const pipeline = freshPipeline();
  const primary = fakeHangingEngine();
  pipeline.engines['openai'] = primary;
  pipeline.engines['google-free'] = fakeSpyEngine('google-free');

  const uniqueText = `translatenow-abort-test-${Date.now()}-${Math.random()}`;
  const p1 = pipeline.translateNow(uniqueText, {});
  p1.catch(() => {});

  await waitFor(() => primary.calls.length > 0);
  pipeline.translateNow(`${uniqueText}-two`, {}).catch(() => {});

  let p1Error = null;
  try {
    await p1;
  } catch (e) {
    p1Error = e;
  }

  const pass = p1Error && p1Error.code === 'SUPERSEDED';
  return { pass, actual: { p1ErrorCode: p1Error?.code, p1ErrorMessage: p1Error?.message } };
}, 'A second translateNow() call must cancel the first one\'s in-flight request the same way translate() already does — otherwise both race to the overlay and whichever HTTP response happens to arrive last wins, regardless of which was actually requested last.');

// ─── Context-poisoning fix (ronda 6) ─────────────────────────────────────────
// Real bug: every _doTranslate() resolution path pushes (text, result) into
// contextMemory BEFORE returning — so retranslating line X used to hand the
// engine a prompt containing "X → X's own prior translation" under a header
// telling the model to stay consistent with it. See context-memory.js's
// getExcluding() and this method's own comment in pipeline.js's _tryEngine().

check('the-line-being-translated-is-never-present-in-the-context-passed-to-the-engine', async () => {
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;

  const lineA = `ctx-fix-A-${Date.now()}-${Math.random()}`;
  const lineB = `ctx-fix-B-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(lineA, {});
  await pipeline.translateNow(lineB, {});
  // Retranslate lineA — bypassMemory so it reaches the engine again despite
  // being cached from the first call, exactly like the ↻ button does.
  await pipeline.translateNow(lineA, { bypassMemory: true });

  const lastCall = primary.calls[primary.calls.length - 1];
  const sources = lastCall.options.context.map((c) => c.source);
  const pass = lastCall.text === lineA && !sources.includes(lineA);
  return { pass, actual: { text: lastCall.text, contextSources: sources } };
}, 'Reproduces the exact bug: on unfixed code, this call\'s context contained "lineA → <lineA\'s own prior answer>" plus a "stay consistent with the recent lines above" instruction — a model copying it byte-for-byte was the EXPECTED result of that prompt, not a mystery.');

check('context-passed-to-the-engine-still-contains-the-other-recent-lines', async () => {
  // Guards against an over-broad fix (e.g. clearing the whole window
  // instead of filtering one entry) — the OTHER recent lines are real
  // scene context and must survive the exclusion.
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;

  const lineA = `ctx-keep-A-${Date.now()}-${Math.random()}`;
  const lineB = `ctx-keep-B-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(lineA, {});
  await pipeline.translateNow(lineB, {});
  await pipeline.translateNow(lineA, { bypassMemory: true });

  const lastCall = primary.calls[primary.calls.length - 1];
  const sources = lastCall.options.context.map((c) => c.source);
  return { pass: sources.includes(lineB), actual: sources };
});

check('a-cache-hit-still-pushes-to-the-context-window', async () => {
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;
  const line = `cache-push-test-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(line, {}); // engine call, pushes to context
  const sizeAfterFirst = pipeline.contextMemory.size;
  await pipeline.translateNow(line, {}); // SAME text, cache hit this time (no bypassMemory)
  const sizeAfterSecond = pipeline.contextMemory.size;
  const entries = pipeline.contextMemory.get();

  const pass = sizeAfterFirst === 1 && sizeAfterSecond === 1 && entries.length === 1 && entries[0].source === line;
  return { pass, actual: { sizeAfterFirst, sizeAfterSecond, entries } };
}, "Guards against reintroducing v3.13.19's Bug A (cache hit doesn't feed the context window) — the investigation deliberately did NOT stop pushing on cache/TM hits; it fixed the READ side (getExcluding) and the duplicate-append side (push()'s replace-and-promote) instead.");

// ─── bypassMemory plumbing (ronda 6) ─────────────────────────────────────────
// Real bug: "Settings changed while text is on-screen — auto-retranslating
// ..." in a real log was immediately followed by a silent TM exact hit —
// the engine was never called at all, so a settings change (or the ↻
// button) could echo back a stale answer instead of a fresh one.

check('translateNow-with-bypassMemory-calls-the-engine-even-when-the-cache-holds-the-line', async () => {
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;
  const line = `bypass-read-test-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(line, {}); // caches it
  const callsBefore = primary.calls.length;
  await pipeline.translateNow(line, { bypassMemory: true });
  const callsAfter = primary.calls.length;

  return { pass: callsAfter === callsBefore + 1, actual: { callsBefore, callsAfter } };
}, 'The ↻ button and the settings-change auto-retranslate are explicit "redo this now" requests — they must actually reach the engine, not silently echo a cached/TM answer.');

check('translateNow-with-bypassMemory-still-writes-the-fresh-result-to-cache-and-TM', async () => {
  const pipeline = freshPipeline();
  let n = 0;
  const primary = {
    name: 'openai', displayName: 'Fake OpenAI',
    capabilities: { prompt: true, context: 'prompt-template', glossaryPrompt: true, abort: true },
    supportedLanguages: [],
    async translate(text) {
      n++;
      return { text: `answer-v${n}`, detectedLang: null, engine: 'openai' };
    }
  };
  pipeline.engines['openai'] = primary;
  const line = `bypass-write-test-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(line, {}); // caches 'answer-v1'
  await pipeline.translateNow(line, { bypassMemory: true }); // fresh call — must overwrite

  const variant = pipeline._cacheVariant(primary);
  const cached = pipeline.cache.get(line, 'ja', 'es', 'openai', variant);
  return { pass: cached === 'answer-v2', actual: cached };
}, 'bypassMemory only skips the READ — the fresh result must still overwrite the stale cache entry, or the very next occurrence of this line would serve the rejected old translation again. This is also what heals a legacy TM entry with no `variant` (see translation-memory.js\'s isVariantCompatible).');

check('translateNow-without-bypassMemory-is-still-served-from-cache', async () => {
  // xuat-server.js calls translateNow() as its NORMAL (non-debounced)
  // translation path with no bypassMemory flag — this must keep its
  // cache/TM hits, or every XUAT line would silently become a paid API
  // call. A future "simplify" pass making bypass the default would break
  // this without ever touching xuat-server.js itself.
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;
  const line = `xuat-guard-test-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(line, {});
  const callsBefore = primary.calls.length;
  await pipeline.translateNow(line, {}); // default bypassMemory:false
  const callsAfter = primary.calls.length;

  return { pass: callsAfter === callsBefore, actual: { callsBefore, callsAfter } };
});

check('a-cache-hit-emits-a-log-line', async () => {
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;
  const line = `log-visibility-test-${Date.now()}-${Math.random()}`;

  await pipeline.translateNow(line, {});

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    await pipeline.translateNow(line, {}); // cache hit this time
  } finally {
    console.log = originalLog;
  }

  const pass = logged.some((l) => l.includes('Cache hit'));
  return { pass, actual: logged };
}, 'The cache-hit branch used to be completely silent — zero console output — which is exactly why "the prompt changed but the translation didn\'t" took 3 real testing sessions to root-cause. Silence here is now a test failure, not just an inconvenience.');

check('a-translate-call-with-nothing-in-flight-does-not-throw-when-aborting', async () => {
  // The very first translate() call of a pipeline's life has no
  // _activeAbortController yet — the supersession guard must handle that
  // (null check) instead of throwing on `.abort()` of a nonexistent object.
  const pipeline = freshPipeline();
  const primary = fakeSpyEngine('openai');
  pipeline.engines['openai'] = primary;

  let threw = null;
  try {
    await pipeline.translate(`first-call-${Date.now()}`, {});
  } catch (e) {
    threw = e;
  }
  return { pass: threw === null, actual: threw?.message };
});

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];
  for (const c of CHECKS) {
    let outcome;
    try {
      outcome = await c.fn();
    } catch (e) {
      outcome = { pass: false, error: e.message };
    }
    results.push({ id: c.id, note: c.note, ...outcome });
  }

  console.log(`${C.bold}pipeline.js abort bench${C.reset} — ${results.length} case(s)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  process.exit(passed === results.length ? 0 : 1);
}

run();
