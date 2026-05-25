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

  platform: process.platform
};

contextBridge.exposeInMainWorld('tuhuaOverlay', api);
