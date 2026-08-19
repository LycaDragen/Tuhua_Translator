/**
 * llm-base.js bench — the shared OpenAI-compat engine (OpenAICompatEngine)
 * that openai.js and local-llm.js are now thin subclasses of (LLM engine
 * overhaul, Fase 1). Asserts the exact request shape (headers, body, URL,
 * timeout) each subclass produces, WITHOUT making a real HTTP call — a fake
 * `httpClient` is injected through the constructor (same idea as the
 * injectable `store` in glossary.js/profile-store.js) and every call it
 * receives is recorded for inspection.
 *
 * This is what makes "did the Fase 1 refactor change any observable
 * behavior" a checkable question instead of a hope: openai.js and
 * local-llm.js used to have the request-building logic duplicated inline;
 * now both delegate to llm-base.js, and this bench pins what that shared
 * code must produce for each of them.
 *
 *   node scripts/test-llm-base.js
 *   node scripts/test-llm-base.js --quiet
 */
const path = require('path');
const OpenAIEngine = require(path.join('..', 'src', 'services', 'translation', 'engines', 'openai.js'));
const LocalLLMEngine = require(path.join('..', 'src', 'services', 'translation', 'engines', 'local-llm.js'));
const { LLMRefusalError, LLMPassthroughError } = require(path.join('..', 'src', 'services', 'translation', 'llm-output.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

// The literal default prompt text both engines fall back to when no custom
// systemPrompt is set — pinned here so a future edit to llm-base.js can't
// silently reintroduce the v3.13.55 "{TEXT}" bug (or any other prompt
// regression) without this bench noticing.
const DEFAULT_PROMPT = `You are a professional translator for visual novels and games. Your task is to translate text from Japanese to Spanish.

CRITICAL RULES — follow all of them exactly:
1. Output ONLY the translated text. No notes, no explanations, no added content.
2. NEVER translate or modify: proper names, character names, game/book/movie titles, brand names, or technical terms. Keep them exactly as written.
3. Preserve the speaker's tone, register, and emotional nuance.
4. Translate naturally — not word-for-word, but meaning-for-meaning.
5. Maintain consistency with any previously established terminology.`;

function fakeHttpClient(responder) {
  const calls = [];
  return {
    calls,
    post: async (url, body, config) => {
      calls.push({ url, body, config });
      const result = typeof responder === 'function' ? responder(calls.length) : responder;
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

const OK_RESPONSE = { data: { choices: [{ message: { content: '  Hola, ¿cómo estás?  ' } }] } };
const EMPTY_RESPONSE = { data: { choices: [] } };

// v3.13.57 (Fase 2): builds a fake response with a given content/finish_reason
// so this bench can also assert on how llm-base.js WIRES UP the sanitizer
// (llm-output.js) — the sanitizer's own heuristics are pinned separately and
// exhaustively in scripts/test-llm-output.js; these checks are only about
// the plumbing (does a refusal verdict actually become a thrown
// LLMRefusalError, does truncated:true actually reach the caller, etc).
function responseWith(content, finishReason = 'stop') {
  return { data: { choices: [{ message: { content }, finish_reason: finishReason }] } };
}

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

const CHECKS = [];
function check(id, fn, note) {
  CHECKS.push({ id, fn, note });
}

// ─── auth header: sent only when there's a key to send ─────────────────
check('openai-sends-bearer-header-when-key-present', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('sk-test-key', { httpClient: http });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const pass = http.calls[0].config.headers['Authorization'] === 'Bearer sk-test-key';
  return { pass, actual: http.calls[0].config.headers };
});

check('openai-throws-before-any-request-when-no-key', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('', { httpClient: http });
  let threw = null;
  try {
    await engine.translate('こんにちは', {});
  } catch (e) {
    threw = e.message;
  }
  const pass = threw === 'OpenAI (GPT) API key is required' && http.calls.length === 0;
  return { pass, actual: { threw, callCount: http.calls.length } };
}, 'Must fail fast without ever hitting the network — a missing key is not a retryable/network error.');

check('local-llm-omits-authorization-header-when-no-key', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new LocalLLMEngine({ httpClient: http });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const pass = !('Authorization' in http.calls[0].config.headers);
  return { pass, actual: http.calls[0].config.headers };
}, 'The v3.13.55/56 trap: sending "Bearer " with an empty token is not the same as sending no Authorization header at all — some local servers reject the former.');

check('local-llm-sends-authorization-once-a-key-is-set', async () => {
  // v3.13.56: local-llm.js never passes an apiKey through its constructor
  // today, but llm-base.js supports one generically (LM Studio's optional
  // auth toggle is exactly the case this exists for) — setApiKey() is the
  // only way to exercise it right now.
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new LocalLLMEngine({ httpClient: http });
  engine.setApiKey('local-secret');
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const pass = http.calls[0].config.headers['Authorization'] === 'Bearer local-secret';
  return { pass, actual: http.calls[0].config.headers };
});

// ─── prompt construction ──────────────────────────────────────────────
check('default-prompt-matches-pinned-text-and-has-no-unresolved-placeholder', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const systemMsg = http.calls[0].body.messages[0];
  const pass = systemMsg.role === 'system'
    && systemMsg.content === DEFAULT_PROMPT
    && !systemMsg.content.includes('{TEXT}');
  return { pass, actual: systemMsg };
}, 'Regression guard for the v3.13.55 fix: the prompt must never contain a literal, unresolved {TEXT} placeholder again.');

check('custom-system-prompt-is-used-verbatim-and-disables-fewshot', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, systemPrompt: 'Translate literally, word for word.' });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const { messages } = http.calls[0].body;
  // system + final user only — no few-shot pair, no context turns.
  const pass = messages.length === 2
    && messages[0].content === 'Translate literally, word for word.'
    && messages[1].role === 'user' && messages[1].content === 'こんにちは';
  return { pass, actual: messages };
});

check('fewshot-added-for-ja-es-but-not-for-ja-pt', async () => {
  const httpEs = fakeHttpClient(OK_RESPONSE);
  const esEngine = new OpenAIEngine('key', { httpClient: httpEs });
  await esEngine.translate('こんにちは', { sourceLangName: 'Japanese', targetLangName: 'Spanish' });

  const httpPt = fakeHttpClient(OK_RESPONSE);
  const ptEngine = new OpenAIEngine('key', { httpClient: httpPt });
  await ptEngine.translate('こんにちは', { sourceLangName: 'Japanese', targetLangName: 'Portuguese' });

  const esHasFewshot = httpEs.calls[0].body.messages.length === 4; // system, user-example, assistant-example, user
  const ptHasFewshot = httpPt.calls[0].body.messages.length === 4;
  const pass = esHasFewshot === true && ptHasFewshot === false;
  return { pass, actual: { esMessageCount: httpEs.calls[0].body.messages.length, ptMessageCount: httpPt.calls[0].body.messages.length } };
});

check('context-turns-appended-in-order-before-final-user-message', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, systemPrompt: 'x' }); // custom prompt disables few-shot, isolating this check to context only
  const context = [
    { source: 'おはよう', translation: 'Buenos días' },
    { source: 'ただいま', translation: 'Ya llegué' }
  ];
  await engine.translate('こんにちは', { sourceLangName: 'Japanese', targetLangName: 'Spanish', context });
  const { messages } = http.calls[0].body;
  const pass = messages.length === 6
    && messages[1].role === 'user' && messages[1].content === 'おはよう'
    && messages[2].role === 'assistant' && messages[2].content === 'Buenos días'
    && messages[3].role === 'user' && messages[3].content === 'ただいま'
    && messages[4].role === 'assistant' && messages[4].content === 'Ya llegué'
    && messages[5].role === 'user' && messages[5].content === 'こんにちは';
  return { pass, actual: messages };
});

// ─── provider-specific wiring ───────────────────────────────────────────
check('openai-default-timeout-is-30s-local-llm-is-60s', async () => {
  const httpA = fakeHttpClient(OK_RESPONSE);
  await new OpenAIEngine('key', { httpClient: httpA }).translate('x', {});
  const httpB = fakeHttpClient(OK_RESPONSE);
  await new LocalLLMEngine({ httpClient: httpB }).translate('x', {});
  const pass = httpA.calls[0].config.timeout === 30000 && httpB.calls[0].config.timeout === 60000;
  return { pass, actual: { openai: httpA.calls[0].config.timeout, localLlm: httpB.calls[0].config.timeout } };
}, 'Deliberately different on purpose (local models can be slower) — must not get collapsed to one shared default.');

check('local-llm-endpoint-option-maps-to-request-url', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new LocalLLMEngine({ httpClient: http, endpoint: 'http://localhost:11434/v1' });
  await engine.translate('x', {});
  const pass = http.calls[0].url === 'http://localhost:11434/v1/chat/completions';
  return { pass, actual: http.calls[0].url };
});

check('set-endpoint-updates-the-url-used-on-next-call', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new LocalLLMEngine({ httpClient: http });
  engine.setEndpoint('http://localhost:8080/v1');
  await engine.translate('x', {});
  const pass = http.calls[0].url === 'http://localhost:8080/v1/chat/completions';
  return { pass, actual: http.calls[0].url };
});

check('default-models-match-provider-conventions', () => {
  const openaiModel = new OpenAIEngine('key').model;
  const localModel = new LocalLLMEngine().model;
  const pass = openaiModel === 'gpt-3.5-turbo' && localModel === 'local-model';
  return { pass, actual: { openaiModel, localModel } };
});

// ─── response parsing ────────────────────────────────────────────────────
check('response-content-is-trimmed', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http });
  const result = await engine.translate('x', {});
  return { pass: result.text === 'Hola, ¿cómo estás?', actual: result };
});

check('empty-response-throws-a-named-error', async () => {
  const http = fakeHttpClient(EMPTY_RESPONSE);
  const engine = new LocalLLMEngine({ httpClient: http });
  let threw = null;
  try {
    await engine.translate('x', {});
  } catch (e) {
    threw = e.message;
  }
  return { pass: threw === 'Empty Local LLM (Ollama/LM Studio) response', actual: threw };
});

// ─── Fase 2 wiring: sanitizer verdicts become the right outcome ─────────
check('refusal-verdict-throws-a-typed-non-retryable-error', async () => {
  const http = fakeHttpClient(responseWith(
    "I'm sorry, but I can't assist with that request as it involves explicit content that violates my usage policies."
  ));
  const engine = new OpenAIEngine('key', { httpClient: http });
  let threw = null;
  try {
    await engine.translate('服を脱いで、こっちに来て。', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  } catch (e) {
    threw = e;
  }
  const pass = threw instanceof LLMRefusalError;
  return { pass, actual: threw ? threw.constructor.name : null };
}, 'pipeline.js relies on this being a plain thrown Error (any subclass) with no retryable signal — _isRetryable() must not match it, so a single failed attempt falls straight through to the fallback chain instead of retrying the same refusal.');

check('passthrough-verdict-throws-a-typed-error', async () => {
  const http = fakeHttpClient(responseWith('こんにちは、元気？')); // echoes the JA source verbatim
  const engine = new OpenAIEngine('key', { httpClient: http });
  let threw = null;
  try {
    await engine.translate('こんにちは、元気？', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  } catch (e) {
    threw = e;
  }
  const pass = threw instanceof LLMPassthroughError;
  return { pass, actual: threw ? threw.constructor.name : null };
});

check('finish-reason-length-sets-truncated-true-on-the-result', async () => {
  const http = fakeHttpClient(responseWith('Cuando llegamos a la ciudad, nos encontramos con', 'length'));
  const engine = new OpenAIEngine('key', { httpClient: http });
  const result = await engine.translate('x', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const pass = result.truncated === true && result.text === 'Cuando llegamos a la ciudad, nos encontramos con';
  return { pass, actual: result };
}, 'This is what pipeline.js reads to skip caching/TM/context for a response cut off by max_tokens — see pipeline.js _doTranslate.');

check('ok-verdict-result-has-no-truncated-flag', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http });
  const result = await engine.translate('x', {});
  const pass = result.truncated === false;
  return { pass, actual: result };
}, 'Explicitly false (not just falsy/absent) so pipeline.js\'s `!result.truncated` check is unambiguous either way.');

check('llmSanitize-false-disables-the-sanitizer-entirely', async () => {
  // With sanitize:false, an output that WOULD be flagged as a refusal must
  // instead pass straight through untouched — this is the rollback path
  // (settings.llmSanitize) for if the sanitizer ever misfires in the wild.
  const http = fakeHttpClient(responseWith(
    "I'm sorry, but I can't assist with that request today, sorry about that."
  ));
  const engine = new OpenAIEngine('key', { httpClient: http, sanitize: false });
  const result = await engine.translate('x', { sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const pass = result.text === "I'm sorry, but I can't assist with that request today, sorry about that." && result.truncated === undefined;
  return { pass, actual: result };
});

// ─── capabilities contract (read by later Fases, not yet by pipeline.js) ─
check('capabilities-shape-is-consistent-across-both-engines', () => {
  const openaiCaps = new OpenAIEngine('key').capabilities;
  const localCaps = new LocalLLMEngine().capabilities;
  const expected = { prompt: true, context: 'chat-turns', glossaryPrompt: true, abort: false };
  const matches = (caps) => JSON.stringify(caps) === JSON.stringify(expected);
  const pass = matches(openaiCaps) && matches(localCaps);
  return { pass, actual: { openaiCaps, localCaps } };
}, 'Pins the Fase-1 contract Fase 3-5 will read instead of hardcoding engine names — abort stays false until Fase 9 wires an AbortController.');

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

  console.log(`${C.bold}llm-base.js bench${C.reset} — ${results.length} case(s)\n`);
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
