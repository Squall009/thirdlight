/**
 * Several player controllers sharing one view (local co-op), through the
 * production composition (the real game host, the character controllers and
 * Rapier), on the 2D plane and in 3D, on the main thread and in the
 * simulation worker, driven by recorded input.
 *
 * Two controllers stand on one floor: the first reads the default `move` and
 * `jump` actions, the second its own `move_p2` and `jump_p2`. Each walks
 * from its own input only (the other's input never moves it), they walk
 * through each other, the second jumps on its own jump; a script's intent
 * naming the second controller drives it alone; a trigger between them
 * reports each player's entry with the player that entered (`by`); a save
 * keeps the second player's place under `characters`. Every step's digest
 * agrees in page and worker.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
type Dim = 2 | 3;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/**
 * Logs both players' positions every 10 steps, the gate's trigger events
 * (with the player that entered), and at step 330 has the second player
 * walk right by its intent (`control_move` naming it).
 */
const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    for (const e of ctx.events ?? []) if (e.trigger !== undefined) {
      const ev = ctx.save.get('events') ?? [];
      ev.push([e.type, e.by]);
      ctx.save.set('events', ev);
    }
    if (ctx.stepIndex >= 330 && ctx.stepIndex < 390) ctx.emit({ kind: 'control_move', entityId: 'player-0002', value: 1 });
    if (ctx.stepIndex % 10 !== 0) return;
    const key = 'log' + Math.floor(ctx.stepIndex / 100);
    const log = ctx.save.get(key) ?? [];
    const at = (id) => { const t = ctx.world.transform(id); return t === undefined ? null : [Math.round(t.position[0] * 1e4) / 1e4, Math.round(t.position[1] * 1e4) / 1e4, Math.round(t.position[2] * 1e4) / 1e4]; };
    log.push([ctx.stepIndex, at('player-0001'), at('player-0002')]);
    ctx.save.set(key, log);
  },
};
`;

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -20, run_speed: 4, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const CONTROLLER_2D = { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false };

function box(dim: Dim, id: string, c: number[], h: number[]): Any {
  return { id, components: { transform: T(c), collider: { shape: dim === 3 ? { type: 'box', hx: h[0], hy: h[1], hz: h[2] } : { type: 'box', hx: h[0], hy: h[1] } } } };
}

/** A floor, a gate trigger at x 0 (its owner logs), the first player at x −1 and the second at x 0.5. */
function level(dim: Dim): Any[] {
  const z = dim === 3;
  return [
    { id: 'player-0001', components: { transform: T([-1, 0.91, 0]), controller: {} } },
    { id: 'player-0002', components: { transform: T([0.5, 0.91, 0]), controller: { moveAction: 'move_p2', jumpAction: 'jump_p2' } } },
    box(dim, 'floor-0001', [0, -0.5, 0], [30, 0.5, 4]),
    { id: 'gate-0001', components: { transform: T([0, 1, 0]), trigger: { size: z ? [0.5, 2, 4] : [0.5, 2], signal: 'gate' }, behavior: { behaviorId: 'director', values: {} } } },
  ];
}

/**
 * The recorded input: the first player's `move` pushes right for steps
 * 20–139 (through the second, standing), the second's `move_p2` pushes left
 * for steps 150–269 (through the first) and its `jump_p2` is pressed at step
 * 280 (both axes' x; 3D reads x as across).
 */
function recording(n: number): Any[] {
  const axis = (x: number) => ({ v: x, x, y: 0, p: 'none' });
  return Array.from({ length: n + 100 }, (_, s) => {
    const actions: Record<string, Any> = {};
    if (s >= 20 && s < 140) actions['move'] = axis(1);
    if (s >= 150 && s < 270) actions['move_p2'] = axis(-1);
    if (s === 280) actions['jump_p2'] = { v: 1, p: 'pressed' };
    else if (s > 280 && s < 300) actions['jump_p2'] = { v: 1, p: 'held' };
    return { stepIndex: s, actions };
  });
}

async function run(mode: Mode, dim: Dim, steps: number): Promise<{ log: Any[]; events: Any[]; digests: string[]; errors: Any[]; world: Any }> {
  const entities = level(dim);
  const settings = dim === 3 ? SETTINGS_3D : SETTINGS_2D;
  const statics = entities.filter((e) => e.components.collider).map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics =
    dim === 3
      ? physics3DConfigOf(entities, SETTINGS_3D)
      : { character: { x: -1, y: 0.91 }, characters: [{ id: 'player-0002', x: 0.5, y: 0.91 }], statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: CONTROLLER_2D };
  const h = await startHarness(mode, {
    snapshot: { snapshotId: `coop${dim}@r1`, projectId: `coop${dim}`, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }] },
    storage: true,
    settings,
    physics,
    replay: recording(steps),
    digestSteps: true,
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('director', DIRECTOR)],
  });
  try {
    let now = 10;
    while (h.digests.length < steps) {
      now += DT;
      await h.tick(now);
    }
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    const log = Array.from({ length: Math.ceil(steps / 100) + 1 }, (_, i) => (values[`log${i}`] ?? []) as Any[]).flat();
    // Where the play stands as a save keeps it (the page runtime's own capture).
    const world = mode === 'single' ? (h.rt as Any).captureWorld() : null;
    return { log, events: (values['events'] ?? []) as Any[], digests: h.digests.slice(0, steps), errors: d.ok ? d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log') : [d], world };
  } finally {
    await h.dispose();
  }
}

const row = (log: Any[], s: number): Any[] => {
  const r = log.find((x: Any[]) => x[0] === s);
  expect(r, `step ${s}`).toBeDefined();
  return r;
};

describe.each([2, 3] as const)('two player controllers in one view (%iD)', (dim) => {
  it('each moves from its own input only, they pass through each other, a script names one, triggers name who entered; page and worker agree', async () => {
    const single = await run('single', dim, 440);
    expect(single.errors).toEqual([]);
    const at = (s: number, p: 1 | 2): number[] => row(single.log, s)[p];
    // Before any input both stand where they started.
    expect(at(10, 1)[0]).toBeCloseTo(-1, 2);
    expect(at(10, 2)[0]).toBeCloseTo(0.5, 2);
    // The first player's move: only it walks right, through the second (standing at x 0.5).
    expect(at(140, 1)[0]).toBeGreaterThan(0.7);
    expect(at(140, 2)[0]).toBeCloseTo(0.5, 2);
    const p1 = at(200, 1)[0]!;
    // The second player's move_p2: only it walks left, through the first.
    expect(at(270, 2)[0]).toBeLessThan(-0.5);
    expect(at(270, 1)[0]).toBeCloseTo(p1, 2);
    // Its own jump lifts it; the first stays on the floor.
    const during = single.log.filter((r) => r[0] > 280 && r[0] < 340);
    expect(Math.max(...during.map((r) => r[2][1]))).toBeGreaterThan(1.5);
    expect(Math.max(...during.map((r) => r[1][1]))).toBeLessThan(0.95);
    // The script's control_move naming the second player walks it right; the first does not move.
    expect(at(400, 2)[0]).toBeGreaterThan(at(320, 2)[0]! + 0.5);
    expect(at(400, 1)[0]).toBeCloseTo(p1, 2);
    // The gate reported each player's entry and exit, naming the player.
    expect(single.events).toEqual(expect.arrayContaining([['enter', 'player-0001'], ['exit', 'player-0001'], ['enter', 'player-0002'], ['exit', 'player-0002']]));
    // A save keeps the first player as `character` and the second under `characters`.
    expect(single.world.character.position[0]).toBeCloseTo(p1, 1);
    expect(Object.keys(single.world.characters)).toEqual(['player-0002']);
    const worker = await run('worker', dim, 440);
    expect(worker.errors).toEqual([]);
    expect(worker.digests).toEqual(single.digests);
  }, 120_000);
});

/**
 * Counts the runs (a restart starts the scripts over, so its step count starts at 0) and,
 * per run, walks both players apart, makes the second jump, and logs both players'
 * exact positions and facings and their last physics results every 10 of its steps.
 */
const RUNNER = `
export default {
  instantiate() { return { n: 0, run: -1 }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (s.n === 0) { s.run = ctx.save.get('runs') ?? 0; ctx.save.set('runs', s.run + 1); }
    const n = s.n++;
    if (n >= 20 && n < 80) ctx.emit({ kind: 'control_move', value: 1 });
    if (n >= 40 && n < 120) ctx.emit({ kind: 'control_move', entityId: 'player-0002', value: -1 });
    if (n === 90) ctx.emit({ kind: 'control_jump', entityId: 'player-0002', value: 'pressed' });
    else if (n > 90 && n < 100) ctx.emit({ kind: 'control_jump', entityId: 'player-0002', value: 'held' });
    if (n % 10 !== 0 || n > 200) return;
    // One save key per run and 100 steps (a save value has a size limit).
    const key = 'run' + s.run + '.' + Math.floor(n / 100);
    const log = ctx.save.get(key) ?? [];
    const at = (id) => { const t = ctx.world.transform(id); return t === undefined ? null : [...t.position, ...t.rotation]; };
    // What the physics last reported for each (a run's first step: nothing yet, as at the first start).
    const last = (id) => { const r = ctx.physics.characterResult(id); return r === undefined ? null : [r.grounded, r.applied.x, r.applied.y]; };
    log.push([n, at('player-0001'), at('player-0002'), last('player-0001'), last('player-0002')]);
    ctx.save.set(key, log);
  },
};
`;

async function restartedRuns(mode: Mode, dim: Dim, ticks: readonly number[]): Promise<{ logs: Any[][]; errors: Any[] }> {
  // The second player starts in the air: the start's settle moves it, so a restart must put it back exactly.
  const entities: Any[] = [
    { id: 'player-0001', components: { transform: T([-1, 0.91, 0]), controller: {} } },
    { id: 'player-0002', keepLoaded: true, components: { transform: T([5, 1.6, 0]), controller: { moveAction: 'move_p2', jumpAction: 'jump_p2' } } },
    box(dim, 'floor-0001', [0, -0.5, 0], [30, 0.5, 4]),
    { id: 'runner-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'runner', values: {} } } },
  ];
  const settings = dim === 3 ? SETTINGS_3D : SETTINGS_2D;
  const statics = entities.filter((e) => e.components.collider).map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics =
    dim === 3
      ? physics3DConfigOf(entities, SETTINGS_3D)
      : { character: { x: -1, y: 0.91 }, characters: [{ id: 'player-0002', x: 5, y: 1.6 }], statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: CONTROLLER_2D };
  const h = await startHarness(mode, {
    snapshot: { snapshotId: `coop-runs${dim}@r1`, projectId: `coop-runs${dim}`, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }] },
    storage: true,
    settings,
    physics,
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('runner', RUNNER)],
  });
  try {
    let now = 10;
    // Each run so many frames of one step, then the host's replay (a restart, as each play-test run begins).
    for (let r = 0; r < ticks.length; r += 1) {
      for (let i = 0; i < ticks[r]!; i += 1) {
        now += DT;
        await h.tick(now);
      }
      if (r < ticks.length - 1) expect(h.host.control('replay').ok).toBe(true);
    }
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    return { logs: ticks.map((_, r) => [0, 1, 2].flatMap((k) => (values[`run${r}.${k}`] ?? []) as Any[])), errors: d.ok ? d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log') : [d] };
  } finally {
    await h.dispose();
  }
}

describe.each([2, 3] as const)('runs restarted in one play with two player controllers (%iD)', (dim) => {
  it('every restarted run repeats the last one exactly, for both players, whatever the last one ended in; page and worker', async () => {
    for (const mode of ['single', 'worker'] as const) {
      // As a play-test: the first run restarts at once, the others after both players walked, turned and jumped.
      const { logs, errors } = await restartedRuns(mode, dim, [12, 230, 230, 230]);
      expect(errors).toEqual([]);
      expect(logs[1]!.length).toBe(21);
      // The second player walked and jumped (the run is not trivially at rest).
      expect(logs[1]![15]![2][0]).toBeLessThan(4.5);
      expect(Math.max(...logs[1]!.map((r: Any) => r[2][1]))).toBeGreaterThan(1.7);
      for (let r = 2; r < logs.length; r += 1) expect(logs[r], `${mode} run ${r}`).toEqual(logs[1]);
      // A restarted run is the first start again. On the 2D plane the first start's first sweep differs (the physics
      // world's query pipeline is empty until its first step; a placement updates it), so there only the second player's
      // run, which starts in the air, is the same.
      const first = await restartedRuns(mode, dim, [230, 230]);
      expect(first.errors).toEqual([]);
      if (dim === 3) expect(first.logs[1], `${mode} first start`).toEqual(first.logs[0]);
      else expect(first.logs[1]!.map((row: Any) => row[2]), `${mode} first start`).toEqual(first.logs[0]!.map((row: Any) => row[2]));
    }
  }, 120_000);
});
