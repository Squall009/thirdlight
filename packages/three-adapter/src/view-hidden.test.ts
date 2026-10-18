/**
 * What occlusion culling may test: the reasons decided before it (a
 * cut-away, the rooms' portals, an edit mode's isolation) are never tested
 * again, what occlusion itself hid is asked again, and a model's `_OCC`
 * stand-in fills the depth only while its own surfaces are drawn. What a
 * host works on (an editor's selection, an edited object) is never tested,
 * the batch or merged cell drawing it included; what a host draws for itself
 * is no occludee; the culled draws' overlay draws each box's 12 edges.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { VIEW_OWNER_KEY } from './isolation-view';
import { markHostDrawing, occludeeKindOf, OccludeeRegistry } from './occludees';
import { applyModelOccluders, standinFollowsSurfaces } from './occluders';
import { OcclusionKeep } from './occlusion-keep';
import { boxEdgeVertices } from './occlusion-overlay';
import { HIDDEN_BEFORE_OCCLUSION, HIDDEN_BY_CUTAWAY, HIDDEN_BY_ISOLATION, HIDDEN_BY_OCCLUSION, HIDDEN_BY_ROOM, hideFromView, keepFromOcclusion, keptFromOcclusion, occlusionMayTest } from './view-hidden';

const mesh = (name = 'm'): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial());
  m.name = name;
  return m;
};

describe('the order of culling', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);

  it('never tests what a cut-away, the rooms or isolation hid, and asks again what occlusion hid', () => {
    expect(HIDDEN_BEFORE_OCCLUSION).toBe(HIDDEN_BY_CUTAWAY | HIDDEN_BY_ROOM | HIDDEN_BY_ISOLATION);
    const m = mesh();
    expect(occlusionMayTest(m, camera)).toBe(true);
    for (const reason of [HIDDEN_BY_CUTAWAY, HIDDEN_BY_ROOM, HIDDEN_BY_ISOLATION]) {
      hideFromView(m, reason, true);
      expect(occlusionMayTest(m, camera), `hidden by ${reason}`).toBe(false);
      // Hidden by occlusion as well (a room shut while its draw was culled): still not tested.
      hideFromView(m, HIDDEN_BY_OCCLUSION, true);
      expect(occlusionMayTest(m, camera), `hidden by ${reason} and occlusion`).toBe(false);
      hideFromView(m, reason, false);
      // Occlusion's own hiding left: asked again (off the view's layer only because of it).
      expect(m.layers.isEnabled(0)).toBe(false);
      expect(occlusionMayTest(m, camera), `shown again by ${reason}, still hidden by occlusion`).toBe(true);
      hideFromView(m, HIDDEN_BY_OCCLUSION, false);
      expect(occlusionMayTest(m, camera)).toBe(true);
    }
    // Not drawn at all, or on a layer the view does not see.
    m.visible = false;
    expect(occlusionMayTest(m, camera)).toBe(false);
    m.visible = true;
    m.layers.set(5);
    expect(occlusionMayTest(m, camera)).toBe(false);
  });

  it('draws a stand-in only while one of its surfaces drawn on its own is shown', () => {
    const root = new THREE.Group();
    const hedge0 = mesh('hedge_LOD0');
    const hedge1 = mesh('hedge_LOD1');
    const occ = mesh('hedge_OCC');
    occ.scale.setScalar(0.5);
    const rock = mesh('rock');
    rock.position.x = 3;
    root.add(hedge0, hedge1, occ, rock);
    expect(applyModelOccluders(root)).toEqual({ standins: 1, dropped: 0 });
    // In the scene now: the near level only (the far one is unattached).
    const inScene = new Set<THREE.Object3D>([hedge0, rock]);
    const drawn = (o: THREE.Object3D): boolean => inScene.has(o);
    expect(standinFollowsSurfaces(occ, drawn)).toBe(true);
    // Its piece's level in the scene hidden by the rooms (or a cut-away, or isolation): the stand-in follows.
    for (const reason of [HIDDEN_BY_ROOM, HIDDEN_BY_CUTAWAY, HIDDEN_BY_ISOLATION]) {
      hideFromView(hedge0, reason, true);
      expect(standinFollowsSurfaces(occ, drawn), `surface hidden by ${reason}`).toBe(false);
      hideFromView(hedge0, reason, false);
    }
    // Another piece hidden does not matter; the unattached level's state does not either.
    hideFromView(rock, HIDDEN_BY_ROOM, true);
    hideFromView(hedge1, HIDDEN_BY_ROOM, true);
    expect(standinFollowsSurfaces(occ, drawn)).toBe(true);
    // Occlusion's own hiding of a surface is not a reason (the depth it fills is what culls it).
    hideFromView(hedge0, HIDDEN_BY_OCCLUSION, true);
    expect(standinFollowsSurfaces(occ, drawn)).toBe(true);
    // Its surfaces parked in a batch (none drawn on its own): its own hiding decides.
    inScene.clear();
    expect(standinFollowsSurfaces(occ, drawn)).toBe(true);
    hideFromView(occ, HIDDEN_BY_ROOM, true);
    expect(standinFollowsSurfaces(occ, drawn)).toBe(false);
  });

  it('never tests what a host keeps, and tests it again once let go', () => {
    const m = mesh();
    expect(keepFromOcclusion(m, true)).toBe(true);
    expect(keepFromOcclusion(m, true)).toBe(false);
    expect(occlusionMayTest(m, camera)).toBe(false);
    // Kept while occlusion had hidden it (a draw selected behind a wall): still not tested, so every path draws it.
    hideFromView(m, HIDDEN_BY_OCCLUSION, true);
    expect(occlusionMayTest(m, camera)).toBe(false);
    hideFromView(m, HIDDEN_BY_OCCLUSION, false);
    expect(keepFromOcclusion(m, false)).toBe(true);
    expect(occlusionMayTest(m, camera)).toBe(true);
  });
});

describe('what a host works on and draws itself', () => {
  const nodes = new Map<string, THREE.Object3D>();
  const node = (id: string): THREE.Group => {
    const g = new THREE.Group();
    g.userData['entity'] = id;
    nodes.set(id, g);
    return g;
  };
  const entityOf = (o: THREE.Object3D): string | null => {
    for (let x: THREE.Object3D | null = o; x !== null; x = x.parent) if (typeof x.userData['entity'] === 'string') return x.userData['entity'] as string;
    return null;
  };

  it('keeps the draws of the objects named: their own, a view group they own, and the batch or cell drawing a member', () => {
    const scene = new THREE.Scene();
    // A model drawn alone (its mesh listed in the scene, its logical parent the entity's node).
    const alone = mesh('alone');
    node('picked').add(alone);
    scene.children.push(alone);
    // A block layer's chunk: its view group names the owner.
    const layer = new THREE.Group();
    layer.userData[VIEW_OWNER_KEY] = 'picked';
    const chunk = mesh('chunk');
    layer.add(chunk);
    scene.children.push(chunk);
    // A member drawn through a batch: the batch's draw is in the scene, the member is parked.
    const member = mesh('member');
    node('copy').add(member);
    const batch = mesh('batch');
    batch.userData['tlBatch'] = true;
    scene.children.push(batch);
    // Someone else's draw.
    const other = mesh('other');
    node('other').add(other);
    scene.children.push(other);
    const keep = new OcclusionKeep({ scene, entityOf, node: (id) => nodes.get(id), drawOf: (m) => (m === member ? batch : null) });
    keep.set(new Set(['picked']));
    keep.update(true);
    expect([alone, chunk, batch, other].map(keptFromOcclusion)).toEqual([true, true, false, false]);
    expect(keep.size).toBe(2);
    // The batch's member picked: the whole batch is drawn untested.
    keep.set(new Set(['copy']));
    keep.update(true);
    expect([alone, chunk, batch, other].map(keptFromOcclusion)).toEqual([false, false, true, false]);
    // No path on: nothing is marked.
    keep.update(false);
    expect([alone, chunk, batch, other].some(keptFromOcclusion)).toBe(false);
    keep.update(true);
    keep.set(new Set());
    keep.update(true);
    expect(keep.size).toBe(0);
    expect(keptFromOcclusion(batch)).toBe(false);
  });

  it("never takes a host's own drawing for an occludee", () => {
    const overlay = new THREE.Group();
    const handle = mesh('handle');
    overlay.add(new THREE.Group().add(handle));
    expect(occludeeKindOf(handle)).toBe('single');
    markHostDrawing(overlay);
    expect(occludeeKindOf(handle)).toBeNull();
    // Hung on an object and listed among the scene's drawables (the render graph lists a subtree's meshes).
    const registry = new OccludeeRegistry();
    registry.sync([handle, mesh('wall')]);
    expect(registry.size).toBe(1);
    expect(registry.get(handle)).toBeUndefined();
  });

  it('draws the 12 edges of each culled box, nothing for an empty one', () => {
    const out = new Float32Array(72 * 3);
    const boxes = [new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 2, 3)), new THREE.Box3(), new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))];
    expect(boxEdgeVertices(boxes, out)).toBe(48);
    const edges = new Set<string>();
    for (let v = 0; v < 24; v += 2) {
      const a = [out[v * 3]!, out[v * 3 + 1]!, out[v * 3 + 2]!];
      const b = [out[v * 3 + 3]!, out[v * 3 + 4]!, out[v * 3 + 5]!];
      // Each edge changes one coordinate, from the box's min to its max.
      expect(a.filter((x, i) => x !== b[i]).length).toBe(1);
      edges.add([a, b].map((p) => p.join(',')).sort().join(' '));
    }
    expect(edges.size).toBe(12);
  });
});
