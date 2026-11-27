/**
 * The dressing rules on made worlds: each of the research's examples is a
 * small world of real cells whose surfaces are read by the surface fields'
 * kernel, then asked of the evaluator: where the species grows, at what
 * share, and which condition says no where it does not.
 */
import { describe, expect, it } from 'vitest';
import { DRESSING_CLEAR_UNDER_M, DRESSING_CONDITIONS, DRESSING_ROLE_NAMES, clearedByProp, dressingConditionAt, dressingNoise, dressingRule, dressingShare, dressingWhyNot, propClearances, type DressingConditions, type DressingWhyNot } from './dressing-rules';
import type { PropShape } from './prop-coverage';
import { recordValue, SHAPE_FULL, VOXEL_ROLE } from './record';
import { SURFACE_DISTANCE_CAP_M, SURFACE_NO_ROW, surfaceFieldsOf, surfacePointOut, surfaceRows, surfaceTable, surfaceTop, type SurfaceCells, type SurfacePoint, type SurfaceTable } from './surface-fields';

const R = VOXEL_ROLE;
const GRASS = 3;
const PATH = 4;
const STONE = 5;
const WOOD = 7;
const WATER = 20;
const M = 0.5;

/** A made world: a box of cells with its lowest cell at the grid's origin. */
class World {
  readonly values: Uint32Array;
  built: Uint8Array | null = null;
  private made: SurfaceTable | null = null;
  constructor(readonly sx: number, readonly sy: number, readonly sz: number) {
    this.values = new Uint32Array(sx * sy * sz);
  }
  set(x: number, y: number, z: number, v: number): this {
    this.values[(x * this.sz + z) * this.sy + y] = v;
    this.made = null;
    return this;
  }
  /** Ground from the floor up to `height` cells (a fraction: the top cell's fill). */
  column(x: number, z: number, height: number, material = GRASS, wetness = 0): this {
    const whole = Math.floor(height + 1e-9);
    for (let y = 0; y < whole; y++) this.set(x, y, z, recordValue(material, R.terrain, SHAPE_FULL, wetness));
    const part = Math.round((height - whole) * SHAPE_FULL);
    if (part > 0) this.set(x, whole, z, recordValue(material, R.terrain, part, wetness));
    return this;
  }
  flat(height: number, material = GRASS, wetness = 0): this {
    for (let x = 0; x < this.sx; x++) for (let z = 0; z < this.sz; z++) this.column(x, z, height, material, wetness);
    return this;
  }
  stamp(x: number, y: number, z: number): this {
    (this.built ??= new Uint8Array(this.values.length))[(x * this.sz + z) * this.sy + y] = 1;
    this.made = null;
    return this;
  }
  cells(): SurfaceCells {
    return { sx: this.sx, sy: this.sy, sz: this.sz, ox: 0, oy: 0, oz: 0, cellM: M, values: this.values, built: this.built };
  }
  table(): SurfaceTable {
    return (this.made ??= surfaceTable(this.cells()));
  }
  rows(x: number, z: number): number[] {
    return [...surfaceRows(this.table(), x, z)];
  }
  /** The fields of column (x, z)'s surface at `row` (its highest by default), read with their distances. */
  at(x: number, z: number, row = surfaceTop(this.table(), x, z)): SurfacePoint {
    if (row === SURFACE_NO_ROW) throw new Error(`no surface at ${x}, ${z}`);
    return surfaceFieldsOf(this.table(), x, z, row, true, surfacePointOut());
  }
}

/** The middle of column (x, z) in metres. */
const mid = (c: number): number => (c + 0.5) * M;

/** A species' answer at a column's surface: its share and why not. */
function ask(w: World, c: DressingConditions, x: number, z: number, row?: number, clear?: Float32Array): { share: number; why: DressingWhyNot | null } {
  const r = dressingRule(c);
  const p = w.at(x, z, row);
  return { share: dressingShare(r, p, mid(x), mid(z)), why: dressingWhyNot(r, p, mid(x), mid(z), clear) };
}

const YES = { share: 1, why: null };
const no = (why: DressingWhyNot): { share: number; why: DressingWhyNot } => ({ share: 0, why });

describe('dressing rules: the research examples, each on a made world', () => {
  it('grass grows on grass ground under open sky, and nowhere else: not on the path, not under a roof, not under water', () => {
    const GRASS_RULE: DressingConditions = { material: [GRASS], sky: true, waterDepth: { max: 0 } };
    const w = new World(24, 16, 24).flat(4);
    // A path two columns wide.
    for (let z = 0; z < 24; z++) for (const x of [10, 11]) w.column(x, z, 4, PATH);
    // A roof slab over a corner, four cells up.
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) w.set(x, 8, z, recordValue(WOOD, R.roof, SHAPE_FULL, 0));
    // A pool dug two cells deep and filled.
    for (let x = 18; x < 22; x++) for (let z = 18; z < 22; z++) {
      w.set(x, 3, z, recordValue(WATER, R.liquid, SHAPE_FULL, 0));
      w.set(x, 2, z, recordValue(WATER, R.liquid, SHAPE_FULL, 0));
    }
    expect(ask(w, GRASS_RULE, 6, 12)).toEqual(YES);
    expect(ask(w, GRASS_RULE, 10, 12)).toEqual(no('material'));
    expect(ask(w, GRASS_RULE, 1, 1, 3)).toEqual(no('sky'));
    expect(ask(w, GRASS_RULE, 19, 19)).toEqual(no('waterDepth'));
    // The roof's own top is a surface under the sky, of another material.
    expect(ask(w, GRASS_RULE, 1, 1)).toEqual(no('material'));
    // Without the material condition the grass would take the path too: the condition is what keeps it off.
    expect(ask(w, { sky: true }, 10, 12)).toEqual(YES);
  });

  it('reeds grow only in the shallows: a depth range, dry ground and deep water both out', () => {
    const REEDS: DressingConditions = { waterDepth: { min: 0.1, max: 0.6 } };
    // A bed falling a cell every two columns along x, water to row 6's top.
    const w = new World(20, 12, 6);
    for (let x = 0; x < 20; x++) for (let z = 0; z < 6; z++) {
      const h = 8 - Math.floor(x / 2);
      w.column(x, z, h);
      for (let y = h; y < 7; y++) w.set(x, y, z, recordValue(WATER, R.liquid, SHAPE_FULL, 0));
    }
    const depth = (x: number): number => w.at(x, 3).waterDepth;
    expect(depth(0)).toBe(0);
    expect(depth(4)).toBeCloseTo(0.5, 6);
    expect(depth(10)).toBeCloseTo(2, 6);
    expect(ask(w, REEDS, 0, 3)).toEqual(no('waterDepth'));
    expect(ask(w, REEDS, 4, 3)).toEqual(YES);
    expect(ask(w, REEDS, 10, 3)).toEqual(no('waterDepth'));
    // A soft outer edge: a metre deep with a metre of fade keeps a share between none and all.
    const soft = ask(w, { waterDepth: { min: 0.1, max: 0.6, fade: 1 } }, 6, 3);
    expect(depth(6)).toBeCloseTo(1, 6);
    expect(soft.why).toBeNull();
    expect(soft.share).toBeGreaterThan(0.2);
    expect(soft.share).toBeLessThan(0.8);
  });

  it('moss grows in caves: no sky and wet ground; the meadow over the cave and a dry cave grow none', () => {
    const MOSS: DressingConditions = { sky: false, wetness: { min: 2 } };
    // A hill of stone with a cave through it: wet floor in one half, dry in the other.
    const w = new World(16, 16, 16).flat(12, STONE);
    for (let x = 2; x < 14; x++) for (let z = 6; z < 10; z++) {
      for (let y = 4; y < 8; y++) w.set(x, y, z, 0);
      w.set(x, 3, z, recordValue(STONE, R.terrain, SHAPE_FULL, x < 8 ? 4 : 0));
    }
    expect(w.rows(4, 7)).toEqual([3, 11]);
    expect(ask(w, MOSS, 4, 7, 3)).toEqual(YES);
    expect(ask(w, MOSS, 10, 7, 3)).toEqual(no('wetness'));
    // The same column's top: the meadow over the cave.
    expect(ask(w, MOSS, 4, 7, 11)).toEqual(no('sky'));
  });

  it('flowers grow at a verge: within a bound of another material\'s edge, not out in the meadow', () => {
    const FLOWERS: DressingConditions = { material: [GRASS], materialEdge: { max: 1.5 } };
    const w = new World(40, 8, 12).flat(4);
    for (let z = 0; z < 12; z++) for (const x of [0, 1]) w.column(x, z, 4, PATH);
    // Column 2 is half a metre from the path's nearest column, column 4 a metre and a half, column 30 past the search.
    expect(w.at(2, 6).materialEdge).toBeCloseTo(0.5, 6);
    expect(w.at(4, 6).materialEdge).toBeCloseTo(1.5, 6);
    expect(w.at(30, 6).materialEdge).toBe(SURFACE_DISTANCE_CAP_M);
    expect(ask(w, FLOWERS, 2, 6)).toEqual(YES);
    expect(ask(w, FLOWERS, 4, 6)).toEqual(YES);
    expect(ask(w, FLOWERS, 5, 6)).toEqual(no('materialEdge'));
    expect(ask(w, FLOWERS, 30, 6)).toEqual(no('materialEdge'));
    // The path itself is at its own edge and is kept off by the material.
    expect(ask(w, FLOWERS, 1, 6)).toEqual(no('material'));
    // The other way round, "nothing beside a road": a floor on the distance.
    expect(ask(w, { material: [GRASS], materialEdge: { min: 2 } }, 2, 6)).toEqual(no('materialEdge'));
    expect(ask(w, { material: [GRASS], materialEdge: { min: 2 } }, 30, 6)).toEqual(YES);
  });

  it('a fringe grows where a wall meets the ground: within a bound of construction, on either side of it', () => {
    const FRINGE: DressingConditions = { role: ['terrain'], construction: { max: 1 } };
    const w = new World(40, 12, 12).flat(4);
    // A wall along z at x = 20, four cells high, standing on the ground.
    for (let z = 0; z < 12; z++) for (let y = 4; y < 8; y++) w.set(20, y, z, recordValue(STONE, R.wall, SHAPE_FULL, 0));
    expect(w.at(19, 6).construction).toBeCloseTo(0.5, 6);
    expect(ask(w, FRINGE, 19, 6)).toEqual(YES);
    expect(ask(w, FRINGE, 21, 6)).toEqual(YES);
    expect(ask(w, FRINGE, 18, 6)).toEqual(YES);
    expect(ask(w, FRINGE, 17, 6)).toEqual(no('construction'));
    expect(ask(w, FRINGE, 2, 6)).toEqual(no('construction'));
    // The wall's top is a surface 0 m from construction: the role keeps the fringe off it.
    expect(ask(w, FRINGE, 20, 6)).toEqual(no('role'));
  });

  it('nothing grows under a foundation or inside a building\'s footprint: the ground there is no surface, and what is a surface is not ground', () => {
    const GRASS_RULE: DressingConditions = { role: ['terrain'], sky: true };
    const w = new World(24, 16, 24).flat(4);
    // A foundation slab on the ground (blocks in the world's own cells).
    for (let x = 4; x < 10; x++) for (let z = 4; z < 10; z++) w.set(x, 4, z, recordValue(STONE, R.foundation, SHAPE_FULL, 0));
    // A structure standing on the ground elsewhere: its stamp closes the cells over its footprint.
    for (let x = 14; x < 20; x++) for (let z = 14; z < 20; z++) for (let y = 4; y < 10; y++) w.stamp(x, y, z);
    // Under the slab the ground is not a surface; the slab's top is one, a foundation.
    expect(w.rows(6, 6)).toEqual([4]);
    expect(ask(w, GRASS_RULE, 6, 6)).toEqual(no('role'));
    // Inside the stamped footprint no column has a surface at all, so no species is ever asked.
    for (let x = 14; x < 20; x++) for (let z = 14; z < 20; z++) expect(w.rows(x, z)).toEqual([]);
    // Open ground beside both still grows.
    expect(ask(w, GRASS_RULE, 11, 6)).toEqual(YES);
    expect(ask(w, GRASS_RULE, 12, 16)).toEqual(YES);
    // Every surface over the two footprints, asked: none grows.
    let grew = 0;
    for (const [x0, z0] of [[4, 4], [14, 14]] as const) for (let x = x0; x < x0 + 6; x++) for (let z = z0; z < z0 + 6; z++) for (const row of w.rows(x, z)) if (ask(w, GRASS_RULE, x, z, row).share > 0) grew++;
    expect(grew).toBe(0);
    // And "keep a metre off anything built" is the distance, measured through the stamp too.
    expect(ask(w, { role: ['terrain'], construction: { min: 1.5 } }, 13, 16)).toEqual(no('construction'));
    expect(ask(w, { role: ['terrain'], construction: { min: 1.5 } }, 1, 20)).toEqual(YES);
  });

  it('rule plants keep clear of a hand-placed prop: inside its box across the ground, from a little under its foot to its top', () => {
    const w = new World(24, 24, 24).flat(4);
    // An upper storey: a floor slab six cells over the ground.
    for (let x = 0; x < 24; x++) for (let z = 0; z < 12; z++) w.set(x, 10, z, recordValue(WOOD, R.floor, SHAPE_FULL, 0));
    // A crate a metre wide standing on the ground at (6 m, 2 m, 9 m), turned 30 degrees; a chest on the storey above.
    const crate: PropShape = { inside: () => true, min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5], position: [6, 2, 9], yaw: [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], scale: 1 };
    const chest: PropShape = { inside: () => true, min: [-0.5, 0, -0.5], max: [0.5, 0.8, 0.5], position: [3, 5.5, 3], yaw: [1, 0], scale: 1 };
    const clear = propClearances([crate, chest]);
    expect(clear.length).toBe(12);
    const ANY: DressingConditions = {};
    // Column 12 is at 6.25 m: under the crate. Ten columns on it is open.
    expect(ask(w, ANY, 12, 18, undefined, clear)).toEqual({ share: 1, why: 'prop' });
    expect(ask(w, ANY, 22, 18, undefined, clear)).toEqual(YES);
    // The turned crate's box is wider than the crate: 0.68 m to each side.
    expect(clearedByProp(clear, 6 + 0.65, 2, 9)).toBe(true);
    expect(clearedByProp(clear, 6 + 0.75, 2, 9)).toBe(false);
    // Under the chest on the storey: the storey's floor is cleared, the ground floor under it is not.
    expect(ask(w, ANY, 6, 6, 10, clear).why).toBe('prop');
    expect(ask(w, ANY, 6, 6, 3, clear).why).toBeNull();
    // A prop sunk a little into the ground still clears it; one hanging well over it does not.
    expect(clearedByProp(clear, 6, 2 - DRESSING_CLEAR_UNDER_M, 9)).toBe(true);
    expect(clearedByProp(clear, 6, 2 - DRESSING_CLEAR_UNDER_M - 0.1, 9)).toBe(false);
    expect(clearedByProp(clear, 6, 3.01, 9)).toBe(false);
    // A failed condition is named before the prop.
    expect(ask(w, { sky: false }, 12, 18, undefined, clear).why).toBe('sky');
    expect(clearedByProp(undefined, 6, 2, 9)).toBe(false);
  });

  it('a slope limit: flat ground grows, a 45 degree bank does not, and a fade thins the steps between', () => {
    const w = new World(40, 40, 6);
    // Flat, then rising a third of a cell a column (about 18 degrees), then a cell a column (45 degrees).
    for (let x = 0; x < 40; x++) for (let z = 0; z < 6; z++) w.column(x, z, x < 10 ? 4 : x < 22 ? 4 + (x - 10) / 3 : 8 + (x - 22));
    expect(w.at(5, 3).slope).toBeCloseTo(0, 6);
    expect(w.at(15, 3).slope).toBeCloseTo((Math.atan(1 / 3) * 180) / Math.PI, 3);
    expect(w.at(30, 3).slope).toBeCloseTo(45, 3);
    const LIMIT: DressingConditions = { slope: { max: 30 } };
    expect(ask(w, LIMIT, 5, 3)).toEqual(YES);
    expect(ask(w, LIMIT, 15, 3)).toEqual(YES);
    expect(ask(w, LIMIT, 30, 3)).toEqual(no('slope'));
    // A scree species the other way round.
    expect(ask(w, { slope: { min: 35 } }, 30, 3)).toEqual(YES);
    expect(ask(w, { slope: { min: 35 } }, 5, 3)).toEqual(no('slope'));
    // With a fade of 20 degrees past a limit of 10, the gentler bank keeps part of the density.
    const soft = ask(w, { slope: { max: 10, fade: 20 } }, 15, 3);
    expect(soft.why).toBeNull();
    expect(soft.share).toBeGreaterThan(0.5);
    expect(soft.share).toBeLessThan(1);
  });

  it('a height band and wetness are ranges too, and the conditions multiply', () => {
    const w = new World(8, 24, 8).flat(4);
    w.column(2, 2, 16);
    w.column(5, 5, 4, GRASS, 6);
    expect(ask(w, { height: { min: 5 } }, 2, 2)).toEqual(YES);
    expect(ask(w, { height: { min: 5 } }, 6, 6)).toEqual(no('height'));
    expect(ask(w, { wetness: { min: 5 } }, 5, 5)).toEqual(YES);
    expect(ask(w, { wetness: { max: 1 } }, 5, 5)).toEqual(no('wetness'));
    // Two soft conditions: the share is their product.
    const r = dressingRule({ height: { min: 3, fade: 2 }, wetness: { min: 7, fade: 2 } });
    const p = w.at(5, 5);
    const h = dressingConditionAt(r, 'height', p, 0, 0);
    const wet = dressingConditionAt(r, 'wetness', p, 0, 0);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(1);
    expect(wet).toBeGreaterThan(0);
    expect(wet).toBeLessThan(1);
    expect(dressingShare(r, p, 0, 0)).toBeCloseTo(h * wet, 12);
  });

  it('noise makes patches with their own scale and seed: coherent at the scale, different on another seed, the same every time', () => {
    const w = new World(4, 8, 4).flat(4);
    const p = w.at(1, 1);
    const grows = (c: DressingConditions, x: number, z: number): boolean => dressingShare(dressingRule(c), p, x, z) > 0;
    const PATCHES: DressingConditions = { noise: { min: 0.5, scale: 8, seed: 3 } };
    // A 96 m square at half-metre steps.
    const N = 192;
    const field = (c: DressingConditions): Uint8Array => {
      const out = new Uint8Array(N * N);
      for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) out[i * N + k] = grows(c, (i + 0.5) * M, (k + 0.5) * M) ? 1 : 0;
      return out;
    };
    const a = field(PATCHES);
    const share = a.reduce((s, v) => s + v, 0) / a.length;
    // About half the ground, in patches: a point and the one a metre on mostly agree.
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.7);
    const agree = (f: Uint8Array, step: number): number => {
      let same = 0;
      let n = 0;
      for (let i = 0; i + step < N; i++) for (let k = 0; k < N; k++) {
        n++;
        if (f[i * N + k] === f[(i + step) * N + k]) same++;
      }
      return same / n;
    };
    expect(agree(a, 2)).toBeGreaterThan(0.9);
    // The same ground on another seed: other patches (it agrees no better than chance allows).
    const b = field({ noise: { min: 0.5, scale: 8, seed: 4 } });
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same / a.length).toBeLessThan(0.7);
    expect(same / a.length).toBeGreaterThan(0.3);
    // A scale of half a metre is speckle: neighbours a metre apart agree far less than the 8 m patches do.
    const fine = field({ noise: { min: 0.5, scale: 0.5, seed: 3 } });
    expect(agree(fine, 2)).toBeLessThan(0.7);
    // Deterministic, and named when it says no.
    expect(field(PATCHES)).toEqual(a);
    const off = a.indexOf(0);
    const [ox, oz] = [(Math.floor(off / N) + 0.5) * M, ((off % N) + 0.5) * M];
    expect(dressingWhyNot(dressingRule(PATCHES), p, ox, oz)).toBe('noise');
    expect(dressingNoise({ scale: 8, seed: 3 }, ox, oz)).toBeLessThan(0.5);
    // The noise is flat: sculpting a patch's ground does not move it.
    w.column(1, 1, 6);
    expect(dressingShare(dressingRule(PATCHES), w.at(1, 1), ox, oz)).toBe(0);
  });
});

describe('dressing rules: the conditions as a vocabulary', () => {
  it('names exactly the ten conditions, and the roles a surface can have', () => {
    expect([...DRESSING_CONDITIONS]).toEqual(['material', 'role', 'slope', 'height', 'sky', 'wetness', 'waterDepth', 'materialEdge', 'construction', 'noise']);
    expect([...DRESSING_ROLE_NAMES]).toEqual(['terrain', 'wall', 'floor', 'roof', 'foundation', 'stair', 'pillar']);
  });

  it('no conditions grow everywhere at full density; each condition alone can say no and is the one named', () => {
    const w = new World(40, 12, 8).flat(4);
    for (let z = 0; z < 8; z++) w.column(39, z, 4, PATH);
    const p = w.at(3, 3);
    expect(dressingShare(dressingRule(undefined), p, 1, 1)).toBe(1);
    expect(dressingWhyNot(dressingRule({}), p, 1, 1)).toBeNull();
    const failing: Record<(typeof DRESSING_CONDITIONS)[number], DressingConditions> = {
      material: { material: [PATH] },
      role: { role: ['roof'] },
      slope: { slope: { min: 10 } },
      height: { height: { max: 1 } },
      sky: { sky: false },
      wetness: { wetness: { min: 1 } },
      waterDepth: { waterDepth: { min: 0.1 } },
      materialEdge: { materialEdge: { max: 2 } },
      construction: { construction: { max: 2 } },
      noise: { noise: { min: 2, scale: 4 } },
    };
    for (const name of DRESSING_CONDITIONS) {
      const r = dressingRule(failing[name]);
      expect(dressingShare(r, p, 1, 1), name).toBe(0);
      expect(dressingWhyNot(r, p, 1, 1), name).toBe(name);
      // Every other condition of that rule reads 1: only the one named failed.
      for (const other of DRESSING_CONDITIONS) expect(dressingConditionAt(r, other, p, 1, 1), `${name}/${other}`).toBe(other === name ? 0 : 1);
    }
    // Two failing: the first in the vocabulary's order is the one named.
    expect(dressingWhyNot(dressingRule({ sky: false, material: [PATH] }), p, 1, 1)).toBe('material');
  });

  it('says which rules read the two distances, and refuses to judge them from fields read without', () => {
    expect(dressingRule({ slope: { max: 20 } }).distances).toBe(false);
    expect(dressingRule({ materialEdge: { max: 2 } }).distances).toBe(true);
    expect(dressingRule({ construction: { min: 1 } }).distances).toBe(true);
    const w = new World(8, 8, 8).flat(4);
    const bare = surfaceFieldsOf(w.table(), 3, 3, 3, false, surfacePointOut());
    expect(() => dressingShare(dressingRule({ construction: { min: 1 } }), bare, 0, 0)).toThrow(/construction was not read/);
    expect(dressingShare(dressingRule({ slope: { max: 20 } }), bare, 0, 0)).toBe(1);
  });
});
