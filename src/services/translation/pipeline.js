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
const ContextMemory = require('./context-memory');

// Engine imports
const GoogleFreeEngine = require('./engines/google-free');
const BingEngine = require('./engines/bing');
const DeepLEngine = require('./engines/deepl');
const OpenAIEngine = require('./engines/openai');
const LocalLLMEngine = require('./engines/local-llm');
const LibreTranslateEngine = require('./engines/libretranslate');
const CustomMTEngine = require('./engines/custom-mt');
const { resolveLocalEndpoint } = require('./llm-providers');

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

// v3.13.23: Used when detectLanguageSimple() can't positively identify a script
// (returns null) to decide the fallback default. Same Unicode ranges as the
// hiragana/katakana/kanji/cyrillic/hangul counters above — if none of those
// appear anywhere in the text, it's pure Latin/ASCII and defaulting to 'ja'
// (the historical fallback for VN/game text) is actively wrong.
function hasNonLatinScript(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3040 && code <= 0x309F) return true; // Hiragana
    if (code >= 0x30A0 && code <= 0x30FF) return true; // Katakana
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) return true; // CJK
    if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) return true; // Cyrillic
    if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)) return true; // Hangul
  }
  return false;
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
  // v3.13.40 (profiles Phase 1, step 2): `glossary` is injected rather than
  // constructed here. Previously this class built its own GlossaryService
  // over the same glossary.json that src/main/index.js also opens a
  // separate instance of — two objects backed by one file, kept in sync
  // only by electron-store re-reading the file per access. Collapsing to
  // one shared instance is what makes setProfileLayer()/getEffective()
  // meaningful: a profile switch calls setProfileLayer() on the instance
  // index.js owns, and this pipeline sees it because there is only one.
  // `glossary || new GlossaryService()` keeps direct construction (existing
  // benches, XUatServer tests) working without an injected instance.
  constructor(settings = {}, { glossary } = {}) {
    super();
    this.settings = settings;
    this.cache = new TranslationCache({ maxSize: 5000 });
    // v3.11.23: Translation Memory — engine-agnostic persistent store
    this.translationMemory = new TranslationMemory({ maxSize: 10000, enabled: settings.enableTranslationMemory !== false });
    this.glossary = glossary || new GlossaryService();
    // v3.13.19: Context Memory — owned here, not per-engine (see context-memory.js).
    // `!== undefined` matters: `settings.maxContextHistory || 5` would silently turn
    // an explicit 0 (disable context) back into 5, since 0 is falsy in JS.
    this.contextMemory = new ContextMemory(
      settings.maxContextHistory !== undefined ? parseInt(settings.maxContextHistory) : 5
    );

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
          // v3.11.28: New DeepL features
          customInstructions: s.deeplCustomInstructions || [],
          styleId: s.deeplStyleId || '',
          translationMemoryId: s.deeplTranslationMemoryId || '',
          translationMemoryThreshold: s.deeplTranslationMemoryThreshold || 75
        });
        break;
      case 'openai': {
        // v3.13.58 (Fase 3): `engine:'openai'` now means "cloud LLM,
        // provider selected by s.llmProvider" — see openai.js's header
        // comment for why the engine id/class/file name stay as-is rather
        // than getting renamed. `s.openaiKey` is no longer read here (see
        // llm-providers.js's seedProviderKeysFromLegacyOpenAIKey and its
        // one-time call site in src/main/index.js) — the key comes from
        // the provider-keyed map instead, so switching providers doesn't
        // require re-entering a key that was really for a different one.
        const providerId = s.llmProvider || 'openai';
        const providerKey = (s.llmProviderKeys && s.llmProviderKeys[providerId]) || '';
        this.engines[engineName] = new OpenAIEngine(providerKey, {
          providerId,
          // v3.13.58: renamed from the old (dead — see renderer.js's
          // gatherConfig, which just hardcoded it to 'gpt-3.5-turbo' on
          // every save, never displayed or user-edited) `openaiModel` to
          // `llmModel`, since it now covers whichever cloud provider is
          // selected, not just OpenAI specifically.
          model: s.llmModel || '',
          // Only meaningful for providerId==='custom' (see openai.js on
          // why an unset custom baseUrl must NOT fall back to a real
          // provider's URL); ignored otherwise since options.baseUrl only
          // wins when non-empty.
          baseUrl: providerId === 'custom' ? (s.llmCustomBaseUrl || '') : undefined,
          systemPrompt: s.systemPrompt || '',
          temperature: s.llmTemperature,
          maxTokens: s.llmMaxTokens,
          topP: s.llmTopP,
          // v3.13.57 (Fase 2): rollback interruptor for the output
          // sanitizer — defaults on.
          sanitize: s.llmSanitize !== false
        });
        break;
      }
      case 'local-llm': {
        // v3.13.58 (Fase 3): s.localLlmEndpointPreset lets the UI offer a
        // dropdown (Ollama/LM Studio/llama.cpp/KoboldCpp) instead of
        // requiring the user to remember a port — resolveLocalEndpoint()
        // falls back to the pre-existing customEndpoint setting when no
        // preset (or 'custom') is selected, so an install upgrading from
        // before this version keeps working unchanged.
        const endpoint = resolveLocalEndpoint(s.localLlmEndpointPreset, s.customEndpoint) || 'http://localhost:1234/v1';
        this.engines[engineName] = new LocalLLMEngine({
          endpoint,
          model: s.customModel || 'local-model',
          systemPrompt: s.systemPrompt || '',
          temperature: s.llmTemperature,
          maxTokens: s.llmMaxTokens,
          topP: s.llmTopP,
          sanitize: s.llmSanitize !== false
        });
        break;
      }
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
    // Reject previous pending promise to prevent memory leak.
    // v3.13.55: tagged with a `code` so callers (see ipc-handlers.js _handleText)
    // can tell "debounce superseded this" apart from a real translation failure
    // instead of both landing in the same catch and painting `[Error] ...` text
    // over the overlay for what is actually expected, routine behavior.
    if (this._pendingReject) {
      const supersededError = new Error('Translation superseded by new text');
      supersededError.code = 'SUPERSEDED';
      this._pendingReject(supersededError);
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
      } else if (hasNonLatinScript(text)) {
        // v3.13.07: When detectLanguageSimple() returns null (can't determine)
        // but the text does contain some non-Latin script (ambiguous/mixed
        // text that still didn't hit a positive branch above), don't pass
        // 'auto' to translation engines — most don't support it well.
        // Default to 'ja' since this tool is primarily used for Japanese VNs/games.
        console.log(`[Pipeline] Could not auto-detect language, defaulting to Japanese`);
        effectiveSrcLang = 'ja';
      } else {
        // v3.13.23: Pure Latin/ASCII text with no CJK/Cyrillic/Hangul at all —
        // defaulting to 'ja' here was objectively wrong (confirmed in real
        // Textractor+KiriKiriZ testing: DeepL rescued the wrong hint
        // server-side, but the hint itself was still incorrect, which is
        // inefficient and risks worse results on engines that don't tolerate
        // a wrong source-language hint as well as DeepL does).
        console.log(`[Pipeline] Could not auto-detect language, no CJK/Cyrillic/Hangul found — defaulting to English`);
        effectiveSrcLang = 'en';
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

      // v3.13.19: Push BEFORE returning — this is the fix for Bug A. The old
      // per-engine contextHistory only got pushed inside engine.translate(),
      // which a cache hit never calls, so repeated lines silently vanished
      // from the context window. Order matters here: push first, return
      // second — swapping them reintroduces the exact bug this line fixes.
      this.contextMemory.push(preprocessed, cached);

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

      // v3.13.19: Same fix as the cache-hit branch above — push before return.
      this.contextMemory.push(preprocessed, tmResult.translation);

      return postprocessed;
    }

    // 3. Rate limiting is now enforced inside _tryEngine (once per attempt/fallback,
    // not just once here) — see v3.13.55 note there.

    // 4. Translate with retry and fallback
    this._lastError = null;

    // Try primary engine
    const result = await this._tryEngine(engineName, preprocessed, effectiveSrcLang, tgtLang);
    if (result) {
      // v3.13.57: a response the sanitizer flagged as cut off by
      // max_tokens (llm-output.js verdict:'truncated') is still shown to
      // the user (better than nothing), but must not poison the cache,
      // the Translation Memory, or the context window — a truncated
      // fragment is not what a full retranslation should return, and it's
      // exactly the kind of thing that used to get cached for 24h as if
      // it were a real translation. `!result.truncated` guards all three.
      if (!result.truncated) {
        this.cache.set(preprocessed, effectiveSrcLang, tgtLang, engineName, result.text);
        // v3.11.23: Also store in Translation Memory (engine-agnostic) for cross-engine reuse
        this.translationMemory.set(preprocessed, effectiveSrcLang, tgtLang, result.text);
      }
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
        truncated: !!result.truncated,
        sourceLang: srcLang,
        targetLang: tgtLang,
        timestamp: Date.now()
      });

      if (!result.truncated) {
        this.contextMemory.push(preprocessed, result.text);
      }

      return postprocessed;
    }

    // 5. Fallback chain
    // v3.13.55 bugfix: this used to pass the raw `srcLang` ('auto', 'lzh') instead
    // of `effectiveSrcLang` (the resolved/detected code used everywhere above,
    // :530-532). A fallback triggered with sourceLang='auto' cached under a
    // different key than the primary engine's attempt, so its result was never
    // reused by the normal cache/TM lookup path, and poisoned the (TTL-less)
    // Translation Memory with the literal string 'auto' as a language code.
    // v3.13.55: every engine declares `supportedLanguages` but nothing read it
    // before this — a fallback engine that doesn't support tgtLang was still
    // tried and, unsurprisingly, failed. Skip fallbacks we already know can't
    // work; still permissive (keep the candidate) if the list is missing/empty.
    const fallbacks = (FALLBACK_CHAIN[engineName] || ['google-free']).filter((name) => {
      const fallbackEngine = this.getEngine(name);
      if (!fallbackEngine || !Array.isArray(fallbackEngine.supportedLanguages) || fallbackEngine.supportedLanguages.length === 0) {
        return true;
      }
      return fallbackEngine.supportedLanguages.includes(tgtLang);
    });
    for (const fallback of fallbacks) {
      const fallbackResult = await this._tryEngine(fallback, preprocessed, effectiveSrcLang, tgtLang);
      if (fallbackResult) {
        this.stats.fallbacks++;
        // v3.13.57: same guard as the primary-engine branch above — a
        // fallback could itself be an LLM engine in a future FALLBACK_CHAIN
        // configuration, so this stays correct even though today's chains
        // only fall back to non-LLM engines that never set `truncated`.
        if (!fallbackResult.truncated) {
          this.cache.set(preprocessed, effectiveSrcLang, tgtLang, fallback, fallbackResult.text);
          // v3.11.23: Also store in Translation Memory
          this.translationMemory.set(preprocessed, effectiveSrcLang, tgtLang, fallbackResult.text);
        }
        this.stats.totalTranslations++;

        const postprocessed = this.glossary.applyPostTranslation(fallbackResult.text);
        this._addToHistory(text, postprocessed, `${engineName}→${fallback}`, false);

        this.emit('translation', {
          original: text,
          translated: postprocessed,
          engine: `${engineName}→${fallback}`,
          cached: false,
          isFallback: true,
          truncated: !!fallbackResult.truncated,
          sourceLang: srcLang,
          targetLang: tgtLang,
          timestamp: Date.now()
        });

        if (!fallbackResult.truncated) {
          this.contextMemory.push(preprocessed, fallbackResult.text);
        }

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
      // v3.13.55: rate limiting used to be enforced once in _doTranslate, before
      // the primary engine's *first* attempt only — so a retry or a fallback
      // engine call could fire back-to-back with no spacing at all. Enforcing it
      // here means every attempt (primary retries AND fallback engines) is spaced.
      await this._enforceRateLimit();
      try {
        const result = await engine.translate(text, {
          sourceLang: srcLang,
          targetLang: tgtLang,
          sourceLangName: getLanguageName(srcLang),
          targetLangName: getLanguageName(tgtLang),
          context: this.contextMemory.get()
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
          // v3.13.55: honor Retry-After when the server sends one (429/503 commonly
          // do) instead of always using the exponential backoff guess. The header
          // can be seconds (an integer) or an HTTP-date; we only handle the
          // integer-seconds form here since that's what every engine we talk to
          // uses in practice — a non-numeric value falls through to the backoff.
          const retryAfterHeader = err.response?.headers?.['retry-after'];
          const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          const delay = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : Math.pow(2, attempt) * 500; // Exponential backoff
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
    const status = err.response?.status;
    // Retry on network errors, rate limits, timeouts, and server-side errors.
    // v3.13.55: 5xx (server overloaded/down, common with local LLM servers under
    // load) and explicit status checks for 429/408 were missing — only string
    // matching on err.message caught 429 (because axios's default message text
    // happens to contain "429"), and a plain 500/502/503 matched nothing at all.
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      status === 429 ||
      status === 408 ||
      (status !== undefined && status >= 500) ||
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
   * Reset the context window. Must be called explicitly at real scene/game
   * boundaries (profile load, source/target language change, engine change,
   * or a manual user action) — see ipc-handlers.js for the call sites. This
   * method existing is not enough by itself; before v3.13.19 the equivalent
   * per-engine clearContext() had zero callers anywhere in the codebase.
   */
  clearContext() {
    this.contextMemory.clear();
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
    // v3.13.19: Resize (not clear) the context window when the setting
    // changes. `!== undefined` matters — an explicit 0 must disable context,
    // not fall back to a default (see the constructor's comment for why).
    if (newSettings.maxContextHistory !== undefined) {
      this.contextMemory.resize(parseInt(newSettings.maxContextHistory));
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
