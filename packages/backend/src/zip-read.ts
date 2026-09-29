/**
 * Phase 25.22: a small bounded zip reader for job exports (the central
 * directory, stored and deflated entries, CRC-32 checked). No zip64, no
 * encryption, no multi-disk archives: those are refused, not guessed at.
 * Entries are read only when asked for, each within a byte bound.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** The entry's name (forward slashes as stored). */
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  readonly localOffset: number;
}

export type ZipResult<T> = { ok: true; value: T } | { ok: false; message: string };

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
export const ZIP_MAX_ENTRIES = 4096;

/** The entries of a zip archive (its central directory). */
export function zipEntries(bytes: Uint8Array): ZipResult<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 22 - 65_535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, message: 'not a zip archive (no end of central directory)' };
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) return { ok: false, message: 'multi-disk zip archives are not read' };
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) return { ok: false, message: 'zip64 archives are not read' };
  if (count > ZIP_MAX_ENTRIES) return { ok: false, message: `the zip has more than ${ZIP_MAX_ENTRIES} entries` };
  if (cdOffset + cdSize > eocd) return { ok: false, message: 'the zip central directory is out of bounds' };
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || view.getUint32(p, true) !== CEN_SIG) return { ok: false, message: 'the zip central directory is damaged' };
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > eocd) return { ok: false, message: 'the zip central directory is damaged' };
    const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if ((flags & 0x1) !== 0) return { ok: false, message: `"${name.slice(0, 64)}" is encrypted` };
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) return { ok: false, message: 'zip64 archives are not read' };
    out.push({ name, method, compressedSize, size, crc, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, value: out };
}

/** One entry's bytes (at most `maxBytes`), inflated and CRC-checked. */
export function zipRead(bytes: Uint8Array, e: ZipEntry, maxBytes: number): ZipResult<Uint8Array> {
  if (e.size > maxBytes) return { ok: false, message: `"${e.name.slice(0, 64)}" is ${e.size} bytes (at most ${maxBytes})` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = e.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOC_SIG) return { ok: false, message: `"${e.name.slice(0, 64)}" has no local header` };
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + e.compressedSize;
  if (end > bytes.length) return { ok: false, message: `"${e.name.slice(0, 64)}" is out of bounds` };
  const raw = bytes.subarray(start, end);
  let data: Uint8Array;
  if (e.method === 0) data = raw;
  else if (e.method === 8) {
    try {
      data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }));
    } catch {
      return { ok: false, message: `"${e.name.slice(0, 64)}" could not be inflated` };
    }
  } else return { ok: false, message: `"${e.name.slice(0, 64)}" uses compression method ${e.method} (stored and deflate are read)` };
  if (data.length !== e.size) return { ok: false, message: `"${e.name.slice(0, 64)}" has the wrong size` };
  if ((crc32(data) >>> 0) !== e.crc) return { ok: false, message: `"${e.name.slice(0, 64)}" fails its CRC check` };
  return { ok: true, value: data };
}
