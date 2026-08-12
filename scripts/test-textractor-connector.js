/**
 * TextractorConnector (TCP) bench — real net.createServer() on 127.0.0.1,
 * ephemeral port, no Electron, no privileges. This is the ONLY way to write
 * a real regression test for the v3.13.39 fix: the bug was that a fresh
 * net.Socket() reports readyState === 'open' on Node 18/20, so a pre-check
 * in connect() matched on every new socket and returned WITHOUT ever
 * calling client.connect() — no SYN was ever sent, for anyone, ever. That
 * can only be caught by actually listening for a real connection.
 *
 *   node scripts/test-textractor-connector.js
 *   node scripts/test-textractor-connector.js --quiet
 */
const net = require('net');
const path = require('path');
const TextractorConnector = require(path.join('..', 'src', 'services', 'textractor.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

function parseArgs(argv) {
  const args = { quiet: false };
  for (const a of argv) if (a === '--quiet') args.quiet = true;
  return args;
}

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    const connections = [];
    server.on('connection', (sock) => connections.push(sock));
    server.listen(0, '127.0.0.1', () => resolve({ server, connections, port: server.address().port }));
  });
}

function closeServer(server, connections = []) {
  // net.Server#close()'s callback only fires once every existing
  // connection has ended too — destroy any server-side sockets the test
  // tracked (including ones a test intentionally left "half-closed" via a
  // synthetic client-side event) so this never hangs the bench.
  for (const sock of connections) { try { sock.destroy(); } catch (e) { /* already gone */ } }
  return new Promise((resolve) => server.close(resolve));
}

function waitFor(fn, timeoutMs = 2000, stepMs = 5) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

async function testConnectsToARealListener() {
  const { server, connections, port } = await listen();
  const conn = new TextractorConnector(port);
  const statuses = [];
  conn.on('status', (s) => statuses.push(s));

  conn.connect();
  let ok = true;
  let err = null;
  try {
    await waitFor(() => connections.length > 0 && statuses.includes('connected'));
  } catch (e) {
    ok = false;
    err = e.message;
  }

  const pass = ok && connections.length > 0 && statuses.includes('connected') && conn.isConnected === true;
  conn.disconnect();
  await closeServer(server, connections);
  return { id: 'connects-to-a-real-listener', pass, serverGotConnection: connections.length > 0, statuses, isConnected: conn.isConnected, err };
}

async function testReconfigureConnects() {
  const { server, connections, port } = await listen();
  const conn = new TextractorConnector(1); // deliberately wrong port first
  const statuses = [];
  conn.on('status', (s) => statuses.push(s));

  conn.reconfigure(port);
  let ok = true;
  try {
    await waitFor(() => connections.length > 0 && statuses.includes('connected'));
  } catch (e) {
    ok = false;
  }

  // No 'reconnecting' should appear before the first 'connected' — this is
  // the real path index.js:329 uses (Textractor-mode startup).
  const connectedIdx = statuses.indexOf('connected');
  const reconnectingBeforeConnect = statuses.slice(0, connectedIdx === -1 ? statuses.length : connectedIdx).includes('reconnecting');

  const pass = ok && connections.length > 0 && !reconnectingBeforeConnect;
  conn.disconnect();
  await closeServer(server, connections);
  return { id: 'reconfigure-connects', pass, statuses, reconnectingBeforeConnect };
}

async function testStaleSocketCloseIgnored() {
  const { server, connections, port } = await listen();
  const conn = new TextractorConnector(port);
  conn.connect();
  await waitFor(() => connections.length > 0 && conn.isConnected === true);

  const oldSocket = conn.client;
  const attemptsBefore = conn.reconnectAttempts;

  // Simulate the exact race: a new socket is created (generation bumps),
  // and only THEN does the old socket's close handler fire.
  conn._createSocket();
  const statuses = [];
  conn.on('status', (s) => statuses.push(s));
  oldSocket.emit('close', false);

  const pass = conn.isConnecting === false || true; // isConnecting is unaffected either way; the real assertion is below
  const noReconnectTriggered = !statuses.includes('reconnecting') && conn.reconnectAttempts === attemptsBefore;

  conn.disconnect();
  await closeServer(server, connections);
  return { id: 'stale-socket-close-ignored', pass: noReconnectTriggered, statuses, attemptsBefore, attemptsAfter: conn.reconnectAttempts };
}

async function testNoEisconnOnReconnectRace() {
  const { server, connections, port } = await listen();
  const conn = new TextractorConnector(port);
  conn.baseReconnectDelay = 0;
  const errors = [];
  const statuses = [];
  conn.on('error', (e) => errors.push(e));
  conn.on('status', (s) => statuses.push(s));

  // Rapid reconfigure — the exact shape of a real Textractor-mode startup
  // (disconnect old + create new + connect, all synchronous).
  conn.reconfigure(port);
  await waitFor(() => statuses.includes('connected'));

  const badErrors = errors.filter((e) => e.code === 'EALREADY' || e.code === 'EISCONN');
  const connectedCount = statuses.filter((s) => s === 'connected').length;

  const pass = badErrors.length === 0 && connectedCount === 1;
  conn.disconnect();
  await closeServer(server, connections);
  return { id: 'no-eisconn-on-reconnect-race', pass, badErrors: badErrors.map((e) => e.code), connectedCount, statuses };
}

async function testReconnectsAfterServerDeath() {
  const { server, connections, port } = await listen();
  const conn = new TextractorConnector(port);
  conn.baseReconnectDelay = 10;
  const statuses = [];
  conn.on('status', (s) => statuses.push(s));

  conn.connect();
  await waitFor(() => statuses.includes('connected'));
  statuses.length = 0;

  await closeServer(server, connections);
  await waitFor(() => statuses.includes('disconnected'));
  await waitFor(() => statuses.includes('reconnecting'), 2000);

  const pass = statuses.includes('disconnected') && statuses.includes('reconnecting') && conn.reconnectAttempts >= 1;
  conn.disconnect();
  return { id: 'reconnects-after-server-death', pass, statuses, reconnectAttempts: conn.reconnectAttempts };
}

async function testStopsAfterMaxAttempts() {
  // No listener at all — every attempt gets ECONNREFUSED.
  const conn = new TextractorConnector(1); // port 1 is refused instantly on most systems without a listener; use a closed local port instead
  // Bind and immediately close a server to get a guaranteed-refused port.
  const { server, port } = await listen();
  await closeServer(server);
  conn.port = port;
  conn.maxReconnectAttempts = 3;
  conn.baseReconnectDelay = 5;
  const statuses = [];
  conn.on('status', (s) => statuses.push(s));
  conn.on('error', () => {}); // ECONNREFUSED surfaces as 'error' too; swallow for this test

  conn.connect();

  await waitFor(() => conn.reconnectTimer === null && statuses.filter((s) => s === 'reconnecting').length >= 3, 3000).catch(() => {});
  // Allow one more tick for the terminal disconnect to land.
  await new Promise((r) => setTimeout(r, 50));

  const reconnectingCount = statuses.filter((s) => s === 'reconnecting').length;
  const pass = reconnectingCount === 3 && conn.reconnectTimer === null;
  conn.disconnect();
  return { id: 'stops-after-max-attempts', pass, reconnectingCount, statuses, timerNulled: conn.reconnectTimer === null };
}

async function testDisconnectClearsIsConnecting() {
  const conn = new TextractorConnector(1);
  conn.isConnecting = true;
  conn.disconnect();
  return { id: 'disconnect-clears-isConnecting', pass: conn.isConnecting === false, isConnecting: conn.isConnecting };
}

function testStripHookPrefix() {
  const conn = new TextractorConnector(1);
  const results = [];
  const cases = [
    { input: '[0x1A2B:3:GameName] Hello world', expected: 'Hello world' },
    { input: 'No prefix here', expected: null },
    { input: '[0x1234:0:Foo]  leading space', expected: 'leading space' },
    { input: '[0x1234:0:Foo] ---', expected: null }, // separator-only noise, filtered
    { input: '[0x1234:0:Foo] 12AB', expected: null } // pure hex/numeric, filtered
  ];
  for (const c of cases) {
    const out = conn._stripHookPrefix(c.input);
    results.push({ id: `strip-hook-prefix-${JSON.stringify(c.input).slice(0, 20)}`, pass: out === c.expected, out, expected: c.expected });
  }
  conn.disconnect();
  return results;
}

function testProcessDataDedup() {
  const conn = new TextractorConnector(1);
  const texts = [];
  conn.on('text', (t) => texts.push(t));

  const encode = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
  conn._processData(encode('[0x1:0:g] hello'));
  conn._processData(encode('[0x1:0:g] hello')); // exact repeat, must dedup
  conn._processData(encode('[0x1:0:g] world'));

  conn.disconnect();
  return { id: 'process-data-dedups-exact-repeat', pass: texts.length === 2 && texts[0] === 'hello' && texts[1] === 'world', texts };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const all = [];

  all.push(await testConnectsToARealListener());
  all.push(await testReconfigureConnects());
  all.push(await testStaleSocketCloseIgnored());
  all.push(await testNoEisconnOnReconnectRace());
  all.push(await testReconnectsAfterServerDeath());
  all.push(await testStopsAfterMaxAttempts());
  all.push(await testDisconnectClearsIsConnecting());
  all.push(...testStripHookPrefix());
  all.push(testProcessDataDedup());

  console.log(`${C.bold}TextractorConnector (TCP) bench${C.reset} — ${all.length} case(s)\n`);
  let passed = 0;
  for (const r of all) {
    const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`${mark}  ${r.id}`);
    if (r.pass) passed++;
    if (!args.quiet && !r.pass) {
      console.log(`      ${C.dim}${JSON.stringify(r, null, 2).split('\n').join('\n      ')}${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Overall${C.reset}  ${passed === all.length ? C.green : C.red}${passed}/${all.length}${C.reset}`);
  process.exit(passed === all.length ? 0 : 1);
}

run();
