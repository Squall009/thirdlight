/**
 * The surface cache's direct-light update on the GPU: the stale texels the
 * scheduler hands out each frame (`SurfaceRelight.plan`) are lit by the sun
 * and the point, spot and area lights reaching their unit, with soft
 * shadows from rays traced through the static scene (`tracer-gpu.ts`),
 * within the quality level's GPU time.
 *
 * Three compute passes, timestamped together: rays are made per texel and
 * light (sun rays over its disc, light rays over a small sphere round a
 * point or spot light or over an area light's shape), traced as shadow
 * rays, and gathered into each texel's irradiance (`surface-light-wgsl.ts`,
 * over the words `surface-light-frame.ts` packs). The measured time goes
 * back to the scheduler, which sizes the next frames' work by it.
 *
 * Only the few WebGPU calls this uses are typed (`tracer-gpu.ts`'s types).
 */
import { RAY_FLOATS, type PackedTraceScene } from './tracer-scene';
import type { TraceOptions } from './tracer-cpu-math';
import { GpuTracer, type GpuBuffer, type GpuEncoder, type TracerDevice } from './tracer-gpu';
import { SUN_DISC_RADIANS, packLightFrame, type LightPassFrame } from './surface-light-frame';
import { LIGHT_GATHER_WGSL, LIGHT_RAYS_WGSL, LIGHT_WORKGROUP } from './surface-light-wgsl';
import { TEXEL_POINT_FLOATS } from './surface-texels';

export { AREA_RAYS, LIGHT_RAYS, SUN_RAYS, lightFrameOf, packLightFrame, raysAtLevel, type LightPassFrame } from './surface-light-frame';

/**
 * Shadow rays are traced as such: any hit blocks, and a model's distance
 * field blocks a ray passing within this cone (radians) of it: half the
 * sun's disc, so a ray creeping along a surface stops early.
 */
export const SHADOW_TRACE: TraceOptions = { anyHit: true, cone: SUN_DISC_RADIANS / 2 };

const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80, QUERY_RESOLVE: 0x200 } as const;

interface QueryDevice extends TracerDevice {
  readonly features?: { has(f: string): boolean };
  createQuerySet?(desc: { type: 'timestamp'; count: number }): unknown;
}

/** The pass on one device: its pipelines, the tracer and the buffers it grows into. */
export class SurfaceLightPass {
  private readonly params: GpuBuffer;
  private frameBuf: GpuBuffer | null = null;
  private pointsBuf: GpuBuffer | null = null;
  private raysBuf: GpuBuffer | null = null;
  private masksBuf: GpuBuffer | null = null;
  private outBuf: GpuBuffer | null = null;
  private readonly query: unknown;
  private readonly resolveBuf: GpuBuffer | null;
  private seed = 1;
  private reading = false;

  private constructor(private readonly device: QueryDevice, readonly tracer: GpuTracer, private readonly gen: { getBindGroupLayout(i: number): unknown }, private readonly gather: { getBindGroupLayout(i: number): unknown }) {
    this.params = device.createBuffer({ size: 32, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'surface light params' });
    const timed = device.features?.has('timestamp-query') === true && device.createQuerySet !== undefined;
    this.query = timed ? device.createQuerySet!({ type: 'timestamp', count: 6 }) : null;
    this.resolveBuf = timed ? device.createBuffer({ size: 48, usage: USAGE.QUERY_RESOLVE | USAGE.COPY_SRC, label: 'surface light timestamps' }) : null;
  }

  static async create(device: TracerDevice): Promise<SurfaceLightPass> {
    const compile = async (code: string, label: string): Promise<{ getBindGroupLayout(i: number): unknown }> => {
      const module = device.createShaderModule({ code, label });
      const info = await module.getCompilationInfo?.();
      const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
      if (errors.length > 0) throw new Error(`${label} WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
      return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
    };
    return new SurfaceLightPass(device as QueryDevice, await GpuTracer.create(device), await compile(LIGHT_RAYS_WGSL, 'surface light rays'), await compile(LIGHT_GATHER_WGSL, 'surface light gather'));
  }

  /** The random seed the last run drew its rays with (the CPU twin, `lightFrameCpu`, takes it to give the same light). */
  get lastSeed(): number {
    return this.seed;
  }

  /** Whether the GPU times its work (timestamp queries); without, the scheduler keeps its starting count. */
  get timed(): boolean {
    return this.query !== null;
  }

  setScene(scene: PackedTraceScene): void {
    this.tracer.setScene(scene);
  }

  private grow(buf: GpuBuffer | null, bytes: number, usage: number, label: string): GpuBuffer {
    if (buf !== null && buf.size >= bytes) return buf;
    buf?.destroy();
    let size = 256;
    while (size < bytes) size *= 2;
    return this.device.createBuffer({ size, usage, label });
  }

  /** The irradiance of the last frame's texels (a vec4f each, in order), on the GPU. */
  get irradiance(): GpuBuffer | null {
    return this.outBuf;
  }

  /**
   * Light one frame's texels. `done(ms, texels, passes)` hears the GPU time
   * (the whole, and making rays, tracing and gathering) once the timestamps
   * are read (a frame later or so; never while the last is read).
   */
  run(frame: LightPassFrame, done?: (ms: number, texels: number, passes: readonly number[]) => void): void {
    const packed = packLightFrame(frame);
    if (packed.texels === 0) return;
    const d = this.device;
    this.frameBuf = this.grow(this.frameBuf, packed.words.byteLength, USAGE.STORAGE | USAGE.COPY_DST, 'surface light frame');
    this.pointsBuf = this.grow(this.pointsBuf, packed.texels * TEXEL_POINT_FLOATS * 4, USAGE.STORAGE | USAGE.COPY_DST, 'surface light points');
    this.raysBuf = this.grow(this.raysBuf, packed.rays * RAY_FLOATS * 4, USAGE.STORAGE, 'surface light rays');
    this.masksBuf = this.grow(this.masksBuf, packed.rays * 4, USAGE.STORAGE, 'surface light ray masks');
    this.outBuf = this.grow(this.outBuf, packed.texels * 16, USAGE.STORAGE | USAGE.COPY_SRC, 'surface light irradiance');
    d.queue.writeBuffer(this.frameBuf, 0, packed.words);
    d.queue.writeBuffer(this.pointsBuf, 0, frame.points.subarray(0, packed.texels * TEXEL_POINT_FLOATS));
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    d.queue.writeBuffer(this.params, 0, new Uint32Array([packed.texels, packed.rays, frame.slices.length, this.seed, frame.lights.length, packed.sunAt, packed.roomsAt, 0]));
    const enc = d.createCommandEncoder();
    const timed = this.query !== null && !this.reading;
    // Each pass's start and end: the three passes' times and the whole.
    const stamp = (i: number): Record<string, unknown> => (timed ? { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } } : {});
    const bind = (pipe: { getBindGroupLayout(i: number): unknown }, last: GpuBuffer, out: GpuBuffer): unknown =>
      d.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.frameBuf } },
          { binding: 2, resource: { buffer: this.pointsBuf } },
          { binding: 3, resource: { buffer: last } },
          { binding: 4, resource: { buffer: out } },
        ],
      });
    let p = enc.beginComputePass(stamp(0));
    p.setPipeline(this.gen);
    p.setBindGroup(0, bind(this.gen, this.raysBuf, this.masksBuf));
    p.dispatchWorkgroups(Math.ceil(packed.rays / LIGHT_WORKGROUP));
    p.end();
    this.tracer.encodeBuffer(enc, this.raysBuf, packed.rays, stamp(1), SHADOW_TRACE, this.masksBuf);
    p = enc.beginComputePass(stamp(2));
    p.setPipeline(this.gather);
    p.setBindGroup(0, bind(this.gather, this.tracer.hitsBuffer!, this.outBuf));
    p.dispatchWorkgroups(Math.ceil(packed.texels / LIGHT_WORKGROUP));
    p.end();
    let read: GpuBuffer | null = null;
    if (timed && this.resolveBuf !== null) {
      read = d.createBuffer({ size: 48, usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'surface light timestamps read' });
      (enc as GpuEncoder & { resolveQuerySet(q: unknown, first: number, count: number, dst: GpuBuffer, offset: number): void }).resolveQuerySet(this.query, 0, 6, this.resolveBuf, 0);
      enc.copyBufferToBuffer(this.resolveBuf, 0, read, 0, 48);
    }
    d.queue.submit([enc.finish()]);
    if (read !== null) {
      this.reading = true;
      const texels = packed.texels;
      const buf = read;
      buf.mapAsync(USAGE.MAP_READ).then(
        () => {
          const t = new BigUint64Array(buf.getMappedRange().slice(0));
          buf.unmap();
          buf.destroy();
          this.reading = false;
          const ns = Number(t[5]! - t[0]!);
          const passes = [0, 1, 2].map((i) => Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6);
          if (ns > 0) done?.(ns / 1e6, texels, passes);
        },
        () => {
          buf.destroy();
          this.reading = false;
        },
      );
    }
  }

  dispose(): void {
    for (const b of [this.params, this.frameBuf, this.pointsBuf, this.raysBuf, this.masksBuf, this.outBuf, this.resolveBuf]) b?.destroy();
    (this.query as { destroy?(): void } | null)?.destroy?.();
    this.tracer.dispose();
  }
}
