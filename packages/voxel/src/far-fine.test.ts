/**
 * Fine far bricks' parts that run on the CPU: the packed block the GPU
 * builds from is the very block the CPU build reads (and builds the same
 * bricks), the GPU build's windowed field passes (mirrored here step for
 * step in 64-bit floats; the browser test checks the WGSL against the CPU
 * build) give the CPU build's exact corner bytes, the selection opens fine
 * levels only where their chunks are resident and the detail ring does not
 * draw them whole, and the far field sends fine nodes' blocks from the
 * streamer's chunks and sends them again after an edit.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid, VOXEL_SIZE_M, type ChunkCoord } from './coords';
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, sampleOfDistance } from './distance-brick-format';
import { farBricksFromBlock, farBricksFromFaces, gatherFarCells, type ChunkCells, type FarCellBlock } from './far-bricks-faces';
import { farRoofDistance } from './far-bricks-roofs';
import { FAR_BAKED_LEVELS, FAR_VIEW_PIXELS_PER_RADIAN, FarField, type FarEvent, type FarNodeDraw, type FarNodeSource } from './far-field';
import { bakeFarFineNode } from './far-fine-bake';
import { encodeFarBricks } from './far-bricks-baked';
import { farBrickCount } from './far-bricks';
import { streamJobHandlers } from './stream-handlers';
import { farBrickOctant, farFineChunks, farFineDirty, farFineFade, FarFineIndex, farFineOctants, farFineScale, isFarFine, packFarFine, unpackFarFine, type FarFineHost } from './far-fine';
import { SHADER_CONSTRUCTION_BIT } from './derived-shader';
import { FAR_MIN_LEVEL, farCellPixels, FarNodeIndex, FarSelection } from './far-tree';
import { createWorldStore, type PaletteStore } from './palette-store';
import { recordValue, SHAPE_FULL, VOXEL_ROLE } from './record';
import { mipNodeKey, type MipNode } from './voxel-mips';
import { WORLD_RULES } from './rule-registry';
import type { WorkerPool } from './worker-pool';

const grid = chunkGrid(32);
const ROCK = 7;
const GRASS = 9;
const WALL = 12;
const TILE = 14;
/** The test world's chunks: 8 × 3 × 8 (128 m square, 48 m tall). */
const SPAN = 8;
const HEIGHT = 3;

/** Hills of whole and part-full cells, a steep scarp, a house with a doorway and a part-full roof, and a 45° gable roof. */
function testWorld(): PaletteStore {
  const s = createWorldStore(grid);
  const e = grid.edge;
  for (let x = 0; x < SPAN * e; x++) for (let z = 0; z < SPAN * e; z++) {
    const h = 30 + 6 * Math.sin(x / 23) + 5 * Math.cos(z / 17) + (x > 150 ? 6 : 0);
    const top = Math.floor(h);
    for (let y = 0; y < top; y++) s.setVoxel(x, y, z, { material: y === top - 1 ? GRASS : ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
    const part = Math.round((h - top) * SHAPE_FULL);
    if (part > 0) s.setVoxel(x, top, z, { material: GRASS, role: VOXEL_ROLE.terrain, shape: part, wetness: 1 });
  }
  for (let x = 100; x < 116; x++) for (let z = 60; z < 72; z++) for (let y = 36; y < 46; y++) {
    const shell = x === 100 || x === 115 || z === 60 || z === 71;
    const door = z === 60 && x >= 106 && x <= 108 && y < 41;
    if (shell && !door) s.setVoxel(x, y, z, { material: WALL, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
  }
  for (let x = 99; x < 117; x++) for (let z = 59; z < 73; z++) s.setVoxel(x, 46, z, { material: WALL, role: VOXEL_ROLE.terrain, shape: 9, wetness: 0 });
  // A 45° gable of roof cells (one a column, the ridge along x): drawn as the roof mesher's planes.
  for (let x = 102; x < 116; x++) for (let z = 76; z < 90; z++) s.setVoxel(x, 48 + Math.min(z - 76 + 1, 90 - z), z, { material: TILE, role: VOXEL_ROLE.roof, shape: SHAPE_FULL, wetness: 0 });
  return s;
}

const world = testWorld();

/** Whether two buffers (or views) hold the same bytes. */
function sameBytes(a: ArrayBufferLike | ArrayBufferView, b: ArrayBufferLike | ArrayBufferView): boolean {
  const x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
  const y = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
const cellsOf = (store: PaletteStore): ChunkCells => (cx, cy, cz, out) => cx >= 0 && cz >= 0 && cy >= 0 && cx < SPAN && cz < SPAN && cy < HEIGHT && store.exportChunk(cx, cy, cz, out);

/**
 * The GPU build's corner field (voxel-fine-bricks-wgsl.ts passes 1–3) in 64-bit floats: the nearest span along y
 * within a window, then the separable passes along x and z within a window, then the CPU build's surface rule.
 */
function windowedField(b: FarCellBlock): Float64Array {
  const { n, apron: A, scale: S, density } = b;
  const m = n + 1;
  const C = 33;
  const W = (DISTANCE_BRICK_BAND_VOXELS + 1) * S + 1;
  const R = DISTANCE_BRICK_BAND_VOXELS * S + 1;
  const NONE = 1e12;
  const ci = (x: number, y: number, z: number): number => (z * n + y) * n + x;
  const ys = [new Float64Array(C * m * m), new Float64Array(C * m * m)];
  for (let cy = 0; cy < C; cy++) for (let z = 0; z < m; z++) for (let x = 0; x < m; x++) {
    const Y = cy * S + A;
    let belowS = -Infinity, aboveS = Infinity, belowA = -Infinity, aboveA = Infinity;
    for (let y = Math.max(Y - W, 0); y < Math.min(Y + W, n); y++) {
      let ls = Infinity, hs = -Infinity, la = Infinity, ha = -Infinity;
      for (let cz = z - 1; cz <= z; cz++) for (let cx = x - 1; cx <= x; cx++) {
        if (cx < 0 || cz < 0 || cx >= n || cz >= n) continue;
        const i = ci(cx, y, cz);
        const d = density[i]!;
        const r = Math.fround(1 - d);
        if (d <= 0) [la, ha] = [Math.min(la, 0), Math.max(ha, 1)];
        else if (d >= 1) [ls, hs] = [Math.min(ls, 0), Math.max(hs, 1)];
        else {
          const above = y < n - 1 ? density[i + n]! : 0;
          const below = y > 0 ? density[i - n]! : 0;
          if (above > below) [ls, hs, la, ha] = [Math.min(ls, r), Math.max(hs, 1), Math.min(la, 0), Math.max(ha, r)];
          else [ls, hs, la, ha] = [Math.min(ls, 0), Math.max(hs, d), Math.min(la, d), Math.max(ha, 1)];
        }
      }
      // The span ends as 32-bit floats (the CPU build's arrays; the GPU's arithmetic).
      if (y < Y) [belowS, belowA] = [Math.max(belowS, Math.fround(y + hs)), Math.max(belowA, Math.fround(y + ha))];
      else [aboveS, aboveA] = [Math.min(aboveS, Math.fround(y + ls)), Math.min(aboveA, Math.fround(y + la))];
    }
    const dS = Math.min(Y - belowS, aboveS - Y);
    const dA = Math.min(Y - belowA, aboveA - Y);
    // Stored as 32-bit floats, as the CPU build's passes (and the GPU's) store them.
    ys[0]![(cy * m + z) * m + x] = Math.fround(dS < Infinity ? dS * dS : NONE);
    ys[1]![(cy * m + z) * m + x] = Math.fround(dA < Infinity ? dA * dA : NONE);
  }
  const xs = [new Float64Array(C * m * C), new Float64Array(C * m * C)];
  for (let sel = 0; sel < 2; sel++) for (let cy = 0; cy < C; cy++) for (let z = 0; z < m; z++) for (let cx = 0; cx < C; cx++) {
    const X = cx * S + A;
    let best = NONE;
    for (let j = -R; j <= R; j++) if (X + j >= 0 && X + j < m) best = Math.min(best, ys[sel]![(cy * m + z) * m + X + j]! + j * j);
    xs[sel]![(cy * m + z) * C + cx] = Math.fround(best);
  }
  const out = new Float64Array(C * C * C);
  for (let cz = 0; cz < C; cz++) for (let cy = 0; cy < C; cy++) for (let cx = 0; cx < C; cx++) {
    const Z = cz * S + A;
    let toS = NONE, toA = NONE;
    for (let l = -R; l <= R; l++) {
      if (Z + l < 0 || Z + l >= m) continue;
      toS = Math.min(toS, xs[0]![(cy * m + Z + l) * C + cx]! + l * l);
      toA = Math.min(toA, xs[1]![(cy * m + Z + l) * C + cx]! + l * l);
    }
    const o = Math.sqrt(Math.fround(toS)), inside = Math.sqrt(Math.fround(toA));
    let v = (o > 0 ? o : -inside) / S;
    if (o === 0 && inside === 0) {
      const i = ci(cx * S + A - 1, cy * S + A - 1, cz * S + A - 1);
      let sum = 0;
      let whole = true;
      for (const k of [i, i + 1, i + n, i + n + 1, i + n * n, i + n * n + 1, i + n * n + n, i + n * n + n + 1]) {
        sum += density[k]!;
        if (density[k]! > 0 && density[k]! < 1) whole = false;
      }
      if (whole) v = (0.5 - sum / 8) / S;
    }
    // The roofs' slabs join by the least (the GPU's roofDistance is this function in 32 bits).
    if (b.roofs !== null) v = Math.min(v, farRoofDistance(b.roofs, n, cx * S + A, cy * S + A, Z, S) / S);
    out[(cz * C + cy) * C + cx] = v;
  }
  return out;
}

/** Fine and coarse nodes over the test world, every chunk resident unless `away` says so; `near` chunks drawn by the near field. */
function host(store: PaletteStore, away: (c: ChunkCoord) => boolean = () => false, near: (c: ChunkCoord) => boolean = () => false): FarFineHost {
  const inside = (cx: number, cy: number, cz: number): boolean => cx >= 0 && cz >= 0 && cy >= 0 && cx < SPAN && cz < SPAN && cy < HEIGHT;
  return {
    resident: (cx, cy, cz) => !away({ cx, cy, cz }),
    holds: (cx, cy, cz) => inside(cx, cy, cz) && !away({ cx, cy, cz }) && store.chunkForm(cx, cy, cz) !== 'absent',
    cells: (cx, cy, cz, out) => inside(cx, cy, cz) && !away({ cx, cy, cz }) && store.exportChunk(cx, cy, cz, out),
    nearDrawn: (cx, cy, cz) => near({ cx, cy, cz }),
  };
}

/** The kept far tree over the world: levels 2 (64 m) and 3. */
function keptIndex(): FarNodeIndex {
  const idx = new FarNodeIndex(grid, 2, 3);
  for (let nx = 0; nx < SPAN / 4; nx++) for (let nz = 0; nz < SPAN / 4; nz++) idx.add({ level: 2, nx, ny: 0, nz }, 1000);
  idx.add({ level: 3, nx: 0, ny: 0, nz: 0 }, 1000);
  return idx;
}

describe('fine far bricks: the block', () => {
  it('packs a block with more looks than a packed block names: a look past them draws as its material dry where that is named, else as the first look', () => {
    const n = 17;
    const block = (wordAt: (i: number) => number): FarCellBlock => {
      const density = new Float32Array(n ** 3).fill(1);
      const solid = new Uint8Array(n ** 3).fill(1);
      density[0] = 0;
      solid[0] = 0;
      return { n, apron: 1, scale: 1, density, word: Uint16Array.from({ length: n ** 3 }, (_, i) => (i === 0 ? 0 : wordAt(i))), solid, count: n ** 3 - 1, roofs: null };
    };
    const WET = (w: number, m: number): number => m | (w << 12);
    // Materials 1–4095 dry name every look a block can; a wet 5 past them reads as dry 5.
    const dry = unpackFarFine(packFarFine(block((i) => (i < 4096 ? i : WET(3, 5))))!);
    expect(dry.word[4095]).toBe(4095);
    expect(dry.word[4096]).toBe(5);
    expect(dry.word[n ** 3 - 1]).toBe(5);
    // Every look named wet: a look of another wetness past them reads as the first.
    const wet = unpackFarFine(packFarFine(block((i) => (i < 4096 ? WET(1, i) : WET(2, 7))))!);
    expect(wet.word[4096]).toBe(WET(1, 1));
  });

  it('packs the block the CPU build reads, and builds the same bricks from it', () => {
    for (const node of [{ level: 0, nx: 3, ny: 1, nz: 2 }, { level: 1, nx: 1, ny: 0, nz: 1 }, { level: 1, nx: 3, ny: 0, nz: 1 }] as const) {
      const block = gatherFarCells(grid, cellsOf(world), [node.nx, node.ny, node.nz], farFineScale(node.level));
      const packed = packFarFine(block)!;
      expect(packed, mipNodeKey(node)).not.toBeNull();
      expect(packed.n).toBe(grid.edge * farFineScale(node.level) + 2 * block.apron);
      const back = unpackFarFine(packed);
      expect(sameBytes(back.density.buffer, block.density.buffer)).toBe(true);
      expect(back.count).toBe(block.count);
      // Words of empty cells are never read by the build; every other cell's word survives the trip.
      for (let i = 0; i < block.word.length; i++) if (block.density[i]! > 0) expect(back.word[i]).toBe(block.word[i]);
      const a = farBricksFromBlock(grid, back);
      const b = farBricksFromBlock(grid, block);
      expect(sameBytes(a.samples, b.samples)).toBe(true);
      expect(sameBytes(a.looks.buffer, b.looks.buffer)).toBe(true);
      expect(a.samples.length / DISTANCE_BRICK_SAMPLES, mipNodeKey(node)).toBeGreaterThan(0);
    }
    // The gable's block carries its roofs' column table there and back; its plane cells read as air with their word.
    const roofed = gatherFarCells(grid, cellsOf(world), [3, 1, 2], 1, true);
    expect(roofed.roofs).not.toBeNull();
    const back = unpackFarFine(packFarFine(roofed)!);
    expect(sameBytes(back.roofs!.buffer, roofed.roofs!.buffer)).toBe(true);
    let planes = 0;
    for (let i = 0; i < roofed.word.length; i++) if (roofed.density[i] === 0 && roofed.word[i] !== 0) {
      planes++;
      expect(back.word[i]).toBe(roofed.word[i]);
    }
    expect(planes).toBe(14 * 14);
    expect(sameBytes(farBricksFromBlock(grid, back).samples, farBricksFromBlock(grid, roofed).samples)).toBe(true);
    // A level-0 node is built from its own cells as the CPU far build would from a store.
    const own = farBricksFromBlock(grid, gatherFarCells(grid, cellsOf(world), [3, 1, 2], 1));
    const store = farBricksFromFaces(grid, world, [3, 1, 2], 1);
    expect(sameBytes(own.samples, store.samples)).toBe(true);
    // Nothing but air or nothing but solid: nothing to build.
    expect(packFarFine(gatherFarCells(grid, cellsOf(world), [0, 2, 0], 1))).toBeNull();
    expect(packFarFine(gatherFarCells(grid, () => false, [0, 0, 0], 1))).toBeNull();
  });

  it("keeps a construction cell's word apart from ground of the same material (the near surface's construction bit), so the samples' looks tell a wall's texture set from the terrain's; the distances do not change", () => {
    const cells = cellsOf(world);
    for (const [node, scale] of [[[3, 1, 1], 1], [[1, 0, 0], 2]] as const) {
      const plain = gatherFarCells(grid, cells, node, scale);
      const fine = gatherFarCells(grid, cells, node, scale, true);
      let walls = 0;
      let ground = 0;
      for (let i = 0; i < plain.word.length; i++) {
        if (plain.density[i] === 0) continue;
        const built = fine.word[i]! !== plain.word[i]!;
        expect(fine.word[i]! & ~SHADER_CONSTRUCTION_BIT).toBe(plain.word[i]);
        if (built) walls++;
        else ground++;
      }
      // The house's walls (role wall) carry it; its roof (laid with the terrain role) and the hills do not.
      expect(walls, node.join()).toBeGreaterThan(100);
      expect(ground, node.join()).toBeGreaterThan(100);
      const a = farBricksFromBlock(grid, unpackFarFine(packFarFine(fine)!));
      const b = farBricksFromBlock(grid, plain);
      expect(sameBytes(a.samples, b.samples)).toBe(true);
      expect([...a.looks].some((w) => (w & SHADER_CONSTRUCTION_BIT) !== 0)).toBe(true);
      expect([...b.looks].some((w) => (w & SHADER_CONSTRUCTION_BIT) !== 0)).toBe(false);
    }
  });

  it('fades fine bricks\' textures out where level 2 begins: where a level-2 cell is the error on screen, or nearer where the load ring keeps level 2 closed', () => {
    for (const error of [4, 8, 16]) {
      const [start, end] = farFineFade(error, FAR_VIEW_PIXELS_PER_RADIAN, Infinity, grid.edge);
      // At the fade's end a level-2 cell is still worth opening into level 1 (no level-2 brick nearer than it by error).
      expect(farCellPixels(FAR_MIN_LEVEL, end / VOXEL_SIZE_M, FAR_VIEW_PIXELS_PER_RADIAN)).toBeGreaterThanOrEqual(error - 1e-9);
      expect(start).toBeGreaterThan(0);
      expect(start).toBeLessThan(end);
      // A load ring of 192 m: a level-1 node opens only with its chunks and one round them resident (level 2 begins
      // 1–3 chunks short of the ring): the textures are gone by the middle of that band.
      const [, ringEnd] = farFineFade(error, FAR_VIEW_PIXELS_PER_RADIAN, 384, grid.edge);
      expect(ringEnd).toBeLessThanOrEqual(Math.min(end, (384 - 2 * grid.edge) * VOXEL_SIZE_M));
    }
  });

  it("gives the CPU build's corner bytes with the GPU build's windowed passes (scale 1 and 2, terrain, scarp, house, a sloped roof)", () => {
    let corners = 0;
    for (const node of [{ level: 0, nx: 3, ny: 1, nz: 2 }, { level: 0, nx: 5, ny: 1, nz: 3 }, { level: 1, nx: 1, ny: 0, nz: 1 }, { level: 1, nx: 2, ny: 0, nz: 1 }, { level: 1, nx: 3, ny: 0, nz: 1 }] as const) {
      const block = gatherFarCells(grid, cellsOf(world), [node.nx, node.ny, node.nz], farFineScale(node.level), true);
      const cpu = farBricksFromBlock(grid, block);
      const field = windowedField(block);
      const C = DISTANCE_BRICK_CELLS;
      const T = DISTANCE_BRICK_SIDE;
      for (let b = 0; b < cpu.bricks.length; b++) {
        const k = cpu.bricks[b]!;
        if (k < 0) continue;
        const bx = b % 4, by = (b >> 2) % 4, bz = b >> 4;
        for (let z = 0; z < T; z++) for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
          const v = field[((bz * C + z) * 33 + by * C + y) * 33 + bx * C + x]!;
          expect(sampleOfDistance(v, DISTANCE_BRICK_BAND_VOXELS), `${mipNodeKey(node)} brick ${b} corner ${x},${y},${z}`).toBe(cpu.samples[k * DISTANCE_BRICK_SAMPLES + (z * T + y) * T + x]);
          corners++;
        }
      }
    }
    expect(corners).toBeGreaterThan(20_000);
  });
});

describe('fine far bricks: the selection', () => {
  const view = { eye: [128, 76, 128] as const, pixelsPerRadian: 300, errorPixels: 8, near: null };

  it('opens the kept level 2 into levels 1 and 0 by screen error where the chunks are resident', () => {
    const fine = new FarFineIndex(keptIndex(), host(world));
    const sel = new FarSelection().select(fine, view);
    const levels = sel.drawn.map((d) => d.node.level);
    expect(levels.filter((l) => l === 0).length).toBeGreaterThan(0);
    expect(levels.filter((l) => l === 1).length).toBeGreaterThan(0);
    // The nearest nodes are the finest: every level-0 node is nearer than every level-2 node.
    const nearest2 = Math.min(...sel.drawn.filter((d) => d.node.level === 2).map((d) => d.distance), Infinity);
    for (const d of sel.drawn.filter((d) => d.node.level === 0)) expect(d.distance).toBeLessThan(nearest2);
    // Never two drawn nodes over one place, and fine nodes store nothing.
    const keys = new Set(sel.drawn.map((d) => mipNodeKey(d.node)));
    for (const d of sel.drawn) for (let l = d.node.level + 1; l <= 3; l++) expect(keys.has(mipNodeKey({ level: l, nx: d.node.nx >> (l - d.node.level), ny: d.node.ny >> (l - d.node.level), nz: d.node.nz >> (l - d.node.level) }))).toBe(false);
    for (const d of sel.drawn) if (isFarFine(d.node)) expect(d.bytes).toBe(0);
    // The kept tree alone stops at level 2 (no fine bricks).
    expect(new FarSelection().select(keptIndex(), view).drawn.every((d) => d.node.level >= 2)).toBe(true);
  });

  it('opens a level-2 node the load ring ends across into its resident children only, keeping it drawn over the rest, and not a node the detail ring draws whole', () => {
    // One chunk away: the two level-2 nodes whose children read it (it is in one, in the other's apron) open into the
    // level-1 children whose blocks do not read it, and stay drawn over the children that do.
    const away = (c: ChunkCoord): boolean => c.cx === 0 && c.cz === 4 && c.cy === 0;
    const fine = new FarFineIndex(keptIndex(), host(world, away));
    const sel = new FarSelection().select(fine, view);
    const keys = new Set(sel.drawn.map((d) => mipNodeKey(d.node)));
    const up = (n: MipNode, l: number): MipNode => ({ level: l, nx: n.nx >> (l - n.level), ny: n.ny >> (l - n.level), nz: n.nz >> (l - n.level) });
    const reads = (n: MipNode): boolean => {
      const { min, max } = farFineChunks(n);
      return min[0] <= 0 && max[0] >= 0 && min[1] <= 0 && max[1] >= 0 && min[2] <= 4 && max[2] >= 4;
    };
    for (const k of ['2:0,0,0', '2:0,0,1']) expect(keys.has(k), `${k} stays drawn over its unread part`).toBe(true);
    for (const k of ['2:1,0,0', '2:1,0,1']) expect(keys.has(k), `${k} opens whole`).toBe(false);
    expect(fine.partial({ level: 2, nx: 0, ny: 0, nz: 1 })).toBe(true);
    expect(fine.partial({ level: 2, nx: 1, ny: 0, nz: 1 })).toBe(false);
    let opened = 0;
    for (const d of sel.drawn) {
      if (!isFarFine(d.node)) continue;
      // No fine node reads a chunk that is not here, and none lies under another drawn fine node.
      expect(reads(d.node.level === 1 ? d.node : up(d.node, 1)), mipNodeKey(d.node)).toBe(false);
      for (let l = d.node.level + 1; l <= 1; l++) expect(keys.has(mipNodeKey(up(d.node, l)))).toBe(false);
      if (keys.has(mipNodeKey(up(d.node, 2)))) opened++;
    }
    expect(opened, 'fine nodes beside their partly opened level-2 node').toBeGreaterThan(0);
    // No hole: under a drawn level-2 node every octant is the node's or a fine node's; under one not drawn every
    // holding level-1 child is drawn itself or through its level-0 children.
    for (const n of keptIndex().nodes(2)) {
      const k2 = mipNodeKey(n);
      const octants = farFineOctants(n, (k) => keys.has(k));
      for (const c of fine.children(n)) {
        const o = (c.nx & 1) | ((c.ny & 1) << 1) | ((c.nz & 1) << 2);
        if (!keys.has(k2)) expect((octants >> o) & 1, `${mipNodeKey(c)} drawn`).toBe(1);
      }
      if (keys.has(k2)) for (let o = 0; o < 8; o++) {
        const c = { level: 1, nx: n.nx * 2 + (o & 1), ny: n.ny * 2 + ((o >> 1) & 1), nz: n.nz * 2 + (o >> 2) };
        // A partly opened node's octant left to it is one whose child reads the chunk away (or holds nothing).
        if (((octants >> o) & 1) === 0 && fine.has(c)) expect(reads(c), mipNodeKey(c)).toBe(true);
      }
    }
    expect(fine.refused.resident + fine.refused.partial).toBe(0);
    fine.selecting();
    expect(fine.refused.partial, 'the selection counted the nodes it opened in part').toBe(2);
    // Every chunk the near field draws: no fine node opens under it.
    const all = new FarSelection().select(new FarFineIndex(keptIndex(), host(world, () => false, () => true)), view);
    expect(all.drawn.every((d) => d.node.level >= 2)).toBe(true);
  });

  it("opens fine nodes in the near cover's edge ring, where the far field draws behind the near field, and none the cover hides", () => {
    // The near field draws chunk columns 0–6 on both axes at every height: the cover hides 1–5 (each chunk and every
    // chunk round it drawn) and keeps 0 and 6 as its edge ring. A level-2 node over the edge ring kept closed draws
    // its 2 m roofs there behind the near field, standing out past its silhouettes; fine nodes draw the near field's
    // own surface instead.
    const drawnCol = (c: number): boolean => c >= 0 && c <= 6;
    const near = (c: ChunkCoord): boolean => drawnCol(c.cx) && drawnCol(c.cz);
    const hiddenCol = (c: number): boolean => c >= 1 && c <= 5;
    const fine = new FarFineIndex(keptIndex(), host(world, () => false, near));
    const sel = new FarSelection().select(fine, { ...view, errorPixels: 2 });
    const covering = (cx: number, cy: number, cz: number): MipNode | undefined => sel.drawn.map((d) => d.node).find((n) => n.nx === cx >> n.level && n.ny === cy >> n.level && n.nz === cz >> n.level);
    let edge = 0;
    for (let cx = 0; cx < SPAN; cx++) for (let cz = 0; cz < SPAN; cz++) for (let cy = 0; cy < HEIGHT; cy++) {
      if (!near({ cx, cy, cz }) || (hiddenCol(cx) && hiddenCol(cz)) || world.chunkForm(cx, cy, cz) === 'absent') continue;
      edge++;
      expect(covering(cx, cy, cz)?.level, `edge chunk ${cx},${cy},${cz}`).toBe(0);
    }
    expect(edge).toBeGreaterThan(0);
    // Nothing fine where the cover hides the far field whole.
    for (const d of sel.drawn) {
      if (!isFarFine(d.node)) continue;
      const s = 1 << d.node.level;
      const wholly = hiddenCol(d.node.nx * s) && hiddenCol((d.node.nx + 1) * s - 1) && hiddenCol(d.node.nz * s) && hiddenCol((d.node.nz + 1) * s - 1);
      expect(wholly, `${mipNodeKey(d.node)} under the cover`).toBe(false);
    }
  });

  it("leaves a partly opened node's bricks out of its draw in the octants fine nodes cover", () => {
    const n = { level: 2, nx: 3, ny: 1, nz: 5 };
    const drawn = new Set(['1:7,2,10', '0:12,6,22', '0:13,7,23']);
    // 1:7,2,10 is octant x1 y0 z0; 0:12,6,22 and 0:13,7,23 are both under 1:6,3,11 (octant x0 y1 z1).
    expect(farFineOctants(n, (k) => drawn.has(k))).toBe((1 << 1) | (1 << 6));
    // A 4³ brick table: bricks 0–1 in x lie in the low half, 2–3 in the high one, alike for y and z.
    expect(farBrickOctant(0, 4)).toBe(0);
    expect(farBrickOctant(2, 4)).toBe(1);
    expect(farBrickOctant(1 + 4 * 2 + 16 * 3, 4)).toBe(2 | 4);
    expect(farBrickOctant(63, 4)).toBe(7);
  });

  it('names every fine node whose block reads a changed chunk', () => {
    const dirty = new Set(farFineDirty([{ cx: 4, cy: 1, cz: 4 }]).map(mipNodeKey));
    for (const level of [0, 1]) for (let nx = 0; nx < 8 >> level; nx++) for (let ny = 0; ny < 4 >> level; ny++) for (let nz = 0; nz < 8 >> level; nz++) {
      const n = { level, nx, ny, nz };
      const { min, max } = farFineChunks(n);
      const reads = 4 >= min[0] && 4 <= max[0] && 1 >= min[1] && 1 <= max[1] && 4 >= min[2] && 4 <= max[2];
      if (reads) expect(dirty.has(mipNodeKey(n)), mipNodeKey(n)).toBe(true);
    }
  });
});

describe('fine far bricks: the far field', () => {
  it('sends fine nodes as the blocks of the resident chunks, again after an edit, and closes back to level 2 when off', async () => {
    const store = testWorld();
    const kept = keptIndex();
    const source: FarNodeSource = {
      grid,
      minLevel: 2,
      maxLevel: 3,
      index: () => Promise.resolve(kept),
      // Coarse nodes read as air: their (stubbed) jobs make nothing; what is tested here is the fine nodes.
      read: (_level, nodes) => Promise.resolve(nodes.map((c) => ({ ...c, kind: 'air' as const }))),
      invalidate: () => undefined,
      memoryBytes: () => 0,
    };
    let jobs = 0;
    const pool = {
      submit: () => {
        jobs++;
        return Promise.resolve({ status: 'done', output: { side: 4, bricks: new Int32Array(64).fill(DISTANCE_BRICK_OUTSIDE), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) }, workerUs: 0, queueMs: 0, runMs: 0 });
      },
      cancel: () => true,
      backgroundRoom: () => 8,
    } as unknown as WorkerPool;
    const far = new FarField({ source, errorPixels: 8, pixelsPerRadian: 300, draw: 'bricks', fine: true }, { grid, pool, rules: WORLD_RULES, fine: host(store) });
    const shown = new Map<string, FarNodeDraw>();
    const events: FarEvent[] = [];
    far.on((e) => {
      events.push(e);
      for (const n of e.removed) shown.delete(mipNodeKey(n));
      for (const a of e.added) shown.set(mipNodeKey(a), a);
    });
    far.setEye(128, 76, 128);
    far.update();
    await far.settle();
    expect(far.metrics().problem).toBeNull();
    expect(far.fineNodes.on).toBe(true);
    const fine = [...shown.values()].filter((d) => isFarFine(d));
    expect(fine.filter((d) => d.level === 0).length).toBeGreaterThan(0);
    expect(fine.filter((d) => d.level === 1).length).toBeGreaterThan(0);
    // Each fine node's block is the store's, packed.
    for (const d of fine) {
      expect(d.fine, mipNodeKey(d)).toBeDefined();
      const block = gatherFarCells(grid, host(store).cells, [d.nx, d.ny, d.nz], farFineScale(d.level), true);
      expect(sameBytes(unpackFarFine(d.fine!).density.buffer, block.density.buffer), mipNodeKey(d)).toBe(true);
    }
    expect(far.metrics().fine.ms.n).toBeGreaterThan(0);
    // The events say where the fine nodes' textures fade (no near ring given: by the error alone).
    expect(events.at(-1)!.fineFade).toEqual(farFineFade(8, 300, Infinity, grid.edge));
    // An edit in a fine node: it and every fine node reading the chunk are sent again with the edited cells.
    const target = fine.find((d) => d.level === 0)!;
    const s = grid.shift;
    const x = (target.nx << s) + 10, z = (target.nz << s) + 10;
    for (let y = target.ny << s; y < (target.ny + 1) << s; y++) store.setVoxel(x, y, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    const before = events.length;
    far.fineNodes.changed([{ cx: target.nx, cy: target.ny, cz: target.nz }]);
    far.update();
    await far.settle();
    const again = events.slice(before).flatMap((e) => e.added);
    const sent = again.find((a) => mipNodeKey(a) === mipNodeKey(target));
    expect(sent?.fine, 'the edited node sent again').toBeDefined();
    const edited = gatherFarCells(grid, host(store).cells, [target.nx, target.ny, target.nz], 1, true);
    expect(sameBytes(unpackFarFine(sent!.fine!).density.buffer, edited.density.buffer)).toBe(true);
    for (const a of again) expect(isFarFine(a), mipNodeKey(a)).toBe(true);
    // Off: the fine nodes close back into the kept level 2.
    far.setView({ fine: false });
    await far.settle();
    expect([...shown.values()].some((d) => isFarFine(d))).toBe(false);
    expect(far.metrics().fine.on).toBe(false);
    expect(events.at(-1)!.fineFade).toBeUndefined();
    expect(jobs).toBeGreaterThan(0);
    // The world's uniform value is what a block reads as solid.
    expect(recordValue(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0)).toBeGreaterThan(0);
    far.close();
  });
});

describe('fine far bricks: baked levels read', () => {
  /** A far source over the kept index whose fine levels 0–1 are baked: every fine node the fine bake of its block. */
  function bakedSource(store: PaletteStore, reads: { fine: number; bytes?: number }): FarNodeSource & { bakes: Map<string, Uint8Array | null> } {
    const kept = keptIndex();
    const bakes = new Map<string, Uint8Array | null>();
    const bakeOf = (n: MipNode): Uint8Array | null => {
      const key = mipNodeKey(n);
      if (!bakes.has(key)) {
        const b = bakeFarFineNode(grid, cellsOf(store), n);
        bakes.set(key, b === null ? null : encodeFarBricks(b));
      }
      return bakes.get(key)!;
    };
    return {
      grid,
      minLevel: 2,
      maxLevel: 3,
      index: () => Promise.resolve(kept),
      read: (level, nodes) => {
        // Coarse nodes read as solid rock (they stay in the index when read again after an edit; their bricks are empty).
        if (level < FAR_BAKED_LEVELS) return Promise.resolve(nodes.map((c) => ({ ...c, kind: 'uniform' as const, value: recordValue(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0) })));
        const fine = level - FAR_BAKED_LEVELS;
        expect(fine, 'only fine levels are read baked here').toBeLessThan(2);
        reads.fine += nodes.length;
        return Promise.resolve(
          nodes.map((c) => {
            const bytes = bakeOf({ level: fine, nx: c.cx, ny: c.cy, nz: c.cz });
            if (bytes !== null) reads.bytes = (reads.bytes ?? 0) + bytes.byteLength;
            return bytes === null ? { ...c, kind: 'air' as const } : { ...c, kind: 'stored' as const, bytes, raw: true };
          }),
        );
      },
      fineBaked: (n) => n.level < 2,
      fineBakeLevel: () => 0,
      invalidate: (level, nodes) => {
        for (const c of nodes) bakes.delete(mipNodeKey({ level: level - FAR_BAKED_LEVELS, nx: c.cx, ny: c.cy, nz: c.cz }));
      },
      memoryBytes: () => 0,
      bakes,
    };
  }

  /** The worker's own far-bricks handler, run in this thread: a baked entry is decoded, a coarse node built. */
  function handlerPool(): WorkerPool & { counts: { baked: number; built: number } } {
    const handlers = streamJobHandlers({ decompress: (b) => b });
    const counts = { baked: 0, built: 0 };
    return {
      submit: (job: { kind: string; input: unknown }) => {
        const input = job.input as { baked?: unknown };
        if (input.baked !== undefined) counts.baked++;
        else counts.built++;
        return Promise.resolve(handlers[job.kind]!(job.input)).then((r) => ({ status: 'done', output: r.output, workerUs: 0, queueMs: 0, runMs: 0 }));
      },
      cancel: () => true,
      backgroundRoom: () => 8,
      counts,
    } as unknown as WorkerPool & { counts: { baked: number; built: number } };
  }

  it('draws levels 0 and 1 from the baked entries, decoded byte for byte as baked, with no chunk resident and nothing built; none at speed, back after', async () => {
    const store = testWorld();
    const reads: { fine: number; bytes?: number } = { fine: 0 };
    const source = bakedSource(store, reads);
    const pool = handlerPool();
    let fast = false;
    // No chunk resident: a baked world needs none past the detail ring (cells would throw if read).
    const noChunks: FarFineHost = {
      resident: () => false,
      holds: () => false,
      cells: () => {
        throw new Error('a baked fine node read a chunk');
      },
      nearDrawn: () => false,
      fast: () => fast,
    };
    const far = new FarField({ source, errorPixels: 8, pixelsPerRadian: 300, draw: 'bricks' }, { grid, pool, rules: WORLD_RULES, fine: noChunks });
    const shown = new Map<string, FarNodeDraw>();
    const events: FarEvent[] = [];
    far.on((e) => {
      events.push(e);
      for (const n of e.removed) shown.delete(mipNodeKey(n));
      for (const a of e.added) shown.set(mipNodeKey(a), a);
    });
    far.setEye(128, 76, 128);
    far.update();
    await far.settle();
    expect(far.metrics().problem).toBeNull();
    expect(far.fineNodes.on, 'nothing is built from chunks (the switch is off)').toBe(false);
    const fine = [...shown.values()].filter((d) => isFarFine(d));
    expect(fine.filter((d) => d.level === 0).length).toBeGreaterThan(4);
    expect(fine.filter((d) => d.level === 1).length).toBeGreaterThan(0);
    for (const d of fine) {
      expect(d.fine, `${mipNodeKey(d)} came as bricks, not a block to build`).toBeUndefined();
      expect(sameBytes(encodeFarBricks(d.bricks!), source.bakes.get(mipNodeKey(d))!), mipNodeKey(d)).toBe(true);
    }
    const m = far.metrics().fine;
    expect(m.made, 'fine blocks read from chunks').toBe(0);
    // The bytes read are the cache's stored entries as the source served them, counted, not estimated.
    const c = far.metrics().counters;
    expect(c.bakedReads).toBe(reads.fine);
    expect(c.bakedReadBytes).toBe(reads.bytes);
    expect(c.bakedReadBytes).toBeGreaterThan(0);
    expect(m.baked).toBeGreaterThanOrEqual(fine.length);
    expect(pool.counts.baked).toBeGreaterThanOrEqual(fine.length);
    // The textures fade by the error alone: no load ring ends a baked level.
    expect(events.at(-1)!.fineFade).toEqual(farFineFade(8, 300, Infinity, grid.edge));
    // Faster than the detail speed: no baked fine node is read; the fine levels close into level 2 meanwhile.
    fast = true;
    far.fineNodes.residency();
    await new Promise((ok) => setTimeout(ok, 600));
    far.update();
    await far.settle();
    const readAtSpeed = reads.fine;
    expect([...shown.values()].some((d) => isFarFine(d)), 'fine nodes drawn at speed').toBe(false);
    expect(far.metrics().fine.refused?.speed ?? 0).toBeGreaterThan(0);
    far.setEye(140, 76, 128);
    far.update();
    await far.settle();
    expect(reads.fine, 'baked fine reads at speed').toBe(readAtSpeed);
    // Slow again: they come back.
    fast = false;
    far.fineNodes.residency();
    await new Promise((ok) => setTimeout(ok, 600));
    far.update();
    await far.settle();
    expect([...shown.values()].filter((d) => d.level === 0).length).toBeGreaterThan(4);
    far.close();
  });

  it('reads an edited node again from the rebuilt cache (refresh), and holds level 0 to the tier reach past its error', async () => {
    const store = testWorld();
    const reads = { fine: 0 };
    const source = bakedSource(store, reads);
    const pool = handlerPool();
    const host: FarFineHost = { resident: () => false, holds: () => false, cells: () => false, nearDrawn: () => false };
    const far = new FarField({ source, errorPixels: 8, pixelsPerRadian: 300, draw: 'bricks' }, { grid, pool, rules: WORLD_RULES, fine: host });
    const shown = new Map<string, FarNodeDraw>();
    far.on((e) => {
      for (const n of e.removed) shown.delete(mipNodeKey(n));
      for (const a of e.added) shown.set(mipNodeKey(a), a);
    });
    far.setEye(128, 76, 128);
    far.update();
    await far.settle();
    const target = [...shown.values()].find((d) => d.level === 0 && farBrickCount(d.bricks!) > 0)!;
    expect(target).toBeDefined();
    // The world's files change there (the backend bakes the node again): the far field reads it again.
    const s = grid.shift;
    const x = (target.nx << s) + 10, z = (target.nz << s) + 10;
    for (let y = target.ny << s; y < (target.ny + 1) << s; y++) store.setVoxel(x, y, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    far.refresh([{ cx: target.nx, cy: target.ny, cz: target.nz }]);
    await new Promise((ok) => setTimeout(ok, 0));
    far.update();
    await far.settle();
    const again = shown.get(mipNodeKey(target))!;
    const want = bakeFarFineNode(grid, cellsOf(store), target)!;
    expect(sameBytes(encodeFarBricks(again.bricks!), encodeFarBricks(want))).toBe(true);
    expect(sameBytes(encodeFarBricks(again.bricks!), encodeFarBricks(target.bricks!)), 'the edit changed the node').toBe(false);
    expect(far.metrics().fine.made).toBe(0);
    // The tier's hold: level 1 opens into baked level 0 within the reach whatever its error.
    const level0At = async (holdM: number | undefined, eye: readonly [number, number, number]): Promise<number> => {
      far.setView({ errorPixels: 64, ...(holdM !== undefined ? { fineHoldM: holdM } : {}) });
      far.setEye(...eye);
      far.update();
      await far.settle();
      return [...shown.values()].filter((d) => d.level === 0).length;
    };
    const byError = await level0At(undefined, [-20, 76, -20]);
    const held = await level0At(80, [-20, 76, -20]);
    expect(held).toBeGreaterThan(byError);
    far.close();
  });
});
