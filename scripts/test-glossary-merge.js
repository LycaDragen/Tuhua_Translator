/**
 * glossary-merge.js bench — pure decision table, no Electron, no store.
 * See src/services/translation/glossary-merge.js for the full rationale.
 *
 * The end-to-end cases call GlossaryService.prototype._applyEntry directly
 * (via .call on the prototype, never `new GlossaryService()`) — that
 * method and its _escapeRegex helper don't touch `this.store` at all, so
 * this exercises the REAL replacement algorithm with zero disk I/O and no
 * dependency on Step 2's store-injection refactor (which hasn't landed
 * yet at Step 1 — profile-schema.js and this file are the two modules
 * nobody imports until then).
 *
 *   node scripts/test-glossary-merge.js
 *   node scripts/test-glossary-merge.js --quiet
 */
const path = require('path');
const { conflictKey, mergeGlossaryLayers } = require(path.join('..', 'src', 'services', 'translation', 'glossary-merge.js'));
const GlossaryService = require(path.join('..', 'src', 'services', 'translation', 'glossary.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();
const proto = GlossaryService.prototype;

function applyAll(text, entries) {
  let result = text;
  for (const entry of entries) {
    result = proto._applyEntry.call(proto, result, entry);
  }
  return result;
}

const entry = (source, target, mode = 'exact', enabled = true) =>
  ({ id: `${source}-${mode}`, source, target, mode, enabled, createdAt: 1 });


// ─── conflictKey ────────────────────────────────────────────────────────
check('conflict-key-differs-by-mode', () => {
  const a = conflictKey(entry('foo', 'x', 'exact'));
  const b = conflictKey(entry('foo', 'y', 'regex'));
  return { pass: a !== b, actual: { a, b } };
}, 'A regex rule and an exact rule with the same source string are different rules and must not shadow each other.');

// ─── mergeGlossaryLayers: conflict resolution ──────────────────────────
check('profile-overrides-global-on-mode-and-source', () => {
  const global = [entry('Chocola', 'Chocola (global)')];
  const profile = [entry('Chocola', 'Chocola (profile)')];
  const merged = mergeGlossaryLayers(global, profile);
  const pass = merged.length === 1 && merged[0].target === 'Chocola (profile)';
  return { pass, actual: merged };
});

check('same-source-two-modes-both-survive', () => {
  const global = [entry('foo', 'exact-global', 'exact')];
  const profile = [entry('foo', 'regex-profile', 'regex')];
  const merged = mergeGlossaryLayers(global, profile);
  const pass = merged.length === 2
    && merged.some((e) => e.mode === 'exact' && e.target === 'exact-global')
    && merged.some((e) => e.mode === 'regex' && e.target === 'regex-profile');
  return { pass, actual: merged };
}, 'Same source string, different mode: keying on source alone would have dropped one of these.');

check('non-conflicting-entries-from-both-layers-survive', () => {
  const global = [entry('style-term', 'global-value')];
  const profile = [entry('Chocola', 'profile-value')];
  const merged = mergeGlossaryLayers(global, profile);
  return { pass: merged.length === 2 };
});

// ─── enabled filtering ──────────────────────────────────────────────────
check('disabled-global-entry-excluded', () => {
  const global = [entry('x', 'y', 'exact', false)];
  const merged = mergeGlossaryLayers(global, []);
  return { pass: merged.length === 0, actual: merged };
});

check('disabled-profile-entry-excluded', () => {
  const profile = [entry('x', 'y', 'exact', false)];
  const merged = mergeGlossaryLayers([], profile);
  return { pass: merged.length === 0, actual: merged };
});

check('disabled-entry-does-not-shadow-an-enabled-one', () => {
  // A disabled profile entry must not suppress the global entry it would
  // otherwise have shadowed — the shadow set is built from ENABLED
  // profile entries only.
  const global = [entry('Chocola', 'Chocola (global)')];
  const profile = [entry('Chocola', 'Chocola (profile)', 'exact', false)];
  const merged = mergeGlossaryLayers(global, profile);
  const pass = merged.length === 1 && merged[0].target === 'Chocola (global)';
  return { pass, actual: merged };
});

// ─── ordering: functional, not cosmetic ────────────────────────────────
check('output-order-is-profile-first-then-global', () => {
  const global = [entry('b', 'B')];
  const profile = [entry('a', 'A')];
  const merged = mergeGlossaryLayers(global, profile);
  return { pass: merged[0].source === 'a' && merged[1].source === 'b', actual: merged };
});

check('reversing-layer-order-changes-the-applied-result', () => {
  // The exact scenario the ordering rule exists for: a profile entry
  // (character name) must run before a global style/prose entry, because
  // _applyEntry runs sequentially and an earlier replacement can consume
  // text a later one would otherwise have matched.
  const global = [entry('Choco cat', 'chat Choco', 'exact')];
  const profile = [entry('Chocola', 'Choco cat', 'exact')];

  const correctOrder = mergeGlossaryLayers(global, profile); // profile first
  const reversedOrder = [...global, ...profile]; // deliberately wrong order, for contrast

  const correctResult = applyAll('Chocola is here.', correctOrder);
  const reversedResult = applyAll('Chocola is here.', reversedOrder);

  const pass = correctResult !== reversedResult
    && correctResult === 'chat Choco is here.'
    && reversedResult === 'Choco cat is here.';
  return { pass, actual: { correctResult, reversedResult } };
}, 'Pinned exactly as the plan requires: inverting the layer order changes the output string.');

// ─── end-to-end through the real _applyEntry (no store, no disk I/O) ───
check('end-to-end-merge-and-apply-profile-wins', () => {
  const global = [entry('Chocola', 'a random cat', 'exact')];
  const profile = [entry('Chocola', 'Chocola', 'exact')]; // keep the name as-is
  const merged = mergeGlossaryLayers(global, profile);
  const result = applyAll('Chocola waved.', merged);
  return { pass: result === 'Chocola waved.', actual: result };
});

check('end-to-end-case-insensitive-and-regex-modes-both-apply', () => {
  const global = [entry('HELLO', 'Hola', 'case-insensitive')];
  const profile = [entry('\\bcat\\b', 'gato', 'regex')];
  const merged = mergeGlossaryLayers(global, profile);
  const result = applyAll('hello, the cat is here', merged);
  return { pass: result === 'Hola, the gato is here', actual: result };
});

run("glossary-merge.js bench", CHECKS);
