/**
 * Pure forward-op application — commands.md §8.1/§8.2/§8.3.
 *
 * Each op takes the validated request args plus the current (valid,
 * canonical) scene and either returns the applied result (new scene,
 * change data, inverse spec) or a structured error. Application happens on
 * an in-memory copy (pipeline step 5, commands.md §6.1): the input scene
 * is never mutated, and the RESULTING scene is re-validated by the
 * project-model; any failure means no state change, no revision change.
 */

import {
  serializeCanonical,
  validateContent,
  validateContentV3,
  validateEnvelopeV3,
  validateProjectV2,
  validateProjectV3,
  validateScene,
  validateSceneV2,
  SURFACE_PRESETS,
  type BehaviorComponent,
  type ContentCatalog,
  type Entity,
  type EntityV2,
  type Manifest,
  type ModelErrorV3,
  type Scene,
  type SceneV2,
  type SceneV3,
  type TransformComponent,
} from '@thirdlight/project-model';

import {
  cameraCountInvalid,
  assetReferenceMissing,
  entityNotFound,
  gameReferenceInUse,
  idExhaustion,
  limitsExceeded,
  noChange,
  noChangeContent,
  referenceInUse,
  referenceMissing,
  resultSceneError,
  type CommandError,
} from './errors';
import type {
  ChangedField,
  ChangeData,
  ContentDocument,
  CreateEntityArgs,
  CreateEntityChange,
  DeleteEntityArgs,
  DeleteEntityChange,
  SetTransformArgs,
  SetTransformChange,
  ForwardChange,
  InverseSpec,
  SceneDocument,
  V3OwnedComponent,
} from './types';
import {
  COMPONENT_FIELD_ORDER_V3,
  V3_COMPONENTS,
  commandErrorFromModel,
  danglingGameReferences,
  gameOf,
  validateAnimationRoleRange,
  validateV3ComponentValue,
  animationVersionOf,
} from './v3';

/** Either scene shape (M1 interchange or embedded v2). */
export type AnyEntity = Entity | EntityV2;

/**
 * The entity's component bag as a plain record. The M1 (schemaVersion 1) and
 * v2 component registries overlap; commands that must address a component that
 * exists only in one of them (for example `behavior`) go through this helper
 * so the union stays explicit and the value is still re-validated by the gate.
 */
export function componentsRecord(e: AnyEntity): Record<string, unknown> {
  return e.components as unknown as Record<string, unknown>;
}

/** The v1 entity components are a subset of v2; `behavior` is v2-only. */
export function behaviorOf(e: AnyEntity): BehaviorComponent | undefined {
  return (e.components as { behavior?: BehaviorComponent }).behavior;
}

/** M1 limits (project-model §10.4, restated in commands.md §5.4/§8.1). */
const MAX_ENTITIES = 1024;
const MAX_DEPTH = 32; // root = 1
const ID_MAX = 9999;

/**
 * JSON-safe deep clone. Entity/transform graphs are plain JSON values by
 * construction (canonical documents, validated args), so the round-trip is
 * total; it also normalizes `-0` to `0`, matching canonical semantics.
 */
export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Plain byte equality (no Buffer dependency). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function entitiesById(scene: SceneDocument): Map<string, AnyEntity> {
  return new Map(scene.entities.map((e) => [e.id, e]));
}

/** Entity depth (root = 1). Valid scenes are acyclic with parents first. */
function entityDepth(scene: SceneDocument, id: string): number {
  const byId = entitiesById(scene);
  let depth = 0;
  let cur: AnyEntity | undefined = byId.get(id);
  while (cur !== undefined) {
    depth += 1;
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
  }
  return depth;
}

/**
 * Full descendant closure of `rootId` (project-model §11.3: M1 deletion is
 * always subtree deletion). Returns null when the root does not exist.
 */
export function subtreeClosure(scene: SceneDocument, rootId: string): string[] | null {
  const byId = entitiesById(scene);
  if (!byId.has(rootId)) return null;
  const children = new Map<string, string[]>();
  for (const e of scene.entities) {
    if (e.parentId !== undefined) {
      const list = children.get(e.parentId) ?? [];
      list.push(e.id);
      children.set(e.parentId, list);
    }
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    out.push(id);
    const kids = children.get(id);
    if (kids !== undefined) for (const k of kids) stack.push(k);
  }
  return out;
}

/** Closure members in pre-deletion array order (ascending index). */
function closureInArrayOrder(scene: SceneDocument, closure: string[]): string[] {
  const index = new Map(scene.entities.map((e, i) => [e.id, i]));
  return [...closure].sort((a, b) => {
    const ia = index.get(a) ?? 0;
    const ib = index.get(b) ?? 0;
    return ia - ib;
  });
}

/** The scene's (exactly one) camera entity ID, or null. */
function cameraIdOf(scene: SceneDocument): string | null {
  for (const e of scene.entities) {
    if (e.components.camera !== undefined) return e.id;
  }
  return null;
}

/**
 * `no_change` check (commands.md §6.5): canonical-serialize both scenes
 * with `revision` masked to `0` and byte-compare. Only `setTransform` can
 * reach this (create/delete change structure; undo/redo always restore a
 * different state), but the pipeline runs the check uniformly.
 */
export function isNoChange(current: SceneDocument, result: SceneDocument): boolean {
  const a = serializeCanonical({ ...current, revision: 0 });
  const b = serializeCanonical({ ...result, revision: 0 });
  if (!a.ok || !b.ok) return false; // unreachable: both documents are valid
  return bytesEqual(a.bytes, b.bytes);
}

/**
 * §8.1 step 2: backend-assigned ID — the smallest NNNN in 0001..9999 such
 * that `<kind>-NNNN` does not exist in the current scene. Undefined on
 * exhaustion (⇒ `id_exhaustion`). The v3 derived prefixes (`zone`, `spawn`,
 * `light`) use the same rule (authoring §A4.1).
 */
export type EntityIdPrefix = 'box' | 'group' | 'model' | 'zone' | 'spawn' | 'light';

export function nextEntityId(scene: SceneDocument, kind: EntityIdPrefix): string | undefined {
  const existing = new Set(scene.entities.map((e) => e.id));
  for (let n = 1; n <= ID_MAX; n++) {
    const id = `${kind}-${String(n).padStart(4, '0')}`;
    if (!existing.has(id)) return id;
  }
  return undefined;
}

/**
 * §8.1 step 2 / authoring §A4.1: the derived ID prefix of a created entity is
 * the FIRST match in the order `model` → `box` → `zone` (gameZone) → `spawn`
 * (playerSpawn) → `light` → `group`. `camera` is never allocatable.
 */
export function derivedPrefix(components: Record<string, unknown>): EntityIdPrefix {
  if (components['model'] !== undefined) return 'model';
  if (components['box'] !== undefined) return 'box';
  if (components['gameZone'] !== undefined) return 'zone';
  if (components['playerSpawn'] !== undefined) return 'spawn';
  if (components['light'] !== undefined) return 'light';
  return 'group';
}

// ---- internal result shapes ------------------------------------------------------

export interface OpSuccess {
  scene: SceneDocument; // the applied, re-validated (canonical) result scene
  /** The applied content block when this op changed it (M2/M3); absent = unchanged. */
  content?: ContentDocument;
  change: ForwardChange;
  inverse: InverseSpec;
  createdId?: string;
}

export type OpOutcome =
  | { ok: true; op: OpSuccess }
  | { ok: false; error: CommandError };

/**
 * Pipeline steps 5–6 on the applied result: re-validate the resulting
 * scene with the project-model (any failure ⇒ structured error, no state
 * change), then run the uniform no-change check (§6.5). `result` is the
 * CANDIDATE document (typed `unknown`: its value rules — vector lengths,
 * finiteness, ranges, quaternion norm — are exactly what this validation
 * checks); on success the canonical (normalized) scene is returned.
 */
export function gateResultScene(
  current: Scene,
  result: unknown,
): { ok: true; normalized: Scene } | { ok: false; error: CommandError } {
  const v = validateScene(result);
  if (!v.ok) return { ok: false, error: resultSceneError(v.errors) };
  if (isNoChange(current, v.normalized)) return { ok: false, error: noChange() };
  return { ok: true, normalized: v.normalized };
}

/** Canonical bytes of the content block (project-model §12.2), or null. */
function contentBytes(content: ContentDocument | undefined): Uint8Array | null {
  if (content === undefined) return null;
  const s = serializeCanonical(content);
  return s.ok ? s.bytes : null;
}

/**
 * Pipeline steps 5–6 for the v3 branch (project-model §23.8): the resulting
 * scene and content are validated together (composition included) by the
 * model-owned v3 envelope branch, then the whole durable state is compared
 * (canonical scene bytes with `revision` masked AND canonical content bytes).
 *
 * The model entry point takes an envelope; without a caller-supplied manifest
 * the command layer supplies the minimal envelope wrapper (the `retry` block
 * and `projectId` are carried through unchanged and are not part of the
 * validated state). Envelope-relative error paths are mapped back to
 * document-relative paths so the `details` objects keep the §12.5 shape.
 */
function gateResultV3(
  current: { scene: SceneDocument; content?: ContentDocument; manifest?: Manifest },
  resultScene: unknown,
  resultContent: ContentDocument | undefined,
): { ok: true; scene: SceneV3; content: ContentDocument } | { ok: false; error: CommandError } {
  if (current.manifest !== undefined && resultContent !== undefined) {
    const v = validateProjectV3(current.manifest, resultScene, resultContent);
    if (!v.ok) return { ok: false, error: resultSceneError(v.errors) };
    const nextScene = v.normalized.scene;
    const nextContent = v.normalized.content as ContentDocument;
    if (stateIsNoChange(current, nextScene, nextContent)) {
      return { ok: false, error: noChangeContent() };
    }
    return { ok: true, scene: nextScene, content: nextContent };
  }
  const load = validateEnvelopeV3({
    storageVersion: 3,
    type: 'authoring-state',
    projectId: 'command-state',
    scene: resultScene,
    content: resultContent,
    retry: { retention: 0, records: [] },
  });
  if (!load.ok) return { ok: false, error: resultSceneError(load.errors.map(envelopeErrorToModel)) };
  const nextScene = load.normalized.scene;
  const nextContent = load.normalized.content as ContentDocument;
  if (stateIsNoChange(current, nextScene, nextContent)) {
    return { ok: false, error: noChangeContent() };
  }
  return { ok: true, scene: nextScene, content: nextContent };
}

/** Strip the envelope prefix from a v3 branch error (paths are `/scene/…`). */
function envelopeErrorToModel(e: { path: string; code: string; message: string; expected?: string; reason?: string; found?: unknown }): ModelErrorV3 {
  const path = e.path.startsWith('/scene')
    ? e.path.slice('/scene'.length)
    : e.path.startsWith('/content')
      ? e.path.slice('/content'.length)
      : e.path;
  return {
    code: e.code as ModelErrorV3['code'],
    path,
    message: e.message,
    ...(e.expected === undefined ? {} : { expected: e.expected }),
    ...(e.reason === undefined ? {} : { reason: e.reason }),
    ...(e.found === undefined ? {} : { found: e.found }),
  };
}

/**
 * Pipeline steps 5–6 for the M2/M3 state (commands.md §6.1 step 5/§6.5):
 * validate the resulting **scene and content** — v3 via the model-owned v3
 * envelope branch when `resultScene.schemaVersion === 3`, otherwise
 * three-block via `validateProjectV2` when the manifest is available
 * (project-model §13.1) or the v2 scene and content separately (each op
 * additionally runs its own explicit reference checks; see handoff 21) — then
 * compare the whole durable state (canonical scene bytes with `revision`
 * masked **and** canonical content bytes).
 *
 * A schemaVersion 1 result keeps the accepted M1 path (`validateScene`, scene
 * bytes only); no M1 behaviour changes.
 */
export function gateResultState(
  current: { scene: SceneDocument; content?: ContentDocument; manifest?: Manifest },
  resultScene: unknown,
  resultContent?: ContentDocument,
):
  | { ok: true; scene: SceneDocument; content?: ContentDocument }
  | { ok: false; error: CommandError } {
  const schema =
    typeof resultScene === 'object' && resultScene !== null
      ? (resultScene as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (schema === 3) return gateResultV3(current, resultScene, resultContent);
  const isV2 = schema === 2;
  if (isV2) {
    if (current.manifest !== undefined && resultContent !== undefined) {
      const v = validateProjectV2(current.manifest, resultScene, resultContent);
      if (!v.ok) return { ok: false, error: resultSceneError(v.errors) };
      const nextScene = v.normalized.scene as SceneV2;
      const nextContent = v.normalized.content as ContentCatalog;
      if (stateIsNoChange(current, nextScene, nextContent)) {
        return { ok: false, error: noChangeContent() };
      }
      return { ok: true, scene: nextScene, content: nextContent };
    }
    const sv = validateSceneV2(resultScene);
    if (!sv.ok) return { ok: false, error: resultSceneError(sv.errors) };
    if (resultContent !== undefined) {
      const cv = validateContent(resultContent);
      if (!cv.ok) return { ok: false, error: resultSceneError(cv.errors) };
      const nextContent = cv.normalized as ContentCatalog;
      if (stateIsNoChange(current, sv.normalized as SceneV2, nextContent)) {
        return { ok: false, error: noChangeContent() };
      }
      return { ok: true, scene: sv.normalized as SceneV2, content: nextContent };
    }
    if (stateIsNoChange(current, sv.normalized as SceneV2, current.content)) {
      return { ok: false, error: noChangeContent() };
    }
    return { ok: true, scene: sv.normalized as SceneV2, content: current.content };
  }
  // M1 interchange scene: unchanged accepted path (scene bytes only).
  const v = validateScene(resultScene);
  if (!v.ok) return { ok: false, error: resultSceneError(v.errors) };
  if (resultContent !== undefined) {
    const cv = validateContent(resultContent);
    if (!cv.ok) return { ok: false, error: resultSceneError(cv.errors) };
  }
  const sceneSame = isNoChange(current.scene, v.normalized);
  if (resultContent === undefined) {
    if (sceneSame) return { ok: false, error: noChange() };
  } else if (sceneSame && contentIsNoChange(current.content, resultContent)) {
    return { ok: false, error: noChange() };
  }
  return { ok: true, scene: v.normalized, content: resultContent };
}

/** §6.5: canonical scene bytes (revision masked) AND canonical content bytes. */
export function stateIsNoChange(
  current: { scene: SceneDocument; content?: ContentDocument },
  resultScene: SceneDocument,
  resultContent: ContentDocument | undefined,
): boolean {
  if (!isNoChange(current.scene, resultScene)) return false;
  if (current.content === undefined && resultContent === undefined) return true;
  return contentIsNoChange(current.content, resultContent);
}

/** Byte-compare two content blocks (a missing block is the empty catalog). */
export function contentIsNoChange(
  current: ContentDocument | undefined,
  result: ContentDocument | undefined,
): boolean {
  const a = contentBytes(current ?? emptyContentCatalog());
  const b = contentBytes(result ?? emptyContentCatalog());
  if (a === null || b === null) return false;
  return bytesEqual(a, b);
}

/** The canonical empty content block (project-model §18). */
export function emptyContentCatalog(): ContentDocument {
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] } };
}

// ---- createEntity (§8.1) ----------------------------------------------------------

export function applyCreateEntity(
  scene: SceneDocument,
  args: CreateEntityArgs,
  content?: ContentDocument,
): OpOutcome {
  const byId = entitiesById(scene);
  const parentId = args.parentId ?? null;

  // §8.1 precondition order: parentId resolves, then the model asset
  // reference resolves, then the v3 component VALUES (authoring §A3.1), the
  // limits, then the derived-ID scan.
  if (parentId !== null && !byId.has(parentId)) {
    return { ok: false, error: referenceMissing(parentId) };
  }
  if (args.kind === 'model') {
    const assetId = args.model?.asset.assetId;
    const assets = content?.assets ?? [];
    if (assetId === undefined || !assets.some((a) => a.assetId === assetId)) {
      return { ok: false, error: assetReferenceMissing(assetId ?? '') };
    }
  }
  const provided = args.components ?? {};
  for (const component of V3_COMPONENTS) {
    const value = provided[component];
    if (value === undefined) continue;
    const path = `/args/components/${component}`;
    const errors = validateV3ComponentValue(component, value, path);
    if (errors.length > 0) return { ok: false, error: commandErrorFromModel(errors[0] as ModelErrorV3) };
    if (component === 'modelAnimation') {
      const roleError = animationRoleError(value, content, `${path}/roles`);
      if (roleError !== null) return { ok: false, error: roleError };
    }
  }
  if (scene.entities.length + 1 > MAX_ENTITIES) {
    return {
      ok: false,
      error: limitsExceeded('entities', scene.entities.length + 1, MAX_ENTITIES),
    };
  }
  const newDepth = parentId === null ? 1 : entityDepth(scene, parentId) + 1;
  if (newDepth > MAX_DEPTH) {
    return { ok: false, error: limitsExceeded('depth', newDepth, MAX_DEPTH) };
  }

  // §8.3: defaults per field; a provided field replaces that field only.
  // The candidate entity is a plain object: vector values are checked by
  // the result-scene validation below (the model is the value authority).
  const transform = {
    position: [...(args.transform?.position ?? [0, 0, 0])],
    rotation: [...(args.transform?.rotation ?? [0, 0, 0, 1])],
    scale: [...(args.transform?.scale ?? [1, 1, 1])],
  };
  const candidateComponents: Record<string, unknown> = {
    transform,
    ...(args.kind === 'box'
      ? {
          box: {
            size: [...(args.box?.size ?? [1, 1, 1])],
            material: { color: args.box?.material?.color ?? '#b0b0b0' },
          },
        }
      : {}),
    ...(args.kind === 'model'
      ? { model: { asset: { assetId: args.model!.asset.assetId } } }
      : {}),
  };
  for (const [component, value] of Object.entries(provided)) {
    candidateComponents[component] = deepClone(value);
  }
  // §3.1: `surfacePreset` copies the frozen row; `components.surface` is
  // mutually excluded (args validation), so this is the only writer.
  if (args.surfacePreset !== undefined && candidateComponents['surface'] === undefined) {
    candidateComponents['surface'] = deepClone(SURFACE_PRESETS[args.surfacePreset]);
  }

  const id = nextEntityId(scene, derivedPrefix(candidateComponents));
  if (id === undefined) return { ok: false, error: idExhaustion(derivedPrefix(candidateComponents)) };
  const candidateEntity = {
    id,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(parentId !== null ? { parentId } : {}),
    components: candidateComponents,
  };

  // §3.1 step 4: append at the END (leaf ⇒ parent-before-child preserved).
  const result = {
    ...scene,
    revision: scene.revision + 1,
    entities: [...scene.entities, candidateEntity],
  };
  const gate = gateResultState({ scene, content }, result, content);
  if (!gate.ok) return gate;

  // Canonical entity value (defaults filled, -0 normalized) from the
  // validated result document.
  const canonicalEntity = gate.scene.entities.find((e) => e.id === id) as Entity;
  const change: CreateEntityChange = { type: 'createEntity', id, entity: deepClone(canonicalEntity) };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      change,
      inverse: { kind: 'delete', rootId: id },
      createdId: id,
    },
  };
}

/**
 * §41.3.2 stages 3–4 for a `modelAnimation` value: range against the named
 * immutable version's clip count and duplicate clip indices. The asset/version
 * resolution itself is the resulting-state gate's job, so an unresolvable
 * version is left to it.
 */
function animationRoleError(
  value: unknown,
  content: ContentDocument | undefined,
  path: string,
): CommandError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const version = animationVersionOf(content?.assets ?? [], v['assetId'], v['version']);
  if (version === undefined) return null;
  const clips = (version.metrics as { animations?: unknown }).animations;
  if (typeof clips !== 'number') return null;
  return validateAnimationRoleRange(v['roles'], clips, path);
}

// ---- setTransform (§8.2) ------------------------------------------------------------

const FIELD_ORDER: readonly ChangedField[] = ['position', 'rotation', 'scale'];

export function applySetTransform(scene: SceneDocument, args: SetTransformArgs, content?: ContentDocument): OpOutcome {
  const byId = entitiesById(scene);
  const index = scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const current = scene.entities[index] as AnyEntity;

  // §8.2: a provided field REPLACES the whole field (no component-wise
  // merge); absent fields are unchanged. `previous` is the entity's
  // canonical transform; `next` is the candidate (values checked by the
  // result-scene validation below).
  const previous = deepClone(current.components.transform);
  const next = {
    position: [...previous.position],
    rotation: [...previous.rotation],
    scale: [...previous.scale],
  };
  const changedFields: ChangedField[] = [];
  for (const f of FIELD_ORDER) {
    const v = args.transform[f];
    if (v !== undefined) {
      if (f === 'position') next.position = [...v];
      else if (f === 'rotation') next.rotation = [...v];
      else next.scale = [...v];
      changedFields.push(f);
    }
  }

  const newEntity = {
    ...deepClone(current),
    components: { ...deepClone(current.components), transform: next },
  };
  const nextEntities: unknown[] = [...scene.entities];
  nextEntities[index] = newEntity;
  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  // A v3 result is validated together with the (unchanged) content block.
  const gate = content !== undefined ? gateResultState({ scene, content }, result, content) : gateResultState({ scene }, result);
  if (!gate.ok) return gate;

  const canonicalNext = deepClone(
    (gate.scene.entities[index] as AnyEntity).components.transform,
  );
  const change: SetTransformChange = {
    type: 'setTransform',
    id: args.entityId,
    previous: deepClone(previous),
    next: canonicalNext,
    changedFields,
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      change,
      // §9.1: restore the FULL previous transform (all three fields).
      inverse: { kind: 'setTransform', id: args.entityId, restore: deepClone(previous) },
    },
  };
}

/**
 * §8.3 step 2b/§20.10: entity IDs outside `closure` that own an `entityRef`
 * property value naming an entity inside it, in scene document order. Values
 * inside the closure are fine (both disappear) and a value naming an entity
 * outside the closure is unaffected. Without a content block there are no
 * declarations to resolve, so no reference can be identified.
 */
export function referencingEntitiesInUse(
  scene: SceneDocument,
  content: ContentDocument | undefined,
  closure: ReadonlySet<string>,
): string[] {
  if (content === undefined) return [];
  const refKeys = new Map<string, Set<string>>();
  for (const b of content.behaviors) {
    refKeys.set(
      b.behaviorId,
      new Set(b.declaration.properties.filter((p) => p.type === 'entityRef').map((p) => p.key)),
    );
  }
  const out: string[] = [];
  for (const e of scene.entities) {
    if (closure.has(e.id)) continue;
    const behavior = behaviorOf(e);
    if (behavior === undefined) continue;
    const keys = refKeys.get(behavior.behaviorId);
    if (keys === undefined) continue;
    let references = false;
    for (const key of keys) {
      const v = behavior.values[key];
      if (typeof v === 'string' && closure.has(v)) {
        references = true;
        break;
      }
    }
    if (references) out.push(e.id);
  }
  return out;
}

// ---- deleteEntity (§8.3) -------------------------------------------------------------

export function applyDeleteEntity(
  scene: SceneDocument,
  args: DeleteEntityArgs,
  content?: ContentDocument,
): OpOutcome {
  const byId = entitiesById(scene);
  const root = byId.get(args.entityId);
  if (root === undefined) return { ok: false, error: entityNotFound(args.entityId) };

  const closure = subtreeClosure(scene, args.entityId);
  if (closure === null) {
    return { ok: false, error: entityNotFound(args.entityId) };
  }
  // §8.3 step 2: the closure may not contain the scene's only camera.
  const camId = cameraIdOf(scene);
  if (camId !== null && closure.includes(camId)) {
    return { ok: false, error: cameraCountInvalid(camId) };
  }

  // §8.3 step 2b (project-model §20.10): an `entityRef` property value owned
  // by an entity OUTSIDE the closure may not name an entity inside it.
  const closureSet0 = new Set(closure);
  const referencing = referencingEntitiesInUse(scene, content, closureSet0);
  if (referencing.length > 0) {
    return {
      ok: false,
      error: referenceInUse(closureInArrayOrder(scene, closure), referencing),
    };
  }

  // §23.6 rule 1 (authoring §A4.2): a v3 `content.game`/checkpoint reference
  // inside the closure is refused before application; nothing is cleared.
  const isV3 = (scene as { schemaVersion?: unknown }).schemaVersion === 3;
  if (isV3) {
    const refs = danglingGameReferences(scene as SceneV3, gameOf(content), closureSet0);
    if (refs.length > 0) {
      return { ok: false, error: gameReferenceInUse(closureInArrayOrder(scene, closure), refs) };
    }
  }

  const deletedIds = closureInArrayOrder(scene, closure);
  const indexOf = new Map(scene.entities.map((e, i) => [e.id, i]));
  // §9.1 inverse: entries in pre-deletion array order with indices.
  const entries = deletedIds.map((id) => ({
    index: indexOf.get(id) as number,
    entity: deepClone(byId.get(id) as Entity),
  }));

  const closureSet = new Set(closure);
  const nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  // A v3 result is validated together with the (unchanged) content block so
  // the §23.5 game composition rules run; M2 keeps the accepted scene-only
  // gate with the op's own explicit reference checks (handoff 21).
  const gate = isV3
    ? gateResultState({ scene, content }, result, content)
    : gateResultState({ scene }, result);
  if (!gate.ok) return gate;

  const change: DeleteEntityChange = {
    type: 'deleteEntity',
    rootId: args.entityId,
    deletedIds: [...deletedIds],
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      change,
      inverse: {
        kind: 'restoreSubtree',
        entries: entries.map((e) => ({ index: e.index, entity: deepClone(e.entity) })),
        restoredParentId: root.parentId ?? null,
      },
    },
  };
}