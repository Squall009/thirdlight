/**
 * The made world the ground cover tests grow on, as a function of a cell: a
 * rolling meadow with two road strips, a pond, a dry-grass variant, a hill
 * of stone with a wet cave and a two-storey house; its materials and the
 * dressings they name. Test data, written into a chunk store a chunk at a
 * time.
 */
import { chunkGrid, createDenseChunk, createWorldStore, localIndex, recordValue, SHAPE_FULL, valueMaterial, valueRole, valueShape, valueWetness, VOXEL_ROLE, type PaletteStore, type SurfaceCells } from '@thirdlight/voxel';
import { voxelCoverTable, type DressingDef } from '@thirdlight/project-model';

export const grid = chunkGrid(32);
export const E = grid.edge;
export const M = 0.5;
export const R = VOXEL_ROLE;
/** The world: four chunks a side, two rows of them. */
export const SIDE = 4 * E;
export const HIGH = 2 * E;

export const GRASS = 3;
export const DRY = 4;
export const STONE = 5;
export const ROAD = 6;
export const BOARDS = 7;
export const PLASTER = 8;
export const TILES = 9;
export const WATER = 20;

/** A bowl three metres deep, its water standing 0.2 m over the bowl's rim on a ring of flat ground round it. */
export const POND = { x: 88, z: 20, r: 9, rim: 9, level: 9.4, shore: 12 };
/** A hill of stone whose top cells are the last row of the lower chunks: its top face lies on the chunk border. */
export const HILL = { x0: 8, x1: 40, z0: 40, z1: 72, top: 32 };
export const CAVE = { x0: 14, x1: 34, z0: 46, z1: 66, floor: 8, roof: 16, wetTo: 24 };
/** A house whose upper storey's floor is in the upper chunks. */
export const HOUSE = { x0: 100, x1: 116, z0: 60, z1: 76, ground: 9, storey: 33, roof: 40 };
/** The road's two strips (columns, first and past the last): the first begins a search's reach past the border between chunk columns 0 and 1. */
export const ROADS: readonly (readonly [number, number])[] = [[48, 51], [70, 76]];

/** An edit some tests make: a square of the dry meadow in chunk (3, 3) repaved as road. */
export const PAVED = { x0: 108, x1: 116, z0: 108, z1: 116 };

/** The made world's cell at (x, y, z), `paved`: with the repaved square. */
export function cell(x: number, y: number, z: number, paved = false): number {
  const ground = (material: number, shape = SHAPE_FULL, wetness = 0): number => recordValue(material, R.terrain, shape, wetness);
  if (x >= HILL.x0 && x < HILL.x1 && z >= HILL.z0 && z < HILL.z1) {
    if (y >= HILL.top) return 0;
    const hollow = x >= CAVE.x0 && x < CAVE.x1 && z >= CAVE.z0 && z < CAVE.z1;
    if (hollow && y > CAVE.floor && y < CAVE.roof) return 0;
    return ground(STONE, SHAPE_FULL, hollow && y === CAVE.floor && x < CAVE.wetTo ? 4 : 0);
  }
  const inHouse = x >= HOUSE.x0 && x < HOUSE.x1 && z >= HOUSE.z0 && z < HOUSE.z1;
  if (inHouse) {
    if (y < HOUSE.ground) return ground(GRASS);
    if (y === HOUSE.roof) return recordValue(TILES, R.roof, SHAPE_FULL, 0);
    if (y > HOUSE.roof) return 0;
    if (y === HOUSE.storey) return recordValue(BOARDS, R.floor, SHAPE_FULL, 0);
    const wall = x === HOUSE.x0 || x === HOUSE.x1 - 1 || z === HOUSE.z0 || z === HOUSE.z1 - 1;
    return wall ? recordValue(PLASTER, R.wall, SHAPE_FULL, 0) : 0;
  }
  const d = Math.hypot(x - POND.x, z - POND.z);
  if (d < POND.shore) {
    const bed = POND.rim - 6 * Math.max(0, 1 - d / POND.r);
    const whole = Math.floor(bed + 1e-9);
    if (y < whole) return ground(GRASS);
    const part = Math.round((bed - whole) * SHAPE_FULL);
    if (y === whole && part > 0) return ground(GRASS, part);
    const top = Math.floor(POND.level);
    return y < top ? recordValue(WATER, R.liquid, SHAPE_FULL, 0) : y === top ? recordValue(WATER, R.liquid, Math.round((POND.level - top) * SHAPE_FULL), 0) : 0;
  }
  // Flat round the house, rolling elsewhere.
  const nearHouse = x >= HOUSE.x0 - 2 && x < HOUSE.x1 + 2 && z >= HOUSE.z0 - 2 && z < HOUSE.z1 + 2;
  const h = nearHouse ? HOUSE.ground : 9 + 1.5 * Math.sin(x / 11) + 1.5 * Math.cos(z / 13);
  const road = ROADS.some(([a, b]) => x >= a && x < b) || (paved && x >= PAVED.x0 && x < PAVED.x1 && z >= PAVED.z0 && z < PAVED.z1);
  const material = road ? ROAD : z >= 96 ? DRY : GRASS;
  const whole = Math.floor(h + 1e-9);
  if (y < whole) return ground(material);
  const part = Math.round((h - whole) * SHAPE_FULL);
  return y === whole && part > 0 ? ground(material, part) : 0;
}

/** The world's chunk (cx, cy, cz) written into a store from the cell function. */
export function writeChunk(store: PaletteStore, cx: number, cy: number, cz: number, paved = false): void {
  const d = createDenseChunk(grid);
  for (let lx = 0; lx < E; lx++) for (let ly = 0; ly < E; ly++) for (let lz = 0; lz < E; lz++) {
    const v = cell(cx * E + lx, cy * E + ly, cz * E + lz, paved);
    const i = localIndex(grid, lx, ly, lz);
    d.material[i] = valueMaterial(v);
    d.role[i] = valueRole(v);
    d.shape[i] = valueShape(v);
    d.wetness[i] = valueWetness(v);
  }
  store.importChunk(cx, cy, cz, d);
}

export function world(paved = false): PaletteStore {
  const store = createWorldStore(grid);
  for (let cx = 0; cx < 4; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 4; cz++) writeChunk(store, cx, cy, cz, paved);
  return store;
}

/** The whole world as one box of cells (what one bake over every chunk reads). */
export function wholeBox(): SurfaceCells {
  const values = new Uint32Array(SIDE * HIGH * SIDE);
  for (let x = 0; x < SIDE; x++) for (let z = 0; z < SIDE; z++) for (let y = 0; y < HIGH; y++) values[(x * SIDE + z) * HIGH + y] = cell(x, y, z);
  return { sx: SIDE, sy: HIGH, sz: SIDE, ox: 0, oy: 0, oz: 0, cellM: M, values, built: null };
}

export const material = (materialId: string, voxel: Record<string, unknown>, instanceOf?: string): Record<string, unknown> => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, ...(instanceOf !== undefined ? { instanceOf } : {}), voxel });
export const MATERIALS = [
  material('grass', { id: GRASS, use: 'terrain', dressing: 'meadow' }),
  // A variant of the grass: the same ground, a sparser dressing.
  material('grass-dry', { id: DRY, dressing: 'meadow-sparse' }, 'grass'),
  material('stone', { id: STONE, use: 'terrain', dressing: 'cave' }),
  material('road', { id: ROAD, use: 'terrain' }),
  material('boards', { id: BOARDS, use: 'construction', dressing: 'dust' }),
  material('plaster', { id: PLASTER, use: 'construction' }),
  material('tiles', { id: TILES, use: 'construction' }),
  material('water', { id: WATER, use: 'liquid' }),
];
export const GRASS_SPECIES = 0;
export const OAK_SPECIES = 1;
export const REED_SPECIES = 2;
export const FLOWER_SPECIES = 3;
export const CLOVER_SPECIES = 4;
export const THISTLE_SPECIES = 5;
export const DRESSINGS: DressingDef[] = [
  { dressingFormat: 1, dressingId: 'cave', name: 'Cave', species: [{ model: 'moss', class: 'cover', density: 3, conditions: { sky: false, wetness: { min: 2 } } }, { model: 'lichen', class: 'cover', density: 1, conditions: { sky: true } }] },
  { dressingFormat: 1, dressingId: 'dust', name: 'Dust', species: [{ model: 'dust', class: 'cover', density: 2, conditions: { role: ['floor'], sky: false } }] },
  {
    dressingFormat: 1,
    dressingId: 'meadow',
    name: 'Meadow',
    species: [
      { model: 'grass', class: 'cover', density: 4, scale: [0.8, 1.2], conditions: { slope: { max: 40 }, sky: true, waterDepth: { max: 0 } } },
      { model: 'oak', class: 'large', density: 0.02, spacing: 6, conditions: { sky: true } },
      { model: 'reed', class: 'cover', density: 2, spacing: 0.4, conditions: { waterDepth: { min: 0.05, max: 0.5 } } },
      { model: 'flower', class: 'cover', density: 1, spacing: 1, seed: 4, conditions: { sky: true, waterDepth: { max: 0 }, materialEdge: { max: 1.5 } } },
      // In patches with soft edges: a share of the candidates is kept where the noise fades.
      { model: 'clover', class: 'cover', density: 2, conditions: { sky: true, waterDepth: { max: 0 }, noise: { min: 0.45, scale: 7, fade: 0.25, seed: 2 } } },
      // Spaced, and only far from any other material: judged at the end of the fields' reach.
      { model: 'thistle', class: 'cover', density: 1, spacing: 2, conditions: { sky: true, waterDepth: { max: 0 }, materialEdge: { min: 7.8 } } },
    ],
  },
  { dressingFormat: 1, dressingId: 'meadow-sparse', name: 'Sparse meadow', species: [{ model: 'grass', class: 'cover', density: 1, conditions: { sky: true } }] },
];
export const TABLE = voxelCoverTable({ materials: MATERIALS as never, dressings: DRESSINGS });
