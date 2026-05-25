/**
 * XUAT (XUnity AutoTranslator) Game Mod Installer
 *
 * v3.11.17: Cleanup — removed residual proxy bypass files, .bat launcher, diagnostic
 *           steps, and dead code. XUAT connectivity is now handled by the correct
 *           Endpoint=CustomTranslate config and DisableCertificateValidation=True.
 *           Added updateLanguageConfig() and clearTranslationCache() for
 *           live language switching without full reinstall.
 * v3.11.15: CRITICAL FIXES:
 *           1. Changed Endpoint from 'Custom' to 'CustomTranslate'
 *           2. Fixed translators path to BepInEx/plugins/XUnity.AutoTranslator/Translators/
 *           3. Added Http/DisableCertificateValidation=True to XUAT config
 * v3.11.6: Major IL2CPP support rewrite
 *
 * Uses PowerShell Expand-Archive for zip extraction on Windows.
 * Downloads from GitHub releases API.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const axios = require('axios');
const { execSync } = require('child_process');

class XuatInstaller extends EventEmitter {
  constructor() {
    super();
    this._tempDir = null;
  }

  /**
   * Detect if the selected path is a Unity game
   * v3.11.9: Simplified IL2CPP detection — reduced log spam.
   * All detection methods still run but only a single summary line is logged.
   * @param {string} exePath - Path to the game .exe
   * @returns {{isUnity: boolean, gameDir: string, gameName: string, dataDir: string|null, isIL2CPP: boolean}}
   */
  detectUnityGame(exePath) {
    try {
      const gameDir = path.dirname(exePath);
      const exeName = path.basename(exePath, '.exe');

      // List files in game directory
      let dirFiles = [];
      let dataFiles = [];
      try {
        dirFiles = fs.readdirSync(gameDir);
      } catch (dirErr) {
        console.error(`[XUAT] CRITICAL: Cannot read game directory "${gameDir}": ${dirErr.message}`);
      }

      // Look for *_Data folder next to the exe (standard Unity convention)
      const dataDir = path.join(gameDir, `${exeName}_Data`);
      const dataDirExists = fs.existsSync(dataDir);

      if (dataDirExists) {
        try {
          dataFiles = fs.readdirSync(dataDir);
        } catch (e) { /* ignore */ }
      }

      // Also check for UnityPlayer.dll as a secondary indicator
      const hasUnityPlayer = fs.existsSync(path.join(gameDir, 'UnityPlayer.dll'));

      // Check for Managed folder inside _Data
      let hasManaged = false;
      if (dataDirExists) {
        hasManaged = fs.existsSync(path.join(dataDir, 'Managed'));
      }

      // ===== IL2CPP DETECTION =====
      // Run all checks silently, then log a single summary line
      let isIL2CPP = false;
      const gameAssemblyPath = path.join(gameDir, 'GameAssembly.dll');
      let detectionMethod = 'none';

      // Check 1: GameAssembly.dll (primary IL2CPP indicator)
      if (!isIL2CPP && fs.existsSync(gameAssemblyPath)) {
        isIL2CPP = true;
        detectionMethod = 'GameAssembly.dll (existsSync)';
      }

      // Check 3: Il2CppAssemblies folder in _Data
      if (!isIL2CPP && dataDirExists && dataFiles.some(f => f.toLowerCase() === 'il2cppassemblies')) {
        isIL2CPP = true;
        detectionMethod = 'Il2CppAssemblies';
      }

      // Check 4: il2cpp_data folder in _Data
      if (!isIL2CPP && dataDirExists && dataFiles.some(f => f.toLowerCase() === 'il2cpp_data')) {
        isIL2CPP = true;
        detectionMethod = 'il2cpp_data';
      }

      // Check 5: global-metadata.dat in _Data/il2cpp_data/Metadata/
      if (!isIL2CPP && dataDirExists) {
        const metadataPath = path.join(dataDir, 'il2cpp_data', 'Metadata', 'global-metadata.dat');
        if (fs.existsSync(metadataPath)) {
          isIL2CPP = true;
          detectionMethod = 'global-metadata.dat';
        }
      }

      // v3.11.9: Single summary log line instead of 12+ lines
      console.log(`[XUAT] Game: ${exeName} | IL2CPP: ${isIL2CPP}${isIL2CPP ? ` (detected via ${detectionMethod})` : ' (Mono — no IL2CPP indicators found)'} | Data: ${dataDirExists} | Files: ${dirFiles.length}`);

      const isUnity = dataDirExists || hasUnityPlayer;

      return {
        isUnity,
        gameDir,
        gameName: exeName,
        dataDir: dataDirExists ? dataDir : null,
        hasUnityPlayer,
        hasManaged,
        isIL2CPP
      };
    } catch (err) {
      console.error(`[XUAT] detectUnityGame error: ${err.message}`);
      return {
        isUnity: false,
        gameDir: path.dirname(exePath),
        gameName: path.basename(exePath, '.exe'),
        dataDir: null,
        hasUnityPlayer: false,
        hasManaged: false,
        isIL2CPP: false,
        error: err.message
      };
    }
  }

  /**
   * Download BepInEx from GitHub releases
   * v3.11.6: IL2CPP games download BepInEx 6 (IL2CPP build),
   * Mono games download BepInEx 5 (stable).
   *
   * BepInEx 5 (stable) is Mono-only — it does NOT work with IL2CPP games.
   * BepInEx 6 (pre-release/bleeding edge) includes IL2CPP support via
   * BepInEx.IL2CPP.dll entry point and Il2CppInterop runtime.
   *
   * Asset naming conventions:
   *   BepInEx 5: BepInEx_win_x64_5.x.x.x.zip (Mono only)
   *   BepInEx 6: BepInEx-IL2CPP_win_x64_6.x.x.x.zip (IL2CPP)
   *              BepInEx-Mono_win_x64_6.x.x.x.zip (Mono)
   *
   * @param {string} gameDir - Game directory (for progress reporting)
   * @param {boolean} isIL2CPP - Whether the game uses IL2CPP backend
   * @returns {Promise<{filePath: string, version: string, isIL2CPP: boolean}>}
   */
  async downloadBepInEx(gameDir, isIL2CPP = false) {
    this.emit('status', 'Fetching BepInEx release info...');

    try {
      // Get BepInEx releases from GitHub API
      const releaseResp = await axios.get('https://api.github.com/repos/BepInEx/BepInEx/releases', {
        timeout: 15000,
        headers: { 'User-Agent': 'Tuhua-Translator' }
      });

      const releases = releaseResp.data;
      let asset = null;
      let version = null;
      let releaseLabel = null;

      if (isIL2CPP) {
        // ===== IL2CPP: Download BepInEx 6 IL2CPP build =====
        console.log(`[XUAT] IL2CPP game detected — looking for BepInEx 6 IL2CPP build...`);

        // Find the latest BepInEx 6.x release (includes pre-releases for IL2CPP)
        // BepInEx 6 is the only version that supports IL2CPP games
        const bepInEx6Release = releases.find(r => {
          return r.tag_name && r.tag_name.startsWith('v6');
        });

        if (bepInEx6Release) {
          console.log(`[XUAT] Found BepInEx 6 release: ${bepInEx6Release.tag_name} (prerelease: ${bepInEx6Release.prerelease})`);

          // Look for IL2CPP-specific asset
          // Naming: BepInEx-IL2CPP_win_x64_*.zip or BepInEx_il2cpp_win_x64_*.zip
          asset = bepInEx6Release.assets.find(a =>
            a.name && a.name.toLowerCase().includes('il2cpp') &&
            a.name.toLowerCase().includes('win') &&
            a.name.toLowerCase().includes('x64') &&
            a.name.endsWith('.zip') &&
            !a.name.toLowerCase().includes('x86')
          );

          // Fallback: any IL2CPP + x64 zip
          if (!asset) {
            asset = bepInEx6Release.assets.find(a =>
              a.name && a.name.toLowerCase().includes('il2cpp') &&
              a.name.toLowerCase().includes('x64') &&
              a.name.endsWith('.zip') &&
              !a.name.toLowerCase().includes('x86')
            );
          }

          // Fallback: any IL2CPP zip (try without x64 filter)
          if (!asset) {
            asset = bepInEx6Release.assets.find(a =>
              a.name && a.name.toLowerCase().includes('il2cpp') &&
              a.name.endsWith('.zip') &&
              !a.name.toLowerCase().includes('x86') &&
              !a.name.toLowerCase().includes('unix') &&
              !a.name.toLowerCase().includes('linux') &&
              !a.name.toLowerCase().includes('macos')
            );
          }

          if (asset) {
            version = bepInEx6Release.tag_name;
            releaseLabel = 'BepInEx 6 IL2CPP';
          }
        }

        // If no BepInEx 6 IL2CPP found, try BepInEx-IL2CPP repo as fallback
        if (!asset) {
          console.log(`[XUAT] No IL2CPP build in main repo, trying BepInEx-IL2CPP repo...`);
          try {
            const il2cppRepoResp = await axios.get('https://api.github.com/repos/BepInEx/BepInEx-IL2CPP/releases', {
              timeout: 15000,
              headers: { 'User-Agent': 'Tuhua-Translator' }
            });

            const il2cppReleases = il2cppRepoResp.data;
            if (il2cppReleases.length > 0) {
              const latestIl2cpp = il2cppReleases[0];
              console.log(`[XUAT] Found BepInEx-IL2CPP release: ${latestIl2cpp.tag_name}`);

              // Find Windows x64 zip
              asset = latestIl2cpp.assets.find(a =>
                a.name && a.name.endsWith('.zip') &&
                (a.name.toLowerCase().includes('x64') || a.name.toLowerCase().includes('win')) &&
                !a.name.toLowerCase().includes('x86') &&
                !a.name.toLowerCase().includes('unix') &&
                !a.name.toLowerCase().includes('linux') &&
                !a.name.toLowerCase().includes('macos')
              );

              // Fallback: first zip asset
              if (!asset) {
                asset = latestIl2cpp.assets.find(a =>
                  a.name && a.name.endsWith('.zip') &&
                  !a.name.toLowerCase().includes('x86') &&
                  !a.name.toLowerCase().includes('unix') &&
                  !a.name.toLowerCase().includes('linux') &&
                  !a.name.toLowerCase().includes('macos')
                );
              }

              if (asset) {
                version = latestIl2cpp.tag_name;
                releaseLabel = 'BepInEx-IL2CPP';
              }
            }
          } catch (il2cppRepoErr) {
            console.log(`[XUAT] BepInEx-IL2CPP repo not accessible: ${il2cppRepoErr.message}`);
          }
        }

        if (!asset) {
          throw new Error(
            'Could not find BepInEx IL2CPP build. IL2CPP games (like Lethal Company) require ' +
            'BepInEx 6 with IL2CPP support. Please install manually from: ' +
            'https://github.com/BepInEx/BepInEx/releases'
          );
        }
      } else {
        // ===== MONO: Download BepInEx 5 stable =====
        console.log(`[XUAT] Mono game detected — downloading BepInEx 5 stable...`);

        const bepInEx5Release = releases.find(r => {
          return r.tag_name && r.tag_name.startsWith('v5') && !r.prerelease;
        });

        if (!bepInEx5Release) {
          throw new Error('Could not find BepInEx 5.x release. Please install manually.');
        }

        // BepInEx 5 naming conventions:
        //   v5.4.23+: BepInEx_win_x64_5.4.23.x.zip
        //   v5.4.22-: BepInEx_x64_5.4.22.0.zip

        // Try v5.4.23+ naming first (BepInEx_win_x64_*)
        asset = bepInEx5Release.assets.find(a =>
          a.name && a.name.includes('win') && a.name.includes('x64') && a.name.endsWith('.zip') && !a.name.includes('x86')
        );

        // Fallback: v5.4.22 and earlier naming (BepInEx_x64_*)
        if (!asset) {
          asset = bepInEx5Release.assets.find(a =>
            a.name && a.name.includes('x64') && a.name.endsWith('.zip') && !a.name.includes('x86') && !a.name.includes('win')
          );
        }

        // Final fallback: any non-x86, non-unix zip
        if (!asset) {
          asset = bepInEx5Release.assets.find(a =>
            a.name && a.name.endsWith('.zip') && !a.name.includes('x86') && !a.name.includes('unix') && !a.name.includes('linux') && !a.name.includes('macos')
          );
        }

        if (!asset) {
          throw new Error('Could not find BepInEx 5.x download. Please install manually.');
        }

        version = bepInEx5Release.tag_name;
        releaseLabel = 'BepInEx 5 Mono';
      }

      const downloadUrl = asset.browser_download_url;

      console.log(`[XUAT] Selected ${releaseLabel} asset: ${asset.name} (version ${version})`);
      // v3.11.15: Log platform info to verify correct selection
      const isWindows = asset.name.toLowerCase().includes('win');
      console.log(`[XUAT] Platform: ${isWindows ? 'Windows' : 'Unknown'} x64`);
      this.emit('status', `Downloading ${releaseLabel} ${version}...`);
      this.emit('progress', { stage: 'download-bepinex', percent: 10 });

      // Download to temp directory
      const tempDir = this._getTempDir();
      const filePath = path.join(tempDir, isIL2CPP ? 'BepInEx-IL2CPP.zip' : 'BepInEx5.zip');

      const downloadResp = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded / progressEvent.total) * 30) + 10;
            this.emit('progress', { stage: 'download-bepinex', percent });
          }
        }
      });

      fs.writeFileSync(filePath, downloadResp.data);
      this.emit('progress', { stage: 'download-bepinex', percent: 40 });

      return { filePath, version, isIL2CPP };
    } catch (err) {
      if (err.response && err.response.status === 403) {
        throw new Error('GitHub API rate limit exceeded. Please try again in a few minutes or install BepInEx manually.');
      }
      throw new Error(`Failed to download BepInEx: ${err.message}`);
    }
  }

  /**
   * Download the latest XUnity.AutoTranslator from GitHub releases
   * @param {string} gameDir - Game directory (for progress reporting)
   * @returns {Promise<{filePath: string, version: string}>}
   */
  async downloadXuat(gameDir) {
    this.emit('status', 'Fetching XUnity.AutoTranslator release info...');

    try {
      const releaseResp = await axios.get('https://api.github.com/repos/bbepis/XUnity.AutoTranslator/releases/latest', {
        timeout: 15000,
        headers: { 'User-Agent': 'Tuhua-Translator' }
      });

      const release = releaseResp.data;
      const version = release.tag_name;

      // Find the main zip asset
      const asset = release.assets.find(a =>
        a.name && a.name.endsWith('.zip') && !a.name.includes('ResourceRedirector')
      );

      if (!asset) {
        throw new Error('Could not find XUnity.AutoTranslator download. Please install manually.');
      }

      this.emit('status', `Downloading XUnity.AutoTranslator ${version}...`);
      this.emit('progress', { stage: 'download-xuat', percent: 45 });

      const tempDir = this._getTempDir();
      const filePath = path.join(tempDir, 'XUnity.AutoTranslator.zip');

      const downloadResp = await axios.get(asset.browser_download_url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded / progressEvent.total) * 25) + 45;
            this.emit('progress', { stage: 'download-xuat', percent });
          }
        }
      });

      fs.writeFileSync(filePath, downloadResp.data);
      this.emit('progress', { stage: 'download-xuat', percent: 70 });

      return { filePath, version };
    } catch (err) {
      if (err.response && err.response.status === 403) {
        throw new Error('GitHub API rate limit exceeded. Please try again in a few minutes or install XUAT manually.');
      }
      throw new Error(`Failed to download XUnity.AutoTranslator: ${err.message}`);
    }
  }

  /**
   * Configure XUAT to use Tuhua as translation endpoint
   * @param {string} gameDir - Game directory path
   * @param {number} port - Tuhua XUAT server port
   * @param {string} sourceLang - Source language code (e.g. 'ja')
   * @param {string} targetLang - Target language code (e.g. 'en')
   * @returns {void}
   */
  configureXuat(gameDir, port, sourceLang = 'ja', targetLang = 'en') {
    const configDir = path.join(gameDir, 'BepInEx', 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const configPath = path.join(configDir, 'AutoTranslatorConfig.ini');

    // v3.11.7: XUAT does NOT support 'auto' as FromLanguage.
    // It requires a specific language code. When the user has 'auto' selected
    // in Tuhua, we default to 'en' for XUAT since most translatable games
    // are in English. The user can override this by selecting a specific
    // source language in Tuhua's settings.
    let xuatSourceLang = sourceLang;
    if (!xuatSourceLang || xuatSourceLang === 'auto') {
      xuatSourceLang = 'en';
      console.log(`[XUAT] Source language is 'auto' — XUAT requires a specific language, defaulting to 'en'`);
      console.log(`[XUAT] TIP: Select a specific source language in Settings for better results`);
    }

    // Read existing config if present to preserve user settings
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf8');
        existingConfig = this._parseIni(content);
      } catch (e) {
        // Ignore parse errors, start fresh
      }
    }

    // v3.11.15: CRITICAL FIX — XUAT's [Service] Endpoint= expects the endpoint ID
    // from the translator DLL name. The CustomTranslate endpoint has Id="CustomTranslate"
    // (from CustomTranslate.dll), NOT "Custom".
    // Previous versions used "Custom" which caused:
    //   "Could not find the configured endpoint 'Custom'"
    // CORRECT configuration:
    //   [Service] Endpoint=CustomTranslate           <-- endpoint ID (matches DLL)
    //   [Custom] Url=http://127.0.0.1:8419/translate <-- URL here
    //
    // XUAT's CustomTranslateEndpoint makes GET requests to:
    //   {Url}?from={1}&to={2}&text={3}
    // Our server parses query params by name, so parameter order doesn't matter.
    // CRITICAL: Server must return PLAIN TEXT (not JSON!) — see xuat-server.js
    const config = {
      General: {
        Language: targetLang,
        FromLanguage: xuatSourceLang,
        ...existingConfig.General
      },
      Service: {
        Endpoint: 'CustomTranslate',  // MUST be "CustomTranslate", NOT "Custom"!
        FallbackEndpoint: '',
        ...existingConfig.Service
      },
      Custom: {
        Url: `http://127.0.0.1:${port}/translate`,
        EnableShortDelay: 'False',
        DisableSpamChecks: 'False',
        ...existingConfig.Custom
      },
      Behavior: {
        ImguirClipboardTraceOnStartup: 'False',
        MaxTranslationsPerFrame: '25',
        ...existingConfig.Behavior
      },
      TextFrameworks: {
        TextMeshPro: 'True',
        IMGUI: 'True',
        NGUI: 'True',
        ...existingConfig.TextFrameworks
      },
      Http: {
        UserAgent: '',
        DisableCertificateValidation: 'True',  // Required for local HTTP in Unity/Mono
        ...existingConfig.Http
      }
    };

    // Override the critical settings that Tuhua needs
    config.General.Language = targetLang;
    config.General.FromLanguage = xuatSourceLang;
    // v3.11.15: Use 'CustomTranslate' endpoint ID, not 'Custom'!
    config.Service.Endpoint = 'CustomTranslate';  // MUST be "CustomTranslate"!
    config.Service.FallbackEndpoint = '';
    // URL goes in [Custom] section — XUAT appends ?from={1}&to={2}&text={3}
    config.Custom.Url = `http://127.0.0.1:${port}/translate`;
    config.Http.DisableCertificateValidation = 'True';

    const iniContent = this._serializeIni(config);
    fs.writeFileSync(configPath, iniContent, 'utf8');

    console.log(`[XUAT] Config written: ${xuatSourceLang} → ${targetLang} | Endpoint: CustomTranslate | Port: ${port}`);
  }

  /**
   * Update language settings in the existing AutoTranslatorConfig.ini
   * when the user changes language in the UI, without requiring a full reinstall.
   * v3.11.17: Added for live language switching.
   * @param {string} gameDir - Game directory path
   * @param {number} port - Tuhua XUAT server port
   * @param {string} sourceLang - New source language code (e.g. 'en')
   * @param {string} targetLang - New target language code (e.g. 'es')
   * @returns {void}
   */
  updateLanguageConfig(gameDir, port, sourceLang, targetLang) {
    const configPath = path.join(gameDir, 'BepInEx', 'config', 'AutoTranslatorConfig.ini');

    if (!fs.existsSync(configPath)) {
      console.log(`[XUAT] Config file not found at ${configPath} — cannot update language`);
      return;
    }

    // XUAT doesn't support 'auto' as FromLanguage — default to 'en'
    let xuatSourceLang = sourceLang;
    if (!xuatSourceLang || xuatSourceLang === 'auto') {
      xuatSourceLang = 'en';
    }

    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = this._parseIni(content);

      // Update language settings
      if (!config.General) config.General = {};
      const oldSource = config.General.FromLanguage;
      const oldTarget = config.General.Language;

      config.General.Language = targetLang;
      config.General.FromLanguage = xuatSourceLang;

      // Also update the URL in case port changed
      if (config.Custom) {
        config.Custom.Url = `http://127.0.0.1:${port}/translate`;
      }

      const iniContent = this._serializeIni(config);
      fs.writeFileSync(configPath, iniContent, 'utf8');

      console.log(`[XUAT] Language config updated: FromLanguage ${oldSource}→${xuatSourceLang}, Language ${oldTarget}→${targetLang}`);
    } catch (err) {
      console.error(`[XUAT] Failed to update language config: ${err.message}`);
      throw err;
    }
  }

  /**
   * Clear XUAT's translation cache files so that changing the target
   * language actually takes effect.
   * v3.11.17: Added for live language switching.
   * @param {string} gameDir - Game directory path
   * @returns {number} Count of files deleted
   */
  clearTranslationCache(gameDir) {
    const bepInExDir = path.join(gameDir, 'BepInEx');
    let deletedCount = 0;

    if (!fs.existsSync(bepInExDir)) {
      console.log(`[XUAT] BepInEx directory not found at ${bepInExDir} — cannot clear cache`);
      return 0;
    }

    // Search for _AutoGeneratedTranslations.txt files recursively
    const findAndDeleteCacheFiles = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            findAndDeleteCacheFiles(fullPath);
          } else if (entry.name.endsWith('_AutoGeneratedTranslations.txt')) {
            try {
              fs.unlinkSync(fullPath);
              deletedCount++;
              console.log(`[XUAT] Deleted cache file: ${fullPath}`);
            } catch (delErr) {
              console.error(`[XUAT] Could not delete ${fullPath}: ${delErr.message}`);
            }
          }
        }
      } catch (readErr) {
        console.error(`[XUAT] Could not read directory ${dir}: ${readErr.message}`);
      }
    };

    findAndDeleteCacheFiles(bepInExDir);

    // Also clear AutoTranslations/ directory if it exists
    const autoTranslationsDir = path.join(bepInExDir, 'AutoTranslations');
    if (fs.existsSync(autoTranslationsDir)) {
      try {
        const entries = fs.readdirSync(autoTranslationsDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(autoTranslationsDir, entry.name);
          if (entry.isFile()) {
            try {
              fs.unlinkSync(fullPath);
              deletedCount++;
              console.log(`[XUAT] Deleted AutoTranslations file: ${fullPath}`);
            } catch (delErr) {
              console.error(`[XUAT] Could not delete ${fullPath}: ${delErr.message}`);
            }
          }
        }
        console.log(`[XUAT] Cleared AutoTranslations/ directory`);
      } catch (readErr) {
        console.error(`[XUAT] Could not read AutoTranslations dir: ${readErr.message}`);
      }
    }

    console.log(`[XUAT] Cache clearing complete: ${deletedCount} file(s) deleted`);
    return deletedCount;
  }

  /**
   * Full installation flow: detect, download, install, configure
   * v3.11.6: IL2CPP games get BepInEx 6 IL2CPP, Mono games get BepInEx 5.
   * doorstop_config.ini is preserved from the BepInEx zip (not overwritten).
   * @param {string} exePath - Path to the game executable
   * @param {number} port - Tuhua XUAT server port
   * @param {string} sourceLang - Source language code
   * @param {string} targetLang - Target language code
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async runFullInstall(exePath, port, sourceLang = 'ja', targetLang = 'en') {
    try {
      // Step 1: Detect Unity game
      this.emit('status', 'Detecting game...');
      this.emit('progress', { stage: 'detect', percent: 5 });

      const detection = this.detectUnityGame(exePath);
      if (!detection.isUnity) {
        throw new Error('Selected file does not appear to be a Unity game. XUAT only works with Unity games.');
      }

      const gameDir = detection.gameDir;
      const isIL2CPP = detection.isIL2CPP;

      // v3.11.6: Log game backend type — this determines which BepInEx variant to download
      console.log(`[XUAT] Game detected: ${detection.gameName}, IL2CPP: ${isIL2CPP}`);
      if (isIL2CPP) {
        console.log(`[XUAT] IL2CPP game — will download BepInEx 6 IL2CPP build`);
      } else {
        console.log(`[XUAT] Mono game — will download BepInEx 5 stable`);
      }

      // Step 2: Download BepInEx (correct variant for game backend)
      this.emit('status', isIL2CPP ? 'Downloading BepInEx 6 IL2CPP...' : 'Downloading BepInEx 5...');
      const bepInEx = await this.downloadBepInEx(gameDir, isIL2CPP);
      this.emit('status', 'Extracting BepInEx...');
      const bepInExTempDir = path.join(this._getTempDir(), 'bepinex-extract');
      if (!fs.existsSync(bepInExTempDir)) fs.mkdirSync(bepInExTempDir, { recursive: true });
      await this._extractZip(bepInEx.filePath, bepInExTempDir);
      this._moveExtractedToGameDir(bepInExTempDir, gameDir);

      // Step 3: Download and install XUAT (always — ensures latest version)
      const xuat = await this.downloadXuat(gameDir);
      this.emit('status', 'Extracting XUnity.AutoTranslator...');
      const xuatTempDir = path.join(this._getTempDir(), 'xuat-extract');
      if (!fs.existsSync(xuatTempDir)) fs.mkdirSync(xuatTempDir, { recursive: true });
      await this._extractZip(xuat.filePath, xuatTempDir);
      this._moveExtractedToGameDir(xuatTempDir, gameDir);

      // Step 4: Ensure directories exist
      const bepInExDir = path.join(gameDir, 'BepInEx');
      const pluginsDir = path.join(bepInExDir, 'plugins');
      const configDir = path.join(bepInExDir, 'config');
      if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

      // Step 5: Configure XUAT
      this.emit('status', 'Configuring XUAT...');
      this.emit('progress', { stage: 'configure', percent: 90 });
      this.configureXuat(gameDir, port, sourceLang, targetLang);

      // Step 6: Verify installation — check that the correct entry point DLL exists
      const coreDir = path.join(bepInExDir, 'core');
      let foundDllNames = [];
      let foundEntryPoint = false;
      let entryPointName = isIL2CPP ? 'BepInEx.IL2CPP.dll' : 'BepInEx.Preloader.dll';

      if (fs.existsSync(coreDir)) {
        try {
          const coreFiles = fs.readdirSync(coreDir);
          for (const f of coreFiles) {
            if (f.startsWith('BepInEx') && f.endsWith('.dll')) {
              foundDllNames.push(f);
            }
            // Check for the correct entry point DLL for this game backend
            if (isIL2CPP && f.includes('IL2CPP') && f.endsWith('.dll')) {
              entryPointName = f;
              foundEntryPoint = true;
            } else if (!isIL2CPP && f.includes('Preloader') && f.endsWith('.dll')) {
              entryPointName = f;
              foundEntryPoint = true;
            }
          }
        } catch (e) { /* ignore */ }
      }

      console.log(`[XUAT] DLLs found in core/: ${foundDllNames.length > 0 ? foundDllNames.join(', ') : 'NONE'}`);
      console.log(`[XUAT] Entry point DLL: ${entryPointName} (found: ${foundEntryPoint})`);

      if (!foundEntryPoint) {
        console.error(`[XUAT] WARNING: ${entryPointName} not found in core/ — installation may be incomplete`);
        this.emit('status', `Advertencia: ${entryPointName} no encontrado. La instalacion puede estar incompleta.`);
      }

      // v3.11.6: Verify doorstop_config.ini exists and points to the right entry point
      const doorstopConfigPath = path.join(gameDir, 'doorstop_config.ini');
      if (fs.existsSync(doorstopConfigPath)) {
        try {
          const doorstopContent = fs.readFileSync(doorstopConfigPath, 'utf8');
          console.log(`[XUAT] doorstop_config.ini found — verifying entry point`);

          // Check if doorstop_config.ini points to the correct entry point
          const expectedTarget = `BepInEx\\core\\${entryPointName}`;
          if (!doorstopContent.includes(expectedTarget) && !doorstopContent.includes(expectedTarget.replace(/\\/g, '/'))) {
            console.log(`[XUAT] doorstop_config.ini does NOT point to ${expectedTarget} — fixing it`);
            // The zip's doorstop_config.ini might be wrong. Fix it.
            this._writeDoorstopConfig(doorstopConfigPath, entryPointName);
          } else {
            console.log(`[XUAT] doorstop_config.ini correctly targets ${expectedTarget}`);
          }
        } catch (e) {
          console.log(`[XUAT] Could not read doorstop_config.ini: ${e.message}`);
        }
      } else {
        // No doorstop_config.ini — create one
        console.log(`[XUAT] No doorstop_config.ini found — creating one for ${entryPointName}`);
        this._writeDoorstopConfig(doorstopConfigPath, entryPointName);
      }

      // Step 7: v3.11.7 Check for stale Linux files from previous BepInEx installations
      // These can interfere with the Windows BepInEx doorstop loader
      const staleLinuxFiles = ['libdoorstop.so', 'run_bepinex.sh', 'doorstop_libs'];
      for (const staleFile of staleLinuxFiles) {
        const stalePath = path.join(gameDir, staleFile);
        if (fs.existsSync(stalePath)) {
          console.log(`[XUAT] WARNING: Found stale Linux file '${staleFile}' from a previous installation. This can interfere with BepInEx on Windows.`);
          try {
            const stat = fs.statSync(stalePath);
            if (stat.isDirectory()) {
              fs.rmSync(stalePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(stalePath);
            }
            console.log(`[XUAT] Removed stale file: ${staleFile}`);
          } catch (rmErr) {
            console.log(`[XUAT] Could not remove '${staleFile}': ${rmErr.message} — please delete it manually`);
          }
        }
      }

      // v3.11.15: Check for translators in the CORRECT path per XUAT docs:
      // BepInEx/plugins/XUnity.AutoTranslator/Translators/ (not BepInEx/translators/)
      const translatorsDir = path.join(bepInExDir, 'plugins', 'XUnity.AutoTranslator', 'Translators');
      // Also check the old wrong path for backwards compat
      const translatorsDirOld = path.join(bepInExDir, 'translators');
      let foundTranslatorsDir = fs.existsSync(translatorsDir) ? translatorsDir :
                                 fs.existsSync(translatorsDirOld) ? translatorsDirOld : null;

      if (foundTranslatorsDir) {
        try {
          const translatorFiles = fs.readdirSync(foundTranslatorsDir);
          const customDll = translatorFiles.find(f =>
            f.toLowerCase().includes('custom') && f.toLowerCase().endsWith('.dll')
          );
          console.log(`[XUAT] Translators folder: ${foundTranslatorsDir} (${translatorFiles.length} files)`);
          if (customDll) {
            console.log(`[XUAT] Custom endpoint DLL found: ${customDll}`);
          } else {
            console.log(`[XUAT] WARNING: No CustomTranslateEndpoint DLL found in translators/ folder!`);
            console.log(`[XUAT] Files: ${translatorFiles.join(', ')}`);
            console.log(`[XUAT] The 'Custom' endpoint will NOT be available without this DLL`);
          }
        } catch (e) {
          console.log(`[XUAT] Could not read translators folder: ${e.message}`);
        }
      } else {
        console.log(`[XUAT] WARNING: No translators/ folder found in BepInEx!`);
        console.log(`[XUAT] XUAT needs endpoint DLLs in BepInEx/translators/ to work`);
        console.log(`[XUAT] The 'Custom' endpoint will NOT be available`);

        // Try to find the translators folder in the extracted XUAT zip
        // It might have been extracted to a different location
        const xuatExtractDir = path.join(this._getTempDir(), 'xuat-extract');
        if (fs.existsSync(xuatExtractDir)) {
          console.log(`[XUAT] Searching for translators in XUAT extract dir...`);
          try {
            const extractContents = fs.readdirSync(xuatExtractDir, { recursive: true });
            const translatorDlls = extractContents.filter(f =>
              typeof f === 'string' && f.toLowerCase().includes('translator') && f.toLowerCase().endsWith('.dll')
            );
            if (translatorDlls.length > 0) {
              console.log(`[XUAT] Found translator DLLs in extract dir: ${translatorDlls.join(', ')}`);
              // v3.11.15: Create the CORRECT translators directory (not the old wrong one)
              const targetTranslatorsDir = path.join(bepInExDir, 'plugins', 'XUnity.AutoTranslator', 'Translators');
              if (!fs.existsSync(targetTranslatorsDir)) {
                fs.mkdirSync(targetTranslatorsDir, { recursive: true });
              }
              for (const dll of translatorDlls) {
                const srcPath = path.join(xuatExtractDir, dll);
                const dstPath = path.join(targetTranslatorsDir, path.basename(dll));
                if (fs.existsSync(srcPath)) {
                  try {
                    fs.copyFileSync(srcPath, dstPath);
                    console.log(`[XUAT] Copied translator DLL: ${path.basename(dll)}`);
                  } catch (copyErr) {
                    console.log(`[XUAT] Could not copy ${path.basename(dll)}: ${copyErr.message}`);
                  }
                }
              }
              foundTranslatorsDir = targetTranslatorsDir;
            }
          } catch (searchErr) {
            console.log(`[XUAT] Could not search extract dir: ${searchErr.message}`);
          }
        }
      }

      // Step 8: Cleanup
      this._cleanupTemp();

      this.emit('progress', { stage: 'complete', percent: 100 });
      this.emit('status', `Instalacion completa! (${isIL2CPP ? 'IL2CPP' : 'Mono'}) — Mantén Tuhua abierto e inicia el juego`);
      this.emit('complete', {
        gameDir,
        gameName: detection.gameName,
        bepInExInstalled: true,
        xuatInstalled: true,
        configured: true,
        isIL2CPP,
        port
      });

      return { success: true, gameDir, gameName: detection.gameName, isIL2CPP };
    } catch (err) {
      console.error('[XUAT] Installation failed:', err.message);
      this.emit('error', err);
      this._cleanupTemp();
      return { success: false, error: err.message };
    }
  }

  /**
   * Write doorstop_config.ini with the correct entry point
   * v3.11.6: Handles both IL2CPP and Mono configurations
   * @private
   * @param {string} configPath - Path to doorstop_config.ini
   * @param {string} entryPointDll - Name of the entry point DLL (e.g. BepInEx.IL2CPP.dll)
   */
  _writeDoorstopConfig(configPath, entryPointDll) {
    const targetAssembly = `BepInEx\\core\\${entryPointDll}`;

    // v3.11.6: Write different config sections based on entry point
    const isIL2CPP = entryPointDll.toLowerCase().includes('il2cpp');

    const lines = [
      '[General]',
      'enabled=true',
      `target_assembly=${targetAssembly}`,
      'redirect_output_log=false',
      'ignore_disable_switch=false',
      ''
    ];

    if (isIL2CPP) {
      // BepInEx 6 IL2CPP uses [UnityIL2CPP] section
      lines.push(
        '[UnityIL2CPP]',
        'coreclr_path=',
        'unity_dir=',
        ''
      );
    } else {
      // BepInEx 5 Mono uses [UnityMono] section
      lines.push(
        '[UnityMono]',
        'dll_search_path_override=',
        'debug_enabled=false',
        'debug_address=127.0.0.1:10000',
        'debug_suspend=false',
        ''
      );
    }

    fs.writeFileSync(configPath, lines.join('\r\n'), 'utf8');
    console.log(`[XUAT] doorstop_config.ini written (target: ${targetAssembly}, backend: ${isIL2CPP ? 'IL2CPP' : 'Mono'})`);
  }

  /**
   * Move extracted files from temp dir to game dir.
   * v3.11.4: Handles the case where the zip has a wrapper directory.
   * Some zips extract as: tempDir/BepInEx_x64_5.4.21.0/BepInEx/core/...
   * instead of: tempDir/BepInEx/core/...
   * This method detects wrapper directories and moves files correctly.
   * @private
   * @param {string} extractDir - Temp directory where zip was extracted
   * @param {string} gameDir - Game directory to move files to
   */
  _moveExtractedToGameDir(extractDir, gameDir) {
    if (!fs.existsSync(extractDir)) return;

    let sourceDir = extractDir;
    const entries = fs.readdirSync(extractDir);

    // v3.11.4: Check if the zip had a single wrapper directory
    // e.g. BepInEx_x64_5.4.21.0/ containing the actual BepInEx/ folder
    if (entries.length === 1) {
      const singleEntry = entries[0];
      const singlePath = path.join(extractDir, singleEntry);
      const stat = fs.statSync(singlePath);
      if (stat.isDirectory()) {
        // Check if this wrapper dir contains a BepInEx folder or doorstop_config.ini
        const wrapperContents = fs.readdirSync(singlePath);
        if (wrapperContents.some(f => f === 'BepInEx' || f === 'doorstop_config.ini' || f === 'winhttp.dll' || f === '.doorstop_version')) {
          console.log(`[XUAT] Detected wrapper directory '${singleEntry}', using inner contents`);
          sourceDir = singlePath;
        }
      }
    }

    // Copy all files/dirs from sourceDir to gameDir
    this._copyDirRecursive(sourceDir, gameDir);
    console.log(`[XUAT] Moved extracted files from ${sourceDir} to ${gameDir}`);
  }

  /**
   * Recursively copy directory contents, merging with existing files
   * @private
   * @param {string} src - Source directory
   * @param {string} dest - Destination directory
   */
  _copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      const stat = fs.statSync(srcPath);

      if (stat.isDirectory()) {
        this._copyDirRecursive(srcPath, destPath);
      } else {
        // Copy file, overwriting if exists
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Extract a zip file using PowerShell Expand-Archive (Windows only)
   * @private
   * @param {string} zipPath - Path to the zip file
   * @param {string} destDir - Destination directory
   * @returns {Promise<void>}
   */
  async _extractZip(zipPath, destDir) {
    if (os.platform() !== 'win32') {
      throw new Error('XUAT installer only supports Windows (Unity games require Windows).');
    }

    return new Promise((resolve, reject) => {
      try {
        // Use PowerShell Expand-Archive for reliable zip extraction on Windows
        const psCommand = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
        execSync(`powershell -NoProfile -Command "${psCommand.replace(/"/g, '\\"')}"`, {
          timeout: 60000,
          windowsHide: true
        });
        resolve();
      } catch (err) {
        // Fallback: try with a different quoting approach
        try {
          const escapedZip = zipPath.replace(/'/g, "''");
          const escapedDest = destDir.replace(/'/g, "''");
          const script = `Expand-Archive -Path '${escapedZip}' -DestinationPath '${escapedDest}' -Force`;
          execSync(`powershell -NoProfile -Command "& { ${script} }"`, {
            timeout: 60000,
            windowsHide: true
          });
          resolve();
        } catch (fallbackErr) {
          reject(new Error(`Failed to extract zip: ${fallbackErr.message || err.message}`));
        }
      }
    });
  }

  /**
   * Get or create a temp directory for downloads
   * @private
   * @returns {string}
   */
  _getTempDir() {
    if (!this._tempDir) {
      this._tempDir = path.join(os.tmpdir(), `tuhua-xuat-${Date.now()}`);
      fs.mkdirSync(this._tempDir, { recursive: true });
    }
    return this._tempDir;
  }

  /**
   * Clean up temporary files
   * @private
   */
  _cleanupTemp() {
    if (this._tempDir && fs.existsSync(this._tempDir)) {
      try {
        fs.rmSync(this._tempDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
      this._tempDir = null;
    }
  }

  /**
   * Parse an INI file content into a nested object
   * @private
   * @param {string} content - INI file content
   * @returns {object}
   */
  _parseIni(content) {
    const result = {};
    let currentSection = null;

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

      const sectionMatch = trimmed.match(/^\[(\w+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        if (!result[currentSection]) result[currentSection] = {};
        continue;
      }

      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (kvMatch && currentSection) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        result[currentSection][key] = value;
      }
    }

    return result;
  }

  /**
   * Serialize a nested object into INI format
   * @private
   * @param {object} config - Config object
   * @returns {string}
   */
  _serializeIni(config) {
    const lines = [];

    for (const [section, values] of Object.entries(config)) {
      lines.push(`[${section}]`);
      for (const [key, value] of Object.entries(values)) {
        lines.push(`${key}=${value}`);
      }
      lines.push('');
    }

    return lines.join('\r\n');
  }
}

module.exports = XuatInstaller;
