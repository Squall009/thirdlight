/**
 * Plays of one GPU effect share its compute passes: a batch holds slots for
 * many plays of the same effect definition, each system's particles of every
 * slot live in one set of storage buffers, and one dispatch per pass steps
 * every slot (`GpuSystem`). What differs per play — its time, origin,
 * parameters, wind and this step's births — is a row block of the batch's slot
 * table, a storage buffer written on the CPU and uploaded once per step. So a
 * frame's compute work is a fixed number of calls per effect, not per play:
 * the main thread's share per play is its CPU planning and a few floats.
 *
 * Each play still draws from its own buffers (instanced attributes start at
 * the first instance, and WebGPU's compatibility level may allow no storage
 * reads in the vertex stage), filled by a gather pass of its own; the frame's
 * gathers of every play go to the GPU in one compute call.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { compileEffect, EffectInstance, Rng, type EffectOrigin, type EffectProgram, type SystemProgram } from '@thirdlight/effects';

import { releaseStorage } from './dispose';
import { cpuSystemsOf, GpuSystem, MAX_RUNS, SLOT_FLAG_RESET, SLOT_FLAG_STEP, type GpuDepthUniforms, type GpuParticleBuffers, type GpuSlotReader, type SharedUniforms } from './effects-gpu';
import { permutationTable, type N } from './effects-tsl';

const TSL: N = TSLTyped;
const { uniform, instancedArray } = TSL;

/** Engine tuning: the particles a batch holds over its GPU systems — its slot count is this over a play's particles. */
export const GPU_BATCH_PARTICLES = 16384;
/** Engine tuning: the most slots a batch has (its slot table is uploaded each step); more plays open more batches. */
export const GPU_BATCH_SLOTS = 64;

/** Slots of a batch whose plays each hold `particlesPerPlay` particles on the GPU. */
export function batchSlots(particlesPerPlay: number): number {
  return Math.max(1, Math.min(GPU_BATCH_SLOTS, Math.floor(GPU_BATCH_PARTICLES / Math.max(1, particlesPerPlay))));
}

/** A slot's rows (vec4) in the slot table: time, origin, the previous position, wind; then parameters; then births per GPU system. */
export const SLOT_ROW = { time: 0, position: 1, rotation: 2, scale: 3, previous: 4, wind: 5, gust: 6, params: 7 } as const;

export interface SlotLayout {
  /** Rows per slot. */
  readonly rows: number;
  /** Each effect parameter's row and type. */
  readonly params: ReadonlyMap<string, { row: number; type: string }>;
  /** Each GPU system's births row (count, first serial's bits), followed by `MAX_RUNS` run rows (start, count, distance). */
  readonly spawn: readonly number[];
}

export function slotLayout(params: readonly { key: string; type: string }[], gpuSystems: number): SlotLayout {
  let row: number = SLOT_ROW.params;
  const map = new Map<string, { row: number; type: string }>();
  for (const p of params) map.set(p.key, { row: row++, type: p.type });
  const spawn: number[] = [];
  for (let j = 0; j < gpuSystems; j++) {
    spawn.push(row);
    row += 1 + MAX_RUNS;
  }
  return { rows: row, params: map, spawn };
}

/** The slot table on the CPU: floats, and the same memory as unsigned integers (serial numbers keep all 32 bits). */
export interface SlotTable {
  readonly layout: SlotLayout;
  readonly floats: Float32Array;
  readonly bits: Uint32Array;
}

export function slotTable(layout: SlotLayout, slots: number): SlotTable {
  const floats = new Float32Array(slots * layout.rows * 4);
  return { layout, floats, bits: new Uint32Array(floats.buffer) };
}

const at = (t: SlotTable, slot: number, row: number): number => (slot * t.layout.rows + row) * 4;

/** A play's values for one step. */
export interface SlotStep {
  dt: number;
  /** Cycle time at the step's start (the reference evaluates the step there). */
  time: number;
  worldTime: number;
  flags: number;
  current: EffectOrigin;
  previousPosition: readonly number[];
}

export function writeSlotStep(t: SlotTable, slot: number, s: SlotStep): void {
  const f = t.floats;
  let o = at(t, slot, SLOT_ROW.time);
  f[o] = s.dt;
  f[o + 1] = s.time;
  f[o + 2] = s.worldTime;
  f[o + 3] = s.flags;
  o = at(t, slot, SLOT_ROW.position);
  f.set(s.current.position.slice(0, 3), o);
  o = at(t, slot, SLOT_ROW.rotation);
  f.set(s.current.rotation.slice(0, 4), o);
  o = at(t, slot, SLOT_ROW.scale);
  f.set(s.current.scale.slice(0, 3), o);
  o = at(t, slot, SLOT_ROW.previous);
  f.set(s.previousPosition.slice(0, 3), o);
}

/** A system's planned births of one step (`EffectInstance.plans()`). */
export interface SpawnPlan {
  serialBase: number;
  count: number;
  runs: readonly { count: number; distance: boolean }[];
}

/** Write one GPU system's births (at most its capacity: the rest would be refused anyway). */
export function writeSlotSpawn(t: SlotTable, slot: number, gpuIndex: number, capacity: number, plan: SpawnPlan | undefined): void {
  const row = t.layout.spawn[gpuIndex]!;
  const o = at(t, slot, row);
  const count = plan === undefined ? 0 : Math.max(0, Math.min(plan.count, capacity));
  t.floats[o] = count;
  t.bits[o + 1] = count > 0 ? plan!.serialBase >>> 0 : 0;
  let start = 0;
  for (let r = 0; r < MAX_RUNS; r++) {
    const run = count > 0 ? plan!.runs[r] : undefined;
    const q = at(t, slot, row + 1 + r);
    t.floats[q] = start;
    t.floats[q + 1] = run?.count ?? 0;
    t.floats[q + 2] = run?.distance === true ? 1 : 0;
    start += run?.count ?? 0;
  }
}

/** After a dispatch: every slot idle until its play steps again (no flags, no births). */
export function clearSlotSteps(t: SlotTable, slots: Iterable<number>): void {
  for (const slot of slots) {
    t.floats[at(t, slot, SLOT_ROW.time) + 3] = 0;
    for (const row of t.layout.spawn) t.floats[at(t, slot, row)] = 0;
  }
}

/** A play's constants: its parameters and the wind. */
export function writeSlotConstants(t: SlotTable, slot: number, params: (key: string) => readonly number[] | null, wind: { direction: readonly number[]; strength: number; gust: number; gustFrequency: number; turbulence: number }): void {
  for (const [key, p] of t.layout.params) {
    const v = params(key) ?? [0];
    const o = at(t, slot, p.row);
    t.floats.set([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, p.type === 'color' ? (v[3] ?? 1) : (v[3] ?? 0)], o);
  }
  const d = new THREE.Vector3(wind.direction[0] ?? 0, 0, wind.direction[1] ?? 0);
  if (d.lengthSq() > 1e-24) d.normalize();
  else d.set(0, 0, 0);
  t.floats.set([d.x, d.y, d.z, wind.strength], at(t, slot, SLOT_ROW.wind));
  t.floats.set([wind.gust, wind.gustFrequency, wind.turbulence, 0], at(t, slot, SLOT_ROW.gust));
}

/** Free slots handed out lowest first (the table's uploaded prefix stays short). */
export class SlotPool {
  private readonly free: number[];
  constructor(readonly size: number) {
    this.free = Array.from({ length: size }, (_, i) => size - 1 - i);
  }
  acquire(): number | null {
    return this.free.pop() ?? null;
  }
  release(slot: number): void {
    this.free.push(slot);
    this.free.sort((a, b) => b - a);
  }
  get used(): number {
    return this.size - this.free.length;
  }
  /** One past the highest slot in use (0: none). */
  get extent(): number {
    const free = new Set(this.free);
    let end = this.size;
    while (end > 0 && free.has(end - 1)) end -= 1;
    return end;
  }
}

/** One system of one play: what its draw reads (its own buffers) and the pass that fills them from its slot. */
export interface GpuPlaySystem {
  readonly program: SystemProgram;
  readonly capacity: number;
  /** The batch's particle buffers (every slot's) and this play's slot: its particles are `slot * capacity` on. */
  readonly buffers: GpuParticleBuffers;
  readonly slot: number;
  readonly draw: { posAge: N; velLife: N; color: N; sizeRot: N };
  readonly gather: N;
}

export interface GpuExecutorOptions {
  params?: Readonly<Record<string, number | number[] | string>>;
  wind?: { direction: readonly number[]; strength: number; gust: number; gustFrequency: number; turbulence: number };
  /** The executor's particle cap per system. */
  capacityLimit: number;
  /** Systems whose outputs blend with alpha (their slots are sorted back to front). */
  sortedSystems: ReadonlySet<string>;
  /** The scene depth the player draws for scene-depth collision (null: none; such blocks then do nothing). */
  depthTexture?: THREE.Texture | null;
  /** The particle cap of the systems simulated on the CPU (the CPU executor's; absent: `capacityLimit`). */
  cpuCapacityLimit?: number;
  /** A model asset's mesh (mesh-surface shapes of CPU-simulated systems). */
  mesh?: (assetId: string) => import('@thirdlight/effects').EffectMesh | null;
  /**
   * The batches this play joins (the player's: one per renderer). Absent: a
   * batch of its own, stepped and gathered at once (the Effect tab's preview).
   */
  batches?: GpuEffectBatches;
}

type EffectDef = import('@thirdlight/effects').EffectInstance['effect'];

/** Plays of one effect definition in shared buffers: the slot table, the systems over every slot, the permutation table and the depth. */
export class GpuEffectBatch {
  readonly systems: GpuSystem[];
  readonly table: SlotTable;
  readonly pool: SlotPool;
  readonly depth: GpuDepthUniforms;
  private readonly tableNode: N;
  private readonly perm: N;
  /** Slots written since the last dispatch. */
  private readonly stepped = new Set<number>();
  /** Bumped by every dispatch: a read-back issued since the last one can be shared. */
  private generation = 0;
  private reading: { generation: number; counts: Promise<Int32Array[]> } | null = null;

  constructor(
    readonly effect: EffectDef,
    program: EffectProgram,
    cpuSystems: ReadonlySet<number>,
    options: GpuExecutorOptions,
    slots: number,
  ) {
    const gpuPrograms = program.systems.filter((s) => !cpuSystems.has(s.index));
    this.table = slotTable(slotLayout(effect.parameters ?? [], gpuPrograms.length), slots);
    this.pool = new SlotPool(slots);
    this.tableNode = instancedArray(this.table.floats, 'vec4');
    this.perm = instancedArray(permutationTable(effect.seed, (s) => {
      const r = new Rng(s);
      return () => r.next();
    }), 'uint');
    const usesDepth = program.systems.some((s) => s.chains.update.some((b) => b.type === 'update.collide.depth'));
    this.depth = { viewProj: uniform(new THREE.Matrix4()), view: uniform(new THREE.Matrix4()), near: uniform(0.1), far: uniform(100), texture: usesDepth ? (options.depthTexture ?? null) : null, size: uniform(new THREE.Vector2(1, 1)), enabled: usesDepth };
    const reader = this.reader(effect.duration);
    this.systems = gpuPrograms.map((s, j) => new GpuSystem(s, reader, j, effect.seed, options.sortedSystems.has(s.systemId), slots));
  }

  /** The slot table as the passes read it: each value a var declared where the pass asks for it (in scope for the whole pass). */
  private reader(duration: number): GpuSlotReader {
    const layout = this.table.layout;
    const table = this.tableNode;
    const row = (slot: N, r: number): N => table.element(slot.mul(layout.rows).add(r));
    return {
      shared: (slot: N): SharedUniforms => {
        const time = row(slot, SLOT_ROW.time).toVar();
        const wind = row(slot, SLOT_ROW.wind).toVar();
        const gust = row(slot, SLOT_ROW.gust).toVar();
        const params = new Map<string, { node: N; type: string }>();
        for (const [key, p] of layout.params) {
          const v = row(slot, p.row);
          params.set(key, { node: (p.type === 'float' ? v.x : p.type === 'vec3' ? v.xyz : v).toVar(), type: p.type });
        }
        return {
          dt: time.x,
          time: time.y,
          worldTime: time.z,
          duration: TSL.float(duration),
          origin: { position: row(slot, SLOT_ROW.position).xyz.toVar(), rotation: row(slot, SLOT_ROW.rotation).toVar(), scale: row(slot, SLOT_ROW.scale).xyz.toVar() },
          prevPosition: row(slot, SLOT_ROW.previous).xyz.toVar(),
          wind: { dir: wind.xyz, strength: wind.w, gust: gust.x, freq: gust.y, turb: gust.z },
          params,
          depth: this.depth,
          perm: this.perm,
        };
      },
      flags: (slot: N): N => row(slot, SLOT_ROW.time).w,
      spawn: (slot: N, gpuIndex: number) => {
        const r0 = layout.spawn[gpuIndex]!;
        const head = row(slot, r0).toVar();
        return {
          count: head.x,
          serialBase: TSL.floatBitsToUint(head.y),
          runs: Array.from({ length: MAX_RUNS }, (_, r) => row(slot, r0 + 1 + r).toVar()),
        };
      },
    };
  }

  /** The camera the depth texture was drawn with (world → view → clip) and its size in pixels. */
  setDepthCamera(camera: THREE.Camera & { near?: number; far?: number }, width: number, height: number): void {
    const d = this.depth;
    (d.viewProj.value as THREE.Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    (d.view.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
    d.near.value = camera.near ?? 0.1;
    d.far.value = camera.far ?? 100;
    (d.size.value as THREE.Vector2).set(width, height);
  }

  /** A slot was written for the next dispatch. */
  markStepped(slot: number): void {
    this.stepped.add(slot);
  }

  /** The passes of the next dispatch (none when no slot stepped); uploads the table's used rows. */
  takeStep(): N[] {
    if (this.stepped.size === 0) return [];
    const attr = this.tableNode.value as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, this.pool.extent * this.table.layout.rows * 4);
    attr.needsUpdate = true;
    return this.systems.flatMap((s) => s.stepPasses());
  }

  /** After the dispatch: the stepped slots idle until written again. */
  stepDone(): void {
    if (this.stepped.size === 0) return;
    clearSlotSteps(this.table, this.stepped);
    this.stepped.clear();
    this.generation += 1;
  }

  /** Each GPU system's free-list counts per slot (read back; reads asked for before the next dispatch share one). */
  freeCounts(renderer: THREE.WebGPURenderer): Promise<Int32Array[]> {
    if (this.reading !== null && this.reading.generation === this.generation) return this.reading.counts;
    const counts = Promise.all(this.systems.map(async (s) => new Int32Array(await renderer.getArrayBufferAsync(s.buffers.deadCount.value))));
    this.reading = { generation: this.generation, counts };
    return counts;
  }

  dispose(renderer?: THREE.WebGPURenderer | null): void {
    for (const s of this.systems) s.dispose(renderer);
    const buffers = [this.tableNode.value, this.perm.value];
    for (const b of buffers) b?.dispose?.();
    releaseStorage(renderer, buffers);
  }
}

/** Every batch of a renderer: plays join them, and a frame dispatches each step and the gathers once for all. */
export class GpuEffectBatches {
  private readonly byEffect = new Map<EffectDef, GpuEffectBatch[]>();
  private readonly gathers = new Set<N>();
  private readonly sorts = new Set<GpuSystem>();

  /** `single`: one slot a batch (a play of its own). */
  constructor(private readonly single = false) {}

  /** A free slot in a batch of this effect (a new batch when every one is full). */
  acquire(effect: EffectDef, make: (slots: number) => GpuEffectBatch, particlesPerPlay: number): { batch: GpuEffectBatch; slot: number } {
    const list = this.byEffect.get(effect) ?? [];
    for (const batch of list) {
      const slot = batch.pool.acquire();
      if (slot !== null) return { batch, slot };
    }
    const batch = make(this.single ? 1 : batchSlots(particlesPerPlay));
    list.push(batch);
    this.byEffect.set(effect, list);
    return { batch, slot: batch.pool.acquire()! };
  }

  /** A play left its slot; an empty batch is freed. */
  release(batch: GpuEffectBatch, slot: number, renderer?: THREE.WebGPURenderer | null): void {
    batch.pool.release(slot);
    if (batch.pool.used > 0) return;
    const list = this.byEffect.get(batch.effect) ?? [];
    const i = list.indexOf(batch);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.byEffect.delete(batch.effect);
    for (const s of batch.systems) this.sorts.delete(s);
    batch.dispose(renderer);
  }

  /** Dispatch the written step of every batch: one compute call. */
  flushStep(renderer: THREE.WebGPURenderer): void {
    const batches = [...this.byEffect.values()].flat();
    const passes = batches.flatMap((b) => b.takeStep());
    if (passes.length > 0) void renderer.compute(passes);
    for (const b of batches) b.stepDone();
  }

  /** A play's gathers (and its systems' sorts) for this frame's `flushDraw`. */
  requestDraw(batch: GpuEffectBatch, systems: readonly GpuPlaySystem[]): void {
    for (const s of batch.systems) if (s.sorted) this.sorts.add(s);
    for (const s of systems) this.gathers.add(s.gather);
  }

  /** Sort the systems drawn this frame (back to front for this camera), then every requested gather: one compute call. */
  flushDraw(renderer: THREE.WebGPURenderer, camera: THREE.Vector3): void {
    const passes = [...this.sorts].flatMap((s) => s.sortPasses(camera));
    for (const g of this.gathers) passes.push(g);
    if (passes.length > 0) void renderer.compute(passes);
    this.sorts.clear();
    this.gathers.clear();
  }

  /** A play's gathers no longer run (it is gone before the frame's `flushDraw`). */
  forget(systems: readonly GpuPlaySystem[]): void {
    for (const s of systems) this.gathers.delete(s.gather);
  }

  get batchCount(): number {
    let n = 0;
    for (const list of this.byEffect.values()) n += list.length;
    return n;
  }

  dispose(renderer?: THREE.WebGPURenderer | null): void {
    for (const list of this.byEffect.values()) for (const b of list) b.dispose(renderer);
    this.byEffect.clear();
    this.gathers.clear();
    this.sorts.clear();
  }
}

/** A playing effect on the GPU (one per play; pooled by the player): its planner, its slot in a batch and its draw buffers. */
export class GpuEffectExecutor {
  /** Plans the GPU systems' births and simulates the CPU systems (`cpuSystems`). */
  readonly planner: EffectInstance;
  /** The systems run on the GPU (each knows its index: `program.index`). */
  readonly systems: GpuPlaySystem[];
  /** The systems (by index) simulated on the CPU beside them: `planner.systems[i]` holds their particles. */
  readonly cpuSystems: ReadonlySet<number>;
  private readonly batches: GpuEffectBatches;
  private readonly own: boolean;
  private readonly batch: GpuEffectBatch;
  private readonly slot: number;
  private needsReset = true;
  private disposed = false;

  constructor(
    readonly effect: EffectDef,
    options: GpuExecutorOptions,
  ) {
    // Compiled with the GPU cap, as the planner is: the batch's buffers hold these capacities.
    const program = compileEffect(effect, { capacityLimit: options.capacityLimit });
    const cpuSystems = cpuSystemsOf(program);
    this.cpuSystems = new Set(cpuSystems);
    this.planner = new EffectInstance(effect, {
      planOnly: true,
      capacityLimit: options.capacityLimit,
      simulate: cpuSystems,
      ...(options.cpuCapacityLimit !== undefined ? { simulateCapacityLimit: options.cpuCapacityLimit } : {}),
      ...(options.params !== undefined ? { params: options.params } : {}),
      ...(options.wind !== undefined ? { wind: options.wind as never } : {}),
      ...(options.mesh !== undefined ? { mesh: options.mesh } : {}),
    });
    this.own = options.batches === undefined;
    this.batches = options.batches ?? new GpuEffectBatches(true);
    const perPlay = program.systems.reduce((n, s) => n + (this.cpuSystems.has(s.index) ? 0 : s.capacity), 0);
    const { batch, slot } = this.batches.acquire(effect, (slots) => new GpuEffectBatch(effect, program, this.cpuSystems, options, slots), perPlay);
    this.batch = batch;
    this.slot = slot;
    writeSlotConstants(batch.table, slot, (key) => this.planner.parameter(key), this.planner.windConfig());
    this.systems = batch.systems.map((s) => {
      const C = s.capacity;
      const draw = { posAge: instancedArray(C, 'vec4'), velLife: instancedArray(C, 'vec4'), color: instancedArray(C, 'vec4'), sizeRot: instancedArray(C, 'vec4') };
      return { program: s.program, capacity: C, buffers: s.buffers, slot, draw, gather: s.gatherInto(draw, slot) };
    });
  }

  /** The camera the depth texture was drawn with (world → view → clip) and its size in pixels. */
  setDepthCamera(camera: THREE.Camera & { near?: number; far?: number }, width: number, height: number): void {
    this.batch.setDepthCamera(camera, width, height);
  }

  get usesDepth(): boolean {
    return this.batch.depth.enabled;
  }

  get diagnostics(): readonly import('@thirdlight/effects').EffectDiagnostic[] {
    return this.planner.diagnostics;
  }

  /** Clears every particle and starts over (the next step clears the slot first). */
  restart(): void {
    this.planner.restart();
    this.needsReset = true;
  }

  /** Apply a pending restart now (clears the slot without a step: the Effect tab's preview seeking to time 0). */
  resetNow(renderer: THREE.WebGPURenderer): void {
    if (!this.needsReset) return;
    const o = this.planner.origins().current;
    writeSlotStep(this.batch.table, this.slot, { dt: 0, time: 0, worldTime: 0, flags: SLOT_FLAG_RESET, current: o, previousPosition: o.position });
    this.batch.systems.forEach((s, j) => writeSlotSpawn(this.batch.table, this.slot, j, s.capacity, undefined));
    this.batch.markStepped(this.slot);
    this.needsReset = false;
    this.batches.flushStep(renderer);
  }

  /** Plan one step and write it into the slot; the batches dispatch it (at once for a batch of its own). */
  step(renderer: THREE.WebGPURenderer, dt: number, input: { origin?: EffectOrigin; worldTime?: number }): void {
    if (!(dt > 0)) return;
    const before = this.planner.origins().current;
    this.planner.step(dt, input);
    const { current } = this.planner.origins();
    // The reference evaluates the step with the time at its start (cycle time of t0).
    const t0 = this.planner.time - dt;
    const D = this.effect.duration;
    const t = this.batch.table;
    writeSlotStep(t, this.slot, { dt, time: this.effect.loop ? t0 % D : Math.min(t0, D), worldTime: input.worldTime ?? t0, flags: this.needsReset ? SLOT_FLAG_RESET : SLOT_FLAG_STEP, current, previousPosition: before.position });
    this.needsReset = false;
    const plans = this.planner.plans();
    this.batch.systems.forEach((s, j) => writeSlotSpawn(t, this.slot, j, s.capacity, plans[s.program.index]));
    this.batch.markStepped(this.slot);
    if (this.own) this.batches.flushStep(renderer);
  }

  /** Before drawing: sort (alpha-blended outputs) and gather this play's particles into its draw buffers (with the frame's others). */
  sort(renderer: THREE.WebGPURenderer, cameraPosition: THREE.Vector3): void {
    this.batches.requestDraw(this.batch, this.systems);
    if (this.own) this.batches.flushDraw(renderer, cameraPosition);
  }

  /** Spawning is over (a finished one-shot or a stop): the player then asks the GPU whether particles remain. */
  get spawning(): boolean {
    return this.planner.alive;
  }

  async living(renderer: THREE.WebGPURenderer): Promise<number> {
    return (await this.livingBySystem(renderer)).reduce((a, n) => a + n, 0);
  }

  /** Living particles per system, by index (GPU systems read back; CPU systems counted now). */
  async livingBySystem(renderer: THREE.WebGPURenderer): Promise<number[]> {
    const free = await this.batch.freeCounts(renderer);
    const out = this.planner.systems.map((s) => s.count);
    this.batch.systems.forEach((s, j) => (out[s.program.index] = s.capacity - free[j]![this.slot]!));
    return out;
  }

  /** Release the slot, the gathers and the draw buffers (`renderer`: the one that ran them, so their GPU buffers are freed now; see `releaseStorage`). */
  dispose(renderer?: THREE.WebGPURenderer | null): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batches.forget(this.systems);
    for (const s of this.systems) s.gather.dispose?.();
    const buffers = this.systems.flatMap((s) => Object.values(s.draw).map((b) => (b as N).value));
    for (const b of buffers) b?.dispose?.();
    releaseStorage(renderer, buffers);
    this.batches.release(this.batch, this.slot, renderer);
  }
}
