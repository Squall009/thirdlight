/**
 * The resolve pass on one device (`surface-resolve-wgsl.ts`): after a
 * tracer pass, each hit's texel, in a buffer the next pass reads (probes
 * and reflections gather the cache's light from it). The table is
 * uploaded again whenever residency changed (`packResolveTable`).
 */
import { RESOLVE_WGSL, RESOLVE_WORKGROUP } from './surface-resolve-wgsl';
import { TEXEL_WORDS } from './surface-resolve';
import type { GpuBuffer, GpuEncoder, TracerDevice } from './tracer-gpu';

const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;

export class GpuResolve {
  private readonly params: GpuBuffer;
  private table: GpuBuffer | null = null;
  private out: GpuBuffer | null = null;

  private constructor(private readonly device: TracerDevice, private readonly pipeline: { getBindGroupLayout(i: number): unknown }) {
    this.params = device.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'resolve params' });
  }

  static async create(device: TracerDevice): Promise<GpuResolve> {
    const module = device.createShaderModule({ code: RESOLVE_WGSL, label: 'surface resolve' });
    const info = await module.getCompilationInfo?.();
    const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
    if (errors.length > 0) throw new Error(`surface resolve WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
    return new GpuResolve(device, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: 'surface resolve' }));
  }

  /** Upload a packed table (replacing the last). */
  setTable(words: Uint32Array): void {
    this.table?.destroy();
    this.table = this.device.createBuffer({ size: Math.max(16, words.byteLength), usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'resolve table' });
    this.device.queue.writeBuffer(this.table, 0, words);
  }

  /** The texels of the last pass (`TEXEL_WORDS` per hit). */
  get texels(): GpuBuffer | null {
    return this.out;
  }

  /** Encode the pass over `count` hits (the tracer's hits buffer). */
  encode(encoder: GpuEncoder, hits: GpuBuffer, count: number, pass: Record<string, unknown> = {}): void {
    if (this.table === null) throw new Error('surface resolve: no table');
    const bytes = Math.max(1, count) * TEXEL_WORDS * 4;
    if (this.out === null || this.out.size < bytes) {
      this.out?.destroy();
      this.out = this.device.createBuffer({ size: bytes, usage: USAGE.STORAGE | USAGE.COPY_SRC, label: 'resolve texels' });
    }
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([count, 0, 0, 0]));
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.table } },
        { binding: 2, resource: { buffer: hits } },
        { binding: 3, resource: { buffer: this.out } },
      ],
    });
    const p = encoder.beginComputePass(pass);
    p.setPipeline(this.pipeline);
    p.setBindGroup(0, bind);
    p.dispatchWorkgroups(Math.ceil(count / RESOLVE_WORKGROUP));
    p.end();
  }

  /** Resolve `count` hits and read the texels back (the checks). */
  async resolve(hits: GpuBuffer, count: number): Promise<Uint32Array> {
    const encoder = this.device.createCommandEncoder();
    this.encode(encoder, hits, count);
    const bytes = count * TEXEL_WORDS * 4;
    const read = this.device.createBuffer({ size: Math.max(16, bytes), usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'resolve readback' });
    encoder.copyBufferToBuffer(this.out!, 0, read, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(USAGE.MAP_READ);
    const out = new Uint32Array(read.getMappedRange().slice(0, bytes));
    read.unmap();
    read.destroy();
    return out;
  }

  dispose(): void {
    for (const b of [this.params, this.table, this.out]) b?.destroy();
    this.table = this.out = null;
  }
}
