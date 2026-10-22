/**
 * How an entity's drawables meet the lights: whether its box, model or
 * instance set casts and receives the key light's shadow, which light
 * layers it is in (light-layers.ts), which decal layers projected decals
 * mark it in (projected-decals.ts), how its local lights are shaded
 * (local-lights.ts), whether it counts as an occluder (occluders.ts) and whether it fades round see-through
 * subjects (see-through.ts). Set on every mesh under what the entity
 * shows, when it is realized and when a model or instance set arrives.
 */
import type * as THREE from 'three';

import { applyObjectLightLayers, lightLayersOfComponents } from './light-layers';
import { applyObjectLocalLights, localLightsOfComponents } from './local-lights';
import { applyObjectDecalLayers, decalLayersOfComponents } from './projected-decals';
import { MATERIAL_NO_SHADOW_KEY } from './material-library';
import { applyObjectOccluder, isOccluderStandin } from './occluders';
import { applyObjectSeeThrough, seeThroughOfComponents } from './see-through';

/**
 * Whether an entity's box, model or instance set casts and
 * receives the directional light's realtime shadow — its component's
 * `castShadow` / `receiveShadow`, true when absent (solid geometry blocks the
 * light and shows the shadows falling on it), except an instance set's
 * `castShadow`, false when absent (foliage and scatter; project-model's
 * descriptors).
 */
export function shadowFlagsOf(components: unknown): { cast: boolean; receive: boolean } {
  const c = components as { box?: { castShadow?: unknown; receiveShadow?: unknown }; model?: { castShadow?: unknown; receiveShadow?: unknown }; instances?: { castShadow?: unknown; receiveShadow?: unknown } };
  const part = c.box ?? c.model;
  if (part === undefined && c.instances !== undefined) return { cast: c.instances.castShadow === true, receive: c.instances.receiveShadow !== false };
  return { cast: part?.castShadow !== false, receive: part?.receiveShadow !== false };
}

/** Set the shadow flags on every mesh under `root` (a model's meshes, an instance set's instanced meshes). */
function applyShadowFlags(root: THREE.Object3D, flags: { cast: boolean; receive: boolean }): void {
  root.traverse((o) => {
    // An occluder stand-in never casts or receives (it draws into the view's depth only).
    if ((o as THREE.Mesh).isMesh === true && !isOccluderStandin(o)) {
      // A graph material whose output casts no shadow keeps it off (its flag is data too).
      if (o.userData[MATERIAL_NO_SHADOW_KEY] !== undefined) o.userData[MATERIAL_NO_SHADOW_KEY] = flags.cast;
      else o.castShadow = flags.cast;
      o.receiveShadow = flags.receive;
    }
  });
}

/**
 * The entity's shadow flags, light layers, local-light mode and occluder flag
 * and see-through flag on every mesh under `root`. Returns whether the light
 * layers, the mode, the occluder or see-through flag of a mesh changed (the shadow maps that drew it, and its
 * batch, must follow).
 */
export function applyEntityRenderFlags(root: THREE.Object3D, components: unknown): boolean {
  applyShadowFlags(root, shadowFlagsOf(components));
  const layers = applyObjectLightLayers(root, lightLayersOfComponents(components));
  const decalLayers = applyObjectDecalLayers(root, decalLayersOfComponents(components));
  const occluder = applyObjectOccluder(root, components);
  const seeThrough = applyObjectSeeThrough(root, seeThroughOfComponents(components));
  return applyObjectLocalLights(root, localLightsOfComponents(components)) || layers || decalLayers || occluder || seeThrough;
}
