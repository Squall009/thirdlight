/**
 * The live probes' update on the GPU (`surface-probe-wgsl.ts`, its CPU twin
 * `surface-probe-cpu.ts`): the stale probes `LiveProbes.plan` hands out cast
 * their rays (held to their rooms), the tracer finds the closest hits, the
 * resolve pass their cache texels (`surface-resolve-gpu.ts`), and the
 * gather reads the cache's light there, the probes' own light and the sky,
 * into each probe's record. All probes' records stay on the GPU (the gather
 * reads neighbours at its hits); the updated ones are read back a frame or
 * so later for the probe lighting and the scheduler.
 *
 * Only the few WebGPU calls this uses are typed (`tracer-gpu.ts`'s types).
 */
import { EXACT_TRACE } from './tracer-cpu-math';
import type { GpuBuffer, GpuTexture, GpuTracer, TracerDevice } from './tracer-gpu';
import { RAY_FLOATS } from './tracer-scene';
import { GpuResolve } from './surface-resolve-gpu';
import { BOUNCE_ALBEDO, PROBE_BLEND_MIN, PROBE_FLOATS, PROBE_HIT_LIFT, PROBE_RAYS, NO_BRICK_WORD, type LiveProbes, type ProbeLayoutWords } from './surface-probes';
import { PROBE_COMMIT_WGSL, PROBE_GATHER_WGSL, PROBE_RAYS_WGSL, PROBE_SLOT_WORDS, PROBE_VEC4S, PROBE_WORKGROUP } from './surface-probe-wgsl';

const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80, QUERY_RESOLVE: 0x200 } as const;

interface QueryDevice extends TracerDevice {
  readonly features?: { has(f: string): boolean };
  createQuerySet?(desc: { type: 'timestamp'; count: number }): unknown;
}

type Pipeline = { getBindGroupLayout(i: number): unknown };

/** One update's inputs. */
export interface ProbePassInput {
  readonly probes: LiveProbes;
  readonly slots: Uint32Array;
  /** The sky's four RGB coefficients. */
  readonly sky: Float32Array;
  /** Packed rooms (null: none). */
  readonly rooms: Uint32Array | null;
  /** The cache's textures (the light runtime's). */
  readonly atlas: GpuTexture;
  readonly rings: GpuTexture;
  /** The surfaces' colours the materials drawing the cache put there (`albedoWords`; alpha 0: none yet), and where the rings' start. */
  readonly albedo: GpuBuffer;
  readonly albedoRingsAt: number;
}

/**
 * The words an update's passes read after the probes' layout (which starts
 * them, `LiveProbes.layoutWords`): its probes, the sky and the rooms, with
 * where each starts (counted from the start of the whole, layout included).
 */
export function packProbeWords(input: Pick<ProbePassInput, 'probes' | 'slots' | 'sky' | 'rooms'>): { layout: ProbeLayoutWords; tail: Uint32Array; slotsAt: number; skyAt: number; roomsAt: number } {
  const { probes, slots } = input;
  const layout = probes.layoutWords();
  const slotsAt = layout.words.length;
  const skyAt = slotsAt + slots.length * PROBE_SLOT_WORDS;
  const roomsAt = input.rooms === null ? 0 : skyAt + 12;
  const tail = new Uint32Array(skyAt + 12 + (input.rooms?.length ?? 0) - slotsAt);
  const f = new Float32Array(tail.buffer);
  slots.forEach((p, s) => {
    const at = s * PROBE_SLOT_WORDS;
    tail[at] = p;
    tail[at + 1] = probes.rooms[p]!;
    f.set(probes.positions.subarray(p * 3, p * 3 + 3), at + 2);
    f[at + 5] = probes.reach[p]!;
  });
  f.set(input.sky.subarray(0, 12), skyAt - slotsAt);
  if (input.rooms !== null) tail.set(input.rooms, roomsAt - slotsAt);
  return { layout, tail, slotsAt, skyAt, roomsAt };
}

/**
 * A pass's word buffer holding the probes' layout and an update's words
 * after it: the layout (tens of kilobytes in a large scene) is written only
 * when it changed or the buffer grew.
 */
export class ProbeWordsBuffer {
  private buf: GpuBuffer | null = null;
  private written: ProbeLayoutWords | null = null;

  constructor(private readonly device: TracerDevice, private readonly label: string) {}

  /** The buffer with `packed` in it. */
  write(packed: ReturnType<typeof packProbeWords>): GpuBuffer {
    const bytes = (packed.slotsAt + packed.tail.length) * 4;
    if (this.buf === null || this.buf.size < bytes) {
      this.buf?.destroy();
      let size = 256;
      while (size < bytes) size *= 2;
      this.buf = this.device.createBuffer({ size, usage: USAGE.STORAGE | USAGE.COPY_DST, label: this.label });
      this.written = null;
    }
    if (this.written !== packed.layout && packed.layout.words.length > 0) this.device.queue.writeBuffer(this.buf, 0, packed.layout.words);
    this.written = packed.layout;
    if (packed.tail.length > 0) this.device.queue.writeBuffer(this.buf, packed.slotsAt * 4, packed.tail);
    return this.buf;
  }

  dispose(): void {
    this.buf?.destroy();
    this.buf = null;
  }
}

/** The parameters (`PROBE_COMMON_WGSL`'s `Params`) for an update or a gather of `rays`, the probes laid out as `packed`. */
export function probeParams(probes: LiveProbes, packed: ReturnType<typeof packProbeWords>, slots: number, rays: number, seed: number, albedoRingsAt: number, withProbes = true): Uint32Array {
  const p = new Uint32Array(16);
  const pf = new Float32Array(p.buffer);
  p.set([slots, rays, withProbes ? probes.roomGrids : 0, 0, packed.skyAt, packed.roomsAt, seed, probes.count]);
  pf.set([0, BOUNCE_ALBEDO, PROBE_HIT_LIFT, PROBE_BLEND_MIN], 8);
  p[12] = albedoRingsAt;
  p[13] = packed.layout.latticeAt;
  // No probes: no map.
  p[14] = withProbes ? packed.layout.mapAt : NO_BRICK_WORD;
  p[15] = packed.slotsAt;
  return p;
}

export class SurfaceProbePass {
  private readonly params: GpuBuffer;
  private readonly words: ProbeWordsBuffer;
  private recordsBuf: GpuBuffer | null = null;
  private raysBuf: GpuBuffer | null = null;
  private heldBuf: GpuBuffer | null = null;
  private outBuf: GpuBuffer | null = null;
  private layout = -1;
  private seed = 7;
  private readonly query: unknown;
  private readonly resolveTs: GpuBuffer | null;
  /** An update is on the GPU or being read back: the next waits (the scheduler hands out what it read). */
  busy = false;

  private constructor(private readonly device: QueryDevice, private readonly tracer: GpuTracer, readonly resolve: GpuResolve, private readonly rays: Pipeline, private readonly gather: Pipeline, private readonly commit: Pipeline) {
    this.params = device.createBuffer({ size: 64, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'probe params' });
    this.words = new ProbeWordsBuffer(device, 'probe words');
    const timed = device.features?.has('timestamp-query') === true && device.createQuerySet !== undefined;
    this.query = timed ? device.createQuerySet!({ type: 'timestamp', count: 2 }) : null;
    this.resolveTs = timed ? device.createBuffer({ size: 16, usage: USAGE.QUERY_RESOLVE | USAGE.COPY_SRC, label: 'probe timestamps' }) : null;
  }

  static async create(device: TracerDevice, tracer: GpuTracer): Promise<SurfaceProbePass> {
    const compile = async (code: string, label: string): Promise<Pipeline> => {
      const module = device.createShaderModule({ code, label });
      const info = await module.getCompilationInfo?.();
      const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
      if (errors.length > 0) throw new Error(`${label} WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
      return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
    };
    return new SurfaceProbePass(device as QueryDevice, tracer, await GpuResolve.create(device), await compile(PROBE_RAYS_WGSL, 'probe rays'), await compile(PROBE_GATHER_WGSL, 'probe gather'), await compile(PROBE_COMMIT_WGSL, 'probe commit'));
  }

  /** The seed the last update turned its rays with (the CPU twin takes it). */
  get lastSeed(): number {
    return this.seed;
  }

  private grow(buf: GpuBuffer | null, bytes: number, usage: number, label: string): GpuBuffer {
    if (buf !== null && buf.size >= bytes) return buf;
    buf?.destroy();
    let size = 256;
    while (size < bytes) size *= 2;
    return this.device.createBuffer({ size, usage, label });
  }

  /** The probes' records on the GPU, if they are laid out as `probes` now (null: not yet, or placed again since). */
  recordsFor(probes: LiveProbes): GpuBuffer | null {
    return probes.layout === this.layout ? this.recordsBuf : null;
  }

  /** The next update puts the probes' records on the GPU again from the CPU's copy (a check starting both from one state). */
  reload(): void {
    this.layout = -1;
  }

  /** The probes' records on the GPU, put there again when the grids were placed again. */
  private syncLayout(probes: LiveProbes): void {
    if (probes.layout === this.layout && this.recordsBuf !== null) return;
    this.layout = probes.layout;
    this.recordsBuf?.destroy();
    this.recordsBuf = this.device.createBuffer({ size: Math.max(256, probes.state.byteLength), usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'probe records' });
    this.device.queue.writeBuffer(this.recordsBuf, 0, probes.state);
  }

  /**
   * Update `input.slots`. `done(values, ms)` hears the probes' new records
   * (`PROBE_FLOATS` each, in slot order) and the GPU time (null: not timed)
   * once they are read back.
   */
  run(input: ProbePassInput, done: (values: Float32Array, ms: number | null) => void): void {
    const n = input.slots.length;
    if (n === 0 || this.busy) return;
    const d = this.device;
    this.syncLayout(input.probes);
    const packed = packProbeWords(input);
    const rays = n * PROBE_RAYS;
    const wordsBuf = this.words.write(packed);
    this.raysBuf = this.grow(this.raysBuf, rays * RAY_FLOATS * 4, USAGE.STORAGE, 'probe rays');
    this.heldBuf = this.grow(this.heldBuf, rays * 4, USAGE.STORAGE, 'probe rays held');
    this.outBuf = this.grow(this.outBuf, n * PROBE_FLOATS * 4, USAGE.STORAGE | USAGE.COPY_SRC, 'probe updated');
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    d.queue.writeBuffer(this.params, 0, probeParams(input.probes, packed, n, rays, this.seed, input.albedoRingsAt));
    const timed = this.query !== null;
    const enc = d.createCommandEncoder();
    let pass = enc.beginComputePass(timed ? { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: 0 } } : {});
    pass.setPipeline(this.rays);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: this.rays.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: wordsBuf } },
          { binding: 2, resource: { buffer: this.raysBuf } },
          { binding: 3, resource: { buffer: this.heldBuf } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(rays / PROBE_WORKGROUP));
    pass.end();
    this.tracer.encodeBuffer(enc, this.raysBuf, rays, {}, EXACT_TRACE, null);
    this.resolve.encode(enc, this.tracer.hitsBuffer!, rays);
    pass = enc.beginComputePass();
    pass.setPipeline(this.gather);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: this.gather.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: wordsBuf } },
          { binding: 2, resource: { buffer: this.recordsBuf } },
          { binding: 3, resource: { buffer: this.raysBuf } },
          { binding: 4, resource: { buffer: this.heldBuf } },
          { binding: 5, resource: { buffer: this.tracer.hitsBuffer } },
          { binding: 6, resource: { buffer: this.resolve.texels } },
          { binding: 7, resource: { buffer: this.outBuf } },
          { binding: 8, resource: input.atlas.createView({ dimension: '2d-array' }) },
          { binding: 9, resource: input.rings.createView({ dimension: '2d-array' }) },
          { binding: 10, resource: { buffer: input.albedo } },
        ],
      }),
    );
    // One workgroup a probe.
    pass.dispatchWorkgroups(n);
    pass.end();
    pass = enc.beginComputePass(timed ? { timestampWrites: { querySet: this.query, endOfPassWriteIndex: 1 } } : {});
    pass.setPipeline(this.commit);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: this.commit.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: wordsBuf } },
          { binding: 2, resource: { buffer: this.recordsBuf } },
          { binding: 3, resource: { buffer: this.outBuf } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil((n * PROBE_VEC4S) / PROBE_WORKGROUP));
    pass.end();
    const bytes = n * PROBE_FLOATS * 4;
    const read = d.createBuffer({ size: Math.max(16, bytes), usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'probe read' });
    enc.copyBufferToBuffer(this.outBuf, 0, read, 0, bytes);
    let ts: GpuBuffer | null = null;
    if (timed && this.resolveTs !== null) {
      ts = d.createBuffer({ size: 16, usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'probe timestamps read' });
      (enc as unknown as { resolveQuerySet(q: unknown, first: number, count: number, dst: GpuBuffer, offset: number): void }).resolveQuerySet(this.query, 0, 2, this.resolveTs, 0);
      enc.copyBufferToBuffer(this.resolveTs, 0, ts, 0, 16);
    }
    d.queue.submit([enc.finish()]);
    this.busy = true;
    const msOf = async (): Promise<number | null> => {
      if (ts === null) return null;
      await ts.mapAsync(USAGE.MAP_READ);
      const t = new BigUint64Array(ts.getMappedRange().slice(0));
      ts.unmap();
      ts.destroy();
      const ns = Number(t[1]! - t[0]!);
      return ns > 0 ? ns / 1e6 : null;
    };
    Promise.all([read.mapAsync(USAGE.MAP_READ).then(() => new Float32Array(read.getMappedRange().slice(0, bytes))), msOf()]).then(
      ([values, ms]) => {
        read.unmap();
        read.destroy();
        this.busy = false;
        done(values, ms);
      },
      () => {
        read.destroy();
        ts?.destroy();
        this.busy = false;
      },
    );
  }

  dispose(): void {
    for (const b of [this.params, this.recordsBuf, this.raysBuf, this.heldBuf, this.outBuf, this.resolveTs]) b?.destroy();
    this.words.dispose();
    (this.query as { destroy?(): void } | null)?.destroy?.();
    this.resolve.dispose();
    this.recordsBuf = null;
  }
}
