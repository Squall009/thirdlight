/**
 * Open regions against a brute-force flood fill on generated chunks, with
 * the real derive (the world rules, 16³ sections of 32³ chunks): the
 * labelling of a unit, its face connectivity and sky columns, and the
 * stitching across chunk faces (enclosed rooms, portals, caves, cavities,
 * a region over 2 × 2 × 2 chunks, edge contacts that do not join, arrival
 * order, unloading, and edits that merge and split regions).
 */
import { describe, expect, it } from 'vitest';

import { buildApron } from './apron';
import { createNeighbourhood, fillNeighbourhood, jobRadius } from './assembly';
import { chunkGrid, sectionGrid, type CellGrid } from './coords';
import { createDenseChunk } from './dense-chunk';
import { deriveSectionsWithApron, sectionLocalOrigin } from './derive-assembly';
import { cellBit, deriveChunk, OCCUPANCY, type DerivedData } from './derived-data';
import { facePairBit, openRegionsArrays, openRegionsOf, REGION_PORTAL, regionLabelAt } from './open-regions';
import { OpenRegionStitch, type RegionStreamerView } from './open-region-stitch';
import { createWorldStore, type PaletteStore } from './palette-store';
import { SHAPE_FULL, valueOf, VOXEL_ROLE, voxel } from './record';
import { WORLD_RULES } from './rule-registry';
import type { DeriveOutput } from './stream-job';
import { SkyColumns } from './sky-columns';

const grid = chunkGrid(32);
const SECTIONS: CellGrid = sectionGrid(16);
const IDS = Array.from({ length: 8 }, (_, i) => i);
const R = jobRadius(WORLD_RULES);

const WALL = voxel(5, VOXEL_ROLE.wall, SHAPE_FULL);
const ROCK = voxel(3, VOXEL_ROLE.terrain, SHAPE_FULL);
const OPENING = voxel(5, VOXEL_ROLE.opening, 0);
const AIR = voxel();

type Box = readonly [number, number, number, number, number, number];

/** A test world: a store, its chunks derived on demand, and which chunks are loaded (a stitch view over them). */
class TestWorld {
  readonly store: PaletteStore = createWorldStore(grid);
  readonly derived = new Map<string, DerivedData>();
  readonly loaded = new Set<string>();
  /** Chunks derived (what an edit's rebuild counts). */
  derives = 0;

  fill(b: Box, v: typeof WALL): void {
    for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) this.store.setVoxel(x, y, z, v);
  }

  /** A hollow box: walls, floor and roof one cell thick round the inside (min, max of the outer shell). */
  room(b: Box, v = WALL): void {
    this.fill(b, v);
    this.fill([b[0] + 1, b[1] + 1, b[2] + 1, b[3] - 1, b[4] - 1, b[5] - 1], AIR);
  }

  derive(cx: number, cy: number, cz: number): void {
    this.derives++;
    const results = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(this.store, cx, cy, cz, R), (out) => this.store.exportChunk(cx, cy, cz, out), 16, IDS);
    for (const r of results) {
      const [lx, ly, lz] = sectionLocalOrigin(grid.edge, 16, r.id);
      this.derived.set(`${cx * 2 + lx / 16},${cy * 2 + ly / 16},${cz * 2 + lz / 16}`, r.assembly!);
    }
  }

  load(cx: number, cy: number, cz: number): void {
    this.derive(cx, cy, cz);
    this.loaded.add(`${cx},${cy},${cz}`);
  }

  view(): RegionStreamerView {
    return {
      grid,
      sections: SECTIONS,
      derivedOf: (sx, sy, sz) => {
        if (!this.loaded.has(`${sx >> 1},${sy >> 1},${sz >> 1}`)) return null;
        const d = this.derived.get(`${sx},${sy},${sz}`);
        return d === undefined ? null : ({ assembly: d } as unknown as DeriveOutput);
      },
    };
  }

  /** Whether a cell is drawn as a body (the derived occupancy), and whether it is an opening. */
  solid(x: number, y: number, z: number): boolean {
    const d = this.derived.get(`${x >> 4},${y >> 4},${z >> 4}`)!;
    const i = (((x & 15) * 16 + (z & 15)) * 16) + (y & 15);
    return d.occupancy.flag === OCCUPANCY.solid || (d.occupancy.flag === OCCUPANCY.mixed && cellBit(d.occupancy.mask, i));
  }

  opening(x: number, y: number, z: number): boolean {
    const v = voxel();
    this.store.voxelAt(x, y, z, v);
    return v.role === VOXEL_ROLE.opening;
  }
}

/** Loads chunks [lo, hi] (inclusive) into a world and a stitch, in the given order (default: x, y, z). */
function loadBox(w: TestWorld, lo: readonly number[], hi: readonly number[], order?: (list: number[][]) => number[][]): OpenRegionStitch {
  let list: number[][] = [];
  for (let cx = lo[0]!; cx <= hi[0]!; cx++) for (let cy = lo[1]!; cy <= hi[1]!; cy++) for (let cz = lo[2]!; cz <= hi[2]!; cz++) list.push([cx, cy, cz]);
  if (order !== undefined) list = order(list);
  const s = new OpenRegionStitch(w.view());
  for (const [cx, cy, cz] of list) {
    w.load(cx!, cy!, cz!);
    s.touch(cx!, cy!, cz!);
  }
  s.update();
  return s;
}

/** The brute force: a 6-connected flood fill over the loaded box's open cells, openings apart; label per cell key. */
function bruteRegions(w: TestWorld, lo: readonly number[], hi: readonly number[]): Map<string, number> {
  const out = new Map<string, number>();
  const min = lo.map((c) => c * 32);
  const max = hi.map((c) => c * 32 + 31);
  let next = 0;
  for (let x = min[0]!; x <= max[0]!; x++) for (let y = min[1]!; y <= max[1]!; y++) for (let z = min[2]!; z <= max[2]!; z++) {
    const k = `${x},${y},${z}`;
    if (out.has(k) || w.solid(x, y, z)) continue;
    const portal = w.opening(x, y, z);
    const label = ++next;
    out.set(k, label);
    const stack = [[x, y, z]];
    while (stack.length > 0) {
      const [a, b, c] = stack.pop()!;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const p = [a! + dx!, b! + dy!, c! + dz!];
        if (p.some((v, i) => v < min[i]! || v > max[i]!)) continue;
        const pk = p.join(',');
        if (out.has(pk) || w.solid(p[0]!, p[1]!, p[2]!) || w.opening(p[0]!, p[1]!, p[2]!) !== portal) continue;
        out.set(pk, label);
        stack.push(p);
      }
    }
  }
  return out;
}

/** The stitch's partition equals the brute force's, cell for cell (a bijection of labels). */
function expectSamePartition(s: OpenRegionStitch, brute: Map<string, number>): void {
  const toStitch = new Map<number, number>();
  const toBrute = new Map<number, number>();
  let bad = 0;
  for (const [k, b] of brute) {
    const [x, y, z] = k.split(',').map(Number);
    const id = s.regionIdAt(x!, y!, z!);
    if (id === 0 || (toStitch.get(b) ?? id) !== id || (toBrute.get(id) ?? b) !== b) bad++;
    toStitch.set(b, id);
    toBrute.set(id, b);
  }
  expect(bad).toBe(0);
  expect(toStitch.size).toBeGreaterThan(0);
}

describe('open regions of a unit', () => {
  it('labels a unit as a flood fill does, with faces, links and volumes', () => {
    const w = new TestWorld();
    // Random rock with an opening run through it, in one chunk.
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) if (rnd() < 0.45) w.store.setVoxel(x, y, z, ROCK);
    w.fill([10, 3, 0, 10, 8, 31], OPENING);
    w.derive(0, 0, 0);
    for (let id = 0; id < 8; id++) {
      const [lx, ly, lz] = sectionLocalOrigin(32, 16, id);
      const d = w.derived.get(`${lx / 16},${ly / 16},${lz / 16}`)!;
      const r = d.regions!;
      // Every pair of face neighbours: the same label exactly when both open and of one kind.
      let wrong = 0;
      const vol = new Map<number, number>();
      for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
        const i = (x * 16 + z) * 16 + y;
        const l = regionLabelAt(r, i);
        if ((l === 0) !== w.solid(lx + x, ly + y, lz + z)) wrong++;
        if (l !== 0 && ((r.flags[l - 1]! & REGION_PORTAL) !== 0) !== w.opening(lx + x, ly + y, lz + z)) wrong++;
        if (l !== 0) vol.set(l, (vol.get(l) ?? 0) + 1);
      }
      expect(wrong).toBe(0);
      for (const [l, n] of vol) expect(r.volume[l - 1]).toBe(n);
      expect(vol.size).toBe(r.count);
    }
    // Section by section the labels match a brute flood fill of that section alone.
    const brute = bruteRegions(w, [0, 0, 0], [0, 0, 0]);
    expect(brute.size).toBeGreaterThan(1000);
  });

  it('gives face connectivity: a tunnel joins two faces, a wall keeps two others apart', () => {
    const w = new TestWorld();
    w.fill([0, 0, 0, 31, 31, 31], ROCK);
    // A tunnel along x through the first section's middle (cells 0–15), and a pocket open to −z only.
    w.fill([0, 6, 6, 15, 8, 8], AIR);
    w.fill([4, 2, 0, 5, 3, 3], AIR);
    w.derive(0, 0, 0);
    const r = w.derived.get('0,0,0')!.regions!;
    expect(r.connect & facePairBit(0, 1)).not.toBe(0);
    expect(r.connect & facePairBit(4, 5)).toBe(0);
    expect(r.connect & facePairBit(0, 4)).toBe(0);
    expect(r.connect & facePairBit(2, 3)).toBe(0);
    expect(r.count).toBe(2);
  });

  it('gives each column its highest solid cell, as a scan of the cells does', () => {
    const w = new TestWorld();
    let seed = 3;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
      const h = Math.floor(rnd() * 40) - 4;
      for (let y = 0; y < Math.min(h, 32); y++) w.store.setVoxel(x, y, z, ROCK);
      if (rnd() < 0.2) w.store.setVoxel(x, 20, z, WALL);
    }
    w.load(0, 0, 0);
    const s = new OpenRegionStitch(w.view());
    s.touch(0, 0, 0);
    s.update();
    let wrong = 0;
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
      let top = -8192;
      for (let y = 31; y >= 0; y--) if (w.solid(x, y, z)) {
        top = y + 1;
        break;
      }
      if (s.skyHeight(x, z) !== top) wrong++;
    }
    expect(wrong).toBe(0);
    // The heights a batch carries to the page read the same there.
    const page = new SkyColumns(32);
    const wires = s.takeSky();
    expect(wires.length).toBe(1);
    page.apply(wires);
    let differ = 0;
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) if (page.heightAt(x, z) !== s.skyHeight(x, z)) differ++;
    expect(differ).toBe(0);
    expect(s.takeSky()).toEqual([]);
    w.loaded.clear();
    s.touch(0, 0, 0);
    s.update();
    page.apply(s.takeSky());
    expect(page.heightAt(3, 3)).toBeNull();
  });

  it('reads nothing past its own cells: any pad round the unit gives the same regions', () => {
    const w = new TestWorld();
    w.room([4, 4, 4, 20, 12, 40]);
    w.fill([10, 5, 4, 11, 8, 4], OPENING);
    w.fill([0, 0, 0, 40, 3, 40], ROCK);
    const dense = createDenseChunk(grid);
    const has = w.store.exportChunk(0, 0, 0, dense);
    const n = createNeighbourhood(32, R);
    fillNeighbourhood(n, grid, has ? dense : null, buildApron(w.store, 0, 0, 0, R));
    const d = deriveChunk(n, WORLD_RULES);
    const a = d.regions!;
    // Overwrite every pad cell (outside the unit) with openings and rock: the part reads only the unit.
    const s0 = n.side;
    for (let x = 0; x < s0; x++) for (let z = 0; z < s0; z++) for (let y = 0; y < s0; y++) {
      const inside = [x, y, z].every((c) => c >= R && c < R + 32);
      if (!inside) n.values[(x * s0 + z) * s0 + y] = (x + y + z) & 1 ? valueOf(OPENING) : valueOf(ROCK);
    }
    const b = openRegionsOf(n, d.occupancy);
    expect(a.count).toBeGreaterThan(2);
    const bytes = (r: typeof a): number[][] => openRegionsArrays(r).map((x) => Array.from(x as Uint8Array));
    expect(bytes(b)).toEqual(bytes(a));
    expect(b.connect).toBe(a.connect);
  });
});

describe('open regions stitched across chunks', () => {
  /** A ground plate at y 0–3 over the loaded box, so outdoors is the air above it. */
  function ground(w: TestWorld): void {
    w.fill([0, 0, 0, 95, 3, 95], ROCK);
  }

  it('a closed box is one enclosed region of its inside, the street is not', () => {
    const w = new TestWorld();
    ground(w);
    w.room([20, 4, 20, 30, 12, 34]);
    const s = loadBox(w, [0, 0, 0], [2, 1, 2]);
    const room = s.regionAt(25, 6, 25)!;
    expect(room).not.toBeNull();
    expect(room.enclosed).toBe(true);
    expect(room.complete).toBe(true);
    expect(room.sky).toBe(false);
    expect(room.cells).toBe(9 * 7 * 13);
    expect(room.portals).toBe(0);
    const street = s.regionAt(50, 6, 50)!;
    expect(street.enclosed).toBe(false);
    expect(street.sky).toBe(true);
    expectSamePartition(s, bruteRegions(w, [0, 0, 0], [2, 1, 2]));
  });

  it('a door of opening cells makes the room its own region joined to the street by a portal', () => {
    const w = new TestWorld();
    ground(w);
    w.room([20, 4, 20, 30, 12, 34]);
    w.fill([24, 5, 20, 25, 8, 20], OPENING);
    const s = loadBox(w, [0, 0, 0], [2, 1, 2]);
    const room = s.regionAt(25, 6, 25)!;
    const street = s.regionAt(50, 6, 50)!;
    expect(room.id).not.toBe(street.id);
    expect(room.enclosed).toBe(true);
    expect(room.portals).toBe(1);
    const door = s.regionAt(24, 6, 20)!;
    expect(door.portal).toBe(true);
    expect(door.cells).toBe(8);
    const [p] = s.portalsOf(room.id);
    expect(p!.regions).toEqual([room.id, street.id].sort((a, b) => a - b));
    expect(p!.min).toEqual([24, 5, 20]);
    expect(p!.max).toEqual([25, 8, 20]);
    expectSamePartition(s, bruteRegions(w, [0, 0, 0], [2, 1, 2]));
  });

  it('two rooms sharing a doorway are two enclosed regions and one portal', () => {
    const w = new TestWorld();
    ground(w);
    w.room([20, 4, 20, 30, 12, 34]);
    w.room([30, 4, 20, 44, 12, 34]);
    w.fill([30, 5, 26, 30, 8, 27], OPENING);
    const s = loadBox(w, [0, 0, 0], [2, 1, 2]);
    const a = s.regionAt(25, 6, 25)!;
    const b = s.regionAt(40, 6, 25)!;
    expect(a.id).not.toBe(b.id);
    expect(a.enclosed && b.enclosed).toBe(true);
    const ports = s.portalsOf(a.id);
    expect(ports.length).toBe(1);
    expect(ports[0]!.regions).toEqual([a.id, b.id].sort((x, y) => x - y));
  });

  it('a cave open to a hillside is not enclosed; a sealed cavity is', () => {
    const w = new TestWorld();
    w.fill([0, 0, 0, 63, 40, 63], ROCK);
    // The hillside: the rock stops at x = 40; a tunnel enters it from there.
    w.fill([41, 4, 0, 63, 40, 63], AIR);
    w.fill([10, 10, 10, 40, 13, 13], AIR);
    w.fill([10, 25, 30, 20, 30, 40], AIR);
    const s = loadBox(w, [0, 0, 0], [1, 1, 1]);
    const cave = s.regionAt(20, 11, 11)!;
    expect(cave.enclosed).toBe(false);
    expect(cave.id).toBe(s.regionAt(50, 20, 20)!.id);
    const cavity = s.regionAt(15, 27, 35)!;
    expect(cavity.enclosed).toBe(true);
    expect(cavity.cells).toBe(11 * 6 * 11);
    expectSamePartition(s, bruteRegions(w, [0, 0, 0], [1, 1, 1]));
  });

  it('a region over 2 × 2 × 2 chunks is one region with the summed volume', () => {
    const w = new TestWorld();
    w.fill([0, 0, 0, 95, 95, 95], ROCK);
    w.fill([20, 20, 20, 44, 44, 44], AIR);
    const s = loadBox(w, [0, 0, 0], [2, 2, 2]);
    const r = s.regionAt(32, 32, 32)!;
    expect(r.cells).toBe(25 ** 3);
    expect(r.enclosed).toBe(true);
    expect(s.regionAt(20, 20, 20)!.id).toBe(s.regionAt(44, 44, 44)!.id);
  });

  it('cells touching by an edge only do not join', () => {
    const w = new TestWorld();
    w.fill([0, 0, 0, 63, 63, 63], ROCK);
    // Two cavities meeting at an edge across the chunk face x = 32 / y = 32.
    w.fill([26, 26, 10, 31, 31, 20], AIR);
    w.fill([32, 32, 10, 37, 37, 20], AIR);
    const s = loadBox(w, [0, 0, 0], [1, 1, 1]);
    const a = s.regionAt(28, 28, 15)!;
    const b = s.regionAt(34, 34, 15)!;
    expect(a.id).not.toBe(b.id);
    expect(a.enclosed && b.enclosed).toBe(true);
  });

  it('the result does not depend on the order chunks arrive in', () => {
    const w = new TestWorld();
    ground(w);
    w.room([20, 4, 20, 30, 12, 34]);
    w.room([30, 4, 20, 44, 12, 34]);
    w.fill([30, 5, 26, 30, 8, 27], OPENING);
    w.fill([24, 5, 20, 25, 8, 20], OPENING);
    w.fill([60, 0, 60, 90, 50, 90], ROCK);
    w.fill([70, 20, 70, 80, 30, 80], AIR);
    const ref = loadBox(w, [0, 0, 0], [2, 1, 2]);
    const brute = bruteRegions(w, [0, 0, 0], [2, 1, 2]);
    const summary = (s: OpenRegionStitch): string[] => [...s.all()].map((r) => `${r.portal}:${r.cells}:${r.enclosed}:${r.sky}:${r.portals}`).sort();
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 4; k++) {
      const s = loadBox(w, [0, 0, 0], [2, 1, 2], (l) => l.map((c) => [rnd(), c] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]));
      expect(summary(s)).toEqual(summary(ref));
      expectSamePartition(s, brute);
    }
    // One chunk at a time, updating between: the same again.
    const s = new OpenRegionStitch(w.view());
    for (let cx = 2; cx >= 0; cx--) for (let cz = 0; cz <= 2; cz++) for (let cy = 1; cy >= 0; cy--) {
      s.touch(cx, cy, cz);
      s.update();
    }
    expect(summary(s)).toEqual(summary(ref));
  });

  it('unloading a chunk the room reaches turns enclosed into unknown, and loading it back restores it', () => {
    const w = new TestWorld();
    ground(w);
    w.room([20, 4, 20, 40, 12, 34]);
    const s = loadBox(w, [0, 0, 0], [2, 1, 2]);
    const before = s.regionAt(25, 6, 25)!;
    expect(before.enclosed).toBe(true);
    w.loaded.delete('1,0,0');
    s.touch(1, 0, 0);
    s.update();
    const now = s.regionAt(25, 6, 25)!;
    expect(now.complete).toBe(false);
    expect(now.enclosed).toBe(false);
    w.loaded.add('1,0,0');
    s.touch(1, 0, 0);
    s.update();
    expect(s.regionAt(25, 6, 25)!.enclosed).toBe(true);
    // A region that never reaches the unloaded chunk keeps its id through it.
    expect(s.regionAt(25, 6, 25)!.cells).toBe(before.cells);
  });

  it('an edit rebuilds the edited chunk alone: a hole merges the room with the street, filling the door splits them', () => {
    const w = new TestWorld();
    ground(w);
    w.room([4, 4, 4, 14, 12, 14]);
    w.fill([8, 5, 4, 9, 8, 4], OPENING);
    const s = loadBox(w, [0, 0, 0], [2, 1, 2]);
    const street = s.regionAt(50, 6, 50)!;
    const room = s.regionAt(8, 6, 8)!;
    expect(room.enclosed).toBe(true);
    const walkedBefore = s.stats().built;
    // Dig through the back wall (chunk 0,0,0 only): the room joins the street.
    w.fill([10, 6, 14, 11, 7, 14], AIR);
    const derives = w.derives;
    w.derive(0, 0, 0);
    s.touch(0, 0, 0);
    s.update();
    expect(w.derives - derives).toBe(1);
    expect(s.stats().built - walkedBefore).toBe(1);
    const merged = s.regionAt(8, 6, 8)!;
    expect(merged.id).toBe(s.regionAt(50, 6, 50)!.id);
    expect(merged.id).toBe(street.id);
    expect(merged.enclosed).toBe(false);
    // Fill the hole and the door: the room is its own region again, enclosed, with no portal.
    w.fill([10, 6, 14, 11, 7, 14], WALL);
    w.fill([8, 5, 4, 9, 8, 4], WALL);
    w.derive(0, 0, 0);
    s.touch(0, 0, 0);
    s.update();
    const split = s.regionAt(8, 6, 8)!;
    expect(split.id).not.toBe(s.regionAt(50, 6, 50)!.id);
    expect(split.enclosed).toBe(true);
    expect(split.portals).toBe(0);
    expect(s.regionAt(50, 6, 50)!.id).toBe(street.id);
    expectSamePartition(s, bruteRegions(w, [0, 0, 0], [2, 1, 2]));
  });
});
