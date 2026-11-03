/**
 * The messages between the editor page and the worker that streams the
 * Scene view's voxel worlds (scene-voxels-worker.ts).
 */
import type { ChunkDrawBatch, SectionEdge, WorldRingMetres } from '@thirdlight/voxel';
import type { WorldChange } from './range-world';

/** Page → worker. */
export type SceneVoxelsIn =
  /** Stream `world` (its route `url`, read with `headers`; derive workers from `workerUrl`) with a `voxelWorld` object's ring and sections. */
  | { readonly t: 'open'; readonly world: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly workerUrl: string; readonly ring: WorldRingMetres; readonly sectionEdge: SectionEdge }
  | { readonly t: 'close'; readonly world: string }
  /** Where the view looks (metres): every world streams around it. */
  | { readonly t: 'focus'; readonly x: number; readonly y: number; readonly z: number }
  /** A change the backend applied to `world` (the editor feed's `voxelsChanged`). */
  | { readonly t: 'changed'; readonly world: string; readonly change: WorldChange }
  /** The page's GPU bytes of drawn chunks (`[cx, cy, cz, bytes]` repeated). */
  | { readonly t: 'drawn'; readonly world: string; readonly bytes: readonly number[] };

/** Worker → page. */
export type SceneVoxelsOut =
  | { readonly t: 'batch'; readonly batch: ChunkDrawBatch }
  /** The world could not be opened or read again (it is not drawn, or drawn as it was). */
  | { readonly t: 'problem'; readonly world: string; readonly message: string }
  /** What a world holds (after it settles; tests and the status read it). */
  | { readonly t: 'state'; readonly world: string; readonly revision: number; readonly resident: number; readonly settled: boolean; readonly bytes: number };
