/**
 * Stroke edits: one shape written with one voxel record.
 *
 * Edits are strokes, not single cells, so one command covers a brush dab, a
 * fill or a dig. Which cells a stroke covers is defined here once, so every
 * store candidate writes exactly the same cells and the oracle can check
 * them. (Brush falloff, partial density at a stroke's rim and stamps come
 * with the edit commands; a stroke here writes whole cells.)
 */
import { cellInWorld } from './coords';
import { checkVoxel, type VoxelRecord } from './record';

/** What {@link applyStrokeCells} writes through: a store's single-cell write. */
export interface CellWriter {
  setVoxel(x: number, y: number, z: number, v: Readonly<VoxelRecord>): void;
}

/** An integer cell position. */
export type Cell = readonly [number, number, number];

/** A box of cells, both corners inclusive. */
export interface BoxStroke {
  readonly kind: 'box';
  readonly min: Cell;
  readonly max: Cell;
  readonly voxel: Readonly<VoxelRecord>;
}

/** A ball of cells around a cell: every cell whose offset from `center` is at most `radius` cells long. */
export interface SphereStroke {
  readonly kind: 'sphere';
  readonly center: Cell;
  readonly radius: number;
  readonly voxel: Readonly<VoxelRecord>;
}

export type VoxelStroke = BoxStroke | SphereStroke;

/** The inclusive cell bounds a stroke can touch. */
export interface CellBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Throws unless the stroke is well formed and inside the world. */
export function checkStroke(stroke: VoxelStroke): void {
  checkVoxel(stroke.voxel);
  const b = strokeBounds(stroke);
  if (stroke.kind === 'sphere' && !(Number.isFinite(stroke.radius) && stroke.radius >= 0)) throw new RangeError(`sphere radius must be ≥ 0, got ${stroke.radius}`);
  if (b.minX > b.maxX || b.minY > b.maxY || b.minZ > b.maxZ) throw new RangeError('box stroke has min above max');
  if (!cellInWorld(b.minX, b.minY, b.minZ) || !cellInWorld(b.maxX, b.maxY, b.maxZ)) throw new RangeError('stroke reaches outside the world');
}

/** The inclusive cell bounds of a stroke. */
export function strokeBounds(stroke: VoxelStroke): CellBox {
  if (stroke.kind === 'box') {
    const [x0, y0, z0] = stroke.min;
    const [x1, y1, z1] = stroke.max;
    return { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 };
  }
  const [x, y, z] = stroke.center;
  const r = Math.floor(stroke.radius);
  return { minX: x - r, minY: y - r, minZ: z - r, maxX: x + r, maxY: y + r, maxZ: z + r };
}

/** Whether a stroke writes cell (x, y, z). */
export function strokeCovers(stroke: VoxelStroke, x: number, y: number, z: number): boolean {
  if (stroke.kind === 'box') {
    return x >= stroke.min[0] && x <= stroke.max[0] && y >= stroke.min[1] && y <= stroke.max[1] && z >= stroke.min[2] && z <= stroke.max[2];
  }
  const dx = x - stroke.center[0];
  const dy = y - stroke.center[1];
  const dz = z - stroke.center[2];
  return dx * dx + dy * dy + dz * dz <= stroke.radius * stroke.radius;
}

/**
 * Writes every cell a stroke covers through `store.setVoxel` (x, then z,
 * then y innermost, so a column's cells are written in a row) and returns
 * how many it wrote: the one stroke loop every store shares, so every
 * store writes exactly the same cells.
 */
export function applyStrokeCells(store: CellWriter, stroke: VoxelStroke): number {
  checkStroke(stroke);
  const b = strokeBounds(stroke);
  let written = 0;
  for (let x = b.minX; x <= b.maxX; x++) {
    for (let z = b.minZ; z <= b.maxZ; z++) {
      for (let y = b.minY; y <= b.maxY; y++) {
        if (!strokeCovers(stroke, x, y, z)) continue;
        store.setVoxel(x, y, z, stroke.voxel);
        written++;
      }
    }
  }
  return written;
}
