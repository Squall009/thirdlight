/**
 * The engine's default fallback kit: procedural pieces made from a few
 * boxes, so a world whose materials no game kit binds still draws its
 * edges, trims and frames (copings, plinths, sills, mouldings, running
 * boards, skirts, ridge caps, opening frames) instead of bare voxel faces.
 * It is engine-owned test-quality art, generated in code from the table
 * below: no files, nothing to import, the same in every build.
 *
 * **Every catalogue case has an answer here** ({@link DEFAULT_KIT_PIECES}):
 * a piece, or `null` where the cell is drawn without one of this kit's
 * pieces: by the base surface (plain faces, slopes, the reshaped soffit,
 * an enclosed cell), or, where the case leaves its base to a piece (beams,
 * banister rails and posts), by the engine's default pieces, the stand-in
 * families with their run sections (piece-table.ts, below
 * `KIT_PIECE_BASE`), which every kit falls back to.
 *
 * A piece is written in its case's own orientation (kit-case-catalogue.ts:
 * the exposed face toward +z, a run along x, up +y), in sixteenths of a
 * cell from the cell's corner; boxes may reach a little past the cell
 * (a coping overhangs, a plinth stands proud of the face). Only the body
 * section is given: every other run section falls back to it, so runs meet
 * end to end at the cell faces. A renderer turns, mirrors and scales the
 * boxes as it does a kit's own meshes.
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

/** A strip along the front face (+z) between heights y0 and y1, standing `out` sixteenths proud of it. */
const frontStrip = (y0: number, y1: number, out: number, back = 0): DefaultKitBox => [0, y0, DEFAULT_KIT_UNITS - back, DEFAULT_KIT_UNITS, y1, DEFAULT_KIT_UNITS + out];

/**
 * Per catalogue case id: the default piece, or null (see the file comment).
 * A test checks this lists exactly the catalogue's cases.
 */
export const DEFAULT_KIT_PIECES: Readonly<Record<string, DefaultKitPiece | null>> = Object.freeze({
  enclosed: null,
  'wall-plain': null,
  'wall-top': piece('a coping cap over the wall top, overhanging the face', [0, 14, 1, 16, 17, 17]),
  'wall-end': piece('an end board up the free end (+x)', [16, 0, 2, 17, 16, 14]),
  'wall-corner': piece('a corner post up the outside corner (+x, +z)', [14, 0, 14, 17, 16, 17]),
  'wall-base': piece('a plinth at the foot of the face', frontStrip(0, 3, 2, 1)),
  'wall-jamb': piece('a frame board beside the opening (+x)', [13, 0, 15, 16, 16, 18]),
  'wall-lintel': piece('a header over the opening below', frontStrip(0, 3, 2, 1)),
  'wall-sill': piece('a sill ledge under the opening above', frontStrip(13, 16, 3, 1)),
  beam: null,
  'banister-rail': null,
  'banister-post': null,
  'running-board': piece('a board along the storey line', frontStrip(6, 10, 2, 1)),
  moulding: piece('a moulding under the ceiling', frontStrip(13, 16, 2, 1)),
  'floor-plain': null,
  'floor-edge': piece('a band along the slab edge', frontStrip(12, 16, 1, 1)),
  'floor-corner': piece('the band round the outside corner', [0, 12, 15, 17, 16, 17], [15, 12, 0, 17, 16, 15]),
  soffit: null,
  'roof-plain': null,
  'roof-peak': piece('a finial on the peak', [6, 16, 6, 10, 22, 10]),
  'roof-ridge': piece('a ridge cap along the top', [0, 15, 4, 16, 18, 12]),
  'roof-hip': null,
  'roof-valley': null,
  'roof-verge': piece('a barge board at the gable end (+x)', [16, 6, 0, 17, 17, 17]),
  'roof-eave': piece('a fascia board under the eave', frontStrip(0, 6, 1, 1)),
  'roof-slope': null,
  'roof-edge': piece('a curb along the flat roof edge', frontStrip(14, 18, 1, 1)),
  'foundation-plain': null,
  'foundation-skirt': piece('a skirt where the foundation meets the ground', frontStrip(0, 4, 2, 1)),
  'foundation-corner': piece('a quoin up the outside corner', [14, 0, 14, 17, 16, 17]),
  'foundation-edge': piece('a band under the top of the exposed face', frontStrip(12, 15, 1, 1)),
  'stair-plain': null,
  'stair-step': piece('a nosing on the step', frontStrip(14, 16, 1, 2)),
  'stair-side': piece('a stringer on the open side (+x)', [16, 0, 0, 17, 16, 16]),
  'pillar-plain': null,
  'pillar-single': piece('a plinth and a cap', [-1, 0, -1, 17, 3, 17], [-1, 13, -1, 17, 16, 17]),
  'pillar-base': piece('a plinth at the foot', [-1, 0, -1, 17, 3, 17]),
  'pillar-capital': piece('a cap at the head', [-1, 13, -1, 17, 16, 17]),
  'pillar-shaft': null,
  'opening-plain': null,
  'opening-single': piece('a frame on four sides', [0, 0, 4, 16, 2, 12], [0, 14, 4, 16, 16, 12], [0, 2, 4, 2, 14, 12], [14, 2, 4, 16, 14, 12]),
  'opening-threshold': piece('a threshold board', [0, 0, 3, 16, 1, 13]),
  'opening-sill': piece('a window sill', [0, 0, 3, 16, 2, 13]),
  'opening-head': piece('a head board', [0, 14, 4, 16, 16, 12]),
  'opening-jamb': piece('a jamb board (+x)', [14, 0, 4, 16, 16, 12]),
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
