/**
 * Local lights per object (project-model local-lights.ts has the data rules).
 *
 * three.js shades every point and spot light on every lit material. An
 * object (or material) in mode `none` takes no local light: a far backdrop,
 * a sky dome, a look lit by the sun and the sky alone.
 *
 * - **Which build sees which lights.** The renderer's lights node (installed
 *   by `registerProbeLighting`) asks `splitLocalLights` before it builds a
 *   material's lights: a build in mode `none` leaves the local lights (and
 *   the effect light pool, effect-lights.ts) out; every other build shades
 *   them per pixel with three's own light nodes.
 * - **Which build an object gets.** A program can't depend on the object
 *   drawn (three keys programs by material, geometry and lights), so an
 *   object in mode `none` draws with a *mode variant* of its material: an
 *   object made with `Object.create(material)` — it reads every value of the
 *   material through the prototype (a colour, a texture, a version bump all
 *   reach it), carries only its mode and a program key that says so.
 *   `installLocalLightModes` swaps it in for each draw in
 *   `renderer.renderObject`; `mesh.material` never changes, so looks,
 *   lightmaps and material swaps keep owning it. Variants of equal materials
 *   share programs (their key is the material's key plus the mode), and
 *   light layers add none (they are a per-object uniform).
 * - **The default.** An object's `localLights` (`LOCAL_LIGHTS_KEY` in a
 *   drawable's `userData`), else its material's, else per pixel.
 */
import * as THREE from 'three/webgpu';
import { localLightModeOf, type LocalLightMode } from '@thirdlight/runtime';

import { type EffectLights } from './effect-lights';

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

type Keyed = THREE.Material & { customProgramCacheKey(): string; lights?: boolean; isNodeMaterial?: boolean };

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

/**
 * A material's program key the way three's render object computes it from
 * the material's own values (`RenderObject.getMaterialCacheKey`): a variant
 * has none of its own, so its key spells them out — two variants of equal
 * materials then share a program, as the materials do.
 */
export function materialValuesKey(m: THREE.Material): string {
  let key = '';
  for (const property of Object.keys(m)) {
    if (/^(is[A-Z]|_)|^(visible|version|uuid|name|opacity|userData)$/.test(property)) continue;
    const value = (m as unknown as Record<string, unknown>)[property];
    if (value === null || value === undefined) key += `${String(value)},`;
    else if (typeof value === 'number') key += property === 'side' ? `${value},` : value !== 0 ? '1,' : '0,';
    else if (typeof value === 'object') {
      const t = value as THREE.Texture;
      key += t.isTexture === true ? `{${t.mapping}${t.magFilter}${t.minFilter}${t.wrapS}${t.wrapT}${(t as unknown as { wrapR?: number }).wrapR ?? ''}},` : '{},';
    } else if (typeof value === 'function') key += 'f,';
    else key += `${String(value)},`;
  }
  return key;
}

const variants = new WeakMap<THREE.Material, Map<LocalLightMode, THREE.Material>>();

/** Variants made so far (diagnostics). */
let variantCount = 0;

/** The mode variant of `material` (made once, dropped when the material is disposed). */
export function localLightVariant(material: THREE.Material, mode: Exclude<LocalLightMode, 'pixel'>): THREE.Material {
  let byMode = variants.get(material);
  const seen = byMode?.get(mode);
  if (seen !== undefined) return seen;
  const base = material as Keyed;
  const v = Object.create(base) as Keyed & Record<string, unknown>;
  // Own listeners: three's render objects listen for the variant's dispose, never the material's.
  v['_listeners'] = {};
  v[VARIANT_MODE] = mode;
  v.customProgramCacheKey = function variantKey(): string {
    return `${base.customProgramCacheKey()}|${materialValuesKey(base)}|tlLocalLights=${mode}`;
  };
  if (byMode === undefined) {
    byMode = new Map();
    variants.set(material, byMode);
    material.addEventListener('dispose', () => {
      const made = variants.get(material);
      variants.delete(material);
      for (const m of made?.values() ?? []) m.dispatchEvent({ type: 'dispose' });
    });
  }
  byMode.set(mode, v);
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

type RenderObjectFn = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, ...rest: unknown[]) => void;

/**
 * `scene.userData[LOCAL_LIGHTS_IGNORED_KEY]`: the scene draws every object
 * with its material as it is, whatever its or the material's mode (the probe
 * bake: a lamp's bounce off a surface that takes no local light itself is
 * still light in the room).
 */
export const LOCAL_LIGHTS_IGNORED_KEY = 'tlLocalLightsIgnored';

/**
 * Draw each object with the variant of its mode. Shadow and other override
 * passes draw with their own material and are left alone; unlit materials
 * have no lights to split; a scene marked {@link LOCAL_LIGHTS_IGNORED_KEY}
 * draws every object per pixel.
 */
export function installLocalLightModes(renderer: { renderObject: RenderObjectFn }): void {
  const base = renderer.renderObject;
  renderer.renderObject = function renderObjectWithMode(this: unknown, object, scene, camera, geometry, material, ...rest) {
    if (scene.overrideMaterial === null && scene.userData[LOCAL_LIGHTS_IGNORED_KEY] !== true && isLit(material)) {
      const mode = drawMode(object, material);
      if (mode !== 'pixel') {
        const v = localLightVariant(material, mode);
        base.call(this, object, scene, camera, geometry, v, ...rest);
        // A transparent double-sided draw sets `side` on the material it draws and back: keep reading the material's.
        if (Object.prototype.hasOwnProperty.call(v, 'side')) delete (v as unknown as Record<string, unknown>)['side'];
        return;
      }
    }
    base.call(this, object, scene, camera, geometry, material, ...rest);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The lights of one build

type LightNodeLike = { readonly light?: THREE.Light; build(builder: unknown): unknown };
type LocalFlags = { isPointLight?: boolean; isSpotLight?: boolean; isEffectLights?: boolean };

function isLocal(l: THREE.Light | undefined): boolean {
  const f = l as (THREE.Light & LocalFlags) | undefined;
  return f !== undefined && (f.isPointLight === true || f.isSpotLight === true || f.isEffectLights === true);
}

function isPool(l: THREE.Light | undefined): l is EffectLights {
  return (l as (THREE.Light & LocalFlags) | undefined)?.isEffectLights === true;
}

/** The light nodes a build shades: all of them, or (a build in mode `none`) all but the local lights. */
export function splitLocalLights<T extends LightNodeLike>(builder: { material?: unknown }, nodes: readonly T[]): T[] {
  if (buildMode(builder) !== 'none') return [...nodes];
  return nodes.filter((n) => !isLocal(n.light));
}

/** The part of a lights node's program key the effect light pool decides (whether its shaders test layer masks). */
export function localLightsCacheKey(lights: readonly THREE.Light[]): number {
  let h = 0;
  for (const l of lights) if (isPool(l) && l.abilities.layered) h = (Math.imul(h, 31) + l.id * 8 + 1) | 0;
  return h;
}
