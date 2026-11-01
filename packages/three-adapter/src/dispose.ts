/**
 * Releasing three.js objects that leave the scene for good.
 *
 * In three's WebGPURenderer (both backends) removing an object from
 * the scene is not enough:
 *
 * - A render object (the object × material × pass: its pipeline, bindings,
 *   uniform buffers) is in the renderer's `RenderObjects` set until the
 *   object, its material or its geometry fires `dispose`. Disposing the
 *   geometry only clears an attribute cache, so an object whose material
 *   outlives it (project materials, shared box materials, shared model
 *   clones) kept its render objects — and through them the object, its
 *   skeleton and its node uniforms — for the renderer's lifetime. The fix is
 *   the object's own `dispose()` (it exists on every `Object3D`).
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

/** The renderer internals this module reads (three r187; every field optional: guarded). */
interface RendererInternals {
  _objects?: { _renderObjects?: Set<RenderObjectLike> } | null;
  _attributes?: { delete(attribute: unknown): unknown } | null;
  _geometries?: GeometriesInternals | null;
}
/** three's geometry component: a record per geometry it drew, with the dispose listener and the weak reference it tracks. */
interface GeometriesInternals {
  has?(geometry: unknown): boolean;
  get?(geometry: unknown): { onDispose?: (event: unknown) => void; ref?: object } | undefined;
  delete?(geometry: unknown): unknown;
  _tracked?: Set<object>;
  _registry?: { unregister(token: object): unknown };
  info?: { memory?: { geometries?: number } } | null;
}

/** The GPU buffer three keys an attribute by: an interleaved attribute's shared buffer, else the attribute. */
const bufferOf = (a: unknown): unknown => ((a as { isInterleavedBufferAttribute?: boolean } | null)?.isInterleavedBufferAttribute === true ? (a as { data: unknown }).data : a);
interface RenderObjectLike {
  object?: unknown;
  geometry?: { attributes?: Record<string, unknown>; index?: unknown } | null;
  getAttributes?: () => readonly unknown[];
}

const live = new Set<unknown>();

/** Register a renderer while it exists (the factory does; tests may too). Returns its release. */
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
      const own = new Set<unknown>(Object.values(ro.geometry?.attributes ?? {}).map(bufferOf));
      if (ro.geometry?.index !== undefined && ro.geometry.index !== null) own.add(ro.geometry.index);
      let list: readonly unknown[];
      try {
        list = ro.getAttributes();
      } catch {
        continue;
      }
      for (const a of list.map(bufferOf)) {
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

/**
 * Dispose a geometry that shares attributes (or its index) with other
 * geometries, freeing only `own` on the GPU.
 *
 * three's renderer frees, when a geometry it drew is disposed, its current
 * attributes and index: a plain `dispose` would destroy the shared buffers
 * while the geometries still holding them draw (three then uploads them
 * again, a stall per buffer, or on an older three refused every later
 * submit). Here the renderer's record of this geometry (its dispose listener
 * and the weak reference it tracks) is dropped (private API of the pinned
 * three version, guarded), then only `own` is freed.
 *
 * Returns false (and leaves the geometry undisposed) when a live renderer
 * drew it but lacks the expected internals: a leaked wrapper is recoverable,
 * a destroyed shared buffer is not.
 */
export function disposeSharingGeometry(geometry: THREE.BufferGeometry, own: readonly object[], renderers: readonly unknown[] = liveRenderers()): boolean {
  const plan: { geometries: GeometriesInternals; attributes: NonNullable<RendererInternals['_attributes']> }[] = [];
  for (const r of renderers) {
    const internals = r as RendererInternals | null;
    const geometries = internals?._geometries;
    if (geometries === undefined || geometries === null) continue;
    const attributes = internals?._attributes;
    if (typeof geometries.has !== 'function' || typeof geometries.get !== 'function' || typeof geometries.delete !== 'function' || !(geometries._tracked instanceof Set) || typeof geometries._registry?.unregister !== 'function') return false;
    if (attributes === undefined || attributes === null || typeof attributes.delete !== 'function') return false;
    plan.push({ geometries, attributes });
  }
  for (const { geometries, attributes } of plan) {
    // `get` would make a record for a geometry this renderer never drew.
    if (!geometries.has!(geometry)) continue;
    const record = geometries.get!(geometry);
    if (record?.onDispose !== undefined) geometry.removeEventListener('dispose', record.onDispose as never);
    if (record?.ref !== undefined) {
      geometries._tracked!.delete(record.ref);
      geometries._registry!.unregister(record.ref);
    }
    geometries.delete!(geometry);
    const memory = geometries.info?.memory;
    if (memory !== undefined && typeof memory.geometries === 'number') memory.geometries -= 1;
    for (const a of new Set(own.map(bufferOf))) {
      try {
        attributes.delete(a);
      } catch {
        /* best effort: the collector frees what is left */
      }
    }
  }
  // Render objects still listening for it let go of it here (those of disposed objects already did).
  geometry.dispose();
  return true;
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

/**
 * Forget the render contexts drawn with an MRT setup that is gone
 * (a post pipeline rebuilt: its scene pass had its own MRT node). three
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

/**
 * Free compute-only storage buffers on the renderer that created them.
 * three frees a node's buffer together with a geometry that drew it, so
 * buffers only compute passes use (particle state, free list, sort keys, the
 * noise table, a depth pyramid) would stay allocated after their passes are
 * disposed (the leak check measured 5 per particle system); here they go on
 * the renderer that made them, whoever else still holds the attribute. The renderer's
 * attribute map is private API of the pinned three version; deleting an
 * attribute it never saw (or already freed) does nothing.
 */
export function releaseStorage(renderer: unknown, buffers: readonly unknown[]): void {
  const map = (renderer as RendererInternals | null | undefined)?._attributes;
  if (map === null || map === undefined || typeof map.delete !== 'function') return;
  for (const b of buffers) if (b !== null && b !== undefined) map.delete(b);
}
