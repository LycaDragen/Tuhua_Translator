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
const llmProviders = require('../services/translation/llm-providers');
const promptPresets = require('../services/translation/prompt-presets');

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
      // v3.13.8x (settings UX audit): deeplStyleId/deeplTranslationMemoryId/
      // deeplTranslationMemoryThreshold/deeplLanguageFeatures removed —
      // dead defaults with no UI, no real writer, and (the first three) no
      // reader either once pipeline.js's 'deepl' case stopped passing them
      // in this same audit. See profile-migrations.js's DEAD_SETTING_KEYS_V2
      // comment for the full reasoning; an existing install's config.json
      // gets these stripped by ProfileStore#migrate()'s v3->v4 step.
      // v3.13.6x (LLM engine overhaul, Fase 6): global user preference (a
      // cost/latency-vs-quality tradeoff), not per-game — same reasoning as
      // llmTemperature. 'prefer_quality_optimized' matches what the app was
      // ALREADY silently forcing almost all the time before this Fase (see
      // deepl.js: custom_instructions, sent by default, forces DeepL's
      // next-gen model) — this setting mostly makes an existing behavior
      // visible and overridable rather than changing it.
      deeplModelType: 'prefer_quality_optimized',
      maxContextHistory: 5,
      historyLimit: 5,
      // v3.13.59 (LLM engine overhaul, Fase 4): kept as a default (not
      // deleted) purely so the one-time migration below has something to
      // read from on an existing install — nothing in the app reads
      // `systemPrompt` for translation anymore, see promptTemplate below.
      systemPrompt: '',
      // '' means "use prompt-presets.js's DEFAULT_TEMPLATE" — see
      // llm-base.js/prompt-template.js. Global only for now; a per-profile
      // override is designed (see the plan) but not wired until Fase 7
      // injects profileStore into the pipeline.
      promptTemplate: '',
      // Independent of promptTemplate — see fewShotEnabled's doc comment
      // in llm-base.js for why the old `if (!systemPrompt)` coupling was
      // a real bug (a custom prompt silently killed few-shot).
      llmFewShot: true,
      // v3.13.57 (LLM engine overhaul, Fase 2): rollback interruptor for
      // the LLM output sanitizer (llm-output.js) — set false to fall back
      // to a bare .trim() with none of its heuristics.
      llmSanitize: true,
      // v3.13.6x (LLM engine overhaul, Fase 5): rollback interruptor for
      // glossary-as-prompt-instruction (glossary-prompt.js). Measured
      // against two real engines (scripts/test-glossary-compliance.js):
      // OpenAI hit 100% prompt-only compliance, but a local 3B model
      // (Qwen2.5-3B-Instruct via Ollama) only hit 81.8% — it followed
      // "translate X as Y" instructions fine but ignored "leave X
      // unchanged" (source===target entries) and translated the term
      // anyway. Since glossaryMode is one global setting and Tuhua can't
      // know in advance whether a given local-llm user's model is strong
      // enough for prompt-only compliance, 'hybrid' — literal substitution
      // AND the prompt instruction together — is the safer universal
      // default: the literal substitution guarantees the term is present
      // (same ~100% floor as pre-Fase-5 behavior) while the prompt
      // instruction still helps a capable model integrate it with better
      // grammar than a raw substituted string. 'prompt' (skip the literal
      // substitution entirely) is available for a setup known to comply
      // well, e.g. OpenAI per the measurement above; 'literal' reproduces
      // the exact pre-Fase-5 behavior for every engine. No UI toggle yet —
      // same as llmSanitize just above, this is an escape hatch reachable
      // by editing settings directly if a real-world setup needs it.
      glossaryMode: 'hybrid',
      // v3.13.58 (LLM engine overhaul, Fase 3): global — credentials, one
      // real-world API key per provider id (see llm-providers.js). NOT
      // profile-scoped, same reasoning as deeplKey/apiKey before it.
      llmProviderKeys: {},
      // Sampling params shared by both LLM engines (openai/local-llm) —
      // deliberately global rather than per-profile: this is "how
      // deterministic should translations be", a user preference, not a
      // per-game setting the way the provider/model themselves are.
      llmTemperature: 0.3,
      llmMaxTokens: 1500,
      // null, not 0 — unset. See llm-base.js's constructor comment for why
      // "not sent" and "sent as 0" must stay distinguishable for top_p.
      llmTopP: null,
      clickThrough: false,
      profiles: [],
      activeProfile: 'Por Defecto',
      xuatPort: 8419,
      xuatConnectedGame: '',
      xuatConnectedPath: '',
      // v3.11.17: XUAT has its own language settings independent from global
      xuatSourceLang: 'en',   // XUAT requires a specific source language (no 'auto')
      xuatTargetLang: 'es',
      // v3.11.30: Regex text filter
      enableRegexFilter: true,
      // v3.13.01: OCR engine selection ('tesseract' or 'paddle')
      ocrEngine: 'tesseract',
      // v3.13.8x (settings UX audit): exposed in the modal's Avanzado
      // category. Matches the 3500ms default _startOcrAutoCapture() has
      // used since v3.9.9 — see ipc-handlers.js.
      ocrCaptureIntervalMs: 3500
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
    log.info('Profiles migrated.', {
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

  // v3.13.58 (LLM engine overhaul, Fase 3): one-time, idempotent seed of
  // the legacy global `openaiKey` into the new per-provider
  // `llmProviderKeys` map — see llm-providers.js's
  // seedProviderKeysFromLegacyOpenAIKey doc comment for why `openaiKey`
  // itself is deliberately left untouched rather than deleted here.
  // Runs before the settings snapshot below, same reasoning as the profile
  // migration above: `settings` must reflect the post-seed store.
  const seededProviderKeys = llmProviders.seedProviderKeysFromLegacyOpenAIKey(store.get());
  if (seededProviderKeys) {
    store.set('llmProviderKeys', seededProviderKeys);
    log.info('Seeded llmProviderKeys from legacy openaiKey.', { providers: Object.keys(seededProviderKeys) });
  }

  // v3.13.59 (LLM engine overhaul, Fase 4): same one-time seed pattern —
  // promotes a non-empty legacy `systemPrompt` into `promptTemplate`
  // verbatim. See prompt-presets.js's seedPromptTemplateFromLegacySystemPrompt.
  const seededPromptTemplate = promptPresets.seedPromptTemplateFromLegacySystemPrompt(store.get());
  if (seededPromptTemplate !== null) {
    store.set('promptTemplate', seededPromptTemplate);
    log.info('Seeded promptTemplate from legacy systemPrompt.');
  }

  const settings = store.get();
  log.info('Settings loaded:', { engine: settings.engine, sourceLang: settings.sourceLang, targetLang: settings.targetLang, inputMethod: settings.inputMethod });

  // Initialize services
  regexFilter = new RegexFilterService();
  hookCleaningSettings = new HookCleaningSettingsService();
  // v3.13.6x (Fase 6): profileStore injected so DeepL native glossary
  // auto-sync can read/write the active profile's deeplGlossarySync
  // bookkeeping — see pipeline.js's constructor comment.
  pipeline = new TranslationPipeline(settings, { glossary, profileStore });
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
