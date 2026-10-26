/**
 * Area lights: a light with a size, a `light` component of type `area`.
 *
 * - Its shape is a rectangle (`rect`) lying in the object's local XZ plane,
 *   centred on the object, `width` along local X and `height` along local Z;
 *   or a line (`line`), a thin tube `width` long along local X.
 * - It faces local −Y, so an unrotated area light is a ceiling panel shining
 *   down; `twoSided` makes it shine both ways. Where it faces comes from the
 *   object's transform only (it has no `direction`).
 * - `intensity` is candela along its facing axis for the whole light: far
 *   away it lights like a point light of that intensity, close by its size
 *   softens the light and its shadows (soft shadows are its point, so it
 *   casts them unless told not to).
 *
 * Pure data.
 */
import type { ModelErrorV2 } from './errors';
import { fieldType, fieldValue } from './validate';

/** An area light's shapes. */
export const AREA_LIGHT_SHAPES = ['rect', 'line'] as const;
export type AreaLightShape = (typeof AREA_LIGHT_SHAPES)[number];

/**
 * An area light's longest side in metres: a lit ceiling, a window or a
 * light strip down a hall fits; a larger emitter is a sky or a lit surface,
 * not a light.
 */
export const AREA_LIGHT_SIZE_MAX = 50;

/**
 * The values an area light has when they are absent: a 1 × 0.5 m panel
 * (a ceiling fixture's size) shining one way, casting shadows.
 */
export const AREA_LIGHT_DEFAULTS = Object.freeze({ shape: 'rect' as AreaLightShape, width: 1, height: 0.5, twoSided: false, castShadow: true });

/** The fields an area light carries besides the ones every light has. */
export const AREA_LIGHT_FIELDS = ['shape', 'width', 'height', 'twoSided'] as const;

/** An area light's own fields (`shape`, `width`, `height` (a rect's only), `twoSided`). */
export function validateAreaLightFields(c: Readonly<Record<string, unknown>>, path: string, errors: ModelErrorV2[]): void {
  const shape = c['shape'];
  if (shape !== undefined && !(AREA_LIGHT_SHAPES as readonly unknown[]).includes(shape)) {
    errors.push(fieldValue(`${path}/shape`, shape, AREA_LIGHT_SHAPES.map((s) => `"${s}"`).join(' | '), 'an area light is a rect or a line'));
  }
  for (const k of ['width', 'height'] as const) {
    const v = c[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > AREA_LIGHT_SIZE_MAX)) {
      errors.push(fieldValue(`${path}/${k}`, v, `a number in (0, ${AREA_LIGHT_SIZE_MAX}]`, `${k} must be in (0, ${AREA_LIGHT_SIZE_MAX}] m`));
    }
  }
  if (shape === 'line' && c['height'] !== undefined) {
    errors.push(fieldValue(`${path}/height`, c['height'], 'absent on a line light', 'a line light has a length (width) only'));
  }
  if (c['twoSided'] !== undefined && typeof c['twoSided'] !== 'boolean') errors.push(fieldType(`${path}/twoSided`, c['twoSided'], 'boolean'));
}

/** An area light's own fields and its shadow flag in canonical form, absent ones filled. */
export function canonicalAreaLightFields(o: Readonly<Record<string, unknown>>): { shape: AreaLightShape; width: number; height?: number; twoSided: boolean; castShadow: boolean } {
  const shape = o['shape'] === 'line' ? 'line' : AREA_LIGHT_DEFAULTS.shape;
  const num = (k: 'width' | 'height'): number => (typeof o[k] === 'number' ? (o[k] as number) : AREA_LIGHT_DEFAULTS[k]);
  return {
    shape,
    width: num('width'),
    ...(shape === 'rect' ? { height: num('height') } : {}),
    twoSided: typeof o['twoSided'] === 'boolean' ? o['twoSided'] : AREA_LIGHT_DEFAULTS.twoSided,
    castShadow: typeof o['castShadow'] === 'boolean' ? o['castShadow'] : AREA_LIGHT_DEFAULTS.castShadow,
  };
}
