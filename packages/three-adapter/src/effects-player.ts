/**
 * Phase 20.2: the effect player — plays the project's visual effects in a
 * three.js scene (Play, exported games, the Scene view's edit-mode preview).
 *
 * Executors (plan-phase-20 §1: one graph semantics, two executors):
 * - `webgpu` (the renderer draws on WebGPU): TSL compute passes over storage
 *   buffers (`effects-gpu.ts`), instanced draws from the buffers, GPU
 *   back-to-front sort for alpha blending. Caps: `EFFECT_CAPS.webgpu`.
 * - `cpu` (the WebGL 2 backend, and on WebGPU the effects the GPU executor
 *   does not run — events, mesh-surface shapes, ribbons/trails, lights): the
 *   reference evaluator of `@thirdlight/effects` over typed arrays, drawn
 *   instanced (CPU back-to-front sort). Lower caps: `EFFECT_CAPS.cpu`.
 *
 * Plays come from `effect` components (play on start; restart/stop on
 * signals), scripts (`ctx.effects.play/stop`) and gameplay hooks — the last
 * two arrive as the runtime's presentation requests. Effects are visual
 * only: nothing here is read by the game simulation.
 *
 * Pooling: a finished one-shot play keeps its executor and draw objects in a
 * per-effect pool (up to `POOL_PER_EFFECT`) and the next play of that effect
 * restarts it (no new buffers, no pipeline compile).
 */
import * as THREE from 'three/webgpu';

import { compileEffect, EffectInstance, type CompiledNode, type EffectMesh, type EffectOrigin } from '@thirdlight/effects';

import { CpuParticleSource, createOutputRenderer, GpuParticleSource, LightPool, outputSorted, type DrawContext, type FrameInfo, type OutputRenderer } from './effects-draw';
import { GPU_SORT_LIMIT, GpuEffectExecutor, gpuUnsupportedReason } from './effects-gpu';
import { decodeTexture } from './material-library';
import type { GlbLoaderPort } from './visual';

/** An effect definition (the manifest's `content.effects[]` rows; project-model `EffectDef`). */
export type EffectDefLike = import('@thirdlight/effects').EffectInstance['effect'];

/** The `effect` component (project-model `EffectComponent`). */
export interface EffectComponentLike {
  readonly effectId: string;
  readonly playOnStart?: boolean;
  readonly params?: Readonly<Record<string, number | readonly number[] | string>>;
  readonly signal?: string;
  readonly stopSignal?: string;
}

/** A presentation request (the runtime's `EffectRequest`). */
export interface EffectRequestLike {
  readonly op: 'play' | 'stop';
  readonly effectId: string;
  readonly handle: number;
  readonly entityId: string | null;
  readonly position: readonly number[];
  readonly params: Readonly<Record<string, number | readonly number[] | string>> | null;
  readonly source: string;
}

/**
 * Engine limits per executor (documented in docs/deployment.md): particles
 * per system (a system's `maxParticles` is capped to it), particles
 * allocated over every playing effect (a play past it is refused), playing
 * effects at once.
 */
export interface EffectCaps {
  readonly particlesPerSystem: number;
  readonly particlesTotal: number;
  readonly instances: number;
}
export const EFFECT_CAPS: { readonly webgpu: EffectCaps; readonly cpu: EffectCaps } = {
  webgpu: { particlesPerSystem: 262_144, particlesTotal: 1_048_576, instances: 64 },
  /** The CPU fallback: typed-array simulation on the main thread. */
  cpu: { particlesPerSystem: 4_096, particlesTotal: 16_384, instances: 64 },
};
/** Finished plays kept per effect for reuse. */
export const POOL_PER_EFFECT = 4;
/** The longest simulation step (s): a slower frame is split into up to MAX_SUBSTEPS steps (then time slows). */
const MAX_STEP = 1 / 30;
const MAX_SUBSTEPS = 4;

export interface EffectsDiagnostics {
  /** The executor for this backend: `webgpu` on WebGPU, `cpu` on WebGL 2 (null: no renderer yet). */
  executor: 'webgpu' | 'cpu' | null;
  caps: { particlesPerSystem: number; particlesTotal: number; instances: number; lights: number; sortLimit: number | null };
  /** Effects playing now, and their living particles (GPU counts are read back every half second). */
  playing: number;
  particles: number;
  /** Plays refused at a cap, and requests naming no effect of the game. */
  refused: number;
  unknownEffects: string[];
  /** Up to 16 playing effects: which executor runs each, and why an effect runs on the CPU on WebGPU. */
  instances: { effectId: string; executor: 'webgpu' | 'cpu'; particles: number; reason?: string }[];
  /** Compile problems (errors and warnings) of the played effects, up to 16. */
  problems: string[];
  /** Point lights in use of the shared pool. */
  lights: number;
}

export interface EffectsPlayerOptions {
  scene: THREE.Scene;
  defs: readonly EffectDefLike[];
  /** The global wind (the Wind block); absent: the engine default. */
  wind?: { direction: readonly number[]; strength: number; gust: number; gustFrequency: number; turbulence: number } | null;
  loadTexture(assetId: string): Promise<THREE.Texture | null>;
  /** A model asset's scene (mesh particles, mesh-surface shapes); absent: those draw nothing. */
  loadModel?(assetId: string): Promise<THREE.Object3D | null>;
  /** A project material's compiled material (shading `material`). */
  projectMaterial?(materialId: string): THREE.Material | null;
  /** The Scene view's preview: an attached component play that finished starts again (after `replayDelay` s). */
  replayFinished?: boolean;
}

export interface EffectsPlayer {
  /** The renderer the effects draw with (after it is ready; again after a backend change). */
  setRenderer(renderer: THREE.WebGPURenderer, api: 'webgpu' | 'webgl2'): void;
  setDefs(defs: readonly EffectDefLike[]): void;
  /** An entity's `effect` component: plays from `object` (following it); `play` false: waits for a signal or a script. */
  attach(entityId: string, object: THREE.Object3D, component: EffectComponentLike, play: boolean): void;
  detach(entityId: string): void;
  /** Stop spawning on an attached entity while it is hidden (collected, defeated); resume when it shows again. */
  setAttachedActive(entityId: string, active: boolean): void;
  /** A runtime presentation request (`objectOf`: an entity's object, for plays on an entity). */
  request(req: EffectRequestLike, objectOf: (entityId: string) => THREE.Object3D | undefined): void;
  /** Step every playing effect by the frame's seconds and prepare its draw (before the scene renders). */
  update(frameSeconds: number, camera: THREE.Camera, worldTime?: number): void;
  /** Whether something plays (the caller keeps drawing frames while true). */
  readonly active: boolean;
  diagnostics(): EffectsDiagnostics;
  dispose(): void;
}

interface Playing {
  effectId: string;
  def: EffectDefLike;
  executor: 'webgpu' | 'cpu';
  reason?: string;
  cpu: EffectInstance | null;
  gpu: GpuEffectExecutor | null;
  renderers: { system: number; renderer: OutputRenderer; source: CpuParticleSource | GpuParticleSource }[];
  group: THREE.Group;
  /** Followed object (attached plays) and the offset from it, or a fixed world position. */
  object: THREE.Object3D | null;
  offset: THREE.Vector3;
  position: THREE.Vector3;
  handle: number;
  entityId: string | null;
  /** An entity's own component play (kept while the entity lives; restarted by its signal). */
  component: boolean;
  params: string;
  capacity: number;
  /** GPU: living particles as last read back, and whether a read is in flight. */
  gpuLiving: number;
  gpuReading: boolean;
  gpuReadAt: number;
  finished: boolean;
  /** Waiting for model assets its graphs need (mesh shapes). */
  pending: boolean;
  hidden: boolean;
}

function paramsKey(p: Readonly<Record<string, unknown>> | null | undefined): string {
  return p === null || p === undefined ? '' : JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
}

export function createEffectsPlayer(options: EffectsPlayerOptions): EffectsPlayer {
  const scene = options.scene;
  let defs = new Map(options.defs.map((d) => [d.effectId, d]));
  let renderer: THREE.WebGPURenderer | null = null;
  let api: 'webgpu' | 'webgl2' | null = null;
  const playing: Playing[] = [];
  const pool = new Map<string, Playing[]>();
  const attached = new Map<string, { object: THREE.Object3D; component: EffectComponentLike; play: Playing | null }>();
  const lights = new LightPool(scene);
  let refused = 0;
  const unknown = new Set<string>();
  const problems = new Set<string>();
  let clock = 0;
  const models = new Map<string, Promise<THREE.Object3D | null>>();
  const meshes = new Map<string, EffectMesh | null>();

  const loadModel = (assetId: string): Promise<THREE.Object3D | null> => {
    let p = models.get(assetId);
    if (p === undefined) {
      p = (options.loadModel?.(assetId) ?? Promise.resolve(null)).catch(() => null);
      models.set(assetId, p);
      void p.then((root) => meshes.set(assetId, root !== null ? meshOf(root) : null));
    }
    return p;
  };
  const drawContext = (): DrawContext => ({
    webgpu: api === 'webgpu',
    loadTexture: options.loadTexture,
    loadModel,
    projectMaterial: (id) => options.projectMaterial?.(id) ?? null,
    lights,
  });
  const caps = (): EffectCaps => (api === 'webgpu' ? EFFECT_CAPS.webgpu : EFFECT_CAPS.cpu);

  /** The models an effect's graphs sample on the CPU (mesh-surface shapes). */
  const shapeModels = (def: EffectDefLike): string[] => {
    const out = new Set<string>();
    for (const s of def.systems) for (const n of s.graph.nodes) if (n.type === 'init.position.mesh') {
      const m = (n as { data?: Record<string, unknown> }).data?.['model'];
      if (typeof m === 'string' && m !== '') out.add(m);
    }
    return [...out];
  };

  function allocated(): number {
    return playing.reduce((a, p) => a + p.capacity, 0);
  }

  function create(def: EffectDefLike, params: Readonly<Record<string, number | readonly number[] | string>> | null): Playing | null {
    if (renderer === null || api === null) return null;
    const program = compileEffect(def);
    for (const d of program.diagnostics) if (d.severity !== 'info') problems.add(`${def.effectId}/${d.systemId}: ${d.message}`.slice(0, 200));
    const gpuReason = api === 'webgpu' ? gpuUnsupportedReason(program) : 'the WebGL 2 backend has no compute: the CPU executor';
    const executor: 'webgpu' | 'cpu' = api === 'webgpu' && gpuReason === null ? 'webgpu' : 'cpu';
    const cap = executor === 'webgpu' ? EFFECT_CAPS.webgpu : EFFECT_CAPS.cpu;
    const capacity = def.systems.reduce((a, s) => a + Math.min(s.maxParticles, cap.particlesPerSystem), 0);
    if (playing.length >= caps().instances || allocated() + capacity > caps().particlesTotal) {
      refused += 1;
      return null;
    }
    const p = params !== null ? (params as Record<string, number | number[] | string>) : undefined;
    const group = new THREE.Group();
    group.name = `effect ${def.effectId}`;
    const rec: Playing = {
      effectId: def.effectId,
      def,
      executor,
      ...(api === 'webgpu' && gpuReason !== null ? { reason: gpuReason } : {}),
      cpu: null,
      gpu: null,
      renderers: [],
      group,
      object: null,
      offset: new THREE.Vector3(),
      position: new THREE.Vector3(),
      handle: 0,
      entityId: null,
      component: false,
      params: paramsKey(params),
      capacity,
      gpuLiving: 0,
      gpuReading: false,
      gpuReadAt: 0,
      finished: false,
      pending: false,
      hidden: false,
    };
    const ctx = drawContext();
    if (executor === 'webgpu') {
      const sorted = new Set(program.systems.filter((s) => s.chains.output.some((b) => outputSorted(b))).map((s) => s.systemId));
      const gpu = new GpuEffectExecutor(def, { capacityLimit: cap.particlesPerSystem, sortedSystems: sorted, ...(p !== undefined ? { params: p } : {}), ...(options.wind ? { wind: options.wind } : {}) });
      rec.gpu = gpu;
      gpu.systems.forEach((sys, i) => {
        const src = new GpuParticleSource(sys);
        for (const b of sys.program.chains.output) {
          const r = createOutputRenderer(b, src, null, ctx);
          if (r !== null) {
            rec.renderers.push({ system: i, renderer: r, source: src });
            if (r.object !== null) group.add(r.object);
          }
        }
      });
    } else {
      const needs = shapeModels(def);
      for (const m of needs) void loadModel(m);
      rec.pending = needs.some((m) => !meshes.has(m));
      const cpu = new EffectInstance(def, { capacityLimit: cap.particlesPerSystem, ...(p !== undefined ? { params: p } : {}), ...(options.wind ? { wind: options.wind as never } : {}), mesh: (id) => meshes.get(id) ?? null });
      rec.cpu = cpu;
      cpu.systems.forEach((sys, i) => {
        const src = new CpuParticleSource(sys);
        for (const b of sys.program.chains.output) {
          const r = createOutputRenderer(b, src, sys, ctx);
          if (r !== null) {
            rec.renderers.push({ system: i, renderer: r, source: src });
            if (r.object !== null) group.add(r.object);
          }
        }
      });
    }
    return rec;
  }

  /** A play of an effect (from the pool when a finished one with the same parameters waits there). */
  function start(effectId: string, params: Readonly<Record<string, number | readonly number[] | string>> | null): Playing | null {
    const def = defs.get(effectId);
    if (def === undefined) {
      if (unknown.size < 16) unknown.add(effectId);
      return null;
    }
    const key = paramsKey(params);
    const free = pool.get(effectId);
    const i = free?.findIndex((r) => r.params === key && r.executor === (api === 'webgpu' && r.gpu !== null ? 'webgpu' : r.executor)) ?? -1;
    let rec: Playing | null = null;
    if (free !== undefined && i >= 0) {
      rec = free.splice(i, 1)[0]!;
      if (playing.length >= caps().instances || allocated() + rec.capacity > caps().particlesTotal) {
        free.push(rec);
        refused += 1;
        return null;
      }
      restart(rec);
    } else {
      rec = create(def, params);
    }
    if (rec === null) return null;
    playing.push(rec);
    scene.add(rec.group);
    return rec;
  }

  function restart(rec: Playing): void {
    rec.cpu?.restart();
    rec.gpu?.restart();
    rec.finished = false;
    rec.gpuLiving = 0;
    rec.gpuReadAt = clock;
  }

  function stopSpawning(rec: Playing): void {
    rec.cpu?.stop();
    rec.gpu?.planner.stop();
  }

  function release(rec: Playing, keep: boolean): void {
    const i = playing.indexOf(rec);
    if (i >= 0) playing.splice(i, 1);
    rec.group.removeFromParent();
    const list = pool.get(rec.effectId) ?? [];
    if (keep && !rec.component && list.length < POOL_PER_EFFECT && defs.get(rec.effectId) === rec.def) {
      rec.object = null;
      rec.entityId = null;
      rec.handle = 0;
      list.push(rec);
      pool.set(rec.effectId, list);
      return;
    }
    destroy(rec);
  }

  function destroy(rec: Playing): void {
    for (const r of rec.renderers) r.renderer.dispose();
    rec.gpu?.dispose();
    rec.renderers.length = 0;
  }

  function originOf(rec: Playing, out: THREE.Matrix4): EffectOrigin {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    if (rec.object !== null) {
      rec.object.updateWorldMatrix(true, false);
      rec.object.matrixWorld.decompose(pos, quat, scl);
      pos.add(rec.offset.clone().multiply(scl).applyQuaternion(quat));
    } else {
      pos.copy(rec.position);
    }
    out.compose(pos, quat, scl);
    return { position: [pos.x, pos.y, pos.z], rotation: [quat.x, quat.y, quat.z, quat.w], scale: [scl.x, scl.y, scl.z] };
  }

  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const box = new THREE.Box3();
  const tmpM = new THREE.Matrix4();
  const identity = new THREE.Matrix4();
  const eye = new THREE.Vector3();

  function update(frameSeconds: number, camera: THREE.Camera, worldTime?: number): void {
    if (renderer === null) return;
    const dtAll = Math.max(0, Math.min(frameSeconds, MAX_STEP * MAX_SUBSTEPS));
    clock += dtAll;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, renderer.coordinateSystem);
    eye.setFromMatrixPosition(camera.matrixWorld);
    lights.begin();
    for (const rec of [...playing]) {
      if (rec.pending) {
        rec.pending = shapeModels(rec.def).some((m) => !meshes.has(m));
        if (rec.pending) continue;
      }
      const origin = originOf(rec, tmpM);
      const steps = dtAll > 0 ? Math.max(1, Math.ceil(dtAll / MAX_STEP - 1e-9)) : 0;
      const dt = steps > 0 ? dtAll / steps : 0;
      for (let k = 0; k < steps; k++) {
        const input = { origin, ...(worldTime !== undefined ? { worldTime: worldTime - dtAll + dt * (k + 1) } : {}) };
        if (rec.cpu !== null) rec.cpu.step(dt, input);
        else if (rec.gpu !== null) rec.gpu.step(renderer, dt, input);
      }
      // Culling: the effect's bounds (effect space) around its origin.
      const b = rec.def.bounds;
      box.setFromCenterAndSize(new THREE.Vector3(b.center[0], b.center[1], b.center[2]), new THREE.Vector3(b.size[0], b.size[1], b.size[2])).applyMatrix4(tmpM);
      const visible = frustum.intersectsBox(box) && !rec.hidden;
      if (rec.gpu !== null && visible) rec.gpu.sort(renderer, eye);
      const inputOf = (system: number) => (block: CompiledNode, key: string): number[] => (rec.cpu ?? rec.gpu!.planner).outputInput(system, block, key);
      for (const r of rec.renderers) {
        if (r.source instanceof CpuParticleSource) {
          const world = r.source.space === 'local';
          r.source.fill(r.renderer.sorted, eye, world ? tmpM : null);
        }
        const frame: FrameInfo = { camera, originMatrix: r.source.space === 'local' ? tmpM : identity, visible, input: inputOf(r.system) };
        r.renderer.update(frame);
      }
      // Finished: a one-shot whose spawning ended and whose particles are gone.
      if (rec.cpu !== null && !rec.cpu.alive) rec.finished = true;
      if (rec.gpu !== null && !rec.gpu.spawning) {
        if (!rec.gpuReading && clock - rec.gpuReadAt >= 0.5) {
          rec.gpuReading = true;
          rec.gpuReadAt = clock;
          const r = renderer;
          void rec.gpu.living(r).then(
            (n) => {
              rec.gpuReading = false;
              rec.gpuLiving = n;
              if (n === 0 && !rec.gpu!.spawning) rec.finished = true;
            },
            () => {
              rec.gpuReading = false;
            },
          );
        }
      } else if (rec.gpu !== null && clock - rec.gpuReadAt >= 0.5 && !rec.gpuReading) {
        rec.gpuReading = true;
        rec.gpuReadAt = clock;
        void rec.gpu.living(renderer).then(
          (n) => {
            rec.gpuReading = false;
            rec.gpuLiving = n;
          },
          () => {
            rec.gpuReading = false;
          },
        );
      }
      if (rec.finished && !rec.component) release(rec, true);
      else if (rec.finished && rec.component && options.replayFinished === true) restart(rec);
    }
    lights.end();
  }

  const api_: EffectsPlayer = {
    setRenderer(r, backend) {
      if (renderer === r && api === backend) return;
      // A new renderer (backend change, device loss): every executor starts over on it.
      for (const rec of [...playing]) {
        release(rec, false);
      }
      for (const list of pool.values()) for (const rec of list) destroy(rec);
      pool.clear();
      renderer = r;
      api = backend;
      for (const [id, a] of attached) {
        a.play = null;
        if (a.component.playOnStart !== false || a.play !== null) api_.attach(id, a.object, a.component, a.component.playOnStart !== false);
      }
    },
    setDefs(list) {
      defs = new Map(list.map((d) => [d.effectId, d]));
      // Plays of a changed or removed effect end; attached components start again with the new definition.
      for (const rec of [...playing]) if (defs.get(rec.effectId) !== rec.def) release(rec, false);
      for (const [id, list2] of [...pool]) {
        if (list2.some((r) => defs.get(id) !== r.def)) {
          for (const r of list2) destroy(r);
          pool.delete(id);
        }
      }
      for (const [id, a] of attached) if (a.play === null || !playing.includes(a.play)) api_.attach(id, a.object, a.component, a.component.playOnStart !== false);
    },
    attach(entityId, object, component, play) {
      const prev = attached.get(entityId);
      if (prev?.play) release(prev.play, false);
      const rec: { object: THREE.Object3D; component: EffectComponentLike; play: Playing | null } = { object, component, play: null };
      attached.set(entityId, rec);
      if (!play || renderer === null) return;
      const p = start(component.effectId, component.params ?? null);
      if (p === null) return;
      p.object = object;
      p.entityId = entityId;
      p.component = true;
      rec.play = p;
    },
    detach(entityId) {
      const a = attached.get(entityId);
      if (a?.play) release(a.play, false);
      attached.delete(entityId);
      for (const rec of [...playing]) if (rec.entityId === entityId) release(rec, false);
    },
    setAttachedActive(entityId, active) {
      for (const rec of playing) {
        if (rec.entityId !== entityId) continue;
        if (rec.hidden === !active) continue;
        rec.hidden = !active;
        if (!active) stopSpawning(rec);
        else if (rec.component) {
          rec.cpu?.play();
          rec.gpu?.planner.play();
        }
      }
    },
    request(req, objectOf) {
      if (req.op === 'stop') {
        for (const rec of playing) if ((req.handle > 0 && rec.handle === req.handle) || (req.handle === 0 && req.entityId !== null && rec.entityId === req.entityId)) stopSpawning(rec);
        return;
      }
      // An entity's component signal: restart its own play.
      if (req.source === 'component' && req.entityId !== null) {
        const a = attached.get(req.entityId);
        if (a === undefined) return;
        if (a.play !== null && playing.includes(a.play)) {
          restart(a.play);
          return;
        }
        api_.attach(req.entityId, a.object, a.component, true);
        return;
      }
      const object = req.entityId !== null ? objectOf(req.entityId) : undefined;
      if (req.entityId !== null && object === undefined) return;
      const p = start(req.effectId, req.params);
      if (p === null) return;
      p.handle = req.handle;
      p.entityId = req.entityId;
      p.object = object ?? null;
      p.offset.set(req.position[0] ?? 0, req.position[1] ?? 0, req.position[2] ?? 0);
      p.position.set(req.position[0] ?? 0, req.position[1] ?? 0, req.position[2] ?? 0);
    },
    update,
    get active(): boolean {
      return playing.length > 0;
    },
    diagnostics(): EffectsDiagnostics {
      const c = caps();
      let particles = 0;
      const instances: EffectsDiagnostics['instances'] = [];
      for (const rec of playing) {
        const n = rec.cpu !== null ? rec.cpu.systems.reduce((a, s) => a + s.count, 0) : rec.gpuLiving;
        particles += n;
        if (instances.length < 16) instances.push({ effectId: rec.effectId, executor: rec.executor, particles: n, ...(rec.reason !== undefined ? { reason: rec.reason } : {}) });
      }
      return {
        executor: api === null ? null : api === 'webgpu' ? 'webgpu' : 'cpu',
        caps: { particlesPerSystem: c.particlesPerSystem, particlesTotal: c.particlesTotal, instances: c.instances, lights: 16, sortLimit: api === 'webgpu' ? GPU_SORT_LIMIT : null },
        playing: playing.length,
        particles,
        refused,
        unknownEffects: [...unknown],
        instances,
        problems: [...problems].slice(0, 16),
        lights: lights.active,
      };
    },
    dispose() {
      for (const rec of [...playing]) release(rec, false);
      for (const list of pool.values()) for (const rec of list) destroy(rec);
      pool.clear();
      attached.clear();
      lights.dispose();
    },
  };
  return api_;
}

/** A model's triangles in its own space (every mesh, in the model's frame) for mesh-surface shapes. */
function meshOf(root: THREE.Object3D): EffectMesh | null {
  const positions: number[] = [];
  const indices: number[] = [];
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    const g = m.geometry;
    const pos = g.getAttribute('position');
    if (pos === undefined) return;
    const base = positions.length / 3;
    const toRoot = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      positions.push(v.x, v.y, v.z);
    }
    const index = g.getIndex();
    if (index !== null) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  });
  return positions.length > 0 ? { positions: new Float32Array(positions), indices: new Uint32Array(indices) } : null;
}

/** An asset row of the game's manifest (what the effect option needs of it). */
export interface EffectAssetRowLike {
  readonly assetId: string;
  readonly version: number;
  readonly kind: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
}

/**
 * The scene adapter's `effects` option from a verified manifest (Play and
 * the export build it the same way): textures decoded and models parsed from
 * the wrapper-verified bytes (never a URL).
 */
export function effectsOptionFrom(input: {
  defs: readonly EffectDefLike[];
  wind: { direction: readonly number[]; strength: number; gust: number; gustFrequency: number; turbulence: number } | null;
  assets: readonly EffectAssetRowLike[];
  bytes: (assetId: string, version: number) => ArrayBuffer | undefined;
  /** The GLB loader port (mesh particles, mesh-surface shapes); absent: those draw nothing. */
  loader?: GlbLoaderPort;
}): { defs: readonly EffectDefLike[]; wind: EffectsPlayerOptions['wind']; loadTexture: (assetId: string) => Promise<THREE.Texture | null>; loadModel?: (assetId: string) => Promise<THREE.Object3D | null> } {
  const row = (kind: string, assetId: string): EffectAssetRowLike | undefined => input.assets.find((a) => a.kind === kind && a.assetId === assetId);
  const loader = input.loader;
  return {
    defs: input.defs,
    wind: input.wind,
    loadTexture: (assetId) => {
      const r = row('texture', assetId);
      const buf = r !== undefined ? input.bytes(r.assetId, r.version) : undefined;
      return buf !== undefined ? (decodeTexture(buf) as unknown as Promise<THREE.Texture>) : Promise.resolve(null);
    },
    ...(loader !== undefined
      ? {
          loadModel: async (assetId: string): Promise<THREE.Object3D | null> => {
            const r = row('model', assetId);
            const buf = r !== undefined ? input.bytes(r.assetId, r.version) : undefined;
            if (r === undefined || buf === undefined) return null;
            const glb = await loader.load(new Uint8Array(buf), { signal: new AbortController().signal, descriptor: { assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, sourceByteLength: r.sourceByteLength } });
            return glb.createInstance() as unknown as THREE.Object3D;
          },
        }
      : {}),
  };
}
