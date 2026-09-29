/**
 * Pointer samples in the step's input frame (validation, the
 * held state and its edges), the cursor request, `ctx.input`'s pointer view,
 * and the 3D script queries (raycast3d, overlaps, picks) with their filters
 * and per-step cap — against a recording 3D port.
 */
import { describe, expect, it } from 'vitest';

import { inputView } from './behavior';
import {
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  validateActionFrame,
  QUERY_LIMIT_3D,
  type ActionFrame,
  type CharacterMoveResult3D,
  type OverlapShape3D,
  type PhysicsPort3D,
  type PhysicsQueryFilter3D,
  type PhysicsVec3,
  type StepContext,
} from './index';
import { probeSpec } from './m2-helpers';

const DT = 1 / 120;
/** The settle pre-roll: the first 12 steps sample no input. */
const S = 12;
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
// The scene camera 10 m in front of the origin, looking down −Z.
const CAM = { id: 'cam-main', components: { transform: T([0, 0, 10]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } };
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const snap = (entities: unknown[], tags?: unknown[]) => ({ snapshotId: 'pq@r1', projectId: 'pq', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, ...(tags !== undefined ? { tags } : {}) });

describe('pointer samples in the frame', () => {
  it('old frames stay valid; a pointer sample is checked strictly', () => {
    expect(validateActionFrame({ stepIndex: 1 }).ok).toBe(true);
    const ok = validateActionFrame({ stepIndex: 1, pointer: { x: 0.25, y: 1, dx: -0.5, wheel: 3, buttons: 5, pressed: 1, over: true, locked: false } });
    expect(ok.ok && ok.frame.pointer).toEqual({ x: 0.25, y: 1, dx: -0.5, wheel: 3, buttons: 5, pressed: 1, over: true, locked: false });
    for (const [bad, field] of [
      [{ x: 1.5, y: 0 }, 'pointer/x'],
      [{ x: 0 }, 'pointer/y'],
      [{ x: 0, y: 0, buttons: 8 }, 'pointer/buttons'],
      [{ x: 0, y: 0, dx: 11 }, 'pointer/dx'],
      [{ x: 0, y: 0, over: 1 }, 'pointer/over'],
      [{ x: 0, y: 0, z: 1 }, 'pointer/z'],
      [[0, 0], 'pointer'],
    ] as const) {
      const r = validateActionFrame({ stepIndex: 1, pointer: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.field).toBe(field);
    }
    // An action value may mark a per-sample amount (i: 1), nothing else.
    expect(validateActionFrame({ stepIndex: 1, actions: { look: { v: 1, x: 1, y: 0, p: 'pressed', i: 1 } } }).ok).toBe(true);
    expect(validateActionFrame({ stepIndex: 1, actions: { look: { v: 1, p: 'pressed', i: 2 } } }).ok).toBe(false);
  });

  it('the runtime keeps the pointer between samples and derives the edges; the input view reads them', () => {
    const frames: ActionFrame[] = [
      { stepIndex: S + 2, pointer: { x: 0.5, y: 0.5 } },
      { stepIndex: S + 3, pointer: { x: 0.6, y: 0.5, dx: 0.1, buttons: 1 } },
      // S + 4: no sample — held
      { stepIndex: S + 5, pointer: { x: 0.6, y: 0.5, buttons: 0 } },
      // a click between two samples, then leaving the view
      { stepIndex: S + 6, pointer: { x: 0.6, y: 0.5, pressed: 2, released: 2 } },
      { stepIndex: S + 7, pointer: { x: 0.6, y: 0.5, over: false } },
      { stepIndex: S + 8, pointer: { x: 0.7, y: 0.5 } },
    ];
    const seen = new Map<number, ActionFrame>();
    const probe = probeSpec({ id: 'thirdlight.test:pointer', phases: ['intent'], step: (_p, ctx) => seen.set(ctx.stepIndex, ctx.action) });
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, probe.id, probe);
    const res = instantiateRuntime({ snapshot: snap([CAM]), registry, modules: [probe.id], driver: { kind: 'manual' }, clock: () => 0, actions: createRecordedActionSource(frames) });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    res.runtime.start();
    for (let i = 0; i <= 24; i += 1) res.runtime.tick(i * DT);
    const view = (s: number) => inputView(seen.get(s)!);
    expect(view(S + 1).pointer()).toBeNull(); // before the first sample
    expect(view(S + 2).pointer()).toMatchObject({ x: 0.5, y: 0.5, dx: 0, over: true, entered: true });
    expect(view(S + 3).pointerPressed()).toBe(true);
    expect(view(S + 3).pointer()).toMatchObject({ dx: 0.1, entered: false });
    expect(view(S + 4).pointerHeld('left')).toBe(true); // held without a sample
    expect(view(S + 4).pointerPressed()).toBe(false);
    expect(view(S + 4).pointer()!.dx).toBe(0);
    expect(view(S + 5).pointerReleased()).toBe(true);
    expect(view(S + 6).pointerPressed('right')).toBe(true);
    expect(view(S + 6).pointerReleased('right')).toBe(true);
    expect(view(S + 6).pointerHeld('right')).toBe(false);
    expect(view(S + 7).pointer()).toMatchObject({ over: false, left: true });
    expect(view(S + 8).pointer()).toMatchObject({ x: 0.7, over: true, entered: true });
    expect(view(S + 9).pointer()).toMatchObject({ x: 0.7, entered: false });
    expect(res.runtime.readPointer?.()).toMatchObject({ x: 0.7, y: 0.5, buttons: 0 });
  });

  it('setCursor: free / locked / auto is simulation state the host reads', () => {
    const calls: ('free' | 'locked' | 'auto')[] = [];
    const probe = probeSpec({
      id: 'thirdlight.test:cursor',
      phases: ['intent'],
      step: (_p, ctx) => {
        if (ctx.stepIndex === 2) ctx.cursor?.request('locked');
        if (ctx.stepIndex === 30) ctx.cursor?.request('auto');
        calls.push('free');
      },
    });
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, probe.id, probe);
    const res = instantiateRuntime({ snapshot: snap([CAM]), registry, modules: [probe.id], driver: { kind: 'manual' }, clock: () => 0 });
    if (!res.ok) throw new Error('x');
    const rt = res.runtime;
    rt.start();
    const at: (string | null)[] = [];
    for (let i = 0; i <= 40; i += 1) {
      rt.tick(i * DT);
      at.push(rt.cursorRequest?.() ?? null);
    }
    expect(at).toContain('locked');
    expect(at[at.length - 1]).toBeNull();
    // The input view's channel refuses anything else.
    const v = inputView({ stepIndex: 0 }, (m) => calls.push(m));
    v.setCursor('locked');
    expect(calls[calls.length - 1]).toBe('locked');
    expect(() => v.setCursor('hidden' as never)).toThrow(/setCursor/);
  });
});

/** A recording 3D port: every collider is a unit box at x = 0, 2, 4 … (id `box-<n>`), rays hit the first whose filter accepts it. */
function recordingPort(): PhysicsPort3D & { rays: { origin: PhysicsVec3; dir: PhysicsVec3; max: number; filter?: PhysicsQueryFilter3D }[]; overlaps: { shape: OverlapShape3D; center: PhysicsVec3; rotation?: unknown; filter?: PhysicsQueryFilter3D }[] } {
  const rays: { origin: PhysicsVec3; dir: PhysicsVec3; max: number; filter?: PhysicsQueryFilter3D }[] = [];
  const overlaps: { shape: OverlapShape3D; center: PhysicsVec3; rotation?: unknown; filter?: PhysicsQueryFilter3D }[] = [];
  const ids = ['box-a', 'box-b', 'box-c'];
  const layerOf: Record<string, string> = { 'box-a': 'default', 'box-b': 'units', 'box-c': 'units' };
  const passes = (id: string, f?: PhysicsQueryFilter3D): boolean => (f?.layers === undefined || f.layers.includes(layerOf[id]!)) && (f?.accept === undefined || f.accept(id));
  return {
    dimension: 3,
    rays,
    overlaps,
    stageCharacterMove() {},
    step(): CharacterMoveResult3D {
      const z = { x: 0, y: 0, z: 0 };
      return { requested: z, applied: { ...z }, position: { ...z }, grounded: false, supportNormal: { x: 0, y: 1, z: 0 }, contacts: { ground: false, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    raycast(origin, dir, max, filter) {
      rays.push({ origin, dir, max, ...(filter !== undefined ? { filter } : {}) });
      const id = ids.find((i) => passes(i, filter));
      return id === undefined ? null : { entityId: id, distance: 3, normal: { x: 0, y: 0, z: 1 } };
    },
    overlap(shape, center, rotation, filter) {
      overlaps.push({ shape, center, ...(rotation !== undefined ? { rotation } : {}), ...(filter !== undefined ? { filter } : {}) });
      return ids.filter((i) => passes(i, filter));
    },
    dispose() {},
  } as ReturnType<typeof recordingPort>;
}

function runQueries(step: (ctx: StepContext, n: number) => void, frames: ActionFrame[] = [], extra: { logs?: string[] } = {}) {
  const port = recordingPort();
  const probe = probeSpec({ id: 'thirdlight.test:queries', phases: ['intent'], step: (_p, ctx) => step(ctx, ctx.stepIndex) });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, probe.id, probe);
  const entities = [
    CAM,
    { id: 'box-a', components: { transform: T([0, 0, 0]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } } } },
    { id: 'box-b', tags: 1, components: { transform: T([2, 0, 0]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, layers: ['units'] } } },
    { id: 'box-c', tags: 2, components: { transform: T([4, 0, 0]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, layers: ['units'] } } },
  ];
  const res = instantiateRuntime({
    snapshot: snap(entities, [{ bit: 0, name: 'friend' }, { bit: 1, name: 'foe' }]),
    registry,
    modules: [probe.id],
    driver: { kind: 'manual' },
    clock: () => 0,
    physics: port,
    settings: SETTINGS,
    ...(frames.length > 0 ? { actions: createRecordedActionSource(frames) } : {}),
  });
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  res.runtime.start();
  for (let i = 0; i <= S + 4; i += 1) res.runtime.tick(i * DT);
  if (extra.logs !== undefined) {
    const d = res.runtime.getDiagnostics();
    if (d.ok) for (const e of d.diagnostics.errors) extra.logs.push(`${e.code} ${e.message}`);
  }
  return port;
}

describe('3D script queries', () => {
  it('raycast3d: a hit carries the object, the point, the normal and the distance; the direction is normalized', () => {
    const hits: unknown[] = [];
    const port = runQueries((ctx, n) => {
      if (n === 1) hits.push(ctx.physics.raycast3d!([1, 2, 10], [0, 0, -2]));
    });
    expect(hits[0]).toEqual({ entityId: 'box-a', point: [1, 2, 7], normal: [0, 0, 1], distance: 3 });
    expect(port.rays[0]).toMatchObject({ origin: { x: 1, y: 2, z: 10 }, dir: { x: 0, y: 0, z: -1 }, max: 100 });
  });

  it('filters: layers go to the port, tags and exclusions become its accept test; an unknown tag is a script error', () => {
    const got: unknown[] = [];
    let thrown = '';
    runQueries((ctx, n) => {
      if (n !== 1) return;
      got.push(ctx.physics.raycast3d!([0, 0, 10], [0, 0, -1], 50, { layers: ['units'] })?.entityId);
      got.push(ctx.physics.raycast3d!([0, 0, 10], [0, 0, -1], 50, { tags: ['foe'] })?.entityId);
      got.push(ctx.physics.raycast3d!([0, 0, 10], [0, 0, -1], 50, { layers: ['units'], exclude: ['box-b'] })?.entityId);
      got.push(ctx.physics.overlapSphere!([0, 0, 0], 3, { tags: ['friend', 'foe'] }));
      got.push(ctx.physics.overlapBox3d!([0, 0, 0], [1, 1, 1], [0, 0, 0, 2], { layers: ['default'] }));
      got.push(ctx.physics.overlapCapsule!([0, 1, 0], 0.3, 1.8));
      got.push(ctx.physics.raycast3d!([0, 0, 10], [0, 0, -1], 50, { layers: ['nothing'] }));
      try {
        ctx.physics.raycast3d!([0, 0, 10], [0, 0, -1], 50, { tags: ['nobody'] });
      } catch (e) {
        thrown = String((e as Error).message);
      }
    });
    expect(got).toEqual(['box-b', 'box-c', 'box-c', ['box-b', 'box-c'], ['box-a'], ['box-a', 'box-b', 'box-c'], null]);
    expect(thrown).toMatch(/unknown tag "nobody"/);
  });

  it('bad arguments are script errors; a zero direction finds nothing', () => {
    const errors: string[] = [];
    runQueries((ctx, n) => {
      if (n !== 1) return;
      for (const call of [
        () => ctx.physics.raycast3d!([0, 0] as never, [0, 0, -1]),
        () => ctx.physics.overlapSphere!([0, 0, 0], -1),
        () => ctx.physics.overlapBox3d!([0, 0, 0], [1, 1, 1], [0, 0, 0, 0]),
        () => ctx.physics.raycast3d!([0, 0, 0], [0, 0, -1], 5, { color: 'red' } as never),
      ]) {
        try {
          call();
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      expect(ctx.physics.raycast3d!([0, 0, 0], [0, 0, 0])).toBeNull();
    });
    expect(errors).toHaveLength(4);
  });

  it(`at most ${QUERY_LIMIT_3D} queries a step (then nothing, warned once); the budget resets every step`, () => {
    const counts: number[] = [];
    const logs: string[] = [];
    runQueries(
      (ctx, n) => {
        if (n < 1 || n > 2) return;
        let hits = 0;
        for (let i = 0; i < QUERY_LIMIT_3D + 10; i += 1) if (ctx.physics.raycast3d!([0, 0, 10], [0, 0, -1]) !== null) hits += 1;
        counts.push(hits);
      },
      [],
      { logs },
    );
    expect(counts).toEqual([QUERY_LIMIT_3D, QUERY_LIMIT_3D]);
    expect(logs.filter((l) => l.includes('physics queries in one step'))).toHaveLength(1);
  });

  it('pickAt casts the scene camera\'s ray through a screen point; pickAtPointer the pointer\'s (null before a sample or off the view)', () => {
    const picks: unknown[] = [];
    const frames: ActionFrame[] = [
      { stepIndex: S + 2, pointer: { x: 0.5, y: 0.5 } },
      { stepIndex: S + 3, pointer: { x: 0.75, y: 0.5, over: false } },
    ];
    const port = runQueries((ctx, n) => {
      if (n === 1) picks.push(ctx.physics.pickAtPointer!(), ctx.physics.pickAt!(0.5, 0.5)?.entityId);
      if (n === S + 2) picks.push(ctx.physics.pickAtPointer!()?.entityId);
      if (n === S + 3) picks.push(ctx.physics.pickAtPointer!());
    }, frames);
    expect(picks).toEqual([null, 'box-a', 'box-a', null]);
    // The centre of the view: from the camera straight down −Z, 1000 m by default.
    expect(port.rays[0]).toMatchObject({ origin: { x: 0, y: 0, z: 10 }, max: 1000 });
    expect(port.rays[0]!.dir.x).toBeCloseTo(0, 12);
    expect(port.rays[0]!.dir.z).toBeCloseTo(-1, 12);
    expect(port.rays).toHaveLength(2);
  });

  it('ctx.camera.screenToRay / worldToScreen use the scene camera when no virtual camera is live', () => {
    const out: unknown[] = [];
    runQueries((ctx, n) => {
      if (n !== 1 || ctx.camera === undefined) return;
      const r = ctx.camera.screenToRay(1, 0.5);
      out.push(r.origin);
      // The right edge at a 16:9 aspect and a 60° vertical field of view.
      out.push(Math.atan2(r.direction[0], -r.direction[2]));
      const s = ctx.camera.worldToScreen([0, 0, 0]);
      out.push([s.x, s.y, s.depth, s.onScreen]);
    });
    expect(out[0]).toEqual([0, 0, 10]);
    expect(out[1] as number).toBeCloseTo(Math.atan(Math.tan(Math.PI / 6) * (16 / 9)), 9);
    expect(out[2]).toEqual([0.5, 0.5, 10, true]);
  });
});
