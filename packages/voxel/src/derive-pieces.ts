/**
 * Which detail pieces a derive places, cell by cell. Walls, floors, stairs,
 * pillars, foundations and flat roofs are plain voxel faces: the base
 * surface draws every flat face, and no piece ever stands on one. A cell
 * owns pieces only where faces meet or where it is broken:
 *
 * - **edges and corners** (edge-cases.ts): one piece a lattice edge or
 *   corner the edge pass gave the cell, by its case and yaw;
 * - **roof edges** (roof-mesher.ts): the ridge, eave, verge, hip and valley
 *   pieces of a roof plane cell (a verge rising toward its own −x
 *   mirrored, so one verge mesh follows both slopes of a gable);
 * - **beams and banisters**: the cell's window case with its run section, a
 *   piece that replaces the cell's base (as built with the case pass);
 * - **debris**: a debris cell (case-forms.ts `isDebrisCell`) draws the piece
 *   of its stage in place of its faces, and every intact body face opening
 *   toward it draws a `debris-face` piece (its broken rim), owned by the
 *   intact cell. Edges round a debris cell take no piece.
 *
 * An edge piece is dropped where a cell round its edge is a beam or a
 * banister (drawn thin by its own piece, so the edge is not where faces
 * meet). Every piece is its own instance (no merged runs); its variant is
 * hashed from its world cell, its kit's seed and which of the cell's pieces
 * it is, so the edges of one cell vary on their own and an edit elsewhere
 * never moves them.
 */
import type { Neighbourhood } from './assembly';
import { FORM_BASE, FORM_DEBRIS, FORM_SHAPE, formBaseOf, formFoldOf, formShapeOf } from './case-forms';
import { INSTANCE_FLAG, INSTANCE_PLACE, PIECE_FAMILY, PIECE_SECTION, type CellPiece } from './derived-mesh';
import { EDGE_CASE_IDS, EDGE_SLOTS, edgeCaseOf, edgeYawOf, PIECE_SLOT_TABLE, PIECE_SLOTS, type EdgeMasks } from './edge-cases';
import { DEBRIS_LIGHT_MIN } from './kit-case-catalogue';
import { caseIndexOf, NO_CASE, type CaseCatalogueDef } from './kit-cases';
import { NO_SECTION, RUN_SECTION, runSectionOf } from './kit-runs';
import { defaultPiece, NO_PIECE, PIECE_VARIANT_MIRROR, pieceVariant, tablePiece, type PieceTable } from './piece-table';
import { damagedIntegrity, MATERIAL_ID_MAX } from './record';
import { roofEdgesOf } from './roof-mesher';

/**
 * The kit pieces a derive chooses from: the world's piece table (null: no
 * kit binds a material, every cell draws the default pieces) and the
 * derive unit's first cell in world cells of its level (what a variant's
 * hash reads, so a cell keeps its variant whichever chunk, section or job
 * derives it).
 */
export interface DerivePieces {
  readonly table: PieceTable | null;
  readonly origin: readonly [number, number, number];
}

export const NO_PIECES: DerivePieces = Object.freeze({ table: null, origin: [0, 0, 0] as const });

/** What one derive's piece choice reads (built once a derive). */
export interface PieceInputs {
  readonly n: Neighbourhood;
  readonly classes: Uint8Array;
  readonly forms: Uint8Array;
  readonly cases: Uint16Array;
  readonly runs: Uint16Array;
  readonly pieces: DerivePieces;
  readonly level: number;
  /** Roof plane words (roof-mesher.ts): a plane cell takes its roof-edge pieces and no other. */
  readonly roofs: Uint32Array;
  /** The edge pass's pieces of the derive unit's cells. */
  readonly edges: EdgeMasks;
  /** The rule set's catalogue (what the table numbers cases by), if any. */
  readonly catalogue: CaseCatalogueDef | undefined;
}

/** The default piece's stand-in family for each declared shape a piece replaces (0: none). */
const SHAPE_FAMILY = new Uint8Array(8);
SHAPE_FAMILY[FORM_SHAPE.bar] = PIECE_FAMILY.beam;
SHAPE_FAMILY[FORM_SHAPE.panel] = PIECE_FAMILY.rail;
SHAPE_FAMILY[FORM_SHAPE.post] = PIECE_FAMILY.post;

/** A catalogue's case indices of the cases the passes name (−1: the catalogue lacks it). */
interface PassCases {
  /** By edge case index ({@link EDGE_CASE_IDS}). */
  readonly edge: Int32Array;
  readonly roof: ReadonlyMap<string, number>;
  readonly debris: number;
  readonly debrisHeavy: number;
  readonly debrisFace: number;
}

const passCaseCache = new WeakMap<CaseCatalogueDef, PassCases>();

function passCases(cat: CaseCatalogueDef): PassCases {
  let p = passCaseCache.get(cat);
  if (p === undefined) {
    const at = new Map(cat.cases.map((c, k) => [c.id, k]));
    const of = (id: string): number => at.get(id) ?? -1;
    p = {
      edge: Int32Array.from(EDGE_CASE_IDS, of),
      roof: new Map(['roof-ridge', 'roof-eave', 'roof-gable', 'roof-hip', 'roof-valley'].map((id) => [id, of(id)])),
      debris: of('debris'),
      debrisHeavy: of('debris-heavy'),
      debrisFace: of('debris-face'),
    };
    passCaseCache.set(cat, p);
  }
  return p;
}

/** Per side: per edge slot, the neighbourhood offsets of the 3 cells round the edge besides the owner. */
const slotCellCache = new Map<number, Int32Array>();

function slotCells(side: number): Int32Array {
  let d = slotCellCache.get(side);
  if (d === undefined) {
    d = new Int32Array(EDGE_SLOTS * 3);
    for (let k = 0; k < EDGE_SLOTS; k++) {
      const slot = PIECE_SLOT_TABLE[k]!;
      [...slot.faces, ...slot.rest].forEach((o, j) => (d![k * 3 + j] = (o[0] * side + o[2]) * side + o[1]));
    }
    slotCellCache.set(side, d);
  }
  return d;
}

/** Per corner slot c (bit 0 +x, 1 +y, 2 +z): the offsets of the 7 cells round the corner besides the owner. */
const cornerCellCache = new Map<number, Int32Array>();

function cornerCells(side: number): Int32Array {
  let d = cornerCellCache.get(side);
  if (d === undefined) {
    d = new Int32Array((PIECE_SLOTS - EDGE_SLOTS) * 7);
    for (let c = 0; c < PIECE_SLOTS - EDGE_SLOTS; c++) {
      const slot = PIECE_SLOT_TABLE[EDGE_SLOTS + c]!;
      [...slot.faces, ...slot.rest].forEach((o, j) => (d![c * 7 + j] = (o[0] * side + o[2]) * side + o[1]));
    }
    cornerCellCache.set(side, d);
  }
  return d;
}

/** Whether a form leaves its cell to a beam or banister piece (drawn thin: no edge of faces meets there). */
function thinPiece(form: number): boolean {
  return formBaseOf(form) === FORM_BASE.suppress && form !== FORM_DEBRIS;
}

/** The six face directions: neighbourhood offset factors (x, y, z) and the debris-face piece's yaw and placement there. */
const FACE_DIRS: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 1, 0, INSTANCE_PLACE.upright],
  [-1, 0, 0, 1, INSTANCE_PLACE.upright],
  [0, 0, -1, 2, INSTANCE_PLACE.upright],
  [1, 0, 0, 3, INSTANCE_PLACE.upright],
  [0, 1, 0, 0, INSTANCE_PLACE.faceUp],
  [0, -1, 0, 0, INSTANCE_PLACE.faceDown],
];

/**
 * The beam or banister piece of cell `i` into `cell`, or false: the own
 * piece of the kit its material names, by its case and run section, where
 * the kit has one; else the engine's default piece for its declared shape
 * and run section, or for a cell without a case (rule sets without a case
 * pass), its section from the neighbours along its run with the same class
 * byte. Turns, and the mirror bit, come from its case's transform.
 */
function thinPieceAt(p: PieceInputs, i: number, x: number, y: number, z: number, cell: CellPiece): boolean {
  const f = p.forms[i]!;
  if (!thinPiece(f)) return false;
  const fold = formFoldOf(f);
  const packed = p.cases[i]!;
  const run = p.runs[i]!;
  const table = p.pieces.table;
  cell.turns = fold & 3;
  cell.place = INSTANCE_PLACE.upright;
  cell.flags = INSTANCE_FLAG.replacesBase;
  const mirror = fold >= 4 ? PIECE_VARIANT_MIRROR : 0;
  if (table !== null && packed !== NO_CASE) {
    const mat = p.n.values[i]! & MATERIAL_ID_MAX;
    const piece = tablePiece(table, mat, caseIndexOf(packed), run === NO_SECTION ? RUN_SECTION.single : runSectionOf(run));
    if (piece !== NO_PIECE) {
      const o = p.pieces.origin;
      cell.piece = piece;
      cell.variant = pieceVariant(table, mat, piece, p.level, o[0] + x, o[1] + y, o[2] + z) | mirror;
      return true;
    }
  }
  const family = SHAPE_FAMILY[formShapeOf(f)]!;
  if (family === 0) return false;
  let section: number = PIECE_SECTION.single;
  if (run !== NO_SECTION) section = runSectionOf(run);
  else if (family !== PIECE_FAMILY.post) {
    // Along the run: x unturned or half turned, z otherwise.
    const s = p.n.side;
    const step = (fold & 1) === 0 ? s * s : s;
    const k = p.classes[i]!;
    const prev = p.classes[i - step] === k;
    const next = p.classes[i + step] === k;
    section = prev && next ? PIECE_SECTION.body : next ? PIECE_SECTION.start : prev ? PIECE_SECTION.end : PIECE_SECTION.single;
  }
  cell.piece = defaultPiece(family, section);
  cell.variant = mirror;
  return true;
}

/**
 * Every piece padded cell `i` (local x, y, z) owns, each written into
 * `cell` and listed by `emit` (see the file comment for which and in what
 * order: its beam or banister piece, its debris, its edges and corners in
 * slot order, its roof edges, its debris faces).
 */
export function cellPieces(p: PieceInputs, i: number, x: number, y: number, z: number, cell: CellPiece, emit: () => void): void {
  if (thinPieceAt(p, i, x, y, z, cell)) {
    emit();
    return;
  }
  const table = p.pieces.table;
  if (table === null || p.catalogue === undefined) return;
  const v = p.n.values[i]!;
  const mat = v & MATERIAL_ID_MAX;
  if (mat === 0) return;
  const cases = passCases(p.catalogue);
  const o = p.pieces.origin;
  const put = (caseIndex: number, yaw: number, place: number, flags: number, mirror = false): void => {
    if (caseIndex < 0) return;
    const piece = tablePiece(table, mat, caseIndex, RUN_SECTION.single);
    if (piece === NO_PIECE) return;
    cell.piece = piece;
    cell.turns = yaw;
    cell.place = place;
    cell.flags = flags;
    cell.variant = pieceVariant(table, mat, piece, p.level, o[0] + x, o[1] + y, o[2] + z, (caseIndex << 4) | (place << 2) | yaw) | (mirror ? PIECE_VARIANT_MIRROR : 0);
    emit();
  };
  const forms = p.forms;
  const form = forms[i]!;
  if (form === FORM_DEBRIS) {
    put(damagedIntegrity(v) >= DEBRIS_LIGHT_MIN ? cases.debris : cases.debrisHeavy, 0, INSTANCE_PLACE.upright, INSTANCE_FLAG.replacesBase);
    return;
  }
  const mask = p.edges.pieces[i]!;
  if (mask !== 0) {
    const inner = p.edges.inner[i]!;
    const edgeCells = slotCells(p.n.side);
    const corner = cornerCells(p.n.side);
    for (let k = 0; k < PIECE_SLOTS; k++) {
      if (((mask >>> k) & 1) === 0) continue;
      let thin = false;
      if (k < EDGE_SLOTS) for (let j = 0; j < 3 && !thin; j++) thin = thinPiece(forms[i + edgeCells[k * 3 + j]!]!);
      else for (let j = 0; j < 7 && !thin; j++) thin = thinPiece(forms[i + corner[(k - EDGE_SLOTS) * 7 + j]!]!);
      if (thin) continue;
      const isInner = ((inner >>> k) & 1) === 1;
      put(cases.edge[edgeCaseOf(k, isInner)]!, edgeYawOf(k, isInner), INSTANCE_PLACE.upright, 0);
    }
  }
  const roof = p.roofs[i]!;
  if (roof !== 0) {
    for (const e of roofEdgesOf(roof)) put(cases.roof.get(e.caseId) ?? -1, e.yaw, e.centred === true ? INSTANCE_PLACE.centred : INSTANCE_PLACE.upright, 0, e.mirror === true);
    return;
  }
  if (cases.debrisFace < 0 || formBaseOf(form) !== FORM_BASE.keep || formShapeOf(form) !== FORM_SHAPE.box) return;
  const s = p.n.side;
  for (const [dx, dy, dz, yaw, place] of FACE_DIRS) {
    if (forms[i + (dx * s + dz) * s + dy] === FORM_DEBRIS) put(cases.debrisFace, yaw, place, 0);
  }
}
