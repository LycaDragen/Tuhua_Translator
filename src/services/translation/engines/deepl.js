/**
 * DeepL API Engine
 * Uses official DeepL API (Free or Pro).
 * Requires API key.
 * Updated to auto-detect Free vs Pro endpoint on 403 errors.
 * v3.11.23: Added context, formality, preserve_formatting support.
 */
const axios = require('axios');

class DeepLEngine {
  constructor(apiKey, usePro = false, options = {}) {
    this.name = 'deepl';
    this.displayName = 'DeepL API';
    this.requiresKey = true;
    this.apiKey = apiKey;
    this.usePro = usePro || false;
    this.baseUrl = this.usePro
      ? 'https://api.deepl.com/v2'
      : 'https://api-free.deepl.com/v2';
    this.supportedLanguages = [
      'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh', 'ar', 'nl', 'pl', 'uk'
    ];
    // v3.11.23: Formality setting — 'default', 'more', 'less', 'prefer_more', 'prefer_less'
    this.formality = options.formality || 'default';
    // v3.11.23: Context — recent translation history for better quality
    this.contextHistory = [];
    this.maxContext = options.maxContext || 3;
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es' } = options;
    console.log(`[DeepL] translate: sourceLang=${sourceLang}, targetLang=${targetLang}`);

    if (!this.apiKey) {
      throw new Error('DeepL API key is required. Get one free at deepl.com/pro#developer');
    }

    const payload = {
      text: text,
      target_lang: targetLang.toUpperCase()
    };

    // Only send source_lang if it's not auto-detect
    if (sourceLang !== 'auto') {
      payload.source_lang = sourceLang.toUpperCase();
    }

    // v3.11.23: Send context from recent translation history.
    // DeepL's context parameter accepts additional text that influences translation
    // but is not translated itself. Characters in context are NOT billed.
    // We send the last few source strings as context for better disambiguation.
    if (this.contextHistory.length > 0) {
      // Build context from recent source texts (last 3 by default)
      const contextTexts = this.contextHistory.slice(-this.maxContext).map(h => h.source);
      const contextStr = contextTexts.join(' ');
      // DeepL recommends context < 2000 chars, and it must be same language as source
      if (contextStr.length > 0 && contextStr.length <= 2000) {
        payload.context = contextStr;
      }
    }

    // v3.11.23: Formality setting.
    // Supported for: DE, FR, IT, ES, NL, PL, PT-BR, PT-PT, JA, RU
    // 'more' = formal, 'less' = informal, 'prefer_more'/'prefer_less' = soft preference
    if (this.formality && this.formality !== 'default') {
      payload.formality = this.formality;
    }

    // v3.11.23: Preserve formatting — maintains original punctuation/capitalization patterns
    payload.preserve_formatting = true;

    try {
      const response = await this._makeRequest(payload);
      const data = response.data;
      if (data.translations && data.translations[0]) {
        const result = {
          text: data.translations[0].text,
          detectedLang: data.translations[0].detected_source_language?.toLowerCase() || null,
          engine: this.name
        };

        // Add to context history for next translation
        this.contextHistory.push({ source: text, translation: result.text });
        if (this.contextHistory.length > this.maxContext) {
          this.contextHistory.shift();
        }

        return result;
      }
      throw new Error('Unexpected DeepL response format');
    } catch (err) {
      // If we get 403 on the configured endpoint, try the other one
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        const altUrl = this.baseUrl === 'https://api.deepl.com/v2'
          ? 'https://api-free.deepl.com/v2'
          : 'https://api.deepl.com/v2';

        console.log(`[DeepL] Got ${err.response.status} on ${this.baseUrl}, trying ${altUrl}`);

        try {
          const response = await axios.post(
            `${altUrl}/translate`,
            payload,
            {
              timeout: 10000,
              headers: {
                'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
                'Content-Type': 'application/json'
              }
            }
          );

          // If the alternate endpoint worked, update our baseUrl for future requests
          this.baseUrl = altUrl;
          console.log(`[DeepL] Switched to ${altUrl}`);

          const data = response.data;
          if (data.translations && data.translations[0]) {
            const result = {
              text: data.translations[0].text,
              detectedLang: data.translations[0].detected_source_language?.toLowerCase() || null,
              engine: this.name
            };

            // Add to context history
            this.contextHistory.push({ source: text, translation: result.text });
            if (this.contextHistory.length > this.maxContext) {
              this.contextHistory.shift();
            }

            return result;
          }
          throw new Error('Unexpected DeepL response format');
        } catch (altErr) {
          // Both endpoints failed, throw the original error
          throw err;
        }
      }
      throw err;
    }
  }

  _makeRequest(payload) {
    return axios.post(
      `${this.baseUrl}/translate`,
      payload,
      {
        timeout: 10000,
        headers: {
          'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  setUsePro(usePro) {
    this.usePro = usePro;
    this.baseUrl = usePro
      ? 'https://api.deepl.com/v2'
      : 'https://api-free.deepl.com/v2';
  }

  setFormality(formality) {
    this.formality = formality || 'default';
  }

  clearContext() {
    this.contextHistory = [];
  }
}

module.exports = DeepLEngine;
