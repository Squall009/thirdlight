/**
 * WebGL 2's foliage bend round the view's subjects (no interaction field
 * there): the analytic push against the numbers it was held to before the
 * field (radius falloff, strength, rule, weight², the lean under the plant's
 * height, the path's head and tail), the view's easing and recovery with an
 * `interactor` component on the subject, the InteractorView running it on a
 * WebGL 2 renderer only, and the program three builds for WebGL 2 reading
 * the subjects while WebGPU's reads the field.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { InteractorView, type InteractorDeps } from './interactors';
import { createMaterialLibrary } from './material-library';
import { SubjectBend, SubjectBendView, subjectBendAt, SUBJECT_BEND_FLOATS } from './subject-bend';
import { glslRenderer, litScene, wgslOf, wgslRenderer } from './test-wgsl';

/** One subject standing at (x, z) on the ground, radius `r`, body 1.8 m tall, strength `k`; tail at (tx, tz). */
function packed(x: number, z: number, r: number, k: number, tx = x, tz = z): Float32Array {
  return Float32Array.from([x, 0, z, r, tx, 1.8, tz, k]);
}

const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[2]!);

describe('the push on a vertex (the numbers WebGL 2 bent by before the field)', () => {
  it('falls smoothly from the body to nothing at the radius, away from the subject', () => {
    const s = packed(0, 0, 1, 1);
    const at = (d: number): [number, number, number] => subjectBendAt([d, 0.5, 0], 0.5, 1, s, 1);
    const pushes = [0.1, 0.3, 0.5, 0.7, 0.9].map((d) => at(d)[0]);
    for (let i = 1; i < pushes.length; i++) expect(pushes[i]!).toBeLessThan(pushes[i - 1]!);
    expect(pushes.every((p) => p > 0)).toBe(true);
    // (1 − q²)² of the capacity (weight² × height = 0.5 m) at q = d / r.
    expect(at(0.5)[0]).toBeCloseTo(0.5 * (1 - 0.25) ** 2, 5);
    expect(len(at(1))).toBe(0);
    expect(len(at(1.5))).toBe(0);
    expect(subjectBendAt([-0.4, 0.5, 0], 0.5, 1, s, 1)[0]).toBeLessThan(0);
    const diag = subjectBendAt([0.3, 0.5, 0.3], 0.5, 1, s, 1);
    expect(diag[0]).toBeCloseTo(diag[2], 6);
  });

  it('scales with strength, the rule and the bend weight squared, and spares what is above the body or below its feet', () => {
    const p: [number, number, number] = [0.4, 0.3, 0];
    const one = subjectBendAt(p, 0.3, 1, packed(0, 0, 1, 0.5), 1)[0];
    expect(subjectBendAt(p, 0.3, 1, packed(0, 0, 1, 0.25), 1)[0]).toBeCloseTo(one / 2, 6);
    expect(subjectBendAt(p, 0.3, 1, packed(0, 0, 1, 0.5), 1, 0.5)[0]).toBeCloseTo(one / 2, 6);
    expect(subjectBendAt(p, 0.3, 0.5, packed(0, 0, 1, 0.5), 1)[0]).toBeCloseTo(one / 4, 6);
    expect(len(subjectBendAt(p, 0.3, 1, packed(0, 0, 1, 0.5), 1, 0))).toBe(0);
    expect(len(subjectBendAt(p, 0.3, 0, packed(0, 0, 1, 0.5), 1))).toBe(0);
    // A body 3 m up (a bridge): grass 0.3 m tall below it parts not at all.
    expect(len(subjectBendAt(p, 0.3, 1, Float32Array.from([0, 3, 0, 1, 0, 4.8, 0, 1]), 1))).toBe(0);
    // A mesh without weights: its height share of the first metre, squared.
    expect(subjectBendAt(p, 0.3, null, packed(0, 0, 1, 0.5), 1)[0]).toBeCloseTo(one * 0.09, 6);
  });

  it('holds the lean under the plant height, keeps the vertex as far from its root, and two subjects cancel', () => {
    const h = 0.8;
    const off = subjectBendAt([0.05, h, 0], h, 1, packed(0, 0, 1, 4), 1);
    expect(len(off)).toBeLessThanOrEqual(0.95 * h + 1e-6);
    expect(len(off)).toBeGreaterThan(0.9 * h);
    expect(Math.hypot(len(off), h + off[1])).toBeCloseTo(h, 5);
    const two = new Float32Array(2 * SUBJECT_BEND_FLOATS);
    two.set(packed(-0.3, 0, 1, 1), 0);
    two.set(packed(0.3, 0, 1, 1), SUBJECT_BEND_FLOATS);
    expect(len(subjectBendAt([0, 0.5, 0], 0.5, 1, two, 2))).toBeCloseTo(0, 6);
  });

  it('along the path: all of it at the head, none at the tail', () => {
    const s = packed(4, 0, 1, 1, 0, 0);
    const near = (x: number): number => subjectBendAt([x, 0.5, 0.3], 0.5, 1, s, 1)[2];
    expect(near(4)).toBeCloseTo(subjectBendAt([0, 0.5, 0.3], 0.5, 1, packed(0, 0, 1, 1), 1)[2], 6);
    expect(near(2)).toBeCloseTo(near(4) / 2, 6);
    expect(near(0)).toBeCloseTo(0, 6);
  });
});

/** The camera's target `walker`, a 1.8 m capsule with an interactor; `other` carries the component but is no subject. */
function world(): { deps: InteractorDeps; at: THREE.Vector3; named: string[] | null } {
  const w = { at: new THREE.Vector3(), named: null as string[] | null };
  const comps: Record<string, Record<string, unknown>> = { walker: { controller: {}, interactor: { radius: 1, strength: 1, recovery: 1 } }, other: { interactor: { radius: 1 } } };
  const deps: InteractorDeps = {
    matrix: (id, out) => (id === 'walker' ? (out.makeTranslation(w.at.x, w.at.y, w.at.z), true) : id === 'other' ? (out.makeTranslation(-5, 0, 0), true) : false),
    drawn: () => [],
    components: (id) => comps[id],
    cameraTarget: () => 'walker',
    named: () => w.named,
    interactors: () => ['other'],
  };
  return Object.assign(w, { deps });
}

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 10, 20);
camera.updateMatrixWorld();

describe('the view: easing and recovery', () => {
  it('eases a subject in, then a pressed path stands up again behind it over its recovery time, then eases out', () => {
    const w = world();
    const bend = new SubjectBend();
    const view = new SubjectBendView(w.deps, bend);
    let t = 0;
    const frame = (): void => {
      view.update(camera, t * 1000);
      t += 1 / 60;
    };
    frame();
    expect(view.packed[7]).toBe(0);
    for (let i = 0; i < 60; i++) frame();
    expect(view.packed[7]).toBeCloseTo(1, 5);
    expect(bend.isLive()).toBe(true);
    for (let i = 0; i < 120; i++) {
      w.at.x += 2 / 60;
      frame();
    }
    const push = (x: number): number => subjectBendAt([x, 0.5, 0.3], 0.5, 1, view.packed, view.live())[2];
    expect(push(w.at.x - 0.5)).toBeGreaterThan(push(w.at.x) * 0.5);
    expect(push(w.at.x - 3)).toBe(0);
    const behind = push(w.at.x - 1);
    expect(behind).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) frame();
    expect(push(w.at.x - 1)).toBeLessThan(behind * 0.5);
    for (let i = 0; i < 300; i++) frame();
    expect(push(w.at.x - 1.2)).toBe(0);
    expect(push(w.at.x)).toBeGreaterThan(0);
    w.named = [];
    for (let i = 0; i < 30; i++) frame();
    expect(view.packed[7]).toBeGreaterThan(0.3);
    expect(view.packed[7]).toBeLessThan(0.7);
    for (let i = 0; i < 40; i++) frame();
    expect(view.live()).toBe(0);
    expect(bend.isLive()).toBe(false);
  });

  it('starts the path again after a jump (no streak across the map)', () => {
    const w = world();
    const view = new SubjectBendView(w.deps, null);
    for (let i = 0; i <= 60; i++) view.update(camera, i * 16.7);
    w.at.set(50, 0, 0);
    view.update(camera, 61 * 16.7);
    expect(view.packed[0]).toBe(50);
    expect(view.packed[4]).toBe(50);
  });

  it('runs on a WebGL 2 renderer only, for the subjects alone; WebGPU stamps the field instead', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    const gl = { backend: { isWebGLBackend: true }, compute: () => undefined, copyTextureToTexture: () => undefined };
    const view = new InteractorView(world().deps, lib.interaction);
    for (let i = 0; i <= 70; i++) view.update(gl, camera, i * 16.7);
    expect(view.objects()).toEqual([{ id: 'walker', ease: 1 }]);
    expect(lib.interaction.subjects!.isLive()).toBe(true);
    expect(lib.interaction.reach(0.8)).toBe(0.8);
    expect(lib.interaction.isLive()).toBe(false);
    const gpu = new InteractorView(world().deps, null);
    const webgpu = { backend: { isWebGLBackend: false }, compute: () => undefined, copyTextureToTexture: () => undefined };
    for (let i = 0; i <= 3; i++) gpu.update(webgpu, camera, i * 16.7);
    // The subject and the object that only carries the component both stamp there.
    expect(gpu.stamps().count).toBe(2);
    lib.dispose();
  });
});

describe('the foliage program on WebGL 2', () => {
  it('reads the subjects\' push in its vertex stage (one program for any number of them) and WebGPU\'s reads the field', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([{ materialId: 'grass', name: 'grass', shader: 'foliage', params: {}, textures: {} }]);
    const geometry = new THREE.PlaneGeometry(0.2, 0.8);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes['position']!.count * 4).fill(1), 4));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    lib.apply(mesh, { '*': 'grass' });
    const scene = litScene();
    scene.add(mesh);
    const gl = wgslOf(glslRenderer(), scene, mesh);
    // The wind's three square roots, then two per subject slot (distance, reach) for the four slots: none of them
    // were there while WebGL 2 read nothing.
    expect((gl.match(/sqrt/g) ?? []).length).toBeGreaterThanOrEqual(3 + 8);
    lib.interaction.subjects!.set(packed(0, 0, 1, 1), 1);
    expect(wgslOf(glslRenderer(), scene, mesh)).toBe(gl);
    const gpu = wgslOf(wgslRenderer(), scene, mesh);
    expect(gpu).toMatch(/textureSampleLevel/);
    expect(gpu).not.toBe(gl);
    lib.dispose();
  });
});
