/**
 * OpenAI-compatible chat completions engine — shared base for any provider
 * that speaks the `/chat/completions` API shape (OpenAI itself, Ollama/
 * LM Studio/llama.cpp/KoboldCpp locally, and — per the LLM engine overhaul
 * plan — OpenRouter/DeepSeek/Gemini/Anthropic/Groq via their OpenAI
 * compatibility layers later on).
 *
 * v3.13.56 (LLM engine overhaul, Fase 1): extracted from openai.js and
 * local-llm.js, which were ~95% identical — prompt text included — down to
 * the same typo-prone bugs having to be fixed twice (see v3.13.55's Fase 0).
 * This is a pure refactor: request shape, prompt text, few-shot logic, and
 * response parsing are all unchanged from what those two files did before.
 * `openai.js` and `local-llm.js` are now thin subclasses that just fix the
 * provider-specific constructor values (name, auth, default timeout, model,
 * baseUrl, supportedLanguages).
 */
const axios = require('axios');

class OpenAICompatEngine {
  constructor({
    name,
    displayName,
    requiresKey = false,
    apiKey = '',
    model,
    baseUrl,
    systemPrompt = '',
    timeout = 30000,
    supportedLanguages = [],
    httpClient = axios
  } = {}) {
    this.name = name;
    this.displayName = displayName;
    this.requiresKey = requiresKey;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.systemPrompt = systemPrompt;
    this.timeout = timeout;
    this.supportedLanguages = supportedLanguages;
    // Injectable so scripts/test-llm-base.js can assert on the exact request
    // body/headers without making a real HTTP call — same idea as the
    // injectable `store` in glossary.js/profile-store.js.
    this._httpClient = httpClient;
    // v3.13.19: Context is owned by the pipeline's ContextMemory, passed in
    // via options.context — see context-memory.js.
    //
    // v3.13.56: `capabilities` is what pipeline.js will read once Fase 3-5
    // land (prompt templates, glossary-as-prompt, abort/streaming) instead
    // of hardcoding engine names in a list — see the now-deleted
    // `LLM_ENGINES` array this replaces the intent of. `abort` stays false
    // until Fase 9 actually wires an AbortController through translate().
    this.capabilities = { prompt: true, context: 'chat-turns', glossaryPrompt: true, abort: false };
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es', sourceLangName = sourceLang, targetLangName = targetLang } = options;

    if (this.requiresKey && !this.apiKey) {
      throw new Error(`${this.displayName} API key is required`);
    }

    const defaultPrompt = `You are a professional translator for visual novels and games. Your task is to translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES — follow all of them exactly:
1. Output ONLY the translated text. No notes, no explanations, no added content.
2. NEVER translate or modify: proper names, character names, game/book/movie titles, brand names, or technical terms. Keep them exactly as written.
3. Preserve the speaker's tone, register, and emotional nuance.
4. Translate naturally — not word-for-word, but meaning-for-meaning.
5. Maintain consistency with any previously established terminology.`;

    const messages = [
      {
        role: 'system',
        content: this.systemPrompt || defaultPrompt
      }
    ];

    // Add few-shot example for better small model performance
    if (!this.systemPrompt) {
      if (sourceLangName === 'Japanese' && targetLangName === 'Spanish') {
        messages.push({ role: 'user', content: 'こんにちは、元気？' });
        messages.push({ role: 'assistant', content: 'Hola, ¿cómo estás?' });
      } else if (sourceLangName === 'Japanese' && targetLangName === 'English') {
        messages.push({ role: 'user', content: 'こんにちは、元気？' });
        messages.push({ role: 'assistant', content: 'Hello, how are you?' });
      }
    }

    // Add context history for better translation quality
    for (const ctx of options.context || []) {
      messages.push({ role: 'user', content: ctx.source });
      messages.push({ role: 'assistant', content: ctx.translation });
    }

    messages.push({ role: 'user', content: text });

    const headers = { 'Content-Type': 'application/json' };
    // v3.13.56: only send Authorization when there's actually a key to send.
    // openai.js always had one (requiresKey throws above if not), but
    // local-llm.js never sent this header at all — some local servers (LM
    // Studio with its optional auth toggle, notably) reject a Bearer header
    // with an empty token rather than just ignoring it, so "send an empty
    // Bearer" is not equivalent to "send nothing".
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this._httpClient.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages: messages,
        temperature: 0.3,
        max_tokens: 1000
      },
      { timeout: this.timeout, headers }
    );

    const translation = response.data?.choices?.[0]?.message?.content?.trim();
    if (!translation) {
      throw new Error(`Empty ${this.displayName} response`);
    }

    return {
      text: translation,
      detectedLang: null,
      engine: this.name
    };
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  setModel(model) {
    this.model = model;
  }

  setBaseUrl(url) {
    this.baseUrl = url;
  }
}

module.exports = OpenAICompatEngine;
