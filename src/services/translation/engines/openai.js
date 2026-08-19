/**
 * Cloud LLM engine — the `engine:'openai'` slot in pipeline.js, but no
 * longer hardcoded to OpenAI itself.
 *
 * v3.13.56 (Fase 1): the actual translate() logic now lives in
 * llm-base.js, shared with local-llm.js — this file just supplies
 * constructor values.
 *
 * v3.13.58 (Fase 3): those constructor values are now looked up from
 * `providerId` in llm-providers.js rather than hardcoded to OpenAI's own
 * baseUrl/model. `engine` stays `'openai'` in settings/profile/cache-key
 * terms — see the plan's explicit reasoning for why the provider is a
 * sub-setting (`llmProvider`) instead of a new `engine` id: that would have
 * fragmented the cache key, FALLBACK_CHAIN, and every saved profile's
 * `engine` field for zero benefit. The class name and file path stay as
 * `OpenAIEngine`/`openai.js` for the same reason — renaming either is a
 * bigger, unrelated diff for no functional gain.
 */
const OpenAICompatEngine = require('./llm-base');
const { getProvider } = require('../llm-providers');

class OpenAIEngine extends OpenAICompatEngine {
  constructor(apiKey, options = {}) {
    const providerId = options.providerId || 'openai';
    const provider = getProvider(providerId) || getProvider('openai');
    super({
      name: 'openai',
      displayName: provider.displayName,
      requiresKey: provider.requiresKey,
      apiKey,
      model: options.model || provider.defaultModel || 'gpt-3.5-turbo',
      // `options.baseUrl` wins when set — that's how the 'custom' provider
      // (an empty baseUrl in the table on purpose) and a per-profile
      // override both work: the user-typed URL comes in as options.baseUrl.
      // Deliberately NO further fallback to OpenAI's real URL: `provider`
      // is always resolved above (falls back to the real 'openai' entry
      // when providerId is unknown), so if THIS is empty it's because the
      // user picked 'custom' and hasn't typed a URL yet — failing the
      // request outright is correct there, silently calling OpenAI's API
      // with their key would not be.
      baseUrl: options.baseUrl || provider.baseUrl,
      systemPrompt: options.systemPrompt || '',
      timeout: 30000,
      supportedLanguages: [
        'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh', 'ar', 'hi', 'th', 'vi'
      ],
      providerId,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      // Only ever set by scripts/test-llm-base.js — production code never
      // passes this, so llm-base.js's own axios default is what runs live.
      httpClient: options.httpClient,
      // v3.13.57 (Fase 2): defaults true in llm-base.js when omitted —
      // forwarded explicitly here (rather than defaulting to true again in
      // this file) so pipeline.js's `sanitize: s.llmSanitize !== false` is
      // the one place that decides it.
      sanitize: options.sanitize
    });
  }
}

module.exports = OpenAIEngine;
