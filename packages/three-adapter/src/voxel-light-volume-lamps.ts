/**
 * The voxel light volume's lamps (voxel-light-volume.ts uses them): the lamp
 * table its update reads, made from the clustered lights' record of every
 * lamp (`ClusterLights`, gathered each frame for the clusters: one
 * description of a lamp on the page), and a list per kept brick (every
 * level) of the lamps that reach it, in world space, built in compute.
 *
 * - **The table.** Point and spot lights with a range whose reach meets the
 *   volume's windows, as `VOLUME_LAMP_FLOATS` words each (their kind passed
 *   through: a spot is lit as a point by the update for now; area lights and
 *   an effect's lights are not in it). Uploaded when it changes, into a
 *   buffer that grows with it: no count of lamps is capped.
 * - **The lists.** A slot of the pool's words: the lamps a brick's box is
 *   reached by (`volumeBrickLamps`, at most `VOLUME_LAMP_LIST_ENTRIES`; an
 *   overflowing brick keeps those that give it the most light, the rest
 *   counted). A hit is lit by its level-0 brick's list, past the level-0
 *   window (or before its brick has a slot) by the finest coarse brick's
 *   holding it, so the bounce of lamps out to the coarse levels' reach is
 *   kept. Built for every brick holding a slot when the table
 *   changes, and for the slots taken or given up since the last build
 *   otherwise; never while nothing changed. The clustered lists are per
 *   camera and leave out what is off screen; the update's rays reach bricks
 *   off screen, so these are the bricks' own.
 * - **Where a brick's list is.** A window index of its own (every level's,
 *   wrapped and stacked as the pool's index), written as a brick takes or gives up a slot: the
 *   pool's index is written only after a brick's first update, and a lamp's
 *   bounce off a brick not yet updated must not wait for it.
 * - **The counts.** After a build, every slot's list is summed in compute
 *   (bricks listing a lamp, the most lamps reaching one brick, bricks over
 *   and lamps dropped) and read back, one reading at a time, for the volume's
 *   diagnostics.
 */
import { CLUSTER_RECT, CLUSTER_UNBOUNDED, CLUSTER_UNCACHED, type ClusterLights } from './cluster-build';
import { GPU_BUFFER_USAGE, GPU_MAP_READ, grownGpuBuffer, type GpuBuffer } from './tracer-gpu';
import { VOLUME_INDEX_ROWS, VOLUME_INDEX_WIDTH, VOLUME_LAMP_FLOATS, VOLUME_LAMP_LIST_WORDS } from './voxel-light-volume-layout';
import { VOLUME_LAMP_LIST_PARAM_WORDS, VOLUME_LAMP_LIST_STAT_WORDS, VOLUME_LAMP_LIST_WGSL, VOLUME_LAMP_LIST_WORKGROUP } from './voxel-light-volume-wgsl';
import type { VolumeDevice } from './voxel-light-volume';

/** The lamps the volume's update reads, as its table holds them. */
export interface VolumeLampSet {
  readonly data: Float32Array;
  readonly count: number;
  /** Changes when any lamp's record does (a change marks what the old and new lamps reach). */
  readonly key: string;
  /** Each lamp's place and reach (x, y, z, r). */
  readonly spheres: readonly number[][];
}

export const NO_VOLUME_LAMPS: VolumeLampSet = Object.freeze({ data: new Float32Array(VOLUME_LAMP_FLOATS), count: 0, key: '', spheres: [] });

/**
 * The volume's lamp table from the clustered lights' record: the point and spot lights on, with a range, lit, and an
 * update's lamp (not an effect's), whose reach meets the box lo … hi (metres).
 */
export function volumeLampSet(lights: ClusterLights | null, [lo, hi]: readonly [readonly number[], readonly number[]]): VolumeLampSet {
  if (lights === null || lights.count === 0) return NO_VOLUME_LAMPS;
  const found: number[] = [];
  const keys: string[] = [];
  const spheres: number[][] = [];
  const rec = new Array<number>(VOLUME_LAMP_FLOATS);
  for (let i = 0; i < lights.count; i++) {
    const field = lights.kind[i]!;
    const kind = field & 3;
    // Area lights are not lamps of the volume yet; an effect's lights are not held by the lighting stores; a lamp
    // without a range has no reach to list it by.
    if (kind >= CLUSTER_RECT || (field & CLUSTER_UNCACHED) !== 0 || (field & CLUSTER_UNBOUNDED) !== 0 || lights.visible[i] !== 1) continue;
    const r = lights.reach[i]!;
    const x = lights.position[i * 3]!;
    const y = lights.position[i * 3 + 1]!;
    const z = lights.position[i * 3 + 2]!;
    const c = i * 3;
    if (!(r > 0) || !(lights.color[c]! + lights.color[c + 1]! + lights.color[c + 2]! > 0)) continue;
    if (x + r < lo[0]! || y + r < lo[1]! || z + r < lo[2]! || x - r > hi[0]! || y - r > hi[1]! || z - r > hi[2]!) continue;
    rec[0] = x;
    rec[1] = y;
    rec[2] = z;
    rec[3] = r;
    for (let a = 0; a < 3; a++) {
      rec[4 + a] = lights.color[c + a]!;
      rec[8 + a] = lights.direction[c + a]!;
      rec[12 + a] = lights.u[c + a]!;
      rec[16 + a] = lights.v[c + a]!;
    }
    rec[7] = lights.decay[i]!;
    rec[11] = field;
    rec[15] = lights.cone[i * 2]!;
    rec[19] = lights.cone[i * 2 + 1]!;
    found.push(...rec);
    keys.push(rec.map((v) => v.toFixed(3)).join(','));
    spheres.push([x, y, z, r]);
  }
  if (spheres.length === 0) return NO_VOLUME_LAMPS;
  return { data: new Float32Array(found), count: spheres.length, key: keys.join(';'), spheres };
}

/** A list job: a brick (of `level`) and the slot its list goes to; or a slot cleared (`brick` null). */
export interface VolumeLampListJob {
  readonly slot: number;
  readonly level: number;
  readonly brick: readonly [number, number, number] | null;
}

/** The lists' counts over every slot, as the last reading found them. */
export interface VolumeLampListCounts {
  /** Bricks with a slot that some lamp reaches, and lamps listed over them. */
  readonly bricksLit: number;
  readonly listed: number;
  /** The most lamps reaching one brick (listed or not). */
  readonly mostReaching: number;
  /** Bricks reached by more lamps than a list holds, and the lamps they left out. */
  readonly bricksOver: number;
  readonly lampsDropped: number;
}

/** The lamp table, the lists and their window index on the volume's device. */
export class VolumeLampLists {
  /** The lamp table (grown with it; at least 256 bytes). */
  lampBuffer: GpuBuffer;
  /** A slot's list (`VOLUME_LAMP_LIST_WORDS` words) for every slot of the pool. */
  readonly lists: GpuBuffer;
  /** Every level's window's slot + 1 of each brick (0: none), wrapped and stacked as the pool's index. */
  readonly slots: GpuBuffer;
  private lampCount = 0;
  private jobs: GpuBuffer | null = null;
  private readonly params: GpuBuffer;
  private readonly counts: GpuBuffer;
  private readonly buildPipeline: { getBindGroupLayout(i: number): unknown };
  private readonly countPipeline: { getBindGroupLayout(i: number): unknown };
  private buildBind: { group: unknown; key: readonly unknown[] } | null = null;
  private countBind: unknown = null;
  private readonly query: unknown;
  private readonly stamps: GpuBuffer | null;
  private timing = false;
  private counting = false;
  /** A build happened whose counts are not read yet. */
  private countsWanted = false;
  /** The counts as last read (null: none read yet). */
  lastCounts: VolumeLampListCounts | null = null;
  /** Builds dispatched: all, those of every brick (the table changed), slots built and cleared, the last builds' GPU ms. */
  readonly stats = { builds: 0, fullBuilds: 0, slotsBuilt: 0, slotsCleared: 0, lastJobs: 0, lastMs: 0, lastFullJobs: 0, lastFullMs: 0, timed: 0 };

  constructor(
    private readonly device: VolumeDevice,
    private readonly capacity: number,
  ) {
    const d = device;
    const STORAGE = GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST;
    this.lampBuffer = d.createBuffer({ size: 256, usage: STORAGE, label: 'voxel light volume lamps' });
    // New buffers are zeros: every list empty, no brick's slot known.
    this.lists = d.createBuffer({ size: capacity * VOLUME_LAMP_LIST_WORDS * 4, usage: STORAGE | GPU_BUFFER_USAGE.COPY_SRC, label: 'voxel light volume lamp lists' });
    this.slots = d.createBuffer({ size: VOLUME_INDEX_WIDTH * VOLUME_INDEX_ROWS * 4, usage: STORAGE, label: 'voxel light volume lamp list index' });
    this.params = d.createBuffer({ size: VOLUME_LAMP_LIST_PARAM_WORDS * 4, usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume lamp list params' });
    this.counts = d.createBuffer({ size: VOLUME_LAMP_LIST_STAT_WORDS * 4, usage: STORAGE | GPU_BUFFER_USAGE.COPY_SRC, label: 'voxel light volume lamp list counts' });
    const module = d.createShaderModule({ code: VOLUME_LAMP_LIST_WGSL, label: 'voxel light volume lamp lists' }) as { getCompilationInfo?(): Promise<{ messages: ReadonlyArray<{ type: string; lineNum: number; message: string }> }> };
    void module.getCompilationInfo?.().then((info) => {
      for (const m of info.messages) if (m.type === 'error') console.error(`voxel light volume lamp lists WGSL, line ${m.lineNum}: ${m.message}`);
    });
    this.buildPipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'build' }, label: 'voxel light volume lamp lists' });
    this.countPipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'count' }, label: 'voxel light volume lamp list counts' });
    const timed = d.features?.has('timestamp-query') === true && d.createQuerySet !== undefined;
    this.query = timed ? d.createQuerySet!({ type: 'timestamp', count: 2 }) : null;
    this.stamps = timed ? d.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE.QUERY_RESOLVE | GPU_BUFFER_USAGE.COPY_SRC, label: 'voxel light volume lamp list timestamps' }) : null;
  }

  /** GPU bytes: the lists, their window index, the lamp table and the build's buffers. */
  get bytes(): number {
    return this.lists.size + this.slots.size + this.lampBuffer.size + (this.jobs?.size ?? 0) + this.params.size + this.counts.size;
  }

  /** A new lamp table (its buffer grown to hold it). */
  setLamps(set: VolumeLampSet): void {
    this.lampBuffer = grownGpuBuffer(this.device, this.lampBuffer, Math.max(set.data.byteLength, 256), GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST, 'voxel light volume lamps');
    this.device.queue.writeBuffer(this.lampBuffer, 0, set.data);
    this.lampCount = set.count;
  }

  /** Rows of the lists' window index uploaded (`index`: the whole index, as the pool's, a row of `VOLUME_INDEX_WIDTH`). */
  writeSlots(index: Uint32Array, rows: Iterable<number>): void {
    const w = VOLUME_INDEX_WIDTH;
    for (const y of rows) this.device.queue.writeBuffer(this.slots, y * w * 4, index.subarray(y * w, (y + 1) * w));
  }

  /** The lists of `jobs` built (`full`: every brick's, the table changed), before the update that reads them. */
  build(jobs: readonly VolumeLampListJob[], full: boolean): void {
    if (jobs.length === 0) return;
    const d = this.device;
    const words = new Int32Array(jobs.length * 4);
    jobs.forEach((j, k) => {
      if (j.brick === null) words[k * 4 + 3] = -1 - j.slot;
      else {
        words.set(j.brick, k * 4);
        words[k * 4 + 3] = j.slot | (j.level << 24);
      }
    });
    this.jobs = grownGpuBuffer(d, this.jobs, Math.max(words.byteLength, 256), GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST, 'voxel light volume lamp list jobs');
    d.queue.writeBuffer(this.jobs, 0, words);
    d.queue.writeBuffer(this.params, 0, new Uint32Array([jobs.length, this.lampCount, this.capacity, 0]));
    const key = [this.jobs, this.lampBuffer];
    if (this.buildBind === null || this.buildBind.key.some((k, i) => k !== key[i])) {
      this.buildBind = {
        key,
        group: d.createBindGroup({
          layout: this.buildPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.params } },
            { binding: 1, resource: { buffer: this.jobs } },
            { binding: 2, resource: { buffer: this.lampBuffer } },
            { binding: 3, resource: { buffer: this.lists } },
          ],
        }),
      };
    }
    const enc = d.createCommandEncoder();
    const time = this.query !== null && this.stamps !== null && !this.timing;
    const pass = enc.beginComputePass(time ? { label: 'voxel light volume lamp lists', timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : { label: 'voxel light volume lamp lists' });
    pass.setPipeline(this.buildPipeline);
    pass.setBindGroup(0, this.buildBind.group);
    pass.dispatchWorkgroups(Math.ceil(jobs.length / VOLUME_LAMP_LIST_WORKGROUP));
    pass.end();
    let read: GpuBuffer | null = null;
    if (time) {
      read = d.createBuffer({ size: 16, usage: GPU_MAP_READ | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume lamp list timestamps read' });
      enc.resolveQuerySet!(this.query, 0, 2, this.stamps!, 0);
      enc.copyBufferToBuffer(this.stamps!, 0, read, 0, 16);
    }
    d.queue.submit([enc.finish()]);
    const built = jobs.filter((j) => j.brick !== null).length;
    const s = this.stats;
    s.builds++;
    if (full) s.fullBuilds++;
    s.slotsBuilt += built;
    s.slotsCleared += jobs.length - built;
    if (full) s.lastFullJobs = jobs.length;
    s.lastJobs = jobs.length;
    this.countsWanted = true;
    if (read === null) return;
    this.timing = true;
    const r = read;
    const wasFull = full;
    r.mapAsync(GPU_MAP_READ).then(
      () => {
        const t = new BigUint64Array(r.getMappedRange().slice(0));
        r.unmap();
        r.destroy();
        this.timing = false;
        const ms = Number(t[1]! - t[0]!) / 1e6;
        if (!(ms > 0)) return;
        s.lastMs = ms;
        s.timed++;
        if (wasFull) s.lastFullMs = ms;
      },
      () => {
        r.destroy();
        this.timing = false;
      },
    );
  }

  /** After a build, every slot's list summed in compute and read back (one reading at a time; the next frame's otherwise). */
  count(): void {
    if (!this.countsWanted || this.counting) return;
    this.countsWanted = false;
    this.counting = true;
    const d = this.device;
    d.queue.writeBuffer(this.counts, 0, new Uint32Array(VOLUME_LAMP_LIST_STAT_WORDS));
    d.queue.writeBuffer(this.params, 0, new Uint32Array([0, this.lampCount, this.capacity, 0]));
    this.countBind ??= d.createBindGroup({
      layout: this.countPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 3, resource: { buffer: this.lists } },
        { binding: 4, resource: { buffer: this.counts } },
      ],
    });
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass({ label: 'voxel light volume lamp list counts' });
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, this.countBind);
    pass.dispatchWorkgroups(Math.ceil(this.capacity / VOLUME_LAMP_LIST_WORKGROUP));
    pass.end();
    const read = d.createBuffer({ size: VOLUME_LAMP_LIST_STAT_WORDS * 4, usage: GPU_MAP_READ | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume lamp list counts read' });
    enc.copyBufferToBuffer(this.counts, 0, read, 0, VOLUME_LAMP_LIST_STAT_WORDS * 4);
    d.queue.submit([enc.finish()]);
    read.mapAsync(GPU_MAP_READ).then(
      () => {
        const c = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        read.destroy();
        this.counting = false;
        this.lastCounts = { bricksLit: c[0]!, listed: c[1]!, mostReaching: c[2]!, bricksOver: c[3]!, lampsDropped: c[4]! };
      },
      () => {
        read.destroy();
        this.counting = false;
      },
    );
  }

  /** Slots' lists read back (each: the count listed, the count reaching, the entries listed). */
  async readSlots(slots: readonly number[]): Promise<Map<number, { listed: number[]; total: number }>> {
    const out = new Map<number, { listed: number[]; total: number }>();
    if (slots.length === 0) return out;
    const d = this.device;
    const bytes = VOLUME_LAMP_LIST_WORDS * 4;
    const buf = d.createBuffer({ size: bytes * slots.length, usage: GPU_MAP_READ | GPU_BUFFER_USAGE.COPY_DST, label: 'voxel light volume lamp lists read' });
    const enc = d.createCommandEncoder();
    slots.forEach((s, k) => enc.copyBufferToBuffer(this.lists, s * bytes, buf, k * bytes, bytes));
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPU_MAP_READ);
    const all = new Uint32Array(buf.getMappedRange().slice(0));
    buf.unmap();
    buf.destroy();
    slots.forEach((s, k) => {
      const o = k * VOLUME_LAMP_LIST_WORDS;
      out.set(s, { listed: [...all.subarray(o + 2, o + 2 + all[o]!)], total: all[o + 1]! });
    });
    return out;
  }

  dispose(): void {
    for (const b of [this.lampBuffer, this.lists, this.slots, this.jobs, this.params, this.counts, this.stamps]) b?.destroy();
    (this.query as { destroy?(): void } | null)?.destroy?.();
  }
}
