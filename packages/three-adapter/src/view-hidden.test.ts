/**
 * What occlusion culling may test: the reasons decided before it (a
 * cut-away, the rooms' portals, an edit mode's isolation) are never tested
 * again, what occlusion itself hid is asked again, and a model's `_OCC`
 * stand-in fills the depth only while its own surfaces are drawn.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyModelOccluders, standinFollowsSurfaces } from './occluders';
import { HIDDEN_BEFORE_OCCLUSION, HIDDEN_BY_CUTAWAY, HIDDEN_BY_ISOLATION, HIDDEN_BY_OCCLUSION, HIDDEN_BY_ROOM, hideFromView, occlusionMayTest } from './view-hidden';

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
});
