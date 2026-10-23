import { describe, expect, it } from 'vitest';
import type { ArchitectureComponent } from '@thirdlight/project-model';
import { architectureOpeningEdges, architectureWallEdges, cellKeyOf } from '@thirdlight/runtime';

import { architectureStylesOf, ARCHITECTURE_STARTER_GRAPHS, expandArchitecture } from '@thirdlight/runtime';

import { groundArea2, moveWall, outlineFrame, outlineUnderRay, nearestCorner, nearestSegment, nearestSide, nextOutlineId, openingOn, openingPiece, openingResized, outlineOfElement, overridesOf, presetUses, rectPath, roomPath, sideDragOffset, snapCorner, straightSides, withOutline, withOutlineSet, withOverride, withPresetSwapped } from './room-draw';
import { kitPieceChoices, modelKey } from './kit-edits';

const CELL = [1, 1, 1];

describe('the Rooms tool', () => {
  it('snaps to cell corners and stores rooms with their inside on the right, however they were drawn', () => {
    expect(snapCorner(2.4, 3.6, 1, [0.5, 1, 0.5])).toEqual([2.5, 1, 3.5]);
    const r = rectPath([4, 1, 4], [0, 1, 0])!;
    expect(groundArea2(r.points)).toBeGreaterThan(0);
    expect(rectPath([0, 1, 0], [0, 1, 4])).toBeNull();
    // Drawn the other way round, an arc on its second side: reversed, the arc on the same side, bulging the same way.
    const p = roomPath([[0, 0, 0], [0, 0, 4], [4, 0, 4], [4, 0, 0]], [0, 0.5, 0, 0]);
    expect(p.points).toEqual([[4, 0, 0], [4, 0, 4], [0, 0, 4], [0, 0, 0]]);
    expect(p.bulges).toEqual([0, -0.5, 0, 0]);
  });

  it('puts openings whole cells wide on the nearest straight wall, centred on the cells they cover', () => {
    const c = withOutline(null, 'floor', { id: nextOutlineId(null, 'room'), preset: 'starter-room', path: rectPath([0, 0, 0], [6, 0, 4])! });
    expect(c.layer).toBe('floor');
    expect(nextOutlineId(c, 'room')).toBe('room-2');
    const near = nearestSide(c, 2.3, 0.2, 0.6, true)!;
    expect(near.side.index).toBe(0);
    const door = openingOn(near.side, near.along, 'door', CELL, 0)!;
    expect(door).toEqual({ id: 'door-1', at: 2.5, width: 1, bottom: 0, top: 2.1 });
    const arch = openingOn(near.side, near.along, 'arch', CELL, 0)!;
    expect([arch.at, arch.width]).toEqual([2, 2]);
    // On the second side (x = 6), 1.6 m along it: 6 m round the room plus the cell's middle.
    const east = nearestSide(c, 5.8, 1.6, 0.6, true)!;
    expect(openingOn(east.side, east.along, 'window', CELL, 1)).toEqual({ id: 'window-1', at: 7.5, width: 1, bottom: 0.9, top: 2, pane: true, storey: 1 });
    expect(nearestSide(c, 3, 2, 0.6, true)).toBeNull();
  });

  it('drags a wall by whole cells across itself, and the wall a room beside it shares goes with it', () => {
    const a = { id: 'a', preset: 'starter-room', path: rectPath([0, 0, 0], [4, 0, 4])! };
    const b = { id: 'b', preset: 'starter-room', path: rectPath([4, 0, 0], [8, 0, 4])! };
    const c: ArchitectureComponent = { elements: [], outlines: [a, b] };
    const shared = straightSides(a).find((s) => s.a[0] === 4 && s.b[0] === 4)!;
    // A drag 1.4 m toward +x moves it one cell (A's side runs +z: its right is −x, so the offset is −1).
    expect(sideDragOffset(shared, 4, 2, 5.4, 2, CELL)).toBe(-1);
    const next = moveWall(c, 'a', shared.index, -1);
    expect(next.outlines![0]!.path.points.filter((p) => p[0] === 5)).toHaveLength(2);
    expect(next.outlines![1]!.path.points.filter((p) => p[0] === 5)).toHaveLength(2);
    expect(next.outlines![1]!.path.points.filter((p) => p[0] === 4)).toHaveLength(0);
  });

  it('keeps the doors on the other walls where they stood when a wall is dragged; a partly shared wall goes with it', () => {
    // A: 10 × 4 (sides: 0 south z 0, 1 east x 10, 2 north z 4, 3 west x 0); a door on the south wall, an arch on the north.
    const a = { id: 'a', preset: 'starter-room', path: rectPath([0, 0, 0], [10, 0, 4])!, openings: [{ id: 'door-1', at: 6.5, width: 1, bottom: 0, top: 2.1 }, { id: 'arch-1', at: 16, width: 2, bottom: 0, top: 2.6 }] };
    // B north of A, sharing A's north wall over its whole length.
    const b = { id: 'b', preset: 'starter-room', path: rectPath([0, 0, 4], [10, 0, 8])!, openings: [{ id: 'window-1', at: 26, width: 1, bottom: 0.9, top: 2 }] };
    const c: ArchitectureComponent = { elements: [], outlines: [a, b] };
    const where = (x: ArchitectureComponent, id: string, opening: string): [number, number] => {
      const o = x.outlines!.find((q) => q.id === id)!;
      const at = o.openings!.find((q) => q.id === opening)!.at;
      const s = straightSides(o).find((q) => at >= q.start && at <= q.start + q.length)!;
      const t = (at - s.start) / s.length;
      return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[2] + (s.b[2] - s.a[2]) * t];
    };
    const before = { door: where(c, 'a', 'door-1'), arch: where(c, 'a', 'arch-1'), window: where(c, 'b', 'window-1') };
    expect(before).toEqual({ door: [6.5, 0], arch: [8, 4], window: [0, 6] });
    // A's east wall one cell in (x 10 → 9): the south side shrinks, so the arch on the north side and B's window would slide.
    const east = moveWall(c, 'a', 1, 1);
    expect(east.outlines![0]!.path.points.filter((p) => p[0] === 9)).toHaveLength(2);
    expect({ door: where(east, 'a', 'door-1'), arch: where(east, 'a', 'arch-1'), window: where(east, 'b', 'window-1') }).toEqual(before);
    // B's south wall is now longer than A's north wall (x 0–10 against 0–9): still shared, so a drag of A's north wall moves it too.
    const north = moveWall(east, 'a', 2, -1);
    expect(north.outlines![0]!.path.points.filter((p) => p[2] === 5)).toHaveLength(2);
    expect(north.outlines![1]!.path.points.filter((p) => p[2] === 5)).toHaveLength(2);
    expect(north.outlines![1]!.path.points.filter((p) => p[2] === 4)).toHaveLength(0);
    // The arch went with its wall; the door and B's window stayed.
    expect({ door: where(north, 'a', 'door-1'), arch: where(north, 'a', 'arch-1'), window: where(north, 'b', 'window-1') }).toEqual({ ...before, arch: [8, 5] });
    // A room touching only at a corner is left alone.
    const corner = { id: 'k', preset: 'starter-room', path: rectPath([10, 0, 0], [12, 0, 4])! };
    const touched = moveWall({ elements: [], outlines: [b, corner] }, 'b', 0, 1);
    expect(touched.outlines![1]).toBe(corner);
  });

  it('finds the cell edges a door piece goes on: the opening cells along its wall, the rows up to its head', () => {
    const o = { id: 'a', preset: 'starter-room', path: rectPath([0, 1, 0], [6, 1, 4])!, openings: [] };
    const door = { id: 'd', at: 7.5, width: 1, bottom: 0, top: 2.1 };
    // 7.5 m round: the east side (x = 6), cell z 1; the floor 1 m up, the layer 2 cells along x.
    expect(architectureOpeningEdges(o.path, door, 1, [2, 0, 0], CELL)).toEqual([
      [8, 1, 1, 0],
      [8, 2, 1, 0],
    ]);
    // On the south side, two cells wide, walked +x.
    expect(architectureOpeningEdges(o.path, { id: 'd', at: 3, width: 2, bottom: 0, top: 1 }, 1, [0, 0, 0], CELL)).toEqual([
      [2, 1, 0, 1],
      [3, 1, 0, 1],
    ]);
    // The cells the piece goes on are the ones the generated wall opens for the same door (one walk of the wall's cells).
    const wall = { elements: [{ id: 'w', kind: 'sweep' as const, path: o.path, profile: 'w', wall: true, openings: [door] }], profiles: { w: { points: [[-0.1, 0], [0.1, 0], [0.1, 3], [-0.1, 3]] as [number, number][], slots: ['lower_wall'] } } };
    const walls = architectureWallEdges(wall as unknown as ArchitectureComponent, [2, 0, 0], CELL);
    const opened = [...walls].filter(([, blocks]) => !blocks).map(([key]) => key);
    expect(architectureOpeningEdges(o.path, door, 1, [2, 0, 0], CELL).map(([x, y, z, axis]) => cellKeyOf(x, y, z) * 2 + axis)).toEqual(opened);
    // Past the path's end (20 m round) an opening is cut there, as the generator cuts it, never wrapped onto the first side.
    expect(architectureOpeningEdges(o.path, { ...door, at: 20.5 }, 1, [0, 0, 0], CELL)).toEqual([]);
  });
});

describe('kit pieces in rooms', () => {
  const table = architectureStylesOf(ARCHITECTURE_STARTER_GRAPHS as never);
  const rooms: ArchitectureComponent = {
    elements: [],
    outlines: [
      { id: 'room-1', preset: 'starter-room', path: { points: [[0, 0, 0], [6, 0, 0], [6, 0, 4], [0, 0, 4]], closed: true } },
      { id: 'room-10', preset: 'starter-room', path: { points: [[10, 0, 0], [14, 0, 0], [14, 0, 4], [10, 0, 4]], closed: true } },
      { id: 'run-1', preset: 'starter-fence', path: { points: [[0, 0, 8], [6, 0, 8]] } },
    ],
  };
  const expanded = expandArchitecture(rooms, [0, 0, 0], table).component;

  it('picks a wall segment or corner of the generated walls and names the room it belongs to', () => {
    const seg = nearestSegment(expanded.elements, 3, 0.3, 0.6)!;
    expect(seg.segment).toBe(0);
    expect(outlineOfElement(rooms, seg.element)?.id).toBe('room-1');
    // room-10's walls are not taken for room-1's (the id prefix is the whole outline id).
    expect(outlineOfElement(rooms, nearestSegment(expanded.elements, 12, 4.2, 0.6)!.element)?.id).toBe('room-10');
    expect(nearestSegment(expanded.elements, 3, 2, 0.6)).toBeNull();
    const corner = nearestCorner(expanded.elements, 6.2, 3.8, 0.6)!;
    expect([corner.corner, outlineOfElement(rooms, corner.element)?.id]).toEqual([2, 'room-1']);
  });

  it('puts one piece per spot, replaces and takes it off; the expansion keeps it', () => {
    const seg = nearestSegment(expanded.elements, 3, 0.3, 0.6)!;
    const door = { assetId: 'kit-wall', piece: 'panel' };
    let c = withOverride(rooms, { element: seg.element, segment: seg.segment }, door);
    c = withOverride(c, { element: seg.element, segment: seg.segment }, { assetId: 'kit-wall-2' });
    expect(c.overrides).toEqual([{ element: seg.element, segment: 0, model: { assetId: 'kit-wall-2' }, centre: true }]);
    expect(overridesOf(c, 'room-1').map((o) => o.index)).toEqual([0]);
    expect(overridesOf(c, 'room-10')).toEqual([]);
    expect(expandArchitecture(c, [0, 0, 0], table).component.overrides).toEqual(c.overrides);
    expect(withOverride(c, { element: seg.element, segment: 0 }, null).overrides).toBeUndefined();
  });

  it('a room deleted or renamed takes the pieces on its walls with it (the component stays valid)', () => {
    // The model's rule (the editor may not run its validator; the rooms e2e stores a delete through the backend):
    // a piece names an element of `elements` or one an outline or building makes (its id, then '-').
    const errorsOf = (c: ArchitectureComponent): string[] => {
      const makers = [...(c.outlines ?? []).map((o) => o.id), ...(c.buildings ?? []).map((b) => b.id)];
      const ids = new Set(c.elements.map((e) => e.id));
      return (c.overrides ?? []).filter((o) => !ids.has(o.element) && !makers.some((m) => o.element.startsWith(`${m}-`))).map((o) => o.element);
    };
    const mine = nearestSegment(expanded.elements, 3, 0.3, 0.6)!;
    const other = nearestSegment(expanded.elements, 12, 4.2, 0.6)!;
    let c = withOverride(rooms, { element: mine.element, segment: mine.segment }, { assetId: 'kit-wall' });
    c = withOverride(c, { element: other.element, corner: 1 }, { assetId: 'kit-corner' });
    expect(errorsOf(c)).toEqual([]);
    const gone = withOutlineSet(c, 'room-1', null);
    expect(gone.overrides!.map((o) => o.element)).toEqual([other.element]);
    expect(errorsOf(gone)).toEqual([]);
    const renamed = withOutlineSet(c, 'room-1', { ...rooms.outlines![0]!, id: 'hall' });
    expect(renamed.overrides!.map((o) => o.element)).toEqual([`hall${mine.element.slice('room-1'.length)}`, other.element]);
    expect(errorsOf(renamed)).toEqual([]);
    // An edit that keeps the id keeps its pieces as they are; the last piece gone drops the list.
    expect(withOutlineSet(c, 'room-1', { ...rooms.outlines![0]!, preset: 'starter-hall' }).overrides).toBe(c.overrides);
    expect(withOutlineSet(withOutlineSet(c, 'room-1', null), 'room-10', null).overrides).toBeUndefined();
  });

  it("picks an upper storey's wall and corner from its own floor (the ground storey's from the ground)", () => {
    const tall: ArchitectureComponent = { elements: [], outlines: [{ ...rooms.outlines![0]!, storeys: 2, storeyHeight: 3 }] };
    const els = expandArchitecture(tall, [0, 0, 0], table).component.elements;
    const ground = nearestSegment(els, 3, 0.3, 0.6, 0)!;
    const upper = nearestSegment(els, 3, 0.3, 0.6, 3)!;
    expect(ground.a[1]).toBe(0);
    expect(upper.a[1]).toBe(3);
    expect(upper.element).not.toBe(ground.element);
    expect(nearestCorner(els, 6.2, 3.8, 0.6, 3)!.p[1]).toBe(3);
    expect(nearestCorner(els, 6.2, 3.8, 0.6, 0)!.p[1]).toBe(0);
  });

  it("a run's repeated piece comes from the kit: the style's copies place the model (absent: the style's own)", () => {
    const run = (x: ArchitectureComponent): unknown[] => expandArchitecture(x, [0, 0, 0], table).component.elements.filter((e) => e.id.startsWith('run-1') && e.kind === 'repeat').map((e) => (e as { piece: unknown }).piece);
    expect(run(rooms).every((p) => 'elements' in (p as object))).toBe(true);
    const rail = { assetId: 'kit-rail' };
    const c: ArchitectureComponent = { ...rooms, outlines: rooms.outlines!.map((o) => (o.id === 'run-1' ? { ...o, repeatModel: rail } : o)) };
    expect(run(c)).toEqual(run(rooms).map(() => ({ model: rail })));
  });

  it('a door or window piece takes the hole its size needs, from its slot\'s sill', () => {
    const side = straightSides(rooms.outlines![0]!)[0]!;
    const door = openingPiece({ assetId: 'd' }, 'door', 0, [1, 2, 0.2], CELL);
    const o = openingOn(side, 3.2, 'door', CELL, 0, door)!;
    expect(o).toEqual({ id: 'door-1', at: 3.5, width: 1, bottom: 0, top: 2, model: { assetId: 'd' } });
    // A wide window (1.6 m: two cells), no pane behind a piece; an unknown size takes the kind's height from the sill.
    expect(openingOn(side, 3.2, 'window', CELL, 0, openingPiece({ assetId: 'w' }, 'window', 1, [1.6, 1, 0.1], CELL))).toMatchObject({ width: 2, bottom: 1, top: 2, at: 3 });
    expect(openingPiece({ assetId: 'w' }, 'window', 1, null, CELL)).toMatchObject({ cells: 1, bottom: 1, top: 2.1 });
    // A piece a little over a cell wide takes the next whole cell (its hole must hold it), not the nearest.
    expect(openingPiece({ assetId: 'd' }, 'door', 0, [1.2, 2, 0.2], CELL).cells).toBe(2);
    expect(openingPiece({ assetId: 'd' }, 'door', 0, [1.0000001, 2, 0.2], CELL).cells).toBe(1);
  });

  it("sizes a piece's hole on the wall's own axis, re-centred on whole cells, and refuses a wall too short", () => {
    // Cells 2 m along x, 1 m along z: a 1.5 m piece is one cell on the x walls, two on the z walls.
    const cs = [2, 1, 1];
    const room = rooms.outlines![0]!;
    const [xSide, zSide] = straightSides(room);
    const piece = openingPiece({ assetId: 'd' }, 'door', 0, [1.5, 2, 0.2], cs);
    expect(openingOn(xSide!, 3.2, 'door', cs, 0, piece)).toMatchObject({ width: 2, at: 3 });
    expect(openingOn(zSide!, 1.2, 'door', cs, 0, piece)).toMatchObject({ width: 2, at: 7 });
    // An opening on the z wall (6 m round, 1 cell wide at 7.5) given the piece: two cells, centred on a cell line near where it stood.
    const o = { id: 'door-1', at: 7.5, width: 1, bottom: 0, top: 2 };
    expect(openingResized(room, o, piece, cs)).toEqual({ at: 8, width: 2 });
    // A piece wider than the 4 m wall: refused in words.
    expect(openingResized(room, o, openingPiece({ assetId: 'd' }, 'door', 0, [4.5, 2, 0.2], cs), cs)).toMatch(/too short/);
  });

  it("offers a kit's slot pieces once each, keyed by model", () => {
    const kit = { kitId: 'k', name: 'K', pieces: { door: [{ assetId: 'a', piece: 'door' }, { assetId: 'a', piece: 'door', weight: 2 }], window: [{ assetId: 'b' }] } };
    expect(kitPieceChoices(kit, ['door', 'window']).map((c) => [c.slot, c.key])).toEqual([['door', 'a#door'], ['window', 'b']]);
    expect(kitPieceChoices(null, ['door'])).toEqual([]);
    expect(modelKey({ assetId: 'b' })).toBe('b');
  });

  it('swaps one preset for another on every room, run and building, the outlines kept', () => {
    const path = { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4]] as [number, number, number][], closed: true };
    const c: ArchitectureComponent = {
      elements: [],
      outlines: [{ id: 'a', preset: 'stone', path, openings: [{ id: 'door-1', at: 1, width: 1, bottom: 0, top: 2 }] }, { id: 'b', preset: 'wood', outside: 'stone', path }, { id: 'fence', preset: 'rail', path: { ...path, closed: false } }],
      buildings: [{ id: 'house', preset: 'wood', outside: 'stone', path, roof: { shape: 'hip' } }],
    };
    expect(presetUses(c)).toEqual([{ preset: 'stone', outlines: 3 }, { preset: 'wood', outlines: 2 }, { preset: 'rail', outlines: 1 }]);
    const next = withPresetSwapped(c, 'stone', 'brick');
    expect(next.outlines!.map((o) => [o.preset, o.outside])).toEqual([['brick', undefined], ['wood', 'brick'], ['rail', undefined]]);
    expect(next.buildings![0]).toMatchObject({ preset: 'wood', outside: 'brick', roof: { shape: 'hip' } });
    // The plan stays: paths and openings are the same values.
    expect(next.outlines![0]!.path).toBe(path);
    expect(next.outlines![0]!.openings).toEqual(c.outlines![0]!.openings);
    expect(presetUses(next).map((u) => u.preset)).toEqual(['brick', 'wood', 'rail']);
  });
});

describe('picking a room, building or path in the view', () => {
  // A room 4 × 4 m at the origin and a building 4 × 4 m beside it, two storeys of 3 m; a fence path along z = 10.
  const room = withOutline(null, 'floor', { id: 'room-1', preset: 'starter-room', path: rectPath([0, 0, 0], [4, 0, 4])! });
  const c: ArchitectureComponent = { ...room, buildings: [{ id: 'building-1', preset: 'starter-room', storeys: 2, storeyHeight: 3, path: rectPath([8, 0, 0], [12, 0, 4])! }], outlines: [...(room.outlines ?? []), { id: 'run-1', preset: 'starter-fence', path: { points: [[0, 0, 10], [12, 0, 10]] } }] };

  it('finds a footprint from above and a wall from the side, the nearest first', () => {
    expect(outlineUnderRay(c, [2, 20, 2], [0, -1, 0], undefined, 1, 0.6)?.id).toBe('room-1');
    expect(outlineUnderRay(c, [10, 20, 2], [0, -1, 0], undefined, 1, 0.6)?.id).toBe('building-1');
    // From the side at 5 m up: the room (3 m) is passed over, the two-storey building is met.
    expect(outlineUnderRay(c, [-10, 5, 2], [1, 0, 0], undefined, 1, 0.6)?.id).toBe('building-1');
    // At 1 m up the room's wall is nearer.
    const hit = outlineUnderRay(c, [-10, 1, 2], [1, 0, 0], undefined, 1, 0.6)!;
    expect(hit.id).toBe('room-1');
    expect(hit.t).toBeCloseTo(10);
    // Between them, nothing.
    expect(outlineUnderRay(c, [6, 20, 2], [0, -1, 0], undefined, 1, 0.6)).toBeNull();
  });

  it('finds a path from above within reach of its line, and nothing behind the ray', () => {
    expect(outlineUnderRay(c, [5, 20, 10.4], [0, -1, 0], undefined, 1, 0.6)?.id).toBe('run-1');
    expect(outlineUnderRay(c, [5, 20, 11], [0, -1, 0], undefined, 1, 0.6)).toBeNull();
    expect(outlineUnderRay(c, [2, 20, 2], [0, 1, 0], undefined, 1, 0.6)).toBeNull();
  });

  it('outlines an outline as its floor and top rings and its corners stood up', () => {
    const b = c.buildings![0]!;
    const lines = outlineFrame(b, undefined, 1);
    // Four sides twice (floor, top) and four verticals: 12 lines, 24 points; the top at two storeys.
    expect(lines).toHaveLength(24);
    expect(Math.max(...lines.map((p) => p[1]))).toBe(6);
  });

  it('stands a building up to the storeys the runtime builds (a tall preset), as the expansion gives them', () => {
    const table = architectureStylesOf(ARCHITECTURE_STARTER_GRAPHS as never);
    const tall: ArchitectureComponent = { elements: [], buildings: [{ id: 'building-1', preset: 'starter-room-tall', storeys: 2, path: rectPath([0, 0, 0], [4, 0, 4])! }] };
    const rises = expandArchitecture(tall, [0, 0, 0], table).rises;
    expect(rises?.['building-1']).toBeCloseTo(4.2, 3);
    const b = tall.buildings![0]!;
    expect(Math.max(...outlineFrame(b, rises, 1).map((p) => p[1]))).toBeCloseTo(8.4, 3);
    // From the side at 7 m up: the second storey of a tall building (3 m storeys would end at 6).
    expect(outlineUnderRay(tall, [-10, 7, 2], [1, 0, 0], rises, 1, 0.6)?.id).toBe('building-1');
    expect(outlineUnderRay(tall, [-10, 7, 2], [1, 0, 0], undefined, 1, 0.6)).toBeNull();
  });

  it('picks the building first; a double-click goes in to the room or path under the pointer, and a click out again', () => {
    const inside: ArchitectureComponent = {
      elements: [],
      buildings: [{ id: 'building-1', preset: 'starter-room', storeys: 2, storeyHeight: 3, path: rectPath([0, 0, 0], [8, 0, 8])! }],
      outlines: [{ id: 'room-1', preset: 'starter-room', path: rectPath([1, 0, 1], [4, 0, 4])! }, { id: 'run-1', preset: 'starter-fence', path: { points: [[5, 0, 6], [7, 0, 6]] } }],
    };
    const pick = (o: number[], d: number[], goIn = false): string | undefined => outlineUnderRay(inside, o, d, undefined, 1, 0.6, goIn)?.id;
    expect(pick([2, 20, 2], [0, -1, 0])).toBe('building-1');
    expect(pick([2, 20, 2], [0, -1, 0], true)).toBe('room-1');
    expect(pick([6, 20, 6.2], [0, -1, 0], true)).toBe('run-1');
    // A low view through the building's wall: the room behind it (its 3 m walls under the building's 6 m).
    expect(pick([-10, 2, 2.5], [1, 0, 0], true)).toBe('room-1');
    // An oblique view onto the building's top above the room: the room stood up to the building's top is met.
    expect(pick([2.5 + 12, 6 + 6, 2.5], [-12, -6, 0], true)).toBe('room-1');
    // Nothing inside under the pointer: the building stays; a plain click over the room picks the building again.
    expect(pick([6, 20, 2], [0, -1, 0], true)).toBe('building-1');
    expect(pick([2, 20, 2], [0, -1, 0])).toBe('building-1');
  });
});
