/**
 * Phase 24.4: the generic primitives through the production composition —
 * the real game host, the character controller and Rapier physics, a scene
 * without any game session — on the 2D plane and in 3D, in both threading
 * modes, driven by a recorded input:
 *
 * - the character walks through a collectible: its counter rises by the
 *   amount, it hides, sends its signal and a `collected` event, and comes
 *   back after its respawn time (`restored`);
 * - it walks through a damaging hitbox: both sides get a `contact` event with
 *   the other object and the normal (the side the contact came from), the
 *   character's health falls by the damage (`damaged`), then `separate`;
 * - an edge-walking patroller turns at a wall and then at a ledge (`turned`
 *   with the reason and its new direction);
 * - a script damages the character to 0 (`damaged`, `died`) — nothing else
 *   happens: what 0 means is the game's rule.
 *
 * The script owns the character (it sits on it) and names the collectible and
 * the patroller in object properties, so their events reach its `ctx.events`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { memoryProjectSaveBackend } from '@thirdlight/game-host';

import { behaviorModule, MODES, startHarness, type Harness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** Logs every event the script owns, the collect signal, and damages its own object at step 200. */
const WATCH = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    const log = ctx.save.get('log') ?? [];
    for (const e of ctx.events ?? []) {
      if (e.type === 'turned') log.push('turned:' + e.entity + ':' + e.reason + ':' + Math.sign(e.direction[0]));
      else if (e.type === 'damaged' || e.type === 'healed' || e.type === 'died') log.push(e.type + ':' + e.entity + ':' + e.amount + ':' + e.current + ':' + e.source);
      else if (e.type === 'contact') log.push('contact:' + e.entity + ':' + e.other + ':' + e.normal.join(','));
      else if (e.type === 'separate') log.push('separate:' + e.entity + ':' + e.other);
      else if (e.type === 'collected' || e.type === 'restored') log.push(e.type + ':' + e.entity + ':' + e.counter + ':' + e.amount + ':' + e.by);
    }
    if (ctx.signals.on('got')) log.push('signal:got');
    ctx.save.set('log', log);
    if (ctx.stepIndex === 200) {
      ctx.save.set('hp', ctx.health.get(ctx.entityId));
      ctx.save.set('hit', ctx.health.damage(ctx.entityId, 5, 'script'));
      ctx.save.set('hp2', ctx.health.get(ctx.entityId));
      ctx.save.set('again', ctx.health.damage(ctx.entityId, 1));
    }
  },
};
`;
const DECLARATION = {
  properties: [
    { key: 'walker', label: 'Walker', type: 'entityRef', default: null },
    { key: 'token', label: 'Collectible', type: 'entityRef', default: null },
  ],
};

/** The level, in either dimension: a floor with the character, a collectible and a damaging hitbox; a second floor with a wall and a patroller. */
function level(dim: 2 | 3): Any[] {
  const z = dim === 3;
  const box = (id: string, c: number[], h: number[]): Any => ({
    id,
    components: { transform: T(c), box: { size: [h[0]! * 2, h[1]! * 2, h[2]! * 2], material: { color: '#888888' } }, collider: { shape: z ? { type: 'box', hx: h[0], hy: h[1], hz: h[2] } : { type: 'box', hx: h[0], hy: h[1] } } },
  });
  return [
    { id: 'cam-main', components: { transform: T([4, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {}, health: { max: 3 }, behavior: { behaviorId: 'watch', values: { walker: 'walker-0001', token: 'token-0001' } } } },
    box('floor-a', [2, -0.5, 0], [4, 0.5, 2]),
    box('floor-b', [9.75, -0.5, 0], [2.75, 0.5, 2]),
    box('wall-0001', [12.5, 1, 0], [0.5, 1, 2]),
    { id: 'token-0001', components: { transform: T([1.5, 0.9, 0]), collectible: { counter: 'items', amount: 2, onCollect: 'got', respawn: 1, size: z ? [1, 1, 1] : [1, 1] } } },
    { id: 'thorn-0001', components: { transform: T([3.5, 0.25, 0]), hitbox: { size: z ? [0.5, 0.5, 0.5] : [0.5, 0.5], damage: 1 } } },
    { id: 'walker-0001', components: { transform: T([9.5, 0.5, 0]), patrol: { mode: 'edges', speed: 2, size: z ? [1, 1, 1] : [1, 1] } } },
  ];
}

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.dispose();
});

async function run(mode: Mode, dim: 2 | 3): Promise<{ h: Harness; values: Record<string, Any>; counters: Record<string, number>; hiddenAt: boolean[] }> {
  const entities = level(dim);
  const settings = dim === 3 ? { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 } : { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics =
    dim === 3
      ? physics3DConfigOf(entities, settings)
      : { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: settings.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } };
  // Walk right (+x) past the thorn (the 3D character walks at its 2 m/s default), then stand.
  const walk = dim === 3 ? 270 : 150;
  const replay = Array.from({ length: 480 }, (_, i) => ({ stepIndex: i, moveX: i < walk ? 1 : 0, ...(dim === 3 ? { moveY: 0 } : {}), jump: 'none' as const }));
  const h = await startHarness(mode, {
    snapshot: { snapshotId: `prims${dim}@r1`, projectId: `prims${dim}`, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities } },
    storage: true,
    settings,
    physics,
    replay,
    digestSteps: true,
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('watch', WATCH, DECLARATION)],
  });
  live.push(h);
  const rt: Any = h.rt;
  const hiddenAt: boolean[] = [];
  let now = 0;
  while (h.digests.length < 460) {
    now += DT;
    await h.tick(now);
    hiddenAt[h.digests.length] = rt.hiddenEntities().has('token-0001');
  }
  const d = rt.getDiagnostics();
  expect(d.ok ? d.diagnostics.errors : d).toEqual([]);
  return { h, values: await h.storage(), counters: rt.gameCounters().counters, hiddenAt };
}

function expectInOrder(log: string[], expected: string[]): void {
  let at = -1;
  for (const e of expected) {
    const i = log.indexOf(e, at + 1);
    expect(i, `"${e}" after position ${at} in ${JSON.stringify(log)}`).toBeGreaterThan(at);
    at = i;
  }
}

describe.each([2, 3] as const)('generic primitives (dimension %s)', (dim) => {
  const logs: Record<string, string[]> = {};
  const digests: Record<string, string[]> = {};
  it.each(MODES)('collectible, hitbox contact with damage, patrol turns and script health events (threading: %s)', async (mode) => {
    const { h, values, counters, hiddenAt } = await run(mode, dim);
    const log = values['log'] as string[];
    logs[mode] = log;
    digests[mode] = [...h.digests];
    // The collectible: +2 to its counter, hidden, its signal and event, back one second later.
    expect(counters['items']).toBe(2);
    expectInOrder(log, ['collected:token-0001:items:2:player-0001', 'signal:got', 'restored:token-0001:items:0:']);
    const first = hiddenAt.indexOf(true);
    const back = hiddenAt.indexOf(false, first);
    expect(first).toBeGreaterThan(0);
    expect(back - first).toBeGreaterThanOrEqual(119);
    expect(back - first).toBeLessThanOrEqual(121);
    // The thorn: contact on both sides with opposite normals along x (the character came from -x), one damage, then apart.
    expectInOrder(log, ['contact:player-0001:thorn-0001:1,0,0', 'damaged:player-0001:1:2:thorn-0001', 'separate:player-0001:thorn-0001']);
    expect(log.filter((l) => l.startsWith('damaged:player-0001:1:'))).toHaveLength(1);
    // The patroller: turns at the wall (now walking -x), then at the floor's edge (now +x).
    expectInOrder(log, ['turned:walker-0001:wall:-1', 'turned:walker-0001:ledge:1']);
    // The script's damage: to 0, reported as damaged and died; a second hit at 0 does nothing.
    expect(values['hp']).toEqual({ current: 2, max: 3 });
    expect(values['hit']).toBe(true);
    expect(values['hp2']).toEqual({ current: 0, max: 3 });
    expect(values['again']).toBe(false);
    expectInOrder(log, ['damaged:player-0001:2:0:script', 'died:player-0001:0:0:script']);
    // Deterministic across threading modes: the same events and the same committed states.
    if (logs['single'] !== undefined && logs['worker'] !== undefined) {
      expect(logs['worker']).toEqual(logs['single']);
      const firstDiff = digests['worker']!.slice(0, 400).findIndex((d, k) => d !== digests['single']![k]);
      expect(firstDiff, `first differing step ${firstDiff}`).toBe(-1);
    }
  }, 60_000);
});

/**
 * The `components` save section: a script damages an object, stops a waypoint
 * patroller and switches a hitbox off, saves, undoes all three, and loads —
 * the health, the patroller (stopped where it was) and the hitbox (off) come
 * back. No character and no physics: a 2D-plane scene of scripts only.
 */
const SAVER = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    const s = ctx.stepIndex;
    const at = () => ctx.world.transform('rover-0001').position[0];
    if (s === 40) {
      ctx.health.damage('crate-0001', 2, 'test');
      ctx.patrol.setActive('rover-0001', false);
      ctx.hitbox.setActive('ward-0001', false);
      ctx.save.set('x40', at());
      ctx.saves.save(1);
    }
    if (s === 60) {
      ctx.health.heal('crate-0001', 2);
      ctx.patrol.setActive('rover-0001', true);
      ctx.hitbox.setActive('ward-0001', true);
    }
    // (Kept in the script's own state: the load at 80 restores ctx.save.)
    if (s === 79) _s.touch79 = ctx.hitbox.touching('ward-0001');
    if (s === 80) ctx.saves.load(1);
    if (s === 100) {
      ctx.save.set('hp', ctx.health.get('crate-0001'));
      ctx.save.set('patrol', ctx.patrol.get('rover-0001'));
      ctx.save.set('x100', at());
      ctx.save.set('touch100', ctx.hitbox.touching('ward-0001'));
      ctx.save.set('touch79', _s.touch79);
    }
  },
};
`;

describe('the components save section (page and worker)', () => {
  it.each(MODES)('health, a stopped patroller and a switched-off hitbox come back with a loaded save (threading: %s)', async (mode) => {
    const entities: Any[] = [
      { id: 'cam-main', components: { transform: T([0, 2, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 100 } } },
      { id: 'crate-0001', components: { transform: T([0, 0, 0]), health: { max: 5 } } },
      { id: 'rover-0001', components: { transform: T([0, 0, 0]), patrol: { mode: 'waypoints', waypoints: [[10, 0, 0]], speed: 1 }, hitbox: { size: [1, 1] } } },
      { id: 'ward-0001', components: { transform: T([0.5, 0, 0]), hitbox: { size: [2, 1] } } },
      { id: 'saver-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'saver', values: {} } } },
    ];
    const store = new Map<string, string>();
    const h = await startHarness(mode, {
      snapshot: { snapshotId: 'psave@r1', projectId: 'psave', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, saveSchema: { version: 1, slots: 2, sections: ['components', 'storage'] } },
      storage: true,
      settings: { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 },
      physics: null,
      digestSteps: true,
      behaviors: [behaviorModule('saver', SAVER)],
      host: { projectSaveBackend: memoryProjectSaveBackend(store), saveNamespace: 'test' },
    });
    live.push(h);
    let now = 10;
    while (h.digests.length < 110) {
      now += DT;
      await h.tick(now);
      await h.host.projectSaves?.idle();
      await new Promise((r) => setTimeout(r, 0));
    }
    const rt: Any = h.rt;
    const d = rt.getDiagnostics();
    expect(d.ok ? d.diagnostics.errors : d).toEqual([]);
    const body = JSON.parse(store.get('test:slot:1:body')!);
    expect(body.sections.components.health).toEqual({ 'crate-0001': 3 });
    expect(body.sections.components.off).toEqual(['ward-0001']);
    expect(body.sections.components.patrol['rover-0001'].a).toBe(false);
    const v: Any = await h.storage();
    // The hitboxes touched again after they were switched back on; after the load the ward is off again.
    expect(v['touch79']).toEqual(['rover-0001']);
    expect(v['touch100']).toEqual([]);
    expect(v['hp']).toEqual({ current: 3, max: 5 });
    expect(v['patrol']).toEqual({ direction: [1, 0, 0], active: false });
    expect(v['x100']).toBeCloseTo(v['x40'], 9);
  }, 60_000);
});
