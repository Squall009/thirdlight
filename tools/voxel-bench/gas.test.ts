/**
 * The gas role in the data: the record holds it (value 10, its shape a
 * density, no wetness), the coarser levels keep it only where nothing else
 * holds and its mean density rounds to a level, a change of gas alone feeds
 * the gas part alone, and every consumer reads a gas cell as the air it
 * stands in: the town (banks on the ground, in rooms, against walls, over
 * ponds) and the hard-case row (through an arch, in a cave) derive to the
 * same bytes with gas written into their open cells as
 * without it.
 */
import { createHash } from 'node:crypto';
import {
  applyEdit,
  buildApron,
  canonicalEditCommand,
  changeFeeds,
  checkRecordValue,
  checkVoxel,
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  createWorldStore,
  decodeDenseChunk,
  DERIVED_PART,
  deriveMipNode,
  deriveSectionsWithApron,
  downsampleMip,
  EditCommandError,
  encodeDenseChunk,
  encodeShader,
  farBricksFromFaces,
  farGroundTops,
  fillLevel,
  heldWetness,
  isBodyRole,
  isGasRole,
  isLiquidRole,
  isMediumRole,
  jobRadius,
  levelFill,
  localIndex,
  MIP_MEDIUM_ROLES,
  MIP_OPEN_ROLES,
  MipTree,
  OPEN_ROLE,
  openRegionsArrays,
  PLANE_BIT,
  recordValue,
  roleBlocksWalkers,
  roleCollides,
  roleShape,
  roleStopsLight,
  roleTraits,
  ROLE_TRAITS,
  savedValue,
  sectionLocalOrigin,
  SHAPE_FULL,
  STAMP_CLASS,
  stampClassOfValue,
  valueRole,
  valueShape,
  valueWetness,
  VOXEL_ROLE,
  VOXEL_ROLE_COUNT,
  WalkGraph,
  WORLD_RULES,
  type DenseChunk,
  type DerivedData,
  type DeriveOutput,
  type PaletteStore,
  type WalkGraphView,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { FEATURE_PAD, featuresWorld } from './features';
import { townWorld } from './town';
import { loadAreaCached } from './world-cache';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const R = VOXEL_ROLE;
/** Two gas materials (ids no test world uses). */
const MIST = 40;
const SMOKE = 41;
const gas = (density = SHAPE_FULL, material = MIST): number => recordValue(material, R.gas, density, 0);
const AIR = { material: 0, role: 0, shape: 0, wetness: 0 };

describe('the gas role in the record', () => {
  it('is value 10 of the role field, the eleventh assigned role: open space that holds a gas, its shape a density', () => {
    expect(R.gas).toBe(10);
    expect(VOXEL_ROLE_COUNT).toBe(11);
    expect(ROLE_TRAITS[10]).toEqual({ name: 'gas', body: false, stopsLight: false, blocksWalkers: false, collides: false, medium: 'gas', shape: 'density', portal: false, frame: false, mip: 'share', mipRank: 9 });
    expect([isGasRole(R.gas), isMediumRole(R.gas), isLiquidRole(R.gas), isBodyRole(R.gas), roleStopsLight(R.gas), roleBlocksWalkers(R.gas), roleCollides(R.gas)]).toEqual([true, true, false, false, false, false, false]);
    expect(OPEN_ROLE[R.gas]).toBe(1);
    expect(roleShape(R.gas)).toBe('density');
    // The density is the shape as stored: 16 levels, never read as a whole block.
    for (let d = 0; d <= SHAPE_FULL; d++) expect(fillLevel(R.gas, d)).toBe(d);
    expect(Object.values(R).filter(isGasRole)).toEqual([R.gas]);
    // Where no body holds a coarser cell: a liquid, then an opening, then a gas.
    expect([...MIP_MEDIUM_ROLES]).toEqual([R.liquid, R.gas]);
    expect([...MIP_OPEN_ROLES]).toEqual([R.liquid, R.opening, R.gas]);
  });

  it('is held by every form that checks a value, at every density; values 11 to 15 stay refused, and a gas with wetness or a reserved bit is refused', () => {
    for (let d = 1; d <= SHAPE_FULL; d++) {
      expect(() => checkRecordValue(gas(d))).not.toThrow();
      expect(() => checkVoxel({ material: MIST, role: R.gas, shape: d, wetness: 0 })).not.toThrow();
    }
    for (let role = 11; role <= 15; role++) {
      expect(() => checkRecordValue(recordValue(MIST, role, 8, 0)), `role ${role}`).toThrow(/unassigned role/);
      expect(() => checkVoxel({ material: MIST, role, shape: 8, wetness: 0 }), `role ${role}`).toThrow(/out of range/);
    }
    expect(() => checkRecordValue(recordValue(MIST, R.gas, 8, 1))).toThrow(/gas with wetness/);
    expect(() => checkVoxel({ material: MIST, role: R.gas, shape: 8, wetness: 3 })).toThrow(/gas holds no wetness/);
    expect(() => checkRecordValue((gas(8) | (1 << 23)) >>> 0)).toThrow(/reserved bits/);
    // Wetness stays what it was for every other role.
    expect(() => checkRecordValue(recordValue(MAT.water, R.liquid, 8, 3))).not.toThrow();
    expect(heldWetness(R.gas, 5)).toBe(0);
    expect(heldWetness(R.terrain, 5)).toBe(5);
  });

  it('goes through the chunk codec, the store and a stroke as it was written', () => {
    const d = createDenseChunk(grid);
    for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < 6; y++) {
      const i = localIndex(grid, x, y, z);
      d.material[i] = y < 2 ? MAT.rock : (x + z) & 8 ? MIST : SMOKE;
      d.role[i] = y < 2 ? R.terrain : R.gas;
      d.shape[i] = y < 2 ? SHAPE_FULL : 1 + ((x * 7 + y * 3 + z) % 15);
    }
    const bytes = encodeDenseChunk(grid, d)!;
    const back = createDenseChunk(grid);
    decodeDenseChunk(grid, bytes, back);
    for (const plane of ['material', 'role', 'shape', 'wetness'] as const) expect(Buffer.from(back[plane].buffer).equals(Buffer.from(d[plane].buffer)), plane).toBe(true);
    const store = createWorldStore(grid);
    store.importChunk(0, 0, 0, d);
    const v = { ...AIR };
    expect(store.voxelAt(3, 4, 2, v)).toEqual({ material: SMOKE, role: R.gas, shape: 1 + ((3 * 7 + 4 * 3 + 2) % 15), wetness: 0 });
    expect(store.voxelAt(3, 4, 5, v).material).toBe(MIST);
    // A set writes the density a command names; a stroke names a gas dry.
    const set = canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [3, 9, 5], voxel: { material: MIST, role: R.gas, shape: 4, wetness: 0 } });
    applyEdit({ store: () => store }, set);
    expect(store.voxelAt(3, 9, 5, v)).toEqual({ material: MIST, role: R.gas, shape: 4, wetness: 0 });
    expect(() => canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [3, 9, 5], voxel: { material: MIST, role: R.gas, shape: 4, wetness: 2 } })).toThrow(EditCommandError);
    expect(() => canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [0, 8, 0], max: [1, 8, 1], mode: 'add', voxel: { material: MIST, role: R.gas, wetness: 1 } })).toThrow(EditCommandError);
    expect(() => canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [3, 9, 5], voxel: { material: MIST, role: 11, shape: 4, wetness: 0 } })).toThrow(EditCommandError);
  });

  it('keeps a save\'s gas dry when a kept role lands on a base cell that was wet', () => {
    const wetGround = recordValue(MAT.grass, R.terrain, SHAPE_FULL, 5);
    const kept = savedValue(wetGround, gas(9), PLANE_BIT.material | PLANE_BIT.role | PLANE_BIT.shape);
    expect([valueRole(kept), valueShape(kept), valueWetness(kept)]).toEqual([R.gas, 9, 0]);
    expect(() => checkRecordValue(kept)).not.toThrow();
  });
});

describe('the coarser levels: gas adds nothing where anything else holds', () => {
  type Cell = readonly [role: number, shape: number, material: number];
  const parentOf = (cells: readonly Cell[]): { role: number; shape: number; material: number; wetness: number } => {
    const child = createDenseChunk(grid);
    // The 8 cells under parent cell (0, 0, 0) of octant 0.
    cells.forEach(([role, shape, material], c) => {
      const i = localIndex(grid, c & 1, (c >> 1) & 1, (c >> 2) & 1);
      child.material[i] = material;
      child.role[i] = role;
      child.shape[i] = shape;
    });
    const out = createDenseChunk(grid);
    downsampleMip(grid, [child, null, null, null, null, null, null, null], out);
    return { role: out.role[0]!, shape: out.shape[0]!, material: out.material[0]!, wetness: out.wetness[0]! };
  };
  const none: Cell = [0, 0, 0];
  const of = (...cells: Cell[]): Cell[] => [...cells, ...new Array<Cell>(8 - cells.length).fill(none)];
  const times = (n: number, cell: Cell): Cell[] => new Array<Cell>(n).fill(cell);
  const nothing = { role: R.air, shape: 0, material: 0, wetness: 0 };

  it('makes a coarse cell gas when its mean density over the 8 cells rounds to a level, the shape that mean', () => {
    expect(parentOf(times(8, [R.gas, SHAPE_FULL, MIST]))).toEqual({ role: R.gas, shape: SHAPE_FULL, material: MIST, wetness: 0 });
    expect(parentOf(times(8, [R.gas, 6, MIST]))).toMatchObject({ role: R.gas, shape: 6 });
    // Half the cells at full density: half the density.
    expect(parentOf(of(...times(4, [R.gas, SHAPE_FULL, MIST])))).toMatchObject({ role: R.gas, shape: 8 });
    // Densities 1 … 8: their sum 36, the mean 4.5, rounded 5.
    expect(parentOf([1, 2, 3, 4, 5, 6, 7, 8].map((d): Cell => [R.gas, d, MIST]))).toMatchObject({ role: R.gas, shape: 5 });
    // Round the rounding point: a summed density of 3 (mean 0.375) leaves air, of 4 (mean 0.5) a gas of 1.
    expect(parentOf(of([R.gas, 3, MIST]))).toEqual(nothing);
    expect(parentOf(of([R.gas, 2, MIST], [R.gas, 1, MIST]))).toEqual(nothing);
    expect(parentOf(of([R.gas, 4, MIST]))).toMatchObject({ role: R.gas, shape: 1 });
    expect(parentOf(of([R.gas, 2, MIST], [R.gas, 2, SMOKE]))).toMatchObject({ role: R.gas, shape: 1 });
    // Two gases: the one of more cells is the parent's material.
    expect(parentOf(of(...times(5, [R.gas, 8, SMOKE]), ...times(3, [R.gas, 8, MIST]))).material).toBe(SMOKE);
  });

  it('leaves the parent what it is without the gas wherever a solid, a liquid or an opening holds it', () => {
    const cases: Array<[string, Cell[]]> = [
      ['ground under gas', of(...times(4, [R.terrain, SHAPE_FULL, MAT.grass]))],
      ['one cell of ground', of([R.terrain, SHAPE_FULL, MAT.rock])],
      ['a thin wall', of(...times(4, [R.wall, SHAPE_FULL, MAT.stone]))],
      ['a floor slab', of(...times(4, [R.floor, SHAPE_FULL, MAT.plank]))],
      ['water under gas', of(...times(4, [R.liquid, SHAPE_FULL, MAT.water]))],
      ['a little water', of([R.liquid, 9, MAT.water])],
      ['a doorway', of(...times(4, [R.opening, SHAPE_FULL, MAT.timber]))],
    ];
    for (const [name, cells] of cases) {
      const clean = parentOf(cells);
      expect(clean.role, `${name}: holds without gas`).not.toBe(R.air);
      const filled = cells.map((c): Cell => (c === none ? [R.gas, SHAPE_FULL, MIST] : c));
      expect(parentOf(filled), name).toEqual(clean);
    }
    // Ground too thin to hold the parent, and water too shallow: gas holds it, as it would hold the air there.
    expect(parentOf(of([R.terrain, 2, MAT.rock]))).toEqual(nothing);
    expect(parentOf([[R.terrain, 2, MAT.rock], ...times(7, [R.gas, 8, MIST])])).toMatchObject({ role: R.gas, shape: 7, material: MIST });
    expect(parentOf(of([R.liquid, 3, MAT.water]))).toEqual(nothing);
    expect(parentOf([[R.liquid, 3, MAT.water], ...times(7, [R.gas, 8, MIST])])).toMatchObject({ role: R.gas, shape: 7, material: MIST });
  });
});

describe('the feeds rule for gas: what one cell\'s change makes stale', () => {
  const rock = recordValue(MAT.rock, R.terrain, SHAPE_FULL, 0);
  const water = recordValue(MAT.water, R.liquid, SHAPE_FULL, 0);
  const geometry = DERIVED_PART.mesh | DERIVED_PART.collision | DERIVED_PART.nav | DERIVED_PART.light;

  it('feeds the gas part alone for a change only between air and gas, or of a gas cell\'s density or material', () => {
    expect(DERIVED_PART.gas).toBe(64);
    expect(changeFeeds(0, gas())).toBe(DERIVED_PART.gas);
    expect(changeFeeds(gas(), 0)).toBe(DERIVED_PART.gas);
    expect(changeFeeds(gas(15), gas(4))).toBe(DERIVED_PART.gas);
    expect(changeFeeds(gas(9, MIST), gas(9, SMOKE))).toBe(DERIVED_PART.gas);
    expect(changeFeeds(gas(), gas())).toBe(0);
    // Water replaced by gas, or gas by water: both media's parts, nothing else.
    expect(changeFeeds(water, gas())).toBe(DERIVED_PART.liquid | DERIVED_PART.gas);
    expect(changeFeeds(gas(), water)).toBe(DERIVED_PART.liquid | DERIVED_PART.gas);
    // Liquid alone stays the liquid part alone.
    expect(changeFeeds(0, water)).toBe(DERIVED_PART.liquid);
  });

  it('feeds the gas part besides what it fed before for a change of a cell that is no medium (ground dug beside fog bares its side)', () => {
    expect(changeFeeds(rock, 0)).toBe(geometry | DERIVED_PART.shader | DERIVED_PART.liquid | DERIVED_PART.gas);
    expect(changeFeeds(rock, gas()) & (geometry | DERIVED_PART.gas)).toBe(geometry | DERIVED_PART.gas);
    // A material or wetness change of ground: the shader data alone (a gas wears its own material).
    expect(changeFeeds(rock, recordValue(MAT.sand, R.terrain, SHAPE_FULL, 0))).toBe(DERIVED_PART.shader);
    expect(changeFeeds(rock, recordValue(MAT.rock, R.terrain, SHAPE_FULL, 4))).toBe(DERIVED_PART.shader);
  });

  it('reports a stroke\'s parts by its cells: gas strokes of every kind the gas part alone, mixed strokes both', () => {
    const s = createWorldStore(grid);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 2; y++) s.setVoxel(x, y, z, { material: MAT.rock, role: R.terrain, shape: SHAPE_FULL, wetness: 0 });
    const run = (c: Record<string, unknown>): number => applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, ...c })).parts;
    const mist = { material: MIST, role: R.gas, wetness: 0 };
    const bank: number[] = [];
    for (let x = 4; x < 12; x++) for (let z = 4; z < 12; z++) for (let y = 2; y < 5; y++) bank.push(x, y, z);
    // A bank set on the ground at a density, thinned, repainted another gas, added to with a brush, dug away.
    expect(run({ kind: 'set', cells: bank, voxel: { ...mist, shape: 12 } })).toBe(DERIVED_PART.gas);
    expect(run({ kind: 'set', cells: bank.slice(0, 30), voxel: { ...mist, shape: 3 } })).toBe(DERIVED_PART.gas);
    expect(run({ kind: 'fill', min: [4, 2, 4], max: [11, 4, 11], mode: 'paint', voxel: { ...mist, material: SMOKE } })).toBe(DERIVED_PART.gas);
    expect(run({ kind: 'brush', shape: 'sphere', size: [3, 3, 3], points: [8, 6, 8], mode: 'add', smooth: true, voxel: mist })).toBe(DERIVED_PART.gas);
    expect(run({ kind: 'dig', cells: [4, 2, 4, 5, 2, 4] })).toBe(DERIVED_PART.gas);
    // A dig through the bank into the ground under it: what a dig of ground feeds, the gas part with it.
    const mixed = run({ kind: 'fill', min: [6, 1, 6], max: [7, 3, 7], mode: 'dig' });
    expect(mixed & (geometry | DERIVED_PART.gas)).toBe(geometry | DERIVED_PART.gas);
    const v = { ...AIR };
    expect(s.voxelAt(9, 3, 9, v).role).toBe(R.gas);
  });
});

describe('the level fill passes a gas as it passes air', () => {
  it('fills a basin that holds fog to the same cells as the empty basin', () => {
    const cells = new Map<string, number>();
    const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
    // A box of ground 12 × 12 with a hollow 8 × 8 and 4 deep.
    const ground = recordValue(MAT.rock, R.terrain, SHAPE_FULL, 0);
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < 6; y++) if (y < 2 || x < 2 || x >= 10 || z < 2 || z >= 10) cells.set(key(x, y, z), ground);
    const world = { value: (x: number, y: number, z: number): number => (x < 0 || x >= 12 || z < 0 || z >= 12 || y < 0 ? -1 : (cells.get(key(x, y, z)) ?? 0)) };
    const spec = { seed: [5, 2, 5] as const, level: 4.5, material: MAT.water, reach: 32 };
    const empty = levelFill(spec, world);
    expect(empty.status).toBe('filled');
    expect(empty.cells.length / 3).toBe(8 * 8 * 3);
    for (let x = 2; x < 10; x++) for (let z = 2; z < 6; z++) for (let y = 2; y < 6; y++) cells.set(key(x, y, z), gas(1 + ((x + y + z) % 15)));
    const fogged = levelFill(spec, world);
    expect(fogged.status).toBe('filled');
    expect([...fogged.cells]).toEqual([...empty.cells]);
    expect([...fogged.values]).toEqual([...empty.values]);
  });
});

/** A CRC-free digest of views' bytes in turn. */
function digestOf(...a: Array<ArrayBufferView | null | undefined>): string {
  const h = createHash('sha256');
  for (const v of a) {
    if (v == null) h.update('-');
    else h.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    h.update('|');
  }
  return h.digest('hex').slice(0, 16);
}

/** Each consumer's bytes of a derived section: what gas written into its open cells must leave as they are. */
function consumerDigests(d: DerivedData | null): Record<string, string> {
  if (d === null) return { none: '' };
  const occ = d.occupancy;
  return {
    mesh: digestOf(d.ground.vertices, d.ground.indices, d.base.vertices, d.base.indices, d.instances.data),
    collision: digestOf(d.collision.boxes, d.collision.ramps.vertices, d.collision.ramps.indices, new Uint32Array([d.collision.fullBoxes])),
    'navigation (the walk graph\'s input)': digestOf(d.nav.blocks, d.nav.standable, d.nav.clearance, new Uint32Array([d.nav.blocking])),
    'light stop': digestOf(d.light.full, d.light.partialCells, d.light.partialCover, new Int32Array([d.light.uniform])),
    occupancy: digestOf(occ.bricks, occ.mask, new Uint32Array([occ.flag])),
    'open regions and sky columns': d.regions == null ? '' : digestOf(...openRegionsArrays(d.regions), new Int32Array([d.regions.count, d.regions.connect, d.regions.skyUniform])),
    'shader data': digestOf(encodeShader(d.shader)),
    'liquid part': digestOf(d.liquid?.quads),
  };
}

const SECTION_IDS = Array.from({ length: 8 }, (_, i) => i);
type Box = { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };

/** Every derive section of the box's chunks (world rules), by `sx,sy,sz`. */
function sectionsOf(store: PaletteStore, box: Box): Map<string, DerivedData | null> {
  const out = new Map<string, DerivedData | null>();
  const pad = jobRadius(WORLD_RULES);
  for (let cx = box.min[0]; cx <= box.max[0]; cx++) for (let cy = box.min[1]; cy <= box.max[1]; cy++) for (let cz = box.min[2]; cz <= box.max[2]; cz++) {
    for (const r of deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, pad), (o) => store.exportChunk(cx, cy, cz, o), 16, SECTION_IDS)) {
      const [lx, ly, lz] = sectionLocalOrigin(E, 16, r.id);
      out.set(`${cx * 2 + lx / 16},${cy * 2 + ly / 16},${cz * 2 + lz / 16}`, r.assembly);
    }
  }
  return out;
}

/** The walk graph over derived sections: every chunk's standable cells, pieces and exits, as one digest, with its counts. */
function walkGraphOf(sections: Map<string, DerivedData | null>, box: Box): { digest: string; cells: number; pieces: number; exits: number } {
  const view: WalkGraphView = {
    grid,
    sections: { edge: 16, shift: 4, mask: 15 } as never,
    derivedOf: (sx, sy, sz) => {
      const a = sections.get(`${sx},${sy},${sz}`);
      return a === undefined ? null : ({ assembly: a } as DeriveOutput);
    },
  };
  const g = new WalkGraph(view, 0.5);
  for (let cx = box.min[0]; cx <= box.max[0]; cx++) for (let cy = box.min[1]; cy <= box.max[1]; cy++) for (let cz = box.min[2]; cz <= box.max[2]; cz++) g.touch(cx, cy, cz);
  g.update();
  const h = createHash('sha256');
  const parts = [...g.parts()].sort((a, b) => a.key - b.key);
  for (const c of parts) {
    h.update(`${c.cx},${c.cy},${c.cz}:${c.pieces.length};`);
    for (const a of [c.colStart, c.ys, c.col, c.clear, c.wide, c.piece]) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    for (let p = 0; p < c.pieces.length; p++) for (const e of g.exitsOf(c, p)) h.update(`${e.fromPiece}>${e.to.cx},${e.to.cy},${e.to.cz}/${e.toPiece}@${e.a},${e.b}:${e.cost.toFixed(4)};`);
  }
  const s = g.stats();
  return { digest: h.digest('hex').slice(0, 16), cells: s.cells, pieces: s.pieces, exits: s.exits };
}

/** A copy of a store. */
function copyOf(store: PaletteStore): PaletteStore {
  const out = createWorldStore(grid);
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    out.adoptPayload(c.cx, c.cy, c.cz, store.chunkPayload(c.cx, c.cy, c.cz, true));
  }
  return out;
}

const hash3 = (x: number, y: number, z: number): number => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;

/**
 * Gas written into the open cells (plain air: not an opening's) of a box of cells under `top`: banks 4 cells
 * across with gaps between them (so gas meets air, ground, walls, water and the box's sides), each cell at a
 * density of its own, two materials. Returns the cells written and what they touch.
 */
function fog(store: PaletteStore, lo: readonly [number, number, number], hi: readonly [number, number, number]): { cells: number; overWater: number; onGround: number; byWalls: number; underCover: number } {
  const v = { ...AIR };
  const n = { ...AIR };
  const count = { cells: 0, overWater: 0, onGround: 0, byWalls: 0, underCover: 0 };
  const put: number[] = [];
  for (let x = lo[0]; x < hi[0]; x++) for (let z = lo[2]; z < hi[2]; z++) {
    let cover = false;
    for (let y = hi[1] - 1; y >= lo[1]; y--) {
      store.voxelAt(x, y, z, v);
      if (v.material !== 0 || v.role !== 0) {
        if (isBodyRole(v.role)) cover = true;
        continue;
      }
      if (hash3(x >> 2, y >> 2, z >> 2) % 5 === 0) continue;
      put.push(x, y, z);
      count.cells++;
      if (cover) count.underCover++;
      store.voxelAt(x, y - 1, z, n);
      if (n.material !== 0 && isLiquidRole(n.role)) count.overWater++;
      if (n.material !== 0 && n.role === R.terrain) count.onGround++;
      store.voxelAt(x + 1, y, z, n);
      if (n.material !== 0 && n.role === R.wall) count.byWalls++;
    }
  }
  for (let k = 0; k < put.length; k += 3) {
    const [x, y, z] = [put[k]!, put[k + 1]!, put[k + 2]!];
    store.setVoxel(x, y, z, { material: (x >> 3) & 1 ? MIST : SMOKE, role: R.gas, shape: 1 + (hash3(x, y, z) % 15), wetness: 0 });
  }
  return count;
}

/** A level's nodes over a chunk box. */
function nodesOver(box: Box, level: number): Array<{ level: number; nx: number; ny: number; nz: number }> {
  const out: Array<{ level: number; nx: number; ny: number; nz: number }> = [];
  for (let nx = box.min[0] >> level; nx <= box.max[0] >> level; nx++) for (let ny = box.min[1] >> level; ny <= box.max[1] >> level; ny++) for (let nz = box.min[2] >> level; nz <= box.max[2] >> level; nz++) out.push({ level, nx, ny, nz });
  return out;
}

/** The far ground's tops over a column of level-2 nodes, read from their stored bytes as the worker reads them. */
function groundTops(tree: MipTree, nx: number, nz: number, nys: readonly number[]): Float32Array {
  const nodes: Array<{ ny: number; bytes: { stored: Uint8Array; raw: boolean } | { uniform: number } }> = [];
  for (const ny of nys) {
    const cells = tree.node({ level: 2, nx, ny, nz });
    const bytes = cells === null ? null : encodeDenseChunk(grid, cells);
    nodes.push({ ny, bytes: bytes === null ? { uniform: 0 } : { stored: bytes, raw: true } });
  }
  return farGroundTops({ edge: E, level: 2, nodes }, (b) => b).tops;
}

interface WorldCase {
  readonly name: string;
  readonly store: PaletteStore;
  /** The chunks compared. */
  readonly box: Box;
  /** The cells gas is written into (inclusive, exclusive). */
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
  /** Whether the mesh rings' nodes and the far field are compared too (once is enough: they read the coarser levels' cells, compared for every case). */
  readonly far: boolean;
}

function worldCases(): WorldCase[] {
  const town = createWorldStore(grid);
  loadAreaCached(townWorld({ footprint: 128 }).grids[0]!, town, 0, 0, 128, 128);
  const row = createWorldStore(grid);
  // The arch and the cave of the hard-case row (pads 7 and 8, a pad 64 cells wide), with the pads beside them.
  loadAreaCached(featuresWorld().grids[0]!, row, 5 * FEATURE_PAD, 0, 10 * FEATURE_PAD, FEATURE_PAD);
  return [
    // Ground at y 0, ponds below it, houses of 6-cell storeys: gas from the ponds' rims up into the upper floors.
    { name: 'town', store: town, box: { min: [0, -1, 0], max: [2, 0, 2] }, lo: [0, -4, 0], hi: [96, 16, 96], far: true },
    { name: 'hard cases (arch, cave)', store: row, box: { min: [14, 0, 0], max: [17, 0, 1] }, lo: [7 * FEATURE_PAD, 0, 0], hi: [9 * FEATURE_PAD, 30, FEATURE_PAD], far: false },
  ];
}

describe('a world with gas derives as the same world without it', () => {
  it('gives the same meshes, collision, navigation and walk graph, light stop, occupancy, open regions, sky columns, shader data and liquid faces; the same coarser levels wherever anything else holds; the same far faces and far ground', { timeout: 240_000 }, () => {
    const report: Record<string, unknown> = {};
    for (const w of worldCases()) {
      const clean = w.store;
      const fogged = copyOf(clean);
      const wrote = fog(fogged, w.lo, w.hi);
      expect(wrote.cells, `${w.name}: gas cells`).toBeGreaterThan(20_000);

      // Level 0, by derive section, a consumer at a time.
      const a = sectionsOf(clean, w.box);
      const b = sectionsOf(fogged, w.box);
      const differing: Record<string, string[]> = {};
      let compared = 0;
      for (const [key, d] of a) {
        const x = consumerDigests(d);
        const y = consumerDigests(b.get(key) ?? null);
        expect(Object.keys(y), `${w.name} ${key}`).toEqual(Object.keys(x));
        for (const k of Object.keys(x)) if (x[k] !== y[k]) (differing[k] ??= []).push(key);
        if (d !== null) compared++;
      }
      expect(differing, `${w.name}: sections whose bytes differ, by consumer`).toEqual({});
      expect(compared, `${w.name}: sections compared`).toBeGreaterThan(40);

      // The walk graph made from those sections.
      const walkA = walkGraphOf(a, w.box);
      const walkB = walkGraphOf(b, w.box);
      expect(walkA.cells, `${w.name}: standable cells`).toBeGreaterThan(1000);
      expect(walkB, `${w.name}: walk graph`).toEqual(walkA);

      // The coarser levels: a cell that is anything without the gas is the same with it; one that is air is air or gas.
      const treeA = new MipTree(clean);
      const treeB = new MipTree(fogged);
      const kept: number[] = [];
      for (const level of [1, 2, 3]) {
        let gasCells = 0;
        for (const n of nodesOver(w.box, level)) {
          const x = treeA.node(n);
          const y = treeB.node(n);
          const under = level === 1 ? null : treeB.level(level - 1);
          const child = { ...AIR };
          for (let i = 0; i < grid.cellsPerChunk; i++) {
            const m = x === null ? 0 : x.material[i]!;
            if (m !== 0 || (x !== null && x.role[i] !== 0)) {
              if (y === null || y.material[i] !== m || y.role[i] !== x!.role[i] || y.shape[i] !== x!.shape[i] || y.wetness[i] !== x!.wetness[i]) expect.fail(`${w.name} level ${level} node ${n.nx},${n.ny},${n.nz} cell ${i}: ${cellText(x!, i)} without gas, ${y === null ? 'air' : cellText(y, i)} with it`);
              continue;
            }
            if (y === null || y.material[i] === 0) continue;
            if (!isGasRole(y.role[i]!)) expect.fail(`${w.name} level ${level} node ${n.nx},${n.ny},${n.nz} cell ${i}: air without gas, ${cellText(y, i)} with it`);
            gasCells++;
            if (y.wetness[i] !== 0) expect.fail(`${w.name} level ${level}: a coarse gas cell with wetness`);
            // Its density is the mean of the gas under it (the level below's 8 cells), rounded; checked a cell in 7.
            if (under === null || i % 7 !== 0) continue;
            const lx = Math.floor(i / (E * E));
            const lz = Math.floor(i / E) % E;
            const ly = i % E;
            let sum = 0;
            for (let c = 0; c < 8; c++) {
              under.voxelAt(2 * (n.nx * E + lx) + (c & 1), 2 * (n.ny * E + ly) + ((c >> 1) & 1), 2 * (n.nz * E + lz) + ((c >> 2) & 1), child);
              if (child.material !== 0 && isGasRole(child.role)) sum += child.shape;
            }
            if (y.shape[i] !== Math.round(sum / 8) || y.shape[i] === 0) expect.fail(`${w.name} level ${level} cell ${i}: density ${y.shape[i]}, the gas under it sums to ${sum}`);
          }
        }
        kept.push(gasCells);
      }
      // Gas thick enough is kept in the 1 m level; the far levels still hold what they held.
      expect(kept[0], `${w.name}: gas cells kept at level 1`).toBeGreaterThan(1000);

      report[w.name] = { ...wrote, sections: compared, walk: walkA, gasKeptByLevel: kept };
      if (!w.far) continue;

      // The mesh rings' nodes and the far field's faces and ground.
      let nodes = 0;
      for (const level of [1, 2]) for (const n of nodesOver(w.box, level)) {
        const x = consumerDigests(deriveMipNode(treeA, n, WORLD_RULES));
        const y = consumerDigests(deriveMipNode(treeB, n, WORLD_RULES));
        expect(y, `${w.name} level ${level} node ${n.nx},${n.ny},${n.nz}`).toEqual(x);
        nodes++;
      }
      let faces = 0;
      // Every 2 m node over the box (the far cache's finest level), and the 1 m nodes of its first corner.
      for (const scale of [2, 4]) for (const n of nodesOver(w.box, Math.log2(scale)).filter((k) => scale === 4 || (k.nx === w.box.min[0] >> 1 && k.nz === w.box.min[2] >> 1))) {
        const x = farBricksFromFaces(grid, clean, [n.nx, n.ny, n.nz], scale);
        const y = farBricksFromFaces(grid, fogged, [n.nx, n.ny, n.nz], scale);
        expect(digestOf(y.samples, y.looks, y.bricks, y.blocks, y.bounds), `${w.name} far faces ×${scale} ${n.nx},${n.ny},${n.nz}`).toBe(digestOf(x.samples, x.looks, x.bricks, x.blocks, x.bounds));
        faces += x.samples.length;
      }
      expect(faces, `${w.name}: far brick samples`).toBeGreaterThan(0);
      let tops = 0;
      for (const n of nodesOver({ min: [w.box.min[0], 0, w.box.min[2]], max: [w.box.max[0], 0, w.box.max[2]] }, 2)) {
        const x = groundTops(treeA, n.nx, n.nz, [-1, 0]);
        const y = groundTops(treeB, n.nx, n.nz, [-1, 0]);
        expect(digestOf(y), `${w.name} far ground ${n.nx},${n.nz}`).toBe(digestOf(x));
        tops += x.reduce((s, t) => s + (Number.isNaN(t) ? 0 : 1), 0);
      }
      expect(tops, `${w.name}: far ground columns with a top`).toBeGreaterThan(0);
      report[w.name] = { ...wrote, sections: compared, walk: walkA, gasKeptByLevel: kept, mipNodes: nodes, farGroundColumns: tops };
    }
    // A structure stamp reads a gas cell as open, and the sum of what the two worlds touch covers the cases named.
    expect(stampClassOfValue(gas())).toBe(STAMP_CLASS.open);
    const town = report['town'] as ReturnType<typeof fog>;
    const row = report['hard cases (arch, cave)'] as ReturnType<typeof fog>;
    expect(town.overWater, 'gas over water').toBeGreaterThan(50);
    expect(town.onGround, 'gas on the ground').toBeGreaterThan(1000);
    expect(town.byWalls, 'gas against walls').toBeGreaterThan(100);
    expect(town.underCover, 'gas in rooms').toBeGreaterThan(1000);
    expect(row.underCover, 'gas under the arch and in the cave').toBeGreaterThan(1000);
    console.log(`[gas] ${JSON.stringify(report)}`);
  });
});

function cellText(c: DenseChunk, i: number): string {
  return `material ${c.material[i]} role ${roleTraits(c.role[i]!).name} shape ${c.shape[i]} wetness ${c.wetness[i]}`;
}
