/**
 * Meshes hidden from the view while the shadow cameras still draw them: a
 * cut-away's roof (its shadow stays on the room, as the probes baked with it
 * say) and a room no portal shows (its walls and props still shade a room
 * that is seen). Hidden = off the view camera's layer 0, on
 * {@link OFF_VIEW_LAYER}, which the shadow cameras see.
 *
 * Several reasons may hide one mesh (a cut roof in a room out of sight): it
 * comes back into view only when none is left.
 */
import type * as THREE from 'three';

/** The three.js layer a mesh hidden from the view is drawn on: the shadow cameras see it, the view's camera does not. */
export const OFF_VIEW_LAYER = 31;

/** Why a mesh is hidden (bits). */
export const HIDDEN_BY_CUTAWAY = 1;
export const HIDDEN_BY_ROOM = 2;

/** `object.userData[HIDDEN_BY_KEY]`: the reasons a mesh is hidden from the view (bits; absent: none). */
const HIDDEN_BY_KEY = '__tlHiddenBy';

/** Hide `o` from the view for `reason` (or stop hiding it for that reason); true when that changed whether it is drawn. */
export function hideFromView(o: THREE.Object3D, reason: number, hidden: boolean): boolean {
  const was = (o.userData[HIDDEN_BY_KEY] as number | undefined) ?? 0;
  const now = hidden ? was | reason : was & ~reason;
  if (now === was) return false;
  if (now === 0) delete o.userData[HIDDEN_BY_KEY];
  else o.userData[HIDDEN_BY_KEY] = now;
  if ((was === 0) === (now === 0)) return false;
  if (now === 0) {
    o.layers.enable(0);
    o.layers.disable(OFF_VIEW_LAYER);
  } else {
    o.layers.disable(0);
    o.layers.enable(OFF_VIEW_LAYER);
  }
  return true;
}

/** Whether `o` is hidden from the view for `reason`. */
export function hiddenFromView(o: THREE.Object3D, reason: number): boolean {
  return (((o.userData[HIDDEN_BY_KEY] as number | undefined) ?? 0) & reason) !== 0;
}
