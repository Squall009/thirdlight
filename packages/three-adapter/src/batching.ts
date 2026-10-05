/**
 * Automatic instancing of repeated objects (Play, export and the
 * editor Scene view).
 *
 * Objects that draw the same geometry with the same material and the same
 * shadow flags are drawn together: one instanced draw per group, its
 * instance matrices copied from the members' world matrices. The members
 * stay in the scene graph as they are — hierarchy,
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
 * `materialParams` are per-object uniforms, as are the values scripts set
 * while the game runs), or no partner. A per-object
 * override that gives a mesh its own material copy (the selection highlight,
 * a look override, a lightmap) takes it out of its group by
 * itself — the material is part of the key.
 *
 * The key is (draw geometry, material, casts shadow, receives shadow), plus
 * a coarse cell of the world for detailed geometry (≥ `detailedTriangles`
 * triangles): one group per cell keeps the frustum culling of a large scene
 * for meshes whose off-screen vertices are worth culling, while cheap
 * geometry (boxes) stays one draw for the whole scene. A host may give a
 * mesh a shared draw geometry and a scale (`{ geometry, scale }`): every box
 * draws the one unit box scaled by its size, so boxes of any size batch.
 *
 * Nothing is re-derived per frame. The host tells the batcher what entered
 * or left the scene (a new object, a LOD level switched in or out, a hidden
 * object), whose world matrix it wrote, and which objects had their
 * material, shadow flags or marks changed (`touch`); groups are kept between
 * frames, only those members are grouped again, and only the matrices of
 * members that moved are copied. An idle frame of a static scene does
 * neither (diagnostics count both per frame).
 *
 * A group is drawn through instance-matrix columns of its own
 * geometry (`attribute-instancing.ts`), not a `THREE.InstancedMesh`: three
 * builds a node program for every instanced object on its own, while groups
 * drawn through columns share one per material and vertex layout (the large
 * benchmark's 573 groups built 573 programs before its first frame). A
 * group's mesh is kept across frames; it grows by doubling (a new geometry,
 * the same program) and is released when the group is gone.
 */
import * as THREE from 'three';

import { createAttributeInstancedMesh, type AttributeInstancedMesh } from './attribute-instancing';
import { OVERRIDES_KEY, RUNTIME_VALUES_KEY } from './material-graph';

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
  // The columns are applied before three's displacement (batches draw no displaced mesh).
  if ((mat as { displacementMap?: unknown }).displacementMap != null) return 'displacement map';
  if (mesh.renderOrder !== 0) return 'render order';
  if (mesh.onBeforeRender !== DEFAULT_ON_BEFORE_RENDER) return 'custom onBeforeRender';
  const layers = (mesh.userData[LAYERS_KEY] as number | undefined) ?? mesh.layers.mask;
  if (layers !== 1) return 'layers';
  if (mesh.userData[OVERRIDES_KEY] !== undefined) return 'per-object material parameters';
  // Values a script set on this object (per-object uniforms, its own data texture).
  if (mesh.userData[RUNTIME_VALUES_KEY] !== undefined) return 'run-time material parameters';
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
 * Fewest instance slots of a chunked instance set's `InstancedMesh`: one more
 * than three's 64 KiB uniform buffer holds (1024 matrices; the WebGL 2 and
 * default WebGPU limit). Below it three reads the matrices from a uniform
 * array named after the node, so every instanced mesh would compile its own
 * shader program; above it they are instanced vertex attributes and every
 * chunk of a material shares one shader. The price is 64 KiB of matrices
 * per chunk. (Automatic batches draw through instance-matrix columns and
 * start at {@link MIN_BATCH_CAPACITY}.)
 */
export const MIN_INSTANCE_CAPACITY = 1025;

/** The instance slots a chunk of `n` gets: at least {@link MIN_INSTANCE_CAPACITY}, doubling beyond it. */
export function instanceCapacity(n: number): number {
  let c = MIN_INSTANCE_CAPACITY;
  while (c < n) c *= 2;
  return c;
}

/** Fewest slots of an automatic batch (its columns share the program at any size). */
export const MIN_BATCH_CAPACITY = 16;

/** The slots a batch of `n` gets: at least {@link MIN_BATCH_CAPACITY}, doubling beyond it. */
export function batchCapacity(n: number): number {
  let c = MIN_BATCH_CAPACITY;
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
   * Side of a world cell for detailed geometry, m (default 64: a scene is
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
  /** Groups a member joined or left in the last frame. */
  readonly regroups: number;
  /** Member matrices copied into a batch in the last frame. */
  readonly matrixCopies: number;
  /** Both since the batcher was made. */
  readonly regroupsTotal: number;
  readonly matrixCopiesTotal: number;
}

/**
 * What the batcher is told about the scene. It never walks the scene: the
 * host announces what enters and leaves it and whose world matrix it wrote,
 * so an idle frame costs nothing.
 */
export interface BatchMembership {
  /** `o` entered the scene: it and the meshes below it may be batched. */
  listed(o: THREE.Object3D): void;
  /** `o` left the scene: its meshes leave their groups. */
  unlisted(o: THREE.Object3D): void;
  /** `o`'s world matrix (and those below it) was written this frame. */
  moved(o: THREE.Object3D): void;
}

export interface AutoBatcher extends BatchMembership {
  /**
   * Update the scene's world matrices, regroup what changed and copy the
   * matrices of members that moved; call right before rendering (after the
   * transform sync). A host that calls it before every render may set
   * `scene.matrixWorldAutoUpdate = false` (the renderer's own pass would
   * repeat the work).
   */
  update(camera: THREE.Camera): void;
  /**
   * Something that decides the group of the meshes under `o` may have
   * changed — a material, the shadow flags, the layers, per-object material
   * parameters, `visible`, the batch mark: they are grouped again next frame.
   */
  touch(o: THREE.Object3D): void;
  /** Every member is grouped again next frame (a change that reaches every object: new bakes, materials redefined). */
  touchAll(): void;
  diagnostics(): AutoBatcherDiagnostics;
  /** Off: every member goes back to drawing on its own. */
  setEnabled(on: boolean): void;
  /** Restore every member and release the instanced meshes (geometry and materials stay the host's). */
  dispose(): void;
}

/** A mesh in the scene the batcher knows of (batchable or not). */
interface Member {
  readonly mesh: THREE.Mesh;
  /** The listed object it came in with. */
  root: THREE.Object3D;
  group: Group | null;
  /** Its slot in the group's members (and instance array). */
  slot: number;
  scale: readonly number[] | null;
  /** Its world cell (detailed geometry only). */
  cx: number;
  cy: number;
  cz: number;
  /** Carries the batch mark (counted as single while not batched). */
  marked: boolean;
  /** Drawn through its group's batch (its layers moved). */
  batched: boolean;
}

interface Group {
  readonly key: string;
  readonly parts: BatchKeyParts;
  readonly detailed: boolean;
  readonly members: Member[];
  /** The batch, while the group has enough members. */
  inst: AttributeInstancedMesh | null;
  /** Stops listening to the batch material's `dispose`. */
  unlisten: () => void;
  /** The material's `version` when the members were last grouped (a change may make them unbatchable). */
  materialVersion: number;
}

export function createAutoBatcher(scene: THREE.Scene, options: AutoBatcherOptions = {}): AutoBatcher {
  const minGroup = Math.max(2, options.minGroup ?? 4);
  const cellSize = options.cellSize ?? 64;
  const detailedTriangles = options.detailedTriangles ?? 256;
  const members = new Map<THREE.Mesh, Member>();
  const byRoot = new Map<THREE.Object3D, Member[]>();
  const groups = new Map<string, Group>();
  /** Members to group again, members whose matrix was written, groups whose members changed. */
  const dirty = new Set<Member>();
  const movedNow = new Set<Member>();
  const changedGroups = new Set<Group>();
  /** Groups whose instance matrices changed this frame (uploaded once). */
  const writtenGroups = new Set<Group>();
  let enabled = true;
  let disposed = false;
  let marked = 0;
  /** This frame's work so far (a member leaving between frames counts in the next one), and the last frame's. */
  let regroups = 0;
  let copies = 0;
  let lastRegroups = 0;
  let lastCopies = 0;
  let regroupsTotal = 0;
  let copiesTotal = 0;
  let counts = { groups: 0, batched: 0, single: 0 };
  const triangles = new WeakMap<THREE.BufferGeometry, number>();
  const trianglesOf = (g: THREE.BufferGeometry): number => {
    let n = triangles.get(g);
    if (n === undefined) {
      n = triangleCount(g);
      triangles.set(g, n);
    }
    return n;
  };
  const pos: [number, number, number] = [0, 0, 0];

  const batch = (m: Member): void => {
    if (m.batched) return;
    m.batched = true;
    m.mesh.userData[LAYERS_KEY] = m.mesh.layers.mask;
    m.mesh.layers.set(BATCHED_LAYER);
  };
  const unbatch = (m: Member): void => {
    if (!m.batched) return;
    m.batched = false;
    const saved = m.mesh.userData[LAYERS_KEY] as number | undefined;
    if (saved !== undefined) {
      m.mesh.layers.mask = saved;
      delete m.mesh.userData[LAYERS_KEY];
    }
  };
  /** The group draws its members on their own again; its batch goes. */
  const release = (g: Group): void => {
    if (g.inst === null) return;
    for (const m of g.members) unbatch(m);
    g.unlisten();
    g.unlisten = () => undefined;
    // Its render objects and its instance buffer go too (the source geometry stays its owner's).
    g.inst.dispose();
    g.inst = null;
  };

  /** Copy member `m`'s draw matrix into its slot; true when it changed. */
  const writeMatrix = (g: Group, m: Member): boolean => {
    copies += 1;
    const array = g.inst!.array;
    const e = m.mesh.matrixWorld.elements;
    const scale = m.scale;
    const sx = scale === null ? 1 : (scale[0] ?? 1);
    const sy = scale === null ? 1 : (scale[1] ?? 1);
    const sz = scale === null ? 1 : (scale[2] ?? 1);
    const o = m.slot * 16;
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

  const join = (g: Group, m: Member, scale: readonly number[] | null): void => {
    m.group = g;
    m.slot = g.members.length;
    m.scale = scale;
    g.members.push(m);
    changedGroups.add(g);
    // A batch with room takes it now; a full one is made again larger when the frame's changes are in.
    if (g.inst !== null && m.slot < g.inst.capacity) {
      writeMatrix(g, m);
      batch(m);
    }
  };
  const leave = (m: Member): void => {
    const g = m.group;
    if (g === null) return;
    const last = g.members.pop()!;
    if (last !== m) {
      // The last member takes its slot (its matrix moves along: no other slot changes).
      g.members[m.slot] = last;
      const from = last.slot;
      last.slot = m.slot;
      if (g.inst !== null && from < g.inst.capacity) {
        g.inst.array.copyWithin(m.slot * 16, from * 16, from * 16 + 16);
        copies += 1;
      }
    }
    m.group = null;
    m.slot = -1;
    unbatch(m);
    changedGroups.add(g);
  };

  /** Drawn as far as the scene is concerned: it and its parents up to what was listed are visible. */
  const shown = (m: Member): boolean => {
    for (let o: THREE.Object3D | null = m.mesh; o !== null; o = o.parent) {
      if (!o.visible) return false;
      if (o === m.root) break;
    }
    return true;
  };
  const cellOf = (m: Member): void => {
    const e = m.mesh.matrixWorld.elements;
    m.cx = Math.floor(e[12]! / cellSize);
    m.cy = Math.floor(e[13]! / cellSize);
    m.cz = Math.floor(e[14]! / cellSize);
  };

  /** Put a member in the group its key names now (or none). */
  const regroup = (m: Member): void => {
    const isMarked = m.mesh.userData[BATCH_KEY] !== undefined;
    if (isMarked !== m.marked) {
      m.marked = isMarked;
      marked += isMarked ? 1 : -1;
    }
    const parts = isMarked && shown(m) ? batchKeyParts(m.mesh) : null;
    if (parts === null) {
      leave(m);
      return;
    }
    const detailed = trianglesOf(parts.geometry) >= detailedTriangles;
    if (detailed) {
      cellOf(m);
      pos[0] = m.mesh.matrixWorld.elements[12]!;
      pos[1] = m.mesh.matrixWorld.elements[13]!;
      pos[2] = m.mesh.matrixWorld.elements[14]!;
    }
    const key = batchKey(parts, detailed ? pos : null, cellSize);
    const current = m.group;
    if (current !== null && current.key === key) {
      if (m.scale !== parts.scale) {
        m.scale = parts.scale;
        if (current.inst !== null && m.batched && writeMatrix(current, m)) writtenGroups.add(current);
      }
      return;
    }
    leave(m);
    let g = groups.get(key);
    if (g === undefined) {
      g = { key, parts, detailed, members: [], inst: null, unlisten: () => undefined, materialVersion: parts.material.version };
      groups.set(key, g);
    }
    join(g, m, parts.scale);
  };

  /** A group whose members changed: its batch made, grown, refilled or released. */
  const settle = (g: Group): void => {
    regroups += 1;
    const n = g.members.length;
    if (n < minGroup) {
      release(g);
      if (n === 0) groups.delete(g.key);
      return;
    }
    if (g.inst === null || g.inst.capacity < n) {
      release(g);
      const inst = createAttributeInstancedMesh(g.parts.geometry, g.parts.material, batchCapacity(n));
      const mesh = inst.mesh;
      mesh.name = `tl-batch:${g.key}`;
      mesh.castShadow = g.parts.castShadow;
      mesh.receiveShadow = g.parts.receiveShadow;
      mesh.userData['tlBatch'] = true;
      // Picking goes to the members (they keep their entity ids); the batch is drawn only.
      mesh.raycast = () => undefined;
      g.inst = inst;
      // A material disposed before the next frame (its last box went) takes the batch's
      // render objects with it; the batch's own geometry and instance buffer go right after.
      const material = g.parts.material;
      const group = g;
      const onMaterialDispose = (): void => {
        if (group.inst !== inst) return;
        // The batch goes with its material. Its render objects go by the material's own event, which
        // is still being dispatched (three calls every listener, also one removed meanwhile): the
        // object and its geometry are disposed after it, so no render object is released twice.
        group.unlisten();
        group.unlisten = () => undefined;
        group.inst = null;
        inst.mesh.removeFromParent();
        queueMicrotask(() => inst.dispose());
        for (const m of group.members) {
          unbatch(m);
          dirty.add(m);
        }
        changedGroups.add(group);
      };
      material.addEventListener('dispose', onMaterialDispose);
      g.unlisten = () => material.removeEventListener('dispose', onMaterialDispose);
      scene.add(mesh);
      for (const m of g.members) {
        writeMatrix(g, m);
        batch(m);
      }
    }
    writtenGroups.add(g);
  };

  const countNow = (): void => {
    let n = 0;
    let batched = 0;
    for (const g of groups.values()) {
      if (g.inst === null) continue;
      n += 1;
      batched += g.members.length;
    }
    counts = { groups: n, batched, single: Math.max(0, marked - batched) };
  };

  const forget = (m: Member): void => {
    leave(m);
    if (m.marked) marked -= 1;
    members.delete(m.mesh);
    dirty.delete(m);
    movedNow.delete(m);
  };

  const api: AutoBatcher = {
    listed(o) {
      if (disposed || byRoot.has(o)) return;
      const list: Member[] = [];
      o.traverse((x) => {
        const mesh = x as THREE.Mesh;
        if (mesh.isMesh !== true || mesh.userData['tlBatch'] === true) return;
        let m = members.get(mesh);
        if (m === undefined) {
          m = { mesh, root: o, group: null, slot: -1, scale: null, cx: 0, cy: 0, cz: 0, marked: false, batched: false };
          members.set(mesh, m);
        } else {
          // Listed again on its own (a node moved out from below a mesh): it belongs to the nearer listing.
          const before = byRoot.get(m.root);
          if (before !== undefined) before.splice(before.indexOf(m), 1);
          m.root = o;
        }
        list.push(m);
        dirty.add(m);
      });
      byRoot.set(o, list);
    },
    unlisted(o) {
      const list = byRoot.get(o);
      if (list === undefined) return;
      byRoot.delete(o);
      for (const m of list) forget(m);
    },
    moved(o) {
      const list = byRoot.get(o);
      if (list === undefined) return;
      for (const m of list) if (m.group !== null) movedNow.add(m);
    },
    touch(o) {
      if (disposed) return;
      o.traverse((x) => {
        const m = members.get(x as THREE.Mesh);
        if (m !== undefined) dirty.add(m);
      });
    },
    touchAll() {
      if (disposed) return;
      for (const m of members.values()) dirty.add(m);
    },
    update(camera) {
      if (disposed) return;
      // The world matrices of this frame (also when off: a host may leave the renderer's own pass out,
      // `scene.matrixWorldAutoUpdate = false`, so the scene is not walked twice per frame).
      scene.updateMatrixWorld();
      // A camera outside the scene (the view's) is updated the way the renderer does it.
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      const finish = (): void => {
        lastRegroups = regroups;
        lastCopies = copies;
        regroupsTotal += regroups;
        copiesTotal += copies;
        regroups = 0;
        copies = 0;
      };
      if (!enabled) {
        movedNow.clear();
        dirty.clear();
        finish();
        return;
      }
      // A material changed in place (`needsUpdate`: transparency, visibility, maps): its members are grouped again.
      for (const g of groups.values()) {
        const v = g.parts.material.version;
        if (v === g.materialVersion) continue;
        g.materialVersion = v;
        for (const m of g.members) dirty.add(m);
      }
      // Moved members: their matrix, or (detailed geometry leaving its cell) a new group.
      for (const m of movedNow) {
        const g = m.group;
        if (g === null) continue;
        if (g.detailed) {
          const { cx, cy, cz } = m;
          cellOf(m);
          if (m.cx !== cx || m.cy !== cy || m.cz !== cz) {
            dirty.add(m);
            continue;
          }
        }
        if (g.inst !== null && m.batched && writeMatrix(g, m)) writtenGroups.add(g);
      }
      movedNow.clear();
      for (const m of dirty) regroup(m);
      dirty.clear();
      for (const g of changedGroups) settle(g);
      if (changedGroups.size > 0) countNow();
      changedGroups.clear();
      for (const g of writtenGroups) {
        if (g.inst === null) continue;
        g.inst.count = g.members.length;
        g.inst.markChanged();
      }
      writtenGroups.clear();
      finish();
    },
    diagnostics: () => ({ ...counts, regroups: lastRegroups, matrixCopies: lastCopies, regroupsTotal, matrixCopiesTotal: copiesTotal }),
    setEnabled(on) {
      if (on === enabled || disposed) return;
      enabled = on;
      if (!on) {
        for (const g of groups.values()) {
          release(g);
          for (const m of g.members) {
            m.group = null;
            m.slot = -1;
          }
        }
        groups.clear();
        changedGroups.clear();
        writtenGroups.clear();
        counts = { groups: 0, batched: 0, single: 0 };
      } else api.touchAll();
    },
    dispose() {
      if (disposed) return;
      api.setEnabled(false);
      members.clear();
      byRoot.clear();
      dirty.clear();
      movedNow.clear();
      disposed = true;
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
