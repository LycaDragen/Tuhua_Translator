/**
 * translation-memory.js bench — LLM engine overhaul, Fase 7d. Pure Node
 * (electron-store writes to disk the same as production — same trade-off
 * cache.js's own bench accepts; `.clear()` at the top of each check keeps
 * runs independent).
 *
 * Three things pinned here that were real gaps before this Fase:
 *   1. TM was a single global namespace — one VN's dialogue could answer a
 *      lookup for a completely different VN sharing a short generic line.
 *   2. TM was engine-agnostic in a way that let an LLM setup silently
 *      inherit a cruder literal-MT translation.
 *   3. TM never expired anything, ever.
 *
 *   node scripts/test-translation-memory.js
 *   node scripts/test-translation-memory.js --quiet
 */
const path = require('path');
const TranslationMemory = require(path.join('..', 'src', 'services', 'translation', 'translation-memory.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

function freshTM(options = {}) {
  const tm = new TranslationMemory({ fuzzyEnabled: false, ...options });
  tm.clear();
  return tm;
}

// ─── profileId namespacing ──────────────────────────────────────────────────
check('a-different-profile-is-a-cache-miss-for-the-exact-same-line', () => {
  const tm = freshTM();
  tm.set('はい。', 'ja', 'es', 'Sí (VN A).', 'deepl', 'profileA');
  const hitSameProfile = tm.get('はい。', 'ja', 'es', 'profileA');
  const missOtherProfile = tm.get('はい。', 'ja', 'es', 'profileB');
  return {
    pass: hitSameProfile === 'Sí (VN A).' && missOtherProfile === null,
    actual: { hitSameProfile, missOtherProfile }
  };
}, 'The actual bug being fixed: a short generic line ("はい。") from one VN used to silently answer a lookup for a completely different VN.');

check('default-empty-profileId-preserves-old-global-namespace-behavior', () => {
  const tm = freshTM();
  tm.set('こんにちは', 'ja', 'es', 'Hola');
  const hit = tm.get('こんにちは', 'ja', 'es');
  return { pass: hit === 'Hola', actual: hit };
}, 'A pipeline built without profileStore (existing benches) must keep working exactly as before.');

// ─── engineClass compatibility ───────────────────────────────────────────────
check('an-llm-lookup-does-not-reuse-an-mt-entry', () => {
  const tm = freshTM();
  tm.set('こんにちは', 'ja', 'es', 'Hola (literal MT)', 'deepl', 'p1', 'mt');
  const hit = tm.get('こんにちは', 'ja', 'es', 'p1', 'llm');
  return { pass: hit === null, actual: hit };
}, 'A literal-MT translation is a real quality downgrade an LLM setup should not silently inherit.');

check('an-mt-lookup-DOES-reuse-an-llm-entry', () => {
  const tm = freshTM();
  tm.set('こんにちは', 'ja', 'es', 'Hola (LLM, natural)', 'openai', 'p1', 'llm');
  const hit = tm.get('こんにちは', 'ja', 'es', 'p1', 'mt');
  return { pass: hit === 'Hola (LLM, natural)', actual: hit };
}, "The asymmetric half — reusing an LLM's typically more natural translation is a strict improvement for a plain MT engine, not a downgrade.");

check('llm-reuses-llm-and-mt-reuses-mt', () => {
  const tm = freshTM();
  tm.set('a', 'ja', 'es', 'LLM-A', 'openai', 'p1', 'llm');
  tm.set('b', 'ja', 'es', 'MT-B', 'deepl', 'p1', 'mt');
  return {
    pass: tm.get('a', 'ja', 'es', 'p1', 'llm') === 'LLM-A' && tm.get('b', 'ja', 'es', 'p1', 'mt') === 'MT-B',
    actual: { a: tm.get('a', 'ja', 'es', 'p1', 'llm'), b: tm.get('b', 'ja', 'es', 'p1', 'mt') }
  };
});

check('missing-engineClass-on-either-side-never-blocks-a-match', () => {
  const tm = freshTM();
  tm.set('legacy line', 'ja', 'es', 'Legacy translation', 'deepl', 'p1'); // no engineClass — pre-Fase-7 shape
  const hit = tm.get('legacy line', 'ja', 'es', 'p1', 'llm');
  return { pass: hit === 'Legacy translation', actual: hit };
}, 'A pre-Fase-7 entry (or a caller that omits the class) must not become permanently unreachable — unknown is treated as compatible, not incompatible.');

// ─── TTL ─────────────────────────────────────────────────────────────────────
check('ttl-expires-entries-that-never-expired-before-this-fase', () => {
  const tm = freshTM({ ttl: 1 }); // 1ms
  tm.set('test', 'ja', 'es', 'Test', 'deepl', 'p1');
  return new Promise((resolve) => {
    setTimeout(() => {
      const hit = tm.get('test', 'ja', 'es', 'p1');
      resolve({ pass: hit === null, actual: hit });
    }, 20);
  });
});

check('default-ttl-is-30-days-not-24h-like-the-engine-cache', () => {
  const tm = freshTM();
  return { pass: tm.ttl === 30 * 24 * 60 * 60 * 1000, actual: tm.ttl };
}, 'TM is explicitly meant to persist across sessions/restarts — the same 24h as the engine cache would defeat its purpose.');

// ─── fuzzy matching respects both profileId and engineClass ────────────────
check('fuzzy-match-respects-profileId', () => {
  const tm = freshTM({ fuzzyEnabled: true, fuzzyThreshold: 0.5 });
  tm.set('灰音とロゼは幼馴染で仲がいい', 'ja', 'es', 'VN A translation', 'deepl', 'profileA');
  const resultSameProfile = tm.getWithFuzzy('灰音とロゼは幼馴染で仲が良い', 'ja', 'es', 'profileA');
  const resultOtherProfile = tm.getWithFuzzy('灰音とロゼは幼馴染で仲が良い', 'ja', 'es', 'profileB');
  return {
    pass: !!resultSameProfile && resultOtherProfile === null,
    actual: { resultSameProfile, resultOtherProfile }
  };
});

check('fuzzy-match-respects-engineClass-llm-does-not-reuse-mt', () => {
  const tm = freshTM({ fuzzyEnabled: true, fuzzyThreshold: 0.5 });
  tm.set('灰音とロゼは幼馴染で仲がいい', 'ja', 'es', 'MT version', 'deepl', 'p1', 'mt');
  const result = tm.getWithFuzzy('灰音とロゼは幼馴染で仲が良い', 'ja', 'es', 'p1', 'llm');
  return { pass: result === null, actual: result };
});

// ─── variant compatibility (Fase 9 testing follow-up — real bug found by
// Lyca: switching prompt presets on an already-seen line kept returning
// the OLD preset's translation, because TM never knew the prompt changed) ─
check('a-different-prompt-variant-is-a-tm-miss-for-the-same-line', () => {
  const tm = freshTM();
  tm.set('こんにちは', 'ja', 'es', 'Hola (Balanceado)', 'openai', 'p1', 'llm', 'hash-balanced');
  const sameVariant = tm.get('こんにちは', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  const differentVariant = tm.get('こんにちは', 'ja', 'es', 'p1', 'llm', 'hash-literal');
  return {
    pass: sameVariant === 'Hola (Balanceado)' && differentVariant === null,
    actual: { sameVariant, differentVariant }
  };
}, 'The bug reproduced exactly: reload a save, switch prompt preset, reload the same line — before this fix, the SECOND lookup silently returned the FIRST preset\'s cached text instead of re-translating.');

// v3.13.6x (Fase 9 testing follow-up, ronda 6): the leniency this check
// used to pin ("missing-variant-on-either-side-never-blocks-a-match") was
// found, by real testing across 3 sessions, to be the ACTUAL reason
// prompt-preset comparisons looked broken during normal play — Lyca had
// 571 real TM entries written before `variant` existed, and every one of
// them answered EVERY preset for the rest of its 30-day TTL. It's replaced
// below with the tightened rule: a blank-variant entry an LLM engine
// itself wrote no longer satisfies a variant-specific query, but the same
// blank-variant leniency stays fully intact for MT engines (DeepL/Google),
// which never carry a real variant by design — orphaning THOSE was never
// the goal. See isVariantCompatible()'s header comment in
// translation-memory.js for the full reasoning.
check('a-legacy-blank-variant-entry-written-by-an-llm-engine-does-not-answer-a-variant-specific-lookup', () => {
  const tm = freshTM();
  tm.set('legacy line', 'ja', 'es', 'Legacy translation', 'openai', 'p1', 'llm'); // explicit engineClass, no variant — pre-Fase-9 shape
  const hit = tm.get('legacy line', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  return { pass: hit === null, actual: hit };
});

check('a-legacy-entry-with-no-engineClass-at-all-falls-back-to-originalEngine-and-an-mt-one-still-answers', () => {
  const tm = freshTM();
  tm.set('oldest shape mt line', 'ja', 'es', 'Legacy MT translation', 'deepl', 'p1'); // no engineClass, no variant — the OLDEST possible entry shape
  const hit = tm.get('oldest shape mt line', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  return { pass: hit === 'Legacy MT translation', actual: hit };
}, "resolveEntryClass() falls back to originalEngine (present on every entry since v3.11.23, unlike engineClass) when engineClass itself is missing — a DeepL-originated entry must stay reachable no matter what an LLM variant-specific query asks for.");

check('a-legacy-entry-with-no-engineClass-written-by-an-llm-engine-is-blocked-via-the-originalEngine-fallback-too', () => {
  const tm = freshTM();
  tm.set('oldest shape llm line', 'ja', 'es', 'Legacy LLM translation', 'openai', 'p1'); // no engineClass, no variant
  const hit = tm.get('oldest shape llm line', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  return { pass: hit === null, actual: hit };
}, "originalEngine='openai' resolves to class 'llm' via LLM_ENGINE_NAMES even with engineClass entirely absent — the same block applies to the oldest-shape entries, not just ones that already had an explicit engineClass.");

check('an-explicit-engineClass-wins-over-the-originalEngine-fallback', () => {
  const tm = freshTM();
  // engineClass explicitly 'llm' (so the pre-existing engineClass gate
  // lets an 'llm' query through) but originalEngine is 'deepl' (an MT
  // name) — if resolveEntryClass() wrongly consulted originalEngine ahead
  // of the explicit engineClass, this blank-variant entry would
  // incorrectly stay lenient for a variant-specific LLM query.
  tm.set('contradictory line', 'ja', 'es', 'Should stay blocked', 'deepl', 'p1', 'llm');
  const hit = tm.get('contradictory line', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  return { pass: hit === null, actual: hit };
}, "resolveEntryClass() must read entry.engineClass first and only consult originalEngine when it's absent — an explicit classification is never silently overridden by the fallback.");

check('rewriting-a-legacy-entry-with-a-real-variant-heals-it', () => {
  const tm = freshTM();
  tm.set('healable line', 'ja', 'es', 'Old translation', 'openai', 'p1', 'llm'); // no variant
  const beforeHeal = tm.get('healable line', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  // Simulates a retranslate: pipeline.js's bypassMemory:true still WRITES
  // the fresh result (see _doTranslate's own comment on why) — this is the
  // set() call that does it.
  tm.set('healable line', 'ja', 'es', 'New translation', 'openai', 'p1', 'llm', 'hash-balanced');
  const afterHealSameVariant = tm.get('healable line', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  const afterHealDifferentVariant = tm.get('healable line', 'ja', 'es', 'p1', 'llm', 'hash-literal');
  return {
    pass: beforeHeal === null && afterHealSameVariant === 'New translation' && afterHealDifferentVariant === null,
    actual: { beforeHeal, afterHealSameVariant, afterHealDifferentVariant }
  };
}, 'One explicit retranslate quietly retires one of the entries that used to answer every preset — set()\'s existing update branch (`variant || entries[key].variant`) stamps a real variant onto what was a blank-variant legacy entry.');

check('fuzzy-lookup-applies-the-same-legacy-llm-rule-as-the-exact-path', () => {
  const tm = freshTM({ fuzzyEnabled: true, fuzzyThreshold: 0.5 });
  tm.set('灰音とロゼは幼馴染で仲がいい', 'ja', 'es', 'Legacy LLM version', 'openai', 'p1', 'llm'); // no variant
  const result = tm.getWithFuzzy('灰音とロゼは幼馴染で仲が良い', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  return { pass: result === null, actual: result };
}, "getFuzzy()'s candidate filtering is separate code from get()'s (_rebuildFuzzyIndex builds its own candidate objects) — this pins that the legacy-LLM-blocking rule applies there too, not just to the exact-match path.");

check('an-mt-engine-with-empty-variant-is-unaffected-by-variant-compatibility', () => {
  const tm = freshTM();
  tm.set('こんにちは', 'ja', 'es', 'Hola (DeepL)', 'deepl', 'p1', 'mt', '');
  const hit = tm.get('こんにちは', 'ja', 'es', 'p1', 'mt', '');
  return { pass: hit === 'Hola (DeepL)', actual: hit };
}, "_cacheVariant() always returns '' for non-glossaryPrompt engines (DeepL, Google, ...) — variant compatibility must be a no-op for the whole MT half of the fallback chain.");

check('fuzzy-match-respects-variant-too', () => {
  const tm = freshTM({ fuzzyEnabled: true, fuzzyThreshold: 0.5 });
  tm.set('灰音とロゼは幼馴染で仲がいい', 'ja', 'es', 'Balanceado version', 'openai', 'p1', 'llm', 'hash-balanced');
  const sameVariant = tm.getWithFuzzy('灰音とロゼは幼馴染で仲が良い', 'ja', 'es', 'p1', 'llm', 'hash-balanced');
  const differentVariant = tm.getWithFuzzy('灰音とロゼは幼馴染で仲が良い', 'ja', 'es', 'p1', 'llm', 'hash-literal');
  return {
    pass: !!sameVariant && differentVariant === null,
    actual: { sameVariant, differentVariant }
  };
});

run("translation-memory.js bench", CHECKS);
