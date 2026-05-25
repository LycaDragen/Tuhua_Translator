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
  'get-glossary',
  'save-glossary',
  'delete-glossary-entry',
  'get-history',
  'clear-history',
  'export-history',
  'import-glossary',
  'export-glossary',
  'get-profiles',
  'save-profile',
  'create-profile',
  'delete-profile',
  'load-profile',
  'get-active-profile',
  'ocr-capture',
  'ocr-start',
  'ocr-stop',
  'ocr-set-language',
  'ocr-set-interval',
  'ocr-set-preprocessing',
  'ocr-status',
  'ocr-set-auto-capture',
  'ocr-close-capture-area',
  'ocr-toggle-scan',
  'get-displays',
  'test-connection',
  'validate-api-key',
  'detect-font-family',
  'textractor-validate-cli',
  'textractor-browse-cli',
  'textractor-launch',
  'textractor-kill',
  'textractor-cli-status',
  'textractor-cli-output',
  'textractor-select-hook',
  'textractor-test-cli',
  'get-debug-logs',
  'xuat-start-server', 'xuat-stop-server', 'xuat-get-status',
  'xuat-select-game', 'xuat-detect-game', 'xuat-install-in-game', 'xuat-set-port',
  'xuat-test-endpoint',
  'xuat-update-language', 'xuat-clear-cache'
]);

const ALLOWED_SEND_CHANNELS = new Set([
  'manual-translate'
]);

const ALLOWED_RECEIVE_CHANNELS = new Set([
  'textractor-status',
  'textractor-cli-status-changed',
  'textractor-cli-output',
  'textractor-cli-error',
  'hooks-discovered',
  'translation-result',
  'translation-error',
  'shortcut-pressed',
  'ocr-status',
  'ocr-text',
  'xuat-status',
  'xuat-install-progress',
  'xuat-game-connected',
  'xuat-translation-request'
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

  // Glossary
  getGlossary: () => secureInvoke('get-glossary'),
  saveGlossaryEntry: (entry) => {
    if (!entry || typeof entry.source !== 'string' || typeof entry.target !== 'string') {
      throw new Error('Invalid glossary entry');
    }
    return secureInvoke('save-glossary', entry);
  },
  deleteGlossaryEntry: (id) => {
    if (typeof id !== 'string') throw new Error('Invalid entry ID');
    return secureInvoke('delete-glossary-entry', id);
  },
  importGlossary: (filePath) => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path');
    return secureInvoke('import-glossary', filePath);
  },
  exportGlossary: (filePath) => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path');
    return secureInvoke('export-glossary', filePath);
  },

  // History
  getHistory: () => secureInvoke('get-history'),
  clearHistory: () => secureInvoke('clear-history'),
  exportHistory: (filePath) => {
    if (typeof filePath !== 'string') throw new Error('Invalid file path');
    return secureInvoke('export-history', filePath);
  },

  // Profiles
  getProfiles: () => secureInvoke('get-profiles'),
  saveProfile: (profile) => {
    if (!profile || typeof profile.name !== 'string') throw new Error('Invalid profile');
    return secureInvoke('save-profile', profile);
  },
  createProfile: ({ name, cloneFrom }) => {
    if (typeof name !== 'string') throw new Error('Invalid profile name');
    return secureInvoke('create-profile', { name, cloneFrom: cloneFrom || undefined });
  },
  deleteProfile: (name) => {
    if (typeof name !== 'string') throw new Error('Invalid profile name');
    return secureInvoke('delete-profile', name);
  },
  loadProfile: (name) => {
    if (typeof name !== 'string') throw new Error('Invalid profile name');
    return secureInvoke('load-profile', name);
  },
  getActiveProfile: () => secureInvoke('get-active-profile'),

  // OCR
  ocrCapture: () => secureInvoke('ocr-capture'),
  ocrStart: () => secureInvoke('ocr-start'),
  ocrStop: () => secureInvoke('ocr-stop'),
  ocrSetLanguage: (lang) => {
    if (typeof lang !== 'string') throw new Error('Invalid language');
    return secureInvoke('ocr-set-language', lang);
  },
  ocrSetInterval: (ms) => {
    if (typeof ms !== 'number' || ms < 300) throw new Error('Interval must be >= 300ms');
    return secureInvoke('ocr-set-interval', ms);
  },
  ocrSetPreprocessing: (options) => {
    if (typeof options !== 'object' || options === null) throw new Error('Invalid preprocessing options');
    return secureInvoke('ocr-set-preprocessing', options);
  },
  ocrStatus: () => secureInvoke('ocr-status'),
  ocrSetAutoCapture: (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Must be boolean');
    return secureInvoke('ocr-set-auto-capture', enabled);
  },
  ocrCloseCaptureArea: () => secureInvoke('ocr-close-capture-area'),
  getDisplays: () => secureInvoke('get-displays'),

  // Translation
  manualTranslate: (text) => {
    if (typeof text !== 'string') throw new Error('Text must be a string');
    secureSend('manual-translate', text);
  },

  // Connection test
  testConnection: (host, port) => {
    if (typeof host !== 'string' || typeof port !== 'number') {
      throw new Error('Invalid host or port');
    }
    return secureInvoke('test-connection', { host, port });
  },

  // API Key validation
  validateApiKey: (engine, apiKey, endpoint) => {
    if (typeof engine !== 'string') throw new Error('Invalid engine');
    return secureInvoke('validate-api-key', { engine, apiKey: apiKey || '', endpoint: endpoint || '' });
  },

  // Font family detection
  detectFontFamily: (sourceLang) => {
    if (typeof sourceLang !== 'string') throw new Error('Invalid language');
    return secureInvoke('detect-font-family', { sourceLang });
  },

  // TextractorCLI controls
  textractorValidateCli: (cliPath) => {
    if (typeof cliPath !== 'string') throw new Error('Invalid CLI path');
    return secureInvoke('textractor-validate-cli', cliPath);
  },
  textractorBrowseCli: () => secureInvoke('textractor-browse-cli'),
  textractorLaunch: (cliPath, gamePid, port) => {
    if (typeof cliPath !== 'string') throw new Error('Invalid CLI path');
    if (typeof gamePid !== 'number') throw new Error('Invalid PID');
    return secureInvoke('textractor-launch', { cliPath, gamePid, port: port || undefined });
  },
  textractorKill: () => secureInvoke('textractor-kill'),
  textractorCliStatus: () => secureInvoke('textractor-cli-status'),
  textractorCliOutput: () => secureInvoke('textractor-cli-output'),
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
  onHooksDiscovered: (callback) => secureOn('hooks-discovered', callback),
  onTranslationResult: (callback) => secureOn('translation-result', callback),
  onTranslationError: (callback) => secureOn('translation-error', callback),
  onShortcutPressed: (callback) => secureOn('shortcut-pressed', callback),

  // OCR events
  onOcrStatus: (callback) => secureOn('ocr-status', callback),
  onOcrText: (callback) => secureOn('ocr-text', callback),

  // v3.10.0: Debug logs
  getDebugLogs: () => secureInvoke('get-debug-logs'),

  // XUAT
  xuatStartServer: (port) => secureInvoke('xuat-start-server', port),
  xuatStopServer: () => secureInvoke('xuat-stop-server'),
  xuatGetStatus: () => secureInvoke('xuat-get-status'),
  xuatSelectGame: () => secureInvoke('xuat-select-game'),
  xuatDetectGame: (exePath) => secureInvoke('xuat-detect-game', exePath),
  xuatInstallInGame: (exePath, port) => secureInvoke('xuat-install-in-game', { exePath, port }),
  xuatSetPort: (port) => secureInvoke('xuat-set-port', port),
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

  // Platform info
  platform: process.platform,
  version: process.env.npm_package_version || '3.11.24'
};

contextBridge.exposeInMainWorld('tuhuaAPI', api);
