/**
 * A clipped decal baked to a model ("Bake to model") goes through the
 * model import like any GLB: its per-vertex fade is the engine's own
 * attribute, accepted by the profile.
 */
import { describe, expect, it } from 'vitest';

import { decalClipGlb } from '@thirdlight/project-model/decal-clip-glb';

import { inspectGlb } from './inspect';

describe('a baked clipped decal', () => {
  it('passes the model import with its fade attribute', () => {
    // A clipped mark's arrays (a quad, as the clipper writes one).
    const m = {
      positions: new Float32Array([-0.5, -0.5, 0.001, 0.5, -0.5, 0.001, 0.5, 0.5, 0.001, -0.5, 0.5, 0.001]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
      tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
      fades: new Float32Array([1, 1, 0.5, 0.5]),
      index: new Uint16Array([0, 1, 2, 0, 2, 3]),
    };
    const p = inspectGlb(decalClipGlb(m, { name: 'Mark', materialId: 'mat-mark' }), { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } });
    expect(p.status, JSON.stringify(p.status === 'ok' ? null : (p as { diagnostics?: unknown }).diagnostics)).toBe('ok');
  });
});
