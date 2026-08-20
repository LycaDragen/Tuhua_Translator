/**
 * Profile schema — the single source of truth for the shape of a profile.
 *
 * Before this file, the shape of a profile was written as a literal object
 * in four separate places in src/main/ipc-handlers.js (the save-profile
 * handler, the get-profiles default-seed, create-profile's no-source
 * branch, and load-profile's restore list), and they had already drifted:
 * `apiKey` was written to a profile by one of the four and never read back
 * by another. Every one of those call sites is replaced by the functions
 * below.
 *
 * A profile is now the configuration of a GAME, not a mirror of the whole
 * app. Credentials (deeplKey/openaiKey/apiKey), the reader's own
 * targetLang, and the machine-level textractorCliPath/textractorPort are
 * deliberately NOT part of the profile — they are promoted to global
 * settings (see PROMOTED_TO_GLOBAL_KEYS). `validateProfile` asserts a
 * profile never carries one of those keys, which is the regression guard
 * that closes the class of bug that caused a profile switch to silently
 * reset a custom Textractor port back to 9251.
 */

const crypto = require('crypto');

const PROFILE_SCHEMA_VERSION = 1;

// The only fields copied INTO global settings when a profile activates,
// and copied OUT of global settings when a profile is saved. Both
// projections below (profileToSettings / settingsToProfile) read this one
// list, so they cannot drift from each other the way the four old literals
// did.
const PROFILE_SCOPED_SETTING_KEYS = [
  'sourceLang',
  'inputMethod',
  'engine',
  'customEndpoint',
  'customModel',
  // v3.13.58 (LLM engine overhaul, Fase 3): the cloud-LLM analogues of
  // customEndpoint/customModel above — which provider/model a GAME uses is
  // exactly as game-specific as which local server it points to (one VN
  // might warrant a stronger cloud model, another a cheap local one).
  // llmProvider/llmModel/llmCustomBaseUrl mirror engine/customModel/
  // customEndpoint's scoping for the same reason. The API KEYS themselves
  // (llmProviderKeys) are NOT here — see PROMOTED_TO_GLOBAL_KEYS below.
  'llmProvider',
  'llmModel',
  'llmCustomBaseUrl',
  // The convenience preset (Ollama/LM Studio/...) that resolves to
  // customEndpoint when set to something other than 'custom' — scoped
  // alongside customEndpoint since it's a UI shortcut for the same field,
  // not an independent setting.
  'localLlmEndpointPreset',
  'libretranslateEndpoint',
  'customMTEndpoint',
  'customMTMethod',
  'customMTBody',
  'customMTResponsePath',
  // Template string, e.g. "Authorization: Bearer {{apiKey}}" — the actual
  // secret is customMTApiKey, which is global and NOT in this list. Do not
  // "fix" this by moving a credential in here.
  'customMTAuthHeader',
  'manualTextractorMode',
  // v3.13.6x (LLM engine overhaul, Fase 6): DeepL's native `glossary_id` is
  // profile-scoped for the same reason `engine`/`customModel` are — the
  // remote glossary a request should reference is tied to which GAME is
  // active, not a global user preference. A global setting here would
  // leak profile 1's character names into profile 2's translations the
  // moment you switched games without touching this field. `deeplGlossaryId`
  // is the manual "paste an ID you made yourself" path; `deeplAutoGlossary`
  // opts a profile into Tuhua managing its own remote glossary automatically
  // (see deepl-glossary-sync.js) — off by default, since it means sending
  // glossary content to DeepL as a persistent, named account resource,
  // materially different from the ephemeral text of a normal translation
  // request.
  'deeplGlossaryId',
  'deeplAutoGlossary'
];

// Deliberately excluded from the profile schema — user/machine-level, not
// game-level. A profile must never carry one of these (validateProfile
// enforces it); the migration (profile-migrations.js) is what removes them
// from existing profiles and promotes their value to global settings.
const PROMOTED_TO_GLOBAL_KEYS = [
  'deeplKey',
  'openaiKey',
  'apiKey',
  'targetLang',
  'textractorCliPath',
  'textractorPort',
  // v3.13.58 (Fase 3): the provider-keyed credential map that replaced
  // the single global `openaiKey` — see llm-providers.js's
  // seedProviderKeysFromLegacyOpenAIKey for the one-time migration off the
  // old key. Credentials are global for the same reason deeplKey/apiKey
  // already were: switching games shouldn't switch which real-world API
  // key is in use.
  'llmProviderKeys'
];

function generateId() {
  return crypto.randomUUID();
}

/**
 * Builds a fully-populated profile from an (optionally partial) overrides
 * object. Any key on `overrides` that isn't one of the fields below is
 * silently ignored — this is what makes normalizeProfile() a structural
 * drop of legacy/unknown keys rather than an explicit delete list: passing
 * a v0 profile (with deeplKey, targetLang, textractorCliPath, ...) through
 * here yields a clean v1 profile with none of them.
 */
function createProfile(overrides = {}) {
  const now = Date.now();
  return {
    id: typeof overrides.id === 'string' && overrides.id ? overrides.id : generateId(),
    name: typeof overrides.name === 'string' ? overrides.name : '',
    isDefault: overrides.isDefault === true,
    createdAt: typeof overrides.createdAt === 'number' ? overrides.createdAt : now,
    savedAt: typeof overrides.savedAt === 'number' ? overrides.savedAt : now,

    sourceLang: overrides.sourceLang !== undefined ? overrides.sourceLang : 'auto',
    inputMethod: overrides.inputMethod !== undefined ? overrides.inputMethod : 'textractor',
    engine: overrides.engine !== undefined ? overrides.engine : 'google-free',
    customEndpoint: overrides.customEndpoint || '',
    customModel: overrides.customModel || '',
    // v3.13.58 (Fase 3): '' means "use the provider's default" — see
    // llmProvider's own default below and openai.js's fallback chain.
    llmProvider: overrides.llmProvider || 'openai',
    llmModel: overrides.llmModel || '',
    llmCustomBaseUrl: overrides.llmCustomBaseUrl || '',
    // v3.13.58: defaults to 'custom' (== "just use customEndpoint
    // verbatim"), NOT one of the real presets. A profile normalized from
    // before this field existed has no localLlmEndpointPreset at all and
    // falls through to this default — if it defaulted to e.g. 'lmstudio',
    // resolveLocalEndpoint() would silently override a customEndpoint the
    // user had manually pointed at Ollama (or anything else) back to LM
    // Studio's port. 'custom' is the only default that can't regress an
    // existing endpoint.
    localLlmEndpointPreset: overrides.localLlmEndpointPreset || 'custom',
    libretranslateEndpoint: overrides.libretranslateEndpoint || '',
    customMTEndpoint: overrides.customMTEndpoint || '',
    customMTMethod: overrides.customMTMethod || '',
    customMTBody: overrides.customMTBody || '',
    customMTResponsePath: overrides.customMTResponsePath || '',
    customMTAuthHeader: overrides.customMTAuthHeader || '',
    manualTextractorMode: overrides.manualTextractorMode === true,
    // v3.13.6x (Fase 6): '' means "no manually-pasted glossary — use the
    // auto-synced one if deeplAutoGlossary is on, otherwise none".
    deeplGlossaryId: overrides.deeplGlossaryId || '',
    deeplAutoGlossary: overrides.deeplAutoGlossary === true,

    // v3.13.6x (Fase 6): internal bookkeeping for the auto-sync path
    // (deepl-glossary-sync.js) — {glossaryId, hash, sourceLang, targetLang}
    // or null. NOT in PROFILE_SCOPED_SETTING_KEYS: this isn't a setting the
    // user configures, it's state Tuhua writes after a successful remote
    // sync, same category as `hook`/`cover` below (own dedicated write
    // path, not projected into global settings via profileToSettings).
    deeplGlossarySync: overrides.deeplGlossarySync || null,

    // A per-profile glossary LAYER (merged with the global layer at
    // translate time — see glossary-merge.js), not a snapshot of the
    // global glossary the way this field used to work.
    glossary: Array.isArray(overrides.glossary) ? overrides.glossary : [],
    // {hookCode, hookName, processName, hookCodeType, displayName, source,
    // savedAt} | null — see the hook-persistence design (Phase 1, step 7).
    // Deliberately NOT a hookKey: hookKey embeds a thread handle, PID, and
    // absolute addresses, none of which survive a restart.
    hook: overrides.hook || null,
    // {url, vnId, vnTitle} | null — set on a successful VNDB glossary
    // import (see vndb-import in ipc-handlers.js), shown as the card's
    // cover thumbnail so a profile is recognizable by its game at a
    // glance. Purely cosmetic identification, never read by translation/
    // pipeline logic.
    cover: overrides.cover || null,
    history: Array.isArray(overrides.history) ? overrides.history : []
  };
}

/**
 * Normalizes a raw, possibly-legacy profile object into the current
 * schema. Structural, not a delete list: createProfile() only reads the
 * fields it knows about, so any legacy key on `raw` (deeplKey, apiKey,
 * targetLang, textractorCliPath, textractorPort, or anything else that
 * ever existed) is dropped by omission.
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('normalizeProfile: expected an object');
  }
  return createProfile(raw);
}

/**
 * Validates a profile against the current schema. Includes the assertion
 * that closes the port-clobber bug class: a profile must never carry a
 * promoted-to-global key.
 */
function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') {
    return { valid: false, errors: ['profile must be an object'] };
  }
  if (typeof profile.id !== 'string' || !profile.id) {
    errors.push('id must be a non-empty string');
  }
  if (typeof profile.name !== 'string' || !profile.name.trim()) {
    errors.push('name must be a non-empty string');
  }
  if (typeof profile.isDefault !== 'boolean') {
    errors.push('isDefault must be a boolean');
  }
  if (!Array.isArray(profile.glossary)) {
    errors.push('glossary must be an array');
  }
  if (!Array.isArray(profile.history)) {
    errors.push('history must be an array');
  }
  if (profile.hook !== null && typeof profile.hook !== 'object') {
    errors.push('hook must be null or an object');
  }
  if (profile.cover !== null && typeof profile.cover !== 'object') {
    errors.push('cover must be null or an object');
  }
  if (profile.deeplGlossarySync !== null && typeof profile.deeplGlossarySync !== 'object') {
    errors.push('deeplGlossarySync must be null or an object');
  }
  for (const key of PROFILE_SCOPED_SETTING_KEYS) {
    if (profile[key] === undefined) {
      errors.push(`missing scoped setting: ${key}`);
    }
  }
  for (const key of PROMOTED_TO_GLOBAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(profile, key)) {
      errors.push(`profile must not carry promoted-to-global key: ${key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The copy-on-activate projection: what gets merged into global settings
 * when this profile becomes active. Replaces load-profile's hand-written
 * restore list (src/main/ipc-handlers.js, historically lines 894-911).
 * Never emits a PROMOTED_TO_GLOBAL_KEYS key, by construction (it only
 * reads PROFILE_SCOPED_SETTING_KEYS) — pinned by a bench assertion so this
 * can't regress silently the way the textractorPort clobber did.
 */
function profileToSettings(profile) {
  const settings = {};
  for (const key of PROFILE_SCOPED_SETTING_KEYS) {
    if (profile[key] !== undefined) {
      settings[key] = profile[key];
    }
  }
  return settings;
}

/**
 * The copy-on-save projection: folds the scoped subset of the current
 * global settings into an existing profile object, bumping savedAt.
 * Fields the profile owns outside of PROFILE_SCOPED_SETTING_KEYS (id,
 * name, isDefault, createdAt, glossary, hook, history) are preserved from
 * `existingProfile` untouched — callers update glossary/hook/history
 * through their own dedicated paths, not through this function.
 */
function settingsToProfile(settings, existingProfile) {
  if (!existingProfile || typeof existingProfile !== 'object') {
    throw new Error('settingsToProfile requires an existing profile to merge into');
  }
  const scoped = {};
  for (const key of PROFILE_SCOPED_SETTING_KEYS) {
    if (settings[key] !== undefined) {
      scoped[key] = settings[key];
    }
  }
  return {
    ...existingProfile,
    ...scoped,
    savedAt: Date.now()
  };
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  PROFILE_SCOPED_SETTING_KEYS,
  PROMOTED_TO_GLOBAL_KEYS,
  createProfile,
  normalizeProfile,
  validateProfile,
  profileToSettings,
  settingsToProfile
};
