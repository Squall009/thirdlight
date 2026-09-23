/**
 * The widened glTF extension profile against real files
 * (fixtures/import-ext: Blender 5.2.2 exports + gltf-transform variants).
 * Read through the Vite raw import like the M2 fixtures (this package has no
 * I/O); every file's bytes are checked against its recorded SHA-256 first.
 */
import { describe, expect, it } from 'vitest';

import { inspectGlb, type ImportJobPort } from './index';
import { sha256Hex } from './sha256';
import { base64ToBytes } from './test-fixtures';

const RAW = import.meta.glob('../../../fixtures/import-ext/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const read = (name: string): string => {
  const v = RAW[`../../../fixtures/import-ext/${name}`];
  if (typeof v !== 'string') throw new Error(`missing fixtures/import-ext/${name}`);
  return v;
};
const files = JSON.parse(read('bytes.base64.json')) as Record<string, string>;
const expected = JSON.parse(read('expected.json')) as {
  files: Record<string, { sha256: string; byteLength: number; status: 'ok' | 'rejected'; extensions?: string[]; codes?: string[] }>;
};

const job: ImportJobPort = {
  now: () => 0,
  isCancelled: () => false,
  proposalId: () => 'p-00000000000000000000000000000002',
  stageId: () => 'stage-import-ext',
  expiresAt: () => '2026-09-23T00:00:00Z',
};
const inspect = (bytes: Uint8Array) => inspectGlb(bytes, { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, job });

describe('import-ext fixtures through the real inspector', () => {
  for (const [name, want] of Object.entries(expected.files)) {
    it(`${name}: ${want.status}${want.codes ? ` (${want.codes.join(', ')})` : ''}`, () => {
      const bytes = base64ToBytes(files[name] ?? '');
      expect(bytes.length).toBe(want.byteLength);
      expect(sha256Hex(bytes)).toBe(want.sha256);
      const p = inspect(bytes);
      expect(p.status, JSON.stringify(p.diagnostics)).toBe(want.status);
      if (want.status === 'ok') {
        expect(p.importRecipe.extensions).toEqual(want.extensions);
        expect(p.metrics?.vertices).toBeGreaterThan(0);
      } else {
        expect([...new Set(p.diagnostics.map((d) => d.code))]).toEqual(want.codes);
      }
    });
  }

  it('reads animation times out of meshopt-compressed data (a 2 s clip) and counts Draco geometry by its accessors', () => {
    const m = inspect(base64ToBytes(files['meshopt-cube.glb'] ?? ''));
    expect(m.status).toBe('ok');
    expect(m.metrics?.animations).toBe(1);
    expect(m.metrics?.clipDurationMs).toBe(2000);
    expect(m.metrics?.vertices).toBe(24);
    const d = inspect(base64ToBytes(files['draco-cube.glb'] ?? ''));
    expect(d.metrics?.vertices).toBe(24);
    expect(d.metrics?.triangles).toBe(12);
  });

  it('reads KTX2 header dimensions into the decoded-image budget', () => {
    const k = inspect(base64ToBytes(files['ktx2-cube.glb'] ?? ''));
    expect(k.metrics?.decodedImageBytes).toBe(64 * 64 * 4);
  });

  it('reads WebP dimensions into the decoded-image budget (64x64 RGBA)', () => {
    const p = inspect(base64ToBytes(files['webp-cube.glb'] ?? ''));
    expect(p.status).toBe('ok');
    expect(p.metrics?.decodedImageBytes).toBe(64 * 64 * 4);
    expect(p.metrics?.images).toBe(1);
  });
});
