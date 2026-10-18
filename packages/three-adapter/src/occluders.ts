/**
 * Occluders in the adapter: what hides the occludees from the view.
 *
 * Occlusion culling tests draws against the depth the view's opaque draws
 * leave: a depth pyramid built from it on WebGPU, occlusion queries drawn
 * against it on WebGL 2. What fills that depth, and in which order, is set
 * here; which draw counts is the runtime's `occluderRoleOf`:
 *
 * - **Level geometry** (terrain pages, block chunks, generated architecture,
 *   merged static cells) draws first ({@link OCCLUDER_EARLY_RENDER_ORDER},
 *   the merged cells' order), so the big hiders fill the depth before the
 *   detail behind them is shaded.
 * - **`_OCC` stand-ins** (a model's `<piece>_OCC` nodes) draw into the
 *   view's depth only: never in colour, never into a shadow map, a probe or
 *   any camera but the view's, and only while a culling path is on. They
 *   draw after every opaque surface ({@link OCCLUDER_STANDIN_RENDER_ORDER}),
 *   so this frame's colour is what it is without them: through a cut-out
 *   hedge's gaps the house behind still shows, and the depth the test reads
 *   is the hedge's solid stand-in. A stand-in with a vertex outside its
 *   piece's LOD0 bounds is dropped when the model is made (project-model's
 *   rule; the backend reports it), so it never hides what is seen beside
 *   the model.
 * - **Opting out**: an object's `occluder: false` and a model's `occluder`
 *   import setting (`occ`, `none`, or `auto` with stand-ins) mark the
 *   surfaces that must not count; transparent, alpha-tested and
 *   double-sided materials never count. The marks are what the culling
 *   paths read (`occluderRoleOfDraw`).
 */
import * as THREE from 'three';
import { MODEL_OCC_RE, modelOccluderUse, occluderPointsOutside, occluderRoleOf, type ModelOccluderMode, type OccludeeKind, type OccluderRole } from '@thirdlight/runtime';

import { pieceBaseName, pieceBounds } from './pieces';
import { HIDDEN_BEFORE_OCCLUSION, hiddenFromView } from './view-hidden';

/** `mesh.userData[OCCLUDER_STANDIN_KEY]`: the mesh is a model's `_OCC` stand-in (depth only, the view only). */
export const OCCLUDER_STANDIN_KEY = '__tlOccluderStandin';
/** `mesh.userData[NOT_OCCLUDER_KEY]`: its object's `occluder` is false (a stand-in of it is not drawn either). */
export const NOT_OCCLUDER_KEY = '__tlNotOccluder';
/** `mesh.userData[SURFACES_STAND_DOWN_KEY]`: its model's stand-ins (or its import setting) speak for its surfaces. */
export const SURFACES_STAND_DOWN_KEY = '__tlSurfacesStandDown';

/** Level geometry draws first, with the merged static cells (`static-merge.ts`), before every other opaque draw. */
export const OCCLUDER_EARLY_RENDER_ORDER = -1;
/**
 * Stand-ins draw after every opaque surface (the editor's overlays sit
 * below 100), before whatever a culling path draws to test against them.
 */
export const OCCLUDER_STANDIN_RENDER_ORDER = 1_000_000;

/**
 * `scene.userData[STANDIN_VIEW_KEY]`: `(camera, standin) => boolean`,
 * whether `standin` draws for `camera` (the view's, while a culling path is
 * on). Set by the occlusion culler; absent: stand-ins draw for no camera.
 */
export const STANDIN_VIEW_KEY = 'tlOccluderView';

/**
 * The material stand-ins draw with into the view's depth: depth written, no
 * colour (an instance's clone keeps both). The depth pyramid path gives them
 * its own while it runs (occlusion-pyramid.ts: the pyramid only, not the
 * scene's depth) and this one back after.
 */
let standinMaterial: THREE.MeshBasicMaterial | null = null;
export function standinMaterialOf(): THREE.MeshBasicMaterial {
  if (standinMaterial === null) {
    standinMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
    standinMaterial.name = 'tl-occluder-standin';
  }
  return standinMaterial;
}

/**
 * A stand-in's own surfaces: its piece's meshes (the whole file's when it
 * names no drawn piece). Kept beside the meshes, not in `userData`, which a
 * clone copies as JSON.
 */
const standinSurfaces = new WeakMap<THREE.Object3D, readonly THREE.Mesh[]>();

/**
 * Whether a stand-in may fill the view's depth now: it follows what it
 * stands in for. When every surface of its piece that is drawn on its own
 * (`drawn`: in the scene now, not a level of detail left unattached nor
 * parked in a batch or a merged cell) is hidden by a reason decided before
 * occlusion (a cut-away, the rooms, isolation), the stand-in is not drawn
 * either: the depth must never hold a model the view does not draw. With
 * none drawn on its own it follows its own hiding only (a batch is in its
 * members' room, as the stand-in is).
 */
export function standinFollowsSurfaces(standin: THREE.Object3D, drawn: (surface: THREE.Object3D) => boolean): boolean {
  if (hiddenFromView(standin, HIDDEN_BEFORE_OCCLUSION)) return false;
  const surfaces = standinSurfaces.get(standin);
  if (surfaces === undefined) return true;
  let alone = 0;
  for (const s of surfaces) {
    if (!drawn(s)) continue;
    alone += 1;
    if (!hiddenFromView(s, HIDDEN_BEFORE_OCCLUSION)) return true;
  }
  return alone === 0;
}

/** Whether `o` is a model's `_OCC` stand-in. */
export function isOccluderStandin(o: THREE.Object3D): boolean {
  return o.userData[OCCLUDER_STANDIN_KEY] === true;
}

/**
 * The stand-in's own per-camera choice, as the view's culled draws make
 * theirs (`view-cull.ts`): the whole mesh for the view while a path is on,
 * nothing for any other camera (shadow maps, probes, a bake).
 */
function standinBeforeRender(this: THREE.Mesh, _r: unknown, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry): void {
  const view = scene.userData[STANDIN_VIEW_KEY] as ((c: THREE.Camera, standin: THREE.Mesh) => boolean) | undefined;
  const draw = this.userData[NOT_OCCLUDER_KEY] !== true && view !== undefined && view(camera, this);
  geometry.drawRange.count = draw ? Number.POSITIVE_INFINITY : 0;
}

/** Make `mesh` a stand-in: depth only, no shadows, after the opaque surfaces, never picked. */
function makeStandin(mesh: THREE.Mesh): void {
  mesh.material = standinMaterialOf();
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = OCCLUDER_STANDIN_RENDER_ORDER;
  mesh.userData[OCCLUDER_STANDIN_KEY] = true;
  mesh.onBeforeRender = standinBeforeRender as THREE.Object3D['onBeforeRender'];
  mesh.raycast = () => undefined;
  // Drawn by no camera until the culler says the view draws it.
  mesh.geometry.drawRange.count = 0;
}

/** The piece an `_OCC` node stands in for: its top-level node's base name. */
function pieceOf(root: THREE.Object3D, o: THREE.Object3D): string {
  let top = o;
  while (top.parent !== null && top.parent !== root) top = top.parent;
  return pieceBaseName(top.name);
}

/** Every mesh position under `node` in `root`'s space (xyz, flat). */
function pointsUnder(root: THREE.Object3D, node: THREE.Object3D): number[] {
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const out: number[] = [];
  node.traverse((o) => {
    const pos = (o as THREE.Mesh).isMesh === true ? (o as THREE.Mesh).geometry?.getAttribute('position') : undefined;
    if (pos === undefined) return;
    m.multiplyMatrices(inverseRoot, o.matrixWorld);
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
  });
  return out;
}

/** What {@link applyModelOccluders} did. */
export interface ModelOccluders {
  /** Stand-in meshes kept. */
  readonly standins: number;
  /** `_OCC` nodes dropped: a vertex outside their piece's LOD0 bounds, or none drawn (`occluder: none`). */
  readonly dropped: number;
}

/**
 * A model instance's `_OCC` nodes become stand-ins (or are dropped: outside
 * their piece's LOD0 bounds, or the model's `occluder` is `none`), and its
 * surfaces are marked when they do not count (`occ` and `none`, or `auto`
 * for a piece with a stand-in). Run on a fresh instance before its LOD groups are made, while
 * the file's node names are as exported.
 */
export function applyModelOccluders(root: THREE.Object3D, mode: ModelOccluderMode = 'auto'): ModelOccluders {
  const nodes: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D): void => {
    for (const c of o.children) {
      if (MODEL_OCC_RE.test(c.name)) nodes.push(c);
      else visit(c);
    }
  };
  visit(root);
  let dropped = 0;
  let standins = 0;
  /** The pieces a kept stand-in speaks for, and its stand-ins by piece. */
  const spoken = new Set<string>();
  const kept = new Map<string, THREE.Mesh[]>();
  if (nodes.length > 0) {
    root.updateMatrixWorld(true);
    const boxes = new Map<string, THREE.Box3>();
    const boundsOf = (piece: string): THREE.Box3 => {
      let b = boxes.get(piece);
      if (b === undefined) {
        b = pieceBounds(root, piece);
        // A node whose name matches no drawn piece stands in for the whole file.
        if (b.isEmpty()) b = pieceBounds(root, null);
        boxes.set(piece, b);
      }
      return b;
    };
    for (const node of nodes) {
      const piece = pieceOf(root, node);
      const box = boundsOf(piece);
      const inside = mode !== 'none' && !box.isEmpty() && occluderPointsOutside(pointsUnder(root, node), { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] }) === 0;
      if (!inside) {
        node.parent?.remove(node);
        dropped += 1;
        continue;
      }
      node.traverse((o) => {
        if ((o as THREE.Mesh).isMesh !== true) return;
        makeStandin(o as THREE.Mesh);
        standins += 1;
        spoken.add(piece);
        const list = kept.get(piece);
        if (list === undefined) kept.set(piece, [o as THREE.Mesh]);
        else list.push(o as THREE.Mesh);
      });
    }
  }
  // Per piece: in a kit file one piece may have a stand-in and the next none.
  const surfaces = new Map<string, THREE.Mesh[]>();
  const all: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true || isOccluderStandin(o)) return;
    const piece = pieceOf(root, o);
    if (!modelOccluderUse(mode, spoken.has(piece)).surfaces) o.userData[SURFACES_STAND_DOWN_KEY] = true;
    all.push(o as THREE.Mesh);
    const list = surfaces.get(piece);
    if (list === undefined) surfaces.set(piece, [o as THREE.Mesh]);
    else list.push(o as THREE.Mesh);
  });
  for (const [piece, list] of kept) for (const s of list) standinSurfaces.set(s, surfaces.get(piece) ?? all);
  return { standins, dropped };
}

/**
 * An object's `occluder` (its box's or model's; absent: true) on every mesh
 * under `root`. True when that changed a mesh (its batch must regroup).
 */
export function applyObjectOccluder(root: THREE.Object3D, components: unknown): boolean {
  const c = components as { box?: { occluder?: unknown }; model?: { occluder?: unknown } } | undefined;
  const off = (c?.box ?? c?.model)?.occluder === false;
  let changed = false;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true || (o.userData[NOT_OCCLUDER_KEY] === true) === off) return;
    changed = true;
    if (off) o.userData[NOT_OCCLUDER_KEY] = true;
    else delete o.userData[NOT_OCCLUDER_KEY];
  });
  return changed;
}

/** Whether a mesh's own material lets its depth count (opaque, no discards, one face). */
function materialFacts(mesh: THREE.Mesh): { transparent: boolean; alphaTested: boolean; doubleSided: boolean } {
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let transparent = false;
  let alphaTested = false;
  let doubleSided = false;
  for (const m of list) {
    if (m === undefined) continue;
    if (m.transparent) transparent = true;
    if (m.alphaTest > 0 || m.alphaToCoverage) alphaTested = true;
    if (m.side === THREE.DoubleSide) doubleSided = true;
  }
  return { transparent, alphaTested, doubleSided };
}

/** A draw's occluder role (its occludee kind: null for one three never culls). */
export function occluderRoleOfDraw(mesh: THREE.Mesh, kind: OccludeeKind | null): OccluderRole {
  return occluderRoleOf({
    kind,
    standin: isOccluderStandin(mesh),
    optedOut: mesh.userData[NOT_OCCLUDER_KEY] === true,
    surfacesStandDown: mesh.userData[SURFACES_STAND_DOWN_KEY] === true,
    ...materialFacts(mesh),
  });
}

/** The marks a batch or a merged cell carries for its members (they share them: their group key holds them). */
export function occluderMarksOf(mesh: THREE.Mesh): string {
  return `${mesh.userData[NOT_OCCLUDER_KEY] === true ? 'n' : ''}${mesh.userData[SURFACES_STAND_DOWN_KEY] === true ? 's' : ''}`;
}

/** Put a group's shared marks (`occluderMarksOf`) on the mesh that draws it. */
export function setOccluderMarks(mesh: THREE.Mesh, marks: string): void {
  if (marks.includes('n')) mesh.userData[NOT_OCCLUDER_KEY] = true;
  if (marks.includes('s')) mesh.userData[SURFACES_STAND_DOWN_KEY] = true;
}
