/**
 * Window Manager
 * Creates and manages all application windows:
 * - Main window (settings & status)
 * - Output overlay (translated text)
 * - Capture area (OCR region selector)
 *
 * v3.13.04: Added periodic alwaysOnTop reaffirmation to prevent overlays
 *   from falling behind other windows on Windows. The 'screen-saver' z-level
 *   is the highest normal level but Windows can demote it when other apps
 *   steal focus aggressively (games, alt-tab, etc.). A 3-second timer
 *   re-asserts the level, and focus-loss events trigger immediate reaffirmation.
 * v3.13.06: No changes to window-manager in this version.
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const RENDERER_BASE = path.join(__dirname, '..', '..', 'renderer');

/**
 * v3.13.39: channels whose payload is CURRENT STATE, not a one-off event —
 * the renderer needs the latest value even if it wasn't listening when it
 * was sent. This is what fixes the badge staying red for a whole session
 * (session17.log): textractor.reconfigure(port) (src/main/index.js) runs
 * synchronously inside app.whenReady(), right after createMainWindow() —
 * this.mainWindow already exists at that point, so sendToMainWindow's
 * delivery guard passes, but the renderer process hasn't executed a single
 * line of script yet. webContents.send() is a guaranteed no-op there, not a
 * race — replaying the last known value once the page is actually ready is
 * the only fix.
 *
 * Everything else (translation-result, textractor-cli-output, *-error,
 * *-progress, hooks-discovered) is a discrete event and must NEVER be
 * replayed: re-firing a translation result or an error toast on every page
 * load would be a new bug, not a fix.
 */
const REPLAYABLE_CHANNELS = new Set([
  'textractor-status',
  'textractor-cli-status-changed',
  'xuat-status',
  // v1.0.1: "existe la versión X" es estado, no un evento discreto — sigue
  // siendo verdad después de un reload, y el listener sólo repinta un banner
  // (sin toast, sin efecto lateral), así que replayearlo es idempotente. Su
  // progreso de descarga, en cambio, NO está acá: es exactamente el caso que
  // el comentario de arriba prohíbe, y el mismo split que xuat-status /
  // xuat-install-progress ya hacen.
  'update-status'
]);

class WindowManager {
  constructor(store) {
    this.store = store;
    this.mainWindow = null;
    this.outputOverlay = null;
    this.captureArea = null;
    // v3.13.42: the "save word to glossary" popup — see createWordSavePrompt().
    this._wordPrompt = null;
    this.clickThrough = false;
    // v3.13.04: Periodic alwaysOnTop reaffirmation timer
    this._alwaysOnTopTimer = null;
    // Input overlay removed — original text is visible in all modes:
    // Textractor: in the game, Clipboard: in clipboard, OCR: behind capture area
    // v3.13.39: last known value per REPLAYABLE_CHANNELS entry.
    this._lastStateByChannel = new Map();
  }

  /**
   * v3.13.04: Re-assert alwaysOnTop on all overlay windows.
   * Called periodically and on focus-loss events to prevent overlays
   * from falling behind other windows on Windows.
   * @private
   */
  _reaffirmAlwaysOnTop() {
    // v3.13.47: real bug found on Windows — this timer's own
    // setAlwaysOnTop/moveTop calls (this tick included the word-prompt
    // itself, added in v3.13.46 as Linux insurance) were dismissing the
    // prompt's native <select> dropdown mid-interaction, closing it
    // ~every 3s and making it impossible to actually pick a mode. Any
    // z-order shuffle among topmost windows appears to do this to an
    // open native popup, not just moving the OTHER window — so the safe
    // fix is skipping this ENTIRE cycle while the prompt is open, not
    // picking a "safer" subset of calls. Nothing is lost by skipping:
    // the prompt is `parent`-owned by the overlay (see
    // createWordSavePrompt), so Windows already enforces the
    // above-overlay z-order invariant on its own for the few seconds
    // the prompt is up, without any periodic reassertion.
    if (this._wordPrompt && !this._wordPrompt.isDestroyed() && this._wordPrompt.isVisible()) {
      return;
    }
    const windows = [this.outputOverlay, this.captureArea];
    for (const win of windows) {
      if (win && !win.isDestroyed() && win.isVisible()) {
        try {
          win.setAlwaysOnTop(true, 'screen-saver');
        } catch (e) {
          // Window may have been closed between check and call
        }
      }
    }
  }

  /**
   * v3.13.04: Start the periodic alwaysOnTop reaffirmation timer.
   * Re-asserts the z-level every 3 seconds and on overlay focus loss.
   */
  startAlwaysOnTopGuard() {
    this.stopAlwaysOnTopGuard();
    this._alwaysOnTopTimer = setInterval(() => this._reaffirmAlwaysOnTop(), 3000);

    // Also reaffirm when overlay windows lose focus
    const attachBlurHandler = (win) => {
      if (!win) return;
      win.on('blur', () => {
        // Small delay to avoid fighting with window manager during normal interactions
        setTimeout(() => this._reaffirmAlwaysOnTop(), 100);
      });
    };

    // Attach handlers to existing windows
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      attachBlurHandler(this.outputOverlay);
    }
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      attachBlurHandler(this.captureArea);
    }

    // Store the handler creator for future windows
    this._attachBlurHandler = attachBlurHandler;
  }

  /**
   * v3.13.04: Stop the periodic alwaysOnTop reaffirmation timer.
   */
  stopAlwaysOnTopGuard() {
    if (this._alwaysOnTopTimer) {
      clearInterval(this._alwaysOnTopTimer);
      this._alwaysOnTopTimer = null;
    }
  }

  createMainWindow() {
    const settings = this.store.get();
    const bounds = settings.mainWindowBounds || { width: 1100, height: 900 };

    this.mainWindow = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload', 'main-preload.js')
      },
      title: 'Tuhua Translator',
      // v3.11.3: Use .ico on Windows for best icon quality, .png on other platforms
      icon: path.join(RENDERER_BASE, 'main', 'assets', process.platform === 'win32' ? 'Tuhua.ico' : 'icon.png'),
      backgroundColor: '#0f172a',
      show: false
    });

    this.mainWindow.loadFile(path.join(RENDERER_BASE, 'main', 'index.html'));
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });

    // v3.13.39: 'dom-ready' (= DOMContentLoaded), not 'did-finish-load', on
    // purpose. dom-ready fires once index.html's last classic script tag
    // (renderer.js) has executed — so ipcRenderer.on listeners already
    // exist — but does NOT wait on subresources, and index.html loads
    // Tailwind from a CDN, which on an offline machine would hold
    // did-finish-load back until that request times out. dom-ready also
    // fires again on a page reload, which is what we want here.
    this.mainWindow.webContents.on('dom-ready', () => this._replayStateToMainWindow());

    this.mainWindow.on('moved', () => this._saveMainWindowBounds());
    this.mainWindow.on('resized', () => this._saveMainWindowBounds());

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      this.stopAlwaysOnTopGuard();
      this.closeAllOverlays();
    });

    return this.mainWindow;
  }

  /**
   * Resolve font family from settings, auto-detecting based on source language if set to 'automatic'
   */
  _resolveFontFamily(settings) {
    const fontFamily = settings.overlayFontFamily;
    if (!fontFamily || fontFamily === 'automatic') {
      // Auto-detect based on source language
      const FONT_MAP = {
        'ja': "'Meiryo', 'MS Gothic', 'Noto Sans JP', sans-serif",
        'zh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', sans-serif",
        'lzh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', serif",
        'ko': "'Noto Sans KR', 'Malgun Gothic', sans-serif",
        'th': "'Tahoma', 'Noto Sans Thai', sans-serif",
        'vi': "'Tahoma', 'Noto Sans', sans-serif",
        'ar': "'Tahoma', 'Noto Sans Arabic', sans-serif",
        'hi': "'Tahoma', 'Noto Sans Devanagari', sans-serif",
        'ru': "'Segoe UI', 'Noto Sans', sans-serif"
      };
      const srcLang = settings.sourceLang || 'auto';
      return FONT_MAP[srcLang] || "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif";
    }
    return fontFamily;
  }

  createOutputOverlay() {
    if (this.outputOverlay) return this.outputOverlay;

    const settings = this.store.get();
    const bounds = settings.outputBounds || { width: 550, height: 180, x: 100, y: 280 };

    this.outputOverlay = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: 80,
      minHeight: 24,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js')
      }
    });

    this.outputOverlay.loadFile(path.join(RENDERER_BASE, 'output-overlay', 'index.html'));
    this.outputOverlay.setAlwaysOnTop(true, 'screen-saver');

    // v3.13.04: Re-assert alwaysOnTop when overlay loses focus
    this.outputOverlay.on('blur', () => {
      setTimeout(() => {
        if (this.outputOverlay && !this.outputOverlay.isDestroyed() && this.outputOverlay.isVisible()) {
          this.outputOverlay.setAlwaysOnTop(true, 'screen-saver');
        }
      }, 100);
    });

    // Send initial styles to output overlay after it loads
    this.outputOverlay.webContents.on('did-finish-load', () => {
      const s = this.store.get();
      const fontFamily = this._resolveFontFamily(s);
      this.sendToOutputOverlay('update-style', {
        fontSize: s.outputFontSize || 24,
        theme: s.outputTheme || 'dark',
        opacity: s.overlayOpacity || 85,
        fontFamily: fontFamily
      });
    });

    this.outputOverlay.on('moved', () => this._saveOverlayBounds());
    this.outputOverlay.on('resized', () => this._saveOverlayBounds());
    this.outputOverlay.on('closed', () => { this.outputOverlay = null; });

    return this.outputOverlay;
  }

  /**
   * Toggle click-through mode on output overlay
   * When enabled, overlay becomes non-interactive (mouse passes through)
   * Uses forward: true so the overlay still receives mouseMove events for visual updates
   */
  toggleClickThrough(enable) {
    this.clickThrough = enable !== undefined ? enable : !this.clickThrough;

    const setIgnoreMouseEvents = (win) => {
      if (!win || win.isDestroyed()) return;
      if (this.clickThrough) {
        // forward: true allows the window to still receive mouseMove events
        // while passing clicks through to windows below
        win.setIgnoreMouseEvents(true, { forward: true });
      } else {
        win.setIgnoreMouseEvents(false);
      }
    };

    setIgnoreMouseEvents(this.outputOverlay);
  }

  /**
   * Send data to output overlay window
   */
  sendToOutputOverlay(channel, data) {
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      this.outputOverlay.webContents.send(channel, data);
    }
  }

  sendToMainWindow(channel, data) {
    // v3.13.39: record BEFORE the delivery check — see REPLAYABLE_CHANNELS'
    // doc for why this specific ordering matters (the renderer may not
    // exist yet even though this.mainWindow does).
    if (REPLAYABLE_CHANNELS.has(channel)) {
      this._lastStateByChannel.set(channel, data);
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  _replayStateToMainWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    for (const [channel, data] of this._lastStateByChannel) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Toggle output overlay visibility
   */
  toggleOverlays(visible) {
    const action = visible ? 'show' : 'hide';
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      this.outputOverlay[action]();
    }
  }

  /**
   * Update output overlay styles
   */
  updateOverlayStyles(styleData) {
    // Handle 'automatic' font family - resolve based on source language
    if (styleData.fontFamily === 'automatic' || !styleData.fontFamily) {
      const settings = this.store.get();
      styleData.fontFamily = this._resolveFontFamily(settings);
    }
    this.sendToOutputOverlay('update-style', styleData);
  }

  /**
   * Hide the output overlay (used when paused)
   */
  hideOutputOverlay() {
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      if (this.outputOverlay.isVisible()) {
        console.log('[WindowManager] Hiding output overlay');
      }
      this.outputOverlay.hide();
    }
  }

  /**
   * Show the output overlay (used when resuming)
   */
  showOutputOverlay() {
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      // v3.13.80: only call .show() when actually hidden. This is called
      // unconditionally at the end of EVERY save-settings request while
      // Tuhua is active (see ipc-handlers.js's unified overlay-visibility
      // block) — including autosave-per-keystroke fields like DeepL custom
      // instructions. .show() re-activates the window every time it runs,
      // which steals OS keyboard focus from whatever the user is typing
      // into on Windows. Real bug found live: typing in "Instrucciones
      // Personalizadas" lost focus after every character, only while
      // active (never while paused, since the paused branch calls
      // hideOutputOverlay() instead). setAlwaysOnTop stays unconditional —
      // it's a z-order op, not a focus op, and re-asserting it defends
      // against another window stealing the on-top slot.
      if (!this.outputOverlay.isVisible()) {
        console.log('[WindowManager] Showing output overlay');
        this.outputOverlay.show();
      }
      this.outputOverlay.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  /**
   * Clear the content of the output overlay window
   */
  clearOverlayContent() {
    this.sendToOutputOverlay('update-output', { text: '', targetLang: '' });
  }

  closeAllOverlays() {
    this.stopAlwaysOnTopGuard();
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      this.outputOverlay.close();
    }
    this.outputOverlay = null;
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      this.captureArea.close();
    }
    this.captureArea = null;
  }

  _saveMainWindowBounds() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.store.set('mainWindowBounds', this.mainWindow.getBounds());
    }
  }

  _saveOverlayBounds() {
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      this.store.set('outputBounds', this.outputOverlay.getBounds());
    }
  }

  /**
   * Create the OCR capture area window
   * A transparent, frameless, always-on-top overlay that the user
   * positions over the game's dialogue box to define the OCR capture region.
   */
  createCaptureArea() {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      return this.captureArea;
    }

    const settings = this.store.get();
    const bounds = settings.captureAreaBounds || { width: 600, height: 150, x: 200, y: 400 };

    this.captureArea = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: 100,
      minHeight: 60,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js')
      }
    });

    this.captureArea.loadFile(path.join(RENDERER_BASE, 'capture-area', 'index.html'));
    this.captureArea.setAlwaysOnTop(true, 'screen-saver');

    // v3.13.04: Re-assert alwaysOnTop when capture area loses focus
    this.captureArea.on('blur', () => {
      setTimeout(() => {
        if (this.captureArea && !this.captureArea.isDestroyed() && this.captureArea.isVisible()) {
          this.captureArea.setAlwaysOnTop(true, 'screen-saver');
        }
      }, 100);
    });

    // Save bounds on move/resize
    this.captureArea.on('moved', () => this._saveCaptureAreaBounds());
    this.captureArea.on('resized', () => this._saveCaptureAreaBounds());
    this.captureArea.on('closed', () => { this.captureArea = null; });

    return this.captureArea;
  }

  /**
   * Show the capture area window
   */
  showCaptureArea() {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      this.captureArea.showInactive();
      // v3.13.04: Re-assert alwaysOnTop when showing
      this.captureArea.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  /**
   * Close the capture area window
   */
  closeCaptureArea() {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      this.captureArea.close();
      this.captureArea = null;
    }
  }

  /**
   * Get the capture area window bounds (for screen capture region)
   */
  getCaptureAreaBounds() {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      return this.captureArea.getBounds();
    }
    return null;
  }

  /**
   * Send data to capture area window
   */
  sendToCaptureArea(channel, data) {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      this.captureArea.webContents.send(channel, data);
    }
  }

  _saveCaptureAreaBounds() {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      this.store.set('captureAreaBounds', this.captureArea.getBounds());
    }
  }

  /**
   * v3.13.42: small ephemeral popup for the "right-click a word in the
   * output overlay → save to glossary" feature. `scope` was already
   * decided by which native-menu item the user clicked (see
   * overlay-word-context-menu in ipc-handlers.js, the only caller) — this
   * window's only job is collecting the meaning, so it has no scope
   * picker of its own. Positioned just under the output overlay so it
   * reads as attached to the word that was clicked, clamped to the
   * nearest display's work area so it can't render off-screen near an
   * edge. Reuses overlay-preload.js (see that file's own comment on why)
   * and the output-overlay's dark glass visual language.
   */
  createWordSavePrompt(word, scope, scopeLabel, strings, originalText, sourceClickable) {
    if (this._wordPrompt && !this._wordPrompt.isDestroyed()) {
      this._wordPrompt.close();
    }

    const width = 300;
    // v3.13.45: +30px for the mode select (Exact/Case Insensitive/Regex),
    // added so this flow isn't stuck hardcoding case-insensitive.
    // v3.13.46: +30px baseline for the new "Término" (source term) input
    // — every case needs it now, CJK included, since saving used to
    // (wrongly) reuse the clicked TRANSLATED word as the glossary
    // entry's source. +50px more on top when sourceClickable, for the
    // clickable original-line row (see overlay-word-context-menu in
    // ipc-handlers.js for how that's decided).
    // v3.13.49: +40px more on both — visual polish pass added a field
    // label above each input plus a divider under the header row. Sized
    // here, not left to the renderer, since this window doesn't
    // auto-resize the way the output overlay does.
    const height = sourceClickable ? 320 : 270;
    // v3.13.54: real gap Lyca caught — mainWindow/outputOverlay/
    // captureArea all remember where the user last dragged them
    // (store 'moved' → *Bounds, restored on next createX()); this
    // window never did, always resetting to "centered under the
    // overlay" every single time. Only width/height are NOT restored
    // (they're computed above from sourceClickable, not user-resizable
    // — resizable:false on this window) — just the position. Re-clamped
    // to the nearest display's work area even when restoring, in case
    // the saved point is now off-screen (resolution/monitor changed).
    const savedPos = this.store.get('wordPromptBounds');
    let x, y;
    if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
      x = savedPos.x;
      y = savedPos.y;
      const display = screen.getDisplayNearestPoint({ x, y });
      const area = display.workArea;
      x = Math.min(Math.max(x, area.x), area.x + area.width - width);
      y = Math.min(Math.max(y, area.y), area.y + area.height - height);
    } else if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      const bounds = this.outputOverlay.getBounds();
      x = Math.round(bounds.x + (bounds.width - width) / 2);
      y = bounds.y + bounds.height + 8;
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const area = display.workArea;
      x = Math.min(Math.max(x, area.x), area.x + area.width - width);
      y = Math.min(Math.max(y, area.y), area.y + area.height - height);
    }

    // v3.13.46: real bug — both this window and the output overlay used
    // the same 'screen-saver' alwaysOnTop level, so which one actually
    // rendered on top came down to whichever last won the OS's internal
    // "most recently raised topmost window" race. The output overlay's
    // OWN blur handler (createOutputOverlay, ~100ms after losing focus —
    // which opening THIS window causes) re-asserts its topmost level,
    // and could win that race, burying the prompt behind it depending on
    // timing/position. `parent` sidesteps the race instead of tuning it:
    // on Windows an owned window is a hard z-order invariant — the OS
    // will never let the owner (outputOverlay) paint above its owned
    // window, regardless of either window's alwaysOnTop reassertions.
    const hasOverlay = this.outputOverlay && !this.outputOverlay.isDestroyed();
    const win = new BrowserWindow({
      width, height, x, y,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      parent: hasOverlay ? this.outputOverlay : undefined,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js')
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(RENDERER_BASE, 'word-save-prompt', 'index.html'));
    win.once('ready-to-show', () => { win.show(); win.moveTop(); });
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('word-prompt-context', { word, scope, scopeLabel, strings, originalText, sourceClickable });
    });
    // Dismiss like a popup/context menu when the user clicks elsewhere.
    win.on('blur', () => { if (!win.isDestroyed()) win.close(); });
    // v3.13.54: remember where the user drags it, same as the other
    // windows (see this method's own comment above on why this one
    // never did). Position only — width/height are recomputed fresh
    // every open based on sourceClickable, not something to restore.
    win.on('moved', () => {
      if (!win.isDestroyed()) {
        const b = win.getBounds();
        this.store.set('wordPromptBounds', { x: b.x, y: b.y });
      }
    });
    win.on('closed', () => { if (this._wordPrompt === win) this._wordPrompt = null; });

    this._wordPrompt = win;
    return win;
  }

  getAllWindows() {
    return {
      main: this.mainWindow,
      outputOverlay: this.outputOverlay,
      captureArea: this.captureArea
    };
  }
}

module.exports = WindowManager;
