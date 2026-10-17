/**
 * The occludees: every draw the view could leave out because something in
 * front hides it, with what it is and where it is.
 *
 * The scene's children are its drawables (render-graph.ts), so the registry
 * follows them: a draw that enters is classified once (its kind: instanced
 * copies, a merged cell, a terrain page, a block or architecture chunk, a
 * model alone, something transparent), one that leaves is dropped. Owners
 * whose draws cannot be told apart by their three.js type mark them
 * (`markOccludee`): block chunks, architecture chunks, terrain pages.
 *
 * Never occludees: lights, points, lines and sprites, and what three is told
 * never to cull (`frustumCulled = false`: the sky, full-screen passes) unless
 * an owner marked it (terrain pages pick their own nodes and are marked).
 *
 * What a culling path needs of an occludee is read when it asks: its world
 * bounds (the geometry's box, for instanced draws the box over every copy,
 * which their owners keep), its triangles and items, and from those the
 * facts the runtime's `occludeeClassOf` decides on.
 */
import * as THREE from 'three';
import { occludeeScreenShare, OCCLUDEE_KINDS, type OccludeeFacts, type OccludeeKind } from '@thirdlight/runtime';

import { mergedMembersOf } from './static-merge';

/** `object.userData[OCCLUDEE_KIND_KEY]`: the kind an owner gave its draw (else it is told from its type). */
export const OCCLUDEE_KIND_KEY = '__tlOccludeeKind';

/** Mark `o` as an occludee of `kind` (block, architecture and terrain draws, which look like any mesh). */
export function markOccludee(o: THREE.Object3D, kind: OccludeeKind): void {
  o.userData[OCCLUDEE_KIND_KEY] = kind;
}

const materialsOf = (m: THREE.Mesh): readonly THREE.Material[] => (Array.isArray(m.material) ? m.material : [m.material]);

/** Whether `m` draws copies of one geometry (three's instanced meshes, or instance attributes). */
export function isInstancedDraw(m: THREE.Mesh): boolean {
  return (m as THREE.InstancedMesh).isInstancedMesh === true || (m.geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry === true;
}

/** What `o` is as an occludee (null: never one). */
export function occludeeKindOf(o: THREE.Object3D): OccludeeKind | null {
  const m = o as THREE.Mesh;
  if (m.isMesh !== true) return null;
  const marked = o.userData[OCCLUDEE_KIND_KEY] as OccludeeKind | undefined;
  if (materialsOf(m).some((x) => x.transparent)) return 'transparent';
  if (marked !== undefined) return marked;
  if (o.frustumCulled === false) return null;
  if (mergedMembersOf(m) !== null) return 'merged';
  return isInstancedDraw(m) ? 'instanced' : 'single';
}

/** The most items a draw can draw: the copies it holds, a merged cell's members, or 1. */
export function drawCapacityOf(mesh: THREE.Mesh, members: readonly unknown[] | null = mergedMembersOf(mesh)): number {
  if (members !== null) return Math.max(1, members.length);
  if ((mesh as THREE.InstancedMesh).isInstancedMesh === true) return Math.max(1, (mesh as THREE.InstancedMesh).count);
  const g = mesh.geometry as THREE.InstancedBufferGeometry;
  if (g.isInstancedBufferGeometry !== true) return 1;
  let n = 0;
  for (const a of Object.values(g.attributes)) {
    const ia = a as THREE.BufferAttribute & { isInstancedBufferAttribute?: boolean; data?: { isInstancedInterleavedBuffer?: boolean; count: number } };
    if (ia.isInstancedBufferAttribute === true) n = Math.max(n, ia.count);
    else if (ia.data?.isInstancedInterleavedBuffer === true) n = Math.max(n, ia.data.count);
  }
  if (Number.isFinite(g.instanceCount)) n = Math.max(n, g.instanceCount);
  return Math.max(1, n);
}

/** Triangles one copy of the geometry draws (its draw range). */
export function drawTrianglesOf(g: THREE.BufferGeometry): number {
  const total = g.index !== null ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  const start = Math.max(0, g.drawRange.start);
  return Math.floor(Math.max(0, Math.min(total - start, g.drawRange.count)) / 3);
}

/** One draw the view could leave out. */
export interface Occludee {
  readonly object: THREE.Mesh;
  readonly kind: OccludeeKind;
}

interface Entry extends Occludee {
  kind: OccludeeKind;
  /** What it was classified with (a new material or geometry classifies it again). */
  material: THREE.Mesh['material'];
  geometry: THREE.BufferGeometry;
  seen: number;
}

const _sphere = new THREE.Sphere();

/** The draws in the scene that occlusion culling may leave out of the view. */
export class OccludeeRegistry {
  private readonly entries = new Map<THREE.Object3D, Entry>();
  private stamp = 0;
  private readonly kinds: Record<OccludeeKind, number> = Object.fromEntries(OCCLUDEE_KINDS.map((k) => [k, 0])) as Record<OccludeeKind, number>;

  /** Follow the scene's drawables (`scene.children`): new ones classified, gone ones dropped; true when that changed anything. */
  sync(children: readonly THREE.Object3D[]): boolean {
    this.stamp += 1;
    let changed = false;
    let seen = 0;
    for (const o of children) {
      const known = this.entries.get(o);
      const m = o as THREE.Mesh;
      if (known !== undefined && known.material === m.material && known.geometry === m.geometry) {
        known.seen = this.stamp;
        seen += 1;
        continue;
      }
      const kind = occludeeKindOf(o);
      if (known !== undefined) {
        this.kinds[known.kind] -= 1;
        this.entries.delete(o);
        changed = true;
      }
      if (kind === null) continue;
      this.entries.set(o, { object: m, kind, material: m.material, geometry: m.geometry, seen: this.stamp });
      this.kinds[kind] += 1;
      seen += 1;
      changed = true;
    }
    // Some left the scene: drop them.
    if (seen < this.entries.size) {
      for (const [o, e] of this.entries) {
        if (e.seen === this.stamp) continue;
        this.entries.delete(o);
        this.kinds[e.kind] -= 1;
      }
      changed = true;
    }
    return changed;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The occludees (in the order they entered). */
  values(): IterableIterator<Occludee> {
    return this.entries.values();
  }

  /** The occludee `o` is (undefined: not one). */
  get(o: THREE.Object3D): Occludee | undefined {
    return this.entries.get(o);
  }

  /** How many occludees there are of each kind. */
  counts(): Readonly<Record<OccludeeKind, number>> {
    return { ...this.kinds };
  }

  clear(): void {
    this.entries.clear();
    for (const k of OCCLUDEE_KINDS) this.kinds[k] = 0;
  }
}

/** The box in the draw's own space over everything it draws (every copy of an instanced draw). */
function localBox(o: Occludee): THREE.Box3 {
  const inst = o.object as THREE.InstancedMesh;
  if (inst.isInstancedMesh === true) {
    if (inst.boundingBox === null) inst.computeBoundingBox();
    return inst.boundingBox!;
  }
  const g = o.object.geometry;
  if (g.boundingBox === null) g.computeBoundingBox();
  return g.boundingBox!;
}

/** An occludee's bounds in the world now (empty: it draws nothing). */
export function occludeeWorldBounds(o: Occludee, out: THREE.Box3): THREE.Box3 {
  return out.copy(localBox(o)).applyMatrix4(o.object.matrixWorld);
}

/**
 * What the runtime decides an occludee's test on, seen from `eye` with a
 * perspective view whose vertical half-angle has tangent `tanHalfFovY`.
 */
export function occludeeFactsOf(o: Occludee, eye: THREE.Vector3, tanHalfFovY: number, box = new THREE.Box3()): OccludeeFacts {
  const world = occludeeWorldBounds(o, box);
  const items = drawCapacityOf(o.object);
  if (world.isEmpty()) return { kind: o.kind, triangles: 0, items, screenShare: 0 };
  world.getBoundingSphere(_sphere);
  return { kind: o.kind, triangles: drawTrianglesOf(o.object.geometry), items, screenShare: occludeeScreenShare(_sphere.radius, _sphere.center.distanceTo(eye), tanHalfFovY) };
}
