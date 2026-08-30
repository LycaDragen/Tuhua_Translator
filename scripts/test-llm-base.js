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
const { renderPromptTemplate } = require(path.join('..', 'src', 'services', 'translation', 'prompt-template.js'));
const { DEFAULT_TEMPLATE } = require(path.join('..', 'src', 'services', 'translation', 'prompt-presets.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

// v3.13.59 (Fase 4): the default prompt is now a rendered TEMPLATE
// (prompt-presets.js's DEFAULT_TEMPLATE), not a static string — computed
// here via the real renderPromptTemplate() for the exact ja->es/no-context
// case these checks exercise, rather than a second hardcoded copy that
// could drift from the template. prompt-template.js's own exhaustive
// behavior (the collapse rule, unknown-variable warnings, context
// formatting, ...) is covered by scripts/test-prompt-template.js — these
// checks are only about whether llm-base.js WIRES to it correctly.
const DEFAULT_PROMPT_JA_ES = renderPromptTemplate(DEFAULT_TEMPLATE, {
  sentence: 'こんにちは',
  srclang: 'Japanese',
  tgtlang: 'Spanish',
  srclangcode: 'ja',
  tgtlangcode: 'es',
  context: []
}).text;

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


// v1.0.5: una respuesta con `usage`, que es lo que separa un modelo de
// razonamiento agotando su presupuesto (finish_reason 'length' +
// completion_tokens > 0 + content vacío) de un vacío cualquiera.
function responseSpending(tokens, content = '', finishReason = 'length') {
  return { data: { choices: [{ message: { content }, finish_reason: finishReason }], usage: { completion_tokens: tokens } } };
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
  // v3.13.58: displayName is now provider-derived ('OpenAI', from
  // llm-providers.js) rather than the old hardcoded 'OpenAI (GPT)'.
  const pass = threw === 'OpenAI API key is required' && http.calls.length === 0;
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
    && systemMsg.content === DEFAULT_PROMPT_JA_ES
    && !/\{[A-Za-z]+\}/.test(systemMsg.content);
  return { pass, actual: systemMsg };
}, 'Regression guard for the v3.13.55 fix: the rendered prompt must never contain a literal, unresolved {variable} placeholder — {TEXT} was the original bug, but any leftover {name} is the same class of mistake.');

check('custom-prompt-template-with-no-variables-renders-verbatim', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, promptTemplate: 'Translate literally, word for word.' });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const { messages } = http.calls[0].body;
  // v3.13.59 (Fase 4): a custom template no longer disables few-shot (the
  // OLD `if (!this.systemPrompt)` coupling is exactly what this Fase
  // removes) — fewShotEnabled defaults true, so ja->es's 2 examples are
  // still expected here: system, 2x(user+assistant) fewshot, final user.
  const pass = messages.length === 6
    && messages[0].content === 'Translate literally, word for word.'
    && messages[5].role === 'user' && messages[5].content === 'こんにちは';
  return { pass, actual: messages };
}, "A template with no {variables} at all is a valid, if minimal, template — renderPromptTemplate() must pass it through unchanged rather than erroring or mangling it.");

check('sentence-embedded-template-omits-fewshot-even-when-enabled', async () => {
  // Real bug found testing against a live Ollama server: fewShotEnabled
  // defaults true independently of the template (see the check above), but
  // a template that embeds {sentence} rides the whole line inside the
  // `system` message and appends NO trailing `user` turn (see the
  // containsSentence branch further down in llm-base.js). Pushing few-shot
  // pairs in that case left the conversation ending on an `assistant`
  // turn with nothing asking the model to respond — Ollama returned
  // finish_reason 'stop' with empty content rather than erroring, so this
  // was silent until traced deliberately. Few-shot must be skipped
  // whenever the template already contains {sentence}.
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, promptTemplate: 'Translate this: {sentence}' });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const { messages } = http.calls[0].body;
  const pass = messages.length === 1
    && messages[0].role === 'system'
    && messages[0].content === 'Translate this: こんにちは';
  return { pass, actual: messages };
}, 'A completion-style template ({sentence} embedded in system) must never end up with few-shot turns and no trailing user turn — that combination reliably produced an empty response against a real local server.');

check('fewShotEnabled-false-disables-fewshot-independently-of-the-template', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, fewShotEnabled: false });
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });
  const { messages } = http.calls[0].body;
  // system + final user only — no few-shot pair, even with the DEFAULT
  // template (which would otherwise get ja->es's 2 examples).
  const pass = messages.length === 2 && messages[1].content === 'こんにちは';
  return { pass, actual: messages };
});

check('fewshot-keyed-by-language-CODE-ja-es-has-examples-ja-pt-does-not', async () => {
  // v3.13.59: keyed by CODE now (fewshot-examples.js), not by comparing
  // the English NAME of the language the way the old hardcoded `if` did —
  // sourceLangName/targetLangName are passed here too but must NOT be
  // what decides this.
  const httpEs = fakeHttpClient(OK_RESPONSE);
  const esEngine = new OpenAIEngine('key', { httpClient: httpEs });
  await esEngine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish' });

  const httpPt = fakeHttpClient(OK_RESPONSE);
  const ptEngine = new OpenAIEngine('key', { httpClient: httpPt });
  await ptEngine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'pt', sourceLangName: 'Japanese', targetLangName: 'Portuguese' });

  const esHasFewshot = httpEs.calls[0].body.messages.length === 6; // system, 2x(user+assistant), final user
  const ptHasFewshot = httpPt.calls[0].body.messages.length === 6;
  const pass = esHasFewshot === true && ptHasFewshot === false;
  return { pass, actual: { esMessageCount: httpEs.calls[0].body.messages.length, ptMessageCount: httpPt.calls[0].body.messages.length } };
});

check('context-renders-into-the-system-prompt-text-not-as-chat-turns', async () => {
  // v3.13.59 (Fase 4): real conversation context moved from fake
  // user/assistant turns into {contextBoth} in the system prompt text —
  // see llm-base.js's capabilities.context ('prompt-template' now, was
  // 'chat-turns'). Few-shot is disabled here to isolate this check to
  // context only, same isolation technique the old version of this check used.
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, fewShotEnabled: false });
  const context = [
    { source: 'おはよう', translation: 'Buenos días' },
    { source: 'ただいま', translation: 'Ya llegué' }
  ];
  await engine.translate('こんにちは', { sourceLang: 'ja', targetLang: 'es', sourceLangName: 'Japanese', targetLangName: 'Spanish', context });
  const { messages } = http.calls[0].body;
  const systemContainsContext = messages[0].content.includes('おはよう → Buenos días')
    && messages[0].content.includes('ただいま → Ya llegué');
  // system + final user only — context is text now, not extra turns.
  const pass = messages.length === 2 && systemContainsContext;
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
  // v3.13.58: OpenAI's default model now comes from llm-providers.js
  // (getProvider('openai').defaultModel) instead of a hardcoded literal —
  // gpt-4o-mini rather than the outdated gpt-3.5-turbo.
  const openaiModel = new OpenAIEngine('key').model;
  const localModel = new LocalLLMEngine().model;
  const pass = openaiModel === 'gpt-4o-mini' && localModel === 'local-model';
  return { pass, actual: { openaiModel, localModel } };
});

// ─── Fase 3: provider selection, params, reasoning-model overrides ──────
check('providerId-selects-baseurl-displayname-and-default-model', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, providerId: 'groq' });
  await engine.translate('x', {});
  const pass = http.calls[0].url === 'https://api.groq.com/openai/v1/chat/completions'
    && engine.displayName === 'Groq'
    && engine.model === 'llama-3.3-70b-versatile';
  return { pass, actual: { url: http.calls[0].url, displayName: engine.displayName, model: engine.model } };
}, "Confirms the 'openai' engine class is genuinely provider-generic now, not just accepting the option and ignoring it.");

check('explicit-model-option-overrides-the-provider-default', async () => {
  const engine = new OpenAIEngine('key', { providerId: 'groq', model: 'llama-3.1-8b-instant' });
  return { pass: engine.model === 'llama-3.1-8b-instant', actual: engine.model };
});

check('custom-providerId-with-no-url-does-not-silently-default-to-openai', () => {
  // If this fell back to 'https://api.openai.com/v1' when the 'custom'
  // provider's own baseUrl (empty in the table on purpose) and
  // options.baseUrl are BOTH empty, a user's key/text meant for their own
  // gateway could get sent to OpenAI's real API instead — a silent
  // wrong-destination bug, not just a broken feature.
  const engine = new OpenAIEngine('key', { providerId: 'custom' });
  return { pass: engine.baseUrl === '', actual: engine.baseUrl };
});

check('custom-providerId-uses-a-user-supplied-baseurl', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, providerId: 'custom', baseUrl: 'https://my-gateway.example.com/v1', model: 'whatever-model' });
  await engine.translate('x', {});
  const pass = http.calls[0].url === 'https://my-gateway.example.com/v1/chat/completions';
  return { pass, actual: http.calls[0].url };
}, "The 'custom' provider table entry has an empty baseUrl on purpose — it exists to be overridden by options.baseUrl.");

check('temperature-and-max-tokens-are-configurable-and-sent', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, temperature: 0.7, maxTokens: 800 });
  await engine.translate('x', {});
  const { body } = http.calls[0];
  const pass = body.temperature === 0.7 && body.max_tokens === 800 && !('top_p' in body);
  return { pass, actual: body };
}, 'top_p absent by default — unset, not 0, since 0 is a meaningful sampling value.');

check('top-p-is-sent-only-when-explicitly-set', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, topP: 0.9 });
  await engine.translate('x', {});
  const pass = http.calls[0].body.top_p === 0.9;
  return { pass, actual: http.calls[0].body };
});

check('reasoning-model-gets-max-completion-tokens-and-drops-sampling-params', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, providerId: 'openai', model: 'o4-mini', temperature: 0.7, topP: 0.9 });
  await engine.translate('x', {});
  const { body } = http.calls[0];
  const pass = body.max_completion_tokens !== undefined
    && !('max_tokens' in body)
    && !('temperature' in body)
    && !('top_p' in body);
  return { pass, actual: body };
}, "End-to-end proof that llm-base.js's request builder actually consults getRequestParamOverrides() — llm-providers.js's own bench only proves the table lookup is correct in isolation.");

check('deepseek-reasoner-keeps-max-tokens-but-drops-sampling-params', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http, providerId: 'deepseek', model: 'deepseek-reasoner', temperature: 0.7 });
  await engine.translate('x', {});
  const { body } = http.calls[0];
  const pass = body.max_tokens !== undefined && !('max_completion_tokens' in body) && !('temperature' in body);
  return { pass, actual: body };
}, 'The exact per-provider distinction getRequestParamOverrides exists for — see the same-named check in test-llm-providers.js for why this differs from OpenAI o-series.');

check('non-reasoning-model-keeps-default-max-tokens-field-and-temperature', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http });
  await engine.translate('x', {});
  const { body } = http.calls[0];
  const pass = body.max_tokens === 1500 && body.temperature === 0.3;
  return { pass, actual: body };
}, 'Defaults per the plan: temperature 0.3 (unchanged), maxTokens raised to 1500 (was hardcoded 1000, which cut off longer lines and got them cached truncated).');

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

// ─── v1.0.5: modelo de razonamiento que devuelve vacío ────────────────────
// Ollama no manda el bloque de pensamiento en `content`: la respuesta llega
// con el texto vacío y todo el presupuesto gastado. Antes eso era
// "Empty ... response", que no dice ni qué pasó ni qué hacer.

check('a-reasoning-model-that-returns-nothing-says-so-with-its-token-count', async () => {
  const http = fakeHttpClient(responseSpending(300));
  const engine = new LocalLLMEngine({ httpClient: http });
  let threw = null;
  try {
    await engine.translate('x', {});
  } catch (e) {
    threw = e.message;
  }
  const pass = threw !== null
    && threw.includes('300 tokens')
    && /reasoning/i.test(threw)
    && threw !== 'Empty Local LLM (Ollama/LM Studio) response';
  return { pass, actual: threw };
}, 'Revertir la rama nueva de llm-base.js tiene que hacer fallar ESTE check: el mensaje volvería a ser el genérico.');

check('an-empty-response-with-no-usage-keeps-the-old-generic-error', async () => {
  // Sin `usage` no hay prueba de que el modelo gastara nada: puede ser un
  // servidor caído, una plantilla rota o cualquier otra cosa. Afirmar
  // "es un modelo de razonamiento" ahí sería peor que el mensaje genérico.
  const http = fakeHttpClient(EMPTY_RESPONSE);
  const engine = new LocalLLMEngine({ httpClient: http });
  let threw = null;
  try {
    await engine.translate('x', {});
  } catch (e) {
    threw = e.message;
  }
  return { pass: threw === 'Empty Local LLM (Ollama/LM Studio) response', actual: threw };
}, 'La rama nueva no puede tragarse el caso genérico — es la mitad del arreglo que se rompe sin querer.');

check('an-empty-response-that-stopped-normally-is-not-blamed-on-reasoning', async () => {
  const http = fakeHttpClient(responseSpending(120, '', 'stop'));
  const engine = new LocalLLMEngine({ httpClient: http });
  let threw = null;
  try {
    await engine.translate('x', {});
  } catch (e) {
    threw = e.message;
  }
  return { pass: threw === 'Empty Local LLM (Ollama/LM Studio) response', actual: threw };
}, "finish_reason 'stop' con texto vacío es otro problema; sólo 'length' indica presupuesto agotado.");

check('a-truncated-response-that-does-have-text-still-reaches-the-sanitizer', async () => {
  // Guard de no-regresión de la Fase 2: la rama nueva sólo mira respuestas
  // VACÍAS, así que un truncado con texto tiene que seguir devolviendo
  // truncated:true en vez de lanzar.
  const http = fakeHttpClient(responseSpending(120, 'Hola, ¿cómo est', 'length'));
  const engine = new LocalLLMEngine({ httpClient: http });
  const result = await engine.translate('x', {});
  return { pass: result.truncated === true, actual: result };
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
  // v3.13.59 (Fase 4): context changed from 'chat-turns' to
  // 'prompt-template' — see the field's own doc comment in llm-base.js.
  // v3.13.6x (Fase 9): abort is now true — see the two checks below for
  // proof it's actually wired, not just a flipped flag.
  const expected = { prompt: true, context: 'prompt-template', glossaryPrompt: true, abort: true };
  const matches = (caps) => JSON.stringify(caps) === JSON.stringify(expected);
  const pass = matches(openaiCaps) && matches(localCaps);
  return { pass, actual: { openaiCaps, localCaps } };
}, 'Pins the contract Fase 5 read for glossaryPrompt, and Fase 9 now reads too for abort.');

// ─── Fase 9: abort wiring ─────────────────────────────────────────────
check('options-signal-is-forwarded-to-the-http-client-request-config', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http });
  const controller = new AbortController();
  await engine.translate('x', { signal: controller.signal });
  const pass = http.calls[0].config.signal === controller.signal;
  return { pass, actual: typeof http.calls[0].config.signal };
}, "pipeline.js's abortController.signal must reach axios's request config unchanged — this is the wiring the rest of the abort behavior depends on.");

check('no-signal-option-does-not-throw-or-send-one', async () => {
  const http = fakeHttpClient(OK_RESPONSE);
  const engine = new OpenAIEngine('key', { httpClient: http });
  await engine.translate('x', {});
  const pass = http.calls[0].config.signal === undefined;
  return { pass, actual: http.calls[0].config.signal };
}, 'Every existing caller that never passes options.signal (benches, translateNow() call sites written before Fase 9) must keep working unchanged.');

check('aborting-mid-request-actually-cancels-the-real-http-call', async () => {
  // v3.13.6x (Fase 9): the checks above only prove the signal is FORWARDED —
  // this proves it actually CANCELS, against a real HTTP server and a real
  // axios instance (not the fakeHttpClient the rest of this file uses),
  // same discipline as v3.13.39's real net.createServer check for the TCP
  // badge bug. A server that never responds + a signal aborted partway
  // through is what a slow LLM the debounce moves past looks like in
  // production.
  const http = require('http');
  const realAxios = require('axios');
  let serverSawRequest = false;
  const server = http.createServer((req, res) => {
    serverSawRequest = true;
    // Deliberately never respond — the abort must fire before any reply.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const engine = new OpenAIEngine('key', { httpClient: realAxios, timeout: 5000 });
  engine.setBaseUrl(`http://127.0.0.1:${port}`);
  const controller = new AbortController();

  const translatePromise = engine.translate('x', { signal: controller.signal });
  // Give the request a tick to actually reach the server before aborting —
  // an abort before the socket even connects would prove nothing about
  // cancelling an in-flight request specifically.
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();

  let threw = null;
  try {
    await translatePromise;
  } catch (e) {
    threw = e;
  }
  server.close();

  const pass = serverSawRequest && threw && threw.code === 'ERR_CANCELED';
  return { pass, actual: { serverSawRequest, errorCode: threw?.code } };
}, 'Proves cancellation is real, not just a forwarded option nobody reads — the request must have actually reached the server AND the promise must reject with ERR_CANCELED once aborted, against a live socket.');

run("llm-base.js bench", CHECKS);
