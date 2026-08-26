/**
 * Bing Translator (Free) Engine
 * Uses Bing's web translator page (ttranslatev3 endpoint) with an anti-abuse
 * token scraped from that page. No API key required.
 *
 * v3.13.102: rewritten after confirming both prior methods were broken.
 * The Azure edge token endpoint (`edge.microsoft.com/translate/auth`) returns
 * a real HTTP 404 — deprecated/moved on Microsoft's side, dropped entirely.
 * The web method's token regexes expected the value in single quotes
 * (`'...'`); the page has always used double quotes
 * (`var params_AbusePreventionHelper = [<key>,"<token>",<ttlMs>]`), so the
 * token never matched and every request silently fell through to
 * `{"statusCode":205,"errorMessage":""}`. Verified against the live page.
 */
const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Bing rejects bare 'zh' for both `from` and `to` (HTTP 200 body
// {"statusCode":400}) — it needs the script-qualified locale. Verified live;
// every other language in supportedLanguages below works with its bare code.
const LANG_TO_BING = { zh: 'zh-Hans' };
const BING_LANG_NORMALIZE = { 'zh-hans': 'zh', 'zh-hant': 'zh' };

const AUTH_REGEX = /var\s+params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/;

/**
 * Pure parsing helpers, split out of the class so scripts/test-bing-engine.js
 * can pin the exact extraction/mapping logic against fixture HTML/JSON
 * without a live network call or an axios mock.
 */

function mapLangToBing(lang) {
  return LANG_TO_BING[lang] || lang;
}

function normalizeDetectedLang(code) {
  if (!code) return null;
  return BING_LANG_NORMALIZE[code.toLowerCase()] || code;
}

function parseAuthFromHtml(html) {
  const igMatch = html.match(/"ig":"([^"]+)"/);
  const iidMatch = html.match(/data-iid="([^"]+)"/);
  const authMatch = html.match(AUTH_REGEX);

  if (!igMatch || !authMatch) return null;

  return {
    ig: igMatch[1],
    iid: iidMatch ? iidMatch[1] : 'translator.5023',
    key: authMatch[1],
    token: authMatch[2],
    ttlMs: Number(authMatch[3])
  };
}

function parseTranslateResponse(data) {
  if (Array.isArray(data) && data[0]?.translations?.[0]?.text) {
    return {
      text: data[0].translations[0].text,
      detectedLang: normalizeDetectedLang(data[0].detectedLanguage?.language || null)
    };
  }
  if (data && typeof data === 'object' && 'statusCode' in data) {
    return { rejected: true, statusCode: data.statusCode };
  }
  return null;
}

class BingEngine {
  constructor() {
    this.name = 'bing';
    this.displayName = 'Bing Translator (Gratuito)';
    this.requiresKey = false;
    this.supportedLanguages = [
      'auto', 'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh',
      'ar', 'hi', 'th', 'vi', 'id', 'tr', 'nl', 'pl'
    ];
    this._auth = null; // { ig, iid, token, key, expiresAt }
  }

  async translate(text, options = {}) {
    const { sourceLang = 'auto', targetLang = 'es' } = options;
    console.log(`[Bing] translate: sourceLang=${sourceLang}, targetLang=${targetLang}`);

    const auth = await this._getAuth();
    const from = sourceLang === 'auto' ? 'auto-detect' : mapLangToBing(sourceLang);
    const to = mapLangToBing(targetLang);

    const url = `https://www.bing.com/ttranslatev3?IG=${auth.ig}&IID=${auth.iid}&isVertical=1&`;
    const body = new URLSearchParams({
      fromLang: from,
      to,
      text,
      token: auth.token,
      key: auth.key
    });

    const response = await axios.post(url, body, {
      timeout: 8000,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.bing.com/translator'
      }
    });

    const parsed = parseTranslateResponse(response.data);
    if (parsed?.text) {
      return { text: parsed.text, detectedLang: parsed.detectedLang, engine: this.name };
    }

    // A stale/invalid token doesn't error at the HTTP level — Bing replies
    // 200 with {"statusCode":...,"errorMessage":""}. Drop the cached auth so
    // the next attempt (pipeline retry or fallback) fetches a fresh one.
    if (parsed?.rejected) {
      this._auth = null;
      throw new Error(`Bing rejected the request (statusCode ${parsed.statusCode})`);
    }

    throw new Error('Unexpected Bing response format');
  }

  async _getAuth() {
    if (this._auth && Date.now() < this._auth.expiresAt) {
      return this._auth;
    }

    const pageResponse = await axios.get('https://www.bing.com/translator', {
      timeout: 8000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const parsed = parseAuthFromHtml(pageResponse.data);
    if (!parsed) {
      throw new Error('Could not extract Bing auth token from translator page');
    }

    this._auth = {
      ig: parsed.ig,
      iid: parsed.iid,
      key: parsed.key,
      token: parsed.token,
      // Small safety margin so a call started just before the real expiry
      // doesn't race a page whose token already rotated server-side.
      expiresAt: Date.now() + parsed.ttlMs - 30000
    };
    return this._auth;
  }
}

module.exports = BingEngine;
module.exports.mapLangToBing = mapLangToBing;
module.exports.normalizeDetectedLang = normalizeDetectedLang;
module.exports.parseAuthFromHtml = parseAuthFromHtml;
module.exports.parseTranslateResponse = parseTranslateResponse;
