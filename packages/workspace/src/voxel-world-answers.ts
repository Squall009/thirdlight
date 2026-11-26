/** What the voxel worlds answer (info, files, far cache, commands and their reports) and the state the backend keeps a world open with. */
import { statSync } from 'node:fs';
import {
  UndoStore,
  FAR_MAX_LEVEL,
  VOXEL_SIZE_M,
  type GridPlacement,
  type StructureDefinition,
  type StructureGenerator,
  type StructureMisfit,
  type CellBox,
  type ChunkCoord,
  type ChunkEdge,
  type RegionFootprint,
  type RegionLayout,
  type KitTestLabel,
  type VoxelEditCommand,
} from '@thirdlight/voxel';
import { type VoxelWorldOp } from '@thirdlight/commands/mutation-ops';
import { REGION_WORLD_RESIDENT_BYTES, RegionWorld } from './voxel-world-files';
import { type HeldOverrides, type StructureChangeReport } from './voxel-structure-writes';
import { type WriteOps } from './write';
import { type FarBricksRebuild } from './voxel-far-bake';
import { FAR_EXPORT_WAIT_MS, type FarCacheManifest } from './voxel-far-cache';
import { type FarCacheJobs } from './voxel-far-jobs';
import { type WaterBodyReport } from './voxel-water';
import { type HeldRecord, type SplineChangeReport } from './voxel-spline-writes';
import { type VoxelWorldManifest } from './voxel-world-manifest';

/**
 * The voxel world ops' arguments, as {@link VoxelWorlds.command} reads them
 * (unknown fields refused). `world` names the folder `voxels/<world>/`.
 */
export type VoxelWorldOpArgs =
  | {
      op: 'editVoxels';
      /** One stroke; `command` is the voxel edit command format (`v`, `grid`, `kind`, …), rebuilt field by field. */
      args: { world: string; command: VoxelEditCommand };
    }
  | {
      op: 'writeKitTestScene';
      /**
       * Writes the kit test scene (@thirdlight/voxel `kitTestScene`: every
       * case of the world rules' catalogue built from voxels, a row a role,
       * a column a case) into the box from `origin` (world cells, its lowest
       * corner), emptying the box first; every built cell in `material` (a
       * kit's bound material, so the kit's pieces draw). One change: one
       * `undo` takes it back. The answer's `scene` labels each
       * exhibit's centre with its role, case and run section.
       */
      args: { world: string; origin: [number, number, number]; material: number };
    };

/** Why a world, a file or a command was refused. */
export interface VoxelWorldError {
  readonly code: string;
  readonly cls: 'validation' | 'conflict' | 'not_found' | 'internal';
  readonly message: string;
  readonly path?: string;
  /** `revision_conflict`: the revision the command expected and the world's. */
  readonly expectedRevision?: number;
  readonly currentRevision?: number;
  /**
   * `flood_leaks`: where the refused flood would leave its bound, as a water body's leaks are told: metres (in the
   * scene for the world grid, in the grid's own frame for a structure's), a place per 16 m of ground, the bound
   * crossed and the cells there.
   */
  readonly leaks?: ReadonlyArray<{ readonly at: readonly [number, number, number]; readonly kind: 'reach' | 'world'; readonly cells: number }>;
}

/** A world's manifest and its listed region files with their tags (null: listed, but missing or unreadable): the world grid's (`files`), each structure grid's (`grids`). */
export type VoxelWorldInfo =
  | {
      ok: true;
      world: string;
      manifest: VoxelWorldManifest;
      files: Array<{ name: string; etag: string | null }>;
      /** Each structure grid the manifest lists: its files, where its structure object stands (absent: no object owns it), its last regenerate's report this backend holds (absent: none since the world was opened, or undone since), and how many cells its hand edits (overrides) hold. */
      grids: Array<{ id: number; files: Array<{ name: string; etag: string | null }>; place?: GridPlacement; lastRegenerate?: StructureGridReport; overrides: number }>;
      /** Each water body of the world (its object placed): its state after the last step that wrote it, or as the fill finds it now (filled, drained by a leak and where, its start cell blocked). Memory only, never stored. */
      bodies: WaterBodyReport[];
      /** Each spline writing into the world: the cells its record holds, and its last rewrite's report this backend holds (absent: none since the world was opened, or undone since). */
      splines: Array<{ entityId: string; written: number; recordBytes: number; lastWrite?: SplineReportAt }>;
    }
  | { ok: false; error: VoxelWorldError };

/** A world's files as an export ships them (`VoxelWorlds.shippedFiles`). */
export type ShippedWorldFiles =
  | {
      ok: true;
      world: { world: string; worldId: string; edge: ChunkEdge; layout: RegionLayout; footprint: RegionFootprint; revision: number };
      files: Array<{ name: string; path: string; digest: string; byteLength: number }>;
      /** The structure grids placed by the project's structure objects: each grid's region files and where it stands (absent: none). Never their definitions or overrides. */
      grids?: Array<{ id: number; position: [number, number, number]; yawRad: number; files: Array<{ name: string; path: string; digest: string; byteLength: number }> }>;
      /** The world's far cache, current with its revision: what the far field draws (its files named `L<level>/<name>`). */
      far?: { minLevel: number; maxLevel: number; files: Array<{ name: string; path: string; digest: string; byteLength: number }>; bakeLevel?: number };
      /** Why the world ships without its far cache, or without the fine levels its bake level asks (still being built when the export stopped waiting). */
      farNote?: string;
    }
  | { ok: false; code: string; message: string };

export type RegionFileAnswer = { ok: true; path: string; etag: string } | { ok: false; error: VoxelWorldError };

/**
 * A world's far cache as served: its manifest and its files (`L<level>/<name>`)
 * with their tags, current with the world's revision. While it is being
 * built (missing, or of an older revision) the answer is `far_cache_building`.
 */
export type VoxelFarInfo = { ok: true; world: string; manifest: FarCacheManifest; files: Array<{ name: string; etag: string }>; fine?: VoxelFineBake; follow?: VoxelFarFollow } | { ok: false; error: VoxelWorldError };

/** The last far rebuild that followed commands after their answers (voxel-far-follow.ts), as the far info reports it. */
export interface VoxelFarFollow {
  /** Changes it built (an edit, an undo, a structure step: a structure made or changed gives its stroke and its place), and the world chunks it built again over. */
  readonly commands: number;
  readonly chunks: number;
  /** When it landed (ms since the epoch). */
  readonly at: number;
  /** What it built (null: there was no far cache). */
  readonly result: FarRebuilt | { readonly stale: string } | null;
}

/** A world's fine bake as the far info answers it: the level asked, whether it is baking now, and per fine level the region columns baked of all. */
export interface VoxelFineBake {
  readonly bakeLevel: number;
  readonly baking: boolean;
  /** Paused by the editor: the columns baked stay, and nothing bakes until it is resumed. */
  readonly paused: boolean;
  /** Why the last bake stopped with an error (a full disk, a failed read): it waits for a resume or a new bake level. */
  readonly failed?: string;
  readonly levels: ReadonlyArray<{ readonly level: number; readonly done: number; readonly total: number }>;
}

/** A far cache's level file folder name (`L<level>`: its nodes; `B<level>`: their baked bricks). */
export const FAR_LEVEL_RE = /^[LB](\d{1,2})$/;
export const isFarLevel = (level: string): boolean => {
  const m = FAR_LEVEL_RE.exec(level);
  return m !== null && Number(m[1]) <= FAR_MAX_LEVEL;
};

/** Waits for `p` or `ms`, whichever is first (a timer that keeps no process alive). */
export async function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((ok) => {
    timer = setTimeout(ok, ms);
    timer.unref();
  });
  await Promise.race([p, elapsed]);
  clearTimeout(timer);
}

/** A structure command's writes to a world (voxel-structure-writes.ts), its own op on the world's line of strokes. */
export const STRUCTURE_WRITE_OP = 'writeStructures';
/** A command's splines written into a world (voxel-spline-writes.ts), its own op on the world's line of strokes. */
export const SPLINE_WRITE_OP = 'writeSplines';

/** A spline rewrite's report with its left-alone cells and misfits placed in the world (metres, the cell's middle). */
export interface SplineReportAt extends Omit<SplineChangeReport, 'leftAlone' | 'misfits'> {
  readonly leftAlone: ReadonlyArray<SplineChangeReport['leftAlone'][number] & { readonly at: readonly [number, number, number] }>;
  readonly misfits: ReadonlyArray<SplineChangeReport['misfits'][number] & { readonly at: readonly [number, number, number] }>;
}
/** A command's water (voxel-water.ts: bodies made, changed or deleted, and those round the structures it wrote), its own op on the world's line of strokes. */
export const WATER_WRITE_OP = 'writeWater';

/** The water a stroke wrote after its edit, in the same stroke: what a client derives again for it (the liquid part, round `box`), and each body's report. */
export interface VoxelWaterAnswer {
  readonly box: Readonly<CellBox>;
  readonly parts: number;
  readonly chunks: ReadonlyArray<readonly [number, number, number]>;
  readonly bodies?: readonly WaterBodyReport[];
  /** Milliseconds the water took (inside `ms.apply`). */
  readonly ms?: number;
}

/** An empty cell box: a change of structure grids only touches no cell of the world grid. */
export const NO_CELLS: Readonly<CellBox> = Object.freeze({ minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1 });

/** A misfit of a regenerate: its cell in the structure's grid, and where that cell's middle stands in the world now (metres; null: the structure is not placed). */
export interface StructureMisfitAt extends StructureMisfit {
  readonly at: readonly [number, number, number] | null;
}

/** What a structure command did to one grid (its last regenerate's report, held in memory and answered again by {@link VoxelWorlds.info}). */
export interface StructureGridReport extends Omit<StructureChangeReport, 'misfits'> {
  readonly misfits: readonly StructureMisfitAt[];
}

/** What an applied voxel command answers. */
export interface VoxelCommandApplied {
  readonly ok: true;
  /** The op applied: a forward op (a structure command's writes: {@link STRUCTURE_WRITE_OP}; its splines: {@link SPLINE_WRITE_OP}; its water: {@link WATER_WRITE_OP}), or `undo` / `redo` of one of the world's strokes ({@link VoxelWorlds.step}). */
  readonly op: VoxelWorldOp | VoxelStepDirection | typeof STRUCTURE_WRITE_OP | typeof SPLINE_WRITE_OP | typeof WATER_WRITE_OP;
  readonly requestId: string | null;
  readonly world: string;
  /** The world's revision after the change. */
  readonly revision: number;
  /**
   * The far cache after the change: `queued`, the world chunks now waiting
   * to be built again after the answer (voxel-far-follow.ts; a rebuild's
   * own answer: the nodes rebuilt and the ms it took, from
   * {@link VoxelWorlds.farSettled}), or why it will not be (it is then built
   * again whole when next read); null when the world has none yet.
   */
  readonly far: FarRebuilt | { readonly queued: number } | { readonly stale: string } | null;
  /** Cells whose voxel changed. */
  readonly cells: number;
  /** The world grid's chunks whose content changed ([cx, cy, cz] each): what a client re-reads. */
  readonly chunks: ReadonlyArray<readonly [number, number, number]>;
  /** The structure grids' chunks that changed, by grid (absent: none). */
  readonly grids?: ReadonlyArray<{ readonly grid: number; readonly chunks: ReadonlyArray<readonly [number, number, number]> }>;
  /** A structure command's writes, a grid each: cells, kept and absorbed overrides, misfits (in the grid's cells and in world metres). */
  readonly structures?: readonly StructureGridReport[];
  /** A spline command's writes, a spline each: cells put back, written, left alone (edited since), kept and misfits by the fit rule. */
  readonly splines?: readonly SplineReportAt[];
  /**
   * The water bodies the stroke followed after its edit (absent: none met): the cells their liquid took or left,
   * which feed the liquid part alone (`box` and `parts` above are the edit's own). A {@link WATER_WRITE_OP} step
   * answers its bodies here too, its `box` and `parts` its own.
   */
  readonly water?: VoxelWaterAnswer;
  /**
   * The cells the change can have touched (inclusive; an undo answers the
   * box of the edit it undoes): what a client derives again from, only the
   * results within the rules' radius of it.
   */
  readonly box: Readonly<CellBox>;
  /**
   * The derived parts the change makes stale (DERIVED_PART bits of
   * @thirdlight/voxel, from the fields that changed): a client rebuilds
   * only these (only `shader` when only material or wetness changed: the
   * shader data of the chunks within its border of the box, nothing else).
   */
  readonly parts: number;
  /**
   * The distinct material changes (@thirdlight/voxel `materialSwap`: from,
   * to; an undo answers its edit's turned round): what tells a client
   * whether a shader-only change moves cells to another kit's pieces.
   */
  readonly materialSwaps: readonly number[];
  /** The region files rewritten, with their new entity tags. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly etag: string | null }>;
  /** Edits that can still be undone. */
  readonly undoable: number;
  /** Edits undone that can be applied again. */
  readonly redoable: number;
  /** The stroke the command made (a forward op) or took back or applied again (a step): what the project's undo timeline names. */
  readonly stroke: number;
  /** True when this answers a request id seen before (nothing was applied again). */
  readonly duplicated: boolean;
  /** Milliseconds: the apply, and the region and manifest writes. */
  readonly ms: { readonly apply: number; readonly save: number };
  /** `writeKitTestScene` only: the scene's box (inclusive) and its labels. */
  readonly scene?: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number]; readonly labels: readonly KitTestLabel[] };
}

export type VoxelCommandResult = VoxelCommandApplied | { ok: false; error: VoxelWorldError };

/** Which way {@link VoxelWorlds.step} goes: take a stroke back, or apply an undone one again. */
export type VoxelStepDirection = 'undo' | 'redo';

/**
 * One edit in a world's history: its stroke (an id unique in this process, kept through undo and redo), the id of
 * the record that steps it (undo: what it changed, as it was before; redo: what the undo found), the cells it
 * changed, the box it could change and the derived parts it made stale.
 */
export interface HistoryEntry {
  readonly stroke: number;
  readonly id: number;
  readonly cells: number;
  readonly box: Readonly<CellBox>;
  readonly parts: number;
  readonly materialSwaps: readonly number[];
  /** Structure grids' overrides files the stroke changed: their bytes before and after (null: no file). */
  readonly overrides?: ReadonlyArray<{ readonly grid: number; readonly before: Uint8Array | null; readonly after: Uint8Array | null }>;
  /** Splines' record files the stroke changed: their bytes before and after (null: no file). */
  readonly records?: ReadonlyArray<{ readonly entityId: string; readonly before: Uint8Array | null; readonly after: Uint8Array | null }>;
  /** A structure command's writes: the far field under its grids is the command's to build again (its objects may come or go with it). */
  readonly structural?: true;
  /** The water a stroke wrote after its edit (answered again by its undo and redo). */
  readonly water?: { readonly box: Readonly<CellBox>; readonly parts: number; readonly chunks: ReadonlyArray<readonly [number, number, number]> };
}

/** What a world folder holds as this process last read or wrote it. */
export interface WorldState {
  manifest: VoxelWorldManifest;
  /** Hash of the manifest's bytes. */
  manifestHash: string;
  world: RegionWorld;
  /** The structure grids' region files by grid id (a grid a command made is here before the manifest lists it). */
  grids: Map<number, RegionWorld>;
  /** The structure grids' overrides as read or written (read on first use). */
  overrides: Map<number, HeldOverrides>;
  /** The last regenerate's report of each structure grid (memory only: answered again, never stored). */
  reports: Map<number, StructureChangeReport>;
  /** The splines' records as read or written, by object id (read on first use). */
  records: Map<string, HeldRecord>;
  /** The last rewrite's report of each spline (memory only). */
  splineReports: Map<string, SplineChangeReport>;
  undo: UndoStore;
  history: HistoryEntry[];
  /** Strokes undone, newest last: a redo applies the last again; a new edit drops them all. */
  redo: HistoryEntry[];
  /**
   * File stamps (inode, size, change times) of the manifest and every listed
   * region file, by path ('absent' for a missing one): a file whose stamp
   * moved is checked by hash, and one whose bytes differ was changed by
   * someone else (a git checkout, a restore, another program).
   */
  stamps: Map<string, string>;
}

export interface OpenWorld extends WorldState {
  readonly projectId: string;
  readonly name: string;
  readonly dir: string;
  /** The world's far cache folder. */
  readonly farDir: string;
  /** Far cache file tags by path, with the stamp they were taken at. */
  readonly farTags: Map<string, { stamp: string; hash: string }>;
  readonly answers: Map<string, VoxelCommandApplied>;
  queue: Promise<unknown>;
}

/** A far rebuild's answer: the nodes rebuilt (the changed chunks' ancestors), the ms it took, its bricks and fine nodes. */
export type FarRebuilt = { readonly nodes: number; readonly ms: number; readonly bricks?: FarBricksRebuild; readonly fine?: FarBricksRebuild };

export const refuse = (code: string, cls: VoxelWorldError['cls'], message: string, path?: string): { ok: false; error: VoxelWorldError } => ({ ok: false, error: { code, cls, message, ...(path !== undefined ? { path } : {}) } });

export interface VoxelWorldsOptions {
  /** The project's folder (null: the project cannot be opened). */
  projectDir(projectId: string): string | null;
  /** The file operations of region and manifest writes (tests inject failures here). */
  readonly writeOps?: WriteOps;
  /** Store bytes each open world keeps of its clean region files (default {@link REGION_WORLD_RESIDENT_BYTES}). */
  readonly residentBytes?: number;
  /** Where far cache builds and rebuilds run (the backend's worker thread; default this thread). */
  readonly farJobs?: FarCacheJobs;
  /** How long an export waits for a far cache being built (default {@link FAR_EXPORT_WAIT_MS}). */
  readonly farExportWaitMs?: number;
  /** How long a command's far changes wait for more before they are built (default `FAR_FOLLOW_SETTLE_MS`). */
  readonly farFollowSettleMs?: number;
  /**
   * The project's scenes as stored: their voxel world components name each world's bake level (the finest any of them
   * sets; absent: the default, 2 m, no fine level baked).
   */
  scenes?(projectId: string): readonly unknown[];
  /** The structures' generator (default the building generator; tests give one of another version). */
  readonly structureGenerator?: StructureGenerator<StructureDefinition>;
}

/**
 * A fine bake under way (voxel-far-fine.ts): it runs outside the world's queue, a region column at a time, each
 * column written in the queue; the chunks commands change meanwhile are built again in each column as it lands (a
 * column read the world's files while they changed).
 */
export interface FineBake {
  readonly level: number;
  readonly changed: ChunkCoord[];
  done: Promise<void>;
  /** Stopped (paused, or the level asked changed): no further column lands; the columns written stay. */
  stopped: boolean;
}

/**
 * A full far cache build under way: it runs outside the world's queue, so
 * commands go on meanwhile; the chunks they change are noted and built
 * again once the new cache has landed, and a change on disk by someone else
 * (`lost`) leaves the new cache stale, built again when next read.
 */
export interface FarBuild {
  readonly changed: Map<string, ChunkCoord>;
  lost: boolean;
  done: Promise<void>;
}

export const worldKey = (w: { projectId: string; name: string }): string => `${w.projectId}\u0000${w.name}`;

export function fileStamp(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch {
    return 'absent';
  }
}

/** The object ids whose records a stepped stroke changed. */
export function strokeRecords(e: HistoryEntry | null): string[] {
  return (e?.records ?? []).map((r) => r.entityId);
}

/** A spline report with its cells' places (metres, a cell's middle). */
export function splineReportAt(r: SplineChangeReport): SplineReportAt {
  const m = VOXEL_SIZE_M;
  const at = (c: { x: number; y: number; z: number }): readonly [number, number, number] => [(c.x + 0.5) * m, (c.y + 0.5) * m, (c.z + 0.5) * m];
  return { ...r, leftAlone: r.leftAlone.map((c) => ({ ...c, at: at(c) })), misfits: r.misfits.map((c) => ({ ...c, at: at(c) })) };
}
