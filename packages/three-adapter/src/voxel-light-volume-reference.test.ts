/**
 * The light volume's update against closed forms (the CPU model of its arithmetic and the path-traced reference, both
 * in voxel-light-volume-reference.ts): the sky's light on a face (the π and cosine factors), a white furnace (a closed
 * box of one colour lit by a lamp: what every bounce adds up to), the filter never reading across a 0.5 m wall, the
 * history's weights, and the colours a textured look bounces.
 */
import { describe, expect, it } from 'vitest';
import { LIGHTING_TIER_SETTINGS } from '@thirdlight/project-model';
import { mulberry32 } from '@thirdlight/shared';

import { BOUNCE_ALBEDO, SH_Y0 } from './surface-probes';
import { VolumeColourCache, volumeCellColour, volumeLookBounce } from './voxel-light-volume-colours';
import { VOLUME_LAMP_FLOATS, volumeBlendWeight } from './voxel-light-volume-layout';
import { VolumeUpdateModel, volumePredicateSource, volumeReferenceFace, type VolumeLightWorld } from './voxel-light-volume-reference';
import type { VoxelMaterialLook } from './voxel-surface';

/** Updates a brick is refined to (the low tier's). */
const VOLUME_HISTORY_UPDATES = LIGHTING_TIER_SETTINGS.low.voxelLightVolume.historyUpdates;

/** A sky of uniform radiance `l` (grey) as the pass's SH words. */
function uniformSky(l: number): Float32Array {
  const s = new Float32Array(12);
  for (let k = 0; k < 3; k++) s[k] = l / SH_Y0;
  return s;
}

/** A point lamp's words: at `p`, reach, colour × intensity (grey `i`), decay 2. */
function pointLamp(p: readonly number[], i: number, reach = 200): Float32Array {
  const w = new Float32Array(VOLUME_LAMP_FLOATS);
  w.set([p[0]!, p[1]!, p[2]!, reach, i, i, i, 2]);
  return w;
}

function world(solid: (x: number, y: number, z: number) => boolean, opts: { sky?: number; lamp?: Float32Array; albedo: number }): VolumeLightWorld {
  return {
    src: volumePredicateSource(solid, [-2, -2, -2], [2, 2, 2]),
    sky: uniformSky(opts.sky ?? 0),
    sun: new Float32Array(7),
    lamps: opts.lamp ?? new Float32Array(0),
    lampCount: opts.lamp === undefined ? 0 : 1,
    albedo: () => [opts.albedo, opts.albedo, opts.albedo],
  };
}

const grey = (c: readonly number[] | null | undefined): number => (c === null || c === undefined ? 0 : (c[0]! + c[1]! + c[2]!) / 3);
const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length;

/**
 * The white furnace: a closed box of 10³ open cells (5 m inside) of colour ρ = 0.7 lit by a point lamp of intensity I
 * at its centre. Every bounce lands back on the walls, so the light the walls receive from the room (their indirect
 * light) adds up to ρΦ / (1 − ρ) over the walls' area A, Φ = 4πI: its mean over the wall faces' cells is ρΦ / (A (1 − ρ)).
 */
const BOX = 10;
const RHO = 0.7;
const LAMP_I = 10;
const boxSolid = (x: number, y: number, z: number): boolean => !(x >= 0 && x < BOX && y >= 0 && y < BOX && z >= 0 && z < BOX);
const FURNACE_CLOSED = (RHO * 4 * Math.PI * LAMP_I) / (6 * (BOX * 0.5) ** 2 * (1 - RHO));
const furnace = (): VolumeLightWorld => world(boxSolid, { lamp: pointLamp([BOX * 0.25, BOX * 0.25, BOX * 0.25], LAMP_I), albedo: RHO });

/** The mean light of the wall-facing faces of a model's cells (each face whose back is a wall), red channel. */
function wallLight(m: VolumeUpdateModel): number {
  const out: number[] = [];
  for (const cell of m.cells.values()) for (let f = 0; f < 6; f++) {
    const back = [...cell.c];
    back[f >> 1]! -= (f & 1) === 1 ? -1 : 1;
    if (boxSolid(back[0]!, back[1]!, back[2]!)) out.push(cell.faces[f]?.[0] ?? 0);
  }
  return mean(out);
}

describe('the light volume against closed forms', () => {
  it("the sky's light on a face: π L up over open ground, π ρ L down from a floor of colour ρ (the update and the reference)", () => {
    const L = 0.8;
    const rho = 0.6;
    const w = world((_x, y) => y < 0, { sky: L, albedo: rho });
    // The floor's cells 6 m round the ones read, so the down faces' rays land on cells the model holds.
    const m = new VolumeUpdateModel(w, [-12, 0, -12], [16, 1, 16], { rays: 16, reach: 24, sunReach: 48, filter: false });
    // A floor face's light comes from its first update; the down faces read it from the second on, and the mean of the
    // last quarter of the updates has forgotten the first by the eighth (0.98 of it is left by then).
    for (let i = 0; i < 8; i++) m.step();
    const read = [...m.cells.values()].filter((c) => c.c[0] >= 0 && c.c[0] < 4 && c.c[2] >= 0 && c.c[2] < 4);
    const up = mean(read.map((c) => grey(c.faces[2])));
    const down = mean(read.map((c) => grey(c.faces[3])));
    expect(up / (Math.PI * L)).toBeCloseTo(1, 2);
    expect(down / (Math.PI * rho * L)).toBeGreaterThan(0.97);
    expect(down / (Math.PI * rho * L)).toBeLessThan(1.03);
    const ref = volumeReferenceFace(w, [2, 0, 2], 3, { rays: 4096, bounces: 3 });
    expect(grey(ref) / (Math.PI * rho * L)).toBeGreaterThan(0.97);
    expect(grey(ref) / (Math.PI * rho * L)).toBeLessThan(1.03);
  });

  it('the white furnace: the reference holds every bounce; the update converges to it while refined, the filter on, and loses none to the filter', () => {
    const w = furnace();
    // The reference at six wall cells (one a wall), twelve bounces: the box's walls receive ρΦ / (A (1 − ρ)); the cells
    // sit a quarter metre off the walls (corners and edges nearer the lamp's light bouncing off the next wall), +4 %.
    const cells = [[0, 3, 4, 0], [4, 0, 6, 2], [9, 5, 5, 1], [5, 9, 2, 3], [2, 2, 0, 4], [7, 6, 9, 5]];
    const ref = mean(cells.map(([x, y, z, f]) => volumeReferenceFace(w, [x!, y!, z!], f!, { rays: 2048, bounces: 12 })[0]));
    console.log(`white furnace: closed form ${FURNACE_CLOSED.toFixed(4)}, reference ${(ref / FURNACE_CLOSED).toFixed(3)} of it`);
    expect(ref / FURNACE_CLOSED).toBeGreaterThan(0.98);
    expect(ref / FURNACE_CLOSED).toBeLessThan(1.1);
    const run = (filter: boolean): number[] => {
      const m = new VolumeUpdateModel(w, [0, 0, 0], [BOX, BOX, BOX], { rays: 4, reach: 24, sunReach: 48, filter });
      const at: number[] = [];
      for (let u = 1; u <= VOLUME_HISTORY_UPDATES; u++) {
        m.step();
        if (u === 8 || u === VOLUME_HISTORY_UPDATES) at.push(wallLight(m) / FURNACE_CLOSED);
      }
      return at;
    };
    const plain = run(false);
    const filtered = run(true);
    console.log(`white furnace through the update: after its first settle (8 updates) ${plain[0]!.toFixed(3)} of the closed form, refined to ${VOLUME_HISTORY_UPDATES} ${plain[1]!.toFixed(3)}; with the filter ${filtered[0]!.toFixed(3)} / ${filtered[1]!.toFixed(3)}`);
    // Refined, it holds what every bounce gives (a mean of every estimate held 0.79 here: the estimates made while the
    // bounces were still building stayed in it).
    expect(plain[1]!).toBeGreaterThan(0.95);
    expect(plain[1]!).toBeLessThan(1.06);
    // The filter moves no energy (each neighbour against the face's own light as held).
    expect(Math.abs(filtered[1]! / plain[1]! - 1)).toBeLessThan(0.01);
    expect(Math.abs(filtered[0]! / plain[0]! - 1)).toBeLessThan(0.02);
  });

  it('a room lit through a window by the sky and the sun: refined, the update holds what the reference does at its floor, walls and ceiling', () => {
    // A room 4 × 2.5 × 5 m inside (cells x 0 … 7, y 0 … 4, z 0 … 9), walls and roof a cell thick, a 1 × 1 m window in
    // its west wall (x −1) at z 4 … 5, y 2 … 3; the sun low from the west through it, a sky of radiance 0.8.
    const solid = (x: number, y: number, z: number): boolean => {
      if (y < 0) return true;
      const inside = x >= 0 && x < 8 && y >= 0 && y < 5 && z >= 0 && z < 10;
      const shell = x >= -1 && x < 9 && y >= 0 && y < 6 && z >= -1 && z < 11;
      const window = x === -1 && y >= 2 && y < 4 && z >= 4 && z < 6;
      return shell && !inside && !window;
    };
    const sun = new Float32Array(7);
    const d = [-0.7, 0.5, 0.1];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    sun.set([d[0]! / len, d[1]! / len, d[2]! / len, 1, 3, 3, 3]);
    const w: VolumeLightWorld = { ...world(solid, { sky: 0.8, albedo: 0.6 }), sun };
    const m = new VolumeUpdateModel(w, [0, 0, 0], [8, 5, 10], { rays: 4, reach: 24, sunReach: 48, filter: true });
    for (let u = 0; u < VOLUME_HISTORY_UPDATES; u++) m.step();
    const read = [[2, 0, 2, 2], [5, 0, 7, 2], [6, 0, 4, 2], [7, 2, 5, 1], [3, 2, 9, 5], [4, 4, 5, 3], [1, 4, 2, 3], [0, 1, 8, 0]];
    const gpu = mean(read.map(([x, y, z, f]) => grey(m.held([x!, y!, z!], f!))));
    const ref = mean(read.map(([x, y, z, f]) => grey(volumeReferenceFace(w, [x!, y!, z!], f!, { rays: 2048, bounces: 6, reach: 24, sunReach: 48 }))));
    console.log(`room with a window: the update refined ${gpu.toFixed(4)}, the reference ${ref.toFixed(4)} (${(gpu / ref).toFixed(3)})`);
    expect(gpu / ref).toBeGreaterThan(0.9);
    expect(gpu / ref).toBeLessThan(1.1);
  });

  it('the filter never reads across a 0.5 m wall: a lamp in one room, the room beside it behind one cell of wall stays black', () => {
    // Two closed rooms x 0 … 5 and 7 … 12 (cells), the wall between them one cell thick (x = 6); the lamp in the first.
    const solid = (x: number, y: number, z: number): boolean => y < 0 || y >= 6 || z < 0 || z >= 6 || x < 0 || x >= 13 || x === 6;
    const w = world(solid, { lamp: pointLamp([1.5, 1.5, 1.5], 20), albedo: 0.8 });
    const m = new VolumeUpdateModel(w, [0, 0, 0], [13, 6, 6], { rays: 8, reach: 24, sunReach: 48, filter: true });
    for (let i = 0; i < 12; i++) m.step();
    const lit = [...m.cells.values()].filter((c) => c.c[0] === 5);
    const dark = [...m.cells.values()].filter((c) => c.c[0] >= 7);
    const most = Math.max(...dark.flatMap((c) => c.faces.map(grey)));
    console.log(`wall between: the lit room's cells by the wall ${mean(lit.map((c) => grey(c.faces[1]))).toFixed(4)} (their faces looking at it), the dark room's brightest face ${most}`);
    expect(mean(lit.map((c) => grey(c.faces[1])))).toBeGreaterThan(0.1);
    expect(dark.length).toBeGreaterThan(100);
    expect(most).toBe(0);
  });

  it('the history: a mean of about the last quarter of the updates, never under 1/17 of a new estimate before the cap; noise falls, a change is followed', () => {
    expect(volumeBlendWeight(0)).toBe(1);
    const w = Array.from({ length: VOLUME_HISTORY_UPDATES + 1 }, (_, u) => volumeBlendWeight(u));
    for (let u = 1; u < w.length; u++) expect(w[u]!).toBeLessThanOrEqual(w[u - 1]!);
    expect(w[VOLUME_HISTORY_UPDATES]!).toBeCloseTo(1 / 17, 6);
    // A noisy constant (uniform ±0.5 round 1), many faces: the spread after the refining against after the first settle.
    const rnd = mulberry32(7);
    const spread = (n: number): number => {
      const v: number[] = [];
      for (let f = 0; f < 2000; f++) {
        let x = 0;
        for (let u = 0; u < n; u++) x += (1 + (rnd() - 0.5) - x) * volumeBlendWeight(u);
        v.push(x);
      }
      const m = mean(v);
      return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
    };
    const s8 = spread(8);
    const s64 = spread(VOLUME_HISTORY_UPDATES);
    console.log(`history: a noisy face's spread after 8 updates ${s8.toFixed(4)}, after ${VOLUME_HISTORY_UPDATES} ${s64.toFixed(4)}`);
    expect(s64).toBeLessThan(0.5 * s8);
    // A change from 1 to 2 at the cap's weight (no restart: a slow change between marks) is followed to 90 % in 40 updates.
    let x = 1;
    for (let u = 0; u < 40; u++) x += (2 - x) * volumeBlendWeight(VOLUME_HISTORY_UPDATES);
    expect(x - 1).toBeGreaterThan(0.9);
  });
});

describe('the colours the volume bounces', () => {
  const look = (colour: number): VoxelMaterialLook => ({ colour, pattern: 0 });
  it("a textured look bounces its tint times its texture's mean for the side seen; before the means, white bounces the default grey", () => {
    const plaster = [0.64, 0.58, 0.46];
    const timber = [0.24, 0.12, 0.04];
    expect(volumeLookBounce(look(0xffffff), null, 0)).toEqual([BOUNCE_ALBEDO, BOUNCE_ALBEDO, BOUNCE_ALBEDO]);
    expect(volumeLookBounce(look(0xffffff), [plaster, timber, plaster], 1)).toEqual(timber);
    expect(volumeLookBounce(look(0xffffff), [plaster, null, null], 2)).toEqual(plaster);
    // A tint (sRGB) times the mean (linear): #808080 is 0.2159 linear.
    const tinted = volumeLookBounce(look(0x808080), [plaster, null, null], 0);
    expect(tinted[0]).toBeCloseTo(0.2159 * plaster[0]!, 3);
    // No set: the tint as it was.
    expect(volumeLookBounce(look(0x808080), null, 0)[1]).toBeCloseTo(0.2159, 3);
  });

  it("an open cell's colour: the floor set of the cell under it, the wall set of those beside it", () => {
    // A chunk grid (34³ with its border): material 1 under cell (5, 5, 5), material 2 beside it at x + 1.
    const g = new Uint16Array(34 ** 3);
    const at = (x: number, y: number, z: number): number => ((x + 1) * 34 + (z + 1)) * 34 + (y + 1);
    g[at(5, 4, 5)] = 1;
    g[at(6, 5, 5)] = 2;
    const means = new Map([[1, [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const], [2, [[0.5, 0.5, 0.5], null, null] as const]]);
    const word = volumeCellColour(g, [0, 0, 0], 5, 5, 5, new VolumeColourCache(() => look(0xffffff), means));
    // The floor set of material 1 (green) and the wall set of material 2 (grey), averaged in 8 bits.
    expect([word & 255, (word >>> 8) & 255, (word >>> 16) & 255]).toEqual([64, 192, 64]);
  });
});
