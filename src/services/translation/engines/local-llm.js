/**
 * Local LLM Engine
 * Connects to Ollama, LM Studio, or any OpenAI-compatible local server.
 * No API key required for most local setups.
 */
const axios = require('axios');

class LocalLLMEngine {
  constructor(options = {}) {
    this.name = 'local-llm';
    this.displayName = 'Local LLM (Ollama/LM Studio)';
    this.requiresKey = false;
    this.endpoint = options.endpoint || 'http://localhost:1234/v1';
    this.model = options.model || 'local-model';
    this.systemPrompt = options.systemPrompt || '';
    // v3.13.19: Context is owned by the pipeline's ContextMemory, passed in
    // via options.context — see context-memory.js.
    this.supportedLanguages = ['ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh'];
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es', sourceLangName = sourceLang, targetLangName = targetLang } = options;

    const defaultPrompt = `You are a professional translator for visual novels and games. Your task is to translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES — follow all of them exactly:
1. Output ONLY the translated text. No notes, no explanations, no added content.
2. NEVER translate or modify: proper names, character names, game/book/movie titles, brand names, or technical terms. Keep them exactly as written.
3. Preserve the speaker's tone, register, and emotional nuance.
4. Translate naturally — not word-for-word, but meaning-for-meaning.
5. Maintain consistency with any previously established terminology.`;
    // v3.13.55: the prompt used to end with "Input: {TEXT}\nOutput:" — a
    // completion-style placeholder that was never interpolated (the actual
    // text is sent as a separate `user` message below, not substituted into
    // the system prompt), so the model literally saw the string "{TEXT}".
    // Leftover from an earlier completion-API design ported to chat messages.

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

    for (const ctx of options.context || []) {
      messages.push({ role: 'user', content: ctx.source });
      messages.push({ role: 'assistant', content: ctx.translation });
    }

    messages.push({ role: 'user', content: text });

    const response = await axios.post(
      `${this.endpoint}/chat/completions`,
      {
        model: this.model,
        messages: messages,
        temperature: 0.3,
        max_tokens: 1000
      },
      {
        timeout: 60000, // Local models can be slower
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const translation = response.data?.choices?.[0]?.message?.content?.trim();
    if (!translation) {
      throw new Error('Empty local LLM response');
    }

    return {
      text: translation,
      detectedLang: null,
      engine: this.name
    };
  }

  setEndpoint(endpoint) {
    this.endpoint = endpoint;
  }

  setModel(model) {
    this.model = model;
  }
}

module.exports = LocalLLMEngine;
