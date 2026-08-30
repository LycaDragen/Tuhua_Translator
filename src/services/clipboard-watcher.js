/**
 * Clipboard Watcher Service
 * Monitors the system clipboard for text changes and emits them.
 * Supports deduplication and configurable polling interval.
 */
const { clipboard } = require('electron');
const EventEmitter = require('events');
const crypto = require('crypto');

const hashText = (text) => crypto.createHash('md5').update(text).digest('hex');

class ClipboardWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.interval = options.interval || 500; // ms between checks
    this.timer = null;
    this.lastHash = '';
    this.isWatching = false;
    this.lastText = '';
    // v1.0.6: one-shot "absorb this without translating it" slot — see
    // ignoreNext() below.
    this._ignoreHash = null;
    // v1.0.6: injectable reader — the only Electron dependency in this file,
    // so the bench (scripts/test-clipboard-watcher.js) can drive real start()/
    // _tick() calls against a fake clipboard instead of re-modelling them.
    this._read = options.readClipboard || (() => clipboard.readText());
  }

  start() {
    if (this.isWatching) return;
    this.isWatching = true;

    // v1.0.6: SEED the hash with whatever is already in the clipboard,
    // instead of the `this.lastHash = ''` that used to be here. With the
    // reset, the very first tick after start() always saw "a hash that
    // differs from ''" and emitted stale content the user never copied for
    // Tuhua — found in a real 2026-08-30 log, where the same old text got
    // re-translated three times in three minutes, each time exactly 500ms
    // (one polling interval) after `[Clipboard] Status: watching`:
    //
    //   00:35:37.049 watching  →  00:35:37.552 translate (same old text)
    //   00:38:17.796 watching  →  00:38:18.297 translate (same old text)
    //   00:38:50.637 watching  →  00:38:51.139 translate (same old text)
    //
    // Three ways this fires in normal use, all of them wrong:
    //  - toggling ▶/⏸ (stop() + start()) re-translates the last line;
    //  - setInterval() below restarts the watcher, so merely changing the
    //    polling interval in settings re-translates too;
    //  - launching Tuhua in clipboard mode (src/main/index.js calls start()
    //    at boot) translates whatever the user copied BEFORE opening the
    //    app — a URL, a password, or, as in that log, Tuhua's own debug
    //    logs straight from the "Copiar logs" button, which then also
    //    poison the context window and the Translation Memory.
    // The cost is one line: whatever was copied BEFORE activating is never
    // translated, and copying it again changes nothing (same content, same
    // hash) — the user has to advance to the next line. Ctrl+Shift+R is NOT
    // a workaround for this: it re-translates `_lastHandledText`, the last
    // line Tuhua already received, and never reads the clipboard
    // (see ipc-handlers.js's _retranslateCurrent). That trade is worth it
    // against re-translating a stale line on every ▶/⏸ toggle, on every
    // polling-interval change, and on every launch.
    this.lastHash = this._currentHash();

    this.timer = setInterval(() => this._tick(), this.interval);

    this.emit('status', 'watching');
  }

  /**
   * v1.0.6: hash of the clipboard right now, or '' if it can't be read.
   * Falling back to '' reproduces the old start() behavior for that one
   * edge case (clipboard unavailable), which is the safe direction: at
   * worst the next tick emits, exactly as before.
   * @private
   */
  _currentHash() {
    try {
      const text = this._read();
      return text ? hashText(text) : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * v1.0.6: Tuhua is about to put `text` on the clipboard itself (today:
   * the "Copiar logs" button, see ipc-handlers.js's get-debug-logs) — take
   * it as already seen instead of translating it. Deliberately a one-shot
   * single slot: it absorbs exactly that one write and nothing else, so a
   * game line that happens to arrive first is still translated normally.
   * @param {string} text — the exact text about to be copied
   */
  ignoreNext(text) {
    this._ignoreHash = text ? hashText(text) : null;
  }

  /**
   * v1.0.6: one polling step. Extracted from the setInterval body (behavior
   * unchanged) so the bench can drive it deterministically instead of
   * sleeping on real timers.
   * @private
   */
  _tick() {
    try {
      const text = this._read();
      if (!text || text.length < 2) return;

      const hash = hashText(text);

      // v1.0.6: Tuhua's own clipboard write (see ignoreNext) — record it as
      // seen so the NEXT line still dedups against it, but emit nothing.
      if (this._ignoreHash && hash === this._ignoreHash) {
        this._ignoreHash = null;
        this.lastHash = hash;
        this.lastText = text;
        return;
      }

      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.lastText = text;
        this.emit('text', text);
      }
    } catch (e) {
      // Clipboard might be temporarily unavailable
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isWatching = false;
    this.emit('status', 'stopped');
  }

  setInterval(ms) {
    this.interval = Math.max(200, ms); // Minimum 200ms
    if (this.isWatching) {
      this.stop();
      this.start();
    }
  }
}

module.exports = ClipboardWatcher;
