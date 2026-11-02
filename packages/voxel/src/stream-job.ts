/**
 * The streaming job contract (v1 DRAFT): what the main thread sends a
 * worker and what comes back.
 *
 * - **Ids.** Every job has an id from the {@link DirtyTracker} (one id
 *   space for chunk jobs and saves), and every reply names it. A reply for
 *   an id that is no longer live (cancelled, timed out, its chunk unloaded)
 *   is ignored, never applied.
 * - **Kinds.** `load` (decompress and decode a stored chunk), `apply-save`
 *   (a save entry over its base chunk, with the base-hash check), `edit` (a
 *   stroke command over the chunks it touches) and `derive` (anything
 *   rebuilt from a chunk and its neighbours: the placeholder here, meshing
 *   and its kin later).
 * - **Lanes.** Work is queued by lane, then by distance: `edit` (rebuilds an
 *   edit made stale) before `near` before `far` (LOD, prefetch).
 * - **Staleness.** A job snapshots the input version of the chunks it reads
 *   (an edit, a neighbour edit within R, a reload each move it on); a result
 *   is accepted only while those are unchanged.
 * - **Neighbourhood.** A derive job carries its dependency radius R and the
 *   apron strips R deep (apron.ts), never whole neighbours.
 * - **Buffers** travel as transfer lists: chunk payloads (chunk-wire.ts),
 *   aprons, stored bytes and undo records move, they are not copied.
 */
import type { Apron } from './apron';
import type { ChunkPayload } from './chunk-wire';
import type { ChunkEdge } from './coords';
import type { VoxelEditCommand } from './edit-command';
import type { MismatchChoice } from './save-file';
import type { StampShape } from './stamp-shape';

/** Version of the job messages; a worker refuses any other. */
export const STREAM_JOB_VERSION = 1;

export type StreamJobKind = 'load' | 'apply-save' | 'edit' | 'derive';

/** Queue lanes in priority order: an edit's rebuilds, then near work, then far work (LOD, prefetch). */
export type JobLane = 'edit' | 'near' | 'far';
export const JOB_LANES: readonly JobLane[] = Object.freeze(['edit', 'near', 'far']);

/** A chunk of a grid (0 the world grid, else a structure's own grid). */
export interface ChunkRef {
  readonly grid: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

/** A chunk as its region file holds it: stored bytes (compressed unless `raw`), or one record value. */
export type StoredChunk = { readonly stored: Uint8Array; readonly raw: boolean } | { readonly uniform: number };

export interface LoadInput {
  readonly edge: ChunkEdge;
  readonly chunk: ChunkRef;
  readonly bytes: StoredChunk;
  /** Also return the base hash of the chunk's canonical codec bytes (what a save entry is checked against). */
  readonly hash: boolean;
}

export interface LoadOutput {
  readonly payload: ChunkPayload;
  readonly hash: Uint8Array | null;
  /** Worker microseconds: decompressing, then decoding into the memory form. */
  readonly decompressUs: number;
  readonly decodeUs: number;
}

/** A save entry's content as it crosses threads (a delta as its bytes at rest). */
export type SaveContentWire =
  | { readonly kind: 'delta'; readonly bytes: Uint8Array }
  | { readonly kind: 'image'; readonly bytes: Uint8Array }
  | { readonly kind: 'uniform'; readonly value: number }
  | { readonly kind: 'air' };

export interface ApplySaveInput {
  readonly edge: ChunkEdge;
  readonly chunk: ChunkRef;
  /** The shipped chunk (null: absent, air). */
  readonly base: StoredChunk | null;
  /** The save entry's base hash. */
  readonly expect: Uint8Array;
  readonly content: SaveContentWire;
  /** On a base mismatch: apply the save anyway, take the base, or apply nothing and report (the game then decides). */
  readonly onMismatch: MismatchChoice | 'report';
}

export interface ApplySaveOutput {
  /** The chunk now (the base when the save was not applied). */
  readonly payload: ChunkPayload;
  readonly mismatch: boolean;
  readonly applied: boolean;
  readonly baseNow: Uint8Array;
}

export interface EditInput {
  readonly edge: ChunkEdge;
  /** A canonical command (canonicalEditCommand). */
  readonly command: VoxelEditCommand;
  /** Every chunk the command can touch, as it is now (copies; the main thread keeps its own). */
  readonly chunks: readonly { readonly chunk: ChunkRef; readonly payload: ChunkPayload }[];
  /** Stamp shapes the command names, by id (their hash is computed again in the worker). */
  readonly stamps?: readonly { readonly id: string; readonly shape: StampShape }[];
}

export interface EditOutput {
  readonly cells: number;
  /** The chunks the command changed, as they are now. */
  readonly chunks: readonly { readonly chunk: ChunkRef; readonly payload: ChunkPayload }[];
  /** The undo record (encodeUndoRecord bytes). */
  readonly undo: Uint8Array;
}

export interface DeriveInput {
  readonly edge: ChunkEdge;
  readonly chunk: ChunkRef;
  readonly payload: ChunkPayload;
  /** The rules' dependency radius R (cells); the apron is R deep. */
  readonly radius: number;
  readonly apron: Apron;
}

/**
 * The derive placeholder's result: which solid cells have an air cell
 * within R (the cells a surface or detail pass would visit), as a bitmask
 * over the chunk's cells. A stand-in for meshing and its kin that reads the
 * whole neighbourhood, so apron and invalidation can be proven before they
 * exist; null mask when no cell is exposed.
 */
export interface DeriveOutput {
  readonly solid: number;
  readonly exposed: number;
  readonly mask: Uint32Array | null;
  /** FNV-1a of the mask words (0 when null), for comparing results. */
  readonly hash: number;
}

export interface StreamJobInputs {
  load: LoadInput;
  'apply-save': ApplySaveInput;
  edit: EditInput;
  derive: DeriveInput;
}

export interface StreamJobOutputs {
  load: LoadOutput;
  'apply-save': ApplySaveOutput;
  edit: EditOutput;
  derive: DeriveOutput;
}

/** A job message to a worker. `kind` is any handler's name: the pool is not tied to the stream kinds. */
export interface JobRequest {
  readonly v: number;
  readonly id: number;
  readonly kind: string;
  readonly input: unknown;
}

/** Why a worker could not run a job. */
export type JobErrorCode = 'version' | 'unknown_kind' | 'refused' | 'failed';

export type JobReply =
  | { readonly v: number; readonly id: number; readonly ok: true; readonly output: unknown; readonly workerUs: number }
  | { readonly v: number; readonly id: number; readonly ok: false; readonly code: JobErrorCode; readonly message: string; readonly workerUs: number };
