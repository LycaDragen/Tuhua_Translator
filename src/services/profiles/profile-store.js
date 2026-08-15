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
const { migrateProfiles } = require('./profile-migrations');

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
      ? createProfile({ ...source, id: undefined, name, isDefault: false })
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
   * One-time schema migration 0 -> 1, gated by `profilesSchemaVersion`.
   * Idempotent: a store already at PROFILE_SCHEMA_VERSION is left
   * untouched (returns { ran: false }) rather than re-running the pure
   * migration and re-writing an identical backup.
   *
   * The backup and the migrated data land in ONE store.set() call —
   * verified against the real electron-store package that set(object)
   * only touches the keys present in it (leaves every other setting
   * alone), so this does not require pre-spreading store.get() first.
   * Two separate writes would leave a window where credentials are
   * already stripped from profiles but not yet promoted to global.
   */
  migrate(globalGlossaryEntries = []) {
    const currentVersion = this.store.get('profilesSchemaVersion', 0);
    if (currentVersion >= PROFILE_SCHEMA_VERSION) {
      return { ran: false };
    }

    const profiles = this.store.get('profiles', []);
    const activeProfile = this.store.get('activeProfile', DEFAULT_PROFILE_NAME);
    const settings = this.store.get();

    const result = migrateProfiles({ profiles, settings, globalGlossaryEntries, activeProfile });

    this.store.set({
      ...result.settings,
      profiles: result.profiles,
      activeProfile,
      activeProfileId: result.activeProfileId,
      profilesBackupV0: result.backup,
      profilesSchemaVersion: PROFILE_SCHEMA_VERSION
    });

    return { ran: true, ...result };
  }
}

module.exports = ProfileStore;
