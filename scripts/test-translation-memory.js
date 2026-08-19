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

function run() {
  const args = parseArgs(process.argv.slice(2));
  return (async () => {
    const results = [];
    for (const c of CHECKS) {
      let outcome;
      try {
        outcome = await c.fn();
      } catch (e) {
        outcome = { pass: false, error: e.message };
      }
      results.push({ id: c.id, note: c.note, ...outcome });
    }

    console.log(`${C.bold}translation-memory.js bench${C.reset} — ${results.length} case(s)\n`);
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
