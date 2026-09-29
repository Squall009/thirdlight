/**
 * Sloped block-layer terrain in the running game, through the production
 * game host (the 3D character controller and Rapier), on the main thread and
 * in the simulation worker, driven by recorded input.
 *
 * A block layer holds two lanes rising along +x from a flat floor: a gentle
 * one (0.375 cells per 1 m column, 20.6°) and a steep one (0.84375, 40.2°),
 * each a smooth surface of sloped cells crossing row boundaries. The
 * character (its own slope limit: the project's 45°) walks +x:
 * - up the gentle lane, with the layer's maxSlope at 30°;
 * - not up the steep lane with maxSlope 30° (it stops at the foot);
 * - up the steep lane without maxSlope (40° is under its own 45°).
 * Page and worker agree step by step, and a script's `ctx.grid.surface`
 * under the character matches where it stands.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';

import { behaviorModule } from '../m22-worker/harness';
import { holdMove, runScene, sceneOf, T, type Any } from '../m23-3d/character-kit';

const TYPES = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];
const types = new Map(TYPES.map((t) => [t.blockId, t as Any]));
const LAYER = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [24, 16, 16] } };
/** The layer's min corner: its first row's top is at y = 1 (the kit's floor box is under it at y = 0). */
const ORIGIN = [-4, 0, -8];
const SLOPE_FROM = 6;
const GENTLE = 0.375;
const STEEP = 0.84375;

/** A lane of columns z0..z1 rising `rise` cells per column from column SLOPE_FROM, ten columns long, then flat. */
function lane(g: BlockGrid, z0: number, z1: number, rise: number): void {
  const edits: Any[] = [];
  for (let x = 0; x < 20; x++) {
    const h = (i: number): number => 1 + Math.min(10, Math.max(0, i - SLOPE_FROM)) * rise;
    const h0 = h(x);
    const h1 = h(x + 1);
    const lo = Math.min(h0, h1);
    const top = h0 === h1 && Number.isInteger(h0) ? h0 - 1 : Math.floor(lo);
    if (top > 0) edits.push({ kind: 'fill', box: [x, 0, z0, x + 1, top, z1], cell: { block: 'soil' } });
    const c = [h0 - top, h1 - top, h1 - top, h0 - top];
    edits.push({ kind: 'fill', box: [x, top, z0, x + 1, top + 1, z1], cell: { block: 'soil', ...(c.every((v) => v === 1) ? {} : { corners: c }) } });
  }
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(r.message);
}

/** Logs the character's position and the surface under it every 10 steps. */
const PROBE = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent' || ctx.stepIndex % 10 !== 0) return;
    const p = ctx.world.transform('player-0001').position;
    const s = ctx.grid.surface('terrain-0001', [p[0], p[1], p[2]]);
    const log = ctx.save.get('log' + Math.floor(ctx.stepIndex / 200)) ?? [];
    log.push([ctx.stepIndex, p[0], p[1], s === null ? null : s.height, s === null ? null : s.slope, s === null ? null : s.walkable]);
    ctx.save.set('log' + Math.floor(ctx.stepIndex / 200), log);
  },
};
`;

function scene(maxSlope: number | undefined, laneZ: number): Any {
  const g = new BlockGrid(LAYER as Any);
  lane(g, 2, 6, GENTLE);
  lane(g, 10, 14, STEEP);
  const data = g.toData('terrain-0001', null, g.takeDirty().chunks)!;
  const terrain = { id: 'terrain-0001', components: { transform: T(ORIGIN), blockLayer: { ...LAYER, ...(maxSlope !== undefined ? { maxSlope } : {}) } } };
  const probe = { id: 'probe-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'probe', values: {} } } };
  // The character starts over the lane's flat floor (world x 0 = layer column 4), standing on it.
  const out = sceneOf({}, [0, 1 + 0.91, ORIGIN[2] + laneZ], [terrain, probe], `slopes${maxSlope ?? 'none'}${laneZ}`);
  // The cells are scene data; the block types content.
  out.snapshot = { ...out.snapshot, scene: { ...out.snapshot.scene, blocks: [data] }, blockTypes: TYPES };
  return out;
}

const STEPS = 3 * 120;
const walk = (mode: 'single' | 'worker', maxSlope: number | undefined, laneZ: number) =>
  runScene(mode, scene(maxSlope, laneZ), holdMove(STEPS, 1, 0), STEPS, { storage: true, behaviors: [behaviorModule('probe', PROBE)] });

/** The layer's surface height at world x (the lanes' analytic shape). */
const heightAt = (x: number, rise: number): number => 1 + Math.min(10, Math.max(0, x - ORIGIN[0] - SLOPE_FROM)) * rise;

describe('sloped block terrain with a maxSlope', () => {
  it('the character walks up 20.6° with maxSlope 30, not 40.2°; without maxSlope it climbs 40.2° (page and worker agree)', async () => {
    const gentle = await walk('single', 30, 4);
    const steepLimited = await walk('single', 30, 12);
    const steepLimitedWorker = await walk('worker', 30, 12);
    const steepFree = await walk('single', undefined, 12);
    for (const r of [gentle, steepLimited, steepLimitedWorker, steepFree]) expect(r.errors).toEqual([]);
    const [gx, gy] = gentle.player.position as [number, number];
    // Up the gentle lane: well past the foot (world x 2) and standing on the slope (its origin 0.9 m over it).
    expect(gx).toBeGreaterThan(5);
    expect(gy).toBeGreaterThan(heightAt(gx, GENTLE) + 0.85);
    expect(gy).toBeLessThan(heightAt(gx, GENTLE) + 1.0);
    // Limited: stopped at the foot of the steep lane, still on the floor.
    const [sx, sy] = steepLimited.player.position as [number, number];
    expect(sx).toBeLessThan(2.1);
    expect(sy).toBeLessThan(1 + 0.91 + 0.2);
    expect(steepLimitedWorker.digests).toEqual(steepLimited.digests);
    // Without the layer's limit the character's own 45° applies: up the steep lane.
    const [fx, fy] = steepFree.player.position as [number, number];
    expect(fx).toBeGreaterThan(3);
    expect(fy).toBeGreaterThan(heightAt(fx, STEEP) + 0.8);
  });

  it('ctx.grid.surface under the character: the lane height where it stands, the slope angle, walkable by the layer maxSlope', async () => {
    const r = await walk('single', 30, 4);
    const saved = await r.h.storage();
    const values = Array.from({ length: 4 }, (_, i) => (saved[`log${i}`] ?? []) as Any[]).flat();
    expect(values.length).toBeGreaterThan(20);
    for (const [, x, , height, slope, walkable] of values as [number, number, number, number | null, number | null, boolean | null][]) {
      expect(height).toBeCloseTo(heightAt(x, GENTLE), 6);
      const onSlope = x - ORIGIN[0] > SLOPE_FROM + 0.01 && x - ORIGIN[0] < SLOPE_FROM + 10 - 0.01;
      if (onSlope) expect(slope).toBeCloseTo((Math.atan(GENTLE) * 180) / Math.PI, 6);
      expect(walkable).toBe(true);
    }
  });
});
