/**
 * What a voxel world keeps of the splines that write into it, and the
 * writes a spline command makes.
 *
 * A spline with a `voxels` section writes roads, paths and rivers into the
 * world grid over the ground (`@thirdlight/voxel` structures/world-writer.ts,
 * spline-writer.ts). Its record of what it replaced, for every cell it
 * wrote the voxel that lay there and the voxel it wrote, is
 * `structures/<object id>.tlvo` in the world's folder (the overrides' TLVO
 * layout, its two values read as before and written), written in the same
 * staged write as the region files and the manifest, absent while the
 * spline writes nothing. Authoring data: an export ships the region files
 * only. Nothing else is stored; a rewrite's report (cells put back, left
 * alone, kept, misfits) is answered and held in memory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeOverrides,
  emptyWorldRecord,
  encodeOverrides,
  rewriteInWorld,
  SPLINE_WRITER,
  worldRecordChunks,
  type CellBox,
  type ChunkCoord,
  type ChunkGrid,
  type ChunkUndo,
  type LeftAlone,
  type SplineVoxelDefinition,
  type StructureMisfit,
  type WorldRecord,
} from '@thirdlight/voxel';
import { sha256HexNative } from './digest';
import type { RegionWorld } from './voxel-world-files';

/** The folder of a world's spline records, beside its region files. */
export const SPLINE_RECORDS_FOLDER = 'structures';
/** A spline record's file name after its object's id. */
export const SPLINE_RECORD_EXT = '.tlvo';

/** A record's file name. */
export const splineRecordFile = (entityId: string): string => `${entityId}${SPLINE_RECORD_EXT}`;

/** A spline's record as this process last read or wrote it: the file's bytes and hash (null: no file) and its value. */
export interface HeldRecord {
  readonly bytes: Uint8Array | null;
  readonly hash: string | null;
  readonly value: WorldRecord;
}

/** The object ids whose records a world's folder holds, sorted. */
export function listedSplineRecords(worldDir: string): string[] {
  const dir = join(worldDir, SPLINE_RECORDS_FOLDER);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SPLINE_RECORD_EXT))
    .map((f) => f.slice(0, -SPLINE_RECORD_EXT.length))
    .sort();
}

/** Reads a spline's record (absent: an empty one). Throws when it is damaged. */
export function readSplineRecord(worldDir: string, grid: ChunkGrid, entityId: string): HeldRecord {
  const path = join(worldDir, SPLINE_RECORDS_FOLDER, splineRecordFile(entityId));
  if (!existsSync(path)) return { bytes: null, hash: null, value: emptyWorldRecord(grid) };
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, hash: sha256HexNative(bytes), value: decodeOverrides(grid, bytes) };
}

/** A spline command's change: the spline's course to write now (null: none, what it wrote goes back). */
export interface SplineChange {
  readonly entityId: string;
  readonly definition: SplineVoxelDefinition | null;
}

/** What one change did (the command's answer names each). */
export interface SplineChangeReport {
  readonly entityId: string;
  /** Cells whose voxel changed. */
  readonly cells: number;
  readonly putBack: number;
  /** Cells the record holds after. */
  readonly written: number;
  /** The record's bytes at rest after (0: no file). */
  readonly recordBytes: number;
  readonly leftAlone: readonly LeftAlone[];
  readonly kept: number;
  readonly absorbed: number;
  readonly misfits: readonly StructureMisfit[];
  readonly fields: number;
  /** The cells it changed (inclusive; null: none): what the water round it follows. */
  readonly box: CellBox | null;
}

/** The changes' result: one undo record of the world grid, the record files to write (null: delete), a report a change. */
export interface SplineWrites {
  readonly record: ChunkUndo[];
  readonly cells: number;
  readonly fields: number;
  readonly parts: number;
  readonly materialSwaps: readonly number[];
  /** The world cells the changes changed (inclusive; null: none). */
  readonly box: CellBox | null;
  readonly records: Map<string, { readonly bytes: Uint8Array | null; readonly value: WorldRecord }>;
  readonly reports: SplineChangeReport[];
}

/** What a spline change needs of its world: the world grid and the records as held. */
export interface SplineRecordHost {
  readonly world: RegionWorld;
  record(entityId: string): HeldRecord;
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => (a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]));

const grow = (a: CellBox | null, b: CellBox | null): CellBox | null => (a === null ? b : b === null ? a : { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ) });

/**
 * Applies the changes to the world grid in memory, in order, and answers what they did; nothing is written here.
 * Each change's chunks (its record's and its new course's) are loaded first.
 */
export async function applySplineChanges(host: SplineRecordHost, changes: readonly SplineChange[]): Promise<SplineWrites> {
  const record: ChunkUndo[] = [];
  const records = new Map<string, { bytes: Uint8Array | null; value: WorldRecord }>();
  const reports: SplineChangeReport[] = [];
  const swaps = new Set<number>();
  let cells = 0;
  let fields = 0;
  let parts = 0;
  let box: CellBox | null = null;
  const rw = host.world;
  const grid = rw.opts.grid;
  for (const ch of changes) {
    const held = records.get(ch.entityId)?.value ?? host.record(ch.entityId).value;
    const chunks: ChunkCoord[] = [...worldRecordChunks(held), ...(ch.definition === null ? [] : SPLINE_WRITER.chunks!(ch.definition, grid))];
    await rw.ensure(chunks);
    const r = rewriteInWorld(SPLINE_WRITER, rw.store, held, ch.definition);
    rw.markEdited(r.undo);
    // Newest first: an undo takes back the later change before the earlier.
    record.unshift(...r.undo);
    const bytes = r.record.chunks.size === 0 ? null : encodeOverrides(r.record);
    const was = records.has(ch.entityId) ? records.get(ch.entityId)!.bytes : host.record(ch.entityId).bytes;
    if (!sameBytes(bytes, was)) records.set(ch.entityId, { bytes, value: r.record });
    for (const sw of r.materialSwaps) swaps.add(sw);
    cells += r.cells;
    fields |= r.fields;
    parts |= r.parts;
    box = grow(box, r.box);
    reports.push({ entityId: ch.entityId, cells: r.cells, putBack: r.putBack, written: r.written, recordBytes: bytes?.length ?? 0, leftAlone: r.leftAlone, kept: r.kept, absorbed: r.absorbed, misfits: r.misfits, fields: r.fields, box: r.box });
  }
  return { record, cells, fields, parts, materialSwaps: [...swaps].sort((a, b) => a - b), box, records, reports };
}
