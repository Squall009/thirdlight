import { describe, expect, it } from 'vitest';
import type { ArchitectureComponent } from '@thirdlight/project-model';

import { groundArea2, moveWall, nearestSide, nextOutlineId, openingEdges, openingOn, rectPath, roomPath, sideDragOffset, snapCorner, straightSides, withOutline } from './room-draw';

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

  it('finds the cell edges a door piece goes on: the opening cells along its wall, the rows up to its head', () => {
    const o = { id: 'a', preset: 'starter-room', path: rectPath([0, 1, 0], [6, 1, 4])!, openings: [] };
    // 7.5 m round: the east side (x = 6), cell z 1; the floor 1 m up, the layer 2 cells along x.
    expect(openingEdges(o, { id: 'd', at: 7.5, width: 1, bottom: 0, top: 2.1 }, 1, [2, 0, 0], CELL)).toEqual([
      [8, 1, 1, 0],
      [8, 2, 1, 0],
    ]);
    // On the south side, two cells wide, walked +x.
    expect(openingEdges(o, { id: 'd', at: 3, width: 2, bottom: 0, top: 1 }, 1, [0, 0, 0], CELL)).toEqual([
      [2, 1, 0, 1],
      [3, 1, 0, 1],
    ]);
  });
});
