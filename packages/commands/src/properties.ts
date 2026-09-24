/**
 * Declared-property declaration/value checks — commands.md §8.8/§8.9,
 * project-model.md §20.5/§20.8 (packet 21).
 *
 * The command layer must return the op-level error codes the contract names
 * (`property_unknown`, `property_type`, `property_value`,
 * `property_declaration_incompatible`, `reference_missing`,
 * `asset_reference_missing`) with the carried fields packet 16's fixtures pin.
 * The model remains the authority for the *document* rules: every candidate
 * content block is still re-validated by the v3/v4 content and project
 * validators after application, so these checks are the op-level front
 * door, not a second validator.
 *
 * Property shape (project-model §20.5): seven types, canonical field order
 * `key, label, type, default, min, max, step, maxLength, values, bounds`.
 */

import {
  assetReferenceMissing,
  fieldValue,
  propertyType,
  propertyTypeDetail,
  propertyUnknown,
  propertyValue,
  withBoundedFound,
} from './errors';
import type { CommandError } from './types';
import type {
  DeclaredProperty,
  PropertyDeclaration,
  PropertyType,
  PropertyValue,
} from '@thirdlight/project-model';

/** `^[a-z][a-z0-9_]{0,63}$` (project-model §20.5). */
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TYPES: readonly PropertyType[] = [
  'number',
  'boolean',
  'string',
  'enum',
  'vec3',
  'entityRef',
  'assetRef',
];

/** Reference-resolution context for value checks. */
export interface ValueContext {
  entityIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
}

/** Plain deep equality (JSON values only). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** `reference_missing` carrying a property-value failure (commands.md §8.9). */
export function referenceMissingValue(found: unknown, expected: string): CommandError {
  return withBoundedFound(
    {
      code: 'reference_missing',
      cls: 'validation',
      expected,
      message: 'entity reference does not resolve',
    },
    found,
  );
}

function isControlFree(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

function finiteVector(v: unknown, n: number, max: number): boolean {
  if (!Array.isArray(v) || v.length !== n) return false;
  return v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= max);
}

function declarationValueError(
  key: string,
  found: unknown,
  expected: string,
  message: string,
): CommandError {
  return propertyValue(key, found, expected, message);
}

/**
 * Validate one declared property's own data (§20.5/§20.8.5 step 5): key syntax
 * and uniqueness, label, type, default and constraint coherence. Limits are
 * enforced by the caller (checkDeclarationLimits) so the order matches §8.8.3.
 */
function checkDeclaredProperty(
  prop: unknown,
  index: number,
  seenKeys: Set<string>,
): { ok: true; prop: DeclaredProperty } | { ok: false; error: CommandError } {
  const path = `/args/declaration/properties/${index}`;
  if (typeof prop !== 'object' || prop === null || Array.isArray(prop)) {
    return {
      ok: false,
      error: {
        code: 'field_type',
        cls: 'validation',
        path,
        found: prop,
        expected: 'object (DeclaredProperty)',
        message: 'each declared property must be an object',
      },
    };
  }
  const p = prop as Record<string, unknown>;
  for (const field of Object.keys(p)) {
    if (!['key', 'label', 'type', 'default', 'min', 'max', 'step', 'maxLength', 'values', 'bounds'].includes(field)) {
      return {
        ok: false,
        error: {
          code: 'field_unexpected',
          cls: 'validation',
          path: `${path}/${field}`,
          found: field,
          expected: 'key, label, type, default, min, max, step, maxLength, values, bounds',
          message: 'unknown declared-property field',
        },
      };
    }
  }
  if (typeof p['key'] !== 'string') {
    return {
      ok: false,
      error: { code: 'field_type', cls: 'validation', path: `${path}/key`, found: p['key'], expected: 'string', message: 'property key must be a string' },
    };
  }
  const key = p['key'];
  if (!KEY_RE.test(key)) {
    return {
      ok: false,
      error: declarationValueError(key, key, 'key syntax ^[a-z][a-z0-9_]{0,63}$', 'property key does not use the declared key syntax'),
    };
  }
  if (seenKeys.has(key)) {
    return {
      ok: false,
      error: declarationValueError(key, key, 'a unique property key', 'property keys must be unique within a declaration'),
    };
  }
  seenKeys.add(key);
  if (typeof p['label'] !== 'string') {
    return {
      ok: false,
      error: { code: 'field_type', cls: 'validation', path: `${path}/label`, found: p['label'], expected: 'string', message: 'property label must be a string' },
    };
  }
  if (p['label'].length < 1 || p['label'].length > 64 || !isControlFree(p['label'])) {
    return {
      ok: false,
      error: declarationValueError(key, p['label'], 'string, 1-64 chars, no control characters', 'property label must be 1-64 characters without control characters'),
    };
  }
  const type = p['type'];
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      error: declarationValueError(key, type, `one of: ${TYPES.join(', ')}`, 'property type must be one of the seven declared types'),
    };
  }
  const pt = type as PropertyType;
  if (!Object.prototype.hasOwnProperty.call(p, 'default')) {
    return {
      ok: false,
      error: declarationValueError(key, undefined, 'a default value', 'every declared property requires a default'),
    };
  }
  const def = p['default'];
  // Optional numeric constraint coherence.
  for (const f of ['min', 'max', 'step'] as const) {
    const v = p[f];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) {
      return { ok: false, error: declarationValueError(key, v, 'finite number, |v| <= 1e12', `${f} must be a finite number within 1e12`) };
    }
    if (f === 'step' && (v <= 0 || v > 1e6)) {
      return { ok: false, error: declarationValueError(key, v, 'number in (0, 1e6]', 'step must be positive and at most 1e6') };
    }
  }
  const min = p['min'] as number | undefined;
  const max = p['max'] as number | undefined;
  if (min !== undefined && max !== undefined && min > max) {
    return { ok: false, error: declarationValueError(key, [min, max], 'min <= max', 'min must not exceed max') };
  }
  if (p['maxLength'] !== undefined) {
    const ml = p['maxLength'];
    if (typeof ml !== 'number' || !Number.isInteger(ml) || ml < 1 || ml > 1024) {
      return { ok: false, error: declarationValueError(key, ml, 'integer in [1, 1024]', 'maxLength must be an integer in [1, 1024]') };
    }
  }
  if (p['values'] !== undefined) {
    const values = p['values'];
    if (!Array.isArray(values) || values.length === 0) {
      return { ok: false, error: declarationValueError(key, values, 'array of 1-32 unique enum members', 'enum values must be a non-empty array') };
    }
    if (values.length > 32) {
      return { ok: false, error: declarationValueError(key, values, 'array of 1-32 unique enum members', 'an enum may declare at most 32 members') };
    }
    for (const m of values) {
      if (typeof m !== 'string' || m.length < 1 || m.length > 64 || !isControlFree(m)) {
        return { ok: false, error: declarationValueError(key, m, 'string, 1-64 chars, no control characters', 'enum members must be 1-64 characters without control characters') };
      }
    }
    if (new Set(values as string[]).size !== values.length) {
      return { ok: false, error: declarationValueError(key, values, 'unique enum members', 'enum members must be unique') };
    }
  }
  if (p['bounds'] !== undefined) {
    const bounds = p['bounds'];
    if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) {
      return { ok: false, error: declarationValueError(key, bounds, 'object { min: Vec3, max: Vec3 }', 'bounds must be an object with min and max vectors') };
    }
    const b = bounds as Record<string, unknown>;
    if (!finiteVector(b['min'], 3, 1e6) || !finiteVector(b['max'], 3, 1e6)) {
      return { ok: false, error: declarationValueError(key, bounds, 'finite Vec3 min/max with |v| <= 1e6', 'bounds min/max must be finite 3-number vectors within 1e6') };
    }
    const bmin = b['min'] as number[];
    const bmax = b['max'] as number[];
    for (let i = 0; i < 3; i++) {
      if ((bmin[i] as number) > (bmax[i] as number)) {
        return { ok: false, error: declarationValueError(key, bounds, 'component-wise min <= max', 'bounds min must not exceed max component-wise') };
      }
    }
  }
  // The default must satisfy the property's own constraints.
  const ctx: ValueContext = { entityIds: new Set(), assetIds: new Set() };
  const checked = checkPropertyValue(pt, key, def, p, ctx, true);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, prop: p as unknown as DeclaredProperty };
}

/**
 * How one value-rule failure is reported to a caller.
 *
 * `expected`/`message` carry the op-level (`field`) presentation the
 * packet-21 fixtures pin; a caller that wants a different presentation (the
 * prefab override path uses a constraint-rich `expected`) supplies an
 * override or maps the failure itself. The RULE below is the single place
 * the seven type vocabularies are decided.
 */
interface ValueRuleFailure {
  kind: 'type' | 'value' | 'reference';
  type: PropertyType;
  /** Field presentation (empty for a reference failure). */
  expected: string;
  message: string;
}

/**
 * Pure value rule for one property instance (project-model §20.5).
 * `allowUnresolved` is used for a declaration's own default: an `entityRef`
 * default of `null` is valid; a non-null reference default cannot be checked
 * against a scene and is validated by the model when it is actually stored.
 * Reference values are only *resolved* when `resolveRefs` is true.
 */
function checkPropertyValueRule(
  type: PropertyType,
  value: unknown,
  decl: Record<string, unknown>,
  ctx: ValueContext,
  allowUnresolved: boolean,
): { ok: true } | { ok: false; failure: ValueRuleFailure } {
  const bad = (
    kind: ValueRuleFailure['kind'],
    expected: string,
    message: string,
  ): { ok: false; failure: ValueRuleFailure } => ({
    ok: false,
    failure: { kind, type, expected, message },
  });
  switch (type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return bad('type', 'number', 'the declared property type is number');
      }
      const min = decl['min'] as number | undefined;
      const max = decl['max'] as number | undefined;
      if (min !== undefined && value < min) {
        return bad('value', `number >= ${min}`, 'number value is below the declared minimum');
      }
      if (max !== undefined && value > max) {
        return bad('value', `number <= ${max}`, 'number value is above the declared maximum');
      }
      return { ok: true };
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        return bad('type', 'boolean', 'the declared property type is boolean');
      }
      return { ok: true };
    case 'string': {
      if (typeof value !== 'string') {
        return bad('type', 'string', 'the declared property type is string');
      }
      const maxLength = (decl['maxLength'] as number | undefined) ?? 256;
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
      const values = (decl['values'] as string[] | undefined) ?? [];
      if (!values.includes(value)) {
        return bad('value', `one of: ${values.join(', ')}`, 'enum value is not a declared member');
      }
      return { ok: true };
    }
    case 'vec3': {
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        !value.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        return bad('type', 'array of 3 finite numbers', 'the declared property type is array of 3 finite numbers');
      }
      const bounds = decl['bounds'] as { min: number[]; max: number[] } | undefined;
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
    case 'entityRef': {
      if (value === null) return { ok: true };
      if (typeof value !== 'string') {
        return bad('type', 'string (entity ID) or null', 'the declared property type is string (entity ID) or null');
      }
      if (allowUnresolved) return { ok: true };
      if (!ctx.entityIds.has(value)) {
        return bad('reference', '', 'entity reference does not resolve');
      }
      return { ok: true };
    }
    case 'assetRef': {
      if (value === null) return { ok: true };
      if (typeof value !== 'string') {
        return bad('type', 'string (asset ID) or null', 'the declared property type is string (asset ID) or null');
      }
      if (allowUnresolved) return { ok: true };
      if (!ctx.assetIds.has(value)) {
        return bad('reference', '', 'asset reference does not resolve');
      }
      return { ok: true };
    }
  }
}

/** Field-presentation mapper for a rule failure (packet-21 pinned shapes). */
function fieldValueError(
  key: string,
  value: unknown,
  failure: ValueRuleFailure,
): CommandError {
  if (failure.kind === 'reference') {
    return failure.type === 'assetRef'
      ? assetReferenceMissing(value as string)
      : referenceMissingValue(value, 'an existing entity ID in the current scene');
  }
  if (failure.kind === 'type') return propertyType(key, value, failure.expected);
  return propertyValue(key, value, failure.expected, failure.message);
}

/**
 * Value check for one property instance in the field/declaration presentation
 * (`null` reference values allowed). Used by `validateDeclaration` defaults,
 * `fillDeclaredValues` and declaration compatibility.
 */
function checkPropertyValue(
  type: PropertyType,
  key: string,
  value: unknown,
  decl: Record<string, unknown>,
  ctx: ValueContext,
  allowUnresolved: boolean,
): { ok: true } | { ok: false; error: CommandError } {
  const r = checkPropertyValueRule(type, value, decl, ctx, allowUnresolved);
  if (r.ok) return { ok: true };
  return { ok: false, error: fieldValueError(key, value, r.failure) };
}

/** The constraint-rich type description the prefab override fixtures pin (§8.7.3). */
function overrideTypeDescription(prop: DeclaredProperty): string {
  switch (prop.type) {
    case 'number':
      return typeof prop.min === 'number' && typeof prop.max === 'number'
        ? `finite number in [${prop.min}, ${prop.max}]`
        : 'finite number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return `string of at most ${prop.maxLength ?? 256} characters`;
    case 'enum':
      return `one of: ${(prop.values ?? []).join(', ')}`;
    case 'vec3':
      return 'array of 3 finite numbers';
    case 'entityRef':
      return 'string (entity ID) or null';
    case 'assetRef':
      return 'string (asset ID) or null';
  }
}

/**
 * Instantiation-override value check (commands.md §8.7.3): the same seven-type
 * rule, reported with the override presentation. `ctx.entityIds` must be the
 * union of the definition's localIds and the current scene's entity IDs;
 * `ctx.assetIds` is `content.assets`.
 */
export function checkOverrideValue(
  prop: DeclaredProperty,
  key: string,
  value: unknown,
  ctx: ValueContext,
  prefabId: string,
): { ok: true } | { ok: false; error: CommandError } {
  const r = checkPropertyValueRule(
    prop.type,
    value,
    prop as unknown as Record<string, unknown>,
    ctx,
    false,
  );
  if (r.ok) return { ok: true };
  const failure = r.failure;
  if (failure.kind === 'reference') {
    return failure.type === 'assetRef'
      ? { ok: false, error: assetReferenceMissing(value as string) }
      : {
          ok: false,
          error: referenceMissingValue(
            value,
            `a localId of ${prefabId} or an existing scene entity ID`,
          ),
        };
  }
  if (failure.kind === 'type') {
    return {
      ok: false,
      error: propertyTypeDetail(key, value, failure.type, overrideTypeDescription(prop)),
    };
  }
  return { ok: false, error: propertyValue(key, value, failure.expected, failure.message) };
}

/**
 * Validate a whole declaration for `publishBehavior` (§8.8.3 steps 4–5):
 * declaration limits, then every property's data. Returns the canonical
 * declaration value (request field order preserved).
 */
export function validateDeclaration(
  declaration: PropertyDeclaration,
): { ok: true; declaration: PropertyDeclaration } | { ok: false; error: CommandError } {
  const properties = declaration.properties as readonly unknown[];
  if (properties.length === 0) {
    return {
      ok: false,
      error: fieldValue(
        '/args/declaration/properties',
        [],
        'at least one declared property',
        'a behavior with no declared properties is invalid (project-model §20.8.5)',
      ),
    };
  }
  if (properties.length > 32) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        cls: 'validation',
        limit: 'properties',
        current: properties.length,
        max: 32,
        message: `a declaration may declare at most 32 properties`,
      },
    };
  }
  const out: DeclaredProperty[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < properties.length; i++) {
    const r = checkDeclaredProperty(properties[i], i, seen);
    if (!r.ok) return r;
    out.push(r.prop);
  }
  for (const p of out) {
    if (p.values !== undefined && p.values.length > 32) {
      return {
        ok: false,
        error: {
          code: 'limits_exceeded',
          cls: 'validation',
          limit: 'enum_values',
          current: p.values.length,
          max: 32,
          message: `enum '${p.key}' may declare at most 32 members`,
        },
      };
    }
  }
  const canonical: PropertyDeclaration = { properties: out };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical, null, 2) + '\n').length;
  if (bytes > 32_768) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        cls: 'validation',
        limit: 'declaration_bytes',
        current: bytes,
        max: 32_768,
        message: 'the canonical declaration exceeds the 32768-byte cap',
      },
    };
  }
  return { ok: true, declaration: canonical };
}

/**
 * Check a provided value map against a declaration and fill defaults
 * (§8.9 step 4/5): every provided key must be declared and type-check; the
 * result contains every declared key in declaration order.
 */
export function fillDeclaredValues(
  declaration: PropertyDeclaration,
  provided: Record<string, unknown>,
  ctx: ValueContext,
  behaviorId?: string,
  previousValues?: Record<string, PropertyValue>,
):
  | { ok: true; values: Record<string, PropertyValue> }
  | { ok: false; error: CommandError } {
  const byKey = new Map<string, DeclaredProperty>(
    declaration.properties.map((p) => [p.key, p]),
  );
  for (const key of Object.keys(provided)) {
    if (!byKey.has(key)) return { ok: false, error: propertyUnknown(behaviorId, key) };
  }
  const values: Record<string, PropertyValue> = {};
  for (const prop of declaration.properties) {
    const providedValue = Object.prototype.hasOwnProperty.call(provided, prop.key);
    // Omitted keys keep the existing stored value when the component already
    // has one (§20.8.3: changing a default affects NEW values only); a fresh
    // attach falls back to the declaration default.
    const previousValue =
      previousValues !== undefined && Object.prototype.hasOwnProperty.call(previousValues, prop.key);
    const value = providedValue
      ? provided[prop.key]
      : previousValue
        ? (previousValues as Record<string, PropertyValue>)[prop.key]
        : prop.default;
    const checked = checkPropertyValue(
      prop.type,
      prop.key,
      value,
      prop as unknown as Record<string, unknown>,
      ctx,
      false,
    );
    if (!checked.ok) return { ok: false, error: checked.error };
    values[prop.key] = value as PropertyValue;
  }
  return { ok: true, values };
}

/**
 * `declaration-update` compatibility (§8.8.3 step 6 / §20.8.5): every existing
 * use must still be accepted. Returns the first incompatibility found in use
 * order, carrying the offending `(entityId, key)` pairs.
 */
export function checkDeclarationCompatibility(
  behaviorId: string,
  previous: PropertyDeclaration,
  next: PropertyDeclaration,
  uses: readonly { entityId: string; values: Record<string, PropertyValue> }[],
  ctx: ValueContext,
): { ok: true } | { ok: false; error: CommandError } {
  const nextByKey = new Map(next.properties.map((p) => [p.key, p]));
  const removed = new Set<string>();
  for (const prop of previous.properties) {
    if (!nextByKey.has(prop.key)) removed.add(prop.key);
  }
  const typeChanged = new Set<string>();
  for (const prop of previous.properties) {
    const n = nextByKey.get(prop.key);
    if (n !== undefined && n.type !== prop.type) typeChanged.add(prop.key);
  }
  // 4. a removed key is incompatible only if some stored value uses it.
  const removedUses: { entityId: string; key: string }[] = [];
  for (const use of uses) {
    for (const key of Object.keys(use.values)) {
      if (removed.has(key)) removedUses.push({ entityId: use.entityId, key });
    }
  }
  if (removedUses.length > 0) {
    return {
      ok: false,
      error: {
        code: 'property_declaration_incompatible',
        cls: 'validation',
        behaviorId,
        reason: 'declared_key_removed',
        uses: removedUses,
        message: 'the new declaration is incompatible with existing behavior components; nothing was written',
      },
    };
  }
  const typeUses: { entityId: string; key: string }[] = [];
  for (const use of uses) {
    for (const key of Object.keys(use.values)) {
      if (typeChanged.has(key)) typeUses.push({ entityId: use.entityId, key });
    }
  }
  if (typeUses.length > 0) {
    return {
      ok: false,
      error: {
        code: 'property_declaration_incompatible',
        cls: 'validation',
        behaviorId,
        reason: 'declared_type_changed',
        uses: typeUses,
        message: 'the new declaration is incompatible with existing behavior components; nothing was written',
      },
    };
  }
  // 2. every stored value must still satisfy the new declaration.
  for (const use of uses) {
    for (const [key, value] of Object.entries(use.values)) {
      const n = nextByKey.get(key);
      if (n === undefined) continue; // covered by removal above
      const checked = checkPropertyValue(
        n.type,
        key,
        value,
        n as unknown as Record<string, unknown>,
        ctx,
        false,
      );
      if (!checked.ok) {
        return {
          ok: false,
          error: {
            code: 'property_declaration_incompatible',
            cls: 'validation',
            behaviorId,
            reason: 'stored_value_invalid',
            uses: [{ entityId: use.entityId, key }],
            message: 'the new declaration is incompatible with existing behavior components; nothing was written',
          },
        };
      }
    }
  }
  return { ok: true };
}
