/**
 * ONE-OFF generator for scripts/hook-cleaning-ground-truth.json.
 * Not part of the bench itself — run manually to (re)build the corpus file.
 * Exists so multi-part Japanese concatenations are built and verified in
 * code (e.g. base + suffixes of decreasing length) instead of hand-typed
 * character-by-character into JSON, which is exactly the kind of place a
 * transcription mistake would silently corrupt the ground truth.
 */
const fs = require('fs');
const path = require('path');
const snapshot = require('./hook-cleaning-snapshot');

const entries = [];

function add(id, group, input, expected, appliesTo, note, hookPrefixed) {
  entries.push({ id, group, input, expected, appliesTo, note, hookPrefixed: !!hookPrefixed });
}

// ─── Group 1: Luna's 5 HOOK dedup patterns, isolated ────────────────────────

add(
  'L8_3x', 1,
  '恵恵恵麻麻麻さんは再び液タブへ視線を落とす。',
  '恵麻さんは再び液タブへ視線を落とす。',
  ['luna#8'],
  'Char repeated 3x+ (Luna\'s own documentation example). Covered today by Strategy 1\'s regex (\\1{2,} requires 3+ total occurrences).'
);

add(
  'L8_2x', 1,
  '桜' + '桜' + '咲' + '咲' + '久' + '久' + 'です',
  '桜咲久です',
  ['luna#8'],
  'Char repeated EXACTLY 2x (doubled), CJK. The gap: Strategy 1\'s regex requires 3+ occurrences (\\1{2,}), so a clean 2x double passes through untouched on the TCP route. Only _cleanGameText\'s _isDoubledText/_unDoubleText (launcher route only) catches this.'
);

add(
  'L9_cjk', 1,
  'ありがとう'.repeat(3),
  'ありがとう',
  ['luna#9'],
  'Full CJK line/sentence repeated 3x, no delimiter. Covered today by Strategy 2 (both routes).'
);

add(
  'L9_latin_gap', 1,
  'I love you.'.repeat(3),
  'I love you.',
  ['luna#9', 'cjkOnly-gap'],
  'Same pattern as L9_cjk but in English. FAILS on both routes today — Strategy 2 requires the candidate unit to contain a CJK character (hasCJK check), so pure-Latin full-sentence repetition is never collapsed by either route. This is a Fase-3 cjkOnly-relaxation candidate, not a route-wiring gap (both routes already share the same Strategy 2 code) — relaxing cjkOnly must not break the Group 2 latin-scream rows.'
);

// L10: Luna's "S1S1S1S2S2S2 -> S1S2" pattern — two different sentences,
// each individually repeated 3x, concatenated together.
{
  const s1 = 'やめて';
  const s2 = 'お願い';
  add(
    'L10', 1,
    s1.repeat(3) + s2.repeat(3),
    s1 + s2,
    ['luna#10'],
    'Multi-sentence variable refresh rate: S1 repeated 3x, then S2 repeated 3x, concatenated. FAILS today — no existing strategy handles this; the closest (Strategy 2) only detects a SINGLE repeating unit across the whole string, not two different repeating units back to back. Luna\'s own docs call this "complex deduplication logic" and expose a configurable repetition-count parameter because auto-detection isn\'t reliable — worth replicating that escape hatch in Fase 3, not just the heuristic.'
  );
}

// L11: Luna's "ABCDBCDCDD -> ABCD" pattern — progressively SHRINKING
// suffix (decreasing param length each call), concatenated.
// Constructed as: full string, then successive suffixes with 1 fewer
// leading char each time, down to the last single character.
{
  const base = 'ありがとう'; // 5 chars: あ,り,が,と,う
  let input = '';
  for (let dropFromFront = 0; dropFromFront < base.length; dropFromFront++) {
    input += base.substring(dropFromFront);
  }
  add(
    'L11', 1,
    input,
    base,
    ['luna#11'],
    'Progressive substring calls where parameters DECREASE (shrinking suffix): full string, then drop 1 char from the front each time, concatenated. Expected = the FIRST/longest/complete segment. FAILS today — confirmed by direct execution that _removeIncrementalPattern (the function whose docstring claims to handle exactly this example, "ABCDBCDCDD") returns null on every realistic input tested, including its own textbook example. Effectively dead code, not a mislabeled algorithm.'
  );
}

// L12: Luna's "AABABCABCD -> ABCD" pattern — progressively GROWING prefix
// (character-by-character redraw), concatenated.
{
  const full = 'あいうえお'; // 5 chars
  let input = '';
  for (let len = 1; len <= full.length; len++) {
    input += full.substring(0, len);
  }
  add(
    'L12', 1,
    input,
    full,
    ['luna#12'],
    'Character-by-character redraw (growing prefix): "A"+"AB"+"ABC"+... concatenated. Expected = the LAST/longest/complete segment (opposite end from L11). FAILS today for the same reason as L11 — _removeIncrementalPattern returns null on this pattern too, verified directly, not assumed from reading the code. The approved plan originally guessed this function implemented Luna #12 by misreading its structure; running it against this exact case disproved that.'
  );
}

// ─── Group 2: regressions that MUST survive on both routes, unchanged ──────

add('G2_scream_single', 2, 'AAAAA', 'AAAAA', ['strategy1', 'strategy2'], 'Single-char Latin scream must never collapse — legitimate emphasis, not a Textractor artifact (v3.12.04/06 regression guard).');
add('G2_scream_2unit', 2, 'HAHAHAHA', 'HAHAHAHA', ['strategy2'], '2-char repeating Latin unit ("HA") must never collapse — same regression class as above.');
add('G2_scream_nono', 2, 'NONONONO', 'NONONONO', ['strategy2'], 'Another documented real-world Latin emphasis case from the code\'s own comments.');
add('G2_stats_colon', 2, 'HP:100 MP:50', 'HP:100 MP:50', ['strategy4', 'deduplicateSegments'], 'Digit-delimiter dedup must not eat meaningful Label:Number pairs. This was the active data-loss bug patched 2026-08-06 on the launcher route (both _deduplicateSegments and _cleanGameText\'s trailing-digit strip).');
add('G2_leading_number_word', 2, '3 hours', '3 hours', ['strategy4-leading-strip'], 'A legitimate leading number followed by a space+word must survive. Second data-loss bug patched 2026-08-06 (_deduplicateText\'s leading-digit strip had no space-awareness, unlike _cleanGameText\'s copy).');
add('G2_leading_number_word2', 2, '3 people arrived', '3 people arrived', ['strategy4-leading-strip'], 'Same class as above, different wording — guards against the fix being coincidentally correct for only one exact string.');
add('G2_real_digit_dup', 2, '0I softly murmured to myself.0I softly murmured to myself.0', 'I softly murmured to myself.', ['strategy4', 'deduplicateSegments'], 'The actual positive case Strategy 4 exists for — digit delimiters ARE garbage here since the segments are true duplicates. Must still work after the two data-loss patches above (guards should only suppress the destructive path, not the whole feature).');
add('G2_jp_quotes', 2, '「静かに」と先生は言った。', '「静かに」と先生は言った。', ['none'], 'Ordinary Japanese dialogue with legitimate quotation marks — must pass through completely untouched by all HOOK dedup strategies.');
add('G2_hook_prefix_real_text', 2, '[0x004A1B20:1:GameThread] 恵恵恵麻麻麻さんは再び。', '恵麻さんは再び。', ['stripHookPrefix', 'strategy1'], 'TCP-route-only case: real hook prefix wrapping a char-repeat artifact — confirms stripHookPrefix + downstream dedup compose correctly.', true);

// ─── Group 3: gaps that differ by MECHANISM, not just by route ────────────
// 3a: route-composition gap — the algorithm exists, just isn't wired to TCP.
// Fixed by Fase 1's consolidation, NOT by relaxing cjkOnly.
add(
  'G3a_doubled_latin', 3,
  'NNooww tthhaatt',
  'Now that',
  ['unDoubleText', 'route-gap'],
  'Route-composition gap, confirmed asymmetric today: launcher route correctly un-doubles this via _isDoubledText/_unDoubleText; TCP route has no equivalent step at all and leaves it completely untouched. Fixed by Fase 1 applying the same doubled-text check to both routes — NOT a cjkOnly question, this mechanism has no CJK restriction, it\'s simply missing from one route entirely.'
);

// 3b: cjkOnly-restriction gap — Strategy 2 already runs on both routes, but
// deliberately skips non-CJK candidates. Only fixable by relaxing cjkOnly.
add(
  'G3b_sentence_repeat_latin', 3,
  'Now that I am on my own.'.repeat(3),
  'Now that I am on my own.',
  ['strategy2', 'cjkOnly-gap'],
  'cjkOnly-restriction gap, confirmed symmetric today: FAILS on both routes identically (same Strategy 2 code, same hasCJK gate). Only fixable in Fase 3 by relaxing cjkOnly for Strategy 2 specifically — and only if doing so doesn\'t break Group 2\'s Latin-scream rows (G2_scream_*). This is the OTHER half of L9_latin_gap in Group 1; kept as a separate row here because it\'s what "does relaxing cjkOnly help" gets scored against directly.'
);

// ─── Write ───────────────────────────────────────────────────────────────

const groundTruth = {
  _meta: {
    description: 'HOOK text-cleaning ground truth — garbage in, clean text out, exact match (no ambiguity, unlike the Context Memory bench\'s assertions). Three groups: (1) Luna Translator\'s 5 canonical HOOK dedup patterns isolated, (2) regressions that must survive on both routes unchanged, (3) gaps that differ by underlying mechanism (3a: route-wiring gap, fixed by Fase 1 consolidation; 3b: cjkOnly-restriction gap, only fixable by Fase 3 relaxing it, and only if it does not break group 2).',
    routes: ['tcp', 'launcher'],
    routesNote: 'Each entry is run through BOTH composed routes (cleanViaTcpRoute, cleanViaLauncherRoute in scripts/lib/hook-cleaning-snapshot.js). Entries with a real Textractor hook prefix in `input` should set `hookPrefixed: true` so the bench knows to pass it through as-is for the TCP route and strip it before the launcher route (which never sees the prefix in production — the launcher parses it separately, see textractor-launcher.js\'s _parseHookLine).'
  },
  entries
};

const outPath = path.join(__dirname, '..', 'hook-cleaning-ground-truth.json');
fs.writeFileSync(outPath, JSON.stringify(groundTruth, null, 2) + '\n', 'utf8');
console.log(`Wrote ${entries.length} entries to ${outPath}`);

// Self-check: run each entry through both routes against TODAY's production
// snapshot and report pass/fail per route. This is documentation, not a
// gate — several rows (L10/L11/L12, G3a, G3b, L9_latin_gap) are SUPPOSED to
// fail today by design (that's the whole point of Fase 0). Printing this
// here means the corpus's own generation log is the record of which rows
// were red on day one, instead of me asserting it separately by hand.
console.log('\nSelf-check against current production snapshot (informational):');
for (const e of entries) {
  const tcpInput = e.hookPrefixed ? e.input : '[0x1:1:T] ' + e.input;
  const tcpOut = snapshot.cleanViaTcpRoute(tcpInput);
  const launcherInput = e.hookPrefixed ? e.input.replace(/^\[0x[0-9A-Fa-f]+:\d+:[^\]]*\]\s*/, '') : e.input;
  const launcherOut = snapshot.cleanViaLauncherRoute(launcherInput);
  const tcpPass = tcpOut === e.expected;
  const launcherPass = launcherOut === e.expected;
  const mark = (b) => b ? 'PASS' : 'FAIL';
  console.log(`  [G${e.group}] ${e.id.padEnd(28)} tcp=${mark(tcpPass)} launcher=${mark(launcherPass)}` +
    (!tcpPass ? `  tcp->${JSON.stringify(tcpOut)}` : '') +
    (!launcherPass ? `  launcher->${JSON.stringify(launcherOut)}` : ''));
}
