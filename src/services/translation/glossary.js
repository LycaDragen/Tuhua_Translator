/**
 * Glossary Service
 * Manages translation glossary entries for consistent terminology.
 * Supports exact match, case-insensitive, and regex patterns.
 * Applied as pre-processing (before translation) and post-processing (after).
 *
 * Two layers: the GLOBAL layer (this.store, `entries[]`, shared across all
 * games) and a PER-PROFILE layer (`setProfileLayer()`, in-memory only —
 * profiles/profile-store.js is what persists it). getEffective() merges
 * them via glossary-merge.js, profile winning on conflict; both
 * applyPreTranslation/applyPostTranslation read the merged result.
 */
const glossaryMerge = require('./glossary-merge');
const glossaryEntries = require('./glossary-entries');

// v3.13.40 (profiles Phase 1, step 2): require('electron-store') moved
// inside the constructor's no-store branch instead of at module load —
// this is what makes glossary.js requireable from a plain-Node bench with
// an injected fake store and zero Electron/disk dependency (see
// scripts/test-glossary-merge.js, which already calls
// GlossaryService.prototype._applyEntry without ever instantiating Store).
function createDefaultStore() {
  const Store = require('electron-store');
  return new Store({
    name: 'glossary',
    defaults: {
      entries: []  // [{ id, source, target, mode, enabled, createdAt }]
    }
  });
}

class GlossaryService {
  constructor(store) {
    this.store = store || createDefaultStore();
    this._profileEntries = [];
    this._effectiveDirty = true;
    this._effectiveCache = [];
    // v3.13.55: entry.id -> {id, source, mode, error}. Populated by
    // _applyEntry's catch (see there) and refreshed on every getEffective()
    // recompute — see the self-test loop below. Previously a bad regex
    // pattern (invalid syntax) was caught and silently discarded with no
    // way for the user to find out their entry wasn't doing anything.
    this._compileErrors = new Map();
  }

  _invalidateEffective() {
    this._effectiveDirty = true;
  }

  /**
   * Sets the in-memory per-profile glossary layer — called on profile
   * switch (and at startup for the active profile). Not persisted by this
   * class; profile-store.js owns writing profile.glossary to disk.
   */
  setProfileLayer(entries) {
    this._profileEntries = Array.isArray(entries) ? entries : [];
    this._invalidateEffective();
  }

  /**
   * The merged, effective glossary: profile layer entries first, global
   * layer entries after, profile winning on (mode, source) conflict — see
   * glossary-merge.js for why the order is functional, not cosmetic.
   */
  getEffective() {
    if (this._effectiveDirty) {
      this._effectiveCache = glossaryMerge.mergeGlossaryLayers(this.getEnabled(), this._profileEntries);
      this._effectiveDirty = false;
      // v3.13.55: self-test every entry against an empty string right when the
      // merged list changes, instead of only finding out an entry is broken
      // whenever real translation traffic happens to route through it (which,
      // for a rarely-matched term, could be never). Clear first — an entry
      // that was fixed or removed since the last recompute must not leave a
      // stale error behind.
      this._compileErrors.clear();
      for (const entry of this._effectiveCache) {
        this._applyEntry('', entry);
      }
    }
    return this._effectiveCache;
  }

  /**
   * Glossary entries whose pattern failed to compile/apply (e.g. invalid
   * regex syntax). Surfaced to the UI via the `get-glossary` IPC response so
   * a bad entry shows a warning instead of silently doing nothing.
   * Calls getEffective() itself — _compileErrors is only ever refreshed
   * inside that recompute, so reading it without forcing that first would
   * silently return stale data after any add/update/delete/setProfileLayer.
   */
  getCompileErrors() {
    this.getEffective();
    return Array.from(this._compileErrors.values());
  }

  getAll() {
    return this.store.get('entries', []);
  }

  getEnabled() {
    return this.store.get('entries', []).filter(e => e.enabled !== false);
  }

  add(entry) {
    const { list, entry: newEntry } = glossaryEntries.addEntry(this.store.get('entries', []), entry);
    this.store.set('entries', list);
    this._invalidateEffective();
    return newEntry;
  }

  update(id, updates) {
    const { list, entry } = glossaryEntries.updateEntry(this.store.get('entries', []), id, updates);
    if (!entry) return null;
    this.store.set('entries', list);
    this._invalidateEffective();
    return entry;
  }

  delete(id) {
    this.store.set('entries', glossaryEntries.removeEntry(this.store.get('entries', []), id));
    this._invalidateEffective();
  }

  /**
   * Replace all glossary entries (used by profile loading)
   */
  replaceAll(newEntries) {
    this.store.set('entries', newEntries);
    this._invalidateEffective();
  }

  /**
   * Apply glossary replacements to text (pre-translation)
   */
  applyPreTranslation(text) {
    return this._apply(text);
  }

  /**
   * Apply glossary replacements to translation (post-translation)
   * Useful for terms that the translation engine doesn't know
   */
  applyPostTranslation(text) {
    return this._apply(text);
  }

  _apply(text) {
    let result = text;
    for (const entry of this.getEffective()) {
      result = this._applyEntry(result, entry);
    }
    return result;
  }

  _applyEntry(text, entry) {
    // v3.13.55: clear any stale error for this id before re-attempting — a
    // previously-broken entry that now compiles fine must not keep showing
    // as broken. Only meaningful when getEffective()'s self-test loop calls
    // this repeatedly on recompute; a no-op the rest of the time.
    // `this._compileErrors` may not exist here: scripts/test-glossary-merge.js
    // deliberately calls `GlossaryService.prototype._applyEntry.call(proto, ...)`
    // without ever running the constructor, to test this method with zero
    // store/disk dependency — guard instead of requiring that setup to change.
    if (entry.id != null && this._compileErrors) {
      this._compileErrors.delete(entry.id);
    }
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
      // v3.13.55: this used to just discard the error — invalid regex syntax
      // (the overwhelmingly likely cause; 'exact'/'case-insensitive' can't
      // really throw here) meant the entry silently did nothing, forever,
      // with zero signal to the user. Now recorded so getCompileErrors() /
      // the UI can surface it. Same bare-prototype guard as above.
      if (entry.id != null && this._compileErrors) {
        this._compileErrors.set(entry.id, { id: entry.id, source: entry.source, mode: entry.mode, error: e.message });
      }
      return text;
    }
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Import glossary from JSON file
   */
  importFromFile(filePath) {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { list, imported } = glossaryEntries.importEntries(this.store.get('entries', []), data);
    this.store.set('entries', list);
    this._invalidateEffective();
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
