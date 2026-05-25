/**
 * XUAT (XUnity AutoTranslator) HTTP Translation Server
 *
 * v3.11.17: Added language config update and cache clearing support.
 * v3.11.15: THREE CRITICAL FIXES:
 *           1. pipeline.translateNow() returns a STRING, not an object with .translated.
 *              Previous code did `result.translated` on a string, which is always undefined,
 *              causing the server to ALWAYS return the original untranslated text.
 *           2. Changed response format from JSON to PLAIN TEXT. XUAT's CustomTranslate
 *              endpoint does `context.Complete(context.Response.Data)` where Response.Data
 *              is the raw string body. JSON was being injected literally as the translation.
 *           3. Added 500ms delay after stop() in reconfigure() to let OS release the port.
 * v3.11.11: Updated endpoint info display for Custom endpoint ID
 * v3.11.9: Listen on 0.0.0.0 (all interfaces) instead of 127.0.0.1.
 * v3.11.3: Complete rewrite of server lifecycle management.
 *
 * CRITICAL: XUAT's CustomTranslate endpoint expects PLAIN TEXT responses!
 * NOT JSON! The response MUST be just the translated text as plain text:
 *   Content-Type: text/plain; charset=utf-8
 *   Body: Olá
 *
 * This allows Tuhua to act as a translation backend for Unity games
 * that have XUAT installed via BepInEx.
 */

const http = require('http');
const url = require('url');
const EventEmitter = require('events');

class XuatServer extends EventEmitter {
  /**
   * @param {object} pipeline - Translation pipeline instance
   * @param {number} port - Port to listen on (default 8419)
   */
  constructor(pipeline, port = 8419) {
    super();
    this.pipeline = pipeline;
    this.port = port;
    this.server = null;
    this._running = false;
    this._requestCount = 0;
    this._activeConnections = new Set();

    // v3.11.3: Serial operation queue — ensures only one start/stop/reconfigure
    // operation runs at a time. This completely eliminates race conditions
    // that caused the "Port already in use" crash loop.
    this._operationQueue = Promise.resolve();
  }

  /**
   * Run an operation serially (one at a time).
   * Operations are queued and executed in order.
   * Errors in one operation don't break the chain.
   * @param {Function} fn - Async function to run
   * @returns {Promise<*>}
   * @private
   */
  _serialRun(fn) {
    const op = this._operationQueue.then(() => fn());
    // Prevent chain from breaking on error — catch and swallow
    this._operationQueue = op.catch(() => {});
    return op;
  }

  /**
   * Start the XUAT HTTP server
   * v3.11.3: Serial — waits for any pending stop/reconfigure to complete first
   * @returns {Promise<void>}
   */
  start() {
    return this._serialRun(() => this._doStart());
  }

  /**
   * Internal start implementation (must only be called via _serialRun)
   * @private
   */
  async _doStart() {
    // Already running — nothing to do
    if (this._running && this.server) {
      return;
    }

    try {
      await this._doStartInner();
    } catch (err) {
      // v3.11.3: If port is in use, force-stop and retry ONCE
      if (err.message && err.message.includes('already in use')) {
        console.log('[XUAT] Port in use during start — force-stopping and retrying...');
        await this._doForceStop();
        // Small delay to let OS release the port
        await new Promise(resolve => setTimeout(resolve, 300));
        await this._doStartInner();
      } else {
        throw err;
      }
    }
  }

  /**
   * Inner start logic (creates server, binds to port)
   * @private
   */
  _doStartInner() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this._handleRequest(req, res);
      });

      // Track active connections for clean shutdown
      this.server.on('connection', (socket) => {
        this._activeConnections.add(socket);
        socket.on('close', () => {
          this._activeConnections.delete(socket);
        });
      });

      this.server.on('error', (err) => {
        // Clean up the failed server
        if (this.server) {
          try { this.server.close(); } catch (e) { /* ignore */ }
          this.server = null;
        }
        this._running = false;

        if (err.code === 'EADDRINUSE') {
          console.error(`[XUAT] Port ${this.port} is already in use`);
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          console.error('[XUAT] Server error:', err.message);
          reject(err);
        }
      });

      // v3.11.9: Listen on 0.0.0.0 (all interfaces) instead of 127.0.0.1.
      // On some Windows systems, binding to 127.0.0.1 can cause issues where
      // other processes (like Unity games) cannot connect to the server even
      // though it's on loopback. Binding to 0.0.0.0 ensures the server is
      // reachable on all interfaces, including loopback.
      this.server.listen(this.port, '0.0.0.0', () => {
        this._running = true;
        console.log(`[XUAT] Translation server started on port ${this.port}`);
        console.log(`[XUAT] Endpoint: http://127.0.0.1:${this.port}/translate?text={0}&from={1}&to={2}`);
        this.emit('started', { port: this.port });
        resolve();
      });
    });
  }

  /**
   * Stop the XUAT HTTP server
   * v3.11.3: Serial — waits for any pending start/reconfigure to complete first.
   * Properly waits for the 'close' event before resolving.
   * @returns {Promise<void>}
   */
  stop() {
    return this._serialRun(() => this._doStop());
  }

  /**
   * Internal stop implementation (must only be called via _serialRun)
   * @private
   */
  _doStop() {
    return new Promise((resolve) => {
      if (!this.server) {
        this._running = false;
        resolve();
        return;
      }

      // Destroy all active connections first so server.close()
      // doesn't hang waiting for keep-alive connections to time out
      for (const socket of this._activeConnections) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
      }
      this._activeConnections.clear();

      this.server.close(() => {
        this._running = false;
        this.server = null;
        console.log('[XUAT] Translation server stopped');
        this.emit('stopped');
        resolve();
      });

      // Force stop after 3 seconds if close still hangs
      setTimeout(() => {
        if (this._running && this.server) {
          console.log('[XUAT] Force-stopping server after timeout');
          this._running = false;
          try { this.server.close(); } catch (e) { /* ignore */ }
          this.server = null;
          this.emit('stopped');
          resolve();
        }
      }, 3000);
    });
  }

  /**
   * Force-stop the server unconditionally.
   * v3.11.3: Used for recovery when normal stop fails.
   * Also runs through the serial queue to prevent conflicts.
   * @returns {Promise<void>}
   */
  forceStop() {
    return this._serialRun(() => this._doForceStop());
  }

  /**
   * Internal force-stop implementation
   * @private
   */
  async _doForceStop() {
    console.log('[XUAT] Force-stopping server...');
    this._running = false;

    // Destroy all active connections
    for (const socket of this._activeConnections) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
    }
    this._activeConnections.clear();

    if (this.server) {
      try {
        this.server.unref();
        this.server.close();
      } catch (e) { /* ignore */ }
      this.server = null;
    }

    // Give the OS a moment to release the port
    await new Promise(resolve => setTimeout(resolve, 300));

    this.emit('stopped');
    console.log('[XUAT] Server force-stopped');
  }

  /**
   * Reconfigure the server with a new port
   * v3.11.3: Serial — properly stop before starting on new port
   * @param {number} newPort
   * @returns {Promise<void>}
   */
  async reconfigure(newPort) {
    return this._serialRun(async () => {
      if (this._running) {
        await this._doStop();
        // v3.11.15 FIX: Wait for the OS to release the port after close().
        // Without this delay, the new server immediately tries to listen on
        // the same port and gets EADDRINUSE because the OS hasn't freed it yet.
        console.log('[XUAT] Waiting 500ms for port to be released by OS...');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      this.port = newPort;
      // Always restart after reconfigure (even if _running was false before,
      // reconfigure implies the user wants the server running on the new port)
      await this._doStart();
    });
  }

  /**
   * Get the current server status
   * @returns {object}
   */
  getStatus() {
    return {
      running: this._running,
      port: this.port,
      url: this._running ? `http://127.0.0.1:${this.port}/translate?text={0}&from={1}&to={2}` : null,
      requestCount: this._requestCount
    };
  }

  /**
   * Handle incoming HTTP request
   * @private
   */
  async _handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Status endpoint
    if (pathname === '/status') {
      console.log('[XUAT] Status check received');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'Tuhua Translator', port: this.port }));
      return;
    }

    // Translate endpoint (both /translate and /api/translate)
    if (pathname === '/translate' || pathname === '/api/translate') {
      await this._handleTranslate(parsedUrl.query, res);
      return;
    }

    // Unknown endpoint
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, error: 'Not found' }));
  }

  /**
   * Handle a translation request
   * @private
   */
  async _handleTranslate(query, res) {
    const text = query.text || '';
    const from = query.from || 'ja';
    const to = query.to || 'en';

    if (!text) {
      // XUAT expects a response — return empty string as plain text
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('');
      return;
    }

    this._requestCount++;

    try {
      // Use the translation pipeline directly — XUAT works independently
      // of the main translation toggle so games never hang
      const result = await this.pipeline.translateNow(text, { source: from, target: to });

      // v3.11.15 CRITICAL FIX: pipeline.translateNow() returns a PLAIN STRING,
      // not an object with a .translated property!
      // Previous code: `result && result.translated ? result.translated : text`
      // This always fell through to `text` because strings don't have .translated,
      // causing ALL translations to return the original untranslated text.
      let translatedText;
      if (typeof result === 'string' && result) {
        translatedText = result;
      } else if (result && typeof result === 'object' && result.translated) {
        // Fallback for future versions that might return objects
        translatedText = result.translated;
      } else {
        translatedText = text;
      }

      console.log(`[XUAT] Translated: "${text.substring(0, 50)}" -> "${translatedText.substring(0, 50)}" (${from}->${to})`);

      this.emit('translation-request', {
        original: text,
        translated: translatedText,
        from,
        to,
        success: true
      });

      // CRITICAL: Return PLAIN TEXT, not JSON!
      // XUAT's CustomTranslate uses the raw response body as the translation.
      // If we return JSON, XUAT injects the JSON string as the "translation".
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(translatedText);
    } catch (err) {
      console.error(`[XUAT] Translation error:`, err.message);

      this.emit('translation-request', {
        original: text,
        translated: text,
        from,
        to,
        success: false,
        error: err.message
      });

      // Return original text as plain text so the game doesn't hang
      // XUAT expects a response — if we don't respond, the game freezes
      // CRITICAL: Must return plain text, not JSON!
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    }
  }
}

module.exports = XuatServer;
