/**
 * Plane locks scripts set and clear while the game runs
 * (`ctx.physics.setPlane`, `ctx.character.setPlane`): any object with a
 * collider or a player controller can be locked to an axis-aligned plane,
 * or freed, at any moment, mid-scene, with no reload.
 *
 * A request takes effect at the next step boundary, in the order the
 * scripts made them, so the page and the simulation worker apply the same
 * locks at the same step. Locking snaps the object onto the plane (its
 * coordinate along the normal set to the plane's, its rotation reduced to
 * the turn about the normal); freeing leaves it where it is.
 *
 * A plane a script set replaces the component's own until the run
 * restarts (then every object has its authored plane again) or the object
 * leaves the game.
 */
import { isPlaneLock, planeLockOf } from '@thirdlight/project-model';

import type { PhysicsPlane, PhysicsPort3D } from './ports';
import type { TransformState } from './types-simulation';

/** What the locks read of and ask of the runtime. */
export interface PlaneLockHost {
  readonly physics3d: PhysicsPort3D | undefined;
  /** Whether the object is a player controller (its character is locked). */
  isCharacter(id: string): boolean;
  /** Whether the object has a collider in the world (its body is locked). */
  hasBody(id: string): boolean;
  /** Lock a player controller's character (its body and object snap; see `PlayerControllers.setPlane`). */
  setCharacterPlane(id: string, plane: PhysicsPlane | null): void;
  /** A player controller's plane now (null: free). */
  characterPlane(id: string): PhysicsPlane | null;
  /** The object's components (its authored collider plane). */
  componentsOf(id: string): Readonly<Record<string, unknown>> | undefined;
  /** The live transforms. */
  curr(): ReadonlyMap<string, TransformState>;
  parentOf(id: string): string | null | undefined;
}

/** The twist of a rotation [x, y, z, w] about a world axis (the turn about the plane's normal), written in place. */
function twistInPlace(q: number[], axis: 'x' | 'z'): void {
  const k = axis === 'x' ? 0 : 2;
  const a = q[k]!;
  const len = Math.hypot(a, q[3]!);
  const s = q[3]! < 0 ? -1 : 1;
  q[0] = 0;
  q[1] = 0;
  q[2] = 0;
  if (!(len > 1e-12)) {
    q[3] = 1;
    return;
  }
  q[k] = (s * a) / len;
  q[3] = (s * q[3]!) / len;
}

export class PlaneLocks {
  /** Requests made this step, applied at the next boundary in order. */
  private readonly pending = new Map<string, PhysicsPlane | null>();
  /** Planes scripts set on bodies (null: freed), over their colliders' own. */
  private readonly set = new Map<string, PhysicsPlane | null>();
  /** Objects a script locked or freed since the run started (their authored plane comes back at a restart). */
  private readonly touched = new Set<string>();

  constructor(private readonly host: PlaneLockHost) {}

  /**
   * A script's request: `plane` is `{ axis: 'x' | 'z', origin }` or null.
   * False (nothing queued) without a 3D world, for a bad plane, or for an
   * object that has neither a collider nor a player controller now.
   */
  request(id: unknown, plane: unknown): boolean {
    if (this.host.physics3d === undefined || typeof id !== 'string') return false;
    if (plane !== null && !isPlaneLock(plane)) return false;
    if (!this.host.isCharacter(id) && !this.host.hasBody(id)) return false;
    // Re-inserted at the end: the last request for an object is the one that applies, in the order made.
    this.pending.delete(id);
    this.pending.set(id, plane === null ? null : Object.freeze({ axis: plane.axis, origin: plane.origin === 0 ? 0 : plane.origin }));
    return true;
  }

  /** The plane a script set on a body (null: freed), undefined when its collider's own applies. */
  scriptPlane(id: string): PhysicsPlane | null | undefined {
    return this.set.get(id);
  }

  /** The plane an object is locked to now (null: free). */
  planeOf(id: string): PhysicsPlane | null {
    if (this.host.isCharacter(id)) return this.host.characterPlane(id);
    const set = this.set.get(id);
    if (set !== undefined) return set;
    return this.host.hasBody(id) ? planeLockOf(this.host.componentsOf(id)?.['collider']) : null;
  }

  /** The step boundary: this step's requests take effect, in order. */
  applyAtBoundary(): void {
    if (this.pending.size === 0) return;
    const requests = [...this.pending];
    this.pending.clear();
    for (const [id, plane] of requests) {
      this.touched.add(id);
      if (this.host.isCharacter(id)) {
        this.host.setCharacterPlane(id, plane);
        continue;
      }
      if (!this.host.hasBody(id)) continue;
      this.set.set(id, plane);
      this.host.physics3d?.setBodyPlane?.(id, plane);
      if (plane !== null) this.snapObject(id, plane);
    }
  }

  /**
   * A run restart: every object a script locked or freed gets its authored
   * plane back (before the world is rebuilt from what it holds).
   */
  restart(): void {
    this.pending.clear();
    this.set.clear();
    for (const id of this.touched) {
      const authored = planeLockOf(this.host.componentsOf(id)?.[this.host.isCharacter(id) ? 'controller' : 'collider']);
      if (this.host.isCharacter(id)) this.host.setCharacterPlane(id, authored);
      else if (this.host.hasBody(id)) this.host.physics3d?.setBodyPlane?.(id, authored);
    }
    this.touched.clear();
  }

  /** Objects that left the game: a later object with the same id starts from its own components. */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      this.pending.delete(id);
      this.set.delete(id);
      this.touched.delete(id);
    }
  }

  /**
   * A locked object snaps with its body: a root object's own transform is
   * put on the plane. A child keeps its transform (its parent's motion
   * decides where it is); its body is on the plane all the same.
   */
  private snapObject(id: string, plane: PhysicsPlane): void {
    if (this.host.parentOf(id) !== null) return;
    const t = this.host.curr().get(id);
    if (t === undefined) return;
    (t.position as number[])[plane.axis === 'x' ? 0 : 2] = plane.origin;
    twistInPlace(t.rotation as number[], plane.axis);
  }
}
