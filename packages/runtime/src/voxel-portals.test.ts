/**
 * Portal state on a structure's opening, against the real prop channel: a door prop joined to the opening it stands
 * in by its place alone (no definition), its shut state stamped into exactly the world cells the opening reaches at
 * 0°, 30° and 45° (every world cell whose middle lies in the opening stops light whole, though a turned stamp narrows
 * the opening), a flip recombining only the chunks those cells lie in, the walk graph told the opening's cells, and
 * opened, the channel back to what it was.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid, GridFrame, LIGHT_STOP_COVERAGE, PropLightChannel, VOXEL_ROLE, VOXEL_SIZE_M, type VoxelRecord } from '@thirdlight/voxel';
import { WorldPortals } from './voxel-portals';
import type { VoxelGridHost } from './voxel-grid-host';

const grid = chunkGrid(32);
const M = VOXEL_SIZE_M;
/** A wall along x at z 0, rows 1 … 6, with a door at x 5 … 7, rows 1 … 5 (the e2e house's). */
const DOOR = { x: [5, 7], y: [1, 5], z: 0 } as const;

function gridHost(yawDeg: number): { host: VoxelGridHost; shut: Array<[string, unknown]> } {
  const frame = new GridFrame({ gridId: 1, position: [10.2, 0, -3.7], yawRad: (yawDeg * Math.PI) / 180 });
  const shut: Array<[string, unknown]> = [];
  const streamer = {
    grid,
    isResident: () => true,
    voxelAt: (x: number, y: number, z: number, out: VoxelRecord): VoxelRecord => {
      const door = x >= DOOR.x[0] && x <= DOOR.x[1] && y >= DOOR.y[0] && y <= DOOR.y[1] && z === DOOR.z;
      const wall = z === DOOR.z && x >= 0 && x < 12 && y >= 1 && y <= 6;
      out.material = door || wall ? 9 : 0;
      out.role = door ? VOXEL_ROLE.opening : wall ? VOXEL_ROLE.wall : VOXEL_ROLE.air;
      out.shape = wall ? 15 : 0;
      out.wetness = 0;
      return out;
    },
  };
  const host = { frame, streamer, extent: { min: [-1, -1, -1], max: [1, 1, 1] }, walk: { setShut: (id: string, cells: unknown) => shut.push([id, cells]) } } as unknown as VoxelGridHost;
  return { host, shut };
}

function channel(): { ch: PropLightChannel; built: string[] } {
  const ch = new PropLightChannel({ grid, setPart: () => true }, M);
  for (let cx = -1; cx <= 1; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = -1; cz <= 1; cz++) ch.loaded(cx, cy, cz);
  const built: string[] = [];
  ch.onBuild = (cx, cy, cz) => built.push(`${cx},${cy},${cz}`);
  return { ch, built };
}

describe('portal state on a structure opening', () => {
  for (const yaw of [0, 30, 45]) {
    it(`a shut door stops light in every world cell whose middle lies in its opening, and opened passes it again (${yaw}°)`, () => {
      const { host, shut } = gridHost(yaw);
      const { ch, built } = channel();
      const portals = new WorldPortals(() => [host], () => ch);
      const middle = host.frame.toWorld(((DOOR.x[0] + DOOR.x[1] + 1) / 2) * M, 1.5, (DOOR.z + 0.5) * M);
      portals.set([['door', { open: false, stops: { light: true, sight: true, walk: true }, at: [middle[0], middle[1], middle[2]] }]]);
      portals.step();
      ch.flush();
      expect(portals.stats()).toMatchObject({ joined: 1, shutLight: 1, shutWalk: 1 });
      // The walk graph got the opening's 15 cells.
      expect(shut).toHaveLength(1);
      expect((shut[0]![1] as unknown[]).length).toBe(15);
      // Every world cell whose middle lies in the opening's cells stops light whole; none far from it does.
      let inside = 0;
      for (let x = 0; x < 60; x++) for (let y = 0; y < 8; y++) for (let z = -30; z < 10; z++) {
        const g = host.frame.toGrid((x + 0.5) * M, (y + 0.5) * M, (z + 0.5) * M).map((v) => Math.floor(v / M));
        const inDoor = g[0]! >= DOOR.x[0] && g[0]! <= DOOR.x[1] && g[1]! >= DOOR.y[0] && g[1]! <= DOOR.y[1] && g[2] === DOOR.z;
        const b = ch.at(x, y, z);
        if (inDoor) {
          inside++;
          expect(b, `cell ${x},${y},${z}`).toBeGreaterThanOrEqual(LIGHT_STOP_COVERAGE);
        }
        const far = Math.abs(g[0]! - 6) > 3 || g[1]! < 0 || g[1]! > 6 || Math.abs(g[2]!) > 1;
        if (far) expect(b, `cell ${x},${y},${z}`).toBe(0);
      }
      expect(inside).toBeGreaterThan(0);
      // The flip recombined only the chunks the opening's cells reach.
      const reached = new Set(built);
      expect(reached.size).toBeLessThanOrEqual(2);
      built.length = 0;
      portals.set([['door', { open: true, stops: { light: true, sight: true, walk: true }, at: [middle[0], middle[1], middle[2]] }]]);
      ch.flush();
      expect(portals.stats()).toMatchObject({ shutLight: 0, shutWalk: 0, flips: 2 });
      expect(shut[1]).toEqual(['door', null]);
      for (const k of built) expect(reached.has(k)).toBe(true);
      for (let x = 0; x < 60; x++) for (let y = 0; y < 8; y++) for (let z = -30; z < 10; z++) expect(ch.at(x, y, z)).toBe(0);
      // A pane (light passes) never stamps; a prop standing in no opening joins nothing.
      portals.set([['pane', { open: false, stops: { light: false, sight: false, walk: true }, at: [middle[0], middle[1], middle[2]] }], ['nowhere', { open: false, stops: { light: true, sight: true, walk: true }, at: [middle[0] + 40, 1, middle[2]] }]]);
      portals.step();
      ch.flush();
      expect(portals.stats()).toMatchObject({ joined: 2, shutLight: 0 });
      expect(portals.propOf([-1000, -1000, -1000], [1000, 1000, 1000])?.id).toBeDefined();
    });
  }

  it('two openings side by side (one run of opening cells) are told apart by which side of the midpoint between their props each lies, whichever joins first', () => {
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const { host, shut } = gridHost(30);
      const { ch } = channel();
      const portals = new WorldPortals(() => [host], () => ch);
      // The door's run x 5 … 7 holds two props: one over x 5, one over x 7 (as two touching openings sent by command).
      const at = (x: number) => host.frame.toWorld((x + 0.5) * M, 1.5, (DOOR.z + 0.5) * M);
      const props = { a: at(5), b: at(7) } as Record<string, [number, number, number]>;
      for (const id of order) {
        portals.set([[id, { open: false, stops: { light: true, sight: true, walk: true }, at: props[id]! }]]);
        portals.step();
        portals.step();
      }
      const last = new Map<string, Array<[number, number, number]> | null>();
      for (const [id, cells] of shut) last.set(id, cells as Array<[number, number, number]> | null);
      const xs = (id: string) => [...new Set((last.get(id) ?? []).map((c) => c[0]))].sort();
      // The cut is the cell boundary nearest the midpoint (x 6.5: boundary 6 or 7, rounding the middle up to 7).
      expect(xs('a'), order.join('')).toEqual([5, 6]);
      expect(xs('b'), order.join('')).toEqual([7]);
      expect(portals.stats()).toMatchObject({ joined: 2, shutWalk: 2 });
    }
  });
});
