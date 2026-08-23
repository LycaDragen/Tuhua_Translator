/**
 * IPC Handlers
 * Registers all secure IPC communication between main and renderer.
 * All payloads are validated before processing.
 */
const { ipcMain, dialog, app, desktopCapturer, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const { parseProcessListJson } = require('../services/game-process-list');

const XuatInstaller = require('../services/xuat-installer');
const VndbService = require('../services/vndb');
const { profileToSettings, settingsToProfile } = require('../services/profiles/profile-schema');
const glossaryEntries = require('../services/translation/glossary-entries');
const textCleaning = require('../services/text-cleaning');
const llmProviders = require('../services/translation/llm-providers');
const { deleteGlossary: deleteDeeplGlossary } = require('../services/translation/deepl-glossary-sync');
const speakerExtract = require('../services/speaker-extract');
const promptPresets = require('../services/translation/prompt-presets');
// v3.13.29: renderer/main/i18n.js exports its `translations` object via
// module.exports whenever it's available (see its own bottom-of-file
// check), so it's requirable here too — used for the few strings the
// MAIN process needs translated (native dialog titles), which the
// renderer's own changeLanguage()/data-i18n machinery can't reach since
// those dialogs are drawn by Electron itself, not the DOM.
const translations = require('../../renderer/main/i18n.js');

// v3.13.8x (settings UX audit, Fase 4, second pass): Lyca reported the
// game process picker felt slow to open — real cost, not perception: a
// PowerShell cold-start (~1-2s) plus a per-process app.getFileIcon() disk
// read for however many windowed apps are open. The PowerShell call is
// unavoidable per-open, but an exe's icon does not change mid-session, so
// caching it here means every open AFTER the first is faster — module-level
// (not per-handler-instance) since this class is only ever constructed
// once per app lifetime anyway. Never explicitly cleared: an icon going
// stale mid-session (an app updating its own binary while running) is a
// cosmetic non-issue, not worth the complexity of invalidation.
const _gameProcessIconCache = new Map();

/**
 * Look up a translated string for a main-process-only UI surface (native
 * dialogs) using the same `uiLanguage` setting the renderer persists via
 * saveSettings — falls back to 'es' (this app's original default) then to
 * the key itself if nothing matches, so a missing translation degrades to
 * a visible key rather than a crash.
 */
function mainT(store, key) {
  const lang = (store && typeof store.get === 'function' && store.get('uiLanguage')) || 'es';
  const dict = translations[lang] || translations.es || translations.en || {};
  return dict[key] || key;
}

class IpcHandlers {
  constructor(store, pipeline, glossary, regexFilter, windowManager, textractor, clipboardWatcher, textractorLauncher, ocrService, xuatServer, shortcutManager, hookCleaningSettings, profileStore) {
    this.store = store;
    this.pipeline = pipeline;
    this.glossary = glossary;
    this.profileStore = profileStore;
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
    // v3.13.6x (Fase 7a): companion to _lastHandledText — the speaker that
    // was extracted for it, so a settings-change auto-retranslation (below)
    // still has {speaker} available instead of silently losing it.
    this._lastSpeakerName = null;
    // OCR dedup: persistent hash that doesn't expire — same text from OCR
    // should NEVER be re-translated until the game screen changes
    this._lastOcrTextHash = '';
    // OCR state
    this._ocrActive = false;
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
    // v3.13.44 (profiles Phase 1, step 8): this used to migrate old
    // dot-notation keys (glossary.perProfile, glossary.autoApply,
    // overlay.showSourceText) into flat keys (perProfileGlossary,
    // autoApplyGlossary, showSourceTextInOverlay) — all three flat keys
    // are now gone, dead themselves: declared as store defaults but never
    // read by any pipeline/UI code. showSourceTextInOverlay in particular
    // looked legitimate (translated UI label + description in all 8
    // locales) but had zero wiring — update-output's payload to the
    // output overlay is always just {text, targetLang}, never the
    // original text, and no checkbox in index.html ever referenced the
    // show_source_text i18n key (removed alongside it, see i18n.js).
    // profile-migrations.js's DEAD_SETTING_KEYS already strips all five
    // from existing users' persisted settings on the one-time v0→v1
    // profile migration, so this handler needs no migration logic at all
    // anymore.
    ipcMain.handle('get-settings', () => {
      return this.store.get() || {};
    });

    // v3.13.58 (LLM engine overhaul, Fase 3): read-only — llm-providers.js
    // lives in the main process (src/services/) and isn't reachable from
    // the sandboxed renderer via require(), so this is what feeds the
    // provider dropdown / local endpoint preset dropdown / model
    // datalists. Only the fields the UI actually needs are sent —
    // `reasoningModelPattern` (a RegExp) doesn't survive structured clone
    // and isn't needed there anyway, request-param overrides are decided
    // in the main process.
    ipcMain.handle('get-llm-providers', () => {
      return {
        providers: llmProviders.CLOUD_PROVIDERS.map((p) => ({
          id: p.id, labelKey: p.labelKey, requiresKey: p.requiresKey,
          defaultModel: p.defaultModel, models: p.models, beta: !!p.beta, docsUrl: p.docsUrl || ''
        })),
        localPresets: llmProviders.LOCAL_ENDPOINT_PRESETS.map((p) => ({ id: p.id, labelKey: p.labelKey }))
      };
    });

    // v3.13.59 (LLM engine overhaul, Fase 4): read-only, same reasoning as
    // get-llm-providers just above — prompt-presets.js lives in the main
    // process; this is what feeds the renderer's preset <select> and lets
    // it match a saved/typed template back to a preset id (or 'custom')
    // without duplicating the actual prompt prose text into renderer.js.
    ipcMain.handle('get-prompt-presets', () => {
      return {
        presets: promptPresets.PROMPT_PRESETS.map((p) => ({ id: p.id, labelKey: p.labelKey, template: p.template })),
        defaultTemplate: promptPresets.DEFAULT_TEMPLATE
      };
    });

    ipcMain.handle('save-settings', async (event, data) => {
      if (typeof data !== 'object' || data === null) {
        return { success: false, error: 'Invalid settings data' };
      }

      // Merge with existing settings instead of replacing
      const currentSettings = this.store.get();
      // v3.13.6x (Fase 9 testing follow-up, ronda 5/6): diagnostic (ronda 5)
      // plus now a real decision input (ronda 6) — see its two uses below,
      // clearContext() and the auto-retranslate block. Confirms whether the
      // RENDERER even included `promptTemplate` in this specific
      // save-settings call, and whether its value actually differs from
      // what was already stored.
      const promptTemplateChanged = 'promptTemplate' in data && data.promptTemplate !== currentSettings.promptTemplate;
      if (promptTemplateChanged) {
        console.log(`[Tuhua] save-settings: promptTemplate changed (${(currentSettings.promptTemplate || '').length} chars -> ${(data.promptTemplate || '').length} chars)`);
      }
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
          // v3.13.04: Re-show output overlay for clipboard mode.
          // v3.13.48: ...and HIDE it when paused — real bug: this only
          // ever showed the overlay, never hid it, so switching input
          // methods while paused left whatever was already on screen
          // (stale content from the PREVIOUS method) visibly stuck
          // there. Same fix applied to the ocr/textractor branches below.
          if (this._translationActive) {
            this.windowManager.showOutputOverlay();
          } else {
            this.windowManager.hideOutputOverlay();
            this.windowManager.clearOverlayContent();
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
          // v3.13.48: this branch never touched the overlay at all
          // before — switching TO ocr while it was showing a translation
          // from the PREVIOUS input method left that stale text stuck on
          // screen indefinitely, since OCR itself has nothing new to
          // show it until the user manually starts a capture.
          if (this._translationActive) {
            this.windowManager.showOutputOverlay();
            // v3.13.50: actually START the OCR capture session (creates
            // the capture area window, initializes the engine) when
            // switching TO ocr while Tuhua is already active — real bug:
            // this branch used to leave everything uninitialized, so the
            // capture area silently never appeared unless the user
            // separately paused/resumed Tuhua (which DOES call this,
            // via ocr-start). _startOcrCapture() itself now always
            // leaves scanning paused (see its doc comment), so this
            // doesn't start grabbing screenshots before the user
            // repositions the region either.
            const startResult = await this._startOcrCapture();
            if (!startResult.success) {
              console.error('[Tuhua] Failed to auto-start OCR on method switch:', startResult.error);
            }
          } else {
            this.windowManager.hideOutputOverlay();
            this.windowManager.clearOverlayContent();
          }
          // Notify renderer of the mode
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
          // v3.13.04: Re-show output overlay for Textractor mode (was hidden for XUAT).
          // v3.13.48: ...and hide it when paused, same fix as the
          // clipboard/ocr branches above (see their comments).
          if (this._translationActive) {
            this.windowManager.showOutputOverlay();
          } else {
            this.windowManager.hideOutputOverlay();
            this.windowManager.clearOverlayContent();
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
      // v3.13.6x (LLM engine overhaul, Fase 7e): a genuine change in HOW
      // text arrives (Textractor ↔ OCR ↔ clipboard) is data provenance
      // changing mid-conversation — the {contextBoth} window an LLM sees
      // would otherwise mix lines whose {inputMethod} the prompt itself
      // now describes differently. Deliberately NOT extended to
      // pause/resume — pausing translation isn't a scene change, and
      // clearing context on every pause/resume cycle would defeat the
      // point of carrying context across a player's natural reading pauses.
      const inputMethodChanged = data.inputMethod && data.inputMethod !== currentSettings.inputMethod;

      // v3.13.19: Reset Context Memory on any of these changes — mixing
      // context lines from a different engine/source language/target language
      // into the next translation call ranges from meaningless (DeepL's
      // context must be the same language as the new source) to actively
      // misleading (an LLM engine would see prior turns in the old target
      // language while being told to now answer in a different one).
      // v3.13.6x (Fase 9 testing follow-up, ronda 6): `promptTemplateChanged`
      // added — same reasoning as inputMethodChanged, weaker but real: even
      // after pipeline.js's context-poisoning fix (the CURRENT line can no
      // longer leak into its own context), the OTHER lines still in the
      // window were translated under the OLD preset, and every preset's
      // rule 6 explicitly tells the model to "stay consistent with the
      // terminology and character voices established in the recent lines
      // above" — pointing it right back at the style being compared away
      // from. A prompt-preset A/B comparison should start from a clean
      // window.
      if (engineChanged || sourceLangChanged || targetLangChanged || inputMethodChanged || promptTemplateChanged) {
        this.pipeline.clearContext();
      }

      if ((engineChanged || sourceLangChanged || targetLangChanged || promptTemplateChanged) && this._lastHandledText) {
        const newEngine = data.engine || currentSettings.engine || 'google-free';
        const newSourceLang = data.sourceLang || currentSettings.sourceLang || 'auto';
        const newTargetLang = data.targetLang || currentSettings.targetLang || 'es';
        console.log(`[Tuhua] Settings changed while text is on-screen — auto-retranslating last text with ${newEngine} (${newSourceLang} → ${newTargetLang})${promptTemplateChanged ? ' [promptTemplate changed]' : ''}`);
        // Use translateNow (no debounce) for immediate retranslation.
        // v3.13.6x (Fase 9 testing follow-up, ronda 6): bypassMemory:true —
        // this IS an explicit "redo with the settings I just changed"
        // request; without it, a cache/TM hit could silently answer with
        // the OLD settings' translation and this call would never reach
        // the engine at all (reproduced for real: this exact log line
        // followed immediately by a TM exact hit, in a real session).
        try {
          await this.pipeline.translateNow(this._lastHandledText, {
            source: newSourceLang,
            target: newTargetLang,
            engine: newEngine,
            speaker: this._lastSpeakerName,
            bypassMemory: true
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
        title: mainT(this.store, 'dialog_browse_textractor_title'),
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

    // v3.13.8x (settings UX audit, Fase 4): replaces "open Task Manager and
    // type the PID by hand" — the worst control in the settings panel per
    // Lyca's own words. Windows-only, same guard class as every other
    // Textractor path in this file (see _resolveExePathFromPid() in
    // textractor-launcher.js for the sibling pattern this borrows: async
    // exec + PowerShell, never execSync, so a slow PowerShell cold-start
    // can't block the main process's event loop).
    //
    // `MainWindowTitle -ne ''` is the actual noise filter Lyca asked for —
    // it's exactly what separates "an app with a window a user would
    // recognize" from Windows' many background services/helpers, without
    // a hand-maintained denylist. `-and $_.Path` additionally drops
    // protected/system processes Tuhua couldn't read the icon/exe for
    // anyway. Tuhua's own window is excluded by PID so it never lists
    // itself as a "game" to attach to.
    ipcMain.handle('list-game-processes', async () => {
      if (process.platform !== 'win32') {
        return { success: false, error: 'windows-only' };
      }
      const ownPid = process.pid;
      const psCommand = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.Path -and $_.Id -ne ${ownPid} } | Select-Object Id, ProcessName, MainWindowTitle, Path | ConvertTo-Json -Compress`;
      const raw = await new Promise((resolve) => {
        exec(
          `powershell -NoProfile -NonInteractive -Command "${psCommand}"`,
          { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              console.warn('[Tuhua] list-game-processes: PowerShell call failed:', err.message);
              return resolve(null);
            }
            resolve(stdout);
          }
        );
      });
      // parseProcessListJson (src/services/game-process-list.js) is the
      // pure/testable half of this handler — see its own doc comment for
      // why going through it (not JSON.parse directly) matters even for
      // the single-process case.
      const rows = parseProcessListJson(raw);

      // Icons resolved in parallel — app.getFileIcon() is a real per-file
      // disk read, and there can be a couple dozen matching windows on a
      // busy desktop. Each is independently guarded: a failure (protected
      // path, deleted-but-still-running exe) drops just that process's
      // icon, never the whole list.
      const processes = await Promise.all(rows.map(async (row) => {
        if (_gameProcessIconCache.has(row.exePath)) {
          return { ...row, iconDataUrl: _gameProcessIconCache.get(row.exePath) };
        }
        let iconDataUrl = null;
        try {
          const icon = await app.getFileIcon(row.exePath, { size: 'normal' });
          if (icon && !icon.isEmpty()) iconDataUrl = icon.toDataURL();
        } catch (e) {
          // Silent — a missing icon just means the picker row falls back
          // to a generic glyph in the renderer, not worth a console line
          // per process on every open.
        }
        _gameProcessIconCache.set(row.exePath, iconDataUrl);
        return { ...row, iconDataUrl };
      }));

      return { success: true, processes };
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
      if (typeof cliPath !== 'string') return { canStart: false, hintKey: 'hint_invalid_path', hint: 'Invalid path' };
      console.log(`[Tuhua] Testing TextractorCLI: ${cliPath}`);
      const result = await this.textractorLauncher.testLaunch(cliPath);
      console.log(`[Tuhua] Test result: canStart=${result.canStart}, hint="${result.hint}"`);
      return result;
    });

    // ===== Glossary =====
    // v3.13.40 (profiles Phase 1, step 5): two layers. `this.glossary`
    // (glossary.json) is the GLOBAL layer, unchanged. The PROFILE layer is
    // just `activeProfile.glossary[]`, mutated through profileStore.update()
    // — there's no separate store for it. Every profile-scope mutation
    // below re-calls this.glossary.setProfileLayer() with the fresh array
    // so the pipeline's merged view (getEffective()) is correct for the
    // very next translation, not just after the next profile switch.
    ipcMain.handle('get-glossary', () => {
      const active = this.profileStore.getActive();
      // v3.13.55: getEffective() must run before getCompileErrors() reads
      // off it — it's what recomputes and self-tests the merged list (see
      // glossary.js). Order matters here.
      const effective = this.glossary.getEffective();
      return {
        global: this.glossary.getAll(),
        profile: active ? active.glossary : [],
        effective,
        compileErrors: this.glossary.getCompileErrors(),
        activeProfileId: active ? active.id : null
      };
    });

    ipcMain.handle('save-glossary', (event, { entry, scope } = {}) => {
      if (!entry || typeof entry.source !== 'string' || typeof entry.target !== 'string') {
        return { success: false, error: 'Invalid glossary entry' };
      }
      if (scope === 'profile') {
        const active = this.profileStore.getActive();
        if (!active) return { success: false, error: 'No active profile' };
        let savedEntry = null;
        this.profileStore.update(active.id, (current) => {
          const result = entry.id
            ? glossaryEntries.updateEntry(current.glossary, entry.id, entry)
            : glossaryEntries.addEntry(current.glossary, entry);
          savedEntry = result.entry;
          return { glossary: result.list };
        });
        this.glossary.setProfileLayer(this.profileStore.getById(active.id).glossary);
        return { success: true, entry: savedEntry };
      }
      if (entry.id) {
        this.glossary.update(entry.id, entry);
      } else {
        this.glossary.add(entry);
      }
      return { success: true };
    });

    ipcMain.handle('delete-glossary-entry', (event, { id, scope } = {}) => {
      if (typeof id !== 'string') return { success: false, error: 'Invalid ID' };
      if (scope === 'profile') {
        const active = this.profileStore.getActive();
        if (!active) return { success: false, error: 'No active profile' };
        this.profileStore.update(active.id, (current) => ({ glossary: glossaryEntries.removeEntry(current.glossary, id) }));
        this.glossary.setProfileLayer(this.profileStore.getById(active.id).glossary);
        return { success: true };
      }
      this.glossary.delete(id);
      return { success: true };
    });

    ipcMain.handle('import-glossary', async (event, { filePath, scope } = {}) => {
      try {
        if (scope === 'profile') {
          const active = this.profileStore.getActive();
          if (!active) return { success: false, error: 'No active profile' };
          const fs = require('fs');
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          let imported = 0;
          this.profileStore.update(active.id, (current) => {
            const result = glossaryEntries.importEntries(current.glossary, data);
            imported = result.imported;
            return { glossary: result.list };
          });
          this.glossary.setProfileLayer(this.profileStore.getById(active.id).glossary);
          return { success: true, imported };
        }
        const count = this.glossary.importFromFile(filePath);
        return { success: true, imported: count };
      } catch (e) {
        // e.code (WRONG_CATEGORY_HISTORY / NO_VALID_ENTRIES / INVALID_FORMAT,
        // see glossary-entries.js) lets the renderer show a specific,
        // translated message instead of the raw error text.
        return { success: false, error: e.message, code: e.code };
      }
    });

    ipcMain.handle('export-glossary', async (event, { filePath, scope } = {}) => {
      try {
        if (scope === 'profile') {
          const active = this.profileStore.getActive();
          if (!active) return { success: false, error: 'No active profile' };
          const fs = require('fs');
          const entries = active.glossary || [];
          fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
          return { success: true, exported: entries.length };
        }
        const count = this.glossary.exportToFile(filePath);
        return { success: true, exported: count };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // v3.13.40-fix: glossary/history import-export used to prompt the user
    // to TYPE a full file path (via showTextPrompt) — real feedback found
    // this genuinely unclear (Lyca first read it as "type a filename",
    // not "type a full path", and even once understood, typing a path by
    // hand instead of picking one is a worse experience than every other
    // file-choosing flow in this app already has — see
    // textractor-browse-cli just above, same dialog module). Generic
    // save/open pickers, reused by glossary export, glossary import, and
    // history export (three call sites already, the exact point this
    // project's own convention treats a shared helper as earned rather
    // than premature).
    ipcMain.handle('browse-save-json', async (event, { title, defaultFileName } = {}) => {
      const result = await dialog.showSaveDialog({
        title: title || 'Export JSON',
        defaultPath: defaultFileName || 'export.json',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (result.canceled || !result.filePath) return { canceled: true, path: '' };
      return { canceled: false, path: result.filePath };
    });

    ipcMain.handle('browse-open-json', async (event, { title } = {}) => {
      const result = await dialog.showOpenDialog({
        title: title || 'Import JSON',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: '' };
      return { canceled: false, path: result.filePaths[0] };
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

    // Import glossary entries from a VNDB visual novel.
    // v3.13.40 (profiles Phase 1, step 6): routes to a PROFILE glossary
    // layer, not the global one — a VN's characters/terms are per-game
    // data, same reasoning as save-glossary/import-glossary's scope:
    // 'profile' branch above (which this mirrors: profileStore.update()).
    // v3.13.41: the button that opens this moved to each profile CARD, so
    // it now targets an explicit `profileId` — not necessarily the active
    // one. glossary.setProfileLayer() represents "the active profile's
    // merged view" specifically, so it's only called when the profile we
    // just edited IS the active one; calling it for a different profile
    // would clobber the pipeline's in-memory glossary with the wrong
    // profile's data while some OTHER profile stays active.
    ipcMain.handle('vndb-import', async (event, vnId, profileId, options) => {
      if (typeof vnId !== 'string' || !vnId.match(/^v\d+$/)) {
        return { success: false, error: 'Invalid VNDB VN ID (format: v123)' };
      }
      const target = this.profileStore.getById(profileId);
      if (!target) return { success: false, error: 'Profile not found' };
      try {
        const importResult = await this.vndbService.importGlossary(vnId, options || {});

        let addedCount = 0;
        this.profileStore.update(target.id, (current) => {
          let list = current.glossary || [];
          for (const entry of importResult.entries) {
            const isDuplicate = list.some(e =>
              e.source === entry.source && e.target === entry.target
            );
            if (!isDuplicate) {
              const result = glossaryEntries.addEntry(list, {
                source: entry.source,
                target: entry.target,
                mode: entry.mode || 'case-insensitive',
                enabled: true
              });
              list = result.list;
              addedCount++;
            }
          }
          const patch = { glossary: list };
          // v3.13.41: cover thumbnail — the renderer already has the VN's
          // image.url from the search result (see vndb.js), so it's
          // passed straight through in `options` instead of fetching the
          // VN a second time here. Only overwrites the card's existing
          // cover when this VN actually has an image; re-importing a
          // cover-less VN on top of a profile that already has one
          // shouldn't blank it out.
          if (options && typeof options.coverUrl === 'string' && options.coverUrl) {
            patch.cover = { url: options.coverUrl, vnId, vnTitle: options.vnTitle || '' };
          }
          return patch;
        });
        const active = this.profileStore.getActive();
        if (active && active.id === target.id) {
          this.glossary.setProfileLayer(this.profileStore.getById(target.id).glossary);
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

    // ===== Word → Glossary (right-click, or the overlay's own toolbar
    // button, on the output overlay) =====
    // v3.13.42: Textractor/clipboard/OCR all render through the SAME
    // output-overlay window, so this covers all three input methods at
    // once — no per-method wiring needed. `.on`, not `.handle`: the
    // overlay just fires-and-forgets the click, the menu itself is built
    // and shown here (a native Menu can render outside the tiny overlay
    // window's own bounds, which a DOM popup couldn't — see
    // overlay-preload.js's comment on requestWordContextMenu). The scope
    // (global vs. this profile) is picked from the menu directly; the
    // follow-up prompt window (word-save-prompt/, created by
    // windowManager.createWordSavePrompt) only asks for the meaning.
    //
    // v3.13.51: `word` can be an empty string now — the overlay's new
    // toolbar button (📖+, next to the OUTPUT label) opens this SAME
    // flow without any specific word attached, for exactly the reason
    // Lyca raised: right-clicking one word implied to the user that THAT
    // word would be the one saved, which stopped being true once the
    // Término field became independently editable (v3.13.47) — a
    // generic entry point removes the false expectation. Right-click on
    // a word still works too (kept as a convenience), it just no longer
    // has any special claim over the popup's content either.
    ipcMain.on('overlay-word-context-menu', (event, word, originalText) => {
      const cleanWord = (typeof word === 'string' ? word : '').trim();
      const active = this.profileStore.getActive();
      // v3.13.46: whether the ORIGINAL line can be split into clickable
      // words for the prompt (see createWordSavePrompt) — real fix for
      // the backwards flow Lyca flagged: this used to save the CLICKED
      // (translated) word as the glossary entry's `source`, when a
      // source→target glossary needs the actual source-language term.
      // Whitespace segmentation only means something for word-delimited
      // scripts — CJK (Hiragana/Katakana/Han/Hangul) has none, so those
      // stay a plain typed field instead of a false-precision word list
      // (Lyca's own call: fine for this to just not work for CJK rather
      // than guess wrong).
      const cleanOriginal = typeof originalText === 'string' ? originalText.trim() : '';
      // Same Hiragana/Katakana/Han/Hangul ranges as translatableCharCount
      // above (぀-ゟ, ゠-ヿ, 一-鿿, 가-힯);
      // verified directly against real strings in each script (node -e)
      // rather than trusting hand-typed literal CJK boundary characters.
      const sourceClickable = cleanOriginal.length > 0 && !/[぀-ゟ゠-ヿ一-鿿가-힯]/.test(cleanOriginal);
      // Resolved here (not in the prompt window) because that window has
      // no translations.js of its own — same reasoning as mainT() itself,
      // see its doc comment near the top of this file.
      const strings = {
        save: mainT(this.store, 'word_save_button'),
        cancel: mainT(this.store, 'word_save_cancel'),
        placeholder: mainT(this.store, 'word_save_meaning_placeholder'),
        emptyError: mainT(this.store, 'word_save_empty_meaning'),
        error: mainT(this.store, 'word_save_error'),
        success: mainT(this.store, 'word_save_success'),
        // v3.13.45: match mode picker — same 3 modes/labels as the
        // Glosario tab's manual "Agregar" form (mode_exact/
        // mode_case_insensitive/mode_regex, reused as-is rather than
        // adding new word_save_* duplicates for the exact same concept).
        modeExact: mainT(this.store, 'mode_exact'),
        modeCaseInsensitive: mainT(this.store, 'mode_case_insensitive'),
        modeRegex: mainT(this.store, 'mode_regex'),
        // v3.13.46: the new "Término" field and its click-a-word helper.
        termLabel: mainT(this.store, 'word_save_term_label'),
        termPlaceholder: mainT(this.store, 'word_save_term_placeholder'),
        clickHint: mainT(this.store, 'word_save_click_hint'),
        emptyTerm: mainT(this.store, 'word_save_empty_term'),
        // v3.13.49: field label for the meaning input (visual polish pass).
        meaningLabel: mainT(this.store, 'word_save_meaning_label'),
        // v3.13.51: shown in the prompt window's header when there's no
        // specific clicked word (opened via the toolbar button instead).
        genericHeader: mainT(this.store, 'word_save_generic_header')
      };
      const globalLabel = mainT(this.store, 'word_save_scope_global');
      const template = cleanWord
        ? [{ label: `"${cleanWord}"`, enabled: false }, { type: 'separator' }]
        : [];
      template.push({
        label: mainT(this.store, 'word_save_global'),
        click: () => this.windowManager.createWordSavePrompt(cleanWord, 'global', globalLabel, strings, cleanOriginal, sourceClickable)
      });
      if (active) {
        template.push({
          label: mainT(this.store, 'word_save_profile').replace('{profile}', active.name),
          click: () => this.windowManager.createWordSavePrompt(cleanWord, 'profile', active.name, strings, cleanOriginal, sourceClickable)
        });
      }
      Menu.buildFromTemplate(template).popup({ window: this.windowManager.outputOverlay });
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
    // v3.13.40 (profiles Phase 1, step 4): rewritten on top of
    // src/services/profiles/profile-store.js + profile-schema.js — the
    // four hand-written literals that used to build a profile object here
    // (one per handler) had already drifted from each other (apiKey was
    // written by save-profile and never restored by load-profile). Every
    // profile is now keyed by `id`, not `name` — this is what makes
    // rename possible, since name used to BE the primary key.
    //
    // What changed in behavior:
    // - create-profile no longer clones the active profile by default.
    //   Pass cloneFromId explicitly (see duplicate-profile) to get the old
    //   "inherit my current setup" behavior — previously that happened
    //   silently even though the UI showed an empty card.
    // - Credentials (deeplKey/openaiKey/apiKey), targetLang, and
    //   textractorCliPath/Port are no longer read from or written to a
    //   profile at all — they're promoted to global settings (Phase 1
    //   step 3's migration). profileToSettings()/settingsToProfile() are
    //   the only two places that translate between a profile and the
    //   global settings object, replacing every hand-rolled field list
    //   that used to live in this file.
    // - The glossary is two layers now (step 5): settingsToProfile() never
    //   reads or writes profile.glossary — the outgoing profile's layer is
    //   left exactly as the glossary IPC handlers last set it — but
    //   load-profile DOES call glossary.setProfileLayer(incoming.glossary)
    //   below, since the INCOMING profile's layer must become active for
    //   translation immediately, not just its stored snapshot.

    ipcMain.handle('get-profiles', () => {
      const profiles = this.profileStore.list();
      const activeProfileId = this.profileStore.getActiveId();
      return { profiles, activeProfileId };
    });

    ipcMain.handle('save-profile', (event, profileId) => {
      if (typeof profileId !== 'string' || !profileId) {
        return { success: false, error: 'Invalid profile id' };
      }
      const currentSettings = this.store.get();
      const updated = this.profileStore.update(profileId, (current) => ({
        ...settingsToProfile(currentSettings, current),
        history: this.pipeline.getHistory()
      }));
      if (!updated) return { success: false, error: 'Profile not found' };
      return { success: true, profile: updated };
    });

    ipcMain.handle('create-profile', (event, { name, cloneFromId } = {}) => {
      try {
        const created = this.profileStore.create({ name, cloneFromId });
        return { success: true, profile: created };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('rename-profile', (event, { id, newName } = {}) => {
      try {
        const updated = this.profileStore.rename(id, newName);
        return { success: true, profile: updated };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('duplicate-profile', (event, { id, newName } = {}) => {
      try {
        const created = this.profileStore.duplicate(id, newName);
        return { success: true, profile: created };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('delete-profile', async (event, id) => {
      try {
        // v3.13.6x (Fase 6): best-effort cleanup of the profile's remote
        // DeepL glossary (if auto-sync ever created one) BEFORE the
        // profile record itself is gone — otherwise the glossaryId is lost
        // and the remote resource is orphaned in the user's DeepL account
        // forever (DeepL also caps the number of glossaries per account).
        // Never blocks the actual deletion: a DeepL API hiccup here must
        // not prevent removing a profile.
        const target = this.profileStore.getById(id);
        if (target?.deeplGlossarySync?.glossaryId) {
          try {
            const deeplEngine = this.pipeline.getEngine('deepl');
            await deleteDeeplGlossary({
              baseUrl: deeplEngine.baseUrl,
              apiKey: deeplEngine.apiKey,
              glossaryId: target.deeplGlossarySync.glossaryId
            });
          } catch (cleanupErr) {
            console.error(`[Tuhua] Failed to clean up DeepL glossary for deleted profile "${target.name}": ${cleanupErr.message}`);
          }
        }

        const removed = this.profileStore.remove(id);
        if (!removed) return { success: false, error: 'Profile not found' };
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('load-profile', (event, id) => {
      const incoming = this.profileStore.getById(id);
      if (!incoming) return { success: false, error: 'Profile not found' };

      // Save the OUTGOING profile's current settings before switching —
      // same intent as before ("a profile switch snapshots what you were
      // doing"), now via settingsToProfile() instead of a hand-written
      // field list. Deliberately does NOT touch glossary here — the
      // outgoing profile's glossary layer is only ever mutated through the
      // glossary IPC handlers (save/delete/import above), never implicitly
      // by switching away from it.
      const activeId = this.profileStore.getActiveId();
      if (activeId && activeId !== id) {
        const currentSettings = this.store.get();
        this.profileStore.update(activeId, (current) => ({
          ...settingsToProfile(currentSettings, current),
          history: this.pipeline.getHistory()
        }));
      }

      const profileSettings = profileToSettings(incoming);
      this.store.set(profileSettings);
      this.pipeline.updateSettings(profileSettings);

      // v3.13.40 (step 5): the INCOMING profile's glossary layer becomes
      // the active one — this is the other half of the two-layer glossary
      // (see setProfileLayer's own doc comment in glossary.js). Without
      // this, a profile switch would silently keep applying the PREVIOUS
      // profile's terms.
      this.glossary.setProfileLayer(incoming.glossary);

      // v3.13.19: A profile switch is the closest thing this app has to
      // "changed games" — the previous game's dialogue context must not
      // bleed into the new one.
      this.pipeline.clearContext();

      const historyLimit = this.store.get('historyLimit', 5);
      const limitedHistory = Array.isArray(incoming.history)
        ? (historyLimit > 0 ? incoming.history.slice(0, historyLimit) : [])
        : [];
      this.pipeline.replaceHistory(limitedHistory);

      this.profileStore.setActive(id);

      return {
        success: true,
        settings: profileSettings,
        activeProfileId: id,
        hasGlossary: !!(incoming.glossary && incoming.glossary.length),
        hasHistory: !!(incoming.history && incoming.history.length)
      };
    });

    ipcMain.handle('get-active-profile', () => {
      return this.profileStore.getActiveId();
    });

    // ===== API Key Validation =====
    ipcMain.handle('validate-api-key', async (event, { engine, apiKey, endpoint, provider }) => {
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
            // v3.13.58 (Fase 3): this used to be hardcoded to OpenAI's own
            // API — now it hits whichever provider's baseUrl was selected
            // (llm-providers.js), so "Validar" actually validates the key
            // against the provider the dropdown has selected. `endpoint`
            // (the 'custom' provider's user-typed URL) wins when set, same
            // precedence as the real request path in openai.js.
            const selectedProvider = llmProviders.getProvider(provider) || llmProviders.getProvider('openai');
            const base = endpoint || selectedProvider.baseUrl;
            if (!base) {
              return { valid: false, code: 'endpoint_not_configured', params: {} };
            }
            const resp = await axios.get(`${base}/models`, {
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

    // v3.13.6x (Fase 9 testing follow-up): one shared channel for the
    // overlay's new "↻" toolbar button AND the Ctrl+Shift+R global
    // shortcut (fixed here too — see _retranslateCurrent's own comment
    // for why it did nothing before this).
    ipcMain.on('request-retranslate', () => {
      this._retranslateCurrent();
    });

    // v3.13.40-fix: sendSync (not invoke/handle) — main-preload.js calls
    // this synchronously while building the `api` object, so app.getVersion()
    // needs to be available before contextBridge.exposeInMainWorld runs.
    ipcMain.on('get-app-version', (event) => {
      event.returnValue = app.getVersion();
    });

    // v3.13.40-fix: confirm-dialog/alert-dialog (native dialog.showMessageBox
    // over IPC) briefly lived here, as the fix for window.confirm()/alert()
    // leaving the renderer's keyboard focus broken after they closed (a
    // known Electron quirk — see git history if curious). Removed again:
    // a native OS dialog fixed the focus bug but can't be restyled at all
    // (showed up as a plain Windows message box), so it was replaced by
    // showConfirm()/showToast() in renderer.js — an in-page modal that
    // never touches the native blocking dialog APIs, so the focus bug
    // never applied to it either. Nothing calls these IPC channels anymore.

    // ===== OCR =====
    ipcMain.handle('ocr-start', async () => {
      return this._startOcrCapture();
    });

    ipcMain.handle('ocr-stop', async () => {
      try {
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
        // force:true — manual capture is an explicit user action, so it must
        // bypass the similarity dedup that the auto-capture loop relies on
        // (otherwise clicking the button while the same line is on screen
        // silently does nothing, see v3.13.75 OCR test round)
        const result = await this.ocrService.recognize(imageBuffer, { force: true });
        return { success: true, text: result.text, confidence: result.confidence };
      } catch (err) {
        console.error('[OCR] Capture error:', err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('ocr-status', async () => {
      return this.ocrService.getStatus();
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
  async _handleText(text, { force = false } = {}) {
    // v3.13.6x (LLM engine overhaul, Fase 7a): captured here, not lower —
    // the two builtin filters right below (angle-bracket removal, Japanese
    // quote extraction) both DESTROY the speaker's name on their way to
    // producing clean dialogue text. Extracting it first, before either
    // filter runs, is what lets the name survive at all while leaving the
    // filters' own job (and the text they hand back) completely unchanged.
    let speakerName = null;
    // v3.8.25: Safety net — strip any remaining null bytes, control chars,
    // and apply deduplication for text that arrives from TCP (bypassing _cleanGameText)
    if (text) {
      const originalText = text;
      text = text.replace(/[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, '');

      const speakerResult = speakerExtract.extractSpeaker(text);
      speakerName = speakerResult.speaker;
      text = speakerResult.text;

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
      // force=true (manual capture button) bypasses this — the user explicitly
      // asked to rescan, so an identical result must still reach the overlay.
      if (!force && this._lastOcrTextHash === textHash) {
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
    this._lastSpeakerName = speakerName;

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
      this.windowManager.sendToOutputOverlay('update-output', { text: text, originalText: text, targetLang: tgtLang });
      return;
    }

    // Translate
    try {
      console.log(`[Tuhua] Calling pipeline.translate() with engine=${engineName}...`);
      const translation = await this.pipeline.translate(text, {
        source: srcLang,
        target: tgtLang,
        engine: engineName,
        // v3.13.6x (Fase 7a): extracted above, before the filters that
        // would otherwise destroy it — see this method's top comment.
        speaker: speakerName
      });

      // v3.13.6x (Fase 9 testing follow-up, ronda 4): was substring(0, 60)
      // — too short to ever recover the FULL text of a real-world bad
      // output (e.g. a refusal that slipped past the sanitizer) from an
      // exported log, which is exactly what made a real refusal-leak find
      // during testing un-rootcause-able after the fact. 300 is still a
      // truncation (very long lines exist), but covers the actual refusal
      // boilerplates seen so far with room to spare.
      console.log(`[Tuhua] Translation result: "${translation?.substring(0, 300)}${translation && translation.length > 300 ? '...' : ''}"`);
      // v3.13.06: Double-check that translation is still active before sending
      // to overlay. There can be a race condition where the user pauses
      // translation while a pipeline.translate() call is in-flight.
      if (!this._translationActive) {
        console.log(`[Tuhua] Translation became paused during translate — discarding result`);
        return;
      }
      // Send translation to output overlay. v3.13.46: originalText rides
      // along too — needed so a right-click on a translated word can
      // offer the ACTUAL original-language line for the user to pick the
      // real source term from (see overlay-word-context-menu below),
      // instead of the previous behavior of saving the CLICKED
      // (translated) word as the glossary entry's `source` — backwards
      // for a source→target glossary, and the exact bug Lyca flagged.
      this.windowManager.sendToOutputOverlay('update-output', { text: translation, originalText: text, targetLang: tgtLang });
    } catch (err) {
      // v3.13.55: a SUPERSEDED error means the debounce in pipeline.translate()
      // rejected this call because newer text arrived before it fired — routine,
      // expected behavior on every fast-scrolling line, not a translation
      // failure. It used to fall through to the generic branch below and paint
      // `[Error] Translation superseded by new text` over the overlay, which
      // could flash on screen for any line the debounce superseded.
      if (err.code === 'SUPERSEDED') {
        return;
      }
      console.error(`[Tuhua] Translation error:`, err.message);
      this.windowManager.sendToOutputOverlay('update-output', {
        text: `[Error] ${err.message}`
      });
    }
  }

  /**
   * v3.13.6x (Fase 9 testing follow-up): re-translate whatever line is
   * CURRENTLY shown, using CURRENT settings — the overlay's new "↻" toolbar
   * button, next to 📖+. Real bug found by Lyca: Ctrl+Shift+R has fired
   * `shortcut-pressed{action:'retranslate'}` since it was added, but
   * handleShortcut() in renderer.js only ever handled
   * 'toggle-clickthrough' — 'retranslate' silently did nothing, ever. This
   * replaces it with an actual, verified path.
   *
   * Only meaningful for Textractor/Clipboard/OCR — the three input methods
   * that actually show the floating output overlay this button lives on.
   * `_lastHandledText`/`_lastSpeakerName` are set by _handleText() for all
   * three, so one implementation covers them with no per-input-method
   * branching — unlike OCR's separate "📸 Capturar ahora" button (that one
   * re-reads the SCREEN; this one re-reads the last text Tuhua already
   * received, which is the only thing Textractor/Clipboard even have).
   * v3.13.6x correction (Lyca, same day): does NOT apply to XUAT — XUAT
   * replaces text directly inside the game via XUnity.AutoTranslator, it
   * has no output overlay at all, and its text never reaches
   * _handleText() in the first place (xuat-server.js calls
   * pipeline.translateNow() directly) — so `_lastHandledText` is never set
   * from XUAT either way.
   *
   * Uses translateNow() (no debounce) like the existing engine/language
   * auto-retranslate above, but — unlike that one — explicitly pushes the
   * result to the output overlay: translateNow()'s return value alone only
   * reaches the main window's small preview panel via pipeline's own
   * 'translation' event (see index.js), never the floating overlay.
   */
  async _retranslateCurrent() {
    if (!this._lastHandledText) {
      console.log('[Tuhua] Retranslate requested but there is no last text yet — ignoring');
      return;
    }
    const settings = this.store.get();
    const srcLang = settings.sourceLang || 'ja';
    const tgtLang = settings.targetLang || 'es';
    const engineName = settings.engine || 'google-free';
    console.log(`[Tuhua] Manual retranslate requested: engine=${engineName} (${srcLang} → ${tgtLang})`);
    try {
      // v3.13.6x (Fase 9 testing follow-up, ronda 6): bypassMemory:true —
      // the ↻ button IS an explicit "redo this now" request; without it, a
      // cache/TM hit could answer from an OLD prompt/engine and this call
      // would never reach the engine at all, which is exactly what made
      // preset comparisons via this button look broken.
      const translation = await this.pipeline.translateNow(this._lastHandledText, {
        source: srcLang,
        target: tgtLang,
        engine: engineName,
        speaker: this._lastSpeakerName,
        bypassMemory: true
      });
      // v3.13.6x (Fase 9 testing follow-up, ronda 5): this path never
      // logged its result at all — unlike _handleText's normal flow (see
      // its own "[Tuhua] Translation result:" line), which made a real
      // race condition here (fixed alongside this — see
      // pipeline.js's translateNow()) much harder to diagnose from an
      // exported log than it needed to be.
      console.log(`[Tuhua] Manual retranslate result: "${translation?.substring(0, 300)}${translation && translation.length > 300 ? '...' : ''}"`);
      this.windowManager.sendToOutputOverlay('update-output', {
        text: translation,
        originalText: this._lastHandledText,
        targetLang: tgtLang
      });
    } catch (err) {
      if (err.code === 'SUPERSEDED') {
        console.log('[Tuhua] Manual retranslate superseded by a newer request — discarding');
        return;
      }
      console.error('[Tuhua] Manual retranslate failed:', err.message);
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
   * v3.13.50: extracted from the 'ocr-start' IPC handler so the SAME
   * initialization path can be triggered from two places — the user
   * pressing ▶ Activo in OCR mode (via ocr-start), AND switching the
   * input method to OCR while Tuhua is already active (save-settings'
   * input-method-switch block) — which used to just leave the capture
   * area window uncreated until the user manually paused/resumed,
   * exactly Lyca's report ("cambio a OCR estando activo y no aparece
   * el overlay de input").
   *
   * Also where the "capture area always starts paused" fix lives: this
   * used to unconditionally call _startOcrAutoCapture() at the end,
   * meaning every fresh OCR session started scanning immediately,
   * before the user had a chance to reposition the capture region.
   * _ocrScanPaused is now force-set true on every call (it's a instance
   * field that otherwise persists stale across an entire app session,
   * not reset by ocr-stop) and auto-capture is deliberately NOT started
   * here — only the user's own press of the capture area's ⏸/▶ button
   * (ocr-toggle-scan) starts it, consistent with the same "user
   * positions the region first" intent already documented for the
   * ocr-start entry point.
   */
  async _startOcrCapture() {
    try {
      const settings = this.store.get();
      const sourceLang = settings.sourceLang || 'ja';

      // v3.13.01: Restore OCR engine from settings before initializing
      if (settings.ocrEngine) {
        this.ocrService.setOcrEngine(settings.ocrEngine);
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
      this.ocrService.on('text', (text, { force } = {}) => {
        console.log(`[OCR] Text recognized: "${text.substring(0, 50)}..."`);
        this._handleText(text, { force });
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

      // v3.13.79 (Fase 3, round-3 plan): the opposite direction of
      // paddle-fallback above — Tesseract quality has been persistently
      // poor for this session (see OcrService._trackTesseractQualityAndMaybeAdvise())
      // and PaddleOCR is available to switch to. Same bridging pattern:
      // internal event name changes at the IPC boundary
      // ('engine-advice' -> 'ocr-engine-advice'), listener reset first
      // because ocr-start can run repeatedly. This does NOT auto-switch the
      // engine or touch the store — the renderer shows a dismissible
      // suggestion and the user decides (mirrors the v3.13.76 game-engine
      // advisory's "suggest, don't decide for the user" rule).
      this.ocrService.removeAllListeners('engine-advice');
      this.ocrService.on('engine-advice', ({ reason, badCount, meanConfidence }) => {
        console.log(`[OCR] Suggesting PaddleOCR (reason=${reason}, badCount=${badCount}, meanConfidence=${meanConfidence})`);
        this.windowManager.sendToMainWindow('ocr-engine-advice', {
          suggestedEngine: 'paddle',
          reason,
          badCount,
          meanConfidence
        });
      });

      this._ocrActive = true;
      // v3.13.50: see this method's doc comment — always paused on a
      // fresh start, regardless of whatever this flag was left at from
      // a previous session (ocr-stop never resets it).
      this._ocrScanPaused = true;

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

      // v3.13.77 (Stage 4, OCR-refinement round): no longer needed — the
      // real preprocessing defaults (grayscale on, no upscale/Otsu) now
      // live directly in OcrService's constructor. This used to re-push a
      // hardcoded copy of the same defaults on every OCR start, which was
      // never anything but a no-op restatement of the constructor values.

      // v3.13.50: auto-capture is NOT started here anymore — see this
      // method's doc comment. The capture area opens paused; the user's
      // own press of its ⏸/▶ button (ocr-toggle-scan) is what starts it.

      // v3.13.01-fix: Return actual engine used (may differ from requested if fallback occurred)
      const actualEngine = this.ocrService.getOcrEngine();
      return { success: true, status: this.ocrService.getStatus(), engine: actualEngine };
    } catch (err) {
      console.error('[OCR] Start error:', err.message);
      // Clean up: close capture area if start failed
      this.windowManager.closeCaptureArea();
      return { success: false, error: err.message };
    }
  }

  /**
   * Start OCR auto-capture with the configured (or best default) interval
   */
  _startOcrAutoCapture() {
    // v3.9.9: 3500ms default (was 7000ms). Faster scanning means game
    // dialogue is picked up sooner. The similarity-based dedup prevents
    // re-translating the same text, so faster scans are safe. Sequential
    // processing + change detection prevent overload.
    // v3.13.8x (settings UX audit): exposed as `ocrCaptureIntervalMs` in
    // the modal's Avanzado category — read fresh here, at OCR start, same
    // as xuatPort and other settings this file only reads at the moment
    // the corresponding session/server starts. Changing it while OCR is
    // already running takes effect the next time capture (re)starts
    // (switching input method away and back, or app restart) — not a live
    // mid-session interval swap, which startAutoCapture()'s own setTimeout
    // chain (see ocr.js) doesn't support.
    const intervalMs = this.store.get('ocrCaptureIntervalMs', 3500);
    this.ocrService.startAutoCapture(async () => {
      return await this._captureScreenRegion();
    }, intervalMs);
  }

  unregister() {
    const channels = [
      'get-settings', 'save-settings',
      // v3.13.58 (LLM engine overhaul, Fase 3)
      'get-llm-providers',
      // v3.13.59 (Fase 4)
      'get-prompt-presets',
      'get-glossary', 'save-glossary', 'delete-glossary-entry',
      'import-glossary', 'export-glossary', 'browse-save-json', 'browse-open-json',
      'get-history', 'clear-history', 'export-history', 'clear-context',
      'get-profiles', 'save-profile', 'create-profile', 'delete-profile', 'load-profile',
      'get-active-profile', 'rename-profile', 'duplicate-profile',
      'validate-api-key', 'test-connection', 'detect-font-family',
      'ocr-capture', 'ocr-start', 'ocr-stop', 'ocr-status',
      'ocr-close-capture-area', 'ocr-toggle-scan', 'get-displays',
      'textractor-validate-cli', 'textractor-browse-cli', 'textractor-launch',
      'list-game-processes',
      'textractor-kill', 'textractor-cli-status', 'textractor-cli-output',
      'textractor-select-hook', 'textractor-test-cli', 'resize-overlay', 'get-debug-logs',
      'xuat-start-server', 'xuat-stop-server', 'xuat-get-status',
      'xuat-select-game', 'xuat-detect-game', 'xuat-install-in-game', 'xuat-set-port',
      'xuat-test-endpoint', 'xuat-update-language', 'xuat-clear-cache',
      // v3.11.27: VNDB glossary import
      'vndb-search', 'vndb-import',
      // v3.11.28: DeepL feature detection
      'deepl-fetch-features',
      // v3.11.30: Regex text filter
      'get-regex-filters', 'save-regex-filter', 'delete-regex-filter',
      'toggle-regex-filter', 'reorder-regex-filters', 'test-regex-filter', 'reset-regex-filters',
      // v3.13.21: HOOK cleaning step settings
      'get-hook-cleaning-steps', 'toggle-hook-cleaning-step', 'set-hook-cleaning-cjk-only',
      'reset-hook-cleaning-steps',
      // v3.13.01: PaddleOCR engine selection
      'set-ocr-engine', 'get-ocr-engine-status'
    ];
    channels.forEach(ch => ipcMain.removeHandler(ch));
    ipcMain.removeAllListeners('manual-translate');
    ipcMain.removeAllListeners('get-app-version');
    ipcMain.removeAllListeners('overlay-word-context-menu');
    ipcMain.removeAllListeners('request-retranslate');
    // Cleanup OCR
    if (this.ocrService) {
      this.ocrService.stopAutoCapture();
    }
    this.registered = false;
  }
}

module.exports = IpcHandlers;
