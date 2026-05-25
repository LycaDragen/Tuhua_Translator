/**
 * Custom MT Engine
 * JSON-configurable translation endpoint.
 * Supports HTTP GET and POST with custom request/response mapping.
 * Inspired by VNTranslator's Custom MT but 100% free and open.
 */
const axios = require('axios');

class CustomMTEngine {
  constructor(config = {}) {
    this.name = 'custom-mt';
    this.displayName = 'Custom MT Endpoint';
    this.requiresKey = false;
    this.config = {
      endpoint: config.endpoint || '',
      method: config.method || 'POST',       // GET or POST
      headers: config.headers || {},
      // Request body template - use {{text}}, {{source}}, {{target}} as placeholders
      bodyTemplate: config.bodyTemplate || '{"text":"{{text}}","source":"{{source}}","target":"{{target}}"}',
      // Response path - dot notation to extract translation from response JSON
      responsePath: config.responsePath || 'data.translations.0.translatedText',
      // Authentication
      authHeader: config.authHeader || '',   // e.g. "Authorization: Bearer {{apiKey}}"
      apiKey: config.apiKey || '',
      timeout: config.timeout || 15000,
      ...config
    };
    this.supportedLanguages = ['ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh'];
  }

  _interpolateTemplate(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
  }

  _extractFromPath(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return null;
      current = current[part];
    }
    return current;
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es' } = options;

    if (!this.config.endpoint) {
      throw new Error('Custom MT endpoint is not configured');
    }

    const vars = {
      text: text,
      source: sourceLang,
      target: targetLang,
      apiKey: this.config.apiKey
    };

    const headers = { ...this.config.headers };
    if (this.config.authHeader) {
      const authValue = this._interpolateTemplate(this.config.authHeader, vars);
      const [headerName, ...headerValueParts] = authValue.split(':');
      headers[headerName.trim()] = headerValueParts.join(':').trim();
    }

    const requestConfig = {
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    let response;

    if (this.config.method.toUpperCase() === 'GET') {
      const url = this._interpolateTemplate(
        this.config.endpoint + (this.config.endpoint.includes('?') ? '&' : '?') + 'text={{text}}&source={{source}}&target={{target}}',
        vars
      );
      response = await axios.get(url, requestConfig);
    } else {
      const bodyStr = this._interpolateTemplate(this.config.bodyTemplate, vars);
      let body;
      try {
        body = JSON.parse(bodyStr);
      } catch {
        body = bodyStr;
      }
      response = await axios.post(
        this._interpolateTemplate(this.config.endpoint, vars),
        body,
        requestConfig
      );
    }

    const translation = this._extractFromPath(response.data, this.config.responsePath);
    if (!translation) {
      throw new Error('Could not extract translation from response. Check responsePath config.');
    }

    return {
      text: String(translation),
      detectedLang: null,
      engine: this.name
    };
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }
}

module.exports = CustomMTEngine;
