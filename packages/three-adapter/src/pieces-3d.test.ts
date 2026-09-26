/**
 * Phase 23.1: 3D colliders from a model — a triangle mesh or a convex hull
 * from a piece's `_COL` node, else its LOD0 geometry (the `_COL` and higher
 * levels skipped), in the file's root space on a 1 mm grid; refused with a
 * reason when too big for a mesh, flat for a hull, or beyond 64 m.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { pieceCollider3D } from './pieces';

function node(name: string, geometry: THREE.BufferGeometry, at: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const m = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  m.name = name;
  m.position.set(...at);
  return m;
}

describe('pieceCollider3D', () => {
  it('a piece with a `_COL` box: a mesh of its 8 corners and 12 triangles, or a hull of the corners (in root space)', () => {
    const root = new THREE.Group();
    root.add(node('crate_LOD0', new THREE.SphereGeometry(1, 32, 16)), node('crate_LOD1', new THREE.SphereGeometry(1, 8, 4)), node('crate_COL', new THREE.BoxGeometry(2, 1, 2), [0, 0.5, 0]));
    const mesh = pieceCollider3D(root, 'crate', 'mesh');
    expect(mesh.ok && mesh.source).toBe('collision');
    if (!mesh.ok || mesh.shape.type !== 'mesh') throw new Error('mesh');
    expect(mesh.shape.vertices).toHaveLength(8);
    expect(mesh.shape.triangles).toHaveLength(12);
    expect(mesh.shape.vertices).toContainEqual([1, 1, 1]);
    expect(mesh.shape.vertices).toContainEqual([-1, 0, -1]);
    const hull = pieceCollider3D(root, 'crate', 'convex');
    if (!hull.ok || hull.shape.type !== 'convex') throw new Error('hull');
    expect(hull.shape.points).toHaveLength(8);
  });

  it('without `_COL`: the LOD0 geometry (not the higher levels); a detailed mesh is refused with a hint, its hull kept to 64 extreme points', () => {
    const root = new THREE.Group();
    root.add(node('rock_LOD0', new THREE.SphereGeometry(1, 48, 32)), node('rock_LOD1', new THREE.BoxGeometry(10, 10, 10)));
    const mesh = pieceCollider3D(root, 'rock', 'mesh');
    expect(mesh.ok).toBe(false);
    expect(!mesh.ok && mesh.message).toMatch(/_COL/);
    const hull = pieceCollider3D(root, 'rock', 'convex');
    if (!hull.ok || hull.shape.type !== 'convex') throw new Error('hull');
    expect(hull.source).toBe('geometry');
    expect(hull.shape.points.length).toBeLessThanOrEqual(64);
    expect(hull.shape.points.length).toBeGreaterThan(20);
    // The sphere (radius 1), not the 10 m LOD1 box.
    for (const p of hull.shape.points) expect(Math.hypot(...p)).toBeLessThan(1.01);
    // The six axis extremes are kept.
    expect(Math.max(...hull.shape.points.map((p) => p[1]))).toBeCloseTo(1, 3);
  });

  it('a flat model makes no hull; a model beyond 64 m makes no collider', () => {
    const flat = new THREE.Group();
    flat.add(node('floor', new THREE.PlaneGeometry(4, 4)));
    expect(pieceCollider3D(flat, null, 'convex').ok).toBe(false);
    const quad = pieceCollider3D(flat, null, 'mesh');
    expect(quad.ok && quad.shape.type === 'mesh' && quad.shape.triangles.length).toBe(2);
    const far = new THREE.Group();
    far.add(node('tower', new THREE.BoxGeometry(1, 1, 1), [0, 80, 0]));
    expect(pieceCollider3D(far, null, 'mesh')).toMatchObject({ ok: false });
  });
});
