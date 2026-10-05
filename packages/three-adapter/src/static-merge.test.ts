/**
 * Static batching — which meshes merge, the merged copy in world space, a
 * member that moves, hides or switches level, mirrored members, dropped ones,
 * the background build and turning it off. Pure three.js scene graph in Node
 * (no renderer): what is drawn is read from the layers and the merged meshes'
 * index.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { BATCH_KEY, BATCHED_LAYER, createAutoBatcher, type AutoBatcherOptions } from './batching';
import { LOD_OWNER_KEY } from './lod-switch';
import { MERGED_RENDER_ORDER, mergeLayout, OBJECT_FRAME_KEY, STATIC_KEY } from './static-merge';

const camera = (): THREE.PerspectiveCamera => new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

/** A static, batchable mesh at `x` (its own geometry: unique, so instancing leaves it alone). */
function prop(material: THREE.Material, x: number, opts: { scope?: string | null; geometry?: THREE.BufferGeometry; scale?: number } = {}): THREE.Mesh {
  const m = new THREE.Mesh(opts.geometry ?? new THREE.BoxGeometry(1, 1 + x * 0.01, 1), material);
  m.position.set(x, 0, 0);
  if (opts.scale !== undefined) m.scale.set(opts.scale, 1, 1);
  m.userData[BATCH_KEY] = true;
  if (opts.scope !== null) m.userData[STATIC_KEY] = opts.scope ?? 'scene-a';
  m.updateMatrixWorld(true);
  return m;
}

function merged(scene: THREE.Scene): THREE.Mesh[] {
  return scene.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true && o.name.startsWith('tl-merged:'));
}

/** Triangles a merged mesh draws now. */
const drawn = (m: THREE.Mesh): number => (m.visible ? Math.min(m.geometry.drawRange.count, m.geometry.index!.count) / 3 : 0);
const alone = (m: THREE.Mesh): boolean => m.layers.mask === 1;

function setup(meshes: THREE.Mesh[], options: AutoBatcherOptions = {}): { scene: THREE.Scene; b: ReturnType<typeof createAutoBatcher>; clock: { t: number } } {
  const scene = new THREE.Scene();
  const clock = { t: 0 };
  for (const m of meshes) scene.add(m);
  const b = createAutoBatcher(scene, { now: () => clock.t, ...options });
  for (const m of meshes) b.listed(m);
  return { scene, b, clock };
}

describe('static batching', () => {
  it('merges static meshes of one material into one world-space geometry; the members leave the drawn layer', () => {
    const mat = new THREE.MeshLambertMaterial();
    const a = prop(mat, 0);
    const c = prop(mat, 3, { scale: 2 });
    const { scene, b } = setup([a, c]);
    b.update(camera());
    const [cell, ...rest] = merged(scene);
    expect(rest).toEqual([]);
    expect(cell!.material).toBe(mat);
    expect(drawn(cell!)).toBe(24);
    expect([a, c].map(alone)).toEqual([false, false]);
    expect(a.layers.mask).toBe(1 << BATCHED_LAYER);
    // World space: the second box spans x 2..4 (scale 2 around x = 3).
    cell!.geometry.computeBoundingBox();
    expect(cell!.geometry.boundingBox!.min.x).toBeCloseTo(-0.5);
    expect(cell!.geometry.boundingBox!.max.x).toBeCloseTo(4);
    // Picking goes to the members, and the merged mesh stays out of the batcher's own listing.
    expect(cell!.userData['tlBatch']).toBe(true);
    // Drawn ahead of the other opaque objects (the level's occluder), whose own order is 0.
    expect(cell!.renderOrder).toBe(MERGED_RENDER_ORDER);
    expect(MERGED_RENDER_ORDER).toBeLessThan(0);
    const d = b.diagnostics();
    expect([d.single, d.merging?.cells, d.merging?.merged]).toEqual([0, 1, 2]);
    expect(d.merging!.vertexBytes).toBe(48 * (3 + 3 + 2) * 4);
    expect(d.merging!.indexBytes).toBe(72 * 2);
  });

  it('leaves alone what is not static, refused, of another scope, material, layout or frame-reading material', () => {
    const mat = new THREE.MeshLambertMaterial();
    const other = new THREE.MeshLambertMaterial();
    const frame = new THREE.MeshLambertMaterial();
    frame.userData[OBJECT_FRAME_KEY] = true;
    const plain = new THREE.BufferGeometry().setAttribute('position', new THREE.BoxGeometry().getAttribute('position'));
    const meshes = [prop(mat, 0, { scope: null }), prop(mat, 1, { scope: 'scene-b' }), prop(mat, 2), prop(other, 3), prop(mat, 4, { geometry: plain }), prop(frame, 5), prop(frame, 6)];
    const { scene, b } = setup(meshes);
    b.update(camera());
    expect(merged(scene)).toEqual([]);
    expect(meshes.every(alone)).toBe(true);
    expect(b.diagnostics().single).toBe(7);
    expect(mergeLayout(plain)).not.toBe(mergeLayout(meshes[0]!.geometry));
  });

  it('a member that moves leaves the merged draw at once and rejoins where it is after it stays put', () => {
    const mat = new THREE.MeshLambertMaterial();
    const a = prop(mat, 0);
    const c = prop(mat, 3);
    const { scene, b, clock } = setup([a, c]);
    b.update(camera());
    const cell = merged(scene)[0]!;
    const builds = b.diagnostics().merging!.buildsTotal;
    // Within its world cell (a move to another cell joins that cell's draw instead).
    a.position.set(10, 0, 0);
    a.updateMatrixWorld(true);
    b.moved(a);
    clock.t = 10;
    b.update(camera());
    expect(alone(a)).toBe(true);
    expect(drawn(cell)).toBe(12);
    clock.t = 400;
    b.update(camera());
    expect(alone(a)).toBe(true);
    clock.t = 600;
    expect(b.pending()).toBe(true);
    b.update(camera());
    expect(alone(a)).toBe(false);
    expect(drawn(cell)).toBe(24);
    expect(b.diagnostics().merging!.buildsTotal, 'rewritten in place, not built again').toBe(builds);
    expect(cell.geometry.boundingBox!.max.x).toBeCloseTo(10.5);
  });

  it('a hidden member leaves the draw; one that leaves for good goes with the next build', () => {
    const mat = new THREE.MeshLambertMaterial();
    const ms = [0, 2, 4].map((x) => prop(mat, x));
    const { scene, b } = setup(ms);
    b.update(camera());
    const cell = merged(scene)[0]!;
    ms[1]!.visible = false;
    b.touch(ms[1]!);
    b.update(camera());
    expect(drawn(cell)).toBe(24);
    expect(alone(ms[1]!)).toBe(true);
    // Two of three gone: built again without them, then dropped with the last.
    for (const m of ms.slice(0, 2)) {
      b.unlisted(m);
      b.dropped(m);
    }
    b.update(camera());
    expect(merged(scene).length).toBe(1);
    expect(merged(scene)[0]!.geometry.getAttribute('position').count).toBe(24);
    b.unlisted(ms[2]!);
    b.dropped(ms[2]!);
    b.update(camera());
    expect(merged(scene)).toEqual([]);
    expect(b.diagnostics().merging!.slots).toBe(0);
  });

  it('copies every level of a LOD with its member: a level switch rewrites the index only', () => {
    const mat = new THREE.MeshLambertMaterial();
    const lod = new THREE.LOD();
    const near = prop(mat, 0);
    const far = prop(mat, 0, { geometry: new THREE.BoxGeometry(1, 1, 1, 1, 1, 1) });
    lod.addLevel(near, 0);
    lod.addLevel(far, 20);
    for (const m of [near, far]) m.userData[LOD_OWNER_KEY] = lod;
    lod.updateMatrixWorld(true);
    const other = prop(mat, 5);
    const scene = new THREE.Scene();
    scene.add(near, other);
    const b = createAutoBatcher(scene);
    b.listed(near);
    b.listed(other);
    b.update(camera());
    const cell = merged(scene)[0]!;
    expect(b.diagnostics().merging!.slots).toBe(3);
    expect(cell.geometry.getAttribute('position').count).toBe(72);
    const builds = b.diagnostics().merging!.buildsTotal;
    // The switch: the near level leaves the scene, the far one comes in.
    scene.remove(near);
    b.unlisted(near);
    scene.add(far);
    b.listed(far);
    b.update(camera());
    expect(alone(near)).toBe(true);
    expect(alone(far)).toBe(false);
    expect(drawn(cell)).toBe(24);
    expect(b.diagnostics().merging!.buildsTotal).toBe(builds);
  });

  it('turns the triangles of a mirrored member so its front faces stay front', () => {
    const mat = new THREE.MeshLambertMaterial();
    const g = new THREE.BoxGeometry();
    const a = prop(mat, 0, { geometry: g });
    const c = prop(mat, 3, { geometry: g.clone() });
    c.scale.set(-1, 1, 1);
    c.updateMatrixWorld(true);
    const { scene, b } = setup([a, c]);
    b.update(camera());
    const cell = merged(scene)[0]!;
    const idx = cell.geometry.index!;
    const pos = cell.geometry.getAttribute('position');
    const normal = cell.geometry.getAttribute('normal');
    // Every triangle's winding agrees with its (world) normal.
    const v = (i: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(pos, i);
    for (let t = 0; t < idx.count; t += 3) {
      const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      const face = v(j).sub(v(i)).cross(v(k).sub(v(i)));
      expect(face.dot(new THREE.Vector3().fromBufferAttribute(normal, i))).toBeGreaterThan(0);
    }
  });

  it('builds in the background a frame after its members arrive, drawing them alone meanwhile; off draws everything alone', () => {
    const mat = new THREE.MeshLambertMaterial();
    const ms = [0, 2].map((x) => prop(mat, x));
    const { scene, b } = setup(ms, { merging: 'background' });
    b.update(camera());
    expect(merged(scene)).toEqual([]);
    expect(ms.every(alone)).toBe(true);
    expect(b.pending()).toBe(true);
    b.update(camera());
    expect(merged(scene).length).toBe(1);
    expect(ms.some(alone)).toBe(false);
    expect(b.pending()).toBe(false);
    b.setEnabled(false);
    expect(merged(scene)).toEqual([]);
    expect(ms.every(alone)).toBe(true);
    const off = setup([0, 2].map((x) => prop(mat, x)), { merging: 'off' });
    off.b.update(camera());
    expect(merged(off.scene)).toEqual([]);
    expect(off.b.diagnostics().merging).toBeUndefined();
  });
});
