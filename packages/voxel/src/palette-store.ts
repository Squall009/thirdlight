/**
 * The palette chunk store: every chunk in one compact form, with the
 * savings in the encoding rather than in a second format.
 *
 * - A chunk that is one voxel everywhere (deep ground, a filled room)
 *   collapses to a single number in the chunk index; an all-air chunk is
 *   not stored at all. Edits collapse and expand chunks as they go.
 * - Any other chunk is a palette (one record palette of whole voxels, or
 *   one palette per plane) with its cells bit-packed or as vertical runs.
 * - Density is stored only for surface voxels (see surface-density.ts).
 * - At rest a chunk is the palette codec's canonical bytes
 *   (palette-codec.ts), bit-packed or as runs whatever the memory layout.
 *
 * A store may keep fewer planes than the record has (to measure what a
 * plane costs in memory); it then reads the others as 0 (shape: implied).
 */
import type { LayoutKind } from './cell-layout';
import { ChunkIndex } from './chunk-index';
import { cellInWorld, localIndex, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { checkChunk } from './dense-store';
import { PlanesChunk, RecordChunk, scratchImage, uniformImage, type PaletteChunk } from './palette-chunk';
import { decodePaletteImage, encodePaletteImage } from './palette-codec';
import { imageToCells, planesImageFromCells, recordImageFromCells, recordValue, valueCategory, valueMaterial, valueOrientation, type ChunkImage, type PaletteKind } from './palette-image';
import { MATERIAL_AIR, PLANE_BIT, planeMask, VOXEL_PLANES, type VoxelPlane, type VoxelRecord } from './record';
import type { VoxelStoreCandidate } from './store';
import { applyStrokeCells, type VoxelStroke } from './stroke';
import { impliedShape } from './surface-density';

export interface PaletteStoreOptions {
  /** Report name. */
  name: string;
  /** One record palette per chunk, or one palette per plane. */
  palette: PaletteKind;
  /** How cells point at their entries in memory. */
  layout: LayoutKind;
  /** How the bytes at rest hold the entry ids. */
  atRest: LayoutKind;
  /** Planes kept (default all). */
  planes?: readonly VoxelPlane[];
}

/** Bytes a collapsed chunk costs: one number in the index. */
const UNIFORM_BYTES = 8;

/** A chunk in the index: a record value (one voxel everywhere, implied shape) or a palette chunk. */
type Slot = number | PaletteChunk;

export class PaletteStore implements VoxelStoreCandidate {
  readonly name: string;
  readonly grid: ChunkGrid;
  readonly planes: readonly VoxelPlane[];
  private readonly opts: PaletteStoreOptions;
  private readonly mask: number;
  private readonly chunks: ChunkIndex<Slot>;
  private readonly cells: DenseChunk;
  private lastCol = -2;
  private lastY = -2;
  private lastSlot: Slot | undefined;

  constructor(grid: ChunkGrid, opts: PaletteStoreOptions) {
    this.grid = grid;
    this.opts = opts;
    this.name = opts.name;
    this.planes = opts.planes ?? VOXEL_PLANES;
    this.mask = planeMask(this.planes) | PLANE_BIT.material;
    this.chunks = new ChunkIndex<Slot>(grid);
    this.cells = createDenseChunk(grid);
  }

  private slotAt(x: number, y: number, z: number): Slot | undefined {
    const s = this.grid.shift;
    const col = this.chunks.colKey(x >> s, z >> s);
    const cy = this.chunks.yKey(y >> s);
    if (col === this.lastCol && cy === this.lastY) return this.lastSlot;
    const slot = this.chunks.getKey(col, cy);
    this.lastCol = col;
    this.lastY = cy;
    this.lastSlot = slot;
    return slot;
  }

  private forget(): void {
    this.lastCol = -2;
    this.lastY = -2;
    this.lastSlot = undefined;
  }

  voxelAt(x: number, y: number, z: number, out: VoxelRecord): VoxelRecord {
    const slot = this.slotAt(x, y, z);
    if (slot === undefined) {
      out.material = MATERIAL_AIR;
      out.category = 0;
      out.shape = 0;
      out.orientation = 0;
      return out;
    }
    if (typeof slot === 'number') {
      const m = slot & 0xffff;
      out.material = m;
      out.category = (slot >>> 16) & 0xff;
      out.orientation = slot >>> 24;
      out.shape = impliedShape(m);
      return out;
    }
    const g = this.grid;
    return slot.read(localIndex(g, x & g.mask, y & g.mask, z & g.mask), out);
  }

  /** A palette chunk holding `value` everywhere. */
  private expand(value: number): PaletteChunk {
    return this.opts.palette === 'record' ? RecordChunk.filled(this.grid, this.opts.layout, value) : PlanesChunk.filled(this.grid, this.opts.layout, value);
  }

  setVoxel(x: number, y: number, z: number, v: Readonly<VoxelRecord>): void {
    if (!cellInWorld(x, y, z)) throw new RangeError(`cell (${x}, ${y}, ${z}) is outside the world`);
    const air = v.material === MATERIAL_AIR;
    const m = v.material;
    const c = air || !(this.mask & PLANE_BIT.category) ? 0 : v.category;
    const o = air || !(this.mask & PLANE_BIT.orientation) ? 0 : v.orientation;
    const s = air ? 0 : this.mask & PLANE_BIT.shape ? v.shape : impliedShape(m);
    let slot = this.slotAt(x, y, z);
    const sh = this.grid.shift;
    if (slot === undefined) {
      if (air) return;
      slot = 0;
    }
    let chunk: PaletteChunk;
    const cx = x >> sh;
    const cy = y >> sh;
    const cz = z >> sh;
    if (typeof slot === 'number') {
      if (slot === recordValue(m, c, o) && s === impliedShape(m)) return;
      chunk = this.expand(slot);
      this.chunks.set(cx, cy, cz, chunk);
      this.lastSlot = chunk;
    } else {
      chunk = slot;
    }
    const g = this.grid;
    chunk.write(localIndex(g, x & g.mask, y & g.mask, z & g.mask), m, c, s, o);
    const u = chunk.uniformValue();
    if (u < 0) return;
    if (u === 0) this.chunks.delete(cx, cy, cz);
    else this.chunks.set(cx, cy, cz, u);
    this.forget();
  }

  applyStroke(stroke: VoxelStroke): number {
    return applyStrokeCells(this, stroke);
  }

  /** Stores the chunk an image describes (absent when all air, a number when one voxel). */
  private storeImage(cx: number, cy: number, cz: number, img: ChunkImage): void {
    this.forget();
    const uniform = img.densCount === 0 && (img.kind === 'record' ? img.planes[0].count === 1 : img.planes.every((p) => p.count === 1));
    if (uniform) {
      const value = img.kind === 'record' ? img.planes[0].values[0]! : recordValue(img.planes[0].values[0]!, img.planes[1].values[0]!, img.planes[2].values[0]!);
      if (value === 0) this.chunks.delete(cx, cy, cz);
      else this.chunks.set(cx, cy, cz, value);
      return;
    }
    this.chunks.set(cx, cy, cz, img.kind === 'record' ? RecordChunk.fromImage(img, this.opts.layout) : PlanesChunk.fromImage(img, this.opts.layout));
  }

  /** The image of a chunk's cells in this store's palette kind, keeping `mask`'s planes. */
  private imageOf(cells: DenseChunk, mask: number): ChunkImage {
    const img = scratchImage(this.grid);
    if (this.opts.palette === 'record') recordImageFromCells(cells, mask, img);
    else planesImageFromCells(cells, mask, img);
    return img;
  }

  importChunk(cx: number, cy: number, cz: number, cells: DenseChunk): void {
    checkChunk(this.grid, cx, cy, cz);
    this.storeImage(cx, cy, cz, this.imageOf(cells, this.mask));
  }

  exportChunk(cx: number, cy: number, cz: number, out: DenseChunk): boolean {
    checkChunk(this.grid, cx, cy, cz);
    const slot = this.chunks.get(cx, cy, cz);
    if (slot === undefined) return false;
    if (typeof slot === 'number') {
      const m = valueMaterial(slot);
      out.material.fill(m);
      out.category.fill(valueCategory(slot));
      out.shape.fill(impliedShape(m));
      out.orientation.fill(valueOrientation(slot));
      return true;
    }
    slot.toCells(out);
    return true;
  }

  chunkForm(cx: number, cy: number, cz: number): 'absent' | 'uniform' | 'stored' {
    const slot = this.chunks.get(cx, cy, cz);
    return slot === undefined ? 'absent' : typeof slot === 'number' ? 'uniform' : 'stored';
  }

  dropChunk(cx: number, cy: number, cz: number): void {
    checkChunk(this.grid, cx, cy, cz);
    this.chunks.delete(cx, cy, cz);
    this.forget();
  }

  chunkKeys(): Iterable<number> {
    return this.chunks.keys();
  }

  encodeChunk(cx: number, cy: number, cz: number, planes: readonly VoxelPlane[] = VOXEL_PLANES): Uint8Array | null {
    checkChunk(this.grid, cx, cy, cz);
    const slot = this.chunks.get(cx, cy, cz);
    if (slot === undefined) return null;
    const mask = planeMask(planes) & this.mask;
    const img = scratchImage(this.grid);
    if (typeof slot === 'number') uniformImage(img, slot);
    else if (mask === this.mask) slot.toImage(img);
    else {
      // Dropping a plane can merge palette entries: rebuild the image from the cells.
      slot.toCells(this.cells);
      this.imageOf(this.cells, mask);
    }
    return encodePaletteImage(img, mask, this.opts.atRest);
  }

  decodeChunk(cx: number, cy: number, cz: number, bytes: Uint8Array): void {
    checkChunk(this.grid, cx, cy, cz);
    const img = scratchImage(this.grid);
    const h = decodePaletteImage(bytes, img);
    // Bytes of the other palette kind, or holding planes this store drops, go through cells.
    if ((img.kind !== this.opts.palette && h.body !== 'uniform') || (h.planes & ~this.mask) !== 0) {
      imageToCells(img, this.cells);
      this.importChunk(cx, cy, cz, this.cells);
      return;
    }
    this.storeImage(cx, cy, cz, img);
  }

  memoryBytes(): number {
    let bytes = 0;
    for (const slot of this.chunks.valuesIter()) bytes += typeof slot === 'number' ? UNIFORM_BYTES : slot.bytes();
    return bytes;
  }
}
