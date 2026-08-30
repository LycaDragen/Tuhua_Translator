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
const crypto = require('crypto');
const TranslationCache = require('./cache');
const TranslationMemory = require('./translation-memory');
const GlossaryService = require('./glossary');
const ContextMemory = require('./context-memory');
const { buildGlossaryPrompt, maskKeepUnchanged } = require('./glossary-prompt');
const { syncProfileGlossary } = require('./deepl-glossary-sync');

// Engine imports
const GoogleFreeEngine = require('./engines/google-free');
const BingEngine = require('./engines/bing');
const DeepLEngine = require('./engines/deepl');
const OpenAIEngine = require('./engines/openai');
const LocalLLMEngine = require('./engines/local-llm');
const LibreTranslateEngine = require('./engines/libretranslate');
const CustomMTEngine = require('./engines/custom-mt');
const { resolveLocalEndpoint } = require('./llm-providers');
const { matchPresetId } = require('./prompt-presets');

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
  //
  // v3.13.6x (Fase 6): `profileStore` is the same injection Fase 4 left
  // noted as Fase 7's job (per-profile promptTemplate override) — pulled
  // forward here, scoped only to what DeepL's native glossary auto-sync
  // needs (read the active profile's deeplGlossarySync bookkeeping, write
  // it back after a successful remote sync). Optional: a pipeline built
  // without one (existing benches, XUatServer) simply never attempts
  // auto-sync — see _tryEngine's deepl-specific branch.
  constructor(settings = {}, { glossary, profileStore } = {}) {
    super();
    this.settings = settings;
    this.profileStore = profileStore || null;
    this.cache = new TranslationCache({ maxSize: 5000 });
    // v3.11.23: Translation Memory — engine-agnostic persistent store
    this.translationMemory = new TranslationMemory({ maxSize: 10000, enabled: settings.enableTranslationMemory !== false });
    this.glossary = glossary || new GlossaryService();
    // v3.13.6x (Fase 5): word-boundary regex compile cache for
    // glossary-prompt.js's buildGlossaryPrompt(), reused across every
    // translate() call for the life of this pipeline instance — same
    // pattern as GlossaryService's own per-entry compile-error cache.
    // Keyed by "mode source", so a stale entry (glossary term edited/
    // removed) is just an unused Map slot, never a wrong match.
    this._glossaryPromptCache = new Map();
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
    // v3.13.6x (Fase 9): the AbortController for whichever _doTranslate()
    // call is currently making an HTTP request — see translate()'s
    // supersession block below for why this exists. One at a time: only
    // ONE _doTranslate() is ever the "current" one a superseding
    // translate() call cares about aborting.
    this._activeAbortController = null;

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
    // v1.0.6: human-readable form of the same error — see _tryEngine's catch.
    this._lastErrorSummary = null;

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
        // v3.13.8x (settings UX audit): usePro is no longer a settings key —
        // DeepLEngine derives it from the key's ':fx' suffix itself now (see
        // deepl.js's header comment). styleId/translationMemoryId/
        // translationMemoryThreshold dropped too: all three were Pro-plan
        // DeepL features with no UI to set them and no default — always
        // sent as their fallback (unset/75), i.e. dead weight, not a working
        // feature waiting for a UI. See [[plan-deepl-mail-review]], which
        // already concluded DeepL's server-side translation memory adds
        // nothing over Tuhua's own Context Memory.
        this.engines[engineName] = new DeepLEngine(s.deeplKey, {
          formality: s.deeplFormality || 'prefer_more',
          // v3.11.28: New DeepL features
          customInstructions: s.deeplCustomInstructions || [],
          // v3.13.6x (Fase 6): global user preference (cost/latency vs.
          // quality tradeoff), not per-game — same reasoning as llmTemperature.
          modelType: s.deeplModelType || 'prefer_quality_optimized'
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
          // v3.13.59 (Fase 4): renamed from `systemPrompt` — no longer
          // destructive when set (see llm-base.js/prompt-template.js). The
          // profile-level override (`profile.promptTemplate`) the plan
          // designs for is deliberately NOT wired here yet: reading it
          // needs a `profileStore` reference this pipeline doesn't have —
          // that injection is Fase 7's job, alongside the other
          // profile-derived template variables ({game}/{vnTitle}/
          // {speaker}). Adding the schema field without a working read
          // path would be a setting that silently does nothing, which is
          // worse than not having it yet.
          promptTemplate: s.promptTemplate || '',
          // Deliberately decoupled from promptTemplate — see fewShotEnabled's
          // own doc comment in llm-base.js for why the old coupling was a bug.
          fewShotEnabled: s.llmFewShot !== false,
          temperature: s.llmTemperature,
          maxTokens: s.llmMaxTokens,
          topP: s.llmTopP,
          // v3.13.57 (Fase 2): rollback interruptor for the output
          // sanitizer — defaults on.
          sanitize: s.llmSanitize !== false
        });
        // v3.13.6x (Fase 9 testing follow-up, ronda 5): Lyca reported twice
        // (real OpenAI, both rounds) seeing no perceptible difference
        // switching prompt presets or hand-editing the template, despite
        // this being verified correct end-to-end against a real pipeline
        // in this session's own testing (see the memory log). This engine
        // is only ever constructed once per settings generation (getEngine
        // caches it, updateSettings() clears the cache — see there) — this
        // line is the one place that can confirm, from a real exported
        // log, exactly which preset/template actually reached the request
        // that follows, without guessing.
        // v3.13.6x (Fase 9 testing follow-up, ronda 6): added model/
        // temperature/topP/maxTokens/providerId, read off the constructed
        // instance itself (not `s.*`) — same one-source-of-truth reasoning
        // as _cacheVariant(). Without `temperature` here there was no way
        // to tell "the prompt had no effect" apart from "temperature 0
        // (or near it) on a near-deterministic model converging on its
        // own" from the log alone.
        {
          const built = this.engines[engineName];
          console.log(`[Pipeline] openai engine built — preset=${matchPresetId(s.promptTemplate || '')}, fewShot=${built.fewShotEnabled}, promptTemplateHash=${crypto.createHash('sha256').update(s.promptTemplate || '').digest('hex').slice(0, 8)}, providerId=${built.providerId}, model=${built.model}, temperature=${built.temperature}, topP=${built.topP}, maxTokens=${built.maxTokens}`);
        }
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
          // v3.13.59 (Fase 4): see the same comment in the 'openai' case above.
          promptTemplate: s.promptTemplate || '',
          fewShotEnabled: s.llmFewShot !== false,
          temperature: s.llmTemperature,
          maxTokens: s.llmMaxTokens,
          topP: s.llmTopP,
          sanitize: s.llmSanitize !== false
        });
        // v3.13.6x (Fase 9 testing follow-up, ronda 6): same additions as
        // the 'openai' case above, plus `endpoint` — a misconfigured local
        // endpoint (wrong port, e.g. LM Studio's 1234 vs Ollama's 11434)
        // has caused real confusion before and is otherwise invisible here.
        {
          const built = this.engines[engineName];
          console.log(`[Pipeline] local-llm engine built — preset=${matchPresetId(s.promptTemplate || '')}, fewShot=${built.fewShotEnabled}, promptTemplateHash=${crypto.createHash('sha256').update(s.promptTemplate || '').digest('hex').slice(0, 8)}, endpoint=${built.baseUrl}, model=${built.model}, temperature=${built.temperature}, topP=${built.topP}, maxTokens=${built.maxTokens}`);
        }
        break;
      }
      case 'libretranslate':
        // v3.13.8x (settings UX audit): dropped `apiKey: s.libretranslateKey`
        // — no default, no UI field, no writer anywhere; always undefined.
        // LibreTranslate's self-hosted/localhost mode (Tuhua's supported
        // path) doesn't need one. Re-add if the public libretranslate.com
        // API (which does require a key) is ever wired up with a real field.
        this.engines[engineName] = new LibreTranslateEngine({
          endpoint: s.libretranslateEndpoint || 'http://localhost:5000'
        });
        break;
      case 'custom-mt':
        // v3.13.8x (settings UX audit): dropped `headers: s.customMTHeaders`
        // and `apiKey: s.customMTApiKey` — same reasoning, always undefined.
        // The Auth Header field's `{{apiKey}}` placeholder promised a value
        // that could never resolve to anything; it's now a plain text field
        // where the key is typed in literally (see index.html).
        this.engines[engineName] = new CustomMTEngine({
          endpoint: s.customMTEndpoint || '',
          method: s.customMTMethod || 'POST',
          bodyTemplate: s.customMTBody || '{"text":"{{text}}","source":"{{source}}","target":"{{target}}"}',
          responsePath: s.customMTResponsePath || 'data.translations.0.translatedText',
          authHeader: s.customMTAuthHeader || ''
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
    // v3.13.6x (Fase 9): the block above only rejects a translation still
    // waiting OUT its debounce delay — once a debounce timer actually
    // fires, _pendingReject is already null (see the timer callback
    // below), but the engine's HTTP request can still be running for far
    // longer than debounceMs (this is exactly the case with a slow LLM).
    // Aborting here means that request — and the tokens it would have
    // billed for a translation nobody will ever see — actually stops,
    // instead of running to a completion that gets silently discarded.
    this._abortActiveRequest();

    const src = options.source || this.settings.sourceLang || 'ja';
    const tgt = options.target || this.settings.targetLang || 'es';
    const engine = options.engine || this.settings.engine || 'google-free';
    // v3.13.6x (Fase 7a): the speaker's name, extracted by ipc-handlers.js's
    // _handleText BEFORE the filters that would otherwise destroy it — see
    // its own comment there. `game`/`vnTitle`/`inputMethod` are NOT threaded
    // through options: _tryEngine resolves them itself, straight from the
    // active profile / settings, the same way it already resolves DeepL's
    // glossary_id — there's no reason to make every caller of translate()
    // pass through data the pipeline already has direct access to.
    const meta = { speaker: options.speaker };

    // Debounce
    return new Promise((resolve, reject) => {
      this._pendingReject = reject;
      this.debounceTimer = setTimeout(async () => {
        this._pendingReject = null;
        try {
          const result = await this._doTranslate(text, src, tgt, engine, meta);
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
    // v3.13.6x (Fase 9 testing follow-up, ronda 5): real bug found testing
    // the prompt-preset comparison workflow (change preset → click ↻,
    // repeated) — translate()'s debounce entry point has aborted the
    // previous in-flight request before starting a new one since Fase 9
    // (see there), but translateNow() — the method _retranslateCurrent()
    // (the ↻ button / Ctrl+Shift+R) actually calls — never did. Two
    // translateNow() calls fired close together (comparing presets faster
    // than OpenAI's round trip) both ran to completion UNCANCELLED, each
    // silently overwriting `_activeAbortController` with its own — neither
    // aborted the other. Whichever response happened to arrive LAST won
    // the overlay, a pure network race with no relationship to which
    // preset was actually selected last. This is almost certainly why
    // preset/prompt comparisons looked like "no difference": a stale
    // response from an earlier click could paint over a newer one at any
    // time, silently. `_abortActiveRequest()` — the same guard translate()
    // uses — closes the gap; a superseded call rejects tagged
    // `SUPERSEDED`, which `_retranslateCurrent()` already treats as a
    // silent no-op (routine, expected), not an error.
    this._abortActiveRequest();
    const src = options.source || this.settings.sourceLang || 'ja';
    const tgt = options.target || this.settings.targetLang || 'es';
    const engine = options.engine || this.settings.engine || 'google-free';
    const meta = { speaker: options.speaker };
    // v3.13.6x (Fase 9 testing follow-up, ronda 6): forwarded, not read
    // here — see _doTranslate()'s own comment on `bypassMemory` for why
    // ("Settings changed while text is on-screen — auto-retranslating..."
    // followed by a silent TM hit, engine never called, was reproduced in
    // a real log). Default false: xuat-server.js also calls translateNow()
    // as its normal (non-debounced) translation path and must keep its
    // cache/TM hits.
    return this._doTranslate(text, src, tgt, engine, meta, { bypassMemory: options.bypassMemory === true });
  }

  /**
   * Aborts whatever _doTranslate() call is currently in flight, if any —
   * shared by translate() (debounce path) and translateNow() (manual path)
   * so BOTH guarantee only the most recently requested translation can
   * ever paint a result. See translateNow()'s own comment for the bug this
   * fixes on the manual-retranslate side.
   */
  _abortActiveRequest() {
    if (this._activeAbortController) {
      this._activeAbortController.abort();
      this._activeAbortController = null;
    }
  }

  async _doTranslate(text, srcLang, tgtLang, engineName, meta = {}, options = {}) {
    // v3.13.6x (Fase 9 testing follow-up, ronda 6): `bypassMemory` skips
    // ONLY the cache/TM READ below — writes still happen. An explicit
    // retranslate ("redo this with the settings I just changed") must
    // actually call the engine, not silently echo back whatever a stale
    // cache/TM entry already had (real bug found this way: the log showed
    // "Settings changed while text is on-screen — auto-retranslating..."
    // immediately followed by "Translation Memory exact hit ... (was:
    // deepl)" — the engine was never called at all). Writes stay on
    // deliberately: overwriting the stale entry is what makes the fresh
    // result "stick" for the next time this exact line appears, and it
    // stamps a real `variant` onto legacy TM entries that never had one
    // (see translation-memory.js's isVariantCompatible). Default false —
    // xuat-server.js's normal (non-debounced) translation path also calls
    // translateNow() and must keep its cache/TM hits.
    const bypassMemory = options.bypassMemory === true;
    console.log(`[Pipeline] _doTranslate: srcLang=${srcLang}, tgtLang=${tgtLang}, engine=${engineName}${bypassMemory ? ', bypassMemory=true' : ''}`);

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

    // 1. Cache/TM/context key — ALWAYS the raw text (post upstream filters,
    // e.g. regex-filter/hook-cleaning, which already ran before this method
    // was called). v3.13.6x (Fase 5): before this, `preprocessed` (glossary
    // literal-substituted text) was both the cache key AND what got sent to
    // the engine. Once glossaryPrompt-capable engines stop getting the
    // literal substitution (see _tryEngine below), the SAME line would
    // otherwise hash into two different cache-key spaces depending on
    // whether glossaryMode happened to be 'prompt' or 'literal' at the
    // time — a cache/TM entry written under one mode would silently never
    // be found under the other. Keying on the untouched line instead makes
    // the cache mode-agnostic; _tryEngine decides per-call how the glossary
    // reaches the engine, entirely independent of what gets hashed.
    const cacheKey = text;
    // v3.13.6x (Fase 7c): the 5th key component — see cache.js's and
    // _cacheVariant's own header comments. Computed once here (not
    // per-attempt inside _tryEngine) since it only depends on the primary
    // engine's static configuration, not anything about this specific call.
    const variant = this._cacheVariant(this.getEngine(engineName));
    // v3.13.6x (Fase 7d): TM namespace/compatibility — see
    // translation-memory.js's own header comments for why cross-profile
    // bleed and LLM-reusing-MT were real bugs, not features. '' when no
    // profileStore is injected (existing benches) preserves the old
    // global-namespace TM behavior exactly.
    const profileId = this.profileStore?.getActive()?.id || '';
    const engineClass = this._engineClass(this.getEngine(engineName));

    // 2. Check engine-specific cache (exact engine match)
    const cached = bypassMemory ? null : this.cache.get(cacheKey, effectiveSrcLang, tgtLang, engineName, variant);
    if (cached) {
      // v3.13.6x (Fase 9 testing follow-up, ronda 6): this branch used to
      // be completely silent — zero console output — which is exactly why
      // "the prompt changed but the translation didn't" took 3 real
      // testing sessions to root-cause: nothing in the log distinguished
      // a cache hit from a fresh engine call. `variant` is the field that
      // says whether a prompt/model change SHOULD have invalidated this
      // entry — its presence here makes that question answerable from an
      // exported log instead of requiring a code read.
      console.log(`[Pipeline] Cache hit: "${cacheKey.substring(0, 30)}..." → "${cached.substring(0, 30)}..." (engine=${engineName}, variant=${variant || '(none)'})`);
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
      //
      // v3.13.6x (Fase 7e): pushes `postprocessed`, not `cached` — the
      // context window is what a FUTURE line's {contextBoth} sees as "how
      // was this rendered", and glossary-post-processing (character name
      // casing, style fixes) is part of the real rendered output. Pushing
      // the pre-post-processing text meant the context window quietly
      // disagreed with what the user actually saw on screen for that line.
      this.contextMemory.push(cacheKey, postprocessed);

      return postprocessed;
    }

    // 2b. v3.11.25: Translation Memory — exact match first, then fuzzy.
    // This saves money and reduces latency for repeated or near-matching dialogue.
    const tmResult = bypassMemory ? null : this.translationMemory.getWithFuzzy(cacheKey, effectiveSrcLang, tgtLang, profileId, engineClass, variant);
    if (tmResult) {
      this.stats.tmHits++;
      const matchType = tmResult.fuzzy ? 'fuzzy' : 'exact';
      const scoreInfo = tmResult.fuzzy ? ` (${(tmResult.score * 100).toFixed(0)}%)` : '';
      // v3.13.6x (Fase 9 testing follow-up, ronda 6): now logs BOTH sides of
      // the variant comparison — `variant` is what this call asked for,
      // `storedVariant` is what's actually on the entry that answered it.
      // A hit with `storedVariant=(none)` is a legacy entry (written before
      // `variant` existed) matching regardless of prompt/model — without
      // this, that case is visually identical to a normal, correct hit.
      console.log(`[Pipeline] Translation Memory ${matchType} hit${scoreInfo}: "${cacheKey.substring(0, 30)}..." → "${tmResult.translation.substring(0, 30)}..." (was: ${engineName}, variant=${variant || '(none)'}, storedVariant=${tmResult.variant || '(none)'})`);
      // Also store in engine-specific cache for faster future lookups
      this.cache.set(cacheKey, effectiveSrcLang, tgtLang, engineName, tmResult.translation, variant);
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
      // v3.13.6x (Fase 7e): pushes `postprocessed` — see the cache-hit
      // branch's comment above for why.
      this.contextMemory.push(cacheKey, postprocessed);

      return postprocessed;
    }

    // 3. Rate limiting is now enforced inside _tryEngine (once per attempt/fallback,
    // not just once here) — see v3.13.55 note there.

    // 4. Translate with retry and fallback
    this._lastError = null;
    this._lastErrorSummary = null;

    // v3.13.6x (Fase 9): one controller for this whole _doTranslate() call —
    // covers the primary engine's retries AND any fallback attempt below,
    // since all of them are for the SAME (possibly now-stale) text. See
    // translate()'s supersession block for where this gets aborted; no
    // explicit cleanup needed here — the next _doTranslate() call simply
    // overwrites this with its own controller, and aborting an
    // already-settled controller is a harmless no-op.
    const abortController = new AbortController();
    this._activeAbortController = abortController;

    // Try primary engine
    const result = await this._tryEngine(engineName, text, effectiveSrcLang, tgtLang, 1, meta, abortController.signal);
    if (result) {
      // v3.13.57: a response the sanitizer flagged as cut off by
      // max_tokens (llm-output.js verdict:'truncated') is still shown to
      // the user (better than nothing), but must not poison the cache,
      // the Translation Memory, or the context window — a truncated
      // fragment is not what a full retranslation should return, and it's
      // exactly the kind of thing that used to get cached for 24h as if
      // it were a real translation. `!result.truncated` guards all three.
      if (!result.truncated) {
        this.cache.set(cacheKey, effectiveSrcLang, tgtLang, engineName, result.text, variant);
        // v3.11.23: Also store in Translation Memory (engine-agnostic) for cross-engine reuse
        this.translationMemory.set(cacheKey, effectiveSrcLang, tgtLang, result.text, engineName, profileId, engineClass, variant);
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
        // v3.13.6x (Fase 7e): pushes `postprocessed` — see the cache-hit
        // branch's comment above for why the raw engine output isn't
        // what belongs in the context window.
        this.contextMemory.push(cacheKey, postprocessed);
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
    // v1.0.6: captured HERE, before any fallback runs — `_lastErrorSummary`
    // is overwritten by each failing attempt, so reading it after the loop
    // would report a fallback's error as if it were the primary's. What the
    // user needs to see is why THEIR chosen engine failed.
    const primaryFailureReason = this._lastErrorSummary || this._lastError?.message || '';

    const fallbacks = (FALLBACK_CHAIN[engineName] || ['google-free']).filter((name) => {
      const fallbackEngine = this.getEngine(name);
      if (!fallbackEngine || !Array.isArray(fallbackEngine.supportedLanguages) || fallbackEngine.supportedLanguages.length === 0) {
        return true;
      }
      return fallbackEngine.supportedLanguages.includes(tgtLang);
    });
    for (const fallback of fallbacks) {
      const fallbackResult = await this._tryEngine(fallback, text, effectiveSrcLang, tgtLang, 1, meta, abortController.signal);
      if (fallbackResult) {
        this.stats.fallbacks++;
        // v3.13.57: same guard as the primary-engine branch above — a
        // fallback could itself be an LLM engine in a future FALLBACK_CHAIN
        // configuration, so this stays correct even though today's chains
        // only fall back to non-LLM engines that never set `truncated`.
        if (!fallbackResult.truncated) {
          // v3.13.6x (Fase 7c): the FALLBACK engine's own variant, not the
          // primary's — a fallback with different prompt/model config must
          // not read/write under the primary's cache slot.
          this.cache.set(cacheKey, effectiveSrcLang, tgtLang, fallback, fallbackResult.text, this._cacheVariant(this.getEngine(fallback)));
          // v3.11.23: Also store in Translation Memory
          this.translationMemory.set(cacheKey, effectiveSrcLang, tgtLang, fallbackResult.text, fallback, profileId, this._engineClass(this.getEngine(fallback)), this._cacheVariant(this.getEngine(fallback)));
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
          fallbackReason: primaryFailureReason,
          truncated: !!fallbackResult.truncated,
          sourceLang: srcLang,
          targetLang: tgtLang,
          timestamp: Date.now()
        });

        if (!fallbackResult.truncated) {
          // v3.13.6x (Fase 7e): pushes `postprocessed` — same reasoning as
          // the primary-engine branch above.
          this.contextMemory.push(cacheKey, postprocessed);
        }

        return postprocessed;
      }
    }

    // All engines failed
    this.stats.errors++;
    this.emit('error', {
      original: text,
      // v1.0.6: the same richer summary the fallback toast now gets — an
      // axios `.message` ("Request failed with status code 401") says
      // nothing the user can act on.
      error: this._lastErrorSummary || this._lastError?.message || 'All translation engines failed',
      engine: engineName,
      timestamp: Date.now()
    });

    return `[Error] Translation failed`;
  }

  async _tryEngine(engineName, text, srcLang, tgtLang, retries = 1, meta = {}, signal = undefined) {
    const engine = this.getEngine(engineName);
    if (!engine) return null;

    console.log(`[Pipeline] _tryEngine: engine=${engineName}, srcLang=${srcLang} (${getLanguageName(srcLang)}), tgtLang=${tgtLang} (${getLanguageName(tgtLang)})`);

    // v3.13.6x (Fase 7b): {game}/{vnTitle} resolved straight from the
    // active profile here, not threaded in from translate()'s caller —
    // profileStore is already injected (Fase 6), and the pipeline has
    // direct access to exactly the same data a caller would otherwise have
    // to look up and pass through every translate()/translateNow() call
    // site for no reason. `game` is the profile's own name (always
    // present); `vnTitle` is VNDB's title (only present if imported —
    // profile.cover.vnTitle, see profile-schema.js). `inputMethod` is a
    // plain setting, no profile lookup needed at all.
    const activeProfile = this.profileStore?.getActive();
    const promptContext = {
      speaker: meta.speaker || '',
      game: activeProfile?.name || '',
      vnTitle: activeProfile?.cover?.vnTitle || '',
      inputMethod: this.settings.inputMethod || ''
    };

    // v3.13.6x (Fase 5): glossary-as-prompt-instruction. Measured against
    // two real engines before picking a default — see
    // scripts/test-glossary-compliance.js and its report: OpenAI hit 100%
    // prompt-only compliance, but a local 3B model (Qwen2.5-3B-Instruct via
    // Ollama) only hit 81.8% — it followed "translate X as Y" fine but
    // ignored "leave X unchanged" (source===target entries) and translated
    // the proper noun anyway. Since this is one global setting and Tuhua
    // can't know in advance whether a given local-llm user's model complies
    // well, 'hybrid' is the default (see below), not 'prompt'.
    //
    // `glossaryMode` (settings, default 'hybrid' — see src/main/index.js)
    // is the rollback interruptor: 'literal' reproduces the exact
    // pre-Fase-5 behavior for every engine. Only engines whose
    // capabilities.glossaryPrompt is true (today: openai, local-llm — see
    // llm-base.js) are eligible for anything else; every other engine
    // (google-free, deepl, bing, ...) always gets the literal path,
    // unaffected by this setting.
    const glossaryMode = this.settings.glossaryMode || 'hybrid';
    const supportsGlossaryPrompt = !!engine.capabilities?.glossaryPrompt;
    const usePromptGlossary = supportsGlossaryPrompt && glossaryMode !== 'literal';
    // 'prompt': the literal pre-substitution is skipped entirely — sending
    // the model a line that's already half-target-language degrades output
    // (and, per the Fase 0 fix, that same degraded text is what feeds the
    // cache/TM/context window). 'hybrid' additionally keeps the literal
    // substitution for RENDERING entries (source≠target — a real, working
    // safety net there, since the model never sees the source term at all).
    // It does nothing extra for KEEP-UNCHANGED entries (source===target):
    // literal substitution is a no-op for those by construction, so masking
    // (below) is what actually protects them in both 'prompt' and 'hybrid'.
    let engineInput = (usePromptGlossary && glossaryMode !== 'hybrid')
      ? text
      : this.glossary.applyPreTranslation(text);
    let glossaryBlock;
    // Placeholder-masks the text the model actually sees where the model
    // ignoring the prompt instruction was measured to be a real failure
    // mode (see maskKeepUnchanged's doc comment in glossary-prompt.js) —
    // the model can't mistranslate a proper noun it never saw. Runs on
    // `engineInput` (after any literal substitution above) since the two
    // never target the same entries: masking only touches source===target,
    // literal substitution only ever changes anything for source≠target.
    let restoreKeepUnchanged = (output) => output;
    if (usePromptGlossary) {
      const masked = maskKeepUnchanged(this.glossary.getEffective(), engineInput, { compileCache: this._glossaryPromptCache });
      engineInput = masked.maskedText;
      restoreKeepUnchanged = masked.restore;
      glossaryBlock = buildGlossaryPrompt(this.glossary.getEffective(), text, {
        compileCache: this._glossaryPromptCache,
        // Masked entries are already guaranteed — telling the model to
        // "keep X unchanged" when X has been replaced by a ⟦N⟧ token it
        // can't even see is redundant at best, confusing at worst.
        includeKeepUnchanged: false
      });
    }

    // v3.13.6x (Fase 6): DeepL's native glossary_id — a completely
    // different mechanism from the LLM prompt/masking block above (DeepL
    // isn't an LLM; it has no prompt to instruct). Resolved once per call,
    // not per attempt — a retry of the SAME call shouldn't re-sync.
    let deeplGlossaryId;
    let deeplKeepUnchangedTerms;
    if (engineName === 'deepl') {
      const resolved = await this._resolveDeeplGlossary(engine, srcLang, tgtLang);
      deeplGlossaryId = resolved.glossaryId;
      deeplKeepUnchangedTerms = resolved.keepUnchangedTerms;
    }

    // v3.13.6x (Fase 9 testing follow-up, ronda 6): THE fix for the real
    // bug behind "changing the prompt preset doesn't change the
    // translation" — verified over 3 real testing sessions plus
    // scripts/test-context-memory.js --mode=preset-divergence against a
    // real LLM. Every _doTranslate() resolution path (cache hit, TM hit,
    // live engine call, fallback) pushes (text, result) into
    // contextMemory BEFORE returning — so without this exclusion, `text`
    // (the exact line about to be sent below) could already be sitting in
    // the window from the PREVIOUS call for this same line, rendered into
    // the prompt as "<text> → <text's own prior translation>" under a
    // header telling the model these are recent lines "to stay consistent
    // with" and "not to re-translate". That isn't a bias toward the old
    // answer — it's an answer key with a copy instruction attached, and a
    // model reproducing it byte-for-byte regardless of which prompt preset
    // asked is the expected result of that prompt, not a mystery. See
    // context-memory.js's getExcluding() for why this is exact-string,
    // not fuzzy. `text` (not `engineInput`, which may be glossary-masked
    // — see this method's own construction of `engineInput` above) is
    // what was actually pushed to the window by every write site in
    // _doTranslate(), so it's what has to be excluded here too.
    const contextWindow = this.contextMemory.getExcluding(text);
    console.log(`[Pipeline] context window: ${contextWindow.length} pair(s) sent (${this.contextMemory.size} held, current line excluded=${contextWindow.length < this.contextMemory.size})`);

    for (let attempt = 0; attempt <= retries; attempt++) {
      // v3.13.55: rate limiting used to be enforced once in _doTranslate, before
      // the primary engine's *first* attempt only — so a retry or a fallback
      // engine call could fire back-to-back with no spacing at all. Enforcing it
      // here means every attempt (primary retries AND fallback engines) is spaced.
      await this._enforceRateLimit();
      try {
        const result = await engine.translate(engineInput, {
          sourceLang: srcLang,
          targetLang: tgtLang,
          sourceLangName: getLanguageName(srcLang),
          targetLangName: getLanguageName(tgtLang),
          context: contextWindow,
          glossary: glossaryBlock,
          glossaryId: deeplGlossaryId,
          keepUnchangedTerms: deeplKeepUnchangedTerms,
          speaker: promptContext.speaker,
          game: promptContext.game,
          vnTitle: promptContext.vnTitle,
          inputMethod: promptContext.inputMethod,
          // v3.13.6x (Fase 9): only engines with capabilities.abort (today:
          // the LLM base class) actually read this — every other engine's
          // translate() ignores an unused options field, same as it already
          // ignores e.g. `glossaryId` when it isn't DeepL.
          signal
        });
        if (result) {
          result.text = restoreKeepUnchanged(result.text);
        }
        return result;
      } catch (err) {
        this._lastError = err; // Track last actual error
        // v3.13.6x (Fase 9): a cancelled request means translate() itself
        // was superseded by newer text while this attempt was in flight
        // (see translate()'s abort call) — not a real engine failure.
        // Rethrow tagged the same way the debounce's own supersession
        // already is, so the caller (_doTranslate, and translateNow()'s
        // direct caller) treats it identically: no retry, no fallback
        // chain, no [Error] painted on the overlay — the promise this
        // stale attempt would have resolved is either already rejected or
        // about to be discarded, so there's nothing left worth doing here.
        if (err.code === 'ERR_CANCELED') {
          const supersededError = new Error('Translation superseded by new text');
          supersededError.code = 'SUPERSEDED';
          throw supersededError;
        }
        // v3.11.27: Log the actual error so we can diagnose engine failures
        const status = err.response?.status;
        const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
        const statusInfo = status ? ` (HTTP ${status})` : '';
        console.error(`[Pipeline] ${engineName} failed${statusInfo}: ${errMsg}`);
        // v1.0.6: keep that same diagnostic string for the UI. `_lastError`
        // alone isn't enough — for an HTTP failure its `.message` is axios's
        // generic "Request failed with status code 401", while the sentence
        // that actually tells the user what to do ("Invalid Anthropic API
        // Key") only lives in the response body, and until now only ever
        // reached the log file. That's the whole reason a wrong API key
        // looked like "it just translates badly": the fallback toast said
        // the primary engine had failed, but never why.
        this._lastErrorSummary = status ? `HTTP ${status}: ${errMsg}` : errMsg;
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

  /**
   * Resolves which DeepL glossary_id (if any) this call should send, and
   * the list of "keep unchanged" terms for fixTermSpacing() to fix up
   * DeepL's own glued-boundary artifact on (see deepl.js's translate()).
   *
   * Manual (`profile.deeplGlossaryId`, flows in via `this.settings` like any
   * other profile-scoped setting — no profileStore access needed for this
   * half) takes priority if set: "the user is managing this themselves, we
   * don't touch it." Otherwise, if `deeplAutoGlossary` is on for the active
   * profile, lazily syncs (see deepl-glossary-sync.js — a no-op on the
   * common case where nothing changed since the last sync, just a hash
   * comparison) and uses the resulting id.
   *
   * Never throws: a DeepL API hiccup during sync must not block the actual
   * translation this call exists for — falls back to "no glossary" and lets
   * the translation proceed, logging the failure.
   */
  async _resolveDeeplGlossary(deeplEngine, srcLang, tgtLang) {
    const effective = this.glossary.getEffective();
    const keepUnchangedTerms = effective
      .filter((e) => e.enabled !== false && e.mode !== 'regex' && e.source === e.target)
      .map((e) => e.source);

    if (this.settings.deeplGlossaryId) {
      return { glossaryId: this.settings.deeplGlossaryId, keepUnchangedTerms };
    }
    if (!this.settings.deeplAutoGlossary || !this.profileStore) {
      return { glossaryId: undefined, keepUnchangedTerms };
    }

    const activeProfile = this.profileStore.getActive();
    if (!activeProfile) {
      return { glossaryId: undefined, keepUnchangedTerms };
    }

    try {
      const { deeplGlossarySync, changed } = await syncProfileGlossary({
        deeplGlossarySync: activeProfile.deeplGlossarySync,
        entries: effective,
        sourceLang: srcLang,
        targetLang: tgtLang,
        profileName: activeProfile.name,
        baseUrl: deeplEngine.baseUrl,
        apiKey: deeplEngine.apiKey
      });
      if (changed) {
        this.profileStore.update(activeProfile.id, () => ({ deeplGlossarySync }));
        console.log(`[Pipeline] DeepL glossary ${deeplGlossarySync ? 'synced' : 'cleared'} for profile "${activeProfile.name}"${deeplGlossarySync ? ` (${deeplGlossarySync.glossaryId})` : ''}`);
      }
      return { glossaryId: deeplGlossarySync?.glossaryId, keepUnchangedTerms };
    } catch (err) {
      console.error(`[Pipeline] DeepL glossary auto-sync failed, continuing without a glossary: ${err.response?.data?.message || err.message}`);
      return { glossaryId: undefined, keepUnchangedTerms };
    }
  }

  /**
   * The cache key's 5th component (Fase 7c) — '' for any engine without
   * `capabilities.glossaryPrompt` (their key shape is completely
   * unaffected by this Fase), otherwise a hash of exactly what a prompt-
   * driven engine's request actually depends on: provider, model, the
   * rendered prompt template, temperature, and whether few-shot is on.
   * Read straight off the constructed engine instance (llm-base.js already
   * resolved all of these into properties on it) rather than re-derived
   * from `this.settings` a second time — one source of truth, no chance of
   * the two drifting apart.
   *
   * Context is deliberately NOT part of this — see cache.js's own header
   * comment for why that's a considered decision, not an oversight.
   */
  _cacheVariant(engine) {
    if (!engine.capabilities?.glossaryPrompt) return '';
    const raw = [
      engine.providerId || engine.name,
      engine.model,
      engine.promptTemplate,
      engine.temperature,
      engine.fewShotEnabled
    ].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  }

  // v3.13.6x (Fase 7d): 'llm'|'mt' — the same capability signal
  // _cacheVariant/glossaryMode already gate on, reused here for
  // translation-memory.js's engine-class compatibility check.
  _engineClass(engine) {
    return engine.capabilities?.glossaryPrompt ? 'llm' : 'mt';
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
    // v3.13.8x (settings UX audit): enableTranslationMemory used to be
    // read ONLY in the constructor (`enabled: settings.enableTranslationMemory
    // !== false`), so there was no UI for it AND no way to change it
    // without restarting the app even if there had been one. Now exposed
    // in the modal's Avanzado category — this is what makes toggling it
    // actually take effect: save-settings already calls updateSettings()
    // on every save, and TranslationMemory#get() checks `this.enabled` on
    // every lookup, so this applies starting with the very next
    // translation (a request already in flight keeps using the old value).
    if (newSettings.enableTranslationMemory !== undefined) {
      this.translationMemory.setEnabled(newSettings.enableTranslationMemory !== false);
    }
  }
}

module.exports = TranslationPipeline;
