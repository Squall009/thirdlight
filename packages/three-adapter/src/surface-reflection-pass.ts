/**
 * Reflection rays that left the screen, traced through the static world on
 * the GPU (the tracer, `tracer-gpu.ts`) and lit where they hit from the
 * surface cache: the hit's texel (its direct light from every light the
 * cache holds, soft shadows included) plus the probes' light there (its
 * bounce), times the surface's colour as the materials drew it, over π —
 * what the probes' own rays read (`PROBE_HIT_LIGHT_WGSL`).
 *
 * The rays come from the screen-space pass (`post-reflections.ts`), one per
 * traced pixel, in a storage buffer it wrote; each ray's light goes into
 * another (rgb, then 1 for a hit, 0 where the ray met nothing or a surface's
 * back, -1 for a ray not cast: its tmax is 0). A miss is left to the
 * reflecting pixel's own environment light, which knows the sky better
 * than the probes' second-order sky does.
 *
 * Only the WebGPU calls this uses are typed (`tracer-gpu.ts`'s types).
 */
import { EXACT_TRACE } from './tracer-cpu-math';
import type { GpuBuffer, GpuTracer, GpuTexture, TracerDevice } from './tracer-gpu';
import type { GpuResolve } from './surface-resolve-gpu';
import { BOUNCE_ALBEDO, PROBE_HIT_LIFT, type LiveProbes } from './surface-probes';
import { packProbeWords } from './surface-probe-pass';
import { PROBE_COMMON_WGSL, PROBE_HIT_LIGHT_WGSL } from './surface-probe-wgsl';
import { TRACE_MISS, TRACE_UNFINISHED } from './tracer-scene';

const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80, QUERY_RESOLVE: 0x200 } as const;
const WORKGROUP = 64;
/** The weight a new frame's cost per ray gets in the average. */
const RAY_COST_WEIGHT = 0.25;

/** The gather: each traced ray's light at its hit (`O`: rgb, hit 1 / none 0 / not cast -1). */
export const REFLECTION_GATHER_WGSL =
  PROBE_COMMON_WGSL +
  /* wgsl */ `
@group(0) @binding(2) var<storage, read> PR: array<vec4f>;
@group(0) @binding(3) var<storage, read> R: array<vec4f>;
@group(0) @binding(5) var<storage, read> H: array<vec4u>;
@group(0) @binding(6) var<storage, read> T: array<u32>;
@group(0) @binding(7) var<storage, read_write> O: array<vec4f>;
@group(0) @binding(8) var atlas: texture_2d_array<f32>;
@group(0) @binding(9) var rings: texture_2d_array<f32>;
@group(0) @binding(10) var<storage, read> ALB: array<u32>;
${PROBE_HIT_LIGHT_WGSL}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.rays) { return; }
  let r1 = R[g.x * 2u + 1u];
  if (r1.w <= 0.0) { O[g.x] = vec4f(0.0, 0.0, 0.0, -1.0); return; }
  let h0 = H[g.x * 2u];
  let kind = H[g.x * 2u + 1u].x & 255u;
  if (kind == ${TRACE_MISS}u || kind == ${TRACE_UNFINISHED}u) { O[g.x] = vec4f(0.0); return; }
  let n = bitcast<vec3f>(h0.yzw);
  if (dot(n, r1.xyz) > 0.0) { O[g.x] = vec4f(0.0); return; }
  let p = R[g.x * 2u].xyz + r1.xyz * bitcast<f32>(h0.x);
  O[g.x] = vec4f(texelAlbedo(g.x) / 3.14159265 * (texelLight(g.x) + probesAt(p + n * P.lift, n)), 1.0);
}
`;

/** What one frame's reflection rays read besides the rays: the cache, its colours, the probes and their tables. */
export interface ReflectionTraceInput {
  /** The rays (`RAY_FLOATS` each) and where their light goes (a vec4f each). */
  readonly rays: GpuBuffer;
  readonly out: GpuBuffer;
  readonly count: number;
  readonly probes: LiveProbes;
  /** The probes' records on the GPU (null: none yet; the probes then give nothing). */
  readonly records: GpuBuffer | null;
  readonly sky: Float32Array;
  readonly rooms: Uint32Array | null;
  readonly atlas: GpuTexture;
  readonly rings: GpuTexture;
  readonly albedo: GpuBuffer;
  readonly albedoRingsAt: number;
  /** The resolve pass with the tables of the traced scene (the probes' own). */
  readonly resolve: GpuResolve;
}

type Pipeline = { getBindGroupLayout(i: number): unknown };

interface QueryDevice extends TracerDevice {
  readonly features?: { has(f: string): boolean };
  createQuerySet?(desc: { type: 'timestamp'; count: number }): unknown;
}

export class SurfaceReflectionPass {
  private readonly params: GpuBuffer;
  private readonly noRecords: GpuBuffer;
  private words: GpuBuffer | null = null;
  private readonly query: unknown;
  private readonly resolveTs: GpuBuffer | null;
  private timing = false;
  /** GPU ms a ray costs (an average over the timed frames; null until the first). */
  msPerRay: number | null = null;
  /** The last timed frame's GPU ms and rays (diagnostics). */
  lastMs: number | null = null;
  lastRays = 0;

  private constructor(private readonly device: QueryDevice, private readonly tracer: GpuTracer, private readonly gather: Pipeline) {
    this.params = device.createBuffer({ size: 64, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'reflection params' });
    this.noRecords = device.createBuffer({ size: 96, usage: USAGE.STORAGE, label: 'reflection no probes' });
    const timed = device.features?.has('timestamp-query') === true && device.createQuerySet !== undefined;
    this.query = timed ? device.createQuerySet!({ type: 'timestamp', count: 2 }) : null;
    this.resolveTs = timed ? device.createBuffer({ size: 16, usage: USAGE.QUERY_RESOLVE | USAGE.COPY_SRC, label: 'reflection timestamps' }) : null;
  }

  static async create(device: TracerDevice, tracer: GpuTracer): Promise<SurfaceReflectionPass> {
    const module = device.createShaderModule({ code: REFLECTION_GATHER_WGSL, label: 'reflection gather' });
    const info = await module.getCompilationInfo?.();
    const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
    if (errors.length > 0) throw new Error(`reflection gather WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
    return new SurfaceReflectionPass(device as QueryDevice, tracer, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: 'reflection gather' }));
  }

  /** Trace the rays, resolve their hits' texels and gather their light, in one submit. */
  run(input: ReflectionTraceInput): void {
    const d = this.device;
    const n = input.count;
    if (n === 0 || !this.tracer.ready) return;
    const packed = packProbeWords({ probes: input.probes, slots: new Uint32Array(0), sky: input.sky, rooms: input.rooms });
    if (this.words === null || this.words.size < packed.words.byteLength) {
      this.words?.destroy();
      let size = 256;
      while (size < packed.words.byteLength) size *= 2;
      this.words = d.createBuffer({ size, usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'reflection words' });
    }
    d.queue.writeBuffer(this.words, 0, packed.words);
    const p = new Uint32Array(16);
    const pf = new Float32Array(p.buffer);
    const grids = input.records === null ? 0 : input.probes.grids.length;
    p.set([0, n, grids, packed.gridAt, packed.skyAt, packed.roomsAt, 0, input.probes.count]);
    pf.set([0, BOUNCE_ALBEDO, PROBE_HIT_LIFT, 0], 8);
    p[12] = input.albedoRingsAt;
    d.queue.writeBuffer(this.params, 0, p);
    // One frame timed at a time: the next waits for the read-back.
    const timed = this.query !== null && !this.timing;
    const enc = d.createCommandEncoder();
    this.tracer.encodeBuffer(enc, input.rays, n, timed ? { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: 0 } } : {}, EXACT_TRACE, null);
    input.resolve.encode(enc, this.tracer.hitsBuffer!, n);
    const pass = enc.beginComputePass(timed ? { timestampWrites: { querySet: this.query, endOfPassWriteIndex: 1 } } : {});
    pass.setPipeline(this.gather);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: this.gather.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.words } },
          { binding: 2, resource: { buffer: input.records ?? this.noRecords } },
          { binding: 3, resource: { buffer: input.rays } },
          { binding: 5, resource: { buffer: this.tracer.hitsBuffer } },
          { binding: 6, resource: { buffer: input.resolve.texels } },
          { binding: 7, resource: { buffer: input.out } },
          { binding: 8, resource: input.atlas.createView({ dimension: '2d-array' }) },
          { binding: 9, resource: input.rings.createView({ dimension: '2d-array' }) },
          { binding: 10, resource: { buffer: input.albedo } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
    pass.end();
    let ts: GpuBuffer | null = null;
    if (timed && this.resolveTs !== null) {
      ts = d.createBuffer({ size: 16, usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'reflection timestamps read' });
      (enc as unknown as { resolveQuerySet(q: unknown, first: number, count: number, dst: GpuBuffer, offset: number): void }).resolveQuerySet(this.query, 0, 2, this.resolveTs, 0);
      enc.copyBufferToBuffer(this.resolveTs, 0, ts, 0, 16);
    }
    d.queue.submit([enc.finish()]);
    if (ts === null) return;
    this.timing = true;
    const read = ts;
    read.mapAsync(USAGE.MAP_READ).then(
      () => {
        const t = new BigUint64Array(read.getMappedRange().slice(0));
        read.unmap();
        read.destroy();
        this.timing = false;
        const ms = Number(t[1]! - t[0]!) / 1e6;
        if (!(ms > 0)) return;
        this.lastMs = ms;
        this.lastRays = n;
        const per = ms / n;
        this.msPerRay = this.msPerRay === null ? per : this.msPerRay + (per - this.msPerRay) * RAY_COST_WEIGHT;
      },
      () => {
        read.destroy();
        this.timing = false;
      },
    );
  }

  dispose(): void {
    for (const b of [this.params, this.noRecords, this.words, this.resolveTs]) b?.destroy();
    (this.query as { destroy?(): void } | null)?.destroy?.();
    this.words = null;
  }
}
