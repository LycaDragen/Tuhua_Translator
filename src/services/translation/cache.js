/**
 * Translation Cache Service
 * Persistent LRU cache for translations.
 * Stores translations in electron-store to survive restarts.
 * Key format: hash(sourceText + srcLang + targetLang + engine)
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
  }

  _makeKey(text, srcLang, targetLang, engine) {
    const raw = `${text}|||${srcLang}|||${targetLang}|||${engine}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  get(text, srcLang, targetLang, engine) {
    const key = this._makeKey(text, srcLang, targetLang, engine);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

    const entry = entries[key];
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      delete entries[key];
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      this.store.set('entries', entries);
      this.store.set('order', order);
      return null;
    }

    // Move to end (most recently used)
    const idx = order.indexOf(key);
    if (idx !== -1) {
      order.splice(idx, 1);
      order.push(key);
      this.store.set('order', order);
    }

    return entry.translation;
  }

  set(text, srcLang, targetLang, engine, translation) {
    const key = this._makeKey(text, srcLang, targetLang, engine);
    const entries = this.store.get('entries', {});
    const order = this.store.get('order', []);

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
}

module.exports = TranslationCache;
