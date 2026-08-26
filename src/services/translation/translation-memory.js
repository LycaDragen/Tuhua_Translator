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
const { findBestMatch } = require('./fuzzy-matcher');

// v3.13.6x (LLM engine overhaul, Fase 7d): 'mt' entries are not reused by
// an 'llm' lookup — a plain literal-MT translation is a real quality
// downgrade an LLM setup shouldn't silently inherit — but the reverse is
// fine: an MT engine reusing an LLM's (typically more natural,
// context-aware) translation is a strict improvement over what MT would
// have produced on its own. Unknown class (missing on either side — a
// pre-Fase-7 entry, or a caller that didn't pass one) never blocks a match;
// this is an added quality signal, not a new hard requirement.
function isEngineClassCompatible(queryClass, storedClass) {
  if (!queryClass || !storedClass) return true;
  return !(queryClass === 'llm' && storedClass === 'mt');
}

// v3.13.6x (Fase 9 testing follow-up, ronda 6): whether a TM entry was
// produced by an LLM engine or an MT one, for entries written before
// `engineClass` existed (Fase 7d) or that had it stamped blank. Falls back
// to `originalEngine`, which every entry has carried since v3.11.23 —
// unlike `engineClass`, it's never been optional.
const LLM_ENGINE_NAMES = new Set(['openai', 'local-llm']);
function resolveEntryClass(entry) {
  return entry.engineClass || (LLM_ENGINE_NAMES.has(entry.originalEngine) ? 'llm' : 'mt');
}

// v3.13.6x (LLM engine overhaul, Fase 9 testing follow-up): found by real
// testing (Lyca, Nekopara Vol.1) — reloading a save and comparing prompt
// presets (Balanceado/Literal/Localizado) on the SAME line showed no
// difference, because TM had no idea the prompt had changed at all. This
// is the exact same 5th key component cache.js's 24h cache already gates
// on (`variant` — a hash of providerId|model|promptTemplate|temperature|
// fewShotEnabled, see pipeline.js's _cacheVariant and cache.js's Fase 7c
// header) — TM was only ever given `engineClass` (Fase 7d), never this.
// Unlike engineClass's llm>mt asymmetry, there's no "better" variant here
// — two prompts are just different — so a real stored variant means a
// plain equality check.
//
// v3.13.6x (Fase 9 testing follow-up, ronda 6): tightened. The original
// "unknown never blocks" leniency (either side blank matches anything) was
// found, by real testing across 3 sessions, to be the actual reason prompt-
// preset comparisons looked broken in normal play: hundreds of TM entries
// written before `variant` existed answered EVERY preset for the rest of
// their 30-day TTL, silently. The leniency is still correct and still
// needed for MT engines — DeepL/Google always carry `variant=''` by
// construction (see `_cacheVariant`'s early return for non-glossaryPrompt
// engines), so an MT entry must stay reachable no matter what an LLM query
// asks for; orphaning those was never the goal. What must stop matching is
// a BLANK-variant entry that an LLM engine actually wrote — that's "some
// unknown prompt produced this," which is precisely the ambiguity a real
// `variant` exists to resolve. `entry` is passed whole here (not just its
// `.variant`) so this can call `resolveEntryClass()`.
function isVariantCompatible(queryVariant, entry) {
  if (!queryVariant) return true; // the query itself has no preference (e.g. an MT engine)
  if (entry.variant) return queryVariant === entry.variant;
  return resolveEntryClass(entry) === 'mt';
}

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
    // v3.13.6x (Fase 7d): TM previously had NO expiry at all — an entry
    // written once lived forever. 30 days (much longer than the engine
    // cache's 24h — TM is explicitly meant to persist across sessions/
    // restarts, that's its whole purpose) balances "still useful weeks
    // into replaying a long VN" against "doesn't accumulate translations
    // for games nobody's played in months".
    this.ttl = options.ttl || 30 * 24 * 60 * 60 * 1000;
    // Cache the plain-text index for fuzzy lookups (rebuilt lazily)
    this._fuzzyIndex = null;
    this._fuzzyIndexDirty = true;

    this.store = new Store({
      name: 'translation-memory',
      defaults: {
        entries: {},   // key -> { sourceText, translation, srcLang, tgtLang, timestamp, originalEngine, engineClass, profileId, variant }
        order: []      // LRU order (most recent last)
      }
    });
  }

  // v3.13.6x (Fase 7d): `profileId` namespaces the key — before this, a
  // TM entry from one VN (profile) could silently answer a lookup for a
  // completely different VN whose dialogue happened to share a line
  // (common for short/generic lines: "はい。", "わかった。"). '' (no
  // active profile, or a pipeline built without profileStore — existing
  // benches) preserves the old global-namespace behavior exactly.
  _makeKey(text, srcLang, targetLang, profileId = '') {
    const raw = `${text}|||${srcLang}|||${targetLang}|||${profileId}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * v3.13.6x (Fase 9 testing follow-up, ronda 6): the entry-fetching guts of
   * `get()`, factored out so `getWithFuzzy()` can read `entry.variant` for
   * its diagnostic logging (pipeline.js's "Translation Memory ... hit"
   * line) without duplicating the TTL-eviction/LRU-touch side effects, and
   * without changing `get()`'s own return type (a bare string|null) — that
   * shape is load-bearing for every existing caller/test
   * (scripts/test-translation-memory.js compares `tm.get(...) === 'X'`
   * directly, dozens of times).
   */
  _getEntry(text, srcLang, targetLang, profileId = '', engineClass = '', variant = '') {
    if (!this.enabled) return null;

    const key = this._makeKey(text, srcLang, targetLang, profileId);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

    const entry = entries[key];
    if (!entry) return null;

    // v3.13.6x (Fase 7d): TTL — see the constructor comment for why 30
    // days, not the engine cache's 24h. Expired entries are evicted here,
    // same pattern as cache.js's get().
    if (Date.now() - entry.timestamp > this.ttl) {
      delete entries[key];
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      this.store.set('entries', entries);
      this.store.set('order', order);
      this._fuzzyIndexDirty = true;
      return null;
    }

    if (!isEngineClassCompatible(engineClass, entry.engineClass)) return null;
    if (!isVariantCompatible(variant, entry)) return null;

    // Update LRU order
    const idx = order.indexOf(key);
    if (idx !== -1) {
      order.splice(idx, 1);
      order.push(key);
      this.store.set('order', order);
    }

    return entry;
  }

  /**
   * Exact match lookup.
   * Returns translation string or null.
   */
  get(text, srcLang, targetLang, profileId = '', engineClass = '', variant = '') {
    const entry = this._getEntry(text, srcLang, targetLang, profileId, engineClass, variant);
    return entry ? entry.translation : null;
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
   * @param {string} [profileId] - v3.13.6x (Fase 7d): scopes the search to
   *   one VN's own entries — see _makeKey's comment for why cross-profile
   *   bleed is a real bug, not a feature.
   * @param {string} [engineClass] - v3.13.6x (Fase 7d): 'llm'|'mt', see
   *   isEngineClassCompatible.
   * @param {string} [variant] - v3.13.6x (Fase 9 follow-up): see
   *   isVariantCompatible.
   * @returns {{ translation: string, score: number, originalText: string } | null}
   */
  getFuzzy(text, srcLang, targetLang, profileId = '', engineClass = '', variant = '') {
    if (!this.enabled || !this.fuzzyEnabled) return null;

    // Rebuild fuzzy index if dirty
    if (this._fuzzyIndexDirty) {
      this._rebuildFuzzyIndex();
    }

    const langKey = `${srcLang}|||${targetLang}|||${profileId}`;
    const allCandidates = this._fuzzyIndex.get(langKey);
    if (!allCandidates || allCandidates.length === 0) return null;
    // Asymmetric/non-hierarchical, so neither can be folded into langKey
    // the way profileId was — filtered here instead of at index-build time.
    const candidates = allCandidates
      .filter((c) => isEngineClassCompatible(engineClass, c.engineClass))
      .filter((c) => isVariantCompatible(variant, c));
    if (candidates.length === 0) return null;

    const result = findBestMatch(text, candidates, this.fuzzyThreshold);
    if (result.match) {
      log.info(`[TM] Fuzzy hit: score=${(result.score * 100).toFixed(0)}%, "${text.substring(0, 30)}..." ≈ "${result.match.text.substring(0, 30)}..."`);
      return {
        translation: result.match.translation,
        score: result.score,
        originalText: result.match.text,
        // v3.13.6x (Fase 9 testing follow-up, ronda 6): `result.match` IS
        // the candidate object built in _rebuildFuzzyIndex(), which already
        // carries `variant` — threaded through here for the same
        // diagnostic reason as _getEntry() below.
        variant: result.match.variant || ''
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
  getWithFuzzy(text, srcLang, targetLang, profileId = '', engineClass = '', variant = '') {
    // 1. Try exact match first (O(1), always preferred)
    // v3.13.6x (Fase 9 testing follow-up, ronda 6): reads the full entry
    // (via _getEntry) instead of just the translation string, so the
    // returned `variant` can tell pipeline.js's diagnostic log whether this
    // hit came from a legacy (blank-variant) entry — see _getEntry's own
    // comment for why get() itself keeps returning a bare string.
    const exactEntry = this._getEntry(text, srcLang, targetLang, profileId, engineClass, variant);
    if (exactEntry) {
      return { translation: exactEntry.translation, fuzzy: false, variant: exactEntry.variant || '' };
    }

    // 2. Try fuzzy match (O(n), fallback)
    // v3.13.07: Validate fuzzy matches — skip if source texts differ
    // significantly in length, as this often indicates different dialogue
    // that happens to share character overlap (e.g., "行くよ！" vs "行かない！")
    const fuzzyResult = this.getFuzzy(text, srcLang, targetLang, profileId, engineClass, variant);
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
        originalText: fuzzyResult.originalText,
        variant: fuzzyResult.variant || ''
      };
    }

    return null;
  }

  set(text, srcLang, targetLang, translation, engineName, profileId = '', engineClass = '', variant = '') {
    if (!this.enabled) return;

    const key = this._makeKey(text, srcLang, targetLang, profileId);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

    if (entries[key]) {
      entries[key] = {
        sourceText: text,   // v3.11.25: Store plain text for fuzzy matching
        srcLang,
        tgtLang: targetLang,
        translation,
        timestamp: Date.now(),
        originalEngine: engineName || entries[key].originalEngine,
        profileId,
        engineClass: engineClass || entries[key].engineClass,
        variant: variant || entries[key].variant
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
        originalEngine: engineName || 'unknown',
        profileId,
        engineClass,
        variant
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

      // v3.13.6x (Fase 7d): profileId folded into the grouping key itself
      // (unlike engineClass — see getFuzzy's comment for why that one has
      // to stay a post-filter) — a lookup for profile A must never even
      // SEE profile B's candidates, symmetric in both directions.
      const langKey = `${entry.srcLang || 'auto'}|||${entry.tgtLang || 'es'}|||${entry.profileId || ''}`;
      if (!this._fuzzyIndex.has(langKey)) {
        this._fuzzyIndex.set(langKey, []);
      }
      this._fuzzyIndex.get(langKey).push({
        text: entry.sourceText,
        translation: entry.translation,
        engineClass: entry.engineClass || '',
        variant: entry.variant || '',
        // v3.13.6x (Fase 9 testing follow-up, ronda 6): resolveEntryClass()
        // needs this to classify a legacy blank-`engineClass` candidate —
        // see isVariantCompatible's header comment.
        originalEngine: entry.originalEngine || ''
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
