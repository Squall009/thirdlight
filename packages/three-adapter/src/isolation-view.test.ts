/**
 * An edit mode's isolation: only the isolated objects' drawables stay on the
 * view's layer (the others leave it and the shadow cameras' too, and come
 * back to what a room hiding them says),
 * batches and merged cells are hidden whole while the isolated objects' own
 * meshes leave them, what belongs to no object (the sky, overlays) and the
 * lights stay, a drawable that leaves the scene while hidden comes back as it
 * was, and ending isolation restores every layer. Browser-free.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { BATCH_KEY, batchRefusal } from './batching';
import { IsolationView, VIEW_OWNER_KEY } from './isolation-view';
import { HIDDEN_BY_ROOM, hideFromView, OFF_VIEW_LAYER } from './view-hidden';

const mat = new THREE.MeshBasicMaterial();
const mesh = (): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), mat);

/** A drawable listed in the scene with its logical parent kept (as the render graph lists them). */
function listed(scene: THREE.Scene, o: THREE.Object3D, logicalParent: THREE.Object3D | null): THREE.Object3D {
  scene.add(o);
  if (logicalParent !== null) (o as { parent: THREE.Object3D | null }).parent = logicalParent;
  return o;
}

const inView = (o: THREE.Object3D): boolean => o.layers.isEnabled(0) && !o.layers.isEnabled(OFF_VIEW_LAYER);
/** Hidden from the view and the shadows (isolation). */
const hidden = (o: THREE.Object3D): boolean => !o.layers.isEnabled(0) && !o.layers.isEnabled(OFF_VIEW_LAYER);
/** Hidden from the view only, still casting (a room out of sight). */
const shadowOnly = (o: THREE.Object3D): boolean => !o.layers.isEnabled(0) && o.layers.isEnabled(OFF_VIEW_LAYER);

function setup() {
  const scene = new THREE.Scene();
  // Two entities' nodes (never in the scene), their meshes listed flat.
  const nodeA = new THREE.Group();
  nodeA.userData['entity'] = 'a';
  const nodeB = new THREE.Group();
  nodeB.userData['entity'] = 'b';
  const a = listed(scene, mesh(), nodeA);
  nodeA.children.push(a);
  const b = listed(scene, mesh(), nodeB);
  // A block layer's chunk: its group names the layer.
  const layerGroup = new THREE.Group();
  layerGroup.userData[VIEW_OWNER_KEY] = 'layer';
  const chunk = listed(scene, mesh(), layerGroup);
  // A batch drawing several objects, the sky and a light.
  const batch = listed(scene, mesh(), null);
  batch.userData['tlBatch'] = true;
  const sky = listed(scene, mesh(), null);
  const light = listed(scene, new THREE.DirectionalLight(), null);
  const regrouped: THREE.Object3D[] = [];
  const entityOf = (o: THREE.Object3D): string | null => {
    for (let x: THREE.Object3D | null = o; x !== null; x = x.parent) if (typeof x.userData['entity'] === 'string') return x.userData['entity'] as string;
    return null;
  };
  const shadows = { changed: 0 };
  const view = new IsolationView({ scene, entityOf, node: (id) => (id === 'a' ? nodeA : id === 'b' ? nodeB : undefined), regroup: (o) => void regrouped.push(o), shadowsChanged: () => void (shadows.changed += 1) });
  return { scene, a, b, chunk, batch, sky, light, view, regrouped, nodeA, shadows };
}

describe('IsolationView', () => {
  it('keeps only the isolated objects (and what belongs to none) in the view', () => {
    const s = setup();
    expect(s.view.set(new Set(['a']))).toBe(true);
    expect(s.view.set(new Set(['a']))).toBe(false);
    s.view.beforeBatch();
    expect(s.view.sweep()).toBe(true);
    expect(inView(s.a)).toBe(true);
    expect(hidden(s.b)).toBe(true);
    expect(hidden(s.chunk)).toBe(true);
    expect(hidden(s.batch)).toBe(true);
    expect(inView(s.sky)).toBe(true);
    expect(inView(s.light)).toBe(true);
    expect(s.view.diagnostics()).toMatchObject({ isolated: 1, hidden: 3 });
    expect(s.shadows.changed, 'the cached static shadow drawn again').toBe(1);
    // A second sweep changes nothing.
    expect(s.view.sweep()).toBe(false);
    expect(s.shadows.changed).toBe(1);
    // The block layer isolated instead: its chunk back, the box hidden.
    s.view.set(new Set(['layer']));
    s.view.sweep();
    expect(inView(s.chunk)).toBe(true);
    expect(hidden(s.a)).toBe(true);
    // Off: every layer as it was.
    s.view.set(null);
    for (const o of [s.a, s.b, s.chunk, s.batch, s.sky]) expect(inView(o)).toBe(true);
    expect(s.view.diagnostics().isolated).toBe(0);
    expect(s.shadows.changed).toBe(3);
  });

  it('gives a mesh a room hides back to the shadows only', () => {
    const s = setup();
    hideFromView(s.b, HIDDEN_BY_ROOM, true);
    expect(shadowOnly(s.b)).toBe(true);
    s.view.set(new Set(['a']));
    s.view.sweep();
    expect(hidden(s.b)).toBe(true);
    s.view.set(null);
    expect(shadowOnly(s.b), 'still out of the view for its room').toBe(true);
    hideFromView(s.b, HIDDEN_BY_ROOM, false);
    expect(inView(s.b)).toBe(true);
  });

  it("takes the isolated object's meshes out of batches while isolated, and gives them back", () => {
    const s = setup();
    s.a.userData[BATCH_KEY] = true;
    expect(batchRefusal(s.a as THREE.Mesh)).toBeNull();
    s.view.set(new Set(['a']));
    s.view.beforeBatch();
    expect(batchRefusal(s.a as THREE.Mesh)).toBe('isolated');
    expect(s.regrouped).toEqual([s.nodeA]);
    s.view.set(null);
    expect(batchRefusal(s.a as THREE.Mesh)).toBeNull();
    expect(s.regrouped).toEqual([s.nodeA, s.nodeA]);
  });

  it('brings back a hidden drawable that left the scene meanwhile', () => {
    const s = setup();
    s.view.set(new Set(['a']));
    s.view.sweep();
    expect(hidden(s.b)).toBe(true);
    s.scene.remove(s.b);
    s.view.sweep();
    expect(inView(s.b)).toBe(true);
    expect(s.view.diagnostics().hidden).toBe(2);
  });
});
