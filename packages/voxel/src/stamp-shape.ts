/**
 * A stamp's voxelized shape: a plain mesh (a bridge, an arch, a rock)
 * voxelized once, at import, into a box of 0.5 m cells in its own frame,
 * each holding how much of the cell the mesh fills (0 … 255). A stamp
 * command places it anywhere with any material; the shape is content, named
 * by its hash so a command always means the same cells.
 */
import { sha256Hex } from '@thirdlight/shared';

export interface StampShape {
  /** Cells along x, y, z. */
  readonly size: readonly [number, number, number];
  /** Coverage per cell, index (x × size z + z) × size y + y (y fastest, like chunks). */
  readonly coverage: Uint8Array;
}

/** Largest side of a stamp in cells (u16 in the hash header). */
export const STAMP_SIDE_MAX = 0xffff;

/** Throws unless the shape's sizes and coverage agree. */
export function checkStampShape(s: StampShape): void {
  const [x, y, z] = s.size;
  for (const n of s.size) if (!Number.isInteger(n) || n < 1 || n > STAMP_SIDE_MAX) throw new RangeError(`stamp side ${n} not in [1, ${STAMP_SIDE_MAX}]`);
  if (s.coverage.length !== x * y * z) throw new RangeError(`stamp coverage holds ${s.coverage.length} cells, its size ${x * y * z}`);
}

/** The shape's content hash (SHA-256 hex of its sizes, u16 little-endian, then its coverage). */
export function stampShapeHash(s: StampShape): string {
  checkStampShape(s);
  const bytes = new Uint8Array(6 + s.coverage.length);
  const view = new DataView(bytes.buffer);
  s.size.forEach((n, i) => view.setUint16(i * 2, n, true));
  bytes.set(s.coverage, 6);
  return sha256Hex(bytes);
}

/** Finds a stamp's shape by id (with the hash it was computed to have), or undefined. */
export type StampResolver = (id: string) => { readonly shape: StampShape; readonly hash: string } | undefined;
