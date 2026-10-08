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
import { decodeWallPaint, wallPaintAt, type WallPaint } from './block-wall-paint';
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

/**
 * A generated mesh's COLOR_0 bytes (`colors`, RGBA) from a block layer's wall
 * paint (`ArchitecturePaint`: the layer's cell size, the mesh frame's offset
 * into the layer's, the chunks' wall paint): G grime and B wetness written for
 * every vertex (0 on faces looking up or down, and where nothing is painted),
 * R (the generator's baked AO) and A left as they are.
 */
export function paintArchitectureColours(positions: ArrayLike<number>, normals: ArrayLike<number>, colors: Uint8Array, paint: { readonly cellSize: readonly number[]; readonly offset: readonly number[]; readonly chunks: Readonly<Record<string, string>> }, grimeLayer: number = TRIM_GRIME_PAINT_LAYER): void {
  const decoded = new Map<string, WallPaint | null>();
  const points = (cx: number, cz: number): WallPaint | null => {
    const k = `${cx},${cz}`;
    let w = decoded.get(k);
    if (w === undefined) decoded.set(k, (w = decodedWallPaint(paint.chunks[k])));
    return w;
  };
  const value = new Float64Array(PAINT_CHANNELS);
  const [ox, oy, oz] = [paint.offset[0] ?? 0, paint.offset[1] ?? 0, paint.offset[2] ?? 0];
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i++) {
    const nx = normals[i * 3]!;
    const ny = normals[i * 3 + 1]!;
    const nz = normals[i * 3 + 2]!;
    let grime = 0;
    let wet = 0;
    if (Math.abs(ny) < Math.max(Math.abs(nx), Math.abs(nz))) {
      const side = Math.abs(nx) >= Math.abs(nz) ? (nx > 0 ? 0 : 1) : nz > 0 ? 2 : 3;
      const px = positions[i * 3]! + ox;
      const pz = positions[i * 3 + 2]! + oz;
      wallPaintAt(points, paint.cellSize, side, px, positions[i * 3 + 1]! + oy, pz, px, pz, value);
      grime = value[grimeLayer]!;
      wet = value[PAINT_WETNESS_CHANNEL]!;
    }
    colors[i * 4 + TRIM_COLOUR_GRIME] = Math.round(Math.max(0, Math.min(255, grime)));
    colors[i * 4 + TRIM_COLOUR_WETNESS] = Math.round(Math.max(0, Math.min(255, wet)));
  }
}

/**
 * Decoded wall paint kept by its text: the chunks a generator job reads are
 * mostly the ones the jobs before it read (neighbouring chunks of one
 * layer), so a worker decodes each once. A cache's bound, not a project's.
 */
const DECODED_WALL_PAINT_KEPT = 64;
const decodedKept = new Map<string, WallPaint | null>();

function decodedWallPaint(text: string | undefined): WallPaint | null {
  if (text === undefined) return null;
  const known = decodedKept.get(text);
  if (known !== undefined) return known;
  const w = decodeWallPaint(text);
  if (decodedKept.size >= DECODED_WALL_PAINT_KEPT) decodedKept.delete(decodedKept.keys().next().value!);
  decodedKept.set(text, w);
  return w;
}
