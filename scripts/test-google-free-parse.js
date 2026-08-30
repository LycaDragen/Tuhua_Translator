/**
 * google-free.js response-parsing bench — v1.0.6.
 *
 * The bug (real 2026-08-30 log): Google hands back HTML-escaped text and
 * nothing decoded it, so
 *
 *   "I don't know what's going on right now."
 *      → &quot;No sé qué está pasando ahora&quot;.
 *
 * landed on the overlay entity-and-all. This is not a google-free-only
 * problem: google-free is the last link of every engine's FALLBACK_CHAIN
 * (pipeline.js), so any engine failure funnels users straight into it —
 * which is exactly how that log got there, via a 401 on the LLM engine.
 *
 * Checks run against the REAL engine object, on both parse paths, with
 * captured-shape payloads — no network, no key. The two `-path-` checks are
 * the ones that fail if the decode call is dropped from a call site while
 * _decodeEntities() itself stays correct.
 *
 *   node scripts/test-google-free-parse.js
 *   node scripts/test-google-free-parse.js --quiet
 */
const path = require('path');
const GoogleFreeEngine = require(path.join('..', 'src', 'services', 'translation', 'engines', 'google-free.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const engine = new GoogleFreeEngine();

// Shape of a real translate_a/single body: [[[translated, original, …], …], …, detectedLang]
const apiBody = (segments, detected) => [segments.map((s) => [s, 'src', null, null, 10]), null, detected];
const webPage = (inner) => `<html><body><div class="result-container">${inner}</div></body></html>`;

const eq = (actual, expected) => ({ pass: actual === expected, actual, expected });

// ─── The reported bug, on both paths ──────────────────────────────────────
check('the-reported-bug-api-path-decodes-quot', () => {
  const parsed = engine._parseApiResponse(apiBody(['&quot;No sé qué está pasando ahora&quot;.'], 'en'), 'auto');
  return eq(parsed && parsed.text, '"No sé qué está pasando ahora".');
}, 'Log 2026-08-30 00:34:08 — the exact line the user saw, verbatim.');

check('the-reported-bug-web-path-decodes-quot', () => {
  return eq(engine._parseWebHtml(webPage('&quot;No sé qué está pasando ahora&quot;.')), '"No sé qué está pasando ahora".');
}, 'The /m scrape captures raw page HTML with ([^<]*), so decoding is the only thing between page source and overlay.');

// ─── The decoder itself ───────────────────────────────────────────────────
check('decodes-the-named-entities-google-actually-emits', () => {
  return eq(engine._decodeEntities('&quot;A&quot; &amp; &apos;B&apos; &lt;tag&gt;&nbsp;end'), '"A" & \'B\' <tag> end');
});

check('decodes-decimal-and-hex-numeric-entities', () => {
  return eq(engine._decodeEntities('caf&#233; &#x2014; &#128512;'), 'café — 😀');
}, 'Astral code points too (emoji): fromCodePoint, not fromCharCode.');

check('single-pass-does-not-double-decode-an-escaped-ampersand', () => {
  return eq(engine._decodeEntities('&amp;quot;'), '&quot;');
}, 'A text that genuinely CONTAINS the string &quot; must survive as such — a second decoding pass would turn it into a bare quote.');

check('text-without-entities-is-returned-untouched', () => {
  const s = 'Ulric: Únete al club. ¡No es que hubiéramos anticipado esto!';
  return eq(engine._decodeEntities(s), s);
});

check('a-lone-ampersand-and-unknown-entities-are-left-alone', () => {
  return eq(engine._decodeEntities('Tom & Jerry &unknown; 100% &#;'), 'Tom & Jerry &unknown; 100% &#;');
}, 'Never invent characters: anything not in the table stays literal.');

check('a-surrogate-half-entity-is-left-literal-instead-of-throwing', () => {
  return eq(engine._decodeEntities('&#xD800;'), '&#xD800;');
}, 'String.fromCodePoint throws on lone surrogates — a malformed page must not take the translation down.');

check('non-string-input-does-not-throw', () => {
  const out = [engine._decodeEntities(null), engine._decodeEntities(undefined), engine._decodeEntities('')];
  return { pass: out[0] === null && out[1] === undefined && out[2] === '', actual: out };
});

// ─── Everything the parse paths did before, still intact ──────────────────
check('api-path-still-concatenates-every-segment-in-order', () => {
  const parsed = engine._parseApiResponse(apiBody(['Se aleja por unos momentos ', 'e inspecciona el suelo.'], 'en'), 'auto');
  return eq(parsed && parsed.text, 'Se aleja por unos momentos e inspecciona el suelo.');
}, 'Google splits long lines into several segments — the multi-segment join predates this bench and must not regress.');

check('api-path-still-reports-the-detected-language', () => {
  const parsed = engine._parseApiResponse(apiBody(['hola'], 'en'), 'auto');
  return eq(parsed && parsed.detectedLang, 'en');
});

check('api-path-omits-detected-language-when-it-equals-the-requested-one', () => {
  const parsed = engine._parseApiResponse(apiBody(['hola'], 'en'), 'en');
  return eq(parsed && parsed.detectedLang, null);
});

check('api-path-returns-null-on-an-unparseable-body', () => {
  const bad = [engine._parseApiResponse(null, 'auto'), engine._parseApiResponse('<html>Sorry...</html>', 'auto'), engine._parseApiResponse([[], null, 'en'], 'auto')];
  return { pass: bad.every((b) => b === null), actual: bad };
}, 'Google answers a rate-limited IP with an HTML captcha page — that must stay a thrown "Could not parse" in the caller, which is what triggers the /m fallback.');

check('web-path-returns-null-when-the-page-shape-changed', () => {
  const bad = [engine._parseWebHtml('<html>no result container here</html>'), engine._parseWebHtml(null)];
  return { pass: bad.every((b) => b === null), actual: bad };
});

run('google-free.js parsing bench', CHECKS);
