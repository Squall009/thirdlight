/**
 * Meshes hidden from the view while the shadow cameras still draw them: a
 * cut-away's roof (its shadow stays on the room, as the probes baked with it
 * say) and a room no portal shows (its walls and props still shade a room
 * that is seen). Hidden = off the view camera's layer 0, on
 * {@link OFF_VIEW_LAYER}, which the shadow cameras see.
 *
 * An edit mode's isolation hides the other objects from the shadow cameras
 * too (on no layer at all): what is edited is seen alone, without the
 * shadows of objects that are not drawn.
 *
 * Several reasons may hide one mesh (a cut roof in a room out of sight): it
 * comes back into view only when none is left, and into the shadows when no
 * reason that hides it from them is left.
 */
import type * as THREE from 'three';

/** The three.js layer a mesh hidden from the view is drawn on: the shadow cameras see it, the view's camera does not. */
export const OFF_VIEW_LAYER = 31;

/** Why a mesh is hidden (bits). */
export const HIDDEN_BY_CUTAWAY = 1;
export const HIDDEN_BY_ROOM = 2;
/** Another object than the one an editor's edit mode isolates (isolation-view.ts): hidden from the shadows too. */
export const HIDDEN_BY_ISOLATION = 4;
/** Hidden behind what is drawn in front of it (occlusion queries' answers, the occlusion oracle's ideal culling). */
export const HIDDEN_BY_OCCLUSION = 8;

/**
 * The reasons decided before occlusion culling runs, each frame: a cut-away,
 * the rooms' portals, an edit mode's isolation. They are exact and cheap, so
 * what they hide is never tested against the depth or asked a query.
 */
export const HIDDEN_BEFORE_OCCLUSION = HIDDEN_BY_CUTAWAY | HIDDEN_BY_ROOM | HIDDEN_BY_ISOLATION;

/** The reasons that hide a mesh from the shadow cameras as well. */
const HIDDEN_FROM_SHADOWS = HIDDEN_BY_ISOLATION;

/** `object.userData[HIDDEN_BY_KEY]`: the reasons a mesh is hidden from the view (bits; absent: none). */
const HIDDEN_BY_KEY = '__tlHiddenBy';

/** Hide `o` from the view for `reason` (or stop hiding it for that reason); true when that changed whether it is drawn (in the view or the shadows). */
export function hideFromView(o: THREE.Object3D, reason: number, hidden: boolean): boolean {
  const was = (o.userData[HIDDEN_BY_KEY] as number | undefined) ?? 0;
  const now = hidden ? was | reason : was & ~reason;
  if (now === was) return false;
  if (now === 0) delete o.userData[HIDDEN_BY_KEY];
  else o.userData[HIDDEN_BY_KEY] = now;
  const shadowsWere = (was & HIDDEN_FROM_SHADOWS) === 0;
  const shadowsNow = (now & HIDDEN_FROM_SHADOWS) === 0;
  if ((was === 0) === (now === 0) && shadowsWere === shadowsNow) return false;
  if (now === 0) o.layers.enable(0);
  else o.layers.disable(0);
  if (now !== 0 && shadowsNow) o.layers.enable(OFF_VIEW_LAYER);
  else o.layers.disable(OFF_VIEW_LAYER);
  return true;
}

/** Whether `o` is hidden from the view for `reason`. */
export function hiddenFromView(o: THREE.Object3D, reason: number): boolean {
  return (((o.userData[HIDDEN_BY_KEY] as number | undefined) ?? 0) & reason) !== 0;
}

/** `object.userData[OCCLUSION_KEPT_KEY]`: never culled by occlusion now (an editor's selection, the object an edit mode edits). */
const OCCLUSION_KEPT_KEY = '__tlOcclusionKept';

/** Draws kept now, on the page: none (Play, an export) costs the tests no read. */
let keptDraws = 0;

/** Keep `o` from occlusion culling (or let it be tested again); true when that changed. */
export function keepFromOcclusion(o: THREE.Object3D, kept: boolean): boolean {
  if ((o.userData[OCCLUSION_KEPT_KEY] === true) === kept) return false;
  if (kept) o.userData[OCCLUSION_KEPT_KEY] = true;
  else delete o.userData[OCCLUSION_KEPT_KEY];
  keptDraws += kept ? 1 : -1;
  return true;
}

/** Whether `o` is kept from occlusion culling. */
export function keptFromOcclusion(o: THREE.Object3D): boolean {
  return keptDraws > 0 && o.userData[OCCLUSION_KEPT_KEY] === true;
}

/**
 * Whether occlusion culling may test `o` for `camera`: drawn, kept by no
 * host, hidden by no reason decided before it, and on the camera's layers,
 * or off them only because occlusion itself hid it (a hidden draw is asked
 * again, so it shows at the first answer that sees it). A draw it may not
 * test is drawn whole by every path.
 */
export function occlusionMayTest(o: THREE.Object3D, camera: THREE.Camera): boolean {
  if (!o.visible || keptFromOcclusion(o) || hiddenFromView(o, HIDDEN_BEFORE_OCCLUSION)) return false;
  return hiddenFromView(o, HIDDEN_BY_OCCLUSION) || camera.layers.test(o.layers);
}
