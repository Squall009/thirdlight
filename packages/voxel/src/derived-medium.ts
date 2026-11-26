/**
 * What the media's parts share (the liquid part, derived-liquid.ts; the gas
 * part, derived-gas.ts): a medium's faces toward its neighbours as
 * axis-aligned quads with their material, the merge of equal faces of a
 * layer into rectangles, the quads' bytes and the join of a chunk's
 * sections' quads into one list.
 *
 * **Bytes** ({@link MEDIUM_QUAD_BYTES} a quad, little-endian): x0, y0, z0,
 * x1, y1, z1 (u16, steps from the unit's corner: the quad's box, flat along
 * its face's axis), material (u16), the face ({@link MEDIUM_FACE}, u8) and
 * one byte the part gives its own meaning (the liquid part: 0).
 */
import { SURFACE_ISO } from './derived-mesh';
import { isBodyRole, isFillRole } from './role-traits';

/** Bytes of one quad. */
export const MEDIUM_QUAD_BYTES = 16;

/** A quad's face: the direction its outward normal points. */
export const MEDIUM_FACE = Object.freeze({ px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 });

/** Outward normals by {@link MEDIUM_FACE}. */
export const MEDIUM_FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = Object.freeze([
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]);

/** A list of quads. */
export interface MediumQuads {
  readonly count: number;
  /** {@link MEDIUM_QUAD_BYTES} a quad. */
  readonly quads: Uint8Array;
}

/**
 * Whether a cell that is no medium closes a medium's face: ground filled to
 * the surface and every built role, of any form or integrity (the media's
 * parts read the value alone, no rule evaluation, so a rail or a post stands
 * as a wall would). Air, an opening and ground filled below the surface are
 * open.
 */
export function closesMedium(role: number, density: number): boolean {
  if (!isBodyRole(role)) return false;
  return isFillRole(role) ? density >= SURFACE_ISO : true;
}

/** Grows a quad list as quads are added. */
export class MediumQuadWriter {
  private bytes = new Uint8Array(MEDIUM_QUAD_BYTES * 64);
  private view = new DataView(this.bytes.buffer);
  count = 0;

  add(face: number, material: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, extra = 0): void {
    const at = this.count * MEDIUM_QUAD_BYTES;
    if (at + MEDIUM_QUAD_BYTES > this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    const w = this.view;
    w.setUint16(at, x0, true);
    w.setUint16(at + 2, y0, true);
    w.setUint16(at + 4, z0, true);
    w.setUint16(at + 6, x1, true);
    w.setUint16(at + 8, y1, true);
    w.setUint16(at + 10, z1, true);
    w.setUint16(at + 12, material, true);
    w.setUint8(at + 14, face);
    w.setUint8(at + 15, extra);
    this.count++;
  }

  /** The quads added, in bytes of their own. */
  quads(): Uint8Array {
    return this.bytes.slice(0, this.count * MEDIUM_QUAD_BYTES);
  }
}

/**
 * Merges a layer's equal faces into rectangles: `key` holds a value a cell
 * of an `na` × `nb` layer (index a · nb + b; negative: no face), `used` is
 * scratch of the same size (cleared here). Each rectangle of one key, grown
 * along b first and then along a, is given once as [a0, a1) × [b0, b1).
 */
export function mergeLayerRects(na: number, nb: number, key: Int32Array, used: Uint8Array, emit: (a0: number, b0: number, a1: number, b1: number, key: number) => void): void {
  used.fill(0, 0, na * nb);
  for (let a = 0; a < na; a++) for (let b = 0; b < nb; b++) {
    const k = key[a * nb + b]!;
    if (k < 0 || used[a * nb + b] === 1) continue;
    let db = 1;
    while (b + db < nb && key[a * nb + b + db] === k && used[a * nb + b + db] === 0) db++;
    let da = 1;
    grow: while (a + da < na) {
      for (let j = 0; j < db; j++) if (key[(a + da) * nb + b + j] !== k || used[(a + da) * nb + b + j] === 1) break grow;
      da++;
    }
    for (let i = 0; i < da; i++) for (let j = 0; j < db; j++) used[(a + i) * nb + b + j] = 1;
    emit(a, b, a + da, b + db, k);
  }
}

/** One quad's fields (tests, the renderer's unpack). */
export function mediumQuad(l: MediumQuads, k: number): { face: number; material: number; extra: number; min: [number, number, number]; max: [number, number, number] } {
  const v = new DataView(l.quads.buffer, l.quads.byteOffset + k * MEDIUM_QUAD_BYTES, MEDIUM_QUAD_BYTES);
  return { face: v.getUint8(14), material: v.getUint16(12, true), extra: v.getUint8(15), min: [v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)], max: [v.getUint16(6, true), v.getUint16(8, true), v.getUint16(10, true)] };
}

/**
 * The quads of a chunk's sections (by section id; null: none) as one list
 * of the chunk, positions moved from each section's corner to the chunk's
 * (`origin(id)`, cells; `steps` position steps a cell); null when no
 * section has a quad.
 */
export function joinMediumQuads(parts: ReadonlyArray<MediumQuads | null | undefined>, origin: (id: number) => readonly [number, number, number], steps: number): MediumQuads | null {
  let count = 0;
  for (const l of parts) count += l?.count ?? 0;
  if (count === 0) return null;
  const quads = new Uint8Array(count * MEDIUM_QUAD_BYTES);
  const view = new DataView(quads.buffer);
  let at = 0;
  parts.forEach((l, id) => {
    if (l == null || l.count === 0) return;
    quads.set(l.quads.subarray(0, l.count * MEDIUM_QUAD_BYTES), at);
    const [ox, oy, oz] = origin(id);
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      for (let k = 0; k < l.count; k++, at += MEDIUM_QUAD_BYTES) {
        for (const [off, d] of [[0, ox], [2, oy], [4, oz], [6, ox], [8, oy], [10, oz]] as const) view.setUint16(at + off, view.getUint16(at + off, true) + d * steps, true);
      }
    } else at += l.count * MEDIUM_QUAD_BYTES;
  });
  return { count, quads };
}
