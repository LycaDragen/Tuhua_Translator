/**
 * IPC Handlers
 * Registers all secure IPC communication between main and renderer.
 * All payloads are validated before processing.
 */
const { ipcMain, dialog, app, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const XuatInstaller = require('../services/xuat-installer');
const VndbService = require('../services/vndb');
const textCleaning = require('../services/text-cleaning');

class IpcHandlers {
  constructor(store, pipeline, glossary, regexFilter, windowManager, textractor, clipboardWatcher, textractorLauncher, ocrService, xuatServer, shortcutManager, hookCleaningSettings) {
    this.store = store;
    this.pipeline = pipeline;
    this.glossary = glossary;
    this.regexFilter = regexFilter;
    this.hookCleaningSettings = hookCleaningSettings || null;
    this.windowManager = windowManager;
    this.textractor = textractor;
    this.clipboardWatcher = clipboardWatcher;
    this.textractorLauncher = textractorLauncher;
    this.ocrService = ocrService;
    this.xuatServer = xuatServer;
    // v3.11.25: Shortcut manager for OCR hotkey-triggered capture
    this.shortcutManager = shortcutManager || null;
    // v3.11.25: VNDB service for glossary import
    this.vndbService = new VndbService();
    this.registered = false;
    // In-memory translation active flag for fast, reliable access
    this._translationActive = true;
    // Deduplication state for _handleText
    this._lastHandledHash = '';
    this._lastHandledTime = 0;
    // v3.13.12: Store last handled text for auto-retranslation when settings change
    this._lastHandledText = '';
    // OCR dedup: persistent hash that doesn't expire — same text from OCR
    // should NEVER be re-translated until the game screen changes
    this._lastOcrTextHash = '';
    // OCR state
    this._ocrActive = false;
    this._ocrAutoCapture = false;
    this._ocrScanPaused = false; // v3.9.6: scan paused from capture area overlay
  }

  /**
   * v3.13.14: Get the current input method from store.
   * Used by index.js to filter Textractor status events when OCR/clipboard/XUAT is active.
   * @returns {string} Current input method ('textractor', 'clipboard', 'ocr', 'xuat')
   */
  _getCurrentInputMethod() {
    return this.store.get('inputMethod') || 'textractor';
  }

  register() {
    if (this.registered) return;
    this.registered = true;

    // ===== Settings =====
    ipcMain.handle('get-settings', () => {
      const settings = this.store.get() || {};
      // Migration: convert old dot-notation keys to flat keys
      // electron-store's set() with dot-notation keys creates nested objects,
      // but get() with dot-notation reads nested paths — causing mismatch.
      // We migrate to flat keys (perProfileGlossary, autoApplyGlossary, showSourceTextInOverlay).
      let migrated = false;
      if (settings.glossary && typeof settings.glossary === 'object' && !Array.isArray(settings.glossary)) {
        if (settings.glossary.perProfile !== undefined && settings.perProfileGlossary === undefined) {
          settings.perProfileGlossary = settings.glossary.perProfile;
          delete settings.glossary.perProfile;
          migrated = true;
        }
        if (settings.glossary.autoApply !== undefined && settings.autoApplyGlossary === undefined) {
          settings.autoApplyGlossary = settings.glossary.autoApply;
          delete settings.glossary.autoApply;
          migrated = true;
        }
        // If glossary object is now empty (no more nested keys), remove it
        if (Object.keys(settings.glossary).length === 0) {
          delete settings.glossary;
          migrated = true;
        }
      }
      // Also check for flat dot-key stored by old code
      if (settings['glossary.perProfile'] !== undefined && settings.perProfileGlossary === undefined) {
        settings.perProfileGlossary = settings['glossary.perProfile'];
        delete settings['glossary.perProfile'];
        migrated = true;
      }
      if (settings['glossary.autoApply'] !== undefined && settings.autoApplyGlossary === undefined) {
        settings.autoApplyGlossary = settings['glossary.autoApply'];
        delete settings['glossary.autoApply'];
        migrated = true;
      }
      if (settings.overlay && typeof settings.overlay === 'object') {
        if (settings.overlay.showSourceText !== undefined && settings.showSourceTextInOverlay === undefined) {
          settings.showSourceTextInOverlay = settings.overlay.showSourceText;
          delete settings.overlay.showSourceText;
          migrated = true;
        }
        if (Object.keys(settings.overlay).length === 0) {
          delete settings.overlay;
          migrated = true;
        }
      }
      if (settings['overlay.showSourceText'] !== undefined && settings.showSourceTextInOverlay === undefined) {
        settings.showSourceTextInOverlay = settings['overlay.showSourceText'];
        delete settings['overlay.showSourceText'];
        migrated = true;
      }
      if (migrated) {
        this.store.set(settings);
        console.log('[Tuhua] Settings migrated: dot-notation keys converted to flat keys');
      }
      return settings;
    });

    ipcMain.handle('save-settings', async (event, data) => {
      if (typeof data !== 'object' || data === null) {
        return { success: false, error: 'Invalid settings data' };
      }

      // Merge with existing settings instead of replacing
      const currentSettings = this.store.get();
      const mergedSettings = { ...currentSettings, ...data };
      this.store.set(mergedSettings);

      // Update translation pipeline with new settings
      this.pipeline.updateSettings(mergedSettings);

      // Reconfigure Textractor if port changed
      if (data.textractorPort) {
        this.textractor.reconfigure(data.textractorPort);
        console.log(`[Tuhua] Textractor port changed to ${data.textractorPort} — reconnecting`);
      }

      // Update TextractorCLI path if changed
      if (data.textractorCliPath !== undefined) {
        this.textractorLauncher.configure(data.textractorCliPath);
      }

      // Switch input method
      // v3.11.3: ALL xuatServer.stop() calls are now AWAITED to prevent
      // the "Port already in use" race condition.
      // v3.13.08: Only run method switch logic if the input method actually changed.
      // gatherConfig() always sends inputMethod, so the previous code ran teardown/restart
      // on every "Apply & Save" click, causing the OCR capture area to disappear.
      const previousInputMethod = currentSettings.inputMethod;
      if (data.inputMethod && data.inputMethod !== previousInputMethod) {
        if (data.inputMethod === 'clipboard') {
          this.textractor.disconnect();
          this.textractorLauncher.kill();
          if (this.xuatServer) await this.xuatServer.stop();  // v3.11.3: AWAITED
          // v3.13.04: Stop OCR if switching FROM OCR to clipboard
          if (this._ocrActive) {
            try {
              this.ocrService.stopAutoCapture();
              await this.ocrService.terminate();
              this.windowManager.closeCaptureArea();
              this._ocrActive = false;
              if (this.shortcutManager) {
                this.shortcutManager.setOcrCaptureCallback(null);
              }
            } catch (e) {
              console.warn('[Tuhua] Error stopping OCR on method switch:', e.message);
            }
          }
          // v3.13.04: Re-show output overlay for clipboard mode
          if (this._translationActive) {
            this.windowManager.showOutputOverlay();
          }
          this.clipboardWatcher.start();
          // Notify renderer of new status
          setTimeout(() => {
            this.windowManager.sendToMainWindow('textractor-status', 'watching');
          }, 300);
        } else if (data.inputMethod === 'ocr') {
          // OCR mode — stop other input methods
          this.textractor.disconnect();
          this.textractorLauncher.kill();
          this.clipboardWatcher.stop();
          if (this.xuatServer) await this.xuatServer.stop();  // v3.11.3: AWAITED
          console.log('[Tuhua] OCR input method selected');
          // Don't auto-start OCR here — let the user click "Start OCR" in the settings
          // Just notify renderer of the mode
          setTimeout(() => {
            this.windowManager.sendToMainWindow('textractor-status', 'ocr');
          }, 300);
        } else if (data.inputMethod === 'xuat') {
          // XUAT mode — stop other input methods, but DON'T auto-start server
          // v3.11.11: Previous versions auto-started the server here, which
          // caused the bug where "Aplicar y Guardar" would restart the server
          // even after the user manually stopped it. Now we just switch the
          // input method and let the user control the server with the toggle.
          this.textractor.disconnect();
          this.textractorLauncher.kill();
          this.clipboardWatcher.stop();
          // v3.13.04: Stop OCR if switching FROM OCR to XUAT
          if (this._ocrActive) {
            try {
              this.ocrService.stopAutoCapture();
              await this.ocrService.terminate();
              this.windowManager.closeCaptureArea();
              this._ocrActive = false;
              if (this.shortcutManager) {
                this.shortcutManager.setOcrCaptureCallback(null);
              }
            } catch (e) {
              console.warn('[Tuhua] Error stopping OCR on method switch:', e.message);
            }
          }
          // v3.13.04: XUAT replaces text directly in the game, no overlay needed.
          // Hide and clear the output overlay when switching to XUAT mode.
          this.windowManager.hideOutputOverlay();
          this.windowManager.clearOverlayContent();
          console.log('[Tuhua] XUAT input method selected');
          // Update port if changed, but don't start the server
          if (this.xuatServer && data.xuatPort) {
            this.xuatServer.port = data.xuatPort;
          }
          this.windowManager.sendToMainWindow('textractor-status', 'xuat');
        } else {
          this.clipboardWatcher.stop();
          if (this.xuatServer) await this.xuatServer.stop();  // v3.11.3: AWAITED
          // v3.13.04: Stop OCR if switching FROM OCR to Textractor
          if (this._ocrActive) {
            try {
              this.ocrService.stopAutoCapture();
              await this.ocrService.terminate();
              this.windowManager.closeCaptureArea();
              this._ocrActive = false;
              if (this.shortcutManager) {
                this.shortcutManager.setOcrCaptureCallback(null);
              }
            } catch (e) {
              console.warn('[Tuhua] Error stopping OCR on method switch:', e.message);
            }
          }
          // v3.13.04: Re-show output overlay for Textractor mode (was hidden for XUAT)
          if (this._translationActive) {
            this.windowManager.showOutputOverlay();
          }
          // Textractor mode: always try to connect TCP as a secondary channel
          // (CLI stdout is primary, but TCP works if "Start Server" extension is present)
          const port = this.store.get('textractorPort') || 9251;
          console.log(`[Tuhua] Textractor mode — connecting TCP to port ${port}`);
          this.textractor.reconfigure(port);
          // Notify renderer
          setTimeout(() => {
            this.windowManager.sendToMainWindow('textractor-status', 'reconnecting');
          }, 300);
        }
      }

      // v3.13.10: When source language changes and OCR is active, update the OCR engine.
      // This was a critical bug — the OCR engine was only initialized with the language
      // set at startup, and changing the source language dropdown had no effect on
      // which OCR model was used. Korean text would never be recognized if the user
      // started OCR with 'auto' (defaults to English/Chinese) and then switched to Korean.
      if (data.sourceLang && data.sourceLang !== currentSettings.sourceLang && this._ocrActive) {
        const previousOcrLang = currentSettings.sourceLang || 'auto';
        console.log(`[Tuhua] Source language changed while OCR active: ${previousOcrLang} → ${data.sourceLang}, updating OCR engine`);
        try {
          await this.ocrService.setLanguage(data.sourceLang);
          console.log(`[Tuhua] OCR engine language updated to: ${data.sourceLang}`);
        } catch (ocrLangErr) {
          console.warn(`[Tuhua] Failed to update OCR language: ${ocrLangErr.message}`);
        }
      }

      // v3.13.12: Auto-retranslate when engine or source language changes but the
      // OCR text is the same (screen hasn't changed). Previously, changing the
      // translation engine (e.g., DeepL → Google) or source language (e.g., Korean
      // → Auto-detect) had no effect until the game screen changed, because the
      // OCR dedup blocked re-translation of identical text. Now we force a
      // retranslation with the new settings. Following VN Translator's approach
      // of immediately retranslating when translation settings change.
      const engineChanged = data.engine && data.engine !== currentSettings.engine;
      const sourceLangChanged = data.sourceLang && data.sourceLang !== currentSettings.sourceLang;
      const targetLangChanged = data.targetLang && data.targetLang !== currentSettings.targetLang;

      // v3.13.19: Reset Context Memory on any of these three changes — mixing
      // context lines from a different engine/source language/target language
      // into the next translation call ranges from meaningless (DeepL's
      // context must be the same language as the new source) to actively
      // misleading (an LLM engine would see prior turns in the old target
      // language while being told to now answer in a different one).
      if (engineChanged || sourceLangChanged || targetLangChanged) {
        this.pipeline.clearContext();
      }

      if ((engineChanged || sourceLangChanged || targetLangChanged) && this._lastHandledText) {
        const newEngine = data.engine || currentSettings.engine || 'google-free';
        const newSourceLang = data.sourceLang || currentSettings.sourceLang || 'auto';
        const newTargetLang = data.targetLang || currentSettings.targetLang || 'es';
        console.log(`[Tuhua] Settings changed while text is on-screen — auto-retranslating last text with ${newEngine} (${newSourceLang} → ${newTargetLang})`);
        // Use translateNow (no debounce) for immediate retranslation
        try {
          await this.pipeline.translateNow(this._lastHandledText, {
            source: newSourceLang,
            target: newTargetLang,
            engine: newEngine
          });
        } catch (retransErr) {
          console.warn(`[Tuhua] Auto-retranslation failed: ${retransErr.message}`);
        }
      }

      // Update overlay styles
      if (data.outputFontSize || data.outputTheme || data.overlayOpacity || data.overlayFontFamily) {
        this.windowManager.updateOverlayStyles({
          fontSize: data.outputFontSize,
          theme: data.outputTheme,
          opacity: data.overlayOpacity,
          fontFamily: data.overlayFontFamily
        });
      }

      // Handle click-through mode
      if (data.clickThrough !== undefined) {
        this.windowManager.toggleClickThrough(data.clickThrough);
      }

      // Handle xuatPort — only if inputMethod was NOT just switched to xuat
      // (avoid double start: inputMethod switch already handles port)
      if (data.xuatPort !== undefined && data.inputMethod !== 'xuat' && this.xuatServer) {
        if (this.xuatServer._running) {
          this.xuatServer.reconfigure(data.xuatPort).catch(err => {
            console.error('[Tuhua] XUAT reconfigure error:', err.message);
          });
        } else {
          this.xuatServer.port = data.xuatPort;
        }
      }

      // v3.11.17: XUAT language config is now updated ONLY when the user changes
      // XUAT-specific language selectors (autoSaveXuatLanguage in renderer).
      // Global sourceLang/targetLang changes should NOT affect XUAT config.
      // The xuat-update-language IPC handler uses xuatSourceLang/xuatTargetLang
      // from the store, which are set independently by the XUAT language selectors.

      // v3.13.06: Unified overlay visibility management.
      // Previously, engine change and translationActive toggle were handled
      // separately, causing race conditions when both arrive in the same
      // save-settings call. Now we determine the FINAL state of both flags
      // first, then apply overlay visibility ONCE at the end.

      // Update _translationActive if it changed
      if (data.translationActive !== undefined) {
        this._translationActive = data.translationActive;
        // v3.11.22: Resume/stop clipboard watcher when toggling
        const imForClipboard = data.inputMethod || this.store.get('inputMethod');
        if (data.translationActive && imForClipboard === 'clipboard') {
          this.clipboardWatcher.start();
        } else if (!data.translationActive && imForClipboard === 'clipboard') {
          this.clipboardWatcher.stop();
        }
      }

      // v3.13.07: Improved unified overlay visibility management.
      // Determine the FINAL overlay visibility based on current state.
      // Key fix: when switching FROM XUAT to another method, only show overlay
      // if translation is active. Also, always ensure overlay is hidden when paused.
      const finalInputMethod = data.inputMethod || this.store.get('inputMethod');
      const finalTranslationActive = this._translationActive;

      if (finalTranslationActive && finalInputMethod !== 'xuat') {
        // Translation is active AND not in XUAT mode — show overlay
        this.windowManager.showOutputOverlay();
      } else {
        // Translation is paused OR in XUAT mode — hide overlay and clear content
        this.windowManager.hideOutputOverlay();
        this.windowManager.clearOverlayContent();
      }

      return { success: true };
    });

    // ===== TextractorCLI =====
    ipcMain.handle('textractor-validate-cli', async (event, cliPath) => {
      if (typeof cliPath !== 'string') return { valid: false, message: 'Invalid path' };
      return this.textractorLauncher.validatePath(cliPath);
    });

    ipcMain.handle('textractor-browse-cli', async () => {
      const result = await dialog.showOpenDialog({
        title: 'Seleccionar carpeta de Textractor o TextractorCLI.exe',
        filters: [
          { name: 'Executable', extensions: ['exe'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'openDirectory']
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: '' };
      }
      const selectedPath = result.filePaths[0];
      // Validate the selected path (auto-resolves folders)
      const validation = this.textractorLauncher.validatePath(selectedPath);
      // If auto-resolved, return the resolved .exe path so the UI can update
      const returnPath = validation.resolved || selectedPath;
      return { canceled: false, path: returnPath, originalPath: selectedPath, valid: validation.valid, message: validation.message, autoResolved: validation.autoResolved };
    });

    ipcMain.handle('textractor-launch', async (event, { cliPath, gamePid, port: requestedPort }) => {
      if (!cliPath || !gamePid) {
        return { success: false, error: 'CLI path and Game PID are required' };
      }
      const pid = parseInt(gamePid);
      if (isNaN(pid) || pid <= 0) {
        return { success: false, error: 'Invalid Game PID' };
      }

      // Save the port from UI if provided (fix: port wasn't being saved on launch)
      const port = requestedPort || this.store.get('textractorPort') || 9251;
      if (requestedPort) {
        this.store.set({ ...this.store.get(), textractorPort: port });
        console.log(`[Tuhua] Textractor port saved: ${port}`);
      }

      // Configure launcher
      this.textractorLauncher.configure(cliPath);

      // Kill existing CLI process if any
      this.textractorLauncher.kill();

      // Launch TextractorCLI
      const launched = this.textractorLauncher.launch(pid, { cliPath });
      if (!launched) {
        return { success: false, error: 'Failed to launch TextractorCLI' };
      }

      // NOTE (v3.8.10): Spawn with NO args, send attach via stdin immediately + delayed
      // Hex diagnostics enabled for first 10 lines to debug encoding issues
      // 10s diagnostic warning if no game text found
      console.log(`[Tuhua] TextractorCLI launched (v3.8.10) — stdin attach (immediate + 1.5s), hex diagnostics ON, TCP (port ${port}) secondary`);
      setTimeout(() => {
        if (!this.textractor.isConnected) {
          this.textractor.reconfigure(port);
          console.log(`[Tuhua] TCP connection attempt to port ${port} (secondary channel)`);
        }
      }, 8000);

      return { success: true, message: 'TextractorCLI launched' };
    });

    ipcMain.handle('textractor-kill', async () => {
      this.textractorLauncher.kill();
      this.textractor.disconnect();
      return { success: true };
    });

    ipcMain.handle('textractor-cli-status', async () => {
      return {
        isRunning: this.textractorLauncher.isRunning,
        cliPath: this.textractorLauncher.cliPath,
        processPid: this.textractorLauncher.getProcessPid(),
        isConfigured: this.textractorLauncher.isConfigured(),
        stats: this.textractorLauncher.getStats()
      };
    });

    ipcMain.handle('textractor-cli-output', async () => {
      return this.textractorLauncher.getOutput();
    });

    ipcMain.handle('textractor-select-hook', async (event, hookKey) => {
      this.textractorLauncher.selectHook(hookKey || null);
      return { success: true, activeHookKey: this.textractorLauncher.getActiveHookKey() };
    });

    // ===== TextractorCLI Test (v3.8.23) =====
    ipcMain.handle('textractor-test-cli', async (event, cliPath) => {
      if (typeof cliPath !== 'string') return { canStart: false, hint: 'Ruta inválida' };
      console.log(`[Tuhua] Testing TextractorCLI: ${cliPath}`);
      const result = await this.textractorLauncher.testLaunch(cliPath);
      console.log(`[Tuhua] Test result: canStart=${result.canStart}, hint="${result.hint}"`);
      return result;
    });

    // ===== Glossary =====
    ipcMain.handle('get-glossary', () => {
      return this.glossary.getAll();
    });

    ipcMain.handle('save-glossary', (event, entry) => {
      if (!entry || typeof entry.source !== 'string' || typeof entry.target !== 'string') {
        return { success: false, error: 'Invalid glossary entry' };
      }
      if (entry.id) {
        this.glossary.update(entry.id, entry);
      } else {
        this.glossary.add(entry);
      }
      return { success: true };
    });

    ipcMain.handle('delete-glossary-entry', (event, id) => {
      if (typeof id !== 'string') return { success: false, error: 'Invalid ID' };
      this.glossary.delete(id);
      return { success: true };
    });

    ipcMain.handle('import-glossary', async (event, filePath) => {
      try {
        const count = this.glossary.importFromFile(filePath);
        return { success: true, imported: count };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('export-glossary', async (event, filePath) => {
      try {
        const count = this.glossary.exportToFile(filePath);
        return { success: true, exported: count };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // ===== Regex Filter (v3.11.30) =====
    ipcMain.handle('get-regex-filters', () => {
      return this.regexFilter.getAll();
    });

    ipcMain.handle('save-regex-filter', (event, entry) => {
      if (!entry || typeof entry.pattern !== 'string') {
        return { success: false, error: 'Invalid filter entry' };
      }
      if (entry.id && !entry.isBuiltIn) {
        this.regexFilter.update(entry.id, entry);
        return { success: true, entry: this.regexFilter.getById(entry.id) };
      } else {
        const newEntry = this.regexFilter.add(entry);
        return { success: true, entry: newEntry };
      }
    });

    ipcMain.handle('delete-regex-filter', (event, id) => {
      if (typeof id !== 'string') return { success: false, error: 'Invalid ID' };
      const deleted = this.regexFilter.delete(id);
      return { success: deleted };
    });

    ipcMain.handle('toggle-regex-filter', (event, id, enabled) => {
      if (typeof id !== 'string') return { success: false, error: 'Invalid ID' };
      const updated = this.regexFilter.toggle(id, enabled);
      return { success: !!updated, entry: updated };
    });

    ipcMain.handle('reorder-regex-filters', (event, orderedIds) => {
      if (!Array.isArray(orderedIds)) return { success: false, error: 'Invalid order' };
      this.regexFilter.reorder(orderedIds);
      return { success: true };
    });

    ipcMain.handle('test-regex-filter', (event, text, filterId) => {
      if (typeof text !== 'string') return { text: '', steps: [] };
      return this.regexFilter.test(text, filterId || null);
    });

    ipcMain.handle('reset-regex-filters', () => {
      this.regexFilter.resetToDefaults();
      return { success: true };
    });

    // ===== HOOK Cleaning Settings (v3.13.21) =====
    // Deliberately no reorder handler, unlike regex filters above — the
    // five steps have a fixed, order-dependent pipeline (see
    // hook-cleaning-settings.js's header comment for why letting a user
    // reorder them would be unsafe, not just unsupported).
    ipcMain.handle('get-hook-cleaning-steps', () => {
      if (!this.hookCleaningSettings) return [];
      return this.hookCleaningSettings.getAll();
    });

    ipcMain.handle('toggle-hook-cleaning-step', (event, id, enabled) => {
      if (!this.hookCleaningSettings) return { success: false, error: 'Service not available' };
      if (typeof id !== 'string') return { success: false, error: 'Invalid ID' };
      const updated = this.hookCleaningSettings.toggle(id, enabled);
      return { success: !!updated, entry: updated };
    });

    ipcMain.handle('set-hook-cleaning-cjk-only', (event, id, cjkOnly) => {
      if (!this.hookCleaningSettings) return { success: false, error: 'Service not available' };
      if (typeof id !== 'string') return { success: false, error: 'Invalid ID' };
      const updated = this.hookCleaningSettings.setCjkOnly(id, cjkOnly);
      return { success: !!updated, entry: updated };
    });

    ipcMain.handle('reset-hook-cleaning-steps', () => {
      if (!this.hookCleaningSettings) return { success: false, error: 'Service not available' };
      this.hookCleaningSettings.resetToDefaults();
      return { success: true };
    });

    // ===== VNDB Glossary Import (v3.11.25) =====
    // Search VNDB for visual novels by title
    ipcMain.handle('vndb-search', async (event, query) => {
      if (typeof query !== 'string' || query.trim().length < 2) {
        return { success: false, error: 'Query too short (minimum 2 characters)' };
      }
      try {
        const results = await this.vndbService.searchVN(query);
        return { success: true, results };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Import glossary entries from a VNDB visual novel
    ipcMain.handle('vndb-import', async (event, vnId, options) => {
      if (typeof vnId !== 'string' || !vnId.match(/^v\d+$/)) {
        return { success: false, error: 'Invalid VNDB VN ID (format: v123)' };
      }
      try {
        const importResult = await this.vndbService.importGlossary(vnId, options || {});

        // Add all imported entries to the glossary
        let addedCount = 0;
        for (const entry of importResult.entries) {
          // Check for duplicates before adding
          const existing = this.glossary.getAll();
          const isDuplicate = existing.some(e =>
            e.source === entry.source && e.target === entry.target
          );
          if (!isDuplicate) {
            this.glossary.add({
              source: entry.source,
              target: entry.target,
              mode: entry.mode || 'case-insensitive',
              enabled: true
            });
            addedCount++;
          }
        }

        return {
          success: true,
          imported: addedCount,
          duplicates: importResult.stats.total - addedCount,
          stats: importResult.stats
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // ===== History =====
    ipcMain.handle('get-history', () => {
      return this.pipeline.getHistory();
    });

    ipcMain.handle('clear-history', () => {
      this.pipeline.clearHistory();
      return { success: true };
    });

    // ===== Context Memory =====
    ipcMain.handle('clear-context', () => {
      this.pipeline.clearContext();
      return { success: true };
    });

    ipcMain.handle('export-history', async (event, filePath) => {
      try {
        const history = this.pipeline.getHistory();
        fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
        return { success: true, count: history.length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // ===== Profiles =====
    // v3.10.7: Complete profile system rewrite.
    // - Default profile "Por Defecto" is always present and cannot be deleted
    // - Profiles store ONLY profile-scoped data (not global settings)
    // - Active profile is tracked in store.activeProfile
    // - Loading a profile saves current profile data first, then loads new profile
    // - Glossary per-profile toggle is GLOBAL and never changes with profile

    ipcMain.handle('get-profiles', () => {
      const profiles = this.store.get('profiles', []);
      const activeProfile = this.store.get('activeProfile', 'Por Defecto');
      // Ensure default profile always exists
      const hasDefault = profiles.some(p => p.name === 'Por Defecto');
      if (!hasDefault) {
        const currentSettings = this.store.get();
        profiles.unshift({
          name: 'Por Defecto',
          isDefault: true,
          sourceLang: currentSettings.sourceLang || 'auto',
          targetLang: currentSettings.targetLang || 'es',
          inputMethod: currentSettings.inputMethod || 'textractor',
          engine: currentSettings.engine || 'google-free',
          deeplKey: currentSettings.deeplKey || '',
          openaiKey: currentSettings.openaiKey || '',
          customEndpoint: currentSettings.customEndpoint || '',
          customModel: currentSettings.customModel || '',
          libretranslateEndpoint: currentSettings.libretranslateEndpoint || '',
          customMTEndpoint: currentSettings.customMTEndpoint || '',
          customMTMethod: currentSettings.customMTMethod || '',
          customMTBody: currentSettings.customMTBody || '',
          customMTResponsePath: currentSettings.customMTResponsePath || '',
          customMTAuthHeader: currentSettings.customMTAuthHeader || '',
          textractorCliPath: currentSettings.textractorCliPath || '',
          textractorPort: currentSettings.textractorPort || 9251,
          manualTextractorMode: currentSettings.manualTextractorMode || false,
          glossary: this.glossary.getAll(),
          history: this.pipeline.getHistory(),
          savedAt: Date.now()
        });
        this.store.set('profiles', profiles);
      }
      return { profiles, activeProfile };
    });

    ipcMain.handle('save-profile', (event, profile) => {
      if (!profile || typeof profile.name !== 'string') {
        return { success: false, error: 'Invalid profile' };
      }
      const profiles = this.store.get('profiles', []);
      const idx = profiles.findIndex(p => p.name === profile.name);

      // Profiles ONLY store profile-scoped data (not global settings)
      const currentSettings = this.store.get();
      const profileData = {
        name: profile.name,
        isDefault: profile.name === 'Por Defecto',
        // Language preferences
        sourceLang: currentSettings.sourceLang,
        targetLang: currentSettings.targetLang,
        // Input method
        inputMethod: currentSettings.inputMethod,
        // Translation engine + config
        engine: currentSettings.engine,
        deeplKey: currentSettings.deeplKey || '',
        openaiKey: currentSettings.openaiKey || '',
        apiKey: currentSettings.apiKey || '',
        customEndpoint: currentSettings.customEndpoint || '',
        customModel: currentSettings.customModel || '',
        libretranslateEndpoint: currentSettings.libretranslateEndpoint || '',
        customMTEndpoint: currentSettings.customMTEndpoint || '',
        customMTMethod: currentSettings.customMTMethod || '',
        customMTBody: currentSettings.customMTBody || '',
        customMTResponsePath: currentSettings.customMTResponsePath || '',
        customMTAuthHeader: currentSettings.customMTAuthHeader || '',
        // Glossary (only saved to profile if glossary.perProfile is enabled)
        glossary: this.glossary.getAll(),
        // Translation history
        history: this.pipeline.getHistory(),
        // Textractor config
        textractorCliPath: currentSettings.textractorCliPath || '',
        textractorPort: currentSettings.textractorPort || 9251,
        manualTextractorMode: currentSettings.manualTextractorMode || false,
        savedAt: Date.now()
      };

      if (idx >= 0) {
        profileData.isDefault = profiles[idx].isDefault || profile.name === 'Por Defecto';
        profiles[idx] = profileData;
      } else {
        profiles.push(profileData);
      }
      this.store.set('profiles', profiles);

      // Update active profile if this is the current one
      const activeProfile = this.store.get('activeProfile', 'Por Defecto');
      if (activeProfile === profile.name) {
        // Already active, just saved
      }

      return { success: true };
    });

    ipcMain.handle('create-profile', (event, { name, cloneFrom }) => {
      if (!name || typeof name !== 'string') {
        return { success: false, error: 'Invalid profile name' };
      }
      const profiles = this.store.get('profiles', []);
      if (profiles.some(p => p.name === name)) {
        return { success: false, error: 'Profile name already exists' };
      }

      // Clone from current active profile or specified profile
      const sourceName = cloneFrom || this.store.get('activeProfile', 'Por Defecto');
      const sourceProfile = profiles.find(p => p.name === sourceName);

      const newProfile = sourceProfile
        ? { ...sourceProfile, name, isDefault: false, savedAt: Date.now() }
        : {
            name,
            isDefault: false,
            sourceLang: this.store.get('sourceLang', 'auto'),
            targetLang: this.store.get('targetLang', 'es'),
            inputMethod: this.store.get('inputMethod', 'textractor'),
            engine: this.store.get('engine', 'google-free'),
            deeplKey: '', openaiKey: '', apiKey: '',
            customEndpoint: '', customModel: '',
            libretranslateEndpoint: '',
            customMTEndpoint: '', customMTMethod: '',
            customMTBody: '', customMTResponsePath: '', customMTAuthHeader: '',
            textractorCliPath: this.store.get('textractorCliPath', ''),
            textractorPort: this.store.get('textractorPort', 9251),
            manualTextractorMode: this.store.get('manualTextractorMode', false),
            glossary: this.glossary.getAll(),
            history: [],
            savedAt: Date.now()
          };

      profiles.push(newProfile);
      this.store.set('profiles', profiles);
      return { success: true };
    });

    ipcMain.handle('delete-profile', (event, name) => {
      if (name === 'Por Defecto') {
        return { success: false, error: 'Cannot delete the default profile' };
      }
      let profiles = this.store.get('profiles', []);
      profiles = profiles.filter(p => p.name !== name);
      this.store.set('profiles', profiles);
      // If deleting the active profile, switch to default
      const activeProfile = this.store.get('activeProfile', 'Por Defecto');
      if (activeProfile === name) {
        this.store.set('activeProfile', 'Por Defecto');
      }
      return { success: true };
    });

    ipcMain.handle('load-profile', (event, name) => {
      const profiles = this.store.get('profiles', []);
      const profile = profiles.find(p => p.name === name);
      if (!profile) return { success: false, error: 'Profile not found' };

      // v3.10.7: Save current profile data BEFORE loading new one
      const currentActiveProfile = this.store.get('activeProfile', 'Por Defecto');
      if (currentActiveProfile !== name) {
        const currentProfileIdx = profiles.findIndex(p => p.name === currentActiveProfile);
        if (currentProfileIdx >= 0) {
          const currentSettings = this.store.get();
          profiles[currentProfileIdx] = {
            ...profiles[currentProfileIdx],
            sourceLang: currentSettings.sourceLang,
            targetLang: currentSettings.targetLang,
            inputMethod: currentSettings.inputMethod,
            engine: currentSettings.engine,
            deeplKey: currentSettings.deeplKey || '',
            openaiKey: currentSettings.openaiKey || '',
            customEndpoint: currentSettings.customEndpoint || '',
            customModel: currentSettings.customModel || '',
            libretranslateEndpoint: currentSettings.libretranslateEndpoint || '',
            customMTEndpoint: currentSettings.customMTEndpoint || '',
            customMTMethod: currentSettings.customMTMethod || '',
            customMTBody: currentSettings.customMTBody || '',
            customMTResponsePath: currentSettings.customMTResponsePath || '',
            customMTAuthHeader: currentSettings.customMTAuthHeader || '',
            textractorCliPath: currentSettings.textractorCliPath || '',
            textractorPort: currentSettings.textractorPort || 9251,
            manualTextractorMode: currentSettings.manualTextractorMode || false,
            glossary: this.glossary.getAll(),
            history: this.pipeline.getHistory(),
            savedAt: Date.now()
          };
        }
      }

      // ONLY restore profile-scoped data. Global settings are NOT touched.
      const profileSettings = {};
      if (profile.sourceLang !== undefined) profileSettings.sourceLang = profile.sourceLang;
      if (profile.targetLang !== undefined) profileSettings.targetLang = profile.targetLang;
      if (profile.inputMethod !== undefined) profileSettings.inputMethod = profile.inputMethod;
      if (profile.engine !== undefined) profileSettings.engine = profile.engine;
      if (profile.deeplKey !== undefined) profileSettings.deeplKey = profile.deeplKey;
      if (profile.openaiKey !== undefined) profileSettings.openaiKey = profile.openaiKey;
      if (profile.customEndpoint !== undefined) profileSettings.customEndpoint = profile.customEndpoint;
      if (profile.customModel !== undefined) profileSettings.customModel = profile.customModel;
      if (profile.libretranslateEndpoint !== undefined) profileSettings.libretranslateEndpoint = profile.libretranslateEndpoint;
      if (profile.customMTEndpoint !== undefined) profileSettings.customMTEndpoint = profile.customMTEndpoint;
      if (profile.customMTMethod !== undefined) profileSettings.customMTMethod = profile.customMTMethod;
      if (profile.customMTBody !== undefined) profileSettings.customMTBody = profile.customMTBody;
      if (profile.customMTResponsePath !== undefined) profileSettings.customMTResponsePath = profile.customMTResponsePath;
      if (profile.customMTAuthHeader !== undefined) profileSettings.customMTAuthHeader = profile.customMTAuthHeader;
      if (profile.textractorCliPath !== undefined) profileSettings.textractorCliPath = profile.textractorCliPath;
      if (profile.textractorPort !== undefined) profileSettings.textractorPort = profile.textractorPort;
      if (profile.manualTextractorMode !== undefined) profileSettings.manualTextractorMode = profile.manualTextractorMode;

      // Apply profile-scoped settings (preserving ALL global settings)
      const mergedSettings = { ...this.store.get(), ...profileSettings };
      this.store.set(mergedSettings);
      this.pipeline.updateSettings(profileSettings);

      // v3.13.19: A profile switch is the closest thing this app has to
      // "changed games" — the previous game's dialogue context must not
      // bleed into the new one.
      this.pipeline.clearContext();

      // Restore glossary: only if glossary.perProfile is enabled
      const perProfileGlossary = this.store.get('perProfileGlossary', false);
      if (perProfileGlossary && profile.glossary && Array.isArray(profile.glossary)) {
        this.glossary.replaceAll(profile.glossary);
      }
      // If per-profile glossary is OFF, don't touch the glossary (it's global)

      // Restore history (always per-profile)
      const historyLimit = this.store.get('historyLimit', 5);
      if (profile.history && Array.isArray(profile.history)) {
        const limitedHistory = historyLimit > 0 ? profile.history.slice(0, historyLimit) : [];
        this.pipeline.replaceHistory(limitedHistory);
      } else {
        this.pipeline.replaceHistory([]);
      }

      // Update active profile
      this.store.set('activeProfile', name);

      // Save updated profiles (with previous profile data saved)
      this.store.set('profiles', profiles);

      return { success: true, settings: profileSettings, activeProfile: name, hasGlossary: !!(profile.glossary && profile.glossary.length), hasHistory: !!(profile.history && profile.history.length) };
    });

    ipcMain.handle('get-active-profile', () => {
      return this.store.get('activeProfile', 'Por Defecto');
    });

    // ===== API Key Validation =====
    ipcMain.handle('validate-api-key', async (event, { engine, apiKey, endpoint }) => {
      try {
        switch (engine) {
          case 'deepl': {
            const endpoints = [
              { url: 'https://api-free.deepl.com/v2', label: 'Free' },
              { url: 'https://api.deepl.com/v2', label: 'Pro' }
            ];

            if (apiKey.endsWith(':fx')) {
              endpoints.reverse();
            }

            let lastError = null;
            for (const ep of endpoints) {
              try {
                const resp = await axios.get(`${ep.url}/usage`, {
                  timeout: 8000,
                  headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}` }
                });
                if (resp.data && resp.data.character_count !== undefined) {
                  const used = resp.data.character_count;
                  const limit = resp.data.character_limit;
                  return { valid: true, code: 'deepl_key_valid', params: { type: ep.label, used: used.toLocaleString(), limit: limit.toLocaleString() } };
                }
                return { valid: true, code: 'deepl_key_valid_short', params: { type: ep.label } };
              } catch (err) {
                lastError = err;
                if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                  continue;
                }
                break;
              }
            }

            if (lastError && lastError.response) {
              const status = lastError.response.status;
              if (status === 401 || status === 403) {
                return { valid: false, code: 'deepl_key_invalid', params: {} };
              }
              return { valid: false, code: 'api_error', params: { status, message: lastError.response.data?.error?.message || lastError.message } };
            }
            throw lastError;
          }

          case 'openai': {
            const resp = await axios.get('https://api.openai.com/v1/models', {
              timeout: 8000,
              headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (resp.data && resp.data.data) {
              return { valid: true, code: 'openai_key_valid', params: { count: resp.data.data.length } };
            }
            return { valid: true, code: 'key_valid', params: {} };
          }

          case 'local-llm': {
            const base = endpoint || 'http://localhost:1234/v1';
            const resp = await axios.get(`${base}/models`, { timeout: 5000 });
            if (resp.data) {
              const models = resp.data.data || resp.data;
              const count = Array.isArray(models) ? models.length : 0;
              return { valid: true, code: 'local_connected', params: { count } };
            }
            return { valid: true, code: 'local_connected_short', params: {} };
          }

          case 'libretranslate': {
            const base = endpoint || 'http://localhost:5000';
            const resp = await axios.get(`${base}/languages`, { timeout: 5000 });
            if (resp.data && Array.isArray(resp.data)) {
              return { valid: true, code: 'libre_connected', params: { count: resp.data.length } };
            }
            return { valid: true, code: 'libre_connected_short', params: {} };
          }

          case 'custom-mt': {
            if (!endpoint) {
              return { valid: false, code: 'endpoint_not_configured', params: {} };
            }
            try {
              await axios.head(endpoint, { timeout: 5000 });
              return { valid: true, code: 'endpoint_reachable', params: {} };
            } catch (headErr) {
              try {
                await axios.get(endpoint, { timeout: 5000 });
                return { valid: true, code: 'endpoint_reachable', params: {} };
              } catch (getErr) {
                if (getErr.response) {
                  return { valid: true, code: 'endpoint_responding', params: {} };
                }
                throw getErr;
              }
            }
          }

          default:
            return { valid: false, code: 'engine_not_supported', params: { engine } };
        }
      } catch (err) {
        if (err.response) {
          const status = err.response.status;
          if (status === 401 || status === 403) {
            return { valid: false, code: 'api_key_invalid', params: {} };
          }
          if (status === 404) {
            return { valid: false, code: 'endpoint_not_found', params: {} };
          }
          return { valid: false, code: 'api_error', params: { status, message: err.response.data?.error?.message || err.message } };
        }
        if (err.code === 'ECONNREFUSED') {
          return { valid: false, code: 'connection_refused', params: {} };
        }
        if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
          return { valid: false, code: 'connection_timeout', params: {} };
        }
        if (err.code === 'ENOTFOUND') {
          return { valid: false, code: 'host_not_found', params: {} };
        }
        return { valid: false, code: 'api_error', params: { status: 0, message: err.message } };
      }
    });

    // ===== DeepL Feature Detection (v3.11.28) =====
    // Fetch language features from /v3/languages to dynamically show/hide UI options
    ipcMain.handle('deepl-fetch-features', async (event, { apiKey }) => {
      if (!apiKey || typeof apiKey !== 'string') {
        return { success: false, error: 'API key required', features: null };
      }
      try {
        const isFree = apiKey.endsWith(':fx');
        const baseUrl = isFree
          ? 'https://api-free.deepl.com/v3/languages'
          : 'https://api.deepl.com/v3/languages';

        const response = await axios.get(baseUrl, {
          params: { resource: 'translate_text' },
          timeout: 8000,
          headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}` }
        });

        if (response.data && Array.isArray(response.data)) {
          const features = {};
          for (const lang of response.data) {
            features[lang.lang.toLowerCase()] = {
              formality: 'formality' in (lang.features || {}),
              style_rules: 'style_rules' in (lang.features || {}),
              glossary: 'glossary' in (lang.features || {}),
              tag_handling: 'tag_handling' in (lang.features || {})
            };
          }
          return { success: true, features, languageCount: Object.keys(features).length };
        }
        return { success: false, error: 'Unexpected response format', features: null };
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        console.warn(`[DeepL] /v3/languages failed: HTTP ${status || 'N/A'} — ${msg}`);
        return { success: false, error: `HTTP ${status || 'N/A'}: ${msg}`, features: null };
      }
    });

    // v3.11.28: Fetch DeepL Translation Memories from user's account
    ipcMain.handle('deepl-fetch-translation-memories', async (event, { apiKey }) => {
      if (!apiKey || typeof apiKey !== 'string') {
        return { success: false, error: 'API key required', memories: [] };
      }
      try {
        const isFree = apiKey.endsWith(':fx');
        const baseUrl = isFree
          ? 'https://api-free.deepl.com/v3/translation_memories'
          : 'https://api.deepl.com/v3/translation_memories';

        const response = await axios.get(baseUrl, {
          timeout: 8000,
          headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}` }
        });

        if (response.data && response.data.translation_memories) {
          return {
            success: true,
            memories: response.data.translation_memories.map(tm => ({
              id: tm.translation_memory_id,
              name: tm.name,
              sourceLanguage: tm.source_language,
              targetLanguages: tm.target_languages,
              segmentCount: tm.segment_count
            }))
          };
        }
        return { success: false, error: 'No translation memories found', memories: [] };
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        console.warn(`[DeepL] /v3/translation_memories failed: HTTP ${status || 'N/A'} — ${msg}`);
        return { success: false, error: `HTTP ${status || 'N/A'}: ${msg}`, memories: [] };
      }
    });

    // ===== Connection Test =====
    ipcMain.handle('test-connection', async (event, { host, port }) => {
      return new Promise((resolve) => {
        const net = require('net');
        const socket = new net.Socket();
        socket.setTimeout(3000);
        socket.on('connect', () => {
          socket.destroy();
          resolve({ success: true, message: 'Connection successful' });
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve({ success: false, message: 'Connection timed out' });
        });
        socket.on('error', (err) => {
          socket.destroy();
          resolve({ success: false, message: err.message });
        });
        socket.connect(port, host);
      });
    });

    // ===== Font Family Auto-Detection =====
    ipcMain.handle('detect-font-family', (event, { sourceLang }) => {
      const FONT_MAP = {
        'ja': "'Meiryo', 'MS Gothic', 'Noto Sans JP', sans-serif",
        'zh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', sans-serif",
        'lzh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', serif",
        'ko': "'Noto Sans KR', 'Malgun Gothic', sans-serif",
        'th': "'Tahoma', 'Noto Sans Thai', sans-serif",
        'vi': "'Tahoma', 'Noto Sans', sans-serif",
        'ar': "'Tahoma', 'Noto Sans Arabic', sans-serif",
        'hi': "'Tahoma', 'Noto Sans Devanagari', sans-serif",
        'ru': "'Segoe UI', 'Noto Sans', sans-serif",
        'auto': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif"
      };
      const defaultFont = "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif";
      const font = FONT_MAP[sourceLang] || defaultFont;
      return { fontFamily: font, language: sourceLang };
    });

    // ===== Manual Translation =====
    ipcMain.on('manual-translate', (event, text) => {
      if (typeof text !== 'string' || text.length === 0) return;
      this._handleText(text);
    });

    // ===== OCR =====
    ipcMain.handle('ocr-start', async () => {
      try {
        const settings = this.store.get();
        const sourceLang = settings.sourceLang || 'ja';

        // v3.13.01: Restore OCR engine from settings before initializing
        if (settings.ocrEngine) {
          this.ocrService.setOcrEngine(settings.ocrEngine);
        }

        // v3.13.08: Restore min confidence from settings (default: 0 = no minimum)
        if (settings.ocrMinConfidence !== undefined) {
          this.ocrService.setMinConfidence(settings.ocrMinConfidence);
        }

        // Create and show capture area window
        this.windowManager.createCaptureArea();
        this.windowManager.showCaptureArea();

        // Initialize OCR service with the source language
        await this.ocrService.initialize(sourceLang);

        // v3.13.01-fix: Check if OCR service actually became ready after initialization.
        // If PaddleOCR failed and auto-fell back to Tesseract, the service should be ready
        // via Tesseract. If BOTH failed, we need to handle it here.
        if (!this.ocrService._isReady) {
          console.error('[OCR] Failed to initialize any OCR engine');
          this.windowManager.closeCaptureArea();
          return { success: false, error: 'Failed to initialize any OCR engine. Check logs for details.' };
        }

        // Forward OCR text events to the translation pipeline
        this.ocrService.removeAllListeners('text'); // Remove previous listeners
        this.ocrService.on('text', (text) => {
          console.log(`[OCR] Text recognized: "${text.substring(0, 50)}..."`);
          this._handleText(text);
        });

        // Forward OCR status to renderer
        this.ocrService.removeAllListeners('status');
        this.ocrService.on('status', (status) => {
          this.windowManager.sendToMainWindow('ocr-status', status);
          this.windowManager.sendToCaptureArea('shortcut-pressed', { action: 'ocr-status', state: status });
        });

        // Forward OCR errors
        this.ocrService.removeAllListeners('error');
        this.ocrService.on('error', (err) => {
          console.error('[OCR] Error:', err.message);
          this.windowManager.sendToMainWindow('ocr-status', 'error');
        });

        // v3.13.01-fix: Listen for PaddleOCR fallback event
        this.ocrService.removeAllListeners('paddle-fallback');
        this.ocrService.on('paddle-fallback', ({ reason }) => {
          console.warn(`[OCR] PaddleOCR fell back to Tesseract: ${reason}`);
          // Update the store to reflect the actual engine being used
          this.store.set('ocrEngine', 'tesseract');
          // Notify the renderer so the UI can update
          this.windowManager.sendToMainWindow('ocr-engine-fallback', {
            engine: 'tesseract',
            reason: reason
          });
        });

        this._ocrActive = true;

        // v3.11.25: Register OCR capture callback for global hotkey (Ctrl+Shift+S)
        // When the user presses the hotkey, it performs an immediate single capture
        // and sends the result through the translation pipeline.
        if (this.shortcutManager) {
          this.shortcutManager.setOcrCaptureCallback(async () => {
            if (!this._ocrActive || !this.ocrService._isReady) {
              console.log('[OCR] Hotkey capture skipped: OCR not active/ready');
              return;
            }
            try {
              const imageBuffer = await this._captureScreenRegion();
              if (!imageBuffer) return;
              await this.ocrService.recognize(imageBuffer);
            } catch (err) {
              console.error('[OCR] Hotkey capture error:', err.message);
            }
          });
        }

        // Apply best preprocessing defaults automatically (grayscale ON, smart threshold)
        this.ocrService.setPreprocessing({
          grayscale: true,
          threshold: false,
          thresholdValue: 128,
          contrast: false,
          contrastValue: 1.5
        });

        // Always start auto-capture with smart change detection
        this._startOcrAutoCapture();

        // v3.13.01-fix: Return actual engine used (may differ from requested if fallback occurred)
        const actualEngine = this.ocrService.getOcrEngine();
        return { success: true, status: this.ocrService.getStatus(), engine: actualEngine };
      } catch (err) {
        console.error('[OCR] Start error:', err.message);
        // Clean up: close capture area if start failed
        this.windowManager.closeCaptureArea();
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('ocr-stop', async () => {
      try {
        this._ocrAutoCapture = false;
        this.ocrService.stopAutoCapture();
        await this.ocrService.terminate();
        this.windowManager.closeCaptureArea();
        this._ocrActive = false;
        // v3.11.25: Clear OCR hotkey callback when OCR stops
        if (this.shortcutManager) {
          this.shortcutManager.setOcrCaptureCallback(null);
        }
        return { success: true };
      } catch (err) {
        console.error('[OCR] Stop error:', err.message);
        return { success: false, error: err.message };
      }
    });

    // v3.13.01: Set OCR engine (tesseract or paddle)
    ipcMain.handle('set-ocr-engine', async (_event, engine) => {
      try {
        this.ocrService.setOcrEngine(engine);
        this.store.set('ocrEngine', engine);
        console.log(`[Tuhua] OCR engine set to: ${engine}`);
        return { success: true, engine: this.ocrService.getOcrEngine() };
      } catch (err) {
        console.error('[Tuhua] Error setting OCR engine:', err.message);
        return { success: false, error: err.message };
      }
    });

    // v3.13.01: Get OCR engine status
    ipcMain.handle('get-ocr-engine-status', async () => {
      return {
        current: this.ocrService.getOcrEngine(),
        paddleAvailable: this.ocrService.isPaddleAvailable(),
        paddleStatus: this.ocrService.getPaddleDownloadProgress()
      };
    });

    ipcMain.handle('ocr-capture', async () => {
      if (!this._ocrActive || !this.ocrService._isReady) {
        return { success: false, error: 'OCR not initialized' };
      }
      try {
        const imageBuffer = await this._captureScreenRegion();
        if (!imageBuffer) {
          return { success: false, error: 'Failed to capture screen' };
        }
        const result = await this.ocrService.recognize(imageBuffer);
        return { success: true, text: result.text, confidence: result.confidence };
      } catch (err) {
        console.error('[OCR] Capture error:', err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('ocr-set-language', async (event, lang) => {
      if (typeof lang !== 'string') return { success: false, error: 'Invalid language' };
      try {
        await this.ocrService.setLanguage(lang);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('ocr-set-interval', async (event, ms) => {
      if (typeof ms !== 'number' || ms < 300) return { success: false, error: 'Invalid interval' };
      this.store.set('ocrAutoCaptureMs', ms);
      // If auto-capture is running, restart with new interval
      if (this._ocrAutoCapture && this.ocrService.isAutoCapturing) {
        this._startOcrAutoCapture();
      }
      return { success: true };
    });

    ipcMain.handle('ocr-set-preprocessing', async (event, options) => {
      if (typeof options !== 'object' || options === null) return { success: false, error: 'Invalid options' };
      this.ocrService.setPreprocessing(options);
      this.store.set('ocrPreprocessing', options);
      return { success: true };
    });

    // v3.13.08: Set Tesseract minimum confidence threshold
    ipcMain.handle('ocr-set-min-confidence', async (event, threshold) => {
      if (typeof threshold !== 'number') return { success: false, error: 'Must be a number' };
      const clamped = Math.max(0, Math.min(100, threshold));
      this.ocrService.setMinConfidence(clamped);
      this.store.set('ocrMinConfidence', clamped);
      return { success: true, minConfidence: clamped };
    });

    ipcMain.handle('ocr-status', async () => {
      return this.ocrService.getStatus();
    });

    ipcMain.handle('ocr-set-auto-capture', async (event, enabled) => {
      if (typeof enabled !== 'boolean') return { success: false, error: 'Must be boolean' };
      this._ocrAutoCapture = enabled;
      this.store.set('ocrAutoCapture', enabled);

      if (enabled && this._ocrActive) {
        this._startOcrAutoCapture();
      } else {
        this.ocrService.stopAutoCapture();
      }
      return { success: true };
    });

    ipcMain.handle('ocr-close-capture-area', async () => {
      this.windowManager.closeCaptureArea();
      return { success: true };
    });

    // v3.9.6: Pause/resume OCR scanning from capture area overlay.
    // This ONLY controls the auto-capture scanning loop — it does NOT
    // affect the main Tuhua ▶ Activo toggle (which controls translation).
    ipcMain.handle('ocr-toggle-scan', async () => {
      if (!this._ocrActive) {
        return { success: false, error: 'OCR not initialized', scanning: false };
      }

      if (this.ocrService.isAutoCapturing) {
        // Pause scanning — stop auto-capture but keep worker alive
        this.ocrService.stopAutoCapture();
        this._ocrScanPaused = true;
        console.log('[OCR] Scan paused from capture area overlay');
        return { success: true, scanning: false };
      } else {
        // Resume scanning — restart auto-capture
        this._ocrScanPaused = false;
        this._startOcrAutoCapture();
        console.log('[OCR] Scan resumed from capture area overlay');
        return { success: true, scanning: true };
      }
    });

    ipcMain.handle('get-displays', async () => {
      const { screen } = require('electron');
      return screen.getAllDisplays();
    });

    // v3.9.7: Output overlay auto-resize.
    // The output overlay requests a height change based on its text content.
    // Main process resizes the BrowserWindow accordingly.
    ipcMain.handle('resize-overlay', async (event, desiredHeight) => {
      if (typeof desiredHeight !== 'number' || desiredHeight < 40 || desiredHeight > 800) {
        return { success: false };
      }
      try {
        const overlayWin = this.windowManager.outputOverlay;
        if (overlayWin && !overlayWin.isDestroyed()) {
          const bounds = overlayWin.getBounds();
          // Only resize if height difference is significant (>10px) to avoid flicker
          if (Math.abs(bounds.height - desiredHeight) > 10) {
            // Resize from bottom — keep the top position fixed so the overlay
            // grows downward and doesn't cover the capture area
            overlayWin.setBounds({
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: Math.round(desiredHeight)
            });
          }
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // ===== XUAT (XUnity AutoTranslator) =====
    ipcMain.handle('xuat-start-server', async (event, port) => {
      try {
        if (!this.xuatServer) {
          return { success: false, error: 'XUAT server not initialized' };
        }
        const actualPort = port || this.store.get('xuatPort') || 8419;
        this.store.set({ ...this.store.get(), xuatPort: actualPort });

        // v3.11.3: Use start() directly — the serial queue in xuat-server
        // ensures operations run one at a time (no more race conditions)
        this.xuatServer.port = actualPort;
        await this.xuatServer.start();
        console.log(`[XUAT] Server started on port ${actualPort}`);
        return { success: true, port: actualPort };
      } catch (err) {
        console.error('[XUAT] Start error:', err.message);
        this.windowManager.sendToMainWindow('xuat-status', { running: false, error: err.message });
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('xuat-stop-server', async () => {
      try {
        if (!this.xuatServer) {
          return { success: false, error: 'XUAT server not initialized' };
        }
        await this.xuatServer.stop();
        console.log('[XUAT] Server stopped');
        return { success: true };
      } catch (err) {
        console.error('[XUAT] Stop error:', err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('xuat-get-status', async () => {
      if (!this.xuatServer) {
        return { running: false, port: this.store.get('xuatPort') || 8419, url: null };
      }
      return this.xuatServer.getStatus();
    });

    ipcMain.handle('xuat-select-game', async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Select Unity Game Executable',
          properties: ['openFile'],
          filters: [
            { name: 'Game Executable', extensions: ['exe'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true };
        }
        return { canceled: false, filePath: result.filePaths[0] };
      } catch (err) {
        return { canceled: true, error: err.message };
      }
    });

    ipcMain.handle('xuat-detect-game', async (event, exePath) => {
      try {
        if (typeof exePath !== 'string') {
          return { isUnity: false, error: 'Invalid path' };
        }
        const installer = new XuatInstaller();
        const result = installer.detectUnityGame(exePath);
        return result;
      } catch (err) {
        return { isUnity: false, error: err.message };
      }
    });

    ipcMain.handle('xuat-install-in-game', async (event, { exePath, port }) => {
      try {
        if (typeof exePath !== 'string') {
          return { success: false, error: 'Invalid exe path' };
        }

        const settings = this.store.get();
        // v3.11.17: Use XUAT-specific language settings, not global
        const sourceLang = settings.xuatSourceLang || 'en';
        const targetLang = settings.xuatTargetLang || 'es';
        const xuatPort = port || settings.xuatPort || 8419;

        const installer = new XuatInstaller();

        // Forward progress events to renderer
        installer.on('progress', (data) => {
          this.windowManager.sendToMainWindow('xuat-install-progress', data);
        });

        installer.on('status', (status) => {
          this.windowManager.sendToMainWindow('xuat-install-progress', { status, percent: -1 });
        });

        installer.on('error', (err) => {
          this.windowManager.sendToMainWindow('xuat-install-progress', { error: err.message, percent: -1 });
        });

        const result = await installer.runFullInstall(exePath, xuatPort, sourceLang, targetLang);

        // Save connected game info for persistent display
        if (result.success) {
          const gameName = result.gameName || path.basename(path.dirname(exePath));
          this.store.set({ ...this.store.get(), xuatConnectedGame: gameName, xuatConnectedPath: exePath });
          this.windowManager.sendToMainWindow('xuat-game-connected', { name: gameName, path: exePath });
        }

        return result;
      } catch (err) {
        console.error('[XUAT] Install error:', err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('xuat-set-port', async (event, port) => {
      if (typeof port !== 'number' || port < 1024 || port > 65535) {
        return { success: false, error: 'Port must be between 1024 and 65535' };
      }
      this.store.set({ ...this.store.get(), xuatPort: port });
      if (this.xuatServer && this.xuatServer._running) {
        await this.xuatServer.reconfigure(port);
      } else if (this.xuatServer) {
        this.xuatServer.port = port;
      }
      console.log(`[XUAT] Port set to ${port}`);
      return { success: true, port };
    });

    // Test XUAT endpoint by making a self-request
    ipcMain.handle('xuat-test-endpoint', async () => {
      try {
        if (!this.xuatServer || !this.xuatServer._running) {
          return { success: false, error: 'XUAT server is not running' };
        }
        const port = this.xuatServer.port;
        const axios = require('axios');
        // v3.11.4: Use 127.0.0.1 instead of localhost — Node resolves localhost
        // to ::1 (IPv6) but our server only listens on 127.0.0.1 (IPv4)
        const response = await axios.get(`http://127.0.0.1:${port}/status`, { timeout: 3000 });
        return { success: true, status: response.data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // v3.11.17: Update XUAT language config for connected game
    ipcMain.handle('xuat-update-language', async (event, { sourceLang, targetLang }) => {
      try {
        const xuatConnectedPath = this.store.get('xuatConnectedPath');
        if (!xuatConnectedPath) {
          return { success: false, error: 'No XUAT game connected' };
        }
        const gameDir = path.dirname(xuatConnectedPath);
        // Use XUAT-specific language settings (passed from renderer)
        // These are independent from the global sourceLang/targetLang
        const xuatSource = sourceLang || this.store.get('xuatSourceLang') || 'en';
        const xuatTarget = targetLang || this.store.get('xuatTargetLang') || 'es';
        const xuatPort = this.store.get('xuatPort') || 8419;
        const installer = new XuatInstaller();
        installer.updateLanguageConfig(gameDir, xuatPort, xuatSource, xuatTarget);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // v3.11.17: Clear XUAT translation cache for connected game
    ipcMain.handle('xuat-clear-cache', async () => {
      try {
        const xuatConnectedPath = this.store.get('xuatConnectedPath');
        if (!xuatConnectedPath) {
          return { success: false, error: 'No XUAT game connected' };
        }
        const gameDir = path.dirname(xuatConnectedPath);
        const installer = new XuatInstaller();
        const deleted = installer.clearTranslationCache(gameDir);
        return { success: true, deleted };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // v3.10.0: Get log file path and contents for debugging/sharing.
    // Users can click a button in settings to copy their logs.
    ipcMain.handle('get-debug-logs', async () => {
      try {
        const log = require('electron-log');
        const logPath = log.transports.file.getFile()?.path || log.transports.file.findLogPath?.() || '';
        let logContent = '';
        if (logPath) {
          try {
            logContent = fs.readFileSync(logPath, 'utf8');
            // Keep only last 100 lines
            const lines = logContent.split('\n');
            logContent = lines.slice(-100).join('\n');
          } catch (e) {
            logContent = `[Error reading log file: ${e.message}]`;
          }
        }
        return { success: true, logPath, logContent };
      } catch (err) {
        return { success: false, error: err.message, logPath: '', logContent: '' };
      }
    });
  }

  /**
   * Ensure the XUAT HTTP server is running on the specified port.
   * v3.11.3: Simplified — the serial queue in xuat-server handles
   * all race conditions and retry logic internally.
   *
   * If already running on the same port, do nothing.
   * If running on a different port, reconfigure.
   * If not running, start it.
   *
   * @param {number} port
   * @returns {Promise<void>}
   */
  async _ensureXuatServerRunning(port) {
    if (!this.xuatServer) {
      throw new Error('XUAT server not initialized');
    }
    if (this.xuatServer._running) {
      // Already running — only reconfigure if port changed
      if (this.xuatServer.port !== port) {
        await this.xuatServer.reconfigure(port);
      }
    } else {
      // Not running — set port and start
      this.xuatServer.port = port;
      await this.xuatServer.start();
    }
  }

  /**
   * Handle incoming text from any source (Textractor stdout, Textractor TCP, Clipboard, OCR)
   * Includes deduplication to prevent double-translation when the same text
   * arrives from both stdout and TCP channels.
   */
  async _handleText(text) {
    // v3.8.25: Safety net — strip any remaining null bytes, control chars,
    // and apply deduplication for text that arrives from TCP (bypassing _cleanGameText)
    if (text) {
      const originalText = text;
      text = text.replace(/[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, '');

      // v3.11.33: Apply regex text filters before dedup/translation
      // Always apply if regexFilter service is available (respects enableRegexFilter toggle)
      // v3.11.35: Pass srcLang for language-aware replacement (LunaTranslator-style:
      //   ja/zh/ko newlines → '' (remove), other langs → ' ' (space))
      const enableRegexFilter = this.store.get('enableRegexFilter');
      const srcLangForFilter = this.store.get('sourceLang') || 'ja';
      if (this.regexFilter) {
        if (enableRegexFilter !== false) {
          const filterResult = this.regexFilter.apply(text, srcLangForFilter);
          if (filterResult.appliedCount > 0) {
            console.log(`[Tuhua] Regex filter: ${filterResult.appliedCount} applied, ${filterResult.skipped.length} skipped — "${text.substring(0, 40)}" → "${filterResult.text.substring(0, 40)}"`);
          } else {
            console.log(`[Tuhua] Regex filter: 0 filters matched (0 applied)`);
          }
          text = filterResult.text;
        } else {
          console.log(`[Tuhua] Regex filter: DISABLED (enableRegexFilter=${enableRegexFilter})`);
        }
      } else {
        console.warn(`[Tuhua] Regex filter: Service not available`);
      }

      // v3.9.5: Only apply HOOK cleaning for Textractor input.
      // For OCR text, this STRIPS numbers by splitting on digits
      // (e.g., "Interval of 1500ms" → "Interval of ms" — losing the "1500").
      // OCR text doesn't have Textractor's digit-delimiter pattern, so skip it.
      // v3.13.20: Delegates to src/services/text-cleaning.js's single
      // consolidated pipeline — this used to call this class's own
      // _deduplicateText, which duplicated (and, before three 2026-08-06
      // patches, diverged from) textractor-launcher.js's _cleanGameText.
      // See text-cleaning.js's header comment for the full history.
      const currentInputMethod = this.store.get('inputMethod');
      if (currentInputMethod !== 'ocr') {
        // v3.13.21 (Fase 2): per-step enable + cjkOnly now come from
        // HookCleaningSettingsService, not hardcoded — defaults reproduce
        // Fase 1's fixed pipeline exactly (verified: the bench report did
        // not change when this service's defaults were introduced).
        const cleaningOptions = this.hookCleaningSettings ? this.hookCleaningSettings.getOptions() : {};
        text = textCleaning.cleanHookText(text, cleaningOptions);
      }
    }

    const settings = this.store.get();
    const srcLang = settings.sourceLang || 'ja';
    const tgtLang = settings.targetLang || 'es';
    const engineName = settings.engine || 'google-free';

    // Deduplication: skip if we just processed the exact same text
    // (prevents double-translation when stdout and TCP both deliver the same text)
    const crypto = require('crypto');
    const textHash = crypto.createHash('md5').update(text).digest('hex');
    const now = Date.now();

    // v3.9.8: For OCR, similarity-based dedup is now handled in ocr.js
    // (_isSimilarText). The OCR service only emits 'text' events when the
    // new text is genuinely different from the last emitted text (>80%
    // word overlap means same dialogue, skip it). So we only need a
    // simple exact-match safety net here for the rare case where the
    // same text somehow arrives twice.
    // For Textractor/Clipboard: time-based dedup (2s window) to handle
    // stdout+TCP double delivery.
    const isOcr = settings.inputMethod === 'ocr';
    if (isOcr) {
      // Light dedup: only skip if EXACT same text was just processed.
      // The heavy similarity dedup is done in ocr.js before emitting.
      if (this._lastOcrTextHash === textHash) {
        console.log(`[Tuhua] OCR exact duplicate skipped: "${text.substring(0, 30)}..."`);
        return;
      }
      this._lastOcrTextHash = textHash;
    } else {
      if (this._lastHandledHash === textHash && (now - this._lastHandledTime) < 2000) {
        console.log(`[Tuhua] Duplicate text skipped (dedup): "${text.substring(0, 30)}..."`);
        return;
      }
      this._lastHandledHash = textHash;
      this._lastHandledTime = now;
    }

    // v3.13.12: Store last handled text for auto-retranslation when settings change
    this._lastHandledText = text;

    console.log(`[Tuhua] _handleText: srcLang=${srcLang}, tgtLang=${tgtLang}, engine=${engineName}, active=${this._translationActive}, inputMethod=${settings.inputMethod}, text="${text.substring(0, 60)}..."`);

    // If translation is paused, skip everything — no text to overlays, no translation
    // v3.13.07: Also defensively hide overlay and clear content when paused.
    // This prevents stale overlay content from being visible after switching input methods.
    if (!this._translationActive) {
      console.log(`[Tuhua] Translation paused — skipping text`);
      this.windowManager.hideOutputOverlay();
      this.windowManager.clearOverlayContent();
      return;
    }

    // v3.12.02: Skip translation for text that contains no translatable content.
    // After filtering, text may consist solely of numbers, punctuation, or symbols
    // (e.g. NFKC converts "！！！" → "!!!", "１２３" → "123"). Sending these to a
    // translation engine wastes API calls and produces hallucinated translations
    // (DeepL translates "!!!" to "¿¡Qué!?" in Spanish). Instead, show the
    // filtered text directly in the overlay.
    //
    // "Translatable" means the text contains at least 2 letters or CJK characters
    // across all supported scripts: Latin, Cyrillic, Hiragana, Katakana, Kanji, Hangul.
    // v3.12.08: Also allow translation if the text contains a single CJK ideograph
    // (kanji or hangul). A single kanji like 桜 (cerezo) or 花 (flor) is a real word
    // that should be translated. A single Latin letter like "A" is not. After
    // Strategy 1 collapses 桜桜桜 → 桜, the guard must still allow translation.
    const translatableCharCount = (text.match(/[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0400-\u052F]/g) || []).length;
    const hasCJKIdeograph = /[\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
    if (translatableCharCount < 2 && !hasCJKIdeograph) {
      console.log(`[Tuhua] Skipping translation — not enough translatable characters (${translatableCharCount}): "${text.substring(0, 40)}"`);
      this.windowManager.sendToOutputOverlay('update-output', { text: text, targetLang: tgtLang });
      return;
    }

    // Translate
    try {
      console.log(`[Tuhua] Calling pipeline.translate() with engine=${engineName}...`);
      const translation = await this.pipeline.translate(text, {
        source: srcLang,
        target: tgtLang,
        engine: engineName
      });

      console.log(`[Tuhua] Translation result: "${translation?.substring(0, 60)}..."`);
      // v3.13.06: Double-check that translation is still active before sending
      // to overlay. There can be a race condition where the user pauses
      // translation while a pipeline.translate() call is in-flight.
      if (!this._translationActive) {
        console.log(`[Tuhua] Translation became paused during translate — discarding result`);
        return;
      }
      // Send translation to output overlay
      this.windowManager.sendToOutputOverlay('update-output', { text: translation, targetLang: tgtLang });
    } catch (err) {
      console.error(`[Tuhua] Translation error:`, err.message);
      this.windowManager.sendToOutputOverlay('update-output', {
        text: `[Error] ${err.message}`
      });
    }
  }

  // v3.13.20: _deduplicateText and _removeIncrementalPattern moved to
  // src/services/text-cleaning.js (cleanHookText, detectGrowingPrefix) as
  // part of consolidating the previously-duplicated dedup logic that used
  // to be split across this file and textractor-launcher.js.

  /**
   * Capture the screen region defined by the capture area window bounds.
   * Uses Electron's desktopCapturer API to get a screenshot of the specific area.
   *
   * v3.9.6: NO hiding/showing of overlays at all. The capture area has
   * transparent: true and only a thin dashed border + title bar, which are
   * negligible for OCR quality. Hiding/showing overlays causes visible flashing
   * and focus changes that ruin the UX. The OCR scan region is offset to
   * exclude the title bar area (28px at top).
   *
   * @returns {Promise<Buffer|null>} PNG image buffer of the captured region
   */
  async _captureScreenRegion() {
    try {
      const bounds = this.windowManager.getCaptureAreaBounds();
      if (!bounds) {
        console.error('[OCR] No capture area bounds available');
        return null;
      }

      // Get the primary display
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.size;
      const scaleFactor = primaryDisplay.scaleFactor;

      // Use desktopCapturer to get the screen source — NO overlay hiding
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(screenWidth * scaleFactor),
          height: Math.round(screenHeight * scaleFactor)
        }
      });

      if (!sources || sources.length === 0) {
        console.error('[OCR] No screen sources available');
        return null;
      }

      const source = sources[0];
      const thumbnail = source.thumbnail;

      if (thumbnail.isEmpty()) {
        console.error('[OCR] Screen capture thumbnail is empty');
        return null;
      }

      // Crop to the capture area bounds, but SKIP the title bar area (28px at top).
      // The title bar has "OCR" label and is not part of the text being scanned.
      const titleBarHeight = 28;
      const cropX = Math.round(bounds.x * scaleFactor);
      const cropY = Math.round((bounds.y + titleBarHeight) * scaleFactor);
      const cropWidth = Math.round(bounds.width * scaleFactor);
      const cropHeight = Math.round((bounds.height - titleBarHeight) * scaleFactor);

      // Resize the full screenshot and crop it
      const resized = thumbnail.resize({
        width: Math.round(screenWidth * scaleFactor),
        height: Math.round(screenHeight * scaleFactor)
      });

      const cropped = resized.crop({
        x: cropX,
        y: cropY,
        width: Math.min(cropWidth, resized.getSize().width - cropX),
        height: Math.min(cropHeight, resized.getSize().height - cropY)
      });

      // Convert to PNG buffer
      const pngBuffer = cropped.toPNG();
      return Buffer.from(pngBuffer);
    } catch (err) {
      console.error('[OCR] Screen capture error:', err.message);
      return null;
    }
  }

  /**
   * Start OCR auto-capture with the best default interval
   */
  _startOcrAutoCapture() {
    // v3.9.9: 3500ms interval (was 7000ms). Faster scanning means
    // game dialogue is picked up sooner. The similarity-based dedup
    // prevents re-translating the same text, so faster scans are safe.
    // Sequential processing + change detection prevent overload.
    this.ocrService.startAutoCapture(async () => {
      return await this._captureScreenRegion();
    }, 3500);
  }

  unregister() {
    const channels = [
      'get-settings', 'save-settings',
      'get-glossary', 'save-glossary', 'delete-glossary-entry',
      'import-glossary', 'export-glossary',
      'get-history', 'clear-history', 'export-history', 'clear-context',
      'get-profiles', 'save-profile', 'delete-profile', 'load-profile',
      'validate-api-key', 'test-connection', 'detect-font-family',
      'ocr-capture', 'ocr-start', 'ocr-stop', 'ocr-set-language',
      'ocr-set-interval', 'ocr-set-preprocessing', 'ocr-set-min-confidence', 'ocr-status',
      'ocr-set-auto-capture', 'ocr-close-capture-area', 'ocr-toggle-scan', 'get-displays',
      'textractor-validate-cli', 'textractor-browse-cli', 'textractor-launch',
      'textractor-kill', 'textractor-cli-status', 'textractor-cli-output',
      'textractor-select-hook', 'textractor-test-cli', 'resize-overlay', 'get-debug-logs',
      'xuat-start-server', 'xuat-stop-server', 'xuat-get-status',
      'xuat-select-game', 'xuat-detect-game', 'xuat-install-in-game', 'xuat-set-port',
      'xuat-test-endpoint'
    ];
    channels.forEach(ch => ipcMain.removeHandler(ch));
    ipcMain.removeAllListeners('manual-translate');
    // Cleanup OCR
    if (this.ocrService) {
      this.ocrService.stopAutoCapture();
    }
    this.registered = false;
  }
}

module.exports = IpcHandlers;
