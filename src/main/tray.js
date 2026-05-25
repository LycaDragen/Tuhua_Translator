/**
 * System Tray
 * Provides quick access to common actions without opening the main window.
 */
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

class AppTray {
  constructor(windowManager, pipeline, textractor, clipboardWatcher, textractorLauncher) {
    this.windowManager = windowManager;
    this.pipeline = pipeline;
    this.textractor = textractor;
    this.clipboardWatcher = clipboardWatcher;
    this.textractorLauncher = textractorLauncher;
    this.tray = null;
  }

  create() {
    // v3.11.3: Use .ico on Windows for best icon quality
    const iconName = process.platform === 'win32' ? 'Tuhua.ico' : 'tray-icon.png';
    const iconPath = path.join(__dirname, '..', '..', 'renderer', 'main', 'assets', iconName);

    // Fallback: create a simple tray icon if file doesn't exist
    let icon;
    try {
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        icon = nativeImage.createEmpty();
      }
    } catch {
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('Tuhua Translator');

    this._rebuildMenu();
    return this.tray;
  }

  _rebuildMenu() {
    const stats = this.pipeline.getStats();

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Tuhua Translator',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Show Main Window',
        click: () => {
          const { main } = this.windowManager.getAllWindows();
          if (main) {
            main.show();
            main.focus();
          }
        }
      },
      {
        label: 'Toggle Overlays',
        click: () => {
          const { outputOverlay } = this.windowManager.getAllWindows();
          if (outputOverlay && outputOverlay.isVisible()) {
            this.windowManager.toggleOverlays(false);
          } else {
            this.windowManager.toggleOverlays(true);
          }
        }
      },
      {
        label: 'Click-Through Mode',
        type: 'checkbox',
        checked: this.windowManager.clickThrough,
        click: (menuItem) => {
          this.windowManager.toggleClickThrough(menuItem.checked);
        }
      },
      { type: 'separator' },
      {
        label: 'Clear Cache',
        click: () => {
          this.pipeline.cache.clear();
        }
      },
      {
        label: 'Clear History',
        click: () => {
          this.pipeline.clearHistory();
        }
      },
      { type: 'separator' },
      {
        label: `Translations: ${stats.totalTranslations}`,
        enabled: false
      },
      {
        label: `Cache Hits: ${stats.cacheHits}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          if (this.textractorLauncher) this.textractorLauncher.kill();
          this.textractor.disconnect();
          this.clipboardWatcher.stop();
          const { main } = this.windowManager.getAllWindows();
          if (main) main.close();
          require('electron').app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  update() {
    this._rebuildMenu();
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = AppTray;
