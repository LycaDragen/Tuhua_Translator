/**
 * Local LLM Engine
 * Connects to Ollama, LM Studio, or any OpenAI-compatible local server.
 * No API key required for most local setups.
 *
 * v3.13.56 (LLM engine overhaul, Fase 1): the actual translate() logic
 * (prompt, few-shot, context turns, request/response handling) now lives in
 * llm-base.js, shared with openai.js — this file just supplies the
 * local-server-specific constructor values. See llm-base.js for the full
 * history.
 */
const OpenAICompatEngine = require('./llm-base');

class LocalLLMEngine extends OpenAICompatEngine {
  constructor(options = {}) {
    super({
      name: 'local-llm',
      displayName: 'Local LLM (Ollama/LM Studio)',
      requiresKey: false,
      model: options.model || 'local-model',
      baseUrl: options.endpoint || 'http://localhost:1234/v1',
      systemPrompt: options.systemPrompt || '',
      timeout: 60000, // Local models can be slower
      supportedLanguages: ['ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh'],
      // v3.13.58 (Fase 3): no `providerId` — local servers aren't in the
      // provider table, so getRequestParamOverrides(undefined, model)
      // always falls through to the plain max_tokens/temperature/top_p
      // defaults, which is the right behavior for an arbitrary local model.
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      // Only ever set by scripts/test-llm-base.js — production code never
      // passes this, so llm-base.js's own axios default is what runs live.
      httpClient: options.httpClient,
      // v3.13.57 (Fase 2): see the same comment in openai.js.
      sanitize: options.sanitize
    });
  }

  // Kept as a distinct name (rather than just exposing setBaseUrl directly)
  // since "endpoint" is the term used in settings/UI for this engine.
  setEndpoint(endpoint) {
    this.setBaseUrl(endpoint);
  }
}

module.exports = LocalLLMEngine;
