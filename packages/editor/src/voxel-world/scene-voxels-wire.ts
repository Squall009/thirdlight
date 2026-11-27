/**
 * The messages between the editor page and the worker that streams the
 * Scene view's voxel worlds (scene-voxels-worker.ts).
 */
import { surfacePoint, surfacePointOut, type ChunkDrawBatch, type GridPlacement, type PieceKitSource, type ReliefRingSettings, type SectionEdge, type SurfacePoint, type SurfaceSource, type WorldLevelsMetres, type WorldRingMetres } from '@thirdlight/voxel';
import type { WorldChange } from './range-world';

/** Page → worker. */
export type SceneVoxelsIn =
  /** Stream `world` (its route `url`, read with `headers`; derive workers from `workerUrl`) with a `voxelWorld` object's ring, levels and sections (its collision radius bounds level 0), its relief lattice steps (the view's quality level's), its pieces from the project's `kits` and piece seed. */
  | { readonly t: 'open'; readonly world: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly workerUrl: string; readonly ring: WorldRingMetres; readonly levels: WorldLevelsMetres; readonly collision: { readonly radius: number }; readonly sectionEdge: SectionEdge; readonly reliefSteps: number; readonly kits: readonly PieceKitSource[]; readonly pieceSeed: number }
  /** The view's quality level changed: `world`'s relief ring from now on (cells). */
  | { readonly t: 'relief'; readonly world: string; readonly ring: ReliefRingSettings }
  | { readonly t: 'close'; readonly world: string }
  /** The project's kits or piece seed changed: `world` derives again what the new piece table changes. */
  | { readonly t: 'kits'; readonly world: string; readonly kits: readonly PieceKitSource[]; readonly pieceSeed: number }
  /**
   * What grows on the project's voxel ground from now on (the cover job's table: its dressings and the voxel
   * materials that name them; null: nothing) and the boxes of the props rule plants keep clear of (world metres,
   * six floats a prop; null: none): every open world, and those opened later, makes its ground cover by them.
   */
  | { readonly t: 'cover'; readonly table?: unknown; readonly clear?: Float32Array | null }
  /** Where the view looks (metres): every world streams around it. */
  | { readonly t: 'focus'; readonly x: number; readonly y: number; readonly z: number }
  /** A change the backend applied to `world` (the editor feed's `voxelsChanged`). */
  | { readonly t: 'changed'; readonly world: string; readonly change: WorldChange }
  /** The page's GPU bytes of drawn chunks (`[cx, cy, cz, bytes]` repeated) of a world or a structure grid (its draw name). */
  | { readonly t: 'drawn'; readonly world: string; readonly bytes: readonly number[]; readonly coarse: number; readonly kits: number }
  /** Where the open scenes' structure objects of `world` place its grids (every one; a grid left out is not drawn). */
  | { readonly t: 'grids'; readonly world: string; readonly places: readonly GridPlacement[] }
  /** What a ray (world metres) meets first within `maxM` in every world and its drawn grids, each grid in its own frame. */
  | { readonly t: 'pick'; readonly id: number; readonly origin: readonly [number, number, number]; readonly dir: readonly [number, number, number]; readonly maxM: number }
  /** The record values of a box of `world`'s own cells (both corners inclusive), as the view holds them now. */
  | { readonly t: 'cells'; readonly id: number; readonly world: string; readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
  /** The surface under a cell of `world`'s own lattice and its fields, the two distances with them, as the view holds the cells now. */
  | { readonly t: 'surface'; readonly id: number; readonly world: string; readonly cell: readonly [number, number, number] };

/** Worker → page. */
export type SceneVoxelsOut =
  | { readonly t: 'batch'; readonly batch: ChunkDrawBatch }
  /** `world` took the new kits: what they change swaps in with the swap group `group` (0: nothing to derive again). */
  | { readonly t: 'kits'; readonly world: string; readonly group: number }
  /** The world could not be opened or read again (it is not drawn, or drawn as it was). */
  | { readonly t: 'problem'; readonly world: string; readonly message: string }
  /** What a world holds (after it settles; tests and the status read it). */
  | { readonly t: 'state'; readonly world: string; readonly revision: number; readonly resident: number; readonly settled: boolean; readonly bytes: number; readonly grids?: Readonly<Record<string, { readonly resident: number; readonly settled: boolean }>> }
  /** A pick's answer: the nearest stop (metres along the ray), its world and grid (0: the world grid), or none. */
  | { readonly t: 'picked'; readonly id: number; readonly hit: ScenePickHit | null }
  /** A box's record values, x outermost, then z, then y (`CELL_NOT_LOADED` where the view holds none); null: the world is not open. */
  | { readonly t: 'cells'; readonly id: number; readonly values: Uint32Array | null }
  /** A surface read's answer (null: the world is not open). */
  | { readonly t: 'surface'; readonly id: number; readonly read: SceneSurfaceRead | null };

/**
 * What lies under a cell: a surface with its fields (the ones a dressing
 * rule reads, distances included), no surface within the per-point form's
 * reach, or cells the view has not loaded (never a guess).
 */
export type SceneSurfaceRead = { readonly state: 'surface'; readonly point: SurfacePoint } | { readonly state: 'none' } | { readonly state: 'unloaded' };

/** The surface under cell (x, y, z) of a world read through `src`, with its distances: the kernel's per-point form, nothing kept. */
export function sceneSurfaceRead(src: SurfaceSource, cell: readonly [number, number, number]): SceneSurfaceRead {
  const point = surfacePointOut();
  const got = surfacePoint(src, cell[0], cell[1], cell[2], true, point);
  return got === null ? { state: 'unloaded' } : got ? { state: 'surface', point } : { state: 'none' };
}

/** A cell the view has not loaded, in a `cells` answer (no record value is it: a value's reserved bits are never all set). */
export const CELL_NOT_LOADED = 0xffffffff;

/**
 * Where a pick's ray stopped: metres along it, the world and grid (0: the world grid), the cell in that grid and the
 * face it entered by (the stopping cell's outward normal, in the grid's frame; 0, 0, 0: it started inside), and the
 * cell's voxel value (null: not read).
 */
export interface ScenePickHit {
  readonly world: string;
  readonly grid: number;
  readonly t: number;
  readonly cell: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly record: number | null;
}
