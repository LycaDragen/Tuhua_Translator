/**
 * IpcHandlers#_handleSetOcrEngine bench — pins a real regression
 * (session90.log, fixed in v3.13.115, extracted for testability in
 * v3.13.116). Same technique scripts/test-glossary-merge.js already uses
 * for GlossaryService.prototype._applyEntry: call the real method off the
 * bare prototype with `.call(fakeThis, ...)`, no Electron/IPC/real
 * OcrService needed — confirmed requireable from plain Node (ipc-
 * handlers.js's top-level `require('electron')` destructures to
 * `undefined` fields outside an Electron process, which is fine since
 * this method never touches them).
 *
 * The bug: switching the OCR engine (Settings dropdown, tesseract↔paddle)
 * while OCR was already running only flipped OcrService's internal flag —
 * it never (re)initialized the worker/session for the newly selected
 * engine. The next capture threw "OCR worker not initialized. Call
 * initialize() first." Reproduced live: Lyca ran PaddleOCR successfully,
 * switched to Tesseract, and every subsequent capture failed until the
 * app was restarted.
 *
 *   node scripts/test-ocr-engine-switch.js
 *   node scripts/test-ocr-engine-switch.js --quiet
 */
const path = require('path');
const IpcHandlers = require(path.join('..', 'src', 'main', 'ipc-handlers.js'));
const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

/**
 * Minimal fake standing in for the real IpcHandlers instance — only the
 * fields _handleSetOcrEngine actually touches. `calls` records every
 * interaction in order so a test can assert not just "was X called" but
 * "was X called, and in what order relative to Y".
 */
function makeFakeThis({ ocrActive = false, sourceLang = 'ja', throwOnSetEngine = null } = {}) {
  const calls = [];
  const storeData = { ocrEngine: 'tesseract', sourceLang };
  let currentEngine = 'tesseract';
  return {
    _ocrActive: ocrActive,
    _calls: calls,
    ocrService: {
      setOcrEngine(engine) {
        calls.push({ fn: 'setOcrEngine', engine });
        if (throwOnSetEngine) throw new Error(throwOnSetEngine);
        currentEngine = engine;
      },
      getOcrEngine() {
        return currentEngine;
      },
      async initialize(lang) {
        calls.push({ fn: 'initialize', lang, engineAtCallTime: currentEngine });
      }
    },
    store: {
      set(key, value) {
        calls.push({ fn: 'store.set', key, value });
        storeData[key] = value;
      },
      get() {
        return { ...storeData };
      }
    }
  };
}

check('ocr-inactive-only-flips-the-engine-flag-never-touches-initialize', () => {
  const fake = makeFakeThis({ ocrActive: false });
  return IpcHandlers.prototype._handleSetOcrEngine.call(fake, 'paddle').then((result) => {
    const initCalls = fake._calls.filter((c) => c.fn === 'initialize');
    return {
      pass: result.success === true && initCalls.length === 0,
      actual: { result, calls: fake._calls }
    };
  });
}, 'Picking an engine from Settings while OCR is not the active input method must not eagerly load PaddleOCR/download models.');

check('ocr-active-reinitializes-the-newly-selected-engine', () => {
  // THE REGRESSION: OCR already running (as if PaddleOCR had just
  // finished a successful capture cycle), user switches to tesseract.
  const fake = makeFakeThis({ ocrActive: true, sourceLang: 'en' });
  return IpcHandlers.prototype._handleSetOcrEngine.call(fake, 'tesseract').then((result) => {
    const initCalls = fake._calls.filter((c) => c.fn === 'initialize');
    return {
      pass: result.success === true && initCalls.length === 1 && initCalls[0].lang === 'en' && initCalls[0].engineAtCallTime === 'tesseract',
      actual: { result, calls: fake._calls }
    };
  });
}, 'This exact scenario ("OCR worker not initialized") reached real users — session90.log.');

check('initialize-is-called-with-the-NEW-engine-already-set-not-the-old-one', () => {
  // Ordering matters: initialize() must see the post-switch engine so
  // OcrService.initialize()'s own `if (this._ocrEngine === 'paddle')`
  // dispatch picks the engine the user actually asked for.
  const fake = makeFakeThis({ ocrActive: true });
  return IpcHandlers.prototype._handleSetOcrEngine.call(fake, 'paddle').then(() => {
    const setEngineIdx = fake._calls.findIndex((c) => c.fn === 'setOcrEngine');
    const initIdx = fake._calls.findIndex((c) => c.fn === 'initialize');
    return {
      pass: setEngineIdx !== -1 && initIdx !== -1 && setEngineIdx < initIdx && fake._calls[initIdx].engineAtCallTime === 'paddle',
      actual: fake._calls
    };
  });
});

check('defaults-to-ja-when-no-sourceLang-is-persisted', () => {
  const fake = makeFakeThis({ ocrActive: true, sourceLang: undefined });
  return IpcHandlers.prototype._handleSetOcrEngine.call(fake, 'tesseract').then(() => {
    const initCall = fake._calls.find((c) => c.fn === 'initialize');
    return { pass: initCall && initCall.lang === 'ja', actual: initCall };
  });
});

check('the-persisted-ocrEngine-setting-is-updated-regardless-of-active-state', () => {
  const fake = makeFakeThis({ ocrActive: false });
  return IpcHandlers.prototype._handleSetOcrEngine.call(fake, 'paddle').then(() => {
    const storeCall = fake._calls.find((c) => c.fn === 'store.set' && c.key === 'ocrEngine');
    return { pass: !!storeCall && storeCall.value === 'paddle', actual: storeCall };
  });
});

check('a-thrown-error-is-caught-and-returned-as-a-failure-result-not-propagated', () => {
  const fake = makeFakeThis({ ocrActive: true, throwOnSetEngine: 'boom' });
  return IpcHandlers.prototype._handleSetOcrEngine.call(fake, 'paddle').then((result) => {
    return { pass: result.success === false && result.error === 'boom', actual: result };
  });
});

run('ipc-handlers.js OCR engine switch bench', CHECKS);
