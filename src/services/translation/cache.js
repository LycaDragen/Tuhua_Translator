/**
 * Translation Cache Service
 * Persistent LRU cache for translations.
 * Stores translations in electron-store to survive restarts.
 * Key format: hash(sourceText + srcLang + targetLang + engine + variant)
 */
const Store = require('electron-store');
const crypto = require('crypto');

class TranslationCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 5000;
    this.ttl = options.ttl || 24 * 60 * 60 * 1000; // 24 hours default

    this.store = new Store({
      name: 'translation-cache',
      defaults: {
        entries: {},   // key -> { translation, timestamp, engine }
        order: []      // LRU order (most recent last)
      }
    });

    // v3.13.111 (Ronda 4a): electron-store's get()/set() each do a full
    // readFileSync+JSON.parse (resp. writeFileSync) of the ENTIRE store
    // file — verified against node_modules/conf's source, `get store()`
    // re-reads from disk on every access, there's no in-memory cache
    // underneath. Every get()/set() call below used to hit disk twice
    // (entries + order) — per dialogue line, with cache.js AND
    // translation-memory.js both doing this, that was ~10 synchronous
    // disk reads + 4 atomic writes on the main process, per line, while
    // the game is running. Holding entries/order in memory (read once
    // here, written back with a single _persist() per mutation) cuts that
    // to zero reads and at most one write per call.
    this._entries = this.store.get('entries', {});
    this._order = this.store.get('order', []);
  }

  // Single atomic write for both keys — electron-store's set(object) reads
  // the file once, merges, and writes once (vs. two separate set() calls,
  // which would each do their own read+write of the whole file).
  _persist() {
    this.store.set({ entries: this._entries, order: this._order });
  }

  // v3.13.6x (LLM engine overhaul, Fase 7c): `variant` is a 5th key
  // component — pipeline.js computes it as a hash of
  // provider+model+promptTemplate+temperature+fewShot for glossaryPrompt-
  // capable engines (openai/local-llm), '' for everything else. Before
  // this, editing the prompt or switching models changed NOTHING about
  // what got cached, so a user tweaking their prompt to test an
  // improvement would see the exact same cached line for up to 24h and
  // reasonably conclude the feature didn't work.
  //
  // Deliberately excluded from `variant`: the context window. Folding
  // context in would be "more correct" (the model saw different prior
  // lines, so technically it's a different request) but would tank the
  // LLM hit rate to near-zero — repeated dialogue lines are exactly what
  // the cache exists to catch, and context legitimately differs run to
  // run for the same line. Documented here so this isn't re-litigated:
  // this is an accepted approximation, not an oversight.
  _makeKey(text, srcLang, targetLang, engine, variant = '') {
    const raw = `${text}|||${srcLang}|||${targetLang}|||${engine}|||${variant}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  get(text, srcLang, targetLang, engine, variant = '') {
    const key = this._makeKey(text, srcLang, targetLang, engine, variant);
    const entries = this._entries;
    const order = this._order;

    const entry = entries[key];
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      delete entries[key];
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      this._persist();
      return null;
    }

    // Move to end (most recently used)
    const idx = order.indexOf(key);
    if (idx !== -1) {
      order.splice(idx, 1);
      order.push(key);
      this._persist();
    }

    return entry.translation;
  }

  set(text, srcLang, targetLang, engine, translation, variant = '') {
    const key = this._makeKey(text, srcLang, targetLang, engine, variant);
    const entries = this._entries;
    const order = this._order;

    // If already exists, update
    if (entries[key]) {
      entries[key] = { translation, timestamp: Date.now(), engine };
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      order.push(key);
    } else {
      entries[key] = { translation, timestamp: Date.now(), engine };
      order.push(key);

      // Evict oldest if over max size
      while (order.length > this.maxSize) {
        const oldestKey = order.shift();
        delete entries[oldestKey];
      }
    }

    this._persist();
  }

  clear() {
    this._entries = {};
    this._order = [];
    this._persist();
  }

  size() {
    return this._order.length;
  }
}

module.exports = TranslationCache;
