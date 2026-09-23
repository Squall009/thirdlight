/**
 * Export listing + download for the editor: the export directories the
 * admin export route wrote for a project, and one of them as a stored
 * (uncompressed) zip so the browser can save the standalone game. Plain
 * Node, no zip library: local headers + central directory + CRC-32.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXPORT_DIR_RE = /^[a-z0-9][a-z0-9_-]{0,63}@r\d+$/;

export interface ExportEntry {
  dir: string;
  revision: number;
  mtimeMs: number;
  files: number;
}

/** The export directories of one project (newest first). */
export function listExports(exportRoot: string, projectId: string): ExportEntry[] {
  let names: string[];
  try {
    names = readdirSync(exportRoot);
  } catch {
    return [];
  }
  const out: ExportEntry[] = [];
  for (const name of names) {
    if (!EXPORT_DIR_RE.test(name) || !name.startsWith(`${projectId}@r`)) continue;
    const dir = join(exportRoot, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      out.push({ dir: name, revision: Number(name.slice(name.lastIndexOf('@r') + 2)), mtimeMs: st.mtimeMs, files: walk(dir).length });
    } catch {
      // vanished or unreadable: skip
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Is `name` a well-formed export directory name of this project? */
export function isExportDirOf(projectId: string, name: string): boolean {
  return EXPORT_DIR_RE.test(name) && name.startsWith(`${projectId}@r`);
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const r = rel === '' ? name : `${rel}/${name}`;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored zip of every file under `dir` (paths relative to it, forward slashes). */
export function zipDirectory(dir: string): Uint8Array {
  const files = walk(dir);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  // A fixed DOS time (zip has no timezone); the export's identity is its buildId, not mtimes.
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01
  for (const rel of files) {
    const data = readFileSync(join(dir, rel));
    const name = enc.encode(rel);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  const total = offset + cdSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
