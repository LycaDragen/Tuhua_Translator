/**
 * glossary-prompt.js bench — LLM engine overhaul, Fase 5. Pure Node, no
 * network, no Electron.
 *
 * Covers the formatting rules from the plan's Fase 5 section: presence
 * filtering, the word-boundary guard (the concrete bug it exists to
 * prevent — `art → arte` firing inside `start`), the caps (20 entries /
 * 1200 chars, longest-source-first), the `source===target` → "keep
 * unchanged" split, and `regex` entries being excluded from the block
 * while still being real glossary entries elsewhere.
 *
 *   node scripts/test-glossary-prompt.js
 *   node scripts/test-glossary-prompt.js --quiet
 */
const path = require('path');
const { buildGlossaryPrompt, maskKeepUnchanged, matchesLine, containsCJK, fixTermSpacing, PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, MAX_ENTRIES, MAX_CHARS } =
  require(path.join('..', 'src', 'services', 'translation', 'glossary-prompt.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

// ─── presence filtering ───────────────────────────────────────────────────
check('only-entries-present-in-the-line-are-included', () => {
  const entries = [
    { source: '灰音', target: 'Haine', mode: 'exact' },
    { source: 'アルテミス', target: 'Artemis', mode: 'exact' }
  ];
  const text = buildGlossaryPrompt(entries, '灰音、おはよう。');
  return { pass: text.includes('Haine') && !text.includes('Artemis'), actual: text };
});

check('empty-result-when-nothing-matches', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, '今日はいい天気ですね。');
  return { pass: text === '', actual: text };
}, "resolveVariable('glossary') in prompt-template.js treats '' as auto-collapsible — this is what lets the {glossary} line vanish cleanly when there's nothing to say.");

check('disabled-entries-are-excluded', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact', enabled: false }];
  const text = buildGlossaryPrompt(entries, '灰音、おはよう。');
  return { pass: text === '', actual: text };
});

// ─── case-insensitive mode ─────────────────────────────────────────────────
check('case-insensitive-mode-matches-regardless-of-case', () => {
  const entries = [{ source: 'senpai', target: 'senpai (upperclassman)', mode: 'case-insensitive' }];
  const text = buildGlossaryPrompt(entries, 'Hey SENPAI, wait up!');
  return { pass: text.includes('senpai (upperclassman)'), actual: text };
});

// ─── the word-boundary guard (the concrete bug from the plan) ─────────────
check('word-boundary-guard-does-not-fire-inside-a-longer-latin-word', () => {
  const entries = [{ source: 'art', target: 'arte', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, 'Please start the game now.');
  return { pass: text === '', actual: text };
}, '"art" must not match inside "start" — this is glossary.js\'s known literal-replacement bug (art→arte turns start into starte); the prompt block must not repeat it.');

check('word-boundary-guard-still-fires-on-a-real-standalone-word', () => {
  const entries = [{ source: 'art', target: 'arte', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, 'I love art class.');
  return { pass: text.includes('art → arte'), actual: text };
});

check('word-boundary-guard-does-not-apply-to-cjk-terms', () => {
  // CJK has no \w/\W transition in the regex-\b sense, and a CJK line has
  // no spaces — matchesLine must fall through to plain substring matching,
  // not silently fail to match a legitimate CJK entry.
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, '灰音先輩、おはよう。');
  return { pass: text.includes('Haine'), actual: text };
});

check('containsCJK-detects-cjk-anywhere-in-the-string', () => {
  const cases = [['art', false], ['灰音', true], ['Artemis-2', false], ['桜Art', true], ['арт', false]];
  const offenders = cases.filter(([str, expected]) => containsCJK(str) !== expected);
  return { pass: offenders.length === 0, actual: offenders };
});

// ─── word-boundary guard on non-CJK, non-Latin scripts ─────────────────────
// Lyca asked specifically not to limit testing to well-known languages —
// this is the bug that surfaced from actually doing that: the guard used
// to be gated on "is the term ALL-LATIN" (ASCII only), so a Cyrillic term
// fell through to plain substring matching and corrupted a real word.
check('word-boundary-guard-protects-cyrillic-terms-too-not-only-latin', () => {
  const entries = [{ source: 'арт', target: 'арт', mode: 'exact' }]; // Russian for "art"
  const text = buildGlossaryPrompt(entries, 'Мы должны сделать старт сейчас.'); // "старт" = "start"
  return { pass: text === '', actual: text };
}, '"арт" must not match inside "старт" (Russian "start") — the exact same shape of bug as art/start in English, just a different script. Plain JS `\\b` is ASCII-only and silently fails to guard non-Latin scripts at all, so this needed a Unicode-aware boundary, not just a wider term check.');

check('word-boundary-guard-still-fires-on-a-standalone-cyrillic-word', () => {
  const entries = [{ source: 'арт', target: 'арт', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, 'Здесь арт хороший.');
  return { pass: text.includes('- арт'), actual: text };
});

check('masking-does-not-slice-a-cyrillic-word-in-half', () => {
  // The masking-specific version of the same bug: without the fix, this
  // would produce "Мы должны сделать ст⟦1⟧ сейчас." — a real word sliced
  // in half with a placeholder token jammed into the middle of it, sent to
  // the engine as if it were legitimate input.
  const entries = [{ source: 'арт', target: 'арт', mode: 'exact' }];
  const { maskedText, hasMasks } = maskKeepUnchanged(entries, 'Мы должны сделать старт сейчас.');
  return { pass: hasMasks === false && maskedText === 'Мы должны сделать старт сейчас.', actual: maskedText };
});

// ─── source===target → "keep unchanged" split ─────────────────────────────
check('source-equals-target-goes-to-the-keep-unchanged-block-not-renderings', () => {
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, '桜花学園に着いた。');
  return {
    pass: text.includes('Keep these unchanged (proper nouns):') && text.includes('- 桜花学園') && !text.includes('→'),
    actual: text
  };
}, 'This is the exact VNDB-import case the plan calls out: source===target entries were pure no-ops in the literal-replacement path and never reached the model at all.');

check('renderings-and-keep-unchanged-both-present-when-both-match', () => {
  const entries = [
    { source: '灰音', target: 'Haine', mode: 'exact' },
    { source: '桜花学園', target: '桜花学園', mode: 'exact' }
  ];
  const text = buildGlossaryPrompt(entries, '灰音は桜花学園の生徒だ。');
  return {
    pass: text.includes('Glossary — apply these renderings exactly:') &&
      text.includes('- 灰音 → Haine') &&
      text.includes('Keep these unchanged (proper nouns):') &&
      text.includes('- 桜花学園'),
    actual: text
  };
});

// ─── regex entries excluded from the prompt block ──────────────────────────
check('regex-mode-entries-are-excluded-from-the-block', () => {
  const entries = [{ source: '「(.+?)」', target: '"$1"', mode: 'regex' }];
  const text = buildGlossaryPrompt(entries, '灰音「おはよう」');
  return { pass: text === '', actual: text };
}, 'A regex pattern is not a term a prompt instruction can act on — it keeps working via the existing literal replacement path, untouched by this module.');

check('matchesLine-returns-false-for-regex-mode-directly', () => {
  const pass = matchesLine({ source: '.*', mode: 'regex' }, 'anything', new Map());
  return { pass: pass === false, actual: pass };
});

// ─── caps: entry count and character budget ────────────────────────────────
check('maxEntries-caps-the-number-of-entries-longest-source-first', () => {
  const entries = [
    { source: 'A', target: 'one', mode: 'exact' },
    { source: 'BB', target: 'two', mode: 'exact' },
    { source: 'CCC', target: 'three', mode: 'exact' }
  ];
  const text = buildGlossaryPrompt(entries, 'A BB CCC', { maxEntries: 2 });
  return {
    pass: text.includes('CCC → three') && text.includes('BB → two') && !text.includes('A → one'),
    actual: text
  };
}, 'Longest-source-first: with a tight cap, a more specific/longer term should survive over a shorter, more generic one competing for the same budget.');

check('maxChars-stops-adding-entries-once-the-budget-is-exhausted', () => {
  const entries = [
    { source: 'AAAAAAAAAA', target: 'ten-a', mode: 'exact' },
    { source: 'BBBBBBBBBB', target: 'ten-b', mode: 'exact' }
  ];
  const text = buildGlossaryPrompt(entries, 'AAAAAAAAAA BBBBBBBBBB', { maxChars: 30 });
  return { pass: text.includes('ten-a') && !text.includes('ten-b'), actual: text };
});

check('default-caps-match-the-plan (20 entries / 1200 chars)', () => {
  return { pass: MAX_ENTRIES === 20 && MAX_CHARS === 1200, actual: { MAX_ENTRIES, MAX_CHARS } };
});

check('more-than-20-matching-entries-still-caps-at-20-with-default-options', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) {
    // Vary length so sort order is deterministic and doesn't depend on
    // Array.prototype.sort's stability for equal-length keys.
    entries.push({ source: `term${String(i).padStart(2, '0')}`, target: `t${i}`, mode: 'exact' });
  }
  const text = buildGlossaryPrompt(entries, entries.map((e) => e.source).join(' '));
  const lineCount = text.split('\n').filter((l) => l.startsWith('- ')).length;
  return { pass: lineCount === 20, actual: lineCount };
});

// ─── compileCache reuse ─────────────────────────────────────────────────────
check('compileCache-is-reused-across-calls-when-passed-explicitly', () => {
  const cache = new Map();
  const entries = [{ source: 'art', target: 'arte', mode: 'exact' }];
  buildGlossaryPrompt(entries, 'I love art class.', { compileCache: cache });
  const sizeAfterFirst = cache.size;
  buildGlossaryPrompt(entries, 'More art here too.', { compileCache: cache });
  return { pass: sizeAfterFirst === 1 && cache.size === 1, actual: { sizeAfterFirst, sizeAfterSecond: cache.size } };
}, 'A fresh regex compile per entry per line would be real cost at scale (a VNDB import can be hundreds of entries) — the cache must actually be reused, not just accepted and ignored.');

// ─── maskKeepUnchanged (the placeholder-protection mechanism) ─────────────
check('masks-a-keep-unchanged-entry-and-restore-puts-it-back', () => {
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const { maskedText, hasMasks, restore } = maskKeepUnchanged(entries, '桜花学園に着いた。');
  const roundTrip = restore(`Llegó a ${maskedText.match(/⟦\d⟧/)[0]}.`);
  return {
    pass: hasMasks && !maskedText.includes('桜花学園') && roundTrip === 'Llegó a 桜花学園.',
    actual: { maskedText, roundTrip }
  };
}, 'The core guarantee: the model never sees the real term (it is gone from maskedText), and restore() puts the exact original text back regardless of what the model did around the token.');

check('rendering-entries-are-never-masked', () => {
  const entries = [{ source: '灰音', target: 'Haine', mode: 'exact' }];
  const { maskedText, hasMasks } = maskKeepUnchanged(entries, '灰音、おはよう。');
  return { pass: !hasMasks && maskedText === '灰音、おはよう。', actual: { maskedText, hasMasks } };
}, 'Masking is only for source===target entries — a rendering entry needs the model to see the source text to know what to substitute.');

check('regex-entries-are-never-masked', () => {
  const entries = [{ source: '.+', target: '.+', mode: 'regex' }];
  const { maskedText, hasMasks } = maskKeepUnchanged(entries, 'anything here');
  return { pass: !hasMasks && maskedText === 'anything here', actual: { maskedText, hasMasks } };
});

check('entries-not-present-in-the-text-produce-no-mask', () => {
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const { hasMasks } = maskKeepUnchanged(entries, '今日はいい天気ですね。');
  return { pass: hasMasks === false, actual: hasMasks };
});

check('multiple-keep-unchanged-entries-get-distinct-placeholder-tokens', () => {
  const entries = [
    { source: '桜花学園', target: '桜花学園', mode: 'exact' },
    { source: 'アルテミス', target: 'アルテミス', mode: 'exact' }
  ];
  const { maskedText } = maskKeepUnchanged(entries, '桜花学園でアルテミスに会った。');
  const tokens = maskedText.match(/⟦\d⟧/g) || [];
  return {
    pass: tokens.length === 2 && new Set(tokens).size === 2 && !maskedText.includes('桜花学園') && !maskedText.includes('アルテミス'),
    actual: maskedText
  };
});

check('word-boundary-guard-applies-to-masking-too', () => {
  // Same guard as matchesLine/buildGlossaryPrompt: an all-Latin keep-unchanged
  // term must not mask a substring inside an unrelated longer word.
  const entries = [{ source: 'art', target: 'art', mode: 'exact' }];
  const { hasMasks, maskedText } = maskKeepUnchanged(entries, 'Please start the game now.');
  return { pass: hasMasks === false && maskedText === 'Please start the game now.', actual: maskedText };
}, 'Without this guard, masking "art" inside "start" would corrupt an unrelated English word in the source line — worse than the bug it exists to prevent.');

check('restore-is-a-no-op-when-the-model-drops-the-placeholder-entirely', () => {
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const { restore } = maskKeepUnchanged(entries, '桜花学園に着いた。');
  const result = restore('I arrived at the school.');
  return { pass: result === 'I arrived at the school.', actual: result };
}, "restore() only replaces tokens it finds — if the model drops the placeholder entirely (rare, but possible), this fails safe (empty/missing term) rather than throwing or inserting garbage.");

check('restore-inserts-a-space-at-a-cjk-latin-boundary-the-model-dropped', () => {
  // Reproduces the exact failure observed against a real local model
  // (Qwen2.5-3B via Ollama): "Haine fue a⟦1⟧." — the model kept the token
  // intact but glued it directly onto the preceding Spanish word.
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const { maskedText, restore } = maskKeepUnchanged(entries, '桜花学園に着いた。');
  const token = maskedText.match(/⟦\d⟧/)[0];
  const result = restore(`Haine fue a${token}.`);
  return { pass: result === 'Haine fue a 桜花学園.', actual: result };
});

check('restore-does-not-add-a-space-when-the-model-already-spaced-it-correctly', () => {
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const { maskedText, restore } = maskKeepUnchanged(entries, '桜花学園に着いた。');
  const token = maskedText.match(/⟦\d⟧/)[0];
  const result = restore(`Haine fue a ${token}.`);
  return { pass: result === 'Haine fue a 桜花学園.', actual: result };
}, 'No double-spacing when the model got it right on its own.');

check('restore-inserts-a-space-between-two-glued-latin-words-too', () => {
  // The Qwen2.5-3B artifact reproduced with a plain English glossary term
  // restored into Spanish, not just CJK: "aNekoparu Academy" — confirms
  // the fix isn't CJK-specific, it fires at any glued letter/digit boundary.
  const entries = [{ source: 'Nekoparu Academy', target: 'Nekoparu Academy', mode: 'exact' }];
  const { maskedText, restore } = maskKeepUnchanged(entries, 'Welcome to Nekoparu Academy today.');
  const token = maskedText.match(/⟦\d⟧/)[0];
  const result = restore(`Bienvenido a${token}, hogar de campeones.`);
  return { pass: result === 'Bienvenido a Nekoparu Academy, hogar de campeones.', actual: result };
});

check('restore-does-not-add-a-space-between-two-cjk-neighbors', () => {
  // Japanese/Chinese output legitimately has no spaces between words —
  // this must never "fix" that into a real bug.
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const { maskedText, restore } = maskKeepUnchanged(entries, '桜花学園に着いた。');
  const token = maskedText.match(/⟦\d⟧/)[0];
  const result = restore(`花音は${token}に着いた。`);
  return { pass: result === '花音は桜花学園に着いた。', actual: result };
});

check('placeholder-tokens-use-the-documented-brackets', () => {
  return { pass: PLACEHOLDER_OPEN === '⟦' && PLACEHOLDER_CLOSE === '⟧', actual: { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE } };
});

check('buildGlossaryPrompt-includeKeepUnchanged-false-omits-the-keep-unchanged-block', () => {
  const entries = [
    { source: '灰音', target: 'Haine', mode: 'exact' },
    { source: '桜花学園', target: '桜花学園', mode: 'exact' }
  ];
  const text = buildGlossaryPrompt(entries, '灰音は桜花学園にいる。', { includeKeepUnchanged: false });
  return {
    pass: text.includes('Haine') && !text.includes('Keep these unchanged') && !text.includes('桜花学園'),
    actual: text
  };
}, 'pipeline.js sets this when maskKeepUnchanged() already handles those entries — the prompt block should only carry what masking does NOT already guarantee.');

check('buildGlossaryPrompt-includeKeepUnchanged-defaults-to-true-unchanged-from-before', () => {
  const entries = [{ source: '桜花学園', target: '桜花学園', mode: 'exact' }];
  const text = buildGlossaryPrompt(entries, '桜花学園に着いた。');
  return { pass: text.includes('Keep these unchanged (proper nouns):') && text.includes('- 桜花学園'), actual: text };
});

// ─── fixTermSpacing (DeepL's native glossary, Fase 6) ──────────────────────
check('fixTermSpacing-fixes-a-real-deepl-glossary-glued-boundary', () => {
  // Reproduced against DeepL's real API with a live glossary_id: "灰音は
  // 桜花学園に行った。" with a keep-unchanged 桜花学園 entry came back as
  // "Haine fue a la桜花学園." — DeepL's own native glossary has the exact
  // same glued-boundary artifact as the LLM masking path, with no
  // placeholder step of Tuhua's to hook into.
  const result = fixTermSpacing('Haine fue a la桜花学園.', ['桜花学園']);
  return { pass: result === 'Haine fue a la 桜花学園.', actual: result };
});

check('fixTermSpacing-does-not-touch-a-correctly-spaced-cjk-latin-boundary', () => {
  const result = fixTermSpacing('花音は桜花学園に着いた。', ['桜花学園']);
  return { pass: result === '花音は桜花学園に着いた。', actual: result };
});

check('fixTermSpacing-handles-latin-terms-too', () => {
  const result = fixTermSpacing('Bienvenido aNekoparu Academy hoy.', ['Nekoparu Academy']);
  return { pass: result === 'Bienvenido a Nekoparu Academy hoy.', actual: result };
});

check('fixTermSpacing-handles-multiple-terms-and-occurrences', () => {
  const result = fixTermSpacing('花音と桜花学園とアルテミスが話す。桜花学園はいい所だ。', ['桜花学園', 'アルテミス']);
  return { pass: result === '花音と桜花学園とアルテミスが話す。桜花学園はいい所だ。', actual: result };
}, 'No terms glued to non-CJK neighbors here — should be a pure no-op, and must not throw or infinite-loop scanning repeated occurrences.');

check('fixTermSpacing-is-a-no-op-when-the-term-is-absent', () => {
  const result = fixTermSpacing('Nothing to see here.', ['桜花学園']);
  return { pass: result === 'Nothing to see here.', actual: result };
});

run("glossary-prompt.js bench", CHECKS);
