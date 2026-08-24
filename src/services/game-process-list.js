/**
 * v3.13.8x (settings UX audit, Fase 4): pure parsing for the
 * `list-game-processes` IPC handler (ipc-handlers.js) — split out so the
 * one genuinely test-worthy piece (turning PowerShell's ConvertTo-Json
 * output into a stable array shape) doesn't need Electron, Windows, or a
 * real child process to verify. Icon resolution (app.getFileIcon) stays in
 * the handler itself; that part can only be exercised on real Windows.
 */

// v3.13.88: itch.io's own desktop client is Electron-based and keeps a real
// window open while browsing the library, so it passes list-game-processes'
// only filter (MainWindowTitle non-empty + Path present) exactly like the
// VN it's about to launch — a user who leaves the itch client open (the
// common case; most VN installs go through it) can end up linking a
// profile straight to itch.exe instead of the actual game. Confirmed real
// (2026-08-24, Lyca): a profile's `game.exePath` resolved to
// `...\itch\app-26.18.0\itch.exe`, which then fed a wrong PID into
// Textractor's auto-connect AND kept re-triggering a "profile already
// linked" suggestion on every later scan, for ANY game, as long as the
// itch client happened to be running in the background.
//
// Matched by install-path shape, not bare exeName alone, so a
// coincidentally-named `itch.exe` living somewhere else is never silently
// dropped from the picker.
const ITCH_LAUNCHER_RE = /\\itch\\app-[^\\]+\\itch\.exe$/i;

/**
 * @param {string} exePath
 * @returns {boolean}
 */
function isKnownLauncherProcess(exePath) {
  return typeof exePath === 'string' && ITCH_LAUNCHER_RE.test(exePath);
}

/**
 * `ConvertTo-Json` returns a single JSON OBJECT (not a one-element array)
 * when exactly one process matches the filter — a well-documented
 * PowerShell quirk, not a bug in the command. Every caller of this
 * function must go through here rather than `JSON.parse` directly, or a
 * desktop with exactly one open game window silently produces `.length`
 * on an object instead of an array.
 *
 * Malformed/empty input never throws — a picker that shows "no processes
 * found" is a correct, calm degradation; a picker that throws is a blank
 * dropdown with a console error the user can't act on.
 *
 * @param {string} raw - stdout from the `list-game-processes` PowerShell command
 * @returns {Array<{pid:number, name:string, windowTitle:string, exePath:string}>}
 */
function parseProcessListJson(raw) {
  if (!raw || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && typeof row === 'object' && Number.isInteger(row.Id) && typeof row.Path === 'string' && row.Path)
    .filter((row) => !isKnownLauncherProcess(row.Path))
    .map((row) => ({
      pid: row.Id,
      name: typeof row.ProcessName === 'string' ? row.ProcessName : '',
      windowTitle: typeof row.MainWindowTitle === 'string' ? row.MainWindowTitle : '',
      exePath: row.Path
    }));
}

module.exports = { parseProcessListJson, isKnownLauncherProcess };
