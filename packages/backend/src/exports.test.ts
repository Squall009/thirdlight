import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, listExports, zipDirectory } from './exports';

describe('exports: listing + stored zip', () => {
  it('zips a tree with correct headers and CRCs; lists a project\'s export dirs', () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-exports-'));
    try {
      const dir = join(root, 'game-0001@r3');
      mkdirSync(join(dir, 'js'), { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      writeFileSync(join(dir, 'js', 'main.js'), 'console.log(1)');
      mkdirSync(join(root, 'other@r1'));
      mkdirSync(join(root, 'game-0001@r1'));
      expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
      const zip = zipDirectory(dir);
      const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
      expect(v.getUint32(0, true)).toBe(0x04034b50);
      // Walk the local headers.
      const names: string[] = [];
      let i = 0;
      while (v.getUint32(i, true) === 0x04034b50) {
        const size = v.getUint32(i + 18, true);
        const n = v.getUint16(i + 26, true);
        names.push(new TextDecoder().decode(zip.subarray(i + 30, i + 30 + n)));
        i += 30 + n + size;
      }
      expect(names).toEqual(['index.html', 'js/main.js']);
      expect(v.getUint32(i, true)).toBe(0x02014b50); // central directory follows
      expect(v.getUint32(zip.length - 22, true)).toBe(0x06054b50); // end record
      const list = listExports(root, 'game-0001');
      expect(list.map((e) => [e.dir, e.revision, e.files])).toEqual(expect.arrayContaining([['game-0001@r3', 3, 2], ['game-0001@r1', 1, 0]]));
      expect(list).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
