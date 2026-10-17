/**
 * Occluders on a small scene: a model's `_OCC` nodes become depth-only
 * stand-ins drawn by the view's camera alone while a culling path is on (or
 * are dropped when they stick out of their piece), its surfaces stand down
 * where a stand-in speaks for them, an object's `occluder: false` and its
 * materials decide its role, level geometry is ordered first, and batches
 * and merged cells never mix draws of different roles.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyEntityRenderFlags } from './entity-render-flags';
import { batchKey, batchKeyParts, markBatchable } from './batching';
import { markOccludee, occludeeKindOf, OccludeeRegistry } from './occludees';
import { applyModelOccluders, applyObjectOccluder, isOccluderStandin, OCCLUDER_EARLY_RENDER_ORDER, OCCLUDER_STANDIN_RENDER_ORDER, occluderRoleOfDraw, SURFACES_STAND_DOWN_KEY } from './occluders';
import { OcclusionCuller } from './occlusion';
import { modelPieces, pieceBounds } from './pieces';

/** A 1 m box (y 0..1) named as a file's node, at `x`, scaled by `s` about its base. */
const node = (name: string, x = 0, s = 1, y = 0): THREE.Mesh => {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  m.name = name;
  m.position.set(x, y, 0);
  m.scale.setScalar(s);
  return m;
};

/** A kit file: `hedge` with a stand-in inside, `wall` with one sticking out above it, `rock` with none. */
function kit(): THREE.Group {
  const root = new THREE.Group();
  root.add(node('hedge_LOD0', 0), node('hedge_LOD1', 0), node('hedge_OCC', 0, 0.5, 0.25), node('wall', 3), node('wall_OCC', 3, 0.9, 0.4), node('rock', 6));
  return root;
}

const byName = (root: THREE.Object3D, name: string): THREE.Mesh => root.getObjectByName(name) as THREE.Mesh;
const camera = (): THREE.PerspectiveCamera => new THREE.PerspectiveCamera(60, 1, 0.1, 100);

describe('occluder stand-ins', () => {
  it('belong to their piece but are none of its render nodes and leave its bounds as they are', () => {
    const root = kit();
    expect(modelPieces(root).map((p) => [p.name, p.nodes.map((n) => n.name)])).toEqual([['hedge', ['hedge_LOD0', 'hedge_LOD1']], ['wall', ['wall']], ['rock', ['rock']]]);
    const b = pieceBounds(root, 'wall');
    expect([b.min.y, b.max.y]).toEqual([0, 1]);
  });

  it('keeps a stand-in inside its piece as depth only, drops one sticking out, and stands the spoken-for surfaces down', () => {
    const root = kit();
    expect(applyModelOccluders(root, 'auto')).toEqual({ standins: 1, dropped: 1 });
    expect(root.getObjectByName('wall_OCC')).toBeUndefined();
    const occ = byName(root, 'hedge_OCC');
    expect(isOccluderStandin(occ)).toBe(true);
    const mat = occ.material as THREE.Material;
    expect([mat.colorWrite, mat.depthWrite, mat.depthTest, occ.castShadow, occ.receiveShadow, occ.renderOrder]).toEqual([false, true, true, false, false, OCCLUDER_STANDIN_RENDER_ORDER]);
    // A stand-in is never picked.
    const hits: THREE.Intersection[] = [];
    occ.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0.5, -5), new THREE.Vector3(0, 0, 1)), hits);
    expect(hits).toEqual([]);
    // auto: the hedge's levels stand down for its stand-in; the wall (its stand-in dropped) and the rock count.
    const down = (n: string): boolean => byName(root, n).userData[SURFACES_STAND_DOWN_KEY] === true;
    expect(['hedge_LOD0', 'hedge_LOD1', 'wall', 'rock'].map(down)).toEqual([true, true, false, false]);
    expect(occluderRoleOfDraw(byName(root, 'hedge_LOD0'), 'single')).toBe('none');
    expect(occluderRoleOfDraw(byName(root, 'rock'), 'single')).toBe('surface');
    expect(occluderRoleOfDraw(occ, null)).toBe('standin');
    // The entity's render flags never give a stand-in a shadow.
    applyEntityRenderFlags(root, { model: { castShadow: true } });
    expect([occ.castShadow, byName(root, 'rock').castShadow]).toEqual([false, true]);
  });

  it('follows the import setting: occ keeps only the stand-ins, none drops them and nothing counts', () => {
    const occ = kit();
    expect(applyModelOccluders(occ, 'occ')).toEqual({ standins: 1, dropped: 1 });
    expect(occluderRoleOfDraw(byName(occ, 'rock'), 'single')).toBe('none');
    const none = kit();
    expect(applyModelOccluders(none, 'none')).toEqual({ standins: 0, dropped: 2 });
    expect(['hedge_LOD0', 'rock'].map((n) => occluderRoleOfDraw(byName(none, n), 'single'))).toEqual(['none', 'none']);
  });

  it('draw for the view\'s camera alone, only while the culler is on a path, and are counted', () => {
    const root = kit();
    applyModelOccluders(root);
    const occ = byName(root, 'hedge_OCC');
    const scene = new THREE.Scene();
    const view = camera();
    const shadow = camera();
    let path: 'off' | 'hiz' = 'off';
    const culler = new OcclusionCuller({ scene, setting: () => (path === 'off' ? 'off' : 'auto'), renderer: () => 'webgpu', pinned: null, view: { is: (c) => c === view } });
    const draws = (c: THREE.Camera): number => {
      occ.onBeforeRender(null as never, scene, c, occ.geometry, occ.material as THREE.Material, null as never);
      return occ.geometry.drawRange.count;
    };
    culler.update();
    expect([draws(view), draws(shadow)]).toEqual([0, 0]);
    path = 'hiz';
    culler.update();
    expect([draws(view), draws(shadow)]).toEqual([Number.POSITIVE_INFINITY, 0]);
    culler.update();
    expect(culler.diagnostics().standins).toBe(1);
    // An object that opts out draws no stand-in either.
    applyObjectOccluder(root, { model: { occluder: false } });
    expect(draws(view)).toBe(0);
    culler.dispose();
    expect(draws(view)).toBe(0);
  });

  it('are never occludees; level geometry is ordered first; materials and the object flag decide the role', () => {
    const root = kit();
    applyModelOccluders(root);
    expect(occludeeKindOf(byName(root, 'hedge_OCC'))).toBeNull();
    const chunk = node('chunk');
    markOccludee(chunk, 'blocks');
    expect(chunk.renderOrder).toBe(OCCLUDER_EARLY_RENDER_ORDER);
    const glassChunk = node('glass');
    (glassChunk.material as THREE.Material).transparent = true;
    markOccludee(glassChunk, 'blocks');
    // A see-through chunk keeps its place among the transparent draws.
    expect(glassChunk.renderOrder).toBe(0);
    const cutout = node('leaves');
    (cutout.material as THREE.Material).alphaTest = 0.5;
    const card = node('card');
    (card.material as THREE.Material).side = THREE.DoubleSide;
    const optedOut = node('opted');
    applyObjectOccluder(optedOut, { box: { occluder: false } });
    expect([cutout, card, optedOut, node('solid')].map((m) => occluderRoleOfDraw(m, 'single'))).toEqual(['none', 'none', 'none', 'surface']);
    const r = new OccludeeRegistry();
    r.sync([chunk, glassChunk, cutout, card, optedOut, node('solid'), byName(root, 'hedge_OCC')]);
    expect(r.roleCounts()).toEqual({ early: 1, surface: 1, standin: 0, none: 4 });
    // Opting in again is seen by the next sync.
    applyObjectOccluder(optedOut, { box: {} });
    r.sync([chunk, glassChunk, cutout, card, optedOut, node('solid')]);
    expect(r.roleCounts()).toMatchObject({ surface: 2, none: 3 });
  });

  it('keep draws of different roles out of one batch', () => {
    const a = node('a');
    const b = node('b');
    b.material = a.material;
    b.geometry = a.geometry;
    markBatchable(a);
    markBatchable(b);
    const key = (m: THREE.Mesh): string => batchKey(batchKeyParts(m)!, null, 64);
    expect(key(a)).toBe(key(b));
    applyObjectOccluder(b, { model: { occluder: false } });
    expect(key(a)).not.toBe(key(b));
    // A stand-in is drawn alone (its own order and per-camera hook).
    const root = kit();
    applyModelOccluders(root);
    markBatchable(root);
    expect(batchKeyParts(byName(root, 'hedge_OCC'))).toBeNull();
  });
});
