/**
 * The edge case catalogue: **DRAFT — not the role spec's v1.** Walls,
 * floors, stairs, pillars, foundations and flat roofs are plain voxel faces
 * and get no case of their own; a detail piece goes only where faces meet.
 * Its 18 cases come from three passes:
 *
 * - **edges and corners** (edge-cases.ts): per 0.5 m lattice edge and lattice
 *   corner, from the 4 or 8 cells round it, 10 cases with a yaw;
 * - **roof edges**: ridge, eave, gable edge (verge), hip and valley of a
 *   sloped roof's planes, written by the roof mesher;
 * - **debris**: a construction cell whose integrity (its shape) is below
 *   intact, by its stage (`debris`, `debris-heavy`), and the intact faces
 *   opening toward it (`debris-face`).
 *
 * Every case is a kit's slot: its id is the slot's stable name, and a kit
 * fills it with meshes or leaves it empty (nothing drawn). Every case is
 * written in its own orientation: the open side toward +z (a vertical edge
 * or a corner: +x and +z), a run along x, up +y. The catalogue has no
 * window rules (beams and banisters, the cases a window inferred, are not
 * part of the voxel world: their cells are plain voxels) and no role has a
 * fallback case, so no cell carries a window case. Nothing stores a case.
 */
import { EDGE_CASE_IDS } from './edge-cases';
import { CASE_ROLES, type CaseCatalogueDef, type CaseDef } from './kit-cases';
import { CONSTRUCTION_ROLES, SHAPE_FULL, VOXEL_ROLE } from './record';

const R = VOXEL_ROLE;

/** Cases a pass writes: whole cells keep their base and the box. */
const kept = (id: string, roles: readonly number[], note: string): CaseDef => ({ id, roles, base: 'keep', shape: 'box', note });

/** The edge pass's cases, one line each (in {@link EDGE_CASE_IDS} order). */
const EDGE_NOTES: Readonly<Record<(typeof EDGE_CASE_IDS)[number], string>> = {
  'edge-out-top': 'outer edge, the solid cell below it: a wall top, a stair nosing, a floor edge',
  'edge-out-vertical': 'outer vertical edge: an outside wall corner, a jamb',
  'edge-out-bottom': 'outer edge, the solid cell above it: a lintel underside, an overhang',
  'edge-in-top': 'inner edge, the open cell below it: wall meets ceiling',
  'edge-in-vertical': 'inner vertical edge: an inside wall corner',
  'edge-in-bottom': 'inner edge, the open cell above it: wall meets floor, a riser foot',
  'corner-out-top': 'outer corner, the solid cell below it: a box top corner',
  'corner-out-bottom': 'outer corner, the solid cell above it: a box bottom corner',
  'corner-in-top': 'inner corner, the open cell below it',
  'corner-in-bottom': 'inner corner, the open cell above it',
};

/** The lowest integrity (shape) of the light debris stage: below it a damaged cell is drawn by `debris-heavy`. */
export const DEBRIS_LIGHT_MIN = 8;

const cases: CaseDef[] = [
  ...EDGE_CASE_IDS.map((id) => kept(id, CONSTRUCTION_ROLES, EDGE_NOTES[id])),
  kept('roof-ridge', [R.roof], 'the top line of two roof planes meeting'),
  kept('roof-eave', [R.roof], 'the lowest edge of a roof plane'),
  kept('roof-gable', [R.roof], 'the sloped end of a roof plane at a gable: the verge'),
  kept('roof-hip', [R.roof], 'an outside corner line of two roof planes'),
  kept('roof-valley', [R.roof], 'an inside corner line of two roof planes'),
  kept('debris', CONSTRUCTION_ROLES, `a damaged cell, integrity ${DEBRIS_LIGHT_MIN}–${SHAPE_FULL - 1}: drawn by this piece in place of its faces`),
  kept('debris-heavy', CONSTRUCTION_ROLES, `a badly damaged cell, integrity below ${DEBRIS_LIGHT_MIN}: drawn by this piece in place of its faces`),
  kept('debris-face', CONSTRUCTION_ROLES, 'an intact face opening toward a damaged cell: its broken edge'),
];

/** No role has a fallback case: a cell no window rule matches carries none. */
const NO_FALLBACK = Object.freeze(Object.fromEntries(CASE_ROLES.map((r) => [r, null])));

/** The edge catalogue (see the file comment: DRAFT — not v1). */
export const EDGE_CASE_CATALOGUE: CaseCatalogueDef = Object.freeze({
  id: 'edges-draft',
  version: 2,
  draft: true,
  cases,
  rules: [],
  fallback: NO_FALLBACK,
});
