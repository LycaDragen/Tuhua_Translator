/**
 * llm-providers.js bench — LLM engine overhaul, Fase 3. Pure Node, no
 * network, no Electron.
 *
 * Three things this pins:
 *   1. The table itself is well-formed (unique ids, no trailing-slash
 *      double-concat bug — see the comment in llm-providers.js explaining
 *      why google-gemini/anthropic don't have one despite their own docs
 *      showing it).
 *   2. Every labelKey the table declares actually exists as an i18n key in
 *      all 8 locales — a provider a user can select but whose name shows
 *      up blank is worse than not listing it.
 *   3. getRequestParamOverrides() and the openaiKey->llmProviderKeys
 *      migration seed, both pure functions with real behavior to pin.
 *
 *   node scripts/test-llm-providers.js
 *   node scripts/test-llm-providers.js --quiet
 */
const path = require('path');
const {
  CLOUD_PROVIDERS,
  LOCAL_ENDPOINT_PRESETS,
  getProvider,
  getLocalPreset,
  getRequestParamOverrides,
  getExtraHeaders,
  resolveLocalEndpoint,
  seedProviderKeysFromLegacyOpenAIKey
} = require(path.join('..', 'src', 'services', 'translation', 'llm-providers.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

// ─── table shape ──────────────────────────────────────────────────────────
check('cloud-provider-ids-are-unique', () => {
  const ids = CLOUD_PROVIDERS.map((p) => p.id);
  const pass = new Set(ids).size === ids.length;
  return { pass, actual: ids };
});

check('local-preset-ids-are-unique', () => {
  const ids = LOCAL_ENDPOINT_PRESETS.map((p) => p.id);
  const pass = new Set(ids).size === ids.length;
  return { pass, actual: ids };
});

check('no-baseurl-ends-with-a-trailing-slash', () => {
  // llm-base.js does a plain `${baseUrl}/chat/completions` template concat
  // (not smart URL joining) — a trailing slash here would produce a
  // double slash on the wire. Empty string (the 'custom' entries, filled
  // in by the user) is fine; anything else must not end in '/'.
  const offenders = [...CLOUD_PROVIDERS, ...LOCAL_ENDPOINT_PRESETS]
    .filter((p) => p.baseUrl && p.baseUrl.endsWith('/'))
    .map((p) => p.id);
  return { pass: offenders.length === 0, actual: offenders };
}, "Regression guard for the exact bug caught while writing this table: Google's and Anthropic's own docs show a trailing slash, which is a different SDK's URL-joining convention, not what this file's raw concatenation needs.");

check('every-cloud-provider-has-a-display-name', () => {
  const offenders = CLOUD_PROVIDERS.filter((p) => !p.displayName).map((p) => p.id);
  return { pass: offenders.length === 0, actual: offenders };
}, 'displayName is the English name used in logs/errors — separate from labelKey (the translated UI string) on purpose.');

check('every-cloud-provider-has-a-default-model-unless-custom', () => {
  const offenders = CLOUD_PROVIDERS.filter((p) => p.id !== 'custom' && !p.defaultModel).map((p) => p.id);
  return { pass: offenders.length === 0, actual: offenders };
});

check('get-provider-and-get-local-preset-round-trip-every-id', () => {
  const cloudOk = CLOUD_PROVIDERS.every((p) => getProvider(p.id) === p);
  const localOk = LOCAL_ENDPOINT_PRESETS.every((p) => getLocalPreset(p.id) === p);
  const unknownIsNull = getProvider('does-not-exist') === null && getLocalPreset('does-not-exist') === null;
  return { pass: cloudOk && localOk && unknownIsNull };
});

// ─── i18n coverage ────────────────────────────────────────────────────────
check('every-labelkey-exists-in-all-8-locales', () => {
  const i18nPath = path.join(__dirname, '..', 'renderer', 'main', 'i18n.js');
  // i18n.js does `module.exports = translations` for Node — requiring it
  // directly gives the real object, no need to regex-scrape the file.
  const translations = require(i18nPath);
  const locales = Object.keys(translations);
  const labelKeys = [...CLOUD_PROVIDERS, ...LOCAL_ENDPOINT_PRESETS].map((p) => p.labelKey);
  const missing = [];
  for (const locale of locales) {
    for (const key of labelKeys) {
      if (!(key in translations[locale])) {
        missing.push(`${locale}.${key}`);
      }
    }
  }
  return { pass: locales.length === 8 && missing.length === 0, actual: { localeCount: locales.length, missing } };
}, 'A provider the dropdown can select but whose name renders blank is worse than not listing it at all.');

// ─── getRequestParamOverrides ────────────────────────────────────────────
check('reasoning-model-gets-max-completion-tokens-and-omits-sampling', () => {
  const result = getRequestParamOverrides('openai', 'o4-mini');
  const pass = result.maxTokensField === 'max_completion_tokens' && result.omitSamplingParams === true;
  return { pass, actual: result };
});

check('non-reasoning-model-keeps-max-tokens-and-sampling', () => {
  const result = getRequestParamOverrides('openai', 'gpt-4o-mini');
  const pass = result.maxTokensField === 'max_tokens' && result.omitSamplingParams === false;
  return { pass, actual: result };
});

check('deepseek-reasoner-also-omits-sampling', () => {
  const result = getRequestParamOverrides('deepseek', 'deepseek-reasoner');
  const pass = result.maxTokensField === 'max_tokens' && result.omitSamplingParams === true;
  return { pass, actual: result };
}, 'Different provider, different rejection shape: deepseek-reasoner still accepts max_tokens (only OpenAI\'s o-series needs max_completion_tokens) but also rejects temperature/top_p.');

check('unknown-provider-falls-back-to-safe-defaults', () => {
  const result = getRequestParamOverrides('does-not-exist', 'whatever');
  const pass = result.maxTokensField === 'max_tokens' && result.omitSamplingParams === false;
  return { pass, actual: result };
});

// ─── resolveLocalEndpoint ─────────────────────────────────────────────────
check('preset-wins-over-custom-endpoint', () => {
  const result = resolveLocalEndpoint('ollama', 'http://127.0.0.1:1234/v1');
  return { pass: result === 'http://127.0.0.1:11434/v1', actual: result };
});

// v1.0.4: guard de regresión, no un detalle de estilo. Node 18+ resuelve
// 'localhost' a ::1 (IPv6) antes que a 127.0.0.1, pero Ollama y compañía
// escuchan sólo en IPv4 por defecto: el resultado era
// `connect ECONNREFUSED ::1:11434` con el servidor perfectamente levantado.
// Salió del log de un usuario real, y el síntoma no da ninguna pista de que
// el problema sea la familia de direcciones — de ahí que valga un test.
check('local-presets-use-ipv4-not-localhost', () => {
  const offenders = LOCAL_ENDPOINT_PRESETS
    .filter((p) => p.baseUrl && p.baseUrl.includes('localhost'))
    .map((p) => p.id);
  return { pass: offenders.length === 0, actual: offenders };
}, 'localhost puede resolverse a ::1 y estos servidores suelen escuchar sólo IPv4.');

check('custom-preset-falls-back-to-the-legacy-customEndpoint-setting', () => {
  const result = resolveLocalEndpoint('custom', 'http://my-server:9000/v1');
  return { pass: result === 'http://my-server:9000/v1', actual: result };
}, 'Pre-Fase-3 behavior for anyone who never touches the new preset dropdown — customEndpoint stays the source of truth.');

check('no-preset-set-falls-back-to-customEndpoint-too', () => {
  // An install upgrading from before Fase 3 has no localLlmEndpointPreset
  // saved at all — must behave exactly like 'custom'.
  const result = resolveLocalEndpoint(undefined, 'http://localhost:1234/v1');
  return { pass: result === 'http://localhost:1234/v1', actual: result };
});

// ─── seedProviderKeysFromLegacyOpenAIKey (migration) ─────────────────────
check('migration-seeds-openai-key-into-provider-keys-map', () => {
  const result = seedProviderKeysFromLegacyOpenAIKey({ openaiKey: 'sk-legacy-123' });
  return { pass: result && result.openai === 'sk-legacy-123', actual: result };
});

check('migration-is-a-no-op-when-already-migrated', () => {
  // Even an EMPTY llmProviderKeys object means "already migrated / user's
  // choice" — must not overwrite it back from the legacy key.
  const result = seedProviderKeysFromLegacyOpenAIKey({ openaiKey: 'sk-legacy-123', llmProviderKeys: {} });
  return { pass: result === null, actual: result };
});

check('migration-is-a-no-op-when-there-is-nothing-to-migrate', () => {
  const result = seedProviderKeysFromLegacyOpenAIKey({ openaiKey: '' });
  return { pass: result === null, actual: result };
});

check('migration-does-not-touch-a-configured-provider-keys-map', () => {
  const result = seedProviderKeysFromLegacyOpenAIKey({
    openaiKey: 'sk-legacy-123',
    llmProviderKeys: { anthropic: 'sk-ant-real' }
  });
  return { pass: result === null, actual: result };
}, 'A user who has already set up a different provider (and never had an openaiKey used) must not have it silently reintroduced.');

// ─── getExtraHeaders (headers exigidos por proveedor) ────────────────────
// v1.0.5. Un usuario reportó "error 400" con Anthropic: el botón Validar
// consulta GET {baseUrl}/models, que en Anthropic es un endpoint NATIVO (la
// capa de compatibilidad OpenAI sólo cubre /chat/completions) y exige el
// header 'anthropic-version'. Sin él, 400 quejándose del header.
check('anthropic-declares-the-anthropic-version-header', () => {
  const h = getExtraHeaders('anthropic');
  return { pass: h['anthropic-version'] === '2023-06-01', actual: h };
}, 'Sin este header GET /v1/models devuelve 400. Es lo unico que le faltaba: Bearer si lo acepta.');

check('custom-provider-pointed-at-anthropic-still-gets-the-header', () => {
  // El caso que se escapa de la tabla: "Personalizado" con la URL a mano.
  // providerId es 'custom', no tiene extraHeaders propios, y sin el
  // fallback por host se come el mismo 400.
  const h = getExtraHeaders('custom', 'https://API.Anthropic.com/v1/');
  return { pass: h['anthropic-version'] === '2023-06-01', actual: h };
});

check('other-providers-get-no-extra-headers', () => {
  const cases = [
    getExtraHeaders('openai', 'https://api.openai.com/v1'),
    getExtraHeaders('custom', 'http://127.0.0.1:11434/v1'),
    getExtraHeaders('custom', 'no-es-una-url'),
    getExtraHeaders('inexistente')
  ];
  const bad = cases.filter((h) => Object.keys(h).length !== 0);
  return { pass: bad.length === 0, actual: bad };
}, 'Mandarle anthropic-version a Ollama o a OpenAI no rompe nada hoy, pero la tabla tiene que ser precisa o deja de significar algo.');

check('every-declared-extraHeaders-reaches-the-validate-handler', () => {
  // El defecto real no era la tabla: era que el punto de llamada no la
  // leia. Este check ata las dos mitades — si alguien agrega extraHeaders
  // a un proveedor pero Validar sigue mandando solo el Bearer, falla.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.js'), 'utf-8');
  const declaring = CLOUD_PROVIDERS.filter((p) => p.extraHeaders).map((p) => p.id);
  const wired = /axios\.get\(`\$\{base\}\/models`[\s\S]{0,320}?getExtraHeaders\(/.test(src);
  return {
    pass: declaring.length === 0 || wired,
    actual: { declaring, validateHandlerCallsGetExtraHeaders: wired }
  };
}, 'Este es el check que habria atrapado el bug original.');

run("llm-providers.js bench", CHECKS);
