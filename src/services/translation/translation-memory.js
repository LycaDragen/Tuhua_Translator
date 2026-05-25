/**
 * Translation Memory Service
 * v3.11.23: Engine-agnostic persistent translation memory.
 * Unlike the engine-specific cache, this stores translations keyed by
 * (sourceText, srcLang, tgtLang) WITHOUT the engine — so if you switch
 * from Google to DeepL, repeated dialogue gets an instant cache hit
 * without making a new API call.
 *
 * This is especially valuable for VNs with branching paths where
 * the same dialogue repeats across different routes.
 */
const Store = require('electron-store');
const crypto = require('crypto');

class TranslationMemory {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 10000;
    this.enabled = options.enabled !== undefined ? options.enabled : true;

    this.store = new Store({
      name: 'translation-memory',
      defaults: {
        entries: {},   // key -> { translation, timestamp, originalEngine }
        order: []      // LRU order (most recent last)
      }
    });
  }

  _makeKey(text, srcLang, targetLang) {
    // No engine in key — this is engine-agnostic
    const raw = `${text}|||${srcLang}|||${targetLang}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

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

  set(text, srcLang, targetLang, translation, engineName) {
    if (!this.enabled) return;

    const key = this._makeKey(text, srcLang, targetLang);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

    if (entries[key]) {
      entries[key] = { translation, timestamp: Date.now(), originalEngine: engineName || entries[key].originalEngine };
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      order.push(key);
    } else {
      entries[key] = { translation, timestamp: Date.now(), originalEngine: engineName || 'unknown' };
      order.push(key);

      // Evict oldest if over max size
      while (order.length > this.maxSize) {
        const oldestKey = order.shift();
        delete entries[oldestKey];
      }
    }

    this.store.set('entries', entries);
    this.store.set('order', order);
  }

  clear() {
    this.store.set('entries', {});
    this.store.set('order', []);
  }

  size() {
    return this.store.get('order', []).length;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }
}

module.exports = TranslationMemory;
