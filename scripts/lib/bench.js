/**
 * Shared boilerplate for scripts/test-*.js benches — v3.13.113 (Ronda 4g).
 *
 * Extracted after finding this exact shape byte-for-byte duplicated (down
 * to whitespace) across 16 bench files (the deferred CHECKS-array style,
 * `run()`/`check()`) and a second exact shape across 4 more (the eager
 * `check()` style, `makeEagerCheckRegistry()`/`report()`) — verified with
 * md5 comparisons of each file's `check()`/`run()` bodies before touching
 * anything, not assumed from the plan's estimate. The other ~12
 * scripts/test-*.js files have genuinely different reporting shapes (e.g.
 * hook-cleaning.js's split tcp:/launcher: summary, stdout-decoding.js's
 * single aggregate count) and are NOT migrated here — forcing them into
 * either shape below would change what they report, not just how the
 * boilerplate is organized.
 *
 * Two supported shapes:
 *
 * 1. Deferred (most common — `check()` registers a case, `run(title,
 *    CHECKS)` executes them all at the end, sync or async `fn` both work
 *    since `await` on a non-Promise just resolves immediately):
 *
 *      const { makeCheckRegistry, run } = require('./lib/bench.js');
 *      const { check, CHECKS } = makeCheckRegistry();
 *      check('some-id', () => ({ pass: true, actual: 1 }));
 *      run('my-thing.js bench', CHECKS);
 *
 * 2. Eager (`check()` runs `fn()` immediately at the call site; used by
 *    files that build the `results` array as a side effect of running
 *    checks inline among other file-level setup code):
 *
 *      const { makeEagerCheckRegistry } = require('./lib/bench.js');
 *      const { check, report } = makeEagerCheckRegistry();
 *      check('some-name', () => ({ pass: true, actual: 1 }));
 *      report();
 */

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

/**
 * Deferred style — each bench file gets its OWN {check, CHECKS} pair (not
 * a shared module-level array), so requiring this file from several
 * benches in the same process (e.g. a future runner that loads them all)
 * can never cross-contaminate one file's cases into another's.
 */
function makeCheckRegistry() {
  const CHECKS = [];
  function check(id, fn, note) {
    CHECKS.push({ id, fn, note });
  }
  return { check, CHECKS };
}

async function run(title, CHECKS) {
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

  console.log(`${C.bold}${title}${C.reset} — ${results.length} case(s)\n`);
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

/** Eager style — see module doc comment above. */
function makeEagerCheckRegistry() {
  const results = [];
  let passCount = 0;
  let failCount = 0;

  function check(name, fn, note) {
    let result;
    try {
      result = fn();
    } catch (e) {
      result = { pass: false, actual: `threw: ${e.message}` };
    }
    results.push({ name, note, ...result });
    if (result.pass) passCount++; else failCount++;
  }

  function report() {
    const args = parseArgs(process.argv.slice(2));
    for (const r of results) {
      const status = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
      console.log(`${status}  ${r.name}`);
      if (!r.pass || !args.quiet) {
        if (r.note) console.log(`  ${C.dim}${r.note}${C.reset}`);
        if (!r.pass) console.log(`  ${C.yellow}actual:${C.reset}`, JSON.stringify(r.actual));
      }
    }
    console.log(`\n${C.bold}Overall${C.reset}  ${failCount === 0 ? C.green : C.red}${passCount}/${results.length}${C.reset}`);
    process.exit(failCount === 0 ? 0 : 1);
  }

  return { check, report };
}

module.exports = { C, parseArgs, makeCheckRegistry, run, makeEagerCheckRegistry };
