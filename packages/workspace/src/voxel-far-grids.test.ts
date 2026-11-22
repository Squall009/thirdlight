/**
 * Structure grids in a world's far field, with real region files on disk: the far builder's source joins each placed
 * grid's cells, resampled where the grid stands, over the world grid's (voxel-far-cache.ts `FarWorldSource`). A house in
 * grid 1 at yaw 0 on the world's cells gives the same level-0 cells and the same far nodes as the same house written
 * into the world grid; turned 30° it lands as about as many cells, all inside its turned box; with no placement (or a
 * grid the manifest does not list) the source is the world grid's alone.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFarNode, chunkGrid, createWorldStore, GridFrame, SHAPE_FULL, VOXEL_ROLE, type FarCells, type GridPlacement, type PaletteStore } from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { FarWorldSource } from './voxel-far-cache';
import { RegionWorld } from './voxel-world-files';
import { gridFolder, writeVoxelWorld, writeVoxelWorldManifest } from './voxel-worlds';

const grid = chunkGrid(32);
const root = join(tmpdir(), `tl-voxel-far-grids-${process.pid}-${Date.now().toString(36)}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const WORLD = { worldId: 'b0112233445566778899aabbccddeeff', edge: 32 as const, layout: 'stacked' as const, footprint: 512 as const };
const M = 0.5;
/** The house in world cells at yaw 0: its cell (0, 0, 0) at (HX, 0, HZ), 20 × 13 × 16 cells. */
const HX = 4;
const HZ = -10;
const ROCK = 7;
const WALL = 12;
const FLOOR = 13;

function ground(s: PaletteStore): void {
  for (let x = -40; x < 40; x++) for (let z = -40; z < 40; z++) for (let y = -6; y < 0; y++) s.setVoxel(x, y, z, { material: ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
}

/** The house's cells (its own frame): a foundation, walls with a door of opening cells, a floor, a roof. */
function house(set: (x: number, y: number, z: number, v: { material: number; role: number; shape: number; wetness: number }) => void): void {
  for (let x = 0; x < 20; x++) for (let z = 0; z < 16; z++) for (let y = 0; y <= 12; y++) {
    const edge = x === 0 || x === 19 || z === 0 || z === 15;
    if (y === 0 || y === 12) set(x, y, z, { material: FLOOR, role: y === 0 ? VOXEL_ROLE.foundation : VOXEL_ROLE.roof, shape: SHAPE_FULL, wetness: 0 });
    else if (y === 6 && !edge) set(x, y, z, { material: FLOOR, role: VOXEL_ROLE.floor, shape: SHAPE_FULL, wetness: 0 });
    else if (edge) set(x, y, z, z === 0 && (x === 9 || x === 10) && y <= 4 ? { material: WALL, role: VOXEL_ROLE.opening, shape: 0, wetness: 0 } : { material: WALL, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
  }
}

/** A world folder: the ground and the house in the world grid (`in: 'world'`), or the ground and the house in grid 1. */
function world(name: string, where: 'world' | 'grid'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const s = createWorldStore(grid);
  ground(s);
  if (where === 'world') {
    house((x, y, z, v) => s.setVoxel(x + HX, y, z + HZ, v));
    writeVoxelWorld(dir, WORLD, s);
    return dir;
  }
  const g = createWorldStore(grid);
  house((x, y, z, v) => g.setVoxel(x, y, z, v));
  const own = RegionWorld.create(join(dir, gridFolder(0)), { grid, worldId: hexToBytes(WORLD.worldId), layout: WORLD.layout, footprint: WORLD.footprint, gridId: 0 }, s).listedRegions();
  const files = RegionWorld.create(join(dir, gridFolder(1)), { grid, worldId: hexToBytes(WORLD.worldId), layout: WORLD.layout, footprint: WORLD.footprint, gridId: 1 }, g).listedRegions();
  writeVoxelWorldManifest(dir, WORLD, own, [{ id: 1, regions: files }]);
  return dir;
}

/** Grid 1 turned `yawDeg` about the house's middle, that middle where the world grid's house has it. */
function placement(yawDeg: number): GridPlacement {
  const yaw = (yawDeg * Math.PI) / 180;
  const mid = [(HX + 10) * M, 0, (HZ + 8) * M];
  const local = [10 * M, 0, 8 * M];
  const p = new GridFrame({ gridId: 1, position: [0, 0, 0], yawRad: yaw }).toWorld(local[0]!, 0, local[2]!);
  return { gridId: 1, position: [mid[0]! - p[0], 0, mid[2]! - p[2]], yawRad: yaw };
}

const CHUNKS: Array<[number, number, number]> = [];
for (let cx = -2; cx <= 1; cx++) for (let cy = -1; cy <= 0; cy++) for (let cz = -2; cz <= 1; cz++) CHUNKS.push([cx, cy, cz]);

/** Cells that are not air in a chunk's cells. */
function solid(c: FarCells): number {
  if (c === null) return 0;
  if (typeof c === 'number') return c === 0 ? 0 : grid.cellsPerChunk;
  let n = 0;
  for (let i = 0; i < grid.cellsPerChunk; i++) if (c.material[i] !== 0 || c.role[i] !== 0) n++;
  return n;
}

function sameCells(a: FarCells, b: FarCells): boolean {
  if (a === null || typeof a === 'number' || b === null || typeof b === 'number') return a === b;
  for (const k of ['material', 'role', 'shape', 'wetness'] as const) for (let i = 0; i < grid.cellsPerChunk; i++) if (a[k][i] !== b[k][i]) return false;
  return true;
}

describe('the far builder sees structure grids where they stand', () => {
  const W = world('w', 'world');
  const G = world('g', 'grid');

  it('a grid at yaw 0 on the world cells gives the world-grid house cell for cell, and the same far nodes', () => {
    const w = new FarWorldSource(W);
    const g = new FarWorldSource(G, [placement(0)]);
    for (const [cx, cy, cz] of CHUNKS) expect(sameCells(g.chunk(cx, cy, cz), w.chunk(cx, cy, cz)), `chunk ${cx},${cy},${cz}`).toBe(true);
    for (const n of [{ level: 2, nx: -1, ny: -1, nz: -1 }, { level: 2, nx: 0, ny: 0, nz: -1 }, { level: 3, nx: -1, ny: -1, nz: -1 }, { level: 3, nx: 0, ny: 0, nz: -1 }]) expect(sameCells(buildFarNode(g, n), buildFarNode(w, n)), `node ${JSON.stringify(n)}`).toBe(true);
  });

  it('turned 30°: about the house’s cells, inside its turned box; without a placement the world grid alone', () => {
    const plain = new FarWorldSource(G);
    const turned = new FarWorldSource(G, [placement(30)]);
    const w = new FarWorldSource(W);
    let ground = 0;
    let withHouse = 0;
    let control = 0;
    for (const [cx, cy, cz] of CHUNKS) {
      ground += solid(plain.chunk(cx, cy, cz));
      withHouse += solid(turned.chunk(cx, cy, cz));
      control += solid(w.chunk(cx, cy, cz));
    }
    const houseCells = control - ground;
    expect(houseCells).toBeGreaterThan(0);
    // The world's ground stands where no grid cell is; the house lands as about as many cells turned.
    expect((withHouse - ground) / houseCells).toBeGreaterThan(0.9);
    expect((withHouse - ground) / houseCells).toBeLessThan(1.1);
    // Nothing of it outside its turned box (a cell of slack round it).
    const f = new GridFrame(placement(30));
    for (const [cx, cy, cz] of CHUNKS) {
      const a = turned.chunk(cx, cy, cz);
      const b = plain.chunk(cx, cy, cz);
      if (a === null || typeof a === 'number' || sameCells(a, b)) continue;
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
        const i = (((x << grid.shift) | z) << grid.shift) | y;
        const bm = b === null ? 0 : typeof b === 'number' ? 1 : b.material[i]! + b.role[i]!;
        if (a.material[i]! + a.role[i]! === bm) continue;
        const q = f.toGrid((cx * 32 + x + 0.5) * M, (cy * 32 + y + 0.5) * M, (cz * 32 + z + 0.5) * M);
        expect(q[0] / M).toBeGreaterThan(-1);
        expect(q[0] / M).toBeLessThan(21);
        expect(q[2] / M).toBeGreaterThan(-1);
        expect(q[2] / M).toBeLessThan(17);
      }
    }
  });

  it('leaves out a grid the manifest does not list', () => {
    const plain = new FarWorldSource(G);
    const other = new FarWorldSource(G, [{ ...placement(0), gridId: 7 }]);
    for (const [cx, cy, cz] of CHUNKS) expect(sameCells(other.chunk(cx, cy, cz), plain.chunk(cx, cy, cz))).toBe(true);
  });
});
