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
  'lzh': 'Classical Chinese', 'ko': 'Korean', 'ru': 'Russian', 'pt': 'Portuguese', 'fr': 'French',
  'de': 'German', 'it': 'Italian', 'ar': 'Arabic', 'th': 'Thai',
  'vi': 'Vietnamese', 'id': 'Indonesian', 'tr': 'Turkish', 'nl': 'Dutch',
  'pl': 'Polish', 'uk': 'Ukrainian', 'hi': 'Hindi'
};

// v3.13.10: Normalize language codes from translation APIs.
// Some engines return non-standard codes (e.g., Google returns 'izh' for Izhorian
// when it misidentifies Korean, or 'zh-CN' instead of 'zh'). Map these to our
// standard codes to prevent unknown languages from appearing in the UI.
const LANG_CODE_NORMALIZE = {
  'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh',
  'zh-CHS': 'zh', 'zh-CHT': 'zh',
  'jpn': 'ja', 'jp': 'ja',
  'kor': 'ko', 'kr': 'ko', 'ko-kr': 'ko',
  'eng': 'en', 'en-us': 'en', 'en-gb': 'en',
  'esp': 'es', 'es-419': 'es',
  'por': 'pt', 'pt-br': 'pt', 'pt-pt': 'pt',
  'fra': 'fr', 'fr-ca': 'fr',
  'deu': 'de', 'de-de': 'de', 'de-at': 'de', 'de-ch': 'de',
  'ita': 'it',
  'rus': 'ru',
  'ara': 'ar',
  'tha': 'th',
  'vie': 'vi',
  'ind': 'id',
  'tur': 'tr',
  'nld': 'nl',
  'pol': 'pl',
  'ukr': 'uk',
  'hin': 'hi',
  // v3.13.10: Google Translate sometimes returns 'izh' (Izhorian) when
  // it misidentifies Korean text. Map it to 'ko' since this is the most
  // likely intended language in a VN/translation context.
  'izh': 'ko',
  // Other rare codes that might appear
  'chr': 'en',  // Cherokee → English fallback
  'haw': 'en',  // Hawaiian → English fallback
};

function normalizeLangCode(code) {
  if (!code) return code;
  const lower = code.toLowerCase();
  return LANG_CODE_NORMALIZE[lower] || (LANGUAGE_NAMES[lower] ? lower : null);
}

function getLanguageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

// Engines that are LLM-based and need explicit source language in prompt
const LLM_ENGINES = ['openai', 'local-llm'];

// Simple character-based language detection for CJK and common scripts
// v3.13.04: Improved Japanese detection for kanji-only text.
//   When PaddleOCR produces text that is purely kanji (no kana), it's often
//   Japanese text read through the Chinese model (which strips kana readings).
//   We now use several heuristics to distinguish:
//   - Japan-specific kanji (shintaiji / 設定 図書館 駅 etc.)
//   - Japanese punctuation (。、「」・etc.)
//   - If sourceLang was set to 'ja' by the user, trust it
// v3.13.07: Changed default for kanji-only text from 'zh' to 'ja'.
//   In a VN/game translation context, Japanese is far more common than
//   Chinese. The 'zh' default caused Japanese kanji-only text to be
//   misidentified and produce wrong translations via DeepL. Users who
//   need Chinese should set sourceLang='zh' explicitly. Also expanded
//   the Japan-specific kanji/compound set with game/VN vocabulary.
function detectLanguageSimple(text) {
  if (!text || text.length === 0) return null;

  // Count character types
  let hiragana = 0, katakana = 0, kanji = 0, cyrillic = 0, hangul = 0;
  let jpPunctuation = 0; // v3.13.04: Japanese-specific punctuation count

  // v3.13.06: Expanded set of kanji/compounds that are much more common in
  // Japanese than Chinese. These are shinjitai (new character forms),
  // Japan-specific simplified forms, or compound words that only exist in
  // Japanese. Multi-character strings work because we check with includes().
  const jpSpecificKanji = new Set([
    // Shinjitai / Japan-specific simplified forms
    '桜', '渋', '円', '駅', '広', '庫', '舎', '脳', '践', '険',
    '検', '称', '産', '観', '豊', '賛', '区', '団', '協', '単',
    '学', '強', '営', '場', '報', '圧', '専', '覚', '導', '層',
    '権', '済', '聴', '認', '証', '職', '辞', '写', '恵', '恵',
    '変', '恥', '誰', '何', '私', '僕', '俺', '彼', '彼女', '夫',
    // Common Japanese compound words (game UI / VN dialogue)
    '設定', '図書', '図書館', '移動', '確認', '選択', '保存', '終了',
    '会話', '冒険', '魔法', '仲間', '敵', '味方', '戦闘', '探索',
    '道具', '装備', '技', 'スキル', '宝箱', '村', '城', '森',
    '神社', '寺院', '宿屋', '商店', '酒場', '門', '庭', '廊下',
    '階段', '屋上', '地下', '研究室', '教室', '廊下', '部活',
    '放課後', '夏休み', '文化祭', '体育祭', '修学旅行',
    // Japanese-specific katakana-heavy terms
    'ホ', 'メ', 'ル', 'ダ', 'ン', 'ス', 'ト', 'ッ', 'プ',
    // v3.13.07: Expanded game/VN-specific vocabulary for better JP detection
    '主人公', '仲間', '冒険', '戦闘', '魔法', '技能', '経験', '回復',
    '攻撃', '防御', '逃走', '道具', '装備', '武器', '防具', '飾',
    '金貨', 'HP', 'MP', '能力', '状態', '毒', '麻痺', '睡眠',
    '石化', '混乱', '沈黙', '暗闇', '即死', '吸収', '反射',
    '勝利', '敗北', '退却', '全滅', '復活', '召喚', '進化',
    '恋人', '親友', '幼馴染', '先輩', '後輩', '同級生',
    '約束', '守護', '絆', '勇者', '魔王', '姫', '騎士',
    '侍', '忍者', '巫女', '僧侶', '盗賊', '賢者', '商人',
    '宿', '酒場', '教会', '塔', '洞窟', '遺跡', '砦', '要塞',
    '祭', '儀式', '試練', '修行', '悟', '魂', '運命', '宿命',
    '想像', '現実', '真実', '嘘', '秘密', '約束', '信頼', '裏切',
    '昨日', '今日', '明日', '毎日', '今', '昔', '未来', '永遠',
    '悲', '喜', '怒', '楽', '寂', '懐', '恋', '愛',
    // Common single kanji that are distinctly Japanese in game context
    '覚', '察', '承', '拒', '認', '得', '失', '続',
    '断', '了', '申', '届', '替', '換', '据', '据',
    '演', '奏', '詠', '唱', '舞', '闘', '襲', '撃'
  ]);

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
    // v3.13.04: Japanese-specific punctuation
    // 。(U+3002) 、(U+3001) 「」(U+300C-U+300F) ・(U+30FB) 〜(U+301C)
    else if (code === 0x3002 || code === 0x3001 ||
             (code >= 0x300C && code <= 0x300F) ||
             code === 0x30FB || code === 0x301C) jpPunctuation++;
  }

  // Japanese: has hiragana or katakana (definitive)
  if (hiragana > 0 || katakana > 0) return 'ja';
  // Korean: has hangul
  if (hangul > 0) return 'ko';
  // Russian: has cyrillic
  if (cyrillic > 2) return 'ru';

  // v3.13.06: Kanji-only text — try to distinguish Japanese from Chinese
  if (kanji > 0 && hiragana === 0 && katakana === 0 && hangul === 0) {
    // Heuristic 1: Japanese punctuation strongly suggests Japanese
    if (jpPunctuation > 0) return 'ja';

    // Heuristic 2: Check for Japan-specific kanji (including compound words)
    let jpKanjiHits = 0;
    for (const item of jpSpecificKanji) {
      if (text.includes(item)) jpKanjiHits++;
    }
    // v3.13.06: If ANY Japan-specific kanji/compound is found, assume Japanese.
    // In a VN/game translation context, Japanese text without kana is FAR more
    // common than Chinese text without kana. The old ratio threshold (10%)
    // was too conservative for short text.
    if (jpKanjiHits > 0) return 'ja';

    // Heuristic 3: For short kanji-only text (1-4 chars), default to Japanese.
    // Single/double kanji like 設定, 移動, 終了 are extremely common in Japanese
    // game UI and unlikely to be Chinese in this tool's context.
    if (kanji <= 4 && kanji >= 1) return 'ja';

    // v3.13.07: For longer kanji-only text without Japanese markers,
    // default to Japanese instead of Chinese. In a VN/game translation
    // context, Japanese text without kana is far more common than Chinese
    // text without kana. The previous default of 'zh' caused too many
    // Japanese texts to be sent to DeepL as Chinese, producing wrong
    // translations. If the user is actually translating Chinese, they
    // should set sourceLang='zh' explicitly.
    return 'ja';
  }

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
          formality: s.deeplFormality || 'prefer_more',
          maxContext: s.maxContextHistory || 3,
          // v3.11.28: New DeepL features
          customInstructions: s.deeplCustomInstructions || [],
          styleId: s.deeplStyleId || '',
          translationMemoryId: s.deeplTranslationMemoryId || '',
          translationMemoryThreshold: s.deeplTranslationMemoryThreshold || 75
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

    // v3.13.04: For ALL engines (not just LLM), use detected language when
    // auto-detect is selected. This is critical because:
    // - DeepL often misdetects kanji-only text as Chinese instead of Japanese
    // - PaddleOCR's Chinese model can read Japanese kanji but loses kana context
    // - Our detectLanguageSimple() with JP-specific heuristics is more accurate
    //   than DeepL's API-level auto-detect for CJK text
    // v3.13.05: When the user explicitly selects 'ja' or 'ko' as source language,
    //   ALWAYS use that — don't let auto-detection override the user's choice.
    //   This prevents the pipeline from switching to 'zh' for kanji-only Japanese
    //   text that our heuristics can't reliably distinguish from Chinese.
    // v3.13.08-fix: When sourceLang is 'lzh' (Classical Chinese), ALWAYS use 'zh'
    //   as the effective source for translation engines. Most engines don't support
    //   'lzh' natively, but they handle classical Chinese text correctly when told
    //   it's Chinese. The detectLanguageSimple() function would misidentify
    //   classical Chinese as Japanese (all kanji, no kana), producing wrong translations.
    let effectiveSrcLang = srcLang;
    let detectedSourceLang = null;

    // v3.13.08-fix: Classical Chinese — use 'zh' directly, skip auto-detection
    if (srcLang === 'lzh') {
      effectiveSrcLang = 'zh';
      console.log(`[Pipeline] Classical Chinese (lzh) → using 'zh' as effective source language`);
    } else if (srcLang === 'auto') {
      detectedSourceLang = detectLanguageSimple(text);
      if (detectedSourceLang) {
        console.log(`[Pipeline] Auto-detected source language: ${detectedSourceLang} (${getLanguageName(detectedSourceLang)})`);
        // v3.13.04: Use detected language for ALL engines, not just LLM.
        effectiveSrcLang = detectedSourceLang;
      } else {
        // v3.13.07: When detectLanguageSimple() returns null (can't determine),
        // don't pass 'auto' to translation engines — most don't support it well.
        // Default to 'ja' since this tool is primarily used for Japanese VNs/games.
        console.log(`[Pipeline] Could not auto-detect language, defaulting to Japanese`);
        effectiveSrcLang = 'ja';
      }
    } else {
      // v3.13.10: Normalize source language code (e.g., 'KR' → 'ko', 'jpn' → 'ja')
      const normalizedSrc = normalizeLangCode(srcLang);
      if (normalizedSrc && normalizedSrc !== srcLang) {
        console.log(`[Pipeline] Normalized source language: ${srcLang} → ${normalizedSrc}`);
        effectiveSrcLang = normalizedSrc;
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

    // 2b. v3.11.25: Translation Memory — exact match first, then fuzzy.
    // This saves money and reduces latency for repeated or near-matching dialogue.
    const tmResult = this.translationMemory.getWithFuzzy(preprocessed, effectiveSrcLang, tgtLang);
    if (tmResult) {
      this.stats.tmHits++;
      const matchType = tmResult.fuzzy ? 'fuzzy' : 'exact';
      const scoreInfo = tmResult.fuzzy ? ` (${(tmResult.score * 100).toFixed(0)}%)` : '';
      console.log(`[Pipeline] Translation Memory ${matchType} hit${scoreInfo}: "${preprocessed.substring(0, 30)}..." → "${tmResult.translation.substring(0, 30)}..." (was: ${engineName})`);
      // Also store in engine-specific cache for faster future lookups
      this.cache.set(preprocessed, effectiveSrcLang, tgtLang, engineName, tmResult.translation);
      this._addToHistory(text, tmResult.translation, engineName, true);

      const postprocessed = this.glossary.applyPostTranslation(tmResult.translation);

      this.emit('translation', {
        original: text,
        translated: postprocessed,
        engine: engineName,
        cached: true,
        fromMemory: true,
        fuzzyMatch: tmResult.fuzzy || false,
        fuzzyScore: tmResult.score || null,
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
      // v3.13.10: Normalize API-returned language codes (e.g., 'izh' → 'ko')
      const rawDetectedLang = result.detectedLang || detectedSourceLang;
      const finalDetectedLang = normalizeLangCode(rawDetectedLang) || rawDetectedLang;

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
        // v3.11.27: Log the actual error so we can diagnose engine failures
        const status = err.response?.status;
        const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
        const statusInfo = status ? ` (HTTP ${status})` : '';
        console.error(`[Pipeline] ${engineName} failed${statusInfo}: ${errMsg}`);
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
