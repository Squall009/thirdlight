/**
 * Prefab capture/instantiation planning (packet 28; commands.md §8.6–§8.7,
 * project-model §20.1–§20.3).
 *
 * Prefab copies, never links: `createPrefab` captures one immutable definition
 * from a **selected subtree** and `instantiatePrefab` materializes independent
 * scene entities. This module only *plans* those typed commands and preflights
 * them against the projection so the UI can surface the contract's actionable
 * errors before a round trip; the workspace remains the sole executor and the
 * only authority. There is deliberately no `updatePrefab`, no variant, no
 * apply/revert and no propagation — definitions are immutable in M2
 * (project-model §20.1.2) and a definition change never rewrites a copy
 * (§20.1.4).
 *
 * Normative rules implemented here:
 *
 *  - capture rejects the scene camera, a nested copy and an external
 *    `entityRef` atomically (commands.md §8.6.3) and enforces the
 *    `prefab_entities`/`prefab_depth`/`prefabs` limits (§20.3);
 *  - instantiation accepts only the contract's three configurables — the root
 *    parent, the root's partial transform and declared-property overrides —
 *    and enforces `overrides`/`entities`/`depth` limits and override legality
 *    against the definition's **recorded values** and the **published
 *    declarations** (§8.7.3/§8.7.5);
 *  - a stale revision is recovered by re-reading and re-issuing with a fresh
 *    `requestId`; a backend-rejected instance limit is surfaced (never
 *    swallowed) with its `limit`/`current`/`max` (commands.md §5.5/§6.4).
 *
 * Pure: no DOM, no I/O, no Node builtins, no code evaluation.
 */

import type {
  PrefabDefinition,
  PropertyDeclaration,
  PropertyValue,
} from '@thirdlight/project-model';
import {
  ID_SYNTAX,
  parseControlInput,
  validatePropertyValue,
  type BehaviorControlsView,
  type ControlError,
  type ReferenceContext,
  type StoredValues,
} from './property-controls';

// ---- limits (project-model §20.3 / commands.md §5.4 / project-model §10.4) ----

export const MAX_PREFABS = 128;
export const MAX_PREFAB_ENTITIES = 256;
export const MAX_PREFAB_DEPTH = 16;
export const MAX_OVERRIDES = 64;
export const MAX_SCENE_ENTITIES = 1024;
export const MAX_SCENE_DEPTH = 32;
export const MAX_DISPLAY_NAME = 128;

/** A bounded, actionable planning error (the contract's code vocabulary). */
export type PlanError = ControlError & Record<string, unknown>;

export type PlanResult<T> = { ok: true } & T | { ok: false; error: PlanError };

// ---- shared view shapes -------------------------------------------------------

/** One projected scene entity as the capture preflight consumes it. */
export interface CaptureEntityView {
  id: string;
  parentId: string | null;
  /** `components.camera` present. */
  camera: boolean;
  /** `components.prefab` provenance, when the entity is a materialized copy. */
  prefab: { prefabId: string; localId: string } | null;
  /** `components.behavior`, when present. */
  behavior: { behaviorId: string; values: StoredValues } | null;
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

/** A caller-generated, contract-syntax prefab id (`prefab-` + 16 hex). */
export function makePrefabId(rng: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += Math.floor(rng() * 16).toString(16);
  }
  return `prefab-${hex}`;
}

/** A suggested draft for a capture from the selected entity's name. */
export function newPrefabDraft(
  selection: { id: string; name: string } | null,
  existingPrefabIds: readonly string[],
  rng: () => number = Math.random,
): { prefabId: string; displayName: string } {
  let displayName = (selection?.name ?? selection?.id ?? 'Prefab').trim().slice(0, MAX_DISPLAY_NAME);
  if (displayName === '' || hasControlChars(displayName)) displayName = 'Prefab';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prefabId = makePrefabId(rng);
    if (!existingPrefabIds.includes(prefabId)) return { prefabId, displayName };
  }
  return { prefabId: makePrefabId(rng), displayName };
}

// ---- capture (createPrefab) ---------------------------------------------------

export interface CaptureInput {
  prefabId: string;
  displayName: string;
  sourceEntityId: string;
  scene: readonly CaptureEntityView[];
  existingPrefabIds: readonly string[];
  /** Published declarations (to resolve `entityRef` values by declaration). */
  declarations: ReadonlyMap<string, PropertyDeclaration>;
  /** The scene's camera id, for the forbidden-capture payload. */
  cameraId?: string | null;
}

export interface CapturePreflight {
  entityCount: number;
  depth: number;
}

interface Closure {
  entities: CaptureEntityView[];
  depth: number;
}

/** The subtree closure in scene document order (parent before child, §8.6.2 step 5). */
export function captureClosure(scene: readonly CaptureEntityView[], sourceEntityId: string): Closure | null {
  const byId = new Map<string, CaptureEntityView>();
  const children = new Map<string, CaptureEntityView[]>();
  for (const e of scene) {
    byId.set(e.id, e);
    const arr = children.get(e.parentId ?? '') ?? [];
    arr.push(e);
    children.set(e.parentId ?? '', arr);
  }
  const root = byId.get(sourceEntityId);
  if (root === undefined) return null;
  const entities: CaptureEntityView[] = [];
  let depth = 0;
  const seen = new Set<string>();
  const visit = (e: CaptureEntityView, d: number): void => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    entities.push(e);
    depth = Math.max(depth, d);
    for (const c of children.get(e.id) ?? []) visit(c, d + 1);
  };
  visit(root, 1);
  return { entities, depth };
}

/** Entity-reference links declared by a behavior component (§8.6.3 row 3). */
export function entityRefLinks(
  entity: CaptureEntityView,
  declarations: ReadonlyMap<string, PropertyDeclaration>,
): { key: string; entityId: string }[] {
  if (entity.behavior === null) return [];
  const declaration = declarations.get(entity.behavior.behaviorId);
  if (declaration === undefined) return [];
  const out: { key: string; entityId: string }[] = [];
  for (const prop of declaration.properties) {
    if (prop.type !== 'entityRef') continue;
    const value = entity.behavior.values[prop.key];
    if (typeof value === 'string') out.push({ key: prop.key, entityId: value });
  }
  return out;
}

/**
 * Preflight a capture in the normative §8.6.2/§8.6.3 order. The canonical
 * definition byte bound (`prefab_bytes`, §20.3) is enforced by the backend:
 * the editor cannot serialize the definition without duplicating the model's
 * canonical writer, and the backend remains authoritative.
 */
export function preflightCreatePrefab(input: CaptureInput): PlanResult<CapturePreflight> {
  if (!ID_SYNTAX.test(input.prefabId)) {
    return {
      ok: false,
      error: { code: 'id_invalid', message: `"${input.prefabId}" is not a valid prefab id`, path: '/args/prefabId', expected: 'project-model ID syntax', found: input.prefabId },
    };
  }
  if (input.existingPrefabIds.includes(input.prefabId)) {
    return {
      ok: false,
      error: { code: 'prefab_id_duplicate', message: `a prefab definition "${input.prefabId}" already exists (M2 has no prefab deletion)`, prefabId: input.prefabId },
    };
  }
  if (input.displayName.length < 1 || input.displayName.length > MAX_DISPLAY_NAME || hasControlChars(input.displayName)) {
    return {
      ok: false,
      error: { code: 'field_value', message: 'displayName must be 1–128 characters without control characters', path: '/args/displayName', found: input.displayName },
    };
  }
  const closure = captureClosure(input.scene, input.sourceEntityId);
  if (closure === null) {
    return {
      ok: false,
      error: { code: 'entity_not_found', message: `the source entity ${input.sourceEntityId} does not exist in the current scene`, entityId: input.sourceEntityId },
    };
  }
  const camera = closure.entities.find((e) => e.camera);
  if (camera !== undefined) {
    return {
      ok: false,
      error: {
        code: 'prefab_camera_capture_forbidden',
        message: 'the captured subtree contains the scene camera; a definition must not carry it',
        sourceEntityId: input.sourceEntityId,
        cameraId: input.cameraId ?? camera.id,
      },
    };
  }
  const nested = closure.entities.filter((e) => e.prefab !== null).map((e) => e.id);
  if (nested.length > 0) {
    return {
      ok: false,
      error: {
        code: 'prefab_nested_forbidden',
        message: 'the captured subtree contains a prefab copy; nested definitions are not in M2',
        sourceEntityId: input.sourceEntityId,
        prefabInstanceIds: nested,
      },
    };
  }
  const inside = new Set(closure.entities.map((e) => e.id));
  for (const e of closure.entities) {
    for (const link of entityRefLinks(e, input.declarations)) {
      if (!inside.has(link.entityId)) {
        return {
          ok: false,
          error: {
            code: 'prefab_external_reference_forbidden',
            message: `an entityRef value on ${e.id} names ${link.entityId}, which is outside the captured subtree`,
            sourceEntityId: input.sourceEntityId,
            localId: e.id,
            key: link.key,
            entityId: link.entityId,
          },
        };
      }
    }
  }
  if (closure.entities.length > MAX_PREFAB_ENTITIES) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        message: `the captured subtree has ${closure.entities.length} entities; the definition bound is ${MAX_PREFAB_ENTITIES}`,
        limit: 'prefab_entities',
        current: closure.entities.length,
        max: MAX_PREFAB_ENTITIES,
      },
    };
  }
  if (closure.depth > MAX_PREFAB_DEPTH) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        message: `the captured subtree is ${closure.depth} levels deep; the definition bound is ${MAX_PREFAB_DEPTH}`,
        limit: 'prefab_depth',
        current: closure.depth,
        max: MAX_PREFAB_DEPTH,
      },
    };
  }
  if (input.existingPrefabIds.length >= MAX_PREFABS) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        message: `the catalog already holds ${input.existingPrefabIds.length} definitions; the bound is ${MAX_PREFABS}`,
        limit: 'prefabs',
        current: input.existingPrefabIds.length,
        max: MAX_PREFABS,
      },
    };
  }
  return { ok: true, entityCount: closure.entities.length, depth: closure.depth };
}

export interface CreatePrefabCommand {
  op: 'createPrefab';
  args: { prefabId: string; displayName: string; sourceEntityId: string };
}

/** Plan exactly one `createPrefab` command ("Create Prefab Definition"). */
export function planCreatePrefab(input: CaptureInput): PlanResult<{ command: CreatePrefabCommand }> {
  const preflight = preflightCreatePrefab(input);
  if (!preflight.ok) return preflight;
  return {
    ok: true,
    command: {
      op: 'createPrefab',
      args: { prefabId: input.prefabId, displayName: input.displayName, sourceEntityId: input.sourceEntityId },
    },
  };
}

// ---- instantiation (instantiatePrefab) ---------------------------------------

export interface PartialTransformInput {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

export interface OverrideInput {
  localId: string;
  key: string;
  value: unknown;
}

export interface InstantiateInput {
  prefabId: string;
  /** The definition the projection holds for `prefabId`, or `null` when unknown. */
  definition: PrefabDefinition | null;
  /** Published declarations keyed by behaviorId (the only schema source). */
  declarations: ReadonlyMap<string, PropertyDeclaration>;
  parentId?: string | null;
  transform?: PartialTransformInput;
  overrides?: readonly OverrideInput[];
  /** Existing scene entity IDs (parent resolution + `entityRef` targets). */
  sceneEntityIds: readonly string[];
  /** Catalog asset IDs (`assetRef` override resolution). */
  assetIds: readonly string[];
  /** The projected scene size before insertion (the `entities` limit). */
  sceneEntityCount: number;
  /** The depth of `parentId` (root = 1); 0 for the scene root. */
  parentDepth: number;
}

export interface InstantiateCommand {
  op: 'instantiatePrefab';
  args: {
    prefabId: string;
    parentId?: string | null;
    transform?: PartialTransformInput;
    overrides?: { localId: string; key: string; value: PropertyValue }[];
  };
}

function checkPartialTransform(transform: PartialTransformInput): PlanError | null {
  if (transform.position !== undefined) {
    const p = transform.position;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => isFiniteNumber(v) && Math.abs(v) <= 1e6)) {
      return { code: 'field_value', message: 'transform.position must be three finite numbers with |v| <= 1e6', path: '/args/transform/position', found: p };
    }
  }
  if (transform.rotation !== undefined) {
    const q = transform.rotation;
    if (!Array.isArray(q) || q.length !== 4 || !q.every(isFiniteNumber)) {
      return { code: 'field_value', message: 'transform.rotation must be four finite numbers', path: '/args/transform/rotation', found: q };
    }
    const [x, y, z, w] = q as [number, number, number, number];
    const norm = Math.sqrt(x * x + y * y + z * z + w * w);
    if (!(Math.abs(norm - 1) <= 1e-4)) {
      return { code: 'quaternion_invalid', message: 'transform.rotation must have unit length within 1e-4', path: '/args/transform/rotation', found: q, expected: 'finite [x,y,z,w] with |norm - 1| <= 1e-4' };
    }
  }
  if (transform.scale !== undefined) {
    const s = transform.scale;
    if (!Array.isArray(s) || s.length !== 3 || !s.every((v) => isFiniteNumber(v) && v > 0 && v <= 1e6)) {
      return { code: 'field_value', message: 'transform.scale must be three finite numbers with 0 < v <= 1e6', path: '/args/transform/scale', found: s };
    }
  }
  return null;
}

/**
 * Plan exactly one `instantiatePrefab` command ("Place Copy") in the normative
 * §8.7.5 validation order. A second copy is a second call: each is one
 * independent transaction with its own backend-assigned IDs.
 */
export function planInstantiatePrefab(input: InstantiateInput): PlanResult<{ command: InstantiateCommand }> {
  // 1. overrides bound (checked before anything else, §8.7.5 step 1).
  const overrides = input.overrides ?? [];
  if (overrides.length > MAX_OVERRIDES) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        message: `${overrides.length} overrides supplied; the bound is ${MAX_OVERRIDES}`,
        limit: 'overrides',
        current: overrides.length,
        max: MAX_OVERRIDES,
      },
    };
  }
  // 2. prefabId resolves.
  if (input.definition === null || input.definition.prefabId !== input.prefabId) {
    return {
      ok: false,
      error: { code: 'prefab_not_found', message: `no prefab definition ${input.prefabId} is in the catalog`, prefabId: input.prefabId },
    };
  }
  const definition = input.definition;
  const parentId = input.parentId ?? null;
  // 3. parentId resolves.
  if (parentId !== null && !input.sceneEntityIds.includes(parentId)) {
    return {
      ok: false,
      error: { code: 'reference_missing', message: `the parent entity ${parentId} does not exist in the current scene`, found: parentId, expected: 'an existing scene entity id or null' },
    };
  }
  // 4. the root transform fields.
  if (input.transform !== undefined) {
    const invalid = checkPartialTransform(input.transform);
    if (invalid) return { ok: false, error: invalid };
  }
  // 5. overrides resolve and type-check against the recorded values + declarations.
  const entityByLocal = new Map(definition.entities.map((e) => [e.localId, e]));
  const seen = new Set<string>();
  const checked: { localId: string; key: string; value: PropertyValue }[] = [];
  for (const override of overrides) {
    const pair = `${override.localId}\u0000${override.key}`;
    if (seen.has(pair)) {
      return {
        ok: false,
        error: { code: 'field_value', message: `duplicate override (${override.localId}, ${override.key})`, path: '/args/overrides', found: override },
      };
    }
    seen.add(pair);
    const entity = entityByLocal.get(override.localId);
    if (entity === undefined) {
      return {
        ok: false,
        error: { code: 'prefab_local_unknown', message: `the definition has no local entity ${override.localId}`, prefabId: input.prefabId, localId: override.localId },
      };
    }
    const behavior = entity.components.behavior;
    if (behavior === undefined) {
      return {
        ok: false,
        error: {
          code: 'property_unknown',
          message: `${override.localId} carries no behavior component, so it has no declared properties to override (structural overrides are not supported)`,
          path: '/args/overrides',
          key: override.key,
        },
      };
    }
    const declaration = input.declarations.get(behavior.behaviorId);
    if (declaration === undefined) {
      return {
        ok: false,
        error: {
          code: 'behavior_reference_missing',
          message: `${override.localId} references ${behavior.behaviorId}, which is not in content.behaviors`,
          behaviorId: behavior.behaviorId,
        },
      };
    }
    const prop = declaration.properties.find((p) => p.key === override.key);
    if (prop === undefined) {
      return {
        ok: false,
        error: {
          code: 'property_unknown',
          message: `"${override.key}" is not declared by ${behavior.behaviorId}`,
          path: '/args/overrides',
          key: override.key,
          expected: `one of: ${declaration.properties.map((p) => p.key).join(', ')}`,
        },
      };
    }
    const invalid = validatePropertyValue(prop, override.value);
    if (invalid) {
      return { ok: false, error: { ...invalid, path: '/args/overrides', key: override.key, localId: override.localId } };
    }
    if (prop.type === 'entityRef' && override.value !== null) {
      const target = override.value as string;
      const isLocal = entityByLocal.has(target);
      if (!isLocal && !input.sceneEntityIds.includes(target)) {
        return {
          ok: false,
          error: { code: 'reference_missing', message: `the entityRef override names ${target}, which is neither a definition localId nor an existing scene entity`, found: target, expected: 'a definition localId or an existing scene entity id', key: override.key, localId: override.localId },
        };
      }
    }
    if (prop.type === 'assetRef' && override.value !== null) {
      const target = override.value as string;
      if (!input.assetIds.includes(target)) {
        return {
          ok: false,
          error: { code: 'asset_reference_missing', message: `the assetRef override names ${target}, which is not in the asset catalog`, found: target, expected: 'an existing assetId', key: override.key, localId: override.localId },
        };
      }
    }
    checked.push({ localId: override.localId, key: override.key, value: override.value as PropertyValue });
  }
  // 6. atomic preconditions on the whole operation.
  const resultingEntities = input.sceneEntityCount + definition.entityCount;
  if (resultingEntities > MAX_SCENE_ENTITIES) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        message: `placing this copy would create ${resultingEntities} scene entities; the bound is ${MAX_SCENE_ENTITIES}`,
        limit: 'entities',
        current: resultingEntities,
        max: MAX_SCENE_ENTITIES,
      },
    };
  }
  const resultingDepth = input.parentDepth + definition.depth;
  if (resultingDepth > MAX_SCENE_DEPTH) {
    return {
      ok: false,
      error: {
        code: 'limits_exceeded',
        message: `placing this copy would reach depth ${resultingDepth}; the bound is ${MAX_SCENE_DEPTH}`,
        limit: 'depth',
        current: resultingDepth,
        max: MAX_SCENE_DEPTH,
      },
    };
  }
  const args: InstantiateCommand['args'] = { prefabId: input.prefabId };
  if (input.parentId !== undefined) args.parentId = input.parentId;
  if (input.transform !== undefined) args.transform = input.transform;
  if (checked.length > 0) args.overrides = checked;
  return { ok: true, command: { op: 'instantiatePrefab', args } };
}

// ---- initial-override draft collection ----------------------------------------

/** The draft-map key for one `(localId, key)` override control. */
export function overrideDraftKey(localId: string, key: string): string {
  return `${localId}\u0000${key}`;
}

/**
 * Turn the UI's textual override drafts into typed overrides, derived only from
 * the published declarations (`BehaviorControlsView.controls`). An edit to a
 * target/key that is not a declared property is rejected — structural,
 * per-entity-transform and component overrides are not supported
 * (commands.md §8.7.1/§8.7.3).
 */
export function collectOverrides(
  targets: readonly BehaviorControlsView[],
  drafts: ReadonlyMap<string, string>,
  refs: ReferenceContext = {},
): PlanResult<{ overrides: { localId: string; key: string; value: PropertyValue }[] }> {
  const byLocal = new Map(targets.map((t) => [t.localId, t]));
  const overrides: { localId: string; key: string; value: PropertyValue }[] = [];
  for (const [draftKey, raw] of drafts) {
    const sep = draftKey.indexOf('\u0000');
    if (sep < 0) {
      return {
        ok: false,
        error: { code: 'field_value', message: `malformed override draft key "${draftKey}"`, path: '/args/overrides' },
      };
    }
    const localId = draftKey.slice(0, sep);
    const key = draftKey.slice(sep + 1);
    const target = byLocal.get(localId);
    if (target === undefined || target.declaration === null) {
      return {
        ok: false,
        error: { code: 'prefab_local_unknown', message: `no declared-property target ${localId} in this definition`, localId },
      };
    }
    const control = target.controls.find((c) => c.key === key);
    if (control === undefined) {
      return {
        ok: false,
        error: { code: 'property_unknown', message: `"${key}" is not a declared property of ${target.behaviorId}`, key, localId },
      };
    }
    const parsed = parseControlInput(control, raw, refs);
    if (!parsed.ok) return { ok: false, error: { ...parsed.error, key, localId } };
    overrides.push({ localId, key, value: parsed.value });
  }
  return { ok: true, overrides };
}

// ---- failure recovery (stale revision / backend-rejected limits) --------------

export interface PrefabFailure {
  code: string;
  message?: string;
  limit?: string;
  current?: number;
  max?: number;
  currentRevision?: number;
}

export type PrefabRecovery =
  | { kind: 'reissue'; reason: string; message: string }
  | { kind: 'surface'; reason: string; message: string };

/**
 * Decide what to do with a failed prefab command (commands.md §5.5/§6.4):
 * a stale revision is recovered by re-reading then re-issuing with a fresh
 * `requestId` (at most once per logical attempt); a backend-rejected instance
 * limit is surfaced with its exact bound. Nothing is swallowed.
 */
export function recoverPrefabCommandFailure(
  failure: PrefabFailure,
  state: { reissues: number; maxReissues?: number },
): PrefabRecovery {
  const maxReissues = state.maxReissues ?? 1;
  if (failure.code === 'revision_conflict') {
    if (state.reissues < maxReissues) {
      return {
        kind: 'reissue',
        reason: 'revision_conflict',
        message: `the scene changed since this edit began (backend revision ${failure.currentRevision ?? '?'}); re-reading and re-issuing with a fresh requestId`,
      };
    }
    return {
      kind: 'surface',
      reason: 'revision_conflict',
      message: `the scene kept changing (backend revision ${failure.currentRevision ?? '?'}); re-read the state and retry manually`,
    };
  }
  if (failure.code === 'limits_exceeded') {
    const bound = failure.limit ? `limit "${failure.limit}"` : 'a declared limit';
    const measure =
      failure.current !== undefined && failure.max !== undefined ? ` (current ${failure.current}, max ${failure.max})` : '';
    return {
      kind: 'surface',
      reason: 'limits_exceeded',
      message: `the backend rejected the command: ${bound} was exceeded${measure}`,
    };
  }
  return { kind: 'surface', reason: failure.code, message: failure.message ?? failure.code };
}
