/**
 * Textractor TCP Connector (Improved)
 * - Reconnection with exponential backoff
 * - Message boundary handling (null-terminated UTF-16LE)
 * - Text deduplication with hash
 * - Configurable timeouts
 * - Proper cleanup on disconnect
 */
const net = require('net');
const EventEmitter = require('events');
const crypto = require('crypto');

class TextractorConnector extends EventEmitter {
  constructor(port = 5000, host = '127.0.0.1') {
    super();
    this.port = port;
    this.host = host;
    this.client = null;
    this.isConnected = false;
    this.isDestroyed = false;
    this.isConnecting = false;  // Track whether socket.connect() is in progress
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 15;  // Stop trying after 15 attempts (~2 minutes)
    this.maxReconnectDelay = 30000;
    this.baseReconnectDelay = 1000;
    this.lastTextHash = '';
    this.buffer = Buffer.alloc(0);

    this._createSocket();
  }

  _createSocket() {
    this.client = new net.Socket();
    this.client.setKeepAlive(true, 10000);
    this.client.setTimeout(0); // No idle timeout for persistent connections

    this.client.on('connect', () => {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.emit('status', 'connected');
    });

    this.client.on('data', (data) => {
      this._processData(data);
    });

    this.client.on('close', (hadError) => {
      this.isConnected = false;
      this.isConnecting = false;
      this.emit('status', 'disconnected');
      if (!this.isDestroyed) {
        this._scheduleReconnect();
      }
    });

    this.client.on('error', (err) => {
      this.isConnected = false;
      this.isConnecting = false;
      // EISCONN means we tried to connect a socket that's already connected.
      // This is harmless — just log and ignore, don't emit as an error.
      if (err.code === 'EISCONN') {
        console.log('[Textractor] EISCONN — socket already connected, ignoring');
        this.isConnected = true;
        return;
      }
      this.emit('error', err);
    });

    this.client.on('timeout', () => {
      this.emit('status', 'timeout');
    });
  }

  connect() {
    if (this.isDestroyed) return;
    if (this.isConnected) return;
    // Don't call connect() if a connection attempt is already in progress.
    // This prevents EISCONN errors when multiple connect() calls overlap.
    if (this.isConnecting) return;

    // Check if the socket is already connected or connecting before calling connect()
    if (this.client && !this.client.destroyed) {
      const state = this.client.readyState;
      if (state === 'open' || state === 'opening') {
        // Socket is already connected or connecting — skip
        this.isConnected = (state === 'open');
        this.isConnecting = (state === 'opening');
        return;
      }
    }

    try {
      this.isConnecting = true;
      this.client.connect(this.port, this.host);
    } catch (err) {
      this.isConnecting = false;
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this.isDestroyed = true;
    this._clearReconnect();
    if (this.client) {
      try {
        this.client.destroy();
      } catch (e) {
        // Ignore
      }
    }
    this.isConnected = false;
    this.emit('status', 'disconnected');
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.isDestroyed) return;

    // Stop reconnecting after max attempts — no server is listening.
    // This prevents infinite reconnection loops when TextractorCLI isn't running.
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log(`[Textractor] Max reconnect attempts (${this.maxReconnectAttempts}) reached — stopping`);
      this.emit('status', 'disconnected');
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;
    this.emit('status', 'reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, delay);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Process incoming TCP data from Textractor.
   * Textractor sends null-terminated UTF-16LE strings.
   * Each message ends with \0\0 (null terminator in UTF-16LE).
   *
   * Messages from Textractor's "Start Server" extension have the format:
   *   [HookAddr:ThreadNum:ThreadName] Extracted text
   * We strip the hook prefix before emitting 'text' so the translation
   * pipeline only receives the actual game text.
   */
  _processData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    // Try to find message boundaries (null-terminated UTF-16LE)
    while (this.buffer.length >= 2) {
      // Look for double null (UTF-16LE null terminator)
      let nullIndex = -1;
      for (let i = 0; i < this.buffer.length - 1; i += 2) {
        if (this.buffer[i] === 0x00 && this.buffer[i + 1] === 0x00) {
          nullIndex = i;
          break;
        }
      }

      if (nullIndex === -1) {
        // No complete message yet, prevent buffer from growing unbounded
        if (this.buffer.length > 65536) {
          this.buffer = this.buffer.slice(this.buffer.length - 4096);
        }
        break;
      }

      const messageBuffer = this.buffer.slice(0, nullIndex);
      this.buffer = this.buffer.slice(nullIndex + 2);

      if (messageBuffer.length > 0) {
        try {
          const rawText = messageBuffer.toString('utf16le').trim();
          if (rawText.length > 1) {
            // Strip the hook prefix: [0xABCDEF00:1:HookName] actual text
            const gameText = this._stripHookPrefix(rawText);
            if (gameText && gameText.length > 1) {
              const hash = crypto.createHash('md5').update(gameText).digest('hex');
              if (hash !== this.lastTextHash) {
                this.lastTextHash = hash;
                console.log(`[Textractor] TCP text: "${gameText.substring(0, 60)}..."`);
                this.emit('text', gameText);
              } else {
                console.log(`[Textractor] TCP dedup skip: "${gameText.substring(0, 40)}..."`);
              }
            } else if (gameText === null) {
              // Hook prefix matched but no game text after it — likely a status message
              console.log(`[Textractor] TCP status message: "${rawText.substring(0, 60)}"`);
            } else {
              // No hook prefix — could be a raw text message or system message
              // Emit it as-is for compatibility (some Textractor versions send raw text)
              const hash = crypto.createHash('md5').update(rawText).digest('hex');
              if (hash !== this.lastTextHash) {
                // Only emit if it looks like actual text (has CJK or is long enough)
                const hasCJK = /[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(rawText);
                if (hasCJK || rawText.length >= 4) {
                  this.lastTextHash = hash;
                  console.log(`[Textractor] TCP raw text: "${rawText.substring(0, 60)}..."`);
                  this.emit('text', rawText);
                }
              }
            }
          }
        } catch (e) {
          this.emit('error', e);
        }
      }
    }
  }

  /**
   * Strip the Textractor hook prefix from a message.
   * Format: [0xABCDEF00:1:HookName] actual game text
   * Returns the game text after the ], or null if it was a status/hook-only message.
   * If no hook prefix is found, returns null (indicating this isn't a standard hook message).
   */
  _stripHookPrefix(text) {
    // Match [hex:digit:name] prefix
    const hookMatch = text.match(/^\[0x[0-9A-Fa-f]+:\d+:[^\]]*\]\s*(.*)$/);
    if (hookMatch) {
      const gameText = hookMatch[1].trim();
      // Filter out empty or noise text after the hook prefix
      if (!gameText) return null;
      // Filter pure hex/numeric, separators, or Textractor internal messages
      if (/^[0-9A-Fa-f\s]+$/.test(gameText)) return null;
      if (/^[-=_*#.\s]+$/.test(gameText)) return null;
      if (gameText.includes('Textractor') && gameText.length < 30) return null;
      return gameText;
    }
    // No hook prefix found
    return null;
  }

  /**
   * Reconfigure connection parameters.
   * Always attempts to connect after reconfiguration, even if previously disconnected,
   * because a port change means the user wants to connect to a new endpoint.
   */
  reconfigure(port, host) {
    this.disconnect();

    this.port = port || this.port;
    this.host = host || this.host;
    this.isDestroyed = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.buffer = Buffer.alloc(0);
    this.lastTextHash = '';

    this._createSocket();

    // Always try to connect after reconfiguration
    this.connect();
  }
}

module.exports = TextractorConnector;
