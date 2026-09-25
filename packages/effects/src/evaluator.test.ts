/**
 * Phase 20.1: the CPU reference semantics — seeded determinism, spawning
 * (rate, bursts, distance, events), initialize shapes, forces, over-life
 * curves and gradients, collisions, kills, spaces, parameters and the
 * output maths. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { newEffectSystemGraph, validateEffect, type EffectDef, type EffectSystem, type GraphData, type GraphValue, type ModelErrorV2 } from '@thirdlight/project-model';

import { billboardAxes, compileEffect, EffectInstance, evalCurve, evalGradient, flipbookFrame, flipbookRect, GradientNoise, hexToLinear, lightParticles, ribbonOrder, type EffectOrigin, type SystemState, type Vec3 } from './index';

type Block = { type: string; data?: Record<string, GraphValue>; id?: string };
type Wire = { from: string; port?: string; to: string; input: string };

/** A system graph: the four contexts with their chains, plus value nodes and wires into block inputs. */
function graph(chains: Partial<Record<'spawn' | 'initialize' | 'update' | 'output', Block[]>>, values: Block[] = [], wires: Wire[] = []): GraphData {
  const g = newEffectSystemGraph() as GraphData;
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks ?? []) {
      const id = b.id ?? `b${n++}`;
      g.nodes.push({ id, type: b.type, position: [200 * n, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      g.edges.push({ id: `e${g.edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  for (const v of values) g.nodes.push({ id: v.id!, type: v.type, position: [0, 900], ...(v.data !== undefined ? { data: v.data } : {}) });
  for (const w of wires) g.edges.push({ id: `e${g.edges.length}`, from: { node: w.from, port: w.port ?? 'value' }, to: { node: w.to, port: w.input } });
  return g;
}

function effect(systems: (Partial<EffectSystem> & { graph: GraphData })[], extra: Partial<EffectDef> = {}): EffectDef {
  const e: EffectDef = {
    effectId: 'fx',
    name: 'Test effect',
    duration: 2,
    loop: true,
    seed: 1,
    bounds: { center: [0, 0, 0], size: [10, 10, 10] },
    systems: systems.map((s, i) => ({ systemId: s.systemId ?? `s${i}`, name: s.name ?? `S${i}`, maxParticles: s.maxParticles ?? 1000, space: s.space ?? 'local', graph: s.graph })),
    ...extra,
  };
  const errors: ModelErrorV2[] = [];
  validateEffect(e, '', errors);
  expect(errors).toEqual([]);
  return e;
}

const DT = 1 / 60;
function run(inst: EffectInstance, seconds: number, origin?: (t: number) => EffectOrigin): void {
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) inst.step(DT, origin !== undefined ? { origin: origin(inst.time + DT) } : {});
}
const pos = (s: SystemState, i: number): Vec3 => s.get3(s.position, i);
const vel = (s: SystemState, i: number): Vec3 => s.get3(s.velocity, i);
const snapshot = (inst: EffectInstance): unknown => inst.systems.map((s) => ({ count: s.count, p: Array.from(s.position.slice(0, s.count * 3)), v: Array.from(s.velocity.slice(0, s.count * 3)), c: Array.from(s.color.slice(0, s.count * 4)), size: Array.from(s.size.slice(0, s.count)) }));

const FOUNTAIN = graph({
  spawn: [{ type: 'spawn.rate', data: { rate: 50 } }, { type: 'spawn.burst', data: { count: 10 } }],
  initialize: [{ type: 'init.position.sphere', data: { radius: 0.3 } }, { type: 'init.velocity.direction', data: { speedMin: 1, speedMax: 3 } }, { type: 'init.lifetime', data: { min: 0.5, max: 1.5 } }, { type: 'init.color.gradient' }, { type: 'init.size', data: { min: 0.05, max: 0.2 } }],
  update: [{ type: 'update.gravity' }, { type: 'update.turbulence', data: { strength: 2 } }, { type: 'update.size.curve' }, { type: 'update.color.gradient' }, { type: 'update.collide.plane', data: { point: [0, -1, 0] } }],
  output: [{ type: 'output.billboard' }],
});

describe('seeded determinism', () => {
  it('the same seed and steps give identical particles; restart replays them; another seed differs', () => {
    const a = new EffectInstance(effect([{ graph: FOUNTAIN }]));
    const b = new EffectInstance(effect([{ graph: FOUNTAIN }]));
    run(a, 1.5);
    run(b, 1.5);
    expect(a.systems[0]!.count).toBeGreaterThan(20);
    expect(snapshot(a)).toEqual(snapshot(b));
    const first = snapshot(a);
    a.restart();
    run(a, 1.5);
    expect(snapshot(a)).toEqual(first);
    const c = new EffectInstance(effect([{ graph: FOUNTAIN }], { seed: 2 }));
    run(c, 1.5);
    expect(snapshot(c)).not.toEqual(first);
  });
});

describe('spawn', () => {
  it('a constant rate carries fractions: 10/s for 1 s gives 10 particles', () => {
    const inst = new EffectInstance(effect([{ graph: graph({ spawn: [{ type: 'spawn.rate', data: { rate: 10 } }], initialize: [{ type: 'init.lifetime', data: { min: 100, max: 100 } }] }) }]));
    run(inst, 1);
    expect(inst.systems[0]!.count).toBe(10);
  });

  it('bursts fire at their times, repeat per cycle when looping and stop after the duration otherwise', () => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 5, time: 0.25, cycles: 3, interval: 0.5 } }], initialize: [{ type: 'init.lifetime', data: { min: 100, max: 100 } }] });
    const loop = new EffectInstance(effect([{ graph: g }]));
    run(loop, 0.2);
    expect(loop.systems[0]!.count).toBe(0);
    run(loop, 0.1);
    expect(loop.systems[0]!.count).toBe(5);
    run(loop, 1.7);
    expect(loop.systems[0]!.count).toBe(15); // 0.25, 0.75, 1.25
    run(loop, 0.5);
    expect(loop.systems[0]!.count).toBe(20); // the next cycle's 0.25
    const once = new EffectInstance(effect([{ graph: g }], { loop: false }));
    run(once, 5);
    expect(once.systems[0]!.count).toBe(15);
    expect(once.alive).toBe(true);
  });

  it('spawns per metre the origin moves, spread along the path (world space)', () => {
    const g = graph({ spawn: [{ type: 'spawn.distance', data: { perMeter: 4 } }], initialize: [{ type: 'init.lifetime', data: { min: 100, max: 100 } }] });
    const inst = new EffectInstance(effect([{ graph: g, space: 'world' }]));
    run(inst, 1, (t) => ({ position: [t * 2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }));
    const s = inst.systems[0]!;
    expect(s.count).toBe(8);
    const xs = Array.from({ length: s.count }, (_, i) => pos(s, i)[0]).sort((x, y) => x - y);
    expect(xs[0]!).toBeGreaterThan(0);
    expect(xs[xs.length - 1]!).toBeCloseTo(2, 1);
  });

  it('respects the capacity and the executor cap', () => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 500 } }], initialize: [{ type: 'init.lifetime', data: { min: 100, max: 100 } }] });
    const inst = new EffectInstance(effect([{ graph: g, maxParticles: 300 }]));
    run(inst, 0.1);
    expect(inst.systems[0]!.count).toBe(300);
    const capped = new EffectInstance(effect([{ graph: g, maxParticles: 300 }]), { capacityLimit: 64 });
    run(capped, 0.1);
    expect(capped.systems[0]!.count).toBe(64);
    expect(capped.diagnostics.some((d) => /capped at 64/.test(d.message))).toBe(true);
  });
});

describe('lifetime, kill conditions and events', () => {
  it('particles die when their age reaches their lifetime', () => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 10 } }], initialize: [{ type: 'init.lifetime', data: { min: 0.5, max: 0.5 } }] });
    const inst = new EffectInstance(effect([{ graph: g }], { loop: false }));
    run(inst, 0.45);
    expect(inst.systems[0]!.count).toBe(10);
    run(inst, 0.1);
    expect(inst.systems[0]!.count).toBe(0);
    expect(inst.alive).toBe(true); // the cycle has not ended
    run(inst, 2);
    expect(inst.alive).toBe(false);
  });

  it('kill volumes and the speed kill remove particles', () => {
    const mk = (kill: Block): number => {
      const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 200 } }], initialize: [{ type: 'init.position.box', data: { size: [4, 4, 4] } }, { type: 'init.lifetime', data: { min: 100, max: 100 } }], update: [kill] });
      const inst = new EffectInstance(effect([{ graph: g }]));
      run(inst, 2 * DT);
      return inst.systems[0]!.count;
    };
    const below = mk({ type: 'update.kill.plane', data: { point: [0, 0, 0], normal: [0, 1, 0] } });
    expect(below).toBeGreaterThan(60);
    expect(below).toBeLessThan(140);
    expect(mk({ type: 'update.kill.sphere', data: { radius: 100 } })).toBe(0);
    expect(mk({ type: 'update.kill.box', data: { size: [100, 100, 100], mode: 'outside' } })).toBe(200);
    expect(mk({ type: 'update.kill.speed', data: { speed: 0.01 } })).toBe(0);
  });

  it('on death → spawn in another system: particles appear where the others died', () => {
    const sparks = graph({ spawn: [{ type: 'spawn.burst', data: { count: 3 } }], initialize: [{ type: 'init.position.box', data: { size: [2, 2, 2] } }, { type: 'init.velocity', data: { min: [0, 1, 0], max: [0, 1, 0] } }, { type: 'init.lifetime', data: { min: 0.2, max: 0.2 } }] });
    const smoke = graph({ spawn: [{ type: 'spawn.event', data: { system: 'sparks', event: 'death', count: 2, inheritVelocity: 0.5 } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }] });
    const inst = new EffectInstance(effect([{ systemId: 'sparks', graph: sparks }, { systemId: 'smoke', graph: smoke }]));
    run(inst, 0.15);
    const [a, b] = inst.systems as [SystemState, SystemState];
    const before = Array.from({ length: a.count }, (_, i) => pos(a, i));
    expect(b.count).toBe(0);
    run(inst, 0.1);
    expect(a.count).toBe(0);
    expect(b.count).toBe(6);
    // Each smoke particle sits where a spark died (a spark moved up ~0.05 m more after the snapshot) and keeps half its velocity.
    for (let i = 0; i < b.count; i++) {
      const p = pos(b, i);
      expect(before.some((q) => Math.abs(q[0] - p[0]) < 1e-5 && Math.abs(q[2] - p[2]) < 1e-5 && p[1] - q[1] > 0 && p[1] - q[1] < 0.1)).toBe(true);
      expect(vel(b, i)[1]).toBeCloseTo(0.5, 5);
    }
  });

  it('a later system reaches an earlier one in the next step', () => {
    const src = graph({ spawn: [{ type: 'spawn.burst', data: { count: 4 } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }] });
    const dst = graph({ spawn: [{ type: 'spawn.event', data: { system: 'late', event: 'birth' } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }] });
    const inst = new EffectInstance(effect([{ systemId: 'early', graph: dst }, { systemId: 'late', graph: src }]));
    inst.step(DT);
    expect(inst.systems[0]!.count).toBe(0);
    inst.step(DT);
    expect(inst.systems[0]!.count).toBe(4);
  });
});

describe('forces', () => {
  const one = (update: Block[], init: Block[] = [], extra: Partial<EffectSystem> = {}): EffectInstance =>
    new EffectInstance(effect([{ graph: graph({ spawn: [{ type: 'spawn.burst', data: { count: 1 } }], initialize: [{ type: 'init.lifetime', data: { min: 100, max: 100 } }, ...init], update }), ...extra }]));

  it('gravity integrates by explicit Euler, independent of mass', () => {
    const inst = one([{ type: 'update.gravity' }], [{ type: 'init.mass', data: { min: 7, max: 7 } }]);
    inst.step(DT); // birth
    for (let k = 0; k < 60; k++) inst.step(DT);
    const s = inst.systems[0]!;
    expect(vel(s, 0)[1]).toBeCloseTo(-9.81, 4);
    // Σ_{k=1..60} (−9.81 k dt) dt
    expect(pos(s, 0)[1]).toBeCloseTo(-9.81 * DT * DT * ((60 * 61) / 2), 4);
  });

  it('drag decays the velocity exponentially with coefficient / mass', () => {
    const inst = one([{ type: 'update.drag', data: { coefficient: 2 } }], [{ type: 'init.velocity', data: { min: [4, 0, 0], max: [4, 0, 0] } }, { type: 'init.mass', data: { min: 2, max: 2 } }]);
    inst.step(DT);
    run(inst, 1);
    expect(vel(inst.systems[0]!, 0)[0]).toBeCloseTo(4 * Math.exp(-1), 4);
  });

  it('wind pulls the velocity toward the global wind', () => {
    const inst = new EffectInstance(effect([{ graph: graph({ spawn: [{ type: 'spawn.burst', data: { count: 1 } }], initialize: [{ type: 'init.lifetime', data: { min: 100, max: 100 } }], update: [{ type: 'update.wind', data: { influence: 5 } }] }) }]), { wind: { direction: [0, 1], strength: 3, gust: 0, gustFrequency: 0, turbulence: 0 } });
    run(inst, 3);
    const v = vel(inst.systems[0]!, 0);
    expect(v[2]).toBeCloseTo(3, 3);
    expect(v[0]).toBeCloseTo(0, 5);
  });

  it('a vortex accelerates around its axis and an attractor toward its point', () => {
    const vortex = one([{ type: 'update.vortex', data: { strength: 1 } }], [{ type: 'init.position.point', data: { offset: [1, 0, 0] } }]);
    vortex.step(DT);
    vortex.step(DT);
    const v = vel(vortex.systems[0]!, 0);
    // axis +Y, radius +X → tangent Y × X = −Z
    expect(v[2]).toBeLessThan(0);
    expect(Math.abs(v[0])).toBeLessThan(1e-6);
    const att = one([{ type: 'update.attractor', data: { position: [0, 5, 0], strength: 2 } }]);
    att.step(DT);
    run(att, 0.5);
    expect(vel(att.systems[0]!, 0)[1]).toBeCloseTo(1, 4);
  });

  it('turbulence is curl noise: divergence-free and the same per seed', () => {
    const n = new GradientNoise(7);
    const e = 1e-3;
    for (const p of [[0.3, 1.7, -2.2], [5.1, 0.2, 3.3], [-1.4, -3.9, 0.8]] as Vec3[]) {
      const c = (x: Vec3): Vec3 => n.curl(x, 2);
      const dx = (c([p[0] + e, p[1], p[2]])[0] - c([p[0] - e, p[1], p[2]])[0]) / (2 * e);
      const dy = (c([p[0], p[1] + e, p[2]])[1] - c([p[0], p[1] - e, p[2]])[1]) / (2 * e);
      const dz = (c([p[0], p[1], p[2] + e])[2] - c([p[0], p[1], p[2] - e])[2]) / (2 * e);
      const mag = Math.hypot(...c(p));
      expect(mag).toBeGreaterThan(0.01);
      expect(Math.abs(dx + dy + dz)).toBeLessThan(0.05 * Math.max(1, mag));
    }
    expect(new GradientNoise(7).curl([1, 2, 3])).toEqual(n.curl([1, 2, 3]));
    expect(new GradientNoise(8).curl([1, 2, 3])).not.toEqual(n.curl([1, 2, 3]));
  });

  it('a plane collision bounces with the bounce share of the normal speed and raises collision events', () => {
    const inst = one([{ type: 'update.gravity' }, { type: 'update.collide.plane', data: { point: [0, 0, 0], bounce: 0.5, friction: 0 } }], [{ type: 'init.position.point', data: { offset: [0, 1, 0] } }]);
    let hit = false;
    let maxUp = 0;
    for (let k = 0; k < 120; k++) {
      inst.step(DT);
      const s = inst.systems[0]!;
      expect(pos(s, 0)[1]).toBeGreaterThanOrEqual(-1e-6);
      if (s.events.collision.length > 0 && !hit) {
        hit = true;
        maxUp = vel(s, 0)[1];
      }
    }
    expect(hit).toBe(true);
    // ~ half of the impact speed sqrt(2 g h) ≈ 4.43 m/s
    expect(maxUp).toBeGreaterThan(1.9);
    expect(maxUp).toBeLessThan(2.4);
  });

  it('scene-depth collision is a no-op on the CPU executor and says so', () => {
    const inst = one([{ type: 'update.collide.depth' }]);
    expect(inst.diagnostics.some((d) => d.severity === 'info' && /WebGPU/.test(d.message))).toBe(true);
  });
});

describe('curves, gradients and over-life blocks', () => {
  it('curves are linear between keys and clamped outside; gradients interpolate in sRGB and convert to linear', () => {
    expect(evalCurve([0, 1, 1, 0], 0.25)).toBeCloseTo(0.75);
    expect(evalCurve([0.2, 2, 0.6, 4, 1, 0], 0.4)).toBeCloseTo(3);
    expect(evalCurve([0.2, 2, 0.6, 4], 0)).toBe(2);
    expect(evalCurve([0.2, 2, 0.6, 4], 1)).toBe(4);
    const g = evalGradient([0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 0.5);
    expect(g[0]).toBeCloseTo(0.214, 3); // sRGB 0.5 → linear
    expect(g[2]).toBeCloseTo(0.214, 3);
    expect(g[3]).toBeCloseTo(0.5);
    expect(hexToLinear('#ffffff', 0.5)).toEqual([1, 1, 1, 0.5]);
  });

  it('size over life scales the initial size; colour over life multiplies the initial colour', () => {
    const g = graph({
      spawn: [{ type: 'spawn.burst', data: { count: 1 } }],
      initialize: [{ type: 'init.lifetime', data: { min: 1, max: 1 } }, { type: 'init.size', data: { min: 2, max: 2 } }, { type: 'init.color', data: { color: '#ff0000', alpha: 1 } }],
      update: [{ type: 'update.size.curve', data: { curve: [0, 1, 1, 0] } }, { type: 'update.color.gradient', data: { gradient: [0, 1, 1, 1, 1, 1, 1, 1, 1, 0] } }],
    });
    const inst = new EffectInstance(effect([{ graph: g }]));
    inst.step(DT);
    for (let k = 0; k < 30; k++) inst.step(DT);
    const s = inst.systems[0]!;
    expect(s.size[0]!).toBeCloseTo(2 * (1 - 0.5), 2);
    expect(s.baseSize[0]!).toBe(2);
    expect(s.color[0]!).toBeCloseTo(1, 5);
    expect(s.color[1]!).toBeCloseTo(0, 5);
    expect(s.color[3]!).toBeCloseTo(0.5, 2);
  });

  it('a speed limit curve caps the speed', () => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 1 } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }, { type: 'init.velocity', data: { min: [30, 0, 0], max: [30, 0, 0] } }], update: [{ type: 'update.velocity.curve', data: { curve: [0, 2, 1, 2] } }] });
    const inst = new EffectInstance(effect([{ graph: g }]));
    inst.step(DT);
    inst.step(DT);
    expect(vel(inst.systems[0]!, 0)[0]).toBeCloseTo(2, 5);
  });
});

describe('initialize shapes and spaces', () => {
  const shape = (b: Block): SystemState => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 300 } }], initialize: [b, { type: 'init.lifetime', data: { min: 10, max: 10 } }] });
    const inst = new EffectInstance(effect([{ graph: g }]), { mesh: (id) => (id === 'tri' ? { positions: [0, 0, 0, 2, 0, 0, 0, 0, 2] } : null) });
    inst.step(DT);
    return inst.systems[0]!;
  };
  const all = (s: SystemState): Vec3[] => Array.from({ length: s.count }, (_, i) => pos(s, i));

  it('sphere, box, circle, cone, line and mesh keep their points on the shape', () => {
    expect(all(shape({ type: 'init.position.sphere', data: { radius: 2, center: [1, 0, 0] } })).every((p) => Math.hypot(p[0] - 1, p[1], p[2]) <= 2 + 1e-5)).toBe(true);
    expect(all(shape({ type: 'init.position.sphere', data: { radius: 2, surface: true } })).every((p) => Math.abs(Math.hypot(...p) - 2) < 1e-4)).toBe(true);
    expect(all(shape({ type: 'init.position.box', data: { size: [2, 4, 6] } })).every((p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 2 && Math.abs(p[2]) <= 3)).toBe(true);
    expect(all(shape({ type: 'init.position.box', data: { size: [2, 2, 2], surface: true } })).every((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) > 1 - 1e-5)).toBe(true);
    expect(all(shape({ type: 'init.position.circle', data: { radius: 1, axis: 'y', edge: true } })).every((p) => Math.abs(p[1]) < 1e-6 && Math.abs(Math.hypot(p[0], p[2]) - 1) < 1e-4)).toBe(true);
    expect(all(shape({ type: 'init.position.line', data: { start: [0, 0, 0], end: [0, 0, 5] } })).every((p) => p[0] === 0 && p[1] === 0 && p[2] >= 0 && p[2] <= 5)).toBe(true);
    expect(all(shape({ type: 'init.position.mesh', data: { model: 'tri' } })).every((p) => Math.abs(p[1]) < 1e-6 && p[0] >= 0 && p[2] >= 0 && p[0] + p[2] <= 2 + 1e-5)).toBe(true);
  });

  it('a cone sprays its velocity within the angle around the axis', () => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 300 } }], initialize: [{ type: 'init.position.cone', data: { angle: 20 } }, { type: 'init.velocity.direction', data: { speedMin: 1, speedMax: 1 } }, { type: 'init.lifetime', data: { min: 10, max: 10 } }] });
    const inst = new EffectInstance(effect([{ graph: g }]));
    inst.step(DT);
    const s = inst.systems[0]!;
    for (let i = 0; i < s.count; i++) expect(vel(s, i)[1]).toBeGreaterThanOrEqual(Math.cos((20 * Math.PI) / 180) - 1e-5);
  });

  it('world-space particles stay where they were born; local ones move with the origin', () => {
    const g = graph({ spawn: [{ type: 'spawn.burst', data: { count: 5 } }], initialize: [{ type: 'init.position.point', data: { offset: [0, 1, 0] } }, { type: 'init.lifetime', data: { min: 10, max: 10 } }] });
    const at = (x: number): EffectOrigin => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const world = new EffectInstance(effect([{ graph: g, space: 'world' }]));
    world.step(DT, { origin: at(3) });
    world.step(DT, { origin: at(10) });
    expect(pos(world.systems[0]!, 0)).toEqual([3, 1, 0]);
    const local = new EffectInstance(effect([{ graph: g }]));
    local.step(DT, { origin: at(3) });
    local.step(DT, { origin: at(10) });
    expect(pos(local.systems[0]!, 0)).toEqual([0, 1, 0]);
    // A rotated origin turns a world-space system's offsets: 90° about Z sends +Y to −X.
    const turned = new EffectInstance(effect([{ graph: g, space: 'world' }]));
    turned.step(DT, { origin: { position: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [1, 1, 1] } });
    const p = pos(turned.systems[0]!, 0);
    expect(p[0]).toBeCloseTo(-1, 5);
    expect(p[1]).toBeCloseTo(0, 5);
  });
});

describe('values and parameters', () => {
  it('reads public parameters (overridable), ignores private overrides and flags undeclared keys', () => {
    const g = graph(
      { spawn: [{ type: 'spawn.burst', id: 'burst', data: { count: 1 } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }] },
      [{ id: 'n', type: 'value.parameter', data: { key: 'count' } }, { id: 'ghost', type: 'value.parameter', data: { key: 'ghost' } }],
      [{ from: 'n', to: 'burst', input: 'count' }],
    );
    const params: EffectDef['parameters'] = [{ key: 'count', type: 'float', default: 7 }];
    const base = new EffectInstance(effect([{ graph: g }], { parameters: params }));
    base.step(DT);
    expect(base.systems[0]!.count).toBe(7);
    expect(base.diagnostics.some((d) => d.nodeId === 'ghost' && d.severity === 'error')).toBe(true);
    const over = new EffectInstance(effect([{ graph: g }], { parameters: params }), { params: { count: 12 } });
    over.step(DT);
    expect(over.systems[0]!.count).toBe(12);
    const priv = new EffectInstance(effect([{ graph: g }], { parameters: [{ key: 'count', type: 'float', default: 3, visibility: 'private' }] }), { params: { count: 12 } });
    priv.step(DT);
    expect(priv.systems[0]!.count).toBe(3);
  });

  it('a Random node is fixed per particle; maths and an age curve feed block inputs', () => {
    const g = graph(
      { spawn: [{ type: 'spawn.burst', data: { count: 50 } }], initialize: [{ type: 'init.lifetime', data: { min: 1, max: 1 } }, { type: 'init.size', id: 'size' }], update: [] },
      [
        { id: 'r', type: 'value.random', data: { min: 1, max: 2 } },
        { id: 'k', type: 'value.float', data: { value: 3 } },
        { id: 'mul', type: 'math.multiply' },
      ],
      [
        { from: 'r', to: 'mul', input: 'a' },
        { from: 'k', to: 'mul', input: 'b' },
        { from: 'mul', port: 'out', to: 'size', input: 'min' },
        { from: 'mul', port: 'out', to: 'size', input: 'max' },
      ],
    );
    const inst = new EffectInstance(effect([{ graph: g }]));
    inst.step(DT);
    const s = inst.systems[0]!;
    const sizes = Array.from(s.size.slice(0, s.count));
    expect(sizes.every((x) => x >= 3 - 1e-5 && x <= 6 + 1e-5)).toBe(true);
    expect(new Set(sizes.map((x) => x.toFixed(4))).size).toBeGreaterThan(40);
  });

  it('warns about blocks off every chain and a missing renderer', () => {
    const g = graph({ spawn: [{ type: 'spawn.rate' }] }, [{ id: 'lonely', type: 'update.gravity' }, { id: 'maths', type: 'math.oneMinus' }]);
    const p = compileEffect(effect([{ graph: g }]));
    expect(p.diagnostics.some((d) => d.nodeId === 'lonely' && /not on its context's chain/.test(d.message))).toBe(true);
    expect(p.diagnostics.some((d) => d.nodeId === 'maths')).toBe(false);
    expect(p.diagnostics.some((d) => /no renderer/.test(d.message))).toBe(true);
  });
});

describe('output maths', () => {
  it('flipbook frames over the life or at a frame rate, and their UV rectangles', () => {
    const f = { flipbook: 'overLife', columns: 4, rows: 2, fps: 12 };
    expect(flipbookFrame(f, 0, 1)).toBe(0);
    expect(flipbookFrame(f, 0.5, 1)).toBe(4);
    expect(flipbookFrame(f, 1, 1)).toBe(7);
    expect(flipbookFrame({ ...f, flipbook: 'fps' }, 1, 10)).toBe(4); // 12 frames in 1 s, 8 frames
    expect(flipbookFrame({ ...f, flipbook: 'none' }, 1, 10)).toBe(0);
    expect(flipbookRect(f, 5)).toEqual([0.25, 0, 0.5, 0.5]);
  });

  it('billboard axes face the camera, follow the velocity or turn around an axis', () => {
    const cam = { right: [1, 0, 0] as Vec3, up: [0, 1, 0] as Vec3, forward: [0, 0, -1] as Vec3 };
    expect(billboardAxes('camera', cam, [5, 0, 0], [0, 1, 0])).toEqual({ right: [1, 0, 0], up: [0, 1, 0] });
    const v = billboardAxes('velocity', cam, [3, 0, 0], [0, 1, 0]);
    expect(v.up).toEqual([1, 0, 0]);
    expect(Math.abs(v.right[1])).toBeCloseTo(1);
    expect(billboardAxes('velocity', cam, [0, 0, 0], [0, 1, 0])).toEqual({ right: [1, 0, 0], up: [0, 1, 0] });
    expect(billboardAxes('axis', cam, [0, 0, 0], [0, 2, 0]).up).toEqual([0, 1, 0]);
  });

  it('lights go to the oldest particles; ribbons join them in birth order; trails record positions', () => {
    const g = graph({ spawn: [{ type: 'spawn.rate', data: { rate: 60 } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }, { type: 'init.velocity', data: { min: [1, 0, 0], max: [1, 0, 0] } }], output: [{ type: 'output.ribbon', data: { mode: 'trail', segments: 4, trailLength: 0.2 } }, { type: 'output.light', data: { maxLights: 2 } }] });
    const inst = new EffectInstance(effect([{ graph: g }]));
    run(inst, 0.5);
    const s = inst.systems[0]!;
    const lights = lightParticles(s, 2);
    expect(lights.map((i) => s.serial[i])).toEqual([0, 1]);
    const order = ribbonOrder(s).map((i) => s.serial[i]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const oldest = lights[0]!;
    expect(s.trailCount![oldest]).toBe(4);
    // Newest first, moving +X: the recorded x values decrease.
    const t = Array.from(s.trail!.slice(oldest * 12, oldest * 12 + 12));
    expect(t[0]!).toBeGreaterThan(t[3]!);
    expect(t[3]!).toBeGreaterThan(t[6]!);
  });
});
