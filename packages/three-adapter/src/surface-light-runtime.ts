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
 * again when it changed, at most every `REPACK_MS`, and then only in the
 * sections that changed (`TraceScenePacker`), within the device's storage
 * binding size.
 *
 * The textures are made by whoever draws them (`SurfaceTextureSource`: the
 * page's renderer, so materials sample them), else here; a block of the
 * atlas newly handed to a tile is cleared before its light is written (its
 * texels read as not lit until then, never as another tile's light).
 *
 * After the texels, the host's stale probes (`LiveProbes`) are updated by
 * the probe pass (`surface-probe-pass.ts`), which reads these textures at
 * its rays' hits through the resolve tables (packed again with the traced
 * scene, and when the cache's residency changed). A look at the cache
 * (`setView`) keeps a copy of every texel's point and light on the CPU, read
 * back a frame late, for a debug drawing.
 */
import { SURFACE_PAGE_TEXELS, SURFACE_TEXEL_METRES } from './surface-cache-atlas';
import { TERRAIN_RINGS_MAX, TERRAIN_RING_TEXELS } from './surface-cache-terrain';
import { markTexturesLost, type SurfaceCacheHost } from './surface-cache-host';
import type { CacheLight } from './surface-changes';
import { lightFrameOf, sliceRays, splitLightFrame } from './surface-light-frame';
import type { RelightSlice } from './surface-relight';
import { SurfaceLightPass } from './surface-light-pass';
import { RESOLVE_PAGE, RESOLVE_RING } from './surface-resolve';
import { TEXEL_POINT_FLOATS, patchTexelAddresses, tileTexelAddresses } from './surface-texels';
import type { GpuBuffer, GpuTexture, TracerDevice } from './tracer-gpu';
import { DEFAULT_STORAGE_BINDING_BYTES, TraceScenePacker } from './tracer-scene-packer';
import { SurfaceProbePass } from './surface-probe-pass';
import { SurfaceReflectionPass } from './surface-reflection-pass';
import { packResolveTable } from './surface-resolve';
import { ALBEDO_CELLS, ALBEDO_PAGE_STEP, albedoWords } from './surface-cache-lookup';

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
const TEXTURE = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8 } as const;

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
  /** Read-backs of lit texels still on their way. */
  readonly viewReading: number;
  forEach(cb: (points: Float32Array, light: Float32Array, texels: number, size: number) => void): void;
}

interface Pipeline {
  getBindGroupLayout(i: number): unknown;
}

/** Which of the cache's light textures. */
export type SurfaceTextureKind = 'atlas' | 'rings';
/**
 * The cache's GPU resources made by whoever draws them: the light
 * textures, `layers` deep (made again when the count grows), and the
 * surfaces' colours (`albedoWords`, made once for the budget's pages and
 * ring layers, the rings' words from `ringsAt`).
 */
export interface SurfaceTextureSource {
  texture(which: SurfaceTextureKind, layers: number): GpuTexture;
  /** The colours' buffer (null until whoever draws them made it). */
  albedo(): { readonly buffer: GpuBuffer; readonly pages: number; readonly ringsAt: number } | null;
}

export class SurfaceLightRuntime implements SurfaceCacheView {
  private atlas: GpuTexture | null = null;
  private rings: GpuTexture | null = null;
  private albedo: { readonly buffer: GpuBuffer; readonly pages: number; readonly ringsAt: number } | null = null;
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
  private readonly packer: TraceScenePacker;
  /** Words the last scene that did not fit the binding needed (0: it fit). */
  private overWords = 0;
  private viewOn = false;
  /** The resolve tables' trace and residency versions (-1: none yet). */
  private resolvedFor = -1;
  private resolvedResidency = -1;
  /** The sky the probes see where nothing is hit (radiance SH: `SkyProbe`'s). */
  sky = new Float32Array(12);
  /** Hears each timed probe update (GPU ms, probes, the parts: rays, trace, resolve, gather). */
  onProbeTimed: ((ms: number, probes: number, passes: readonly number[]) => void) | null = null;
  private readonly viewUnits = new Map<string, { points: Float32Array; light: Float32Array; texels: number; size: number }>();
  version = 0;
  viewReading = 0;

  /** Hears each timed run of the pass (GPU ms, texels, and its three passes' ms): the measurements read it. */
  onTimed: ((ms: number, texels: number, passes: readonly number[]) => void) | null = null;

  private zeros: Uint8Array | null = null;
  private noAlbedo: GpuBuffer | null = null;

  private constructor(private readonly device: TracerDevice, private readonly host: SurfaceCacheHost, readonly pass: SurfaceLightPass, private readonly scatter: Pipeline, readonly probePass: SurfaceProbePass, readonly reflectionPass: SurfaceReflectionPass, private readonly source: SurfaceTextureSource | null) {
    this.countBuf = device.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST, label: 'surface scatter count' });
    this.packer = new TraceScenePacker(device.limits?.maxStorageBufferBindingSize ?? DEFAULT_STORAGE_BINDING_BYTES);
  }

  /** Bytes the traced scene needed when it last did not fit a storage binding (0: it fits). */
  get sceneOverBytes(): number {
    return this.overWords * 4;
  }

  static async create(device: TracerDevice, host: SurfaceCacheHost, source: SurfaceTextureSource | null = null): Promise<SurfaceLightRuntime> {
    const pass = await SurfaceLightPass.create(device);
    const module = device.createShaderModule({ code: SCATTER_WGSL, label: 'surface scatter' });
    const info = await module.getCompilationInfo?.();
    const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
    if (errors.length > 0) throw new Error(`surface scatter WGSL: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join('; ')}`);
    const scatter = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: 'surface scatter' });
    return new SurfaceLightRuntime(device, host, pass, scatter, await SurfaceProbePass.create(device, pass.tracer), await SurfaceReflectionPass.create(device, pass.tracer), source);
  }

  /** The atlas and ring textures (null until the first frame made them; they can be copied out: a bake saves them, a check reads them). */
  get textures(): { atlas: GpuTexture | null; rings: GpuTexture | null; albedo: { readonly buffer: GpuBuffer; readonly ringsAt: number } | null } {
    return { atlas: this.atlas, rings: this.rings, albedo: this.albedo };
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
    // A texture made again starts empty: what was lit into the old one is lit again.
    if (this.atlas === null || this.atlasLayers < pages) {
      const had = this.atlas !== null;
      this.atlasLayers = pages;
      this.atlas = this.make('atlas', this.atlas, SURFACE_PAGE_TEXELS, pages);
      if (had) markTexturesLost(this.host, 'atlas');
    }
    const ringLayers = Math.max(1, this.host.cache.ringTerrains().length) * TERRAIN_RINGS_MAX;
    if (this.rings === null || this.ringLayers < ringLayers) {
      const had = this.rings !== null;
      this.ringLayers = ringLayers;
      this.rings = this.make('rings', this.rings, TERRAIN_RING_TEXELS, ringLayers);
      if (had) markTexturesLost(this.host, 'rings');
    }
    if (this.source !== null) this.albedo = this.source.albedo();
    else if (this.albedo === null) this.albedo = this.ownAlbedo(pages);
  }

  /** The surfaces' colours for the probe pass: the drawn ones, else an empty buffer (every hit bounces the default). */
  private albedoForProbes(): { buffer: GpuBuffer; ringsAt: number } {
    if (this.albedo !== null) return this.albedo;
    this.noAlbedo ??= this.device.createBuffer({ size: 16, usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'surface cache no albedo' });
    return { buffer: this.noAlbedo, ringsAt: 0 };
  }

  /** The surfaces' colours when nobody draws them (no material writes: every hit bounces the default). */
  private ownAlbedo(pages: number): { buffer: GpuBuffer; pages: number; ringsAt: number } {
    const buffer = this.device.createBuffer({ size: albedoWords(pages, TERRAIN_RINGS_MAX) * 4, usage: USAGE.STORAGE | USAGE.COPY_DST, label: 'surface cache albedo' });
    return { buffer, pages, ringsAt: pages * ALBEDO_CELLS };
  }

  /** One of the textures, `layers` deep: the source's, else made here (the old one let go). */
  private make(which: SurfaceTextureKind, old: GpuTexture | null, side: number, layers: number): GpuTexture {
    if (this.source !== null) return this.source.texture(which, layers);
    old?.destroy();
    return this.device.createTexture({ size: [side, side, layers], format: 'rgba16float', usage: TEXTURE.TEXTURE_BINDING | TEXTURE.STORAGE_BINDING | TEXTURE.COPY_DST | TEXTURE.COPY_SRC, label: `surface cache ${which}` });
  }

  /**
   * The atlas blocks newly handed to tiles: cleared, or given the saved
   * light a bake left for them (`SurfaceSeeding`); their colours cleared (a
   * new texture is cleared already).
   */
  private clearFresh(): void {
    const { clear: fresh, copies: seeds } = this.host.seeding.take();
    if ((fresh.length === 0 && seeds.length === 0) || this.atlas === null) return;
    const q = this.device.queue;
    // Cleared first: a block handed out and seeded in one frame keeps its saved light.
    const cleared = new Set(fresh);
    for (const b of [...fresh, ...seeds.map((s) => s.to)]) {
      if (b.page >= this.atlasLayers) continue;
      const bytes = b.side * b.side * SURFACE_TEXEL_BYTES;
      if (this.zeros === null || this.zeros.length < bytes) this.zeros = new Uint8Array(bytes);
      if (cleared.has(b)) q.writeTexture({ texture: this.atlas, origin: [b.x, b.y, b.page] }, this.zeros.subarray(0, bytes), { bytesPerRow: b.side * SURFACE_TEXEL_BYTES, rowsPerImage: b.side }, [b.side, b.side, 1]);
      const a = this.albedo;
      if (a === null || b.page >= a.pages) continue;
      // Its colours' rows (a word per ALBEDO_PAGE_STEP² texels).
      const row = SURFACE_PAGE_TEXELS / ALBEDO_PAGE_STEP;
      const w = Math.max(1, b.side / ALBEDO_PAGE_STEP);
      for (let y = 0; y < w; y += 1) q.writeBuffer(a.buffer, (b.page * ALBEDO_CELLS + (b.y / ALBEDO_PAGE_STEP + y) * row + b.x / ALBEDO_PAGE_STEP) * 4, this.zeros.subarray(0, w * 4));
    }
    const row = SURFACE_PAGE_TEXELS * 4;
    for (const s of seeds) {
      const b = s.to;
      if (b.page >= this.atlasLayers) continue;
      // The saved block's rows, one after another (a page holds SURFACE_PAGE_TEXELS rows of RGBA halves).
      const block = new Uint16Array(b.side * b.side * 4);
      for (let y = 0; y < b.side; y += 1) {
        const at = (s.from.page * SURFACE_PAGE_TEXELS + s.from.y + y) * row + s.from.x * 4;
        block.set(s.texels.subarray(at, at + b.side * 4), y * b.side * 4);
      }
      q.writeTexture({ texture: this.atlas, origin: [b.x, b.y, b.page] }, block, { bytesPerRow: b.side * SURFACE_TEXEL_BYTES, rowsPerImage: b.side }, [b.side, b.side, 1]);
    }
  }

  /** The traced scene, packed again when the host's changed (not more often than `REPACK_MS`). */
  private syncScene(now: number): boolean {
    // The version first: the scene is made (and packed) at most every REPACK_MS while it keeps changing.
    const v = this.host.traceVersion;
    if (v === this.sceneVersion) return true;
    if (this.sceneVersion >= 0 && now - this.packedAt < REPACK_MS) return true;
    const { source, version } = this.host.traceSource();
    const packed = this.packer.pack(source);
    if (packed.fits) this.pass.updateScene(packed);
    else if (this.overWords === 0) console.warn(`surface light: the traced scene needs ${(packed.neededWords * 4 / 2 ** 20).toFixed(1)} MiB, over the ${(this.device.limits?.maxStorageBufferBindingSize ?? DEFAULT_STORAGE_BINDING_BYTES) / 2 ** 20} MiB a storage binding holds: the last scene that fit is traced`);
    this.overWords = packed.fits ? 0 : packed.neededWords;
    this.sceneVersion = version;
    this.packedAt = now;
    return true;
  }

  /** One frame (after the host's `update`): light its planned texels, write them into the textures, then update stale probes. */
  frame(lights: readonly CacheLight[], now = performance.now()): void {
    this.ensureTextures();
    this.clearFresh();
    this.lightTexels(lights, now);
    this.updateProbes(now);
  }

  /** The stale probes nearest the eye, within their share of the budget (one update on the GPU at a time). */
  private updateProbes(now: number): void {
    const probes = this.host.probes;
    probes.tick(this.host.relight.isSettled);
    if (probes.count === 0 || this.probePass.busy) return;
    const slots = probes.plan(this.host.eye, now);
    if (slots.length === 0) return;
    if (!this.syncProbeInputs(now)) return;
    const layout = probes.layout;
    this.probePass.run({ probes, slots, sky: this.sky, rooms: this.host.rooms()?.words ?? null, atlas: this.atlas!, rings: this.rings!, albedo: this.albedoForProbes().buffer, albedoRingsAt: this.albedoForProbes().ringsAt }, (values, ms, passes) => {
      if (probes.layout !== layout) return;
      probes.accept(slots, values, this.host.relight.isSettled, performance.now());
      if (ms === null) return;
      probes.report(ms, slots.length);
      this.onProbeTimed?.(ms, slots.length, passes);
    });
  }

  /**
   * What a probe update reads, up to date: the traced scene, the cache's
   * textures and the resolve tables (packed with the traced scene, the same
   * object order, and again when the residency changed). False: no tables yet.
   */
  syncProbeInputs(now = performance.now()): boolean {
    this.syncScene(now);
    this.ensureTextures();
    // The tables follow the packed scene (the same version), never a newer one the pack has not caught up with.
    const version = this.host.traceVersion;
    if (version === this.sceneVersion && (version !== this.resolvedFor || this.host.residencyVersion !== this.resolvedResidency)) {
      this.probePass.resolve.setTable(packResolveTable(this.host.resolveScene().scene, this.host.cache).words);
      this.resolvedFor = version;
      this.resolvedResidency = this.host.residencyVersion;
    }
    return this.resolvedFor >= 0;
  }

  /**
   * Trace `count` reflection rays (`rays`, `RAY_FLOATS` each, on this
   * device) and write each one's light at its hit into `out`
   * (`surface-reflection-pass.ts`). False: nothing to trace yet (no scene,
   * tables or textures).
   */
  traceReflections(rays: GpuBuffer, out: GpuBuffer, count: number): boolean {
    if (!this.syncProbeInputs() || this.atlas === null || this.rings === null || !this.pass.tracer.ready) return false;
    const albedo = this.albedoForProbes();
    const probes = this.host.probes;
    this.reflectionPass.run({ rays, out, count, probes, records: this.probePass.recordsFor(probes), sky: this.sky, rooms: this.host.rooms()?.words ?? null, atlas: this.atlas, rings: this.rings, albedo: albedo.buffer, albedoRingsAt: albedo.ringsAt, resolve: this.probePass.resolve });
    return true;
  }

  private lightTexels(lights: readonly CacheLight[], now: number): void {
    const slices = this.host.slicesThisFrame();
    if (slices.length === 0) return;
    this.syncScene(now);
    this.ensureTextures();
    const f = lightFrameOf(this.host, lights, this.points, this.host.rooms(), this.host.cache.rayScale);
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
    this.viewReading += 1;
    read.mapAsync(USAGE.MAP_READ).then(
      () => {
        this.viewReading -= 1;
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
      () => {
        this.viewReading -= 1;
        read.destroy();
      },
    );
  }

  dispose(): void {
    if (this.source === null) {
      for (const t of [this.atlas, this.rings]) t?.destroy();
      this.albedo?.buffer.destroy();
    }
    this.noAlbedo?.destroy();
    this.addrBuf?.destroy();
    this.countBuf.destroy();
    this.probePass.dispose();
    this.reflectionPass.dispose();
    this.pass.dispose();
    this.atlas = this.rings = this.addrBuf = null;
    this.albedo = null;
  }
}
