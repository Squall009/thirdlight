/**
 * The liquid part: a derive unit's liquid faces against open space, merged
 * into quads, each with its liquid's material. What the page draws as plain
 * water near the eye; derived like every other part, never stored.
 *
 * Every other derived output reads a liquid cell as the air it stands in
 * (the mesh, collision, navigation, light, occupancy, regions and shader
 * data alike), so a cell changing only between air and liquid, or a
 * liquid's fill level or material, makes this part stale and nothing else
 * (record.ts `changeFeeds`).
 *
 * **Faces.** A liquid cell of fill level h (its shape, 1 … 15 of a cell)
 * has, toward each neighbour:
 * - **open** (air, an opening, ground filled below the surface): its whole
 *   face, from the cell's floor to h on a side, its top at h (at the cell's
 *   top when full), its bottom at the floor;
 * - **liquid**: on a side, the step where the neighbour's fill is lower (from
 *   the neighbour's h to its own), nothing where it is as high or higher;
 *   above or below, nothing;
 * - **solid** (ground filled to the surface, any built role): nothing.
 * A partly filled cell always shows its top at h. A liquid cell of fill 0
 * holds nothing and counts as open. Positions are exact: x and z on cell
 * faces, y on cell faces and fill levels, in {@link LIQUID_STEPS_PER_CELL}
 * steps a cell. A neighbour across the unit's face is read from the
 * neighbourhood's pad, so no face is made against liquid across a border
 * and the faces of two units meet without a gap or a doubled face.
 *
 * **Merging.** Tops and bottoms merge into rectangles of one height and
 * one material within a cell layer; sides first merge up a column (a
 * face reaching its cell's top meets the face above it starting at that
 * cell's floor), then along the face's row where the next column's run has
 * the same span and material. A quad never crosses the unit's border (a
 * derive section, inside one storage chunk).
 *
 * **Bytes** ({@link LIQUID_QUAD_BYTES} a quad, little-endian): x0, y0, z0,
 * x1, y1, z1 (u16, steps from the unit's corner: the quad's box, flat along
 * its face's axis), material (u16), the face ({@link LIQUID_FACE}, u8), a
 * reserved byte 0. A unit with no liquid face has no part (null): nothing is
 * kept for it, and a unit with no liquid cell costs one look at its cells.
 */
import type { Neighbourhood } from './assembly';
import { SURFACE_ISO } from './derived-mesh';
import { MATERIAL_ID_MAX, ROLE_MASK, ROLE_SHIFT, SHAPE_FULL, SHAPE_SHIFT, VOXEL_ROLE } from './record';

/** Steps a cell along each axis in the liquid part's positions: a fill level is a whole step. */
export const LIQUID_STEPS_PER_CELL = SHAPE_FULL;

/** Cells round a unit the liquid part reads (its faces look at the six neighbours): the apron of a liquid-only derive. */
export const LIQUID_REACH_CELLS = 1;

/** Bytes of one quad. */
export const LIQUID_QUAD_BYTES = 16;

/** A quad's face: the direction its outward normal points. */
export const LIQUID_FACE = Object.freeze({ px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 });

/** Outward normals by {@link LIQUID_FACE}. */
export const LIQUID_FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = Object.freeze([
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]);

/** A unit's (or a joined chunk's) liquid quads. */
export interface LiquidPart {
  readonly count: number;
  /** {@link LIQUID_QUAD_BYTES} a quad. */
  readonly quads: Uint8Array;
}

/** A neighbour as the liquid part sees it: open, solid, or liquid of its fill. */
const OPEN = -1;
const SOLID = -2;

/** Fill (1 … 15) of a liquid value, {@link OPEN} or {@link SOLID} for anything else. */
function kindOf(v: number, density: number): number {
  const material = v & MATERIAL_ID_MAX;
  if (material === 0) return OPEN;
  const role = (v >>> ROLE_SHIFT) & ROLE_MASK;
  if (role === VOXEL_ROLE.liquid) {
    const h = (v >>> SHAPE_SHIFT) & SHAPE_FULL;
    return h === 0 ? OPEN : h;
  }
  if (role === VOXEL_ROLE.air || role === VOXEL_ROLE.opening) return OPEN;
  if (role === VOXEL_ROLE.terrain) return density >= SURFACE_ISO ? SOLID : OPEN;
  // Every built role, of any form or integrity: the liquid part reads the value alone (no rule evaluation), so a
  // rail or a post stands as a wall would.
  return SOLID;
}

/** Whether any of a neighbourhood's own cells (not its pad) is liquid. */
function holdsLiquid(n: Neighbourhood): boolean {
  const { edge: e, pad: p, side: s, values } = n;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const row = ((x + p) * s + (z + p)) * s + p;
    for (let y = 0; y < e; y++) {
      const v = values[row + y]!;
      if (((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.liquid && (v & MATERIAL_ID_MAX) !== 0) return true;
    }
  }
  return false;
}

/** Grows a quad list as quads are added. */
class QuadWriter {
  bytes = new Uint8Array(LIQUID_QUAD_BYTES * 64);
  view = new DataView(this.bytes.buffer);
  count = 0;

  add(face: number, material: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const at = this.count * LIQUID_QUAD_BYTES;
    if (at + LIQUID_QUAD_BYTES > this.bytes.length) {
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
    this.count++;
  }

  part(): LiquidPart {
    return { count: this.count, quads: this.bytes.slice(0, this.count * LIQUID_QUAD_BYTES) };
  }
}

/** One run of a side face up a column: from `lo` to `hi` (steps from the unit's floor), one material. */
interface Run {
  lo: number;
  hi: number;
  material: number;
  used: boolean;
}

/**
 * The liquid part of a neighbourhood's own cells (its pad at least
 * {@link LIQUID_REACH_CELLS} deep), or null when they show no liquid face
 * (no liquid, or liquid closed in on every side).
 */
export function liquidOfNeighbourhood(n: Neighbourhood): LiquidPart | null {
  if (n.pad < LIQUID_REACH_CELLS) throw new RangeError(`liquid part: a pad of ${n.pad} does not reach the ${LIQUID_REACH_CELLS}-cell neighbours`);
  if (!holdsLiquid(n)) return null;
  const { edge: e, pad: p, side: s, values, shapes } = n;
  const S = LIQUID_STEPS_PER_CELL;
  // Every cell of the unit and one round it: its kind (fill, open or solid).
  const ks = e + 2;
  const kinds = new Int8Array(ks * ks * ks);
  const mats = new Uint16Array(e * e * e);
  // Columns of the unit holding liquid: the only ones whose faces are looked for.
  const wet = new Uint8Array(e * e);
  for (let x = -1; x <= e; x++) for (let z = -1; z <= e; z++) {
    const src = ((x + p) * s + (z + p)) * s + (p - 1);
    const dst = ((x + 1) * ks + (z + 1)) * ks;
    const inside = x >= 0 && x < e && z >= 0 && z < e;
    for (let y = -1; y <= e; y++) {
      const v = values[src + y + 1]!;
      const k = kindOf(v, shapes[src + y + 1]!);
      kinds[dst + y + 1] = k;
      if (k > 0 && inside && y >= 0 && y < e) {
        mats[(x * e + z) * e + y] = v & MATERIAL_ID_MAX;
        wet[x * e + z] = 1;
      }
    }
  }
  // A unit cell's index in `kinds`, and the steps to its neighbours there.
  const at = (x: number, z: number): number => ((x + 1) * ks + (z + 1)) * ks + 1;
  const out = new QuadWriter();

  // Tops and bottoms: per cell layer, a key a column (fill << 12 | material; −1 none), merged into rectangles.
  const key = new Int32Array(e * e);
  const used = new Uint8Array(e * e);
  for (const face of [LIQUID_FACE.py, LIQUID_FACE.ny]) {
    for (let y = 0; y < e; y++) {
      let any = false;
      for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
        const i = at(x, z) + y;
        const h = wet[x * e + z] === 1 ? kinds[i]! : 0;
        let k = -1;
        if (h > 0) {
          if (face === LIQUID_FACE.py) {
            if (h < S) k = h;
            else if (kinds[i + 1] === OPEN) k = S;
          } else if (kinds[i - 1] === OPEN) k = 0;
        }
        key[x * e + z] = k < 0 ? -1 : (k << 12) | mats[(x * e + z) * e + y]!;
        any ||= k >= 0;
      }
      if (!any) continue;
      used.fill(0);
      for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
        const k = key[x * e + z]!;
        if (k < 0 || used[x * e + z] === 1) continue;
        let dz = 1;
        while (z + dz < e && key[x * e + z + dz] === k && used[x * e + z + dz] === 0) dz++;
        let dx = 1;
        grow: while (x + dx < e) {
          for (let j = 0; j < dz; j++) if (key[(x + dx) * e + z + j] !== k || used[(x + dx) * e + z + j] === 1) break grow;
          dx++;
        }
        for (let a = 0; a < dx; a++) for (let j = 0; j < dz; j++) used[(x + a) * e + z + j] = 1;
        const yy = y * S + (k >>> 12);
        out.add(face, k & 0xfff, x * S, yy, z * S, (x + dx) * S, yy, (z + dz) * S);
      }
    }
  }

  // Sides: per face direction and layer across it, runs up each column, merged along the row.
  const sides: ReadonlyArray<readonly [number, number, number]> = [
    [LIQUID_FACE.px, 1, 0],
    [LIQUID_FACE.nx, -1, 0],
    [LIQUID_FACE.pz, 0, 1],
    [LIQUID_FACE.nz, 0, -1],
  ];
  const columns: Run[][] = Array.from({ length: e }, () => []);
  for (const [face, dx, dz] of sides) {
    for (let a = 0; a < e; a++) {
      // `a` is the layer across the face (x for ±x, z for ±z); `b` runs along it.
      let any = false;
      for (let b = 0; b < e; b++) {
        const col = columns[b]!;
        col.length = 0;
        const x = dx !== 0 ? a : b;
        const z = dx !== 0 ? b : a;
        if (wet[x * e + z] === 0) continue;
        const base = at(x, z);
        const step = (dx * ks + dz) * ks;
        let run: Run | null = null;
        for (let y = 0; y < e; y++) {
          const h = kinds[base + y]!;
          let lo = -1;
          if (h > 0) {
            const nb = kinds[base + step + y]!;
            if (nb === OPEN) lo = 0;
            else if (nb > 0 && nb < h) lo = nb;
          }
          if (lo < 0) {
            run = null;
            continue;
          }
          const m = mats[(x * e + z) * e + y]!;
          if (run !== null && run.hi === y * S && lo === 0 && run.material === m) run.hi = y * S + h;
          else {
            run = { lo: y * S + lo, hi: y * S + h, material: m, used: false };
            col.push(run);
          }
          // A run reaching above a cell's top ends there (the next starts at its floor only when it is the same face).
          if (h < S) run = null;
        }
        any ||= col.length > 0;
      }
      if (!any) continue;
      const plane = (dx > 0 || dz > 0 ? a + 1 : a) * S;
      for (let b = 0; b < e; b++) {
        for (const r of columns[b]!) {
          if (r.used) continue;
          r.used = true;
          let len = 1;
          while (b + len < e) {
            const next = columns[b + len]!.find((q) => !q.used && q.lo === r.lo && q.hi === r.hi && q.material === r.material);
            if (next === undefined) break;
            next.used = true;
            len++;
          }
          if (dx !== 0) out.add(face, r.material, plane, r.lo, b * S, plane, r.hi, (b + len) * S);
          else out.add(face, r.material, b * S, r.lo, plane, (b + len) * S, r.hi, plane);
        }
      }
    }
  }
  return out.count === 0 ? null : out.part();
}

/** Bytes a liquid part holds. */
export function liquidBytes(l: LiquidPart | null | undefined): number {
  return l == null ? 0 : l.quads.byteLength;
}

/** One quad's fields (tests, the renderer's unpack). */
export function liquidQuad(l: LiquidPart, k: number): { face: number; material: number; min: [number, number, number]; max: [number, number, number] } {
  const v = new DataView(l.quads.buffer, l.quads.byteOffset + k * LIQUID_QUAD_BYTES, LIQUID_QUAD_BYTES);
  return { face: v.getUint8(14), material: v.getUint16(12, true), min: [v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)], max: [v.getUint16(6, true), v.getUint16(8, true), v.getUint16(10, true)] };
}

/**
 * The liquid parts of a chunk's sections (by section id; null: none) as one
 * part of the chunk, positions moved from each section's corner to the
 * chunk's (`origin(id)`, cells); null when no section has a quad.
 */
export function joinLiquid(parts: ReadonlyArray<LiquidPart | null | undefined>, origin: (id: number) => readonly [number, number, number]): LiquidPart | null {
  let count = 0;
  for (const l of parts) count += l?.count ?? 0;
  if (count === 0) return null;
  const quads = new Uint8Array(count * LIQUID_QUAD_BYTES);
  const view = new DataView(quads.buffer);
  const S = LIQUID_STEPS_PER_CELL;
  let at = 0;
  parts.forEach((l, id) => {
    if (l == null || l.count === 0) return;
    quads.set(l.quads.subarray(0, l.count * LIQUID_QUAD_BYTES), at);
    const [ox, oy, oz] = origin(id);
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      for (let k = 0; k < l.count; k++, at += LIQUID_QUAD_BYTES) {
        for (const [off, d] of [[0, ox], [2, oy], [4, oz], [6, ox], [8, oy], [10, oz]] as const) view.setUint16(at + off, view.getUint16(at + off, true) + d * S, true);
      }
    } else at += l.count * LIQUID_QUAD_BYTES;
  });
  return { count, quads };
}
