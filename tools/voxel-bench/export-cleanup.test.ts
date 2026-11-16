import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MadeExport } from './export-cleanup';

const scratch: string[] = [];
function root(): string {
  const base = process.env['TMPDIR'] ?? join(process.cwd(), '.cache');
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, 'export-cleanup-'));
  scratch.push(d);
  return join(d, 'exports');
}
function folder(r: string, name: string): string {
  mkdirSync(join(r, name, 'assets'), { recursive: true });
  writeFileSync(join(r, name, 'manifest.json'), '{}');
  return join(r, name);
}
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the export a bench run made', () => {
  it('removes the folder the call made and nothing else', () => {
    const r = root();
    const older = folder(r, 'voxel-slice@r40');
    const made = new MadeExport(r);
    const out = folder(r, 'voxel-slice@r41');
    expect(made.claim('voxel-slice@r41')).toBe(out);
    expect(made.remove()).toBe(out);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(older)).toBe(true);
    expect(made.remove()).toBeNull();
  });

  it('never removes a folder that was there before the call, outside the exports folder, or the folder itself', () => {
    const r = root();
    const there = folder(r, 'voxel-slice@r41');
    const made = new MadeExport(r);
    made.claim('voxel-slice@r41');
    expect(made.path).toBeNull();
    made.claim('../elsewhere');
    made.claim('.');
    made.claim('a/b');
    expect(made.path).toBeNull();
    expect(made.remove()).toBeNull();
    expect(existsSync(there)).toBe(true);
  });

  it('after a failed call takes the one half-written folder of the project, and none when it is not alone', () => {
    const r = root();
    folder(r, 'other@r1');
    const made = new MadeExport(r);
    const half = folder(r, 'voxel-slice@r42');
    expect(made.claimNew('voxel-slice@')).toBe(half);
    expect(made.remove()).toBe(half);
    const two = new MadeExport(r);
    folder(r, 'voxel-slice@r43');
    folder(r, 'voxel-slice@r44');
    expect(two.claimNew('voxel-slice@')).toBeNull();
    expect(existsSync(join(r, 'other@r1'))).toBe(true);
  });
});
