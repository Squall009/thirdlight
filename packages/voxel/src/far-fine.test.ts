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
import { FAR_VIEW_PIXELS_PER_RADIAN, FarField, type FarEvent, type FarNodeDraw, type FarNodeSource } from './far-field';
import { farFineChunks, farFineDirty, farFineFade, FarFineIndex, farFineScale, isFarFine, packFarFine, unpackFarFine, type FarFineHost } from './far-fine';
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
/** The test world's chunks: 8 × 3 × 8 (128 m square, 48 m tall). */
const SPAN = 8;
const HEIGHT = 3;

/** Hills of whole and part-full cells, a steep scarp and a house with a doorway and a part-full roof. */
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
      // A load ring of 192 m: level 2 opens only with a node's chunks and one round them resident (its near side 1–5
      // chunks short of the ring): the textures are gone by the middle of that band.
      const [, ringEnd] = farFineFade(error, FAR_VIEW_PIXELS_PER_RADIAN, 384, grid.edge);
      expect(ringEnd).toBeLessThanOrEqual(Math.min(end, (384 - 3 * grid.edge) * VOXEL_SIZE_M));
    }
  });

  it("gives the CPU build's corner bytes with the GPU build's windowed passes (scale 1 and 2, terrain, scarp, house)", () => {
    let corners = 0;
    for (const node of [{ level: 0, nx: 3, ny: 1, nz: 2 }, { level: 0, nx: 5, ny: 1, nz: 3 }, { level: 1, nx: 1, ny: 0, nz: 1 }, { level: 1, nx: 2, ny: 0, nz: 1 }, { level: 1, nx: 3, ny: 0, nz: 1 }] as const) {
      const block = gatherFarCells(grid, cellsOf(world), [node.nx, node.ny, node.nz], farFineScale(node.level));
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

  it('keeps a level-2 node closed while a chunk its children read is not resident, and a node the detail ring draws whole', () => {
    // One chunk away: the two level-2 nodes whose children read it (it is in one, in the other's apron) stay closed.
    const away = (c: ChunkCoord): boolean => c.cx === 0 && c.cz === 4 && c.cy === 0;
    const sel = new FarSelection().select(new FarFineIndex(keptIndex(), host(world, away)), view);
    const at = (n: MipNode): MipNode => ({ level: 2, nx: n.nx >> (2 - n.level), ny: n.ny >> (2 - n.level), nz: n.nz >> (2 - n.level) });
    const opened = new Set(sel.drawn.filter((d) => d.node.level < 2).map((d) => mipNodeKey(at(d.node))));
    for (const k of ['2:0,0,0', '2:0,0,1', '2:1,0,0', '2:1,0,1']) expect(opened.has(k), k).toBe(k.startsWith('2:1,'));
    // Every chunk the near field draws: no fine node opens under it.
    const all = new FarSelection().select(new FarFineIndex(keptIndex(), host(world, () => false, () => true)), view);
    expect(all.drawn.every((d) => d.node.level >= 2)).toBe(true);
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
      const block = gatherFarCells(grid, host(store).cells, [d.nx, d.ny, d.nz], farFineScale(d.level));
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
    const edited = gatherFarCells(grid, host(store).cells, [target.nx, target.ny, target.nz], 1);
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
