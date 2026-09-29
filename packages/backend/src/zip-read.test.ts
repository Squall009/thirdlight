/**
 * The bounded zip reader of job exports — stored and deflated
 * entries, CRC and size checks, and the archives it refuses.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { zipEntries, zipRead } from './zip-read';

/** A zip of the given files (method 8 when `deflate`), written the way common tools do. */
export function makeZip(files: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = f.deflate === true ? deflateRawSync(f.data) : Buffer.from(f.data);
    const crc = crc32(f.data) >>> 0;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(f.deflate === true ? 8 : 0, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(f.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(f.deflate === true ? 8 : 0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    cens.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

describe('phase 25.22: the job-export zip reader', () => {
  const text = new TextEncoder().encode('hello hello hello hello');
  it('lists entries and reads stored and deflated ones', () => {
    const zip = makeZip([{ name: 'a/manifest.json', data: text }, { name: 'a/b.bin', data: text, deflate: true }]);
    const list = zipEntries(zip);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.map((e) => [e.name, e.method])).toEqual([['a/manifest.json', 0], ['a/b.bin', 8]]);
    for (const e of list.value) {
      const r = zipRead(zip, e, 1024);
      expect(r.ok && new TextDecoder().decode(r.value)).toBe('hello hello hello hello');
    }
  });
  it('refuses what it does not read: not a zip, over the bound, a damaged entry', () => {
    expect(zipEntries(text).ok).toBe(false);
    const zip = makeZip([{ name: 'x', data: text, deflate: true }]);
    const e = (zipEntries(zip) as { ok: true; value: import('./zip-read').ZipEntry[] }).value[0]!;
    expect(zipRead(zip, e, 4)).toMatchObject({ ok: false });
    const bad = zip.slice();
    bad[30 + 1 + 2] = (bad[30 + 1 + 2] ?? 0) ^ 0xff; // a byte of the deflated body
    expect(zipRead(bad, e, 1024).ok).toBe(false);
    expect(zipRead(zip, { ...e, crc: (e.crc + 1) >>> 0 }, 1024)).toMatchObject({ ok: false });
    expect(zipRead(zip, { ...e, method: 12 }, 1024)).toMatchObject({ ok: false });
  });
});
