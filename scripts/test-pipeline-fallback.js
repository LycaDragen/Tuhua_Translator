/**
 * pipeline.js fallback-reporting bench — v1.0.6.
 *
 * The gap (real 2026-08-30 log): with an invalid API key, every line logged
 *
 *   [Pipeline] openai failed (HTTP 401): Invalid Anthropic API Key
 *
 * while the UI only got "primary engine failed, using fallback" — the
 * sentence that actually tells the user what to do never left the log file.
 * That's why a wrong key reads as "Tuhua just translates badly": the
 * translation keeps arriving, silently downgraded to Google Translate.
 *
 * Runs the REAL TranslationPipeline with fake engines injected via
 * `pipeline.engines[name]` (same technique as test-pipeline-abort.js) — no
 * keys, no network.
 *
 *   node scripts/test-pipeline-fallback.js
 *   node scripts/test-pipeline-fallback.js --quiet
 */
const path = require('path');
const TranslationPipeline = require(path.join('..', 'src', 'services', 'translation', 'pipeline.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

/** An axios-shaped HTTP failure: generic .message, real reason in the body. */
function fakeHttpFailure(name, status, serverMessage) {
  return {
    name,
    displayName: `Fake ${name}`,
    capabilities: { prompt: false, glossaryPrompt: false },
    supportedLanguages: [],
    async translate() {
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { status, data: { error: { message: serverMessage } }, headers: {} };
      throw err;
    }
  };
}

function fakeWorkingEngine(name) {
  return {
    name,
    displayName: `Fake ${name}`,
    capabilities: { prompt: false, glossaryPrompt: false },
    supportedLanguages: [],
    async translate(text) {
      return { text: `[${name}] ${text}`, detectedLang: null, engine: name };
    }
  };
}

function freshPipeline(engine) {
  const pipeline = new TranslationPipeline({ engine, debounceMs: 15, sourceLang: 'en', targetLang: 'es' });
  // Real on-disk cache/TM stores — clear them or a previous run's entry
  // answers before any engine is ever called.
  pipeline.cache.clear();
  pipeline.translationMemory.clear();
  return pipeline;
}

const uniqueText = (tag) => `${tag}-${Date.now()}-${Math.random()}`;

check('the-reported-gap-the-fallback-event-carries-the-servers-own-message', async () => {
  const pipeline = freshPipeline('openai');
  pipeline.engines['openai'] = fakeHttpFailure('openai', 401, 'Invalid Anthropic API Key');
  pipeline.engines['google-free'] = fakeWorkingEngine('google-free');

  const events = [];
  pipeline.on('translation', (e) => events.push(e));
  await pipeline.translate(uniqueText('fallback-reason'), {});

  const e = events[0];
  const pass = !!e && e.isFallback === true && e.fallbackReason === 'HTTP 401: Invalid Anthropic API Key';
  return { pass, actual: { isFallback: e?.isFallback, fallbackReason: e?.fallbackReason, engine: e?.engine } };
}, 'Log 2026-08-30 00:33:44 verbatim. renderer.js appends this to the fallback toast — without it the toast cannot distinguish a bad key from a rate limit or a dead network.');

check('the-axios-generic-message-is-not-what-gets-reported', async () => {
  const pipeline = freshPipeline('openai');
  pipeline.engines['openai'] = fakeHttpFailure('openai', 401, 'Invalid Anthropic API Key');
  pipeline.engines['google-free'] = fakeWorkingEngine('google-free');

  const events = [];
  pipeline.on('translation', (e) => events.push(e));
  await pipeline.translate(uniqueText('not-axios-generic'), {});

  const reason = events[0]?.fallbackReason || '';
  return { pass: !reason.includes('Request failed with status code'), actual: reason };
}, "err.message for any HTTP failure is axios's boilerplate — that string is exactly what the old `_lastError?.message` path would have shown the user.");

check('the-primary-engines-error-wins-over-a-later-fallbacks-error', async () => {
  // custom-mt's chain is ['google-free', 'bing'] — two links, so the first
  // fallback can fail too and the SECOND one answer.
  const pipeline = freshPipeline('custom-mt');
  pipeline.engines['custom-mt'] = fakeHttpFailure('custom-mt', 401, 'Invalid API Key');
  pipeline.engines['google-free'] = fakeHttpFailure('google-free', 403, 'Google says no');
  pipeline.engines['bing'] = fakeWorkingEngine('bing');

  const events = [];
  pipeline.on('translation', (e) => events.push(e));
  await pipeline.translate(uniqueText('primary-wins'), {});

  const e = events[0];
  const pass = !!e && e.fallbackReason === 'HTTP 401: Invalid API Key' && e.engine === 'custom-mt→bing';
  return { pass, actual: { fallbackReason: e?.fallbackReason, engine: e?.engine } };
}, 'The reason is captured before the fallback loop runs: what the user must fix is THEIR engine, not the intermediate one Tuhua tried on its own.');

check('when-every-engine-fails-the-error-event-carries-the-actionable-message', async () => {
  const pipeline = freshPipeline('openai');
  pipeline.engines['openai'] = fakeHttpFailure('openai', 401, 'Invalid Anthropic API Key');
  pipeline.engines['google-free'] = fakeHttpFailure('google-free', 429, 'Too many requests');

  const errors = [];
  pipeline.on('error', (e) => errors.push(e));
  await pipeline.translate(uniqueText('all-failed'), {});

  const pass = errors.length === 1 && errors[0].error === 'HTTP 429: Too many requests';
  return { pass, actual: errors };
}, "Same 'last error wins' semantics the pre-v1.0.6 `_lastError` had — only the string is richer. renderer.js's updateLiveError() shows it as-is.");

check('a-successful-primary-emits-no-fallback-flag-and-no-reason', async () => {
  const pipeline = freshPipeline('openai');
  pipeline.engines['openai'] = fakeWorkingEngine('openai');
  pipeline.engines['google-free'] = fakeWorkingEngine('google-free');

  const events = [];
  pipeline.on('translation', (e) => events.push(e));
  await pipeline.translate(uniqueText('happy-path'), {});

  const e = events[0];
  const pass = !!e && !e.isFallback && e.fallbackReason === undefined;
  return { pass, actual: { isFallback: e?.isFallback, fallbackReason: e?.fallbackReason } };
}, 'No toast at all on the happy path — showToast() is only reached through isFallback.');

check('a-stale-summary-from-an-earlier-line-cannot-leak-into-a-later-one', async () => {
  const pipeline = freshPipeline('openai');
  pipeline.engines['openai'] = fakeHttpFailure('openai', 401, 'Invalid Anthropic API Key');
  pipeline.engines['google-free'] = fakeWorkingEngine('google-free');

  const events = [];
  pipeline.on('translation', (e) => events.push(e));
  await pipeline.translate(uniqueText('first-line-fails'), {});

  // The key is fixed mid-session (the user pastes a good one): the very
  // next line must not still be blamed on the old 401.
  pipeline.engines['openai'] = fakeWorkingEngine('openai');
  await pipeline.translate(uniqueText('second-line-works'), {});

  const pass = events.length === 2 && events[1].isFallback !== true && events[1].fallbackReason === undefined;
  return { pass, actual: events.map((e) => ({ engine: e.engine, isFallback: e.isFallback, fallbackReason: e.fallbackReason })) };
}, '_lastErrorSummary is instance state — _doTranslate clears it per call, exactly like _lastError.');

run('pipeline.js fallback-reporting bench', CHECKS);
