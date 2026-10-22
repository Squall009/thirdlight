/**
 * Where things are in the Scene view: an entity's world matrix and frame,
 * its subtree, the meshes it draws and their bounds, what a ray from the
 * view or from a world point hits, which entity a click picks, where a drop
 * lands, and the model data "Fit to model" and "collider from model outline"
 * read. All of it reads the adapter's drawn world (synced first where a
 * stale world would answer wrong).
 *
 * Browser-only (three.js, the scene adapter).
 */
import { BATCHED_LAYER, drawOwner, type SceneAdapter } from '@thirdlight/three-adapter';
import * as THREE from 'three';
import type { ProjectedEntity } from '../session/projection';
import type { EffectiveEntityFlags } from '../session/hierarchy';
import { getSnapSettings } from '../session/snapping';
import type { HelperOverlay } from './helper-overlay';
import { OVERLAY_KEY } from './entity-overlays';
import type { ViewIsolationState } from './view-isolation';

/**
 * An object outside the scene whose world matrix is set by hand: the parent
 * frame of the gizmo's and the copy gizmo's stand-ins, and an entity's frame
 * for the handles and the bake.
 */
export function frameObject(): THREE.Object3D {
  const o = new THREE.Object3D();
  o.matrixAutoUpdate = false;
  o.matrixWorldAutoUpdate = false;
  return o;
}

export type CellTopSnap = (entityId: string | null, position: readonly number[], rotation: readonly number[]) => [number, number, number] | null;

export interface SceneQueriesHost {
  readonly adapter: () => SceneAdapter;
  readonly root: () => HTMLElement;
  readonly camera: THREE.PerspectiveCamera;
  /** The view's own drawing (never hit). */
  readonly overlay: THREE.Object3D;
  readonly synced: ReadonlyMap<string, ProjectedEntity>;
  readonly projected: () => readonly ProjectedEntity[];
  readonly flags: () => ReadonlyMap<string, EffectiveEntityFlags>;
  readonly isolation: ViewIsolationState;
  readonly helpers: HelperOverlay;
  /** Where the camera looks (a drop that hits nothing lands there). */
  readonly focus: () => THREE.Vector3;
  readonly snapping: () => boolean;
  readonly cellTopSnap: () => CellTopSnap | null;
}

export class SceneQueries {
  readonly raycaster = new THREE.Raycaster();

  constructor(private readonly host: SceneQueriesHost) {
    this.raycaster.layers.enable(BATCHED_LAYER);
  }

  /** An entity's world matrix (composed by the adapter), or null when it is not drawn here. */
  worldOf(id: string): THREE.Matrix4 | null {
    const m = new THREE.Matrix4();
    return this.host.adapter().worldMatrix?.(id, m) === true ? m : null;
  }

  /** An object standing at an entity's world matrix (handles and the bake read frames from it). */
  frameOf(id: string): THREE.Object3D | null {
    const m = this.worldOf(id);
    if (m === null) return null;
    const o = frameObject();
    o.matrix.copy(m);
    o.matrixWorld.copy(m);
    return o;
  }

  /** An entity and the ones below it (bounds and outlines of a model built from parts). */
  subtreeIds(rootId: string): string[] {
    const kids = new Map<string, string[]>();
    for (const e of this.host.projected()) {
      if (e.parentId === null) continue;
      let list = kids.get(e.parentId);
      if (list === undefined) kids.set(e.parentId, (list = []));
      list.push(e.id);
    }
    const out: string[] = [];
    const walk = (id: string, depth: number): void => {
      out.push(id);
      if (depth < 64) for (const c of kids.get(id) ?? []) walk(c, depth + 1);
    };
    walk(rootId, 0);
    return out;
  }

  /**
   * Every mesh an entity draws itself (not its overlays, not its children's), with current world matrices. `paths`:
   * with what it generates outside its node too (a building's or a spline's chunks carry its id, not its node).
   */
  drawnMeshes(id: string, paths = false): THREE.Mesh[] {
    const adapter = this.host.adapter();
    const node = adapter.entityObject?.(id) ?? null;
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if (o.userData[OVERLAY_KEY] === true) return;
      if ((o as THREE.Mesh).isMesh === true) out.push(o as THREE.Mesh);
      for (const c of o.children) visit(c);
    };
    if (node !== null) visit(node);
    if (paths) for (const o of adapter.pickables?.() ?? []) if (o !== node && o !== this.host.overlay && adapter.paintOwnerOf?.(o) === id) visit(o);
    return out;
  }

  boundsOf(ids: readonly string[], include: (e: ProjectedEntity | undefined) => boolean): THREE.Box3 {
    const box = new THREE.Box3();
    const one = new THREE.Box3();
    for (const id of ids) {
      if (!include(this.host.synced.get(id))) continue;
      for (const mesh of this.drawnMeshes(id, true)) {
        if (mesh.userData['tlBatch'] === true) continue;
        mesh.updateWorldMatrix(true, false);
        one.makeEmpty().expandByObject(mesh, false);
        box.union(one);
      }
    }
    return box;
  }

  /** The models drawn for an entity (its own and its children's), relative to its world position (null: none loaded). */
  modelBounds(entityId: string): { min: number[]; max: number[] } | null {
    this.host.adapter().sync?.();
    const world = this.worldOf(entityId);
    if (world === null) return null;
    const box = this.boundsOf(this.subtreeIds(entityId), (e) => e?.kind === 'model');
    if (box.isEmpty()) return null;
    const at = new THREE.Vector3().setFromMatrixPosition(world);
    return { min: [box.min.x - at.x, box.min.y - at.y, box.min.z - at.z], max: [box.max.x - at.x, box.max.y - at.y, box.max.z - at.z] };
  }

  /**
   * The vertices of the models drawn for an entity (its own and its
   * children's), on the play plane relative to its origin with its rotation
   * about Z undone (the collider's frame), or null when no model is loaded.
   */
  modelOutline(entityId: string): { x: number; y: number }[] | null {
    this.host.adapter().sync?.();
    const world = this.worldOf(entityId);
    if (world === null) return null;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    world.decompose(pos, quat, new THREE.Vector3());
    const angle = new THREE.Euler().setFromQuaternion(quat, 'ZYX').z;
    const toFrame = new THREE.Matrix4().makeRotationZ(angle).setPosition(pos).invert();
    const out: { x: number; y: number }[] = [];
    const v = new THREE.Vector3();
    for (const id of this.subtreeIds(entityId)) {
      if (this.host.synced.get(id)?.kind !== 'model') continue;
      for (const mesh of this.drawnMeshes(id)) {
        const attr = mesh.geometry.getAttribute('position');
        if (attr === undefined) continue;
        mesh.updateWorldMatrix(true, false);
        const m = new THREE.Matrix4().multiplyMatrices(toFrame, mesh.matrixWorld);
        // At most ~50k points per mesh (the hull only needs the extremes).
        const stride = Math.max(1, Math.ceil(attr.count / 50_000));
        for (let i = 0; i < attr.count; i += stride) {
          v.fromBufferAttribute(attr, i).applyMatrix4(m);
          out.push({ x: v.x, y: v.y });
        }
      }
    }
    return out.length === 0 ? null : out;
  }

  /** The drawn objects that collide (shown and switched on; instance sets and `exceptId` left out): what the brush paints on besides block layers. */
  colliderObjects(exceptId: string): THREE.Object3D[] {
    const adapter = this.host.adapter();
    adapter.sync?.();
    const flags = this.host.flags();
    const out: THREE.Object3D[] = [];
    for (const e of this.host.projected()) {
      if (e.collider === undefined || e.instances !== undefined || e.id === exceptId || flags.get(e.id)?.active === false) continue;
      const node = adapter.entityObject?.(e.id) ?? null;
      if (node !== null) out.push(node);
    }
    return out;
  }

  /** The raycaster aimed from the camera through a pointer position. */
  aim(clientX: number, clientY: number): void {
    const rect = this.host.root().getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.host.camera);
  }

  /** What a ray from the view hits among the drawn objects and the entities' overlays (nearest first); `all`: what an edit mode cannot pick too (a decal is placed on any surface). */
  castScene(clientX: number, clientY: number, all = false): THREE.Intersection[] {
    this.aim(clientX, clientY);
    const hits = this.castTargets();
    if (all) return hits;
    // In an edit mode only the edited objects are hit (the rest, shown as context or not, is never picked or painted).
    const adapter = this.host.adapter();
    const entityOf = (o: THREE.Object3D): string | null => adapter.entityOf?.(o) ?? null;
    return this.host.isolation.hits(hits, (o) => drawOwner(o, entityOf));
  }

  /** What a ray from a world point hits within `far` metres among the drawn objects (nearest first; a decal scatter's drop). */
  castRay(origin: readonly number[], dir: readonly number[], far: number): THREE.Intersection[] {
    this.raycaster.set(new THREE.Vector3(origin[0], origin[1], origin[2]), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
    this.raycaster.far = far;
    const hits = this.castTargets();
    this.raycaster.far = Infinity;
    return hits;
  }

  /** The raycaster's hits among the drawables (those drawn through batches too; the batches' own meshes stand for objects picked themselves) — not the view's overlay group. */
  private castTargets(): THREE.Intersection[] {
    const adapter = this.host.adapter();
    adapter.sync?.();
    const scene = adapter.threeScene?.();
    if (scene === undefined) return [];
    const targets = (adapter.pickables?.() ?? scene.children).filter((o) => o !== this.host.overlay && o.userData['tlBatch'] !== true);
    return this.raycaster.intersectObjects(targets, true).filter((h) => h.object.visible);
  }

  /**
   * Where something dropped at a pointer position lands: the first visible
   * surface under the pointer, else the ground plane (y = 0), else the focus
   * point. Snapped to the translate step when snapping is on.
   */
  dropPoint(clientX: number, clientY: number): [number, number, number] {
    let point: THREE.Vector3 | null = null;
    for (const h of this.castScene(clientX, clientY)) {
      if ((h.object as THREE.Mesh).isMesh === true) {
        point = h.point.clone();
        break;
      }
    }
    if (point === null) point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    const p = point ?? this.host.focus().clone();
    const step = this.host.snapping() ? getSnapSettings().translateM : 0.001;
    const snap = (v: number): number => {
      const r = Math.round(v / step) * step;
      return Math.abs(r) < 1e-9 ? 0 : Number(r.toFixed(3));
    };
    const snapped: [number, number, number] = [snap(p.x), snap(p.y), snap(p.z)];
    // Onto the cell top under the drop point.
    return this.host.cellTopSnap()?.(null, snapped, [0, 0, 0, 1]) ?? snapped;
  }

  /** Pick the entity under a pointer position (client coords in the canvas). */
  pick(clientX: number, clientY: number): string | null {
    // The player's capsule outline selects the player (before
    // whatever model is drawn over it); inside the outline it does when
    // nothing else is hit.
    const flags = this.host.flags();
    const capsule = this.host.helpers.capsuleAt(clientX, clientY);
    const capsuleId = capsule !== null && (flags.get(capsule.entityId) === undefined || (flags.get(capsule.entityId)!.active && !flags.get(capsule.entityId)!.locked)) ? capsule.entityId : null;
    if (capsuleId !== null && capsule!.onOutline) return capsuleId;
    const hit = this.pickMesh(clientX, clientY);
    return hit ?? capsuleId;
  }

  private pickMesh(clientX: number, clientY: number): string | null {
    const adapter = this.host.adapter();
    const flags = this.host.flags();
    for (const h of this.castScene(clientX, clientY)) {
      // The drawable's entity (its logical parents up to the entity's node in the adapter).
      const id = adapter.entityOf?.(h.object) ?? null;
      if (id === null || !this.host.synced.has(id)) continue;
      // Hidden or locked entities are not pickable (try the next hit).
      const f = flags.get(id);
      if (f === undefined || (f.active && !f.locked)) return id;
    }
    return null;
  }
}
