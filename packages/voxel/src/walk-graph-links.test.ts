/**
 * Structure grids in the walk: a two-storey house (foundation, one-cell walls,
 * a 1 m door, a floor with a stair hole, a stair one cell up a cell along, a
 * flat roof) in a grid of its own on flat ground, with the real derive (the
 * world rules) in both frames. The world graph sees the house only through
 * its stamp (blocking, never carrying); the house's own graph is linked to
 * the world's at its doorstep; paths cross between them. Checked against the
 * same house written into the world grid (aligned: the same cells), and
 * turned 30°: street → room → upper storey, no point walked inside a wall of
 * the grid (its own cells), a way round the house, links made and dropped
 * with chunks, nothing made with no grid.
 */
import { describe, expect, it } from 'vitest';

import { buildApron } from './apron';
import { jobRadius } from './assembly';
import { chunkGrid, sectionGrid } from './coords';
import { deriveSectionsWithApron, sectionLocalOrigin } from './derive-assembly';
import type { DerivedData } from './derived-data';
import { GridFrame } from './grid-place';
import { createWorldStore, type PaletteStore } from './palette-store';
import { PropLightChannel } from './prop-channel';
import { SHAPE_FULL, VOXEL_ROLE, valueOf, voxel } from './record';
import { WORLD_RULES } from './rule-registry';
import type { DeriveOutput } from './stream-job';
import { gridStampBounds, gridStampCells, STAMP_CLASS, stampClassOfValue, stampGrid } from './structure-stamp';
import { sameWalkChunk } from './walk-graph-cells';
import { WalkGraph, type WalkGraphView } from './walk-graph';
import { LinkedWalkQueries, type LinkedPathAnswer } from './walk-graph-linked';
import { WalkGraphLinks } from './walk-graph-links';
import { WalkQueries, type WalkPathAnswer } from './walk-graph-queries';
import { stampedNav } from './walk-graph-stamp';

const grid = chunkGrid(32);
const SECTIONS = sectionGrid(16);
const IDS = Array.from({ length: 8 }, (_, i) => i);
const R = jobRadius(WORLD_RULES);
const M = 0.5;
type P3 = readonly [number, number, number];

const ROCK = voxel(3, VOXEL_ROLE.terrain, SHAPE_FULL);
const AIR = voxel();
/** The house's size (cells): x 0 … 19, z 0 … 15, two storeys of 6 cells, roof at 12. */
const HW = 20;
const HD = 16;

/** The house's voxel at a cell of its own frame (null: none). */
function houseCell(x: number, y: number, z: number): ReturnType<typeof voxel> | null {
  if (x < 0 || x >= HW || z < 0 || z >= HD || y < 0 || y > 12) return null;
  if (y === 0) return voxel(4, VOXEL_ROLE.foundation, SHAPE_FULL);
  if (y === 12) return voxel(6, VOXEL_ROLE.roof, SHAPE_FULL);
  const edge = x === 0 || x === HW - 1 || z === 0 || z === HD - 1;
  if (edge) {
    if (z === 0 && (x === 9 || x === 10) && y >= 1 && y <= 4) return voxel(5, VOXEL_ROLE.opening, 0);
    return voxel(5, VOXEL_ROLE.wall, SHAPE_FULL);
  }
  const lev = y % 6;
  // Stairs up the x = 1, 2 strip, one cell up a cell along z; the floor above has a hole over them.
  if ((x === 1 || x === 2) && y < 6 && lev >= 1 && z === lev + 1) return voxel(7, VOXEL_ROLE.stair, SHAPE_FULL);
  if (y === 6 && !((x === 1 || x === 2) && z >= 2 && z <= 7)) return voxel(7, VOXEL_ROLE.floor, SHAPE_FULL);
  return null;
}

/** A store and its derive by section, with a view the walk graph reads. */
class World {
  readonly store: PaletteStore = createWorldStore(grid);
  readonly derived = new Map<string, DerivedData>();
  readonly loaded = new Set<string>();

  derive(cx: number, cy: number, cz: number): void {
    const results = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(this.store, cx, cy, cz, R), (out) => this.store.exportChunk(cx, cy, cz, out), 16, IDS);
    for (const r of results) {
      const [lx, ly, lz] = sectionLocalOrigin(grid.edge, 16, r.id);
      this.derived.set(`${cx * 2 + lx / 16},${cy * 2 + ly / 16},${cz * 2 + lz / 16}`, r.assembly!);
    }
    this.loaded.add(`${cx},${cy},${cz}`);
  }

  view(): WalkGraphView {
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
}

/** World chunks: x, z −2 … 1, y −1 … 0 (ground's top at cell −1). */
const WLO: P3 = [-2, -1, -2];
const WHI: P3 = [1, 0, 1];
const each = (lo: P3, hi: P3, f: (cx: number, cy: number, cz: number) => void): void => {
  for (let cx = lo[0]; cx <= hi[0]; cx++) for (let cy = lo[1]; cy <= hi[1]; cy++) for (let cz = lo[2]; cz <= hi[2]; cz++) f(cx, cy, cz);
};

function ground(w: World): void {
  for (let x = WLO[0] * 32 - 32; x < (WHI[0] + 2) * 32; x++) for (let z = WLO[2] * 32 - 32; z < (WHI[2] + 2) * 32; z++) for (let y = -40; y <= -1; y++) w.store.setVoxel(x, y, z, ROCK);
}

/** Where the house's grid stands turned `yawDeg` about its footprint's middle (at 0° its cells are the world's: chunk faces where the world's are). */
function placeOf(yawDeg: number): GridFrame {
  const mid = [(HW / 2) * M, 0, (HD / 2) * M];
  const local = [(HW / 2) * M, 0, (HD / 2) * M];
  const yaw = (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return new GridFrame({ gridId: 1, position: [mid[0]! - (c * local[0]! + s * local[2]!), 0, mid[2]! - (-s * local[0]! + c * local[2]!)], yawRad: yaw });
}

/** The house as world cells at yaw 0 (the control: its cells are the grid's). */
function control(): { w: World; graph: WalkGraph } {
  const w = new World();
  ground(w);
  for (let x = 0; x < HW; x++) for (let y = 0; y <= 12; y++) for (let z = 0; z < HD; z++) {
    const v = houseCell(x, y, z);
    if (v !== null) w.store.setVoxel(x, y, z, v);
  }
  each(WLO, WHI, (cx, cy, cz) => w.derive(cx, cy, cz));
  const graph = new WalkGraph(w.view(), M);
  each(WLO, WHI, (cx, cy, cz) => graph.touch(cx, cy, cz));
  graph.update();
  return { w, graph };
}

interface Linked {
  world: World;
  house: World;
  frame: GridFrame;
  channel: PropLightChannel;
  worldGraph: WalkGraph;
  houseGraph: WalkGraph;
  links: WalkGraphLinks;
  queries: LinkedWalkQueries;
}

/** Ground in the world grid, the house in grid 1 turned `yawDeg`, stamped (share) into the world's channel, both graphs linked. */
function linked(yawDeg: number): Linked {
  const world = new World();
  ground(world);
  each(WLO, WHI, (cx, cy, cz) => world.derive(cx, cy, cz));
  const house = new World();
  for (let x = 0; x < HW; x++) for (let y = 0; y <= 12; y++) for (let z = 0; z < HD; z++) {
    const v = houseCell(x, y, z);
    if (v !== null) house.store.setVoxel(x, y, z, v);
  }
  house.derive(0, 0, 0);
  const frame = placeOf(yawDeg);
  const channel = new PropLightChannel({ grid, setPart: () => true }, M);
  each(WLO, WHI, (cx, cy, cz) => channel.loaded(cx, cy, cz));
  stamp(channel, house, frame);
  const worldGraph = new WalkGraph(world.view(), M, { stamps: channel });
  channel.listen((cx, cy, cz, classes) => classes && worldGraph.touchStamp(cx, cy, cz));
  each(WLO, WHI, (cx, cy, cz) => worldGraph.touch(cx, cy, cz));
  worldGraph.update();
  const houseGraph = new WalkGraph(house.view(), M);
  houseGraph.touch(0, 0, 0);
  houseGraph.update();
  const links = new WalkGraphLinks(worldGraph);
  links.add({ id: 1, frame, graph: houseGraph });
  links.update();
  return { world, house, frame, channel, worldGraph, houseGraph, links, queries: new LinkedWalkQueries(new WalkQueries(worldGraph), links) };
}

function stamp(channel: PropLightChannel, house: World, frame: GridFrame): void {
  const rec = voxel();
  const cells = gridStampCells([0, 0, 0], [HW, 13, HD], (x, y, z) => {
    house.store.voxelAt(x, y, z, rec);
    return stampClassOfValue(valueOf(rec));
  });
  channel.place('grid:1', { stamp: true, bounds: () => gridStampBounds(cells, frame, M), sample: (m) => stampGrid(cells, frame, 'share', m) });
}

function linkedPath(l: Linked, from: P3, to: P3): LinkedPathAnswer {
  let out: LinkedPathAnswer | null = null;
  l.queries.path(from, to, {}, (a) => (out = a));
  for (let k = 0; out === null && k < 10_000; k++) l.queries.serve(Infinity);
  return out!;
}

function worldPath(g: WalkGraph, from: P3, to: P3): WalkPathAnswer {
  const q = new WalkQueries(g);
  let out: WalkPathAnswer | null = null;
  q.path(from, to, {}, (a) => (out = a));
  while (out === null) q.serve(Infinity);
  return out;
}

/** A house cell (its own frame: x, feet y, z, at the cell's middle) as the world cell it stands in. */
function worldCellOf(f: GridFrame, x: number, y: number, z: number): P3 {
  const p = f.toWorld((x + 0.5) * M, (y + 0.5) * M, (z + 0.5) * M);
  return [Math.floor(p[0] / M), Math.floor(p[1] / M), Math.floor(p[2] / M)];
}

/** Points walked whose walker column (feet and three cells over, at the point) lies in a cell of the house that stops (its own cells as its store holds them). */
function inWalls(a: LinkedPathAnswer, f: GridFrame, house: World): number {
  let n = 0;
  const v = voxel();
  for (let k = 0; k < a.points.length; k += 3) {
    for (let dy = 0; dy < 4; dy++) {
      const q = f.toGrid(a.points[k]!, a.points[k + 1]! + (dy + 0.5) * M, a.points[k + 2]!);
      house.store.voxelAt(Math.floor(q[0] / M), Math.floor(q[1] / M), Math.floor(q[2] / M), v);
      if (stampClassOfValue(valueOf(v)) === STAMP_CLASS.stop) {
        n++;
        break;
      }
    }
  }
  return n;
}

// The street: 3 m in front of the door; the room's middle; the upper storey's middle (house cells).
const STREET: P3 = [10, 0, -6];
const ROOM: P3 = [13, 1, 8];
const UPPER: P3 = [13, 7, 8];

describe('walk graph with structure grids: the stamp blocks, the grid walks, links join them', () => {
  it('a house at 0° on chunk-aligned cells gives the control’s paths (the same cells, the same cost)', () => {
    const c = control();
    const l = linked(0);
    const f = l.frame;
    for (const to of [ROOM, UPPER]) {
      const w = worldPath(c.graph, worldCellOf(f, ...STREET), worldCellOf(f, ...to));
      const g = linkedPath(l, worldCellOf(f, ...STREET), worldCellOf(f, ...to));
      expect(w.status).toBe('found');
      expect(g.status).toBe('found');
      expect(g.legs).toBe(2);
      expect(g.cost).toBeCloseTo(w.cost, 6);
      // The same cells walked: the world's cells, then the house's (placed at the same world cells).
      expect(g.points.length).toBe(w.cells.length);
      for (let k = 0; k < w.cells.length; k += 3) {
        expect(g.points[k]).toBeCloseTo((w.cells[k]! + 0.5) * M, 6);
        expect(g.points[k + 1]).toBeCloseTo(w.cells[k + 1]! * M, 6);
        expect(g.points[k + 2]).toBeCloseTo((w.cells[k + 2]! + 0.5) * M, 6);
      }
    }
  });

  it('turned 30°: street → room → upper storey, by the door and the stairs, never through a wall; a way round the house', () => {
    const l = linked(30);
    const f = l.frame;
    expect(l.links.linksOf(1).length).toBeGreaterThan(0);
    for (const to of [ROOM, UPPER]) {
      const g = linkedPath(l, worldCellOf(f, ...STREET), worldCellOf(f, ...to));
      expect(g.status).toBe('found');
      expect(g.grids.some((id) => id === 1)).toBe(true);
      expect(inWalls(g, f, l.house)).toBe(0);
      // Within a few per cent of the same way at 0° (the grid metric turned).
      const g0 = linkedPath(linked(0), worldCellOf(placeOf(0), ...STREET), worldCellOf(placeOf(0), ...to));
      expect(g.cost / g0.cost).toBeGreaterThan(0.95);
      expect(g.cost / g0.cost).toBeLessThan(1.1);
    }
    // The world's graph alone never stands inside the footprint: the room is not the world's.
    const alone = worldPath(l.worldGraph, worldCellOf(f, ...STREET), worldCellOf(f, ...ROOM));
    expect(alone.status).not.toBe('found');
    // Front to back round the house: in the world grid, every point clear of its walls.
    const round = linkedPath(l, worldCellOf(f, ...STREET), worldCellOf(f, 10, 0, HD + 6));
    expect(round.status).toBe('found');
    expect(round.legs).toBe(1);
    expect(inWalls(round, f, l.house)).toBe(0);
  });

  it('makes links as chunks arrive and drops them as they go, either side; an edit in the grid opens a new way', () => {
    const l = linked(30);
    const n = l.links.linksOf(1).length;
    expect(n).toBeGreaterThan(0);
    // The house's chunk leaves: its part goes, its links with it.
    l.house.loaded.delete('0,0,0');
    l.houseGraph.touch(0, 0, 0);
    l.houseGraph.update();
    l.links.update();
    expect(l.links.linksOf(1).length).toBe(0);
    expect(l.links.stats().links).toBe(0);
    // Back: the same links.
    l.house.loaded.add('0,0,0');
    l.houseGraph.touch(0, 0, 0);
    l.houseGraph.update();
    l.links.update();
    expect(l.links.linksOf(1).length).toBe(n);
    // The world's chunk under the doorstep leaves and comes back.
    const door = worldCellOf(l.frame, 10, 0, -1);
    const wc: P3 = [door[0] >> 5, door[1] >> 5, door[2] >> 5];
    l.world.loaded.delete(wc.join(','));
    l.worldGraph.touch(...wc);
    l.worldGraph.update();
    l.links.update();
    expect(l.links.linksOf(1).length).toBeLessThan(n);
    l.world.loaded.add(wc.join(','));
    l.worldGraph.touch(...wc);
    l.worldGraph.update();
    l.links.update();
    expect(l.links.linksOf(1).length).toBe(n);
    // The back wall dug open (a direct write to the grid's store), derived again, stamped again: a way in from behind.
    const back = worldCellOf(l.frame, 13, 0, HD + 4);
    const before = linkedPath(l, back, worldCellOf(l.frame, ...ROOM));
    for (const x of [12, 13]) for (let y = 1; y <= 4; y++) l.house.store.setVoxel(x, y, HD - 1, AIR);
    l.house.derive(0, 0, 0);
    stamp(l.channel, l.house, l.frame);
    l.worldGraph.update();
    l.houseGraph.touch(0, 0, 0);
    l.houseGraph.update();
    l.links.update();
    const after = linkedPath(l, back, worldCellOf(l.frame, ...ROOM));
    expect(before.status).toBe('found');
    expect(after.status).toBe('found');
    expect(after.cost).toBeLessThan(before.cost * 0.6);
    expect(inWalls(after, l.frame, l.house)).toBe(0);
  });

  it('costs nothing with no grid: no stamp reads give the same parts, and a section with no stamped cell is the same object', () => {
    const w = new World();
    ground(w);
    each(WLO, WHI, (cx, cy, cz) => w.derive(cx, cy, cz));
    const plain = new WalkGraph(w.view(), M);
    const channel = new PropLightChannel({ grid, setPart: () => true }, M);
    each(WLO, WHI, (cx, cy, cz) => channel.loaded(cx, cy, cz));
    const stamped = new WalkGraph(w.view(), M, { stamps: channel });
    for (const g of [plain, stamped]) {
      each(WLO, WHI, (cx, cy, cz) => g.touch(cx, cy, cz));
      g.update();
    }
    let parts = 0;
    for (const a of plain.parts()) {
      const b = stamped.chunkAt(a.cx, a.cy, a.cz)!;
      expect(sameWalkChunk(a, b)).toBe(true);
      parts++;
    }
    expect(parts).toBeGreaterThan(0);
    const nav = w.derived.get('0,-1,0')!.nav;
    expect(stampedNav(nav, null, null, 0, 16, 0, grid.shift, 16)).toBe(nav);
    expect(stampedNav(nav, new Uint8Array(grid.cellsPerChunk), null, 0, 16, 0, grid.shift, 16)).toBe(nav);
  });

  it('a stamped stop blocks by default, and carries a walker only with supports', () => {
    const w = new World();
    each([0, 0, 0], [0, 0, 0], (cx, cy, cz) => w.derive(cx, cy, cz));
    // A stamped slab at y = 3 over the chunk's x, z 4 … 11: free air otherwise.
    const classes = new Uint8Array(grid.cellsPerChunk);
    for (let x = 4; x < 12; x++) for (let z = 4; z < 12; z++) classes[(((x << grid.shift) | z) << grid.shift) | 3] = STAMP_CLASS.stop;
    const nav = w.derived.get('0,0,0')?.nav ?? null;
    const blocks = stampedNav(nav, classes, null, 0, 0, 0, grid.shift, 16)!;
    const carries = stampedNav(nav, classes, null, 0, 0, 0, grid.shift, 16, true)!;
    const at = (x: number, y: number, z: number): number => (x * 16 + z) * 16 + y;
    expect(blocks.blocks).not.toBeNull();
    expect([...blocks.standable]).not.toContain(at(6, 4, 6));
    expect([...carries.standable]).toContain(at(6, 4, 6));
  });
});
