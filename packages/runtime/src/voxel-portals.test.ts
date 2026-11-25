/**
 * Portal state on a structure's opening, against the real prop channel: a door prop joined to the opening it stands
 * in by its place alone (no definition), its shut state stamped into exactly the world cells the opening reaches at
 * 0°, 30° and 45° (every world cell whose middle lies in the opening stops light whole, though a turned stamp narrows
 * the opening), a flip recombining only the chunks those cells lie in, the walk graph told the opening's cells, and
 * opened, the channel back to what it was.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid, GridFrame, LIGHT_STOP_COVERAGE, PropLightChannel, streamerWalkSource, VOXEL_ROLE, VOXEL_SIZE_M, walkRay, walkVoxels, type VoxelRecord } from '@thirdlight/voxel';
import { WorldPortals } from './voxel-portals';
import type { VoxelGridHost } from './voxel-grid-host';

const grid = chunkGrid(32);
const M = VOXEL_SIZE_M;
/** A wall along x at z 0, rows 1 … 6, with a door at x 5 … 7, rows 1 … 5 (the e2e house's). */
const DOOR = { x: [5, 7], y: [1, 5], z: 0 } as const;

function gridHost(yawDeg: number, door: { readonly x: readonly [number, number]; readonly y: readonly [number, number]; readonly z: number } = DOOR, wallX = 12, wallY = 6): { host: VoxelGridHost; shut: Array<[string, unknown]> } {
  const frame = new GridFrame({ gridId: 1, position: [10.2, 0, -3.7], yawRad: (yawDeg * Math.PI) / 180 });
  const shut: Array<[string, unknown]> = [];
  const streamer = {
    grid,
    isResident: () => true,
    voxelAt: (x: number, y: number, z: number, out: VoxelRecord): VoxelRecord => {
      const inDoor = x >= door.x[0] && x <= door.x[1] && y >= door.y[0] && y <= door.y[1] && z === door.z;
      const wall = z === door.z && x >= 0 && x < wallX && y >= 1 && y <= wallY;
      out.material = inDoor || wall ? 9 : 0;
      out.role = inDoor ? VOXEL_ROLE.opening : wall ? VOXEL_ROLE.wall : VOXEL_ROLE.air;
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
      // What the grid's draws are given for the sun's shadow: its shut openings that stop light, each time they change.
      const given: Array<{ grid: unknown; openings: { id: string; cells: readonly number[] }[] }> = [];
      const portals = new WorldPortals(() => [host], () => ch, (g, openings) => given.push({ grid: g, openings }));
      const middle = host.frame.toWorld(((DOOR.x[0] + DOOR.x[1] + 1) / 2) * M, 1.5, (DOOR.z + 0.5) * M);
      portals.set([['door', { open: false, stops: { light: true, sight: true, walk: true }, at: [middle[0], middle[1], middle[2]] }]]);
      portals.step();
      ch.flush();
      expect(portals.stats()).toMatchObject({ joined: 1, shutLight: 1, shutWalk: 1 });
      // The sun's shadow is given the opening's 15 cells, in the grid's own frame, once.
      expect(given).toHaveLength(1);
      expect(given[0]!.grid).toBe(host);
      expect(given[0]!.openings.map((o) => o.id)).toEqual(['door']);
      const cells = given[0]!.openings[0]!.cells;
      expect(cells.length).toBe(15 * 3);
      for (let i = 0; i < cells.length; i += 3) expect([cells[i]! >= DOOR.x[0] && cells[i]! <= DOOR.x[1], cells[i + 1]! >= DOOR.y[0] && cells[i + 1]! <= DOOR.y[1], cells[i + 2]]).toEqual([true, true, DOOR.z]);
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
      // Opened, the grid's set is empty (its caster goes).
      expect(given).toHaveLength(2);
      expect(given[1]!.openings).toEqual([]);
      for (const k of built) expect(reached.has(k)).toBe(true);
      for (let x = 0; x < 60; x++) for (let y = 0; y < 8; y++) for (let z = -30; z < 10; z++) expect(ch.at(x, y, z)).toBe(0);
      // A pane (light passes) never stamps; a prop standing in no opening joins nothing.
      portals.set([['pane', { open: false, stops: { light: false, sight: false, walk: true }, at: [middle[0], middle[1], middle[2]] }], ['nowhere', { open: false, stops: { light: true, sight: true, walk: true }, at: [middle[0] + 40, 1, middle[2]] }]]);
      portals.step();
      ch.flush();
      expect(portals.stats()).toMatchObject({ joined: 2, shutLight: 0 });
      // A shut pane casts no shadow of the sun: nothing more is given.
      expect(given).toHaveLength(2);
      expect(portals.propOf([-1000, -1000, -1000], [1000, 1000, 1000])?.id).toBeDefined();
    });
  }

  for (const [name, door, wallX, wallY] of [
    ['a barn door 6.5 m wide', { x: [2, 14], y: [1, 6], z: 0 }, 18, 8],
    ['a slot 4.5 m tall', { x: [5, 6], y: [1, 9], z: 0 }, 12, 10],
  ] as const) {
    it(`${name} shuts whole: every world cell whose middle lies in it stops light, at level 0 and at the walk's mip levels, and opened, none`, () => {
      const { host, shut } = gridHost(30, door, wallX, wallY);
      const { ch } = channel();
      const portals = new WorldPortals(() => [host], () => ch);
      const mips: string[] = [];
      ch.listen((cx, cy, cz, classes, m) => {
        expect(classes, 'a shut door gives no class: the regions keep their portal').toBe(false);
        if (m) mips.push(`${cx},${cy},${cz}`);
      });
      // The prop stands at the opening's first column, its middle a cell up: the join finds the rest by the cells.
      const at = host.frame.toWorld((door.x[0] + 0.5) * M, (door.y[0] + 0.5) * M, (door.z + 0.5) * M);
      portals.set([['door', { open: false, stops: { light: true, sight: true, walk: true }, at: [at[0], at[1], at[2]] }]]);
      portals.step();
      ch.flush();
      const cells = (door.x[1] - door.x[0] + 1) * (door.y[1] - door.y[0] + 1);
      expect((shut[0]![1] as unknown[]).length, 'the walk graph is given every cell of the opening').toBe(cells);
      let inside = 0;
      const stopsAtMips = new Set<string>();
      for (let x = -10; x < 50; x++) for (let y = 0; y < 12; y++) for (let z = -30; z < 20; z++) {
        const g = host.frame.toGrid((x + 0.5) * M, (y + 0.5) * M, (z + 0.5) * M).map((v) => Math.floor(v / M));
        if (g[0]! < door.x[0] || g[0]! > door.x[1] || g[1]! < door.y[0] || g[1]! > door.y[1] || g[2] !== door.z) continue;
        inside++;
        expect(ch.at(x, y, z), `cell ${x},${y},${z}`).toBeGreaterThanOrEqual(LIGHT_STOP_COVERAGE);
        // Its level-1 cell stops light at the mips (a node of the level holds 32 of its cells a side).
        const m = ch.mipStops(1, Math.floor((x >> 1) / 32), Math.floor((y >> 1) / 32), Math.floor((z >> 1) / 32));
        const l = [(x >> 1) & 31, (y >> 1) & 31, (z >> 1) & 31];
        const i = (l[0]! * 32 + l[2]!) * 32 + l[1]!;
        if (m !== null && ((m[i >>> 5]! >>> (i & 31)) & 1) === 1) stopsAtMips.add(`${x >> 1},${y >> 1},${z >> 1}`);
        else throw new Error(`level-1 cell of ${x},${y},${z} does not stop light at the mips`);
      }
      expect(inside).toBeGreaterThan(cells * 0.6);
      expect(stopsAtMips.size).toBeGreaterThan(0);
      expect(mips.length, 'the chunks it reaches are told their mip levels changed').toBeGreaterThan(0);
      // A light ray walked past the detail ring (no level 0 known, the mip levels known and empty: open ground) from 3 m
      // before the opening's middle to 3 m behind it meets the shut door; opened, it passes.
      const ray = (): boolean => {
        const mid = [(door.x[0] + door.x[1] + 1) / 2, (door.y[0] + door.y[1] + 1) / 2];
        const a = host.frame.toWorld(mid[0]! * M, mid[1]! * M, (door.z + 0.5) * M - 3);
        const b = host.frame.toWorld(mid[0]! * M, mid[1]! * M, (door.z + 0.5) * M + 3);
        const src = streamerWalkSource({ sections: { shift: 4 }, grid: { shift: 5, edge: 32 }, derivedOf: () => null, mips: { maxLevel: 3, derivedOf: () => null }, isResident: () => true, voxelAt: (_x, _y, _z, o) => o }, null, { props: ch });
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        return walkVoxels(src, walkRay(a, d)!, Math.hypot(d[0]!, d[1]!, d[2]!), { stop: 'light' }).hit !== null;
      };
      expect(ray(), 'a coarse ray stops at the shut door').toBe(true);
      for (let L = 1; L <= 3; L++) expect(ch.mipStops(L, 0, 0, 0) ?? ch.mipStops(L, -1, 0, -1) ?? ch.mipStops(L, 0, 0, -1) ?? ch.mipStops(L, -1, 0, 0), `level ${L}`).not.toBeNull();
      portals.set([['door', { open: true, stops: { light: true, sight: true, walk: true }, at: [at[0], at[1], at[2]] }]]);
      ch.flush();
      for (let L = 1; L <= 3; L++) for (const [nx, nz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) expect(ch.mipStops(L, nx!, 0, nz!), `level ${L} opened`).toBeNull();
      expect(ray(), 'and passes it open').toBe(false);
      for (let x = -10; x < 50; x++) for (let y = 0; y < 12; y++) for (let z = -30; z < 20; z++) expect(ch.at(x, y, z)).toBe(0);
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
