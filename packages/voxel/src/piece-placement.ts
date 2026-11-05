/**
 * Where a detail piece sits in its case's own orientation, as a renderer
 * needs it beyond the instance's turns and placement: the axis its run
 * follows (a world-anchored texture U runs along it) and its **stagger**.
 *
 * **Stagger.** Edge and corner pieces are drawn one a 0.5 m lattice edge, so
 * a long wall's rim would read as a ruled line. Each instance is moved a
 * little into the solid along its edge's bisector and twisted a little about
 * that bisector, by a hash of its world cell, level, kit seed and slot (its
 * case, placement and yaw), so it is the same on every load and on every
 * renderer, and an edit elsewhere never moves it. It moves *into* the
 * solid, never out: an outer strip sinks into its two faces and a cove into
 * the walls it fills, so no gap ever opens between a piece and its faces;
 * the twist is held below what the move hides (a strip end never lifts off
 * a face). Stagger is drawing only: collision, light and navigation never
 * read pieces. Roof-edge, debris and beam/banister pieces are not staggered
 * (their boards and rubble have no rim to break up).
 */
import { latticeHash4 } from '@thirdlight/shared';

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

/**
 * The staggered cases' frames, in each case's own orientation (kit-case-catalogue.ts: the open side toward +z, a
 * vertical edge or corner toward +x and +z, up +y). An inner edge's "solid" is its owner's side: the cove moves into
 * the walls it lies against.
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
});

/** The vertical edge cases: their run is along y in their own orientation (every other case runs along x). */
const VERTICAL_RUN = new Set(['edge-out-vertical', 'edge-in-vertical']);

/** The axis a case's piece runs along in its own orientation (0 x, 1 y): where a world-anchored texture U grows. */
export function pieceRunAxis(caseId: string): 0 | 1 {
  return VERTICAL_RUN.has(caseId) ? 1 : 0;
}

/** Salt that keeps the stagger's hash apart from the variant's (piece-table.ts pieceVariant). */
const STAGGER_SALT = 0x27d4eb2f;

/**
 * An instance's stagger: how far it moves into the solid (cells of its level, {@link PIECE_STAGGER} bounds) and
 * its twist (radians, signed). (x, y, z) is the cell in level-0 cells, `slot` the instance's case index << 4 |
 * placement << 2 | yaw (as its variant's), `reach` its frame's.
 */
export function pieceStagger(seed: number, x: number, y: number, z: number, level: number, slot: number, reach: number): { inward: number; twist: number } {
  const h = latticeHash4(x, y, z, (seed ^ STAGGER_SALT) + Math.imul(level, 0x9e3779b9) + Math.imul(slot, 0x85ebca6b)) >>> 0;
  const inward = PIECE_STAGGER.inwardMin + ((h & 0xffff) / 0xffff) * (PIECE_STAGGER.inwardMax - PIECE_STAGGER.inwardMin);
  // A twist t lifts the piece's ends by reach × sin t off a face; the move into the solid hides up to `inward`.
  const limit = Math.min(PIECE_STAGGER.twistMax, Math.asin(Math.min(1, inward / reach)));
  const twist = ((h >>> 16) / 0xffff) * 2 * limit - limit;
  return { inward, twist };
}
