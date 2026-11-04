/**
 * Run sections: where a cell sits in a run of its case, so a kit draws long
 * features (beams, banisters, soffits, mouldings, running boards, skirts,
 * copings, edges) from a few merge-compatible sections — body, start and end
 * terminations, corner, junction — instead of hand-made run lengths.
 *
 * **What a run is.** Every case names the axis its run follows in its own
 * orientation (`CaseDef.run`); the cell's case transform places that axis on
 * the world (x or z for a horizontal run, y for a vertical one). Two
 * neighbouring cells join when their cases belong to one run group (the
 * same inferred feature, else the same case) and the step between them lies
 * along the run axis of at least one of them: two parallel beams side by
 * side never join, a rail meeting another rail's side does (a T).
 *
 * **Section.** From the joins along the cell's own axis (0–2) and across it
 * (0–2, horizontal runs only): none → single; one along → start or end (the
 * free end at the piece's own −x is a start, at its own +x an end); two along
 * → body; one along and one across → corner; three or four, or joins only
 * across (another run's end meeting its side), → junction. A cell keeps its
 * own axis even when joined only across it: its piece is drawn, its
 * collision box placed and its U read along its case's axis, so a section
 * along another axis would draw an end cap sideways and a U out of step.
 *
 * **Ends.** Each end along the axis is joined, open (an exposed termination:
 * nothing beyond it), butt (it stops against a solid cell), or inner: the run
 * turns an inside corner across the diagonal (a moulding meeting the
 * moulding of the next wall), so the two cells meet in a mitre.
 *
 * **U along the run** is world-anchored: a cell's U is its world coordinate
 * along the run axis times its cell size ({@link runU}), never a distance
 * counted from the run's start. Counting from the start would need the whole
 * run, however far it reaches past any chunk, and an edit at one end would
 * shift the texture of every cell after it; a world-anchored U needs no
 * reach, is the same whichever chunk or section derives the cell, and an
 * edit only changes the sections it touches. The offset a derive unit needs
 * is the cell's own coordinate along the axis, which its instance carries.
 *
 * Reads the cases of the cell and its 18 neighbours sharing a face or a
 * horizontal edge (one cell out), and the fill of the cells one out along the
 * axis: the consumers' reach around the case box, so a chunk's sections are
 * the same whichever chunk or section derives them.
 */
import { OPEN_ROLE, type Neighbourhood } from './assembly';
import { PIECE_SECTION, SURFACE_ISO } from './derived-mesh';
import { applyFold, caseFoldOf, caseIndexOf, FOLD_TRANSFORMS, NO_CASE, type CaseDef } from './kit-cases';
import { ROLE_MASK, ROLE_SHIFT } from './record';

/** A cell's section in its run: the placeholder pieces' sections, then corners and junctions. */
export const RUN_SECTION = Object.freeze({ ...PIECE_SECTION, corner: 4, junction: 5 });

/** What one end of a run cell meets. */
export const RUN_END = Object.freeze({ joined: 0, open: 1, butt: 2, inner: 3 });

/** The world axis a run follows (`none` for a case without a run). */
export const RUN_AXIS = Object.freeze({ x: 0, y: 1, z: 2, none: 3 });

/** A cell without a case has no section. */
export const NO_SECTION = 0xffff;

/** Packs a cell's section: bits 0–2 section, 3–4 the end at its own −x (start side), 5–6 at its own +x, 7–8 the world axis. */
export function packRunSection(section: number, startEnd: number, endEnd: number, axis: number): number {
  return section | (startEnd << 3) | (endEnd << 5) | (axis << 7);
}

/** The section ({@link RUN_SECTION}) of a packed result. */
export function runSectionOf(packed: number): number {
  return packed & 7;
}

/** What the start side (the piece's own −x, or −y for a vertical run) meets ({@link RUN_END}). */
export function runStartEndOf(packed: number): number {
  return (packed >> 3) & 3;
}

/** What the end side (the piece's own +x, or +y) meets ({@link RUN_END}). */
export function runEndEndOf(packed: number): number {
  return (packed >> 5) & 3;
}

/** The world axis ({@link RUN_AXIS}) of a packed result. */
export function runAxisOf(packed: number): number {
  return (packed >> 7) & 3;
}

/**
 * World-anchored U (metres) of the cell at `offset` along the run axis in a
 * derive unit whose first cell is `firstCell` along that axis, both in cells
 * of size `cellMetres`: the same value whichever unit derives the cell, at
 * any level (a coarser cell starts where its finer cells do).
 */
export function runU(firstCell: number, offset: number, cellMetres: number): number {
  return (firstCell + offset) * cellMetres;
}

/** Per packed case (case index << 3 | transform): its run group, world axis and the sign of its own +x on that axis. */
export class RunTable {
  readonly group: Uint16Array;
  readonly axis: Uint8Array;
  readonly sign: Int8Array;

  constructor(cases: readonly CaseDef[]) {
    const size = cases.length * FOLD_TRANSFORMS;
    this.group = new Uint16Array(size);
    this.axis = new Uint8Array(size);
    this.sign = new Int8Array(size);
    const features = new Map<string, number>();
    cases.forEach((c, k) => {
      let group = k;
      if (c.feature !== undefined) {
        if (!features.has(c.feature)) features.set(c.feature, cases.length + features.size);
        group = features.get(c.feature)!;
      }
      for (let t = 0; t < FOLD_TRANSFORMS; t++) {
        const p = k * FOLD_TRANSFORMS + t;
        this.group[p] = group;
        if (c.run === null) {
          this.axis[p] = RUN_AXIS.none;
          this.sign[p] = 1;
        } else if (c.run === 'y') {
          this.axis[p] = RUN_AXIS.y;
          this.sign[p] = 1;
        } else {
          const [x, , z] = applyFold(t, [1, 0, 0]);
          this.axis[p] = x !== 0 ? RUN_AXIS.x : RUN_AXIS.z;
          this.sign[p] = x + z > 0 ? 1 : -1;
        }
      }
    });
  }
}

/** The table index of a packed case (its index and transform, as packed by the case pass). */
function slot(packed: number): number {
  return caseIndexOf(packed) * FOLD_TRANSFORMS + caseFoldOf(packed);
}

/**
 * Resolves the run section of every cell of the box [lo, hi) (padded
 * coordinates, all three axes) from the cases of the box and one cell round
 * it (`cases`, as the case pass packed them) into `out`: a packed section
 * ({@link packRunSection}) for a cell with a case, {@link NO_SECTION} for
 * any other. Returns the cells given a section.
 */
export function resolveRunSections(n: Neighbourhood, cases: Uint16Array, table: RunTable, lo: number, hi: number, out: Uint16Array): number {
  const s = n.side;
  if (lo < 1 || hi + 1 > s || out.length !== n.values.length || cases.length !== n.values.length) throw new RangeError(`run sections: box ${lo}…${hi} in a side of ${s}`);
  const step = [s * s, 1, s];
  const { group, axis: axisOf, sign: signOf } = table;
  const vals = n.values;
  const shapes = n.shapes;
  const open = (j: number): boolean => {
    const role = (vals[j]! >>> ROLE_SHIFT) & ROLE_MASK;
    return OPEN_ROLE[role] === 1 || shapes[j]! < SURFACE_ISO;
  };
  let count = 0;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      const i = row + y;
      const c = cases[i]!;
      if (c === NO_CASE) {
        out[i] = NO_SECTION;
        continue;
      }
      count++;
      const p = slot(c);
      const ax = axisOf[p]!;
      if (ax === RUN_AXIS.none) {
        out[i] = packRunSection(RUN_SECTION.single, RUN_END.open, RUN_END.open, RUN_AXIS.none);
        continue;
      }
      const g = group[p]!;
      const sign = signOf[p]!;
      const joins = (j: number, dirAx: number): boolean => {
        const cj = cases[j]!;
        if (cj === NO_CASE) return false;
        const q = slot(cj);
        return group[q] === g && (ax === dirAx || axisOf[q] === dirAx);
      };
      const st = step[ax]!;
      const neg = joins(i - st, ax);
      const pos = joins(i + st, ax);
      let across = 0;
      // A horizontal run's other horizontal axis: what corners, junctions and inner corners are read across.
      const pAx = ax === RUN_AXIS.x ? RUN_AXIS.z : ax === RUN_AXIS.z ? RUN_AXIS.x : RUN_AXIS.none;
      if (pAx !== RUN_AXIS.none) {
        const ps = step[pAx]!;
        across = (joins(i - ps, pAx) ? 1 : 0) + (joins(i + ps, pAx) ? 1 : 0);
      }
      const along = (neg ? 1 : 0) + (pos ? 1 : 0);
      const ownNeg = sign > 0 ? neg : pos;
      const ownPos = sign > 0 ? pos : neg;
      let section: number;
      if (across === 0) section = along === 0 ? RUN_SECTION.single : along === 2 ? RUN_SECTION.body : ownPos ? RUN_SECTION.start : RUN_SECTION.end;
      else section = along === 1 && across === 1 ? RUN_SECTION.corner : RUN_SECTION.junction;
      const endAt = (joined: boolean, j: number): number => {
        if (joined) return RUN_END.joined;
        if (open(j)) return RUN_END.open;
        const cross = ax === RUN_AXIS.x ? RUN_AXIS.z : ax === RUN_AXIS.z ? RUN_AXIS.x : RUN_AXIS.none;
        if (cross !== RUN_AXIS.none) {
          // An inside corner: the run stops against a solid cell, beside which the next run starts across the open corner.
          const cs = step[cross]!;
          for (const d of [-cs, cs]) {
            const ck = cases[j + d]!;
            if (ck === NO_CASE || !open(i + d)) continue;
            const q = slot(ck);
            if (group[q] === g && axisOf[q] === cross) return RUN_END.inner;
          }
        }
        return RUN_END.butt;
      };
      out[i] = packRunSection(section, endAt(ownNeg, i - sign * st), endAt(ownPos, i + sign * st), ax);
    }
  }
  return count;
}
