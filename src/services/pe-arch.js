/**
 * v3.13.8x: pure PE (Portable Executable) architecture detection, split out
 * of TextractorLauncher#validatePath — see that method for the original
 * inline version, which only ever read this to build a cosmetic
 * "(32-bit)"/"(64-bit)" suffix. Promoted to its own module because the
 * pre-flight arch-swap feature needs the SAME check run against an
 * arbitrary GAME .exe, not just the TextractorCLI.exe the user configured.
 *
 * That distinction is why this can't just reuse validatePath's inline
 * version as-is: TextractorCLI.exe is small (~1MB) so reading it whole with
 * readFileSync was tolerable there. A game's .exe can be hundreds of MB —
 * readFileSync-ing the whole thing on every launch would be a real memory
 * regression, not a theoretical one. The PE machine-type field lives in the
 * first few hundred bytes regardless of file size, so this reads a small
 * fixed window instead.
 */

const fs = require('fs');

// PE header layout this cares about:
//   offset 0x00: 'MZ' (DOS header magic)
//   offset 0x3C: 4-byte LE offset to the PE header
//   PE header + 4: 2-byte LE machine type
// 0x14C = IMAGE_FILE_MACHINE_I386 (32-bit), 0x8664 = IMAGE_FILE_MACHINE_AMD64 (64-bit).
// Read window sized to comfortably cover a PE offset anywhere in the first
// few hundred bytes (real-world DOS stubs are ~64-256 bytes) plus the 6
// bytes of machine-type field itself, with generous headroom.
const READ_WINDOW_BYTES = 1024;

/**
 * Parse a PE machine type out of a buffer containing the START of an exe
 * file (does not need to be the whole file — see READ_WINDOW_BYTES).
 *
 * @param {Buffer} buffer
 * @returns {'x86'|'x64'|null} null on anything that isn't a recognized,
 *   well-formed 32/64-bit PE header (not a PE at all, truncated, corrupt,
 *   or a machine type other than i386/AMD64 — e.g. ARM64, which this
 *   deliberately doesn't claim to identify since neither TextractorCLI
 *   build could match it anyway).
 */
function readPeMachine(buffer) {
  if (!buffer || buffer.length < 0x40) return null;
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null; // 'MZ'
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 6 > buffer.length) return null;
  const machine = buffer.readUInt16LE(peOffset + 4);
  if (machine === 0x14c) return 'x86';
  if (machine === 0x8664) return 'x64';
  return null;
}

/**
 * Detect the architecture of an .exe on disk without reading it whole.
 * Fail-silent by design (returns null, never throws) — every caller of
 * this treats "unknown" as "don't swap anything", the same benign
 * degradation TextractorLauncher already uses elsewhere for anything PE-
 * or filesystem-related (see validatePath's own try/catch around this
 * exact logic).
 *
 * @param {string} exePath
 * @param {typeof fs} [fsImpl] - injectable for tests; defaults to real fs
 * @returns {'x86'|'x64'|null}
 */
function detectExeArch(exePath, fsImpl = fs) {
  if (!exePath || typeof exePath !== 'string') return null;
  let fd;
  try {
    fd = fsImpl.openSync(exePath, 'r');
    const buffer = Buffer.alloc(READ_WINDOW_BYTES);
    const bytesRead = fsImpl.readSync(fd, buffer, 0, READ_WINDOW_BYTES, 0);
    return readPeMachine(buffer.subarray(0, bytesRead));
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (e) { /* already closed / never opened */ }
    }
  }
}

module.exports = { readPeMachine, detectExeArch, READ_WINDOW_BYTES };
