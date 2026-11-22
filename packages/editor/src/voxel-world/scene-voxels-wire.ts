/**
 * The messages between the editor page and the worker that streams the
 * Scene view's voxel worlds (scene-voxels-worker.ts).
 */
import type { ChunkDrawBatch, GridPlacement, PieceKitSource, ReliefRingSettings, SectionEdge, WorldLevelsMetres, WorldRingMetres } from '@thirdlight/voxel';
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
  /** Where the view looks (metres): every world streams around it. */
  | { readonly t: 'focus'; readonly x: number; readonly y: number; readonly z: number }
  /** A change the backend applied to `world` (the editor feed's `voxelsChanged`). */
  | { readonly t: 'changed'; readonly world: string; readonly change: WorldChange }
  /** The page's GPU bytes of drawn chunks (`[cx, cy, cz, bytes]` repeated) of a world or a structure grid (its draw name). */
  | { readonly t: 'drawn'; readonly world: string; readonly bytes: readonly number[]; readonly coarse: number; readonly kits: number }
  /** Where the open scenes' structure objects of `world` place its grids (every one; a grid left out is not drawn). */
  | { readonly t: 'grids'; readonly world: string; readonly places: readonly GridPlacement[] }
  /** What a ray (world metres) meets first within `maxM` in every world and its drawn grids, each grid in its own frame. */
  | { readonly t: 'pick'; readonly id: number; readonly origin: readonly [number, number, number]; readonly dir: readonly [number, number, number]; readonly maxM: number };

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
  | { readonly t: 'picked'; readonly id: number; readonly hit: { readonly world: string; readonly grid: number; readonly t: number } | null };
