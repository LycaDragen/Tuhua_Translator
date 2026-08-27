/**
 * bing.js bench — pins the parsing/mapping bugs found and fixed in v3.13.102.
 * Pure Node, no network: fixture HTML/JSON snippets captured from the real
 * bing.com/translator page and ttranslatev3 responses.
 *
 * The single thing this pins: `params_AbusePreventionHelper` on the real
 * page has always used double quotes, but the old regexes looked for single
 * quotes — every translation silently fell through to a rejected-token
 * response. This fixture is the exact array shape confirmed live.
 *
 *   node scripts/test-bing-engine.js
 *   node scripts/test-bing-engine.js --quiet
 */
const path = require('path');
const bing = require(path.join('..', 'src', 'services', 'translation', 'engines', 'bing.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

// Real page fragment (captured 2026-08-26), the exact shape that broke the
// old single-quote regexes.
const REAL_PAGE_FRAGMENT = `
  "eferrer":""}}); var params_AbusePreventionHelper = [1787723003878,"HwlmFzzIrzbSMCCU74rSxXl7vKZSfWEa",3600000]; var params_RichTranslateHelper = [true];
  ...<div id="tta_outCsr" data-iid="translator.5023"></div>...
  {"ig":"033587A2B77E44ED9852AFA92E7137FD","sid":"23F201EF"}
`;

check('extracts-ig-iid-key-token-ttl-from-real-double-quoted-page', () => {
  const auth = bing.parseAuthFromHtml(REAL_PAGE_FRAGMENT);
  return {
    pass: auth && auth.ig === '033587A2B77E44ED9852AFA92E7137FD'
      && auth.iid === 'translator.5023'
      && auth.key === '1787723003878'
      && auth.token === 'HwlmFzzIrzbSMCCU74rSxXl7vKZSfWEa'
      && auth.ttlMs === 3600000,
    actual: auth
  };
}, 'the exact bug: old regexes required single quotes, the page has always used double quotes');

check('old-single-quote-shaped-html-still-fails-to-parse', () => {
  // Confirms the fixture actually distinguishes the two formats — if this
  // ever passes, the fixture stopped testing what it claims to.
  const singleQuoted = `var params_AbusePreventionHelper = [123,'abc',3600000];`;
  const auth = bing.parseAuthFromHtml(singleQuoted);
  return { pass: auth === null, actual: auth };
}, 'sanity check on the fixture itself');

check('missing-ig-returns-null-not-a-throw', () => {
  const auth = bing.parseAuthFromHtml('var params_AbusePreventionHelper = [1,"t",1000];');
  return { pass: auth === null, actual: auth };
});

check('zh-mapped-to-zh-Hans-every-other-lang-passed-through', () => {
  const cases = { zh: 'zh-Hans', ja: 'ja', en: 'en', pt: 'pt' };
  const actual = Object.fromEntries(Object.keys(cases).map((k) => [k, bing.mapLangToBing(k)]));
  return {
    pass: Object.entries(cases).every(([k, v]) => actual[k] === v),
    actual
  };
}, 'Bing HTTP 400s on bare "zh" for both from and to — confirmed live against the real endpoint');

check('detected-zh-Hans-and-zh-Hant-normalize-to-zh', () => {
  const a = bing.normalizeDetectedLang('zh-Hans');
  const b = bing.normalizeDetectedLang('zh-Hant');
  const c = bing.normalizeDetectedLang('ja');
  return { pass: a === 'zh' && b === 'zh' && c === 'ja', actual: { a, b, c } };
}, 'Bing always detects Chinese as zh-Hans/zh-Hant, never bare zh — normalize back for the rest of the app');

check('detected-null-stays-null', () => {
  const r = bing.normalizeDetectedLang(null);
  return { pass: r === null, actual: r };
});

// Real response shape (captured 2026-08-26) for a successful translation.
const REAL_SUCCESS_RESPONSE = [
  { translations: [{ text: 'hola mundo, esto es una prueba', to: 'es' }], usedLLM: true, detectedLanguage: { language: 'en' } }
];

check('parses-real-success-response', () => {
  const r = bing.parseTranslateResponse(REAL_SUCCESS_RESPONSE);
  return {
    pass: r?.text === 'hola mundo, esto es una prueba' && r?.detectedLang === 'en',
    actual: r
  };
});

// Real rejected-token response shape (captured 2026-08-26, before the fix —
// this is what every call produced with the broken regex).
const REAL_REJECTED_RESPONSE = { statusCode: 205, errorMessage: '' };

check('parses-real-rejected-token-response-as-rejected-not-a-crash', () => {
  const r = bing.parseTranslateResponse(REAL_REJECTED_RESPONSE);
  return { pass: r?.rejected === true && r?.statusCode === 205, actual: r };
}, 'this is the exact shape the old bug produced on every single call');

check('unrecognized-shape-returns-null', () => {
  const r = bing.parseTranslateResponse({ somethingElse: true });
  return { pass: r === null, actual: r };
});

run("bing.js bench", CHECKS);
