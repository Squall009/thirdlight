/**
 * Cheap local lights: how point and spot lights (and effect lights) are
 * evaluated on an object — Unity's "Not Important" (vertex) lights, Godot's
 * per-vertex shading.
 *
 * - An object (box, model, instance set) or a material has a local-light
 *   mode, `localLights`: `pixel` (every local light per pixel, as before),
 *   `vertex` (evaluated at the vertices and interpolated: diffuse only, no
 *   shadows or highlights — cheaper where a mesh has fewer vertices than the
 *   pixels it covers: large, coarse or close foliage) or `none` (no local
 *   light at all). The object's mode wins over its material's; with neither,
 *   instance sets use {@link INSTANCES_LOCAL_LIGHTS_DEFAULT} and everything
 *   else per pixel.
 * - A point or spot light has an `importance`: `auto` (follows each object's
 *   mode), `pixel` (always per pixel: a hero light) or `vertex` (always per
 *   vertex: a fill light). An object in `none` gets none of them.
 * - The sun, ambient light and probes are not local: they stay per pixel
 *   everywhere.
 *
 * Pure data.
 */
import type { ModelErrorV2 } from './errors';
import { fieldValue } from './validate';

/** Most point + spot lights per scene: the forward-lighting cost per drawn light (a quality level may draw fewer). */
export const MAX_LOCAL_LIGHTS = 16;

/** An object's local-light modes. */
export const LOCAL_LIGHT_MODES = ['pixel', 'vertex', 'none'] as const;
export type LocalLightMode = (typeof LOCAL_LIGHT_MODES)[number];

/** A material's local-light modes: `object` (absent) follows the object. */
export const MATERIAL_LOCAL_LIGHT_MODES = ['object', ...LOCAL_LIGHT_MODES] as const;
export type MaterialLocalLightMode = (typeof MATERIAL_LOCAL_LIGHT_MODES)[number];

/** A local light's importance. */
export const LIGHT_IMPORTANCES = ['auto', 'pixel', 'vertex'] as const;
export type LightImportance = (typeof LIGHT_IMPORTANCES)[number];

/**
 * The mode of an instance set that sets none (and whose material sets none).
 * Per pixel: measured on this engine's village class with lamps over its
 * scatter, per vertex was no cheaper (scatter far from the camera has about
 * as many vertices as pixels); a set of large, coarse or close foliage opts in.
 */
export const INSTANCES_LOCAL_LIGHTS_DEFAULT: LocalLightMode = 'pixel';

/** An object's or material's mode as the renderer reads it (undefined: not set — `object` on a material too). */
export function localLightModeOf(v: unknown): LocalLightMode | undefined {
  return (LOCAL_LIGHT_MODES as readonly unknown[]).includes(v) ? (v as LocalLightMode) : undefined;
}

/** A light's importance as the renderer reads it (absent or unknown: auto). */
export function lightImportanceOf(v: unknown): LightImportance {
  return (LIGHT_IMPORTANCES as readonly unknown[]).includes(v) ? (v as LightImportance) : 'auto';
}

/** An optional `localLights` field of a box, model or instance set. */
export function validateLocalLightMode(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined || localLightModeOf(v) !== undefined) return;
  errors.push(fieldValue(path, v, LOCAL_LIGHT_MODES.join(' | '), 'how local (point and spot) lights reach it: per pixel, per vertex or none'));
}

/** An optional `importance` field of a point or spot light. */
export function validateLightImportance(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined || (LIGHT_IMPORTANCES as readonly unknown[]).includes(v)) return;
  errors.push(fieldValue(path, v, LIGHT_IMPORTANCES.join(' | '), 'auto follows each object\'s local-light mode; pixel and vertex force one'));
}
