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
 * Never occludees: lights, points, lines and sprites, a model's `_OCC`
 * stand-ins (occluders.ts: they hide, they are never hidden), what a host
 * draws for itself (`markHostDrawing`: an editor's overlays), and what three
 * is told never to cull (`frustumCulled = false`: the sky, full-screen
 * passes) unless an owner marked it (terrain pages pick their own nodes and
 * are marked).
 *
 * Each occludee also has its occluder role (occluders.ts, the runtime's
 * `occluderRoleOf`): level geometry marked by its owner draws first, so the
 * depth a culling path reads is filled by what hides the most.
 *
 * What a culling path needs of an occludee is read when it asks: its world
 * bounds (the geometry's box, for instanced draws the box over every copy,
 * which their owners keep), its triangles and items, and from those the
 * facts the runtime's `occludeeClassOf` decides on.
 */
import * as THREE from 'three';
import { occludeeScreenShare, OCCLUDEE_KINDS, OCCLUDER_ROLES, type OccludeeFacts, type OccludeeKind, type OccluderRole } from '@thirdlight/runtime';

import { isOccluderStandin, NOT_OCCLUDER_KEY, OCCLUDER_EARLY_RENDER_ORDER, occluderRoleOfDraw } from './occluders';
import { mergedMembersOf } from './static-merge';

/** `object.userData[OCCLUDEE_KIND_KEY]`: the kind an owner gave its draw (else it is told from its type). */
export const OCCLUDEE_KIND_KEY = '__tlOccludeeKind';

/** `object.userData[HOST_DRAWING_KEY]`: what a host draws for itself (an editor's overlays: outlines, gizmos, brush cursors), below this object. */
const HOST_DRAWING_KEY = '__tlHostDrawing';

/** Roots marked so far: a page without any (Play, an export) never walks a draw's parents for the mark. */
let hostDrawings = 0;

/** Mark `root` and everything below it as a host's own drawing: never an occludee (never culled, never tested). */
export function markHostDrawing(root: THREE.Object3D): void {
  if (root.userData[HOST_DRAWING_KEY] === true) return;
  root.userData[HOST_DRAWING_KEY] = true;
  hostDrawings += 1;
}

/** Whether `o` lies in a host's own drawing. */
function inHostDrawing(o: THREE.Object3D): boolean {
  if (hostDrawings === 0) return false;
  for (let x: THREE.Object3D | null = o; x !== null; x = x.parent) if (x.userData[HOST_DRAWING_KEY] === true) return true;
  return false;
}

/** Mark `o` as an occludee of `kind` (block, architecture and terrain draws, which look like any mesh); level geometry draws first. */
export function markOccludee(o: THREE.Object3D, kind: OccludeeKind): void {
  o.userData[OCCLUDEE_KIND_KEY] = kind;
  const m = o as THREE.Mesh;
  if (m.isMesh === true && occluderRoleOfDraw(m, occludeeKindOf(m)) === 'early') m.renderOrder = OCCLUDER_EARLY_RENDER_ORDER;
}

const materialsOf = (m: THREE.Mesh): readonly THREE.Material[] => (Array.isArray(m.material) ? m.material : [m.material]);

/** Whether `m` draws copies of one geometry (three's instanced meshes, or instance attributes). */
export function isInstancedDraw(m: THREE.Mesh): boolean {
  return (m as THREE.InstancedMesh).isInstancedMesh === true || (m.geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry === true;
}

/** What `o` is as an occludee (null: never one). */
export function occludeeKindOf(o: THREE.Object3D): OccludeeKind | null {
  const m = o as THREE.Mesh;
  if (m.isMesh !== true || isOccluderStandin(m) || inHostDrawing(m)) return null;
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
  /** What it is among the occluders (`occluderRoleOf`). */
  readonly role: OccluderRole;
}

interface Entry extends Occludee {
  kind: OccludeeKind;
  role: OccluderRole;
  /** What it was classified with (a new material, geometry or occluder flag classifies it again). */
  material: THREE.Mesh['material'];
  geometry: THREE.BufferGeometry;
  optedOut: boolean;
  seen: number;
}

const _sphere = new THREE.Sphere();

/** The draws in the scene that occlusion culling may leave out of the view. */
export class OccludeeRegistry {
  private readonly entries = new Map<THREE.Object3D, Entry>();
  private stamp = 0;
  private readonly kinds: Record<OccludeeKind, number> = Object.fromEntries(OCCLUDEE_KINDS.map((k) => [k, 0])) as Record<OccludeeKind, number>;
  private readonly roles: Record<OccluderRole, number> = Object.fromEntries(OCCLUDER_ROLES.map((r) => [r, 0])) as Record<OccluderRole, number>;

  /** Follow the scene's drawables (`scene.children`): new ones classified, gone ones dropped; true when that changed anything. */
  sync(children: readonly THREE.Object3D[]): boolean {
    this.stamp += 1;
    let changed = false;
    let seen = 0;
    for (const o of children) {
      const known = this.entries.get(o);
      const m = o as THREE.Mesh;
      if (known !== undefined && known.material === m.material && known.geometry === m.geometry && known.optedOut === (m.userData[NOT_OCCLUDER_KEY] === true)) {
        known.seen = this.stamp;
        seen += 1;
        continue;
      }
      const kind = occludeeKindOf(o);
      if (known !== undefined) {
        this.kinds[known.kind] -= 1;
        this.roles[known.role] -= 1;
        this.entries.delete(o);
        changed = true;
      }
      if (kind === null) continue;
      const role = occluderRoleOfDraw(m, kind);
      this.entries.set(o, { object: m, kind, role, material: m.material, geometry: m.geometry, optedOut: m.userData[NOT_OCCLUDER_KEY] === true, seen: this.stamp });
      this.kinds[kind] += 1;
      this.roles[role] += 1;
      seen += 1;
      changed = true;
    }
    // Some left the scene: drop them.
    if (seen < this.entries.size) {
      for (const [o, e] of this.entries) {
        if (e.seen === this.stamp) continue;
        this.entries.delete(o);
        this.kinds[e.kind] -= 1;
        this.roles[e.role] -= 1;
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

  /** How many occludees there are of each occluder role. */
  roleCounts(): Readonly<Record<OccluderRole, number>> {
    return { ...this.roles };
  }

  clear(): void {
    this.entries.clear();
    for (const k of OCCLUDEE_KINDS) this.kinds[k] = 0;
    for (const r of OCCLUDER_ROLES) this.roles[r] = 0;
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
