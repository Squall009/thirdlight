/**
 * The dense-town test world: a grid of 20 m lots on flat ground, each with a
 * house of 0.5 m walls (one cell), floors, stairs, a 45° gable roof with
 * overhangs, door and window openings, beams one cell out at the storey
 * lines, and on some houses a balcony with an open banister (posts every
 * other cell under a continuous rail). Some lots have a fence (thin rails),
 * some a pond (liquid with a partly filled surface), and some hold a house
 * in its own rotated grid (a structure's local chunk set at 30° or 45°),
 * leaving the world grid's lot empty.
 *
 * The thin features are stored as plain construction voxels: whether a run
 * reads as a wall, a beam or a banister is for assembly rules to infer from
 * the arrangement, which is exactly what the storage must carry cheaply.
 */
import { latticeHash } from '@thirdlight/shared';
import { type ChunkGrid, type DenseChunk, localIndex, SHAPE_FULL, VOXEL_ROLE, type VoxelRecord } from '@thirdlight/voxel';
import { MAT, fillGroundColumn, shapeByte, type GroundColumn, type TestGrid, type TestWorld } from './world-kit';

/** Lot pitch in cells (20 m). */
const LOT = 40;
/** Storey height in cells (3 m). */
const STOREY = 6;
/** Where a house's footprint starts inside its lot. */
const HOUSE_AT_X = 6;
const HOUSE_AT_Z = 8;

const WALL_MATERIALS = [MAT.stone, MAT.timber, MAT.plaster, MAT.brick] as const;

/** One house's parameters (cells, house-local: the footprint is x in [0, w), z in [0, d)). */
export interface House {
  w: number;
  d: number;
  storeys: number;
  wall: number;
  balcony: boolean;
}

/** What a lot holds. */
interface Lot {
  house: House | null;
  /** Yaw of a house standing in its own grid (0: in the world grid). */
  yaw: number;
  fence: boolean;
  pond: boolean;
}

function lotOf(i: number, j: number, seed: number): Lot {
  const h = latticeHash(i, j, seed);
  const pick = (shift: number, n: number): number => (h >>> shift) % n;
  const kind = pick(0, 24);
  const pond = kind === 0 || kind === 1;
  const yaw = kind === 2 ? 30 : kind === 3 ? 45 : 0;
  const storeys = 1 + pick(5, 3);
  const house: House | null = pond
    ? null
    : { w: 16 + 2 * pick(8, 7), d: 16 + 2 * pick(11, 7), storeys, wall: WALL_MATERIALS[pick(14, 4)]!, balcony: storeys >= 2 && pick(17, 2) === 0 };
  return { house, yaw, fence: pick(19, 3) === 0, pond };
}

function set(out: VoxelRecord, material: number, role: number, wetness = 0, shape = SHAPE_FULL): true {
  out.material = material;
  out.role = role;
  out.shape = shape;
  out.wetness = wetness;
  return true;
}

/** Height of the roof's 45° surface over row z: one cell up per cell in from either eave. */
function roofRow(h: House, z: number): number {
  return h.storeys * STOREY + Math.min(z + 1, h.d - z);
}

/**
 * The house's voxel at a house-local cell into `out`, true when the house
 * has one there (false: leave what the ground or air already holds).
 */
export function houseVoxel(h: House, x: number, y: number, z: number, out: VoxelRecord): boolean {
  const { w, d } = h;
  const top = h.storeys * STOREY;
  const inFoot = x >= 0 && x < w && z >= 0 && z < d;
  const perimeter = inFoot && (x === 0 || x === w - 1 || z === 0 || z === d - 1);
  const mid = w >> 1;
  if (y === 0 && inFoot) return set(out, MAT.stone, VOXEL_ROLE.foundation);
  if (y >= 1 && y < top) {
    const s = Math.floor(y / STOREY);
    const lev = y % STOREY;
    if (perimeter) {
      const along = z === 0 || z === d - 1 ? x : z;
      const nearCorner = along < 2 || along > (z === 0 || z === d - 1 ? w : d) - 3;
      const door = z === 0 && (x === mid - 1 || x === mid) && lev >= 1 && lev <= 4 && (s === 0 || (s === 1 && h.balcony));
      const window = !nearCorner && (lev === 2 || lev === 3) && along % 6 >= 3 && along % 6 <= 4 && !(z === 0 && Math.abs(x - mid) < 3);
      // A door or window is an opening (its pieces drawn flush to the reveal), in the wall's material.
      if (door || window) return set(out, h.wall, VOXEL_ROLE.opening);
      return set(out, h.wall, VOXEL_ROLE.wall);
    }
    // Stairs up the x = 1, 2 strip: one cell up per cell along z, facing +z; the floor above has a hole over them.
    const stairStorey = s < h.storeys - 1;
    if (inFoot && (x === 1 || x === 2) && stairStorey && z === 2 + (lev - 1) && lev >= 1 && lev <= 5) return set(out, MAT.plank, VOXEL_ROLE.stair);
    if (inFoot && lev === 0 && !((x === 1 || x === 2) && z >= 2 && z <= 7)) return set(out, MAT.plank, VOXEL_ROLE.floor);
    if (lev === 0 && x >= 0 && x < w && (z === -1 || z === d) && !(h.balcony && s === 1 && z === -1)) return set(out, MAT.timber, VOXEL_ROLE.wall);
    if (h.balcony && s === 1 && lev <= 2) {
      const onSlab = x >= mid - 3 && x < mid + 3 && (z === -1 || z === -2);
      if (onSlab && lev === 0) return set(out, MAT.plank, VOXEL_ROLE.floor);
      const edge = onSlab && (z === -2 || x === mid - 3 || x === mid + 2);
      if (edge && lev === 2) return set(out, MAT.timber, VOXEL_ROLE.wall);
      if (edge && lev === 1 && ((x + z) & 1) === 0) return set(out, MAT.timber, VOXEL_ROLE.wall);
    }
    return false;
  }
  if (y >= top && z >= -1 && z <= d && x >= -1 && x <= w) {
    const r = roofRow(h, z);
    if (y === r) return set(out, MAT.roofTile, VOXEL_ROLE.roof);
    if ((x === 0 || x === w - 1) && z >= 0 && z < d && y < r) return set(out, h.wall, VOXEL_ROLE.wall);
  }
  return false;
}

/** A house's cell bounds in house-local cells (inclusive-exclusive), roof, beams and balcony included. */
function houseBounds(h: House): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [-1, 0, -3], max: [h.w + 1, roofRow(h, h.d >> 1) + 1, h.d + 1] };
}

/** A fence along the lot's edge: posts two cells tall every fourth cell, one rail at the top, a gap at the front. */
function fenceVoxel(x: number, y: number, z: number, out: VoxelRecord): boolean {
  const onEdge = (x === 1 || x === LOT - 2) && z >= 1 && z <= LOT - 2 ? true : (z === 1 || z === LOT - 2) && x >= 1 && x <= LOT - 2;
  if (!onEdge || y < 0 || y > 1) return false;
  if (z === 1 && x >= LOT / 2 - 3 && x <= LOT / 2 + 2) return false;
  const along = z === 1 || z === LOT - 2 ? x : z;
  if (y === 1 || along % 4 === 1) return set(out, MAT.timber, VOXEL_ROLE.wall);
  return false;
}

/** A round pond 8 cells across its radius, 3 cells deep with a partly filled top cell, behind a stone rim. */
function pondVoxel(x: number, y: number, z: number, out: VoxelRecord): boolean {
  const r = Math.hypot(x - LOT / 2 + 0.5, z - LOT / 2 + 0.5);
  if (r <= 8 && y >= -3 && y <= -1) return set(out, MAT.water, VOXEL_ROLE.liquid, 0, y === -1 ? shapeByte(0.78) : SHAPE_FULL);
  if (r > 8 && r <= 9.2 && y === 0) return set(out, MAT.stone, VOXEL_ROLE.wall);
  return false;
}

/** The dense town: one 256 m tile of 20 m lots by default (12 × 12 lots). */
export function townWorld(opts: { seed?: number; footprint?: number } = {}): TestWorld {
  const seed = opts.seed ?? 71;
  const footprint = opts.footprint ?? 512;
  const lots = Math.floor(footprint / LOT);
  const lotTable: Lot[] = [];
  for (let i = 0; i < lots; i++) for (let j = 0; j < lots; j++) lotTable.push(lotOf(i, j, seed));
  const lotAt = (i: number, j: number): Lot | undefined => (i >= 0 && j >= 0 && i < lots && j < lots ? lotTable[i * lots + j] : undefined);
  const ground: GroundColumn = { surface: 0, base: -128, top: MAT.grass, soilDepth: 4, liquidLevel: -Infinity };
  const tallest = Math.max(...lotTable.map((l) => (l.house === null ? 0 : houseBounds(l.house).max[1])));
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

  const world: TestGrid = {
    name: 'world',
    yawDeg: 0,
    originM: [0, 0, 0],
    bounds: { min: [0, ground.base, 0], max: [footprint, tallest + 1, footprint] },
    fill(grid: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean {
      const e = grid.edge;
      const x0 = cx << grid.shift;
      const y0 = cy << grid.shift;
      const z0 = cz << grid.shift;
      let any = false;
      for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
        const x = x0 + lx;
        const z = z0 + lz;
        const inside = x >= 0 && z >= 0 && x < footprint && z < footprint;
        if (inside) any = fillGroundColumn(grid, out, lx, lz, y0, ground) || any;
        else for (let ly = 0; ly < e; ly++) {
          const i = localIndex(grid, lx, ly, lz);
          out.material[i] = 0;
          out.role[i] = 0;
          out.shape[i] = 0;
          out.wetness[i] = 0;
        }
        if (!inside) continue;
        const i = Math.floor(x / LOT);
        const j = Math.floor(z / LOT);
        const lot = lotAt(i, j);
        if (lot === undefined) continue;
        const ax = x - i * LOT;
        const az = z - j * LOT;
        for (let ly = 0; ly < e; ly++) {
          const y = y0 + ly;
          if (y < -3 || y > tallest) continue;
          let hit = false;
          if (lot.pond) hit = pondVoxel(ax, y, az, v);
          else if (lot.house !== null && lot.yaw === 0) hit = houseVoxel(lot.house, ax - HOUSE_AT_X, y, az - HOUSE_AT_Z, v);
          if (!hit && lot.fence) hit = fenceVoxel(ax, y, az, v);
          if (!hit) continue;
          const idx = localIndex(grid, lx, ly, lz);
          out.material[idx] = v.material;
          out.role[idx] = v.role;
          out.shape[idx] = v.shape;
          out.wetness[idx] = v.wetness;
          any = true;
        }
      }
      return any;
    },
  };

  const grids: TestGrid[] = [world];
  for (let i = 0; i < lots; i++) for (let j = 0; j < lots; j++) {
    const lot = lotAt(i, j)!;
    if (lot.house === null || lot.yaw === 0) continue;
    const house = lot.house;
    const b = houseBounds(house);
    const hv: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    grids.push({
      name: `house-${i}-${j}-yaw${lot.yaw}`,
      yawDeg: lot.yaw,
      originM: [(i * LOT + HOUSE_AT_X) / 2, 0, (j * LOT + HOUSE_AT_Z) / 2],
      bounds: b,
      fill(grid, cx, cy, cz, out) {
        const e = grid.edge;
        let any = false;
        for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) for (let ly = 0; ly < e; ly++) {
          const idx = localIndex(grid, lx, ly, lz);
          const hit = houseVoxel(house, (cx << grid.shift) + lx, (cy << grid.shift) + ly, (cz << grid.shift) + lz, hv);
          out.material[idx] = hit ? hv.material : 0;
          out.role[idx] = hit ? hv.role : 0;
          out.shape[idx] = hit ? hv.shape : 0;
          out.wetness[idx] = hit ? hv.wetness : 0;
          any = hit || any;
        }
        return any;
      },
    });
  }

  return {
    name: 'town',
    description: `dense town ${footprint / 2} m square: ${lots * lots} lots of 20 m, houses of 1–3 storeys with 0.5 m walls, 45° roofs, openings, beams, balconies with banisters, fences, ponds; ${grids.length - 1} houses in their own 30°/45° grids`,
    seed,
    areaM2: footprint * footprint * 0.25,
    benchFootprint: Math.min(footprint, 512),
    grids,
  };
}
