/**
 * v3.13.79 — OCR text-cleaning bench: _cleanOcrText() (Tesseract path),
 * _cleanPaddleOcrText() (Paddle path), and _isMostlyGarbled() (the garbled
 * gate both paths call before emitting), all in src/services/ocr.js. Pure
 * string transforms, no Electron, no disk I/O — OcrService can be
 * instantiated directly as long as _preprocessImage() (which lazily
 * requires('electron')) is never called.
 *
 * Motivated by real bugs found while auditing the round-2 cleaning pipeline
 * against the ground-truth bench, then confirmed live on Windows (see
 * plan-ocr-refinement-round2 memo / round-3 plan): the English pronoun "I"
 * was being deleted by the lone-letter-noise filter despite a comment
 * saying it was preserved; the l/1 misread fix was destroying real numbers
 * ("Level1"->"Levell", "F1"->"Fl"); the trailing-word truncation was eating
 * real short words ("It is OK"->"It is", "12:45 PM"->"12:45"); and — found
 * live, Lyca saw "Well" silently skipped every single capture in session50
 * — _isMostlyGarbled() had a blanket `text.length < 5 -> garbled` floor
 * that ran BEFORE the CJK exemption, so it killed every short real result
 * regardless of script (English 4-letter interjections, short CJK replies)
 * before the per-word/CJK heuristics ever got to judge it on its own merits.
 *
 *   node scripts/test-ocr-text-cleaning.js
 *   node scripts/test-ocr-text-cleaning.js --quiet
 */
const path = require('path');
const OcrService = require(path.join('..', 'src', 'services', 'ocr.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

function makeService(language) {
  const svc = new OcrService();
  svc._language = language || 'eng';
  return svc;
}

// `fn` is which cleaner to exercise: 'tesseract' -> _cleanOcrText,
// 'paddle' -> _cleanPaddleOcrText. Most regression cases only make sense
// for one side (e.g. _cleanPaddleOcrText has no Step 11 at all), but the
// three fixed bugs apply to both, so the shared ones are tagged 'both'.
const CASES = [
  // ─── Bug 1: "I" was being deleted by the lone-letter-noise filter ──────
  { id: 'i-pronoun-mid-sentence', fn: 'both', input: 'I am here', expected: 'I am here',
    note: 'The exact regression: comment said "Preserve I and a" but the character class still included I.' },
  { id: 'i-pronoun-real-line', fn: 'both', input: "Even though you're here you're going to try and run again, I know it.",
    expected: "Even though you're here you're going to try and run again, I know it.",
    note: 'Ground-truth-shaped sentence (Echo set 8) with a standalone "I".' },
  { id: 'a-pronoun-still-preserved', fn: 'both', input: 'a cat sat there', expected: 'a cat sat there',
    note: 'Regression guard — "a" was already correctly preserved before this round; must stay that way.' },

  // ─── Bug 2: 6a (l/1 misread) was destroying real numbers/callsigns ─────
  { id: 'f1-not-mangled', fn: 'tesseract', input: 'F1 key', expected: 'F1 key',
    note: 'Preceding letter is F, not l — must not match the tightened 6a.' },
  { id: 'a1-b2-c3-not-mangled', fn: 'tesseract', input: 'A1 B2 C3', expected: 'A1 B2 C3' },
  { id: 'route-93-not-mangled', fn: 'tesseract', input: 'Route 93', expected: 'Route 93' },
  { id: 'wil1-still-fixed-lowercase', fn: 'tesseract', input: 'wil1 do it', expected: 'will do it',
    note: 'The actual misread 6a exists to fix: double-l read as l1. Must still work lowercase.' },
  { id: 'wil1-still-fixed-uppercase', fn: 'tesseract', input: 'WIL1 you', expected: 'WILl you',
    note: 'Case-insensitive per explicit request — WIL1 must still convert (pre-existing mixed-case output quirk, not a regression from this fix; the ORIGINAL code already appended a lowercase l regardless of case).' },
  { id: 'level1-known-limitation', fn: 'tesseract', input: 'Level1', expected: 'Levell',
    note: "KNOWN AMBIGUITY, not fixed by this round: \"Level1\" ends in a single 'l', same local shape as the genuine wil1->will misread, so the tightened regex still matches it. Distinguishing \"Level 1\" from a genuine double-l misread needs more than local context. Zero ground-truth entries in ocr-ground-truth.json exercise this shape (verified separately), so it's left as a documented limitation rather than chased further." },

  // ─── Bug 3: Step 11 was truncating real short trailing words ───────────
  { id: 'ok-not-truncated', fn: 'tesseract', input: 'It is OK', expected: 'It is OK' },
  { id: 'pm-not-truncated', fn: 'tesseract', input: '12:45 PM', expected: '12:45 PM' },
  { id: 'button-prompt-x-to-preserved', fn: 'tesseract', input: 'Press X to', expected: 'Press X to',
    note: 'Same family as the "I" bug (Lyca flagged it after seeing the first bench run): the lone-single-letter filter was deleting real button-prompt letters ("Press X to skip"). Protected via isProtectedButtonLetter() context check — a prompt verb before or a prompt continuation after the letter.' },
  { id: 'button-prompt-x-at-end-preserved', fn: 'tesseract', input: 'Press X', expected: 'Press X',
    note: 'The harder case: no trailing "to" to protect it via BUTTON_PROMPT_AFTER — Step 11 (trailing-word truncation) has to independently recognize the same context, or it strips right back what Step 10 just preserved.' },
  { id: 'button-prompt-hold-a-preserved', fn: 'tesseract', input: 'Hold A', expected: 'Hold A' },
  { id: 'button-prompt-y-to-preserved', fn: 'tesseract', input: 'Y to jump', expected: 'Y to jump' },
  { id: 'unrelated-lone-letter-still-stripped', fn: 'tesseract', input: 'random c word', expected: 'random word',
    note: 'Regression guard — the context protection must not turn off the filter for genuinely stray letters with no button-prompt context nearby.' },
  { id: 'save-1-untouched', fn: 'tesseract', input: 'Save 1', expected: 'Save 1',
    note: 'Regression guard for a real single-digit trailing number — must not be swept up by the garbled-word check.' },
  { id: 'garbled-trailing-still-stripped', fn: 'tesseract', input: 'This is real dialogue xq',
    expected: 'This is real dialogue', note: 'A genuinely garbled 2-letter trailing fragment must still be stripped.' },

  // ─── CJK guards must still hold (nothing in this round touches them) ───
  { id: 'cjk-untouched', fn: 'both', input: 'こんにちは 世界', expected: 'こんにちは 世界' },
  { id: 'cjk-garbled-prefix-untouched', fn: 'tesseract', input: '因書館の本を読みました。',
    expected: '因書館の本を読みました。', note: 'A single wrong kanji (因 for 図) must survive — CJK is never treated as garbled by the Latin heuristics.' },

  // ─── Regression guard for the existing garbled-prefix stripper ─────────
  { id: 'garbled-prefix-still-stripped', fn: 'tesseract', input: 'xqzv. This is real dialogue that continues on.',
    expected: 'This is real dialogue that continues on.' },

  // ─── Bug 4: _isMostlyGarbled()'s length<5 floor was killing short real
  // results before the CJK/word heuristics ever ran ──────────────────────
  { id: 'garbled-well-not-flagged', fn: 'garbled', input: 'Well', expected: false,
    note: 'The exact live regression (session50.log): "Well" (4 chars) was silently discarded on every capture, never reaching the overlay.' },
  { id: 'garbled-four-letter-real-words', fn: 'garbled', input: 'Stop', expected: false },
  { id: 'garbled-short-yeah-not-flagged', fn: 'garbled', input: 'Yeah', expected: false },
  { id: 'garbled-short-cjk-not-flagged', fn: 'garbled', input: 'はい', expected: false,
    note: 'Same class of bug for CJK: a 2-char reply used to hit the length floor before ever reaching the CJK exemption a few lines below it.' },
  { id: 'garbled-digits-not-flagged', fn: 'garbled', input: '35:97', expected: false,
    note: 'Regression guard for the round-3 digit exemption — must keep passing now that the length floor is gone too.' },
  { id: 'garbled-short-noise-still-flagged', fn: 'garbled', input: 'xk', expected: true,
    note: 'Regression guard — removing the length floor must not let genuinely garbled 2-letter fragments through; the commonShort Set in _isGarbledWord still catches this.' },
  { id: 'garbled-symbols-only-still-flagged', fn: 'garbled', input: '!! --', expected: true,
    note: 'Regression guard — punctuation-only noise (no letters, no digits) must still be flagged.' },
];

function run() {
  const args = parseArgs(process.argv.slice(2));
  const svcEng = makeService('eng');

  const results = CASES.map((c) => {
    if (c.fn === 'garbled') {
      const actual = svcEng._isMostlyGarbled(c.input);
      const pass = actual === c.expected;
      const failures = pass ? [] : [`_isMostlyGarbled: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}`];
      return { id: c.id, pass, failures, actuals: { garbled: actual }, note: c.note };
    }
    const fns = c.fn === 'both' ? ['tesseract', 'paddle'] : [c.fn];
    const failures = [];
    const actuals = {};
    for (const fn of fns) {
      const actual = fn === 'tesseract' ? svcEng._cleanOcrText(c.input) : svcEng._cleanPaddleOcrText(c.input);
      actuals[fn] = actual;
      if (actual !== c.expected) failures.push(`${fn}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}`);
    }
    return { id: c.id, pass: failures.length === 0, failures, actuals, note: c.note };
  });

  console.log(`${C.bold}OCR text-cleaning bench${C.reset} — ${results.length} case(s)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && (!r.pass || CASES.find(c => c.id === r.id).note)) {
      const note = CASES.find(c => c.id === r.id).note;
      if (note) console.log(`      ${C.dim}${note}${C.reset}`);
      if (!r.pass) console.log(`      ${C.dim}${r.failures.join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  process.exit(passed === results.length ? 0 : 1);
}

run();
