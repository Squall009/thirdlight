/**
 * The many-lamps scene's definition against the town's own cells: the mix at each size, the same places every time and
 * nested sizes, every lamp inside the town and in open air (the cells the far world's town is written from: town.ts's
 * fill, as far-world.ts writes them), every glowing patch over cells it can paint, the room camera's house holding the
 * first room lamp, and the camera's behaviour with the scene's and the day's code in it compiling.
 */
import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import { chunkGrid, createDenseChunk, localIndex, type DenseChunk } from '@thirdlight/voxel';
import { DAY_ARC_DEG, DAY_PRESET_IDS, DAY_SPEEDS, DAY_START_DEG, dayAt, dayBehaviour, sunElevation } from './day-cycle';
import { LIGHTING_PRESETS, lightShotsSource, MANY_LAMP_CAMERAS, ROOM_HOUSE } from './lighting-cameras';
import { MANY_LAMP_KINDS, MANY_LAMPS_EDIT_ROOM, MANY_LAMPS_MIX, MANY_LAMPS_SIZES, manyLampEntities, manyLampsBehaviour, manyLampsCounts, manyLampsScene } from './many-lamps';
import { townWorld } from './town';

const grid = chunkGrid(32);
const town = townWorld({ footprint: 512 }).grids[0]!;
const chunks = new Map<string, DenseChunk | null>();

/** Whether the town's cell holding a world point (metres; the far world's town, its middle at the origin) is not air. */
function solidAt(x: number, y: number, z: number): boolean {
  const c = [Math.floor(x * 2) + 256, Math.floor(y * 2), Math.floor(z * 2) + 256] as const;
  const k = c.map((v) => v >> grid.shift);
  const key = k.join(',');
  let d = chunks.get(key);
  if (d === undefined) {
    const out = createDenseChunk(grid);
    d = town.fill(grid, k[0]!, k[1]!, k[2]!, out) ? out : null;
    chunks.set(key, d);
  }
  if (d === null) return false;
  const i = localIndex(grid, c[0] & (grid.edge - 1), c[1] & (grid.edge - 1), c[2] & (grid.edge - 1));
  return d.material[i] !== 0 && d.shape[i] !== 0;
}

/** Solid cells in a box (metres), cell centres. */
function solidCells(min: readonly number[], max: readonly number[]): number {
  let n = 0;
  for (let x = min[0]! + 0.25; x < max[0]!; x += 0.5) for (let y = min[1]! + 0.25; y < max[1]!; y += 0.5) for (let z = min[2]! + 0.25; z < max[2]!; z += 0.5) if (solidAt(x, y, z)) n++;
  return n;
}

describe('the many-lamps scene', () => {
  it('has the mix of every kind at each size, its lights adding up to the size', () => {
    for (const size of MANY_LAMPS_SIZES) {
      const c = manyLampsCounts(manyLampsScene(size));
      for (const k of MANY_LAMP_KINDS) expect(c[k], `${size} ${k}`).toBe(MANY_LAMPS_MIX[size][k]);
      expect(c.lights).toBe(size);
      // Shadows: every spot and room lamp, every fourth street lamp (rounded up: the first casts).
      expect(c.shadowed).toBe(c.spot + c.room + Math.ceil(c.street / 4));
      expect(c.spot + c.rect + c.line + c.room + c.street).toBeGreaterThan(0);
    }
  });

  it('puts the same lamps in the same places every time, each size holding the smaller', () => {
    expect(JSON.stringify(manyLampsScene(128))).toBe(JSON.stringify(manyLampsScene(128)));
    const [a, b, c] = MANY_LAMPS_SIZES.map((n) => manyLampsScene(n));
    const names = (s: typeof a) => new Map(s!.lamps.map((l) => [l.name, JSON.stringify(l)]));
    for (const [small, large] of [[a!, b!], [b!, c!]] as const) {
      const big = names(large);
      for (const [n, l] of names(small)) expect(big.get(n), n).toBe(l);
      const glow = new Set(large.glow.map((g) => JSON.stringify(g)));
      for (const g of small.glow) expect(glow.has(JSON.stringify(g))).toBe(true);
    }
    expect(new Set(c!.lamps.map((l) => l.name)).size).toBe(c!.lamps.length);
  });

  it('puts every lamp inside the town and in open air, every glowing patch over cells it paints', () => {
    const s = manyLampsScene(512);
    let checked = 0;
    for (const l of s.lamps) {
      const [x, y, z] = l.position;
      expect(Math.abs(x) < 128 && Math.abs(z) < 128 && y > 0 && y < 12, `${l.name} at ${l.position.join(', ')}`).toBe(true);
      // The lamp's point and a 0.2 m box round it are air (a lamp in a wall would light nothing but the wall's inside).
      for (const dx of [-0.2, 0, 0.2]) for (const dy of [-0.2, 0, 0.2]) for (const dz of [-0.2, 0, 0.2]) {
        expect(solidAt(x + dx, y + dy, z + dz), `${l.name} at ${l.position.join(', ')} (+${dx}, ${dy}, ${dz})`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(s.lamps.length * 27);
    for (const g of s.glow) {
      const cells = solidCells(g.min, g.max);
      const all = ((g.max[0] - g.min[0]) * (g.max[1] - g.min[1]) * (g.max[2] - g.min[2])) / 0.125;
      // A strip lies in the ground (every cell solid); a front's panel and corner block on its wall, an opening's cells counted as wall.
      expect(cells, `${g.kind} ${g.min.join(', ')}`).toBe(Math.round(all));
    }
  });

  it("lights the room camera's room with the first room lamp, and places the cameras in open air", () => {
    const s = manyLampsScene(32);
    const lamp = s.lamps.find((l) => l.name === MANY_LAMPS_EDIT_ROOM)!;
    for (let k = 0; k < 3; k++) expect(lamp.position[k]! > ROOM_HOUSE.min[k]! && lamp.position[k]! < ROOM_HOUSE.max[k]!, `${lamp.position.join(', ')}`).toBe(true);
    for (const c of MANY_LAMP_CAMERAS) expect(solidAt(c.eye[0], c.eye[1], c.eye[2]), c.name).toBe(false);
    // The commands the benches send: one object a lamp, its light as defined.
    const e = manyLampEntities(s);
    expect(e.length).toBe(s.lamps.length);
    expect(e[0]!.args['components']).toEqual({ light: { ...s.lamps[0]!.light } });
  });

  it("builds a behaviour that compiles with the scene's and the day's code, and a day that moves and turns back", () => {
    const src = lightShotsSource(undefined, [manyLampsBehaviour(manyLampsScene(128)), dayBehaviour()]);
    expect(() => transformSync(src, { loader: 'ts' })).not.toThrow();
    expect(src).toContain('ml_glow_painted');
    expect(src).toContain('day_u10');
    // The day's presets are among the looks the bench writes, every one with its key light.
    for (const id of DAY_PRESET_IDS) expect(LIGHTING_PRESETS.some((p) => p.presetId === id)).toBe(true);
    expect(sunElevation(0)).toBeCloseTo(50, 0);
    expect(sunElevation(DAY_ARC_DEG)).toBeGreaterThan(10);
    // A 20-minute day moves 0.3° a second; past the arc's end it comes back.
    const a = dayAt(0, DAY_SPEEDS.slow);
    const b = dayAt(100, DAY_SPEEDS.slow);
    expect(a.deg).toBeCloseTo(DAY_START_DEG, 6);
    expect(b.deg - a.deg).toBeCloseTo(30, 6);
    const end = dayAt((2 * DAY_ARC_DEG - (DAY_START_DEG + DAY_ARC_DEG) + 10) / DAY_SPEEDS.fast, DAY_SPEEDS.fast);
    expect(end.deg).toBeCloseTo(DAY_ARC_DEG - 10, 6);
    expect(end.t).toBeGreaterThanOrEqual(0);
    expect(end.t).toBeLessThanOrEqual(1);
  });
});
