/**
 * OpenAI API Engine
 * Supports GPT-4, GPT-3.5-turbo, and any OpenAI-compatible API.
 * Features: system prompt customization, context history, streaming support.
 */
const axios = require('axios');

class OpenAIEngine {
  constructor(apiKey, options = {}) {
    this.name = 'openai';
    this.displayName = 'OpenAI (GPT)';
    this.requiresKey = true;
    this.apiKey = apiKey;
    this.model = options.model || 'gpt-3.5-turbo';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.systemPrompt = options.systemPrompt || '';
    // v3.13.19: Context is owned by the pipeline's ContextMemory, passed in
    // via options.context — see context-memory.js.
    this.supportedLanguages = [
      'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh', 'ar', 'hi', 'th', 'vi'
    ];
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es', sourceLangName = sourceLang, targetLangName = targetLang } = options;

    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const defaultPrompt = `You are a professional translator for visual novels and games. Your task is to translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES — follow all of them exactly:
1. Output ONLY the translated text. No notes, no explanations, no added content.
2. NEVER translate or modify: proper names, character names, game/book/movie titles, brand names, or technical terms. Keep them exactly as written.
3. Preserve the speaker's tone, register, and emotional nuance.
4. Translate naturally — not word-for-word, but meaning-for-meaning.
5. Maintain consistency with any previously established terminology.

Input: {TEXT}
Output:`;

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

    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages: messages,
        temperature: 0.3,
        max_tokens: 1000
      },
      {
        timeout: 30000,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const translation = response.data?.choices?.[0]?.message?.content?.trim();
    if (!translation) {
      throw new Error('Empty OpenAI response');
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
}

module.exports = OpenAIEngine;
