/**
 * Block layers collide on the 2D plane — the layer's collision shapes cut
 * at the play plane (z = 0) and given to Rapier 2D, through the production
 * composition (the real game host, the platformer controller, Rapier), on
 * the main thread and in the simulation worker, driven by a recorded input.
 *
 * Sprout's case: a 2D project whose ground is a block layer standing across
 * z = 0, with a one-way ledge, a stairs block, a 1:2 slope of sloped
 * corners, a plateau across a chunk edge and a pit with no cells. The player
 * stands on the ground, jumps up through the ledge and stands on it, drops
 * through it (down + jump), walks up the stairs and the slope and falls into
 * the pit. `ctx.grid.surface` at the player agrees with where it stands.
 * Page and worker agree step by step. The next Play of the layer with the
 * pit filled (an edit) walks over it, and a script's cell write in Play digs
 * a hole the player falls through in the same run.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { physics2DConfigOf, sceneEntitiesFromDocument } from '@thirdlight/runtime';

import { modulesOf } from '../../game-modules';
import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS = { run_speed: 4, jump_velocity: 11, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
// Steps of a quarter metre are climbed by the controller's autostep, as a side-view game's player does.
const CONTROLLER = { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: true, autostepHeight: 0.3 };
/** The capsule's centre above its feet (radius 0.3 + half-height 0.6) plus the skin. */
const FEET = 0.91;
const L = 'ground-0001';
/** Half-metre rows, one metre wide; the layer stands from z −1 to 1, so the plane z = 0 is the boundary into its row 1. */
const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 12, 2] } };
const TYPES = [
  { blockId: 'earth', name: 'Earth', variants: [{ color: '#7a5a3a' }], shape: 'full' },
  { blockId: 'steps', name: 'Steps', variants: [{ color: '#999999' }], shape: 'stairs' },
  { blockId: 'plank', name: 'Plank', variants: [{ color: '#a0703a' }], shape: 'full', oneWay: true },
];

/** x 0-6 ground (top 1), ledge x 1-4 at 3-3.5, stairs at x 6, x 7-10 top 1.5, a 1:2 slope x 10-14 to 3.5, x 14-18 top 3.5, the pit x 18-22, x 22-32 ground. */
function cells(pitFilled: boolean): Any {
  const g = new BlockGrid(LAYER as Any);
  const fill = (x0: number, y0: number, x1: number, y1: number, cell: Any): Any => ({ kind: 'fill', box: [x0, y0, 0, x1, y1, 2], cell });
  const earth = { block: 'earth' };
  applyBlockEdits(
    g,
    [
      fill(0, 0, 7, 2, earth),
      fill(1, 6, 4, 7, { block: 'plank' }),
      fill(6, 2, 7, 3, { block: 'steps', rot: 90 }),
      fill(7, 0, 14, 3, earth),
      fill(10, 3, 11, 4, { block: 'earth', corners: [0, 1, 1, 0] }),
      fill(11, 3, 12, 4, { block: 'earth', corners: [1, 2, 2, 1] }),
      fill(12, 3, 13, 4, { block: 'earth', corners: [2, 3, 3, 2] }),
      fill(13, 3, 14, 4, { block: 'earth', corners: [3, 4, 4, 3] }),
      fill(14, 0, 18, 7, earth),
      ...(pitFilled ? [fill(18, 0, 22, 7, earth)] : []),
      fill(22, 0, 32, 2, earth),
    ] as Any,
    { types: new Map(TYPES.map((t) => [t.blockId, t as Any])), stamps: new Map() },
  );
  return g.toData(L, null, g.takeDirty().chunks)!;
}

/** Logs every 5 steps where the player is and the layer's surface under it; with `dig`, clears x 15-17 of the plateau at step 500. */
const watch = (dig: boolean): string => `
export default {
  instantiate() { return {}; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    const n = ctx.stepIndex;
    if (${dig} && n === 500) {
      for (let x = 15; x < 17; x++) for (let y = 0; y < 7; y++) for (let z = 0; z < 2; z++) ctx.grid.clear('${L}', x, y, z);
    }
    if (n % 5 !== 0) return;
    const p = ctx.world.transform('player-0001').position;
    const surface = ctx.grid.surface('${L}', [p[0], p[1], 0]);
    const r = (v) => Math.round(v * 1e4) / 1e4;
    const key = 'log' + Math.floor(n / 100);
    const log = ctx.save.get(key) ?? [];
    log.push([n, r(p[0]), r(p[1]), surface === null ? null : r(surface.height)]);
    ctx.save.set(key, log);
  },
};
`;

/** Stands until 60, jumps at 60 (held for half a second), down + jump at 240, walks right from 360. */
function recording(n: number): Any[] {
  return Array.from({ length: n + 100 }, (_, s) => ({
    stepIndex: s,
    moveX: s >= 360 ? 1 : 0,
    moveY: 0,
    jump: s === 60 || s === 240 ? 'pressed' : (s > 60 && s < 120) || (s > 240 && s < 250) ? 'held' : s === 120 || s === 250 ? 'released' : 'none',
    actions: s >= 230 && s < 250 ? { navigate: { v: 1, x: 0, y: -1, p: 'held' } } : {},
  }));
}

async function run(mode: Mode, steps: number, opts: { pitFilled?: boolean; dig?: boolean } = {}): Promise<{ log: Any[]; digests: string[]; errors: Any[] }> {
  const entities: Any[] = [
    { id: 'player-0001', components: { transform: T([2.5, 1 + FEET, 0]), controller: {} } },
    { id: L, components: { transform: T([0, 0, -1]), blockLayer: LAYER } },
    { id: 'watch-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'watch', values: {} } } },
  ];
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: 'bp@r1',
      projectId: 'bp',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [cells(opts.pitFilled === true)] },
      scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }],
      blockTypes: TYPES,
    },
    storage: true,
    settings: SETTINGS,
    physics: { character: { x: 2.5, y: 1 + FEET }, statics: [], solver: { hz: 120, gravityY: SETTINGS.gravity_y }, controller: CONTROLLER },
    replay: recording(steps),
    digestSteps: true,
    behaviors: [behaviorModule('watch', watch(opts.dig === true))],
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
    const all: Any[] = d.ok ? d.diagnostics.errors : [d];
    return { log, digests: h.digests.slice(0, steps), errors: all.filter((e) => e.code !== 'behavior_log') };
  } finally {
    await h.dispose();
  }
}

/** A logged row: [step, x, y, surface height under it]. */
const rowOf = (log: Any[], s: number): Any[] => {
  const r = log.find((x: Any[]) => x[0] === s);
  expect(r, `step ${s}`).toBeDefined();
  return r;
};

describe('a block layer is the ground of a 2D project', () => {
  it('stands, jumps through a one-way ledge and drops back, walks up stairs and a 1:2 slope, falls into the pit; the surface query agrees; page and worker agree', async () => {
    const steps = 1100;
    const a = await run('single', steps);
    expect(a.errors).toEqual([]);
    const at = (s: number) => rowOf(a.log, s);
    // Standing on the ground (top 1) where it started, and the surface under it says so.
    expect(at(50)[1]).toBeCloseTo(2.5, 3);
    expect(at(50)[2]).toBeCloseTo(1 + FEET, 2);
    expect(at(50)[3]).toBeCloseTo(1, 4);
    // Up through the one-way ledge (bottom 3) and standing on it (top 3.5).
    expect(at(200)[2]).toBeCloseTo(3.5 + FEET, 2);
    expect(at(225)[2]).toBeCloseTo(3.5 + FEET, 2);
    expect(at(200)[3]).toBeCloseTo(3.5, 4);
    // Down + jump drops through it to the ground.
    expect(at(350)[2]).toBeCloseTo(1 + FEET, 2);
    // Walking right: up the stairs (top 1.5), the slope (to 3.5) and across the plateau's chunk edge at x 16.
    const walk = a.log.filter((r) => r[0] >= 360);
    const on = (x0: number, x1: number) => walk.filter((r) => r[1] >= x0 && r[1] <= x1);
    expect(on(7.5, 9.5).length).toBeGreaterThan(3);
    for (const r of on(7.5, 9.5)) expect(r[2] - FEET).toBeCloseTo(1.5, 1);
    // On the slope the feet follow the line from 1.5 at x 10 to 3.5 at x 14 (the round bottom touches it a little ahead).
    expect(on(10.5, 13.5).length).toBeGreaterThan(3);
    for (const r of on(10.5, 13.5)) expect(Math.abs(r[2] - FEET - (1.5 + (r[1] - 10) / 2))).toBeLessThan(0.08);
    expect(on(14.5, 17.5).length).toBeGreaterThan(3);
    for (const r of on(14.5, 17.5)) expect(r[2] - FEET).toBeCloseTo(3.5, 1);
    // Where it stands, the surface query gives the height of its feet (on the slope within the round bottom's lead).
    for (const r of [...on(1, 5).filter((x) => x[0] < 380), ...on(7.5, 9.5), ...on(14.5, 17.5)]) expect(Math.abs(r[2] - FEET - r[3])).toBeLessThan(0.01);
    for (const r of on(10.5, 13.5)) expect(Math.abs(r[2] - FEET - r[3])).toBeLessThan(0.08);
    expect(at(200)[3]).toBeCloseTo(at(200)[2] - FEET, 2);
    // Into the pit: no cell holds it, it falls below the ground's bottom between the plateau and the far ground.
    const fell = a.log.find((r) => r[0] > 360 && r[2] - FEET < 0)!;
    expect(fell[1]).toBeGreaterThan(18);
    expect(fell[1]).toBeLessThan(22);
    expect(a.log[a.log.length - 1][2]).toBeLessThan(-3);
    const w = await run('worker', steps);
    expect(w.errors).toEqual([]);
    expect(w.digests).toEqual(a.digests);
  }, 180_000);

  it('the next Play of the layer with the pit filled walks across it; a script digging the plateau mid-run drops the player through', async () => {
    const filled = await run('single', 1100, { pitFilled: true });
    expect(filled.errors).toEqual([]);
    const end = filled.log[filled.log.length - 1];
    expect(end[1]).toBeGreaterThan(22);
    expect(end[2]).toBeGreaterThan(1);
    const dug = await run('single', 1100, { pitFilled: true, dig: true });
    expect(dug.errors).toEqual([]);
    // Up to step 500 the same walk; then it falls through the hole dug at x 15-17.
    expect(dug.log.filter((r) => r[0] <= 500)).toEqual(filled.log.filter((r) => r[0] <= 500));
    const fell = dug.log.find((r) => r[0] > 500 && r[2] - FEET < 0)!;
    expect(fell[1]).toBeGreaterThan(14.5);
    expect(fell[1]).toBeLessThan(17.5);
  }, 180_000);
});

describe('a block layer arriving with a later scene, its player with it', () => {
  // The start scene holds no player, collider or layer (a title, a script);
  // the script loads the level, whose player stands over a block ground.
  const director = `
export default {
  instantiate() { return {}; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 10) ctx.scenes.load('scene-level');
    if (ctx.stepIndex % 10 !== 0) return;
    const t = ctx.world.transform('player-0001');
    const r = (v) => Math.round(v * 1e4) / 1e4;
    const surface = t === undefined ? null : ctx.grid.surface('${L}', [t.position[0], t.position[1], 0]);
    const log = ctx.save.get('log') ?? [];
    log.push([ctx.stepIndex, t === undefined ? null : r(t.position[0]), t === undefined ? null : r(t.position[1]), surface === null ? null : r(surface.height)]);
    ctx.save.set('log', log);
  },
};
`;
  async function late(mode: Mode, steps: number): Promise<{ log: Any[]; digests: string[]; errors: Any[] }> {
    const main: Any[] = [
      { id: 'cam-main', components: { transform: T([0, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
      { id: 'director', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
    ];
    const level: Any[] = [
      // Its own controller climbs the quarter-metre steps (an arriving player brings its tuning with it).
      { id: 'player-0001', components: { transform: T([2.5, 3, 0]), controller: { autostep: true, autostepHeight: 0.3 } } },
      { id: L, components: { transform: T([0, 0, -1]), blockLayer: LAYER } },
    ];
    const doc = { schemaVersion: 4, sceneId: 'scene-level', revision: 1, entities: level, blocks: [cells(false)] };
    const loaded = sceneEntitiesFromDocument(doc, 'scene-level');
    if (!loaded.ok) throw new Error(loaded.message);
    const h = await startHarness(mode, {
      snapshot: {
        snapshotId: 'bpl@r1',
        projectId: 'bpl',
        revision: 1,
        scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
        scenes: [
          { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
          { sceneId: 'scene-level', start: false },
        ],
        blockTypes: TYPES,
      },
      storage: true,
      settings: SETTINGS,
      // The build's rule: the modules come from every scene, so the level's player names the 2D backend.
      modules: modulesOf({ scene: { entities: [...main, ...level] } } as Any, SETTINGS, { dimension: 2 }),
      physics: physics2DConfigOf(main, SETTINGS, { required: true }),
      replay: Array.from({ length: steps + 100 }, (_, s) => ({ stepIndex: s, moveX: s >= 200 ? 1 : 0, moveY: 0, jump: 'none' })),
      digestSteps: true,
      loadScene: async () => loaded.entities,
      behaviors: [behaviorModule('director', director)],
    });
    try {
      let now = 10;
      while (h.digests.length < steps) {
        now += DT;
        await h.tick(now);
      }
      const d = (h.rt as Any).getDiagnostics();
      const all: Any[] = d.ok ? d.diagnostics.errors : [d];
      return { log: ((await h.storage()) as Any).log ?? [], digests: h.digests.slice(0, steps), errors: all.filter((e) => e.code !== 'behavior_log') };
    } finally {
      await h.dispose();
    }
  }

  it('the player lands on the blocks, walks up the stairs and falls into the pit; page and worker agree', async () => {
    const steps = 900;
    const a = await late('single', steps);
    expect(a.errors).toEqual([]);
    const at = (s: number) => rowOf(a.log, s);
    expect(at(0)[1]).toBeNull();
    // Landed on the ground (top 1) where the level put it; the surface query agrees.
    expect(at(150)[1]).toBeCloseTo(2.5, 3);
    expect(at(150)[2]).toBeCloseTo(1 + FEET, 2);
    expect(at(150)[3]).toBeCloseTo(1, 4);
    // Walking right over the stairs onto the step at 1.5, later into the pit.
    const on = a.log.filter((r) => r[0] > 200 && r[1] >= 7.5 && r[1] <= 9.5);
    expect(on.length).toBeGreaterThan(3);
    for (const r of on) expect(r[2] - FEET).toBeCloseTo(1.5, 1);
    expect(a.log[a.log.length - 1][2]).toBeLessThan(1);
    const w = await late('worker', steps);
    expect(w.errors).toEqual([]);
    expect(w.digests).toEqual(a.digests);
  }, 180_000);
});
