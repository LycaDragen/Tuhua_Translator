/**
 * ProfileStore — the only place in the codebase that touches
 * `store.get('profiles')` / `store.set('profiles', ...)`. Takes an
 * injected store (electron-store's `{get(key, default), set(key, value) |
 * set(object)}` shape) so it's testable in plain Node with a small fake.
 *
 * Storage stays in the same config.json the rest of the app's settings
 * live in, under `profiles` (array) and `activeProfileId` (string — the
 * new primary lookup key; `activeProfile`, the display name, is kept as a
 * mirror alongside it for one release).
 */

const { createProfile, normalizeProfile, PROFILE_SCHEMA_VERSION } = require('./profile-schema');
const { migrateProfiles, seedDeeplCustomInstructions, seedDeeplFormality, stripGhostSettingsV2, seedGameField, DEAD_SETTING_KEYS_V2 } = require('./profile-migrations');

const DEFAULT_PROFILE_NAME = 'Por Defecto';

class ProfileStore {
  constructor(store) {
    if (!store) throw new Error('ProfileStore requires a store');
    this.store = store;
  }

  list() {
    return this.store.get('profiles', []);
  }

  getById(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  getByName(name) {
    return this.list().find((p) => p.name === name) || null;
  }

  getActiveId() {
    return this.store.get('activeProfileId', null);
  }

  getActive() {
    const id = this.getActiveId();
    return id ? this.getById(id) : null;
  }

  /**
   * Ensures the default profile exists, seeding it from current global
   * settings if missing. Called once at startup — the old get-profiles
   * IPC handler materialized the default profile lazily INSIDE the
   * getter itself, which is exactly why its seed literal silently drifted
   * from save-profile's (it lost `apiKey`, since nothing kept the two
   * hand-written literals in sync).
   */
  ensureDefault(globalSettings = {}) {
    const profiles = this.list();
    const hasDefault = profiles.some((p) => p.isDefault || p.name === DEFAULT_PROFILE_NAME);
    if (hasDefault) return profiles;

    const seeded = createProfile({
      name: DEFAULT_PROFILE_NAME,
      isDefault: true,
      sourceLang: globalSettings.sourceLang,
      inputMethod: globalSettings.inputMethod,
      engine: globalSettings.engine,
      customEndpoint: globalSettings.customEndpoint,
      customModel: globalSettings.customModel,
      libretranslateEndpoint: globalSettings.libretranslateEndpoint,
      customMTEndpoint: globalSettings.customMTEndpoint,
      customMTMethod: globalSettings.customMTMethod,
      customMTBody: globalSettings.customMTBody,
      customMTResponsePath: globalSettings.customMTResponsePath,
      customMTAuthHeader: globalSettings.customMTAuthHeader,
      manualTextractorMode: globalSettings.manualTextractorMode
    });
    const next = [seeded, ...profiles];
    this.store.set('profiles', next);
    if (!this.getActiveId()) {
      this.store.set('activeProfileId', seeded.id);
      this.store.set('activeProfile', seeded.name);
    }
    return next;
  }

  /**
   * Creates a profile. Without `cloneFromId`, the new profile is blank
   * (v3.13.40: create no longer silently clones the active profile — see
   * `duplicate()` for that behavior, now explicit).
   */
  create({ name, cloneFromId } = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('Invalid profile name');
    }
    const profiles = this.list();
    if (profiles.some((p) => p.name === name)) {
      throw new Error('Profile name already exists');
    }
    const source = cloneFromId ? this.getById(cloneFromId) : null;
    const created = source
      // v3.13.85 (auto-configuración de juegos, Fase A): `game` and
      // `deeplGlossarySync` are per-INSTALLATION state, not per-profile
      // config, so cloning must not carry them over. Without this, two
      // profiles would end up claiming the same game process (permanently
      // ambiguous for game-identity.js's matching — no visible symptom
      // until you have both open). deeplGlossarySync is the same class of
      // bug for a different resource: it holds a remote DeepL glossaryId,
      // and delete-profile best-effort-deletes that remote resource
      // (ipc-handlers.js) — duplicating it and later deleting the
      // duplicate would silently orphan/kill the ORIGINAL's glossary.
      // Same pattern as `hook: null` forced in migrateProfiles() below.
      ? createProfile({ ...source, id: undefined, name, isDefault: false, game: null, deeplGlossarySync: null })
      : createProfile({ name, isDefault: false });
    this.store.set('profiles', [...profiles, created]);
    return created;
  }

  duplicate(id, newName) {
    if (!this.getById(id)) throw new Error('Profile not found');
    return this.create({ name: newName, cloneFromId: id });
  }

  rename(id, newName) {
    if (typeof newName !== 'string' || !newName.trim()) {
      throw new Error('Invalid profile name');
    }
    const profiles = this.list();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Profile not found');
    if (profiles.some((p) => p.id !== id && p.name === newName)) {
      throw new Error('Profile name already exists');
    }
    const updated = { ...profiles[idx], name: newName, savedAt: Date.now() };
    const next = [...profiles];
    next[idx] = updated;
    this.store.set('profiles', next);
    if (this.getActiveId() === id) {
      this.store.set('activeProfile', newName);
    }
    return updated;
  }

  remove(id) {
    const profiles = this.list();
    const target = profiles.find((p) => p.id === id);
    if (!target) return false;
    if (target.isDefault) throw new Error('Cannot delete the default profile');
    const next = profiles.filter((p) => p.id !== id);
    this.store.set('profiles', next);
    if (this.getActiveId() === id) {
      const fallback = next.find((p) => p.isDefault) || next[0] || null;
      this.store.set('activeProfileId', fallback ? fallback.id : null);
      this.store.set('activeProfile', fallback ? fallback.name : DEFAULT_PROFILE_NAME);
    }
    return true;
  }

  /**
   * Applies `updater(currentProfile) -> partialUpdate` and normalizes the
   * result, so callers can't accidentally reintroduce a legacy/promoted
   * key through a careless partial update.
   */
  update(id, updater) {
    const profiles = this.list();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const patch = updater(profiles[idx]) || {};
    const updated = normalizeProfile({ ...profiles[idx], ...patch, id });
    const next = [...profiles];
    next[idx] = updated;
    this.store.set('profiles', next);
    return updated;
  }

  setActive(id) {
    const profile = this.getById(id);
    if (!profile) throw new Error('Profile not found');
    this.store.set('activeProfileId', id);
    this.store.set('activeProfile', profile.name);
    return profile;
  }

  /**
   * One-time schema migration, gated by `profilesSchemaVersion` and run
   * STEP BY STEP through intermediate versions — not a single
   * all-or-nothing gate — so a store already sitting at v1 (everyone who
   * migrated before v3.13.80) only runs the new v1->v2 step, instead of
   * re-running the v0->v1 credential-promotion/glossary-layer-split logic
   * a second time against data that has moved on since (e.g. the global
   * glossary has grown, which would make splitGlossaryLayer() strip MORE
   * profile-only entries than it did the first time — a real regression,
   * not idempotent no-op).
   *
   * Idempotent: a store already at PROFILE_SCHEMA_VERSION is left
   * untouched (returns { ran: false }). Each step is itself safe to
   * re-run — migrateProfiles() only fires for genuinely-v0 data,
   * seedDeeplCustomInstructions() only fills profiles with an empty
   * `deeplCustomInstructions`.
   *
   * The whole result lands in ONE store.set() call — verified against the
   * real electron-store package that set(object) only touches the keys
   * present in it (leaves every other setting alone), so this does not
   * require pre-spreading store.get() first. A single write avoids a
   * window where profiles reflect one step but not the other.
   */
  migrate(globalGlossaryEntries = []) {
    let currentVersion = this.store.get('profilesSchemaVersion', 0);
    if (currentVersion >= PROFILE_SCHEMA_VERSION) {
      return { ran: false };
    }

    let profiles = this.store.get('profiles', []);
    const activeProfile = this.store.get('activeProfile', DEFAULT_PROFILE_NAME);
    let settings = this.store.get();
    let activeProfileId = this.store.get('activeProfileId', null);
    let backup;
    let report = { credentialConflicts: [], targetLangConflict: null, textractorPortConflict: null };
    let changed = false;

    if (currentVersion < 1) {
      const result = migrateProfiles({ profiles, settings, globalGlossaryEntries, activeProfile });
      profiles = result.profiles;
      settings = result.settings;
      activeProfileId = result.activeProfileId;
      backup = result.backup;
      report = result.report;
      changed = changed || result.changed;
      currentVersion = 1;
    }

    if (currentVersion < 2) {
      const result = seedDeeplCustomInstructions(profiles, settings.deeplCustomInstructions);
      profiles = result.profiles;
      changed = changed || result.changed;
      currentVersion = 2;
    }

    if (currentVersion < 3) {
      const result = seedDeeplFormality(profiles, settings.deeplFormality);
      profiles = result.profiles;
      changed = changed || result.changed;
      currentVersion = 3;
    }

    let ghostKeysToDelete = [];
    if (currentVersion < 4) {
      const result = stripGhostSettingsV2(settings);
      // v3.13.8x: store.set(object) only MERGES — verified against the real
      // electron-store package that it never clears a key the object
      // doesn't mention (that's exactly why this class's docstring above
      // says "leaves every other setting alone"). Deleting a key from this
      // in-memory `settings` copy and then spreading it into `toWrite`
      // below is therefore NOT enough to actually remove it from the
      // persisted store — the pre-existing value would just survive
      // untouched. Caught by a real test (see test-profile-migration.js)
      // that checked the store's raw state after migrate(), not just this
      // function's return value. The keys present get deleted explicitly,
      // BEFORE the main set() below, not after — so a crash mid-migration
      // leaves profilesSchemaVersion still < 4 and this step simply
      // re-runs (store.delete() on an already-gone key is a no-op); doing
      // it in the other order could bump the version while leaving a
      // ghost key stranded forever, since v4+ never re-checks this step.
      ghostKeysToDelete = DEAD_SETTING_KEYS_V2.filter((k) => Object.prototype.hasOwnProperty.call(settings, k));
      settings = result.settings;
      changed = changed || result.changed;
      currentVersion = 4;
    }

    if (currentVersion < 5) {
      const result = seedGameField(profiles);
      profiles = result.profiles;
      changed = changed || result.changed;
      currentVersion = 5;
    }

    for (const key of ghostKeysToDelete) {
      this.store.delete(key);
    }

    const toWrite = {
      ...settings,
      profiles,
      activeProfile,
      activeProfileId,
      profilesSchemaVersion: PROFILE_SCHEMA_VERSION
    };
    if (backup) toWrite.profilesBackupV0 = backup;
    this.store.set(toWrite);

    return { ran: true, changed, report, profiles, activeProfileId };
  }
}

module.exports = ProfileStore;
