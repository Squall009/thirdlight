/**
 * The preview pane's effect: one effect looping on a timeline in the pane's
 * stage, with the executor Play would use (`EffectTimeline`: WebGPU compute
 * where the renderer draws on WebGPU and the graph allows it, the CPU
 * reference evaluator on WebGL 2).
 *
 * - Timeline: play / pause / restart / scrub. Time runs in fixed 1/60 s
 *   steps; a scrub re-simulates from the seed up to t (deterministic: the
 *   same t gives the same particles and counters). At the preview length the
 *   preview starts over (it loops).
 * - Live: a changed effect, a changed preview-only parameter value or a
 *   changed wind rebuilds the play and re-simulates to the current time
 *   (coalesced to one rebuild per REBUILD_INTERVAL_MS while a slider moves).
 * - Stats: per system the particles spawned since the start and living now,
 *   and the frame cost — GPU timestamp queries where the device has them
 *   (simulation = compute passes, draw = render passes), else the CPU time of
 *   the simulation step and the render call, labelled as such.
 *
 * Browser-only.
 */
import { EffectTimeline, type EffectDefLike, type EffectSystemCounter } from '@thirdlight/three-adapter';
import * as THREE from 'three';

import type { PreviewRendererLike, PreviewStage, PreviewSubject } from './preview-renderer';

/** Coalesce rebuilds while a slider moves (a WebGPU rebuild compiles compute pipelines). */
const REBUILD_INTERVAL_MS = 120;
/** How often the stats are published (ms). */
const STATS_INTERVAL_MS = 200;
/** How often the living particles are read back from the GPU (ms). */
const LIVING_READ_INTERVAL_MS = 250;
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
   * and how each part was measured: `gpu` = timestamp queries, `cpu` =
   * main-thread time.
   */
  cost: { simulation: number; simulationBy: 'gpu' | 'cpu'; draw: number; drawBy: 'gpu' | 'cpu' } | null;
  /** Compile problems (errors) of the effect. */
  errors: number;
}

export interface EffectSubjectOptions {
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  loadModel?: (assetId: string) => Promise<THREE.Object3D | null>;
  onStats?: (s: EffectPreviewStats) => void;
}

/** The effect with preview-only parameter values as its defaults (works for public and private parameters alike). */
export function withPreviewParams(def: EffectDefLike, overrides: Readonly<Record<string, PreviewParamValue>>): EffectDefLike {
  if (Object.keys(overrides).length === 0 || def.parameters === undefined) return def;
  return { ...def, parameters: def.parameters.map((p) => (overrides[p.key] !== undefined ? { ...p, default: overrides[p.key] as never } : p)) };
}

export class EffectSubject implements PreviewSubject {
  readonly key: string;
  private stage: PreviewStage | null = null;
  private timeline: EffectTimeline | null = null;
  private timelineGeneration = -1;
  private def: EffectDefLike | null = null;
  private overrides: Readonly<Record<string, PreviewParamValue>> = {};
  private windKey = 'null';
  private dirty = false;
  private lastBuild = 0;
  private framedFor: string | null = null;
  private wantSeek: number | null = null;
  private length = 2;
  private playing = true;
  private lastNow: number | null = null;
  private simStart = 0;
  private disposed = false;
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
    effectId: string,
    private readonly options: EffectSubjectOptions,
  ) {
    this.key = `effect:${effectId}`;
  }

  attach(stage: PreviewStage): void {
    this.stage = stage;
    stage.setGrid(true);
    this.windKey = JSON.stringify(stage.environment()?.wind ?? null);
    this.dirty = true;
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

  environmentChanged(stage: PreviewStage): void {
    const wind = JSON.stringify(stage.environment()?.wind ?? null);
    if (wind === this.windKey) return;
    this.windKey = wind;
    this.dirty = true;
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
    return {
      backend: this.stage?.info().backend ?? null,
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

  update(stage: PreviewStage, now: number): void {
    const r = stage.renderer();
    if (r === null || this.disposed) return;
    this.ensureTimeline(stage, r, now);
    const tl = this.timeline;
    this.simStart = performance.now();
    if (tl === null) return;
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
    tl.draw(stage.camera);
  }

  afterRender(stage: PreviewStage, drawCpuMs: number, now: number): void {
    const r = stage.renderer();
    if (r === null || this.disposed) return;
    const tl = this.timeline;
    this.costFrames += 1;
    this.cpuSim += Math.max(0, performance.now() - drawCpuMs - this.simStart);
    this.cpuDraw += drawCpuMs;
    this.framesUnresolved += 1;
    this.resolveTimestamps(r);
    if (tl !== null && tl.executor === 'webgpu' && now - this.lastLivingRead > LIVING_READ_INTERVAL_MS) {
      this.lastLivingRead = now;
      tl.readLiving();
    }
    if (now - this.lastStats >= STATS_INTERVAL_MS) {
      this.lastStats = now;
      this.publishCost(r);
      this.options.onStats?.(this.stats());
    }
  }

  /** Whether this renderer records GPU timestamps (the device's timestamp feature). */
  private timestamps(r: PreviewRendererLike): boolean {
    const b = (r as unknown as { backend?: { trackTimestamp?: boolean; disjoint?: unknown } }).backend;
    return b?.trackTimestamp === true && (b.disjoint === undefined || b.disjoint !== null);
  }

  private resolveTimestamps(r: PreviewRendererLike): void {
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

  private publishCost(r: PreviewRendererLike): void {
    const gpuSim = this.timeline?.executor === 'webgpu';
    const ts = this.timestamps(r);
    if (ts && this.gpuFrames > 0 && this.costFrames > 0) {
      this.lastCost = gpuSim
        ? { simulation: this.gpuSim / this.gpuFrames, simulationBy: 'gpu', draw: this.gpuDraw / this.gpuFrames, drawBy: 'gpu' }
        : { simulation: this.cpuSim / this.costFrames, simulationBy: 'cpu', draw: this.gpuDraw / this.gpuFrames, drawBy: 'gpu' };
    } else if (this.costFrames > 0 && !ts) {
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
  private ensureTimeline(stage: PreviewStage, r: PreviewRendererLike, now: number): void {
    const generation = stage.generation();
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
    const api = stage.info().api === 'webgpu' ? 'webgpu' : 'webgl2';
    const wind = stage.environment()?.wind ?? null;
    this.timeline = new EffectTimeline({
      scene: stage.scene as never,
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
      // The effect's bounds box, a little closer than a tight fit (the particles rarely fill the corners).
      const b = def.bounds;
      const center = new THREE.Vector3(b.center[0], b.center[1], b.center[2]);
      const half = new THREE.Vector3(b.size[0], b.size[1], b.size[2]).multiplyScalar(0.5);
      stage.frame(new THREE.Box3(center.clone().sub(half), center.clone().add(half)), new THREE.Vector3(0, 0.3, 1), 0.9);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timeline?.dispose();
    this.timeline = null;
    this.stage?.setGrid(false);
    this.stage = null;
  }
}
