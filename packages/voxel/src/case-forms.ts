/**
 * What every consumer of a derive receives for a cell: its **form**, the
 * coarse shape it occupies and what the base surface does with it, read
 * from the cell's case (kit-cases.ts) where it has one and from its class
 * where it does not. Render occupancy, collision, navigation and light
 * coverage are all functions of the form, so an open banister is open for
 * every one of them and a wall is solid for every one of them, and none of
 * them ever reads a kit's piece mesh: a kit cannot change gameplay shapes
 * by its art, and every kit of a material type collides the same.
 *
 * **Shape.** One box in 1/{@link FORM_STEPS} cell, written in the case's
 * own orientation (front +z, run x, up +y) and turned into place by the
 * case's transform: `box` (the whole cell), `panel` (a thin upright sheet
 * along the run: a rail), `bar` (a thin horizontal member along the run: a
 * beam), `post` (a thin upright bar) and `none`. Light coverage is the shape's
 * share of the cell; a cell supports standing when its shape covers the
 * cell's whole top face; it blocks movement unless it is `none`; it is
 * solid for rendering and culling only as a `box`.
 *
 * **Base.** `keep`: the base surface draws the cell's exposed faces (its
 * shape is the whole box, or none); `suppress`: the base surface draws
 * nothing there and the cell hides none of its neighbours' faces, because a
 * detail piece replaces it (a level that draws no pieces draws it as a body
 * instead).
 *
 * Packed in a byte a cell, inside the derive job only: bits 0–2 the shape,
 * 3–5 the transform (kit-cases.ts fold), 6–7 the base.
 */
import { ASSEMBLY_CLASS, CLASS_MASK, CONSUMER_REACH, OPEN_ROLE, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { damagedIntegrity, valueRole } from './record';
import { SURFACE_ISO } from './derived-mesh';
import { applyFold, CASE_BASES, CASE_SHAPES, caseFoldOf, caseIndexOf, FOLD_TRANSFORMS, NO_CASE, type CaseBase, type CaseDef, type CaseShape } from './kit-cases';

/** Shape steps a cell along each axis (the collision steps: 1/16 cell ≈ 3 cm). */
export const FORM_STEPS = 16;

/** The declared shapes, by index (a form byte's shape). */
export const FORM_SHAPE = Object.freeze(Object.fromEntries(CASE_SHAPES.map((k, i) => [k, i])) as Record<CaseShape, number>);

/** What the base surface does with a cell, by index (a form byte's base). */
export const FORM_BASE = Object.freeze(Object.fromEntries(CASE_BASES.map((k, i) => [k, i])) as Record<CaseBase, number>);

/** Each shape's box (min x, y, z, max x, y, z in {@link FORM_STEPS}) in the case's own orientation; null for none. */
export const FORM_SHAPE_BOX: Readonly<Record<CaseShape, readonly [number, number, number, number, number, number] | null>> = Object.freeze({
  none: null,
  box: [0, 0, 0, 16, 16, 16],
  panel: [0, 0, 6, 16, 16, 10],
  bar: [0, 3, 3, 16, 13, 13],
  post: [6, 0, 6, 10, 16, 10],
});

const SHAPE_NAMES = CASE_SHAPES;
const SHAPES = SHAPE_NAMES.length;

/** Light coverage (0 … 255) of each shape: its share of the cell. */
export const LIGHT_COVERAGE: Readonly<Record<CaseShape, number>> = Object.freeze(
  Object.fromEntries(
    SHAPE_NAMES.map((k) => {
      const b = FORM_SHAPE_BOX[k];
      return [k, b === null ? 0 : Math.round((255 * (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2])) / FORM_STEPS ** 3)];
    }),
  ) as Record<CaseShape, number>,
);

/** A form byte. */
export function packForm(shape: number, fold: number, base: number): number {
  return shape | (fold << 3) | (base << 6);
}

/** The shape ({@link FORM_SHAPE}) of a form byte. */
export function formShapeOf(form: number): number {
  return form & 7;
}

/** The transform of a form byte. */
export function formFoldOf(form: number): number {
  return (form >> 3) & 7;
}

/** The base ({@link FORM_BASE}) of a form byte. */
export function formBaseOf(form: number): number {
  return form >> 6;
}

/** The form of open space (air, liquid, an opening, ground: ground's consumers read its density instead). */
export const FORM_NONE = packForm(FORM_SHAPE.none, 0, FORM_BASE.keep);
/** A whole-cell body the base surface draws. */
export const FORM_BODY = packForm(FORM_SHAPE.box, 0, FORM_BASE.keep);
/**
 * A damaged construction cell under a rule set that draws debris: still the
 * whole box for collision, light and navigation (its integrity is not a
 * fill), but its faces are left to its debris piece and it hides none of
 * its neighbours' faces, so the hole shows the faces opening toward it.
 */
export const FORM_DEBRIS = packForm(FORM_SHAPE.box, 0, FORM_BASE.suppress);

/** Per shape and transform (shape · 8 + fold): the box in the world's axes, six numbers. */
const WORLD_BOX = new Uint8Array(SHAPES * FOLD_TRANSFORMS * 6);
/** Per shape and transform: bit d set when the box covers the cell's whole face d (−x, +x, −y, +y, −z, +z). */
const FULL_FACES = new Uint8Array(SHAPES * FOLD_TRANSFORMS);
for (let k = 0; k < SHAPES; k++) {
  const b = FORM_SHAPE_BOX[SHAPE_NAMES[k]!];
  for (let t = 0; t < FOLD_TRANSFORMS; t++) {
    const at = (k * FOLD_TRANSFORMS + t) * 6;
    if (b === null) continue;
    // Turn the corners about the cell's vertical axis (x, z doubled so the centre is whole).
    const h = FORM_STEPS;
    const p = applyFold(t, [2 * b[0] - h, 0, 2 * b[2] - h]);
    const q = applyFold(t, [2 * b[3] - h, 0, 2 * b[5] - h]);
    const box = [(Math.min(p[0], q[0]) + h) / 2, b[1], (Math.min(p[2], q[2]) + h) / 2, (Math.max(p[0], q[0]) + h) / 2, b[4], (Math.max(p[2], q[2]) + h) / 2];
    WORLD_BOX.set(box, at);
    let full = 0;
    for (let d = 0; d < 6; d++) {
      const axis = d >> 1;
      const onFace = (d & 1) === 0 ? box[axis] === 0 : box[3 + axis] === h;
      const u = (axis + 1) % 3;
      const w = (axis + 2) % 3;
      if (onFace && box[u] === 0 && box[3 + u] === h && box[w] === 0 && box[3 + w] === h) full |= 1 << d;
    }
    FULL_FACES[k * FOLD_TRANSFORMS + t] = full;
  }
}

/** The world-axis box of a form's shape into `out` (min x, y, z, max x, y, z in {@link FORM_STEPS}); false for no shape. */
export function formBox(form: number, out: number[] | Uint16Array | Int32Array): boolean {
  const shape = formShapeOf(form);
  if (shape === FORM_SHAPE.none) return false;
  const at = (shape * FOLD_TRANSFORMS + formFoldOf(form)) * 6;
  for (let a = 0; a < 6; a++) out[a] = WORLD_BOX[at + a]!;
  return true;
}

/** Faces of the cell (bit d: −x, +x, −y, +y, −z, +z) a form's shape covers whole. */
export function formFullFaces(form: number): number {
  return FULL_FACES[formShapeOf(form) * FOLD_TRANSFORMS + formFoldOf(form)]!;
}

/** Light coverage of a form's shape. */
export function formCoverage(form: number): number {
  return COVERAGE[formShapeOf(form)]!;
}

const COVERAGE = Uint8Array.from(SHAPE_NAMES, (k) => LIGHT_COVERAGE[k]);

/** Whether a form supports standing on it (its shape covers the cell's whole top face). */
export function formSupports(form: number): boolean {
  return (formFullFaces(form) & (1 << 3)) !== 0;
}

/** Per case index: its declared shape and base (a form byte without the transform). */
export function caseFormTable(cases: readonly CaseDef[]): Uint8Array {
  return Uint8Array.from(cases, (c) => packForm(FORM_SHAPE[c.shape], 0, FORM_BASE[c.base]));
}

/**
 * The form a class byte gives a cell without a case (a rule set without the
 * case pass, a level that resolves none, a cell no catalogue role covers):
 * a wall, beam or rail cell is the body (a plain voxel: no piece stands in
 * for a thin feature); open space, liquid and ground none.
 */
export function classForm(resolved: number): number {
  const k = resolved & CLASS_MASK;
  return k === ASSEMBLY_CLASS.wall || k === ASSEMBLY_CLASS.beam || k === ASSEMBLY_CLASS.rail ? FORM_BODY : FORM_NONE;
}

/** Whether a rule set draws damaged construction cells as debris: the sets with the edge pass. */
export function rulesDrawDebris(rules: AssemblyRuleSet): boolean {
  return rules.resolveEdges !== undefined;
}

/** Whether a cell is solid to look through: a role that is not open, filled to the surface. */
function seeSolid(n: Neighbourhood, i: number): boolean {
  return OPEN_ROLE[valueRole(n.values[i]!)] !== 1 && n.shapes[i]! >= SURFACE_ISO;
}

/**
 * Whether cell `i` is drawn as debris (under a rule set that draws it): a
 * damaged construction cell with at least one face open (air, liquid, an
 * opening or ground below the surface beside it). A damaged cell buried in a
 * mass stays a body: nothing would see its debris, and the faces round it
 * would be hidden geometry. Reads one cell round it.
 */
export function isDebrisCell(n: Neighbourhood, i: number): boolean {
  if (damagedIntegrity(n.values[i]!) === 0) return false;
  const s = n.side;
  return !seeSolid(n, i + 1) || !seeSolid(n, i - 1) || !seeSolid(n, i + s) || !seeSolid(n, i - s) || !seeSolid(n, i + s * s) || !seeSolid(n, i - s * s);
}

/**
 * The form of every cell the consumers read (the derive unit and
 * {@link CONSUMER_REACH} round it) into `out` (neighbourhood indexing), from
 * the classes and the cases the job resolved: a cell with a case takes its
 * case's declared shape and base, turned by its transform; any other its
 * class's form. Under a rule set that draws debris, a debris cell
 * ({@link isDebrisCell}) is {@link FORM_DEBRIS} whatever its case.
 */
export function evaluateForms(n: Neighbourhood, rules: AssemblyRuleSet, classes: Uint8Array, cases: Uint16Array, out: Uint8Array): void {
  if (out.length !== n.values.length || classes.length !== n.values.length || cases.length !== n.values.length) throw new RangeError('cell forms: wrong length');
  const table = rules.caseForms;
  const debris = rulesDrawDebris(rules);
  const s = n.side;
  const lo = n.pad - CONSUMER_REACH;
  const hi = n.pad + n.edge + CONSUMER_REACH;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      const i = row + y;
      const c = cases[i]!;
      if (debris && isDebrisCell(n, i)) out[i] = FORM_DEBRIS;
      else out[i] = c === NO_CASE || table === undefined ? classForm(classes[i]!) : table[caseIndexOf(c)]! | (caseFoldOf(c) << 3);
    }
  }
}
