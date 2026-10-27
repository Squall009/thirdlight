/**
 * Rooms and portals hold the surface cache's light in (surface-rooms.ts):
 * which rooms a lamp may light through open portals, where a probe ray
 * leaves a room and whether by a portal, and the leak a closed door makes
 * without them — a door piece is an edge piece the tracer lets light
 * through, so a lamp in a shut room lights the ground outside its door
 * unless its rooms hold it (the light pass's CPU twin, the shaders line for
 * line). A switched lamp marks only the units its rooms touch.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, buildRoomGraph, type BlockType } from '@thirdlight/runtime';

import { SurfaceChanges, savedLights, type CacheLight } from './surface-changes';
import { lightFrameCpu } from './surface-light-cpu';
import type { LightPassFrame } from './surface-light-frame';
import { SHADOW_TRACE } from './surface-light-pass';
import { SurfaceRelight } from './surface-relight';
import { NO_ROOM, SurfaceRooms, roomExitCpu, texelRoomCpu } from './surface-rooms';
import { packTraceScene } from './tracer-scene';
import { opaqueByBlockTypes, traceBlockLayerOf } from './tracer-sources';

type V3 = [number, number, number];

/**
 * A closed block room (inside x, z 1..7, floor at y 1, ceiling at y 4) on a
 * ground slab, with a doorway gap 2 m wide in its +z wall: the gap is where
 * a door piece stands, which the tracer does not stop. Its room plan has
 * the outline on the walls' middle lines and the doorway as an opening.
 */
function closedRoom(doorOpen: boolean): { rooms: SurfaceRooms; scene: ReturnType<typeof packTraceScene>; open: { value: boolean } } {
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-10, 0, -10], max: [20, 6, 20] } });
  for (let z = -10; z < 20; z += 1) for (let x = -10; x < 20; x += 1) grid.set(x, 0, z, { block: 'rock' });
  for (let y = 1; y <= 4; y += 1) {
    for (let k = 0; k <= 7; k += 1) {
      for (const [x, z] of [[k, 0], [k, 7], [0, k], [7, k]] as const) {
        const doorway = z === 7 && (x === 3 || x === 4) && y <= 2;
        if (!doorway) grid.set(x, y, z, { block: 'rock' });
      }
    }
  }
  for (let z = 0; z <= 7; z += 1) for (let x = 0; x <= 7; x += 1) grid.set(x, 4, z, { block: 'rock' });
  const scene = packTraceScene({ blocks: [traceBlockLayerOf(grid, [0, 0, 0], opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]))] });
  const graph = buildRoomGraph([
    {
      id: 'house',
      origin: [0, 0, 0],
      rooms: [{ id: 'r', outline: 'r', storey: 0, points: [[0.5, 0.5], [7.5, 0.5], [7.5, 7.5], [0.5, 7.5]], floor: 1, top: 4, covered: true, holes: [], openings: [{ id: 'door', from: [3, 7.5], to: [5, 7.5], bottom: 1, top: 3 }] }],
    },
  ]);
  const open = { value: doorOpen };
  return { rooms: new SurfaceRooms({ graph, open: () => open.value, version: 0 }), scene, open };
}

const lamp: CacheLight = { id: 'lamp', kind: 'point', on: true, position: [4, 3, 4], direction: [0, -1, 0], color: [20, 20, 20], range: 14, cone: 0, penumbra: 0, shadows: true };

/** A texel's irradiance (red) from the lamp, its rooms as `rooms` gives them (null: no rooms). */
function lit(p: V3, n: V3, rooms: SurfaceRooms | null, scene: ReturnType<typeof packTraceScene>, light: CacheLight = lamp): number {
  const copies = 64;
  const points = new Float32Array(copies * 6);
  for (let i = 0; i < copies; i += 1) points.set([...p, ...n], i * 6);
  const min = p.map((v) => v - 0.05);
  const max = p.map((v) => v + 0.05);
  const held = rooms?.lightRooms(light.position, light.shadows === false) ?? null;
  const frame: LightPassFrame = {
    points,
    slices: [{ texels: copies, lights: [0], sun: false, level: 0, ...(rooms !== null ? { rooms: rooms.unitRooms(min, max) } : {}) }],
    lights: [light],
    sun: null,
    ...(rooms !== null ? { lightRooms: [held], rooms: rooms.words } : {}),
  };
  const e = lightFrameCpu(frame, scene, 3, SHADOW_TRACE);
  let s = 0;
  for (let i = 0; i < copies; i += 1) s += e[i * 3]!;
  return s / copies;
}

describe('surface cache: rooms and portals hold light in', () => {
  it('a lamp in a room lights that room while its door is shut, and is not held once the door opens onto the outside', () => {
    const { rooms } = closedRoom(false);
    expect(rooms.roomAt([4, 2, 4])).toBe(0);
    expect(rooms.roomAt([4, 2, 10])).toBe(NO_ROOM);
    expect(rooms.lightRooms(lamp.position)).toEqual([0]);
    expect(closedRoom(true).rooms.lightRooms(lamp.position)).toBeNull();
    // A lamp outside is never held.
    expect(rooms.lightRooms([4, 2, 12])).toBeNull();
  });

  it('a probe ray leaves the room at its wall, floor or top, and by the doorway only while it is open', () => {
    for (const doorOpen of [false, true]) {
      const { rooms } = closedRoom(doorOpen);
      const u = rooms.words;
      const side = roomExitCpu(u, 0, [4, 2, 4], [1, 0, 0]);
      expect(side.t).toBeCloseTo(3.5, 5);
      expect(side.open).toBe(false);
      const up = roomExitCpu(u, 0, [4, 2, 4], [0, 1, 0]);
      expect(up.t).toBeCloseTo(2, 5);
      expect(up.open).toBe(false);
      const door = roomExitCpu(u, 0, [4, 2, 4], [0, 0, 1]);
      expect(door.t).toBeCloseTo(3.5, 5);
      expect(door.open).toBe(doorOpen);
      // Through the wall beside the doorway: never open.
      const d = [0.6, 0, 0.8];
      expect(roomExitCpu(u, 0, [4, 2, 4], d).open).toBe(false);
    }
  });

  it("a texel's room: a wall's room side is in the room, its far side is not", () => {
    const { rooms } = closedRoom(false);
    const u = rooms.words;
    expect(texelRoomCpu(u, [0], [7, 2, 4], [-1, 0, 0])).toBe(0);
    expect(texelRoomCpu(u, [0], [8, 2, 4], [1, 0, 0])).toBe(NO_ROOM);
    expect(texelRoomCpu(u, [0], [4, 1, 4], [0, 1, 0])).toBe(0);
    expect(texelRoomCpu(u, [0], [4, 4, 4], [0, -1, 0])).toBe(0);
  });

  it('leak: a lamp behind a shut door lights the ground outside without rooms, nothing with them, and lights it again once the door opens', () => {
    const shut = closedRoom(false);
    const outside: V3 = [4, 1, 10];
    const inside: V3 = [4, 1, 5];
    const leak = lit(outside, [0, 1, 0], null, shut.scene);
    expect(leak).toBeGreaterThan(0.05);
    expect(lit(outside, [0, 1, 0], shut.rooms, shut.scene)).toBe(0);
    // The room itself is lit as before.
    expect(lit(inside, [0, 1, 0], shut.rooms, shut.scene)).toBeCloseTo(lit(inside, [0, 1, 0], null, shut.scene), 6);
    const opened = closedRoom(true);
    expect(lit(outside, [0, 1, 0], opened.rooms, opened.scene)).toBeCloseTo(leak, 6);
  });

  it('a lamp casting no shadow lights only its own room, its door open or not (as drawn per pixel)', () => {
    const opened = closedRoom(true);
    const bare: CacheLight = { ...lamp, shadows: false };
    expect(lit([4, 1, 10], [0, 1, 0], opened.rooms, opened.scene, bare)).toBe(0);
    expect(lit([4, 1, 5], [0, 1, 0], opened.rooms, opened.scene, bare)).toBeGreaterThan(0.05);
    // With its shadow it reaches the ground outside through the open doorway.
    expect(lit([4, 1, 10], [0, 1, 0], opened.rooms, opened.scene)).toBeGreaterThan(0.05);
  });

  it('a lamp switched behind a shut door marks only the units its room touches', () => {
    const { rooms, open } = closedRoom(false);
    const relight = new SurfaceRelight(1.5);
    const unit = (key: string, min: V3, max: V3): void => relight.add({ key, min, max, texels: 16 });
    unit('floor', [1, 1, 1], [7, 1, 7]);
    unit('wall-in', [7, 1, 1], [7, 4, 7]);
    unit('wall-out', [8, 1, 1], [8, 4, 7]);
    unit('yard', [2, 1, 9], [6, 1, 12]);
    const changes = new SurfaceChanges(relight);
    changes.setRooms(rooms);
    changes.setLights([{ ...lamp, on: false }]);
    relight.plan([0, 0, 0], 0);
    for (const k of ['floor', 'wall-in', 'wall-out', 'yard']) while (relight.isStale(k)) relight.plan([0, 0, 0], 0);
    changes.setLights([lamp]);
    expect(['floor', 'wall-in', 'wall-out', 'yard'].filter((k) => relight.isStale(k))).toEqual(['floor', 'wall-in']);
    // The door opens: the lamp's rooms changed, so its room and what it sees through the doorway are marked (not the side wall's far face).
    while (['floor', 'wall-in'].some((k) => relight.isStale(k))) relight.plan([0, 0, 0], 0);
    open.value = true;
    changes.setRooms(new SurfaceRooms({ graph: rooms.rooms.graph, open: () => true, version: 1 }));
    expect(['floor', 'wall-in', 'wall-out', 'yard'].filter((k) => relight.isStale(k))).toEqual(['floor', 'wall-in', 'yard']);
  });
});

describe('surface cache: a lamp in a room whose door is open marks what it sees through the door', () => {
  it('its room, and outside only what the doorway shows it (a frustum from its sphere through the doorway)', () => {
    const { rooms } = closedRoom(true);
    const m = rooms.lightMarks(lamp.position, 0.3)!;
    expect(m.rooms).toEqual([0]);
    expect(m.exits.length).toBe(1);
    // In front of the doorway, beyond it.
    expect(rooms.marks([3.5, 1, 9], [4.5, 1, 10], m)).toBe(true);
    // Beside the house, out of the doorway's sight.
    expect(rooms.marks([10, 1, 2], [11, 1, 3], m)).toBe(false);
    // The wall's outer face beside the doorway: behind the doorway's plane only at its edge, out of its sight.
    expect(rooms.marks([0, 1, 8], [2, 4, 8], m)).toBe(false);
    // The room's own floor.
    expect(rooms.marks([1, 1, 1], [7, 1, 7], m)).toBe(true);
    // Points the lamp's sphere sees through the doorway are inside the frustum (sampled).
    let seen = 0;
    for (let i = 0; i < 400; i += 1) {
      const x = lamp.position[0]! + Math.sin(i) * 0.3;
      const y = lamp.position[1]! + Math.cos(i * 1.7) * 0.3;
      const z = lamp.position[2]! + Math.sin(i * 2.3) * 0.3;
      // Through a point of the doorway, on to 6 m past it.
      const dx = 3 + ((i * 37) % 100) / 50;
      const dy = 1 + ((i * 53) % 100) / 50;
      const t = 1 + ((i * 71) % 100) / 20;
      const q = [x + (dx - x) * t, y + (dy - y) * t, z + (7.5 - z) * t];
      if (q[2]! <= 7.5) continue;
      seen += 1;
      expect(rooms.marks(q, q, m)).toBe(true);
    }
    expect(seen).toBeGreaterThan(100);
  });
});

describe('surface cache: light modes in the saved result', () => {
  it('baked lights give their direct light and bounce, mixed lights their bounce only, realtime lights nothing', () => {
    const ls: CacheLight[] = [{ ...lamp, id: 'r' }, { ...lamp, id: 'b', mode: 'baked' }, { ...lamp, id: 'm', mode: 'mixed' }, { ...lamp, id: 'x', mode: 'realtime' }];
    expect(savedLights(ls, 'direct').map((l) => l.id)).toEqual(['b']);
    expect(savedLights(ls, 'bounce').map((l) => l.id)).toEqual(['b', 'm']);
  });
});
