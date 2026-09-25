/**
 * Phase 20.1: the CPU reference evaluator of effect graphs.
 *
 * One `EffectInstance` simulates one playing effect: every system keeps its
 * particles in typed arrays (structure of arrays, `capacity` slots, living
 * particles packed at the front; a dead particle is replaced by the last
 * one). Each `step(dt)`, system by system in the effect's order:
 *
 * 1. Update the living particles: age += dt (a particle whose age reaches
 *    its lifetime dies); size and colour restart from their initial values;
 *    the Update chain's force and over-life blocks run in chain order; the
 *    position moves (explicit Euler: p += v·dt) and the rotation spins; then
 *    the collision and kill blocks run in chain order.
 * 2. Spawn: the Spawn chain's blocks add up (constant rate with the
 *    fraction carried over, bursts at their cycle times, particles per metre
 *    the origin moved, and particles per event of another system); new
 *    particles run the Initialize chain and are drawn at their birth state.
 *
 * Events (death, birth, collision) of a system reach the systems after it
 * in the same step and the ones before it (or itself) in the next step.
 *
 * Determinism: all randomness is hashed from the effect seed, the system
 * index and each particle's serial number; the same effect, seed, options
 * and step sequence give bit-identical particles. Effects are visual only:
 * nothing here is read back by the game simulation.
 */
import { DEFAULT_WIND, type EffectDef, type GraphValue, type WindConfig } from '@thirdlight/project-model';

import { evalCurve, evalGradient, hexToLinear } from './curves';
import {
  add,
  cross,
  dot,
  IDENTITY_ORIGIN,
  length,
  lerp3,
  normalize,
  scale,
  sub,
  toLocalPoint,
  toLocalVector,
  toWorldDirection,
  toWorldPoint,
  toWorldVector,
  type EffectOrigin,
  type Vec3,
  type Vec4,
} from './math';
import { GradientNoise } from './noise';
import { compileEffect, POST_INTEGRATION_BLOCKS, type CompiledNode, type CompileOptions, type EffectDiagnostic, type EffectProgram, type SystemProgram } from './program';
import { hash32, hashFloat, Rng } from './rng';

/** A triangle mesh of a model asset (the Mesh surface position block samples it). */
export interface EffectMesh {
  /** x, y, z per vertex. */
  positions: Float32Array | readonly number[];
  /** Three vertex indices per triangle (absent: consecutive vertex triples). */
  indices?: Uint32Array | Uint16Array | readonly number[];
}

export interface EffectInstanceOptions extends CompileOptions {
  /** Overrides of public parameters (private keys are ignored). */
  params?: Readonly<Record<string, number | number[] | string>>;
  /** The global wind the Wind block follows (absent: the engine default). */
  wind?: WindConfig;
  /** The mesh of a model asset (absent or null: Mesh surface blocks add nothing). */
  mesh?: (assetId: string) => EffectMesh | null;
}

export interface StepInput {
  /** Where the effect is this step (absent: where it was; initially the world origin). */
  origin?: EffectOrigin;
  /** Seconds of game time for the wind's gusts (absent: the effect's own time). */
  worldTime?: number;
}

/** What an event carries to the systems that spawn from it (world space, linear colour). */
export interface EffectEvent {
  position: Vec3;
  velocity: Vec3;
  color: Vec4;
}

type EventKind = 'death' | 'birth' | 'collision';

/** One system's particles (structure of arrays; the first `count` slots are alive). */
export class SystemState {
  readonly capacity: number;
  count = 0;
  /** Simulation space: effect space for a local system, world space for a world system. */
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  /** Current colour (linear RGBA) and the initial one it restarts from each step. */
  readonly color: Float32Array;
  readonly baseColor: Float32Array;
  readonly size: Float32Array;
  readonly baseSize: Float32Array;
  readonly age: Float32Array;
  readonly lifetime: Float32Array;
  /** Degrees and degrees per second. */
  readonly rotation: Float32Array;
  readonly spin: Float32Array;
  readonly mass: Float32Array;
  /** A fixed random number per particle (0–1). */
  readonly random: Float32Array;
  /** Birth order within the system (ribbons join particles in this order). */
  readonly serial: Uint32Array;
  /** Trail points per particle (newest first), when an Output ribbon draws trails. */
  readonly trail: Float32Array | null;
  readonly trailCount: Uint8Array | null;
  readonly trailTimer: Float32Array | null;
  readonly trailSegments: number;
  /** Events raised this step. */
  events: Record<EventKind, EffectEvent[]> = { death: [], birth: [], collision: [] };
  /** Events raised in the previous step (read by this system and those before it). */
  lastEvents: Record<EventKind, EffectEvent[]> = { death: [], birth: [], collision: [] };
  rateCarry = 0;
  distanceCarry = 0;
  nextSerial = 0;

  constructor(readonly program: SystemProgram) {
    const c = program.capacity;
    this.capacity = c;
    this.position = new Float32Array(c * 3);
    this.velocity = new Float32Array(c * 3);
    this.color = new Float32Array(c * 4);
    this.baseColor = new Float32Array(c * 4);
    this.size = new Float32Array(c);
    this.baseSize = new Float32Array(c);
    this.age = new Float32Array(c);
    this.lifetime = new Float32Array(c);
    this.rotation = new Float32Array(c);
    this.spin = new Float32Array(c);
    this.mass = new Float32Array(c);
    this.random = new Float32Array(c);
    this.serial = new Uint32Array(c);
    this.trailSegments = program.trail?.segments ?? 0;
    this.trail = program.trail !== null ? new Float32Array(c * this.trailSegments * 3) : null;
    this.trailCount = program.trail !== null ? new Uint8Array(c) : null;
    this.trailTimer = program.trail !== null ? new Float32Array(c) : null;
  }

  get3(a: Float32Array, i: number): Vec3 {
    return [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
  }
  set3(a: Float32Array, i: number, v: Vec3): void {
    a[i * 3] = v[0];
    a[i * 3 + 1] = v[1];
    a[i * 3 + 2] = v[2];
  }
  get4(a: Float32Array, i: number): Vec4 {
    return [a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!, a[i * 4 + 3]!];
  }
  set4(a: Float32Array, i: number, v: Vec4): void {
    a[i * 4] = v[0];
    a[i * 4 + 1] = v[1];
    a[i * 4 + 2] = v[2];
    a[i * 4 + 3] = v[3];
  }

  /** Move particle `from` into slot `to` (every attribute). */
  copy(from: number, to: number): void {
    for (const a of [this.position, this.velocity]) a.copyWithin(to * 3, from * 3, from * 3 + 3);
    for (const a of [this.color, this.baseColor]) a.copyWithin(to * 4, from * 4, from * 4 + 4);
    for (const a of [this.size, this.baseSize, this.age, this.lifetime, this.rotation, this.spin, this.mass, this.random]) a[to] = a[from]!;
    this.serial[to] = this.serial[from]!;
    if (this.trail !== null) {
      const s = this.trailSegments * 3;
      this.trail.copyWithin(to * s, from * s, from * s + s);
      this.trailCount![to] = this.trailCount![from]!;
      this.trailTimer![to] = this.trailTimer![from]!;
    }
  }

  /** Remove particle i (the last one takes its slot). */
  remove(i: number): void {
    this.count -= 1;
    if (i !== this.count) this.copy(this.count, i);
  }

  clear(): void {
    this.count = 0;
    this.rateCarry = 0;
    this.distanceCarry = 0;
    this.nextSerial = 0;
    this.events = { death: [], birth: [], collision: [] };
    this.lastEvents = { death: [], birth: [], collision: [] };
  }
}

type Val = number[];
const WIDTH: Record<string, number> = { float: 1, vec3: 3, color: 4 };

/** Convert a value between port types (float → vec3/colour splat, vec3 ↔ colour). */
export function convertValue(v: Val, from: string, to: string): Val {
  if (from === to) return v;
  if (from === 'float') return to === 'color' ? [v[0]!, v[0]!, v[0]!, 1] : [v[0]!, v[0]!, v[0]!];
  if (from === 'vec3' && to === 'color') return [v[0]!, v[1]!, v[2]!, 1];
  if (from === 'color' && to === 'vec3') return [v[0]!, v[1]!, v[2]!];
  return v;
}

const splat = (d: GraphValue | undefined, width: number): Val => {
  if (Array.isArray(d)) return width === 4 && d.length === 3 ? [...d, 1] : [...d];
  const n = typeof d === 'number' ? d : 0;
  return width === 1 ? [n] : width === 3 ? [n, n, n] : [n, n, n, 1];
};

interface EvalCtx {
  sys: SystemState;
  /** Particle slot, or -1 in Spawn. */
  p: number;
  /** The particle's seed (or the step's seed in Spawn): per-node random values hash from it. */
  seed: number;
}

/** A playing effect on the CPU. */
export class EffectInstance {
  readonly program: EffectProgram;
  readonly systems: SystemState[];
  /** Seconds since the effect (re)started. */
  time = 0;
  /** Steps since the effect (re)started. */
  stepIndex = 0;
  /** Spawning on (stop() ends it; living particles finish their lives). */
  playing = true;
  private origin: EffectOrigin = IDENTITY_ORIGIN;
  private worldTime = 0;
  private readonly params = new Map<string, Val>();
  private readonly noise: GradientNoise;
  private readonly wind: WindConfig;
  private readonly meshCache = new Map<string, { pos: number[]; tris: number[]; cumulative: number[] } | null>();

  constructor(
    readonly effect: EffectDef,
    private readonly options: EffectInstanceOptions = {},
  ) {
    this.program = compileEffect(effect, options);
    this.systems = this.program.systems.map((s) => new SystemState(s));
    this.noise = new GradientNoise(effect.seed);
    this.wind = options.wind ?? DEFAULT_WIND;
    for (const p of effect.parameters ?? []) {
      const o = options.params?.[p.key];
      const v = o !== undefined && p.visibility !== 'private' ? o : p.default;
      this.params.set(p.key, p.type === 'color' ? hexToLinear(String(v)) : Array.isArray(v) ? [...v] : [Number(v)]);
    }
  }

  get diagnostics(): readonly EffectDiagnostic[] {
    return this.program.diagnostics;
  }

  /** True while it spawns or has living particles. */
  get alive(): boolean {
    return this.spawning() || this.systems.some((s) => s.count > 0);
  }

  /** Starts spawning again from the effect's current time. */
  play(): void {
    this.playing = true;
  }
  /** Stops spawning; living particles finish their lives. */
  stop(): void {
    this.playing = false;
  }
  /** Clears every particle and starts over: the same seed gives the same particles again. */
  restart(): void {
    for (const s of this.systems) s.clear();
    this.time = 0;
    this.stepIndex = 0;
    this.playing = true;
  }

  private spawning(): boolean {
    return this.playing && (this.effect.loop || this.time < this.effect.duration);
  }

  /** The effect time within the current cycle. */
  cycleTime(): number {
    const d = this.effect.duration;
    return this.effect.loop ? this.time % d : Math.min(this.time, d);
  }

  step(dt: number, input: StepInput = {}): void {
    if (!(dt > 0)) return;
    const prev = this.origin;
    if (input.origin !== undefined) this.origin = input.origin;
    this.worldTime = input.worldTime ?? this.time;
    const t0 = this.time;
    const t1 = t0 + dt;
    for (const s of this.systems) {
      s.lastEvents = s.events;
      s.events = { death: [], birth: [], collision: [] };
    }
    this.systems.forEach((s, i) => {
      this.update(s, dt);
      this.spawn(s, i, t0, t1, dt, prev);
    });
    this.time = t1;
    this.stepIndex += 1;
  }

  // ---- values ---------------------------------------------------------------------------------

  private value(ctx: EvalCtx, nodeId: string, portId: string): Val {
    const n = ctx.sys.program.nodes.get(nodeId);
    if (n === undefined) return [0];
    const out = n.ports.outputs.find((p) => p.id === portId);
    const width = WIDTH[out?.type ?? 'float'] ?? 1;
    const f = n.fields;
    const input = (id: string): Val => {
      const port = n.ports.inputs.find((p) => p.id === id);
      const w = WIDTH[port?.type ?? 'float'] ?? 1;
      const wire = n.wired[id];
      return wire !== undefined ? convertValue(this.value(ctx, wire.nodeId, wire.portId), wire.fromType, wire.toType) : splat(port?.default, w);
    };
    const p = ctx.p;
    const sys = ctx.sys;
    switch (n.type) {
      case 'value.float':
        return [Number(f['value'])];
      case 'value.vec3':
        return [...(f['value'] as number[])];
      case 'value.color':
        return hexToLinear(String(f['color']), Number(f['alpha']));
      case 'value.parameter': {
        const v = this.params.get(String(f['key']));
        return v !== undefined ? [...v] : splat(0, width);
      }
      case 'value.random':
        return [Number(f['min']) + (Number(f['max']) - Number(f['min'])) * hashFloat(ctx.seed, n.key)];
      case 'value.randomVec3': {
        const lo = f['min'] as number[];
        const hi = f['max'] as number[];
        return [0, 1, 2].map((a) => lo[a]! + (hi[a]! - lo[a]!) * hashFloat(ctx.seed, n.key, a + 1));
      }
      case 'value.curve':
      case 'value.gradient': {
        const src = f['input'];
        const t = src === 'random' ? hashFloat(ctx.seed, n.key) : src === 'effectTime' || p < 0 ? this.cycleTime() / this.effect.duration : this.normalizedAge(sys, p);
        return n.type === 'value.curve' ? [evalCurve(f['curve'] as number[], t)] : evalGradient(f['gradient'] as number[], t);
      }
      case 'value.attribute': {
        if (p < 0) return splat(0, width);
        switch (f['attribute']) {
          case 'position':
            return sys.get3(sys.position, p);
          case 'velocity':
            return sys.get3(sys.velocity, p);
          case 'age':
            return [sys.age[p]!];
          case 'normalizedAge':
            return [this.normalizedAge(sys, p)];
          case 'lifetime':
            return [sys.lifetime[p]!];
          case 'size':
            return [sys.size[p]!];
          case 'color':
            return sys.get4(sys.color, p);
          case 'mass':
            return [sys.mass[p]!];
          case 'speed':
            return [length(sys.get3(sys.velocity, p))];
          default:
            return [sys.random[p]!];
        }
      }
      case 'value.time':
        return portId === 'normalized' ? [this.cycleTime() / this.effect.duration] : [this.cycleTime()];
      case 'math.add':
      case 'math.subtract':
      case 'math.multiply':
      case 'math.divide':
      case 'math.min':
      case 'math.max': {
        const a = input('a');
        const b = input('b');
        return a.map((x, i) => {
          const y = b[i] ?? b[0]!;
          switch (n.type) {
            case 'math.add':
              return x + y;
            case 'math.subtract':
              return x - y;
            case 'math.multiply':
              return x * y;
            case 'math.divide':
              return y !== 0 ? x / y : 0;
            case 'math.min':
              return Math.min(x, y);
            default:
              return Math.max(x, y);
          }
        });
      }
      case 'math.lerp': {
        const a = input('a');
        const b = input('b');
        const t = input('t')[0]!;
        return a.map((x, i) => x + ((b[i] ?? b[0]!) - x) * t);
      }
      case 'math.oneMinus':
        return input('in').map((x) => 1 - x);
      case 'math.sine':
        return [Math.sin(input('in')[0]!)];
      case 'math.length':
        return [length(input('in') as Vec3)];
      case 'math.normalize':
        return normalize(input('in') as Vec3);
      case 'math.combine':
        return [input('x')[0]!, input('y')[0]!, input('z')[0]!];
      case 'math.split': {
        const v = input('in');
        return [v[portId === 'x' ? 0 : portId === 'y' ? 1 : 2]!];
      }
      default:
        return splat(0, width);
    }
  }

  private normalizedAge(sys: SystemState, p: number): number {
    const l = sys.lifetime[p]!;
    return l > 0 ? Math.min(1, sys.age[p]! / l) : 1;
  }

  /** A block parameter: its wired input (converted to the input's type) or its field. */
  private num(b: CompiledNode, key: string, ctx: EvalCtx): number {
    const w = b.wired[key];
    return w !== undefined ? convertValue(this.value(ctx, w.nodeId, w.portId), w.fromType, w.toType)[0]! : Number(b.fields[key]);
  }
  private vec(b: CompiledNode, key: string, ctx: EvalCtx): Vec3 {
    const w = b.wired[key];
    const v = w !== undefined ? convertValue(this.value(ctx, w.nodeId, w.portId), w.fromType, w.toType) : (b.fields[key] as number[]);
    return [v[0]!, v[1]!, v[2]!];
  }
  private col(b: CompiledNode, key: string, ctx: EvalCtx): Vec4 {
    const w = b.wired[key];
    if (w !== undefined) {
      const v = convertValue(this.value(ctx, w.nodeId, w.portId), w.fromType, w.toType);
      return [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
    }
    return hexToLinear(String(b.fields[key]), b.fields['alpha'] !== undefined ? Number(b.fields['alpha']) : 1);
  }

  // ---- space helpers (effect-space block values → the system's simulation space) --------------

  private simPoint(sys: SystemState, p: Vec3): Vec3 {
    return sys.program.space === 'world' ? toWorldPoint(this.origin, p) : p;
  }
  private simDirection(sys: SystemState, d: Vec3): Vec3 {
    return sys.program.space === 'world' ? toWorldDirection(this.origin, d) : normalize(d);
  }
  /** A world-space vector (gravity, wind) in the system's simulation space. */
  private fromWorldVector(sys: SystemState, v: Vec3): Vec3 {
    return sys.program.space === 'world' ? v : toLocalVector(this.origin, v);
  }
  private toWorldEventPoint(sys: SystemState, p: Vec3): Vec3 {
    return sys.program.space === 'world' ? p : toWorldPoint(this.origin, p);
  }
  private toWorldEventVector(sys: SystemState, v: Vec3): Vec3 {
    return sys.program.space === 'world' ? v : toWorldVector(this.origin, v);
  }

  private event(sys: SystemState, kind: EventKind, i: number): void {
    sys.events[kind].push({ position: this.toWorldEventPoint(sys, sys.get3(sys.position, i)), velocity: this.toWorldEventVector(sys, sys.get3(sys.velocity, i)), color: sys.get4(sys.color, i) });
  }

  /** The global wind velocity (world space) at a world point and time — the foliage shader's gust wave. */
  windAt(worldPoint: Vec3, t: number): Vec3 {
    const w = this.wind;
    const d = normalize([w.direction[0], 0, w.direction[1]]);
    const gust = 0.5 + 0.5 * Math.sin(t * w.gustFrequency * 6.2831853 - worldPoint[0] * 0.08 * (1 + w.turbulence * 3));
    return scale(d, w.strength + w.gust * gust);
  }

  // ---- update ---------------------------------------------------------------------------------

  private update(sys: SystemState, dt: number): void {
    const chain = sys.program.chains.update;
    let i = 0;
    while (i < sys.count) {
      sys.age[i] = sys.age[i]! + dt;
      if (sys.age[i]! >= sys.lifetime[i]!) {
        this.event(sys, 'death', i);
        sys.remove(i);
        continue;
      }
      sys.size[i] = sys.baseSize[i]!;
      for (let k = 0; k < 4; k++) sys.color[i * 4 + k] = sys.baseColor[i * 4 + k]!;
      const ctx: EvalCtx = { sys, p: i, seed: hash32(this.effect.seed, sys.program.index, sys.serial[i]!) };
      for (const b of chain) if (!POST_INTEGRATION_BLOCKS.has(b.type)) this.applyUpdate(b, ctx, dt);
      sys.set3(sys.position, i, add(sys.get3(sys.position, i), scale(sys.get3(sys.velocity, i), dt)));
      sys.rotation[i] = sys.rotation[i]! + sys.spin[i]! * dt;
      let killed = false;
      for (const b of chain) {
        if (!POST_INTEGRATION_BLOCKS.has(b.type)) continue;
        if (this.applyPost(b, ctx)) {
          killed = true;
          break;
        }
      }
      if (killed || sys.age[i]! >= sys.lifetime[i]!) {
        this.event(sys, 'death', i);
        sys.remove(i);
        continue;
      }
      if (sys.trail !== null) this.recordTrail(sys, i, dt);
      i += 1;
    }
  }

  private recordTrail(sys: SystemState, i: number, dt: number): void {
    const spec = sys.program.trail!;
    const every = spec.length / spec.segments;
    sys.trailTimer![i] = sys.trailTimer![i]! + dt;
    if (sys.trailTimer![i]! < every && sys.trailCount![i]! > 0) return;
    sys.trailTimer![i] = 0;
    const S = sys.trailSegments;
    const base = i * S * 3;
    // Newest first: shift the older points back by one.
    sys.trail!.copyWithin(base + 3, base, base + (S - 1) * 3);
    sys.trail![base] = sys.position[i * 3]!;
    sys.trail![base + 1] = sys.position[i * 3 + 1]!;
    sys.trail![base + 2] = sys.position[i * 3 + 2]!;
    sys.trailCount![i] = Math.min(S, sys.trailCount![i]! + 1);
  }

  private applyUpdate(b: CompiledNode, ctx: EvalCtx, dt: number): void {
    const { sys, p: i } = ctx;
    const v = sys.get3(sys.velocity, i);
    const pos = sys.get3(sys.position, i);
    const m = Math.max(1e-4, sys.mass[i]!);
    const setV = (nv: Vec3): void => sys.set3(sys.velocity, i, nv);
    switch (b.type) {
      case 'update.gravity':
        setV(add(v, scale(this.fromWorldVector(sys, this.vec(b, 'acceleration', ctx)), dt)));
        return;
      case 'update.drag':
        setV(scale(v, Math.exp((-this.num(b, 'coefficient', ctx) * dt) / m)));
        return;
      case 'update.wind': {
        const worldPos = this.toWorldEventPoint(sys, pos);
        const w = this.fromWorldVector(sys, this.windAt(worldPos, this.worldTime));
        // Approach the wind velocity exponentially (never overshoots at large dt).
        const f = 1 - Math.exp((-this.num(b, 'influence', ctx) * dt) / m);
        setV(add(v, scale(sub(w, v), f)));
        return;
      }
      case 'update.vortex': {
        const c = this.simPoint(sys, this.vec(b, 'center', ctx));
        const axis = this.simDirection(sys, this.vec(b, 'axis', ctx));
        const r = sub(pos, c);
        const radial = sub(r, scale(axis, dot(r, axis)));
        const tangent = normalize(cross(axis, radial));
        const inward = scale(normalize(radial), -1);
        const a = add(scale(tangent, this.num(b, 'strength', ctx)), scale(inward, this.num(b, 'pull', ctx)));
        setV(add(v, scale(a, dt / m)));
        return;
      }
      case 'update.turbulence': {
        const freq = this.num(b, 'frequency', ctx);
        const scroll = this.cycleTime() * this.num(b, 'speed', ctx);
        const q: Vec3 = [pos[0] * freq, pos[1] * freq + scroll, pos[2] * freq];
        const c = this.noise.curl(q, Math.round(Number(b.fields['octaves'])));
        setV(add(v, scale(c, (this.num(b, 'strength', ctx) * dt) / m)));
        return;
      }
      case 'update.attractor': {
        const target = this.simPoint(sys, this.vec(b, 'position', ctx));
        const d = sub(target, pos);
        const dist = length(d);
        const radius = this.num(b, 'radius', ctx);
        if (dist < 1e-6 || (radius > 0 && dist > radius)) return;
        setV(add(v, scale(d, (this.num(b, 'strength', ctx) * dt) / (m * dist))));
        return;
      }
      case 'update.size.curve':
        sys.size[i] = sys.baseSize[i]! * evalCurve(b.fields['curve'] as number[], this.normalizedAge(sys, i));
        return;
      case 'update.color.gradient': {
        const g = evalGradient(b.fields['gradient'] as number[], this.normalizedAge(sys, i));
        const c = sys.get4(sys.color, i);
        sys.set4(sys.color, i, b.fields['mode'] === 'set' ? g : [c[0] * g[0], c[1] * g[1], c[2] * g[2], c[3] * g[3]]);
        return;
      }
      case 'update.velocity.curve': {
        const cap = evalCurve(b.fields['curve'] as number[], this.normalizedAge(sys, i));
        const s = length(v);
        if (s > cap) setV(scale(v, cap / s));
        return;
      }
      default:
        return;
    }
  }

  /** Collisions and kills (after the move); true = the particle dies. */
  private applyPost(b: CompiledNode, ctx: EvalCtx): boolean {
    const { sys, p: i } = ctx;
    const pos = sys.get3(sys.position, i);
    switch (b.type) {
      case 'update.collide.plane': {
        const point = this.simPoint(sys, this.vec(b, 'point', ctx));
        const n = this.simDirection(sys, this.vec(b, 'normal', ctx));
        const d = dot(sub(pos, point), n);
        if (d >= 0) return false;
        sys.set3(sys.position, i, sub(pos, scale(n, d)));
        const v = sys.get3(sys.velocity, i);
        const vn = dot(v, n);
        if (vn < 0) {
          const tangential = sub(v, scale(n, vn));
          const friction = this.num(b, 'friction', ctx);
          sys.set3(sys.velocity, i, add(scale(tangential, 1 - friction), scale(n, -vn * this.num(b, 'bounce', ctx))));
        }
        this.event(sys, 'collision', i);
        if (b.fields['kill'] === true) return true;
        const loss = Number(b.fields['lifetimeLoss']);
        if (loss > 0) sys.age[i] = sys.age[i]! + loss * sys.lifetime[i]!;
        return false;
      }
      case 'update.collide.depth':
        // Honoured only by the WebGPU executor (it reads the depth buffer); the CPU fallback has none.
        return false;
      case 'update.kill.plane': {
        const point = this.simPoint(sys, this.vec(b, 'point', ctx));
        const n = this.simDirection(sys, this.vec(b, 'normal', ctx));
        return dot(sub(pos, point), n) < 0;
      }
      case 'update.kill.sphere': {
        const c = this.simPoint(sys, this.vec(b, 'center', ctx));
        const inside = length(sub(pos, c)) < this.num(b, 'radius', ctx);
        return b.fields['mode'] === 'outside' ? !inside : inside;
      }
      case 'update.kill.box': {
        // The box is axis-aligned in effect space: test the particle there.
        const local = sys.program.space === 'world' ? toLocalPoint(this.origin, pos) : pos;
        const c = this.vec(b, 'center', ctx);
        const half = scale(this.vec(b, 'size', ctx), 0.5);
        const inside = Math.abs(local[0] - c[0]) <= half[0] && Math.abs(local[1] - c[1]) <= half[1] && Math.abs(local[2] - c[2]) <= half[2];
        return b.fields['mode'] === 'inside' ? inside : !inside;
      }
      case 'update.kill.speed':
        return length(sys.get3(sys.velocity, i)) < this.num(b, 'speed', ctx);
      default:
        return false;
    }
  }

  // ---- spawn ----------------------------------------------------------------------------------

  private spawn(sys: SystemState, index: number, t0: number, t1: number, dt: number, prev: EffectOrigin): void {
    const chain = sys.program.chains.spawn;
    if (chain.length === 0) return;
    const ctx: EvalCtx = { sys, p: -1, seed: hash32(this.effect.seed, index, this.stepIndex, 0x5ea) };
    const births: ({ kind: 'origin'; t: number } | { kind: 'event'; event: EffectEvent; block: CompiledNode })[] = [];
    const active = this.spawning();
    for (const b of chain) {
      switch (b.type) {
        case 'spawn.rate': {
          if (!active) break;
          const activeDt = this.effect.loop ? dt : Math.max(0, Math.min(t1, this.effect.duration) - t0);
          sys.rateCarry += Math.max(0, this.num(b, 'rate', ctx)) * activeDt;
          // 1e-9: 60 steps of 10/60 must make exactly 10 (binary fractions round down).
          const n = Math.floor(sys.rateCarry + 1e-9);
          sys.rateCarry = Math.max(0, sys.rateCarry - n);
          for (let k = 0; k < n; k++) births.push({ kind: 'origin', t: 1 });
          break;
        }
        case 'spawn.burst': {
          if (!this.playing) break;
          const n = this.burstsIn(b, t0, t1) * Math.max(0, Math.floor(this.num(b, 'count', ctx)));
          for (let k = 0; k < n; k++) births.push({ kind: 'origin', t: 1 });
          break;
        }
        case 'spawn.distance': {
          if (!active) break;
          const moved = length(sub(this.origin.position, prev.position));
          sys.distanceCarry += Math.max(0, this.num(b, 'perMeter', ctx)) * moved;
          const n = Math.floor(sys.distanceCarry + 1e-9);
          sys.distanceCarry = Math.max(0, sys.distanceCarry - n);
          for (let k = 0; k < n; k++) births.push({ kind: 'origin', t: (k + 1) / n });
          break;
        }
        case 'spawn.event': {
          const src = this.systems.findIndex((s) => s.program.systemId === b.fields['system']);
          if (src < 0) break;
          const kind = b.fields['event'] as EventKind;
          // Earlier systems raised theirs this step; this one and later ones in the previous step.
          const list = src < index ? this.systems[src]!.events[kind] : this.systems[src]!.lastEvents[kind];
          const per = Math.max(0, Math.floor(Number(b.fields['count'])));
          for (const e of list) for (let k = 0; k < per; k++) births.push({ kind: 'event', event: e, block: b });
          break;
        }
        default:
          break;
      }
    }
    for (const birth of births) {
      if (sys.count >= sys.capacity) break;
      this.initialize(sys, index, birth, prev);
    }
  }

  /** How many burst times of the block fall in the effect-time interval [t0, t1). */
  private burstsIn(b: CompiledNode, t0: number, t1: number): number {
    const D = this.effect.duration;
    const start = Number(b.fields['time']);
    const cycles = Math.round(Number(b.fields['cycles']));
    const interval = Number(b.fields['interval']);
    const count = (lo: number, hi: number): number => {
      // burst k fires at start + k × interval (k < cycles; 0 cycles = forever), within one effect cycle [0, D).
      let n = 0;
      if (hi <= start) return 0;
      const kFirst = Math.max(0, Math.ceil((lo - start) / interval - 1e-9));
      for (let k = kFirst; ; k++) {
        if (cycles > 0 && k >= cycles) break;
        const t = start + k * interval;
        if (t >= hi || t >= D) break;
        if (t >= lo) n += 1;
      }
      return n;
    };
    if (!this.effect.loop) return count(t0, Math.min(t1, D));
    let n = 0;
    for (let c = Math.floor(t0 / D); c * D < t1; c++) n += count(Math.max(t0 - c * D, 0), Math.min(t1 - c * D, D));
    return n;
  }

  private initialize(sys: SystemState, index: number, birth: { kind: 'origin'; t: number } | { kind: 'event'; event: EffectEvent; block: CompiledNode }, prev: EffectOrigin): void {
    const i = sys.count;
    sys.count += 1;
    const serial = sys.nextSerial++;
    sys.serial[i] = serial;
    const seed = hash32(this.effect.seed, index, serial);
    const rng = new Rng(seed);
    const world = sys.program.space === 'world';
    let base: Vec3;
    let baseV: Vec3 = [0, 0, 0];
    let baseColor: Vec4 = [1, 1, 1, 1];
    if (birth.kind === 'event') {
      const e = birth.event;
      base = world ? e.position : toLocalPoint(this.origin, e.position);
      const k = Number(birth.block.fields['inheritVelocity']);
      baseV = scale(world ? e.velocity : toLocalVector(this.origin, e.velocity), k);
      if (birth.block.fields['inheritColor'] === true) baseColor = [...e.color];
    } else {
      base = world ? lerp3(prev.position, this.origin.position, birth.t) : [0, 0, 0];
    }
    sys.set3(sys.position, i, base);
    sys.set3(sys.velocity, i, baseV);
    sys.set4(sys.baseColor, i, baseColor);
    sys.set4(sys.color, i, baseColor);
    // Defaults without a block: 1 s, 0.1 m, 1 kg, no rotation (the blocks' own defaults).
    sys.lifetime[i] = 1;
    sys.baseSize[i] = 0.1;
    sys.size[i] = 0.1;
    sys.mass[i] = 1;
    sys.rotation[i] = 0;
    sys.spin[i] = 0;
    sys.age[i] = 0;
    sys.random[i] = hashFloat(seed, 0x51);
    if (sys.trail !== null) {
      sys.trailCount![i] = 0;
      sys.trailTimer![i] = 0;
    }
    const ctx: EvalCtx = { sys, p: i, seed };
    let direction: Vec3 = [0, 1, 0];
    const offset = (o: Vec3): void => sys.set3(sys.position, i, add(sys.get3(sys.position, i), world ? toWorldVector(this.origin, o) : o));
    const addVelocity = (v: Vec3): void => sys.set3(sys.velocity, i, add(sys.get3(sys.velocity, i), world ? toWorldVector(this.origin, v) : v));
    const range = (lo: number, hi: number): number => rng.range(lo, hi);
    for (const b of sys.program.chains.initialize) {
      switch (b.type) {
        case 'init.position.point':
          offset(this.vec(b, 'offset', ctx));
          direction = [0, 1, 0];
          break;
        case 'init.position.sphere': {
          const d = randomUnit(rng);
          const r = this.num(b, 'radius', ctx) * (b.fields['surface'] === true ? 1 : Math.cbrt(rng.next()));
          offset(add(this.vec(b, 'center', ctx), scale(d, r)));
          direction = d;
          break;
        }
        case 'init.position.box': {
          const c = this.vec(b, 'center', ctx);
          const s = this.vec(b, 'size', ctx);
          let u: Vec3 = [rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5];
          if (b.fields['surface'] === true) {
            // A face picked by its area, then a point on it.
            const areas = [s[1] * s[2], s[1] * s[2], s[0] * s[2], s[0] * s[2], s[0] * s[1], s[0] * s[1]];
            const total = areas.reduce((a, x) => a + x, 0);
            let pick = rng.next() * total;
            let face = 0;
            while (face < 5 && pick >= areas[face]!) pick -= areas[face++]!;
            const axis = face >> 1;
            u = [u[0], u[1], u[2]];
            u[axis] = face % 2 === 0 ? -0.5 : 0.5;
          }
          offset([c[0] + u[0] * s[0], c[1] + u[1] * s[1], c[2] + u[2] * s[2]]);
          direction = [0, 1, 0];
          break;
        }
        case 'init.position.circle': {
          const [, e1, e2] = axisBasis(String(b.fields['axis']));
          const th = rng.next() * Math.PI * 2;
          const r = this.num(b, 'radius', ctx) * (b.fields['edge'] === true ? 1 : Math.sqrt(rng.next()));
          const radial = add(scale(e1, Math.cos(th)), scale(e2, Math.sin(th)));
          offset(add(this.vec(b, 'center', ctx), scale(radial, r)));
          direction = radial;
          break;
        }
        case 'init.position.cone': {
          const [a, e1, e2] = axisBasis(String(b.fields['axis']));
          const th = rng.next() * Math.PI * 2;
          const r = this.num(b, 'radius', ctx) * Math.sqrt(rng.next());
          offset(add(this.vec(b, 'center', ctx), add(scale(e1, r * Math.cos(th)), scale(e2, r * Math.sin(th)))));
          // A direction uniform on the spherical cap within the angle around the axis.
          const angle = (this.num(b, 'angle', ctx) * Math.PI) / 180;
          const cosT = 1 - rng.next() * (1 - Math.cos(angle));
          const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
          const phi = rng.next() * Math.PI * 2;
          direction = add(scale(a, cosT), add(scale(e1, sinT * Math.cos(phi)), scale(e2, sinT * Math.sin(phi))));
          break;
        }
        case 'init.position.line': {
          const s = this.vec(b, 'start', ctx);
          offset(lerp3(s, this.vec(b, 'end', ctx), rng.next()));
          direction = [0, 1, 0];
          break;
        }
        case 'init.position.mesh': {
          const sample = this.sampleMesh(String(b.fields['model']), rng);
          if (sample === null) break;
          offset(scale(sample.point, this.num(b, 'scale', ctx)));
          direction = sample.normal;
          break;
        }
        case 'init.velocity': {
          const lo = this.vec(b, 'min', ctx);
          const hi = this.vec(b, 'max', ctx);
          addVelocity([range(lo[0], hi[0]), range(lo[1], hi[1]), range(lo[2], hi[2])]);
          break;
        }
        case 'init.velocity.direction':
          addVelocity(scale(normalize(direction), range(this.num(b, 'speedMin', ctx), this.num(b, 'speedMax', ctx))));
          break;
        case 'init.lifetime':
          sys.lifetime[i] = Math.max(1e-3, range(this.num(b, 'min', ctx), this.num(b, 'max', ctx)));
          break;
        case 'init.size': {
          const s = Math.max(0, range(this.num(b, 'min', ctx), this.num(b, 'max', ctx)));
          sys.baseSize[i] = s;
          sys.size[i] = s;
          break;
        }
        case 'init.color': {
          const c = this.col(b, 'color', ctx);
          sys.set4(sys.baseColor, i, c);
          sys.set4(sys.color, i, c);
          break;
        }
        case 'init.color.gradient': {
          const c = evalGradient(b.fields['gradient'] as number[], rng.next());
          sys.set4(sys.baseColor, i, c);
          sys.set4(sys.color, i, c);
          break;
        }
        case 'init.rotation':
          sys.rotation[i] = range(this.num(b, 'angleMin', ctx), this.num(b, 'angleMax', ctx));
          sys.spin[i] = range(this.num(b, 'spinMin', ctx), this.num(b, 'spinMax', ctx));
          break;
        case 'init.mass':
          sys.mass[i] = Math.max(1e-4, range(this.num(b, 'min', ctx), this.num(b, 'max', ctx)));
          break;
        default:
          break;
      }
    }
    this.event(sys, 'birth', i);
  }

  private sampleMesh(assetId: string, rng: Rng): { point: Vec3; normal: Vec3 } | null {
    if (assetId === '') return null;
    let m = this.meshCache.get(assetId);
    if (m === undefined) {
      const mesh = this.options.mesh?.(assetId) ?? null;
      m = mesh !== null ? prepareMesh(mesh) : null;
      this.meshCache.set(assetId, m);
    }
    if (m === null || m.cumulative.length === 0) return null;
    const total = m.cumulative[m.cumulative.length - 1]!;
    const pick = rng.next() * total;
    let lo = 0;
    let hi = m.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m.cumulative[mid]! > pick) hi = mid;
      else lo = mid + 1;
    }
    const v = (k: number): Vec3 => {
      const idx = m!.tris[lo * 3 + k]! * 3;
      return [m!.pos[idx]!, m!.pos[idx + 1]!, m!.pos[idx + 2]!];
    };
    const a = v(0);
    const b = v(1);
    const c = v(2);
    // Uniform barycentric point.
    const r1 = Math.sqrt(rng.next());
    const r2 = rng.next();
    const point = add(add(scale(a, 1 - r1), scale(b, r1 * (1 - r2))), scale(c, r1 * r2));
    return { point, normal: normalize(cross(sub(b, a), sub(c, a))) };
  }
}

function prepareMesh(mesh: EffectMesh): { pos: number[]; tris: number[]; cumulative: number[] } {
  const pos = Array.from(mesh.positions);
  const tris = mesh.indices !== undefined ? Array.from(mesh.indices) : Array.from({ length: Math.floor(pos.length / 3) }, (_, i) => i);
  const cumulative: number[] = [];
  let sum = 0;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const p = (k: number): Vec3 => [pos[tris[t + k]! * 3]!, pos[tris[t + k]! * 3 + 1]!, pos[tris[t + k]! * 3 + 2]!];
    sum += length(cross(sub(p(1), p(0)), sub(p(2), p(0)))) / 2;
    cumulative.push(sum);
  }
  return { pos, tris, cumulative };
}

function randomUnit(rng: Rng): Vec3 {
  const z = rng.next() * 2 - 1;
  const phi = rng.next() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), z, r * Math.sin(phi)];
}

/** The axis and two perpendicular unit vectors of a circle/cone axis choice. */
function axisBasis(axis: string): [Vec3, Vec3, Vec3] {
  if (axis === 'x') return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (axis === 'z') return [[0, 0, 1], [1, 0, 0], [0, 1, 0]];
  return [[0, 1, 0], [1, 0, 0], [0, 0, 1]];
}
