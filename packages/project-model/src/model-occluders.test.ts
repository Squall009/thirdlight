/**
 * Occluder stand-ins read from GLB bytes: `<piece>_OCC` nodes are grouped
 * with their piece, left out of its render geometry (bounds, colliders made
 * from geometry, vertex paint), checked against the piece's LOD0 bounds
 * (inside: used; a vertex outside: ignored and reported), and the import
 * setting says what of a model counts.
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { modelColliderShape, modelPieceName, modelRenderPrimitives, readModelGeometry } from './model-collision';
import { modelOccluderChecks, modelOccluderProblem, modelOccluderReport, modelOccluderUse, OCCLUDER_INSIDE_TOLERANCE_M, occluderPointsOutside, validateModelOccluderField } from './model-occluders';
import { paintableMeshes } from './vertex-paint';

/** A GLB from a JSON document and one binary buffer. */
function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  let j = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...json, buffers: [{ byteLength: bin.length }] }));
  if (j.length % 4 !== 0) {
    const p = new Uint8Array(j.length + (4 - (j.length % 4))).fill(0x20);
    p.set(j);
    j = p;
  }
  const out = new Uint8Array(20 + j.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

/**
 * Two pieces of one 1 m cube mesh (x, z ±0.5, y 0..1): `hedge` with an `_OCC`
 * half its size inside, `wall` with an `_OCC` moved 0.4 m up (its top 0.2 m
 * above the wall: four vertices outside).
 */
function file(): Uint8Array {
  const corners: number[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) corners.push(x, y, z);
  const pos = new Float32Array(corners);
  const idx = new Uint16Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  return glb({
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3] }],
    nodes: [
      { name: 'hedge_LOD0', mesh: 0, translation: [3, 0, 0] },
      { name: 'hedge_OCC', mesh: 0, translation: [3, 0.25, 0], scale: [0.5, 0.5, 0.5] },
      { name: 'wall', mesh: 0 },
      { name: 'wall_OCC', mesh: 0, translation: [0, 0.4, 0], scale: [0.9, 0.8, 0.9] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
  }, bin);
}

describe('occluder stand-ins in a model file', () => {
  it('groups _OCC nodes with their piece and leaves them out of its render geometry', () => {
    expect(modelPieceName('hedge_OCC')).toBe('hedge');
    expect(modelPieceName('_OCC')).toBe('_OCC');
    const read = readModelGeometry(file());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const occ = read.geometry.primitives.filter((p) => p.occluder);
    expect(occ.map((p) => [p.piece, p.occluderNode])).toEqual([['hedge', 'hedge_OCC'], ['wall', 'wall_OCC']]);
    expect(modelRenderPrimitives(read.geometry, 'hedge').map((p) => p.node)).toEqual(['hedge_LOD0']);
    // A box made from the geometry (no _COL) is the drawn cube's, not grown by the stand-in.
    const box = modelColliderShape(read.geometry, 'wall', 'box');
    expect(box.ok && box.shape).toEqual({ type: 'box', hx: 0.5, hy: 0.5, hz: 0.5, center: [0, 0.5, 0] });
    // Vertex paint never covers a stand-in.
    expect(paintableMeshes(read.geometry, () => 'x').map((m) => m.mesh.split('#')[0])).toEqual(['hedge_LOD0', 'wall']);
  });

  it('uses a stand-in inside its piece\'s LOD0 bounds and ignores one with a vertex outside', () => {
    const read = readModelGeometry(file());
    if (!read.ok) throw new Error(read.message);
    const checks = modelOccluderChecks(read.geometry);
    expect(checks).toEqual([
      { piece: 'hedge', node: 'hedge_OCC', vertices: 8, outside: 0, noBounds: false },
      // 0.4 + 0.8 = 1.2 m: the top four corners stand 0.2 m above the wall.
      { piece: 'wall', node: 'wall_OCC', vertices: 8, outside: 4, noBounds: false },
    ]);
    expect(modelOccluderProblem(checks[0]!)).toBeNull();
    expect(modelOccluderProblem(checks[1]!)).toContain('wall_OCC: 4 of 8 vertices outside the LOD0 bounds of "wall"');
    // The same rows straight from the bytes; a file without an _OCC node is not decoded at all.
    expect(modelOccluderReport(file())).toEqual(checks);
    expect(modelOccluderReport(new Uint8Array([1, 2, 3]))).toEqual(expect.any(String));
  });

  it('allows an exporter\'s rounding at the bounds and nothing more', () => {
    const box = { min: [0, 0, 0], max: [1, 1, 1] } as const;
    const t = OCCLUDER_INSIDE_TOLERANCE_M;
    expect(occluderPointsOutside([0, 0, 0, 1, 1, 1, 1 + t * 0.5, 0.5, -t * 0.5], box)).toBe(0);
    expect(occluderPointsOutside([1 + t * 2, 0.5, 0.5, 0.5, Number.NaN, 0.5], box)).toBe(2);
  });

  it('says what of a model counts as an occluder by its import setting', () => {
    expect(modelOccluderUse('auto', true)).toEqual({ standins: true, surfaces: false });
    expect(modelOccluderUse('auto', false)).toEqual({ standins: false, surfaces: true });
    expect(modelOccluderUse('occ', false)).toEqual({ standins: true, surfaces: false });
    expect(modelOccluderUse('none', true)).toEqual({ standins: false, surfaces: false });
    const errors: ModelErrorV2[] = [];
    validateModelOccluderField({ occluder: 'occ' }, '/assets/0', errors, true);
    validateModelOccluderField({ occluder: 'none' }, '/assets/0', errors, true);
    expect(errors).toEqual([]);
    validateModelOccluderField({ occluder: 'auto' }, '/assets/0', errors, true);
    expect(errors).toEqual([]);
    // Only a model has the setting, and only these three.
    validateModelOccluderField({ occluder: 'always' }, '/assets/0', errors, true);
    validateModelOccluderField({ occluder: 'occ' }, '/assets/1', errors, false);
    expect(errors.map((e) => e.path)).toEqual(['/assets/0/occluder', '/assets/1/occluder']);
  });
});
