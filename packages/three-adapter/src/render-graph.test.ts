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
    expect(box.visible).toBe(false);
    graph.setHidden(new Set());
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
