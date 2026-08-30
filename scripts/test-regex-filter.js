/**
 * regex-filter.js apply() bench — v1.0.6.
 *
 * The defect (found reading a real 2026-08-30 log, where SIX consecutive
 * lines all reported "7 applied" — including lines whose text came out
 * byte-for-byte identical): `appliedCount` incremented once per loop
 * iteration, so it was just `getEnabled().length` under another name. The
 * one number in the log meant to answer "did a filter eat my text?" could
 * never answer it. It now counts filters that ACTUALLY CHANGED the text,
 * with `enabledCount` alongside so the log shows both halves.
 *
 * Runs the REAL service with `_entries` replaced in memory — no _persist()
 * call, so the user's own regex-filters store is never written to.
 *
 *   node scripts/test-regex-filter.js
 *   node scripts/test-regex-filter.js --quiet
 */
const path = require('path');
const RegexFilterService = require(path.join('..', 'src', 'services', 'regex-filter.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const filter = (over) => ({
  id: 'f', name: 'f', type: 'regex', pattern: 'x', replacement: '', isRegex: true,
  isCaseSensitive: false, enabled: true, isBuiltIn: false, order: 10, description: '', ...over
});

/** Real service, deterministic filter set, nothing persisted. */
function svcWith(entries) {
  const svc = new RegexFilterService();
  svc._entries = entries;
  return svc;
}

check('the-reported-defect-filters-that-changed-nothing-are-not-counted', () => {
  // Every filter here is valid and runs; none of them matches this text.
  const svc = svcWith([
    filter({ id: 'a', pattern: '【[^】]*】', replacement: '' }),
    filter({ id: 'b', pattern: '\\[[^\\]]*\\]', replacement: '' }),
    filter({ id: 'c', pattern: 'ノ', replacement: '' })
  ]);
  const r = svc.apply('Valessa: Yeah, something else is going on here.', 'en');
  return { pass: r.appliedCount === 0 && r.enabledCount === 3, actual: r };
}, 'Log 2026-08-30: six lines in a row said "7 applied, 0 skipped" with input and output identical on the same line.');

check('only-the-filters-that-really-fired-are-counted', () => {
  const svc = svcWith([
    filter({ id: 'a', pattern: '<[^>]*>', replacement: '' }),   // fires
    filter({ id: 'b', pattern: 'ZZZZ', replacement: '' }),      // no match
    filter({ id: 'c', pattern: '\\s+', replacement: ' ' })      // fires
  ]);
  const r = svc.apply('<Ulric>  Join   the club.', 'en');
  return { pass: r.appliedCount === 2 && r.enabledCount === 3, actual: r };
});

check('the-text-itself-comes-out-exactly-as-before', () => {
  const svc = svcWith([
    filter({ id: 'a', pattern: '<[^>]*>', replacement: '' }),
    filter({ id: 'c', pattern: '\\s+', replacement: ' ' })
  ]);
  const r = svc.apply('<Ulric>  Join   the club.', 'en');
  return { pass: r.text === ' Join the club.', actual: r.text, expected: ' Join the club.' };
}, 'The counting change must be observable ONLY in the count — the filtering pipeline is untouched.');

check('a-filter-that-replaces-a-match-with-itself-counts-as-no-change', () => {
  const svc = svcWith([filter({ id: 'a', pattern: 'club', replacement: 'club' })]);
  const r = svc.apply('Join the club.', 'en');
  return { pass: r.appliedCount === 0, actual: r };
}, 'Matching is not the question the log needs answered; changing the text is.');

check('an-invalid-pattern-is-still-skipped-not-counted', () => {
  const svc = svcWith([
    filter({ id: 'bad', pattern: '([unclosed', replacement: '' }),
    filter({ id: 'ok', pattern: 'club', replacement: 'clan' })
  ]);
  const r = svc.apply('Join the club.', 'en');
  return { pass: r.appliedCount === 1 && r.skipped.length === 1 && r.skipped[0] === 'bad' && r.text === 'Join the clan.', actual: r };
});

check('disabled-filters-are-in-neither-count', () => {
  const svc = svcWith([
    filter({ id: 'on', pattern: 'club', replacement: 'clan' }),
    filter({ id: 'off', pattern: 'Join', replacement: 'X', enabled: false })
  ]);
  const r = svc.apply('Join the club.', 'en');
  return { pass: r.appliedCount === 1 && r.enabledCount === 1 && r.text === 'Join the clan.', actual: r };
});

check('normalize-counts-only-when-normalization-changed-something', () => {
  const svc = svcWith([filter({ id: 'n', type: 'normalize' })]);
  const wide = svc.apply('Ｈｅｌｌｏ', 'ja');   // Ｈｅｌｌｏ → Hello
  const plain = svc.apply('Hello', 'en');
  return { pass: wide.appliedCount === 1 && plain.appliedCount === 0, actual: { wide, plain } };
}, 'The builtin NFKC filter runs on every single line — before this it inflated the count on every line by definition.');

check('language-aware-newline-replacement-is-unchanged', () => {
  const svc = svcWith([filter({ id: 'builtin-remove-newlines', pattern: '\\n', replacement: ' ' })]);
  const ja = svc.apply('あい\nうえ', 'ja');
  const en = svc.apply('Join the club.\nIt is fine.', 'en');
  return { pass: ja.text === 'あいうえ' && en.text === 'Join the club. It is fine.', actual: { ja: ja.text, en: en.text } };
}, "LunaTranslator-style rule (ja/zh/ko join with '', others with ' ') — pinned because apply() is where it's decided.");

check('empty-input-returns-the-zeroed-shape', () => {
  const svc = svcWith([filter({ id: 'a', pattern: 'x', replacement: '' })]);
  const r = svc.apply('', 'en');
  return { pass: r.text === '' && r.appliedCount === 0 && r.enabledCount === 0 && Array.isArray(r.skipped), actual: r };
}, 'ipc-handlers.js reads enabledCount unconditionally for its log line — it must exist on every return path.');

run('regex-filter.js apply() bench', CHECKS);
