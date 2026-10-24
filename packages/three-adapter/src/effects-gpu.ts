/**
 * The WebGPU executor of effect graphs — the same semantics as
 * the CPU reference (`@thirdlight/effects`), simulated in TSL compute passes.
 *
 * Per system: storage buffers of `capacity` particles (vec4s: position +
 * age, velocity + lifetime, colour, initial colour, size / initial size /
 * rotation / spin, mass / random / alive; the serial number) and a free
 * list (a stack of dead slots with an atomic count) — the pool: a birth
 * pops a slot, a death pushes it back, so births past the capacity are
 * refused exactly as on the CPU. Each step, per system in the effect's
 * order:
 *
 * 1. the update pass (one thread per slot): age, death at the lifetime,
 *    size and colour from their initial values, the Update chain's force and
 *    over-life blocks in chain order, explicit Euler, spin, then collisions
 *    and kills in chain order;
 * 2. the spawn pass (one thread per birth): the CPU plans how many particles
 *    the Spawn chain gives and numbers them (`EffectInstance` in plan-only
 *    mode: rates with their carried fraction, bursts, per metre moved); each
 *    thread pops a slot and runs the Initialize chain with the reference's
 *    random stream (hash of seed, system and serial; mulberry32 draws in the
 *    same order), so a particle starts where the CPU starts it (to float
 *    precision).
 *
 * Draw order for alpha-blended outputs comes from a bitonic sort pass over
 * the slots by view distance (back to front; dead slots last), up to
 * `GPU_SORT_LIMIT` slots.
 *
 * What this executor does not run: events between systems (they need
 * particle data back on the CPU: an effect using them plays wholly on the
 * CPU executor, with the reason in the diagnostics). Systems whose particles
 * are used on the CPU — lights, ribbons/trails, mesh-surface shapes — or with
 * more than four origin spawn blocks are simulated on the CPU beside the
 * effect's GPU systems, in the same step (`cpuSystemReason`).
 *
 * Scene-depth collision (`update.collide.depth`) is honoured here only: it
 * reads the previous frame's scene depth (a depth pre-pass the player
 * renders when an effect needs it).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { compileEffect, EffectInstance, Rng, type CompiledNode, type EffectOrigin, type EffectProgram, type SystemProgram, type WireSource } from '@thirdlight/effects';

import { releaseStorage } from './dispose';
import { curveNode, gradientNode, hash32, hashFloat, hexLinear, normalize0, permutationTable, rotate, toLocalPoint, toLocalVector, toWorldDirection, toWorldPoint, toWorldVector, TslNoise, TslRng, type N, type OriginNodes } from './effects-tsl';

/** TSL untyped (see effects-tsl.ts). */
const TSL: N = TSLTyped;
const { Fn, If, float, int, uint, vec2, vec3, vec4, select, instanceIndex, uniform, instancedArray } = TSL;

/** Engine limit: slots sorted for alpha blending (bitonic, power of two); beyond it alpha particles draw unsorted. */
export const GPU_SORT_LIMIT = 65536;
/** Origin spawn blocks one system may have on the GPU (their runs are rows of the slot table). */
export const MAX_RUNS = 4;
/** A slot's step flags in the slot table: stepped this dispatch, or cleared (every particle dead) before its births. */
export const SLOT_FLAG_STEP = 1;
export const SLOT_FLAG_RESET = 2;

/**
 * Why an effect cannot run on the GPU executor at all (null: it can, maybe
 * with some systems beside it on the CPU — `cpuSystemReason`). Only events
 * tie systems together: a system spawning from another's events needs that
 * system's particles on the CPU, so such an effect runs wholly on the CPU.
 */
export function gpuUnsupportedReason(program: EffectProgram): string | null {
  for (const s of program.systems) {
    for (const b of s.chains.spawn) if (b.type === 'spawn.event') return `system "${s.name}" spawns from events (events between systems run on the CPU executor)`;
  }
  return null;
}

/**
 * Why one system of a GPU-run effect is simulated on the CPU beside the
 * others (null: on the GPU). Its particles are used on the CPU — lights
 * follow them, ribbons join them, mesh-surface shapes sample a mesh there —
 * or it has more spawn blocks than the GPU's per-system uniforms hold.
 * Reading such a system back from the GPU would cost a buffer map a frame
 * and show it a frame late; these systems hold few particles, so the CPU
 * simulates them in the same step instead (`EffectInstance`'s `simulate`).
 */
export function cpuSystemReason(s: SystemProgram): string | null {
  for (const b of s.chains.output) {
    if (b.type === 'output.light') return `system "${s.name}" drives lights (its particles are simulated on the CPU)`;
    if (b.type === 'output.ribbon') return `system "${s.name}" draws ribbons/trails (their points are built on the CPU)`;
  }
  for (const b of s.chains.initialize) if (b.type === 'init.position.mesh') return `system "${s.name}" samples a mesh surface (on the CPU)`;
  if (s.chains.spawn.length > MAX_RUNS) return `system "${s.name}" has more than ${MAX_RUNS} spawn blocks`;
  return null;
}

/**
 * Why each system of an effect run by this executor is simulated on the CPU
 * (null: on the GPU): what must run there (`cpuSystemReason`). Small systems
 * stay on the GPU too: every play of an effect shares its passes
 * (`effects-gpu-batch.ts`), so a system costs no dispatch of its own.
 */
export function cpuSystemReasons(program: EffectProgram): (string | null)[] {
  return program.systems.map((s) => cpuSystemReason(s));
}

/** The systems (by index) of a GPU-run effect simulated on the CPU. */
export function cpuSystemsOf(program: EffectProgram): number[] {
  return cpuSystemReasons(program).flatMap((r, i) => (r !== null ? [i] : []));
}

/** What every system of an effect reads of its play: its slot's values (vars in the pass) and the batch's uniforms. */
export interface GpuDepthUniforms {
  viewProj: N;
  view: N;
  near: N;
  far: N;
  texture: THREE.Texture | null;
  size: N;
  enabled: boolean;
}

export interface SharedUniforms {
  dt: N;
  time: N;
  duration: N;
  worldTime: N;
  origin: OriginNodes;
  prevPosition: N;
  wind: { dir: N; strength: N; gust: N; freq: N; turb: N };
  params: Map<string, { node: N; type: string }>;
  /** Scene depth (collide.depth): the view-projection of the frame it was drawn with, its texture and size. */
  depth: GpuDepthUniforms;
  perm: N;
}

/**
 * Particle state of one system. The six vec4 fields live interleaved in one
 * storage buffer (`state`, 6 vec4 per slot: WebGPU guarantees only 8 storage
 * buffers per shader stage) — each field is a view with `.element(i)`.
 */
export interface GpuParticleBuffers {
  state: N;
  posAge: N;
  velLife: N;
  color: N;
  baseColor: N;
  sizeRot: N;
  massRand: N;
  serial: N;
  dead: N;
  deadCount: N;
}
/** vec4s per slot in `state`, and each field's index. */
export const GPU_STATE_STRIDE = 6;
export const GPU_STATE_FIELDS = { posAge: 0, velLife: 1, color: 2, baseColor: 3, sizeRot: 4, massRand: 5 } as const;

interface ParticleVars {
  pos: N;
  vel: N;
  age: N;
  life: N;
  color: N;
  baseColor: N;
  size: N;
  baseSize: N;
  rot: N;
  spin: N;
  mass: N;
  random: N;
  /** Initialize only: the direction the position block chose. */
  dir: N | null;
}

interface ValueCtx {
  sys: SystemProgram;
  shared: SharedUniforms;
  seed: N;
  p: ParticleVars | null;
  world: boolean;
}

const WIDTH: Record<string, number> = { float: 1, vec3: 3, color: 4 };

/** A var declared at this point of the shader (TSL declares a var where it is first used, which may be inside a branch). */
function declare(zero: N, init: N): N {
  const v = zero.toVar();
  v.assign(init);
  return v;
}

function splatConst(d: unknown, type: string): N {
  const w = WIDTH[type] ?? 1;
  if (Array.isArray(d)) {
    if (w === 4) return d.length === 3 ? vec4(d[0], d[1], d[2], 1) : vec4(d[0], d[1], d[2], d[3] ?? 1);
    if (w === 3) return vec3(d[0], d[1], d[2]);
    return float(d[0] ?? 0);
  }
  const n = typeof d === 'number' ? d : 0;
  return w === 1 ? float(n) : w === 3 ? vec3(n) : vec4(n, n, n, 1);
}

/** Convert between port types (float → vec3/colour splat, vec3 ↔ colour) — `convertValue`. */
function convert(v: N, from: string, to: string): N {
  if (from === to) return v;
  if (from === 'float') return to === 'color' ? vec4(v, v, v, 1) : vec3(v);
  if (from === 'vec3' && to === 'color') return vec4(v, 1);
  if (from === 'color' && to === 'vec3') return v.xyz;
  return v;
}

function normalizedAge(p: ParticleVars): N {
  return select(p.life.greaterThan(0), TSL.min(float(1), p.age.div(p.life)), float(1));
}

function cycleNormalized(s: SharedUniforms): N {
  return s.time.div(s.duration);
}

/** A value node's output as TSL (a fresh expression per use: attribute reads see the particle as it is now). */
function valueOf(ctx: ValueCtx, nodeId: string, portId: string): N {
  const n = ctx.sys.nodes.get(nodeId);
  if (n === undefined) return float(0);
  const out = n.ports.outputs.find((p) => p.id === portId);
  const type = out?.type ?? 'float';
  const f = n.fields;
  const input = (id: string): N => {
    const port = n.ports.inputs.find((p) => p.id === id);
    const w = n.wired[id];
    return w !== undefined ? wireValue(ctx, w) : splatConst(port?.default, port?.type ?? 'float');
  };
  const p = ctx.p;
  switch (n.type) {
    case 'value.float':
      return float(Number(f['value']));
    case 'value.vec3': {
      const v = f['value'] as number[];
      return vec3(v[0]!, v[1]!, v[2]!);
    }
    case 'value.color': {
      const c = hexLinear(String(f['color']), Number(f['alpha']));
      return vec4(c[0], c[1], c[2], c[3]);
    }
    case 'value.parameter': {
      const u = ctx.shared.params.get(String(f['key']));
      return u !== undefined ? u.node : splatConst(0, type);
    }
    case 'value.random':
      return float(Number(f['min'])).add(float(Number(f['max']) - Number(f['min'])).mul(hashFloat(ctx.seed, n.key)));
    case 'value.randomVec3': {
      const lo = f['min'] as number[];
      const hi = f['max'] as number[];
      const c = (a: number): N => float(lo[a]!).add(float(hi[a]! - lo[a]!).mul(hashFloat(ctx.seed, n.key, a + 1)));
      return vec3(c(0), c(1), c(2));
    }
    case 'value.curve':
    case 'value.gradient': {
      const src = f['input'];
      const t = src === 'random' ? hashFloat(ctx.seed, n.key) : src === 'effectTime' || p === null ? cycleNormalized(ctx.shared) : normalizedAge(p);
      return n.type === 'value.curve' ? curveNode(f['curve'] as number[], t) : gradientNode(f['gradient'] as number[], t);
    }
    case 'value.attribute': {
      if (p === null) return splatConst(0, type);
      switch (f['attribute']) {
        case 'position':
          return p.pos;
        case 'velocity':
          return p.vel;
        case 'age':
          return p.age;
        case 'normalizedAge':
          return normalizedAge(p);
        case 'lifetime':
          return p.life;
        case 'size':
          return p.size;
        case 'color':
          return p.color;
        case 'mass':
          return p.mass;
        case 'speed':
          return TSL.length(p.vel);
        default:
          return p.random;
      }
    }
    case 'value.time':
      return portId === 'normalized' ? cycleNormalized(ctx.shared) : ctx.shared.time;
    case 'math.add':
      return input('a').add(input('b'));
    case 'math.subtract':
      return input('a').sub(input('b'));
    case 'math.multiply':
      return input('a').mul(input('b'));
    case 'math.divide': {
      const a = input('a');
      const b = input('b');
      const w = WIDTH[type] ?? 1;
      const one = (x: N, y: N): N => select(y.equal(0), float(0), x.div(y));
      if (w === 1) return one(a, b);
      if (w === 3) return vec3(one(a.x, b.x), one(a.y, b.y), one(a.z, b.z));
      return vec4(one(a.x, b.x), one(a.y, b.y), one(a.z, b.z), one(a.w, b.w));
    }
    case 'math.min':
      return TSL.min(input('a'), input('b'));
    case 'math.max':
      return TSL.max(input('a'), input('b'));
    case 'math.lerp':
      return TSL.mix(input('a'), input('b'), input('t'));
    case 'math.oneMinus':
      return float(1).sub(input('in'));
    case 'math.sine':
      return TSL.sin(input('in'));
    case 'math.length':
      return TSL.length(input('in'));
    case 'math.normalize':
      return normalize0(input('in'));
    case 'math.combine':
      return vec3(input('x'), input('y'), input('z'));
    case 'math.split': {
      const v = input('in');
      return portId === 'x' ? v.x : portId === 'y' ? v.y : v.z;
    }
    default:
      return splatConst(0, type);
  }
}

function wireValue(ctx: ValueCtx, w: WireSource): N {
  return convert(valueOf(ctx, w.nodeId, w.portId), w.fromType, w.toType);
}

/** A block parameter: its wired input or its field. */
function num(ctx: ValueCtx, b: CompiledNode, key: string): N {
  const w = b.wired[key];
  if (w !== undefined) {
    const v = wireValue(ctx, w);
    return w.toType === 'float' ? v : v.x;
  }
  return float(Number(b.fields[key]));
}
function vecOf(ctx: ValueCtx, b: CompiledNode, key: string): N {
  const w = b.wired[key];
  if (w !== undefined) {
    const v = wireValue(ctx, w);
    return w.toType === 'color' ? v.xyz : w.toType === 'float' ? vec3(v) : v;
  }
  const v = b.fields[key] as number[];
  return vec3(v[0]!, v[1]!, v[2]!);
}
function colOf(ctx: ValueCtx, b: CompiledNode, key: string): N {
  const w = b.wired[key];
  if (w !== undefined) {
    const v = wireValue(ctx, w);
    return w.toType === 'color' ? v : w.toType === 'vec3' ? vec4(v, 1) : vec4(v, v, v, 1);
  }
  const c = hexLinear(String(b.fields[key]), b.fields['alpha'] !== undefined ? Number(b.fields['alpha']) : 1);
  return vec4(c[0], c[1], c[2], c[3]);
}

function axisBasis(axis: string): [N, N, N] {
  if (axis === 'x') return [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  if (axis === 'z') return [vec3(0, 0, 1), vec3(1, 0, 0), vec3(0, 1, 0)];
  return [vec3(0, 1, 0), vec3(1, 0, 0), vec3(0, 0, 1)];
}

/** One system on the GPU: its buffers, passes and uniforms. */
/**
 * What a batch's systems read of each slot (a play): its effect-wide values
 * (`shared(slot)`, as vars declared where it is called) and this system's
 * births this step (`spawn(slot)`), from the batch's slot table.
 */
export interface GpuSlotReader {
  shared(slot: N): SharedUniforms;
  /** The step's flags (0 idle, 1 step, 2 clear the slot first: `SLOT_FLAG_*`). */
  flags(slot: N): N;
  /** Births this step: count, first serial number and the origin spawn blocks' runs (start, count, distance). */
  spawn(slot: N, gpuIndex: number): { count: N; serialBase: N; runs: N[] };
}

/**
 * One system of an effect for every play of a batch: each play owns a slot
 * of `capacity` particles in the same buffers, and one dispatch steps every
 * slot (a thread per particle of every slot; idle slots return at once).
 */
export class GpuSystem {
  readonly capacity: number;
  readonly slots: number;
  readonly buffers: GpuParticleBuffers;
  readonly sortSize: number;
  readonly sorted: boolean;
  private readonly updatePass: N;
  private readonly spawnPass: N;
  private readonly sortFill: N | null;
  private readonly sortSteps: N[];
  readonly cameraPosition: N;
  readonly sortKeys: N | null;
  readonly sortIdx: N | null;
  /** The slot values of the pass being built (set at the start of each pass's function). */
  private shared!: SharedUniforms;

  constructor(
    readonly program: SystemProgram,
    private readonly reader: GpuSlotReader,
    /** This system's place among its effect's GPU systems (its row in the slot table). */
    private readonly gpuIndex: number,
    effectSeed: number,
    sorted: boolean,
    slots: number,
  ) {
    const C = program.capacity;
    this.capacity = C;
    this.slots = slots;
    const T = C * slots;
    const dead = new Uint32Array(T);
    for (let s = 0; s < slots; s++) for (let i = 0; i < C; i++) dead[s * C + i] = C - 1 - i;
    const deadCount = new Int32Array(slots).fill(C);
    const stateArray = new Float32Array(T * GPU_STATE_STRIDE * 4);
    // Every slot starts dead (massRand = mass 1, random 0, alive 0).
    for (let i = 0; i < T; i++) stateArray[(i * GPU_STATE_STRIDE + GPU_STATE_FIELDS.massRand) * 4] = 1;
    const state = instancedArray(stateArray, 'vec4');
    const field = (k: number): N => ({ element: (i: N): N => state.element(uint(i).mul(GPU_STATE_STRIDE).add(k)) });
    this.buffers = {
      state,
      posAge: field(GPU_STATE_FIELDS.posAge),
      velLife: field(GPU_STATE_FIELDS.velLife),
      color: field(GPU_STATE_FIELDS.color),
      baseColor: field(GPU_STATE_FIELDS.baseColor),
      sizeRot: field(GPU_STATE_FIELDS.sizeRot),
      massRand: field(GPU_STATE_FIELDS.massRand),
      serial: instancedArray(T, 'uint'),
      dead: instancedArray(dead, 'uint'),
      deadCount: instancedArray(deadCount, 'int').toAtomic(),
    };
    this.sorted = sorted && C <= GPU_SORT_LIMIT;
    this.sortSize = this.sorted ? 2 ** Math.ceil(Math.log2(Math.max(2, C))) : 0;
    this.sortKeys = this.sortSize > 0 ? instancedArray(this.sortSize * slots, 'float') : null;
    this.sortIdx = this.sortSize > 0 ? instancedArray(this.sortSize * slots, 'uint') : null;
    this.cameraPosition = uniform(new THREE.Vector3());
    this.updatePass = this.buildUpdate(effectSeed)().compute(T);
    this.spawnPass = this.buildSpawn(effectSeed)().compute(T);
    this.sortFill = this.sortSize > 0 ? this.buildSortFill()().compute(this.sortSize * slots) : null;
    this.sortSteps = [];
    for (let k = 2; k <= this.sortSize; k *= 2) {
      for (let j = k >> 1; j > 0; j >>= 1) this.sortSteps.push(this.buildSortStep(k, j)().compute(this.sortSize * slots));
    }
  }

  /** A pass's thread → its slot and the particle's index in the slot (`per` threads a slot). */
  private slotOf(per: number): { slot: N; local: N } {
    const slot = instanceIndex.div(uint(per)).toVar();
    return { slot, local: instanceIndex.sub(slot.mul(uint(per))).toVar() };
  }

  /**
   * A play's copy of its slot into draw buffers (in sorted order when sorted;
   * dead slots get size 0), as a pass of its own: each play draws from its
   * own buffers.
   */
  gatherInto(draw: { posAge: N; velLife: N; color: N; sizeRot: N }, slot: number): N {
    const b = this.buffers;
    const idx = this.sortIdx;
    const C = this.capacity;
    const base = uniform(slot * C, 'uint');
    const sortBase = uniform(slot * this.sortSize, 'uint');
    return Fn(() => {
      const i = instanceIndex;
      const g = base.add(idx !== null ? idx.element(sortBase.add(i)) : i).toVar();
      const alive = b.massRand.element(g).z.greaterThan(0.5);
      const sr = b.sizeRot.element(g).toVar();
      draw.posAge.element(i).assign(b.posAge.element(g));
      draw.velLife.element(i).assign(b.velLife.element(g));
      draw.color.element(i).assign(b.color.element(g));
      draw.sizeRot.element(i).assign(vec4(select(alive, sr.x, float(0)), sr.y, sr.z, sr.w));
    })().compute(C);
  }

  private world(): boolean {
    return this.program.space === 'world';
  }

  /** Clear one slot (thread `local` of it): every particle dead, the free list full. */
  private resetSlot(g: N, slot: N, local: N): void {
    const C = this.capacity;
    const b = this.buffers;
    b.massRand.element(g).assign(vec4(1, 0, 0, 0));
    b.dead.element(g).assign(uint(C - 1).sub(local));
    If(local.equal(uint(0)), () => {
      TSL.atomicStore(b.deadCount.element(slot), int(C));
    });
  }

  /** The world-space version of an effect-space point for this system (`simPoint`). */
  private simPoint(v: N): N {
    return this.world() ? toWorldPoint(this.shared.origin, v) : v;
  }
  private simDirection(d: N): N {
    return this.world() ? toWorldDirection(this.shared.origin, d) : normalize0(d);
  }
  private fromWorldVector(v: N): N {
    return this.world() ? v : toLocalVector(this.shared.origin, v);
  }
  private toWorldEventPoint(p: N): N {
    return this.world() ? p : toWorldPoint(this.shared.origin, p);
  }

  private buildUpdate(effectSeed: number): N {
    const b = this.buffers;
    const sys = this.program;
    const chain = sys.chains.update;
    const POST = new Set(['update.collide.plane', 'update.collide.depth', 'update.kill.plane', 'update.kill.sphere', 'update.kill.box', 'update.kill.speed']);
    return Fn(() => {
      const i = instanceIndex;
      const { slot, local } = this.slotOf(this.capacity);
      const sh = (this.shared = this.reader.shared(slot));
      const flags = this.reader.flags(slot).toVar();
      If(flags.greaterThan(SLOT_FLAG_STEP + 0.5), () => {
        this.resetSlot(i, slot, local);
      });
      const mr = b.massRand.element(i).toVar();
      If(flags.greaterThan(0.5).and(flags.lessThan(SLOT_FLAG_STEP + 0.5)).and(mr.z.greaterThan(0.5)), () => {
        const pa = b.posAge.element(i).toVar();
        const vl = b.velLife.element(i).toVar();
        const sr = b.sizeRot.element(i).toVar();
        // Declared here (not where first used, which may be inside a branch): the writes below read them.
        const bc = b.baseColor.element(i).toVar();
        const p: ParticleVars = {
          pos: declare(vec3(0), pa.xyz),
          vel: declare(vec3(0), vl.xyz),
          age: declare(float(0), pa.w.add(sh.dt)),
          life: declare(float(0), vl.w),
          baseColor: declare(vec4(0), bc),
          color: declare(vec4(0), bc),
          baseSize: declare(float(0), sr.y),
          size: declare(float(0), sr.y),
          rot: declare(float(0), sr.z),
          spin: declare(float(0), sr.w),
          mass: declare(float(0), mr.x),
          random: declare(float(0), mr.y),
          dir: null,
        };
        const killed = TSL.bool(false).toVar();
        If(p.age.greaterThanEqual(p.life), () => {
          killed.assign(true);
        }).Else(() => {
          const seed = hash32(uint(effectSeed >>> 0), uint(sys.index), b.serial.element(i)).toVar();
          const ctx: ValueCtx = { sys, shared: sh, seed, p, world: this.world() };
          const m = TSL.max(float(1e-4), p.mass);
          for (const blk of chain) if (!POST.has(blk.type)) this.applyUpdate(blk, ctx, m);
          p.pos.assign(p.pos.add(p.vel.mul(sh.dt)));
          p.rot.assign(p.rot.add(p.spin.mul(sh.dt)));
          for (const blk of chain) {
            if (!POST.has(blk.type)) continue;
            If(killed.not(), () => {
              this.applyPost(blk, ctx, killed);
            });
          }
          If(p.age.greaterThanEqual(p.life), () => {
            killed.assign(true);
          });
        });
        If(killed, () => {
          b.massRand.element(i).assign(vec4(p.mass, p.random, 0, 0));
          // The old count as a var: an atomic's result used inside another expression is evaluated again.
          const at = TSL.atomicAdd(b.deadCount.element(slot), int(1)).toVar();
          b.dead.element(slot.mul(uint(this.capacity)).add(uint(at))).assign(local);
        }).Else(() => {
          b.posAge.element(i).assign(vec4(p.pos, p.age));
          b.velLife.element(i).assign(vec4(p.vel, p.life));
          b.color.element(i).assign(p.color);
          b.sizeRot.element(i).assign(vec4(p.size, p.baseSize, p.rot, p.spin));
        });
      });
    });
  }

  private applyUpdate(blk: CompiledNode, ctx: ValueCtx, m: N): void {
    const p = ctx.p!;
    const sh = this.shared;
    const dt = sh.dt;
    switch (blk.type) {
      case 'update.gravity':
        p.vel.assign(p.vel.add(this.fromWorldVector(vecOf(ctx, blk, 'acceleration')).mul(dt)));
        return;
      case 'update.drag':
        p.vel.assign(p.vel.mul(TSL.exp(num(ctx, blk, 'coefficient').negate().mul(dt).div(m))));
        return;
      case 'update.wind': {
        const worldPos = this.toWorldEventPoint(p.pos);
        const w = sh.wind;
        const gust = float(0.5).add(float(0.5).mul(TSL.sin(sh.worldTime.mul(w.freq).mul(6.2831853).sub(worldPos.x.mul(0.08).mul(float(1).add(w.turb.mul(3)))))));
        const windV = this.fromWorldVector(w.dir.mul(w.strength.add(w.gust.mul(gust))));
        const f = float(1).sub(TSL.exp(num(ctx, blk, 'influence').negate().mul(dt).div(m)));
        p.vel.assign(p.vel.add(windV.sub(p.vel).mul(f)));
        return;
      }
      case 'update.vortex': {
        const c = this.simPoint(vecOf(ctx, blk, 'center'));
        const axis = this.simDirection(vecOf(ctx, blk, 'axis')).toVar();
        const r = p.pos.sub(c).toVar();
        const radial = r.sub(axis.mul(TSL.dot(r, axis))).toVar();
        const tangent = normalize0(TSL.cross(axis, radial));
        const inward = normalize0(radial).negate();
        const a = tangent.mul(num(ctx, blk, 'strength')).add(inward.mul(num(ctx, blk, 'pull')));
        p.vel.assign(p.vel.add(a.mul(dt.div(m))));
        return;
      }
      case 'update.turbulence': {
        const freq = num(ctx, blk, 'frequency');
        const scroll = sh.time.mul(num(ctx, blk, 'speed'));
        const q = vec3(p.pos.x.mul(freq), p.pos.y.mul(freq).add(scroll), p.pos.z.mul(freq)).toVar();
        const c = new TslNoise(sh.perm).curl(q, Math.round(Number(blk.fields['octaves'])));
        p.vel.assign(p.vel.add(c.mul(num(ctx, blk, 'strength').mul(dt).div(m))));
        return;
      }
      case 'update.attractor': {
        const target = this.simPoint(vecOf(ctx, blk, 'position'));
        const d = target.sub(p.pos).toVar();
        const dist = TSL.length(d).toVar();
        const radius = num(ctx, blk, 'radius').toVar();
        If(dist.greaterThanEqual(1e-6).and(radius.lessThanEqual(0).or(dist.lessThanEqual(radius))), () => {
          p.vel.assign(p.vel.add(d.mul(num(ctx, blk, 'strength').mul(dt).div(m.mul(dist)))));
        });
        return;
      }
      case 'update.size.curve':
        p.size.assign(p.baseSize.mul(curveNode(blk.fields['curve'] as number[], normalizedAge(p))));
        return;
      case 'update.color.gradient': {
        const g = gradientNode(blk.fields['gradient'] as number[], normalizedAge(p));
        p.color.assign(blk.fields['mode'] === 'set' ? g : p.color.mul(g));
        return;
      }
      case 'update.velocity.curve': {
        const cap = curveNode(blk.fields['curve'] as number[], normalizedAge(p)).toVar();
        const s = TSL.length(p.vel).toVar();
        If(s.greaterThan(cap), () => {
          p.vel.assign(p.vel.mul(cap.div(s)));
        });
        return;
      }
      default:
        return;
    }
  }

  private applyPost(blk: CompiledNode, ctx: ValueCtx, killed: N): void {
    const p = ctx.p!;
    switch (blk.type) {
      case 'update.collide.plane': {
        const point = this.simPoint(vecOf(ctx, blk, 'point'));
        const n = this.simDirection(vecOf(ctx, blk, 'normal')).toVar();
        const d = TSL.dot(p.pos.sub(point), n).toVar();
        If(d.lessThan(0), () => {
          p.pos.assign(p.pos.sub(n.mul(d)));
          const vn = TSL.dot(p.vel, n).toVar();
          If(vn.lessThan(0), () => {
            const tangential = p.vel.sub(n.mul(vn));
            p.vel.assign(tangential.mul(float(1).sub(num(ctx, blk, 'friction'))).add(n.mul(vn.negate().mul(num(ctx, blk, 'bounce')))));
          });
          if (blk.fields['kill'] === true) killed.assign(true);
          const loss = Number(blk.fields['lifetimeLoss']);
          if (loss > 0) p.age.assign(p.age.add(p.life.mul(loss)));
        });
        return;
      }
      case 'update.collide.depth':
        this.depthCollision(blk, ctx, killed);
        return;
      case 'update.kill.plane': {
        const point = this.simPoint(vecOf(ctx, blk, 'point'));
        const n = this.simDirection(vecOf(ctx, blk, 'normal'));
        If(TSL.dot(p.pos.sub(point), n).lessThan(0), () => {
          killed.assign(true);
        });
        return;
      }
      case 'update.kill.sphere': {
        const c = this.simPoint(vecOf(ctx, blk, 'center'));
        const inside = TSL.length(p.pos.sub(c)).lessThan(num(ctx, blk, 'radius'));
        If(blk.fields['mode'] === 'outside' ? inside.not() : inside, () => {
          killed.assign(true);
        });
        return;
      }
      case 'update.kill.box': {
        const local = this.world() ? toLocalPoint(this.shared.origin, p.pos) : p.pos;
        const c = vecOf(ctx, blk, 'center');
        const half = vecOf(ctx, blk, 'size').mul(0.5);
        const q = TSL.abs(local.sub(c)).toVar();
        const inside = q.x.lessThanEqual(half.x).and(q.y.lessThanEqual(half.y)).and(q.z.lessThanEqual(half.z));
        If(blk.fields['mode'] === 'inside' ? inside : inside.not(), () => {
          killed.assign(true);
        });
        return;
      }
      case 'update.kill.speed':
        If(TSL.length(p.vel).lessThan(num(ctx, blk, 'speed')), () => {
          killed.assign(true);
        });
        return;
      default:
        return;
    }
  }

  /**
   * Scene-depth collision: the particle's world position projected with the
   * view-projection of the last depth pre-pass; a particle behind the
   * visible surface by less than `thickness` is pushed back onto it along the
   * view ray and bounces off the surface normal rebuilt from neighbouring
   * depth samples.
   */
  private depthCollision(blk: CompiledNode, ctx: ValueCtx, killed: N): void {
    const d = this.shared.depth;
    if (!d.enabled || d.texture === null) return;
    const p = ctx.p!;
    const world = this.toWorldEventPoint(p.pos).toVar();
    const clip = d.viewProj.mul(vec4(world, 1)).toVar();
    If(clip.w.greaterThan(0), () => {
      const ndc = clip.xyz.div(clip.w).toVar();
      If(TSL.abs(ndc.x).lessThan(1).and(TSL.abs(ndc.y).lessThan(1)), () => {
        const uv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).toVar();
        const px = TSL.ivec2(uv.mul(d.size)).toVar();
        const viewZAt = (q: N): N => TSL.perspectiveDepthToViewZ(float(TSL.textureLoad(d.texture, q).x), d.near, d.far);
        const sceneZ = viewZAt(px).toVar();
        const partZ = d.view.mul(vec4(world, 1)).z.toVar();
        const thickness = Number(blk.fields['thickness']);
        // Behind the surface (further from the camera) by less than the thickness.
        If(partZ.lessThan(sceneZ).and(partZ.greaterThan(sceneZ.sub(thickness))), () => {
          const vx = viewZAt(px.add(TSL.ivec2(1, 0))).sub(sceneZ);
          const vy = viewZAt(px.add(TSL.ivec2(0, 1))).sub(sceneZ);
          // A view-space normal from the depth gradient, then world space (the view matrix's inverse rotation).
          const nView = normalize0(vec3(vx.negate(), vy, float(0.02)));
          const nWorld = normalize0(TSL.transpose(TSL.mat3(d.view)).mul(nView));
          const n = this.world() ? nWorld : normalize0(toLocalVector(this.shared.origin, nWorld));
          p.pos.assign(p.pos.add(n.mul(sceneZ.sub(partZ))));
          const vn = TSL.dot(p.vel, n).toVar();
          If(vn.lessThan(0), () => {
            const tangential = p.vel.sub(n.mul(vn));
            p.vel.assign(tangential.mul(float(1).sub(num(ctx, blk, 'friction'))).add(n.mul(vn.negate().mul(num(ctx, blk, 'bounce')))));
          });
          if (blk.fields['kill'] === true) killed.assign(true);
        });
      });
    });
  }

  private buildSpawn(effectSeed: number): N {
    const b = this.buffers;
    const sys = this.program;
    const world = this.world();
    const C = this.capacity;
    return Fn(() => {
      const { slot: at, local: k } = this.slotOf(C);
      const sh = (this.shared = this.reader.shared(at));
      const plan = this.reader.spawn(at, this.gpuIndex);
      If(float(k).lessThan(plan.count), () => {
        const old = TSL.atomicSub(b.deadCount.element(at), int(1)).toVar();
        If(old.lessThanEqual(int(0)), () => {
          TSL.atomicAdd(b.deadCount.element(at), int(1));
        }).Else(() => {
          const slot = at.mul(uint(C)).add(b.dead.element(at.mul(uint(C)).add(uint(old.sub(int(1)))))).toVar();
          const serial = plan.serialBase.add(k).toVar();
          const seed = hash32(uint(effectSeed >>> 0), uint(sys.index), serial).toVar();
          // Where along the path moved this step the birth is (distance runs), else at the origin.
          const t = float(1).toVar();
          for (const r of plan.runs) {
            If(r.z.greaterThan(0.5).and(float(k).greaterThanEqual(r.x)).and(float(k).lessThan(r.x.add(r.y))), () => {
              t.assign(float(k).sub(r.x).add(1).div(r.y));
            });
          }
          const base = world ? TSL.mix(sh.prevPosition, sh.origin.position, t) : vec3(0);
          const p: ParticleVars = {
            pos: declare(vec3(0), base),
            vel: declare(vec3(0), vec3(0)),
            age: declare(float(0), float(0)),
            life: declare(float(0), float(1)),
            baseColor: declare(vec4(0), vec4(1, 1, 1, 1)),
            color: declare(vec4(0), vec4(1, 1, 1, 1)),
            baseSize: declare(float(0), float(0.1)),
            size: declare(float(0), float(0.1)),
            rot: declare(float(0), float(0)),
            spin: declare(float(0), float(0)),
            mass: declare(float(0), float(1)),
            random: declare(float(0), hashFloat(seed, 0x51)),
            dir: declare(vec3(0), vec3(0, 1, 0)),
          };
          const rng = new TslRng(seed);
          const ctx: ValueCtx = { sys, shared: sh, seed, p, world };
          for (const blk of sys.chains.initialize) this.applyInit(blk, ctx, rng);
          b.posAge.element(slot).assign(vec4(p.pos, 0));
          b.velLife.element(slot).assign(vec4(p.vel, p.life));
          b.color.element(slot).assign(p.baseColor);
          b.baseColor.element(slot).assign(p.baseColor);
          b.sizeRot.element(slot).assign(vec4(p.baseSize, p.baseSize, p.rot, p.spin));
          b.massRand.element(slot).assign(vec4(p.mass, p.random, 1, 0));
          b.serial.element(slot).assign(serial);
        });
      });
    });
  }

  private applyInit(blk: CompiledNode, ctx: ValueCtx, rng: TslRng): void {
    const p = ctx.p!;
    const o = this.shared.origin;
    const offset = (v: N): void => {
      p.pos.assign(p.pos.add(ctx.world ? toWorldVector(o, v) : v));
    };
    const addVelocity = (v: N): void => {
      p.vel.assign(p.vel.add(ctx.world ? toWorldVector(o, v) : v));
    };
    const TAU = Math.PI * 2;
    switch (blk.type) {
      case 'init.position.point':
        offset(vecOf(ctx, blk, 'offset'));
        p.dir!.assign(vec3(0, 1, 0));
        return;
      case 'init.position.sphere': {
        const z = rng.next().mul(2).sub(1).toVar();
        const phi = rng.next().mul(TAU).toVar();
        const rr = TSL.sqrt(TSL.max(float(0), float(1).sub(z.mul(z))));
        const d = vec3(rr.mul(TSL.cos(phi)), z, rr.mul(TSL.sin(phi))).toVar();
        const r = blk.fields['surface'] === true ? num(ctx, blk, 'radius') : num(ctx, blk, 'radius').mul(TSL.pow(rng.next(), 1 / 3));
        offset(vecOf(ctx, blk, 'center').add(d.mul(r)));
        p.dir!.assign(d);
        return;
      }
      case 'init.position.box': {
        const c = vecOf(ctx, blk, 'center');
        const s = vecOf(ctx, blk, 'size').toVar();
        const ux = rng.next().sub(0.5).toVar();
        const uy = rng.next().sub(0.5).toVar();
        const uz = rng.next().sub(0.5).toVar();
        if (blk.fields['surface'] === true) {
          // A face picked by its area (the reference's order: −x, +x, −y, +y, −z, +z), then the point on it.
          const areas = [s.y.mul(s.z), s.y.mul(s.z), s.x.mul(s.z), s.x.mul(s.z), s.x.mul(s.y), s.x.mul(s.y)];
          const total = areas.reduce((a: N, x: N) => a.add(x));
          const pick = rng.next().mul(total).toVar();
          const face = int(0).toVar();
          for (let f = 0; f < 5; f++) {
            If(face.equal(f).and(pick.greaterThanEqual(areas[f])), () => {
              pick.assign(pick.sub(areas[f]));
              face.assign(f + 1);
            });
          }
          const side = select(face.bitAnd(1).equal(0), float(-0.5), float(0.5));
          const axis = face.shiftRight(1);
          ux.assign(select(axis.equal(0), side, ux));
          uy.assign(select(axis.equal(1), side, uy));
          uz.assign(select(axis.equal(2), side, uz));
        }
        offset(vec3(c.x.add(ux.mul(s.x)), c.y.add(uy.mul(s.y)), c.z.add(uz.mul(s.z))));
        p.dir!.assign(vec3(0, 1, 0));
        return;
      }
      case 'init.position.circle': {
        const [, e1, e2] = axisBasis(String(blk.fields['axis']));
        const th = rng.next().mul(TAU).toVar();
        const r = blk.fields['edge'] === true ? num(ctx, blk, 'radius') : num(ctx, blk, 'radius').mul(TSL.sqrt(rng.next()));
        const radial = e1.mul(TSL.cos(th)).add(e2.mul(TSL.sin(th))).toVar();
        offset(vecOf(ctx, blk, 'center').add(radial.mul(r)));
        p.dir!.assign(radial);
        return;
      }
      case 'init.position.cone': {
        const [a, e1, e2] = axisBasis(String(blk.fields['axis']));
        const th = rng.next().mul(TAU).toVar();
        const r = num(ctx, blk, 'radius').mul(TSL.sqrt(rng.next())).toVar();
        offset(vecOf(ctx, blk, 'center').add(e1.mul(r.mul(TSL.cos(th))).add(e2.mul(r.mul(TSL.sin(th))))));
        const angle = num(ctx, blk, 'angle').mul(Math.PI / 180);
        const cosT = float(1).sub(rng.next().mul(float(1).sub(TSL.cos(angle)))).toVar();
        const sinT = TSL.sqrt(TSL.max(float(0), float(1).sub(cosT.mul(cosT)))).toVar();
        const phi = rng.next().mul(TAU).toVar();
        p.dir!.assign(a.mul(cosT).add(e1.mul(sinT.mul(TSL.cos(phi))).add(e2.mul(sinT.mul(TSL.sin(phi))))));
        return;
      }
      case 'init.position.line': {
        const s = vecOf(ctx, blk, 'start');
        offset(TSL.mix(s, vecOf(ctx, blk, 'end'), rng.next()));
        p.dir!.assign(vec3(0, 1, 0));
        return;
      }
      case 'init.velocity': {
        const lo = vecOf(ctx, blk, 'min').toVar();
        const hi = vecOf(ctx, blk, 'max').toVar();
        const x = rng.range(lo.x, hi.x).toVar();
        const y = rng.range(lo.y, hi.y).toVar();
        const z = rng.range(lo.z, hi.z).toVar();
        addVelocity(vec3(x, y, z));
        return;
      }
      case 'init.velocity.direction':
        addVelocity(normalize0(p.dir!).mul(rng.range(num(ctx, blk, 'speedMin'), num(ctx, blk, 'speedMax'))));
        return;
      case 'init.lifetime':
        p.life.assign(TSL.max(float(1e-3), rng.range(num(ctx, blk, 'min'), num(ctx, blk, 'max'))));
        return;
      case 'init.size': {
        const s = TSL.max(float(0), rng.range(num(ctx, blk, 'min'), num(ctx, blk, 'max'))).toVar();
        p.baseSize.assign(s);
        p.size.assign(s);
        return;
      }
      case 'init.color': {
        const c = colOf(ctx, blk, 'color').toVar();
        p.baseColor.assign(c);
        p.color.assign(c);
        return;
      }
      case 'init.color.gradient': {
        const c = gradientNode(blk.fields['gradient'] as number[], rng.next()).toVar();
        p.baseColor.assign(c);
        p.color.assign(c);
        return;
      }
      case 'init.rotation': {
        const angle = rng.range(num(ctx, blk, 'angleMin'), num(ctx, blk, 'angleMax')).toVar();
        const spin = rng.range(num(ctx, blk, 'spinMin'), num(ctx, blk, 'spinMax')).toVar();
        p.rot.assign(angle);
        p.spin.assign(spin);
        return;
      }
      case 'init.mass':
        p.mass.assign(TSL.max(float(1e-4), rng.range(num(ctx, blk, 'min'), num(ctx, blk, 'max'))));
        return;
      default:
        return;
    }
  }

  /** Sort keys: the view distance of living particles (negated: farthest first), dead slots last; each slot sorts its own segment. */
  private buildSortFill(): N {
    const b = this.buffers;
    const C = this.capacity;
    const keys = this.sortKeys!;
    const idx = this.sortIdx!;
    return Fn(() => {
      const i = instanceIndex;
      const { slot, local } = this.slotOf(this.sortSize);
      this.shared = this.reader.shared(slot);
      idx.element(i).assign(local);
      If(local.lessThan(uint(C)), () => {
        const g = slot.mul(uint(C)).add(local);
        const alive = b.massRand.element(g).z.greaterThan(0.5);
        const world = this.toWorldEventPoint(b.posAge.element(g).xyz);
        keys.element(i).assign(select(alive, TSL.length(world.sub(this.cameraPosition)).negate(), float(3.0e38)));
      }).Else(() => {
        keys.element(i).assign(float(3.4e38));
      });
    });
  }

  /**
   * One bitonic compare-exchange step in every slot's segment (j < the
   * segment: partners stay in it). Each step is a node of its own with its
   * own k and j (the same shader), so a whole sort is one compute call: a
   * uniform changed between dispatches of one call would reach the GPU only
   * with its last value.
   */
  private buildSortStep(sortK: number, sortJ: number): N {
    const keys = this.sortKeys!;
    const idx = this.sortIdx!;
    const mask = this.sortSize - 1;
    const k = uniform(sortK, 'uint');
    const j = uniform(sortJ, 'uint');
    return Fn(() => {
      const i = instanceIndex;
      const l = i.bitXor(j).toVar();
      If(l.greaterThan(i), () => {
        // The direction from the index in the segment: a whole segment (k = its size) sorts ascending in every slot.
        const ascending = i.bitAnd(uint(mask)).bitAnd(k).equal(uint(0));
        const ki = keys.element(i).toVar();
        const kl = keys.element(l).toVar();
        If(ascending.and(ki.greaterThan(kl)).or(ascending.not().and(ki.lessThan(kl))), () => {
          const ii = idx.element(i).toVar();
          keys.element(i).assign(kl);
          keys.element(l).assign(ki);
          idx.element(i).assign(idx.element(l));
          idx.element(l).assign(ii);
        });
      });
    });
  }

  /** The step's passes over every slot: update (and clears), then the planned births. */
  stepPasses(): N[] {
    return [this.updatePass, this.spawnPass];
  }

  /** The passes that sort every slot back to front for this camera (alpha-blended outputs; none when unsorted), in order. */
  sortPasses(camera: THREE.Vector3): N[] {
    if (this.sortFill === null) return [];
    (this.cameraPosition.value as THREE.Vector3).copy(camera);
    return [this.sortFill, ...this.sortSteps];
  }

  dispose(renderer?: THREE.WebGPURenderer | null): void {
    for (const n of [this.updatePass, this.spawnPass, this.sortFill, ...this.sortSteps]) n?.dispose?.();
    const buffers = [this.buffers.state, this.buffers.serial, this.buffers.dead, this.buffers.deadCount, this.sortKeys, this.sortIdx].map((b) => (b as N | null)?.value ?? null);
    for (const b of buffers) b?.dispose?.();
    releaseStorage(renderer, buffers);
  }
}
