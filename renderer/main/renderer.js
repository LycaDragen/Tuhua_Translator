        const api = window.tuhuaAPI;
        let currentLang = 'es';
        let currentInputMethod = 'textractor';
        // v3.13.40: two layers — global (glossaryEntries) and the active
        // profile's own (profileGlossaryEntries). currentGlossaryScope
        // picks which one the Glosario tab is currently showing/editing.
        let glossaryEntries = [];
        let profileGlossaryEntries = [];
        let currentGlossaryScope = 'global';
        // v3.13.55: ids of entries whose pattern failed to compile (invalid
        // regex, typically) — see glossary.js getCompileErrors(). Populated
        // by loadGlossary(), read by renderGlossary() for the warning badge.
        let glossaryCompileErrorIds = new Set();
        let historyEntries = [];
        let profileList = [];
        let translationActive = true;
        // In-memory store for per-engine API keys (synced to settings on save).
        // v3.13.58 (Fase 3): `.openai` became `.llm`, a MAP keyed by provider id
        // (llm-providers.js) — switching the cloud provider dropdown must not
        // lose whichever key was typed for a different provider, same reasoning
        // `.deepl` already had for the deepl/openai engine swap.
        let engineApiKeys = { deepl: '', llm: {} };
        // v3.13.58: llm-providers.js lives in the main process — this is the
        // renderer's cached copy, fetched once via loadLlmProviders(). Used to
        // populate the provider/local-preset selects and the model datalist.
        let llmProvidersCatalog = { providers: [], localPresets: [] };
        // v3.13.59 (Fase 4): prompt-presets.js's actual template prose lives
        // only in the main process — fetched once via loadPromptPresets().
        let promptPresetsCatalog = { presets: [], defaultTemplate: '' };
        // v3.10.8: Staged changes — settings changes are held in the UI
        // until the user clicks "Aplicar y Guardar"/"Aplicar". Only Tier A
        // controls (see markUnsaved()'s doc comment) auto-save.
        // sidebarDirty/modalDirty/glossaryDirty are declared right next to
        // markUnsaved()/markSaved(), which are their only readers/writers.
        // Staged glossary changes — entries added/deleted before save
        let stagedGlossaryAdds = [];    // entries to add on save
        let stagedGlossaryDeletes = []; // entry IDs to delete on save
        // v3.13.40: profile create/rename/duplicate/delete are no longer
        // staged — they're immediate IPC calls (see the Profiles section
        // below). Staging them was what caused create-profile's silent
        // "clone the active profile" default in the first place: the
        // staged {name} object carried no memory of what the user saw on
        // screen, so the backend had to guess a source profile at flush
        // time.
        // v3.13.39: was declared inside init()'s listener block, where
        // registerIpcListeners() (see its own doc) used to live inline —
        // hoisted to module scope so the extraction doesn't change its
        // lifetime (still exactly one counter for the process's lifetime).
        let xuatTranslationCount = 0;

        // v3.13.12: Normalize language codes that may come from translation APIs.
        // Google Translate sometimes returns 'izh' (Izhorian) when misidentifying
        // Korean. If this gets saved as sourceLang, the dropdown shows nothing.
        // This function maps unknown/obsolete codes to valid dropdown values.
        const SOURCE_LANG_NORMALIZE = {
            'izh': 'ko', 'chr': 'en', 'haw': 'en',
            'jpn': 'ja', 'jp': 'ja', 'kor': 'ko', 'kr': 'ko',
            'eng': 'en', 'zh-cn': 'zh', 'zh-tw': 'zh'
        };
        function normalizeSourceLang(code) {
            if (!code) return 'auto';
            const lower = code.toLowerCase();
            return SOURCE_LANG_NORMALIZE[lower] || code;
        }

        // v3.13.39: extracted out of init()'s body. init() is re-invoked on
        // resetSettingsToDefaults() and loadProfile() (a full settings
        // reload), and secureOn (src/preload/main-preload.js) is a bare
        // ipcRenderer.on with no dedup — every one of those re-runs used to
        // register a SECOND copy of every listener below, so a profile
        // switch mid-session would double (then triple, ...) every status
        // update, toast, and countdown reset. registerIpcListeners() is now
        // called exactly once, right before the FIRST init() call, at the
        // bottom of this file.
        function registerIpcListeners() {
            api.onTextractorStatus((status) => { tcpStatus = status; recomputeBadge(); });
            api.onTranslationResult((data) => {
                // v3.13.37: the first real translation result IS the "found
                // dialogue" signal the search countdown is waiting for —
                // gated to textractor so switching to clipboard/OCR/xuat
                // mid-search doesn't stop a countdown that isn't showing.
                if (currentInputMethod === 'textractor') stopSearchCountdown();
                updateLiveTranslation(data);
            });
            api.onTranslationError((data) => updateLiveError(data));
            api.onShortcutPressed((data) => handleShortcut(data));
            api.onTextractorCliStatusChanged((status) => updateCliStatus(status));
            api.onTextractorCliOutput((text) => appendCliOutput(text));
            api.onTextractorCliError((errorData) => showCliError(errorData));
            // v3.13.37: backend told us a hook-discovery window just
            // started (fresh launch or an internal arch-fallback retry) —
            // show a live countdown instead of a dead "Launch" button.
            api.onTextractorCliSearchStarted(({ arch, durationMs }) => startSearchCountdown(arch, durationMs));
            // v3.13.23: x64<->x86 auto-fallback — same "toast + status text"
            // pattern already used for onOcrEngineFallback below.
            api.onTextractorCliArchFallback(({ from, to, reason }) => {
                const t = translations[currentLang] || translations['en'];
                const template = t.textractor_arch_fallback_toast || '{from} sin resultado, probando {to}...';
                const notice = template.replace('{from}', from).replace('{to}', to);
                showToast(notice);
                // v3.13.32: also remembered here (not just painted once) so
                // the 'relaunching' case in updateCliStatus can re-show it
                // across the killed/exited -> relaunching -> launched
                // sequence the handover actually produces.
                cliArchFallbackNotice = notice;
                const text = document.getElementById('cli-status-text');
                if (text) text.innerHTML = '<span class="text-amber-500 pulse-dot">⟳ ' + notice + '</span>';
            });
            // v3.13.8x (settings UX audit, Fase 5): live push for the
            // "switched to Textractor mid-session, no saved path" case —
            // see handleTextractorAutoDetectResult()'s own doc comment.
            // Registered once here; the read-once pull path (get-
            // textractor-auto-detect-result, called from init() itself)
            // covers the app-startup case, which can't safely use a push
            // (the renderer isn't guaranteed ready yet at that point).
            api.onTextractorCliPathAutodetected((result) => handleTextractorAutoDetectResult(result));
            // v3.13.32: was emitted by the launcher (src/main/index.js) but
            // missing from main-preload.js's ALLOWED_RECEIVE_CHANNELS, so
            // this listener could never actually fire — a warning meant to
            // tell the user their PID isn't a running process (which fails
            // exactly as silently as an architecture mismatch) never
            // reached the UI. Non-blocking: just a status-text hint.
            api.onTextractorCliPidWarning(({ pid, message }) => {
                const text = document.getElementById('cli-status-text');
                const statusBar = document.getElementById('cli-status-bar');
                if (text && statusBar) {
                    statusBar.classList.remove('hidden');
                    text.innerHTML = '<span class="text-amber-500">⚠ ' + message + '</span>';
                }
            });
            // v3.13.32: a fallback proved which architecture actually works
            // for this install — see TextractorLauncher's _markArchSuccess
            // doc. Must update the PATH INPUT itself, not just settings:
            // maybeAutoLaunchTextractor()/doLaunchTextractor() read
            // `#textractor-cli-path`'s current DOM value directly, not the
            // persisted setting, so without this the next auto-launch
            // would still send the old (proven-broken) path and the whole
            // discovery would be lost.
            api.onTextractorCliArchResolved(({ cliPath }) => {
                const input = document.getElementById('textractor-cli-path');
                if (input) input.value = cliPath;
                const t = translations[currentLang] || translations['en'];
                showToast((t.cli_arch_resolved_toast || 'This architecture works — Tuhua will use it from now on.'));
            });
            api.onHooksDiscovered((data) => updateHookSelector(data));
            // v3.13.85 (Fase C2): the game-engine advisory's own push,
            // replacing the old hooks-discovered piggyback — deliberately a
            // SEPARATE listener, not folded into updateHookSelector, since
            // this must render with zero hooks discovered (Ren'Py/Godot/FNA)
            // and now also fires outside Textractor mode entirely.
            api.onGameEngineAdvice((data) => {
                _lastEngineAdvice = data;
                renderEngineAdvice();
            });
            api.onOcrStatus((status) => updateOcrStatus(status));

            // v3.13.01-fix: Handle PaddleOCR fallback to Tesseract
            api.onOcrEngineFallback(({ engine, reason }) => {
                const t = translations[currentLang] || translations['en'];
                const selectEl = document.getElementById('ocr-engine-select');
                const descEl = document.getElementById('ocr-engine-desc');
                const warningEl = document.getElementById('ocr-paddle-warning');
                // Update selector to reflect actual engine
                if (selectEl) selectEl.value = engine;
                // Show fallback message
                if (descEl) descEl.textContent = t.ocr_paddle_fallback || `PaddleOCR falló, usando Tesseract: ${reason}`;
                if (warningEl) warningEl.classList.add('hidden');
                // Show toast notification
                showToast(t.ocr_paddle_fallback_toast || `PaddleOCR no disponible, usando Tesseract como respaldo`);
            });

            // v3.13.79 (Fase 3, round-3 plan): the opposite direction of
            // onOcrEngineFallback above — Tesseract quality has been
            // persistently poor this session, PaddleOCR is available.
            // Sticky (like _lastEngineAdvice for the game-engine advisory)
            // so it survives a language switch repaint; cleared when the
            // user clicks through in applyOcrEngineAdvice().
            api.onOcrEngineAdvice((data) => {
                _lastOcrEngineAdvice = data;
                renderOcrEngineAdvice();
            });

            // XUAT events
            // v3.11.2: Pass error data to updateXuatStatus for proper error display
            api.onXuatStatus((data) => {
                // Update local tracking variable from event data
                if (data && data.running !== undefined) {
                    xuatServerRunning = data.running;
                }
                updateXuatStatus();
            });
            api.onXuatInstallProgress((data) => {
                if (data.percent && data.percent >= 0) {
                    document.getElementById('xuat-install-bar').style.width = data.percent + '%';
                }
                if (data.status) {
                    document.getElementById('xuat-install-status').textContent = data.status;
                }
                if (data.error) {
                    document.getElementById('xuat-install-status').textContent = 'Error: ' + data.error;
                }
            });

            // XUAT game connected event
            api.onXuatGameConnected((data) => {
                if (data && data.name) {
                    updateXuatConnectedGame(data.name, data.path);
                }
            });

            // XUAT translation request event — update counter in real time
            api.onXuatTranslationRequest((data) => {
                xuatTranslationCount++;
                const counterEl = document.getElementById('xuat-translation-counter');
                const countEl = document.getElementById('xuat-translation-count');
                if (counterEl && countEl) {
                    counterEl.classList.remove('hidden');
                    countEl.textContent = xuatTranslationCount;
                }
            });

            // v3.13.85 (auto-configuración de juegos, Fase B, disparador 2):
            // the trigger that actually solves "abrí Tuhua antes que el
            // juego" — el usuario lanza el juego y vuelve con alt-tab.
            // Registrado UNA sola vez acá (registerIpcListeners corre una
            // vez), nunca dentro de init() (que se re-ejecuta en cada
            // cambio de perfil) — repetirlo ahí apilaría un listener de
            // 'focus' por cada switch de perfil. Throttle de
            // GAME_SCAN_FOCUS_THROTTLE_MS: algunos window managers disparan
            // 'focus' varias veces seguidas en un solo alt-tab.
            let _lastGameScanFocusAt = 0;
            window.addEventListener('focus', () => {
                const now = Date.now();
                if (now - _lastGameScanFocusAt < GAME_SCAN_FOCUS_THROTTLE_MS) return;
                _lastGameScanFocusAt = now;
                scanForKnownGames(false);
            });
        }

        // ===== INITIALIZATION =====
        async function init() {
            if (!api) { console.error('API not available - running outside Electron?'); return; }

            // v3.13.40: was a hardcoded "v3.13.14" string in index.html,
            // stale for many releases (real version was 3.13.39). Reads
            // package.json via api.version instead — see main-preload.js's
            // comment for why it reads the file directly rather than
            // process.env.npm_package_version, so this stays correct in a
            // packaged build too, not only under `pnpm start`.
            const versionBadge = document.getElementById('app-version-badge');
            if (versionBadge && api.version) versionBadge.textContent = 'v' + api.version;

            const settings = await api.getSettings();

            // v3.13.58 (Fase 3): must resolve BEFORE the first toggleInputFields()
            // call below — it populates #llm-provider-select/#local-endpoint-preset,
            // and toggleInputFields() (when engine==='openai') reads the provider
            // select's value to decide what to show/populate.
            await loadLlmProviders();
            // v3.13.59 (Fase 4): populates #prompt-preset-select — read below
            // once settings.promptTemplate is known.
            await loadPromptPresets();

            // Apply saved settings
            if (settings.uiLanguage) {
                document.getElementById('lang-select').value = settings.uiLanguage;
                changeLanguage(settings.uiLanguage);
            }
            applyTheme(settings.theme || 'dark');

            // v3.13.58: provider/model/params restored BEFORE toggleInputFields()
            // runs, same reasoning as loadLlmProviders() above.
            const savedProviderId = settings.llmProvider || 'openai';
            document.getElementById('llm-provider-select').value = savedProviderId;
            document.getElementById('llm-model').value = settings.llmModel || '';
            document.getElementById('llm-custom-baseurl').value = settings.llmCustomBaseUrl || '';
            document.getElementById('llm-temperature').value = settings.llmTemperature ?? 0.3;
            document.getElementById('llm-max-tokens').value = settings.llmMaxTokens ?? 1500;
            const topPEnabled = settings.llmTopP !== null && settings.llmTopP !== undefined;
            document.getElementById('llm-top-p-enabled').checked = topPEnabled;
            document.getElementById('llm-top-p').disabled = !topPEnabled;
            document.getElementById('llm-top-p').value = topPEnabled ? settings.llmTopP : 0.9;
            const savedPresetId = settings.localLlmEndpointPreset || 'custom';
            document.getElementById('local-endpoint-preset').value = savedPresetId;
            // Mirrors onLocalEndpointPresetChange()'s lock logic without its
            // markUnsaved() side effect — this is restoring state, not a change.
            const localEndpointInput = document.getElementById('local-endpoint');
            localEndpointInput.disabled = savedPresetId !== 'custom';
            localEndpointInput.classList.toggle('opacity-60', savedPresetId !== 'custom');

            if (settings.engine) { document.getElementById('engine-select').value = settings.engine; toggleInputFields(); }
            // Restore API key based on current engine
            const savedEngine = settings.engine || 'google-free';
            // Populate in-memory engine API keys from settings
            if (settings.deeplKey) engineApiKeys.deepl = settings.deeplKey;
            // v3.13.58: `.llm` is a map now — see the field's declaration for why
            // (switching providers must not lose a different provider's key).
            // `openaiKey` itself is deliberately not read here anymore — see
            // llm-providers.js's seedProviderKeysFromLegacyOpenAIKey, which
            // promotes it into llmProviderKeys once, in the main process.
            engineApiKeys.llm = { ...(settings.llmProviderKeys || {}) };
            // v3.13.80 fix: restore deeplCustomInstructions UNCONDITIONALLY —
            // not gated behind `savedEngine === 'deepl'` like the rest of this
            // block. Real bug found live by Lyca: `engine` is ALSO
            // profile-scoped, so a freshly created blank profile (default
            // engine: 'google-free') flips the dropdown away from DeepL on
            // load — but this restore used to live INSIDE the DeepL-only
            // branch below, so it never ran at all for that profile, and the
            // PREVIOUS profile's text stayed sitting in the (now hidden)
            // textarea's real .value. The moment anything re-selects DeepL —
            // or anything saves while that stale value is present —
            // it resurfaces, which is how a "default" profile ended up
            // carrying instructions nobody ever typed into it. Must run on
            // every init() (i.e. every profile switch, since loadProfile()
            // calls init()) regardless of which engine is currently active.
            document.getElementById('deepl-custom-instructions').value =
                (settings.deeplCustomInstructions && settings.deeplCustomInstructions.length > 0)
                    ? settings.deeplCustomInstructions.join('\n')
                    : '';
            updateDeepLInstructionsCount();
            updateDeepLInstructionsUI();
            // v3.13.80: formality is profile-scoped now too (Lyca's explicit
            // request) — same fix as deeplCustomInstructions just above, and
            // for the identical reason: this used to live inside the
            // DeepL-only branch below, so switching to a profile whose own
            // `engine` isn't 'deepl' skipped it entirely and left the
            // dropdown showing the PREVIOUS profile's formality. Must always
            // run. '' (a blank/unseeded profile) falls back to 'default' for
            // display, matching deepl.js's setFormality() fallback — changed
            // from 'prefer_more' on Lyca's explicit request, since defaulting
            // every new profile to formal/usted was actively wrong for
            // casual VN dialogue, not just an arbitrary choice. That
            // fallback is NOT written back to the profile just for being
            // displayed; only the legacy 'more'/'less' string migration is
            // persisted, exactly as before.
            {
                let formality = settings.deeplFormality;
                if (formality === 'more') formality = 'prefer_more';
                if (formality === 'less') formality = 'prefer_less';
                document.getElementById('deepl-formality').value = formality || 'default';
                if (settings.deeplFormality && formality !== settings.deeplFormality) {
                    api.saveSettings({ deeplFormality: formality });
                }
            }
            if (savedEngine === 'deepl') {
                document.getElementById('api-key').value = engineApiKeys.deepl || '';
                // v3.11.29: Set initial placeholder based on UI language
                updateDeepLInstructionsPlaceholder();
                // v3.11.28: Fetch language features for dynamic UI
                fetchDeepLLanguageFeatures(engineApiKeys.deepl, settings.targetLang);
            } else if (savedEngine === 'openai') {
                document.getElementById('api-key').value = engineApiKeys.llm[savedProviderId] || '';
                document.getElementById('llm-provider-select').dataset.prevProvider = savedProviderId;
            } else if (settings.apiKey) {
                document.getElementById('api-key').value = settings.apiKey;
            }
            // Track the current engine for per-engine key persistence
            document.getElementById('engine-select').dataset.prevEngine = savedEngine;
            // v3.13.58: a real preset (not 'custom') OWNS the displayed value —
            // showing the stale settings.customEndpoint instead would visually
            // contradict what resolveLocalEndpoint() (pipeline.js) actually uses.
            if (savedPresetId === 'custom') {
                if (settings.customEndpoint) localEndpointInput.value = settings.customEndpoint;
            } else {
                const savedPreset = llmProvidersCatalog.localPresets.find((p) => p.id === savedPresetId);
                if (savedPreset) localEndpointInput.value = savedPreset.baseUrl;
            }
            if (settings.customModel) document.getElementById('local-model').value = settings.customModel;
            if (settings.libretranslateEndpoint) document.getElementById('libretranslate-endpoint').value = settings.libretranslateEndpoint;
            if (settings.customMTEndpoint) document.getElementById('custom-mt-endpoint').value = settings.customMTEndpoint;
            if (settings.customMTMethod) document.getElementById('custom-mt-method').value = settings.customMTMethod;
            if (settings.customMTBody) document.getElementById('custom-mt-body').value = settings.customMTBody;
            if (settings.customMTResponsePath) document.getElementById('custom-mt-response').value = settings.customMTResponsePath;
            if (settings.customMTAuthHeader) document.getElementById('custom-mt-auth').value = settings.customMTAuthHeader;
            // v3.13.12: Normalize source language code before setting dropdown value.
            // Google Translate sometimes returns 'izh' (Izhorian) when misidentifying
            // Korean text. If this gets saved as sourceLang, the dropdown can't display
            // it. Normalize unknown codes to valid dropdown values.
            if (settings.sourceLang) {
                const normalizedSourceLang = normalizeSourceLang(settings.sourceLang);
                document.getElementById('source-lang').value = normalizedSourceLang;
            }
            if (settings.targetLang) document.getElementById('target-lang').value = settings.targetLang;
            // Update target language display
            updateTargetLangDisplay(settings.targetLang || 'es');
            if (settings.outputFontSize) { document.getElementById('font-size-range').value = settings.outputFontSize; document.getElementById('font-size-val').innerText = settings.outputFontSize + 'px'; }
            if (settings.outputTheme) document.getElementById('output-theme').value = settings.outputTheme;
            if (settings.overlayFontFamily) {
                const fontSelect = document.getElementById('overlay-font');
                // Restore font mode (specific font or custom)
                if (settings.overlayFontMode === 'custom') {
                    fontSelect.value = 'custom';
                    document.getElementById('custom-font-input').classList.remove('hidden');
                    if (settings.customFontValue) {
                        document.getElementById('custom-font-input').value = settings.customFontValue;
                    }
                } else if (settings.overlayFontMode) {
                    fontSelect.value = settings.overlayFontMode;
                    if (!fontSelect.value || fontSelect.selectedIndex === -1) {
                        fontSelect.value = "'Segoe UI', 'Noto Sans JP', sans-serif";
                    }
                } else {
                    // Legacy: try to match saved fontFamily to dropdown value
                    fontSelect.value = settings.overlayFontFamily;
                    if (!fontSelect.value || fontSelect.selectedIndex === -1) {
                        fontSelect.value = "'Segoe UI', 'Noto Sans JP', sans-serif";
                    }
                }
                onFontFamilyChange();
            }
            if (settings.overlayOpacity) { document.getElementById('opacity-range').value = settings.overlayOpacity; document.getElementById('opacity-val').innerText = settings.overlayOpacity + '%'; }
            if (settings.textractorCliPath) document.getElementById('textractor-cli-path').value = settings.textractorCliPath;
            // v3.13.8x (settings UX audit, Fase 5): read-once — the
            // backend clears this after the first read, so calling it on
            // every init() (including profile switches) is harmless; it
            // only ever comes back non-null right after a fresh app
            // startup that ran the auto-detect. Already reflected in
            // `settings.textractorCliPath` above if found (index.js
            // persists it before the renderer's first get-settings) — this
            // call's real job is the toast, see its own doc comment.
            handleTextractorAutoDetectResult(await api.getTextractorAutoDetectResult());
            if (settings.manualTextractorMode) document.getElementById('manual-textractor-mode').checked = settings.manualTextractorMode;
            // v3.13.8x (settings UX audit): stopped restoring a persisted
            // gamePid — a PID from a previous session is never valid for
            // this one (every process gets a new PID on launch), so it was
            // being shown as if it were current when it was always stale.
            // See gatherConfig()'s matching removal for the write side.
            if (settings.debounceMs) { document.getElementById('debounce-range').value = settings.debounceMs; document.getElementById('debounce-val').innerText = settings.debounceMs + 'ms'; }
            // v3.13.59 (Fase 4): `settings.systemPrompt` is no longer read here
            // at all — the one-time migration (src/main/index.js) already
            // promoted a non-empty legacy value into `promptTemplate` verbatim
            // before this ever runs. '' resolves to the balanced preset both
            // at render time (llm-base.js) and for the dropdown's initial value
            // (matchPromptPresetId treats '' as "matches balanced").
            const promptTemplateText = settings.promptTemplate || promptPresetsCatalog.defaultTemplate;
            document.getElementById('prompt-template').value = promptTemplateText;
            const matchedPresetId = matchPromptPresetId(settings.promptTemplate || '');
            document.getElementById('prompt-preset-select').value = matchedPresetId;
            updatePromptPresetDesc(matchedPresetId);
            document.getElementById('llm-fewshot-enabled').checked = settings.llmFewShot !== false;
            if (settings.maxContextHistory !== undefined) { document.getElementById('context-range').value = settings.maxContextHistory; document.getElementById('context-val').innerText = settings.maxContextHistory; }
            if (settings.historyLimit) { document.getElementById('history-limit-range').value = settings.historyLimit; document.getElementById('history-limit-val').innerText = settings.historyLimit; }

            // v3.13.8x (settings UX audit): "Avanzado" category restores.
            document.getElementById('deepl-model-type').value = settings.deeplModelType || 'prefer_quality_optimized';
            document.getElementById('advanced-glossary-mode').value = settings.glossaryMode || 'hybrid';
            document.getElementById('enable-translation-memory').checked = settings.enableTranslationMemory !== false;
            if (settings.ocrCaptureIntervalMs) {
                document.getElementById('ocr-interval-range').value = settings.ocrCaptureIntervalMs;
                document.getElementById('ocr-interval-val').innerText = settings.ocrCaptureIntervalMs + 'ms';
            }

            // Click-through toggle - restore from saved settings
            if (settings.clickThrough !== undefined) {
                document.getElementById('click-through-toggle').checked = settings.clickThrough;
            }


            // Cache settings for modal restore
            window._lastSettings = settings;

            // OCR settings - restore OCR engine selector from saved settings
            // v3.13.01: Load OCR engine status (Tesseract/PaddleOCR availability)
            if (settings.ocrEngine) {
                const ocrEngineSelect = document.getElementById('ocr-engine-select');
                if (ocrEngineSelect) ocrEngineSelect.value = settings.ocrEngine;
            }
            loadOcrEngineStatus();

            // Translation active toggle - restore from saved settings
            if (settings.translationActive !== undefined) {
                translationActive = settings.translationActive;
            }
            updateToggleUI();

            // Input method - apply from saved settings
            const savedInputMethod = settings.inputMethod || 'textractor';
            // v3.13.39: setInputMethod() now ends with recomputeBadge(), so
            // the immediate 'watching'/'ocr' badge paint that used to live
            // here is redundant — removing it also removes a stale-code
            // path that painted the badge WITHOUT going through the derived
            // state (it would have shown 'ocr' even if translationActive
            // were false, for example).
            setInputMethod(savedInputMethod);

            // Load tabs data
            loadGlossary();
            loadProfiles();
            loadRegexFilters();
            loadHookCleaningSteps();

            // Restore XUAT port from settings
            if (settings.xuatPort) {
                document.getElementById('xuat-port').value = settings.xuatPort;
            }

            // v3.11.21: Initialize separate language stores for XUAT vs. global methods.
            // The global language selectors are shared — when XUAT is active, "auto" is hidden
            // and values are saved to xuatSourceLang/xuatTargetLang instead of sourceLang/targetLang.
            xuatSavedSourceLang = settings.xuatSourceLang || 'en';
            xuatSavedTargetLang = settings.xuatTargetLang || 'es';
            globalSavedSourceLang = settings.sourceLang || 'auto';
            globalSavedTargetLang = settings.targetLang || 'es';

            // If the current input method is XUAT, apply XUAT language values and hide "auto"
            if (savedInputMethod === 'xuat') {
                const sourceLangEl = document.getElementById('source-lang');
                const autoOption = document.getElementById('source-lang-auto');
                // Hide "auto" option for XUAT
                if (autoOption) autoOption.style.display = 'none';
                // Apply XUAT values to the global selectors
                sourceLangEl.value = xuatSavedSourceLang;
                document.getElementById('target-lang').value = xuatSavedTargetLang;
            }

            // If input method is XUAT, check server status and restore connected game
            if (savedInputMethod === 'xuat') {
                updateXuatStatus();
                // Restore connected game from settings
                if (settings.xuatConnectedGame) {
                    updateXuatConnectedGame(settings.xuatConnectedGame, settings.xuatConnectedPath);
                }
            }

            // v3.13.85 (Fase B, disparador 1): cubre "el juego ya estaba
            // abierto antes de abrir Tuhua". Fire-and-forget, mismo patrón
            // que loadGlossary()/loadProfiles() arriba — silencioso si no
            // hay nada que resolver (manual=false).
            scanForKnownGames(false);
        }

        // ===== UNSAVED CHANGES TRACKER =====
        // v3.10.8: Mark that settings have been changed but not yet saved.
        // The "Aplicar y Guardar"/"Aplicar" buttons show a visual indicator.
        // v3.13.8x (settings UX audit, second pass): #save-btn (sidebar)
        // and #settings-apply-btn (gear modal) each gather a DISJOINT set
        // of Tier B fields (enforced by
        // scripts/test-settings-tier-invariant.js) — but until this pass
        // they shared ONE dirty flag, so editing a field that lives only
        // in the modal (say, the OCR interval slider) also lit up the
        // SIDEBAR's button, and clicking that sidebar button would show
        // "✓ ¡Guardado!" without having saved the modal field at all
        // (gatherConfig() doesn't read it). Real bug Lyca hit from the
        // other direction: close the gear modal without clicking Aplicar,
        // reopen it, the button was still green because nothing had ever
        // cleared modalDirty for a change that was never actually
        // committed (see toggleSettingsModal()'s close branch, which now
        // discards the modal's own pending edits instead of leaving that
        // state stuck). Three independent flags now:
        //   - sidebarDirty: gatherConfig()'s fields (engine, API key,
        //     endpoints, languages, Textractor path...)
        //   - modalDirty: applySettingsModal()'s fields (prompt/LLM
        //     params, context/history/debounce, Avanzado)
        //   - glossaryDirty: stagedGlossaryAdds/-Deletes — genuinely
        //     shared, both saveConfig() and applySettingsModal() flush it,
        //     so it lights up (and clears from) BOTH buttons honestly,
        //     unlike the old blanket sharing.
        // "Tier A" controls (overlay appearance, HOOK cleaning steps,
        // regex filter toggles, theme, UI language, input method, OCR
        // engine, play/pause, DeepL formality/instructions) apply
        // immediately via their own api.saveSettings()/dedicated-IPC call
        // and never call markUnsaved() at all — so a gray button really
        // does mean "nothing pending," not "nothing changed."
        let sidebarDirty = false;
        let modalDirty = false;
        let glossaryDirty = false;

        function _renderSaveButton(btnId, textId, dirty) {
            const t = translations[currentLang] || translations['en'];
            const btn = document.getElementById(btnId);
            const text = document.getElementById(textId);
            if (btn) {
                btn.classList.toggle('save-btn-dirty', dirty);
                btn.classList.toggle('save-btn-idle', !dirty);
            }
            if (text) text.innerText = dirty ? (t.unsaved_changes || 'Guardar Cambios *') : (t.save_btn || 'Aplicar y Guardar');
        }

        function _updateSaveButtonVisuals() {
            _renderSaveButton('save-btn', 'save-btn-text', sidebarDirty || glossaryDirty);
            _renderSaveButton('settings-apply-btn', 'settings-apply-text', modalDirty || glossaryDirty);
        }

        // scope: 'sidebar' | 'modal' | 'glossary' — required, no default,
        // so every call site states which button it's actually claiming
        // will save it (grep for markUnsaved( to audit).
        function markUnsaved(scope) {
            if (scope === 'modal') modalDirty = true;
            else if (scope === 'glossary') glossaryDirty = true;
            else if (scope === 'sidebar') sidebarDirty = true;
            else { console.warn('[Tuhua] markUnsaved() called without a valid scope:', scope); sidebarDirty = true; }
            _updateSaveButtonVisuals();
        }

        // scope: 'sidebar' | 'modal' — the button that was actually
        // clicked. Glossary staging is cleared unconditionally: both
        // saveConfig() and applySettingsModal() flush stagedGlossaryAdds/
        // -Deletes before calling this, so by the time either one calls
        // markSaved(), there is truly nothing glossary-related left
        // pending for the OTHER button either.
        function markSaved(scope) {
            stagedGlossaryAdds = [];
            stagedGlossaryDeletes = [];
            glossaryDirty = false;
            if (scope === 'modal') modalDirty = false;
            else sidebarDirty = false;
            _updateSaveButtonVisuals();
        }

        // v3.13.8x (settings UX audit): the checkmark icon on save-btn/
        // settings-apply-btn used to be permanent button chrome, always
        // visible even at rest — Lyca's feedback was that it should read
        // as "this just saved," not decoration. Shown only for this flash
        // window (2.5s), then hidden again — matches the ✓ text swap that
        // was already there, just extends it to the icon too. Guarded
        // against a newer change landing mid-flash: if the button already
        // went back to dirty (save-btn-dirty) by the time the timeout
        // fires, don't clobber that with the stale "saved" label.
        function flashSaved(textId, checkId) {
            const t = translations[currentLang] || translations['en'];
            const text = document.getElementById(textId);
            const check = document.getElementById(checkId);
            const btn = check ? check.closest('button') : null;
            if (check) check.classList.remove('hidden');
            if (text) text.innerText = '✓ ' + (t.saved_confirm || '¡Guardado!');
            setTimeout(() => {
                if (btn && !btn.classList.contains('save-btn-idle')) return;
                if (check) check.classList.add('hidden');
                if (text) {
                    const t2 = translations[currentLang] || translations['en'];
                    text.innerText = t2.save_btn || 'Aplicar y Guardar';
                }
            }, 2500);
        }

        // ===== LANGUAGE =====
        function changeLanguage(lang) {
            currentLang = lang;
            const t = translations[lang] || translations['en'];
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (t[key]) el.innerText = t[key];
            });

            // v3.13.23: Same pattern as [data-i18n], but for the placeholder
            // attribute of inputs — needed because placeholder text isn't
            // covered by innerText and was previously stuck hardcoded in
            // whatever language was typed into the HTML.
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                const key = el.getAttribute('data-i18n-placeholder');
                if (t[key]) el.placeholder = t[key];
            });

            // Update language selector options (native name + translated name)
            const FLAGS = { auto: '🌐', ja: '🇯🇵', en: '🇺🇸', es: '🇪🇸', zh: '🇨🇳', lzh: '📜', ko: '🇰🇷', ru: '🇷🇺', pt: '🇧🇷', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', ar: '🇸🇦', th: '🇹🇭', vi: '🇻🇳', id: '🇮🇩', tr: '🇹🇷', nl: '🇳🇱', pl: '🇵🇱', uk: '🇺🇦', hi: '🇮🇳' };
            const NATIVE_NAMES = { auto: 'Auto-detect', ja: '日本語', en: 'English', es: 'Español', zh: '中文', lzh: '文言文', ko: '한국어', ru: 'Русский', pt: 'Português', fr: 'Français', de: 'Deutsch', it: 'Italiano', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', tr: 'Türkçe', nl: 'Nederlands', pl: 'Polski', uk: 'Українська', hi: 'हिन्दी' };
            document.querySelectorAll('[data-i18n-lang]').forEach(opt => {
                const code = opt.getAttribute('data-i18n-lang');
                const flag = FLAGS[code] || '';
                if (code === 'auto') {
                    opt.textContent = flag + ' ' + (t.auto_detect || 'Auto-detect');
                } else {
                    // Show: flag + native name only (no parenthesized local name)
                    const nativeName = NATIVE_NAMES[code] || code;
                    opt.textContent = flag + ' ' + nativeName;
                }
            });

            // Update engine selector options
            const ENGINE_ICONS = { 'google-free': '🌐', 'bing': '🔍', 'local-llm': '🤖', 'libretranslate': '🏠', 'deepl': '💎', 'openai': '🧠', 'custom-mt': '⚙️' };
            document.querySelectorAll('[data-i18n-engine]').forEach(opt => {
                const key = opt.getAttribute('data-i18n-engine');
                const icon = ENGINE_ICONS[opt.value] || '';
                if (t[key]) {
                    opt.textContent = icon + ' ' + t[key];
                }
            });

            // Update the custom font option
            const customFontOption = document.querySelector('#overlay-font option[data-i18n-font="custom_font"]');
            if (customFontOption) customFontOption.textContent = '✏️ ' + (t.custom_font || 'Custom...');

            // v3.11.29: Update DeepL custom instructions placeholder for new UI language
            updateDeepLInstructionsPlaceholder();

            // Update engine description for new language (fixes stale description)
            updateEngineDescription();

            // Update the translation toggle button status text
            updateToggleUI();

            // v3.13.39: updateConnectionStatus() replaces the badge's
            // innerHTML with a plain span carrying no data-i18n attribute
            // (see its own comment), so without this the navbar/footer
            // badges stopped following language changes after their first
            // paint. recomputeBadge() also repaints with the CURRENT
            // language's label, not whatever was cached from the last event.
            recomputeBadge();

            // v3.13.76: same reason as recomputeBadge() right above — the
            // game-engine advisory's text is computed, not [data-i18n].
            renderEngineAdvice();
            // v3.13.79: same reason — the OCR-engine advisory's text is
            // also computed, not [data-i18n].
            renderOcrEngineAdvice();

            // v3.13.40: same reason as recomputeBadge() above — the
            // profile cards' default-name label and "Default" badge are
            // computed strings (displayProfileName()), not static
            // data-i18n text, so they need an explicit repaint to follow
            // a language change instead of staying stuck in whatever
            // language they were first rendered in.
            if (profileList.length) renderProfiles();

            // v3.13.85 (Fase B): same reason — the current-game line, the
            // undo banner, and the re-link/suggestion banners are all
            // computed strings with runtime substitutions, not
            // [data-i18n].
            renderGameStatus();
            renderGameBanners();

            api.saveSettings({ uiLanguage: lang });
        }

        // ===== THEME =====
        function toggleTheme() {
            const html = document.documentElement;
            const isDark = html.classList.contains('dark');
            applyTheme(isDark ? 'light' : 'dark');
            api.saveSettings({ theme: isDark ? 'light' : 'dark' });
        }

        function applyTheme(theme) {
            const html = document.documentElement;
            if (theme === 'light') {
                html.classList.remove('dark'); html.classList.add('light');
                document.getElementById('theme-icon-sun').classList.add('hidden');
                document.getElementById('theme-icon-moon').classList.remove('hidden');
            } else {
                html.classList.add('dark'); html.classList.remove('light');
                document.getElementById('theme-icon-moon').classList.add('hidden');
                document.getElementById('theme-icon-sun').classList.remove('hidden');
            }
        }

        // ===== TABS =====
        // v3.13.8x (settings UX audit): used to call discardUnsavedChanges()
        // here — v3.10.10 made switching tabs silently wipe any staged
        // edit (a typed-but-unsaved API key, a staged glossary add, a
        // toggled regex filter) with no warning at all, on the theory that
        // "only Aplicar y Guardar commits" meant anything else was fair
        // game to discard. That's real data loss with zero feedback: click
        // Glosario to check something, click back, the API key you were
        // mid-typing is gone. Tabs are just a view now — staged state
        // (stagedGlossaryAdds/stagedGlossaryDeletes/hasUnsavedChanges/the
        // DOM fields themselves) lives independently of which tab is
        // visible, and only the Save button's own click discards anything.
        // discardUnsavedChanges() had no other caller, so it's removed with
        // this rather than left as dead code.
        function switchTab(name) {
            document.querySelectorAll('[id^="tab-"]').forEach(el => {
                if (el.id.startsWith('tab-btn-')) return;
                el.classList.add('hidden');
            });
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById(`tab-${name}`).classList.remove('hidden');
            document.getElementById(`tab-btn-${name}`).classList.add('active');

            if (name === 'history') loadHistory();
            // v3.13.8x: loadGlossary() re-applies stagedGlossaryAdds/
            // stagedGlossaryDeletes on top of what it fetches now (see its
            // own doc comment) — safe to call here even with staged,
            // unsaved glossary edits pending.
            if (name === 'glossary') loadGlossary();
            if (name === 'profiles') loadProfiles();
        }

        // ===== SETTINGS MODAL =====
        // Collapsible category state
        // v3.13.8x (settings UX audit): 'advanced' starts collapsed
        // (false) — everything else in this object defaults open. Matches
        // the HTML's own `style="display:none"` on #cat-advanced-content,
        // which this state must agree with on first paint (see
        // toggleSettingsCategory()'s chevron/display sync just below).
        const _settingsCatState = { overlay: true, translation: true, glossary: true, textfilter: true, advanced: false };

        function toggleSettingsModal() {
            const modal = document.getElementById('settings-modal');
            if (modal) {
                const willShow = modal.classList.contains('hidden');
                modal.classList.toggle('hidden');
                if (willShow) {
                    // Restore current settings values to the modal controls
                    restoreSettingsModalValues();
                    // Load regex filters for the Text Filter category
                    loadRegexFilters();
                } else if (modalDirty) {
                    // v3.13.8x (settings UX audit): Lyca's real report —
                    // change something in the modal (e.g. the OCR interval
                    // slider), close via the × or the backdrop without
                    // clicking "Aplicar", reopen: the button was still
                    // green, because nothing had ever cleared modalDirty
                    // for an edit that was never actually saved. Closing
                    // the modal is a clear enough "never mind" signal —
                    // unlike switchTab() (see its own doc comment for why
                    // THAT silently discarding was the wrong call): a
                    // modal is something you explicitly open and close,
                    // not a view you're glancing at mid-edit. Discard the
                    // modal's own staged field values back to what's
                    // actually persisted, and clear its dirty flag —
                    // sidebarDirty/glossaryDirty are untouched, so a
                    // pending sidebar edit survives opening/closing the
                    // gear icon to peek at something.
                    discardModalChanges();
                    markSaved('modal');
                }
            }
        }

        // v3.13.8x (settings UX audit): reverts every Tier B field that
        // lives in the gear modal (applySettingsModal()'s gather — prompt/
        // LLM params, context/history/debounce, Avanzado) back to
        // window._lastSettings, the last value actually persisted. Mirrors
        // the equivalent restore lines in init(), duplicated rather than
        // shared because init() also does unrelated setup (OCR status,
        // provider catalogs) this close-without-save path has no business
        // re-running — same reasoning restoreSettingsModalValues() already
        // duplicates its own two fields instead of calling into init().
        function discardModalChanges() {
            const settings = window._lastSettings || {};
            document.getElementById('debounce-range').value = settings.debounceMs || 300;
            document.getElementById('debounce-val').innerText = (settings.debounceMs || 300) + 'ms';
            const promptTemplateText = settings.promptTemplate || (promptPresetsCatalog && promptPresetsCatalog.defaultTemplate) || '';
            document.getElementById('prompt-template').value = promptTemplateText;
            const matchedPresetId = matchPromptPresetId(settings.promptTemplate || '');
            document.getElementById('prompt-preset-select').value = matchedPresetId;
            updatePromptPresetDesc(matchedPresetId);
            document.getElementById('llm-fewshot-enabled').checked = settings.llmFewShot !== false;
            document.getElementById('context-range').value = settings.maxContextHistory ?? 5;
            document.getElementById('context-val').innerText = settings.maxContextHistory ?? 5;
            document.getElementById('history-limit-range').value = settings.historyLimit ?? 5;
            document.getElementById('history-limit-val').innerText = settings.historyLimit ?? 5;
            document.getElementById('llm-temperature').value = settings.llmTemperature ?? 0.3;
            document.getElementById('llm-max-tokens').value = settings.llmMaxTokens ?? 1500;
            const topPEnabled = settings.llmTopP !== null && settings.llmTopP !== undefined;
            document.getElementById('llm-top-p-enabled').checked = topPEnabled;
            document.getElementById('llm-top-p').value = topPEnabled ? settings.llmTopP : 0.9;
            document.getElementById('llm-top-p').disabled = !topPEnabled;
            document.getElementById('deepl-model-type').value = settings.deeplModelType || 'prefer_quality_optimized';
            document.getElementById('advanced-glossary-mode').value = settings.glossaryMode || 'hybrid';
            document.getElementById('enable-translation-memory').checked = settings.enableTranslationMemory !== false;
            document.getElementById('ocr-interval-range').value = settings.ocrCaptureIntervalMs || 3500;
            document.getElementById('ocr-interval-val').innerText = (settings.ocrCaptureIntervalMs || 3500) + 'ms';
            document.getElementById('xuat-port').value = settings.xuatPort || 8419;
        }

        function toggleSettingsCategory(cat) {
            _settingsCatState[cat] = !_settingsCatState[cat];
            const content = document.getElementById(`cat-${cat}-content`);
            const chevron = document.getElementById(`cat-${cat}-chevron`);
            if (_settingsCatState[cat]) {
                content.style.display = '';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                content.style.display = 'none';
                chevron.style.transform = 'rotate(-90deg)';
            }
        }

        function restoreSettingsModalValues() {
            // Read current values from the sidebar/main controls and populate modal
            const settings = window._lastSettings || {};
            document.getElementById('overlay-font').value = settings.overlayFontMode || settings.overlayFontFamily || "'Segoe UI', 'Noto Sans JP', sans-serif";
            const fontSelect = document.getElementById('overlay-font');
            if (fontSelect.selectedIndex === -1) {
                fontSelect.value = "'Segoe UI', 'Noto Sans JP', sans-serif";
            }
            if (settings.overlayFontMode === 'custom') {
                fontSelect.value = 'custom';
                document.getElementById('custom-font-input').classList.remove('hidden');
                document.getElementById('custom-font-input').value = settings.customFontValue || '';
            } else {
                document.getElementById('custom-font-input').classList.add('hidden');
            }
            if (settings.historyLimit) { document.getElementById('history-limit-range').value = settings.historyLimit; document.getElementById('history-limit-val').innerText = settings.historyLimit; }
        }

        // Reset System Prompt to default
        // Apply settings from modal (saves the "Traducción" category — the
        // "Overlay" category above it is Tier A now, applied immediately by
        // saveOverlayImmediate()/toggleClickThrough() as each control
        // changes, so none of it belongs in this gather. See
        // markUnsaved()'s doc comment for the Tier A/B split.)
        async function applySettingsModal() {
            const config = {
                debounceMs: parseInt(document.getElementById('debounce-range').value),
                // v3.13.59 (Fase 4): renamed from systemPrompt
                promptTemplate: document.getElementById('prompt-template').value,
                llmFewShot: document.getElementById('llm-fewshot-enabled').checked,
                maxContextHistory: parseInt(document.getElementById('context-range').value),
                historyLimit: parseInt(document.getElementById('history-limit-range').value),
                // v3.13.8x (settings UX audit): these three live inside this
                // same modal (#llm-params-section) but were never actually
                // saved by its own Apply button — only gatherConfig() (the
                // SIDEBAR's save) picked them up. Editing them here and
                // clicking "Aplicar" silently did nothing; the sidebar's
                // "Aplicar y Guardar" had to be clicked too. Real bug, not a
                // layout choice — every field this modal shows belongs in
                // its own save.
                llmTemperature: parseFloat(document.getElementById('llm-temperature').value),
                llmMaxTokens: parseInt(document.getElementById('llm-max-tokens').value),
                llmTopP: document.getElementById('llm-top-p-enabled').checked ? parseFloat(document.getElementById('llm-top-p').value) : null,
                // v3.13.8x (settings UX audit): "Avanzado" category — new
                // controls for previously-ghost settings (deeplModelType/
                // glossaryMode/enableTranslationMemory had no UI at all
                // before this) plus Manual Mode + xuatPort relocated from
                // the sidebar. Manual Mode is Tier A (data-immediate, saves
                // itself via toggleManualMode()) so it's NOT gathered here.
                deeplModelType: document.getElementById('deepl-model-type').value,
                glossaryMode: document.getElementById('advanced-glossary-mode').value,
                enableTranslationMemory: document.getElementById('enable-translation-memory').checked,
                ocrCaptureIntervalMs: parseInt(document.getElementById('ocr-interval-range').value),
                xuatPort: parseInt(document.getElementById('xuat-port').value) || 8419
            };

            await api.saveSettings(config);

            // v3.10.10: Also apply staged glossary changes (profile
            // create/rename/duplicate/delete are immediate now, see the
            // Profiles section — nothing to flush for them here). Each
            // staged record carries its own scope (v3.13.40, two-layer
            // glossary) — a term staged under "Este perfil" while add-form
            // was in that mode must be saved to the profile layer, not global.
            // v3.13.8x: regex filter toggles (master + per-row) are no
            // longer staged here at all — they're Tier A now, applied
            // immediately by toggleRegexFilterMaster()/toggleRegexFilterEntry()
            // themselves. See markUnsaved()'s doc comment.
            for (const entry of stagedGlossaryAdds) {
                await api.saveGlossaryEntry({ source: entry.source, target: entry.target, mode: entry.mode }, entry.scope);
            }
            for (const item of stagedGlossaryDeletes) {
                await api.deleteGlossaryEntry(item.id, item.scope);
            }

            // Update active profile with new data
            if (activeProfileId) await api.saveProfile(activeProfileId);
            loadProfiles();
            await loadGlossary();

            markSaved('modal');
            flashSaved('settings-apply-text', 'settings-apply-check');
        }

        // Reset all settings to defaults
        async function resetSettingsToDefaults() {
            const t = translations[currentLang] || translations['en'];
            // v3.13.8x (settings UX audit): this button has no confirmation
            // and used to include `textractorPort: 9251` in what it writes —
            // exactly the bug `gatherConfig()` was hardened against in
            // v3.13.38 (a real install can run on a non-default port; a
            // hardcoded reset here silently broke it). See showConfirm()'s
            // own doc comment for why this is an in-page modal, not
            // window.confirm().
            const confirmed = await showConfirm(
                t.settings_reset_confirm || 'Reset these settings to their defaults? Your engine, API key, and Textractor path are not affected.',
                t.dialog_confirm || 'Confirm',
                t.dialog_cancel || 'Cancel'
            );
            if (!confirmed) return;

            const defaults = {
                engine: 'google-free',
                sourceLang: 'auto',
                targetLang: 'es',
                inputMethod: 'textractor',
                outputFontSize: 24,
                outputTheme: 'dark',
                overlayOpacity: 85,
                overlayFontFamily: "'Segoe UI', 'Noto Sans JP', sans-serif",
                overlayFontMode: "'Segoe UI', 'Noto Sans JP', sans-serif",
                customFontValue: '',
                theme: 'dark',
                debounceMs: 300,
                maxContextHistory: 5,
                historyLimit: 5,
                // v3.13.59 (Fase 4): renamed from systemPrompt
                promptTemplate: '',
                llmFewShot: true,
                clickThrough: false,
                enableRegexFilter: true,
                // v3.13.8x: added alongside the applySettingsModal() fix —
                // these three live in the same modal this button's footer
                // belongs to, so "reset" should cover them too.
                llmTemperature: 0.3,
                llmMaxTokens: 1500,
                llmTopP: null,
                // v3.13.8x: Avanzado category defaults. manualTextractorMode
                // intentionally NOT included — it's Tier A, set by its own
                // toggleManualMode() call, not something this bulk reset
                // should silently flip (same reasoning textractorPort was
                // removed for, just above).
                deeplModelType: 'prefer_quality_optimized',
                glossaryMode: 'hybrid',
                enableTranslationMemory: true,
                ocrCaptureIntervalMs: 3500
            };

            await api.saveSettings(defaults);

            // Re-initialize UI with defaults
            await init();

            showToast(t.settings_reset || 'Configuración restablecida');
        }

        // ===== INPUT METHOD =====
        let inputMethodInitialized = false;
        // v3.11.21: Separate language stores for XUAT vs. global methods
        let globalSavedSourceLang = null;
        let globalSavedTargetLang = null;
        let xuatSavedSourceLang = 'en';
        let xuatSavedTargetLang = 'es';
        let previousInputMethod = null;

        function setInputMethod(method) {
            currentInputMethod = method;
            const tBtn = document.getElementById('btn-textractor');
            const cBtn = document.getElementById('btn-clipboard');
            const oBtn = document.getElementById('btn-ocr');
            const xBtn = document.getElementById('btn-xuat');
            const portSection = document.getElementById('textractor-port-section');
            const ocrSettingsSection = document.getElementById('ocr-settings-section');
            const xuatSettingsSection = document.getElementById('xuat-settings-section');
            const ocrDesc = document.getElementById('ocr-desc');
            const xuatDesc = document.getElementById('xuat-desc');

            // Active style
            const activeClass = 'min-w-0 text-center p-2.5 rounded-lg border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-xs font-medium transition';
            const inactiveClass = 'min-w-0 text-center p-2.5 rounded-lg border-2 border-gray-200 dark:border-dark-600 bg-gray-50 dark:bg-dark-900 text-gray-600 dark:text-gray-300 text-xs font-medium transition hover:bg-gray-100 dark:hover:bg-dark-700';

            tBtn.className = method === 'textractor' ? activeClass : inactiveClass;
            cBtn.className = method === 'clipboard' ? activeClass : inactiveClass;
            oBtn.className = method === 'ocr' ? activeClass : inactiveClass;
            xBtn.className = method === 'xuat' ? activeClass : inactiveClass;

            // Show/hide sections based on input method
            // v3.13.8x (settings UX audit): switched from portSection's own
            // inline style.display to classList.toggle('hidden', ...),
            // matching ocrSettingsSection/xuatSettingsSection right below —
            // needed so index.html can ship this section `hidden` by
            // default (it used to have no hidden class at all, so it
            // flashed visible on first paint for anyone whose saved
            // inputMethod isn't textractor, until this function ran and
            // hid it via the OLD inline-style mechanism a moment later).
            portSection.classList.toggle('hidden', method !== 'textractor');
            ocrSettingsSection.classList.toggle('hidden', method !== 'ocr');
            xuatSettingsSection.classList.toggle('hidden', method !== 'xuat');
            ocrDesc.classList.toggle('hidden', method !== 'ocr');
            xuatDesc.classList.toggle('hidden', method !== 'xuat');
            // v3.13.01: Load OCR engine status when OCR section becomes visible
            if (method === 'ocr') {
                loadOcrEngineStatus();
            }

            // v3.11.21: When switching between XUAT and other methods, swap language values.
            // XUAT uses xuatSourceLang/xuatTargetLang (no "auto" allowed),
            // other methods use sourceLang/targetLang (with "auto" allowed).
            const sourceLangEl = document.getElementById('source-lang');
            const autoOption = document.getElementById('source-lang-auto');

            if (method === 'xuat') {
                // Switching TO XUAT: save current values to global, load XUAT values, hide "auto"
                if (previousInputMethod && previousInputMethod !== 'xuat' && inputMethodInitialized) {
                    globalSavedSourceLang = sourceLangEl.value;
                    globalSavedTargetLang = document.getElementById('target-lang').value;
                }
                // Hide "auto" option for XUAT
                if (autoOption) autoOption.style.display = 'none';
                // If current value is "auto", switch to XUAT default
                if (sourceLangEl.value === 'auto') {
                    sourceLangEl.value = xuatSavedSourceLang || 'en';
                }
                // Restore XUAT-specific values if available
                if (xuatSavedSourceLang) sourceLangEl.value = xuatSavedSourceLang;
                if (xuatSavedTargetLang) document.getElementById('target-lang').value = xuatSavedTargetLang;
            } else {
                // Switching AWAY from XUAT: save XUAT values, restore global values, show "auto"
                if (previousInputMethod === 'xuat' && inputMethodInitialized) {
                    xuatSavedSourceLang = sourceLangEl.value;
                    xuatSavedTargetLang = document.getElementById('target-lang').value;
                    // Also persist to store and update AutoTranslatorConfig.ini
                    api.saveSettings({ xuatSourceLang: xuatSavedSourceLang, xuatTargetLang: xuatSavedTargetLang });
                }
                // Show "auto" option for non-XUAT methods
                if (autoOption) autoOption.style.display = '';
                // Restore global values if available
                if (globalSavedSourceLang) sourceLangEl.value = globalSavedSourceLang;
                if (globalSavedTargetLang) document.getElementById('target-lang').value = globalSavedTargetLang;
            }

            // Stop OCR session if switching away from OCR mode
            if (method !== 'ocr' && ocrSessionActive) {
                stopOcrSession();
            }
            // v3.13.50: mirror what the backend now does on this same
            // switch (see the OCR branch of save-settings' input-method
            // handling in ipc-handlers.js) — without this, ocrSessionActive
            // would go stale (stay false even though a session is really
            // running), and a LATER switch away from OCR wouldn't call
            // stopOcrSession() to clean up the Settings panel's status text.
            if (method === 'ocr' && translationActive && inputMethodInitialized) {
                ocrSessionActive = true;
            }

            // v3.11.3: Start/stop XUAT server when switching methods
            // NOTE: We do NOT start/stop the server here — saveSettings handles it.
            if (method === 'xuat' && inputMethodInitialized) {
                updateXuatStatus();
            } else if (method !== 'xuat' && previousInputMethod === 'xuat' && inputMethodInitialized) {
                // saveSettings with inputMethod != xuat will stop the server
            }

            // Save input method only after initialization is complete (not during init)
            if (inputMethodInitialized) {
                api.saveSettings({ inputMethod: method });
            }
            previousInputMethod = method;
            inputMethodInitialized = true;
            recomputeBadge();
        }

        // ===== LLM PROVIDERS (v3.13.58, Fase 3) =====
        // Fetches the provider/local-preset catalog once and populates both
        // <select> elements. Options carry data-i18n so changeLanguage()'s
        // generic [data-i18n] sweep (renderer.js's changeLanguage()) picks them
        // up automatically on a language switch — no separate re-render path
        // needed, same mechanism [data-i18n-lang]/[data-i18n-engine] options use.
        async function loadLlmProviders() {
            try {
                llmProvidersCatalog = await api.getLlmProviders();
            } catch (e) {
                console.error('Failed to load LLM providers:', e);
                return;
            }
            const t = translations[currentLang] || translations['en'];

            const providerSelect = document.getElementById('llm-provider-select');
            providerSelect.innerHTML = llmProvidersCatalog.providers.map((p) =>
                `<option value="${p.id}" data-i18n="${p.labelKey}">${t[p.labelKey] || p.id}</option>`
            ).join('');

            const presetSelect = document.getElementById('local-endpoint-preset');
            presetSelect.innerHTML = llmProvidersCatalog.localPresets.map((p) =>
                `<option value="${p.id}" data-i18n="${p.labelKey}">${t[p.labelKey] || p.id}</option>`
            ).join('');
        }

        // Shared by onLlmProviderChange() (user interaction) and init() (restoring
        // saved settings) — everything EXCEPT the key-swap/markUnsaved side effects,
        // which only make sense on a real user-driven change.
        function updateLlmProviderUI(providerId) {
            const provider = llmProvidersCatalog.providers.find((p) => p.id === providerId);

            const baseUrlRow = document.getElementById('llm-custom-baseurl-row');
            if (baseUrlRow) baseUrlRow.classList.toggle('hidden', providerId !== 'custom');

            const betaNote = document.getElementById('llm-provider-beta-note');
            if (betaNote) betaNote.classList.toggle('hidden', !(provider && provider.beta));

            const modelInput = document.getElementById('llm-model');
            // v3.13.6x (Fase 9 testing follow-up): replaces a native
            // <datalist> — kept on the input's own dataset (not a global)
            // so a provider swap always has the RIGHT list even if the
            // user never re-focuses the field before switching providers.
            if (modelInput) {
                modelInput.dataset.models = JSON.stringify(provider?.models || []);
                modelInput.placeholder = provider?.defaultModel || '';
            }
        }

        // v3.13.6x (Fase 9 testing follow-up): the Modelo field's
        // suggestions list — see index.html's llm-model-row comment for
        // why this replaced a native <datalist> (Chromium's native
        // datalist popup and its input chrome both ignore authored CSS;
        // two rounds of CSS-only attempts confirmed this on real hardware).
        function renderModelSuggestions(models) {
            const box = document.getElementById('llm-model-suggestions');
            if (!box) return;
            if (!models.length) {
                box.classList.add('hidden');
                box.innerHTML = '';
                return;
            }
            box.innerHTML = models.map((m) =>
                `<div class="model-option" data-model="${escapeHtml(m)}">${escapeHtml(m)}</div>`
            ).join('');
            box.classList.remove('hidden');
        }

        function showModelSuggestions() {
            const modelInput = document.getElementById('llm-model');
            if (!modelInput) return;
            const models = JSON.parse(modelInput.dataset.models || '[]');
            renderModelSuggestions(models);
        }

        function filterModelSuggestions() {
            const modelInput = document.getElementById('llm-model');
            if (!modelInput) return;
            const models = JSON.parse(modelInput.dataset.models || '[]');
            const query = modelInput.value.trim().toLowerCase();
            const filtered = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;
            renderModelSuggestions(filtered);
        }

        // Click a suggestion (event delegation — the list is rebuilt on
        // every render, so binding once here beats re-binding per item).
        // v3.13.8x: the game process picker used to extend this same
        // listener, but it's a floating overlay now (openGameProcessPicker())
        // with its own scoped click handler, matching openVndbImportModal() —
        // an ephemeral element appended/removed from document.body doesn't
        // need a permanent global listener watching for it.
        document.addEventListener('click', (e) => {
            const option = e.target.closest('#llm-model-suggestions .model-option');
            if (option) {
                const modelInput = document.getElementById('llm-model');
                modelInput.value = option.dataset.model;
                document.getElementById('llm-model-suggestions').classList.add('hidden');
                markUnsaved('sidebar');
                return;
            }
            // Click anywhere outside the field+list closes it.
            if (!e.target.closest('#llm-model-row')) {
                const box = document.getElementById('llm-model-suggestions');
                if (box) box.classList.add('hidden');
            }
        });

        function onLlmProviderChange() {
            const newProviderId = document.getElementById('llm-provider-select').value;
            const prevProviderId = document.getElementById('llm-provider-select').dataset.prevProvider;
            const currentApiKey = document.getElementById('api-key').value;
            if (prevProviderId && currentApiKey) {
                engineApiKeys.llm[prevProviderId] = currentApiKey;
            }
            document.getElementById('llm-provider-select').dataset.prevProvider = newProviderId;
            document.getElementById('api-key').value = engineApiKeys.llm[newProviderId] || '';

            updateLlmProviderUI(newProviderId);
            markUnsaved('sidebar');
        }

        // v3.13.58: fills AND LOCKS the endpoint field for a real preset (Ollama/
        // LM Studio/llama.cpp/KoboldCpp) — 'custom' (the default) leaves it exactly
        // as free text, unchanged from how this field worked before this existed.
        function onLocalEndpointPresetChange() {
            const presetId = document.getElementById('local-endpoint-preset').value;
            const endpointInput = document.getElementById('local-endpoint');
            if (presetId === 'custom') {
                endpointInput.disabled = false;
                endpointInput.classList.remove('opacity-60');
            } else {
                const preset = llmProvidersCatalog.localPresets.find((p) => p.id === presetId);
                if (preset) endpointInput.value = preset.baseUrl;
                endpointInput.disabled = true;
                endpointInput.classList.add('opacity-60');
            }
            markUnsaved('sidebar');
        }

        // ===== PROMPT TEMPLATE (v3.13.59, Fase 4) =====
        const PROMPT_PRESET_DESC_KEYS = {
            balanced: 'prompt_preset_balanced_desc',
            literal: 'prompt_preset_literal_desc',
            localized: 'prompt_preset_localized_desc',
            uncensored: 'prompt_preset_uncensored_desc',
            custom: ''
        };

        async function loadPromptPresets() {
            try {
                promptPresetsCatalog = await api.getPromptPresets();
            } catch (e) {
                console.error('Failed to load prompt presets:', e);
                return;
            }
            const t = translations[currentLang] || translations['en'];
            const select = document.getElementById('prompt-preset-select');
            const presetOptions = promptPresetsCatalog.presets.map((p) =>
                `<option value="${p.id}" data-i18n="${p.labelKey}">${t[p.labelKey] || p.id}</option>`
            ).join('');
            select.innerHTML = presetOptions + `<option value="custom" data-i18n="prompt_preset_custom">${t.prompt_preset_custom || 'Custom'}</option>`;
        }

        // Matches the CURRENT textarea text against the catalog the same way
        // prompt-presets.js's matchPresetId() does server-side (byte-identical
        // text = that preset), but also treats '' as "matches balanced" — ''
        // is what an unset/reset promptTemplate setting actually stores (it
        // resolves to DEFAULT_TEMPLATE at render time, llm-base.js), so the
        // dropdown should show "Balanced" selected, not "Custom", for a fresh
        // install that has never touched this field.
        function matchPromptPresetId(text) {
            const effectiveText = text || promptPresetsCatalog.defaultTemplate;
            const preset = promptPresetsCatalog.presets.find((p) => p.template === effectiveText);
            return preset ? preset.id : 'custom';
        }

        function updatePromptPresetDesc(presetId) {
            const t = translations[currentLang] || translations['en'];
            const descKey = PROMPT_PRESET_DESC_KEYS[presetId] || '';
            document.getElementById('prompt-preset-desc').innerText = descKey ? (t[descKey] || '') : '';
        }

        function onPromptPresetChange() {
            const presetId = document.getElementById('prompt-preset-select').value;
            if (presetId !== 'custom') {
                const preset = promptPresetsCatalog.presets.find((p) => p.id === presetId);
                if (preset) document.getElementById('prompt-template').value = preset.template;
            }
            // 'custom' selected directly (rather than reached by editing):
            // leave the textarea as whatever it already had — nothing to fill in.
            updatePromptPresetDesc(presetId);
            markUnsaved('modal');
        }

        // Keeps the preset <select> in sync while the user hand-edits the
        // advanced textarea, WITHOUT calling onPromptPresetChange() (that would
        // overwrite what they just typed back to a preset's canned text).
        function onPromptTemplateEdited() {
            const text = document.getElementById('prompt-template').value;
            const matchedId = matchPromptPresetId(text);
            document.getElementById('prompt-preset-select').value = matchedId;
            updatePromptPresetDesc(matchedId);
            markUnsaved('modal');
        }

        function resetPromptTemplate() {
            document.getElementById('prompt-template').value = promptPresetsCatalog.defaultTemplate;
            document.getElementById('prompt-preset-select').value = 'balanced';
            updatePromptPresetDesc('balanced');
            api.saveSettings({ promptTemplate: '' });
            const t = translations[currentLang] || translations['en'];
            showToast(t.prompt_reset || 'Prompt restablecido al valor por defecto');
        }

        // ===== ENGINE FIELDS =====
        function toggleInputFields() {
            const engine = document.getElementById('engine-select').value;
            const keySec = document.getElementById('api-key-section');
            const localSec = document.getElementById('local-config-section');
            const libreSec = document.getElementById('libretranslate-section');
            const customSec = document.getElementById('custom-mt-section');
            // llm-options removed in v3.10.4 — system prompt always visible in settings modal
            const desc = document.getElementById('engine-desc');
            const t = translations[currentLang] || translations['en'];

            // Save current API key to the previous engine before switching
            const prevEngine = document.getElementById('engine-select').dataset.prevEngine;
            const currentApiKey = document.getElementById('api-key').value;
            if (prevEngine === 'deepl' && currentApiKey) {
                engineApiKeys.deepl = currentApiKey;
                api.saveSettings({ deeplKey: currentApiKey });
            } else if (prevEngine === 'openai' && currentApiKey) {
                // v3.13.58: keyed by provider now, not a single flat key — see
                // engineApiKeys.llm's declaration. Persists into the SAME
                // llmProviderKeys map save-side merges into (save-settings does
                // `{...current, ...data}`, so this one-key object is additive,
                // never clobbers a different provider's already-saved key).
                const providerId = document.getElementById('llm-provider-select').value;
                engineApiKeys.llm[providerId] = currentApiKey;
                api.saveSettings({ llmProviderKeys: { ...engineApiKeys.llm } });
            }
            document.getElementById('engine-select').dataset.prevEngine = engine;

            const ENGINE_DESC_MAP = {
                'google-free': 'desc_google_free',
                'bing': 'desc_bing',
                'local-llm': 'desc_local_llm',
                'libretranslate': 'desc_libretranslate',
                'deepl': 'desc_deepl',
                'openai': 'desc_openai',
                'custom-mt': 'desc_custom_mt'
            };
            const descKey = ENGINE_DESC_MAP[engine] || 'desc_google_free';
            desc.innerText = t[descKey] || t.desc_google_free;

            keySec.classList.add('hidden'); localSec.classList.add('hidden');
            libreSec.classList.add('hidden'); customSec.classList.add('hidden');
            // llmOpts hidden by default (no longer needed)

            // Reset validation states
            ['api-key-status', 'local-endpoint-status', 'libretranslate-status', 'custom-mt-status'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
            });
            // Reset input border colors
            ['api-key', 'local-endpoint', 'libretranslate-endpoint', 'custom-mt-endpoint'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.classList.remove('border-emerald-400', 'dark:border-emerald-600', 'border-red-400', 'dark:border-red-600'); }
            });
            // Reset API key section container color
            keySec.classList.remove('bg-emerald-50', 'dark:bg-emerald-900/10', 'border-emerald-200', 'dark:border-emerald-900/30',
                                    'bg-red-50', 'dark:bg-red-900/10', 'border-red-200', 'dark:border-red-900/30');
            keySec.classList.add('bg-amber-50', 'dark:bg-amber-900/10', 'border-amber-200', 'dark:border-amber-900/30');

            if (['deepl', 'openai'].includes(engine)) keySec.classList.remove('hidden');
            if (engine === 'local-llm') { localSec.classList.remove('hidden'); }
            if (engine === 'libretranslate') libreSec.classList.remove('hidden');
            if (engine === 'custom-mt') customSec.classList.remove('hidden');

            // v3.13.58 (Fase 3): provider dropdown + model field, only for the
            // cloud LLM engine (not DeepL, which shares api-key-section but has
            // no concept of a "provider").
            const llmProviderRow = document.getElementById('llm-provider-row');
            const llmModelRow = document.getElementById('llm-model-row');
            if (llmProviderRow) llmProviderRow.classList.toggle('hidden', engine !== 'openai');
            if (llmModelRow) llmModelRow.classList.toggle('hidden', engine !== 'openai');
            if (engine === 'openai') {
                updateLlmProviderUI(document.getElementById('llm-provider-select').value);
            }

            // Shared by both LLM engines — see the section's own comment in
            // index.html for why these are global settings, not per-profile.
            const llmParamsSec = document.getElementById('llm-params-section');
            if (llmParamsSec) llmParamsSec.classList.toggle('hidden', !['openai', 'local-llm'].includes(engine));

            // v3.11.23: Show DeepL formality dropdown only when DeepL is selected
            const deeplFormalitySec = document.getElementById('deepl-formality-section');
            if (deeplFormalitySec) {
                deeplFormalitySec.classList.toggle('hidden', engine !== 'deepl');
            }
            // v3.11.28: Show DeepL custom instructions only when DeepL is selected
            const deeplInstructionsSec = document.getElementById('deepl-custom-instructions-section');
            if (deeplInstructionsSec) {
                deeplInstructionsSec.classList.toggle('hidden', engine !== 'deepl');
            }
            // v3.11.28: Hide feature notice when not DeepL
            const deeplNoticeSec = document.getElementById('deepl-feature-notice');
            if (deeplNoticeSec) {
                deeplNoticeSec.classList.add('hidden');
            }

            // v3.13.19: Google/Bing translate each line independently — the
            // pipeline still sends them the context window (it doesn't hurt
            // anything), but they ignore it, so the slider would do nothing.
            // Confirmed empirically, not assumed: concatenating a real
            // antecedent sentence into the same translation request produced
            // byte-identical output to translating the line alone.
            const contextUnsupported = ['google-free', 'bing'].includes(engine);
            const contextRange = document.getElementById('context-range');
            const contextVal = document.getElementById('context-val');
            const contextNote = document.getElementById('context-unsupported-note');
            if (contextRange) {
                contextRange.disabled = contextUnsupported;
                contextRange.classList.toggle('opacity-50', contextUnsupported);
            }
            if (contextVal) {
                contextVal.classList.toggle('opacity-50', contextUnsupported);
            }
            if (contextNote) {
                contextNote.classList.toggle('hidden', !contextUnsupported);
            }

            // Load engine-specific API key after showing the right section
            if (engine === 'deepl') {
                document.getElementById('api-key').value = engineApiKeys.deepl || '';
            } else if (engine === 'openai') {
                const providerId = document.getElementById('llm-provider-select').value;
                document.getElementById('api-key').value = engineApiKeys.llm[providerId] || '';
                document.getElementById('llm-provider-select').dataset.prevProvider = providerId;
            } else {
                document.getElementById('api-key').value = '';
            }

            const select = document.getElementById('engine-select');
            document.getElementById('display-engine').innerText = select.options[select.selectedIndex]?.text || engine;
        }

        // ===== CONNECTION STATUS =====
        function updateConnectionStatus(status) {
            const badge = document.getElementById('connection-badge');
            const t = translations[currentLang] || translations['en'];
            let label, colorClass;

            switch (status) {
                case 'connected':
                    label = t.status_connected;
                    colorClass = 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50';
                    break;
                case 'reconnecting':
                    label = t.status_reconnecting;
                    colorClass = 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800/50';
                    break;
                case 'watching':
                    label = t.status_watching;
                    colorClass = 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/50';
                    break;
                case 'ocr':
                    label = t.status_ocr || 'OCR Mode';
                    colorClass = 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/50';
                    break;
                case 'xuat':
                    label = t.status_xuat || 'XUAT Mode';
                    colorClass = 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/50';
                    break;
                case 'searching':
                    // v3.13.39: the up-to-60s window between TextractorCLI
                    // launching and the first real game text — distinct from
                    // 'reconnecting' on purpose (nothing is retrying here,
                    // Textractor is looking). #cli-search-status carries the
                    // numeric countdown; this is the always-visible summary.
                    label = t.status_searching || 'Searching for text…';
                    colorClass = 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/50';
                    break;
                default:
                    label = t.status_disconnected;
                    colorClass = 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/50';
            }

            badge.className = `flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${colorClass}`;
            const dot = (status === 'connected' || status === 'searching') ? '<span class="w-1.5 h-1.5 rounded-full bg-current pulse-dot"></span>' : '<span class="w-1.5 h-1.5 rounded-full bg-current"></span>';
            badge.innerHTML = `${dot} <span>${label}</span>`;

            // v3.13.39: #connection-badge-bottom used to be referenced by no
            // JavaScript at all — it kept the markup's hardcoded gray
            // "Disconnected" for the whole session, in the footer, directly
            // under a navbar badge that could say something completely
            // different. Keeps the footer's muted typography; only the dot
            // carries colour.
            const bottom = document.getElementById('connection-badge-bottom');
            if (bottom) {
                const DOT = {
                    connected: 'bg-emerald-500', searching: 'bg-amber-500',
                    reconnecting: 'bg-yellow-500', watching: 'bg-blue-500',
                    ocr: 'bg-purple-500', xuat: 'bg-purple-500'
                };
                bottom.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${DOT[status] || 'bg-red-500'}"></span> <span>${label}</span>`;
            }
        }

        // v3.13.39: derived badge state — see src/services/badge-state.js
        // for the full rationale and the decision table itself. Nothing
        // here paints the badge directly anymore; every call site that used
        // to call updateConnectionStatus(status) now updates the relevant
        // piece of state and calls recomputeBadge(), so the badge is always
        // a pure function of "what's actually happening" rather than
        // "whatever event arrived last".
        let tcpStatus = '';
        let cliEverExtracted = false;

        function recomputeBadge() {
            updateConnectionStatus(deriveBadgeStatus({
                currentInputMethod,
                translationActive,
                xuatServerRunning,
                cliRunning,
                cliEverExtracted,
                tcpStatus
            }));
        }

        // ===== LIVE TRANSLATION =====
        function updateLiveTranslation(data) {
            if (data.targetLang) {
                updateTargetLangDisplay(data.targetLang);
            }
            // v3.13.6x (Fase 9 testing follow-up, ronda 4): pipeline.js has
            // sent isFallback:true since the fallback chain existed — this
            // was the first UI code to ever read that field. Lyca noticed
            // an invalid API key produced no visible signal at all (not
            // even the persistent-toast pattern already used for the
            // Textractor arch-fallback and PaddleOCR->Tesseract fallbacks).
            if (data.isFallback) {
                const t = translations[currentLang] || translations['en'];
                const template = t.translation_fallback_toast || 'Primary translation engine failed, using fallback ({engine})';
                showToast(template.replace('{engine}', data.engine || ''));
            }
            loadHistory();
        }

        function updateLiveError(data) {
            // v3.13.6x (Fase 9 testing follow-up, ronda 4): pipeline.js's
            // 'error' event (ALL engines including every fallback failed)
            // had zero listeners on the renderer side — silently dropped,
            // same gap as the isFallback case above.
            const t = translations[currentLang] || translations['en'];
            const template = t.translation_failed_toast || 'Translation failed: {error}';
            showToast(template.replace('{error}', data.error || ''));
        }

        // ===== DEBUG LOGS (v3.10.0) =====
        async function copyDebugLogs() {
            try {
                const result = await api.getDebugLogs();
                if (result.success && result.logContent) {
                    await navigator.clipboard.writeText(result.logContent);
                    showToast('Logs copiados al portapapeles');
                } else {
                    showToast('No se pudieron obtener los logs');
                }
            } catch (err) {
                showToast('Error: ' + err.message);
            }
        }

        // v3.13.41: stays on screen until the user closes it (X, top-right)
        // instead of auto-fading after 2s — real feedback was that longer
        // messages (import results, error details) didn't stay up long
        // enough to read.
        // v3.13.6x (Fase 9 testing follow-up, ronda 5): was a single-slot
        // toast (a new call replaced whatever was showing) — Lyca noticed
        // that a fallback/error notification could fire while an earlier
        // toast was still up unclosed, and the new one silently replaced
        // it instead of both being visible. Now a stack: each call adds a
        // toast to a fixed-position container (flex column-reverse, newest
        // prepended so it lands in the bottom slot — the same slot the
        // single toast used to occupy), older ones pushed upward. Closing
        // one lets flexbox reflow the rest down to fill the gap on its
        // own — no manual positioning math needed.
        function showToast(message) {
            let container = document.getElementById('tuhua-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'tuhua-toast-container';
                container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column-reverse;align-items:center;gap:8px;max-width:min(420px,90vw);width:min(420px,90vw);';
                document.body.appendChild(container);
            }

            const toast = document.createElement('div');
            toast.className = 'tuhua-toast';
            toast.style.cssText = 'display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;padding:10px 10px 10px 16px;border-radius:10px;font-size:13px;font-weight:500;background:#1e293b;color:#10b981;border:1px solid rgba(16,185,129,0.3);transition:opacity 0.15s ease;';

            const text = document.createElement('span');
            text.style.cssText = 'flex:1;word-break:break-word;';
            text.textContent = message;

            const closeBtn = document.createElement('button');
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.textContent = '×';
            closeBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:inherit;opacity:0.6;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;';
            closeBtn.onmouseenter = () => { closeBtn.style.opacity = '1'; };
            closeBtn.onmouseleave = () => { closeBtn.style.opacity = '0.6'; };
            closeBtn.onclick = () => {
                toast.style.opacity = '0';
                setTimeout(() => {
                    toast.remove();
                    if (!container.hasChildNodes()) container.remove();
                }, 150);
            };

            toast.appendChild(text);
            toast.appendChild(closeBtn);
            // Newest toast takes the bottom slot (the container's
            // main-start in column-reverse) — prepend, not append.
            container.prepend(toast);
        }

        // ===== CLICK THROUGH =====
        // v3.13.8x (settings UX audit): Tier A now — was `markUnsaved()`
        // only, so toggling this checkbox and closing the modal without
        // hitting the sidebar's separate "Aplicar y Guardar" silently did
        // nothing at all (save-settings is what actually calls
        // windowManager.toggleClickThrough(), see ipc-handlers.js). Applies
        // and persists in the same call now, like the Ctrl+Shift+M
        // shortcut handler right below always has.
        function toggleClickThrough(enabled) {
            api.saveSettings({ clickThrough: enabled });
            window._lastSettings = { ...(window._lastSettings || {}), clickThrough: enabled };
        }

        function handleShortcut(data) {
            if (data.action === 'toggle-clickthrough') {
                const toggle = document.getElementById('click-through-toggle');
                toggle.checked = data.state;
                // Also save the new state so it persists
                api.saveSettings({ clickThrough: data.state });
            } else if (data.action === 'retranslate') {
                // v3.13.6x (Fase 9 testing follow-up): real bug — this
                // shortcut has fired since it was registered, but this
                // branch never existed, so Ctrl+Shift+R has done nothing,
                // ever. requestRetranslate() re-translates whatever the
                // overlay is currently showing with current settings (see
                // ipc-handlers.js's _retranslateCurrent) — same action the
                // overlay's new "↻" toolbar button triggers.
                api.requestRetranslate();
            }
        }

        // ===== FONT FAMILY =====
        // Map source languages to recommended font stacks
        const FONT_AUTO_DETECT_MAP = {
            'ja': "'Meiryo', 'MS Gothic', 'Noto Sans JP', sans-serif",
            'zh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', sans-serif",
            'lzh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', serif",  // v3.13.08-fix: Classical Chinese uses Chinese fonts with serif
            'ko': "'Noto Sans KR', 'Malgun Gothic', sans-serif",
            'th': "'Tahoma', 'Noto Sans Thai', sans-serif",
            'vi': "'Tahoma', 'Noto Sans', sans-serif",
            'ar': "'Tahoma', 'Noto Sans Arabic', sans-serif",
            'hi': "'Tahoma', 'Noto Sans Devanagari', sans-serif",
            'ru': "'Segoe UI', 'Noto Sans', sans-serif",
            'en': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif",
            'es': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif",
            'pt': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif",
            'fr': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif",
            'de': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif",
            'it': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif",
            'auto': "'Segoe UI', 'Noto Sans JP', 'Noto Sans SC', sans-serif"
        };

        function getAutoDetectedFont(sourceLang) {
            return FONT_AUTO_DETECT_MAP[sourceLang] || FONT_AUTO_DETECT_MAP['auto'];
        }

        function onFontFamilyChange() {
            const select = document.getElementById('overlay-font');
            const customInput = document.getElementById('custom-font-input');

            if (select.value === 'custom') {
                customInput.classList.remove('hidden');
            } else {
                customInput.classList.add('hidden');
            }
        }

        // Get the effective font family value
        function getEffectiveFontFamily() {
            const select = document.getElementById('overlay-font');
            if (select.value === 'custom') {
                const customVal = document.getElementById('custom-font-input').value.trim();
                return customVal || "'Segoe UI', sans-serif";
            }
            return select.value;
        }

        // v3.13.8x (settings UX audit): the whole "Overlay" category (font,
        // size, theme, opacity) is Tier A — see markUnsaved()'s doc comment
        // for why. save-settings already pushes an `update-style` to the
        // live output overlay whenever these fields are present
        // (ipc-handlers.js), so there's nothing else to wire for the change
        // to actually show up — this is only about WHEN it's sent, not a
        // new code path.
        async function saveOverlayImmediate() {
            const partial = {
                outputFontSize: parseInt(document.getElementById('font-size-range').value),
                outputTheme: document.getElementById('output-theme').value,
                overlayFontFamily: getEffectiveFontFamily(),
                overlayFontMode: document.getElementById('overlay-font').value,
                customFontValue: document.getElementById('custom-font-input').value,
                overlayOpacity: parseInt(document.getElementById('opacity-range').value)
            };
            await api.saveSettings(partial);
            window._lastSettings = { ...(window._lastSettings || {}), ...partial };
        }

        // v3.13.8x: live preview while dragging font-size-range/
        // opacity-range — Lyca asked for the overlay to visibly update
        // WHILE dragging, not only on release. Debounced (~80ms) rather
        // than called on every 'input' tick: each call is a real
        // electron-store write (synchronous disk I/O), and a slider fires
        // input events much faster than that during a drag. `change`
        // (drag-release) still calls saveOverlayImmediate() directly and
        // un-debounced, so the final position is never left waiting on a
        // pending timer.
        let _overlayLiveDebounceTimer = null;
        function saveOverlayImmediateDebounced() {
            clearTimeout(_overlayLiveDebounceTimer);
            _overlayLiveDebounceTimer = setTimeout(saveOverlayImmediate, 80);
        }

        // ===== LANGUAGE CHANGE =====
        // v3.13.8x (settings UX audit): renamed from autoSaveLanguage() —
        // for the common (non-XUAT) case this only calls markUnsaved(), it
        // never saved anything itself. The name was actively misleading:
        // it read as Tier A (immediate) when the real behavior was Tier B
        // (staged, needs the Save button). See markUnsaved()'s doc comment.
        function onLanguageChange() {
            const sourceLang = document.getElementById('source-lang').value;
            const targetLang = document.getElementById('target-lang').value;

            // v3.11.21: When XUAT is active, save to xuatSourceLang/xuatTargetLang
            // and update AutoTranslatorConfig.ini immediately.
            // When other methods are active, track in global variables for later restore.
            if (currentInputMethod === 'xuat') {
                xuatSavedSourceLang = sourceLang;
                xuatSavedTargetLang = targetLang;
                api.saveSettings({ xuatSourceLang: sourceLang, xuatTargetLang: targetLang });
                // Update AutoTranslatorConfig.ini if a game is connected
                api.xuatUpdateLanguage(sourceLang, targetLang).then(result => {
                    if (result.success) {
                        const t = translations[currentLang] || translations['en'];
                        showToast(t.xuat_lang_updated || `Idiomas XUAT actualizados: ${sourceLang} → ${targetLang}`);
                    }
                }).catch(err => {
                    console.log('[XUAT] Language saved but config not updated:', err.message);
                });
            } else {
                // Track global language values so they can be restored when switching back from XUAT
                globalSavedSourceLang = sourceLang;
                globalSavedTargetLang = targetLang;
            }

            updateTargetLangDisplay(targetLang);
            updateEngineDescription();

            // v3.11.28: When target language changes and DeepL is selected,
            // re-evaluate which features are available for the new language
            const engine = document.getElementById('engine-select')?.value;
            if (engine === 'deepl') {
                fetchDeepLLanguageFeatures(engineApiKeys.deepl, targetLang);
            }

            markUnsaved('sidebar');
        }

        // Update engine description based on current engine and language
        function updateEngineDescription() {
            const engine = document.getElementById('engine-select').value;
            const desc = document.getElementById('engine-desc');
            const t = translations[currentLang] || translations['en'];
            const ENGINE_DESC_MAP = {
                'google-free': 'desc_google_free',
                'bing': 'desc_bing',
                'local-llm': 'desc_local_llm',
                'libretranslate': 'desc_libretranslate',
                'deepl': 'desc_deepl',
                'openai': 'desc_openai',
                'custom-mt': 'desc_custom_mt'
            };
            const descKey = ENGINE_DESC_MAP[engine] || 'desc_google_free';
            desc.innerText = t[descKey] || t.desc_google_free;
        }

        // ===== API KEY VALIDATION =====
        function setValidationStatus(statusEl, inputEl, containerEl, result) {
            statusEl.classList.remove('hidden');
            const icon = result.valid
                ? '<svg class="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>'
                : '<svg class="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>';

            if (result.valid) {
                statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-emerald-600 dark:text-emerald-400';
                inputEl.classList.remove('border-red-400', 'dark:border-red-600');
                inputEl.classList.add('border-emerald-400', 'dark:border-emerald-600');
                if (containerEl) {
                    containerEl.classList.remove('bg-red-50', 'dark:bg-red-900/10', 'border-red-200', 'dark:border-red-900/30');
                    containerEl.classList.add('bg-emerald-50', 'dark:bg-emerald-900/10', 'border-emerald-200', 'dark:border-emerald-900/30');
                }
            } else {
                statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-red-600 dark:text-red-400';
                inputEl.classList.remove('border-emerald-400', 'dark:border-emerald-600');
                inputEl.classList.add('border-red-400', 'dark:border-red-600');
                if (containerEl) {
                    containerEl.classList.remove('bg-emerald-50', 'dark:bg-emerald-900/10', 'border-emerald-200', 'dark:border-emerald-900/30');
                    containerEl.classList.add('bg-red-50', 'dark:bg-red-900/10', 'border-red-200', 'dark:border-red-900/30');
                }
            }

            // v3.11.30: Support both code-based (i18n) and legacy message-based validation results
            const message = result.code ? translateValidationCode(result.code, result.params) : result.message;
            statusEl.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
        }

        /**
         * v3.11.30: Translate validation result codes to localized messages.
         * Replaces hardcoded Spanish strings with i18n-aware messages.
         */
        function translateValidationCode(code, params) {
            const p = params || {};
            const t = (key) => {
                const lang = translations[currentLang] || translations['es'];
                return lang[key] || key;
            };
            switch (code) {
                case 'deepl_key_valid':
                    return t('validate_deepl_key_valid').replace('{type}', p.type).replace('{used}', p.used).replace('{limit}', p.limit);
                case 'deepl_key_valid_short':
                    return t('validate_deepl_key_valid_short').replace('{type}', p.type);
                case 'deepl_key_invalid':
                    return t('validate_deepl_key_invalid');
                case 'openai_key_valid':
                    return t('validate_openai_key_valid').replace('{count}', p.count);
                case 'key_valid':
                    return t('validate_key_valid');
                case 'local_connected':
                    return t('validate_local_connected').replace('{count}', p.count);
                case 'local_connected_short':
                    return t('validate_local_connected_short');
                case 'libre_connected':
                    return t('validate_libre_connected').replace('{count}', p.count);
                case 'libre_connected_short':
                    return t('validate_libre_connected_short');
                case 'endpoint_not_configured':
                    return t('validate_endpoint_not_configured');
                case 'endpoint_reachable':
                    return t('validate_endpoint_reachable');
                case 'endpoint_responding':
                    return t('validate_endpoint_responding');
                case 'api_key_invalid':
                    return t('validate_api_key_invalid');
                case 'endpoint_not_found':
                    return t('validate_endpoint_not_found');
                case 'connection_refused':
                    return t('validate_connection_refused');
                case 'connection_timeout':
                    return t('validate_connection_timeout');
                case 'host_not_found':
                    return t('validate_host_not_found');
                case 'api_error':
                    return `Error ${p.status}: ${p.message}`;
                case 'engine_not_supported':
                    return t('validate_engine_not_supported').replace('{engine}', p.engine);
                default:
                    return p.message || code;
            }
        }

        async function validateApiKey() {
            const engine = document.getElementById('engine-select').value;
            const apiKey = document.getElementById('api-key').value.trim();
            const statusEl = document.getElementById('api-key-status');
            const inputEl = document.getElementById('api-key');
            const containerEl = document.getElementById('api-key-section');

            if (!apiKey) {
                setValidationStatus(statusEl, inputEl, containerEl, { valid: false, message: translate('validate_enter_api_key') || 'Ingresa una API Key primero' });
                return;
            }

            // Show loading state
            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>' + (translate('validate_validating') || 'Validando...') + '</span>';

            // v3.13.58 (Fase 3): for engine==='openai', also send which provider
            // is selected (and its custom base URL, if that's the one picked) so
            // "Validar" actually checks the provider the dropdown shows, not
            // always OpenAI's own API — see ipc-handlers.js's validate-api-key.
            const providerId = engine === 'openai' ? document.getElementById('llm-provider-select').value : '';
            const customBaseUrl = providerId === 'custom' ? document.getElementById('llm-custom-baseurl').value.trim() : '';
            const result = await api.validateApiKey(engine, apiKey, customBaseUrl, providerId);
            setValidationStatus(statusEl, inputEl, containerEl, result);
        }

        async function validateLocalEndpoint() {
            const endpoint = document.getElementById('local-endpoint').value.trim();
            const statusEl = document.getElementById('local-endpoint-status');
            const inputEl = document.getElementById('local-endpoint');

            if (!endpoint) {
                setValidationStatus(statusEl, inputEl, null, { valid: false, message: translate('validate_enter_endpoint') || 'Ingresa un endpoint primero' });
                return;
            }

            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>' + (translate('validate_validating') || 'Validando...') + '</span>';

            const result = await api.validateApiKey('local-llm', '', endpoint);
            setValidationStatus(statusEl, inputEl, null, result);
        }

        async function validateLibreTranslate() {
            const endpoint = document.getElementById('libretranslate-endpoint').value.trim();
            const statusEl = document.getElementById('libretranslate-status');
            const inputEl = document.getElementById('libretranslate-endpoint');

            if (!endpoint) {
                setValidationStatus(statusEl, inputEl, null, { valid: false, message: translate('validate_enter_endpoint') || 'Ingresa un endpoint primero' });
                return;
            }

            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>' + (translate('validate_validating') || 'Validando...') + '</span>';

            const result = await api.validateApiKey('libretranslate', '', endpoint);
            setValidationStatus(statusEl, inputEl, null, result);
        }

        async function validateCustomMT() {
            const endpoint = document.getElementById('custom-mt-endpoint').value.trim();
            const statusEl = document.getElementById('custom-mt-status');
            const inputEl = document.getElementById('custom-mt-endpoint');

            if (!endpoint) {
                setValidationStatus(statusEl, inputEl, null, { valid: false, message: translate('validate_enter_endpoint') || 'Ingresa un endpoint primero' });
                return;
            }

            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>' + (translate('validate_validating') || 'Validando...') + '</span>';

            const result = await api.validateApiKey('custom-mt', '', endpoint);
            setValidationStatus(statusEl, inputEl, null, result);
        }

        // v3.13.8x (settings UX audit): renamed from autoSaveEngine() — it
        // never saved the engine itself, only marked unsaved (v3.10.8). See
        // onLanguageChange()'s doc comment for the same fix on its sibling.
        function onEngineChange() {
            // Save the current API key to the previous engine before switching
            const prevEngine = document.getElementById('engine-select').dataset.prevEngine;
            const currentApiKey = document.getElementById('api-key').value;
            if (prevEngine === 'deepl' && currentApiKey) {
                engineApiKeys.deepl = currentApiKey;
            } else if (prevEngine === 'openai' && currentApiKey) {
                const providerId = document.getElementById('llm-provider-select').value;
                engineApiKeys.llm[providerId] = currentApiKey;
            }

            toggleInputFields(); // Still toggle visibility of engine-specific fields
            markUnsaved('sidebar');
        }

        // v3.11.23: Auto-save DeepL formality setting
        function autoSaveDeepLFormality() {
            const formality = document.getElementById('deepl-formality').value;
            api.saveSettings({ deeplFormality: formality });
        }

        // v3.11.29: Auto-save DeepL custom instructions
        function autoSaveDeepLCustomInstructions() {
            const rawText = document.getElementById('deepl-custom-instructions').value;
            const instructions = rawText.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .slice(0, 10)
                .map(line => line.substring(0, 300));
            api.saveSettings({ deeplCustomInstructions: instructions });
            updateDeepLInstructionsCount();
            updateDeepLInstructionsUI();
        }

        // v3.11.29: Reset custom instructions to defaults (clear the field)
        function resetDeepLInstructions() {
            document.getElementById('deepl-custom-instructions').value = '';
            api.saveSettings({ deeplCustomInstructions: [] });
            updateDeepLInstructionsCount();
            updateDeepLInstructionsUI();
            const t = translations[currentLang] || translations['en'];
            showToast(t.deepl_reset_instructions + ' ✓' || 'Reset ✓');
        }

        // v3.11.29: Update the instruction counter display
        function updateDeepLInstructionsCount() {
            const rawText = document.getElementById('deepl-custom-instructions').value;
            const count = rawText.split('\n').filter(line => line.trim().length > 0).length;
            const counter = document.getElementById('deepl-instructions-count');
            if (counter) {
                counter.textContent = `${Math.min(count, 10)}/10`;
                counter.classList.toggle('text-red-500', count > 10);
                counter.classList.toggle('text-gray-400', count <= 10);
            }
        }

        // v3.11.29: Update the default indicator and reset button visibility
        function updateDeepLInstructionsUI() {
            const rawText = document.getElementById('deepl-custom-instructions').value.trim();
            const hasContent = rawText.length > 0;
            const indicator = document.getElementById('deepl-default-instructions-indicator');
            const resetBtn = document.getElementById('deepl-reset-instructions-btn');
            if (indicator) {
                indicator.classList.toggle('hidden', hasContent);
            }
            if (resetBtn) {
                resetBtn.classList.toggle('hidden', !hasContent);
            }
        }

        // v3.11.29: Update the textarea placeholder based on current UI language
        function updateDeepLInstructionsPlaceholder() {
            const textarea = document.getElementById('deepl-custom-instructions');
            if (!textarea) return;
            const t = translations[currentLang] || translations['en'];
            textarea.placeholder = t.deepl_custom_instructions_ph || 'E.g.: Keep honorifics like -san, -chan unchanged\nUse casual language for dialogue\nPreserve character names';
        }

        // v3.11.28: Cache for DeepL language features from /v3/languages
        let deeplLanguageFeaturesCache = null;

        // v3.11.28: Fetch language features from DeepL API and update UI visibility
        async function fetchDeepLLanguageFeatures(apiKey, targetLang) {
            if (!apiKey || !targetLang) return;

            const targetLangLower = targetLang.toLowerCase();

            // Built-in fallback: known feature support per language
            const BUILTIN_FORMALITY = new Set(['de', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'ru']);
            const BUILTIN_STYLE_RULES = new Set(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'zh']);

            let formalitySupported = BUILTIN_FORMALITY.has(targetLangLower);
            let styleRulesSupported = BUILTIN_STYLE_RULES.has(targetLangLower);

            // Try fetching from /v3/languages API
            if (apiKey && apiKey.length > 5) {
                try {
                    const result = await api.deeplFetchFeatures(apiKey);
                    if (result.success && result.features) {
                        deeplLanguageFeaturesCache = result.features;
                        const langFeatures = result.features[targetLangLower];
                        if (langFeatures) {
                            formalitySupported = langFeatures.formality;
                            styleRulesSupported = langFeatures.style_rules;
                        }
                    }
                } catch (e) {
                    // Silently fall back to built-in data
                    console.log('[DeepL] Feature detection failed, using built-in data');
                }
            }

            // Update UI visibility based on feature support
            updateDeepLFeatureVisibility(formalitySupported, styleRulesSupported, targetLang);
        }

        // v3.11.29: Show/hide DeepL feature sections based on language support
        function updateDeepLFeatureVisibility(formalitySupported, styleRulesSupported, targetLang) {
            const engine = document.getElementById('engine-select')?.value;
            if (engine !== 'deepl') return;

            const t = translations[currentLang] || translations['en'];

            const formalitySec = document.getElementById('deepl-formality-section');
            const instructionsSec = document.getElementById('deepl-custom-instructions-section');
            const noticeSec = document.getElementById('deepl-feature-notice');
            const noticeText = document.getElementById('deepl-feature-notice-text');

            // Hide features that aren't supported by the target language
            if (formalitySec) {
                formalitySec.classList.toggle('hidden', !formalitySupported);
            }
            if (instructionsSec) {
                instructionsSec.classList.toggle('hidden', !styleRulesSupported);
            }

            // Show notice if some features are unavailable (v3.11.29: i18n)
            const unavailable = [];
            if (!formalitySupported) unavailable.push(t.deepl_feature_formality || 'Formality');
            if (!styleRulesSupported) unavailable.push(t.deepl_feature_custom_instructions || 'Custom Instructions');

            if (noticeSec && noticeText) {
                if (unavailable.length > 0) {
                    const template = t.deepl_feature_unavailable || 'Not available for {lang}: {features}';
                    noticeText.textContent = template
                        .replace('{lang}', targetLang.toUpperCase())
                        .replace('{features}', unavailable.join(', '));
                    noticeSec.classList.remove('hidden');
                } else {
                    noticeSec.classList.add('hidden');
                }
            }
        }

        function updateTargetLangDisplay(langCode) {
            const langNames = {
                'es': 'Español', 'en': 'English', 'ja': '日本語', 'zh': '中文',
                'ko': '한국어', 'ru': 'Русский', 'pt': 'Português', 'fr': 'Français',
                'de': 'Deutsch', 'it': 'Italiano', 'ar': 'العربية', 'th': 'ไทย',
                'vi': 'Tiếng Việt', 'id': 'Bahasa', 'tr': 'Türkçe', 'nl': 'Nederlands',
                'pl': 'Polski', 'uk': 'Українська', 'hi': 'हिन्दी'
            };
            const display = document.getElementById('display-target-lang');
            if (display) {
                display.innerText = langNames[langCode] || langCode;
            }
        }

        // ===== GLOSSARY =====
        async function loadGlossary() {
            try {
                const result = await api.getGlossary();
                glossaryEntries = result.global || [];
                profileGlossaryEntries = result.profile || [];
                // v3.13.55: entries whose pattern (regex, typically) failed to
                // compile — see glossary.js getCompileErrors(). Keyed by id so
                // renderGlossary() can look each row up in O(1).
                glossaryCompileErrorIds = new Set((result.compileErrors || []).map(e => e.id));
                // v3.13.8x (settings UX audit): re-apply staged-but-unsaved
                // adds/deletes on top of the fresh backend data. This
                // function runs every time the Glosario tab opens
                // (switchTab()), which no longer discards staged edits first
                // (see switchTab()'s doc comment) — without this, opening
                // the tab would silently wipe a staged glossary add/delete
                // that hasn't been saved yet, since the backend never heard
                // about it. A no-op once saveConfig()/applySettingsModal()
                // clear the staged arrays before calling this.
                for (const staged of stagedGlossaryAdds) {
                    const list = staged.scope === 'profile' ? profileGlossaryEntries : glossaryEntries;
                    if (!list.some(e => e.id === staged.id)) list.push({ ...staged });
                }
                for (const del of stagedGlossaryDeletes) {
                    if (del.scope === 'profile') {
                        profileGlossaryEntries = profileGlossaryEntries.filter(e => e.id !== del.id);
                    } else {
                        glossaryEntries = glossaryEntries.filter(e => e.id !== del.id);
                    }
                }
                renderGlossary();
            } catch (e) { console.error('Failed to load glossary:', e); }
        }

        // v3.13.40: which array the Glosario tab is currently showing/
        // editing. The list itself (not just its length) is what
        // addGlossaryEntry/deleteGlossaryEntry mutate, so this always
        // returns a live reference, not a copy.
        function currentGlossaryList() {
            return currentGlossaryScope === 'profile' ? profileGlossaryEntries : glossaryEntries;
        }

        function setGlossaryScope(scope) {
            currentGlossaryScope = scope;
            renderGlossary();
        }

        function updateGlossaryScopeButtons() {
            const activeCls = ['bg-white', 'dark:bg-dark-700', 'text-emerald-600', 'dark:text-emerald-400', 'shadow-sm'];
            const inactiveCls = ['text-gray-500', 'dark:text-gray-400'];
            const globalBtn = document.getElementById('glossary-scope-global');
            const profileBtn = document.getElementById('glossary-scope-profile');
            if (!globalBtn || !profileBtn) return;
            const [activeBtn, inactiveBtn] = currentGlossaryScope === 'profile' ? [profileBtn, globalBtn] : [globalBtn, profileBtn];
            inactiveBtn.classList.remove(...activeCls);
            inactiveBtn.classList.add(...inactiveCls);
            activeBtn.classList.remove(...inactiveCls);
            activeBtn.classList.add(...activeCls);
        }

        function renderGlossary() {
            updateGlossaryScopeButtons();
            const list = document.getElementById('glossary-list');
            const entries = currentGlossaryList();
            if (!entries.length) {
                const t = translations[currentLang] || translations['en'];
                list.innerHTML = `<p class="text-xs text-gray-400 text-center py-4">${t.glossary_empty}</p>`;
                return;
            }

            const t = translations[currentLang] || translations['en'];
            list.innerHTML = entries.map(entry => {
                // v3.13.55: an id with no compile error is the common case;
                // this only ever fires for a 'regex' entry with bad syntax.
                const isInvalid = glossaryCompileErrorIds.has(entry.id);
                const warningIcon = isInvalid ? `
                    <svg class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" title="${escapeHtml(t.glossary_invalid_pattern)}"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l6.518 11.59c.75 1.334-.213 2.987-1.743 2.987H3.482c-1.53 0-2.493-1.653-1.743-2.987l6.518-11.59zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                ` : '';
                return `
                <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-dark-900/50 border ${isInvalid ? 'border-amber-400 dark:border-amber-500' : 'border-gray-200 dark:border-dark-600'} text-xs">
                    ${warningIcon}
                    <div class="flex-1 min-w-0">
                        <span class="font-mono text-gray-700 dark:text-gray-200 truncate block">${escapeHtml(entry.source)}</span>
                        <span class="text-emerald-600 dark:text-emerald-400 truncate block">→ ${escapeHtml(entry.target)}</span>
                    </div>
                    <span class="text-[9px] text-gray-400 px-1 py-0.5 bg-gray-100 dark:bg-dark-700 rounded">${entry.mode}</span>
                    <button onclick="deleteGlossaryEntry('${entry.id}')" class="text-red-400 hover:text-red-500 transition p-1">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                    </button>
                </div>
            `;
            }).join('');
        }

        async function addGlossaryEntry() {
            const source = document.getElementById('glossary-source').value.trim();
            const target = document.getElementById('glossary-target').value.trim();
            const mode = document.getElementById('glossary-mode').value;
            if (!source || !target) return;
            const scope = currentGlossaryScope;

            // v3.10.10: Stage the entry — only persisted on "Aplicar y Guardar"
            const tempId = 'staged_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
            // Check if same entry already staged IN THIS SCOPE to prevent
            // duplicates — the same term can legitimately exist staged in
            // both layers at once (that's the whole point of two layers).
            const alreadyStaged = stagedGlossaryAdds.some(e => e.scope === scope && e.source === source && e.target === target && e.mode === mode);
            if (!alreadyStaged) {
                stagedGlossaryAdds.push({ id: tempId, source, target, mode, enabled: true, createdAt: Date.now(), scope });
                // Show in UI immediately (local render)
                currentGlossaryList().push({ id: tempId, source, target, mode, enabled: true, createdAt: Date.now() });
                renderGlossary();
            }
            document.getElementById('glossary-source').value = '';
            document.getElementById('glossary-target').value = '';
            markUnsaved('glossary');
        }

        async function deleteGlossaryEntry(id) {
            const scope = currentGlossaryScope;
            // v3.10.8: Stage the deletion — only persisted on "Aplicar y Guardar"
            // If it's a staged add, just remove from staged adds and local list
            const stagedIdx = stagedGlossaryAdds.findIndex(e => e.id === id && e.scope === scope);
            if (stagedIdx >= 0) {
                stagedGlossaryAdds.splice(stagedIdx, 1);
            } else {
                // It's a persisted entry — stage for deletion
                stagedGlossaryDeletes.push({ id, scope });
            }
            // Remove from local display immediately
            if (scope === 'profile') {
                profileGlossaryEntries = profileGlossaryEntries.filter(e => e.id !== id);
            } else {
                glossaryEntries = glossaryEntries.filter(e => e.id !== id);
            }
            renderGlossary();
            markUnsaved('glossary');
        }

        async function importGlossary() {
            const t = translations[currentLang] || translations['en'];
            // v3.13.40-fix (round 2): first fix replaced window.prompt()
            // (silently did nothing at all — not implemented by Electron's
            // renderer) with showTextPrompt(), asking the user to TYPE a
            // full file path. Real feedback: that reads as "type the
            // filename you want," not "type where the file already is,"
            // and typing a path by hand is worse UX than a real file
            // picker anyway — every other file-choosing flow in this app
            // already has one (see textractorBrowseCli). Native picker now.
            const browse = await api.browseOpenFile({ title: t.glossary_import });
            if (browse.canceled || !browse.path) return;
            const result = await api.importGlossary(browse.path, currentGlossaryScope);
            if (result.success) {
                loadGlossary();
                showToast((t.glossary_import_success || 'Imported {count} entries').replace('{count}', result.imported));
                return;
            }
            // v3.13.41: importEntries() now flags WHY nothing was imported
            // instead of silently returning imported:0 — real feedback
            // found that picking History's export JSON here used to import
            // 0 entries with no error at all (different shape: original/
            // translated, not source/target), reading as "nothing
            // happened." Give the specific reason when we have one.
            if (result.code === 'WRONG_CATEGORY_HISTORY') {
                showToast(t.glossary_import_wrong_category || 'That file is a history export, not a glossary — different category, can\'t be imported here.');
            } else if (result.code === 'NO_VALID_ENTRIES') {
                showToast(t.glossary_import_no_valid_entries || 'No valid glossary entries found in that file.');
            } else {
                showToast((t.glossary_import_failed || 'Import failed: ') + result.error);
            }
        }

        async function exportGlossary() {
            const t = translations[currentLang] || translations['en'];
            const defaultFileName = currentGlossaryScope === 'profile' ? 'tuhua-glosario-perfil.json' : 'tuhua-glosario-global.json';
            const browse = await api.browseSaveFile({ title: t.glossary_export, defaultFileName });
            if (browse.canceled || !browse.path) return;
            const result = await api.exportGlossary(browse.path, currentGlossaryScope);
            if (result.success) showToast((t.glossary_export_success || 'Exportadas {count} entradas').replace('{count}', result.exported));
        }

        // ===== VNDB IMPORT (profiles Phase 1, step 6) =====
        // v3.13.41: moved from a Glosario-tab button to a per-CARD action
        // in the Profiles tab (next to Duplicar/Renombrar) — real feedback
        // was that it belongs there since it always targets one specific
        // game's profile. `profileId` is now passed in explicitly from the
        // card that opened it, and is NOT necessarily the active profile —
        // the backend (vndb-import IPC) writes into that exact profile's
        // glossary layer regardless of which one is active. The modal
        // explains that up front (message + a per-target confirmation
        // line) so the user knows what to expect before importing —
        // there's no way to redirect the import to Global from this UI.
        // v3.13.87 (Fase D, D.2): {seedQuery, pendingGame, forceNewProfile}
        // — the encadenado from the picker's destination screen's option
        // (c) "Crear un perfil para este juego". `pendingGame` is the
        // process {pid, name, windowTitle, exePath} the picker resolved;
        // it rides along through the whole modal (cleared on close/back,
        // see below) so the eventual import — or the "[Crear sin VNDB]"
        // escape hatch — can call set-profile-game with it (D.3).
        async function openVndbImportModal(profileId, options = {}) {
            const t = translations[currentLang] || translations['en'];
            const targetProfile = profileList.find(p => p.id === profileId);
            if (!targetProfile) {
                showToast(t.vndb_no_active_profile || 'Profile not found.');
                return;
            }
            const profileName = displayProfileName(targetProfile, t);
            const { seedQuery = '', pendingGame = null, forceNewProfile = false } = options;

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
            overlay.innerHTML = `
                <div class="bg-white dark:bg-dark-800 rounded-lg p-4 w-[420px] max-h-[80vh] flex flex-col gap-3 shadow-xl border border-gray-200 dark:border-dark-600">
                    <div class="flex items-center justify-between">
                        <h3 class="text-sm font-bold text-gray-800 dark:text-gray-100">${escapeHtml(t.vndb_modal_title || 'Import from VNDB')}</h3>
                        <button data-action="close" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">&times;</button>
                    </div>
                    <p class="text-[10px] text-gray-500 dark:text-gray-400 leading-snug">${escapeHtml((t.vndb_modal_desc || '').replace('{profile}', profileName))}</p>
                    <div class="flex gap-2">
                        <input type="text" id="vndb-search-input" class="flex-1 p-2 rounded-md bg-gray-50 dark:bg-dark-900 border border-gray-300 dark:border-dark-600 text-xs" placeholder="${escapeHtml(t.vndb_search_placeholder || '')}">
                        <button data-action="search" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-md transition">${escapeHtml(t.vndb_search_button || 'Search')}</button>
                    </div>
                    ${pendingGame ? `<button data-action="create-without-vndb" class="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline text-left">${escapeHtml(t.vndb_create_without_vndb_btn || 'VNDB no tiene este juego — crear el perfil sin importar')}</button>` : ''}
                    <div id="vndb-results" class="flex-1 overflow-y-auto scrollbar-thin space-y-1.5 min-h-[80px]"></div>
                </div>`;
            document.body.appendChild(overlay);

            const closeModal = () => overlay.remove();
            overlay.querySelector('[data-action="close"]').onclick = closeModal;
            overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

            const input = overlay.querySelector('#vndb-search-input');
            const resultsEl = overlay.querySelector('#vndb-results');

            // v3.13.87 (Fase D, D.3 step 6): #game-pid was already filled
            // by the picker's row click (openGameProcessPicker) before
            // this modal ever opened — this just makes the launcher/
            // advisory pipeline react to it now that the game is actually
            // linked to a profile, same as _confirmGameLinkDestination
            // does for the picker's own options (a)/(b). No-op when this
            // modal was opened the normal way (no pendingGame).
            function _applyPendingGameEffects() {
                if (!pendingGame) return;
                const pidField = document.getElementById('game-pid');
                if (pidField) pidField.value = pendingGame.pid;
                const nameEl = document.getElementById('game-pid-selected-name');
                if (nameEl) {
                    nameEl.textContent = '🎮 ' + (pendingGame.name || '');
                    nameEl.classList.remove('hidden');
                }
                gameExePathHint = pendingGame.exePath || null;
                checkGamePidVsAttached();
                maybeAutoLaunchTextractor();
            }

            // v3.13.87 (Fase D, D.2): the escape hatch for games VNDB
            // doesn't catalog (indies, doujin) — same sequence as the
            // normal "save to a new profile" import path minus the VNDB
            // call itself: create + switch + link, no glossary.
            const createWithoutVndbBtn = overlay.querySelector('[data-action="create-without-vndb"]');
            if (createWithoutVndbBtn) {
                createWithoutVndbBtn.onclick = async () => {
                    if (!pendingGame) return;
                    resultsEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-3">${escapeHtml(t.vndb_creating_profile || 'Creating profile...')}</p>`;
                    const newName = _cleanDisplayTitle(pendingGame.windowTitle) || pendingGame.name || 'Game';
                    const createResult = await api.createProfile({ name: newName });
                    if (!createResult.success) {
                        showToast(createResult.error);
                        closeModal();
                        return;
                    }
                    const newProfileId = createResult.profile.id;
                    await loadProfile(newProfileId);
                    let linkResult;
                    try {
                        linkResult = await api.setProfileGame({ profileId: newProfileId, process: pendingGame });
                    } catch (e) {
                        linkResult = { success: false, error: e.message };
                    }
                    if (linkResult && linkResult.success && linkResult.game.engine) {
                        _lastEngineAdvice = { ...linkResult.game.engine, source: 'profile' };
                        renderEngineAdvice();
                    }
                    _applyPendingGameEffects();
                    await loadProfiles();
                    closeModal();
                };
            }

            // v3.13.41: cover thumbnail (VNDB's `image.url`, added in
            // vndb.js) next to each result — a bare title list made it
            // hard to tell same-named entries/regional re-releases apart.
            // Falls back to a placeholder glyph, and onerror hides a
            // thumbnail whose URL 404s rather than showing a broken-image
            // icon.
            function coverThumb(vn) {
                return vn.imageUrl
                    ? `<img src="${escapeHtml(vn.imageUrl)}" loading="lazy" class="w-8 h-10 object-cover rounded flex-shrink-0 bg-gray-200 dark:bg-dark-700" onerror="this.style.visibility='hidden'">`
                    : `<span class="w-8 h-10 rounded flex-shrink-0 bg-gray-200 dark:bg-dark-700 flex items-center justify-center text-sm">🎮</span>`;
            }

            function renderVndbResults(results) {
                if (!results.length) {
                    resultsEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-3">${escapeHtml(t.vndb_no_results || 'No results.')}</p>`;
                    return;
                }
                resultsEl.innerHTML = results.map((vn, idx) => `
                    <button data-vn-idx="${idx}" class="w-full flex items-center gap-2 text-left p-2 rounded-md bg-gray-50 dark:bg-dark-900/50 border border-gray-200 dark:border-dark-600 hover:border-emerald-400 dark:hover:border-emerald-500 transition text-xs">
                        ${coverThumb(vn)}
                        <span class="min-w-0">
                            <span class="font-medium text-gray-700 dark:text-gray-200 block truncate">${escapeHtml(vn.title)}</span>
                            ${vn.alttitle ? `<span class="text-[10px] text-gray-400 block truncate">${escapeHtml(vn.alttitle)}</span>` : ''}
                        </span>
                    </button>
                `).join('');
                resultsEl.querySelectorAll('[data-vn-idx]').forEach(btn => {
                    btn.onclick = () => renderVndbDetail(results[Number(btn.dataset.vnIdx)]);
                });
            }

            function renderVndbDetail(vn) {
                resultsEl.innerHTML = `
                    <div class="p-2.5 rounded-md bg-gray-50 dark:bg-dark-900/50 border border-gray-200 dark:border-dark-600 space-y-2">
                        <div class="flex items-center gap-2">
                            ${coverThumb(vn)}
                            <span class="font-medium text-gray-700 dark:text-gray-200 text-xs block truncate">${escapeHtml(vn.title)}</span>
                        </div>
                        <label class="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
                            <input type="checkbox" id="vndb-inc-title" checked class="rounded border-gray-300 dark:border-dark-600 text-emerald-600 focus:ring-emerald-500 w-3.5 h-3.5">
                            ${escapeHtml(t.vndb_include_title || 'Include title and aliases')}
                        </label>
                        <label class="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
                            <input type="checkbox" id="vndb-inc-characters" checked class="rounded border-gray-300 dark:border-dark-600 text-emerald-600 focus:ring-emerald-500 w-3.5 h-3.5">
                            ${escapeHtml(t.vndb_include_characters || 'Include characters')}
                        </label>
                        <label class="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400 pt-1 border-t border-gray-200 dark:border-dark-600">
                            <input type="checkbox" id="vndb-new-profile" ${forceNewProfile ? 'checked disabled' : ''} ${forceNewProfile ? `title="${escapeHtml(t.vndb_new_profile_locked_hint || 'No se puede destildar: veniste desde «Crear un perfil para este juego»')}"` : ''} class="rounded border-gray-300 dark:border-dark-600 text-emerald-600 focus:ring-emerald-500 w-3.5 h-3.5">
                            ${escapeHtml(t.vndb_new_profile_toggle || 'Save to a new profile')}
                        </label>
                        <div id="vndb-new-profile-wrap" class="${forceNewProfile ? '' : 'hidden'}">
                            <input type="text" id="vndb-new-profile-name" value="${escapeHtml(vn.title)}" class="w-full p-1.5 rounded-md bg-white dark:bg-dark-800 border border-gray-300 dark:border-dark-600 text-xs" placeholder="${escapeHtml(t.vndb_new_profile_name_placeholder || 'New profile name')}">
                        </div>
                        <p id="vndb-target-line" class="text-[9px] font-medium text-emerald-600 dark:text-emerald-400"></p>
                        <div class="flex gap-2 pt-1">
                            <button data-action="back" class="flex-1 py-1.5 text-[10px] font-medium text-gray-500 hover:text-gray-800 dark:hover:text-white border border-gray-200 dark:border-dark-600 rounded-md transition">${escapeHtml(t.vndb_back || 'Back')}</button>
                            <button data-action="import" class="flex-1 py-1.5 text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-md transition">${escapeHtml(t.vndb_import_button || 'Import into glossary')}</button>
                        </div>
                    </div>`;
                resultsEl.querySelector('[data-action="back"]').onclick = () => runSearch();

                // v3.13.43: "save to a new profile" — creates the profile
                // (pre-filled with the VN's title, editable), switches to
                // it, THEN imports into it. Only decided at click time
                // (checkbox), so the confirmation line and the eventual
                // vndb-import target both need to react to it live.
                const newProfileCheckbox = resultsEl.querySelector('#vndb-new-profile');
                const newProfileWrap = resultsEl.querySelector('#vndb-new-profile-wrap');
                const newProfileNameInput = resultsEl.querySelector('#vndb-new-profile-name');
                const targetLine = resultsEl.querySelector('#vndb-target-line');

                function updateTargetLine() {
                    let line;
                    if (newProfileCheckbox.checked) {
                        const name = newProfileNameInput.value.trim() || vn.title;
                        line = (t.vndb_import_target_new_profile || 'A new profile will be created and activated: {profile}').replace('{profile}', name);
                    } else {
                        line = (t.vndb_import_target || 'Will be imported into: {profile}').replace('{profile}', profileName);
                    }
                    // v3.13.87 (Fase D, D.2): chained from the picker —
                    // make the game link explicit too, not just the VNDB
                    // import destination.
                    if (pendingGame) {
                        line += ' ' + (t.vndb_target_with_game || '🎮 {game} quedará vinculado a este perfil.').replace('{game}', pendingGame.name || pendingGame.windowTitle || '');
                    }
                    targetLine.textContent = line;
                }
                newProfileCheckbox.onchange = () => {
                    newProfileWrap.classList.toggle('hidden', !newProfileCheckbox.checked);
                    if (newProfileCheckbox.checked) { newProfileNameInput.focus(); newProfileNameInput.select(); }
                    updateTargetLine();
                };
                newProfileNameInput.addEventListener('input', updateTargetLine);
                updateTargetLine();

                resultsEl.querySelector('[data-action="import"]').onclick = async () => {
                    const includeTitle = resultsEl.querySelector('#vndb-inc-title').checked;
                    const includeCharacters = resultsEl.querySelector('#vndb-inc-characters').checked;
                    let targetProfileId = profileId;

                    if (newProfileCheckbox.checked) {
                        const newName = newProfileNameInput.value.trim() || vn.title;
                        resultsEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-3">${escapeHtml(t.vndb_creating_profile || 'Creating profile...')}</p>`;
                        const createResult = await api.createProfile({ name: newName });
                        if (!createResult.success) {
                            showToast(createResult.error);
                            renderVndbDetail(vn); // back to the form so the name can be fixed and retried
                            return;
                        }
                        targetProfileId = createResult.profile.id;
                        // loadProfile() (defined in the Profiles section
                        // below) does the FULL client+server switch — same
                        // path a card click uses — so activeProfileId,
                        // settings panels, glossary/history all end up
                        // consistent, not just a local variable flip.
                        await loadProfile(targetProfileId);
                    }

                    // v3.13.87 (Fase D, D.3 step 3): BEFORE the VNDB import
                    // (network, can fail/rate-limit) — if it does, the
                    // profile still ends up linked to the game, the more
                    // valuable half. set-profile-game is local and can't
                    // fail on network grounds.
                    if (pendingGame) {
                        let linkResult;
                        try {
                            linkResult = await api.setProfileGame({ profileId: targetProfileId, process: pendingGame });
                        } catch (e) {
                            linkResult = { success: false, error: e.message };
                        }
                        if (linkResult && linkResult.success && linkResult.game.engine) {
                            _lastEngineAdvice = { ...linkResult.game.engine, source: 'profile' };
                            renderEngineAdvice();
                        }
                        // v3.13.87 (Fase D, D.3 step 6): fires regardless of
                        // whether the VNDB import below succeeds — the link
                        // itself just happened, Textractor should react to
                        // it either way.
                        _applyPendingGameEffects();
                    }

                    resultsEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-3">${escapeHtml(t.vndb_importing || 'Importing...')}</p>`;
                    try {
                        // coverUrl/vnTitle: the search result already carries
                        // VNDB's image.url — passed straight through so the
                        // main process can save it on the profile without a
                        // second VNDB fetch (see vndb-import in ipc-handlers.js).
                        const result = await api.vndbImport(vn.id, targetProfileId, {
                            includeTitle, includeCharacters,
                            coverUrl: vn.imageUrl || '', vnTitle: vn.title || ''
                        });
                        if (!result.success) {
                            showToast((t.vndb_import_error || 'Import error: {error}').replace('{error}', result.error || ''));
                            closeModal();
                            return;
                        }
                        showToast((t.vndb_import_success || 'Imported {imported} entries ({duplicates} were already there)')
                            .replace('{imported}', result.imported)
                            .replace('{duplicates}', result.duplicates));
                        closeModal();
                        // The Glosario tab only ever shows the ACTIVE
                        // profile's layer — only reload it if that's the
                        // profile we just imported into. Refresh the
                        // profile cards regardless, so the 📖 count badge
                        // updates even for a profile we didn't switch to.
                        if (targetProfileId === activeProfileId) {
                            currentGlossaryScope = 'profile';
                            await loadGlossary();
                        }
                        await loadProfiles();
                    } catch (e) {
                        showToast((t.vndb_import_error || 'Import error: {error}').replace('{error}', e.message));
                        closeModal();
                    }
                };
            }

            async function runSearch() {
                const query = input.value.trim();
                if (query.length < 2) {
                    resultsEl.innerHTML = '';
                    return;
                }
                resultsEl.innerHTML = `<p class="text-[10px] text-gray-400 text-center py-3">${escapeHtml(t.vndb_searching || 'Searching...')}</p>`;
                try {
                    const res = await api.vndbSearch(query);
                    if (!res.success) {
                        resultsEl.innerHTML = `<p class="text-[10px] text-red-500 text-center py-3">${escapeHtml((t.vndb_search_error || 'Search error: {error}').replace('{error}', res.error || ''))}</p>`;
                        return;
                    }
                    renderVndbResults(res.results || []);
                } catch (e) {
                    resultsEl.innerHTML = `<p class="text-[10px] text-red-500 text-center py-3">${escapeHtml((t.vndb_search_error || 'Search error: {error}').replace('{error}', e.message))}</p>`;
                }
            }

            let searchDebounce = null;
            overlay.querySelector('[data-action="search"]').onclick = () => { clearTimeout(searchDebounce); runSearch(); };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { clearTimeout(searchDebounce); runSearch(); }
                if (e.key === 'Escape') closeModal();
            });
            // v3.13.41: live suggestions as the user types, not just on
            // Enter/click — debounced (VNDB's anonymous rate limit is
            // ~1 req/s, see vndb.js) so we don't fire one request per
            // keystroke.
            input.addEventListener('input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(runSearch, 400);
            });
            // v3.13.87 (Fase D, D.2): seedQuery from the picker's
            // destination screen — pre-fill and search immediately instead
            // of leaving an empty box the user has to re-type the title
            // into.
            if (seedQuery) {
                input.value = seedQuery;
                runSearch();
            }
            input.focus();
        }

        // ===== HISTORY =====
        async function loadHistory() {
            try {
                historyEntries = await api.getHistory();
                renderHistory();
            } catch (e) { console.error('Failed to load history:', e); }
        }

        function renderHistory(filter = '') {
            const list = document.getElementById('history-list');
            const filtered = filter
                ? historyEntries.filter(e => e.original.includes(filter) || e.translated.includes(filter))
                : historyEntries;

            if (!filtered.length) {
                const t = translations[currentLang] || translations['en'];
                list.innerHTML = `<p class="text-xs text-gray-400 text-center py-8">${t.history_empty}</p>`;
                return;
            }

            list.innerHTML = filtered.slice(0, 100).map(entry => `
                <div class="p-2.5 rounded-lg bg-white dark:bg-dark-800 border border-gray-100 dark:border-dark-700 text-xs">
                    <div class="flex justify-between items-start mb-1">
                        <span class="text-gray-500 dark:text-gray-400 font-mono truncate flex-1 mr-2">${escapeHtml(entry.original)}</span>
                        <span class="text-[9px] text-gray-400">${entry.engine || ''}</span>
                    </div>
                    <p class="text-emerald-600 dark:text-emerald-400 font-medium">${escapeHtml(entry.translated)}</p>
                </div>
            `).join('');
        }

        function filterHistory(query) {
            renderHistory(query);
        }

        async function clearHistory() {
            await api.clearHistory();
            historyEntries = [];
            renderHistory();
        }

        async function clearContext() {
            await api.clearContext();
        }

        async function exportHistory() {
            // v3.13.40-fix (round 2): "type the full path" (showTextPrompt)
            // replaced by a real native save picker, same reasoning as
            // exportGlossary/importGlossary above.
            const t = translations[currentLang] || translations['en'];
            const browse = await api.browseSaveFile({ title: t.history_export, defaultFileName: 'tuhua-historial.json' });
            if (browse.canceled || !browse.path) return;
            const result = await api.exportHistory(browse.path);
            if (result.success) showToast((t.history_export_success || 'Exportadas {count} entradas').replace('{count}', result.count));
        }

        // v3.13.40-fix: window.prompt() is not implemented by Electron's
        // default renderer (window.alert()/confirm() ARE — they map to a
        // native dialog — but prompt() silently returns null with no
        // dialog shown at all). renameProfile/duplicateProfile used
        // prompt() and were consequently dead buttons in the real app —
        // found via Lyca's real Windows testing, not by running Electron
        // (can't, in this environment). This is a minimal in-page
        // replacement, Promise-based so call sites read the same as
        // `await prompt(...)` would have.
        function showTextPrompt(message, defaultValue = '') {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
                overlay.innerHTML = `
                    <div class="bg-white dark:bg-dark-800 rounded-lg p-4 w-80 space-y-3 shadow-xl border border-gray-200 dark:border-dark-600">
                        <p class="text-xs font-medium text-gray-700 dark:text-gray-200">${escapeHtml(message)}</p>
                        <input type="text" class="w-full p-2 rounded-md bg-gray-50 dark:bg-dark-900 border border-gray-300 dark:border-dark-600 text-xs" />
                        <div class="flex justify-end gap-2">
                            <button data-action="cancel" class="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-dark-700 rounded-md transition">Cancelar</button>
                            <button data-action="ok" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-md transition">OK</button>
                        </div>
                    </div>`;
                const input = overlay.querySelector('input');
                input.value = defaultValue;
                const cleanup = (value) => { overlay.remove(); resolve(value); };
                overlay.querySelector('[data-action="cancel"]').onclick = () => cleanup(null);
                overlay.querySelector('[data-action="ok"]').onclick = () => cleanup(input.value);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') cleanup(input.value);
                    if (e.key === 'Escape') cleanup(null);
                });
                document.body.appendChild(overlay);
                input.focus();
                input.select();
            });
        }

        // v3.13.40-fix (round 2): the first fix for the confirm() focus
        // bug routed confirmations through a NATIVE OS dialog
        // (dialog.showMessageBox via IPC) — that fixed the focus loss but
        // introduced a different problem: a native Windows dialog cannot
        // be restyled at all, so it showed up as a plain system box with
        // "tuhua-translator |" in the title, nothing like the rest of the
        // app. An in-page modal (same family as showTextPrompt above)
        // solves both at once — it never touches the native blocking
        // dialog APIs in the first place, so the focus bug never applied
        // to it, and it's just HTML/CSS so it matches Tuhua's theme.
        // Default focus is the Cancel button, matching the native
        // dialog's old defaultId:0 — Enter shouldn't confirm a
        // destructive action by accident.
        function showConfirm(message, confirmLabel = 'Confirm', cancelLabel = 'Cancel') {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
                overlay.innerHTML = `
                    <div class="bg-white dark:bg-dark-800 rounded-lg p-4 w-80 space-y-3 shadow-xl border border-gray-200 dark:border-dark-600">
                        <p class="text-xs font-medium text-gray-700 dark:text-gray-200">${escapeHtml(message)}</p>
                        <div class="flex justify-end gap-2">
                            <button data-action="cancel" class="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-dark-700 rounded-md transition">${escapeHtml(cancelLabel)}</button>
                            <button data-action="ok" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white font-bold rounded-md transition">${escapeHtml(confirmLabel)}</button>
                        </div>
                    </div>`;
                const cancelBtn = overlay.querySelector('[data-action="cancel"]');
                const okBtn = overlay.querySelector('[data-action="ok"]');
                const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };
                const cleanup = (value) => {
                    document.removeEventListener('keydown', onKeydown);
                    overlay.remove();
                    resolve(value);
                };
                cancelBtn.onclick = () => cleanup(false);
                okBtn.onclick = () => cleanup(true);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
                document.addEventListener('keydown', onKeydown);
                document.body.appendChild(overlay);
                cancelBtn.focus();
            });
        }

        // ===== PROFILES =====
        // v3.13.40: keyed by id, not name (id is what makes rename
        // possible — name used to BE the primary key). Create/rename/
        // duplicate/delete are immediate IPC calls, not staged — see the
        // comment above stagedGlossaryAdds for why staging created the
        // silent-clone-on-create surprise in the first place.
        let activeProfileId = null;

        async function loadProfiles() {
            try {
                const result = await api.getProfiles();
                profileList = result.profiles || [];
                activeProfileId = result.activeProfileId || null;
                renderProfiles();
                // v3.13.85 (Fase B): profile.game only ever changes via a
                // call that already awaits loadProfiles() afterward (see
                // set-profile-game's renderer call sites) — repainting here
                // instead of at each call site keeps this section always
                // in sync without duplicating the paint logic.
                renderGameStatus();
            } catch (e) { console.error('Failed to load profiles:', e); }
        }

        // v3.13.40-fix: "Por Defecto" was a literal Spanish string baked
        // into every profile's stored `name` (pre-dates this refactor —
        // profile-store.js still seeds it that way, since `name` is now
        // pure display data with no structural role). Shown localized
        // UNLESS the user has explicitly renamed it — renaming away from
        // the literal seed value is treated as an explicit choice to keep.
        function displayProfileName(profile, t) {
            if (profile.isDefault && profile.name === 'Por Defecto') {
                return t.profile_default_name || 'Por Defecto';
            }
            return profile.name;
        }

        function renderProfiles() {
            const list = document.getElementById('profile-list');
            const t = translations[currentLang] || translations['en'];

            if (!profileList.length) {
                list.innerHTML = `<p class="text-xs text-gray-400 text-center py-4">${t.profile_empty}</p>`;
                updateActiveProfileIndicator();
                return;
            }

            list.innerHTML = profileList.map(profile => {
                const glossaryCount = profile.glossary ? profile.glossary.length : 0;
                const historyCount = profile.history ? profile.history.length : 0;
                const savedDate = profile.savedAt ? new Date(profile.savedAt).toLocaleDateString() : '';
                const engineName = profile.engine || 'google-free';
                // v3.13.40: targetLang is global now (the reader's own
                // language, not the game's) — only sourceLang is still
                // profile-scoped, so the badge shows one language, not a pair.
                const sourceLang = profile.sourceLang || 'auto';
                const inputMethod = profile.inputMethod || 'textractor';
                const isActive = profile.id === activeProfileId;
                const isDefault = profile.isDefault === true;
                const borderClass = isActive ? 'border-emerald-400 dark:border-emerald-600' : 'border-gray-200 dark:border-dark-600';
                const bgClass = isActive ? 'bg-emerald-50 dark:bg-emerald-900/10' : 'bg-gray-50 dark:bg-dark-900/50';
                const id = escapeHtml(profile.id);
                const displayName = escapeHtml(displayProfileName(profile, t));
                // v3.13.41: cover thumbnail, set on a successful VNDB
                // import (see openVndbImportModal / vndb-import) — lets a
                // profile be recognized by its game at a glance instead of
                // just its (often generic) name.
                const coverUrl = profile.cover && profile.cover.url ? profile.cover.url : null;
                // v3.13.85 (auto-configuración de juegos): the linked game,
                // if any — shown here too, not just in the settings panel's
                // #game-section, since this is where a user actually
                // compares profiles at a glance.
                const gameLabel = profile.game ? (profile.game.windowTitle || profile.game.exeName || '') : '';

                // v3.13.40-fix: clicking anywhere on a non-active card now
                // switches to it (feedback: depending on a small "Cargar"
                // button felt unnecessary). The button row below stops the
                // click from bubbling up (event.stopPropagation()) so
                // Duplicar/Renombrar/Eliminar don't ALSO trigger a switch.
                const cardOnClick = !isActive ? ` onclick="loadProfile('${id}')"` : '';
                const cardCursor = !isActive ? 'cursor-pointer hover:border-emerald-300 dark:hover:border-emerald-700' : '';

                // v3.13.42: back to 3 stacked lines (name / buttons /
                // properties) — real feedback was that name+buttons sharing
                // one row made the name unreadable once VNDB joined
                // Duplicar/Renombrar/Eliminar on that row. Cover grew from
                // a 10×14 strip to a 16×16 square to visually match the
                // taller 3-line stack next to it.
                return `
                <div class="p-2.5 rounded-lg ${bgClass} border ${borderClass} ${cardCursor} transition flex gap-2 items-start"${cardOnClick}>
                    ${coverUrl ? `<img src="${escapeHtml(coverUrl)}" loading="lazy" class="w-16 h-16 object-cover rounded flex-shrink-0 bg-gray-200 dark:bg-dark-700" title="${escapeHtml(profile.cover.vnTitle || '')}" onerror="this.style.display='none'">` : ''}
                    <div class="flex-1 min-w-0 space-y-1">
                        <div class="flex items-center gap-1.5 min-w-0">
                            ${isActive ? '<span class="w-2 h-2 rounded-full bg-emerald-500 pulse-dot flex-shrink-0"></span>' : ''}
                            <span class="text-sm font-medium truncate ${isActive ? 'text-emerald-700 dark:text-emerald-300' : ''}" title="${displayName}">${displayName}</span>
                            ${isDefault ? `<span class="text-[8px] bg-gray-200 dark:bg-dark-600 text-gray-500 dark:text-gray-400 px-1 py-0.5 rounded font-bold uppercase flex-shrink-0">${escapeHtml(t.profile_default_name || 'Default')}</span>` : ''}
                        </div>
                        <div class="flex flex-wrap gap-1" onclick="event.stopPropagation()">
                            ${!profile.game ? `<button onclick="openGameProcessPicker({targetProfileId:'${id}'})" class="px-2 py-1 text-[10px] font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded transition" data-i18n="game_link_from_card_btn">🎮 Vincular juego</button>` : ''}
                            <button onclick="openVndbImportModal('${id}')" class="px-2 py-1 text-[10px] font-medium text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded transition" data-i18n="glossary_vndb_import">Importar de VNDB</button>
                            <button onclick="duplicateProfile('${id}')" class="px-2 py-1 text-[10px] font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition" data-i18n="profile_duplicate">Duplicar</button>
                            <button onclick="renameProfile('${id}')" class="px-2 py-1 text-[10px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-dark-700 rounded transition" data-i18n="profile_rename">Renombrar</button>
                            ${!isDefault ? `<button onclick="deleteProfile('${id}')" class="px-2 py-1 text-[10px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition" data-i18n="profile_delete">Eliminar</button>` : ''}
                        </div>
                        <div class="flex flex-wrap items-center gap-1.5 text-[9px] text-gray-400">
                            ${gameLabel ? `<span class="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded truncate max-w-[140px]" title="${escapeHtml(profile.game.exePath || '')}">🎮 ${escapeHtml(gameLabel)}</span>` : ''}
                            ${glossaryCount > 0 ? `<span class="bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 px-1.5 py-0.5 rounded">📖 ${glossaryCount}</span>` : ''}
                            ${historyCount > 0 ? `<span class="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-1.5 py-0.5 rounded">📋 ${historyCount}</span>` : ''}
                            <span class="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">${sourceLang}</span>
                            <span class="bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">${engineName}</span>
                            <span class="bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">${inputMethod}</span>
                            ${savedDate ? `<span>${savedDate}</span>` : ''}
                        </div>
                    </div>
                </div>`;
            }).join('');

            updateActiveProfileIndicator();
        }

        function updateActiveProfileIndicator() {
            const indicator = document.getElementById('active-profile-indicator');
            if (indicator) {
                const t = translations[currentLang] || translations['en'];
                const active = profileList.find(p => p.id === activeProfileId);
                indicator.textContent = active ? displayProfileName(active, t) : '';
            }
        }

        async function saveProfile() {
            // v3.10.10: This function is no longer used as a standalone action.
            // Profile saving is now handled by "Aplicar y Guardar" (saveConfig).
            // Kept for reference but redirects to saveConfig.
            await saveConfig();
        }

        // v3.13.40-fix: replaces the toast for profile-name validation —
        // feedback requested it live next to the field it's about
        // (a toast at the bottom of the screen was too far from where the
        // user was actually looking/typing), plus a red outline on the
        // input itself until the user edits it again.
        function showProfileNameError(message) {
            const nameInput = document.getElementById('profile-name');
            const errorEl = document.getElementById('profile-name-error');
            nameInput.classList.add('border-red-500', 'dark:border-red-500');
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
            nameInput.focus();
        }

        function clearProfileNameError() {
            const nameInput = document.getElementById('profile-name');
            const errorEl = document.getElementById('profile-name-error');
            nameInput.classList.remove('border-red-500', 'dark:border-red-500');
            errorEl.classList.add('hidden');
        }

        async function createNewProfile() {
            const nameInput = document.getElementById('profile-name');
            const name = nameInput.value.trim();
            const t = translations[currentLang] || translations['en'];
            if (!name) {
                // v3.13.40-fix: traced with real user testing (DevTools
                // console showed "name read from input: ''") — clicking
                // with an empty field silently no-op'd with zero feedback,
                // reading as "the button doesn't work" when it was
                // actually working exactly as coded, just mute about it.
                showProfileNameError(t.profile_name_required || 'Escribí un nombre primero');
                return;
            }

            try {
                // v3.13.40: immediate — and no cloneFromId, so the new
                // profile is genuinely blank. Use "Duplicar" on an
                // existing card to clone one explicitly.
                const result = await api.createProfile({ name });
                if (!result.success) {
                    if (result.error === 'Profile name already exists') {
                        showProfileNameError(t.profile_name_exists || 'Ya existe un perfil con ese nombre');
                    } else {
                        showToast(result.error);
                    }
                    return;
                }
                nameInput.value = '';
                // v3.13.80: switch to the new profile immediately — creating
                // one and staying on the old one felt unnatural, and was the
                // exact setup for the deeplCustomInstructions scoping bug
                // (typing into a field that's still bound to the profile you
                // never left). loadProfile() switches + re-hydrates the
                // settings panel; loadProfiles() after it refreshes the card
                // list so the new card shows as active (loadProfile() alone
                // doesn't re-render the cards).
                await loadProfile(result.profile.id);
                await loadProfiles();
            } catch (e) {
                // v3.13.40-fix: was silently swallowing exceptions before —
                // a rejected api.* call (or a preload validation throw)
                // looked identical to "the button does nothing" from the
                // user's side. Log + toast so a real failure is visible
                // instead of indistinguishable from a UI wiring bug.
                console.error('createNewProfile failed:', e);
                showToast(e.message || String(e));
            }
        }

        // v3.10.10: saveCurrentProfile removed — "Guardar Actual" button removed.
        // All saving is now done via "Aplicar y Guardar" (saveConfig).

        async function loadProfile(id) {
            try {
                const result = await api.loadProfile(id);
                if (result.success) {
                    activeProfileId = result.activeProfileId || id;
                    // v3.10.8: Clear staged changes when switching profiles
                    // (init() re-reads from backend, so staged changes are discarded)
                    stagedGlossaryAdds = [];
                    stagedGlossaryDeletes = [];
                    // v3.13.8x: profile switch discards pending edits on
                    // BOTH surfaces (init() below re-hydrates every field
                    // from the newly-active profile), not just one.
                    markSaved('sidebar');
                    markSaved('modal');
                    // Re-apply settings to UI and refresh all tabs
                    await init();
                    loadGlossary();
                    loadHistory();
                }
            } catch (e) {
                console.error('loadProfile failed:', e);
                showToast(e.message || String(e));
            }
        }

        async function renameProfile(id) {
            const profile = profileList.find(p => p.id === id);
            if (!profile) return;
            const t = translations[currentLang] || translations['en'];
            try {
                // v3.13.40-fix: window.prompt() replaced with showTextPrompt()
                // (see its doc comment above the Profiles section) — this is
                // why Renombrar/Duplicar did nothing before: prompt() isn't
                // implemented by Electron's default renderer, so it returned
                // null instantly with no dialog ever appearing.
                const newName = await showTextPrompt(t.profile_rename_prompt || 'Nuevo nombre:', profile.name);
                if (!newName || !newName.trim() || newName.trim() === profile.name) return;
                const result = await api.renameProfile(id, newName.trim());
                if (!result.success) {
                    showToast(result.error);
                    return;
                }
                await loadProfiles();
            } catch (e) {
                console.error('renameProfile failed:', e);
                showToast(e.message || String(e));
            }
        }

        async function duplicateProfile(id) {
            const profile = profileList.find(p => p.id === id);
            if (!profile) return;
            const t = translations[currentLang] || translations['en'];
            try {
                const newName = await showTextPrompt(t.profile_duplicate_prompt || 'Nombre para la copia:', `${profile.name} (2)`);
                if (!newName || !newName.trim()) return;
                const result = await api.duplicateProfile(id, newName.trim());
                if (!result.success) {
                    showToast(result.error);
                    return;
                }
                await loadProfiles();
            } catch (e) {
                console.error('duplicateProfile failed:', e);
                showToast(e.message || String(e));
            }
        }

        async function deleteProfile(id) {
            const profile = profileList.find(p => p.id === id);
            if (!profile) return;
            const t = translations[currentLang] || translations['en'];
            if (profile.isDefault) {
                showToast(t.cannot_delete_default || 'No se puede eliminar el perfil por defecto');
                return;
            }
            // v3.13.40-fix: confirmation requested after real testing.
            // Round 1 used window.confirm() — real testing found it left
            // the renderer's keyboard focus broken afterward (typing
            // stopped responding anywhere until the window lost and
            // regained OS focus), a known Electron quirk with the
            // renderer-blocking confirm()/alert() dialogs. Round 2 routed
            // it through a native OS dialog instead, which fixed the focus
            // bug but couldn't be restyled at all (showed up as a plain
            // Windows message box, nothing like the rest of the app).
            // showConfirm() (in-page modal, see its own doc comment) is
            // round 3 — fixes both at once.
            const message = (t.profile_delete_confirm || 'Delete profile "{name}"? This cannot be undone.').replace('{name}', profile.name);
            const confirmed = await showConfirm(message, t.profile_delete || 'Eliminar', t.dialog_cancel || 'Cancelar');
            if (!confirmed) return;
            try {
                const result = await api.deleteProfile(id);
                if (!result.success) {
                    showToast(result.error);
                    return;
                }
                await loadProfiles();
            } catch (e) {
                console.error('deleteProfile failed:', e);
                showToast(e.message || String(e));
            }
        }

        // ===== GUIDE MODAL =====
        function toggleGuide(show) {
            const modal = document.getElementById('guide-modal');
            if (show) {
                modal.classList.remove('hidden');
                setTimeout(() => modal.style.opacity = '1', 10);
            } else {
                modal.style.opacity = '0';
                setTimeout(() => modal.classList.add('hidden'), 200);
            }
        }

        // ===== GATHER CONFIG =====
        // v3.13.8x (settings UX audit): no longer reads the "Overlay" or
        // "Traducción" categories' fields — those live physically in the
        // gear modal, and applySettingsModal() is their one gather now
        // (Overlay went further and became Tier A/immediate, see
        // saveOverlayImmediate()). Both used to ALSO be read here, so the
        // sidebar's Save button silently re-sent values for fields it
        // doesn't even display — harmless (same current value either way,
        // save-settings merges rather than replaces) but exactly the
        // double-coverage scripts/test-settings-tier-invariant.js exists to
        // catch. Confirmed by that bank, not just this comment.
        function gatherConfig() {
            return {
                engine: document.getElementById('engine-select').value,
                apiKey: document.getElementById('api-key').value,
                sourceLang: document.getElementById('source-lang').value,
                targetLang: document.getElementById('target-lang').value,
                localEndpoint: document.getElementById('local-endpoint').value,
                localModel: document.getElementById('local-model').value,
                // v3.13.58 (LLM engine overhaul, Fase 3)
                llmProvider: document.getElementById('llm-provider-select').value,
                llmModel: document.getElementById('llm-model').value,
                llmCustomBaseUrl: document.getElementById('llm-custom-baseurl').value,
                localLlmEndpointPreset: document.getElementById('local-endpoint-preset').value,
                // v3.13.38: textractorPort deliberately OMITTED — the input
                // and the Advanced Settings section it lived in were removed.
                // save-settings merges ({...currentSettings, ...data}) and
                // gates the TCP reconnect on `if (data.textractorPort)`, so
                // leaving the key out preserves whatever port is already
                // stored (Lyca's install runs on 6677, not the 9251 default —
                // sending a hardcoded default here would have silently
                // overwritten it on the next Save).
                textractorCliPath: document.getElementById('textractor-cli-path').value.trim(),
                // v3.13.8x (settings UX audit): manualTextractorMode
                // deliberately OMITTED — Tier A now (data-immediate,
                // toggleManualMode() saves itself), same reasoning as
                // clickThrough/xuatPort below.
                // gamePid deliberately OMITTED
                // — same reasoning as textractorPort just above, but for a
                // different symptom. It used to be persisted purely so
                // init() could re-fill this same input on the next launch,
                // but a PID from a past session is never valid for a new
                // one; sending it here just kept a dead value alive in
                // config.json for no purpose. The launch path already reads
                // the live DOM value directly (see doLaunchTextractor()).
                inputMethod: currentInputMethod,
                // debounceMs/promptTemplate/llmFewShot/maxContextHistory/
                // historyLimit deliberately OMITTED — see this function's
                // header comment; applySettingsModal() is their one owner.
                libretranslateEndpoint: document.getElementById('libretranslate-endpoint').value,
                customMTEndpoint: document.getElementById('custom-mt-endpoint').value,
                customMTMethod: document.getElementById('custom-mt-method').value,
                customMTBody: document.getElementById('custom-mt-body').value,
                customMTResponsePath: document.getElementById('custom-mt-response').value,
                customMTAuthHeader: document.getElementById('custom-mt-auth').value,
                uiLanguage: currentLang
                // v3.13.8x (settings UX audit): clickThrough and xuatPort
                // deliberately OMITTED here now — clickThrough is Tier A
                // (toggleClickThrough() saves itself immediately); xuatPort
                // moved to the gear modal's Avanzado category and is
                // gathered by applySettingsModal() instead. Neither belongs
                // in two places at once. See markUnsaved()'s doc comment.
            };
        }

        // ===== SAVE =====
        async function saveConfig() {
            const config = gatherConfig();
            // Map fields for backend compatibility
            if (config.engine === 'deepl') config.deeplKey = config.apiKey;
            if (config.engine === 'openai') {
                // v3.13.58: keyed by provider now, not a flat openaiKey/openaiModel
                // (the latter was dead — always hardcoded to 'gpt-3.5-turbo' here,
                // never read from a real field). engineApiKeys.llm was kept in sync
                // by every provider swap (onLlmProviderChange/toggleInputFields), so
                // it already holds this provider's key from the field above merged
                // with whatever other providers' keys were loaded/typed this session.
                engineApiKeys.llm[config.llmProvider] = config.apiKey;
                config.llmProviderKeys = { ...engineApiKeys.llm };
            }
            if (['local-llm'].includes(config.engine)) { config.customEndpoint = config.localEndpoint; config.customModel = config.localModel; }
            // apiKey/localEndpoint/localModel only exist as gatherConfig()'s DOM
            // read shape — the fields actually persisted are deeplKey/
            // llmProviderKeys/customEndpoint/customModel above. Sending the raw
            // ones too would round-trip harmlessly (unused elsewhere) but keeping
            // them off the wire makes what's actually read unambiguous.
            delete config.apiKey;
            delete config.localEndpoint;
            delete config.localModel;

            // 1. Save all settings
            await api.saveSettings(config);

            // 2. Apply staged glossary changes (each staged record carries
            // its own scope — v3.13.40, two-layer glossary)
            for (const entry of stagedGlossaryAdds) {
                await api.saveGlossaryEntry({ source: entry.source, target: entry.target, mode: entry.mode }, entry.scope);
            }
            for (const item of stagedGlossaryDeletes) {
                await api.deleteGlossaryEntry(item.id, item.scope);
            }
            stagedGlossaryAdds = [];
            stagedGlossaryDeletes = [];

            // 3. Save current profile data (updates glossary count, history, etc.)
            // v3.13.40: profile create/rename/duplicate/delete are immediate
            // IPC calls now (see the Profiles section) — nothing staged to
            // flush here anymore.
            if (activeProfileId) await api.saveProfile(activeProfileId);
            loadProfiles();

            // 4. Reload glossary from store to sync IDs
            await loadGlossary();

            // 5. Mark as saved (remove visual indicator)
            markSaved('sidebar');

            // v3.13.37: Save is a "real trigger" for Textractor auto-launch —
            // covers both a fresh path/PID entry and retrying after a Kill
            // (see maybeAutoLaunchTextractor's doc for why Kill itself
            // doesn't auto-retry).
            maybeAutoLaunchTextractor();

            // v3.13.85 (Fase B, disparador 3): the user just asked Tuhua to
            // start working — the moment a background scan's answer is
            // actually worth acting on.
            scanForKnownGames(false);

            // Update cached settings
            window._lastSettings = await api.getSettings();

            flashSaved('save-btn-text', 'save-btn-check');
        }

        // ===== TRANSLATION TOGGLE =====
        function toggleTranslationActive() {
            translationActive = !translationActive;

            // v3.11.2: XUAT mode — play/pause controls the XUAT server, not the overlay
            // XUAT translations appear directly in the game, no overlay needed
            if (currentInputMethod === 'xuat') {
                if (translationActive) {
                    // Start XUAT server
                    const port = parseInt(document.getElementById('xuat-port').value) || 8419;
                    api.xuatStartServer(port).then(result => {
                        if (!result.success) {
                            // Failed to start — revert toggle state
                            translationActive = false;
                            updateToggleUI();
                            showToast('Error al iniciar servidor XUAT: ' + (result.error || 'Desconocido'));
                        } else {
                            updateXuatStatus();
                        }
                    }).catch(err => {
                        translationActive = false;
                        updateToggleUI();
                        showToast('Error: ' + err.message);
                    });
                } else {
                    // Stop XUAT server
                    api.xuatStopServer().then(result => {
                        updateXuatStatus();
                    }).catch(err => {
                        console.error('[XUAT] Stop error:', err);
                    });
                }
                api.saveSettings({ translationActive: translationActive });
                updateToggleUI();
                return;
            }

            api.saveSettings({ translationActive: translationActive });
            updateToggleUI();

            // v3.11.22: When clipboard is paused, show disconnected status
            // instead of "watching" to make it clear clipboard is no longer
            // being monitored — v3.13.39: now via recomputeBadge(), which
            // derives the same watching/disconnected split from
            // translationActive (see deriveBadgeStatus).
            recomputeBadge();

            // When OCR is the input method, start/stop OCR session with the main toggle
            if (currentInputMethod === 'ocr') {
                if (translationActive) {
                    startOcrSession();
                } else {
                    stopOcrSession();
                }
            }

            // v3.13.37: resuming (play) is a "real trigger" for Textractor
            // auto-launch, same as Save — see maybeAutoLaunchTextractor's
            // doc. Pausing deliberately does NOT kill the CLI: Kill remains
            // the only manual stop control.
            if (currentInputMethod === 'textractor' && translationActive) {
                maybeAutoLaunchTextractor();
            }

            // v3.13.85 (Fase B, disparador 4): resuming is exactly when a
            // resolved PID/engine advisory becomes actionable — not gated
            // to Textractor, since the engine advisory and PID pre-fill
            // are useful in OCR/XUAT too (maybeAutoLaunchTextractor above
            // already no-ops outside Textractor mode on its own).
            if (translationActive) {
                scanForKnownGames(false);
            }
        }

        function updateToggleUI() {
            const btn = document.getElementById('translation-toggle-btn');
            const pauseIcon = document.getElementById('toggle-icon-pause');
            const playIcon = document.getElementById('toggle-icon-play');
            const statusText = document.getElementById('toggle-status-text');
            const t = translations[currentLang] || translations['en'];

            if (translationActive) {
                // Active state: green pulsing, pause icon, "Active"
                btn.classList.remove('toggle-btn-paused');
                btn.classList.add('toggle-btn-active', 'toggle-pulse-ring');
                pauseIcon.classList.remove('hidden');
                playIcon.classList.add('hidden');
                statusText.innerText = t.status_active || 'Active';
            } else {
                // Paused state: gray, play icon, "Paused"
                btn.classList.remove('toggle-btn-active', 'toggle-pulse-ring');
                btn.classList.add('toggle-btn-paused');
                pauseIcon.classList.add('hidden');
                playIcon.classList.remove('hidden');
                statusText.innerText = t.status_paused || 'Paused';
            }
        }

        // ===== TExtractorCLI FUNCTIONS =====
        let cliRunning = false;
        // v3.13.32: the amber "x64 sin resultado, probando x86..." text set
        // by onTextractorCliArchFallback below, re-shown by the
        // 'relaunching' case in updateCliStatus() so it survives the
        // status transitions the handover produces (see that function's
        // doc for why 'relaunching' exists at all).
        let cliArchFallbackNotice = '';
        // v3.13.32: latched by the 'error' case, cleared by 'launched' and
        // by a fresh manual Launch — see updateCliStatus()'s 'exited'/
        // 'killed' case for the bug this guards (the error panel used to
        // auto-hide itself 2s after ANY stop, even one carrying a terminal
        // error the user hadn't had a chance to read).
        let cliHasTerminalError = false;
        // v3.13.32: handle for the 2s auto-hide timer scheduled by
        // 'exited'/'killed' below, so a status that arrives before it
        // fires (an error, or the relaunch's own 'launched') can cancel it
        // instead of it unconditionally hiding the bar/error panel later.
        let cliStatusHideTimer = null;

        // v3.13.37: live countdown for the up-to-ARCH_FALLBACK_CHECK_MAX_MS
        // (60s) hook-discovery window, driven by the backend's
        // 'search-started' event. Purely a local 1s ticker — the backend
        // already told us the total duration, no need to poll it further.
        let _searchCountdownInterval = null;
        let _searchCountdownDeadline = 0;
        let _searchCountdownArch = null;

        function startSearchCountdown(arch, durationMs) {
            stopSearchCountdown();
            _searchCountdownArch = arch;
            _searchCountdownDeadline = Date.now() + durationMs;
            const el = document.getElementById('cli-search-status');
            if (!el) return;
            el.classList.remove('hidden');
            updateSearchCountdownUI();
            _searchCountdownInterval = setInterval(updateSearchCountdownUI, 1000);
        }

        function updateSearchCountdownUI() {
            const el = document.getElementById('cli-search-status');
            if (!el) return;
            const secondsLeft = Math.max(0, Math.round((_searchCountdownDeadline - Date.now()) / 1000));
            const t = translations[currentLang] || translations['en'];
            const template = t.cli_search_status || 'Searching {arch} — {seconds}s left';
            el.textContent = template.replace('{arch}', _searchCountdownArch || '?').replace('{seconds}', secondsLeft);
            if (secondsLeft <= 0) stopSearchCountdown();
        }

        function stopSearchCountdown() {
            if (_searchCountdownInterval) {
                clearInterval(_searchCountdownInterval);
                _searchCountdownInterval = null;
            }
            const el = document.getElementById('cli-search-status');
            if (el) el.classList.add('hidden');
        }

        // v3.13.8x (settings UX audit, Fase 4, second pass): process picker
        // for the Game PID field, rebuilt as a floating overlay after real
        // feedback on the first version (an inline disclosure-list) —
        // opening it shifted the settings panel's layout (so the mouse
        // ended up over something else) and had no obvious way to close
        // besides re-clicking the same button. This follows
        // openVndbImportModal()'s exact pattern (a couple hundred lines up
        // in this file): a plain div appended to document.body, fixed
        // position so it can never push anything else around, an explicit
        // × plus backdrop-click to close. Fetches fresh on every open
        // rather than caching the process list itself — which games are
        // running changes constantly and the whole point is picking one
        // you already launched — but list-game-processes' own icon lookups
        // ARE cached now (server-side, see _gameProcessIconCache in
        // ipc-handlers.js), so repeat opens are faster than the first one.
        // v3.13.87 (Fase D): {targetProfileId} — called from a specific
        // profile's card (openGameProcessPicker's reverse direction, "🎮
        // Vincular juego" in renderProfiles). When present, the picker
        // skips ALL decision logic below (destination screen included):
        // it writes directly to THAT profile and never touches
        // activeProfileId, #game-pid, or gameExePathHint — same contract
        // the card's own VNDB-import button already has (doesn't switch
        // profile, just writes + re-renders).
        async function openGameProcessPicker(options = {}) {
            const t = translations[currentLang] || translations['en'];

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
            overlay.innerHTML = `
                <div class="bg-white dark:bg-dark-800 rounded-lg p-4 w-[380px] max-h-[70vh] flex flex-col gap-2 shadow-xl border border-gray-200 dark:border-dark-600">
                    <div class="flex items-center justify-between">
                        <h3 class="text-sm font-bold text-gray-800 dark:text-gray-100">${escapeHtml(t.game_pid_picker_title || 'Elegir proceso')}</h3>
                        <button data-action="close" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">&times;</button>
                    </div>
                    <div id="game-process-results" class="flex-1 overflow-y-auto scrollbar-thin space-y-1 min-h-[80px]">
                        <div class="p-3 text-[10px] text-gray-400 text-center">${escapeHtml(t.game_pid_picker_loading || 'Buscando procesos…')}</div>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const closeModal = () => overlay.remove();
            overlay.querySelector('[data-action="close"]').onclick = closeModal;
            overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

            const resultsEl = overlay.querySelector('#game-process-results');
            resultsEl.addEventListener('click', async (e) => {
                const option = e.target.closest('.game-process-option');
                if (!option) return;
                const process = {
                    pid: parseInt(option.dataset.pid, 10),
                    name: option.dataset.name || '',
                    windowTitle: option.dataset.windowTitle || option.dataset.name || '',
                    exePath: option.dataset.exePath || ''
                };

                // v3.13.87 (Fase D): the reverse-direction path — writes
                // straight to targetProfileId, no PID field, no decision
                // table. See this function's own doc comment above.
                if (options.targetProfileId) {
                    closeModal();
                    let result;
                    try {
                        result = await api.setProfileGame({ profileId: options.targetProfileId, process });
                    } catch (err) {
                        result = { success: false, error: err.message };
                    }
                    if (result && result.success) {
                        await loadProfiles();
                    } else if (result && result.error === 'game-owned-by-other-profile') {
                        showToast((t.game_owned_by_other_profile || 'Ese juego ya está vinculado al perfil «{profile}».').replace('{profile}', result.profileName || ''));
                    } else if (result) {
                        showToast(result.error || (t.game_link_error || 'No se pudo vincular el juego.'));
                    }
                    return;
                }

                document.getElementById('game-pid').value = option.dataset.pid;
                const nameEl = document.getElementById('game-pid-selected-name');
                if (nameEl) {
                    nameEl.textContent = '🎮 ' + option.dataset.name;
                    nameEl.classList.remove('hidden');
                }
                // v3.13.8x: the picker already resolved this process's exe
                // path for free (list-game-processes returns it) — stashed
                // here so doLaunchTextractor can hand it to the backend for
                // the pre-flight arch check (Level 1 — see
                // TextractorLauncher#_preflightArchSwap) without a second
                // PowerShell round-trip. A PID typed by hand instead of
                // picked has no such hint; that case is covered by Level 2
                // (_checkArchAgainstGame), which reuses the resolution the
                // game-engine advisory already pays for.
                gameExePathHint = option.dataset.exePath || null;
                checkGamePidVsAttached();

                // v3.13.87 (Fase D): the ONE branch of the old A.4 decision
                // table that changes — an active profile with no `game`
                // yet no longer auto-writes straight away. It gets a
                // destination screen instead (this picker's own puerta de
                // entrada al camino VNDB). Every other branch (already
                // linked to this exact exe, exe owned by a DIFFERENT
                // profile, active profile linked to a DIFFERENT exe)
                // keeps going through handlePickedProcessForGameLink()
                // completely unchanged.
                //
                // Real bug caught in review before this ever shipped: the
                // "owned by another profile" check has to run BEFORE
                // deciding to show the destination screen, not after —
                // an active profile with no game yet doesn't mean this
                // exe is free, it can still belong to a different
                // profile's existing link. Re-derives the exact same
                // check handlePickedProcessForGameLink does (duplicated,
                // not extracted, to keep that function's own decision
                // table untouched and easy to diff against A.4) purely to
                // decide WHICH path to take; the real write still only
                // ever happens inside handlePickedProcessForGameLink or
                // renderGameLinkDestination, never here.
                const activeProfile = profileList.find((p) => p.id === activeProfileId);
                const pickTargetPathNorm = _normalizeExePathForCompare(process.exePath);
                const pickOwnedByOther = activeProfile && profileList.find((p) =>
                    p.id !== activeProfileId && p.game && _normalizeExePathForCompare(p.game.exePath) === pickTargetPathNorm
                );
                if (activeProfile && !activeProfile.game && !pickOwnedByOther) {
                    renderGameLinkDestination(resultsEl, process, activeProfile, closeModal);
                    return;
                }

                closeModal();
                // v3.13.85 (Fase A.4/B): the picker's own click is the
                // explicit user action — decides whether to ask to
                // re-point the active profile's link, or suggest a
                // different profile that already claims this exe. See
                // handlePickedProcessForGameLink's own doc comment for the
                // full decision table.
                handlePickedProcessForGameLink(process);
            });

            let result;
            try {
                result = await api.listGameProcesses();
            } catch (e) {
                result = { success: false, error: e.message };
            }
            // The modal may already be gone (user closed it before the
            // fetch resolved) — writing into a detached element is
            // harmless but pointless.
            if (!overlay.isConnected) return;

            if (!result || !result.success) {
                const msgKey = result && result.error === 'windows-only' ? 'game_pid_picker_windows_only' : 'game_pid_picker_error';
                const fallback = result && result.error === 'windows-only' ? 'Solo disponible en Windows.' : 'No se pudo obtener la lista de procesos.';
                resultsEl.innerHTML = `<div class="p-3 text-[10px] text-amber-500 text-center">${escapeHtml(t[msgKey] || fallback)}</div>`;
                return;
            }
            if (!result.processes.length) {
                resultsEl.innerHTML = `<div class="p-3 text-[10px] text-gray-400 text-center">${escapeHtml(t.game_pid_picker_empty || 'No se encontraron ventanas de juegos abiertas.')}</div>`;
                return;
            }
            resultsEl.innerHTML = result.processes.map((p) => {
                const icon = p.iconDataUrl
                    ? `<img src="${p.iconDataUrl}" class="w-5 h-5 rounded shrink-0" alt="">`
                    : `<span class="w-5 h-5 rounded bg-gray-200 dark:bg-dark-700 shrink-0 flex items-center justify-center text-[10px]">🎮</span>`;
                return `<div class="game-process-option flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-dark-700 cursor-pointer" data-pid="${p.pid}" data-name="${escapeHtml(p.name)}" data-window-title="${escapeHtml(p.windowTitle || '')}" data-exe-path="${escapeHtml(p.exePath || '')}">
                    ${icon}
                    <div class="min-w-0 flex-1">
                        <p class="text-[10px] font-medium truncate">${escapeHtml(p.windowTitle || p.name)}</p>
                        <p class="text-[9px] text-gray-400 font-mono truncate">${escapeHtml(p.name)} · PID ${p.pid}</p>
                    </div>
                </div>`;
            }).join('');
        }

        // v3.13.87 (Fase D): sibling of game-identity.js's cleanDisplayTitle —
        // duplicated rather than round-tripped over IPC because it's a pure
        // string transform over data the renderer already has
        // (process.windowTitle from list-game-processes), with no
        // dependency on profileStore or any other main-process-only state
        // (unlike compareTitles, which needs profile data and DOES go
        // through find-profile-by-title below). Keep in sync with the
        // canonical version's TITLE_NOISE_RE/TITLE_SEPARATOR_RE if either
        // changes — same regexes, copied verbatim.
        function _cleanDisplayTitle(title) {
            if (typeof title !== 'string' || !title) return '';
            let s = title.normalize('NFKC');
            s = s.replace(/[\[（(【][^\]）)】]*[\]）)】]\s*$/g, '');
            s = s.replace(/\b(x64|x86|win32|win64|directx\s?\d*|direct3d\s?\d*|opengl|vulkan|steam|v?\d+(\.\d+)+|demo|trial|paused|not responding)\b/gi, ' ');
            const sepMatch = s.match(/\s[-–—|:]\s/);
            if (sepMatch) s = s.slice(0, sepMatch.index);
            // v3.13.87 (Fase D follow-up): itch.io convention, "{Title} by
            // {Creator}" — see the canonical version's own comment in
            // game-identity.js for the real case that surfaced this
            // ("Lust Shards by MindOfFur" searching VNDB with the whole
            // string attached).
            const byMatch = s.match(/\s+by\s+\S/i);
            if (byMatch) s = s.slice(0, byMatch.index);
            // v3.13.87 (Fase D follow-up): "Chapter"/"Episode" + a number
            // is a release marker, not part of the canonical title — see
            // the canonical version's own comment in game-identity.js
            // (real case: "Lust Shards Chapter 1" should name the profile
            // "Lust Shards"). Deliberately NOT "Vol"/"Volume" — that's the
            // full canonical title for franchises like Nekopara, never a
            // suffix to strip.
            const chapterMatch = s.match(/\s+(chapter|episode)\s*\d+\b/i);
            if (chapterMatch) s = s.slice(0, chapterMatch.index);
            return s.replace(/\s+/g, ' ').trim();
        }

        // v3.13.87 (Fase D, D.1): the destination screen — replaces the
        // old silent auto-write for an active profile with no `game` yet.
        // Same renderVndbResults -> renderVndbDetail in-place-swap pattern
        // the VNDB modal already uses (no new overlay).
        async function renderGameLinkDestination(resultsEl, process, activeProfile, closeModal) {
            const t = translations[currentLang] || translations['en'];
            resultsEl.innerHTML = `<div class="p-3 text-[10px] text-gray-400 text-center">${escapeHtml(t.game_pid_picker_loading || 'Buscando procesos…')}</div>`;

            let matchResult;
            try {
                matchResult = await api.findProfileByTitle({ windowTitle: process.windowTitle, excludeProfileId: activeProfile.id });
            } catch (e) {
                matchResult = { success: false };
            }
            // The picker may have been closed while this awaited.
            if (!resultsEl.isConnected) return;

            const match = (matchResult && matchResult.success) ? matchResult.match : null;
            const preselectMatched = !!(match && match.matchKind === 'exact');
            const activeName = displayProfileName(activeProfile, t);
            const selectedCls = 'border-emerald-400 dark:border-emerald-500 bg-emerald-50 dark:bg-emerald-900/10';
            const unselectedCls = 'border-gray-200 dark:border-dark-600';

            resultsEl.innerHTML = `
                <div class="space-y-1.5">
                    <p class="text-[10px] font-medium text-gray-500 dark:text-gray-400 px-0.5">${escapeHtml((t.game_link_destination_title || 'Vincular «{game}»').replace('{game}', process.windowTitle || process.name))}</p>
                    <button data-dest="active" class="w-full text-left p-2.5 rounded-md border ${preselectMatched ? unselectedCls : selectedCls} hover:border-emerald-400 dark:hover:border-emerald-500 transition text-xs">
                        <span class="font-medium text-gray-700 dark:text-gray-200">${escapeHtml((t.game_link_dest_current_profile || 'Vincular al perfil actual: «{profile}»').replace('{profile}', activeName))}</span>
                    </button>
                    ${match ? `
                    <button data-dest="matched" class="w-full text-left p-2.5 rounded-md border ${preselectMatched ? selectedCls : unselectedCls} hover:border-emerald-400 dark:hover:border-emerald-500 transition text-xs">
                        <span class="font-medium text-gray-700 dark:text-gray-200">${escapeHtml((t.game_link_dest_matched_profile || 'Vincular al perfil «{profile}»').replace('{profile}', match.profileName))}</span>
                    </button>` : ''}
                    <button data-dest="new" class="w-full text-left p-2.5 rounded-md border ${unselectedCls} hover:border-emerald-400 dark:hover:border-emerald-500 transition text-xs">
                        <span class="font-medium text-gray-700 dark:text-gray-200">${escapeHtml(t.game_link_dest_create_new || 'Crear un perfil para este juego')}</span>
                    </button>
                    <p id="game-link-dest-engine-line" class="text-[9px] text-amber-600 dark:text-amber-400 px-0.5 pt-1"></p>
                </div>`;

            resultsEl.querySelector('[data-dest="active"]').onclick = () => _confirmGameLinkDestination(activeProfile.id, process, closeModal);
            if (match) {
                resultsEl.querySelector('[data-dest="matched"]').onclick = () => _confirmGameLinkDestination(match.profileId, process, closeModal);
            }
            resultsEl.querySelector('[data-dest="new"]').onclick = () => {
                closeModal();
                openVndbImportModal(activeProfile.id, {
                    seedQuery: _cleanDisplayTitle(process.windowTitle),
                    pendingGame: process,
                    forceNewProfile: true
                });
            };

            // Engine advisory line — informational only here (D.3's step 6
            // wires the actual persistent advice box once a profile
            // actually owns this link). Fetched after the first paint,
            // same "don't block on it" reasoning openVndbImportModal's own
            // async calls already document.
            const engineLine = resultsEl.querySelector('#game-link-dest-engine-line');
            api.inspectGame(process.exePath).then((r) => {
                if (!engineLine || !engineLine.isConnected) return;
                if (!r || !r.success || !r.engine || !r.engine.adviceKey) return;
                const template = t[r.engine.adviceKey];
                if (!template) return;
                engineLine.textContent = template.replace('{engine}', r.engine.engineLabel || r.engine.engine || '');
            }).catch(() => {});
        }

        // v3.13.87 (Fase D): shared confirm for the destination screen's
        // (a)/(b) options — (c) "crear perfil" has its own path straight
        // into openVndbImportModal (D.2/D.3), no set-profile-game call
        // here since that happens inside the VNDB modal's own import
        // handler.
        async function _confirmGameLinkDestination(profileId, process, closeModal) {
            closeModal();
            let result;
            try {
                result = await api.setProfileGame({ profileId, process });
            } catch (e) {
                result = { success: false, error: e.message };
            }
            const t = translations[currentLang] || translations['en'];
            if (!result || !result.success) {
                const msg = result && result.error === 'game-owned-by-other-profile'
                    ? (t.game_owned_by_other_profile || 'Ese juego ya está vinculado al perfil «{profile}».').replace('{profile}', result.profileName || '')
                    : (t.game_link_error || 'No se pudo vincular el juego.');
                showToast(msg);
                return;
            }
            // Only the active-profile path (a) gets the "Deshacer" strip —
            // same reasoning as A.4: it's the one case that matches
            // today's existing recovery mechanism 1:1. Linking a
            // DIFFERENT (non-active) profile via (b) writes + re-renders
            // without switching to it, same contract as D.4's card button
            // — an undo strip that only shows while VIEWING the active
            // profile wouldn't even be visible for that case.
            if (profileId === activeProfileId) {
                const profile = profileList.find((p) => p.id === activeProfileId);
                _lastGameLinkUndo = { profileId: activeProfileId, exeName: result.game.exeName, profileName: profile ? profile.name : '', windowTitle: result.game.windowTitle || '' };
                if (result.game.engine) {
                    _lastEngineAdvice = { ...result.game.engine, source: 'profile' };
                    renderEngineAdvice();
                }
            }
            await loadProfiles();
        }

        // v3.13.8x, second pass: real gap Lyca hit — gamePid is
        // deliberately NOT a saved Tier B setting (see gatherConfig()'s own
        // comment on why: a stale PID from a past session is never valid
        // for a new one), so the Save button never reacted to it even
        // before this, and maybeAutoLaunchTextractor() no-ops while
        // cliRunning is true regardless (see its own doc comment) — so
        // changing the PID field while Textractor is already attached to a
        // DIFFERENT one used to give the user no feedback at all that
        // anything needed to happen. Called on every PID input/pick;
        // compares against cliAttachedPid (set in doLaunchTextractor(),
        // cleared in killTextractorCli()) and shows/hides the inline
        // "🔄 Reconectar" banner accordingly.
        let cliAttachedPid = null;

        // v3.13.8x: the exe path of whatever process the "🎮 Elegir…"
        // picker's last selection pointed at — see the picker's click
        // handler for where this is set. Deliberately NOT persisted (same
        // reasoning as gamePid in gatherConfig()'s own comment): a path
        // from a past session is never guaranteed valid for a new one, and
        // it's only ever a same-session optimization (skip a redundant
        // PowerShell round-trip), never a correctness requirement — Level
        // 2 of the arch pre-flight check covers the case this is null.
        let gameExePathHint = null;

        function checkGamePidVsAttached() {
            const banner = document.getElementById('game-pid-reconnect-banner');
            if (!banner) return;
            const currentPid = parseInt(document.getElementById('game-pid').value);
            const mismatch = cliRunning && cliAttachedPid !== null && Number.isInteger(currentPid) && currentPid > 0 && currentPid !== cliAttachedPid;
            banner.classList.toggle('hidden', !mismatch);
        }

        // Typing a PID by hand (the fallback path) makes the "🎮 name"
        // confirmation from a previous picker selection stale/wrong — hide
        // it rather than leave a name attached to a PID that no longer
        // matches it.
        function onGamePidInput() {
            const nameEl = document.getElementById('game-pid-selected-name');
            if (nameEl) nameEl.classList.add('hidden');
            // A hand-typed PID invalidates whatever exe path the picker
            // last resolved — it may belong to a completely different
            // process now.
            gameExePathHint = null;
            checkGamePidVsAttached();
            // v3.13.85 (Fase B): a PID typed by hand means there's nothing
            // left for the background scan to resolve — _maybeArmGameScanPolling
            // only ever re-arms while the field is empty, so stopping here
            // (rather than waiting for the next tick to notice) just avoids
            // a few pointless PowerShell calls before the field naturally
            // stops qualifying.
            _stopGameScanPolling();
        }

        // The explicit action the reconnect banner offers: kill the CLI
        // attached to the old PID (if any) and relaunch straight at the
        // new one. Deliberately bypasses maybeAutoLaunchTextractor()'s own
        // guards (translationActive, manual mode) — those exist to gate
        // AUTOMATIC/implicit launches; a user clicking this button is
        // giving an explicit instruction, not triggering a side effect.
        async function reconnectWithNewPid() {
            const cliPath = document.getElementById('textractor-cli-path').value.trim();
            const newPid = parseInt(document.getElementById('game-pid').value);
            if (!cliPath || !Number.isInteger(newPid) || newPid <= 0) return;
            if (cliRunning) await killTextractorCli();
            await doLaunchTextractor(cliPath, newPid);
            const banner = document.getElementById('game-pid-reconnect-banner');
            if (banner) banner.classList.add('hidden');
        }

        // ===== GAME RECOGNITION (auto-configuración de juegos, v3.13.85, Fase B) =====
        //
        // Reconoce el juego corriendo y resuelve el PID solo, a partir del
        // vínculo perfil<->exe que Fase A introdujo (profile.game). Toda la
        // lógica de decisión (exact/moved/suggestion/ambiguous) vive en
        // game-identity.js's matchRunningProcesses(), pura y testeada — este
        // bloque es sólo el I/O (cuándo llamar a scan-known-games) y el
        // pintado de sus tres resultados posibles.

        // Named constants, not inline literals — mismo patrón que
        // textractor-launcher.js's ARCH_FALLBACK_CHECK_MAX_MS/
        // HOOK_SWITCH_THRESHOLD, para que una sesión futura no "corrija" un
        // número sin saber contra qué se eligió.
        //
        // GAME_SCAN_FOCUS_THROTTLE_MS: algunos window managers disparan
        // varios eventos 'focus' seguidos al hacer alt-tab — sin esto, una
        // sola vuelta a la ventana podría disparar varios escaneos.
        const GAME_SCAN_FOCUS_THROTTLE_MS = 5000;
        // GAME_SCAN_POLL_INTERVAL_MS × GAME_SCAN_POLL_MAX_ATTEMPTS ≈ 4 min:
        // cubre el caso real de arrancar un juego pesado (o desde el
        // launcher de Steam) DESPUÉS de haber dejado Tuhua esperando, sin
        // convertirse en un costo de fondo permanente si el juego nunca
        // abre en esta sesión — se desarma solo y avisa una vez.
        const GAME_SCAN_POLL_INTERVAL_MS = 10000;
        const GAME_SCAN_POLL_MAX_ATTEMPTS = 24;

        // Pares `${profileId}::${exePath}` que el usuario ya descartó
        // (✕ en la sugerencia, "No, ignorar" en la confirmación) — no
        // vuelven a molestar en lo que resta de la sesión. Sólo en memoria:
        // no tiene sentido persistir un "no, gracias" de una sesión pasada.
        const _suppressedGameLinkPrompts = new Set();

        let _pendingGameLinkConfirm = null; // { profileId, profileName, process, reason:'moved'|'active-relink', savedExePath, foundExePath } | null
        let _pendingGameSuggestion = null; // { profileId, profileName, coverUrl, pid, windowTitle, exePath } | null
        let _lastGameLinkUndo = null; // { profileId, exeName, profileName } | null — siempre restaura a null (ver A.4: el auto-write sólo ocurre cuando el perfil NO tenía game)
        let _gameScanPollTimer = null;
        let _gameScanPollAttempts = 0;
        let _gameScanPollHintShown = false;
        let _lastGameAutoResolvedPid = null; // toast de "PID resuelto" una sola vez por PID, no por escaneo

        function _normalizeExePathForCompare(p) {
            return (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        }

        function _stopGameScanPolling() {
            if (_gameScanPollTimer) {
                clearInterval(_gameScanPollTimer);
                _gameScanPollTimer = null;
            }
            _gameScanPollAttempts = 0;
        }

        // Se arma SOLO cuando la respuesta realmente puede cambiar: hay un
        // juego vinculado al perfil activo, no hay PID puesto todavía, la
        // traducción está activa, y el último escaneo no encontró nada. En
        // reposo (juego ya conectado, o perfil sin `game`) el costo es CERO
        // spawns de PowerShell — el disparador real es 'focus' de la
        // ventana; esto es sólo el cinturón de los tirantes.
        function _maybeArmGameScanPolling() {
            if (_gameScanPollTimer) return; // ya armado
            const profile = profileList.find((p) => p.id === activeProfileId);
            const gamePidField = document.getElementById('game-pid');
            const pidEmpty = !gamePidField || !gamePidField.value || parseInt(gamePidField.value) <= 0;
            if (!profile || !profile.game || !pidEmpty || !translationActive) return;
            _gameScanPollHintShown = false;
            _gameScanPollAttempts = 0;
            _gameScanPollTimer = setInterval(() => {
                _gameScanPollAttempts++;
                if (_gameScanPollAttempts > GAME_SCAN_POLL_MAX_ATTEMPTS) {
                    _stopGameScanPolling();
                    if (!_gameScanPollHintShown) {
                        _gameScanPollHintShown = true;
                        const t = translations[currentLang] || translations['en'];
                        showToast((t.game_scan_poll_gave_up || 'No encontré «{game}» abierto — abrí el juego y tocá 🔍 Buscar juego.').replace('{game}', profile.game.windowTitle || profile.game.exeName || ''));
                    }
                    return;
                }
                scanForKnownGames(false);
            }, GAME_SCAN_POLL_INTERVAL_MS);
        }

        // manual=true: el usuario tocó el botón 🔍 explícito — siempre
        // avisa (encontrado o no). manual=false: disparador pasivo
        // (init/focus/Save/reanudar/salir de manual/sondeo) — silencioso
        // si no hay nada nuevo que mostrar, para no interrumpir con un
        // toast en cada guardado.
        async function scanForKnownGames(manual) {
            let result;
            try {
                result = await api.scanKnownGames();
            } catch (e) {
                result = { success: false, error: e.message };
            }
            const t = translations[currentLang] || translations['en'];
            if (!result || !result.success) {
                if (manual && result && result.error === 'windows-only') {
                    showToast(t.game_scan_windows_only || 'Solo disponible en Windows.');
                }
                return;
            }

            if (result.resolved) {
                // Real bug found via a live Windows session (v3.13.85):
                // a background scan re-filling #game-pid while Textractor
                // is ALREADY attached and genuinely extracting real text
                // (cliEverExtracted) surfaces the pre-existing "🔄
                // Reconectar" banner (v3.13.8x) over a session that's
                // working fine — and if the match happens to be a
                // DIFFERENT process sharing the same exePath (a stray
                // launcher/updater window, a duplicate instance left
                // running), reconnecting to it replaces a good session
                // with a broken one. A scan can only ever improve on
                // "nothing attached yet" or "attached to something that
                // never produced real text" — once real text is flowing,
                // there's nothing for it to fix, so it must not touch the
                // PID field at all.
                if (cliRunning && cliEverExtracted) {
                    _stopGameScanPolling();
                    return;
                }
                _applyResolvedGame(result.resolved);
                _stopGameScanPolling();
                return;
            }

            if (result.needsPathConfirm) {
                const key = `${result.needsPathConfirm.profileId}::${result.needsPathConfirm.foundExePath}`;
                if (!_suppressedGameLinkPrompts.has(key)) {
                    _pendingGameLinkConfirm = { ...result.needsPathConfirm, reason: 'moved' };
                    renderGameBanners();
                }
                return;
            }

            if (result.suggestion) {
                const key = `${result.suggestion.profileId}::${result.suggestion.exePath}`;
                if (!_suppressedGameLinkPrompts.has(key)) {
                    _pendingGameSuggestion = result.suggestion;
                    renderGameBanners();
                }
                return;
            }

            // Nada resuelto, ni confirmación, ni sugerencia, ni ambiguo —
            // sólo aquí tiene sentido armar el sondeo (la próxima vez el
            // juego puede no estar abierto todavía) y avisar si fue manual.
            _maybeArmGameScanPolling();
            if (manual) {
                showToast(t.game_scan_not_found || 'No encontré tu juego abierto.');
            }
        }

        function _applyResolvedGame(resolved) {
            // Real bug found via a live Windows session (v3.13.85): a
            // passive background scan (triggered by window focus, Save,
            // resume, etc. — NOT an explicit pick) must never silently
            // overwrite a PID the user already has in the field, even if
            // Textractor isn't currently running against it. Observed
            // failure: the field kept "reverting" to a different PID than
            // the one just manually selected, because a focus-triggered
            // scan re-resolved the SAME exePath to a second, apparently
            // lingering process and silently swapped + auto-launched over
            // it. A scan can only ever be useful when there's NOTHING in
            // the field yet — once populated (by any means), only an
            // explicit re-pick (handlePickedProcessForGameLink, a
            // separate call path) is allowed to change it.
            const pidField = document.getElementById('game-pid');
            const currentPid = parseInt(pidField.value, 10);
            const fieldHasAValue = Number.isInteger(currentPid) && currentPid > 0;
            if (fieldHasAValue && currentPid !== resolved.pid) {
                return;
            }
            pidField.value = resolved.pid;
            const nameEl = document.getElementById('game-pid-selected-name');
            if (nameEl) {
                nameEl.textContent = '🎮 ' + (resolved.exeName || '');
                nameEl.classList.remove('hidden');
            }
            gameExePathHint = resolved.exePath || null;
            checkGamePidVsAttached();
            if (resolved.engine) {
                _lastEngineAdvice = { ...resolved.engine, source: 'profile' };
                renderEngineAdvice();
            }
            // v3.13.87 (Fase D follow-up): real UX bug Lyca caught testing
            // a Ren'Py game — this used to unconditionally call
            // maybeAutoLaunchTextractor() and say "PID {pid} conectado"
            // regardless of the engine. For a game we ALREADY know
            // Textractor can't read (textractorWorks===false, cached on
            // profile.game.engine since Fase A/C), that's actively
            // misleading: "conectado" implies it's working, when in
            // Textractor mode this would instead spend the full 60s
            // arch-fallback cycle failing silently in the background (the
            // exact "NO REAL HOOK EVER APPEARED" dead end Ren'Py always
            // hits). Skip the launch attempt entirely and say so plainly
            // instead — the engine advisory box (just rendered above)
            // already tells the user what TO use.
            const knownIncompatible = resolved.engine && resolved.engine.textractorWorks === false;
            if (!knownIncompatible) {
                maybeAutoLaunchTextractor();
            }
            if (_lastGameAutoResolvedPid !== resolved.pid) {
                _lastGameAutoResolvedPid = resolved.pid;
                const t = translations[currentLang] || translations['en'];
                const template = knownIncompatible
                    ? (t.game_auto_resolved_incompatible || '🎮 Encontré tu juego — PID {pid}, pero Textractor no puede leerlo (mirá el aviso de arriba)')
                    : (t.game_auto_resolved || '🎮 Encontré tu juego — PID {pid} conectado');
                showToast(template.replace('{pid}', resolved.pid));
            }
        }

        // Pinta la línea de "juego vinculado a este perfil" + la tira de
        // deshacer de A.4. Llamado desde loadProfiles() (siempre que la
        // lista de perfiles se refresca) y desde changeLanguage().
        //
        // v3.13.86: deliberately does NOT touch #game-pid. Tried scoping
        // it per profile (clear/restore on every switch) after a real bug
        // report — a freshly duplicated profile showed the PID of the
        // profile it was cloned from. Reverted after checking Textractor's
        // own CLI protocol (Artikash/Textractor, host/CLI/main.cpp):
        // `attach -P<pid>`/`detach -P<pid>` are per-process, so the
        // upstream binary itself doesn't forbid multiple simultaneous
        // attachments (its GUI famously supports hooking several games at
        // once) — but Tuhua's own TextractorLauncher is architected around
        // exactly ONE active attachment at a time (kills + relaunches on
        // every PID change, confirmed in every session log), and the
        // whole pipeline (overlay, TM context, hook selection) assumes a
        // single current game. Given that, #game-pid is correctly a
        // GLOBAL "what Textractor is attached to right now" value, not a
        // per-profile one — showing the same PID across every profile
        // while it's attached is accurate, not a bug. Lyca's explicit
        // call after walking through this.
        function renderGameStatus() {
            const t = translations[currentLang] || translations['en'];
            const lineEl = document.getElementById('game-current-line');
            const coverEl = document.getElementById('game-current-cover');
            if (lineEl) {
                const profile = profileList.find((p) => p.id === activeProfileId);
                if (profile && profile.game) {
                    lineEl.textContent = '🎮 ' + (profile.game.windowTitle || profile.game.exeName || profile.game.exePath || '');
                    lineEl.title = profile.game.exePath || '';
                    // v3.13.85: same cover the profile card shows (set on a
                    // VNDB import, same field the card reads) — a profile
                    // linked to a game AND imported from VNDB gets its
                    // thumbnail here too, matching Lyca's ask that this look
                    // like the profile card instead of a bare text line.
                    const coverUrl = profile.cover && profile.cover.url ? profile.cover.url : null;
                    if (coverEl) {
                        if (coverUrl) {
                            coverEl.src = coverUrl;
                            coverEl.classList.remove('hidden');
                        } else {
                            coverEl.classList.add('hidden');
                            coverEl.src = '';
                        }
                    }
                } else {
                    lineEl.textContent = t.game_none_linked || 'Sin juego vinculado a este perfil.';
                    lineEl.title = '';
                    if (coverEl) { coverEl.classList.add('hidden'); coverEl.src = ''; }
                }
            }
            const undoBox = document.getElementById('game-link-undo');
            if (undoBox) {
                if (_lastGameLinkUndo) {
                    undoBox.classList.remove('hidden');
                    const textEl = document.getElementById('game-link-undo-text');
                    if (textEl) {
                        textEl.textContent = (t.game_saved_to_profile || '🎮 {game} guardado en el perfil «{profile}»')
                            .replace('{game}', _lastGameLinkUndo.exeName || '')
                            .replace('{profile}', _lastGameLinkUndo.profileName || '');
                    }
                } else {
                    undoBox.classList.add('hidden');
                }
            }
        }

        async function undoGameLink() {
            if (!_lastGameLinkUndo) return;
            const { profileId } = _lastGameLinkUndo;
            _lastGameLinkUndo = null;
            renderGameStatus();
            try {
                await api.setProfileGame({ profileId, process: null });
            } catch (e) { /* best-effort — nada crítico que reportar */ }
            await loadProfiles();
        }

        // v3.13.87 (Fase D): the "Buscar en VNDB" follow-up next to
        // Deshacer — (a) "Vincular al perfil actual" links instantly with
        // no VNDB detour (same as A.4 always did), but the game is
        // already linked at this point, so there's no `pendingGame`/
        // `forceNewProfile` to thread through: just seed the search with
        // the game's own title and let the user import (or not) like any
        // other profile's "Importar de VNDB" button.
        function _searchVndbFromUndo() {
            if (!_lastGameLinkUndo) return;
            const { profileId, windowTitle } = _lastGameLinkUndo;
            openVndbImportModal(profileId, { seedQuery: _cleanDisplayTitle(windowTitle) });
        }

        // Pinta las dos banners de acción (confirmación de re-vínculo,
        // sugerencia de otro perfil) — nunca ambas a la vez en la práctica
        // (scanForKnownGames sólo puebla una u otra por escaneo), pero cada
        // una se oculta independientemente si su estado es null.
        function renderGameBanners() {
            const t = translations[currentLang] || translations['en'];

            const confirmBox = document.getElementById('game-link-confirm');
            if (confirmBox) {
                if (_pendingGameLinkConfirm) {
                    confirmBox.classList.remove('hidden');
                    const descEl = document.getElementById('game-link-confirm-desc');
                    if (descEl) {
                        const p = _pendingGameLinkConfirm;
                        const key = p.reason === 'moved' ? 'game_link_confirm_moved_desc' : 'game_link_confirm_relink_desc';
                        const fallback = p.reason === 'moved'
                            ? '«{profile}» parece haberse movido de carpeta.\nGuardado: {saved}\nEncontrado: {found}'
                            : '«{profile}» ya está vinculado a otro juego. ¿Vincularlo a este en su lugar?\n{found}';
                        descEl.textContent = (t[key] || fallback)
                            .replace('{profile}', p.profileName || '')
                            .replace('{saved}', p.savedExePath || '')
                            .replace('{found}', p.foundExePath || (p.process && p.process.exePath) || '');
                    }
                } else {
                    confirmBox.classList.add('hidden');
                }
            }

            const suggestBox = document.getElementById('game-profile-suggestion');
            if (suggestBox) {
                if (_pendingGameSuggestion) {
                    suggestBox.classList.remove('hidden');
                    const descEl = document.getElementById('game-profile-suggestion-desc');
                    if (descEl) {
                        descEl.textContent = (t.game_profile_suggestion_desc || 'Detecté «{game}» — parece el perfil «{profile}».')
                            .replace('{game}', _pendingGameSuggestion.windowTitle || _pendingGameSuggestion.exePath || '')
                            .replace('{profile}', _pendingGameSuggestion.profileName || '');
                    }
                } else {
                    suggestBox.classList.add('hidden');
                }
            }
        }

        async function confirmGameLinkChange() {
            if (!_pendingGameLinkConfirm) return;
            const pending = _pendingGameLinkConfirm;
            const process = pending.process || {
                pid: pending.pid, name: pending.processName || '',
                windowTitle: pending.windowTitle, exePath: pending.foundExePath
            };
            let result;
            try {
                result = await api.setProfileGame({ profileId: pending.profileId, process });
            } catch (e) {
                result = { success: false, error: e.message };
            }
            _pendingGameLinkConfirm = null;
            renderGameBanners();
            if (!result || !result.success) {
                showToast(result && result.error ? result.error : 'Error');
                return;
            }
            await loadProfiles();
            if (process.pid) {
                document.getElementById('game-pid').value = process.pid;
                gameExePathHint = process.exePath || null;
                checkGamePidVsAttached();
                if (result.game && result.game.engine) {
                    _lastEngineAdvice = { ...result.game.engine, source: 'profile' };
                    renderEngineAdvice();
                }
                maybeAutoLaunchTextractor();
            }
        }

        function dismissGameLinkChange() {
            if (_pendingGameLinkConfirm) {
                const exePath = _pendingGameLinkConfirm.foundExePath || (_pendingGameLinkConfirm.process && _pendingGameLinkConfirm.process.exePath);
                _suppressedGameLinkPrompts.add(`${_pendingGameLinkConfirm.profileId}::${exePath}`);
            }
            _pendingGameLinkConfirm = null;
            renderGameBanners();
        }

        async function acceptGameProfileSuggestion() {
            if (!_pendingGameSuggestion) return;
            const id = _pendingGameSuggestion.profileId;
            _pendingGameSuggestion = null;
            renderGameBanners();
            await loadProfile(id);
            scanForKnownGames(false);
        }

        function dismissGameProfileSuggestion() {
            if (_pendingGameSuggestion) {
                _suppressedGameLinkPrompts.add(`${_pendingGameSuggestion.profileId}::${_pendingGameSuggestion.exePath}`);
            }
            _pendingGameSuggestion = null;
            renderGameBanners();
        }

        // Llamado desde el click handler del picker (openGameProcessPicker)
        // — implementa la tabla de decisión de Fase A.4. El único caso que
        // escribe SOLO (sin click adicional) es "primera vez" (el perfil
        // activo no tiene game todavía); todo lo demás pide confirmación o
        // se limita a sugerir.
        async function handlePickedProcessForGameLink(process) {
            if (!process || !process.exePath) return;
            const profile = profileList.find((p) => p.id === activeProfileId);
            if (!profile) return;

            const targetPathNorm = _normalizeExePathForCompare(process.exePath);
            const ownedByOther = profileList.find((p) =>
                p.id !== activeProfileId && p.game && _normalizeExePathForCompare(p.game.exePath) === targetPathNorm
            );
            if (ownedByOther) {
                const key = `${ownedByOther.id}::${process.exePath}`;
                if (!_suppressedGameLinkPrompts.has(key)) {
                    _pendingGameSuggestion = {
                        profileId: ownedByOther.id, profileName: ownedByOther.name,
                        coverUrl: (ownedByOther.cover && ownedByOther.cover.url) || null,
                        pid: process.pid, windowTitle: process.windowTitle, exePath: process.exePath
                    };
                    renderGameBanners();
                }
                return;
            }

            if (!profile.game) {
                let result;
                try {
                    result = await api.setProfileGame({ profileId: activeProfileId, process });
                } catch (e) {
                    result = { success: false, error: e.message };
                }
                if (!result || !result.success) return;
                _lastGameLinkUndo = { profileId: activeProfileId, exeName: result.game.exeName, profileName: profile.name, windowTitle: result.game.windowTitle || '' };
                if (result.game.engine) {
                    _lastEngineAdvice = { ...result.game.engine, source: 'profile' };
                    renderEngineAdvice();
                }
                await loadProfiles();
                return;
            }

            if (_normalizeExePathForCompare(profile.game.exePath) === targetPathNorm) {
                return; // ya vinculado exactamente a este exe
            }

            _pendingGameLinkConfirm = {
                profileId: activeProfileId, profileName: profile.name, process,
                reason: 'active-relink', savedExePath: profile.game.exePath, foundExePath: process.exePath
            };
            renderGameBanners();
        }

        // v3.13.8x (settings UX audit, Fase 5): "avisar siempre" from the
        // plan — never silent in either the found or not-found branch.
        // Shared by both delivery paths: the read-once pull
        // (get-textractor-auto-detect-result, called from init()) for the
        // app-startup trigger, and the live push
        // (onTextractorCliPathAutodetected) for switching to Textractor
        // mid-session. `result` is null when neither trigger ever ran this
        // session (e.g. a path was already saved) — nothing to show.
        function handleTextractorAutoDetectResult(result) {
            if (!result) return;
            const t = translations[currentLang] || translations['en'];
            if (result.found) {
                const input = document.getElementById('textractor-cli-path');
                if (input) input.value = result.path;
                const template = t.textractor_autodetect_found || 'Textractor detectado en {path}';
                showToast(template.replace('{path}', result.path));
            } else {
                showToast(t.textractor_autodetect_not_found || 'No se encontró Textractor automáticamente — usá "Examinar" para indicar la ruta.');
            }
        }

        async function browseTextractorCli() {
            const result = await api.textractorBrowseCli();
            if (result.canceled) return;

            const input = document.getElementById('textractor-cli-path');
            const status = document.getElementById('cli-path-status');

            // Use the resolved path (folder -> x64/Textractor.exe auto-resolved)
            input.value = result.path;

            if (result.valid) {
                if (result.autoResolved) {
                    const t = translations[currentLang] || translations['en'];
                    status.innerHTML = '<span class="text-blue-500">✓ ' + (t.cli_auto_detected || 'Auto-detected') + '</span>';
                } else {
                    status.innerHTML = '<span class="text-emerald-500">✓</span>';
                }
                input.classList.remove('border-red-400', 'dark:border-red-600');
                input.classList.add('border-emerald-400', 'dark:border-emerald-600');
            } else {
                status.innerHTML = '<span class="text-red-500">✗</span>';
                input.classList.remove('border-emerald-400', 'dark:border-emerald-600');
                input.classList.add('border-red-400', 'dark:border-red-600');
            }
            setTimeout(() => {
                status.innerHTML = '';
                input.classList.remove('border-emerald-400', 'dark:border-emerald-600', 'border-red-400', 'dark:border-red-600');
            }, 5000);

            // Save the resolved .exe path (not the folder)
            api.saveSettings({ textractorCliPath: result.path });
        }

        // v3.13.8x (settings UX audit, Fase 5, second pass): the field
        // above is `readonly`, so this is the only UI path back to "no
        // saved path" — which both auto-detect triggers require to fire
        // again. Immediately re-runs detection server-side (rather than
        // just clearing and leaving it to a restart or an input-method
        // toggle), reusing handleTextractorAutoDetectResult() for the
        // found/not-found toast — same messaging as both other triggers.
        async function clearTextractorCliPath() {
            const input = document.getElementById('textractor-cli-path');
            const status = document.getElementById('cli-path-status');
            input.value = '';
            const t = translations[currentLang] || translations['en'];
            status.innerHTML = '<span class="text-gray-400">…</span>';
            const result = await api.textractorClearCliPath();
            status.innerHTML = '';
            setTimeout(() => { status.innerHTML = ''; }, 5000);
            handleTextractorAutoDetectResult(result);
        }

        // v3.13.37: extracted from the old manual launchTextractorCli() so
        // both the auto-launch path (maybeAutoLaunchTextractor, below) and
        // any future manual trigger share one implementation. cliPath/
        // gamePid are passed in rather than re-read from the DOM so a
        // caller can validate them first (see maybeAutoLaunchTextractor).
        async function doLaunchTextractor(cliPath, gamePid) {
            // v3.13.32: a fresh launch starts clean — don't carry over an
            // amber arch-fallback notice or a latched terminal-error flag
            // from whatever the previous session ended with (see
            // updateCliStatus's 'launched'/'error'/'exited' cases for what
            // these guard).
            cliArchFallbackNotice = '';
            cliHasTerminalError = false;
            // v3.13.39: a fresh launch hasn't proven anything yet — the
            // badge must not stay green off a PREVIOUS process's proof.
            cliEverExtracted = false;
            if (cliStatusHideTimer) { clearTimeout(cliStatusHideTimer); cliStatusHideTimer = null; }

            document.getElementById('btn-kill-cli').classList.remove('hidden');

            // v3.13.38: no port input left in the UI (see gatherConfig's
            // comment) — pass undefined and let ipc-handlers.js's existing
            // fallback chain resolve it: requestedPort || store.get('textractorPort') || 9251.
            // v3.13.8x: gameExePathHint (4th arg) feeds the pre-flight arch
            // check's Level 1 — see its own comment at the picker's click
            // handler for what ties it to this exact gamePid, and null
            // whenever it doesn't apply (PID typed by hand). The backend
            // degrades to the existing 60s fallback either way.
            const result = await api.textractorLaunch(cliPath, gamePid, undefined, gameExePathHint);
            const status = document.getElementById('cli-status-bar');
            const text = document.getElementById('cli-status-text');
            status.classList.remove('hidden');

            if (result.success) {
                const t = translations[currentLang] || translations['en'];
                cliRunning = true;
                cliAttachedPid = gamePid;
                checkGamePidVsAttached();
                text.innerHTML = '<span class="text-emerald-500">● TextractorCLI: ' + (t.cli_running_status || 'Running') + '</span> (PID: ' + gamePid + ')';
                document.getElementById('cli-pid-text').innerText = 'CLI PID: ...';
                recomputeBadge();
                // Update CLI process PID after a short delay
                setTimeout(async () => {
                    const s = await api.textractorCliStatus();
                    if (s.processPid) {
                        document.getElementById('cli-pid-text').innerText = 'CLI PID: ' + s.processPid;
                    }
                }, 1000);
            } else {
                const t = translations[currentLang] || translations['en'];
                text.innerHTML = '<span class="text-red-500">✗ Error: ' + (result.error || t.cli_unknown_error || 'Unknown') + '</span>';
                document.getElementById('btn-kill-cli').classList.add('hidden');
                cliRunning = false;
                recomputeBadge();
                setTimeout(() => status.classList.add('hidden'), 5000);
            }
        }

        // v3.13.37: replaces the manual "Lanzar" button — Textractor now
        // launches itself whenever there's something real to react to
        // (Save, resuming from pause, leaving manual mode), as long as
        // Tuhua isn't already running it. Silent no-ops (missing path/PID,
        // manual mode, paused, already running) are intentional: this is
        // called opportunistically from several places, not from a single
        // explicit user action, so it shouldn't surface an error for
        // "nothing to do yet". Kill remains the only manual stop control,
        // and — deliberately — killing does NOT block a future auto-launch
        // here; it just means none of these triggers have fired again yet.
        async function maybeAutoLaunchTextractor() {
            if (currentInputMethod !== 'textractor') return;
            if (document.getElementById('manual-textractor-mode').checked) return;
            if (!translationActive) return;
            if (cliRunning) return;
            const cliPath = document.getElementById('textractor-cli-path').value.trim();
            const gamePid = parseInt(document.getElementById('game-pid').value);
            if (!cliPath || !gamePid || gamePid <= 0) return;
            await doLaunchTextractor(cliPath, gamePid);
        }

        async function killTextractorCli() {
            await api.textractorKill();
            cliRunning = false;
            cliAttachedPid = null;
            checkGamePidVsAttached();
            cliEverExtracted = false;
            recomputeBadge();
            document.getElementById('btn-kill-cli').classList.add('hidden');

            // v3.13.76: the advisory belongs to the PID that just died —
            // without clearing it, the previous game's engine advisory
            // survives into whatever gets attached next, at least until a
            // fresh one arrives (which may take a while if the next game's
            // engine detection resolves to `unknown`/silent).
            // v3.13.85 (Fase C2): only clear an advisory that came FROM the
            // launcher (source==='launcher') — one seeded from the game
            // picker/a linked profile (Fase B/D) describes the CONFIGURED
            // game, not the Textractor session that just died, and must
            // survive a Kill click.
            if (_lastEngineAdvice && _lastEngineAdvice.source === 'launcher') {
                _lastEngineAdvice = null;
                renderEngineAdvice();
            }

            const status = document.getElementById('cli-status-bar');
            const text = document.getElementById('cli-status-text');
            const t = translations[currentLang] || translations['en'];
            text.innerHTML = '<span class="text-gray-400">TextractorCLI: ' + (t.cli_stopped_status || 'Stopped') + '</span>';
            document.getElementById('cli-pid-text').innerText = '';
            setTimeout(() => status.classList.add('hidden'), 2000);
        }

        function updateCliStatus(status) {
            const text = document.getElementById('cli-status-text');
            const statusBar = document.getElementById('cli-status-bar');
            const errorDetail = document.getElementById('cli-error-detail');
            const t = translations[currentLang] || translations['en'];
            statusBar.classList.remove('hidden');

            switch (status) {
                case 'launched':
                    cliRunning = true;
                    // v3.13.39: a fresh 'launched' means a new process — it
                    // hasn't proven it can extract real text yet.
                    cliEverExtracted = false;
                    // v3.13.32: a relaunch (arch fallback) is now over —
                    // clear both the amber notice and any stale hide timer
                    // from the 'relaunching'/'exited' transitions that led
                    // here, so this 'launched' reads as an honest running
                    // state, not a fallback still in progress.
                    cliArchFallbackNotice = '';
                    cliHasTerminalError = false;
                    if (cliStatusHideTimer) { clearTimeout(cliStatusHideTimer); cliStatusHideTimer = null; }
                    text.innerHTML = '<span class="text-emerald-500">● TextractorCLI: ' + (t.cli_running_status || 'Running') + '</span>';
                    errorDetail.classList.add('hidden');
                    document.getElementById('btn-kill-cli').classList.remove('hidden');
                    break;
                case 'relaunching':
                    // v3.13.32: NOT a stop. The launcher killed the current
                    // process on purpose and is spawning the sibling
                    // architecture ~300ms later — see _emitStatus()'s doc
                    // in textractor-launcher.js. This used to arrive as
                    // plain 'killed'/'exited', which the case below maps
                    // to "user stopped it": the Launch button reappeared
                    // and the whole status bar hid itself 2s later,
                    // erasing the amber "probando x86..." notice and
                    // inviting the click that restarted the entire 2x60s
                    // discovery cycle from scratch (a real, reported loop).
                    // Kept the Stop button showing and cliRunning true so
                    // the user can still cancel the handover if they want.
                    cliRunning = true;
                    cliHasTerminalError = false;
                    // v3.13.39: the sibling architecture is a NEW process —
                    // back to amber "searching" until it proves itself too.
                    cliEverExtracted = false;
                    if (cliStatusHideTimer) { clearTimeout(cliStatusHideTimer); cliStatusHideTimer = null; }
                    text.innerHTML = '<span class="text-amber-500 pulse-dot">⟳ ' + (cliArchFallbackNotice || t.cli_relaunching_status || 'Switching architecture...') + '</span>';
                    errorDetail.classList.add('hidden');
                    document.getElementById('btn-kill-cli').classList.remove('hidden');
                    break;
                case 'exited':
                case 'killed':
                    cliRunning = false;
                    cliEverExtracted = false;
                    stopSearchCountdown();
                    text.innerHTML = '<span class="text-gray-400">TextractorCLI: ' + (t.cli_stopped_status || 'Stopped') + '</span>';
                    document.getElementById('btn-kill-cli').classList.add('hidden');
                    // v3.13.32: cancelable now, and gated on !cliHasTerminalError
                    // — this timer used to unconditionally hide
                    // #cli-error-detail 2s after ANY stop, including one
                    // that just carried a terminal error the user hadn't
                    // had a chance to read yet (showCliError's OWN 15s
                    // auto-hide never got a chance to run: this 2s one
                    // always won the race). A previous investigation
                    // relied on the "silent failure" this caused as
                    // evidence something was un-diagnosable — it wasn't
                    // silent, it was erased.
                    if (cliStatusHideTimer) clearTimeout(cliStatusHideTimer);
                    cliStatusHideTimer = setTimeout(() => {
                        cliStatusHideTimer = null;
                        if (!cliRunning && !cliHasTerminalError) {
                            errorDetail.classList.add('hidden');
                            statusBar.classList.add('hidden');
                        }
                    }, 2000);
                    break;
                case 'error':
                    cliRunning = false;
                    cliHasTerminalError = true;
                    cliEverExtracted = false;
                    stopSearchCountdown();
                    if (cliStatusHideTimer) { clearTimeout(cliStatusHideTimer); cliStatusHideTimer = null; }
                    text.innerHTML = '<span class="text-red-500">✗ TextractorCLI: ' + (t.cli_error_status || 'Error') + '</span>';
                    document.getElementById('btn-kill-cli').classList.add('hidden');
                    break;
                case 'extracting':
                    cliRunning = true;
                    // v3.13.39: THE signal the navbar badge was missing —
                    // real, deduped game text reached the pipeline. Only
                    // 'stdout-active' (textractor-launcher.js) drives this,
                    // so the badge can't go green off mere process liveness.
                    cliEverExtracted = true;
                    text.innerHTML = '<span class="text-emerald-500 pulse-dot">● TextractorCLI: ' + (t.cli_extracting_status || 'Extracting text') + '</span>';
                    errorDetail.classList.add('hidden');
                    break;
                default:
                    text.innerHTML = '<span class="text-gray-400">TextractorCLI: ' + status + '</span>';
            }

            // v3.13.39: one call site covers every case above, including
            // 'configured' and any other value that falls to default —
            // recomputeBadge() only reads cliRunning/cliEverExtracted, both
            // already updated by the branch that ran.
            recomputeBadge();
        }

        /**
         * v3.13.24: textractor-launcher.js's hint/message strings used to
         * ship hardcoded in Spanish regardless of UI language. The backend
         * now sends a stable `xKey` (+ optional `xParams` for dynamic bits
         * like a PID or path) alongside the English-fallback string —
         * this looks the key up in the current language's dictionary and
         * substitutes `{param}` placeholders, falling back to the raw
         * string from the backend if the key is missing or untranslated.
         */
        function translateHintKey(key, params, fallback) {
            const t = translations[currentLang] || translations['en'];
            let text = (key && t[key]) || fallback || '';
            if (params) {
                for (const [k, v] of Object.entries(params)) {
                    text = text.split('{' + k + '}').join(v);
                }
            }
            return text;
        }

        /**
         * Show detailed CLI error information (v3.8.23)
         * errorData = { message, messageKey, messageParams, code, severity, hint, hintKey, hintParams, stderr, stdout, gamePid, cliPath, timestamp }
         */
        function showCliError(errorData) {
            const errorDetail = document.getElementById('cli-error-detail');
            const errorMessage = document.getElementById('cli-error-message');
            const errorHint = document.getElementById('cli-error-hint');
            const errorTechnical = document.getElementById('cli-error-technical');
            const statusBar = document.getElementById('cli-status-bar');

            statusBar.classList.remove('hidden');
            errorDetail.classList.remove('hidden');

            // Main error message
            errorMessage.textContent = translateHintKey(errorData.messageKey, errorData.messageParams, errorData.message) || 'Unknown error';

            // Helpful hint
            const hintText = translateHintKey(errorData.hintKey, errorData.hintParams, errorData.hint);
            if (hintText) {
                errorHint.textContent = '💡 ' + hintText;
                errorHint.classList.remove('hidden');
            } else {
                errorHint.classList.add('hidden');
            }

            // Technical details (collapsible)
            let techLines = [];
            if (errorData.code !== null && errorData.code !== undefined) {
                techLines.push('Código de salida: ' + errorData.code);
            }
            if (errorData.stderr) {
                techLines.push('Stderr: ' + errorData.stderr.substring(0, 500));
            }
            if (errorData.stdout) {
                techLines.push('Stdout: ' + errorData.stdout.substring(0, 500));
            }
            if (errorData.gamePid) {
                techLines.push('PID: ' + errorData.gamePid);
            }
            if (errorData.severity) {
                techLines.push('Severidad: ' + errorData.severity);
            }
            errorTechnical.textContent = techLines.join('\n');

            // Auto-hide after 15 seconds (longer than before since it's useful)
            // But don't hide if user is looking at technical details
            setTimeout(() => {
                const detailsOpen = errorDetail.querySelector('details[open]');
                if (!detailsOpen && !cliRunning) {
                    errorDetail.classList.add('hidden');
                }
            }, 15000);
        }

        /**
         * Test if TextractorCLI can start (v3.8.23)
         */
        async function testTextractorCli() {
            const cliPath = document.getElementById('textractor-cli-path').value.trim();
            if (!cliPath) {
                await browseTextractorCli();
                return;
            }

            const btn = document.getElementById('btn-test-cli');
            const statusBar = document.getElementById('cli-status-bar');
            const statusText = document.getElementById('cli-status-text');
            const errorDetail = document.getElementById('cli-error-detail');

            // Show testing state
            const t = translations[currentLang] || translations['en'];
            btn.disabled = true;
            btn.innerHTML = '<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Test...</span>';
            statusBar.classList.remove('hidden');
            statusText.innerHTML = '<span class="text-blue-500">⏳ ' + (t.cli_testing_status || 'Testing TextractorCLI...') + '</span>';
            errorDetail.classList.add('hidden');

            try {
                const result = await api.textractorTestCli(cliPath);

                if (result.canStart) {
                    statusText.innerHTML = '<span class="text-emerald-500">✓ ' + (t.cli_works_correctly || 'TextractorCLI works correctly') + '</span>';
                    const okHint = translateHintKey(result.hintKey, result.hintParams, result.hint);
                    if (okHint) {
                        statusText.innerHTML += '<span class="text-[9px] text-gray-400 ml-1">(' + okHint + ')</span>';
                    }
                    // Save the resolved path on successful test (folder -> x64/Textractor.exe)
                    const pathToSave = result.resolvedPath || cliPath;
                    document.getElementById('textractor-cli-path').value = pathToSave;
                    api.saveSettings({ textractorCliPath: pathToSave });
                    setTimeout(() => {
                        if (!cliRunning) statusBar.classList.add('hidden');
                    }, 3000);
                } else {
                    statusText.innerHTML = '<span class="text-red-500">✗ ' + (t.cli_failed_to_start_status || 'TextractorCLI failed to start') + '</span>';
                    // Show detailed error
                    showCliError({
                        message: 'TextractorCLI failed to start',
                        messageKey: 'hint_cli_failed_to_start',
                        code: result.exitCode,
                        severity: 'error',
                        hintKey: result.hintKey,
                        hintParams: result.hintParams,
                        hint: result.hint || 'Verify the file exists and the DLLs are present.',
                        stderr: result.stderr || '',
                        stdout: result.stdout || ''
                    });
                }
            } catch (err) {
                statusText.innerHTML = '<span class="text-red-500">✗ ' + (t.cli_test_error_prefix || 'Error testing') + ': ' + (err.message || t.cli_unknown_error || 'Unknown') + '</span>';
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>Test</span>';
            }
        }

        function appendCliOutput(text) {
            // Optionally log CLI output for debugging (could add a collapsible log view later)
            console.log('[TextractorCLI]', text);
        }

        function toggleManualMode(enabled) {
            const cliPathInput = document.getElementById('textractor-cli-path');
            const gamePidInput = document.getElementById('game-pid');
            const killBtn = document.getElementById('btn-kill-cli');

            if (enabled) {
                // Manual mode: disable CLI controls, just connect to TCP
                cliPathInput.disabled = true;
                cliPathInput.classList.add('opacity-50');
                gamePidInput.disabled = true;
                gamePidInput.classList.add('opacity-50');
                killBtn.disabled = true;
                killBtn.classList.add('opacity-50');
                // Connect directly to TCP
                api.saveSettings({ manualTextractorMode: true });
            } else {
                cliPathInput.disabled = false;
                cliPathInput.classList.remove('opacity-50');
                gamePidInput.disabled = false;
                gamePidInput.classList.remove('opacity-50');
                killBtn.disabled = false;
                killBtn.classList.remove('opacity-50');
                api.saveSettings({ manualTextractorMode: false });
                // v3.13.37: leaving manual mode is a "real trigger" for
                // auto-launch — see maybeAutoLaunchTextractor's doc.
                maybeAutoLaunchTextractor();
                // v3.13.85 (Fase B, disparador 5): same "real trigger"
                // reasoning as above.
                scanForKnownGames(false);
            }
        }

        // ===== HOOK SELECTOR (v3.8.22) =====
        let _discoveredHooks = []; // Cache of discovered hooks
        // v3.13.76: sticky cache of the last gameEngine advisory — separate
        // from _discoveredHooks because it must render even with zero hooks
        // (the Ren'Py/Godot/FNA case: those engines can produce no hooks at
        // all, but the advisory still has to show). See renderEngineAdvice().
        // v3.13.85 (Fase C2): populated by onGameEngineAdvice's own push
        // listener now, not by updateHookSelector's payload — see that
        // listener for the `source` field this checks before clearing on Kill.
        let _lastEngineAdvice = null;
        // v3.13.79 (Fase 3, round-3 plan): sticky cache for the OCR-side
        // advisory (suggest PaddleOCR when Tesseract quality has been
        // persistently poor this session) — same "must survive a language
        // switch repaint" reasoning as _lastEngineAdvice above, separate
        // variable because it's a different event/section entirely.
        let _lastOcrEngineAdvice = null;

        function onHookSelected(hookKey) {
            // Send the hook selection to the backend
            api.textractorSelectHook(hookKey || null);
            // Update preview
            if (hookKey) {
                const hook = _discoveredHooks.find(h => h.key === hookKey);
                if (hook) {
                    updateHookPreview(hook);
                }
            } else {
                document.getElementById('hook-preview').classList.add('hidden');
            }
        }

        function updateHookPreview(hook, isAutoMode) {
            const previewDiv = document.getElementById('hook-preview');
            const previewText = document.getElementById('hook-preview-text');
            const scoreEl = document.getElementById('hook-preview-score');
            if (hook && hook.lastText) {
                previewDiv.classList.remove('hidden');
                previewText.textContent = hook.lastText;
                // v3.13.23: show _autoSelectBestHook's score so the user can
                // see why this hook was picked instead of only finding out
                // from the log — only makes sense in Auto mode, since a
                // manually-selected hook wasn't scored to reach that state.
                if (isAutoMode && scoreEl && hook.score !== null && hook.score !== undefined) {
                    const t = translations[currentLang] || translations['en'];
                    const label = t.hook_auto_score_label || 'Auto-seleccionado — puntaje';
                    let detail = `🎯 ${label}: ${hook.score}`;
                    if (hook.hasCJK) detail += ' · CJK';
                    if (hook.qualityPenalty > 0) detail += ` · -${hook.qualityPenalty} ${t.hook_quality_penalty_label || 'calidad'}`;
                    scoreEl.textContent = detail;
                    scoreEl.classList.remove('hidden');
                } else if (scoreEl) {
                    scoreEl.classList.add('hidden');
                }
            } else {
                previewDiv.classList.add('hidden');
            }
        }

        function updateHookSelector(data) {
            // data = { hooks, selectedHookKey, autoSelectedHookKey, activeHookKey, totalHooks, noRealHookFound }
            // v3.13.85 (Fase C2): `gameEngine` used to ride on this same
            // payload (v3.13.76) — now its own push, see onGameEngineAdvice.
            _discoveredHooks = data.hooks || [];
            const section = document.getElementById('hook-selector-section');
            const selector = document.getElementById('hook-selector');
            const countBadge = document.getElementById('hook-count-badge');
            const noRealWarning = document.getElementById('hook-no-real-warning');

            // Show section if there are hooks
            if (_discoveredHooks.length > 0) {
                section.classList.remove('hidden');
            }

            // v3.13.24: only Console/Clipboard seen so far — Tuhua isn't
            // silently translating that as if it were game text (see
            // _autoSelectBestHook's guard), so make that visible instead of
            // the panel just looking idle with no explanation.
            if (noRealWarning) {
                noRealWarning.classList.toggle('hidden', !data.noRealHookFound);
            }

            countBadge.textContent = _discoveredHooks.length + ' hook' + (_discoveredHooks.length !== 1 ? 's' : '');

            // Build options — v3.8.24: improved display with preview text
            const currentVal = selector.value;
            selector.innerHTML = '<option value="">🔄 Auto (seleccionar mejor hook)</option>';

            for (const hook of _discoveredHooks) {
                const opt = document.createElement('option');
                opt.value = hook.key;

                // Build display label — use displayName (which includes hook index + code)
                let label = hook.displayName || hook.name;

                // Add quality indicator
                if (hook.qualityPenalty === 0 && hook.textCount > 1) {
                    label += ' ✓';  // Clean text
                } else if (hook.qualityPenalty >= 600) {
                    label += ' ⚠'; // Noisy hook
                }

                // Add CJK indicator
                if (hook.hasCJK) label += ' 🎌';

                // Add text count
                label += ` (${hook.textCount})`;

                // Add text preview (first 50 chars, cleaned)
                if (hook.lastText) {
                    const preview = hook.lastText.substring(0, 50).replace(/\n/g, ' ').trim();
                    if (preview) {
                        label += ` — "${preview}${hook.lastText.length > 50 ? '…' : ''}"`;
                    }
                }

                // Mark active
                if (hook.key === data.activeHookKey) label += ' ★';

                opt.textContent = label;

                // Mark as selected if it's the active hook
                if (hook.key === data.selectedHookKey || (hook.key === data.activeHookKey && !data.selectedHookKey)) {
                    opt.selected = true;
                }

                selector.appendChild(opt);
            }

            // If user manually selected, keep their selection
            if (data.selectedHookKey) {
                selector.value = data.selectedHookKey;
            } else {
                selector.value = ''; // Auto mode
            }

            // Update preview for active hook
            const activeHook = _discoveredHooks.find(h => h.key === data.activeHookKey);
            if (activeHook) {
                updateHookPreview(activeHook, !data.selectedHookKey);
            }
        }

        // v3.13.76: paint (or re-paint, e.g. on a language change) the
        // proactive game-engine advisory from _lastEngineAdvice. Split out of
        // updateHookSelector so changeLanguage() can call it too — the text
        // is computed (has a runtime {engine}/{method} substitution), not
        // [data-i18n], so a language switch would otherwise leave it stuck in
        // whatever language it was first painted in.
        function renderEngineAdvice() {
            const box = document.getElementById('engine-advice');
            const textEl = document.getElementById('engine-advice-text');
            const btn = document.getElementById('engine-advice-action');
            if (!box || !textEl || !btn) return;

            const advice = _lastEngineAdvice;
            if (!advice || !advice.adviceKey) {
                box.classList.add('hidden');
                return;
            }

            const t = translations[currentLang] || translations['en'];
            const template = t[advice.adviceKey];
            if (!template) {
                box.classList.add('hidden');
                return;
            }
            textEl.textContent = template.replace('{engine}', advice.engineLabel || advice.engine || '');
            box.classList.remove('hidden');

            if (advice.recommendedMethod && advice.recommendedMethod !== currentInputMethod) {
                const methodLabel = t['method_' + advice.recommendedMethod] || advice.recommendedMethod;
                const btnTemplate = t.engine_advice_switch_btn || '→ Switch to {method}';
                btn.textContent = btnTemplate.replace('{method}', methodLabel);
                btn.classList.remove('hidden');
            } else {
                btn.classList.add('hidden');
            }
        }

        // v3.13.76: the advisory's action button — always an explicit click,
        // never an automatic switch (Lyca's requirement: suggest, don't
        // decide for the user).
        function applyEngineAdvice() {
            const method = _lastEngineAdvice && _lastEngineAdvice.recommendedMethod;
            if (!method) return;
            setInputMethod(method); // already persists via api.saveSettings({inputMethod})
            const box = document.getElementById('engine-advice');
            if (box) box.classList.add('hidden');
        }

        // v3.13.79 (Fase 3, round-3 plan): paint (or re-paint, e.g. on a
        // language change) the OCR-engine advisory from _lastOcrEngineAdvice.
        // Split out the same way renderEngineAdvice() is, for the same
        // reason — the text has a runtime {method} substitution, not
        // [data-i18n], so a language switch would leave it stuck in
        // whatever language it was first painted in.
        function renderOcrEngineAdvice() {
            const box = document.getElementById('ocr-engine-advice');
            const textEl = document.getElementById('ocr-engine-advice-text');
            const btn = document.getElementById('ocr-engine-advice-action');
            if (!box || !textEl || !btn) return;

            const advice = _lastOcrEngineAdvice;
            // Already on Paddle (e.g. the user clicked through, or changed
            // it themselves elsewhere) — nothing left to suggest.
            const currentEngine = document.getElementById('ocr-engine-select');
            if (!advice || (currentEngine && currentEngine.value === 'paddle')) {
                box.classList.add('hidden');
                return;
            }

            const t = translations[currentLang] || translations['en'];
            const template = t.ocr_advice_try_paddle;
            if (!template) {
                box.classList.add('hidden');
                return;
            }
            textEl.textContent = template;
            box.classList.remove('hidden');

            const btnTemplate = t.engine_advice_switch_btn || '→ Switch to {method}';
            btn.textContent = btnTemplate.replace('{method}', 'PaddleOCR');
        }

        // v3.13.79 (Fase 3, round-3 plan): explicit click only, never an
        // automatic switch — same rule v3.13.76's applyEngineAdvice()
        // follows (Lyca's requirement: suggest, don't decide for the user).
        function applyOcrEngineAdvice() {
            // setOcrEngine() is normally driven by the <select>'s onchange,
            // where the DOM value has already moved before the handler
            // runs — calling it directly here needs that same update done
            // by hand, or the dropdown would silently keep showing
            // "Tesseract" while the engine underneath is actually Paddle.
            const selectEl = document.getElementById('ocr-engine-select');
            if (selectEl) selectEl.value = 'paddle';
            setOcrEngine('paddle'); // already persists via the existing setOcrEngine() path
            const box = document.getElementById('ocr-engine-advice');
            if (box) box.classList.add('hidden');
            _lastOcrEngineAdvice = null;
        }

        // ===== HELPERS =====
        function escapeHtml(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // ===== OCR FUNCTIONS =====
        // OCR starts/stops from the main ▶ Activo toggle button.
        // No separate button — when OCR is the input method, the main toggle controls it.
        let ocrSessionActive = false;

        async function startOcrSession() {
            const statusText = document.getElementById('ocr-status-text');
            const t = translations[currentLang] || translations['en'];

            if (statusText) statusText.textContent = t.ocr_loading_worker || 'Cargando motor OCR...';

            try {
                // Start OCR — backend uses source language setting automatically
                const result = await api.ocrStart();

                if (result.success) {
                    ocrSessionActive = true;
                    if (statusText) statusText.textContent = t.ocr_auto_active || 'OCR activo — posiciona el área de captura';
                } else {
                    if (statusText) statusText.textContent = result.error || 'Error al iniciar';
                    // Auto-revert the toggle since OCR failed
                    translationActive = false;
                    api.saveSettings({ translationActive: false });
                    updateToggleUI();
                }
            } catch (err) {
                if (statusText) statusText.textContent = err.message;
                translationActive = false;
                api.saveSettings({ translationActive: false });
                updateToggleUI();
            }
        }

        async function stopOcrSession() {
            const statusText = document.getElementById('ocr-status-text');

            await api.ocrStop();
            ocrSessionActive = false;
            if (statusText) statusText.textContent = '';
        }

        function updateOcrStatus(status) {
            const statusText = document.getElementById('ocr-status-text');
            const t = translations[currentLang] || translations['en'];
            if (!statusText) return;

            switch (status) {
                case 'initializing':
                    statusText.textContent = t.ocr_loading_worker || 'Cargando motor OCR...';
                    break;
                case 'ready':
                case 'auto-capturing':
                    statusText.textContent = t.ocr_auto_active || 'OCR activo — posiciona el área de captura';
                    break;
                case 'recognizing':
                    statusText.textContent = t.ocr_recognizing || 'Reconociendo texto...';
                    break;
                case 'error':
                    statusText.textContent = t.ocr_error || 'Error en OCR';
                    break;
                case 'terminated':
                    statusText.textContent = '';
                    break;
            }
        }

        // ===== OCR ENGINE SELECTOR =====
        // v3.13.01: Switch between Tesseract and PaddleOCR
        async function setOcrEngine(engine) {
            const descEl = document.getElementById('ocr-engine-desc');
            const t = translations[currentLang] || translations['en'];

            if (engine === 'paddle') {
                // Check availability first
                const status = await api.getOcrEngineStatus();
                if (!status.paddleAvailable) {
                    // PaddleOCR not available — revert to tesseract
                    const selectEl = document.getElementById('ocr-engine-select');
                    if (selectEl) selectEl.value = 'tesseract';
                    if (descEl) descEl.textContent = t.ocr_paddle_not_available || 'PaddleOCR no disponible (onnxruntime-node no instalado)';
                    return;
                }
                if (descEl) descEl.textContent = t.ocr_engine_paddle_desc || 'OCR de alta precisión para texto CJK';
            } else {
                if (descEl) descEl.textContent = t.ocr_engine_tesseract_desc || 'Motor OCR predeterminado. Funciona con todos los idiomas.';
            }

            await api.setOcrEngine(engine);
        }

        async function loadOcrEngineStatus() {
            const selectEl = document.getElementById('ocr-engine-select');
            const paddleOption = document.getElementById('ocr-engine-paddle-option');
            const descEl = document.getElementById('ocr-engine-desc');
            const t = translations[currentLang] || translations['en'];

            try {
                const status = await api.getOcrEngineStatus();
                // Set current engine in selector
                if (selectEl) selectEl.value = status.current || 'tesseract';
                // Disable PaddleOCR option if not available
                if (paddleOption && !status.paddleAvailable) {
                    paddleOption.disabled = true;
                    paddleOption.textContent = (t.ocr_engine_paddle || 'PaddleOCR') + ' (N/A)';
                }
                // Show appropriate description
                if (status.current === 'paddle') {
                    if (descEl) descEl.textContent = t.ocr_engine_paddle_desc || 'OCR de alta precisión para texto CJK';
                } else {
                    if (descEl) descEl.textContent = t.ocr_engine_tesseract_desc || 'Motor OCR predeterminado. Funciona con todos los idiomas.';
                }
            } catch (err) {
                console.warn('[Tuhua] Could not load OCR engine status:', err);
            }
        }

        // ===== XUAT =====
        let xuatServerRunning = false;

        async function toggleXuatServer() {
            // v3.11.3: Disable button while operation is in progress
            const btnEl = document.getElementById('xuat-toggle-btn');
            const prevText = btnEl.textContent;
            btnEl.disabled = true;
            btnEl.textContent = '...';

            try {
                if (xuatServerRunning) {
                    const result = await api.xuatStopServer();
                    if (!result.success) {
                        showToast('Error al detener: ' + (result.error || 'Desconocido'));
                    }
                } else {
                    const port = parseInt(document.getElementById('xuat-port').value) || 8419;
                    const result = await api.xuatStartServer(port);
                    if (!result.success) {
                        showToast('Error al iniciar: ' + (result.error || 'Desconocido'));
                    }
                }
            } catch (err) {
                showToast('Error: ' + (err.message || 'Desconocido'));
            }
            // Always refresh status from server after toggle
            await updateXuatStatus();
            btnEl.disabled = false;
        }

        async function updateXuatStatus() {
            try {
                const status = await api.xuatGetStatus();
                xuatServerRunning = status.running;
                const statusEl = document.getElementById('xuat-server-status');
                const btnEl = document.getElementById('xuat-toggle-btn');
                if (status.running) {
                    statusEl.textContent = `✓ Activo (puerto ${status.port})`;
                    statusEl.className = 'text-[10px] text-emerald-500 ml-2';
                    btnEl.textContent = 'Detener';
                    btnEl.className = 'px-3 py-1.5 text-[10px] font-bold bg-red-600 hover:bg-red-500 text-white rounded-md transition';
                } else {
                    // v3.11.3: Show error message if present, or just 'Desactivado'
                    const errorMsg = status.error || '';
                    statusEl.textContent = errorMsg ? `✗ Error: ${errorMsg.substring(0, 50)}` : 'Desactivado';
                    statusEl.className = errorMsg ? 'text-[10px] text-red-500 ml-2' : 'text-[10px] text-gray-400 ml-2';
                    btnEl.textContent = 'Iniciar';
                    btnEl.className = 'px-3 py-1.5 text-[10px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition';
                }
                // v3.11.11: Show both endpoint ID and URL for clarity
                const port = status.port || parseInt(document.getElementById('xuat-port').value) || 8419;
                document.getElementById('xuat-endpoint-url').textContent = `Endpoint: Custom | URL: http://127.0.0.1:${port}/translate`;

                // v3.11.3: Sync the main play/pause toggle with XUAT server status
                // When in XUAT mode, the play/pause button controls the XUAT server
                // Also update the connection status badge to show XUAT mode
                if (currentInputMethod === 'xuat') {
                    translationActive = status.running;
                    updateToggleUI();
                    // v3.11.3 / v3.13.39: xuatServerRunning was already
                    // updated above (line ~2661) — recomputeBadge() derives
                    // xuat/disconnected from it the same way this used to.
                    recomputeBadge();
                }
            } catch (err) {
                console.error('[XUAT] Status check error:', err);
            }
        }

        function copyXuatUrl() {
            const port = parseInt(document.getElementById('xuat-port').value) || 8419;
            const url = `http://127.0.0.1:${port}/translate?text={0}&from={1}&to={2}`;
            navigator.clipboard.writeText(url);
            showToast('URL copiada al portapapeles');
        }

        async function testXuatEndpoint() {
            try {
                const result = await api.xuatTestEndpoint();
                if (result.success) {
                    showToast(`✓ Servidor XUAT funcionando (puerto ${result.status.port || 'desconocido'})`);
                } else {
                    showToast('✗ Servidor XUAT no responde: ' + (result.error || 'Error desconocido'));
                }
            } catch (err) {
                showToast('✗ Error al testear: ' + err.message);
            }
        }

        async function installXuat() {
            try {
                const result = await api.xuatSelectGame();
                if (!result || result.canceled || !result.filePath) return;

                const exePath = result.filePath;
                const detectResult = await api.xuatDetectGame(exePath);

                if (!detectResult.isUnity) {
                    showToast('No parece ser un juego Unity. XUAT solo funciona con juegos Unity.');
                    return;
                }

                // Show progress
                document.getElementById('xuat-install-progress').classList.remove('hidden');
                document.getElementById('xuat-install-status').textContent = 'Detectando juego...';
                document.getElementById('xuat-install-bar').style.width = '10%';

                const port = parseInt(document.getElementById('xuat-port').value) || 8419;
                const installResult = await api.xuatInstallInGame(exePath, port);

                if (installResult.success) {
                    document.getElementById('xuat-install-bar').style.width = '100%';
                    document.getElementById('xuat-install-status').textContent = '¡Instalación completa!';
                    // v3.11.2: Show backend type in success message
                    const backendLabel = installResult.isIL2CPP ? 'IL2CPP' : 'Mono';
                    showToast(`XUAT instalado correctamente. Inicia el juego para comenzar a traducir.`);
                    // Reset translation counter for new game
                    xuatTranslationCount = 0;
                    const countEl = document.getElementById('xuat-translation-count');
                    if (countEl) countEl.textContent = '0';
                    // Show persistent connection status
                    updateXuatConnectedGame(installResult.gameName || 'Juego', exePath, installResult.isIL2CPP);
                    setTimeout(() => {
                        document.getElementById('xuat-install-progress').classList.add('hidden');
                    }, 3000);
                } else {
                    document.getElementById('xuat-install-status').textContent = 'Error: ' + (installResult.error || 'Instalación fallida');
                    document.getElementById('xuat-install-bar').style.width = '0%';
                    showToast('Error al instalar XUAT: ' + (installResult.error || 'Desconocido'));
                }
            } catch (err) {
                showToast('Error: ' + err.message);
                document.getElementById('xuat-install-progress').classList.add('hidden');
            }
        }

        // v3.11.17: Clear XUAT translation cache
        async function clearXuatCache() {
            try {
                const result = await api.xuatClearCache();
                if (result.success) {
                    const t = translations[currentLang] || translations['en'];
                    showToast(t.cache_cleared || `Caché limpiada (${result.deleted} archivo(s) eliminado(s))`);
                } else {
                    showToast('Error: ' + (result.error || 'No se pudo limpiar la caché'));
                }
            } catch (err) {
                showToast('Error: ' + err.message);
            }
        }

        // v3.11.2: Added isIL2CPP parameter to show game backend type
        function updateXuatConnectedGame(gameName, gamePath, isIL2CPP) {
            const container = document.getElementById('xuat-connected-game');
            const nameEl = document.getElementById('xuat-connected-game-name');
            const backendEl = document.getElementById('xuat-game-backend');
            if (container && nameEl) {
                nameEl.textContent = gameName || 'Juego';
                container.classList.remove('hidden');
                // v3.11.2: Show game backend type
                if (backendEl) {
                    if (isIL2CPP !== undefined) {
                        backendEl.textContent = isIL2CPP ? '🔧 Backend: IL2CPP' : '🔧 Backend: Mono';
                        backendEl.classList.remove('hidden');
                    } else {
                        backendEl.classList.add('hidden');
                    }
                }
            }
        }

        // ===== REGEX TEXT FILTER (v3.11.30, fixed v3.11.33) =====
        // v3.13.8x (settings UX audit): the v3.11.33 staging arrays this
        // section used to declare here (stagedRegexToggles/-Adds/-Deletes/
        // -Edits, stagedEnableRegexFilter) are gone. Toggles are Tier A now
        // (see toggleRegexFilterMaster()/toggleRegexFilterEntry()); add/
        // edit/delete were already immediate elsewhere in this file
        // (saveNewRegexFilter()/saveEditedRegexFilter()/
        // deleteRegexFilterEntry()) and never actually populated
        // stagedRegexAdds/-Deletes/-Edits — those three were declared and
        // cleared on every save but written to nowhere, dead since before
        // this cleanup.
        let regexFilterEntries = [];

        /**
         * v3.11.32: Simple i18n translate helper.
         * Looks up a key in the current language's translations.
         * Returns the key itself if not found (as fallback).
         */
        function translate(key) {
            const t = translations[currentLang] || translations['en'];
            return t[key] || key;
        }

        // v3.13.21: HOOK cleaning step settings — five fixed, known toggles
        // (unlike regex filters' open-ended user list), so the checkboxes
        // already exist in the HTML with fixed IDs; this just sets their
        // state from the store instead of building DOM dynamically.
        async function loadHookCleaningSteps() {
            if (!api) {
                console.warn('[Tuhua] loadHookCleaningSteps: API not available');
                return;
            }
            try {
                const steps = await api.getHookCleaningSteps();
                for (const step of steps) {
                    const enableEl = document.getElementById('hook-clean-' + step.id);
                    if (enableEl) enableEl.checked = step.enabled;
                    if (step.supportsCjkOnly) {
                        const cjkEl = document.getElementById('hook-clean-cjk-' + step.id);
                        if (cjkEl) cjkEl.checked = step.cjkOnly;
                    }
                }
            } catch (err) {
                console.error('[Tuhua] loadHookCleaningSteps error:', err);
            }
        }

        async function toggleHookCleanStep(id, enabled) {
            await api.toggleHookCleaningStep(id, enabled);
        }

        async function toggleHookCleanCjkOnly(id, cjkOnly) {
            await api.setHookCleaningCjkOnly(id, cjkOnly);
        }

        async function resetHookCleaningSteps() {
            await api.resetHookCleaningSteps();
            await loadHookCleaningSteps();
        }

        async function loadRegexFilters() {
            if (!api) {
                console.warn('[Tuhua] loadRegexFilters: API not available');
                return;
            }
            try {
                regexFilterEntries = await api.getRegexFilters();
                console.log(`[Tuhua] Loaded ${regexFilterEntries.length} regex filters`);
                renderRegexFilterList();
            } catch (err) {
                console.error('[Tuhua] loadRegexFilters failed:', err);
                regexFilterEntries = [];
                renderRegexFilterList();
            }
            // Restore toggle state from settings
            try {
                const settings = await api.getSettings();
                const toggleEl = document.getElementById('enable-regex-filter');
                if (toggleEl) toggleEl.checked = settings.enableRegexFilter !== false;
            } catch (err) {
                console.error('[Tuhua] loadRegexFilters: Failed to restore toggle state:', err);
            }
        }

        function renderRegexFilterList() {
            const listEl = document.getElementById('regex-filter-list');
            if (!listEl) return;
            listEl.innerHTML = '';

            if (regexFilterEntries.length === 0) {
                listEl.innerHTML = '<p class="text-[9px] text-gray-400 italic text-center" data-i18n="regex_filter_empty">Sin filtros configurados.</p>';
                return;
            }

            // Sort: enabled first (by order), then disabled (by order)
            const sorted = [...regexFilterEntries].sort((a, b) => {
                if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
                return (a.order || 0) - (b.order || 0);
            });

            for (const entry of sorted) {
                try {
                    const displayName = entry.isBuiltIn ? translate(entry.name) : entry.name;
                    const row = document.createElement('div');
                    row.className = `flex items-center gap-1.5 p-1.5 rounded text-[10px] ${entry.enabled ? 'bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-800/20' : 'bg-gray-50/50 dark:bg-dark-900/50 opacity-70'}`;
                    row.dataset.filterId = entry.id;
                    const exampleHtml = entry.example ? `<span class="regex-tip" data-tooltip="${escapeHtml(entry.example)}"><span class="text-amber-400">ℹ️</span><span class="regex-tip-text">${escapeHtml(entry.example)}</span></span>` : (entry.isBuiltIn ? '<span class="text-[9px] text-amber-500/70 flex-shrink-0">⭐</span>' : '');
                    row.innerHTML = `
                        <label class="relative inline-flex items-center cursor-pointer flex-shrink-0">
                            <input type="checkbox" data-immediate="true" ${entry.enabled ? 'checked' : ''} onchange="toggleRegexFilterEntry('${entry.id}', this.checked)" class="sr-only peer">
                            <div class="w-5 h-3 bg-gray-300 dark:bg-dark-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:rounded-full after:h-2 after:w-2 after:transition-all peer-checked:bg-amber-500"></div>
                        </label>
                        <span class="flex-1 truncate ${entry.isBuiltIn ? 'text-amber-700 dark:text-amber-400 font-medium' : 'text-gray-700 dark:text-gray-300'}" title="${escapeHtml(entry.pattern)}">${escapeHtml(displayName)}</span>
                        ${exampleHtml}
                        ${!entry.isBuiltIn ? `<button onclick="editRegexFilter('${entry.id}')" class="text-blue-500 hover:text-blue-400 flex-shrink-0" title="Edit">✏️</button>` : ''}
                        ${!entry.isBuiltIn ? `<button onclick="deleteRegexFilterEntry('${entry.id}')" class="text-red-500 hover:text-red-400 flex-shrink-0" title="Delete">🗑️</button>` : ''}
                    `;
                    listEl.appendChild(row);
                } catch (err) {
                    console.error('[Tuhua] renderRegexFilterList: Error rendering entry:', entry.id, err);
                }
            }

            // v3.11.34: Attach JS-positioned tooltip listeners to .regex-tip elements
            listEl.querySelectorAll('.regex-tip').forEach(el => {
                el.addEventListener('mouseenter', showRegexTooltip);
                el.addEventListener('mouseleave', hideRegexTooltip);
            });
        }

        // v3.11.34: Fixed-position tooltip for filter examples
        // Uses position:fixed to avoid clipping by overflow containers
        function showRegexTooltip(e) {
            const tipEl = e.currentTarget;
            const tipText = tipEl.dataset.tooltip || (tipEl.querySelector('.regex-tip-text') || {}).textContent;
            if (!tipText) return;

            const tooltip = document.getElementById('global-tooltip');
            if (!tooltip) return;

            tooltip.textContent = tipText;
            tooltip.style.display = 'block';

            // Calculate position relative to viewport
            const rect = tipEl.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();

            // Position above the element
            let top = rect.top - tooltipRect.height - 6;
            let left = rect.left;

            // If tooltip goes above viewport, show below instead
            if (top < 4) {
                top = rect.bottom + 6;
            }

            // Ensure tooltip doesn't go off the right edge
            if (left + tooltipRect.width > window.innerWidth - 8) {
                left = window.innerWidth - tooltipRect.width - 8;
            }

            // Ensure tooltip doesn't go off the left edge
            if (left < 4) {
                left = 4;
            }

            tooltip.style.top = top + 'px';
            tooltip.style.left = left + 'px';
        }

        function hideRegexTooltip() {
            const tooltip = document.getElementById('global-tooltip');
            if (tooltip) tooltip.style.display = 'none';
        }

        // v3.13.8x (settings UX audit): Tier A now — applies immediately via
        // the same api.toggleRegexFilter() IPC the flush loop used to call
        // on Save. Used to stage into stagedRegexToggles (v3.11.33); see
        // this section's header comment for why that's gone.
        async function toggleRegexFilterEntry(id, enabled) {
            await api.toggleRegexFilter(id, enabled);
            // Update local state immediately for visual feedback
            const entry = regexFilterEntries.find(e => e.id === id);
            if (entry) entry.enabled = enabled;
            renderRegexFilterList();
        }

        function addRegexFilter() {
            // Show inline add form
            const listEl = document.getElementById('regex-filter-list');
            // Check if form already exists
            if (document.getElementById('regex-add-form')) return;

            const form = document.createElement('div');
            form.id = 'regex-add-form';
            form.className = 'p-2 rounded bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/30 space-y-1.5';
            form.innerHTML = `
                <div class="flex items-center justify-between">
                    <span class="text-[9px] font-bold text-emerald-600 dark:text-emerald-400" data-i18n="regex_filter_add_title">Agregar Filtro</span>
                    <button onclick="cancelRegexFilterAdd()" class="text-[9px] text-gray-400 hover:text-gray-300">✕</button>
                </div>
                <input id="regex-add-name" type="text" class="w-full p-1 rounded bg-white dark:bg-dark-900 border border-gray-200 dark:border-dark-600 text-[10px]" placeholder="Name (e.g. Remove color codes)">
                <input id="regex-add-pattern" type="text" class="w-full p-1 rounded bg-white dark:bg-dark-900 border border-gray-200 dark:border-dark-600 text-[10px] font-mono" placeholder="Pattern (e.g. \\\\c[\\d+])">
                <input id="regex-add-replacement" type="text" class="w-full p-1 rounded bg-white dark:bg-dark-900 border border-gray-200 dark:border-dark-600 text-[10px] font-mono" placeholder="Replacement (empty = remove)">
                <div class="flex items-center gap-3">
                    <label class="flex items-center gap-1 text-[9px] text-gray-500">
                        <input id="regex-add-regex" type="checkbox" checked class="w-3 h-3"> Regex
                    </label>
                    <label class="flex items-center gap-1 text-[9px] text-gray-500">
                        <input id="regex-add-case" type="checkbox" class="w-3 h-3"> Case-sensitive
                    </label>
                </div>
                <button onclick="saveNewRegexFilter()" class="w-full py-1 text-[9px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded transition" data-i18n="regex_filter_save_btn">Guardar</button>
            `;
            listEl.prepend(form);
        }

        function cancelRegexFilterAdd() {
            const form = document.getElementById('regex-add-form');
            if (form) form.remove();
        }

        async function saveNewRegexFilter() {
            const name = document.getElementById('regex-add-name').value.trim();
            const pattern = document.getElementById('regex-add-pattern').value;
            const replacement = document.getElementById('regex-add-replacement').value;
            const isRegex = document.getElementById('regex-add-regex').checked;
            const isCaseSensitive = document.getElementById('regex-add-case').checked;

            if (!pattern) {
                showToast(translate('regex_filter_error_no_pattern') || 'Pattern is required');
                return;
            }

            // Validate regex
            if (isRegex) {
                try {
                    new RegExp(pattern);
                } catch (e) {
                    showToast(`${translate('regex_filter_error_invalid') || 'Invalid regex'}: ${e.message}`);
                    return;
                }
            }

            // v3.11.33: Save immediately — adding a filter is a concrete action
            const result = await api.saveRegexFilter({
                name: name || 'Custom Filter',
                pattern,
                replacement,
                isRegex,
                isCaseSensitive,
                enabled: true
            });

            if (result.success) {
                cancelRegexFilterAdd();
                await loadRegexFilters();
                // Auto-scroll to the newly added filter
                const newId = result.entry?.id;
                if (newId) {
                    const row = document.querySelector(`[data-filter-id="${newId}"]`);
                    if (row) {
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        row.classList.add('bg-emerald-50', 'dark:bg-emerald-900/20');
                        setTimeout(() => row.classList.remove('bg-emerald-50', 'dark:bg-emerald-900/20'), 2000);
                    }
                }
            }
        }

        function editRegexFilter(id) {
            const entry = regexFilterEntries.find(e => e.id === id);
            if (!entry || entry.isBuiltIn) return;

            // Replace the row with an edit form
            const listEl = document.getElementById('regex-filter-list');
            // Check if form already exists
            if (document.getElementById('regex-edit-form')) return;

            const form = document.createElement('div');
            form.id = 'regex-edit-form';
            form.className = 'p-2 rounded bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 space-y-1.5';
            form.innerHTML = `
                <div class="flex items-center justify-between">
                    <span class="text-[9px] font-bold text-blue-600 dark:text-blue-400" data-i18n="regex_filter_edit_title">Editar Filtro</span>
                    <button onclick="cancelRegexFilterEdit()" class="text-[9px] text-gray-400 hover:text-gray-300">✕</button>
                </div>
                <input id="regex-edit-name" type="text" value="${escapeHtml(entry.name)}" class="w-full p-1 rounded bg-white dark:bg-dark-900 border border-gray-200 dark:border-dark-600 text-[10px]">
                <input id="regex-edit-pattern" type="text" value="${escapeHtml(entry.pattern)}" class="w-full p-1 rounded bg-white dark:bg-dark-900 border border-gray-200 dark:border-dark-600 text-[10px] font-mono">
                <input id="regex-edit-replacement" type="text" value="${escapeHtml(entry.replacement)}" class="w-full p-1 rounded bg-white dark:bg-dark-900 border border-gray-200 dark:border-dark-600 text-[10px] font-mono">
                <div class="flex items-center gap-3">
                    <label class="flex items-center gap-1 text-[9px] text-gray-500">
                        <input id="regex-edit-regex" type="checkbox" ${entry.isRegex ? 'checked' : ''} class="w-3 h-3"> Regex
                    </label>
                    <label class="flex items-center gap-1 text-[9px] text-gray-500">
                        <input id="regex-edit-case" type="checkbox" ${entry.isCaseSensitive ? 'checked' : ''} class="w-3 h-3"> Case-sensitive
                    </label>
                </div>
                <button onclick="saveEditedRegexFilter('${entry.id}')" class="w-full py-1 text-[9px] font-bold bg-blue-600 hover:bg-blue-500 text-white rounded transition" data-i18n="regex_filter_save_btn">Guardar</button>
            `;
            listEl.prepend(form);
        }

        function cancelRegexFilterEdit() {
            const form = document.getElementById('regex-edit-form');
            if (form) form.remove();
        }

        async function saveEditedRegexFilter(id) {
            const name = document.getElementById('regex-edit-name').value.trim();
            const pattern = document.getElementById('regex-edit-pattern').value;
            const replacement = document.getElementById('regex-edit-replacement').value;
            const isRegex = document.getElementById('regex-edit-regex').checked;
            const isCaseSensitive = document.getElementById('regex-edit-case').checked;

            if (!pattern) {
                showToast(translate('regex_filter_error_no_pattern') || 'Pattern is required');
                return;
            }

            // Validate regex
            if (isRegex) {
                try {
                    new RegExp(pattern);
                } catch (e) {
                    showToast(`${translate('regex_filter_error_invalid') || 'Invalid regex'}: ${e.message}`);
                    return;
                }
            }

            // v3.11.33: Save immediately — editing a filter is a concrete action
            const result = await api.saveRegexFilter({
                id,
                name: name || 'Custom Filter',
                pattern,
                replacement,
                isRegex,
                isCaseSensitive,
                isBuiltIn: false
            });

            if (result.success) {
                cancelRegexFilterEdit();
                await loadRegexFilters();
            }
        }

        async function deleteRegexFilterEntry(id) {
            // v3.13.40-fix: window.confirm() → showConfirm() — same
            // Electron focus-loss bug documented on the profile delete
            // confirmation (see showConfirm's doc comment).
            const t = translations[currentLang] || translations['en'];
            const confirmed = await showConfirm(translate('regex_filter_confirm_delete') || 'Delete this filter?', t.dialog_confirm, t.dialog_cancel);
            if (!confirmed) return;
            // v3.11.33: Save immediately — deleting a filter is a concrete action
            await api.deleteRegexFilter(id);
            await loadRegexFilters();
        }

        async function resetRegexFilters() {
            const t = translations[currentLang] || translations['en'];
            const confirmed = await showConfirm(translate('regex_filter_confirm_reset') || 'Reset all filters to defaults? Custom filters will be removed.', t.dialog_confirm, t.dialog_cancel);
            if (!confirmed) return;
            await api.resetRegexFilters();
            await loadRegexFilters();
        }

        // v3.13.8x (settings UX audit): Tier A now, like the per-row
        // toggles in toggleRegexFilterEntry() — this master switch and its
        // rows are tuned by watching the live text stream while playing,
        // not something to stage behind a Save click. Used to defer via
        // stagedEnableRegexFilter (v3.11.33); that staging variable is gone.
        function toggleRegexFilterMaster() {
            api.saveSettings({ enableRegexFilter: document.getElementById('enable-regex-filter').checked });
        }

        function testRegexFilter() {
            const testArea = document.getElementById('regex-filter-test-area');
            testArea.classList.toggle('hidden');
            if (!testArea.classList.contains('hidden')) {
                document.getElementById('regex-test-input').focus();
            }
        }

        function closeRegexFilterTest() {
            document.getElementById('regex-filter-test-area').classList.add('hidden');
        }

        let regexTestDebounce = null;
        async function runRegexFilterTest() {
            clearTimeout(regexTestDebounce);
            regexTestDebounce = setTimeout(async () => {
                const text = document.getElementById('regex-test-input').value;
                if (!text) {
                    document.getElementById('regex-test-output').textContent = '';
                    document.getElementById('regex-test-steps').innerHTML = '';
                    return;
                }
                const result = await api.testRegexFilter(text);
                document.getElementById('regex-test-output').textContent = result.text;

                // Show step-by-step results
                const stepsEl = document.getElementById('regex-test-steps');
                if (result.steps && result.steps.length > 0) {
                    stepsEl.innerHTML = result.steps.map(step => {
                        const name = step.name.startsWith('regex_filter_') ? translate(step.name) : step.name;
                        const icon = step.changed ? '→' : '·';
                        const errorIcon = step.error ? '⚠️' : '';
                        return `<div class="${step.changed ? 'text-emerald-500' : 'text-gray-500'}">${icon} ${escapeHtml(name)}${errorIcon} ${step.error ? escapeHtml(step.error) : ''}</div>`;
                    }).join('');
                } else {
                    stepsEl.innerHTML = '';
                }
            }, 200);
        }

        // ===== INIT =====
        // v3.13.39: registered exactly once here — init() itself is
        // re-invoked on resetSettingsToDefaults()/loadProfile() and must
        // NOT re-register listeners each time (see registerIpcListeners's
        // doc for the bug this fixes).
        registerIpcListeners();
        init();
