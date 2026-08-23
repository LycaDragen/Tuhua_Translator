/**
 * v3.13.8x (settings UX audit, Fase 4): pure parsing for the
 * `list-game-processes` IPC handler (ipc-handlers.js) — split out so the
 * one genuinely test-worthy piece (turning PowerShell's ConvertTo-Json
 * output into a stable array shape) doesn't need Electron, Windows, or a
 * real child process to verify. Icon resolution (app.getFileIcon) stays in
 * the handler itself; that part can only be exercised on real Windows.
 */

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
    .map((row) => ({
      pid: row.Id,
      name: typeof row.ProcessName === 'string' ? row.ProcessName : '',
      windowTitle: typeof row.MainWindowTitle === 'string' ? row.MainWindowTitle : '',
      exePath: row.Path
    }));
}

module.exports = { parseProcessListJson };
