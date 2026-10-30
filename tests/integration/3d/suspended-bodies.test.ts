/**
 * Bodies outside the loaded collision, through the production game host on
 * the Rapier 3D backend, in the page and in the simulation worker.
 *
 * A streamed block floor 160 m long collides only within its ring round the
 * player (4 m asked, so the chunk the player stands in). An NPC (an edge
 * walker with gravity) walks away from the player and a rock falls from
 * high up. At step 40 a script places the player 100 m away: the floor
 * under the NPC and the rock leaves the ring, and both are suspended (they
 * neither fall through the world nor move) with their state kept. At step
 * 160 the player comes back: both resume in that step, the rock with the
 * fall speed it had. The NPC walks on to the loaded floor's edge and waits
 * there, suspended, instead of turning back at a ledge that is only not
 * loaded; when the player comes near, it walks on across. Every step's
 * digest agrees in page and worker, and two page runs agree.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from './character-kit';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const STEPS = 660;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 8, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

/**
 * Moves the player (40: far away; 160: back; 520: near the NPC) and keeps a
 * small summary in the save: per step from 38 on, the NPC's x and y, the
 * rock's y and who is suspended, at the steps the test reads.
 */
const DIRECTOR = `
const KEEP = (s) => (s >= 38 && s <= 44) || (s >= 158 && s <= 164) || s % 60 === 0 || s === 500 || s === 659 || (s >= 518 && s <= 524);
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    if (s === 40) ctx.character.place([100, 0.91, 0]);
    if (s === 160) ctx.character.place([1, 0.91, 0]);
    if (s === 520) ctx.character.place([12, 0.91, 0]);
    const w = ctx.world.transform('walker-0001').position;
    const r = ctx.world.transform('rock-0001').position;
    const sus = ['walker-0001', 'rock-0001', 'player-0001'].map((id) => ctx.physics.isSuspended(id));
    const sum = ctx.save.get('sum') ?? { rows: [], walkerHeld: 0, rockHeld: 0, playerHeld: 0, lowest: 99 };
    if (sus[0]) sum.walkerHeld += 1;
    if (sus[1]) sum.rockHeld += 1;
    if (sus[2]) sum.playerHeld += 1;
    sum.lowest = Math.min(sum.lowest, w[1], r[1]);
    if (KEEP(s)) sum.rows.push([s, w[0], w[1], r[1], sus]);
    ctx.save.set('sum', sum);
  },
};
`;

/** A streamed block floor (one-metre cells, 16 m chunks, top at y = 0) whose collision ring reaches 4 m round the player. */
function streamedFloor(): { entity: Any; data: Any; types: Any[] } {
  const layer = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [160, 2, 16] }, streaming: { render: 4, collision: 4, hysteresis: 2 } };
  const types = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];
  const g = new BlockGrid(layer as Any);
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 160, 2, 16], cell: { block: 'stone' } }], { types: new Map(types.map((t) => [t.blockId, t as Any])), stamps: new Map() });
  return { entity: { id: 'floor-0001', components: { transform: T([-1, -1, -8]), blockLayer: layer } }, data: g.toData('floor-0001', null, g.takeDirty().chunks)!, types };
}

async function run(mode: Mode): Promise<{ sum: Any; digests: string[]; held: number[]; diag: Any; errors: Any[] }> {
  const floor = streamedFloor();
  const entities: Any[] = [
    // The camera is a source of the rings too: it stands over the floor's middle, away from everything here.
    { id: 'cam-main', components: { transform: T([60, 10, 0]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([1, 0.91, 0]), controller: {} } },
    floor.entity,
    { id: 'walker-0001', components: { transform: T([4, 0.5, 0]), patrol: { mode: 'edges', speed: 4, size: [1, 1, 1], direction: [1, 0, 0] }, gravity: { size: [1, 1, 1] } } },
    { id: 'rock-0001', components: { transform: T([10, 20, 0]), gravity: { size: [0.5, 0.5, 0.5] } } },
    { id: 'director', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  const h = await startHarness(mode, {
    snapshot: { snapshotId: 'suspend@r1', projectId: 'suspend', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [floor.data] }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }], blockTypes: floor.types },
    storage: true,
    settings: SETTINGS,
    physics: physics3DConfigOf(entities, SETTINGS),
    modules: MODULES_3D,
    digestSteps: true,
    behaviors: [behaviorModule('director', DIRECTOR)],
  });
  const rt = h.rt as Any;
  // The suspended-body count the main thread's runtime reports (single mode), by step.
  const held: number[] = [];
  try {
    let now = 10;
    while (h.digests.length < STEPS) {
      now += DT;
      await h.tick(now);
      if (mode === 'single') {
        const d = rt.getDiagnostics();
        if (d.ok) held[d.diagnostics.stepIndex] = d.diagnostics.worldStream?.suspended?.bodies ?? -1;
      }
      if (h.digests.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const d = rt.getDiagnostics();
    return { sum: ((await h.storage()) as Any).sum ?? null, digests: [...h.digests], held, diag: d.ok ? d.diagnostics.worldStream : null, errors: d.ok ? d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log') : [d] };
  } finally {
    await h.dispose();
  }
}

describe('bodies outside the loaded collision are suspended (3D, page and worker)', () => {
  it('an NPC and a falling rock stand still while their ground is unloaded and resume with their state when it comes back; digests equal', async () => {
    const a = await run('single');
    const b = await run('single');
    const w = await run('worker');
    expect(a.errors).toEqual([]);
    const sum = a.sum as Any;
    const at = (step: number): Any => sum.rows.find((r: Any) => r[0] === step);
    // Before the player leaves: both move, none suspended.
    expect(at(39)[4]).toEqual([false, false, false]);
    expect(at(40)[1]).toBeGreaterThan(at(39)[1]);
    expect(at(40)[3]).toBeLessThan(at(39)[3]);
    // From the boundary after the player left: the NPC and the rock are suspended where they were, the player not.
    expect(at(41)[4]).toEqual([true, true, false]);
    for (const s of [42, 60, 120, 158, 160]) {
      expect(at(s)[1], `walker x at ${s}`).toBe(at(41)[1]);
      expect(at(s)[2], `walker y at ${s}`).toBe(at(41)[2]);
      expect(at(s)[3], `rock y at ${s}`).toBe(at(41)[3]);
      expect(at(s)[4]).toEqual([true, true, false]);
    }
    // Nothing fell through the world.
    expect(sum.lowest).toBeGreaterThan(0.2);
    expect(sum.playerHeld).toBe(0);
    // Back: both resume in the step the floor's collision arrives — the rock with the fall speed it had: its first
    // drop is one step of gravity more than its last drop before (a body starting from rest would drop ~0).
    expect(at(161)[4]).toEqual([false, false, false]);
    const before = at(40)[3] - at(41)[3];
    const after = at(161)[3] - at(162)[3];
    expect(before).toBeGreaterThan(0.03);
    expect(after).toBeCloseTo(before + 19.62 * DT * DT, 6);
    expect(at(162)[1]).toBeGreaterThan(at(161)[1]);
    // The NPC walked to the loaded floor's edge (the next chunk starts at x = 15) and waits there, still on the floor.
    const edge = at(500);
    expect(edge[4][0]).toBe(true);
    expect(edge[1]).toBeGreaterThan(14);
    expect(edge[1]).toBeLessThan(15);
    expect(edge[2]).toBeCloseTo(0.5, 3);
    // The rock landed on the floor (its half height above y = 0).
    expect(edge[3]).toBeCloseTo(0.25, 3);
    // The player comes near: the next chunk loads and the NPC walks on across.
    expect(at(522)[4][0]).toBe(false);
    const last = sum.rows.at(-1);
    expect(last[1]).toBeGreaterThan(16);
    expect(last[2]).toBeCloseTo(0.5, 3);
    // Diagnostics count them (the main thread's runtime): two while the player was away; suspensions and resumes.
    expect(a.held[100]).toBe(2);
    expect(a.held[30]).toBe(0);
    expect(a.diag.suspended.suspensions).toBeGreaterThanOrEqual(3);
    expect(a.diag.suspended.resumes).toBeGreaterThanOrEqual(3);
    // Deterministic: two page runs and the worker, every step.
    const n = Math.min(a.digests.length, b.digests.length, w.digests.length);
    expect(n).toBeGreaterThanOrEqual(STEPS);
    expect(b.digests.slice(0, n)).toEqual(a.digests.slice(0, n));
    expect(w.digests.slice(0, n)).toEqual(a.digests.slice(0, n));
    expect(w.sum).toEqual(a.sum);
  }, 180_000);
});
