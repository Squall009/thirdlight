/**
 * Phase 21.5: releasing three.js objects that leave the scene for good.
 *
 * In three 0.186's WebGPURenderer (both backends) removing an object from
 * the scene is not enough:
 *
 * - A render object (the object × material × pass: its pipeline, bindings,
 *   uniform buffers) lives in the renderer's `RenderObjects` set until the
 *   object, its material or its geometry fires `dispose`. Disposing the
 *   geometry only clears an attribute cache, so an object whose material
 *   outlives it (project materials, shared box materials, shared model
 *   clones) kept its render objects — and through them the object, its
 *   skeleton and its node uniforms — for the renderer's lifetime. The fix is
 *   the object's own `dispose()` (it exists on every `Object3D` in 0.186).
 * - Attributes the node system makes for an object (the interleaved instance
 *   matrices of an `InstancedMesh` with ≥ 1025 slots, per-instance vertex
 *   data built by materials) are freed only when the geometry of the render
 *   object that first used them is disposed; instanced meshes here share their
 *   geometry (the unit box, a model's piece), so those GPU buffers stayed
 *   until the collector found the wrappers. They are deleted here through the
 *   renderer's attribute map — private API of the pinned three version (the
 *   same seam 20.3 uses for compute buffers), guarded: without it nothing
 *   happens and the collector frees them later.
 * - A light casting shadows owns its shadow map (render target), freed by
 *   `light.dispose()`.
 *
 * Geometries, materials and textures are NOT disposed here: callers own
 * them (shared and counted in several places) and dispose them themselves.
 *
 * The renderers to look in are the live ones the factory created
 * (`liveRenderers`); a disposed renderer's resources went with it.
 */
import * as THREE from 'three';

/** The renderer internals this module reads (three 0.186; every field optional: guarded). */
interface RendererInternals {
  _objects?: { _renderObjects?: Set<RenderObjectLike> } | null;
  _attributes?: { delete(attribute: unknown): unknown } | null;
}
interface RenderObjectLike {
  object?: unknown;
  geometry?: { attributes?: Record<string, unknown>; index?: unknown } | null;
  getAttributes?: () => readonly unknown[];
}

const live = new Set<unknown>();

/** Register a renderer while it lives (the factory does; tests may too). Returns its release. */
export function trackRenderer(renderer: unknown): () => void {
  live.add(renderer);
  return () => {
    live.delete(renderer);
  };
}

/** The live renderers (the factory's), for code that must release per-renderer data. */
export function liveRenderers(): readonly unknown[] {
  return [...live];
}

/**
 * Free the attributes the node system made for the objects in `objects`
 * (not their geometry's own attributes, which the geometry's owner frees) in
 * every live renderer — or only in `renderers` when given. Call BEFORE the
 * objects' `dispose()` (that removes their render objects). Returns the
 * number of attributes freed.
 */
export function releaseNodeAttributes(objects: ReadonlySet<unknown>, renderers: readonly unknown[] = liveRenderers()): number {
  if (objects.size === 0) return 0;
  let freed = 0;
  for (const r of renderers) {
    const internals = r as RendererInternals | null;
    const set = internals?._objects?._renderObjects;
    const attributes = internals?._attributes;
    if (set === undefined || attributes === undefined || attributes === null || typeof attributes.delete !== 'function') continue;
    const done = new Set<unknown>();
    for (const ro of set) {
      if (!objects.has(ro.object) || typeof ro.getAttributes !== 'function') continue;
      const own = new Set<unknown>(Object.values(ro.geometry?.attributes ?? {}));
      if (ro.geometry?.index !== undefined && ro.geometry.index !== null) own.add(ro.geometry.index);
      let list: readonly unknown[];
      try {
        list = ro.getAttributes();
      } catch {
        continue;
      }
      for (const a of list) {
        if (own.has(a) || done.has(a)) continue;
        done.add(a);
        try {
          if (attributes.delete(a) !== null) freed += 1;
        } catch {
          /* best effort: the collector frees what is left */
        }
      }
    }
  }
  return freed;
}

export interface DisposeTreeOptions {
  /** Do not descend into (nor dispose) these nodes — e.g. other entities' objects parented below this one. */
  skip?: (node: THREE.Object3D) => boolean;
  /** Skeletons of cloned skinned meshes this tree owns (their bone textures) — disposed too. */
  ownedSkeletons?: boolean;
  /** Where to release node attributes (default: every live renderer). */
  renderers?: readonly unknown[];
}

/**
 * Release a subtree that left the scene for good: node-made attributes of
 * its instanced meshes, then `dispose()` on every object (render objects go;
 * lights free their shadow maps), and optionally owned skeletons. Geometries
 * and materials stay with their owners. Returns the objects disposed.
 */
export function disposeObjectTree(root: THREE.Object3D | null | undefined, options: DisposeTreeOptions = {}): number {
  if (root === null || root === undefined) return 0;
  const nodes: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D): void => {
    if (o !== root && options.skip?.(o) === true) return;
    nodes.push(o);
    for (const c of o.children) visit(c);
  };
  visit(root);
  const instanced = new Set<unknown>(nodes.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh === true));
  releaseNodeAttributes(instanced, options.renderers);
  for (const o of nodes) {
    try {
      // Object3D#dispose fires `dispose` (render objects go; a light's shadow node frees its map);
      // point and spot lights also dispose their LightShadow.
      if (typeof (o as { dispose?: () => void }).dispose === 'function') (o as unknown as { dispose(): void }).dispose();
    } catch {
      /* best effort */
    }
    if (options.ownedSkeletons === true && (o as THREE.SkinnedMesh).isSkinnedMesh === true) {
      try {
        (o as THREE.SkinnedMesh).skeleton?.dispose();
      } catch {
        /* best effort */
      }
    }
  }
  return nodes.length;
}

/** The WebGL 2 backend internals `installVaoSweep` reads (three 0.186; guarded). */
interface WebGlBackendInternals {
  gl?: { deleteVertexArray?(vao: unknown): void } | null;
  vaoCache?: Record<string, unknown>;
  _createVao?: (attributes: readonly object[]) => unknown;
  _getVaoKey?: (attributes: readonly object[]) => string;
  has?: (object: object) => boolean;
  destroyAttribute?: (attribute: object) => void;
}

/** Sweep for dead vertex arrays at least after this many new ones (collected attributes; amortised). */
const VAO_SWEEP_EVERY = 32;

/**
 * Phase 21.5: three 0.186's WebGL 2 backend caches one vertex array object
 * per attribute set (`vaoCache`, keyed by the attributes' ids) and never
 * deletes one — every geometry that ever drew leaves its VAO behind (the
 * Scene view: ~9 per closed/opened scene; a preview shape switch: one each).
 * This wraps the backend's VAO creation (private API of the pinned version,
 * guarded: without it nothing changes) to remember each VAO's attributes
 * weakly, and before the next VAO is made after an attribute was destroyed
 * (a geometry disposed; else every 32 creations) deletes the VAOs one of
 * whose attributes is gone — a live attribute set keeps its VAO. Returns
 * whether it was installed.
 */
export function installVaoSweep(backend: unknown): boolean {
  const b = backend as WebGlBackendInternals | null;
  const WR = (globalThis as { WeakRef?: new <T extends object>(o: T) => { deref(): T | undefined } }).WeakRef;
  if (b === null || typeof b !== 'object' || typeof b._createVao !== 'function' || typeof b._getVaoKey !== 'function' || typeof b.has !== 'function' || b.vaoCache === undefined || WR === undefined) return false;
  const create = b._createVao.bind(b);
  const keyOf = b._getVaoKey.bind(b);
  const has = b.has.bind(b);
  let records: { vao: unknown; key: string; attributes: { deref(): object | undefined }[] }[] = [];
  let sinceSweep = 0;
  let destroyed = false;
  if (typeof b.destroyAttribute === 'function') {
    const destroy = b.destroyAttribute.bind(b);
    b.destroyAttribute = (attribute: object): void => {
      destroyed = true;
      destroy(attribute);
    };
  }
  const sweep = (): void => {
    const keep: typeof records = [];
    for (const r of records) {
      const dead = r.attributes.some((w) => {
        const a = w.deref();
        return a === undefined || !has(a);
      });
      if (!dead) {
        keep.push(r);
        continue;
      }
      if (b.vaoCache![r.key] === r.vao) delete b.vaoCache![r.key];
      try {
        b.gl?.deleteVertexArray?.(r.vao);
      } catch {
        /* best effort */
      }
    }
    records = keep;
  };
  b._createVao = (attributes: readonly object[]): unknown => {
    sinceSweep += 1;
    if (destroyed || sinceSweep >= VAO_SWEEP_EVERY) {
      destroyed = false;
      sinceSweep = 0;
      sweep();
    }
    const vao = create(attributes);
    records.push({ vao, key: keyOf(attributes), attributes: attributes.map((a) => new WR(a)) });
    return vao;
  };
  return true;
}

/** The texture component internals `trackTextureListeners` reads (three 0.186; guarded). */
interface TexturesInternals {
  updateTexture?: (texture: object, options?: unknown) => unknown;
  updateRenderTarget?: (renderTarget: object, level?: number) => unknown;
  get?: (object: object) => { onDispose?: () => void } | undefined;
}

/**
 * Phase 21.5: three 0.186's `Textures` component adds a `dispose` listener to
 * every texture and render target a renderer uploads, and its own `dispose()`
 * only drops its map — the listeners stay. A texture that outlives the
 * renderer (a module-level placeholder, the editor's shared texture cache, a
 * project texture a preview also drew) then keeps the whole disposed renderer
 * reachable (its textures component → renderer → canvas → the React tree the
 * canvas belonged to): every closed preview was retained. This records the
 * textures and render targets a renderer set up (weakly) and returns the
 * release to call before the renderer's `dispose()`, which removes the
 * renderer's listeners from the ones still alive. Private API of the pinned
 * version, guarded: without it the release does nothing.
 */
export function trackTextureListeners(renderer: unknown): () => void {
  const textures = (renderer as { _textures?: TexturesInternals | null } | null)?._textures;
  const WR = (globalThis as { WeakRef?: new <T extends object>(o: T) => { deref(): T | undefined } }).WeakRef;
  if (textures === undefined || textures === null || typeof textures.get !== 'function' || WR === undefined) return () => undefined;
  const seen = new WeakSet<object>();
  const refs: { deref(): object | undefined }[] = [];
  const note = (o: unknown): void => {
    if (o === null || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    refs.push(new WR(o));
  };
  const wrap = (name: 'updateTexture' | 'updateRenderTarget'): void => {
    const orig = textures[name];
    if (typeof orig !== 'function') return;
    const bound = orig.bind(textures) as (o: object, x?: unknown) => unknown;
    (textures as Record<string, unknown>)[name] = (o: object, x?: unknown): unknown => {
      note(o);
      return bound(o, x);
    };
  };
  wrap('updateTexture');
  wrap('updateRenderTarget');
  return () => {
    const get = textures.get!.bind(textures);
    for (const r of refs) {
      const o = r.deref() as { removeEventListener?: (type: string, l: () => void) => void } | undefined;
      if (o === undefined) continue;
      try {
        const data = get(o);
        if (data?.onDispose !== undefined) o.removeEventListener?.('dispose', data.onDispose);
      } catch {
        /* best effort */
      }
    }
    refs.length = 0;
  };
}

/** The internals `installProgramRelease` reads (three 0.186 WebGL 2 backend; guarded). */
interface ProgramInternals {
  _pipelines?: { _releasePipeline?: (pipeline: object) => unknown; _releaseProgram?: (stage: object) => unknown } | null;
  backend?: {
    isWebGLBackend?: boolean;
    gl?: { deleteProgram?(p: unknown): void; deleteShader?(s: unknown): void } | null;
    has?: (o: object) => boolean;
    get?: (o: object) => { programGPU?: unknown; shaderGPU?: unknown } | undefined;
  } | null;
}

/**
 * Phase 21.5: three 0.186's WebGL 2 backend never deletes a linked program or
 * a compiled shader: releasing an unused pipeline or shader stage only drops
 * three's cache entry, and the GL objects wait for the collector to find
 * their wrappers (which it does late: it does not see GPU memory). This makes
 * the release delete them at once (private API of the pinned version,
 * guarded; WebGL 2 backend only — WebGPU pipelines are collected objects).
 * Returns whether it was installed.
 */
export function installProgramRelease(renderer: unknown): boolean {
  const r = renderer as ProgramInternals | null;
  const pipelines = r?._pipelines;
  const backend = r?.backend;
  if (pipelines === undefined || pipelines === null || backend === undefined || backend === null || backend.isWebGLBackend !== true) return false;
  if (typeof pipelines._releasePipeline !== 'function' || typeof pipelines._releaseProgram !== 'function' || typeof backend.has !== 'function' || typeof backend.get !== 'function') return false;
  const gl = backend.gl;
  const has = backend.has.bind(backend);
  const get = backend.get.bind(backend);
  const releasePipeline = pipelines._releasePipeline.bind(pipelines);
  pipelines._releasePipeline = (pipeline: object): unknown => {
    if (has(pipeline)) {
      const program = get(pipeline)?.programGPU;
      try {
        if (program !== undefined && program !== null) gl?.deleteProgram?.(program);
      } catch {
        /* best effort */
      }
    }
    return releasePipeline(pipeline);
  };
  const releaseProgram = pipelines._releaseProgram.bind(pipelines);
  pipelines._releaseProgram = (stage: object): unknown => {
    if (has(stage)) {
      const shader = get(stage)?.shaderGPU;
      try {
        if (shader !== undefined && shader !== null) gl?.deleteShader?.(shader);
      } catch {
        /* best effort */
      }
    }
    return releaseProgram(stage);
  };
  return true;
}

/**
 * Phase 21.5: forget the render contexts drawn with an MRT setup that is gone
 * (a post pipeline rebuilt: its scene pass had its own MRT node). three 0.186
 * keys render contexts by the attachment state and the MRT's id, so every
 * rebuilt pipeline made new contexts — for the scene pass and for every
 * pass drawn inside it (the shadow maps: they render while the pass's MRT is
 * active) — and the old contexts and their render objects (every object ×
 * material, with bindings and uniform buffers) stayed for the renderer's
 * lifetime. Call when the MRT node's pipeline is disposed; private API of the
 * pinned version, guarded. Returns the render objects released.
 */
export function releaseMrtContexts(renderer: unknown, mrt: unknown): number {
  if (mrt === null || mrt === undefined) return 0;
  const r = renderer as (RendererInternals & { _renderContexts?: { _renderContexts?: Record<string, { mrt?: unknown }> } | null }) | null;
  let released = 0;
  const set = r?._objects?._renderObjects;
  if (set !== undefined) {
    for (const ro of [...set]) {
      if ((ro as { context?: { mrt?: unknown } }).context?.mrt !== mrt) continue;
      try {
        (ro as { dispose?: () => void }).dispose?.();
        released += 1;
      } catch {
        /* best effort */
      }
    }
  }
  const contexts = r?._renderContexts?._renderContexts;
  if (contexts !== undefined && contexts !== null) {
    for (const [key, c] of Object.entries(contexts)) if (c?.mrt === mrt) delete contexts[key];
  }
  return released;
}
