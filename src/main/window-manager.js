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

class WindowManager {
  constructor(store) {
    this.store = store;
    this.mainWindow = null;
    this.outputOverlay = null;
    this.captureArea = null;
    this.clickThrough = false;
    // v3.13.04: Periodic alwaysOnTop reaffirmation timer
    this._alwaysOnTopTimer = null;
    // Input overlay removed — original text is visible in all modes:
    // Textractor: in the game, Clipboard: in clipboard, OCR: behind capture area
  }

  /**
   * v3.13.04: Re-assert alwaysOnTop on all overlay windows.
   * Called periodically and on focus-loss events to prevent overlays
   * from falling behind other windows on Windows.
   * @private
   */
  _reaffirmAlwaysOnTop() {
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
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
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
      if (!this.outputOverlay.isVisible()) {
        console.log('[WindowManager] Showing output overlay');
      }
      this.outputOverlay.show();
      // v3.13.04: Re-assert alwaysOnTop when showing
      this.outputOverlay.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  /**
   * v3.13.07: Check if the output overlay is currently visible.
   * @returns {boolean}
   */
  isOutputOverlayVisible() {
    return this.outputOverlay && !this.outputOverlay.isDestroyed() && this.outputOverlay.isVisible();
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
   * Hide the capture area window
   */
  hideCaptureArea() {
    if (this.captureArea && !this.captureArea.isDestroyed()) {
      this.captureArea.hide();
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

  getAllWindows() {
    return {
      main: this.mainWindow,
      outputOverlay: this.outputOverlay,
      captureArea: this.captureArea
    };
  }
}

module.exports = WindowManager;
