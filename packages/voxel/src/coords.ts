/**
 * World, chunk and region coordinates of the voxel world.
 *
 * A voxel is one cell of a 0.5 m grid; every coordinate here is an integer
 * cell, chunk or region index, never metres, so addressing stays exact at
 * any distance from the origin (metres only appear when a cell is placed in
 * a scene, relative to a floating origin).
 *
 * The chunk edge (16 or 32 cells) is still being measured, so every chunk
 * function takes a {@link ChunkGrid} instead of a constant edge; nothing
 * else here depends on the choice.
 */

/** Edge of one voxel in metres. */
export const VOXEL_SIZE_M = 0.5;

/**
 * Horizontal cell bounds (inclusive), the same on x and z. The design target
 * is a 10 km world (20,000 cells); ±32,768 cells (±16.4 km) holds it whether
 * the origin sits at its centre or at a corner, with room to grow, and each
 * axis still fits a signed 16-bit integer.
 */
export const WORLD_CELL_MIN_XZ = -32768;
export const WORLD_CELL_MAX_XZ = 32767;

/**
 * Vertical cell bounds (inclusive): ±8,192 cells (±4.1 km). A world needs
 * about 1–2 km from its base to its highest peak (4,000 cells); these bounds
 * hold that extent placed anywhere around y = 0, with the same again as
 * headroom above and below, in a signed 14-bit range.
 */
export const WORLD_CELL_MIN_Y = -8192;
export const WORLD_CELL_MAX_Y = 8191;

/** The chunk edges under comparison, in cells. */
export type ChunkEdge = 16 | 32;

/** The chunk edges under comparison, in cells. */
export const CHUNK_EDGES: readonly ChunkEdge[] = Object.freeze([16, 32]);

/** The chunk layout for one chunk edge: everything a chunk function needs. */
export interface ChunkGrid {
  /** Cells along each chunk edge. */
  readonly edge: ChunkEdge;
  /** log2(edge): a cell's chunk is `cell >> shift`. */
  readonly shift: number;
  /** edge − 1: a cell's place in its chunk is `cell & mask`. */
  readonly mask: number;
  /** Cells in one chunk (edge³). */
  readonly cellsPerChunk: number;
  /** Lowest chunk index on x and z. */
  readonly chunkMinXZ: number;
  /** Lowest chunk index on y. */
  readonly chunkMinY: number;
  /** Chunk indices along x and z. */
  readonly chunkSpanXZ: number;
  /** Chunk indices along y. */
  readonly chunkSpanY: number;
}

const grids = new Map<ChunkEdge, ChunkGrid>();

/** The chunk layout for `edge` cells per chunk edge. */
export function chunkGrid(edge: ChunkEdge): ChunkGrid {
  const known = grids.get(edge);
  if (known !== undefined) return known;
  if (!CHUNK_EDGES.includes(edge)) throw new RangeError(`chunk edge must be one of ${CHUNK_EDGES.join(', ')}, got ${String(edge)}`);
  const shift = Math.log2(edge);
  const chunkMinXZ = WORLD_CELL_MIN_XZ >> shift;
  const chunkMinY = WORLD_CELL_MIN_Y >> shift;
  const grid: ChunkGrid = Object.freeze({
    edge,
    shift,
    mask: edge - 1,
    cellsPerChunk: edge * edge * edge,
    chunkMinXZ,
    chunkMinY,
    chunkSpanXZ: (WORLD_CELL_MAX_XZ >> shift) - chunkMinXZ + 1,
    chunkSpanY: (WORLD_CELL_MAX_Y >> shift) - chunkMinY + 1,
  });
  grids.set(edge, grid);
  return grid;
}

/** Whether a cell lies inside the world bounds. */
export function cellInWorld(x: number, y: number, z: number): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
    x >= WORLD_CELL_MIN_XZ && x <= WORLD_CELL_MAX_XZ &&
    z >= WORLD_CELL_MIN_XZ && z <= WORLD_CELL_MAX_XZ &&
    y >= WORLD_CELL_MIN_Y && y <= WORLD_CELL_MAX_Y
  );
}

/** The chunk index holding a cell on one axis (rounds toward −∞, so −1 is in chunk −1). */
export function chunkOf(grid: ChunkGrid, cell: number): number {
  return cell >> grid.shift;
}

/** A cell's place inside its chunk on one axis, 0 … edge − 1 (negative cells too). */
export function localOf(grid: ChunkGrid, cell: number): number {
  return cell & grid.mask;
}

/** The first cell of a chunk on one axis. */
export function chunkOrigin(grid: ChunkGrid, chunk: number): number {
  return chunk << grid.shift;
}

/**
 * A cell's index in its chunk's arrays. y runs fastest, then z, then x: a
 * vertical column is contiguous, so column scans (surface search, sky
 * visibility, vertical runs) read memory in order.
 */
export function localIndex(grid: ChunkGrid, lx: number, ly: number, lz: number): number {
  return (((lx << grid.shift) | lz) << grid.shift) | ly;
}

/** Whether a chunk index triple lies inside the world bounds. */
export function chunkInWorld(grid: ChunkGrid, cx: number, cy: number, cz: number): boolean {
  return (
    Number.isInteger(cx) && Number.isInteger(cy) && Number.isInteger(cz) &&
    cx >= grid.chunkMinXZ && cx < grid.chunkMinXZ + grid.chunkSpanXZ &&
    cz >= grid.chunkMinXZ && cz < grid.chunkMinXZ + grid.chunkSpanXZ &&
    cy >= grid.chunkMinY && cy < grid.chunkMinY + grid.chunkSpanY
  );
}

/**
 * One non-negative integer naming a chunk in its grid (below 2^35 for either
 * edge, so an exact JavaScript number). Keys sort by x, then z, then y: the
 * chunks of one vertical column are consecutive, and so are the columns of
 * one region row.
 */
export function chunkKey(grid: ChunkGrid, cx: number, cy: number, cz: number): number {
  if (!chunkInWorld(grid, cx, cy, cz)) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside the world`);
  return chunkKeyOrNone(grid, cx, cy, cz);
}

/**
 * {@link chunkKey} for the per-cell paths: −1 for a chunk outside the world
 * instead of an exception, and no integer check (the caller passes
 * `cell >> shift`, always an integer).
 */
export function chunkKeyOrNone(grid: ChunkGrid, cx: number, cy: number, cz: number): number {
  const x = cx - grid.chunkMinXZ;
  const y = cy - grid.chunkMinY;
  const z = cz - grid.chunkMinXZ;
  if (x < 0 || x >= grid.chunkSpanXZ || z < 0 || z >= grid.chunkSpanXZ || y < 0 || y >= grid.chunkSpanY) return -1;
  return (x * grid.chunkSpanXZ + z) * grid.chunkSpanY + y;
}

/** A chunk index triple, as returned by {@link chunkOfKey}. */
export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

/** The chunk a {@link chunkKey} names. */
export function chunkOfKey(grid: ChunkGrid, key: number, out: ChunkCoord = { cx: 0, cy: 0, cz: 0 }): ChunkCoord {
  const max = grid.chunkSpanXZ * grid.chunkSpanXZ * grid.chunkSpanY;
  if (!Number.isInteger(key) || key < 0 || key >= max) throw new RangeError(`chunk key ${key} is outside the world`);
  const y = key % grid.chunkSpanY;
  const xz = (key - y) / grid.chunkSpanY;
  const z = xz % grid.chunkSpanXZ;
  out.cx = (xz - z) / grid.chunkSpanXZ + grid.chunkMinXZ;
  out.cy = y + grid.chunkMinY;
  out.cz = z + grid.chunkMinXZ;
  return out;
}

/**
 * Region footprints under comparison, in cells per side: 512 (256 m, the
 * default tile) and 1024 (512 m). A region is a full-height column or one
 * cube of a stack (region-file.ts); either way its footprint is never a
 * height limit.
 */
export type RegionFootprint = 512 | 1024;

/** Every region footprint a world may use. */
export const REGION_FOOTPRINTS: readonly RegionFootprint[] = Object.freeze([512, 1024]);

/** Whether a value is a region footprint (a world manifest's or a region header's). */
export function isRegionFootprint(v: unknown): v is RegionFootprint {
  return (REGION_FOOTPRINTS as readonly unknown[]).includes(v);
}

/** The default region footprint in cells (256 m). */
export const DEFAULT_REGION_FOOTPRINT: RegionFootprint = 512;

/** The region index holding a cell on x or z (rounds toward −∞). */
export function regionOfCell(footprint: RegionFootprint, cell: number): number {
  return cell >> Math.log2(footprint);
}

/** The region index holding a chunk on x or z. */
export function regionOfChunk(grid: ChunkGrid, footprint: RegionFootprint, chunk: number): number {
  return chunk >> (Math.log2(footprint) - grid.shift);
}

/** Chunks along each side of a region. */
export function chunksPerRegionSide(grid: ChunkGrid, footprint: RegionFootprint): number {
  return footprint >> grid.shift;
}

/** One non-negative integer naming a region (x then z). */
export function regionKey(footprint: RegionFootprint, rx: number, rz: number): number {
  const min = WORLD_CELL_MIN_XZ >> Math.log2(footprint);
  const span = (WORLD_CELL_MAX_XZ >> Math.log2(footprint)) - min + 1;
  if (!Number.isInteger(rx) || !Number.isInteger(rz) || rx < min || rx >= min + span || rz < min || rz >= min + span) {
    throw new RangeError(`region (${rx}, ${rz}) is outside the world`);
  }
  return (rx - min) * span + (rz - min);
}

/** The region a {@link regionKey} names. */
export function regionOfKey(footprint: RegionFootprint, key: number): { rx: number; rz: number } {
  const min = WORLD_CELL_MIN_XZ >> Math.log2(footprint);
  const span = (WORLD_CELL_MAX_XZ >> Math.log2(footprint)) - min + 1;
  if (!Number.isInteger(key) || key < 0 || key >= span * span) throw new RangeError(`region key ${key} is outside the world`);
  const z = key % span;
  return { rx: (key - z) / span + min, rz: z + min };
}
