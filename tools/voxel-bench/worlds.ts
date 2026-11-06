/**
 * The synthetic test worlds of the storage harness: plain terrain, a hilly
 * 2 × 2 km area, a dense town (town.ts), caves, and a world 2 km tall; and
 * the terrain mesher's hard-case row (features.ts).
 *
 * Engine-owned test data for measuring storage, not a product feature and
 * not world generation for games: each world is a deterministic function of
 * its seed and size, generated chunk by chunk (see world-kit.ts).
 */
import { fractalNoise01, valueNoise01 } from '@thirdlight/shared';
import { type ChunkGrid, type DenseChunk, localIndex, SHAPE_FULL, VOXEL_ROLE } from '@thirdlight/voxel';
import { townWorld } from './town';
import { CoarseField, ColumnCache, MAT, clamp01, fillGroundColumn, shapeByte, type GroundColumn, type TestGrid, type TestWorld } from './world-kit';

/** Options every world takes: its seed and its footprint in cells per side. */
export interface WorldOptions {
  seed?: number;
  footprint?: number;
}

/** Depth of the shallow worlds' ground below y = 0, in cells (64 m). */
export const SHALLOW_BASE = -128;

const M2_PER_CELL2 = 0.25;

/** Ground columns of one chunk column, cached while a sweep fills its chunks. */
type Columns = { cols: GroundColumn[]; maxTop: number };

function groundGrid(name: string, footprint: number, x0: number, top: number, base: number, column: (x: number, z: number) => GroundColumn): TestGrid {
  const cache = new ColumnCache<Columns>();
  return {
    name,
    yawDeg: 0,
    originM: [0, 0, 0],
    bounds: { min: [x0, base, x0], max: [x0 + footprint, top, x0 + footprint] },
    fill(grid: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean {
      const e = grid.edge;
      const { cols, maxTop } = cache.get(cx, cz, e, () => {
        const list: GroundColumn[] = [];
        let hi = -Infinity;
        for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
          const x = (cx << grid.shift) + lx;
          const z = (cz << grid.shift) + lz;
          const inside = x >= x0 && x < x0 + footprint && z >= x0 && z < x0 + footprint;
          const c = inside ? column(x, z) : { surface: -Infinity, base, top: MAT.grass, soilDepth: 0, liquidLevel: -Infinity };
          hi = Math.max(hi, c.surface, c.liquidLevel);
          list.push(c);
        }
        return { cols: list, maxTop: hi };
      });
      const y0 = cy << grid.shift;
      if (y0 >= maxTop || y0 + e <= base) {
        out.material.fill(0);
        out.role.fill(0);
        out.shape.fill(0);
        out.wetness.fill(0);
        return false;
      }
      let any = false;
      let k = 0;
      for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) any = fillGroundColumn(grid, out, lx, lz, y0, cols[k++]!) || any;
      return any;
    },
  };
}

/** Plain terrain: flat-ish ground (±1 m) of grass on 2 m of soil on rock, 64 m deep. One 256 m tile by default. */
export function plainWorld(opts: WorldOptions = {}): TestWorld {
  const seed = opts.seed ?? 11;
  const footprint = opts.footprint ?? 512;
  return {
    name: 'plain',
    description: `plain terrain ${footprint / 2} m square: surface 2 m ± 1 m, grass/soil/rock, base −64 m`,
    seed,
    areaM2: footprint * footprint * M2_PER_CELL2,
    benchFootprint: Math.min(footprint, 512),
    grids: [
      groundGrid('world', footprint, 0, 16, SHALLOW_BASE, (x, z) => ({
        surface: 4 + 4 * (fractalNoise01(x / 96, z / 96, 3, seed) - 0.5),
        base: SHALLOW_BASE,
        top: MAT.grass,
        soilDepth: 4,
        liquidLevel: -Infinity,
      })),
    ],
  };
}

/** Surface height in cells of the hilly world. */
function hillHeight(x: number, z: number, seed: number): number {
  const n = fractalNoise01(x / 900, z / 900, 5, seed);
  return 260 * Math.pow(n, 1.6) - 10;
}

/** Hilly terrain 2 × 2 km by default: hills to ~120 m, rock on steep slopes, lakes at 12 m, base −64 m. */
export function hillyWorld(opts: WorldOptions = {}): TestWorld {
  const seed = opts.seed ?? 23;
  const footprint = opts.footprint ?? 4000;
  // Lake surfaces sit inside a cell, so their top liquid cells are partly filled.
  const lake = 24.6;
  return {
    name: 'hilly',
    description: `hilly terrain ${footprint / 2000} km square: hills to ~120 m, rock on steep slopes, lakes at 12 m, base −64 m`,
    seed,
    areaM2: footprint * footprint * M2_PER_CELL2,
    benchFootprint: 512,
    grids: [
      groundGrid('world', footprint, -footprint / 2, 300, SHALLOW_BASE, (x, z) => {
        const h = hillHeight(x, z, seed);
        const slope = Math.max(Math.abs(hillHeight(x + 2, z, seed) - h), Math.abs(hillHeight(x, z + 2, seed) - h)) / 2;
        const steep = slope > 0.9;
        return {
          surface: h,
          base: SHALLOW_BASE,
          top: steep ? MAT.rock : h < lake + 2 ? MAT.sand : MAT.grass,
          soilDepth: steep ? 0 : 6,
          liquidLevel: lake,
        };
      }),
    ],
  };
}

/** Writes one terrain-or-air cell from a signed density (cells; > 0 inside) and its depth below the ground surface. */
function writeDensityCell(out: DenseChunk, i: number, density: number, depth: number, liquid: boolean, liquidFill: number): boolean {
  const fill = clamp01(density + 0.5);
  if (fill > 0) {
    out.material[i] = depth < 2 ? MAT.grass : depth < 8 ? MAT.soil : MAT.rock;
    out.role[i] = VOXEL_ROLE.terrain;
    out.shape[i] = shapeByte(fill);
    out.wetness[i] = 0;
    return true;
  }
  if (liquid) {
    out.material[i] = MAT.water;
    out.role[i] = VOXEL_ROLE.liquid;
    out.shape[i] = shapeByte(liquidFill);
    out.wetness[i] = 0;
    return true;
  }
  out.material[i] = 0;
  out.role[i] = 0;
  out.shape[i] = 0;
  out.wetness[i] = 0;
  return false;
}

/** Caves: 3D-density ground with overhangs at the surface, winding tunnels and caverns, pools below −40 m. One 256 m tile by default. */
export function cavesWorld(opts: WorldOptions = {}): TestWorld {
  const seed = opts.seed ?? 37;
  const footprint = opts.footprint ?? 512;
  const base = SHALLOW_BASE;
  const pool = -80.4;
  const surfaceAt = (x: number, z: number): number => 60 + 60 * (fractalNoise01(x / 200, z / 200, 3, seed) - 0.5);
  const cache = new ColumnCache<Float32Array>();
  let warpField: CoarseField | null = null;
  let carveField: CoarseField | null = null;
  const world: TestGrid = {
    name: 'world',
    yawDeg: 0,
    originM: [0, 0, 0],
    bounds: { min: [0, base, 0], max: [footprint, 120, footprint] },
    fill(grid, cx, cy, cz, out) {
      const e = grid.edge;
      const x0 = cx << grid.shift;
      const y0 = cy << grid.shift;
      const z0 = cz << grid.shift;
      const surf = cache.get(cx, cz, e, () => {
        const s = new Float32Array(e * e);
        for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) s[lx * e + lz] = surfaceAt(x0 + lx, z0 + lz);
        return s;
      });
      if (warpField === null || warpField.layout !== grid) warpField = new CoarseField(grid, 4);
      if (carveField === null || carveField.layout !== grid) carveField = new CoarseField(grid, 4);
      // Overhangs: a 3D warp of the ground near its surface (cells).
      warpField.sample(x0, y0, z0, (x, y, z) => (valueNoise01(x / 24, z / 24, seed + 1, y / 16) - 0.5) * 24);
      // Carve strength in cells, > 0 inside: tunnels where one noise is near its middle, caverns where another is high.
      carveField.sample(x0, y0, z0, (x, y, z) => {
        const tunnel = (0.05 - Math.abs(valueNoise01(x / 40, z / 40, seed + 2, y / 24) - 0.5)) * 160;
        const cavern = (valueNoise01(x / 70, z / 70, seed + 3, y / 40) - 0.68) * 120;
        return Math.max(tunnel, cavern);
      });
      let any = false;
      for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
        const s = surf[lx * e + lz] ?? 0;
        const x = x0 + lx;
        const z = z0 + lz;
        const inside = x < footprint && z < footprint && x >= 0 && z >= 0;
        for (let ly = 0; ly < e; ly++) {
          const y = y0 + ly;
          const i = localIndex(grid, lx, ly, lz);
          if (!inside || y < base) {
            any = writeDensityCell(out, i, -1, 0, false, 0) || any;
            continue;
          }
          const depth = s - y;
          const ground = depth < 14 ? depth + warpField.at(lx, ly, lz) : depth;
          const carve = depth > 6 && y > base + 4 ? carveField.at(lx, ly, lz) : -Infinity;
          const density = Math.min(ground, -carve);
          const water = density + 0.5 <= 0 && depth > 0 && y < pool;
          any = writeDensityCell(out, i, density, depth, water, pool - y) || any;
        }
      }
      return any;
    },
  };
  return {
    name: 'caves',
    description: `caves ${footprint / 2} m square: ground to ~30 m with 3D overhangs, tunnels and caverns, water pools below −40 m, base −64 m`,
    seed,
    areaM2: footprint * footprint * M2_PER_CELL2,
    benchFootprint: Math.min(footprint, 512),
    grids: [world],
  };
}

/** The town lives in its own module; re-exported so every world comes from here. */
export { townWorld };

/**
 * The terrain mesher's hard cases (slopes, bank, cliff, terraces, overhang,
 * arch, cave, one-cell wall, spike, pit and hole, bumps), each with its
 * analytic solid, in their own module. Not in {@link allWorlds}: they test
 * meshes, not storage.
 */
export { featuresWorld } from './features';

/**
 * A world 2 km tall on a 256 m footprint: base −1,000 m, a mountain to
 * ~+925 m, sparse deep caverns down to the base with water below −850 m,
 * and a 300 m tower of 0.5 m walls standing on the low ground.
 */
export function verticalWorld(opts: WorldOptions = {}): TestWorld {
  const seed = opts.seed ?? 53;
  const footprint = opts.footprint ?? 512;
  const base = -2000;
  const lake = -1699.7;
  const centre = footprint / 2;
  const reach = footprint * 0.7;
  const surfaceAt = (x: number, z: number): number => {
    const r = Math.hypot(x - centre, z - centre) / reach;
    return -200 + 2050 * Math.pow(Math.max(0, 1 - r), 2) + 40 * (fractalNoise01(x / 64, z / 64, 3, seed) - 0.5);
  };
  const tx0 = Math.round(footprint * 0.06);
  const tower = { x0: tx0, z0: tx0, size: 32, base: Math.floor(surfaceAt(tx0 + 16, tx0 + 16)), top: 600, storey: 8 };
  const cache = new ColumnCache<Float32Array>();
  let field: CoarseField | null = null;
  const world: TestGrid = {
    name: 'world',
    yawDeg: 0,
    originM: [0, 0, 0],
    bounds: { min: [0, base, 0], max: [footprint, 2000, footprint] },
    fill(grid, cx, cy, cz, out) {
      const e = grid.edge;
      const x0 = cx << grid.shift;
      const y0 = cy << grid.shift;
      const z0 = cz << grid.shift;
      const surf = cache.get(cx, cz, e, () => {
        const s = new Float32Array(e * e);
        for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) s[lx * e + lz] = surfaceAt(x0 + lx, z0 + lz);
        return s;
      });
      let maxSurf = -Infinity;
      for (const s of surf) maxSurf = Math.max(maxSurf, s);
      const towerHere = x0 < tower.x0 + tower.size && x0 + e > tower.x0 && z0 < tower.z0 + tower.size && z0 + e > tower.z0;
      if (y0 >= maxSurf && !(towerHere && y0 < tower.top)) {
        out.material.fill(0);
        out.role.fill(0);
        out.shape.fill(0);
        out.wetness.fill(0);
        return false;
      }
      const deep = y0 < maxSurf - 20;
      if (deep) {
        if (field === null || field.layout !== grid) field = new CoarseField(grid, 4);
        field.sample(x0, y0, z0, (x, y, z) => (valueNoise01(x / 48, z / 48, seed + 5, y / 48) - 0.7) * 120);
      }
      let any = false;
      for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
        const s = surf[lx * e + lz] ?? 0;
        const x = x0 + lx;
        const z = z0 + lz;
        const inside = x < footprint && z < footprint && x >= 0 && z >= 0;
        const tx = x - tower.x0;
        const tz = z - tower.z0;
        const inTower = tx >= 0 && tx < tower.size && tz >= 0 && tz < tower.size;
        const towerWall = inTower && (tx === 0 || tz === 0 || tx === tower.size - 1 || tz === tower.size - 1);
        for (let ly = 0; ly < e; ly++) {
          const y = y0 + ly;
          const i = localIndex(grid, lx, ly, lz);
          if (!inside || y < base) {
            any = writeDensityCell(out, i, -1, 0, false, 0) || any;
            continue;
          }
          const depth = s - y;
          if (inTower && y >= tower.base && y < tower.top) {
            const level = (y - tower.base) % tower.storey;
            const floor = level === 0;
            const window = towerWall && (level === 4 || level === 5) && (tx + tz) % 6 === 3;
            if ((towerWall && !window) || floor) {
              out.material[i] = towerWall ? MAT.stone : MAT.plank;
              out.role[i] = VOXEL_ROLE.wall;
              out.shape[i] = SHAPE_FULL;
              out.wetness[i] = 0;
              any = true;
              continue;
            }
            if (towerWall && window) {
              // A window is an opening in the wall's material: its edge pieces are drawn flush to the reveal.
              out.material[i] = MAT.stone;
              out.role[i] = VOXEL_ROLE.opening;
              out.shape[i] = SHAPE_FULL;
              out.wetness[i] = 0;
              any = true;
              continue;
            }
            writeDensityCell(out, i, -1, 0, false, 0);
            continue;
          }
          const carve = deep && depth > 20 && y > base + 20 && field !== null ? field.at(lx, ly, lz) : -Infinity;
          const density = Math.min(depth, -carve);
          const water = density + 0.5 <= 0 && depth > 0 && y < lake;
          any = writeDensityCell(out, i, density, depth, water, lake - y) || any;
        }
      }
      return any;
    },
  };
  return {
    name: 'vertical',
    description: `2 km tall, ${footprint / 2} m square: base −1,000 m, mountain to ~+925 m, deep caverns with water below −850 m, a 300 m tower of 0.5 m walls`,
    seed,
    areaM2: footprint * footprint * M2_PER_CELL2,
    benchFootprint: Math.min(footprint, 128),
    grids: [world],
  };
}

/** Every test world at its full size, in report order. */
export function allWorlds(): TestWorld[] {
  return [plainWorld(), hillyWorld(), townWorld(), cavesWorld(), verticalWorld()];
}
