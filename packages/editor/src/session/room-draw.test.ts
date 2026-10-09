import { describe, expect, it } from 'vitest';
import type { ArchitectureComponent } from '@thirdlight/project-model';
import { architectureOpeningEdges, architectureWallEdges, cellKeyOf } from '@thirdlight/runtime';

import { groundArea2, moveWall, nearestSide, nextOutlineId, openingOn, rectPath, roomPath, sideDragOffset, snapCorner, straightSides, withOutline } from './room-draw';

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
