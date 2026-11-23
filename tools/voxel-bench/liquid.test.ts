/**
 * Liquid in the derive: whether any output but the liquid's own reads a
 * liquid cell differently from air (the proof the narrowed feeds rest on),
 * on the lake and cave worlds cell for cell and on hand-made cases.
 */
import {
  applyEdit,
  canonicalEditCommand,
  changeFeeds,
  chunkGrid,
  chunkOfKey,
  DERIVED_PART,
  deriveSectionFromStore,
  joinLiquid,
  LIQUID_FACE,
  LIQUID_STEPS_PER_CELL,
  liquidQuad,
  sectionGrid,
  sectionLocalOrigin,
  recordValue,
  createWorldStore,
  deriveFromStore,
  encodeShader,
  openRegionsArrays,
  VOXEL_ROLE,
  WORLD_RULES,
  dependentChunks,
  editBounds,
  encodeDerived,
  jobRadius,
  VoxelStreamer,
  WorkerPool,
  type ChunkCoord,
  type DerivedData,
  type LiquidPart,
  type PaletteStore,
} from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, writeWorldRegions } from './stream-node';
import { pickStore } from './regions';
import { crc32 } from '@thirdlight/shared';
import { loadArea } from './regions';
import { putVoxel } from './scenes';
import { MAT } from './world-kit';
import { cavesWorld, hillyWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const C = VOXEL_ROLE;

/** A CRC of views' bytes in turn. */
function crcOf(...a: ArrayBufferView[]): number {
  let n = 0;
  for (const v of a) n += v.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const v of a) {
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), o);
    o += v.byteLength;
  }
  return crc32(out);
}

/** Each consumer's bytes of a derived chunk (a CRC each): what a liquid-only change must leave as it is. */
function consumerHashes(d: DerivedData): Record<string, number> {
  const occ = d.occupancy;
  return {
    mesh: crcOf(d.ground.vertices, d.ground.indices, d.base.vertices, d.base.indices, d.instances.data),
    collision: crcOf(d.collision.boxes, d.collision.ramps.vertices, d.collision.ramps.indices, new Uint32Array([d.collision.fullBoxes])),
    nav: crcOf(...(d.nav.blocks === null ? [] : [d.nav.blocks]), d.nav.standable, d.nav.clearance, new Uint32Array([d.nav.blocking])),
    light: crcOf(...(d.light.full === null ? [] : [d.light.full]), d.light.partialCells, d.light.partialCover, new Int32Array([d.light.uniform])),
    occupancy: crcOf(occ.bricks, ...(occ.mask === null ? [] : [occ.mask]), new Uint32Array([occ.flag])),
    regions: d.regions == null ? 0 : crcOf(...openRegionsArrays(d.regions), new Int32Array([d.regions.count, d.regions.connect, d.regions.skyUniform])),
    shader: crc32(encodeShader(d.shader)),
  };
}

const coordOf = (key: number): ChunkCoord => chunkOfKey(grid, key, { cx: 0, cy: 0, cz: 0 });

/** Every chunk holding a liquid cell, and every chunk beside one (what a change of those cells can reach), with the liquid cells counted. */
function chunksNearLiquid(store: PaletteStore): { chunks: ChunkCoord[]; cells: number } {
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const found = new Map<string, ChunkCoord>();
  let cells = 0;
  for (const key of store.chunkKeys()) {
    const c = coordOf(key);
    let has = false;
    for (let lx = 0; lx < E; lx++) for (let lz = 0; lz < E; lz++) for (let ly = 0; ly < E; ly++) {
      if (store.voxelAt(c.cx * E + lx, c.cy * E + ly, c.cz * E + lz, v).material !== 0 && v.role === C.liquid) {
        has = true;
        cells++;
      }
    }
    if (!has) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = { cx: c.cx + dx, cy: c.cy + dy, cz: c.cz + dz };
      found.set(`${n.cx},${n.cy},${n.cz}`, n);
    }
  }
  return { chunks: [...found.values()], cells };
}

/** A copy of `store` with every liquid cell made air: every air ↔ liquid change at once. */
function drained(store: PaletteStore): PaletteStore {
  const out = createWorldStore(grid);
  for (const key of store.chunkKeys()) {
    const c = coordOf(key);
    out.adoptPayload(c.cx, c.cy, c.cz, store.chunkPayload(c.cx, c.cy, c.cz, true));
  }
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const air = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (const key of store.chunkKeys()) {
    const c = coordOf(key);
    for (let lx = 0; lx < E; lx++) for (let lz = 0; lz < E; lz++) for (let ly = 0; ly < E; ly++) {
      const x = c.cx * E + lx;
      const y = c.cy * E + ly;
      const z = c.cz * E + lz;
      if (out.voxelAt(x, y, z, v).material !== 0 && v.role === C.liquid) out.setVoxel(x, y, z, air);
    }
  }
  return out;
}

/** Per consumer, the chunks whose bytes differ between the world with its liquid and without it. */
function differences(wet: PaletteStore, dry: PaletteStore, chunks: readonly ChunkCoord[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of chunks) {
    const a = consumerHashes(deriveFromStore(wet, c.cx, c.cy, c.cz, WORLD_RULES));
    const b = consumerHashes(deriveFromStore(dry, c.cx, c.cy, c.cz, WORLD_RULES));
    for (const k of Object.keys(a)) {
      out[k] ??= [];
      if (a[k] !== b[k]) out[k]!.push(`${c.cx},${c.cy},${c.cz}`);
    }
  }
  return out;
}

describe('liquid is open space to every consumer but its own', () => {
  it('derives the hilly world\'s lakes and the caves world\'s pools to the same mesh, collision, nav, light, occupancy, regions and shader data with the liquid as without it', { timeout: 300_000 }, () => {
    const report: Record<string, unknown> = {};
    for (const [name, w, area] of [
      // A small lake whole (open water and its shore) and a stretch of the large lake's shore.
      ['hilly small lake', hillyWorld(), [768, 800, 960, 1024]],
      ['hilly large lake', hillyWorld(), [-96, 1504, 96, 1760]],
      ['caves', cavesWorld({ footprint: 256 }), [0, 0, 256, 256]],
    ] as const) {
      const store = createWorldStore(grid);
      loadArea(w.grids[0]!, store, area[0], area[1], area[2], area[3]);
      const near = chunksNearLiquid(store);
      expect(near.cells, `${name}: liquid cells`).toBeGreaterThan(1000);
      const diff = differences(store, drained(store), near.chunks);
      report[name] = { liquidCells: near.cells, chunks: near.chunks.length, differing: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.length])) };
      for (const k of ['mesh', 'collision', 'nav', 'light', 'occupancy', 'regions', 'shader']) expect(diff[k], `${name}: ${k}`).toEqual([]);
    }
    console.log(JSON.stringify(report));
  });

  it('reads liquid under a gable roof, on the walls\' tops, as the air it stands in for (the roof words, the shader data)', () => {
    const wet = createWorldStore(grid);
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) putVoxel(wet, x, 0, z, MAT.grass, C.terrain);
    // A 45° gable roof over two walls whose tops lie one cell under it, that cell water: the roof mesher's "one air
    // cell over a body" (it closes the roof down onto the wall there).
    for (let z = 2; z < 10; z++) {
      for (let x = 1; x <= 9; x++) putVoxel(wet, x, 4 + Math.min(x - 1, 9 - x), z, MAT.rock, C.roof);
      for (const x of [2, 8]) {
        for (let y = 1; y <= 3; y++) putVoxel(wet, x, y, z, MAT.rock, C.wall);
        putVoxel(wet, x, 4, z, MAT.water, C.liquid);
      }
    }
    const dry = createWorldStore(grid);
    dry.adoptPayload(0, 0, 0, wet.chunkPayload(0, 0, 0, true));
    for (let z = 2; z < 10; z++) for (const x of [2, 8]) dry.setVoxel(x, 4, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    const diff = differences(wet, dry, [{ cx: 0, cy: 0, cz: 0 }]);
    console.log(JSON.stringify(diff));
    for (const k of ['mesh', 'collision', 'nav', 'light', 'occupancy', 'regions', 'shader']) expect(diff[k], k).toEqual([]);
  });
});

const S = LIQUID_STEPS_PER_CELL;
const AIR = { material: 0, role: 0, shape: 0, wetness: 0 };

/** Per face, the quads and their area in cells², and every quad's box (steps). */
function facesOf(l: LiquidPart | null | undefined): { count: number; byFace: Record<number, { quads: number; area: number }>; quads: ReturnType<typeof liquidQuad>[] } {
  const byFace: Record<number, { quads: number; area: number }> = {};
  const quads: ReturnType<typeof liquidQuad>[] = [];
  for (let k = 0; k < (l?.count ?? 0); k++) {
    const q = liquidQuad(l!, k);
    quads.push(q);
    const d = [q.max[0] - q.min[0], q.max[1] - q.min[1], q.max[2] - q.min[2]].filter((v) => v !== 0);
    const f = (byFace[q.face] ??= { quads: 0, area: 0 });
    f.quads++;
    f.area += (d[0]! * d[1]!) / (S * S);
  }
  return { count: l?.count ?? 0, byFace, quads };
}

/** Ground filled whole over a box of cells (x0..x1, y0..y1, z0..z1 inclusive). */
function groundBox(s: PaletteStore, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) putVoxel(s, x, y, z, MAT.rock, C.terrain);
}

/** Liquid over a box of cells, its top layer filled to `top` (1 … 15). */
function waterBox(s: PaletteStore, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, top = 15, material = MAT.water): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) putVoxel(s, x, y, z, material, C.liquid, y === y1 ? top : 15);
}

const liquidAt = (s: PaletteStore, cx = 0, cy = 0, cz = 0): LiquidPart | null | undefined => deriveFromStore(s, cx, cy, cz, WORLD_RULES).liquid;

describe('the liquid part: faces against open space, merged into quads', () => {
  it('draws a full pool sunk in the ground as its one top quad', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 9, 0, 3, 0, 9);
    for (let x = 2; x <= 7; x++) for (let y = 1; y <= 3; y++) for (let z = 2; z <= 7; z++) s.setVoxel(x, y, z, AIR);
    waterBox(s, 2, 7, 1, 3, 2, 7);
    const f = facesOf(liquidAt(s));
    expect(f.count).toBe(1);
    expect(f.quads[0]).toEqual({ face: LIQUID_FACE.py, material: MAT.water, min: [2 * S, 4 * S, 2 * S], max: [8 * S, 4 * S, 8 * S] });
  });

  it('puts a partly filled top at its fill level', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 9, 0, 3, 0, 9);
    for (let x = 2; x <= 7; x++) for (let y = 1; y <= 3; y++) for (let z = 2; z <= 7; z++) s.setVoxel(x, y, z, AIR);
    waterBox(s, 2, 7, 1, 3, 2, 7, 7);
    const f = facesOf(liquidAt(s));
    expect(f.count).toBe(1);
    expect(f.quads[0]).toEqual({ face: LIQUID_FACE.py, material: MAT.water, min: [2 * S, 3 * S + 7, 2 * S], max: [8 * S, 3 * S + 7, 8 * S] });
  });

  it('draws the step between two fills as one side quad, each fill as its own top', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 9, 0, 3, 0, 9);
    for (let x = 2; x <= 7; x++) for (let y = 1; y <= 3; y++) for (let z = 2; z <= 7; z++) s.setVoxel(x, y, z, AIR);
    waterBox(s, 2, 4, 1, 3, 2, 7, 15);
    waterBox(s, 5, 7, 1, 3, 2, 7, 7);
    const f = facesOf(liquidAt(s));
    expect(f.count).toBe(3);
    expect(f.byFace[LIQUID_FACE.py]).toEqual({ quads: 2, area: 36 });
    expect(f.quads.find((q) => q.face === LIQUID_FACE.px)).toEqual({ face: LIQUID_FACE.px, material: MAT.water, min: [5 * S, 3 * S + 7, 2 * S], max: [5 * S, 4 * S, 8 * S] });
  });

  it('draws a wall of water standing in the air as its top and four whole sides, nothing against the ground under it', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 9, 0, 0, 0, 9);
    waterBox(s, 3, 6, 1, 3, 3, 6);
    const f = facesOf(liquidAt(s));
    expect(f.count).toBe(5);
    expect(f.byFace[LIQUID_FACE.py]).toEqual({ quads: 1, area: 16 });
    for (const face of [LIQUID_FACE.px, LIQUID_FACE.nx, LIQUID_FACE.pz, LIQUID_FACE.nz]) expect(f.byFace[face], `face ${face}`).toEqual({ quads: 1, area: 12 });
    expect(f.byFace[LIQUID_FACE.ny]).toBeUndefined();
    // Its partly filled top layer: the sides end at the fill.
    waterBox(s, 3, 6, 1, 3, 3, 6, 9);
    const g = facesOf(liquidAt(s));
    expect(g.count).toBe(5);
    expect(g.quads.find((q) => q.face === LIQUID_FACE.px)!.max[1]).toBe(3 * S + 9);
  });

  it('makes no face where water meets water across a chunk border: each chunk draws its half and its own outer side', () => {
    const s = createWorldStore(grid);
    groundBox(s, 24, 39, 0, 0, 0, 9);
    waterBox(s, 28, 35, 1, 2, 2, 5);
    const a = facesOf(liquidAt(s, 0, 0, 0));
    const b = facesOf(liquidAt(s, 1, 0, 0));
    expect(a.byFace[LIQUID_FACE.py]).toEqual({ quads: 1, area: 16 });
    expect(b.byFace[LIQUID_FACE.py]).toEqual({ quads: 1, area: 16 });
    expect(a.byFace[LIQUID_FACE.px]).toBeUndefined();
    expect(b.byFace[LIQUID_FACE.nx]).toBeUndefined();
    expect(a.byFace[LIQUID_FACE.nx]).toEqual({ quads: 1, area: 8 });
    expect(b.byFace[LIQUID_FACE.px]).toEqual({ quads: 1, area: 8 });
    expect(a.quads.every((q) => q.max[0] <= 32 * S) && b.quads.every((q) => q.min[0] >= 0)).toBe(true);
  });

  it('gives a cellar pool under a lake two surfaces in one column', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 9, 0, 13, 0, 9);
    for (let x = 2; x <= 7; x++) for (let z = 2; z <= 7; z++) {
      for (let y = 10; y <= 13; y++) s.setVoxel(x, y, z, AIR);
      for (let y = 2; y <= 4; y++) s.setVoxel(x, y, z, AIR);
    }
    waterBox(s, 2, 7, 10, 13, 2, 7);
    waterBox(s, 2, 7, 2, 2, 2, 7, 8);
    const f = facesOf(liquidAt(s));
    expect(f.count).toBe(2);
    expect(f.quads.map((q) => q.min[1]).sort((p, q) => p - q)).toEqual([2 * S + 8, 14 * S]);
  });

  it('builds nothing where there is no liquid (no part, no bytes), and nothing for liquid closed in on every side', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 9, 0, 3, 0, 9);
    const d = deriveFromStore(s, 0, 0, 0, WORLD_RULES);
    expect(d.liquid).toBeUndefined();
    s.setVoxel(4, 2, 4, { material: MAT.water, role: C.liquid, shape: 15, wetness: 0 });
    expect(liquidAt(s)).toBeUndefined();
  });

  it('joins a chunk\'s 16³ sections into the faces the whole chunk draws (the same area by face and material)', () => {
    const s = createWorldStore(grid);
    loadArea(hillyWorld().grids[0]!, s, 800, 832, 960, 992);
    const sections = sectionGrid(16);
    let compared = 0;
    for (const key of s.chunkKeys()) {
      const c = coordOf(key);
      const whole = facesOf(liquidAt(s, c.cx, c.cy, c.cz));
      if (whole.count === 0) continue;
      const parts: Array<LiquidPart | null | undefined> = [];
      for (let id = 0; id < 8; id++) {
        const [ox, oy, oz] = sectionLocalOrigin(E, 16, id);
        parts[id] = deriveSectionFromStore(s, sections, c.cx * 2 + ox / 16, c.cy * 2 + oy / 16, c.cz * 2 + oz / 16, WORLD_RULES).liquid;
      }
      const joined = facesOf(joinLiquid(parts, (id) => sectionLocalOrigin(E, 16, id)));
      for (const face of Object.keys(whole.byFace)) expect(joined.byFace[Number(face)]!.area, `${c.cx},${c.cy},${c.cz} face ${face}`).toBeCloseTo(whole.byFace[Number(face)]!.area, 6);
      expect(Object.keys(joined.byFace)).toEqual(Object.keys(whole.byFace));
      compared++;
    }
    expect(compared).toBeGreaterThan(4);
  });
});

describe('the feeds rule: what one cell\'s change makes stale', () => {
  const water = (shape = 15, material: number = MAT.water): number => recordValue(material, C.liquid, shape, 0);
  const rock = recordValue(MAT.rock, C.terrain, 15, 0);
  const geometry = DERIVED_PART.mesh | DERIVED_PART.collision | DERIVED_PART.nav | DERIVED_PART.light;

  it('feeds the liquid part alone for a change only between air and liquid, or of a liquid\'s fill, material or wetness', () => {
    expect(changeFeeds(0, water())).toBe(DERIVED_PART.liquid);
    expect(changeFeeds(water(), 0)).toBe(DERIVED_PART.liquid);
    expect(changeFeeds(water(15), water(6))).toBe(DERIVED_PART.liquid);
    expect(changeFeeds(water(15, MAT.water), water(15, MAT.sand))).toBe(DERIVED_PART.liquid);
    expect(changeFeeds(water(), recordValue(MAT.water, C.liquid, 15, 3))).toBe(DERIVED_PART.liquid);
    expect(changeFeeds(water(), water())).toBe(0);
  });

  it('feeds what it fed before, and the liquid part besides, for a change of a cell that is not liquid or air', () => {
    expect(changeFeeds(rock, 0) & geometry).toBe(geometry);
    expect(changeFeeds(rock, 0) & DERIVED_PART.liquid).toBe(DERIVED_PART.liquid);
    expect(changeFeeds(rock, water()) & (geometry | DERIVED_PART.liquid)).toBe(geometry | DERIVED_PART.liquid);
    // A material or wetness change of ground: the shader data alone (the liquid wears its own material).
    expect(changeFeeds(rock, recordValue(MAT.sand, C.terrain, 15, 0))).toBe(DERIVED_PART.shader);
    expect(changeFeeds(rock, recordValue(MAT.rock, C.terrain, 15, 4))).toBe(DERIVED_PART.shader);
  });

  it('reports a stroke\'s parts by its cells: liquid strokes of every kind the liquid part alone, mixed strokes both', () => {
    const s = createWorldStore(grid);
    groundBox(s, 0, 15, 0, 3, 0, 15);
    for (let x = 4; x <= 11; x++) for (let y = 2; y <= 3; y++) for (let z = 4; z <= 11; z++) s.setVoxel(x, y, z, AIR);
    const run = (c: Record<string, unknown>): number => applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, ...c })).parts;
    const liquid = { material: MAT.water, role: C.liquid, wetness: 0 };
    // A brush of water into the hollow (add writes into air and liquid only), smooth: partly filled rims.
    expect(run({ kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [8, 3, 8], mode: 'add', smooth: true, voxel: liquid })).toBe(DERIVED_PART.liquid);
    // Water filled over the rest of the hollow, then lowered (a set with a fill level), then repainted another liquid.
    expect(run({ kind: 'fill', min: [4, 2, 4], max: [11, 3, 11], mode: 'add', voxel: liquid })).toBe(DERIVED_PART.liquid);
    const top: number[] = [];
    for (let x = 4; x <= 11; x++) for (let z = 4; z <= 11; z++) top.push(x, 3, z);
    expect(run({ kind: 'set', cells: top, voxel: { ...liquid, shape: 7 } })).toBe(DERIVED_PART.liquid);
    expect(run({ kind: 'fill', min: [4, 2, 4], max: [11, 3, 11], mode: 'paint', voxel: { ...liquid, material: MAT.sand } })).toBe(DERIVED_PART.liquid);
    // A dig of water alone; a dig that takes ground beside the water too.
    expect(run({ kind: 'dig', cells: [4, 3, 4, 5, 3, 4] })).toBe(DERIVED_PART.liquid);
    const mixed = run({ kind: 'fill', min: [11, 2, 6], max: [13, 3, 6], mode: 'dig' });
    expect(mixed & (geometry | DERIVED_PART.liquid)).toBe(geometry | DERIVED_PART.liquid);
    // A paint of ground: the shader data alone.
    expect(run({ kind: 'fill', min: [0, 0, 0], max: [1, 0, 1], mode: 'paint', voxel: { material: MAT.sand, role: C.terrain, wetness: 0 } })).toBe(DERIVED_PART.shader);
  });
});

describe('a liquid edit where the world runs: real workers, region files on disk', () => {
  let dir = '';
  let workerFile = '';
  let oracle: PaletteStore;
  let pool: WorkerPool | null = null;
  let disk: DiskRegions | null = null;
  // The hilly world's small lake (its top cell is y 24) and the ground round it; the stroke goes at a chunk corner in
  // its open water, found below.
  const AREA = [768, 800, 1024, 1056] as const;
  const TOP = 24;
  let CX = 0;
  let CZ = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-voxel-liquid-'));
    workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `stream-worker-liquid-${process.pid}.mjs`));
    oracle = pickStore(grid);
    writeWorldRegions(hillyWorld().grids[0]!, grid, join(dir, 'world'), 'stacked', 512, AREA[0], AREA[1], AREA[2], AREA[3], oracle);
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    const open = (x: number, z: number): boolean => {
      for (let dx = -3; dx < 3; dx++) for (let dz = -3; dz < 3; dz++) if (oracle.voxelAt(x + dx, TOP, z + dz, v).role !== C.liquid || oracle.voxelAt(x + dx, TOP + 1, z + dz, v).material !== 0) return false;
      return true;
    };
    for (let x = AREA[0] + 64; x < AREA[2] - 64 && CX === 0; x += 32) for (let z = AREA[1] + 64; z < AREA[3] - 64 && CX === 0; z += 32) if (open(x, z)) [CX, CZ] = [x, z];
  }, 120_000);

  afterAll(async () => {
    pool?.close();
    await disk?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workerFile, { force: true });
  });

  it('derives only the liquid part of the sections round a liquid-only stroke over 4 chunks, equal to a fresh full derive; a dig of the shore derives as before, its new side face with it', { timeout: 120_000 }, async () => {
    pool = new WorkerPool({ size: 2, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
    disk = new DiskRegions(join(dir, 'world'));
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool, ring: { loadRadius: 64, unloadRadius: 96, loadHeight: 64, unloadHeight: 96, nearRadius: 48 }, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, deriveMsPerUpdate: 10_000 });
    const truth = createWorldStore(grid);
    for (const key of oracle.chunkKeys()) {
      const c = coordOf(key);
      truth.adoptPayload(c.cx, c.cy, c.cz, oracle.chunkPayload(c.cx, c.cy, c.cz, true));
    }
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    for (let x = CX - 2; x < CX + 2; x++) for (let z = CZ - 2; z < CZ + 2; z++) expect(truth.voxelAt(x, TOP, z, v).role, `open water at ${x},${z}`).toBe(C.liquid);
    s.setFocus(CX, TOP, CZ);
    await s.settle();
    const derived = new Set<string>();
    const liquid = new Set<string>();
    s.on((e) => {
      if (e.type === 'derived') derived.add(`${e.cx},${e.cy},${e.cz}`);
      if (e.type === 'liquid') liquid.add(`${e.cx},${e.cy},${e.cz}`);
    });
    const sections = sectionGrid(16);
    /** Every section derived now equals a fresh derive of the truth: its canonical bytes and its liquid part. */
    const expectFresh = (): number => {
      let n = 0;
      for (const d of s.derivedChunks()) {
        const a = d.result.assembly;
        if (a === null) continue;
        const fresh = deriveSectionFromStore(truth, sections, d.cx, d.cy, d.cz, WORLD_RULES);
        expect(Buffer.compare(Buffer.from(encodeDerived(a)), Buffer.from(encodeDerived(fresh))), `section ${d.cx},${d.cy},${d.cz}`).toBe(0);
        expect(Buffer.from(a.liquid?.quads ?? []).equals(Buffer.from(fresh.liquid?.quads ?? [])), `liquid of ${d.cx},${d.cy},${d.cz}`).toBe(true);
        n++;
      }
      return n;
    };
    expect(expectFresh()).toBeGreaterThan(50);
    const counters = (): number[] => [s.counters.derives, s.counters.shaderDerives, s.counters.liquidDerives, s.counters.collisionDerives];

    // The lake's top cells round the corner where four chunks meet, taken out (liquid to air), then the water put back lower.
    const dig = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [CX - 2, TOP, CZ - 2], max: [CX + 1, TOP, CZ + 1], mode: 'dig' });
    const [d0, sh0, l0, c0] = counters();
    const out = s.edit(dig);
    applyEdit({ store: () => truth }, dig);
    expect(out.parts).toBe(DERIVED_PART.liquid);
    expect(new Set(out.chunks.map((u) => `${u.cx},${u.cz}`)).size).toBe(4);
    await s.settle();
    const want = dependentChunks(sections, editBounds(grid, dig), 1).map((c) => `${c.cx},${c.cy},${c.cz}`).sort();
    expect([...derived]).toEqual([]);
    expect([...liquid].sort()).toEqual(want);
    expect(counters()).toEqual([d0, sh0, l0! + want.length, c0]);
    expectFresh();

    // The water put back a fill lower than before: the liquid part alone again.
    const refill = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [CX - 2, TOP, CZ - 2], max: [CX + 1, TOP, CZ + 1], mode: 'place', voxel: { material: MAT.water, role: C.liquid, wetness: 0 } });
    liquid.clear();
    const back = s.edit(refill);
    applyEdit({ store: () => truth }, refill);
    expect(back.parts).toBe(DERIVED_PART.liquid);
    await s.settle();
    expect([...derived]).toEqual([]);
    expect([...liquid].sort()).toEqual(want);
    expectFresh();

    // Ground dug beside the water at the shore: the dig derives what it derives today, and the liquid part with it.
    let shore: [number, number] | null = null;
    for (let x = CX - 60; x < CX + 60 && shore === null; x++) for (let z = CZ - 60; z < CZ + 60 && shore === null; z++) {
      if (truth.voxelAt(x, TOP, z, v).role === C.liquid && truth.voxelAt(x + 1, TOP, z, v).role === C.terrain && truth.voxelAt(x + 1, TOP + 1, z, v).material === 0) shore = [x + 1, z];
    }
    expect(shore).not.toBeNull();
    const bank = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [shore![0], TOP - 1, shore![1]], max: [shore![0] + 1, TOP, shore![1]], mode: 'dig' });
    const [d1] = counters();
    const banked = s.edit(bank);
    applyEdit({ store: () => truth }, bank);
    expect(banked.parts & (DERIVED_PART.mesh | DERIVED_PART.liquid)).toBe(DERIVED_PART.mesh | DERIVED_PART.liquid);
    await s.settle();
    expect(s.counters.derives).toBeGreaterThan(d1!);
    expect(expectFresh()).toBeGreaterThan(50);
  });
});
