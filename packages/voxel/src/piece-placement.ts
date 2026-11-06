/**
 * Where a detail piece sits in its case's own orientation, as a renderer
 * needs it beyond the instance's turns and placement: the axis its run
 * follows (a world-anchored texture U runs along it) and its **stagger**.
 *
 * **Stagger.** Pieces are drawn one a 0.5 m lattice edge, corner or roof
 * edge, so a long wall's rim would read as a ruled line. Each instance is
 * moved a little into the solid along its frame's bisector and twisted a
 * little about that bisector, by a hash of its world cell, level, the
 * project's piece seed and slot (its case, placement and yaw), so it is the
 * same on every load and on every renderer, and an edit elsewhere never
 * moves it. It moves *into* the solid, never out: an outer strip sinks into
 * its two faces, a cove into the walls it fills, a roof edge into the roof
 * and a damage piece into the cell it dresses, so no gap ever opens between
 * a piece and its faces; the twist is held below what the move hides (a
 * strip end never lifts off a face). Every case of the catalogue has a
 * frame, so every piece kind is staggered.
 *
 * **Jitter.** A kit scales the stagger by its own jitter (0 … {@link
 * PIECE_JITTER_MAX}; 1, the default, is {@link PIECE_STAGGER}): 0 draws its
 * pieces exactly on the lattice, 2 moves and twists them twice as far.
 * Stagger is drawing only: collision, light and navigation never read
 * pieces.
 */
import { latticeHash4 } from '@thirdlight/shared';
import { CUBE_ROTATIONS } from './cube-rotations';

/** The stagger's bounds, in cells of the piece's level and radians. */
export const PIECE_STAGGER = Object.freeze({
  /** Every staggered piece moves at least this far into the solid (what lets it twist). */
  inwardMin: 1 / 64,
  /** And at most this far. */
  inwardMax: 1 / 32,
  /** The largest twist about the edge's bisector. */
  twistMax: (2 * Math.PI) / 180,
});

type Vec3 = readonly [number, number, number];

/** A kit's jitter when it sets none: the stagger as {@link PIECE_STAGGER} gives it. */
export const PIECE_JITTER_DEFAULT = 1;

/** The largest jitter a kit may set (its pieces move at most 4 × 1/32 cell, about 6 cm, into the solid and twist at most 8°). */
export const PIECE_JITTER_MAX = 4;

/** A staggered case's frame: the middle of its edge (or its corner) from the cell's centre, in cells, and the bisector out of the solid. */
export interface PieceStaggerFrame {
  readonly anchor: Vec3;
  /** Unit vector from the solid into the open side(s). */
  readonly out: Vec3;
  /** Half the piece's length along its run from the anchor, in cells (a corner: its reach). */
  readonly reach: number;
}

const S2 = Math.SQRT1_2;
const S3 = 1 / Math.sqrt(3);
const frame = (anchor: Vec3, out: Vec3, reach: number): PieceStaggerFrame => Object.freeze({ anchor, out, reach });

const H = 0.5;

/**
 * Every case's frame, in its own orientation (kit-case-catalogue.ts: the open side toward +z, a vertical edge or
 * corner toward +x and +z, up +y; roof-mesher.ts for the roof edges). An inner edge's "solid" is its owner's side:
 * the cove moves into the walls it lies against. A roof edge moves into the roof: an eave down its plane's normal
 * (the plane rising toward −z: normal (0, 1, 1)/√2), a verge into the plane (rising toward +x: normal (−1, 1, 0)/√2)
 * and in from the gable (−z), a ridge straight down, a hip or valley along the two planes' mean normal (planes
 * rising toward −x and −z). A debris piece drawn in its cell's place sinks into the cell; a debris face, written for
 * the face toward the damaged cell (+z), into the intact cell it dresses.
 */
export const PIECE_STAGGER_FRAMES: Readonly<Record<string, PieceStaggerFrame>> = Object.freeze({
  'edge-out-top': frame([0, 0.5, 0.5], [0, S2, S2], 0.5),
  'edge-out-vertical': frame([0.5, 0, 0.5], [S2, 0, S2], 0.5),
  'edge-out-bottom': frame([0, -0.5, 0.5], [0, -S2, S2], 0.5),
  'edge-in-top': frame([0, -0.5, 0.5], [0, -S2, S2], 0.5),
  'edge-in-vertical': frame([0.5, 0, 0.5], [S2, 0, S2], 0.5),
  'edge-in-bottom': frame([0, 0.5, 0.5], [0, S2, S2], 0.5),
  'corner-out-top': frame([0.5, 0.5, 0.5], [S3, S3, S3], 0.25),
  'corner-out-bottom': frame([0.5, -0.5, 0.5], [S3, -S3, S3], 0.25),
  'corner-in-top': frame([0.5, -0.5, 0.5], [S3, -S3, S3], 0.25),
  'corner-in-bottom': frame([0.5, 0.5, 0.5], [S3, S3, S3], 0.25),
  'roof-ridge': frame([0, 3 * H, H], [0, 1, 0], 0.5),
  'roof-eave': frame([0, H, H], [0, S2, S2], 0.5),
  'roof-gable': frame([0, 1, H], [-0.5, 0.5, S2], 0.5 * Math.SQRT2),
  'roof-hip': frame([0, 1, 0], [1 / Math.sqrt(6), 2 / Math.sqrt(6), 1 / Math.sqrt(6)], 0.5 * Math.sqrt(3)),
  'roof-valley': frame([0, 1, 0], [1 / Math.sqrt(6), 2 / Math.sqrt(6), 1 / Math.sqrt(6)], 0.5 * Math.sqrt(3)),
  debris: frame([0, 0, 0], [0, 1, 0], 0.5),
  'debris-heavy': frame([0, 0, 0], [0, 1, 0], 0.5),
  'debris-face': frame([0, 0, H], [0, 0, 1], 0.5),
});

/** The vertical edge cases: their run is along y in their own orientation (every other case runs along x). */
const VERTICAL_RUN = new Set(['edge-out-vertical', 'edge-in-vertical']);

/** The axis a case's piece runs along in its own orientation (0 x, 1 y): where a world-anchored texture U grows. */
export function pieceRunAxis(caseId: string): 0 | 1 {
  return VERTICAL_RUN.has(caseId) ? 1 : 0;
}

/**
 * The axis of a slot's mesh (0 x, 1 y, 2 z, in the mesh's own space) that its cube rotation `rotation` turns onto
 * the slot's run ({@link pieceRunAxis}): where a trim mesh's U grows, and the axis a mirrored case mirrors it across
 * when its run is x.
 */
export function meshRunAxis(caseId: string, rotation: number): 0 | 1 | 2 {
  const m = CUBE_ROTATIONS[rotation]!;
  const row = pieceRunAxis(caseId) * 3;
  return m[row] !== 0 ? 0 : m[row + 1] !== 0 ? 1 : 2;
}

/**
 * How a piece flagged `half` (derived-mesh.ts INSTANCE_FLAG) is drawn, in its case's own orientation: the half of its
 * run on the case's +x side. `x`: a piece running along x (ridge, eave, verge) keeps x from 0 to +½ cell, squeezed
 * along x only (its profile kept). `diagonal`: a hip or valley, running from the cell's +x, +z corner at the voxel's
 * top (+½ cell) up to the −x, −z corner a cell higher, keeps the low half: squeezed along that line to half about its
 * low end, its profile across the line kept. null: the case has no half.
 */
export function pieceHalfRun(caseId: string): 'x' | 'diagonal' | null {
  if (caseId === 'roof-hip' || caseId === 'roof-valley') return 'diagonal';
  return caseId === 'roof-ridge' || caseId === 'roof-eave' || caseId === 'roof-gable' ? 'x' : null;
}

/** Salt that keeps the stagger's hash apart from the mesh pick's (piece-table.ts pieceVariant). */
const STAGGER_SALT = 0x27d4eb2f;

/**
 * An instance's stagger: how far it moves into the solid (cells of its level, {@link PIECE_STAGGER} bounds times
 * the kit's `jitter`) and its twist (radians, signed). `seed` is the table's (the project's piece seed), (x, y, z)
 * the cell in level-0 cells, `slot` the instance's case index << 4 | placement << 2 | yaw (as its mesh pick's),
 * `reach` its frame's.
 */
export function pieceStagger(seed: number, x: number, y: number, z: number, level: number, slot: number, reach: number, jitter = PIECE_JITTER_DEFAULT): { inward: number; twist: number } {
  const h = latticeHash4(x, y, z, (seed ^ STAGGER_SALT) + Math.imul(level, 0x9e3779b9) + Math.imul(slot, 0x85ebca6b)) >>> 0;
  const inward = jitter * (PIECE_STAGGER.inwardMin + ((h & 0xffff) / 0xffff) * (PIECE_STAGGER.inwardMax - PIECE_STAGGER.inwardMin));
  // A twist t lifts the piece's ends by reach × sin t off a face; the move into the solid hides up to `inward`.
  const limit = Math.min(jitter * PIECE_STAGGER.twistMax, Math.asin(Math.min(1, inward / reach)));
  const twist = ((h >>> 16) / 0xffff) * 2 * limit - limit;
  return { inward, twist };
}
