/**
 * renderer.js toast bench — v1.0.6.
 *
 * Two defects from the same real 2026-08-30 session, both in the notice a
 * user gets when their translation engine fails:
 *
 *  1. FLOOD. Since v3.13.41 a toast stays until the user closes it, and the
 *     fallback notice fires once per translated line — so one wrong API key
 *     buried the window under one identical, persistent toast per line
 *     (~8 in five minutes in that log). Same flood 35e1616 removed from the
 *     opacity notice, arriving through a different door.
 *  2. NO REASON. The toast said the primary engine had failed but never
 *     why, while the log had the answer all along ("HTTP 401: Invalid
 *     Anthropic API Key").
 *
 * renderer.js is browser-side code with no exports, so these checks pull
 * the two real functions out of the file by name and run them against a
 * minimal fake DOM — no Electron, no jsdom, and, crucially, no second copy
 * of the logic that could pass while the shipped one is broken.
 *
 *   node scripts/test-toast-notices.js
 *   node scripts/test-toast-notices.js --quiet
 */
const fs = require('fs');
const path = require('path');

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'main', 'renderer.js'), 'utf8');

const { extractFunction, makeDocument } = require('./lib/renderer-harness.js');

// v1.0.7: el extractor de funciones y el DOM falso viven ahora en
// lib/renderer-harness.js — los comparte test-model-suggestions.js.

function makeHarness() {
  const document = makeDocument();
  const showToast = new Function('document', 'setTimeout',
    `${extractFunction(rendererSrc, 'showToast')}; return showToast;`)(document, setTimeout);

  const container = () => document.getElementById('tuhua-toast-container');
  const texts = () => (container() ? container().children.map((t) => t.querySelector('.tuhua-toast-text').textContent) : []);
  return { document, showToast, container, texts };
}

/** updateLiveTranslation() with its collaborators stubbed out. */
function makeFallbackNotice(langPack) {
  const shown = [];
  const fn = new Function('translations', 'currentLang', 'showToast', 'updateTargetLangDisplay', 'loadHistory',
    `${extractFunction(rendererSrc, 'updateLiveTranslation')}; return updateLiveTranslation;`
  )({ en: langPack }, 'en', (m) => shown.push(m), () => {}, () => {});
  return { fn, shown };
}

// ─── Flood ───────────────────────────────────────────────────────────────
check('the-reported-flood-an-identical-message-collapses-into-one-toast', () => {
  const h = makeHarness();
  for (let i = 0; i < 8; i++) h.showToast('Primary translation engine failed, using fallback (openai→google-free)');
  return { pass: h.container().children.length === 1, actual: { toasts: h.container().children.length, texts: h.texts() } };
}, 'Eight translated lines with a dead API key = eight identical toasts before this, none of which auto-dismiss.');

check('the-collapsed-toast-counts-the-repeats', () => {
  const h = makeHarness();
  h.showToast('same');
  h.showToast('same');
  h.showToast('same');
  return { pass: h.texts()[0] === 'same (×3)', actual: h.texts() };
}, 'Silently dropping the repeat would hide that the problem is STILL happening — the count is the point.');

check('different-messages-still-stack-separately', () => {
  const h = makeHarness();
  h.showToast('first');
  h.showToast('second');
  return { pass: h.container().children.length === 2, actual: h.texts() };
}, 'v3.13.6x deliberately replaced the single-slot toast with a stack — dedup must not undo that.');

check('newest-first-order-is-preserved', () => {
  const h = makeHarness();
  h.showToast('older');
  h.showToast('newer');
  return { pass: h.texts()[0] === 'newer', actual: h.texts() };
}, 'column-reverse container: the newest toast is prepended so it lands in the bottom slot.');

check('a-repeat-of-a-message-that-is-no-longer-the-newest-still-collapses', () => {
  const h = makeHarness();
  h.showToast('fallback notice');
  h.showToast('an unrelated notice');
  h.showToast('fallback notice');
  return { pass: h.container().children.length === 2 && h.texts().includes('fallback notice (×2)'), actual: h.texts() };
}, 'The real sequence is interleaved: fallback toasts arrive between other notifications, so dedup keys on the message, not on "was it the last one".');

check('two-different-failure-reasons-are-two-different-toasts', () => {
  const h = makeHarness();
  h.showToast('fallback (openai→google-free) — HTTP 401: Invalid Anthropic API Key');
  h.showToast('fallback (openai→google-free) — HTTP 429: rate limit reached');
  return { pass: h.container().children.length === 2, actual: h.texts() };
}, 'Dedup keys on the FULL message, reason included — a key problem turning into a rate-limit problem must be visible.');

check('closing-a-toast-removes-it-and-a-later-repeat-starts-a-fresh-one', async () => {
  const h = makeHarness();
  h.showToast('closable');
  h.showToast('closable');
  const toast = h.container().children[0];
  const closeBtn = toast.children.find((c) => c.tagName === 'button');
  closeBtn.onclick();
  await new Promise((r) => setTimeout(r, 250)); // the 150ms fade-out timeout
  const goneAfterClose = h.container() === null;
  h.showToast('closable');
  return { pass: goneAfterClose && h.texts()[0] === 'closable', actual: { goneAfterClose, texts: h.texts() } };
}, 'The counter lives on the DOM node, so dismissing really resets it — the user gets a visible new notice if it happens again.');

// ─── Reason ──────────────────────────────────────────────────────────────
const LANG = {
  translation_fallback_toast: 'Falló el motor principal, usando alternativo ({engine})',
  translation_failed_toast: 'Falló la traducción: {error}'
};

check('the-reported-gap-the-fallback-toast-now-says-why', () => {
  const n = makeFallbackNotice(LANG);
  n.fn({ isFallback: true, engine: 'openai→google-free', fallbackReason: 'HTTP 401: Invalid Anthropic API Key' });
  const expected = 'Falló el motor principal, usando alternativo (openai→google-free) — HTTP 401: Invalid Anthropic API Key';
  return { pass: n.shown[0] === expected, actual: n.shown, expected };
}, 'pipeline.js has emitted fallbackReason since v1.0.6 — this is the half that puts it in front of the user.');

check('a-fallback-without-a-reason-keeps-the-old-toast-exactly', () => {
  const n = makeFallbackNotice(LANG);
  n.fn({ isFallback: true, engine: 'openai→google-free' });
  return { pass: n.shown[0] === 'Falló el motor principal, usando alternativo (openai→google-free)', actual: n.shown };
}, 'No dangling "— " when the engine failed without an HTTP body to quote (a timeout, say).');

check('a-normal-translation-shows-no-toast', () => {
  const n = makeFallbackNotice(LANG);
  n.fn({ engine: 'openai', translated: 'hola' });
  return { pass: n.shown.length === 0, actual: n.shown };
});

run('renderer.js toast notices bench', CHECKS);
