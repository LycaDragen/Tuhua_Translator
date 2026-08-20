/**
 * speaker-extract.js bench — LLM engine overhaul, Fase 7a. Pure Node, no
 * network, no Electron.
 *
 * Positives (real hook shapes the plan's own examples reference) and
 * negatives (markup that uses the identical `<...>` shape but isn't a
 * speaker — `<color=red>` is the plan's own named negative case) side by
 * side, so a change that widens the match too far shows up here first.
 *
 *   node scripts/test-speaker-extract.js
 *   node scripts/test-speaker-extract.js --quiet
 */
const path = require('path');
const { extractSpeaker, looksLikeSpeakerName } = require(path.join('..', 'src', 'services', 'speaker-extract.js'));

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

// ─── positives: angle-bracket speaker tag ──────────────────────────────────
check('extracts-the-canonical-angle-bracket-example', () => {
  // regex-filter.js's own builtin-remove-angle-brackets doc comment uses
  // this exact example ("<Narumi>Hello → Hello") for the filter this
  // module has to run BEFORE.
  const { speaker, text } = extractSpeaker('<Narumi>Hello');
  return { pass: speaker === 'Narumi' && text === 'Hello', actual: { speaker, text } };
});

check('angle-bracket-name-with-a-space', () => {
  const { speaker, text } = extractSpeaker('<Big Sister>Wake up already.');
  return { pass: speaker === 'Big Sister' && text === 'Wake up already.', actual: { speaker, text } };
});

check('angle-bracket-dialogue-is-returned-byte-identical', () => {
  const { text } = extractSpeaker('<Haine>ちょっと、聞いてる?');
  return { pass: text === 'ちょっと、聞いてる?', actual: text };
}, 'The dialogue text itself must be untouched — only the tag is peeled off.');

// ─── negatives: markup that uses the same <...> shape ──────────────────────
check('color-tag-is-not-a-speaker (the plan\'s own named negative case)', () => {
  const { speaker, text } = extractSpeaker('<color=red>Warning!</color>');
  return { pass: speaker === null && text === '<color=red>Warning!</color>', actual: { speaker, text } };
});

check('size-tag-is-not-a-speaker', () => {
  const { speaker } = extractSpeaker('<size=24>BIG TEXT</size>');
  return { pass: speaker === null, actual: speaker };
});

check('closing-tag-is-not-a-speaker', () => {
  const { speaker } = extractSpeaker('</color>rest of text');
  return { pass: speaker === null, actual: speaker };
});

check('bare-markup-keyword-without-equals-is-not-a-speaker', () => {
  const { speaker } = extractSpeaker('<b>Bold text</b>');
  return { pass: speaker === null, actual: speaker };
}, "A markup keyword with no '=' (color=red is already caught by the equals check) — <b>/<i>/<ruby>/... are common enough in hook text to need their own denylist entry.");

check('nested-markup-immediately-after-the-tag-is-not-a-speaker', () => {
  const { speaker } = extractSpeaker('<Narumi><color=red>shouting</color></Narumi>');
  return { pass: speaker === null, actual: speaker };
}, "Even though 'Narumi' alone would pass looksLikeSpeakerName, the dialogue starting with ANOTHER tag immediately reads as nested markup, not Name>dialogue.");

check('overlong-candidate-is-not-a-speaker', () => {
  const longText = 'a'.repeat(40);
  const { speaker } = extractSpeaker(`<${longText}>dialogue`);
  return { pass: speaker === null, actual: speaker };
}, "Names aren't paragraphs — a 40-char tag content is almost certainly something else (a data blob, a malformed tag) than a speaker name.");

// ─── positives: Japanese quote-prefix ──────────────────────────────────────
check('extracts-the-canonical-japanese-quote-example', () => {
  // regex-filter.js's builtin-extract-japanese-quotes doc comment example.
  const { speaker, text } = extractSpeaker('名前「こんにちは」');
  return { pass: speaker === '名前' && text === 'こんにちは', actual: { speaker, text } };
});

check('japanese-quote-with-a-real-character-name', () => {
  const { speaker, text } = extractSpeaker('灰音「おはよう、今日も一緒に学校へ行こう」');
  return { pass: speaker === '灰音' && text === 'おはよう、今日も一緒に学校へ行こう', actual: { speaker, text } };
});

check('japanese-quote-trailing-whitespace-is-tolerated', () => {
  const { speaker, text } = extractSpeaker('灰音「おはよう」\n');
  return { pass: speaker === '灰音' && text === 'おはよう', actual: { speaker, text } };
});

// ─── negatives: japanese quote NOT at a clean name-prefix shape ────────────
check('a-quote-that-does-not-reach-the-end-is-not-a-name-prefix', () => {
  // Dialogue that just happens to CONTAIN a quotation mid-sentence, not
  // Name「...」— nothing after the closing quote is normal here, so
  // reaching-the-end is exactly the signal that distinguishes the two.
  const { speaker, text } = extractSpeaker('彼は「おはよう」と言った。');
  return { pass: speaker === null && text === '彼は「おはよう」と言った。', actual: { speaker, text } };
});

check('no-prefix-before-the-quote-is-not-extracted-as-an-empty-speaker', () => {
  const { speaker, text } = extractSpeaker('「おはよう」');
  return { pass: speaker === null && text === '「おはよう」', actual: { speaker, text } };
}, 'An empty candidate must not become speaker: "" — that would be worse than no speaker at all.');

// ─── plain text with no speaker shape at all ────────────────────────────────
check('plain-text-with-no-tag-or-quote-passes-through-unchanged', () => {
  const { speaker, text } = extractSpeaker('今日はいい天気ですね。');
  return { pass: speaker === null && text === '今日はいい天気ですね。', actual: { speaker, text } };
});

check('empty-string-is-handled-without-throwing', () => {
  const { speaker, text } = extractSpeaker('');
  return { pass: speaker === null && text === '', actual: { speaker, text } };
});

check('non-string-input-passes-through-without-throwing', () => {
  const { speaker, text } = extractSpeaker(null);
  return { pass: speaker === null && text === null, actual: { speaker, text } };
});

// ─── looksLikeSpeakerName directly ──────────────────────────────────────────
check('looksLikeSpeakerName-accepts-plausible-names-rejects-markup', () => {
  const cases = [
    ['Narumi', true], ['Big Sister', true],
    ['color=red', false], ['/color', false], ['b', false], ['ruby', false],
    ['', false]
  ];
  const offenders = cases.filter(([str, expected]) => looksLikeSpeakerName(str) !== expected);
  return { pass: offenders.length === 0, actual: offenders };
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

  console.log(`${C.bold}speaker-extract.js bench${C.reset} — ${results.length} case(s)\n`);
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
