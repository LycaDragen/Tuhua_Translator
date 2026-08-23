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
const { spawn, execSync, exec } = require('child_process');
const { StringDecoder } = require('string_decoder');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const textCleaning = require('./text-cleaning');
const { detectGameEngine } = require('./game-engine-detect');
const { detectExeArch } = require('./pe-arch');

/**
 * Interpret Windows exit codes into human-readable messages.
 */
function interpretExitCode(code) {
  // v3.13.24: every branch now returns hintKey (+ optional hintParams) so
  // the renderer can show this translated instead of the hardcoded Spanish
  // that used to ship straight from the backend regardless of UI language.
  // `hint` stays as the English fallback (used if a key/translation is
  // missing, and for log lines).
  if (code === 0) return { severity: 'ok', hintKey: null, hint: '' };
  if (code === 1) return { severity: 'error', hintKey: 'err_code_general', hint: 'General TextractorCLI error. Could be an invalid PID or an internal error.' };
  if (code === 2) return { severity: 'error', hintKey: 'err_code_file_not_found', hint: 'File not found. Verify that TextractorCLI.exe and its DLLs exist.' };
  if (code === 5) return { severity: 'error', hintKey: 'err_code_access_denied', hint: 'Access denied. Try running as Administrator.' };
  if (code === 0xC0000135) return { severity: 'critical', hintKey: 'err_dll_missing', hint: 'DLL not found. Install Visual C++ Redistributable (x64 or x86 depending on your Textractor).' };
  if (code === 0xC0000005) return { severity: 'critical', hintKey: 'err_access_violation', hint: 'Access violation (crash). TextractorCLI failed to start — possible incompatibility or wrong DLL.' };
  if (code === 0xC0000142) return { severity: 'critical', hintKey: 'err_dll_init_failure', hint: 'DLL initialization failure. Reinstall Visual C++ Redistributable.' };
  if (code === 0xE0434352) return { severity: 'critical', hintKey: 'err_dotnet_exception', hint: 'Unhandled .NET exception. TextractorCLI has an internal error.' };
  // Generic negative codes on Windows (signed interpretation of HRESULT).
  // Reuses the same keys as the direct-code checks above — same underlying
  // cause, only reached via a different branch (HRESULT-style negative
  // code vs. a small positive exit code).
  if (code < 0 && code >= -0xFFFF) {
    const unsigned = code >>> 0;
    if (unsigned === 0xC0000135) return { severity: 'critical', hintKey: 'err_dll_missing', hint: 'DLL not found. Install Visual C++ Redistributable.' };
    if (unsigned === 0xC0000005) return { severity: 'critical', hintKey: 'err_access_violation', hint: 'Access violation. TextractorCLI crashed.' };
    if (unsigned === 0xC0000142) return { severity: 'critical', hintKey: 'err_dll_init_failure', hint: 'DLL initialization failure. Reinstall VC++ Redist.' };
    return { severity: 'error', hintKey: 'err_windows_system', hintParams: { code: `0x${unsigned.toString(16).toUpperCase()}` }, hint: `Windows system error (0x${unsigned.toString(16).toUpperCase()}).` };
  }
  return { severity: 'error', hintKey: 'err_exit_code', hintParams: { code: String(code) }, hint: `Exit code: ${code}` };
}

/**
 * v3.13.24: known-good hook codes for common Win32 GDI/D3DX text functions,
 * sent proactively alongside `attach` (not reactively after detecting bad
 * text — see the comment on _sendKnownGoodHooks for why).
 *
 * Confirmed real-world case, not guessed: TextractorCLI's own generic
 * auto-engine (used as a fallback when a game's specific VN engine isn't
 * recognized — happened here for a KiriKiriZ-based game) blanket-hooks a
 * long list of standard Win32 text-drawing APIs with a generic hook-code
 * type. For some of those functions that generic type misreads the string
 * parameters and produces garbled text — confirmed with Nekopara Vol.1: the
 * auto-inserted hook for `GetTextExtentPoint32W` used type `HB0@0` and
 * produced garbage, while the CORRECT type for this function (its `int
 * cbString` parameter gives an explicit length, which needs a
 * length-aware hook type, not the generic one) is `HQ8@0` — found by the
 * user via the Textractor GUI's manual hook search, at the exact same
 * memory address as the broken auto-inserted hook.
 *
 * Deliberately NOT a large table: every entry here must be verified
 * against a real game before being added, the same standard already used
 * for the HOOK-cleaning algorithms in text-cleaning.js — a wrong hook code
 * sent to TextractorCLI wastes the user's time same as a wrong text-
 * cleaning heuristic would. Extend this list only from confirmed reports.
 *
 * v3.13.25 note, also confirmed real: on this same game, x86 TextractorCLI
 * hooked GetTextExtentPoint32W with the CORRECT code automatically, with no
 * manual insertion needed at all — x64's auto-engine was specifically the
 * one that got it wrong. So this table's proactive insertion is a
 * second-line fallback; _attemptArchFallback (see textractor-launcher's
 * arch-fallback logic) trying x86 first is the higher-leverage fix for
 * this exact failure mode and is why its trigger condition was extended
 * to cover "hooks exist but none are clean," not just "zero hooks."
 */
const KNOWN_GOOD_HOOK_CODES = [
  // Confirmed against Nekopara Vol.1 (KiriKiriZ, generic-engine fallback
  // path) — see the comment above.
  'HQ8@0:gdi32.dll:GetTextExtentPoint32W'
];

// v3.13.35: what a well-formed stdin command to TextractorCLI looks like —
// see _writeStdinCommand's doc for the full story. TextractorCLI's own
// parser is `swscanf(input, L"%500s -P%d", command, &processId)`: %s stops
// at the first whitespace, so a command token containing a space silently
// truncates the match; if the match fails at all, TextractorCLI calls
// ExitProcess(0) — not an error, a clean-looking exit that's easy to
// mistake for "the game closed" or "nothing went wrong." This regex is the
// last line of defense against ever sending something that would trigger
// that, regardless of which caller composed the string.
const STDIN_COMMAND_RE = /^\S+ -P\d+\n$/;

// v3.13.36: canonical hook-line layout, transcribed LITERALLY from the
// single printf that produces every hook line TextractorCLI ever emits
// (Artikash/Textractor, host/CLI/main.cpp):
//
//   wprintf_s(L"[%I64X:%I32X:%I64X:%I64X:%I64X:%s:%s] %s\n",
//       thread.handle,        // %I64X  HEX
//       thread.tp.processId,  // %I32X  HEX
//       thread.tp.addr,       // %I64X  HEX
//       thread.tp.ctx,        // %I64X  HEX
//       thread.tp.ctx2,       // %I64X  HEX
//       thread.name.c_str(),          // can be the EMPTY string
//       HookCode::Generate(...),      // CAN CONTAIN ':'
//       output.c_str());
//
// Seven fields. Four things the three previous patches to this regex
// (v3.13.27 the hook index, v3.13.28 the hex index, and the original
// heuristic before either) never saw, because none of them had read this
// printf:
//
//   1. All FIVE numeric fields are %X. There is not one %d in the source.
//      Any `\d+` here is a latent bug that only surfaces once the process
//      involved happens to have a PID with a letter in it. Confirmed real:
//      pid=59C4 — the old `(\d+)` for the PID group failed to match, with
//      no possible backtrack, and all 13 real hooks in that session fell
//      through to the old generic FORMAT D with hookCode:'' and the SAME
//      displayName (the process name) — indistinguishable in the UI's
//      hook selector.
//   2. `name` can be the empty string. The "::" the old FORMAT A treated
//      as a literal separator is NOT a separator: it's ':' + empty-name +
//      ':'. That's why FORMAT A could never parse a hook that DID have a
//      name (Console/Clipboard) and a whole separate FORMAT B had to be
//      invented for the exact same printf.
//   3. `hookCode` comes from HookCode::Generate and CONTAINS ':'
//      ("HB0@0:nekopara_vol1_trial.exe",
//      "HQ8@0:gdi32.dll:GetTextExtentPoint32W"). `[^:]+` could never
//      capture it. Even with the \d+ fixed, FORMAT A was still wrong.
//   4. The TEXT itself can contain ']'. The closing ']' that terminates
//      the bracket is the first one after a well-formed hookCode — hence
//      hookCode is captured with `[^:\]]*`/`[^\]]*` (never crosses a ']'),
//      not `.*`.
//
// IF THIS REGEX EVER STOPS MATCHING: don't patch a field blind. Go back to
// the printf in host/CLI/main.cpp and diff it field by field first.
//
// Complexity: linear. Every character class is disjoint and there's no
// nested quantification — this runs on every stdout line, it can't be
// allowed to backtrack catastrophically.
const HOOK_LINE_RE = /^\[([0-9A-Fa-f]+):([0-9A-Fa-f]+):([0-9A-Fa-f]+):([0-9A-Fa-f]+):([0-9A-Fa-f]+):([^:\]]*):([^\]]*)\]\s*([\s\S]*)$/;

// v3.13.36: signature of "a single-byte-type hook pointed at a buffer
// that's actually UTF-16LE" — see _utf16ByteGarbageRatio's doc for the
// full mechanics (kana/kanji code points have a fixed low byte of 0x30 in
// UTF-16LE, which is the ASCII digit '0', so each CJK character reads back
// as "<char>0" when consumed one byte at a time).
const UTF16_BYTE_RUN_RE = /(?:[^0\s]0){3,}/g;
const UTF16_GARBAGE_RATIO_STRONG = 0.6;
const UTF16_GARBAGE_RATIO_WEAK = 0.35;
const UTF16_GARBAGE_MIN_LEN = 8;

// v3.13.36: CJK bonus in _scoreHook moved from a sticky boolean to a
// ratio — see hook.hasCJK's update site in _processHookLine for why a
// boolean let UTF-16-byte garbage collect the same +1000 real Japanese
// dialogue gets. CJK_RATIO_STRONG is where the full bonus applies;
// CJK_RATIO_UI is a much lower bar just for showing the 🎌 badge in the
// hook selector (kept intentionally generous there — a hook worth
// flagging as "has some Japanese" doesn't need to be majority-Japanese).
const CJK_RATIO_STRONG = 0.30;
const CJK_RATIO_UI = 0.05;

// v3.13.37: staleness penalty — a hook that keeps re-emitting the SAME
// content (a game menu re-rendering on every frame) was scoring almost
// identically to a hook producing one line of real, new dialogue, because
// v3.13.36's dedup already caps textCount at 1 for both ("says the same
// thing" vs "says something new" look alike once textCount stops growing).
// emitCount (raw emissions, tracked since v3.13.36 but unused in scoring
// until now) is the missing signal: textCount/emitCount is the ratio of
// NEW content to total emissions — low for a repeating menu, high for
// dialogue. NOVELTY_MIN_EMITS is an evidence floor so a freshly-discovered
// hook, or real dialogue that happens to repeat a short line ("...") a
// couple of times, isn't penalized before there's enough signal.
const NOVELTY_MIN_EMITS = 4;
const NOVELTY_RATIO_FLOOR = 0.5;
const NOVELTY_STALENESS_PENALTY_MAX = 700;

// v3.13.38: character-repetition garbage — the shape BOTH broken-hook
// families in the real Nekopara/KiriKiriZ x86 session produced, and the one
// thing _scoreHook had no signal for at all: the KiriKiriZ engine hook's
// growing redraw buffer (冠冠冠冠冠冠冠冠詞詞冠詞冠冠詞詞がが...) and the
// GetGlyphOutlineW per-character 5x repeat (目目目目目標標標標標来来来来来...).
// Both collected the FULL +1000 CJK bonus (their characters are real kanji)
// and then WON on avgLen, because garbage is longer than dialogue — the log
// printed the correct dialogue hook at 1047-1069 losing to garbage at 1110.
//
// Metric = coverage of adjacent-duplicate runs, plus how many DISTINCT
// characters participate in a run. Measured on the real samples:
//   KiriKiriZ redraw buffer     coverage 0.727, distinct 4
//   per-character 5x repeat     coverage 1.000, distinct 4
//   real dialogue (doubled)     coverage 0.000
//   menu label, plain JP prose  coverage 0.000
//   English prose ("letting")   coverage 0.129, distinct 3
//   doubled-char artifact       coverage 0.538 (rule 1 already owns it)
//
// An earlier candidate metric (unique chars / total chars) was REJECTED
// after measuring it: real English prose lands at 0.306 and the correct
// dialogue hook itself at 0.379, so any threshold that caught the garbage
// also condemned good text.
//
// REPEAT_RUN_DISTINCT_MIN is not decoration: a Japanese stretched-vowel
// scream ("きゃあああああああああああ", coverage 0.905) is legitimate dialogue
// and has distinct 1. Requiring 3+ different characters to be repeating is
// what separates "one long vowel" from "every character redrawn" — and
// qualityPenalty is sticky (worst-seen), so a false positive here would
// condemn a good hook for the rest of the session.
const REPEAT_RUN_COVERAGE_MIN = 0.60;
const REPEAT_RUN_DISTINCT_MIN = 3;
const REPEAT_RUN_MIN_LEN = 20;
const REPEAT_RUN_PENALTY = 900;

// v3.13.38: a hook whose text ends in sentence-terminating punctuation is
// emitting SENTENCES, not menu labels or a half-redrawn buffer. Checked
// against every hook in the real session — perfect separation, no
// exceptions: the dialogue hook ends in 。 or 」; the two menu hooks end in
// "(" and "x"; another noise hook ends in "["; the KiriKiriZ buffer ends
// mid-word. BONUS ONLY, never a penalty: a game or language that does not
// terminate its lines simply does not collect it, and every hook is then
// compared on exactly the terms that existed before.
const TERMINAL_PUNCT_RE = /[。．.！!？?…‥」』】〉》”"']$/;
const TERMINAL_PUNCT_BONUS = 250;

// v3.13.36: recent-content memory per hook for dedup in
// _isNewHookContent — bounded so a long session can't leak memory one
// hash at a time.
const HOOK_RECENT_HASH_LIMIT = 64;

// v3.13.27: how often (and for how long) the arch-fallback diagnostic
// re-checks hook state after the first look at 10s — see the comment on the
// diagnostic scheduling in launch() for why a single one-shot check isn't
// enough. 60s ceiling gives some headroom over the documented KiriKiriZ
// worst-case warm-up (~45s) elsewhere in this file. Deliberately still
// bounded, not unbounded/minutes: this cap only matters for the "no real
// hook yet" wait — the other case this diagnostic handles ("hooks exist but
// all generic") doesn't self-correct with more time (confirmed with a real
// 3.5min continuous session that stayed 100% HB0@0 throughout), so waiting
// longer there would only delay the fallback that's already known to be
// needed, not avoid it.
const ARCH_FALLBACK_CHECK_INTERVAL_MS = 5000;
const ARCH_FALLBACK_CHECK_MAX_MS = 60000;

// v3.13.29: minimum raw bytes to accumulate before deciding stdout's
// encoding. The old decoder decided on the first chunk with >= 4 bytes,
// which a real 1- or 3-byte first chunk defeats: that chunk decodes with
// the wrong default AND drops its trailing odd byte (the old carry-over
// only ran once encoding was already known to be utf16le), desyncing
// every later chunk — including the one the detector finally samples, so
// the whole session locks to the wrong encoding. Confirmed by direct
// reproduction against scripts/test-stdout-decoding.js's 'tiny' mode.
// 16 bytes = 8 UTF-16LE code units, enough for a meaningful heuristic and
// small enough to never delay the first line perceptibly against a real
// TextractorCLI process (its banner alone exceeds this on the first
// write). A decisive BOM short-circuits the wait regardless of size.
const ENCODING_SNIFF_MIN_BYTES = 16;

// v3.13.29: default byte budget for the raw-wire hex dump gated behind
// TUHUA_STDOUT_RAWDUMP — see _maybeDumpRawBytes.
const RAW_DUMP_DEFAULT_BUDGET = 512;

// v3.13.29: hook auto-selection hysteresis — see _autoSelectBestHook.
// The +200 switch threshold is fixed, but the incumbent hook's claim on it
// decays the longer it goes without producing new text. A menu hook that
// stops the moment the user leaves the menu goes silent almost
// immediately; a dialogue hook keeps producing. Without this, a menu hook
// with zero quality penalty can sit at a score a real dialogue hook needs
// ~20 lines (textCount contributes +10/line, capped at 50) to catch up to
// — confirmed as the mechanism behind an observed ~20-28s delay before the
// selector let go of a menu hook on a real KiriKiriZ session. No discount
// for the first STALE_HOOK_GRACE_MS of silence (a hook that JUST stopped
// producing shouldn't lose its claim to one bad tick), decaying linearly
// to zero — any better-scoring candidate wins outright — by
// STALE_HOOK_FULL_DECAY_MS.
const HOOK_SWITCH_THRESHOLD = 200;
const STALE_HOOK_GRACE_MS = 3000;
const STALE_HOOK_FULL_DECAY_MS = 15000;

class TextractorLauncher extends EventEmitter {
  constructor(hookCleaningSettings) {
    super();
    // v3.13.20: optional — if not passed (e.g. a test constructing this
    // class directly), _cleanGameText falls back to cleanHookText's
    // built-in defaults, which are the same values this service ships
    // with (all steps enabled, cjkOnly true).
    this.hookCleaningSettings = hookCleaningSettings || null;
    this.process = null;
    this.cliPath = '';
    this.isRunning = false;
    this._outputBuffer = [];
    this._maxBufferLines = 200;
    this._stdinTimer = null;
    this._stdinSent = false;
    // v3.13.32: how many times an attach/hook-code write actually
    // succeeded this session — see _attachWasAcknowledged and
    // getStats(). _stdinSent alone (above) can't tell 1 attach from 2.
    this._attachSendCount = 0;
    this._hookInsertCount = 0;
    // v3.13.32: TUHUA_FORCE_DOUBLE_ATTACH=1 restores the old unconditional
    // 1.5s backup attach — see _attachWasAcknowledged's doc for why the
    // default became conditional, and why an escape hatch exists at all
    // (every `attach` makes TextractorCLI inject texthook.dll and suspend
    // the game's threads — the user-visible freeze a real bug report was
    // about — so this is a real behavior change, not just a log toggle).
    this._forceDoubleAttach = process.env.TUHUA_FORCE_DOUBLE_ATTACH === '1';
    // v3.13.33: diagnostic-only escape hatch, set TUHUA_SHOW_CLI_WINDOW=1 to
    // spawn TextractorCLI with a visible console instead of windowsHide.
    // Was tested as a candidate cause for "hooks never engage automated"
    // (a real Windows session confirmed with a visible window that
    // windowsHide was NOT the cause) before the real root cause was found
    // and fixed in v3.13.35 (_writeStdinCommand: stdin needs UTF-16LE, not
    // the plain-string writes used everywhere before that). Left in as a
    // general-purpose diagnostic — seeing TextractorCLI's own console
    // output live is occasionally useful — not because windowsHide is
    // still a live suspect. Default (unset) keeps today's behavior.
    this._showCliWindow = process.env.TUHUA_SHOW_CLI_WINDOW === '1';
    // v3.13.32: reset per-launch — see the diagnostic's 'no-clean-hook'
    // branch, the new call site for _sendKnownGoodHooks.
    this._knownGoodHooksSent = false;
    // v3.13.36: count of lines that needed _parseLegacyHookLine's fallback
    // formats instead of the canonical HOOK_LINE_RE — see _parseHookLine's
    // doc. Should stay at 0 against a real TextractorCLI; exposed via
    // getStats() so that claim can be checked with data before ever
    // deleting the fallback.
    this._legacyParseCount = 0;
    this._gamePid = null;
    // v3.13.76: result of detectGameEngine() for the current game process,
    // set async right after attach — null until it resolves (or forever, if
    // resolution fails silently, see _resolveExePathFromPid). Surfaced to the
    // UI via _emitHookDiscovery()'s `gameEngine` payload field.
    this._gameEngine = null;
    this._launchTime = null;
    this._diagnosticTimer = null;
    // v3.13.29: previously bare, uncancelable setTimeout calls — see
    // _clearTimers() and their respective call sites for what leaking
    // them broke.
    this._hookDiscoveryPhaseTimer = null;
    this._archRelaunchTimer = null;
    this._maxHexDumps = 10;

    // v3.13.29: raw wire-byte dump budget, off by default. Set
    // TUHUA_STDOUT_RAWDUMP=1 (or =N for an N-byte budget) to enable — see
    // _maybeDumpRawBytes. Read once here rather than per-chunk since
    // process.env doesn't change mid-session.
    const rawDumpEnv = process.env.TUHUA_STDOUT_RAWDUMP;
    const rawDumpParsed = rawDumpEnv ? Number.parseInt(rawDumpEnv, 10) : 0;
    this._rawDumpBudget = rawDumpEnv
      ? (Number.isFinite(rawDumpParsed) && rawDumpParsed > 1 ? rawDumpParsed : RAW_DUMP_DEFAULT_BUDGET)
      : 0;

    // v3.13.29: all stdout-decoding state lives in one place, set up here
    // and torn down/rebuilt by _resetStreamState() — see its doc for why a
    // single source of truth mattered (close/error/kill used to reset only
    // _stdoutBuffer, leaving _detectedEncoding and the byte carry-over
    // stuck from the previous session in those paths).
    this._resetStreamState();

    // === ARCHITECTURE FALLBACK STATE (v3.13.23) ===
    // Whether an x64<->x86 fallback has already been tried for the current
    // user-initiated launch — reset at the start of every launch() call that
    // isn't itself a fallback retry, so each fresh attempt gets one retry.
    this._archFallbackAttempted = false;
    // The fully-resolved exe path from the most recent launch() call, used
    // to compute the sibling-architecture candidate if this attempt fails.
    this._lastResolvedPath = null;
    // v3.13.32: (PID, install) -> { exhausted, exhaustedAt, triedPaths } —
    // see _archAttemptKey/_concludeArchFallback. This is what
    // _archFallbackAttempted alone couldn't provide: memory that survives
    // a fresh manual Launch, which is the loop-breaker for a real reported
    // "infinite intentando x86" bug. In-memory only, bounded FIFO — a
    // Tuhua restart is the deliberate way to clear it.
    this._archAttemptMemory = new Map();
    this._maxArchMemoryEntries = 20;
    // v3.13.32: install (_archInstallKey) -> the exe path PROVEN to
    // produce real game text there — see _markArchSuccess. Reused by
    // launch() so a fallback's discovery survives the user's next manual
    // Launch instead of silently reverting to whatever path they last
    // configured (5's own doc has the full story of why that mattered).
    this._archPreference = new Map();
    // v3.13.32: fires _markArchSuccess at most once per session — see its
    // call site in _processHookLine. Reset per-launch below.
    this._archSuccessMarked = false;

    // v3.13.32: true from the moment _attemptArchFallback decides to kill
    // the current process and respawn the sibling architecture, until the
    // replacement either reports 'launched' or fails outright. Read by
    // _emitStatus() to relabel the 'killed'/'exited' this deliberate kill
    // produces as 'relaunching' instead — see _emitStatus's doc for why
    // that distinction is load-bearing, not cosmetic.
    this._relaunchInProgress = false;
    // v3.13.32: identity of the CURRENT spawned process, incremented only
    // immediately after a successful spawn() (see launch()). Every event
    // handler attached to that child (stdout/stderr/close/error) captures
    // the generation it was created with and ignores itself if a NEWER
    // launch has since superseded it. Needed because kill() is
    // asynchronous — taskkill is a separate child process on Windows,
    // typically 50-400ms — so during an arch-fallback handover the dying
    // process's 'close' (and any stdout it had buffered) routinely arrives
    // AFTER the replacement process's own 'launched'. Without this, that
    // late 'close' would run _clearTimers()/_emitStatus('exited') against
    // session state that now belongs to the NEW process, undoing both the
    // relaunch bookkeeping and the UI's 'relaunching' status. Confirmed via
    // a dedicated bench case (relaunch-survives-late-close / stale-close-
    // ignored in scripts/test-launcher-lifecycle.js), not hypothetical.
    this._launchGeneration = 0;
    // v3.13.32: set by kill({ _forArchRelaunch: true }) — the ONLY caller
    // that passes it is _attemptArchFallback. Every other kill() call site
    // (8 of them: tray, ipc-handlers x5, index.js shutdown, launch()'s own
    // pre-relaunch kill) calls kill() with no arguments and gets the
    // ordinary "user/caller stopped this" behavior: cancel any pending
    // relaunch and clear ALL timers, not just this session's.
    this._killedByUser = false;

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
  }

  /**
   * Reset all per-session stdout-decoding state. Single source of truth for
   * "a new stdout stream starts now" — v3.13.29: previously this was
   * scattered (launch() reset _stdoutBuffer/_lastTextHash/_dataEventCount/
   * _hexDumpCount/_detectedEncoding/_rawByteCarry inline, while the close/
   * error/kill handlers only ever reset _stdoutBuffer, leaving the rest —
   * notably _detectedEncoding — stuck from the previous session in those
   * paths). Also used by scripts/test-stdout-decoding.js to reset between
   * fuzz cases without spawning a process.
   */
  _resetStreamState() {
    this._stdoutBuffer = '';
    this._stdoutDecoder = null;           // StringDecoder, created once the encoding is known
    this._detectedEncoding = null;        // null = still sniffing, else 'utf16le' | 'utf8'
    this._encodingSniffChunks = [];       // raw bytes held while still sniffing
    this._encodingSniffBytes = 0;
    this._rawBytesSeen = 0;               // absolute byte offset this session (diagnostic only)
    this._lastTextHash = '';
    this._dataEventCount = 0;
    this._hexDumpCount = 0;
    this._rawDumpBytesRemaining = this._rawDumpBudget;
  }

  /**
   * v3.13.32: single choke point for every 'status' emit. During an arch
   * fallback the process is killed and respawned ON PURPOSE, but the
   * renderer's updateCliStatus() treats 'killed'/'exited' as "the user
   * stopped it": it re-shows the Launch button and hides the whole status
   * bar 2s later — which erased the amber "x64 sin resultado, probando
   * x86..." notice and invited the click that restarted the whole 2x60s
   * cycle from scratch (confirmed real user report: the UI sat on "Launch"
   * while x86 was actually still running). Collapsing both into
   * 'relaunching' keeps the renderer in one honest state for the entire
   * handover, over the SAME 'textractor-cli-status-changed' channel — no
   * new IPC surface, deliberately: 'textractor-cli-pid-warning' is emitted
   * by this class but was missing from main-preload.js's
   * ALLOWED_RECEIVE_CHANNELS and never reached the renderer at all, which
   * this file is not going to repeat.
   */
  _emitStatus(status) {
    if (this._relaunchInProgress && (status === 'killed' || status === 'exited')) {
      status = 'relaunching';
    }
    this.emit('status', status);
  }

  configure(cliPath) {
    if (cliPath && cliPath !== this.cliPath) {
      const cleanPath = cliPath.replace(/^"+|"+$/g, '');
      // Auto-resolve: if user gave a folder, find the exe inside it
      const resolved = this._resolveExePath(cleanPath);
      this.cliPath = resolved;
      console.log(`[TextractorLauncher] Configured path: "${cleanPath}" -> "${resolved}"`);
      this._emitStatus('configured');
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
   * v3.13.8x: this x64-first order is a real cost for a 32-bit game — it's
   * the whole reason auto-detected installs used to guarantee the 60s
   * arch-fallback wait on the FIRST launch of e.g. a KiriKiriZ VN (see
   * textractor-path-detect.js's runAutoDetectAndPersist, which resolves
   * through this same function). Deliberately left as-is rather than
   * flipped: _preflightArchSwap (see launch()) now decides the correct
   * architecture from the GAME's own PE header before spawn whenever it
   * can, which makes this function's default order irrelevant in the
   * common case — flipping it would just move the same 60s penalty onto
   * 64-bit games instead of fixing anything. For the one case pre-flight
   * genuinely can't resolve (game exe unreadable — an elevated process is
   * the common real-world cause), _markArchSuccess's persisted
   * arch-resolved path already fixes future launches after the first one
   * that actually completes a 60s fallback.
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

  /**
   * v3.13.23: Given a resolved exe path that sits inside an x64/x86 (or
   * X64/X86) subfolder, return the equivalent path in the OTHER
   * architecture's subfolder — but only if that file actually exists on
   * disk. Returns null if resolvedPath isn't inside one of those subfolders
   * at all (e.g. the user pointed straight at a flat-layout .exe, or a
   * folder with no arch split) — that's deliberate: it means the user's
   * path gives no alternative architecture to fall back to, whether
   * because they made an explicit choice outside the x64/x86 convention or
   * because there simply isn't a sibling arch build available, and either
   * way there's nothing safe to retry.
   */
  /**
   * v3.13.8x: pre-flight architecture check, called from launch() before
   * spawn — see the call site's doc for ordering vs. _archPreference.
   *
   * A 32-bit Textractor cannot inject into a 64-bit game process and vice
   * versa — a hard OS constraint, not a heuristic. When gameExePath is
   * known (the "🎮 Elegir…" process picker in the renderer already
   * resolves it for free when the user picks the game that way — see
   * doLaunchTextractor's gameExePathHint in renderer.js), this decides the
   * correct architecture BEFORE spawning instead of discovering the
   * mismatch after up to ARCH_FALLBACK_CHECK_MAX_MS (60s) of silence.
   *
   * Measured against a real user's session logs (7 real Textractor
   * launches): 4 already had the right architecture (4.4-11.3s to first
   * dialogue); the other 3 paid the full ~60-76s fallback. This is what
   * collapses that 60s to effectively zero for the case this can resolve.
   *
   * Deliberately does NOT touch _archFallbackAttempted or
   * _archAttemptMemory — this runs before spawn, so it isn't a fallback
   * attempt at all, and the 60s safety net must stay fully armed for
   * whatever this can't resolve (see the degrade cases below — a wrapper
   * exe with a different architecture than the actual game process is a
   * real one: Textractor attaches to the PID given, so matching against
   * THAT PID's exe is correct by construction, but if the user picked a
   * launcher process rather than the game itself, this can be wrong and
   * the fallback needs to still be available to recover).
   *
   * Degrades to null (no swap) — silently, exactly today's behavior —
   * whenever: no gameExePath was given (PID typed by hand, no picker
   * used); the Textractor path's own arch can't be told from its folder
   * name (_detectArch); the game exe can't be read (elevated process —
   * the common real-world case, see _resolveExePathFromPid's doc —
   * deleted, corrupt, or just not a PE); the architectures already match;
   * or the sibling architecture folder doesn't exist on disk
   * (_getArchFallbackPath already checks that last one).
   *
   * @param {string} resolvedPath - the Textractor exe about to be spawned
   * @param {string|undefined} gameExePath
   * @returns {string|null} the swapped resolvedPath, or null if no swap
   */
  _preflightArchSwap(resolvedPath, gameExePath) {
    if (!gameExePath) return null;
    const textractorArch = this._detectArch(resolvedPath);
    if (!textractorArch) return null;
    const gameArch = detectExeArch(gameExePath);
    if (!gameArch || gameArch === textractorArch) return null;
    const fallback = this._getArchFallbackPath(resolvedPath);
    if (!fallback) return null;
    console.log(`[TextractorLauncher] Pre-flight arch check: game exe is ${gameArch}, configured Textractor is ${fallback.from} — switching to ${fallback.to} before spawn (would have needed the ${Math.round(ARCH_FALLBACK_CHECK_MAX_MS / 1000)}s fallback otherwise): "${resolvedPath}" -> "${fallback.path}"`);
    return fallback.path;
  }

  _getArchFallbackPath(resolvedPath) {
    if (!resolvedPath) return null;
    const pairs = [['x64', 'x86'], ['X64', 'X86'], ['x86', 'x64'], ['X86', 'X64']];
    for (const [from, to] of pairs) {
      const marker = path.sep + from + path.sep;
      const idx = resolvedPath.indexOf(marker);
      if (idx === -1) continue;
      const candidate = resolvedPath.slice(0, idx) + path.sep + to + path.sep + resolvedPath.slice(idx + marker.length);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate, from, to };
      } catch (e) { /* skip */ }
    }
    return null;
  }

  /**
   * v3.13.32: normalizes the arch segment out of a resolved exe path so
   * that <root>/x64/TextractorCLI.exe and <root>/x86/TextractorCLI.exe map
   * to ONE key — "already tried both architectures for this install" must
   * survive whichever half the persisted setting happens to point at.
   * Case-folded on win32 only (NTFS is case-insensitive; ext4/APFS aren't).
   */
  _archInstallKey(resolvedPath) {
    let base = String(resolvedPath || '');
    for (const arch of ['x64', 'X64', 'x86', 'X86']) {
      const marker = path.sep + arch + path.sep;
      const idx = base.indexOf(marker);
      if (idx !== -1) {
        base = base.slice(0, idx) + path.sep + '<arch>' + path.sep + base.slice(idx + marker.length);
        break;
      }
    }
    return process.platform === 'win32' ? base.toLowerCase() : base;
  }

  /**
   * v3.13.32: memory key for "have we already burned both architectures'
   * 60s windows on THIS game process without finding a real hook". Keyed
   * by (PID, install) rather than install alone — a different game/PID
   * deserves a fresh retry even against the same Textractor install.
   */
  _archAttemptKey(resolvedPath, gamePid) {
    return `${gamePid}::${this._archInstallKey(resolvedPath)}`;
  }

  /**
   * v3.13.37: best-effort x64/x86 label for the 'search-started' event's
   * UI countdown — same marker detection _archInstallKey normalizes away,
   * kept as a separate method because that one deliberately erases which
   * side it was (for the memoization key), and this needs the opposite.
   */
  _detectArch(resolvedPath) {
    const base = String(resolvedPath || '');
    if (base.includes(path.sep + 'x64' + path.sep) || base.includes(path.sep + 'X64' + path.sep)) return 'x64';
    if (base.includes(path.sep + 'x86' + path.sep) || base.includes(path.sep + 'X86' + path.sep)) return 'x86';
    return null;
  }

  /**
   * Store/update an entry in _archAttemptMemory with a bounded FIFO —
   * long sessions that cycle through many game PIDs shouldn't grow this
   * without limit. In-memory only, deliberately not persisted: restarting
   * Tuhua is the explicit, cheap way for a user to get a clean slate.
   */
  _rememberArchAttempt(key, record) {
    if (!this._archAttemptMemory.has(key) && this._archAttemptMemory.size >= this._maxArchMemoryEntries) {
      const oldestKey = this._archAttemptMemory.keys().next().value;
      this._archAttemptMemory.delete(oldestKey);
    }
    this._archAttemptMemory.set(key, record);
  }

  /**
   * v3.13.32: called when the arch-fallback diagnostic's 60s window ends
   * with no real hook and nothing left to retry — see
   * runArchFallbackCheck's tail in launch() for the two ways it gets here
   * (no sibling architecture at all, or the sibling was ALSO just tried
   * and also failed). Before this, that case just silently stopped
   * polling: the only signal the user had was the UI bouncing back to
   * "Launch" (fixed separately by _emitStatus's 'relaunching' mapping),
   * which is exactly the click that used to restart the whole 2x60s cycle
   * — a real, reported infinite loop, not a hypothetical one. Marks this
   * (install, PID) exhausted in _archAttemptMemory so _attemptArchFallback
   * refuses to retry it automatically again, and reports a single
   * terminal, actionable error instead.
   */
  _concludeArchFallback() {
    const memKey = this._archAttemptKey(this._lastResolvedPath, this._gamePid);
    const rec = this._archAttemptMemory.get(memKey) || { exhausted: false, triedPaths: new Set() };
    if (rec.exhausted) return; // already reported once for this (install, PID)
    rec.exhausted = true;
    rec.exhaustedAt = Date.now();
    if (this._lastResolvedPath) rec.triedPaths.add(this._lastResolvedPath);
    this._rememberArchAttempt(memKey, rec);

    const seconds = String(Math.round(ARCH_FALLBACK_CHECK_MAX_MS / 1000));
    const pid = String(this._gamePid);
    console.warn(`[TextractorLauncher] Arch fallback exhausted for PID ${pid} — ${rec.triedPaths.size} path(s) tried, no real hook ever appeared. Reporting terminal error, will not auto-retry this (install, PID) again this session.`);
    const err = this._buildError(
      `No game hook appeared after ${seconds}s with either architecture for PID ${pid}`,
      undefined,
      { messageKey: 'err_arch_fallback_exhausted', messageParams: { seconds, pid }, hintKey: 'hint_arch_fallback_exhausted' }
    );
    this.emit('error', err);
  }

  /**
   * v3.13.32: a real (non-system) hook just produced text, so THIS exe —
   * specifically this architecture — is the one that works for this game.
   * Before this, a successful x86 fallback left no trace anywhere:
   * _attemptArchFallback relaunches with { cliPath: fallback.path } but
   * never called configure(), so this.cliPath and the persisted
   * store.textractorCliPath both stayed on x64, and the next manual Launch
   * sent the x64 path straight back from the renderer's input field —
   * every fallback's discovery was thrown away the moment the user tried
   * again. Two effects, both idempotent (safe to call repeatedly, though
   * the call site only does it once per session):
   *   1. Clears this (install, PID)'s failure memory — it's now provably
   *      wrong.
   *   2. Records the winning path in _archPreference, keyed by INSTALL
   *      ONLY (not PID) — the right architecture for a given Textractor
   *      build doesn't depend on which game/PID happened to prove it.
   *      launch() consults this to start future sessions on the proven
   *      architecture instead of re-discovering it from scratch. Emits
   *      'arch-resolved' only when the preference actually CHANGES, and
   *      only the emit (not the memory update) — src/main/index.js uses
   *      this to persist to settings and update the renderer's path
   *      field; see its listener for why it also checks `viaFallback`.
   */
  _markArchSuccess() {
    const resolved = this._lastResolvedPath;
    if (!resolved) return;
    this._archAttemptMemory.delete(this._archAttemptKey(resolved, this._gamePid));

    const installKey = this._archInstallKey(resolved);
    const changed = this._archPreference.get(installKey) !== resolved;
    this._archPreference.set(installKey, resolved);
    if (changed) {
      console.log(`[TextractorLauncher] Arch preference resolved for this install: ${resolved}`);
      this.emit('arch-resolved', { cliPath: resolved, installKey, viaFallback: this._archFallbackAttempted });
    }
  }

  /**
   * v3.13.23: Try relaunching with the sibling architecture (x64<->x86) once
   * per user-initiated launch attempt. Triggered from four points where a
   * wrong-architecture attach or a wrong-engine-detection result is already
   * detectable today but previously only logged: immediate spawn error
   * (ENOENT etc.), a quick post-spawn exit, the 10s "no hooks found"
   * diagnostic (attach can silently "succeed" against a mismatched-bitness
   * process and just never produce any hook), and — v3.13.25 — the 10s
   * "hooks exist but all are garbled" case (confirmed real: x64
   * TextractorCLI's generic auto-engine can hook the right function with
   * the wrong hook-code type on a game where x86's own engine gets it
   * right immediately). `reason` is one of 'spawn-error' | 'quick-exit' |
   * 'no-hooks' | 'no-clean-hook' | 'no-real-hook' (v3.13.30 — see the
   * diagnostic's last-resort branch for why this is distinct from
   * 'no-hooks'). Returns true if a fallback attempt was
   * launched (caller should skip its own error reporting for this
   * attempt), false if there's nothing to fall back to, a fallback was
   * already tried for this launch, or (v3.13.32) both architectures were
   * already exhausted earlier this session for this exact (install, PID)
   * — see _concludeArchFallback.
   */
  _attemptArchFallback(reason) {
    if (this._archFallbackAttempted) return false;
    const fallback = this._getArchFallbackPath(this._lastResolvedPath);
    if (!fallback) return false;

    // v3.13.32: the loop-breaker. _archFallbackAttempted alone resets on
    // EVERY non-retry launch() call (:1950-ish) — including the user's own
    // manual Launch click, which arrives with no _isArchFallbackRetry flag
    // at all. That reset is correct in isolation (a different game/PID
    // deserves a fresh attempt), but with nothing remembering "we already
    // burned both architectures' 60s windows on THIS PID", every click
    // bought a brand new pair of 60s waits — confirmed the actual
    // mechanism behind a real reported "infinite loop of intentando x86"
    // once the v3.13.32 UI/timer fixes stopped it from just silently
    // stalling instead.
    const memKey = this._archAttemptKey(this._lastResolvedPath, this._gamePid);
    const record = this._archAttemptMemory.get(memKey);
    if (record && record.exhausted) {
      console.warn(`[TextractorLauncher] Arch fallback suppressed — PID ${this._gamePid} already exhausted both architectures on this install this session.`);
      return false;
    }

    this._archFallbackAttempted = true;
    const reasonLabel = { 'spawn-error': 'no se pudo iniciar', 'quick-exit': 'salió inmediatamente', 'no-hooks': 'sin hooks tras 10s', 'no-clean-hook': 'hooks encontrados pero todos con ruido', 'no-real-hook': `nunca apareció un hook real tras ${Math.round(ARCH_FALLBACK_CHECK_MAX_MS / 1000)}s (solo hooks de sistema)`, 'arch-mismatch': 'el .exe del juego no coincide con la arquitectura configurada (detectado por PE header)' }[reason] || reason;
    console.warn(`[TextractorLauncher] ${fallback.from}: ${reasonLabel} -> probando ${fallback.to}...`);
    this.emit('arch-fallback', { from: fallback.from, to: fallback.to, reason });

    // v3.13.32: record both paths as tried for this (install, PID) BEFORE
    // the relaunch fires — if it never produces a real hook either,
    // _concludeArchFallback() (called from the diagnostic's tail once the
    // NEW session's own 60s window also runs out) will find this and
    // refuse to try a third time (there isn't a third architecture, but
    // this also protects against re-attempting the SAME sibling if
    // something odd re-triggers a fallback on it).
    {
      const rec = record || { exhausted: false, triedPaths: new Set() };
      if (this._lastResolvedPath) rec.triedPaths.add(this._lastResolvedPath);
      rec.triedPaths.add(fallback.path);
      this._rememberArchAttempt(memKey, rec);
    }

    // v3.13.32: makes _emitStatus() relabel the 'killed'/'exited' the next
    // line produces as 'relaunching' — see _emitStatus's doc. Set BEFORE
    // the kill so there's no gap where a status emitted between kill() and
    // here would slip through as a real stop.
    this._relaunchInProgress = true;
    const gamePid = this._gamePid;
    // v3.13.32: passes _forArchRelaunch so kill() only clears THIS
    // process's own timers (_clearSessionTimers) and leaves
    // _archRelaunchTimer — armed a few lines below — alone. Before this,
    // kill()'s unconditional _clearTimers() raced the dying process's own
    // 'close' handler (which also called it): on Windows, taskkill is a
    // separate child process (~50-400ms) and routinely lost that race,
    // cancelling the relaunch this function is about to schedule and
    // leaving nothing running at all — confirmed the actual mechanism
    // behind a real "stuck on Launch, x86 never happens" report, not a
    // hypothetical race.
    if (this.isRunning) this.kill({ _forArchRelaunch: true });
    // Small delay so the previous process's taskkill/exit settles before
    // spawning the replacement — mirrors the pattern already used elsewhere
    // in this file (e.g. the 1.5s delayed stdin-attach backup).
    // v3.13.29: handle now saved (was a bare, uncancelable setTimeout) and
    // cleared by _clearTimers() — a real leak, not defensive-only: if
    // kill() or another _attemptArchFallback() call happened within this
    // 300ms window, the old code still fired this relaunch afterward and
    // resurrected a process the caller had just asked to stop.
    this._archRelaunchTimer = setTimeout(() => {
      this._archRelaunchTimer = null;
      const relaunched = this.launch(gamePid, { cliPath: fallback.path, pid: gamePid, _isArchFallbackRetry: true });
      // v3.13.32: launch() clears _relaunchInProgress itself right before
      // reporting 'launched' on success — but if it returned false (bad
      // path, invalid PID, whatever), nothing else ever will, and every
      // status this instance emits from then on would be silently
      // relabeled 'relaunching' forever.
      if (!relaunched) this._relaunchInProgress = false;
    }, 300);
    return true;
  }

  /**
   * v3.13.31: best-effort check that `pid` corresponds to a currently
   * running process, using `tasklist` (built into Windows, no new
   * dependency — `execSync` is already imported at the top of this file).
   * Diagnostic only — the caller only ever WARNS on a `false` result,
   * never blocks the launch, since a failure of this check itself
   * (locale quirks, WMI hiccups, `tasklist` unavailable in some
   * locked-down environment) shouldn't stop an otherwise-valid attach
   * attempt. Exists because a stale/wrong PID fails `attach` exactly as
   * silently as a genuine x64/x86 architecture mismatch does — confirmed
   * as a real point of confusion during the v3.13.30 investigation, where
   * the same PID persisted unverified across multiple test sessions
   * spanning ~20 minutes with no way to tell whether it was still the
   * live game process.
   *
   * Returns `true` (PID found), `false` (PID not found), or `null`
   * (couldn't determine — the check itself failed).
   */
  _checkPidIsRunning(pid) {
    try {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      // A real match is a quoted CSV row containing the PID as a field;
      // the "no tasks found" message (localized, varies by Windows
      // display language) never contains the PID number itself — this
      // avoids needing to match any specific locale's wording.
      return output.includes(`"${pid}"`);
    } catch (e) {
      console.warn(`[TextractorLauncher] PID liveness check failed (non-fatal): ${e.message}`);
      return null;
    }
  }

  /**
   * v3.13.76: resolve a running process's own .exe path from its PID, so the
   * game engine can be detected (see _detectAndEmitGameEngine below) without
   * the user ever having to point Tuhua at the game folder separately —
   * Textractor already requires a PID to attach, so this is "free" info.
   *
   * Hermano directo de _checkPidIsRunning above, with one deliberate
   * deviation: this uses async `exec`, not `execSync`. `_checkPidIsRunning`
   * can afford execSync because `tasklist` is a native binary that answers
   * in ~50ms; PowerShell cold-starts in 1-2s, and execSync-ing that would
   * block the main process's event loop for that whole window right at
   * spawn time — a real regression, not a theoretical one. Same
   * fail-silently contract as _checkPidIsRunning: every failure path calls
   * back with `null` and only warns, never touches the attach itself.
   *
   * @param {number} pid
   * @param {(exePath: string|null) => void} cb
   */
  _resolveExePathFromPid(pid, cb) {
    if (process.platform !== 'win32') return cb(null);
    if (!Number.isInteger(pid) || pid <= 0) return cb(null);

    const warnUnresolved = () => {
      // v3.13.76: specific message on purpose, not a generic warn — without
      // it, "engine detection never fired" is indistinguishable between two
      // causes with opposite fixes: the engine genuinely being unknown (add
      // a marker) vs. Tuhua simply lacking permission to read the path
      // (elevate it). The elevated-game case is the likely one in practice —
      // plenty of people launch VNs as admin.
      console.warn(`[EngineDetect] Cannot resolve exe path for PID ${pid} — process may be elevated (try running Tuhua as admin), or the PID already died. Engine detection skipped for this session.`);
      cb(null);
    };

    // Primary: PowerShell Get-Process. -NoProfile -NonInteractive is not
    // optional — without them a user's PowerShell profile can print prose
    // to stdout ahead of the value, or the shell can sit waiting on input.
    exec(
      `powershell -NoProfile -NonInteractive -Command "(Get-Process -Id ${pid} -ErrorAction Stop).Path"`,
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        const resolved = (stdout || '').trim();
        if (!err && resolved.toLowerCase().endsWith('.exe')) return cb(resolved);

        // Fallback: WMIC. Deprecated on Windows 11 24H2+, so it goes second,
        // but still present on most machines today.
        exec(
          `wmic process where processid=${pid} get ExecutablePath /value`,
          { encoding: 'utf8', windowsHide: true, timeout: 5000 },
          (err2, stdout2) => {
            const m = /ExecutablePath=(.+\.exe)/i.exec(stdout2 || '');
            if (!err2 && m) return cb(m[1].trim());
            warnUnresolved();
          }
        );
      }
    );
  }

  /**
   * v3.13.76: proactively detect the target game's engine right after
   * attach, and — if it's a class of engine Textractor structurally cannot
   * read (or one XUAT handles far better) — surface that immediately
   * instead of leaving the user to burn a 60s hook-discovery window (or
   * several arch-fallback cycles) figuring it out by trial and error. This
   * is what closes the Amorous/FNA case: real diagnostics in seconds, not a
   * 10-minute dead end. See game-engine-detect.js for the detection logic
   * and the anti-annoyance confidence gate; see the plan this shipped from
   * (ya-veo-claro-ocr-cuddly-quokka.md) for why this is proactive
   * (file-marker-based, works even with zero hooks) rather than reactive
   * (waiting to see whether hooks "look like" dialogue — already documented
   * elsewhere in this file as too fragile an axis, see the 10s→3-stage
   * escalation above _attemptArchFallback).
   *
   * Fire-and-forget from launch()'s perspective: never blocks or delays the
   * spawn, and a failure to resolve the exe path (see
   * _resolveExePathFromPid) just means no advisory ever appears for this
   * session — degrades to exactly today's behavior, silently.
   *
   * @param {number} pid
   */
  _detectAndEmitGameEngine(pid) {
    this._resolveExePathFromPid(pid, (exePath) => {
      if (!exePath) return;
      // A relaunch/arch-fallback or a fresh attach to a different game may
      // have happened while the async resolve above was in flight — only
      // apply the result if it's still for the PID we asked about.
      if (this._gamePid !== pid) return;
      this._gameEngine = detectGameEngine(exePath);
      if (this._gameEngine.adviceKey) {
        // Don't wait for the next scheduled discovery update (debounced
        // every 500ms, or the 3s phase-complete timer) — an advisory this
        // actionable should reach the UI as soon as it's known.
        this._emitHookDiscovery();
      }
      // v3.13.8x: Level 2 of the arch pre-flight feature — piggybacks on
      // this exact PowerShell resolution rather than issuing a second one.
      // Level 1 (_preflightArchSwap, in launch()) only fires when the exe
      // path was already known before spawn (the process picker). When
      // the PID was typed by hand instead, this is the SAME resolution
      // _detectAndEmitGameEngine already pays for the engine advisory —
      // reusing it here costs nothing extra, and still corrects the
      // architecture in ~1-2s instead of the full 60s fallback wait.
      this._checkArchAgainstGame(pid, exePath);
    });
  }

  /**
   * v3.13.8x: Level 2 of the arch pre-flight feature — see
   * _preflightArchSwap (Level 1, pre-spawn) for the full design note and
   * for why PE evidence overrides _archPreference / the persisted
   * arch-resolved path. This is the in-flight correction for when Level 1
   * had no exe path to work with (PID typed by hand, no picker used).
   *
   * Called from _detectAndEmitGameEngine's callback, ~1-2s after spawn —
   * reuses that exact PowerShell resolution rather than paying for a
   * second one. Guarded identically: `this._gamePid !== pid` covers a
   * relaunch/fallback racing this async callback, same as the engine
   * advisory right above it.
   *
   * Deliberately gated on `!this._hasRealHookWithText()` — the same
   * helper the 60s diagnostic uses (see its own doc) — so this can never
   * fire a redundant relaunch once the architecture has already proven
   * itself with real (even low-quality) text. `_attemptArchFallback`
   * itself is what actually consumes _archFallbackAttempted /
   * _archAttemptMemory, so this inherits the full v3.13.32 anti-loop
   * protection (one swap per launch() cycle; suppressed once a (PID,
   * install) pair is already marked exhausted) without needing to
   * duplicate any of it here.
   *
   * @param {number} pid
   * @param {string} gameExePath
   */
  _checkArchAgainstGame(pid, gameExePath) {
    if (this._gamePid !== pid) return;
    if (this._hasRealHookWithText()) return;
    const textractorArch = this._detectArch(this._lastResolvedPath);
    if (!textractorArch) return;
    const gameArch = detectExeArch(gameExePath);
    if (!gameArch || gameArch === textractorArch) return;
    this._attemptArchFallback('arch-mismatch');
  }

  validatePath(cliPath) {
    // v3.13.24: every `message` below now has a companion `messageKey`
    // (+ `messageParams` where dynamic) for the renderer to translate —
    // `message` itself is now always English, used as the fallback.
    // v3.13.29: TextractorCLI/Textractor.exe are Windows-only executables.
    // Before this guard, a macOS/Linux user pointing at ANY path (real or
    // not) fell through to the ext/basename checks below and, if they
    // somehow had a same-named file, would eventually hit spawn()'s
    // ENOENT/EACCES handler — surfacing as "File not found. Verify the
    // path to TextractorCLI.exe.", a message that sends a non-Windows user
    // to double-check a path instead of telling them the actual problem:
    // this feature has no solution on their OS. Checked first, before
    // even the "no path" case, since it's true regardless of what path
    // (or lack of one) was given.
    if (process.platform !== 'win32') {
      return { valid: false, messageKey: 'val_windows_only', message: 'Textractor and TextractorCLI are Windows-only executables and cannot run on this operating system.' };
    }
    if (!cliPath) return { valid: false, messageKey: 'val_no_path', message: 'No path specified' };
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
            const searchedList = searchedPaths.map(p => '  • ' + p).join('\n');
            return {
              valid: false,
              messageKey: 'val_folder_no_exe',
              messageParams: { paths: searchedList },
              message: `Expected a .exe, got a folder. Could not find Textractor.exe or TextractorCLI.exe in:\n${searchedList}`
            };
          }
        }
      } else {
        return { valid: false, messageKey: 'val_path_not_found', messageParams: { path: resolved }, message: 'Path not found: ' + resolved };
      }

      // Now `resolved` should point to a .exe file
      const ext = path.extname(resolved).toLowerCase();
      if (ext !== '.exe') {
        return { valid: false, messageKey: 'val_expected_exe', messageParams: { ext }, message: 'Expected .exe file, got: ' + ext };
      }
      const basename = path.basename(resolved).toLowerCase();
      if (!basename.includes('textractor')) {
        return { valid: false, messageKey: 'val_not_textractor', messageParams: { basename }, message: 'File does not appear to be TextractorCLI: ' + basename };
      }

      // v3.8.23: Check if required DLLs might be missing
      const dir = path.dirname(resolved);
      const requiredDlls = ['vcruntime140.dll', 'msvcp140.dll'];
      const dirFiles = fs.readdirSync(dir).map(f => f.toLowerCase());
      const missingDlls = requiredDlls.filter(dll => !dirFiles.includes(dll));
      // Note: DLLs might be in System32, so this is just a soft check

      // Check architecture consistency.
      // v3.13.8x: delegated to pe-arch.js's detectExeArch — same PE-header
      // logic as before (see that module's doc), but reads a small fixed
      // window instead of the whole file via readFileSync. Harmless for
      // TextractorCLI.exe itself (~1MB), but this codepath's logic is
      // reused for the arch-mismatch pre-flight check against a GAME exe,
      // which can be hundreds of MB — readFileSync-ing that on every
      // launch would be a real regression.
      const detectedArch = detectExeArch(resolved);
      let archWarning = '';
      if (detectedArch === 'x86') archWarning = ' (32-bit)';
      else if (detectedArch === 'x64') archWarning = ' (64-bit)';

      let message = 'Valid TextractorCLI executable' + archWarning;
      let messageKey = 'val_valid_exe';
      let messageParams = { arch: archWarning };
      if (autoResolved) {
        message = 'Auto-detected: ' + resolved + archWarning;
        messageKey = 'val_auto_detected';
        messageParams = { path: resolved, arch: archWarning };
      }
      return { valid: true, messageKey, messageParams, message, resolved, arch: archWarning, autoResolved };
    } catch (err) {
      return { valid: false, messageKey: null, message: err.message };
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
   * v3.13.29: dump the RAW wire bytes of a chunk, before any decoding —
   * unlike _hexDump above, which only ever sees the already-decoded and
   * already-sanitized string, so it was useless for diagnosing an
   * encoding bug from the actual bytes TextractorCLI sent (every previous
   * debugging pass on the corruption this fixes had to work from that
   * decoded view, which is a large part of why it took multiple sessions
   * to pin down). Off by default (TUHUA_STDOUT_RAWDUMP unset ->
   * _rawDumpBudget is 0) since it's verbose; set TUHUA_STDOUT_RAWDUMP=1
   * for a 512-byte-per-session budget, or =N for N bytes.
   *   Windows cmd:  set TUHUA_STDOUT_RAWDUMP=1 && npm start
   *   PowerShell:   $env:TUHUA_STDOUT_RAWDUMP=1; npm start
   *   macOS/Linux:  TUHUA_STDOUT_RAWDUMP=1 npm start
   * The absolute session byte offset is the actual diagnostic value here:
   * for utf16le, a chunk starting at an ODD offset is exactly the
   * condition that used to desync the old decoder, and that's invisible
   * in a dump that only shows each chunk's own bytes without its position
   * in the stream.
   */
  _maybeDumpRawBytes(buf) {
    const startOffset = this._rawBytesSeen;
    this._rawBytesSeen += buf.length;
    if (this._rawDumpBytesRemaining <= 0) return;
    const take = Math.min(buf.length, this._rawDumpBytesRemaining);
    this._rawDumpBytesRemaining -= take;
    const parity = (startOffset % 2 === 1) ? ' ODD-OFFSET' : '';
    console.log(
      `[TextractorLauncher] RAW #${this._dataEventCount} @${startOffset}${parity} ` +
      `${buf.length}B (showing ${take}B, ${this._rawDumpBytesRemaining}B budget left)\n` +
      this._formatHexDump(buf.subarray(0, take), startOffset)
    );
  }

  /**
   * Canonical 16-bytes-per-row hex dump with absolute offsets, used by
   * _maybeDumpRawBytes. Kept separate from _hexDump (which formats an
   * already-decoded string for a single-line inline log) since this one
   * formats raw multi-row Buffer content with a real base offset.
   */
  _formatHexDump(buf, baseOffset = 0, bytesPerRow = 16) {
    const rows = [];
    for (let off = 0; off < buf.length; off += bytesPerRow) {
      const slice = buf.subarray(off, off + bytesPerRow);
      const hex = [];
      let ascii = '';
      for (let i = 0; i < bytesPerRow; i++) {
        if (i < slice.length) {
          hex.push(slice[i].toString(16).padStart(2, '0'));
          ascii += (slice[i] >= 0x20 && slice[i] < 0x7F) ? String.fromCharCode(slice[i]) : '.';
        } else {
          hex.push('  ');
        }
      }
      rows.push(`  ${(baseOffset + off).toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`);
    }
    return rows.join('\n');
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
    const m = HOOK_LINE_RE.exec(line);
    if (m) return this._buildCanonicalHook(m);
    // v3.13.36: the old heuristic formats now only run as a fallback for a
    // TextractorCLI printf this project hasn't seen. In practice they
    // should never fire — _legacyParseCount (exposed via getStats()) lets
    // that be confirmed with data instead of assumption before ever
    // deleting them.
    const legacy = this._parseLegacyHookLine(line);
    if (legacy) this._legacyParseCount++;
    return legacy;
  }

  /**
   * v3.13.36: builds the hook object from HOOK_LINE_RE's 8 capture groups.
   * See HOOK_LINE_RE's doc for the source printf this mirrors field-by-field.
   */
  _buildCanonicalHook(m) {
    const [, handle, pid, addr, ctx, ctx2, name, hookCode, rawText] = m;
    const text = rawText.trim();

    // v3.13.36: pid === 0 is the STRUCTURAL signature of TextractorCLI's
    // own internal threads (Console/Clipboard register with
    // ThreadParam{processId: 0, ...} — confirmed against host/textthread.h
    // via the same source read that found this whole printf). Replaces
    // the old `['Console','Clipboard','Consola','Portapapeles']` name
    // list, which depended on Textractor's own UI language and silently
    // stopped recognizing system hooks the moment someone ran it in
    // German, Japanese, French, etc. No real game process has PID 0.
    const isSystemHook = /^0+$/.test(pid);

    // hookKey: SAME shape and SAME source values (groups 1-4) as the old
    // FORMAT A — deliberately unchanged. `handle` is already unique per
    // TextractorCLI thread, so folding ctx2 in wouldn't add uniqueness
    // and would just invalidate every existing key comparison.
    const hookKey = `${handle}:${pid}:${addr}:${ctx}`;

    const codeType = TextractorLauncher.hookCodeType(hookCode);
    const codeParts = hookCode ? hookCode.split(':') : [];
    const codeHead = codeParts[0] || '';                      // e.g. HQ8@0
    const codeTarget = codeParts.length > 1 ? codeParts.slice(1).join('!') : ''; // e.g. gdi32.dll!GetTextExtentPoint32W

    // v3.13.36: displayName is the direct fix for the reported symptom —
    // 13 hooks that all showed the SAME label (the process name) because
    // they'd all fallen through to the old generic FORMAT D. `addr` is a
    // cheap, stable discriminant (it's also what a manual GUI hook search
    // shows), and the [1B] suffix flags single-byte-type hooks — the ones
    // that produce garbage on a CJK game — right in the selector.
    const displayName = isSystemHook
      ? `#${handle} ${name || codeHead || 'system'}`
      : `#${handle} ${codeHead || '?'} @${addr}` +
        (name ? ` ${name}` : (codeTarget ? ` ${codeTarget}` : '')) +
        (codeType === 'byte' ? ' [1B]' : '');

    return {
      hookKey,
      hookName: name || codeTarget || codeHead || (isSystemHook ? 'system' : ''),
      displayName,
      text,
      fullName: `[${handle}:${pid}:${addr}:${ctx}:${ctx2}:${name}:${hookCode}]`,
      hookCode,
      hookCodeType: codeType,
      hookAddr: addr,
      ctxAddr: ctx,
      ctx2Addr: ctx2,
      // v3.13.36: this field historically held match[4] = thread.tp.ctx,
      // which is a context/return address, not a function address —
      // despite the name. Kept as `funcAddr` for payload compatibility,
      // now actually holding tp.addr as the name always implied. The old
      // value is still available as ctxAddr above.
      funcAddr: addr,
      processName: isSystemHook ? '' : (codeTarget.split('!').pop() || ''),
      hookIndex: parseInt(handle, 16),
      isSystemHook
    };
  }

  /**
   * v3.13.36: pre-canonical heuristic formats, kept only as a fallback —
   * see _parseHookLine's doc. Formerly FORMAT C and FORMAT D; the old
   * FORMAT A and FORMAT B are gone, fully subsumed by HOOK_LINE_RE (they
   * were both parsing the exact same printf, just with different bugs).
   */
  _parseLegacyHookLine(line) {
    // === FORMAT C: Legacy [0xHEX:DIGIT:NAME] text ===
    let match = line.match(/\[(0x[0-9A-Fa-f]+):(\d+):([^\]]*)\]\s*(.*)/);
    if (match) {
      const hookAddr = match[1];
      const threadNum = match[2];
      const hookName = match[3].trim();
      const text = match[4].trim();
      const hookKey = `${hookAddr}:${threadNum}`;
      const displayName = hookName || `${hookAddr}:${threadNum}`;
      return {
        hookKey, hookName, displayName, text, fullName: `[${hookAddr}:${threadNum}:${hookName}]`,
        hookCode: '', hookCodeType: 'unknown', funcAddr: '', processName: '', hookIndex: 0, isSystemHook: false
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
          hookCode: '', hookCodeType: 'unknown', funcAddr: '', processName: '', hookIndex: 0, isSystemHook: false
        };
      }
    }

    return null;
  }

  /**
   * v3.13.36: read-encoding type a hook code selects, from the letter
   * right after the 'H' (or 'R' for a direct-read code) - mapped from
   * Textractor's own host/hookcode.cpp (ParseHCode):
   *
   *   B  (ANSI, the generic auto-engine's default)     -> 'byte'
   *   A  (2-byte/BIG_ENDIAN, NOT UTF-16)                -> 'byte'
   *   S  (USING_STRING, no unicode flag)                -> 'byte'
   *   Q  (USING_STRING|USING_UNICODE)                   -> 'unicode'
   *   W  (USING_UNICODE)                                -> 'unicode'
   *   V  (USING_STRING|USING_UTF8)                      -> 'utf8'
   *   M  (...|HEX_DUMP)                                 -> 'hexdump'
   *
   * Static, and keyed on the TYPE letter rather than the whole string -
   * closes the actual bug in the old _allRealHooksAreGenericType(), which
   * compared `hook.hookCode !== 'HB0@0'` by exact equality while the real
   * hookCode TextractorCLI prints always carries a module suffix
   * ("HB0@0:nekopara_vol1_trial.exe"). That comparison could never be
   * true against a real line, parser bug or not.
   */
  static hookCodeType(hookCode) {
    if (!hookCode) return 'unknown';
    const m = /^\s*[HR]([A-Za-z])/.exec(hookCode);
    if (!m) return 'unknown';
    switch (m[1].toUpperCase()) {
      case 'B': case 'A': case 'S': return 'byte';
      case 'Q': case 'W': return 'unicode';
      case 'V': return 'utf8';
      case 'M': return 'hexdump';
      default: return 'unknown';
    }
  }

  /**
   * Check if text contains CJK characters.
   */
  _hasCJK(text) {
    return /[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uff65-\uff9f]/.test(text);
  }

  /**
   * v3.13.36: count of CJK characters in text - same character class as
   * _hasCJK above (kept as one literal each rather than sharing a compiled
   * regex, since one needs .test() semantics and this needs a global
   * count; a shared /g regex would need lastIndex resets between calls,
   * which is exactly the kind of subtle stateful bug this file has
   * already hit once with a hand-rolled decoder).
   */
  _countCJK(text) {
    const m = text.match(/[\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uff65-\uff9f]/g);
    return m ? m.length : 0;
  }

  /**
   * v3.13.36: fraction of `text` covered by runs of "<char>0" - the
   * signature of a single-byte-type hook reading a buffer that's actually
   * UTF-16LE.
   *
   * Mechanics: kana lives at U+3040-30FF and kanji at U+4E00-9FFF. In
   * UTF-16LE the LOW byte comes first, so a kana character at U+3042 is
   * the byte pair 42 30. Read one byte at a time, 0x30 is the ASCII digit
   * '0' - every kana character becomes "<char>0":
   *     U+306B -> bytes 6B 30 -> "k0"
   *     U+306E -> bytes 6E 30 -> "n0"
   *     U+3067 -> bytes 67 30 -> "g0"
   * which is exactly what a real corrupted session showed: a run of
   * "k0k0" fragments alongside intact ASCII from the same buffer (see
   * _sanitizeLine's note below for why the ASCII survives unaffected).
   *
   * Kanji's range isn't modeled separately: any real Japanese sentence
   * carries kana particles (U+306F, U+304C, U+3092, U+306E, U+306B among
   * others), so the "<char>0" pattern shows up regardless. Covering
   * kanji's high bytes (0x4E-0x9F, which surface as Latin letters or
   * other mojibake depending on codepage) would add false positives on
   * plain Latin text without adding recall.
   *
   * Why _textQualityPenalty's existing 7 patterns never caught this: its
   * doubled-char pattern compares ADJACENT EQUAL characters
   * ("IInnsstt") - here the second character of each pair is always '0'
   * but the first never is, so no pair is ever equal. Its single-repeated
   * -char pattern requires ONE character repeated across the WHOLE
   * string, which this isn't either.
   *
   * Why this is a RUN search, not a fixed-parity index check:
   * _sanitizeLine (see its own doc) strips control chars before this ever
   * runs, and ASCII within the same buffer arrives as "A\0" - stripping
   * the NUL loses the high byte and shifts parity for the rest of the
   * string from that point on. Scanning for runs sidesteps needing a
   * stable parity at all.
   *
   * Why this signal exists ALONGSIDE hookCodeType() rather than instead
   * of it - three independent reasons:
   *   1. The type can be MISSING. With a broken parser, hookCode lands on
   *      '' and hookCodeType('') is 'unknown'. A type-only policy goes
   *      mute in exactly the scenario that needs catching - this looks
   *      only at content, so it survives a broken parser (or the next
   *      TextractorCLI version changing the printf).
   *   2. A single-byte hook can be PERFECT. On a Shift-JIS game,
   *      TextractorCLI converts the buffer with codepage 932 and an
   *      HB0@0 produces flawless Japanese. Penalizing by type alone would
   *      break most older VNs.
   *   3. A unicode hook can be BROKEN. The inverse case is already
   *      documented in this file (see KNOWN_GOOD_HOOK_CODES): at the same
   *      memory address, HB0@0 produced garbage and HQ8@0 produced clean
   *      text - same function, same address. A Q/W hook pointed at the
   *      wrong parameter emits garbage just the same.
   * Content decides hook SELECTION; type decides the architecture
   * DIAGNOSIS (_allRealHooksAreSingleByteType). They answer different
   * questions and neither substitutes for the other.
   */
  _utf16ByteGarbageRatio(text) {
    if (!text || text.length < UTF16_GARBAGE_MIN_LEN) return 0;
    // Guard against the one real false positive found while calibrating
    // this: a long run of alternating digits ("20201030") matches the
    // pattern. A pure-digit string isn't dialogue anyway
    // (_looksLikeGameText already rejects it elsewhere) - this is belt
    // and suspenders.
    if (/^[0-9\s]+$/.test(text)) return 0;
    const runs = text.match(UTF16_BYTE_RUN_RE);
    if (!runs) return 0;
    let covered = 0;
    for (const r of runs) covered += r.length;
    return covered / text.length;
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

    // 2b. v3.13.24: Windows single-letter menu accelerators, e.g. "(&F)",
    // "&S)", "&L)" — the actual real-world convention for localized menu
    // resource strings ("ファイル(&F)"), not caught by the full-word check
    // above. Confirmed against a real false-positive: a Nekopara/KiriKiriZ
    // hook whose captured text was garbled by a wrong-parameter hook (see
    // the encoding investigation) happened to fall in the CJK Unicode
    // range, winning _scoreHook's +1000 CJK bonus outright despite being
    // an obvious menu string, not dialogue. Requires 2+ occurrences (a
    // real menu has several items; a single stray "&X)" is near-impossible
    // in real dialogue but this keeps the bar conservative regardless).
    const acceleratorMatches = text.match(/&[A-Za-z]\)/g);
    if (acceleratorMatches && acceleratorMatches.length >= 2) {
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

    // 7. v3.13.36: UTF-16LE read byte-by-byte (see _utf16ByteGarbageRatio).
    //    Penalty deliberately larger than the +1000 CJK bonus a hook this
    //    broken can still collect (see hook.hasCJK's update site): the
    //    real case measured was garbage at 1510 vs. clean text at 1110.
    //    For the clean hook to win by more than HOOK_SWITCH_THRESHOLD
    //    (200), the penalty needs to clear roughly 750 points even after
    //    that bonus; 1400 leaves margin even if the garbage hook also
    //    piles up volume.
    const garbageRatio = this._utf16ByteGarbageRatio(text);
    if (garbageRatio >= UTF16_GARBAGE_RATIO_STRONG) penalty += 1400;
    else if (garbageRatio >= UTF16_GARBAGE_RATIO_WEAK) penalty += 900;

    // 8. v3.13.38: character-repetition garbage — see REPEAT_RUN_* above for
    //    the measured separation and why "distinct >= 3" is load-bearing.
    //    Skipped once any earlier rule fired: a fully-doubled string
    //    ("NNooww tthhaatt") satisfies rule 1 AND this one, and stacking
    //    800 + 900 changes no ordering that rule 1's 800 has not already
    //    settled — it only makes the resulting score harder to read.
    //
    //    Magnitude 900: a repetition hook that ALSO maxes volume reaches
    //    1000 (CJK) + 500 (textCount cap) + 100 (avgLen cap) = 1600; minus
    //    900 leaves 700, so a modest clean hook (about 1050) beats it by
    //    350 > HOOK_SWITCH_THRESHOLD. Against the real numbers: the
    //    KiriKiriZ hook drops 1110 -> 210 against dialogue at 1047. Kept
    //    equal to rule 7's WEAK tier and below its STRONG 1400, preserving
    //    that the UTF-16 signal is the stronger, more specific one.
    if (penalty === 0) {
      const dense = text.replace(/\s+/g, '');
      if (dense.length >= REPEAT_RUN_MIN_LEN) {
        let inRun = 0;
        const runChars = new Set();
        for (let i = 0; i < dense.length; i++) {
          const prevSame = i > 0 && dense[i] === dense[i - 1];
          const nextSame = i < dense.length - 1 && dense[i] === dense[i + 1];
          if (prevSame || nextSame) { inRun++; runChars.add(dense[i]); }
        }
        const coverage = inRun / dense.length;
        if (coverage >= REPEAT_RUN_COVERAGE_MIN && runChars.size >= REPEAT_RUN_DISTINCT_MIN) {
          penalty += REPEAT_RUN_PENALTY;
        }
      }
    }

    return penalty;
  }

  /**
   * v3.13.26: true when at least one real (non-system) hook has produced
   * text AND every single one has hookCode exactly `HB0@0` — the generic
   * placeholder TextractorCLI's blanket auto-engine uses when it can't
   * identify a specific typed hook for a function. Replaces an earlier
   * (v3.13.25) content-quality-based version that checked
   * `_textQualityPenalty` instead — that one turned out unreliable: proven
   * with a real side-by-side comparison, some HB0@0-typed hooks on x64
   * produce text that happens not to match ANY of the quality-penalty
   * patterns (no menu accelerators, no doubled chars) by coincidence, so
   * they scored as "clean" despite being the exact same broken generic
   * hook type, and the fallback never triggered.
   *
   * hookCode is a much stronger, purely structural signal, confirmed
   * against two full real sessions on the same game: x64 (broken) —
   * EVERY real hook was `HB0@0`, zero exceptions across ~15 discovered
   * hooks over 90+ seconds. x86 (working, after the user pointed Tuhua
   * straight at the x86 folder) — ZERO hooks were `HB0@0`; every one had
   * a specific type (`HQ18@0`, `HQ8@0`, `HW8@0`, KiriKiriZ's own
   * `HW-8*14:-8*0@...`). When a game-specific engine (or a correctly
   * resolved individual API hook) is actually identified, TextractorCLI
   * assigns it a specific code — `HB0@0` alone means "no idea, generic
   * fallback" for every function it's attached to, not just some.
   *
   * Deliberately excludes the "no real hook yet at all" case (only
   * Console/Clipboard so far) — some engines take up to ~45s to insert
   * their real hook (confirmed with KiriKiriZ), so treating "no real hook
   * yet" the same as "only generic real hooks" would cut that off
   * prematurely.
   */
  /**
   * v3.13.36 (was _allRealHooksAreGenericType): true when at least one
   * real hook produced text AND every one of them is single-byte type
   * (B/A/S — see hookCodeType).
   *
   * What changed and why: the old version did
   * `hook.hookCode !== 'HB0@0'` — exact equality against a bare literal.
   * The hookCode TextractorCLI actually prints is whatever
   * HookCode::Generate(hp, pid) returns, which always carries the module
   * suffix ("HB0@0:nekopara_vol1_trial.exe"). That comparison could never
   * be true against a real line — the trigger this feeds was dead for
   * TWO independent reasons (this, and the \d+-vs-hex parser bug that
   * left hookCode at '' in the first place).
   *
   * The reasoning from v3.13.26 still holds and is why this signal is
   * kept at all: in two real sessions on the same game compared side by
   * side, x64 gave 100% single-byte hooks (~15 hooks, 90+ seconds, zero
   * exceptions) and x86 gave ZERO single-byte hooks (HQ18@0, HQ8@0,
   * HW8@0, and KiriKiriZ's own native code). What changed is how it's
   * measured: the TYPE, not the string.
   *
   * NOT the same claim as "single-byte hooks are bad": an HB0@0 on a
   * Shift-JIS game is the normal, correct configuration (TextractorCLI
   * converts with codepage 932 and it comes out perfect). This detects
   * the degenerate case "the auto-engine never identified a single typed
   * hook all session" — not text quality, which is
   * _utf16ByteGarbageRatio's job, on purpose kept independent of this.
   */
  _allRealHooksAreSingleByteType() {
    let hasRealHook = false;
    for (const hook of this._hooks.values()) {
      if (hook.isSystemHook || hook.textCount === 0) continue;
      hasRealHook = true;
      if (TextractorLauncher.hookCodeType(hook.hookCode) !== 'byte') return false;
    }
    return hasRealHook;
  }

  /**
   * v3.13.8x: "has this architecture already proven itself" — extracted
   * out of the 60s arch-fallback diagnostic (runArchFallbackCheck, inside
   * launch()) so the pre-flight arch-mismatch correction (Level 2 of the
   * arch pre-flight feature — see _preflightArchSwap for Level 1) uses the
   * EXACT same criterion, not a lookalike. Two independent code paths
   * deciding "is the architecture already working" on slightly different
   * definitions is exactly the kind of divergence that goes unnoticed
   * until a real session hits the gap between them — this makes that
   * structurally impossible instead of relying on both being kept in sync
   * by hand.
   *
   * `textCount > 0` on a non-system hook is the bar, deliberately not hook
   * QUALITY — garbage text still proves the architecture can inject and
   * receive text at all; whether the hook is a good one is a separate
   * question the scoring/degradation checks already own.
   */
  _hasRealHookWithText() {
    for (const hook of this._hooks.values()) {
      if (!hook.isSystemHook && hook.textCount > 0) return true;
    }
    return false;
  }

  /**
   * v3.13.36: is `text` NEW content for this hook, as opposed to a
   * re-emission of something already counted?
   *
   * The real case this fixes: a hook with a growing/refreshing buffer
   * (ctx2=1A in a real session) re-emitted its ENTIRE accumulated buffer
   * on every stdout tick. Each re-emission counted as +1 toward
   * hook.textCount, which _scoreHook turns into up to +500 of pure
   * volume bonus, plus inflated hook.totalTextLength pushing avgLen's
   * +100 bonus to its cap almost immediately. A hook emitting the exact
   * same clean text ONCE scored barely above zero on both terms.
   * Measured on a real session: the noisy hook scored 1510, the clean
   * one 1110 — 400 points apart, comfortably past HOOK_SWITCH_THRESHOLD
   * (200), so not even the hysteresis protected the clean hook.
   * `_lastTextHash` (the module-level dedup) doesn't help here: it
   * filters the emitted 'text' EVENT of whichever hook is already
   * selected, not the per-hook count that decides selection in the first
   * place.
   *
   * Exact-hash dedup alone isn't enough either: the real case isn't
   * identical text, it's a GROWING buffer ("A" -> "AB" -> "ABC"), so this
   * also treats a straightforward prefix/suffix relationship to the
   * previous text as "not new" — the same growing/shrinking notion
   * text-cleaning.js's detectGrowingPrefix/detectShrinkingSuffix apply
   * downstream, just checked here before it ever affects scoring.
   */
  _isNewHookContent(hook, text) {
    const prev = hook.lastText || '';
    const hash = crypto.createHash('md5').update(text).digest('hex');
    const seen = hook._recentHashes.has(hash);
    if (!seen) {
      hook._recentHashes.add(hash);
      hook._recentHashOrder.push(hash);
      if (hook._recentHashOrder.length > HOOK_RECENT_HASH_LIMIT) {
        hook._recentHashes.delete(hook._recentHashOrder.shift());
      }
    }
    if (!prev) return true;
    if (seen) return false;
    if (text.startsWith(prev) || prev.startsWith(text)) return false;
    return true;
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
        // v3.13.36: type read off hookCode once at hook-creation time,
        // not recomputed per line — hookCode never changes after the
        // first line for a given hookKey (both come from the same
        // Generate() call on Textractor's side).
        hookCodeType: TextractorLauncher.hookCodeType(hookCode),
        funcAddr: funcAddr || '',
        processName: processName || '',
        hookIndex: hookIndex || 0,
        isSystemHook: isSystemHook || false,
        lastText: '',
        // v3.13.36: textCount/totalTextLength/cjkChars/scoredChars all
        // count NEW content only — see _isNewHookContent's doc. emitCount
        // is the raw line count, kept for diagnostics/getStats() only,
        // never fed into scoring.
        textCount: 0,
        emitCount: 0,
        cjkChars: 0,
        scoredChars: 0,
        hasCJK: false,
        looksUtf16Garbled: false,
        totalTextLength: 0,
        qualityPenalty: 0,
        discoveredAt: Date.now(),
        lastTextAt: 0, // v3.13.29: set on first text below, used by the hysteresis age discount
        // v3.13.38: like lastTextAt, but advanced ONLY by genuinely new
        // content — see the hysteresis age discount in _autoSelectBestHook
        // for why re-emitting the same buffer must not count as "producing".
        lastNewTextAt: 0,
        // v3.13.38: longest emission whose quality has actually been
        // scored — see the update site below for the hole this closes.
        longestScoredLength: 0,
        _recentHashes: new Set(),
        _recentHashOrder: []
      };
      this._hooks.set(hookKey, hook);
      console.log(`[TextractorLauncher] NEW HOOK: ${fullName} → ${displayName} (total: ${this._hooks.size})`);
    }

    // Update hook state
    if (text && text.length > 0) {
      hook.emitCount++;
      const isNewContent = this._isNewHookContent(hook, text);
      hook.lastText = text;
      // v3.13.29: reflects hook ACTIVITY for the hysteresis age discount —
      // updates on every emission, including re-emitted/growing buffers,
      // since those still mean the hook is alive and producing signal.
      hook.lastTextAt = Date.now();

      if (isNewContent) {
        hook.textCount++;
        hook.totalTextLength += text.length;
        hook.cjkChars += this._countCJK(text);
        hook.scoredChars += text.length;
        // v3.13.36: UI badge only — a much lower bar than the scoring
        // ratio in _scoreHook, kept generous on purpose (see CJK_RATIO_UI's doc).
        hook.hasCJK = hook.scoredChars > 0 && (hook.cjkChars / hook.scoredChars) >= CJK_RATIO_UI;
        // v3.13.38: advanced only here, inside isNewContent — see the
        // field's declaration and the hysteresis age discount.
        hook.lastNewTextAt = Date.now();
      }

      // v3.13.38: quality signals are evaluated on new content OR on any
      // emission LONGER than anything scored so far — deliberately NOT
      // gated on isNewContent alone, which was a real hole. A growing
      // redraw buffer is "not new" by construction (_isNewHookContent
      // treats a prefix relationship as a repeat), so the entire quality
      // path only ever saw the FIRST, shortest emission of exactly the
      // hook class these penalties exist to catch. Confirmed against the
      // bench's own fixture: _textQualityPenalty('k0n0') is 0 (below
      // UTF16_GARBAGE_MIN_LEN), while the 120-character buffer it grows
      // into is 1400 — a value v3.13.36's rule 7 had never once computed
      // in that scenario.
      //
      // "Longer than the longest scored" rather than "every emission" on
      // purpose: it can only ever admit MORE text to judge, so the
      // short-text rules (rule 6's <3 meaningful chars, rule 4's pure
      // repeat) cannot newly fire on a partial early frame.
      if (isNewContent || text.length > hook.longestScoredLength) {
        hook.longestScoredLength = Math.max(hook.longestScoredLength, text.length);
        // Update quality penalty (use worst seen)
        const penalty = this._textQualityPenalty(text);
        if (penalty > hook.qualityPenalty) {
          hook.qualityPenalty = penalty;
        }
        if (this._utf16ByteGarbageRatio(text) >= UTF16_GARBAGE_RATIO_STRONG) {
          hook.looksUtf16Garbled = true;
        }
      }

      // v3.13.32: the first time a REAL (non-system) hook produces text
      // this session, this exe/architecture is proven to work for this
      // game — see _markArchSuccess's doc for what that unlocks. Guarded
      // to fire once per session (cheap; the work itself is also
      // idempotent, this just avoids repeating it on every line).
      if (!isSystemHook && !this._archSuccessMarked) {
        this._archSuccessMarked = true;
        this._markArchSuccess();
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
  /**
   * v3.13.23: Extracted from the inline scoring logic that used to be
   * duplicated verbatim inside _autoSelectBestHook (once for the candidate
   * hook, once for the previously-selected hook it compares against) — same
   * formula, no behavior change. Having a single scoring function also lets
   * _emitHookDiscovery attach each hook's score to the UI payload, so the
   * hook selector can show *why* a hook was auto-picked instead of that only
   * being visible in the log.
   */
  _scoreHook(hook) {
    let score = 0;

    // v3.13.36: CJK bonus moved from a sticky boolean to a ratio of the
    // hook's SCORED (new, deduped) content — see hook.hasCJK's update
    // site in _processHookLine for why the boolean let UTF-16-byte
    // garbage collect the same +1000 real Japanese dialogue earns.
    // Mechanism: TextractorCLI converts a single-byte buffer to wide
    // using the system ANSI codepage (932 on a Japanese-locale install)
    // BEFORE printing it, and codepage 932 is multi-byte — two
    // consecutive low bytes >=0x81 can combine into a REAL katakana
    // character by accident. With the old sticky flag, one such accident
    // anywhere in the session was worth +1000 forever. The ratio tells
    // real Japanese (typically 0.8-1.0 CJK) apart from garbage with an
    // accidental character (typically well under 0.1).
    //
    // Backward-compat fallback deliberate, not defensive: hook objects
    // built by the test bench's fixtures (and by anything constructed
    // before this version) set hasCJK directly without the
    // cjkChars/scoredChars counters behind it. Without this fallback,
    // testHysteresisAgeDiscount and the B/C/D diagnostic scenarios would
    // lose their CJK score and change result for a reason that has
    // nothing to do with what they're testing.
    const cjkRatio = hook.scoredChars > 0
      ? hook.cjkChars / hook.scoredChars
      : (hook.hasCJK ? 1 : 0);
    if (cjkRatio >= CJK_RATIO_STRONG) score += 1000;
    else if (cjkRatio > 0) score += Math.round(1000 * (cjkRatio / CJK_RATIO_STRONG));

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

    // v3.13.38: TERMINAL SENTENCE PUNCTUATION — see TERMINAL_PUNCT_* above.
    // Measured on cleanPreview (already computed for the prose bonus), not
    // raw lastText: the real dialogue hook this fixes emits "A<sep>A" (the
    // same sentence twice), so the raw string happens to end in 。 here —
    // but a hook whose artifact is a TRAILING one would not, and the
    // preview is what the user sees in the hook selector anyway.
    //
    // Magnitude 250: the incumbent menu hook scored 1034 holding a fresh
    // +200 hysteresis claim, so a challenger had to clear 1234. The
    // dialogue hook's WORST observed single-line score is 1047, and
    // 1047 + 250 = 1297 clears it with 63 points of margin on its FIRST
    // line — no waiting for the incumbent to go stale, no accumulating
    // 20 lines of textCount. Kept below the clean-prose bonus (400) so it
    // cannot outweigh a full prose match on its own.
    if (cleanPreview.length >= 6 && TERMINAL_PUNCT_RE.test(cleanPreview)) {
      score += TERMINAL_PUNCT_BONUS;
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

    // v3.13.37: STALENESS PENALTY — see NOVELTY_* constants' doc above.
    const emitCount = hook.emitCount || 0;
    if (emitCount >= NOVELTY_MIN_EMITS) {
      const noveltyRatio = hook.textCount / emitCount;
      if (noveltyRatio < NOVELTY_RATIO_FLOOR) {
        const staleness = 1 - (noveltyRatio / NOVELTY_RATIO_FLOOR);
        score -= Math.round(NOVELTY_STALENESS_PENALTY_MAX * staleness);
      }
    }

    return score;
  }

  _autoSelectBestHook() {
    if (this._selectedHookKey) return; // User manually selected, don't auto-switch

    let bestHook = null;
    let bestScore = -Infinity;
    let hasRealCandidate = false;

    for (const [key, hook] of this._hooks) {
      if (hook.textCount === 0) continue;
      if (!hook.isSystemHook) hasRealCandidate = true;
      const score = this._scoreHook(hook);
      if (score > bestScore) {
        bestScore = score;
        bestHook = hook;
      }
    }

    // v3.13.24: if every candidate with text so far is a system hook
    // (Console/Clipboard), there's no real hook into the game yet — refuse
    // to auto-select one. Without this guard, the scorer still picks
    // *something* (even a heavily-penalized system hook, if it's the only
    // option), and Tuhua silently translates whatever's in the Windows
    // clipboard or Textractor's own console output as if it were game
    // dialogue — confirmed as the actual cause of a real "wrong game
    // detected" bug report, not a hypothetical. Leaving
    // _autoSelectedHookKey unset means _processHookLine's `activeHookKey ===
    // hookKey` gate never matches, so no 'text' event fires at all — no
    // more informative than before from the translation pane alone, which
    // is why _emitHookDiscovery computes and emits `noRealHookFound`
    // explicitly (v3.13.29: this comment used to name a function,
    // _emitNoRealHookWarning, that doesn't exist in this file — corrected
    // to point at the mechanism that actually does this job) instead of
    // failing silently.
    if (!hasRealCandidate) {
      if (this._autoSelectedHookKey !== null) {
        console.log(`[TextractorLauncher] Only system hooks seen so far — clearing auto-selection instead of picking one`);
        this._autoSelectedHookKey = null;
      }
      return;
    }

    if (bestHook) {
      const prevAuto = this._autoSelectedHookKey;

      // STABILITY: Don't switch unless the new hook is significantly
      // better — but the incumbent's required margin decays with how long
      // it's been since it last produced text (see HOOK_SWITCH_THRESHOLD's
      // comment). A hook that's actively producing keeps its full +200
      // claim; one that's gone quiet for STALE_HOOK_FULL_DECAY_MS or more
      // loses it entirely.
      if (prevAuto && prevAuto !== bestHook.key) {
        const prevHook = this._hooks.get(prevAuto);
        if (prevHook) {
          const prevScore = this._scoreHook(prevHook);
          // v3.13.38: lastNewTextAt, not lastTextAt — lastTextAt advances on
          // EVERY emission including deduped repeats, so a hook re-spamming
          // one identical line never looked stale and kept its +200
          // incumbency claim forever. Falls back to lastTextAt for hook
          // objects built without the new field (the bench's hysteresis
          // fixtures, and anything pre-v3.13.38) — same deliberate
          // back-compat shape as _scoreHook's cjkRatio fallback; without it
          // those fixtures read 0 and every incumbent looks infinitely stale.
          const silentMs = Date.now() - (prevHook.lastNewTextAt || prevHook.lastTextAt || 0);
          let threshold = HOOK_SWITCH_THRESHOLD;
          if (silentMs > STALE_HOOK_GRACE_MS) {
            const decayProgress = Math.min(1, (silentMs - STALE_HOOK_GRACE_MS) / (STALE_HOOK_FULL_DECAY_MS - STALE_HOOK_GRACE_MS));
            threshold = HOOK_SWITCH_THRESHOLD * (1 - decayProgress);
          }

          if (bestScore <= prevScore + threshold) {
            return;
          }
          console.log(`[TextractorLauncher] Hook switch: ${prevHook.displayName} (${prevScore}) → ${bestHook.displayName} (${bestScore}) — significant improvement (threshold ${Math.round(threshold)}, incumbent silent ${Math.round(silentMs / 1000)}s)`);
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
        qualityPenalty: hook.qualityPenalty || 0,
        // v3.13.23: exposes _autoSelectBestHook's scoring so the UI can show
        // *why* a hook was picked, not just log it.
        score: hook.textCount > 0 ? this._scoreHook(hook) : null
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

    // v3.13.24: true when hooks exist but none of them are a real game hook
    // (only Console/Clipboard) AND the user hasn't manually picked one —
    // exactly the state _autoSelectBestHook's guard above refuses to
    // auto-select from, so the UI can show a clear "no real hook yet"
    // message instead of the panel just looking idle while nothing
    // translates. Recomputed on every discovery update (debounced every
    // 500ms), so it clears itself automatically once a real hook engages —
    // some engines (KiriKiriZ observed taking ~45s) are slow to insert, so
    // this is NOT the same signal as the 10s "no hooks at all" diagnostic.
    const noRealHookFound = !this._selectedHookKey && hooks.length > 0 &&
      hooks.every(h => h.isSystemHook);

    this.emit('hooks-discovered', {
      hooks,
      selectedHookKey: this._selectedHookKey,
      autoSelectedHookKey: this._autoSelectedHookKey,
      activeHookKey,
      totalHooks: hooks.length,
      noRealHookFound,
      // v3.13.76: `gameEngine` (see _detectAndEmitGameEngine) rides on this
      // existing, already-allowlisted event instead of getting a channel of
      // its own — deliberate, to keep IPC surface flat (see
      // test-ipc-channels.js checks 1/4/5). The cost: this couples "what
      // engine the game is" to "what hooks exist", and this function stops
      // being pure over just `this._hooks`.
      // TRIGGER TO PROMOTE THIS TO ITS OWN CHANNEL: the moment the advisory
      // needs to appear outside the Textractor flow — OCR or XUAT mode,
      // where TextractorLauncher never runs at all, so this event is never
      // emitted and the advisory would simply never reach those screens.
      // Until then, this coupling is correct: the advisory only ever needs
      // to be seen from here.
      gameEngine: this._gameEngine
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
        qualityPenalty: hook.qualityPenalty || 0,
        // v3.13.23: exposes _autoSelectBestHook's scoring so the UI can show
        // *why* a hook was picked, not just log it.
        score: hook.textCount > 0 ? this._scoreHook(hook) : null
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
   * Returns true if >50% of even-indexed bytes are printable ASCII and
   * >50% of odd-indexed bytes are 0x00 (the JSDoc used to say ">60%" —
   * corrected in v3.13.29 to match what the code actually compares
   * against; behavior itself is unchanged, this method is not touched by
   * the v3.13.29 decoding fix beyond this comment). Blind to CJK-heavy
   * streams with no ASCII header: Japanese in UTF-16LE has high bytes in
   * 0x30/0x4E-0x9F, never 0x00, so this returns false on pure-Japanese
   * input — see _detectEncodingFromBytes's plausibility tiebreaker, which
   * exists specifically to catch what this heuristic misses.
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
   * Mirror of _isUtf16Le for UTF-16BE: ASCII bytes are 00 XX instead of
   * XX 00, so null bytes fall on EVEN indices and printable ASCII on ODD
   * indices — the reverse of _isUtf16Le's check.
   *
   * Textractor never emits UTF-16BE in practice — Node has no built-in BE
   * decoder, and there is no known code path that would produce it. A
   * positive result here is therefore treated as a SYMPTOM of something
   * else being wrong upstream (corrupted pipe, wrong process attached,
   * stream crossed with another source), not as a variant to support: see
   * _detectEncodingFromBytes, which surfaces it via an 'encoding-warning'
   * event instead of silently misdecoding.
   */
  _isUtf16Be(buf) {
    if (buf.length < 4) return false;
    const checkLen = Math.min(buf.length, 40);
    let printableOdd = 0;
    let nullEven = 0;
    const pairs = Math.floor(checkLen / 2);
    for (let i = 0; i < pairs; i++) {
      const hi = buf[i * 2];
      const lo = buf[i * 2 + 1];
      if (lo >= 0x20 && lo < 0x7F) printableOdd++;
      if (hi === 0x00) nullEven++;
    }
    if (pairs < 2) return false;
    return (printableOdd / pairs > 0.5 && nullEven / pairs > 0.5);
  }

  /**
   * BOM-based encoding detection — authoritative when present, checked
   * before any heuristic. Requires 4 bytes before honoring an FF FE prefix
   * as UTF-16LE so a UTF-32LE BOM (FF FE 00 00) isn't mistaken for it —
   * TextractorCLI never emits UTF-32, but the check is free and this is
   * the one place where being wrong would be permanent for the session.
   * Returns 'utf16le' | 'utf8' | 'utf16be' | null (no BOM, or not enough
   * bytes yet to tell — callers should keep accumulating in that case).
   */
  _detectBom(buf) {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8';
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xFE) {
      if (buf[2] === 0x00 && buf[3] === 0x00) return null; // UTF-32LE — unsupported, fall through to heuristics
      return 'utf16le';
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf16be';
    return null;
  }

  /**
   * Fraction of "plausible game-text" characters in a decoded sample, in
   * [0, 1]. Weighted heavily against U+FFFD and the PUA ranges because
   * those are the exact fingerprint of the misdecode this whole change
   * exists to fix: a 1-byte-misaligned UTF-16LE read of a kanji followed
   * by a katakana character (e.g. 止 U+6B62 + モ U+30E2 -> LE bytes
   * 62 6b e2 30 -> reading "6b e2" as one code unit gives U+E26B) lands
   * in the Private Use Area — confirmed by direct reproduction, not
   * guessed. Used only as a tiebreaker when neither a BOM nor
   * _isUtf16Le's fast path can decide (see _detectEncodingFromBytes).
   */
  _scoreTextPlausibility(str) {
    if (!str || !str.length) return 0;
    let good = 0;
    let bad = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp === 0x09 || cp === 0x0A || cp === 0x0D) { good++; continue; }
      if (cp === 0xFFFD) { bad += 3; continue; }               // replacement char
      if (cp >= 0xE000 && cp <= 0xF8FF) { bad += 3; continue; } // PUA (BMP)
      if (cp >= 0xF0000) { bad += 3; continue; }                // PUA (planes 15-16)
      if (cp < 0x20) { bad += 2; continue; }                    // other C0 controls / NUL
      if (cp < 0x7F) { good++; continue; }                      // ASCII printable
      if ((cp >= 0x3000 && cp <= 0x30FF) ||                     // CJK punctuation + kana
          (cp >= 0x4E00 && cp <= 0x9FFF) ||                     // CJK ideographs
          (cp >= 0xFF00 && cp <= 0xFF60) ||                     // fullwidth forms
          (cp >= 0xAC00 && cp <= 0xD7AF) ||                     // hangul syllables
          (cp >= 0x00A0 && cp <= 0x024F)) { good++; continue; } // latin-1 supp / extended
      bad += 1;
    }
    return good / (good + bad);
  }

  /**
   * Decide stdout's encoding from an accumulated raw byte sample. Order:
   *   1. BOM — authoritative.
   *   2. _isUtf16Le's fast path, unchanged — the common case, since
   *      TextractorCLI's banner and hook headers are ASCII.
   *   3. _isUtf16Be's mirror check — equally strong a structural signal as
   *      #2, so it runs BEFORE the plausibility tiebreaker, not after.
   *      Verified this ordering matters, not just symmetric for its own
   *      sake: a BE-encoded sample with CJK content can score >0.5
   *      "plausible" if misread as LE (byte-swapped kanji sometimes still
   *      land in a CJK Unicode range by coincidence — measured s16=0.54 on
   *      a real BE test line), which would beat the plausibility
   *      tiebreaker's margin and misdetect BE as LE. The structural
   *      null-byte-position check has no such coincidence risk.
   *   4. Plausibility tiebreaker — decode the sample both ways and keep
   *      whichever produces less PUA/replacement-char garbage. Needed
   *      because _isUtf16Le returns false for a sample that is pure
   *      Japanese in UTF-16LE (its high bytes are 0x30/0x4E-0x9F, never
   *      the 0x00 the heuristic counts — verified directly). A 0.05
   *      margin favors utf8 on a near-tie, so an inconclusive sample keeps
   *      today's default instead of flipping on noise.
   * Returns { encoding, reason, warn? } — `warn`, when present, is an
   * encoding name the caller should surface via 'encoding-warning'. BE is
   * never decoded as BE itself (Node has no BE decoder) — it's always
   * reported as a warning and treated as utf8 for the (already wrong,
   * already flagged) fallback decode.
   */
  _detectEncodingFromBytes(buf) {
    const bom = this._detectBom(buf);
    if (bom === 'utf16le' || bom === 'utf8') return { encoding: bom, reason: 'bom' };
    if (bom === 'utf16be') {
      return { encoding: 'utf8', reason: 'bom-utf16be', warn: 'utf16be' };
    }

    if (this._isUtf16Le(buf)) return { encoding: 'utf16le', reason: 'heuristic-ascii-null' };
    if (this._isUtf16Be(buf)) return { encoding: 'utf8', reason: 'heuristic-utf16be-mirror', warn: 'utf16be' };

    const even = (buf.length % 2 === 0) ? buf : buf.subarray(0, buf.length - 1);
    const s16 = this._scoreTextPlausibility(even.toString('utf16le'));
    const s8 = this._scoreTextPlausibility(buf.toString('utf8'));
    if (s16 > s8 + 0.05) {
      return { encoding: 'utf16le', reason: `plausibility utf16le=${s16.toFixed(2)} > utf8=${s8.toFixed(2)}` };
    }
    return { encoding: 'utf8', reason: `plausibility utf8=${s8.toFixed(2)} >= utf16le=${s16.toFixed(2)}` };
  }

  /**
   * Clean game text before sending to translation pipeline.
   * v3.8.25: Fixes common Textractor text issues.
   * v3.13.20: Reduced to launcher-specific framing (progressive counter
   * lines are a stdout artifact that TCP never sees) plus whitespace
   * normalize. The dedup/artifact-removal work (control chars, char/line
   * repeat collapse, doubled-text fix, digit-delimiter dedup, garbage
   * digit stripping) now lives once in src/services/text-cleaning.js and
   * is delegated to here — previously this method duplicated most of that
   * logic itself, and ipc-handlers.js's _handleText ran a near-identical
   * second copy on the same text a second time after this emitted it.
   * Confirmed idempotent (see plan-hook-text-cleaning's Fase 1 section)
   * so calling cleanHookText here AND again in _handleText is harmless,
   * not a correctness requirement to avoid — this method still calls it
   * directly (rather than emitting unclean text) so the hook-preview UI
   * (_cleanGameText is also called for previews, not just the actual
   * emit path) shows accurately cleaned text.
   */
  _cleanGameText(text) {
    if (!text) return text;
    let cleaned = text;

    // Progressive counter lines: Textractor sometimes outputs progressive
    // char-by-char cursor-position updates as short numeric-only lines.
    // Launcher/stdout-specific framing (TCP delivers text differently and
    // never has this problem), so this stays here rather than moving to
    // the shared module.
    cleaned = cleaned.split("\n")
      .filter(line => {
        const trimmed = line.trim();
        if (/^\d+$/.test(trimmed) && trimmed.length <= 3) return false;
        if (/^\s*$/.test(line)) return false;
        return true;
      })
      .join(" ");

    // v3.13.20: settings-derived options, not defaults — if this ran with
    // defaults regardless of what the user configured, a step disabled via
    // settings would still fire here (the launcher route's FIRST pass),
    // making the setting silently ineffective on this route even though
    // _handleText's second pass (also settings-aware) would correctly skip
    // it — there'd just be nothing left for it to skip.
    const cleaningOptions = this.hookCleaningSettings ? this.hookCleaningSettings.getOptions() : {};
    cleaned = textCleaning.cleanHookText(cleaned, cleaningOptions);

    // Whitespace normalize — launcher-specific historically (TCP text
    // never went through this step; preserved as-is here rather than
    // added to the shared module, to keep this consolidation neutral on
    // anything beyond the dedup algorithms it set out to unify).
    cleaned = cleaned.replace(/[ \t]+/g, " ").trim();
    cleaned = cleaned.replace(/\n+/g, " ");

    return cleaned.trim();
  }
  /**
   * Process stdout data.
   *
   * v3.13.29: replaces a hand-rolled incremental decoder (a manual byte
   * carry-over + parity check, tuned for utf16le only) that had three
   * confirmed holes, all reproduced directly against
   * scripts/test-stdout-decoding.js's baseline run against this method
   * before this rewrite:
   *   1. A first chunk shorter than 4 bytes skipped encoding detection
   *      entirely (the old `data.length >= 4` gate), decoded with the
   *      'utf8' default, and DROPPED its trailing odd byte — the old
   *      carry only ever ran once encoding was already known to be
   *      utf16le. Every later chunk then started at an odd byte offset,
   *      including the one the detector finally sampled — so the
   *      heuristic itself saw misaligned data and the session locked to
   *      utf8 permanently. A first chunk of 1 or 3 bytes reproduces this
   *      exactly.
   *   2. The carry was a `Buffer#subarray` VIEW into the stream's own
   *      chunk, not a copy — safe only as long as nothing reuses that
   *      memory before the next 'data' event. Measured 0 such reuses on
   *      Node 20/Linux, but the pattern was unsafe regardless of whether
   *      it had fired yet (a buffer-reuse simulation makes every odd
   *      split offset fail).
   *   3. A stream delivered one byte at a time could never satisfy
   *      `data.length >= 4`, so it was corrupted from the first
   *      character.
   * `StringDecoder` (Node core) is stateful and incremental by design,
   * copies partial code units into its own storage instead of holding a
   * view, and handles multi-byte UTF-8 sequences too (the old carry was
   * utf16le-only — a UTF-8 stream split mid-character also corrupted
   * under the old code, an additional bug this fixes as a side effect).
   *
   * Bytes that arrive before the encoding is known are held RAW in
   * _encodingSniffChunks — nothing is ever decoded with a guessed
   * encoding before the decision is made, which is what makes the bug
   * above permanent rather than transient in the old code.
   */
  _processStdoutData(data) {
    this._dataEventCount++;
    this._maybeDumpRawBytes(data);

    let chunk;
    if (this._stdoutDecoder) {
      chunk = this._stdoutDecoder.write(data);
    } else {
      // Still sniffing: hold the raw bytes and wait for either a decisive
      // BOM or ENCODING_SNIFF_MIN_BYTES total, whichever comes first.
      // Buffer.from(data) — NOT data itself — deliberately: `data` is
      // caller-owned and this array can outlive the current call (when
      // the sniff isn't done yet, execution returns below and the array
      // is read again on the NEXT 'data' event). Retaining `data` by
      // reference here is exactly the class of bug this whole rewrite
      // exists to eliminate (see this method's doc, point 2) — confirmed
      // by scripts/test-stdout-decoding.js's 'hostile' mode, which caught
      // this directly during development: it failed at every stream whose
      // first chunk was small enough to still be sniffing.
      this._encodingSniffChunks.push(Buffer.from(data));
      this._encodingSniffBytes += data.length;
      const sniff = Buffer.concat(this._encodingSniffChunks, this._encodingSniffBytes);
      if (this._encodingSniffBytes < ENCODING_SNIFF_MIN_BYTES && this._detectBom(sniff) === null) {
        return;
      }
      chunk = this._openStdoutDecoder(sniff);
    }

    if (chunk) this._stdoutBuffer += chunk;
    this._drainStdoutLines(false);
  }

  /**
   * Decide the encoding from the accumulated sniff buffer, create the
   * StringDecoder, and feed it the ENTIRE sniff buffer as its first
   * write — so the bytes that arrived before the decision was made are
   * decoded WITH the decision, not before it. Also used by _flushStdout
   * when the stream ends before a decision was ever reached.
   */
  _openStdoutDecoder(sniffBuf) {
    const det = this._detectEncodingFromBytes(sniffBuf);
    this._detectedEncoding = det.encoding;
    this._encodingSniffChunks = [];
    this._encodingSniffBytes = 0;
    this._stdoutDecoder = new StringDecoder(det.encoding);
    console.log(`[TextractorLauncher] stdout encoding: ${det.encoding} (${det.reason}, ${sniffBuf.length}B sample)`);
    // v3.13.29: mainly observability (a UI could show this; the bench
    // uses it too, since _flushStdout resets _detectedEncoding back to
    // null as its last step, so reading the field after a flush-driven
    // decision can't observe what was decided).
    this.emit('encoding-detected', { encoding: det.encoding, reason: det.reason, sampleBytes: sniffBuf.length });
    if (det.warn) {
      const warning = { encoding: det.warn, hint: 'Textractor does not use UTF-16BE; check pipe configuration' };
      console.warn(`[TextractorLauncher] ENCODING WARNING: ${JSON.stringify(warning)}`);
      this.emit('encoding-warning', warning);
    }
    return this._stdoutDecoder.write(sniffBuf);
  }

  /**
   * Split the accumulated decoded buffer into lines and run each one
   * through the existing sanitize/parse/emit pipeline — unchanged from
   * before v3.13.29 (see the plan's "que NO tocar": _sanitizeLine and
   * _parseHookLine are deliberately untouched by this decoding fix).
   * `final=true` (only from _flushStdout) also consumes the trailing
   * partial line instead of holding it back in _stdoutBuffer for the next
   * chunk — used when the stream is ending and there won't be one.
   */
  _drainStdoutLines(final) {
    const lines = this._stdoutBuffer.split('\n');
    this._stdoutBuffer = final ? '' : (lines.pop() || '');

    for (const line of lines) {
      const sanitized = this._sanitizeLine(line);
      const trimmedLine = sanitized.trim();
      if (!trimmedLine) continue;

      this._totalLinesProcessed++;

      // HEX DUMP (decoded string) first N lines for cleaning diagnostics —
      // distinct from _maybeDumpRawBytes's wire-byte dump above.
      if (this._hexDumpCount < this._maxHexDumps) {
        this._hexDumpCount++;
        console.log(`[TextractorLauncher] HEX(decoded) #${this._hexDumpCount}: ${this._hexDump(trimmedLine)}`);
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
   * v3.13.29: drain whatever is left when the stdout stream ends — two
   * things the old code silently dropped at the `close` handler: the
   * trailing partial line held in _stdoutBuffer, and (if the process
   * exited before ENCODING_SNIFF_MIN_BYTES ever accumulated) the entire
   * sniff buffer — a process that emits one short line and exits produced
   * NO output at all under the old code. Called from the `close` handler;
   * deliberately NOT called from kill() (the user stopped it on purpose,
   * nothing to recover) — see kill()'s comment.
   */
  _flushStdout(reason) {
    if (!this._stdoutDecoder && this._encodingSniffBytes > 0) {
      const sniff = Buffer.concat(this._encodingSniffChunks, this._encodingSniffBytes);
      const chunk = this._openStdoutDecoder(sniff);
      if (chunk) this._stdoutBuffer += chunk;
    }
    if (this._stdoutDecoder) {
      const tail = this._stdoutDecoder.end();
      if (tail) this._stdoutBuffer += tail;
    }
    if (this._stdoutBuffer) {
      console.log(`[TextractorLauncher] Flushing ${this._stdoutBuffer.length} trailing chars on ${reason}`);
      this._drainStdoutLines(true);
    }
    this._resetStreamState();
  }

  /**
   * Test if TextractorCLI can start without attaching to any process.
   * This verifies that the executable is valid, DLLs are present, etc.
   * Returns { canStart, exitCode, stderr, stdout, hint }
   */
  async testLaunch(cliPath) {
    // v3.13.24: every result now carries hintKey/hintParams alongside the
    // English-fallback `hint` string, same pattern as _buildError/
    // validatePath — this is the exact function behind the "TextractorCLI
    // inició correctamente" message that showed up in Spanish regardless
    // of UI language.
    const testPath = cliPath || this.cliPath;
    if (!testPath) {
      return { canStart: false, exitCode: -1, stderr: '', stdout: '', hintKey: 'hint_no_path_configured', hint: 'TextractorCLI path not configured' };
    }

    const validation = this.validatePath(testPath);
    if (!validation.valid) {
      return { canStart: false, exitCode: -1, stderr: '', stdout: '', hintKey: validation.messageKey, hintParams: validation.messageParams, hint: validation.message };
    }

    // Use the auto-resolved path from validation (folder -> x64/Textractor.exe)
    const resolvedPath = validation.resolved;

    return new Promise((resolve) => {
      let testStdout = '';
      let testStderr = '';
      let settled = false;

      const finish = (canStart, exitCode, hint, hintKey, hintParams) => {
        if (settled) return;
        settled = true;
        resolve({ canStart, exitCode, stderr: testStderr.trim(), stdout: testStdout.trim(), hint, hintKey: hintKey || null, hintParams: hintParams || null, resolvedPath });
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
          finish(true, 0, 'TextractorCLI started successfully', 'hint_cli_started_ok');
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
            finish(true, code || 0, `TextractorCLI started successfully (code: ${code})`, 'hint_cli_started_ok_code', { code: String(code) });
          } else {
            const interpreted = interpretExitCode(code);
            let hintMsg = interpreted.hint || 'Could not start TextractorCLI';
            let hintKey = interpreted.hintKey || 'hint_could_not_start';
            let hintParams = interpreted.hintParams || null;
            if (testStderr.includes('DLL') || testStderr.includes('dll')) {
              hintKey = 'hint_dll_missing_test';
              hintParams = null;
              hintMsg = 'Missing DLL. Install Visual C++ Redistributable 2015-2022.';
            }
            if (testStderr.includes('bit') || testStderr.includes('architecture')) {
              hintKey = 'hint_wrong_architecture_test';
              hintParams = null;
              hintMsg = 'Wrong architecture. Use 64-bit TextractorCLI for 64-bit games.';
            }
            finish(false, code, hintMsg, hintKey, hintParams);
          }
        });

        testProc.on('error', (err) => {
          clearTimeout(timeout);
          let hintMsg = 'Could not run TextractorCLI';
          let hintKey = 'hint_could_not_run';
          let hintParams = null;
          if (err.code === 'ENOENT') {
            hintKey = 'hint_file_not_found_at';
            hintParams = { path: resolvedPath };
            hintMsg = 'File not found: ' + resolvedPath;
          } else if (err.code === 'EACCES') {
            hintKey = 'hint_permission_denied_admin';
            hintMsg = 'Permission denied. Run as Administrator.';
          } else if (err.code === 'EPERM') {
            hintKey = 'hint_permission_denied_av';
            hintMsg = 'Permission denied by the system. Antivirus blocking it?';
          }
          finish(false, -1, hintMsg, hintKey, hintParams);
        });
      } catch (err) {
        finish(false, -1, 'Error launching: ' + err.message, 'hint_launch_error', { message: err.message });
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
    const interpreted = code !== undefined ? interpretExitCode(code) : { severity: 'error', hintKey: null, hint: '' };
    // v3.13.24: hintKey/hintParams let the renderer translate this instead
    // of displaying the hardcoded (English-fallback) `hint` string as-is.
    const error = {
      message,
      messageKey: extra.messageKey || null,
      messageParams: extra.messageParams || null,
      code: code !== undefined ? code : null,
      severity: interpreted.severity,
      hint: interpreted.hint || extra.hint || '',
      hintKey: interpreted.hintKey || extra.hintKey || null,
      hintParams: interpreted.hintParams || extra.hintParams || null,
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
    // v3.13.23: A fresh, user-initiated launch gets one arch-fallback retry.
    // An internal fallback retry (options._isArchFallbackRetry) must NOT
    // reset this, or a bad path in both architectures would relaunch forever.
    if (!options._isArchFallbackRetry) {
      this._archFallbackAttempted = false;
    }
    // v3.13.32: every launch() call — retry or not — starts a fresh process
    // lifecycle, so any 'killed-by-user' latch from a PREVIOUS session must
    // not leak into this one's close handler. See kill()'s doc for what
    // this flag guards (skipping the quick-exit arch-fallback branch after
    // a deliberate stop).
    this._killedByUser = false;

    const cliPath = options.cliPath || this.cliPath;
    if (!cliPath) {
      const err = this._buildError('TextractorCLI path not configured', undefined, { hintKey: 'hint_configure_path', hint: 'Configure the path to TextractorCLI.exe in the Textractor section.' });
      this.emit('error', err);
      return false;
    }

    if (this.isRunning) {
      this.kill();
    }

    const validation = this.validatePath(cliPath);
    if (!validation.valid) {
      const err = this._buildError(validation.message, undefined, {
        messageKey: validation.messageKey, messageParams: validation.messageParams,
        hintKey: 'hint_verify_path', hint: 'Verify that the path to TextractorCLI.exe or the Textractor folder is correct.'
      });
      this.emit('error', err);
      return false;
    }

    // Use the auto-resolved path from validation (folder -> x64/Textractor.exe)
    // v3.13.32: `let`, not `const` — see the preference swap right below,
    // which reassigns this SAME variable so every downstream use (spawn,
    // its cwd, the log line, the 'launched' payload) picks up the swap
    // too, rather than a separately-named variable only some of them read.
    let resolvedPath = validation.resolved;

    // v3.13.32: if an earlier session on this SAME Textractor install
    // proved the OTHER architecture is the one that actually hooks games,
    // start there instead of repeating the 60s discovery — see
    // _markArchSuccess's doc. Only ever swaps BETWEEN the x64/x86 halves
    // of the path the caller gave us (same _archInstallKey), so pointing
    // at a genuinely different install always wins: an explicit user
    // choice is never silently overridden. Skipped on a fallback retry
    // itself (options._isArchFallbackRetry) — that call already carries
    // the exact path _attemptArchFallback computed, which must not be
    // second-guessed here.
    if (!options._isArchFallbackRetry) {
      const preferred = this._archPreference.get(this._archInstallKey(resolvedPath));
      if (preferred && preferred !== resolvedPath) {
        console.log(`[TextractorLauncher] Using previously proven architecture for this install: "${resolvedPath}" -> "${preferred}"`);
        resolvedPath = preferred;
      }
    }

    // v3.13.8x: pre-flight arch check — see _preflightArchSwap's own doc.
    // Runs AFTER the _archPreference swap above on purpose: PE evidence
    // about THIS process overrides both _archPreference and the persisted
    // arch-resolved path in src/main/index.js, because those are proof
    // about a past session and this is proof about this one. Skipped on a
    // fallback retry for the same reason the preference swap above is —
    // that call already carries the exact path _attemptArchFallback
    // computed. Deliberately does not touch _archFallbackAttempted or
    // _archAttemptMemory: this isn't a fallback, it runs before spawn, so
    // the 60s safety net stays fully armed for whatever this can't
    // resolve (see the method doc for every silent-degrade case).
    if (!options._isArchFallbackRetry) {
      const preflightPath = this._preflightArchSwap(resolvedPath, options.gameExePath);
      if (preflightPath) resolvedPath = preflightPath;
    }
    this._lastResolvedPath = resolvedPath;
    // Deliberately NOT this.configure(resolvedPath) — configure() emits
    // 'status','configured', which _emitStatus has no special case for
    // (falls into updateCliStatus's `default:` branch in the renderer)
    // and would overwrite whatever this launch's own status is about to
    // show. Plain assignment keeps getStats()/_buildError()'s embedded
    // cliPath honest without that side effect.
    this.cliPath = resolvedPath;

    const gamePid = options.pid || pid;
    if (!gamePid || isNaN(gamePid)) {
      const err = this._buildError('Invalid game PID', undefined, { hintKey: 'hint_invalid_pid', hint: 'Enter a valid game PID (positive number). Find it in Task Manager → Details.' });
      this.emit('error', err);
      return false;
    }

    this._gamePid = gamePid;
    this._launchTime = Date.now();

    // v3.13.31: best-effort warning if this PID doesn't correspond to a
    // running process — see _checkPidIsRunning's doc for why this exists.
    const pidRunning = this._checkPidIsRunning(gamePid);
    if (pidRunning === false) {
      console.warn(`[TextractorLauncher] WARNING: PID ${gamePid} does not appear to be a running process — attach will fail exactly as silently as an architecture mismatch. Verify the PID in Task Manager before assuming this is x64/x86.`);
      this.emit('pid-warning', { pid: gamePid, message: `PID ${gamePid} does not appear to be running.` });
    }

    // v3.13.37: tell the UI a discovery window is starting, so it can
    // show a live countdown instead of a dead "Launch" button during the
    // up-to-ARCH_FALLBACK_CHECK_MAX_MS wait for a real hook. Gated on
    // pidRunning !== false: a dead PID (stale after a game/PC restart)
    // should show the pid-warning above instead of racing it with a
    // countdown that's doomed to fail. launch() is the SAME function used
    // both for a fresh launch and for _attemptArchFallback's internal
    // retry, so this one emit site covers both — the retry's own
    // resolvedPath naturally yields the other arch's label.
    if (pidRunning !== false) {
      this.emit('search-started', { arch: this._detectArch(resolvedPath), durationMs: ARCH_FALLBACK_CHECK_MAX_MS });

      // v3.13.76: detect the game's engine right as the discovery window
      // opens, not reactively after it — see _detectAndEmitGameEngine's doc.
      // Reset first: a fresh launch() (new PID) must not keep showing a
      // stale advisory from whatever game was attached before. Re-running
      // this on an _attemptArchFallback retry (same PID) just re-resolves
      // the same result — a redundant PowerShell call, not a correctness
      // issue, and far cheaper than the 60s it's saving the user from.
      this._gameEngine = null;
      this._detectAndEmitGameEngine(gamePid);
    }

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

      if (process.platform === 'win32' && !this._showCliWindow) {
        spawnOptions.windowsHide = true;
      }
      if (this._showCliWindow) {
        console.log(`[TextractorLauncher] TUHUA_SHOW_CLI_WINDOW=1 — spawning with a visible console window for this diagnostic.`);
      }

      this.process = spawn(resolvedPath, args, spawnOptions);
      // v3.13.32: identifies THIS process to its own event handlers below —
      // see the constructor's _launchGeneration doc for the late-'close'
      // race this exists to close. Incremented only here, after a spawn
      // that didn't throw — a spawn error must NOT consume a generation,
      // or the 'error' handler's own generation check would immediately
      // discard the very error it's meant to report.
      const generation = ++this._launchGeneration;

      this.isRunning = true;
      this._outputBuffer = [];
      // v3.13.29: replaces manual reset of _stdoutBuffer/_lastTextHash/
      // _dataEventCount/_hexDumpCount/_detectedEncoding/_rawByteCarry —
      // see _resetStreamState's doc.
      this._resetStreamState();
      this._stdinSent = false;
      this._attachSendCount = 0;
      this._hookInsertCount = 0;
      this._legacyParseCount = 0;
      // v3.13.32: whether _sendKnownGoodHooks has already run THIS
      // session — see its new call site in the diagnostic's
      // 'no-clean-hook' branch for why this needs a per-session guard now
      // that it's no longer unconditional.
      this._knownGoodHooksSent = false;
      this._archSuccessMarked = false;
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

      // Clean up any timers left over from a previous session — v3.13.29:
      // now routed through the single _clearTimers() rather than repeating
      // the same three clears inline (a fourth and fifth timer existed
      // elsewhere in this file with NO clear at all until this version;
      // duplicating the cleanup here instead of sharing it is exactly how
      // those two got missed — see _clearTimers()).
      this._clearTimers();

      // === SEND ATTACH VIA STDIN IMMEDIATELY ===
      this._sendStdinAttach(gamePid, 'immediate');

      // === ALSO SEND AFTER 1.5 SECONDS, BUT ONLY IF NEEDED ===
      // v3.13.32: conditional now — see _attachWasAcknowledged's doc for
      // why an unconditional second attach here was a real contributor to
      // the game freezing on every single launch, not just a redundant
      // log line.
      this._stdinTimer = setTimeout(() => {
        this._stdinTimer = null;
        const acked = this._attachWasAcknowledged();
        const shouldResend = !acked || this._forceDoubleAttach;
        console.log(`[TextractorLauncher] 1.5s backup attach check: acked=${acked} (hookLines=${this._hookLinesProcessed}, hooks=${this._hooks.size}, stdoutEvents=${this._dataEventCount}) -> ${shouldResend ? 'RESEND' : 'skip'}`);
        if (shouldResend) this._sendStdinAttach(gamePid, 'delayed-1.5s');
      }, 1500);

      // === HOOK DISCOVERY PHASE ===
      // After 3 seconds, finalize initial hook discovery.
      // v3.13.29: handle now saved (was a bare, uncancelable setTimeout)
      // and cleared by _clearTimers() — a real leak, not defensive-only:
      // it used to survive kill() AND a relaunch via arch-fallback. On the
      // 'quick-exit' path in particular (fallback fires before 2s), this
      // timer from the ABANDONED attempt fired after the NEW launch()
      // had already cleared this._hooks for the new session, emitting a
      // spurious 'hooks-discovered' and marking _hookDiscoveryPhase=true
      // prematurely for a session that had barely started — and each
      // further relaunch added another one of these ticking in the
      // background.
      this._hookDiscoveryPhaseTimer = setTimeout(() => {
        this._hookDiscoveryPhaseTimer = null;
        this._hookDiscoveryPhase = true;
        this._emitHookDiscovery();
        console.log(`[TextractorLauncher] Hook discovery phase complete. ${this._hooks.size} hooks found.`);
      }, 3000);

      // === ARCH-FALLBACK DIAGNOSTIC CHECK ===
      // v3.13.27: used to be a single check at 10s. Confirmed too fragile
      // with a real ~3.5min session on Nekopara Vol.1 (KiriKiriZ): the first
      // real (non-system) hook didn't show up until ~13.7s — just past the
      // one-shot window. At the 10s mark only system hooks existed yet, so
      // the check correctly deferred (per the "some engines take up to ~45s"
      // reasoning below) — but a one-shot timer never got a second look, so
      // the HB0@0-only hooks that arrived a few seconds later were never
      // evaluated and the fallback that should have fired simply never got
      // a chance to. That session ran to completion entirely on garbled x64
      // hooks. Fix: re-run the same check every
      // ARCH_FALLBACK_CHECK_INTERVAL_MS until either a fallback fires, a
      // non-generic real hook shows up, or ARCH_FALLBACK_CHECK_MAX_MS is
      // reached.
      const runArchFallbackCheck = (elapsedMs) => {
        this._diagnosticTimer = null;
        const activeHook = this.getActiveHookKey();
        const elapsedLabel = `${Math.round(elapsedMs / 1000)}s`;
        console.warn(`[TextractorLauncher] ${elapsedLabel} DIAGNOSTIC:`);
        console.warn(`[TextractorLauncher]   Total hooks: ${this._hooks.size}`);
        console.warn(`[TextractorLauncher]   Active hook: ${activeHook || 'none'}`);
        console.warn(`[TextractorLauncher]   Lines processed: ${this._totalLinesProcessed} (hook lines: ${this._hookLinesProcessed})`);

        // Distinguish "no real hook has produced text yet" (keep waiting —
        // some engines, e.g. KiriKiriZ, take up to ~45s) from "a real hook
        // exists and isn't stuck on a degraded type/content" (nothing to
        // fix, stop polling).
        const realHooks = Array.from(this._hooks.values()).filter(h => !h.isSystemHook);
        const realWithText = realHooks.filter(h => h.textCount > 0);
        // v3.13.8x: routed through _hasRealHookWithText() rather than
        // `realWithText.length > 0` inline — same value, but this
        // guarantees the pre-flight arch-mismatch check (Level 2) can
        // never drift onto a different definition of "already proven".
        const hasRealHookWithText = this._hasRealHookWithText();
        // v3.13.30: distinct from `_hooks.size === 0` below — see the
        // last-resort branch at the bottom of this function for why this
        // is needed at all.
        const hasAnyRealHook = realHooks.length > 0;

        // v3.13.36: TWO independent signals that "this architecture isn't
        // working for this game" — either alone is enough to escalate, and
        // they're kept separate on purpose because they cover different
        // failure shapes:
        //   structural — the auto-engine never identified a single typed
        //     hook all session (every real hook is single-byte type). This
        //     is the v3.13.26 signal; it was DEAD before this version for
        //     two independent reasons layered on top of each other: a
        //     \d+-vs-hex parser bug that left hookCode at '' (so the old
        //     exact-string check against 'HB0@0' had nothing to match),
        //     and — even with hookCode present — that check compared
        //     against a bare literal while the real string always carries
        //     a module suffix ("HB0@0:nekopara_vol1_trial.exe"), so it
        //     could never be true against a real line either way.
        //   content — every real hook that HAS produced text shows the
        //     UTF-16-byte garbage signature. Fires even with mixed hook
        //     types, and even if the parser fell back to legacy formats
        //     and hookCode is empty — it only looks at the text itself.
        const structurallyDegraded = this._allRealHooksAreSingleByteType();
        const contentDegraded = hasRealHookWithText && realWithText.every(h => h.looksUtf16Garbled);

        if (this._hooks.size === 0) {
          console.warn(`[TextractorLauncher]   *** NO HOOKS FOUND! ***`);
          console.warn(`[TextractorLauncher]   Possible causes:`);
          console.warn(`[TextractorLauncher]     1. PID ${gamePid} is not a valid game process`);
          console.warn(`[TextractorLauncher]     2. TextractorCLI didn't receive the attach command`);
          console.warn(`[TextractorLauncher]     3. Game is not producing text through hookable APIs`);
          console.warn(`[TextractorLauncher]   Try: Run TextractorCLI.exe manually in a terminal and type "attach -P${gamePid}"`);
          // v3.13.23: zero hooks can also mean the process attached to a PID
          // whose bitness doesn't match this TextractorCLI build — attach
          // doesn't always fail loudly in that case, it just never hooks
          // anything. Try the sibling architecture once before giving up.
          if (this._attemptArchFallback('no-hooks')) return;
        } else if (hasRealHookWithText && (structurallyDegraded || contentDegraded)) {
          // v3.13.26/v3.13.36: hooks DO exist, but they're degraded — a
          // different failure mode than "zero hooks", and one the
          // size===0 check above can't see. Confirmed real with a
          // side-by-side comparison on Nekopara Vol.1: x64 TextractorCLI's
          // own auto-engine consistently produced only single-byte hooks
          // across an entire multi-minute session (they don't self-correct
          // with more time), while x86 TextractorCLI auto-detected
          // specifically-typed hooks (HQ18@0, HQ8@0, HW8@0, KiriKiriZ's own
          // code) immediately on attach, no manual intervention needed.
          console.warn(`[TextractorLauncher]   *** HOOKS DEGRADED (single-byte type: ${structurallyDegraded}, UTF-16-as-bytes garbage: ${contentDegraded}) ***`);
          if (!this._knownGoodHooksSent) {
            // v3.13.32: try the CHEAP fix once before the expensive one.
            // _sendKnownGoodHooks used to run unconditionally 1.5s into
            // EVERY launch (see its own doc for why that was proactive by
            // design) — but that meant one more DLL-injection freeze on
            // every single healthy session too, for a hook code that in
            // practice only ever helped this exact degraded-hook failure
            // mode. Doesn't contradict the "proactive, not reactive"
            // reasoning documented there: that argument was about not
            // being able to correlate a garbled hook's runtime ADDRESS
            // back to a function name. The trigger here isn't a
            // correlation — it's this diagnostic's own whole-session
            // condition. The insertion is still blind as to which function
            // it helps; it's only deferred until there's evidence
            // something is actually wrong, and it costs one injection
            // instead of running on every launch regardless of need.
            console.warn(`[TextractorLauncher]   Trying known-good hook codes before falling back to the sibling architecture...`);
            this._sendKnownGoodHooks(`diagnostic-${elapsedLabel}`);
            this._knownGoodHooksSent = true;
            // Give it one polling interval to produce a clean hook before
            // considering the arch fallback — fall through to the
            // reschedule at the bottom rather than escalating this tick.
          } else {
            console.warn(`[TextractorLauncher]   The auto-engine's hooks stayed degraded, and the known-good hook code didn't help either — the sibling architecture may do better.`);
            if (this._attemptArchFallback('no-clean-hook')) return;
          }
        } else if (hasRealHookWithText) {
          // v3.13.36: this branch is why the real session that exposed
          // this whole chain went silent after exactly one tick — with
          // the parser bug leaving hookCode at '', the degraded-hooks
          // branch above evaluated false (an empty hookCode's type is
          // 'unknown', not 'byte'), so this `return` fired on the very
          // first 10s check, never sending KNOWN_GOOD_HOOK_CODES and
          // never attempting the sibling architecture.
          //
          // Still correct to stop here UNCONDITIONALLY now that the
          // degraded-hooks branch above is fixed: reaching this branch at
          // all means at least one real hook has text AND
          // (structurallyDegraded || contentDegraded) was false — i.e.
          // NOT every real-with-text hook is single-byte type, and NOT
          // every one of them looks like UTF-16-as-bytes garbage. Since
          // structurallyDegraded is computed over the exact same hook set
          // this branch sees, "not all single-byte" here means at least
          // one hook is a NON-byte type with text already — genuine
          // evidence of health, not merely the absence of bad evidence.
          // Nothing to fall back from.
          return;
        }

        const nextElapsed = elapsedMs + ARCH_FALLBACK_CHECK_INTERVAL_MS;
        if (nextElapsed <= ARCH_FALLBACK_CHECK_MAX_MS) {
          this._diagnosticTimer = setTimeout(() => runArchFallbackCheck(nextElapsed), ARCH_FALLBACK_CHECK_INTERVAL_MS);
          return;
        }

        if (!hasAnyRealHook && this._hooks.size > 0) {
          // v3.13.30: last-resort fallback attempt for the gap the
          // `_hooks.size === 0` branch above can't see — confirmed
          // necessary by a real Windows session log (Nekopara Vol.1 /
          // KiriKiriZ, x64): TextractorCLI's system Console/Clipboard
          // hooks register almost instantly on ANY attach attempt,
          // successful or not, so `_hooks.size` was already 1 (just the
          // system hook) by the very first 10s check in that session.
          // "Only system hooks, forever" then matched NONE of the three
          // branches above (size !== 0, and hasRealHookWithText stays
          // false since a system hook never counts as one), so the
          // diagnostic just quietly ran out the clock to the 60s cap and
          // gave up — never trying the sibling architecture at all.
          // That's exactly the case a user had to work around by manually
          // opening Textractor's own GUI and attaching there (a
          // successful GUI attach injects the hook into the game process,
          // which then broadcasts to any listener — including Tuhua's
          // already-running TextractorCLI — which is why that "fixed" it
          // with no logged connection between the two events, and why
          // re-running Tuhua fully elevated as Administrator changed
          // nothing: this was never a privilege issue).
          //
          // Gated on `_hooks.size > 0` (not just `!hasAnyRealHook`)
          // deliberately: the `_hooks.size === 0` branch above already
          // retries every tick on its own (it never sets
          // _archFallbackAttempted when there's no sibling arch to fall
          // back to, so nothing ever stops it) — without this guard, a
          // session with literally zero hooks the entire time would hit
          // BOTH that branch AND this one on the final tick, logging a
          // redundant second attempt right after the 11th "no hooks" one.
          console.warn(`[TextractorLauncher]   *** NO REAL HOOK EVER APPEARED after ${Math.round(ARCH_FALLBACK_CHECK_MAX_MS / 1000)}s (only system hooks) ***`);
          if (this._attemptArchFallback('no-real-hook')) return;
        }

        if (!hasAnyRealHook) {
          // v3.13.32: the window is over and no relaunch got launched —
          // either both architectures have now been tried for this
          // (install, PID) pair (the branch above returned false because
          // _attemptArchFallback found the sibling already exhausted or
          // nothing left to try), or this is the `_hooks.size === 0` case,
          // which never even reaches the branch above (deliberately, per
          // its own comment) and so was previously just as silent at the
          // cap. Report it as terminal instead of returning without a
          // trace — see _concludeArchFallback's doc for why the UI
          // bouncing back to "Launch" with no explanation was mistaken for
          // a hang rather than a real, actionable dead end.
          this._concludeArchFallback();
        }
      };
      this._diagnosticTimer = setTimeout(() => runArchFallbackCheck(10000), 10000);

      // v3.13.32: only ever false if _relaunchInProgress leaked past a
      // relaunch that already succeeded — clearing it here is what closes
      // the handover window _emitStatus() opened in _attemptArchFallback,
      // so THIS 'launched' is reported as an honest 'launched', not
      // relabeled by a stale flag.
      this._relaunchInProgress = false;
      this._emitStatus('launched');
      this.emit('launched', { pid: gamePid, cliPath: resolvedPath });
      console.log(`[TextractorLauncher] Launched — stdin immediate + delayed, hook discovery ON`);

      // === CAPTURE STDOUT ===
      this.process.stdout.on('data', (data) => {
        // v3.13.32: see the constructor's _launchGeneration doc — a NEWER
        // launch has already superseded this process, so its stdout must
        // not touch current-session state (hooks, buffers, hash dedup).
        if (generation !== this._launchGeneration) return;
        const sizeKB = Math.round(data.length / 1024);
        if (this._dataEventCount < 10 || sizeKB > 0) {
          console.log(`[TextractorLauncher] stdout event #${this._dataEventCount + 1}: ${data.length} bytes${sizeKB > 0 ? ` (${sizeKB}KB)` : ''}`);
        }
        this._processStdoutData(data);
      });

      // === CAPTURE STDERR (v3.8.23: improved capture) ===
      this.process.stderr.on('data', (data) => {
        if (generation !== this._launchGeneration) return;
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
        // v3.13.32: the single most important generation check in this
        // file — see the constructor's doc. kill() is asynchronous
        // (taskkill is a separate child process on Windows, ~50-400ms),
        // so during an arch-fallback handover this 'close' from the DYING
        // process routinely arrives after the REPLACEMENT process's own
        // 'launched'. Without this guard, everything below (isRunning,
        // this.process, the arch-fallback quick-exit check, _emitStatus)
        // would run against — and corrupt — the new session's state.
        if (generation !== this._launchGeneration) {
          console.log(`[TextractorLauncher] Ignoring 'close' from superseded session #${generation} (current #${this._launchGeneration})`);
          return;
        }
        const runTime = this._launchTime ? Math.round((Date.now() - this._launchTime) / 1000) : 0;
        this.isRunning = false;
        this.process = null;
        // v3.13.29: drain any trailing partial line (and, if the process
        // died before the encoding sniffer ever accumulated
        // ENCODING_SNIFF_MIN_BYTES, decide an encoding from whatever it
        // has rather than losing the line entirely) instead of the old
        // silent `_stdoutBuffer = ''`. Deliberately unconditional, not
        // gated on code===0: dropping the last line of dialogue is worse
        // than a possible extra 'text' emit a moment after the process
        // already exited. Runs before the stats log below so hook/line
        // counts include anything this flush processes. Resets stream
        // state as its last step — see _flushStdout's doc.
        this._flushStdout('close');
        // v3.13.32: _clearTimers() unconditionally here was the actual
        // mechanism of the "x86 relaunch never happens" bug — see
        // _clearSessionTimers()'s doc. During a fallback handover
        // (_relaunchInProgress true), only clear THIS session's own
        // timers and leave _archRelaunchTimer alone.
        if (this._relaunchInProgress) {
          this._clearSessionTimers();
        } else {
          this._clearTimers();
        }

        console.log(`[TextractorLauncher] Process exited: code=${code}, signal=${signal}, ranFor=${runTime}s`);
        console.log(`[TextractorLauncher] Final stats: hooks=${this._hooks.size}, hookLines=${this._hookLinesProcessed}, totalLines=${this._totalLinesProcessed}`);

        if (!this._killedByUser && runTime < 2 && code !== 0) {
          console.warn(`[TextractorLauncher] Process exited quickly with code=${code} — attach likely failed`);

          // v3.13.23: a quick non-zero exit is one of the classic symptoms
          // of an architecture mismatch (see the 'bit'/'architecture'/'x86'
          // stderr check right below) — try the sibling arch once before
          // reporting this as a hard error to the user.
          if (this._attemptArchFallback('quick-exit')) {
            this._emitStatus('exited');
            this.emit('exited', { code, signal });
            return;
          }

          // Build detailed error info
          // v3.13.24: hintKey/hintParams alongside each English hint fallback.
          let hint = '';
          let hintKey = null;
          let hintParams = null;
          const stderrText = this._stderrLines.join('\n').trim();

          // Common error patterns
          if (stderrText.includes('DLL') || stderrText.includes('dll') || stderrText.includes('VCRUNTIME')) {
            hintKey = 'hint_dll_missing_2015_2022';
            hint = 'Missing DLL. Install Visual C++ Redistributable 2015-2022 (x64 for 64-bit Textractor).';
          } else if (stderrText.includes('bit') || stderrText.includes('architecture') || stderrText.includes('x86')) {
            hintKey = 'hint_wrong_architecture';
            hint = 'Wrong architecture. Use 64-bit TextractorCLI for 64-bit games, and 32-bit for 32-bit games.';
          } else if (code === 1 && this._totalLinesProcessed === 0) {
            hintKey = 'hint_cli_failed_to_start';
            hint = 'TextractorCLI failed to start. Verify the file isn\'t corrupted and the DLLs are present.';
          } else if (code === 1 && this._totalLinesProcessed > 0) {
            hintKey = 'hint_attach_failed';
            hintParams = { pid: String(gamePid) };
            hint = 'Attach to PID ' + gamePid + ' failed. Verify the PID is correct and the process is accessible.';
          } else if (code === 5) {
            hintKey = 'hint_access_denied_admin';
            hint = 'Access denied. Try running Tuhua Translator as Administrator.';
          } else {
            const interpreted = interpretExitCode(code);
            if (interpreted.hint) {
              hintKey = interpreted.hintKey;
              hintParams = interpreted.hintParams;
              hint = interpreted.hint;
            } else {
              hintKey = 'hint_verify_pid_manual';
              hint = 'Verify the PID is correct and that TextractorCLI works manually.';
            }
          }

          const error = this._buildError(
            `TextractorCLI exited with code ${code} after ${runTime}s`,
            code,
            { hint, hintKey, hintParams, messageKey: 'err_exited_with_code', messageParams: { code: String(code), runTime: String(runTime) } }
          );
          this.emit('error', error);
        }

        this._emitStatus('exited');
        this.emit('exited', { code, signal });
      });

      // === SPAWN ERROR (v3.8.23: better messages) ===
      this.process.on('error', (err) => {
        // v3.13.32: same superseded-session guard as 'close' above.
        if (generation !== this._launchGeneration) {
          console.log(`[TextractorLauncher] Ignoring 'error' from superseded session #${generation} (current #${this._launchGeneration})`);
          return;
        }
        this.isRunning = false;
        this.process = null;
        // v3.13.29: a spawn error means the process never produced usable
        // stdout — reset rather than flush (nothing meaningful to drain).
        this._resetStreamState();
        // v3.13.32: same _relaunchInProgress-aware choice as 'close' —
        // don't clear _archRelaunchTimer out from under a handover this
        // same event is about to trigger (or that's already in flight from
        // elsewhere) via _attemptArchFallback('spawn-error') below.
        if (this._relaunchInProgress) {
          this._clearSessionTimers();
        } else {
          this._clearTimers();
        }
        console.error(`[TextractorLauncher] Spawn error:`, err.message);

        // v3.13.23: try the sibling architecture once before reporting a
        // hard error — a bad/stale path pointing at an x64 build that no
        // longer exists (or similar) surfaces here as ENOENT.
        if (this._attemptArchFallback('spawn-error')) {
          return;
        }

        let hint = '';
        let hintKey = null;
        if (err.code === 'ENOENT') {
          hintKey = 'hint_file_not_found_path';
          hint = 'File not found. Verify the path to TextractorCLI.exe.';
        } else if (err.code === 'EACCES' || err.code === 'EPERM') {
          hintKey = 'hint_permission_denied_admin';
          hint = 'Permission denied. Run Tuhua Translator as Administrator.';
        } else if (err.code === 'EINVAL') {
          hintKey = 'hint_invalid_path_chars';
          hint = 'Invalid path. Verify the path doesn\'t contain special characters.';
        }

        const error = this._buildError(
          'Could not start TextractorCLI: ' + err.message,
          undefined,
          { hint, hintKey, messageKey: 'err_could_not_start_cli', messageParams: { message: err.message } }
        );
        this.emit('error', error);
        this._emitStatus('error');
      });

      return true;
    } catch (err) {
      const error = this._buildError('Error al lanzar: ' + err.message);
      this.emit('error', error);
      this._emitStatus('error');
      return false;
    }
  }

  /**
   * v3.13.24: Manually insert a hook by code via TextractorCLI's stdin
   * console. v3.13.25 fix: the real command syntax, confirmed by running
   * TextractorCLI.exe directly and typing `hook` with no arguments, is
   * `{'attach'|'detach'|hookcode} -Pprocessid` — the THIRD alternative is
   * the literal hookcode string itself, with NO leading "hook" keyword.
   * The truncated banner previously seen in logs ("Usage: {'attach'|
   * 'detach'|hook") was just "hookcode" cut off mid-word by a small stdout
   * chunk, not a subcommand named "hook" — a wrong reading that made the
   * original version of this method prepend a bogus "hook " prefix,
   * silently no-opping every call (confirmed: zero non-HB0@0 hooks ever
   * appeared in a real session despite this method reporting success).
   *
   * Exists because the generic auto-engine can hook the RIGHT function
   * with the WRONG hook-code type — confirmed with a real case:
   * TextractorCLI's own auto-engine hooked `GetTextExtentPoint32W` with the
   * generic `HB0@0` code and produced garbled text, while the correct code
   * for that exact function is `HQ8@0:gdi32.dll:GetTextExtentPoint32W`.
   * Since Tuhua doesn't do its own hooking (it only launches TextractorCLI
   * and reads whatever it inserts), the only way to apply a hook code
   * found elsewhere (the GUI, a community hook-code list, etc.) is to send
   * it to this same running process — this lets that happen without
   * needing the separate GUI open. Returns { success, error } — doesn't
   * wait for TextractorCLI's response (the resulting hook, if any,
   * surfaces the normal way through _processHookLine/_emitHookDiscovery).
   */
  insertHookCode(hookCode) {
    if (!hookCode || typeof hookCode !== 'string' || !hookCode.trim()) {
      return { success: false, error: 'Empty hook code' };
    }
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed || !this.isRunning) {
      return { success: false, error: 'TextractorCLI is not running' };
    }
    if (!this._gamePid) {
      return { success: false, error: 'No game PID attached' };
    }
    const cleanCode = hookCode.trim();
    // v3.13.35: reject up front, with a message the user (this comes from
    // IPC / the UI's manual hook-insert field, unlike attach/detach which
    // Tuhua composes itself) can actually act on. See STDIN_COMMAND_RE's
    // doc: a space here truncates TextractorCLI's own `%500s` match, which
    // makes the whole parse fail and kills the process outright.
    if (/\s/.test(cleanCode)) {
      return { success: false, error: 'Hook code cannot contain spaces — TextractorCLI would fail to parse it and exit.' };
    }
    const cmd = `${cleanCode} -P${this._gamePid}\n`;
    if (!this._writeStdinCommand(cmd, 'manual hook insert')) {
      return { success: false, error: 'stdin write failed — see log for details' };
    }
    this._hookInsertCount++;
    return { success: true };
  }

  /**
   * v3.13.35: single choke point for every stdin write to TextractorCLI.
   *
   * ROOT CAUSE (confirmed against Textractor's own source,
   * host/CLI/main.cpp, github.com/Artikash/Textractor): TextractorCLI puts
   * its stdin in UTF-16 text mode — `_setmode(_fileno(stdin),
   * _O_U16TEXT)` — and reads commands with `fgetws`, a wide-character line
   * read, then parses with `swscanf(input, L"%500s -P%d", ...)`. Every
   * prior version of this file wrote commands as a plain JS string, which
   * Buffer/stream defaults encode as UTF-8/ASCII (one byte per char).
   * Those bytes never contain the wide newline TextractorCLI's `fgetws` is
   * scanning for (0x000A as a 16-bit code unit) — which is the part that
   * cost several real investigation sessions to pin down: the process
   * didn't error, didn't exit, didn't log anything. `fgetws` just blocked
   * forever waiting for a line ending that, in UTF-16, never arrived. That
   * silence is why TextractorCLI looked "alive but not hooking anything"
   * for the full 60s diagnostic window in every session tried — across
   * both architectures, every install location, and with windowsHide on
   * or off (v3.13.33) — none of those were ever the cause, because none
   * of them touched this.
   *
   * Fix: encode as UTF-16LE. `Buffer.from('...\n', 'utf16le')` ends in the
   * bytes `0A 00` — exactly the wide char 0x000A `fgetws` is waiting for.
   * No \r\n needed; MSVC's text-mode translation isn't what was missing.
   *
   * Every command now shares this one guard, this one encoding, this one
   * format check (STDIN_COMMAND_RE — see its doc for what a bad command
   * costs on the other end), and a hex dump of what actually went out.
   * That last part is the piece that was missing for so long: nothing
   * ever showed what bytes left the process, symmetric to
   * _maybeDumpRawBytes on the read side. Returns true if the write was
   * attempted, false if the process isn't in a writable state or the
   * command was rejected before ever reaching stdin.
   */
  _writeStdinCommand(cmd, label) {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed || !this.isRunning) {
      console.warn(`[TextractorLauncher] Cannot send stdin (${label}) — process not available`);
      return false;
    }
    if (!STDIN_COMMAND_RE.test(cmd)) {
      console.error(`[TextractorLauncher] Refusing to send malformed stdin command (${label}): "${cmd.trim()}" — TextractorCLI's parser (swscanf "%500s -P%d") would fail this and call ExitProcess(0), silently killing the process instead of erroring.`);
      return false;
    }
    const buf = Buffer.from(cmd, 'utf16le');
    console.log(`[TextractorLauncher] Sending stdin (${label}): "${cmd.trim()}"\n` + this._formatHexDump(buf));
    try {
      this.process.stdin.write(buf);
      return true;
    } catch (err) {
      console.error(`[TextractorLauncher] stdin write failed (${label}):`, err.message);
      return false;
    }
  }

  /**
   * v3.13.32: whether the immediate (t=0) attach was actually consumed by
   * TextractorCLI — used to decide whether the 1.5s backup attach below is
   * worth sending at all. The old code sent it unconditionally: TWO
   * injections per launch, and every `attach` makes TextractorCLI inject
   * texthook.dll and SUSPEND the game's threads — the user-visible freeze
   * a real bug report was about. With an arch fallback that doubles to
   * four injections per cycle, and with the loop Fase 2 fixed, it was
   * unbounded. The backup exists for exactly one case — TextractorCLI not
   * having started reading stdin yet by spawn time — and that case is
   * directly observable: a consumed attach makes TextractorCLI emit hook
   * traffic (its Console/Clipboard system hooks register almost instantly
   * on any PROCESSED attach — see the v3.13.30 diagnostic comment).
   * Deliberately NOT keyed on _totalLinesProcessed: the startup usage
   * banner prints regardless of whether stdin was ever read at all, so
   * that would suppress the backup exactly when it's needed.
   */
  _attachWasAcknowledged() {
    return this._hookLinesProcessed > 0 || this._hooks.size > 0;
  }

  /**
   * Send the attach command via stdin.
   */
  _sendStdinAttach(gamePid, label) {
    const cmd = `attach -P${gamePid}\n`;
    if (this._writeStdinCommand(cmd, label)) {
      this._stdinSent = true;
      this._attachSendCount++;
    }
  }

  /**
   * v3.13.24: proactively insert KNOWN_GOOD_HOOK_CODES alongside the normal
   * attach — deliberately NOT reactive (i.e. not "wait for a hook to look
   * garbled, then retry it"). Reactive retry would need to correlate a
   * garbled hook's runtime address back to a WinAPI function name to know
   * which known-good code applies, but TextractorCLI announces
   * "insertando hook: X" for its whole blanket-hook batch upfront, well
   * before any of those hooks actually fire — by the time a hook fires,
   * many announcements have already gone by with no reliable way to tell
   * which one it corresponds to. Firing proactively sidesteps that
   * entirely: if the target game's generic auto-hook for this exact
   * function is also broken, both hooks end up as separate candidates in
   * `_hooks` (different hook codes), and _scoreHook's existing garbage
   * penalty naturally prefers whichever one actually decodes cleanly — no
   * detection or correlation needed. Harmless no-op if the function is
   * never called by this particular game.
   */
  _sendKnownGoodHooks(label) {
    if (KNOWN_GOOD_HOOK_CODES.length === 0) return;
    for (const code of KNOWN_GOOD_HOOK_CODES) {
      const result = this.insertHookCode(code);
      if (!result.success) {
        console.warn(`[TextractorLauncher] Known-good hook (${label}) "${code}" not sent: ${result.error}`);
      }
    }
  }

  /**
   * v3.13.32: timers scoped to ONE spawned process — everything except
   * _archRelaunchTimer, which belongs to the HANDOVER between two
   * processes and must survive the one that's dying. Split out of the old
   * do-everything _clearTimers() because that was the actual mechanism of
   * a real, confirmed bug: _attemptArchFallback() calls kill() (:386-ish)
   * BEFORE arming _archRelaunchTimer, but the dying child's own 'close'
   * handler also calls the timer cleanup — and taskkill on Windows is a
   * separate child process (~50-400ms), so that 'close' routinely arrives
   * AFTER _archRelaunchTimer has already been armed. The old
   * _clearTimers() cleared it right back out, cancelling the x86 relaunch
   * outright and leaving nothing running — with no error, just a UI back
   * on "Launch". See _clearTimers() and kill(options) for how the two
   * callers (a real user-initiated kill vs. the internal pre-relaunch
   * kill) are told apart.
   */
  _clearSessionTimers() {
    if (this._stdinTimer) { clearTimeout(this._stdinTimer); this._stdinTimer = null; }
    if (this._diagnosticTimer) { clearTimeout(this._diagnosticTimer); this._diagnosticTimer = null; }
    if (this._hookDiscoveryTimer) { clearTimeout(this._hookDiscoveryTimer); this._hookDiscoveryTimer = null; }
    if (this._hookDiscoveryPhaseTimer) { clearTimeout(this._hookDiscoveryPhaseTimer); this._hookDiscoveryPhaseTimer = null; }
  }

  /**
   * Clear ALL timers, including the cross-process _archRelaunchTimer.
   * Correct for launch() (a fresh session with no relaunch of its own
   * pending yet) and for a genuine user/caller-initiated kill() — see
   * _clearSessionTimers()'s doc for the one case this is deliberately NOT
   * used from.
   */
  _clearTimers() {
    this._clearSessionTimers();
    if (this._archRelaunchTimer) { clearTimeout(this._archRelaunchTimer); this._archRelaunchTimer = null; }
  }

  /**
   * v3.13.32: `options._forArchRelaunch` is set by exactly one caller —
   * _attemptArchFallback(), right before it kills the current process to
   * respawn the sibling architecture. Every other call site (tray,
   * ipc-handlers' textractor-kill/input-method-switch/shutdown paths,
   * launch()'s own "already running" guard) calls kill() with no
   * arguments and gets the ordinary meaning: the caller wants this STOPPED,
   * full stop — cancel any pending arch relaunch too (_clearTimers(), not
   * _clearSessionTimers()), and don't let a later 'close'/'exited' from
   * this same process get relabeled 'relaunching' by _emitStatus. Also
   * closes a real collateral bug found while designing this: previously,
   * killing TextractorCLI within its first 2s made the `close` handler's
   * `runTime < 2 && code !== 0` branch treat that as an attach failure and
   * fire _attemptArchFallback('quick-exit') — resurrecting, in the OTHER
   * architecture, a process the user had just asked to stop.
   */
  kill(options = {}) {
    const forRelaunch = options._forArchRelaunch === true;
    if (forRelaunch) {
      this._clearSessionTimers();
    } else {
      this._relaunchInProgress = false;
      this._killedByUser = true;
      this._clearTimers();
    }

    if (this.process && this.isRunning) {
      try {
        // v3.13.35: routed through _writeStdinCommand — see its doc.
        // Best-effort either way (the process is about to be killed
        // outright below regardless of whether TextractorCLI ever
        // actually parses this detach).
        this._writeStdinCommand(`detach -P${this._gamePid}\n`, 'detach on kill');
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
      // v3.13.29: reset only, no flush — the user stopped this
      // deliberately, so there's no "the process died mid-line, don't
      // lose it" case to recover here the way there is in the `close`
      // handler.
      this._resetStreamState();
      this._emitStatus('killed');
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
      // v3.13.32: distinguish 1 attach from 2 — the whole point of the
      // conditional backup in _attachWasAcknowledged.
      attachSendCount: this._attachSendCount,
      hookInsertCount: this._hookInsertCount,
      legacyParseCount: this._legacyParseCount,
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
