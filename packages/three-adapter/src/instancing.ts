/**
 * Phase 12 (c): instance sets — one model drawn many times from a transform
 * buffer (10 float32 per copy: position xyz, rotation quaternion xyzw,
 * scale xyz). Each mesh of the model becomes `THREE.InstancedMesh`es
 * sharing the model's geometry and materials; the copy transform is
 * multiplied with the mesh's own offset inside the model. Used by the game
 * adapter and the editor viewport alike.
 *
 * Phase 21.3: culling and LODs. The copies are split into spatial chunks
 * (a grid over the set's two widest axes, about {@link INSTANCE_CHUNK_COPIES}
 * copies per chunk, at most {@link INSTANCE_MAX_CHUNKS}), so the renderer's
 * frustum culling skips the chunks out of view. A model with levels of
 * detail (9.0: `<piece>_LOD<n>`, a `THREE.LOD` in the instance) gets one
 * `THREE.LOD` per chunk at the chunk's centre with the model's switch
 * distances: a chunk draws only the level its distance asks for (before,
 * every level of every copy was drawn). A copy is found again from a picked
 * instanced mesh with `copyOf`, and its bounds with `copyBox`.
 *
 * The meshes own only their instance matrices; geometry, materials and
 * textures stay owned by the prepared model resource (released with it).
 */
import * as THREE from 'three';

import { instanceCapacity } from './batching';
import type { ModelInstance } from './visual';

/** Floats per copy in an instance buffer. */
export const INSTANCE_BUFFER_FLOATS = 10;
/**
 * Copies per chunk the grid aims at (a chunk is one draw per mesh: large
 * enough to keep draws few and its matrices above three's uniform-buffer
 * limit, small enough to cull and pick its LOD locally).
 */
export const INSTANCE_CHUNK_COPIES = 2048;
/** Most chunks per set (bounds the draws of a very large set; 64 chunks × a few meshes stays well under any draw budget). */
export const INSTANCE_MAX_CHUNKS = 64;

export interface BuiltInstanceSet {
  /** Holds the instanced meshes; attach it under the entity's node. */
  readonly group: THREE.Group;
  readonly meshes: readonly THREE.InstancedMesh[];
  /** Phase 15.2 (editor preview): redraw copy `index` at a transform (position xyz, quaternion xyzw, scale xyz). */
  setCopy(index: number, transform: readonly number[]): void;
  /** Phase 21.3: the copy an instance of one of the set's meshes draws (a picked `instanceId`), or null. */
  copyOf(mesh: THREE.Object3D, instanceId: number): number | null;
  /** Phase 21.3: a copy's bounds in world space (its most detailed level; the group's world matrix must be current), or null. */
  copyBox(index: number): THREE.Box3 | null;
  /** Copies drawn (the buffer's count, bounded by its length). */
  readonly count: number;
  /** Release the instance matrices and detach (the model resource is untouched). */
  dispose(): void;
}

/** One mesh of the template: its offset in the model, and its LOD (index into `lods`, level) if it has one. */
interface Part {
  readonly mesh: THREE.Mesh;
  readonly local: THREE.Matrix4;
  readonly lod: number;
  readonly level: number;
}

/** The chunk grid for copy positions: cells along the two widest axes. Pure (unit-tested). */
export function chunkCopies(positions: Float32Array | readonly number[], count: number, target = INSTANCE_CHUNK_COPIES, maxChunks = INSTANCE_MAX_CHUNKS): Int32Array {
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
  if (chunks === 1) return out;
  const ext = [0, 1, 2].map((a) => Math.max(1e-6, max[a]! - min[a]!));
  const axes = [0, 1, 2].sort((p, q) => ext[q]! - ext[p]!);
  const a0 = axes[0]!;
  const a1 = axes[1]!;
  const n0 = Math.max(1, Math.min(chunks, Math.round(Math.sqrt((chunks * ext[a0]!) / ext[a1]!))));
  const n1 = Math.max(1, Math.floor(chunks / n0));
  for (let i = 0; i < count; i += 1) {
    const c0 = Math.min(n0 - 1, Math.floor(((positions[i * 3 + a0]! - min[a0]!) / ext[a0]!) * n0));
    const c1 = Math.min(n1 - 1, Math.floor(((positions[i * 3 + a1]! - min[a1]!) / ext[a1]!) * n1));
    out[i] = c0 * n1 + c1;
  }
  return out;
}

/**
 * Build the instanced meshes of `template` (a model instance that is not
 * attached anywhere; it stays alive while the set is shown) for the first
 * `count` copies of `floats`.
 */
export function buildInstanceSet(template: ModelInstance, floats: Float32Array, count: number, name = 'instances'): BuiltInstanceSet {
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
  const chunkOf = chunkCopies(positions, n);
  let chunkCount = 0;
  for (let i = 0; i < n; i += 1) if (chunkOf[i]! + 1 > chunkCount) chunkCount = chunkOf[i]! + 1;
  interface Chunk { copies: number[]; center: THREE.Vector3; node: THREE.Group; meshes: THREE.InstancedMesh[] }
  const chunks: Chunk[] = [];
  for (let c = 0; c < chunkCount; c += 1) chunks.push({ copies: [], center: new THREE.Vector3(), node: new THREE.Group(), meshes: [] });
  for (let i = 0; i < n; i += 1) chunks[chunkOf[i]!]!.copies.push(i);
  /** Copy → its chunk and slot. */
  const slotOf = new Int32Array(n);
  const meshes: THREE.InstancedMesh[] = [];
  /** An instanced mesh → its chunk, part and the copy index of each slot. */
  const meta = new Map<THREE.Object3D, { chunk: Chunk; part: Part; copies: readonly number[] }>();
  const relative = new THREE.Matrix4();
  const writeCopy = (inst: THREE.InstancedMesh, slot: number, part: Part, center: THREE.Vector3, t: ArrayLike<number>, offset: number): void => {
    pos.set(t[offset]!, t[offset + 1]!, t[offset + 2]!);
    rot.set(t[offset + 3]!, t[offset + 4]!, t[offset + 5]!, t[offset + 6]!).normalize();
    scl.set(t[offset + 7]!, t[offset + 8]!, t[offset + 9]!);
    place.compose(pos, rot, scl).multiply(part.local);
    relative.makeTranslation(-center.x, -center.y, -center.z).multiply(place);
    inst.setMatrixAt(slot, relative);
  };
  for (const chunk of chunks.filter((c) => c.copies.length > 0)) {
    for (const i of chunk.copies) chunk.center.add(pos.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!));
    chunk.center.divideScalar(chunk.copies.length);
    chunk.copies.forEach((copy, slot) => {
      slotOf[copy] = slot;
    });
    chunk.node.name = `${name}:chunk`;
    chunk.node.position.copy(chunk.center);
    // One THREE.LOD per template LOD, at the chunk's centre, with the template's switch distances.
    const chunkLods = lods.map((src) => {
      const lod = new THREE.LOD();
      lod.name = src.name;
      for (const l of src.levels) {
        const holder = new THREE.Group();
        lod.addLevel(holder, l.distance, l.hysteresis);
      }
      chunk.node.add(lod);
      return lod;
    });
    for (const part of parts) {
      // A chunked set's meshes take instanceCapacity's slots (matrices as vertex attributes: its chunks
      // share one shader program); a one-chunk set keeps its exact count as before.
      const inst = new THREE.InstancedMesh(part.mesh.geometry, part.mesh.material, chunks.length > 1 ? instanceCapacity(chunk.copies.length) : chunk.copies.length);
      inst.count = chunk.copies.length;
      inst.name = part.mesh.name;
      inst.castShadow = true;
      inst.receiveShadow = true;
      chunk.copies.forEach((copy, slot) => writeCopy(inst, slot, part, chunk.center, floats, copy * INSTANCE_BUFFER_FLOATS));
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      const parent = part.lod >= 0 ? chunkLods[part.lod]!.levels[part.level]!.object : chunk.node;
      parent.add(inst);
      chunk.meshes.push(inst);
      meshes.push(inst);
      meta.set(inst, { chunk, part, copies: chunk.copies });
    }
    group.add(chunk.node);
  }
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  return {
    group,
    meshes,
    count: n,
    setCopy(index: number, t: readonly number[]): void {
      if (index < 0 || index >= n || t.length < INSTANCE_BUFFER_FLOATS) return;
      const chunk = chunks[chunkOf[index]!]!;
      for (const inst of chunk.meshes) {
        const info = meta.get(inst)!;
        writeCopy(inst, slotOf[index]!, info.part, chunk.center, t, 0);
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
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
        const info = meta.get(inst)!;
        // The most detailed level only (what the copy is at its closest).
        if (info.part.lod >= 0 && info.part.level !== 0) continue;
        inst.updateWorldMatrix(true, false);
        if (inst.geometry.boundingBox === null) inst.geometry.computeBoundingBox();
        inst.getMatrixAt(slotOf[index]!, m);
        box.copy(inst.geometry.boundingBox!).applyMatrix4(m.premultiply(inst.matrixWorld));
        out.union(box);
      }
      return out.isEmpty() ? null : out;
    },
    dispose(): void {
      for (const mesh of meshes) {
        try {
          mesh.dispose();
        } catch {
          /* best effort */
        }
      }
      group.removeFromParent();
    },
  };
}
