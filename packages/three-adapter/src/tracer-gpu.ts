/**
 * The tracer on the GPU: one compute pass answers a batch of rays against a
 * packed scene (`tracer-scene.ts`) on the renderer's own device. Callers
 * group their rays (`groupRays`) before they hand them over: on the Iris Xe
 * rays in random order cost 2 to 4 times rays grouped by geometry kind,
 * facing and place.
 *
 * Only the few WebGPU calls this uses are typed here (the TypeScript DOM
 * library has no WebGPU types).
 */
import { EXACT_TRACE, type TraceOptions } from './tracer-cpu-math';
import { HIT_WORDS, RAY_FLOATS, TRACE_RESUMES, type PackedTraceScene } from './tracer-scene';
import type { ScenePack } from './tracer-scene-packer';
import { TRACER_WGSL, TRACER_WORKGROUP } from './tracer-wgsl';

/** GPUTextureUsage bits (WebGPU's constants). */
const TEXTURE = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4 } as const;
/** GPUBufferUsage and GPUMapMode bits this module uses (WebGPU's constants). */
const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const MAP_READ = 0x1;

export interface GpuBuffer {
  readonly size: number;
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}
interface GpuPass {
  setPipeline(p: unknown): void;
  setBindGroup(i: number, g: unknown): void;
  dispatchWorkgroups(x: number): void;
  end(): void;
  [k: string]: unknown;
}
export interface GpuEncoder {
  beginComputePass(desc?: Record<string, unknown>): GpuPass;
  copyBufferToBuffer(src: GpuBuffer, srcOffset: number, dst: GpuBuffer, dstOffset: number, size: number): void;
  /** A texture region into a buffer (a bake reads the cache's pages back). */
  copyTextureToBuffer?(src: { texture: GpuTexture; origin?: Record<string, number> }, dst: { buffer: GpuBuffer; bytesPerRow: number; rowsPerImage: number }, size: Record<string, number>): void;
  finish(): unknown;
}
export interface GpuTexture {
  createView(desc?: Record<string, unknown>): unknown;
  destroy(): void;
}
/** The part of a `GPUDevice` the tracer calls. */
export interface TracerDevice {
  createBuffer(desc: { size: number; usage: number; label?: string }): GpuBuffer;
  createTexture(desc: Record<string, unknown>): GpuTexture;
  createSampler(desc: Record<string, unknown>): unknown;
  createShaderModule(desc: { code: string; label?: string }): { getCompilationInfo?(): Promise<{ messages: readonly { type: string; message: string; lineNum: number }[] }> };
  createComputePipeline(desc: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): GpuEncoder;
  /** The device's limits (absent: WebGPU's defaults). */
  readonly limits?: { readonly maxStorageBufferBindingSize?: number };
  readonly queue: {
    writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView): void;
    writeTexture(dst: { texture: GpuTexture; origin?: readonly number[] }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: readonly number[]): void;
    submit(list: unknown[]): void;
    onSubmittedWorkDone(): Promise<void>;
  };
}

/** Bytes of a dispatch's parameter block (`paramWords`). */
const PARAM_BYTES = 16;

/**
 * Sort order for a batch of rays: by the geometry kind they leave from, then
 * their direction's octant, then where they start (a Morton code of their
 * origin on a `cell`-metre grid). Neighbouring threads then walk the same
 * cells in the same direction.
 */
export function groupRays(rays: Float32Array, kinds: ArrayLike<number> | null, cell = 1): Uint32Array {
  const n = Math.floor(rays.length / RAY_FLOATS);
  const keys = new Float64Array(n);
  const spread = (v: number): number => {
    // 10 bits per axis, interleaved.
    let x = Math.min(1023, Math.max(0, Math.floor(v))) >>> 0;
    x = (x | (x << 16)) & 0x030000ff;
    x = (x | (x << 8)) & 0x0300f00f;
    x = (x | (x << 4)) & 0x030c30c3;
    x = (x | (x << 2)) & 0x09249249;
    return x >>> 0;
  };
  for (let i = 0; i < n; i += 1) {
    const r = i * RAY_FLOATS;
    const oct = (rays[r + 4]! < 0 ? 1 : 0) | (rays[r + 5]! < 0 ? 2 : 0) | (rays[r + 6]! < 0 ? 4 : 0);
    const m = spread(((rays[r]! / cell) % 1024 + 1024) % 1024) | (spread(((rays[r + 1]! / cell) % 1024 + 1024) % 1024) << 1) | (spread(((rays[r + 2]! / cell) % 1024 + 1024) % 1024) << 2);
    keys[i] = ((kinds?.[i] ?? 0) * 8 + oct) * 2 ** 30 + (m >>> 0);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  order.sort((a, b) => keys[a]! - keys[b]!);
  return order;
}

/** A batch of rays in `order` (what `groupRays` returns). */
export function reorderRays(rays: Float32Array, order: Uint32Array): Float32Array {
  const out = new Float32Array(order.length * RAY_FLOATS);
  for (let i = 0; i < order.length; i += 1) out.set(rays.subarray(order[i]! * RAY_FLOATS, order[i]! * RAY_FLOATS + RAY_FLOATS), i * RAY_FLOATS);
  return out;
}

/** A dispatch's parameter block: ray count, first ray, the options' cone (f32) and flags (1: any hit, 2: each ray's caster mask in the mask buffer, bits 8–15: the resumes). */
function paramWords(count: number, opts: TraceOptions, masked: boolean): Uint32Array {
  const resumes = Math.min(255, Math.max(0, opts.resumes ?? TRACE_RESUMES));
  const w = new Uint32Array([count, 0, 0, (opts.anyHit ? 1 : 0) | (masked ? 2 : 0) | (resumes << 8)]);
  new Float32Array(w.buffer)[2] = opts.cone;
  return w;
}

/** The tracer's pipeline and its scene on one device. */
export class GpuTracer {
  private readonly pipeline: { getBindGroupLayout(i: number): unknown };
  private readonly params: GpuBuffer;
  private scene: GpuBuffer | null = null;
  private atlas: GpuTexture | null = null;
  private atlasView: unknown = null;
  private readonly sampler: unknown;
  /** Stands in for the mask buffer when rays carry none. */
  private readonly noMasks: GpuBuffer;
  private outerMasks: GpuBuffer | null = null;
  private rays: GpuBuffer | null = null;
  private hits: GpuBuffer | null = null;
  private bind: unknown = null;
  /** The bind group over rays another pass made (`encodeBuffer`), and those rays. */
  private outerBind: unknown = null;
  private outerRays: GpuBuffer | null = null;

  private constructor(private readonly device: TracerDevice, pipeline: { getBindGroupLayout(i: number): unknown }) {
    this.pipeline = pipeline;
    this.params = device.createBuffer({ size: PARAM_BYTES, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'tracer params' });
    this.noMasks = device.createBuffer({ size: 16, usage: USAGE.STORAGE, label: 'tracer no masks' });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge', label: 'tracer bricks' });
  }

  /** Compile the tracer on `device` (a WGSL error rejects with the compiler's messages). */
  static async create(device: TracerDevice): Promise<GpuTracer> {
    const module = device.createShaderModule({ code: TRACER_WGSL, label: 'tracer' });
    const info = await module.getCompilationInfo?.();
    const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
    if (errors.length > 0) throw new Error(`tracer WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
    return new GpuTracer(device, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: 'tracer' }));
  }

  /** Upload a packed scene (replacing the last). */
  setScene(scene: PackedTraceScene): void {
    this.updateScene({ ...scene, dirty: [[0, scene.words.length]], resized: true, atlasChanged: true });
  }

  /**
   * Upload what changed of a packed scene: the whole buffer when its size
   * changed, else only the `dirty` word ranges; the models' atlas only when
   * it changed (bind groups are made again only for a new buffer or atlas).
   */
  updateScene(scene: Pick<ScenePack, 'words' | 'brickAtlas' | 'dirty' | 'resized' | 'atlasChanged'>): void {
    const q = this.device.queue;
    if (this.scene === null || scene.resized || this.scene.size !== Math.max(16, scene.words.byteLength)) {
      this.scene?.destroy();
      this.scene = this.device.createBuffer({ size: Math.max(16, scene.words.byteLength), usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'tracer scene' });
      q.writeBuffer(this.scene, 0, scene.words);
      this.bind = null;
      this.outerBind = null;
    } else {
      for (const [from, to] of scene.dirty) if (to > from) q.writeBuffer(this.scene, from * 4, scene.words.subarray(from, to));
    }
    if (this.atlas === null || scene.atlasChanged) {
      this.atlas?.destroy();
      const a = scene.brickAtlas;
      this.atlas = this.device.createTexture({ size: a.size, dimension: '3d', format: 'r8unorm', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST, label: 'tracer brick atlas' });
      q.writeTexture({ texture: this.atlas }, a.data, { bytesPerRow: a.size[0], rowsPerImage: a.size[1] }, a.size);
      this.atlasView = this.atlas.createView();
      this.bind = null;
      this.outerBind = null;
    }
  }

  /** Room for `count` rays and hits (grown, never shrunk). */
  private ensure(count: number): void {
    const rayBytes = count * RAY_FLOATS * 4;
    if (this.rays !== null && this.rays.size >= rayBytes) return;
    this.rays?.destroy();
    this.hits?.destroy();
    this.rays = this.device.createBuffer({ size: rayBytes, usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'tracer rays' });
    this.hits = this.device.createBuffer({ size: count * HIT_WORDS * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC, label: 'tracer hits' });
    this.bind = null;
    this.outerBind = null;
  }

  /**
   * Encode one pass over `rays` (`RAY_FLOATS` each) into `encoder`; the hits
   * stay on the GPU (`hitsBuffer`) for the passes that read them. `pass` may
   * carry timestamp writes.
   */
  encode(encoder: GpuEncoder, rays: Float32Array, pass: Record<string, unknown> = {}, opts: TraceOptions = EXACT_TRACE): void {
    if (this.scene === null) throw new Error('tracer: no scene');
    const count = Math.floor(rays.length / RAY_FLOATS);
    this.ensure(Math.max(1, count));
    this.device.queue.writeBuffer(this.rays!, 0, rays);
    this.device.queue.writeBuffer(this.params, 0, paramWords(count, opts, false));
    this.bind ??= this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.scene } },
        { binding: 2, resource: { buffer: this.rays } },
        { binding: 3, resource: { buffer: this.hits } },
        { binding: 4, resource: this.atlasView },
        { binding: 5, resource: this.sampler },
        { binding: 6, resource: { buffer: this.noMasks } },
      ],
    });
    const p = encoder.beginComputePass(pass);
    p.setPipeline(this.pipeline);
    p.setBindGroup(0, this.bind);
    p.dispatchWorkgroups(Math.ceil(count / TRACER_WORKGROUP));
    p.end();
  }

  /**
   * Encode one pass over `count` rays already on the GPU (`rays`: storage,
   * `RAY_FLOATS` each, made by another pass); the hits stay in `hitsBuffer`.
   */
  encodeBuffer(encoder: GpuEncoder, rays: GpuBuffer, count: number, pass: Record<string, unknown> = {}, opts: TraceOptions = EXACT_TRACE, masks: GpuBuffer | null = null): void {
    if (this.scene === null) throw new Error('tracer: no scene');
    if (this.hits === null || this.hits.size < count * HIT_WORDS * 4) {
      this.hits?.destroy();
      this.hits = this.device.createBuffer({ size: Math.max(1, count) * HIT_WORDS * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC, label: 'tracer hits' });
      this.outerBind = null;
      this.bind = null;
    }
    this.device.queue.writeBuffer(this.params, 0, paramWords(count, opts, masks !== null));
    if (this.outerBind === null || this.outerRays !== rays || this.outerMasks !== masks) {
      this.outerRays = rays;
      this.outerMasks = masks;
      this.outerBind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.scene } },
          { binding: 2, resource: { buffer: rays } },
          { binding: 3, resource: { buffer: this.hits } },
          { binding: 4, resource: this.atlasView },
          { binding: 5, resource: this.sampler },
          { binding: 6, resource: { buffer: masks ?? this.noMasks } },
        ],
      });
    }
    const p = encoder.beginComputePass(pass);
    p.setPipeline(this.pipeline);
    p.setBindGroup(0, this.outerBind);
    p.dispatchWorkgroups(Math.ceil(count / TRACER_WORKGROUP));
    p.end();
  }

  /** Whether a scene is uploaded (a pass before it has nothing to trace). */
  get ready(): boolean {
    return this.scene !== null;
  }

  /** The hits of the last pass. */
  get hitsBuffer(): GpuBuffer | null {
    return this.hits;
  }

  /** Trace `rays` and read the hits back (`HIT_WORDS` per ray, as `traceRaysCpu` writes them). */
  async trace(rays: Float32Array, opts: TraceOptions = EXACT_TRACE): Promise<Uint32Array> {
    const count = Math.floor(rays.length / RAY_FLOATS);
    const encoder = this.device.createCommandEncoder();
    this.encode(encoder, rays, {}, opts);
    const bytes = count * HIT_WORDS * 4;
    const read = this.device.createBuffer({ size: Math.max(16, bytes), usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'tracer readback' });
    encoder.copyBufferToBuffer(this.hits!, 0, read, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(MAP_READ);
    const out = new Uint32Array(read.getMappedRange().slice(0, bytes));
    read.unmap();
    read.destroy();
    return out;
  }

  dispose(): void {
    for (const b of [this.params, this.scene, this.rays, this.hits, this.noMasks]) b?.destroy();
    this.atlas?.destroy();
    this.atlas = null;
    this.atlasView = null;
    this.scene = this.rays = this.hits = null;
    this.bind = this.outerBind = null;
    this.outerRays = null;
  }
}
