/**
 * Window Manager
 * Creates and manages all application windows:
 * - Main window (settings & status)
 * - Output overlay (translated text)
 * - Capture area (OCR region selector)
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
    // Input overlay removed — original text is visible in all modes:
    // Textractor: in the game, Clipboard: in clipboard, OCR: behind capture area
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
      this.outputOverlay.hide();
    }
  }

  /**
   * Show the output overlay (used when resuming)
   */
  showOutputOverlay() {
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      this.outputOverlay.show();
    }
  }

  /**
   * Clear the content of the output overlay window
   */
  clearOverlayContent() {
    this.sendToOutputOverlay('update-output', { text: '', targetLang: '' });
  }

  closeAllOverlays() {
    if (this.outputOverlay && !this.outputOverlay.isDestroyed()) {
      this.outputOverlay.close();
    }
    this.outputOverlay = null;
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
