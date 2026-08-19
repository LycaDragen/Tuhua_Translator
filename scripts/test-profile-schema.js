/**
 * profile-schema.js bench — pure decision table, no Electron, no store.
 * See src/services/profiles/profile-schema.js for the full rationale.
 *
 * The load-bearing assertion here is CASE 'profile-to-settings-never-emits-a-promoted-key':
 * this is what permanently closes the class of bug that made a profile
 * switch silently reset a custom Textractor port back to 9251 (the port
 * was written into global settings by the old load-profile handler even
 * though gatherConfig() deliberately never sends it — see
 * renderer/main/renderer.js's gatherConfig comment).
 *
 *   node scripts/test-profile-schema.js
 *   node scripts/test-profile-schema.js --quiet
 */
const path = require('path');
const {
  PROFILE_SCHEMA_VERSION,
  PROFILE_SCOPED_SETTING_KEYS,
  PROMOTED_TO_GLOBAL_KEYS,
  createProfile,
  normalizeProfile,
  validateProfile,
  profileToSettings,
  settingsToProfile
} = require(path.join('..', 'src', 'services', 'profiles', 'profile-schema.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

const EXPECTED_FIELDS = [
  'id', 'name', 'isDefault', 'createdAt', 'savedAt',
  'sourceLang', 'inputMethod', 'engine',
  'customEndpoint', 'customModel',
  // v3.13.58 (Fase 3): cloud-LLM analogues of customEndpoint/customModel.
  'llmProvider', 'llmModel', 'llmCustomBaseUrl', 'localLlmEndpointPreset',
  'libretranslateEndpoint',
  'customMTEndpoint', 'customMTMethod', 'customMTBody', 'customMTResponsePath', 'customMTAuthHeader',
  'manualTextractorMode', 'glossary', 'hook', 'cover', 'history'
].sort();

const LEGACY_V0_PROFILE = {
  name: 'Nekopara',
  isDefault: false,
  sourceLang: 'ja',
  targetLang: 'es',
  inputMethod: 'textractor',
  engine: 'deepl',
  deeplKey: 'sk-legacy-deepl-key',
  openaiKey: '',
  apiKey: 'legacy-generic-key',
  customEndpoint: '',
  customModel: '',
  libretranslateEndpoint: '',
  customMTEndpoint: '', customMTMethod: '', customMTBody: '', customMTResponsePath: '', customMTAuthHeader: '',
  glossary: [{ id: 'a1', source: 'Chocola', target: 'Chocola', mode: 'exact', enabled: true, createdAt: 1 }],
  history: [{ source: 'こんにちは', translated: 'Hola', timestamp: 1 }],
  textractorCliPath: 'C:\\Textractor\\x86',
  textractorPort: 6677,
  manualTextractorMode: false,
  savedAt: 123456789
};

const CHECKS = [];
function check(id, fn, note) {
  CHECKS.push({ id, fn, note });
}

// ─── createProfile: exactly the documented field set, nothing more ────────
check('create-profile-emits-exactly-documented-fields', () => {
  const p = createProfile({ name: 'Test' });
  const actual = Object.keys(p).sort();
  return { pass: JSON.stringify(actual) === JSON.stringify(EXPECTED_FIELDS), actual, expected: EXPECTED_FIELDS };
}, 'The single-source-of-truth assertion: if this drifts, one of the four old divergent literals has crept back in somewhere.');

check('create-profile-defaults-are-sane', () => {
  const p = createProfile({ name: 'Test' });
  const pass = p.sourceLang === 'auto' && p.inputMethod === 'textractor' && p.engine === 'google-free'
    && p.isDefault === false && Array.isArray(p.glossary) && p.glossary.length === 0
    && p.hook === null && p.cover === null && Array.isArray(p.history) && p.history.length === 0
    && typeof p.id === 'string' && p.id.length > 0;
  return { pass, actual: p };
});

check('create-profile-generates-unique-ids', () => {
  const a = createProfile({ name: 'A' });
  const b = createProfile({ name: 'B' });
  return { pass: a.id !== b.id, actual: { a: a.id, b: b.id } };
});

check('create-profile-preserves-explicit-id', () => {
  const p = createProfile({ name: 'Test', id: 'fixed-id-123' });
  return { pass: p.id === 'fixed-id-123', actual: p.id };
});

// ─── normalizeProfile: structural drop of legacy keys ──────────────────────
check('normalize-profile-drops-legacy-keys', () => {
  const p = normalizeProfile(LEGACY_V0_PROFILE);
  const leaked = PROMOTED_TO_GLOBAL_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(p, k));
  return { pass: leaked.length === 0, actual: leaked };
}, 'deeplKey/openaiKey/apiKey/targetLang/textractorCliPath/textractorPort must not survive normalization.');

check('normalize-profile-preserves-known-fields', () => {
  const p = normalizeProfile(LEGACY_V0_PROFILE);
  const pass = p.name === 'Nekopara' && p.sourceLang === 'ja' && p.engine === 'deepl'
    && p.glossary.length === 1 && p.glossary[0].source === 'Chocola'
    && p.history.length === 1 && p.savedAt === 123456789;
  return { pass, actual: p };
});

check('normalize-profile-throws-on-non-object', () => {
  let threw = false;
  try { normalizeProfile(null); } catch (e) { threw = true; }
  return { pass: threw };
});

// ─── validateProfile ────────────────────────────────────────────────────
check('validate-profile-accepts-a-fresh-profile', () => {
  const { valid, errors } = validateProfile(createProfile({ name: 'Test' }));
  return { pass: valid && errors.length === 0, actual: errors };
});

check('validate-profile-rejects-a-promoted-key', () => {
  const p = createProfile({ name: 'Test' });
  p.deeplKey = 'should not be here';
  const { valid, errors } = validateProfile(p);
  return { pass: valid === false && errors.some((e) => e.includes('deeplKey')), actual: errors };
}, 'The regression guard: a profile carrying a promoted-to-global key must fail validation.');

check('validate-profile-rejects-missing-scoped-key', () => {
  const p = createProfile({ name: 'Test' });
  delete p.sourceLang;
  const { valid, errors } = validateProfile(p);
  return { pass: valid === false && errors.some((e) => e.includes('sourceLang')), actual: errors };
});

check('validate-profile-rejects-empty-name', () => {
  const p = createProfile({ name: '   ' });
  const { valid } = validateProfile(p);
  return { pass: valid === false };
});

// ─── profileToSettings: the load-bearing assertion ─────────────────────
check('profile-to-settings-never-emits-a-promoted-key', () => {
  // Simulate a profile that (incorrectly, defensively) still carries a
  // promoted key — profileToSettings must ignore it regardless, because
  // it only reads PROFILE_SCOPED_SETTING_KEYS by construction.
  const p = createProfile({ name: 'Test' });
  p.textractorPort = 9251; // must never leak into the projection
  p.deeplKey = 'leaked-key';
  const settings = profileToSettings(p);
  const leaked = PROMOTED_TO_GLOBAL_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(settings, k));
  return { pass: leaked.length === 0, actual: settings };
}, 'This is THE bench assertion that closes the textractorPort-reset-to-9251 bug class permanently.');

check('profile-to-settings-emits-exactly-the-scoped-keys', () => {
  const p = createProfile({ name: 'Test', sourceLang: 'ja', engine: 'deepl' });
  const settings = profileToSettings(p);
  const actual = Object.keys(settings).sort();
  const expected = [...PROFILE_SCOPED_SETTING_KEYS].sort();
  return { pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected };
});

check('profile-to-settings-round-trips-values', () => {
  const p = createProfile({ name: 'Test', sourceLang: 'ja', engine: 'deepl', manualTextractorMode: true });
  const settings = profileToSettings(p);
  return { pass: settings.sourceLang === 'ja' && settings.engine === 'deepl' && settings.manualTextractorMode === true };
});

// ─── settingsToProfile ──────────────────────────────────────────────────
check('settings-to-profile-updates-scoped-keys-only', () => {
  const existing = createProfile({ name: 'Nekopara', sourceLang: 'ja' });
  existing.glossary = [{ id: 'a1', source: 'x', target: 'y', mode: 'exact', enabled: true, createdAt: 1 }];
  existing.hook = { hookCode: 'HQ8@0', source: 'manual' };
  existing.cover = { url: 'https://t.vndb.org/cv/01/23.jpg', vnId: 'v49181', vnTitle: 'Nekopara' };
  const settings = { sourceLang: 'auto', engine: 'openai', deeplKey: 'ignored-not-scoped' };
  const updated = settingsToProfile(settings, existing);
  const pass = updated.sourceLang === 'auto' && updated.engine === 'openai'
    && !Object.prototype.hasOwnProperty.call(updated, 'deeplKey')
    && updated.glossary.length === 1 && updated.hook.hookCode === 'HQ8@0'
    && updated.cover.vnId === 'v49181'
    && updated.id === existing.id && updated.name === 'Nekopara';
  return { pass, actual: updated };
}, 'glossary/hook/cover/history/id/name/isDefault/createdAt survive untouched; deeplKey (not in PROFILE_SCOPED_SETTING_KEYS) is ignored even though it was present in the settings object.');

check('normalize-profile-preserves-cover-field', () => {
  const raw = { ...LEGACY_V0_PROFILE, cover: { url: 'https://t.vndb.org/cv/01/23.jpg', vnId: 'v49181', vnTitle: 'Nekopara' } };
  const p = normalizeProfile(raw);
  return { pass: p.cover !== null && p.cover.vnId === 'v49181' && p.cover.url.includes('vndb'), actual: p.cover };
}, 'cover (VNDB import thumbnail) is a real schema field, not dropped like the pre-v1 legacy keys.');

check('settings-to-profile-bumps-saved-at', () => {
  const existing = createProfile({ name: 'Test' });
  const before = existing.savedAt;
  // Force a tick so Date.now() cannot tie by coincidence in a fast run.
  const updated = settingsToProfile({}, { ...existing, savedAt: before - 1000 });
  return { pass: updated.savedAt > before - 1000 };
});

check('settings-to-profile-throws-without-existing-profile', () => {
  let threw = false;
  try { settingsToProfile({}, null); } catch (e) { threw = true; }
  return { pass: threw };
});

// ─── Round-trip identity over the scoped subset ────────────────────────
check('round-trip-identity-over-scoped-subset', () => {
  const original = createProfile({
    name: 'Test', sourceLang: 'ja', inputMethod: 'textractor', engine: 'deepl',
    customMTEndpoint: 'http://x', manualTextractorMode: true
  });
  const settings = profileToSettings(original);
  const roundTripped = settingsToProfile(settings, original);
  const pass = PROFILE_SCOPED_SETTING_KEYS.every((k) => roundTripped[k] === original[k]);
  return { pass, actual: roundTripped, expected: original };
});

check('schema-version-is-1', () => ({ pass: PROFILE_SCHEMA_VERSION === 1 }));

// ─── v3.13.58 (Fase 3): llmProvider* fields ─────────────────────────────
check('llm-provider-keys-is-promoted-to-global-not-scoped', () => {
  const pass = PROMOTED_TO_GLOBAL_KEYS.includes('llmProviderKeys') && !PROFILE_SCOPED_SETTING_KEYS.includes('llmProviderKeys');
  return { pass };
}, 'Credentials stay global — same reasoning as deeplKey/apiKey. A profile carrying this key fails validateProfile (see the promoted-key rejection case above).');

check('normalize-profile-defaults-localLlmEndpointPreset-to-custom-not-a-real-preset', () => {
  // A v0/pre-Fase-3 profile with a manually-set customEndpoint (e.g.
  // pointed at Ollama's :11434) and no localLlmEndpointPreset field at
  // all must NOT come out pointed at a different preset's port after
  // normalization — 'custom' is the only default that defers entirely to
  // the existing customEndpoint value instead of overriding it.
  const legacyProfile = { name: 'Old Profile', customEndpoint: 'http://localhost:11434/v1' };
  const normalized = normalizeProfile(legacyProfile);
  return { pass: normalized.localLlmEndpointPreset === 'custom', actual: normalized.localLlmEndpointPreset };
});

check('llmProvider-defaults-to-openai', () => {
  const normalized = normalizeProfile({ name: 'X' });
  return { pass: normalized.llmProvider === 'openai', actual: normalized.llmProvider };
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

  console.log(`${C.bold}profile-schema.js bench${C.reset} — ${results.length} case(s)\n`);
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
