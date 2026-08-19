/**
 * Overlay Preload Script
 * Minimal secure API for overlay windows.
 * Only exposes what overlays actually need.
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Output overlay
  onOutputText: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update-output', handler);
    return () => ipcRenderer.removeListener('update-output', handler);
  },
  onStyleUpdate: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update-style', handler);
    return () => ipcRenderer.removeListener('update-style', handler);
  },

  // Shared
  onShortcut: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('shortcut-pressed', handler);
    return () => ipcRenderer.removeListener('shortcut-pressed', handler);
  },

  // Capture area actions (used by capture-area overlay)
  ocrCapture: () => ipcRenderer.invoke('ocr-capture'),
  ocrCloseCaptureArea: () => ipcRenderer.invoke('ocr-close-capture-area'),
  ocrToggleScan: () => ipcRenderer.invoke('ocr-toggle-scan'),

  // v3.9.7: Output overlay auto-resize
  // Requests the main process to resize this overlay window to fit content
  resizeOverlay: (desiredHeight) => ipcRenderer.invoke('resize-overlay', desiredHeight),

  // v3.13.42: right-click a word in the output overlay → save to glossary.
  // requestWordContextMenu asks the main process to build and show a
  // NATIVE context menu (ipcMain.on('overlay-word-context-menu', ...) in
  // ipc-handlers.js) — a native menu can render outside this window's own
  // bounds, which a DOM popup couldn't, since this window is sized tightly
  // to the translation text. Picking a menu item there opens a second,
  // tiny prompt window (word-save-prompt/) that reuses this SAME preload
  // — onWordPromptContext/saveGlossaryEntry are for that window, not this
  // one. save-glossary is otherwise a main-window-only channel (see
  // ALLOWED_INVOKE_CHANNELS in main-preload.js); invoking it here is
  // deliberate, same as resize-overlay above (see this file's header).
  // v3.13.46: originalText travels along too — see the doc comment on
  // overlay-word-context-menu in ipc-handlers.js for what it's used for.
  requestWordContextMenu: (word, originalText) => ipcRenderer.send('overlay-word-context-menu', word, originalText),
  // v3.13.6x (Fase 9 testing follow-up): re-translate whatever line is
  // CURRENTLY shown, with whatever settings are current right now — the
  // overlay's "↻" toolbar button. Shared channel with Ctrl+Shift+R (see
  // ipc-handlers.js's request-retranslate handler / _retranslateCurrent).
  requestRetranslate: () => ipcRenderer.send('request-retranslate'),
  onWordPromptContext: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('word-prompt-context', handler);
    return () => ipcRenderer.removeListener('word-prompt-context', handler);
  },
  saveGlossaryEntry: (entry, scope) => ipcRenderer.invoke('save-glossary', { entry, scope }),

  platform: process.platform
};

contextBridge.exposeInMainWorld('tuhuaOverlay', api);
