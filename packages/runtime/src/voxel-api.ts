/**
 * `ctx.voxels`: what scripts read and change of the scenes' voxel worlds.
 *
 * Scripts work in world metres; which cells and chunks that means stays
 * inside the engine. A world's cell (0, 0, 0) starts at the world origin and
 * a cell is `VOXEL_SIZE_M` on each side.
 *
 * Reads are of the world as the game sees it (its runtime changes over the
 * world's files). A cell whose chunk is not loaded reads `null`, never air:
 * a game that needs ground there waits for it (`whenResident`, answered in
 * `waits` at a later step, as every answer that takes time is). Changes go to
 * the running game only (dropped when the game quits or a run restarts);
 * the edited cells read their new values at once, in the same step, and
 * their meshes, colliders and shader data change together in one swap a
 * few frames later, reported in `changes` at the next step.
 */
import { cellInWorld, MATERIAL_ID_MAX, SHAPE_FULL, VOXEL_ROLE_COUNT, VOXEL_SIZE_M, WETNESS_MAX, type VoxelRecord } from '@thirdlight/voxel';

/** A voxel as scripts read and write it. */
export interface VoxelValue {
  /** Material id (0: air). */
  readonly material: number;
  /** Role (0: air): what the voxel is to meshing and collision (ground, wall, beam, …). */
  readonly role: number;
  /** Fill level, 0 (empty) to 15 (full). */
  readonly shape: number;
  /** Wetness, 0 (dry) to 7. */
  readonly wetness: number;
}

/** The voxel `set` writes: shape absent is full, wetness absent is dry. */
export interface VoxelWrite {
  readonly material: number;
  readonly role: number;
  readonly shape?: number;
  readonly wetness?: number;
}

/** What `paint` changes: material and wetness only (shader data; meshes and colliders stand). */
export interface VoxelPaint {
  readonly material?: number;
  readonly wetness?: number;
}

/**
 * Where a read or change applies, in world metres: the cell holding a
 * point, every cell a box touches, or every cell whose centre lies within a
 * ball.
 */
export type VoxelRegion =
  | { readonly at: readonly [number, number, number] }
  | { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
  | { readonly center: readonly [number, number, number]; readonly radius: number };

/** Why a change was not made (nothing was written). */
export type VoxelRefusal = 'no_world' | 'not_resident' | 'invalid';

/** A change's answer: its id (named again by its entry in `changes`) and the cells it changed (0: it changed nothing). */
export type VoxelEditResult = { readonly ok: true; readonly edit: number; readonly cells: number } | { readonly ok: false; readonly reason: VoxelRefusal; readonly message: string };

/** A box in world metres. */
export interface VoxelBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A change whose meshes, colliders and shader data were swapped in. */
export interface VoxelChange {
  readonly world: string;
  /** The id the change's call answered with. */
  readonly edit: number;
  /** The world's pieces whose derived data the swap replaced (each one's box). */
  readonly chunks: readonly VoxelBox[];
  /** Only material or wetness changed: the shader data was replaced, meshes and colliders stand. */
  readonly shaderOnly: boolean;
}

/** One voxel world of the loaded scenes. */
export interface BehaviorVoxelWorld {
  /** The world's name (its `voxelWorld` component's `world`). */
  readonly name: string;
  /**
   * The voxel at a world position, or null where the world is not loaded there (never air for that).
   * @graphPure
   * @graphNode Voxel at
   */
  get(x: number, y: number, z: number): VoxelValue | null;
  /** Write a voxel into every cell of a region (readable at once; meshes and colliders follow in one swap). */
  set(region: VoxelRegion, voxel: VoxelWrite): VoxelEditResult;
  /** Empty every cell of a region to air. */
  dig(region: VoxelRegion): VoxelEditResult;
  /** Change the material or wetness of the non-air cells of a region, keeping their shape and role (only shader data changes). */
  paint(region: VoxelRegion, paint: VoxelPaint): VoxelEditResult;
  /**
   * Whether every cell of a region is loaded (reads give values, changes are accepted).
   * @graphPure
   */
  isResident(region: VoxelRegion): boolean;
  /**
   * Waits for every cell of a region to be loaded: returns the wait's id, answered in `ctx.voxels.waits`
   * at a later step's start (resident, or not when the world unloaded first).
   */
  whenResident(region: VoxelRegion): number;
}

/**
 * The voxel worlds of the loaded scenes (`ctx.voxels`). Its own reads and
 * changes act on the first world loaded; `world(name)` reaches the others.
 */
export interface BehaviorVoxels extends Omit<BehaviorVoxelWorld, 'name'> {
  /** The loaded worlds' names, in load order. */
  worlds(): readonly string[];
  /** A loaded world by name (null: no loaded scene names it). */
  world(name: string): BehaviorVoxelWorld | null;
  /** The changes swapped in since the previous step, every world's, in swap order. */
  readonly changes: readonly VoxelChange[];
  /** The `whenResident` waits answered at this step's start. */
  readonly waits: readonly VoxelWaitAnswer[];
}

/** A `whenResident` wait's answer. */
export interface VoxelWaitAnswer {
  readonly wait: number;
  /** True: the region is loaded; false: its world unloaded first (or the region was not one). */
  readonly resident: boolean;
}

/** A region's cells (inclusive bounds) and, for a ball, which of them it holds. */
export interface RegionCells {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /** Absent: every cell of the bounds. */
  readonly holds?: (x: number, y: number, z: number) => boolean;
}

const finite3 = (v: unknown): v is readonly [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const cellOf = (m: number): number => Math.floor(m / VOXEL_SIZE_M);
/** The last cell a box edge at `m` touches (a box ending exactly on a cell face does not reach into the next cell). */
const lastCellOf = (m: number): number => Math.ceil(m / VOXEL_SIZE_M) - 1;

/** The cells of a region (null: malformed, or reaching outside the world). */
export function regionCells(region: VoxelRegion): RegionCells | null {
  if (typeof region !== 'object' || region === null) return null;
  let out: RegionCells;
  if ('at' in region) {
    if (!finite3(region.at)) return null;
    const [x, y, z] = region.at.map(cellOf) as [number, number, number];
    out = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
  } else if ('min' in region) {
    if (!finite3(region.min) || !finite3(region.max)) return null;
    const lo = region.min.map(cellOf);
    const hi = region.max.map((m, i) => Math.max(lo[i]!, lastCellOf(m)));
    if (region.max.some((m, i) => m < region.min[i]!)) return null;
    out = { minX: lo[0]!, minY: lo[1]!, minZ: lo[2]!, maxX: hi[0]!, maxY: hi[1]!, maxZ: hi[2]! };
  } else if ('center' in region) {
    const r = region.radius;
    if (!finite3(region.center) || typeof r !== 'number' || !(r >= 0) || !Number.isFinite(r)) return null;
    const [cx, cy, cz] = region.center;
    const r2 = r * r;
    const s = VOXEL_SIZE_M;
    // A cell is in the ball when its centre is.
    const holds = (x: number, y: number, z: number): boolean => {
      const dx = (x + 0.5) * s - cx;
      const dy = (y + 0.5) * s - cy;
      const dz = (z + 0.5) * s - cz;
      return dx * dx + dy * dy + dz * dz <= r2;
    };
    out = { minX: cellOf(cx - r), minY: cellOf(cy - r), minZ: cellOf(cz - r), maxX: cellOf(cx + r), maxY: cellOf(cy + r), maxZ: cellOf(cz + r), holds };
  } else return null;
  return cellInWorld(out.minX, out.minY, out.minZ) && cellInWorld(out.maxX, out.maxY, out.maxZ) ? out : null;
}

/** Every cell of a region, x y z flat. */
export function regionCellList(r: RegionCells): number[] {
  const out: number[] = [];
  for (let x = r.minX; x <= r.maxX; x++) for (let z = r.minZ; z <= r.maxZ; z++) for (let y = r.minY; y <= r.maxY; y++) if (r.holds === undefined || r.holds(x, y, z)) out.push(x, y, z);
  return out;
}

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A script's voxel as the record it writes (null: a field out of range). */
export function writeRecord(v: VoxelWrite): VoxelRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const shape = v.shape ?? SHAPE_FULL;
  const wetness = v.wetness ?? 0;
  if (!intIn(v.material, 0, MATERIAL_ID_MAX) || !intIn(v.role, 0, VOXEL_ROLE_COUNT - 1) || !intIn(shape, 0, SHAPE_FULL) || !intIn(wetness, 0, WETNESS_MAX)) return null;
  return { material: v.material, role: v.role, shape, wetness };
}

/** Whether a paint names only material and wetness, in range, and at least one of them. */
export function validPaint(p: VoxelPaint): boolean {
  if (typeof p !== 'object' || p === null || (p.material === undefined && p.wetness === undefined)) return false;
  return (p.material === undefined || intIn(p.material, 1, MATERIAL_ID_MAX)) && (p.wetness === undefined || intIn(p.wetness, 0, WETNESS_MAX));
}
