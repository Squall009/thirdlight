/**
 * The decal clipper (project-model `clipDecal`) against three's
 * DecalGeometry on the same inputs, on receivers the engine makes (a block
 * chunk, a generated room's walls and crown moulding, a heightfield patch, a
 * dense model), and its cost per decal.
 *
 * three is this test's only: project-model never imports it.
 *
 * Parity: DecalGeometry has no normal fade, no lift and no welding, and its
 * v runs up the image; so the clipper runs with the fade at 180° and no lift,
 * and the areas agree, each of the clipper's vertices (position, normal,
 * uv) is one of three's, and each of three's lies on the clipper's surface.
 *
 * Cost (the plan's soft target: ≤ 5 ms a decal on a worker for 50k receiver
 * triangles) is printed per receiver; set TL_PERF=1 to append it to
 * ~/.cache/thirdlight-perf/decal-clip.jsonl. The assertion is loose (this
 * host's load varies); the printed numbers go to the plan.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { describe, expect, it } from 'vitest';

import { clipDecal, type DecalClipMesh, type DecalClipReceiver } from '../packages/project-model/src/decal-clip';
import { generateArchitecture } from '../packages/project-model/src/arch-generate';
import { defaultTrimSheet } from '../packages/project-model/src/trim-sheet';
import { BlockGrid } from '../packages/project-model/src/block-grid';
import { meshBlockChunk, shapeSource, type BlockLookResolver } from '../packages/project-model/src/block-mesh';
import type { BlockType } from '../packages/project-model/src/block-layers';
import { testArchitecture } from './arch-test-style';

interface Box {
  readonly position: readonly [number, number, number];
  readonly quaternion: THREE.Quaternion;
  readonly size: readonly [number, number, number];
}

const matrixOf = (b: Box): number[] => new THREE.Matrix4().compose(new THREE.Vector3(...b.position), b.quaternion, new THREE.Vector3(1, 1, 1)).toArray();
/** A box whose −Z looks along `dir` (its image's +Y as near the world's `up` as it can be). */
function looking(position: [number, number, number], dir: [number, number, number], size: [number, number, number], up: [number, number, number] = [0, 1, 0]): Box {
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(...dir), new THREE.Vector3(...up));
  return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m), size };
}

function meshOf(r: DecalClipReceiver): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.positions), 3));
  if (r.normals) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(r.normals), 3));
  if (r.index) g.setIndex(new THREE.BufferAttribute(new Uint32Array(r.index), 1));
  const mesh = new THREE.Mesh(g);
  if (r.matrix) mesh.matrix.fromArray(Array.from(r.matrix));
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** DecalGeometry over each receiver, in the world: positions, normalised normals, uvs. */
function threeDecal(box: Box, receivers: readonly DecalClipReceiver[]): { p: number[]; n: number[]; uv: number[]; area: number } {
  const out = { p: [] as number[], n: [] as number[], uv: [] as number[], area: 0 };
  for (const r of receivers) {
    const g = new DecalGeometry(meshOf(r), new THREE.Vector3(...box.position), new THREE.Euler().setFromQuaternion(box.quaternion), new THREE.Vector3(...box.size));
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const v = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      const s = new THREE.Triangle(a, b, c).getArea();
      out.area += s;
      // Its zero-area triangles (a corner exactly on a plane is cut into a point) are not surface; the clipper drops them.
      if (s < 1e-12) continue;
      for (let k = i; k < i + 3; k++) {
        out.p.push(p.getX(k), p.getY(k), p.getZ(k));
        if (n) {
          v.set(n.getX(k), n.getY(k), n.getZ(k)).normalize();
          out.n.push(v.x, v.y, v.z);
        }
        out.uv.push(uv.getX(k), uv.getY(k));
      }
    }
  }
  return out;
}

/** The clipper's mesh in the world (its entity's matrix applied), as the parity check reads it. */
function ours(box: Box, receivers: readonly DecalClipReceiver[], extra: { normalFade?: number; lift?: number } = { normalFade: 180, lift: 0 }): { m: DecalClipMesh; p: number[]; n: number[]; area: number } {
  const matrix = matrixOf(box);
  const m = clipDecal({ matrix, size: box.size, ...extra }, receivers);
  const M = new THREE.Matrix4().fromArray(matrix);
  const N = new THREE.Matrix3().getNormalMatrix(M);
  const p: number[] = [];
  const n: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < m.positions.length / 3; i++) {
    v.fromArray(m.positions, i * 3).applyMatrix4(M);
    p.push(v.x, v.y, v.z);
    v.fromArray(m.normals, i * 3).applyMatrix3(N).normalize();
    n.push(v.x, v.y, v.z);
  }
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < m.index.length; t += 3) {
    a.fromArray(p, m.index[t]! * 3);
    b.fromArray(p, m.index[t + 1]! * 3);
    c.fromArray(p, m.index[t + 2]! * 3);
    area += new THREE.Triangle(a, b, c).getArea();
  }
  return { m, p, n, area };
}

/**
 * Every vertex of `a` has one in `b` at its position (within `tol` metres) with its normal (within ~2.5°) and its uv
 * (`flipV`: b's v is 1 − a's); the count of those that do not.
 */
function unmatched(a: { p: number[]; n: number[]; uv: number[] }, b: { p: number[]; n: number[]; uv: number[] }, tol: number, flipV: boolean): number {
  const cell = 0.01;
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < b.p.length / 3; i++) {
    const k = keyOf(b.p[i * 3]!, b.p[i * 3 + 1]!, b.p[i * 3 + 2]!);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  let missing = 0;
  for (let i = 0; i < a.p.length / 3; i++) {
    const [x, y, z] = [a.p[i * 3]!, a.p[i * 3 + 1]!, a.p[i * 3 + 2]!];
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) for (let dy = -1; dy <= 1 && !found; dy++) for (let dz = -1; dz <= 1 && !found; dz++) {
      for (const j of grid.get(keyOf(x + dx * cell, y + dy * cell, z + dz * cell)) ?? []) {
        if (Math.abs(b.p[j * 3]! - x) > tol || Math.abs(b.p[j * 3 + 1]! - y) > tol || Math.abs(b.p[j * 3 + 2]! - z) > tol) continue;
        if (a.n.length > 0 && b.n.length > 0 && a.n[i * 3]! * b.n[j * 3]! + a.n[i * 3 + 1]! * b.n[j * 3 + 1]! + a.n[i * 3 + 2]! * b.n[j * 3 + 2]! < 0.999) continue;
        const bv = flipV ? 1 - b.uv[j * 2 + 1]! : b.uv[j * 2 + 1]!;
        if (Math.abs(b.uv[j * 2]! - a.uv[i * 2]!) > 1e-4 || Math.abs(bv - a.uv[i * 2 + 1]!) > 1e-4) continue;
        found = true;
        break;
      }
    }
    if (!found) missing++;

  }
  return missing;
}

/** How many of `points` lie farther than `tol` from every triangle of the mesh (world positions `p`, `index`). */
function offSurface(points: readonly number[], p: readonly number[], index: ArrayLike<number>, tol: number): number {
  const q = new THREE.Vector3(), t = new THREE.Triangle(), c = new THREE.Vector3();
  let off = 0;
  for (let i = 0; i < points.length / 3; i++) {
    q.fromArray(points, i * 3);
    let best = Infinity;
    for (let k = 0; k < index.length && best > tol; k += 3) {
      t.a.fromArray(p, index[k]! * 3);
      t.b.fromArray(p, index[k + 1]! * 3);
      t.c.fromArray(p, index[k + 2]! * 3);
      best = Math.min(best, t.closestPointToPoint(q, c).distanceTo(q));
    }
    if (best > tol) off++;
  }
  return off;
}

function parity(box: Box, receivers: readonly DecalClipReceiver[]): { area: number; vertices: number; triangles: number; threeVertices: number } {
  const t = threeDecal(box, receivers);
  const o = ours(box, receivers);
  const mine = { p: o.p, n: o.n, uv: Array.from(o.m.uvs) };
  expect(o.area).toBeGreaterThan(0);
  expect(Math.abs(o.area - t.area) / t.area).toBeLessThan(1e-4);
  // Each of our (welded) vertices is one of three's, normal and uv included.
  expect(unmatched(mine, t, 2e-5, true)).toBe(0);
  // Each of three's lies on our surface: it also cuts the diagonals it splits a triangle with, so it has extra
  // corners along the box's faces where ours has a straight edge.
  expect(offSurface(t.p, o.p, o.m.index, 2e-5)).toBe(0);
  return { area: o.area, vertices: o.m.positions.length / 3, triangles: o.m.index.length / 3, threeVertices: t.p.length / 3 };
}

/** A UV sphere as three makes it (with its degenerate pole triangles). */
function sphere(radius: number, w: number, h: number, matrix?: THREE.Matrix4): DecalClipReceiver {
  const g = new THREE.SphereGeometry(radius, w, h);
  return {
    positions: g.getAttribute('position').array as Float32Array,
    normals: g.getAttribute('normal').array as Float32Array,
    index: g.getIndex()!.array as Uint16Array,
    ...(matrix ? { matrix: matrix.toArray() } : {}),
  };
}
/** A heightfield patch `n` quads square, `side` metres, rolling hills, indexed, with normals. */
function heightfield(n: number, side: number): DecalClipReceiver {
  const g = new THREE.PlaneGeometry(side, side, n, n).rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, 0.6 * Math.sin(p.getX(i) * 0.7) * Math.cos(p.getZ(i) * 0.5));
  g.computeVertexNormals();
  return { positions: p.array as Float32Array, normals: g.getAttribute('normal').array as Float32Array, index: g.getIndex()!.array as Uint16Array };
}

/** A block layer chunk: sloped ground with steps and a pit, every shape's stand-in. */
function blockChunk(): DecalClipReceiver[] {
  const types: BlockType[] = [
    { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
    { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#777777' }], shape: 'ramp', rotations: [0, 90, 180, 270] },
    { blockId: 'stairs', name: 'Stairs', variants: [{ color: '#666666' }], shape: 'stairs', rotations: [0, 90, 180, 270] },
  ];
  const byId = new Map(types.map((t) => [t.blockId, t]));
  const looks: BlockLookResolver = { source: (t, v, fm) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes) }) };
  const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [16, 24, 16] } });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    if (x >= 6 && x < 8 && z >= 6 && z < 8) continue;
    const top = 6 + Math.floor(x / 4) + ((x + z) % 3 === 0 ? 1 : 0);
    for (let y = 0; y < top; y++) g.set(x, y, z, { block: 'stone' });
  }
  g.set(3, g.columnTop(3, 3)! + 1, 3, { block: 'ramp', rot: 90 });
  g.set(4, g.columnTop(4, 3)! + 1, 3, { block: 'stairs', rot: 180 });
  return meshBlockChunk(g, 0, 0, byId, looks).map((part) => ({ positions: part.positions, normals: part.normals, index: part.indices }));
}

/** The test room's walls, crown moulding, floor and vault as the generator makes them. */
function room(): DecalClipReceiver[] {
  const out: DecalClipReceiver[] = [];
  for (const chunk of generateArchitecture(testArchitecture(), { '*': defaultTrimSheet() })) {
    for (const m of chunk.meshes) out.push({ positions: m.mesh.positions, normals: m.mesh.normals, index: m.mesh.indices });
  }
  return out;
}

const PERF = process.env['TL_PERF'] === '1';
function record(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line));
  if (!PERF) return;
  const dir = process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'decal-clip.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}
/** The median of `runs` timed clips (ms), after warming up. */
function timed(fn: () => unknown, runs = 31): number {
  for (let i = 0; i < 40; i++) fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(runs / 2)]!;
}
const triangleCount = (rs: readonly DecalClipReceiver[]): number => rs.reduce((s, r) => s + Math.floor((r.index ? r.index.length : r.positions.length / 3) / 3), 0);

describe('decal clipper against three DecalGeometry', () => {
  it('a curved model (a sphere turned and scaled), a box over its side', () => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, -1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, 0.1)), new THREE.Vector3(1.5, 1.5, 1.5));
    const r = parity(looking([1.8, 2.5, -1], [-1, -0.4, 0.1], [1, 0.8, 2]), [sphere(1, 32, 16, m)]);
    expect(r.triangles).toBeGreaterThan(20);
  });

  it('a box over a block chunk corner (steps, a ramp, stairs, a pit)', () => {
    const chunk = blockChunk();
    // Across the pit's rim, looking down and a little sideways, so walls and tops are both cut.
    parity(looking([6.2, 4, 6.3], [0.3, -1, 0.2], [2.5, 2, 3]), chunk);
    // Over a ramp and a stair from the side.
    parity(looking([3.5, 4, 1.5], [0.1, -0.6, 1], [2, 2, 3]), chunk);
  });

  it('a box over a generated wall corner and its crown moulding', () => {
    const rs = room();
    // The room's corner at (8, 0, 0), looked at from inside (toward +X +Z… the corner is at the box's back), high enough for the crown.
    const r = parity(looking([7.6, 2.7, 0.4], [1, 0.1, -1], [1.2, 1, 1.5]), rs);
    expect(r.triangles).toBeGreaterThan(30);
  });

  it('a heightfield patch and several receivers at once (the sphere on it)', () => {
    const rs = [heightfield(64, 16), sphere(0.7, 24, 12, new THREE.Matrix4().makeTranslation(0.3, 0.4, 0.2))];
    parity(looking([0.2, 1.5, 0], [0, -1, 0], [3, 3, 4], [0, 0, -1]), rs);
  });
});

describe('decal clipper on generated receivers', () => {
  it('a wall corner with its moulding: faces past the fade left out, the rest faded smoothly', () => {
    const rs = room();
    const box = looking([7.6, 2.7, 0.4], [1, 0.1, -1], [1.2, 1, 1.5]);
    const all = ours(box, rs);
    const faded = ours(box, rs, {});
    expect(faded.m.stats.faded).toBeGreaterThan(0);
    expect(faded.area).toBeLessThan(all.area);
    expect(faded.area).toBeGreaterThan(0);
    for (const f of faded.m.fades) expect(f >= 0 && f <= 1).toBe(true);
    // The two walls meeting at the corner are both met at ~45°: both keep the mark.
    const n = faded.n;
    let east = 0, south = 0;
    for (let i = 0; i < n.length / 3; i++) {
      if (n[i * 3]! < -0.99) east++;
      if (n[i * 3 + 2]! > 0.99) south++;
    }
    expect(east).toBeGreaterThan(0);
    expect(south).toBeGreaterThan(0);
  });

  it('a regenerated wall clips to the same bytes', () => {
    const box = looking([7.6, 2.7, 0.4], [1, 0.1, -1], [1.2, 1, 1.5]);
    const a = ours(box, room(), {}).m;
    const b = ours(box, room(), {}).m;
    for (const k of ['positions', 'normals', 'uvs', 'tangents', 'fades', 'index'] as const) expect(Buffer.from(b[k].buffer).equals(Buffer.from(a[k].buffer))).toBe(true);
  });
});

describe('decal clipper cost', () => {
  it('ms per decal on typical receivers and on 50k triangles', () => {
    const chunk = blockChunk();
    const walls = room();
    const patch = [heightfield(128, 32)];
    const dense = [sphere(1, 160, 160)];
    const cases: { name: string; rs: DecalClipReceiver[]; box: Box }[] = [
      { name: 'block chunk', rs: chunk, box: looking([6.2, 4, 6.3], [0.3, -1, 0.2], [2, 2, 3]) },
      { name: 'architecture wall corner', rs: walls, box: looking([7.6, 2.7, 0.4], [1, 0.1, -1], [1.2, 1, 1.5]) },
      { name: 'terrain patch', rs: patch, box: looking([1, 2, 1], [0, -1, 0], [2, 2, 4], [0, 0, -1]) },
      { name: 'model 50k, 1 m mark', rs: dense, box: looking([0, 0, 1.2], [0, 0, -1], [1, 1, 1]) },
      { name: 'model 50k, whole model in the box', rs: dense, box: looking([0, 0, 0], [0, 0, -1], [2.2, 2.2, 2.2]) },
    ];
    for (const c of cases) {
      const matrix = matrixOf(c.box);
      // The first call is cold for the first case only (a worker's first decal at load); the rest are warm.
      const cold = performance.now();
      const out = clipDecal({ matrix, size: c.box.size }, c.rs);
      const firstMs = performance.now() - cold;
      const ms = timed(() => clipDecal({ matrix, size: c.box.size }, c.rs));
      const tris = triangleCount(c.rs);
      record({ case: c.name, receiverTriangles: tris, ms: Number(ms.toFixed(3)), firstMs: Number(firstMs.toFixed(3)), nsPerReceiverTriangle: Number(((ms * 1e6) / tris).toFixed(1)), outVertices: out.positions.length / 3, outTriangles: out.index.length / 3 });
      // Loose: the soft target is 5 ms for 50k triangles; this host's load swings.
      expect(ms).toBeLessThan(50);
    }
  });
});
