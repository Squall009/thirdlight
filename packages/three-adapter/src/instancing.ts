/**
 * Instance sets — one model drawn many times from a transform
 * buffer (10 float32 per copy: position xyz, rotation quaternion xyzw,
 * scale xyz). Each mesh of the model becomes `THREE.InstancedMesh`es
 * sharing the model's geometry and materials; the copy transform is
 * multiplied with the mesh's own offset inside the model. Used by the game
 * adapter and the editor viewport alike.
 *
 * Culling and LODs. The copies are split into spatial chunks
 * (a grid over the set's two widest axes, about {@link INSTANCE_CHUNK_COPIES}
 * copies per chunk, at most {@link INSTANCE_MAX_CHUNKS}), so the renderer's
 * frustum culling skips the chunks out of view. A model with levels of
 * detail (`<piece>_LOD<n>`, a `THREE.LOD` in the instance) gets one draw per
 * mesh and level in each chunk, and every copy is drawn at its own level and
 * thinned out with distance (`instance-lod.ts`). A copy is found again from a picked
 * instanced mesh with `copyOf`, and its bounds with `copyBox`.
 *
 * The meshes own only their instance matrices; geometry, materials and
 * textures stay owned by the prepared model resource (released with it).
 *
 * Each chunk's mesh draws through instance-matrix columns of
 * its own geometry (`attribute-instancing.ts`), not a `THREE.InstancedMesh`
 * — three builds a node program per instanced mesh, so a set of many chunks
 * would build as many programs; this way the chunks of a mesh share one. A chunk mesh
 * is picked per copy like an instanced mesh (the hit's `instanceId`).
 */
import * as THREE from 'three';

import type { InstanceDensity } from '@thirdlight/runtime';

import { createAttributeInstancedMesh, type AttributeInstancedMesh } from './attribute-instancing';
import type { CullView, ViewCullable } from './view-cull';
import type { ModelInstance } from './visual';
import { disposeObjectTree } from './dispose';
import { ChunkLodPicker, copyRank, type CopyLodGroup } from './instance-lod';
import { LOD_CULL_LEVEL_KEY, LodTuning } from './lod-switch';

/** `mesh.userData[INSTANCE_SET_KEY]`: the mesh draws copies of an instance set (one chunk, one mesh and level). */
export const INSTANCE_SET_KEY = 'tlInstanceSet';

/** Floats per copy in an instance buffer. */
export const INSTANCE_BUFFER_FLOATS = 10;
/**
 * Copies per chunk the grid aims at (a chunk is one draw per mesh: large
 * enough to keep draws few and its matrices above three's uniform-buffer
 * limit, small enough to cull locally).
 */
export const INSTANCE_CHUNK_COPIES = 2048;
/** Most chunks per set (bounds the draws of a very large set; 64 chunks × a few meshes stays well under any draw budget). */
export const INSTANCE_MAX_CHUNKS = 64;
/**
 * Most chunks per set when it is also chunked by spatial extent.
 * Chunks out of view are culled, so more of them cost draws only where they
 * are seen; 256 cells keep a set seen whole (from above) at a few hundred
 * draws per mesh. A set larger than 256 cells of its chunk size gets larger
 * cells.
 */
export const INSTANCE_MAX_SPATIAL_CHUNKS = 256;
/**
 * The engine default chunk size (m) of an instance set (the
 * project's `instance_chunk_m`, overridable per set). 32 m: a few seconds'
 * walk for the default 1.8 m character and small next to a typical view
 * distance, so a chunk out of view is culled.
 */
export const INSTANCE_CHUNK_METERS = 32;

export interface BuiltInstanceSet {
  /** Holds the instanced meshes; attach it under the entity's node. */
  readonly group: THREE.Group;
  /** The chunk meshes (plain meshes drawing instance-matrix columns; a ray hit names the copy's slot as `instanceId`). */
  readonly meshes: readonly THREE.Mesh[];
  /** Editor preview: redraw copy `index` at a transform (position xyz, quaternion xyzw, scale xyz). */
  setCopy(index: number, transform: readonly number[]): void;
  /** The copy an instance of one of the set's meshes draws (a picked `instanceId`), or null. */
  copyOf(mesh: THREE.Object3D, instanceId: number): number | null;
  /** A copy's bounds in world space (its most detailed level; the group's world matrix must be current), or null. */
  copyBox(index: number): THREE.Box3 | null;
  /** Copies drawn (the buffer's count, bounded by its length). */
  readonly count: number;
  /** How many chunks the copies were split into (each culled on its own). */
  readonly chunks: number;
  /** What the copies' levels of detail and density hold now (diagnostics). */
  stats(): InstanceSetStats;
  /** Release the instance matrices and detach (the model resource is untouched). */
  dispose(): void;
}

/** An instance set's copies by what they draw now. */
export interface InstanceSetStats {
  readonly copies: number;
  /** Copies the view drew in the last frame it culled. */
  readonly inView: number;
  /** Copies drawn (any pass) at each level (of the model's first LOD group). */
  readonly byLevel: number[];
  /** Copies past the model's cull size, and left out by the density falloff. */
  readonly culled: number;
  readonly thinned: number;
}

/**
 * How a set is built: its chunk size (m), the project's LOD tuning, its
 * density falloff (null: none) and whether each copy picks its own level
 * (else each chunk one level for all its copies).
 */
export interface InstanceSetOptions {
  readonly chunkSize?: number;
  readonly tuning?: LodTuning;
  readonly density?: InstanceDensity | null;
  readonly lodPerCopy?: boolean;
}

/** One mesh of the template: its offset in the model, and its LOD (index into `lods`, level) if it has one. */
interface Part {
  readonly mesh: THREE.Mesh;
  readonly local: THREE.Matrix4;
  readonly lod: number;
  readonly level: number;
}

/**
 * The chunk grid for copy positions: cells along the two widest axes. Pure (unit-tested).
 * By count (about `target` copies per chunk, at most `maxChunks`) and,
 * with `chunkSize` (m), also by extent: no cell is wider than
 * `chunkSize` along either axis (at most {@link INSTANCE_MAX_SPATIAL_CHUNKS}
 * cells; past that the cells grow). The finer of the two grids wins per axis.
 */
export function chunkCopies(positions: Float32Array | readonly number[], count: number, target = INSTANCE_CHUNK_COPIES, maxChunks = INSTANCE_MAX_CHUNKS, chunkSize?: number): Int32Array {
  const out = new Int32Array(count);
  if (count === 0) return out;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const chunks = Math.max(1, Math.min(maxChunks, Math.ceil(count / target)));
  const ext = [0, 1, 2].map((a) => Math.max(1e-6, max[a]! - min[a]!));
  const axes = [0, 1, 2].sort((p, q) => ext[q]! - ext[p]!);
  const a0 = axes[0]!;
  const a1 = axes[1]!;
  let n0 = chunks === 1 ? 1 : Math.max(1, Math.min(chunks, Math.round(Math.sqrt((chunks * ext[a0]!) / ext[a1]!))));
  let n1 = chunks === 1 ? 1 : Math.max(1, Math.floor(chunks / n0));
  if (chunkSize !== undefined && Number.isFinite(chunkSize) && chunkSize > 0) {
    // No cell wider than chunkSize (the cells grow when the set would need more than the cap).
    let size = chunkSize;
    const cells = (s: number): [number, number] => [Math.max(1, Math.ceil(ext[a0]! / s - 1e-9)), Math.max(1, Math.ceil(ext[a1]! / s - 1e-9))];
    let [s0, s1] = cells(size);
    while (s0 * s1 > INSTANCE_MAX_SPATIAL_CHUNKS) {
      size *= Math.sqrt((s0 * s1) / INSTANCE_MAX_SPATIAL_CHUNKS) * 1.001;
      [s0, s1] = cells(size);
    }
    n0 = Math.max(n0, s0);
    n1 = Math.max(n1, s1);
    while (n0 * n1 > INSTANCE_MAX_SPATIAL_CHUNKS) {
      if (n0 >= n1) n0 -= 1;
      else n1 -= 1;
    }
  }
  if (n0 * n1 === 1) return out;
  for (let i = 0; i < count; i += 1) {
    const c0 = Math.min(n0 - 1, Math.floor(((positions[i * 3 + a0]! - min[a0]!) / ext[a0]!) * n0));
    const c1 = Math.min(n1 - 1, Math.floor(((positions[i * 3 + a1]! - min[a1]!) / ext[a1]!) * n1));
    out[i] = c0 * n1 + c1;
  }
  // Only the cells that hold copies become chunks: number them densely.
  const dense = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const c = out[i]!;
    let d = dense.get(c);
    if (d === undefined) {
      d = dense.size;
      dense.set(c, d);
    }
    out[i] = d;
  }
  return out;
}

/**
 * Build the instanced meshes of `template` (a model instance that is not
 * attached anywhere; it stays alive while the set is shown) for the first
 * `count` copies of `floats`.
 */
export function buildInstanceSet(template: ModelInstance, floats: Float32Array, count: number, name = 'instances', options: InstanceSetOptions = {}): BuiltInstanceSet {
  template.glbRoot.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.glbRoot.matrixWorld).invert();
  const group = new THREE.Group();
  group.name = name;
  const n = Math.max(0, Math.min(count, Math.floor(floats.length / INSTANCE_BUFFER_FLOATS)));

  // The template's meshes, each with its LOD and level (the nearest LOD above it).
  const lods: THREE.LOD[] = [];
  const parts: Part[] = [];
  const walk = (node: THREE.Object3D, lod: number, level: number): void => {
    const asLod = node as THREE.LOD;
    if (asLod.isLOD === true && asLod.levels.length > 0) {
      const index = lods.push(asLod) - 1;
      asLod.levels.forEach((l, i) => walk(l.object, index, i));
      return;
    }
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh === true) parts.push({ mesh, local: new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld), lod, level });
    for (const c of node.children) walk(c, lod, level);
  };
  walk(template.glbRoot, -1, 0);
  // Picks per copy when the model has levels or the set thins out; else every copy is drawn (no filter).
  const groups: CopyLodGroup[] = lods.map((l) => ({ distances: l.levels.map((v) => v.distance), culls: l.levels[l.levels.length - 1]?.object.userData[LOD_CULL_LEVEL_KEY] === true }));
  const density = options.density !== undefined && options.density !== null && options.density.min < 1 ? options.density : null;
  const perCopy = groups.length > 0 || density !== null;
  const tuning = options.tuning ?? new LodTuning();
  // The model's radius at its most detailed level (the density falloff's screen sizes are of it).
  const radius = ((): number => {
    const box = new THREE.Box3();
    const b = new THREE.Box3();
    for (const p of parts) {
      if (p.level !== 0) continue;
      const g = p.mesh.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      box.union(b.copy(g.boundingBox!).applyMatrix4(p.local));
    }
    return box.isEmpty() ? 0 : box.getBoundingSphere(new THREE.Sphere()).radius;
  })();

  // Where each copy is, and its chunk.
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const place = new THREE.Matrix4();
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const o = i * INSTANCE_BUFFER_FLOATS;
    positions[i * 3] = floats[o]!;
    positions[i * 3 + 1] = floats[o + 1]!;
    positions[i * 3 + 2] = floats[o + 2]!;
  }
  // Also by extent when a chunk size is given (each chunk culled and LOD'd on its own).
  const chunkOf = chunkCopies(positions, n, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, options.chunkSize);
  let chunkCount = 0;
  for (let i = 0; i < n; i += 1) if (chunkOf[i]! + 1 > chunkCount) chunkCount = chunkOf[i]! + 1;
  /** `changed`: a copy moved since the chunk's draws were last culled. */
  interface Chunk { copies: number[]; center: THREE.Vector3; node: THREE.Group; meshes: AttributeInstancedMesh[]; picker: ChunkLodPicker | null; changed: boolean; culler: ViewCullable }
  const chunks: Chunk[] = [];
  for (let c = 0; c < chunkCount; c += 1) {
    const chunk: Omit<Chunk, 'culler'> & { culler?: ViewCullable } = { copies: [], center: new THREE.Vector3(), node: new THREE.Group(), meshes: [], picker: null, changed: true };
    chunk.culler = chunkCuller(chunk, tuning);
    chunks.push(chunk as Chunk);
  }
  for (let i = 0; i < n; i += 1) chunks[chunkOf[i]!]!.copies.push(i);
  /** Copy → its chunk and slot. */
  const slotOf = new Int32Array(n);
  const meshes: THREE.Mesh[] = [];
  /** A chunk mesh → its chunk, part, the copy index of each slot, and its instances. */
  const meta = new Map<THREE.Object3D, { chunk: Chunk; part: Part; copies: readonly number[]; inst: AttributeInstancedMesh }>();
  /** A copy's placement relative to its chunk's centre (the translation less the centre; affine, so that is all). */
  const placeCopy = (center: THREE.Vector3, t: ArrayLike<number>, offset: number): void => {
    pos.set(t[offset]! - center.x, t[offset + 1]! - center.y, t[offset + 2]! - center.z);
    rot.set(t[offset + 3]!, t[offset + 4]!, t[offset + 5]!, t[offset + 6]!).normalize();
    scl.set(t[offset + 7]!, t[offset + 8]!, t[offset + 9]!);
    place.compose(pos, rot, scl);
  };
  const relative = new THREE.Matrix4();
  const writeCopy = (inst: AttributeInstancedMesh, slot: number, part: Part): void => {
    relative.multiplyMatrices(place, part.local).toArray(inst.array, slot * 16);
  };
  for (const chunk of chunks.filter((c) => c.copies.length > 0)) {
    for (const i of chunk.copies) chunk.center.add(pos.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!));
    chunk.center.divideScalar(chunk.copies.length);
    chunk.copies.forEach((copy, slot) => {
      slotOf[copy] = slot;
    });
    chunk.node.name = `${name}:chunk`;
    chunk.node.position.copy(chunk.center);
    if (perCopy) {
      const k = chunk.copies.length;
      const origins = new Float32Array(k * 3);
      const scales = new Float32Array(k);
      const ranks = new Float32Array(k);
      chunk.copies.forEach((copy, slot) => {
        const o = copy * INSTANCE_BUFFER_FLOATS;
        origins[slot * 3] = floats[o]! - chunk.center.x;
        origins[slot * 3 + 1] = floats[o + 1]! - chunk.center.y;
        origins[slot * 3 + 2] = floats[o + 2]! - chunk.center.z;
        scales[slot] = Math.max(Math.abs(floats[o + 7]!), Math.abs(floats[o + 8]!), Math.abs(floats[o + 9]!));
        ranks[slot] = copyRank(copy);
      });
      chunk.picker = new ChunkLodPicker({ origins, scales, ranks, count: k }, groups, density !== null ? { radius, falloff: density } : null, tuning, options.lodPerCopy === true);
    }
    const made = parts.map((part) => {
      const filter = chunk.picker?.filter(part.lod, part.level);
      const inst = createAttributeInstancedMesh(part.mesh.geometry, part.mesh.material as THREE.Material, chunk.copies.length, { raycast: true, group: chunk.culler, ...(filter !== undefined ? { filter } : {}) });
      inst.count = chunk.copies.length;
      inst.mesh.name = part.mesh.name;
      // Tools counting instance-set copies (the perf harness's scene walk) find the chunk draws by it.
      inst.mesh.userData[INSTANCE_SET_KEY] = true;
      // The set's own flags go on when it is attached (an instance set casts only when it says so).
      inst.mesh.castShadow = false;
      inst.mesh.receiveShadow = true;
      return inst;
    });
    // Each copy placed once, then offset per mesh of the model.
    chunk.copies.forEach((copy, slot) => {
      placeCopy(chunk.center, floats, copy * INSTANCE_BUFFER_FLOATS);
      for (let k = 0; k < parts.length; k += 1) writeCopy(made[k]!, slot, parts[k]!);
    });
    parts.forEach((part, k) => {
      const inst = made[k]!;
      inst.markChanged();
      chunk.node.add(inst.mesh);
      chunk.meshes.push(inst);
      meshes.push(inst.mesh);
      meta.set(inst.mesh, { chunk, part, copies: chunk.copies, inst });
    });
    group.add(chunk.node);
  }
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  // One mesh per level stands for its copies in the counts (of the first LOD group; the first mesh without one).
  const counted = groups.length > 0 ? parts.flatMap((p, k) => (p.lod === 0 && parts.findIndex((q) => q.lod === 0 && q.level === p.level) === k ? [k] : [])) : parts.length > 0 ? [0] : [];
  return {
    group,
    meshes,
    count: n,
    chunks: chunks.filter((c) => c.copies.length > 0).length,
    stats(): InstanceSetStats {
      let inView = 0;
      let culled = 0;
      let thinned = 0;
      const byLevel: number[] = [];
      for (const c of chunks) {
        if (c.copies.length === 0) continue;
        for (const k of counted) inView += c.meshes[k]?.inView ?? 0;
        if (c.picker === null) {
          byLevel[0] = (byLevel[0] ?? 0) + c.copies.length;
          continue;
        }
        const s = c.picker.stats();
        s.byLevel.forEach((v, l) => (byLevel[l] = (byLevel[l] ?? 0) + v));
        culled += s.culled;
        thinned += s.thinned;
      }
      return { copies: n, inView, byLevel, culled, thinned };
    },
    setCopy(index: number, t: readonly number[]): void {
      if (index < 0 || index >= n || t.length < INSTANCE_BUFFER_FLOATS) return;
      const chunk = chunks[chunkOf[index]!]!;
      placeCopy(chunk.center, t, 0);
      chunk.picker?.moveCopy(slotOf[index]!, t[0]! - chunk.center.x, t[1]! - chunk.center.y, t[2]! - chunk.center.z, Math.max(Math.abs(t[7]!), Math.abs(t[8]!), Math.abs(t[9]!)));
      chunk.changed = true;
      for (const inst of chunk.meshes) {
        const info = meta.get(inst.mesh)!;
        writeCopy(inst, slotOf[index]!, info.part);
        inst.markChanged();
      }
    },
    copyOf(mesh: THREE.Object3D, instanceId: number): number | null {
      const info = meta.get(mesh);
      return info === undefined ? null : (info.copies[instanceId] ?? null);
    },
    copyBox(index: number): THREE.Box3 | null {
      if (index < 0 || index >= n) return null;
      const chunk = chunks[chunkOf[index]!]!;
      const out = new THREE.Box3();
      for (const inst of chunk.meshes) {
        const info = meta.get(inst.mesh)!;
        // The most detailed level only (what the copy is at its closest).
        if (info.part.lod >= 0 && info.part.level !== 0) continue;
        inst.mesh.updateWorldMatrix(true, false);
        const source = info.part.mesh.geometry;
        if (source.boundingBox === null) source.computeBoundingBox();
        inst.getMatrixAt(slotOf[index]!, m);
        box.copy(source.boundingBox!).applyMatrix4(m.premultiply(inst.mesh.matrixWorld));
        out.union(box);
      }
      return out.isEmpty() ? null : out;
    },
    dispose(): void {
      group.removeFromParent();
      // Every chunk mesh and LOD node: render objects; Each chunk mesh's own geometry
      // and instance buffer (never the model's geometry).
      for (const c of chunks) for (const inst of c.meshes) inst.dispose();
      disposeObjectTree(group);
    },
  };
}

/**
 * Culls a chunk's draws (one per mesh and level) as one: while neither the
 * view, the chunk's place, the project's LOD tuning nor a copy changed, one
 * check stands for all of them (a still camera over many small sets with
 * levels made every draw compare its own matrices each frame). The draws
 * are listed in the scene on their own (the render graph writes their world
 * matrices, not the chunk node's), all at the chunk's place: the first one's
 * matrix stands for the chunk's.
 */
function chunkCuller(chunk: { readonly meshes: readonly AttributeInstancedMesh[]; changed: boolean }, tuning: LodTuning): ViewCullable {
  const world = new Float64Array(16).fill(Number.NaN);
  let view: CullView | null = null;
  let stamp = -1;
  let revision = -1;
  return {
    cull(v: CullView): boolean {
      const first = chunk.meshes[0];
      if (first === undefined) return false;
      const w = first.mesh.matrixWorld.elements;
      let same = !chunk.changed && v === view && v.stamp === stamp && tuning.revision === revision;
      for (let k = 0; k < 16 && same; k += 1) if (world[k] !== w[k]) same = false;
      if (same) return false;
      view = v;
      stamp = v.stamp;
      revision = tuning.revision;
      chunk.changed = false;
      for (let k = 0; k < 16; k += 1) world[k] = w[k]!;
      let reordered = false;
      for (const m of chunk.meshes) if (m.cull(v)) reordered = true;
      return reordered;
    },
  };
}
