/**
 * Occluder stand-ins read from GLB bytes: `<piece>_OCC` nodes are grouped
 * with their piece, left out of its render geometry (bounds, colliders made
 * from geometry, vertex paint), checked against the piece's LOD0 bounds
 * (inside: used; a vertex outside: ignored and reported), and the import
 * setting says what of a model counts.
 */
import { glbBytes } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { modelColliderShape, modelPieceName, modelRenderPrimitives, readModelGeometry } from './model-collision';
import { modelOccluderChecks, modelOccluderProblem, modelOccluderReport, modelOccluderUse, OCCLUDER_COVERAGE_TEXELS, OCCLUDER_INSIDE_TOLERANCE_M, occluderCoverageBreaks, occluderPointsOutside, validateModelOccluderField } from './model-occluders';
import { paintableMeshes } from './vertex-paint';

/** A GLB from a JSON document and one binary buffer. */
function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  return glbBytes(JSON.stringify({ asset: { version: '2.0' }, ...json, buffers: [{ byteLength: bin.length }] }), bin);
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
      { piece: 'hedge', node: 'hedge_OCC', vertices: 8, outside: 0, uncovered: 0, nearer: 0, noBounds: false },
      // 0.4 + 0.8 = 1.2 m: the top four corners stand 0.2 m above the wall.
      { piece: 'wall', node: 'wall_OCC', vertices: 8, outside: 4, uncovered: 0, nearer: 0, noBounds: false },
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

  it('rejects a stand-in over an opening or in front of the surfaces, seen along the axes; passes one inside', () => {
    // An arch 3 m wide and 3 m high, 0.4 m deep: two 0.5 m legs and a 1 m lintel (a 2 × 2 m opening under it).
    const arch = [...cuboid([0, 0, -0.2], [0.5, 3, 0.2]), ...cuboid([2.5, 0, -0.2], [3, 3, 0.2]), ...cuboid([0.5, 2, -0.2], [2.5, 3, 0.2])];
    const box = { min: [0, 0, -0.2], max: [3, 3, 0.2] } as const;
    // A slab over the whole arch has its every vertex inside the bounds, but covers the opening.
    const slab = cuboid([0.05, 0.05, -0.1], [2.95, 2.95, 0.1]);
    expect(occluderPointsOutside(slab, box)).toBe(0);
    expect(occluderCoverageBreaks(arch, slab, box).uncovered).toBeGreaterThan(0);
    // One slab inside each leg and one inside the lintel: they pass.
    const inside = [...cuboid([0.1, 0.1, -0.1], [0.4, 2.9, 0.1]), ...cuboid([2.6, 0.1, -0.1], [2.9, 2.9, 0.1]), ...cuboid([0.6, 2.1, -0.1], [2.4, 2.9, 0.1])];
    expect(occluderCoverageBreaks(arch, inside, box)).toEqual({ uncovered: 0, nearer: 0 });
    // The same slab as the leg it stands in (faces on the leg's own faces: the exporter's rounding passes).
    expect(occluderCoverageBreaks(arch, cuboid([0, 0, -0.2], [0.5, 3, 0.2]), box)).toEqual({ uncovered: 0, nearer: 0 });
    // An L-shaped piece and a box over its notch.
    const ell = [...cuboid([0, 0, 0], [2, 1, 1]), ...cuboid([0, 1, 0], [1, 2, 1])];
    const ellBox = { min: [0, 0, 0], max: [2, 2, 1] } as const;
    expect(occluderCoverageBreaks(ell, cuboid([0.05, 0.05, 0.05], [1.95, 1.95, 0.95]), ellBox).uncovered).toBeGreaterThan(0);
    // A wall with a sloped top (a gable): a box up to the bounds' top stands in front of the slope, seen from above.
    const gable = [...cuboid([0, 0, 0], [4, 2, 0.3]), ...prism([0, 2, 0], [4, 2, 0], [2, 3, 0], 0.3)];
    const gableBox = { min: [0, 0, 0], max: [4, 3, 0.3] } as const;
    const tall = cuboid([0.2, 0.1, 0.05], [3.8, 2.9, 0.25]);
    expect(occluderPointsOutside(tall, gableBox)).toBe(0);
    const broken = occluderCoverageBreaks(gable, tall, gableBox);
    expect(broken.uncovered + broken.nearer).toBeGreaterThan(0);
    expect(occluderCoverageBreaks(gable, cuboid([0.2, 0.1, 0.05], [3.8, 1.9, 0.25]), gableBox)).toEqual({ uncovered: 0, nearer: 0 });
    // A hedge of leaf cards: a shell of quads (their cut-outs are a texture's, not geometry) holds a box inside it.
    const hedgeBox = { min: [0, 0, 0], max: [2, 2, 2] } as const;
    expect(occluderCoverageBreaks(cuboid([0, 0, 0], [2, 2, 2]), cuboid([0.2, 0.2, 0.2], [1.8, 1.8, 1.8]), hedgeBox)).toEqual({ uncovered: 0, nearer: 0 });
    // A plant of two crossed cards is no hedge: from above its geometry is a cross, and a box inside covers the gaps.
    const cross = [...quad([0, 0, 1], [2, 0, 1], [2, 2, 1], [0, 2, 1]), ...quad([1, 0, 0], [1, 0, 2], [1, 2, 2], [1, 2, 0])];
    expect(occluderCoverageBreaks(cross, cuboid([0.5, 0.1, 0.5], [1.5, 1.9, 1.5]), hedgeBox).uncovered).toBeGreaterThan(0);
    expect(OCCLUDER_COVERAGE_TEXELS).toBeGreaterThan(8);
  });

  it('reports a stand-in over an opening with its reason', () => {
    expect(modelOccluderProblem({ piece: 'arch', node: 'arch_OCC', vertices: 8, outside: 0, uncovered: 12, nearer: 0, noBounds: false })).toContain('arch_OCC: it covers an opening of "arch"');
    expect(modelOccluderProblem({ piece: '', node: 'x_OCC', vertices: 8, outside: 0, uncovered: 0, nearer: 3, noBounds: false })).toContain('stands out in front of the LOD0 surfaces of the model');
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

/** A box's twelve triangles (nine floats each) from its min to its max corner. */
function cuboid(lo: readonly number[], hi: readonly number[]): number[] {
  const c = (i: number): number[] => [i & 1 ? hi[0]! : lo[0]!, i & 2 ? hi[1]! : lo[1]!, i & 4 ? hi[2]! : lo[2]!];
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return faces.flatMap(([a, b, d, e]) => [...c(a!), ...c(b!), ...c(d!), ...c(a!), ...c(d!), ...c(e!)]);
}

/** A quad's two triangles. */
function quad(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

/** A triangle (a, b, c) pushed `depth` along +z: its two caps and three sides. */
function prism(a: number[], b: number[], c: number[], depth: number): number[] {
  const z = (p: number[]): number[] => [p[0]!, p[1]!, p[2]! + depth];
  return [...a, ...b, ...c, ...z(a), ...z(c), ...z(b), ...quad(a, b, z(b), z(a)), ...quad(b, c, z(c), z(b)), ...quad(c, a, z(a), z(c))];
}
