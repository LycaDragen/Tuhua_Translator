/**
 * deriveBadgeStatus bench — pure decision table, no Electron, no DOM.
 * See src/services/badge-state.js for the full rationale.
 *
 *   node scripts/test-badge-state.js
 *   node scripts/test-badge-state.js --quiet
 */
const path = require('path');
const { deriveBadgeStatus } = require(path.join('..', 'src', 'services', 'badge-state.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

const BASE = {
  currentInputMethod: 'textractor',
  translationActive: true,
  xuatServerRunning: false,
  cliRunning: false,
  cliEverExtracted: false,
  tcpStatus: ''
};

const state = (overrides) => ({ ...BASE, ...overrides });

const CASES = [
  // ─── THE reported bug, and its fix ───────────────────────────────────────
  { id: 'the-reported-bug-cli-extracting-beats-stale-tcp-status',
    input: state({ cliRunning: true, cliEverExtracted: true, tcpStatus: 'reconnecting' }),
    expected: 'connected',
    note: 'session17.log exactly: CLI extracting real text while the TCP socket (which the user never uses) sits on a stale reconnecting status. The badge must be green, not red.' },

  // ─── Textractor mode ──────────────────────────────────────────────────────
  { id: 'textractor-cli-running-not-yet-extracted', input: state({ cliRunning: true }), expected: 'searching' },
  { id: 'textractor-cli-not-running-tcp-connected-manual-mode', input: state({ tcpStatus: 'connected' }), expected: 'connected' },
  { id: 'textractor-cli-not-running-tcp-reconnecting', input: state({ tcpStatus: 'reconnecting' }), expected: 'reconnecting' },
  { id: 'textractor-nothing-running', input: state(), expected: 'disconnected' },
  { id: 'textractor-cli-extracted-wins-over-tcp-connected', input: state({ cliRunning: true, cliEverExtracted: true, tcpStatus: 'connected' }), expected: 'connected' },
  { id: 'textractor-cli-not-running-but-still-marked-extracted-falls-back-to-tcp',
    input: state({ cliRunning: false, cliEverExtracted: true, tcpStatus: 'disconnected' }),
    expected: 'disconnected',
    note: 'cliRunning is the gate — a stale cliEverExtracted from a dead process must not paint green on its own (killTextractorCli/exited/error all clear it, but this is the safety net if they didn\'t).' },
  { id: 'textractor-error-tcp-does-not-override-extracting-cli',
    input: state({ cliRunning: true, cliEverExtracted: true, tcpStatus: 'error' }),
    expected: 'connected',
    note: 'the ~15-attempt TCP failure cycle a Manual-Mode-less user gets post v3.13.39 fix must never turn a working stdout session red.' },

  // ─── The regression the TCP fix makes reachable, and its guard ──────────
  { id: 'ocr-mode-tcp-connected-does-not-leak-through',
    input: state({ currentInputMethod: 'ocr', tcpStatus: 'connected' }),
    expected: 'ocr',
    note: 'before the badge derivation, a background TextractorCLI TCP connect (Start Server extension running) could paint green "Connected" over an OCR session that has nothing to do with it.' },
  { id: 'ocr-mode-ignores-cli-state-too', input: state({ currentInputMethod: 'ocr', cliRunning: true, cliEverExtracted: true }), expected: 'ocr' },

  // ─── Clipboard mode ───────────────────────────────────────────────────────
  { id: 'clipboard-active', input: state({ currentInputMethod: 'clipboard', translationActive: true }), expected: 'watching' },
  { id: 'clipboard-paused', input: state({ currentInputMethod: 'clipboard', translationActive: false }), expected: 'disconnected' },
  { id: 'clipboard-ignores-tcp-and-cli',
    input: state({ currentInputMethod: 'clipboard', translationActive: true, tcpStatus: 'connected', cliRunning: true, cliEverExtracted: true }),
    expected: 'watching' },

  // ─── XUAT mode ────────────────────────────────────────────────────────────
  { id: 'xuat-server-running', input: state({ currentInputMethod: 'xuat', xuatServerRunning: true }), expected: 'xuat' },
  { id: 'xuat-server-stopped', input: state({ currentInputMethod: 'xuat', xuatServerRunning: false }), expected: 'disconnected' },
  { id: 'xuat-ignores-tcp-connected', input: state({ currentInputMethod: 'xuat', xuatServerRunning: true, tcpStatus: 'connected' }), expected: 'xuat' },

  // ─── Order independence (required for the dom-ready replay) ─────────────
  { id: 'order-independence-tcp-then-cli-same-result-as-cli-then-tcp',
    input: state({ cliRunning: true, cliEverExtracted: true, tcpStatus: 'connected' }),
    expected: deriveBadgeStatus(state({ tcpStatus: 'connected', cliRunning: true, cliEverExtracted: true })),
    note: 'the function is pure — key insertion order into the state object cannot matter. Asserted against itself as a sanity check that no hidden ordering crept in.' }
];

function run() {
  const args = parseArgs(process.argv.slice(2));
  const results = CASES.map((c) => {
    const actual = deriveBadgeStatus(c.input);
    return { id: c.id, pass: actual === c.expected, actual, expected: c.expected, input: c.input, note: c.note };
  });

  console.log(`${C.bold}deriveBadgeStatus bench${C.reset} — ${results.length} case(s)\n`);
  let passed = 0;
  for (const r of results) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === results.length ? C.green : C.red}${passed}/${results.length}${C.reset}`);
  process.exit(passed === results.length ? 0 : 1);
}

run();
