/**
 * Stored copies through the GPU renderer: the blocks each draw lists per
 * frame hold every copy its level draws (each copy's level by its own
 * distance and size, the vertex stage's rule held to the CPU reference),
 * the passes take their share of a list, thinning, copies written in place,
 * a ray picking a copy, and one program for the draws of every set.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { INSTANCE_FLOATS } from '@thirdlight/project-model';

import { BLOCK_FLOATS, copyDensityAt, copyLevel, prepareCopies } from './copies-prepare';
import { buildGpuCopySet, GPU_COPIES_KEY } from './copies-gpu';
import { TAN_HALF_REFERENCE } from './instance-lod';
import { LOD_CULL_LEVEL_KEY, LodTuning } from './lod-switch';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';
import { CullView, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY, type ViewCullable } from './view-cull';
import type { ModelInstance } from './visual';
import { PAINT_MESH_KEY, vertexPaintDiagnostics, type PaintStream } from './vertex-paint-draw';

function copies(n: number, spread: number, scale = (_i: number): number => 1): Float32Array {
  const f = new Float32Array(n * INSTANCE_FLOATS);
  for (let i = 0; i < n; i += 1) {
    const o = i * INSTANCE_FLOATS;
    f[o] = (i % 100) * spread;
    f[o + 2] = Math.floor(i / 100) * spread;
    f[o + 6] = 1;
    f[o + 7] = f[o + 8] = f[o + 9] = scale(i);
  }
  return f;
}

function lodTemplate(cullAt?: number): { template: ModelInstance; near: THREE.BufferGeometry; far: THREE.BufferGeometry } {
  const root = new THREE.Group();
  const near = new THREE.BoxGeometry(1, 1, 1);
  const far = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const mat = new MeshStandardNodeMaterial();
  const lod = new THREE.LOD();
  lod.addLevel(new THREE.Mesh(near, mat), 0);
  lod.addLevel(new THREE.Mesh(far, mat), 30);
  if (cullAt !== undefined) {
    const none = new THREE.Group();
    none.userData[LOD_CULL_LEVEL_KEY] = true;
    lod.addLevel(none, cullAt);
  }
  root.add(lod);
  return { template: { glbRoot: root } as unknown as ModelInstance, near, far };
}

function camera(eye: [number, number, number], at: [number, number, number]): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  cam.position.set(...eye);
  cam.lookAt(...at);
  cam.updateMatrixWorld();
  return cam;
}

/** Cull the set's draws for a camera (what the adapter's view culler does each frame). */
function cullFor(meshes: readonly THREE.Mesh[], cam: THREE.Camera): CullView {
  const v = new CullView();
  v.set(cam);
  const groups = new Set(meshes.map((m) => (m.userData[VIEW_CULL_KEY] as ViewCullable).group!));
  for (const g of groups) g.cull(v);
  return v;
}

/** The copies (buffer indices) a draw lists for a pass of `cam`, read through its list as the vertex stage does. */
function listed(mesh: THREE.Mesh, cam: THREE.Camera, order: Uint32Array): number[] {
  mesh.onBeforeRender(null as never, null as never, cam, mesh.geometry, mesh.material as THREE.Material, null as never);
  const draw = mesh.userData[GPU_COPIES_KEY] as { list: { data: Float32Array; header: number }; set: { block: number } };
  const n = (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount / draw.set.block;
  const out: number[] = [];
  const h = draw.list.header;
  for (let e = h; e < h + n; e++) for (let k = 0; k < draw.list.data[e * 4 + 1]!; k++) out.push(order[draw.list.data[e * 4]! + k]!);
  return out;
}

const drawsGeometry = (m: THREE.Mesh, g: THREE.BufferGeometry): boolean => m.geometry.getAttribute('position') === g.getAttribute('position');

describe('stored copies on the GPU', () => {
  it('counts its painted copies for the paint diagnostics (by their texels, not by the draw\'s vertices)', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial());
    mesh.userData[PAINT_MESH_KEY] = 'box';
    root.add(mesh);
    const stream = { bytes: 64 } as unknown as PaintStream;
    // Three copies in a row, the middle one painted.
    const set = buildGpuCopySet({ glbRoot: root } as unknown as ModelInstance, copies(3, 2), 3, 'painted', { paint: { slotOf: (c) => (c === 1 ? 0 : -1), stream: () => stream } });
    const cam = camera([2, 3, -10], [2, 0, 0]);
    cullFor(set.meshes, cam);
    for (const m of set.meshes) m.onBeforeRender(null as never, null as never, cam, m.geometry, m.material as THREE.Material, null as never);
    const d = vertexPaintDiagnostics(set.group)!;
    expect(d.instancedDraws).toBeGreaterThan(0);
    expect(d.paintedInstances).toBe(d.instancedDraws);
    set.dispose();
  });

  it('each level\'s draw lists every copy its own distance and size put there; the static map draws all at the detailed level', () => {
    const { template, near, far } = lodTemplate(60);
    // 5000 copies 2 m apart, sizes 0.5–1.5: a copy switches at 30 m × its size and is culled at 60 m × its size.
    const size = (i: number): number => 0.5 + (i % 7) / 6;
    const f = copies(5000, 2, size);
    const set = buildGpuCopySet(template, f, 5000, 'lod', { tuning: new LodTuning(), lodPerCopy: true });
    expect(set.count).toBe(5000);
    expect(set.chunks).toBeGreaterThan(1);
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    const eye: [number, number, number] = [0, 10, 0];
    const cam = camera(eye, [100, 0, 50]);
    cullFor(set.meshes, cam);
    const order = prepareCopies(f, 5000).order;
    const distance = (i: number): number => Math.hypot(f[i * 10]! - eye[0], eye[1], f[i * 10 + 2]! - eye[2]);
    const levelOf = (i: number): number => copyLevel([0, 30, 60], distance(i), size(i));
    // A draw that casts nothing: a static map draws none of it.
    const shadow = new THREE.OrthographicCamera();
    const staticCam = new THREE.OrthographicCamera();
    staticCam.userData[STATIC_SHADOW_CAMERA_KEY] = true;
    expect(set.meshes.filter((m) => drawsGeometry(m, near)).flatMap((m) => listed(m, staticCam, order))).toHaveLength(0);
    // A shadow pass (any other camera) of a set that casts lists every candidate block; each copy at level 0 or 1 is in its level's list.
    for (const m of set.meshes) m.castShadow = true;
    const nearListed = new Set(set.meshes.filter((m) => drawsGeometry(m, near)).flatMap((m) => listed(m, shadow, order)));
    const farListed = new Set(set.meshes.filter((m) => drawsGeometry(m, far)).flatMap((m) => listed(m, shadow, order)));
    let n0 = 0;
    let n1 = 0;
    for (let i = 0; i < 5000; i++) {
      const l = levelOf(i);
      if (l === 0) {
        n0 += 1;
        expect(nearListed.has(i)).toBe(true);
      } else if (l === 1) {
        n1 += 1;
        expect(farListed.has(i)).toBe(true);
      }
    }
    // A block lies in few lists: far fewer copies listed than the set holds twice over.
    expect(nearListed.size + farListed.size).toBeLessThan(5000 * 0.8);
    const stats = set.stats();
    expect(stats.byLevel.slice(0, 2)).toEqual([n0, n1]);
    expect(stats.culled).toBe(5000 - n0 - n1);
    expect(stats.thinned).toBe(0);
    // The view's pass lists the blocks it sees, a subset of the candidates.
    const seen = set.meshes.filter((m) => drawsGeometry(m, near)).flatMap((m) => listed(m, cam, order));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((i) => nearListed.has(i))).toBe(true);
    // A cached static shadow map draws every copy at the most detailed level of a set that casts, none at others.
    expect(set.meshes.filter((m) => drawsGeometry(m, near)).flatMap((m) => listed(m, staticCam, order))).toHaveLength(5000);
    expect(set.meshes.filter((m) => drawsGeometry(m, far)).flatMap((m) => listed(m, staticCam, order))).toHaveLength(0);
    set.dispose();
    expect(set.group.parent).toBeNull();
  });

  it('by default each block draws one level, picked at its centre: listed once, by one level\'s draws', () => {
    const { template, near, far } = lodTemplate(60);
    const f = copies(5000, 2);
    const set = buildGpuCopySet(template, f, 5000, 'blocks', { tuning: new LodTuning() });
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    cullFor(set.meshes, camera([0, 10, 0], [100, 0, 50]));
    const order = prepareCopies(f, 5000).order;
    const cam = new THREE.OrthographicCamera();
    for (const m of set.meshes) m.castShadow = true;
    const nearListed = set.meshes.filter((m) => drawsGeometry(m, near)).flatMap((m) => listed(m, cam, order));
    const farListed = new Set(set.meshes.filter((m) => drawsGeometry(m, far)).flatMap((m) => listed(m, cam, order)));
    expect(nearListed.length).toBeGreaterThan(0);
    expect(farListed.size).toBeGreaterThan(0);
    expect(nearListed.some((i) => farListed.has(i))).toBe(false);
    const stats = set.stats();
    expect(stats.byLevel.slice(0, 2)).toEqual([nearListed.length, farListed.size]);
    expect(stats.culled).toBe(5000 - nearListed.length - farListed.size);
    set.dispose();
  });

  it('thins copies by their rank past the falloff, as the CPU reference does', () => {
    const { template } = lodTemplate();
    const f = copies(4000, 3);
    const density = { start: 0.2, end: 0.05, min: 0.25 };
    const set = buildGpuCopySet(template, f, 4000, 'thin', { density, lodPerCopy: true });
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    cullFor(set.meshes, camera([0, 5, 0], [100, 0, 100]));
    const radius = Math.sqrt(3) / 2;
    const from = radius / (TAN_HALF_REFERENCE * density.start);
    const to = radius / (TAN_HALF_REFERENCE * density.end);
    const prepared = prepareCopies(f, 4000);
    let thinned = 0;
    for (let s = 0; s < 4000; s++) {
      const i = prepared.order[s]!;
      const d = Math.hypot(f[i * 10]!, 5, f[i * 10 + 2]!);
      if (prepared.texels[s * 12 + 3]! >= copyDensityAt(d, from, to, density.min)) thinned += 1;
    }
    expect(thinned).toBeGreaterThan(1000);
    expect(set.stats().thinned).toBe(thinned);
    set.dispose();
    // A falloff down to no copies (a blob disc's) lists no block wholly past it: those draws would draw nothing.
    const gone = buildGpuCopySet(template, f, 4000, 'blobs', { density: { ...density, min: 0 } });
    scene.add(gone.group);
    scene.updateMatrixWorld(true);
    cullFor(gone.meshes, camera([0, 5, 0], [100, 0, 100]));
    const order = prepareCopies(f, 4000).order;
    const listedNow = gone.meshes.flatMap((m) => listed(m, new THREE.OrthographicCamera(), order));
    expect(listedNow.length).toBeGreaterThan(0);
    expect(listedNow.length).toBeLessThan(4000);
    // Whole blocks (up to ~24 m across on this 3 m grid) round the falloff's end.
    expect(listedNow.every((i) => Math.hypot(f[i * 10]!, 5, f[i * 10 + 2]!) < to + 50)).toBe(true);
    gone.dispose();
  });

  it('a copy written in place moves in its block (where it was and is told); a ray picks a copy by its index', () => {
    const { template } = lodTemplate();
    const f = copies(300, 4);
    const moved: number[][] = [];
    const set = buildGpuCopySet(template, f, 300, 'edit', { moved: (s) => moved.push([...s]) });
    const scene = new THREE.Scene();
    scene.add(set.group);
    set.group.position.set(10, 0, 0);
    scene.updateMatrixWorld(true);
    cullFor(set.meshes, camera([10, 20, -20], [10, 0, 0]));
    set.setCopy(5, [500, 0, 500, 0, 0, 0, 1, 1, 1, 1]);
    expect(moved).toHaveLength(1);
    // Before (the block round copy 5's place) and after (grown to hold 500, 500).
    expect(moved[0]!.length).toBe(8);
    const [x, y, z, r] = moved[0]!.slice(4);
    expect(Math.hypot(510 - x!, -y!, 500 - z!)).toBeLessThanOrEqual(r!);
    const box = set.copyBox(5)!;
    expect(box.containsPoint(new THREE.Vector3(510, 0, 500))).toBe(true);
    // A ray down onto copy 7 (at x 28, z 0, the set at x + 10).
    const ray = new THREE.Raycaster(new THREE.Vector3(38, 10, 0), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObjects([...set.meshes], false);
    expect(hits.length).toBeGreaterThan(0);
    expect(set.copyOf(hits[0]!.object, hits[0]!.instanceId!)).toBe(7);
    // A copy shrunk to nothing is not picked.
    set.setCopy(7, [28, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(ray.intersectObjects([...set.meshes], false).filter((h) => h.instanceId === 7)).toHaveLength(0);
    set.dispose();
  });

  it('blocks are compact on the ground and hold every copy once', () => {
    const f = copies(10000, 1);
    const p = prepareCopies(f, 10000);
    expect([...p.order].sort((a, b) => a - b)).toEqual([...Array(10000).keys()]);
    let widest = 0;
    for (let b = 0; b < p.blocks.length / BLOCK_FLOATS; b++) widest = Math.max(widest, p.blocks[b * BLOCK_FLOATS + 3]!);
    // 64 copies 1 m apart: a block is about an 8 × 8 m square (radius ~5.7 m), never a strip across the set.
    expect(widest).toBeLessThan(8);
  });

  it('a model of more than eight levels keeps every switch: its lists carry all its distances, and the vertex stage is the same program', () => {
    const root = new THREE.Group();
    const mat = new MeshStandardNodeMaterial();
    const lod = new THREE.LOD();
    for (let l = 0; l < 10; l += 1) lod.addLevel(new THREE.Mesh(new THREE.BoxGeometry(1, 1 - l * 0.05, 1), mat), l * 10);
    const none = new THREE.Group();
    none.userData[LOD_CULL_LEVEL_KEY] = true;
    lod.addLevel(none, 120);
    root.add(lod);
    const many = buildGpuCopySet({ glbRoot: root } as unknown as ModelInstance, copies(200, 2), 200, 'many', { tuning: new LodTuning(), lodPerCopy: true });
    expect(many.meshes).toHaveLength(10);
    const distances = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 120];
    for (const m of many.meshes) {
      const list = (m.userData[GPU_COPIES_KEY] as { list: { data: Float32Array; header: number } }).list;
      // Three fixed texels, then the 11 distances four a texel.
      expect(list.header).toBe(6);
      expect(list.data[5]).toBe(distances.length);
      expect(Array.from(list.data.subarray(12, 12 + distances.length))).toEqual(distances);
    }
    const few = buildGpuCopySet(lodTemplate(60).template, copies(50, 2), 50, 'few', { tuning: new LodTuning(), lodPerCopy: true });
    const renderer = wgslRenderer();
    const sa = litScene();
    sa.add(many.group);
    const sb = litScene();
    sb.add(few.group);
    expect(wgslOf(renderer, sa, many.meshes[0]!)).toBe(wgslOf(renderer, sb, few.meshes[0]!));
    many.dispose();
    few.dispose();
  });

  it('every set\'s draws build one vertex stage (their inputs bound per draw)', () => {
    const { template } = lodTemplate();
    const a = buildGpuCopySet(template, copies(50, 2), 50, 'a');
    const b = buildGpuCopySet(template, copies(900, 1), 900, 'b', { density: { start: 0.1, end: 0.05, min: 0.5 } });
    const renderer = wgslRenderer();
    const sa = litScene();
    sa.add(a.group);
    const sb = litScene();
    sb.add(b.group);
    const wa = wgslOf(renderer, sa, a.meshes[0]!);
    const wb = wgslOf(renderer, sb, b.meshes[0]!);
    expect(wa).toMatch(/instance_index/);
    expect(wa).toMatch(/textureLoad/);
    expect(wa).toBe(wb);
    a.dispose();
    b.dispose();
  });
});
