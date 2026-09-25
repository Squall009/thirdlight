/**
 * Phase 21.3: automatic instancing of repeated objects (Play, export and the
 * editor Scene view).
 *
 * Objects that draw the same geometry with the same material and the same
 * shadow flags are drawn together: one `THREE.InstancedMesh` per group, its
 * instance matrices copied from the members' world matrices before every
 * frame. The members stay in the scene graph as they are — hierarchy,
 * transforms, picking, bounds, lightmap bakes and per-object overrides keep
 * working on them — they only move to {@link BATCHED_LAYER}, which cameras do
 * not draw (the shadow cameras take the main camera's layers, so the members
 * cast no second shadow). A picker that must still hit them enables that
 * layer on its raycaster.
 *
 * Opt-in: only meshes a host marked with {@link BATCH_KEY} take part (a box,
 * the meshes of a placed model) — helpers, gizmos, sprites, effects and the
 * sky never do. A marked mesh is drawn on its own whenever it is not
 * batchable this frame: hidden, transparent (it needs back-to-front sorting),
 * skinned or morphed, several materials, a custom `onBeforeRender`, a render
 * order, other layers, per-object material parameters (a graph material's
 * `materialParams` are per-object uniforms), or no partner. A per-object
 * override that gives a mesh its own material copy (the selection highlight,
 * the checkpoint glow, a fade, a lightmap) takes it out of its group by
 * itself — the material is part of the key.
 *
 * The key is (draw geometry, material, casts shadow, receives shadow), plus
 * a coarse cell of the world for detailed geometry (≥ `detailedTriangles`
 * triangles): one group per cell keeps the frustum culling of a large level
 * for meshes whose off-screen vertices are worth culling, while cheap
 * geometry (boxes) stays one draw for the whole level. A host may give a
 * mesh a shared draw geometry and a scale (`{ geometry, scale }`): every box
 * draws the one unit box scaled by its size, so boxes of any size batch.
 *
 * An `InstancedMesh` is kept for its group across frames (three builds its
 * node program per instanced object, so recreating it would recompile);
 * it grows by doubling and is released when the group is gone.
 */
import * as THREE from 'three';

import { OVERRIDES_KEY } from './material-graph';

/** The layer batched members move to (cameras draw layer 0 only; pickers enable this one). */
export const BATCHED_LAYER = 30;

/** `mesh.userData[BATCH_KEY]`: `true`, or a draw geometry and a scale (a box: the unit box times its size). */
export const BATCH_KEY = '__tlBatch';

/** What a host puts under {@link BATCH_KEY}. */
export type BatchHint = true | { readonly geometry: THREE.BufferGeometry; readonly scale: readonly [number, number, number] | readonly number[] };

/** Where a member's own layer mask is kept while it is batched. */
const LAYERS_KEY = '__tlBatchLayers';

/** Mark every plain mesh under `root` (a placed model) as batchable. */
export function markBatchable(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh === true && (m as THREE.InstancedMesh).isInstancedMesh !== true && m.userData[BATCH_KEY] === undefined) m.userData[BATCH_KEY] = true;
  });
}

/** One unit box (1 × 1 × 1, lightmap UV1 like every box) that boxes draw through, scaled by their size. */
export function unitBoxGeometry(addLightmapUv: (g: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  addLightmapUv(g);
  return g;
}

export interface BatchKeyParts {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly scale: readonly number[] | null;
}

const DEFAULT_ON_BEFORE_RENDER = THREE.Object3D.prototype.onBeforeRender;

/**
 * Why a marked mesh is not batchable this frame (null: it is). Pure; the
 * member's layer mask is read from the saved copy while it is batched.
 */
export function batchRefusal(mesh: THREE.Mesh): string | null {
  const hint = mesh.userData[BATCH_KEY] as BatchHint | undefined;
  if (hint === undefined) return 'not marked';
  if ((mesh as THREE.InstancedMesh).isInstancedMesh === true || (mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh === true) return 'already instanced';
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) return 'skinned';
  if (mesh.morphTargetInfluences !== undefined && mesh.morphTargetInfluences.length > 0) return 'morph targets';
  const mat = mesh.material;
  if (Array.isArray(mat) || mat === undefined || mat === null) return 'several materials';
  if (mat.transparent === true) return 'transparent';
  if (mat.visible === false) return 'material hidden';
  if (mesh.renderOrder !== 0) return 'render order';
  if (mesh.onBeforeRender !== DEFAULT_ON_BEFORE_RENDER) return 'custom onBeforeRender';
  const layers = (mesh.userData[LAYERS_KEY] as number | undefined) ?? mesh.layers.mask;
  if (layers !== 1) return 'layers';
  if (mesh.userData[OVERRIDES_KEY] !== undefined) return 'per-object material parameters';
  const geometry = hint === true ? mesh.geometry : hint.geometry;
  if (geometry === undefined || geometry.getAttribute('position') === undefined) return 'no geometry';
  return null;
}

/** The parts a batchable mesh is grouped by (null when it is not batchable). */
export function batchKeyParts(mesh: THREE.Mesh): BatchKeyParts | null {
  if (batchRefusal(mesh) !== null) return null;
  const hint = mesh.userData[BATCH_KEY] as BatchHint;
  return {
    geometry: hint === true ? mesh.geometry : hint.geometry,
    material: mesh.material as THREE.Material,
    castShadow: mesh.castShadow,
    receiveShadow: mesh.receiveShadow,
    scale: hint === true ? null : hint.scale,
  };
}

/** Triangles a geometry draws (indexed or not). */
export function triangleCount(g: THREE.BufferGeometry): number {
  const index = g.getIndex();
  const n = index !== null ? index.count : (g.getAttribute('position')?.count ?? 0);
  return Math.floor(n / 3);
}

/** Small stable ids for keys (material ids are not in three's typings; one counter for both kinds). */
const keyIds = new WeakMap<object, number>();
let nextKeyId = 1;
const keyIdOf = (o: object): number => {
  let id = keyIds.get(o);
  if (id === undefined) {
    id = nextKeyId++;
    keyIds.set(o, id);
  }
  return id;
};

/** The group key of a batchable mesh: geometry, material, shadow flags and (detailed geometry only) the world cell. */
export function batchKey(parts: BatchKeyParts, worldPosition: readonly [number, number, number] | null, cellSize: number): string {
  const flags = `${parts.castShadow ? 1 : 0}${parts.receiveShadow ? 1 : 0}`;
  const base = `${keyIdOf(parts.geometry)}|${keyIdOf(parts.material)}|${flags}`;
  if (worldPosition === null) return base;
  return `${base}|${Math.floor(worldPosition[0] / cellSize)},${Math.floor(worldPosition[1] / cellSize)},${Math.floor(worldPosition[2] / cellSize)}`;
}

/**
 * Fewest instance slots of a batch: one more than three's 64 KiB uniform
 * buffer holds (1024 matrices; the WebGL 2 and default WebGPU limit). Below
 * it three reads the matrices from a uniform array named after the node, so
 * every instanced mesh would compile its own shader program; above it they
 * are instanced vertex attributes and every batch of a material shares one
 * program. The price is 64 KiB of matrices per batch.
 */
export const MIN_INSTANCE_CAPACITY = 1025;

/** The instance slots a group of `n` gets: at least {@link MIN_INSTANCE_CAPACITY}, doubling beyond it. */
export function instanceCapacity(n: number): number {
  let c = MIN_INSTANCE_CAPACITY;
  while (c < n) c *= 2;
  return c;
}

export interface AutoBatcherOptions {
  /**
   * Fewest members a group needs to be drawn instanced (default 4: every
   * instanced mesh costs three a node build once, so a pair or a triple
   * saves too few draws to be worth it).
   */
  readonly minGroup?: number;
  /**
   * Side of a world cell for detailed geometry, m (default 64: a level is
   * cut into a few cells a view usually sees one or two of, so the rest is
   * culled, while a group still holds many objects).
   */
  readonly cellSize?: number;
  /** Triangles from which a geometry is split by cell (default 256: below that, off-screen vertices cost less than extra draws). */
  readonly detailedTriangles?: number;
}

export interface AutoBatcherDiagnostics {
  /** Instanced groups drawn this frame. */
  readonly groups: number;
  /** Meshes drawn through them. */
  readonly batched: number;
  /** Marked meshes drawn on their own (not batchable or no partner). */
  readonly single: number;
}

export interface AutoBatcher {
  /**
   * Update the scene's world matrices, regroup and copy the members'
   * matrices; call right before rendering (after the transform sync). A host
   * that calls it before every render may set `scene.matrixWorldAutoUpdate =
   * false` (the renderer's own pass would repeat the work).
   */
  update(camera: THREE.Camera): void;
  diagnostics(): AutoBatcherDiagnostics;
  /** Off: every member goes back to drawing on its own. */
  setEnabled(on: boolean): void;
  /** Restore every member and release the instanced meshes (geometry and materials stay the host's). */
  dispose(): void;
}

interface Group {
  readonly key: string;
  mesh: THREE.InstancedMesh;
  members: THREE.Mesh[];
  scales: (readonly number[] | null)[];
  seen: number;
}

export function createAutoBatcher(scene: THREE.Scene, options: AutoBatcherOptions = {}): AutoBatcher {
  const minGroup = Math.max(2, options.minGroup ?? 4);
  const cellSize = options.cellSize ?? 64;
  const detailed = options.detailedTriangles ?? 256;
  const root = new THREE.Group();
  root.name = 'tl-batches';
  root.matrixAutoUpdate = false;
  scene.add(root);
  const groups = new Map<string, Group>();
  /** Members batched in the last frame (their layers are moved). */
  let batchedNow = new Set<THREE.Mesh>();
  let enabled = true;
  let disposed = false;
  let frame = 0;
  let stats: AutoBatcherDiagnostics = { groups: 0, batched: 0, single: 0 };
  const triangles = new WeakMap<THREE.BufferGeometry, number>();
  const trianglesOf = (g: THREE.BufferGeometry): number => {
    let n = triangles.get(g);
    if (n === undefined) {
      n = triangleCount(g);
      triangles.set(g, n);
    }
    return n;
  };
  const pending = new Map<string, { parts: BatchKeyParts; members: THREE.Mesh[]; scales: (readonly number[] | null)[] }>();
  let single = 0;
  const pos: [number, number, number] = [0, 0, 0];

  const restore = (m: THREE.Mesh): void => {
    const saved = m.userData[LAYERS_KEY] as number | undefined;
    if (saved !== undefined) {
      m.layers.mask = saved;
      delete m.userData[LAYERS_KEY];
    }
  };
  const release = (g: Group): void => {
    g.mesh.removeFromParent();
    g.mesh.dispose();
  };

  const visit = (o: THREE.Object3D, camera: THREE.Camera): void => {
    if (!o.visible || o === root) return;
    const lod = o as THREE.LOD;
    // The level shown this frame (the renderer would pick the same one later in the frame).
    if (lod.isLOD === true && lod.autoUpdate) lod.update(camera);
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh === true && mesh.userData[BATCH_KEY] !== undefined) {
      const parts = batchKeyParts(mesh);
      if (parts === null) single += 1;
      else {
        const e = mesh.matrixWorld.elements;
        pos[0] = e[12]!;
        pos[1] = e[13]!;
        pos[2] = e[14]!;
        const key = batchKey(parts, trianglesOf(parts.geometry) >= detailed ? pos : null, cellSize);
        let p = pending.get(key);
        if (p === undefined) {
          p = { parts, members: [], scales: [] };
          pending.set(key, p);
        }
        p.members.push(mesh);
        p.scales.push(parts.scale);
      }
    }
    const children = o.children;
    for (let i = 0; i < children.length; i += 1) visit(children[i]!, camera);
  };

  /** Copy member i's draw matrix into the instance array; true when it changed. */
  const writeMatrix = (array: Float32Array, i: number, m: THREE.Mesh, scale: readonly number[] | null): boolean => {
    const e = m.matrixWorld.elements;
    const sx = scale === null ? 1 : (scale[0] ?? 1);
    const sy = scale === null ? 1 : (scale[1] ?? 1);
    const sz = scale === null ? 1 : (scale[2] ?? 1);
    const o = i * 16;
    let changed = false;
    for (let k = 0; k < 16; k += 1) {
      const s = k < 3 ? sx : k < 7 && k > 3 ? sy : k < 11 && k > 7 ? sz : 1;
      // Compared as stored (float32): a float64 product never equals its stored copy, which would re-upload every frame.
      const v = Math.fround(e[k]! * s);
      if (array[o + k] !== v) {
        array[o + k] = v;
        changed = true;
      }
    }
    return changed;
  };

  const api: AutoBatcher = {
    update(camera) {
      if (disposed) return;
      frame += 1;
      // The world matrices of this frame (also when off: a host may leave the renderer's own pass out,
      // `scene.matrixWorldAutoUpdate = false`, so the graph is not walked twice per frame).
      scene.updateMatrixWorld();
      // A camera outside the scene (the editor's) is updated the way the renderer does it.
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      if (!enabled) return;
      pending.clear();
      single = 0;
      visit(scene, camera);
      const next = new Set<THREE.Mesh>();
      let batched = 0;
      for (const [key, p] of pending) {
        if (p.members.length < minGroup) {
          single += p.members.length;
          continue;
        }
        let g = groups.get(key);
        const n = p.members.length;
        let membershipChanged = false;
        if (g === undefined || g.mesh.instanceMatrix.count < n) {
          const capacity = instanceCapacity(n);
          const mesh = new THREE.InstancedMesh(p.parts.geometry, p.parts.material, capacity);
          mesh.name = `tl-batch:${key}`;
          mesh.castShadow = p.parts.castShadow;
          mesh.receiveShadow = p.parts.receiveShadow;
          mesh.userData['tlBatch'] = true;
          // Picking goes to the members (they keep their entity ids); the batch is drawn only.
          mesh.raycast = () => undefined;
          mesh.matrixAutoUpdate = false;
          if (g !== undefined) release(g);
          g = { key, mesh, members: [], scales: [], seen: frame };
          groups.set(key, g);
          root.add(mesh);
          membershipChanged = true;
        }
        g.seen = frame;
        if (g.members.length !== n) membershipChanged = true;
        else for (let i = 0; i < n && !membershipChanged; i += 1) if (g.members[i] !== p.members[i] || g.scales[i] !== p.scales[i]) membershipChanged = true;
        g.members = p.members;
        g.scales = p.scales;
        const array = g.mesh.instanceMatrix.array as Float32Array;
        let changed = membershipChanged;
        for (let i = 0; i < n; i += 1) {
          const m = p.members[i]!;
          if (writeMatrix(array, i, m, p.scales[i]!)) changed = true;
          if (m.userData[LAYERS_KEY] === undefined) {
            m.userData[LAYERS_KEY] = m.layers.mask;
            m.layers.set(BATCHED_LAYER);
          }
          next.add(m);
        }
        if (changed) {
          g.mesh.count = n;
          g.mesh.instanceMatrix.needsUpdate = true;
          g.mesh.computeBoundingSphere();
        }
        batched += n;
      }
      for (const m of batchedNow) if (!next.has(m)) restore(m);
      batchedNow = next;
      for (const [key, g] of [...groups]) {
        if (g.seen === frame) continue;
        release(g);
        groups.delete(key);
      }
      pending.clear();
      stats = { groups: groups.size, batched, single };
    },
    diagnostics: () => stats,
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        for (const m of batchedNow) restore(m);
        batchedNow = new Set();
        for (const g of groups.values()) release(g);
        groups.clear();
        stats = { groups: 0, batched: 0, single: 0 };
      }
    },
    dispose() {
      if (disposed) return;
      api.setEnabled(false);
      disposed = true;
      root.removeFromParent();
    },
  };
  return api;
}

/** The page flag that turns automatic instancing off (`?batching=off`: a diagnostic comparison; drawn the same, one draw per object). */
export const BATCHING_URL_PARAM = 'batching';

/** Whether a page's query string leaves automatic instancing on (the default) — `batching=off` or `0` turns it off. */
export function batchingFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(BATCHING_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}
