/**
 * Sloped roofs in fine far bricks: the roof mesher's planes, not the stair
 * of cells they are stored as.
 *
 * Why: a roof is stored as a 45° (or 1:2) stair one cell thick whose cells
 * touch only along their edges, and the near field draws it as a sloped slab
 * through the stair's outer corners (roof-mesher.ts). A distance field of the
 * cells themselves has no inside there (every corner touches air), so its
 * surface is a row of rounded steps that a ray at a slant passes between, and
 * its gradient (what the shade lights and textures by) turns with every step.
 * The planes, sampled at the field's corners, are linear, and a trilinear
 * read of a linear field is the plane itself: the roof's top comes back flat,
 * with its ridges and eaves where the near mesher puts them.
 *
 * - **Which cells.** A fine block's plane cells: roof cells drawn whole with
 *   nothing solid above them that the roof mesher's own reading
 *   (roof-words.ts `roofReading`) lays as a slope, read with the engine's
 *   damage stages. The highest such cell of a column is the column's roof;
 *   it leaves the cell field (its fill reads as air there) and keeps its
 *   look word, so the samples round it still show its material.
 * - **The column table** ({@link FarRoofColumns}): per block column the plane
 *   cell's height and its top at the column's four corners (the mesher's
 *   `roofTopAt`, quarter cells), the only thing the distance needs, since the
 *   field's corners lie on the cells' corners.
 * - **The distance** ({@link farRoofDistance}): at a corner over a roof
 *   column, the height above its top (or below its underside) times the
 *   slope's cosine, the exact distance to the plane; elsewhere, to the
 *   nearest roof column's span at its nearest corner. The slab is drawn
 *   {@link farRoofThickness} cells thick: a corner just under the top must
 *   read the top's plane, not the underside's, for the trilinear read to put
 *   the top where it is, so the slab is at least two sample spacings deep
 *   (the near mesher's is one cell; the far underside shows only under an
 *   eave). The cell field and the roofs' field join by their least.
 */
import { DISTANCE_BRICK_BAND_VOXELS } from './distance-brick-format';
import { roofReading, roofTopAt, ROOF_PLANE_REACH, ROOF_WORD, type RoofProbe } from './roof-words';

/**
 * Per block column (index z · n + x): 0 no plane cell; else bits 0–7 the plane cell's y in the block plus one, bits
 * 8–19 its top at the column's corners (3 bits each, quarter cells above the cell's top, corner ix + 2 · iz), bit 20
 * a 1:2 slope (else 45°).
 */
export type FarRoofColumns = Uint32Array;

/** The column table's fields. */
export const FAR_ROOF_COLUMN = Object.freeze({ yMask: 0xff, cornerShift: 8, cornerBits: 3, shallow: 1 << 20 });

/** Cos of a 45° roof's slope and of a 1:2 one's: a height above the plane times it is the distance to the plane. */
export const FAR_ROOF_COS_STEEP = Math.SQRT1_2;
export const FAR_ROOF_COS_SHALLOW = 2 / Math.sqrt(5);

/** Cells past a block's side its roofs are read from: the reading's reach and the cell above. */
export const FAR_ROOF_READ_PAD = ROOF_PLANE_REACH + 1;

/** A drawn roof slab's depth (finer cells) at a build scale: two of the field's sample spacings. */
export function farRoofThickness(scale: number): number {
  return 2 * scale;
}

/** Horizontal reach (finer cells) a corner reads roof columns over: the band at the node's spacing and one cell. */
export function farRoofReach(scale: number): number {
  return DISTANCE_BRICK_BAND_VOXELS * scale + 1;
}

/**
 * The column table of a block of `n` cells a side from its cells and {@link FAR_ROOF_READ_PAD} more round it
 * (−pad … n + pad − 1 an axis): `roof(x, y, z)` whether block cell (x, y, z) is a roof cell the roof mesher reads
 * (roof-words.ts `isRoofCellValue`), `solid(x, y, z)` whether it is solid for the mesher (not an open role, half full
 * or more). Null when no column has a plane cell.
 */
export function farRoofColumns(n: number, roof: (x: number, y: number, z: number) => boolean, solid: (x: number, y: number, z: number) => boolean): FarRoofColumns | null {
  let ax = 0, ay = 0, az = 0;
  const probe: RoofProbe = (dx, dy, dz) => roof(ax + dx, ay + dy, az + dz);
  let out: FarRoofColumns | null = null;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    for (let y = n - 1; y >= 0; y--) {
      if (!roof(x, y, z) || solid(x, y + 1, z)) continue;
      ax = x;
      ay = y;
      az = z;
      const w = roofReading(probe);
      if (w === 0) continue;
      let c = (y + 1) | ((w & ROOF_WORD.shallow) !== 0 ? FAR_ROOF_COLUMN.shallow : 0);
      for (let k = 0; k < 4; k++) c |= roofTopAt(w, 4 * (k & 1), 4 * (k >> 1)) << (FAR_ROOF_COLUMN.cornerShift + FAR_ROOF_COLUMN.cornerBits * k);
      out ??= new Uint32Array(n * n);
      out[z * n + x] = c;
      break;
    }
  }
  return out;
}

/** Whether block cell (x, y, z) is its column's plane cell. */
export function isFarRoofCell(roofs: FarRoofColumns, n: number, x: number, y: number, z: number): boolean {
  return (roofs[z * n + x]! & FAR_ROOF_COLUMN.yMask) === y + 1;
}

/**
 * The signed distance (finer cells; Infinity: no roof in reach) from block corner (X, Y, Z) to the roofs' slabs
 * ({@link farRoofThickness} deep at `scale`). The GPU build (three-adapter voxel-fine-bricks-wgsl.ts) mirrors it.
 */
export function farRoofDistance(roofs: FarRoofColumns, n: number, X: number, Y: number, Z: number, scale: number): number {
  const R = farRoofReach(scale);
  const T = farRoofThickness(scale);
  let best = Infinity;
  for (let cz = Math.max(0, Z - R); cz < Math.min(n, Z + R); cz++) for (let cx = Math.max(0, X - R); cx < Math.min(n, X + R); cx++) {
    const c = roofs[cz * n + cx]!;
    if (c === 0) continue;
    const qx = Math.min(Math.max(X, cx), cx + 1);
    const qz = Math.min(Math.max(Z, cz), cz + 1);
    const k = qx - cx + 2 * (qz - cz);
    const h = (c & FAR_ROOF_COLUMN.yMask) + ((c >>> (FAR_ROOF_COLUMN.cornerShift + FAR_ROOF_COLUMN.cornerBits * k)) & 7) / 4;
    const b = h - T;
    const ex = X - qx;
    const ez = Z - qz;
    let d: number;
    if (ex === 0 && ez === 0) {
      // Over the column: the height off the plane, times the slope's cosine, is the distance to it.
      const cos = (c & FAR_ROOF_COLUMN.shallow) !== 0 ? FAR_ROOF_COS_SHALLOW : FAR_ROOF_COS_STEEP;
      d = (Y > h ? Y - h : Y < b ? b - Y : -Math.min(h - Y, Y - b)) * cos;
    } else {
      const dy = Y > h ? Y - h : Y < b ? b - Y : 0;
      d = Math.sqrt(ex * ex + ez * ez + dy * dy);
    }
    if (d < best) best = d;
  }
  return best;
}
