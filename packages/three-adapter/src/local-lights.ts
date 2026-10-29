/**
 * Local lights per object (project-model local-lights.ts has the data rules).
 *
 * three.js shades every point and spot light on every lit material. An
 * object (or material) in mode `none` takes no local light: a far backdrop,
 * a sky dome, a look lit by the sun and the sky alone.
 *
 * - **Which build sees which lights.** The renderer's lights node (installed
 *   by `registerProbeLighting`) asks `splitLocalLights` before it builds a
 *   material's lights: a build in mode `none` leaves the local lights (the
 *   light clusters' loop, effects' lights included) out; every other build shades
 *   them per pixel with three's own light nodes.
 * - **Which build an object gets.** A program can't depend on the object
 *   drawn (three keys programs by material, geometry and lights), so an
 *   object in mode `none` draws with a *mode variant* of its material: a
 *   shallow copy of the material's own values on the material's class, its
 *   values copied again once per render call (a colour, a texture, a version
 *   bump all reach it), carrying its mode and a program key that says so.
 *   `installLocalLightModes` swaps it in for each draw in
 *   `renderer.renderObject`; `mesh.material` never changes, so looks,
 *   lightmaps and material swaps keep owning it. Variants of equal materials
 *   share programs (their key is the material's key plus the mode), and
 *   light layers add none (they are a per-object uniform).
 *   (`material-variant.ts`: why a copy, not `Object.create`).
 * - **The default.** An object's `localLights` (`LOCAL_LIGHTS_KEY` in a
 *   drawable's `userData`), else its material's, else per pixel.
 */
import * as THREE from 'three/webgpu';
import { localLightModeOf, type LocalLightMode } from '@thirdlight/runtime';

import { makeMaterialVariant, renderCallOf, syncMaterialVariant } from './material-variant';
import { SURFACE_READ_CAPTURE, SURFACE_READ_KEY, SURFACE_READ_LIVE_KEY, SURFACE_READ_TEXTURES, SURFACE_READ_VARIANT, type SurfaceCacheTextures } from './surface-cache-read';

/** `object.userData[LOCAL_LIGHTS_KEY]` / `material.userData[LOCAL_LIGHTS_KEY]`: a set local-light mode. */
export const LOCAL_LIGHTS_KEY = '__tlLocalLights';
/** The own property of a mode variant holding its mode. */
const VARIANT_MODE = 'tlLocalLightMode';

/** Put an object's local-light mode on every mesh under `root` (undefined: not set). Returns whether any changed. */
export function applyObjectLocalLights(root: THREE.Object3D, mode: LocalLightMode | undefined): boolean {
  let changed = false;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true || o.userData[LOCAL_LIGHTS_KEY] === mode) return;
    changed = true;
    if (mode === undefined) delete o.userData[LOCAL_LIGHTS_KEY];
    else o.userData[LOCAL_LIGHTS_KEY] = mode;
  });
  return changed;
}

/** The local-light mode an entity's box, model or instance set sets (undefined: none). */
export function localLightsOfComponents(components: unknown): LocalLightMode | undefined {
  const c = components as { box?: { localLights?: unknown }; model?: { localLights?: unknown }; instances?: { localLights?: unknown } } | undefined;
  return localLightModeOf((c?.box ?? c?.model ?? c?.instances)?.localLights);
}

/** The mode a drawable set (undefined: not set), for grouping keys (batches, merged cells keep modes apart). */
export function objectLocalLights(o: THREE.Object3D): LocalLightMode | undefined {
  return o.userData[LOCAL_LIGHTS_KEY] as LocalLightMode | undefined;
}

/** The mode `object` draws `material` with. */
export function drawMode(object: THREE.Object3D, material: THREE.Material): LocalLightMode {
  return (object.userData[LOCAL_LIGHTS_KEY] as LocalLightMode | undefined) ?? (material.userData[LOCAL_LIGHTS_KEY] as LocalLightMode | undefined) ?? 'pixel';
}

// ---------------------------------------------------------------------------------------------------------------
// Mode variants


type LitFlags = { lights?: boolean; isNodeMaterial?: boolean; isMeshBasicNodeMaterial?: boolean; isMeshStandardMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshToonMaterial?: boolean };

/**
 * Whether a material is shaded by lights (it has local lights to split): a
 * lit node material, or a plain lit material three converts to one (a model
 * file's own). Basic materials take only lightmaps.
 */
export function isLit(material: THREE.Material): boolean {
  const m = material as THREE.Material & LitFlags;
  if (m.isNodeMaterial === true) return m.lights === true && m.isMeshBasicNodeMaterial !== true;
  return m.isMeshStandardMaterial === true || m.isMeshLambertMaterial === true || m.isMeshPhongMaterial === true || m.isMeshToonMaterial === true;
}

/** Each material's variants by `variantCode` (a reading one also by the textures it reads). */
const variants = new WeakMap<THREE.Material, Map<number, THREE.Material>>();

/** Variants made so far (diagnostics). */
let variantCount = 0;

/** A small number per local-light mode, for variant codes (no string is built per draw). */
const modeIds = new Map<string, number>();

/** A variant's code: its mode, the kind it reads (0: none) and whether it writes the colours. */
function variantCode(mode: LocalLightMode, kind: number, capture: boolean): number {
  let id = modeIds.get(mode);
  if (id === undefined) modeIds.set(mode, (id = modeIds.size));
  return (id * 256 + kind) * 2 + (capture ? 1 : 0);
}

/**
 * The variant of `material` drawn in local-light `mode` and, when `read` is
 * not null, reading the surface cache's light for that kind of static
 * surface (`surface-cache-read.ts`): made once, dropped when the material
 * is disposed, its values copied from the material again for each render
 * call `call` (-1, the default: copied now).
 */
export function localLightVariant(material: THREE.Material, mode: LocalLightMode, read: { kind: number; textures: SurfaceCacheTextures; capture?: boolean } | null = null, call = -1): THREE.Material {
  return variantFor(material, mode, read?.kind ?? 0, read?.textures ?? null, read?.capture === true, call);
}

function variantFor(material: THREE.Material, mode: LocalLightMode, kind: number, textures: SurfaceCacheTextures | null, capture: boolean, call: number): THREE.Material {
  const code = variantCode(mode, kind, capture);
  let byCode = variants.get(material);
  const seen = byCode?.get(code);
  if (seen !== undefined && (seen as unknown as Record<string, unknown>)[SURFACE_READ_TEXTURES] === textures) {
    syncMaterialVariant(seen, call);
    return seen;
  }
  // Another page's textures (the cache made again): the old variant goes, so three lets go of its draws.
  seen?.dispatchEvent({ type: 'dispose' });
  // Every mark always, in one order: a variant's shape is its class's.
  const v = makeMaterialVariant(material, { [VARIANT_MODE]: mode, [SURFACE_READ_VARIANT]: kind, [SURFACE_READ_TEXTURES]: textures, [SURFACE_READ_CAPTURE]: capture }, `|tlLocalLights=${mode}${textures !== null ? `|tlSurfaceRead=${kind}/${textures.id}${capture ? '/capture' : ''}` : ''}`);
  if (call !== -1) syncMaterialVariant(v, call);
  if (byCode === undefined) {
    byCode = new Map();
    variants.set(material, byCode);
    material.addEventListener('dispose', () => {
      const made = variants.get(material);
      variants.delete(material);
      for (const m of made?.values() ?? []) m.dispatchEvent({ type: 'dispose' });
    });
  }
  byCode.set(code, v);
  variantCount += 1;
  return v;
}

/** Variants made since the page loaded (diagnostics). */
export function localLightVariantCount(): number {
  return variantCount;
}

/** The mode a material build shades with (a variant's, else per pixel). */
function buildMode(builder: { material?: unknown }): LocalLightMode {
  return ((builder.material as Record<string, unknown> | undefined)?.[VARIANT_MODE] as LocalLightMode | undefined) ?? 'pixel';
}

type RenderObjectFn = (this: unknown, object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group?: unknown, lightsNode?: unknown, clippingContext?: unknown, passId?: unknown) => void;

/**
 * Draw each object with the variant of its mode. Shadow and other override
 * passes draw with their own material and are left alone; unlit materials
 * have no lights to split.
 */
export function installLocalLightModes(renderer: { renderObject: RenderObjectFn }): void {
  const base = renderer.renderObject;
  // Named arguments, not a rest array: this runs for every draw.
  renderer.renderObject = function renderObjectWithMode(this: unknown, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) {
    if (scene.overrideMaterial === null && isLit(material)) {
      const mode = drawMode(object, material);
      // A surface with a saved lightmap keeps drawing it until the scene is baked again.
      const textures = (material as { lightMap?: unknown }).lightMap ? undefined : (scene.userData[SURFACE_READ_LIVE_KEY] as SurfaceCacheTextures | undefined);
      const named = textures === undefined ? 0 : ((object.userData[SURFACE_READ_KEY] as number | undefined) ?? 0);
      const kind = named !== 0 && (textures!.readKinds & (1 << named)) !== 0 ? named : 0;
      if (mode !== 'pixel' || kind !== 0) {
        const v = kind === 0 ? variantFor(material, mode, 0, null, false, renderCallOf(this)) : variantFor(material, mode, kind, textures!, textures!.capture, renderCallOf(this));
        base.call(this, object, scene, camera, geometry, v, group, lightsNode, clippingContext, passId);
        return;
      }
    }
    base.call(this, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The lights of one build

type LightNodeLike = { readonly light?: THREE.Light; build(builder: unknown): unknown };
type LocalFlags = { isPointLight?: boolean; isSpotLight?: boolean; isClusteredLights?: boolean };

export function isLocal(l: THREE.Light | undefined): boolean {
  const f = l as (THREE.Light & LocalFlags) | undefined;
  return f !== undefined && (f.isPointLight === true || f.isSpotLight === true || f.isClusteredLights === true);
}

function isClustered(l: THREE.Light | undefined): l is THREE.Light & { layered: boolean; areas: boolean; uncached: boolean; shadows: boolean; cookies: boolean } {
  return (l as (THREE.Light & LocalFlags) | undefined)?.isClusteredLights === true;
}

/** Whether a material build shades local lights (every mode but `none`). */
export function buildsLocalLights(builder: { material?: unknown }): boolean {
  return buildMode(builder) !== 'none';
}

/** The light nodes a build shades: all of them, or (a build in mode `none`) all but the local lights. */
export function splitLocalLights<T extends LightNodeLike>(builder: { material?: unknown }, nodes: readonly T[]): T[] {
  if (buildMode(builder) !== 'none') return [...nodes];
  return nodes.filter((n) => !isLocal(n.light));
}

/** The part of a lights node's program key the clustered lights decide (whether their shaders test layer masks, draw area lights, sum uncached lights apart, read the shadow atlas, project cookies). */
export function localLightsCacheKey(lights: readonly THREE.Light[]): number {
  let h = 0;
  for (const l of lights) {
    if (!isClustered(l)) continue;
    const shape = (l.layered ? 1 : 0) | (l.areas ? 2 : 0) | (l.uncached ? 4 : 0) | (l.shadows ? 8 : 0) | (l.cookies ? 16 : 0);
    if (shape !== 0) h = (Math.imul(h, 31) + l.id * 32 + shape) | 0;
  }
  return h;
}
