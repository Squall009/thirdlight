/**
 * Ground cover's point sets as rows of the culled-instance table: a point expanded into a copy's floats as the
 * vertex stage of the other path places it, the points the compute pass keeps against the rings' thinning (the
 * same points, ring by ring), and the set's places following the point atlas (only changed blocks written, taken
 * again when the atlas grows, nothing taken where the scene has no table).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { COVER_POINT_FLOATS, COVER_POINT_STEPS, coverPointAt, coverPointCopy, type CoverPointSet, type ScatterRule } from '@thirdlight/project-model';

import { INSTANCE_CULLER_KEY } from './attribute-instancing';
import type { CopyRowsSource } from './copy-rows';
import { COPY_ROW_FLOATS, selectCopy, type CopySelection } from './copy-rows-rule';
import { coverPointKept, coverShare, coverShareSteps, planCover } from './cover-placement';
import { COVER_POINT_BLOCK, CoverPointAtlas } from './cover-points-gpu';
import { CoverRows, writeCoverPointRow } from './cover-rows';
import type { InstanceSetPlan } from './instancing';
import { LodTuning } from './lod-switch';
import { CullView } from './view-cull';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';

const RULE = { id: 'grass', asset: { assetId: 'grass' }, density: 8, cover: true, coverDistance: 60, scale: [0.8, 1.3], align: 0.5, yaw: 360, sink: 0.05 } as unknown as ScatterRule;

/** A chunk set of `n` points on a 16 m square at (cx, cz): place, height, threshold, turn, size and a tilted normal from `i`. */
function pointSet(n: number, cx = 0, cz = 0): CoverPointSet {
  const data = new Float32Array(n * COVER_POINT_FLOATS);
  const rows: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const t = Math.floor((i * 255) / Math.max(1, n - 1));
    rows.push([((i * 977) % COVER_POINT_STEPS) + ((i * 1499) % COVER_POINT_STEPS) * COVER_POINT_STEPS, 0.5 + (i % 7) * 0.1, t + ((i * 37) % 256) * 256 + ((i * 91) % 256) * 65536, 120 + (i % 20) + (130 + (i % 9)) * 256]);
  }
  rows.forEach((r, i) => data.set(r, i * COVER_POINT_FLOATS));
  return { x0: cx * 16, z0: cz * 16, w: 16, d: 16, low: 0.5, high: 1.1, count: n, data };
}

describe('a point as a row of the culled-instance table', () => {
  it('is the copy the other path places: its place less the sink, its threshold as the rank, its turn and size', () => {
    const set = pointSet(40, 2, -1);
    const out = new Float32Array(COPY_ROW_FLOATS * 41);
    for (let i = 0; i < 41; i += 1) writeCoverPointRow(set, i, RULE, out, i * COPY_ROW_FLOATS);
    for (let i = 0; i < 40; i += 1) {
      const p = coverPointAt(set, i);
      const c = coverPointCopy(p, RULE);
      const row = [...out.subarray(i * COPY_ROW_FLOATS, (i + 1) * COPY_ROW_FLOATS)];
      const want = [p.x, p.y - 0.05, p.z, p.threshold, ...c.rotation, c.scale, c.scale, c.scale, 0, c.scale, 0, 0, 1];
      row.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 5));
      // Inside its chunk's square (the source's frame).
      expect(p.x >= 32 && p.x <= 48 && p.z >= -16 && p.z <= 0).toBe(true);
    }
    // Past the set's points: a copy of no size, which the pass never keeps.
    expect([...out.subarray(40 * COPY_ROW_FLOATS, 41 * COPY_ROW_FLOATS)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    const sel: CopySelection = { switches: [0], culls: false, toDistance: 1, hysteresis: 0.1, worldScale: 1, density: null, cover: { full: 60, reach: 60, min: 0 }, nearReach: null, ungrouped: false, levels: [true] };
    expect(selectCopy(sel, 5, 0, 0, true, 0, 0).levels).toEqual([]);
  });

  it('keeps the points the rings kept: a threshold under the cover\'s share at its distance across the ground', () => {
    const rule = { density: 8, scale: [0.8, 1.3] as [number, number] };
    for (const [reach, screenFull, min] of [[60, undefined, 0], [80, 21, 0.1], [30, undefined, 0.3]] as const) {
      const plan = planCover(rule, reach, { distances: [0], culls: false, radius: 0.3 }, 16, 1, screenFull);
      const sel: CopySelection = { switches: [0], culls: false, toDistance: 1, hysteresis: 0.1, worldScale: 1, density: null, cover: { ...plan.thinning, min }, nearReach: null, ungrouped: false, levels: [true] };
      const thinning = { ...plan.thinning, min };
      for (let i = 0; i < 4000; i += 1) {
        const d = (i * 0.0271) % (reach * 1.1);
        const threshold = ((i * 7919) % 256) / 256 + 0.5 / 256;
        // The eye 6 m up: the level's distance is the eye's, the thinning's across the ground.
        const rows = selectCopy(sel, Math.hypot(d, 6), 1, threshold, true, 0, 0, d).levels.length > 0;
        const rings = plan.rings.some((ring) => coverPointKept({ x: d, z: 0, threshold }, ring, thinning, [0, 0]));
        // The rings cut the reach without gaps and the share is 0 past it: the same points either way.
        expect(rows).toBe(rings);
      }
    }
  });

  it('thins by the same steps on the CPU and in the pass (one definition over the scalar ops)', () => {
    for (const t of [{ full: 60, reach: 60, min: 0 }, { full: 21, reach: 80, min: 0.1 }])
      for (let d = 0; d < 100; d += 0.37) expect(coverShareSteps(CPU_SCALAR_OPS, d, t.full, t.reach, t.min)).toBe(coverShare(t, d));
  });
});

/** The scene's table as a cover rule's rows see it: what it took and let go. */
function fakeTable(): { host: Record<string, unknown>; taken: CopyRowsSource[]; forgotten: CopyRowsSource[] } {
  const taken: CopyRowsSource[] = [];
  const forgotten: CopyRowsSource[] = [];
  const host = {
    adoptCopies: (src: CopyRowsSource) => (taken.push(src), true),
    forgetCopies: (src: CopyRowsSource) => void forgotten.push(src),
    copySets: { rowOf: () => ({}) },
    copyBuffers: () => ({}),
    drawCopies: () => undefined,
  };
  return { host, taken, forgotten };
}

function rowsFor(atlas: CoverPointAtlas, scene: THREE.Scene): CoverRows {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.1), new THREE.MeshBasicMaterial());
  const model = { parts: [{ mesh, local: new THREE.Matrix4(), lod: -1, level: 0 }], groups: [], radius: 0.3 } as unknown as InstanceSetPlan;
  return new CoverRows({
    name: 'test',
    rule: RULE,
    plan: planCover({ density: 8 }, 60, { distances: [0], culls: false, radius: 0.3 }, 16),
    model,
    atlas,
    tuning: new LodTuning(),
    origin: [10, 0, -5],
    place: (root, shown) => void (shown ? scene.add(root) : root.removeFromParent()),
    released: () => undefined,
  });
}

describe('a cover rule\'s point sets as one set of the table', () => {
  const view = (): CullView => {
    const v = new CullView();
    const cam = new THREE.PerspectiveCamera();
    cam.updateMatrixWorld(true);
    v.set(cam);
    return v;
  };

  it('is taken once the scene has a table; its places are the atlas\'s points, written block by block as sets come and go', () => {
    const scene = new THREE.Scene();
    const t = fakeTable();
    scene.userData[INSTANCE_CULLER_KEY] = t.host;
    const atlas = new CoverPointAtlas();
    const rows = rowsFor(atlas, scene);
    // Taken once a draw of the rings offers a scene with a table; in the scene from then on.
    expect(rows.update(view(), false)).toBe(false);
    expect(rows.offer(scene)).toBe(true);
    expect(rows.update(view(), false)).toBe(true);
    expect(rows.root.parent).toBe(scene);
    const src = t.taken[0]!;
    expect(src.count).toBe(atlas.capacity * COVER_POINT_BLOCK);
    expect(src.cover).toEqual(expect.objectContaining({ reach: 60 }));
    expect(src.world.elements[12]).toBe(10);
    // Nothing held yet: not shown (no rows listed).
    expect(src.shown()).toBe(false);
    const target = new Float32Array(src.count * COPY_ROW_FLOATS);
    expect(src.writeCopies(target, 0)).toBeNull();
    // A chunk's set of 300 points: two blocks; only they are written since the last version.
    const since = src.copiesVersion;
    const e = atlas.entry(1, 2, 0);
    atlas.store(e, pointSet(300, 1, 2));
    expect(src.copiesVersion).toBeGreaterThan(since);
    expect(src.shown()).toBe(true);
    const ranges = src.writeCopies(target, 0, since)!;
    const [a, b] = e.slots;
    const blocks = [a!, b!].sort((x, y) => x - y);
    expect(ranges.length).toBe(blocks[1] === blocks[0]! + 1 ? 2 : 4);
    expect(ranges[0]).toBe(blocks[0]! * COVER_POINT_BLOCK);
    // The second block holds points 256 … 299, then copies of no size.
    const at = (k: number): number => (e.slots[1]! * COVER_POINT_BLOCK + k) * COPY_ROW_FLOATS;
    expect(target[at(0)]).toBeCloseTo(coverPointAt(pointSet(300, 1, 2), 256).x, 5);
    expect(target[at(44) + 12]).toBe(0);
    // The set let go: its blocks written again as places of no size.
    const v2 = src.copiesVersion;
    atlas.forget(10_000);
    expect(src.writeCopies(target, 0, v2)!.length).toBeGreaterThan(0);
    expect(target[at(0) + 12]).toBe(0);
    rows.dispose();
    expect(t.forgotten.includes(src)).toBe(true);
  });

  it('is taken again at the new size when the atlas grows', () => {
    const scene = new THREE.Scene();
    const t = fakeTable();
    scene.userData[INSTANCE_CULLER_KEY] = t.host;
    const atlas = new CoverPointAtlas();
    const rows = rowsFor(atlas, scene);
    rows.offer(scene);
    rows.update(view(), false);
    const before = atlas.capacity;
    atlas.store(atlas.entry(0, 0, 0), pointSet((before + 1) * COVER_POINT_BLOCK));
    expect(atlas.capacity).toBeGreaterThan(before);
    rows.update(view(), false);
    expect(t.taken.length).toBe(2);
    expect(t.forgotten.length === 1 && t.forgotten[0] === t.taken[0]).toBe(true);
    expect(t.taken[1]!.count).toBe(atlas.capacity * COVER_POINT_BLOCK);
  });

  it('is not taken where the scene has no table (WebGL 2): the rule draws its rings; hidden, it leaves the scene', () => {
    const plain = new THREE.Scene();
    const rows = rowsFor(new CoverPointAtlas(), plain);
    expect(rows.offer(plain)).toBe(false);
    expect(rows.update(view(), false)).toBe(false);
    expect(rows.meshes()).toEqual([]);
    expect(rows.root.parent).toBeNull();
    const scene = new THREE.Scene();
    scene.userData[INSTANCE_CULLER_KEY] = fakeTable().host;
    const taken = rowsFor(new CoverPointAtlas(), scene);
    taken.offer(scene);
    taken.update(view(), false);
    expect(taken.root.parent).toBe(scene);
    taken.update(view(), true);
    expect(taken.root.parent).toBeNull();
  });
});
