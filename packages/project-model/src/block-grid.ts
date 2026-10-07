/**
 * The in-memory block grid — decode a layer's chunks, read
 * and write cells, encode the touched chunks back, and the bulk edits the
 * `editBlocks` command applies (fill, cells, array, replace, metadata paint,
 * flood fill, raise/lower column, stamp, copy/move/mirror, regions,
 * heightmap import). The same grid serves the runtime (`ctx.grid`) and its
 * deterministic ray pick (a DDA over cells, independent of physics).
 *
 * Pure and deterministic: integer cell maths only (floating point appears
 * only in the world ↔ cell conversions and the ray pick, the same IEEE
 * operations everywhere).
 */
import {
  BLOCK_LIMITS,
  CHUNK_SIZE,
  REGION_ID_RE,
  blockTypeSlopes,
  validateBlockCell,
  blockCellKey,
  canonicalBlockCell,
  markCanonicalChunk,
  rotatedFootprint,
  type BlockCell,
  type BlockChunk,
  type BlockLayerComponent,
  type BlockLayerData,
  type BlockRegion,
  type BlockStamp,
  type BlockType,
  type CellField,
  type CellMetaValue,
} from './block-layers';
import { decodeBase64, decodePngRgba } from './png-decode';
import { SCULPT_LIMITS, SCULPT_OPS, sculptHeights, setColumnSurface, type SculptOp } from './block-sculpt';
import { PAINT_CHANNELS, decodeChunkPaint, encodeChunkPaint, isUnpainted, paintDab, unpaintedChunk, type PaintSurface } from './block-paint';
import { paintBrushError, type BrushFalloff } from './paint-brush';
import { edgeConnectNeighbours } from './block-connect';
import { canonicalBlockEdge, edgeInBounds, edgeInBox, transformEdge, validatePatternEdges, edgeLocalKey, edgesEditShapeError, edgesEditTargets, type BlockEdge, type EdgesEdit } from './block-edges';

// ---- keys ---------------------------------------------------------------------------

const OX = BLOCK_LIMITS.coordinateXZ;
const OY = BLOCK_LIMITS.coordinateY;
const SX = 2 * OX + 1;
const SY = 2 * OY + 1;

/** One number per cell (x, z within ±4096, y within ±1024). */
export function cellKeyOf(x: number, y: number, z: number): number {
  return ((x + OX) * SX + (z + OX)) * SY + (y + OY);
}
export function cellOfKey(k: number): [number, number, number] {
  const y = (k % SY) - OY;
  const r = Math.floor(k / SY);
  const z = (r % SX) - OX;
  const x = Math.floor(r / SX) - OX;
  return [x, y, z];
}
const chunkIndex = (v: number): number => Math.floor(v / CHUNK_SIZE);
export const chunkKeyOf = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * The memory a column takes besides its cells' 4 bytes each: its record, its
 * typed array's header and the chunk map's entry (measured on V8: 250-275
 * bytes a column on layers of 64 to 1,024 chunks). A layer's memory grows with
 * its columns more than its depth.
 */
export const BLOCK_COLUMN_BYTES = 270;
/** The memory an edge piece takes: its entry in its chunk's edge map (measured on V8: 28 bytes an edge in chunks of 256 edges). */
export const BLOCK_EDGE_BYTES = 28;

/** A layer's cells in memory (`BlockGrid.memory`). */
export interface BlockLayerMemory {
  chunks: number;
  columns: number;
  cells: number;
  /** Edge pieces (`block-edges.ts`). */
  edges: number;
  bytes: number;
}

/** An edge's local key (`edgeLocalKey`) back to lx, lz, y, axis. */
function edgeOfLocalKey(k: number): [number, number, number, number] {
  const lx = k % CHUNK_SIZE;
  const lz = Math.floor(k / CHUNK_SIZE) % CHUNK_SIZE;
  const r = Math.floor(k / (CHUNK_SIZE * CHUNK_SIZE));
  return [lx, lz, Math.floor(r / 2) - BLOCK_LIMITS.coordinateY, r % 2];
}

/** A column's cells: palette indices (−1 empty) from `y0` up. */
interface Column {
  y0: number;
  data: Int32Array;
}

/**
 * One layer's cells. Values are interned in a grid palette (a value never
 * changes once interned), so cells compare by index.
 */
export class BlockGrid {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly cellSize: [number, number, number];
  readonly metadataOnly: boolean;
  private readonly palette: BlockCell[] = [];
  private readonly keys = new Map<string, number>();
  /** chunk key → column index (lz * 16 + lx) → column. */
  private readonly chunks = new Map<string, Map<number, Column>>();
  /** The regions (id → boxes). */
  readonly regions = new Map<string, number[][]>();
  /** Each chunk's paint lattice (`block-paint.ts`); absent: unpainted. */
  private readonly paints = new Map<string, Uint8Array>();
  /** Each chunk's edge pieces: edge local key (`edgeLocalKey`) → palette index (edge values share the palette). */
  private readonly edgeChunks = new Map<string, Map<number, number>>();
  private edgeTotal = 0;
  /** Chunks written since the last `takeDirty` (keys). */
  private dirty = new Set<string>();
  /** Chunks whose meshes (render, collision) changed: the written ones and their neighbours across a written border cell. */
  private meshDirty = new Set<string>();
  private regionsDirty = new Set<string>();
  private count = 0;

  constructor(comp: BlockLayerComponent) {
    this.min = [comp.bounds.min[0], comp.bounds.min[1], comp.bounds.min[2]];
    this.max = [comp.bounds.max[0], comp.bounds.max[1], comp.bounds.max[2]];
    this.cellSize = [comp.cellSize[0], comp.cellSize[1], comp.cellSize[2]];
    this.metadataOnly = comp.metadataOnly === true;
  }

  /** A grid holding a layer's stored cells and regions. */
  static from(comp: BlockLayerComponent, data: BlockLayerData | undefined | null): BlockGrid {
    const g = new BlockGrid(comp);
    // Decoded column by column (no per-cell bookkeeping: a whole layer loads at once).
    for (const c of data?.chunks ?? []) {
      const local = c.palette.map((cell) => g.intern(cell));
      const ck = chunkKeyOf(c.cx, c.cz);
      let chunk = g.chunks.get(ck);
      if (chunk === undefined) g.chunks.set(ck, (chunk = new Map()));
      for (const col of c.columns) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let r = 2; r < col.length; r += 3) {
          lo = Math.min(lo, col[r]!);
          hi = Math.max(hi, col[r]! + col[r + 1]!);
        }
        if (!(hi > lo)) continue;
        const colData = new Int32Array(hi - lo).fill(-1);
        for (let r = 2; r < col.length; r += 3) {
          const p = local[col[r + 2]!]!;
          for (let y = col[r]!; y < col[r]! + col[r + 1]!; y++) {
            if (colData[y - lo]! < 0) g.count += 1;
            colData[y - lo] = p;
          }
        }
        chunk.set(col[1]! * CHUNK_SIZE + col[0]!, { y0: lo, data: colData });
      }
      const paint = decodeChunkPaint(c.paint);
      if (paint !== null) g.paints.set(ck, paint);
      if (c.edges !== undefined && c.edgePalette !== undefined && c.edges.length > 0) {
        const values = c.edgePalette.map((e) => g.internEdge(e));
        const map = new Map<number, number>();
        for (const r of c.edges) map.set(edgeLocalKey(r[0]!, r[1]!, r[2]!, r[3]!), values[r[4]!]!);
        g.edgeChunks.set(ck, map);
        g.edgeTotal += map.size;
      }
    }
    for (const r of data?.regions ?? []) g.regions.set(r.regionId, r.boxes.map((b) => [...b]));
    g.dirty.clear();
    g.meshDirty.clear();
    g.regionsDirty.clear();
    return g;
  }

  /** The number of stored cells. */
  get size(): number {
    return this.count;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= this.min[0] && x < this.max[0] && y >= this.min[1] && y < this.max[1] && z >= this.min[2] && z < this.max[2];
  }

  /** The palette index of a value (interned on first use). */
  intern(cell: BlockCell): number {
    const c = canonicalBlockCell(cell);
    const k = JSON.stringify(c);
    let i = this.keys.get(k);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(Object.freeze({ ...c, ...(c.meta !== undefined ? { meta: Object.freeze({ ...c.meta }) } : {}) }) as BlockCell);
      this.keys.set(k, i);
    }
    return i;
  }

  /** The palette index of an edge value (edges and cells share the palette; an edge's key is its canonical form). */
  internEdge(edge: BlockEdge): number {
    const e = canonicalBlockEdge(edge);
    const k = JSON.stringify(e);
    let i = this.keys.get(k);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(Object.freeze(e) as BlockCell);
      this.keys.set(k, i);
    }
    return i;
  }

  valueOf(index: number): BlockCell {
    return this.palette[index] as BlockCell;
  }

  /** An edge value by its palette index. */
  edgeValueOf(index: number): BlockEdge {
    return this.palette[index] as unknown as BlockEdge;
  }

  /** Every distinct cell value the layer has held (what a renderer may need looks for before meshing). */
  paletteCells(): readonly BlockCell[] {
    return this.palette;
  }

  private column(x: number, z: number, create: boolean): Column | undefined {
    const ck = chunkKeyOf(chunkIndex(x), chunkIndex(z));
    let chunk = this.chunks.get(ck);
    if (chunk === undefined) {
      if (!create) return undefined;
      chunk = new Map();
      this.chunks.set(ck, chunk);
    }
    const ci = (z - chunkIndex(z) * CHUNK_SIZE) * CHUNK_SIZE + (x - chunkIndex(x) * CHUNK_SIZE);
    let col = chunk.get(ci);
    if (col === undefined && create) {
      col = { y0: 0, data: new Int32Array(0) };
      chunk.set(ci, col);
    }
    return col;
  }

  /** The palette index at a cell (−1: empty). */
  indexAt(x: number, y: number, z: number): number {
    const col = this.column(x, z, false);
    if (col === undefined) return -1;
    const i = y - col.y0;
    return i >= 0 && i < col.data.length ? col.data[i]! : -1;
  }

  get(x: number, y: number, z: number): BlockCell | null {
    const i = this.indexAt(x, y, z);
    return i < 0 ? null : (this.palette[i] as BlockCell);
  }

  // ---- Edge pieces ----------------------------------------------------------

  /** The number of edge pieces. */
  get edgeCount(): number {
    return this.edgeTotal;
  }

  /** Whether an edge lies within the bounds (one past the cells along its axis). */
  edgeInBounds(x: number, y: number, z: number, axis: number): boolean {
    return edgeInBounds(this.min, this.max, x, y, z, axis);
  }

  /** The palette index of the edge piece at (x, y, z, axis) (−1: none). */
  edgeIndexAt(x: number, y: number, z: number, axis: number): number {
    const cx = chunkIndex(x);
    const cz = chunkIndex(z);
    return this.edgeChunks.get(chunkKeyOf(cx, cz))?.get(edgeLocalKey(x - cx * CHUNK_SIZE, z - cz * CHUNK_SIZE, y, axis)) ?? -1;
  }

  edgeAt(x: number, y: number, z: number, axis: number): BlockEdge | null {
    const i = this.edgeIndexAt(x, y, z, axis);
    return i < 0 ? null : this.edgeValueOf(i);
  }

  /** Write an edge piece's palette index (−1 removes it); returns whether it changed. Only its own chunk re-meshes (edges hide no faces). */
  setEdgeIndex(x: number, y: number, z: number, axis: number, index: number): boolean {
    const cx = chunkIndex(x);
    const cz = chunkIndex(z);
    const ck = chunkKeyOf(cx, cz);
    const lk = edgeLocalKey(x - cx * CHUNK_SIZE, z - cz * CHUNK_SIZE, y, axis);
    let map = this.edgeChunks.get(ck);
    const before = map?.get(lk) ?? -1;
    if (before === index) return false;
    if (index < 0) {
      map!.delete(lk);
      this.edgeTotal -= 1;
      if (map!.size === 0) this.edgeChunks.delete(ck);
    } else {
      if (map === undefined) this.edgeChunks.set(ck, (map = new Map()));
      map.set(lk, index);
      if (before < 0) this.edgeTotal += 1;
    }
    this.dirty.add(ck);
    this.meshDirty.add(ck);
    // A piece that came or went changes the connected looks of the edges meeting it (`block-connect.ts`): at a chunk
    // border some of those are the next chunk's. Opening or closing a piece changes no look.
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    if ((lx === 0 || lx === CHUNK_SIZE - 1 || lz === 0 || lz === CHUNK_SIZE - 1) && (before < 0 || index < 0 || this.edgeValueOf(before).block !== this.edgeValueOf(index).block)) {
      for (const [nx, , nz] of edgeConnectNeighbours(x, y, z, axis)) this.meshDirty.add(chunkKeyOf(chunkIndex(nx), chunkIndex(nz)));
    }
    return true;
  }

  setEdge(x: number, y: number, z: number, axis: number, edge: BlockEdge | null): boolean {
    return this.setEdgeIndex(x, y, z, axis, edge === null ? -1 : this.internEdge(edge));
  }

  /** Every edge piece of a chunk (y, axis, z, x ascending). */
  forEachEdgeInChunk(ck: string, cb: (x: number, y: number, z: number, axis: number, index: number) => void): void {
    const map = this.edgeChunks.get(ck);
    if (map === undefined) return;
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    for (const lk of [...map.keys()].sort((a, b) => a - b)) {
      const [lx, lz, y, axis] = edgeOfLocalKey(lk);
      cb(cx * CHUNK_SIZE + lx, y, cz * CHUNK_SIZE + lz, axis, map.get(lk)!);
    }
  }

  /** Every edge piece (chunks in key order). */
  forEachEdge(cb: (x: number, y: number, z: number, axis: number, index: number) => void): void {
    for (const ck of [...this.edgeChunks.keys()].sort(compareChunkKeys)) this.forEachEdgeInChunk(ck, cb);
  }

  /** Write a palette index (−1 clears); returns whether the cell changed. */
  setIndex(x: number, y: number, z: number, index: number): boolean {
    const before = this.indexAt(x, y, z);
    if (before === index) return false;
    const col = this.column(x, z, index >= 0) as Column | undefined;
    if (col === undefined) return false;
    if (index >= 0) {
      if (col.data.length === 0) {
        col.y0 = y;
        col.data = new Int32Array(1).fill(-1);
      } else if (y < col.y0 || y >= col.y0 + col.data.length) {
        const lo = Math.min(col.y0, y);
        const hi = Math.max(col.y0 + col.data.length, y + 1);
        const next = new Int32Array(hi - lo).fill(-1);
        next.set(col.data, col.y0 - lo);
        col.y0 = lo;
        col.data = next;
      }
    }
    col.data[y - col.y0] = index;
    if (before < 0) this.count += 1;
    if (index < 0) this.count -= 1;
    const cx = chunkIndex(x);
    const cz = chunkIndex(z);
    const own = chunkKeyOf(cx, cz);
    this.dirty.add(own);
    this.meshDirty.add(own);
    // A face on a chunk border changes the neighbour chunk's meshing too.
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    if (lx === 0) this.meshDirty.add(chunkKeyOf(cx - 1, cz));
    if (lx === CHUNK_SIZE - 1) this.meshDirty.add(chunkKeyOf(cx + 1, cz));
    if (lz === 0) this.meshDirty.add(chunkKeyOf(cx, cz - 1));
    if (lz === CHUNK_SIZE - 1) this.meshDirty.add(chunkKeyOf(cx, cz + 1));
    // A corner cell touches the diagonal chunk's corner vertex (smoothed tops average across it).
    const ex = lx === 0 ? -1 : lx === CHUNK_SIZE - 1 ? 1 : 0;
    const ez = lz === 0 ? -1 : lz === CHUNK_SIZE - 1 ? 1 : 0;
    if (ex !== 0 && ez !== 0) this.meshDirty.add(chunkKeyOf(cx + ex, cz + ez));
    return true;
  }

  set(x: number, y: number, z: number, cell: BlockCell | null): boolean {
    return this.setIndex(x, y, z, cell === null ? -1 : this.intern(cell));
  }

  /** Replace one chunk's cells with a stored chunk (null: empty it) — a renderer's copy following the simulation. */
  replaceChunk(cx: number, cz: number, chunk: BlockChunk | null): void {
    const ck = chunkKeyOf(cx, cz);
    const clear: [number, number, number][] = [];
    this.forEachInChunk(ck, (x, y, z) => clear.push([x, y, z]));
    const next = new Map<number, number>();
    if (chunk !== null) {
      const local = chunk.palette.map((c) => this.intern(c));
      for (const col of chunk.columns) {
        const x = cx * CHUNK_SIZE + col[0]!;
        const z = cz * CHUNK_SIZE + col[1]!;
        for (let r = 2; r < col.length; r += 3) for (let y = col[r]!; y < col[r]! + col[r + 1]!; y++) next.set(cellKeyOf(x, y, z), local[col[r + 2]!]!);
      }
    }
    for (const [x, y, z] of clear) if (!next.has(cellKeyOf(x, y, z))) this.setIndex(x, y, z, -1);
    for (const [k, idx] of next) {
      const [x, y, z] = cellOfKey(k);
      this.setIndex(x, y, z, idx);
    }
    // Its edge pieces follow.
    const nextEdges = new Map<number, number>();
    if (chunk?.edges !== undefined && chunk.edgePalette !== undefined) {
      const values = chunk.edgePalette.map((e) => this.internEdge(e));
      for (const r of chunk.edges) nextEdges.set(edgeLocalKey(r[0]!, r[1]!, r[2]!, r[3]!), values[r[4]!]!);
    }
    const edgeCells: [number, number, number, number][] = [];
    this.forEachEdgeInChunk(ck, (x, y, z, axis) => edgeCells.push([x, y, z, axis]));
    for (const [x, y, z, axis] of edgeCells) if (!nextEdges.has(edgeLocalKey(x - cx * CHUNK_SIZE, z - cz * CHUNK_SIZE, y, axis))) this.setEdgeIndex(x, y, z, axis, -1);
    for (const [lk, idx] of nextEdges) {
      const [lx, lz, y, axis] = edgeOfLocalKey(lk);
      this.setEdgeIndex(cx * CHUNK_SIZE + lx, y, cz * CHUNK_SIZE + lz, axis, idx);
    }
    // The chunk's paint follows too (only this chunk's meshes read it).
    const paint = chunk !== null ? decodeChunkPaint(chunk.paint) : null;
    const had = this.paints.get(ck) ?? null;
    const same = paint === null ? had === null || isUnpainted(had) : had !== null && had.length === paint.length && had.every((v, i) => v === paint[i]);
    if (!same) {
      if (paint === null) this.paints.delete(ck);
      else this.paints.set(ck, paint);
      this.dirty.add(ck);
      this.meshDirty.add(ck);
    }
  }

  // ---- Paint ------------------------------------------------------------

  /** A chunk's paint lattice (null: unpainted). */
  chunkPaint(cx: number, cz: number): Uint8Array | null {
    return this.paints.get(chunkKeyOf(cx, cz)) ?? null;
  }

  /** Whether any chunk of the layer is painted (its chunk meshes then carry paint colours). */
  hasPaint(): boolean {
    for (const p of this.paints.values()) if (!isUnpainted(p)) return true;
    return false;
  }

  /** The paint surface of `paintDab`: chunks with cells, their lattices made on first write. */
  paintSurface(): PaintSurface {
    return {
      minX: this.min[0],
      maxX: this.max[0],
      minZ: this.min[2],
      maxZ: this.max[2],
      lattice: (cx, cz) => {
        const ck = chunkKeyOf(cx, cz);
        if (!this.chunkHasCells(ck)) return null;
        let l = this.paints.get(ck);
        if (l === undefined) this.paints.set(ck, (l = unpaintedChunk()));
        return l;
      },
      touched: (cx, cz) => {
        const ck = chunkKeyOf(cx, cz);
        this.dirty.add(ck);
        this.meshDirty.add(ck);
      },
    };
  }

  /** The highest cell of a column holding a block (or any cell with `anyCell`), or null. */
  columnTop(x: number, z: number, anyCell = false): number | null {
    const col = this.column(x, z, false);
    if (col === undefined) return null;
    for (let i = col.data.length - 1; i >= 0; i--) {
      const p = col.data[i]!;
      if (p >= 0 && (anyCell || this.palette[p]!.block !== undefined)) return col.y0 + i;
    }
    return null;
  }

  /** Every stored cell (chunks in key order, columns z then x, y ascending). */
  forEach(cb: (x: number, y: number, z: number, index: number) => void): void {
    for (const ck of [...this.chunks.keys()].sort(compareChunkKeys)) this.forEachInChunk(ck, cb);
  }

  forEachInChunk(ck: string, cb: (x: number, y: number, z: number, index: number) => void): void {
    const chunk = this.chunks.get(ck);
    if (chunk === undefined) return;
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    for (const ci of [...chunk.keys()].sort((a, b) => a - b)) {
      const col = chunk.get(ci)!;
      const x = cx * CHUNK_SIZE + (ci % CHUNK_SIZE);
      const z = cz * CHUNK_SIZE + Math.floor(ci / CHUNK_SIZE);
      for (let i = 0; i < col.data.length; i++) if (col.data[i]! >= 0) cb(x, col.y0 + i, z, col.data[i]!);
    }
  }

  /** Every stored cell of one column (y ascending); nothing for a column outside the stored chunks. */
  forEachInColumn(x: number, z: number, cb: (y: number, index: number) => void): void {
    const col = this.column(x, z, false);
    if (col === undefined) return;
    for (let i = 0; i < col.data.length; i++) if (col.data[i]! >= 0) cb(col.y0 + i, col.data[i]!);
  }

  /**
   * What the layer's cells take in memory: its chunks, columns and cells, and
   * the bytes (the columns' cell arrays and paint lattices, plus
   * {@link BLOCK_COLUMN_BYTES} of bookkeeping per column).
   */
  memory(): BlockLayerMemory {
    let chunks = 0;
    let columns = 0;
    let bytes = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.size > 0) chunks += 1;
      columns += chunk.size;
      for (const col of chunk.values()) bytes += col.data.byteLength;
    }
    for (const paint of this.paints.values()) bytes += paint.byteLength;
    for (const ck of this.edgeChunks.keys()) if ((this.chunks.get(ck)?.size ?? 0) === 0) chunks += 1;
    return { chunks, columns, cells: this.count, edges: this.edgeTotal, bytes: bytes + columns * BLOCK_COLUMN_BYTES + this.edgeTotal * BLOCK_EDGE_BYTES };
  }

  /** The chunk keys holding cells or edge pieces, sorted (cz, cx). */
  chunkKeys(): string[] {
    const keys = new Set([...this.chunks.keys()].filter((k) => this.chunkHasCells(k)));
    for (const k of this.edgeChunks.keys()) keys.add(k);
    return [...keys].sort(compareChunkKeys);
  }

  private chunkHasCells(ck: string): boolean {
    const chunk = this.chunks.get(ck);
    if (chunk === undefined) return false;
    for (const col of chunk.values()) for (const v of col.data) if (v >= 0) return true;
    return false;
  }

  /** One chunk in the canonical stored form (null: no cells and no edge pieces). */
  encodeChunk(ck: string): BlockChunk | null {
    const chunk = this.chunks.get(ck) ?? new Map<number, Column>();
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    const remap = new Map<number, number>();
    const palette: BlockCell[] = [];
    const columns: number[][] = [];
    for (const ci of [...chunk.keys()].sort((a, b) => a - b)) {
      const col = chunk.get(ci)!;
      const row = [ci % CHUNK_SIZE, Math.floor(ci / CHUNK_SIZE)];
      let runStart = 0;
      let runIndex = -1;
      const flush = (end: number): void => {
        if (runIndex < 0) return;
        let q = remap.get(runIndex);
        if (q === undefined) {
          q = palette.length;
          remap.set(runIndex, q);
          const v = this.palette[runIndex]!;
          palette.push({ ...v, ...(v.meta !== undefined ? { meta: { ...v.meta } } : {}) });
        }
        row.push(col.y0 + runStart, end - runStart, q);
      };
      for (let i = 0; i < col.data.length; i++) {
        const v = col.data[i]!;
        if (v !== runIndex) {
          flush(i);
          runStart = i;
          runIndex = v;
        }
      }
      flush(col.data.length);
      if (row.length > 2) columns.push(row);
    }
    const edges = this.encodeEdges(ck);
    if (columns.length === 0 && edges === null) return null;
    const paint = this.paints.get(ck);
    return markCanonicalChunk({ cx, cz, palette, columns, ...(edges ?? {}), ...(paint !== undefined && !isUnpainted(paint) ? { paint: encodeChunkPaint(paint) } : {}) });
  }

  /** A chunk's edge pieces in the canonical stored form (rows in local key order, palette by first use; null: none). */
  private encodeEdges(ck: string): { edgePalette: BlockEdge[]; edges: number[][] } | null {
    const map = this.edgeChunks.get(ck);
    if (map === undefined || map.size === 0) return null;
    const remap = new Map<number, number>();
    const edgePalette: BlockEdge[] = [];
    const edges: number[][] = [];
    for (const lk of [...map.keys()].sort((a, b) => a - b)) {
      const idx = map.get(lk)!;
      let q = remap.get(idx);
      if (q === undefined) {
        q = edgePalette.length;
        remap.set(idx, q);
        edgePalette.push({ ...this.edgeValueOf(idx) });
      }
      const [lx, lz, y, axis] = edgeOfLocalKey(lk);
      edges.push([lx, lz, y, axis, q]);
    }
    return { edgePalette, edges };
  }

  /** The chunks written since the last call (keys, sorted), the chunks to re-mesh, and the regions changed. */
  takeDirty(): { chunks: string[]; mesh: string[]; regions: string[] } {
    const out = { chunks: [...this.dirty].sort(compareChunkKeys), mesh: [...this.meshDirty].sort(compareChunkKeys), regions: [...this.regionsDirty].sort() };
    this.dirty = new Set();
    this.meshDirty = new Set();
    this.regionsDirty = new Set();
    return out;
  }

  markRegionDirty(id: string): void {
    this.regionsDirty.add(id);
  }

  /**
   * The layer data after edits: the chunks in `changed` re-encoded, every
   * other chunk object kept from `previous` (unchanged chunks keep their
   * identity, so storage writes and checks skip them). Null: nothing left.
   */
  toData(entityId: string, previous: BlockLayerData | null | undefined, changed: readonly string[]): BlockLayerData | null {
    const byKey = new Map<string, BlockChunk>();
    for (const c of previous?.chunks ?? []) byKey.set(chunkKeyOf(c.cx, c.cz), c);
    for (const ck of changed) {
      const c = this.encodeChunk(ck);
      if (c === null) {
        byKey.delete(ck);
        // A chunk without cells keeps no paint.
        this.paints.delete(ck);
      } else byKey.set(ck, c);
    }
    const chunks = [...byKey.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
    const regions: BlockRegion[] = [...this.regions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([regionId, boxes]) => ({ regionId, boxes: boxes.map((b) => [...b]) }));
    if (chunks.length === 0 && regions.length === 0) return null;
    return { entityId, ...(chunks.length > 0 ? { chunks } : {}), ...(regions.length > 0 ? { regions } : {}) };
  }
}

export function compareChunkKeys(a: string, b: string): number {
  const [ax, az] = a.split(',').map(Number) as [number, number];
  const [bx, bz] = b.split(',').map(Number) as [number, number];
  return az - bz || ax - bx;
}

// ---- metadata ---------------------------------------------------------------------------

/** A cell's effective metadata: the schema defaults, then the block's defaults, then the cell's overrides. */
export function effectiveCellMeta(cell: BlockCell | null, types: ReadonlyMap<string, BlockType>, fields: readonly CellField[]): Record<string, CellMetaValue> {
  const out: Record<string, CellMetaValue> = {};
  for (const f of fields) out[f.key] = f.default ?? (f.type === 'bool' ? false : f.type === 'enum' ? (f.values?.[0] ?? '') : f.type === 'string' ? '' : 0);
  if (cell === null) return out;
  const t = cell.block !== undefined ? types.get(cell.block) : undefined;
  if (t?.metadata !== undefined) Object.assign(out, t.metadata);
  if (cell.meta !== undefined) Object.assign(out, cell.meta);
  return out;
}

// ---- regions ------------------------------------------------------------------------------

export function boxContains(b: readonly number[], x: number, y: number, z: number): boolean {
  return x >= b[0]! && x < b[3]! && y >= b[1]! && y < b[4]! && z >= b[2]! && z < b[5]!;
}

export function regionContains(boxes: readonly (readonly number[])[], x: number, y: number, z: number): boolean {
  for (const b of boxes) if (boxContains(b, x, y, z)) return true;
  return false;
}

/** `a` minus `b` (up to six boxes). */
export function subtractBox(a: readonly number[], b: readonly number[]): number[][] {
  const [ax0, ay0, az0, ax1, ay1, az1] = a as [number, number, number, number, number, number];
  const [bx0, by0, bz0, bx1, by1, bz1] = b as [number, number, number, number, number, number];
  if (bx0 >= ax1 || bx1 <= ax0 || by0 >= ay1 || by1 <= ay0 || bz0 >= az1 || bz1 <= az0) return [[...a]];
  const out: number[][] = [];
  const x0 = Math.max(ax0, bx0);
  const x1 = Math.min(ax1, bx1);
  const y0 = Math.max(ay0, by0);
  const y1 = Math.min(ay1, by1);
  if (ax0 < x0) out.push([ax0, ay0, az0, x0, ay1, az1]);
  if (x1 < ax1) out.push([x1, ay0, az0, ax1, ay1, az1]);
  if (ay0 < y0) out.push([x0, ay0, az0, x1, y0, az1]);
  if (y1 < ay1) out.push([x0, y1, az0, x1, ay1, az1]);
  if (az0 < bz0) out.push([x0, y0, az0, x1, y1, bz0]);
  if (bz1 < az1) out.push([x0, y0, bz1, x1, y1, az1]);
  return out;
}

/** The cells of a region in a stable order (boxes in order, x, then z, then y), at most `limit` (null: more). */
export function regionCells(boxes: readonly (readonly number[])[], limit: number): [number, number, number][] | null {
  const seen = new Set<number>();
  const out: [number, number, number][] = [];
  for (const b of boxes) {
    for (let y = b[1]!; y < b[4]!; y++)
      for (let z = b[2]!; z < b[5]!; z++)
        for (let x = b[0]!; x < b[3]!; x++) {
          const k = cellKeyOf(x, y, z);
          if (seen.has(k)) continue;
          seen.add(k);
          if (out.length >= limit) return null;
          out.push([x, y, z]);
        }
  }
  return out;
}

// ---- edits --------------------------------------------------------------------------------

export type BlockRotation = 0 | 90 | 180 | 270;

/** One bulk edit of `editBlocks` (boxes are `[x0, y0, z0, x1, y1, z1]`, max exclusive). */
export type BlockEdit =
  /** Set every cell of a box (`cell: null` erases); `keep`: only empty cells; `replace`: only occupied cells. */
  | { kind: 'fill'; box: number[]; cell: BlockCell | null; mode?: 'set' | 'keep' | 'replace' }
  /** Set listed cells (`at` = x, y, z, x, y, z, …). */
  | { kind: 'cells'; at: number[]; cell: BlockCell | null }
  /**
   * Set cells from an array: `size` cells from `origin`, x fastest, then z,
   * then y; `data` = run-length pairs [count, index, …] into `palette`
   * (null entries erase; index −1 leaves a cell as it is).
   */
  | { kind: 'array'; origin: number[]; size: number[]; palette: (BlockCell | null)[]; data: number[]; edgePalette?: BlockEdge[]; edges?: number[][] }
  /** Replace the block of every cell matching `match` (metadata overrides kept); in `box` or the whole layer. */
  | { kind: 'replace'; match: { block: string | null; rot?: BlockRotation; variant?: number }; cell: BlockCell | null; box?: number[] }
  /** Paint metadata: set (or remove with null) fields on cells of `box` / `at`; empty cells become metadata-only cells unless `occupiedOnly`. */
  | { kind: 'meta'; set: Record<string, CellMetaValue | null>; box?: number[]; at?: number[]; occupiedOnly?: boolean }
  /** Flood fill from `at`: the connected cells equal to it (4-connected in its xz plane, or 6-connected with `xyz`). */
  | { kind: 'flood'; at: number[]; cell: BlockCell | null; connectivity?: 'xz' | 'xyz' }
  /** Raise (delta > 0: add `cell`, default a copy of the top block) or lower (delta < 0: remove top blocks) columns (`at` = x, z, …). */
  | { kind: 'column'; at: number[]; delta: number; cell?: BlockCell }
  /** Place a stamp with its min corner at `at` (turned, mirrored); `keep`: only into empty cells. */
  | { kind: 'stamp'; stampId: string; at: number[]; rot?: BlockRotation; mirror?: 'x' | 'z'; mode?: 'set' | 'keep' }
  /** Copy (or move) the cells of `box` so its min corner lands at `to`, turned and mirrored about the box. */
  | { kind: 'copy'; box: number[]; to: number[]; rot?: BlockRotation; mirror?: 'x' | 'z'; move?: boolean; mode?: 'set' | 'keep' }
  /** Region CRUD: set / add / remove (subtract) boxes, delete, or rename to `to`. */
  | { kind: 'region'; regionId: string; op: 'set' | 'add' | 'remove' | 'delete' | 'rename'; boxes?: number[][]; to?: string }
  /**
   * Import a heightmap: a greyscale PNG (base64) sets column heights from
   * `origin` (x, z; image x → +x, image rows → +z): `round(value / 255 ×
   * scale)` cells of `cell` from `y` up (above cleared unless `keepAbove`).
   * An optional colour PNG of the same size picks each column's cell by the
   * nearest colour of `colors.map`.
   */
  | { kind: 'heightmap'; png: string; origin: number[]; y: number; scale: number; cell: BlockCell; keepAbove?: boolean; colors?: { png: string; map: { color: string; cell: BlockCell }[] } }
  /**
   * Set column top surfaces: `columns` = x, z, then the four corner heights
   * (−x−z, +x−z, +x+z, −x+z) in rows of the layer (3.25: a quarter cell over
   * row 3's bottom), per column. The column grows (with `cell`, else its top
   * block) or shrinks to it; its top cell holds the corners.
   */
  | { kind: 'surface'; columns: number[]; cell?: BlockCell }
  /**
   * A terrain brush dab: raise, lower, smooth or flatten (to `height`, rows)
   * the column tops under a round brush at `at` (x, z in columns; vertices at
   * whole numbers) of `radius` cells; `strength` is cells at the centre
   * (raise/lower) or the blend toward the target (smooth/flatten, 0-1).
   * Empty columns grow only with `cell`.
   */
  | { kind: 'sculpt'; op: SculptOp; at: number[]; radius: number; strength: number; height?: number; cell?: BlockCell }
  /**
   * A paint brush dab on the layer's surface paint: `channel`
   * 0-3 paints that material layer (its weight grows, the others give way),
   * 4 the wetness; `erase` takes it away. At `at` (x, z in columns;
   * lattice vertices at whole numbers), `radius` cells, `strength` the blend
   * toward the target per dab at the centre (0-1], `falloff` smooth (default),
   * linear or constant. Only chunks holding cells are painted.
   */
  | { kind: 'paint'; at: number[]; radius: number; strength: number; channel: number; falloff?: BrushFalloff; erase?: boolean }
  /** Edge pieces (`block-edges.ts`): set (or remove with null) the edges at `at` (x, y, z, axis, …) or on and inside `box`; `keep`: only where none stands. */
  | EdgesEdit;

export const BLOCK_EDIT_KINDS = ['fill', 'cells', 'array', 'replace', 'meta', 'flood', 'column', 'stamp', 'copy', 'region', 'heightmap', 'surface', 'sculpt', 'paint', 'edges'] as const;

const EDIT_KEYS: Record<(typeof BLOCK_EDIT_KINDS)[number], { required: string[]; optional: string[] }> = {
  fill: { required: ['box', 'cell'], optional: ['mode'] },
  cells: { required: ['at', 'cell'], optional: [] },
  array: { required: ['origin', 'size', 'palette', 'data'], optional: ['edgePalette', 'edges'] },
  replace: { required: ['match', 'cell'], optional: ['box'] },
  meta: { required: ['set'], optional: ['box', 'at', 'occupiedOnly'] },
  flood: { required: ['at', 'cell'], optional: ['connectivity'] },
  column: { required: ['at', 'delta'], optional: ['cell'] },
  stamp: { required: ['stampId', 'at'], optional: ['rot', 'mirror', 'mode'] },
  copy: { required: ['box', 'to'], optional: ['rot', 'mirror', 'move', 'mode'] },
  region: { required: ['regionId', 'op'], optional: ['boxes', 'to'] },
  heightmap: { required: ['png', 'origin', 'y', 'scale', 'cell'], optional: ['keepAbove', 'colors'] },
  surface: { required: ['columns'], optional: ['cell'] },
  sculpt: { required: ['op', 'at', 'radius', 'strength'], optional: ['height', 'cell'] },
  paint: { required: ['at', 'radius', 'strength', 'channel'], optional: ['falloff', 'erase'] },
  edges: { required: ['edge'], optional: ['at', 'box', 'mode'] },
};

/**
 * The shape of `editBlocks` edits (the command's argument rules): kinds,
 * keys, integer vectors, cell values. Values the layer decides (bounds,
 * stamps, regions present) are the apply step's. Null: valid.
 */
export function blockEditsShapeError(edits: unknown): { path: string; message: string; code: 'field_type' | 'field_value' | 'field_missing' | 'field_unexpected' } | null {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const ints = (v: unknown, n?: number): boolean => Array.isArray(v) && (n === undefined || v.length === n) && v.every((x) => Number.isSafeInteger(x));
  const cellOk = (v: unknown, nullable: boolean): string | null => {
    if (v === null) return nullable ? null : 'a cell value (not null)';
    const errors: import('./errors').ModelErrorV2[] = [];
    validateBlockCell(v, '', errors);
    return errors.length > 0 ? `${errors[0]!.path || 'cell'}: ${errors[0]!.message}` : null;
  };
  if (!Array.isArray(edits)) return { path: '/args/edits', message: 'edits is an array of edits', code: 'field_type' };
  if (edits.length < 1 || edits.length > BLOCK_EDIT_MAX_EDITS) return { path: '/args/edits', message: `1-${BLOCK_EDIT_MAX_EDITS} edits per command`, code: 'field_value' };
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const p = `/args/edits/${i}`;
    if (!isObj(e)) return { path: p, message: 'an edit is an object {kind, …}', code: 'field_type' };
    const kind = e['kind'] as (typeof BLOCK_EDIT_KINDS)[number];
    if (!BLOCK_EDIT_KINDS.includes(kind)) return { path: `${p}/kind`, message: `kind is one of ${BLOCK_EDIT_KINDS.join(', ')}`, code: 'field_value' };
    const keys = EDIT_KEYS[kind];
    for (const k of Object.keys(e)) if (k !== 'kind' && !keys.required.includes(k) && !keys.optional.includes(k)) return { path: `${p}/${k}`, message: `a ${kind} edit takes ${[...keys.required, ...keys.optional].join(', ')}`, code: 'field_unexpected' };
    for (const k of keys.required) if (e[k] === undefined) return { path: `${p}/${k}`, message: `a ${kind} edit needs ${k}`, code: 'field_missing' };
    const bad = (k: string, message: string): { path: string; message: string; code: 'field_value' } => ({ path: `${p}/${k}`, message, code: 'field_value' });
    if (e['box'] !== undefined && !ints(e['box'], 6)) return bad('box', 'box is [x0, y0, z0, x1, y1, z1] integers (max exclusive)');
    if (e['cell'] !== undefined) {
      const c = cellOk(e['cell'], kind !== 'column' && kind !== 'heightmap' && kind !== 'surface' && kind !== 'sculpt');
      if (c !== null) return bad('cell', c);
    }
    if (e['mode'] !== undefined && !(kind === 'fill' ? ['set', 'keep', 'replace'] : ['set', 'keep']).includes(e['mode'] as string)) return bad('mode', kind === 'fill' ? 'mode is set, keep or replace' : 'mode is set or keep');
    if (e['rot'] !== undefined && ![0, 90, 180, 270].includes(e['rot'] as number)) return bad('rot', 'rot is 0, 90, 180 or 270');
    if (e['mirror'] !== undefined && e['mirror'] !== 'x' && e['mirror'] !== 'z') return bad('mirror', 'mirror is "x" or "z"');
    for (const k of ['move', 'occupiedOnly', 'keepAbove', 'erase']) if (e[k] !== undefined && typeof e[k] !== 'boolean') return bad(k, `${k} is a boolean`);
    switch (kind) {
      case 'edges': {
        const ee = edgesEditShapeError(e);
        if (ee !== null) return bad(ee.key, ee.message);
        break;
      }
      case 'cells':
      case 'meta':
        if (e['at'] !== undefined && (!ints(e['at']) || (e['at'] as number[]).length % 3 !== 0 || (e['at'] as number[]).length === 0)) return bad('at', 'at is a flat list of integer x, y, z triples');
        if (kind === 'meta') {
          if (!isObj(e['set']) || Object.keys(e['set']).length === 0) return bad('set', 'set is a map field → value (null removes the field)');
          for (const [k, v] of Object.entries(e['set'])) if (v !== null && typeof v !== 'boolean' && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return bad(`set/${k}`, 'a metadata value is a boolean, number, string or null');
          if (e['box'] === undefined && e['at'] === undefined) return { path: `${p}/box`, message: 'a meta edit needs box or at', code: 'field_missing' };
        }
        break;
      case 'array': {
        if (!ints(e['origin'], 3)) return bad('origin', 'origin is [x, y, z] integers');
        if (!ints(e['size'], 3) || !(e['size'] as number[]).every((v) => v >= 1 && v <= BLOCK_LIMITS.layerWidth)) return bad('size', `size is [w, h, d], each 1-${BLOCK_LIMITS.layerWidth}`);
        const pal = e['palette'];
        if (!Array.isArray(pal) || pal.length < 1 || pal.length > BLOCK_LIMITS.chunkPalette) return bad('palette', `palette is 1-${BLOCK_LIMITS.chunkPalette} cell values (null erases)`);
        for (let k = 0; k < pal.length; k++) {
          const c = cellOk(pal[k], true);
          if (c !== null) return bad(`palette/${k}`, c);
        }
        const data = e['data'];
        if (!ints(data) || (data as number[]).length % 2 !== 0 || (data as number[]).some((v, k) => (k % 2 === 0 ? v < 1 : v < -1))) return bad('data', 'data is run-length pairs [count >= 1, palette index (or -1: leave the cell)]');
        // The array's edge pieces (a selection pasted into another layer carries its walls).
        const edgeErrors: import('./errors').ModelErrorV2[] = [];
        validatePatternEdges(e['edgePalette'], e['edges'], '', e['size'] as number[], edgeErrors);
        if (edgeErrors.length > 0) return { path: `${p}${edgeErrors[0]!.path}`, message: edgeErrors[0]!.message, code: 'field_value' };
        break;
      }
      case 'replace': {
        const m = e['match'];
        if (!isObj(m) || !('block' in m) || !(m['block'] === null || (typeof m['block'] === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(m['block']))) || Object.keys(m).some((k) => !['block', 'rot', 'variant'].includes(k))) return bad('match', 'match is {block: id | null, rot?, variant?}');
        if (m['rot'] !== undefined && ![0, 90, 180, 270].includes(m['rot'] as number)) return bad('match/rot', 'rot is 0, 90, 180 or 270');
        if (m['variant'] !== undefined && !(Number.isSafeInteger(m['variant']) && (m['variant'] as number) >= 0)) return bad('match/variant', 'variant is an index');
        break;
      }
      case 'flood':
        if (!ints(e['at'], 3)) return bad('at', 'at is [x, y, z] integers');
        if (e['connectivity'] !== undefined && e['connectivity'] !== 'xz' && e['connectivity'] !== 'xyz') return bad('connectivity', 'connectivity is "xz" or "xyz"');
        break;
      case 'column':
        if (!ints(e['at']) || (e['at'] as number[]).length % 2 !== 0 || (e['at'] as number[]).length === 0) return bad('at', 'at is a flat list of integer x, z pairs');
        if (!Number.isSafeInteger(e['delta']) || e['delta'] === 0) return bad('delta', 'delta is a non-zero whole number of cells');
        break;
      case 'stamp':
        if (typeof e['stampId'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(e['stampId'])) return bad('stampId', 'stampId is a stamp id');
        if (!ints(e['at'], 3)) return bad('at', 'at is [x, y, z] integers');
        break;
      case 'copy':
        if (!ints(e['to'], 3)) return bad('to', 'to is [x, y, z] integers');
        break;
      case 'region': {
        if (typeof e['regionId'] !== 'string' || !REGION_ID_RE.test(e['regionId'])) return bad('regionId', 'a region id is 1-64 letters, digits, "_", "." or "-"');
        const op = e['op'];
        if (!['set', 'add', 'remove', 'delete', 'rename'].includes(op as string)) return bad('op', 'op is set, add, remove, delete or rename');
        if (op === 'set' || op === 'add' || op === 'remove') {
          const boxes = e['boxes'];
          if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > BLOCK_LIMITS.regionBoxes || !boxes.every((b) => ints(b, 6))) return bad('boxes', `boxes is 1-${BLOCK_LIMITS.regionBoxes} [x0, y0, z0, x1, y1, z1] integer boxes`);
        }
        if (op === 'rename' && (typeof e['to'] !== 'string' || !REGION_ID_RE.test(e['to']))) return bad('to', 'to is the new region id');
        break;
      }
      case 'surface': {
        const cols = e['columns'];
        if (!Array.isArray(cols) || cols.length === 0 || cols.length % 6 !== 0 || cols.length > 6 * SURFACE_EDIT_MAX_COLUMNS) return bad('columns', `columns is x, z and four corner heights per column (1-${SURFACE_EDIT_MAX_COLUMNS} columns)`);
        for (let k = 0; k < cols.length; k += 6) {
          if (!Number.isSafeInteger(cols[k]) || !Number.isSafeInteger(cols[k + 1])) return bad(`columns/${k}`, 'a column starts with its integer x and z');
          for (let j = 2; j < 6; j++) if (typeof cols[k + j] !== 'number' || !Number.isFinite(cols[k + j]) || Math.abs(cols[k + j] as number) > BLOCK_LIMITS.coordinateY) return bad(`columns/${k + j}`, `a corner height is a finite number of rows within ±${BLOCK_LIMITS.coordinateY}`);
        }
        break;
      }
      case 'sculpt': {
        if (!SCULPT_OPS.includes(e['op'] as SculptOp)) return bad('op', `op is ${SCULPT_OPS.join(', ')}`);
        const at = e['at'];
        if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= BLOCK_LIMITS.coordinateXZ)) return bad('at', 'at is the brush centre [x, z] in columns');
        const r = e['radius'];
        if (typeof r !== 'number' || !Number.isFinite(r) || r < SCULPT_LIMITS.radiusMin || r > SCULPT_LIMITS.radiusMax) return bad('radius', `radius is ${SCULPT_LIMITS.radiusMin}-${SCULPT_LIMITS.radiusMax} cells`);
        const st = e['strength'];
        if (typeof st !== 'number' || !Number.isFinite(st) || st <= 0 || st > SCULPT_LIMITS.strengthMax) return bad('strength', `strength is in (0, ${SCULPT_LIMITS.strengthMax}] (cells for raise/lower, a 0-1 blend for smooth/flatten)`);
        if (e['op'] === 'flatten' && (typeof e['height'] !== 'number' || !Number.isFinite(e['height']) || Math.abs(e['height']) > BLOCK_LIMITS.coordinateY)) return { path: `${p}/height`, message: 'a flatten dab needs height (rows)', code: 'field_missing' };
        if (e['op'] !== 'flatten' && e['height'] !== undefined) return { path: `${p}/height`, message: 'height belongs to a flatten dab', code: 'field_unexpected' };
        break;
      }
      case 'paint': {
        const at = e['at'];
        if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= BLOCK_LIMITS.coordinateXZ)) return bad('at', 'at is the brush centre [x, z] in columns');
        const be = paintBrushError(e);
        if (be !== null) return bad(be.field, be.message);
        if (!Number.isInteger(e['channel']) || (e['channel'] as number) < 0 || (e['channel'] as number) >= PAINT_CHANNELS) return bad('channel', 'channel is 0-3 (a material layer) or 4 (wetness)');
        break;
      }
      case 'heightmap': {
        if (typeof e['png'] !== 'string' || e['png'].length < 8) return bad('png', 'png is base64 PNG bytes');
        if (!ints(e['origin'], 2)) return bad('origin', 'origin is [x, z] integers');
        if (!Number.isSafeInteger(e['y'])) return bad('y', 'y is the base cell row (an integer)');
        if (typeof e['scale'] !== 'number' || !Number.isFinite(e['scale']) || e['scale'] < 0 || e['scale'] > BLOCK_LIMITS.layerHeight) return bad('scale', `scale is the cells a white pixel stands for (0-${BLOCK_LIMITS.layerHeight})`);
        const colors = e['colors'];
        if (colors !== undefined) {
          if (!isObj(colors) || typeof colors['png'] !== 'string' || !Array.isArray(colors['map']) || colors['map'].length < 1 || colors['map'].length > 64) return bad('colors', 'colors is {png, map: [{color: "#rrggbb", cell}] (1-64)}');
          for (let k = 0; k < (colors['map'] as unknown[]).length; k++) {
            const m = (colors['map'] as unknown[])[k];
            if (!isObj(m) || typeof m['color'] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(m['color'])) return bad(`colors/map/${k}`, 'a colour entry is {color: "#rrggbb", cell}');
            const c = cellOk(m['cell'], false);
            if (c !== null) return bad(`colors/map/${k}/cell`, c);
          }
        }
        break;
      }
    }
  }
  return null;
}

/** Most columns one `surface` edit sets (one command stays well under the 64 KiB request cap). */
export const SURFACE_EDIT_MAX_COLUMNS = 4096;

/** Most cells one command may visit (a box volume, a flood, an array). */
export const BLOCK_EDIT_MAX_CELLS = 1_048_576;
/** Most edits in one command. */
export const BLOCK_EDIT_MAX_EDITS = 256;

export interface BlockEditContext {
  types: ReadonlyMap<string, BlockType>;
  stamps: ReadonlyMap<string, BlockStamp>;
}

/** `rebased`: columns whose top row moved under `surface` / `sculpt` edits (absent: the command had none). */
export type BlockEditResult = { ok: true; cells: number; rebased?: number } | { ok: false; path: string; message: string };

function fail(path: string, message: string): { ok: false; path: string; message: string } {
  return { ok: false, path, message };
}

function boxCheck(g: BlockGrid, b: unknown, path: string): { ok: true; box: [number, number, number, number, number, number] } | { ok: false; path: string; message: string } {
  if (!Array.isArray(b) || b.length !== 6 || !b.every((x) => Number.isSafeInteger(x))) return fail(path, 'a box is [x0, y0, z0, x1, y1, z1] integers (max exclusive)');
  const [x0, y0, z0, x1, y1, z1] = b as number[];
  if (!(x1! > x0! && y1! > y0! && z1! > z0!)) return fail(path, 'a box has max > min on every axis');
  // Clip to the layer's bounds (cells outside never exist).
  const box: [number, number, number, number, number, number] = [Math.max(x0!, g.min[0]), Math.max(y0!, g.min[1]), Math.max(z0!, g.min[2]), Math.min(x1!, g.max[0]), Math.min(y1!, g.max[1]), Math.min(z1!, g.max[2])];
  const vol = Math.max(0, box[3] - box[0]) * Math.max(0, box[4] - box[1]) * Math.max(0, box[5] - box[2]);
  if (vol > BLOCK_EDIT_MAX_CELLS) return fail(path, `a box covers at most ${BLOCK_EDIT_MAX_CELLS} cells of the layer`);
  return { ok: true, box };
}

function outside(g: BlockGrid, x: number, y: number, z: number, path: string): { ok: false; path: string; message: string } | null {
  return g.inBounds(x, y, z) ? null : fail(path, `cell [${x}, ${y}, ${z}] lies outside the layer's bounds [${g.min.join(', ')}] - [${g.max.join(', ')}]`);
}

function rotAdd(rot: number | undefined, by: number): BlockRotation {
  return ((((rot ?? 0) + by) % 360) + 360) % 360 as BlockRotation;
}

function mirroredRot(rot: number | undefined, mirror: 'x' | 'z'): BlockRotation {
  const r = rot ?? 0;
  return (mirror === 'x' ? (360 - r) % 360 : (540 - r) % 360) as BlockRotation;
}

function withRot(cell: BlockCell, rot: BlockRotation): BlockCell {
  if (cell.block === undefined) return cell;
  const { rot: _r, ...rest } = cell;
  return rot === 0 ? rest : { ...rest, rot };
}

/**
 * A cell moved by a pattern transform: position inside the source extent
 * (`w` × `d`) turned by `rot` then mirrored; the value's rotation follows,
 * and a multi-cell footprint keeps its anchor at the min corner.
 */
function transformCell(
  lx: number,
  lz: number,
  cell: BlockCell,
  w: number,
  d: number,
  rot: BlockRotation,
  mirror: 'x' | 'z' | undefined,
  types: ReadonlyMap<string, BlockType>,
): { x: number; z: number; cell: BlockCell } {
  const t = cell.block !== undefined ? types.get(cell.block) : undefined;
  const f = t !== undefined ? rotatedFootprint(t, cell.rot) : [1, 1, 1];
  // The cell's footprint box corners within the extent, turned (counter-clockwise from above: x' = z, z' = w - x).
  let x0 = lx;
  let x1 = lx + f[0]!;
  let z0 = lz;
  let z1 = lz + f[2]!;
  let W = w;
  let D = d;
  const turns = rot / 90;
  for (let i = 0; i < turns; i++) {
    const nx0 = z0;
    const nx1 = z1;
    const nz0 = W - x1;
    const nz1 = W - x0;
    x0 = nx0;
    x1 = nx1;
    z0 = nz0;
    z1 = nz1;
    const t2 = W;
    W = D;
    D = t2;
  }
  let r = rotAdd(cell.rot, rot);
  let corners = cell.corners;
  for (let i = 0; corners !== undefined && i < turns; i++) corners = [corners[1], corners[2], corners[3], corners[0]];
  if (mirror === 'x') {
    const n0 = W - x1;
    x1 = W - x0;
    x0 = n0;
    r = mirroredRot(r, 'x');
    if (corners !== undefined) corners = [corners[1], corners[0], corners[3], corners[2]];
  } else if (mirror === 'z') {
    const n0 = D - z1;
    z1 = D - z0;
    z0 = n0;
    r = mirroredRot(r, 'z');
    if (corners !== undefined) corners = [corners[3], corners[2], corners[1], corners[0]];
  }
  const turned = withRot(cell, r);
  // The corners are in the layer's axes: they turn and mirror with the pattern (a quarter turn moves −x−z to −x+z).
  return { x: x0, z: z0, cell: corners !== undefined ? { ...turned, corners } : turned };
}

function mergeMeta(cell: BlockCell | null, set: Record<string, CellMetaValue | null>): BlockCell | null {
  const meta: Record<string, CellMetaValue> = { ...(cell?.meta ?? {}) };
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete meta[k];
    else meta[k] = v;
  }
  const out: BlockCell = { ...(cell ?? {}) };
  if (Object.keys(meta).length > 0) out.meta = meta;
  else delete out.meta;
  return out.block === undefined && out.meta === undefined ? null : out;
}

function replaceBlock(cell: BlockCell, next: BlockCell | null, types: ReadonlyMap<string, BlockType>): BlockCell | null {
  const meta = { ...(cell.meta ?? {}), ...(next?.meta ?? {}) };
  const out: BlockCell = {};
  if (next?.block !== undefined) {
    out.block = next.block;
    if (next.rot !== undefined) out.rot = next.rot;
    if (next.variant !== undefined) out.variant = next.variant;
    // A replaced block keeps the terrain's slope when the new type can carry it.
    const corners = next.corners ?? cell.corners;
    const t = types.get(next.block);
    if (corners !== undefined && t !== undefined && blockTypeSlopes(t)) out.corners = corners;
  }
  if (Object.keys(meta).length > 0) out.meta = meta;
  return out.block === undefined && out.meta === undefined ? null : out;
}

function withoutCorners(cell: BlockCell): BlockCell {
  if (cell.corners === undefined) return cell;
  const { corners: _c, ...rest } = cell;
  return rest;
}

function matchesBlock(cell: BlockCell, match: { block: string | null; rot?: number; variant?: number }): boolean {
  if (match.block === null ? cell.block !== undefined : cell.block !== match.block) return false;
  if (match.rot !== undefined && (cell.rot ?? 0) !== match.rot) return false;
  if (match.variant !== undefined && cell.variant !== match.variant) return false;
  return true;
}

function nearestColor(r: number, g: number, b: number, map: readonly { rgb: [number, number, number]; index: number }[]): number {
  let best = map[0]!.index;
  let bestD = Infinity;
  for (const m of map) {
    const d = (m.rgb[0] - r) ** 2 + (m.rgb[1] - g) ** 2 + (m.rgb[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = m.index;
    }
  }
  return best;
}

/**
 * Apply edits in order to a grid. Structural problems (a box out of shape, a
 * cell outside the bounds, an unknown stamp, too many cells) refuse the whole
 * command with a path under `/args/edits`; references the content decides
 * (block types, metadata fields, rotations) are checked on the result.
 */
export function applyBlockEdits(g: BlockGrid, edits: readonly BlockEdit[], ctx: BlockEditContext): BlockEditResult {
  let visited = 0;
  let changed = 0;
  const budget = (n: number, path: string): { ok: false; path: string; message: string } | null => {
    visited += n;
    return visited > BLOCK_EDIT_MAX_CELLS ? fail(path, `one command visits at most ${BLOCK_EDIT_MAX_CELLS} cells`) : null;
  };
  const put = (x: number, y: number, z: number, cell: BlockCell | null): void => {
    if (g.set(x, y, z, cell)) changed += 1;
  };
  // The top row of each column a surface or sculpt edit sets, before its first edit, so the result can say how many re-based.
  let topsBefore: Map<string, { x: number; z: number; top: number | null }> | null = null;
  const surfaceColumn = (x: number, z: number): void => {
    topsBefore ??= new Map();
    const k = `${x},${z}`;
    if (!topsBefore.has(k)) topsBefore.set(k, { x, z, top: g.columnTop(x, z) });
  };
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const p = `/args/edits/${i}`;
    switch (e.kind) {
      case 'fill': {
        const bc = boxCheck(g, e.box, `${p}/box`);
        if (!bc.ok) return bc;
        const [x0, y0, z0, x1, y1, z1] = bc.box;
        const over = budget(Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * Math.max(0, z1 - z0), p);
        if (over) return over;
        const idx = e.cell === null ? -1 : g.intern(e.cell);
        for (let y = y0; y < y1; y++)
          for (let z = z0; z < z1; z++)
            for (let x = x0; x < x1; x++) {
              const cur = g.indexAt(x, y, z);
              if (e.mode === 'keep' && cur >= 0) continue;
              if (e.mode === 'replace' && cur < 0) continue;
              if (g.setIndex(x, y, z, idx)) changed += 1;
            }
        break;
      }
      case 'cells': {
        if (!Array.isArray(e.at) || e.at.length % 3 !== 0 || !e.at.every((v) => Number.isSafeInteger(v))) return fail(`${p}/at`, 'at is a flat list of integer x, y, z triples');
        const over = budget(e.at.length / 3, p);
        if (over) return over;
        for (let k = 0; k < e.at.length; k += 3) {
          const o = outside(g, e.at[k]!, e.at[k + 1]!, e.at[k + 2]!, `${p}/at/${k}`);
          if (o) return o;
          put(e.at[k]!, e.at[k + 1]!, e.at[k + 2]!, e.cell);
        }
        break;
      }
      case 'array': {
        const [ox, oy, oz] = e.origin as [number, number, number];
        const [w, h, d] = e.size as [number, number, number];
        const total = w * h * d;
        const over = budget(total, p);
        if (over) return over;
        if (!g.inBounds(ox, oy, oz) || !g.inBounds(ox + w - 1, oy + h - 1, oz + d - 1)) return fail(`${p}/origin`, "the array reaches outside the layer's bounds");
        const indices = e.palette.map((c) => (c === null ? -1 : g.intern(c)));
        let n = 0;
        for (let k = 0; k < e.data.length; k += 2) {
          const count = e.data[k]!;
          const pi = e.data[k + 1]!;
          if (pi < -1 || pi >= indices.length) return fail(`${p}/data/${k + 1}`, 'a run names a palette entry (or -1: leave the cell)');
          for (let c = 0; c < count; c++, n++) {
            if (n >= total) return fail(`${p}/data`, 'the runs cover more cells than size');
            if (pi === -1) continue;
            const x = ox + (n % w);
            const z = oz + (Math.floor(n / w) % d);
            const y = oy + Math.floor(n / (w * d));
            if (g.setIndex(x, y, z, indices[pi]!)) changed += 1;
          }
        }
        if (n !== total) return fail(`${p}/data`, `the runs cover ${n} cells; size holds ${total}`);
        if (e.edges !== undefined && e.edgePalette !== undefined) {
          const over2 = budget(e.edges.length, p);
          if (over2) return over2;
          const values = e.edgePalette.map((v) => g.internEdge(v));
          for (const r of e.edges) if (g.setEdgeIndex(ox + r[0]!, oy + r[2]!, oz + r[1]!, r[3]!, values[r[4]!]!)) changed += 1;
        }
        break;
      }
      case 'replace': {
        let box: [number, number, number, number, number, number] = [g.min[0], g.min[1], g.min[2], g.max[0], g.max[1], g.max[2]];
        if (e.box !== undefined) {
          const bc = boxCheck(g, e.box, `${p}/box`);
          if (!bc.ok) return bc;
          box = bc.box;
        }
        const hits: [number, number, number, BlockCell][] = [];
        g.forEach((x, y, z, idx) => {
          if (!boxContains(box, x, y, z)) return;
          const cell = g.valueOf(idx);
          if (matchesBlock(cell, e.match)) hits.push([x, y, z, cell]);
        });
        const over = budget(hits.length, p);
        if (over) return over;
        for (const [x, y, z, cell] of hits) put(x, y, z, replaceBlock(cell, e.cell, ctx.types));
        break;
      }
      case 'meta': {
        const targets: [number, number, number][] = [];
        if (e.box !== undefined) {
          const bc = boxCheck(g, e.box, `${p}/box`);
          if (!bc.ok) return bc;
          const [x0, y0, z0, x1, y1, z1] = bc.box;
          const over = budget(Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * Math.max(0, z1 - z0), p);
          if (over) return over;
          for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) targets.push([x, y, z]);
        }
        if (e.at !== undefined) {
          if (!Array.isArray(e.at) || e.at.length % 3 !== 0 || !e.at.every((v) => Number.isSafeInteger(v))) return fail(`${p}/at`, 'at is a flat list of integer x, y, z triples');
          const over = budget(e.at.length / 3, p);
          if (over) return over;
          for (let k = 0; k < e.at.length; k += 3) {
            const o = outside(g, e.at[k]!, e.at[k + 1]!, e.at[k + 2]!, `${p}/at/${k}`);
            if (o) return o;
            targets.push([e.at[k]!, e.at[k + 1]!, e.at[k + 2]!]);
          }
        }
        for (const [x, y, z] of targets) {
          const cur = g.get(x, y, z);
          if (cur === null && e.occupiedOnly === true) continue;
          put(x, y, z, mergeMeta(cur, e.set));
        }
        break;
      }
      case 'flood': {
        const [sx, sy, sz] = e.at as [number, number, number];
        const o = outside(g, sx, sy, sz, `${p}/at`);
        if (o) return o;
        const from = g.indexAt(sx, sy, sz);
        const to = e.cell === null ? -1 : g.intern(e.cell);
        if (from === to) break;
        const three = e.connectivity === 'xyz';
        const stack: number[] = [cellKeyOf(sx, sy, sz)];
        const seen = new Set<number>(stack);
        const fill: number[] = [];
        while (stack.length > 0) {
          const k = stack.pop()!;
          fill.push(k);
          if (fill.length > 65_536) return fail(p, 'a flood fill covers at most 65,536 cells (fill a box or bound the area first)');
          const [x, y, z] = cellOfKey(k);
          const next: [number, number, number][] = [
            [x + 1, y, z],
            [x - 1, y, z],
            [x, y, z + 1],
            [x, y, z - 1],
          ];
          if (three) next.push([x, y + 1, z], [x, y - 1, z]);
          for (const [nx, ny, nz] of next) {
            if (!g.inBounds(nx, ny, nz)) continue;
            const nk = cellKeyOf(nx, ny, nz);
            if (seen.has(nk) || g.indexAt(nx, ny, nz) !== from) continue;
            seen.add(nk);
            stack.push(nk);
          }
        }
        const over = budget(fill.length, p);
        if (over) return over;
        fill.sort((a, b) => a - b);
        for (const k of fill) {
          const [x, y, z] = cellOfKey(k);
          if (g.setIndex(x, y, z, to)) changed += 1;
        }
        break;
      }
      case 'column': {
        if (!Array.isArray(e.at) || e.at.length % 2 !== 0 || !e.at.every((v) => Number.isSafeInteger(v))) return fail(`${p}/at`, 'at is a flat list of integer x, z pairs');
        if (!Number.isSafeInteger(e.delta) || e.delta === 0 || Math.abs(e.delta) > BLOCK_LIMITS.layerHeight) return fail(`${p}/delta`, `delta is a non-zero whole number of cells (at most ${BLOCK_LIMITS.layerHeight})`);
        const over = budget((e.at.length / 2) * Math.abs(e.delta), p);
        if (over) return over;
        for (let k = 0; k < e.at.length; k += 2) {
          const x = e.at[k]!;
          const z = e.at[k + 1]!;
          const o = outside(g, x, g.min[1], z, `${p}/at/${k}`);
          if (o) return o;
          const top = g.columnTop(x, z);
          const topCell = top !== null ? g.get(x, top, z) : null;
          // A sloped top moves with the column's top: raising and lowering keep the slope's shape.
          const slope = topCell?.corners ?? null;
          if (e.delta > 0) {
            const cell = e.cell ?? (topCell !== null ? withoutCorners(topCell) : null);
            if (cell === null) continue;
            const base = top === null ? g.min[1] : top + 1;
            for (let y = base; y < base + e.delta; y++) {
              const oo = outside(g, x, y, z, `${p}/delta`);
              if (oo) return oo;
              put(x, y, z, cell);
            }
            if (slope !== null && top !== null) {
              put(x, top, z, withoutCorners(topCell!));
              const t = cell.block !== undefined ? ctx.types.get(cell.block) : undefined;
              if (t !== undefined && blockTypeSlopes(t)) put(x, base + e.delta - 1, z, { ...cell, corners: slope });
            }
          } else if (top !== null) {
            for (let y = top; y > top + e.delta && y >= g.min[1]; y--) {
              const cur = g.get(x, y, z);
              if (cur === null) continue;
              put(x, y, z, cur.meta !== undefined ? { meta: cur.meta } : null);
            }
            const now = slope !== null ? g.columnTop(x, z) : null;
            if (now !== null) {
              const below = g.get(x, now, z)!;
              const t = below.block !== undefined ? ctx.types.get(below.block) : undefined;
              if (t !== undefined && blockTypeSlopes(t)) put(x, now, z, { ...below, corners: slope! });
            }
          }
        }
        break;
      }
      case 'stamp':
      case 'copy': {
        const rot = (e.rot ?? 0) as BlockRotation;
        let cells: { lx: number; ly: number; lz: number; cell: BlockCell }[] = [];
        // The edge pieces go with the cells (those on the box's outline too), turned and mirrored with them.
        let edges: { lx: number; ly: number; lz: number; axis: number; edge: BlockEdge }[] = [];
        let w: number;
        let d: number;
        if (e.kind === 'stamp') {
          const s = ctx.stamps.get(e.stampId);
          if (s === undefined) return fail(`${p}/stampId`, `no stamp "${e.stampId}" in content.blockStamps`);
          [w, , d] = s.size;
          for (const col of s.columns) for (let r = 2; r < col.length; r += 3) for (let y = col[r]!; y < col[r]! + col[r + 1]!; y++) cells.push({ lx: col[0]!, ly: y, lz: col[1]!, cell: s.palette[col[r + 2]!]! });
          if (s.edgePalette !== undefined) for (const r of s.edges ?? []) edges.push({ lx: r[0]!, lz: r[1]!, ly: r[2]!, axis: r[3]!, edge: s.edgePalette[r[4]!]! });
        } else {
          const bc = boxCheck(g, e.box, `${p}/box`);
          if (!bc.ok) return bc;
          const [x0, y0, z0, x1, y1, z1] = bc.box;
          w = x1 - x0;
          d = z1 - z0;
          g.forEach((x, y, z, idx) => {
            if (boxContains(bc.box, x, y, z)) cells.push({ lx: x - x0, ly: y - y0, lz: z - z0, cell: g.valueOf(idx) });
          });
          if (g.edgeCount > 0) {
            g.forEachEdge((x, y, z, axis, idx) => {
              if (edgeInBox(bc.box, x, y, z, axis)) edges.push({ lx: x - x0, ly: y - y0, lz: z - z0, axis, edge: g.edgeValueOf(idx) });
            });
          }
          if (e.move === true) {
            for (const c of cells) put(c.lx + x0, c.ly + y0, c.lz + z0, null);
            for (const c of edges) if (g.setEdgeIndex(c.lx + x0, c.ly + y0, c.lz + z0, c.axis, -1)) changed += 1;
          }
        }
        const over = budget(cells.length + edges.length, p);
        if (over) return over;
        const [ax, ay, az] = e.kind === 'stamp' ? (e.at as [number, number, number]) : (e.to as [number, number, number]);
        const placed = cells.map((c) => {
          const t = transformCell(c.lx, c.lz, c.cell, w, d, rot, e.mirror, ctx.types);
          return { x: ax + t.x, y: ay + c.ly, z: az + t.z, cell: t.cell };
        });
        for (const c of placed) {
          const o = outside(g, c.x, c.y, c.z, e.kind === 'stamp' ? `${p}/at` : `${p}/to`);
          if (o) return o;
          if (e.mode === 'keep' && g.indexAt(c.x, c.y, c.z) >= 0) continue;
          put(c.x, c.y, c.z, c.cell);
        }
        for (const c of edges) {
          const t = transformEdge(c.lx, c.lz, c.axis, c.edge.rot, w, d, rot, e.mirror);
          const x = ax + t.x;
          const y = ay + c.ly;
          const z = az + t.z;
          if (!g.edgeInBounds(x, y, z, t.axis)) return fail(e.kind === 'stamp' ? `${p}/at` : `${p}/to`, `edge [${x}, ${y}, ${z}, ${t.axis}] lies outside the layer's bounds`);
          if (e.mode === 'keep' && g.edgeIndexAt(x, y, z, t.axis) >= 0) continue;
          // A piece that may only face one way keeps facing it.
          const allowed = ctx.types.get(c.edge.block)?.rotations ?? [0, 180];
          const turned = allowed.includes(t.rot) ? t.rot : (c.edge.rot ?? 0);
          const { rot: _r, ...rest } = c.edge;
          if (g.setEdge(x, y, z, t.axis, turned === 180 ? { ...rest, rot: 180 } : rest)) changed += 1;
        }
        cells = [];
        edges = [];
        break;
      }
      case 'region': {
        const cur = g.regions.get(e.regionId);
        if (e.op === 'delete') {
          if (cur === undefined) return fail(`${p}/regionId`, `no region "${e.regionId}" in this layer`);
          g.regions.delete(e.regionId);
        } else if (e.op === 'rename') {
          if (cur === undefined) return fail(`${p}/regionId`, `no region "${e.regionId}" in this layer`);
          if (typeof e.to !== 'string' || g.regions.has(e.to)) return fail(`${p}/to`, 'rename to a region id this layer does not use');
          g.regions.delete(e.regionId);
          g.regions.set(e.to, cur);
          g.markRegionDirty(e.to);
        } else {
          const boxes = (e.boxes ?? []).map((b) => [...b]);
          for (let k = 0; k < boxes.length; k++) {
            const b = boxes[k]!;
            if (b.length !== 6 || !b.every((v) => Number.isSafeInteger(v)) || !(b[3]! > b[0]! && b[4]! > b[1]! && b[5]! > b[2]!)) return fail(`${p}/boxes/${k}`, 'a region box is [x0, y0, z0, x1, y1, z1] integers with max > min');
          }
          let next: number[][];
          if (e.op === 'set') next = boxes;
          else if (e.op === 'add') next = [...(cur ?? []), ...boxes.filter((b) => !(cur ?? []).some((c) => c.every((v, j) => v === b[j])))];
          else {
            if (cur === undefined) return fail(`${p}/regionId`, `no region "${e.regionId}" in this layer`);
            next = cur;
            for (const b of boxes) next = next.flatMap((a) => subtractBox(a, b));
          }
          if (next.length === 0) g.regions.delete(e.regionId);
          else g.regions.set(e.regionId, next);
        }
        g.markRegionDirty(e.regionId);
        break;
      }
      case 'surface': {
        const cols = e.columns;
        const over = budget(cols.length / 6, p);
        if (over) return over;
        topsBefore ??= new Map();
        for (let k = 0; k < cols.length; k += 6) {
          const o = outside(g, cols[k]!, g.min[1], cols[k + 1]!, `${p}/columns/${k}`);
          if (o) return o;
          surfaceColumn(cols[k]!, cols[k + 1]!);
          const n = setColumnSurface(g, ctx.types, cols[k]!, cols[k + 1]!, cols.slice(k + 2, k + 6), e.cell);
          if (n > 0) changed += n;
        }
        break;
      }
      case 'edges': {
        if (g.metadataOnly && e.edge !== null) return fail(p, 'a metadata-only layer holds no edge pieces');
        const targets = edgesEditTargets(g, e, BLOCK_EDIT_MAX_CELLS - visited);
        if (typeof targets === 'string') return fail(e.at !== undefined ? `${p}/at` : `${p}/box`, targets);
        const over = budget(targets.length, p);
        if (over) return over;
        const idx = e.edge === null ? -1 : g.internEdge(e.edge);
        for (const [x, y, z, axis] of targets) {
          if (e.mode === 'keep' && g.edgeIndexAt(x!, y!, z!, axis!) >= 0) continue;
          if (g.setEdgeIndex(x!, y!, z!, axis!, idx)) changed += 1;
        }
        break;
      }
      case 'paint': {
        // The layer's surface paint (the cells stay as they are).
        if (g.metadataOnly) return fail(p, 'a metadata-only layer has no surface to paint');
        changed += paintDab(g.paintSurface(), [e.at[0]!, e.at[1]!], { radius: e.radius, strength: e.strength, falloff: e.falloff ?? 'smooth', channel: e.channel, ...(e.erase === true ? { erase: true } : {}) });
        break;
      }
      case 'sculpt': {
        const next = sculptHeights(g, ctx.types, e, e.cell !== undefined);
        const over = budget(next.size, p);
        if (over) return over;
        topsBefore ??= new Map();
        for (const k of [...next.keys()].sort()) {
          const c = next.get(k)!;
          surfaceColumn(c.x, c.z);
          const n = setColumnSurface(g, ctx.types, c.x, c.z, c.h, e.cell);
          if (n > 0) changed += n;
        }
        break;
      }
      case 'heightmap': {
        const bytes = decodeBase64(e.png);
        if (bytes === null) return fail(`${p}/png`, 'png is base64 PNG bytes');
        const img = decodePngRgba(bytes);
        if (!img.ok) return fail(`${p}/png`, img.message);
        const { width, height, rgba } = img.png;
        let colorOf: ((px: number, py: number) => number) | null = null;
        if (e.colors !== undefined) {
          const cb = decodeBase64(e.colors.png);
          if (cb === null) return fail(`${p}/colors/png`, 'colors.png is base64 PNG bytes');
          const ci = decodePngRgba(cb);
          if (!ci.ok) return fail(`${p}/colors/png`, ci.message);
          if (ci.png.width !== width || ci.png.height !== height) return fail(`${p}/colors/png`, `the colour map is ${ci.png.width} × ${ci.png.height}; the heightmap is ${width} × ${height}`);
          if (e.colors.map.length < 1) return fail(`${p}/colors/map`, 'the colour map lists at least one colour');
          const map = e.colors.map.map((m) => ({ rgb: [parseInt(m.color.slice(1, 3), 16), parseInt(m.color.slice(3, 5), 16), parseInt(m.color.slice(5, 7), 16)] as [number, number, number], index: g.intern(m.cell) }));
          const crgba = ci.png.rgba;
          colorOf = (px, py) => {
            const o = (py * width + px) * 4;
            return nearestColor(crgba[o]!, crgba[o + 1]!, crgba[o + 2]!, map);
          };
        }
        const [ox, oz] = e.origin as [number, number];
        if (!g.inBounds(ox, e.y, oz) || !g.inBounds(ox + width - 1, e.y, oz + height - 1)) return fail(`${p}/origin`, `the ${width} × ${height} heightmap reaches outside the layer's bounds`);
        const fillIndex = g.intern(e.cell);
        const over = budget(width * height * Math.max(1, g.max[1] - e.y), p);
        if (over) return over;
        for (let py = 0; py < height; py++)
          for (let px = 0; px < width; px++) {
            const o = (py * width + px) * 4;
            const grey = rgba[o]! === rgba[o + 1]! && rgba[o]! === rgba[o + 2]! ? rgba[o]! : Math.round(0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!);
            const cells = Math.round((grey / 255) * e.scale);
            const x = ox + px;
            const z = oz + py;
            const idx = colorOf !== null ? colorOf(px, py) : fillIndex;
            const top = Math.min(e.y + cells, g.max[1]);
            for (let y = e.y; y < top; y++) if (g.setIndex(x, y, z, idx)) changed += 1;
            if (e.keepAbove !== true) for (let y = top; y < g.max[1]; y++) if (g.setIndex(x, y, z, -1)) changed += 1;
          }
        break;
      }
    }
  }
  if (g.metadataOnly && changedBlocks(g)) return fail('/args/edits', 'a metadata-only layer holds no blocks (paint metadata, or use a block layer)');
  if (topsBefore === null) return { ok: true, cells: changed };
  let rebased = 0;
  for (const c of (topsBefore as Map<string, { x: number; z: number; top: number | null }>).values()) if (g.columnTop(c.x, c.z) !== c.top) rebased += 1;
  return { ok: true, cells: changed, rebased };
}

function changedBlocks(g: BlockGrid): boolean {
  let found = false;
  g.forEach((_x, _y, _z, idx) => {
    if (!found && g.valueOf(idx).block !== undefined) found = true;
  });
  return found;
}

// ---- world ↔ cell, the ray pick ------------------------------------------------------------

export type Vec3Like = { x: number; y: number; z: number };

/** The cell holding a world point (the layer origin is the min corner of cell [0, 0, 0]). */
export function worldToCell(origin: Vec3Like, cellSize: readonly number[], p: Vec3Like): [number, number, number] {
  return [Math.floor((p.x - origin.x) / cellSize[0]!), Math.floor((p.y - origin.y) / cellSize[1]!), Math.floor((p.z - origin.z) / cellSize[2]!)];
}

/** A cell's centre in world space. */
export function cellCenter(origin: Vec3Like, cellSize: readonly number[], x: number, y: number, z: number): Vec3Like {
  return { x: origin.x + (x + 0.5) * cellSize[0]!, y: origin.y + (y + 0.5) * cellSize[1]!, z: origin.z + (z + 0.5) * cellSize[2]! };
}

export interface BlockPick {
  cell: [number, number, number];
  /** The face the ray entered through (a unit axis vector; [0, 0, 0] when the ray starts inside the cell). */
  normal: [number, number, number];
  /** Metres along the (normalized) ray. */
  distance: number;
  point: Vec3Like;
}

/**
 * The first cell a ray enters that `hit` accepts (a DDA over the layer's
 * cells: deterministic and independent of physics). Cells are whole boxes
 * here (a half block or ramp is picked by its cell).
 */
export function pickCell(
  g: Pick<BlockGrid, 'min' | 'max' | 'cellSize'>,
  origin: Vec3Like,
  rayOrigin: Vec3Like,
  rayDir: Vec3Like,
  maxDistance: number,
  hit: (x: number, y: number, z: number) => boolean,
): BlockPick | null {
  const len = Math.hypot(rayDir.x, rayDir.y, rayDir.z);
  if (!(len > 0) || !(maxDistance > 0)) return null;
  const d = [rayDir.x / len, rayDir.y / len, rayDir.z / len];
  const cs = g.cellSize;
  // In cell units.
  const o = [(rayOrigin.x - origin.x) / cs[0]!, (rayOrigin.y - origin.y) / cs[1]!, (rayOrigin.z - origin.z) / cs[2]!];
  const dc = [d[0]! / cs[0]!, d[1]! / cs[1]!, d[2]! / cs[2]!];
  // Clip the ray to the layer's bounds box (slab test) to start inside.
  let tEnter = 0;
  let tExit = maxDistance;
  let enterAxis = -1;
  for (let a = 0; a < 3; a++) {
    const lo = g.min[a]!;
    const hi = g.max[a]!;
    if (dc[a] === 0) {
      if (o[a]! < lo || o[a]! >= hi) return null;
      continue;
    }
    let t0 = (lo - o[a]!) / dc[a]!;
    let t1 = (hi - o[a]!) / dc[a]!;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) {
      tEnter = t0;
      enterAxis = a;
    }
    if (t1 < tExit) tExit = t1;
  }
  if (tEnter > tExit) return null;
  const p = [o[0]! + dc[0]! * tEnter, o[1]! + dc[1]! * tEnter, o[2]! + dc[2]! * tEnter];
  const cell = [0, 1, 2].map((a) => {
    let c = Math.floor(p[a]!);
    if (a === enterAxis && dc[a]! < 0) c = Math.ceil(p[a]!) - 1;
    return Math.min(g.max[a]! - 1, Math.max(g.min[a]!, c));
  }) as [number, number, number];
  const step = dc.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
  const tDelta = dc.map((v) => (v !== 0 ? Math.abs(1 / v) : Infinity));
  const tMax = [0, 1, 2].map((a) => {
    if (dc[a] === 0) return Infinity;
    const boundary = dc[a]! > 0 ? cell[a]! + 1 : cell[a]!;
    return tEnter + (boundary - p[a]!) / dc[a]!;
  });
  let normal: [number, number, number] = [0, 0, 0];
  if (enterAxis >= 0) normal[enterAxis] = -step[enterAxis]! as number;
  let t = tEnter;
  for (let guard = 0; guard < 4 * (BLOCK_LIMITS.layerWidth * 2 + BLOCK_LIMITS.layerHeight); guard++) {
    if (t > tExit) return null;
    if (hit(cell[0], cell[1], cell[2])) {
      return { cell: [cell[0], cell[1], cell[2]], normal: [normal[0] || 0, normal[1] || 0, normal[2] || 0], distance: t, point: { x: rayOrigin.x + d[0]! * t, y: rayOrigin.y + d[1]! * t, z: rayOrigin.z + d[2]! * t } };
    }
    let a = 0;
    if (tMax[1]! < tMax[a]!) a = 1;
    if (tMax[2]! < tMax[a]!) a = 2;
    t = tMax[a]!;
    cell[a] = cell[a]! + step[a]!;
    tMax[a] = tMax[a]! + tDelta[a]!;
    normal = [0, 0, 0];
    normal[a] = -step[a]!;
    if (cell[a]! < g.min[a]! || cell[a]! >= g.max[a]!) return null;
  }
  return null;
}

// ---- deterministic variant choice ---------------------------------------------------------

/** The variant a cell without one shows: weighted by the variants' weights, keyed by the cell coordinates (stable). */
export function autoVariant(t: Pick<BlockType, 'variants'>, x: number, y: number, z: number): number {
  const n = t.variants.length;
  if (n <= 1) return 0;
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  const weights = t.variants.map((v) => v.weight ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let pick = (h / 4294967296) * total;
  for (let i = 0; i < n; i++) {
    pick -= weights[i]!;
    if (pick < 0) return i;
  }
  return n - 1;
}

/** The look an edge piece without a variant shows: weighted, keyed by its place (the x- and z-line edges of one cell pick apart). */
export function edgeAutoVariant(t: Pick<BlockType, 'variants'>, x: number, y: number, z: number, axis: number): number {
  return autoVariant(t, x * 2 + axis, y, z);
}

/** The key of a canonical cell value (re-exported for the grid's callers). */
export { blockCellKey };
