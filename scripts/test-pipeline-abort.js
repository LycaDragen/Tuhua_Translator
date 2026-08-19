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
