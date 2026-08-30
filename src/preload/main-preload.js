/**
 * Main Window Preload Script
 * Secure bridge between renderer and main process.
 * Uses contextBridge to expose only a typed, validated API surface.
 * All IPC channels are validated against whitelists at runtime.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted IPC channels - enforced at runtime
const ALLOWED_INVOKE_CHANNELS = new Set([
  'get-settings',
  'save-settings',
  // v3.13.58 (LLM engine overhaul, Fase 3)
  'get-llm-providers',
  // v3.13.59 (Fase 4)
  'get-prompt-presets',
  'get-glossary',
  'save-glossary',
  'delete-glossary-entry',
  'get-history',
  'clear-history',
  'export-history',
  'clear-context',
  'import-glossary',
  'export-glossary',
  'browse-save-json',
  'browse-open-json',
  'get-profiles',
  'save-profile',
  'create-profile',
  'delete-profile',
  'load-profile',
  'rename-profile',
  'duplicate-profile',
  'ocr-capture',
  'ocr-start',
  'ocr-stop',
  'ocr-toggle-scan',
  'validate-api-key',
  'textractor-browse-cli',
  'textractor-clear-cli-path',
  'list-game-processes',
  'inspect-game',
  'set-profile-game',
  'find-profile-by-title',
  'scan-known-games',
  'get-textractor-auto-detect-result',
  'open-docs-link',
  'open-mail-link',
  'textractor-launch',
  'textractor-kill',
  'textractor-cli-status',
  'textractor-select-hook',
  'textractor-test-cli',
  'get-debug-logs',
  'xuat-start-server', 'xuat-stop-server', 'xuat-get-status',
  'xuat-select-game', 'xuat-detect-game', 'xuat-install-in-game',
  'xuat-test-endpoint',
  'xuat-update-language', 'xuat-clear-cache',
  // v3.11.27: VNDB glossary import
  'vndb-search', 'vndb-import',
  // v3.11.28: DeepL feature detection
  'deepl-fetch-features',
  // v3.11.30: Regex text filter
  'get-regex-filters', 'save-regex-filter', 'delete-regex-filter',
  'toggle-regex-filter', 'test-regex-filter', 'reset-regex-filters',
  // v3.13.21: HOOK cleaning step settings
  'get-hook-cleaning-steps', 'toggle-hook-cleaning-step', 'set-hook-cleaning-cjk-only',
  'reset-hook-cleaning-steps',
  // v3.13.01: PaddleOCR engine selection
  'set-ocr-engine', 'get-ocr-engine-status',
  // v1.0.1: auto-updater
  'update-check', 'update-download', 'update-install',
  'update-open-release', 'update-skip-version',
  // v1.0.3: abrir la carpeta del log para adjuntarlo a un reporte
  'open-logs-folder'
]);

const ALLOWED_SEND_CHANNELS = new Set([
  // v3.13.6x (Fase 9 testing follow-up): fixes Ctrl+Shift+R, which fired
  // shortcut-pressed{action:'retranslate'} since it was registered but
  // handleShortcut() in renderer.js never had a case for it — the
  // shortcut has done nothing, ever, until now.
  'request-retranslate'
]);

const ALLOWED_RECEIVE_CHANNELS = new Set([
  'textractor-status',
  'textractor-cli-status-changed',
  'textractor-cli-output',
  'textractor-cli-error',
  'textractor-cli-arch-fallback',
  // v3.13.8x (settings UX audit, Fase 5): live push for the "switched to
  // Textractor mid-session, no saved path" auto-detect case — see the
  // save-settings handler in ipc-handlers.js.
  'textractor-cli-path-autodetected',
  // v3.13.32: was emitted by TextractorLauncher (src/main/index.js) since
  // v3.13.31 but missing here — secureOn silently rejects any channel not
  // in this Set, so the renderer's listener could never actually fire.
  'textractor-cli-pid-warning',
  'textractor-cli-arch-resolved',
  // v3.13.37: same lesson as the pid-warning comment above — allowlist
  // AND wrapper both required, not just one.
  'textractor-cli-search-started',
  'hooks-discovered',
  // v3.13.85 (auto-configuración de juegos, Fase C2): promoted out of
  // hooks-discovered's payload — see textractor-launcher.js's
  // _detectAndEmitGameEngine for the full rationale.
  'game-engine-advice',
  'translation-result',
  'translation-error',
  'shortcut-pressed',
  'ocr-status',
  'ocr-engine-fallback',
  'ocr-engine-advice',
  'xuat-status',
  'xuat-install-progress',
  'xuat-game-connected',
  'xuat-translation-request',
  // v1.0.1: auto-updater
  'update-status',
  'update-download-progress'
]);

/**
 * Secure invoke wrapper with channel validation
 */
function secureInvoke(channel, ...args) {
  if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC invoke channel "${channel}" is not allowed`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * Secure send wrapper with channel validation
 */
function secureSend(channel, ...args) {
  if (!ALLOWED_SEND_CHANNELS.has(channel)) {
    throw new Error(`IPC send channel "${channel}" is not allowed`);
  }
  ipcRenderer.send(channel, ...args);
}

/**
 * Secure receive listener with channel validation
 */
function secureOn(channel, callback) {
  if (!ALLOWED_RECEIVE_CHANNELS.has(channel)) {
    throw new Error(`IPC receive channel "${channel}" is not allowed`);
  }
  const handler = (event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  // Settings
  getSettings: () => secureInvoke('get-settings'),
  saveSettings: (data) => {
    if (typeof data !== 'object' || data === null) {
      throw new Error('Settings must be an object');
    }
    return secureInvoke('save-settings', data);
  },
  // v3.13.58 (LLM engine overhaul, Fase 3): the cloud provider dropdown /
  // local endpoint preset dropdown / model datalists all read from this —
  // see ipc-handlers.js's get-llm-providers for why it can't just be a
  // require() of llm-providers.js from here (sandboxed renderer).
  getLlmProviders: () => secureInvoke('get-llm-providers'),
  // v3.13.59 (Fase 4): feeds the prompt preset <select> — same reasoning
  // as getLlmProviders just above (prompt-presets.js's actual template
  // prose lives only in the main process).
  getPromptPresets: () => secureInvoke('get-prompt-presets'),

  // Glossary (v3.13.40: two layers — scope is 'global' or 'profile')
  getGlossary: () => secureInvoke('get-glossary'),
  saveGlossaryEntry: (entry, scope = 'global') => {
    if (!entry || typeof entry.source !== 'string' || typeof entry.target !== 'string') {
      throw new Error('Invalid glossary entry');
    }
    return secureInvoke('save-glossary', { entry, scope });
  },
  deleteGlossaryEntry: (id, scope = 'global') => {
    if (typeof id !== 'string') throw new Error('Invalid entry ID');
    return secureInvoke('delete-glossary-entry', { id, scope });
  },
  importGlossary: (filePath, scope = 'global') => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path');
    return secureInvoke('import-glossary', { filePath, scope });
  },
  exportGlossary: (filePath, scope = 'global') => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path');
    return secureInvoke('export-glossary', { filePath, scope });
  },
  // v3.13.40-fix: native file pickers, replacing the "type the full path"
  // prompt() flow — real feedback found it unclear (read as "type just
  // the filename" at first) and worse UX than every other file-choosing
  // flow in the app already had (see textractorBrowseCli).
  browseSaveFile: (options) => secureInvoke('browse-save-json', options || {}),
  browseOpenFile: (options) => secureInvoke('browse-open-json', options || {}),

  // History
  getHistory: () => secureInvoke('get-history'),
  clearHistory: () => secureInvoke('clear-history'),
  clearContext: () => secureInvoke('clear-context'),
  exportHistory: (filePath) => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path');
    return secureInvoke('export-history', filePath);
  },

  // Profiles (v3.13.40: keyed by id, not name — id is what makes rename possible)
  getProfiles: () => secureInvoke('get-profiles'),
  saveProfile: (id) => {
    if (typeof id !== 'string') throw new Error('Invalid profile id');
    return secureInvoke('save-profile', id);
  },
  createProfile: ({ name, cloneFromId, inputMethod } = {}) => {
    if (typeof name !== 'string') throw new Error('Invalid profile name');
    return secureInvoke('create-profile', { name, cloneFromId: cloneFromId || undefined, inputMethod: inputMethod || undefined });
  },
  renameProfile: (id, newName) => {
    if (typeof id !== 'string') throw new Error('Invalid profile id');
    if (typeof newName !== 'string') throw new Error('Invalid profile name');
    return secureInvoke('rename-profile', { id, newName });
  },
  duplicateProfile: (id, newName) => {
    if (typeof id !== 'string') throw new Error('Invalid profile id');
    if (typeof newName !== 'string') throw new Error('Invalid profile name');
    return secureInvoke('duplicate-profile', { id, newName });
  },
  deleteProfile: (id) => {
    if (typeof id !== 'string') throw new Error('Invalid profile id');
    return secureInvoke('delete-profile', id);
  },
  loadProfile: (id) => {
    if (typeof id !== 'string') throw new Error('Invalid profile id');
    return secureInvoke('load-profile', id);
  },

  // OCR
  ocrCapture: () => secureInvoke('ocr-capture'),
  ocrStart: () => secureInvoke('ocr-start'),
  ocrStop: () => secureInvoke('ocr-stop'),
  // v3.13.01: OCR engine selection
  setOcrEngine: (engine) => {
    if (typeof engine !== 'string' || (engine !== 'tesseract' && engine !== 'paddle')) {
      throw new Error('Invalid OCR engine');
    }
    return secureInvoke('set-ocr-engine', engine);
  },
  getOcrEngineStatus: () => secureInvoke('get-ocr-engine-status'),

  requestRetranslate: () => secureSend('request-retranslate'),

  // API Key validation
  // v3.13.58 (Fase 3): `provider` is new — which llm-providers.js entry to
  // validate against for engine==='openai'. Optional/backward-compatible:
  // every other engine ignores it, and omitting it falls back to the
  // 'openai' provider (see ipc-handlers.js's validate-api-key handler).
  validateApiKey: (engine, apiKey, endpoint, provider) => {
    if (typeof engine !== 'string') throw new Error('Invalid engine');
    return secureInvoke('validate-api-key', { engine, apiKey: apiKey || '', endpoint: endpoint || '', provider: provider || '' });
  },

  // TextractorCLI controls
  textractorBrowseCli: () => secureInvoke('textractor-browse-cli'),
  // v3.13.8x (Fase 5, second pass): clears the saved path and immediately
  // re-runs auto-detection — see the handler's own doc comment.
  textractorClearCliPath: () => secureInvoke('textractor-clear-cli-path'),
  // v3.13.8x (settings UX audit, Fase 4): Windows-only game process picker
  // for the Game PID field — see the handler's own doc comment.
  listGameProcesses: () => secureInvoke('list-game-processes'),
  // v3.13.85 (auto-configuración de juegos, Fase C1): engine+arch inspection
  // for an arbitrary exe — the Windows-independent replacement for the old
  // Textractor-only, post-launch-only advisory. See game-inspect.js.
  inspectGame: (exePath) => secureInvoke('inspect-game', { exePath }),
  // v3.13.85 (Fase B): the only writer of profile.game — `process: null`
  // unlinks. See the handler's own doc comment in ipc-handlers.js.
  setProfileGame: (payload) => secureInvoke('set-profile-game', payload),
  // v3.13.87 (Fase D, D.1 branch b): title-match lookup for the picker's
  // destination screen — see the handler's own doc comment in
  // ipc-handlers.js for why this can't just be a client-side
  // compareTitles() call.
  findProfileByTitle: (payload) => secureInvoke('find-profile-by-title', payload),
  // v3.13.85 (Fase B): matches running processes against every profile's
  // saved game link — see the handler's own doc comment.
  scanKnownGames: () => secureInvoke('scan-known-games'),
  // v3.13.8x (Fase 5): read-once startup auto-detect result — see the
  // handler's own doc comment in ipc-handlers.js.
  getTextractorAutoDetectResult: () => secureInvoke('get-textractor-auto-detect-result'),
  // v3.13.88 (Fase E, Guía de Inicio): opens tuhua.lyca.dev in the OS
  // default browser — needs shell.openExternal, unreachable from a
  // sandboxed renderer directly.
  openDocsLink: () => secureInvoke('open-docs-link'),
  // v1.0.7: destino fijo (mailto:help@tuhua.lyca.dev), igual que openDocsLink
  openMailLink: () => secureInvoke('open-mail-link'),
  // v3.13.8x: gameExePath (4th arg) is an optional hint — the "🎮 Elegir…"
  // picker already resolves it for free (list-game-processes returns
  // exePath per process), so the renderer forwards it here instead of the
  // backend paying for a second PowerShell round-trip. Feeds the
  // pre-flight arch check's Level 1 (TextractorLauncher#_preflightArchSwap)
  // — null/absent just means Level 2's in-flight correction covers it
  // instead, same as a PID typed by hand.
  textractorLaunch: (cliPath, gamePid, port, gameExePath) => {
    if (typeof cliPath !== 'string') throw new Error('Invalid CLI path');
    if (typeof gamePid !== 'number') throw new Error('Invalid PID');
    return secureInvoke('textractor-launch', { cliPath, gamePid, port: port || undefined, gameExePath: gameExePath || undefined });
  },
  textractorKill: () => secureInvoke('textractor-kill'),
  textractorCliStatus: () => secureInvoke('textractor-cli-status'),
  textractorSelectHook: (hookKey) => secureInvoke('textractor-select-hook', hookKey),
  textractorTestCli: (cliPath) => {
    if (typeof cliPath !== 'string') throw new Error('Invalid CLI path');
    return secureInvoke('textractor-test-cli', cliPath);
  },

  // Event listeners (secure, with channel validation)
  onTextractorStatus: (callback) => secureOn('textractor-status', callback),
  onTextractorCliStatusChanged: (callback) => secureOn('textractor-cli-status-changed', callback),
  onTextractorCliOutput: (callback) => secureOn('textractor-cli-output', callback),
  onTextractorCliError: (callback) => secureOn('textractor-cli-error', callback),
  onTextractorCliArchFallback: (callback) => secureOn('textractor-cli-arch-fallback', callback),
  // v3.13.8x (Fase 5): live push for the mid-session auto-detect case.
  onTextractorCliPathAutodetected: (callback) => secureOn('textractor-cli-path-autodetected', callback),
  onTextractorCliPidWarning: (callback) => secureOn('textractor-cli-pid-warning', callback),
  onTextractorCliArchResolved: (callback) => secureOn('textractor-cli-arch-resolved', callback),
  onTextractorCliSearchStarted: (callback) => secureOn('textractor-cli-search-started', callback),
  onHooksDiscovered: (callback) => secureOn('hooks-discovered', callback),
  // v3.13.85 (auto-configuración de juegos, Fase C2): the game-engine
  // advisory's own push channel — see textractor-launcher.js's
  // _detectAndEmitGameEngine doc comment.
  onGameEngineAdvice: (callback) => secureOn('game-engine-advice', callback),
  onTranslationResult: (callback) => secureOn('translation-result', callback),
  onTranslationError: (callback) => secureOn('translation-error', callback),
  onShortcutPressed: (callback) => secureOn('shortcut-pressed', callback),

  // OCR events
  onOcrStatus: (callback) => secureOn('ocr-status', callback),
  // v3.13.01-fix: PaddleOCR fallback notification
  onOcrEngineFallback: (callback) => secureOn('ocr-engine-fallback', callback),
  // v3.13.79 (Fase 3, round-3 plan): proactive suggestion to try Paddle
  // when Tesseract quality has been persistently poor this session
  onOcrEngineAdvice: (callback) => secureOn('ocr-engine-advice', callback),

  // v3.10.0: Debug logs
  getDebugLogs: () => secureInvoke('get-debug-logs'),

  // XUAT
  xuatStartServer: (port) => secureInvoke('xuat-start-server', port),
  xuatStopServer: () => secureInvoke('xuat-stop-server'),
  xuatGetStatus: () => secureInvoke('xuat-get-status'),
  xuatSelectGame: () => secureInvoke('xuat-select-game'),
  xuatDetectGame: (exePath) => secureInvoke('xuat-detect-game', exePath),
  xuatInstallInGame: (exePath, port) => secureInvoke('xuat-install-in-game', { exePath, port }),
  xuatTestEndpoint: () => secureInvoke('xuat-test-endpoint'),
  xuatUpdateLanguage: (sourceLang, targetLang) => {
    if (typeof sourceLang !== 'string' || typeof targetLang !== 'string') {
      throw new Error('Invalid language parameters');
    }
    return secureInvoke('xuat-update-language', { sourceLang, targetLang });
  },
  xuatClearCache: () => secureInvoke('xuat-clear-cache'),
  onXuatStatus: (callback) => secureOn('xuat-status', callback),
  onXuatInstallProgress: (callback) => secureOn('xuat-install-progress', callback),
  onXuatGameConnected: (callback) => secureOn('xuat-game-connected', callback),
  onXuatTranslationRequest: (callback) => secureOn('xuat-translation-request', callback),

  // v3.11.27: VNDB glossary import
  vndbSearch: (query) => {
    if (typeof query !== 'string' || query.trim().length < 2) throw new Error('Query too short');
    return secureInvoke('vndb-search', query);
  },
  // v3.13.41: profileId is explicit now — the import button lives on each
  // profile card, not just the active profile's Glosario tab.
  vndbImport: (vnId, profileId, options) => {
    if (typeof vnId !== 'string') throw new Error('Invalid VNDB ID');
    if (typeof profileId !== 'string') throw new Error('Invalid profile ID');
    return secureInvoke('vndb-import', vnId, profileId, options || {});
  },

  // v3.11.28: DeepL feature detection
  deeplFetchFeatures: (apiKey) => {
    if (typeof apiKey !== 'string') throw new Error('Invalid API key');
    return secureInvoke('deepl-fetch-features', { apiKey });
  },

  // v3.11.30: Regex text filter
  getRegexFilters: () => secureInvoke('get-regex-filters'),
  saveRegexFilter: (entry) => {
    if (!entry || typeof entry.pattern !== 'string') throw new Error('Invalid filter entry');
    return secureInvoke('save-regex-filter', entry);
  },
  deleteRegexFilter: (id) => {
    if (typeof id !== 'string') throw new Error('Invalid filter ID');
    return secureInvoke('delete-regex-filter', id);
  },
  toggleRegexFilter: (id, enabled) => {
    if (typeof id !== 'string') throw new Error('Invalid filter ID');
    if (typeof enabled !== 'boolean') throw new Error('Enabled must be boolean');
    return secureInvoke('toggle-regex-filter', id, enabled);
  },
  testRegexFilter: (text, filterId) => {
    if (typeof text !== 'string') throw new Error('Invalid text');
    return secureInvoke('test-regex-filter', text, filterId || null);
  },
  resetRegexFilters: () => secureInvoke('reset-regex-filters'),

  // v3.13.21: HOOK cleaning step settings
  getHookCleaningSteps: () => secureInvoke('get-hook-cleaning-steps'),
  toggleHookCleaningStep: (id, enabled) => {
    if (typeof id !== 'string') throw new Error('Invalid step ID');
    if (typeof enabled !== 'boolean') throw new Error('Enabled must be boolean');
    return secureInvoke('toggle-hook-cleaning-step', id, enabled);
  },
  setHookCleaningCjkOnly: (id, cjkOnly) => {
    if (typeof id !== 'string') throw new Error('Invalid step ID');
    if (typeof cjkOnly !== 'boolean') throw new Error('cjkOnly must be boolean');
    return secureInvoke('set-hook-cleaning-cjk-only', id, cjkOnly);
  },
  resetHookCleaningSteps: () => secureInvoke('reset-hook-cleaning-steps'),

  // v1.0.1: auto-updater. Ninguno lleva argumentos a propósito — la versión,
  // la URL del release y si se puede auto-instalar los decide el main.
  openLogsFolder: () => secureInvoke('open-logs-folder'),
  checkForUpdate: () => secureInvoke('update-check'),
  downloadUpdate: () => secureInvoke('update-download'),
  installUpdate: () => secureInvoke('update-install'),
  openReleasePage: () => secureInvoke('update-open-release'),
  skipUpdateVersion: () => secureInvoke('update-skip-version'),
  onUpdateStatus: (callback) => secureOn('update-status', callback),
  onUpdateDownloadProgress: (callback) => secureOn('update-download-progress', callback),

  // Platform info
  platform: process.platform,
  // v3.13.40-fix: require('../../package.json') broke the ENTIRE preload
  // silently — this window is created with `sandbox: true`
  // (window-manager.js), and a sandboxed preload's require() only allows
  // a small built-in allowlist (electron/events/timers/url), not
  // arbitrary local file paths. Since this was the last property in the
  // `api` object literal, the exception aborted the whole `const api =
  // {...}` before contextBridge.exposeInMainWorld ever ran — window.tuhuaAPI
  // stayed undefined, and every api.* call in the renderer failed via
  // init()'s `if (!api) return;` guard (not just this field — that's why
  // profile cards disappeared too, not only the version badge).
  // ipcRenderer.sendSync is explicitly allowed under sandbox, so this asks
  // the main process (which has full Node/Electron access) via
  // app.getVersion() — Electron's own accessor for package.json's
  // `version`, correct in both dev and a packaged build.
  version: ipcRenderer.sendSync('get-app-version')
};

contextBridge.exposeInMainWorld('tuhuaAPI', api);
