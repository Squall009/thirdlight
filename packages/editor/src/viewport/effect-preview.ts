/**
 * Phase 20.3: the Effect tab's looping preview pane — one effect on a
 * timeline, with its own renderer (the three-adapter factory, the editor's
 * backend choice), the project environment (the same environment renderer
 * as the Scene view) and an orbit camera framed on the effect's bounds.
 *
 * - Executor: the same choice as Play (`EffectTimeline`): WebGPU compute
 *   where the renderer draws on WebGPU and the graph allows it, the CPU
 *   reference evaluator on WebGL 2.
 * - Timeline: play / pause / restart / scrub. Time runs in fixed 1/60 s
 *   steps; a scrub re-simulates from the seed up to t (deterministic: the
 *   same t gives the same particles and counters). At the preview length
 *   the preview starts over (it loops).
 * - Live: a changed effect (graph, settings, parameters), a changed
 *   preview-only parameter override or a changed wind rebuilds the play and
 *   re-simulates to the current time (rebuilds are coalesced to one per
 *   REBUILD_INTERVAL_MS while a slider moves).
 * - Stats: per system the particles spawned since the start and living now,
 *   and the frame cost — GPU timestamp queries where the device has them
 *   (simulation = compute passes, draw = render passes), else the CPU time
 *   of the simulation step and the render call, labelled as such.
 * - Disposal: `dispose()` releases the play (buffers, geometries,
 *   materials), the environment, the renderer (and its WebGL context) and
 *   checks that the renderer's geometry/attribute counts went back to what
 *   they were before the first play was built (the leak ledger on
 *   `<html data-tl-effect-previews>`, read by the e2e and by phase 21.5).
 *
 * Self-contained (its own renderer, scene and loop): the Scene view's
 * render loop is not involved. Browser-only.
 */
import {
  createEnvironmentRenderer,
  createRenderer,
  EffectTimeline,
  type EffectDefLike,
  type EffectSystemCounter,
  type EnvironmentLike,
  type EnvironmentRenderer,
  type RendererHandle,
  type RendererInfo,
  type WindLike,
} from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { editorRendererChoice } from './renderer-choice';

type AnyRenderer = NonNullable<ReturnType<RendererHandle['current']>>;

/** Coalesce rebuilds while a slider moves (a WebGPU rebuild compiles compute pipelines). */
const REBUILD_INTERVAL_MS = 120;
/** How often the stats are published (ms). */
const STATS_INTERVAL_MS = 200;
/** The longest preview length (s): a scrub re-simulates up to 3600 steps at most. */
export const PREVIEW_MAX_LENGTH = 60;

/** A preview-only parameter value (as the effect's parameter defaults). */
export type PreviewParamValue = number | readonly number[] | string;

export interface EffectPreviewStats {
  /** Renderer backend (null while starting). */
  backend: string | null;
  executor: 'webgpu' | 'cpu' | null;
  /** Why a WebGPU renderer runs this effect on the CPU. */
  reason: string | null;
  time: number;
  steps: number;
  length: number;
  playing: boolean;
  systems: EffectSystemCounter[];
  /**
   * Frame cost per drawn frame (ms), averaged over the last stats interval,
   * and how each part was measured: `gpu` = timestamp queries (the WebGPU
   * executor's compute passes; the render passes), `cpu` = main-thread time
   * (the CPU executor's simulation; the render call where the device has no
   * timestamp queries).
   */
  cost: { simulation: number; simulationBy: 'gpu' | 'cpu'; draw: number; drawBy: 'gpu' | 'cpu' } | null;
  /** Compile problems (errors) of the effect. */
  errors: number;
}

export interface EffectPreviewOptions {
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  loadModel?: (assetId: string) => Promise<THREE.Object3D | null>;
  onStats?: (s: EffectPreviewStats) => void;
}

/** The renderer's memory counts the effect's objects occupy (textures come from the editor's shared cache: not counted). */
type MemoryCounts = { geometries: number; attributes: number; indexAttributes: number; storageAttributes: number };
const MEMORY_KEYS: readonly (keyof MemoryCounts)[] = ['geometries', 'attributes', 'indexAttributes', 'storageAttributes'];

interface Ledger {
  open: number;
  opened: number;
  closed: number;
  /** Closes whose counts did not return to their baseline. */
  leaks: number;
  /** The last close: its baseline and the counts after the play was released. */
  last: { baseline: MemoryCounts; after: MemoryCounts } | null;
}
const ledger: Ledger = { open: 0, opened: 0, closed: 0, leaks: 0, last: null };
function publishLedger(): void {
  try {
    document.documentElement.setAttribute('data-tl-effect-previews', JSON.stringify(ledger));
  } catch {
    /* diagnostics only */
  }
}

/** The effect with preview-only parameter values as its defaults (works for public and private parameters alike). */
export function withPreviewParams(def: EffectDefLike, overrides: Readonly<Record<string, PreviewParamValue>>): EffectDefLike {
  if (Object.keys(overrides).length === 0 || def.parameters === undefined) return def;
  return { ...def, parameters: def.parameters.map((p) => (overrides[p.key] !== undefined ? { ...p, default: overrides[p.key] as never } : p)) };
}

export class EffectPreview {
  readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
  private readonly renderer: RendererHandle;
  private readonly orbit: OrbitControls;
  private readonly key = new THREE.DirectionalLight(0xffffff, 1.4);
  private readonly fill = new THREE.AmbientLight(0xa0b0c8, 0.6);
  private readonly grid = new THREE.GridHelper(4, 8, 0x3a4050, 0x262a34);
  private environment: EnvironmentRenderer | null = null;
  private environmentGeneration = -1;
  private environmentValue: (EnvironmentLike & { wind?: WindLike }) | null = null;
  private timeline: EffectTimeline | null = null;
  private timelineGeneration = -1;
  private def: EffectDefLike | null = null;
  private overrides: Readonly<Record<string, PreviewParamValue>> = {};
  private dirty = false;
  private lastBuild = 0;
  private framedFor: string | null = null;
  private wantSeek: number | null = null;
  private length = 2;
  private playing = true;
  private raf = 0;
  private sizedFor = -1;
  private lastNow: number | null = null;
  private frames = 0;
  private disposed = false;
  private baseline: MemoryCounts | null = null;
  // Frame cost accumulators (since the last stats publish).
  private costFrames = 0;
  private cpuSim = 0;
  private cpuDraw = 0;
  private gpuSim = 0;
  private gpuDraw = 0;
  private gpuFrames = 0;
  private framesUnresolved = 0;
  private resolving = false;
  private lastCost: EffectPreviewStats['cost'] = null;
  private lastStats = 0;
  private lastLivingRead = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: EffectPreviewOptions,
  ) {
    const choice = editorRendererChoice();
    // The canvas is never drawn to again after dispose (a new tab makes a new canvas): drop its WebGL context then,
    // so opening and closing the tab never piles up contexts (the browser would start losing the oldest — the Scene view's).
    this.renderer = createRenderer({ canvas, preference: choice.preference, source: choice.source, antialias: true, clearColor: 0x000000, clearAlpha: 1, loseContextOnDispose: true, trackTimestamp: true });
    this.scene.background = new THREE.Color(0x14161c);
    this.key.position.set(3, 5, 4);
    this.scene.add(this.key, this.fill, this.grid);
    this.camera.position.set(0, 2, 6);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();
    ledger.open += 1;
    ledger.opened += 1;
    publishLedger();
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  info(): RendererInfo {
    return this.renderer.info();
  }

  frameCount(): number {
    return this.frames;
  }

  /** The effect shown (a new object = an edit: the play is rebuilt at the current time). */
  setEffect(def: EffectDefLike | null): void {
    if (def === this.def) return;
    this.def = def;
    this.dirty = true;
  }

  /** Preview-only parameter values (never saved). */
  setOverrides(values: Readonly<Record<string, PreviewParamValue>>): void {
    this.overrides = values;
    this.dirty = true;
  }

  /** The project environment (null: a neutral dark backdrop) and its wind (the Wind block follows it). */
  setEnvironment(env: (EnvironmentLike & { wind?: WindLike }) | null): void {
    const windChanged = JSON.stringify(env?.wind ?? null) !== JSON.stringify(this.environmentValue?.wind ?? null);
    this.environmentValue = env;
    this.environment?.set(env);
    if (windChanged) this.dirty = true;
  }

  /** The timeline's length (s): scrub range and loop point. */
  setLength(seconds: number): void {
    this.length = Math.min(PREVIEW_MAX_LENGTH, Math.max(0.1, seconds));
    if (this.timeline !== null && this.timeline.time > this.length) this.wantSeek = 0;
  }

  play(): void {
    this.playing = true;
    this.lastNow = null;
  }

  pause(): void {
    this.playing = false;
  }

  /** Back to time 0 (keeps playing or paused as it was). */
  restart(): void {
    this.wantSeek = 0;
  }

  /** Re-simulate from the seed up to t (applied on the next frame; the last request wins). */
  seek(t: number): void {
    this.wantSeek = Math.min(this.length, Math.max(0, t));
  }

  stats(): EffectPreviewStats {
    const tl = this.timeline;
    const info = this.renderer.info();
    return {
      backend: info.backend,
      executor: tl?.executor ?? null,
      reason: tl?.reason ?? null,
      time: tl?.time ?? 0,
      steps: tl?.stepCount ?? 0,
      length: this.length,
      playing: this.playing,
      systems: tl?.counters() ?? [],
      cost: this.lastCost,
      errors: tl?.diagnostics().filter((d) => d.severity === 'error').length ?? 0,
    };
  }

  private frame(): void {
    if (this.disposed) return;
    const r = this.renderer.ready() ? this.renderer.current() : null;
    if (r === null) return;
    this.resize(r);
    const env = this.ensureEnvironment();
    const now = performance.now();
    // The baseline: what the renderer holds before any play exists (after the first frame drew the backdrop).
    if (this.baseline === null) {
      if (this.frames > 0) this.baseline = memoryOf(r);
    } else this.ensureTimeline(r, now);
    const tl = this.timeline;
    const t0 = performance.now();
    if (tl !== null) {
      if (this.wantSeek !== null) {
        tl.seek(this.wantSeek);
        this.wantSeek = null;
        this.lastNow = null;
      } else if (this.playing) {
        const dt = this.lastNow === null ? 0 : (now - this.lastNow) / 1000;
        tl.advance(dt);
        // The preview loops: at its length it starts over from the seed.
        if (tl.time >= this.length - 1e-9) tl.seek(0);
      }
      this.lastNow = now;
      tl.draw(this.camera);
    }
    const t1 = performance.now();
    if (env !== null) env.render(this.camera);
    else r.render(this.scene, this.camera);
    const t2 = performance.now();
    this.frames += 1;
    this.costFrames += 1;
    this.cpuSim += t1 - t0;
    this.cpuDraw += t2 - t1;
    this.framesUnresolved += 1;
    this.resolveTimestamps(r);
    if (tl !== null && tl.executor === 'webgpu' && now - this.lastLivingRead > 250) {
      this.lastLivingRead = now;
      tl.readLiving();
    }
    if (now - this.lastStats >= STATS_INTERVAL_MS) {
      this.lastStats = now;
      this.publishCost();
      const s = this.stats();
      this.canvas.dataset['tlEffectPreview'] = JSON.stringify({ executor: s.executor, time: Math.round(s.time * 1000) / 1000, steps: s.steps, playing: s.playing, systems: s.systems.map((x) => ({ id: x.systemId, spawned: x.spawned, living: x.living })), cost: s.cost === null ? null : `${s.cost.simulationBy}/${s.cost.drawBy}` });
      this.options.onStats?.(s);
    }
  }

  /** Whether this renderer records GPU timestamps (the device's timestamp feature). */
  private timestamps(r: AnyRenderer): boolean {
    const b = (r as unknown as { backend?: { trackTimestamp?: boolean; disjoint?: unknown } }).backend;
    return b?.trackTimestamp === true && (b.disjoint === undefined || b.disjoint !== null);
  }

  private resolveTimestamps(r: AnyRenderer): void {
    if (this.resolving || !this.timestamps(r)) return;
    this.resolving = true;
    // The queries recorded since the last resolve (one or more frames: a resolve is in flight for a while).
    const frames = this.framesUnresolved;
    this.framesUnresolved = 0;
    const gpuSim = this.timeline?.executor === 'webgpu';
    const rr = r as unknown as { resolveTimestampsAsync(type: string): Promise<number | undefined> };
    void Promise.all([gpuSim ? rr.resolveTimestampsAsync('compute') : Promise.resolve(0), rr.resolveTimestampsAsync('render')]).then(
      ([sim, draw]) => {
        this.resolving = false;
        if (this.disposed) return;
        this.gpuSim += Number(sim ?? 0);
        this.gpuDraw += Number(draw ?? 0);
        this.gpuFrames += frames;
      },
      () => {
        this.resolving = false;
      },
    );
  }

  private publishCost(): void {
    const r = this.renderer.current();
    const gpuSim = this.timeline?.executor === 'webgpu';
    if (r !== null && this.timestamps(r) && this.gpuFrames > 0 && this.costFrames > 0) {
      this.lastCost = gpuSim
        ? { simulation: this.gpuSim / this.gpuFrames, simulationBy: 'gpu', draw: this.gpuDraw / this.gpuFrames, drawBy: 'gpu' }
        : { simulation: this.cpuSim / this.costFrames, simulationBy: 'cpu', draw: this.gpuDraw / this.gpuFrames, drawBy: 'gpu' };
    } else if (this.costFrames > 0 && (r === null || !this.timestamps(r))) {
      this.lastCost = { simulation: this.cpuSim / this.costFrames, simulationBy: 'cpu', draw: this.cpuDraw / this.costFrames, drawBy: 'cpu' };
    }
    this.costFrames = 0;
    this.cpuSim = 0;
    this.cpuDraw = 0;
    this.gpuSim = 0;
    this.gpuDraw = 0;
    this.gpuFrames = 0;
  }

  /** Build (or rebuild after an edit or a new renderer) the play, re-simulated to the current time. */
  private ensureTimeline(r: AnyRenderer, now: number): void {
    const generation = this.renderer.generation();
    const stale = this.timelineGeneration !== generation;
    if (!stale && !this.dirty) return;
    if (!stale && this.timeline !== null && now - this.lastBuild < REBUILD_INTERVAL_MS) return;
    const at = this.wantSeek ?? this.timeline?.time ?? 0;
    this.timeline?.dispose();
    this.timeline = null;
    this.dirty = false;
    this.lastBuild = now;
    this.timelineGeneration = generation;
    const def = this.def;
    if (def === null || def.systems.length === 0) return;
    const api = this.renderer.info().api === 'webgpu' ? 'webgpu' : 'webgl2';
    const wind = this.environmentValue?.wind ?? null;
    this.timeline = new EffectTimeline({
      scene: this.scene as never,
      renderer: r as never,
      api,
      def: withPreviewParams(def, this.overrides),
      ...(wind !== null ? { wind: { direction: [...wind.direction], strength: wind.strength, gust: wind.gust, gustFrequency: wind.gustFrequency, turbulence: wind.turbulence } } : {}),
      loadTexture: this.options.loadTexture as never,
      ...(this.options.loadModel !== undefined ? { loadModel: this.options.loadModel as never } : {}),
    });
    this.wantSeek = Math.min(at, this.length);
    const frameKey = JSON.stringify(def.bounds);
    if (this.framedFor !== frameKey) {
      this.framedFor = frameKey;
      this.frameBounds(def.bounds);
    }
  }

  /** Point the camera at the effect's bounds box (the grid sits at the effect's origin). */
  private frameBounds(b: EffectDefLike['bounds']): void {
    const center = new THREE.Vector3(b.center[0], b.center[1], b.center[2]);
    const radius = Math.max(0.25, new THREE.Vector3(b.size[0], b.size[1], b.size[2]).length() / 2);
    const distance = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 0.9;
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(0, 0.3, 1).normalize(), distance);
    this.camera.near = distance / 200;
    this.camera.far = distance * 50;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private ensureEnvironment(): EnvironmentRenderer | null {
    const r = this.renderer.current();
    if (r === null || this.environmentValue === null) return null;
    if (this.environment !== null && this.environmentGeneration === this.renderer.generation()) return this.environment;
    this.environment?.dispose();
    this.environmentGeneration = this.renderer.generation();
    const env = createEnvironmentRenderer(r, this.scene, { loadTexture: this.options.loadTexture });
    env.resize(Math.max(1, this.canvas.clientWidth), Math.max(1, this.canvas.clientHeight));
    env.setKeyLightDirection([-3, -5, -4]);
    env.set(this.environmentValue);
    this.environment = env;
    return env;
  }

  private resize(r: NonNullable<ReturnType<RendererHandle['current']>>): void {
    if (this.sizedFor !== this.renderer.generation()) {
      this.sizedFor = this.renderer.generation();
      r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const size = r.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    r.setSize(w, h, false);
    this.environment?.resize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const r = this.renderer.current();
    this.timeline?.dispose();
    this.timeline = null;
    ledger.open -= 1;
    ledger.closed += 1;
    if (r !== null && this.baseline !== null) {
      const after = memoryOf(r);
      if (MEMORY_KEYS.some((k) => after[k] > this.baseline![k])) ledger.leaks += 1;
      ledger.last = { baseline: this.baseline, after };
    }
    publishLedger();
    this.orbit.dispose();
    this.environment?.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}

function memoryOf(r: AnyRenderer): MemoryCounts {
  const m = (r as unknown as { info: { memory: Record<string, number> } }).info.memory;
  return { geometries: m['geometries'] ?? 0, attributes: m['attributes'] ?? 0, indexAttributes: m['indexAttributes'] ?? 0, storageAttributes: m['storageAttributes'] ?? 0 };
}
