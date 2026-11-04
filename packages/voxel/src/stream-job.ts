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
 *   and its kin later; with a `level`, a node of the chunk tree), and `mip`
 *   (a node of the chunk tree downsampled from its 8 children), and `seam`
 *   (a coarse node face's seam toward the finer nodes against it, from their
 *   derived surfaces: lod-seam.ts).
 * - **Lanes.** Work is queued by lane, then by distance: `edit` (rebuilds an
 *   edit made stale) before `near` before `far` (prefetch) before `mip` (the
 *   coarser levels, built from what level 0 already holds).
 * - **Staleness.** A job snapshots the input version of the chunks it reads
 *   (an edit, a neighbour edit within R, a reload each move it on); a result
 *   is accepted only while those are unchanged.
 * - **Neighbourhood.** A derive job carries its dependency radius R and the
 *   apron strips R deep (apron.ts), never whole neighbours.
 * - **Sections.** A derive job may name sections of its chunk (8³, 16³ or
 *   the whole 32³): each is derived as a unit of its own, so an edit
 *   re-derives only the sections within R of the cells it changed.
 * - **Buffers** travel as transfer lists: chunk payloads (chunk-wire.ts),
 *   aprons, stored bytes and undo records move, they are not copied.
 */
import type { Apron } from './apron';
import type { AssemblyRulesRef } from './assembly';
import type { ChunkPayload } from './chunk-wire';
import type { ChunkEdge, SectionEdge } from './coords';
import type { SectionResult } from './derive-assembly';
import type { ShaderOut } from './derived-shader';
import type { DerivedData } from './derived-data';
import type { VoxelEditCommand } from './edit-command';
import type { FaceSeam, SeamFaceInput } from './lod-seam';
import type { MismatchChoice, SaveContentKind } from './save-file';
import type { StampShape } from './stamp-shape';

/** Version of the job messages; a worker refuses any other. */
export const STREAM_JOB_VERSION = 1;

export type StreamJobKind = 'load' | 'apply-save' | 'edit' | 'derive' | 'mip' | 'seam';

/**
 * Queue lanes in priority order: an edit's rebuilds, then near work, then
 * far work (prefetch), then the chunk tree's coarser levels (drawn only
 * past level 0, and built from it, so they never hold level 0 back).
 */
export type JobLane = 'edit' | 'near' | 'far' | 'mip';
export const JOB_LANES: readonly JobLane[] = Object.freeze(['edit', 'near', 'far', 'mip']);

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

/** A save entry's content as it crosses threads: its kind and its payload bytes as the save holds them. */
export interface SaveContentWire {
  readonly kind: SaveContentKind;
  readonly payload: Uint8Array;
}

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
  /** The fields that changed in any cell (PLANE_BIT mask): what decides which derived parts go stale. */
  readonly fields: number;
}

export interface DeriveInput {
  readonly edge: ChunkEdge;
  readonly chunk: ChunkRef;
  readonly payload: ChunkPayload;
  /** The job's dependency radius R (cells); the apron is R deep. */
  readonly radius: number;
  readonly apron: Apron;
  /**
   * The assembly rule set to derive with (derive-assembly.ts); R must then be
   * its radius + the consumers' reach. Absent: the exposure placeholder.
   */
  readonly rules?: AssemblyRulesRef;
  /**
   * The derived parts wanted (DERIVED_PART bits, record.ts; default all).
   * Only `shader`: the shader data of the chunk and its border, no assembly
   * evaluation; R is then the shader border (SHADER_BORDER_CELLS) and the
   * apron that deep (a change of material or wetness only).
   */
  readonly parts?: number;
  /**
   * Derive these sections of the chunk instead of the chunk as one unit
   * (the rules or the shader data alone; the exposure placeholder has no
   * sections). `edge` divides the chunk edge; `ids` are section ids
   * (derive-assembly.ts `sectionIdOf`). The apron is the chunk's: a section
   * reads its neighbours inside the chunk from the chunk's own cells.
   */
  readonly sections?: { readonly edge: SectionEdge; readonly ids: readonly number[] };
  /**
   * The chunk-tree level of the chunk (default 0): a node of level L
   * (voxel-mips.ts) is derived like a chunk from its cells and an apron of
   * the same level's nodes, with the rules (no sections), and its result
   * records the level.
   */
  readonly level?: number;
  /**
   * The world's kit piece table (piece-table.ts bytes; absent: no kit, the
   * default pieces), with the rules: a worker decodes it once and keeps it
   * by hash.
   */
  readonly pieces?: Uint8Array;
}

/** A chunk-tree node's 8 children (octant order: bit 0 x, bit 1 y, bit 2 z; null: air, or not known). */
export interface MipInput {
  readonly edge: ChunkEdge;
  readonly children: ReadonlyArray<ChunkPayload | null>;
}

export interface MipOutput {
  /** The node's cells (`downsampleMip`), in the chunk payload form. */
  readonly payload: ChunkPayload;
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
  /** FNV-1a of the mask words (0 when null), or CRC-32 of the derived chunk's canonical bytes, for comparing results. */
  readonly hash: number;
  /** The derived chunk when the job named assembly rules (the exposure fields are then 0 and null). */
  readonly assembly: DerivedData | null;
  /** The shader data alone, for a job that asked for only that part (else null; a full derive holds it in `assembly`). */
  readonly shader: ShaderOut | null;
  /** One result a section, in the order the input named them, when the job named sections. */
  readonly sections?: readonly SectionResult[];
}

export interface StreamJobInputs {
  load: LoadInput;
  'apply-save': ApplySaveInput;
  edit: EditInput;
  derive: DeriveInput;
  mip: MipInput;
  seam: SeamFaceInput;
}

export interface StreamJobOutputs {
  load: LoadOutput;
  'apply-save': ApplySaveOutput;
  edit: EditOutput;
  derive: DeriveOutput;
  mip: MipOutput;
  seam: FaceSeam;
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
