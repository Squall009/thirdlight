import { describe, expect, it } from 'vitest';
import { BUILDING_GENERATOR, MATERIAL_AIR, recordValue, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, type StructureDefinition } from '@thirdlight/voxel';

import { addPolygon, brushCells, defaultMaterials, edgeMoveAxis, footprintMiddle, handStrokeCommand, misfitSummary, misfitWords, moveCorner, moveEdge, newStructure, rectPoints, removePolygon, snapYaw, storeysFor, structureProblem, turnedPosition, withPolygonPoints } from './structure-shape';

const MAT = { wall: 3, floor: 3, roof: 3, foundation: 3, stair: 3 };
const house = (): StructureDefinition => {
  const { world: _w, ...def } = newStructure('w', 16, 12, MAT).value;
  void _w;
  return def;
};
const v = (material: number, role: number): number => (material === MATERIAL_AIR ? 0 : recordValue(material, role, SHAPE_FULL, 0));

describe('structure shape: drawing and handles', () => {
  it('a drawn rectangle is a right-angled polygon from its minimum corner, refused below three cells a side', () => {
    expect(rectPoints([10, 4], [2, 9])).toEqual([[2, 4], [10, 4], [10, 9], [2, 9]]);
    expect(rectPoints([0, 0], [2, 9])).toBeNull();
    expect(rectPoints([0, 0], [3, 3])).not.toBeNull();
  });

  it('a new structure is anchored as the backend anchors it, so its rectangle sits `offset` cells in and the backend moves nothing', () => {
    const { value, offset } = newStructure('w', 16, 12, MAT);
    expect(offset).toBe(1);
    expect(value.footprint[0]!.points).toEqual([[1, 1], [17, 1], [17, 13], [1, 13]]);
    expect(value).toMatchObject({ world: 'w', storeys: 1, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'gable', overhang: 1, axis: 'x' }, generator: BUILDING_GENERATOR.version });
    expect(structureProblem(house())).toBeNull();
  });

  it('an edge moves across its run in whole cells and keeps the polygon right-angled; both ends move', () => {
    const p = house().footprint[0]!.points;
    // Edge 1 runs from (17, 1) to (17, 13): along z, so it moves along x.
    expect(edgeMoveAxis(p, 1)).toBe('x');
    expect(edgeMoveAxis(p, 0)).toBe('z');
    const wider = moveEdge(p, 1, 4);
    expect(wider).toEqual([[1, 1], [21, 1], [21, 13], [1, 13]]);
    expect(structureProblem(withPolygonPoints(house(), 0, wider))).toBeNull();
    // West past the anchor: negative cells are fine (nothing is translated).
    expect(moveEdge(p, 3, -3)).toEqual([[-2, 1], [17, 1], [17, 13], [-2, 13]]);
  });

  it('a corner moves its two edges; an edge pushed past its opposite is refused by the generator with its message', () => {
    const p = house().footprint[0]!.points;
    expect(moveCorner(p, 2, 2, -3)).toEqual([[1, 1], [19, 1], [19, 10], [1, 10]]);
    expect(moveCorner(p, 0, -1, 2)).toEqual([[0, 3], [17, 3], [17, 13], [0, 13]]);
    const collapsed = withPolygonPoints(house(), 0, moveEdge(p, 1, -16));
    expect(structureProblem(collapsed)).toMatch(/repeats point|straight run|cross or touch/);
  });

  it('extend adds a polygon with a new id (an L); the last polygon and one an opening stands on are not removed', () => {
    const l = addPolygon(house(), rectPoints([17, 5], [25, 13])!);
    expect(l.footprint.map((x) => x.id)).toEqual(['main', 'wing-2']);
    expect(structureProblem(l)).toBeNull();
    expect(addPolygon(l, rectPoints([0, 20], [4, 24])!).footprint.map((x) => x.id)).toEqual(['main', 'wing-2', 'wing-3']);
    expect(removePolygon(house(), 0)).toMatch(/at least one polygon/);
    const removed = removePolygon(l, 1);
    expect(typeof removed !== 'string' && removed.footprint.map((x) => x.id)).toEqual(['main']);
    const withDoor: StructureDefinition = { ...l, openings: [{ id: 'door', polygon: 'wing-2', edge: 0, storey: 0, at: 2, width: 2, height: 4, sill: 0 }] };
    expect(removePolygon(withDoor, 1)).toMatch(/holds 1 opening/);
  });

  it('openings and stairs survive a footprint edit unchanged', () => {
    const d: StructureDefinition = { ...house(), openings: [{ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 4, width: 2, height: 4, sill: 0 }] };
    const wider = withPolygonPoints(d, 0, moveEdge(d.footprint[0]!.points, 1, 4));
    expect(wider.openings).toEqual(d.openings);
    expect(wider.stairs).toEqual(d.stairs);
  });

  it('a drag up gives whole storeys, at least one', () => {
    expect(storeysFor(1, 3.1, 6)).toBe(2);
    expect(storeysFor(1, 1.4, 6)).toBe(1);
    expect(storeysFor(2, -10, 6)).toBe(1);
    expect(storeysFor(1, 6, 6)).toBe(3);
  });

  it('a turn snaps to 15° steps unless free; it turns about the footprint middle, which stays put', () => {
    expect(snapYaw((31 * Math.PI) / 180, false)).toBeCloseTo((30 * Math.PI) / 180, 12);
    expect(snapYaw((38 * Math.PI) / 180, false)).toBeCloseTo((45 * Math.PI) / 180, 12);
    expect(snapYaw(0.123, true)).toBeCloseTo(0.123, 12);
    expect(snapYaw(-0.01, false)).toBe(0);
    const place = { gridId: 1, position: [10, 2, -4] as [number, number, number], yawRad: 0 };
    const mid = footprintMiddle(house());
    expect(mid).toEqual([9 * VOXEL_SIZE_M, 0, 7 * VOXEL_SIZE_M]);
    const pos = turnedPosition(place, mid, Math.PI / 6);
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    // The middle in the world before and after the turn.
    expect(pos[0] + c * mid[0] + s * mid[2]).toBeCloseTo(10 + mid[0], 9);
    expect(pos[2] - s * mid[0] + c * mid[2]).toBeCloseTo(-4 + mid[2], 9);
    expect(pos[1]).toBe(2);
  });
});

describe('structure shape: materials, hand edits and misfit words', () => {
  it('a new structure takes the first construction material by id on every part; none is a message, not a house', () => {
    expect(defaultMaterials([{ id: 9, name: 'b', use: 'construction' }, { id: 2, name: 'soil', use: 'terrain' }, { id: 4, name: 'a', use: 'construction' }])).toEqual({ wall: 4, floor: 4, roof: 4, foundation: 4, stair: 4 });
    expect(defaultMaterials([{ id: 2, name: 'soil', use: 'terrain' }])).toBeNull();
  });

  it('a brush is an odd count of cells across, centred on a cell; a stroke is one brush command on the grid', () => {
    expect([0.2, 0.5, 1, 1.5, 2].map(brushCells)).toEqual([1, 1, 3, 3, 5]);
    expect(handStrokeCommand({ grid: 4, cells: [[3, 2, 0], [4, 2, 0]], shape: 'box', across: 1, mode: 'dig' })).toEqual({ v: 2, grid: 4, kind: 'brush', shape: 'box', size: [0.5, 0.5, 0.5], points: [3.5, 2.5, 0.5, 4.5, 2.5, 0.5], mode: 'dig', smooth: false });
    expect(handStrokeCommand({ grid: 4, cells: [[1, 1, 1]], shape: 'sphere', across: 3, mode: 'add', voxel: { material: 7, role: VOXEL_ROLE.pillar } })).toMatchObject({ size: [1.5, 1.5, 1.5], voxel: { material: 7, role: VOXEL_ROLE.pillar, wetness: 0 } });
  });

  it('a misfit says what the hand edit was in plain words', () => {
    expect(misfitWords({ x: 0, y: 1, z: 0, base: v(3, VOXEL_ROLE.wall), value: 0, generated: 0 })).toBe('a dug cell (was wall; now air is generated there)');
    expect(misfitWords({ x: 0, y: 1, z: 0, base: 0, value: v(5, VOXEL_ROLE.pillar), generated: v(3, VOXEL_ROLE.floor) })).toBe('an added cell (pillar, material 5; now floor is generated there)');
    expect(misfitWords({ x: 0, y: 1, z: 0, base: v(3, VOXEL_ROLE.wall), value: v(8, VOXEL_ROLE.wall), generated: 0 })).toBe('a painted cell (wall, material 8 over material 3; now air is generated there)');
    expect(misfitWords({ x: 0, y: 1, z: 0, base: v(3, VOXEL_ROLE.wall), value: v(8, VOXEL_ROLE.wall), generated: 0 }, (id) => (id === 8 ? 'Brick' : 'Stone'))).toBe('a painted cell (wall, Brick over Stone; now air is generated there)');
    expect(misfitSummary(1)).toBe('1 edit did not fit the new shape');
    expect(misfitSummary(3)).toBe('3 edits did not fit the new shape');
  });
});
