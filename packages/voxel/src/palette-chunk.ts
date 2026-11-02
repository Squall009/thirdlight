/**
 * A chunk that is not one voxel everywhere, held as palettes: one record
 * palette (whole voxel values as entries) or one palette per field
 * (material, role, shape, wetness; a measurement candidate), each with its
 * cells in a {@link CellLayout}.
 */
import type { LayoutKind } from './cell-layout';
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { createChunkImage, type ChunkImage, type PaletteKind } from './palette-image';
import { PalettePlane, type PlaneImage, type PlaneWire } from './palette-plane';
import { readValue, recordValue, valueMaterial, valueRole, valueShape, valueWetness, type VoxelRecord } from './record';

export interface PaletteChunk {
  readonly kind: PaletteKind;
  /** Cell `i`'s voxel, written into `out`. */
  read(i: number, out: VoxelRecord): VoxelRecord;
  /** Sets cell `i` to a value (checked; air is 0). */
  write(i: number, value: number): void;
  /** The value of the one voxel the chunk now holds everywhere, or −1. */
  uniformValue(): number;
  /** Writes every cell into `out`. */
  toCells(out: DenseChunk): void;
  /** Writes the chunk's canonical image (entries in order of first appearance) into `img`. */
  toImage(img: ChunkImage): void;
  /** Bytes of its arrays. */
  bytes(): number;
}

const images = new Map<number, ChunkImage>();

/** A reusable image for `grid` (single-threaded use only). */
export function scratchImage(grid: ChunkGrid): ChunkImage {
  let img = images.get(grid.edge);
  if (img === undefined) {
    img = createChunkImage(grid);
    images.set(grid.edge, img);
  }
  return img;
}

/** The image of a chunk holding one voxel value everywhere. */
export function uniformImage(img: ChunkImage, value: number): void {
  img.kind = 'record';
  const p = img.planes[0];
  p.count = 1;
  p.values[0] = value;
  p.counts[0] = img.grid.cellsPerChunk;
  p.ids.fill(0);
}

const remaps = new Map<number, Int32Array>();

/** A plane's entries renumbered by first appearance into `out` (its ids, values and counts). */
function canonicalPlane(plane: PalettePlane, out: PlaneImage): void {
  let remap = remaps.get(plane.size);
  if (remap === undefined) {
    remap = new Int32Array(plane.size);
    remaps.set(plane.size, remap);
  }
  remap.fill(-1);
  const ids = out.ids;
  plane.layout.unpack(ids);
  let count = 0;
  for (let i = 0; i < ids.length; i++) {
    const e = ids[i]!;
    let r = remap[e]!;
    if (r < 0) {
      r = count++;
      remap[e] = r;
      out.values[r] = plane.values[e]!;
      out.counts[r] = 0;
    }
    ids[i] = r;
    out.counts[r]!++;
  }
  out.count = count;
}

/** A record chunk's arrays, as they cross to or from a worker (see chunk-wire.ts). */
export interface RecordChunkWire {
  readonly plane: PlaneWire;
}

export class RecordChunk implements PaletteChunk {
  readonly kind = 'record';
  private readonly grid: ChunkGrid;
  private readonly plane: PalettePlane;

  constructor(grid: ChunkGrid, plane: PalettePlane) {
    this.grid = grid;
    this.plane = plane;
  }

  static fromImage(img: ChunkImage, layout: LayoutKind): RecordChunk {
    return new RecordChunk(img.grid, PalettePlane.fromImage(img.grid, layout, img.planes[0]));
  }

  /** The chunk's arrays for a worker message (copied when `copy`, else handed over and this chunk is dropped). */
  toWire(copy: boolean): RecordChunkWire {
    return { plane: this.plane.toWire(copy) };
  }

  /** A chunk over a wire's arrays (adopted, no per-cell work); throws unless they are consistent. */
  static fromWire(grid: ChunkGrid, w: RecordChunkWire): RecordChunk {
    return new RecordChunk(grid, PalettePlane.fromWire(grid, w.plane));
  }

  /** A chunk holding one value everywhere, ready to be edited. */
  static filled(grid: ChunkGrid, layout: LayoutKind, value: number): RecordChunk {
    return new RecordChunk(grid, PalettePlane.single(grid, layout, value));
  }

  read(i: number, out: VoxelRecord): VoxelRecord {
    const p = this.plane;
    return readValue(p.values[p.layout.get(i)]!, out);
  }

  write(i: number, value: number): void {
    this.plane.set(i, value);
  }

  uniformValue(): number {
    const p = this.plane;
    return p.live === 1 ? p.values[0]! : -1;
  }

  toCells(out: DenseChunk): void {
    const img = scratchImage(this.grid);
    const ids = img.planes[0].ids;
    this.plane.layout.unpack(ids);
    const values = this.plane.values;
    for (let i = 0; i < ids.length; i++) {
      const v = values[ids[i]!]!;
      out.material[i] = valueMaterial(v);
      out.role[i] = valueRole(v);
      out.shape[i] = valueShape(v);
      out.wetness[i] = valueWetness(v);
    }
  }

  toImage(img: ChunkImage): void {
    img.kind = 'record';
    canonicalPlane(this.plane, img.planes[0]);
  }

  bytes(): number {
    return this.plane.bytes();
  }
}

export class PlanesChunk implements PaletteChunk {
  readonly kind = 'planes';
  private readonly grid: ChunkGrid;
  private readonly planes: [PalettePlane, PalettePlane, PalettePlane, PalettePlane];

  constructor(grid: ChunkGrid, planes: [PalettePlane, PalettePlane, PalettePlane, PalettePlane]) {
    this.grid = grid;
    this.planes = planes;
  }

  static fromImage(img: ChunkImage, layout: LayoutKind): PlanesChunk {
    const g = img.grid;
    const [m, r, s, w] = img.planes;
    return new PlanesChunk(g, [PalettePlane.fromImage(g, layout, m), PalettePlane.fromImage(g, layout, r), PalettePlane.fromImage(g, layout, s), PalettePlane.fromImage(g, layout, w)]);
  }

  static filled(grid: ChunkGrid, layout: LayoutKind, value: number): PlanesChunk {
    const single = (v: number): PalettePlane => PalettePlane.single(grid, layout, v);
    return new PlanesChunk(grid, [single(valueMaterial(value)), single(valueRole(value)), single(valueShape(value)), single(valueWetness(value))]);
  }

  read(i: number, out: VoxelRecord): VoxelRecord {
    const [m, r, s, w] = this.planes;
    out.material = m.values[m.layout.get(i)]!;
    out.role = r.values[r.layout.get(i)]!;
    out.shape = s.values[s.layout.get(i)]!;
    out.wetness = w.values[w.layout.get(i)]!;
    return out;
  }

  write(i: number, value: number): void {
    const [m, r, s, w] = this.planes;
    m.set(i, valueMaterial(value));
    r.set(i, valueRole(value));
    s.set(i, valueShape(value));
    w.set(i, valueWetness(value));
  }

  uniformValue(): number {
    const [m, r, s, w] = this.planes;
    if (m.live !== 1 || r.live !== 1 || s.live !== 1 || w.live !== 1) return -1;
    return m.values[0] === 0 ? 0 : recordValue(m.values[0]!, r.values[0]!, s.values[0]!, w.values[0]!);
  }

  toCells(out: DenseChunk): void {
    const ids = scratchImage(this.grid).planes[0].ids;
    const targets = [out.material, out.role, out.shape, out.wetness] as const;
    for (let k = 0; k < 4; k++) {
      const p = this.planes[k]!;
      const t = targets[k]!;
      p.layout.unpack(ids);
      for (let i = 0; i < ids.length; i++) t[i] = p.values[ids[i]!]!;
    }
  }

  toImage(img: ChunkImage): void {
    img.kind = 'planes';
    for (let k = 0; k < 4; k++) canonicalPlane(this.planes[k]!, img.planes[k]!);
  }

  bytes(): number {
    return this.planes.reduce((n, p) => n + p.bytes(), 0);
  }
}
