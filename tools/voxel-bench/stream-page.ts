/**
 * The browser streaming page (driven by stream-page-cli.ts): flies a camera
 * over the hilly 2 × 2 km test world while the streaming core keeps the
 * chunks around it loaded, with the region files fetched by HTTP Range
 * requests and decoded in real module workers, and draws something cheap
 * so frame pacing is real: one box per loaded chunk that holds stored
 * cells (the ground's surface; air and solid uniform chunks are not drawn).
 *
 * three's WebGPURenderer draws it, on WebGPU or (`?renderer=webgl2`) its
 * WebGL 2 backend, the two paths the engine draws with. Box positions are
 * held relative to a floating origin and moved when it re-bases, as a
 * renderer's would be.
 *
 * A measuring tool, never shipped: it fetches from the bench's own server.
 */
import * as THREE from 'three/webgpu';
import {
  chunkGrid,
  chunkKey,
  createWorldStore,
  DEFAULT_STREAM_RING,
  eventTargetWorker,
  FloatingOrigin,
  RegionChunkSource,
  ringChunks,
  STREAM_POOL_SETTINGS,
  VOXEL_SIZE_M,
  VOXEL_STREAM_BUDGET_BYTES,
  VoxelStreamer,
  WORLD_GRID_ID,
  WorkerPool,
  type RegionByteSource,
  type SampleRing,
  type StreamRing,
} from '@thirdlight/voxel';
import { ALTITUDE_CELLS, loopAt, loopHeading } from './flight-path';
import { TEST_WORLD_ID } from './test-world-id';

/** What the driver asks for (plain data). */
export interface StreamPageSpec {
  /** Region file names present in `/world/` (a file not listed is all air, never fetched). */
  files: string[];
  workers: number;
  speed: number;
  seconds: number;
  /** Floating-origin re-base distance (metres). */
  rebaseM: number;
  derive: boolean;
  /** Source reads in flight and the largest gap (bytes) one range request spans (the source's coalescing). */
  maxReads: number;
  /** null: the source's default gap. */
  maxGap: number | null;
  /** Frames between near-ring checks (each lists the near ring, a little main-thread work of its own). */
  nearEvery: number;
}

/** Updates longer than this (ms) are kept one by one, with what happened around them. */
const LONG_UPDATE_MS = 4;
/** Instances the box mesh holds (resident chunks with stored cells; ~1,000 on hilly ground at the default ring). */
const BOX_CAPACITY = 8192;
/** A drawn box is this share of its chunk, so neighbours read apart. */
const BOX_SHRINK = 0.92;

interface LongUpdate {
  atMs: number;
  ms: number;
  crossed: boolean;
  resident: number;
  queued: number;
  heapBeforeMB: number;
  heapAfterMB: number;
}

const grid = chunkGrid(32);
const params = new URLSearchParams(location.search);
const rendererName = params.get('renderer') === 'webgl2' ? 'webgl2' : 'webgpu';

const heapMB = (): number => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m === undefined ? NaN : m.usedJSHeapSize / 1e6;
};
const q = (r: SampleRing, p: number): number => Number(r.quantile(p).toFixed(3));
const series = (r: SampleRing): { p50: number; p95: number; max: number; n: number } => ({ p50: q(r, 0.5), p95: q(r, 0.95), max: q(r, 1), n: r.count });

/** Region files over HTTP: one Range request per read, timed. */
class FetchRegions {
  requests = 0;
  bytes = 0;
  readonly ms: number[] = [];
  private readonly names: Set<string>;
  constructor(files: readonly string[]) {
    this.names = new Set(files);
  }
  open(name: string): RegionByteSource | null {
    if (!this.names.has(name)) return null;
    const url = `world/${name}`;
    return {
      read: async (offset, length) => {
        const t0 = performance.now();
        const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
        // Past the end of the file: fewer bytes (none), as the byte source promises.
        if (r.status === 416) return new Uint8Array(0);
        if (r.status !== 206 && r.status !== 200) throw new Error(`${name}: HTTP ${r.status}`);
        const all = new Uint8Array(await r.arrayBuffer());
        const b = r.status === 200 ? all.subarray(offset, offset + length) : all;
        this.requests++;
        this.bytes += b.length;
        this.ms.push(performance.now() - t0);
        return b;
      },
    };
  }
}

/** One box per drawn chunk, positioned relative to the floating origin. */
class ChunkBoxes {
  readonly mesh: THREE.InstancedMesh;
  private readonly slot = new Map<number, number>();
  private readonly cx = new Int32Array(BOX_CAPACITY);
  private readonly cy = new Int32Array(BOX_CAPACITY);
  private readonly cz = new Int32Array(BOX_CAPACITY);
  private readonly keys = new Float64Array(BOX_CAPACITY);
  private readonly color = new THREE.Color();
  overflow = 0;
  peak = 0;
  dirty = false;

  constructor(private readonly origin: FloatingOrigin) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), BOX_CAPACITY);
    // Colours exist before the first draw, so the pipeline is built with them.
    this.mesh.setColorAt(0, this.color.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  private place(i: number): void {
    const o = this.origin.origin;
    const half = grid.edge / 2;
    const s = grid.edge * VOXEL_SIZE_M * BOX_SHRINK;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const b = i * 16;
    m.fill(0, b, b + 16);
    m[b] = s;
    m[b + 5] = s;
    m[b + 10] = s;
    m[b + 12] = ((this.cx[i]! << grid.shift) + half - o.x) * VOXEL_SIZE_M;
    m[b + 13] = ((this.cy[i]! << grid.shift) + half - o.y) * VOXEL_SIZE_M;
    m[b + 14] = ((this.cz[i]! << grid.shift) + half - o.z) * VOXEL_SIZE_M;
    m[b + 15] = 1;
  }

  private tint(i: number, lit: boolean): void {
    // Low chunks green, high ones brown; derived ones brighter.
    const t = Math.min(1, Math.max(0, (this.cy[i]! + 2) / 10));
    this.color.setRGB(0.25 + 0.35 * t, 0.55 - 0.2 * t, 0.2);
    if (lit) this.color.multiplyScalar(1.5);
    this.mesh.setColorAt(i, this.color);
  }

  add(cx: number, cy: number, cz: number): void {
    const key = chunkKey(grid, cx, cy, cz);
    if (this.slot.has(key)) return;
    const i = this.mesh.count;
    if (i >= BOX_CAPACITY) {
      this.overflow++;
      return;
    }
    this.cx[i] = cx;
    this.cy[i] = cy;
    this.cz[i] = cz;
    this.keys[i] = key;
    this.slot.set(key, i);
    this.mesh.count = i + 1;
    this.peak = Math.max(this.peak, i + 1);
    this.place(i);
    this.tint(i, false);
    this.dirty = true;
  }

  lit(cx: number, cy: number, cz: number): void {
    const i = this.slot.get(chunkKey(grid, cx, cy, cz));
    if (i === undefined) return;
    this.tint(i, true);
    this.dirty = true;
  }

  remove(cx: number, cy: number, cz: number): void {
    const key = chunkKey(grid, cx, cy, cz);
    const i = this.slot.get(key);
    if (i === undefined) return;
    const last = this.mesh.count - 1;
    this.slot.delete(key);
    if (i !== last) {
      // The last box moves into the hole: matrix, colour and coordinates.
      const m = this.mesh.instanceMatrix.array as Float32Array;
      m.copyWithin(i * 16, last * 16, last * 16 + 16);
      const c = this.mesh.instanceColor!.array as Float32Array;
      c.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.cx[i] = this.cx[last]!;
      this.cy[i] = this.cy[last]!;
      this.cz[i] = this.cz[last]!;
      this.keys[i] = this.keys[last]!;
      this.slot.set(this.keys[i]!, i);
    }
    this.mesh.count = last;
    this.dirty = true;
  }

  /** After a re-base: every box's 32-bit position again, from its integer chunk. */
  rebase(): void {
    for (let i = 0; i < this.mesh.count; i++) this.place(i);
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
  }
}

interface Session {
  spec: StreamPageSpec;
  pool: WorkerPool;
  regions: FetchRegions;
  source: RegionChunkSource;
  streamer: VoxelStreamer;
  origin: FloatingOrigin;
  boxes: ChunkBoxes;
  coldMs: number;
  events: { loaded: number; unloaded: number; derived: number; damaged: number };
  rebaseMs: number[];
}

const longTasks: Array<{ start: number; ms: number }> = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, ms: e.duration });
  }).observe({ type: 'longtask', buffered: true });
} catch {
  // No long-task timing in this browser: the report says so (an empty list with `longTaskApi: false`).
}

const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: rendererName === 'webgl2' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4e8);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a4030, 1.2));
const sun = new THREE.DirectionalLight(0xfff2dc, 2);
sun.position.set(0.4, 1, 0.3);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 2000);
let session: Session | null = null;

/** Builds the pool, source and streamer, and settles the ring at the loop's start (the cold fill). */
async function prepare(spec: StreamPageSpec): Promise<Record<string, unknown>> {
  await renderer.init();
  const pool = new WorkerPool({ size: spec.workers, create: () => eventTargetWorker(new Worker('./stream-worker.js', { type: 'module' })), ...STREAM_POOL_SETTINGS });
  const regions = new FetchRegions(spec.files);
  const source = new RegionChunkSource({ worldId: TEST_WORLD_ID, gridId: WORLD_GRID_ID, grid, layout: 'stacked', footprint: 512, open: (n) => regions.open(n), maxOpen: 128, ...(spec.maxGap === null ? {} : { maxGap: spec.maxGap }) });
  const streamer = new VoxelStreamer({ store: createWorldStore(grid), source, pool, budgetBytes: VOXEL_STREAM_BUDGET_BYTES.low, dependencyRadius: 2, derive: spec.derive, readBatch: 64, maxReads: spec.maxReads });
  const origin = new FloatingOrigin({ grid, rebaseDistanceM: spec.rebaseM });
  const boxes = new ChunkBoxes(origin);
  scene.add(boxes.mesh);
  const s: Session = { spec, pool, regions, source, streamer, origin, boxes, coldMs: 0, events: { loaded: 0, unloaded: 0, derived: 0, damaged: 0 }, rebaseMs: [] };
  streamer.on((e) => {
    if (e.type === 'loaded') {
      s.events.loaded++;
      if (streamer.store.chunkForm(e.cx, e.cy, e.cz) === 'stored') boxes.add(e.cx, e.cy, e.cz);
    } else if (e.type === 'unloaded') {
      s.events.unloaded++;
      boxes.remove(e.cx, e.cy, e.cz);
    } else if (e.type === 'derived') {
      s.events.derived++;
      if ((streamer.derivedOf(e.cx, e.cy, e.cz)?.exposed ?? 0) > 0) boxes.lit(e.cx, e.cy, e.cz);
    } else if (e.type === 'damaged') s.events.damaged++;
  });
  origin.onRebase(() => boxes.rebase());
  const [x0, z0] = loopAt(0);
  origin.update(x0 * VOXEL_SIZE_M, ALTITUDE_CELLS * VOXEL_SIZE_M, z0 * VOXEL_SIZE_M);
  streamer.setFocus(x0, ALTITUDE_CELLS, z0);
  const t0 = performance.now();
  await streamer.settle();
  s.coldMs = performance.now() - t0;
  session = s;
  const m = streamer.metrics();
  return { coldMs: Math.round(s.coldMs), resident: m.resident, stored: m.residentStored, mb: Number((m.bytes.total / 1e6).toFixed(1)), requests: regions.requests, kb: Math.round(regions.bytes / 1e3), backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'webgpu' : 'webgl2' };
}

/** Flies the loop for the spec's seconds at its speed, one streamer update and one draw per frame; returns everything measured. */
async function fly(): Promise<Record<string, unknown>> {
  const s = session;
  if (s === null) throw new Error('prepare first');
  const { streamer, pool, origin, boxes, regions, spec } = s;
  for (const r of [streamer.planMs, streamer.adoptMs, streamer.apronMs, streamer.decodeUs, streamer.decompressUs, streamer.apronBytes, pool.stats.queueMs, pool.stats.runMs, pool.stats.workerUs]) r.clear();
  const c0 = { ...streamer.counters };
  const req0 = regions.requests;
  const bytes0 = regions.bytes;
  regions.ms.length = 0;
  const near: StreamRing = { ...DEFAULT_STREAM_RING, loadRadius: DEFAULT_STREAM_RING.nearRadius, unloadRadius: DEFAULT_STREAM_RING.nearRadius };
  const intervals: number[] = [];
  const updates: number[] = [];
  const crossedUpdates: number[] = [];
  const otherUpdates: number[] = [];
  const longUpdates: LongUpdate[] = [];
  const holes: number[] = [];
  const nearCheckMs: number[] = [];
  const heap: number[] = [];
  const budgetMB: number[] = [];
  const rebases: Array<{ atM: number; shiftM: [number, number, number]; ms: number; boxes: number }> = [];
  let travelled = 0;
  let last = -1;
  let frame = 0;
  let prevChunk = Number.NaN;
  const startedAt = performance.now();
  const longTasksBefore = longTasks.length;
  await new Promise<void>((done) => {
    const step = (t: number): void => {
      if (last >= 0) {
        const dt = t - last;
        intervals.push(dt);
        travelled += (spec.speed * dt) / 1000;
      }
      last = t;
      const [x, z] = loopAt(travelled);
      const [hx, hz] = loopHeading(travelled);
      const r0 = performance.now();
      const ev = origin.update(x * VOXEL_SIZE_M, ALTITUDE_CELLS * VOXEL_SIZE_M, z * VOXEL_SIZE_M);
      if (ev !== null) rebases.push({ atM: Math.round(travelled), shiftM: [ev.shiftM.x, ev.shiftM.y, ev.shiftM.z], ms: Number((performance.now() - r0).toFixed(3)), boxes: boxes.mesh.count });
      streamer.setFocus(x, ALTITUDE_CELLS, z);
      const fk = chunkKey(grid, Math.floor(x) >> grid.shift, ALTITUDE_CELLS >> grid.shift, Math.floor(z) >> grid.shift);
      const crossed = fk !== prevChunk;
      prevChunk = fk;
      const h0 = heapMB();
      const u0 = performance.now();
      streamer.update();
      const u = performance.now() - u0;
      updates.push(u);
      (crossed ? crossedUpdates : otherUpdates).push(u);
      if (u > LONG_UPDATE_MS) {
        // A user-timing mark, so a trace shows what ran beside it (GC, adoption, planning).
        performance.measure('voxel-update', { start: u0, end: u0 + u });
        longUpdates.push({ atMs: Math.round(u0 - startedAt), ms: Number(u.toFixed(2)), crossed, resident: streamer.metrics().resident, queued: pool.queued, heapBeforeMB: Number(h0.toFixed(1)), heapAfterMB: Number(heapMB().toFixed(1)) });
      }
      const local = origin.toLocal(x * VOXEL_SIZE_M, ALTITUDE_CELLS * VOXEL_SIZE_M, z * VOXEL_SIZE_M, new Float32Array(3));
      // Behind and above the focus, looking ahead of it.
      camera.position.set(local[0]! - hx * 60, local[1]! + 70, local[2]! - hz * 60);
      camera.lookAt(local[0]! + hx * 80, local[1]! - 20, local[2]! + hz * 80);
      boxes.flush();
      renderer.render(scene, camera);
      frame++;
      if (frame % spec.nearEvery === 0) {
        const n0 = performance.now();
        let missing = 0;
        for (const c of ringChunks(grid, near, { x, y: ALTITUDE_CELLS, z })) if (!streamer.isResident(c.cx, c.cy, c.cz)) missing++;
        nearCheckMs.push(performance.now() - n0);
        holes.push(missing);
        heap.push(heapMB());
        budgetMB.push(streamer.metrics().bytes.total / 1e6);
      }
      if (performance.now() - startedAt < spec.seconds * 1000) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
  const secs = (performance.now() - startedAt) / 1000;
  const m = streamer.metrics();
  const c = streamer.counters;
  const flightTasks = longTasks.slice(longTasksBefore).filter((t) => t.start >= startedAt);
  const out = {
    renderer: rendererName,
    hardwareConcurrency: navigator.hardwareConcurrency,
    workers: spec.workers,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    seconds: Number(secs.toFixed(1)),
    travelledM: Math.round(travelled),
    intervals,
    updates,
    crossedUpdates,
    otherUpdates,
    longUpdates,
    longTasks: flightTasks.map((t) => ({ atMs: Math.round(t.start - startedAt), ms: Math.round(t.ms) })),
    longTaskApi: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask'),
    mainMs: { plan: series(streamer.planMs), adopt: series(streamer.adoptMs), apron: series(streamer.apronMs) },
    nearCheckMs,
    workerUs: { decompress: series(streamer.decompressUs), decode: series(streamer.decodeUs), job: series(pool.stats.workerUs) },
    poolMs: { queue: series(pool.stats.queueMs), run: series(pool.stats.runMs) },
    range: { requests: regions.requests - req0, bytes: regions.bytes - bytes0, ms: regions.ms.slice() },
    holes,
    nearChunks: ringChunks(grid, near, { x: 0, y: ALTITUDE_CELLS, z: 0 }).length,
    heapMB: heap,
    budgetMB,
    streamBytes: m.bytes,
    resident: { end: m.resident, stored: m.residentStored, boxesPeak: boxes.peak, boxOverflow: boxes.overflow },
    rebases,
    events: { ...s.events },
    churn: {
      loads: c.loads - c0.loads,
      storedLoads: c.loadsStored - c0.loadsStored,
      derives: c.derives - c0.derives,
      deriveChecks: c.deriveChecks - c0.deriveChecks,
      unloads: c.unloads - c0.unloads,
      reloads: c.reloads - c0.reloads,
      evictions: c.evictions - c0.evictions,
      cancelledLoads: c.cancelledLoads - c0.cancelledLoads,
      staleRefused: c.staleRefused - c0.staleRefused,
      retried: c.retried - c0.retried,
      damaged: c.damaged - c0.damaged,
    },
    pool: { timeouts: pool.stats.timeouts, queueFull: pool.stats.queueFull, replaced: pool.stats.replaced, lateReplies: pool.stats.lateReplies },
  };
  return out;
}

/** The page's memory as the browser measures it (cross-origin isolated pages only), or why not. */
async function measureMemory(timeoutMs: number): Promise<Record<string, unknown>> {
  const p = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: Array<{ bytes: number; types: string[]; attribution: Array<{ scope?: string }> }> }> };
  if (typeof p.measureUserAgentSpecificMemory !== 'function') return { available: false, reason: globalThis.crossOriginIsolated === true ? 'no API' : 'not cross-origin isolated' };
  const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), timeoutMs));
  let r: Awaited<ReturnType<NonNullable<typeof p.measureUserAgentSpecificMemory>>> | null;
  try {
    r = await Promise.race([p.measureUserAgentSpecificMemory(), timeout]);
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e), crossOriginIsolated: globalThis.crossOriginIsolated === true };
  }
  if (r === null) return { available: true, timedOut: true };
  const byScope: Record<string, number> = {};
  for (const b of r.breakdown) {
    const scope = b.attribution.map((a) => a.scope ?? '?').join('+') || (b.types.join('+') || 'shared');
    byScope[scope] = (byScope[scope] ?? 0) + b.bytes;
  }
  return { available: true, totalMB: Number((r.bytes / 1e6).toFixed(1)), byScopeMB: Object.fromEntries(Object.entries(byScope).map(([k, v]) => [k, Number((v / 1e6).toFixed(1))])) };
}

function close(): void {
  session?.pool.close();
  session = null;
}

(window as unknown as Record<string, unknown>)['__tlStream'] = { prepare, fly, measureMemory, close, ready: true };
