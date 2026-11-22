import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { OCCUPANCY } from './derived-data';
import { GridFrame } from './grid-place';
import { GridWalkIndex, walkWithGrids, type GridWalk } from './grid-walk';
import { OpenRegionStitch, type RegionStreamerView } from './open-region-stitch';
import { walkVoxels, type WalkBlockView, type WalkSource } from './occupancy-walk';
import { PropLightChannel, type LitStamp } from './prop-channel';
import { recordValue, VOXEL_ROLE } from './record';
import type { DeriveOutput } from './stream-job';
import { gridStampBounds, gridStampCells, STAMP_CLASS, stampClassOfValue, stampGrid, STRUCTURE_STAMP_RULES, type GridStampCells, type StructureStampRule } from './structure-stamp';
import { streamerWalkSource, type WalkStreamerView } from './walk-sources';
import { walkRay } from './walk-steps';

const grid = chunkGrid(32);
const M = 0.5;

/** A test house in grid cells: a 20 × 16 room, walls one cell thick, a floor and a ceiling, 8 cells tall; a window 2 × 2 at x 9–10 on the z = 0 wall, a door 2 × 4 at z 7–8 on the x = 0 wall. */
const HOUSE: [number, number, number] = [20, 10, 16];
function houseClass(x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= HOUSE[0] || y >= HOUSE[1] || z >= HOUSE[2]) return STAMP_CLASS.open;
  if (y === 0 || y === 9) return STAMP_CLASS.stop;
  const wall = x === 0 || x === HOUSE[0] - 1 || z === 0 || z === HOUSE[2] - 1;
  if (!wall) return STAMP_CLASS.open;
  if (z === 0 && (x === 9 || x === 10) && (y === 4 || y === 5)) return STAMP_CLASS.opening;
  if (x === 0 && (z === 7 || z === 8) && y >= 1 && y <= 4) return STAMP_CLASS.opening;
  return STAMP_CLASS.stop;
}
const houseCells = (): GridStampCells => gridStampCells([0, 0, 0], HOUSE, houseClass);

/** The house's cells as a walk source in its own frame (16³ blocks, read cell by cell). */
const houseSource: WalkSource = {
  maxLevel: 0,
  blockShift: () => 4,
  block: (_level, bx, by, bz) => {
    const view: WalkBlockView = { flag: OCCUPANCY.mixed, brick: () => OCCUPANCY.mixed, cell: (i) => houseClass(bx * 16 + Math.floor(i / 256), by * 16 + (i % 16), bz * 16 + (Math.floor(i / 16) % 16)) === STAMP_CLASS.stop };
    return view;
  },
};

/** A world of air over chunks −2 … 2 (every section known, as a streamer's derived air), with a channel loaded over it. */
const known = (sx: number, sy: number, sz: number): boolean => [sx, sy, sz].every((v) => v >= -4 && v < 6);
const airView: WalkStreamerView = {
  sections: { shift: 4 },
  grid,
  derivedOf: (sx, sy, sz) => (known(sx, sy, sz) ? ({ assembly: null } as DeriveOutput) : null),
  mips: null,
  isResident: () => true,
  voxelAt: (_x, _y, _z, out) => out,
};
function channel(): PropLightChannel {
  const ch = new PropLightChannel({ grid, setPart: () => true }, M);
  for (let cx = -2; cx <= 2; cx++) for (let cy = -2; cy <= 2; cy++) for (let cz = -2; cz <= 2; cz++) ch.loaded(cx, cy, cz);
  return ch;
}
const stampOf = (cells: GridStampCells, frame: GridFrame, rule: StructureStampRule): LitStamp => ({ stamp: true, bounds: () => gridStampBounds(cells, frame, M), sample: (m) => stampGrid(cells, frame, rule, m) });

/** A house placed with its middle at (3, 0, 2) m (so it spans chunk faces and negative cells), turned by `deg`. */
function frameAt(deg: number): GridFrame {
  const mid = [(HOUSE[0] * M) / 2, 0, (HOUSE[2] * M) / 2];
  const turn = new GridFrame({ gridId: 1, position: [0, 0, 0], yawRad: (deg * Math.PI) / 180 });
  const off = turn.toWorld(-mid[0]!, 0, -mid[2]!);
  return new GridFrame({ gridId: 1, position: [3 + off[0], 0, 2 + off[2]], yawRad: (deg * Math.PI) / 180 });
}

let seed = 7;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

/** Rays (grid frame) from outside the walls toward the room, away from the openings by two cells or more, and through the openings' middles. */
function rays(n: number): { across: { o: number[]; d: number[]; t: number }[]; through: { o: number[]; d: number[]; t: number }[] } {
  const across: { o: number[]; d: number[]; t: number }[] = [];
  const through: { o: number[]; d: number[]; t: number }[] = [];
  const to = (o: number[], p: number[]): { o: number[]; d: number[]; t: number } => {
    const d = p.map((v, a) => v - o[a]!);
    return { o, d, t: Math.hypot(d[0]!, d[1]!, d[2]!) };
  };
  while (across.length < n) {
    // A wall face cell of the z = 0 or the x = 0 wall, the point inside a room 2 m in.
    const onZ = rnd() < 0.5;
    const along = 1 + rnd() * ((onZ ? HOUSE[0] : HOUSE[2]) - 2);
    const y = 1 + rnd() * 8;
    if (onZ ? along > 7 && along < 13 : along > 5 && along < 11) continue;
    const face = onZ ? [along * M, y * M, 0] : [0, y * M, along * M];
    const out = onZ ? [face[0]! + (rnd() - 0.5), face[1]!, -1.5] : [-1.5, face[1]!, face[2]! + (rnd() - 0.5)];
    const into = onZ ? [face[0]!, face[1]!, 2] : [2, face[1]!, face[2]!];
    across.push(to(out, into));
  }
  for (let k = 0; k < n; k++) {
    const window = k % 2 === 0;
    const mid = window ? [10 * M, 5 * M, 0] : [0, 3 * M, 8 * M];
    const out = window ? [mid[0]! + (rnd() - 0.5) * 0.2, mid[1]! + (rnd() - 0.5) * 0.2, -2] : [-2, mid[1]! + (rnd() - 0.5) * 0.4, mid[2]! + (rnd() - 0.5) * 0.2];
    const into = window ? [mid[0]!, mid[1]!, 1] : [1, mid[1]!, mid[2]!];
    through.push(to(out, into));
  }
  return { across, through };
}

/** Of `list` (grid frame), the rays E stops and S lets pass (leaks), those S stops (blocked), out of the list's. */
function compare(frame: GridFrame, rule: StructureStampRule, list: { o: number[]; d: number[]; t: number }[]): { leaks: number; stoppedByS: number; stoppedByE: number } {
  const ch = channel();
  ch.place('grid:1', stampOf(houseCells(), frame, rule));
  const s = streamerWalkSource(airView, null, { props: ch });
  const gw: GridWalk = { frame, source: houseSource, box: { lo: [0, 0, 0], hi: [HOUSE[0] * M, HOUSE[1] * M, HOUSE[2] * M] } };
  const air = streamerWalkSource(airView, null);
  let leaks = 0;
  let stoppedByS = 0;
  let stoppedByE = 0;
  for (const r of list) {
    const o = frame.toWorld(r.o[0]!, r.o[1]!, r.o[2]!);
    const p = frame.toWorld(r.o[0]! + r.d[0]!, r.o[1]! + r.d[1]!, r.o[2]! + r.d[2]!);
    const ray = walkRay(o, [p[0] - o[0], p[1] - o[1], p[2] - o[2]])!;
    const e = walkWithGrids(air, [gw], ray, r.t, { stop: 'light' }) !== null;
    const sh = walkVoxels(s, ray, r.t, { stop: 'light' }).hit !== null;
    if (e) stoppedByE++;
    if (sh) stoppedByS++;
    if (e && !sh) leaks++;
  }
  return { leaks, stoppedByS, stoppedByE };
}

describe('structure grids stamped into the world grid', () => {
  it('reads a cell from its record: construction stops, openings are openings, air and thin damage are open', () => {
    expect(stampClassOfValue(recordValue(3, VOXEL_ROLE.wall, 15, 0))).toBe(STAMP_CLASS.stop);
    expect(stampClassOfValue(recordValue(3, VOXEL_ROLE.opening, 15, 0))).toBe(STAMP_CLASS.opening);
    expect(stampClassOfValue(recordValue(0, VOXEL_ROLE.air, 0, 0))).toBe(STAMP_CLASS.open);
    // Integrity 4 of 15 covers under half: light passes it, as the derive's coverage says.
    expect(stampClassOfValue(recordValue(3, VOXEL_ROLE.wall, 4, 0))).toBe(STAMP_CLASS.open);
    expect(stampClassOfValue(recordValue(1, VOXEL_ROLE.terrain, 15, 0))).toBe(STAMP_CLASS.stop);
    expect(stampClassOfValue(recordValue(1, VOXEL_ROLE.terrain, 4, 0))).toBe(STAMP_CLASS.open);
  });

  it('a grid at 0° on the world lattice stamps exactly its own cells, under every rule', () => {
    const cells = houseCells();
    const frame = new GridFrame({ gridId: 1, position: [-3, 1, 2.5], yawRad: 0 });
    for (const rule of STRUCTURE_STAMP_RULES) {
      const s = stampGrid(cells, frame, rule, M);
      expect(s.lo).toEqual([-6, 2, 5]);
      expect(s.size).toEqual(HOUSE);
      let differ = 0;
      for (let x = 0; x < HOUSE[0]; x++) for (let z = 0; z < HOUSE[2]; z++) for (let y = 0; y < HOUSE[1]; y++) {
        const i = (x * HOUSE[2] + z) * HOUSE[1] + y;
        const want = houseClass(x, y, z);
        if (s.classes[i] !== want || s.bytes[i] !== (want === STAMP_CLASS.stop ? 255 : 0)) differ++;
      }
      expect(differ, rule).toBe(0);
    }
  });

  it('a wall one cell thick turned 30° or 45°: the share rule leaks under one ray in 500 away from the openings, and keeps the window and door open; one sample filling a cell closes them', () => {
    const { across, through } = rays(2000);
    for (const deg of [30, 45]) {
      const f = frameAt(deg);
      const share = compare(f, 'share', across);
      // E stops every ray across a closed wall.
      expect(share.stoppedByE).toBe(across.length);
      expect(share.leaks, `${deg}°`).toBeLessThan(across.length / 500);
      const open = compare(f, 'share', through);
      expect(open.stoppedByE).toBe(0);
      expect(open.stoppedByS, `${deg}° share through the openings' middles`).toBe(0);
      expect(compare(f, 'roles', through).stoppedByS).toBe(0);
      expect(compare(f, 'any', through).stoppedByS, `${deg}° any`).toBeGreaterThan(through.length / 2);
    }
  });

  it('stamped regions: the turned room is one enclosed region whose window and door are portals', () => {
    for (const deg of [0, 30, 45]) {
      const ch = channel();
      const f = frameAt(deg);
      ch.place('grid:1', stampOf(houseCells(), f, 'share'));
      const view: RegionStreamerView = { grid, sections: chunkGrid(16), derivedOf: (sx, sy, sz) => airView.derivedOf(sx, sy, sz) };
      const s = new OpenRegionStitch(view, ch);
      for (let cx = -2; cx <= 2; cx++) for (let cy = -2; cy <= 2; cy++) for (let cz = -2; cz <= 2; cz++) s.touch(cx, cy, cz);
      s.update();
      const mid = f.toWorld(10 * M, 5 * M, 8 * M);
      const room = s.regionAt(Math.floor(mid[0] / M), Math.floor(mid[1] / M), Math.floor(mid[2] / M))!;
      expect(room.enclosed, `${deg}°`).toBe(true);
      expect(s.portalsOf(room.id).length, `${deg}°`).toBe(2);
      // 18 × 8 × 14 cells inside; a turned stamp may take up to a cell off each wall.
      expect(room.cells).toBeLessThanOrEqual(18 * 8 * 14 + 200);
      expect(room.cells).toBeGreaterThan(14 * 8 * 10);
      // The sky heights see its ceiling.
      expect(s.skyAt(Math.floor(mid[0] / M), Math.floor(mid[1] / M), Math.floor(mid[2] / M))).toBe(false);
    }
  });

  it('a moved grid recombines only the chunks it left and entered, and leaves nothing where it stood', () => {
    const ch = channel();
    const cells = houseCells();
    const a = new GridFrame({ gridId: 1, position: [-12, 0, -12], yawRad: 0.4 });
    const b = new GridFrame({ gridId: 1, position: [14, 0, 14], yawRad: 0.4 });
    const chunksOf = (f: GridFrame): Set<string> => {
      const bd = gridStampBounds(cells, f, M);
      const out = new Set<string>();
      for (let cx = Math.floor(bd.min[0]! / 16); cx <= Math.floor(bd.max[0]! / 16); cx++) for (let cy = Math.floor(bd.min[1]! / 16); cy <= Math.floor(bd.max[1]! / 16); cy++) for (let cz = Math.floor(bd.min[2]! / 16); cz <= Math.floor(bd.max[2]! / 16); cz++) out.add(`${cx},${cy},${cz}`);
      return out;
    };
    ch.place('grid:1', stampOf(cells, a, 'share'));
    const built: string[] = [];
    ch.onBuild = (cx, cy, cz) => built.push(`${cx},${cy},${cz}`);
    ch.place('grid:1', stampOf(cells, b, 'share'));
    const want = new Set([...chunksOf(a), ...chunksOf(b)]);
    expect(new Set(built)).toEqual(want);
    for (const k of chunksOf(a)) {
      if (chunksOf(b).has(k)) continue;
      const [cx, cy, cz] = k.split(',').map(Number) as [number, number, number];
      expect(ch.rooms(cx, cy, cz)).toBeNull();
      expect(ch.chunk(cx, cy, cz)).toBeNull();
    }
    // The mip levels see the house where it now stands: some level-1 cells over it stop.
    const at = b.toWorld(5, 2, 4);
    const n = [Math.floor(at[0] / M) >> 6, Math.floor(at[1] / M) >> 6, Math.floor(at[2] / M) >> 6];
    expect(ch.mipStops(1, n[0]!, n[1]!, n[2]!)).not.toBeNull();
    ch.remove('grid:1');
    expect(ch.mipStops(1, n[0]!, n[1]!, n[2]!)).toBeNull();
  });

  it('with no grids nothing changes: no classes, no mip stops, the walk views and regions as without a channel', () => {
    const ch = channel();
    expect(ch.stats().classBytes).toBe(0);
    expect(ch.mipStops(1, 0, 0, 0)).toBeNull();
    const view: RegionStreamerView = { grid, sections: chunkGrid(16), derivedOf: (sx, sy, sz) => airView.derivedOf(sx, sy, sz) };
    const a = new OpenRegionStitch(view, ch);
    const b = new OpenRegionStitch(view);
    for (const s of [a, b]) {
      for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) s.touch(cx, 0, cz);
      s.update();
    }
    expect(a.stats()).toEqual(b.stats());
    const src = streamerWalkSource(airView, null, { props: ch });
    const plain = streamerWalkSource(airView, null);
    expect(src.block(0, 0, 0, 0, 'light')).toBe(plain.block(0, 0, 0, 0, 'light'));
  });

  it('the walk into a grid\'s frame stops where a fine march through the turned cells first meets a stopping cell', () => {
    const f = frameAt(30);
    const gw: GridWalk = { frame: f, source: houseSource, box: { lo: [0, 0, 0], hi: [HOUSE[0] * M, HOUSE[1] * M, HOUSE[2] * M] } };
    const air = streamerWalkSource(airView, null);
    let hits = 0;
    for (let k = 0; k < 300; k++) {
      const o = [3 + (rnd() - 0.5) * 30, 0.5 + rnd() * 4, 2 + (rnd() - 0.5) * 30];
      const tgt = [3 + (rnd() - 0.5) * 8, 0.5 + rnd() * 4, 2 + (rnd() - 0.5) * 6];
      const d = tgt.map((v, a) => v - o[a]!);
      const len = Math.hypot(d[0]!, d[1]!, d[2]!);
      const ray = walkRay(o, d)!;
      const h = walkWithGrids(air, [gw], ray, 40, { stop: 'light' });
      // The march: 2 mm steps in the grid's frame.
      let want: number | null = null;
      for (let t = 0; t < 40; t += 0.002) {
        const q = f.toGrid(o[0]! + (d[0]! / len) * t, o[1]! + (d[1]! / len) * t, o[2]! + (d[2]! / len) * t);
        if (houseClass(Math.floor(q[0] / M), Math.floor(q[1] / M), Math.floor(q[2] / M)) === STAMP_CLASS.stop) {
          want = t;
          break;
        }
      }
      expect(h === null, `ray ${k}`).toBe(want === null);
      if (h !== null && want !== null) {
        hits++;
        expect(h.gridId).toBe(1);
        expect(Math.abs(h.t - want)).toBeLessThan(0.004);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });
});

describe('structure grids filed by tile for rays', () => {
  it('a ray tests only the grids along its way and meets what testing every grid meets (a town of 64 houses at 0°, 30° and 45°)', () => {
    const air = streamerWalkSource(airView, null);
    const grids: GridWalk[] = [];
    for (let i = 0; i < 64; i++) {
      const deg = [0, 30, 45][i % 3]!;
      const yaw = (deg * Math.PI) / 180;
      grids.push({ frame: new GridFrame({ gridId: i + 1, position: [(i % 8) * 14 - 50, 0, Math.floor(i / 8) * 12 - 45], yawRad: yaw }), source: houseSource, box: { lo: [0, 0, 0], hi: [HOUSE[0] * M, HOUSE[1] * M, HOUSE[2] * M] } });
    }
    const index = new GridWalkIndex(grids);
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let along = 0;
    let same = 0;
    const N = 400;
    for (let k = 0; k < N; k++) {
      const o = [rnd() * 120 - 60, rnd() * 4 + 0.25, rnd() * 110 - 55];
      const a = rnd() * Math.PI * 2;
      const ray = walkRay(o, [Math.cos(a), rnd() * 0.2 - 0.1, Math.sin(a)])!;
      const t = 5 + rnd() * 40;
      const list = index.along(ray, t);
      along += list.length;
      const all = walkWithGrids(air, grids, ray, t, { stop: 'solid' });
      const some = walkWithGrids(air, list, ray, t, { stop: 'solid' });
      if ((all === null && some === null) || (all !== null && some !== null && all.gridId === some.gridId && all.t === some.t && all.hit.cell.every((v, i) => v === some.hit.cell[i]))) same++;
    }
    expect(same).toBe(N);
    // A few boxes a ray, not the 64.
    expect(along / N).toBeLessThan(12);
    // A vertical ray tests its tile's grids alone.
    expect(index.along(walkRay([grids[9]!.frame.position[0] + 1, 20, grids[9]!.frame.position[2] + 1], [0, -1, 0])!, 30).map((g) => g.frame.gridId)).toContain(10);
  });
});
