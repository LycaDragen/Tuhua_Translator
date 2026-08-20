/**
 * LLM provider table — LLM engine overhaul, Fase 3.
 *
 * Lyca asked for a dropdown of cloud LLM providers next to the API key
 * field (today only OpenAI's own API is reachable). Every provider below
 * speaks the same `/chat/completions` shape OpenAI does — none of them
 * need a real adapter, which is why this is a data table and not seven new
 * engine classes.
 *
 * Deliberately NOT here: Mistral, Together, Fireworks, Cerebras, and other
 * open-weights hosts. OpenRouter already covers "I want a cheap open model"
 * with a single key, so adding a second host for the same job is only
 * mainteance cost for the dropdown, not a real capability gap.
 *
 * Pure, no I/O, no Electron — requireable from a plain-Node bench.
 */

const CLOUD_PROVIDERS = [
  {
    id: 'openai',
    labelKey: 'llm_provider_openai',
    // English name for logs/errors — NOT shown in the UI (labelKey is,
    // translated in all 8 locales). Kept separate on purpose: an error
    // message like "OpenAI API key is required" belongs in a log file, not
    // in the user's chosen UI language.
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini', 'gpt-3.5-turbo'],
    maxTokensField: 'max_tokens',
    // v3.13.58: OpenAI's reasoning models (o1/o3/o4/...) reject `max_tokens`
    // (they want `max_completion_tokens` instead) AND reject a custom
    // `temperature`/`top_p` entirely — see getRequestParamOverrides() below,
    // which is what actually reads this at request-build time.
    reasoningModelPattern: /^o\d/i,
    // This is an OpenAI-specific quirk, NOT a general "reasoning models
    // rename this field" rule — deepseek-reasoner below matches its own
    // reasoningModelPattern but keeps plain `max_tokens`, which is exactly
    // why this flag is per-provider rather than implied by
    // reasoningModelPattern alone.
    reasoningModelUsesMaxCompletionTokens: true,
    supportsTopP: true,
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter',
    labelKey: 'llm_provider_openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authScheme: 'bearer',
    requiresKey: true,
    // A single OpenRouter key reaches OpenAI/Anthropic/Google/DeepSeek/Meta
    // models and more — listed first among the third-party providers on
    // purpose, it's the lowest-friction way to try more than one model.
    defaultModel: 'openai/gpt-4o-mini',
    models: [
      'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku',
      'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat'
    ],
    maxTokensField: 'max_tokens',
    supportsTopP: true,
    docsUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'deepseek',
    labelKey: 'llm_provider_deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authScheme: 'bearer',
    requiresKey: true,
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    maxTokensField: 'max_tokens',
    // deepseek-reasoner is DeepSeek's own reasoning model — same rejection
    // behavior as OpenAI's o-series for temperature/top_p (not max_tokens,
    // it still accepts that one; only the sampling params are rejected).
    reasoningModelPattern: /reasoner/i,
    supportsTopP: true,
    docsUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'google-gemini',
    labelKey: 'llm_provider_google_gemini',
    displayName: 'Google Gemini',
    // v3.13.58: Google's own docs show this baseURL WITH a trailing slash,
    // but that's an openai-python/openai-node SDK config convention (their
    // client does smart URL joining) — llm-base.js instead does a plain
    // `${baseUrl}/chat/completions` template concat, so a stored trailing
    // slash here would produce a double slash on the wire. No trailing
    // slash, consistent with every other entry in this table (see
    // getRequestParamOverrides's bench for the invariant that pins this).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authScheme: 'bearer',
    requiresKey: true,
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
    maxTokensField: 'max_tokens',
    supportsTopP: true,
    docsUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'anthropic',
    labelKey: 'llm_provider_anthropic',
    displayName: 'Anthropic',
    // Same no-trailing-slash reasoning as google-gemini above.
    baseUrl: 'https://api.anthropic.com/v1',
    authScheme: 'bearer',
    requiresKey: true,
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
    maxTokensField: 'max_tokens',
    supportsTopP: true,
    // v3.13.58: Anthropic's own docs mark their OpenAI SDK compatibility
    // layer as beta and "not intended for production applications" — this
    // flag is what the UI uses to show that disclaimer instead of hiding
    // it. Not a reason to write a native /v1/messages adapter today: Tuhua
    // uses none of what the compat layer lacks (tool calling, PDFs,
    // extended thinking, prompt caching) — that's the concrete trigger to
    // revisit this, not "Anthropic support" in the abstract.
    beta: true,
    docsUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'groq',
    labelKey: 'llm_provider_groq',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authScheme: 'bearer',
    requiresKey: true,
    // Groq's whole pitch is inference speed, which matters for a live
    // overlay — listed for that reason even though it hosts open models
    // OpenRouter can also reach, similar to why OpenRouter itself is here.
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    maxTokensField: 'max_tokens',
    supportsTopP: true,
    docsUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'custom',
    labelKey: 'llm_provider_custom',
    displayName: 'Custom (OpenAI-compatible)',
    // The escape hatch: today's plain "OpenAI (GPT)" engine with a
    // user-typed baseUrl, for any OpenAI-compatible provider not listed
    // above.
    baseUrl: '',
    authScheme: 'bearer',
    requiresKey: false,
    defaultModel: '',
    models: [],
    maxTokensField: 'max_tokens',
    supportsTopP: true,
    docsUrl: ''
  }
];

// Presets for the LOCAL engine's endpoint field — these aren't "providers"
// in the credentialed-cloud sense, just common ports so the user doesn't
// have to remember one. v3.13.19-era testing already documented mixing up
// LM Studio's :1234 and Ollama's :11434 as a real, repeated mistake (see
// scripts/test-context-memory.js's header) — this is what removes it.
const LOCAL_ENDPOINT_PRESETS = [
  { id: 'lmstudio', labelKey: 'llm_local_preset_lmstudio', baseUrl: 'http://localhost:1234/v1' },
  { id: 'ollama', labelKey: 'llm_local_preset_ollama', baseUrl: 'http://localhost:11434/v1' },
  { id: 'llamacpp', labelKey: 'llm_local_preset_llamacpp', baseUrl: 'http://localhost:8080/v1' },
  { id: 'koboldcpp', labelKey: 'llm_local_preset_koboldcpp', baseUrl: 'http://localhost:5001/v1' },
  { id: 'custom', labelKey: 'llm_local_preset_custom', baseUrl: '' }
];

function getProvider(id) {
  return CLOUD_PROVIDERS.find((p) => p.id === id) || null;
}

function getLocalPreset(id) {
  return LOCAL_ENDPOINT_PRESETS.find((p) => p.id === id) || null;
}

/**
 * What pipeline.js actually passes as the local-llm engine's endpoint.
 * `customEndpoint` is the pre-existing setting (still the source of truth
 * for the 'custom' preset, and for anyone who never touches the new
 * dropdown — an install upgrading from before Fase 3 keeps working
 * unchanged). Any other preset id wins over it.
 */
function resolveLocalEndpoint(presetId, customEndpoint) {
  if (!presetId || presetId === 'custom') {
    return customEndpoint || '';
  }
  const preset = getLocalPreset(presetId);
  return preset ? preset.baseUrl : (customEndpoint || '');
}

/**
 * What llm-base.js's request builder needs to know beyond the plain
 * temperature/maxTokens/topP values: which JSON field carries the token
 * cap, and whether to omit the sampling params entirely for a reasoning
 * model that rejects them. Keyed on provider+model rather than provider
 * alone, since e.g. OpenAI's gpt-4o-mini and o4-mini need different
 * handling from the SAME provider.
 */
function getRequestParamOverrides(providerId, model) {
  const provider = getProvider(providerId);
  if (!provider) {
    return { maxTokensField: 'max_tokens', omitSamplingParams: false };
  }
  const isReasoningModel = !!(provider.reasoningModelPattern && model && provider.reasoningModelPattern.test(model));
  const useMaxCompletionTokens = isReasoningModel && provider.reasoningModelUsesMaxCompletionTokens === true;
  return {
    maxTokensField: useMaxCompletionTokens ? 'max_completion_tokens' : (provider.maxTokensField || 'max_tokens'),
    omitSamplingParams: isReasoningModel
  };
}

/**
 * One-time, idempotent seed: promote the legacy global `openaiKey` setting
 * into the new `llmProviderKeys.openai` map. Returns the object to
 * `store.set('llmProviderKeys', ...)`, or null if there's nothing to do —
 * caller only writes when this returns non-null, so an already-migrated or
 * never-configured install is left untouched.
 *
 * v3.13.58: `openaiKey` itself is deliberately NOT deleted or read from
 * here again after this runs — same "leave it dead for one version, clean
 * it up later" approach as v3.13.44's DEAD_SETTING_KEYS (see
 * profile-migrations.js), which has an established precedent in this repo.
 * pipeline.js stops reading `openaiKey` as of this version; only this
 * function still looks at it, and only once.
 */
function seedProviderKeysFromLegacyOpenAIKey(settings) {
  const existing = settings.llmProviderKeys;
  if (existing && typeof existing === 'object') {
    return null; // already migrated, or the user has already configured providers directly
  }
  const legacyKey = settings.openaiKey;
  if (!legacyKey || typeof legacyKey !== 'string') {
    return null; // nothing to migrate
  }
  return { openai: legacyKey };
}

module.exports = {
  CLOUD_PROVIDERS,
  LOCAL_ENDPOINT_PRESETS,
  getProvider,
  getLocalPreset,
  getRequestParamOverrides,
  resolveLocalEndpoint,
  seedProviderKeysFromLegacyOpenAIKey
};
