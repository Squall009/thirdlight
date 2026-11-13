/**
 * The interaction field: what presses into it and how foliage bends from it.
 *
 * The field's steps run on the CPU (`InteractionFieldReference`: the pass and
 * the foliage read over the same steps and window as the GPU's) against the
 * analytic bend it replaced (the push of a subject standing in the grass:
 * strength × (1 − q²)² × the vertex's capacity, away from the body), the
 * pressed path behind a mover standing up over its recovery time, more
 * objects than the old four slots, the gatherer (interactors, subjects,
 * easing, jumps), when the GPU pass runs and what it holds, and the programs
 * three builds: the foliage read (WebGPU; none on WebGL 2), the pass, and the
 * public wind sample read in a compute node.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import type { N } from './effects-tsl';
import { InteractionFieldReference } from './interaction-field-reference';
import { bendCapacity, InteractionField, INTERACTION_TEXELS, STAMP_FLOATS, type InteractionStamps } from './interaction-field';
import { InteractorView, type InteractorDeps } from './interactors';
import { createMaterialLibrary } from './material-library';
import { glslRenderer, litScene, wgslOf, wgslRenderer } from './test-wgsl';

/** One stamp standing at (x, z) (or swept from (fx, fz)), radius `r`, strength `k`, feet 0, top 1.8 m, recovery 1 s. */
function stamps(list: { x: number; z: number; r: number; k: number; fx?: number; fz?: number; recovery?: number }[]): InteractionStamps {
  const packed = new Float32Array(Math.max(1, list.length) * STAMP_FLOATS);
  list.forEach((s, i) => packed.set([s.fx ?? s.x, s.fz ?? s.z, s.x, s.z, 0, 1.8, s.r, s.k, 0, 0, 1 / (s.recovery ?? 1), 0], i * STAMP_FLOATS));
  return { packed, count: list.length, longestRecovery: Math.max(0, ...list.map((s) => s.recovery ?? 1)) };
}

/** The analytic push the field replaced: a subject standing at the origin, radius r, strength k, on a vertex at distance d. */
const analytic = (d: number, r: number, k: number, cap: number): number => (d >= r ? 0 : k * (1 - (d / r) ** 2) ** 2 * cap);

const EYE: [number, number, number] = [0, 1.7, 0];
const len = (v: readonly number[]): number => Math.hypot(v[0]!, v[2]!);

describe('the field against the bend it replaced', () => {
  it('bends away from a standing object by the same falloff, strength, rule and weight', () => {
    const f = new InteractionFieldReference();
    for (let i = 0; i < 3; i++) f.step(stamps([{ x: 0.1, z: 0.1, r: 1, k: 1 }]), EYE, 1 / 60);
    const h = 0.5;
    const cap = bendCapacity(1, h);
    const at = (d: number): [number, number, number] => f.bendAt([0.1 + d, h, 0.1], h, 1);
    // Every distance within 6 % of the plant's capacity of the analytic push, falling to nothing at the radius.
    let last = Infinity;
    for (const d of [0.25, 0.4, 0.55, 0.7, 0.85]) {
      const got = len(at(d));
      expect(Math.abs(got - analytic(d, 1, 1, cap))).toBeLessThan(0.06 * cap);
      expect(got).toBeLessThan(last);
      last = got;
    }
    expect(len(at(1.3))).toBe(0);
    // Away from the body: on the other side the other way, on a diagonal along it.
    expect(at(0.5)[0]).toBeGreaterThan(0);
    expect(f.bendAt([0.1 - 0.5, h, 0.1], h, 1)[0]).toBeLessThan(0);
    const diag = f.bendAt([0.1 + 0.35, h, 0.1 + 0.35], h, 1);
    expect(Math.abs(diag[0] - diag[2])).toBeLessThan(0.1 * len(diag));
    // Strength, the rule's bendAway and the bend weight squared scale it as they did.
    const half = new InteractionFieldReference();
    half.step(stamps([{ x: 0.1, z: 0.1, r: 1, k: 0.5 }]), EYE, 1 / 60);
    const p: [number, number, number] = [0.6, 0.3, 0.1];
    const one = len(f.bendAt(p, 0.3, 1));
    expect(len(half.bendAt(p, 0.3, 1))).toBeCloseTo(one / 2, 5);
    expect(len(f.bendAt(p, 0.3, 1, 0.5))).toBeCloseTo(one / 2, 5);
    expect(len(f.bendAt(p, 0.3, 0.5))).toBeCloseTo(one / 4, 5);
    expect(len(f.bendAt(p, 0.3, 1, 0))).toBe(0);
    // A body 3 m up (a bridge): grass 0.3 m tall below it parts not at all.
    const bridge = new InteractionFieldReference();
    const up = stamps([{ x: 0.1, z: 0.1, r: 1, k: 1 }]);
    up.packed[4] = 3;
    up.packed[5] = 4.8;
    bridge.step(up, EYE, 1 / 60);
    expect(len(bridge.bendAt(p, 0.3, 1))).toBe(0);
  });

  it('holds the lean under the plant height and keeps the vertex as far from its root', () => {
    const f = new InteractionFieldReference();
    f.step(stamps([{ x: 0.1, z: 0.1, r: 1, k: 4 }]), EYE, 1 / 60);
    const h = 0.8;
    const off = f.bendAt([0.3, h, 0.1], h, 1);
    expect(len(off)).toBeLessThanOrEqual(0.95 * h + 1e-6);
    expect(len(off)).toBeGreaterThan(0.9 * h);
    expect(Math.hypot(len(off), h + off[1])).toBeCloseTo(h, 5);
  });

  it('leaves a pressed path behind a mover that stands up again over its recovery time, linearly as the old path did', () => {
    const f = new InteractionFieldReference();
    // Walking 2 m/s along x for 2 s, recovery 1 s.
    let x = 0;
    for (let i = 0; i < 120; i++) {
      f.step(stamps([{ fx: x, fz: 0.1, x: x + 2 / 60, z: 0.1, r: 1, k: 1 }]), EYE, 1 / 60);
      x += 2 / 60;
    }
    const side = (bx: number): number => len(f.bendAt([bx, 0.5, 0.4], 0.5, 1));
    const atBody = side(x);
    // Half a second back (1 m): about half of it; 0.25 s back: about three quarters; 3 m back (1.5 s): nothing.
    expect(side(x - 1) / atBody).toBeGreaterThan(0.4);
    expect(side(x - 1) / atBody).toBeLessThan(0.6);
    expect(side(x - 0.5) / atBody).toBeGreaterThan(0.65);
    expect(side(x - 3)).toBe(0);
    // Sideways out of the path, as the old push away from the path's line.
    const off = f.bendAt([x - 1, 0.5, 0.4], 0.5, 1);
    expect(Math.abs(off[2])).toBeGreaterThan(Math.abs(off[0]) * 2);
    expect(off[2]).toBeGreaterThan(0);
    // Stopped: within a recovery time the path behind has stood up; round the body the plants stay parted.
    for (let i = 0; i < 70; i++) f.step(stamps([{ x, z: 0.1, r: 1, k: 1 }]), EYE, 1 / 60);
    expect(side(x - 1.3)).toBe(0);
    expect(side(x)).toBeCloseTo(atBody, 1);
    // Gone: half a recovery time later about half is left, after a whole one nothing.
    for (let i = 0; i < 30; i++) f.step(stamps([]), EYE, 1 / 60);
    expect(side(x) / atBody).toBeGreaterThan(0.4);
    expect(side(x) / atBody).toBeLessThan(0.6);
    for (let i = 0; i < 31; i++) f.step(stamps([]), EYE, 1 / 60);
    expect(side(x)).toBe(0);
  });

  it('carries what is pressed with the window as the eye moves, and keeps heights through a moved base', () => {
    const f = new InteractionFieldReference();
    f.step(stamps([{ x: 5.1, z: 5.1, r: 1, k: 1, recovery: 30 }]), [0, 100.4, 0], 1 / 60);
    const before = f.bendAt([5.6, 0.3, 5.1], 0.3, 1);
    expect(len(before)).toBeGreaterThan(0);
    // The eye walks 7 m and climbs 3 m with nothing new pressed: the press is where it was.
    f.step(stamps([]), [7.3, 103.6, -2.2], 1 / 60);
    const after = f.bendAt([5.6, 0.3, 5.1], 0.3, 1);
    expect(len(after)).toBeGreaterThan(0);
    expect(len(after)).toBeCloseTo(len(before), 2);
    // Past the window (64 m on): nothing is carried in from what it held.
    f.step(stamps([]), [107.3, 103.6, -2.2], 1 / 60);
    expect(f.a.every((v) => v === 0 || Number.isFinite(v))).toBe(true);
    expect(Math.max(...f.a.filter((_, k) => k % 4 === 2))).toBe(0);
  });

  it('presses round any number of objects, each where it stands (more than the old four)', () => {
    const f = new InteractionFieldReference();
    const list = Array.from({ length: 9 }, (_, k) => ({ x: -16 + k * 4.1, z: (k % 3) * 5 - 5.1, r: 0.6, k: 1 }));
    f.step(stamps(list), EYE, 1 / 60);
    for (const s of list) {
      expect(len(f.bendAt([s.x + 0.3, 0.5, s.z], 0.5, 1))).toBeGreaterThan(0.1);
      expect(len(f.bendAt([s.x + 1.6, 0.5, s.z], 0.5, 1))).toBe(0);
    }
  });
});

/** Objects the test moves; `walker` is the camera's target, a 1.8 m capsule (the controller's default). */
function world(): { deps: InteractorDeps; at: Map<string, THREE.Vector3>; named: string[] | null; comps: Map<string, Record<string, unknown>>; ids: string[] } {
  const w = { at: new Map<string, THREE.Vector3>([['walker', new THREE.Vector3()]]), named: null as string[] | null, comps: new Map<string, Record<string, unknown>>([['walker', { controller: {} }]]), ids: [] as string[] };
  const deps: InteractorDeps = {
    matrix: (id, out) => {
      const p = w.at.get(id);
      if (p === undefined) return false;
      out.makeTranslation(p.x, p.y, p.z);
      return true;
    },
    drawn: () => [],
    components: (id) => w.comps.get(id),
    cameraTarget: () => 'walker',
    named: () => w.named,
    interactors: () => w.ids,
  };
  return Object.assign(w, { deps });
}

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 10, 20);
camera.updateMatrixWorld();

/** A renderer that runs nothing: the field's own bookkeeping only. */
function fakeRenderer(webgl = false): { backend: { isWebGLBackend: boolean }; computes: number; copies: number; compute(): void; copyTextureToTexture(): void } {
  const r = { backend: { isWebGLBackend: webgl }, computes: 0, copies: 0, compute: () => void (r.computes += 1), copyTextureToTexture: () => void (r.copies += 1) };
  return r;
}

describe('the objects that press', () => {
  it('eases a subject in over its recovery, sweeps it from where it stood, and starts it again after a jump', () => {
    const w = world();
    w.comps.set('walker', { controller: {}, interactor: { radius: 1, strength: 1, recovery: 1 } });
    const view = new InteractorView(w.deps, null);
    view.gather(0);
    expect(view.stamps().count).toBe(0);
    for (let i = 0; i < 30; i++) view.gather(1 / 60);
    expect(view.stamps().packed[7]).toBeCloseTo(0.5, 2);
    for (let i = 0; i < 40; i++) view.gather(1 / 60);
    const s = view.stamps().packed;
    expect(s[7]).toBe(1);
    expect(s[6]).toBe(1);
    // Feet to top: the capsule's 1.8 m.
    expect(s[5]! - s[4]!).toBeCloseTo(1.8, 5);
    w.at.get('walker')!.x = 0.05;
    view.gather(1 / 60);
    expect([s[0], s[2]]).toEqual([0, Math.fround(0.05)]);
    expect(s[8]).toBeCloseTo(3, 4);
    // A jump: no streak across the map, no velocity.
    w.at.get('walker')!.x = 50;
    view.gather(1 / 60);
    expect([s[0], s[2], s[8]]).toEqual([50, 50, 0]);
  });

  it('every object with an interactor presses beside the subjects; one without strength presses nothing; see-through\'s named list stands for the target', () => {
    const w = world();
    for (let k = 0; k < 7; k++) {
      w.at.set(`p${k}`, new THREE.Vector3(k * 3, 0, 0));
      w.comps.set(`p${k}`, { interactor: { radius: 0.5, recovery: 0 } });
      w.ids.push(`p${k}`);
    }
    w.comps.set('p6', { interactor: { strength: 0 } });
    const view = new InteractorView(w.deps, null);
    view.gather(1 / 60);
    // The camera's target (easing in) and six interactors at full strength (recovery 0).
    expect(view.stamps().count).toBe(7);
    expect(view.objects().map((o) => o.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'walker']);
    // A named list replaces the target; a name that is also an interactor presses once.
    w.named = ['p1'];
    view.gather(1 / 60);
    expect(view.stamps().count).toBe(6);
    expect(view.objects().some((o) => o.id === 'walker')).toBe(false);
  });

  it('runs the GPU pass only while something changes or the window must follow, and holds nothing before anything presses', () => {
    const field = new InteractionField();
    const r = fakeRenderer();
    const none = stamps([]);
    for (let t = 0; t < 10; t++) expect(field.update(r, none, EYE, t / 60, 1 / 60)).toBe(false);
    expect([r.computes, field.bytes(), field.isLive()]).toEqual([0, 0, false]);
    // One object standing: a pass while it eases in (the stamps differ) and for its recovery after, then none.
    const one = stamps([{ x: 1, z: 1, r: 0.6, k: 1 }]);
    field.update(r, one, EYE, 1, 1 / 60);
    expect(r.computes).toBe(1);
    expect(r.copies).toBe(2);
    expect(field.isLive()).toBe(true);
    // Two RGBA half-float pairs of 256² (2 MiB) and the stamp buffer's 16 slots.
    expect(field.bytes()).toBe(2 * 2 * INTERACTION_TEXELS * INTERACTION_TEXELS * 8 + 16 * STAMP_FLOATS * 4);
    for (let t = 1; t < 3; t += 1 / 60) field.update(r, one, EYE, t, 1 / 60);
    const settled = r.computes;
    for (let t = 3; t < 4; t += 1 / 60) expect(field.update(r, one, EYE, t, 1 / 60)).toBe(false);
    expect(r.computes).toBe(settled);
    expect(field.isLive()).toBe(true);
    // The eye walks a cell: one pass to follow.
    field.update(r, one, [0.3, 1.7, 0], 4.1, 1 / 60);
    expect(r.computes).toBe(settled + 1);
    // It leaves: passes for its recovery, then the field turns off for readers.
    for (let t = 4.2; t < 5.6; t += 1 / 60) field.update(r, none, [0.3, 1.7, 0], t, 1 / 60);
    expect(field.isLive()).toBe(false);
    // Forty objects: the stamp buffer grows (no cap).
    const many = stamps(Array.from({ length: 40 }, (_, k) => ({ x: k, z: 0, r: 0.5, k: 1 })));
    field.update(r, many, EYE, 6, 1 / 60);
    expect(field.state().stamps).toBe(40);
    expect(field.bytes()).toBe(2 * 2 * INTERACTION_TEXELS * INTERACTION_TEXELS * 8 + 64 * STAMP_FLOATS * 4);
    // WebGL 2: no pass.
    const gl = fakeRenderer(true);
    expect(new InteractionField().update(gl, many, EYE, 0, 1 / 60)).toBe(false);
    expect(gl.computes).toBe(0);
  });
});

/** The WGSL three builds for a compute node (no GPU). */
function computeWgsl(node: N): string {
  const renderer = wgslRenderer();
  const b = (renderer as unknown as { backend: { createNodeBuilder(o: unknown, r: unknown): { compute: unknown; build(): void; computeShader: string } } }).backend.createNodeBuilder(null, renderer);
  b.compute = node;
  b.build();
  return b.computeShader;
}

describe('the programs', () => {
  const foliage = (): { lib: ReturnType<typeof createMaterialLibrary>; mesh: THREE.Mesh } => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([{ materialId: 'grass', name: 'grass', shader: 'foliage', params: {}, textures: {} }]);
    const geometry = new THREE.PlaneGeometry(0.2, 0.8);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes['position']!.count * 4).fill(1), 4));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    lib.apply(mesh, { '*': 'grass' });
    return { lib, mesh };
  };

  it('foliage reads the field in its vertex stage on WebGPU (one program for any number of objects), not at all on WebGL 2', () => {
    const { lib, mesh } = foliage();
    const scene = litScene();
    scene.add(mesh);
    const before = wgslOf(wgslRenderer(), scene, mesh);
    // The wind's three reads, the field's pressed amount, its four slope taps and its span.
    expect((before.match(/textureSampleLevel/g) ?? []).length).toBeGreaterThanOrEqual(3 + 6);
    lib.interaction.update(fakeRenderer(), stamps(Array.from({ length: 12 }, (_, k) => ({ x: k, z: 0, r: 0.5, k: 1 }))), EYE, 0, 1 / 60);
    expect(wgslOf(wgslRenderer(), scene, mesh)).toBe(before);
    expect(lib.interaction.reach(0.8)).toBe(0.8);
    const gl = wgslOf(glslRenderer(), scene, mesh);
    expect((gl.match(/texture\w*\(/g) ?? []).length).toBeLessThan((before.match(/textureSampleLevel/g) ?? []).length);
    lib.dispose();
  });

  it('the pass scrolls, decays and stamps every object in one compute program', () => {
    const field = new InteractionField();
    field.update(fakeRenderer(), stamps([{ x: 1, z: 1, r: 0.6, k: 1 }]), EYE, 0, 1 / 60);
    const wgsl = computeWgsl((field as unknown as { pass: N }).pass);
    expect((wgsl.match(/textureStore/g) ?? []).length).toBe(2);
    expect((wgsl.match(/textureLoad/g) ?? []).length).toBe(2);
    expect(wgsl).toMatch(/for \(/);
    expect(wgsl).toMatch(/rgba16float/);
  });

  it('the wind sample is public and reads in a compute pass as in a material', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setWindZones([{ key: 'z', zone: { shape: 'sphere', radius: 5, direction: [0, 1] }, matrix: new THREE.Matrix4().toArray() }]);
    lib.setViewEye(0, 1, 0);
    const out = TSL.instancedArray(64, 'vec4');
    const pass = TSL.Fn(() => {
      const i = TSL.instanceIndex;
      out.element(i).assign(lib.windSample(TSL.vec2(TSL.float(i), 0)));
    })().compute(64, [64]);
    const wgsl = computeWgsl(pass);
    // The zones' map (two textures) and the gust pattern read with an explicit level, as the foliage's vertex stage does.
    expect((wgsl.match(/textureSampleLevel/g) ?? []).length).toBeGreaterThanOrEqual(4);
    lib.dispose();
  });
});
