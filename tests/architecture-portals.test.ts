/**
 * Rooms and portals (project-model): the rooms of generated architecture and
 * the holes they see each other through — doors and windows (the outside
 * across an outer wall), holes in floors, open tops — and the portal walk
 * from the eye: rooms through open doors in view are seen, a closed door or
 * a door out of view hides what lies behind it, the outside is seen through
 * a window, and an eye standing in a doorway sees both sides. Browser-free;
 * the page's culling and the pixels are in the e2e.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildRoomGraph, portalRect, roomVisibility, ROOM_OUTSIDE, walkRooms, type RoomGraph } from '../packages/project-model/src/arch-portals';
import { expandArchitecture } from '../packages/project-model/src/arch-rooms';
import { architectureStylesOf, type ArchitectureRoomPlan } from '../packages/project-model/src/arch-style';
import type { ArchitectureComponent, ArchitectureOutline } from '../packages/project-model/src/architecture';

const STARTERS = architectureStylesOf([]);
const box = (x0: number, z0: number, x1: number, z1: number, y = 0): [number, number, number][] => [
  [x0, y, z0],
  [x1, y, z0],
  [x1, y, z1],
  [x0, y, z1],
];
const room = (id: string, pts: [number, number, number][], extra: Partial<ArchitectureOutline> = {}): ArchitectureOutline => ({ id, preset: 'starter-room', path: { points: pts, closed: true }, ...extra });

/**
 * Three 4 m rooms in a row along x (a 0–4, b 4–8, c 8–12): b's door into a
 * and c's door into b on the walls they share (each room's last side, at
 * x = 4 and x = 8, z 1–2), a window in a's front wall (z = 0, x 1.5–2.5).
 */
const ROW: ArchitectureComponent = {
  elements: [],
  outlines: [
    room('a', box(0, 0, 4, 4), { openings: [{ id: 'win', at: 2, width: 1, bottom: 1, top: 2 }] }),
    room('b', box(4, 0, 8, 4), { openings: [{ id: 'door', at: 14.5, width: 1, bottom: 0, top: 2.1 }] }),
    room('c', box(8, 0, 12, 4), { openings: [{ id: 'door', at: 14.5, width: 1, bottom: 0, top: 2.1 }] }),
  ],
};

/** A camera at `eye` looking at `at`: its projection × view (column-major). */
function view(eye: [number, number, number], at: [number, number, number], fov = 60): Float64Array {
  const cam = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
  cam.position.set(...eye);
  cam.lookAt(...at);
  cam.updateMatrixWorld();
  return Float64Array.from(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements);
}

const seen = (g: RoomGraph, eye: [number, number, number], at: [number, number, number], open: (p: number) => boolean = () => true): { rooms: string[]; outside: boolean } => {
  const v = walkRooms(g, eye, view(eye, at), open, roomVisibility(g.rooms.length));
  return { rooms: g.rooms.filter((_, i) => v.rooms[i] === 1).map((r) => r.id), outside: v.outside };
};

const rowGraph = (layer = false): RoomGraph => {
  const x = expandArchitecture({ ...ROW, ...(layer ? { layer: 'floor' } : {}) }, [10, 0, 20], STARTERS);
  return buildRoomGraph([{ id: 'house', origin: [10, 0, 20], rooms: x.rooms, ...(layer ? { layer: { id: 'floor', origin: [10, 0, 20], cellSize: [1, 0.5, 1] } } : {}) }]);
};

describe('rooms and portals', () => {
  it('the expansion gives each room its openings, whether it is covered, and its floor holes', () => {
    const x = expandArchitecture(ROW, [0, 0, 0], STARTERS);
    expect(x.rooms.map((r) => [r.id, r.openings.map((o) => o.id), r.covered])).toEqual([
      ['a', ['win'], true],
      ['b', ['door'], true],
      ['c', ['door'], true],
    ]);
    const door = x.rooms[1]!.openings[0]!;
    // B's last side runs from (4, 4) back to (4, 0): 14.5 m along is z 1.5; the door's ends are 0.5 m either way.
    expect([door.from, door.to, door.bottom, door.top]).toEqual([[4, 2], [4, 1], 0, 2.1]);
    // Storeys: the lower storey is covered by the floor of the one above, the hole in the upper floor is listed there.
    const two = expandArchitecture({ elements: [], outlines: [room('t', box(0, 0, 4, 4), { storeys: 2, storeyHeight: 3.2, holes: [{ storey: 1, path: { points: box(1, 1, 2, 2), closed: true } }] })] }, [0, 0, 0], STARTERS);
    expect(two.rooms.map((r) => [r.id, r.covered, r.holes.length])).toEqual([
      ['t', true, 0],
      ['t-s1', true, 1],
    ]);
  });

  it('builds the rooms in world space and the portals between them and to the outside', () => {
    const g = rowGraph();
    expect(g.rooms.map((r) => r.key)).toEqual(['house/a', 'house/b', 'house/c']);
    expect(g.rooms[0]!.box).toEqual([10, 20, 14, 24]);
    const pairs = g.portals.map((p) => [p.kind, p.a === ROOM_OUTSIDE ? 'out' : g.rooms[p.a]!.id, p.b === ROOM_OUTSIDE ? 'out' : g.rooms[p.b]!.id]);
    expect(pairs).toEqual([
      ['opening', 'a', 'out'],
      ['opening', 'b', 'a'],
      ['opening', 'c', 'b'],
    ]);
    expect(g.roomAt(12, 1, 22)).toBe(0);
    expect(g.roomAt(16, 1, 22)).toBe(1);
    expect(g.roomAt(16, 5, 22)).toBe(ROOM_OUTSIDE);
    expect(g.roomAt(30, 1, 22)).toBe(ROOM_OUTSIDE);
    expect(g.near(14.2, 1, 22, 0.35).sort()).toEqual([0, 1]);
  });

  it('a door on the layer\'s cell lines names the cell edges across its foot', () => {
    const g = rowGraph(true);
    // b's door: the line x = 4 of the layer, z 1–2 (one column), row 0.
    expect(Array.from(g.portals[1]!.door!.edges)).toEqual([4, 0, 1, 0]);
    expect(g.portals[1]!.door!.layer).toBe('floor');
    // The window in a's front wall (x 1.5–2.5) spans the middle of no column: no door stands there.
    expect(g.portals[0]!.door).toBeNull();
  });

  it('sees the rooms through the open doors in view, none behind a closed door or a door out of view', () => {
    const g = rowGraph();
    // In a, looking down the row through both doors.
    expect(seen(g, [12, 1.6, 21.5], [22, 1.2, 21.5]).rooms).toEqual(['a', 'b', 'c']);
    // Looking the other way: only a.
    expect(seen(g, [12, 1.6, 21.5], [2, 1.2, 21.5]).rooms).toEqual(['a']);
    // The door between a and b shut: only a, though b and c are in front of the eye.
    expect(seen(g, [12, 1.6, 21.5], [22, 1.2, 21.5], (p) => p !== 1).rooms).toEqual(['a']);
    // The door between b and c shut: a and b.
    expect(seen(g, [12, 1.6, 21.5], [22, 1.2, 21.5], (p) => p !== 2).rooms).toEqual(['a', 'b']);
    // In a, looking at the window: the outside.
    expect(seen(g, [12, 1.5, 22], [12, 1.5, 15]).outside).toBe(true);
    expect(seen(g, [12, 1.5, 22], [22, 1.2, 21.5]).outside).toBe(false);
  });

  it('from outside, a room is seen through its window and no further than its doors allow', () => {
    const g = rowGraph();
    // In front of a's window, looking in.
    const v = seen(g, [12, 1.5, 16], [12, 1.5, 22]);
    expect(v.outside).toBe(true);
    expect(v.rooms).toEqual(['a']);
    // Behind the row, no openings that side: nothing inside.
    expect(seen(g, [16, 1.5, 30], [16, 1.5, 20]).rooms).toEqual([]);
  });

  it('an eye in a doorway sees both rooms whichever way it looks along the wall', () => {
    const g = rowGraph();
    // In b's door (x = 14, z 21–22), looking along the wall: the door's picture is a sliver, both sides are kept.
    expect(seen(g, [14, 1.5, 21.5], [14, 1.5, 30]).rooms).toEqual(['a', 'b']);
  });

  it('an open top is a portal to the sky; a hole in a floor one to the room below', () => {
    const plan = (id: string, floor: number, top: number, extra: Partial<ArchitectureRoomPlan> = {}): ArchitectureRoomPlan => ({ id, outline: id, storey: 0, points: [[0, 0], [4, 0], [4, 4], [0, 4]], floor, top, openings: [], covered: true, holes: [], ...extra });
    const yard = buildRoomGraph([{ id: 'o', origin: [0, 0, 0], rooms: [plan('yard', 0, 3, { covered: false })] }]);
    expect(yard.portals.map((p) => [p.kind, p.b])).toEqual([['top', ROOM_OUTSIDE]]);
    expect(seen(yard, [2, 10, -6], [2, 0, 2]).rooms).toEqual(['yard']);
    const stack = buildRoomGraph([{ id: 'o', origin: [0, 0, 0], rooms: [plan('low', 0, 3), plan('up', 3.2, 6.2, { holes: [[[1, 1], [2, 1], [2, 2], [1, 2]]] })] }]);
    expect(stack.portals.map((p) => [p.kind, stack.rooms[p.a]!.id, stack.rooms[p.b]!.id])).toEqual([['hole', 'up', 'low']]);
    // Looking down through the hole from the upper room sees the lower one; looking away does not.
    expect(seen(stack, [3, 4.8, 3], [1.5, 0, 1.5]).rooms).toEqual(['low', 'up']);
    expect(seen(stack, [3, 4.8, 3], [3, 5, 20]).rooms).toEqual(['up']);
    // Covered tops are kept apart, shut: from above, nothing of the stack is seen.
    expect(stack.tops.map((t) => t?.kind ?? null)).toEqual(['top', 'top']);
    const fromAbove = (cut: (r: number) => boolean): string[] => {
      const v = walkRooms(stack, [2, 30, -2], view([2, 30, -2], [2, 0, 2]), () => true, roomVisibility(stack.rooms.length), cut);
      return stack.rooms.filter((_, i) => v.rooms[i] === 1).map((r) => r.id);
    };
    expect(fromAbove(() => false)).toEqual([]);
    // A cut-away hiding the roof opens the upper room to the sky (and the lower one through its hole, seen from steep
    // enough above); with the upper
    // floor cut too, the lower room is open from above by itself.
    expect(fromAbove((r) => r === 1)).toEqual(['low', 'up']);
    const solid = buildRoomGraph([{ id: 'o', origin: [0, 0, 0], rooms: [plan('low', 0, 3), plan('up', 3.2, 6.2)] }]);
    const solidSeen = (cut: (r: number) => boolean): string[] => {
      const v = walkRooms(solid, [2, 14, -6], view([2, 14, -6], [2, 0, 2]), () => true, roomVisibility(solid.rooms.length), cut);
      return solid.rooms.filter((_, i) => v.rooms[i] === 1).map((r) => r.id);
    };
    expect(solidSeen((r) => r === 1)).toEqual(['up']);
    expect(solidSeen(() => true)).toEqual(['low', 'up']);
  });

  it('a portal behind the eye has no picture; one in front is cut to the screen it covers', () => {
    const m = view([0, 0, 0], [0, 0, -1], 90);
    const r = new Float64Array(4);
    // A 2 × 2 m square 1 m ahead fills the 90° view across.
    expect(portalRect(Float64Array.of(-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1), m, r)).toBe(true);
    expect(r[0]).toBeCloseTo(-9 / 16, 5);
    expect(r[3]).toBeCloseTo(1, 5);
    expect(portalRect(Float64Array.of(-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1), m, r)).toBe(false);
  });
});
