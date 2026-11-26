/**
 * Open regions of one derive unit (a level-0 section or chunk): its open
 * cells labelled into connected components, which of its faces they reach,
 * which faces join through open space, and the highest solid cell of each
 * column. Derived beside the other consumers' outputs in the derive job,
 * never stored; the streamer stitches the units' components across their
 * faces into the world's regions (open-region-stitch.ts).
 *
 * - **Open** is the complement of the derived occupancy: a cell is open
 *   when it is not drawn as a body (the occupancy walk's `solid` stop, the
 *   one a pick or a body stops at). Air, liquid, openings, and the thin
 *   forms (a rail's panel, a post, a beam's bar) are open; a wall of any
 *   integrity and ground filled to its surface are not. So a region is the
 *   space a body could move through or a ray could pass, cell for cell.
 * - **Portals.** Cells of the `opening` role (the gap a door or window
 *   fills) are open but are labelled apart: an opening's cells form portal
 *   components, and the regions either side of a doorway are separate
 *   regions joined by the portal (`links`). A dug or broken hole is air,
 *   not an opening, and joins what it opens onto.
 * - **6-connected.** Cells join only across a shared face; an edge or a
 *   corner contact does not connect (the walk's rule: no diagonal slip).
 * - **Radius 0.** The part reads only the unit's own cells (their resolved
 *   occupancy and their roles), so it needs nothing past the job's apron.
 */
import type { Neighbourhood } from './assembly';
import { OCCUPANCY, type OccupancyOut } from './derived-data';
import { valueRole } from './record';
import { isPortalRole } from './role-traits';
import { STAMP_CLASS } from './structure-stamp';

/** Face bits of a unit: −x, +x, −y, +y, −z, +z. */
export const REGION_FACE = Object.freeze({ nx: 1, px: 2, ny: 4, py: 8, nz: 16, pz: 32 });

/** Every face. */
export const ALL_REGION_FACES = 63;

/** A component's flag: its cells are an opening's (a portal), not a region's. */
export const REGION_PORTAL = 0x80;

/** Bit of the face pair (a, b) (face indices 0–5, a ≠ b) in {@link OpenRegionsOut.connect}: 15 pairs. */
export function facePairBit(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi || lo < 0 || hi > 5) throw new RangeError(`face pair ${a}, ${b}`);
  // Pairs in order (0,1) (0,2) … (0,5) (1,2) … (4,5).
  return 1 << ((lo * (11 - lo)) / 2 + hi - lo - 1);
}

/** Every face pair joined. */
export const ALL_FACE_PAIRS = (1 << 15) - 1;

/**
 * A unit's open regions. Labels index the unit's cells as the other parts
 * do (local index (x · E + z) · E + y); label 0 is a solid cell, labels
 * 1 … count are components, label L's facts at index L − 1.
 */
export interface OpenRegionsOut {
  readonly edge: number;
  /** Components (regions and portals). */
  readonly count: number;
  /**
   * The label of every cell; null when the unit is uniform: every cell
   * solid (`count` 0) or every cell open in one region (`count` 1).
   */
  readonly labels: Uint8Array | Uint16Array | null;
  /** Cells of each component. */
  readonly volume: Uint16Array;
  /** Each component's faces reached ({@link REGION_FACE} bits) | {@link REGION_PORTAL} for a portal. */
  readonly flags: Uint8Array;
  /** Pairs (region label, portal label) whose cells share a face inside the unit, each pair once, in label order. */
  readonly links: Uint16Array;
  /** R97: the face pairs ({@link facePairBit}) joined through open cells (regions and the portals between them). */
  readonly connect: number;
  /**
   * R98: per column (x · E + z) the highest solid cell + 1 (0: no solid
   * cell in the column); null when every column is `skyUniform`.
   */
  readonly sky: Uint8Array | null;
  readonly skyUniform: number;
}

/** The regions of a unit with no solid cell and no opening: one region reaching every face. */
export function airRegions(edge: number): OpenRegionsOut {
  return { edge, count: 1, labels: null, volume: Uint16Array.of(edge ** 3), flags: Uint8Array.of(ALL_REGION_FACES), links: new Uint16Array(0), connect: ALL_FACE_PAIRS, sky: null, skyUniform: 0 };
}

/** The regions of a unit every cell of which is solid. */
export function solidRegions(edge: number): OpenRegionsOut {
  return { edge, count: 0, labels: null, volume: new Uint16Array(0), flags: new Uint8Array(0), links: new Uint16Array(0), connect: 0, sky: null, skyUniform: edge };
}

/** The label of cell `i` of a unit's regions. */
export function regionLabelAt(r: OpenRegionsOut, i: number): number {
  return r.labels === null ? r.count : r.labels[i]!;
}

/** Highest solid cell + 1 of column (x · E + z). */
export function regionSkyAt(r: OpenRegionsOut, column: number): number {
  return r.sky === null ? r.skyUniform : r.sky[column]!;
}

/** Bytes a unit's regions hold. */
export function openRegionsBytes(r: OpenRegionsOut): number {
  return (r.labels?.byteLength ?? 0) + r.volume.byteLength + r.flags.byteLength + r.links.byteLength + (r.sky?.byteLength ?? 0);
}

/** A unit's regions' arrays, in a fixed order (canonical bytes, transfer lists). */
export function openRegionsArrays(r: OpenRegionsOut): ArrayBufferView[] {
  const out: ArrayBufferView[] = [];
  if (r.labels !== null) out.push(r.labels);
  out.push(r.volume, r.flags, r.links);
  if (r.sky !== null) out.push(r.sky);
  return out;
}

/** Per thread, by cell count: the label and stack scratch of the labelling running. */
const labelScratches = new Map<number, { labels: Uint16Array; stack: Int32Array }>();

function scratchOf(cells: number): { labels: Uint16Array; stack: Int32Array } {
  let s = labelScratches.get(cells);
  if (s === undefined) labelScratches.set(cells, (s = { labels: new Uint16Array(cells), stack: new Int32Array(cells) }));
  return s;
}

/**
 * The open regions of a derived unit, from its occupancy (what is solid)
 * and its neighbourhood's roles (which open cells are openings).
 */
export function openRegionsOf(n: Neighbourhood, occ: OccupancyOut): OpenRegionsOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const cells = e * e * e;
  const solid = (i: number): boolean => occ.flag === OCCUPANCY.solid || (occ.flag === OCCUPANCY.mixed && ((occ.mask![i >>> 5]! >>> (i & 31)) & 1) === 1);
  // Openings (only open cells can be: an opening's form is none).
  let openings: Uint8Array | null = null;
  if (occ.flag !== OCCUPANCY.solid) {
    for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
      const row = ((x + p) * s + (z + p)) * s + p;
      for (let y = 0; y < e; y++) {
        if (!isPortalRole(valueRole(n.values[row + y]!))) continue;
        openings ??= new Uint8Array(cells);
        openings[(x * e + z) * e + y] = 1;
      }
    }
  }
  if (occ.flag === OCCUPANCY.solid) return solidRegions(e);
  if (occ.flag === OCCUPANCY.empty && openings === null) return airRegions(e);
  return labelRegions(e, occ.flag, solid, openings);
}

/**
 * A unit's regions from its cells' kinds: `flag` the {@link OCCUPANCY} of its solid cells as a whole, `solid` a cell's,
 * `openings` its open cells that are openings (1; null: none). The labelling every unit's regions are made by.
 */
function labelRegions(e: number, flag: number, solid: (i: number) => boolean, openings: Uint8Array | null): OpenRegionsOut {
  const cells = e * e * e;
  const { labels, stack } = scratchOf(cells);
  labels.fill(0);
  const volume: number[] = [];
  const flags: number[] = [];
  const e2 = e * e;
  let count = 0;
  for (let start = 0; start < cells; start++) {
    if (labels[start] !== 0 || solid(start)) continue;
    const portal = openings !== null && openings[start] === 1;
    const label = ++count;
    labels[start] = label;
    let top = 0;
    stack[top++] = start;
    let cellsIn = 0;
    let faces = 0;
    while (top > 0) {
      const i = stack[--top]!;
      cellsIn++;
      const x = (i / e2) | 0;
      const z = ((i / e) | 0) % e;
      const y = i % e;
      if (x === 0) faces |= REGION_FACE.nx;
      if (x === e - 1) faces |= REGION_FACE.px;
      if (y === 0) faces |= REGION_FACE.ny;
      if (y === e - 1) faces |= REGION_FACE.py;
      if (z === 0) faces |= REGION_FACE.nz;
      if (z === e - 1) faces |= REGION_FACE.pz;
      const visit = (j: number): void => {
        if (labels[j] !== 0 || solid(j) || (openings !== null && openings[j] === 1) !== portal) return;
        labels[j] = label;
        stack[top++] = j;
      };
      if (x > 0) visit(i - e2);
      if (x < e - 1) visit(i + e2);
      if (z > 0) visit(i - e);
      if (z < e - 1) visit(i + e);
      if (y > 0) visit(i - 1);
      if (y < e - 1) visit(i + 1);
    }
    volume.push(cellsIn);
    flags.push(faces | (portal ? REGION_PORTAL : 0));
  }
  // Region–portal contacts: the only contacts between different labels (two regions or two portals that touch are one).
  const pairs = new Set<number>();
  const contact = (a: number, b: number): void => {
    if (a === 0 || b === 0 || a === b) return;
    const ap = (flags[a - 1]! & REGION_PORTAL) !== 0;
    pairs.add(ap ? b * 0x10000 + a : a * 0x10000 + b);
  };
  if (openings !== null) {
    for (let i = 0; i < cells; i++) {
      const a = labels[i]!;
      if (a === 0) continue;
      const x = (i / e2) | 0;
      const z = ((i / e) | 0) % e;
      const y = i % e;
      if (x < e - 1) contact(a, labels[i + e2]!);
      if (z < e - 1) contact(a, labels[i + e]!);
      if (y < e - 1) contact(a, labels[i + 1]!);
    }
  }
  const links = Uint16Array.from([...pairs].sort((a, b) => a - b).flatMap((k) => [Math.floor(k / 0x10000), k % 0x10000]));
  // R97: components joined through their portal contacts, and the faces each group reaches.
  const group = Array.from({ length: count + 1 }, (_, i) => i);
  const find = (a: number): number => {
    while (group[a] !== a) a = group[a] = group[group[a]!]!;
    return a;
  };
  for (let k = 0; k < links.length; k += 2) group[find(links[k]!)] = find(links[k + 1]!);
  const groupFaces = new Map<number, number>();
  for (let l = 1; l <= count; l++) groupFaces.set(find(l), (groupFaces.get(find(l)) ?? 0) | (flags[l - 1]! & ALL_REGION_FACES));
  let connect = 0;
  for (const f of groupFaces.values()) {
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) if (f & (1 << a) && f & (1 << b)) connect |= facePairBit(a, b);
  }
  // R98: the highest solid cell of each column.
  const sky = new Uint8Array(e2);
  let skyFirst = -1;
  let skyUniform = true;
  for (let c = 0; c < e2; c++) {
    let h = 0;
    if (flag === OCCUPANCY.mixed) {
      for (let y = e - 1; y >= 0; y--) {
        if (solid(c * e + y)) {
          h = y + 1;
          break;
        }
      }
    }
    sky[c] = h;
    if (skyFirst < 0) skyFirst = h;
    else if (h !== skyFirst) skyUniform = false;
  }
  const out = count <= 0xff ? Uint8Array.from(labels) : labels.slice();
  return { edge: e, count, labels: out, volume: Uint16Array.from(volume, (v) => Math.min(v, 0xffff)), flags: Uint8Array.from(flags), links, connect, sky: skyUniform ? null : sky, skyUniform: skyUniform ? skyFirst : 0 };
}

/**
 * A unit's regions with a structure stamped over it (structure-stamp.ts): `classes` the stamp's classes of the storage
 * chunk holding the unit (local index `((x << csh) | z) << csh | y`), the unit's cells at `(ox, oy, oz)` in it. A
 * stamped stopping cell is solid; a stamped opening is a portal cell where the unit's own cell is open; the rest is the
 * unit's own. `base` itself where no stamped cell falls in the unit.
 */
export function stampedRegions(base: OpenRegionsOut, classes: Uint8Array, ox: number, oy: number, oz: number, csh: number): OpenRegionsOut {
  const e = base.edge;
  let any = false;
  for (let x = 0; x < e && !any; x++) for (let z = 0; z < e && !any; z++) {
    const row = (((ox + x) << csh) | (oz + z)) << csh;
    for (let y = 0; y < e; y++) if (classes[row | (oy + y)] !== 0) {
      any = true;
      break;
    }
  }
  if (!any) return base;
  const cells = e * e * e;
  const solidAt = new Uint8Array(cells);
  let openings: Uint8Array | null = null;
  let solids = 0;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const row = (((ox + x) << csh) | (oz + z)) << csh;
    for (let y = 0; y < e; y++) {
      const i = (x * e + z) * e + y;
      const l = regionLabelAt(base, i);
      const c = classes[row | (oy + y)]!;
      if (l === 0 || c === STAMP_CLASS.stop) {
        solidAt[i] = 1;
        solids++;
      } else if (c === STAMP_CLASS.opening || (base.flags[l - 1]! & REGION_PORTAL) !== 0) (openings ??= new Uint8Array(cells))[i] = 1;
    }
  }
  if (solids === cells) return solidRegions(e);
  if (solids === 0 && openings === null) return airRegions(e);
  return labelRegions(e, solids === 0 ? OCCUPANCY.empty : OCCUPANCY.mixed, (i) => solidAt[i] === 1, openings);
}
