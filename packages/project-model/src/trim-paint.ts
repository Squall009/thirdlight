/**
 * Paint on generated trim meshes. A block layer's wall paint (`blockLayer.wallPaint`) is stored on the layer's
 * column-border planes in layer metres, not on any mesh, so a mesh laid along those walls — generated
 * architecture, made again whenever its parameters change — reads it at its vertices each time it is made and
 * the paint stays where it was painted.
 *
 * Into the trim colour channels (`trim-sheet.ts`): G grime is one paint layer's weight, B the painted wetness;
 * R occlusion is the generator's own (left as written, or taken from `occlusion`). Vertices facing up or down
 * have no wall paint and are left clean and dry.
 */
import { PAINT_CHANNELS, PAINT_WETNESS_CHANNEL } from './block-paint';
import { wallPaintAt, type WallPaint } from './block-wall-paint';
import { TRIM_COLOUR_GRIME, TRIM_COLOUR_OCCLUSION, TRIM_COLOUR_WETNESS } from './trim-sheet';

/**
 * The paint layer whose weight is grime by default: the third (index 2). An unpainted wall is all the second
 * layer and an unpainted top all the first, so the third is the first one only a brush puts there.
 */
export const TRIM_GRIME_PAINT_LAYER = 2;

export interface TrimWallPaintOptions {
  /** The layer's cell size (metres). */
  readonly cellSize: readonly number[];
  /** A chunk's wall points (null: none). */
  points(cx: number, cz: number): WallPaint | null;
  /** The paint layer (0–3) read as grime (absent: {@link TRIM_GRIME_PAINT_LAYER}). */
  readonly grimeLayer?: number;
  /** Per-vertex occlusion (0–1) for R (absent: R as already written). */
  readonly occlusion?: ArrayLike<number>;
}

/**
 * COLOR_0 (RGBA floats, `out`) of a trim mesh from the layer's wall paint at its vertices: `positions` and
 * `normals` in the layer's frame (metres). Writes every vertex's G, B and A; R only with `occlusion`.
 */
export function trimColoursFromWallPaint(positions: ArrayLike<number>, normals: ArrayLike<number>, out: Float32Array, o: TrimWallPaintOptions): void {
  const value = new Float64Array(PAINT_CHANNELS);
  const grimeLayer = o.grimeLayer ?? TRIM_GRIME_PAINT_LAYER;
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i++) {
    const nx = normals[i * 3]!;
    const ny = normals[i * 3 + 1]!;
    const nz = normals[i * 3 + 2]!;
    let grime = 0;
    let wet = 0;
    if (Math.abs(ny) < Math.max(Math.abs(nx), Math.abs(nz))) {
      const side = Math.abs(nx) >= Math.abs(nz) ? (nx > 0 ? 0 : 1) : nz > 0 ? 2 : 3;
      const px = positions[i * 3]!;
      const pz = positions[i * 3 + 2]!;
      wallPaintAt(o.points, o.cellSize, side, px, positions[i * 3 + 1]!, pz, px, pz, value);
      grime = value[grimeLayer]! / 255;
      wet = value[PAINT_WETNESS_CHANNEL]! / 255;
    }
    if (o.occlusion !== undefined) out[i * 4 + TRIM_COLOUR_OCCLUSION] = Math.max(0, Math.min(1, o.occlusion[i]!));
    out[i * 4 + TRIM_COLOUR_GRIME] = grime;
    out[i * 4 + TRIM_COLOUR_WETNESS] = wet;
    out[i * 4 + 3] = 1;
  }
}
