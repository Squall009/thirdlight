import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { BATCH_KEY, createAutoBatcher } from './batching';
import { applyLodGroups } from './pieces';
import { RenderGraph } from './render-graph';
import { STATIC_KEY } from './static-merge';

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

describe('RenderGraph: a flat list that keeps what the hierarchy meant', () => {
  it('a node hidden in the file (visible = false) keeps the meshes below it out of the scene', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('prop', null);
    const { root, mesh } = fileTree();
    mesh.parent!.visible = false;
    const shown = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    root.add(shown);
    graph.nodeFor('prop')!.add(root);
    graph.update();
    expect(scene.children).toEqual([shown]);
    // And as an animated hierarchy.
    const g2 = new RenderGraph(new THREE.Scene(), () => true);
    g2.addEntity('walker', null);
    const t = fileTree();
    t.mesh.parent!.visible = false;
    g2.nodeFor('walker')!.add(t.root);
    expect(g2.counts().listed).toBe(0);
  });

  it('a mesh added later deeper into a shown model is drawn, and leaves with what it was added to', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('prop', null);
    graph.world.setLocal('prop', [5, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const { root, mesh } = fileTree();
    graph.nodeFor('prop')!.add(root);
    graph.update();
    expect(scene.children).toEqual([mesh]);
    // A late attachment inside the file's group (a socketed prop, a part loaded on demand).
    const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    late.position.set(0, 0, 2);
    const holder = new THREE.Group();
    holder.add(late);
    mesh.parent!.add(holder);
    expect(scene.children).toContain(late);
    // Placed by the entity and the file's offsets: prop (5,0,0) ∘ inner (0,1,0) ∘ late (0,0,2).
    near(new THREE.Vector3().setFromMatrixPosition(late.matrixWorld), [5, 1, 2]);
    // Removed again: out of the scene; the rest stays.
    holder.removeFromParent();
    expect(scene.children).toEqual([mesh]);
    // A mesh of the original file removed from its group leaves too.
    mesh.removeFromParent();
    expect(scene.children).toEqual([]);
  });

  it('an entity whose animator starts after it was shown is posed from then on (its offsets are not baked)', () => {
    const scene = new THREE.Scene();
    let animated = false;
    const graph = new RenderGraph(scene, () => animated);
    graph.addEntity('door', null);
    graph.world.setLocal('door', [0, 0, 3], [0, 0, 0, 1], [1, 1, 1]);
    const { root, mesh } = fileTree();
    graph.nodeFor('door')!.add(root);
    graph.update();
    // Its animator's poses arrive: the mixer moves a node inside the file.
    animated = true;
    graph.ensureAnimated('door');
    mesh.position.set(0, 0, 1);
    graph.poseAnimated();
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

  it('a model whose LOD nodes sit under a scaled unit node switches where the same model unscaled does, moved out by the object scale only', () => {
    /** The model as a file holds it: `unit` scales `size`-metre LOD nodes to the same 1 m box either way. */
    const model = (unit: number): THREE.Group => {
      const root = new THREE.Group();
      const holder = new THREE.Group();
      holder.scale.setScalar(unit);
      for (const n of [0, 1]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1 / unit, 1 / unit, 1 / unit), new THREE.MeshBasicMaterial());
        m.name = `Box_LOD${n}`;
        holder.add(m);
      }
      root.add(holder);
      expect(applyLodGroups(root)).toBe(1);
      return root;
    };
    /** Where level 1 takes over for a model placed at `objectScale`, found by walking the camera out. */
    const switchAt = (unit: number, objectScale: number): { at: number; levelDistance: number } => {
      const scene = new THREE.Scene();
      const graph = new RenderGraph(scene, () => false);
      graph.addEntity('m', null);
      graph.world.setLocal('m', [0, 0, 0], [0, 0, 0, 1], [objectScale, objectScale, objectScale]);
      const root = model(unit);
      let lod: THREE.LOD | null = null;
      root.traverse((o) => {
        if ((o as THREE.LOD).isLOD === true) lod = o as THREE.LOD;
      });
      graph.nodeFor('m')!.add(root);
      graph.update();
      const camera = new THREE.PerspectiveCamera();
      const lod0 = lod!.levels[0]!.object;
      for (let z = 0.5; z < 1000; z += 0.25) {
        camera.position.set(0, 0, z);
        graph.updateLods(camera);
        if (!scene.children.includes(lod0 as THREE.Mesh)) return { at: z, levelDistance: lod!.levels[1]!.distance };
      }
      return { at: Number.NaN, levelDistance: lod!.levels[1]!.distance };
    };
    const flat = switchAt(1, 1);
    const unitScaled = switchAt(0.01, 1);
    expect(flat.at).toBeGreaterThan(1);
    // The 0.01 unit node is not counted a second time: the same switch point.
    expect(unitScaled.at).toBe(flat.at);
    expect(unitScaled.levelDistance).toBeCloseTo(flat.levelDistance, 6);
    // The object's scale moves it out (twice the size: twice as far), as an instance-set copy's level distance × its scale.
    const doubled = switchAt(0.01, 2);
    expect(doubled.at).toBeGreaterThanOrEqual(2 * unitScaled.levelDistance);
    expect(doubled.at).toBeLessThan(2 * unitScaled.levelDistance + 0.25 + 1e-9);
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

describe('RenderGraph and the batcher: regroup only on a change', () => {
  it('an idle frame regroups and copies nothing; a move, a hide and a LOD switch touch only that member', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    const batcher = createAutoBatcher(scene);
    graph.setMembership(batcher);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 10);
    const nearGeo = new THREE.BoxGeometry();
    const farGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const mat = new THREE.MeshBasicMaterial();
    const other = new THREE.MeshBasicMaterial();
    const levels: THREE.Mesh[][] = [];
    for (let i = 0; i < 5; i += 1) {
      // A tree with two levels, and a plain box of another material beside it.
      graph.addEntity(`tree${i}`, null);
      graph.world.setLocal(`tree${i}`, [i * 2, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      const lod = new THREE.LOD();
      const a = new THREE.Mesh(nearGeo, mat);
      const f = new THREE.Mesh(farGeo, mat);
      a.userData[BATCH_KEY] = true;
      f.userData[BATCH_KEY] = true;
      lod.addLevel(a, 0);
      lod.addLevel(f, 30);
      graph.nodeFor(`tree${i}`)!.add(lod);
      levels.push([a, f]);
      graph.addEntity(`box${i}`, null);
      graph.world.setLocal(`box${i}`, [i * 2, 3, 0], [0, 0, 0, 1], [1, 1, 1]);
      const box = new THREE.Mesh(nearGeo, other);
      box.userData[BATCH_KEY] = true;
      graph.nodeFor(`box${i}`)!.add(box);
    }
    const frame = (): [number, number] => {
      graph.update();
      graph.updateLods(camera);
      batcher.update(camera);
      const d = batcher.diagnostics();
      return [d.regroups, d.matrixCopies];
    };
    frame();
    expect(batcher.diagnostics()).toMatchObject({ groups: 2, batched: 10 });
    // Idle: nothing.
    expect(frame()).toEqual([0, 0]);
    expect(frame()).toEqual([0, 0]);
    // One tree moves: its matrix only.
    graph.world.setLocal('tree1', [2, 1, 0], [0, 0, 0, 1], [1, 1, 1]);
    expect(frame()).toEqual([0, 1]);
    expect(frame()).toEqual([0, 0]);
    // One box hidden: its group regroups (the last box takes its slot), the trees' does not.
    graph.setHidden(new Set(['box2']));
    expect(frame()).toEqual([1, 1]);
    expect(batcher.diagnostics()).toMatchObject({ groups: 2, batched: 9 });
    // One tree goes far: its far level is attached, its near level leaves (two groups: near and far), nothing else.
    graph.world.setLocal('tree3', [6, 0, -100], [0, 0, 0, 1], [1, 1, 1]);
    const [regroups, copies] = frame();
    expect(regroups).toBe(2);
    expect(copies).toBeLessThanOrEqual(2);
    expect(levels[3]![1]!.parent).not.toBeNull();
    expect(scene.children).toContain(levels[3]![1]!);
    expect(scene.children).not.toContain(levels[3]![0]!);
    expect(batcher.diagnostics()).toMatchObject({ groups: 2, batched: 8, single: 1 });
    expect(frame()).toEqual([0, 0]);
  });
});

describe('RenderGraph and static batching', () => {
  it('merges static placements per material with every LOD level; members drawn through batches leave the scene but stay pickable', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    const batcher = createAutoBatcher(scene, { park: (o, on) => graph.park(o, on) });
    graph.setMembership(batcher);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 10);
    const mat = new THREE.MeshBasicMaterial();
    const nears: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i += 1) {
      // Distinct models (no instancing partner) sharing one material, two levels each.
      graph.addEntity(`prop${i}`, null);
      graph.world.setLocal(`prop${i}`, [i * 2, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      const lod = new THREE.LOD();
      const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1 + i * 0.1, 1), mat);
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9 + i * 0.1, 0.9), mat);
      for (const m of [a, f]) {
        m.userData[BATCH_KEY] = true;
        m.userData[STATIC_KEY] = 'scene-main';
      }
      lod.addLevel(a, 0);
      lod.addLevel(f, 30);
      graph.nodeFor(`prop${i}`)!.add(lod);
      nears.push(a);
    }
    const frame = (): void => {
      graph.update();
      graph.updateLods(camera);
      batcher.update(camera);
    };
    frame();
    const merged = scene.children.filter((o) => o.name.startsWith('tl-merged:')) as THREE.Mesh[];
    expect(merged.length).toBe(1);
    // Both levels of all three copied; the near ones drawn.
    expect(batcher.diagnostics().merging).toMatchObject({ cells: 1, merged: 3, slots: 6 });
    expect(merged[0]!.geometry.drawRange.count).toBe(3 * 36);
    // The members are out of the scene's children, and still what a ray picks.
    for (const a of nears) expect(scene.children).not.toContain(a);
    const picks = graph.pickables();
    for (const a of nears) expect(picks).toContain(a);
    // A hidden prop leaves the draw (and comes back into nothing: it is not drawn at all).
    graph.setHidden(new Set(['prop1']));
    frame();
    expect(merged[0]!.geometry.drawRange.count).toBe(2 * 36);
    expect(graph.pickables()).not.toContain(nears[1]);
    // The camera backs off: every prop draws its far level, from the same copy (the index only, no build).
    const builds = batcher.diagnostics().merging!.buildsTotal;
    camera.position.set(0, 0, 200);
    frame();
    expect(batcher.diagnostics().merging).toMatchObject({ buildsTotal: builds, merged: 2 });
    expect(merged[0]!.geometry.drawRange.count).toBe(2 * 36);
    // One that moves leaves the merged draw (drawn on its own until it stays put).
    graph.world.setLocal('prop2', [4, 0, 1], [0, 0, 0, 1], [1, 1, 1]);
    frame();
    expect(merged[0]!.geometry.drawRange.count).toBe(36);
    expect(scene.children.filter((o) => (o as THREE.Mesh).isMesh === true && !o.name.startsWith('tl-merged:')).length).toBe(1);
    // Gone for good: the copies go.
    graph.removeEntity('prop0');
    graph.removeEntity('prop1');
    graph.removeEntity('prop2');
    frame();
    expect(scene.children).toEqual([]);
    expect(batcher.diagnostics().merging!.slots).toBe(0);
  });
});
