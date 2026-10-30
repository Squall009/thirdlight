/**
 * What a cutscene (or a script walk) leaves a character with, through the
 * production composition (the real game host, the character controllers and
 * Rapier), on the main thread and in the simulation worker:
 *
 * - a stopped cutscene switches the character back on (it had switched it
 *   off) and gives the input back;
 * - a skip lands a walk under way on its mark facing a later turn key's way;
 * - a turn asked on arrival gives way to the player's input once nothing
 *   holds the character;
 * - a held character does not climb on the player's climb input;
 * - a loaded save ends a script's walk;
 * - a cutscene played in the step its character's scene was asked for
 *   holds and places that character once it arrives;
 * - a position key places a player character with the port's placement
 *   alone (no clearance query).
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf, sceneEntitiesFromDocument } from '@thirdlight/runtime';

import { modulesOf } from '../../game-modules';
import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { SETTINGS, STAND_Y } from '../3d/character-kit';

type Any = any;
const DT = 1 / 120;
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });

/** Logs [step, x, y, z, facing (degrees), on, the script walk's state] every 5 steps. */
const LOGGER = `
  const r = (v) => Math.round(v * 1e4) / 1e4;
  const logRow = (s, ctx, id) => {
    const n = ctx.stepIndex;
    if (n % 5 !== 0) return;
    const t = ctx.world.transform(id);
    if (t === undefined) return;
    const q = t.rotation;
    const on = ctx.physics.characterState()?.enabled ?? null;
    const key = 'log' + Math.floor(n / 100);
    const log = ctx.save.get(key) ?? [];
    log.push([n, r(t.position[0]), r(t.position[1]), r(t.position[2]), r((2 * Math.atan2(q[1], q[3]) * 180) / Math.PI), on, s.w ? ctx.character.walkState(s.w) : null]);
    ctx.save.set(key, log);
  };
`;

function box(id: string, c: number[], h: number[]): Any {
  return { id, components: { transform: T(c), collider: { shape: { type: 'box', hx: h[0], hy: h[1], hz: h[2] } } } };
}

function player(x: number, controller: Any = {}): Any[] {
  return [{ id: 'player-0001', components: { transform: T([x, STAND_Y, 0]), controller } }];
}

const FLOOR = box('floor-0001', [0, -0.5, 0], [30, 0.5, 30]);

interface RunSpec {
  /** Start-scene entities besides the script object. */
  entities: Any[];
  /** A later scene, loaded by `loadScene`. */
  later?: { sceneId: string; entities: Any[] };
  timelines: Any[];
  script: string;
  replay: (s: number) => Any;
  steps: number;
  saves?: boolean;
  wrapPhysics?: (port: Any) => Any;
}

async function run(mode: Mode, spec: RunSpec): Promise<{ log: Any[]; digests: string[]; errors: Any[]; logs: string[] }> {
  const director = { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } };
  const main = [...spec.entities, director];
  const all = [...main, ...(spec.later?.entities ?? [])];
  // A later scene's player needs a world from the start (the build names the backend from every scene).
  const physics = physics3DConfigOf(main, SETTINGS, spec.later !== undefined ? { required: true } : {});
  let loadScene: ((id: string) => Promise<Any>) | undefined;
  if (spec.later !== undefined) {
    const loaded = sceneEntitiesFromDocument({ schemaVersion: 4, sceneId: spec.later.sceneId, revision: 1, entities: spec.later.entities }, spec.later.sceneId);
    if (!loaded.ok) throw new Error(loaded.message);
    loadScene = async () => loaded.entities;
  }
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: 'dr@r1',
      projectId: 'dr',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [{ sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) }, ...(spec.later !== undefined ? [{ sceneId: spec.later.sceneId, start: false }] : [])],
      timelines: spec.timelines,
      // A loaded save brings the log back as it was saved; later rows are added to it.
      ...(spec.saves === true ? { saveSchema: { version: 1, slots: 2, sections: ['storage'] } } : {}),
    },
    storage: true,
    settings: SETTINGS,
    physics,
    replay: Array.from({ length: spec.steps + 100 }, (_, s) => ({ stepIndex: s, moveX: 0, moveY: 0, jump: 'none', actions: {}, ...spec.replay(s) })),
    digestSteps: true,
    modules: modulesOf({ scene: { entities: all } } as Any),
    ...(loadScene !== undefined ? { loadScene } : {}),
    ...(spec.wrapPhysics !== undefined ? { wrapPhysics: spec.wrapPhysics } : {}),
    behaviors: [behaviorModule('director', `${LOGGER}\n${spec.script}`)],
  });
  try {
    let now = 10;
    while (h.digests.length < spec.steps) {
      now += DT;
      await h.tick(now);
      if (spec.saves === true) {
        await h.host.projectSaves?.idle();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    const log = Array.from({ length: Math.ceil(spec.steps / 100) + 1 }, (_, i) => (values[`log${i}`] ?? []) as Any[]).flat();
    const rows: Any[] = d.ok ? d.diagnostics.errors : [d];
    return { log, digests: h.digests.slice(0, spec.steps), errors: rows.filter((e) => e.code !== 'behavior_log'), logs: rows.filter((e) => e.code === 'behavior_log').map((e) => String(e.message)) };
  } finally {
    await h.dispose();
  }
}

/**
 * Runs on the main thread, checks it, then in the worker: the same steps
 * (with saves the storage answers land at whichever step they beat, so the
 * worker run is checked the same way instead).
 */
async function bothModes(spec: RunSpec, check: (log: Any[], logs: string[]) => void): Promise<void> {
  const a = await run('single', spec);
  expect(a.errors).toEqual([]);
  check(a.log, a.logs);
  const w = await run('worker', spec);
  expect(w.errors).toEqual([]);
  if (spec.saves === true) check(w.log, w.logs);
  else expect(w.digests).toEqual(a.digests);
}

const rowOf = (log: Any[], s: number): Any[] => {
  const r = log.find((x: Any[]) => x[0] === s);
  expect(r, `step ${s}`).toBeDefined();
  return r;
};
const turnGap = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

describe('what a cutscene leaves behind', () => {
  const y = STAND_Y;
  // The later turn key's way: one the walk does not face.
  const later = 0;
  const slot = [{ name: 'hero', entity: 'player-0001' }];
  const timelines = [
    { timelineId: 'park', name: 'Park', duration: 5, slots: slot, tracks: [{ trackId: 'p', type: 'character', target: 'hero', keys: [{ time: 1, enabled: false }, { time: 4, enabled: true }] }] },
    {
      timelineId: 'skipturn',
      name: 'Skip turn',
      duration: 4,
      slots: slot,
      tracks: [{ trackId: 's', type: 'character', target: 'hero', keys: [{ time: 0, mode: 'place', position: [-2, y, 0], facing: 90 }, { time: 0.5, mode: 'walk', position: [2, y, 0] }, { time: 3, facing: later }] }],
    },
  ];
  /**
   * 10: the park cutscene (off at 1 s, on at 4 s), stopped at 250 (2 s in);
   * 500: the skip-turn cutscene, skipped at 620 while it walks; 700: a
   * script walk to x 3.5 that faces +X on arrival, while the input pushes left.
   */
  const script = `
export default {
  instantiate() { return { h: 0, k: 0, w: 0 }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    const n = ctx.stepIndex;
    if (n === 10) s.h = ctx.timeline.play('park');
    if (n === 250) ctx.timeline.stop(s.h);
    if (n === 500) s.k = ctx.timeline.play('skipturn');
    if (n === 620) ctx.timeline.skip(s.k);
    if (n === 700) s.w = ctx.character.walkTo([3.5, ${y}, 0], { facing: 90 });
    logRow(s, ctx, 'player-0001');
  },
};
`;
  it('a stop switches the character back on and gives the input back; a skip faces a later turn key; an arrival turn gives way to the input; page and worker agree', async () => {
    await bothModes(
      {
        entities: [...player(0), FLOOR],
        timelines,
        script,
        replay: (s) => ({ moveX: s < 450 ? 1 : s >= 700 ? -1 : 0 }),
        steps: 960,
      },
      (log) => {
        const at = (s: number) => rowOf(log, s);
        // Held, then switched off: the input pushing right does not move it.
        expect(Math.abs(at(240)[1] - at(150)[1])).toBeLessThan(0.01);
        expect(at(240)[5]).toBe(false);
        // Stopped at 2 s: on again, and the input moves it.
        expect(at(300)[5]).toBe(true);
        expect(at(440)[1]).toBeGreaterThan(at(260)[1] + 0.5);
        // Skipped mid-walk: on the walk's mark, facing the later turn key's way.
        expect(Math.abs(at(660)[1] - 2)).toBeLessThan(0.05);
        expect(turnGap(at(660)[4], later)).toBeLessThan(1);
        // The script walk arrived; the input then walks it left, facing left.
        expect(at(950)[6]).toBe('arrived');
        expect(at(950)[1]).toBeLessThan(at(850)[1] - 0.3);
        expect(turnGap(at(950)[4], -90)).toBeLessThan(1);
      },
    );
  }, 180_000);
});

describe('a held character', () => {
  it('does not take hold of a climb volume on the climb input until the cutscene ends (page and worker)', async () => {
    const timelines = [{ timelineId: 'hold', name: 'Hold', duration: 2, slots: [{ name: 'hero', entity: 'player-0001' }], tracks: [{ trackId: 'h', type: 'character', target: 'hero', keys: [{ time: 0, facing: 0 }] }] }];
    const script = `
export default {
  instantiate() { return {}; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 10) ctx.timeline.play('hold');
    logRow(s, ctx, 'player-0001');
  },
};
`;
    await bothModes(
      {
        entities: [...player(0, { climbAction: 'climb' }), FLOOR, { id: 'ladder-0001', components: { transform: T([0, 3, 0]), climbVolume: { size: [1, 6, 1] } } }],
        timelines,
        script,
        replay: (s) => (s >= 30 ? { actions: { climb: { v: 1, p: s === 30 ? 'pressed' : 'held' } } } : {}),
        steps: 420,
      },
      (log) => {
        const at = (s: number) => rowOf(log, s);
        // Held from step 10 to 250 (2 s): on the floor all the while.
        expect(at(240)[2]).toBeLessThan(STAND_Y + 0.02);
        // Then the climb input takes hold and it climbs.
        expect(at(410)[2]).toBeGreaterThan(STAND_Y + 0.5);
      },
    );
  }, 180_000);
});

describe('a loaded save', () => {
  it('ends a script walk: the character stays where the save put it (page and worker)', async () => {
    const script = `
export default {
  instantiate() { return { w: 0 }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    const n = ctx.stepIndex;
    if (n === 20) ctx.saves.save(1);
    if (n === 40) s.w = ctx.character.walkTo([6, ${STAND_Y}, 0]);
    if (n === 70) ctx.saves.load(1);
    logRow(s, ctx, 'player-0001');
  },
};
`;
    await bothModes(
      { entities: [...player(0), FLOOR], timelines: [], script, replay: () => ({}), steps: 300, saves: true },
      (log) => {
        const at = (s: number) => rowOf(log, s);
        // It stays where the save put it (x 0), its walk stopped.
        expect(Math.abs(at(290)[1])).toBeLessThan(0.05);
        expect(at(290)[6]).toBe('stopped');
      },
    );
  }, 180_000);
});

describe('a cutscene on a character whose scene is still loading', () => {
  it('holds and places it once its scene is in (played in the step the scene was asked for; page and worker)', async () => {
    const timelines = [
      {
        timelineId: 'arrive',
        name: 'Arrive',
        duration: 4,
        slots: [{ name: 'hero', entity: 'player-0001' }],
        tracks: [{ trackId: 'a', type: 'character', target: 'hero', keys: [{ time: 0, mode: 'place', position: [-2, STAND_Y, 0] }, { time: 0.5, mode: 'walk', position: [2, STAND_Y, 0] }] }],
      },
    ];
    const script = `
export default {
  instantiate() { return {}; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 10) {
      ctx.scenes.load('scene-hero');
      ctx.timeline.play('arrive');
    }
    logRow(s, ctx, 'player-0001');
  },
};
`;
    await bothModes(
      {
        entities: [{ id: 'cam-main', components: { transform: T([0, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } }],
        later: { sceneId: 'scene-hero', entities: [...player(5), FLOOR] },
        timelines,
        script,
        // The input pushes left the whole time.
        replay: () => ({ moveX: -1 }),
        steps: 560,
      },
      (log, logs) => {
        const at = (s: number) => rowOf(log, s);
        expect(logs.filter((m) => m.includes('not a player character'))).toEqual([]);
        // Placed at the first mark, walked to the second against the input, held there until the end (4 s from step 10).
        expect(Math.abs(at(470)[1] - 2)).toBeLessThan(0.1);
        expect(Math.abs(at(490)[1] - at(470)[1])).toBeLessThan(0.01);
        // Then the input moves it.
        expect(at(555)[1]).toBeLessThan(at(495)[1] - 0.3);
      },
    );
  }, 180_000);
});

describe('a position key on a player character', () => {
  it('places it with the port\'s placement alone (a physics world without the clearance query); nothing is logged', async () => {
    const timelines = [{ timelineId: 'move', name: 'Move', duration: 1, slots: [{ name: 'hero', entity: 'player-0001' }], tracks: [{ trackId: 'm', type: 'transform', target: 'hero', keys: [{ time: 0, position: [1, STAND_Y, 0] }, { time: 1, position: [3, STAND_Y, 0] }] }] }];
    const script = `
export default {
  instantiate() { return {}; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 10) ctx.timeline.play('move');
    logRow(s, ctx, 'player-0001');
  },
};
`;
    // The port without the character clearance query: a timeline's placement needs none.
    const wrapPhysics = (port: Any): Any => new Proxy(port, { get: (t, k) => (k === 'characterClearance' ? undefined : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    const a = await run('single', { entities: [...player(0), FLOOR], timelines, script, replay: () => ({}), steps: 200, wrapPhysics });
    expect(a.errors).toEqual([]);
    expect(a.logs.filter((m) => m.includes('cannot place'))).toEqual([]);
    const at = (s: number) => rowOf(a.log, s);
    // Half way through the key (step 70, 0.5 s in) and after it: the body went with the transform.
    expect(Math.abs(at(70)[1] - 2)).toBeLessThan(0.05);
    expect(Math.abs(at(190)[1] - 3)).toBeLessThan(0.01);
    expect(Math.abs(at(190)[2] - STAND_Y)).toBeLessThan(0.02);
  }, 60_000);
});
