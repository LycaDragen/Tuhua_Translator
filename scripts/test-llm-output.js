/**
 * llm-output.js bench — sanitizeLLMOutput() ground truth (LLM engine
 * overhaul, Fase 2). Pure Node, no network, no Electron.
 *
 * Runs scripts/llm-output-ground-truth.json's two sections against the real
 * sanitizeLLMOutput() (src/services/translation/llm-output.js):
 *   - `cases`: inputs that must be transformed a specific way.
 *   - `mustNotChange`: legitimate LLM outputs that must survive byte-
 *     identical. This is the non-negotiable half — see the plan's own
 *     framing: a false positive here (a real translation mangled by the
 *     sanitizer) looks like a Tuhua bug, not an LLM one, and is worse than
 *     missing a bad output the user can just retranslate past.
 *
 *   node scripts/test-llm-output.js
 *   node scripts/test-llm-output.js --quiet
 */
const fs = require('fs');
const path = require('path');
const { sanitizeLLMOutput } = require(path.join('..', 'src', 'services', 'translation', 'llm-output.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

function sameSet(actual, expected) {
  if (!expected) return true; // omitted in the fixture — don't check
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((v, i) => v === e[i]);
}

function runEntry(entry) {
  const result = sanitizeLLMOutput(entry.input, {
    sourceText: entry.sourceText,
    sourceLangCode: entry.sourceLangCode,
    targetLangCode: entry.targetLangCode,
    finishReason: entry.finishReason
  });

  const verdictOk = result.verdict === entry.expectedVerdict;
  const textOk = entry.expectedText === undefined || result.text === entry.expectedText;
  const actionsOk = sameSet(result.actions, entry.expectedActions);

  return {
    pass: verdictOk && textOk && actionsOk,
    actual: { text: result.text, verdict: result.verdict, actions: result.actions },
    expected: { text: entry.expectedText, verdict: entry.expectedVerdict, actions: entry.expectedActions }
  };
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const groundTruthPath = path.join(__dirname, 'llm-output-ground-truth.json');
  const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8'));

  const results = [];
  for (const entry of groundTruth.cases || []) {
    results.push({ id: entry.id, section: 'cases', note: entry.note, ...runEntry(entry) });
  }
  for (const entry of groundTruth.mustNotChange || []) {
    results.push({ id: entry.id, section: 'mustNotChange', note: entry.note, ...runEntry(entry) });
  }

  console.log(`${C.bold}llm-output.js bench${C.reset} — ${results.length} case(s) (${groundTruth.cases.length} cases, ${groundTruth.mustNotChange.length} mustNotChange)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  [${r.section}] ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify({ actual: r.actual, expected: r.expected }, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  const mustNotChangeFails = results.filter((r) => r.section === 'mustNotChange' && !r.pass).length;
  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  if (mustNotChangeFails > 0) {
    console.log(`${C.red}${mustNotChangeFails} mustNotChange failure(s) — the sanitizer mangled a legitimate translation. This is the more serious failure mode.${C.reset}`);
  }
  process.exit(passed === results.length ? 0 : 1);
}

run();
