/**
 * Google Translate (Free) Engine
 * Uses Google Translate's mobile/desktop web endpoint directly.
 * No API key required. More reliable than @vitalets/google-translate-api
 * which frequently breaks due to CAPTCHA/token changes.
 *
 * v3.13.12: Added client='dict-chrome-ex' as alternative endpoint for better
 *   Korean/CJK support. The default 'gtx' client sometimes returns 'izh'
 *   (Izhorian) as detected language for Korean text, producing wrong
 *   translations. The 'dict-chrome-ex' client handles CJK languages better.
 *   Also added automatic retry with 'at' client when 'gtx' returns suspicious
 *   detected language codes. Following Luna Translator's approach of using
 *   multiple Google Translate endpoints for reliability.
 */
const axios = require('axios');

// v3.13.12: Language codes that Google Translate sometimes misidentifies.
// If the API returns one of these as detected language, it's likely wrong
// in a VN/translation context. We retry with a different client.
const SUSPICIOUS_LANG_CODES = new Set([
  'izh',   // Izhorian — Google misidentifies Korean as this
  'chr',   // Cherokee — rare, likely misidentification
  'haw',   // Hawaiian — rare, likely misidentification
  'mfe',   // Morisyen — rare, likely misidentification
  'ceb',   // Cebuano — sometimes confused with other Asian languages
]);

// v3.13.12: Normalize detected language codes from Google Translate.
// Maps non-standard or misidentified codes to their likely correct equivalents.
const GOOGLE_LANG_NORMALIZE = {
  'izh': 'ko',    // Izhorian → Korean (most common misidentification)
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  'zh-hans': 'zh',
  'zh-hant': 'zh',
};

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

  /**
   * v3.13.12: Normalize a detected language code from Google Translate.
   * Maps suspicious/wrong codes to their likely correct equivalents.
   * @param {string} code - Raw detected language code
   * @returns {string} Normalized language code
   */
  _normalizeDetectedLang(code) {
    if (!code) return code;
    const lower = code.toLowerCase();
    return GOOGLE_LANG_NORMALIZE[lower] || code;
  }

  async translate(text, options = {}) {
    const { sourceLang = 'auto', targetLang = 'es' } = options;
    console.log(`[Google-Free] translate: sourceLang=${sourceLang}, targetLang=${targetLang}`);

    const sl = sourceLang === 'auto' ? 'auto' : sourceLang;
    const tl = targetLang;

    // Method 1: Try the single endpoint with 'gtx' client
    try {
      const result = await this._translateViaApi(text, sl, tl, 'gtx');

      // v3.13.12: If the detected language is suspicious (e.g., 'izh' for Korean),
      // retry with 'dict-chrome-ex' client which handles CJK languages better.
      if (result.detectedLang && SUSPICIOUS_LANG_CODES.has(result.detectedLang.toLowerCase())) {
        console.log(`[Google-Free] Suspicious detected language '${result.detectedLang}' — retrying with dict-chrome-ex client`);
        try {
          const retryResult = await this._translateViaApi(text, sl, tl, 'dict-chrome-ex');
          if (retryResult.text && retryResult.text.length > 0) {
            // Normalize the detected language from the retry
            retryResult.detectedLang = this._normalizeDetectedLang(retryResult.detectedLang);
            return retryResult;
          }
        } catch (retryErr) {
          console.log(`[Google-Free] Retry with dict-chrome-ex failed: ${retryErr.message} — using original result`);
        }
      }

      // Normalize detected language
      result.detectedLang = this._normalizeDetectedLang(result.detectedLang);
      return result;
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

  /**
   * v3.13.12: Translate via Google Translate API endpoint with configurable client.
   * The 'gtx' client is the standard one. The 'dict-chrome-ex' client handles
   * CJK languages (especially Korean) better and is less likely to return
   * misidentified language codes like 'izh'.
   * @param {string} text - Text to translate
   * @param {string} sl - Source language code
   * @param {string} tl - Target language code
   * @param {string} client - Google Translate client identifier ('gtx', 'dict-chrome-ex', 'at')
   * @private
   */
  async _translateViaApi(text, sl, tl, client = 'gtx') {
    const url = 'https://translate.googleapis.com/translate_a/single';
    const params = {
      client: client,
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
