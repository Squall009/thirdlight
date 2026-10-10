/**
 * How a mesh decal draws: a mesh whose material is a decal (a `decal`
 * project material, a graph material whose output is flagged `decal`, or a
 * model file's own material named `*_decal`) is laid over the surface under
 * it.
 *
 * - **Transparent, no depth written, no shadow cast.** It draws after the
 *   opaque scene and never hides what is behind it; the surface under it
 *   already cast the shadow. It is lit like any surface (probes, light
 *   layers, its room): only the drawing state differs.
 * - **Pushed toward the camera in the vertex stage**, along its view ray, by
 *   a distance that grows with the distance from the camera
 *   ({@link DECAL_PUSH}). Along the ray the decal keeps its place on screen
 *   and only its depth changes, so it wins the depth test against the
 *   surface it lies on at any angle, with every depth buffer: a slope offset
 *   does not reach a logarithmic buffer (it writes depth per fragment) and
 *   flips its sign with reversed Z. A standard buffer also takes one fixed
 *   `polygonOffset` ({@link DECAL_POLYGON_OFFSET}) for the grazing angles,
 *   the same for every decal: on WebGPU each distinct offset is a pipeline
 *   of its own.
 * - **Blends** `blend` (its lit colour over the surface by its alpha),
 *   `multiply` (its albedo stains the lit colour under it; unlit) or `add`
 *   (its lit colour added: glow).
 * - **Sorted** before every other transparent surface (water, effects), in
 *   its sort order (higher draws later), through the render order
 *   ({@link decalRenderOrder}). The batcher and the static merger take decal
 *   meshes (one draw per cell per decal material); their draws carry the
 *   order.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import type { NodeBuilder } from 'three/webgpu';

import { DECAL_LIMITS } from '@thirdlight/runtime';

import { MATERIAL_NO_SHADOW_KEY } from './material-keys';

export type DecalBlendMode = 'blend' | 'multiply' | 'add';

/** How a decal material draws (`material.userData[DECAL_DRAW_KEY]`). */
export interface DecalDraw {
  readonly blend: DecalBlendMode;
  /** −1000 to 1000 (project-model `DECAL_LIMITS`): higher draws later. */
  readonly sortOrder: number;
}

/** `material.userData[DECAL_DRAW_KEY]`: the material draws as a mesh decal ({@link DecalDraw}). */
export const DECAL_DRAW_KEY = '__tlDecalDraw';

/**
 * How far a decal is pushed toward the camera along its view ray (m): at
 * least `min`, else `perMetre` of its distance, never more than half of it.
 * A 24-bit standard depth buffer with a 0.1 m near plane resolves about
 * d² × 6e-7 m at distance d (4 mm at 80 m): the push stays well above that
 * out to the far plane of any level, and is far too small to be seen on
 * screen (it moves along the ray). The screen-space ambient occlusion keeps
 * its history within 6 % of the depth, so a pushed decal still takes it.
 */
export const DECAL_PUSH = { min: 0.002, perMetre: 0.001 } as const;

/** The standard depth buffer's fixed offset for every decal (one pipeline state; grazing angles). */
export const DECAL_POLYGON_OFFSET = { factor: -1, units: -1 } as const;

/**
 * The render order of sort order 0: below every other transparent surface
 * (their orders are 0 and up), with room for the whole sort-order range on
 * either side.
 */
export const DECAL_RENDER_ORDER_BASE = -(4 * Math.max(Math.abs(DECAL_LIMITS.sortOrderMin), Math.abs(DECAL_LIMITS.sortOrderMax)));

/** A sort order as decals use it: a whole number in the sort-order range. */
export function decalSortOrder(v: unknown): number {
  const s = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(DECAL_LIMITS.sortOrderMin, Math.min(DECAL_LIMITS.sortOrderMax, s));
}

/** The render order of a decal of `sortOrder`. */
export function decalRenderOrderFor(sortOrder: number): number {
  return DECAL_RENDER_ORDER_BASE + decalSortOrder(sortOrder);
}

/** How a material draws as a decal (null: it is not one). */
export function decalDrawOf(material: THREE.Material | null | undefined): DecalDraw | null {
  return (material?.userData?.[DECAL_DRAW_KEY] as DecalDraw | undefined) ?? null;
}

/** The render order a mesh wearing `material` draws in (null: not a decal). */
export function decalRenderOrder(material: THREE.Material | THREE.Material[] | null | undefined): number | null {
  if (Array.isArray(material)) {
    let order: number | null = null;
    for (const m of material) {
      const d = decalDrawOf(m);
      if (d !== null) order = Math.min(order ?? Infinity, decalRenderOrderFor(d.sortOrder));
    }
    return order;
  }
  const d = decalDrawOf(material);
  return d === null ? null : decalRenderOrderFor(d.sortOrder);
}

export type DepthBufferMode = 'standard' | 'reversed' | 'logarithmic';

/**
 * The page's depth buffer (one renderer setting for every view of a page):
 * the fixed polygon offset is used only where it helps (standard depth).
 */
let depthMode: DepthBufferMode = 'standard';
/** The decal materials drawn now (their offset follows the depth mode). */
const live = new Set<THREE.Material>();

function applyOffset(m: THREE.Material): void {
  const on = depthMode === 'standard';
  if (m.polygonOffset === on) return;
  m.polygonOffset = on;
  m.polygonOffsetFactor = on ? DECAL_POLYGON_OFFSET.factor : 0;
  m.polygonOffsetUnits = on ? DECAL_POLYGON_OFFSET.units : 0;
  m.needsUpdate = true;
}

/** The depth buffer the page's renderer uses (the decals' fixed offset is on only with a standard one). */
export function setDecalDepthMode(mode: DepthBufferMode): void {
  if (mode === depthMode) return;
  depthMode = mode;
  for (const m of live) applyOffset(m);
}

type Node = ReturnType<typeof TSL.vec3>;
type PositionHolder = THREE.Material & { positionNode?: unknown; outputNode?: unknown };

/** The pushed position node of each decal material, and what it pushes (a material's own position, or none). */
const pushes = new WeakMap<THREE.Material, { readonly base: unknown; readonly node: unknown }>();

/**
 * `base` (the material's own position node; null: the vertex's) pushed
 * toward the camera along the view ray, in the object's space. Instancing
 * and batch columns are applied before the position node, so the object's
 * world matrix takes it to the world.
 */
function decalPush(base: unknown): unknown {
  return TSL.Fn((builder: NodeBuilder) => {
    const local = base === null ? TSL.positionLocal : TSL.vec3(base as Node);
    const world = TSL.modelWorldMatrix.mul(TSL.vec4(local, 1)).xyz;
    const toEye = TSL.cameraPosition.sub(world);
    const ortho = (builder as unknown as { camera?: { isOrthographicCamera?: boolean } }).camera?.isOrthographicCamera === true;
    // Toward the camera: along the ray through the eye, or the view's backward axis for a parallel projection.
    const back = TSL.normalize(TSL.cameraWorldMatrix.mul(TSL.vec4(0, 0, 1, 0)).xyz);
    const distance = ortho ? TSL.abs(TSL.dot(toEye, back)) : TSL.length(toEye);
    const dir = ortho ? back : toEye.div(TSL.max(distance, 1e-6));
    const push = TSL.min(TSL.max(TSL.float(DECAL_PUSH.min), distance.mul(DECAL_PUSH.perMetre)), distance.mul(0.5));
    return local.add(TSL.modelWorldMatrixInverse.mul(TSL.vec4(dir.mul(push), 0)).xyz);
  })();
}

/**
 * Make `material` draw as a mesh decal: transparent, no depth write, the
 * blend, the vertex push over its own position node, the depth offset, and
 * the mark the batcher, the merger and the shadow flags read. Idempotent;
 * call again after the material's position node changed (a graph
 * recompiled).
 */
export function installDecalDraw(material: THREE.Material, draw: DecalDraw): void {
  const m = material as PositionHolder;
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  if (draw.blend === 'add') m.blending = THREE.AdditiveBlending;
  else if (draw.blend === 'multiply') {
    // The colour drawn is the stain (1 where it leaves the surface alone): the surface times it; the alpha the
    // scene pass keeps (where the background shows) is left as it was.
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.ZeroFactor;
    m.blendDst = THREE.SrcColorFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
  } else m.blending = THREE.NormalBlending;
  const own = m.positionNode ?? null;
  const known = pushes.get(m);
  if (known === undefined || known.node !== own) {
    const node = decalPush(own);
    pushes.set(m, { base: own, node });
    m.positionNode = node;
  }
  m.userData[DECAL_DRAW_KEY] = { blend: draw.blend, sortOrder: decalSortOrder(draw.sortOrder) };
  if (!live.has(m)) {
    live.add(m);
    m.addEventListener('dispose', () => live.delete(m));
  }
  applyOffset(m);
  m.needsUpdate = true;
}

/** Undo {@link installDecalDraw} on a material that stops being a decal (a graph's flag cleared). */
export function removeDecalDraw(material: THREE.Material): void {
  const m = material as PositionHolder;
  if (m.userData[DECAL_DRAW_KEY] === undefined) return;
  delete m.userData[DECAL_DRAW_KEY];
  const known = pushes.get(m);
  if (known !== undefined && m.positionNode === known.node) m.positionNode = known.base;
  pushes.delete(m);
  live.delete(m);
  m.depthWrite = true;
  m.blending = THREE.NormalBlending;
  m.polygonOffset = false;
  m.polygonOffsetFactor = 0;
  m.polygonOffsetUnits = 0;
  m.needsUpdate = true;
}

/** Where a decal mesh keeps its own render order while it draws in the decal order. */
const OWN_ORDER_KEY = '__tlDecalOwnOrder';

/** Put `mesh` in the decal order `order`, or (null) back in its own. */
export function setDecalOrder(mesh: THREE.Object3D, order: number | null): void {
  const data = mesh.userData;
  if (order !== null) {
    if (data[OWN_ORDER_KEY] === undefined) data[OWN_ORDER_KEY] = mesh.renderOrder;
    mesh.renderOrder = order;
  } else if (data[OWN_ORDER_KEY] !== undefined) {
    mesh.renderOrder = data[OWN_ORDER_KEY] as number;
    delete data[OWN_ORDER_KEY];
  }
}

/** A model file's material that draws as a decal by its name (`*_decal`, any case) unless the asset maps it to a project material. */
export const FILE_DECAL_NAME = /_decal$/i;

/**
 * A model file's materials named `*_decal` draw as decals (blend, sort
 * order 0) with the file's own textures, and the meshes wearing them cast no
 * shadow and draw in the decal order. The file's materials are shared by
 * its copies, so this is done once per material (and again harmlessly per
 * copy). A project material mapped over one replaces it as any mapping does.
 */
export function markFileDecals(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true || Array.isArray(mesh.material) || mesh.material === undefined) return;
    const mat = mesh.material;
    if (!FILE_DECAL_NAME.test(mat.name)) return;
    if (decalDrawOf(mat) === null) installDecalDraw(mat, { blend: 'blend', sortOrder: 0 });
    // The entity's shadow flag is kept to restore (entity-render-flags.ts writes it there while this is on).
    if (mesh.userData[MATERIAL_NO_SHADOW_KEY] === undefined) {
      mesh.userData[MATERIAL_NO_SHADOW_KEY] = mesh.castShadow;
      mesh.castShadow = false;
    }
    setDecalOrder(mesh, decalRenderOrder(mat));
  });
}
