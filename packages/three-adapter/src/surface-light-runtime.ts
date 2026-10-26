/**
 * The surface cache's light on the page's own GPU device (WebGPU; the
 * medium and high tiers): each frame the host's planned texels
 * (`SurfaceCacheHost.slicesThisFrame`) are lit by the light pass and
 * written into the cache's textures, where materials will read them:
 *
 * - the atlas: a 2D array of `SURFACE_PAGE_TEXELS`² rgba16float pages, as
 *   many as the quality level's budget holds (block, architecture and model
 *   charts);
 * - the rings: a 2D array of `TERRAIN_RING_TEXELS`² rgba16float layers,
 *   `TERRAIN_RINGS_MAX` per terrain holding rings.
 *
 * A texel's light is its irradiance (rgb, the light's colour × intensity
 * as three counts it; a pixel's diffuse light is albedo × it / π).
 *
 * The scene the shadow rays trace is the host's (`traceSource`), packed
 * again when it changed, at most every `REPACK_MS`. A look at the cache
 * (`setView`) keeps a copy of every texel's point and light on the CPU, read
 * back a frame late, for a debug drawing.
 */
import { SURFACE_PAGE_TEXELS, SURFACE_TEXEL_METRES } from './surface-cache-atlas';
import { TERRAIN_RINGS_MAX, TERRAIN_RING_TEXELS } from './surface-cache-terrain';
import type { SurfaceCacheHost } from './surface-cache-host';
import type { CacheLight } from './surface-changes';
import { lightFrameOf, sliceRays, splitLightFrame } from './surface-light-frame';
import type { RelightSlice } from './surface-relight';
import { SurfaceLightPass } from './surface-light-pass';
import { RESOLVE_PAGE, RESOLVE_RING } from './surface-resolve';
import { TEXEL_POINT_FLOATS, patchTexelAddresses, tileTexelAddresses } from './surface-texels';
import type { GpuBuffer, GpuTexture, TracerDevice } from './tracer-gpu';
import { packTraceScene } from './tracer-scene';

/** Bytes a cache texel takes (rgba16float). */
export const SURFACE_TEXEL_BYTES = 8;
/**
 * Rays one run of the pass takes at most: its ray and hit buffers (32 B a
 * ray each) stay within the default storage binding size (128 MiB), so a
 * texel reached by many lights never needs a device asked for more.
 */
export const MAX_PASS_RAYS = 1 << 21;
/**
 * Rays a frame's run takes at least, whatever the budget says: on an
 * integrated GPU a smaller run costs about as much (it is bound by one
 * ray's latency, not by the count; 8 k and 64 k rays both took about 2 ms
 * on the Iris Xe at its floor clock), so fewer would only slow the light.
 */
export const MIN_PASS_RAYS = 1 << 16;
/** The weight a new run's cost per ray gets in the average. */
const RAY_COST_WEIGHT = 0.25;
/** Shortest time (ms) between packing the traced scene again after it changed. */
export const REPACK_MS = 250;

const WORKGROUP = 64;
const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const TEXTURE = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8 } as const;

const SCATTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> N: vec4u;
@group(0) @binding(1) var<storage, read> A: array<u32>;
@group(0) @binding(2) var<storage, read> E: array<vec4f>;
@group(0) @binding(3) var atlas: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var rings: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= N.x) { return; }
  let a = A[g.x * 2u];
  let b = A[g.x * 2u + 1u];
  let xy = vec2u(b & 0xffffu, b >> 16u);
  let kind = a >> 30u;
  if (kind == ${RESOLVE_PAGE}u) { textureStore(atlas, xy, a & 0x3fffffffu, E[g.x]); }
  else if (kind == ${RESOLVE_RING}u) { textureStore(rings, xy, ((a >> 3u) & 0x7ffffffu) * ${TERRAIN_RINGS_MAX}u + (a & 7u), E[g.x]); }
}
`;

/** What the debug look at the cache holds: each lit texel's point, normal and light, by unit, with the unit's texel size (m). */
export interface SurfaceCacheView {
  /** Bumped when a unit's texels changed. */
  readonly version: number;
  forEach(cb: (points: Float32Array, light: Float32Array, texels: number, size: number) => void): void;
}

interface Pipeline {
  getBindGroupLayout(i: number): unknown;
}

export class SurfaceLightRuntime implements SurfaceCacheView {
  private atlas: GpuTexture | null = null;
  private rings: GpuTexture | null = null;
  private atlasLayers = 0;
  private ringLayers = 0;
  private addrBuf: GpuBuffer | null = null;
  private readonly countBuf: GpuBuffer;
  private points: Float32Array | null = null;
  private addresses = new Uint32Array(0);
  private sceneVersion = -1;
  /** GPU ms a ray of the pass costs (an average over the timed runs; null until the first). */
  private msPerRay: number | null = null;
  private packedAt = -Infinity;
  private viewOn = false;
  private readonly viewUnits = new Map<string, { points: Float32Array; light: Float32Array; texels: number; size: number }>();
  version = 0;

  /** Hears each timed run of the pass (GPU ms, texels, and its three passes' ms): the measurements read it. */
  onTimed: ((ms: number, texels: number, passes: readonly number[]) => void) | null = null;

  private constructor(private readonly device: TracerDevice, private readonly host: SurfaceCacheHost, readonly pass: SurfaceLightPass, private readonly scatter: Pipeline) {
    this.countBuf = device.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'surface scatter count' });
  }

  static async create(device: TracerDevice, host: SurfaceCacheHost): Promise<SurfaceLightRuntime> {
    const pass = await SurfaceLightPass.create(device);
    const module = device.createShaderModule({ code: SCATTER_WGSL, label: 'surface scatter' });
    const info = await module.getCompilationInfo?.();
    const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
    if (errors.length > 0) throw new Error(`surface scatter WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
    const scatter = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: 'surface scatter' });
    return new SurfaceLightRuntime(device, host, pass, scatter);
  }

  /** The atlas and ring textures (null until the first frame made them). */
  get textures(): { atlas: GpuTexture | null; rings: GpuTexture | null } {
    return { atlas: this.atlas, rings: this.rings };
  }

  /** Keep a CPU copy of the lit texels for a debug drawing (off: dropped). */
  setView(on: boolean): void {
    this.viewOn = on;
    if (!on) this.viewUnits.clear();
  }

  forEach(cb: (points: Float32Array, light: Float32Array, texels: number, size: number) => void): void {
    for (const u of this.viewUnits.values()) cb(u.points, u.light, u.texels, u.size);
  }

  /** Textures sized to the cache's budget and its ring terrains (made again when they no longer fit). */
  private ensureTextures(): void {
    const pageBytes = SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * SURFACE_TEXEL_BYTES;
    const pages = Math.max(1, Math.ceil(this.host.cache.budgetBytes / pageBytes));
    if (this.atlas === null || this.atlasLayers < pages) {
      this.atlas?.destroy();
      this.atlasLayers = pages;
      this.atlas = this.device.createTexture({ size: [SURFACE_PAGE_TEXELS, SURFACE_PAGE_TEXELS, pages], format: 'rgba16float', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.STORAGE_BINDING | TEXTURE.COPY_DST, label: 'surface cache atlas' });
    }
    const ringLayers = Math.max(1, this.host.cache.ringTerrains().length) * TERRAIN_RINGS_MAX;
    if (this.rings === null || this.ringLayers < ringLayers) {
      this.rings?.destroy();
      this.ringLayers = ringLayers;
      this.rings = this.device.createTexture({ size: [TERRAIN_RING_TEXELS, TERRAIN_RING_TEXELS, ringLayers], format: 'rgba16float', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.STORAGE_BINDING | TEXTURE.COPY_DST, label: 'surface cache rings' });
    }
  }

  /** The traced scene, packed again when the host's changed (not more often than `REPACK_MS`). */
  private syncScene(now: number): boolean {
    const { source, version } = this.host.traceSource();
    if (version === this.sceneVersion) return true;
    if (this.sceneVersion >= 0 && now - this.packedAt < REPACK_MS) return true;
    this.pass.setScene(packTraceScene(source));
    this.sceneVersion = version;
    this.packedAt = now;
    return true;
  }

  /** One frame (after the host's `update`): light its planned texels and write them into the textures. */
  frame(lights: readonly CacheLight[], now = performance.now()): void {
    const slices = this.host.slicesThisFrame();
    if (slices.length === 0) return;
    this.syncScene(now);
    this.ensureTextures();
    const f = lightFrameOf(this.host, lights, this.points, this.host.rooms());
    this.points = f.points;
    const texels = f.slices.reduce((n, s) => n + s.texels, 0);
    if (this.addresses.length < texels * 2) this.addresses = new Uint32Array(texels * 2 * 2);
    let at = 0;
    const sizes: number[] = [];
    const starts: number[] = [];
    for (const s of slices) {
      starts.push(at);
      const src = this.host.texelsOf(s.unit.key);
      const n = s.to - s.from;
      sizes.push(src === null ? 0 : 'patch' in src ? src.texel : SURFACE_TEXEL_METRES * 2 ** src.level);
      if (src === null) this.addresses.fill(0, at * 2, (at + n) * 2);
      else if ('patch' in src) patchTexelAddresses(src, s.from, s.to, this.addresses, at * 2);
      else tileTexelAddresses(src, s.from, s.to, this.addresses, at * 2);
      at += n;
    }
    const d = this.device;
    const read = this.viewOn ? d.createBuffer({ size: texels * 16, usage: USAGE.MAP_READ | USAGE.COPY_DST, label: 'surface cache view read' }) : null;
    // In parts no larger than a binding holds, as many as the frame's GPU time allows (the rays a texel
    // casts change with the lights reaching it; the planned count of texels cannot know): each part is
    // lit, then written into the textures; what is left waits for the next frames.
    const budget = this.msPerRay === null ? Infinity : Math.max(MIN_PASS_RAYS, this.host.relightBudgetMs / this.msPerRay);
    const parts = splitLightFrame(f, Math.max(1, Math.min(MAX_PASS_RAYS, budget)));
    let rays = 0;
    let done = 0;
    for (const part of parts) {
      const partRays = part.frame.slices.reduce((k, sl) => k + sl.texels * sliceRays(part.frame, sl), 0);
      if (done > 0 && rays + partRays > budget) break;
      rays += partRays;
      done += 1;
      const n = part.frame.slices.reduce((k, s) => k + s.texels, 0);
      if (this.addrBuf === null || this.addrBuf.size < n * 8) {
        this.addrBuf?.destroy();
        this.addrBuf = d.createBuffer({ size: Math.max(256, 2 ** Math.ceil(Math.log2(n * 8))), usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'surface scatter addresses' });
      }
      d.queue.writeBuffer(this.addrBuf, 0, this.addresses.subarray(part.first * 2, (part.first + n) * 2));
      d.queue.writeBuffer(this.countBuf, 0, new Uint32Array([n, 0, 0, 0]));
      this.pass.run(part.frame, (ms, t, passes) => {
        this.host.relight.report(ms, t);
        this.onTimed?.(ms, t, passes);
        const per = ms / Math.max(1, partRays);
        this.msPerRay = this.msPerRay === null ? per : this.msPerRay + (per - this.msPerRay) * RAY_COST_WEIGHT;
      });
      const out = this.pass.irradiance;
      if (out === null) continue;
      const enc = d.createCommandEncoder();
      const p = enc.beginComputePass();
      p.setPipeline(this.scatter);
      p.setBindGroup(
        0,
        d.createBindGroup({
          layout: this.scatter.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.countBuf } },
            { binding: 1, resource: { buffer: this.addrBuf } },
            { binding: 2, resource: { buffer: out } },
            { binding: 3, resource: this.atlas!.createView({ dimension: '2d-array' }) },
            { binding: 4, resource: this.rings!.createView({ dimension: '2d-array' }) },
          ],
        }),
      );
      p.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
      p.end();
      if (read !== null) enc.copyBufferToBuffer(out, 0, read, part.first * 16, n * 16);
      d.queue.submit([enc.finish()]);
    }
    const lit = done < parts.length ? parts[done]!.first : texels;
    if (lit < texels) {
      let g = 0;
      const back: RelightSlice[] = [];
      for (const s of slices) {
        const n = s.to - s.from;
        if (g + n > lit) back.push({ unit: s.unit, from: s.from + Math.max(0, lit - g), to: s.to });
        g += n;
      }
      this.host.relight.giveBack(back);
    }
    if (read !== null) this.keepView(read, slices.map((s, i) => ({ key: s.unit.key, from: s.from, to: Math.min(s.to, s.from + Math.max(0, lit - starts[i]!)), total: s.unit.texels, size: sizes[i]! })), f.points.slice(0, texels * TEXEL_POINT_FLOATS));
  }

  private keepView(read: GpuBuffer, slices: readonly { key: string; from: number; to: number; total: number; size: number }[], points: Float32Array): void {
    read.mapAsync(USAGE.MAP_READ).then(
      () => {
        const e = new Float32Array(read.getMappedRange().slice(0));
        read.unmap();
        read.destroy();
        if (!this.viewOn) return;
        let at = 0;
        for (const s of slices) {
          let u = this.viewUnits.get(s.key);
          if (u === undefined || u.texels !== s.total) this.viewUnits.set(s.key, (u = { points: new Float32Array(s.total * TEXEL_POINT_FLOATS), light: new Float32Array(s.total * 3), texels: s.total, size: s.size }));
          u.size = s.size;
          for (let i = s.from; i < s.to; i += 1, at += 1) {
            u.points.set(points.subarray(at * TEXEL_POINT_FLOATS, at * TEXEL_POINT_FLOATS + TEXEL_POINT_FLOATS), i * TEXEL_POINT_FLOATS);
            // A texel with no place on a surface is left out of the drawing.
            const none = points[at * TEXEL_POINT_FLOATS + 3] === 0 && points[at * TEXEL_POINT_FLOATS + 4] === 0 && points[at * TEXEL_POINT_FLOATS + 5] === 0;
            u.light.set(none ? [-1, -1, -1] : e.subarray(at * 4, at * 4 + 3), i * 3);
          }
        }
        this.version += 1;
      },
      () => read.destroy(),
    );
  }

  dispose(): void {
    this.atlas?.destroy();
    this.rings?.destroy();
    this.addrBuf?.destroy();
    this.countBuf.destroy();
    this.pass.dispose();
    this.atlas = this.rings = this.addrBuf = null;
  }
}
