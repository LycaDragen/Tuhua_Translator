/**
 * Global Keyboard Shortcuts
 * Registers system-wide hotkeys for common actions.
 *
 * v3.11.25: Added OCR capture trigger shortcut (Ctrl+Shift+S).
 *           When OCR mode is active, pressing the hotkey performs
 *           an immediate capture without going to the UI.
 */
const { globalShortcut, BrowserWindow } = require('electron');

class ShortcutManager {
  constructor(windowManager, pipeline, textractor, clipboardWatcher, ocrService) {
    this.windowManager = windowManager;
    this.pipeline = pipeline;
    this.textractor = textractor;
    this.clipboardWatcher = clipboardWatcher;
    // v3.11.25: OCR service reference for hotkey-triggered capture
    this.ocrService = ocrService;
    this.registered = false;
    // v3.11.25: OCR capture callback — set by ipc-handlers when OCR starts
    this._ocrCaptureCallback = null;
  }

  /**
   * v3.11.25: Set the OCR capture callback function.
   * Called by ipc-handlers when OCR mode starts to provide a
   * function that captures the screen region and runs OCR.
   * @param {Function} callback - async () => void
   */
  setOcrCaptureCallback(callback) {
    this._ocrCaptureCallback = callback;
  }

  register() {
    if (this.registered) return;
    this.registered = true;

    // Toggle main window visibility
    try {
      globalShortcut.register('CommandOrControl+Shift+L', () => {
        const { main } = this.windowManager.getAllWindows();
        if (!main) return;
        if (main.isVisible()) {
          main.hide();
        } else {
          main.show();
          main.focus();
        }
      });
    } catch (e) {
      console.warn('Failed to register Ctrl+Shift+L:', e.message);
    }

    // Toggle overlay visibility
    try {
      globalShortcut.register('CommandOrControl+Shift+E', () => {
        const { outputOverlay } = this.windowManager.getAllWindows();
        const visible = outputOverlay && outputOverlay.isVisible();
        this.windowManager.toggleOverlays(!visible);
      });
    } catch (e) {
      console.warn('Failed to register Ctrl+Shift+E:', e.message);
    }

    // Toggle click-through mode
    try {
      globalShortcut.register('CommandOrControl+Shift+M', () => {
        this.windowManager.toggleClickThrough();
        // Notify overlays
        this.windowManager.sendToMainWindow('shortcut-pressed', {
          action: 'toggle-clickthrough',
          state: this.windowManager.clickThrough
        });
      });
    } catch (e) {
      console.warn('Failed to register Ctrl+Shift+M:', e.message);
    }

    // Manual re-translate (useful for clipboard mode)
    try {
      globalShortcut.register('CommandOrControl+Shift+R', () => {
        this.windowManager.sendToMainWindow('shortcut-pressed', {
          action: 'retranslate'
        });
      });
    } catch (e) {
      console.warn('Failed to register Ctrl+Shift+R:', e.message);
    }

    // Cycle overlay opacity
    try {
      globalShortcut.register('CommandOrControl+Shift+O', () => {
        this.windowManager.sendToMainWindow('shortcut-pressed', {
          action: 'cycle-opacity'
        });
      });
    } catch (e) {
      console.warn('Failed to register Ctrl+Shift+O:', e.message);
    }

    // v3.11.25: OCR capture trigger — press to capture and translate now.
    // Only fires when OCR mode is active and a capture callback is set.
    // This is the equivalent of LunaTranslator's "click to capture" feature,
    // but implemented as a global hotkey for reliability.
    try {
      globalShortcut.register('CommandOrControl+Shift+S', async () => {
        if (!this._ocrCaptureCallback) {
          console.log('[Shortcuts] OCR capture hotkey pressed, but no OCR callback set');
          return;
        }
        try {
          console.log('[Shortcuts] OCR capture hotkey triggered');
          await this._ocrCaptureCallback();
        } catch (err) {
          console.error('[Shortcuts] OCR capture error:', err.message);
        }
      });
    } catch (e) {
      console.warn('Failed to register Ctrl+Shift+S (OCR capture):', e.message);
    }
  }

  unregister() {
    if (!this.registered) return;
    globalShortcut.unregisterAll();
    this.registered = false;
  }
}

module.exports = ShortcutManager;
