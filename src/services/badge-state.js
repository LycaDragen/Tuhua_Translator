/**
 * v3.13.39: pure decision table for the navbar connection badge
 * (#connection-badge). Extracted out of renderer.js specifically so it can
 * be required from a plain-Node bench (renderer.js lives in <script> scope
 * and can't be required) — same dual-load shape i18n.js already uses.
 *
 * Root bug this exists to fix: the badge used to be PAINTED by whatever
 * event arrived last (updateConnectionStatus(status) called directly from
 * each IPC handler), and its only event source was the TCP "Start Server"
 * socket. TextractorCLI's stdout path — the PRIMARY way text reaches
 * Tuhua — had a completely separate indicator (#cli-status-text, hidden by
 * default in the settings panel), so a session that translated perfectly
 * over stdout still showed red "Disconnected" in the navbar for its whole
 * duration (session17.log). Making the badge a pure function of state
 * (rather than a sequence of paints) is what lets it be order-independent
 * — required for the dom-ready replay in window-manager.js, and for
 * changeLanguage() to just recompute it instead of tracking what was last
 * painted.
 */

/**
 * @param {object} state
 * @param {string} state.currentInputMethod - 'textractor' | 'clipboard' | 'ocr' | 'xuat'
 * @param {boolean} state.translationActive
 * @param {boolean} state.xuatServerRunning
 * @param {boolean} state.cliRunning - TextractorCLI child process is alive
 * @param {boolean} state.cliEverExtracted - the CURRENT CLI process has
 *   delivered at least one real, deduped line of game text
 * @param {string} state.tcpStatus - last status from the TCP connector
 *   ('connected' | 'reconnecting' | 'disconnected' | 'timeout' | 'error' | '')
 * @returns {'connected'|'searching'|'reconnecting'|'watching'|'ocr'|'xuat'|'disconnected'}
 */
function deriveBadgeStatus(state) {
  const {
    currentInputMethod,
    translationActive,
    xuatServerRunning,
    cliRunning,
    cliEverExtracted,
    tcpStatus
  } = state;

  if (currentInputMethod === 'clipboard') {
    return translationActive ? 'watching' : 'disconnected';
  }
  if (currentInputMethod === 'ocr') {
    return 'ocr';
  }
  if (currentInputMethod === 'xuat') {
    return xuatServerRunning ? 'xuat' : 'disconnected';
  }

  // Textractor mode: CLI stdout is primary and ALWAYS wins over TCP. Once
  // the v3.13.39 TCP fix makes the socket actually connect, a user with no
  // "Start Server" extension gets a real disconnected/reconnecting/error
  // cycle at every backoff step (measured: ~15 attempts over ~5 minutes) —
  // that churn must never be able to paint a working stdout session red.
  if (cliRunning && cliEverExtracted) return 'connected';
  if (tcpStatus === 'connected') return 'connected'; // Manual Mode
  // CLI launched, no real game text yet — the up-to-60s hook search.
  // Distinct from 'reconnecting' on purpose: nothing is retrying here,
  // Textractor is looking. #cli-search-status carries the numeric countdown.
  if (cliRunning) return 'searching';
  if (tcpStatus === 'reconnecting') return 'reconnecting';
  return 'disconnected';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { deriveBadgeStatus };
}
