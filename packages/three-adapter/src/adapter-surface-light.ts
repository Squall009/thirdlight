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
import { SurfaceLightRuntime } from './surface-light-runtime';
import { TEXEL_POINT_FLOATS } from './surface-texels';
import { AdapterLiveProbes } from './adapter-live-probes';
import type { ProbeLightingHost } from './probe-grids';
import { PROBE_HIT_LIFT, probesIrradianceAt } from './surface-probes';
import type { GpuTexture, TracerDevice } from './tracer-gpu';
import { packSurfaceLookup } from './surface-cache-lookup';
import { SURFACE_READ_LIVE_KEY, SurfaceCacheTextures } from './surface-cache-read';
import type { CacheLight } from './surface-changes';

/** How often (ms) the debug look is drawn again while texels change. */
const VIEW_MS = 200;
/** The albedo the debug look shows light on (a mid-grey surface). */
const VIEW_ALBEDO = 0.5;
/** How far (m) the debug squares stand off their surfaces. */
const VIEW_LIFT = 0.01;
/** The page flag that keeps materials off the cache while it is lit live (`?surfaceRead=0`). */
export const SURFACE_READ_URL_PARAM = 'surfaceRead';
/** Shortest time (ms) between two packings of the materials' lookup while residency keeps changing. */
const LOOKUP_MS = 100;

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
  private lookupAt = -Infinity;

  constructor(private readonly host: SurfaceCacheHost, private readonly scene: THREE.Scene, docs: ReadonlyMap<string, EntityDoc>, graph: RenderGraph, probes: ProbeLightingHost | null = null) {
    this.lights = new SurfaceLights(docs, graph);
    this.liveProbes = probes === null ? null : new AdapterLiveProbes(host, probes, scene);
    const q = new URLSearchParams(pageSearch());
    this.viewOn = q.get('surfaceCacheView') === '1';
    this.readOn = q.get(SURFACE_READ_URL_PARAM) !== '0';
  }

  /** Before the frame's programs are built (ahead of the probes' frame): whether the light is live with probes, so the probe light joins before the programs are built. */
  prepare(renderer: AnyRenderer): void {
    this.liveProbes?.hold(!this.failed && this.host.relightBudgetMs > 0 && deviceOf(renderer) !== null);
  }

  /** Before a frame's draw: the cache's lights, its residency and stale work, then this frame's light on the GPU. */
  beforeFrame(renderer: AnyRenderer, sceneLights: SceneLights, eye: ArrayLike<number>): void {
    const lights = this.lights.now(sceneLights);
    this.host.setLights(lights);
    this.host.update(eye);
    const gpu = deviceOf(renderer);
    const device = this.failed || this.host.relightBudgetMs <= 0 ? null : gpu;
    if (device !== this.device) this.drop(device, renderer);
    this.off = this.runtime !== null ? null : this.failed ? 'failed' : this.host.relightBudgetMs <= 0 ? 'no-budget' : gpu === null ? 'no-webgpu' : 'starting';
    this.runtime?.frame(lights);
    this.syncRead(lights);
    this.liveProbes?.frame(renderer, this.runtime);
    this.drawView();
  }

  /** What materials read, up to date: the lookup packed again when residency changed, the sun the texels were lit with; the scene says so once both are up. */
  private syncRead(lights: readonly CacheLight[]): void {
    const tex = this.textures;
    if (this.runtime === null || tex === null || !this.readOn) {
      delete this.scene.userData[SURFACE_READ_LIVE_KEY];
      return;
    }
    const sun = lights.find((l) => l.on && l.kind === 'directional');
    tex.sun.value.setRGB(sun?.color[0] ?? 0, sun?.color[1] ?? 0, sun?.color[2] ?? 0);
    const { scene, version } = this.host.resolveScene();
    const key = `${version}/${this.host.residencyVersion}`;
    const now = performance.now();
    if (key !== this.lookupFor && now - this.lookupAt >= LOOKUP_MS) {
      tex.setTable(packSurfaceLookup(scene, this.host.cache));
      this.lookupFor = key;
      this.lookupAt = now;
    }
    if (this.lookupFor !== '') this.scene.userData[SURFACE_READ_LIVE_KEY] = tex;
  }

  /** A new device (or none): the old one's work goes; on a device, the pass is made and the host goes live when it is ready. */
  private drop(device: TracerDevice | null, renderer: AnyRenderer): void {
    this.runtime?.dispose();
    this.runtime = null;
    this.host.setLive(false);
    delete this.scene.userData[SURFACE_READ_LIVE_KEY];
    this.lookupFor = '';
    this.textures?.dispose();
    this.textures = null;
    this.device = device;
    if (device === null) return;
    const tex = new SurfaceCacheTextures();
    SurfaceLightRuntime.create(device, this.host, (which, layers) => tex.gpuTexture(renderer, which, layers) as GpuTexture).then(
      (rt) => {
        if (this.device !== device) {
          rt.dispose();
          tex.dispose();
          return;
        }
        this.runtime = rt;
        this.textures = tex;
        rt.setView(this.viewOn);
        this.host.setLive(true);
      },
      (e: unknown) => {
        // A device that cannot make the pass draws the saved light, as WebGL 2 does.
        console.warn(`surface cache: no live light (${e instanceof Error ? e.message : String(e)})`);
        this.failed = true;
      },
    );
  }

  diagnostics(): SurfaceLightDiagnostics {
    const read = this.scene.userData[SURFACE_READ_LIVE_KEY] !== undefined;
    return { live: this.runtime !== null, off: this.off, view: this.viewOn, viewTexels: this.viewTexels, read, lookupBytes: read ? ((this.textures?.table.image as { data?: Uint32Array } | undefined)?.data?.byteLength ?? 0) : 0 };
  }

  /** Whether the cache's light is computed live on this page. */
  get live(): boolean {
    return this.runtime !== null;
  }

  setView(on: boolean): void {
    this.viewOn = on;
    this.runtime?.setView(on);
    if (!on) this.clearView();
  }

  private clearView(): void {
    if (this.view === null) return;
    this.scene.remove(this.view);
    this.view.geometry.dispose();
    (this.view.material as THREE.Material).dispose();
    this.view = null;
    this.viewVersion = -1;
  }

  private drawView(): void {
    const rt = this.runtime;
    // Drawn again when texels were read back or probes updated.
    if (!this.viewOn || rt === null) return;
    const version = rt.version * 1e6 + this.host.probes.diagnostics().updates;
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
        probesIrradianceAt(probes.grids, probes.state, [pts[o]! + nx * PROBE_HIT_LIFT, pts[o + 1]! + ny * PROBE_HIT_LIFT, pts[o + 2]! + nz * PROBE_HIT_LIFT], [nx, ny, nz], bounce, rooms);
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
    this.liveProbes?.dispose();
    this.runtime?.dispose();
    this.runtime = null;
    delete this.scene.userData[SURFACE_READ_LIVE_KEY];
    this.textures?.dispose();
    this.textures = null;
    this.device = null;
  }
}
