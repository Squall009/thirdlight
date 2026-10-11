/**
 * `ctx.decals`: scripts leave a prefab's projected decal on a surface. The
 * requests are presentation events like `ctx.effects`' — recorded in step
 * order with handles, the prefab's decal resolved and its box scaled,
 * refused past the per-step count, cleared by a run restart, and never read
 * back by the simulation: a run that spawns decals computes what a run that
 * does not computes. Neutral fixtures.
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, PRESENTATION_REQUESTS_PER_STEP, registerSimulationModule, type DecalRequest, type Runtime } from './index';

const DT = 1 / 120;
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** A scorch mark (a decal on its root's child) and a crate without one. */
const PREFABS = [
  {
    prefabId: 'scorch',
    displayName: 'Scorch',
    createdRevision: 1,
    entityCount: 2,
    depth: 2,
    entities: [
      { localId: 'group-0001', components: { transform: at(0, 0) } },
      { localId: 'group-0002', parentLocalId: 'group-0001', components: { transform: at(0, 0), decal: { size: [0.5, 0.5, 0.2], material: 'mat-scorch', sortOrder: 3 } } },
    ],
  },
  { prefabId: 'crate', displayName: 'Crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0001', components: { transform: at(0, 0), box: { size: [1, 1, 1], material: { color: '#aa7733' } } } }] },
];

interface DecalCtx {
  stepIndex: number;
  phase: string;
  decals: { spawn(prefabId: string, options?: unknown): number; remove(target: number | string): void };
  lifecycle: { restart(): boolean };
  world: { transform(id: string): { position: readonly number[] } | undefined };
}

function run(script: (ctx: DecalCtx, handles: number[]) => void, steps = 40): { rt: Runtime; requests: DecalRequest[]; handles: number[]; positions: string } {
  const handles: number[] = [];
  const spec = createBehaviorModuleSpec({
    declaration: { properties: [] } as never,
    artifact: {
      behaviorId: 'marker',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: [],
      requiredModules: [],
      enginePins: [],
      namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: DecalCtx) => (ctx.phase === 'intent' ? script(ctx, handles) : undefined) } },
    } as never,
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'decals@r1',
      projectId: 'decals',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'player-0001', components: { transform: at(0, 0), controller: {} } },
          { id: 'box-marker', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'marker', values: {} } } },
        ],
      },
      prefabs: PREFABS,
    },
    registry,
    modules: [spec.id],
    actions: { sample: (i: number) => neutralFrame(i) },
    settings: {},
    clock: () => now.t,
    driver: { kind: 'manual' },
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  for (let i = 0; i < steps; i += 1) {
    now.t += DT;
    const r = rt.tick(now.t);
    if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
  }
  const st = rt.getInterpolatedState();
  const positions = JSON.stringify(st.ok ? st.state.transforms : null);
  return { rt, requests: rt.takeDecalRequests?.() ?? [], handles, positions };
}

describe('ctx.decals', () => {
  it('spawns a prefab\'s decal with a handle, its box scaled, facing out along the normal and turned about it', () => {
    const { requests, handles } = run((ctx, h) => {
      if (ctx.stepIndex !== 3) return;
      h.push(ctx.decals.spawn('scorch', { position: [1, 2, 3], normal: [1, 0, 0], angle: 90, scale: 2, lifetime: 5 }));
      h.push(ctx.decals.spawn('scorch', { position: [0, 0, 0], entityId: 'box-marker' }));
      // A prefab without a decal, and one that does not exist: refused, not thrown.
      h.push(ctx.decals.spawn('crate'));
      h.push(ctx.decals.spawn('nothing'));
      ctx.decals.remove(h[0]!);
      ctx.decals.remove('box-marker');
    });
    expect(handles).toEqual([1, 2, 0, 0]);
    expect(requests.map((r) => [r.op, r.handle, r.entityId])).toEqual([
      ['spawn', 1, null],
      ['spawn', 2, 'box-marker'],
      ['remove', 1, null],
      ['remove', 0, 'box-marker'],
    ]);
    const first = requests[0]!;
    expect(first.prefabId).toBe('scorch');
    expect(first.decal).toEqual({ size: [1, 1, 0.4], material: 'mat-scorch', sortOrder: 3 });
    expect(first.position).toEqual([1, 2, 3]);
    expect(first.lifetime).toBe(5);
    // The box's +Z (where it projects from) on the normal: rotate +Z by the quaternion.
    const [x, y, z, w] = first.rotation;
    const zAxis = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    expect(zAxis[0]).toBeCloseTo(1);
    expect(zAxis[1]).toBeCloseTo(0);
    expect(zAxis[2]).toBeCloseTo(0);
    // Turned 90° about the normal: the box's +X ends on world ∓Y, not ±Z.
    const xAxis = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    expect(Math.abs(xAxis[1]!)).toBeCloseTo(1);
    // Absent: up, unscaled, no lifetime.
    expect(requests[1]!.decal?.size).toEqual([0.5, 0.5, 0.2]);
    expect(requests[1]!.lifetime).toBe(0);
  });

  it(`refuses more than ${PRESENTATION_REQUESTS_PER_STEP} spawns a step and is deterministic; a restart clears the run's decals`, () => {
    const script = (ctx: DecalCtx, h: number[]): void => {
      if (ctx.stepIndex === 2) for (let i = 0; i < 40; i++) h.push(ctx.decals.spawn('scorch', { position: [i, 0, 0] }));
    };
    const a = run(script);
    const b = run(script);
    expect(b.handles).toEqual(a.handles);
    expect(b.requests).toEqual(a.requests);
    expect(a.handles.filter((x) => x > 0)).toHaveLength(PRESENTATION_REQUESTS_PER_STEP);
    expect(a.requests.filter((r) => r.op === 'spawn')).toHaveLength(PRESENTATION_REQUESTS_PER_STEP);
    // A restart: the decals the run left go (spawns not taken yet go with them); handles keep counting.
    const restarted = run((ctx, h) => {
      if (ctx.stepIndex === 2) h.push(ctx.decals.spawn('scorch'));
      if (ctx.stepIndex === 10) ctx.lifecycle.restart();
      if (ctx.stepIndex === 20) h.push(ctx.decals.spawn('scorch'));
    });
    expect(restarted.requests.map((r) => r.op)).toEqual(['clear', 'spawn']);
    expect(restarted.handles).toEqual([1, 2]);
  });

  it('spawning decals changes nothing the simulation computes', () => {
    const marked = run((ctx) => void ctx.decals.spawn('scorch', { position: [ctx.stepIndex, 0, 0] }));
    const plain = run(() => undefined);
    expect(marked.requests.length).toBeGreaterThan(0);
    expect(marked.positions).toEqual(plain.positions);
  });
});
