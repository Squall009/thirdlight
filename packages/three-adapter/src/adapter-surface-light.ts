/**
 * The adapter's live surface-cache light (`surface-light-runtime.ts`): on a
 * WebGPU renderer whose quality level gives the cache a GPU budget
 * (`surfaceLightMs` > 0: the medium and high tiers), the host's stale texels
 * are lit on the renderer's own device each frame; elsewhere (WebGL 2, the
 * low tier) the host stays not live and nothing is lit.
 *
 * A debug look at the cache (`setView`, or `?surfaceCacheView=1` on the
 * page) draws every lit texel as a small square on its surface, coloured by
 * its light as a mid-grey surface would show it: what the cache holds
 * (its direct light) and the bounce its room's probes add there, whether
 * or not materials read it yet. The live probes stand in for the bakes'
 * probe tiles meanwhile (`adapter-live-probes.ts`).
 *
 * While the light is live, static surfaces read it (`surface-cache-read.ts`):
 * the cache's textures are three's (the pass writes the GPU textures behind
 * them), its lookup is packed again whenever what is resident changes
 * (at most every `LOOKUP_MS`), and the scene says it may be read once the
 * first lookup is up.
 */
import * as THREE from 'three';

import { pageSearch, type AnyRenderer } from './renderer-factory';
import type { EntityDoc } from './adapter-entities';
import { SurfaceLights } from './adapter-surface-cache';
import type { SceneLights } from './lights-shadows';
import type { RenderGraph } from './render-graph';
import type { SurfaceCacheHost } from './surface-cache-host';
import { SurfaceLightRuntime, type SurfaceTextureSource } from './surface-light-runtime';
import { TEXEL_POINT_FLOATS } from './surface-texels';
import { cacheSuns } from './surface-light-frame';
import { AdapterLiveProbes } from './adapter-live-probes';
import type { ProbeLightingHost } from './probe-grids';
import { PROBE_HIT_LIFT, probesIrradianceAt } from './surface-probes';
import type { GpuBuffer, GpuTexture, TracerDevice } from './tracer-gpu';
import { SURFACE_PAGE_BYTES } from './surface-cache-atlas';
import { TERRAIN_RING_SHARE } from './surface-cache';
import { TERRAIN_RINGS_MAX, TERRAIN_RING_BYTES } from './surface-cache-terrain';
import { packSurfaceLookup, SURFACE_READ } from './surface-cache-lookup';
import { SURFACE_READ_ALL, SURFACE_READ_LIVE_KEY, SurfaceCacheTextures } from './surface-cache-read';
import { savedLights, type CacheLight, type ColourChanges } from './surface-changes';
import { runSurfaceBake, type BakePart, type SurfaceBakeOptions, type SurfaceBakeOutcome } from './adapter-surface-bake';
import { AdapterSavedLight, LOOKUP_MS, type SavedLightDiagnostics, type SurfaceBakeLike } from './adapter-saved-light';
import { REFLECTION_TRACER_KEY, type ReflectionTracer } from './post-reflections';
import { AdapterLightingViews, type LightingViewCounts, type LightingViewState } from './adapter-lighting-views';

/** How often (ms) the debug look is drawn again while texels change. */
const VIEW_MS = 200;
/** The albedo the debug look shows light on (a mid-grey surface). */
const VIEW_ALBEDO = 0.5;
/** How far (m) the debug squares stand off their surfaces. */
const VIEW_LIFT = 0.01;
/** The page flag that keeps materials off the cache while it is lit live (`?surfaceRead=0`), or names the kinds that read it (`?surfaceRead=blocks,model`: each kind's cost, by comparison). */
export const SURFACE_READ_URL_PARAM = 'surfaceRead';
/** `?surfaceHighlights=0`: reading pixels draw no area light's highlight (a comparison of what they cost). */
export const SURFACE_HIGHLIGHTS_URL_PARAM = 'surfaceHighlights';

/** The kinds a `surfaceRead` flag names (a bit per `SURFACE_READ` kind; no flag or no known name: all). */
export function surfaceReadKinds(flag: string | null): number {
  let bits = 0;
  for (const name of (flag ?? '').split(',')) {
    const kind = (SURFACE_READ as Record<string, number>)[name.trim()];
    if (kind !== undefined) bits |= 1 << kind;
  }
  return bits === 0 ? SURFACE_READ_ALL : bits;
}
/** Every how many frames the reading draws write their surfaces' colours (a draw that writes loses early depth culling). */
const ALBEDO_CAPTURE_FRAMES = 30;
/** Shortest time (ms) between two read-backs of the surfaces' colours for the diagnostics. */
const ALBEDO_READ_MS = 2000;

/** The renderer's WebGPU device (three's WebGPU backend keeps it as `backend.device`), or null on WebGL 2. */
function deviceOf(renderer: AnyRenderer): TracerDevice | null {
  const b = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean; device?: TracerDevice | null } }).backend;
  return b?.isWebGPUBackend === true && b.device != null ? b.device : null;
}

/** The live light on the page: whether it runs, why not, and the debug look's squares. */
export interface SurfaceLightDiagnostics {
  readonly live: boolean;
  /** Why it is not live (null: it is). */
  readonly off: 'no-budget' | 'no-webgpu' | 'failed' | 'starting' | null;
  readonly view: boolean;
  /** Texels the debug look draws. */
  readonly viewTexels: number;
  /** Whether static surfaces read the cache now, and the bytes of their lookup. */
  readonly read: boolean;
  readonly lookupBytes: number;
  /**
   * Cells of the surfaces' colours the materials have drawn, as last read
   * back (null: not read yet; a read is asked by this call until one finds
   * colours drawn under the current lookup: the read copies the whole buffer
   * back, too dear to repeat while a diagnostics panel or harness polls).
   */
  readonly albedoDrawn: number | null;
  /** Frames that wrote the surfaces' colours so far. */
  readonly captures: number;
  /** The saved lighting drawn while the light is not live (WebGL 2, the low tier, a live light still starting). */
  readonly saved: SavedLightDiagnostics;
}

export class AdapterSurfaceLight {
  private runtime: SurfaceLightRuntime | null = null;
  private device: TracerDevice | null = null;
  private failed = false;
  private viewOn: boolean;
  private view: THREE.InstancedMesh | null = null;
  private viewVersion = -1;
  private viewAt = -Infinity;
  private viewTexels = 0;
  private off: SurfaceLightDiagnostics['off'] = 'starting';
  readonly lights: SurfaceLights;
  private readonly liveProbes: AdapterLiveProbes | null;
  /** What materials read (made with the first live runtime). */
  private textures: SurfaceCacheTextures | null = null;
  private lookupFor = '';
  /** `?surfaceRead=0`: the cache is lit but no material reads it (a comparison of what reading costs and changes). */
  private readonly readOn: boolean;
  /** The kinds of surface that read (a bit per `SURFACE_READ` kind). */
  private readonly readKinds: number;
  private readonly highlightsOn: boolean;
  private lookupAt = -Infinity;
  /** The budget the textures were made for (another quality level's makes them again). */
  private budgetFor = -1;
  private albedoDrawn: number | null = null;
  private albedoAsked = false;
  private albedoReading = false;
  private albedoAt = -Infinity;
  /** The lookup the last read-back was made under. */
  private albedoFor = '';
  private frames = 0;
  private captures = 0;
  /** Where colours changed, written on frame `colourFrame`: marked on the probes the frame after (null: none waits). */
  private colourMarks: ColourChanges | null = null;
  private colourFrame = -1;
  /** Every light as the cache last saw them (a bake saves the ones it keeps). */
  private allLights: readonly CacheLight[] = [];
  /** A bake's part: the lights whose light it saves light the cache (null: every light, live). */
  private part: BakePart = null;

  /** The scenes' saved lighting, drawn where the light is not live. */
  private readonly saved: AdapterSavedLight;
  /** Something drawn changed (a host drawing on demand draws again). */
  private readonly changed: () => void;
  /** The rooms and stale-pages debug views (the cache and probe views are this page's own). */
  private readonly views: AdapterLightingViews;

  constructor(private readonly host: SurfaceCacheHost, private readonly scene: THREE.Scene, docs: ReadonlyMap<string, EntityDoc>, graph: RenderGraph, probes: ProbeLightingHost | null = null, lighting: { bakes: Readonly<Record<string, { surface?: SurfaceBakeLike } | undefined>> | null; loadBytes?: ((assetId: string) => Promise<Uint8Array>) | undefined; changed?: () => void } = { bakes: null }) {
    this.lights = new SurfaceLights(docs, graph);
    this.liveProbes = probes === null ? null : new AdapterLiveProbes(host, probes, scene);
    this.changed = lighting.changed ?? (() => undefined);
    this.saved = new AdapterSavedLight(host, scene, probes, lighting.loadBytes, this.changed);
    this.saved.setBakes(lighting.bakes);
    const q = new URLSearchParams(pageSearch());
    this.viewOn = q.get('surfaceCacheView') === '1';
    this.views = new AdapterLightingViews(host, scene);
    this.views.set({ cache: this.viewOn, probes: q.get('probesView') === '1', rooms: false, stale: false });
    const read = q.get(SURFACE_READ_URL_PARAM);
    this.readOn = read !== '0';
    this.readKinds = surfaceReadKinds(read);
    this.highlightsOn = q.get(SURFACE_HIGHLIGHTS_URL_PARAM) !== '0';
  }

  /** Before the frame's programs are built (ahead of the probes' frame): whether the light is live with probes, so the probe light joins before the programs are built. */
  prepare(renderer: AnyRenderer): void {
    this.liveProbes?.hold(!this.failed && this.host.relightBudgetMs > 0 && deviceOf(renderer) !== null);
    if (this.runtime === null) this.saved.prepare();
  }

  /** The project's bakes (their saved lighting is drawn where the light is not live). */
  setBakes(bakes: Readonly<Record<string, { surface?: SurfaceBakeLike } | undefined>> | null): void {
    this.saved.setBakes(bakes);
  }

  /** The realized scenes (their saved lighting is drawn). */
  followScenes(sceneIds: readonly string[]): void {
    this.saved.follow(sceneIds);
  }

  /** Before a frame's draw: the cache's lights, its residency and stale work, then this frame's light on the GPU. */
  beforeFrame(renderer: AnyRenderer, sceneLights: SceneLights, eye: ArrayLike<number>): void {
    const all = this.lights.now(sceneLights);
    this.allLights = all;
    const lights = this.part === null ? all : savedLights(all, this.part);
    this.host.setLights(lights);
    this.host.update(eye);
    const gpu = deviceOf(renderer);
    const device = this.failed || this.host.relightBudgetMs <= 0 ? null : gpu;
    if (device !== this.device || (device !== null && this.host.cache.budgetBytes !== this.budgetFor)) this.drop(device, renderer);
    this.off = this.runtime !== null ? null : this.failed ? 'failed' : this.host.relightBudgetMs <= 0 ? 'no-budget' : gpu === null ? 'no-webgpu' : 'starting';
    if (this.runtime !== null) this.runtime.drawnSuns = this.lights.drawnSuns;
    this.runtime?.frame(lights);
    this.syncRead(all, lights, renderer, eye);
    // Until the light is live (WebGL 2, a level without a live budget, a live light still starting) the saved light is drawn.
    if (this.runtime === null && this.readOn) this.saved.frame();
    else {
      this.saved.drop();
      // Live: the saved light is where it starts.
      this.saved.seed();
    }
    this.liveProbes?.frame(renderer, this.runtime);
    this.drawView();
    this.views.frame();
  }

  /** The lighting's debug views (an editor's Scene view menu). */
  setLightingView(state: LightingViewState): void {
    this.views.set(state);
    this.setView(state.cache);
    this.liveProbes?.setView(state.probes);
  }

  /** The debug views drawn and what they hold. */
  lightingView(): LightingViewState & LightingViewCounts {
    const probes = this.liveProbes?.viewCounts() ?? { spheres: 0, invalid: 0 };
    return { ...this.views.views, cacheTexels: this.viewOn && this.view !== null ? this.viewTexels : 0, probeSpheres: probes.spheres, invalidProbes: probes.invalid, ...this.views.counts() };
  }

  /** Why the light is not live (null: it is), and the reflections' last traced pass (null: none). */
  get offReason(): SurfaceLightDiagnostics['off'] {
    return this.off;
  }

  reflectionsTraced(): { ms: number | null; rays: number } | null {
    const pass = this.runtime?.reflectionPass;
    return pass === undefined || pass.lastRays === 0 ? null : { ms: pass.lastMs, rays: pass.lastRays };
  }

  /** What materials read, up to date: the lookup packed again when residency changed, the sun the texels were lit with; the scene says so once both are up. */
  private syncRead(lights: readonly CacheLight[], lit: readonly CacheLight[], renderer: AnyRenderer, eye: ArrayLike<number>): void {
    const tex = this.textures;
    if (this.runtime === null || tex === null || !this.readOn) {
      delete this.scene.userData[SURFACE_READ_LIVE_KEY];
      return;
    }
    // The suns' share is taken out of a texel where they are drawn per pixel (a light held by a bake is not): their summed colour.
    const sun = [0, 0, 0];
    for (const l of cacheSuns(lit)) if (this.lights.drawnSuns.has(l.id)) for (let i = 0; i < 3; i += 1) sun[i]! += l.color[i] ?? 0;
    tex.sun.value.setRGB(sun[0]!, sun[1]!, sun[2]!);
    tex.highlights.set(this.highlightsOn ? lights : [], eye);
    const key = `${this.host.traceVersion}/${this.host.residencyVersion}/${this.host.modelSlots.version}`;
    const now = performance.now();
    if (key !== this.lookupFor && now - this.lookupAt >= LOOKUP_MS) {
      tex.setTable(packSurfaceLookup(this.host.resolveScene().scene, this.host.cache, (tileKey) => this.host.modelSlots.peek(tileKey)));
      this.lookupFor = key;
      this.lookupAt = now;
    }
    tex.readKinds = this.readKinds;
    if (this.lookupFor !== '') this.scene.userData[SURFACE_READ_LIVE_KEY] = tex;
    // The surfaces' colours are written one frame now and then, only where probes bounce them.
    this.frames += 1;
    // Written last frame where colours had changed: the probes there bounce the new ones now.
    if (this.colourMarks !== null && this.frames > this.colourFrame) {
      this.host.colours.mark(this.colourMarks);
      this.colourMarks = null;
    }
    // Colours changed (a surface made again, a material edited) and the lookup holds them: written this frame.
    const recolour = this.colourMarks === null && key === this.lookupFor && this.host.colours.waiting;
    if (recolour) {
      this.colourMarks = this.host.colours.take();
      this.colourFrame = this.frames;
    }
    tex.capture = this.host.probes.count > 0 && (recolour || this.frames % ALBEDO_CAPTURE_FRAMES === 0);
    if (tex.capture) this.captures += 1;
    const albedoSeen = (this.albedoDrawn ?? 0) > 0 && this.albedoFor === this.lookupFor;
    if (this.albedoAsked && !albedoSeen && !this.albedoReading && now - this.albedoAt >= ALBEDO_READ_MS) {
      this.albedoAt = now;
      this.readAlbedo(renderer);
    }
  }

  /** Counts the surfaces' colours the materials drew (a diagnostics read: asked by `diagnostics`, done a frame or two later). */
  private readAlbedo(renderer: AnyRenderer): void {
    const tex = this.textures;
    const r = renderer as unknown as { getArrayBufferAsync?(a: unknown): Promise<ArrayBuffer> };
    if (tex === null || tex.albedo === null || typeof r.getArrayBufferAsync !== 'function' || tex.gpuAlbedo(renderer) === null) return;
    const albedo = tex.albedo;
    this.albedoAsked = false;
    this.albedoReading = true;
    const lookup = this.lookupFor;
    r.getArrayBufferAsync(albedo).then(
      (bytes) => {
        const w = new Uint32Array(bytes);
        let n = 0;
        for (let i = 0; i < w.length; i += 1) if (w[i]! >>> 24 !== 0) n += 1;
        this.albedoDrawn = n;
        this.albedoFor = lookup;
        this.albedoReading = false;
      },
      () => {
        this.albedoReading = false;
      },
    );
  }

  /** A new device (or none): the old one's work goes; on a device, the pass is made and the host goes live when it is ready. */
  private drop(device: TracerDevice | null, renderer: AnyRenderer): void {
    this.runtime?.dispose();
    this.runtime = null;
    this.host.setLive(false);
    delete this.scene.userData[SURFACE_READ_LIVE_KEY];
    delete this.scene.userData[REFLECTION_TRACER_KEY];
    this.lookupFor = '';
    this.textures?.dispose();
    this.textures = null;
    this.device = device;
    if (device === null) return;
    // The colours' buffer holds every page and ring layer the budget allows.
    const pages = Math.max(1, Math.ceil(this.host.cache.budgetBytes / SURFACE_PAGE_BYTES));
    const ringLayers = Math.max(1, Math.floor((this.host.cache.budgetBytes * TERRAIN_RING_SHARE) / TERRAIN_RING_BYTES)) * TERRAIN_RINGS_MAX;
    const tex = new SurfaceCacheTextures(pages, ringLayers);
    this.budgetFor = this.host.cache.budgetBytes;
    const source: SurfaceTextureSource = {
      texture: (which, layers) => tex.gpuTexture(renderer, which, layers) as GpuTexture,
      albedo: () => {
        const buffer = tex.gpuAlbedo(renderer) as GpuBuffer | null;
        return buffer === null ? null : { buffer, pages, ringsAt: tex.albedoRingsAt };
      },
    };
    SurfaceLightRuntime.create(device, this.host, source).then(
      (rt) => {
        if (this.device !== device) {
          rt.dispose();
          tex.dispose();
          return;
        }
        this.runtime = rt;
        this.textures = tex;
        rt.setView(this.viewOn);
        // A runtime made again (a bake's budget given back) under the cache view: its copy starts empty, and the light
        // may have settled before it came, so every unit is lit again for it as when the view is switched on.
        if (this.viewOn) this.markAllForView();
        this.host.setLive(true);
        // Reflection rays that leave the screen are traced here, on the same device.
        const tracer: ReflectionTracer = {
          trace: (rays, out, count) => rt.traceReflections(rays as GpuBuffer, out as GpuBuffer, count),
          msPerRay: () => rt.reflectionPass.msPerRay,
          last: () => ({ ms: rt.reflectionPass.lastMs, rays: rt.reflectionPass.lastRays }),
        };
        this.scene.userData[REFLECTION_TRACER_KEY] = tracer;
        // A host drawing on demand draws the live light now (it had drawn the saved light while this started).
        this.changed();
      },
      (e: unknown) => {
        // A device that cannot make the pass draws the saved light, as WebGL 2 does.
        console.warn(`surface cache: no live light (${e instanceof Error ? e.message : String(e)})`);
        this.failed = true;
      },
    );
  }

  /** "Bake lighting": this page's live light run to settled and read back (`adapter-surface-bake.ts`). */
  bake(o: SurfaceBakeOptions): Promise<SurfaceBakeOutcome> {
    return runSurfaceBake(
      {
        host: this.host,
        setPart: (part) => {
          this.part = part;
        },
        runtime: () => this.runtime,
        device: () => this.device,
        off: () => this.off,
        probeTiles: () => this.liveProbes?.savedTiles() ?? [],
        lights: () => savedLights(this.allLights, 'bounce'),
      },
      o,
    );
  }

  diagnostics(): SurfaceLightDiagnostics {
    const read = this.scene.userData[SURFACE_READ_LIVE_KEY] !== undefined;
    this.albedoAsked = true;
    return { live: this.runtime !== null, off: this.off, view: this.viewOn, viewTexels: this.viewTexels, read, lookupBytes: read ? ((this.textures?.table.image as { data?: Uint32Array } | undefined)?.data?.byteLength ?? 0) : 0, albedoDrawn: this.albedoDrawn, captures: this.captures, saved: this.saved.diagnostics() };
  }

  /** Whether the cache's light is computed live on this page. */
  get live(): boolean {
    return this.runtime !== null;
  }

  /** Whether the light drawn has caught up: live, nothing stale in the cache or the probes; else the followed scenes' saved light read (never while the live light is still starting). */
  get settled(): boolean {
    if (this.runtime !== null) return this.host.relight.isSettled && this.host.probes.isSettled;
    return this.off !== 'starting' && !this.saved.loading();
  }

  setView(on: boolean): void {
    const was = this.viewOn;
    this.viewOn = on;
    this.runtime?.setView(on);
    // The look reads texels back as they are lit: switched on over settled light, every unit is lit again (to the
    // same light; the probes keep theirs).
    if (on && !was && this.runtime !== null) this.markAllForView();
    if (!on) this.clearView();
  }

  private markAllForView(): void {
    this.host.relight.markUnits(this.host.relight.unitsIn([-Infinity, -Infinity, -Infinity], [Infinity, Infinity, Infinity]));
  }

  private clearView(): void {
    if (this.view === null) return;
    this.scene.remove(this.view);
    this.view.geometry.dispose();
    (this.view.material as THREE.Material).dispose();
    this.view = null;
    this.viewVersion = -1;
  }

  /** The cache view has texels read back, or on their way, that it has not drawn yet (a view drawn on demand asks for frames until it has). */
  get viewBehind(): boolean {
    const rt = this.runtime;
    return this.viewOn && rt !== null && (rt.viewReading > 0 || this.viewVersionOf(rt) !== this.viewVersion);
  }

  private viewVersionOf(rt: SurfaceLightRuntime): number {
    return rt.version * 1e6 + this.host.probes.diagnostics().updates;
  }

  private drawView(): void {
    const rt = this.runtime;
    // Drawn again when texels were read back or probes updated.
    if (!this.viewOn || rt === null) return;
    const version = this.viewVersionOf(rt);
    if (version === this.viewVersion) return;
    const now = performance.now();
    if (now - this.viewAt < VIEW_MS) return;
    this.viewAt = now;
    this.viewVersion = version;
    let n = 0;
    rt.forEach((_, light, texels) => {
      for (let i = 0; i < texels; i += 1) if (light[i * 3]! >= 0) n += 1;
    });
    if (this.view === null || this.view.instanceMatrix.count < n) {
      this.clearView();
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), Math.max(1, Math.ceil(n * 1.5)));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3), 3);
      mesh.frustumCulled = false;
      mesh.name = 'surface cache view';
      this.view = mesh;
      this.scene.add(mesh);
    }
    const mesh = this.view;
    const m = mesh.instanceMatrix.array as Float32Array;
    const probes = this.host.probes;
    const rooms = this.host.rooms()?.words ?? null;
    const bounce = [0, 0, 0];
    const c = mesh.instanceColor!.array as Float32Array;
    let k = 0;
    rt.forEach((pts, light, texels, size) => {
      for (let i = 0; i < texels; i += 1) {
        if (light[i * 3]! < 0) continue;
        const o = i * TEXEL_POINT_FLOATS;
        const nx = pts[o + 3]!, ny = pts[o + 4]!, nz = pts[o + 5]!;
        // A square on the surface: its plane's two axes, the normal out of it.
        const ax = Math.abs(nx) > 0.9 ? [0, 1, 0] : [1, 0, 0];
        let tx = ny * ax[2]! - nz * ax[1]!, ty = nz * ax[0]! - nx * ax[2]!, tz = nx * ax[1]! - ny * ax[0]!;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        m.set([tx * size, ty * size, tz * size, 0, bx * size, by * size, bz * size, 0, nx, ny, nz, 0, pts[o]! + nx * VIEW_LIFT, pts[o + 1]! + ny * VIEW_LIFT, pts[o + 2]! + nz * VIEW_LIFT, 1], k * 16);
        // Diffuse light off a mid-grey surface: albedo × (direct + its room's probes' bounce) / π.
        probesIrradianceAt(probes, [pts[o]! + nx * PROBE_HIT_LIFT, pts[o + 1]! + ny * PROBE_HIT_LIFT, pts[o + 2]! + nz * PROBE_HIT_LIFT], [nx, ny, nz], bounce, rooms);
        for (let q = 0; q < 3; q += 1) c[k * 3 + q] = (VIEW_ALBEDO * (light[i * 3 + q]! + bounce[q]!)) / Math.PI;
        k += 1;
      }
    });
    mesh.count = k;
    this.viewTexels = k;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.clearView();
    this.views.dispose();
    this.saved.drop();
    this.liveProbes?.dispose();
    this.runtime?.dispose();
    this.runtime = null;
    delete this.scene.userData[SURFACE_READ_LIVE_KEY];
    delete this.scene.userData[REFLECTION_TRACER_KEY];
    this.textures?.dispose();
    this.textures = null;
    this.device = null;
  }
}
