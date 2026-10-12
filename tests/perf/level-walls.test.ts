/**
 * The level classes' generated-walls switch without a browser: at 0 the class
 * is the plan it was; above 0 the buildings stand on the area's free ground
 * (clear of the rooms, of each other and of the camera's view ahead), expand
 * with the engine's starters without a problem, and wear the one wall
 * material; the variants the engine can't draw yet are refused rather than
 * built as something else.
 */
import { describe, expect, it } from 'vitest';

import { architectureStylesOf, expandArchitecture, type ArchitectureComponent } from '@thirdlight/project-model';

import { levelPlan, LEVEL_SPEC } from '../../tools/perf/level';
import { NO_LEVEL_MARKS } from '../../tools/perf/level-marks';
import { layeredWallsNotBuilt, NO_LAYERED_WALLS, parseLayeredWalls, wallLayerTextures, WALL_LAYER_SETS, WALL_MATERIAL, WALL_TILING_TEXTURE, type LayeredWallsOptions } from '../../tools/perf/level-walls';

const plan = (walls: LayeredWallsOptions = NO_LAYERED_WALLS, kind: 'area' | 'landscape' = 'area'): ReturnType<typeof levelPlan> => levelPlan(kind, undefined, 0, false, false, 'none', false, 0, false, 0, 0, 'on', false, 0, true, true, false, NO_LEVEL_MARKS, walls);
const flags = (o: Record<string, string>) => (f: string): string | undefined => o[f];
/** A PNG's width and height from its header. */
const pngSize = (b: Buffer): [number, number] => [b.readUInt32BE(16), b.readUInt32BE(20)];

describe('the level walls switch', () => {
  it('reads a whole number of buildings and a layer count of 1, 2 or 4, and refuses anything else', () => {
    expect(parseLayeredWalls(flags({}))).toEqual(NO_LAYERED_WALLS);
    expect(parseLayeredWalls(flags({ 'layered-walls': '24' }))).toEqual({ buildings: 24, layers: 1 });
    expect(parseLayeredWalls(flags({ 'layered-walls': '24', 'wall-layers': '4' }))).toEqual({ buildings: 24, layers: 4 });
    for (const bad of ['-1', '1.5', 'x', '']) expect(() => parseLayeredWalls(flags({ 'layered-walls': bad }))).toThrow(/--layered-walls: a whole number/);
    for (const bad of ['0', '3', 'x']) expect(() => parseLayeredWalls(flags({ 'layered-walls': '4', 'wall-layers': bad }))).toThrow(/--wall-layers: 1, 2, 4/);
    expect(() => parseLayeredWalls(flags({ 'wall-layers': '2' }))).toThrow(/needs --layered-walls/);
  });

  it('at 0 leaves the class as it was: the same entities, edits and counts, nothing to publish', () => {
    const before = levelPlan('area');
    const after = plan();
    expect(after.batches).toEqual(before.batches);
    expect(after.blockEdits).toEqual(before.blockEdits);
    expect(after.counts).toEqual(before.counts);
    expect(after.walls).toBeUndefined();
  });

  it('places the buildings on free ground after the class\'s own entities, the same every time', () => {
    const base = plan();
    const p = plan({ buildings: 24, layers: 1 });
    expect(JSON.stringify(plan({ buildings: 24, layers: 1 }))).toBe(JSON.stringify(p));
    const own = p.batches.map((b) => b.filter((e) => e.id !== 'level-walls')).filter((b) => b.length > 0);
    expect(own).toEqual(base.batches);
    expect(p.blockEdits).toEqual(base.blockEdits);
    const w = p.walls!;
    expect(w.buildings).toHaveLength(24);
    expect(p.counts).toMatchObject({ wallBuildings: 24, wallLayers: 1 });
    expect(p.counts['wallStoreys']).toBe(w.buildings.reduce((n, b) => n + b.storeys, 0));
    const N = LEVEL_SPEC.areaSide;
    const apart = (a: readonly number[], b: readonly number[], m: number): boolean => a[2]! + m <= b[0]! || b[2]! + m <= a[0]! || a[3]! + m <= b[1]! || b[3]! + m <= a[1]!;
    for (const [i, b] of w.buildings.entries()) {
      expect(b.box[0]).toBeGreaterThanOrEqual(2);
      expect(b.box[2]).toBeLessThanOrEqual(N - 2);
      expect(b.box[1]).toBeGreaterThanOrEqual(2);
      expect(b.box[3]).toBeLessThanOrEqual(N - 2);
      for (const r of p.rooms) expect(apart(b.box, r.box, 2)).toBe(true);
      for (const o of w.buildings.slice(i + 1)) expect(apart(b.box, o.box, 2)).toBe(true);
      // The camera stands at the south edge's middle: the ground just ahead of it stays open.
      expect(apart(b.box, [N / 2 - 10, N - 16, N / 2 + 10, N], 0)).toBe(true);
    }
    // Some of them in both halves of the view, near and far.
    expect(w.buildings.some((b) => b.box[3] > N / 2)).toBe(true);
    expect(w.buildings.some((b) => b.box[1] < N / 2)).toBe(true);
  });

  it('makes one static architecture object of closed outlines that expands with the engine\'s starters, every opening cut', () => {
    const p = plan({ buildings: 24, layers: 1 });
    const e = p.batches.flat().find((x) => x.id === 'level-walls')!;
    expect(e.static).toBe(true);
    expect(e.components['materials']).toEqual({ '*': WALL_MATERIAL });
    const arch = e.components['architecture'] as ArchitectureComponent;
    const origin = (e.components['transform'] as { position: number[] }).position;
    for (const b of arch.buildings!) {
      const pts = b.path.points;
      expect(b.path.closed).toBe(true);
      // Clockwise seen from above (x right, z down the page): the inside is to the right of travel.
      const area = pts.reduce((s, [x, , z], i) => s + x * pts[(i + 1) % pts.length]![2] - pts[(i + 1) % pts.length]![0] * z, 0);
      expect(area).toBeGreaterThan(0);
    }
    const ex = expandArchitecture(arch, origin, architectureStylesOf([]));
    expect(ex.problems).toEqual([]);
    const walls = ex.component.elements.filter((x) => x.kind === 'sweep' && x.wall === true);
    expect(walls.length).toBeGreaterThan(0);
    const listed = arch.buildings!.reduce((n, b) => n + (b.openings?.length ?? 0), 0);
    const cut = walls.reduce((n, x) => n + ((x as { openings?: unknown[] }).openings?.length ?? 0), 0);
    expect(cut).toBeGreaterThanOrEqual(listed);
  });

  it('says when the area is full rather than placing fewer', () => {
    expect(() => plan({ buildings: 400, layers: 1 })).toThrow(/free ground holds \d+ buildings, not 400/);
  });

  it('builds one trim layer today and refuses the blends that wait for the layered surface material', () => {
    expect(layeredWallsNotBuilt(NO_LAYERED_WALLS)).toBeNull();
    expect(layeredWallsNotBuilt({ buildings: 24, layers: 1 })).toBeNull();
    expect(layeredWallsNotBuilt({ buildings: 24, layers: 2 })).toMatch(/layered surface material/);
    expect(layeredWallsNotBuilt({ buildings: 24, layers: 4 })).toMatch(/layered surface material/);
    // Every variant starts from the same base sheet; four adds two tiling layers and wetness.
    expect(WALL_LAYER_SETS[1].layers.map((l) => l.kind)).toEqual(['trim']);
    expect(WALL_LAYER_SETS[2].layers.map((l) => l.kind)).toEqual(['trim', 'trim']);
    expect(WALL_LAYER_SETS[4].layers.map((l) => l.kind)).toEqual(['trim', 'trim', 'tiling', 'tiling']);
    expect(WALL_LAYER_SETS[4].wetness).toBe(true);
    for (const n of [2, 4] as const) expect(WALL_LAYER_SETS[n].layers[0]).toEqual(WALL_LAYER_SETS[1].layers[0]);
  });

  it('makes a layer\'s textures at its size, the same every time, different per layer', () => {
    const moss = WALL_LAYER_SETS[4].layers[2]!;
    const rust = WALL_LAYER_SETS[4].layers[3]!;
    const a = wallLayerTextures(moss, 30);
    expect(a.size).toBe(WALL_TILING_TEXTURE);
    for (const t of [a.albedo, a.normal, a.orm]) expect(pngSize(t)).toEqual([WALL_TILING_TEXTURE, WALL_TILING_TEXTURE]);
    expect(wallLayerTextures(moss, 30).albedo.equals(a.albedo)).toBe(true);
    expect(wallLayerTextures(rust, 30).albedo.equals(a.albedo)).toBe(false);
    const sheet = wallLayerTextures(WALL_LAYER_SETS[1].layers[0]!, 30);
    expect(pngSize(sheet.albedo)).toEqual([1024, 1024]);
  });
});
