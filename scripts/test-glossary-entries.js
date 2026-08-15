/**
 * glossary-entries.js bench — pure decision table, no Electron, no store.
 * See src/services/translation/glossary-entries.js for the full rationale:
 * these are the exact primitives both the GLOBAL layer (GlossaryService,
 * store-backed) and the PER-PROFILE layer (a plain array at
 * profile.glossary[], mutated via ProfileStore#update()) share, so the
 * entry-shape logic can't drift between the two scopes.
 *
 *   node scripts/test-glossary-entries.js
 *   node scripts/test-glossary-entries.js --quiet
 */
const path = require('path');
const glossaryEntries = require(path.join('..', 'src', 'services', 'translation', 'glossary-entries.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

const CHECKS = [];
function check(id, fn, note) {
  CHECKS.push({ id, fn, note });
}

check('generate-id-uniqueness', () => {
  const ids = new Set(Array.from({ length: 100 }, () => glossaryEntries.generateId()));
  return { pass: ids.size === 100, actual: ids.size };
});

check('create-entry-defaults', () => {
  const e = glossaryEntries.createEntry({ source: 'foo', target: 'bar' });
  const pass = e.mode === 'exact' && e.enabled === true && typeof e.id === 'string' && typeof e.createdAt === 'number';
  return { pass, actual: e };
});

check('create-entry-respects-explicit-mode-and-enabled', () => {
  const e = glossaryEntries.createEntry({ source: 'foo', target: 'bar', mode: 'regex', enabled: false });
  return { pass: e.mode === 'regex' && e.enabled === false, actual: e };
});

check('add-entry-appends-and-returns-new-entry', () => {
  const { list, entry } = glossaryEntries.addEntry([], { source: 'a', target: 'b' });
  const pass = list.length === 1 && list[0].id === entry.id && entry.source === 'a';
  return { pass, actual: { list, entry } };
});

check('add-entry-handles-null-list', () => {
  const { list } = glossaryEntries.addEntry(null, { source: 'a', target: 'b' });
  return { pass: list.length === 1, actual: list };
});

check('add-entry-does-not-mutate-input-array', () => {
  const original = [{ id: 'x', source: 'p', target: 'q', mode: 'exact', enabled: true, createdAt: 1 }];
  const { list } = glossaryEntries.addEntry(original, { source: 'a', target: 'b' });
  return { pass: original.length === 1 && list.length === 2, actual: { original, list } };
});

check('update-entry-merges-fields-and-preserves-id', () => {
  const { list: seeded } = glossaryEntries.addEntry([], { source: 'a', target: 'b' });
  const id = seeded[0].id;
  const { list, entry } = glossaryEntries.updateEntry(seeded, id, { target: 'z', id: 'attempted-hijack' });
  const pass = entry.id === id && entry.target === 'z' && entry.source === 'a' && list[0].id === id;
  return { pass, actual: { entry, list } };
}, 'Updates cannot smuggle a different id in through the updates object — the real id always wins.');

check('update-entry-unknown-id-returns-null-entry-and-original-list', () => {
  const original = [{ id: 'x', source: 'p', target: 'q', mode: 'exact', enabled: true, createdAt: 1 }];
  const { list, entry } = glossaryEntries.updateEntry(original, 'ghost', { target: 'z' });
  return { pass: entry === null && list === original, actual: { entry, list } };
});

check('remove-entry-filters-by-id', () => {
  const original = [
    { id: 'x', source: 'p', target: 'q', mode: 'exact', enabled: true, createdAt: 1 },
    { id: 'y', source: 'r', target: 's', mode: 'exact', enabled: true, createdAt: 2 }
  ];
  const result = glossaryEntries.removeEntry(original, 'x');
  return { pass: result.length === 1 && result[0].id === 'y', actual: result };
});

check('remove-entry-handles-null-list', () => {
  const result = glossaryEntries.removeEntry(null, 'x');
  return { pass: Array.isArray(result) && result.length === 0, actual: result };
});

check('import-entries-only-accepts-items-with-source-and-target', () => {
  const data = [{ source: 'a', target: 'b' }, { source: 'no-target' }, { target: 'no-source' }, { source: 'c', target: 'd', mode: 'regex' }];
  const { list, imported } = glossaryEntries.importEntries([], data);
  const pass = imported === 2 && list.length === 2 && list[1].mode === 'regex';
  return { pass, actual: { list, imported } };
});

check('import-entries-appends-to-existing-list', () => {
  const existing = [{ id: 'x', source: 'p', target: 'q', mode: 'exact', enabled: true, createdAt: 1 }];
  const { list, imported } = glossaryEntries.importEntries(existing, [{ source: 'a', target: 'b' }]);
  return { pass: list.length === 2 && imported === 1 && list[0].id === 'x', actual: list };
});

check('import-entries-rejects-non-array-data', () => {
  let threw = false;
  try { glossaryEntries.importEntries([], { not: 'an array' }); } catch (e) { threw = true; }
  return { pass: threw };
});

// ─── Real bug: importing a History export into the Glossary picker used
// to silently succeed with imported:0 (different shape: original/target
// vs source/target) — no error, nothing visibly happened. Now it throws
// a typed error the renderer can show a specific message for.
check('looks-like-history-file-detects-a-real-history-export-shape', () => {
  const data = [{ id: 'a1', original: 'こんにちは', translated: 'Hola', engine: 'deepl', cached: false, timestamp: 123 }];
  return { pass: glossaryEntries.looksLikeHistoryFile(data) === true };
});

check('looks-like-history-file-rejects-a-real-glossary-shape', () => {
  const data = [{ source: 'a', target: 'b', mode: 'exact' }];
  return { pass: glossaryEntries.looksLikeHistoryFile(data) === false };
});

check('looks-like-history-file-rejects-empty-array', () => {
  return { pass: glossaryEntries.looksLikeHistoryFile([]) === false };
});

check('import-entries-throws-wrong-category-code-for-a-history-export', () => {
  const data = [{ id: 'a1', original: 'x', translated: 'y', engine: 'deepl', cached: false, timestamp: 1 }];
  let code = null;
  try { glossaryEntries.importEntries([], data); } catch (e) { code = e.code; }
  return { pass: code === 'WRONG_CATEGORY_HISTORY', actual: code };
});

check('import-entries-throws-no-valid-entries-code-for-other-malformed-arrays', () => {
  const data = [{ foo: 'bar' }, { baz: 'qux' }];
  let code = null;
  try { glossaryEntries.importEntries([], data); } catch (e) { code = e.code; }
  return { pass: code === 'NO_VALID_ENTRIES', actual: code };
});

check('import-entries-empty-array-still-imports-zero-without-throwing', () => {
  const { list, imported } = glossaryEntries.importEntries([], []);
  return { pass: imported === 0 && list.length === 0 };
});

// ─── The two-scope reuse claim, verified directly ──────────────────────
check('same-primitives-work-identically-for-a-global-store-list-and-a-plain-profile-array', () => {
  // Simulates exactly how ipc-handlers.js uses these: global layer
  // (array read from/written back to a store) and profile layer (array
  // read from/written back to profile.glossary via ProfileStore#update)
  // go through the IDENTICAL addEntry/removeEntry calls.
  let globalList = [];
  let profileList = [];

  ({ list: globalList } = glossaryEntries.addEntry(globalList, { source: 'style-term', target: 'X' }));
  ({ list: profileList } = glossaryEntries.addEntry(profileList, { source: 'Chocola', target: 'Chocola' }));

  const pass = globalList.length === 1 && profileList.length === 1
    && globalList[0].source === 'style-term' && profileList[0].source === 'Chocola';
  return { pass, actual: { globalList, profileList } };
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

  console.log(`${C.bold}glossary-entries.js bench${C.reset} — ${results.length} case(s)\n`);
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
