/**
 * The case catalogue: **DRAFT — not the role spec's v1.** It is the source
 * the role spec draft (`docs/architecture/voxel-role-spec.md`) is written
 * from, and stays a draft until the owner approves that spec; nothing
 * builds on its case list as final before then.
 *
 * Every case is written in its own orientation: the exposed face looks
 * toward +z ("front"), a run follows x, up is +y. A rule's cells are
 * `[dx, dy, dz, accepts]` in that orientation; the matcher tries them under
 * every turn and mirror. Priorities: enclosed 100, inferred features
 * 60–90, role shapes 45–80; a cell no rule matches takes its role's
 * fallback (the plain case: the base surface alone, or the kit's generic
 * piece).
 *
 * The inferred features (beam, banister, soffit, moulding, running board,
 * foundation skirt) are cases of the stored roles, read from the
 * arrangement: nothing stores them.
 */
import { CELL, notCell, type CaseCatalogueDef, type CaseDef, type CaseRule, type CaseRuleCell } from './kit-cases';
import { VOXEL_ROLE } from './record';

const R = VOXEL_ROLE;
const { air: A, open: O, opening: OP, ground: G, built: B, solid: S } = CELL;
const BUILT_CASE_ROLES = [R.wall, R.floor, R.roof, R.foundation, R.stair, R.pillar];

/** A case's base and declared shape: kept whole cells unless said otherwise (case-forms.ts). */
type Form = Pick<CaseDef, 'base' | 'shape'>;
const BODY: Form = { base: 'keep', shape: 'box' };
const GAP: Form = { base: 'keep', shape: 'none' };
const c = (id: string, roles: readonly number[], run: CaseDef['run'], required: boolean, note: string, feature?: CaseDef['feature'], form: Form = BODY): CaseDef => (feature === undefined ? { id, roles, run, required, ...form, note } : { id, roles, run, required, ...form, note, feature });
const r = (id: string, priority: number, cells: readonly CaseRuleCell[], roles?: readonly number[]): CaseRule => (roles === undefined ? { case: id, priority, cells } : { case: id, priority, cells, roles });

/** The four sides of the centre, level with it. */
const SIDES_OPEN: CaseRuleCell[] = [[1, 0, 0, O], [-1, 0, 0, O], [0, 0, 1, O], [0, 0, -1, O]];
/** A rail where rails meet: open above, on a support, no cell beside it diagonally (rails one cell thin). */
const RAIL_MEET: CaseRuleCell[] = [[0, 1, 0, O], [0, -1, 0, S], [1, 0, 1, O], [1, 0, -1, O], [-1, 0, 1, O], [-1, 0, -1, O]];
/** The six faces of the centre covered by solid cells. */
const ENCLOSED: CaseRuleCell[] = [[1, 0, 0, S], [-1, 0, 0, S], [0, 1, 0, S], [0, -1, 0, S], [0, 0, 1, S], [0, 0, -1, S]];

const cases: CaseDef[] = [
  c('enclosed', BUILT_CASE_ROLES, null, false, 'no face open: nothing shows, no piece'),
  // wall
  c('wall-plain', [R.wall], null, true, 'an exposed wall face with no edge in reach (fallback): the base surface'),
  c('wall-thin', [R.wall], 'x', false, 'a one-cell-thick wall, open in front and behind: the piece dresses both faces'),
  c('wall-top', [R.wall], 'x', true, 'the top edge of a wall: a coping cap'),
  c('wall-end', [R.wall], 'y', true, 'the free end of a one-cell-thick wall'),
  c('wall-corner', [R.wall], 'y', true, 'an outside vertical corner'),
  c('wall-base', [R.wall], 'x', false, 'the foot of a wall on ground, a foundation or a floor: a plinth'),
  c('wall-jamb', [R.wall], 'y', true, 'beside an opening: the frame side'),
  c('wall-lintel', [R.wall], 'x', true, 'over an opening'),
  c('wall-sill', [R.wall], 'x', true, 'under an opening'),
  c('beam', [R.wall, R.floor], 'x', true, 'one cell out from a wall body, open above and below', 'beam', { base: 'suppress', shape: 'bar' }),
  c('banister-rail', [R.wall], 'x', true, 'a low thin run, open above: on a post, between posts or on a wider support', 'banister', { base: 'suppress', shape: 'panel' }),
  c('banister-post', [R.wall, R.pillar], null, true, 'thin both ways on a support, under a rail', 'banister', { base: 'suppress', shape: 'post' }),
  c('running-board', [R.wall], 'x', false, 'the outside of a wall where a floor meets it inside: the storey line', 'running-board'),
  c('moulding', [R.wall], 'x', false, 'a wall face under a ceiling: the moulding in the corner', 'moulding'),
  // floor
  c('floor-plain', [R.floor], null, true, 'a floor with no edge in reach (fallback): the base surface'),
  c('floor-edge', [R.floor], 'x', true, 'the exposed edge of a floor slab'),
  c('floor-corner', [R.floor], null, true, 'an outside corner of a floor slab'),
  c('soffit', [R.floor, R.roof], 'x', false, 'the underside of a projecting edge: open below and in front (its underside raised to half the cell)', 'soffit', { base: 'reshape', shape: 'slab' }),
  // roof
  c('roof-plain', [R.roof], null, true, 'a roof cell with no slope or edge in reach (fallback)'),
  c('roof-peak', [R.roof], null, true, 'open on all four sides and above: the top of a pyramid or a spire'),
  c('roof-ridge', [R.roof], 'x', true, 'the top of two slopes meeting'),
  c('roof-hip', [R.roof], null, true, 'an outside corner of two slopes'),
  c('roof-valley', [R.roof], null, true, 'an inside corner of two slopes'),
  c('roof-verge', [R.roof], null, true, 'the end of a slope at a gable: the verge'),
  c('roof-eave', [R.roof], 'x', true, 'the lowest step of a slope: the eave with its fascia'),
  c('roof-slope', [R.roof], 'x', true, 'a 45° step of the stair pattern under the roof role'),
  c('roof-edge', [R.roof], 'x', true, 'the edge of a flat roof'),
  // foundation
  c('foundation-plain', [R.foundation], null, true, 'a foundation with no exposed edge in reach (fallback)'),
  c('foundation-skirt', [R.foundation], 'x', true, 'an exposed foundation face meeting the ground in front', 'foundation-skirt'),
  c('foundation-corner', [R.foundation], null, true, 'an outside corner of a foundation'),
  c('foundation-edge', [R.foundation], 'x', true, 'an exposed foundation face clear of the ground'),
  // stair
  c('stair-plain', [R.stair], null, true, 'a stair cell off the step pattern (fallback): a landing'),
  c('stair-step', [R.stair], 'x', true, 'a step of the 45° stair pattern under the stair role'),
  c('stair-side', [R.stair], null, true, 'a step at the open side of a flight: the stringer'),
  // pillar
  c('pillar-plain', [R.pillar], null, true, 'a pillar against other cells (fallback)'),
  c('pillar-single', [R.pillar], null, true, 'a free pillar one cell high'),
  c('pillar-base', [R.pillar], null, true, 'the foot of a free pillar'),
  c('pillar-capital', [R.pillar], null, true, 'the head of a free pillar'),
  c('pillar-shaft', [R.pillar], 'y', true, 'the middle of a free pillar'),
  // opening
  c('opening-plain', [R.opening], null, true, 'inside a larger opening (fallback): no frame in reach', undefined, GAP),
  c('opening-single', [R.opening], null, true, 'a one-cell opening framed on four sides', undefined, GAP),
  c('opening-threshold', [R.opening], 'x', true, 'the bottom of an opening on a floor or ground: a door', undefined, GAP),
  c('opening-sill', [R.opening], 'x', true, 'the bottom of an opening on a wall: a window', undefined, GAP),
  c('opening-head', [R.opening], 'x', true, 'the top of an opening', undefined, GAP),
  c('opening-jamb', [R.opening], 'y', true, 'the side of an opening', undefined, GAP),
];

const rules: CaseRule[] = [
  r('enclosed', 100, ENCLOSED),
  // Inferred features, read from the arrangement as the placeholder rules read beams and rails.
  r('beam', 90, [[0, 1, 0, O], [0, -1, 0, O], [0, 0, -1, B], [0, 1, -1, B], [0, -1, -1, B], [0, 0, 1, O]]),
  // A beam round a wall's inside corner (walls behind and to the left) and round its outside corner (the wall diagonally behind).
  r('beam', 90, [[0, 1, 0, O], [0, -1, 0, O], [0, 0, -1, B], [0, 1, -1, B], [0, -1, -1, B], [-1, 0, 0, B], [-1, 1, 0, B], [-1, -1, 0, B], [1, 0, 0, B], [0, 0, 1, B], [1, 1, 0, O], [1, -1, 0, O], [0, 1, 1, O], [0, -1, 1, O]]),
  r('beam', 90, [[0, 1, 0, O], [0, -1, 0, O], [-1, 0, -1, B], [-1, 1, -1, B], [-1, -1, -1, B], [-1, 0, 0, B], [0, 0, -1, B], [-1, 1, 0, O], [-1, -1, 0, O], [0, 1, -1, O], [0, -1, -1, O], [1, 0, 0, O], [0, 0, 1, O]]),
  r('banister-post', 88, [...SIDES_OPEN, [0, -1, 0, S], [0, 1, 0, B], [0, 1, 1, O], [0, 1, -1, O], [0, 2, 0, O]]),
  // A rail: thin across z, open above; on a post, spanning one open cell between posts, or on a support wider than it.
  r('banister-rail', 86, [[0, 0, 1, O], [0, 0, -1, O], [0, 1, 0, O], [0, -1, 0, B], [1, -1, 0, O], [-1, -1, 0, O], [0, -1, 1, O], [0, -1, -1, O], [0, -2, 0, S]]),
  r('banister-rail', 86, [[0, 0, 1, O], [0, 0, -1, O], [0, 1, 0, O], [0, -1, 0, O], [0, -2, 0, S]]),
  r('banister-rail', 86, [[0, 0, 1, O], [0, 0, -1, O], [0, 1, 0, O], [0, -1, 0, S], [0, -1, 1, S]]),
  // Where thin rails on a wider support meet: an L, a T and a cross (the rail's sections turn or branch there).
  r('banister-rail', 86, [...RAIL_MEET, [1, 0, 0, B], [0, 0, 1, B], [-1, 0, 0, O], [0, 0, -1, O], [1, 1, 0, O], [0, 1, 1, O], [-1, -1, 0, S], [0, -1, -1, S]]),
  r('banister-rail', 86, [...RAIL_MEET, [1, 0, 0, B], [-1, 0, 0, B], [0, 0, 1, B], [0, 0, -1, O], [1, 1, 0, O], [-1, 1, 0, O], [0, 1, 1, O], [0, -1, -1, S]]),
  r('banister-rail', 86, [...RAIL_MEET, [1, 0, 0, B], [-1, 0, 0, B], [0, 0, 1, B], [0, 0, -1, B], [1, 1, 0, O], [-1, 1, 0, O], [0, 1, 1, O], [0, 1, -1, O], [1, -1, 1, S]]),
  r('running-board', 70, [[0, 0, 1, A], [0, 0, -1, CELL.floor], [0, 1, 0, CELL.wall], [0, -1, 0, CELL.wall]]),
  // The outside corner of the storey line: the floor meets the corner diagonally inside.
  r('running-board', 70, [[0, 0, 1, A], [1, 0, 0, A], [-1, 0, -1, CELL.floor], [0, 1, 0, CELL.wall], [0, -1, 0, CELL.wall]]),
  r('moulding', 68, [[0, 0, 1, A], [0, 1, 1, CELL.floor | CELL.roof], [0, 1, 0, B]]),
  r('soffit', 60, [[0, -1, 0, A], [0, 0, 1, A], [0, -1, 1, A]]),
  r('foundation-skirt', 70, [[0, 0, 1, O], [0, -1, 1, G]]),
  // wall
  // Jambs, lintels and sills name their front: the opening beside, above or below alone leaves the piece's face free to
  // turn into the wall (in a wall two cells thick, into the other layer).
  r('wall-jamb', 65, [[1, 0, 0, OP], [0, 0, 1, O]]),
  r('wall-lintel', 64, [[0, -1, 0, OP], [0, 0, 1, O]]),
  r('wall-sill', 63, [[0, 1, 0, OP], [0, 0, 1, O]]),
  r('wall-end', 55, [[0, 0, 1, O], [0, 0, -1, O], [1, 0, 0, O], [-1, 0, 0, S]]),
  r('wall-corner', 54, [[0, 0, 1, O], [1, 0, 0, O], [1, 0, 1, O]]),
  r('wall-top', 50, [[0, 1, 0, A], [0, 0, 1, O]]),
  r('wall-base', 45, [[0, 0, 1, O], [0, -1, 0, G | CELL.foundation | CELL.floor], [0, -1, 1, S]]),
  // The plain wall's front on an exposed side face: without it the fallback took the key's fold, whose front may face
  // along the wall, into the next cell (a piece hidden in the wall or standing across its face).
  // A one-cell-thick wall shows both faces: a piece on one face only would leave the other bare, and which one it
  // took would flip wherever the window changes (beside a corner or an opening). Above the plinth, so a thin wall's
  // foot is dressed on both faces too (a one-sided plinth is the same flip).
  r('wall-thin', 46, [[0, 0, 1, O], [0, 0, -1, O]]),
  r('wall-plain', 1, [[0, 0, 1, O]]),
  // floor
  r('floor-corner', 52, [[0, 0, 1, O], [1, 0, 0, O]]),
  r('floor-edge', 50, [[0, 0, 1, O]]),
  // roof: the 45° stair pattern; steps up toward −z.
  r('roof-peak', 80, [...SIDES_OPEN.map(([x, y, z]) => [x, y, z, A] as CaseRuleCell), [0, 1, 0, A]]),
  r('roof-ridge', 78, [[0, 1, 0, A], [0, 0, 1, A], [0, 0, -1, A], [0, -1, 1, CELL.roof], [0, -1, -1, CELL.roof]]),
  r('roof-hip', 76, [[0, 1, 0, A], [1, 0, 0, A], [0, 0, 1, A], [-1, 0, 0, CELL.roof], [0, 0, -1, CELL.roof], [-1, 1, -1, CELL.roof]]),
  r('roof-valley', 75, [[0, 1, 0, A], [1, 0, 1, A], [1, 0, 0, CELL.roof], [0, 0, 1, CELL.roof], [-1, 1, 0, CELL.roof], [0, 1, -1, CELL.roof]]),
  r('roof-verge', 72, [[0, 1, 0, A], [0, 0, 1, A], [1, 0, 0, A], [0, 1, -1, CELL.roof], [-1, 0, 0, CELL.roof]]),
  r('roof-eave', 70, [[0, 1, 0, A], [0, 0, 1, A], [0, 1, -1, CELL.roof], [0, -1, 1, notCell(CELL.roof)]]),
  r('roof-slope', 68, [[0, 1, 0, A], [0, 0, 1, A], [0, 1, -1, CELL.roof], [0, -1, 1, CELL.roof]]),
  r('roof-slope', 67, [[0, 1, 0, A], [0, 0, 1, A], [0, -1, 1, CELL.roof]]),
  r('roof-edge', 50, [[0, 1, 0, A], [0, 0, 1, A]]),
  // foundation
  r('foundation-corner', 55, [[0, 0, 1, O], [1, 0, 0, O]]),
  r('foundation-edge', 50, [[0, 0, 1, O]]),
  // stair: steps up toward −z.
  r('stair-side', 62, [[0, 1, 0, A], [0, 0, 1, A], [1, 0, 0, A], [0, 1, -1, CELL.stair]]),
  r('stair-side', 62, [[0, 1, 0, A], [0, 0, 1, A], [1, 0, 0, A], [0, -1, 1, CELL.stair]]),
  r('stair-step', 60, [[0, 1, 0, A], [0, 0, 1, A], [0, 1, -1, CELL.stair]]),
  r('stair-step', 60, [[0, 1, 0, A], [0, 0, 1, A], [0, -1, 1, CELL.stair]]),
  // pillar
  r('pillar-single', 60, [...SIDES_OPEN, [0, 1, 0, notCell(CELL.pillar)], [0, -1, 0, notCell(CELL.pillar)]]),
  r('pillar-base', 58, [...SIDES_OPEN, [0, 1, 0, CELL.pillar], [0, -1, 0, notCell(CELL.pillar)]]),
  r('pillar-capital', 58, [...SIDES_OPEN, [0, -1, 0, CELL.pillar], [0, 1, 0, notCell(CELL.pillar)]]),
  r('pillar-shaft', 55, [...SIDES_OPEN, [0, 1, 0, CELL.pillar], [0, -1, 0, CELL.pillar]]),
  // opening: its frame is the solid around it in its plane (x, y); front and back are open.
  r('opening-single', 60, [[0, 1, 0, S], [0, -1, 0, S], [1, 0, 0, S], [-1, 0, 0, S]]),
  // Bottoms, tops and sides name their front as air: beside another opening cell the frame would otherwise turn across the wall.
  r('opening-threshold', 58, [[0, -1, 0, G | CELL.floor | CELL.foundation | CELL.stair], [0, 0, 1, A]]),
  r('opening-sill', 56, [[0, -1, 0, S], [0, 0, 1, A]]),
  r('opening-head', 54, [[0, 1, 0, S], [0, 0, 1, A]]),
  r('opening-jamb', 52, [[1, 0, 0, S], [0, 0, 1, A]]),
];

/** The draft catalogue (see the file comment: DRAFT — not v1, the role spec draft's source). */
export const DRAFT_CASE_CATALOGUE: CaseCatalogueDef = Object.freeze({
  id: 'cases-draft',
  version: 5,
  draft: true,
  cases,
  rules,
  fallback: {
    [R.wall]: 'wall-plain',
    [R.floor]: 'floor-plain',
    [R.roof]: 'roof-plain',
    [R.foundation]: 'foundation-plain',
    [R.stair]: 'stair-plain',
    [R.pillar]: 'pillar-plain',
    [R.opening]: 'opening-plain',
  },
});
