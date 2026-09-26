/**
 * Phase 23.1: the runtime's 3D blocks with a scripted 3D port (the
 * character moves exactly as staged and stands on y = 0) — the exact
 * capsule-vs-volume geometry, 3D triggers (box turned with its entity,
 * sphere, capsule) entering and leaving as the player falls through them,
 * their signals and `ctx.triggerEvents`, a mover posed on the port with its
 * rotation and carrying the player standing on it, and the lifted ownership
 * rule (a script may own a collider in 3D, not in the 2D plane, never a
 * mover's or the controller's).
 */
import { describe, expect, it } from 'vitest';

import { segmentBoxDistance2, segmentPointDistance2, segmentSegmentDistance2 } from './blocks';
import {
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type BehaviorArtifact,
  type CharacterMoveResult3D,
  type KinematicPose3D,
  type PhysicsPort3D,
  type PhysicsVec3,
  type SimulationModuleSpec,
} from './index';
import { probeSpec } from './m2-helpers';

const DT = 1 / 120;
type V = [number, number, number];

describe('3D capsule geometry', () => {
  // Brute force: the closest of many samples along the segment (and, for two segments, pairs of samples).
  const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const d2 = (p: V, q: V): number => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const boxD2 = (p: V, h: V): number => [0, 1, 2].reduce((s, i) => s + Math.max(0, Math.abs(p[i]!) - h[i]!) ** 2, 0);
  const rnd = (() => {
    let x = 12345;
    return (): number => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648 - 0.5;
    };
  })();
  const pt = (s: number): V => [rnd() * s, rnd() * s, rnd() * s];

  it('segment–point, segment–segment and segment–box distances match a fine brute force', () => {
    for (let k = 0; k < 40; k += 1) {
      const a = pt(6);
      const b = pt(6);
      const p = pt(6);
      const c = pt(6);
      const e = pt(6);
      const h: V = [Math.abs(rnd()) + 0.1, Math.abs(rnd()) + 0.1, Math.abs(rnd()) + 0.1];
      let bp = Infinity;
      let bs = Infinity;
      let bb = Infinity;
      for (let i = 0; i <= 400; i += 1) {
        const s = lerp(a, b, i / 400);
        bp = Math.min(bp, d2(s, p));
        bb = Math.min(bb, boxD2(s, h));
        for (let j = 0; j <= 40; j += 1) bs = Math.min(bs, d2(s, lerp(c, e, j / 40)));
      }
      expect(Math.sqrt(segmentPointDistance2(a, b, p))).toBeCloseTo(Math.sqrt(bp), 2);
      expect(Math.sqrt(segmentSegmentDistance2(a, b, c, e))).toBeLessThanOrEqual(Math.sqrt(bs) + 1e-9);
      expect(Math.sqrt(segmentSegmentDistance2(a, b, c, e))).toBeGreaterThan(Math.sqrt(bs) - 0.1);
      expect(Math.sqrt(segmentBoxDistance2(a, b, h))).toBeCloseTo(Math.sqrt(bb), 2);
    }
    // Exact cases.
    expect(segmentPointDistance2([0, -1, 0], [0, 1, 0], [2, 0, 0])).toBeCloseTo(4, 12);
    expect(segmentSegmentDistance2([0, -1, 0], [0, 1, 0], [1, 0, -1], [1, 0, 1])).toBeCloseTo(1, 12);
    expect(segmentBoxDistance2([2, -1, 0], [2, 1, 0], [1, 1, 1])).toBeCloseTo(1, 9);
    expect(segmentBoxDistance2([0, -5, 0], [0, 5, 0], [1, 1, 1])).toBe(0);
  });
});

/** A scripted 3D port: the character moves exactly as staged and stands on y = 0 (its feet 0.9 m below its origin). */
function scriptedPort(start: PhysicsVec3): PhysicsPort3D & { poses: KinematicPose3D[][]; added: string[] } {
  let p = { ...start };
  let staged: PhysicsVec3 = { x: 0, y: 0, z: 0 };
  const poses: KinematicPose3D[][] = [];
  const added: string[] = [];
  let ground: string | null = null;
  return {
    dimension: 3,
    poses,
    added,
    stageCharacterMove(d) {
      staged = { ...d };
    },
    step(): CharacterMoveResult3D {
      const requested = staged;
      staged = { x: 0, y: 0, z: 0 };
      const before = p;
      const floor = ground !== null ? 1.1 : 0.9;
      const y = Math.max(floor, before.y + requested.y);
      p = { x: before.x + requested.x, y, z: before.z + requested.z };
      const grounded = y === floor;
      return {
        requested,
        applied: { x: p.x - before.x, y: p.y - before.y, z: p.z - before.z },
        position: { ...p },
        grounded,
        supportNormal: { x: 0, y: 1, z: 0 },
        contacts: { ground: grounded, wall: false, head: false, steepSlope: false },
        snapped: false,
        groundEntityId: grounded ? ground : null,
        kinematicSlack: 0.5,
      };
    },
    setKinematicPoses(list) {
      poses.push(list.map((x) => ({ ...x })));
    },
    addStaticColliders(specs) {
      for (const s of specs) added.push(`${s.entityId}:${s.kinematic === true ? 'kinematic' : 'fixed'}`);
    },
    removeStaticColliders() {},
    dispose() {},
    // Test hook: what the character stands on (a lift under it).
    set standOn(id: string | null) {
      ground = id;
    },
  } as PhysicsPort3D & { poses: KinematicPose3D[][]; added: string[] };
}

const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const CAM = { id: 'cam-main', components: { transform: T([0, 2, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 100 } } };
const snap = (entities: unknown[]) => ({ snapshotId: 'p3@r1', projectId: 'p3', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, game: null });
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

/** Run with a probe module (intent phase) that records each step's signals and trigger events. */
function runWith(entities: unknown[], port: PhysicsPort3D, steps: number, signals: string[]): { log: string[]; rt: ReturnType<typeof instantiateRuntime> } {
  const log: string[] = [];
  const probe = probeSpec({
    id: 'thirdlight.test:probe3d',
    phases: ['intent'],
    step: (_phase, ctx) => {
      for (const s of signals) if (ctx.signals?.on(s)) log.push(`${ctx.stepIndex} signal ${s}`);
      for (const e of ctx.triggerEvents ?? []) log.push(`${e.stepIndex} ${e.type} ${e.trigger}`);
    },
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, probe.id, probe);
  const res = instantiateRuntime({ snapshot: snap(entities), registry, modules: [probe.id], driver: { kind: 'manual' }, clock: () => 0, physics: port, settings: SETTINGS });
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  const rt = res.runtime;
  rt.start();
  for (let i = 0; i <= steps; i += 1) rt.tick(i * DT);
  return { log, rt: res };
}

const turnY = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
const turnZ = (deg: number) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];

describe('3D triggers and movers in the runtime', () => {
  it('a falling player enters and leaves a sphere, a turned box and a lying capsule, each once, in step order', () => {
    const entities = [
      CAM,
      { id: 'player-0001', components: { transform: T([0, 12, 0]), controller: {} } },
      // Centres on the fall line at y = 9, 6 and 3: the capsule (±0.9 m tall, radius 0.3) passes through each.
      { id: 'trig-a', components: { transform: T([0.5, 9, 0]), trigger: { shape: 'sphere', radius: 0.3, signal: 'a', exitSignal: 'a_out' } } },
      { id: 'trig-b', components: { transform: T([0, 6, 0.9], turnY(45)), trigger: { shape: 'box', size: [1, 0.2, 1], signal: 'b' } } },
      { id: 'trig-c', components: { transform: T([0, 3, 0], turnZ(90)), trigger: { shape: 'capsule', radius: 0.1, height: 3, signal: 'c', mode: 'stay' } } },
      // Beside the fall line (a 0.35 m gap to the capsule's side): never entered.
      { id: 'trig-d', components: { transform: T([0.95, 6, 0]), trigger: { shape: 'sphere', radius: 0.3, signal: 'd' } } },
    ];
    const port = scriptedPort({ x: 0, y: 12, z: 0 });
    const { log } = runWith(entities, port, 240, ['a', 'a_out', 'b', 'c', 'd']);
    const kinds = log.map((l) => l.replace(/^\d+ /, ''));
    // Each trigger: enter then exit, in the order the capsule reaches them; "d" never fires.
    const order = kinds.filter((k) => k.startsWith('enter') || k.startsWith('exit'));
    expect(order).toEqual(['enter trig-a', 'exit trig-a', 'enter trig-b', 'exit trig-b', 'enter trig-c', 'exit trig-c']);
    expect(kinds.filter((k) => k === 'signal a')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'signal a_out')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'signal b')).toHaveLength(1);
    // "stay": every step while inside (more than one).
    expect(kinds.filter((k) => k === 'signal c').length).toBeGreaterThan(1);
    expect(kinds).not.toContain('signal d');
    // A signal is seen the step after its enter event is recorded.
    const at = (s: string): number => Number(log.find((l) => l.endsWith(s))!.split(' ')[0]);
    expect(at('signal a')).toBe(at('enter trig-a') + 1);
  });

  it('a mover waiting for a trigger is posed on the 3D port with its rotation and carries the player standing on it', () => {
    const entities = [
      CAM,
      { id: 'player-0001', components: { transform: T([0, 1.1, 0]), controller: {} } },
      { id: 'lift-0001', components: { transform: T([0, 0.1, 0], turnY(30)), collider: { shape: { type: 'box', hx: 1, hy: 0.1, hz: 1 } }, mover: { waypoints: [[3, 0, -2]], speed: 1, mode: 'once', startOn: 'go' } } },
      { id: 'trig-0001', components: { transform: T([0, 1.1, 0]), trigger: { shape: 'sphere', radius: 0.5, signal: 'go' } } },
    ];
    const port = scriptedPort({ x: 0, y: 1.1, z: 0 }) as ReturnType<typeof scriptedPort> & { standOn: string | null };
    port.standOn = 'lift-0001';
    const { rt } = runWith(entities, port, 600, []);
    if (!rt.ok) throw new Error('x');
    const tr = rt.runtime.getInterpolatedState();
    if (!tr.ok) throw new Error('x');
    const at = (id: string) => tr.state.transforms.find((t) => t.id === id)!.position;
    expect(at('lift-0001')).toEqual([3, 0.1, -2]);
    // The player moved with it (the scripted port applies the staged carry exactly).
    expect(at('player-0001')[0]).toBeCloseTo(3, 9);
    expect(at('player-0001')[2]).toBeCloseTo(-2, 9);
    // Every step posed the lift with its own rotation.
    const last = port.poses[port.poses.length - 1]!;
    expect(last).toEqual([{ entityId: 'lift-0001', position: { x: 3, y: 0.1, z: -2 }, rotation: { x: 0, y: turnY(30)[1], z: 0, w: turnY(30)[3] } }]);
  });
});

function artifact(behaviorId: string, owned: string[]): BehaviorArtifact {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: owned,
    requiredModules: [],
    enginePins: [],
    namespace: { default: { instantiate: () => ({}), step: () => undefined } },
  };
}

describe('the behavior ownership rule, lifted for 3D colliders', () => {
  const entities = (extra: Record<string, unknown>) => [
    CAM,
    { id: 'player-0001', components: { transform: T([0, 1.1, 0]), controller: {} } },
    { id: 'plat-0001', components: { transform: T([0, 0.1, 0]), collider: { shape: { type: 'box', hx: 1, hy: 0.1, hz: 1 } }, behavior: { behaviorId: 'driver', values: {} }, ...extra } },
  ];
  const make = (ents: unknown[], physics: PhysicsPort3D | undefined): { ok: true } | { ok: false; code: string; detail?: string } => {
    const spec: SimulationModuleSpec = createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: artifact('driver', ['@self']) });
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, spec.id, spec);
    const res = instantiateRuntime({ snapshot: snap(ents), registry, modules: [spec.id], driver: { kind: 'manual' }, clock: () => 0, settings: SETTINGS, ...(physics !== undefined ? { physics } : {}) });
    if (!res.ok) return { ok: false, code: res.error.code, ...(res.error.detail !== undefined ? { detail: String(res.error.detail) } : {}) };
    res.runtime.dispose();
    return { ok: true };
  };

  it('a 3D project: a script may own a collider (made kinematic at the first step); never a mover\'s collider', () => {
    const port = scriptedPort({ x: 0, y: 1.1, z: 0 });
    expect(make(entities({}), port)).toEqual({ ok: true });
    expect(make(entities({ mover: { waypoints: [[1, 0, 0]], speed: 1, mode: 'loop' } }), scriptedPort({ x: 0, y: 1.1, z: 0 }))).toMatchObject({ ok: false, code: 'transform_owner_forbidden', detail: 'physics_entity' });
  });

  it('the 2D plane keeps the rule exactly: a script owning a collider is refused', () => {
    expect(make(entities({}), undefined)).toMatchObject({ ok: false, code: 'transform_owner_forbidden', detail: 'physics_entity' });
  });

  it('the owned collider is re-added as a kinematic body before the first step and posed from its transform', () => {
    const port = scriptedPort({ x: 0, y: 1.1, z: 0 });
    const spec = createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: artifact('driver', ['@self']) });
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, spec.id, spec);
    const res = instantiateRuntime({ snapshot: snap(entities({})), registry, modules: [spec.id], driver: { kind: 'manual' }, clock: () => 0, settings: SETTINGS, physics: port });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    res.runtime.start();
    for (let i = 0; i <= 3; i += 1) res.runtime.tick(i * DT);
    expect(port.added).toEqual(['plat-0001:kinematic']);
    expect(port.poses.at(-1)).toEqual([{ entityId: 'plat-0001', position: { x: 0, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }]);
    res.runtime.dispose();
  });
});
