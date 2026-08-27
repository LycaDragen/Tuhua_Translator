/**
 * profile-migrations.js + profile-store.js bench — pure decision table
 * plus a fake-store integration pass, no Electron, no disk I/O.
 * See src/services/profiles/profile-migrations.js and profile-store.js
 * for the full rationale.
 *
 * The invariant every fixture is checked against: no glossary entry and
 * no non-empty credential value present BEFORE migration is absent AFTER
 * it — where "present after" means present in {migrated settings/profiles}
 * OR verbatim in the backup. This is why `backup.profiles` is asserted to
 * be a byte-for-byte deep copy of the original input on every case: it's
 * the safety net for the one genuinely irreversible outcome (two profiles
 * with different real API keys — only one survives in the live config,
 * per the plan's own risk section, recoverable from profilesBackupV0).
 *
 *   node scripts/test-profile-migration.js
 *   node scripts/test-profile-migration.js --quiet
 */
const path = require('path');
const { migrateProfiles, resolvePromotedValue, splitGlossaryLayer, seedDeeplCustomInstructions, seedDeeplFormality, stripGhostSettingsV2, seedGameField } =
  require(path.join('..', 'src', 'services', 'profiles', 'profile-migrations.js'));
const ProfileStore = require(path.join('..', 'src', 'services', 'profiles', 'profile-store.js'));
const { PROFILE_SCHEMA_VERSION, PROMOTED_TO_GLOBAL_KEYS } =
  require(path.join('..', 'src', 'services', 'profiles', 'profile-schema.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

function createFakeStore(initialData = {}) {
  let data = JSON.parse(JSON.stringify(initialData));
  let setCalls = 0;
  let deleteCalls = 0;
  return {
    get(key, def) {
      if (key === undefined) return JSON.parse(JSON.stringify(data));
      return data[key] !== undefined ? JSON.parse(JSON.stringify(data[key])) : def;
    },
    set(keyOrObj, value) {
      setCalls += 1;
      if (typeof keyOrObj === 'object' && keyOrObj !== null) {
        for (const [k, v] of Object.entries(keyOrObj)) data[k] = v;
      } else {
        data[keyOrObj] = value;
      }
    },
    // v3.13.8x: real electron-store's set(object) only merges — it never
    // clears a key absent from the object (see profile-store.js's migrate()
    // for where that distinction bit the v3->v4 ghost-settings step). This
    // fake needs its own .delete() to match, or that class of bug is
    // invisible against this fake even though it's real against the actual
    // store. Tracked separately from setCalls — the "one write" invariant
    // this file's header comment describes is specifically about the
    // profiles/settings set() call, not about ghost-key deletes, which are
    // an intentionally separate, idempotent side-channel (see
    // profile-store.js's migrate()).
    delete(key) {
      deleteCalls += 1;
      delete data[key];
    },
    _raw: () => JSON.parse(JSON.stringify(data)),
    _setCallCount: () => setCalls,
    _deleteCallCount: () => deleteCalls
  };
}

const glossaryEntry = (source, target, mode = 'exact') => ({ id: `${source}-${mode}`, source, target, mode, enabled: true, createdAt: 1 });

// A realistic v0 profile literal — matches the shape the OLD save-profile
// handler wrote (src/main/ipc-handlers.js, historically lines 752-782).
function v0Profile(overrides) {
  return {
    name: 'Profile', isDefault: false,
    sourceLang: 'ja', targetLang: 'es', inputMethod: 'textractor', engine: 'deepl',
    deeplKey: '', openaiKey: '', apiKey: '',
    customEndpoint: '', customModel: '', libretranslateEndpoint: '',
    customMTEndpoint: '', customMTMethod: '', customMTBody: '', customMTResponsePath: '', customMTAuthHeader: '',
    glossary: [], history: [],
    textractorCliPath: '', textractorPort: 9251, manualTextractorMode: false,
    savedAt: 1000,
    ...overrides
  };
}


// ─── Credential promotion: precedence and conflict reporting ──────────
check('three-profiles-three-deepl-keys-global-empty-active-wins', () => {
  const profiles = [
    v0Profile({ name: 'Default', isDefault: true, savedAt: 100, deeplKey: 'key-A' }),
    v0Profile({ name: 'Nekopara', savedAt: 300, deeplKey: 'key-B' }),
    v0Profile({ name: 'Fate', savedAt: 200, deeplKey: 'key-C' })
  ];
  const result = migrateProfiles({ profiles, settings: { deeplKey: '' }, globalGlossaryEntries: [], activeProfile: 'Nekopara' });
  const conflict = result.report.credentialConflicts.find((c) => c.key === 'deeplKey');
  const pass = result.settings.deeplKey === 'key-B'
    && conflict && conflict.maskedValues.length === 3
    && JSON.stringify(result.backup.profiles) === JSON.stringify(profiles);
  return { pass, actual: { resolvedKey: result.settings.deeplKey, conflict, backupMatches: JSON.stringify(result.backup.profiles) === JSON.stringify(profiles) } };
}, 'Active profile wins over non-active profiles when global is empty. Conflict reported with all 3 masked values. Backup is a verbatim copy of the original 3 profiles — nothing is lost even though only one value survives in the live settings.');

check('global-non-empty-wins-over-all-profiles', () => {
  const profiles = [
    v0Profile({ name: 'A', savedAt: 500, deeplKey: 'profile-key-1' }),
    v0Profile({ name: 'B', savedAt: 100, deeplKey: 'profile-key-2' })
  ];
  const result = migrateProfiles({ profiles, settings: { deeplKey: 'the-real-global-key' }, globalGlossaryEntries: [], activeProfile: 'A' });
  const conflict = result.report.credentialConflicts.find((c) => c.key === 'deeplKey');
  const pass = result.settings.deeplKey === 'the-real-global-key' && !!conflict;
  return { pass, actual: { resolvedKey: result.settings.deeplKey, conflict } };
}, 'Global is the ground truth — pipeline.getEngine reads it, it is what has actually been translating. It wins outright even though it differs from every profile, and the divergence is still reported, never silently dropped.');

check('no-active-profile-match-falls-back-to-most-recent-savedat', () => {
  const profiles = [
    v0Profile({ name: 'Old', savedAt: 100, openaiKey: 'old-key' }),
    v0Profile({ name: 'Recent', savedAt: 900, openaiKey: 'recent-key' })
  ];
  // activeProfile references a name that no longer exists in `profiles`
  // (a corrupt/stale activeProfile pointer) — falls through to savedAt.
  const result = migrateProfiles({ profiles, settings: { openaiKey: '' }, globalGlossaryEntries: [], activeProfile: 'Ghost' });
  return { pass: result.settings.openaiKey === 'recent-key', actual: result.settings.openaiKey };
});

check('array-order-tiebreak-on-equal-savedat', () => {
  const profiles = [
    v0Profile({ name: 'First', savedAt: 500, apiKey: 'first-key' }),
    v0Profile({ name: 'Second', savedAt: 500, apiKey: 'second-key' })
  ];
  const result = migrateProfiles({ profiles, settings: { apiKey: '' }, globalGlossaryEntries: [], activeProfile: 'Ghost' });
  return { pass: result.settings.apiKey === 'first-key', actual: result.settings.apiKey };
});

check('single-non-empty-value-no-conflict-reported', () => {
  const profiles = [v0Profile({ name: 'Solo', deeplKey: 'only-key' })];
  const result = migrateProfiles({ profiles, settings: { deeplKey: '' }, globalGlossaryEntries: [], activeProfile: 'Solo' });
  return { pass: result.settings.deeplKey === 'only-key' && result.report.credentialConflicts.length === 0 };
});

// ─── targetLang / textractorCliPath / textractorPort ───────────────────
check('target-lang-follows-same-precedence', () => {
  const profiles = [v0Profile({ name: 'A', targetLang: 'fr' }), v0Profile({ name: 'B', targetLang: 'pt' })];
  const result = migrateProfiles({ profiles, settings: { targetLang: 'es' }, globalGlossaryEntries: [], activeProfile: 'A' });
  return { pass: result.settings.targetLang === 'es' && !!result.report.targetLangConflict };
});

check('textractor-port-treats-stock-default-as-empty', () => {
  // Global port is still the untouched stock default (9251) — the plan's
  // fix for the real-world bug (a switch resetting a custom port to
  // 9251): a profile's real custom port should win over an untouched
  // global default, not be discarded by it.
  const profiles = [v0Profile({ name: 'Nekopara', textractorPort: 6677 })];
  const result = migrateProfiles({ profiles, settings: { textractorPort: 9251 }, globalGlossaryEntries: [], activeProfile: 'Nekopara' });
  return { pass: result.settings.textractorPort === 6677, actual: result.settings.textractorPort };
});

check('textractor-port-global-non-default-wins', () => {
  // Mirrors Lyca's real install: global is already a real custom port
  // (non-default) — it must win, matching the documented real bug fix.
  const profiles = [v0Profile({ name: 'Nekopara', textractorPort: 9251 })];
  const result = migrateProfiles({ profiles, settings: { textractorPort: 6677 }, globalGlossaryEntries: [], activeProfile: 'Nekopara' });
  return { pass: result.settings.textractorPort === 6677, actual: result.settings.textractorPort };
});

check('textractor-cli-path-promotes-from-profile-when-global-empty', () => {
  const profiles = [v0Profile({ name: 'Nekopara', textractorCliPath: 'C:\\Textractor\\x86' })];
  const result = migrateProfiles({ profiles, settings: { textractorCliPath: '' }, globalGlossaryEntries: [], activeProfile: 'Nekopara' });
  return { pass: result.settings.textractorCliPath === 'C:\\Textractor\\x86' };
});

// ─── promoted keys never survive on any migrated profile ──────────────
check('no-migrated-profile-carries-a-promoted-key', () => {
  const profiles = [
    v0Profile({ name: 'A', deeplKey: 'x', openaiKey: 'y', apiKey: 'z', targetLang: 'fr', textractorCliPath: 'C:\\x', textractorPort: 6677 })
  ];
  const result = migrateProfiles({ profiles, settings: {}, globalGlossaryEntries: [], activeProfile: 'A' });
  const leaked = result.profiles.flatMap((p) => PROMOTED_TO_GLOBAL_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(p, k)));
  return { pass: leaked.length === 0, actual: leaked };
});

// ─── Glossary layer split ───────────────────────────────────────────────
check('converged-snapshots-perprofile-off-yield-empty-profile-layers', () => {
  const global = [glossaryEntry('Chocola', 'Chocola'), glossaryEntry('Vanilla', 'Vanilla')];
  // Simulates the real historical bug: with perProfileGlossary off, every
  // profile's snapshot converges to an exact copy of the global list.
  const profiles = [
    v0Profile({ name: 'A', glossary: [...global] }),
    v0Profile({ name: 'B', glossary: [...global] })
  ];
  const result = migrateProfiles({ profiles, settings: {}, globalGlossaryEntries: global, activeProfile: 'A' });
  const pass = result.profiles.every((p) => p.glossary.length === 0) && result.glossaryEntries === global;
  return { pass, actual: result.profiles.map((p) => p.glossary) };
});

check('divergent-snapshots-perprofile-on-preserve-deltas-exactly', () => {
  const global = [glossaryEntry('Chocola', 'Chocola')];
  const profiles = [
    v0Profile({ name: 'Nekopara', glossary: [...global, glossaryEntry('Vanilla', 'Vanilla-chan')] }),
    v0Profile({ name: 'Fate', glossary: [...global, glossaryEntry('Saber', 'Saber-sama')] })
  ];
  const result = migrateProfiles({ profiles, settings: {}, globalGlossaryEntries: global, activeProfile: 'Nekopara' });
  const nekopara = result.profiles.find((p) => p.name === 'Nekopara');
  const fate = result.profiles.find((p) => p.name === 'Fate');
  const pass = nekopara.glossary.length === 1 && nekopara.glossary[0].source === 'Vanilla'
    && fate.glossary.length === 1 && fate.glossary[0].source === 'Saber';
  return { pass, actual: { nekopara: nekopara.glossary, fate: fate.glossary } };
});

check('split-glossary-layer-equivalence-is-mode-source-target-never-id', () => {
  const global = [{ id: 'global-id-1', source: 'x', target: 'y', mode: 'exact', enabled: true, createdAt: 1 }];
  // Same (mode, source, target) as global but a DIFFERENT id (as if
  // regenerated by a re-import) — must still be recognized as a duplicate
  // and dropped from the profile layer.
  const profileGlossary = [{ id: 'totally-different-id', source: 'x', target: 'y', mode: 'exact', enabled: true, createdAt: 999 }];
  const result = splitGlossaryLayer(profileGlossary, global);
  return { pass: result.length === 0, actual: result };
});

check('glossary-entry-key-does-not-collide-on-embedded-space', () => {
  // Regression guard: glossaryEntryKey() must join fields with something
  // that can't appear inside a real source/target (found live — a prior
  // edit had silently swapped the `\0` separator for a plain space, which
  // lets {source:'a b', target:'c'} collide with {source:'a', target:'b c'}
  // under the same mode. A profile entry that's a genuine near-miss of a
  // global entry must NOT be treated as a duplicate and dropped.
  const global = [{ id: 'g1', mode: 'exact', source: 'a b', target: 'c', enabled: true, createdAt: 1 }];
  const profileGlossary = [{ id: 'p1', mode: 'exact', source: 'a', target: 'b c', enabled: true, createdAt: 2 }];
  const result = splitGlossaryLayer(profileGlossary, global);
  return { pass: result.length === 1 && result[0].id === 'p1', actual: result };
});

// ─── The union invariant, asserted directly on every fixture above ────
check('union-invariant-backup-is-verbatim-for-all-fixtures', () => {
  const fixtures = [
    { profiles: [v0Profile({ name: 'A', deeplKey: 'k1' })], settings: {}, globalGlossaryEntries: [], activeProfile: 'A' },
    { profiles: [v0Profile({ name: 'B', glossary: [glossaryEntry('x', 'y')] })], settings: {}, globalGlossaryEntries: [], activeProfile: 'B' }
  ];
  const failures = fixtures.filter((f) => {
    const result = migrateProfiles(f);
    return JSON.stringify(result.backup.profiles) !== JSON.stringify(f.profiles)
      || JSON.stringify(result.backup.glossary) !== JSON.stringify(f.globalGlossaryEntries);
  });
  return { pass: failures.length === 0, actual: failures };
}, 'backup.profiles / backup.glossary must be an exact deep copy of the pre-migration input — this is what makes the union invariant hold even in the one genuinely irreversible case (a shadowed credential).');

// ─── Idempotence ─────────────────────────────────────────────────────
check('idempotent-second-pass-on-first-pass-output-is-a-no-op', () => {
  const profiles = [
    v0Profile({ name: 'Default', isDefault: true, savedAt: 100, deeplKey: 'key-A' }),
    v0Profile({ name: 'Nekopara', savedAt: 300, deeplKey: 'key-B', glossary: [glossaryEntry('Vanilla', 'Vanilla-chan')] })
  ];
  const global = [glossaryEntry('Chocola', 'Chocola')];
  const round1 = migrateProfiles({ profiles, settings: { deeplKey: '' }, globalGlossaryEntries: global, activeProfile: 'Nekopara' });

  const activeName = round1.profiles.find((p) => p.id === round1.activeProfileId).name;
  const round2 = migrateProfiles({
    profiles: round1.profiles,
    settings: round1.settings,
    globalGlossaryEntries: round1.glossaryEntries,
    activeProfile: activeName
  });

  const pass = round2.changed === false
    && JSON.stringify(round2.profiles) === JSON.stringify(round1.profiles)
    && JSON.stringify(round2.settings) === JSON.stringify(round1.settings)
    && round2.activeProfileId === round1.activeProfileId;
  return { pass, actual: { round1changed: round1.changed, round2changed: round2.changed } };
});

// ─── A v1 store passes through untouched ────────────────────────────
check('already-v1-store-changed-is-false', () => {
  const profiles = [
    { id: 'uuid-1', name: 'Por Defecto', isDefault: true, createdAt: 1, savedAt: 1,
      sourceLang: 'auto', inputMethod: 'textractor', engine: 'google-free',
      customEndpoint: '', customModel: '', libretranslateEndpoint: '',
      customMTEndpoint: '', customMTMethod: '', customMTBody: '', customMTResponsePath: '', customMTAuthHeader: '',
      manualTextractorMode: false, glossary: [], hook: null, history: [] }
  ];
  const result = migrateProfiles({ profiles, settings: { deeplKey: 'already-global' }, globalGlossaryEntries: [], activeProfile: 'Por Defecto' });
  return { pass: result.changed === false, actual: result.changed };
});

// ─── v1 -> v2: seedDeeplCustomInstructions (pure function) ─────────────
// v3.13.80: deeplCustomInstructions became profile-scoped after custom
// instructions were verified to actually work on DeepL's Free tier. This
// step exists so that promotion doesn't blank out instructions a user
// already wrote in the (until now global-only) setting — every existing
// profile is seeded from the current global value the first time an
// already-migrated store passes through this step.
const v1Profile = (overrides) => ({
  id: overrides.id || `uuid-${overrides.name}`, name: 'Profile', isDefault: false,
  createdAt: 1, savedAt: 1,
  sourceLang: 'auto', inputMethod: 'textractor', engine: 'deepl',
  customEndpoint: '', customModel: '', llmProvider: 'openai', llmModel: '', llmCustomBaseUrl: '',
  localLlmEndpointPreset: 'custom', libretranslateEndpoint: '',
  customMTEndpoint: '', customMTMethod: '', customMTBody: '', customMTResponsePath: '', customMTAuthHeader: '',
  manualTextractorMode: false, deeplGlossaryId: '', deeplAutoGlossary: false, deeplGlossarySync: null,
  glossary: [], hook: null, cover: null, history: [],
  ...overrides
});

check('seed-deepl-custom-instructions-fills-empty-profiles-from-global', () => {
  const profiles = [v1Profile({ name: 'A' }), v1Profile({ name: 'B' })];
  const globalInstructions = ['Use archaic formal Spanish', 'Never translate the word Youkai'];
  const { profiles: seeded, changed } = seedDeeplCustomInstructions(profiles, globalInstructions);
  const pass = changed === true
    && seeded.every((p) => JSON.stringify(p.deeplCustomInstructions) === JSON.stringify(globalInstructions));
  return { pass, actual: seeded.map((p) => p.deeplCustomInstructions) };
}, 'Without this seed, the first load-profile after v3.13.80 ships would overwrite the user\'s real global instructions with the new field\'s [] default — this is what prevents that.');

check('seed-deepl-custom-instructions-is-idempotent-on-non-empty-profile', () => {
  const alreadySeeded = ['Keep character names untranslated'];
  const profiles = [v1Profile({ name: 'A', deeplCustomInstructions: alreadySeeded })];
  const { profiles: seeded, changed } = seedDeeplCustomInstructions(profiles, ['A different global value']);
  const pass = changed === false && JSON.stringify(seeded[0].deeplCustomInstructions) === JSON.stringify(alreadySeeded);
  return { pass, actual: seeded[0].deeplCustomInstructions };
}, 'A profile that already has its own instructions (re-run, or created after the field existed) is never overwritten by a global value — only a genuinely-empty profile gets seeded.');

check('seed-deepl-custom-instructions-no-op-when-global-empty', () => {
  const profiles = [v1Profile({ name: 'A' })];
  const { profiles: seeded, changed } = seedDeeplCustomInstructions(profiles, []);
  const pass = changed === false && seeded[0].deeplCustomInstructions.length === 0;
  return { pass, actual: seeded[0].deeplCustomInstructions };
}, 'A user who never wrote global instructions has nothing to preserve — the profile stays [], and the DeepL engine\'s own DEFAULT_INSTRUCTIONS fallback applies exactly as it did before this field existed.');

// ─── v2 -> v3: seedDeeplFormality (pure function) ──────────────────────
// v3.13.80, same day: deeplFormality became profile-scoped too, on Lyca's
// explicit request after the instructions scoping above. Same shape of
// step, same reason to exist — see seedDeeplCustomInstructions above.
check('seed-deepl-formality-fills-empty-profiles-from-global', () => {
  const profiles = [v1Profile({ name: 'A' }), v1Profile({ name: 'B' })];
  const { profiles: seeded, changed } = seedDeeplFormality(profiles, 'prefer_more');
  const pass = changed === true && seeded.every((p) => p.deeplFormality === 'prefer_more');
  return { pass, actual: seeded.map((p) => p.deeplFormality) };
}, 'Without this seed, the first load-profile after v3.13.80 ships would overwrite the user\'s already-tuned global formality with the new field\'s \'\' default.');

check('seed-deepl-formality-is-idempotent-on-non-empty-profile', () => {
  const profiles = [v1Profile({ name: 'A', deeplFormality: 'prefer_less' })];
  const { profiles: seeded, changed } = seedDeeplFormality(profiles, 'prefer_more');
  const pass = changed === false && seeded[0].deeplFormality === 'prefer_less';
  return { pass, actual: seeded[0].deeplFormality };
}, 'A profile that already has its own formality (re-run, or created after the field existed) is never overwritten by a global value — only a genuinely-unset (\'\') profile gets seeded.');

check('seed-deepl-formality-no-op-when-global-empty', () => {
  const profiles = [v1Profile({ name: 'A' })];
  const { profiles: seeded, changed } = seedDeeplFormality(profiles, '');
  const pass = changed === false && seeded[0].deeplFormality === '';
  return { pass, actual: seeded[0].deeplFormality };
}, "Global formality is never really empty in practice (main/index.js defaults it to 'prefer_more'), but the function must still no-op cleanly if it somehow is.");

// ─── ProfileStore#migrate() stepping through an already-v1 store ──────
check('migrate-from-v1-only-seeds-does-not-resplit-glossary', () => {
  // The real risk this guards: re-running the FULL v0->v1 migrateProfiles
  // (glossary re-split included) against an already-migrated store would
  // re-evaluate splitGlossaryLayer() against whatever the CURRENT global
  // glossary looks like now — which may have grown since the original v0
  // migration to include terms that used to be profile-only, silently
  // stripping them. Stepping from v1 must skip that entirely.
  const profileOnlyEntry = glossaryEntry('Vanilla', 'Vanilla-chan');
  const store = createFakeStore({
    profiles: [v1Profile({ name: 'Nekopara', glossary: [profileOnlyEntry] })],
    activeProfile: 'Nekopara',
    profilesSchemaVersion: 1
  });
  const ps = new ProfileStore(store);
  // The global glossary passed in now happens to already contain the same
  // (mode, source, target) as the profile-only entry above — simulating
  // "grew since the v0 migration ran". If migrate() re-ran the v0 step,
  // this would strip it from the profile.
  ps.migrate([profileOnlyEntry]);
  const nekopara = ps.getById('uuid-Nekopara');
  const pass = !!nekopara && nekopara.glossary.length === 1 && nekopara.glossary[0].source === 'Vanilla';
  return { pass, actual: nekopara.glossary };
}, 'An already-v1 store must only run the v1->v2 seed step — re-running the v0 glossary split here would be a real regression, not a harmless no-op.');

check('migrate-from-v2-only-seeds-formality-does-not-reseed-instructions', () => {
  // Mirrors the v1-stepping test above, one version later: a store that
  // already went through the v1->v2 instructions seed (real content on the
  // profile) must not have that content clobbered by re-running the v1->v2
  // step again — only v2->v3 (formality) should run.
  const alreadySeededInstructions = ['Keep character names untranslated'];
  const store = createFakeStore({
    profiles: [v1Profile({ name: 'Nekopara', deeplCustomInstructions: alreadySeededInstructions })],
    activeProfile: 'Nekopara',
    profilesSchemaVersion: 2,
    // Deliberately different from what's already on the profile — if the
    // v1->v2 step re-ran, this is what it would incorrectly overwrite with.
    deeplCustomInstructions: ['A DIFFERENT global value that must not leak in'],
    deeplFormality: 'prefer_less'
  });
  const ps = new ProfileStore(store);
  ps.migrate([]);
  const nekopara = ps.getById('uuid-Nekopara');
  const pass = !!nekopara
    && JSON.stringify(nekopara.deeplCustomInstructions) === JSON.stringify(alreadySeededInstructions)
    && nekopara.deeplFormality === 'prefer_less';
  return { pass, actual: nekopara };
}, 'An already-v2 store must only run the v2->v3 formality seed — re-running the v1->v2 instructions seed here would be a real regression (it would still no-op given its own idempotency check, but the version-gate is what should actually prevent it from running at all).');

check('migrate-from-v1-seeds-existing-profiles-and-bumps-version', () => {
  const store = createFakeStore({
    profiles: [v1Profile({ name: 'Nekopara' }), v1Profile({ name: 'Fate' })],
    activeProfile: 'Nekopara',
    profilesSchemaVersion: 1,
    deeplCustomInstructions: ['Preserve honorifics like -senpai']
  });
  const ps = new ProfileStore(store);
  const setCallsBefore = store._setCallCount();
  const result = ps.migrate([]);
  const setCallsAfter = store._setCallCount();
  const raw = store._raw();
  const pass = result.ran === true
    && (setCallsAfter - setCallsBefore) === 1
    && raw.profilesSchemaVersion === PROFILE_SCHEMA_VERSION
    && raw.profiles.every((p) => JSON.stringify(p.deeplCustomInstructions) === JSON.stringify(['Preserve honorifics like -senpai']))
    // v0->v1-only fields (profilesBackupV0) must NOT be (re)written when
    // starting from v1 — nothing in this run touched credentials/glossary.
    && raw.profilesBackupV0 === undefined;
  return { pass, actual: raw };
}, 'One write, both existing profiles seeded from the real global value, version lands on PROFILE_SCHEMA_VERSION — and no v0-only backup key appears, confirming the v0 step genuinely did not run.');

// ─── Dead settings stripped ─────────────────────────────────────────
check('dead-settings-are-stripped', () => {
  const settings = { perProfileGlossary: true, enableGlossary: true, enableCache: true, autoApplyGlossary: true, showSourceTextInOverlay: true, deeplKey: 'x' };
  const result = migrateProfiles({ profiles: [], settings, globalGlossaryEntries: [], activeProfile: 'Por Defecto' });
  const stillPresent = ['perProfileGlossary', 'enableGlossary', 'enableCache', 'autoApplyGlossary', 'showSourceTextInOverlay'].filter((k) => Object.prototype.hasOwnProperty.call(result.settings, k));
  return { pass: stillPresent.length === 0, actual: stillPresent };
}, 'showSourceTextInOverlay added in step 8 (v3.13.44) — looked legitimate (translated label across 8 locales) but had zero actual wiring, same dead-setting class as the original four.');

// ─── Ghost settings V2 stripped (settings UX audit, v3->v4) ────────────
check('strip-ghost-settings-v2-removes-all-six-keys', () => {
  const settings = {
    deeplStyleId: 'style-123', deeplTranslationMemoryId: 'tm-456', deeplTranslationMemoryThreshold: 90,
    deeplLanguageFeatures: { en: {} }, apiKey: 'legacy-key', profilesBackupV0: { profiles: [] },
    deeplKey: 'keep-me', targetLang: 'es'
  };
  const result = stripGhostSettingsV2(settings);
  const ghostKeys = ['deeplStyleId', 'deeplTranslationMemoryId', 'deeplTranslationMemoryThreshold', 'deeplLanguageFeatures', 'apiKey', 'profilesBackupV0'];
  const stillPresent = ghostKeys.filter((k) => Object.prototype.hasOwnProperty.call(result.settings, k));
  const pass = result.changed === true && stillPresent.length === 0
    && result.settings.deeplKey === 'keep-me' && result.settings.targetLang === 'es';
  return { pass, actual: { stillPresent, settings: result.settings } };
}, 'All six DEAD_SETTING_KEYS_V2 removed in one pass; unrelated real settings (deeplKey, targetLang) untouched.');

check('strip-ghost-settings-v2-is-a-no-op-when-nothing-to-strip', () => {
  const settings = { deeplKey: 'x', targetLang: 'es' };
  const result = stripGhostSettingsV2(settings);
  const pass = result.changed === false && JSON.stringify(result.settings) === JSON.stringify(settings);
  return { pass, actual: result };
}, 'Idempotent: a store already past this step (or that never had these keys) reports changed:false.');

check('profile-store-migrate-from-v3-strips-ghost-settings-and-keeps-existing-backup-gone', () => {
  // Simulates Lyca's real install: already fully migrated to v3 (the
  // v0->v1 step's own backup/promotion logic never runs again — see the
  // class doc comment on why re-running it against grown data would be a
  // regression), but still carrying the six now-dead keys from earlier
  // releases, including its own historical profilesBackupV0.
  const store = createFakeStore({
    profilesSchemaVersion: 3,
    profiles: [v0Profile({ name: 'Default', isDefault: true, deeplFormality: 'default', deeplCustomInstructions: [] })],
    activeProfile: 'Default',
    deeplKey: 'k1',
    deeplStyleId: 'style-123', deeplTranslationMemoryId: 'tm-456', deeplTranslationMemoryThreshold: 90,
    deeplLanguageFeatures: { en: {} }, apiKey: 'legacy-key', profilesBackupV0: { profiles: [] }
  });
  const ps = new ProfileStore(store);
  const setCallsBefore = store._setCallCount();
  const result = ps.migrate([]);
  const setCallsAfter = store._setCallCount();
  const raw = store._raw();
  const ghostKeys = ['deeplStyleId', 'deeplTranslationMemoryId', 'deeplTranslationMemoryThreshold', 'deeplLanguageFeatures', 'apiKey', 'profilesBackupV0'];
  const stillPresent = ghostKeys.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
  const pass = result.ran === true
    // The profiles/settings write stays a single set() call — the six
    // ghost-key deletes are separate, tracked store.delete() calls (see
    // createFakeStore()'s own comment on why they're counted apart).
    && (setCallsAfter - setCallsBefore) === 1
    && store._deleteCallCount() === ghostKeys.length
    && raw.profilesSchemaVersion === PROFILE_SCHEMA_VERSION
    && stillPresent.length === 0
    && raw.deeplKey === 'k1';
  return { pass, actual: { stillPresent, raw, deleteCalls: store._deleteCallCount() } };
}, 'Starting from v3 (already through v0->v1/v1->v2/v2->v3), only the new v3->v4 step runs — the six ghost keys, including a STALE historical backup that has already proven itself, are gone via real store.delete() calls (not just omitted from the merge-set); a real setting (deeplKey) survives.');

// ─── v4 -> v5: seedGameField (pure function) ───────────────────────────
// v3.13.85 (auto-configuración de juegos, Fase A): `game` isn't a
// PROFILE_SCOPED_SETTING_KEYS field (no global value to seed FROM), so
// this step is pure structural fill-in — unlike the DeepL seed steps
// above, `changed` is always false.
check('seed-game-field-fills-missing-key-with-null', () => {
  const profiles = [v1Profile({ name: 'A' }), v1Profile({ name: 'B' })];
  const { profiles: seeded, changed } = seedGameField(profiles);
  const pass = changed === false && seeded.every((p) => p.game === null);
  return { pass, actual: seeded.map((p) => p.game) };
});

check('seed-game-field-is-idempotent-on-already-populated-profile', () => {
  const gameLink = { exePath: 'C:\\Games\\x.exe', exeName: 'x.exe' };
  const profiles = [{ ...v1Profile({ name: 'A' }), game: gameLink }];
  const { profiles: seeded, changed } = seedGameField(profiles);
  const pass = changed === false && seeded[0].game === gameLink;
  return { pass, actual: seeded[0].game };
}, 'A profile that already has a `game` (populated OR explicit null) is left completely untouched — same object reference, not just an equal value.');

check('profile-store-migrate-from-v4-only-seeds-game-does-not-rerun-earlier-steps', () => {
  // Mirrors the v1/v2-stepping tests above, one version later: a store
  // already at v4 (through v0->v1/v1->v2/v2->v3/v3->v4) must run ONLY the
  // v4->v5 game-seed step, and leave a real, already-populated `game`
  // completely alone.
  const gameLink = { exePath: 'C:\\Games\\nekopara.exe', exeName: 'nekopara.exe', dirName: 'games', windowTitle: 'Nekopara', processName: 'nekopara', engine: null, arch: 'x86', detectedAt: 1 };
  const store = createFakeStore({
    profiles: [
      { ...v1Profile({ name: 'Nekopara' }), game: gameLink },
      v1Profile({ name: 'Fate' }) // no `game` key at all — the v4-and-earlier shape
    ],
    activeProfile: 'Nekopara',
    profilesSchemaVersion: 4
  });
  const ps = new ProfileStore(store);
  const setCallsBefore = store._setCallCount();
  const result = ps.migrate([]);
  const setCallsAfter = store._setCallCount();
  const raw = store._raw();
  const nekopara = raw.profiles.find((p) => p.name === 'Nekopara');
  const fate = raw.profiles.find((p) => p.name === 'Fate');
  const pass = result.ran === true
    && (setCallsAfter - setCallsBefore) === 1
    && raw.profilesSchemaVersion === PROFILE_SCHEMA_VERSION
    && JSON.stringify(nekopara.game) === JSON.stringify(gameLink)
    && fate.game === null;
  return { pass, actual: { nekopara: nekopara.game, fate: fate.game } };
}, 'Starting from v4, only the new v4->v5 step runs: a real game link survives untouched, and a profile with no `game` key at all gets it seeded to null.');

// ─── ProfileStore#migrate() wrapper: version gate + one write ─────────
check('profile-store-migrate-runs-once-and-gates-by-version', () => {
  const store = createFakeStore({
    profiles: [v0Profile({ name: 'Default', isDefault: true, deeplKey: 'k1' })],
    activeProfile: 'Default',
    deeplKey: ''
  });
  const ps = new ProfileStore(store);
  const setCallsBefore = store._setCallCount();
  const first = ps.migrate([]);
  const setCallsAfterFirst = store._setCallCount();
  const second = ps.migrate([]);
  const setCallsAfterSecond = store._setCallCount();

  const pass = first.ran === true
    && (setCallsAfterFirst - setCallsBefore) === 1
    && second.ran === false
    && setCallsAfterSecond === setCallsAfterFirst
    && store._raw().profilesSchemaVersion === PROFILE_SCHEMA_VERSION
    && !!store._raw().profilesBackupV0
    && store._raw().deeplKey === 'k1';
  return { pass, actual: { first, second, raw: store._raw() } };
}, 'Exactly one store.set() call for the actual migration; calling migrate() again on an already-v1 store makes zero further writes.');

check('profile-store-migrate-resolves-active-profile-id', () => {
  const store = createFakeStore({
    profiles: [v0Profile({ name: 'Default', isDefault: true }), v0Profile({ name: 'Nekopara' })],
    activeProfile: 'Nekopara'
  });
  const ps = new ProfileStore(store);
  ps.migrate([]);
  const active = ps.getActive();
  return { pass: !!active && active.name === 'Nekopara', actual: active };
});

// ─── ProfileStore CRUD sanity (used directly by Step 4) ────────────────
check('profile-store-create-is-blank-without-clonefromid', () => {
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  const created = ps.create({ name: 'New Game' });
  const pass = created.glossary.length === 0 && created.history.length === 0 && created.sourceLang === 'auto';
  return { pass, actual: created };
});

check('profile-store-duplicate-clones-explicitly', () => {
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  const original = ps.create({ name: 'Nekopara' });
  ps.update(original.id, () => ({ sourceLang: 'ja', glossary: [glossaryEntry('Chocola', 'Chocola')] }));
  const dup = ps.duplicate(original.id, 'Nekopara Vol 2');
  const pass = dup.id !== original.id && dup.sourceLang === 'ja' && dup.glossary.length === 1 && dup.name === 'Nekopara Vol 2';
  return { pass, actual: dup };
});

check('profile-store-duplicate-does-not-copy-game-or-deeplGlossarySync', () => {
  // v3.13.85 (auto-configuración de juegos, Fase A): without this, two
  // profiles would end up claiming the same game process (permanently
  // ambiguous for game-identity.js's matching, no visible symptom until
  // both are open) — and deleting the duplicate would orphan/kill the
  // ORIGINAL's remote DeepL glossary via delete-profile's best-effort
  // cleanup, since deeplGlossarySync.glossaryId would be duplicated too.
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  const original = ps.create({ name: 'Nekopara' });
  ps.update(original.id, () => ({
    game: { exePath: 'C:\\Games\\nekopara.exe', exeName: 'nekopara.exe', dirName: 'games', windowTitle: 'Nekopara', processName: 'nekopara', engine: null, arch: 'x86', detectedAt: 1 },
    deeplGlossarySync: { glossaryId: 'remote-g1', hash: 'abc', sourceLang: 'ja', targetLang: 'es' }
  }));
  const dup = ps.duplicate(original.id, 'Nekopara Vol 2');
  const pass = dup.game === null && dup.deeplGlossarySync === null;
  return { pass, actual: { game: dup.game, deeplGlossarySync: dup.deeplGlossarySync } };
});

check('profile-store-rename-rejects-duplicate-name', () => {
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  const a = ps.create({ name: 'A' });
  ps.create({ name: 'B' });
  let threw = false;
  try { ps.rename(a.id, 'B'); } catch (e) { threw = true; }
  return { pass: threw };
});

check('profile-store-remove-refuses-default', () => {
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  ps.ensureDefault({});
  const def = ps.list()[0];
  let threw = false;
  try { ps.remove(def.id); } catch (e) { threw = true; }
  return { pass: threw && ps.list().length === 1 };
});

check('profile-store-remove-active-falls-back-to-default', () => {
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  ps.ensureDefault({});
  const def = ps.list()[0];
  const extra = ps.create({ name: 'Temp' });
  ps.setActive(extra.id);
  ps.remove(extra.id);
  return { pass: ps.getActiveId() === def.id, actual: ps.getActiveId() };
});

check('profile-store-ensure-default-does-not-duplicate', () => {
  const store = createFakeStore({ profiles: [] });
  const ps = new ProfileStore(store);
  ps.ensureDefault({});
  ps.ensureDefault({});
  return { pass: ps.list().length === 1, actual: ps.list().length };
});

run("profile-migrations.js / profile-store.js bench", CHECKS);
