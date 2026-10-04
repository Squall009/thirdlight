import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { RenderGraph } from './render-graph';

const near = (a: THREE.Vector3, b: [number, number, number]): void => {
  expect(a.x).toBeCloseTo(b[0], 9);
  expect(a.y).toBeCloseTo(b[1], 9);
  expect(a.z).toBeCloseTo(b[2], 9);
};

/** A model file's shape: a root, an empty group with an offset, a mesh inside it. */
function fileTree(): { root: THREE.Group; mesh: THREE.Mesh } {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.set(0, 1, 0);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.set(1, 0, 0);
  inner.add(mesh);
  root.add(inner);
  return { root, mesh };
}

describe('RenderGraph', () => {
  it('lists only drawables in the scene, placed by the entity world matrix and the baked file offset', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('parent', null);
    graph.addEntity('child', 'parent');
    graph.addEntity('marker', 'parent');
    graph.world.setLocal('parent', [10, 0, 0], [0, 0, 0, 1], [2, 2, 2]);
    graph.world.setLocal('child', [0, 0, 5], [0, 0, 0, 1], [1, 1, 1]);
    const { root, mesh } = fileTree();
    graph.nodeFor('child')!.add(root);
    graph.update();
    // The scene holds the mesh alone: no entity, holder or file group.
    expect(scene.children).toEqual([mesh]);
    expect(mesh.parent?.parent).toBe(root);
    expect(graph.node('marker')).toBeUndefined();
    expect(graph.counts()).toMatchObject({ objects: 1, drawables: 1, containers: 0, entities: 1, listed: 1 });
    // parent (10,0,0)·2 ∘ child (0,0,5) ∘ inner (0,1,0) ∘ mesh (1,0,0)
    near(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld), [12, 2, 10]);
    // Moving the parent moves the drawable at the next update.
    graph.world.setLocal('parent', [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    graph.update();
    near(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld), [1, 1, 5]);
    // A three update of the scene keeps the written matrix.
    scene.updateMatrixWorld(true);
    near(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld), [1, 1, 5]);
  });

  it('hides an entity with its children, and gives a removed subtree back as it was', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('a', null);
    graph.addEntity('b', 'a');
    const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    graph.nodeFor('b')!.add(box);
    graph.update();
    const hidden = graph.setHidden(new Set(['a']));
    expect(hidden.has('b')).toBe(true);
    expect(scene.children).toEqual([]);
    graph.setHidden(new Set());
    expect(scene.children).toEqual([box]);
    expect(box.visible).toBe(true);
    box.removeFromParent();
    expect(scene.children).toEqual([]);
    expect(box.matrixAutoUpdate).toBe(true);
    expect(box.matrixWorldAutoUpdate).toBe(true);
  });

  it('keeps an animated hierarchy outside the scene and poses it after the animation step', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, (id) => id === 'walker');
    graph.addEntity('walker', null);
    graph.world.setLocal('walker', [0, 0, 3], [0, 0, 0, 1], [1, 1, 1]);
    const { root, mesh } = fileTree();
    graph.nodeFor('walker')!.add(root);
    graph.update();
    // The mixer moves a node inside the file.
    mesh.position.set(0, 0, 1);
    graph.poseAnimated();
    scene.updateMatrixWorld();
    expect(scene.children).toEqual([mesh]);
    near(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld), [0, 1, 4]);
  });
});

describe('RenderGraph: only what moved, one LOD level, flat model files', () => {
  it('writes no matrix while nothing moves, and only the moved entity and its children when one does', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    for (const [id, parent] of [['a', null], ['a1', 'a'], ['b', null]] as const) {
      graph.addEntity(id, parent);
      graph.nodeFor(id)!.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    }
    graph.update();
    for (let f = 0; f < 3; f += 1) {
      for (const id of ['a', 'a1', 'b']) graph.world.setLocal(id, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      graph.update();
      expect(graph.counts().matrixWrites).toEqual({ entities: 0, drawables: 0, posed: 0 });
    }
    const total = graph.counts().matrixWritesTotal;
    graph.world.setLocal('a', [0, 2, 0], [0, 0, 0, 1], [1, 1, 1]);
    graph.update();
    expect(graph.counts().matrixWrites).toEqual({ entities: 2, drawables: 2, posed: 0 });
    expect(graph.counts().matrixWritesTotal).toBe(total + 4);
    near(new THREE.Vector3().setFromMatrixPosition((graph.node('a1')!.children[0] as THREE.Mesh).matrixWorld), [0, 2, 0]);
  });

  it('attaches only the level a LOD draws, switching where three would, and nothing else of it', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('tree', null);
    graph.world.setLocal('tree', [0, 0, -5], [0, 0, 0, 1], [1, 1, 1]);
    const holder = new THREE.Group();
    const lod = new THREE.LOD();
    lod.position.set(0, 0, -5);
    const near0 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const far = new THREE.Group();
    const far1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const far2 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    far.add(far1, far2);
    lod.addLevel(near0, 0);
    lod.addLevel(far, 20);
    holder.add(lod);
    graph.nodeFor('tree')!.add(holder);
    graph.update();
    // The LOD sits at z = -10 in the world; the camera walks out along +z.
    const camera = new THREE.PerspectiveCamera();
    const at = (z: number): void => {
      camera.position.set(0, 0, z);
      graph.updateLods(camera);
    };
    at(0);
    expect(scene.children).toEqual([near0]);
    at(9.9);
    expect(scene.children).toEqual([near0]);
    at(10);
    expect(new Set(scene.children)).toEqual(new Set([far1, far2]));
    const c = graph.counts();
    expect(c).toMatchObject({ objects: 2, drawables: 2, lods: 0, containers: 0, lodSwitches: 1, listed: 2, unattached: 1 });
    at(0);
    expect(scene.children).toEqual([near0]);
    // The level's world matrix was written while it was not attached.
    near(new THREE.Vector3().setFromMatrixPosition(far1.matrixWorld), [0, 0, -10]);
    holder.removeFromParent();
    expect(scene.children).toEqual([]);
    expect(graph.counts().lodSwitches).toBe(0);
  });

  it("moves a static mesh's child nodes beside it (their offset baked) and puts them back when the model leaves", () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('house', null);
    graph.world.setLocal('house', [10, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const root = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    walls.position.set(0, 1, 0);
    walls.scale.set(2, 2, 2);
    const door = new THREE.Group();
    door.position.set(0, 0, 1);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    knob.position.set(0.5, 0, 0);
    door.add(knob);
    const empty = new THREE.Object3D();
    walls.add(door, empty);
    root.add(walls);
    graph.nodeFor('house')!.add(root);
    graph.update();
    // Only the two meshes, each without children, are in the scene.
    expect(new Set(scene.children)).toEqual(new Set([walls, knob]));
    expect(walls.children.length).toBe(0);
    expect(graph.counts()).toMatchObject({ objects: 2, containers: 0 });
    // house (10,0,0) ∘ walls (0,1,0)·2 ∘ door (0,0,1) ∘ knob (0.5,0,0)
    near(new THREE.Vector3().setFromMatrixPosition(knob.matrixWorld), [11, 1, 2]);
    root.removeFromParent();
    expect(walls.children.length).toBe(2);
    expect(walls.children[0]).toBe(door);
    expect(walls.children[1]).toBe(empty);
    expect(door.matrixAutoUpdate).toBe(true);
    door.updateMatrix();
    near(new THREE.Vector3().setFromMatrixPosition(door.matrix), [0, 0, 1]);
  });
});
