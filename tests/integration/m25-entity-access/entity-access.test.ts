/**
 * Generic component access through the production composition,
 * on the main thread and in the simulation worker, on the 2D plane and in 3D.
 *
 * A neutral level and five scripts. The director reads and writes components
 * through `ctx.entity(id)` step by step and marks what it saw in counters:
 * - light intensity/colour/range: a write is seen from the next step (the
 *   step itself reads the step-start state);
 * - refusals name the field (a fixed field, a physics body's transform, the
 *   character's `active`, a mover-driven transform, a value out of range, a
 *   missing component, a data material parameter); a camera's transform is
 *   written like any object's;
 * - relaxed ownership: the director and a helper both move a plain box in
 *   one step — the later script wins and the conflict is in diagnostics;
 * - mover speed and `active` (held where it is), material parameters;
 * - object `active`: a script on a switched-off object does not tick, a
 *   switched-off ledge does not collide (the character falls through it; it
 *   collides again once switched on), a switched-off trigger fires no event;
 * - `visible`;
 * - `character_place` (2D too): from rest, velocity reset;
 * - a spawned prefab copy's object property names its own child (typed
 *   prefab-local reference), a text property spelling a local id is kept;
 * - `ctx.shell.nextScene()` moves to the next scene list entry.
 * The counters, hidden/inactive sets and light values agree in page and
 * worker, and every step's digest is identical in both modes and in a second
 * run (replays stay identical).
 */
import { describe, expect, it } from 'vitest';

import { materialCatalogOf, physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    const g = ctx.game;
    const E = (id) => ctx.entity(id);
    const mark = (name, ok) => { if (ok) g.add(name, 1); };
    const y = () => E('player-0001').get('transform').position[1];
    g.add('steps', 1);
    if (s === 5) {
      const l = E('lamp-0001');
      mark('l_before', l.get('light').intensity === 30 && l.get('light').range === 8 && l.get('light').decay === 2);
      mark('l_queued', l.set('light', { intensity: 60, color: '#FF0000', range: 4 }).ok);
      mark('l_stepstart', l.get('light').intensity === 30);
    }
    if (s === 6) { const v = E('lamp-0001').get('light'); mark('l_after', v.intensity === 60 && v.color === '#ff0000' && v.range === 4 && v.type === 'point' && Object.isFrozen(v)); }
    if (s === 7) {
      const r1 = E('lamp-0001').set('light', { type: 'spot' }); mark('r_type', !r1.ok && r1.field === 'light.type' && r1.code === 'field_not_writable');
      const r2 = E('floor-0001').set('transform', { position: [0, 0, 0] }); mark('r_phys', !r2.ok && r2.code === 'entity_physics' && r2.field === 'transform.position');
      // A camera is a shot: a script moves it like any object (here to where it is).
      const r3 = E('cam-main').set('transform', { position: [0, 4, 14] }); mark('r_cam', r3.ok);
      const r4 = E('player-0001').set('object', { active: false }); mark('r_char', !r4.ok && r4.code === 'entity_character' && r4.field === 'object.active');
      const r5 = E('lift-0001').set('transform', { position: [0, 0, 0] }); mark('r_driven', !r5.ok && r5.code === 'entity_driven');
      const r6 = E('lamp-0001').set('light', { intensity: -1 }); mark('r_range', !r6.ok && r6.code === 'field_value' && r6.field === 'light.intensity');
      const r7 = E('deco-0001').set('light', { intensity: 1 }); mark('r_missing', !r7.ok && r7.code === 'component_missing');
      const r8 = E('floor-0001').set('collider', { oneWay: true }); mark('r_fixed', !r8.ok && r8.code === 'field_not_writable' && r8.field === 'collider.oneWay');
      mark('null_ref', ctx.entity(null) === null && ctx.entity('nothing-0001') === null);
      let threw = false;
      try { E('lamp-0001').get('instances'); } catch (e) { threw = true; }
      mark('r_get', threw);
      mark('get_missing', E('deco-0001').get('light') === null && E('floor-0001').get('collider') !== null);
    }
    if (s === 10) E('deco-0001').set('transform', { position: [1, 2, 0] });
    if (s === 11) mark('deco_x3', E('deco-0001').get('transform').position[0] === 3);
    if (s === 12) {
      E('lift-0001').set('mover', { speed: 4 });
      mark('m_q', E('deco-0001').set('materialParams', { overlay: { amount: 0.5 } }).ok);
      mark('m_same', E('deco-0001').get('materialParams').overlay.amount === 0);
      const r = E('deco-0001').set('materialParams', { overlay: { cells: 1 } });
      mark('m_data', !r.ok && r.code === 'material_parameter' && r.field === 'materialParams.overlay.cells');
    }
    if (s === 13) {
      mark('mv_speed', E('lift-0001').get('mover').speed === 4);
      state.liftA = E('lift-0001').get('transform').position[0];
      // The other transform fields: a quarter turn about Z (normalized) and a scale.
      E('deco-0001').set('transform', { rotation: [0, 0, 2, 2], scale: [2, 3, 4] });
    }
    if (s === 14) {
      // At 4 m/s the lift covers 4/120 m per step (it was 2 m/s).
      mark('mv_fast', Math.abs(E('lift-0001').get('transform').position[0] - state.liftA - 4 / 120) < 1e-9);
      const t = E('deco-0001').get('transform');
      mark('rot_scale', Math.abs(t.rotation[2] - Math.SQRT1_2) < 1e-12 && Math.abs(t.rotation[3] - Math.SQRT1_2) < 1e-12 && t.scale.join(',') === '2,3,4' && t.position[0] === 3);
    }
    if (s === 13) {
      mark('m_after', E('deco-0001').get('materialParams').overlay.amount === 0.5 && ctx.materials.get('deco-0001', 'amount') === 0.5);
    }
    if (s === 20) {
      E('lift-0001').set('mover', { active: false });
      ctx.spawn('crate', { position: [30, 3] });
    }
    if (s === 30) state.liftX = E('lift-0001').get('transform').position[0];
    if (s === 60) mark('mv_held', E('lift-0001').get('transform').position[0] === state.liftX && E('lift-0001').get('mover').active === false);
    if (s === 40) E('ticker-0001').set('object', { active: false });
    if (s === 41) mark('t_off', E('ticker-0001').get('object').active === false);
    if (s === 45) ctx.character.impulse([0, 20, 0]);
    if (s === 50) ctx.emit({ kind: 'character_place', position: [10, 6.5, 0] });
    // Placed from rest: one step later it has not risen (the impulse was dropped with its velocity).
    if (s === 52) mark('placed_rest', y() <= 6.5001 && y() > 6.4);
    if (s === 100) E('ticker-0001').set('object', { active: true });
    if (s === 150) mark('on_ledge', y() > 5);
    if (s === 160) E('ledge-0001').set('object', { active: false });
    if (s === 161) mark('ledge_off', E('ledge-0001').get('object').active === false);
    if (s === 260) mark('fell', y() < 1.5);
    if (s === 262) E('zone-0001').set('object', { active: false });
    if (s === 265) ctx.emit({ kind: 'character_place', position: [-6, 1, 0] });
    if (s === 300) { mark('no_enter_off', g.counter('enter') === 0); E('zone-0001').set('object', { active: true }); }
    if (s === 320) E('deco-0001').set('object', { visible: false });
    if (s === 321) mark('hidden', E('deco-0001').get('object').visible === false && E('deco-0001').get('object').active === true);
    if (s === 340) E('ledge-0001').set('object', { active: true });
    if (s === 345) ctx.emit({ kind: 'character_place', position: [10, 6.5, 0] });
    if (s === 440) mark('ledge_back', y() > 5);
    if (s === 500) mark('next', ctx.shell.nextScene() && ctx.shell.sceneCount() === 2);
    if (s === 580) mark('arrived', ctx.shell.sceneIndex() === 1 && Math.abs(E('player-0001').get('transform').position[0] - 40) < 1);
    if (s === 581) mark('no_next', ctx.shell.nextScene() === false);
  },
};
`;
const HELPER = `
export default {
  step(state, ctx) {
    if (ctx.phase === 'intent' && ctx.stepIndex === 10) ctx.entity('deco-0001').set('transform', { position: [3, 2, 0] });
  },
};
`;
const TICKER = `export default { step(state, ctx) { if (ctx.phase === 'intent') ctx.game.add('ticks', 1); } };`;
const WATCHER = `
export default {
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    for (const e of ctx.events ?? []) if (e.type === 'enter' && e.trigger === ctx.properties.zone) ctx.game.add('enter', 1);
  },
};
`;
const REFS = `
export default {
  instantiate() { return { seen: false }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent' || state.seen) return;
    state.seen = true;
    const p = ctx.properties;
    const child = p.target === null ? null : ctx.entity(p.target);
    if (p.target !== 'lid' && child !== null && child.get('object').parentId === ctx.entityId && p.label === 'lid') ctx.game.add('prefab_ref', 1);
  },
};
`;
const REFS_DECLARATION = { properties: [{ key: 'target', label: 'Target', type: 'entityRef', default: null }, { key: 'label', label: 'Label', type: 'string', default: '' }] };
const WATCHER_DECLARATION = { properties: [{ key: 'zone', label: 'Zone', type: 'entityRef', default: null }] };

const MATERIALS = [
  {
    materialId: 'overlay',
    name: 'Overlay',
    shader: 'unlit',
    params: {},
    textures: {},
    parameters: [
      { key: 'amount', type: 'float', default: 0, min: 0, max: 1 },
      { key: 'cells', type: 'data', default: [0, 0, 0, 0], size: [4, 4] },
    ],
    graph: { nodes: [{ id: 'out', type: 'unlit', position: [0, 0] }], edges: [] },
  },
];

type Dim = 2 | 3;

function level(dim: Dim): { main: Any[]; two: Any[] } {
  const box = (hx: number, hy: number, hz: number) => (dim === 3 ? { type: 'box', hx, hy, hz } : { type: 'box', hx, hy });
  const main: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 300 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [60, 1, 4], material: { color: '#888888' } }, collider: { shape: box(30, 0.5, 2) } } },
    { id: 'ledge-0001', components: { transform: T([10, 5, 0]), box: { size: [3, 0.5, 3], material: { color: '#777777' } }, collider: { shape: box(1.5, 0.25, 1.5) } } },
    { id: 'lamp-0001', components: { transform: T([0, 3, 0]), light: { type: 'point', color: '#ffffff', intensity: 30, range: 8, decay: 2 } } },
    { id: 'lift-0001', components: { transform: T([20, 1, 0]), box: { size: [1, 0.2, 1], material: { color: '#aaaaaa' } }, mover: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong' } } },
    { id: 'deco-0001', components: { transform: T([-10, 2, 0]), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, materials: { '*': 'overlay' } } },
    { id: 'zone-0001', components: { transform: T([-6, 1.5, 0]), trigger: dim === 3 ? { size: [2, 3, 2], signal: 'zone' } : { size: [2, 3], signal: 'zone' } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'helper-0001', components: { transform: T([1, -5, 0]), behavior: { behaviorId: 'helper', values: {} } } },
    { id: 'ticker-0001', components: { transform: T([2, -5, 0]), behavior: { behaviorId: 'ticker', values: {} } } },
    { id: 'watcher-0001', components: { transform: T([3, -5, 0]), behavior: { behaviorId: 'watcher', values: { zone: 'zone-0001' } } } },
  ];
  const two: Any[] = [
    { id: 'floor-0002', components: { transform: T([40, -0.5, 0]), box: { size: [10, 1, 4], material: { color: '#888888' } }, collider: { shape: box(5, 0.5, 2) } } },
    { id: 'spawn-0002', components: { transform: T([40, 0.91, 0]), playerSpawn: {} } },
  ];
  return { main, two };
}

const PREFABS = [
  {
    prefabId: 'crate',
    displayName: 'Crate',
    createdRevision: 1,
    entityCount: 2,
    depth: 2,
    entities: [
      { localId: 'root', components: { transform: T([0, 0, 0]), box: { size: [1, 1, 1], material: { color: '#aa7733' } }, behavior: { behaviorId: 'refs', values: { target: 'lid', label: 'lid' } } } },
      { localId: 'lid', parentLocalId: 'root', components: { transform: T([0, 0.6, 0]), box: { size: [1, 0.2, 1], material: { color: '#cc9955' } } } },
    ],
  },
];

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

function physicsOf(dim: Dim, main: Any[]): { settings: Any; physics: Any } {
  if (dim === 3) return { settings: SETTINGS_3D, physics: physics3DConfigOf(main, SETTINGS_3D) };
  const statics = main
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  return {
    settings: SETTINGS_2D,
    physics: { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } },
  };
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];
const STEPS = 640;

interface Outcome {
  counters: Record<string, number>;
  digests: string[];
  hidden: string[];
  inactive: string[];
  lights: [string, Any][];
  writes: Any;
  errors: Any[];
}

async function run(mode: Mode, dim: Dim): Promise<Outcome> {
  const { main, two } = level(dim);
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: `access${dim}@r1`,
      projectId: `access${dim}`,
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-two', start: false },
      ],
      sceneList: [{ scene: 'scene-main' }, { scene: 'scene-two', spawn: 'spawn-0002' }],
      prefabs: PREFABS,
      materialCatalog: materialCatalogOf(MATERIALS as Any, []),
    },
    ...physicsOf(dim, main),
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [
      behaviorModule('director', DIRECTOR),
      behaviorModule('helper', HELPER),
      behaviorModule('ticker', TICKER),
      behaviorModule('watcher', WATCHER, WATCHER_DECLARATION),
      behaviorModule('refs', REFS, REFS_DECLARATION),
    ],
    loadScene: async (sceneId: string) => {
      if (sceneId !== 'scene-two') throw new Error('unknown scene');
      return two;
    },
    replay: Array.from({ length: STEPS + 200 }, (_, s) => ({ stepIndex: s, moveX: 0, ...(dim === 3 ? { moveY: 0 } : {}), jump: 'none' as const, actions: {} })),
    digestSteps: true,
  });
  try {
    let now = 10;
    await h.tick(now);
    let i = 0;
    while (h.digests.length < STEPS) {
      now += PATTERN[i++ % PATTERN.length]! * DT;
      try {
        await h.tick(now);
      } catch (e) {
        const d = (h.rt as Any).getDiagnostics();
        throw new Error(`${String(e)} at step ${h.digests.length}: ${JSON.stringify(d.ok ? d.diagnostics.errors.slice(-3) : d).slice(0, 2500)}`);
      }
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    // A frame without a step brings the last diagnostics over.
    await h.tick(now);
    const rt: Any = h.rt;
    const d = rt.getDiagnostics();
    return {
      counters: { ...(rt.gameCounters?.()?.counters ?? {}) },
      digests: h.digests.slice(0, STEPS),
      hidden: [...(rt.hiddenEntities?.() ?? [])].sort(),
      inactive: [...(rt.inactiveEntities?.() ?? [])].sort(),
      lights: [...(rt.lightOverrides?.() ?? new Map())],
      writes: d.ok ? d.diagnostics.entityWrites : null,
      errors: d.ok ? d.diagnostics.errors : [],
    };
  } finally {
    await h.dispose();
  }
}

const MARKS = [
  'l_before', 'l_queued', 'l_stepstart', 'l_after',
  'r_type', 'r_phys', 'r_cam', 'r_char', 'r_driven', 'r_range', 'r_missing', 'r_fixed', 'null_ref', 'r_get', 'get_missing',
  'deco_x3', 'm_q', 'm_same', 'm_data', 'mv_speed', 'mv_fast', 'rot_scale', 'm_after', 'mv_held', 't_off', 'placed_rest',
  'on_ledge', 'ledge_off', 'fell', 'no_enter_off', 'hidden', 'ledge_back', 'next', 'arrived', 'no_next', 'prefab_ref',
];

describe('ctx.entity get/set, relaxed ownership, typed references, ctx.shell', () => {
  for (const dim of [2, 3] as const) {
    it(`reads, writes and refuses as described, alike in page and worker, replays identical (${dim}D)`, async () => {
      const single = await run('single', dim);
      const expected = Object.fromEntries(MARKS.map((m) => [m, 1]));
      expect(single.counters, JSON.stringify(single.errors).slice(0, 2000)).toMatchObject(expected);
      // The ticker was switched off for steps 41–100: it missed exactly 60 steps.
      expect(single.counters['steps']! - single.counters['ticks']!).toBe(60);
      // The switched-off zone fired nothing; switched on with the character inside, one entry.
      expect(single.counters['enter']).toBe(1);
      expect(single.hidden).toContain('deco-0001');
      expect(single.inactive).toEqual([]);
      expect(single.lights).toEqual([['lamp-0001', { intensity: 60, color: '#ff0000', range: 4 }]]);
      // Two writers of the box in one step: one conflict, reported; refusals noted.
      expect(single.writes).toMatchObject({ conflicts: 1 });
      expect(single.writes.refused).toBeGreaterThanOrEqual(8);
      expect(single.errors.some((e: Any) => e.code === 'entity_write' && e.reason === 'conflict' && /deco-0001/.test(e.message) && /helper/.test(e.message))).toBe(true);
      expect(single.errors.some((e: Any) => e.code === 'entity_write' && e.reason === 'refused' && e.detail === 'field_not_writable' && /light\.type/.test(e.message))).toBe(true);

      const worker = await run('worker', dim);
      expect(worker.counters).toEqual(single.counters);
      expect(worker.hidden).toEqual(single.hidden);
      expect(worker.lights).toEqual(single.lights);
      expect(worker.digests).toEqual(single.digests);

      // A second run plays the same, step for step.
      const again = await run('single', dim);
      expect(again.digests).toEqual(single.digests);
    }, 240_000);
  }
});
