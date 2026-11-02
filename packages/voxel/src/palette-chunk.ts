/**
 * A chunk that is not one voxel everywhere, held as palettes: one record
 * palette (whole voxels as entries) or one palette per plane (material with
 * the density flag, category, orientation), each with its cells in a
 * {@link CellLayout}, plus the densities of its surface voxels.
 */
import type { LayoutKind } from './cell-layout';
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { createChunkImage, recordValue, valueCategory, valueMaterial, valueOrientation, type ChunkImage, type PaletteKind } from './palette-image';
import { PalettePlane, type PlaneImage, type PlaneWire } from './palette-plane';
import type { VoxelRecord } from './record';
import { impliedShape, SurfaceDensity } from './surface-density';

export interface PaletteChunk {
  readonly kind: PaletteKind;
  /** Cell `i`'s voxel, written into `out`. */
  read(i: number, out: VoxelRecord): VoxelRecord;
  /** Sets cell `i` (fields already checked; air passed as all zeros). */
  write(i: number, material: number, category: number, shape: number, orientation: number): void;
  /** The record value ({@link recordValue}) of the one voxel the chunk now holds everywhere, or −1. */
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

/** The image of a chunk holding one voxel (a record value, implied shape) everywhere. */
export function uniformImage(img: ChunkImage, value: number): void {
  img.kind = 'record';
  const p = img.planes[0];
  p.count = 1;
  p.values[0] = value;
  p.flags[0] = 0;
  p.counts[0] = img.grid.cellsPerChunk;
  p.ids.fill(0);
  img.densCount = 0;
}

const remaps = new Map<number, Int32Array>();

/** A plane's entries renumbered by first appearance into `out` (its ids, values, flags and counts). */
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
      out.flags[r] = plane.flag(e) ? 1 : 0;
      out.counts[r] = 0;
    }
    ids[i] = r;
    out.counts[r]!++;
  }
  out.count = count;
}

function densityInto(density: SurfaceDensity | null, img: ChunkImage): void {
  const n = density?.count ?? 0;
  for (let k = 0; k < n; k++) {
    img.densCells[k] = density!.cellAt(k);
    img.densValues[k] = density!.densityAt(k);
  }
  img.densCount = n;
}

function densityOf(img: ChunkImage): SurfaceDensity | null {
  return img.densCount > 0 ? SurfaceDensity.from(img.densCells, img.densValues, img.densCount) : null;
}

/** Updates a chunk's surface densities after a write; `oldFlag` is what the plane's set returned. */
function updateDensity(density: SurfaceDensity | null, i: number, oldFlag: number, flagged: boolean, shape: number): SurfaceDensity | null {
  if (flagged) {
    const d = density ?? SurfaceDensity.empty();
    d.put(i, shape);
    return d;
  }
  if (oldFlag === 1 && density !== null) {
    density.remove(i);
    return density.count > 0 ? density : null;
  }
  return density;
}

/** A record chunk's arrays, as they cross to or from a worker (see chunk-wire.ts). */
export interface RecordChunkWire {
  readonly plane: PlaneWire;
  /** Surface voxels (`cell << 8 | density`, ascending), or null when it has none. */
  readonly density: Uint32Array | null;
}

export class RecordChunk implements PaletteChunk {
  readonly kind = 'record';
  private readonly grid: ChunkGrid;
  private readonly plane: PalettePlane;
  private density: SurfaceDensity | null;

  constructor(grid: ChunkGrid, plane: PalettePlane, density: SurfaceDensity | null) {
    this.grid = grid;
    this.plane = plane;
    this.density = density;
  }

  static fromImage(img: ChunkImage, layout: LayoutKind): RecordChunk {
    return new RecordChunk(img.grid, PalettePlane.fromImage(img.grid, layout, img.planes[0]), densityOf(img));
  }

  /** The chunk's arrays for a worker message (copied when `copy`, else handed over and this chunk is dropped). */
  toWire(copy: boolean): RecordChunkWire {
    return { plane: this.plane.toWire(copy), density: this.density === null ? null : this.density.toWire(copy) };
  }

  /**
   * A chunk over a wire's arrays (adopted, no per-cell work). Throws unless
   * they are consistent, and unless the flagged entries and the surface
   * list agree in count, so a damaged message never becomes a chunk.
   */
  static fromWire(grid: ChunkGrid, w: RecordChunkWire): RecordChunk {
    const plane = PalettePlane.fromWire(grid, w.plane);
    const density = w.density === null || w.density.length === 0 ? null : SurfaceDensity.fromWire(w.density, grid.cellsPerChunk);
    let flaggedCells = 0;
    for (let e = 0; e < plane.size; e++) if (plane.flag(e)) flaggedCells += plane.cellCount(e);
    if (flaggedCells !== (density?.count ?? 0)) throw new RangeError('chunk wire: flagged cells and surface voxels differ');
    return new RecordChunk(grid, plane, density);
  }

  /** A chunk holding one voxel (a record value, implied shape) everywhere, ready to be edited. */
  static filled(grid: ChunkGrid, layout: LayoutKind, value: number): RecordChunk {
    return new RecordChunk(grid, PalettePlane.single(grid, layout, value, false), null);
  }

  read(i: number, out: VoxelRecord): VoxelRecord {
    const p = this.plane;
    const e = p.layout.get(i);
    const v = p.values[e]!;
    const m = valueMaterial(v);
    out.material = m;
    out.category = valueCategory(v);
    out.orientation = valueOrientation(v);
    out.shape = p.flag(e) ? this.density!.get(i) : impliedShape(m);
    return out;
  }

  write(i: number, material: number, category: number, shape: number, orientation: number): void {
    const flagged = shape !== impliedShape(material);
    const old = this.plane.set(i, recordValue(material, category, orientation), flagged);
    if (old === -1 && !flagged) return;
    this.density = updateDensity(this.density, i, old, flagged, shape);
  }

  uniformValue(): number {
    const p = this.plane;
    return p.live === 1 && !p.flag(0) ? p.values[0]! : -1;
  }

  toCells(out: DenseChunk): void {
    const img = scratchImage(this.grid);
    const ids = img.planes[0].ids;
    this.plane.layout.unpack(ids);
    const values = this.plane.values;
    for (let i = 0; i < ids.length; i++) {
      const v = values[ids[i]!]!;
      const m = valueMaterial(v);
      out.material[i] = m;
      out.category[i] = valueCategory(v);
      out.orientation[i] = valueOrientation(v);
      out.shape[i] = impliedShape(m);
    }
    const d = this.density;
    if (d !== null) for (let k = 0; k < d.count; k++) out.shape[d.cellAt(k)] = d.densityAt(k);
  }

  toImage(img: ChunkImage): void {
    img.kind = 'record';
    canonicalPlane(this.plane, img.planes[0]);
    densityInto(this.density, img);
  }

  bytes(): number {
    return this.plane.bytes() + (this.density?.bytes() ?? 0);
  }
}

export class PlanesChunk implements PaletteChunk {
  readonly kind = 'planes';
  private readonly grid: ChunkGrid;
  private readonly material: PalettePlane;
  private readonly category: PalettePlane;
  private readonly orientation: PalettePlane;
  private density: SurfaceDensity | null;

  constructor(grid: ChunkGrid, planes: [PalettePlane, PalettePlane, PalettePlane], density: SurfaceDensity | null) {
    this.grid = grid;
    [this.material, this.category, this.orientation] = planes;
    this.density = density;
  }

  static fromImage(img: ChunkImage, layout: LayoutKind): PlanesChunk {
    const g = img.grid;
    const [m, c, o] = img.planes;
    return new PlanesChunk(g, [PalettePlane.fromImage(g, layout, m), PalettePlane.fromImage(g, layout, c), PalettePlane.fromImage(g, layout, o)], densityOf(img));
  }

  static filled(grid: ChunkGrid, layout: LayoutKind, value: number): PlanesChunk {
    return new PlanesChunk(
      grid,
      [
        PalettePlane.single(grid, layout, valueMaterial(value), false),
        PalettePlane.single(grid, layout, valueCategory(value), false),
        PalettePlane.single(grid, layout, valueOrientation(value), false),
      ],
      null,
    );
  }

  read(i: number, out: VoxelRecord): VoxelRecord {
    const pm = this.material;
    const e = pm.layout.get(i);
    const m = pm.values[e]!;
    out.material = m;
    out.category = this.category.values[this.category.layout.get(i)]!;
    out.orientation = this.orientation.values[this.orientation.layout.get(i)]!;
    out.shape = pm.flag(e) ? this.density!.get(i) : impliedShape(m);
    return out;
  }

  write(i: number, material: number, category: number, shape: number, orientation: number): void {
    const flagged = shape !== impliedShape(material);
    const old = this.material.set(i, material, flagged);
    this.category.set(i, category, false);
    this.orientation.set(i, orientation, false);
    if (old === -1 && !flagged) return;
    this.density = updateDensity(this.density, i, old, flagged, shape);
  }

  uniformValue(): number {
    const { material: m, category: c, orientation: o } = this;
    if (m.live !== 1 || c.live !== 1 || o.live !== 1 || m.flag(0)) return -1;
    return recordValue(m.values[0]!, c.values[0]!, o.values[0]!);
  }

  toCells(out: DenseChunk): void {
    const img = scratchImage(this.grid);
    const ids = img.planes[0].ids;
    const n = ids.length;
    this.material.layout.unpack(ids);
    for (let i = 0; i < n; i++) {
      const m = this.material.values[ids[i]!]!;
      out.material[i] = m;
      out.shape[i] = impliedShape(m);
    }
    this.category.layout.unpack(ids);
    for (let i = 0; i < n; i++) out.category[i] = this.category.values[ids[i]!]!;
    this.orientation.layout.unpack(ids);
    for (let i = 0; i < n; i++) out.orientation[i] = this.orientation.values[ids[i]!]!;
    const d = this.density;
    if (d !== null) for (let k = 0; k < d.count; k++) out.shape[d.cellAt(k)] = d.densityAt(k);
  }

  toImage(img: ChunkImage): void {
    img.kind = 'planes';
    canonicalPlane(this.material, img.planes[0]);
    canonicalPlane(this.category, img.planes[1]);
    canonicalPlane(this.orientation, img.planes[2]);
    densityInto(this.density, img);
  }

  bytes(): number {
    return this.material.bytes() + this.category.bytes() + this.orientation.bytes() + (this.density?.bytes() ?? 0);
  }
}
