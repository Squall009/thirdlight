/**
 * The steps undo and redo share across op families: re-gating a result
 * state, the record sort orders, and the entity, header, move and scene-look
 * writes several entry kinds replay.
 */

import { scenePlaneOf, withScenePlane } from './scene-plane-ops';
import { replayLinkEdit } from './prefab-link-replay';
import type { PrefabLinkEditChange } from './prefab-link-types';
import { COMPONENT_FIELD_ORDER } from './v3';
import type { PlaneLock, SceneEnvironment } from '@thirdlight/project-model';
import { withSceneEnvironment } from './material-ops';
import type { BehaviorComponent, BehaviorRecord, PrefabDefinition, TransformComponent } from '@thirdlight/project-model';
import { contentOf } from './content-ops';
import { historyInvalid } from './errors';
import {
  componentsRecord,
  deepClone,
  entityHeader,
  headerChangedFields,
  fullHeader,
  withMovedEntities,
  gateResultState,
  withEntityHeader,
  type AnyEntity,
} from './ops';
import { deepEqual } from './properties';
import type { ApplyResult } from './op-table-types';
import type {
  ChangeData,
  CommandAssetRecord,
  CommandState,
  ContentDocument,
  HistoryEntry,
  MoveEntitiesChange,
  MovedEntity,
  RemovePrefabChange,
  SceneDocument,
  EntityHeader,
  UpdateEntityChange,
} from './types';

/** Read a component value as `null` when absent. */
export function componentOrNull(components: Record<string, unknown>, component: string): unknown | null {
  return components[component] === undefined ? null : deepClone(components[component]);
}

/** Write/remove one component on a cloned entity. */
export function writeComponent(entity: AnyEntity, component: string, value: unknown | null): AnyEntity {
  const cloned = deepClone(entity);
  const components = { ...componentsRecord(cloned) };
  if (value === null) delete components[component];
  else components[component] = deepClone(value);
  return { ...cloned, components } as unknown as AnyEntity;
}

/** Canonical changed-field list for a setComponent edit/add/remove. */
export function componentChangedFields(
  component: string,
  before: unknown | null,
  after: unknown | null,
): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return ((COMPONENT_FIELD_ORDER as Record<string, readonly string[] | undefined>)[component] ?? Object.keys(a ?? {})).filter(
    (f) => !deepEqual(b[f], a[f]),
  );
}

/** The scene index of a v4 content block. */
export function sceneIndexOf(content: ContentDocument): { scenes: { sceneId: string; name: string }[]; startScenes: string[] } {
  const c = content as { scenes?: { sceneId: string; name: string }[]; startScenes?: string[] };
  return { scenes: deepClone(c.scenes ?? []), startScenes: [...(c.startScenes ?? [])] };
}

/** The next revision for a content-only entry. */
export function bumped(scene: SceneDocument): SceneDocument {
  return { ...scene, revision: scene.revision + 1 };
}

export function sortedAssets(assets: CommandAssetRecord[]): CommandAssetRecord[] {
  return [...assets].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

export function sortedBehaviors(behaviors: BehaviorRecord[]): BehaviorRecord[] {
  return [...behaviors].sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
}

export function sortedPrefabs(prefabs: PrefabDefinition[]): PrefabDefinition[] {
  return [...prefabs].sort((a, b) => (a.prefabId < b.prefabId ? -1 : a.prefabId > b.prefabId ? 1 : 0));
}

/** Re-gate the mutated state (steps 5–6) and wrap the result. */
export function finish(
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

/** A prefab removed from the catalog (the undo of a capture, the redo of a delete). */
export function removePrefabOf(state: CommandState<SceneDocument>, content: ContentDocument, prefabId: string, requestId: string): ApplyResult {
  const nextContent: ContentDocument = { ...content, prefabs: content.prefabs.filter((d) => d.prefabId !== prefabId) };
  const change: RemovePrefabChange = { type: 'removePrefab', prefabId };
  return finish(state, bumped(state.scene), nextContent, change, requestId);
}

/** Undo or redo of a linked-copy change: one side of the recorded objects (and prefabs) for the other. */
export function replayLinked(state: CommandState<SceneDocument>, entry: HistoryEntry, forward: boolean): ApplyResult {
  const r = replayLinkEdit(state.scene, contentOf(state.content), entry.change as PrefabLinkEditChange, forward);
  if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
  return finish(state, r.scene, r.content ?? state.content, r.change, entry.requestId);
}

export function requireEntity(scene: SceneDocument, id: string): number {
  return scene.entities.findIndex((e) => e.id === id);
}

/** Re-apply an entity header (+ order) and describe it as an updateEntity change. */
export function applyHeader(
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
export function applyMove(
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

/** One scene's look set to `look` (null: none), for an undo or a redo routed to that scene. */
export function sceneLookTo(state: CommandState<SceneDocument>, sceneId: string, look: SceneEnvironment | null, requestId: string): ApplyResult {
  const before = (state.scene as { environment?: SceneEnvironment }).environment ?? null;
  const change: ChangeData = { type: 'setEnvironment', sceneId, previous: before === null ? null : deepClone(before), next: look === null ? null : deepClone(look) };
  return finish(state, bumped(withSceneEnvironment(state.scene, look)), contentOf(state.content), change, requestId);
}

/** One scene's default plane set to `plane` (null: none), for an undo or a redo routed to that scene. */
export function scenePlaneTo(state: CommandState<SceneDocument>, sceneId: string, plane: PlaneLock | null, requestId: string): ApplyResult {
  const change: ChangeData = { type: 'setScenePlane', sceneId, previous: scenePlaneOf(state.scene), next: plane === null ? null : { ...plane } };
  return finish(state, bumped(withScenePlane(state.scene, plane)), contentOf(state.content), change, requestId);
}


/**
 * Keys that differ between two behavior components, in declaration order when
 * the declaration resolves (`changedKeys` is in declaration order), else in the component's own key order.
 */
export function behaviorChangedKeys(
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