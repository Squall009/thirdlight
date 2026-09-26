/**
 * Declared-property control model (packet 28; project-model §20.5/§20.8,
 * commands.md §8.7.3/§8.9).
 *
 * Schema-driven controls for the seven M2 property types, derived **only**
 * from the published declaration data (`content.behaviors[i].declaration`,
 * project-model §20.6): every control carries the declaration's `label`,
 * `type`, typed `default` and its constraints (min/max/step/maxLength/enum
 * members/vec3 bounds). Nothing here evaluates a value, imports behavior code
 * or discovers a schema by running anything — a declaration is data and is
 * consumed as data (project-model §20.5: "no schema discovery by evaluating
 * code").
 *
 * The module also derives the contract component controls for `collider` and
 * `controller` shapes (project-model §10.7/§10.8/§21) and builds the exact
 * `setBehaviorProperties` args (commands.md §8.9): the whole values map is
 * sent, because omitted keys take their declaration default — editing one
 * property must not reset the others.
 *
 * Pure: no DOM, no I/O, no Node builtins, no code evaluation.
 */

import type {
  BehaviorComponent,
  ColliderComponent,
  DeclaredProperty,
  PrefabDefinition,
  PrefabEntity,
  PropertyDeclaration,
  PropertyType,
  PropertyValue,
} from '@thirdlight/project-model';

/** `^[a-z0-9][a-z0-9_-]{0,63}$` — the project-model §5.1 ID syntax. */
export const ID_SYNTAX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** project-model §20.5: a `string` declaration without `maxLength` defaults to 256. */
export const DEFAULT_STRING_MAX_LENGTH = 256;

/** §20.7: properties per declaration, enum members, string `maxLength`. */
export const MAX_DECLARED_PROPERTIES = 32;
export const MAX_ENUM_MEMBERS = 32;
export const MAX_STRING_MAX_LENGTH = 1024;

/** A bounded, actionable diagnostic surfaced to the UI. */
export interface ControlError {
  code: string;
  message: string;
  /** The JSON-Pointer-ish location inside the command args, when known. */
  path?: string;
  expected?: string;
  found?: unknown;
}

/** The declaration constraints a control exposes (defaults/types/errors). */
export interface PropertyConstraints {
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  values?: readonly string[];
  bounds?: { min: readonly number[]; max: readonly number[] };
}

export interface PropertyControl {
  key: string;
  label: string;
  type: PropertyType;
  /** The declaration's typed default (never evaluated). */
  default: PropertyValue;
  /** The stored value, or the default when the component/values are absent. */
  current: PropertyValue;
  /** `current` differs from `default`. */
  modified: boolean;
  constraints: PropertyConstraints;
  /** A one-line type/constraint summary for the control's caption. */
  constraintText: string;
  /** `current` violates the declaration (a bounded error), else `null`. */
  error: ControlError | null;
  /** Phase 15.4: the Inspector section, heading and hover help the declaration names. */
  group?: string;
  header?: string;
  tooltip?: string;
}

/** Phase 15.4: a private property is not shown or set per object (absent visibility = public). */
export function isPrivateProperty(p: { visibility?: string }): boolean {
  return p.visibility === 'private';
}

/** An entity's stored values as the projection carries them (never trusted). */
export type StoredValues = Readonly<Record<string, unknown>>;

function own(values: StoredValues | null | undefined, key: string): { present: boolean; value: unknown } {
  if (values === null || values === undefined) return { present: false, value: undefined };
  if (!Object.prototype.hasOwnProperty.call(values, key)) return { present: false, value: undefined };
  return { present: true, value: values[key] };
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate one value against one declaration (project-model §20.5). The
 * declaration is data: the value is checked structurally against the declared
 * type and range/length/enum/bounds — never executed or coerced.
 */
export function validatePropertyValue(prop: DeclaredProperty, value: unknown): ControlError | null {
  const label = prop.label || prop.key;
  const typeError = (expected: string): ControlError => ({
    code: 'property_type',
    message: `${label} must match its declared type (${prop.type})`,
    expected,
    found: value,
  });
  const valueError = (expected: string): ControlError => ({
    code: 'property_value',
    message: `${label} violates its declared constraints`,
    expected,
    found: value,
  });
  switch (prop.type) {
    case 'number': {
      if (!isFiniteNumber(value)) return typeError('finite number');
      if (prop.min !== undefined && value < prop.min) return valueError(`v >= ${prop.min}`);
      if (prop.max !== undefined && value > prop.max) return valueError(`v <= ${prop.max}`);
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : typeError('boolean');
    case 'string': {
      if (typeof value !== 'string') return typeError('string');
      const maxLength = prop.maxLength ?? DEFAULT_STRING_MAX_LENGTH;
      if ([...value].length > maxLength) return valueError(`length <= ${maxLength} code points`);
      if (hasControlChars(value)) return valueError('no control characters');
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string') return typeError('one of the declared enum members');
      const values = prop.values ?? [];
      return values.includes(value) ? null : valueError('one of the declared enum members');
    }
    case 'vec3': {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
        return typeError('[number, number, number]');
      }
      const bounds = prop.bounds;
      if (bounds) {
        for (let i = 0; i < 3; i += 1) {
          const n = value[i] as number;
          if (n < (bounds.min[i] as number) || n > (bounds.max[i] as number)) {
            return valueError('component-wise within bounds');
          }
        }
      }
      return null;
    }
    case 'entityRef':
    case 'assetRef':
      if (value === null) return null;
      if (typeof value !== 'string' || !ID_SYNTAX.test(value)) return typeError('an ID string or null');
      return null;
    default:
      return typeError('a known property type');
  }
}

function constraintsOf(prop: DeclaredProperty): PropertyConstraints {
  const c: PropertyConstraints = {};
  if (prop.min !== undefined) c.min = prop.min;
  if (prop.max !== undefined) c.max = prop.max;
  if (prop.step !== undefined) c.step = prop.step;
  if (prop.maxLength !== undefined) c.maxLength = prop.maxLength;
  if (prop.values !== undefined) c.values = [...prop.values];
  if (prop.bounds !== undefined) {
    c.bounds = { min: [...prop.bounds.min], max: [...prop.bounds.max] };
  }
  return c;
}

function numberText(v: number): string {
  return Object.is(v, -0) ? '0' : String(v);
}

/** One-line type/default/constraint caption ("exposes defaults/types"). */
export function constraintTextFor(prop: DeclaredProperty): string {
  const parts: string[] = [prop.type];
  switch (prop.type) {
    case 'number': {
      const range =
        prop.min !== undefined && prop.max !== undefined
          ? `[${numberText(prop.min)}, ${numberText(prop.max)}]`
          : prop.min !== undefined
            ? `>= ${numberText(prop.min)}`
            : prop.max !== undefined
              ? `<= ${numberText(prop.max)}`
              : 'any finite';
      parts.push(range);
      if (prop.step !== undefined) parts.push(`step ${numberText(prop.step)}`);
      break;
    }
    case 'string':
      parts.push(`max ${prop.maxLength ?? DEFAULT_STRING_MAX_LENGTH} chars`);
      break;
    case 'enum':
      parts.push(`one of: ${(prop.values ?? []).join(', ') || '—'}`);
      break;
    case 'vec3': {
      parts.push(
        prop.bounds
          ? `bounds [${prop.bounds.min.join(', ')}] … [${prop.bounds.max.join(', ')}]`
          : 'three finite numbers',
      );
      break;
    }
    case 'entityRef':
      parts.push('scene entity id or null');
      break;
    case 'assetRef':
      parts.push('catalog assetId or null');
      break;
    default:
      break;
  }
  parts.push(`default ${formatPropertyValue(prop.default)}`);
  return parts.join(' · ');
}

/** Render a value for a read-only display / form seed. */
export function formatPropertyValue(value: PropertyValue | unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'number' ? numberText(v) : String(v))).join(', ');
  return String(value);
}

/**
 * Derive one control per public declared property, in declaration order
 * (phase 15.4: private properties are not shown per object). When a key is
 * absent the declaration default is used — that is the same default the
 * backend materializes.
 */
export function derivePropertyControls(
  declaration: PropertyDeclaration | null | undefined,
  values: StoredValues | null | undefined,
): PropertyControl[] {
  if (declaration === null || declaration === undefined) return [];
  const controls: PropertyControl[] = [];
  for (const prop of declaration.properties) {
    if (isPrivateProperty(prop)) continue;
    const stored = own(values, prop.key);
    const current = (stored.present && stored.value !== undefined ? stored.value : prop.default) as PropertyValue;
    controls.push({
      key: prop.key,
      label: prop.label,
      type: prop.type,
      default: prop.default,
      current,
      modified: !sameValue(current, prop.default),
      constraints: constraintsOf(prop),
      constraintText: constraintTextFor(prop),
      error: validatePropertyValue(prop, current),
      ...(prop.group !== undefined ? { group: prop.group } : {}),
      ...(prop.header !== undefined ? { header: prop.header } : {}),
      ...(prop.tooltip !== undefined ? { tooltip: prop.tooltip } : {}),
    });
  }
  return controls;
}

/** Structural (JSON) equality for the seven property value shapes. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || a === b;
  return a === b;
}

// ---- input parsing (invalid numeric/reference input is rejected) -------------

export interface ReferenceContext {
  /** Existing scene entity IDs (an `entityRef` must resolve to one). */
  entityIds?: readonly string[];
  /** Catalog asset IDs (an `assetRef` must resolve to one). */
  assetIds?: readonly string[];
}

export type ParseControlResult =
  | { ok: true; value: PropertyValue }
  | { ok: false; error: ControlError };

/**
 * Parse the UI's textual input into a typed declared value. This is the
 * editor-side preflight for invalid numeric/reference input; the command
 * layer re-validates authoritatively (the backend is the sole authority).
 */
export function parseControlInput(
  control: Pick<PropertyControl, 'key' | 'label' | 'type' | 'constraints'>,
  raw: string,
  refs: ReferenceContext = {},
): ParseControlResult {
  const label = control.label || control.key;
  const path = `/args/values/${control.key}`;
  const fail = (error: ControlError): ParseControlResult => ({ ok: false, error: { path, ...error } });
  switch (control.type) {
    case 'number': {
      const text = raw.trim();
      if (text === '') return fail({ code: 'property_type', message: `${label} needs a number`, expected: 'finite number', found: raw });
      const n = Number(text);
      if (!Number.isFinite(n)) return fail({ code: 'property_type', message: `${label} is not a finite number`, expected: 'finite number', found: raw });
      const { min, max } = control.constraints;
      if (min !== undefined && n < min) return fail({ code: 'property_value', message: `${label} must be >= ${numberText(min)}`, expected: `v >= ${min}`, found: n });
      if (max !== undefined && n > max) return fail({ code: 'property_value', message: `${label} must be <= ${numberText(max)}`, expected: `v <= ${max}`, found: n });
      return { ok: true, value: n };
    }
    case 'boolean': {
      const text = raw.trim().toLowerCase();
      if (text === 'true') return { ok: true, value: true };
      if (text === 'false') return { ok: true, value: false };
      return fail({ code: 'property_type', message: `${label} must be true or false`, expected: 'boolean', found: raw });
    }
    case 'string': {
      const maxLength = control.constraints.maxLength ?? DEFAULT_STRING_MAX_LENGTH;
      if ([...raw].length > maxLength) {
        return fail({ code: 'property_value', message: `${label} exceeds ${maxLength} characters`, expected: `length <= ${maxLength} code points`, found: raw });
      }
      if (hasControlChars(raw)) return fail({ code: 'property_value', message: `${label} contains a control character`, expected: 'no control characters', found: raw });
      return { ok: true, value: raw };
    }
    case 'enum': {
      const values = control.constraints.values ?? [];
      if (!values.includes(raw)) {
        return fail({ code: 'property_value', message: `${label} must be one of: ${values.join(', ')}`, expected: 'one of the declared enum members', found: raw });
      }
      return { ok: true, value: raw };
    }
    case 'vec3': {
      const parts = raw.split(/[\s,]+/).filter((p) => p !== '');
      if (parts.length !== 3) return fail({ code: 'property_type', message: `${label} needs three numbers`, expected: '[number, number, number]', found: raw });
      const nums = parts.map((p) => Number(p));
      if (!nums.every((n) => Number.isFinite(n))) {
        return fail({ code: 'property_type', message: `${label} has a non-finite component`, expected: 'finite numbers', found: raw });
      }
      const bounds = control.constraints.bounds;
      if (bounds) {
        for (let i = 0; i < 3; i += 1) {
          const n = nums[i] as number;
          if (n < (bounds.min[i] as number) || n > (bounds.max[i] as number)) {
            return fail({ code: 'property_value', message: `${label} is outside its bounds`, expected: 'component-wise within bounds', found: nums });
          }
        }
      }
      return { ok: true, value: [nums[0] as number, nums[1] as number, nums[2] as number] };
    }
    case 'entityRef':
    case 'assetRef': {
      const text = raw.trim();
      if (text === '') return { ok: true, value: null };
      if (!ID_SYNTAX.test(text)) {
        return fail({ code: 'property_type', message: `${label} is not an ID`, expected: 'an ID string or empty (null)', found: raw });
      }
      if (control.type === 'entityRef' && refs.entityIds && !refs.entityIds.includes(text)) {
        return fail({ code: 'reference_missing', message: `${label} names an entity that does not exist`, expected: 'an existing scene entity id', found: text });
      }
      if (control.type === 'assetRef' && refs.assetIds && !refs.assetIds.includes(text)) {
        return fail({ code: 'asset_reference_missing', message: `${label} names an asset that is not in the catalog`, expected: 'an existing assetId', found: text });
      }
      return { ok: true, value: text };
    }
    default:
      return fail({ code: 'property_type', message: `${label} has an unknown declared type`, expected: 'a known property type', found: control.type });
  }
}

// ---- the one typed command path for a property edit ---------------------------

export interface SetBehaviorPropertiesArgsView {
  entityId: string;
  /** `null` removes the behavior component (commands.md §8.9). */
  behaviorId: string | null;
  /** Present for an attach/update; absent when removing. */
  values?: Record<string, PropertyValue>;
}

export type PlanEditResult =
  | { ok: true; args: SetBehaviorPropertiesArgsView }
  | { ok: false; error: ControlError };

/**
 * Build the exact `setBehaviorProperties` args for one property edit
 * (commands.md §8.9). The **whole** declared values map is sent: omitted keys
 * take their declaration default, so a partial map would reset the other
 * properties. The changed key is the only value that differs.
 */
export function planSetBehaviorProperties(
  entityId: string,
  behaviorId: string,
  declaration: PropertyDeclaration,
  current: StoredValues | null | undefined,
  key: string,
  value: unknown,
): PlanEditResult {
  const prop = declaration.properties.find((p) => p.key === key);
  if (prop === undefined) {
    return {
      ok: false,
      error: {
        code: 'property_unknown',
        message: `"${key}" is not declared by ${behaviorId}`,
        path: `/args/values/${key}`,
        expected: `one of: ${declaration.properties.map((p) => p.key).join(', ')}`,
        found: key,
      },
    };
  }
  if (isPrivateProperty(prop)) {
    return {
      ok: false,
      error: { code: 'property_private', message: `"${key}" is private: objects cannot set it (the script reads its default)`, path: `/args/values/${key}`, found: key },
    };
  }
  const invalid = validatePropertyValue(prop, value);
  if (invalid) return { ok: false, error: { path: `/args/values/${key}`, ...invalid } };
  const values: Record<string, PropertyValue> = {};
  for (const p of declaration.properties) {
    // Phase 15.4: private properties are never sent (the backend refuses them).
    if (isPrivateProperty(p)) continue;
    const stored = own(current, p.key);
    const kept = stored.present && stored.value !== undefined ? (stored.value as PropertyValue) : p.default;
    values[p.key] = p.key === key ? (value as PropertyValue) : kept;
  }
  return { ok: true, args: { entityId, behaviorId, values } };
}

/** The one typed command that removes a behavior component (commands.md §8.9). */
export function planRemoveBehaviorProperties(entityId: string): SetBehaviorPropertiesArgsView {
  return { entityId, behaviorId: null };
}

// ---- contract component controls (collider / controller) ----------------------

export interface ComponentFieldView {
  path: string;
  label: string;
  type: string;
  value: string;
}

export interface ComponentControl {
  component: 'collider' | 'controller';
  label: string;
  /** Whether the selected entity currently carries the component. */
  present: boolean;
  fields: ComponentFieldView[];
  /** Whether an accepted M2 command can edit this component (always true now). */
  editable: boolean;
  /** Why editing is unavailable (bounded, actionable), else `null`. */
  unavailableReason: string | null;
  contractChangeRequest: string | null;
}

/**
 * `setComponent` (commands.md §8.10, C28-1 repair) owns `collider`/`controller`
 * too: `collider` supports add/edit/remove, `controller` supports add (the
 * field-less marker's value is exactly `{}`) and remove (`value: null`). The
 * controls below therefore build real typed commands; nothing is read-only.
 */
export const COMPONENT_EDIT_AVAILABLE =
  'setComponent supports collider/controller add, edit and remove (commands.md §8.10; C28-1 closed).';

export interface ComponentCarrier {
  collider?: ColliderComponent;
  controller?: unknown;
}

/** The bounded typed `setComponent` args this module plans (value `null` = remove). */
export interface SetComponentArgsView {
  entityId: string;
  component: 'collider' | 'controller';
  value: Record<string, unknown> | null;
}

/** Derive the physics-component controls; absent ones are add affordances. */
export function deriveComponentControls(
  components: ComponentCarrier | null | undefined,
  options: { includeAbsent?: boolean } = {},
): ComponentControl[] {
  const out: ComponentControl[] = [];
  const collider = components?.collider;
  if (collider) {
    out.push({
      component: 'collider',
      label: 'Collider',
      present: true,
      fields: colliderFields(collider),
      editable: true,
      unavailableReason: null,
      contractChangeRequest: null,
    });
  } else if (options.includeAbsent) {
    out.push({
      component: 'collider',
      label: 'Collider',
      present: false,
      fields: [],
      editable: true,
      unavailableReason: null,
      contractChangeRequest: null,
    });
  }
  const hasController = components !== null && components !== undefined && components.controller !== undefined;
  if (hasController) {
    out.push({
      component: 'controller',
      label: 'Controller',
      present: true,
      fields: [{ path: 'controller', label: 'marker', type: 'marker (no fields in M2)', value: 'present' }],
      editable: true,
      unavailableReason: null,
      contractChangeRequest: null,
    });
  } else if (options.includeAbsent) {
    out.push({
      component: 'controller',
      label: 'Controller',
      present: false,
      fields: [],
      editable: true,
      unavailableReason: null,
      contractChangeRequest: null,
    });
  }
  return out;
}

/** Plan a collider add/edit from a parsed shape (commands.md §8.10). */
export function planSetCollider(
  entityId: string,
  shape: ColliderComponent['shape'],
): SetComponentArgsView {
  return { entityId, component: 'collider', value: { shape } };
}

/** Parse one box-collider draft (`hx`/`hy`), returning a bounded error otherwise. */
export function parseColliderBox(
  hx: unknown,
  hy: unknown,
): { ok: true; shape: { type: 'box'; hx: number; hy: number } } | { ok: false; error: ControlError } {
  const parse = (v: unknown, path: string): number | ControlError => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 1e6) {
      return { code: 'collider_shape_invalid', message: `${path} must be a finite number 0 < v <= 1e6`, path, found: v };
    }
    return n;
  };
  const a = parse(hx, 'collider.shape.hx');
  if (typeof a !== 'number') return { ok: false, error: a };
  const b = parse(hy, 'collider.shape.hy');
  if (typeof b !== 'number') return { ok: false, error: b };
  return { ok: true, shape: { type: 'box', hx: a, hy: b } };
}

/** Parse a polygon-collider draft (JSON text): 3–8 `[x, y]` pairs, finite. */
export function parseColliderPolygon(
  raw: string,
): { ok: true; shape: { type: 'polygon'; vertices: [number, number][] } } | { ok: false; error: ControlError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: 'collider_shape_invalid', message: 'vertices must be valid JSON', path: 'collider.shape.vertices', found: raw } };
  }
  if (!Array.isArray(parsed) || parsed.length < 3 || parsed.length > 8) {
    return { ok: false, error: { code: 'collider_shape_invalid', message: 'vertices must be an array of 3-8 [x, y] pairs', path: 'collider.shape.vertices', found: parsed } };
  }
  const vertices: [number, number][] = [];
  for (const v of parsed) {
    if (
      !Array.isArray(v) ||
      v.length !== 2 ||
      typeof v[0] !== 'number' ||
      typeof v[1] !== 'number' ||
      !Number.isFinite(v[0]) ||
      !Number.isFinite(v[1])
    ) {
      return { ok: false, error: { code: 'collider_shape_invalid', message: 'each vertex must be a finite [x, y] pair', path: 'collider.shape.vertices', found: v } };
    }
    vertices.push([v[0], v[1]]);
  }
  return { ok: true, shape: { type: 'polygon', vertices } };
}

/** Plan adding the field-less controller marker (value is exactly `{}`). */
export function planAddController(entityId: string): SetComponentArgsView {
  return { entityId, component: 'controller', value: {} };
}

/** Plan removing a physics component (`value: null`, commands.md §8.10). */
export function planRemovePhysicsComponent(
  entityId: string,
  component: 'collider' | 'controller',
): SetComponentArgsView {
  return { entityId, component, value: null };
}

function colliderFields(collider: ColliderComponent): ComponentFieldView[] {
  const shape = collider.shape;
  if (shape.type === 'box') {
    return [
      { path: 'collider.shape.type', label: 'shape', type: '"box"', value: 'box' },
      { path: 'collider.shape.hx', label: 'hx', type: 'number (0, 1e6]', value: numberText(shape.hx) },
      { path: 'collider.shape.hy', label: 'hy', type: 'number (0, 1e6]', value: numberText(shape.hy) },
    ];
  }
  // Phase 23.1: the 3D shapes (a 3D project).
  if (shape.type === 'sphere') return [{ path: 'collider.shape.type', label: 'shape', type: '"sphere"', value: 'sphere' }, { path: 'collider.shape.radius', label: 'radius', type: 'number (0, 64]', value: numberText(shape.radius) }];
  if (shape.type === 'capsule') {
    return [
      { path: 'collider.shape.type', label: 'shape', type: '"capsule"', value: 'capsule' },
      { path: 'collider.shape.radius', label: 'radius', type: 'number (0, 64]', value: numberText(shape.radius) },
      { path: 'collider.shape.height', label: 'height', type: 'number >= 2 radius', value: numberText(shape.height) },
    ];
  }
  if (shape.type === 'convex') return [{ path: 'collider.shape.type', label: 'shape', type: '"convex"', value: 'convex' }, { path: 'collider.shape.points', label: 'points', type: '4–64 [x, y, z]', value: String(shape.points.length) }];
  if (shape.type === 'mesh') {
    return [
      { path: 'collider.shape.type', label: 'shape', type: '"mesh"', value: 'mesh' },
      { path: 'collider.shape.vertices', label: 'vertices', type: '3–1024 [x, y, z]', value: String(shape.vertices.length) },
      { path: 'collider.shape.triangles', label: 'triangles', type: '1–2048 [a, b, c]', value: String(shape.triangles.length) },
    ];
  }
  const fields: ComponentFieldView[] = [
    { path: 'collider.shape.type', label: 'shape', type: '"polygon"', value: 'polygon' },
    { path: 'collider.shape.vertices', label: 'vertices', type: '3–8 strict-convex', value: String(shape.vertices.length) },
  ];
  shape.vertices.forEach((v, i) => {
    fields.push({ path: `collider.shape.vertices/${i}`, label: `v${i}`, type: '[x, y]', value: `${numberText(v[0])}, ${numberText(v[1])}` });
  });
  return fields;
}

// ---- definition/entity → control derivation ----------------------------------

/** One definition entity's behavior component + recorded values. */
export interface BehaviorEntityView {
  localId: string;
  entityName: string;
  behaviorId: string;
  recordedValues: StoredValues;
}

export interface BehaviorControlsView {
  localId: string;
  entityName: string;
  behaviorId: string;
  /** The published declaration, or `null` when it does not resolve. */
  declaration: PropertyDeclaration | null;
  /** The definition's recorded values (the materialization source). */
  recordedValues: StoredValues;
  controls: PropertyControl[];
  error: ControlError | null;
}

/** Build the values/declaration view for one behavior-carrying entity. */
export function deriveBehaviorControls(
  entity: BehaviorEntityView,
  declarations: ReadonlyMap<string, PropertyDeclaration>,
): BehaviorControlsView {
  const declaration = declarations.get(entity.behaviorId) ?? null;
  if (declaration === null) {
    return {
      localId: entity.localId,
      entityName: entity.entityName,
      behaviorId: entity.behaviorId,
      declaration: null,
      recordedValues: entity.recordedValues,
      controls: [],
      error: {
        code: 'behavior_reference_missing',
        message: `no published declaration for ${entity.behaviorId}`,
        expected: 'a behaviorId in content.behaviors',
        found: entity.behaviorId,
      },
    };
  }
  return {
    localId: entity.localId,
    entityName: entity.entityName,
    behaviorId: entity.behaviorId,
    declaration,
    recordedValues: entity.recordedValues,
    controls: derivePropertyControls(declaration, entity.recordedValues),
    error: null,
  };
}

/** Every behavior-carrying entity of a definition, in definition document order. */
export function deriveOverrideTargets(
  definition: PrefabDefinition,
  declarations: ReadonlyMap<string, PropertyDeclaration>,
): BehaviorControlsView[] {
  const out: BehaviorControlsView[] = [];
  for (const entity of definition.entities) {
    const behavior = behaviorOf(entity);
    if (behavior === null) continue;
    out.push(
      deriveBehaviorControls(
        {
          localId: entity.localId,
          entityName: entity.name ?? entity.localId,
          behaviorId: behavior.behaviorId,
          recordedValues: behavior.values,
        },
        declarations,
      ),
    );
  }
  return out;
}

function behaviorOf(entity: PrefabEntity): BehaviorComponent | null {
  return entity.components.behavior ?? null;
}
