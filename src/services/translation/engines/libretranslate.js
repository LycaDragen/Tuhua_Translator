/**
 * LibreTranslate Engine
 * Self-hosted or public LibreTranslate instance.
 * Can work offline if local instance is running.
 * Free and open source.
 */
const axios = require('axios');

class LibreTranslateEngine {
  constructor(options = {}) {
    this.name = 'libretranslate';
    this.displayName = 'LibreTranslate (Offline Capable)';
    this.requiresKey = false;
    this.endpoint = options.endpoint || 'http://localhost:5000';
    this.apiKey = options.apiKey || '';
    this.supportedLanguages = [
      'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko', 'ar', 'hi'
    ];
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es' } = options;
    console.log(`[LibreTranslate] translate: sourceLang=${sourceLang}, targetLang=${targetLang}`);

    const payload = {
      q: text,
      source: sourceLang === 'auto' ? 'auto' : sourceLang,
      target: targetLang,
      format: 'text'
    };

    if (this.apiKey) {
      payload.api_key = this.apiKey;
    }

    const response = await axios.post(
      `${this.endpoint}/translate`,
      payload,
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const data = response.data;
    if (data.translatedText) {
      return {
        text: data.translatedText,
        detectedLang: data.detectedLanguage?.language || null,
        engine: this.name
      };
    }

    throw new Error('Unexpected LibreTranslate response format');
  }

  setEndpoint(endpoint) {
    this.endpoint = endpoint;
  }

  setApiKey(key) {
    this.apiKey = key;
  }
}

module.exports = LibreTranslateEngine;
