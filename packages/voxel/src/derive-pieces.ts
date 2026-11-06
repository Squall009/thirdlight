/**
 * Which detail pieces a derive places, cell by cell. Walls, floors, stairs,
 * pillars, foundations and flat roofs are plain voxel faces: the base
 * surface draws every flat face, and no piece ever stands on one. A cell
 * owns pieces only where faces meet or where it is broken:
 *
 * - **edges and corners** (edge-cases.ts): one piece a lattice edge or
 *   corner the edge pass gave the cell, by its case and yaw, in the kit of
 *   the cell that dresses it (`slotDressing`: where roles meet, the higher
 *   role's), cut flush at faces toward an opening;
 * - **roof edges** (roof-mesher.ts): the ridge, eave, verge, hip and valley
 *   pieces of a roof plane cell (a verge rising toward its own −x
 *   mirrored, so one verge mesh follows both slopes of a gable);
 * - **debris**: a debris cell (case-forms.ts `isDebrisCell`) draws the piece
 *   of its stage in place of its faces, and every intact body face opening
 *   toward it draws a `debris-face` piece (its broken rim), owned by the
 *   intact cell. Edges round a debris cell take no piece.
 *
 * A piece is drawn only where its dressing cell's material has a kit and the kit
 * fills the case's slot: no kit, or an empty slot, draws nothing (the
 * edge stays a plain voxel edge). Every piece is its own instance (no
 * merged runs); its mesh pick is hashed from its world cell, the project's
 * piece seed and which of the cell's pieces it is, so the edges of one cell
 * vary on their own and an edit elsewhere never moves them.
 */
import type { Neighbourhood } from './assembly';
import { FORM_BASE, FORM_DEBRIS, FORM_SHAPE, formBaseOf, formShapeOf } from './case-forms';
import { dressingWord, INSTANCE_FLAG, INSTANCE_PLACE, type CellPiece } from './derived-mesh';
import { blockNeighbour, DRESSING_FLUSH_SHIFT, EDGE_CASE_IDS, edgeCaseOf, edgeYawOf, PIECE_SLOTS, SELF_BLOCK, slotDressing, type EdgeMasks } from './edge-cases';
import { DEBRIS_LIGHT_MIN } from './kit-case-catalogue';
import type { CaseCatalogueDef } from './kit-cases';
import { NO_PIECE, PIECE_VARIANT_MIRROR, pieceVariant, tablePiece, type PieceTable } from './piece-table';
import { damagedIntegrity, MATERIAL_ID_MAX } from './record';
import { ROOF_EDGE_CASE_IDS, roofEdgesOf } from './roof-mesher';

/**
 * The kit pieces a derive chooses from: the world's piece table (null: no
 * kit, no cell draws a piece) and the
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
  readonly forms: Uint8Array;
  readonly pieces: DerivePieces;
  readonly level: number;
  /** Roof plane words (roof-mesher.ts): a plane cell takes its roof-edge pieces and no other. */
  readonly roofs: Uint32Array;
  /** The edge pass's pieces of the derive unit's cells. */
  readonly edges: EdgeMasks;
  /** The rule set's catalogue (what the table numbers cases by), if any. */
  readonly catalogue: CaseCatalogueDef | undefined;
}

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
      roof: new Map(ROOF_EDGE_CASE_IDS.map((id) => [id, of(id)])),
      debris: of('debris'),
      debrisHeavy: of('debris-heavy'),
      debrisFace: of('debris-face'),
    };
    passCaseCache.set(cat, p);
  }
  return p;
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
 * Every piece padded cell `i` (local x, y, z) owns, each written into
 * `cell` and listed by `emit` (see the file comment for which and in what
 * order: its debris, its edges and corners in slot order, its roof edges,
 * its debris faces).
 */
export function cellPieces(p: PieceInputs, i: number, x: number, y: number, z: number, cell: CellPiece, emit: () => void): void {
  const table = p.pieces.table;
  if (table === null || p.catalogue === undefined) return;
  const v = p.n.values[i]!;
  const mat = v & MATERIAL_ID_MAX;
  if (mat === 0) return;
  const cases = passCases(p.catalogue);
  const o = p.pieces.origin;
  // `dressing`: the slotDressing word (the cell whose kit draws it, the faces it is cut at); its own cell's by default.
  const put = (caseIndex: number, yaw: number, place: number, flags: number, mirror = false, dressing = SELF_BLOCK): void => {
    if (caseIndex < 0) return;
    const block = dressing & ((1 << DRESSING_FLUSH_SHIFT) - 1);
    const m = block === SELF_BLOCK ? mat : p.n.values[blockNeighbour(p.n, i, block)]! & MATERIAL_ID_MAX;
    const piece = tablePiece(table, m, caseIndex);
    if (piece === NO_PIECE) return;
    cell.piece = piece;
    cell.turns = yaw;
    cell.place = place;
    cell.flags = flags;
    cell.variant = pieceVariant(table, m, piece, p.level, o[0] + x, o[1] + y, o[2] + z, (caseIndex << 4) | (place << 2) | yaw) | (mirror ? PIECE_VARIANT_MIRROR : 0);
    cell.dressing = dressingWord(block, dressing >>> DRESSING_FLUSH_SHIFT);
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
    for (let k = 0; k < PIECE_SLOTS; k++) {
      if (((mask >>> k) & 1) === 0) continue;
      const isInner = ((inner >>> k) & 1) === 1;
      const dressing = slotDressing(p.n, i, k, isInner, table.materialKit);
      if (dressing >= 0) put(cases.edge[edgeCaseOf(k, isInner)]!, edgeYawOf(k, isInner), INSTANCE_PLACE.upright, 0, false, dressing);
    }
  }
  const roof = p.roofs[i]!;
  if (roof !== 0) {
    for (const e of roofEdgesOf(roof)) put(cases.roof.get(e.caseId) ?? -1, e.yaw, e.centred === true ? INSTANCE_PLACE.centred : INSTANCE_PLACE.upright, e.half === true ? INSTANCE_FLAG.half : 0, e.mirror === true);
    return;
  }
  if (cases.debrisFace < 0 || formBaseOf(form) !== FORM_BASE.keep || formShapeOf(form) !== FORM_SHAPE.box) return;
  const s = p.n.side;
  for (const [dx, dy, dz, yaw, place] of FACE_DIRS) {
    if (forms[i + (dx * s + dz) * s + dy] === FORM_DEBRIS) put(cases.debrisFace, yaw, place, 0);
  }
}
