/**
 * Context Memory — a rolling window of recent {source, translation} pairs,
 * owned by the pipeline and shared by every engine.
 *
 * v3.13.16-18's Context History existed inside each engine (deepl/openai/
 * local-llm) instead of here, which meant the pipeline's cache/translation-
 * memory short-circuits (exact-match hits never call the engine) silently
 * skipped the context push, and nothing anywhere ever called the engines'
 * clearContext(). Centralizing ownership fixes both by construction: the
 * pipeline pushes here from the single place _doTranslate() resolves a
 * translation (cache hit, TM hit, or live engine call alike), and reset is
 * one call regardless of which engine is active.
 */
class ContextMemory {
  constructor(maxSize = 5) {
    this.maxSize = Math.max(0, maxSize);
    this.entries = [];
  }

  // v3.13.6x (Fase 9 testing follow-up, ronda 6): replace-and-promote instead
  // of a bare append. Real bug found testing prompt presets: retranslating
  // the SAME line N times (exactly what comparing presets via the ↻ button
  // does) used to leave N duplicate {source, translation} pairs in the
  // window — with maxSize=5, five retranslates evicted every OTHER line of
  // real context and left the window as five copies of one pair. Combined
  // with getExcluding() below (not always enough on its own — a single
  // stale copy is already the poisoning case, see there), this also makes
  // the window hold up to maxSize DISTINCT lines instead of maxSize EVENTS,
  // which is what a "recent lines for continuity" window is supposed to be.
  push(source, translation) {
    if (this.maxSize === 0) return;
    const existingIdx = this.entries.findIndex((e) => e.source === source);
    if (existingIdx !== -1) this.entries.splice(existingIdx, 1);
    this.entries.push({ source, translation });
    while (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  /** Returns the current window as [{source, translation}], oldest first. */
  get() {
    return this.entries.slice();
  }

  // v3.13.6x (Fase 9 testing follow-up, ronda 6): the actual fix for the
  // real bug behind "changing the prompt preset doesn't change the
  // translation" — verified over 3 real testing sessions plus a dedicated
  // experiment (scripts/test-context-memory.js --mode=preset-divergence)
  // against a real LLM. Every resolution path in pipeline.js's
  // _doTranslate() pushes (cacheKey, result) into this window BEFORE
  // returning, including a fresh engine call — so retranslating line X
  // shows the SECOND request a prompt that literally contains
  // "X → <X's own previous translation>" under a header that says "recent
  // lines for continuity, do not re-translate them", plus a rule telling
  // the model to stay consistent with them. That isn't a bias toward the
  // old answer, it's an answer key with a copy instruction attached — the
  // model reproducing it byte-for-byte across 4 different prompt presets
  // and a hand-written custom template is the EXPECTED result of that
  // prompt, not a mystery. `_tryEngine()` in pipeline.js is the only
  // caller — it must ask for the window excluding whatever it's currently
  // about to ask the model to translate.
  //
  // Exact string equality only, deliberately not fuzzy: a near-identical
  // prior line (OCR jitter, a retry with slightly cleaned text) is
  // legitimate context a human reader would want kept, not a duplicate to
  // silently drop — fuzzy-excluding it would trade a rare, subtle
  // over-inclusion bug for a rare, subtle under-inclusion one, with no net
  // gain. If OCR noise turns out to need this later, it should be a
  // decision made with real false-negative examples in hand, not a
  // speculative widening here.
  getExcluding(source) {
    return this.entries.filter((e) => e.source !== source).map((e) => ({ ...e }));
  }

  clear() {
    this.entries = [];
  }

  resize(maxSize) {
    this.maxSize = Math.max(0, maxSize);
    while (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  get size() {
    return this.entries.length;
  }
}

module.exports = ContextMemory;
