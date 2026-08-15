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
const { migrateProfiles, resolvePromotedValue, splitGlossaryLayer } =
  require(path.join('..', 'src', 'services', 'profiles', 'profile-migrations.js'));
const ProfileStore = require(path.join('..', 'src', 'services', 'profiles', 'profile-store.js'));
const { PROFILE_SCHEMA_VERSION, PROMOTED_TO_GLOBAL_KEYS } =
  require(path.join('..', 'src', 'services', 'profiles', 'profile-schema.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

function createFakeStore(initialData = {}) {
  let data = JSON.parse(JSON.stringify(initialData));
  let setCalls = 0;
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
    _raw: () => JSON.parse(JSON.stringify(data)),
    _setCallCount: () => setCalls
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

const CHECKS = [];
function check(id, fn, note) {
  CHECKS.push({ id, fn, note });
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

// ─── Dead settings stripped ─────────────────────────────────────────
check('dead-settings-are-stripped', () => {
  const settings = { perProfileGlossary: true, enableGlossary: true, enableCache: true, autoApplyGlossary: true, showSourceTextInOverlay: true, deeplKey: 'x' };
  const result = migrateProfiles({ profiles: [], settings, globalGlossaryEntries: [], activeProfile: 'Por Defecto' });
  const stillPresent = ['perProfileGlossary', 'enableGlossary', 'enableCache', 'autoApplyGlossary', 'showSourceTextInOverlay'].filter((k) => Object.prototype.hasOwnProperty.call(result.settings, k));
  return { pass: stillPresent.length === 0, actual: stillPresent };
}, 'showSourceTextInOverlay added in step 8 (v3.13.44) — looked legitimate (translated label across 8 locales) but had zero actual wiring, same dead-setting class as the original four.');

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

function run() {
  const args = parseArgs(process.argv.slice(2));
  const results = CHECKS.map((c) => {
    let outcome;
    try {
      outcome = c.fn();
    } catch (e) {
      outcome = { pass: false, error: e.message };
    }
    return { id: c.id, note: c.note, ...outcome };
  });

  console.log(`${C.bold}profile-migrations.js / profile-store.js bench${C.reset} — ${results.length} case(s)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  process.exit(passed === results.length ? 0 : 1);
}

run();
