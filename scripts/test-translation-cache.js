/**
 * cache.js bench — LLM engine overhaul, Fase 7c. Pure Node (electron-store
 * writes to disk the same as it does in production — same trade-off
 * test-context-memory.js already accepts; `.clear()` at the top of each
 * check keeps runs independent).
 *
 * The single thing this pins: before this Fase, changing the LLM prompt,
 * model, or temperature did not change the cache key at all — a user
 * tweaking their prompt to test an improvement would see the exact same
 * cached translation for up to 24h. `variant` (a 5th key component) fixes
 * that for LLM engines specifically, while leaving every other engine's
 * key exactly as it always was.
 *
 *   node scripts/test-translation-cache.js
 *   node scripts/test-translation-cache.js --quiet
 */
const path = require('path');
const TranslationCache = require(path.join('..', 'src', 'services', 'translation', 'cache.js'));

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

function freshCache() {
  const cache = new TranslationCache({ maxSize: 100 });
  cache.clear();
  return cache;
}

check('a-different-variant-is-a-cache-miss-even-for-the-same-line', () => {
  const cache = freshCache();
  cache.set('こんにちは', 'ja', 'es', 'openai', 'Hola (variant A)', 'variantA');
  const hitSameVariant = cache.get('こんにちは', 'ja', 'es', 'openai', 'variantA');
  const missDifferentVariant = cache.get('こんにちは', 'ja', 'es', 'openai', 'variantB');
  return {
    pass: hitSameVariant === 'Hola (variant A)' && missDifferentVariant === null,
    actual: { hitSameVariant, missDifferentVariant }
  };
}, 'This is the actual bug being fixed: before Fase 7c, editing the prompt (which changes the variant) did not change the cache key at all, so a user testing a prompt tweak saw the same stale cached line for up to 24h.');

check('default-empty-variant-still-works-for-non-llm-engines', () => {
  const cache = freshCache();
  cache.set('こんにちは', 'ja', 'es', 'deepl', 'Hola');
  const hit = cache.get('こんにちは', 'ja', 'es', 'deepl');
  return { pass: hit === 'Hola', actual: hit };
}, "Non-LLM engines pass '' (the default) — their key shape is unaffected by this Fase.");

check('same-variant-across-two-different-lines-does-not-collide', () => {
  const cache = freshCache();
  cache.set('こんにちは', 'ja', 'es', 'openai', 'Hola', 'v1');
  cache.set('さようなら', 'ja', 'es', 'openai', 'Adiós', 'v1');
  return {
    pass: cache.get('こんにちは', 'ja', 'es', 'openai', 'v1') === 'Hola' && cache.get('さようなら', 'ja', 'es', 'openai', 'v1') === 'Adiós',
    actual: { a: cache.get('こんにちは', 'ja', 'es', 'openai', 'v1'), b: cache.get('さようなら', 'ja', 'es', 'openai', 'v1') }
  };
});

check('changing-only-the-variant-does-not-corrupt-the-old-entry', () => {
  const cache = freshCache();
  cache.set('こんにちは', 'ja', 'es', 'openai', 'Hola (old prompt)', 'v1');
  cache.set('こんにちは', 'ja', 'es', 'openai', 'Hola (new prompt)', 'v2');
  return {
    pass: cache.get('こんにちは', 'ja', 'es', 'openai', 'v1') === 'Hola (old prompt)' && cache.get('こんにちは', 'ja', 'es', 'openai', 'v2') === 'Hola (new prompt)',
    actual: { v1: cache.get('こんにちは', 'ja', 'es', 'openai', 'v1'), v2: cache.get('こんにちは', 'ja', 'es', 'openai', 'v2') }
  };
}, 'Both live side by side under different keys — reverting a prompt change should still hit the old cached entry, not just invalidate it one-way.');

check('ttl-still-expires-entries-regardless-of-variant', () => {
  const cache = new TranslationCache({ maxSize: 100, ttl: 1 }); // 1ms TTL
  cache.clear();
  cache.set('test', 'ja', 'es', 'openai', 'Test', 'v1');
  return new Promise((resolve) => {
    setTimeout(() => {
      const hit = cache.get('test', 'ja', 'es', 'openai', 'v1');
      resolve({ pass: hit === null, actual: hit });
    }, 20);
  });
});

check('lru-eviction-still-works-with-variant-in-the-key', () => {
  const cache = new TranslationCache({ maxSize: 2 });
  cache.clear();
  cache.set('a', 'ja', 'es', 'openai', 'A', 'v1');
  cache.set('b', 'ja', 'es', 'openai', 'B', 'v1');
  cache.set('c', 'ja', 'es', 'openai', 'C', 'v1'); // evicts 'a'
  return {
    pass: cache.get('a', 'ja', 'es', 'openai', 'v1') === null && cache.get('b', 'ja', 'es', 'openai', 'v1') === 'B' && cache.get('c', 'ja', 'es', 'openai', 'v1') === 'C',
    actual: { a: cache.get('a', 'ja', 'es', 'openai', 'v1'), b: cache.get('b', 'ja', 'es', 'openai', 'v1'), c: cache.get('c', 'ja', 'es', 'openai', 'v1') }
  };
});

async function run() {
  const args = parseArgs(process.argv.slice(2));
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

  console.log(`${C.bold}cache.js bench${C.reset} — ${results.length} case(s)\n`);
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
