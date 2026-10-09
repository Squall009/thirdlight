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
import { ChunkLodPicker, TAN_HALF_REFERENCE, type CopyLodGroup } from './instance-lod';
import { INSTANCE_CHUNK_METERS, INSTANCE_FLOATS } from '@thirdlight/runtime';
import { INSTANCE_CHUNK_COPIES, prepareInstanceSet, writeCopyMatrices, type PreparedChunk, type PreparedInstanceSet, type PrepareOptions, type PrepareParts } from './instance-prepare';

export { chunkCopies, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, INSTANCE_MAX_SPATIAL_CHUNKS } from './instance-prepare';
import { LOD_CULL_LEVEL_KEY, LodTuning } from './lod-switch';
import { KEEP_MATERIAL_KEY } from './material-keys';

/** `mesh.userData[INSTANCE_SET_KEY]`: the mesh draws copies of an instance set (one chunk, one mesh and level). */
export const INSTANCE_SET_KEY = 'tlInstanceSet';

export { INSTANCE_CHUNK_METERS };

export interface BuiltInstanceSet {
  /** Holds the instanced meshes; attach it under the entity's node. */
  readonly group: THREE.Group;
  /** The chunk meshes (plain meshes drawing instance-matrix columns; a ray hit names the copy's slot as `instanceId`). */
  readonly meshes: readonly THREE.Mesh[];
  /** Editor preview: redraw copy `index` at a transform (position xyz, quaternion xyzw, scale xyz). */
  setCopy(index: number, transform: readonly number[]): void;
  /** Redraw several copies at once (each draw uploaded once; a copy scaled to 0 is drawn as nothing and leaves the bounds as they are). */
  setCopies(changes: readonly { readonly index: number; readonly transform: readonly number[] }[]): void;
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
  /** Copies per chunk the count grid aims at (absent: {@link INSTANCE_CHUNK_COPIES}); a large value leaves the chunks to `chunkSize`. */
  readonly copiesPerChunk?: number;
  readonly tuning?: LodTuning;
  readonly density?: InstanceDensity | null;
  /**
   * A density falloff by distance instead (metres at unit scale: all copies
   * nearer than `start`, `min` of them from `end` on; a larger copy thins
   * that much farther), over `density`.
   */
  readonly densityDistance?: { readonly start: number; readonly end: number; readonly min: number };
  readonly lodPerCopy?: boolean;
  /**
   * The set's arithmetic made ahead (`instance-prepare.ts`, on a worker) from
   * these copies and {@link instanceSetPlan}'s parts and options; absent: made here.
   */
  readonly prepared?: PreparedInstanceSet;
  /**
   * A far level drawn as an impostor (`impostor.ts`): its quad mesh (at the
   * model's origin) and the screen size it takes over below (the share of the
   * view's height the model covers, as the model's own levels switch): the
   * model's levels from there on are left out (its cull level, past it, stays).
   */
  readonly impostor?: { readonly mesh: THREE.Mesh; readonly size: number };
  /**
   * Copies written in place ({@link BuiltInstanceSet.setCopies}) moved: the
   * world spheres (x, y, z, r) of the chunks they were and are in. Nothing
   * else hears of such a move (the meshes stay where they are), so a cached
   * shadow near them would keep showing them where they were.
   */
  readonly moved?: (spheres: readonly number[]) => void;
}

/** One mesh of the template: its offset in the model, and its LOD (index into `lods`, level) if it has one. */
interface Part {
  readonly mesh: THREE.Mesh;
  readonly local: THREE.Matrix4;
  readonly lod: number;
  readonly level: number;
}

/** How a set of a template is made: its meshes and levels, the density falloff it draws with, and what its arithmetic reads. */
export interface InstanceSetPlan {
  readonly parts: readonly Part[];
  readonly groups: readonly CopyLodGroup[];
  /** The model's radius at its most detailed level (the density falloff's screen sizes are of it). */
  readonly radius: number;
  readonly density: InstanceDensity | null;
  /** The arithmetic's inputs (`prepareInstanceSet`). */
  readonly prepareParts: PrepareParts;
  readonly prepareOptions: PrepareOptions;
}

/** The plan of a set of `template` with `options` (cheap: the template's meshes, not its copies). */
export function instanceSetPlan(template: ModelInstance, options: InstanceSetOptions = {}): InstanceSetPlan {
  template.glbRoot.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.glbRoot.matrixWorld).invert();
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
  let groups: CopyLodGroup[] = lods.map((l) => ({ distances: l.levels.map((v) => v.distance), culls: l.levels[l.levels.length - 1]?.object.userData[LOD_CULL_LEVEL_KEY] === true }));
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
  const imp = options.impostor;
  if (imp !== undefined && radius > 0) {
    // Its distance is where the model's radius covers its screen size (as the model's own levels switch).
    const impDistance = radius / (TAN_HALF_REFERENCE * imp.size);
    // The impostor joins the first LOD group as the level at its distance (a model without levels gets one group:
    // all its meshes near, the impostor far); the levels it replaces go, a cull level past it stays.
    if (groups.length === 0) {
      for (let k = 0; k < parts.length; k++) if (parts[k]!.lod < 0) parts[k] = { ...parts[k]!, lod: 0, level: 0 };
      groups = [{ distances: [0, impDistance], culls: false }];
      parts.push({ mesh: imp.mesh, local: new THREE.Matrix4(), lod: 0, level: 1 });
    } else {
      const g = groups[0]!;
      const cull = g.culls && g.distances[g.distances.length - 1]! > impDistance;
      const kept = g.distances.filter((d, l) => l === 0 || (d < impDistance && !(g.culls && l === g.distances.length - 1)));
      const at = kept.length;
      const distances = [...kept, impDistance, ...(cull ? [g.distances[g.distances.length - 1]!] : [])];
      const last = g.distances.length - 1;
      const remap = (level: number): number => (level < at ? level : g.culls && level === last && cull ? at + 1 : -1);
      for (let k = parts.length - 1; k >= 0; k--) {
        const p = parts[k]!;
        if (p.lod !== 0) continue;
        const level = remap(p.level);
        if (level < 0) parts.splice(k, 1);
        else parts[k] = { ...p, level };
      }
      parts.push({ mesh: imp.mesh, local: new THREE.Matrix4(), lod: 0, level: at });
      groups[0] = { distances, culls: cull };
    }
  }
  // A falloff by distance is the screen sizes the model's radius covers at those distances.
  const dd = options.densityDistance;
  const falloff: InstanceDensity | null | undefined = dd !== undefined && radius > 0 ? { start: radius / (TAN_HALF_REFERENCE * dd.start), end: radius / (TAN_HALF_REFERENCE * Math.max(dd.start, dd.end)), min: dd.min } : options.density;
  const density = falloff !== undefined && falloff !== null && falloff.min < 1 ? falloff : null;
  const locals = new Float64Array(parts.length * 16);
  const spheres = new Float64Array(parts.length * 4);
  parts.forEach((p, k) => {
    p.local.toArray(locals, k * 16);
    const g = p.mesh.geometry;
    if (g.boundingSphere === null) g.computeBoundingSphere();
    spheres.set([g.boundingSphere!.center.x, g.boundingSphere!.center.y, g.boundingSphere!.center.z, g.boundingSphere!.radius], k * 4);
  });
  return {
    parts,
    groups,
    radius,
    density,
    prepareParts: { locals, spheres },
    prepareOptions: { perCopy: groups.length > 0 || density !== null, copiesPerChunk: options.copiesPerChunk ?? INSTANCE_CHUNK_COPIES, ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}) },
  };
}

/**
 * Build the instanced meshes of `template` (a model instance that is not
 * attached anywhere; it stays alive while the set is shown) for the first
 * `count` copies of `floats`.
 */
export function buildInstanceSet(template: ModelInstance, floats: Float32Array, count: number, name = 'instances', options: InstanceSetOptions = {}): BuiltInstanceSet {
  const b = beginInstanceSet(template, floats, count, name, options);
  b.step(Number.POSITIVE_INFINITY);
  return b.set;
}

/**
 * An instance set made a few chunks at a time ({@link beginInstanceSet}): a
 * large set (a landscape's scatter group: hundreds of chunks, a draw per mesh
 * and level each) costs the page milliseconds to make, more than a frame
 * spares, so its maker spreads it over frames and shows it once it is done.
 */
export interface InstanceSetBuilder {
  /** The set (draw it, write it or ask it only once {@link step} said it is done). */
  readonly set: BuiltInstanceSet;
  /** Make chunks until `until` (a `performance.now()` time; at least one chunk or draw a call); returns whether every chunk is made. */
  step(until: number): boolean;
  /**
   * Once made: cull its chunks for `view` ahead of being shown, at the place
   * they will have under a parent at `parentWorld` (each copy's world sphere
   * and level worked out, the drawn order written), until `until` (at least
   * one draw a call); returns whether every chunk is culled. A large set
   * shown all at once would do this for every copy in its first frame.
   */
  prime(view: CullView, parentWorld: THREE.Matrix4, until: number): boolean;
}

/** {@link buildInstanceSet} made a step at a time (see {@link InstanceSetBuilder}). */
export function beginInstanceSet(template: ModelInstance, floats: Float32Array, count: number, name = 'instances', options: InstanceSetOptions = {}): InstanceSetBuilder {
  const plan = instanceSetPlan(template, options);
  const { parts, groups, radius, density } = plan;
  const tuning = options.tuning ?? new LodTuning();
  const prepared = options.prepared ?? prepareInstanceSet(floats, count, plan.prepareParts, plan.prepareOptions);
  const n = prepared.count;
  const chunkOf = prepared.chunkOf;
  const group = new THREE.Group();
  group.name = name;
  /** `changed`: a copy moved since the chunk's draws were last culled. */
  interface Chunk { copies: Uint32Array; center: Float64Array; node: THREE.Group; meshes: AttributeInstancedMesh[]; picker: ChunkLodPicker | null; changed: boolean; culler: ViewCullable }
  const chunks: Chunk[] = [];
  /** Copy → its slot in its chunk. */
  const slotOf = new Int32Array(n);
  const meshes: THREE.Mesh[] = [];
  /** A chunk mesh → its chunk, part, the copy index of each slot, and its instances. */
  const meta = new Map<THREE.Object3D, { chunk: Chunk; part: Part; copies: Uint32Array; inst: AttributeInstancedMesh }>();
  const makeChunk = (pc: PreparedChunk): void => {
    const chunk: Omit<Chunk, 'culler'> & { culler?: ViewCullable } = { copies: pc.copies, center: pc.center, node: new THREE.Group(), meshes: [], picker: null, changed: true };
    chunk.culler = chunkCuller(chunk, tuning);
    chunks.push(chunk as Chunk);
    if (pc.copies.length === 0) return;
    pc.copies.forEach((copy, slot) => {
      slotOf[copy] = slot;
    });
    chunk.node.name = `${name}:chunk`;
    chunk.node.position.set(pc.center[0]!, pc.center[1]!, pc.center[2]!);
    if (plan.prepareOptions.perCopy && pc.origins !== null && pc.scales !== null && pc.ranks !== null) {
      chunk.picker = new ChunkLodPicker({ origins: pc.origins, scales: pc.scales, ranks: pc.ranks, count: pc.copies.length }, groups, density !== null ? { radius, falloff: density } : null, tuning, options.lodPerCopy === true, pc.stats ?? undefined);
    }
    group.add(chunk.node);
  };
  /** Mesh `k` of the model's draw in the chunk made last. */
  const makePart = (pc: PreparedChunk, k: number): void => {
    const chunk = chunks[chunks.length - 1]!;
    const part = parts[k]!;
    const filter = chunk.picker?.filter(part.lod, part.level);
    const inst = createAttributeInstancedMesh(part.mesh.geometry, part.mesh.material as THREE.Material, pc.copies.length, { raycast: true, group: chunk.culler!, matrices: pc.matrices[k]!, ...(filter !== undefined ? { filter } : {}) });
    inst.count = pc.copies.length;
    inst.mesh.name = part.mesh.name;
    // Tools counting instance-set copies (the perf harness's scene walk) find the chunk draws by it.
    inst.mesh.userData[INSTANCE_SET_KEY] = true;
    // A part whose material is its own (an impostor's quad) keeps it when the set is dressed.
    if (part.mesh.userData[KEEP_MATERIAL_KEY] === true) inst.mesh.userData[KEEP_MATERIAL_KEY] = true;
    // The set's own flags go on when it is attached (an instance set casts only when it says so).
    inst.mesh.castShadow = false;
    inst.mesh.receiveShadow = true;
    inst.markChanged(pc.bounds.subarray(k * 4, k * 4 + 4));
    chunk.node.add(inst.mesh);
    chunk.meshes.push(inst);
    meshes.push(inst.mesh);
    meta.set(inst.mesh, { chunk, part, copies: pc.copies, inst });
  };
  /** Makes the chunks a draw at a time (a dense chunk's draws, each with buffers per copy, are a millisecond or more each). */
  const making = (function* (): Generator<void, void, void> {
    for (const pc of prepared.chunks) {
      makeChunk(pc);
      yield;
      for (let k = 0; k < parts.length && pc.copies.length > 0; k += 1) {
        makePart(pc, k);
        yield;
      }
    }
  })();
  let made = prepared.chunks.length === 0;
  /** Chunks culled ahead ({@link InstanceSetBuilder.prime}), and the set's world matrix there. */
  let primed = 0;
  let primedDraw = 0;
  const groupWorld = new THREE.Matrix4();
  const place = new Float64Array(16);
  const keep = [0, 0, 0, -1];
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const worldSphere = new THREE.Sphere();
  // One mesh per level stands for its copies in the counts (of the first LOD group; the first mesh without one).
  const counted = groups.length > 0 ? parts.flatMap((p, k) => (p.lod === 0 && parts.findIndex((q) => q.lod === 0 && q.level === p.level) === k ? [k] : [])) : parts.length > 0 ? [0] : [];
  const set: BuiltInstanceSet = {
    group,
    meshes,
    count: n,
    get chunks() {
      return chunks.filter((c) => c.copies.length > 0).length;
    },
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
      this.setCopies([{ index, transform: t }]);
    },
    setCopies(changes): void {
      /** Per chunk touched: whether every copy written there shrank to nothing. */
      const touched = new Map<Chunk, boolean>();
      for (const { index, transform: t } of changes) {
        if (index < 0 || index >= n || t.length < INSTANCE_FLOATS) continue;
        const chunk = chunks[chunkOf[index]!]!;
        const c = chunk.center;
        const slot = slotOf[index]!;
        const size = Math.max(Math.abs(t[7]!), Math.abs(t[8]!), Math.abs(t[9]!));
        chunk.picker?.moveCopy(slot, t[0]! - c[0]!, t[1]! - c[1]!, t[2]! - c[2]!, size);
        chunk.changed = true;
        writeCopyMatrices(t, 0, c, plan.prepareParts, chunk.meshes.map((inst) => inst.array), slot, place);
        touched.set(chunk, (touched.get(chunk) ?? true) && size === 0);
      }
      const moved = options.moved;
      const spheres: number[] = [];
      /** The world sphere of a chunk's first draw (its copies' bounds). */
      const sphereOf = (chunk: Chunk): void => {
        const inst = chunk.meshes[0];
        const s = inst?.mesh.geometry.boundingSphere;
        if (inst === undefined || s === null || s === undefined || s.isEmpty()) return;
        inst.mesh.updateWorldMatrix(true, false);
        worldSphere.copy(s).applyMatrix4(inst.mesh.matrixWorld);
        spheres.push(worldSphere.center.x, worldSphere.center.y, worldSphere.center.z, worldSphere.radius);
      };
      if (moved !== undefined) for (const chunk of touched.keys()) sphereOf(chunk);
      for (const [chunk, shrunk] of touched) {
        for (const inst of chunk.meshes) {
          // Copies shrunk to nothing (hidden) leave the bounds as they are: still around every copy drawn.
          const s = inst.mesh.geometry.boundingSphere;
          if (shrunk && s !== null) {
            keep[0] = s.center.x;
            keep[1] = s.center.y;
            keep[2] = s.center.z;
            keep[3] = s.isEmpty() ? -1 : s.radius;
            inst.markChanged(keep);
          } else inst.markChanged();
        }
      }
      if (moved !== undefined) {
        // The bounds before (taken above, before the refit) and after.
        for (const chunk of touched.keys()) sphereOf(chunk);
        if (spheres.length > 0) moved(spheres);
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
  return {
    set,
    step(until: number): boolean {
      while (!made) {
        made = making.next().done === true;
        if (performance.now() >= until) break;
      }
      return made;
    },
    prime(view: CullView, parentWorld: THREE.Matrix4, until: number): boolean {
      // The world matrices three's updateMatrixWorld will give them once attached (the same products: a cull then
      // finds them unchanged and keeps the copies' spheres).
      group.updateMatrix();
      groupWorld.multiplyMatrices(parentWorld, group.matrix);
      // A draw at a time (a dense chunk's draws cost a millisecond or more each); its chunk's first places them all.
      while (primed < chunks.length) {
        const c = chunks[primed]!;
        if (primedDraw === 0 && c.meshes.length > 0) {
          c.node.updateMatrix();
          c.node.matrixWorld.multiplyMatrices(groupWorld, c.node.matrix);
          for (const inst of c.meshes) inst.mesh.matrixWorld.multiplyMatrices(c.node.matrixWorld, inst.mesh.matrix);
        }
        if (primedDraw < c.meshes.length) c.meshes[primedDraw++]!.cull(view);
        if (primedDraw >= c.meshes.length) {
          primed += 1;
          primedDraw = 0;
        }
        if (performance.now() >= until) break;
      }
      return primed >= chunks.length;
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
