/**
 * Fine far bricks built on the GPU (`@thirdlight/voxel` far-fine.ts): a
 * fine node's cell block, sent by the far field, becomes its bricks in the
 * far brick atlas by compute passes on the renderer's own device
 * (voxel-fine-bricks-wgsl.ts), drawn by the far bricks' one march and shade
 * like every other far node. WebGPU only.
 *
 * - **A build.** The block (16 bits a cell), its look words and its sloped
 *   roofs' column table go up, five
 *   dispatches make the corner field, choose the stored bricks and stage
 *   their bytes; the brick list and the staged distances are read back.
 *   Once there, the stored bricks get atlas regions and one copy each puts
 *   their distances and look words in place from the staging buffer
 *   (never through the page), and the node's brick table is written. The
 *   block is not kept: an edit sends a new one.
 * - **Budget.** A few builds in flight at most ({@link FINE_BUILD_SLOTS},
 *   each with its own buffers), and per frame no more cells than
 *   {@link FINE_BUILD_CELLS_PER_FRAME} start (at least one block), so a
 *   fill spreads its builds over frames instead of one frame doing them all.
 * - **A check.** A build asked to check also reads back its looks and
 *   compares its bricks with the CPU build's of the same block
 *   ({@link FineBrickCheck}): the test of the GPU build against the CPU one.
 */
import * as THREE from 'three';
import { DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_BRICK_BAKED_BYTES, farBrickOcclusion, farBricksFromBlock, mipNodeKey, SHAPE_FULL, unpackFarFine, type ChunkGrid, type FarBricks, type FarFineCells, type MipNode } from '@thirdlight/voxel';

import { GPU_BUFFER_USAGE, GPU_MAP_READ, type GpuBuffer, type GpuEncoder, type GpuTexture } from './tracer-gpu';
import type { FarBrickAtlas } from './voxel-far-bricks';
import { FINE_BRICK_ROWS, FINE_BRICKS_WGSL, FINE_COLOUR_PER_ROW, FINE_COLOUR_WORDS, FINE_CORNERS, FINE_DIST_PER_ROW, FINE_DIST_WORDS, FINE_KIND, FINE_META_WORDS, FINE_NODE_BRICKS, FINE_PARAM_WORDS, FINE_ROW_BYTES, FINE_WORKGROUP, fineParams, fineScratchFloats } from './voxel-fine-bricks-wgsl';
import type { VoxelGridRenderer } from './voxel-surface';

/** The page flag that turns fine far bricks on (`?fineBricks=1`): what the page asks its streamer for. */
export const FINE_BRICKS_URL_PARAM = 'fineBricks';

/** Whether a page's query turns fine far bricks on. */
export function fineBricksFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(FINE_BRICKS_URL_PARAM);
  return v === '1' || v === 'on' || v === 'true';
}

/** Builds in flight at once (each holds a block's buffers, ~4 MiB for a level-1 node). */
export const FINE_BUILD_SLOTS = 4;

/** Cells of the blocks a frame starts building (a level-1 block is 78³ ≈ 475 k, a level-0 one 40³ = 64 k; at least one a frame). */
export const FINE_BUILD_CELLS_PER_FRAME = 1_000_000;

/** The largest block a slot holds: a level-1 node's (scale 2: 64 cells and an apron of 7 either side). */
const SLOT_MAX_N = 78;
/** The most look words a block names. */
const SLOT_MAX_WORDS = 4096;

/** A built node: its bricks (samples only: the looks stay on the GPU), their atlas regions and its page (null bricks: it draws nothing). */
export interface FineBrickResult {
  readonly bricks: FarBricks | null;
  readonly regions: THREE.Vector3[];
  readonly page: THREE.Vector3 | null;
  readonly check?: FineBrickCheck;
}

/**
 * The GPU build against the CPU build of the same block: whether they store the same bricks, and among the stored
 * samples how many distance bytes, look words and occlusion bytes differ (and by how much at most).
 */
export interface FineBrickCheck {
  readonly node: string;
  readonly sameBricks: boolean;
  readonly bricks: number;
  /** Columns of the block with a sloped roof drawn as its planes. */
  readonly roofs: number;
  readonly samples: number;
  readonly distanceDiffer: number;
  readonly distanceMax: number;
  readonly boundsDiffer: number;
  readonly lookDiffer: number;
  readonly occlusionDiffer: number;
  readonly occlusionMax: number;
}

/** The part of a `GPUDevice` the build calls. */
interface FineDevice {
  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBuffer;
  createShaderModule(desc: { code: string; label?: string }): unknown;
  createBindGroupLayout(desc: Record<string, unknown>): unknown;
  createPipelineLayout(desc: Record<string, unknown>): unknown;
  createComputePipeline(desc: Record<string, unknown>): unknown;
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): GpuEncoder & { copyBufferToTexture(src: Record<string, unknown>, dst: Record<string, unknown>, size: Record<string, number>): void };
  readonly queue: { writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView): void; submit(list: unknown[]): void };
}

interface FineJob {
  readonly node: MipNode;
  readonly fine: FarFineCells;
  readonly check: boolean;
  readonly at: number;
  readonly done: (r: FineBrickResult) => void;
}

interface Slot {
  readonly params: GpuBuffer;
  readonly cells: GpuBuffer;
  readonly words: GpuBuffer;
  readonly roofs: GpuBuffer;
  readonly scratch: GpuBuffer;
  readonly meta: GpuBuffer;
  readonly staged: GpuBuffer;
  readonly read: GpuBuffer;
  readonly bind: unknown;
  busy: boolean;
}

const META_BYTES = FINE_NODE_BRICKS * FINE_META_WORDS * 4;
const DIST_BYTES = FINE_DIST_WORDS * 4;
const COLOUR_BYTES = FINE_COLOUR_WORDS * 4;

/** Densities by fill level, the CPU build's (fill / 15 as a 32-bit float). */
const DENSITIES = Float32Array.from({ length: 16 }, (_, k) => k / SHAPE_FULL);

/** The device of a renderer whose backend is WebGPU (null: WebGL 2). */
export function fineDeviceOf(renderer: VoxelGridRenderer): unknown {
  const b = renderer.backend as { isWebGPUBackend?: boolean; device?: unknown };
  return b.isWebGPUBackend === true && b.device !== undefined ? b.device : null;
}

export class FineBrickBuilder {
  private readonly device: FineDevice;
  private readonly pipelines: Record<'ypass' | 'xpass' | 'zpass' | 'classify' | 'bake', unknown>;
  private readonly layout: unknown;
  private readonly slots: Slot[] = [];
  private readonly queue: FineJob[] = [];
  private raf: number | null = null;
  private disposed = false;
  /** Builds done, their stored bricks, the newest latencies (ms from the block's arrival to its bricks in the atlas), the most started a frame. */
  readonly stats = { built: 0, empty: 0, bricks: 0, cells: 0, frames: 0, maxPerFrame: 0, maxCellsPerFrame: 0, latencyMs: [] as number[], encodeMs: 0 };
  /** The latest checks (builds asked to check). */
  readonly checks: FineBrickCheck[] = [];

  constructor(
    device: unknown,
    private readonly renderer: VoxelGridRenderer,
    private readonly atlas: FarBrickAtlas,
    private readonly grid: ChunkGrid,
  ) {
    const d = (this.device = device as FineDevice);
    const module = d.createShaderModule({ code: FINE_BRICKS_WGSL, label: 'fine far bricks' });
    const COMPUTE = 4;
    const entry = (binding: number, type: string): Record<string, unknown> => ({ binding, visibility: COMPUTE, buffer: { type } });
    const group = d.createBindGroupLayout({ label: 'fine far bricks', entries: [entry(0, 'uniform'), entry(1, 'read-only-storage'), entry(2, 'read-only-storage'), entry(3, 'storage'), entry(4, 'storage'), entry(5, 'storage'), entry(6, 'read-only-storage')] });
    this.layout = group;
    const layout = d.createPipelineLayout({ bindGroupLayouts: [group] });
    const make = (entryPoint: string): unknown => d.createComputePipeline({ layout, compute: { module, entryPoint }, label: `fine far bricks ${entryPoint}` });
    this.pipelines = { ypass: make('ypass'), xpass: make('xpass'), zpass: make('zpass'), classify: make('classify'), bake: make('bake') };
  }

  /** GPU bytes the build's buffers hold. */
  get gpuBytes(): number {
    let n = 0;
    for (const s of this.slots) n += s.params.size + s.cells.size + s.words.size + s.roofs.size + s.scratch.size + s.meta.size + s.staged.size + s.read.size;
    return n;
  }

  /** Blocks waiting and building. */
  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.busy).length;
  }

  /** A block to build; `done` gets its bricks once they are in the atlas. */
  enqueue(node: MipNode, fine: FarFineCells, done: (r: FineBrickResult) => void, check = false): void {
    if (fine.n > SLOT_MAX_N || fine.words.length > SLOT_MAX_WORDS) throw new RangeError(`fine far bricks: a block of ${fine.n} cells, ${fine.words.length} words`);
    this.queue.push({ node, fine, check, at: performance.now(), done });
    this.loop();
  }

  private loop(): void {
    if (this.raf !== null || this.disposed) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.frame();
      return;
    }
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.frame();
      if (this.queue.length > 0) this.loop();
    });
  }

  /** Starts the waiting builds this frame's budget and the free slots allow. */
  private frame(): void {
    if (this.disposed || this.queue.length === 0) return;
    let started = 0;
    let cells = 0;
    while (this.queue.length > 0) {
      const job = this.queue[0]!;
      const size = job.fine.cells.length;
      if (started > 0 && cells + size > FINE_BUILD_CELLS_PER_FRAME) break;
      const slot = this.freeSlot();
      if (slot === null) break;
      this.queue.shift();
      this.start(slot, job);
      started++;
      cells += size;
    }
    if (started > 0) this.stats.frames++;
    this.stats.maxPerFrame = Math.max(this.stats.maxPerFrame, started);
    this.stats.maxCellsPerFrame = Math.max(this.stats.maxCellsPerFrame, cells);
  }

  private freeSlot(): Slot | null {
    const free = this.slots.find((s) => !s.busy);
    if (free !== undefined) return free;
    if (this.slots.length >= FINE_BUILD_SLOTS) return null;
    const d = this.device;
    const U = GPU_BUFFER_USAGE;
    const buf = (size: number, usage: number, label: string): GpuBuffer => d.createBuffer({ size: Math.ceil(size / 4) * 4, usage, label: `fine far bricks ${label}` });
    const params = buf(FINE_PARAM_WORDS * 4, U.UNIFORM | U.COPY_DST, 'params');
    const cells = buf(SLOT_MAX_N ** 3 * 2, U.STORAGE | U.COPY_DST, 'cells');
    const words = buf(SLOT_MAX_WORDS * 4, U.STORAGE | U.COPY_DST, 'words');
    const roofs = buf(SLOT_MAX_N ** 2 * 4, U.STORAGE | U.COPY_DST, 'roofs');
    const scratch = buf(fineScratchFloats(SLOT_MAX_N).total * 4, U.STORAGE, 'scratch');
    const meta = buf(META_BYTES, U.STORAGE | U.COPY_SRC, 'bricks');
    const staged = buf(DIST_BYTES + COLOUR_BYTES, U.STORAGE | U.COPY_SRC, 'staged');
    const read = buf(META_BYTES + DIST_BYTES + COLOUR_BYTES, U.MAP_READ | U.COPY_DST, 'read');
    const bind = d.createBindGroup({ layout: this.layout, entries: [params, cells, words, scratch, meta, staged, roofs].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const s: Slot = { params, cells, words, roofs, scratch, meta, staged, read, bind, busy: false };
    this.slots.push(s);
    return s;
  }

  private start(slot: Slot, job: FineJob): void {
    const t0 = performance.now();
    slot.busy = true;
    const d = this.device;
    const f = job.fine;
    const n = f.n;
    const apron = (n - this.grid.edge * f.scale) / 2;
    d.queue.writeBuffer(slot.params, 0, fineParams(n, f.scale, apron, DENSITIES, f.roofs !== null));
    if (f.roofs !== null) d.queue.writeBuffer(slot.roofs, 0, f.roofs);
    // Whole words: a block of an odd cell count is padded by a cell.
    const cells = f.cells.length % 2 === 0 ? f.cells : Uint16Array.from({ length: f.cells.length + 1 }, (_, i) => f.cells[i] ?? 0);
    d.queue.writeBuffer(slot.cells, 0, cells);
    d.queue.writeBuffer(slot.words, 0, Uint32Array.from(f.words));
    const m = n + 1;
    const C = FINE_CORNERS;
    const groups = (threads: number): number => Math.ceil(threads / FINE_WORKGROUP);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass({ label: 'fine far bricks' });
    const run = (p: unknown, count: number): void => {
      pass.setPipeline(p);
      pass.setBindGroup(0, slot.bind);
      pass.dispatchWorkgroups(count);
    };
    run(this.pipelines.ypass, groups(m * m * C));
    run(this.pipelines.xpass, groups(2 * C * m * C));
    run(this.pipelines.zpass, groups(C * C * C));
    run(this.pipelines.classify, FINE_NODE_BRICKS);
    run(this.pipelines.bake, FINE_NODE_BRICKS);
    pass.end();
    enc.copyBufferToBuffer(slot.meta, 0, slot.read, 0, META_BYTES);
    enc.copyBufferToBuffer(slot.staged, 0, slot.read, META_BYTES, job.check ? DIST_BYTES + COLOUR_BYTES : DIST_BYTES);
    d.queue.submit([enc.finish()]);
    this.stats.encodeMs += performance.now() - t0;
    this.stats.cells += f.cells.length;
    slot.read.mapAsync(GPU_MAP_READ).then(
      () => this.place(slot, job),
      (e: unknown) => {
        slot.busy = false;
        if (!this.disposed) console.warn('fine far bricks: a build could not be read back', e);
        job.done({ bricks: null, regions: [], page: null });
      },
    );
  }

  /** A build read back: its stored bricks into atlas regions (one copy each from the staging buffer), its page written. */
  private place(slot: Slot, job: FineJob): void {
    if (this.disposed) return;
    const raw = slot.read.getMappedRange();
    const meta = new Uint32Array(raw, 0, FINE_NODE_BRICKS * FINE_META_WORDS);
    const dist = new Uint8Array(raw, META_BYTES, DIST_BYTES);
    const looks = job.check ? new Uint8Array(raw, META_BYTES + DIST_BYTES, COLOUR_BYTES).slice() : null;
    const stored: number[] = [];
    const table = new Int32Array(FINE_NODE_BRICKS);
    for (let b = 0; b < FINE_NODE_BRICKS; b++) {
      const kind = meta[b * FINE_META_WORDS]!;
      table[b] = kind === FINE_KIND.outside ? DISTANCE_BRICK_OUTSIDE : kind === FINE_KIND.inside ? DISTANCE_BRICK_INSIDE : stored.length;
      if (kind === FINE_KIND.stored) stored.push(b);
    }
    const S = DISTANCE_BRICK_SIDE;
    const samples = new Uint8Array(stored.length * DISTANCE_BRICK_SAMPLES);
    const blocks = new Uint8Array(stored.length * 4);
    const bounds = new Uint8Array(stored.length * 6);
    stored.forEach((b, k) => {
      const base = Math.floor(b / FINE_DIST_PER_ROW) * FINE_BRICK_ROWS * FINE_ROW_BYTES + (b % FINE_DIST_PER_ROW) * 12;
      for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) samples.set(dist.subarray(base + (z * S + y) * FINE_ROW_BYTES, base + (z * S + y) * FINE_ROW_BYTES + S), k * DISTANCE_BRICK_SAMPLES + (z * S + y) * S);
      const p = meta[b * FINE_META_WORDS + 1]!;
      bounds.set([p & 15, (p >> 4) & 15, (p >> 8) & 15, (p >> 12) & 15, (p >> 16) & 15, (p >> 20) & 15], k * 6);
      blocks.set([b % 4, (b >> 2) % 4, b >> 4, meta[b * FINE_META_WORDS + 2]!], k * 4);
    });
    slot.read.unmap();
    const bricks: FarBricks = { side: 4, bricks: table, samples, looks: new Uint16Array(0), blocks, bounds };
    const check = looks !== null ? this.check(job, bricks, looks) : undefined;
    if (stored.length === 0) {
      slot.busy = false;
      this.stats.built++;
      this.stats.empty++;
      this.finish(job, { bricks: null, regions: [], page: null, ...(check !== undefined ? { check } : {}) });
      return;
    }
    const r = this.renderer;
    const regions: THREE.Vector3[] = [];
    for (let k = 0; k < stored.length; k++) {
      const at = this.atlas.distance.allocate(r);
      const twin = this.atlas.colours.allocate(r);
      if (!at.equals(twin)) throw new Error('far brick atlas: the two region stores parted');
      regions.push(at);
    }
    // After every allocation: a growth replaces the textures, and the copies go into the textures as they are now.
    r.initTexture(this.atlas.distance.texture);
    r.initTexture(this.atlas.colours.texture);
    const backend = r.backend as unknown as { get(t: THREE.Texture): { texture?: GpuTexture } };
    const distTex = backend.get(this.atlas.distance.texture).texture;
    const colourTex = backend.get(this.atlas.colours.texture).texture;
    if (distTex === undefined || colourTex === undefined) throw new Error('fine far bricks: the atlas is not on the GPU');
    const enc = this.device.createCommandEncoder();
    const size = { width: S, height: S, depthOrArrayLayers: S };
    stored.forEach((b, k) => {
      const at = regions[k]!;
      const origin = { x: at.x, y: at.y, z: at.z };
      const dOff = Math.floor(b / FINE_DIST_PER_ROW) * FINE_BRICK_ROWS * FINE_ROW_BYTES + (b % FINE_DIST_PER_ROW) * 12;
      const cOff = DIST_BYTES + Math.floor(b / FINE_COLOUR_PER_ROW) * FINE_BRICK_ROWS * FINE_ROW_BYTES + (b % FINE_COLOUR_PER_ROW) * S * FAR_BRICK_BAKED_BYTES;
      enc.copyBufferToTexture({ buffer: slot.staged, offset: dOff, bytesPerRow: FINE_ROW_BYTES, rowsPerImage: S }, { texture: distTex, origin }, size);
      enc.copyBufferToTexture({ buffer: slot.staged, offset: cOff, bytesPerRow: FINE_ROW_BYTES, rowsPerImage: S }, { texture: colourTex, origin }, size);
    });
    this.device.queue.submit([enc.finish()]);
    // Later writes to this slot's buffers queue after these copies.
    slot.busy = false;
    const page = this.atlas.addPage(r, bricks, regions);
    this.stats.built++;
    this.stats.bricks += stored.length;
    this.finish(job, { bricks, regions, page, ...(check !== undefined ? { check } : {}) });
  }

  private finish(job: FineJob, r: FineBrickResult): void {
    const ms = performance.now() - job.at;
    this.stats.latencyMs.push(ms);
    if (this.stats.latencyMs.length > 256) this.stats.latencyMs.splice(0, this.stats.latencyMs.length - 256);
    job.done(r);
    if (this.queue.length > 0) this.loop();
  }

  /** The GPU build against the CPU build of the same block. */
  private check(job: FineJob, gpu: FarBricks, looks: Uint8Array): FineBrickCheck {
    const block = unpackFarFine(job.fine);
    const cpu = farBricksFromBlock(this.grid, block);
    const occlusion = farBrickOcclusion(cpu);
    const S = DISTANCE_BRICK_SIDE;
    let sameBricks = cpu.bricks.length === gpu.bricks.length;
    for (let i = 0; i < cpu.bricks.length && sameBricks; i++) sameBricks = cpu.bricks[i] === gpu.bricks[i];
    let samples = 0, distanceDiffer = 0, distanceMax = 0, boundsDiffer = 0, lookDiffer = 0, occlusionDiffer = 0, occlusionMax = 0;
    for (let b = 0; b < cpu.bricks.length; b++) {
      const kc = cpu.bricks[b]!;
      const kg = gpu.bricks[b]!;
      if (kc < 0 || kg < 0) continue;
      for (let a = 0; a < 6; a++) if (cpu.bounds[kc * 6 + a] !== gpu.bounds[kg * 6 + a]) boundsDiffer++;
      const cBase = Math.floor(b / FINE_COLOUR_PER_ROW) * FINE_BRICK_ROWS * FINE_ROW_BYTES + (b % FINE_COLOUR_PER_ROW) * S * FAR_BRICK_BAKED_BYTES;
      for (let i = 0; i < DISTANCE_BRICK_SAMPLES; i++) {
        samples++;
        const dd = Math.abs(cpu.samples[kc * DISTANCE_BRICK_SAMPLES + i]! - gpu.samples[kg * DISTANCE_BRICK_SAMPLES + i]!);
        if (dd > 0) distanceDiffer++;
        distanceMax = Math.max(distanceMax, dd);
        const x = i % S, y = Math.floor(i / S) % S, z = Math.floor(i / (S * S));
        const t = cBase + (z * S + y) * FINE_ROW_BYTES + x * FAR_BRICK_BAKED_BYTES;
        const s = kc * DISTANCE_BRICK_SAMPLES + i;
        if (cpu.looks[s] !== looks[t]! + 256 * looks[t + 1]!) lookDiffer++;
        const od = Math.abs(Math.round(occlusion[s]!) - looks[t + 3]!);
        if (od > 0) occlusionDiffer++;
        occlusionMax = Math.max(occlusionMax, od);
      }
    }
    const roofs = job.fine.roofs === null ? 0 : job.fine.roofs.reduce((n, c) => n + (c !== 0 ? 1 : 0), 0);
    const out: FineBrickCheck = { node: mipNodeKey(job.node), sameBricks, bricks: gpu.samples.length / DISTANCE_BRICK_SAMPLES, roofs, samples, distanceDiffer, distanceMax, boundsDiffer, lookDiffer, occlusionDiffer, occlusionMax };
    this.checks.push(out);
    if (this.checks.length > 64) this.checks.shift();
    return out;
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = null;
    this.queue.length = 0;
    for (const s of this.slots) for (const b of [s.params, s.cells, s.words, s.roofs, s.scratch, s.meta, s.staged, s.read]) b.destroy();
    this.slots.length = 0;
  }
}
