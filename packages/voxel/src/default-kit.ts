/**
 * The engine's default fallback kit: procedural pieces made from a few
 * boxes, so a world whose materials no game kit binds still shows where its
 * faces meet (edges, corners, roof edges) and its debris instead of bare
 * voxel faces. It is engine-owned stand-in art, generated in code from the
 * table below: no files, nothing to import, the same in every build. These
 * are square stand-ins (a strip a little proud of the faces along an edge,
 * a cap on a corner, a few boxes of rubble); rounded bevels are its next
 * revision.
 *
 * **Every catalogue case has an answer here** ({@link DEFAULT_KIT_PIECES}):
 * a piece, or `null` where the cell is drawn without one of this kit's
 * pieces: beams, banister rails and posts are drawn by the engine's
 * default pieces, the stand-in families with their run sections
 * (piece-table.ts, below `KIT_PIECE_BASE`), which every kit falls back to.
 *
 * A piece is written in its case's own orientation (kit-case-catalogue.ts:
 * the open side toward +z, a vertical edge or corner toward +x and +z, up
 * +y), in sixteenths of a cell from the owning cell's corner; boxes reach a
 * little past the cell (an edge strip stands proud of its faces, an inner
 * edge's cove lies in the open cell beside the owner). Only the body section
 * is given: every other run section falls back to it. A renderer turns,
 * tips and scales the boxes as it does a kit's own meshes.
 */
import type { CaseCatalogueDef } from './kit-cases';
import type { PieceKitSource } from './piece-table';

/** The default kit's id: outside the project id syntax, so no project kit can take it. */
export const DEFAULT_KIT_ID = '@engine-default';

/** Sixteenths of a cell a default piece's box is written in. */
export const DEFAULT_KIT_UNITS = 16;

/** A box: [x0, y0, z0, x1, y1, z1] in sixteenths of a cell from the cell's corner, in the case's orientation. */
export type DefaultKitBox = readonly [number, number, number, number, number, number];

/** A default piece: its boxes, and why it looks like that. */
export interface DefaultKitPiece {
  readonly boxes: readonly DefaultKitBox[];
  readonly note: string;
}

const piece = (note: string, ...boxes: DefaultKitBox[]): DefaultKitPiece => Object.freeze({ note, boxes: Object.freeze(boxes) });

/**
 * Per catalogue case id: the default piece, or null (see the file comment).
 * A test checks this lists exactly the world catalogue's cases.
 */
export const DEFAULT_KIT_PIECES: Readonly<Record<string, DefaultKitPiece | null>> = Object.freeze({
  'edge-out-top': piece('a strip along the top edge, proud of both faces', [0, 14, 14, 16, 17, 17]),
  'edge-out-vertical': piece('a strip up the outside corner', [14, 0, 14, 17, 16, 17]),
  'edge-out-bottom': piece('a strip along the underside edge', [0, -1, 14, 16, 2, 17]),
  'edge-in-top': piece('a cove where the wall meets the ceiling, in the open cell', [0, -2, 16, 16, 0, 18]),
  'edge-in-vertical': piece('a cove up the inside corner, in the open cell', [16, 0, 16, 18, 16, 18]),
  'edge-in-bottom': piece('a cove where the wall meets the floor, in the open cell', [0, 16, 16, 16, 18, 18]),
  'corner-out-top': piece('a cap on the top corner', [14, 14, 14, 17, 17, 17]),
  'corner-out-bottom': piece('a cap on the bottom corner', [14, -1, 14, 17, 2, 17]),
  'corner-in-top': piece('a cap in the inside corner under the ceiling', [16, -2, 16, 18, 0, 18]),
  'corner-in-bottom': piece('a cap in the inside corner on the floor', [16, 16, 16, 18, 18, 18]),
  'roof-ridge': piece('a ridge board along the side the planes meet on', [0, 15, 14, 16, 18, 18]),
  'roof-eave': piece('a fascia under the eave', [0, -1, 14, 16, 3, 17]),
  'roof-gable': piece('a barge board up the verge', [0, 0, 16, 16, 16, 17]),
  'roof-hip': piece('a cap on the hip toward the corner', [12, 12, 12, 17, 17, 17]),
  'roof-valley': piece('a board in the valley toward the corner', [12, 14, 12, 16, 17, 16]),
  debris: piece('a few blocks of rubble', [2, 0, 3, 9, 6, 10], [8, 0, 6, 14, 4, 13], [4, 5, 5, 10, 9, 11]),
  'debris-heavy': piece('a low heap of rubble', [1, 0, 1, 12, 3, 9], [6, 0, 8, 15, 2, 15]),
  'debris-face': piece('a broken rim on the face opening to the damage', [3, 3, 16, 13, 13, 17]),
  beam: null,
  'banister-rail': null,
  'banister-post': null,
});

/**
 * The default kit as the piece table reads it: one variant of the body
 * section for each case with a piece. Cases the catalogue lacks are left
 * out (a catalogue of another version may have fewer).
 */
export function defaultKitSource(catalogue: CaseCatalogueDef): PieceKitSource {
  const cases: Record<string, { sections: Record<string, { variants: { weight?: number }[] }> }> = {};
  for (const c of catalogue.cases) if (DEFAULT_KIT_PIECES[c.id] != null) cases[c.id] = { sections: { body: { variants: [{}] } } };
  return { voxelKitId: DEFAULT_KIT_ID, cases };
}
