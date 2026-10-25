/**
 * Foliage giving way to the view's subjects: the push the shader runs (the
 * same steps over numbers, `foliageBendAt`) against closed-form
 * expectations (radius falloff, strength, the lean held under the plant's
 * height), the recovery behind a moving subject through the view's eased
 * values, the subject list followed with see-through off, and the WGSL the
 * foliage material builds with it.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { SEE_THROUGH_DEFAULTS, type ScatterRule } from '@thirdlight/runtime';

import { FOLIAGE_BEND_FLOATS, FoliageBend, FoliageBendView, foliageBendAt, type FoliageBendDeps } from './foliage-bend';
import { createMaterialLibrary } from './material-library';
import { SeeThroughView } from './see-through';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';
import { COVER_DRAW_KEY, coverPointsPlacement, installCoverPlacement } from './cover-gpu';
import { planCover } from './cover-placement';

/** One subject standing at (x, z) on the ground, radius `r`, body 1.8 m tall, strength `k`; tail at (tx, tz). */
function packed(x: number, z: number, r: number, k: number, tx = x, tz = z): Float32Array {
  return Float32Array.from([x, 0, z, r, tx, 1.8, tz, k]);
}

const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[2]!);

describe('the push on a vertex', () => {
  it('falls smoothly from the body to nothing at the radius, away from the subject', () => {
    const s = packed(0, 0, 1, 1);
    const at = (d: number): [number, number, number] => foliageBendAt([d, 0.5, 0], 0.5, 1, s, 1);
    const pushes = [0.1, 0.3, 0.5, 0.7, 0.9].map((d) => at(d)[0]);
    for (let i = 1; i < pushes.length; i++) expect(pushes[i]!).toBeLessThan(pushes[i - 1]!);
    expect(pushes.every((p) => p > 0)).toBe(true);
    // (1 − q²)² of the capacity (weight² × height = 0.5 m) at q = d / r.
    expect(at(0.5)[0]).toBeCloseTo(0.5 * (1 - 0.25) ** 2, 5);
    expect(len(at(1))).toBe(0);
    expect(len(at(1.5))).toBe(0);
    // Away: on the other side it points the other way; off the axis it points along the line from the body.
    expect(foliageBendAt([-0.4, 0.5, 0], 0.5, 1, s, 1)[0]).toBeLessThan(0);
    const diag = foliageBendAt([0.3, 0.5, 0.3], 0.5, 1, s, 1);
    expect(diag[0]).toBeCloseTo(diag[2], 6);
  });

  it('scales with strength, the rule and the bend weight squared, and spares what is above the body or below its feet', () => {
    const p: [number, number, number] = [0.4, 0.3, 0];
    const one = foliageBendAt(p, 0.3, 1, packed(0, 0, 1, 0.5), 1)[0];
    expect(foliageBendAt(p, 0.3, 1, packed(0, 0, 1, 0.25), 1)[0]).toBeCloseTo(one / 2, 6);
    expect(foliageBendAt(p, 0.3, 1, packed(0, 0, 1, 0.5), 1, 0.5)[0]).toBeCloseTo(one / 2, 6);
    expect(foliageBendAt(p, 0.3, 0.5, packed(0, 0, 1, 0.5), 1)[0]).toBeCloseTo(one / 4, 6);
    expect(len(foliageBendAt(p, 0.3, 1, packed(0, 0, 1, 0.5), 1, 0))).toBe(0);
    expect(len(foliageBendAt(p, 0.3, 0, packed(0, 0, 1, 0.5), 1))).toBe(0);
    // A body 3 m up (a bridge): grass 0.3 m tall below it parts not at all.
    const up = Float32Array.from([0, 3, 0, 1, 0, 4.8, 0, 1]);
    expect(len(foliageBendAt(p, 0.3, 1, up, 1))).toBe(0);
    // A mesh without weights: its height share of the first metre, squared.
    expect(foliageBendAt(p, 0.3, null, packed(0, 0, 1, 0.5), 1)[0]).toBeCloseTo(one * 0.09, 6);
  });

  it('holds the lean under the plant height and keeps the vertex as far from its root', () => {
    const h = 0.8;
    const off = foliageBendAt([0.05, h, 0], h, 1, packed(0, 0, 1, 4), 1);
    expect(len(off)).toBeLessThanOrEqual(0.95 * h + 1e-6);
    expect(len(off)).toBeGreaterThan(0.9 * h);
    expect(Math.hypot(len(off), h + off[1])).toBeCloseTo(h, 5);
    // Two subjects side by side push the same vertex from both sides: they cancel.
    const two = new Float32Array(2 * FOLIAGE_BEND_FLOATS);
    two.set(packed(-0.3, 0, 1, 1), 0);
    two.set(packed(0.3, 0, 1, 1), FOLIAGE_BEND_FLOATS);
    expect(len(foliageBendAt([0, 0.5, 0], 0.5, 1, two, 2))).toBeCloseTo(0, 6);
  });

  it('along the path: all of it at the head, none at the tail, as far round the segment', () => {
    const s = packed(4, 0, 1, 1, 0, 0);
    const near = (x: number): number => foliageBendAt([x, 0.5, 0.3], 0.5, 1, s, 1)[2];
    expect(near(4)).toBeCloseTo(foliageBendAt([0, 0.5, 0.3], 0.5, 1, packed(0, 0, 1, 1), 1)[2], 6);
    expect(near(2)).toBeCloseTo(near(4) / 2, 6);
    expect(near(0)).toBeCloseTo(0, 6);
  });
});

/** A subject `id` the test moves, a 1.8 m capsule (the controller's default) unless `bend` says otherwise. */
function world(): { deps: FoliageBendDeps; at: THREE.Vector3; named: string[] | null; comps: Record<string, unknown> } {
  const w = { at: new THREE.Vector3(), named: null as string[] | null, comps: { controller: {} } as Record<string, unknown> };
  const deps: FoliageBendDeps = {
    matrix: (id, out) => (id === 'walker' ? (out.makeTranslation(w.at.x, w.at.y, w.at.z), true) : false),
    drawn: () => [],
    components: () => w.comps,
    cameraTarget: () => 'walker',
    named: () => w.named,
  };
  return Object.assign(w, { deps });
}

describe('the view: easing and recovery', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 10, 20);
  camera.updateMatrixWorld();

  it('eases a subject in, then a pressed path stands up again behind it over its recovery time', () => {
    const w = world();
    w.comps = { controller: {}, foliageBend: { radius: 1, strength: 1, recovery: 1 } };
    const field = new FoliageBend();
    const view = new FoliageBendView(w.deps, field);
    let t = 0;
    const frame = (): void => {
      view.update(camera, t * 1000);
      t += 1 / 60;
    };
    frame();
    expect(view.packed[7]).toBe(0);
    for (let i = 0; i < 60; i++) frame();
    expect(view.packed[7]).toBeCloseTo(1, 5);
    expect(field.live.value).toBe(1);
    // Walk 4 m along x at 2 m/s.
    for (let i = 0; i < 120; i++) {
      w.at.x += 2 / 60;
      frame();
    }
    const push = (x: number): number => foliageBendAt([x, 0.5, 0.3], 0.5, 1, view.packed, view.live())[2];
    // The tail lags speed × recovery (2 m) behind the head: half a metre back still parted, 3 m back standing.
    expect(push(w.at.x - 0.5)).toBeGreaterThan(push(w.at.x) * 0.5);
    expect(push(w.at.x - 3)).toBe(0);
    const behind = push(w.at.x - 1);
    expect(behind).toBeGreaterThan(0);
    // Stopped: over a recovery time the path behind closes up, the plants round the body stay parted.
    for (let i = 0; i < 60; i++) frame();
    expect(push(w.at.x - 1)).toBeLessThan(behind * 0.5);
    for (let i = 0; i < 300; i++) frame();
    expect(push(w.at.x - 1.2)).toBe(0);
    expect(push(w.at.x)).toBeGreaterThan(0);
    // Gone from the list: it eases out, then its slot is free and nothing is pushed.
    w.named = [];
    for (let i = 0; i < 30; i++) frame();
    expect(view.packed[7]).toBeGreaterThan(0.3);
    expect(view.packed[7]).toBeLessThan(0.7);
    for (let i = 0; i < 40; i++) frame();
    expect(view.live()).toBe(0);
    expect(field.live.value).toBe(0);
  });

  it('starts the path again after a jump (no streak across the map)', () => {
    const w = world();
    const view = new FoliageBendView(w.deps, null);
    for (let i = 0; i <= 60; i++) view.update(camera, i * 16.7);
    w.at.set(50, 0, 0);
    view.update(camera, 61 * 16.7);
    expect(view.packed[0]).toBe(50);
    expect(view.packed[4]).toBe(50);
  });

  it('follows the subjects a script names while see-through is off', () => {
    const scripted = { settings: { ...SEE_THROUGH_DEFAULTS, enabled: false }, subjects: ['walker'] };
    const st = new SeeThroughView({ matrix: () => false, drawn: () => [], components: () => undefined, cameraTarget: () => null, scripted: () => scripted });
    st.beforeBatch(camera);
    expect(st.settings().enabled).toBe(false);
    const w = world();
    const view = new FoliageBendView({ ...w.deps, cameraTarget: () => null, named: () => st.subjects() }, null);
    for (let i = 0; i <= 20; i++) view.update(camera, i * 100);
    expect(view.subjects()).toEqual([{ id: 'walker', ease: 1 }]);
  });
});

describe('the foliage shader with subjects', () => {
  it('builds its vertex stage reading the subjects (the same program for any number of them)', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([{ materialId: 'grass', name: 'grass', shader: 'foliage', params: {}, textures: {} }]);
    const geometry = new THREE.PlaneGeometry(0.2, 0.8);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes['position']!.count * 4).fill(1), 4));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    lib.apply(mesh, { '*': 'grass' });
    const scene = litScene();
    scene.add(mesh);
    const none = wgslOf(wgslRenderer(), scene, mesh);
    // The push's steps for each subject slot (a square root for the distance and one for the reach, per slot).
    expect((none.match(/sqrt/g) ?? []).length).toBeGreaterThanOrEqual(8);
    lib.foliageBend.set(packed(0, 0, 1, 1), 1);
    const one = wgslOf(wgslRenderer(), scene, mesh);
    expect(one).toBe(none);
    expect(lib.foliageBend.reach(0.8)).toBe(0.8);
    lib.dispose();
  });

  it('measures a cover copy\'s height from the copy\'s own root, and reads its rule\'s bendAway', () => {
    installCoverPlacement();
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([{ materialId: 'grass', name: 'grass', shader: 'foliage', params: { windDistance: 40 }, textures: {} }]);
    const geometry = new THREE.BoxGeometry(0.1, 0.8, 0.1);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes['position']!.count * 4).fill(1), 4));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    lib.apply(mesh, { '*': 'grass' });
    const rule: ScatterRule = { id: 'grass', asset: { assetId: 'tuft' }, density: 4, cover: true, bendAway: 0.37 };
    const plan = planCover(rule, 40, { distances: [0], culls: false, radius: 0.3 }, 16);
    const blocks = new THREE.DataTexture(new Float32Array(1024 * 4), 1024, 1, THREE.RGBAFormat, THREE.FloatType);
    const points = new THREE.DataTexture(new Float32Array(1024 * 4 * 16), 1024, 16, THREE.RGBAFormat, THREE.FloatType);
    mesh.userData[COVER_DRAW_KEY] = coverPointsPlacement({ ring: plan.rings[0]!, plan, rule, blocks, points, chunk: [16, 16], eye: TSL.uniform(new THREE.Vector2()), local: new THREE.Matrix4() });
    (mesh as unknown as { count: number }).count = 512;
    const scene = litScene();
    scene.add(mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    // Not the draw's origin (the terrain's or the block layer's): a copy's height above its own ground.
    expect(wgsl).not.toMatch(/vec4<f32>\(\s*vec3<f32>\(\s*0\.0,\s*0\.0,\s*0\.0\s*\),\s*1\.0\s*\)/);
    expect(wgsl).toMatch(/\* 0\.37/);
    lib.dispose();
  });
});
