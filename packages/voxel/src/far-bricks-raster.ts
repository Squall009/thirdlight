/**
 * Far bricks drawn as cubes instead of ray marched: the same bricks
 * (far-bricks.ts, any build), each sample the centre of a cube one node
 * cell across, solid where its distance is below zero; every cube face open
 * to air is one flat square the draw rasterizes (three-adapter
 * `voxel-far-raster.ts`), so the GPU's depth test does the work a march did.
 *
 * - **Faces.** A face lies between two neighbouring samples of opposite
 *   signs, half a cell from each, facing out of the solid one; it takes the
 *   solid sample's look word and occlusion. Faces only ever lie between
 *   samples on the node's lattice, so two neighbouring faces share their
 *   corners exactly and the surface is closed: no crack inside a node.
 * - **The node's box.** A node keeps every one of its samples (0 to the
 *   edge an axis, the samples on its box faces included, which it shares
 *   with its neighbours), each cube clipped to the box. So a node covers its
 *   box exactly, two neighbours at one level draw their shared samples a half
 *   each and nothing twice, and nodes of different levels, whose boxes tile
 *   space too, leave no gap across the ground between them.
 * - **Skirts.** Where neighbours drawn at different levels put the surface
 *   at different heights, a wall is missing at their shared box face. A
 *   solid sample on a box face within {@link FAR_SKIRT_CELLS} of the surface
 *   puts a face on that box face, facing out: the cube's clipped side, which
 *   only shows where the neighbour's surface lies lower (as a mesh skirt
 *   does). Against a neighbour at the same level it lies inside that
 *   neighbour's solid half cube, hidden.
 *
 * A face is 8 bytes here: its cube's sample (node cells, a byte an axis),
 * its kind (direction, skirt, clipped sides) and its look and occlusion.
 */
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import type { FarBricks } from './far-bricks';
import { FAR_SKIRT_CELLS } from './far-mesh';

/**
 * A face's kind byte ({@link FarRasterFaces.cells}): its direction in the low bits, −x, +x, −y, +y, −z, +z
 * (`axis · 2 + (positive ? 1 : 0)`).
 */
export const FAR_FACE_DIRECTION_MASK = 7;
/** A face's kind byte: a skirt (on the node's box face, not between two samples). */
export const FAR_FACE_SKIRT = 8;
/**
 * A face's kind byte from this bit: the face's sides clipped to the node's box (its cube's sample on the box face), half a
 * cell short: low and high along its first tangent axis, then its second (the axes after its own, in x → y → z order).
 */
export const FAR_FACE_CLIP_SHIFT = 4;

/** A far node's faces to rasterize. */
export interface FarRasterFaces {
  readonly count: number;
  /** Per face: its cube's sample (node cells 0 to the edge, x, y, z) and its kind byte (direction, {@link FAR_FACE_SKIRT}, clipped sides). */
  readonly cells: Uint8Array;
  /**
   * Per face: its look word (material | wetness << 12), its occlusion (0 shut … 255 open) at bit 16, and from
   * {@link FAR_FACE_SHADE_SHIFT} the direction it is shaded as: its own, but a skirt's the surface's it hangs from (the
   * field's steepest axis at its sample), so a skirt facing down under a cliff is lit as the cliff is.
   */
  readonly looks: Uint32Array;
}

/** {@link FarRasterFaces.looks}: where a face's shading direction starts. */
export const FAR_FACE_SHADE_SHIFT = 24;

/**
 * A far node's bricks as faces to rasterize ({@link FarRasterFaces}): every face open to air between two of its
 * samples, and the skirts on its box faces. Only stored bricks hold faces (a brick the surface does not cross has its
 * samples all of one sign, and so do the samples it shares).
 */
export function farRasterFaces(b: FarBricks): FarRasterFaces {
  const C = DISTANCE_BRICK_CELLS;
  const S = DISTANCE_BRICK_SIDE;
  const band = DISTANCE_BRICK_BAND_VOXELS;
  const edge = b.side * C;
  const cells: number[] = [];
  const looks: number[] = [];
  const ao = b.occlusion;
  const p = [0, 0, 0];
  const step = [1, S, S * S];
  // A sample whose look found no cell to show (a sample on the box face the vote reached nothing from) takes a
  // neighbour's in its brick, so no face is drawn in the air material's colour.
  const lookAt = (i: number): number => {
    const w = b.looks[i]!;
    if (w !== 0) return w;
    const r = i % DISTANCE_BRICK_SAMPLES;
    const l = [r % S, Math.floor(r / S) % S, Math.floor(r / (S * S))];
    for (let axis = 0; axis < 3; axis++) for (const s of [-1, 1]) {
      const c = l[axis]! + s;
      if (c < 0 || c >= S) continue;
      const n = b.looks[i + s * step[axis]!]!;
      if (n !== 0) return n;
    }
    return 0;
  };
  // The direction the field rises fastest at a sample (towards air), by differences inside its brick.
  const steepest = (i: number): number => {
    const r = i % DISTANCE_BRICK_SAMPLES;
    const l = [r % S, Math.floor(r / S) % S, Math.floor(r / (S * S))];
    let best = 3;
    let most = 0;
    for (let axis = 0; axis < 3; axis++) {
      const lo = l[axis]! > 0 ? i - step[axis]! : i;
      const hi = l[axis]! < S - 1 ? i + step[axis]! : i;
      const g = b.samples[hi]! - b.samples[lo]!;
      if (Math.abs(g) > most) {
        most = Math.abs(g);
        best = axis * 2 + (g > 0 ? 1 : 0);
      }
    }
    return best;
  };
  // A face of the cube at node sample p, its look the sample's at index `i` of the brick holding both of the pair.
  const emit = (i: number, dir: number, skirt: boolean): void => {
    const axis = dir >> 1;
    let clip = 0;
    for (let t = 0; t < 2; t++) {
      const c = p[(axis + 1 + t) % 3]!;
      if (c === 0) clip |= 1 << (2 * t);
      if (c === edge) clip |= 2 << (2 * t);
    }
    cells.push(p[0]!, p[1]!, p[2]!, dir | (skirt ? FAR_FACE_SKIRT : 0) | (clip << FAR_FACE_CLIP_SHIFT));
    looks.push((lookAt(i) | ((ao === undefined ? 255 : ao[i]!) << 16) | ((skirt ? steepest(i) : dir) << FAR_FACE_SHADE_SHIFT)) >>> 0);
  };
  for (let bz = 0; bz < b.side; bz++) for (let by = 0; by < b.side; by++) for (let bx = 0; bx < b.side; bx++) {
    const k = b.bricks[(bz * b.side + by) * b.side + bx]!;
    if (k < 0) continue;
    const o = [bx * C, by * C, bz * C];
    const base = k * DISTANCE_BRICK_SAMPLES;
    // The samples this brick owns: its own 8 an axis, and the 9th where it is the node's last brick on that axis.
    const n = [bx === b.side - 1 ? S : C, by === b.side - 1 ? S : C, bz === b.side - 1 ? S : C];
    for (let lz = 0; lz < n[2]!; lz++) for (let ly = 0; ly < n[1]!; ly++) for (let lx = 0; lx < n[0]!; lx++) {
      const l = [lx, ly, lz];
      const i = base + (lz * S + ly) * S + lx;
      const d = distanceOfSample(b.samples[i]!, band);
      for (let axis = 0; axis < 3; axis++) {
        const c = o[axis]! + l[axis]!;
        // The pair with the next sample along the axis (both in this brick: a sample short of the node's far face is
        // short of its brick's ninth row), its face half way, on the solid one's cube.
        if (c < edge) {
          const i1 = i + step[axis]!;
          const d1 = distanceOfSample(b.samples[i1]!, band);
          if ((d < 0) !== (d1 < 0)) {
            const solid = d < 0 ? i : i1;
            p[0] = o[0]! + lx;
            p[1] = o[1]! + ly;
            p[2] = o[2]! + lz;
            if (solid === i1) p[axis] = p[axis]! + 1;
            emit(solid, axis * 2 + (d < 0 ? 1 : 0), false);
          }
        }
        // A skirt: a solid sample near the surface on the box face, its clipped side facing out.
        if (d < 0 && d > -FAR_SKIRT_CELLS && (c === 0 || c === edge)) {
          p[0] = o[0]! + lx;
          p[1] = o[1]! + ly;
          p[2] = o[2]! + lz;
          emit(i, axis * 2 + (c === edge ? 1 : 0), true);
        }
      }
    }
  }
  return { count: looks.length, cells: Uint8Array.from(cells), looks: Uint32Array.from(looks) };
}

/** Bytes a node's faces hold here (the page's copy). */
export function farRasterFacesBytes(f: FarRasterFaces): number {
  return f.cells.byteLength + f.looks.byteLength;
}

/**
 * How many instances the faces would be as runs: faces of one direction and kind, one look and one occlusion, next to
 * each other along their first tangent axis, merged into one (a measurement of what merging would save; the draw does
 * not merge: a long face's edge beside two short ones' shared corner is a T-junction, which rasterizes with cracks).
 */
export function farRasterRuns(f: FarRasterFaces): number {
  const key = (i: number): string => `${f.cells[i * 4]},${f.cells[i * 4 + 1]},${f.cells[i * 4 + 2]},${f.cells[i * 4 + 3]}`;
  const index = new Map<string, number>();
  for (let i = 0; i < f.count; i++) index.set(key(i), i);
  let runs = 0;
  for (let i = 0; i < f.count; i++) {
    const kind = f.cells[i * 4 + 3]!;
    const t = (((kind & FAR_FACE_DIRECTION_MASK) >> 1) + 1) % 3;
    if (kind >> FAR_FACE_CLIP_SHIFT !== 0) {
      runs++;
      continue;
    }
    const prev = [f.cells[i * 4]!, f.cells[i * 4 + 1]!, f.cells[i * 4 + 2]!];
    prev[t] = prev[t]! - 1;
    const j = index.get(`${prev[0]},${prev[1]},${prev[2]},${kind}`);
    if (j === undefined || f.looks[j] !== f.looks[i]) runs++;
  }
  return runs;
}
