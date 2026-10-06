/**
 * Light layers: which lights light an object and whose shadows it casts
 * (Godot's light cull mask and shadow caster mask, Unity's rendering layers,
 * Unreal's lighting channels).
 *
 * - An object that draws (a box, a model, an instance set, a block layer) is
 *   in some of the {@link LIGHT_LAYER_COUNT} layers: `lightLayers`, a bit mask
 *   (absent: every layer).
 * - A light lights the objects in any of its `lightMask` layers, and only the
 *   objects in any of its `shadowCasterMask` layers cast its shadow (both
 *   absent: every layer). A mask of 0 lights nothing / takes no shadow.
 * - The project may name the layers (`content.lightLayers`, by bit, editor
 *   labels only): the game reads the masks.
 *
 * Absent masks are every layer, so a project that never sets one draws as it
 * did before light layers existed.
 */
import type { ModelErrorV2 } from './errors';
import { fieldValue, withFound } from './validate';

/**
 * How many light layers there are: the width of every mask. Eight named
 * layers cover the usual splits (world, characters, interiors, effects, UI
 * models, a few spare) and fit one row of checkboxes in the Inspector; the
 * renderer tests the masks as 32-bit integers, so the width could grow to 31
 * without a format change.
 */
export const LIGHT_LAYER_COUNT = 8;

/** Every layer: the default of every mask. */
export const LIGHT_LAYERS_ALL = (1 << LIGHT_LAYER_COUNT) - 1;

/** Longest layer name. */
export const MAX_LIGHT_LAYER_NAME = 32;

/** A mask as the renderer reads it: a valid integer mask, else every layer (absent, or not yet validated). */
export function lightLayerMaskOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= LIGHT_LAYERS_ALL ? v : LIGHT_LAYERS_ALL;
}

/**
 * An optional mask field: an integer from `min` to {@link LIGHT_LAYERS_ALL}.
 * An object's `lightLayers` starts at 1 (an object is in at least one layer),
 * a light's masks at 0.
 */
export function validateLightLayerMask(v: unknown, path: string, errors: ModelErrorV2[], min: 0 | 1): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > LIGHT_LAYERS_ALL) {
    errors.push(fieldValue(path, v, `an integer ${min}-${LIGHT_LAYERS_ALL}`, `a light layer mask: bit n is layer n + 1 (${LIGHT_LAYER_COUNT} layers; ${LIGHT_LAYERS_ALL}: every layer)`));
  }
}

/** The project's layer names (`content.lightLayers`): up to {@link LIGHT_LAYER_COUNT}, index n names layer n + 1; "" leaves one unnamed. */
export function validateLightLayerNames(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v)) {
    errors.push(withFound({ code: 'field_type', path, message: 'lightLayers is a list of layer names', expected: 'array of strings' }, v));
    return;
  }
  if (v.length > LIGHT_LAYER_COUNT) {
    errors.push(withFound({ code: 'field_value', path, message: `a project names at most ${LIGHT_LAYER_COUNT} light layers`, expected: `at most ${LIGHT_LAYER_COUNT} names` }, v.length));
  }
  // Labels only (the masks hold the layers), so two equal names are allowed.
  v.forEach((name, i) => {
    if (typeof name !== 'string' || name.length > MAX_LIGHT_LAYER_NAME) errors.push(fieldValue(`${path}/${i}`, name, `a name of up to ${MAX_LIGHT_LAYER_NAME} characters ("" for none)`, 'a light layer name'));
  });
}

/** What the editor calls layer `bit` (0-based): its project name, else "Layer n". */
export function lightLayerLabel(names: readonly string[] | undefined, bit: number): string {
  const n = names?.[bit];
  return typeof n === 'string' && n !== '' ? n : `Layer ${bit + 1}`;
}
