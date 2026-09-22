/**
 * Strict `args` schema validation for the prefab M2 mutation ops
 * (commands.md §3.1.2/§3.1.3, §8.6–§8.7) — packet 22.
 *
 * Same conventions as the M1 / packet-21 args passes: unknown fields ⇒
 * `field_unexpected`; missing ⇒ `field_missing`; wrong JSON type ⇒
 * `field_type`; right type / wrong value ⇒ `field_value`. Structural checks
 * live here; the model remains the authority for document value rules, so
 * transform numbers and behavior values are re-checked by the resulting-state
 * validation (step 5) unless the contract names an op-level error.
 *
 * Op-level precondition order (existence, reference resolution, forbidden
 * capture contents, overrides) is owned by the op implementations
 * (`prefab-ops.ts`): commands.md §6.1 step 4 checks the revision BEFORE any
 * argument validation.
 */

import {
  fieldMissing,
  fieldType,
  fieldUnexpected,
  fieldValue,
  isPlainObject,
  limitsExceeded,
} from './errors';
import type {
  CommandError,
  CreatePrefabArgs,
  InstantiatePrefabArgs,
  PartialTransformArgs,
  PropertyOverride,
} from './types';

export interface PrefabArgsOk<T> {
  ok: true;
  args: T;
}

/** §20.3/§20.7: at most 64 overrides per instantiation request. */
export const MAX_OVERRIDES = 64;

const TRANSFORM_FIELDS = ['position', 'rotation', 'scale'] as const;

function validateTransform(
  value: unknown,
  path: string,
): PartialTransformArgs | { error: CommandError } {
  if (!isPlainObject(value)) {
    return { error: fieldType(path, value, 'object with optional position, rotation, scale') };
  }
  for (const key of Object.keys(value)) {
    if (!(TRANSFORM_FIELDS as readonly string[]).includes(key)) {
      return {
        error: fieldUnexpected(`${path}/${key}`, key, 'position, rotation, scale'),
      };
    }
  }
  const out: PartialTransformArgs = {};
  for (const f of TRANSFORM_FIELDS) {
    const v = value[f];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      return {
        error: fieldType(
          `${path}/${f}`,
          v,
          f === 'rotation' ? 'array of 4 finite numbers' : 'array of 3 finite numbers',
        ),
      };
    }
    // Element values (finiteness, ranges, quaternion norm) are checked by the
    // project-model validation of the resulting scene (commands.md §3.1).
    if (f === 'position') out.position = v.slice() as readonly number[];
    else if (f === 'rotation') out.rotation = v.slice() as readonly number[];
    else out.scale = v.slice() as readonly number[];
  }
  return out;
}

/** §3.1.2/§8.6.1 `createPrefab` args. */
export function validateCreatePrefabArgs(
  args: Record<string, unknown>,
): PrefabArgsOk<CreatePrefabArgs> | { ok: false; error: CommandError } {
  const KNOWN = 'prefabId, displayName, sourceEntityId';
  for (const key of Object.keys(args)) {
    if (!['prefabId', 'displayName', 'sourceEntityId'].includes(key)) {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, KNOWN) };
    }
  }
  if (args['prefabId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/prefabId', 'prefabId') };
  }
  if (typeof args['prefabId'] !== 'string') {
    return { ok: false, error: fieldType('/args/prefabId', args['prefabId'], 'string (prefab ID)') };
  }
  if (args['displayName'] === undefined) {
    return { ok: false, error: fieldMissing('/args/displayName', 'displayName') };
  }
  if (typeof args['displayName'] !== 'string') {
    return { ok: false, error: fieldType('/args/displayName', args['displayName'], 'string') };
  }
  if (args['sourceEntityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/sourceEntityId', 'sourceEntityId') };
  }
  if (typeof args['sourceEntityId'] !== 'string') {
    return {
      ok: false,
      error: fieldType('/args/sourceEntityId', args['sourceEntityId'], 'string (entity ID)'),
    };
  }
  return {
    ok: true,
    args: {
      prefabId: args['prefabId'],
      displayName: args['displayName'],
      sourceEntityId: args['sourceEntityId'],
    },
  };
}

/** §3.1.3/§8.7.1 `instantiatePrefab` args (overrides ≤ 64, pairs unique). */
export function validateInstantiatePrefabArgs(
  args: Record<string, unknown>,
): PrefabArgsOk<InstantiatePrefabArgs> | { ok: false; error: CommandError } {
  const KNOWN = 'prefabId, parentId (optional), transform (optional), overrides (optional)';
  for (const key of Object.keys(args)) {
    if (!['prefabId', 'parentId', 'transform', 'overrides'].includes(key)) {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, KNOWN) };
    }
  }
  if (args['prefabId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/prefabId', 'prefabId') };
  }
  if (typeof args['prefabId'] !== 'string') {
    return { ok: false, error: fieldType('/args/prefabId', args['prefabId'], 'string (prefab ID)') };
  }
  const out: InstantiatePrefabArgs = { prefabId: args['prefabId'] };
  if (args['parentId'] !== undefined) {
    const parentId = args['parentId'];
    if (parentId !== null && typeof parentId !== 'string') {
      return {
        ok: false,
        error: fieldType('/args/parentId', parentId, 'existing entity ID or null'),
      };
    }
    out.parentId = parentId as string | null;
  }
  if (args['transform'] !== undefined) {
    const t = validateTransform(args['transform'], '/args/transform');
    if ('error' in t) return { ok: false, error: t.error };
    out.transform = t;
  }
  if (args['overrides'] !== undefined) {
    const raw = args['overrides'];
    if (!Array.isArray(raw)) {
      return { ok: false, error: fieldType('/args/overrides', raw, 'array of { localId, key, value }') };
    }
    if (raw.length > MAX_OVERRIDES) {
      return {
        ok: false,
        error: limitsExceeded('overrides', raw.length, MAX_OVERRIDES),
      };
    }
    const overrides: PropertyOverride[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
      const path = `/args/overrides/${i}`;
      const o = raw[i];
      if (!isPlainObject(o)) {
        return { ok: false, error: fieldType(path, o, 'object { localId, key, value }') };
      }
      for (const key of Object.keys(o)) {
        if (!['localId', 'key', 'value'].includes(key)) {
          return { ok: false, error: fieldUnexpected(`${path}/${key}`, key, 'localId, key, value') };
        }
      }
      if (o['localId'] === undefined) {
        return { ok: false, error: fieldMissing(`${path}/localId`, 'localId') };
      }
      if (typeof o['localId'] !== 'string') {
        return { ok: false, error: fieldType(`${path}/localId`, o['localId'], 'string (localId)') };
      }
      if (o['key'] === undefined) {
        return { ok: false, error: fieldMissing(`${path}/key`, 'key') };
      }
      if (typeof o['key'] !== 'string') {
        return { ok: false, error: fieldType(`${path}/key`, o['key'], 'string (declared key)') };
      }
      if (!Object.prototype.hasOwnProperty.call(o, 'value')) {
        return { ok: false, error: fieldMissing(`${path}/value`, 'value') };
      }
      const pair = `${o['localId']}\u0000${o['key']}`;
      if (seen.has(pair)) {
        return {
          ok: false,
          error: fieldValue(
            `${path}/key`,
            o['key'],
            'a unique (localId, key) pair',
            'an override may address each (localId, key) pair at most once',
          ),
        };
      }
      seen.add(pair);
      overrides.push({
        localId: o['localId'],
        key: o['key'],
        value: o['value'] as PropertyOverride['value'],
      });
    }
    out.overrides = overrides;
  }
  return { ok: true, args: out };
}
