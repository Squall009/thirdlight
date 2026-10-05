/**
 * Static batching: the meshes of objects that never move, merged into one
 * geometry per material and world cell.
 *
 * Automatic instancing (`batching.ts`) needs several copies of one mesh, so a
 * scene of unique placed models (a village of props placed once, mirrored
 * parts) still draws most of them one by one, in the main pass and again in
 * the shadow pass. Here the meshes of `static` objects that draw alone and
 * share a material, shadow flags, vertex layout, scene and world cell are
 * copied into one geometry in world space (Unity's static batching, Godot's
 * mesh merging) and drawn as one mesh per cell. The members stay where they
 * are — entities, picking, bounds, colliders and scripts keep working on them
 * — and only move to the batched layer, which cameras do not draw.
 *
 * - **Levels of detail:** a merged geometry holds every level of a member's
 *   LOD (the levels not drawn yet are copied with it), and its index lists
 *   only the levels attached now. A level switch, a hidden member or one
 *   that moves rewrites the cell's index, not its vertices.
 * - **Moving and hiding:** a member a script moves or hides leaves the merged
 *   draw at once (it is drawn on its own or not at all); after it has stayed
 *   put for {@link MERGE_QUIET_MS} its vertices are written again where they
 *   were and it rejoins.
 * - **Built when:** at load in Play and the export (all at once, before the
 *   frame is drawn); in the editor in the background, a cell per frame
 *   within a time budget, the members drawn alone until it is ready.
 * - **Scenes:** the scope a host marks (its scene) is part of the key, so a
 *   scene unload or reload drops or rebuilds only its own cells; a host marks
 *   no object kept loaded across scenes.
 * - **Not merged:** materials that read the object's own frame (its origin or
 *   object-space position: the result would be the world's), vertex layouts
 *   that differ, morph targets — and everything instancing refuses.
 *
 * The merged copies cost GPU memory beside the sources (a source drawn only
 * through its cell is never uploaded); diagnostics report the bytes. There is
 * no count cap.
 */
import * as THREE from 'three';

import type { BatchKeyParts } from './batching';
import { LOD_OWNER_KEY } from './lod-switch';
import { STATIC_CASTER_KEY } from './shadow-casters';

/** `mesh.userData[STATIC_KEY]`: the scope (a scene id) of a mesh whose object never moves; absent: not static. */
export const STATIC_KEY = '__tlStatic';

/** `material.userData[OBJECT_FRAME_KEY]`: the material reads the object's own frame (its origin, object-space position), so it is never merged. */
export const OBJECT_FRAME_KEY = '__tlObjectFrame';

/** `mesh.userData[OCCLUDER_KEY]`: a merged static cell, drawn before the other opaque objects (`occludersFirst`). */
export const OCCLUDER_KEY = '__tlOccluder';

/** What three's render list sorts (the fields the opaque order reads). */
export interface RenderItemLike {
  readonly groupOrder: number;
  readonly renderOrder: number;
  readonly z: number;
  readonly id: number;
  readonly object: THREE.Object3D;
}

/**
 * The opaque order: three's own (group order, render order, nearest centre
 * first) with merged static cells ahead of everything else of the same render
 * order, nearest first among themselves. A merged cell is up to a cell wide,
 * so its centre says little about its nearest walls: by centre it was drawn
 * after the props in front of its far side, and every pixel of those that its
 * walls cover was shaded for nothing (the village class: 142 → 152 fps on
 * WebGPU, GPU-bound). The level's dense static geometry is the occluder; what
 * stands in front of it still passes the depth test.
 */
export function occludersFirst(a: RenderItemLike, b: RenderItemLike): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const oa = a.object.userData[OCCLUDER_KEY] === true ? 0 : 1;
  const ob = b.object.userData[OCCLUDER_KEY] === true ? 0 : 1;
  if (oa !== ob) return oa - ob;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

/** How long a static member must stay put after a move before it rejoins its merged draw (ms). */
export const MERGE_QUIET_MS = 500;

/** Fewest members wanting a cell before it is built (one alone draws the same either way). */
export const MIN_MERGE = 2;

/** The editor's time budget for building cells per frame (ms; at least one cell is built). */
export const MERGE_BACKGROUND_BUDGET_MS = 4;

/** Mark every plain mesh under `root` as static within `scope` (the host's scene); its instanced meshes cast into the static shadow map. */
export function markStatic(root: THREE.Object3D, scope: string): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    if ((m as THREE.InstancedMesh).isInstancedMesh !== true) m.userData[STATIC_KEY] = scope;
    else m.userData[STATIC_CASTER_KEY] = true;
  });
}

/** The static scope of a mesh (null: not static). */
export function staticScopeOf(mesh: THREE.Object3D): string | null {
  const s = mesh.userData[STATIC_KEY];
  return typeof s === 'string' ? s : null;
}

/** Attributes written in world space (always float); the rest are copied as stored. */
const TRANSFORMED: Readonly<Record<string, number>> = { position: 3, normal: 3, tangent: 4 };

const layouts = new WeakMap<THREE.BufferGeometry, string | null>();

/**
 * The vertex layout geometries must share to be merged: attribute names,
 * sizes and (for the copied ones) storage. Null: not mergeable (no
 * positions, morph targets, an attribute in an unexpected shape).
 */
export function mergeLayout(g: THREE.BufferGeometry): string | null {
  if (layouts.has(g)) return layouts.get(g)!;
  let out: string | null = null;
  const morph = Object.values(g.morphAttributes).some((list) => list.length > 0);
  if (!morph && g.getAttribute('position') !== undefined) {
    const parts: string[] = [];
    for (const name of Object.keys(g.attributes).sort()) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      const want = TRANSFORMED[name];
      if (want !== undefined) {
        if (a.itemSize !== want) {
          parts.length = 0;
          break;
        }
        parts.push(`${name}:${want}:f`);
      } else {
        const array = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true ? (a as THREE.InterleavedBufferAttribute).data.array : (a as THREE.BufferAttribute).array;
        parts.push(`${name}:${a.itemSize}:${array.constructor.name}:${a.normalized ? 1 : 0}`);
      }
    }
    if (parts.length > 0) out = parts.join(',');
  }
  layouts.set(g, out);
  return out;
}

/** Why a batchable mesh is not merged (null: it may be). */
export function mergeRefusal(mesh: THREE.Mesh): string | null {
  const mat = mesh.material as THREE.Material;
  if (mat.userData[OBJECT_FRAME_KEY] === true) return 'reads the object frame';
  if (mergeLayout(mesh.geometry) === null) return 'vertex layout';
  return null;
}

export interface StaticMergeDiagnostics {
  /** Merged cells drawn (each one draw per pass). */
  readonly cells: number;
  /** Meshes drawn through them. */
  readonly merged: number;
  /** Meshes copied into them (every LOD level and member drawn alone or hidden now included). */
  readonly slots: number;
  /** Cells waiting to be built (their members drawn alone meanwhile). */
  readonly pending: number;
  /** GPU bytes of the merged copies: vertices and indices. */
  readonly vertexBytes: number;
  readonly indexBytes: number;
  /** Cells built in the last frame, since the batcher was made, and the last frame's build time (ms). */
  readonly builds: number;
  readonly buildsTotal: number;
  readonly buildMs: number;
}

export interface StaticMergerOptions {
  /** Side of a world cell, m. */
  readonly cellSize: number;
  /** Build time per frame (ms; Infinity: every pending cell before the frame is drawn). */
  readonly budgetMs: number;
  /** Where merged meshes are drawn. */
  readonly scene: THREE.Scene;
  /** A member started (or stopped) being drawn through its cell outside a `want` call (a cell was built or dropped). */
  readonly onMerged: (mesh: THREE.Mesh, on: boolean) => void;
  /** What a mesh would be grouped by (null: not batchable), for the levels of a LOD not attached yet. */
  readonly partsOf: (mesh: THREE.Mesh) => BatchKeyParts | null;
  readonly now?: () => number;
}

export interface StaticMerger {
  /**
   * `mesh` (static, batchable, drawn alone, still) wants its cell: true when
   * it is drawn through it from this frame on, false while the cell is not
   * built yet (it is then announced through `onMerged`).
   */
  want(mesh: THREE.Mesh, parts: BatchKeyParts, scope: string): boolean;
  /** `mesh` is drawn alone (or not at all) from now: it leaves its cell's draw (its copy stays for later). */
  unwant(mesh: THREE.Mesh): void;
  /** `mesh` is gone for good: its copy goes with the next build of its cell. */
  drop(mesh: THREE.Mesh): void;
  /** Build what is pending (within the budget) and rewrite the changed indices; before the draw. */
  update(): void;
  /** Work is left for later frames (a host drawing on demand draws again). */
  pending(): boolean;
  diagnostics(): StaticMergeDiagnostics;
  dispose(): void;
}

interface Slot {
  readonly mesh: THREE.Mesh;
  readonly cell: Cell;
  readonly geometry: THREE.BufferGeometry;
  /** Its vertices in the built geometry (-1: not built yet) and its range in the cell's full index. */
  vStart: number;
  vCount: number;
  iStart: number;
  iCount: number;
  /** The world matrix its vertices were written with, and whether its triangles were turned (a mirroring matrix). */
  readonly matrix: Float64Array;
  flipped: boolean;
  wanted: boolean;
  /** In the drawn index. */
  active: boolean;
}

interface Built {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  /** Every slot's triangles (vertex indices of the built geometry), in slot order. */
  readonly template: Uint32Array;
  readonly index: THREE.BufferAttribute;
  readonly vertices: number;
  readonly vertexBytes: number;
}

interface Cell {
  readonly key: string;
  readonly material: THREE.Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly slots: Set<Slot>;
  built: Built | null;
  /** Slots without vertices in the build, or too many dead ones. */
  needsBuild: boolean;
  /** Vertices of dropped slots still in the build. */
  dead: number;
  wanted: number;
  /** The update a slot was last added in (the editor waits a frame for more to arrive). */
  addedAt: number;
  unlisten: () => void;
}

const sameMatrix = (a: Float64Array, e: readonly number[]): boolean => {
  for (let k = 0; k < 16; k += 1) if (a[k] !== e[k]) return false;
  return true;
};

/** The source's triangles as vertex indices (its draw range; a non-indexed geometry's in order). */
function sourceIndices(g: THREE.BufferGeometry): { read: (i: number) => number; start: number; count: number } {
  const index = g.getIndex();
  const total = index !== null ? index.count : g.getAttribute('position').count;
  const start = Math.max(0, g.drawRange.start);
  const count = Math.max(0, Math.min(total - start, g.drawRange.count));
  const n = count - (count % 3);
  return index !== null ? { read: (i) => index.getX(i), start, count: n } : { read: (i) => i, start, count: n };
}

const tmpM = new THREE.Matrix4();
const tmpN = new THREE.Matrix3();
const tmpR = new THREE.Matrix3();
const tmpV = new THREE.Vector3();

/** Write a slot's vertices into the built attributes at its place, in world space. */
function writeVertices(attrs: ReadonlyMap<string, THREE.BufferAttribute>, slot: Slot): void {
  const g = slot.geometry;
  tmpM.fromArray(slot.matrix);
  tmpN.getNormalMatrix(tmpM);
  tmpR.setFromMatrix4(tmpM);
  const mirrored = tmpM.determinant() < 0;
  const n = slot.vCount;
  for (const [name, out] of attrs) {
    const src = g.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const size = out.itemSize;
    const dst = out.array as unknown as { [i: number]: number; set(a: ArrayLike<number>, at: number): void };
    const base = slot.vStart * size;
    if (name === 'position') {
      for (let i = 0; i < n; i += 1) {
        tmpV.fromBufferAttribute(src, i).applyMatrix4(tmpM);
        dst[base + i * 3] = tmpV.x;
        dst[base + i * 3 + 1] = tmpV.y;
        dst[base + i * 3 + 2] = tmpV.z;
      }
    } else if (name === 'normal' || name === 'tangent') {
      const m = name === 'normal' ? tmpN : tmpR;
      for (let i = 0; i < n; i += 1) {
        tmpV.fromBufferAttribute(src, i).applyMatrix3(m).normalize();
        dst[base + i * size] = tmpV.x;
        dst[base + i * size + 1] = tmpV.y;
        dst[base + i * size + 2] = tmpV.z;
        // A mirroring matrix turns the bitangent's handedness (bitangent = w × cross(normal, tangent)).
        if (size === 4) dst[base + i * 4 + 3] = src.getW(i) * (mirrored ? -1 : 1);
      }
    } else if ((src as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true) {
      const ia = src as THREE.InterleavedBufferAttribute;
      const data = ia.data.array;
      const stride = ia.data.stride;
      for (let i = 0; i < n; i += 1) for (let k = 0; k < size; k += 1) dst[base + i * size + k] = data[i * stride + ia.offset + k]!;
    } else {
      dst.set((src as THREE.BufferAttribute).array.subarray(0, n * size), base);
    }
  }
}

/** A slot's triangles into the template at its place (turned for a mirroring matrix, so the front faces stay front). */
function writeTriangles(template: Uint32Array, slot: Slot): void {
  const src = sourceIndices(slot.geometry);
  const o = slot.vStart;
  for (let t = 0; t < src.count; t += 3) {
    const a = src.read(src.start + t) + o;
    const b = src.read(src.start + t + 1) + o;
    const c = src.read(src.start + t + 2) + o;
    const at = slot.iStart + t;
    template[at] = a;
    template[at + 1] = slot.flipped ? c : b;
    template[at + 2] = slot.flipped ? b : c;
  }
}

export function createStaticMerger(options: StaticMergerOptions): StaticMerger {
  const now = options.now ?? (() => performance.now());
  const cells = new Map<string, Cell>();
  const slots = new Map<THREE.Mesh, Slot>();
  /** Cells to build, and cells whose drawn index changed this frame. */
  const queue = new Set<Cell>();
  const indexDirty = new Set<Cell>();
  /** Cells whose vertices were rewritten in place (uploaded and bounds again). */
  const vertexDirty = new Set<Cell>();
  let frame = 0;
  let builds = 0;
  let buildsTotal = 0;
  let buildMs = 0;
  let disposed = false;

  const keyOf = (mesh: THREE.Mesh, parts: BatchKeyParts, scope: string): string | null => {
    if (mergeRefusal(mesh) !== null) return null;
    const e = mesh.matrixWorld.elements;
    const s = options.cellSize;
    const cell = `${Math.floor(e[12]! / s)},${Math.floor(e[13]! / s)},${Math.floor(e[14]! / s)}`;
    return `${scope}|${parts.material.uuid}|${parts.castShadow ? 1 : 0}${parts.receiveShadow ? 1 : 0}|${cell}|${mergeLayout(mesh.geometry)}`;
  };

  const releaseBuilt = (b: Built): void => {
    b.mesh.removeFromParent();
    // Its render objects go with the object; the merged geometry is all its own.
    b.mesh.dispose();
    b.geometry.dispose();
  };

  const dropCell = (cell: Cell): void => {
    cells.delete(cell.key);
    queue.delete(cell);
    indexDirty.delete(cell);
    vertexDirty.delete(cell);
    cell.unlisten();
    for (const s of cell.slots) {
      slots.delete(s.mesh);
      if (s.active) options.onMerged(s.mesh, false);
    }
    cell.slots.clear();
    if (cell.built !== null) releaseBuilt(cell.built);
    cell.built = null;
  };

  const cellFor = (key: string, parts: BatchKeyParts): Cell => {
    let cell = cells.get(key);
    if (cell !== undefined) return cell;
    const c: Cell = { key, material: parts.material, castShadow: parts.castShadow, receiveShadow: parts.receiveShadow, slots: new Set(), built: null, needsBuild: false, dead: 0, wanted: 0, addedAt: frame, unlisten: () => undefined };
    // A material disposed (its last wearer went) takes its cells with it; the objects are drawn alone again.
    const onDispose = (): void => {
      if (cells.get(key) !== c) return;
      const b = c.built;
      c.built = null;
      if (b !== null) {
        // Its render objects go by the material's own event, still being dispatched: released after it.
        b.mesh.removeFromParent();
        queueMicrotask(() => releaseBuilt(b));
      }
      dropCell(c);
    };
    parts.material.addEventListener('dispose', onDispose);
    c.unlisten = () => parts.material.removeEventListener('dispose', onDispose);
    cells.set(key, c);
    cell = c;
    return cell;
  };

  const addSlot = (mesh: THREE.Mesh, cell: Cell): Slot => {
    const s: Slot = { mesh, cell, geometry: mesh.geometry, vStart: -1, vCount: 0, iStart: 0, iCount: 0, matrix: new Float64Array(16), flipped: false, wanted: false, active: false };
    slots.set(mesh, s);
    cell.slots.add(s);
    cell.needsBuild = true;
    cell.addedAt = frame;
    queue.add(cell);
    return s;
  };

  const removeSlot = (s: Slot): void => {
    const cell = s.cell;
    setWanted(s, false);
    slots.delete(s.mesh);
    cell.slots.delete(s);
    if (cell.slots.size === 0) {
      dropCell(cell);
      return;
    }
    if (s.vStart >= 0 && cell.built !== null) {
      cell.dead += s.vCount;
      // Mostly dead space: built again without it.
      if (cell.dead * 2 > cell.built.vertices) {
        cell.needsBuild = true;
        queue.add(cell);
      }
    }
  };

  const setWanted = (s: Slot, on: boolean): void => {
    if (s.wanted !== on) {
      s.wanted = on;
      s.cell.wanted += on ? 1 : -1;
      if (on && s.cell.needsBuild) queue.add(s.cell);
    }
    if (!on && s.active) {
      s.active = false;
      indexDirty.add(s.cell);
    }
  };

  /** The other levels of a LOD the mesh is a level of: copied with it, so a level switch needs no build. */
  const addLevels = (mesh: THREE.Mesh, scope: string): void => {
    const lod = mesh.userData[LOD_OWNER_KEY] as THREE.LOD | undefined;
    if (lod === undefined) return;
    for (const level of lod.levels) {
      level.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m === mesh || m.isMesh !== true || slots.has(m) || staticScopeOf(m) !== scope || m.userData[LOD_OWNER_KEY] !== lod) return;
        const p = options.partsOf(m);
        const key = p === null ? null : keyOf(m, p, scope);
        if (key !== null) addSlot(m, cellFor(key, p!));
      });
    }
  };

  const build = (cell: Cell): void => {
    const list = [...cell.slots];
    const first = list[0]!.geometry;
    const names = Object.keys(first.attributes);
    let vertices = 0;
    let indices = 0;
    for (const s of list) {
      s.vStart = vertices;
      s.vCount = s.geometry.getAttribute('position').count;
      s.iStart = indices;
      s.iCount = sourceIndices(s.geometry).count;
      s.matrix.set(s.mesh.matrixWorld.elements);
      s.flipped = s.mesh.matrixWorld.determinant() < 0;
      vertices += s.vCount;
      indices += s.iCount;
    }
    const geometry = new THREE.BufferGeometry();
    const attrs = new Map<string, THREE.BufferAttribute>();
    let vertexBytes = 0;
    for (const name of names) {
      const src = first.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      const size = src.itemSize;
      let attr: THREE.BufferAttribute;
      if (TRANSFORMED[name] !== undefined) attr = new THREE.BufferAttribute(new Float32Array(vertices * size), size);
      else {
        const like = (src as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true ? (src as THREE.InterleavedBufferAttribute).data.array : (src as THREE.BufferAttribute).array;
        const Ctor = like.constructor as new (n: number) => THREE.TypedArray;
        attr = new THREE.BufferAttribute(new Ctor(vertices * size), size, src.normalized);
      }
      attrs.set(name, attr);
      geometry.setAttribute(name, attr);
      vertexBytes += attr.array.byteLength;
    }
    const template = new Uint32Array(indices);
    for (const s of list) {
      writeVertices(attrs, s);
      writeTriangles(template, s);
    }
    const index = new THREE.BufferAttribute(vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), 1);
    geometry.setIndex(index);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, cell.material);
    mesh.name = `tl-merged:${cell.key}`;
    mesh.castShadow = cell.castShadow;
    mesh.receiveShadow = cell.receiveShadow;
    // Vertices are in world space: the identity, never recomposed.
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // Drawn only: picking goes to the members (they keep their entities); the batcher and the scene dump skip it.
    mesh.userData['tlBatch'] = true;
    // Its members never move while they are drawn through it. A cell built, dropped or drawing other members
    // changes no shadow: a member is drawn through it or alone at the same place, and entering or leaving the
    // scene, or moving, is reported by the host.
    mesh.userData[STATIC_CASTER_KEY] = true;
    mesh.userData[OCCLUDER_KEY] = true;
    mesh.raycast = () => undefined;
    if (cell.built !== null) releaseBuilt(cell.built);
    cell.built = { mesh, geometry, template, index, vertices, vertexBytes };
    cell.dead = 0;
    cell.needsBuild = false;
    options.scene.add(mesh);
    for (const s of list) {
      if (!s.wanted || s.active) continue;
      s.active = true;
      options.onMerged(s.mesh, true);
    }
    indexDirty.add(cell);
  };

  /** The drawn index: the triangles of the slots drawn now (the rest of the copy waits for a level switch or a return). */
  const writeIndex = (cell: Cell): void => {
    const b = cell.built;
    if (b === null) return;
    const out = b.index.array as Uint16Array | Uint32Array;
    let n = 0;
    for (const s of cell.slots) {
      if (!s.active || s.vStart < 0) continue;
      out.set(b.template.subarray(s.iStart, s.iStart + s.iCount), n);
      n += s.iCount;
    }
    b.geometry.setDrawRange(0, n);
    b.index.needsUpdate = true;
    b.mesh.visible = n > 0;
  };

  const api: StaticMerger = {
    want(mesh, parts, scope) {
      if (disposed) return false;
      const key = keyOf(mesh, parts, scope);
      let s = slots.get(mesh);
      if (key === null) {
        if (s !== undefined) setWanted(s, false);
        return false;
      }
      if (s !== undefined && (s.cell.key !== key || s.geometry !== mesh.geometry)) {
        removeSlot(s);
        s = undefined;
      }
      if (s === undefined) {
        s = addSlot(mesh, cellFor(key, parts));
        addLevels(mesh, scope);
      }
      setWanted(s, true);
      const cell = s.cell;
      if (s.vStart < 0 || cell.built === null) return false;
      // Moved since it was copied (and still now): written again in place.
      if (!sameMatrix(s.matrix, mesh.matrixWorld.elements)) {
        s.matrix.set(mesh.matrixWorld.elements);
        const flipped = mesh.matrixWorld.determinant() < 0;
        if (flipped !== s.flipped) {
          s.flipped = flipped;
          writeTriangles(cell.built.template, s);
        }
        const attrs = new Map<string, THREE.BufferAttribute>();
        for (const [name, a] of Object.entries(cell.built.geometry.attributes)) attrs.set(name, a as THREE.BufferAttribute);
        writeVertices(attrs, s);
        vertexDirty.add(cell);
      }
      if (!s.active) {
        s.active = true;
        indexDirty.add(cell);
      }
      return true;
    },
    unwant(mesh) {
      const s = slots.get(mesh);
      if (s !== undefined) setWanted(s, false);
    },
    drop(mesh) {
      const s = slots.get(mesh);
      if (s !== undefined) removeSlot(s);
    },
    update() {
      if (disposed) return;
      builds = 0;
      const t0 = now();
      for (const cell of queue) {
        if (!cell.needsBuild || cells.get(cell.key) !== cell) {
          queue.delete(cell);
          continue;
        }
        // Waits for a partner (it is queued again when one wants it).
        if (cell.wanted < MIN_MERGE && cell.built === null) {
          queue.delete(cell);
          continue;
        }
        if (options.budgetMs !== Infinity) {
          // In the background: slots may still be arriving (a model's meshes over a few frames), and a frame's budget.
          if (cell.addedAt === frame) continue;
          if (builds > 0 && now() - t0 > options.budgetMs) break;
        }
        build(cell);
        queue.delete(cell);
        builds += 1;
      }
      buildsTotal += builds;
      buildMs = builds > 0 ? Math.round((now() - t0) * 100) / 100 : 0;
      for (const cell of vertexDirty) {
        const b = cell.built;
        if (b === null) continue;
        for (const a of Object.values(b.geometry.attributes)) (a as THREE.BufferAttribute).needsUpdate = true;
        b.geometry.computeBoundingBox();
        b.geometry.computeBoundingSphere();
      }
      vertexDirty.clear();
      for (const cell of indexDirty) writeIndex(cell);
      indexDirty.clear();
      frame += 1;
    },
    pending: () => {
      for (const c of queue) if (c.needsBuild && (c.wanted >= MIN_MERGE || c.built !== null)) return true;
      return false;
    },
    diagnostics() {
      let drawn = 0;
      let merged = 0;
      let pendingCells = 0;
      let vertexBytes = 0;
      let indexBytes = 0;
      for (const c of cells.values()) {
        if (c.needsBuild && (c.wanted >= MIN_MERGE || c.built !== null)) pendingCells += 1;
        const b = c.built;
        if (b === null) continue;
        vertexBytes += b.vertexBytes;
        indexBytes += b.index.array.byteLength;
        if (b.mesh.visible) drawn += 1;
        for (const s of c.slots) if (s.active) merged += 1;
      }
      return { cells: drawn, merged, slots: slots.size, pending: pendingCells, vertexBytes, indexBytes, builds, buildsTotal, buildMs };
    },
    dispose() {
      if (disposed) return;
      for (const c of [...cells.values()]) dropCell(c);
      disposed = true;
    },
  };
  return api;
}
