/**
 * Paint on generated trim meshes. A block layer's wall paint (`blockLayer.wallPaint`) is stored on the layer's
 * column-border planes in layer metres, not on any mesh, so a mesh laid along those walls — generated
 * architecture, made again whenever its parameters change — reads it at its vertices each time it is made and
 * the paint stays where it was painted.
 *
 * Into the trim data (`trim-sheet.ts`): A is the painted wetness; R occlusion is the generator's own. The paint's
 * layers are not read: a trim mesh's layers 2–4 come from the object's vertex paint, as on any layered surface.
 * Vertices facing up or down have no wall paint and are left dry.
 */
import { PAINT_CHANNELS, PAINT_WETNESS_CHANNEL } from './block-paint';
import { decodeWallPaint, wallPaintAt, type WallPaint } from './block-wall-paint';
import { TRIM_DATA_WETNESS } from './trim-sheet';

/**
 * A generated mesh's trim data bytes (`colors`, RGBA) from a block layer's
 * wall paint (`ArchitecturePaint`: the layer's cell size, the mesh frame's
 * offset into the layer's, the chunks' wall paint): A, the wetness, written
 * for every vertex (0 on faces looking up or down, and where nothing is
 * painted); R (the generator's baked AO) left as it is.
 */
export function paintArchitectureColours(positions: ArrayLike<number>, normals: ArrayLike<number>, colors: Uint8Array, paint: { readonly cellSize: readonly number[]; readonly offset: readonly number[]; readonly chunks: Readonly<Record<string, string>> }): void {
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
    let wet = 0;
    if (Math.abs(ny) < Math.max(Math.abs(nx), Math.abs(nz))) {
      const side = Math.abs(nx) >= Math.abs(nz) ? (nx > 0 ? 0 : 1) : nz > 0 ? 2 : 3;
      const px = positions[i * 3]! + ox;
      const pz = positions[i * 3 + 2]! + oz;
      wallPaintAt(points, paint.cellSize, side, px, positions[i * 3 + 1]! + oy, pz, px, pz, value);
      wet = value[PAINT_WETNESS_CHANNEL]!;
    }
    colors[i * 4 + TRIM_DATA_WETNESS] = Math.round(Math.max(0, Math.min(255, wet)));
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
