/**
 * deepl-glossary-sync.js bench — LLM engine overhaul, Fase 6. Pure Node,
 * no real network (a fake httpClient is injected — same pattern as
 * test-llm-base.js).
 *
 * The create/delete/get request shapes themselves (field names, TSV
 * format, glossary_id being what actually gets applied) were verified
 * against DeepL's real API (free tier included) before this bench was
 * written — see the module's own header comment. This bench pins the
 * ORCHESTRATION logic: when a sync is/isn't needed, that the TSV is built
 * correctly, and that the right sequence of calls happens for
 * create/replace/delete-only.
 *
 *   node scripts/test-deepl-glossary-sync.js
 *   node scripts/test-deepl-glossary-sync.js --quiet
 */
const path = require('path');
const {
  hashEntries, buildTsvEntries, needsSync, syncProfileGlossary
} = require(path.join('..', 'src', 'services', 'translation', 'deepl-glossary-sync.js'));

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
function asyncCheck(id, fn, note) {
  CHECKS.push({ id, fn, note, async: true });
}

function fakeHttpClient() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    post: async (url, body, config) => {
      calls.push({ method: 'POST', url, body, config });
      return { data: { glossary_id: `fake-${nextId++}`, ready: true } };
    },
    delete: async (url, config) => {
      calls.push({ method: 'DELETE', url, config });
      return { status: 204 };
    }
  };
}

// ─── hashEntries ─────────────────────────────────────────────────────────
check('hashEntries-is-order-independent', () => {
  const a = [{ source: '灰音', target: 'Haine', mode: 'exact' }, { source: 'ロゼ', target: 'Rose', mode: 'exact' }];
  const b = [{ source: 'ロゼ', target: 'Rose', mode: 'exact' }, { source: '灰音', target: 'Haine', mode: 'exact' }];
  return { pass: hashEntries(a) === hashEntries(b), actual: { a: hashEntries(a), b: hashEntries(b) } };
});

check('hashEntries-changes-when-a-target-changes', () => {
  const a = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const b = [{ source: '灰音', target: 'Hayne', mode: 'exact' }];
  return { pass: hashEntries(a) !== hashEntries(b), actual: { a: hashEntries(a), b: hashEntries(b) } };
});

check('hashEntries-ignores-regex-entries', () => {
  const a = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const b = [{ source: '灰音', target: 'Haine', mode: 'exact' }, { source: '.+', target: '.+', mode: 'regex' }];
  return { pass: hashEntries(a) === hashEntries(b), actual: { a: hashEntries(a), b: hashEntries(b) } };
});

check('hashEntries-ignores-disabled-entries', () => {
  const a = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const b = [{ source: '灰音', target: 'Haine', mode: 'exact' }, { source: 'ロゼ', target: 'Rose', mode: 'exact', enabled: false }];
  return { pass: hashEntries(a) === hashEntries(b), actual: { a: hashEntries(a), b: hashEntries(b) } };
});

// ─── buildTsvEntries ─────────────────────────────────────────────────────
check('buildTsvEntries-formats-source-tab-target-per-line', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }, { source: 'ロゼ', target: 'Rose', mode: 'exact' }];
  const tsv = buildTsvEntries(entries);
  return { pass: tsv === '灰音\tHaine\nロゼ\tRose', actual: tsv };
});

check('buildTsvEntries-excludes-regex-entries', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }, { source: '.+', target: '.+', mode: 'regex' }];
  const tsv = buildTsvEntries(entries);
  return { pass: tsv === '灰音\tHaine', actual: tsv };
});

check('buildTsvEntries-strips-tabs-and-newlines-to-not-corrupt-the-tsv', () => {
  const entries = [{ source: '灰\ta', target: 'X\nY', mode: 'exact' }];
  const tsv = buildTsvEntries(entries);
  const pass = !tsv.includes('\t\t') && tsv.split('\t').length === 2 && !tsv.slice(tsv.indexOf('\t') + 1).includes('\n');
  return { pass, actual: tsv };
});

check('buildTsvEntries-drops-duplicate-source-terms', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }, { source: '灰音', target: 'Haine2', mode: 'exact' }];
  const tsv = buildTsvEntries(entries);
  return { pass: tsv.split('\n').length === 1, actual: tsv };
}, 'DeepL rejects a glossary with a duplicate source term — first one wins, consistent with how the rest of Tuhua treats profile-then-global ordering.');

check('buildTsvEntries-is-empty-string-for-empty-input', () => {
  return { pass: buildTsvEntries([]) === '', actual: buildTsvEntries([]) };
});

// ─── needsSync ───────────────────────────────────────────────────────────
check('needsSync-true-when-never-synced', () => {
  return { pass: needsSync(null, [{ source: 'a', target: 'b', mode: 'exact' }], 'ja', 'es') === true };
});

check('needsSync-false-when-hash-and-lang-pair-unchanged', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const sync = { glossaryId: 'g1', hash: hashEntries(entries), sourceLang: 'ja', targetLang: 'es' };
  return { pass: needsSync(sync, entries, 'ja', 'es') === false };
});

check('needsSync-true-when-content-changed', () => {
  const before = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const after = [{ source: '灰音', target: 'Hayne', mode: 'exact' }];
  const sync = { glossaryId: 'g1', hash: hashEntries(before), sourceLang: 'ja', targetLang: 'es' };
  return { pass: needsSync(sync, after, 'ja', 'es') === true };
});

check('needsSync-true-when-language-pair-changed', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const sync = { glossaryId: 'g1', hash: hashEntries(entries), sourceLang: 'ja', targetLang: 'es' };
  return { pass: needsSync(sync, entries, 'ja', 'en') === true };
}, "DeepL locks a glossary to one exact source/target pair — a profile's target language changing must trigger a fresh glossary, not silently keep applying the wrong-language one.");

// ─── syncProfileGlossary orchestration ──────────────────────────────────
asyncCheck('syncProfileGlossary-creates-when-never-synced', async () => {
  const http = fakeHttpClient();
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const result = await syncProfileGlossary({
    deeplGlossarySync: null, entries, sourceLang: 'ja', targetLang: 'es',
    profileName: 'Test VN', baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'fake:fx', httpClient: http
  });
  return {
    pass: result.changed === true && !!result.deeplGlossarySync?.glossaryId &&
      http.calls.length === 1 && http.calls[0].method === 'POST',
    actual: { result, calls: http.calls }
  };
});

asyncCheck('syncProfileGlossary-is-a-no-op-when-nothing-changed', async () => {
  const http = fakeHttpClient();
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const existingSync = { glossaryId: 'g-existing', hash: hashEntries(entries), sourceLang: 'ja', targetLang: 'es' };
  const result = await syncProfileGlossary({
    deeplGlossarySync: existingSync, entries, sourceLang: 'ja', targetLang: 'es',
    profileName: 'Test VN', baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'fake:fx', httpClient: http
  });
  return { pass: result.changed === false && http.calls.length === 0, actual: { result, calls: http.calls } };
}, 'The whole point of hashing: no network call at all on the common "nothing changed" path.');

asyncCheck('syncProfileGlossary-deletes-old-then-creates-new-when-content-changed', async () => {
  const http = fakeHttpClient();
  const before = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const after = [{ source: '灰音', target: 'Hayne', mode: 'exact' }];
  const existingSync = { glossaryId: 'g-old', hash: hashEntries(before), sourceLang: 'ja', targetLang: 'es' };
  const result = await syncProfileGlossary({
    deeplGlossarySync: existingSync, entries: after, sourceLang: 'ja', targetLang: 'es',
    profileName: 'Test VN', baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'fake:fx', httpClient: http
  });
  return {
    pass: result.changed === true && result.deeplGlossarySync.glossaryId !== 'g-old' &&
      http.calls.length === 2 && http.calls[0].method === 'DELETE' && http.calls[0].url.endsWith('/g-old') && http.calls[1].method === 'POST',
    actual: { result, calls: http.calls.map((c) => ({ method: c.method, url: c.url })) }
  };
});

asyncCheck('syncProfileGlossary-deletes-and-returns-null-sync-when-glossary-becomes-empty', async () => {
  const http = fakeHttpClient();
  const existingSync = { glossaryId: 'g-old', hash: hashEntries([{ source: 'a', target: 'b', mode: 'exact' }]), sourceLang: 'ja', targetLang: 'es' };
  const result = await syncProfileGlossary({
    deeplGlossarySync: existingSync, entries: [], sourceLang: 'ja', targetLang: 'es',
    profileName: 'Test VN', baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'fake:fx', httpClient: http
  });
  return {
    pass: result.changed === true && result.deeplGlossarySync === null &&
      http.calls.length === 1 && http.calls[0].method === 'DELETE',
    actual: { result, calls: http.calls.map((c) => c.method) }
  };
}, "An emptied glossary (last entry removed) must not leave an orphaned remote resource, and must not try to POST an empty entries body (DeepL rejects that).");

asyncCheck('syncProfileGlossary-delete-swallows-a-404-from-an-already-gone-glossary', async () => {
  const http = {
    calls: [],
    post: async () => ({ data: { glossary_id: 'g-new' } }),
    delete: async () => { const e = new Error('Not Found'); e.response = { status: 404 }; throw e; }
  };
  const entries = [{ source: '灰音', target: 'Hayne', mode: 'exact' }];
  const existingSync = { glossaryId: 'g-gone', hash: 'stale-hash', sourceLang: 'ja', targetLang: 'es' };
  let threw = false;
  let result;
  try {
    result = await syncProfileGlossary({
      deeplGlossarySync: existingSync, entries, sourceLang: 'ja', targetLang: 'es',
      profileName: 'Test VN', baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'fake:fx', httpClient: http
    });
  } catch (e) { threw = true; }
  return { pass: threw === false && result?.deeplGlossarySync?.glossaryId === 'g-new', actual: { threw, result } };
}, 'A glossary deleted by hand on DeepL\'s own dashboard (or by a crashed previous run) must not block re-syncing — a 404 on delete is treated as "already gone", not an error.');

function run() {
  const args = parseArgs(process.argv.slice(2));
  return (async () => {
    const results = [];
    for (const c of CHECKS) {
      let outcome;
      try {
        outcome = c.async ? await c.fn() : c.fn();
      } catch (e) {
        outcome = { pass: false, error: e.message };
      }
      results.push({ id: c.id, note: c.note, ...outcome });
    }

    console.log(`${C.bold}deepl-glossary-sync.js bench${C.reset} — ${results.length} case(s)\n`);
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
  })();
}

run();
