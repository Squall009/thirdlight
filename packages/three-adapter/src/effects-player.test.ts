/**
 * The effect player's plumbing (no GPU: the CPU executor draws
 * into node materials; the WebGPU executor's passes are recorded by a stub
 * renderer) — executor choice per backend and per effect, caps, pooling,
 * requests (plays, stops, component signals), diagnostics. Neutral fixtures.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { compileEffect } from '@thirdlight/effects';

import { EffectLights } from './effect-lights';
import { EFFECT_LIGHT_LIMIT } from './effects-draw';
import { createEffectsPlayer, EFFECT_CAPS, type EffectDefLike } from './effects-player';
import { GpuEffectExecutor, gpuUnsupportedReason } from './effects-gpu';

type Block = { type: string; data?: Record<string, unknown> };
function graph(chains: Partial<Record<'spawn' | 'initialize' | 'update' | 'output', Block[]>>): EffectDefLike['systems'][number]['graph'] {
  const nodes: { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }[] = ['spawn', 'initialize', 'update', 'output'].map((c) => ({ id: c, type: c, position: [0, 0] }));
  const edges: { id: string; from: { node: string; port: string }; to: { node: string; port: string } }[] = [];
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks ?? []) {
      const id = `b${n++}`;
      nodes.push({ id, type: b.type, position: [0, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  return { nodes, edges } as never;
}
const fx = (effectId: string, chains: Parameters<typeof graph>[0], o: { loop?: boolean; maxParticles?: number } = {}): EffectDefLike => ({
  effectId,
  name: effectId,
  duration: 1,
  loop: o.loop ?? false,
  seed: 1,
  bounds: { center: [0, 0, 0], size: [100, 100, 100] },
  systems: [{ systemId: 's', name: 'S', maxParticles: o.maxParticles ?? 100, space: 'world', graph: graph(chains) }],
});
const BURST = fx('burst', { spawn: [{ type: 'spawn.burst', data: { count: 50 } }], initialize: [{ type: 'init.lifetime', data: { min: 0.2, max: 0.2 } }], output: [{ type: 'output.billboard' }] });
const FOUNTAIN = fx('fountain', { spawn: [{ type: 'spawn.rate', data: { rate: 60 } }], output: [{ type: 'output.billboard', data: { blend: 'additive' } }] }, { loop: true });
const BIG = fx('big', { spawn: [{ type: 'spawn.rate', data: { rate: 1 } }], output: [{ type: 'output.billboard' }] }, { loop: true, maxParticles: 100_000 });
const TRAIL = fx('trail', { spawn: [{ type: 'spawn.rate', data: { rate: 10 } }], output: [{ type: 'output.ribbon' }] }, { loop: true });

/** A stub renderer: WebGL coordinates; records compute passes (the WebGPU executor's). */
function stubRenderer(): { r: THREE.WebGPURenderer; computes: { node: unknown; count: number | null }[] } {
  const computes: { node: unknown; count: number | null }[] = [];
  const r = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    compute: (node: unknown, count: number | null = null) => void computes.push({ node, count }),
    getArrayBufferAsync: async () => new Int32Array([0]).buffer,
  } as unknown as THREE.WebGPURenderer;
  return { r, computes };
}
const camera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  c.position.set(0, 0, 20);
  c.lookAt(0, 0, 0);
  return c;
};
const play = (effectId: string, handle: number, position: [number, number, number] = [0, 0, 0]) => ({ op: 'play' as const, effectId, handle, entityId: null, position, params: null, source: 'script' });

describe('effect player (CPU executor on WebGL 2)', () => {
  it('adds the light pool as one object before the first frame and never changes the scene\'s lights while lights rise', () => {
    const GLOW = fx('glow', { spawn: [{ type: 'spawn.rate', data: { rate: 30 } }], initialize: [{ type: 'init.lifetime', data: { min: 5, max: 5 } }], output: [{ type: 'output.light', data: { maxLights: 1 } }] }, { loop: true });
    const lightsOf = (scene: THREE.Scene): THREE.Light[] => scene.children.filter((o): o is THREE.Light => (o as THREE.Light).isLight === true);
    const poolOf = (scene: THREE.Scene): EffectLights | undefined => scene.children.find((o): o is EffectLights => o instanceof EffectLights);
    // A game without light-emitting effects carries no pool.
    const plain = new THREE.Scene();
    createEffectsPlayer({ scene: plain, defs: [FOUNTAIN], loadTexture: async () => null });
    expect(lightsOf(plain)).toHaveLength(0);
    const scene = new THREE.Scene();
    const p = createEffectsPlayer({ scene, defs: [FOUNTAIN, GLOW], loadTexture: async () => null });
    const reserved = lightsOf(scene);
    expect(reserved).toHaveLength(1);
    expect(poolOf(scene)?.slots).toHaveLength(EFFECT_LIGHT_LIMIT);
    expect(poolOf(scene)?.count).toBe(0);
    const { r } = stubRenderer();
    p.setRenderer(r, 'webgl2');
    const cam = camera();
    for (let k = 1; k <= EFFECT_LIGHT_LIMIT + 2; k++) {
      p.request(play('glow', k, [k - 9, 0, 0]), () => undefined);
      for (let f = 0; f < 3; f++) p.update(1 / 30, cam);
      expect(lightsOf(scene)).toEqual(reserved);
      expect(p.diagnostics().lights).toBe(Math.min(k, EFFECT_LIGHT_LIMIT));
      // Only the slots in use are shaded.
      expect(poolOf(scene)?.count).toBe(Math.min(k, EFFECT_LIGHT_LIMIT));
    }
    expect(p.diagnostics().lightPool).toBe(EFFECT_LIGHT_LIMIT);
    expect(poolOf(scene)!.slots.filter((l) => l.intensity > 0)).toHaveLength(EFFECT_LIGHT_LIMIT);
    // An effect that gains a light output in an edit reserves the pool then, once.
    const later = new THREE.Scene();
    const q = createEffectsPlayer({ scene: later, defs: [FOUNTAIN], loadTexture: async () => null });
    q.setDefs([FOUNTAIN, GLOW]);
    q.setDefs([GLOW]);
    expect(lightsOf(later)).toHaveLength(1);
    p.dispose();
    expect(lightsOf(scene)).toHaveLength(0);
  });

  it('plays requests on the CPU executor, reports caps and unknown effects, stops by handle', () => {
    const scene = new THREE.Scene();
    const p = createEffectsPlayer({ scene, defs: [BURST, FOUNTAIN], loadTexture: async () => null });
    const { r } = stubRenderer();
    p.setRenderer(r, 'webgl2');
    p.request(play('fountain', 1), () => undefined);
    p.request(play('nope', 2), () => undefined);
    const cam = camera();
    for (let k = 0; k < 30; k++) p.update(1 / 30, cam);
    let d = p.diagnostics();
    expect(d.executor).toBe('cpu');
    expect(d.caps).toEqual({ ...EFFECT_CAPS.cpu, lights: EFFECT_LIGHT_LIMIT, sortLimit: null });
    expect(d.playing).toBe(1);
    expect(d.particles).toBe(60);
    expect(d.unknownEffects).toEqual(['nope']);
    expect(d.instances).toEqual([{ effectId: 'fountain', executor: 'cpu', particles: 60 }]);
    // Drawn: one billboard mesh, 60 instances.
    const mesh = scene.getObjectByName('effect fountain')!.children[0] as THREE.Mesh & { count: number };
    expect(mesh.count).toBe(60);
    // Stop: spawning ends, the particles finish (1 s lifetime), the play ends.
    p.request({ op: 'stop', effectId: '', handle: 1, entityId: null, position: [0, 0, 0], params: null, source: 'script' }, () => undefined);
    for (let k = 0; k < 45; k++) p.update(1 / 30, cam);
    d = p.diagnostics();
    expect(d.playing).toBe(0);
    p.dispose();
  });

  it('pools a finished one-shot and reuses it for the next play of that effect', () => {
    const scene = new THREE.Scene();
    const p = createEffectsPlayer({ scene, defs: [BURST], loadTexture: async () => null });
    p.setRenderer(stubRenderer().r, 'webgl2');
    const cam = camera();
    p.request(play('burst', 1), () => undefined);
    p.update(1 / 30, cam);
    const first = scene.getObjectByName('effect burst');
    expect(p.diagnostics().particles).toBe(50);
    // The one-shot ends after its 1 s cycle (its particles died at 0.2 s).
    for (let k = 0; k < 35; k++) p.update(1 / 30, cam);
    expect(p.diagnostics().playing).toBe(0);
    expect(scene.getObjectByName('effect burst')).toBeUndefined();
    p.request(play('burst', 2), () => undefined);
    p.update(1 / 30, cam);
    expect(scene.getObjectByName('effect burst')).toBe(first);
    expect(p.diagnostics().particles).toBe(50);
    p.dispose();
  });

  it('refuses plays past the total particle cap (capacities are capped per system first)', () => {
    const p = createEffectsPlayer({ scene: new THREE.Scene(), defs: [BIG], loadTexture: async () => null });
    p.setRenderer(stubRenderer().r, 'webgl2');
    const per = EFFECT_CAPS.cpu.particlesPerSystem;
    const fit = Math.floor(EFFECT_CAPS.cpu.particlesTotal / per);
    for (let k = 0; k <= fit; k++) p.request(play('big', k + 1), () => undefined);
    const d = p.diagnostics();
    expect(d.playing).toBe(fit);
    expect(d.refused).toBe(1);
    p.dispose();
  });

  it('an attached component plays from its object, restarts on its signal and ends with its entity', () => {
    const scene = new THREE.Scene();
    const p = createEffectsPlayer({ scene, defs: [BURST], loadTexture: async () => null });
    const holder = new THREE.Group();
    holder.position.set(5, 0, 0);
    scene.add(holder);
    p.attach('lamp-0001', holder, { effectId: 'burst' }, true);
    expect(p.diagnostics().playing).toBe(0); // no renderer yet
    p.setRenderer(stubRenderer().r, 'webgl2');
    const cam = camera();
    p.update(1 / 30, cam);
    expect(p.diagnostics().particles).toBe(50);
    for (let k = 0; k < 15; k++) p.update(1 / 30, cam);
    // A finished component play stays attached (nothing left) until its signal restarts it.
    expect(p.diagnostics().playing).toBe(1);
    expect(p.diagnostics().particles).toBe(0);
    p.request({ op: 'play', effectId: 'burst', handle: 3, entityId: 'lamp-0001', position: [0, 0, 0], params: null, source: 'component' }, () => holder);
    p.update(1 / 30, cam);
    expect(p.diagnostics().particles).toBe(50);
    p.detach('lamp-0001');
    expect(p.diagnostics().playing).toBe(0);
    p.dispose();
  });
});

describe('WebGPU executor plumbing', () => {
  it('runs on WebGPU unless the effect uses what only the CPU runs (the reason is reported)', () => {
    expect(gpuUnsupportedReason(compileEffect(FOUNTAIN))).toBeNull();
    expect(gpuUnsupportedReason(compileEffect(TRAIL))).toMatch(/ribbons/);
    const lights = fx('lights', { spawn: [{ type: 'spawn.rate' }], output: [{ type: 'output.light' }] });
    expect(gpuUnsupportedReason(compileEffect(lights))).toMatch(/lights/);
    const events = fx('events', { spawn: [{ type: 'spawn.event', data: { system: 's' } }], output: [{ type: 'output.billboard' }] });
    expect(gpuUnsupportedReason(compileEffect(events))).toMatch(/events/);
    const mesh = fx('mesh', { spawn: [{ type: 'spawn.rate' }], initialize: [{ type: 'init.position.mesh', data: { model: 'm' } }], output: [{ type: 'output.billboard' }] });
    expect(gpuUnsupportedReason(compileEffect(mesh))).toMatch(/mesh surface/);

    const p = createEffectsPlayer({ scene: new THREE.Scene(), defs: [TRAIL], loadTexture: async () => null });
    p.setRenderer(stubRenderer().r, 'webgpu');
    p.request(play('trail', 1), () => undefined);
    const d = p.diagnostics();
    expect(d.executor).toBe('webgpu');
    expect(d.caps.particlesPerSystem).toBe(EFFECT_CAPS.webgpu.particlesPerSystem);
    expect(d.instances[0]).toMatchObject({ effectId: 'trail', executor: 'cpu' });
    expect(d.instances[0]!.reason).toMatch(/ribbons/);
    p.dispose();
  });

  it('each step runs the update pass, then the spawn pass for exactly the planned births', () => {
    const { r, computes } = stubRenderer();
    const gpu = new GpuEffectExecutor(FOUNTAIN, { capacityLimit: 1000, sortedSystems: new Set() });
    for (let k = 0; k < 6; k++) gpu.step(r, 1 / 60, {});
    // 60/s at 1/60 s: one birth per step; update + spawn per step.
    expect(computes).toHaveLength(12);
    expect(computes.filter((c) => c.count === 1)).toHaveLength(6);
    const plans = gpu.planner.plans();
    expect(plans[0]).toEqual({ serialBase: 5, count: 1, runs: [{ count: 1, distance: false }] });
    // A burst is planned once, with its serial numbers.
    const b = new GpuEffectExecutor(BURST, { capacityLimit: 1000, sortedSystems: new Set() });
    b.step(r, 1 / 60, {});
    expect(b.planner.plans()[0]).toEqual({ serialBase: 0, count: 50, runs: [{ count: 50, distance: false }] });
    b.step(r, 1 / 60, {});
    expect(b.planner.plans()[0]!.count).toBe(0);
    gpu.dispose();
    b.dispose();
  });
});
