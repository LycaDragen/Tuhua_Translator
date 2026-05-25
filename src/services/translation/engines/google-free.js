/**
 * Google Translate (Free) Engine
 * Uses Google Translate's mobile/desktop web endpoint directly.
 * No API key required. More reliable than @vitalets/google-translate-api
 * which frequently breaks due to CAPTCHA/token changes.
 */
const axios = require('axios');

class GoogleFreeEngine {
  constructor() {
    this.name = 'google-free';
    this.displayName = 'Google Translate (Gratuito)';
    this.requiresKey = false;
    this.supportedLanguages = [
      'auto', 'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh',
      'ar', 'hi', 'th', 'vi', 'id', 'tr', 'nl', 'pl', 'uk'
    ];
    this.token = null;
    this.tokenExpiry = 0;
  }

  async _getToken() {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    try {
      const response = await axios.get('https://translate.google.com', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      // Try to extract the RPC token (TKK) from the page
      const tkkMatch = response.data.match(/tkk:'([^']+)'/);
      if (tkkMatch) {
        this.token = tkkMatch[1];
      } else {
        // Fallback: use a timestamp-based token
        const hours = Math.floor(Date.now() / 3600000);
        this.token = `${hours}`;
      }
      this.tokenExpiry = Date.now() + 3600000; // 1 hour
      return this.token;
    } catch (e) {
      // If token fetch fails, use timestamp-based fallback
      const hours = Math.floor(Date.now() / 3600000);
      this.token = `${hours}`;
      this.tokenExpiry = Date.now() + 3600000;
      return this.token;
    }
  }

  async translate(text, options = {}) {
    const { sourceLang = 'auto', targetLang = 'es' } = options;
    console.log(`[Google-Free] translate: sourceLang=${sourceLang}, targetLang=${targetLang}`);

    const sl = sourceLang === 'auto' ? 'auto' : sourceLang;
    const tl = targetLang;

    // Method 1: Try the single endpoint (most reliable for short texts)
    try {
      const url = 'https://translate.googleapis.com/translate_a/single';
      const params = {
        client: 'gtx',
        sl: sl,
        tl: tl,
        dt: 't',
        q: text
      };

      const response = await axios.get(url, {
        params,
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const data = response.data;

      // Google returns an array where the first element contains translation segments
      if (data && Array.isArray(data) && Array.isArray(data[0])) {
        let translatedText = '';
        let detectedLang = null;

        for (const segment of data[0]) {
          if (segment && segment[0]) {
            translatedText += segment[0];
          }
        }

        // Detected language is in data[2]
        if (data[2] && data[2] !== sl) {
          detectedLang = data[2];
        }

        if (translatedText) {
          return {
            text: translatedText,
            detectedLang: detectedLang,
            engine: this.name
          };
        }
      }

      throw new Error('Could not parse Google response');
    } catch (primaryError) {
      // Method 2: Fallback to the web scrape approach
      try {
        return await this._translateViaWeb(text, sl, tl);
      } catch (fallbackError) {
        // Both methods failed - throw the primary error
        throw new Error(primaryError.message || 'Google Translate request failed');
      }
    }
  }

  async _translateViaWeb(text, sl, tl) {
    const url = 'https://translate.google.com/m';
    const params = {
      sl: sl,
      tl: tl,
      q: text
    };

    const response = await axios.get(url, {
      params,
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      }
    });

    // Parse the mobile page HTML
    const resultMatch = response.data.match(/class="result-container">([^<]*)</);
    if (resultMatch && resultMatch[1]) {
      return {
        text: resultMatch[1],
        detectedLang: null,
        engine: this.name
      };
    }

    throw new Error('Could not parse Google web response');
  }
}

module.exports = GoogleFreeEngine;
