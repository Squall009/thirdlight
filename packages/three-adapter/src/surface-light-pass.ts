/**
 * The surface cache's direct-light update on the GPU: the stale texels the
 * scheduler hands out each frame (`SurfaceRelight.plan`) are lit by the sun
 * and the point and spot lights reaching their unit, with soft shadows from
 * rays traced through the static scene (`tracer-gpu.ts`), within the
 * quality level's GPU time.
 *
 * Three compute passes, timestamped together: rays are made per texel and
 * light (sun rays over its disc, light rays over a small sphere round each
 * light), traced, and gathered into each texel's irradiance. The measured
 * time goes back to the scheduler, which sizes the next frames' work by it.
 *
 * Per-frame input (one word buffer): a slice table (`SLICE_WORDS` per
 * slice: first texel, texels, first ray, rays per texel, its lights' list,
 * their count, sun rays and rays per light), the light lists, the light records
 * (`LIGHT_WORDS`: position, reach, colour, the spot's cos outer, axis, cos
 * inner) and the sun (`SUN_WORDS`: direction toward it, colour); and the
 * texels' points (`surface-texels.ts`).
 *
 * Only the few WebGPU calls this uses are typed (`tracer-gpu.ts`'s types).
 */
import { RAY_FLOATS, TRACE_MISS, TRACE_UNFINISHED, type PackedTraceScene } from './tracer-scene';
import type { TraceOptions } from './tracer-cpu-math';
import { GpuTracer, type GpuBuffer, type GpuEncoder, type TracerDevice } from './tracer-gpu';
import { lightReach, type CacheLight } from './surface-changes';
import type { SurfaceCacheHost } from './surface-cache-host';
import { TEXEL_POINT_FLOATS, patchTexelPoints, tileTexelPoints } from './surface-texels';

/**
 * Rays a texel casts toward the sun (over its disc) and toward each point
 * or spot light reaching it (over its small sphere): the medium tier's
 * counts. A light this small casts a penumbra of a few centimetres, which
 * four rays resolve; the sun's wider one takes eight.
 */
export const SUN_RAYS = 8;
export const LIGHT_RAYS = 4;

/**
 * Rays a texel of cache level `level` casts: halved a level (a coarser
 * texel is wider than the detail more rays would resolve), at least one.
 */
export function raysAtLevel(rays: number, level: number): number {
  return Math.max(1, rays >> Math.max(0, level));
}
/** The sun's disc (radians, its angular radius): its shadows' penumbra. */
export const SUN_DISC_RADIANS = 0.02;
const SHADOW_CONE = SUN_DISC_RADIANS / 2;
/** The sphere (m) a point or spot light's shadow rays aim over: three's lights have no size, a little softness reads as real. */
export const POINT_LIGHT_RADIUS = 0.05;
/**
 * Shadow rays are traced as such: any hit blocks, and a model's distance
 * field blocks a ray passing within this cone (radians) of it: half the
 * sun's disc, so a ray creeping along a surface stops early.
 */
export const SHADOW_TRACE: TraceOptions = { anyHit: true, cone: SHADOW_CONE };
/** How far (m) a texel's rays start off its surface. */
const RAY_BIAS = 0.01;
export const SLICE_WORDS = 8;
export const LIGHT_WORDS = 12;
export const SUN_WORDS = 8;
const WORKGROUP = 64;

const COMMON = /* wgsl */ `
struct Params { texels: u32, rays: u32, slices: u32, seed: u32, lights: u32, sunAt: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> F: array<u32>;
@group(0) @binding(2) var<storage, read> PT: array<f32>;
fn ff(i: u32) -> f32 { return bitcast<f32>(F[i]); }
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(s: ptr<function, u32>) -> f32 { *s = pcg(*s); return f32(*s) / 4294967296.0; }
// The slice holding item 'i' by the slice table's word 'w' (its first texel: 0, its first ray: 2).
fn sliceOf(i: u32, w: u32) -> u32 {
  var lo = 0u;
  var hi = P.slices - 1u;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi + 1u) >> 1u;
    if (F[mid * ${SLICE_WORDS}u + w] <= i) { lo = mid; } else { hi = mid - 1u; }
  }
  return lo;
}
fn pointOf(t: u32) -> vec3f { return vec3f(PT[t * 6u], PT[t * 6u + 1u], PT[t * 6u + 2u]); }
fn normalOf(t: u32) -> vec3f { return vec3f(PT[t * 6u + 3u], PT[t * 6u + 4u], PT[t * 6u + 5u]); }
fn lightAt(j: u32) -> u32 { return P.sunAt + ${SUN_WORDS}u + j * ${LIGHT_WORDS}u; }
`;

const GEN = COMMON + /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> R: array<vec4f>;

fn basis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(n, a));
  return mat3x3f(t, cross(n, t), n);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.rays) { return; }
  let s = sliceOf(g.x, 2u) * ${SLICE_WORDS}u;
  let local = g.x - F[s + 2u];
  let rpt = F[s + 3u];
  let t = F[s] + local / rpt;
  let k = local % rpt;
  let n = normalOf(t);
  let o = pointOf(t) + n * ${RAY_BIAS};
  var seed = pcg(g.x ^ (P.seed * 0x9e3779b9u));
  var d = vec3f(0.0, 1.0, 0.0);
  var tmax = 0.0;
  let sunRays = F[s + 6u];
  let lightRays = F[s + 7u];
  if (dot(n, n) > 0.0) {
    if (k < sunRays) {
      let sd = vec3f(ff(P.sunAt), ff(P.sunAt + 1u), ff(P.sunAt + 2u));
      let a = rnd(&seed) * 6.2831853;
      let q = ${SUN_DISC_RADIANS} * sqrt(rnd(&seed));
      let b = basis(sd);
      d = normalize(sd + (b[0] * cos(a) + b[1] * sin(a)) * q);
      if (dot(d, n) > 0.0) { tmax = 1e4; }
    } else if (F[s + 5u] > 0u) {
      let j = F[F[s + 4u] + (k - sunRays) / lightRays];
      let at = lightAt(j);
      let lp = vec3f(ff(at), ff(at + 1u), ff(at + 2u));
      let u = vec3f(rnd(&seed), rnd(&seed), rnd(&seed)) * 2.0 - 1.0;
      let e = lp + normalize(u + vec3f(1e-6)) * ${POINT_LIGHT_RADIUS} * pow(rnd(&seed), 0.3333);
      let v = e - o;
      let len = length(v);
      d = v / max(len, 1e-6);
      if (dot(d, n) > 0.0 && len < ff(at + 3u)) { tmax = max(0.0, len - ${POINT_LIGHT_RADIUS}); }
    }
  }
  R[g.x * 2u] = vec4f(o, 0.0);
  R[g.x * 2u + 1u] = vec4f(d, tmax);
}
`;

const GATHER = COMMON + /* wgsl */ `
@group(0) @binding(3) var<storage, read> H: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> E: array<vec4f>;

// A ray that ran out of steps found nothing within them: it counts as reaching the light.
fn visible(r: u32) -> f32 { return select(0.0, 1.0, (H[r * 2u + 1u].x & 255u) == ${TRACE_MISS}u || (H[r * 2u + 1u].x & 255u) == ${TRACE_UNFINISHED}u); }

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.texels) { return; }
  let s = sliceOf(g.x, 0u) * ${SLICE_WORDS}u;
  let rpt = F[s + 3u];
  let r0 = F[s + 2u] + (g.x - F[s]) * rpt;
  let n = normalOf(g.x);
  let p = pointOf(g.x);
  var e = vec3f(0.0);
  if (dot(n, n) > 0.0) {
    var k = 0u;
    let sunRays = F[s + 6u];
    let lightRays = F[s + 7u];
    if (sunRays != 0u) {
      var v = 0.0;
      for (; k < sunRays; k++) { v += visible(r0 + k); }
      let sd = vec3f(ff(P.sunAt), ff(P.sunAt + 1u), ff(P.sunAt + 2u));
      e += vec3f(ff(P.sunAt + 4u), ff(P.sunAt + 5u), ff(P.sunAt + 6u)) * max(0.0, dot(n, sd)) * v / f32(sunRays);
    }
    for (var j = 0u; j < F[s + 5u]; j++) {
      let at = lightAt(F[F[s + 4u] + j]);
      let lp = vec3f(ff(at), ff(at + 1u), ff(at + 2u));
      let reach = ff(at + 3u);
      var v = 0.0;
      for (var i = 0u; i < lightRays; i++) { v += visible(r0 + k + i); }
      k += lightRays;
      let lv = lp - p;
      let d2 = max(dot(lv, lv), 1e-4);
      let l = lv * inverseSqrt(d2);
      // three's punctual falloff: inverse square, windowed to the light's reach.
      let w = clamp(1.0 - pow(d2 / (reach * reach), 2.0), 0.0, 1.0);
      let axis = vec3f(ff(at + 8u), ff(at + 9u), ff(at + 10u));
      var cone = 1.0;
      if (ff(at + 7u) > -2.0) { cone = smoothstep(ff(at + 7u), ff(at + 11u), dot(-l, axis)); }
      e += vec3f(ff(at + 4u), ff(at + 5u), ff(at + 6u)) * max(0.0, dot(n, l)) * w * w / d2 * cone * v / f32(lightRays);
    }
  }
  E[g.x] = vec4f(e, 1.0);
}
`;

/** One frame's work as the pass takes it: the planned slices' texel points and the lights reaching each. */
export interface LightPassFrame {
  /** Texel points (`TEXEL_POINT_FLOATS` each), slices in order. */
  readonly points: Float32Array;
  /** Per slice: its texels, the lights reaching its unit, whether the sun is on, and its cache level (ray counts fall with it). */
  readonly slices: readonly { readonly texels: number; readonly lights: readonly number[]; readonly sun: boolean; readonly level: number }[];
  readonly lights: readonly CacheLight[];
  /** The sun (null: none on). */
  readonly sun: CacheLight | null;
}

/** The frame's word buffer and its counts. */
export function packLightFrame(frame: LightPassFrame): { words: Uint32Array; texels: number; rays: number; sunAt: number } {
  const n = frame.slices.length;
  const listWords = frame.slices.reduce((s, sl) => s + sl.lights.length, 0);
  const sunAt = n * SLICE_WORDS + listWords;
  const words = new Uint32Array(sunAt + SUN_WORDS + frame.lights.length * LIGHT_WORDS);
  const f = new Float32Array(words.buffer);
  let texel = 0;
  let ray = 0;
  let list = n * SLICE_WORDS;
  frame.slices.forEach((sl, i) => {
    const sunRays = sl.sun ? raysAtLevel(SUN_RAYS, sl.level) : 0;
    const lightRays = raysAtLevel(LIGHT_RAYS, sl.level);
    const rpt = sunRays + sl.lights.length * lightRays;
    words.set([texel, sl.texels, ray, Math.max(1, rpt), list, sl.lights.length, sunRays, lightRays], i * SLICE_WORDS);
    for (const j of sl.lights) words[list++] = j;
    texel += sl.texels;
    ray += sl.texels * Math.max(1, rpt);
  });
  if (frame.sun !== null) {
    f.set(frame.sun.direction, sunAt);
    f.set(frame.sun.color, sunAt + 4);
  }
  frame.lights.forEach((l, j) => {
    const at = sunAt + SUN_WORDS + j * LIGHT_WORDS;
    f.set(l.position, at);
    f[at + 3] = lightReach(l);
    f.set(l.color, at + 4);
    // A point light has no cone: −3 marks it (a cosine is never below −1).
    const spot = l.kind === 'spot';
    f[at + 7] = spot ? l.cone : -3;
    f.set(l.direction, at + 8);
    // The penumbra's inner edge, as three's: the cone's angle less its penumbra share.
    f[at + 11] = spot ? Math.cos(Math.acos(Math.min(1, Math.max(-1, l.cone))) * (1 - l.penumbra)) : 1;
  });
  return { words, texels: texel, rays: ray, sunAt };
}

/**
 * This frame's planned work from the host (`SurfaceCacheHost.slicesThisFrame`):
 * each slice's texel points, the point and spot lights whose reach touches
 * its unit, and the sun when one is on.
 */
export function lightFrameOf(host: SurfaceCacheHost, lights: readonly CacheLight[], points: Float32Array | null = null): LightPassFrame {
  const slices = host.slicesThisFrame();
  const texels = slices.reduce((n, s) => n + (s.to - s.from), 0);
  const out = points !== null && points.length >= texels * TEXEL_POINT_FLOATS ? points : new Float32Array(texels * TEXEL_POINT_FLOATS);
  const local = lights.filter((l) => l.on && l.kind !== 'directional');
  const sun = lights.find((l) => l.on && l.kind === 'directional') ?? null;
  const reach = local.map((l) => lightReach(l));
  const list: LightPassFrame['slices'][number][] = [];
  let at = 0;
  for (const s of slices) {
    const src = host.texelsOf(s.unit.key);
    const n = s.to - s.from;
    if (src === null) out.fill(0, at, at + n * TEXEL_POINT_FLOATS);
    else if ('patch' in src) patchTexelPoints(src, s.from, s.to, out, at);
    else tileTexelPoints(src, s.from, s.to, out, at);
    at += n * TEXEL_POINT_FLOATS;
    const touching: number[] = [];
    local.forEach((l, j) => {
      const r = reach[j]!;
      for (let k = 0; k < 3; k += 1) if (l.position[k]! + r < s.unit.min[k]! || l.position[k]! - r > s.unit.max[k]!) return;
      touching.push(j);
    });
    list.push({ texels: n, lights: touching, sun: sun !== null, level: src === null ? 0 : 'patch' in src ? src.patch.ring : src.level });
  }
  return { points: out, slices: list, lights: local, sun };
}

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
    return new SurfaceLightPass(device as QueryDevice, await GpuTracer.create(device), await compile(GEN, 'surface light rays'), await compile(GATHER, 'surface light gather'));
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
    this.outBuf = this.grow(this.outBuf, packed.texels * 16, USAGE.STORAGE | USAGE.COPY_SRC, 'surface light irradiance');
    d.queue.writeBuffer(this.frameBuf, 0, packed.words);
    d.queue.writeBuffer(this.pointsBuf, 0, frame.points.subarray(0, packed.texels * TEXEL_POINT_FLOATS));
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    d.queue.writeBuffer(this.params, 0, new Uint32Array([packed.texels, packed.rays, frame.slices.length, this.seed, frame.lights.length, packed.sunAt, 0, 0]));
    const enc = d.createCommandEncoder();
    const timed = this.query !== null && !this.reading;
    // Each pass's start and end: the three passes' times and the whole.
    const stamp = (i: number): Record<string, unknown> => (timed ? { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } } : {});
    const bind = (pipe: { getBindGroupLayout(i: number): unknown }, last: GpuBuffer, out?: GpuBuffer): unknown =>
      d.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.frameBuf } },
          { binding: 2, resource: { buffer: this.pointsBuf } },
          { binding: 3, resource: { buffer: last } },
          ...(out !== undefined ? [{ binding: 4, resource: { buffer: out } }] : []),
        ],
      });
    let p = enc.beginComputePass(stamp(0));
    p.setPipeline(this.gen);
    p.setBindGroup(0, bind(this.gen, this.raysBuf));
    p.dispatchWorkgroups(Math.ceil(packed.rays / WORKGROUP));
    p.end();
    this.tracer.encodeBuffer(enc, this.raysBuf, packed.rays, stamp(1), SHADOW_TRACE);
    p = enc.beginComputePass(stamp(2));
    p.setPipeline(this.gather);
    p.setBindGroup(0, bind(this.gather, this.tracer.hitsBuffer!, this.outBuf));
    p.dispatchWorkgroups(Math.ceil(packed.texels / WORKGROUP));
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
    for (const b of [this.params, this.frameBuf, this.pointsBuf, this.raysBuf, this.outBuf, this.resolveBuf]) b?.destroy();
    (this.query as { destroy?(): void } | null)?.destroy?.();
    this.tracer.dispose();
  }
}
