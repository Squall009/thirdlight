/**
 * Phase 20.3: one effect on a timeline — the Effect tab's preview.
 *
 * The same executors as Play (`chooseEffectExecutor` / `buildEffectPlay`:
 * WebGPU compute where the renderer draws on WebGPU and the graph allows
 * it, else the CPU reference evaluator), but driven by a clock the caller
 * controls: time advances in fixed steps (`step`, default 1/60 s), so the
 * state at time t is always the state after round(t / step) steps from the
 * seed. `seek(t)` restarts and re-simulates up to t (on the CPU the
 * reference evaluator, on WebGPU the compute passes are re-run), so pausing
 * and scrubbing are deterministic: the same t gives the same particles and
 * the same spawn counters.
 *
 * Visual only (plan-phase-20 §1): nothing here feeds the game simulation.
 */
import * as THREE from 'three/webgpu';

import type { EffectMesh } from '@thirdlight/effects';

import { LightPool, type DrawContext } from './effects-draw';
import { buildEffectPlay, chooseEffectExecutor, disposeEffectPlay, drawEffectPlay, effectMeshOf, type EffectDefLike, type EffectPlayParts, type EffectsPlayerOptions } from './effects-player';

/** The preview's fixed simulation step (s): 60 Hz, the display rate most screens run at. */
export const EFFECT_TIMELINE_STEP = 1 / 60;

export interface EffectTimelineOptions {
  /** Where the effect's draw objects and lights go. */
  scene: THREE.Object3D;
  renderer: THREE.WebGPURenderer;
  api: 'webgpu' | 'webgl2';
  def: EffectDefLike;
  /** Public parameter overrides (as an `effect` component's). */
  params?: Readonly<Record<string, number | readonly number[] | string>> | null;
  wind?: EffectsPlayerOptions['wind'];
  loadTexture(assetId: string): Promise<THREE.Texture | null>;
  loadModel?(assetId: string): Promise<THREE.Object3D | null>;
  projectMaterial?(materialId: string): THREE.Material | null;
  /** The fixed step (s); default `EFFECT_TIMELINE_STEP`. */
  step?: number;
}

/** One system's counters: particles born since the start (the reference's serial numbers) and living now (null: not read yet on the GPU). */
export interface EffectSystemCounter {
  systemId: string;
  name: string;
  spawned: number;
  living: number | null;
}

export class EffectTimeline {
  readonly executor: 'webgpu' | 'cpu';
  /** Why a WebGPU renderer runs this effect on the CPU (null otherwise). */
  readonly reason: string | null;
  readonly step: number;
  private readonly parts: EffectPlayParts;
  private readonly lights: LightPool;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly meshes = new Map<string, EffectMesh | null>();
  private readonly needs: string[];
  private steps = 0;
  private carry = 0;
  /** A seek asked for while mesh-surface models were loading (applied when they arrive). */
  private waitingSeek: number | null = null;
  private gpuLiving: (number | null)[];
  private reading = false;
  /** Bumps on every restart (a read-back from before belongs to another run). */
  private epoch = 0;
  private disposed = false;
  private readonly eye = new THREE.Vector3();
  private readonly origin = new THREE.Matrix4();

  constructor(private readonly o: EffectTimelineOptions) {
    this.renderer = o.renderer;
    this.step = o.step ?? EFFECT_TIMELINE_STEP;
    const choice = chooseEffectExecutor(o.def, o.api);
    this.executor = choice.executor;
    this.reason = choice.reason;
    this.lights = new LightPool(o.scene);
    const ctx: DrawContext = {
      webgpu: o.api === 'webgpu',
      loadTexture: o.loadTexture,
      loadModel: (id) => o.loadModel?.(id) ?? Promise.resolve(null),
      projectMaterial: (id) => o.projectMaterial?.(id) ?? null,
      lights: this.lights,
    };
    // Mesh-surface shapes sample a model on the CPU: the timeline waits for those models before it simulates.
    const needs = new Set<string>();
    if (choice.executor === 'cpu') for (const s of o.def.systems) for (const n of s.graph.nodes) if (n.type === 'init.position.mesh') {
      const m = (n as { data?: Record<string, unknown> }).data?.['model'];
      if (typeof m === 'string' && m !== '') needs.add(m);
    }
    this.needs = [...needs];
    for (const id of this.needs) {
      void (o.loadModel?.(id) ?? Promise.resolve(null))
        .catch(() => null)
        .then((root) => {
          if (this.disposed) return;
          this.meshes.set(id, root !== null ? effectMeshOf(root) : null);
          if (this.ready && this.waitingSeek !== null) {
            const t = this.waitingSeek;
            this.waitingSeek = null;
            this.seek(t);
          }
        });
    }
    this.parts = buildEffectPlay(o.def, o.params ?? null, choice, ctx, { ...(o.wind ? { wind: o.wind } : {}), mesh: (id) => this.meshes.get(id) ?? null });
    o.scene.add(this.parts.group);
    this.gpuLiving = this.parts.gpu?.systems.map(() => 0) ?? [];
  }

  /** The models its mesh-surface shapes need have arrived (always true without such shapes). */
  get ready(): boolean {
    return this.needs.every((id) => this.meshes.has(id));
  }

  /** Seconds simulated since the start (whole steps). */
  get time(): number {
    return this.steps * this.step;
  }

  /** Steps simulated since the start. */
  get stepCount(): number {
    return this.steps;
  }

  /** True while it spawns or has living particles (the GPU executor: while it spawns). */
  get alive(): boolean {
    return this.parts.cpu?.alive ?? this.parts.gpu!.spawning;
  }

  /** Compile problems of the effect (errors and warnings). */
  diagnostics(): readonly { systemId: string; severity: string; message: string }[] {
    return (this.parts.cpu ?? this.parts.gpu!.planner).diagnostics;
  }

  /**
   * Advance by real seconds: whole fixed steps (the remainder carries to the
   * next call), at most `maxSteps` in one call (the rest is dropped: a slow
   * frame slows the preview rather than stalling it). Returns the steps run.
   */
  advance(seconds: number, maxSteps = 8): number {
    if (!this.ready) return 0;
    this.carry += Math.max(0, seconds);
    let n = Math.floor(this.carry / this.step + 1e-9);
    this.carry -= n * this.step;
    if (n > maxSteps) {
      n = maxSteps;
      this.carry = 0;
    }
    this.run(n);
    return n;
  }

  /** Start over from the seed (time 0, no particles). */
  restart(): void {
    this.parts.cpu?.restart();
    this.parts.gpu?.restart();
    this.parts.gpu?.resetNow(this.renderer);
    this.steps = 0;
    this.carry = 0;
    this.epoch += 1;
    this.gpuLiving = this.gpuLiving.map(() => 0);
  }

  /** Re-simulate from the seed up to time t (round(t / step) steps): deterministic. */
  seek(t: number): void {
    const n = Math.max(0, Math.round(Math.max(0, t) / this.step));
    if (!this.ready) {
      this.waitingSeek = t;
      return;
    }
    this.restart();
    this.run(n);
    this.gpuLiving = this.gpuLiving.map(() => null);
  }

  private run(n: number): void {
    const dt = this.step;
    for (let k = 0; k < n; k++) {
      if (this.parts.cpu !== null) this.parts.cpu.step(dt, {});
      else this.parts.gpu!.step(this.renderer, dt, {});
      this.steps += 1;
    }
  }

  /** Prepare this frame's draw (after the steps, before the scene renders). */
  draw(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.lights.begin();
    drawEffectPlay(this.parts, this.renderer, camera, this.origin, this.eye, true);
    this.lights.end();
  }

  /** Per system: particles spawned since the start and living now (GPU: the last read-back, see `readLiving`). */
  counters(): EffectSystemCounter[] {
    const sim = this.parts.cpu ?? this.parts.gpu!.planner;
    return sim.systems.map((s, i) => ({
      systemId: s.program.systemId,
      name: this.o.def.systems[i]?.name ?? s.program.systemId,
      spawned: s.nextSerial,
      living: this.parts.cpu !== null ? s.count : (this.gpuLiving[i] ?? null),
    }));
  }

  /** GPU executor: read the living counts back (async; one read at a time). CPU: nothing to do. */
  readLiving(): void {
    const gpu = this.parts.gpu;
    if (gpu === null || this.reading || this.disposed) return;
    this.reading = true;
    const epoch = this.epoch;
    void Promise.all(gpu.systems.map((s) => s.living(this.renderer))).then(
      (counts) => {
        this.reading = false;
        // A count read before a seek or restart belongs to another run.
        if (!this.disposed && this.epoch === epoch) this.gpuLiving = counts;
      },
      () => {
        this.reading = false;
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeEffectPlay(this.parts, this.renderer);
    this.lights.dispose();
  }
}
