/**
 * Profile schema migration 0 -> 1 — pure, no electron-store dependency.
 * The store-touching wrapper is ProfileStore#migrate() in profile-store.js,
 * gated by a `profilesSchemaVersion` key in the main settings store,
 * following the precedent already in this codebase at
 * src/services/regex-filter.js (schemaVersion 0 -> 1).
 *
 * What this migration does, in order:
 *   1. Promotes deeplKey/openaiKey/apiKey/targetLang/textractorCliPath/
 *      textractorPort out of every profile into global settings — these
 *      are user/machine-level, not game-level (see profile-schema.js).
 *      Precedence when values differ: non-empty global wins outright,
 *      else the active profile's value, else the most-recently-saved
 *      profile's value, else array order. Conflicts (>=2 distinct
 *      non-empty values seen) are reported, never silently dropped.
 *   2. Splits each profile's glossary SNAPSHOT into a glossary LAYER: an
 *      entry survives on the profile only if no equivalent (mode, source,
 *      target) entry exists in the global glossary. With the old
 *      perProfileGlossary flag off (the default), every profile's
 *      snapshot had converged to an exact copy of the global list — this
 *      correctly yields an empty profile layer for all of them. With the
 *      flag on, genuine divergence is preserved exactly.
 *   3. Assigns a stable `id` to every profile and resolves activeProfileId.
 *   4. Strips the dead settings this Phase removes (perProfileGlossary,
 *      enableGlossary, enableCache, autoApplyGlossary,
 *      showSourceTextInOverlay — the last one added in step 8 once real
 *      grepping confirmed it had a translated settings label but zero
 *      actual wiring: update-output's payload never carried the original
 *      text, and no checkbox ever referenced it).
 *
 * Data-safety note: this function does NOT write anything. The caller
 * (ProfileStore#migrate()) is expected to persist `backup` BEFORE writing
 * `profiles`/`settings`, in a single store.set() alongside the migrated
 * data — see that file's own comment for why one write, not two.
 */

const { normalizeProfile, PROMOTED_TO_GLOBAL_KEYS } = require('./profile-schema');

const PROMOTABLE_CREDENTIAL_KEYS = ['deeplKey', 'openaiKey', 'apiKey'];
const DEAD_SETTING_KEYS = ['perProfileGlossary', 'enableGlossary', 'enableCache', 'autoApplyGlossary', 'showSourceTextInOverlay'];

// v3.13.8x (settings UX audit): second round of dead-key cleanup, same
// shape as DEAD_SETTING_KEYS above but wired as its OWN migration step
// (see stripGhostSettingsV2() + profile-store.js's migrate(), v3->v4) —
// DEAD_SETTING_KEYS only runs for a genuinely-v0 install, so an install
// already at v1+ (everyone since v3.13.40) would never have these
// stripped if they were just added to that array instead.
//   - deeplStyleId/deeplTranslationMemoryId/deeplTranslationMemoryThreshold:
//     Pro-plan DeepL features with no UI field and no default consumer
//     beyond their own always-empty fallback — see deepl.js's
//     constructor (options.styleId etc.) and pipeline.js's 'deepl' case,
//     which stopped passing them in this same audit.
//   - deeplLanguageFeatures: declared as a default, never read or written
//     anywhere — the renderer's similarly-named in-memory cache
//     (deeplLanguageFeaturesCache) is a local variable fed by a separate
//     IPC call, unrelated to this store key.
//   - apiKey: the legacy global credential slot PROMOTABLE_CREDENTIAL_KEYS
//     (below) promotes an old per-profile value INTO — nothing has ever
//     read it back out as a global setting (deeplKey/llmProviderKeys are
//     what every engine actually reads). Left in PROMOTABLE_CREDENTIAL_KEYS
//     unchanged, since that array's job (rescue a legacy per-profile value
//     during the v0->v1 step) is independent of whether the promoted
//     value then sits around forever — this step deletes it right after.
//   - profilesBackupV0: the one-time safety snapshot the v0->v1 step
//     itself writes (see migrateProfiles()'s `backup` below) — a pure
//     insurance policy, never read back by any code path. By the time an
//     install reaches v3 (this step's precondition), v0->v1 has clearly
//     already succeeded (profiles have loaded correctly ever since), so
//     the backup's job is done.
const DEAD_SETTING_KEYS_V2 = ['deeplStyleId', 'deeplTranslationMemoryId', 'deeplTranslationMemoryThreshold', 'deeplLanguageFeatures', 'apiKey', 'profilesBackupV0'];

function maskSecret(value) {
  const str = String(value);
  if (str.length <= 4) return '*'.repeat(str.length);
  return `${str.slice(0, 2)}${'*'.repeat(Math.max(str.length - 4, 4))}${str.slice(-2)}`;
}

function isEmpty(value, emptyValues) {
  return emptyValues.includes(value);
}

/**
 * Resolves one promoted-to-global key across the global settings value and
 * every profile's value for that key, using the precedence documented
 * above. `emptyValues` lets a caller treat a stock default (e.g.
 * textractorPort's 9251) as "no real global preference" the same way an
 * empty string is treated for the other keys.
 */
function resolvePromotedValue(key, { globalValue, profiles, activeProfileName, emptyValues = [undefined, null, ''] }) {
  const profileCandidates = profiles
    .map((p, idx) => ({ value: p[key], name: p.name, savedAt: p.savedAt || 0, idx }))
    .filter((c) => !isEmpty(c.value, emptyValues));

  const distinctValues = new Set(profileCandidates.map((c) => c.value));
  const globalIsMeaningful = !isEmpty(globalValue, emptyValues);
  if (globalIsMeaningful) distinctValues.add(globalValue);
  const conflict = distinctValues.size > 1;

  let resolved;
  if (globalIsMeaningful) {
    resolved = globalValue;
  } else {
    const active = profileCandidates.find((c) => c.name === activeProfileName);
    if (active) {
      resolved = active.value;
    } else if (profileCandidates.length > 0) {
      const sorted = [...profileCandidates].sort((a, b) => b.savedAt - a.savedAt || a.idx - b.idx);
      resolved = sorted[0].value;
    } else {
      resolved = globalValue;
    }
  }

  return { value: resolved, conflict, distinctValues: [...distinctValues] };
}

// Uses `\0` (not a plain space) between fields — a glossary source/target
// can legitimately contain spaces, and a plain-space join would let
// {source:'a b', target:'c'} collide with {source:'a', target:'b c'} under
// the same mode. `\0` can never appear in real glossary text, so it's an
// unambiguous separator. Written as the escape, not a raw NUL byte in the
// file, so this stays a normal diffable text file for git.
function glossaryEntryKey(e) {
  return `${e.mode}\0${e.source}\0${e.target}`;
}

/**
 * Splits `profileGlossary` into the entries with no equivalent in
 * `globalGlossary` — the profile-only layer that survives migration.
 * Equivalence is (mode, source, target), deliberately never `id` (ids are
 * regenerated by GlossaryService#add/importFromFile, so two entries that
 * are the "same" glossary rule to a user can have different ids).
 */
function splitGlossaryLayer(profileGlossary, globalGlossary) {
  if (!Array.isArray(profileGlossary)) return [];
  const globalKeys = new Set((globalGlossary || []).map(glossaryEntryKey));
  return profileGlossary.filter((e) => !globalKeys.has(glossaryEntryKey(e)));
}

/**
 * The pure migration. Returns the migrated profiles/settings/glossary,
 * the resolved active profile id, a deep-copy backup of the pre-migration
 * profiles and global glossary, a conflict report, and `changed` (whether
 * this call actually had anything v0 to migrate — lets the wrapper and
 * the bench distinguish a real migration from a no-op re-run on already-v1
 * data without relying on fragile whole-object deep equality).
 */
function migrateProfiles({ profiles = [], settings = {}, globalGlossaryEntries = [], activeProfile = 'Por Defecto' } = {}) {
  const backup = {
    profiles: JSON.parse(JSON.stringify(profiles)),
    glossary: JSON.parse(JSON.stringify(globalGlossaryEntries)),
    migratedAt: Date.now()
  };

  const report = { credentialConflicts: [], targetLangConflict: null, textractorPortConflict: null };
  const nextSettings = { ...settings };

  for (const key of PROMOTABLE_CREDENTIAL_KEYS) {
    const resolved = resolvePromotedValue(key, { globalValue: settings[key], profiles, activeProfileName: activeProfile });
    if (resolved.conflict) {
      report.credentialConflicts.push({ key, maskedValues: resolved.distinctValues.map(maskSecret) });
    }
    nextSettings[key] = resolved.value || '';
  }

  {
    const resolved = resolvePromotedValue('targetLang', { globalValue: settings.targetLang, profiles, activeProfileName: activeProfile });
    if (resolved.conflict) report.targetLangConflict = { values: resolved.distinctValues };
    nextSettings.targetLang = resolved.value || 'es';
  }

  {
    const resolved = resolvePromotedValue('textractorCliPath', { globalValue: settings.textractorCliPath, profiles, activeProfileName: activeProfile });
    nextSettings.textractorCliPath = resolved.value || '';
  }

  {
    const resolved = resolvePromotedValue('textractorPort', {
      globalValue: settings.textractorPort,
      profiles,
      activeProfileName: activeProfile,
      emptyValues: [undefined, null, '', 9251]
    });
    if (resolved.conflict) report.textractorPortConflict = { values: resolved.distinctValues };
    nextSettings.textractorPort = resolved.value !== undefined && resolved.value !== null && resolved.value !== ''
      ? resolved.value
      : 9251;
  }

  let activeProfileId = null;
  const migratedProfiles = profiles.map((raw) => {
    const profileOnlyGlossary = splitGlossaryLayer(raw.glossary, globalGlossaryEntries);
    const normalized = normalizeProfile({ ...raw, glossary: profileOnlyGlossary, hook: null });
    if (raw.name === activeProfile) activeProfileId = normalized.id;
    return normalized;
  });
  if (!activeProfileId && migratedProfiles.length > 0) {
    activeProfileId = migratedProfiles[0].id;
  }

  for (const key of DEAD_SETTING_KEYS) {
    delete nextSettings[key];
  }

  const hadLegacyProfileKeys = profiles.some((p) => PROMOTED_TO_GLOBAL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(p, k)));
  const hadMissingIds = profiles.some((p) => typeof p.id !== 'string' || !p.id);
  const hadDeadSettings = DEAD_SETTING_KEYS.some((k) => Object.prototype.hasOwnProperty.call(settings, k));
  const glossarySplitHappened = profiles.some((p, i) => {
    const before = Array.isArray(p.glossary) ? p.glossary.length : 0;
    return before !== migratedProfiles[i].glossary.length;
  });
  const changed = hadLegacyProfileKeys || hadMissingIds || hadDeadSettings || glossarySplitHappened;

  return {
    profiles: migratedProfiles,
    settings: nextSettings,
    glossaryEntries: globalGlossaryEntries,
    activeProfileId,
    backup,
    changed,
    report
  };
}

/**
 * Migration 1 -> 2 — pure, additive-only. Seeds every profile's new
 * `deeplCustomInstructions` field from the CURRENT global
 * `deeplCustomInstructions` setting, so promoting that setting to
 * profile-scoped (profile-schema.js, v3.13.80) doesn't silently blank out
 * instructions a user already wrote — profileToSettings()/
 * settingsToProfile() only take effect from the next profile save/load
 * onward, so an existing profile needs a one-time seed or the first
 * `load-profile` after this ships would overwrite the user's real
 * instructions with the new field's `[]` default.
 *
 * Deliberately does NOT touch anything else on the profile (no glossary
 * re-split, no credential promotion, no re-normalize) — that's the v0->v1
 * step above, already run for anyone reaching this one. Idempotent: a
 * profile that already carries a non-empty deeplCustomInstructions (e.g. a
 * re-run, or a profile created after the field existed) is left untouched.
 *
 * Always leaves the field present as an array, even when there's nothing
 * to seed (global also empty) — a raw pre-v3.13.80 profile genuinely has
 * no `deeplCustomInstructions` key at all, and validateProfile() (which
 * some callers may run on a profile straight from disk, before it's ever
 * passed through normalizeProfile()) rejects any PROFILE_SCOPED_SETTING_KEYS
 * key that's `undefined`. `changed` still only reflects the meaningful
 * case — real content actually copied from the global setting — not this
 * bookkeeping default-fill.
 */
function seedDeeplCustomInstructions(profiles, globalCustomInstructions) {
  const globalValue = Array.isArray(globalCustomInstructions) ? globalCustomInstructions : [];
  let changed = false;
  const seeded = profiles.map((p) => {
    const existing = Array.isArray(p.deeplCustomInstructions) ? p.deeplCustomInstructions : [];
    if (existing.length > 0) return p;
    if (globalValue.length === 0) {
      return Array.isArray(p.deeplCustomInstructions) ? p : { ...p, deeplCustomInstructions: [] };
    }
    changed = true;
    return { ...p, deeplCustomInstructions: [...globalValue] };
  });
  return { profiles: seeded, changed };
}

/**
 * Migration 2 -> 3 — pure, additive-only, same shape as
 * seedDeeplCustomInstructions() just above (see that doc comment for the
 * full rationale — this is the same problem, for `deeplFormality` instead
 * of the instructions array). Seeds every profile's new `deeplFormality`
 * from the CURRENT global `deeplFormality`, so promoting it to
 * profile-scoped (Lyca's explicit request, same session as the
 * instructions scoping) doesn't silently reset an already-tuned register
 * back to a blank default the next time a profile loads.
 *
 * "Already has a value" means a non-empty string, not array length —
 * `''` is the only sentinel for "no per-game override yet" (see
 * profile-schema.js's createProfile() comment on this field). Idempotent:
 * a profile that already carries a non-empty deeplFormality is left
 * untouched. Always leaves the field present as a string, even when
 * there's nothing to seed, for the same validateProfile() reason as the
 * instructions field.
 */
function seedDeeplFormality(profiles, globalFormality) {
  const globalValue = typeof globalFormality === 'string' ? globalFormality : '';
  let changed = false;
  const seeded = profiles.map((p) => {
    const existing = typeof p.deeplFormality === 'string' ? p.deeplFormality : '';
    if (existing !== '') return p;
    if (globalValue === '') {
      return typeof p.deeplFormality === 'string' ? p : { ...p, deeplFormality: '' };
    }
    changed = true;
    return { ...p, deeplFormality: globalValue };
  });
  return { profiles: seeded, changed };
}

/**
 * Migration 3 -> 4 — pure, settings-only (profiles untouched). Strips
 * DEAD_SETTING_KEYS_V2 from the global settings object; see that
 * constant's own comment for what each key was and why it's dead.
 * Idempotent: deleting an already-absent key is a no-op, so re-running
 * this against a store that's already been through it changes nothing.
 */
function stripGhostSettingsV2(settings) {
  const next = { ...settings };
  let changed = false;
  for (const key of DEAD_SETTING_KEYS_V2) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      changed = true;
    }
  }
  return { settings: next, changed };
}

/**
 * Migration 4 -> 5 (auto-configuración de juegos, Fase A) — pure,
 * additive, same shape as seedDeeplCustomInstructions()/seedDeeplFormality()
 * above: a raw pre-3.13.85 profile has no `game` key at all. Unlike those
 * two, `game` isn't a PROFILE_SCOPED_SETTING_KEYS field, so there's no
 * global value to seed FROM — this step is pure structural fill-in,
 * `changed` is always false (it never carries real content, only
 * presence). Kept as its own step rather than folded into
 * normalizeProfile()'s defaults because validateProfile() can run on a
 * profile straight off disk, before it's ever passed through
 * normalizeProfile() — same reasoning documented on
 * seedDeeplCustomInstructions() above. Idempotent: a profile that already
 * has a `game` (object or explicit null) is left untouched.
 */
function seedGameField(profiles) {
  const seeded = profiles.map((p) => {
    if (Object.prototype.hasOwnProperty.call(p, 'game')) return p;
    return { ...p, game: null };
  });
  return { profiles: seeded, changed: false };
}

module.exports = {
  PROMOTABLE_CREDENTIAL_KEYS,
  DEAD_SETTING_KEYS,
  DEAD_SETTING_KEYS_V2,
  resolvePromotedValue,
  splitGlossaryLayer,
  glossaryEntryKey,
  maskSecret,
  migrateProfiles,
  seedDeeplCustomInstructions,
  seedDeeplFormality,
  stripGhostSettingsV2,
  seedGameField
};
