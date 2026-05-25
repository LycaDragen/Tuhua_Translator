/**
 * Clipboard Watcher Service
 * Monitors the system clipboard for text changes and emits them.
 * Supports deduplication and configurable polling interval.
 */
const { clipboard } = require('electron');
const EventEmitter = require('events');
const crypto = require('crypto');

class ClipboardWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.interval = options.interval || 500; // ms between checks
    this.timer = null;
    this.lastHash = '';
    this.isWatching = false;
    this.lastText = '';
  }

  start() {
    if (this.isWatching) return;
    this.isWatching = true;
    this.lastHash = '';

    this.timer = setInterval(() => {
      try {
        const text = clipboard.readText();
        if (!text || text.length < 2) return;

        const hash = crypto.createHash('md5').update(text).digest('hex');
        if (hash !== this.lastHash) {
          this.lastHash = hash;
          this.lastText = text;
          this.emit('text', text);
        }
      } catch (e) {
        // Clipboard might be temporarily unavailable
      }
    }, this.interval);

    this.emit('status', 'watching');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isWatching = false;
    this.emit('status', 'stopped');
  }

  getLastText() {
    return this.lastText;
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
