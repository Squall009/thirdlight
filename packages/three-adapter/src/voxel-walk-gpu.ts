/**
 * The occupancy walk's blocks on the GPU (WebGPU only): the page's mirror
 * of a world's walk table (`@thirdlight/voxel` walk-pages.ts), fed by the
 * blocks the draw batches carry, kept as two storage buffers the WGSL walk
 * reads (voxel-walk-wgsl.ts). The table's entries and pages are written as
 * they change (`queue.writeBuffer` of the changed entries and pages); a
 * table that grew is written whole into larger buffers.
 *
 * Storage buffers, not a texture: the walk reads exact u32 words (keys,
 * bits), which no filtered texture format needs, and its callers are
 * compute passes on the renderer's device. Memory is the table and every
 * page slot (8,320 bytes a mixed block: a share of the chunks drawn),
 * counted in the world's resident bytes.
 *
 * `trace` walks a batch of rays in one dispatch and reads the hits back
 * (the page's check against the CPU walk over the same table); `bench`
 * walks a fixed batch every frame as a pass of the page's GPU measurement
 * (`lighting`), to give rays a millisecond on this GPU.
 */
import { applyWalkWires, WALK_ENTRY_WORDS, WALK_PAGE_WORDS, WalkTable, walkVoxels, type WalkBatchRay, type WalkBlockWire } from '@thirdlight/voxel';

import { gpuPassHides } from './gpu-pass-hides';
import { GPU_BUFFER_USAGE, GPU_MAP_READ, grownGpuBuffer, type GpuBuffer, type GpuEncoder, type VoxelWalkBuffers } from './tracer-gpu';
import { voxelWalkWgsl, WALK_GPU_MAX_STEPS } from './voxel-walk-wgsl';

/** The part of a `GPUDevice` the walk calls. */
interface WalkDevice {
  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBuffer;
  createShaderModule(desc: { code: string; label?: string }): unknown;
  createComputePipeline(desc: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): GpuEncoder;
  readonly queue: { writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView, dataOffset?: number, size?: number): void; submit(list: unknown[]): void; onSubmittedWorkDone(): Promise<void> };
}

/** Threads a workgroup of the trace pass. */
const WALK_WORKGROUP = 64;
/** u32 words a ray takes in the trace pass's input (cell, frac + max t, inv + stop) and a hit in its output. */
const RAY_WORDS = 12;
const HIT_WORDS = 8;

const TRACE_WGSL = /* wgsl */ `
struct Params { count: u32, max_level: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> rays: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> hits: array<vec4<u32>>;
${voxelWalkWgsl({ group: 0, table: 3, pages: 4 })}
@compute @workgroup_size(${WALK_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let a = rays[3u * i];
  let b = bitcast<vec4<f32>>(rays[3u * i + 1u]);
  let c = rays[3u * i + 2u];
  let h = voxel_walk(bitcast<vec3<i32>>(a.xyz), b.xyz, bitcast<vec3<f32>>(c.xyz), b.w, c.w, params.max_level);
  hits[2u * i] = vec4<u32>(h.end, bitcast<u32>(h.t), h.level, bitcast<u32>(h.axis));
  hits[2u * i + 1u] = vec4<u32>(bitcast<vec3<u32>>(h.cell), h.steps);
}
`;

/** A ray of a GPU batch: the walk's ray, how far, and what stops it. */
export type WalkGpuRay = WalkBatchRay;

/** The bench's rays (`@thirdlight/voxel` walk-bench.ts), for the page's hooks. */
export { walkBenchRays, type WalkBenchKind } from '@thirdlight/voxel';

/** A GPU hit read back: how the walk ended (0 distance, 1 hit, 2 world, 3 steps) and where. */
export interface WalkGpuHit {
  readonly end: number;
  readonly t: number;
  readonly cell: readonly [number, number, number];
  readonly axis: number;
  readonly level: number;
  readonly steps: number;
}

/** The GPU's hits against the CPU walk's over the same table, ray by ray. */
export interface WalkGpuCheck {
  readonly rays: number;
  readonly hits: number;
  readonly misses: number;
  /** Rays whose end, cell, axis, level or distance differ (each the first few listed). */
  readonly mismatches: number;
  readonly examples: ReadonlyArray<{ readonly i: number; readonly gpu: WalkGpuHit; readonly cpu: WalkGpuHit }>;
  readonly blocks: number;
  readonly pages: number;
  readonly ms: number;
}

/** What a bench pass walks every frame. */
export interface WalkBenchSpec {
  readonly rays: readonly WalkGpuRay[];
}

/** Packs rays into the trace pass's input words. */
function packRays(rays: readonly WalkGpuRay[]): Uint32Array {
  const out = new Uint32Array(Math.max(1, rays.length) * RAY_WORDS);
  const f = new Float32Array(out.buffer);
  const i = new Int32Array(out.buffer);
  rays.forEach((r, k) => {
    const at = k * RAY_WORDS;
    for (let a = 0; a < 3; a++) {
      i[at + a] = r.ray.cell[a]!;
      f[at + 4 + a] = r.ray.frac[a]!;
      f[at + 8 + a] = r.ray.inv[a]!;
    }
    f[at + 7] = r.maxT;
    out[at + 11] = r.stop === 'solid' ? 0 : 1;
  });
  return out;
}

/** The CPU walk's answer in the GPU's terms (end codes as the GPU numbers them). */
function cpuHit(table: WalkTable, r: WalkGpuRay): WalkGpuHit {
  const w = walkVoxels(table.source(), r.ray, r.maxT, { stop: r.stop, far: false, maxSteps: WALK_GPU_MAX_STEPS });
  const end = w.end === 'distance' ? 0 : w.end === 'hit' ? 1 : w.end === 'world' ? 2 : 3;
  if (w.hit === null) return { end, t: 0, cell: [0, 0, 0], axis: 0, level: 0, steps: w.steps };
  const axis = w.hit.normal.findIndex((n) => n !== 0);
  return { end, t: w.hit.t, cell: w.hit.cell, axis, level: w.hit.level, steps: w.steps };
}

export class VoxelWalkGpu {
  readonly table = new WalkTable();
  private tableBuf: GpuBuffer | null = null;
  private pagesBuf: GpuBuffer | null = null;
  private readonly pipeline: { getBindGroupLayout(i: number): unknown };
  private readonly params: GpuBuffer;
  private bench: { readonly rays: GpuBuffer; readonly hits: GpuBuffer; readonly count: number; bind: unknown; bindFor: GpuBuffer | null } | null = null;
  private benchHidden = false;
  private raf: number | null = null;
  private readonly unregister: () => void;
  /** Uploads made, their bytes, and bench frames walked. */
  readonly counters = { uploads: 0, uploadBytes: 0, wholeUploads: 0, benchFrames: 0 };

  constructor(private readonly device: WalkDevice) {
    const module = device.createShaderModule({ code: TRACE_WGSL, label: 'occupancy walk' }) as { getCompilationInfo?(): Promise<{ messages: ReadonlyArray<{ type: string; lineNum: number; message: string }> }> };
    // A program that does not compile only fails its dispatches later (a read back never answers): said at once instead.
    void module.getCompilationInfo?.().then((info) => {
      for (const m of info.messages) if (m.type === 'error') console.error(`occupancy walk WGSL, line ${m.lineNum}: ${m.message}`);
    });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: 'occupancy walk' });
    this.params = device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST, label: 'occupancy walk params' });
    this.unregister = gpuPassHides.register({ category: 'lighting', name: 'occupancy walk bench', present: () => this.bench !== null, hide: (h) => (this.benchHidden = h) });
  }

  /** The table and pages as a pass binds them (null: nothing uploaded yet): another pass walks the same buffers (the surface cache's tracer). */
  buffers(): VoxelWalkBuffers | null {
    if (this.tableBuf === null || this.pagesBuf === null) return null;
    return { table: this.tableBuf, pages: this.pagesBuf, maxLevel: this.table.maxLevel };
  }

  /** Bytes on the GPU (the two buffers). */
  get gpuBytes(): number {
    return (this.tableBuf?.size ?? 0) + (this.pagesBuf?.size ?? 0);
  }

  /** A batch's blocks into the table, written to the GPU at once. */
  apply(wires: readonly WalkBlockWire[]): void {
    applyWalkWires(this.table, wires);
    this.upload();
  }

  private upload(): void {
    const t = this.table;
    const d = t.takeDirty();
    const STORAGE = GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST;
    let whole = d.whole;
    // The walk reads the table's capacity from its buffer's length: the buffer is the table's size exactly.
    if (this.tableBuf === null || this.tableBuf.size !== t.entries.byteLength) {
      this.tableBuf?.destroy();
      this.tableBuf = this.device.createBuffer({ size: t.entries.byteLength, usage: STORAGE, label: 'occupancy walk table' });
      whole = true;
    }
    const pb = grownGpuBuffer(this.device, this.pagesBuf, Math.max(t.pages.byteLength, 256), STORAGE, 'occupancy walk pages');
    if (pb !== this.pagesBuf) {
      this.pagesBuf = pb;
      whole = true;
    }
    const q = this.device.queue;
    if (whole) {
      q.writeBuffer(this.tableBuf, 0, t.entries);
      q.writeBuffer(this.pagesBuf, 0, t.pages);
      this.counters.wholeUploads++;
      this.counters.uploadBytes += t.entries.byteLength + t.pages.byteLength;
      if (this.bench !== null) this.bench.bindFor = null;
      return;
    }
    // Runs of neighbouring entries go as one write.
    const E = WALK_ENTRY_WORDS;
    for (let k = 0; k < d.entries.length; ) {
      let j = k;
      while (j + 1 < d.entries.length && d.entries[j + 1] === d.entries[j]! + 1) j++;
      q.writeBuffer(this.tableBuf, d.entries[k]! * E * 4, t.entries, d.entries[k]! * E, (j - k + 1) * E);
      this.counters.uploadBytes += (j - k + 1) * E * 4;
      k = j + 1;
    }
    for (const p of d.pages) {
      q.writeBuffer(this.pagesBuf, p * WALK_PAGE_WORDS * 4, t.pages, p * WALK_PAGE_WORDS, WALK_PAGE_WORDS);
      this.counters.uploadBytes += WALK_PAGE_WORDS * 4;
    }
    this.counters.uploads++;
  }

  private bindGroup(rays: GpuBuffer, hits: GpuBuffer): unknown {
    if (this.tableBuf === null) this.upload();
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: rays } },
        { binding: 2, resource: { buffer: hits } },
        { binding: 3, resource: { buffer: this.tableBuf } },
        { binding: 4, resource: { buffer: this.pagesBuf } },
      ],
    });
  }

  private dispatch(enc: GpuEncoder, bind: unknown, count: number): void {
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([count, this.table.maxLevel, 0, 0]));
    const pass = enc.beginComputePass({ label: 'occupancy walk' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(count / WALK_WORKGROUP));
    pass.end();
  }

  /** Walks a batch of rays on the GPU and reads the hits back. */
  async trace(rays: readonly WalkGpuRay[]): Promise<WalkGpuHit[]> {
    const STORAGE = GPU_BUFFER_USAGE.STORAGE;
    const input = packRays(rays);
    const rb = this.device.createBuffer({ size: input.byteLength, usage: STORAGE | GPU_BUFFER_USAGE.COPY_DST, label: 'occupancy walk rays' });
    const bytes = Math.max(1, rays.length) * HIT_WORDS * 4;
    const hb = this.device.createBuffer({ size: bytes, usage: STORAGE | GPU_BUFFER_USAGE.COPY_SRC, label: 'occupancy walk hits' });
    const read = this.device.createBuffer({ size: bytes, usage: GPU_MAP_READ | GPU_BUFFER_USAGE.COPY_DST, label: 'occupancy walk read' });
    try {
      this.device.queue.writeBuffer(rb, 0, input);
      const enc = this.device.createCommandEncoder();
      this.dispatch(enc, this.bindGroup(rb, hb), rays.length);
      enc.copyBufferToBuffer(hb, 0, read, 0, bytes);
      this.device.queue.submit([enc.finish()]);
      await read.mapAsync(GPU_MAP_READ);
      const u = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      const f = new Float32Array(u.buffer);
      const i = new Int32Array(u.buffer);
      return rays.map((_, k) => {
        const at = k * HIT_WORDS;
        return { end: u[at]!, t: f[at + 1]!, level: u[at + 2]!, axis: i[at + 3]!, cell: [i[at + 4]!, i[at + 5]!, i[at + 6]!], steps: u[at + 7]! };
      });
    } finally {
      rb.destroy();
      hb.destroy();
      read.destroy();
    }
  }

  /** The GPU's walk against the CPU walk over the same table on the same rays. */
  async check(rays: readonly WalkGpuRay[]): Promise<WalkGpuCheck> {
    const t0 = performance.now();
    const gpu = await this.trace(rays);
    let hits = 0;
    let misses = 0;
    let mismatches = 0;
    const examples: Array<{ i: number; gpu: WalkGpuHit; cpu: WalkGpuHit }> = [];
    rays.forEach((r, i) => {
      const g = gpu[i]!;
      const c = cpuHit(this.table, r);
      if (c.end === 1) hits++;
      else misses++;
      const same = g.end === c.end && (c.end !== 1 || (g.t === c.t && g.level === c.level && g.axis === c.axis && g.cell.every((v, a) => v === c.cell[a])));
      if (same) return;
      mismatches++;
      if (examples.length < 8) examples.push({ i, gpu: g, cpu: c });
    });
    return { rays: rays.length, hits, misses, mismatches, examples, blocks: this.table.size, pages: this.table.pagesUsed, ms: performance.now() - t0 };
  }

  /** Walks `spec.rays` every frame from now on as a pass of the page's GPU measurement (null: stop). */
  setBench(spec: WalkBenchSpec | null): void {
    if (this.bench !== null) {
      this.bench.rays.destroy();
      this.bench.hits.destroy();
      this.bench = null;
    }
    if (spec === null) return;
    const input = packRays(spec.rays);
    const rays = this.device.createBuffer({ size: input.byteLength, usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST, label: 'occupancy walk bench rays' });
    this.device.queue.writeBuffer(rays, 0, input);
    const hits = this.device.createBuffer({ size: Math.max(1, spec.rays.length) * HIT_WORDS * 4, usage: GPU_BUFFER_USAGE.STORAGE, label: 'occupancy walk bench hits' });
    this.bench = { rays, hits, count: spec.rays.length, bind: null, bindFor: null };
    this.loop();
  }

  private loop(): void {
    if (this.raf !== null || this.bench === null || typeof requestAnimationFrame !== 'function') return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.benchFrame();
      this.loop();
    });
  }

  private benchFrame(): void {
    const b = this.bench;
    if (b === null || this.benchHidden || b.count === 0) return;
    if (b.bindFor !== this.tableBuf || b.bind === null) {
      b.bind = this.bindGroup(b.rays, b.hits);
      b.bindFor = this.tableBuf;
    }
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, b.bind, b.count);
    this.device.queue.submit([enc.finish()]);
    this.counters.benchFrames++;
  }

  dispose(): void {
    this.setBench(null);
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.unregister();
    this.tableBuf?.destroy();
    this.pagesBuf?.destroy();
    this.params.destroy();
    this.tableBuf = this.pagesBuf = null;
  }
}

