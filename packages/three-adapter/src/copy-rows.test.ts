/**
 * Stored copies as rows of the culled-instance table: the selection rule's CPU reference (levels with
 * hysteresis and a cross-fade, thinning, the cull size, the near-shadow list), the rows and selection data the
 * table builds from a set, and the compute passes' WGSL.
 */
import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { CPU_SCALAR_OPS } from '@thirdlight/shared';

import { COPY_FADE_FULL, COPY_LEVEL_FADE_S, copyFadeStep, copySphereCentre, modelSphereOf, nextCopyState, packCopyState, selectCopy, unpackCopyState, type CopySelection } from './copy-rows-rule';
import { CopyRowsTable, type CopyRow, type CopyRowsHost, type CopyRowsSource } from './copy-rows';
import { NO_OUTPUT, SELECT_COVER, SELECTION_U32 } from './copy-rows-select';
import { LodTuning } from './lod-switch';
import { RangeAllocator } from './occlusion-instances-rule';
import { InstanceOcclusion } from './occlusion-instances';
import { computeWgsl, wgslRenderer } from './test-wgsl';
import { CullView } from './view-cull';

const SEL: CopySelection = { switches: [0, 30, 80, 200], culls: true, toDistance: 1, hysteresis: 0.1, worldScale: 1, density: null, nearReach: null, ungrouped: false, levels: [true, true, true, true] };

describe('a copy picked for the view (the selection pass, on the CPU)', () => {
  it('takes its level at once the first time, and from then on cross-fades a switch over the fade time', () => {
    const first = selectCopy(SEL, 50, 1, 0, true, 0, 1 / 30);
    expect(first.levels).toEqual([[1, true]]);
    expect(first.fade).toBe(1);
    // Walking out past 80 m: level 2, and level 1 still listed for the view while the fade runs.
    let s = selectCopy(SEL, 81, 1, 0, true, first.state, 1 / 30);
    expect(s.levels).toEqual([
      [2, true],
      [1, true],
    ]);
    expect(s.fade).toBe(0);
    let t = 0;
    while (s.levels.length > 1) {
      s = selectCopy(SEL, 81, 1, 0, true, s.state, 1 / 30);
      t += 1 / 30;
    }
    expect(t).toBeGreaterThan(COPY_LEVEL_FADE_S - 2 / 30);
    expect(t).toBeLessThan(COPY_LEVEL_FADE_S + 2 / 30);
    expect(s.fade).toBe(1);
    // Out of view: only its own level, from the back of the list (a shadow camera's), never the level it left.
    const out = selectCopy(SEL, 120, 1, 0, false, first.state, 1 / 30);
    expect(out.levels).toEqual([[2, false]]);
  });

  it('keeps a shown level at the switch (hysteresis): no flicker for a view rocking across it', () => {
    let s = selectCopy(SEL, 81, 1, 0, true, 0, 1 / 30);
    expect(unpackCopyState(s.state).level).toBe(2);
    for (const d of [79, 81, 78.5, 80.5, 74]) {
      s = selectCopy(SEL, d, 1, 0, true, s.state, 1 / 30);
      expect(unpackCopyState(s.state).level).toBe(2);
    }
    s = selectCopy(SEL, 71.9, 1, 0, true, s.state, 1 / 30);
    expect(unpackCopyState(s.state).level).toBe(1);
  });

  it('draws nothing past the cull size (and fades out of the level before it), thins by rank, lists the near shadows', () => {
    let s = selectCopy(SEL, 190, 1, 0, true, 0, 1 / 30);
    s = selectCopy(SEL, 210, 1, 0, true, s.state, 1 / 30);
    expect(s.levels).toEqual([[2, true]]);
    const thin: CopySelection = { ...SEL, density: { from: 10, to: 50, min: 0.2 } };
    expect(selectCopy(thin, 30, 1, 0.59, true, 0, 0).levels).toEqual([[1, true]]);
    expect(selectCopy(thin, 30, 1, 0.61, true, 0, 0).levels).toEqual([]);
    const near: CopySelection = { ...SEL, nearReach: 40, ungrouped: true };
    const n = selectCopy(near, 35, 1, 0, false, 0, 0);
    expect([n.near, n.ungrouped]).toEqual([true, false]);
    expect(selectCopy(near, 45, 1, 0, true, 0, 0).near).toBe(false);
    // A copy shrunk to nothing (hidden) is listed nowhere.
    expect(selectCopy(near, 35, 0, 0, true, 0, 0)).toMatchObject({ levels: [], near: false, ungrouped: null });
  });

  it('packs its state so that zero is fresh, and runs a fade down by the frame time', () => {
    expect(unpackCopyState(0)).toEqual({ level: -1, left: -1, remaining: 0 });
    const a = nextCopyState(0, 2, copyFadeStep(1 / 30));
    expect(unpackCopyState(a)).toEqual({ level: 2, left: -1, remaining: 0 });
    const b = nextCopyState(a, 3, copyFadeStep(1 / 30));
    expect(unpackCopyState(b)).toEqual({ level: 3, left: 2, remaining: COPY_FADE_FULL });
    expect(unpackCopyState(nextCopyState(b, 3, copyFadeStep(COPY_LEVEL_FADE_S)))).toEqual({ level: 3, left: -1, remaining: 0 });
    expect(packCopyState(3, -1, 0)).toBe(4);
  });
});

describe('a copy\'s sphere (the selection pass tests the frustum and the pyramid with it)', () => {
  it('lies around the model\'s box centre as the copy places it, holds every corner of the placed box, and is far smaller than a sphere around a standing model\'s origin', () => {
    // A 3 m marker standing on its origin, as a tree or a rock does: x 0..3, y 0..3, z -1.5..1.5.
    const box = new THREE.Box3(new THREE.Vector3(0, 0, -1.5), new THREE.Vector3(3, 3, 1.5));
    const sphere = modelSphereOf(box);
    expect(sphere.centre).toEqual([1.5, 1.5, 0]);
    expect(sphere.radius).toBeCloseTo(Math.hypot(1.5, 1.5, 1.5), 12);
    const fromOrigin = Math.hypot(3, 3, 1.5);
    expect(sphere.radius / fromOrigin).toBeLessThan(0.6);
    expect(modelSphereOf(new THREE.Box3())).toEqual({ centre: [0, 0, 0], radius: 0 });
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 200; i += 1) {
      const q = new THREE.Quaternion(rnd(), rnd(), rnd(), rnd()).normalize();
      const scale = new THREE.Vector3(0.2 + Math.abs(rnd()) * 3, 0.2 + Math.abs(rnd()) * 3, 0.2 + Math.abs(rnd()) * 3);
      const place = new THREE.Vector3(rnd() * 100, rnd() * 10, rnd() * 100);
      const c = copySphereCentre(CPU_SCALAR_OPS, [place.x, place.y, place.z], [q.x, q.y, q.z, q.w], [scale.x, scale.y, scale.z], sphere.centre);
      // The draw's placement (copy-rows-draw.ts): turn(q, p × scale) + place, here by three's own quaternion.
      const want = new THREE.Vector3(...sphere.centre).multiply(scale).applyQuaternion(q).add(place);
      expect(c[0]).toBeCloseTo(want.x, 9);
      expect(c[1]).toBeCloseTo(want.y, 9);
      expect(c[2]).toBeCloseTo(want.z, 9);
      // The pass's radius: the model's times the copy's largest scale; every placed corner lies inside it.
      const r = sphere.radius * Math.max(scale.x, scale.y, scale.z);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const corner = new THREE.Vector3(x, y, z).multiply(scale).applyQuaternion(q).add(place);
        expect(corner.distanceTo(want)).toBeLessThanOrEqual(r + 1e-9);
      }
    }
  });
});

/** A set of `count` copies on a line, with one LOD group of `levels` levels and two meshes a level, plus a near-shadow mesh. */
function source(count: number, levels: number, near: boolean): CopyRowsSource {
  const meshes = [];
  for (let l = 0; l < levels; l += 1) for (let m = 0; m < 2; m += 1) meshes.push({ mesh: new THREE.Mesh(new THREE.BoxGeometry()), group: 0, level: l, near: false, staticAll: l === 0 });
  if (near) meshes.push({ mesh: new THREE.Mesh(new THREE.BoxGeometry()), group: 0, level: 0, near: true, staticAll: false });
  return {
    count,
    groups: [{ distances: Array.from({ length: levels }, (_, i) => i * 40), culls: false }],
    meshes,
    copiesVersion: 1,
    writeCopies: (target, at) => {
      for (let i = 0; i < count; i += 1) target.set([i, 0, 0, 0.5, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 1], (at + i) * 16);
      return null;
    },
    world: new THREE.Matrix4(),
    modelReach: 1,
    modelCentre: [0.25, 0.5, -0.75],
    density: null,
    nearReach: near ? 30 : null,
    blockLevels: () => null,
    tuning: new LodTuning(),
    vertexReach: () => 0,
    shown: () => true,
    released: () => undefined,
  };
}

function host(): CopyRowsHost {
  const alloc = new RangeAllocator(4096);
  const u32 = (n: number): StorageBufferAttribute => new StorageBufferAttribute(new Uint32Array(n), 1);
  return {
    alloc: (n) => alloc.alloc(n),
    release: (b, n) => alloc.release(b, n),
    matrices: new StorageBufferAttribute(new Float32Array(4096 * 16), 4),
    spheres: new StorageBufferAttribute(new Float32Array(4096 * 4), 4),
    visible: u32(4096),
    slots: u32(4096),
    lists: u32(1 + 4096 * 2),
    dirtyMatrices: () => undefined,
    zeroVisible: () => undefined,
  };
}

const LAYOUT = { stride: 12, argsStride: 15, argsOther: 10, flagSelected: 32, outputField: 7 };

describe('a set of copies as the table rows', () => {
  it('gives every list a place, its first mesh the compaction (the others share it), and writes the selection data', () => {
    const computes: unknown[] = [];
    const renderer = { compute: (n: unknown) => void computes.push(n) } as never;
    const h = host();
    const table = new CopyRowsTable(renderer, h, LAYOUT);
    const a = source(100, 3, true);
    const b = source(70, 2, false);
    expect(table.adopt(a)).toBe(true);
    expect(table.adopt(b)).toBe(true);
    const rows: CopyRow[] = [];
    table.list(rows as unknown[], () => true);
    table.writeCopies();
    // Per list: its rows together, the first one the owner; near-shadow rows are drawn by shadow cameras only.
    expect(rows.map((r) => `${r.level}:${r.owner ? 'o' : 's'}${r.sharers}${r.otherOnly ? 'n' : ''}`)).toEqual(['0:o1', '0:s0', '1:o1', '1:s0', '2:o1', '2:s0', '-1:o0n', '0:o1', '0:s0', '1:o1', '1:s0']);
    expect(rows.every((r, i) => r.row === i)).toBe(true);
    // Each list has a range of its own (its copies' count), apart from the set's copies; the sets' copies were written.
    const bases = new Set(rows.map((r) => r.base));
    expect(bases.size).toBe(4 + 2);
    const copiesA = rows[0]!.copies;
    expect((h.matrices.array as Float32Array)[(copiesA + 7) * 16]).toBe(7);
    for (const r of rows) expect(r.base === copiesA).toBe(false);
    const view = new CullView();
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    cam.updateMatrixWorld(true);
    view.set(cam);
    table.run(view, rows.length, { table: new StorageBufferAttribute(new Uint32Array(12 * 16), 1), args: new StorageBufferAttribute(new Uint32Array(15 * 16), 1) }, 0);
    expect(table.ran).toBe(true);
    expect(computes.length).toBe(1);
    // The data: a chunk per 64 copies (2 + 2), then each selection's header, its level outputs and the lists.
    const data = (table as unknown as { data: StorageBufferAttribute }).data.array as Uint32Array;
    expect([...data.subarray(0, 8)]).toEqual([0, 0, 0, 64, 1, 0, 1, 64]);
    const headers = 8;
    expect([...data.subarray(headers, headers + SELECTION_U32)]).toEqual([copiesA, 100, copiesA, 3, 0, 0, headers + 2 * SELECTION_U32, NO_OUTPUT, 3, NO_OUTPUT]);
    expect([...data.subarray(headers + 2 * SELECTION_U32, headers + 2 * SELECTION_U32 + 5)]).toEqual([0, 1, 2, 4, 5]);
    // A set whose blocks pick one level each (not per copy): its blocks' levels follow the lists, block-major.
    const levels = Int16Array.from([1, 0, -1]);
    (b as { blockLevels: () => Int16Array | null }).blockLevels = () => levels;
    rows.length = 0;
    table.list(rows as unknown[], () => true);
    table.run(view, rows.length, { table: new StorageBufferAttribute(new Uint32Array(12 * 16), 1), args: new StorageBufferAttribute(new Uint32Array(15 * 16), 1) }, 0);
    const d2 = (table as unknown as { data: StorageBufferAttribute }).data.array as Uint32Array;
    const outsEnd = headers + 2 * SELECTION_U32 + 5 + 6 * 2;
    expect(d2[headers + SELECTION_U32 + 9]).toBe(outsEnd);
    expect([...d2.subarray(outsEnd, outsEnd + 3)]).toEqual([1, 0, 0]);
    // A set no longer shown gives its places back.
    (b as { shown: () => boolean }).shown = () => false;
    const before = rows.length;
    rows.length = 0;
    table.list(rows as unknown[], () => true);
    expect(rows.length).toBe(before - 4);
  });

  it('runs its pick only while something it reads changes (a still view keeps the last lists once fades are done)', () => {
    const computes: unknown[] = [];
    // A renderer that runs nothing: the counts' read-back (once the view holds still) reads nothing back.
    const table = new CopyRowsTable({ compute: (n: unknown) => void computes.push(n), getArrayBufferAsync: () => new Promise(() => undefined) } as never, host(), LAYOUT);
    table.adopt(source(10, 2, false));
    const view = new CullView();
    const cam = new THREE.PerspectiveCamera();
    cam.updateMatrixWorld(true);
    view.set(cam);
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frame = (): void => {
      const rows: CopyRow[] = [];
      table.list(rows as unknown[], () => true);
      table.writeCopies();
      table.run(view, rows.length, { table: new StorageBufferAttribute(new Uint32Array(12 * 8), 1), args: new StorageBufferAttribute(new Uint32Array(15 * 8), 1) }, 0);
    };
    try {
      frame();
      now += 100;
      frame();
      expect(computes.length).toBe(2);
      now += 1000;
      frame();
      expect([computes.length, table.ran]).toEqual([2, true]);
      // The view moves: picked again.
      cam.position.x += 1;
      cam.updateMatrixWorld(true);
      view.set(cam);
      now += 33;
      frame();
      expect(computes.length).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it('takes ground cover\'s point sets as sets of their own: flagged for the cover\'s thinning, its numbers in the falloff\'s place, counted apart, written only where they changed', () => {
    const dirty: [number, number][] = [];
    const h = { ...host(), dirtyMatrices: (a: number, b: number) => void dirty.push([a, b]) };
    const table = new CopyRowsTable({ compute: () => undefined } as never, h, LAYOUT);
    const copies = source(10, 2, false);
    const cover: CopyRowsSource = { ...source(128, 1, false), cover: { full: 21, reach: 80, min: 0.1 }, copiesVersion: 1, writeCopies: (_t, _at, since) => (since === undefined ? null : [64, 128]) };
    table.adopt(copies);
    table.adopt(cover);
    const rows: CopyRow[] = [];
    table.list(rows as unknown[], () => true);
    table.writeCopies();
    const view = new CullView();
    const cam = new THREE.PerspectiveCamera();
    cam.updateMatrixWorld(true);
    view.set(cam);
    table.run(view, rows.length, { table: new StorageBufferAttribute(new Uint32Array(12 * 16), 1), args: new StorageBufferAttribute(new Uint32Array(15 * 16), 1) }, 0);
    const data = (table as unknown as { data: StorageBufferAttribute }).data.array as Uint32Array;
    // Chunks: 1 of the copies, 2 of the cover's points; then the headers (flags at 4, floats at 5).
    const headers = 3 * 2;
    expect(data[headers + 4]).toBe(0);
    expect(data[headers + SELECTION_U32 + 4]).toBe(SELECT_COVER);
    const floats = (table as unknown as { floats: StorageBufferAttribute }).floats.array as Float32Array;
    const f = data[headers + SELECTION_U32 + 5]!;
    expect([...floats.subarray(f + 22, f + 25)].map((v) => Math.round(v * 100) / 100)).toEqual([21, 80, 0.1]);
    // Then the model's sphere centre (its radius at 19).
    expect([floats[f + 19], ...floats.subarray(f + 25, f + 28)]).toEqual([1, 0.25, 0.5, -0.75]);
    expect(table.diagnostics()).toMatchObject({ sets: 1, copies: 10, rows: 4, lists: 2, cover: { sets: 1, copies: 128, rows: 2, lists: 1 } });
    // A changed point set: only its range written (and uploaded).
    dirty.length = 0;
    (cover as { copiesVersion: number }).copiesVersion = 2;
    table.writeCopies();
    const at = rows.find((r) => r.output.cover)!.copies;
    expect(dirty).toEqual([[(at + 64) * 16, (at + 128) * 16]]);
  });

  it('builds its three compute passes (WGSL: atomic counters, the shared level steps, the frustum)', () => {
    const renderer = { compute: () => undefined } as never;
    const table = new CopyRowsTable(renderer, host(), LAYOUT);
    const rows: CopyRow[] = [];
    table.adopt(source(10, 2, true));
    table.list(rows as unknown[], () => true);
    const view = new CullView();
    const cam = new THREE.PerspectiveCamera();
    cam.updateMatrixWorld(true);
    view.set(cam);
    table.run(view, rows.length, { table: new StorageBufferAttribute(new Uint32Array(12 * 8), 1), args: new StorageBufferAttribute(new Uint32Array(15 * 8), 1) }, 0);
    const k = (table as unknown as { kernels: { select: unknown; outputs: unknown; rows: unknown } }).kernels;
    const select = computeWgsl(k.select);
    expect(select).toMatch(/atomicAdd/);
    expect(select).toMatch(/workgroup_size\( 64/);
    // Dispatched by size for any number of lists and rows: no early return at a thread count baked into the pass
    // (a node made with a count returns past it, which held the lists' counts and rows' arguments to the first 64).
    for (const pass of [k.select, k.outputs, k.rows]) expect(computeWgsl(pass)).not.toMatch(/if \( instanceIndex >= /);
    // Within WebGPU's default of 8 storage buffers a stage (a device asks for more only where an adapter has them).
    const storages = (wgsl: string): number => (wgsl.match(/var<storage/g) ?? []).length;
    for (const pass of [k.select, k.outputs, k.rows]) expect(storages(computeWgsl(pass))).toBeLessThanOrEqual(8);
    // The table's own passes too, with every row kind on (boxes, the far field's depth): the copies' counts ride in its rows.
    const occ = new InstanceOcclusion(wgslRenderer(), { drawing: 0, firstPass: () => true });
    const pyramid = { storage: () => new StorageBufferAttribute(new Float32Array(16), 1), generation: 0 };
    const kernel = (occ as unknown as { kernel(...a: unknown[]): unknown }).kernel.bind(occ);
    expect(storages(computeWgsl(kernel('late', pyramid, false, false, true, true, true)))).toBeLessThanOrEqual(8);
    expect(storages(computeWgsl(kernel('early', null, false, false, true)))).toBeLessThanOrEqual(8);
    occ.dispose();
    expect(computeWgsl(k.outputs)).toMatch(/atomicStore/);
    expect(computeWgsl(k.rows)).toMatch(/fn main/);
  });
});
