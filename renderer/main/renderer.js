        const api = window.tuhuaAPI;
        let currentLang = 'es';
        let currentInputMethod = 'textractor';
        let glossaryEntries = [];
        let historyEntries = [];
        let profileList = [];
        let translationActive = true;
        // In-memory store for per-engine API keys (synced to settings on save)
        let engineApiKeys = { deepl: '', openai: '' };
        // v3.10.8: Staged changes — settings changes are held in the UI
        // until the user clicks "Aplicar y Guardar". Only operational
        // controls (play/pause, theme, language UI, Textractor) auto-save.
        let hasUnsavedChanges = false;
        // Staged glossary changes — entries added/deleted before save
        let stagedGlossaryAdds = [];    // entries to add on save
        let stagedGlossaryDeletes = []; // entry IDs to delete on save
        // Staged profile changes — profiles created/deleted before save
        let stagedProfileCreates = [];  // { name } — profiles to create on save
        let stagedProfileDeletes = [];  // profile names to delete on save

        // ===== INITIALIZATION =====
        async function init() {
            if (!api) { console.error('API not available - running outside Electron?'); return; }

            const settings = await api.getSettings();

            // Apply saved settings
            if (settings.uiLanguage) {
                document.getElementById('lang-select').value = settings.uiLanguage;
                changeLanguage(settings.uiLanguage);
            }
            applyTheme(settings.theme || 'dark');
            if (settings.engine) { document.getElementById('engine-select').value = settings.engine; toggleInputFields(); }
            // Restore API key based on current engine
            const savedEngine = settings.engine || 'google-free';
            // Populate in-memory engine API keys from settings
            if (settings.deeplKey) engineApiKeys.deepl = settings.deeplKey;
            if (settings.openaiKey) engineApiKeys.openai = settings.openaiKey;
            if (savedEngine === 'deepl') {
                document.getElementById('api-key').value = engineApiKeys.deepl || '';
                // v3.11.23: Restore DeepL formality setting
                if (settings.deeplFormality) {
                    document.getElementById('deepl-formality').value = settings.deeplFormality;
                }
            } else if (savedEngine === 'openai') {
                document.getElementById('api-key').value = engineApiKeys.openai || '';
            } else if (settings.apiKey) {
                document.getElementById('api-key').value = settings.apiKey;
            }
            // Track the current engine for per-engine key persistence
            document.getElementById('engine-select').dataset.prevEngine = savedEngine;
            if (settings.customEndpoint) document.getElementById('local-endpoint').value = settings.customEndpoint;
            if (settings.customModel) document.getElementById('local-model').value = settings.customModel;
            if (settings.libretranslateEndpoint) document.getElementById('libretranslate-endpoint').value = settings.libretranslateEndpoint;
            if (settings.customMTEndpoint) document.getElementById('custom-mt-endpoint').value = settings.customMTEndpoint;
            if (settings.customMTMethod) document.getElementById('custom-mt-method').value = settings.customMTMethod;
            if (settings.customMTBody) document.getElementById('custom-mt-body').value = settings.customMTBody;
            if (settings.customMTResponsePath) document.getElementById('custom-mt-response').value = settings.customMTResponsePath;
            if (settings.customMTAuthHeader) document.getElementById('custom-mt-auth').value = settings.customMTAuthHeader;
            if (settings.sourceLang) document.getElementById('source-lang').value = settings.sourceLang;
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
            if (settings.textractorPort) document.getElementById('textractor-port').value = settings.textractorPort;
            if (settings.textractorCliPath) document.getElementById('textractor-cli-path').value = settings.textractorCliPath;
            if (settings.manualTextractorMode) document.getElementById('manual-textractor-mode').checked = settings.manualTextractorMode;
            if (settings.debounceMs) { document.getElementById('debounce-range').value = settings.debounceMs; document.getElementById('debounce-val').innerText = settings.debounceMs + 'ms'; }
            if (settings.systemPrompt) document.getElementById('system-prompt').value = settings.systemPrompt;
            if (settings.maxContextHistory) { document.getElementById('context-range').value = settings.maxContextHistory; document.getElementById('context-val').innerText = settings.maxContextHistory; }
            if (settings.historyLimit) { document.getElementById('history-limit-range').value = settings.historyLimit; document.getElementById('history-limit-val').innerText = settings.historyLimit; }

            // Click-through toggle - restore from saved settings
            if (settings.clickThrough !== undefined) {
                document.getElementById('click-through-toggle').checked = settings.clickThrough;
            }

            // Per-Profile Glossary toggle - restore from saved settings
            if (settings.perProfileGlossary !== undefined) {
                document.getElementById('per-profile-glossary-toggle').checked = settings.perProfileGlossary;
            }

            // Cache settings for modal restore
            window._lastSettings = settings;

            // OCR settings - no UI settings to restore (uses source language, auto-capture by default)

            // Translation active toggle - restore from saved settings
            if (settings.translationActive !== undefined) {
                translationActive = settings.translationActive;
            }
            updateToggleUI();

            // Input method - apply from saved settings
            const savedInputMethod = settings.inputMethod || 'textractor';
            setInputMethod(savedInputMethod);

            // If starting in clipboard mode, update the status badge immediately
            if (savedInputMethod === 'clipboard') {
                updateConnectionStatus('watching');
            } else if (savedInputMethod === 'ocr') {
                updateConnectionStatus('ocr');
            }

            // Load tabs data
            loadGlossary();
            loadProfiles();

            // Listen for events
            api.onTextractorStatus((status) => updateConnectionStatus(status));
            api.onTranslationResult((data) => updateLiveTranslation(data));
            api.onTranslationError((data) => updateLiveError(data));
            api.onShortcutPressed((data) => handleShortcut(data));
            api.onTextractorCliStatusChanged((status) => updateCliStatus(status));
            api.onTextractorCliOutput((text) => appendCliOutput(text));
            api.onTextractorCliError((errorData) => showCliError(errorData));
            api.onHooksDiscovered((data) => updateHookSelector(data));
            api.onOcrStatus((status) => updateOcrStatus(status));

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
            let xuatTranslationCount = 0;
            api.onXuatTranslationRequest((data) => {
                xuatTranslationCount++;
                const counterEl = document.getElementById('xuat-translation-counter');
                const countEl = document.getElementById('xuat-translation-count');
                if (counterEl && countEl) {
                    counterEl.classList.remove('hidden');
                    countEl.textContent = xuatTranslationCount;
                }
            });

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
        }

        // ===== UNSAVED CHANGES TRACKER =====
        // v3.10.8: Mark that settings have been changed but not yet saved.
        // The "Aplicar y Guardar" button shows a visual indicator.
        function markUnsaved() {
            hasUnsavedChanges = true;
            const btn = document.getElementById('save-btn');
            if (btn) btn.classList.add('ring-2', 'ring-amber-400', 'ring-offset-1');
            const text = document.getElementById('save-btn-text');
            if (text) {
                const t = translations[currentLang] || translations['en'];
                text.innerText = t.unsaved_changes || 'Guardar Cambios *';
            }
        }

        function markSaved() {
            hasUnsavedChanges = false;
            stagedGlossaryAdds = [];
            stagedGlossaryDeletes = [];
            stagedProfileCreates = [];
            stagedProfileDeletes = [];
            const btn = document.getElementById('save-btn');
            if (btn) btn.classList.remove('ring-2', 'ring-amber-400', 'ring-offset-1');
            const text = document.getElementById('save-btn-text');
            if (text) {
                const t = translations[currentLang] || translations['en'];
                text.innerText = t.save_btn || 'Aplicar y Guardar';
            }
        }

        // ===== LANGUAGE =====
        function changeLanguage(lang) {
            currentLang = lang;
            const t = translations[lang] || translations['en'];
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (t[key]) el.innerText = t[key];
            });

            // Update language selector options (native name + translated name)
            const FLAGS = { auto: '🌐', ja: '🇯🇵', en: '🇺🇸', es: '🇪🇸', zh: '🇨🇳', ko: '🇰🇷', ru: '🇷🇺', pt: '🇧🇷', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', ar: '🇸🇦', th: '🇹🇭', vi: '🇻🇳', id: '🇮🇩', tr: '🇹🇷', nl: '🇳🇱', pl: '🇵🇱', uk: '🇺🇦', hi: '🇮🇳' };
            const NATIVE_NAMES = { auto: 'Auto-detect', ja: '日本語', en: 'English', es: 'Español', zh: '中文', ko: '한국어', ru: 'Русский', pt: 'Português', fr: 'Français', de: 'Deutsch', it: 'Italiano', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', tr: 'Türkçe', nl: 'Nederlands', pl: 'Polski', uk: 'Українська', hi: 'हिन्दी' };
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

            // Update engine description for new language (fixes stale description)
            updateEngineDescription();

            // Update the translation toggle button status text
            updateToggleUI();

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
        // v3.10.10: Discard all unsaved changes when switching tabs.
        // This ensures a clean state — only "Aplicar y Guardar" commits.
        function switchTab(name) {
            // Discard any unsaved changes before switching
            discardUnsavedChanges();

            document.querySelectorAll('[id^="tab-"]').forEach(el => {
                if (el.id.startsWith('tab-btn-')) return;
                el.classList.add('hidden');
            });
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById(`tab-${name}`).classList.remove('hidden');
            document.getElementById(`tab-btn-${name}`).classList.add('active');

            if (name === 'history') loadHistory();
            if (name === 'glossary') loadGlossary();
            if (name === 'profiles') loadProfiles();
        }

        // Discard all staged/unsaved changes and reload from backend
        async function discardUnsavedChanges() {
            if (!hasUnsavedChanges) return;

            // Clear staged glossary changes
            stagedGlossaryAdds = [];
            stagedGlossaryDeletes = [];

            // Clear staged profile changes
            stagedProfileCreates = [];
            stagedProfileDeletes = [];

            // Reload glossary from backend (removes locally-added entries)
            await loadGlossary();

            // Reload profiles from backend (removes locally-created, restores locally-deleted)
            await loadProfiles();

            // Restore settings UI from last saved state
            if (window._lastSettings) {
                const s = window._lastSettings;
                if (s.engine) { document.getElementById('engine-select').value = s.engine; toggleInputFields(); }
                if (s.sourceLang) document.getElementById('source-lang').value = s.sourceLang;
                if (s.targetLang) document.getElementById('target-lang').value = s.targetLang;
                updateTargetLangDisplay(s.targetLang || 'es');
            }

            markSaved();
        }

        // ===== SETTINGS MODAL =====
        // Collapsible category state
        const _settingsCatState = { overlay: true, translation: true, glossary: true };

        function toggleSettingsModal() {
            const modal = document.getElementById('settings-modal');
            if (modal) {
                const willShow = modal.classList.contains('hidden');
                modal.classList.toggle('hidden');
                if (willShow) {
                    // Restore current settings values to the modal controls
                    restoreSettingsModalValues();
                }
            }
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

        // Per-Profile Glossary Toggle
        function togglePerProfileGlossary(enabled) {
            // v3.10.8: Don't auto-save — mark as unsaved
            markUnsaved();
        }

        // Reset System Prompt to default
        function resetSystemPrompt() {
            document.getElementById('system-prompt').value = '';
            api.saveSettings({ systemPrompt: '' });
            const t = translations[currentLang] || translations['en'];
            showToast(t.prompt_reset || 'Prompt restablecido al valor por defecto');
        }

        // Apply settings from modal (saves everything)
        async function applySettingsModal() {
            const config = {
                outputFontSize: parseInt(document.getElementById('font-size-range').value),
                outputTheme: document.getElementById('output-theme').value,
                overlayFontFamily: getEffectiveFontFamily(),
                overlayFontMode: document.getElementById('overlay-font').value,
                customFontValue: document.getElementById('custom-font-input').value,
                overlayOpacity: parseInt(document.getElementById('opacity-range').value),
                clickThrough: document.getElementById('click-through-toggle').checked,
                debounceMs: parseInt(document.getElementById('debounce-range').value),
                systemPrompt: document.getElementById('system-prompt').value,
                maxContextHistory: parseInt(document.getElementById('context-range').value),
                historyLimit: parseInt(document.getElementById('history-limit-range').value),
                perProfileGlossary: document.getElementById('per-profile-glossary-toggle').checked
            };

            await api.saveSettings(config);

            // v3.10.10: Also apply staged glossary and profile changes
            for (const entry of stagedGlossaryAdds) {
                await api.saveGlossaryEntry({ source: entry.source, target: entry.target, mode: entry.mode });
            }
            for (const id of stagedGlossaryDeletes) {
                await api.deleteGlossaryEntry(id);
            }
            for (const p of stagedProfileCreates) {
                await api.createProfile({ name: p.name });
            }
            for (const name of stagedProfileDeletes) {
                await api.deleteProfile(name);
            }

            // Update active profile with new data
            await api.saveProfile({ name: activeProfile });
            loadProfiles();
            await loadGlossary();

            markSaved();

            const t = translations[currentLang] || translations['en'];
            const btnText = document.getElementById('settings-apply-text');
            const orig = btnText.innerText;
            btnText.innerText = '✓ ' + (t.saved_confirm || '¡Guardado!');
            setTimeout(() => btnText.innerText = orig, 1500);
        }

        // Reset all settings to defaults
        async function resetSettingsToDefaults() {
            const defaults = {
                engine: 'google-free',
                sourceLang: 'auto',
                targetLang: 'es',
                inputMethod: 'textractor',
                textractorPort: 9251,
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
                systemPrompt: '',
                clickThrough: false,
                perProfileGlossary: false
            };

            await api.saveSettings(defaults);

            // Re-initialize UI with defaults
            await init();

            const t = translations[currentLang] || translations['en'];
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
            portSection.style.display = method === 'textractor' ? '' : 'none';
            ocrSettingsSection.classList.toggle('hidden', method !== 'ocr');
            xuatSettingsSection.classList.toggle('hidden', method !== 'xuat');
            ocrDesc.classList.toggle('hidden', method !== 'ocr');
            xuatDesc.classList.toggle('hidden', method !== 'xuat');

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
                engineApiKeys.openai = currentApiKey;
                api.saveSettings({ openaiKey: currentApiKey });
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

            // v3.11.23: Show DeepL formality dropdown only when DeepL is selected
            const deeplFormalitySec = document.getElementById('deepl-formality-section');
            if (deeplFormalitySec) {
                deeplFormalitySec.classList.toggle('hidden', engine !== 'deepl');
            }

            // Load engine-specific API key after showing the right section
            if (engine === 'deepl') {
                document.getElementById('api-key').value = engineApiKeys.deepl || '';
            } else if (engine === 'openai') {
                document.getElementById('api-key').value = engineApiKeys.openai || '';
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
                default:
                    label = t.status_disconnected;
                    colorClass = 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/50';
            }

            badge.className = `flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${colorClass}`;
            const dot = status === 'connected' ? '<span class="w-1.5 h-1.5 rounded-full bg-current pulse-dot"></span>' : '<span class="w-1.5 h-1.5 rounded-full bg-current"></span>';
            badge.innerHTML = `${dot} <span>${label}</span>`;
        }

        // ===== LIVE TRANSLATION =====
        function updateLiveTranslation(data) {
            if (data.targetLang) {
                updateTargetLangDisplay(data.targetLang);
            }
            loadHistory();
        }

        function updateLiveError(data) {
            // Error handled silently — translation errors shown in overlay
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

        function showToast(message) {
            const existing = document.querySelector('.tuhua-toast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.className = 'tuhua-toast';
            toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:500;background:#1e293b;color:#10b981;border:1px solid rgba(16,185,129,0.3);transition:opacity 0.3s ease;pointer-events:none;';
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
        }

        // ===== CLICK THROUGH =====
        function toggleClickThrough(enabled) {
            // v3.10.8: Don't auto-save — mark as unsaved until "Aplicar y Guardar"
            markUnsaved();
        }

        function handleShortcut(data) {
            if (data.action === 'toggle-clickthrough') {
                const toggle = document.getElementById('click-through-toggle');
                toggle.checked = data.state;
                // Also save the new state so it persists
                api.saveSettings({ clickThrough: data.state });
            }
        }

        // ===== FONT FAMILY =====
        // Map source languages to recommended font stacks
        const FONT_AUTO_DETECT_MAP = {
            'ja': "'Meiryo', 'MS Gothic', 'Noto Sans JP', sans-serif",
            'zh': "'Noto Sans SC', 'Microsoft YaHei', 'MingLiu', sans-serif",
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

            // Note: settings are saved when the user clicks "Apply" in the modal
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

        // ===== AUTO-SAVE LANGUAGE =====
        function autoSaveLanguage() {
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
            markUnsaved();
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

            statusEl.innerHTML = `${icon}<span>${escapeHtml(result.message)}</span>`;
        }

        async function validateApiKey() {
            const engine = document.getElementById('engine-select').value;
            const apiKey = document.getElementById('api-key').value.trim();
            const statusEl = document.getElementById('api-key-status');
            const inputEl = document.getElementById('api-key');
            const containerEl = document.getElementById('api-key-section');

            if (!apiKey) {
                setValidationStatus(statusEl, inputEl, containerEl, { valid: false, message: 'Ingresa una API Key primero' });
                return;
            }

            // Show loading state
            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Validando...</span>';

            const result = await api.validateApiKey(engine, apiKey);
            setValidationStatus(statusEl, inputEl, containerEl, result);
        }

        async function validateLocalEndpoint() {
            const endpoint = document.getElementById('local-endpoint').value.trim();
            const statusEl = document.getElementById('local-endpoint-status');
            const inputEl = document.getElementById('local-endpoint');

            if (!endpoint) {
                setValidationStatus(statusEl, inputEl, null, { valid: false, message: 'Ingresa un endpoint primero' });
                return;
            }

            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Validando...</span>';

            const result = await api.validateApiKey('local-llm', '', endpoint);
            setValidationStatus(statusEl, inputEl, null, result);
        }

        async function validateLibreTranslate() {
            const endpoint = document.getElementById('libretranslate-endpoint').value.trim();
            const statusEl = document.getElementById('libretranslate-status');
            const inputEl = document.getElementById('libretranslate-endpoint');

            if (!endpoint) {
                setValidationStatus(statusEl, inputEl, null, { valid: false, message: 'Ingresa un endpoint primero' });
                return;
            }

            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Validando...</span>';

            const result = await api.validateApiKey('libretranslate', '', endpoint);
            setValidationStatus(statusEl, inputEl, null, result);
        }

        async function validateCustomMT() {
            const endpoint = document.getElementById('custom-mt-endpoint').value.trim();
            const statusEl = document.getElementById('custom-mt-status');
            const inputEl = document.getElementById('custom-mt-endpoint');

            if (!endpoint) {
                setValidationStatus(statusEl, inputEl, null, { valid: false, message: 'Ingresa un endpoint primero' });
                return;
            }

            statusEl.classList.remove('hidden');
            statusEl.className = 'flex items-center gap-1.5 text-[11px] font-medium mt-1 text-gray-400';
            statusEl.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Validando...</span>';

            const result = await api.validateApiKey('custom-mt', '', endpoint);
            setValidationStatus(statusEl, inputEl, null, result);
        }

        function autoSaveEngine() {
            // Save the current API key to the previous engine before switching
            const prevEngine = document.getElementById('engine-select').dataset.prevEngine;
            const currentApiKey = document.getElementById('api-key').value;
            if (prevEngine === 'deepl' && currentApiKey) {
                engineApiKeys.deepl = currentApiKey;
            } else if (prevEngine === 'openai' && currentApiKey) {
                engineApiKeys.openai = currentApiKey;
            }

            toggleInputFields(); // Still toggle visibility of engine-specific fields
            // v3.10.8: Don't auto-save engine — mark as unsaved until "Aplicar y Guardar"
            markUnsaved();
        }

        // v3.11.23: Auto-save DeepL formality setting
        function autoSaveDeepLFormality() {
            const formality = document.getElementById('deepl-formality').value;
            api.saveSettings({ deeplFormality: formality });
            // Also update the engine instance if it exists
            // (pipeline will recreate engines on next settings update)
            markUnsaved();
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
                glossaryEntries = await api.getGlossary();
                renderGlossary();
            } catch (e) { console.error('Failed to load glossary:', e); }
        }

        function renderGlossary() {
            const list = document.getElementById('glossary-list');
            if (!glossaryEntries.length) {
                const t = translations[currentLang] || translations['en'];
                list.innerHTML = `<p class="text-xs text-gray-400 text-center py-4">${t.glossary_empty}</p>`;
                return;
            }

            list.innerHTML = glossaryEntries.map(entry => `
                <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-dark-900/50 border border-gray-200 dark:border-dark-600 text-xs">
                    <div class="flex-1 min-w-0">
                        <span class="font-mono text-gray-700 dark:text-gray-200 truncate block">${escapeHtml(entry.source)}</span>
                        <span class="text-emerald-600 dark:text-emerald-400 truncate block">→ ${escapeHtml(entry.target)}</span>
                    </div>
                    <span class="text-[9px] text-gray-400 px-1 py-0.5 bg-gray-100 dark:bg-dark-700 rounded">${entry.mode}</span>
                    <button onclick="deleteGlossaryEntry('${entry.id}')" class="text-red-400 hover:text-red-500 transition p-1">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                    </button>
                </div>
            `).join('');
        }

        async function addGlossaryEntry() {
            const source = document.getElementById('glossary-source').value.trim();
            const target = document.getElementById('glossary-target').value.trim();
            const mode = document.getElementById('glossary-mode').value;
            if (!source || !target) return;

            // v3.10.10: Stage the entry — only persisted on "Aplicar y Guardar"
            const tempId = 'staged_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
            // Check if same entry already staged to prevent duplicates
            const alreadyStaged = stagedGlossaryAdds.some(e => e.source === source && e.target === target && e.mode === mode);
            if (!alreadyStaged) {
                stagedGlossaryAdds.push({ id: tempId, source, target, mode, enabled: true, createdAt: Date.now() });
                // Show in UI immediately (local render)
                glossaryEntries.push({ id: tempId, source, target, mode, enabled: true, createdAt: Date.now() });
                renderGlossary();
            }
            document.getElementById('glossary-source').value = '';
            document.getElementById('glossary-target').value = '';
            markUnsaved();
        }

        async function deleteGlossaryEntry(id) {
            // v3.10.8: Stage the deletion — only persisted on "Aplicar y Guardar"
            // If it's a staged add, just remove from staged adds and local list
            const stagedIdx = stagedGlossaryAdds.findIndex(e => e.id === id);
            if (stagedIdx >= 0) {
                stagedGlossaryAdds.splice(stagedIdx, 1);
            } else {
                // It's a persisted entry — stage for deletion
                stagedGlossaryDeletes.push(id);
            }
            // Remove from local display immediately
            glossaryEntries = glossaryEntries.filter(e => e.id !== id);
            renderGlossary();
            markUnsaved();
        }

        async function importGlossary() {
            // Trigger file dialog via main process
            // For now, prompt for file path
            const path = prompt('Enter JSON file path to import:');
            if (path) {
                const result = await api.importGlossary(path);
                if (result.success) loadGlossary();
                else alert('Import failed: ' + result.error);
            }
        }

        async function exportGlossary() {
            const path = prompt('Enter file path to export:');
            if (path) {
                const result = await api.exportGlossary(path);
                if (result.success) alert(`Exported ${result.exported} entries`);
            }
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

        async function exportHistory() {
            const path = prompt('Enter file path to export:');
            if (path) {
                const result = await api.exportHistory(path);
                if (result.success) alert(`Exported ${result.count} entries`);
            }
        }

        // ===== PROFILES =====
        let activeProfile = 'Por Defecto';

        async function loadProfiles() {
            try {
                const result = await api.getProfiles();
                // v3.10.7: get-profiles now returns { profiles, activeProfile }
                profileList = result.profiles || result;
                activeProfile = result.activeProfile || 'Por Defecto';
                renderProfiles();
            } catch (e) { console.error('Failed to load profiles:', e); }
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
                const langPair = (profile.sourceLang || 'auto') + ' → ' + (profile.targetLang || 'es');
                const inputMethod = profile.inputMethod || 'textractor';
                const isActive = profile.name === activeProfile;
                const isDefault = profile.isDefault || profile.name === 'Por Defecto';
                const isStaged = profile._staged === true;
                const borderClass = isStaged ? 'border-amber-400 dark:border-amber-600 border-dashed' : (isActive ? 'border-emerald-400 dark:border-emerald-600' : 'border-gray-200 dark:border-dark-600');
                const bgClass = isStaged ? 'bg-amber-50 dark:bg-amber-900/10' : (isActive ? 'bg-emerald-50 dark:bg-emerald-900/10' : 'bg-gray-50 dark:bg-dark-900/50');

                return `
                <div class="p-2.5 rounded-lg ${bgClass} border ${borderClass} space-y-1.5">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5">
                            ${isActive ? '<span class="w-2 h-2 rounded-full bg-emerald-500 pulse-dot"></span>' : ''}
                            <span class="text-sm font-medium ${isActive ? 'text-emerald-700 dark:text-emerald-300' : ''}">${escapeHtml(profile.name)}</span>
                            ${isDefault ? '<span class="text-[8px] bg-gray-200 dark:bg-dark-600 text-gray-500 dark:text-gray-400 px-1 py-0.5 rounded font-bold uppercase">Default</span>' : ''}
                            ${isStaged ? '<span class="text-[8px] bg-amber-200 dark:bg-amber-800 text-amber-700 dark:text-amber-300 px-1 py-0.5 rounded font-bold uppercase">Nuevo</span>' : ''}
                        </div>
                        <div class="flex gap-1">
                            ${!isActive && !isStaged ? `<button onclick="loadProfile('${escapeHtml(profile.name)}')" class="px-2.5 py-1 text-[10px] font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded transition" data-i18n="profile_load">Cargar</button>` : ''}
                            ${!isDefault ? `<button onclick="deleteProfile('${escapeHtml(profile.name)}')" class="px-2.5 py-1 text-[10px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition" data-i18n="profile_delete">Eliminar</button>` : ''}
                        </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5 text-[9px] text-gray-400">
                        ${glossaryCount > 0 ? `<span class="bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 px-1.5 py-0.5 rounded">📖 ${glossaryCount}</span>` : ''}
                        ${historyCount > 0 ? `<span class="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-1.5 py-0.5 rounded">📋 ${historyCount}</span>` : ''}
                        <span class="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">${langPair}</span>
                        <span class="bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">${engineName}</span>
                        <span class="bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">${inputMethod}</span>
                        ${savedDate ? `<span>${savedDate}</span>` : ''}
                    </div>
                </div>`;
            }).join('');

            updateActiveProfileIndicator();
        }

        function updateActiveProfileIndicator() {
            const indicator = document.getElementById('active-profile-indicator');
            if (indicator) {
                indicator.textContent = activeProfile;
            }
        }

        async function saveProfile() {
            // v3.10.10: This function is no longer used as a standalone action.
            // Profile saving is now handled by "Aplicar y Guardar" (saveConfig).
            // Kept for reference but redirects to saveConfig.
            await saveConfig();
        }

        async function createNewProfile() {
            const name = document.getElementById('profile-name').value.trim();
            if (!name) return;

            // v3.10.10: Stage the profile creation — only persisted on "Aplicar y Guardar"
            // Check if name already exists in real profiles or staged creates
            const existsInBackend = profileList.some(p => p.name === name);
            const existsInStaged = stagedProfileCreates.some(p => p.name === name);
            if (existsInBackend || existsInStaged) {
                const t = translations[currentLang] || translations['en'];
                showToast(t.profile_name_exists || 'Ya existe un perfil con ese nombre');
                return;
            }

            stagedProfileCreates.push({ name });

            // Show in UI immediately as a local-only profile card
            profileList.push({
                name,
                isDefault: false,
                sourceLang: document.getElementById('source-lang').value,
                targetLang: document.getElementById('target-lang').value,
                inputMethod: currentInputMethod,
                engine: document.getElementById('engine-select').value,
                glossary: [],
                history: [],
                savedAt: null,  // null = not yet saved
                _staged: true
            });
            renderProfiles();
            document.getElementById('profile-name').value = '';
            markUnsaved();
        }

        // v3.10.10: saveCurrentProfile removed — "Guardar Actual" button removed.
        // All saving is now done via "Aplicar y Guardar" (saveConfig).

        async function loadProfile(name) {
            const result = await api.loadProfile(name);
            if (result.success) {
                activeProfile = result.activeProfile || name;
                // v3.10.8: Clear staged changes when switching profiles
                // (init() re-reads from backend, so staged changes are discarded)
                stagedGlossaryAdds = [];
                stagedGlossaryDeletes = [];
                markSaved();
                // Re-apply settings to UI and refresh all tabs
                await init();
                loadGlossary();
                loadHistory();
            }
        }

        async function deleteProfile(name) {
            if (name === 'Por Defecto') {
                const t = translations[currentLang] || translations['en'];
                showToast(t.cannot_delete_default || 'No se puede eliminar el perfil por defecto');
                return;
            }

            // v3.10.10: Stage the deletion — only persisted on "Aplicar y Guardar"
            // If it's a staged create, just remove from staged creates and local list
            const stagedIdx = stagedProfileCreates.findIndex(p => p.name === name);
            if (stagedIdx >= 0) {
                stagedProfileCreates.splice(stagedIdx, 1);
            } else {
                // It's a persisted profile — stage for deletion
                stagedProfileDeletes.push(name);
            }

            // Remove from local display immediately
            profileList = profileList.filter(p => p.name !== name);
            if (activeProfile === name) {
                activeProfile = 'Por Defecto';
            }
            renderProfiles();
            markUnsaved();
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

        // ===== TEST CONNECTION =====
        async function testConnection() {
            const port = parseInt(document.getElementById('textractor-port').value);
            const result = await api.testConnection('127.0.0.1', port);
            const span = document.getElementById('connection-test-result');
            const t = translations[currentLang] || translations['en'];
            if (result.success) {
                span.innerHTML = `<span class="text-emerald-500">✓ ${t.connection_ok}</span>`;
                // Auto-save the port when test succeeds so it's used on launch
                api.saveSettings({ textractorPort: port });
                console.log('[Tuhua] Port auto-saved after successful test:', port);
            } else {
                span.innerHTML = `<span class="text-red-500">✗ ${t.connection_fail}</span>`;
            }
            setTimeout(() => span.innerHTML = '', 3000);
        }

        // ===== GATHER CONFIG =====
        function gatherConfig() {
            return {
                engine: document.getElementById('engine-select').value,
                apiKey: document.getElementById('api-key').value,
                sourceLang: document.getElementById('source-lang').value,
                targetLang: document.getElementById('target-lang').value,
                outputFontSize: parseInt(document.getElementById('font-size-range').value),
                outputTheme: document.getElementById('output-theme').value,
                overlayFontFamily: getEffectiveFontFamily(),
                overlayFontMode: document.getElementById('overlay-font').value,
                customFontValue: document.getElementById('custom-font-input').value,
                overlayOpacity: parseInt(document.getElementById('opacity-range').value),
                localEndpoint: document.getElementById('local-endpoint').value,
                localModel: document.getElementById('local-model').value,
                textractorPort: parseInt(document.getElementById('textractor-port').value),
                textractorCliPath: document.getElementById('textractor-cli-path').value.trim(),
                manualTextractorMode: document.getElementById('manual-textractor-mode').checked,
                inputMethod: currentInputMethod,
                debounceMs: parseInt(document.getElementById('debounce-range').value),
                systemPrompt: document.getElementById('system-prompt').value,
                maxContextHistory: parseInt(document.getElementById('context-range').value),
                historyLimit: parseInt(document.getElementById('history-limit-range').value),
                libretranslateEndpoint: document.getElementById('libretranslate-endpoint').value,
                customMTEndpoint: document.getElementById('custom-mt-endpoint').value,
                customMTMethod: document.getElementById('custom-mt-method').value,
                customMTBody: document.getElementById('custom-mt-body').value,
                customMTResponsePath: document.getElementById('custom-mt-response').value,
                customMTAuthHeader: document.getElementById('custom-mt-auth').value,
                clickThrough: document.getElementById('click-through-toggle').checked,
                perProfileGlossary: document.getElementById('per-profile-glossary-toggle').checked,
                uiLanguage: currentLang,
                xuatPort: parseInt(document.getElementById('xuat-port').value) || 8419
            };
        }

        // ===== SAVE =====
        async function saveConfig() {
            const config = gatherConfig();
            // Map fields for backend compatibility
            if (config.engine === 'deepl') config.deeplKey = config.apiKey;
            if (config.engine === 'openai') { config.openaiKey = config.apiKey; config.openaiModel = 'gpt-3.5-turbo'; }
            if (['local-llm'].includes(config.engine)) { config.customEndpoint = config.localEndpoint; config.customModel = config.localModel; }

            // 1. Save all settings
            await api.saveSettings(config);

            // 2. Apply staged glossary changes
            for (const entry of stagedGlossaryAdds) {
                await api.saveGlossaryEntry({ source: entry.source, target: entry.target, mode: entry.mode });
            }
            for (const id of stagedGlossaryDeletes) {
                await api.deleteGlossaryEntry(id);
            }
            stagedGlossaryAdds = [];
            stagedGlossaryDeletes = [];

            // 3. Apply staged profile creates
            for (const p of stagedProfileCreates) {
                await api.createProfile({ name: p.name });
            }
            // 4. Apply staged profile deletes
            for (const name of stagedProfileDeletes) {
                await api.deleteProfile(name);
            }
            stagedProfileCreates = [];
            stagedProfileDeletes = [];

            // 5. Save current profile data (updates glossary count, history, etc.)
            await api.saveProfile({ name: activeProfile });
            loadProfiles();

            // 6. Reload glossary from store to sync IDs
            await loadGlossary();

            // 7. Mark as saved (remove visual indicator)
            markSaved();

            // Update cached settings
            window._lastSettings = await api.getSettings();

            const btnText = document.getElementById('save-btn-text');
            const t = translations[currentLang] || translations['en'];
            const orig = btnText.innerText;
            btnText.innerText = `✓ ${t.saved_confirm || '¡Guardado!'}`;
            setTimeout(() => btnText.innerText = orig, 1500);
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

            // v3.11.22: When clipboard is paused, show disconnected status instead of "watching"
            // to make it clear clipboard is no longer being monitored
            if (currentInputMethod === 'clipboard') {
                if (translationActive) {
                    updateConnectionStatus('watching');
                } else {
                    updateConnectionStatus('disconnected');
                }
            }

            // When OCR is the input method, start/stop OCR session with the main toggle
            if (currentInputMethod === 'ocr') {
                if (translationActive) {
                    startOcrSession();
                } else {
                    stopOcrSession();
                }
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

        async function browseTextractorCli() {
            const result = await api.textractorBrowseCli();
            if (result.canceled) return;

            const input = document.getElementById('textractor-cli-path');
            const status = document.getElementById('cli-path-status');

            // Use the resolved path (folder -> x64/Textractor.exe auto-resolved)
            input.value = result.path;

            if (result.valid) {
                if (result.autoResolved) {
                    status.innerHTML = '<span class="text-blue-500">✓ Auto-detectado</span>';
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

        async function launchTextractorCli() {
            const cliPath = document.getElementById('textractor-cli-path').value.trim();
            const gamePid = parseInt(document.getElementById('game-pid').value);

            if (!cliPath) {
                await browseTextractorCli();
                return;
            }

            if (!gamePid || gamePid <= 0) {
                const status = document.getElementById('cli-status-bar');
                const text = document.getElementById('cli-status-text');
                status.classList.remove('hidden');
                text.innerHTML = '<span class="text-red-500">⚠ PID requerido</span>';
                setTimeout(() => status.classList.add('hidden'), 3000);
                return;
            }

            // Disable launch button, show kill button
            document.getElementById('btn-launch-cli').classList.add('hidden');
            document.getElementById('btn-kill-cli').classList.remove('hidden');

            // Pass the port from the UI to the backend (fix: port wasn't being used on launch)
            const textractorPort = parseInt(document.getElementById('textractor-port').value);
            const result = await api.textractorLaunch(cliPath, gamePid, textractorPort);
            const status = document.getElementById('cli-status-bar');
            const text = document.getElementById('cli-status-text');
            status.classList.remove('hidden');

            if (result.success) {
                cliRunning = true;
                text.innerHTML = '<span class="text-emerald-500">● TextractorCLI: Ejecutándose</span> (PID: ' + gamePid + ')';
                document.getElementById('cli-pid-text').innerText = 'CLI PID: ...';
                // Update CLI process PID after a short delay
                setTimeout(async () => {
                    const s = await api.textractorCliStatus();
                    if (s.processPid) {
                        document.getElementById('cli-pid-text').innerText = 'CLI PID: ' + s.processPid;
                    }
                }, 1000);
            } else {
                text.innerHTML = '<span class="text-red-500">✗ Error: ' + (result.error || 'Desconocido') + '</span>';
                document.getElementById('btn-launch-cli').classList.remove('hidden');
                document.getElementById('btn-kill-cli').classList.add('hidden');
                setTimeout(() => status.classList.add('hidden'), 5000);
            }
        }

        async function killTextractorCli() {
            await api.textractorKill();
            cliRunning = false;
            document.getElementById('btn-launch-cli').classList.remove('hidden');
            document.getElementById('btn-kill-cli').classList.add('hidden');

            const status = document.getElementById('cli-status-bar');
            const text = document.getElementById('cli-status-text');
            text.innerHTML = '<span class="text-gray-400">TextractorCLI: Detenido</span>';
            document.getElementById('cli-pid-text').innerText = '';
            setTimeout(() => status.classList.add('hidden'), 2000);
        }

        function updateCliStatus(status) {
            const text = document.getElementById('cli-status-text');
            const statusBar = document.getElementById('cli-status-bar');
            const errorDetail = document.getElementById('cli-error-detail');
            statusBar.classList.remove('hidden');

            switch (status) {
                case 'launched':
                    cliRunning = true;
                    text.innerHTML = '<span class="text-emerald-500">● TextractorCLI: Ejecutándose</span>';
                    errorDetail.classList.add('hidden');
                    document.getElementById('btn-launch-cli').classList.add('hidden');
                    document.getElementById('btn-kill-cli').classList.remove('hidden');
                    break;
                case 'exited':
                case 'killed':
                    cliRunning = false;
                    text.innerHTML = '<span class="text-gray-400">TextractorCLI: Detenido</span>';
                    document.getElementById('btn-launch-cli').classList.remove('hidden');
                    document.getElementById('btn-kill-cli').classList.add('hidden');
                    setTimeout(() => {
                        if (!cliRunning) {
                            errorDetail.classList.add('hidden');
                            statusBar.classList.add('hidden');
                        }
                    }, 2000);
                    break;
                case 'error':
                    cliRunning = false;
                    text.innerHTML = '<span class="text-red-500">✗ TextractorCLI: Error</span>';
                    document.getElementById('btn-launch-cli').classList.remove('hidden');
                    document.getElementById('btn-kill-cli').classList.add('hidden');
                    break;
                case 'extracting':
                    cliRunning = true;
                    text.innerHTML = '<span class="text-emerald-500 pulse-dot">● TextractorCLI: Extrayendo texto</span>';
                    errorDetail.classList.add('hidden');
                    break;
                default:
                    text.innerHTML = '<span class="text-gray-400">TextractorCLI: ' + status + '</span>';
            }
        }

        /**
         * Show detailed CLI error information (v3.8.23)
         * errorData = { message, code, severity, hint, stderr, stdout, gamePid, cliPath, timestamp }
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
            errorMessage.textContent = errorData.message || 'Error desconocido';

            // Helpful hint
            if (errorData.hint) {
                errorHint.textContent = '💡 ' + errorData.hint;
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
            btn.disabled = true;
            btn.innerHTML = '<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Test...</span>';
            statusBar.classList.remove('hidden');
            statusText.innerHTML = '<span class="text-blue-500">⏳ Probando TextractorCLI...</span>';
            errorDetail.classList.add('hidden');

            try {
                const result = await api.textractorTestCli(cliPath);

                if (result.canStart) {
                    statusText.innerHTML = '<span class="text-emerald-500">✓ TextractorCLI funciona correctamente</span>';
                    if (result.hint) {
                        statusText.innerHTML += '<span class="text-[9px] text-gray-400 ml-1">(' + result.hint + ')</span>';
                    }
                    // Save the resolved path on successful test (folder -> x64/Textractor.exe)
                    const pathToSave = result.resolvedPath || cliPath;
                    document.getElementById('textractor-cli-path').value = pathToSave;
                    api.saveSettings({ textractorCliPath: pathToSave });
                    setTimeout(() => {
                        if (!cliRunning) statusBar.classList.add('hidden');
                    }, 3000);
                } else {
                    statusText.innerHTML = '<span class="text-red-500">✗ TextractorCLI no pudo iniciar</span>';
                    // Show detailed error
                    showCliError({
                        message: 'TextractorCLI no pudo iniciar',
                        code: result.exitCode,
                        severity: 'error',
                        hint: result.hint || 'Verifica que el archivo exista y las DLLs estén presentes.',
                        stderr: result.stderr || '',
                        stdout: result.stdout || ''
                    });
                }
            } catch (err) {
                statusText.innerHTML = '<span class="text-red-500">✗ Error al probar: ' + (err.message || 'Desconocido') + '</span>';
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
            const launchBtn = document.getElementById('btn-launch-cli');
            const killBtn = document.getElementById('btn-kill-cli');

            if (enabled) {
                // Manual mode: disable CLI controls, just connect to TCP
                cliPathInput.disabled = true;
                cliPathInput.classList.add('opacity-50');
                gamePidInput.disabled = true;
                gamePidInput.classList.add('opacity-50');
                launchBtn.disabled = true;
                launchBtn.classList.add('opacity-50');
                killBtn.disabled = true;
                killBtn.classList.add('opacity-50');
                // Connect directly to TCP
                api.saveSettings({ manualTextractorMode: true });
            } else {
                cliPathInput.disabled = false;
                cliPathInput.classList.remove('opacity-50');
                gamePidInput.disabled = false;
                gamePidInput.classList.remove('opacity-50');
                launchBtn.disabled = false;
                launchBtn.classList.remove('opacity-50');
                killBtn.disabled = false;
                killBtn.classList.remove('opacity-50');
                api.saveSettings({ manualTextractorMode: false });
            }
        }

        // ===== HOOK SELECTOR (v3.8.22) =====
        let _discoveredHooks = []; // Cache of discovered hooks

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

        function updateHookPreview(hook) {
            const previewDiv = document.getElementById('hook-preview');
            const previewText = document.getElementById('hook-preview-text');
            if (hook && hook.lastText) {
                previewDiv.classList.remove('hidden');
                previewText.textContent = hook.lastText;
            } else {
                previewDiv.classList.add('hidden');
            }
        }

        function updateHookSelector(data) {
            // data = { hooks, selectedHookKey, autoSelectedHookKey, activeHookKey, totalHooks }
            _discoveredHooks = data.hooks || [];
            const section = document.getElementById('hook-selector-section');
            const selector = document.getElementById('hook-selector');
            const countBadge = document.getElementById('hook-count-badge');

            // Show section if there are hooks
            if (_discoveredHooks.length > 0) {
                section.classList.remove('hidden');
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
                updateHookPreview(activeHook);
            }
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
                    // v3.11.3: Keep connection badge in sync with server status
                    updateConnectionStatus(status.running ? 'xuat' : 'disconnected');
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

        // ===== INIT =====
        init();
