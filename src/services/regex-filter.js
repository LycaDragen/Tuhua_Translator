/**
 * Regex Filter Service
 *
 * Text preprocessing pipeline for cleaning game text before translation.
 * Inspired by LunaTranslator's post-processing system.
 *
 * Features:
 * - Built-in preset filters for common game text cleanup
 * - Custom user-defined regex/literal replace rules
 * - Ordered execution pipeline
 * - Per-filter enable/disable toggle
 * - Error-tolerant: invalid regex patterns are skipped gracefully
 * - Multiple filter types: regex, literal, and normalize
 *
 * Filter entry structure:
 * {
 *   id: string,           — unique identifier (UUID for custom, slug for built-in)
 *   name: string,         — display name (i18n key for built-in, raw text for custom)
 *   type: string,         — 'regex' (default), 'normalize' — processing type
 *   pattern: string,      — search pattern (regex or literal) — unused for 'normalize'
 *   replacement: string,  — replacement string (supports $1, $2, etc. for regex) — unused for 'normalize'
 *   isRegex: boolean,     — true = regex, false = literal string — unused for 'normalize'
 *   isCaseSensitive: boolean, — case sensitivity flag — unused for 'normalize'
 *   enabled: boolean,     — on/off
 *   isBuiltIn: boolean,   — preset vs user-defined
 *   order: number,        — execution order (lower = earlier)
 *   description: string   — what it does (i18n key for built-in)
 * }
 */

const Store = require('electron-store');
const crypto = require('crypto');

// ============================================================
// BUILT-IN PRESET FILTERS
// ============================================================
// These are predefined filters that users can toggle but not edit/delete.
// They target common patterns in visual novel / game text extraction.

const BUILT_IN_FILTERS = [
  {
    id: 'builtin-unicode-normalize',
    name: 'regex_filter_builtin_unicode_normalize',
    // Unicode NFKC normalization — converts fullwidth/halfwidth compatibility characters
    // to their canonical forms. This MUST run first (order: 1) so that subsequent
    // regex filters can match normalized text.
    // Examples: Ａ→A, １→1, ！！！→!!!, ｶﾀｶﾅ→カタカナ, ﬁ→fi
    // Inspired by LunaTranslator's fulltohalf filter (NFKC by default).
    type: 'normalize',
    pattern: '',
    replacement: '',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 1,
    description: 'regex_filter_builtin_unicode_normalize_desc',
    example: '\uFF28\uFF45\uFF4C\uFF4C\uFF4F \uFF11\uFF12\uFF13 \u2192 Hello 123'
  },
  {
    id: 'builtin-remove-control-chars',
    name: 'regex_filter_builtin_control',
    // ASCII control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F, 0x80-0x9F C1, FEFF BOM)
    // + literal \xNN escape sequences (some game hooks output escaped text)
    // Inspired by LunaTranslator's is_ascii_control() ranges which include C1 (0x80-0x9F)
    // Excludes \r (0x0D) and \n (0x0A) — those are handled by the newline filter
    pattern: '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F\\uFEFF]|\\\\x[0-9A-Fa-f]{2}',
    replacement: ' ',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 5,
    description: 'regex_filter_builtin_control_desc',
    example: 'Hello\\x07World \u2192 Hello World'
  },
  {
    id: 'builtin-remove-angle-brackets',
    name: 'regex_filter_builtin_angle_brackets',
    // Remove ANY content in angle brackets (speaker names, UI elements, tags, etc.)
    // This is the primary filter — it catches <Narumi>, <color=red>, </color>, etc.
    pattern: '<[^>]+>',
    replacement: '',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 10,
    description: 'regex_filter_builtin_angle_brackets_desc',
    example: '<Narumi>Hello \u2192 Hello'
  },
  {
    id: 'builtin-remove-html-tags',
    name: 'regex_filter_builtin_html',
    // More specific: only matches proper HTML/XML tags with attributes or closing tags.
    // Disabled by default since "Remove angle bracket content" above handles all cases.
    // Enable this if you want to keep angle bracket text (like <Narumi>) but strip
    // proper HTML attributes (like <span class="x">).
    pattern: '</?[a-zA-Z][a-zA-Z0-9]*(?:\\s[^>]*)?>',
    replacement: '',
    isRegex: true,
    isCaseSensitive: false,
    enabled: false,
    isBuiltIn: true,
    order: 15,
    description: 'regex_filter_builtin_html_desc',
    example: '<span class="x">Hi</span> \u2192 Hi'
  },
  {
    id: 'builtin-remove-furigana',
    name: 'regex_filter_builtin_furigana',
    // Matches {kanji/reading} and {kanji|reading} patterns — keeps kanji
    pattern: '\\{([^}/|]+)[/|][^}]+\\}',
    replacement: '$1',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 20,
    description: 'regex_filter_builtin_furigana_desc',
    example: '{\u4E16\u754C/\u305B\u304B\u3044}\u3053\u3093\u306B\u3061\u306F \u2192 \u4E16\u754C\u3053\u3093\u306B\u3061\u306F'
  },
  {
    id: 'builtin-remove-rpgmaker-codes',
    name: 'regex_filter_builtin_rpgmaker',
    // Matches RPG Maker escape codes: \c[2], \n[1], \g, \v[5], etc.
    pattern: '\\\\[CcNnVv]\\[\\d+\\]|\\\\[Gg]',
    replacement: '',
    isRegex: true,
    isCaseSensitive: false,
    enabled: false,
    isBuiltIn: true,
    order: 30,
    description: 'regex_filter_builtin_rpgmaker_desc',
    example: '\\c[2]Hello\\n[1] \u2192 Hello'
  },
  {
    id: 'builtin-remove-renpy-tags',
    name: 'regex_filter_builtin_renpy',
    // Matches Ren'Py text tags: {b}...{/b}, {i}...{/i}, {size=20}...{/size}, {fast}, etc.
    pattern: '\\{/?[a-zA-Z][a-zA-Z0-9=]*[^}]*\\}',
    replacement: '',
    isRegex: true,
    isCaseSensitive: false,
    enabled: false,
    isBuiltIn: true,
    order: 40,
    description: 'regex_filter_builtin_renpy_desc',
    example: '{b}Hello{/b} \u2192 Hello'
  },
  {
    id: 'builtin-collapse-whitespace',
    name: 'regex_filter_builtin_whitespace',
    pattern: '\\s{2,}',
    replacement: ' ',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 50,
    description: 'regex_filter_builtin_whitespace_desc',
    example: 'Hello    World \u2192 Hello World'
  },
  {
    id: 'builtin-remove-newlines',
    name: 'regex_filter_builtin_newlines',
    // Matches actual newlines (\r?\n) AND literal escape sequences (\n, \r\n, \\n, \\r\\n, etc.)
    // Second alternative: one or more backslashes + optional(r + one or more backslashes) + n
    // Handles single backslash (\n), double backslash (\\n), and any combination
    // Inspired by LunaTranslator's newline filter which joins splitlines() with spaces.
    pattern: '\\r?\\n|\\\\+(?:r\\\\+)?n',
    replacement: ' ',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 60,
    description: 'regex_filter_builtin_newlines_desc',
    example: 'Hello\\nWorld \u2192 Hello World'
  },
  {
    id: 'builtin-extract-japanese-quotes',
    name: 'regex_filter_builtin_jp_quotes',
    // Extract only text inside Japanese quotation marks 「」
    // This is a special filter — it replaces the ENTIRE text with the extracted content
    pattern: '^[^「]*「([^」]*)」[^」]*$',
    replacement: '$1',
    isRegex: true,
    isCaseSensitive: false,
    enabled: true,
    isBuiltIn: true,
    order: 70,
    description: 'regex_filter_builtin_jp_quotes_desc',
    example: '\u540D\u524D\u300C\u3053\u3093\u306B\u3061\u306F\u300D \u2192 \u3053\u3093\u306B\u3061\u306F'
  }
];

// v3.13.111 (Ronda 4e): compiled RegExp objects, cached by (pattern,flags)
// content rather than by filter id — a filter's pattern/flags are the only
// thing that determines the compiled result, so this stays correct across
// edits without needing explicit invalidation, and is shared across every
// RegexFilterService instance (there's only ever one in practice, but this
// doesn't assume that). Reusing a global-flag RegExp across `.replace()`
// calls on different strings is safe: per spec, `[Symbol.replace]` resets
// `lastIndex` to 0 itself when `global` is true — verified in Node before
// relying on it (see scripts/test-regex-filter.js if a bench exists).
const _compiledRegexCache = new Map();
function getCompiledRegex(pattern, flags) {
  const key = flags + ' ' + pattern;
  let re = _compiledRegexCache.get(key);
  if (!re) {
    re = new RegExp(pattern, flags);
    _compiledRegexCache.set(key, re);
  }
  return re;
}

// Languages without spaces between words (LunaTranslator-style) — module
// level so apply() doesn't rebuild this Set on every dialogue line.
const NO_SPACE_LANGS = new Set(['ja', 'zh', 'cht', 'lzh', 'ko']);

class RegexFilterService {
  constructor() {
    this.store = new Store({ name: 'regex-filters' });
    // v3.13.111 (Ronda 4e, same fix as cache.js/translation-memory.js —
    // Ronda 4a): read once, mutate in memory, single _persist() write.
    // getEnabled() used to trigger a full store.get() (disk read) on
    // EVERY apply() call — once per dialogue line while the game runs.
    this._entries = this.store.get('entries', []);
    this._ensureBuiltInFilters();
  }

  _persist() {
    this.store.set('entries', this._entries);
  }

  /**
   * Ensure built-in filters are present in the store.
   * New built-in filters added in updates will be merged in.
   */
  _ensureBuiltInFilters() {
    const entries = this._entries;

    // Find existing built-in IDs
    const existingBuiltInIds = new Set(
      entries.filter(e => e.isBuiltIn).map(e => e.id)
    );

    let modified = false;
    for (const preset of BUILT_IN_FILTERS) {
      if (!existingBuiltInIds.has(preset.id)) {
        // Add new built-in filter (preserving user's enabled state from previous version)
        entries.push({ ...preset });
        modified = true;
      } else {
        // Update built-in filter pattern/replacement if changed in code
        const idx = entries.findIndex(e => e.id === preset.id);
        if (idx >= 0) {
          const existing = entries[idx];
          // Update pattern and replacement but preserve user's enabled state
          entries[idx] = {
            ...preset,
            enabled: existing.enabled, // Keep user's toggle state
            order: existing.order !== undefined ? existing.order : preset.order
          };
          modified = true;
        }
      }
    }

    // Remove built-in filters that no longer exist in code (cleanup)
    const currentBuiltInIds = new Set(BUILT_IN_FILTERS.map(f => f.id));
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].isBuiltIn && !currentBuiltInIds.has(entries[i].id)) {
        entries.splice(i, 1);
        modified = true;
      }
    }

    // v3.11.34 migration: Force-enable Japanese quotes filter
    // (was incorrectly disabled by default in v3.11.33 and earlier)
    const schemaVersion = this.store.get('schemaVersion', 0);
    if (schemaVersion < 1) {
      const jpQuotes = entries.find(e => e.id === 'builtin-extract-japanese-quotes');
      if (jpQuotes && !jpQuotes.enabled) {
        jpQuotes.enabled = true;
        modified = true;
      }
      this.store.set('schemaVersion', 1);
    }

    if (modified) {
      this._persist();
    }
  }

  /**
   * Get all filters (built-in + custom), sorted by execution order.
   */
  getAll() {
    const entries = this._entries;
    return entries.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /**
   * Get all enabled filters, sorted by execution order.
   */
  getEnabled() {
    return this.getAll().filter(e => e.enabled);
  }

  /**
   * Get a single filter by ID.
   */
  getById(id) {
    return this._entries.find(e => e.id === id) || null;
  }

  /**
   * Add a new custom filter.
   */
  add(entry) {
    const newEntry = {
      id: 'custom-' + crypto.randomUUID(),
      name: entry.name || '',
      type: entry.type || 'regex',
      pattern: entry.pattern || '',
      replacement: entry.replacement || '',
      isRegex: entry.isRegex !== undefined ? entry.isRegex : true,
      isCaseSensitive: entry.isCaseSensitive || false,
      enabled: entry.enabled !== undefined ? entry.enabled : true,
      isBuiltIn: false,
      order: entry.order !== undefined ? entry.order : this._nextOrder(),
      description: entry.description || ''
    };
    this._entries.push(newEntry);
    this._persist();
    return newEntry;
  }

  /**
   * Update an existing filter.
   * Built-in filters can only have their `enabled` state changed.
   */
  update(id, updates) {
    const entries = this._entries;
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return null;

    const existing = entries[idx];

    if (existing.isBuiltIn) {
      // Only allow toggling enabled state for built-in filters
      if (updates.enabled !== undefined) {
        entries[idx].enabled = updates.enabled;
      }
      if (updates.order !== undefined) {
        entries[idx].order = updates.order;
      }
    } else {
      // Custom filters: allow full update
      entries[idx] = { ...existing, ...updates, id: existing.id, isBuiltIn: false };
    }

    this._persist();
    return entries[idx];
  }

  /**
   * Delete a custom filter. Built-in filters cannot be deleted.
   */
  delete(id) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry) return false;
    if (entry.isBuiltIn) return false; // Cannot delete built-in

    this._entries = this._entries.filter(e => e.id !== id);
    this._persist();
    return true;
  }

  /**
   * Toggle a filter's enabled state.
   */
  toggle(id, enabled) {
    return this.update(id, { enabled });
  }

  /**
   * Reorder filters by providing an array of IDs in desired order.
   */
  reorder(orderedIds) {
    if (!Array.isArray(orderedIds)) return false;
    const entries = this._entries;
    const orderMap = {};
    orderedIds.forEach((id, idx) => { orderMap[id] = idx * 10; });
    for (const entry of entries) {
      if (orderMap[entry.id] !== undefined) {
        entry.order = orderMap[entry.id];
      }
    }
    this._persist();
    return true;
  }

  /**
   * Apply a single filter to text.
   * Handles different filter types: regex, literal, normalize.
   *
   * @param {string} text — Input text
   * @param {object} filter — Filter entry
   * @param {boolean} isNoSpaceLang — Whether source language uses no spaces (ja/zh/ko)
   * @returns {string} Filtered text
   */
  _applyFilter(text, filter, isNoSpaceLang) {
    // Type: normalize — Unicode normalization (NFKC)
    if (filter.type === 'normalize') {
      return text.normalize('NFKC');
    }

    // Determine replacement (language-aware for specific filters)
    let replacement = filter.replacement;
    if (isNoSpaceLang && replacement === ' ' &&
        (filter.id === 'builtin-remove-newlines' || filter.id === 'builtin-remove-control-chars')) {
      replacement = '';
    }

    if (filter.isRegex) {
      // Regex mode — v3.13.111 (Ronda 4e): compiled+cached instead of a
      // fresh `new RegExp()` per line per filter (was the 2nd-costliest
      // hot-path finding after the store reads, per Lyca's approval order).
      const flags = filter.isCaseSensitive ? 'g' : 'gi';
      const regex = getCompiledRegex(filter.pattern, flags);
      return text.replace(regex, replacement);
    } else {
      // Literal string mode — escape the pattern for safe regex use
      const escaped = filter.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = filter.isCaseSensitive ? 'g' : 'gi';
      const regex = getCompiledRegex(escaped, flags);
      // For literal mode, escape $ in replacement to prevent backreference interpretation
      const safeReplacement = replacement.replace(/\$/g, '$$$$');
      return text.replace(regex, safeReplacement);
    }
  }

  /**
   * Apply all enabled filters to the input text.
   * Returns the filtered text.
   * Invalid regex patterns are silently skipped.
   *
   * Inspired by LunaTranslator's _6_fEX newline filter which uses language-aware
   * replacement: '' for ja/zh (no spaces between words), ' ' for other languages.
   *
   * @param {string} text — The input text to filter
   * @param {string} [srcLang] — Source language code (e.g. 'ja', 'zh', 'en') for language-aware filters
   * v1.0.6: `appliedCount` counts the filters that ACTUALLY CHANGED the
   * text, not the ones that were run. It used to be `appliedCount++` per
   * loop iteration, which made it a restatement of `enabledCount` — every
   * line in a real log said "7 applied" whether the text came out modified
   * or byte-for-byte identical, so the one number meant to answer "did a
   * filter eat my text?" couldn't answer it. `enabledCount` is returned
   * alongside so the log can still show both halves (`3/7`).
   *
   * @returns {{ text: string, appliedCount: number, enabledCount: number, skipped: string[] }}
   */
  apply(text, srcLang) {
    if (!text || typeof text !== 'string') return { text: text || '', appliedCount: 0, enabledCount: 0, skipped: [] };

    const isNoSpaceLang = NO_SPACE_LANGS.has((srcLang || '').toLowerCase());

    const enabledFilters = this.getEnabled();
    let result = text;
    let appliedCount = 0;
    const skipped = [];

    for (const filter of enabledFilters) {
      try {
        const before = result;
        result = this._applyFilter(result, filter, isNoSpaceLang);
        if (result !== before) appliedCount++;
      } catch (err) {
        // Invalid filter — skip silently
        skipped.push(filter.id);
      }
    }

    return { text: result, appliedCount, enabledCount: enabledFilters.length, skipped };
  }

  /**
   * Test a single filter or all enabled filters against input text.
   * Used by the UI's "Test" feature.
   *
   * @param {string} text — Input text to test
   * @param {string|null} filterId — If provided, test only this filter; otherwise test all enabled
   * @returns {{ text: string, steps: Array<{id: string, name: string, input: string, output: string}> }}
   */
  test(text, filterId = null) {
    if (!text || typeof text !== 'string') return { text: text || '', steps: [] };

    const filters = filterId
      ? [this.getById(filterId)].filter(Boolean)
      : this.getEnabled();

    let result = text;
    const steps = [];

    for (const filter of filters) {
      const input = result;
      try {
        result = this._applyFilter(result, filter, false);
        steps.push({
          id: filter.id,
          name: filter.name,
          input,
          output: result,
          changed: input !== result
        });
      } catch (err) {
        steps.push({
          id: filter.id,
          name: filter.name,
          input,
          output: result,
          changed: false,
          error: err.message
        });
      }
    }

    return { text: result, steps };
  }

  /**
   * Get the next available order number for a new custom filter.
   */
  _nextOrder() {
    const maxOrder = this._entries.reduce((max, e) => Math.max(max, e.order || 0), 0);
    return maxOrder + 10;
  }

  /**
   * Replace all entries (used for import).
   */
  replaceAll(newEntries) {
    if (!Array.isArray(newEntries)) return;
    this._entries = newEntries;
    this._persist();
    this._ensureBuiltInFilters();
  }

  /**
   * Reset all custom filters and restore built-in defaults.
   */
  resetToDefaults() {
    this._entries = BUILT_IN_FILTERS.map(f => ({ ...f }));
    this._persist();
  }
}

module.exports = RegexFilterService;
