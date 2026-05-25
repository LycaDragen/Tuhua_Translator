/**
 * Glossary Service
 * Manages translation glossary entries for consistent terminology.
 * Supports exact match, case-insensitive, and regex patterns.
 * Applied as pre-processing (before translation) and post-processing (after).
 */
const Store = require('electron-store');

class GlossaryService {
  constructor() {
    this.store = new Store({
      name: 'glossary',
      defaults: {
        entries: []  // [{ id, source, target, mode, enabled, createdAt }]
      }
    });
  }

  getAll() {
    return this.store.get('entries', []);
  }

  getEnabled() {
    return this.store.get('entries', []).filter(e => e.enabled !== false);
  }

  add(entry) {
    const entries = this.store.get('entries', []);
    const newEntry = {
      id: this._generateId(),
      source: entry.source || '',
      target: entry.target || '',
      mode: entry.mode || 'exact',  // 'exact', 'case-insensitive', 'regex'
      enabled: entry.enabled !== undefined ? entry.enabled : true,
      createdAt: Date.now()
    };
    entries.push(newEntry);
    this.store.set('entries', entries);
    return newEntry;
  }

  update(id, updates) {
    const entries = this.store.get('entries', []);
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return null;
    entries[idx] = { ...entries[idx], ...updates, id };
    this.store.set('entries', entries);
    return entries[idx];
  }

  delete(id) {
    let entries = this.store.get('entries', []);
    entries = entries.filter(e => e.id !== id);
    this.store.set('entries', entries);
  }

  /**
   * Replace all glossary entries (used by profile loading)
   */
  replaceAll(newEntries) {
    this.store.set('entries', newEntries);
  }

  /**
   * Apply glossary replacements to text (pre-translation)
   */
  applyPreTranslation(text) {
    const entries = this.getEnabled();
    let result = text;
    for (const entry of entries) {
      result = this._applyEntry(result, entry);
    }
    return result;
  }

  /**
   * Apply glossary replacements to translation (post-translation)
   * Useful for terms that the translation engine doesn't know
   */
  applyPostTranslation(text) {
    const entries = this.getEnabled();
    let result = text;
    for (const entry of entries) {
      result = this._applyEntry(result, entry);
    }
    return result;
  }

  _applyEntry(text, entry) {
    try {
      switch (entry.mode) {
        case 'exact':
          return text.split(entry.source).join(entry.target);
        case 'case-insensitive': {
          const regex = new RegExp(this._escapeRegex(entry.source), 'gi');
          return text.replace(regex, entry.target);
        }
        case 'regex': {
          const regex = new RegExp(entry.source, 'g');
          return text.replace(regex, entry.target);
        }
        default:
          return text;
      }
    } catch (e) {
      // Invalid regex or pattern, skip
      return text;
    }
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
  }

  /**
   * Import glossary from JSON file
   */
  importFromFile(filePath) {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Invalid glossary format');

    const entries = this.store.get('entries', []);
    let imported = 0;
    for (const item of data) {
      if (item.source && item.target) {
        entries.push({
          id: this._generateId(),
          source: item.source,
          target: item.target,
          mode: item.mode || 'exact',
          enabled: item.enabled !== undefined ? item.enabled : true,
          createdAt: Date.now()
        });
        imported++;
      }
    }
    this.store.set('entries', entries);
    return imported;
  }

  /**
   * Export glossary to JSON file
   */
  exportToFile(filePath) {
    const fs = require('fs');
    const entries = this.store.get('entries', []);
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
    return entries.length;
  }
}

module.exports = GlossaryService;
