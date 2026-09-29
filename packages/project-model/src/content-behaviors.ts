/**
 * Behaviors of the content catalog: declared properties and their values,
 * source records, behavior records, the trust list, and their canonical form.
 */

import { canonicalGraphData, validateGraphData } from './graph';
import { GRAPH_KINDS } from './graph-kinds';
import { BEHAVIOR_FUNCTION_ID_RE, BEHAVIOR_GRAPH_LIMITS, behaviorGraphContext } from './behavior-graph';
import { validateLibraryPins } from './script-libraries';
import {
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isPlainObject,
  isValidName,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2 } from './errors';
import type { BehaviorRecord, BehaviorTrust, DeclaredProperty } from './types-v2';
import { ID_RE_V2, PROPERTY_KEY_RE } from './components';
import {
  BEHAVIOR_ENTRY_PATH,
  DECLARATION_STRING_LENGTH_DEFAULT,
  MAX_BEHAVIOR_FILES,
  MAX_BEHAVIOR_OUTPUT_BYTES,
  MAX_BEHAVIOR_SOURCE_BYTES,
  MAX_DECLARATION_BYTES,
  MAX_DECLARATION_STRING_LENGTH,
  MAX_ENUM_VALUES,
  MAX_OWNED_TRANSFORMS,
  MAX_PROPERTIES,
  MAX_TRUST_ENTRIES,
} from './content-limits';
import { canonicalDocBytes, DIGEST_RE, digestError, limitsError, sortedRecord } from './content-helpers';

const KNOWN_BEHAVIOR_FIELDS = new Set(['behaviorId', 'displayName', 'declaration', 'source', 'publishedRevision', 'graph', 'functions']);
const KNOWN_DECLARATION_FIELDS = new Set(['properties']);
const KNOWN_PROPERTY_FIELDS = new Set(['key', 'label', 'type', 'default', 'min', 'max', 'step', 'maxLength', 'values', 'bounds', 'visibility', 'group', 'header', 'tooltip']);
/** The optional presentation texts of a declared property and their length caps. */
const PROPERTY_TEXT_FIELDS = [['group', 64], ['header', 64], ['tooltip', 256]] as const;
const KNOWN_BOUNDS_FIELDS = new Set(['min', 'max']);
const KNOWN_SOURCE_FIELDS = new Set([
  'sourceDigest',
  'sourceByteLength',
  'entryPath',
  'fileCount',
  'manifestDigest',
  'outputDigest',
  'outputByteLength',
  'requiredModules',
  'ownedTransforms',
  'declaredInCode',
  'kind',
  'libraries',
  'publishedRevision',
]);
const KNOWN_TRUST_FIELDS = new Set(['entries']);
const KNOWN_TRUST_ENTRY_FIELDS = new Set(['sourceDigest', 'acknowledgedRevision']);
const PROPERTY_TYPES = new Set(['number', 'boolean', 'string', 'enum', 'vec3', 'entityRef', 'assetRef']);

// ---- declared properties and behaviors ---------------------

function checkPropertyValueShape(
  type: string,
  v: unknown,
  prop: Record<string, unknown>,
  path: string,
  errors: ModelErrorV2[],
): void {
  const failType = (expected: string): void => {
    errors.push(withFound({ code: 'property_type', path, message: `value must match declared type ${type}`, expected }, v));
  };
  const failValue = (expected: string): void => {
    errors.push(withFound({ code: 'property_value', path, message: `value violates the declared constraints of ${type}`, expected }, v));
  };
  switch (type) {
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return failType('finite number');
      const min = prop['min'];
      const max = prop['max'];
      if (typeof min === 'number' && v < min) return failValue(`v >= ${min}`);
      if (typeof max === 'number' && v > max) return failValue(`v <= ${max}`);
      return;
    }
    case 'boolean':
      if (typeof v !== 'boolean') failType('boolean');
      return;
    case 'string': {
      if (typeof v !== 'string') return failType('string');
      const maxLength = typeof prop['maxLength'] === 'number' ? prop['maxLength'] : DECLARATION_STRING_LENGTH_DEFAULT;
      if ([...v].length > maxLength) return failValue(`length <= ${maxLength} code points`);
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c <= 0x1f || c === 0x7f) return failValue('no control characters');
      }
      return;
    }
    case 'enum': {
      if (typeof v !== 'string') return failType('string enum member');
      const values = prop['values'];
      if (!Array.isArray(values) || !values.includes(v)) return failValue('one of the declared enum values');
      return;
    }
    case 'vec3': {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return failType('[number, number, number]');
      }
      const bounds = prop['bounds'];
      if (isPlainObject(bounds) && Array.isArray(bounds['min']) && Array.isArray(bounds['max'])) {
        for (let i = 0; i < 3; i++) {
          const n = v[i] as number;
          if (n < (bounds['min'][i] as number) || n > (bounds['max'][i] as number)) return failValue('component-wise within bounds');
        }
      }
      return;
    }
    case 'entityRef':
    case 'assetRef':
      if (v === null) return;
      if (typeof v !== 'string' || !ID_RE_V2.test(v)) return failType('an ID string or null');
      return;
    default:
      return failType('a known property type');
  }
}

/** No C0 control character or DEL (the declared text fields). */
function isControlFreeText(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

function validateDeclaredProperty(p: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(p)) {
    errors.push(fieldType(path, p, 'object'));
    return;
  }
  const key = p['key'];
  if (key === undefined) errors.push(fieldMissing(`${path}/key`, 'key'));
  else if (typeof key !== 'string') errors.push(fieldType(`${path}/key`, key, 'string'));
  else if (!PROPERTY_KEY_RE.test(key)) errors.push(fieldValue(`${path}/key`, key, '^[a-z][a-z0-9_]{0,63}$', 'property keys must match the declared key syntax'));

  const label = p['label'];
  if (label === undefined) errors.push(fieldMissing(`${path}/label`, 'label'));
  else if (typeof label !== 'string') errors.push(fieldType(`${path}/label`, label, 'string'));
  else if (label.length < 1 || label.length > 64) errors.push(fieldValue(`${path}/label`, label, 'string, 1-64 chars', 'property labels must be 1-64 characters'));

  const type = p['type'];
  if (type === undefined) errors.push(fieldMissing(`${path}/type`, 'type'));
  else if (typeof type !== 'string' || !PROPERTY_TYPES.has(type)) {
    errors.push(fieldValue(`${path}/type`, type, 'one of the seven M2 property types', 'property type must be one of the seven M2 types'));
  }
  if (p['default'] === undefined) errors.push(fieldMissing(`${path}/default`, 'default'));
  else checkPropertyValueShape(String(type), p['default'], p, `${path}/default`, errors);

  for (const field of ['min', 'max'] as const) {
    const v = p[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12)) {
      errors.push(fieldValue(`${path}/${field}`, v, 'finite number with |v| <= 1e12', `${field} must be a finite number with |v| <= 1e12`));
    }
  }
  if (typeof p['min'] === 'number' && typeof p['max'] === 'number' && (p['min'] as number) > (p['max'] as number)) {
    errors.push(fieldValue(`${path}/min`, p['min'], 'min <= max', 'property min must be <= max'));
  }
  const step = p['step'];
  if (step !== undefined && (typeof step !== 'number' || !Number.isFinite(step) || step <= 0 || step > 1e6)) {
    errors.push(fieldValue(`${path}/step`, step, 'number with 0 < v <= 1e6', 'property step must satisfy 0 < v <= 1e6'));
  }
  const maxLength = p['maxLength'];
  if (maxLength !== undefined && (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_DECLARATION_STRING_LENGTH)) {
    errors.push(fieldValue(`${path}/maxLength`, maxLength, `integer 1-${MAX_DECLARATION_STRING_LENGTH}`, `string maxLength must be an integer 1-${MAX_DECLARATION_STRING_LENGTH}`));
  }
  const values = p['values'];
  if (values !== undefined) {
    if (type !== 'enum') errors.push(fieldValue(`${path}/values`, values, 'only enum properties declare values', 'values is only valid for the enum type'));
    else if (!Array.isArray(values)) errors.push(fieldType(`${path}/values`, values, 'array'));
    else {
      if (values.length < 1 || values.length > MAX_ENUM_VALUES) {
        errors.push(limitsError(`${path}/values`, 'enum_values', values.length, MAX_ENUM_VALUES, `enum members must be 1-${MAX_ENUM_VALUES}`));
      }
      const seen = new Set<string>();
      for (let i = 0; i < values.length; i++) {
        const m = values[i];
        if (typeof m !== 'string' || m.length < 1 || m.length > 64) errors.push(fieldValue(`${path}/values/${i}`, m, 'string, 1-64 chars', 'enum members must be 1-64 characters'));
        else if (seen.has(m)) errors.push(fieldValue(`${path}/values/${i}`, m, 'unique enum members', 'enum members must be unique'));
        else seen.add(m);
      }
    }
  }
  const bounds = p['bounds'];
  if (bounds !== undefined) {
    if (type !== 'vec3') errors.push(fieldValue(`${path}/bounds`, bounds, 'only vec3 properties declare bounds', 'bounds is only valid for the vec3 type'));
    else if (!isPlainObject(bounds)) errors.push(fieldType(`${path}/bounds`, bounds, 'object'));
    else {
      const bmin = bounds['min'];
      const bmax = bounds['max'];
      const validVec = (x: unknown): x is [number, number, number] =>
        Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6);
      if (!validVec(bmin)) errors.push(fieldValue(`${path}/bounds/min`, bmin, 'finite [x, y, z] with |v| <= 1e6', 'bounds.min must be a finite triple with |v| <= 1e6'));
      if (!validVec(bmax)) errors.push(fieldValue(`${path}/bounds/max`, bmax, 'finite [x, y, z] with |v| <= 1e6', 'bounds.max must be a finite triple with |v| <= 1e6'));
      if (validVec(bmin) && validVec(bmax)) {
        for (let i = 0; i < 3; i++) {
          if ((bmin[i] as number) > (bmax[i] as number)) errors.push(fieldValue(`${path}/bounds`, bounds, 'component-wise min <= max', 'bounds must satisfy component-wise min <= max'));
        }
      }
      for (const k of Object.keys(bounds)) {
        if (!KNOWN_BOUNDS_FIELDS.has(k)) errors.push(unexpectedField(`${path}/bounds/${pointerSegment(k)}`, k, 'min, max'));
      }
    }
  }
  // Visibility (absent = public) and the Inspector texts.
  const visibility = p['visibility'];
  if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') {
    errors.push(fieldValue(`${path}/visibility`, visibility, '"public" or "private"', 'property visibility must be "public" or "private"'));
  }
  for (const [field, max] of PROPERTY_TEXT_FIELDS) {
    const v = p[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') errors.push(fieldType(`${path}/${field}`, v, 'string'));
    else if (v.length < 1 || v.length > max || !isControlFreeText(v)) {
      errors.push(fieldValue(`${path}/${field}`, v, `string, 1-${max} chars, no control characters`, `property ${field} must be 1-${max} characters without control characters`));
    }
  }
  for (const k of Object.keys(p)) {
    if (!KNOWN_PROPERTY_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_PROPERTY_FIELDS].join(', ')));
  }
}

function validateBehaviorSource(s: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(s)) {
    errors.push(fieldType(path, s, 'object or null'));
    return;
  }
  for (const [field, max] of [
    ['sourceDigest', 0],
    ['manifestDigest', 0],
    ['outputDigest', 0],
  ] as const) {
    const v = s[field];
    if (v === undefined) errors.push(fieldMissing(`${path}/${field}`, field));
    else if (typeof v !== 'string') errors.push(fieldType(`${path}/${field}`, v, 'string'));
    else if (!DIGEST_RE.test(v)) errors.push(digestError(`${path}/${field}`, v));
    void max;
  }
  const sourceLen = s['sourceByteLength'];
  if (sourceLen !== undefined && (typeof sourceLen !== 'number' || !Number.isInteger(sourceLen) || sourceLen < 1 || sourceLen > MAX_BEHAVIOR_SOURCE_BYTES)) {
    errors.push(limitsError(`${path}/sourceByteLength`, 'graph_bytes', Number(sourceLen), MAX_BEHAVIOR_SOURCE_BYTES, `sourceByteLength must be an integer in [1, ${MAX_BEHAVIOR_SOURCE_BYTES}]`));
  } else if (sourceLen === undefined) errors.push(fieldMissing(`${path}/sourceByteLength`, 'sourceByteLength'));

  if (s['entryPath'] !== BEHAVIOR_ENTRY_PATH) {
    errors.push(fieldValue(`${path}/entryPath`, s['entryPath'], `"${BEHAVIOR_ENTRY_PATH}"`, `a stored source record entryPath is exactly "${BEHAVIOR_ENTRY_PATH}"`));
  }
  const fileCount = s['fileCount'];
  if (fileCount === undefined) errors.push(fieldMissing(`${path}/fileCount`, 'fileCount'));
  else if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 1 || fileCount > MAX_BEHAVIOR_FILES) {
    errors.push(limitsError(`${path}/fileCount`, 'files', Number(fileCount), MAX_BEHAVIOR_FILES, `fileCount must be an integer in [1, ${MAX_BEHAVIOR_FILES}]`));
  }
  const outputLen = s['outputByteLength'];
  if (outputLen === undefined) errors.push(fieldMissing(`${path}/outputByteLength`, 'outputByteLength'));
  else if (typeof outputLen !== 'number' || !Number.isInteger(outputLen) || outputLen < 1 || outputLen > MAX_BEHAVIOR_OUTPUT_BYTES) {
    errors.push(limitsError(`${path}/outputByteLength`, 'output_bytes', Number(outputLen), MAX_BEHAVIOR_OUTPUT_BYTES, `outputByteLength must be an integer in [1, ${MAX_BEHAVIOR_OUTPUT_BYTES}]`));
  }
  const modules = s['requiredModules'];
  if (modules === undefined) errors.push(fieldMissing(`${path}/requiredModules`, 'requiredModules'));
  else if (!Array.isArray(modules)) errors.push(fieldType(`${path}/requiredModules`, modules, 'array'));
  else {
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      if (typeof m !== 'string') errors.push(fieldType(`${path}/requiredModules/${i}`, m, 'string'));
      else if (i > 0 && typeof modules[i - 1] === 'string' && (modules[i - 1] as string) >= m) {
        errors.push(fieldValue(`${path}/requiredModules/${i}`, m, 'ascending unique module ids', 'requiredModules must be ascending and unique'));
      }
    }
  }
  const owned = s['ownedTransforms'];
  if (owned !== undefined) {
    // Entity ids or "@self", ascending, unique, 1..16 (the container's rules).
    if (!Array.isArray(owned) || owned.length < 1 || owned.length > MAX_OWNED_TRANSFORMS) errors.push(fieldValue(`${path}/ownedTransforms`, owned, `1-${MAX_OWNED_TRANSFORMS} entity ids or "@self"`, `ownedTransforms is absent or lists 1-${MAX_OWNED_TRANSFORMS} entries`));
    else {
      owned.forEach((id, i) => {
        if (typeof id !== 'string' || (id !== '@self' && !ID_RE_V2.test(id))) errors.push(fieldValue(`${path}/ownedTransforms/${i}`, id, 'an entity id or "@self"', 'an owned transform names an entity id or "@self"'));
        else if (i > 0 && typeof owned[i - 1] === 'string' && (owned[i - 1] as string) >= id) errors.push(fieldValue(`${path}/ownedTransforms/${i}`, id, 'ascending unique entries', 'ownedTransforms must be ascending and unique'));
      });
    }
  }
  // Present only as `true` (the declaration was derived from the code).
  if (s['declaredInCode'] !== undefined && s['declaredInCode'] !== true) {
    errors.push(fieldValue(`${path}/declaredInCode`, s['declaredInCode'], 'true or absent', 'declaredInCode is absent or true'));
  }
  // Present only as "graph" (generated from the behavior's visual script).
  if (s['kind'] !== undefined && s['kind'] !== 'graph') {
    errors.push(fieldValue(`${path}/kind`, s['kind'], '"graph" or absent', 'a source kind is "graph" or absent (TypeScript)'));
  }
  // The script library versions the source was compiled against (absent = none).
  if (s['libraries'] !== undefined) validateLibraryPins(s['libraries'], `${path}/libraries`, errors);
  const published = s['publishedRevision'];
  if (published === undefined) errors.push(fieldMissing(`${path}/publishedRevision`, 'publishedRevision'));
  else if (typeof published !== 'number' || !Number.isInteger(published) || published < 0) {
    // A stored source record written by the preparation path carries the
    // revision it landed at (`>= 1`), while a project copy resets it to `0`
    // for the new project identity. A document cannot tell the two provenances apart,
    // so the load bound is the union: `>= 0`. The preparation/publication
    // command still writes `>= 1`.
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/publishedRevision`, message: 'a source record publishedRevision must be an integer >= 0', expected: 'integer >= 0' }, published));
  }
  for (const k of Object.keys(s)) {
    if (!KNOWN_SOURCE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_SOURCE_FIELDS].join(', ')));
  }
}

export function validateBehaviorRecord(b: unknown, path: string, errors: ModelErrorV2[], version = 2, graphs?: unknown): void {
  if (!isPlainObject(b)) {
    errors.push(fieldType(path, b, 'object'));
    return;
  }
  const behaviorId = b['behaviorId'];
  if (behaviorId === undefined) errors.push(fieldMissing(`${path}/behaviorId`, 'behaviorId'));
  else if (typeof behaviorId !== 'string') errors.push(fieldType(`${path}/behaviorId`, behaviorId, 'string'));
  else if (!ID_RE_V2.test(behaviorId)) errors.push(idInvalid(`${path}/behaviorId`, behaviorId));

  const displayName = b['displayName'];
  if (displayName === undefined) errors.push(fieldMissing(`${path}/displayName`, 'displayName'));
  else if (typeof displayName !== 'string') errors.push(fieldType(`${path}/displayName`, displayName, 'string'));
  else if (!isValidName(displayName)) errors.push(fieldValue(`${path}/displayName`, displayName, 'string, 1-128 chars, no control characters', 'behavior displayName must be 1-128 characters without control characters'));

  const declaration = b['declaration'];
  if (declaration === undefined) errors.push(fieldMissing(`${path}/declaration`, 'declaration'));
  else if (!isPlainObject(declaration)) errors.push(fieldType(`${path}/declaration`, declaration, 'object'));
  else {
    const props = declaration['properties'];
    if (props === undefined) errors.push(fieldMissing(`${path}/declaration/properties`, 'properties'));
    else if (!Array.isArray(props)) errors.push(fieldType(`${path}/declaration/properties`, props, 'array'));
    else {
      // 0–32 (a script may declare no property).
      if (props.length > MAX_PROPERTIES) {
        errors.push(limitsError(`${path}/declaration/properties`, 'properties', props.length, MAX_PROPERTIES, `a declaration has at most ${MAX_PROPERTIES} properties`));
      }
      const seen = new Set<string>();
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        validateDeclaredProperty(p, `${path}/declaration/properties/${i}`, errors);
        if (isPlainObject(p) && typeof p['key'] === 'string') {
          if (seen.has(p['key'])) {
            errors.push(withFound({ code: 'id_duplicate', path: `${path}/declaration/properties/${i}/key`, message: 'property key is already declared (first occurrence wins)', expected: 'a unique key' }, p['key']));
          } else seen.add(p['key']);
        }
      }
      if (canonicalDocBytes(declaration) > MAX_DECLARATION_BYTES) {
        errors.push(limitsError(`${path}/declaration`, 'declaration_bytes', canonicalDocBytes(declaration), MAX_DECLARATION_BYTES, 'canonical declaration exceeds the byte cap'));
      }
    }
    for (const k of Object.keys(declaration)) {
      if (!KNOWN_DECLARATION_FIELDS.has(k)) errors.push(unexpectedField(`${path}/declaration/${pointerSegment(k)}`, k, 'properties'));
    }
  }

  const source = b['source'];
  if (source === undefined) errors.push(fieldMissing(`${path}/source`, 'source'));
  else if (source !== null) validateBehaviorSource(source, `${path}/source`, errors);

  const published = b['publishedRevision'];
  if (published === undefined) errors.push(fieldMissing(`${path}/publishedRevision`, 'publishedRevision'));
  else if (typeof published !== 'number' || !Number.isInteger(published) || published < 0 || published > Number.MAX_SAFE_INTEGER) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/publishedRevision`, message: 'publishedRevision must be an integer in [0, 2^53-1]', expected: 'integer in [0, 2^53-1]' }, published));
  }
  // v4: the visual script graph and its functions (calls resolve against
  // them and the project's shared functions).
  const graph = b['graph'];
  const functions = b['functions'];
  if (graph !== undefined) {
    if (version !== 4) errors.push(unexpectedField(`${path}/graph`, 'graph', 'a visual script graph needs a v4 project'));
    else validateGraphData(GRAPH_KINDS['behavior']!, graph, `${path}/graph`, errors, behaviorGraphContext(graph, { functions, graphs }));
  }
  if (functions !== undefined) {
    if (graph === undefined || version !== 4) errors.push(unexpectedField(`${path}/functions`, 'functions', 'functions belong to a visual script (a behavior with a graph)'));
    else if (!Array.isArray(functions) || functions.length > BEHAVIOR_GRAPH_LIMITS.functions) {
      errors.push(fieldValue(`${path}/functions`, functions, `a list of at most ${BEHAVIOR_GRAPH_LIMITS.functions} functions`, 'functions is a short list'));
    } else {
      const ids = new Set<string>();
      functions.forEach((f, i) => {
        const fp = `${path}/functions/${i}`;
        if (!isPlainObject(f)) return errors.push(fieldType(fp, f, 'object'));
        for (const k of Object.keys(f)) if (k !== 'functionId' && k !== 'graph') errors.push(unexpectedField(`${fp}/${pointerSegment(k)}`, k, 'functionId, graph'));
        const id = f['functionId'];
        if (typeof id !== 'string' || !BEHAVIOR_FUNCTION_ID_RE.test(id)) errors.push(fieldValue(`${fp}/functionId`, id, 'an id (a-z, 0-9, _ and -)', 'a function id is an id'));
        else if (ids.has(id)) errors.push(withFound({ code: 'id_duplicate', path: `${fp}/functionId`, message: 'function ids are unique in a script', expected: 'a unique functionId' }, id));
        else ids.add(id);
        const g = f['graph'];
        validateGraphData(GRAPH_KINDS['behavior-function']!, g, `${fp}/graph`, errors, behaviorGraphContext(g, { functions, graphs, script: graph }));
        if (isPlainObject(g) && Array.isArray(g['nodes']) && g['nodes'].length === 0) errors.push(fieldValue(`${fp}/graph/nodes`, [], 'at least one node', 'a function without nodes does not exist (it is removed)'));
      });
    }
  }
  for (const k of Object.keys(b)) {
    if (!KNOWN_BEHAVIOR_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_BEHAVIOR_FIELDS].join(', ')));
  }
}

// ---- trust ------------------------------------------------------------

export function validateTrust(trust: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(trust)) {
    errors.push(fieldType(path, trust, 'object'));
    return;
  }
  const entries = trust['entries'];
  if (entries === undefined) errors.push(fieldMissing(`${path}/entries`, 'entries'));
  else if (!Array.isArray(entries)) errors.push(fieldType(`${path}/entries`, entries, 'array'));
  else {
    if (entries.length > MAX_TRUST_ENTRIES) {
      errors.push(limitsError(`${path}/entries`, 'trust_entries', entries.length, MAX_TRUST_ENTRIES, `behaviorTrust may hold at most ${MAX_TRUST_ENTRIES} entries`));
    }
    let prev: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const epath = `${path}/entries/${i}`;
      if (!isPlainObject(e)) {
        errors.push(fieldType(epath, e, 'object'));
        continue;
      }
      const digest = e['sourceDigest'];
      if (digest === undefined) errors.push(fieldMissing(`${epath}/sourceDigest`, 'sourceDigest'));
      else if (typeof digest !== 'string') errors.push(fieldType(`${epath}/sourceDigest`, digest, 'string'));
      else if (!DIGEST_RE.test(digest)) errors.push(digestError(`${epath}/sourceDigest`, digest));
      else {
        if (seen.has(digest)) errors.push(withFound({ code: 'id_duplicate', path: `${epath}/sourceDigest`, message: 'trust entries must be unique by sourceDigest', expected: 'unique ascending sourceDigest' }, digest));
        seen.add(digest);
        if (prev !== null && digest <= prev) {
          errors.push(withFound({ code: 'digest_invalid', path: `${epath}/sourceDigest`, message: 'trust entries must be ascending by sourceDigest', expected: 'ascending sourceDigest' }, digest));
        }
        prev = digest;
      }
      const rev = e['acknowledgedRevision'];
      if (rev === undefined) errors.push(fieldMissing(`${epath}/acknowledgedRevision`, 'acknowledgedRevision'));
      else if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || rev > Number.MAX_SAFE_INTEGER) {
        errors.push(withFound({ code: 'number_out_of_range', path: `${epath}/acknowledgedRevision`, message: 'acknowledgedRevision must be an integer >= 0', expected: 'integer >= 0' }, rev));
      }
      for (const k of Object.keys(e)) {
        if (!KNOWN_TRUST_ENTRY_FIELDS.has(k)) errors.push(unexpectedField(`${epath}/${pointerSegment(k)}`, k, 'sourceDigest, acknowledgedRevision'));
      }
    }
  }
  for (const k of Object.keys(trust)) {
    if (!KNOWN_TRUST_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'entries'));
  }
}

function canonicalProperty(p: DeclaredProperty): DeclaredProperty {
  const out: DeclaredProperty = {
    key: p.key,
    label: p.label,
    type: p.type,
    default: Array.isArray(p.default) ? [p.default[0], p.default[1], p.default[2]] : p.default,
  };
  if (p.min !== undefined) out.min = p.min;
  if (p.max !== undefined) out.max = p.max;
  if (p.step !== undefined) out.step = p.step;
  if (p.maxLength !== undefined) out.maxLength = p.maxLength;
  if (p.values !== undefined) out.values = [...p.values];
  if (p.bounds !== undefined) out.bounds = { min: [...p.bounds.min], max: [...p.bounds.max] };
  // Public is the default and is omitted (older declarations stay byte-identical).
  if (p.visibility === 'private') out.visibility = 'private';
  if (p.group !== undefined) out.group = p.group;
  if (p.header !== undefined) out.header = p.header;
  if (p.tooltip !== undefined) out.tooltip = p.tooltip;
  return out;
}

export function canonicalBehavior(b: BehaviorRecord): BehaviorRecord {
  return {
    behaviorId: b.behaviorId,
    displayName: b.displayName,
    declaration: { properties: b.declaration.properties.map(canonicalProperty) },
    source:
      b.source === null
        ? null
        : {
            sourceDigest: b.source.sourceDigest,
            sourceByteLength: b.source.sourceByteLength,
            entryPath: b.source.entryPath,
            fileCount: b.source.fileCount,
            manifestDigest: b.source.manifestDigest,
            outputDigest: b.source.outputDigest,
            outputByteLength: b.source.outputByteLength,
            requiredModules: [...b.source.requiredModules],
            ...(b.source.ownedTransforms !== undefined && b.source.ownedTransforms.length > 0 ? { ownedTransforms: [...b.source.ownedTransforms] } : {}),
            ...(b.source.declaredInCode === true ? { declaredInCode: true as const } : {}),
            ...(b.source.kind === 'graph' ? { kind: 'graph' as const } : {}),
            // Present only for a source that imports script libraries.
            ...(b.source.libraries !== undefined && b.source.libraries.length > 0 ? { libraries: b.source.libraries.map((p) => ({ libraryId: p.libraryId, sourceDigest: p.sourceDigest })) } : {}),
            publishedRevision: b.source.publishedRevision,
          },
    publishedRevision: b.publishedRevision,
    // The visual script (absent for other behaviors: older records stay byte-identical).
    ...(b.graph !== undefined ? { graph: canonicalGraphData(b.graph) } : {}),
    // Its functions (sorted by id; absent when there are none).
    ...(b.functions !== undefined && b.functions.length > 0
      ? { functions: [...b.functions].sort((x, y) => (x.functionId < y.functionId ? -1 : x.functionId > y.functionId ? 1 : 0)).map((f) => ({ functionId: f.functionId, graph: canonicalGraphData(f.graph) })) }
      : {}),
  };
}

export function canonicalTrust(t: BehaviorTrust): BehaviorTrust {
  return {
    entries: sortedRecord(t.entries, (e) => e.sourceDigest).map((e) => ({
      sourceDigest: e.sourceDigest,
      acknowledgedRevision: e.acknowledgedRevision,
    })),
  };
}