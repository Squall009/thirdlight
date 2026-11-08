/**
 * The relief ring in the streamer against real boundaries: `worker_threads`
 * workers running the bundled worker module, the town's region files on
 * disk, the world rules in 16³ sections. The ring's sections (and only
 * they) carry the relief part, meshed against their neighbours as the ring
 * holds them; the drawn surfaces are crack-free against the plain mesh at
 * every swap while the focus moves; every other output is byte for byte
 * the plain derive's; and relief keeps to its share of the budget,
 * shrinking its ring, without evicting a chunk of the world.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChunkDrawBatcher,
  chunkDrawBatchTransfer,
  chunkGrid,
  createWorldStore,
  deriveSectionFromStore,
  encodeDerived,
  jobRadius,
  POSITION_STEPS_PER_CELL,
  RELIEF_BUDGET_SHARE,
  RELIEF_FOCUS_STEP_CELLS,
  sectionGrid,
  SURFACE_VERTEX_BYTES,
  VoxelStreamer,
  WORLD_RULES,
  WorkerPool,
  type ChunkDrawBatch,
  type DerivedData,
  type PaletteStore,
  type ReliefRingSettings,
  type StreamRing,
} from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickStore, surfaceY } from './regions';
import { drawnSurface, RELIEF_SECTION_EDGE, watertight, worldMesh } from './relief-checks';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, writeWorldRegions } from './stream-node';
import { townWorld } from './town';

const grid = chunkGrid(32);
const sections = sectionGrid(RELIEF_SECTION_EDGE);
const S = POSITION_STEPS_PER_CELL;
/** The town's 64 m square, all of it loaded. */
const FOOT = 128;
const RING: StreamRing = { loadRadius: 96, unloadRadius: 128, loadHeight: 64, unloadHeight: 96, nearRadius: 48 };
/** A small ring (displacing to 8 m), so the window the checks read (7³ sections, 56 m) holds it and its border. */
const RELIEF: ReliefRingSettings = { n: 2, radius: 16 };
const WINDOW = 3;

let dir = '';
let workerFile = '';
let oracle: PaletteStore;
let focus = { x: 64, y: 0, z: 64 };
const pools: WorkerPool[] = [];
const disks: DiskRegions[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tl-relief-ring-'));
  workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `relief-ring-worker-${process.pid}.mjs`));
  oracle = pickStore(grid);
  writeWorldRegions(townWorld({ footprint: FOOT }).grids[0]!, grid, join(dir, 'world'), 'stacked', 512, 0, 0, FOOT, FOOT, oracle);
  focus = { x: 64, y: (surfaceY(oracle, 64, 64, 200, -64) ?? 0) + 4, z: 64 };
}, 120_000);

afterAll(async () => {
  for (const p of pools) p.close();
  for (const d of disks) await d.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(workerFile, { force: true });
});

function streamer(relief: ReliefRingSettings, budgetBytes = 256 * 1024 * 1024): VoxelStreamer {
  const pool = new WorkerPool({ size: 3, create: () => nodePoolWorker(workerFile), timeoutMs: 30_000, maxQueued: 256 });
  pools.push(pool);
  const disk = new DiskRegions(join(dir, 'world'));
  disks.push(disk);
  return new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool, ring: RING, budgetBytes, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: RELIEF_SECTION_EDGE, mips: [], relief, deriveMsPerUpdate: 10_000 });
}

const sectionOf = (f: { x: number; y: number; z: number }): [number, number, number] => [Math.floor(f.x / 16), Math.floor(f.y / 16), Math.floor(f.z / 16)];

/** The drawn surfaces of the window round `at` (sections) against the plain ones: crack-free; returns relief and plain section counts. */
function checkWindow(s: VoxelStreamer, at: readonly [number, number, number], label: string): { relief: number; plain: number } {
  const parts: Array<{ d: DerivedData; at: [number, number, number] }> = [];
  let relief = 0;
  let plain = 0;
  for (let x = -WINDOW; x <= WINDOW; x++) for (let y = -WINDOW; y <= WINDOW; y++) for (let z = -WINDOW; z <= WINDOW; z++) {
    const c: [number, number, number] = [at[0] + x, at[1] + y, at[2] + z];
    const a = s.derivedOf(...c, true)?.assembly ?? null;
    if (a === null || (a.ground.vertexCount === 0 && a.base.vertexCount === 0)) continue;
    parts.push({ d: a, at: c });
    if (a.relief !== undefined) relief++;
    else plain++;
  }
  const origin = [0, 1, 2].map((k) => ((at[k]! - WINDOW) * RELIEF_SECTION_EDGE - 2) * S) as [number, number, number];
  const span = (2 * WINDOW + 1) * RELIEF_SECTION_EDGE * S;
  const box = { lo: [4 * S, 4 * S, 4 * S], hi: [span, span, span] };
  for (const kind of ['ground', 'base'] as const) {
    const p = worldMesh(parts.map((q) => ({ s: q.d[kind], at: q.at })), origin);
    const r = worldMesh(parts.map((q) => ({ s: drawnSurface(q.d, kind), at: q.at })), origin);
    const t = watertight(p, r, box);
    expect(t.unexplained, `${label} ${kind}: ${t.firstUnexplained}`).toBe(0);
    if (p.tris.length > 0) expect(t.areaRatio, `${label} ${kind} area`).toBeCloseTo(1, 3);
  }
  return { relief, plain };
}

/** Every section with a result: relief part exactly where the ring holds it, the plain derive's canonical bytes. */
function checkSections(s: VoxelStreamer): number {
  const ring = s.relief!.ring;
  let n = 0;
  for (const d of s.derivedChunks()) {
    const a = d.result.assembly;
    if (a === null) continue;
    expect(a.relief !== undefined, `section ${d.cx},${d.cy},${d.cz} relief`).toBe(ring.has(d.cx, d.cy, d.cz) && (a.ground.vertexCount > 0 || a.base.vertexCount > 0 || a.relief !== undefined));
    if (a.relief !== undefined) expect(a.relief.n).toBe(ring.n);
    const want = encodeDerived(deriveSectionFromStore(oracle, sections, d.cx, d.cy, d.cz, WORLD_RULES));
    expect(Buffer.from(encodeDerived(a)).equals(Buffer.from(want)), `section ${d.cx},${d.cy},${d.cz}: plain outputs`).toBe(true);
    n++;
  }
  return n;
}

describe('the relief ring while streaming (real workers, town regions on disk)', () => {
  it('derives relief on the ring only, crack-free against the plain mesh, every other output the plain derive, and moves it in atomic swaps', { timeout: 240_000 }, async () => {
    const s = streamer(RELIEF);
    s.setFocus(focus.x, focus.y, focus.z);
    await s.settle();
    const ring = s.relief!.ring;
    expect(ring.size).toBeGreaterThan(8);
    expect(checkSections(s)).toBeGreaterThan(50);
    const first = checkWindow(s, sectionOf(focus), 'settled');
    expect(first.relief).toBeGreaterThan(0);
    expect(first.plain).toBeGreaterThan(0);
    const m = s.metrics();
    expect(m.bytes.relief).toBeGreaterThan(0);
    expect(m.relief!.displaceRadius).toBe(RELIEF.radius);
    // Moving 6 m: the ring is planned again; what changed swaps together, checked at every swap as it lands.
    const swaps: number[] = [];
    const failures: string[] = [];
    let reliefOnly = 0;
    let bodies = 0;
    const to = { x: focus.x + 12, y: focus.y, z: focus.z + 5 };
    s.on((e) => {
      if (e.type === 'chunk' && !e.shaderOnly) (e.reliefOnly ? reliefOnly++ : bodies++);
      if (e.type !== 'swap') return;
      swaps.push(e.report.sections);
      // Checked as the swap lands (inside the streamer's task): a failure is kept, not thrown into the streamer.
      try {
        checkWindow(s, sectionOf(focus), `swap ${swaps.length}`);
        checkWindow(s, sectionOf(to), `swap ${swaps.length} (new focus)`);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    });
    const before = new Set([...ring.list()].map((c) => `${c.sx},${c.sy},${c.sz}`));
    s.setFocus(to.x, to.y, to.z);
    await s.settle();
    const after = new Set([...ring.list()].map((c) => `${c.sx},${c.sy},${c.sz}`));
    expect([...after].some((k) => !before.has(k)) || [...before].some((k) => !after.has(k))).toBe(true);
    expect(swaps.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(s.relief!.plans).toBeGreaterThan(0);
    // A ring move changes only relief meshes: no chunk's body is replaced for it.
    expect(reliefOnly).toBeGreaterThan(0);
    expect(bodies).toBe(0);
    checkSections(s);
    checkWindow(s, sectionOf(to), 'moved');
    // Off: every section plain again, in one swap.
    s.relief!.set({ n: 0, radius: 0 });
    await s.settle();
    expect(s.relief!.ring.size).toBe(0);
    expect(s.metrics().bytes.relief).toBe(0);
    checkSections(s);
  });

  it('keeps relief to its share of the budget: the ring shrinks to fit and no chunk of the world is evicted for it', { timeout: 240_000 }, async () => {
    const big = { n: 4, radius: 32 };
    const free = streamer(big, 1024 * 1024 * 1024);
    free.setFocus(focus.x, focus.y, focus.z);
    await free.settle();
    const m0 = free.metrics();
    const base = m0.bytes.total - m0.bytes.relief;
    expect(m0.bytes.relief).toBeGreaterThan(0);
    expect(m0.relief!.shrunk, `relief ${m0.bytes.relief} B in a share of ${m0.bytes.reliefShare}`).toBe(false);
    // A budget whose share holds half the ring's relief, the base world fitting the rest.
    const budget = Math.max(Math.ceil((m0.bytes.relief * 0.5) / RELIEF_BUDGET_SHARE), Math.ceil((base * 1.2) / (1 - RELIEF_BUDGET_SHARE)));
    const share = Math.floor(budget * RELIEF_BUDGET_SHARE);
    expect(share, `base ${base}, relief ${m0.bytes.relief}: the test needs relief past its share`).toBeLessThan(m0.bytes.relief);
    const tight = streamer(big, budget);
    tight.setFocus(focus.x, focus.y, focus.z);
    await tight.settle();
    const m = tight.metrics();
    expect(m.relief!.shrunk).toBe(true);
    expect(m.relief!.displaceRadius).toBeLessThan(big.radius);
    expect(m.bytes.relief).toBeLessThanOrEqual(share);
    expect(m.bytes.reliefShare).toBe(share);
    // The world as loaded with the free ring: every chunk resident, none evicted.
    expect(m.counters.evictions).toBe(0);
    expect(m.resident).toBe(m0.resident);
    expect(tight.relief!.ring.size).toBeGreaterThan(0);
    expect(tight.relief!.ring.size).toBeLessThan(free.relief!.ring.size);
    checkSections(tight);
    checkWindow(tight, sectionOf(focus), 'shrunk');
  });

  it("tells the draws the ring's state: its steps, where it displaces and its centre, once a step of the centre, and its relief chunks come with crease weights and their plain surfaces to cast shadows from", { timeout: 240_000 }, async () => {
    const s = streamer(RELIEF);
    const batches: ChunkDrawBatch[] = [];
    new ChunkDrawBatcher('town', s, RELIEF_SECTION_EDGE, (b) => batches.push(b));
    s.setFocus(focus.x, focus.y, focus.z);
    await s.settle();
    await Promise.resolve();
    const told = batches.filter((b) => b.relief !== undefined).map((b) => b.relief!);
    expect(told.length).toBeGreaterThan(0);
    expect(told.at(-1)).toEqual({ n: RELIEF.n, radius: RELIEF.radius, focus: [focus.x, focus.y, focus.z] });
    // The relief sections' chunks are drawn with crease weights (the vertex stage moves them), the rest without.
    const drawn = batches.flatMap((b) => b.chunks).filter((c) => c.kind === 'draw');
    expect(drawn.some((c) => c.ground?.crease !== undefined || c.base?.crease !== undefined)).toBe(true);
    expect(drawn.some((c) => c.ground?.crease === undefined && c.base?.crease === undefined)).toBe(true);
    // A relief chunk also carries its plain surfaces (a view with shadows casts from them), byte-equal to the plain
    // join, handed over with the batch; a plain chunk carries none (it casts itself).
    const last = new Map(drawn.map((c) => [`${c.cx},${c.cy},${c.cz}`, c]));
    let reliefTris = 0;
    let casterTris = 0;
    for (const c of last.values()) {
      const relief = c.ground?.crease !== undefined || c.base?.crease !== undefined;
      expect(c.caster !== undefined, `${c.cx},${c.cy},${c.cz}`).toBe(relief);
      if (c.caster === undefined) continue;
      const plain = s.joinedChunk(c.cx, c.cy, c.cz)!;
      for (const k of ['ground', 'base'] as const) {
        expect((c.caster[k] as { crease?: Uint8Array }).crease).toBeUndefined();
        expect(c.caster[k].vertexCount).toBe(plain[k].vertexCount);
        expect(Buffer.from(c.caster[k].vertices.subarray(0, plain[k].vertexCount * SURFACE_VERTEX_BYTES)).equals(Buffer.from(plain[k].vertices.subarray(0, plain[k].vertexCount * SURFACE_VERTEX_BYTES)))).toBe(true);
        expect([...c.caster[k].indices]).toEqual([...plain[k].indices]);
      }
      reliefTris += (c.ground!.indices.length + c.base!.indices.length) / 3;
      casterTris += (c.caster.ground.indices.length + c.caster.base.indices.length) / 3;
    }
    // At 2 steps a cell the plain casters hold about a quarter of the relief triangles (merged faces: fewer).
    expect(casterTris).toBeGreaterThan(0);
    expect(casterTris).toBeLessThan(reliefTris / 3);
    const withCaster = batches.find((b) => b.chunks.some((c) => c.caster !== undefined))!;
    const handed = new Set(chunkDrawBatchTransfer(withCaster));
    const c0 = withCaster.chunks.find((c) => c.caster !== undefined)!;
    expect(handed.has(c0.caster!.ground.vertices.buffer as ArrayBuffer) && handed.has(c0.caster!.base.indices.buffer as ArrayBuffer)).toBe(true);
    // A move under a step tells nothing; a step tells the new centre.
    const n0 = batches.length;
    s.setFocus(focus.x + RELIEF_FOCUS_STEP_CELLS / 2, focus.y, focus.z);
    s.update();
    await Promise.resolve();
    expect(batches.slice(n0).some((b) => b.relief !== undefined)).toBe(false);
    s.setFocus(focus.x + RELIEF_FOCUS_STEP_CELLS, focus.y, focus.z);
    s.update();
    await Promise.resolve();
    expect(batches.slice(n0).filter((b) => b.relief !== undefined).map((b) => b.relief!.focus)).toEqual([[focus.x + RELIEF_FOCUS_STEP_CELLS, focus.y, focus.z]]);
    // The ring off: the draws are told (nothing displaces), once.
    s.relief!.set({ n: 0, radius: 0 });
    await s.settle();
    await Promise.resolve();
    const off = batches.slice(n0).filter((b) => b.relief !== undefined && b.relief.n === 0);
    expect(off.map((b) => b.relief)).toEqual([{ n: 0, radius: 0, focus: [focus.x + RELIEF_FOCUS_STEP_CELLS, focus.y, focus.z] }]);
  });
});
