/**
 * The edge case catalogue: **DRAFT — not the role spec's v1.** Walls,
 * floors, stairs, pillars, foundations and flat roofs are plain voxel faces
 * and get no case of their own; a detail piece goes only where faces meet.
 * Its 20 cases come from four passes:
 *
 * - **edges and corners** (edge-cases.ts): per 0.5 m lattice edge and lattice
 *   corner, from the 4 or 8 cells round it, 10 cases with a yaw;
 * - **roof edges**: ridge, eave, gable edge (verge), hip and valley of a
 *   sloped roof's planes, written by the roof mesher;
 * - **debris**: a construction cell whose integrity (its shape) is below
 *   intact, and the intact faces opening toward it;
 * - **beams and banisters**, kept as built: inferred from the arrangement by
 *   the case window's rules (kit-cases.ts), with their run sections.
 *
 * Every case is written in its own orientation: the open side toward +z (a
 * vertical edge or a corner: +x and +z), a run along x, up +y. Only the
 * beam and banister cases have window rules; no other cell matches one, and
 * no role has a fallback case, so a cell that is not a beam or banister
 * carries no window case and shows its base surface. Nothing stores a case.
 */
import { EDGE_CASE_IDS } from './edge-cases';
import { CASE_ROLES, CELL, type CaseCatalogueDef, type CaseDef, type CaseRule, type CaseRuleCell } from './kit-cases';
import { CONSTRUCTION_ROLES, VOXEL_ROLE } from './record';

const R = VOXEL_ROLE;
const { open: O, built: B, solid: S } = CELL;

/** Cases a pass writes: whole cells keep their base and the box. */
const kept = (id: string, roles: readonly number[], required: boolean, note: string): CaseDef => ({ id, roles, run: null, required, base: 'keep', shape: 'box', note });

/** The edge pass's cases, one line each (in {@link EDGE_CASE_IDS} order). */
const EDGE_NOTES: Readonly<Record<(typeof EDGE_CASE_IDS)[number], readonly [required: boolean, note: string]>> = {
  'edge-out-top': [true, 'outer edge, the solid cell below it: a wall top, a stair nosing, a floor edge'],
  'edge-out-vertical': [true, 'outer vertical edge: an outside wall corner, a jamb'],
  'edge-out-bottom': [true, 'outer edge, the solid cell above it: a lintel underside, an overhang'],
  'edge-in-top': [false, 'inner edge, the open cell below it: wall meets ceiling'],
  'edge-in-vertical': [false, 'inner vertical edge: an inside wall corner'],
  'edge-in-bottom': [false, 'inner edge, the open cell above it: wall meets floor, a riser foot'],
  'corner-out-top': [true, 'outer corner, the solid cell below it: a box top corner'],
  'corner-out-bottom': [true, 'outer corner, the solid cell above it: a box bottom corner'],
  'corner-in-top': [false, 'inner corner, the open cell below it'],
  'corner-in-bottom': [false, 'inner corner, the open cell above it'],
};

/** Beam and banister cases, inferred from the arrangement (also the source of the superseded draft's). */
export const BEAM_BANISTER_CASES: readonly CaseDef[] = Object.freeze([
  { id: 'beam', roles: [R.wall, R.floor], run: 'x', required: true, base: 'suppress', shape: 'bar', note: 'one cell out from a wall body, open above and below', feature: 'beam' },
  { id: 'banister-rail', roles: [R.wall], run: 'x', required: true, base: 'suppress', shape: 'panel', note: 'a low thin run, open above: on a post, between posts or on a wider support', feature: 'banister' },
  { id: 'banister-post', roles: [R.wall, R.pillar], run: null, required: true, base: 'suppress', shape: 'post', note: 'thin both ways on a support, under a rail', feature: 'banister' },
]);

const rule = (id: string, priority: number, cells: readonly CaseRuleCell[]): CaseRule => ({ case: id, priority, cells });
/** The four sides of the centre, level with it. */
export const SIDES_OPEN: CaseRuleCell[] = [[1, 0, 0, O], [-1, 0, 0, O], [0, 0, 1, O], [0, 0, -1, O]];
/** A rail where rails meet: open above, on a support, no cell beside it diagonally (rails one cell thin). */
const RAIL_MEET: CaseRuleCell[] = [[0, 1, 0, O], [0, -1, 0, S], [1, 0, 1, O], [1, 0, -1, O], [-1, 0, 1, O], [-1, 0, -1, O]];

/** The beam and banister rules, read from the arrangement (in priority order). */
export const BEAM_BANISTER_RULES: readonly CaseRule[] = Object.freeze([
  rule('beam', 90, [[0, 1, 0, O], [0, -1, 0, O], [0, 0, -1, B], [0, 1, -1, B], [0, -1, -1, B], [0, 0, 1, O]]),
  // A beam round a wall's inside corner (walls behind and to the left) and round its outside corner (the wall diagonally behind).
  rule('beam', 90, [[0, 1, 0, O], [0, -1, 0, O], [0, 0, -1, B], [0, 1, -1, B], [0, -1, -1, B], [-1, 0, 0, B], [-1, 1, 0, B], [-1, -1, 0, B], [1, 0, 0, B], [0, 0, 1, B], [1, 1, 0, O], [1, -1, 0, O], [0, 1, 1, O], [0, -1, 1, O]]),
  rule('beam', 90, [[0, 1, 0, O], [0, -1, 0, O], [-1, 0, -1, B], [-1, 1, -1, B], [-1, -1, -1, B], [-1, 0, 0, B], [0, 0, -1, B], [-1, 1, 0, O], [-1, -1, 0, O], [0, 1, -1, O], [0, -1, -1, O], [1, 0, 0, O], [0, 0, 1, O]]),
  rule('banister-post', 88, [...SIDES_OPEN, [0, -1, 0, S], [0, 1, 0, B], [0, 1, 1, O], [0, 1, -1, O], [0, 2, 0, O]]),
  // A rail: thin across z, open above; on a post, spanning one open cell between posts, or on a support wider than it.
  rule('banister-rail', 86, [[0, 0, 1, O], [0, 0, -1, O], [0, 1, 0, O], [0, -1, 0, B], [1, -1, 0, O], [-1, -1, 0, O], [0, -1, 1, O], [0, -1, -1, O], [0, -2, 0, S]]),
  rule('banister-rail', 86, [[0, 0, 1, O], [0, 0, -1, O], [0, 1, 0, O], [0, -1, 0, O], [0, -2, 0, S]]),
  rule('banister-rail', 86, [[0, 0, 1, O], [0, 0, -1, O], [0, 1, 0, O], [0, -1, 0, S], [0, -1, 1, S]]),
  // Where thin rails on a wider support meet: an L, a T and a cross (the rail's sections turn or branch there).
  rule('banister-rail', 86, [...RAIL_MEET, [1, 0, 0, B], [0, 0, 1, B], [-1, 0, 0, O], [0, 0, -1, O], [1, 1, 0, O], [0, 1, 1, O], [-1, -1, 0, S], [0, -1, -1, S]]),
  rule('banister-rail', 86, [...RAIL_MEET, [1, 0, 0, B], [-1, 0, 0, B], [0, 0, 1, B], [0, 0, -1, O], [1, 1, 0, O], [-1, 1, 0, O], [0, 1, 1, O], [0, -1, -1, S]]),
  rule('banister-rail', 86, [...RAIL_MEET, [1, 0, 0, B], [-1, 0, 0, B], [0, 0, 1, B], [0, 0, -1, B], [1, 1, 0, O], [-1, 1, 0, O], [0, 1, 1, O], [0, 1, -1, O], [1, -1, 1, S]]),
]);

const cases: CaseDef[] = [
  ...EDGE_CASE_IDS.map((id) => kept(id, CONSTRUCTION_ROLES, EDGE_NOTES[id][0], EDGE_NOTES[id][1])),
  kept('roof-ridge', [R.roof], true, 'the top line of two roof planes meeting'),
  kept('roof-eave', [R.roof], true, 'the lowest edge of a roof plane'),
  kept('roof-gable', [R.roof], true, 'the sloped end of a roof plane at a gable: the verge'),
  kept('roof-hip', [R.roof], true, 'an outside corner line of two roof planes'),
  kept('roof-valley', [R.roof], false, 'an inside corner line of two roof planes'),
  kept('debris', CONSTRUCTION_ROLES, false, 'a damaged cell (integrity below intact), drawn by its stage'),
  kept('debris-face', CONSTRUCTION_ROLES, false, 'an intact face opening toward a damaged cell: its broken edge'),
  ...BEAM_BANISTER_CASES,
];

/** No role has a fallback case: a cell no window rule matches carries none. */
const NO_FALLBACK = Object.freeze(Object.fromEntries(CASE_ROLES.map((r) => [r, null])));

/** The edge catalogue (see the file comment: DRAFT — not v1). */
export const EDGE_CASE_CATALOGUE: CaseCatalogueDef = Object.freeze({
  id: 'edges-draft',
  version: 0,
  draft: true,
  cases,
  rules: BEAM_BANISTER_RULES,
  fallback: NO_FALLBACK,
});
