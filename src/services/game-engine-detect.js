/**
 * Game Engine Detection
 *
 * v3.13.76: Pure, synchronous detector shared by XUAT's Unity detection
 * (xuat-installer.js's detectUnityGame() is now a one-line delegate to this
 * module) and the new proactive "Textractor structurally can't read this
 * game" advisory (see textractor-launcher.js's _detectAndEmitGameEngine()).
 *
 * Written pure on purpose — no Electron, no EventEmitter, dependencies
 * injectable via the `deps` param — so it's testable in plain Node
 * (scripts/test-game-engine-detect.js) without a fake filesystem on disk.
 *
 * Origin: Lyca hit Amorous (a Visual Novel built on FNA, an open-source XNA
 * reimplementation) with Textractor and burned ~10 minutes trying x86/x64/
 * manual TextractorGUI before finding out Textractor structurally cannot
 * see FNA/XNA/MonoGame text — it's drawn via SpriteBatch.DrawString onto a
 * GPU font atlas, never through the Win32 GDI text APIs
 * (ExtTextOutW/DrawTextW/etc) Textractor hooks. Same underlying limitation
 * as Unity's own text rendering, which is exactly why XUAT exists as a
 * separate approach for Unity — but XUAT is Unity-only, so FNA/XNA/MonoGame
 * games have no hook-based path at all. OCR is the only method that works
 * for this whole class of engine, because it reads pixels, not APIs.
 * See bug-textractor-english-vn-cjk-garbage (memory) for the full writeup,
 * and the plan this shipped from: ya-veo-claro-ocr-cuddly-quokka.md.
 *
 * Precedence (most-specific-and-excluding-others first):
 *   unity > renpy > godot > fna > monogame > xna > unknown
 * Unity always wins over a stray MonoGame.Framework.dll sitting in a Unity
 * game's folder, because `<exeName>_Data/` carries the exact executable
 * name — practically impossible to collide with by accident, and a Unity
 * game is never FNA. FNA is checked before MonoGame before XNA because some
 * FNA ports ship a `Microsoft.Xna.Framework.dll` compatibility stub, but
 * MonoGame never ships `FNA.dll` — the more specific marker wins.
 *
 * Anti-annoyance rule: the advisory is only ever surfaced when
 * `confidence === 'high'` (at least one primary marker matched). A
 * corroborant-only match (e.g. `Content/*.xnb` with no engine DLL) is
 * `confidence: 'medium'` and gets `adviceKey: null` — never nags the user
 * over ambiguous evidence. An engine with zero markers at all is
 * `confidence: 'low'`/`unknown`, also silent.
 */

const fs = require('fs');
const path = require('path');

const XNA_FAMILY_ADVICE_KEY = 'engine_advice_xna';

/**
 * @param {string} exePath - Path to the game's .exe
 * @param {{existsSync?: Function, readdirSync?: Function}} [deps] - Injectable
 *   fs functions, for testing without touching disk.
 * @returns {{
 *   engine: string, engineLabel: string|null, family: string|null,
 *   confidence: 'high'|'medium'|'low', markers: string[],
 *   recommendedMethod: 'xuat'|'ocr'|'clipboard'|null, textractorWorks: boolean|null,
 *   adviceKey: string|null, exePath: string,
 *   isUnity: boolean, gameDir: string, gameName: string, dataDir: string|null,
 *   hasUnityPlayer: boolean, hasManaged: boolean, isIL2CPP: boolean,
 *   error?: string
 * }}
 */
function detectGameEngine(exePath, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;

  const gameDir = path.dirname(exePath);
  const exeName = path.basename(exePath, '.exe');

  // Legacy-shaped defaults (same names/semantics as the old detectUnityGame)
  // — every non-Unity result carries these as false/null so both consumers
  // (xuat-installer.js's runFullInstall, ipc-handlers.js's xuat-detect-game
  // handler) keep working unchanged; they only ever read the Unity fields.
  const buildResult = (fields) => ({
    ...fields,
    exePath,
    isUnity: false,
    gameDir,
    gameName: exeName,
    dataDir: null,
    hasUnityPlayer: false,
    hasManaged: false,
    isIL2CPP: false
  });

  try {
    let dirFiles = [];
    try {
      dirFiles = readdirSync(gameDir);
    } catch (dirErr) {
      console.error(`[EngineDetect] Cannot read game directory "${gameDir}": ${dirErr.message}`);
    }
    const dirSet = new Set(dirFiles.map(f => f.toLowerCase()));
    const has = (name) => dirSet.has(name.toLowerCase());

    // ===== Unity — same markers as the pre-v3.13.76 detectUnityGame =====
    const dataDir = path.join(gameDir, `${exeName}_Data`);
    const dataDirExists = existsSync(dataDir);
    let dataFiles = [];
    if (dataDirExists) {
      try { dataFiles = readdirSync(dataDir); } catch (e) { /* ignore, same as before */ }
    }
    const dataSet = new Set(dataFiles.map(f => f.toLowerCase()));
    const hasUnityPlayer = has('UnityPlayer.dll');
    const hasManaged = dataDirExists && dataSet.has('managed');

    // v3.13.76 addition: a POSITIVE Mono confirmation, not just "no IL2CPP
    // markers found". Assembly-CSharp.dll is where Unity puts a Mono
    // project's own compiled scripts — its presence actually means Mono,
    // rather than the absence of IL2CPP evidence merely implying it.
    let hasAssemblyCSharp = false;
    if (hasManaged) {
      try {
        const managedFiles = readdirSync(path.join(dataDir, 'Managed'));
        hasAssemblyCSharp = managedFiles.some(f => f.toLowerCase() === 'assembly-csharp.dll');
      } catch (e) { /* ignore */ }
    }

    let isIL2CPP = false;
    let detectionMethod = 'none';
    if (existsSync(path.join(gameDir, 'GameAssembly.dll'))) {
      isIL2CPP = true; detectionMethod = 'GameAssembly.dll';
    } else if (dataDirExists && dataSet.has('il2cppassemblies')) {
      isIL2CPP = true; detectionMethod = 'Il2CppAssemblies';
    } else if (dataDirExists && dataSet.has('il2cpp_data')) {
      isIL2CPP = true; detectionMethod = 'il2cpp_data';
    } else if (dataDirExists) {
      const metadataPath = path.join(dataDir, 'il2cpp_data', 'Metadata', 'global-metadata.dat');
      if (existsSync(metadataPath)) { isIL2CPP = true; detectionMethod = 'global-metadata.dat'; }
    }

    const isUnity = dataDirExists || hasUnityPlayer;

    console.log(`[EngineDetect] ${exeName}: Unity=${isUnity}` +
      (isUnity ? ` IL2CPP=${isIL2CPP}${isIL2CPP ? ` (${detectionMethod})` : hasAssemblyCSharp ? ' (Mono, Assembly-CSharp.dll confirmed)' : ' (Mono, no IL2CPP indicators found)'}` : '') +
      ` | Data=${dataDirExists} | Files=${dirFiles.length}`);

    if (isUnity) {
      const engine = isIL2CPP ? 'unity-il2cpp' : 'unity-mono';
      return {
        engine,
        engineLabel: 'Unity',
        family: 'unity',
        confidence: 'high',
        markers: [
          dataDirExists ? `${exeName}_Data/` : null,
          hasUnityPlayer ? 'UnityPlayer.dll' : null,
          isIL2CPP ? detectionMethod : (hasAssemblyCSharp ? 'Assembly-CSharp.dll' : null)
        ].filter(Boolean),
        recommendedMethod: 'xuat',
        // null, not false: Textractor's brute-force Mono hooking sometimes
        // does find something for Unity Mono games — this isn't the hard
        // "never works" case that FNA/XNA/Ren'Py/Godot are.
        textractorWorks: null,
        adviceKey: 'engine_advice_unity',
        exePath,
        isUnity: true,
        gameDir,
        gameName: exeName,
        dataDir: dataDirExists ? dataDir : null,
        hasUnityPlayer,
        hasManaged,
        isIL2CPP
      };
    }

    // ===== Ren'Py =====
    if (has('renpy') && (has('game') || has('lib'))) {
      return buildResult({
        engine: 'renpy',
        engineLabel: "Ren'Py",
        family: 'renpy',
        confidence: 'high',
        markers: ['renpy/', has('game') ? 'game/' : 'lib/'],
        // v3.13.86: NOT 'ocr' — real bug found by Lyca testing a real
        // Ren'Py game. Ren'Py ships a built-in "copy dialogue to the OS
        // clipboard" shortcut (Shift+C) — that's a far more reliable text
        // source than screen OCR (no scan-region setup, no OCR misreads,
        // exact text every time). OCR is the right fallback for engines
        // that draw text on the GPU with no such feature (Unity IL2CPP,
        // Godot, FNA/XNA); Ren'Py specifically has a better one.
        recommendedMethod: 'clipboard',
        textractorWorks: false,
        adviceKey: 'engine_advice_renpy'
      });
    }

    // ===== Godot =====
    const pckName = `${exeName}.pck`;
    const godotDataDir = `data_${exeName}`;
    if (has(pckName) || has(godotDataDir)) {
      return buildResult({
        engine: 'godot',
        engineLabel: 'Godot',
        family: 'godot',
        confidence: 'high',
        markers: [
          has(pckName) ? pckName : null,
          has(godotDataDir) ? `${godotDataDir}/` : null,
          has(`${exeName}.console.exe`) ? `${exeName}.console.exe` : null
        ].filter(Boolean),
        recommendedMethod: 'ocr',
        textractorWorks: false,
        adviceKey: 'engine_advice_godot'
      });
    }

    // ===== FNA / MonoGame / XNA — the family that broke the Amorous case =====
    // All three draw text via SpriteBatch.DrawString onto a GPU font atlas;
    // none of them ever touch ExtTextOutW/DrawTextW, so they share one advice
    // key (engine_advice_xna, {engine} substituted) instead of three near-
    // identical translated strings across 8 locales.
    const monoGameDlls = dirFiles.filter(f => /^monogame\.framework.*\.dll$/i.test(f));
    const xnaDlls = dirFiles.filter(f => /^microsoft\.xna\.framework.*\.dll$/i.test(f));

    if (has('FNA.dll')) {
      return buildResult({
        engine: 'fna',
        engineLabel: 'FNA',
        family: 'xna',
        confidence: 'high',
        markers: ['FNA.dll', ...['FNA3D.dll', 'FAudio.dll', 'SDL2.dll'].filter(has)],
        recommendedMethod: 'ocr',
        textractorWorks: false,
        adviceKey: XNA_FAMILY_ADVICE_KEY
      });
    }
    if (monoGameDlls.length > 0) {
      return buildResult({
        engine: 'monogame',
        engineLabel: 'MonoGame',
        family: 'xna',
        confidence: 'high',
        markers: monoGameDlls,
        recommendedMethod: 'ocr',
        textractorWorks: false,
        adviceKey: XNA_FAMILY_ADVICE_KEY
      });
    }
    if (xnaDlls.length > 0) {
      return buildResult({
        engine: 'xna',
        engineLabel: 'XNA',
        family: 'xna',
        confidence: 'high',
        markers: xnaDlls,
        recommendedMethod: 'ocr',
        textractorWorks: false,
        adviceKey: XNA_FAMILY_ADVICE_KEY
      });
    }

    // Corroborant-only XNA-family evidence (compiled .xnb content with no
    // engine DLL matched) — medium confidence, deliberately no advice.
    if (has('content')) {
      let contentFiles = [];
      try { contentFiles = readdirSync(path.join(gameDir, 'Content')); } catch (e) { /* ignore */ }
      if (contentFiles.some(f => f.toLowerCase().endsWith('.xnb'))) {
        return buildResult({
          engine: 'unknown',
          engineLabel: null,
          family: 'xna',
          confidence: 'medium',
          markers: ['Content/*.xnb'],
          recommendedMethod: null,
          textractorWorks: null,
          adviceKey: null
        });
      }
    }

    // No marker matched at all — genuinely unknown, silent by design.
    return buildResult({
      engine: 'unknown',
      engineLabel: null,
      family: null,
      confidence: 'low',
      markers: [],
      recommendedMethod: null,
      textractorWorks: null,
      adviceKey: null
    });
  } catch (err) {
    console.error(`[EngineDetect] detectGameEngine error: ${err.message}`);
    return {
      engine: 'unknown',
      engineLabel: null,
      family: null,
      confidence: 'low',
      markers: [],
      recommendedMethod: null,
      textractorWorks: null,
      adviceKey: null,
      exePath,
      isUnity: false,
      gameDir,
      gameName: exeName,
      dataDir: null,
      hasUnityPlayer: false,
      hasManaged: false,
      isIL2CPP: false,
      error: err.message
    };
  }
}

module.exports = { detectGameEngine };
