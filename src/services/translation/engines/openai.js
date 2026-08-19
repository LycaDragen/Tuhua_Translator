/**
 * OpenAI API Engine
 * Supports GPT-4, GPT-3.5-turbo, and any OpenAI-compatible API.
 *
 * v3.13.56 (LLM engine overhaul, Fase 1): the actual translate() logic
 * (prompt, few-shot, context turns, request/response handling) now lives in
 * llm-base.js, shared with local-llm.js — this file just supplies the
 * OpenAI-specific constructor values. See llm-base.js for the full history.
 */
const OpenAICompatEngine = require('./llm-base');

class OpenAIEngine extends OpenAICompatEngine {
  constructor(apiKey, options = {}) {
    super({
      name: 'openai',
      displayName: 'OpenAI (GPT)',
      requiresKey: true,
      apiKey,
      model: options.model || 'gpt-3.5-turbo',
      baseUrl: options.baseUrl || 'https://api.openai.com/v1',
      systemPrompt: options.systemPrompt || '',
      timeout: 30000,
      supportedLanguages: [
        'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh', 'ar', 'hi', 'th', 'vi'
      ],
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
