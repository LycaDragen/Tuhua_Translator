/**
 * Translation Memory Service
 * v3.11.23: Engine-agnostic persistent translation memory.
 * v3.11.25: Added fuzzy matching for approximate hits.
 * v3.13.05: Raised fuzzy threshold from 0.75 to 0.85 to prevent incorrect matches.
 * v3.13.07: Raised fuzzy threshold from 0.85 to 0.90 and added length ratio
 *   validation in getWithFuzzy(). Even at 85% threshold, similar but different
 *   dialogue lines were getting false matches (e.g., CJK text sharing many
 *   characters but meaning different things). The length ratio check rejects
 *   matches where source texts differ by more than 2x, which is a strong
 *   signal of semantically different content.
 *
 * Unlike the engine-specific cache, this stores translations keyed by
 * (sourceText, srcLang, tgtLang) WITHOUT the engine — so if you switch
 * from Google to DeepL, repeated dialogue gets an instant cache hit
 * without making a new API call.
 *
 * Fuzzy matching catches near-matches from OCR errors, slight
 * rewording in branching VN dialogue, or Textractor noise —
 * reducing API calls and latency for text that is "close enough"
 * to a previously translated line.
 *
 * This is especially valuable for VNs with branching paths where
 * the same dialogue repeats across different routes.
 */
const Store = require('electron-store');
const crypto = require('crypto');
const log = require('electron-log');
const { combinedSimilarity, findBestMatch } = require('./fuzzy-matcher');

class TranslationMemory {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 10000;
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    // v3.11.25: Fuzzy matching — enabled by default, configurable threshold
    // v3.13.07: Raised from 0.85 to 0.90 — even at 85%, too many false matches
    // occurred where similar but semantically different dialogue lines produced
    // wrong translations. 90% ensures only near-identical text reuses translations.
    this.fuzzyThreshold = options.fuzzyThreshold || 0.90;  // v3.13.07: Raised from 0.85
    this.fuzzyEnabled = options.fuzzyEnabled !== undefined ? options.fuzzyEnabled : true;
    // Cache the plain-text index for fuzzy lookups (rebuilt lazily)
    this._fuzzyIndex = null;
    this._fuzzyIndexDirty = true;

    this.store = new Store({
      name: 'translation-memory',
      defaults: {
        entries: {},   // key -> { sourceText, translation, srcLang, tgtLang, timestamp, originalEngine }
        order: []      // LRU order (most recent last)
      }
    });
  }

  _makeKey(text, srcLang, targetLang) {
    // No engine in key — this is engine-agnostic
    const raw = `${text}|||${srcLang}|||${targetLang}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Exact match lookup.
   * Returns translation string or null.
   */
  get(text, srcLang, targetLang) {
    if (!this.enabled) return null;

    const key = this._makeKey(text, srcLang, targetLang);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

    const entry = entries[key];
    if (!entry) return null;

    // Update LRU order
    const idx = order.indexOf(key);
    if (idx !== -1) {
      order.splice(idx, 1);
      order.push(key);
      this.store.set('order', order);
    }

    return entry.translation;
  }

  /**
   * v3.11.25: Fuzzy match lookup.
   * Searches all entries for (srcLang, tgtLang) and finds the best
   * similar match above the threshold. Returns the translation with
   * a similarity score, or null if nothing matches.
   *
   * This is slower than exact match (O(n) where n = entries for that
   * language pair), but saves an API call when a near-match is found.
   *
   * @param {string} text - Source text to match
   * @param {string} srcLang
   * @param {string} targetLang
   * @returns {{ translation: string, score: number, originalText: string } | null}
   */
  getFuzzy(text, srcLang, targetLang) {
    if (!this.enabled || !this.fuzzyEnabled) return null;

    // Rebuild fuzzy index if dirty
    if (this._fuzzyIndexDirty) {
      this._rebuildFuzzyIndex();
    }

    const langKey = `${srcLang}|||${targetLang}`;
    const candidates = this._fuzzyIndex.get(langKey);
    if (!candidates || candidates.length === 0) return null;

    const result = findBestMatch(text, candidates, this.fuzzyThreshold);
    if (result.match) {
      log.info(`[TM] Fuzzy hit: score=${(result.score * 100).toFixed(0)}%, "${text.substring(0, 30)}..." ≈ "${result.match.text.substring(0, 30)}..."`);
      return {
        translation: result.match.translation,
        score: result.score,
        originalText: result.match.text
      };
    }

    return null;
  }

  /**
   * Combined lookup: tries exact match first, then fuzzy.
   * Returns { translation, fuzzy: boolean, score? } or null.
   * v3.13.06: For fuzzy matches, validate that the source texts are
   * actually semantically similar — OCR errors can produce text that
   * happens to have high character overlap but is actually a different
   * line of dialogue. We now require that the fuzzy match's source text
   * is at least 60% similar in MEANINGFUL characters (CJK + Latin letters),
   * not just overall string similarity.
   */
  getWithFuzzy(text, srcLang, targetLang) {
    // 1. Try exact match first (O(1), always preferred)
    const exact = this.get(text, srcLang, targetLang);
    if (exact) {
      return { translation: exact, fuzzy: false };
    }

    // 2. Try fuzzy match (O(n), fallback)
    // v3.13.07: Validate fuzzy matches — skip if source texts differ
    // significantly in length, as this often indicates different dialogue
    // that happens to share character overlap (e.g., "行くよ！" vs "行かない！")
    const fuzzyResult = this.getFuzzy(text, srcLang, targetLang);
    if (fuzzyResult) {
      // Length validation: if the original TM text is more than 2x shorter or
      // 2x longer than the current text, it's likely a different line of dialogue
      // that just happens to share many characters (common in CJK languages)
      const origLen = (fuzzyResult.originalText || '').length;
      const currLen = text.length;
      const lenRatio = origLen > 0 ? Math.max(origLen, currLen) / Math.min(origLen, currLen) : 1;
      if (lenRatio > 2.0) {
        console.log(`[TM] Fuzzy match rejected — length ratio too different (${lenRatio.toFixed(1)}x): "${text.substring(0, 30)}..." vs "${(fuzzyResult.originalText || '').substring(0, 30)}..."`);
        return null;
      }
      return {
        translation: fuzzyResult.translation,
        fuzzy: true,
        score: fuzzyResult.score,
        originalText: fuzzyResult.originalText
      };
    }

    return null;
  }

  set(text, srcLang, targetLang, translation, engineName) {
    if (!this.enabled) return;

    const key = this._makeKey(text, srcLang, targetLang);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

    if (entries[key]) {
      entries[key] = {
        sourceText: text,   // v3.11.25: Store plain text for fuzzy matching
        srcLang,
        tgtLang: targetLang,
        translation,
        timestamp: Date.now(),
        originalEngine: engineName || entries[key].originalEngine
      };
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      order.push(key);
    } else {
      entries[key] = {
        sourceText: text,   // v3.11.25: Store plain text for fuzzy matching
        srcLang,
        tgtLang: targetLang,
        translation,
        timestamp: Date.now(),
        originalEngine: engineName || 'unknown'
      };
      order.push(key);

      // Evict oldest if over max size
      while (order.length > this.maxSize) {
        const oldestKey = order.shift();
        delete entries[oldestKey];
      }
    }

    this.store.set('entries', entries);
    this.store.set('order', order);

    // Mark fuzzy index as dirty — needs rebuild on next fuzzy lookup
    this._fuzzyIndexDirty = true;
  }

  clear() {
    this.store.set('entries', {});
    this.store.set('order', []);
    this._fuzzyIndex = null;
    this._fuzzyIndexDirty = true;
  }

  size() {
    return this.store.get('order', []).length;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * v3.11.25: Configure fuzzy matching at runtime.
   * @param {boolean} enabled
   * @param {number} threshold - 0..1 similarity threshold
   */
  setFuzzyConfig(enabled, threshold) {
    this.fuzzyEnabled = enabled;
    if (threshold !== undefined) {
      this.fuzzyThreshold = Math.max(0.5, Math.min(1.0, threshold));
    }
  }

  /**
   * v3.11.25: Rebuild the in-memory fuzzy index from persisted entries.
   * Groups entries by (srcLang, tgtLang) for efficient per-language-pair lookups.
   * Called lazily when fuzzy lookup is requested and the index is dirty.
   */
  _rebuildFuzzyIndex() {
    const entries = this.store.get('entries', {});
    this._fuzzyIndex = new Map();

    for (const key of Object.keys(entries)) {
      const entry = entries[key];
      if (!entry.sourceText) continue;  // Skip entries from before v3.11.25

      const langKey = `${entry.srcLang || 'auto'}|||${entry.tgtLang || 'es'}`;
      if (!this._fuzzyIndex.has(langKey)) {
        this._fuzzyIndex.set(langKey, []);
      }
      this._fuzzyIndex.get(langKey).push({
        text: entry.sourceText,
        translation: entry.translation
      });
    }

    this._fuzzyIndexDirty = false;
    log.info(`[TM] Fuzzy index rebuilt: ${this._fuzzyIndex.size} language pairs, ${this.size()} total entries`);
  }

  /**
   * v3.11.25: Migrate old entries that lack sourceText field.
   * Old entries (pre-v3.11.25) only stored the hash key and translation.
   * This method is a no-op for new entries but logs a warning for old ones.
   * Full migration would require reverse-hashing which is not possible,
   * so old entries simply won't participate in fuzzy matching until
   * they are re-translated and stored with sourceText.
   */
  getStats() {
    const entries = this.store.get('entries', {});
    let withSourceText = 0;
    let withoutSourceText = 0;
    for (const key of Object.keys(entries)) {
      if (entries[key].sourceText) withSourceText++;
      else withoutSourceText++;
    }
    return {
      total: this.size(),
      withSourceText,
      withoutSourceText,
      fuzzyEnabled: this.fuzzyEnabled,
      fuzzyThreshold: this.fuzzyThreshold
    };
  }
}

module.exports = TranslationMemory;
