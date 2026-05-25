/**
 * TextractorCLI Launcher (v3.8.25)
 *
 * === v3.8.25 KEY CHANGES ===
 *
 * FIX: TEXT DUPLICATION + GARBAGE DIGIT DELIMITERS
 *   - VN engines produce text like "0I softly murmured.0I softly murmured.0"
 *   - The "0" chars are garbage delimiters (memory counters/buffer artifacts)
 *   - The text is duplicated because Textractor captures from multiple buffers
 *   - New _deduplicateSegments() splits by garbage digits and deduplicates
 *   - Also strips leading/trailing garbage digits glued to text ("0I..." → "I...")
 *   - Result: clean "I softly murmured to myself." instead of garbled double text
 *
 * Previous v3.8.24 changes preserved:
 *   - UTF-16LE auto-detection and decoding
 *   - Text cleaning pipeline (null bytes, control chars, doubled chars)
 *   - Improved auto-selection (prose bonus, quality penalties)
 *   - Distinct hook names with preview
 *
 * Previous v3.8.23 changes preserved:
 *   - Auto-resolve Textractor folder to x64/x86 .exe
 *   - Detailed error reporting with Windows exit code interpretation
 *   - CLI test functionality
 *   - Robust stderr capture
 *   - Hook discovery and selector UI
 *   - Stdin-only attach (no CLI arguments)
 */
const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Interpret Windows exit codes into human-readable messages.
 */
function interpretExitCode(code) {
  if (code === 0) return { severity: 'ok', hint: '' };
  if (code === 1) return { severity: 'error', hint: 'Error general de TextractorCLI. Puede ser un PID inválido o error interno.' };
  if (code === 2) return { severity: 'error', hint: 'Archivo no encontrado. Verifica que TextractorCLI.exe y sus DLLs existan.' };
  if (code === 5) return { severity: 'error', hint: 'Acceso denegado. Intenta ejecutar como Administrador.' };
  if (code === 0xC0000135) return { severity: 'critical', hint: 'DLL no encontrada. Instala Visual C++ Redistributable (x64 o x86 según tu Textractor).' };
  if (code === 0xC0000005) return { severity: 'critical', hint: 'Violación de acceso (crash). TextractorCLI falló al iniciar — posible incompatibilidad o DLL incorrecta.' };
  if (code === 0xC0000142) return { severity: 'critical', hint: 'Fallo de inicialización de DLL. Reinstala Visual C++ Redistributable.' };
  if (code === 0xE0434352) return { severity: 'critical', hint: 'Excepción .NET no manejada. TextractorCLI tiene un error interno.' };
  // Generic negative codes on Windows (signed interpretation of HRESULT)
  if (code < 0 && code >= -0xFFFF) {
    const unsigned = code >>> 0;
    if (unsigned === 0xC0000135) return { severity: 'critical', hint: 'DLL no encontrada (0xC0000135). Instala Visual C++ Redistributable.' };
    if (unsigned === 0xC0000005) return { severity: 'critical', hint: 'Violación de acceso (0xC0000005). TextractorCLI crasheó.' };
    if (unsigned === 0xC0000142) return { severity: 'critical', hint: 'Fallo de inicialización DLL (0xC0000142). Reinstala VC++ Redist.' };
    return { severity: 'error', hint: `Error de sistema Windows (0x${unsigned.toString(16).toUpperCase()}).` };
  }
  return { severity: 'error', hint: `Código de salida: ${code}` };
}

class TextractorLauncher extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.cliPath = '';
    this.isRunning = false;
    this._outputBuffer = [];
    this._maxBufferLines = 200;
    this._stdoutBuffer = '';
    this._stdinTimer = null;
    this._stdinSent = false;
    this._gamePid = null;
    this._launchTime = null;
    this._diagnosticTimer = null;
    this._hexDumpCount = 0;
    this._maxHexDumps = 10;
    this._dataEventCount = 0;

    // === ERROR CAPTURE STATE (v3.8.23) ===
    this._stderrLines = [];       // All stderr lines captured during this session
    this._stdoutTail = [];        // Last 20 stdout lines for error context
    this._maxStdoutTail = 20;
    this._lastError = null;       // Structured error object from last failure

    // === HOOK DISCOVERY STATE ===
    // Map of hookKey -> { key, name, fullName, lastText, textCount, hasCJK, avgLength, discoveredAt }
    this._hooks = new Map();
    // Currently selected hook key (null = auto mode)
    this._selectedHookKey = null;
    // Auto-selected best hook key
    this._autoSelectedHookKey = null;
    // Hook discovery timer — emit batch update after hooks stabilize
    this._hookDiscoveryTimer = null;
    // Whether we've done the initial hook discovery phase
    this._hookDiscoveryPhase = false;
    // Lines processed (for diagnostics)
    this._totalLinesProcessed = 0;
    this._hookLinesProcessed = 0;
    // v3.8.24: Detected encoding for TextractorCLI stdout
    this._detectedEncoding = null; // null = not yet detected, 'utf16le' or 'utf8'
  }

  configure(cliPath) {
    if (cliPath && cliPath !== this.cliPath) {
      const cleanPath = cliPath.replace(/^"+|"+$/g, '');
      // Auto-resolve: if user gave a folder, find the exe inside it
      const resolved = this._resolveExePath(cleanPath);
      this.cliPath = resolved;
      console.log(`[TextractorLauncher] Configured path: "${cleanPath}" -> "${resolved}"`);
      this.emit('status', 'configured');
    }
  }

  /**
   * Auto-resolve a path to the actual TextractorCLI/Textractor executable.
   *
   * If the path points to a .exe file, return it as-is.
   * If the path points to a directory, search for TextractorCLI.exe / Textractor.exe
   * inside common subdirectories (x64, x86, X64, X86) and the directory itself.
   *
   * Priority order:
   *   1. <dir>/x64/TextractorCLI.exe
   *   2. <dir>/x64/Textractor.exe
   *   3. <dir>/X64/TextractorCLI.exe
   *   4. <dir>/X64/Textractor.exe
   *   5. <dir>/x86/TextractorCLI.exe   (fallback for 32-bit games)
   *   6. <dir>/x86/Textractor.exe
   *   7. <dir>/X86/TextractorCLI.exe
   *   8. <dir>/X86/Textractor.exe
   *   9. <dir>/TextractorCLI.exe       (flat layout)
   *  10. <dir>/Textractor.exe
   *
   * Returns the resolved path, or the original path if nothing found.
   */
  _resolveExePath(inputPath) {
    if (!inputPath) return inputPath;

    const resolved = path.resolve(inputPath);

    // Already a file — return as-is
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) return resolved;
    } catch (e) {
      // Path doesn't exist yet — return as-is (validation will catch it)
      return resolved;
    }

    // It's a directory — search for the exe
    const exeNames = ['TextractorCLI.exe', 'Textractor.exe'];
    const archSubdirs = ['x64', 'X64', 'x86', 'X86'];

    for (const subdir of archSubdirs) {
      for (const exeName of exeNames) {
        const candidate = path.join(resolved, subdir, exeName);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            console.log(`[TextractorLauncher] Auto-resolved: "${resolved}" -> "${candidate}"`);
            return candidate;
          }
        } catch (e) { /* skip */ }
      }
    }

    // Flat layout (exe directly in the folder)
    for (const exeName of exeNames) {
      const candidate = path.join(resolved, exeName);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          console.log(`[TextractorLauncher] Auto-resolved (flat): "${resolved}" -> "${candidate}"`);
          return candidate;
        }
      } catch (e) { /* skip */ }
    }

    // Nothing found — return original path (validation will show proper error)
    console.warn(`[TextractorLauncher] Could not auto-resolve "${resolved}" — no Textractor.exe/TextractorCLI.exe found in x64/x86 subdirs`);
    return resolved;
  }

  validatePath(cliPath) {
    if (!cliPath) return { valid: false, message: 'No path specified' };
    try {
      const cleanPath = cliPath.replace(/^"+|"+$/g, '');

      // === AUTO-RESOLVE: if user gave a folder, find the exe inside it ===
      let resolved = path.resolve(cleanPath);
      let autoResolved = false;

      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          // User gave a folder — auto-resolve to the exe
          const found = this._resolveExePath(cleanPath);
          if (found !== resolved) {
            resolved = found;
            autoResolved = true;
          } else {
            // _resolveExePath couldn't find anything — give a helpful error
            const exeNames = ['TextractorCLI.exe', 'Textractor.exe'];
            const subdirs = ['x64', 'X64', 'x86', 'X86'];
            const searchedPaths = [];
            for (const subdir of subdirs) {
              for (const exeName of exeNames) {
                searchedPaths.push(path.join(resolved, subdir, exeName));
              }
            }
            for (const exeName of exeNames) {
              searchedPaths.push(path.join(resolved, exeName));
            }
            return {
              valid: false,
              message: `Se esperaba un .exe, se recibió una carpeta. No se encontró Textractor.exe ni TextractorCLI.exe en:\n` +
                searchedPaths.map(p => '  • ' + p).join('\n')
            };
          }
        }
      } else {
        return { valid: false, message: 'Ruta no encontrada: ' + resolved };
      }

      // Now `resolved` should point to a .exe file
      const ext = path.extname(resolved).toLowerCase();
      if (ext !== '.exe') {
        return { valid: false, message: 'Expected .exe file, got: ' + ext };
      }
      const basename = path.basename(resolved).toLowerCase();
      if (!basename.includes('textractor')) {
        return { valid: false, message: 'File does not appear to be TextractorCLI: ' + basename };
      }

      // v3.8.23: Check if required DLLs might be missing
      const dir = path.dirname(resolved);
      const requiredDlls = ['vcruntime140.dll', 'msvcp140.dll'];
      const dirFiles = fs.readdirSync(dir).map(f => f.toLowerCase());
      const missingDlls = requiredDlls.filter(dll => !dirFiles.includes(dll));
      // Note: DLLs might be in System32, so this is just a soft check

      // Check architecture consistency
      let archWarning = '';
      try {
        const exeBuffer = fs.readFileSync(resolved);
        // PE header: MZ at offset 0, PE offset at 0x3C
        if (exeBuffer[0] === 0x4D && exeBuffer[1] === 0x5A) {
          const peOffset = exeBuffer.readUInt32LE(0x3C);
          if (peOffset + 6 <= exeBuffer.length) {
            const machine = exeBuffer.readUInt16LE(peOffset + 4);
            // 0x14C = i386 (32-bit), 0x8664 = AMD64 (64-bit)
            if (machine === 0x14C) {
              archWarning = ' (32-bit)';
            } else if (machine === 0x8664) {
              archWarning = ' (64-bit)';
            }
          }
        }
      } catch (e) {
        // Ignore PE parse errors
      }

      let message = 'Valid TextractorCLI executable' + archWarning;
      if (autoResolved) {
        message = 'Auto-detectado: ' + resolved + archWarning;
      }
      return { valid: true, message, resolved, arch: archWarning, autoResolved };
    } catch (err) {
      return { valid: false, message: err.message };
    }
  }

  /**
   * Strip BOM, null bytes, and control characters from a line.
   * v3.8.24: Also strips embedded null bytes (from UTF-16LE decoding artifacts).
   */
  _sanitizeLine(line) {
    if (!line) return line;
    // Strip ALL null bytes (the main source of text corruption)
    let cleaned = line.replace(/\u0000/g, '');
    // Strip BOM and leading control characters
    cleaned = cleaned.replace(/^[\u0001-\u001F\uFEFF]+/, '');
    return cleaned;
  }

  /**
   * Convert first N bytes of a string to hex for diagnostic logging.
   */
  _hexDump(str, maxBytes = 30) {
    const bytes = Buffer.from(str.substring(0, maxBytes), 'utf8');
    const hex = [];
    const ascii = [];
    for (let i = 0; i < bytes.length && i < maxBytes; i++) {
      hex.push(bytes[i].toString(16).padStart(2, '0'));
      ascii.push(bytes[i] >= 32 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : '.');
    }
    return hex.join(' ') + '  |' + ascii.join('') + '|';
  }

  /**
   * Check if a line is our own log output being echoed back (NOT a hook filter).
   * We only filter our OWN echo noise here — never filter game hooks.
   */
  _isOwnEcho(line) {
    if (!line || line.length < 2) return true;
    // Our own log output being echoed back
    if (line.includes('[TextractorLauncher]')) return true;
    if (line.includes('[Tuhua]') && line.length < 100) return true;
    if (line.includes('[Pipeline]')) return true;
    if (line.includes('[Textractor]')) return true;
    if (line.includes('[Clipboard]')) return true;
    // Usage banner
    if (line.includes('Usage:') && line.includes('attach')) return true;
    if (line.includes('Usage:') && line.includes('hookcode')) return true;
    // Windows cmd.exe errors
    if (/no se reconoce como un comando/i.test(line)) return true;
    if (/is not recognized as an internal or external command/i.test(line)) return true;
    // Electron-log timestamped lines
    if (/\d{2}:\d{2}:\d{2}\.\d+ >/.test(line)) return true;
    // Shell prompts
    if (/^\$ /.test(line)) return true;
    if (/^[A-Z]:\\.*>/.test(line)) return true;
    // JSON/JS object fragments from settings
    if (/\b(engine|sourceLang|targetLang|inputMethod)\s*[:=]/i.test(line) && line.length < 80) return true;
    // Lines from previous launches with escaped quotes
    if (/^\\?"[A-Z]:\\.*\\\.exe\\?"/.test(line)) return true;
    // Closing braces/brackets from JSON
    if (/^\s*[}\]]\s*$/.test(line)) return true;
    // Our own console.log output being echoed
    if (line.includes('stdout:') && line.includes('TextractorLauncher')) return true;
    if (line.includes('Output:') && line.includes('TextractorLauncher')) return true;
    if (line.includes('Noise #') && line.includes('TextractorLauncher')) return true;
    if (line.includes('Sending stdin') && line.includes('TextractorLauncher')) return true;
    if (line.includes('Warmup') && line.includes('TextractorLauncher')) return true;
    return false;
  }

  /**
   * Parse a TextractorCLI stdout line and extract hook info + text.
   * Returns { hookKey, hookName, displayName, text, hookCode, funcAddr, processName } or null.
   *
   * TextractorCLI v5.x outputs lines in these formats:
   *   Format A (game hooks):
   *     [index:PID:moduleAddr:funcAddr:split::hookCode:processName] text
   *     Example: [6:7394:74ECB850:ECB87D:0::HB0@0:nekopara_vol1_trial.exe] This was a nod
   *     Example: [2:7394:74639720:7295F18A:0::HB0@0:nekopara_vol1_trial.exe] xxxxx
   *
   *   Format B (system hooks — Console/Clipboard):
   *     [index:PID:moduleAddr:funcAddr:...:TypeName:hookCode] text
   *     Example: [1:0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:Portapapeles:HB0@0] text
   *     Example: [0:0:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:FFFFFFFFFFFFFFFF:Consola:HB0@0] text
   *
   *   Format C (legacy/simple):
   *     [0xHEX:DIGIT:HookName] text
   *
   * displayName is a human-readable label like: "#6 HB0@0 @ECB87D"
   * For system hooks: "#1 Portapapeles"
   */
  _parseHookLine(line) {
    if (!line || line.length < 3) return null;

    // === FORMAT A: Full game hook ===
    // [index:PID:moduleAddr:funcAddr:split::hookCode:processName] text
    // Key feature: double colon (::) before hookCode
    let match = line.match(/\[(\d+):(\d+):([0-9A-Fa-f]+):([0-9A-Fa-f]+):(\d+)::([^:]+):([^\]]+)\]\s*(.*)/);
    if (match) {
      const hookIndex = match[1];
      const pid = match[2];
      const moduleAddr = match[3];
      const funcAddr = match[4];
      const split = match[5];
      const hookCode = match[6].trim();   // e.g. HB0@0
      const processName = match[7].trim(); // e.g. nekopara_vol1_trial.exe
      const text = match[8].trim();

      const hookKey = `${hookIndex}:${pid}:${moduleAddr}:${funcAddr}`;
      const displayName = `#${hookIndex} ${hookCode} @${funcAddr}`;
      const fullName = `[${hookIndex}:${pid}:${moduleAddr}:${funcAddr}:${split}::${hookCode}:${processName}]`;

      return {
        hookKey, hookName: processName, displayName, text, fullName,
        hookCode, funcAddr, processName, hookIndex: parseInt(hookIndex), isSystemHook: false
      };
    }

    // === FORMAT B: System hook (Console/Clipboard) ===
    // [index:PID:...:TypeName:hookCode] text
    // These have FFFFFFFFFFFFFFFF addresses and names like Consola/Portapapeles/Console/Clipboard
    match = line.match(/\[(\d+):(\d+):([^\]]+)\]\s*(.*)/);
    if (match) {
      const hookIndex = match[1];
      const pid = match[2];
      const bracketContent = match[3];
      const text = match[4].trim();

      const parts = bracketContent.split(':');
      // Find the hook type name (Console, Clipboard, Consola, Portapapeles, etc.)
      const systemNames = ['Console', 'Clipboard', 'Consola', 'Portapapeles'];
      let hookTypeName = '';
      for (const part of parts) {
        if (systemNames.includes(part.trim())) {
          hookTypeName = part.trim();
          break;
        }
      }
      // Find hook code (last non-empty part that looks like a hook code, e.g. HB0@0)
      let hookCode = '';
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i].trim();
        if (p && /@[0-9A-Fa-f]+$/i.test(p)) {
          hookCode = p;
          break;
        }
      }

      if (hookTypeName || hookCode) {
        const hookKey = `${hookIndex}:${pid}:${parts[2] || '0'}`;
        const displayName = hookTypeName ? `#${hookIndex} ${hookTypeName}` : `#${hookIndex} ${hookCode}`;
        const fullName = `[${bracketContent}]`;
        return {
          hookKey, hookName: hookTypeName || hookCode, displayName, text, fullName,
          hookCode, funcAddr: '', processName: '', hookIndex: parseInt(hookIndex), isSystemHook: true
        };
      }
    }

    // === FORMAT C: Legacy [0xHEX:DIGIT:NAME] text ===
    match = line.match(/\[(0x[0-9A-Fa-f]+):(\d+):([^\]]*)\]\s*(.*)/);
    if (match) {
      const hookAddr = match[1];
      const threadNum = match[2];
      const hookName = match[3].trim();
      const text = match[4].trim();
      const hookKey = `${hookAddr}:${threadNum}`;
      const displayName = hookName || `${hookAddr}:${threadNum}`;
      return {
        hookKey, hookName, displayName, text, fullName: `[${hookAddr}:${threadNum}:${hookName}]`,
        hookCode: '', funcAddr: '', processName: '', hookIndex: 0, isSystemHook: false
      };
    }

    // === FORMAT D: Generic bracket [...] text ===
    match = line.match(/\[([^\]]+)\]\s*(.*)/);
    if (match) {
      const bracketContent = match[1].trim();
      const text = match[2].trim();
      if (bracketContent.includes(':')) {
        const parts = bracketContent.split(':');
        const hookName = parts[parts.length - 1].trim();
        const hookKey = bracketContent;
        return {
          hookKey, hookName, displayName: hookName, text, fullName: `[${bracketContent}]`,
          hookCode: '', funcAddr: '', processName: '', hookIndex: 0, isSystemHook: false
        };
      }
    }

    return null;
  }

  /**
   * Check if text contains CJK characters.
   */
  _hasCJK(text) {
    return /[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uff65-\uff9f]/.test(text);
  }

  /**
   * Check if text looks like meaningful game text (not just hex numbers, separators, etc.)
   */
  _looksLikeGameText(text) {
    if (!text || text.length < 2) return false;
    // Pure hex/numbers
    if (/^[0-9A-Fa-f\s]+$/.test(text)) return false;
    // Pure punctuation/separators
    if (/^[-=_*#.\s]+$/.test(text)) return false;
    // Pure whitespace
    if (/^\s+$/.test(text)) return false;
    // Pure repeated single character (like xxxxxxxx)
    if (/^(.)\1{4,}$/.test(text)) return false;
    // Textractor internal
    if (text.includes('Textractor') && text.length < 30) return false;
    return true;
  }

  /**
   * Detect text quality issues and return a quality score modifier.
   * Returns a negative number for bad text quality (to subtract from score).
   *
   * Patterns detected:
   *   - Doubled characters: "IInnsstteeaadd" → each pair has same char
   *   - Encoded/shifted: ")LOH'LVSOD\7H[W" → looks like shifted ASCII
   *   - Menu text: "&File&DisplayText&Language"
   *   - Pure whitespace: "       "
   *   - Repeated single char: "xxxxxxxx"
   */
  _textQualityPenalty(text) {
    if (!text || text.length < 2) return 0;

    let penalty = 0;

    // 1. Doubled characters (e.g. "IInnsstteeaadd  oo")
    //    Check: strip spaces, then check if most adjacent pairs are the same char
    const stripped = text.replace(/\s+/g, '');
    if (stripped.length >= 6) {
      let doubledPairs = 0;
      let totalPairs = 0;
      for (let i = 0; i < stripped.length - 1; i += 2) {
        totalPairs++;
        if (stripped[i] === stripped[i + 1]) {
          doubledPairs++;
        }
      }
      if (totalPairs >= 3) {
        const ratio = doubledPairs / totalPairs;
        if (ratio > 0.6) {
          penalty += 800; // Heavy penalty for doubled chars
        }
      }
    }

    // 2. Menu text (contains &File, &Display, &Language, &Controls, &Help, etc.)
    if (/&(File|Display|Language|Controls|Help|View|Edit|Options|Window|Tools|Settings|Game)/i.test(text)) {
      penalty += 600;
    }

    // 3. Pure whitespace
    if (/^\s+$/.test(text)) {
      penalty += 900;
    }

    // 4. Pure repeated single character
    if (/^(.)\1{4,}$/.test(text)) {
      penalty += 800;
    }

    // 5. Encoded/shifted ASCII (lots of uppercase letters with apostrophes and backslashes)
    //    Pattern like: )LOH'LVSOD\7H[W/DQJXDJH
    const upperRatio = (text.match(/[A-Z]/g) || []).length / text.length;
    const specialChars = (text.match(/[)'\\/]/g) || []).length;
    if (upperRatio > 0.5 && specialChars >= 2 && text.length > 10) {
      penalty += 700;
    }

    // 6. Very short text (< 3 meaningful chars) repeated many times
    const meaningfulChars = text.replace(/[\s\x00-\x1F]/g, '');
    if (meaningfulChars.length < 3) {
      penalty += 500;
    }

    return penalty;
  }

  /**
   * Process a parsed hook line.
   * Updates hook state and decides whether to emit text.
   */
  _processHookLine(parsed) {
    const { hookKey, hookName, displayName, text, fullName, hookCode, funcAddr, processName, hookIndex, isSystemHook } = parsed;
    this._hookLinesProcessed++;

    // Get or create hook entry
    let hook = this._hooks.get(hookKey);
    if (!hook) {
      hook = {
        key: hookKey,
        name: hookName,
        displayName: displayName || hookName,
        fullName: fullName,
        hookCode: hookCode || '',
        funcAddr: funcAddr || '',
        processName: processName || '',
        hookIndex: hookIndex || 0,
        isSystemHook: isSystemHook || false,
        lastText: '',
        textCount: 0,
        hasCJK: false,
        totalTextLength: 0,
        qualityPenalty: 0,
        discoveredAt: Date.now()
      };
      this._hooks.set(hookKey, hook);
      console.log(`[TextractorLauncher] NEW HOOK: ${fullName} → ${displayName} (total: ${this._hooks.size})`);
    }

    // Update hook state
    if (text && text.length > 0) {
      hook.lastText = text;
      hook.textCount++;
      hook.totalTextLength += text.length;
      if (this._hasCJK(text)) {
        hook.hasCJK = true;
      }
      // Update quality penalty (use worst seen)
      const penalty = this._textQualityPenalty(text);
      if (penalty > hook.qualityPenalty) {
        hook.qualityPenalty = penalty;
      }
    }

    // Auto-select the best hook if user hasn't manually selected one
    this._autoSelectBestHook();

    // Schedule a hook discovery update to the UI
    this._scheduleHookDiscoveryUpdate();

    // Emit text ONLY from the selected hook
    const activeHookKey = this._selectedHookKey || this._autoSelectedHookKey;
    if (activeHookKey === hookKey && text && this._looksLikeGameText(text)) {
      // v3.8.24: Clean the text before emitting (fix doubled chars, garbage, etc.)
      const cleanedText = this._cleanGameText(text);
      if (cleanedText && cleanedText.length >= 2) {
        const hash = crypto.createHash('md5').update(cleanedText).digest('hex');
        if (hash !== this._lastTextHash) {
          this._lastTextHash = hash;
          console.log(`[TextractorLauncher] GAME TEXT from [${hookName}]: "${cleanedText.substring(0, 80)}"`);
          this.emit('text', cleanedText);
          this.emit('stdout-active');
        }
      }
    }
  }

  /**
   * Auto-select the best hook based on:
   * 1. Has CJK text (strong indicator of game text)
   * 2. Clean English prose (lowercase words with spaces = narrative text)
   * 3. Text quality (penalize doubled, encoded, menu, whitespace)
   * 4. Highest text count (most active hook)
   * 5. Longest average text length
   * 6. System hooks (Console/Clipboard) deprioritized
   *
   * v3.8.24: Added clean prose detection bonus. English game text like
   * "Now that I'm on my own" has lowercase letters, spaces, and punctuation
   * which is very different from menu items (&File&Display), encoded text
   * ()LOH'LVSOD), filler (xxxx), or doubled chars (NNooww).
   *
   * STABILITY: Once a hook has been auto-selected with a decent score,
   * we only switch if another hook has a significantly higher score (+200).
   */
  _autoSelectBestHook() {
    if (this._selectedHookKey) return; // User manually selected, don't auto-switch

    let bestHook = null;
    let bestScore = -Infinity;

    for (const [key, hook] of this._hooks) {
      if (hook.textCount === 0) continue;

      let score = 0;

      // CJK text is a very strong signal
      if (hook.hasCJK) score += 1000;

      // v3.8.24: CLEAN PROSE BONUS
      // Check if lastText looks like clean narrative English prose
      // (lowercase letters + spaces + punctuation = actual game dialogue)
      const cleanPreview = this._cleanGameText(hook.lastText || '');
      if (cleanPreview.length >= 10) {
        const lowerRatio = (cleanPreview.match(/[a-z]/g) || []).length / cleanPreview.length;
        const spaceRatio = (cleanPreview.match(/ /g) || []).length / cleanPreview.length;
        const punctRatio = (cleanPreview.match(/[.,!?;:'"-]/g) || []).length / cleanPreview.length;

        // Clean prose has: ~30-60% lowercase, ~10-25% spaces, some punctuation
        if (lowerRatio > 0.2 && spaceRatio > 0.08 && spaceRatio < 0.4) {
          score += 400; // Strong bonus for looking like prose
          if (punctRatio > 0.01) score += 100; // Extra bonus for punctuation
        }
      }

      // Text count (more active = more likely the main text hook)
      score += Math.min(hook.textCount, 50) * 10;

      // Average text length (longer = more likely game text)
      const avgLen = hook.textCount > 0 ? hook.totalTextLength / hook.textCount : 0;
      score += Math.min(avgLen, 100);

      // Deprioritize system hooks (Console/Clipboard/Portapapeles/Consola)
      const nameLower = hook.name.toLowerCase();
      if (nameLower === 'console' || nameLower === 'clipboard' ||
          nameLower === 'consola' || nameLower === 'portapapeles' ||
          hook.isSystemHook) {
        score -= 500;
      }

      // Penalize very short average text (likely noise)
      if (avgLen < 3) score -= 200;

      // TEXT QUALITY PENALTY:
      // Penalize hooks that produce doubled chars, encoded text, menu text, etc.
      score -= hook.qualityPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestHook = hook;
      }
    }

    if (bestHook) {
      const prevAuto = this._autoSelectedHookKey;

      // STABILITY: Don't switch unless the new hook is significantly better
      if (prevAuto && prevAuto !== bestHook.key) {
        const prevHook = this._hooks.get(prevAuto);
        if (prevHook) {
          // Calculate previous hook's current score
          let prevScore = 0;
          if (prevHook.hasCJK) prevScore += 1000;
          const prevCleanPreview = this._cleanGameText(prevHook.lastText || '');
          if (prevCleanPreview.length >= 10) {
            const prevLowerRatio = (prevCleanPreview.match(/[a-z]/g) || []).length / prevCleanPreview.length;
            const prevSpaceRatio = (prevCleanPreview.match(/ /g) || []).length / prevCleanPreview.length;
            const prevPunctRatio = (prevCleanPreview.match(/[.,!?;:'"-]/g) || []).length / prevCleanPreview.length;
            if (prevLowerRatio > 0.2 && prevSpaceRatio > 0.08 && prevSpaceRatio < 0.4) {
              prevScore += 400;
              if (prevPunctRatio > 0.01) prevScore += 100;
            }
          }
          prevScore += Math.min(prevHook.textCount, 50) * 10;
          const prevAvgLen = prevHook.textCount > 0 ? prevHook.totalTextLength / prevHook.textCount : 0;
          prevScore += Math.min(prevAvgLen, 100);
          const prevNameLower = prevHook.name.toLowerCase();
          if (prevNameLower === 'console' || prevNameLower === 'clipboard' ||
              prevNameLower === 'consola' || prevNameLower === 'portapapeles' ||
              prevHook.isSystemHook) {
            prevScore -= 500;
          }
          if (prevAvgLen < 3) prevScore -= 200;
          prevScore -= prevHook.qualityPenalty;

          // Only switch if new hook is significantly better (+200 threshold)
          if (bestScore <= prevScore + 200) {
            return;
          }
          console.log(`[TextractorLauncher] Hook switch: ${prevHook.displayName} (${prevScore}) → ${bestHook.displayName} (${bestScore}) — significant improvement`);
        }
      }

      this._autoSelectedHookKey = bestHook.key;
      if (prevAuto !== bestHook.key) {
        console.log(`[TextractorLauncher] Auto-selected hook: ${bestHook.displayName} (score: ${bestScore}, texts: ${bestHook.textCount}, CJK: ${bestHook.hasCJK}, quality: ${bestHook.qualityPenalty === 0 ? 'GOOD' : 'PENALTY-' + bestHook.qualityPenalty})`);
      }
    }
  }

  /**
   * Schedule a batch hook discovery update to the UI.
   * Debounced to avoid flooding the renderer with updates.
   */
  _scheduleHookDiscoveryUpdate() {
    if (this._hookDiscoveryTimer) return;
    this._hookDiscoveryTimer = setTimeout(() => {
      this._hookDiscoveryTimer = null;
      this._emitHookDiscovery();
    }, 500); // Emit every 500ms at most
  }

  /**
   * Emit hook discovery data to the renderer.
   * Sends ALL hooks with their current state.
   */
  _emitHookDiscovery() {
    const hooks = [];
    for (const [key, hook] of this._hooks) {
      // v3.8.24: Clean the preview text for display
      const cleanPreview = this._cleanGameText(hook.lastText || '');
      hooks.push({
        key: hook.key,
        name: hook.name,
        displayName: hook.displayName || hook.name,
        fullName: hook.fullName,
        hookCode: hook.hookCode || '',
        funcAddr: hook.funcAddr || '',
        processName: hook.processName || '',
        hookIndex: hook.hookIndex || 0,
        isSystemHook: hook.isSystemHook || false,
        lastText: cleanPreview.substring(0, 120),
        rawLastText: hook.lastText ? hook.lastText.substring(0, 120) : '',
        textCount: hook.textCount,
        hasCJK: hook.hasCJK,
        avgLength: hook.textCount > 0 ? Math.round(hook.totalTextLength / hook.textCount) : 0,
        qualityPenalty: hook.qualityPenalty || 0
      });
    }

    // Sort: clean game hooks first (low penalty), then CJK, then by text count
    hooks.sort((a, b) => {
      // System hooks go last
      if (a.isSystemHook !== b.isSystemHook) return a.isSystemHook ? 1 : -1;
      // Lower quality penalty first (cleaner text)
      if (a.qualityPenalty !== b.qualityPenalty) return a.qualityPenalty - b.qualityPenalty;
      // CJK hooks first
      if (a.hasCJK !== b.hasCJK) return b.hasCJK ? 1 : -1;
      // More texts = more likely correct
      if (a.textCount !== b.textCount) return b.textCount - a.textCount;
      return 0;
    });

    const activeHookKey = this._selectedHookKey || this._autoSelectedHookKey;

    this.emit('hooks-discovered', {
      hooks,
      selectedHookKey: this._selectedHookKey,
      autoSelectedHookKey: this._autoSelectedHookKey,
      activeHookKey,
      totalHooks: hooks.length
    });
  }

  /**
   * Manually select a hook by key.
   * Pass null to return to auto mode.
   */
  selectHook(hookKey) {
    if (hookKey === null || hookKey === '') {
      // Return to auto mode
      this._selectedHookKey = null;
      console.log(`[TextractorLauncher] Hook selection: AUTO mode`);
    } else if (this._hooks.has(hookKey)) {
      this._selectedHookKey = hookKey;
      const hook = this._hooks.get(hookKey);
      console.log(`[TextractorLauncher] Hook selection: MANUAL -> ${hook.fullName}`);
      // If the newly selected hook has pending text, emit it
      if (hook.lastText && this._looksLikeGameText(hook.lastText)) {
        const cleanedText = this._cleanGameText(hook.lastText);
        if (cleanedText && cleanedText.length >= 2) {
          const hash = crypto.createHash('md5').update(cleanedText).digest('hex');
          if (hash !== this._lastTextHash) {
            this._lastTextHash = hash;
            this.emit('text', cleanedText);
            this.emit('stdout-active');
          }
        }
      }
    } else {
      console.warn(`[TextractorLauncher] Cannot select unknown hook: ${hookKey}`);
    }
    this._emitHookDiscovery();
  }

  /**
   * Get all discovered hooks.
   */
  getHooks() {
    const hooks = [];
    for (const [key, hook] of this._hooks) {
      const cleanPreview = this._cleanGameText(hook.lastText || '');
      hooks.push({
        key: hook.key,
        name: hook.name,
        displayName: hook.displayName || hook.name,
        fullName: hook.fullName,
        hookCode: hook.hookCode || '',
        funcAddr: hook.funcAddr || '',
        processName: hook.processName || '',
        hookIndex: hook.hookIndex || 0,
        isSystemHook: hook.isSystemHook || false,
        lastText: cleanPreview.substring(0, 120),
        rawLastText: hook.lastText ? hook.lastText.substring(0, 120) : '',
        textCount: hook.textCount,
        hasCJK: hook.hasCJK,
        avgLength: hook.textCount > 0 ? Math.round(hook.totalTextLength / hook.textCount) : 0,
        qualityPenalty: hook.qualityPenalty || 0
      });
    }
    return hooks;
  }

  /**
   * Get the currently active hook key.
   */
  getActiveHookKey() {
    return this._selectedHookKey || this._autoSelectedHookKey;
  }

  /**
   * Auto-detect if a Buffer is UTF-16LE encoded.
   * Checks for the pattern: ASCII char followed by 0x00 byte repeatedly.
   * Returns true if >60% of even-indexed bytes are printable ASCII and
   * >60% of odd-indexed bytes are 0x00.
   */
  _isUtf16Le(buf) {
    if (buf.length < 4) return false;
    const checkLen = Math.min(buf.length, 40); // Check first 40 bytes
    let printableEven = 0;
    let nullOdd = 0;
    const pairs = Math.floor(checkLen / 2);
    for (let i = 0; i < pairs; i++) {
      const lo = buf[i * 2];
      const hi = buf[i * 2 + 1];
      if (lo >= 0x20 && lo < 0x7F) printableEven++;
      if (hi === 0x00) nullOdd++;
    }
    if (pairs < 2) return false;
    return (printableEven / pairs > 0.5 && nullOdd / pairs > 0.5);
  }

  /**
   * Clean game text before sending to translation pipeline.
   * v3.8.25: Fixes common Textractor text issues.
   *
   * Fixes applied:
   * 1. Strip null bytes and control characters
   * 2. Remove progressive counter patterns ("0\n0\n0..." or "1\n2\n3...")
   * 3. Split text by garbage digit delimiters and deduplicate repeated segments
   *    (e.g. "0I softly murmured to myself.0I softly murmured to myself.0" → "I softly murmured to myself.")
   * 4. Detect and fix doubled characters ("NNooww" → "Now")
   * 5. Strip excessive whitespace and leading/trailing garbage
   */
  _cleanGameText(text) {
    if (!text) return text;

    let cleaned = text;

    // 1. Strip null bytes and control characters (except newline, tab)
    cleaned = cleaned.replace(/[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, '');

    // 2. Remove progressive counter patterns
    //    Textractor sometimes outputs progressive char-by-char updates like:
    //    " 0\n  0\n   0\n    0" which are just cursor position indicators
    //    Remove lines that are just a number with leading/trailing whitespace
    cleaned = cleaned.split('\n')
      .filter(line => {
        const trimmed = line.trim();
        // Skip lines that are just a number
        if (/^\d+$/.test(trimmed) && trimmed.length <= 3) return false;
        // Skip lines that are only whitespace
        if (/^\s*$/.test(line)) return false;
        return true;
      })
      .join(' ');

    // 3. Split by garbage digit delimiters and deduplicate
    //    VN engines and Textractor often produce patterns like:
    //    "0I softly murmured to myself.0I softly murmured to myself.0"
    //    "0... Now that I'm on my own I'll have to do my best0"
    //    The "0" (or other single digits) act as delimiters between repeated text segments
    //    Strategy: split by isolated digit delimiters, collect non-empty segments,
    //    and keep only unique ones (deduplicate exact and near-duplicate repetitions)
    cleaned = this._deduplicateSegments(cleaned);

    // 4. Detect and fix doubled characters
    //    "NNooww tthhaatt" → "Now that"
    //    Check if stripping every other character produces more readable text
    if (this._isDoubledText(cleaned)) {
      const unDoubled = this._unDoubleText(cleaned);
      if (unDoubled && unDoubled.length > 0) {
        cleaned = unDoubled;
      }
    }

    // 5. Normalize whitespace
    cleaned = cleaned.replace(/[ \t]+/g, ' ').trim();
    // Collapse multiple newlines into single space (unless they're meaningful)
    cleaned = cleaned.replace(/\n+/g, ' ');

    // 6. Strip leading garbage: isolated digits/dots at the start
    //    "0I softly..." → "I softly..." (digit glued to letter = garbage delimiter)
    //    "0... Now that..." → "Now that..." (digit+dot prefix)
    //    ". Now that..." → "Now that..." (lone dot prefix)
    //    BUT: "3 hours" should NOT be stripped (number is part of the text)
    //    Strategy: strip leading digits/dots only when they're clearly garbage
    //    - A single digit followed by a letter (no space) = garbage: "0I..." → "I..."
    //    - Digits+dot followed by space and letter = garbage: "0... Now" → "Now"
    //    - Multiple digits followed by letter = garbage: "00I..." → "I..."
    cleaned = cleaned.replace(/^\d+(?=[A-Za-z])/, '');  // "0I..." → "I..."
    cleaned = cleaned.replace(/^\d*\.\s+/, '');          // "0. " or ". " → strip
    cleaned = cleaned.replace(/^\.{2,}\s*/, '');         // "... " → strip (ellipsis garbage)
    // Strip trailing garbage digits (NOT dots — those could be sentence-ending punctuation)
    //    "...to myself.0" → "...to myself." (only strip trailing digit)
    cleaned = cleaned.replace(/\d+\s*$/, '');

    // 7. Final cleanup: strip any remaining leading/trailing whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Split text by garbage digit delimiters and deduplicate repeated segments.
   *
   * Textractor + VN engines commonly produce text like:
   *   "0I softly murmured to myself.0I softly murmured to myself.0"
   *   "0... Now that I'm on my own0"
   *   "1Hello world2Hello world3"
   *
   * These digit delimiters are NOT part of the game text — they are
   * memory counters, buffer indicators, or rendering artifacts.
   *
   * Strategy:
   *   1. Split the text by isolated digit delimiters (single digits that separate segments)
   *   2. Collect non-empty, meaningful segments
   *   3. Deduplicate: if segments are identical or one is a prefix of another, keep the longest
   *   4. Return the deduplicated text
   */
  _deduplicateSegments(text) {
    if (!text || text.length < 4) return text;

    // Split by single-digit delimiters that separate text segments
    // Pattern: a digit (0-9) that acts as a boundary between text segments
    // e.g., "0I softly murmured.0I softly murmured.0" splits into ["I softly murmured.", "I softly murmured."]
    const segments = text.split(/\d+/)
      .map(s => s.trim())
      .filter(s => s.length >= 2); // Keep segments with at least 2 chars

    if (segments.length <= 1) {
      // No delimiters found or only one segment — return as-is
      return text;
    }

    // Deduplicate: find unique segments
    // Two segments are "duplicates" if:
    //   - They are identical (case-insensitive)
    //   - One is a prefix/suffix of the other
    const unique = [];
    for (const seg of segments) {
      let isDupe = false;
      for (let i = 0; i < unique.length; i++) {
        const existing = unique[i];
        // Exact duplicate (case-insensitive)
        if (existing.toLowerCase() === seg.toLowerCase()) {
          isDupe = true;
          break;
        }
        // One is a prefix of the other — keep the longer one
        if (existing.toLowerCase().startsWith(seg.toLowerCase()) ||
            seg.toLowerCase().startsWith(existing.toLowerCase())) {
          // Keep the longer segment
          if (seg.length > existing.length) {
            unique[i] = seg;
          }
          isDupe = true;
          break;
        }
        // One is a suffix of the other
        if (existing.toLowerCase().endsWith(seg.toLowerCase()) ||
            seg.toLowerCase().endsWith(existing.toLowerCase())) {
          if (seg.length > existing.length) {
            unique[i] = seg;
          }
          isDupe = true;
          break;
        }
        // Near-duplicate: very similar (Levenshtein-like check for short strings)
        // If 80%+ of characters match, consider it a duplicate
        if (seg.length > 5 && existing.length > 5) {
          const shorter = seg.length < existing.length ? seg : existing;
          const longer = seg.length < existing.length ? existing : seg;
          let matchCount = 0;
          for (let j = 0; j < shorter.length; j++) {
            if (shorter[j].toLowerCase() === longer[j].toLowerCase()) {
              matchCount++;
            }
          }
          if (matchCount / shorter.length > 0.85) {
            if (seg.length > existing.length) {
              unique[i] = seg;
            }
            isDupe = true;
            break;
          }
        }
      }
      if (!isDupe) {
        unique.push(seg);
      }
    }

    // If deduplication reduced multiple segments to 1, return that
    if (unique.length === 1) {
      return unique[0];
    }

    // If we still have multiple unique segments, join them
    // (they might be different parts of the dialogue)
    return unique.join(' ');
  }

  /**
   * Check if text has doubled characters pattern.
   * "NNooww" → each pair has same char → true
   */
  _isDoubledText(text) {
    if (!text || text.length < 6) return false;
    const stripped = text.replace(/\s+/g, '');
    if (stripped.length < 6) return false;
    let doubledPairs = 0;
    let totalPairs = 0;
    for (let i = 0; i < stripped.length - 1; i += 2) {
      totalPairs++;
      if (stripped[i] === stripped[i + 1]) {
        doubledPairs++;
      }
    }
    if (totalPairs < 3) return false;
    return (doubledPairs / totalPairs) > 0.6;
  }

  /**
   * Fix doubled text by taking every other character.
   * "NNooww  tthhaatt" → "Now that"
   */
  _unDoubleText(text) {
    if (!text) return text;
    // Process character by character, keeping one of each doubled pair
    let result = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      // If next char is same, skip it (un-double)
      if (i + 1 < text.length && text[i + 1] === ch) {
        result += ch;
        i += 2; // Skip the doubled char
      } else {
        result += ch;
        i++;
      }
    }
    return result;
  }

  /**
   * Process stdout data — with UTF-16LE auto-detection, BOM stripping, hex dump diagnostics.
   * v3.8.24: Auto-detects UTF-16LE encoding from TextractorCLI on Windows.
   */
  _processStdoutData(data) {
    // v3.8.24: Auto-detect encoding on first data event
    if (this._detectedEncoding === null && data.length >= 4) {
      if (this._isUtf16Le(data)) {
        this._detectedEncoding = 'utf16le';
        console.log(`[TextractorLauncher] Detected UTF-16LE encoding from TextractorCLI`);
      } else {
        this._detectedEncoding = 'utf8';
        console.log(`[TextractorLauncher] Detected UTF-8 encoding from TextractorCLI`);
      }
    }

    // Decode using detected encoding (fallback to utf8)
    const encoding = this._detectedEncoding || 'utf8';
    const chunk = data.toString(encoding);
    this._stdoutBuffer += chunk;
    this._dataEventCount++;

    // Split lines — for UTF-16LE, newlines may have been decoded already
    const lines = this._stdoutBuffer.split('\n');
    this._stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const sanitized = this._sanitizeLine(line);
      const trimmedLine = sanitized.trim();
      if (!trimmedLine) continue;

      this._totalLinesProcessed++;

      // HEX DUMP first N lines for encoding diagnostics
      if (this._hexDumpCount < this._maxHexDumps) {
        this._hexDumpCount++;
        console.log(`[TextractorLauncher] HEX #${this._hexDumpCount}: ${this._hexDump(trimmedLine)}`);
      }

      // Filter out our own echo noise (NOT hook types!)
      if (this._isOwnEcho(trimmedLine)) {
        continue;
      }

      // Log all non-echo lines
      console.log(`[TextractorLauncher] LINE: "${trimmedLine.substring(0, 150)}"`);

      // Store in output buffer
      this._outputBuffer.push(trimmedLine);
      if (this._outputBuffer.length > this._maxBufferLines) {
        this._outputBuffer.shift();
      }

      // v3.8.23: Store in stdout tail for error context
      this._stdoutTail.push(trimmedLine);
      if (this._stdoutTail.length > this._maxStdoutTail) {
        this._stdoutTail.shift();
      }

      this.emit('output', trimmedLine);

      // Try to parse as a hook line
      const parsed = this._parseHookLine(trimmedLine);
      if (parsed) {
        this._processHookLine(parsed);
      } else {
        // Non-hook line that might still contain game text
        // (fallback: emit CJK text that doesn't match hook format)
        if (this._hasCJK(trimmedLine) && trimmedLine.length >= 2) {
          const cleanedCJK = this._cleanGameText(trimmedLine);
          if (cleanedCJK && cleanedCJK.length >= 2) {
            const hash = crypto.createHash('md5').update(cleanedCJK).digest('hex');
            if (hash !== this._lastTextHash) {
              this._lastTextHash = hash;
              console.log(`[TextractorLauncher] CJK TEXT (no hook): "${cleanedCJK.substring(0, 80)}"`);
              this.emit('text', cleanedCJK);
              this.emit('stdout-active');
            }
          }
        }
      }
    }
  }

  /**
   * Test if TextractorCLI can start without attaching to any process.
   * This verifies that the executable is valid, DLLs are present, etc.
   * Returns { canStart, exitCode, stderr, stdout, hint }
   */
  async testLaunch(cliPath) {
    const testPath = cliPath || this.cliPath;
    if (!testPath) {
      return { canStart: false, exitCode: -1, stderr: '', stdout: '', hint: 'Ruta a TextractorCLI no configurada' };
    }

    const validation = this.validatePath(testPath);
    if (!validation.valid) {
      return { canStart: false, exitCode: -1, stderr: '', stdout: '', hint: validation.message };
    }

    // Use the auto-resolved path from validation (folder -> x64/Textractor.exe)
    const resolvedPath = validation.resolved;

    return new Promise((resolve) => {
      let testStdout = '';
      let testStderr = '';
      let settled = false;

      const finish = (canStart, exitCode, hint) => {
        if (settled) return;
        settled = true;
        resolve({ canStart, exitCode, stderr: testStderr.trim(), stdout: testStdout.trim(), hint, resolvedPath });
      };

      try {
        const spawnOptions = {
          cwd: path.dirname(resolvedPath),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env }
        };

        if (process.platform === 'win32') {
          spawnOptions.windowsHide = true;
        }

        const testProc = spawn(resolvedPath, [], spawnOptions);

        // Timeout — if it runs for 3 seconds without crashing, it started OK
        const timeout = setTimeout(() => {
          try { testProc.kill(); } catch (e) { /* ignore */ }
          finish(true, 0, 'TextractorCLI inició correctamente');
        }, 3000);

        testProc.stdout.on('data', (data) => {
          testStdout += data.toString('utf8');
        });

        testProc.stderr.on('data', (data) => {
          testStderr += data.toString('utf8');
        });

        testProc.on('close', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0 || testStdout.length > 0) {
            // Exited with code 0 or produced output = it can start
            finish(true, code || 0, 'TextractorCLI inició correctamente (código: ' + code + ')');
          } else {
            const interpreted = interpretExitCode(code);
            let hintMsg = interpreted.hint || 'No se pudo iniciar TextractorCLI';
            if (testStderr.includes('DLL') || testStderr.includes('dll')) {
              hintMsg = 'DLL faltante. Instala Visual C++ Redistributable 2015-2022.';
            }
            if (testStderr.includes('bit') || testStderr.includes('architecture')) {
              hintMsg = 'Arquitectura incorrecta. Usa TextractorCLI de 64 bits para juegos de 64 bits.';
            }
            finish(false, code, hintMsg);
          }
        });

        testProc.on('error', (err) => {
          clearTimeout(timeout);
          let hintMsg = 'No se pudo ejecutar TextractorCLI';
          if (err.code === 'ENOENT') hintMsg = 'Archivo no encontrado: ' + resolvedPath;
          else if (err.code === 'EACCES') hintMsg = 'Permiso denegado. Ejecuta como Administrador.';
          else if (err.code === 'EPERM') hintMsg = 'Permiso denegado por el sistema. Antivirus bloqueando?';
          finish(false, -1, hintMsg);
        });
      } catch (err) {
        finish(false, -1, 'Error al lanzar: ' + err.message);
      }
    });
  }

  /**
   * Get the last detailed error information.
   * Returns null if no error has occurred.
   */
  getLastError() {
    return this._lastError;
  }

  /**
   * Build a structured error object with all diagnostic information.
   */
  _buildError(message, code, extra = {}) {
    const interpreted = code !== undefined ? interpretExitCode(code) : { severity: 'error', hint: '' };
    const error = {
      message,
      code: code !== undefined ? code : null,
      severity: interpreted.severity,
      hint: interpreted.hint || extra.hint || '',
      stderr: this._stderrLines.join('\n').trim(),
      stdout: this._stdoutTail.join('\n').trim(),
      gamePid: this._gamePid,
      cliPath: this.cliPath,
      timestamp: Date.now()
    };
    this._lastError = error;
    return error;
  }

  /**
   * Launch TextractorCLI.
   */
  launch(pid, options = {}) {
    const cliPath = options.cliPath || this.cliPath;
    if (!cliPath) {
      const err = this._buildError('TextractorCLI path not configured', undefined, { hint: 'Configura la ruta a TextractorCLI.exe en la sección de Textractor.' });
      this.emit('error', err);
      return false;
    }

    if (this.isRunning) {
      this.kill();
    }

    const validation = this.validatePath(cliPath);
    if (!validation.valid) {
      const err = this._buildError(validation.message, undefined, { hint: 'Verifica que la ruta a TextractorCLI.exe o la carpeta de Textractor sea correcta.' });
      this.emit('error', err);
      return false;
    }

    // Use the auto-resolved path from validation (folder -> x64/Textractor.exe)
    const resolvedPath = validation.resolved;

    const gamePid = options.pid || pid;
    if (!gamePid || isNaN(gamePid)) {
      const err = this._buildError('Invalid game PID', undefined, { hint: 'Ingresa un PID válido del juego (número positivo). Encuéntralo en el Administrador de Tareas → Detalles.' });
      this.emit('error', err);
      return false;
    }

    this._gamePid = gamePid;
    this._launchTime = Date.now();

    try {
      // === SPAWN WITH NO ARGUMENTS ===
      const args = [];
      console.log(`[TextractorLauncher] Spawning: "${resolvedPath}" (NO args)`);
      console.log(`[TextractorLauncher] Will send "attach -P${gamePid}" via stdin IMMEDIATELY + after 1.5s`);

      const spawnOptions = {
        cwd: path.dirname(resolvedPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      };

      if (process.platform === 'win32') {
        spawnOptions.windowsHide = true;
      }

      this.process = spawn(resolvedPath, args, spawnOptions);

      this.isRunning = true;
      this._outputBuffer = [];
      this._stdoutBuffer = '';
      this._lastTextHash = '';
      this._stdinSent = false;
      this._dataEventCount = 0;
      this._hexDumpCount = 0;
      this._totalLinesProcessed = 0;
      this._hookLinesProcessed = 0;

      // Reset error capture state (v3.8.23)
      this._stderrLines = [];
      this._stdoutTail = [];
      this._lastError = null;

      // Reset hook discovery state
      this._hooks.clear();
      this._selectedHookKey = null;
      this._autoSelectedHookKey = null;
      this._hookDiscoveryPhase = false;
      this._detectedEncoding = null; // v3.8.24: Reset encoding detection
      if (this._hookDiscoveryTimer) {
        clearTimeout(this._hookDiscoveryTimer);
        this._hookDiscoveryTimer = null;
      }

      // Clean up timers
      if (this._stdinTimer) { clearTimeout(this._stdinTimer); this._stdinTimer = null; }
      if (this._diagnosticTimer) { clearTimeout(this._diagnosticTimer); this._diagnosticTimer = null; }

      // === SEND ATTACH VIA STDIN IMMEDIATELY ===
      this._sendStdinAttach(gamePid, 'immediate');

      // === ALSO SEND AFTER 1.5 SECONDS AS BACKUP ===
      this._stdinTimer = setTimeout(() => {
        this._stdinTimer = null;
        this._sendStdinAttach(gamePid, 'delayed-1.5s');
      }, 1500);

      // === HOOK DISCOVERY PHASE ===
      // After 3 seconds, finalize initial hook discovery
      setTimeout(() => {
        this._hookDiscoveryPhase = true;
        this._emitHookDiscovery();
        console.log(`[TextractorLauncher] Hook discovery phase complete. ${this._hooks.size} hooks found.`);
      }, 3000);

      // === 10-SECOND DIAGNOSTIC CHECK ===
      this._diagnosticTimer = setTimeout(() => {
        this._diagnosticTimer = null;
        const activeHook = this.getActiveHookKey();
        console.warn(`[TextractorLauncher] 10s DIAGNOSTIC:`);
        console.warn(`[TextractorLauncher]   Total hooks: ${this._hooks.size}`);
        console.warn(`[TextractorLauncher]   Active hook: ${activeHook || 'none'}`);
        console.warn(`[TextractorLauncher]   Lines processed: ${this._totalLinesProcessed} (hook lines: ${this._hookLinesProcessed})`);
        if (this._hooks.size === 0) {
          console.warn(`[TextractorLauncher]   *** NO HOOKS FOUND! ***`);
          console.warn(`[TextractorLauncher]   Possible causes:`);
          console.warn(`[TextractorLauncher]     1. PID ${gamePid} is not a valid game process`);
          console.warn(`[TextractorLauncher]     2. TextractorCLI didn't receive the attach command`);
          console.warn(`[TextractorLauncher]     3. Game is not producing text through hookable APIs`);
          console.warn(`[TextractorLauncher]   Try: Run TextractorCLI.exe manually in a terminal and type "attach -P${gamePid}"`);
        }
      }, 10000);

      this.emit('status', 'launched');
      this.emit('launched', { pid: gamePid, cliPath: resolvedPath });
      console.log(`[TextractorLauncher] Launched — stdin immediate + delayed, hook discovery ON`);

      // === CAPTURE STDOUT ===
      this.process.stdout.on('data', (data) => {
        const sizeKB = Math.round(data.length / 1024);
        if (this._dataEventCount < 10 || sizeKB > 0) {
          console.log(`[TextractorLauncher] stdout event #${this._dataEventCount + 1}: ${data.length} bytes${sizeKB > 0 ? ` (${sizeKB}KB)` : ''}`);
        }
        this._processStdoutData(data);
      });

      // === CAPTURE STDERR (v3.8.23: improved capture) ===
      this.process.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          console.log(`[TextractorLauncher] stderr: "${text.substring(0, 200)}"`);
          // v3.8.23: Store stderr for error reporting
          this._stderrLines.push(text);
          if (this._stderrLines.length > 50) {
            this._stderrLines.shift();
          }
          this._outputBuffer.push('[stderr] ' + text);
          if (this._outputBuffer.length > this._maxBufferLines) this._outputBuffer.shift();
          this.emit('output', text);
        }
      });

      // === PROCESS EXIT (v3.8.23: detailed error reporting) ===
      this.process.on('close', (code, signal) => {
        const runTime = this._launchTime ? Math.round((Date.now() - this._launchTime) / 1000) : 0;
        this.isRunning = false;
        this.process = null;
        this._stdoutBuffer = '';
        this._clearTimers();

        console.log(`[TextractorLauncher] Process exited: code=${code}, signal=${signal}, ranFor=${runTime}s`);
        console.log(`[TextractorLauncher] Final stats: hooks=${this._hooks.size}, hookLines=${this._hookLinesProcessed}, totalLines=${this._totalLinesProcessed}`);

        if (runTime < 2 && code !== 0) {
          console.warn(`[TextractorLauncher] Process exited quickly with code=${code} — attach likely failed`);

          // Build detailed error info
          let hint = '';
          const stderrText = this._stderrLines.join('\n').trim();

          // Common error patterns
          if (stderrText.includes('DLL') || stderrText.includes('dll') || stderrText.includes('VCRUNTIME')) {
            hint = 'DLL faltante. Instala Visual C++ Redistributable 2015-2022 (x64 para Textractor de 64 bits).';
          } else if (stderrText.includes('bit') || stderrText.includes('architecture') || stderrText.includes('x86')) {
            hint = 'Arquitectura incorrecta. Usa TextractorCLI de 64 bits para juegos de 64 bits, y 32 bits para juegos de 32 bits.';
          } else if (code === 1 && this._totalLinesProcessed === 0) {
            hint = 'TextractorCLI no pudo iniciar. Verifica que el archivo no esté corrupto y que las DLLs estén presentes.';
          } else if (code === 1 && this._totalLinesProcessed > 0) {
            hint = 'El attach al PID ' + gamePid + ' falló. Verifica que el PID sea correcto y que el proceso sea accesible.';
          } else if (code === 5) {
            hint = 'Acceso denegado. Intenta ejecutar Tuhua Translator como Administrador.';
          } else {
            const interpreted = interpretExitCode(code);
            hint = interpreted.hint || 'Verifica que el PID sea correcto y que TextractorCLI funcione manualmente.';
          }

          const error = this._buildError(
            `TextractorCLI salió con código ${code} tras ${runTime}s`,
            code,
            { hint }
          );
          this.emit('error', error);
        }

        this.emit('status', 'exited');
        this.emit('exited', { code, signal });
      });

      // === SPAWN ERROR (v3.8.23: better messages) ===
      this.process.on('error', (err) => {
        this.isRunning = false;
        this.process = null;
        this._stdoutBuffer = '';
        this._clearTimers();
        console.error(`[TextractorLauncher] Spawn error:`, err.message);

        let hint = '';
        if (err.code === 'ENOENT') {
          hint = 'Archivo no encontrado. Verifica la ruta a TextractorCLI.exe.';
        } else if (err.code === 'EACCES' || err.code === 'EPERM') {
          hint = 'Permiso denegado. Ejecuta Tuhua Translator como Administrador.';
        } else if (err.code === 'EINVAL') {
          hint = 'Ruta inválida. Verifica que la ruta no contenga caracteres especiales.';
        }

        const error = this._buildError(
          'No se pudo iniciar TextractorCLI: ' + err.message,
          undefined,
          { hint }
        );
        this.emit('error', error);
        this.emit('status', 'error');
      });

      return true;
    } catch (err) {
      const error = this._buildError('Error al lanzar: ' + err.message);
      this.emit('error', error);
      this.emit('status', 'error');
      return false;
    }
  }

  /**
   * Send the attach command via stdin.
   */
  _sendStdinAttach(gamePid, label) {
    if (this.process && this.process.stdin && !this.process.stdin.destroyed && this.isRunning) {
      const cmd = `attach -P${gamePid}\n`;
      console.log(`[TextractorLauncher] Sending stdin (${label}): "${cmd.trim()}"`);
      try {
        this.process.stdin.write(cmd);
        this._stdinSent = true;
      } catch (stdinErr) {
        console.error(`[TextractorLauncher] stdin write failed (${label}):`, stdinErr.message);
      }
    } else {
      console.warn(`[TextractorLauncher] Cannot send stdin (${label}) — process not available`);
    }
  }

  /**
   * Clear all timers.
   */
  _clearTimers() {
    if (this._stdinTimer) { clearTimeout(this._stdinTimer); this._stdinTimer = null; }
    if (this._diagnosticTimer) { clearTimeout(this._diagnosticTimer); this._diagnosticTimer = null; }
    if (this._hookDiscoveryTimer) { clearTimeout(this._hookDiscoveryTimer); this._hookDiscoveryTimer = null; }
  }

  kill() {
    this._clearTimers();

    if (this.process && this.isRunning) {
      try {
        if (this.process.stdin && !this.process.stdin.destroyed) {
          try { this.process.stdin.write(`detach -P${this._gamePid}\n`); } catch (e) { /* ignore */ }
        }
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(this.process.pid), '/f'], { windowsHide: true });
        } else {
          this.process.kill('SIGTERM');
        }
      } catch (e) {
        try { this.process.kill('SIGKILL'); } catch (e2) { /* ignore */ }
      }
      this.isRunning = false;
      this.process = null;
      this._stdoutBuffer = '';
      this.emit('status', 'killed');
    }
  }

  getOutput() { return this._outputBuffer.join('\n'); }
  clearOutput() { this._outputBuffer = []; }
  getProcessPid() { return this.process ? this.process.pid : null; }
  isConfigured() { return !!this.cliPath; }

  getStats() {
    return {
      isRunning: this.isRunning,
      dataEventCount: this._dataEventCount,
      totalHooks: this._hooks.size,
      hookLinesProcessed: this._hookLinesProcessed,
      totalLinesProcessed: this._totalLinesProcessed,
      stdinSent: this._stdinSent,
      activeHookKey: this.getActiveHookKey(),
      selectedHookKey: this._selectedHookKey,
      autoSelectedHookKey: this._autoSelectedHookKey,
      launchTime: this._launchTime,
      runTimeMs: this._launchTime ? Date.now() - this._launchTime : 0,
      lastError: this._lastError
    };
  }
}

module.exports = TextractorLauncher;
