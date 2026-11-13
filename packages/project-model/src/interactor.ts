/**
 * How an object presses into what it moves through: the `interactor`
 * component, and the values an object without one uses where it still
 * presses (the view's subjects: the camera's target, or the subjects a
 * script names, the same list see-through fades round).
 *
 * Every object with the component (and every view subject) is stamped each
 * frame into the renderer's interaction field round the camera
 * (three-adapter `interaction-field.ts`): a soft footprint `radius` metres
 * round its body, pressed by `strength`, carrying its velocity and its body's
 * feet-to-top span. What it pressed stands up again over `recovery` seconds.
 * Foliage bends away from it there (by the vertex's bend weight, COLOR_0 R
 * squared, and its height above its plant's root; a scatter or cover rule's
 * `bendAway` scales how readily its plants give way). The field is visual
 * only: scripts and the simulation never read it.
 *
 * Pure data. The component was called `foliageBend` before the field; the
 * schema 8 step `interactor` (`upgrade-interactor.ts`) renames it.
 */
import type { ModelErrorV2 } from './errors';
import { isPlainObject } from '@thirdlight/shared';

export interface InteractorComponent {
  /** Metres round the body it presses within (absent: its body's radius plus `INTERACTOR_DEFAULTS.margin`). */
  radius?: number;
  /** How far foliage lies down at the body: 1 bends a plant's tip by its own height (absent: 1; 0: it presses nothing). */
  strength?: number;
  /** Seconds what it pressed takes to stand up again behind it (absent: 1). */
  recovery?: number;
}

export const INTERACTOR_FIELDS: readonly string[] = Object.freeze(['radius', 'strength', 'recovery']);

export const INTERACTOR_DEFAULTS = Object.freeze({
  /** Metres past the body (its capsule or what it draws) it presses within, when no radius is set. */
  margin: 0.3,
  strength: 1,
  recovery: 1,
  /** A rule's `bendAway` when absent. */
  ruleBend: 1,
});

export const INTERACTOR_LIMITS = Object.freeze({
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

export function validateInteractorComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'interactor is an object { radius?, strength?, recovery? }', value);
  for (const k of Object.keys(value)) if (!INTERACTOR_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown interactor field "${k}" (${INTERACTOR_FIELDS.join(', ')})`, k);
  const L = INTERACTOR_LIMITS;
  const units: Record<string, string> = { radius: 'metres', strength: 'a factor', recovery: 'seconds' };
  for (const k of ['radius', 'strength', 'recovery'] as const) {
    if (value[k] !== undefined && !inRange(value[k], L[k])) err(errors, 'field_value', `${path}/${k}`, `${k} is ${L[k].min}-${L[k].max} (${units[k]})`, value[k]);
  }
}

export function canonicalInteractor(c: InteractorComponent): InteractorComponent {
  const out: InteractorComponent = {};
  if (c.radius !== undefined) out.radius = c.radius;
  if (c.strength !== undefined) out.strength = c.strength;
  if (c.recovery !== undefined) out.recovery = c.recovery;
  return out;
}

/** An object's values, every one given (`bodyRadius`: its body's, which an absent radius grows from). */
export function interactorOf(c: unknown, bodyRadius: number): { radius: number; strength: number; recovery: number } {
  const v = isPlainObject(c) ? c : {};
  const L = INTERACTOR_LIMITS;
  const D = INTERACTOR_DEFAULTS;
  const pick = (k: 'radius' | 'strength' | 'recovery', d: number): number => (inRange(v[k], L[k]) ? (v[k] as number) : d);
  return { radius: pick('radius', Math.max(L.radius.min, bodyRadius + D.margin)), strength: pick('strength', D.strength), recovery: pick('recovery', D.recovery) };
}
