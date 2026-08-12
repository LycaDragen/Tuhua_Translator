/**
 * HOOK Cleaning Settings Service
 *
 * Persisted enable/disable + cjkOnly toggles for the five HOOK dedup steps
 * in src/services/text-cleaning.js's cleanHookText. Mirrors regex-filter.js's
 * architecture (store-backed list of built-in entries, per-entry
 * enable/disable, i18n name/description keys) with one deliberate
 * difference: no reordering.
 *
 * regex-filter.js's entries are independent regex substitutions — safe to
 * enable/disable/reorder freely, since each is just text.replace(...) with
 * no relationship to the others. The five steps here are NOT independent:
 * collapseRepeatedChars must run before the doubled-text fix, or a short
 * pure 3x+ repeat can be misread as "doubled" and corrupted (verified
 * empirically — see text-cleaning.js's isDoubledText comment). Exposing a
 * drag-and-drop reorder UI here would let a user silently reintroduce that
 * exact bug. Order is fixed in code (cleanHookText); this service only
 * exposes on/off and, for the two CJK-gated steps, cjkOnly.
 */

const Store = require('electron-store');

const BUILT_IN_STEPS = [
  {
    id: 'collapse-repeated-chars',
    name: 'hook_clean_step_chars',
    description: 'hook_clean_step_chars_desc',
    enabled: true,
    supportsCjkOnly: true,
    cjkOnly: true,
    order: 1
  },
  {
    id: 'collapse-repeated-line',
    name: 'hook_clean_step_line',
    description: 'hook_clean_step_line_desc',
    enabled: true,
    supportsCjkOnly: true,
    cjkOnly: true,
    order: 2
  },
  {
    // v3.13.22 (Fase 3): Luna #10 shape. The hardest of the seven, and the
    // only one besides the first two that needs cjkOnly — verified during
    // implementation that without it, "HAHAHAHA"/"NONONONO" (Group 2's own
    // Latin-emphasis regression rows) get misread as two repeated 2-char
    // runs and mangled.
    id: 'detect-variable-refresh',
    name: 'hook_clean_step_variable_refresh',
    description: 'hook_clean_step_variable_refresh_desc',
    enabled: true,
    supportsCjkOnly: true,
    cjkOnly: true,
    order: 3
  },
  {
    // v3.13.38: "A<sep>A" — the same sentence twice in one line, joined by
    // a single space. Runs BEFORE deduplicate-segments on purpose; see
    // detectSeparatedDuplicate's comment for the data-loss case that pins
    // the ordering.
    id: 'detect-separated-duplicate',
    name: 'hook_clean_step_separated',
    description: 'hook_clean_step_separated_desc',
    enabled: true,
    supportsCjkOnly: true,
    cjkOnly: true,
    order: 4
  },
  {
    // v3.13.22 (Fase 3): Luna #11 shape.
    id: 'detect-shrinking-suffix',
    name: 'hook_clean_step_shrinking',
    description: 'hook_clean_step_shrinking_desc',
    enabled: true,
    supportsCjkOnly: false,
    order: 5
  },
  {
    id: 'detect-growing-prefix',
    name: 'hook_clean_step_growing',
    description: 'hook_clean_step_growing_desc',
    enabled: true,
    supportsCjkOnly: false,
    order: 6
  },
  {
    id: 'undouble-text',
    name: 'hook_clean_step_doubled',
    description: 'hook_clean_step_doubled_desc',
    enabled: true,
    supportsCjkOnly: false,
    order: 7
  },
  {
    id: 'deduplicate-segments',
    name: 'hook_clean_step_segments',
    description: 'hook_clean_step_segments_desc',
    enabled: true,
    supportsCjkOnly: false,
    order: 8
  }
];

class HookCleaningSettingsService {
  constructor() {
    this.store = new Store({ name: 'hook-cleaning-settings' });
    this._ensureBuiltInSteps();
  }

  /**
   * Same merge pattern as RegexFilterService._ensureBuiltInFilters: pick up
   * new/changed steps from code while preserving the user's enabled/cjkOnly
   * choices.
   */
  _ensureBuiltInSteps() {
    const entries = this.store.get('steps', []);
    const existingIds = new Set(entries.map(e => e.id));

    let modified = false;
    for (const preset of BUILT_IN_STEPS) {
      if (!existingIds.has(preset.id)) {
        entries.push({ ...preset });
        modified = true;
      } else {
        const idx = entries.findIndex(e => e.id === preset.id);
        const existing = entries[idx];
        entries[idx] = {
          ...preset,
          enabled: existing.enabled !== undefined ? existing.enabled : preset.enabled,
          cjkOnly: existing.cjkOnly !== undefined ? existing.cjkOnly : preset.cjkOnly
        };
        modified = true;
      }
    }

    const currentIds = new Set(BUILT_IN_STEPS.map(s => s.id));
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!currentIds.has(entries[i].id)) {
        entries.splice(i, 1);
        modified = true;
      }
    }

    if (modified) {
      this.store.set('steps', entries);
    }
  }

  /** All five steps, in their fixed pipeline order. */
  getAll() {
    return this.store.get('steps', []).sort((a, b) => a.order - b.order);
  }

  toggle(id, enabled) {
    const entries = this.store.get('steps', []);
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return null;
    entries[idx].enabled = !!enabled;
    this.store.set('steps', entries);
    return entries[idx];
  }

  setCjkOnly(id, cjkOnly) {
    const entries = this.store.get('steps', []);
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0 || !entries[idx].supportsCjkOnly) return null;
    entries[idx].cjkOnly = !!cjkOnly;
    this.store.set('steps', entries);
    return entries[idx];
  }

  resetToDefaults() {
    this.store.set('steps', BUILT_IN_STEPS.map(s => ({ ...s })));
  }

  /**
   * Builds the options object text-cleaning.js's cleanHookText expects.
   * Defaults (all steps enabled, cjkOnly true) exactly reproduce Fase 2's
   * pipeline for the original five steps — verified against
   * scripts/test-hook-cleaning.js at the time. The two new Fase 3 steps
   * (variable-refresh, shrinking-suffix) default enabled too: unlike
   * cjkOnly relaxation (which the bench showed breaks Group 2), turning
   * these algorithms ON was the measured, positive result of Fase 3 —
   * see the plan's Fase 3 section for the before/after bench numbers.
   */
  getOptions() {
    const byId = {};
    for (const step of this.getAll()) byId[step.id] = step;

    return {
      enableCollapseRepeatedChars: byId['collapse-repeated-chars']?.enabled !== false,
      collapseRepeatedCharsCjkOnly: byId['collapse-repeated-chars']?.cjkOnly !== false,
      enableCollapseRepeatedLine: byId['collapse-repeated-line']?.enabled !== false,
      collapseRepeatedLineCjkOnly: byId['collapse-repeated-line']?.cjkOnly !== false,
      enableVariableRefresh: byId['detect-variable-refresh']?.enabled !== false,
      variableRefreshCjkOnly: byId['detect-variable-refresh']?.cjkOnly !== false,
      enableSeparatedDuplicate: byId['detect-separated-duplicate']?.enabled !== false,
      separatedDuplicateCjkOnly: byId['detect-separated-duplicate']?.cjkOnly !== false,
      enableShrinkingSuffix: byId['detect-shrinking-suffix']?.enabled !== false,
      enableGrowingPrefix: byId['detect-growing-prefix']?.enabled !== false,
      enableUndouble: byId['undouble-text']?.enabled !== false,
      enableDedupSegments: byId['deduplicate-segments']?.enabled !== false
    };
  }
}

module.exports = HookCleaningSettingsService;
