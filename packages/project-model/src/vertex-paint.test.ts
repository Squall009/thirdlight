/**
 * Vertex paint data: the `vertexPaint` component and an instance set's
 * `paint` validated and kept in canonical form (absent: the old bytes); a
 * model's meshes named by node path with a position hash that tells a
 * changed mesh from the one painted; dabs turned into bytes by the shared
 * brush; the copy table following copies taken out; and paint in path
 * space surviving a regeneration of generated architecture and a spline.
 */
import { describe, expect, it } from 'vitest';

import { generateArchitecture } from './arch-generate';
import type { ArchitectureComponent } from './architecture';
import type { ModelErrorV2 } from './errors';
import { readModelGeometry } from './model-collision';
import { validateSceneV4 } from './scene-v3';
import { sweepSplineMesh } from './spline-mesh';
import type { SplineComponent } from './spline';
import { defaultTrimSheet } from './trim-sheet';
import {
  PATH_PAINT_CELL,
  VERTEX_PAINT_BYTES,
  canonicalVertexPaint,
  copyIndexMap,
  copySlot,
  decodeCopyTable,
  encodeCopyTable,
  paintableMeshes,
  remapCopyTable,
  validateInstancePaint,
  validateVertexPaintComponent,
  vertexPaintMismatches,
  type VertexPaintComponent,
} from './vertex-paint';
import { paintIsEmpty, paintVertexDabs, vertexPaintStrokeError, type VertexPaintBrush } from './vertex-paint-stroke';
import { paintPathDabs, pathPaintFrame, samplePathPaint, type PathGrid } from './vertex-paint-paths';

const D = (c: string): string => c.repeat(64);
const H = (c: string): string => c.repeat(16);

/** A GLB of named nodes, each a mesh of one triangle-list primitive over `positions` (node translation optional). */
function paintGlb(nodes: { name: string; positions: number[]; translation?: number[]; children?: number[] }[], roots: number[] = nodes.map((_, i) => i)): Uint8Array {
  const floats: number[] = [];
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const meshes: unknown[] = [];
  for (const n of nodes) {
    bufferViews.push({ buffer: 0, byteOffset: floats.length * 4, byteLength: n.positions.length * 4 });
    floats.push(...n.positions);
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: n.positions.length / 3, type: 'VEC3' });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 1 } }] });
  }
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: roots }], nodes: nodes.map((n, i) => ({ name: n.name, mesh: i, ...(n.translation !== undefined ? { translation: n.translation } : {}), ...(n.children !== undefined ? { children: n.children } : {}) })), meshes, accessors, bufferViews, buffers: [{ byteLength: floats.length * 4 }] };
  const bin = new Uint8Array(new Float32Array(floats).buffer);
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  json = new Uint8Array([...json, ...new Array((4 - (json.length % 4)) % 4).fill(0x20)]);
  const out = new Uint8Array(28 + json.length + bin.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  v.setUint32(20 + json.length, bin.length, true);
  v.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}

const errorsOf = (f: (v: unknown, p: string, e: ModelErrorV2[]) => void, v: unknown): string[] => {
  const e: ModelErrorV2[] = [];
  f(v, '', e);
  return e.map((x) => `${x.code} ${x.path}`);
};

const MESH = { mesh: 'Hull#0', vertices: 3, positions: H('a'), paint: D('b') };
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CAMERA = { id: 'cam-main', components: { transform: { ...T, position: [0, 2, 10] }, virtualCamera: { rig: 'fixed' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, ...entities] });

describe('the vertexPaint component and instance paint', () => {
  it('validates meshes and paths; unknown fields, bad keys, sizes and digests are refused', () => {
    const v = validateVertexPaintComponent;
    expect(errorsOf(v, { meshes: [MESH] })).toEqual([]);
    expect(errorsOf(v, { paths: [{ path: 'outline:room-1', side: 'right', origin: [-2, 0], size: [10, 12], paint: D('c') }] })).toEqual([]);
    expect(errorsOf(v, {})).toEqual(['field_missing ']);
    expect(errorsOf(v, { meshes: [] })).toEqual(['field_value /meshes']);
    expect(errorsOf(v, { meshes: [{ ...MESH, mesh: 'Hull' }, { ...MESH, vertices: 0, positions: 'x', paint: 'y', colour: 1 }], tint: 1 })).toEqual([
      'field_unexpected /tint',
      'field_value /meshes/0/mesh',
      'field_unexpected /meshes/1/colour',
      'field_value /meshes/1/vertices',
      'field_value /meshes/1/positions',
      'field_value /meshes/1/paint',
    ]);
    expect(errorsOf(v, { meshes: [MESH, MESH] })).toEqual(['field_value /meshes/1/mesh']);
    expect(errorsOf(v, { paths: [{ path: 'wall', side: 'front', origin: [0.5, 0], size: [0, 1], paint: D('c') }] })).toEqual(['field_value /paths/0/path', 'field_value /paths/0/side', 'field_value /paths/0/origin', 'field_value /paths/0/size']);
    expect(errorsOf(validateInstancePaint, { copies: D('d'), painted: 2, slots: 3, meshes: [MESH] })).toEqual([]);
    expect(errorsOf(validateInstancePaint, { copies: D('d'), painted: 4, slots: 3, meshes: [MESH] })).toEqual(['field_value /slots']);
  });

  it('sits on a model (meshes) or generated architecture/spline (paths); canonical form; absent keeps the old bytes', () => {
    const model = (vp?: unknown) => ({ id: 'rock-000001', components: { transform: T, model: { asset: { assetId: 'rock' } }, ...(vp !== undefined ? { vertexPaint: vp } : {}) } });
    const lone = validateSceneV4(scene([{ id: 'e-000001', components: { transform: T, vertexPaint: { meshes: [MESH] } } }, { id: 'e-000002', components: { transform: T, model: { asset: { assetId: 'rock' } }, vertexPaint: { paths: [{ path: 'spline', side: 'top', origin: [0, 0], size: [1, 1], paint: D('c') }] } } }]));
    expect(lone.ok === false && lone.errors.map((e) => `${e.code} ${e.path}`)).toEqual(['component_missing /entities/1/components/vertexPaint/meshes', 'component_missing /entities/2/components/vertexPaint/paths']);
    // Canonical: meshes by name, fields in order.
    const c = canonicalVertexPaint({ meshes: [{ paint: D('b'), positions: H('a'), vertices: 3, mesh: 'Z#0' }, MESH] } as VertexPaintComponent);
    expect(JSON.stringify(c)).toBe(`{"meshes":[{"mesh":"Hull#0","vertices":3,"positions":"${H('a')}","paint":"${D('b')}"},{"mesh":"Z#0","vertices":3,"positions":"${H('a')}","paint":"${D('b')}"}]}`);
    // A scene without paint reads back as it was written; one with paint keeps it.
    for (const s of [scene([model()]), scene([model({ meshes: [MESH] }), { id: 'set-000001', components: { transform: T, instances: { asset: { assetId: 'rock' }, buffer: D('e'), count: 4, paint: { copies: D('d'), painted: 1, slots: 1, meshes: [MESH] } } } }])]) {
      const r = validateSceneV4(s);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(JSON.parse(JSON.stringify(r.normalized))).toEqual(s);
    }
  });
});

describe('model meshes', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  it('are named by node path and primitive (siblings of one name numbered); the hash follows the positions, not the node\'s place', () => {
    const g = readModelGeometry(paintGlb([{ name: 'Body', positions: tri, children: [1, 2] }, { name: 'Lid', positions: tri }, { name: 'Lid', positions: tri }, { name: 'Body_COL', positions: tri }], [0, 3]));
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const m = paintableMeshes(g.geometry);
    expect(m.map((x) => x.mesh)).toEqual(['Body#0', 'Body/Lid#0', 'Body/Lid~1#0']);
    expect(m[0]!.positions).toMatch(/^[0-9a-f]{16}$/);
    expect(m[1]!.positions).toBe(m[2]!.positions);
    const moved = readModelGeometry(paintGlb([{ name: 'Body', positions: tri, translation: [5, 0, 0] }]));
    const changed = readModelGeometry(paintGlb([{ name: 'Body', positions: [0, 0, 0, 2, 0, 0, 0, 1, 0] }]));
    if (!moved.ok || !changed.ok) throw new Error('unreadable');
    const [a] = paintableMeshes(moved.geometry);
    const [b] = paintableMeshes(changed.geometry);
    expect(a!.positions).toBe(m[0]!.positions);
    expect(a!.points[0]).toBe(5);
    expect(b!.positions).not.toBe(m[0]!.positions);
    // A reimport: same vertex count, moved vertices; a vertex fewer; a mesh gone.
    const rec = { mesh: 'Body#0', vertices: 3, positions: m[0]!.positions, paint: D('f') };
    expect(vertexPaintMismatches([rec], [a!])).toEqual([]);
    expect(vertexPaintMismatches([rec], [b!]).map((x) => x.reason)).toEqual(['positions']);
    expect(vertexPaintMismatches([rec], [{ mesh: 'Body#0', vertices: 2, positions: b!.positions }]).map((x) => x.reason)).toEqual(['vertices']);
    expect(vertexPaintMismatches([rec], []).map((x) => x.reason)).toEqual(['missing']);
  });
});

describe('dabs to bytes', () => {
  const line = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]);
  const brush: VertexPaintBrush = { radius: 2, strength: 1, channel: 1 };
  it('raise a channel by strength × falloff, leave the others; erase lowers it; the result is the same bytes every time', () => {
    const v = new Uint8Array(5 * VERTEX_PAINT_BYTES);
    expect(paintVertexDabs(line, v, [[0, 0, 0]], brush)).toBe(2);
    // smooth: (1 - d²/r²)²: 1, 0.5625, 0 → 255, 143, 0.
    expect([...v]).toEqual([0, 255, 0, 0, 0, 143, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const lin = new Uint8Array(5 * VERTEX_PAINT_BYTES);
    paintVertexDabs(line, lin, [[4, 0, 0]], { radius: 2, strength: 0.5, channel: 3, falloff: 'linear' });
    expect([...lin.subarray(12)]).toEqual([0, 0, 0, 64, 0, 0, 0, 128]);
    paintVertexDabs(line, v, [[0, 0, 0]], { ...brush, erase: true, strength: 0.5 });
    expect([v[1], v[5]]).toEqual([128, 103]);
    paintVertexDabs(line, v, [[0, 0, 0]], { ...brush, erase: true, falloff: 'constant' });
    expect(paintIsEmpty(v)).toBe(true);
  });
  it('checks a stroke\'s shape', () => {
    expect(vertexPaintStrokeError({ dabs: [[0, 0, 0]], brush })).toBeNull();
    expect(vertexPaintStrokeError({ dabs: [], brush })?.path).toBe('/dabs');
    expect(vertexPaintStrokeError({ dabs: [[0, 0, 0]], brush: { ...brush, channel: 4 } })?.path).toBe('/brush/channel');
    expect(vertexPaintStrokeError({ dabs: [[0, 0, 0]], brush: { ...brush, radius: 0 } })?.path).toBe('/brush/radius');
    expect(vertexPaintStrokeError({ dabs: [[0, 0, 0]], brush, path: 'spline' })?.path).toBe('/side');
    expect(vertexPaintStrokeError({ dabs: [[0, 0, 0]], brush, copy: 1, path: 'spline', side: 'top' })?.path).toBe('/path');
    expect(vertexPaintStrokeError({ dabs: [[0, 0, 0]], brush, copy: 1, mesh: 'A#0' })).toBeNull();
  });
});

describe('the copy table', () => {
  const copies = (...xs: number[]): Float32Array => Float32Array.from(xs.flatMap((x) => [x, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
  it('reads back; a copy finds its slot', () => {
    const t = { copies: Uint32Array.from([2, 7, 9]), slots: Uint32Array.from([1, 0, 2]) };
    const back = decodeCopyTable(encodeCopyTable(t))!;
    expect([...back.copies, ...back.slots]).toEqual([2, 7, 9, 1, 0, 2]);
    expect([copySlot(back, 7), copySlot(back, 3)]).toEqual([0, -1]);
    expect(decodeCopyTable(encodeCopyTable({ copies: Uint32Array.from([3, 2]), slots: Uint32Array.from([0, 1]) }))).toBeNull();
  });
  it('follows copies taken out, keeps them through moves and additions, drops paint on an unrelated buffer', () => {
    const before = copies(0, 1, 2, 3, 4);
    const t = { copies: Uint32Array.from([1, 3, 4]), slots: Uint32Array.from([0, 1, 2]) };
    const out = copyIndexMap(before, copies(0, 2, 4), 10)!;
    expect([...out]).toEqual([0, -1, 1, -1, 2]);
    const moved = remapCopyTable(t, out);
    expect([...moved.copies, ...moved.slots]).toEqual([2, 2]);
    expect([...copyIndexMap(before, copies(9, 1, 2, 3, 4), 10)!]).toEqual([0, 1, 2, 3, 4]);
    expect([...copyIndexMap(before, copies(0, 1, 2, 3, 4, 5, 6), 10)!]).toEqual([0, 1, 2, 3, 4]);
    expect(copyIndexMap(before, copies(0, 7), 10)).toBeNull();
    expect(copyIndexMap(before, copies(9, 1, 2, 3, 4, 5), 10)).toBeNull();
  });
});

describe('paint in path space', () => {
  const brush: VertexPaintBrush = { radius: 1, strength: 1, channel: 0, falloff: 'constant' };
  const SHEETS = { '*': defaultTrimSheet() };
  const wall = (profile: [number, number][], end = 6, openings?: unknown[]): ArchitectureComponent => ({
    elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [end, 0, 0]] }, profile: 'wall', ...(openings !== undefined ? { openings } : {}) }],
    profiles: { wall: { points: profile, slots: profile.slice(1).map(() => 'lower_wall') } },
  } as ArchitectureComponent);
  /** Every generated vertex's R paint by its place ("x,y,z"), and how many vertices were made. */
  const painted = (c: ArchitectureComponent, grids: Partial<Record<'left' | 'right' | 'top', PathGrid>>): { paint: Map<string, number>; vertices: number } => {
    const paint = new Map<string, number>();
    let vertices = 0;
    for (const chunk of generateArchitecture(c, SHEETS)) {
      for (const m of chunk.meshes) {
        const out = new Uint8Array((m.mesh.positions.length / 3) * VERTEX_PAINT_BYTES);
        samplePathPaint([{ frame: pathPaintFrame({ architecture: c }, 'element:wall')!, grids }], m.mesh.positions, m.mesh.normals, out);
        vertices += out.length / 4;
        for (let i = 0; i < out.length / 4; i++) paint.set(`${m.mesh.positions[i * 3]!},${m.mesh.positions[i * 3 + 1]!},${m.mesh.positions[i * 3 + 2]!}`, out[i * 4]!);
      }
    }
    return { paint, vertices };
  };
  it('a wall painted on its right face keeps the paint where it was when it is made again taller, longer, with another profile', () => {
    const c = wall([[0, 0], [0, 3]]);
    const frame = pathPaintFrame({ architecture: c }, 'element:wall')!;
    // The face looks to the right of travel (+Z for a path along +X); a dab on it at x = 3, 1 m up.
    const r = paintPathDabs(null, frame, 'right', [[3, 1, 0.01]], brush);
    expect(r.changed).toBeGreaterThan(0);
    const before = painted(c, { right: r.grid! });
    const lit = [...before.paint].filter(([, v]) => v > 0);
    expect(lit.length).toBeGreaterThan(0);
    // Only vertices within the radius (on the face: along × up; one grid cell more where they lie between points) took paint.
    for (const [k] of lit) {
      const [x, y] = k.split(',').map(Number);
      expect(Math.hypot(x! - 3, y! - 1), k).toBeLessThanOrEqual(1 + PATH_PAINT_CELL);
    }
    expect(Math.max(...lit.map(([, v]) => v))).toBe(255);
    // Made again taller, longer, with a row more: every vertex that is where one was before has its paint.
    const after = painted(wall([[0, 0], [0, 1.25], [0, 4]], 9), { right: r.grid! });
    expect(after.vertices).toBeGreaterThan(before.vertices);
    let same = 0;
    for (const [k, v] of before.paint) {
      if (!after.paint.has(k)) continue;
      same++;
      expect(after.paint.get(k), k).toBe(v);
    }
    expect(same).toBeGreaterThan(lit.length);
    // The other side was not painted.
    expect([...painted(c, { left: r.grid! }).paint.values()].every((v) => v === 0)).toBe(true);
  });
  it('a spline\'s surface painted across keeps its paint when its mesh is made at another step', () => {
    const spline = (step: number): SplineComponent => ({ points: [{ at: [0, 0, 0] }, { at: [20, 0, 0] }], width: 4, mesh: { kind: 'surface', step } } as SplineComponent);
    const frame = pathPaintFrame({ spline: spline(1) }, 'spline')!;
    // The strip's vertices are at its edges, 2 m either side.
    const r = paintPathDabs(null, frame, 'top', [[10, 0, 0]], { ...brush, radius: 2.5 });
    const at = (step: number): Map<string, number> => {
      const out = new Map<string, number>();
      for (const piece of sweepSplineMesh(spline(step))) {
        const paint = new Uint8Array((piece.positions.length / 3) * VERTEX_PAINT_BYTES);
        samplePathPaint([{ frame: pathPaintFrame({ spline: spline(step) }, 'spline')!, grids: { top: r.grid! } }], piece.positions, piece.normals, paint, piece.center);
        for (let i = 0; i < paint.length / 4; i++) if (paint[i * 4]! > 0) out.set(`${(piece.positions[i * 3]! + piece.center[0]).toFixed(2)},${(piece.positions[i * 3 + 2]! + piece.center[2]).toFixed(2)}`, paint[i * 4]!);
      }
      return out;
    };
    const coarse = at(1);
    const fine = at(0.5);
    expect(coarse.size).toBeGreaterThan(0);
    expect(fine.size).toBeGreaterThan(coarse.size);
    for (const [k, v] of coarse) expect(fine.get(k), k).toBe(v);
  });
  it('a closed path painted across its start paints both ends', () => {
    const square = { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]] as [number, number, number][], closed: true };
    const frame = pathPaintFrame({ architecture: { elements: [{ id: 'room', kind: 'sweep', path: square, profile: 'w' }] } as unknown as ArchitectureComponent }, 'element:room')!;
    const r = paintPathDabs(null, frame, 'right', [[0.1, 0, 0]], brush);
    const g = r.grid!;
    // Points near s = 0 and near s = 16 (the length) are both painted.
    expect(g.origin[0]).toBe(0);
    expect(g.origin[0] + g.size[0] - 1).toBe(64);
  });
});
