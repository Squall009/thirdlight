/**
 * How a subject parts the foliage it moves through: the `foliageBend`
 * component on a subject (an entity in the view's subject list, the same
 * list see-through fades round: the camera's target, or the subjects a
 * script names), and the defaults when it has none.
 *
 * The renderer pushes a foliage vertex away from each subject's body within
 * `radius` of it, by `strength` times the vertex's bend weight (COLOR_0 R,
 * squared) and its height above its plant's root; a scatter or cover rule's
 * `bendAway` scales how readily its plants give way. The pressed path
 * recovers over `recovery` seconds behind a moving subject. There is no
 * simulation and no state per plant (three-adapter `foliage-bend.ts`).
 *
 * Pure data.
 */
import type { ModelErrorV2 } from './errors';
import { isPlainObject } from '@thirdlight/shared';

export interface FoliageBendComponent {
  /** Metres round the subject's body foliage gives way within (absent: its body's radius plus `FOLIAGE_BEND_DEFAULTS.margin`). */
  radius?: number;
  /** How far foliage lies down at the body: 1 bends a plant's tip by its own height (absent: 1; 0: the subject parts nothing). */
  strength?: number;
  /** Seconds the pressed path takes to stand up again behind the subject (absent: 1). */
  recovery?: number;
}

export const FOLIAGE_BEND_FIELDS: readonly string[] = Object.freeze(['radius', 'strength', 'recovery']);

export const FOLIAGE_BEND_DEFAULTS = Object.freeze({
  /** Metres past the subject's body (its capsule or what it draws) foliage gives way within, when no radius is set. */
  margin: 0.3,
  strength: 1,
  recovery: 1,
  /** A rule's `bendAway` when absent. */
  ruleBend: 1,
});

export const FOLIAGE_BEND_LIMITS = Object.freeze({
  radius: Object.freeze({ min: 0.05, max: 50 }),
  strength: Object.freeze({ min: 0, max: 4 }),
  recovery: Object.freeze({ min: 0, max: 30 }),
  /** A scatter or cover rule's `bendAway`. */
  ruleBend: Object.freeze({ min: 0, max: 4 }),
});

const inRange = (v: unknown, r: { min: number; max: number }): boolean => typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max;
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

export function validateFoliageBendComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'foliageBend is an object { radius?, strength?, recovery? }', value);
  for (const k of Object.keys(value)) if (!FOLIAGE_BEND_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown foliageBend field "${k}" (${FOLIAGE_BEND_FIELDS.join(', ')})`, k);
  const L = FOLIAGE_BEND_LIMITS;
  const units: Record<string, string> = { radius: 'metres', strength: 'a factor', recovery: 'seconds' };
  for (const k of ['radius', 'strength', 'recovery'] as const) {
    if (value[k] !== undefined && !inRange(value[k], L[k])) err(errors, 'field_value', `${path}/${k}`, `${k} is ${L[k].min}-${L[k].max} (${units[k]})`, value[k]);
  }
}

export function canonicalFoliageBend(c: FoliageBendComponent): FoliageBendComponent {
  const out: FoliageBendComponent = {};
  if (c.radius !== undefined) out.radius = c.radius;
  if (c.strength !== undefined) out.strength = c.strength;
  if (c.recovery !== undefined) out.recovery = c.recovery;
  return out;
}

/** A subject's values, every one given (`bodyRadius`: its body's, which an absent radius grows from). */
export function foliageBendOf(c: unknown, bodyRadius: number): { radius: number; strength: number; recovery: number } {
  const v = isPlainObject(c) ? c : {};
  const L = FOLIAGE_BEND_LIMITS;
  const D = FOLIAGE_BEND_DEFAULTS;
  const pick = (k: 'radius' | 'strength' | 'recovery', d: number): number => (inRange(v[k], L[k]) ? (v[k] as number) : d);
  return { radius: pick('radius', Math.max(L.radius.min, bodyRadius + D.margin)), strength: pick('strength', D.strength), recovery: pick('recovery', D.recovery) };
}
