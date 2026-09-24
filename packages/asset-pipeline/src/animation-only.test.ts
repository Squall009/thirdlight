/**
 * Phase 14.6: an animation-only GLB (bones and clips, no mesh) is accepted
 * as a model asset — its clips play on another model's rig. A file with
 * neither meshes nor animations is still refused, and so is a mesh without
 * geometry.
 */
import { describe, expect, it } from 'vitest';

import { inspectGlb, type ImportProposal } from './index';
import { buildGlb, float32 } from './test-glb';

function inspect(json: Record<string, unknown>, bin: Uint8Array): ImportProposal {
  return inspectGlb(buildGlb(json, bin), { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } });
}

/** Two bones and one 1 s rotation clip on the second. */
function clipsOnly(withAnimation = true): { json: Record<string, unknown>; bin: Uint8Array } {
  const times = float32([0, 1]);
  const rotations = float32([0, 0, 0, 1, 0, 0, 0.5, 0.8660254]);
  const bin = new Uint8Array(times.length + rotations.length);
  bin.set(times, 0);
  bin.set(rotations, times.length);
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'root', children: [1] }, { name: 'upper', translation: [0, 1, 0] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: times.length },
      { buffer: 0, byteOffset: times.length, byteLength: rotations.length },
    ],
    buffers: [{ byteLength: bin.length }],
    ...(withAnimation ? { animations: [{ name: 'wave', samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }] }] } : {}),
  };
  return { json, bin };
}

describe('animation-only GLBs', () => {
  it('accepts clips without a mesh (no meshes key, or an empty list)', () => {
    const a = clipsOnly();
    const p = inspect(a.json, a.bin);
    expect(p.status, JSON.stringify(p.diagnostics)).toBe('ok');
    expect(p.metrics?.meshes).toBe(0);
    expect(p.metrics?.animations).toBe(1);
    const b = clipsOnly();
    expect(inspect({ ...b.json, meshes: [] }, b.bin).status).toBe('ok');
  });

  it('still refuses a file with neither meshes nor animations', () => {
    const c = clipsOnly(false);
    const p = inspect(c.json, c.bin);
    expect(p.status).toBe('rejected');
    expect(p.diagnostics.map((d) => d.code)).toContain('asset_mesh_invalid');
  });
});
