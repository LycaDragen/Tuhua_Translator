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

// v1.0.6: Google hands back HTML-escaped text on BOTH paths — the
// translate_a/single endpoint escapes quotes and ampersands inside the
// segment strings, and _translateViaWeb scrapes raw page HTML, so it can
// carry anything the page encoded. Nothing decoded it, so a line as plain
// as `"I don't know what's going on right now."` reached the overlay as
// `&quot;No sé qué está pasando ahora&quot;.` (real 2026-08-30 log). This
// hits every user, not just google-free users: google-free is the default
// fallback of every engine's chain (see FALLBACK_CHAIN in pipeline.js).
const HTML_ENTITIES = {
  'quot': '"',
  'apos': "'",
  'lt': '<',
  'gt': '>',
  'nbsp': ' ',
  'amp': '&'
};
// One single pass, deliberately: decoding `&amp;` in a second pass would
// turn the literal `&amp;quot;` (a text that really contains `&quot;`)
// into `"`. With one pass it correctly becomes `&quot;`.
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|quot|apos|lt|gt|nbsp|amp);/g;

class GoogleFreeEngine {
  constructor() {
    this.name = 'google-free';
    this.displayName = 'Google Translate (Gratuito)';
    this.requiresKey = false;
    this.supportedLanguages = [
      'auto', 'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh',
      'ar', 'hi', 'th', 'vi', 'id', 'tr', 'nl', 'pl', 'uk'
    ];
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

  /**
   * v1.0.6: Decode the HTML entities Google returns — see HTML_ENTITIES above.
   * @param {string} str
   * @returns {string}
   */
  _decodeEntities(str) {
    if (!str || typeof str !== 'string' || str.indexOf('&') === -1) return str;
    return str.replace(HTML_ENTITY_RE, (match, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
        // Not a usable code point (NaN, out of range, or a surrogate half) —
        // leave the entity exactly as it came rather than throwing.
        if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return match;
        try {
          return String.fromCodePoint(code);
        } catch (e) {
          return match;
        }
      }
      return HTML_ENTITIES[name];
    });
  }

  /**
   * v1.0.6: Parse a translate_a/single response body. Extracted from
   * _translateViaApi so the decoding can be pinned by a bench against real
   * captured payloads — a decode call is easy to drop, and without a test
   * that reads the parse path end-to-end nothing would notice.
   * @param {*} data - Parsed response body (Google returns a nested array)
   * @param {string} sl - The source language we asked for
   * @returns {{text: string, detectedLang: string|null}|null} null if unparseable
   * @private
   */
  _parseApiResponse(data, sl) {
    if (!data || !Array.isArray(data) || !Array.isArray(data[0])) return null;

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

    if (!translatedText) return null;
    return { text: this._decodeEntities(translatedText), detectedLang };
  }

  /**
   * v1.0.6: Parse the translate.google.com/m page. The `([^<]*)` capture
   * below takes raw HTML, so entity decoding isn't optional here — it's the
   * only thing standing between the page source and the overlay.
   * @param {string} html
   * @returns {string|null} null if the page shape didn't match
   * @private
   */
  _parseWebHtml(html) {
    if (typeof html !== 'string') return null;
    const resultMatch = html.match(/class="result-container">([^<]*)</);
    if (!resultMatch || !resultMatch[1]) return null;
    return this._decodeEntities(resultMatch[1]);
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

    // Google returns an array where the first element contains translation segments
    const parsed = this._parseApiResponse(response.data, sl);
    if (parsed) {
      return {
        text: parsed.text,
        detectedLang: parsed.detectedLang,
        engine: this.name
      };
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
    const translated = this._parseWebHtml(response.data);
    if (translated) {
      return {
        text: translated,
        detectedLang: null,
        engine: this.name
      };
    }

    throw new Error('Could not parse Google web response');
  }
}

module.exports = GoogleFreeEngine;
