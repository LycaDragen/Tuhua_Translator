/**
 * Tuhua Translator - Main Process Entry Point
 *
 * Open Source Visual Novel Translator
 * No paywalls, no feature gates — everything is free.
 */
const { app, BrowserWindow } = require('electron');
const Store = require('electron-store');
const log = require('electron-log');

const WindowManager = require('./window-manager');
const IpcHandlers = require('./ipc-handlers');
const AppTray = require('./tray');
const ShortcutManager = require('./shortcuts');
const TextractorConnector = require('../services/textractor');
const TextractorLauncher = require('../services/textractor-launcher');
const ClipboardWatcher = require('../services/clipboard-watcher');
const OcrService = require('../services/ocr');
const XuatServer = require('../services/xuat-server');
const TranslationPipeline = require('../services/translation/pipeline');
const GlossaryService = require('../services/translation/glossary');

// Configure logging
// v3.10.0: Log to %appdata%/tuhua-translator/tuhua.log (rotating, max 1MB).
// Users can share this file for debugging. Keeps last 100 log entries.
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.maxSize = 1048576; // 1MB — rotate when exceeded
log.info('Tuhua Translator starting...');

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let store;
let windowManager;
let ipcHandlers;
let tray;
let shortcuts;
let textractor;
let textractorLauncher;
let clipboardWatcher;
let pipeline;
let glossary;
let ocrService;
let xuatServer;

app.whenReady().then(() => {
  // Initialize store with defaults
  store = new Store({
    defaults: {
      engine: 'google-free',
      sourceLang: 'auto',
      targetLang: 'es',
      inputMethod: 'textractor',
      textractorPort: 9251,
      textractorCliPath: '',
      outputFontSize: 24,
      outputTheme: 'dark',
      overlayOpacity: 85,
      overlayFontFamily: "'Segoe UI', 'Noto Sans JP', sans-serif",
      overlayFontMode: "'Segoe UI', 'Noto Sans JP', sans-serif",
      customFontValue: '',
      uiLanguage: 'es',
      theme: 'dark',
      debounceMs: 300,
      enableCache: true,
      enableGlossary: true,
      enableTranslationMemory: true,
      deeplFormality: 'default',
      maxContextHistory: 5,
      historyLimit: 5,
      systemPrompt: '',
      clickThrough: false,
      showSourceTextInOverlay: false,
      perProfileGlossary: false,
      autoApplyGlossary: true,
      profiles: [],
      activeProfile: 'Por Defecto',
      ocrLanguage: 'auto',
      ocrAutoCaptureMs: 3500,
      ocrAutoCapture: false,
      ocrCaptureMode: 'manual',
      ocrPreprocessing: { grayscale: true, threshold: false, thresholdValue: 128, contrast: false, contrastValue: 1.5 },
      xuatPort: 8419,
      xuatConnectedGame: '',
      xuatConnectedPath: '',
      // v3.11.17: XUAT has its own language settings independent from global
      xuatSourceLang: 'en',   // XUAT requires a specific source language (no 'auto')
      xuatTargetLang: 'es'
    }
  });

  const settings = store.get();
  log.info('Settings loaded:', { engine: settings.engine, sourceLang: settings.sourceLang, targetLang: settings.targetLang, inputMethod: settings.inputMethod });

  // Initialize services
  glossary = new GlossaryService();
  pipeline = new TranslationPipeline(settings);
  textractor = new TextractorConnector(settings.textractorPort || 9251);
  textractorLauncher = new TextractorLauncher();
  clipboardWatcher = new ClipboardWatcher({ interval: 500 });
  ocrService = new OcrService();
  xuatServer = new XuatServer(pipeline, settings.xuatPort || 8419);

  // Configure TextractorLauncher from saved settings
  if (settings.textractorCliPath) {
    textractorLauncher.configure(settings.textractorCliPath);
  }

  // Forward TextractorLauncher events to renderer
  textractorLauncher.on('status', (status) => {
    log.info('[TextractorLauncher] Status:', status);
    windowManager.sendToMainWindow('textractor-cli-status-changed', status);
  });

  textractorLauncher.on('error', (err) => {
    // v3.8.23: err is now a structured object with { message, code, severity, hint, stderr, stdout }
    // If it's an old-style Error object, convert it
    const errorData = err instanceof Error
      ? { message: err.message, code: null, severity: 'error', hint: '', stderr: '', stdout: '' }
      : err;
    log.error('[TextractorLauncher] Error:', errorData.message, errorData.hint ? `(hint: ${errorData.hint})` : '');
    windowManager.sendToMainWindow('textractor-cli-status-changed', 'error');
    windowManager.sendToMainWindow('textractor-cli-error', errorData);
  });

  textractorLauncher.on('output', (text) => {
    log.debug('[TextractorLauncher] Output:', text.substring(0, 100));
    windowManager.sendToMainWindow('textractor-cli-output', text);
  });

  // CRITICAL: Connect TextractorLauncher's 'text' event to the translation pipeline
  // This is the PRIMARY text source when using TextractorCLI mode.
  // TextractorCLI outputs game text to stdout, which we parse and emit as 'text'.
  textractorLauncher.on('text', (text) => {
    log.info('[TextractorLauncher] Game text received:', text.substring(0, 50));
    ipcHandlers._handleText(text);
  });

  // When stdout is producing game text, update the status display
  // so the user knows extraction is working (even if TCP shows "reconnecting")
  textractorLauncher.on('stdout-active', () => {
    windowManager.sendToMainWindow('textractor-cli-status-changed', 'extracting');
  });

  textractorLauncher.on('hooks-discovered', (data) => {
    windowManager.sendToMainWindow('hooks-discovered', data);
  });

  textractorLauncher.on('exited', ({ code, signal }) => {
    log.info('[TextractorLauncher] Exited:', { code, signal });
  });

  // Initialize window manager
  windowManager = new WindowManager(store);
  windowManager.createMainWindow();
  // Input overlay removed — original text is always visible:
  // Textractor: in the game, Clipboard: in clipboard, OCR: behind capture area
  windowManager.createOutputOverlay();

  // Initialize IPC handlers
  ipcHandlers = new IpcHandlers(store, pipeline, glossary, windowManager, textractor, clipboardWatcher, textractorLauncher, ocrService, xuatServer);
  ipcHandlers.register();

  // Restore translation active state from saved settings
  // XUAT mode does NOT need the overlay — translations appear in-game
  if (settings.translationActive === false || settings.inputMethod === 'xuat') {
    ipcHandlers._translationActive = settings.translationActive !== false;
    // Start with output overlay hidden if paused or XUAT mode
    windowManager.hideOutputOverlay();
    if (settings.translationActive === false) {
      log.info('Starting in paused mode — overlays hidden');
    }
  }

  // Connect Textractor text events to translation pipeline
  textractor.on('text', (text) => {
    log.debug('[Textractor] Text received:', text.substring(0, 50));
    ipcHandlers._handleText(text);
  });

  textractor.on('status', (status) => {
    log.info('[Textractor] Status:', status);
    windowManager.sendToMainWindow('textractor-status', status);
  });

  textractor.on('error', (err) => {
    log.error('[Textractor] Error:', err.message);
    windowManager.sendToMainWindow('textractor-status', 'error');
  });

  // Connect clipboard watcher
  clipboardWatcher.on('text', (text) => {
    log.debug('[Clipboard] Text received:', text.substring(0, 50));
    ipcHandlers._handleText(text);
  });

  clipboardWatcher.on('status', (status) => {
    log.info('[Clipboard] Status:', status);
    windowManager.sendToMainWindow('textractor-status', status);
  });

  // Initialize tray
  tray = new AppTray(windowManager, pipeline, textractor, clipboardWatcher, textractorLauncher);
  tray.create();

  // Initialize shortcuts
  shortcuts = new ShortcutManager(windowManager, pipeline, textractor, clipboardWatcher);
  shortcuts.register();

  // Start the appropriate input method based on saved settings
  if (settings.inputMethod === 'xuat') {
    log.info('Starting in XUAT mode, port:', settings.xuatPort || 8419);
    // XUAT doesn't need the output overlay — translations appear in-game
    // (overlay already hidden above during initialization)
    xuatServer.start().then(() => {
      windowManager.sendToMainWindow('textractor-status', 'xuat');
    }).catch(err => {
      log.error('[XUAT] Failed to start:', err.message);
    });
  } else if (settings.inputMethod === 'clipboard') {
    log.info('Starting in Clipboard mode');
    clipboardWatcher.start();
    setTimeout(() => {
      windowManager.sendToMainWindow('textractor-status', 'watching');
    }, 1000);
  } else if (settings.inputMethod === 'ocr') {
    log.info('Starting in OCR mode — user must click ▶ Activo to begin capture');
    // Don't auto-start OCR here; the user needs to position the capture area first
    setTimeout(() => {
      windowManager.sendToMainWindow('textractor-status', 'ocr');
    }, 1000);
  } else {
    log.info('Starting in Textractor mode, port:', settings.textractorPort);
    // Textractor mode: input overlay stays hidden, only output overlay needed
    // Always try TCP connection in Textractor mode (works with "Start Server" extension)
    // If CLI path is also configured, stdout is the primary channel
    const port = settings.textractorPort || 9251;
    textractor.reconfigure(port);
  }

  // Apply saved click-through mode on startup
  if (settings.clickThrough) {
    log.info('Applying saved click-through mode');
    setTimeout(() => {
      windowManager.toggleClickThrough(true);
    }, 500);
  }

  // Pipeline event forwarding
  pipeline.on('translation', (data) => {
    windowManager.sendToMainWindow('translation-result', data);
  });

  pipeline.on('error', (data) => {
    windowManager.sendToMainWindow('translation-error', data);
  });

  // XUAT event forwarding — send translation requests and status to renderer
  xuatServer.on('translation-request', (data) => {
    windowManager.sendToMainWindow('xuat-translation-request', data);
  });

  xuatServer.on('started', (data) => {
    windowManager.sendToMainWindow('xuat-status', { running: true, port: data.port });
  });

  xuatServer.on('stopped', () => {
    windowManager.sendToMainWindow('xuat-status', { running: false });
  });

  // v3.11.3: Add XUAT error listener — prevents uncaught exceptions
  // from EventEmitter's default behavior (throw if no listener)
  xuatServer.on('error', (err) => {
    log.error('[XUAT] Server error event:', err.message);
    // Don't send xuat-status on every error event — only on started/stopped
    // The IPC handlers already send status on start/stop success/failure
  });

  log.info('Tuhua Translator initialized successfully');
});

// Second instance handler
app.on('second-instance', () => {
  const { main } = windowManager ? windowManager.getAllWindows() : {};
  if (main) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }
});

// Cleanup on quit
app.on('will-quit', () => {
  log.info('Tuhua Translator shutting down...');

  if (shortcuts) shortcuts.unregister();
  if (textractorLauncher) textractorLauncher.kill();
  if (textractor) textractor.disconnect();
  if (clipboardWatcher) clipboardWatcher.stop();
  if (ocrService) ocrService.terminate();
  if (xuatServer) xuatServer.forceStop();
  if (tray) tray.destroy();

  log.info('Cleanup complete');
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
    windowManager.createMainWindow();
    windowManager.createOutputOverlay();
  }
});

// Error handling
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection:', reason);
});
