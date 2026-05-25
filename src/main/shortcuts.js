/**
 * Global Keyboard Shortcuts
 * Registers system-wide hotkeys for common actions.
 */
const { globalShortcut, BrowserWindow } = require('electron');

class ShortcutManager {
  constructor(windowManager, pipeline, textractor, clipboardWatcher) {
    this.windowManager = windowManager;
    this.pipeline = pipeline;
    this.textractor = textractor;
    this.clipboardWatcher = clipboardWatcher;
    this.registered = false;
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
  }

  unregister() {
    if (!this.registered) return;
    globalShortcut.unregisterAll();
    this.registered = false;
  }
}

module.exports = ShortcutManager;
