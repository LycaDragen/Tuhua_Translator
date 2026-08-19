/**
 * Tuhua Translator - Main Process Entry Point
 *
 * Open Source Visual Novel Translator
 * No paywalls, no feature gates — everything is free.
 */
const { app, BrowserWindow, Menu } = require('electron');
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
const ProfileStore = require('../services/profiles/profile-store');
const RegexFilterService = require('../services/regex-filter');
const HookCleaningSettingsService = require('../services/hook-cleaning-settings');

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
let regexFilter;
let hookCleaningSettings;
let profileStore;

app.whenReady().then(() => {
  // v3.13.40: removes Electron's default File/Edit/View/Window/Help menu
  // bar — this is Chromium's stock application menu (About/Quit/Reload/
  // DevTools/etc), not anything Tuhua defines; the app has no use for it
  // and it doesn't match the rest of the UI. AppTray (src/main/tray.js)
  // is unrelated — that's the system tray icon's right-click menu, still
  // built separately below and untouched by this.
  Menu.setApplicationMenu(null);

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
      enableTranslationMemory: true,
      deeplFormality: 'prefer_more',
      deeplCustomInstructions: [],
      deeplStyleId: '',
      deeplTranslationMemoryId: '',
      deeplTranslationMemoryThreshold: 75,
      deeplLanguageFeatures: null,
      maxContextHistory: 5,
      historyLimit: 5,
      systemPrompt: '',
      clickThrough: false,
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
      xuatTargetLang: 'es',
      // v3.11.30: Regex text filter
      enableRegexFilter: true,
      // v3.13.01: OCR engine selection ('tesseract' or 'paddle')
      ocrEngine: 'tesseract'
    }
  });

  // v3.13.40 (profiles Phase 1, steps 3-4): glossary and profileStore are
  // constructed BEFORE the settings snapshot below is captured, and the
  // one-time schema migration runs in between — this is what lets
  // `settings` (used to build the pipeline and everything downstream)
  // reflect the POST-migration global settings (promoted credentials,
  // targetLang, textractorCliPath/Port; the four dead settings keys
  // stripped) rather than a stale pre-migration snapshot.
  glossary = new GlossaryService();
  profileStore = new ProfileStore(store);
  const migration = profileStore.migrate(glossary.getAll());
  if (migration.ran) {
    log.info('Profiles migrated to schema v1.', {
      profileCount: migration.profiles.length,
      credentialConflicts: migration.report.credentialConflicts.map((c) => c.key),
      targetLangConflict: !!migration.report.targetLangConflict,
      textractorPortConflict: !!migration.report.textractorPortConflict
    });
  }
  // Materialized once here at startup, not lazily inside get-profiles —
  // see profile-store.js's ensureDefault() doc comment for why the old
  // lazy-inside-the-getter approach is what let the default profile's
  // seed literal drift from save-profile's in the first place.
  profileStore.ensureDefault(store.get());

  // v3.13.40 (step 5): the active profile's glossary layer must be live
  // from the very first translation, not just after the first profile
  // switch — load-profile's handler sets this again on every switch, but
  // nothing else runs at startup, so it has to happen here too.
  const startupActiveProfile = profileStore.getActive();
  if (startupActiveProfile) {
    glossary.setProfileLayer(startupActiveProfile.glossary);
  }

  const settings = store.get();
  log.info('Settings loaded:', { engine: settings.engine, sourceLang: settings.sourceLang, targetLang: settings.targetLang, inputMethod: settings.inputMethod });

  // Initialize services
  regexFilter = new RegexFilterService();
  hookCleaningSettings = new HookCleaningSettingsService();
  pipeline = new TranslationPipeline(settings, { glossary });
  textractor = new TextractorConnector(settings.textractorPort || 9251);
  textractorLauncher = new TextractorLauncher(hookCleaningSettings);
  clipboardWatcher = new ClipboardWatcher({ interval: 500 });
  ocrService = new OcrService();

  // v3.13.01: Restore OCR engine setting from saved config
  if (settings.ocrEngine && settings.ocrEngine !== 'tesseract') {
    ocrService.setOcrEngine(settings.ocrEngine);
  }

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

  // v3.13.23: x64<->x86 auto-fallback — log it clearly (not just a silent
  // retry) and let the renderer show a toast, same pattern as the existing
  // 'ocr-engine-fallback' notification.
  textractorLauncher.on('arch-fallback', ({ from, to, reason }) => {
    log.info(`[TextractorLauncher] Arch fallback: ${from} -> ${to} (reason: ${reason})`);
    windowManager.sendToMainWindow('textractor-cli-arch-fallback', { from, to, reason });
  });

  // v3.13.31: same pattern as 'arch-fallback' above — log clearly so a
  // stale/wrong PID isn't mistaken for an architecture mismatch during
  // diagnosis (attach fails exactly as silently either way).
  textractorLauncher.on('pid-warning', ({ pid, message }) => {
    log.warn(`[TextractorLauncher] PID warning: ${message}`);
    windowManager.sendToMainWindow('textractor-cli-pid-warning', { pid, message });
  });

  // v3.13.37: same pattern as 'arch-fallback'/'pid-warning' above — lets
  // the renderer show a live countdown instead of a dead "Launch" button
  // during the up-to-60s hook discovery window (fresh launch or an
  // internal arch-fallback retry, launch() emits it either way).
  textractorLauncher.on('search-started', ({ arch, durationMs }) => {
    log.info(`[TextractorLauncher] Search started: arch=${arch || 'unknown'} durationMs=${durationMs}`);
    windowManager.sendToMainWindow('textractor-cli-search-started', { arch, durationMs });
  });

  // v3.13.32: a fallback just discovered which architecture actually
  // works for this Textractor install — see TextractorLauncher's
  // _markArchSuccess doc for why nothing persisted this before. Only
  // rewrite the saved path when this came FROM a fallback (viaFallback) —
  // launch() itself already prefers the resolved arch in-session without
  // needing settings touched, so this is specifically about surviving a
  // Tuhua restart — and only within the SAME install the user already had
  // configured, so an explicit choice of a different Textractor folder is
  // never silently overwritten.
  textractorLauncher.on('arch-resolved', ({ cliPath, installKey, viaFallback }) => {
    if (!viaFallback) return;
    const stored = store.get('textractorCliPath', '');
    const sameInstall = stored && textractorLauncher._archInstallKey(stored) === installKey;
    if (!stored || sameInstall) {
      store.set({ ...store.get(), textractorCliPath: cliPath });
      log.info(`[TextractorLauncher] Persisted proven architecture: ${cliPath}`);
    }
    windowManager.sendToMainWindow('textractor-cli-arch-resolved', { cliPath });
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

  // v3.13.04: Start periodic alwaysOnTop guard to prevent overlays from
  // falling behind other windows (Windows can demote z-level on focus steal)
  windowManager.startAlwaysOnTopGuard();

  // v3.11.25: Initialize shortcuts BEFORE IPC handlers so the shortcut
  // manager reference can be passed to IpcHandlers for OCR hotkey integration.
  shortcuts = new ShortcutManager(windowManager, pipeline, textractor, clipboardWatcher, ocrService);
  shortcuts.register();

  // Initialize IPC handlers (v3.11.25: pass shortcuts for OCR hotkey integration)
  ipcHandlers = new IpcHandlers(store, pipeline, glossary, regexFilter, windowManager, textractor, clipboardWatcher, textractorLauncher, ocrService, xuatServer, shortcuts, hookCleaningSettings, profileStore);
  ipcHandlers.register();

  // v3.13.07: Improved startup overlay state management.
  // Set _translationActive based on saved settings, then ensure overlay
  // visibility matches the state: hidden when paused OR in XUAT mode.
  if (settings.translationActive === false) {
    ipcHandlers._translationActive = false;
    windowManager.hideOutputOverlay();
    windowManager.clearOverlayContent();
    log.info('Starting in paused mode — overlays hidden');
  } else if (settings.inputMethod === 'xuat') {
    ipcHandlers._translationActive = true;
    windowManager.hideOutputOverlay();
    windowManager.clearOverlayContent();
    log.info('Starting in XUAT mode — overlay hidden (XUAT renders in-game)');
  } else if (settings.inputMethod === 'ocr') {
    // v3.13.48: OCR always starts paused, regardless of the persisted
    // translationActive flag — real bug: a user who left Tuhua "Active"
    // in a DIFFERENT input method, then switched to OCR and closed the
    // app, would relaunch straight into OCR still marked active. OCR
    // needs its capture region repositioned every session (the game
    // window isn't guaranteed to be in the same place), so silently
    // staying "active" risks capturing/translating whatever happens to
    // be under a stale region before the user gets a chance to
    // reposition it. store.set (not just the in-memory flag) so the
    // renderer's own get-settings call — which happens later, once the
    // window has loaded — reflects the same paused state instead of
    // showing a misleading "Active" toggle.
    ipcHandlers._translationActive = false;
    store.set('translationActive', false);
    windowManager.hideOutputOverlay();
    windowManager.clearOverlayContent();
    log.info('Starting in OCR mode — forced to paused; position the capture area, then press ▶ Activo');
  }

  // Connect Textractor text events to translation pipeline
  textractor.on('text', (text) => {
    log.debug('[Textractor] Text received:', text.substring(0, 50));
    ipcHandlers._handleText(text);
  });

  textractor.on('status', (status) => {
    log.info('[Textractor] Status:', status);
    // v3.13.14: Don't forward Textractor reconnecting/disconnected status to renderer
    // when OCR or XUAT mode is active — the user doesn't care about Textractor's
    // background state while using a different input method. This was causing the
    // "Reconnecting..." yellow badge to appear even when OCR was working fine.
    const currentInputMethod = ipcHandlers._getCurrentInputMethod();
    // v3.13.39: 'error' and 'connected' added to the suppression list. The
    // TCP socket used to never actually connect (a broken readyState guard —
    // fixed this version), so these two were unreachable in practice. Now
    // that the socket connects for real, an OCR/XUAT/clipboard user with
    // Textractor's "Start Server" extension running in the background would
    // otherwise see up to 15 red 'error' paints from ECONNREFUSED retries,
    // or the badge flipping from "OCR Mode" to green "Connected" — neither
    // has anything to do with the input method they're actually using.
    if ((currentInputMethod === 'ocr' || currentInputMethod === 'xuat' || currentInputMethod === 'clipboard') &&
        (status === 'reconnecting' || status === 'disconnected' || status === 'timeout' ||
         status === 'error' || status === 'connected')) {
      log.info(`[Textractor] Suppressing '${status}' status — current input method is '${currentInputMethod}'`);
      return;
    }
    windowManager.sendToMainWindow('textractor-status', status);
  });

  textractor.on('error', (err) => {
    log.error('[Textractor] Error:', err.message);
    // v3.13.39: same suppression as the 'status' handler above — this event
    // bypassed it entirely, and with the socket now actually connecting
    // (and therefore actually able to ECONNREFUSED), it would otherwise
    // paint OCR/XUAT/clipboard users red from a background socket they
    // don't use.
    const currentInputMethod = ipcHandlers._getCurrentInputMethod();
    if (currentInputMethod === 'ocr' || currentInputMethod === 'xuat' || currentInputMethod === 'clipboard') {
      log.info(`[Textractor] Suppressing 'error' — current input method is '${currentInputMethod}'`);
      return;
    }
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

  // (shortcuts already initialized above before IPC handlers)

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
