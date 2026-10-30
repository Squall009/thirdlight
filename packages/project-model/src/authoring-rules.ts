/**
 * Edit rules the commands enforce and the editor checks before it sends a
 * command: a declared property's value, a prefab capture's subtree and its
 * external references, a placed copy's root transform and a display name.
 *
 * They live here, beside the model, so the editor's preflight is the very
 * code the commands run: an edit the editor accepts is one the backend
 * accepts, and the two cannot drift. Each caller keeps its own error
 * presentation; the rule decides.
 *
 * Pure: no I/O, no code evaluation.
 */
import { DECLARATION_STRING_LENGTH_DEFAULT } from './content-limits';
import { isPrivateProperty } from './prefab-assembly';
import type { DeclaredProperty, PropertyType } from './types-v2';
import { isValidName, transformFieldErrors } from './validate';

export { isPrivateProperty, isValidName, transformFieldErrors };

/** The reference sets a property value resolves against. */
export interface PropertyRefs {
  entityIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
}

/**
 * Why a value breaks its declaration. `expected`/`message` are the commands'
 * presentation (the content fixtures pin it); `reference` failures carry none.
 */
export interface PropertyRuleFailure {
  kind: 'type' | 'value' | 'reference';
  type: PropertyType;
  expected: string;
  message: string;
}

export type PropertyRuleResult = { ok: true } | { ok: false; failure: PropertyRuleFailure };

/** The constraint fields of a declaration the rule reads. */
export interface PropertyConstraintFields {
  min?: number;
  max?: number;
  maxLength?: number;
  values?: readonly string[];
  bounds?: { min: readonly number[]; max: readonly number[] };
}

/** No C0 control character and no DEL. */
export function isControlFree(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/**
 * The one value rule for the seven declared property types. With `refs`
 * null a reference is only type-checked (a declaration's own default, or a
 * stored value shown without its scene); otherwise it must resolve.
 */
export function propertyValueRule(
  type: PropertyType,
  value: unknown,
  decl: PropertyConstraintFields,
  refs: PropertyRefs | null,
): PropertyRuleResult {
  const bad = (kind: PropertyRuleFailure['kind'], expected: string, message: string): PropertyRuleResult => ({
    ok: false,
    failure: { kind, type, expected, message },
  });
  switch (type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return bad('type', 'number', 'the declared property type is number');
      }
      if (decl.min !== undefined && value < decl.min) {
        return bad('value', `number >= ${decl.min}`, 'number value is below the declared minimum');
      }
      if (decl.max !== undefined && value > decl.max) {
        return bad('value', `number <= ${decl.max}`, 'number value is above the declared maximum');
      }
      return { ok: true };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true } : bad('type', 'boolean', 'the declared property type is boolean');
    case 'string': {
      if (typeof value !== 'string') return bad('type', 'string', 'the declared property type is string');
      const maxLength = decl.maxLength ?? DECLARATION_STRING_LENGTH_DEFAULT;
      if ([...value].length > maxLength) {
        return bad('value', `string of at most ${maxLength} characters`, 'string value exceeds its declared maxLength');
      }
      if (!isControlFree(value)) {
        return bad('value', 'string without control characters', 'string value must not contain control characters');
      }
      return { ok: true };
    }
    case 'enum': {
      if (typeof value !== 'string') {
        return bad('type', 'enum member string', 'the declared property type is enum member string');
      }
      const values = decl.values ?? [];
      if (!values.includes(value)) return bad('value', `one of: ${values.join(', ')}`, 'enum value is not a declared member');
      return { ok: true };
    }
    case 'vec3': {
      if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        return bad('type', 'array of 3 finite numbers', 'the declared property type is array of 3 finite numbers');
      }
      const bounds = decl.bounds;
      if (bounds !== undefined) {
        for (let i = 0; i < 3; i++) {
          const v = value[i] as number;
          if (v < (bounds.min[i] as number) || v > (bounds.max[i] as number)) {
            return bad('value', 'vec3 within the declared bounds', 'vec3 value is outside its declared bounds');
          }
        }
      }
      return { ok: true };
    }
    case 'entityRef':
    case 'assetRef': {
      if (value === null) return { ok: true };
      const what = type === 'entityRef' ? 'entity' : 'asset';
      if (typeof value !== 'string') {
        return bad('type', `string (${what} ID) or null`, `the declared property type is string (${what} ID) or null`);
      }
      if (refs === null) return { ok: true };
      const known = type === 'entityRef' ? refs.entityIds : refs.assetIds;
      return known.has(value) ? { ok: true } : bad('reference', '', `${what} reference does not resolve`);
    }
  }
}

// ---- prefabs ------------------------------------------------------------------

/** What the capture rules read of a scene object. */
export interface CaptureEntity {
  id: string;
  parentId?: string | null;
  behavior?: { behaviorId: string; values: Readonly<Record<string, unknown>> } | null;
}

/**
 * A subtree in scene document order (parent before child in a valid scene)
 * with its depth (the root is 1), or null when the root is not in the scene.
 */
export function subtreeOf<E extends CaptureEntity>(scene: readonly E[], rootId: string): { entities: E[]; depth: number } | null {
  const children = new Map<string, string[]>();
  let found = false;
  for (const e of scene) {
    if (e.id === rootId) found = true;
    if (e.parentId !== undefined && e.parentId !== null) {
      const list = children.get(e.parentId) ?? [];
      list.push(e.id);
      children.set(e.parentId, list);
    }
  }
  if (!found) return null;
  const depthOf = new Map<string, number>([[rootId, 1]]);
  const stack = [rootId];
  let depth = 1;
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const d = depthOf.get(id) as number;
    for (const k of children.get(id) ?? []) {
      if (depthOf.has(k)) continue;
      depthOf.set(k, d + 1);
      if (d + 1 > depth) depth = d + 1;
      stack.push(k);
    }
  }
  return { entities: scene.filter((e) => depthOf.has(e.id)), depth };
}

/** The public `entityRef` keys each behavior declares (a private value is never read). */
export function entityRefKeysByBehavior(
  behaviors: Iterable<{ behaviorId: string; declaration: { properties: readonly DeclaredProperty[] } }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of behaviors) {
    out.set(b.behaviorId, b.declaration.properties.filter((p) => p.type === 'entityRef' && !isPrivateProperty(p)).map((p) => p.key));
  }
  return out;
}

/**
 * The first `entityRef` value in a capture that names an object outside it:
 * a prefab cannot hold a link to something it does not contain.
 */
export function firstExternalEntityRef(
  closure: readonly CaptureEntity[],
  refKeys: ReadonlyMap<string, readonly string[]>,
): { localId: string; key: string; entityId: string } | null {
  const inside = new Set(closure.map((e) => e.id));
  for (const e of closure) {
    const behavior = e.behavior;
    if (behavior === undefined || behavior === null) continue;
    for (const key of refKeys.get(behavior.behaviorId) ?? []) {
      const v = behavior.values[key];
      if (typeof v === 'string' && !inside.has(v)) return { localId: e.id, key, entityId: v };
    }
  }
  return null;
}
