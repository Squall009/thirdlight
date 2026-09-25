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
  validateContentV3,
  validateEnvelopeV3,
  validateSceneV4,
  validateContentV4,
  composeSceneV4,
  type SceneV4,
  type ContentCatalogV4,
  validateProjectV3,
  SURFACE_PRESETS,
  type BehaviorComponent,
  type EntityV3,
  type FolderEntityV3,
  type Manifest,
  type ModelErrorV3,
  type SceneV3,
  type TransformComponent,
  type TagDefinition,
} from '@thirdlight/project-model';

import {
  cameraCountInvalid,
  assetReferenceMissing,
  entityNotFound,
  gameReferenceInUse,
  idExhaustion,
  limitsExceeded,
  noChangeContent,
  referenceInUse,
  referenceMissing,
  resultSceneError,
  fieldValue,
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
  EntityHeader,
  EntityHeaderField,
  MoveEntitiesArgs,
  MoveEntitiesChange,
  MoveEntitiesInverse,
  MovedEntity,
  UpdateEntityArgs,
  UpdateEntityChange,
  UpdateEntityInverse,
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
import { worldKeepingLocal, type HierarchyNode } from './world-transform';

/** A scene entity: an object entity or a v3/v4 folder. */
export type AnyEntity = EntityV3 | FolderEntityV3;

/**
 * The entity's component bag as a plain record, for commands that address a
 * component by name (the value is still re-validated by the gate).
 */
export function componentsRecord(e: AnyEntity): Record<string, unknown> {
  return e.components as unknown as Record<string, unknown>;
}

/** The entity's behavior component, if any (folders have none). */
export function behaviorOf(e: AnyEntity): BehaviorComponent | undefined {
  return (e.components as { behavior?: BehaviorComponent }).behavior;
}

/** Scene limits (project-model §10.4, restated in commands.md §5.4/§8.1): a v3 scene. */
const MAX_ENTITIES = 1024;
/** Phase 12 (c): a v4 scene holds up to 16384 entities. */
const MAX_ENTITIES_SCENE_V4 = 16_384;
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
  const a = maskedSceneBytes(current);
  const b = maskedSceneBytes(result);
  if (a === null || b === null) return false; // unreachable: both documents are valid
  return bytesEqual(a, b);
}

/**
 * Phase 21.4: the canonical bytes of a scene with `revision` masked, cached
 * per entity array. Scene documents are immutable values here: an edit builds
 * a new entity array, so the scene a command starts from is usually the one
 * the previous command produced (and serialized) — its bytes are not built
 * again. The cache key also checks the scene's other fields.
 */
const sceneBytesCache = new WeakMap<object, { head: string; bytes: Uint8Array }>();
function maskedSceneBytes(scene: SceneDocument): Uint8Array | null {
  const entities = (scene as { entities?: unknown }).entities;
  const cacheable = Array.isArray(entities);
  const head = cacheable ? JSON.stringify({ ...scene, entities: null, revision: 0 }) : '';
  if (cacheable) {
    const hit = sceneBytesCache.get(entities);
    if (hit !== undefined && hit.head === head) return hit.bytes;
  }
  const s = serializeCanonical({ ...scene, revision: 0 });
  if (!s.ok) return null;
  if (cacheable) sceneBytesCache.set(entities, { head, bytes: s.bytes });
  return s.bytes;
}

/**
 * §8.1 step 2: backend-assigned ID — the smallest NNNN in 0001..9999 such
 * that `<kind>-NNNN` does not exist in the current scene. Undefined on
 * exhaustion (⇒ `id_exhaustion`). The v3 derived prefixes (`zone`, `spawn`,
 * `light`) use the same rule (authoring §A4.1).
 */
export type EntityIdPrefix = 'box' | 'group' | 'model' | 'zone' | 'spawn' | 'light' | 'folder' | 'instances';

export function nextEntityId(scene: SceneDocument, kind: EntityIdPrefix, reserved?: ReadonlySet<string>): string | undefined {
  // Phase 12 (c): ids are unique across the project — the other scenes' ids are reserved.
  const existing = new Set([...scene.entities.map((e) => e.id), ...(reserved ?? [])]);
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
  if (components['instances'] !== undefined) return 'instances';
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

/**
 * Phase 12 (c): steps 5–6 for a v4 scene — the edited scene (v4 rules) and
 * the project content block (v4 rules), plus the per-scene cross-block rules
 * (`composeSceneV4`). The rules that span scenes (ids unique across the
 * project, the start set, exit targets) are checked by the workspace over the
 * whole resulting project.
 */
function gateResultV4(
  current: { scene: SceneDocument; content?: ContentDocument },
  resultScene: unknown,
  resultContent: ContentDocument | undefined,
): { ok: true; scene: SceneV4; content: ContentDocument } | { ok: false; error: CommandError } {
  const sv = validateSceneV4(resultScene);
  if (!sv.ok) return { ok: false, error: resultSceneError(sv.errors) };
  const cv = validateContentV4(resultContent ?? current.content);
  if (!cv.ok) return { ok: false, error: resultSceneError(cv.errors) };
  const errors: ModelErrorV3[] = [];
  composeSceneV4(sv.normalized, cv.normalized, errors, sv.normalized.revision);
  if (errors.length > 0) return { ok: false, error: resultSceneError(errors) };
  const nextContent = cv.normalized as unknown as ContentDocument;
  if (stateIsNoChange(current, sv.normalized, nextContent)) return { ok: false, error: noChangeContent() };
  return { ok: true, scene: sv.normalized, content: nextContent };
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
 * Pipeline steps 5–6 (commands.md §6.1 step 5/§6.5): validate the resulting
 * **scene and content** — a v4 scene by the v4 rules (`gateResultV4`), a v3
 * scene by the model-owned v3 envelope branch (`gateResultV3`) — then compare
 * the whole durable state (canonical scene bytes with `revision` masked
 * **and** canonical content bytes). Any other scene version is refused (the
 * v1/v2 scene models were removed in phase 9.3).
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
  if (schema === 4) return gateResultV4(current, resultScene, resultContent);
  return {
    ok: false,
    error: resultSceneError([
      {
        code: 'schema_version_unsupported',
        path: '/schemaVersion',
        message: 'the command layer edits schemaVersion 3 and 4 scenes only',
        expected: 'schemaVersion 3 or 4',
        knownVersions: [3, 4],
        ...(schema === undefined ? {} : { found: schema }),
      },
    ]),
  };
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

/**
 * The canonical empty v3 content block (project-model §18/§23.4): what a
 * command state without a content block is compared and edited against.
 */
export function emptyContentCatalog(): ContentDocument {
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
}

// ---- createEntity (§8.1) ----------------------------------------------------------

export function applyCreateEntity(
  scene: SceneDocument,
  args: CreateEntityArgs,
  content?: ContentDocument,
  reservedIds?: ReadonlySet<string>,
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
    const errors = validateV3ComponentValue(component, value, path, scene.schemaVersion === 4 ? 4 : 3);
    if (errors.length > 0) return { ok: false, error: commandErrorFromModel(errors[0] as ModelErrorV3) };
    if (component === 'modelAnimation') {
      const roleError = animationRoleError(value, content, `${path}/roles`);
      if (roleError !== null) return { ok: false, error: roleError };
    }
  }
  const maxEntities = scene.schemaVersion === 4 ? MAX_ENTITIES_SCENE_V4 : MAX_ENTITIES;
  if (scene.entities.length + 1 > maxEntities) {
    return {
      ok: false,
      error: limitsExceeded('entities', scene.entities.length + 1, maxEntities),
    };
  }
  const newDepth = parentId === null ? 1 : entityDepth(scene, parentId) + 1;
  if (newDepth > MAX_DEPTH) {
    return { ok: false, error: limitsExceeded('depth', newDepth, MAX_DEPTH) };
  }

  if (args.kind === 'folder') {
    // Phase 12: a folder is organisation only; it sits at the root or in a folder.
    if (parentId !== null && !isFolder(byId.get(parentId))) return { ok: false, error: folderParentError('/args/parentId', parentId) };
    const id = nextEntityId(scene, 'folder', reservedIds);
    if (id === undefined) return { ok: false, error: idExhaustion('folder') };
    const folder = {
      id,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(parentId !== null ? { parentId } : {}),
      components: { folder: {} },
    };
    const folderResult = { ...scene, revision: scene.revision + 1, entities: [...scene.entities, folder] };
    const folderGate = gateResultState({ scene, content }, folderResult, content);
    if (!folderGate.ok) return folderGate;
    const created = folderGate.scene.entities.find((e) => e.id === id) as unknown as EntityV3;
    // A folder created with children (a multi-piece model drop): each child
    // goes through the same create path inside the new folder; the whole set
    // is one transaction whose undo deletes the folder subtree.
    let sceneNow = folderGate.scene;
    const children: EntityV3[] = [];
    for (const child of args.children ?? []) {
      const r = applyCreateEntity({ ...sceneNow, revision: scene.revision }, { ...child, parentId: id }, content, reservedIds);
      if (!r.ok) return r;
      sceneNow = r.op.scene;
      const change = r.op.change as CreateEntityChange;
      children.push(deepClone(change.entity));
    }
    return {
      ok: true,
      op: {
        scene: sceneNow,
        change: { type: 'createEntity', id, entity: deepClone(created), ...(children.length > 0 ? { children } : {}) },
        inverse: { kind: 'delete', rootId: id },
        createdId: id,
      },
    };
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
      ? { model: { asset: { assetId: args.model!.asset.assetId }, ...(args.model!.piece !== undefined ? { piece: args.model!.piece } : {}) } }
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

  const id = nextEntityId(scene, derivedPrefix(candidateComponents), reservedIds);
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
  const canonicalEntity = gate.scene.entities.find((e) => e.id === id) as EntityV3;
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
  const currentTransform = current.components.transform;
  if (currentTransform === undefined) {
    return {
      ok: false,
      error: fieldValue('/args/entityId', args.entityId, 'an entity with a transform', 'a folder has no transform; move the objects filed in it instead'),
    };
  }
  const previous = deepClone(currentTransform);
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
    (gate.scene.entities[index] as AnyEntity).components.transform as TransformComponent,
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

  // §23.6 rule 1 (authoring §A4.2): a `content.game`/checkpoint reference
  // inside the closure is refused before application; nothing is cleared.
  const refs = danglingGameReferences(scene as SceneV3, gameOf(content), closureSet0);
  if (refs.length > 0) {
    return { ok: false, error: gameReferenceInUse(closureInArrayOrder(scene, closure), refs) };
  }

  const deletedIds = closureInArrayOrder(scene, closure);
  const indexOf = new Map(scene.entities.map((e, i) => [e.id, i]));
  // §9.1 inverse: entries in pre-deletion array order with indices.
  const entries = deletedIds.map((id) => ({
    index: indexOf.get(id) as number,
    entity: deepClone(byId.get(id) as EntityV3),
  }));

  const closureSet = new Set(closure);
  const nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  // The result is validated together with the (unchanged) content block so
  // the §23.5 game composition rules run.
  const gate = gateResultState({ scene, content }, result, content);
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

// ---- updateEntity (rename / reparent / flags) --------------------------------------

/** The entity's name, parent (null = absent / root) and own flags. */
export function entityHeader(e: { name?: string; parentId?: string; active?: boolean; locked?: boolean; static?: boolean; tags?: number }): EntityHeader {
  return {
    name: e.name ?? null,
    parentId: e.parentId ?? null,
    active: e.active !== false,
    locked: e.locked === true,
    static: e.static === true,
    tags: typeof e.tags === 'number' ? e.tags >>> 0 : 0,
  };
}

/** The header fields that differ between two headers, in field order. */
export function headerChangedFields(previous: EntityHeader, next: EntityHeader): EntityHeaderField[] {
  return (['name', 'parentId', 'active', 'locked', 'static', 'tags'] as const).filter((f) => previous[f] !== next[f]);
}

/**
 * Older records carry a two-field header (name, parentId); the flags and the
 * tag mask default.
 */
export function fullHeader(h: EntityHeader): EntityHeader {
  return {
    name: h.name,
    parentId: h.parentId,
    active: h.active !== false,
    locked: h.locked === true,
    static: h.static === true,
    tags: typeof h.tags === 'number' ? h.tags >>> 0 : 0,
  };
}

/** Write `header` onto an entity record (only non-default flags are stored). */
function writeHeader(entity: Record<string, unknown>, header: EntityHeader): Record<string, unknown> {
  const h = fullHeader(header);
  const { id, name: _n, parentId: _p, active: _a, locked: _l, static: _s, tags: _t, components, ...rest } = entity;
  return {
    id,
    ...(h.name !== null ? { name: h.name } : {}),
    ...(h.parentId !== null ? { parentId: h.parentId } : {}),
    ...(h.active ? {} : { active: false }),
    ...(h.locked ? { locked: true } : {}),
    ...(h.static ? { static: true } : {}),
    ...(h.tags !== 0 ? { tags: h.tags } : {}),
    ...rest,
    components,
  };
}

/**
 * The candidate scene with `id`'s header replaced, its local transform
 * replaced when `transform` is given and, when given, the entities reordered
 * to `order` (the full id order). Null when `id` or an id in `order` is
 * unknown. Shared by the forward op, undo and redo.
 */
export function withEntityHeader(
  scene: SceneDocument,
  id: string,
  header: EntityHeader,
  order: readonly string[] | null,
  transform?: TransformComponent,
): Record<string, unknown> | null {
  const index = scene.entities.findIndex((e) => e.id === id);
  if (index < 0) return null;
  let updated = writeHeader(deepClone(scene.entities[index]) as unknown as Record<string, unknown>, header);
  if (transform !== undefined) {
    updated = { ...updated, components: { ...(updated['components'] as Record<string, unknown>), transform: deepClone(transform) } };
  }
  let entities: unknown[] = [...scene.entities];
  entities[index] = updated;
  if (order !== null) {
    const reordered = reorder(entities, order);
    if (reordered === null) return null;
    entities = reordered;
  }
  return { ...scene, revision: scene.revision + 1, entities };
}

function reorder(entities: readonly unknown[], order: readonly string[]): unknown[] | null {
  if (order.length !== entities.length) return null;
  const byId = new Map(entities.map((e) => [(e as { id: string }).id, e]));
  const reordered = order.map((eid) => byId.get(eid));
  if (reordered.some((e) => e === undefined)) return null;
  return reordered;
}

function isFolder(e: AnyEntity | undefined): boolean {
  return e !== undefined && (e.components as { folder?: unknown }).folder !== undefined;
}

/** A folder may only be filed at the root or in another folder. */
function folderParentError(path: string, parentId: string): CommandError {
  return fieldValue(path, parentId, 'null (root) or the id of a folder', 'a folder sits at the root or inside another folder, never under an object');
}

/** The mask for tag names (matched ignoring case) against the registry. */
export function tagMaskOf(
  names: readonly string[],
  registry: readonly TagDefinition[],
): { ok: true; mask: number } | { ok: false; error: CommandError } {
  let mask = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    const tag = registry.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (tag === undefined) {
      return {
        ok: false,
        error: fieldValue(`/args/tags/${i}`, name, `one of the project's tags: ${registry.map((t) => t.name).join(', ') || '(none defined)'}`, 'unknown tag name (define it in the project tags first)'),
      };
    }
    mask = (mask | (1 << tag.bit)) >>> 0;
  }
  return { ok: true, mask };
}

export function applyUpdateEntity(scene: SceneDocument, args: UpdateEntityArgs, content?: ContentDocument): OpOutcome {
  const index = scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const entity = scene.entities[index] as AnyEntity;
  const previous = entityHeader(entity);
  const next: EntityHeader = {
    name: args.name ?? previous.name,
    parentId: args.parentId !== undefined ? args.parentId : previous.parentId,
    active: args.active ?? previous.active,
    locked: args.locked ?? previous.locked,
    static: args.static ?? previous.static,
    tags: previous.tags,
  };
  if (args.tags !== undefined) {
    // Phase 12 (b): tags are named in the request and stored as the mask.
    const mask = tagMaskOf(args.tags, content?.tags ?? []);
    if (!mask.ok) return { ok: false, error: mask.error };
    next.tags = mask.mask;
  }

  let order: UpdateEntityChange['order'] = null;
  let transform: UpdateEntityChange['transform'];
  if (next.parentId !== previous.parentId) {
    const byId = entitiesById(scene);
    if (next.parentId !== null) {
      const parentIndex = scene.entities.findIndex((e) => e.id === next.parentId);
      if (parentIndex < 0) return { ok: false, error: referenceMissing(next.parentId) };
      const closure = subtreeClosure(scene, args.entityId) ?? [args.entityId];
      if (closure.includes(next.parentId)) {
        return {
          ok: false,
          error: fieldValue('/args/parentId', next.parentId, 'an entity outside the moved subtree', 'an entity cannot become a child of itself or its descendants'),
        };
      }
      if (isFolder(entity) && !isFolder(byId.get(next.parentId))) return { ok: false, error: folderParentError('/args/parentId', next.parentId) };
      // Parent-before-child order: a subtree that sits before its new parent
      // moves to just after it (its internal order is kept).
      if (parentIndex > index) {
        const ids = scene.entities.map((e) => e.id);
        const moving = closureInArrayOrder(scene, closure);
        const movingSet = new Set(moving);
        const rest = ids.filter((eid) => !movingSet.has(eid));
        const at = rest.indexOf(next.parentId) + 1;
        order = { previous: ids, next: [...rest.slice(0, at), ...moving, ...rest.slice(at)] };
      }
    }
    // Phase 12: a reparent keeps the entity where it is in the world.
    const local = entity.components.transform;
    const kept = worldKeepingLocal(byId as ReadonlyMap<string, HierarchyNode>, args.entityId, next.parentId);
    if (local !== undefined && kept !== null && kept !== local) transform = { previous: deepClone(local), next: kept };
  }

  const result = withEntityHeader(scene, args.entityId, next, order?.next ?? null, transform?.next);
  if (result === null) return { ok: false, error: entityNotFound(args.entityId) };
  const gate = content !== undefined ? gateResultState({ scene, content }, result, content) : gateResultState({ scene }, result);
  if (!gate.ok) return gate;

  const change: UpdateEntityChange = {
    type: 'updateEntity',
    id: args.entityId,
    previous,
    next,
    changedFields: headerChangedFields(previous, next),
    order,
  };
  const inverse: UpdateEntityInverse = { kind: 'updateEntity', id: args.entityId, restore: previous, order: order?.previous ?? null };
  if (transform !== undefined) {
    const canonical = (gate.scene.entities[gate.scene.entities.findIndex((e) => e.id === args.entityId)] as AnyEntity).components.transform;
    change.transform = { previous: transform.previous, next: deepClone(canonical ?? transform.next) };
    inverse.transform = deepClone(transform.previous);
  }
  return { ok: true, op: { scene: gate.scene, change, inverse } };
}

// ---- moveEntities (phase 12) --------------------------------------------------------

/**
 * The candidate scene for a move: `order` applied, then each entry's parent
 * and (when not null) local transform written. Shared by the forward op,
 * undo and redo. Null when an id is unknown.
 */
export function withMovedEntities(
  scene: SceneDocument,
  order: readonly string[],
  moves: readonly { id: string; parentId: string | null; transform: TransformComponent | null }[],
): Record<string, unknown> | null {
  let entities: unknown[] = [...scene.entities];
  for (const m of moves) {
    const index = entities.findIndex((e) => (e as { id: string }).id === m.id);
    if (index < 0) return null;
    const current = entities[index] as Record<string, unknown>;
    let updated = writeHeader(deepClone(current), { ...entityHeader(current as { name?: string }), parentId: m.parentId });
    if (m.transform !== null) {
      updated = { ...updated, components: { ...(updated['components'] as Record<string, unknown>), transform: deepClone(m.transform) } };
    }
    entities[index] = updated;
  }
  const reordered = reorder(entities, order);
  if (reordered === null) return null;
  entities = reordered;
  return { ...scene, revision: scene.revision + 1, entities };
}

export function applyMoveEntities(scene: SceneDocument, args: MoveEntitiesArgs, content?: ContentDocument): OpOutcome {
  const byId = entitiesById(scene);
  for (let i = 0; i < args.entityIds.length; i++) {
    const id = args.entityIds[i] as string;
    if (!byId.has(id)) return { ok: false, error: entityNotFound(id) };
  }
  const parentId = args.parentId;
  const beforeId = args.beforeId ?? null;
  if (parentId !== null && !byId.has(parentId)) return { ok: false, error: referenceMissing(parentId) };
  if (beforeId !== null) {
    const before = byId.get(beforeId);
    if (before === undefined) return { ok: false, error: referenceMissing(beforeId) };
    if ((before.parentId ?? null) !== parentId) {
      return { ok: false, error: fieldValue('/args/beforeId', beforeId, 'a child of parentId', 'beforeId must be a sibling under the target parent') };
    }
  }

  // An entity whose ancestor is also named moves with that ancestor.
  const named = new Set(args.entityIds);
  const hasNamedAncestor = (id: string): boolean => {
    const seen = new Set<string>();
    let cur = byId.get(id)?.parentId;
    while (cur !== undefined && !seen.has(cur)) {
      if (named.has(cur)) return true;
      seen.add(cur);
      cur = byId.get(cur)?.parentId;
    }
    return false;
  };
  const ids = scene.entities.map((e) => e.id);
  const roots = ids.filter((id) => named.has(id) && !hasNamedAncestor(id));
  const moving: string[] = [];
  for (const root of roots) {
    const closure = subtreeClosure(scene, root) ?? [root];
    if (parentId !== null && closure.includes(parentId)) {
      return {
        ok: false,
        error: fieldValue('/args/parentId', parentId, 'an entity outside the moved subtrees', 'an entity cannot become a child of itself or its descendants'),
      };
    }
    if (beforeId !== null && closure.includes(beforeId)) {
      return { ok: false, error: fieldValue('/args/beforeId', beforeId, 'an entity that is not moved', 'beforeId cannot be one of the moved entities') };
    }
    if (isFolder(byId.get(root)) && parentId !== null && !isFolder(byId.get(parentId))) {
      return { ok: false, error: folderParentError('/args/parentId', parentId) };
    }
    moving.push(...closureInArrayOrder(scene, closure));
  }

  // The new order: the moved subtrees (in document order) go just before
  // `beforeId`, or after the target parent's last descendant (or at the end
  // for the root). Parents stay before their children.
  const movingSet = new Set(moving);
  const rest = ids.filter((id) => !movingSet.has(id));
  let at: number;
  if (beforeId !== null) at = rest.indexOf(beforeId);
  else if (parentId === null) at = rest.length;
  else {
    const parentClosure = new Set(subtreeClosure(scene, parentId) ?? [parentId]);
    at = rest.indexOf(parentId) + 1;
    while (at < rest.length && parentClosure.has(rest[at] as string)) at++;
  }
  const nextOrder = [...rest.slice(0, at), ...moving, ...rest.slice(at)];

  const nodes = byId as ReadonlyMap<string, HierarchyNode>;
  const entries: MovedEntity[] = roots.map((id) => {
    const e = byId.get(id) as AnyEntity;
    const local = e.components.transform ?? null;
    const kept = local === null ? null : worldKeepingLocal(nodes, id, parentId) ?? local;
    return {
      id,
      previous: { parentId: e.parentId ?? null, transform: local === null ? null : deepClone(local) },
      next: { parentId, transform: kept === null ? null : deepClone(kept) },
    };
  });
  const result = withMovedEntities(
    scene,
    nextOrder,
    entries.map((m) => ({ id: m.id, parentId: m.next.parentId, transform: m.next.transform })),
  );
  if (result === null) return { ok: false, error: entityNotFound(roots[0] ?? '') };
  const gate = content !== undefined ? gateResultState({ scene, content }, result, content) : gateResultState({ scene }, result);
  if (!gate.ok) return gate;

  // Record the canonical transforms the gate produced.
  const after = new Map(gate.scene.entities.map((e) => [e.id, e as AnyEntity]));
  for (const m of entries) {
    const t = after.get(m.id)?.components.transform;
    if (m.next.transform !== null && t !== undefined) m.next.transform = deepClone(t);
  }
  const change: MoveEntitiesChange = {
    type: 'moveEntities',
    parentId,
    beforeId,
    entities: entries,
    order: { previous: ids, next: nextOrder },
  };
  const inverse: MoveEntitiesInverse = {
    kind: 'moveEntities',
    order: ids,
    restore: entries.map((m) => ({ id: m.id, parentId: m.previous.parentId, transform: m.previous.transform })),
  };
  return { ok: true, op: { scene: gate.scene, change, inverse } };
}
