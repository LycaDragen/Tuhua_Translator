/**
 * Translation Pipeline
 * Central orchestrator that manages:
 * - Engine selection and initialization
 * - Debounce/throttle for rapid text changes
 * - Translation cache (persistent)
 * - Glossary pre/post processing
 * - Retry with exponential backoff
 * - Fallback to alternative engines
 * - Translation history logging
 * - Request cancellation for superseded translations
 */
const EventEmitter = require('events');
const TranslationCache = require('./cache');
const TranslationMemory = require('./translation-memory');
const GlossaryService = require('./glossary');

// Engine imports
const GoogleFreeEngine = require('./engines/google-free');
const BingEngine = require('./engines/bing');
const DeepLEngine = require('./engines/deepl');
const OpenAIEngine = require('./engines/openai');
const LocalLLMEngine = require('./engines/local-llm');
const LibreTranslateEngine = require('./engines/libretranslate');
const CustomMTEngine = require('./engines/custom-mt');

// Language code to full name mapping (for LLM prompts and display)
const LANGUAGE_NAMES = {
  'auto': 'Auto-detect',
  'ja': 'Japanese', 'en': 'English', 'es': 'Spanish', 'zh': 'Chinese',
  'ko': 'Korean', 'ru': 'Russian', 'pt': 'Portuguese', 'fr': 'French',
  'de': 'German', 'it': 'Italian', 'ar': 'Arabic', 'th': 'Thai',
  'vi': 'Vietnamese', 'id': 'Indonesian', 'tr': 'Turkish', 'nl': 'Dutch',
  'pl': 'Polish', 'uk': 'Ukrainian', 'hi': 'Hindi'
};

function getLanguageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

// Engines that are LLM-based and need explicit source language in prompt
const LLM_ENGINES = ['openai', 'local-llm'];

// Simple character-based language detection for CJK and common scripts
function detectLanguageSimple(text) {
  if (!text || text.length === 0) return null;

  // Count character types
  let hiragana = 0, katakana = 0, kanji = 0, cyrillic = 0, hangul = 0, hanziSimplified = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0);
    // Hiragana: 3040-309F
    if (code >= 0x3040 && code <= 0x309F) hiragana++;
    // Katakana: 30A0-30FF
    else if (code >= 0x30A0 && code <= 0x30FF) katakana++;
    // CJK Unified Ideographs (common to JA/ZH/KO)
    else if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) kanji++;
    // Cyrillic
    else if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) cyrillic++;
    // Hangul
    else if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)) hangul++;
  }

  // Japanese: has hiragana or katakana
  if (hiragana > 0 || katakana > 0) return 'ja';
  // Korean: has hangul
  if (hangul > 0) return 'ko';
  // Russian: has cyrillic
  if (cyrillic > 2) return 'ru';
  // Chinese: has CJK but no kana/hangul (simplified detection)
  if (kanji > 0 && hiragana === 0 && katakana === 0 && hangul === 0) return 'zh';

  // Default: can't determine
  return null;
}

// Fallback chain: if primary engine fails, try these in order
const FALLBACK_CHAIN = {
  'google-free': ['bing'],
  'bing': ['google-free'],
  'deepl': ['google-free', 'bing'],
  'openai': ['google-free'],
  'local-llm': ['google-free'],
  'libretranslate': ['google-free', 'bing'],
  'custom-mt': ['google-free', 'bing']
};

class TranslationPipeline extends EventEmitter {
  constructor(settings = {}) {
    super();
    this.settings = settings;
    this.cache = new TranslationCache({ maxSize: 5000 });
    // v3.11.23: Translation Memory — engine-agnostic persistent store
    this.translationMemory = new TranslationMemory({ maxSize: 10000, enabled: settings.enableTranslationMemory !== false });
    this.glossary = new GlossaryService();

    // Debounce
    this.debounceMs = settings.debounceMs || 300;
    this.debounceTimer = null;
    this._pendingReject = null;

    // Rate limiting
    this.lastRequestTime = 0;
    this.minRequestInterval = 500; // ms between requests

    // History (in-memory, limited by historyLimit setting)
    this.history = [];
    this.maxHistory = settings.historyLimit || 500;

    // Engine instances (lazy initialized)
    this.engines = {};

    // Last error tracking
    this._lastError = null;

    // Stats
    this.stats = {
      totalTranslations: 0,
      cacheHits: 0,
      tmHits: 0,
      errors: 0,
      fallbacks: 0
    };
  }

  /**
   * Get or create an engine instance
   */
  getEngine(engineName) {
    if (this.engines[engineName]) {
      return this.engines[engineName];
    }

    const s = this.settings;
    switch (engineName) {
      case 'google-free':
        this.engines[engineName] = new GoogleFreeEngine();
        break;
      case 'bing':
        this.engines[engineName] = new BingEngine();
        break;
      case 'deepl':
        this.engines[engineName] = new DeepLEngine(s.deeplKey, s.deeplUsePro, {
          formality: s.deeplFormality || 'default',
          maxContext: s.maxContextHistory || 3
        });
        break;
      case 'openai':
        this.engines[engineName] = new OpenAIEngine(s.openaiKey, {
          model: s.openaiModel || 'gpt-3.5-turbo',
          systemPrompt: s.systemPrompt || '',
          maxContext: s.maxContextHistory || 5
        });
        break;
      case 'local-llm':
        this.engines[engineName] = new LocalLLMEngine({
          endpoint: s.customEndpoint || 'http://localhost:1234/v1',
          model: s.customModel || 'local-model',
          systemPrompt: s.systemPrompt || '',
          maxContext: s.maxContextHistory || 5
        });
        break;
      case 'libretranslate':
        this.engines[engineName] = new LibreTranslateEngine({
          endpoint: s.libretranslateEndpoint || 'http://localhost:5000',
          apiKey: s.libretranslateKey || ''
        });
        break;
      case 'custom-mt':
        this.engines[engineName] = new CustomMTEngine({
          endpoint: s.customMTEndpoint || '',
          method: s.customMTMethod || 'POST',
          headers: s.customMTHeaders || {},
          bodyTemplate: s.customMTBody || '{"text":"{{text}}","source":"{{source}}","target":"{{target}}"}',
          responsePath: s.customMTResponsePath || 'data.translations.0.translatedText',
          authHeader: s.customMTAuthHeader || '',
          apiKey: s.customMTApiKey || ''
        });
        break;
      default:
        return null;
    }

    return this.engines[engineName];
  }

  /**
   * Main translation entry point.
   * Called when new text arrives from any input source.
   * Handles debounce, cache, glossary, retry, and fallback.
   */
  translate(text, options = {}) {
    // Cancel previous pending translation
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    // Reject previous pending promise to prevent memory leak
    if (this._pendingReject) {
      this._pendingReject(new Error('Translation superseded by new text'));
      this._pendingReject = null;
    }

    const src = options.source || this.settings.sourceLang || 'ja';
    const tgt = options.target || this.settings.targetLang || 'es';
    const engine = options.engine || this.settings.engine || 'google-free';

    // Debounce
    return new Promise((resolve, reject) => {
      this._pendingReject = reject;
      this.debounceTimer = setTimeout(async () => {
        this._pendingReject = null;
        try {
          const result = await this._doTranslate(text, src, tgt, engine);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, this.debounceMs);
    });
  }

  /**
   * Immediate translation (no debounce) - for manual/user-initiated requests
   */
  async translateNow(text, options = {}) {
    const src = options.source || this.settings.sourceLang || 'ja';
    const tgt = options.target || this.settings.targetLang || 'es';
    const engine = options.engine || this.settings.engine || 'google-free';
    return this._doTranslate(text, src, tgt, engine);
  }

  async _doTranslate(text, srcLang, tgtLang, engineName) {
    console.log(`[Pipeline] _doTranslate: srcLang=${srcLang}, tgtLang=${tgtLang}, engine=${engineName}`);

    // For LLM engines with auto-detect source, detect the language first
    // so we can pass it explicitly in the prompt (avoids ambiguity for small models)
    let effectiveSrcLang = srcLang;
    let detectedSourceLang = null;
    if (srcLang === 'auto') {
      detectedSourceLang = detectLanguageSimple(text);
      if (detectedSourceLang) {
        console.log(`[Pipeline] Auto-detected source language: ${detectedSourceLang} (${getLanguageName(detectedSourceLang)})`);
        // For LLM engines, use detected language explicitly in the prompt
        // For non-LLM engines, keep 'auto' and let them handle it
        if (LLM_ENGINES.includes(engineName)) {
          effectiveSrcLang = detectedSourceLang;
        }
      }
    }

    // 1. Apply glossary pre-processing
    const preprocessed = this.glossary.applyPreTranslation(text);

    // 2. Check engine-specific cache (exact engine match)
    const cached = this.cache.get(preprocessed, effectiveSrcLang, tgtLang, engineName);
    if (cached) {
      this.stats.cacheHits++;
      this._addToHistory(text, cached, engineName, true);

      // Still apply post-processing
      const postprocessed = this.glossary.applyPostTranslation(cached);

      this.emit('translation', {
        original: text,
        translated: postprocessed,
        engine: engineName,
        cached: true,
        sourceLang: srcLang,
        targetLang: tgtLang,
        timestamp: Date.now()
      });

      return postprocessed;
    }

    // 2b. v3.11.23: Translation Memory — check if this text was translated by ANY engine
    // before making a new API call. This saves money and reduces latency for repeated dialogue.
    const tmResult = this.translationMemory.get(preprocessed, effectiveSrcLang, tgtLang);
    if (tmResult) {
      this.stats.tmHits++;
      console.log(`[Pipeline] Translation Memory hit: "${preprocessed.substring(0, 30)}..." → "${tmResult.substring(0, 30)}..." (was: ${engineName})`);
      // Also store in engine-specific cache for faster future lookups
      this.cache.set(preprocessed, effectiveSrcLang, tgtLang, engineName, tmResult);
      this._addToHistory(text, tmResult, engineName, true);

      const postprocessed = this.glossary.applyPostTranslation(tmResult);

      this.emit('translation', {
        original: text,
        translated: postprocessed,
        engine: engineName,
        cached: true,
        fromMemory: true,
        sourceLang: srcLang,
        targetLang: tgtLang,
        timestamp: Date.now()
      });

      return postprocessed;
    }

    // 3. Rate limiting
    await this._enforceRateLimit();

    // 4. Translate with retry and fallback
    this._lastError = null;

    // Try primary engine
    const result = await this._tryEngine(engineName, preprocessed, effectiveSrcLang, tgtLang);
    if (result) {
      // Cache the result
      this.cache.set(preprocessed, effectiveSrcLang, tgtLang, engineName, result.text);
      // v3.11.23: Also store in Translation Memory (engine-agnostic) for cross-engine reuse
      this.translationMemory.set(preprocessed, effectiveSrcLang, tgtLang, result.text);
      this.stats.totalTranslations++;

      // Apply glossary post-processing
      const postprocessed = this.glossary.applyPostTranslation(result.text);

      this._addToHistory(text, postprocessed, engineName, false);

      // Use detected language from engine if available, otherwise our detection
      const finalDetectedLang = result.detectedLang || detectedSourceLang;

      this.emit('translation', {
        original: text,
        translated: postprocessed,
        engine: engineName,
        cached: false,
        detectedLang: finalDetectedLang,
        sourceLang: srcLang,
        targetLang: tgtLang,
        timestamp: Date.now()
      });

      return postprocessed;
    }

    // 5. Fallback chain
    const fallbacks = FALLBACK_CHAIN[engineName] || ['google-free'];
    for (const fallback of fallbacks) {
      const fallbackResult = await this._tryEngine(fallback, preprocessed, srcLang, tgtLang);
      if (fallbackResult) {
        this.stats.fallbacks++;
        this.cache.set(preprocessed, srcLang, tgtLang, fallback, fallbackResult.text);
        // v3.11.23: Also store in Translation Memory
        this.translationMemory.set(preprocessed, srcLang, tgtLang, fallbackResult.text);
        this.stats.totalTranslations++;

        const postprocessed = this.glossary.applyPostTranslation(fallbackResult.text);
        this._addToHistory(text, postprocessed, `${engineName}→${fallback}`, false);

        this.emit('translation', {
          original: text,
          translated: postprocessed,
          engine: `${engineName}→${fallback}`,
          cached: false,
          isFallback: true,
          sourceLang: srcLang,
          targetLang: tgtLang,
          timestamp: Date.now()
        });

        return postprocessed;
      }
    }

    // All engines failed
    this.stats.errors++;
    this.emit('error', {
      original: text,
      error: this._lastError?.message || 'All translation engines failed',
      engine: engineName,
      timestamp: Date.now()
    });

    return `[Error] Translation failed`;
  }

  async _tryEngine(engineName, text, srcLang, tgtLang, retries = 1) {
    const engine = this.getEngine(engineName);
    if (!engine) return null;

    console.log(`[Pipeline] _tryEngine: engine=${engineName}, srcLang=${srcLang} (${getLanguageName(srcLang)}), tgtLang=${tgtLang} (${getLanguageName(tgtLang)})`);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await engine.translate(text, {
          sourceLang: srcLang,
          targetLang: tgtLang,
          sourceLangName: getLanguageName(srcLang),
          targetLangName: getLanguageName(tgtLang)
        });
        return result;
      } catch (err) {
        this._lastError = err; // Track last actual error
        if (attempt < retries && this._isRetryable(err)) {
          // Exponential backoff
          const delay = Math.pow(2, attempt) * 500;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  _isRetryable(err) {
    if (!err) return false;
    const msg = err.message || '';
    const code = err.code || '';
    // Retry on network errors, rate limits, and timeouts
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      msg.includes('429') ||
      msg.includes('rate') ||
      msg.includes('timeout') ||
      msg.includes('network')
    );
  }

  async _enforceRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  _addToHistory(original, translated, engine, cached) {
    // v3.10.11: Skip if history is disabled (limit = 0)
    if (this.maxHistory === 0) return;
    this.history.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7),
      original,
      translated,
      engine,
      cached,
      timestamp: Date.now()
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }
  }

  getHistory() {
    return this.history;
  }

  clearHistory() {
    this.history = [];
  }

  /**
   * Replace all history entries (used by profile loading)
   */
  replaceHistory(newHistory) {
    this.history = Array.isArray(newHistory) ? newHistory.slice(0, this.maxHistory) : [];
  }

  getStats() {
    return { ...this.stats, cacheSize: this.cache.size(), tmSize: this.translationMemory.size() };
  }

  /**
   * Update settings and reinitialize engines as needed
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    console.log(`[Pipeline] updateSettings: targetLang=${this.settings.targetLang}, sourceLang=${this.settings.sourceLang}`);
    // Clear engine instances so they get re-initialized with new settings
    this.engines = {};
    // v3.10.11: Update maxHistory from historyLimit setting
    if (newSettings.historyLimit !== undefined) {
      const limit = parseInt(newSettings.historyLimit);
      if (limit > 0) {
        this.maxHistory = limit;
      } else if (limit === 0) {
        // 0 = disabled, no history stored
        this.maxHistory = 0;
      }
      // Trim existing history if new limit is smaller
      if (this.history.length > this.maxHistory && this.maxHistory > 0) {
        this.history = this.history.slice(0, this.maxHistory);
      } else if (this.maxHistory === 0) {
        this.history = [];
      }
    }
  }

  /**
   * Reset all engine instances (e.g., when switching API keys)
   */
  resetEngines() {
    this.engines = {};
  }
}

module.exports = TranslationPipeline;
