/**
 * The sun's shadow over a grid's shut openings: a closed surface over exactly the opening's cells (every edge shared
 * by two triangles, the box the cells fill), drawn by the shadow cameras only, cast into the static map with its
 * change reported where it stands, and gone when the opening is no longer shut.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chunkGrid, FloatingOrigin, VOXEL_SIZE_M } from '@thirdlight/voxel';

import { STATIC_CASTER_KEY } from './shadow-casters';
import { OFF_VIEW_LAYER } from './view-hidden';
import { openingCasterGeometry, VoxelPortalCasters } from './voxel-portal-casters';

/** A door's cells: x 5 … 7, y 1 … 5, z 0 (15 cells). */
const DOOR: number[] = [];
for (let x = 5; x <= 7; x++) for (let y = 1; y <= 5; y++) DOOR.push(x, y, 0);

describe('shut openings cast the sun’s shadow', () => {
  it('casts a closed surface over exactly the cells', () => {
    const made = openingCasterGeometry(DOOR)!;
    expect(made.lo).toEqual([5, 1, 0]);
    const pos = made.geometry.getAttribute('position');
    const idx = made.geometry.getIndex()!;
    // The 3 × 5 × 1 box's outer faces only: 2 (3·5 + 3·1 + 5·1) = 46 cell faces, two triangles each.
    expect(idx.count / 3).toBe(46 * 2);
    made.geometry.computeBoundingBox();
    const box = made.geometry.boundingBox!;
    expect(box.min.toArray()).toEqual([0, 0, 0]);
    expect(box.max.toArray().map((v) => v / VOXEL_SIZE_M)).toEqual([3, 5, 1]);
    // Closed: every edge is shared by exactly two triangles, once each way.
    const edges = new Map<string, number>();
    const key = (i: number): string => [pos.getX(i), pos.getY(i), pos.getZ(i)].map((v) => v.toFixed(4)).join(',');
    for (let t = 0; t < idx.count; t += 3) for (let e = 0; e < 3; e++) {
      const a = key(idx.getX(t + e));
      const b = key(idx.getX(t + ((e + 1) % 3)));
      edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
    }
    for (const [k, n] of edges) {
      const [a, b] = k.split('|');
      expect(n, k).toBe(1);
      expect(edges.get(`${b}|${a}`), `the edge ${k} back`).toBe(1);
    }
    expect(openingCasterGeometry([])).toBeNull();
  });

  it('draws in the shadow pass only, as a static caster, and reports where it came and went', () => {
    const grid = chunkGrid(32);
    const origin = new FloatingOrigin({ grid });
    const spheres: number[][] = [];
    let bumps = 0;
    const casters = new VoxelPortalCasters(origin, { changedWithin: (x, y, z, r) => spheres.push([x, y, z, r]), bump: () => bumps++ });
    const root = new THREE.Group();
    root.position.set(100, 0, -50);
    root.add(casters.root);
    root.updateMatrixWorld(true);
    casters.set([{ id: 'door', cells: DOOR }]);
    expect(casters.count).toBe(1);
    const mesh = casters.root.children[0] as THREE.Mesh;
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(false);
    // Not in the view's layer (0): only cameras that see the off-view layer draw it (the shadow cameras).
    const view = new THREE.Camera();
    expect(mesh.layers.test(view.layers)).toBe(false);
    view.layers.set(OFF_VIEW_LAYER);
    expect(mesh.layers.test(view.layers)).toBe(true);
    expect(mesh.userData[STATIC_CASTER_KEY]).toBe(true);
    // Reported at its place in the world: the middle of the 1.5 × 2.5 × 0.5 m box at cells (5, 1, 0) under the root.
    expect(spheres).toHaveLength(1);
    const [x, y, z, r] = spheres[0]!;
    expect([x, y, z].map((v) => Math.round(v! * 100) / 100)).toEqual([100 + 5 * VOXEL_SIZE_M + 0.75, VOXEL_SIZE_M + 1.25, -50 + 0.25]);
    expect(r).toBeGreaterThan(1.4);
    // The same set again: nothing made or reported; opened: gone, reported again.
    casters.set([{ id: 'door', cells: DOOR }]);
    expect(spheres).toHaveLength(1);
    casters.set([]);
    expect(casters.count).toBe(0);
    expect(casters.root.children).toHaveLength(0);
    expect(spheres).toHaveLength(2);
    expect(bumps).toBe(0);
    casters.dispose();
  });
});
