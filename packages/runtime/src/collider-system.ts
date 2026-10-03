/**
 * The colliders of the running game: what each loaded object adds to the
 * physics world (shapes resolved, placed where the object is in the world)
 * and which of them follow a moving object.
 *
 * A collider is static where its object stays. It becomes a kinematic body,
 * posed every step from its object's world transform, once the object or one
 * of its parents is moved by something other than physics — a script that
 * owns its transform, a timeline's transform track, a mover (a mover's own
 * collider is the mover's; a collider on its child follows it here). This is
 * Unity's rule that a collider moves with its transform and a moving one
 * belongs on a kinematic body; Godot's AnimatableBody does the same. A mesh
 * collider has no inside and stays static (the port refuses moving meshes):
 * one log line says so.
 *
 * In 3D only: the 2D plane's colliders on children are placed at load and
 * stay (its scripts drive no collider).
 */
import type { ModelColliderTable } from '@thirdlight/project-model';

import { colliderSpecs2D, colliderSpecs3D, shapeAabb3, staticColliderOf, staticColliderOf3D, type ColliderContext } from './collider-specs';
import type { ColliderShape3D, PhysicsPort, PhysicsPort3D, StaticColliderSpec, StaticColliderSpec3D } from './ports';
import type { TransformState } from './types-simulation';
import { worldTransformOf } from './world-transform';

/** Parent chains deeper than this are not followed (a cycle cannot hang a step). */
const MAX_CHAIN = 64;

/** What the collider system reads from the runtime. */
export interface ColliderSystemHost {
  readonly physics?: PhysicsPort;
  readonly physics3d?: PhysicsPort3D;
  /** The step's transforms (the runtime replaces the map on a restore). */
  curr(): ReadonlyMap<string, TransformState>;
  parentOf(id: string): string | null | undefined;
  inactive(): ReadonlySet<string>;
  /** Every entity a module (a script) owns the transform of. */
  ownedIds(): Iterable<string>;
  /** An entity's components (its document), for one that came back. */
  componentsOf(id: string): Readonly<Record<string, unknown>> | undefined;
  /** One warning line in the game's log. */
  warn(message: string): void;
}

/** Where a moving collider is now (world), and the box around it (relative to that point). */
export interface MovingColliderPose {
  entityId: string;
  position: [number, number, number];
  rotation: readonly number[];
  aabb: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** Why a collider batch did not go in. */
export type ColliderAddResult = { ok: true } | { ok: false; refused: string } | { ok: false; failed: string };

/** A collider spec's resolved shape (what its box is measured on). */
type Shaped = { shape: unknown };

export class ColliderSystem {
  /** The collider-bearing objects of a 3D world (no controller): their components. */
  private readonly components = new Map<string, Readonly<Record<string, unknown>>>();
  /** Objects with a mover (their children's colliders follow them). */
  private readonly movers = new Set<string>();
  /** Colliders posed every step from their world transform, and the shape each was built with. */
  private readonly moving = new Map<string, ColliderShape3D>();
  /** Objects a timeline moved. */
  private readonly timelineMoved = new Set<string>();
  /** Mesh colliders already reported as unable to follow. */
  private readonly meshWarned = new Set<string>();
  /** The moving set must be brought up to date before the next step. */
  private dirty = true;
  readonly ctx: ColliderContext;

  constructor(private readonly host: ColliderSystemHost, modelColliders?: ModelColliderTable) {
    this.ctx = {
      ...(modelColliders !== undefined ? { modelColliders } : {}),
      outside: { transform: (id) => host.curr().get(id), parentOf: (id) => host.parentOf(id) },
    };
  }

  /**
   * Whether a script may own this object's transform although it has a
   * collider (3D): neither the controller's (the character is the
   * controller's) nor a mover's (which moves it itself).
   */
  static drivable(components: unknown): boolean {
    if (typeof components !== 'object' || components === null) return false;
    const c = components as Record<string, unknown>;
    return c['collider'] !== undefined && c['controller'] === undefined && c['mover'] === undefined;
  }

  /** Whether an attached object is a 3D collider a script may drive. */
  drivableId(id: string): boolean {
    return ColliderSystem.drivable(this.components.get(id));
  }

  /** The 2D static colliders of entities about to be attached, each where it is in the world. */
  specs2D(entities: readonly { id: string; parentId?: string | null; components?: unknown }[]): StaticColliderSpec[] {
    return colliderSpecs2D(entities, this.ctx);
  }

  /** Add the colliders of entities about to be attached (a scene, a spawned copy) to whichever world there is. */
  add(entities: readonly { id: string; parentId?: string | null; components?: unknown }[], what: string): ColliderAddResult {
    const port3 = this.host.physics3d;
    const port2 = this.host.physics;
    const specs: (StaticColliderSpec | StaticColliderSpec3D)[] = port3 !== undefined ? colliderSpecs3D(entities, this.ctx) : port2 !== undefined ? this.specs2D(entities) : [];
    if (specs.length === 0) return { ok: true };
    const port = (port3 ?? port2) as { addStaticColliders?: (s: never[]) => void };
    if (typeof port.addStaticColliders !== 'function') return { ok: false, refused: 'the physics port cannot add colliders' };
    try {
      port.addStaticColliders(specs as never[]);
    } catch (e) {
      return { ok: false, failed: `adding the colliders of ${what} failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  }

  /** Attached objects: their colliders and movers are known from now on. */
  track(entities: readonly { id: string; components?: unknown }[]): void {
    if (this.host.physics3d === undefined) return;
    for (const e of entities) {
      const c = (e.components ?? {}) as Readonly<Record<string, unknown>>;
      if (c['collider'] !== undefined && c['controller'] === undefined) this.components.set(e.id, c);
      if (c['mover'] !== undefined) this.movers.add(e.id);
    }
    this.dirty = true;
  }

  /** Detached objects (their bodies are removed with them). */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      this.components.delete(id);
      this.movers.delete(id);
      this.moving.delete(id);
      this.timelineMoved.delete(id);
    }
  }

  /** A module's owners changed, or objects came back: check which colliders move at the next boundary. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Whether the moving set must be brought up to date before the next step. */
  get needsSync(): boolean {
    return this.dirty;
  }

  /** A timeline wrote an object's transform (its colliders, and its children's, follow it from the next step). */
  timelineMove(id: string): void {
    if (this.host.physics3d === undefined || this.timelineMoved.has(id)) return;
    this.timelineMoved.add(id);
    this.dirty = true;
  }

  /** Whether `id` or a parent of it is moved by a script, a timeline or a mover (`self`: its own mover counts). */
  private followsMovement(id: string, owned: ReadonlySet<string>): boolean {
    let at: string | null | undefined = id;
    for (let depth = 0; at !== null && at !== undefined && depth < MAX_CHAIN; depth += 1) {
      if (owned.has(at) || this.timelineMoved.has(at) || (at !== id && this.movers.has(at))) return true;
      at = this.host.parentOf(at);
    }
    return false;
  }

  /**
   * Bring the moving colliders up to date (at a step boundary): a collider
   * whose object (or a parent) is now moved and that is still a fixed body
   * is re-added as a kinematic one where it is. Returns an error message for
   * the runtime's fail-stop, or null.
   */
  sync(): string | null {
    this.dirty = false;
    const port = this.host.physics3d;
    if (port === undefined) return null;
    const owned = new Set(this.host.ownedIds());
    const off = this.host.inactive();
    const add: StaticColliderSpec3D[] = [];
    for (const id of [...this.components.keys()].sort()) {
      if (this.moving.has(id) || off.has(id)) continue;
      const comps = this.components.get(id)!;
      if (comps['mover'] !== undefined || !this.followsMovement(id, owned)) continue;
      const spec = staticColliderOf3D(id, comps, true, worldTransformOf(id, this.host.curr(), (x) => this.host.parentOf(x)), this.ctx);
      if (spec === null) continue;
      const shape = spec.shape as ColliderShape3D;
      if (shape.type === 'mesh' || (shape.type === 'compound' && shape.parts.some((p) => p.shape.type === 'mesh'))) {
        if (!this.meshWarned.has(id)) {
          this.meshWarned.add(id);
          this.host.warn(`the mesh collider of "${id}" stays where it was: a mesh collider is static level geometry (a moving one uses box, sphere, capsule or convex)`);
        }
        continue;
      }
      add.push(spec);
    }
    if (add.length === 0) return null;
    if (typeof port.addStaticColliders !== 'function' || typeof port.removeStaticColliders !== 'function' || typeof port.setKinematicPoses !== 'function') return 'the 3D physics port cannot pose moving colliders';
    try {
      port.removeStaticColliders(add.map((sp) => sp.entityId));
      port.addStaticColliders(add);
    } catch (e) {
      return `making the moving colliders kinematic failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    for (const sp of add) this.moving.set(sp.entityId, (sp as Shaped).shape as ColliderShape3D);
    return null;
  }

  /** Where the moving colliders are now (their committed world transforms), in id order, with the box each pushes the player out of. */
  poses(): MovingColliderPose[] {
    if (this.moving.size === 0) return [];
    const curr = this.host.curr();
    const out: MovingColliderPose[] = [];
    for (const id of [...this.moving.keys()].sort()) {
      const w = worldTransformOf(id, curr, (x) => this.host.parentOf(x));
      if (w === undefined) continue;
      out.push({ entityId: id, position: [w.position[0], w.position[1], w.position[2]], rotation: w.rotation, aabb: shapeAabb3(this.moving.get(id)!, w.rotation) });
    }
    return out;
  }

  /**
   * Objects were switched off or on (with their children): their colliders
   * leave the world, or come back where they are now (a moving one becomes
   * kinematic again at the next boundary). Returns an error message, or null.
   */
  activeChanged(leaving: readonly string[], coming: readonly string[]): string | null {
    try {
      if (leaving.length > 0) {
        this.host.physics3d?.removeStaticColliders?.(leaving);
        this.host.physics?.removeStaticColliders?.(leaving);
        for (const id of leaving) this.moving.delete(id);
      }
      if (coming.length === 0) return null;
      const curr = this.host.curr();
      const worldOf = (id: string): ReturnType<typeof worldTransformOf> => worldTransformOf(id, curr, (x) => this.host.parentOf(x));
      if (this.host.physics3d !== undefined) {
        const specs = coming.map((id) => staticColliderOf3D(id, this.host.componentsOf(id) ?? {}, false, worldOf(id), this.ctx)).filter((x): x is StaticColliderSpec3D => x !== null);
        if (specs.length > 0) this.host.physics3d.addStaticColliders?.(specs);
        this.dirty = true;
      } else if (this.host.physics !== undefined) {
        const specs = coming.map((id) => staticColliderOf(id, this.host.componentsOf(id) ?? {}, worldOf(id), this.ctx)).filter((x): x is StaticColliderSpec => x !== null);
        if (specs.length > 0) this.host.physics.addStaticColliders?.(specs);
      }
    } catch (e) {
      return `switching the colliders of ${[...leaving, ...coming].slice(0, 4).join(', ')} failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
  }

  /** Whether an object has a 3D collider the system knows. */
  has(id: string): boolean {
    return this.components.has(id);
  }
}
