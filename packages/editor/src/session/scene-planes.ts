/**
 * The plane an object's body is held to in the editor's view of its scene:
 * its collider's or controller's own `plane`, else its scene's default
 * plane. Objects without a body (scenery, lights, markers) are free: the game
 * does not hold them to a plane, so neither does the gizmo.
 */
import { effectivePlaneOf, type PlaneAxis, type PlaneLock } from '@thirdlight/project-model/plane-lock';

/** The body's plane (null: free, or no body). */
export function bodyPlaneOf(components: Readonly<Record<string, unknown>>, scenePlane: PlaneLock | null | undefined): PlaneLock | null {
  const body = components['controller'] ?? components['collider'];
  return body === undefined ? null : effectivePlaneOf(body, scenePlane);
}

/** The axis of the plane the gizmo keeps an object on (null: free). */
export function gizmoPlaneAxis(e: { components: Readonly<Record<string, unknown>>; sceneId?: string } | undefined, planes: ReadonlyMap<string, PlaneLock>): PlaneAxis | null {
  if (e === undefined) return null;
  return bodyPlaneOf(e.components, e.sceneId !== undefined ? planes.get(e.sceneId) : null)?.axis ?? null;
}
