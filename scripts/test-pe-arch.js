/**
 * pe-arch.js bench — pure PE machine-type detection (readPeMachine +
 * detectExeArch), split out of TextractorLauncher#validatePath for the
 * arch-mismatch pre-flight feature. See src/services/pe-arch.js's own doc
 * for why this reads a small window instead of the whole file.
 *
 *   node scripts/test-pe-arch.js
 *   node scripts/test-pe-arch.js --quiet
 */
const path = require('path');
const { readPeMachine, detectExeArch } = require(path.join('..', 'src', 'services', 'pe-arch.js'));

const { makeEagerCheckRegistry } = require('./lib/bench.js');
const { check, report } = makeEagerCheckRegistry();

// ─── Synthetic PE buffer builder ────────────────────────────────────────
// A real PE has a much longer DOS stub, but readPeMachine only ever looks
// at bytes 0-1 ('MZ'), 0x3C (PE offset), and peOffset+4 (machine type) — so
// a minimal buffer with just those fields populated exercises the same
// code path as a real .exe.
function buildPeBuffer({ magic = 'MZ', peOffset = 0x80, machine = null, totalLen = 0x200 } = {}) {
  const buf = Buffer.alloc(totalLen);
  if (magic) buf.write(magic, 0, 'ascii');
  buf.writeUInt32LE(peOffset, 0x3c);
  if (peOffset + 4 <= totalLen - 4 && machine !== null) {
    // 'PE\0\0' signature, then the machine field right after.
    buf.write('PE', peOffset, 'ascii');
    buf.writeUInt16LE(machine, peOffset + 4);
  }
  return buf;
}

const MACHINE_I386 = 0x14c;
const MACHINE_AMD64 = 0x8664;
const MACHINE_ARM64 = 0xaa64;

check('i386-machine-type-reads-as-x86', () => {
  const buf = buildPeBuffer({ peOffset: 0x80, machine: MACHINE_I386 });
  const r = readPeMachine(buf);
  return { pass: r === 'x86', actual: r };
});

check('amd64-machine-type-reads-as-x64', () => {
  const buf = buildPeBuffer({ peOffset: 0x80, machine: MACHINE_AMD64 });
  const r = readPeMachine(buf);
  return { pass: r === 'x64', actual: r };
});

check('arm64-machine-type-is-unrecognized-not-misclassified', () => {
  // Deliberately not claimed as x86 or x64 — neither TextractorCLI build
  // could match it anyway, and silently mapping it to either would be
  // worse than admitting "unknown".
  const buf = buildPeBuffer({ peOffset: 0x80, machine: MACHINE_ARM64 });
  const r = readPeMachine(buf);
  return { pass: r === null, actual: r };
});

check('missing-mz-magic-is-not-a-pe-at-all', () => {
  const buf = buildPeBuffer({ magic: 'XX', peOffset: 0x80, machine: MACHINE_AMD64 });
  const r = readPeMachine(buf);
  return { pass: r === null, actual: r };
});

check('pe-offset-pointing-past-buffer-end-is-handled-without-throwing', () => {
  const buf = Buffer.alloc(0x50);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x1000, 0x3c); // way past the 0x50-byte buffer
  const r = readPeMachine(buf);
  return { pass: r === null, actual: r };
}, 'A truncated read window (e.g. a file shorter than READ_WINDOW_BYTES) must degrade to null, never throw.');

check('buffer-shorter-than-dos-header-is-handled-without-throwing', () => {
  const r = readPeMachine(Buffer.alloc(4));
  return { pass: r === null, actual: r };
});

check('null-or-undefined-buffer-is-handled-without-throwing', () => {
  const a = readPeMachine(null);
  const b = readPeMachine(undefined);
  return { pass: a === null && b === null, actual: [a, b] };
});

check('garbage-bytes-are-not-misread-as-a-pe', () => {
  const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37) % 256));
  const r = readPeMachine(buf);
  return { pass: r === null, actual: r };
});

check('pe-offset-zero-is-a-valid-degenerate-case', () => {
  // Pathological but shouldn't crash: PE header claimed to start at byte 0,
  // right on top of the MZ magic.
  const buf = Buffer.alloc(0x200);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0, 0x3c);
  buf.writeUInt16LE(MACHINE_AMD64, 4);
  const r = readPeMachine(buf);
  return { pass: r === 'x64', actual: r };
});

// ─── detectExeArch: fs-level behavior via an injected fake fs ──────────
function makeFakeFs(files) {
  return {
    openSync(p, flags) {
      if (!(p in files)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return p; // use the path itself as the "fd"
    },
    readSync(fd, buffer, offset, length, position) {
      const data = files[fd];
      if (data === 'THROW_ON_READ') throw new Error('simulated read failure');
      const n = Math.min(length, data.length - position);
      data.copy(buffer, offset, position, position + Math.max(0, n));
      return Math.max(0, n);
    },
    closeSync(fd) { /* no-op */ }
  };
}

check('detectExeArch-reads-a-real-x64-exe-through-injected-fs', () => {
  const buf = buildPeBuffer({ peOffset: 0x80, machine: MACHINE_AMD64 });
  const fake = makeFakeFs({ '/fake/game64.exe': buf });
  const r = detectExeArch('/fake/game64.exe', fake);
  return { pass: r === 'x64', actual: r };
});

check('detectExeArch-reads-a-real-x86-exe-through-injected-fs', () => {
  const buf = buildPeBuffer({ peOffset: 0x80, machine: MACHINE_I386 });
  const fake = makeFakeFs({ '/fake/game32.exe': buf });
  const r = detectExeArch('/fake/game32.exe', fake);
  return { pass: r === 'x86', actual: r };
});

check('detectExeArch-missing-file-degrades-to-null-not-a-throw', () => {
  const fake = makeFakeFs({});
  const r = detectExeArch('/fake/does-not-exist.exe', fake);
  return { pass: r === null, actual: r };
}, 'Elevated-process / permission-denied / already-deleted cases must all silently degrade — see the module doc on why this can never throw into launch().');

check('detectExeArch-read-failure-degrades-to-null-not-a-throw', () => {
  const fake = makeFakeFs({ '/fake/locked.exe': 'THROW_ON_READ' });
  const r = detectExeArch('/fake/locked.exe', fake);
  return { pass: r === null, actual: r };
});

check('detectExeArch-empty-or-non-string-path-degrades-to-null', () => {
  const fake = makeFakeFs({});
  const a = detectExeArch('', fake);
  const b = detectExeArch(null, fake);
  const c = detectExeArch(undefined, fake);
  return { pass: a === null && b === null && c === null, actual: [a, b, c] };
});

check('detectExeArch-never-reads-more-than-the-declared-window', () => {
  // A file far larger than READ_WINDOW_BYTES must still only cost a
  // bounded read — this is the whole point of the module (avoid
  // readFileSync-ing a hundreds-of-MB game exe).
  const { READ_WINDOW_BYTES } = require(path.join('..', 'src', 'services', 'pe-arch.js'));
  let requestedLength = null;
  const buf = buildPeBuffer({ peOffset: 0x80, machine: MACHINE_AMD64, totalLen: 50 * 1024 * 1024 });
  const fake = {
    openSync: () => 'fd',
    readSync(fd, buffer, offset, length, position) {
      requestedLength = length;
      const n = Math.min(length, buf.length - position);
      buf.copy(buffer, offset, position, position + n);
      return n;
    },
    closeSync: () => {}
  };
  const r = detectExeArch('/fake/huge-game.exe', fake);
  return { pass: r === 'x64' && requestedLength === READ_WINDOW_BYTES, actual: { r, requestedLength } };
});

report();
