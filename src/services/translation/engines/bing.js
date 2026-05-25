/**
 * Bing Translator (Free) Engine
 * Uses Microsoft's Azure Cognitive Services token endpoint.
 * No API key required.
 * Updated: Uses edge auth token approach (most reliable free method).
 */
const axios = require('axios');

class BingEngine {
  constructor() {
    this.name = 'bing';
    this.displayName = 'Bing Translator (Gratuito)';
    this.requiresKey = false;
    this.supportedLanguages = [
      'auto', 'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh',
      'ar', 'hi', 'th', 'vi', 'id', 'tr', 'nl', 'pl'
    ];
  }

  async translate(text, options = {}) {
    const { sourceLang = 'auto', targetLang = 'es' } = options;
    console.log(`[Bing] translate: sourceLang=${sourceLang}, targetLang=${targetLang}`);

    // Method 1: Try Azure Cognitive Services token (most reliable)
    try {
      return await this._translateViaAzureToken(text, sourceLang, targetLang);
    } catch (azureError) {
      console.log(`[Bing] Azure token method failed: ${azureError.message}, trying web method...`);

      // Method 2: Fallback to web scraping method
      try {
        return await this._translateViaWeb(text, sourceLang, targetLang);
      } catch (webError) {
        throw new Error(azureError.message || 'Bing translation failed');
      }
    }
  }

  async _translateViaAzureToken(text, sourceLang, targetLang) {
    // Get an auth token from Microsoft Edge's translate auth endpoint
    const authResponse = await axios.post(
      'https://edge.microsoft.com/translate/auth',
      null,
      {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
        }
      }
    );

    const authToken = authResponse.data;
    if (!authToken || typeof authToken !== 'string') {
      throw new Error('Failed to get Bing auth token');
    }

    // Use the Azure Cognitive Services endpoint with the token
    const params = {
      'api-version': '3.0',
      to: targetLang
    };

    // Only set 'from' if not auto-detect — Azure API does not accept 'from' for auto-detect
    if (sourceLang !== 'auto') {
      params.from = sourceLang;
    }

    const response = await axios.post(
      'https://api.cognitive.microsofttranslator.com/translate',
      [{ text: text }],
      {
        params,
        timeout: 8000,
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
          'Referer': 'https://www.bing.com/translator'
        }
      }
    );

    const data = response.data;
    if (Array.isArray(data) && data[0]?.translations?.[0]?.text) {
      return {
        text: data[0].translations[0].text,
        detectedLang: data[0].detectedLanguage?.language || null,
        engine: this.name
      };
    }

    throw new Error('Unexpected Bing Azure response format');
  }

  async _translateViaWeb(text, sourceLang, targetLang) {
    // Fallback: Use Bing's web translator page directly
    // First, get a token and IG/IID from the page
    const pageResponse = await axios.get('https://www.bing.com/translator', {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = pageResponse.data;
    let ig = '';
    let iid = 'translator.5021';
    let token = '';
    let tokenExpiry = 0;

    // Extract IG parameter
    const igMatch = html.match(/"ig":"([^"]+)"/);
    if (igMatch) ig = igMatch[1];

    // Extract IID parameter
    const iidMatch = html.match(/data-iid="([^"]+)"/);
    if (iidMatch) iid = iidMatch[1];

    // Extract the abuse prevention token
    const keyPatterns = [
      /params_AbusePreventionHelper\s*=\s*\[.*?'([^']+)'/,
      /params_AbusePreventionHelper\s*=\s*\[\s*'([^']+)'/,
      /"AbusePreventionHelper".*?"([^"]{20,})"/
    ];

    for (const pattern of keyPatterns) {
      const match = html.match(pattern);
      if (match) {
        token = match[1];
        tokenExpiry = Date.now() + 540000; // 9 minutes
        break;
      }
    }

    const from = sourceLang === 'auto' ? '' : sourceLang;

    const url = `https://www.bing.com/ttranslatev3?IG=${ig}&IID=${iid}&isVertical=1&`;
    const body = new URLSearchParams({
      fromLang: from || 'auto-detect',
      to: targetLang,
      text: text
    });

    if (token) {
      body.append('token', token);
      body.append('key', Date.now().toString());
    }

    const response = await axios.post(url, body, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.bing.com/translator'
      }
    });

    const data = response.data;

    if (data) {
      if (Array.isArray(data) && data[0]?.translations?.[0]?.text) {
        return {
          text: data[0].translations[0].text,
          detectedLang: data[0].detectedLanguage?.language || null,
          engine: this.name
        };
      }

      if (data.translations?.[0]?.text) {
        return {
          text: data.translations[0].text,
          detectedLang: data.detectedLanguage?.language || null,
          engine: this.name
        };
      }

      if (typeof data === 'string' && data.length > 0 && data.length < text.length * 3) {
        return {
          text: data,
          detectedLang: null,
          engine: this.name
        };
      }
    }

    throw new Error('Unexpected Bing web response format');
  }
}

module.exports = BingEngine;
