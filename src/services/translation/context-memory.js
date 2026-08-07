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

  push(source, translation) {
    if (this.maxSize === 0) return;
    this.entries.push({ source, translation });
    while (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  /** Returns the current window as [{source, translation}], oldest first. */
  get() {
    return this.entries.slice();
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
