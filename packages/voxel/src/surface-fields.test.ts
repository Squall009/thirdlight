/**
 * The surface fields on made worlds: each field on a case whose answer is
 * known by construction (a slope of a known angle, a material boundary and
 * a wall at known distances, a pond of known depth, a gas bank of known
 * bottom, top and density, wet ground, a roof, a stamp), the per-point form
 * on a cave floor under a hill and on both storeys of a building, the two
 * forms against each other and the distance search against a plain scan of
 * the definition, the point snap, and what feeds the fields.
 */
import { describe, expect, it } from 'vitest';
import { changeFeeds, DERIVED_PART, isConstructionRole, recordValue, SHAPE_FULL, valueMaterial, valueRole, valueShape, VOXEL_ROLE } from './record';
import { isBodyRole } from './role-traits';
import {
  SURFACE_DISTANCE_CAP_M,
  SURFACE_FIELD_NAMES,
  SURFACE_NO_ROW,
  SURFACE_PAD_CELLS,
  SURFACE_SHEET_RISE,
  SURFACE_SNAP_CELLS,
  SURFACE_UNKNOWN,
  surfaceCellsSource,
  surfaceDistanceCells,
  surfaceFields,
  surfaceFieldsFed,
  surfaceFieldsOf,
  surfacePoint,
  surfacePointOut,
  surfaceRows,
  surfaceTable,
  surfaceTop,
  surfaceWallRows,
  type SurfaceCells,
  type SurfacePoint,
  type SurfaceSource,
} from './surface-fields';

const R = VOXEL_ROLE;
const GRASS = 3;
const SAND = 4;
const STONE = 5;
const MOSS = 6;
const WOOD = 7;
const WATER = 20;
const MIST = 40;
const SMOKE = 41;
const M = 0.5;
const CAP = SURFACE_DISTANCE_CAP_M;

const ground = (material = GRASS, shape = SHAPE_FULL, wetness = 0): number => recordValue(material, R.terrain, shape, wetness);
const block = (role: number, material = STONE): number => recordValue(material, role, SHAPE_FULL, 0);
const water = (level = SHAPE_FULL): number => recordValue(WATER, R.liquid, level, 0);
const gas = (density: number, material = MIST): number => recordValue(material, R.gas, density, 0);

/** A box of cells to write a made world into. Its lowest cell is (ox, oy, oz), so nothing here relies on a box at the origin. */
class Box {
  readonly values: Uint32Array;
  built: Uint8Array | null = null;
  constructor(readonly sx: number, readonly sy: number, readonly sz: number, readonly ox = -7, readonly oy = -8, readonly oz = 5, readonly cellM = M) {
    this.values = new Uint32Array(sx * sy * sz);
  }
  /** Box coordinates. */
  set(x: number, y: number, z: number, v: number): void {
    this.values[(x * this.sz + z) * this.sy + y] = v;
  }
  get(x: number, y: number, z: number): number {
    return x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz ? 0 : this.values[(x * this.sz + z) * this.sy + y]!;
  }
  stamp(x: number, y: number, z: number): void {
    (this.built ??= new Uint8Array(this.values.length))[(x * this.sz + z) * this.sy + y] = 1;
  }
  isBuilt(x: number, y: number, z: number): boolean {
    return this.built !== null && x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz && this.built[(x * this.sz + z) * this.sy + y] === 1;
  }
  /** Ground from the box's floor up to a height in cells (a fraction: the top cell's fill, in fifteenths). */
  column(x: number, z: number, height: number, material = GRASS, wetness = 0): void {
    const whole = Math.floor(height + 1e-9);
    for (let y = 0; y < whole; y++) this.set(x, y, z, ground(material, SHAPE_FULL, wetness));
    const part = Math.round((height - whole) * SHAPE_FULL);
    if (part > 0) this.set(x, whole, z, ground(material, part, wetness));
  }
  flat(height: number, material = GRASS): this {
    for (let x = 0; x < this.sx; x++) for (let z = 0; z < this.sz; z++) this.column(x, z, height, material);
    return this;
  }
  cells(): SurfaceCells {
    return { sx: this.sx, sy: this.sy, sz: this.sz, ox: this.ox, oy: this.oy, oz: this.oz, cellM: this.cellM, values: this.values, built: this.built };
  }
  /** The fields of the surface at box row `row` of box column (x, z). */
  at(x: number, z: number, row = surfaceTop(surfaceTable(this.cells()), x, z)): SurfacePoint {
    return surfaceFieldsOf(surfaceTable(this.cells()), x, z, row, true, surfacePointOut());
  }
  /** The per-point form at a box cell. */
  point(x: number, y: number, z: number, distances = true): SurfacePoint | false | null {
    const out = surfacePointOut();
    const r = surfacePoint(surfaceCellsSource(this.cells()), this.ox + x, this.oy + y, this.oz + z, distances, out);
    return r === true ? out : r;
  }
}

/** Whether two arrays hold the same bytes (NaN patterns included). */
function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** A height in metres of a box row plus a fill. */
const metres = (b: Box, row: number, fill = SHAPE_FULL): number => (b.oy + row + fill / SHAPE_FULL) * b.cellM;

describe('surface fields: each field on a made case', () => {
  it('reads the height from the fill, and the material, role and wetness of the surface cell', () => {
    const b = new Box(9, 12, 9).flat(4);
    b.set(4, 4, 4, ground(SAND, 6, 5));
    const p = b.at(4, 4);
    expect(p.row).toBe(b.oy + 4);
    expect(p.height).toBeCloseTo(metres(b, 4, 6), 12);
    expect([p.material, p.role, p.wetness]).toEqual([SAND, R.terrain, 5]);
    // A block is whole whatever its integrity.
    b.set(2, 4, 2, recordValue(STONE, R.floor, 3, 0));
    expect(b.at(2, 2).height).toBeCloseTo(metres(b, 4), 12);
    expect(b.at(0, 0).height).toBeCloseTo(metres(b, 3), 12);
    expect(b.at(0, 0).wetness).toBe(0);
  });

  it('reads a slope of a known angle, along either axis and across both, and none on flat ground', () => {
    const deg = (rise: number): number => (Math.atan(rise) * 180) / Math.PI;
    const along = (fx: number, fz: number): Box => {
      const b = new Box(12, 16, 12);
      for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) b.column(x, z, 2 + x * fx + z * fz);
      return b;
    };
    expect(along(0, 0).at(5, 5).slope).toBe(0);
    expect(along(1 / 3, 0).at(5, 5).slope).toBeCloseTo(deg(1 / 3), 9);
    expect(along(0, 1 / 3).at(5, 5).slope).toBeCloseTo(deg(1 / 3), 9);
    expect(along(1, 0).at(5, 5).slope).toBeCloseTo(45, 9);
    expect(along(1 / 3, 1 / 3).at(5, 5).slope).toBeCloseTo(deg(Math.SQRT2 / 3), 9);
    // At the box's edge the one side there is gives the same plane's slope.
    expect(along(1 / 3, 0).at(0, 5).slope).toBeCloseTo(deg(1 / 3), 9);
    // The same ground in 2 m cells is the same angle.
    const coarse = new Box(8, 12, 8, 0, 0, 0, 2);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) coarse.column(x, z, 2 + x / 3);
    expect(coarse.at(4, 4).slope).toBeCloseTo(deg(1 / 3), 9);
  });

  it('leaves a wall beside the surface out of the slope, and reads a cliff of ground as steep', () => {
    const b = new Box(12, 16, 12).flat(3);
    for (let z = 0; z < 12; z++) for (let y = 3; y < 9; y++) b.set(6, y, z, block(R.wall));
    expect(b.at(5, 5).slope).toBe(0);
    expect(b.at(7, 5).slope).toBe(0);
    const cliff = new Box(12, 16, 12);
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) cliff.column(x, z, x < 6 ? 3 : 9);
    // Six cells of rise beside it and level ground on its other side: (6 − 0) / 2 a cell.
    expect(cliff.at(5, 5).slope).toBeCloseTo((Math.atan(3) * 180) / Math.PI, 9);
    expect(cliff.at(2, 5).slope).toBe(0);
  });

  it('measures the distance to another material at a boundary a known way off, capped', () => {
    const b = new Box(48, 6, 40).flat(3);
    for (let x = 30; x < 48; x++) for (let z = 0; z < 40; z++) b.column(x, z, 3, SAND);
    expect(b.at(25, 20).materialEdge).toBeCloseTo(5 * M, 12);
    expect(b.at(29, 20).materialEdge).toBeCloseTo(M, 12);
    expect(b.at(30, 20).materialEdge).toBeCloseTo(M, 12);
    expect(b.at(14, 20).materialEdge).toBeCloseTo(CAP, 12);
    expect(b.at(13, 20).materialEdge).toBe(CAP);
    expect(b.at(2, 20).materialEdge).toBe(CAP);
    // One column of another material off both axes: 3 and 4 columns away is 5.
    const one = new Box(40, 6, 40).flat(3);
    one.column(23, 24, 3, STONE);
    expect(one.at(20, 20).materialEdge).toBeCloseTo(5 * M, 12);
    expect(one.at(23, 24).materialEdge).toBeCloseTo(M, 12);
    // 12 and 12 columns away is past the cap, though inside the square searched.
    const corner = new Box(40, 6, 40).flat(3);
    corner.column(32, 32, 3, STONE);
    expect(corner.at(20, 20).materialEdge).toBe(CAP);
    // A column with a surface as far under the sheet as another over it: the lower is the one read.
    const two = (lower: number, upper: number): Box => {
      const t = new Box(40, 20, 40).flat(8);
      for (let y = 6; y < 8; y++) t.set(23, y, 20, 0);
      t.set(23, 5, 20, ground(lower));
      t.set(23, 9, 20, ground(upper));
      return t;
    };
    expect(two(GRASS, STONE).at(20, 20).materialEdge).toBe(CAP);
    expect(two(STONE, GRASS).at(20, 20).materialEdge).toBeCloseTo(3 * M, 12);
    // Wetness and fill are not a material.
    const wet = new Box(40, 6, 40).flat(3);
    wet.set(22, 2, 20, ground(GRASS, 9, 7));
    expect(wet.at(20, 20).materialEdge).toBe(CAP);
  });

  it('measures the distance to a wall a known way off, 0 on a block, and reads no ground under one', () => {
    const b = new Box(48, 12, 40).flat(3);
    for (let z = 10; z < 30; z++) for (let y = 3; y < 9; y++) b.set(30, y, z, block(R.wall));
    expect(b.at(24, 20).construction).toBeCloseTo(6 * M, 12);
    expect(b.at(29, 20).construction).toBeCloseTo(M, 12);
    expect(b.at(31, 20).construction).toBeCloseTo(M, 12);
    expect(b.at(10, 20).construction).toBe(CAP);
    // Past the wall's end the nearest block is its end column.
    expect(b.at(27, 33).construction).toBeCloseTo(Math.hypot(3, 4) * M, 12);
    // The wall's top is a surface of its own, a block: distance 0.
    const top = b.at(30, 20);
    expect([top.row, top.role, top.construction]).toEqual([b.oy + 8, R.wall, 0]);
    // The ground under the wall is no surface.
    expect([...surfaceRows(surfaceTable(b.cells()), 30, 20)]).toEqual([8]);
    // A block over the ground beside it stands on the sheet up to a wall's height and a row a column: five rows up counts from
    // the column beside, ten rows up only from six columns off.
    const eave = new Box(40, 16, 40).flat(3);
    eave.set(20, 7, 20, block(R.roof));
    expect(eave.at(19, 20).construction).toBeCloseTo(M, 12);
    expect(eave.at(18, 20).construction).toBeCloseTo(2 * M, 12);
    const high = new Box(40, 16, 40).flat(3);
    high.set(20, 12, 20, block(R.roof));
    expect(high.at(19, 20).construction).toBe(CAP);
    expect(high.at(15, 20).construction).toBe(CAP);
    expect(high.at(14, 20).construction).toBeCloseTo(6 * M, 12);
  });

  it('reads a pond of known depth, and none on dry ground', () => {
    const b = new Box(12, 16, 12).flat(10);
    for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) {
      for (let y = 6; y < 10; y++) b.set(x, y, z, 0);
      b.set(x, 5, z, ground(SAND, 9));
      for (let y = 6; y < 9; y++) b.set(x, y, z, water());
      b.set(x, 9, z, water(8));
    }
    const p = b.at(5, 5);
    expect(p.material).toBe(SAND);
    expect(p.height).toBeCloseTo(metres(b, 5, 9), 12);
    expect(p.waterTop).toBeCloseTo(metres(b, 9, 8), 12);
    expect(p.waterDepth).toBeCloseTo(metres(b, 9, 8) - metres(b, 5, 9), 12);
    expect(p.waterDepth).toBeCloseTo((3 + 8 / 15 + 6 / 15) * M, 12);
    expect(p.waterMaterial).toBe(WATER);
    expect(p.sky).toBe(1);
    const dry = b.at(1, 1);
    expect([Number.isNaN(dry.waterTop), dry.waterDepth, dry.waterMaterial]).toEqual([true, 0, 0]);
  });

  it('reads a gas bank of known bottom, top and density, the lowest one, over water too', () => {
    const b = new Box(12, 24, 12).flat(10);
    // Two rows of air, then a bank of four cells, air, then another gas.
    [15, 10, 5, 2].forEach((d, i) => b.set(3, 12 + i, 3, gas(d)));
    b.set(3, 18, 3, gas(15, SMOKE));
    const p = b.at(3, 3);
    expect(p.gasBottom).toBeCloseTo((b.oy + 12) * M, 12);
    expect(p.gasTop).toBeCloseTo((b.oy + 16) * M, 12);
    expect(p.gasDensity).toBeCloseTo(32 / 60, 12);
    expect(p.gasMaterial).toBe(MIST);
    expect(p.sky).toBe(1);
    // A bank lying on the ground, and one gas on another: the lowest material's run alone.
    b.set(6, 10, 6, gas(6));
    b.set(6, 11, 6, gas(12));
    b.set(6, 12, 6, gas(15, SMOKE));
    const q = b.at(6, 6);
    expect([q.gasBottom, q.gasTop, q.gasMaterial]).toEqual([(b.oy + 10) * M, (b.oy + 12) * M, MIST]);
    expect(q.gasDensity).toBeCloseTo(18 / 30, 12);
    // Over water: the water's fields and the gas over it.
    b.set(8, 9, 8, ground(SAND));
    b.set(8, 10, 8, water(15));
    b.set(8, 11, 8, gas(3));
    const w = b.at(8, 8);
    expect(w.waterDepth).toBeCloseTo(M, 12);
    expect([w.gasBottom, w.gasTop]).toEqual([(b.oy + 11) * M, (b.oy + 12) * M]);
    expect(w.gasDensity).toBeCloseTo(0.2, 12);
    const none = b.at(1, 1);
    expect([Number.isNaN(none.gasBottom), Number.isNaN(none.gasTop), none.gasDensity, none.gasMaterial]).toEqual([true, true, 0, 0]);
  });

  it('reads open sky, a roof over the ground, and the roof under the sky', () => {
    const b = new Box(12, 24, 12).flat(4);
    for (let x = 3; x < 8; x++) for (let z = 3; z < 8; z++) b.set(x, 15, z, block(R.roof, WOOD));
    expect(b.at(1, 1).sky).toBe(1);
    expect(b.at(5, 5, 3).sky).toBe(0);
    const roof = b.at(5, 5);
    expect([roof.row, roof.material, roof.sky]).toEqual([b.oy + 15, WOOD, 1]);
    // A gas or a liquid overhead closes nothing.
    b.set(1, 20, 1, gas(15));
    b.set(1, 21, 1, water());
    expect(b.at(1, 1).sky).toBe(1);
  });

  it('closes a cell a stamp stands in: no ground under it, no sky through it, construction beside it, never a surface itself', () => {
    const b = new Box(40, 16, 40).flat(4);
    // A stamped slab on the ground and a stamped wall on it.
    for (let x = 20; x < 26; x++) for (let z = 16; z < 24; z++) b.stamp(x, 4, z);
    for (let z = 16; z < 24; z++) for (let y = 5; y < 10; y++) b.stamp(20, y, z);
    const t = surfaceTable(b.cells());
    expect(surfaceTop(t, 22, 20)).toBe(SURFACE_NO_ROW);
    expect([...surfaceRows(t, 20, 20)]).toEqual([]);
    expect(b.at(17, 20).construction).toBeCloseTo(3 * M, 12);
    expect(b.at(19, 20).slope).toBe(0);
    // A stamp overhead alone.
    b.stamp(5, 12, 5);
    expect(b.at(5, 5).sky).toBe(0);
    expect(b.at(6, 5).sky).toBe(1);
    // The same world without the stamps reads plain ground.
    b.built = null;
    expect(b.at(22, 20).construction).toBe(CAP);
  });

  it('gives a column with no surface the empty values in the block form, the distances at their cap', () => {
    const b = new Box(6, 8, 6).flat(3);
    for (let y = 0; y < 8; y++) b.set(2, y, 2, 0);
    for (let y = 0; y < 8; y++) b.set(4, y, 4, water());
    const f = surfaceFields(b.cells());
    for (const k of [2 * 6 + 2, 4 * 6 + 4]) {
      expect(f.row[k]).toBe(SURFACE_NO_ROW);
      expect(Number.isNaN(f.height[k]!)).toBe(true);
      expect([f.material[k], f.role[k], f.slope[k], f.waterDepth[k], f.materialEdge[k], f.construction[k]]).toEqual([0, 0, 0, 0, CAP, CAP]);
    }
    expect([f.x, f.z, f.w, f.d, f.cellM]).toEqual([b.ox, b.oz, 6, 6, M]);
    expect(() => surfaceFields(b.cells(), { x: 2, z: 2, w: 5, d: 1 })).toThrow(RangeError);
  });
});

/** A hill with a cave in it: ground to row 30, a hollow of rows 10 … 14 with a stone floor, a moss patch on the floor. */
function caveWorld(): Box {
  const b = new Box(44, 40, 44).flat(31);
  for (let x = 6; x < 38; x++) for (let z = 6; z < 38; z++) {
    for (let y = 10; y < 15; y++) b.set(x, y, z, 0);
    b.set(x, 9, z, ground(STONE));
  }
  for (let x = 24; x < 27; x++) for (let z = 20; z < 23; z++) b.set(x, 9, z, ground(MOSS, SHAPE_FULL, 4));
  return b;
}

/** A house of two storeys on flat ground: floors at rows 4 and 11, a roof at row 18, walls round them, each storey its own floor material. */
function houseWorld(): Box {
  const b = new Box(44, 26, 44).flat(4);
  for (let x = 14; x < 30; x++) for (let z = 14; z < 30; z++) {
    const rim = x === 14 || x === 29 || z === 14 || z === 29;
    b.set(x, 4, z, block(R.floor, STONE));
    b.set(x, 11, z, block(R.floor, WOOD));
    b.set(x, 18, z, block(R.roof, WOOD));
    if (rim) for (let y = 5; y < 18; y++) b.set(x, y, z, block(R.wall, STONE));
  }
  return b;
}

describe('surface fields: the per-point form answers the surface the point is on', () => {
  it('answers a cave floor under a hill, not the hill over it', () => {
    const b = caveWorld();
    const floor = b.point(20, 12, 20);
    expect(floor).not.toBeNull();
    expect(floor).not.toBe(false);
    const f = floor as SurfacePoint;
    expect([f.row, f.material, f.sky, f.slope]).toEqual([b.oy + 9, STONE, 0, 0]);
    expect(f.height).toBeCloseTo(metres(b, 9), 12);
    // The moss four columns off is its nearest other material; the grass over it is not on its sheet.
    expect(f.materialEdge).toBeCloseTo(4 * M, 12);
    expect((b.point(8, 11, 8) as SurfacePoint).materialEdge).toBe(CAP);
    expect((b.point(25, 10, 21) as SurfacePoint).wetness).toBe(4);
    // The same column's top is the hill.
    const top = b.point(20, 32, 20) as SurfacePoint;
    expect([top.row, top.material, top.sky, top.materialEdge]).toEqual([b.oy + 30, GRASS, 1, CAP]);
    const t = surfaceTable(b.cells());
    expect([...surfaceRows(t, 20, 20)]).toEqual([9, 30]);
    // The block form of that column is its top.
    const cols = surfaceFields(b.cells(), { x: 20, z: 20, w: 1, d: 1 });
    expect([cols.row[0], cols.material[0], cols.sky[0]]).toEqual([b.oy + 30, GRASS, 1]);
  });

  it('answers each storey of a building, and the roof', () => {
    const b = houseWorld();
    const lower = b.point(20, 6, 20) as SurfacePoint;
    const upper = b.point(20, 13, 20) as SurfacePoint;
    const roof = b.point(20, 20, 20) as SurfacePoint;
    expect([lower.row, lower.material, lower.role, lower.sky, lower.construction]).toEqual([b.oy + 4, STONE, R.floor, 0, 0]);
    expect([upper.row, upper.material, upper.role, upper.sky, upper.construction]).toEqual([b.oy + 11, WOOD, R.floor, 0, 0]);
    expect([roof.row, roof.role, roof.sky]).toEqual([b.oy + 18, R.roof, 1]);
    expect(lower.height).toBeCloseTo(metres(b, 4), 12);
    expect(upper.height).toBeCloseTo(metres(b, 11), 12);
    // Beside the wall inside: flat (the wall is left out), nothing of another material on the storey's own sheet near the middle.
    expect((b.point(15, 13, 20) as SurfacePoint).slope).toBe(0);
    // The upper floor is wood wall to wall; the ground outside, eight rows under it, is on its sheet from eight columns off.
    expect(upper.materialEdge).toBeCloseTo(8 * M, 12);
    // The lower floor reads the grass outside its wall, a row under it, seven columns off.
    expect(lower.materialEdge).toBeCloseTo(7 * M, 12);
    // The meadow outside reads the house's wall 3 columns away, and the floor's other material at the wall's column.
    const outside = b.point(11, 5, 20) as SurfacePoint;
    expect([outside.material, outside.sky]).toEqual([GRASS, 1]);
    expect(outside.construction).toBeCloseTo(3 * M, 12);
    expect(outside.slope).toBe(0);
  });

  it('finds the surface under a point a few cells over it or inside the body, through water, and not past its bound', () => {
    const b = new Box(9, 40, 9).flat(10);
    const row = b.oy + 9;
    expect((b.point(4, 10, 4, false) as SurfacePoint).row).toBe(row);
    expect((b.point(4, 9 + SURFACE_SNAP_CELLS, 4, false) as SurfacePoint).row).toBe(row);
    expect(b.point(4, 10 + SURFACE_SNAP_CELLS, 4, false)).toBe(false);
    // Inside the ground: its top, a few cells up; deeper, nothing.
    expect((b.point(4, 9, 4, false) as SurfacePoint).row).toBe(row);
    expect((b.point(4, 9 - SURFACE_SNAP_CELLS, 4, false) as SurfacePoint).row).toBe(row);
    expect(b.point(4, 8 - SURFACE_SNAP_CELLS, 4, false)).toBe(false);
    // In deep water the bed, however far down; the air over the water counts.
    for (let y = 10; y < 30; y++) b.set(6, y, 6, water());
    expect((b.point(6, 29, 6, false) as SurfacePoint).row).toBe(row);
    expect((b.point(6, 29, 6, false) as SurfacePoint).waterDepth).toBeCloseTo(20 * M, 12);
    expect((b.point(6, 32, 6, false) as SurfacePoint).row).toBe(row);
    expect(b.point(6, 30 + SURFACE_SNAP_CELLS, 6, false)).toBe(false);
    // A stamped cell is another grid's to answer.
    b.stamp(2, 10, 2);
    expect(b.point(2, 10, 2, false)).toBe(false);
    expect(b.point(2, 11, 2, false)).toBe(false);
    // Without the distances they are not numbers; with, they are.
    expect(Number.isNaN((b.point(4, 10, 4, false) as SurfacePoint).materialEdge)).toBe(true);
    expect((b.point(4, 10, 4, true) as SurfacePoint).materialEdge).toBe(CAP);
  });

  it('answers null where a cell it needs is not known, and reads nothing it does not need', () => {
    const b = caveWorld();
    const inner = surfaceCellsSource(b.cells());
    const reads: Array<[number, number, number]> = [];
    const src = (unknown: (x: number, y: number, z: number) => boolean): SurfaceSource => ({
      cellM: M,
      value: (x, y, z) => {
        reads.push([x, y, z]);
        return unknown(x, y, z) ? SURFACE_UNKNOWN : inner.value(x, y, z);
      },
      top: inner.top,
    });
    const [px, py, pz] = [b.ox + 20, b.oy + 12, b.oz + 20];
    const out = surfacePointOut();
    expect(surfacePoint(src(() => false), px, py, pz, false, out)).toBe(true);
    // Without the distances: its own column and the four beside it, nothing else.
    expect(reads.every(([x, , z]) => Math.abs(x - px) + Math.abs(z - pz) <= 1)).toBe(true);
    const local = reads.length;
    reads.length = 0;
    expect(surfacePoint(src(() => false), px, py, pz, true, out)).toBe(true);
    const reach = surfaceDistanceCells(M);
    expect(reads.every(([x, y, z]) => {
      const d = Math.max(Math.abs(x - px), Math.abs(z - pz));
      return d <= reach && (d <= 1 || Math.abs(y - (b.oy + 9)) <= SURFACE_SHEET_RISE * d + surfaceWallRows(M));
    })).toBe(true);
    expect(reads.length).toBeGreaterThan(local);
    // A column beside it not known: no answer. One far off not known: an answer without the distances, none with.
    expect(surfacePoint(src((x) => x === px + 1), px, py, pz, false, out)).toBeNull();
    expect(surfacePoint(src((x) => x === px + 9), px, py, pz, false, out)).toBe(true);
    expect(surfacePoint(src((x) => x === px + 9), px, py, pz, true, out)).toBeNull();
    expect(surfacePoint(src((_x, y) => y === py - 1), px, py, pz, false, out)).toBeNull();
  });
});

/** A made world with everything in it: rolling ground of three materials, a pond, fog, the cave and the house's parts, a stamp. */
function mixedWorld(seed: number): Box {
  const b = new Box(72, 48, 72, -31, -12, 17);
  let s = seed >>> 0;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const phase = rnd() * 6;
  for (let x = 0; x < 72; x++) for (let z = 0; z < 72; z++) {
    const h = 14 + 4 * Math.sin(x / 7 + phase) + 3 * Math.cos(z / 5 + phase) + (x > 50 ? (x - 50) * 0.9 : 0);
    // Stripes and patches of three materials, and a wide field of one where nothing lies within the cap.
    const m = x > 34 && z < 30 ? GRASS : (x + 2 * z) % 23 < 9 ? SAND : Math.sin(x / 9) * Math.cos(z / 11) > 0.3 ? STONE : GRASS;
    b.column(x, z, Math.round(h * SHAPE_FULL) / SHAPE_FULL, m, (x * 7 + z) % 8);
  }
  // A pond, fog over part of it, a second gas higher up.
  for (let x = 8; x < 20; x++) for (let z = 8; z < 20; z++) {
    for (let y = 9; y < 40; y++) b.set(x, y, z, 0);
    b.set(x, 8, z, ground(SAND, 11));
    for (let y = 9; y < 13; y++) b.set(x, y, z, water(y === 12 ? 7 : SHAPE_FULL));
    if (x < 14) for (let y = 14; y < 17; y++) b.set(x, y, z, gas(1 + ((x + y + z) % 15)));
    if (z < 12) b.set(x, 20, z, gas(9, SMOKE));
  }
  // A cave through a hillside, and a two-storey shell with a gap for a door.
  for (let x = 52; x < 68; x++) for (let z = 30; z < 44; z++) for (let y = 16; y < 20; y++) b.set(x, y, z, 0);
  for (let x = 54; x < 58; x++) for (let z = 32; z < 36; z++) b.set(x, 15, z, ground(MOSS));
  for (let x = 28; x < 42; x++) for (let z = 40; z < 54; z++) {
    for (let y = 18; y < 40; y++) b.set(x, y, z, 0);
    b.set(x, 18, z, block(R.floor, STONE));
    b.set(x, 25, z, block(R.floor, WOOD));
    b.set(x, 32, z, block(R.roof, WOOD));
    const rim = x === 28 || x === 41 || z === 40 || z === 53;
    if (rim && !(z === 40 && x > 33 && x < 36)) for (let y = 19; y < 32; y++) b.set(x, y, z, block(R.wall, STONE));
  }
  for (let x = 30; x < 33; x++) b.set(x, 19, 45, block(R.stair, WOOD));
  // A stamped shed on the open ground.
  for (let x = 4; x < 9; x++) for (let z = 50; z < 56; z++) for (let y = 10; y < 30; y++) if (b.get(x, y, z) === 0 && b.get(x, y - 1, z) !== 0 && y < 26) for (let u = y; u < y + 4; u++) b.stamp(x, u, z);
  return b;
}

/** The two distances by a plain scan of the definition, from the cells alone. */
function scanDistances(b: Box, x: number, z: number, row: number): { edge: number; built: number } {
  const reach = surfaceDistanceCells(b.cellM);
  const body = (u: number, y: number, w: number): boolean => {
    const v = b.get(u, y, w);
    return valueMaterial(v) !== 0 && isBodyRole(valueRole(v)) && valueShape(v) !== 0;
  };
  const closed = (u: number, y: number, w: number): boolean => body(u, y, w) || b.isBuilt(u, y, w);
  const isBlock = (u: number, y: number, w: number): boolean => y >= 0 && y < b.sy && (b.isBuilt(u, y, w) || (body(u, y, w) && isConstructionRole(valueRole(b.get(u, y, w)))));
  const material = valueMaterial(b.get(x, row, z));
  let edge = Infinity;
  let built = isBlock(x, row, z) ? 0 : Infinity;
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
    const d = Math.max(Math.abs(dx), Math.abs(dz));
    const dist = Math.hypot(dx, dz);
    const [u, w] = [x + dx, z + dz];
    if (d === 0 || dist > reach || u < 0 || w < 0 || u >= b.sx || w >= b.sz) continue;
    const band = SURFACE_SHEET_RISE * d;
    // The column's surface nearest in row inside the band, the lower of two as near.
    let near = -1;
    for (let k = 0; k <= band && near < 0; k++) for (const y of [row - k, row + k]) if (near < 0 && y >= 0 && y < b.sy && body(u, y, w) && !b.isBuilt(u, y, w) && !closed(u, y + 1, w)) near = y;
    if (near >= 0 && valueMaterial(b.get(u, near, w)) !== material) edge = Math.min(edge, dist);
    for (let y = row - band; y <= row + band + surfaceWallRows(b.cellM); y++) if (isBlock(u, y, w)) built = Math.min(built, dist);
  }
  const cap = (v: number): number => (v === Infinity ? CAP : v * b.cellM);
  return { edge: cap(edge), built: cap(built) };
}

describe('surface fields: one arithmetic for both forms', () => {
  it('measures both distances as a plain scan of the definition does, on every surface of a made world', () => {
    let surfaces = 0;
    let capped = 0;
    let multi = 0;
    for (const seed of [1, 2]) {
      const b = mixedWorld(seed);
      const t = surfaceTable(b.cells());
      const out = surfacePointOut();
      for (let x = 0; x < b.sx; x += 1) for (let z = (x * 3) % 2; z < b.sz; z += 2) {
        const rows = surfaceRows(t, x, z);
        if (rows.length > 1) multi++;
        for (const row of rows) {
          surfaceFieldsOf(t, x, z, row, true, out);
          const want = scanDistances(b, x, z, row);
          if (Math.abs(out.materialEdge - want.edge) > 1e-9 || Math.abs(out.construction - want.built) > 1e-9) throw new Error(`seed ${seed} column ${x},${z} row ${row}: edge ${out.materialEdge} against ${want.edge}, construction ${out.construction} against ${want.built}`);
          surfaces++;
          if (want.edge === CAP) capped++;
        }
      }
    }
    // The case holds what it is for: many surfaces, columns of several, distances both found and capped.
    expect(surfaces).toBeGreaterThan(5000);
    expect(multi).toBeGreaterThan(200);
    expect(capped).toBeGreaterThan(50);
    expect(capped).toBeLessThan(surfaces - 1000);
  });

  it('gives, a point at a time through a reader, every field the kernel gives on the whole box, for every surface a ring inside it', () => {
    const b = mixedWorld(3);
    const t = surfaceTable(b.cells());
    const src = surfaceCellsSource(b.cells());
    const pad = SURFACE_PAD_CELLS;
    const whole = surfacePointOut();
    const point = surfacePointOut();
    let n = 0;
    for (let x = pad; x < b.sx - pad; x += 2) for (let z = pad + (x % 2); z < b.sz - pad; z += 2) for (const row of surfaceRows(t, x, z)) {
      surfaceFieldsOf(t, x, z, row, true, whole);
      // The point is asked at the surface cell and at the cell over it: both name this surface.
      for (const y of [row, row + 1]) {
        expect(surfacePoint(src, b.ox + x, b.oy + y, b.oz + z, true, point), `column ${x},${z} row ${row} from ${y}`).toBe(true);
        expect(point, `column ${x},${z} row ${row} from ${y}`).toEqual(whole);
      }
      n++;
    }
    expect(n).toBeGreaterThan(400);
  });

  it('is, in the block form, the kernel at each column\'s highest surface, value for value', () => {
    const b = mixedWorld(4);
    const t = surfaceTable(b.cells());
    const foot = { x: 20, z: 20, w: 32, d: 32 };
    const f = surfaceFields(b.cells(), foot);
    const p = surfacePointOut();
    let stored = 0;
    for (let i = 0; i < foot.w; i++) for (let k = 0; k < foot.d; k++) {
      const row = surfaceTop(t, foot.x + i, foot.z + k);
      if (row === SURFACE_NO_ROW) continue;
      surfaceFieldsOf(t, foot.x + i, foot.z + k, row, true, p);
      for (const name of SURFACE_FIELD_NAMES) {
        const kept = f[name][i * foot.d + k]!;
        const want = f[name] instanceof Float32Array ? Math.fround(p[name]) : p[name];
        if (!Object.is(kept, want)) throw new Error(`${name} at ${i},${k}: ${kept} against ${want}`);
      }
      stored++;
    }
    expect(stored).toBeGreaterThan(900);
    // The same cells give the same bytes again, and a footprint is the whole box's values there.
    const again = surfaceFields(b.cells(), foot);
    const all = surfaceFields(b.cells());
    for (const name of SURFACE_FIELD_NAMES) {
      expect(sameBytes(again[name], f[name]), name).toBe(true);
      for (let i = 0; i < foot.w; i += 5) for (let k = 0; k < foot.d; k += 7) expect(Object.is(all[name][(foot.x + i) * b.sz + foot.z + k], f[name][i * foot.d + k]), `${name} at ${i},${k}`).toBe(true);
    }
  });
});

describe('surface fields: what feeds them', () => {
  it('is fed by every change of a cell, a medium\'s too, and a medium\'s change still feeds no mesh', () => {
    const cases: Array<[string, number, number]> = [
      ['ground dug', ground(), 0],
      ['a fill changed', ground(GRASS, 9), ground(GRASS, 12)],
      ['a material painted', ground(GRASS), ground(SAND)],
      ['wetness', ground(GRASS, 15, 0), ground(GRASS, 15, 3)],
      ['a wall built', 0, block(R.wall)],
      ['water poured', 0, water()],
      ['a water level', water(4), water(9)],
      ['fog painted', 0, gas(8)],
      ['a fog density', gas(8), gas(3)],
      ['a fog material', gas(8), gas(8, SMOKE)],
      ['water over fog', gas(8), water()],
    ];
    for (const [what, from, to] of cases) expect(surfaceFieldsFed(changeFeeds(from, to)), what).toBe(true);
    expect(surfaceFieldsFed(changeFeeds(ground(), ground()))).toBe(false);
    // The narrowed feeds stand: the fields add no part to a medium's change.
    expect(changeFeeds(0, gas(8))).toBe(DERIVED_PART.gas);
    expect(changeFeeds(gas(8), gas(3))).toBe(DERIVED_PART.gas);
    expect(changeFeeds(0, water())).toBe(DERIVED_PART.liquid);
    expect(surfaceFieldsFed(DERIVED_PART.collision | DERIVED_PART.nav | DERIVED_PART.light)).toBe(false);
  });
});
