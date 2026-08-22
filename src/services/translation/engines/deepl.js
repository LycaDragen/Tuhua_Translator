/**
 * DeepL API Engine
 * Uses official DeepL API (Free or Pro).
 * Requires API key.
 *
 * Changelog:
 * v3.11.23: Added context, formality, preserve_formatting support.
 * v3.11.27: Improved error logging, auto-detect Free key (:fx suffix),
 *           better endpoint switching, log full error details.
 * v3.11.28: Fixed text parameter — must be array with JSON content-type.
 *           Added custom_instructions support (DeepL API v2 feature).
 *           Added style_id support (references pre-created style rules).
 *           Added translation_memory_id + translation_memory_threshold.
 *           Changed default formality from 'default' to 'prefer_more'
 *           (safer — won't error if language doesn't support formality).
 *           Better handling of features that may not be available on Free tier.
 * v3.11.29: Added default hidden instructions for VN translation.
 *           Only send custom_instructions when target language supports style_rules.
 *           Migrate removed formality options ('more'→'prefer_more', 'less'→'prefer_less').
 *           Removed strict formality options from engine logic.
 * v3.13.80: Fixed the 401/403 cross-endpoint retry skipping fixTermSpacing() —
 *           extracted _buildResult() so the main path and the retry can't
 *           diverge again. Removed the changelog line above that claimed
 *           tag_handling_version v2 support was added in v3.11.28 — grep
 *           confirms tag_handling was never actually sent; Tuhua doesn't
 *           translate XML/HTML-tagged content.
 */
const axios = require('axios');
const log = require('electron-log');
const { fixTermSpacing } = require('../glossary-prompt');

// Languages that support the style_rules feature (custom_instructions, style_id)
// Per DeepL docs: de, en, es, fr, it, ja, ko, zh and variants
const STYLE_RULES_LANGUAGES = new Set([
  'de', 'de-de', 'de-at', 'de-ch',
  'en', 'en-us', 'en-gb',
  'es', 'es-419',
  'fr', 'fr-ca',
  'it',
  'ja',
  'ko',
  'zh', 'zh-hans', 'zh-hant'
]);

// Languages that support formality
// Per DeepL docs: DE, FR, IT, ES, NL, PL, PT-BR, PT-PT, JA, RU
const FORMALITY_LANGUAGES = new Set([
  'de', 'de-de', 'de-at', 'de-ch',
  'es', 'es-419',
  'fr', 'fr-ca',
  'it',
  'ja',
  'nl',
  'pl',
  'pt', 'pt-br', 'pt-pt',
  'ru'
]);

// v3.11.29: Default hidden instructions for VN translation.
// Always in English — DeepL processes these as meta-directives, not text to translate.
// English gives the most precise interpretation per DeepL's documentation.
// These are sent when the user hasn't written any custom instructions.
const DEFAULT_INSTRUCTIONS = [
  'Keep Japanese honorifics and suffixes like -san, -chan, -sama, -kun unchanged',
  'Preserve character names and proper nouns in their original form',
  'Use natural conversational language appropriate for dialogue'
];

class DeepLEngine {
  constructor(apiKey, usePro = false, options = {}) {
    this.name = 'deepl';
    this.displayName = 'DeepL API';
    this.requiresKey = true;
    this.apiKey = apiKey;
    this.usePro = usePro || false;
    // v3.11.27: Auto-detect Free key by :fx suffix
    if (this.apiKey && this.apiKey.endsWith(':fx')) {
      this.usePro = false;
    }
    this.baseUrl = this.usePro
      ? 'https://api.deepl.com/v2'
      : 'https://api-free.deepl.com/v2';
    this.supportedLanguages = [
      'ja', 'en', 'es', 'ru', 'pt', 'fr', 'de', 'it', 'ko', 'zh', 'ar', 'nl', 'pl', 'uk'
    ];

    // v3.11.29: Migrate removed strict formality options
    let formality = options.formality || 'prefer_more';
    if (formality === 'more') formality = 'prefer_more';
    if (formality === 'less') formality = 'prefer_less';
    // v3.11.28: Changed default from 'default' to 'prefer_more'
    // 'prefer_more' is a soft preference — if the language doesn't support formality,
    // DeepL ignores it silently instead of returning an error.
    this.formality = formality;

    // v3.13.19: Context is no longer stored on the engine — it's owned by the
    // pipeline's ContextMemory and passed in via options.context on each call.
    // See context-memory.js for why (the old per-engine contextHistory never
    // received cache/TM hits, and nothing ever called clearContext()).

    // v3.11.28: Custom instructions — natural language directives
    // Up to 10 instructions, max 300 chars each.
    // Only works with target languages: de, en, es, fr, it, ja, ko, zh
    // v3.11.29: Empty array = use DEFAULT_INSTRUCTIONS (hidden defaults)
    this.customInstructions = options.customInstructions || [];

    // v3.11.28: Style ID — references a pre-created style rule list
    this.styleId = options.styleId || '';

    // v3.11.28: Translation Memory — server-side DeepL TM
    this.translationMemoryId = options.translationMemoryId || '';
    this.translationMemoryThreshold = options.translationMemoryThreshold || 75;

    // v3.13.6x (Fase 6): DeepL's next-gen model. Default matches what the
    // app was ALREADY silently forcing almost all the time — see below —
    // so this setting mostly just makes an existing behavior visible and
    // overridable, rather than changing it. 'prefer_quality_optimized' is
    // the soft-preference variant (falls back instead of erroring on a
    // pair/config that doesn't support it), same reasoning as `formality`
    // above using 'prefer_more' instead of a strict 'more'.
    this.modelType = options.modelType || 'prefer_quality_optimized';

    // v3.13.6x (Fase 6): DeepL's native glossary — resolved PER TRANSLATE
    // CALL via options.glossaryId (see translate() below), not fixed here
    // at construction time. A profile's effective glossary_id can change
    // between calls (profile switch, glossary edit triggering a resync),
    // and this engine instance is reused across the pipeline's lifetime —
    // same reasoning as options.context/options.glossary in llm-base.js.

    // v3.11.28: Feature cache from /v3/languages
    this._languageFeatures = null;
    this._languageFeaturesTimestamp = 0;

    const usingDefaults = this.customInstructions.length === 0;
    log.info(`[DeepL] Initialized: endpoint=${this.baseUrl}, hasKey=${!!this.apiKey}, keyType=${this.apiKey?.endsWith(':fx') ? 'Free' : 'Pro/Unknown'}, formality=${this.formality}, customInstructions=${this.customInstructions.length}${usingDefaults ? ' (using ' + DEFAULT_INSTRUCTIONS.length + ' defaults)' : ''}, styleId=${this.styleId || 'none'}`);
  }

  /**
   * v3.11.29: Get the effective instructions to send.
   * If user has custom instructions, use those.
   * If empty, use DEFAULT_INSTRUCTIONS (hidden VN-optimized defaults).
   * Only return instructions if the target language supports style_rules.
   */
  _getEffectiveInstructions(targetLang) {
    const langKey = targetLang.toLowerCase();

    // Only send custom_instructions if target language supports style_rules
    if (!STYLE_RULES_LANGUAGES.has(langKey)) {
      return [];
    }

    // User's custom instructions take priority
    if (this.customInstructions.length > 0) {
      return this.customInstructions
        .filter(inst => inst && inst.trim().length > 0 && inst.length <= 300)
        .slice(0, 10);
    }

    // Fall back to hidden default instructions
    return DEFAULT_INSTRUCTIONS;
  }

  /**
   * v3.11.28: Fetch language features from /v3/languages endpoint.
   * Cached for 1 hour. Used to dynamically show/hide UI options.
   */
  async fetchLanguageFeatures(forceRefresh = false) {
    const CACHE_DURATION = 3600000; // 1 hour
    const now = Date.now();
    if (!forceRefresh && this._languageFeatures && (now - this._languageFeaturesTimestamp) < CACHE_DURATION) {
      return this._languageFeatures;
    }

    try {
      const url = this.usePro
        ? 'https://api.deepl.com/v3/languages'
        : 'https://api-free.deepl.com/v3/languages';

      const response = await axios.get(url, {
        params: { resource: 'translate_text' },
        timeout: 8000,
        headers: { 'Authorization': `DeepL-Auth-Key ${this.apiKey}` }
      });

      if (response.data && Array.isArray(response.data)) {
        const features = {};
        for (const lang of response.data) {
          features[lang.lang.toLowerCase()] = lang.features || {};
        }
        this._languageFeatures = features;
        this._languageFeaturesTimestamp = now;
        log.info(`[DeepL] Fetched language features for ${Object.keys(features).length} languages`);
        return features;
      }
    } catch (err) {
      log.warn(`[DeepL] Failed to fetch /v3/languages: ${err.message} — using built-in feature data`);
    }

    // Fallback to built-in data if API call fails
    return null;
  }

  /**
   * v3.11.28: Check if a target language supports a specific feature.
   * Uses /v3/languages data if available, falls back to built-in sets.
   */
  async supportsFeature(targetLang, featureName) {
    const features = await this.fetchLanguageFeatures();
    const langKey = targetLang.toLowerCase();

    if (features && features[langKey]) {
      return featureName in features[langKey];
    }

    // Fallback to built-in data
    switch (featureName) {
      case 'formality':
        return FORMALITY_LANGUAGES.has(langKey);
      case 'style_rules':
        return STYLE_RULES_LANGUAGES.has(langKey);
      default:
        return false;
    }
  }

  /**
   * v3.11.28: Get all supported features for a language (sync, uses cache or built-in).
   * Returns { formality: bool, style_rules: bool } for UI toggling.
   */
  getLanguageFeaturesSync(targetLang) {
    const langKey = targetLang.toLowerCase();
    // Check cache first
    if (this._languageFeatures && this._languageFeatures[langKey]) {
      const f = this._languageFeatures[langKey];
      return {
        formality: 'formality' in f,
        style_rules: 'style_rules' in f,
        glossary: 'glossary' in f,
        tag_handling: 'tag_handling' in f
      };
    }
    // Fallback to built-in data
    return {
      formality: FORMALITY_LANGUAGES.has(langKey),
      style_rules: STYLE_RULES_LANGUAGES.has(langKey),
      glossary: true,  // Most languages support glossaries
      tag_handling: true  // Most languages support tag handling
    };
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es' } = options;
    log.info(`[DeepL] translate: sourceLang=${sourceLang}, targetLang=${targetLang}, text="${text.substring(0, 50)}..."`);

    if (!this.apiKey) {
      throw new Error('DeepL API key is required. Get one free at deepl.com/pro#developer');
    }

    // v3.11.28 fix: DeepL API with JSON content-type requires 'text' as an array.
    // Sending a plain string causes HTTP 400 "Value for 'text' not supported."
    const payload = {
      text: [text],
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
    // v3.13.19: context now comes from the pipeline's ContextMemory (already
    // capped to the configured window size), not a per-engine array.
    const contextWindow = options.context || [];
    if (contextWindow.length > 0) {
      // DeepL doesn't publish a character limit for `context` itself (the only
      // documented ceiling is the request body's 128 KiB), so 2000 here is a
      // self-imposed cap, not a DeepL requirement.
      const MAX_CONTEXT_CHARS = 2000;
      // v3.13.55 bugfix: this used to build the full joined string and discard
      // it ENTIRELY if it exceeded 2000 chars — with a large context window
      // (the UI slider goes to 20) DeepL would silently get no context at all.
      // Now we keep as many of the most RECENT lines as fit, dropping the
      // oldest ones first — contextWindow is oldest-first (see
      // context-memory.js), so we walk it backwards.
      const kept = [];
      let total = 0;
      for (let i = contextWindow.length - 1; i >= 0; i--) {
        const line = contextWindow[i].source;
        const addedLen = line.length + (kept.length > 0 ? 1 : 0); // +1 for the join newline
        if (total + addedLen > MAX_CONTEXT_CHARS) break;
        kept.unshift(line);
        total += addedLen;
      }
      if (kept.length > 0) {
        // v3.13.6x (Fase 6): joined with '\n', not ' ' — these are
        // separate prior LINES of dialogue, not fragments of one
        // continuous sentence. A space join ran them together as if
        // "Line one Line two" were one sentence; DeepL's own docs
        // describe `context` as surrounding text, which a newline
        // represents more faithfully for line-based VN dialogue.
        payload.context = kept.join('\n');
      }
    }

    // v3.11.28: Formality — use 'prefer_more'/'prefer_less' for soft preference
    // instead of 'more'/'less' which cause errors on unsupported language pairs.
    // v3.11.29: 'more'/''less' removed from UI, but still migrated here for safety.
    if (this.formality && this.formality !== 'default') {
      payload.formality = this.formality;
    }

    // v3.11.23: Preserve formatting
    payload.preserve_formatting = true;

    // v3.11.29: Custom instructions — uses effective instructions (defaults or user's).
    // Only sent if target language supports style_rules.
    // Forces quality_optimized model (cannot combine with latency_optimized).
    const effectiveInstructions = this._getEffectiveInstructions(targetLang);
    if (effectiveInstructions.length > 0) {
      payload.custom_instructions = effectiveInstructions;
    }

    // v3.11.28: Style ID — references a pre-created style rule list
    if (this.styleId) {
      payload.style_id = this.styleId;
    }

    // v3.11.28: Translation Memory — server-side DeepL TM
    if (this.translationMemoryId) {
      payload.translation_memory_id = this.translationMemoryId;
      if (this.translationMemoryThreshold) {
        payload.translation_memory_threshold = this.translationMemoryThreshold;
      }
    }

    // v3.13.6x (Fase 6): only sent when non-default, so a Free-tier account
    // (or any pair that doesn't support next-gen models) never sees a field
    // it might reject — 'prefer_quality_optimized' already matches DeepL's
    // own default when unset, so omitting it changes nothing observable.
    if (this.modelType && this.modelType !== 'prefer_quality_optimized') {
      payload.model_type = this.modelType;
    }

    // v3.13.6x (Fase 6): resolved by the pipeline (manual profile.deeplGlossaryId,
    // or the auto-synced one from deepl-glossary-sync.js) and passed per call
    // — see the constructor's comment for why this isn't fixed at construction.
    if (options.glossaryId) {
      payload.glossary_id = options.glossaryId;
    }

    try {
      const response = await this._makeRequest(payload);
      const result = this._buildResult(response.data, options);
      log.info(`[DeepL] Success: "${text.substring(0, 30)}..." → "${result.text.substring(0, 30)}..."`);
      return result;
    } catch (err) {
      // v3.11.27: Log the full error for diagnosis
      const status = err.response?.status;
      const errData = err.response?.data;
      log.error(`[DeepL] Request failed on ${this.baseUrl}: HTTP ${status || 'N/A'}, data=${JSON.stringify(errData)?.substring(0, 200)}, message=${err.message}`);

      // If we get 401/403 on the configured endpoint, try the other one
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        const altUrl = this.baseUrl === 'https://api.deepl.com/v2'
          ? 'https://api-free.deepl.com/v2'
          : 'https://api.deepl.com/v2';

        log.info(`[DeepL] Got ${err.response.status} on ${this.baseUrl}, trying ${altUrl}`);

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

          this.baseUrl = altUrl;
          log.info(`[DeepL] Switched to ${altUrl} — future requests will use this endpoint`);

          // v3.13.80 bugfix: this used to reconstruct the result inline with
          // the raw data.translations[0].text, skipping the fixTermSpacing()
          // call the main path applies below — a "keep unchanged" glossary
          // term lost its spacing fix ("a la桜花学園") whenever the request
          // happened to fall through this retry. Routed through the same
          // _buildResult() helper as the main path so the two can't diverge
          // again.
          return this._buildResult(response.data, options);
        } catch (altErr) {
          const altStatus = altErr.response?.status;
          const altErrData = altErr.response?.data;
          log.error(`[DeepL] Alternate endpoint ${altUrl} also failed: HTTP ${altStatus || 'N/A'}, data=${JSON.stringify(altErrData)?.substring(0, 200)}`);
          throw err;
        }
      }
      throw err;
    }
  }

  /**
   * v3.13.80: Turns a raw /translate response into the engine's result
   * shape, applying the glossary spacing fix. Extracted so the main
   * request path and the 401/403 cross-endpoint retry (translate(), above)
   * can't drift apart again — see the retry's call site for the bug this
   * fixed.
   */
  _buildResult(data, options) {
    if (!data.translations || !data.translations[0]) {
      throw new Error('Unexpected DeepL response format');
    }
    let resultText = data.translations[0].text;
    // v3.13.6x (Fase 6): verified against a real DeepL glossary_id call
    // — a "keep unchanged" (source===target) term survives correctly
    // but DeepL's own server-side glossary application doesn't
    // reliably insert the space its own boundary needs ("a la桜花学園"
    // instead of "a la 桜花学園"), the identical artifact
    // maskKeepUnchanged's restore() fixes for the LLM path. DeepL
    // applies its glossary server-side with no placeholder step Tuhua
    // controls, so this scans the OUTPUT for the known keep-unchanged
    // terms instead. Only entries the request actually SENT a
    // glossary for are candidates — options.keepUnchangedTerms is
    // populated by the pipeline from the same effective glossary the
    // resolved glossary_id was built from.
    if (options.glossaryId && Array.isArray(options.keepUnchangedTerms) && options.keepUnchangedTerms.length) {
      resultText = fixTermSpacing(resultText, options.keepUnchangedTerms);
    }
    return {
      text: resultText,
      detectedLang: data.translations[0].detected_source_language?.toLowerCase() || null,
      engine: this.name
    };
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
    if (key && key.endsWith(':fx')) {
      this.usePro = false;
      this.baseUrl = 'https://api-free.deepl.com/v2';
    }
    // Clear language features cache when key changes
    this._languageFeatures = null;
  }

  setUsePro(usePro) {
    this.usePro = usePro;
    this.baseUrl = usePro
      ? 'https://api.deepl.com/v2'
      : 'https://api-free.deepl.com/v2';
    // Clear language features cache when endpoint changes
    this._languageFeatures = null;
  }

  setFormality(formality) {
    // v3.11.29: Migrate removed strict options to soft preferences
    if (formality === 'more') formality = 'prefer_more';
    if (formality === 'less') formality = 'prefer_less';
    // v3.13.80: fallback changed prefer_more -> default, on Lyca's explicit
    // request. A blank/unconfigured profile (deeplFormality === '' — see
    // profile-schema.js's createProfile()) now behaves as DeepL's own
    // neutral default instead of silently opinionated formal/usted — VN
    // dialogue is often casual between characters, so defaulting to formal
    // was actively wrong for the common case, not just an arbitrary choice.
    this.formality = formality || 'default';
  }

  // v3.11.28: Set custom instructions
  setCustomInstructions(instructions) {
    if (!Array.isArray(instructions)) {
      this.customInstructions = [];
      return;
    }
    // Filter and validate: max 10, max 300 chars each
    this.customInstructions = instructions
      .filter(inst => inst && typeof inst === 'string' && inst.trim().length > 0)
      .map(inst => inst.substring(0, 300))
      .slice(0, 10);
  }

  // v3.11.28: Set style ID
  setStyleId(styleId) {
    this.styleId = styleId || '';
  }

  // v3.11.28: Set translation memory
  setTranslationMemory(id, threshold) {
    this.translationMemoryId = id || '';
    this.translationMemoryThreshold = threshold || 75;
  }

  // v3.13.6x (Fase 6): Set DeepL's next-gen model preference
  setModelType(modelType) {
    this.modelType = modelType || 'prefer_quality_optimized';
  }

}

// Export the feature sets and default instructions for use by the UI (pipeline/renderer)
DeepLEngine.FORMALITY_LANGUAGES = FORMALITY_LANGUAGES;
DeepLEngine.STYLE_RULES_LANGUAGES = STYLE_RULES_LANGUAGES;
DeepLEngine.DEFAULT_INSTRUCTIONS = DEFAULT_INSTRUCTIONS;

module.exports = DeepLEngine;
