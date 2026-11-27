/**
 * The surface fields of a chunk column, as a job: the block form of
 * surface-fields.ts (the foundation "fields derived from voxels") run on a
 * column's chunks and the eight columns round it, in a worker or in the
 * calling thread, giving the same bytes in both.
 *
 * One job serves every level of the chunk tree, since a node has a chunk's
 * form: level 0 from resident chunks as payloads (what a derive worker is
 * sent), the far cache's 2 m nodes from their stored bytes (the coarse
 * floor's decode, far-ground.ts, here read for every field instead of the
 * tops alone). The result is never stored and nothing asks for it a chunk
 * by default: a consumer submits the job for the columns it places on.
 *
 * **What a far node cannot say** (the coarser levels keep one value a cell,
 * and a body wins it): a gas lying on ground, and water shallower or
 * narrower than a 2 m cell, are not in a 2 m node, so its gas fields read
 * none and its water only where the 0.5 m water fills whole coarse cells; a
 * surface's material and role are those of the body that won its cell.
 */
import { decodeDenseChunk } from './cell-delta';
import { checkPayloadEdge, payloadTransfer, type ChunkPayload } from './chunk-wire';
import { chunkGrid, CHUNK_EDGES, mipCellMetres, type ChunkEdge, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { RecordChunk } from './palette-chunk';
import type { PaletteStore } from './palette-store';
import { checkRecordValue, ROLE_SHIFT, SHAPE_SHIFT, WETNESS_SHIFT } from './record';
import { regionChunkCodecBytes, type RegionChunkRead } from './region-file';
import type { StoredChunk } from './stream-job';
import { surfaceDistanceCells, surfaceFields, type SurfaceCells, type SurfaceFieldColumns } from './surface-fields';

/** One chunk (or node) of a surface fields job: which column it is of (−1 … 1 from the column answered), its row and its cells. */
export interface SurfaceFieldsChunk {
  readonly dx: number;
  readonly dz: number;
  readonly cy: number;
  /** Its cells: a resident chunk's payload, or a chunk as a region file or the far cache stores it. */
  readonly cells: ChunkPayload | StoredChunk;
  /** 1 a cell (a chunk's local index) where something not in the voxels stands (surface-fields.ts `SurfaceCells.built`); absent: nothing. */
  readonly built?: Uint8Array;
}

/** A surface fields job: a chunk column of a level and what holds anything in it and round it. */
export interface SurfaceFieldsInput {
  readonly edge: ChunkEdge;
  /** The chunk-tree level of the cells (0: chunks of 0.5 m cells; 2: the far cache's 2 m nodes). */
  readonly level: number;
  /** The column answered (chunk or node coordinates of that level). */
  readonly cx: number;
  readonly cz: number;
  /** The chunks that hold anything, of the column and the eight round it (a chunk not named is air). */
  readonly chunks: readonly SurfaceFieldsChunk[];
}

/** The ring of cells a job reads round its column: the distance fields' reach at its level. */
export function surfaceFieldsPad(level: number): number {
  return surfaceDistanceCells(mipCellMetres(level));
}

/** Whether a chunk's cells are a resident chunk's payload (else its stored form). */
function isPayload(c: ChunkPayload | StoredChunk): c is ChunkPayload {
  return 'form' in c;
}

/** A stored chunk decoded into `d` (false: it holds nothing). */
export function decodeStoredChunk(g: ChunkGrid, cy: number, b: StoredChunk, decompress: (b: Uint8Array) => Uint8Array, d: DenseChunk): boolean {
  const read: RegionChunkRead = 'uniform' in b ? (b.uniform === 0 ? { cx: 0, cy, cz: 0, kind: 'air' } : { cx: 0, cy, cz: 0, kind: 'uniform', value: b.uniform }) : { cx: 0, cy, cz: 0, kind: 'stored', bytes: b.stored, raw: b.raw };
  const codec = regionChunkCodecBytes(g, read, decompress);
  if (codec === null) return false;
  decodeDenseChunk(g, codec, d);
  return true;
}

/**
 * A job's cells as one box: the column's footprint and the ring round it,
 * over the rows of every chunk named. `ring`: the cells kept round the
 * footprint (the distance fields' reach by default; a consumer that reads
 * fields at points past the footprint asks for more, up to the whole columns
 * beside).
 */
export function surfaceFieldsCells(input: SurfaceFieldsInput, decompress: (b: Uint8Array) => Uint8Array, ring = surfaceFieldsPad(input.level)): SurfaceCells {
  if (!CHUNK_EDGES.includes(input.edge)) throw new RangeError(`surface fields job: chunk edge ${String(input.edge)}`);
  if (![input.level, input.cx, input.cz].every(Number.isInteger) || input.level < 0) throw new RangeError('surface fields job: its column is not integers');
  const g = chunkGrid(input.edge);
  const e = g.edge;
  const pad = ring;
  if (!Number.isInteger(pad) || pad < 0 || pad > e) throw new RangeError(`surface fields job: a reach of ${pad} cells past the columns beside (edge ${e})`);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of input.chunks) {
    if (![c.dx, c.dz, c.cy].every(Number.isInteger) || Math.abs(c.dx) > 1 || Math.abs(c.dz) > 1) throw new RangeError('surface fields job: a chunk outside the columns round its column');
    if (c.built !== undefined && c.built.length !== g.cellsPerChunk) throw new RangeError('surface fields job: built cells of another edge');
    lo = Math.min(lo, c.cy);
    hi = Math.max(hi, c.cy);
  }
  const side = e + 2 * pad;
  const rows = input.chunks.length === 0 ? 1 : (hi - lo + 1) * e;
  const oy = input.chunks.length === 0 ? 0 : lo * e;
  const values = new Uint32Array(side * side * rows);
  let built: Uint8Array | null = null;
  const d = createDenseChunk(g);
  const { material, role, shape, wetness } = d;
  let packed: Uint32Array | null = null;
  for (const c of input.chunks) {
    // A chunk of one value is written as that value, with no cells decoded.
    const one = isPayload(c.cells) ? (c.cells.form === 'uniform' ? c.cells.value : c.cells.form === 'air' ? 0 : -1) : 'uniform' in c.cells ? c.cells.uniform : -1;
    // A payload's cells are read as whole values; stored bytes through the codec's planes.
    let whole = false;
    let any = false;
    if (one > 0) checkRecordValue(one, 'surface fields job: a chunk of one value');
    else if (one < 0) {
      if (isPayload(c.cells) && c.cells.form === 'stored') {
        checkPayloadEdge(g, c.cells);
        RecordChunk.fromWire(g, c.cells.wire).toValues((packed ??= new Uint32Array(g.cellsPerChunk)));
        whole = true;
      } else if (!isPayload(c.cells)) any = decodeStoredChunk(g, c.cy, c.cells, decompress, d);
    }
    if (!any && !whole && one <= 0 && c.built === undefined) continue;
    // The chunk's columns that lie in the box (all of the middle column's, a strip of the others').
    const x0 = Math.max(0, -pad - c.dx * e);
    const x1 = Math.min(e, e + pad - c.dx * e);
    const z0 = Math.max(0, -pad - c.dz * e);
    const z1 = Math.min(e, e + pad - c.dz * e);
    const y0 = c.cy * e - oy;
    for (let lx = x0; lx < x1; lx++) for (let lz = z0; lz < z1; lz++) {
      const from = (lx * e + lz) * e;
      const to = ((c.dx * e + lx + pad) * side + (c.dz * e + lz + pad)) * rows + y0;
      if (one > 0) values.fill(one, to, to + e);
      else if (whole) values.set(packed!.subarray(from, from + e), to);
      else if (any) for (let y = 0; y < e; y++) {
        const m = material[from + y]!;
        if (m !== 0) values[to + y] = (m | (role[from + y]! << ROLE_SHIFT) | (shape[from + y]! << SHAPE_SHIFT) | (wetness[from + y]! << WETNESS_SHIFT)) >>> 0;
      }
      if (c.built !== undefined) for (let y = 0; y < e; y++) if (c.built[from + y] === 1) (built ??= new Uint8Array(values.length))[to + y] = 1;
    }
  }
  return { sx: side, sy: rows, sz: side, ox: input.cx * e - pad, oy, oz: input.cz * e - pad, cellM: mipCellMetres(input.level), values, built };
}

/** A job's answer: the block form over its column's footprint (edge × edge columns). */
export function surfaceFieldsOfColumn(input: SurfaceFieldsInput, decompress: (b: Uint8Array) => Uint8Array): SurfaceFieldColumns {
  const cells = surfaceFieldsCells(input, decompress);
  const pad = surfaceFieldsPad(input.level);
  return surfaceFields(cells, { x: pad, z: pad, w: input.edge, d: input.edge });
}

/**
 * A level-0 job's input from a store's chunks: the column (cx, cz) and the
 * eight round it, rows `cy0 … cy1`, each chunk that holds anything as a
 * payload (copied: the store keeps its own).
 */
export function surfaceFieldsInputOf(store: Pick<PaletteStore, 'grid' | 'chunkPayload'>, cx: number, cz: number, cy0: number, cy1: number, builtOf?: (cx: number, cy: number, cz: number) => Uint8Array | null): { input: SurfaceFieldsInput; transfer: ArrayBuffer[] } {
  const chunks: SurfaceFieldsChunk[] = [];
  const transfer: ArrayBuffer[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let cy = cy0; cy <= cy1; cy++) {
    const cells = store.chunkPayload(cx + dx, cy, cz + dz, true);
    const b = builtOf?.(cx + dx, cy, cz + dz) ?? null;
    if (cells.form === 'air' && b === null) continue;
    chunks.push(b === null ? { dx, dz, cy, cells } : { dx, dz, cy, cells, built: b.slice() });
  }
  for (const c of chunks) {
    if (isPayload(c.cells)) payloadTransfer(c.cells, transfer);
    if (c.built !== undefined) transfer.push(c.built.buffer as ArrayBuffer);
  }
  return { input: { edge: store.grid.edge as ChunkEdge, level: 0, cx, cz, chunks }, transfer };
}
