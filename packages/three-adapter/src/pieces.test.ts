/**
 * Multi-piece GLBs by node name: pieces, LOD groups, `_COL` colliders and the
 * vertex-colour mode (2026-09-24).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  applyLodGroups,
  applyVertexColorMode,
  convexHull,
  keepOnlyPiece,
  modelPieces,
  pieceBounds,
  pieceCollider2D,
  stripCollisionNodes,
} from './pieces';

const material = new THREE.MeshStandardMaterial();

function boxMesh(name: string, w: number, h: number, colors = true): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, 1).translate(w / 2, h / 2, 0);
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.getAttribute('position').count * 4).fill(1), 4));
  const m = new THREE.Mesh(g, material);
  m.name = name;
  return m;
}

function kit(): THREE.Group {
  const root = new THREE.Group();
  root.add(boxMesh('rock_LOD0', 1, 1), boxMesh('rock_LOD1', 1, 1), boxMesh('rock_LOD2', 1, 1), boxMesh('rock_COL', 1, 1, false));
  root.add(boxMesh('bush_LOD0', 2, 0.5), boxMesh('bush_COL', 2, 0.5, false));
  root.add(boxMesh('flower', 0.5, 1.5));
  root.add(boxMesh('orphan_COL', 1, 1, false));
  return root;
}

describe('modelPieces', () => {
  it('groups top-level nodes by base name; a COL-only group is not a piece', () => {
    const pieces = modelPieces(kit());
    expect(pieces.map((p) => [p.name, p.lods, p.collider?.name ?? null])).toEqual([
      ['rock', 3, 'rock_COL'],
      ['bush', 1, 'bush_COL'],
      ['flower', 1, null],
    ]);
  });

  it('keepOnlyPiece keeps one piece (render and collision nodes); an unknown piece is refused', () => {
    const root = kit();
    expect(keepOnlyPiece(root, 'bush')).toBe(true);
    expect(root.children.map((c) => c.name)).toEqual(['bush_LOD0', 'bush_COL']);
    expect(keepOnlyPiece(kit(), 'tree')).toBe(false);
  });

  it('stripCollisionNodes removes every _COL node', () => {
    const root = kit();
    stripCollisionNodes(root);
    expect(root.children.map((c) => c.name)).toEqual(['rock_LOD0', 'rock_LOD1', 'rock_LOD2', 'bush_LOD0', 'flower']);
  });
});

describe('applyLodGroups', () => {
  it('turns sibling _LOD<n> nodes into one THREE.LOD with growing distances and switches by camera distance', () => {
    const root = kit();
    stripCollisionNodes(root);
    expect(applyLodGroups(root)).toBe(1);
    const lod = root.children.find((c) => (c as THREE.LOD).isLOD === true) as THREE.LOD;
    expect(lod.name).toBe('rock_LOD');
    expect(lod.levels.map((l) => l.object.name)).toEqual(['rock_LOD0', 'rock_LOD1', 'rock_LOD2']);
    const d = lod.levels.map((l) => l.distance);
    expect(d[0]).toBe(0);
    expect(d[1]!).toBeGreaterThan(0);
    expect(d[2]!).toBeGreaterThan(d[1]!);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const at = (z: number): string => {
      camera.position.set(0, 0, z);
      camera.updateMatrixWorld(true);
      root.updateMatrixWorld(true);
      lod.update(camera);
      return lod.levels.find((l) => l.object.visible)!.object.name;
    };
    expect(at(1)).toBe('rock_LOD0');
    expect(at((d[1]! + d[2]!) / 2)).toBe('rock_LOD1');
    expect(at(d[2]! * 2)).toBe('rock_LOD2');
    // Single-level pieces are left alone.
    expect(root.children.some((c) => c.name === 'bush_LOD0')).toBe(true);
  });
});

describe('vertex colours', () => {
  it('data (default) turns vertexColors off; tint turns it on', () => {
    const root = kit();
    material.vertexColors = true;
    applyVertexColorMode(root, 'data');
    expect(material.vertexColors).toBe(false);
    applyVertexColorMode(root, 'tint');
    expect(material.vertexColors).toBe(true);
    applyVertexColorMode(root, 'data');
  });
});

describe('2D colliders', () => {
  it('a _COL box becomes its convex outline on the XY plane, counter-clockwise, in the file space', () => {
    expect(pieceCollider2D(kit(), 'rock')).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(pieceCollider2D(kit(), 'bush')).toEqual([[0, 0], [2, 0], [2, 0.5], [0, 0.5]]);
    expect(pieceCollider2D(kit(), 'flower')).toBeNull();
  });

  it('the whole file uses its single _COL; several make it ambiguous (null)', () => {
    const one = new THREE.Group();
    one.add(boxMesh('hero_LOD0', 1, 2), boxMesh('hero_COL', 1, 2, false));
    one.children[1]!.position.set(0.5, 0, 0);
    expect(pieceCollider2D(one, null)).toEqual([[0.5, 0], [1.5, 0], [1.5, 2], [0.5, 2]]);
    expect(pieceCollider2D(kit(), null)).toBeNull();
  });

  it('a round outline is reduced to at most 8 vertices', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 64; i += 1) pts.push([Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2)]);
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(([x, y]) => [x, y, 0]), 3));
    const root = new THREE.Group();
    const col = new THREE.Mesh(g, material);
    col.name = 'disc_COL';
    const vis = boxMesh('disc_LOD0', 1, 1);
    root.add(vis, col);
    const hull = pieceCollider2D(root, 'disc')!;
    expect(hull.length).toBeLessThanOrEqual(8);
    expect(hull.length).toBeGreaterThanOrEqual(6);
    expect(convexHull(hull)).toEqual(hull);
  });
});

describe('pieceBounds', () => {
  it('uses LOD0 only and ignores _COL', () => {
    const root = kit();
    root.getObjectByName('rock_LOD1')!.scale.set(5, 5, 5);
    const b = pieceBounds(root, 'rock');
    expect(b.min.toArray()).toEqual([0, 0, -0.5]);
    expect(b.max.toArray()).toEqual([1, 1, 0.5]);
  });
});
