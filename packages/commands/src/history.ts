/**
 * History model, for the entity and the content ops.
 *
 * Per project, in memory only. `entries[0..n-1]` with cursor `c`:
 * entries below `c` are applied, entries at or above `c` are the
 * redo tail. Fresh edits truncate `entries[c..n-1]` and append; undo
 * applies `entries[c-1].inverse`; redo re-applies `entries[c].change`
 * forward using the recorded values (no ID re-scan).
 *
 * Every entry carries a `change` and an `inverse` in the same vocabulary.
 * The entity kinds (`createEntity`/`setTransform`/`deleteEntity`) touch
 * only the scene.
 * The content/component/property/settings/trust kinds touch the scene and/or
 * the envelope's `content` block; a `restore: null` value means the record or
 * component did not exist, so the inverse removes it.
 *
 * Inverse/forward application passes through the same pure pipeline as
 * forward ops (result-state re-validation, uniform no-change check): it
 * is normally valid (the state is exactly the state the entry was applied
 * from, by LIFO), but if validation ever fails the command returns
 * `history_invalid`, changes nothing, and leaves the stacks untouched
 * (defensive).
 */

import type { AnimatorController, EnvironmentConfig, InputConfig, LightingBake, MaterialDef } from '@thirdlight/project-model';
import { withAnimator, withEnvironment, withInput, withLighting, withMaterial } from './material-ops';
import { withCollisionLayers } from './layer-ops';
import { withSaveSchema } from './save-schema-ops';
import { editOwnerGraph, withGraphDocument } from './graph-ops';
import { effectsOf, withEffect } from './effect-ops';
import { uiOf, withUi } from './ui-ops';
import { dialogueValueOf, withDialogueValue } from './dialogue-ops';
import { behaviorGroupsOf, eventCuesOf, modesOf, shellOf, withBehaviorGroups, withEventCues, withModes, withShell } from './mode-ops';
import { timelineOf, withTimeline } from './timeline-ops';
import { scriptLibrariesOf, withBehaviorRecords, withScriptLibrary } from './script-library-ops';
import { blockStampsOf, blockTypesOf, cellFieldsOf, layerDataOf, layerDelta, withBlockStamp, withBlockType, withCellFields, withLayerData, withoutLayersOf } from './block-ops';
import type { GraphDocument } from '@thirdlight/project-model';
import type {
  BehaviorComponent,
  BehaviorRecord,
  EntityV3,
  PrefabDefinition,
  TransformComponent,
  TrustEntry,
} from '@thirdlight/project-model';

import { historyEmpty, historyInvalid, type CommandError } from './errors';
import { redoImportAssets, undoImportAssets } from './import-assets';
import {
  behaviorOf,
  componentsRecord,
  deepClone,
  emptyContentCatalog,
  entityHeader,
  headerChangedFields,
  fullHeader,
  withMovedEntities,
  gateResultState,
  subtreeClosure,
  withEntityHeader,
  type AnyEntity,
} from './ops';
import { deepEqual } from './properties';
import type {
  ApplySurfacePresetChange,
  ChangeData,
  CommandAssetRecord,
  CommandState,
  ContentDocument,
  CreatePrefabChange,
  SceneDocument,
  DeleteEntityChange,
  ForwardChange,
  HistoryEntry,
  HistoryState,
  InstantiatePrefabChange,
  RemovePrefabChange,
  RestoreSubtreeChange,
  SetTransformChange,
  EntityHeader,
  UpdateEntityChange,
  MoveEntitiesChange,
  MovedEntity,
} from './types';

const COMPONENT_FIELD_ORDER: Record<string, readonly string[]> = {
  box: ['size', 'material', 'castShadow', 'receiveShadow'],
  camera: ['type', 'fovY', 'near', 'far'],
  model: ['asset', 'piece', 'castShadow', 'receiveShadow'],
  collider: ['shape'],
  controller: ['capsule', 'acceleration', 'deceleration', 'coyoteTime', 'jumpBuffer', 'jumpRelease', 'groundSnap', 'skin', 'autostep', 'autostepHeight', 'walkSpeed', 'runSpeed', 'airControl', 'gravityScale', 'jump', 'jumpSpeed', 'slopeLimit', 'stepHeight', 'ledgeClimb', 'ledgeHeight', 'ledgeClimbTime', 'turnSpeed', 'faceMovement', 'moveAction', 'jumpAction', 'climbSpeed', 'climbAction', 'wallSlide', 'wallSlideSpeed', 'wallJump', 'wallJumpAway', 'wallJumpUp', 'wallJumpLock'],
  playerSpawn: ['yaw'],
  light: ['type', 'color', 'intensity', 'direction', 'castShadow', 'shadowMapSize', 'shadowBias', 'shadowNormalBias', 'shadowExtent'],
  surface: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
  modelAnimation: ['assetId', 'version', 'roles'],
  effect: ['effectId', 'playOnStart', 'params', 'signal', 'stopSignal'],
};

/** Read a component value as `null` when absent. */
function componentOrNull(components: Record<string, unknown>, component: string): unknown | null {
  return components[component] === undefined ? null : deepClone(components[component]);
}

/** Write/remove one component on a cloned entity. */
function writeComponent(entity: AnyEntity, component: string, value: unknown | null): AnyEntity {
  const cloned = deepClone(entity);
  const components = { ...componentsRecord(cloned) };
  if (value === null) delete components[component];
  else components[component] = deepClone(value);
  return { ...cloned, components } as unknown as AnyEntity;
}

/** Canonical changed-field list for a setComponent edit/add/remove. */
function componentChangedFields(
  component: string,
  before: unknown | null,
  after: unknown | null,
): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return (COMPONENT_FIELD_ORDER[component] ?? Object.keys(a ?? {})).filter(
    (f) => !deepEqual(b[f], a[f]),
  );
}

/** The scene index of a v4 content block. */
function sceneIndexOf(content: ContentDocument): { scenes: { sceneId: string; name: string }[]; startScenes: string[] } {
  const c = content as { scenes?: { sceneId: string; name: string }[]; startScenes?: string[] };
  return { scenes: deepClone(c.scenes ?? []), startScenes: [...(c.startScenes ?? [])] };
}

/** The next revision for a content-only entry. */
function bumped(scene: SceneDocument): SceneDocument {
  return { ...scene, revision: scene.revision + 1 };
}

function contentOf(content: ContentDocument | undefined): ContentDocument {
  return content ?? emptyContentCatalog();
}

function sortedAssets(assets: CommandAssetRecord[]): CommandAssetRecord[] {
  return [...assets].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

function sortedBehaviors(behaviors: BehaviorRecord[]): BehaviorRecord[] {
  return [...behaviors].sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
}

function sortedPrefabs(prefabs: PrefabDefinition[]): PrefabDefinition[] {
  return [...prefabs].sort((a, b) => (a.prefabId < b.prefabId ? -1 : a.prefabId > b.prefabId ? 1 : 0));
}

/** Result of one inverse/forward application. */
interface AppliedState {
  scene: SceneDocument;
  content?: ContentDocument;
  change: ChangeData;
}

type ApplyResult =
  | { ok: true; applied: AppliedState }
  | { ok: false; error: CommandError };

/** Re-gate the mutated state (steps 5–6) and wrap the result. */
function finish(
  state: CommandState<SceneDocument>,
  scene: unknown,
  content: ContentDocument | undefined,
  change: ChangeData,
  requestId: string,
): ApplyResult {
  // A `restore: null` removal deletes a record; deeper reference breakage is
  // caught by the gate, which reports `history_invalid` rather than a
  // result-scene error (defensive).
  const gate = gateResultState(
    { scene: state.scene, content: state.content, manifest: state.manifest },
    scene,
    content,
  );
  if (!gate.ok) return { ok: false, error: historyInvalid(requestId) };
  return { ok: true, applied: { scene: gate.scene, content: gate.content, change } };
}

function requireEntity(scene: SceneDocument, id: string): number {
  return scene.entities.findIndex((e) => e.id === id);
}

/** Re-apply an entity header (+ order) and describe it as an updateEntity change. */
function applyHeader(
  state: CommandState<SceneDocument>,
  id: string,
  header: EntityHeader,
  order: readonly string[] | null,
  requestId: string,
  transform?: TransformComponent,
): ApplyResult {
  const scene = state.scene;
  const current = scene.entities.find((e) => e.id === id);
  if (current === undefined) return { ok: false, error: historyInvalid(requestId) };
  // Older records carry a two-field header; the flags default.
  const next: EntityHeader = fullHeader(header);
  const result = withEntityHeader(scene, id, next, order, transform);
  if (result === null) return { ok: false, error: historyInvalid(requestId) };
  const previous = entityHeader(current as AnyEntity);
  const change: UpdateEntityChange = {
    type: 'updateEntity',
    id,
    previous,
    next,
    changedFields: headerChangedFields(previous, next),
    order: order === null ? null : { previous: scene.entities.map((e) => e.id), next: [...order] },
  };
  const before = (current as AnyEntity).components.transform;
  if (transform !== undefined && before !== undefined) change.transform = { previous: deepClone(before), next: deepClone(transform) };
  return finish(state, result, state.content, change, requestId);
}

/** Apply a move (forward or its inverse) and describe it as a `moveEntities` change. */
function applyMove(
  state: CommandState<SceneDocument>,
  order: readonly string[],
  moves: readonly { id: string; parentId: string | null; transform: TransformComponent | null }[],
  parentId: string | null,
  beforeId: string | null,
  requestId: string,
): ApplyResult {
  const scene = state.scene;
  const byId = new Map(scene.entities.map((e) => [e.id, e as AnyEntity]));
  const entities: MovedEntity[] = [];
  for (const m of moves) {
    const e = byId.get(m.id);
    if (e === undefined) return { ok: false, error: historyInvalid(requestId) };
    const t = e.components.transform;
    entities.push({
      id: m.id,
      previous: { parentId: e.parentId ?? null, transform: t === undefined ? null : deepClone(t) },
      next: { parentId: m.parentId, transform: m.transform === null ? null : deepClone(m.transform) },
    });
  }
  const result = withMovedEntities(scene, order, moves);
  if (result === null) return { ok: false, error: historyInvalid(requestId) };
  const change: MoveEntitiesChange = {
    type: 'moveEntities',
    parentId,
    beforeId,
    entities,
    order: { previous: scene.entities.map((e) => e.id), next: [...order] },
  };
  return finish(state, result, state.content, change, requestId);
}

/**
 * Apply a history entry's INVERSE (undo). `state` must be the
 * state AFTER the entry's forward command (the LIFO invariant). Returns the
 * applied result state + the change data in the applied (inverse) direction,
 * or a `history_invalid` error on defensive failure.
 */
function applyInverse(state: CommandState<SceneDocument>, entry: HistoryEntry): ApplyResult {
  const scene = state.scene;
  const inv = entry.inverse;
  const content = contentOf(state.content);

  if (inv.kind === 'updateEntity') return applyHeader(state, inv.id, inv.restore, inv.order, entry.requestId, inv.transform);
  if (inv.kind === 'moveEntities') {
    const f = entry.change as MoveEntitiesChange;
    return applyMove(state, inv.order, inv.restore, f.entities[0]?.previous.parentId ?? null, null, entry.requestId);
  }

  if (inv.kind === 'delete') {
    // Undo of a createEntity/instantiatePrefab: subtree deletion at undo time.
    const closure = subtreeClosure(scene, inv.rootId);
    if (closure === null) return { ok: false, error: historyInvalid(entry.requestId) };
    const closureSet = new Set(closure);
    const nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
    const index = new Map(scene.entities.map((e, i) => [e.id, i]));
    const deletedIds = [...closure].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const change: DeleteEntityChange = { type: 'deleteEntity', rootId: inv.rootId, deletedIds };
    const result = { ...withoutLayersOf(scene, closureSet).scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (inv.kind === 'setTransform') {
    const index = requireEntity(scene, inv.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const restore: TransformComponent = {
      position: [...inv.restore.position],
      rotation: [...inv.restore.rotation],
      scale: [...inv.restore.scale],
    };
    const cloned = deepClone(current);
    const newEntity = { ...cloned, components: { ...cloned.components, transform: restore } };
    const nextEntities = [...scene.entities];
    nextEntities[index] = newEntity as unknown as EntityV3;
    const change: SetTransformChange = {
      type: 'setTransform',
      id: inv.id,
      previous: deepClone(current.components.transform as TransformComponent),
      next: deepClone(restore),
      changedFields: ['position', 'rotation', 'scale'],
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (inv.kind === 'restoreSubtree') {
    let ents: AnyEntity[] = deepClone(scene.entities) as AnyEntity[];
    for (const e of inv.entries) {
      if (
        typeof e.index !== 'number' ||
        !Number.isInteger(e.index) ||
        e.index < 0 ||
        e.index > ents.length
      ) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
      ents.splice(e.index, 0, deepClone(e.entity) as AnyEntity);
    }
    const rootEntry = inv.entries[0];
    if (rootEntry === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
    if ((rootEntry.entity.parentId ?? null) !== inv.restoredParentId) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const change: RestoreSubtreeChange = {
      type: 'restoreSubtree',
      rootId: rootEntry.entity.id,
      entities: inv.entries.map((e) => deepClone(e.entity)),
    };
    // The deleted block layers' cells come back with them.
    let restored: SceneDocument = scene;
    for (const b of inv.blocks ?? []) restored = withLayerData(restored, b.entityId, b);
    const result = { ...restored, revision: scene.revision + 1, entities: ents };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (inv.kind === 'importAssets') {
    if (entry.change.type !== 'importAssets') return { ok: false, error: historyInvalid(entry.requestId) };
    const r = undoImportAssets(scene, content, inv, entry.change);
    if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
    return finish(state, r.scene, r.content, r.change, entry.requestId);
  }

  if (inv.kind === 'publishAsset') {
    const before = content.assets.find((a) => a.assetId === inv.assetId) ?? null;
    const after = inv.restore === null ? null : deepClone(inv.restore);
    const assets = sortedAssets([
      ...content.assets.filter((a) => a.assetId !== inv.assetId),
      ...(after === null ? [] : [after]),
    ]);
    const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
    // An atomic animated reimport restores the previous FULL
    // `modelAnimation` component in the same transaction; the recorded
    // forward change carries it.
    const anim = entry.change.type === 'publishAsset' ? entry.change.animation : undefined;
    let nextScene = bumped(scene);
    if (anim !== undefined) {
      const index = requireEntity(scene, anim.entityId);
      if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
      const current = scene.entities[index] as AnyEntity;
      const components = { ...componentsRecord(current) };
      const component = components['modelAnimation'] as Record<string, unknown> | undefined;
      if (component === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
      // Restore the FULL recorded previous component
      // (assetId, version, roles), not roles only — the record is rolled
      // back to the previous `currentVersion` in this same transaction, so
      // the old version binding is exactly what keeps the component a valid
      // binding (1 ≤ version ≤ currentVersion);
      // a roles-only restore would leave the NEW version recorded above the
      // rolled-back record (an invalid binding).
      components['modelAnimation'] = deepClone(anim.previous);
      const nextEntities = [...scene.entities];
      nextEntities[index] = { ...deepClone(current), components } as unknown as EntityV3;
      nextScene = { ...nextScene, entities: nextEntities } as SceneDocument;
    }
    const change: ChangeData = {
      type: 'publishAsset',
      // The mode records the FORWARD direction: a create is undone by removing
      // its record (`restore: null`); a reimport rolls one version back.
      // The undo of a deleteAsset brings the record back (none before it): a create.
      mode: inv.restore === null || before === null ? 'create' : 'reimport',
      assetId: inv.assetId,
      previous: before === null ? null : deepClone(before),
      next: after,
      ...(anim === undefined
        ? {}
        : {
            animation: {
              entityId: anim.entityId,
              previous: deepClone(anim.next),
              next: deepClone(anim.previous),
            },
          }),
    };
    return finish(state, nextScene, nextContent, change, entry.requestId);
  }

  if (inv.kind === 'publishBehavior') {
    const before = content.behaviors.find((b) => b.behaviorId === inv.behaviorId) ?? null;
    const after = inv.restore === null ? null : deepClone(inv.restore);
    const behaviors = sortedBehaviors([
      ...content.behaviors.filter((b) => b.behaviorId !== inv.behaviorId),
      ...(after === null ? [] : [after]),
    ]);
    const nextContent: ContentDocument = { ...content, behaviors };
    const change: ChangeData = {
      type: 'publishBehavior',
      behaviorId: inv.behaviorId,
      previous: before === null ? null : deepClone(before),
      next: after,
    };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (inv.kind === 'restorePrefab') {
    // Undo of a deletePrefab puts the definition back verbatim.
    if (content.prefabs.some((d) => d.prefabId === inv.prefabId)) return { ok: false, error: historyInvalid(entry.requestId) };
    const nextContent: ContentDocument = { ...content, prefabs: sortedPrefabs([...content.prefabs, deepClone(inv.definition)]) };
    const change: CreatePrefabChange = { type: 'createPrefab', prefabId: inv.prefabId, definition: deepClone(inv.definition) };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (inv.kind === 'removePrefab') {
    // Undo of a createPrefab: remove the definition. By LIFO no later command
    // exists, so no instance can still reference it.
    const prefabs = content.prefabs.filter((d) => d.prefabId !== inv.prefabId);
    const nextContent: ContentDocument = { ...content, prefabs };
    const change: RemovePrefabChange = { type: 'removePrefab', prefabId: inv.prefabId };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (inv.kind === 'setBehaviorProperties') {
    const index = requireEntity(scene, inv.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const currentBehavior = behaviorOf(current);
    const before: BehaviorComponent | null =
      currentBehavior !== undefined ? deepClone(currentBehavior) : null;
    const after = inv.restore === null ? null : deepClone(inv.restore);
    const cloned = deepClone(current);
    const components: Record<string, unknown> = { ...componentsRecord(cloned) };
    if (after === null) delete components['behavior'];
    else components['behavior'] = after;
    const nextEntities = [...scene.entities];
    nextEntities[index] = { ...cloned, components } as unknown as EntityV3;
    const change: ChangeData = {
      type: 'setBehaviorProperties',
      id: inv.id,
      previous: before,
      next: after,
      changedKeys: behaviorChangedKeys(content, before, after),
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (inv.kind === 'setComponent') {
    const index = requireEntity(scene, inv.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const components = componentsRecord(current);
    const before = componentOrNull(components, inv.component);
    const after = inv.restore === null ? null : deepClone(inv.restore);
    const nextEntity = writeComponent(current, inv.component, after);
    const nextEntities = [...scene.entities];
    nextEntities[index] = nextEntity;
    const changedFields = componentChangedFields(inv.component, before, after);
    const change: ChangeData = {
      type: 'setComponent',
      id: inv.id,
      component: inv.component,
      previous: before,
      next: after,
      changedFields,
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (inv.kind === 'setSceneIndex') {
    const before = sceneIndexOf(content);
    const after = deepClone(inv.restore);
    const change: ChangeData = { type: 'setSceneIndex', previous: before, next: after };
    return finish(state, bumped(scene), { ...content, scenes: after.scenes, startScenes: after.startScenes } as ContentDocument, change, entry.requestId);
  }

  if (inv.kind === 'setMaterial') {
    const now = ((content as { materials?: MaterialDef[] }).materials ?? []).find((m) => m.materialId === inv.materialId);
    const change: ChangeData = { type: 'setMaterial', materialId: inv.materialId, previous: now !== undefined ? deepClone(now) : null, next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withMaterial(content, inv.materialId, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setEnvironment') {
    const before = (content as { environment?: EnvironmentConfig }).environment ?? null;
    const change: ChangeData = { type: 'setEnvironment', previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withEnvironment(content, inv.restore), change, entry.requestId);
  }


  if (inv.kind === 'setModes') {
    // The game modes back to what they were.
    const before = modesOf(content);
    const change: ChangeData = { type: 'setModes', previous: deepClone(before), next: deepClone(inv.restore) };
    return finish(state, bumped(scene), withModes(content, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setBehaviorGroups') {
    const before = behaviorGroupsOf(content);
    const change: ChangeData = { type: 'setBehaviorGroups', previous: [...before], next: [...inv.restore] };
    return finish(state, bumped(scene), withBehaviorGroups(content, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setShell') {
    // The game shell back to what it was.
    const before = shellOf(content);
    const change: ChangeData = { type: 'setShell', previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withShell(content, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setEventCues') {
    // The event → cue table back to what it was.
    const before = eventCuesOf(content);
    const change: ChangeData = { type: 'setEventCues', previous: deepClone(before), next: deepClone(inv.restore) };
    return finish(state, bumped(scene), withEventCues(content, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setSaveSchema') {
    const before = (content as { saveSchema?: import('@thirdlight/project-model').SaveSchema }).saveSchema ?? null;
    const change: ChangeData = { type: 'setSaveSchema', previous: before === null ? null : structuredClone(before), next: inv.restore === null ? null : structuredClone(inv.restore) };
    return finish(state, bumped(scene), withSaveSchema(content, inv.restore), change, entry.requestId);
  }
  if (inv.kind === 'setCollisionLayers') {
    const before = (content as { collisionLayers?: string[] }).collisionLayers ?? [];
    const change: ChangeData = { type: 'setCollisionLayers', previous: [...before], next: [...inv.restore] };
    return finish(state, bumped(scene), withCollisionLayers(content, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setInput') {
    const before = (content as { input?: InputConfig }).input ?? null;
    const change: ChangeData = { type: 'setInput', previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withInput(content, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'graphEdit') {
    const r = editOwnerGraph(content, inv.owner, inv.ops);
    if (!r.ok) return { ok: false, error: historyInvalid(entry.requestId) };
    const change: ChangeData = { type: 'graphEdit', owner: { ...inv.owner }, ops: deepClone(inv.ops) };
    return finish(state, bumped(scene), r.content, change, entry.requestId);
  }

  if (inv.kind === 'setGraph') {
    const before = ((content as { graphs?: GraphDocument[] }).graphs ?? []).find((g) => g.graphId === inv.graphId) ?? null;
    const change: ChangeData = { type: 'setGraph', graphId: inv.graphId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withGraphDocument(content, inv.graphId, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setScriptLibrary') {
    // The library and the dependents recompiled with it move back together.
    const before = scriptLibrariesOf(content).find((l) => l.libraryId === inv.libraryId) ?? null;
    const behaviors = inv.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.restore), next: deepClone(b.restore) }));
    const change: ChangeData = { type: 'setScriptLibrary', libraryId: inv.libraryId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore), behaviors };
    return finish(state, bumped(scene), withBehaviorRecords(withScriptLibrary(content, inv.libraryId, inv.restore), inv.behaviors.map((b) => b.restore)), change, entry.requestId);
  }

  if (inv.kind === 'setScriptLibraries') {
    // Every library of a staged commit and the dependents recompiled with them move back together.
    let next = content;
    const libraries = inv.libraries.map((l) => {
      const before = scriptLibrariesOf(content).find((x) => x.libraryId === l.libraryId) ?? null;
      next = withScriptLibrary(next, l.libraryId, l.restore);
      return { libraryId: l.libraryId, previous: before === null ? null : deepClone(before), next: l.restore === null ? null : deepClone(l.restore) };
    });
    const behaviors = inv.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.restore), next: deepClone(b.restore) }));
    const change: ChangeData = { type: 'setScriptLibraries', libraries, behaviors };
    return finish(state, bumped(scene), withBehaviorRecords(next, inv.behaviors.map((b) => b.restore)), change, entry.requestId);
  }

  if (inv.kind === 'setTimeline') {
    // One timeline back to what it was.
    const before = timelineOf(content, inv.timelineId);
    const change: ChangeData = { type: 'setTimeline', timelineId: inv.timelineId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withTimeline(content, inv.timelineId, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setUi') {
    // One UI document or theme back to what it was.
    const before = uiOf(content, inv.uiKind, inv.id);
    const change: ChangeData = { type: 'setUi', uiKind: inv.uiKind, id: inv.id, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withUi(content, inv.uiKind, inv.id, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setDialogue') {
    // One conversation, speaker or the settings back to what it was.
    const before = dialogueValueOf(content, inv.dialogueKind, inv.id);
    const change: ChangeData = { type: 'setDialogue', dialogueKind: inv.dialogueKind, id: inv.id, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withDialogueValue(content, inv.dialogueKind, inv.id, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setEffect') {
    const before = effectsOf(content).find((e) => e.effectId === inv.effectId) ?? null;
    const change: ChangeData = { type: 'setEffect', effectId: inv.effectId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withEffect(content, inv.effectId, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setAnimator') {
    const now = ((content as { animators?: AnimatorController[] }).animators ?? []).find((c) => c.controllerId === inv.controllerId);
    const change: ChangeData = { type: 'setAnimator', controllerId: inv.controllerId, previous: now !== undefined ? deepClone(now) : null, next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withAnimator(content, inv.controllerId, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'setLighting') {
    const before = ((content as { lighting?: Record<string, LightingBake> }).lighting ?? {})[inv.sceneId] ?? null;
    const change: ChangeData = { type: 'setLighting', sceneId: inv.sceneId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withLighting(content, inv.sceneId, inv.restore), change, entry.requestId);
  }

  if (inv.kind === 'removeEntities') {
    const gone = new Set(inv.ids);
    if (!inv.ids.every((id) => scene.entities.some((e) => e.id === id))) return { ok: false, error: historyInvalid(entry.requestId) };
    const nextEntities = scene.entities.filter((e) => !gone.has(e.id));
    const change: DeleteEntityChange = { type: 'deleteEntity', rootId: inv.ids[0] ?? '', deletedIds: [...inv.ids] };
    return finish(state, { ...withoutLayersOf(scene, gone).scene, revision: scene.revision + 1, entities: nextEntities }, state.content, change, entry.requestId);
  }

  if (inv.kind === 'setAssetOptions') {
    const before = content.assets.find((a) => a.assetId === inv.assetId);
    if (before === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
    const after = deepClone(inv.restore);
    const assets = sortedAssets([...content.assets.filter((a) => a.assetId !== inv.assetId), after]);
    const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
    const change: ChangeData = { type: 'setAssetOptions', assetId: inv.assetId, previous: deepClone(before), next: deepClone(after) };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (inv.kind === 'setTags') {
    const before = deepClone(content.tags ?? []);
    const after = deepClone(inv.restore);
    const change: ChangeData = { type: 'setTags', previous: before, next: after };
    return finish(state, bumped(scene), { ...content, tags: after }, change, entry.requestId);
  }

  if (inv.kind === 'setSettings') {
    const before = deepClone(content.settings);
    const after = deepClone(inv.restore);
    const nextContent: ContentDocument = { ...content, settings: after };
    const changedKeys = Object.keys(after)
      .filter((k) => !deepEqual(after[k], before[k]))
      .sort();
    const change: ChangeData = { type: 'setSettings', previous: before, next: after, changedKeys };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  // Block layers (cells restored as whole layer entries; content items by id).
  if (inv.kind === 'editBlocks') {
    const before = layerDataOf(scene, inv.entityId);
    const delta = layerDelta(before, inv.restore);
    const change: ChangeData = { type: 'editBlocks', entityId: inv.entityId, chunks: delta.chunks, regions: delta.regions, cells: 0 };
    return finish(state, { ...withLayerData(scene, inv.entityId, inv.restore), revision: scene.revision + 1 }, state.content, change, entry.requestId);
  }
  if (inv.kind === 'setBlockType') {
    const before = blockTypesOf(content).find((t) => t.blockId === inv.blockId) ?? null;
    const change: ChangeData = { type: 'setBlockType', blockId: inv.blockId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withBlockType(content, inv.blockId, inv.restore), change, entry.requestId);
  }
  if (inv.kind === 'setCellFields') {
    const change: ChangeData = { type: 'setCellFields', previous: deepClone(cellFieldsOf(content)), next: deepClone(inv.restore) };
    return finish(state, bumped(scene), withCellFields(content, inv.restore), change, entry.requestId);
  }
  if (inv.kind === 'setBlockStamp') {
    const before = blockStampsOf(content).find((x) => x.stampId === inv.stampId) ?? null;
    const change: ChangeData = { type: 'setBlockStamp', stampId: inv.stampId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
    return finish(state, bumped(scene), withBlockStamp(content, inv.stampId, inv.restore), change, entry.requestId);
  }

  // acknowledgeBehaviorTrust
  const before = deepClone(content.behaviorTrust.entries);
  const after = deepClone(inv.restore);
  const nextContent: ContentDocument = { ...content, behaviorTrust: { entries: [...after] } };
  const change: ChangeData = {
    type: 'acknowledgeBehaviorTrust',
    sourceDigest: inv.sourceDigest,
    previous: before,
    next: after,
  };
  return finish(state, bumped(scene), nextContent, change, entry.requestId);
}

/**
 * Keys that differ between two behavior components, in declaration order when
 * the declaration resolves (`changedKeys` is in declaration order), else in the component's own key order.
 */
function behaviorChangedKeys(
  content: ContentDocument,
  before: BehaviorComponent | null,
  after: BehaviorComponent | null,
): string[] {
  const behaviorId = after?.behaviorId ?? before?.behaviorId;
  const declaration = content.behaviors.find((b) => b.behaviorId === behaviorId)?.declaration;
  const keys =
    declaration !== undefined
      ? declaration.properties.map((p) => p.key)
      : [...new Set([...Object.keys(before?.values ?? {}), ...Object.keys(after?.values ?? {})])];
  const has = (v: Record<string, unknown> | undefined, k: string): boolean =>
    v !== undefined && Object.prototype.hasOwnProperty.call(v, k);
  return keys.filter((k) => {
    const beforeHas = has(before?.values, k);
    const afterHas = has(after?.values, k);
    if (beforeHas !== afterHas) return true; // added or removed key
    return !deepEqual(after?.values?.[k], before?.values?.[k]);
  });
}

/**
 * Re-apply a history entry's FORWARD change (redo) using the recorded
 * values: a redo of a create re-inserts the recorded entity value at the end
 * of the array with its original ID (no ID re-scan); a redo of a setTransform
 * replaces the recorded fields with the recorded `next` values; a redo of a
 * delete removes the recorded `deletedIds`; content entries re-apply their
 * recorded `next`/added values.
 */
function applyForward(state: CommandState<SceneDocument>, entry: HistoryEntry): ApplyResult {
  const scene = state.scene;
  const content = contentOf(state.content);
  const f = entry.change;

  if (f.type === 'updateEntity') return applyHeader(state, f.id, f.next, f.order?.next ?? null, entry.requestId, f.transform?.next);
  if (f.type === 'moveEntities') {
    return applyMove(
      state,
      f.order.next,
      f.entities.map((m) => ({ id: m.id, parentId: m.next.parentId, transform: m.next.transform })),
      f.parentId,
      f.beforeId,
      entry.requestId,
    );
  }

  if (f.type === 'createEntity') {
    const created = [f.entity, ...(f.children ?? [])];
    if (scene.entities.some((e) => created.some((c) => c.id === e.id))) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const nextEntities = [...scene.entities, ...created.map((c) => deepClone(c) as unknown as EntityV3)];
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    const change: ChangeData = {
      type: 'createEntity',
      id: f.id,
      entity: deepClone(f.entity),
      ...(f.children !== undefined ? { children: f.children.map((c) => deepClone(c)) } : {}),
    };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'setTransform') {
    const index = requireEntity(scene, f.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const next: TransformComponent = {
      position: [...f.next.position],
      rotation: [...f.next.rotation],
      scale: [...f.next.scale],
    };
    const cloned = deepClone(current);
    const newEntity = { ...cloned, components: { ...cloned.components, transform: next } };
    const nextEntities = [...scene.entities];
    nextEntities[index] = newEntity as unknown as EntityV3;
    const change: SetTransformChange = {
      type: 'setTransform',
      id: f.id,
      previous: deepClone(current.components.transform as TransformComponent),
      next: deepClone(next),
      changedFields: [...f.changedFields],
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'deleteEntity') {
    const byId = new Map(scene.entities.map((e) => [e.id, e]));
    for (const id of f.deletedIds) {
      if (!byId.has(id)) return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const gone = new Set(f.deletedIds);
    const nextEntities = scene.entities.filter((e) => !gone.has(e.id));
    const change: DeleteEntityChange = {
      type: 'deleteEntity',
      rootId: f.rootId,
      deletedIds: [...f.deletedIds],
    };
    // A deleted block layer takes its cells along.
    const result = { ...withoutLayersOf(scene, gone).scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'instantiatePrefab') {
    // Redo of an instantiation: re-insert the recorded entries at their
    // recorded indices with their recorded IDs — no ID re-scan, no new
    // allocation.
    const ents = deepClone(scene.entities) as unknown as AnyEntity[];
    const existing = new Set(ents.map((e) => e.id));
    for (const en of f.entries) {
      if (
        !Number.isInteger(en.index) ||
        en.index < 0 ||
        en.index > ents.length ||
        existing.has(en.entity.id)
      ) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
      ents.splice(en.index, 0, deepClone(en.entity) as unknown as AnyEntity);
      existing.add(en.entity.id);
    }
    const result = { ...scene, revision: scene.revision + 1, entities: ents };
    const change: InstantiatePrefabChange = {
      type: 'instantiatePrefab',
      prefabId: f.prefabId,
      rootId: f.rootId,
      entries: f.entries.map((e) => ({ index: e.index, entity: deepClone(e.entity) })),
      mapping: f.mapping.map((m) => ({ ...m })),
    };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'createPrefab') {
    // Redo of a capture: re-insert the recorded definition value verbatim
    // (never re-capture).
    if (content.prefabs.some((d) => d.prefabId === f.prefabId)) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const prefabs = sortedPrefabs([...content.prefabs, deepClone(f.definition)]);
    const nextContent: ContentDocument = { ...content, prefabs };
    const change: CreatePrefabChange = {
      type: 'createPrefab',
      prefabId: f.prefabId,
      definition: deepClone(f.definition),
    };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (f.type === 'importAssets') {
    const r = redoImportAssets(scene, content, f);
    if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
    return finish(state, r.scene, r.content, r.change, entry.requestId);
  }

  if (f.type === 'removeAsset') {
    // Redo of a deleteAsset.
    if (!content.assets.some((a) => a.assetId === f.assetId)) return { ok: false, error: historyInvalid(entry.requestId) };
    const nextContent: ContentDocument = { ...content, assets: content.assets.filter((a) => a.assetId !== f.assetId) };
    const change: ChangeData = { type: 'removeAsset', assetId: f.assetId, previous: deepClone(f.previous) };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (f.type === 'removePrefab') {
    // Redo of a deletePrefab.
    if (!content.prefabs.some((d) => d.prefabId === f.prefabId)) return { ok: false, error: historyInvalid(entry.requestId) };
    const nextContent: ContentDocument = { ...content, prefabs: content.prefabs.filter((d) => d.prefabId !== f.prefabId) };
    const change: RemovePrefabChange = { type: 'removePrefab', prefabId: f.prefabId };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (f.type === 'publishAsset') {
    const next = f.next === null ? null : deepClone(f.next);
    const assets = sortedAssets([
      ...content.assets.filter((a) => a.assetId !== f.assetId),
      ...(next === null ? [] : [next]),
    ]);
    const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
    let nextScene = bumped(scene);
    if (f.animation !== undefined) {
      const index = requireEntity(scene, f.animation.entityId);
      if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
      const current = scene.entities[index] as AnyEntity;
      const components = { ...componentsRecord(current) };
      const component = components['modelAnimation'] as Record<string, unknown> | undefined;
      if (component === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
      // Redo re-applies the recorded FULL next component
      // (recorded-value rule) — version and roles together, never a
      // roles-only re-point against whatever version the record now holds.
      components['modelAnimation'] = deepClone(f.animation.next);
      const nextEntities = [...scene.entities];
      nextEntities[index] = { ...deepClone(current), components } as unknown as EntityV3;
      nextScene = { ...nextScene, entities: nextEntities } as SceneDocument;
    }
    const change: ChangeData = {
      type: 'publishAsset',
      mode: f.mode,
      assetId: f.assetId,
      previous: f.previous === null ? null : deepClone(f.previous),
      next,
      ...(f.animation === undefined
        ? {}
        : {
            animation: {
              entityId: f.animation.entityId,
              previous: deepClone(f.animation.previous),
              next: deepClone(f.animation.next),
            },
          }),
    };
    return finish(state, nextScene, nextContent, change, entry.requestId);
  }

  if (f.type === 'applySurfacePreset') {
    // Redo re-applies the recorded `next` surface value (recorded-value rule),
    // never the preset lookup.
    const index = requireEntity(scene, f.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const before = componentOrNull(componentsRecord(current), 'surface');
    const after = f.next === null ? null : deepClone(f.next);
    const nextEntity = writeComponent(current, 'surface', after);
    const nextEntities = [...scene.entities];
    nextEntities[index] = nextEntity;
    const change: ApplySurfacePresetChange = {
      type: 'applySurfacePreset',
      id: f.id,
      preset: f.preset,
      previous: before,
      next: after,
      changedFields: [...f.changedFields],
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'publishBehavior') {
    const next = f.next === null ? null : deepClone(f.next);
    const behaviors = sortedBehaviors([
      ...content.behaviors.filter((b) => b.behaviorId !== f.behaviorId),
      ...(next === null ? [] : [next]),
    ]);
    const nextContent: ContentDocument = { ...content, behaviors };
    const change: ChangeData = {
      type: 'publishBehavior',
      behaviorId: f.behaviorId,
      previous: f.previous === null ? null : deepClone(f.previous),
      next,
    };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (f.type === 'setBehaviorProperties') {
    const index = requireEntity(scene, f.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const currentBehavior = behaviorOf(current);
    const before: BehaviorComponent | null =
      currentBehavior !== undefined ? deepClone(currentBehavior) : null;
    const after = f.next === null ? null : deepClone(f.next);
    const cloned = deepClone(current);
    const components: Record<string, unknown> = { ...componentsRecord(cloned) };
    if (after === null) delete components['behavior'];
    else components['behavior'] = after;
    const nextEntities = [...scene.entities];
    nextEntities[index] = { ...cloned, components } as unknown as EntityV3;
    const change: ChangeData = {
      type: 'setBehaviorProperties',
      id: f.id,
      previous: before,
      next: after,
      changedKeys: behaviorChangedKeys(content, before, after),
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'setComponent') {
    const index = requireEntity(scene, f.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as AnyEntity;
    const components = componentsRecord(current);
    const before = componentOrNull(components, f.component);
    const after = f.next === null ? null : deepClone(f.next);
    const nextEntity = writeComponent(current, f.component, after);
    const nextEntities = [...scene.entities];
    nextEntities[index] = nextEntity;
    const changedFields = componentChangedFields(f.component, before, after);
    const change: ChangeData = {
      type: 'setComponent',
      id: f.id,
      component: f.component,
      previous: before,
      next: after,
      changedFields,
    };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'setSceneIndex') {
    const before = sceneIndexOf(content);
    const after = deepClone(f.next);
    const change: ChangeData = { type: 'setSceneIndex', previous: before, next: after };
    return finish(state, bumped(scene), { ...content, scenes: after.scenes, startScenes: after.startScenes } as ContentDocument, change, entry.requestId);
  }

  if (f.type === 'setMaterial') {
    const now = ((content as { materials?: MaterialDef[] }).materials ?? []).find((m) => m.materialId === f.materialId);
    const change: ChangeData = { type: 'setMaterial', materialId: f.materialId, previous: now !== undefined ? deepClone(now) : null, next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withMaterial(content, f.materialId, f.next), change, entry.requestId);
  }

  if (f.type === 'setEnvironment') {
    const before = (content as { environment?: EnvironmentConfig }).environment ?? null;
    const change: ChangeData = { type: 'setEnvironment', previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withEnvironment(content, f.next), change, entry.requestId);
  }


  if (f.type === 'setModes') {
    const before = modesOf(content);
    const change: ChangeData = { type: 'setModes', previous: deepClone(before), next: deepClone(f.next) };
    return finish(state, bumped(scene), withModes(content, f.next), change, entry.requestId);
  }

  if (f.type === 'setBehaviorGroups') {
    const before = behaviorGroupsOf(content);
    const change: ChangeData = { type: 'setBehaviorGroups', previous: [...before], next: [...f.next] };
    return finish(state, bumped(scene), withBehaviorGroups(content, f.next), change, entry.requestId);
  }

  if (f.type === 'setShell') {
    const before = shellOf(content);
    const change: ChangeData = { type: 'setShell', previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withShell(content, f.next), change, entry.requestId);
  }

  if (f.type === 'setEventCues') {
    const before = eventCuesOf(content);
    const change: ChangeData = { type: 'setEventCues', previous: deepClone(before), next: deepClone(f.next) };
    return finish(state, bumped(scene), withEventCues(content, f.next), change, entry.requestId);
  }

  if (f.type === 'setSaveSchema') {
    const before = (content as { saveSchema?: import('@thirdlight/project-model').SaveSchema }).saveSchema ?? null;
    const change: ChangeData = { type: 'setSaveSchema', previous: before === null ? null : structuredClone(before), next: f.next === null ? null : structuredClone(f.next) };
    return finish(state, bumped(scene), withSaveSchema(content, f.next), change, entry.requestId);
  }
  if (f.type === 'setCollisionLayers') {
    const before = (content as { collisionLayers?: string[] }).collisionLayers ?? [];
    const change: ChangeData = { type: 'setCollisionLayers', previous: [...before], next: [...f.next] };
    return finish(state, bumped(scene), withCollisionLayers(content, f.next), change, entry.requestId);
  }

  if (f.type === 'setInput') {
    const before = (content as { input?: InputConfig }).input ?? null;
    const change: ChangeData = { type: 'setInput', previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withInput(content, f.next), change, entry.requestId);
  }

  if (f.type === 'graphEdit') {
    const r = editOwnerGraph(content, f.owner, f.ops);
    if (!r.ok) return { ok: false, error: historyInvalid(entry.requestId) };
    const change: ChangeData = { type: 'graphEdit', owner: { ...f.owner }, ops: deepClone(f.ops) };
    return finish(state, bumped(scene), r.content, change, entry.requestId);
  }

  if (f.type === 'setGraph') {
    const before = ((content as { graphs?: GraphDocument[] }).graphs ?? []).find((g) => g.graphId === f.graphId) ?? null;
    const change: ChangeData = { type: 'setGraph', graphId: f.graphId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withGraphDocument(content, f.graphId, f.next), change, entry.requestId);
  }

  if (f.type === 'setScriptLibrary') {
    const before = scriptLibrariesOf(content).find((l) => l.libraryId === f.libraryId) ?? null;
    const behaviors = f.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.previous), next: deepClone(b.next) }));
    const change: ChangeData = { type: 'setScriptLibrary', libraryId: f.libraryId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next), behaviors };
    return finish(state, bumped(scene), withBehaviorRecords(withScriptLibrary(content, f.libraryId, f.next), f.behaviors.map((b) => b.next)), change, entry.requestId);
  }

  if (f.type === 'setScriptLibraries') {
    let next = content;
    const libraries = f.libraries.map((l) => {
      const before = scriptLibrariesOf(content).find((x) => x.libraryId === l.libraryId) ?? null;
      next = withScriptLibrary(next, l.libraryId, l.next);
      return { libraryId: l.libraryId, previous: before === null ? null : deepClone(before), next: l.next === null ? null : deepClone(l.next) };
    });
    const behaviors = f.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.previous), next: deepClone(b.next) }));
    const change: ChangeData = { type: 'setScriptLibraries', libraries, behaviors };
    return finish(state, bumped(scene), withBehaviorRecords(next, f.behaviors.map((b) => b.next)), change, entry.requestId);
  }

  if (f.type === 'setTimeline') {
    const before = timelineOf(content, f.timelineId);
    const change: ChangeData = { type: 'setTimeline', timelineId: f.timelineId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withTimeline(content, f.timelineId, f.next), change, entry.requestId);
  }

  if (f.type === 'setUi') {
    const before = uiOf(content, f.uiKind, f.id);
    const change: ChangeData = { type: 'setUi', uiKind: f.uiKind, id: f.id, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withUi(content, f.uiKind, f.id, f.next), change, entry.requestId);
  }

  if (f.type === 'setDialogue') {
    const before = dialogueValueOf(content, f.dialogueKind, f.id);
    const change: ChangeData = { type: 'setDialogue', dialogueKind: f.dialogueKind, id: f.id, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withDialogueValue(content, f.dialogueKind, f.id, f.next), change, entry.requestId);
  }

  if (f.type === 'setEffect') {
    const before = effectsOf(content).find((e) => e.effectId === f.effectId) ?? null;
    const change: ChangeData = { type: 'setEffect', effectId: f.effectId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withEffect(content, f.effectId, f.next), change, entry.requestId);
  }

  if (f.type === 'setAnimator') {
    const now = ((content as { animators?: AnimatorController[] }).animators ?? []).find((c) => c.controllerId === f.controllerId);
    const change: ChangeData = { type: 'setAnimator', controllerId: f.controllerId, previous: now !== undefined ? deepClone(now) : null, next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withAnimator(content, f.controllerId, f.next), change, entry.requestId);
  }

  if (f.type === 'setLighting') {
    const before = ((content as { lighting?: Record<string, LightingBake> }).lighting ?? {})[f.sceneId] ?? null;
    const change: ChangeData = { type: 'setLighting', sceneId: f.sceneId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withLighting(content, f.sceneId, f.next), change, entry.requestId);
  }

  if (f.type === 'pasteEntities') {
    if (scene.entities.some((e) => f.entities.some((c) => c.id === e.id))) return { ok: false, error: historyInvalid(entry.requestId) };
    const nextEntities = [...scene.entities, ...f.entities.map((c) => deepClone(c) as unknown as EntityV3)];
    const change: ChangeData = { type: 'pasteEntities', entities: f.entities.map((c) => deepClone(c)) };
    return finish(state, { ...scene, revision: scene.revision + 1, entities: nextEntities }, state.content, change, entry.requestId);
  }

  if (f.type === 'setAssetOptions') {
    const before = content.assets.find((a) => a.assetId === f.assetId);
    if (before === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
    const after = deepClone(f.next);
    const assets = sortedAssets([...content.assets.filter((a) => a.assetId !== f.assetId), after]);
    const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
    const change: ChangeData = { type: 'setAssetOptions', assetId: f.assetId, previous: deepClone(before), next: deepClone(after) };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  if (f.type === 'setTags') {
    const before = deepClone(content.tags ?? []);
    const after = deepClone(f.next);
    const change: ChangeData = { type: 'setTags', previous: before, next: after };
    return finish(state, bumped(scene), { ...content, tags: after }, change, entry.requestId);
  }

  if (f.type === 'setSettings') {
    const before = deepClone(content.settings);
    const after = deepClone(f.next);
    const nextContent: ContentDocument = { ...content, settings: after };
    const changedKeys = Object.keys(after)
      .filter((k) => !deepEqual(after[k], before[k]))
      .sort();
    const change: ChangeData = { type: 'setSettings', previous: before, next: after, changedKeys };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
  }

  // Block layers — redo re-applies the recorded layer entry / content item.
  if (f.type === 'editBlocks') {
    const inv = entry.inverse as import('./types').EditBlocksInverse;
    const before = layerDataOf(scene, f.entityId);
    const delta = layerDelta(before, inv.next);
    const change: ChangeData = { type: 'editBlocks', entityId: f.entityId, chunks: delta.chunks, regions: delta.regions, cells: f.cells };
    return finish(state, { ...withLayerData(scene, f.entityId, inv.next), revision: scene.revision + 1 }, state.content, change, entry.requestId);
  }
  if (f.type === 'setBlockType') {
    const before = blockTypesOf(content).find((t) => t.blockId === f.blockId) ?? null;
    const change: ChangeData = { type: 'setBlockType', blockId: f.blockId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withBlockType(content, f.blockId, f.next), change, entry.requestId);
  }
  if (f.type === 'setCellFields') {
    const change: ChangeData = { type: 'setCellFields', previous: deepClone(cellFieldsOf(content)), next: deepClone(f.next) };
    return finish(state, bumped(scene), withCellFields(content, f.next), change, entry.requestId);
  }
  if (f.type === 'setBlockStamp') {
    const before = blockStampsOf(content).find((x) => x.stampId === f.stampId) ?? null;
    const change: ChangeData = { type: 'setBlockStamp', stampId: f.stampId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
    return finish(state, bumped(scene), withBlockStamp(content, f.stampId, f.next), change, entry.requestId);
  }

  // acknowledgeBehaviorTrust
  const after = deepClone(f.next) as readonly TrustEntry[];
  const nextContent: ContentDocument = { ...content, behaviorTrust: { entries: [...after] } };
  const change: ChangeData = {
    type: 'acknowledgeBehaviorTrust',
    sourceDigest: f.sourceDigest,
    previous: deepClone(content.behaviorTrust.entries),
    next: after,
  };
  return finish(state, bumped(scene), nextContent, change, entry.requestId);
}

/** Undo/redo outcome: the new state pieces plus the applied-direction change. */
export interface HistoryOutcome {
  scene: SceneDocument;
  content?: ContentDocument;
  history: HistoryState;
  change: ChangeData;
  appliedOf: string;
  originOfApplied: HistoryEntry['origin'];
}

/**
 * Execute `undo` on the command state: requires `c > 0`,
 * applies `entries[c-1].inverse`, `c--`. Returns the new state + the
 * applied-direction change data, or a structured error.
 */
export function executeUndo(
  state: CommandState<SceneDocument>,
): { ok: true; outcome: HistoryOutcome } | { ok: false; error: CommandError } {
  const history = state.history;
  if (history.cursor === 0) return { ok: false, error: { ...historyEmpty('undo') } };
  const entry = history.entries[history.cursor - 1] as HistoryEntry;
  const applied = applyInverse(state, entry);
  if (!applied.ok) return applied;
  return {
    ok: true,
    outcome: {
      scene: applied.applied.scene,
      content: applied.applied.content,
      history: { ...history, cursor: history.cursor - 1 },
      change: applied.applied.change,
      appliedOf: entry.requestId,
      originOfApplied: entry.origin,
    },
  };
}

/**
 * Execute `redo` on the command state: requires `c < n`,
 * re-applies `entries[c].change` forward (recorded values), `c++`.
 */
export function executeRedo(
  state: CommandState<SceneDocument>,
): { ok: true; outcome: HistoryOutcome } | { ok: false; error: CommandError } {
  const history = state.history;
  if (history.cursor >= history.entries.length) {
    return { ok: false, error: { ...historyEmpty('redo') } };
  }
  const entry = history.entries[history.cursor] as HistoryEntry;
  const applied = applyForward(state, entry);
  if (!applied.ok) return applied;
  return {
    ok: true,
    outcome: {
      scene: applied.applied.scene,
      content: applied.applied.content,
      history: { ...history, cursor: history.cursor + 1 },
      change: applied.applied.change,
      appliedOf: entry.requestId,
      originOfApplied: entry.origin,
    },
  };
}

/**
 * Record a fresh forward edit: truncate the redo tail
 * `entries[c..n-1]` (fresh edits invalidate redo), append the entry, `c++`,
 * assign the next diagnostic seq.
 */
export function recordForwardEdit(
  history: HistoryState,
  entry: HistoryEntry,
): HistoryState {
  const kept = history.entries.slice(0, history.cursor);
  return {
    entries: [...kept, entry],
    cursor: history.cursor + 1,
    seq: history.seq + 1,
  };
}

/** Empty initial history (a fresh process starts here). */
export function createHistory(): HistoryState {
  return { entries: [], cursor: 0, seq: 1 };
}
