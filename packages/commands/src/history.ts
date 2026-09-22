/**
 * History model — commands.md §8.4/§9 (M1) extended by the M2 content ops
 * (packets 16/21).
 *
 * Per project, in memory only (M1). `entries[0..n-1]` with cursor `c`
 * (§9.1): entries below `c` are applied, entries at or above `c` are the
 * redo tail. Fresh edits truncate `entries[c..n-1]` and append; undo
 * applies `entries[c-1].inverse`; redo re-applies `entries[c].change`
 * forward using the recorded values (no ID re-scan, §8.4).
 *
 * Every entry carries a `change` and an `inverse` in the same vocabulary
 * (§5.3/§9.1). The M1 kinds (`createEntity`/`setTransform`/`deleteEntity`)
 * are unchanged: their forward/inverse application touches only the scene.
 * The content/component/property/settings/trust kinds touch the scene and/or
 * the envelope's `content` block; a `restore: null` value means the record or
 * component did not exist, so the inverse removes it.
 *
 * Inverse/forward application passes through the same pure pipeline as
 * forward ops (result-state re-validation, uniform no-change check): in M1 it
 * is provably valid (the state is exactly the state the entry was applied
 * from, by LIFO), but if validation ever fails the command returns
 * `history_invalid`, changes nothing, and leaves the stacks untouched
 * (§9.4, defensive).
 */

import type {
  BehaviorComponent,
  BehaviorRecord,
  EntityV2,
  GameConfig,
  PrefabDefinition,
  TransformComponent,
  TrustEntry,
} from '@thirdlight/project-model';

import { historyEmpty, historyInvalid, type CommandError } from './errors';
import {
  behaviorOf,
  componentsRecord,
  deepClone,
  emptyContentCatalog,
  gateResultState,
  subtreeClosure,
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
  SetGameConfigChange,
  SetTransformChange,
} from './types';

const COMPONENT_FIELD_ORDER: Record<string, readonly string[]> = {
  box: ['size', 'material'],
  camera: ['type', 'fovY', 'near', 'far'],
  model: ['asset'],
  collider: ['shape'],
  controller: [],
  gameZone: ['role', 'size', 'safeSpawnId', 'activation'],
  playerSpawn: [],
  cameraFollow: ['deadZone', 'smoothing', 'bounds'],
  light: ['type', 'color', 'intensity', 'direction', 'castShadow'],
  surface: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
  modelAnimation: ['assetId', 'version', 'roles'],
};

/** §23.4 canonical top-level order of `content.game` (authoring §A4.2). */
const GAME_CONFIG_FIELDS = [
  'configVersion',
  'title',
  'objective',
  'instructions',
  'playerId',
  'cameraId',
  'spawnId',
  'level',
  'killY',
  'cues',
] as const;

/** Read a component value as `null` when absent (commands.md §5.3). */
function componentOrNull(components: Record<string, unknown>, component: string): unknown | null {
  return components[component] === undefined ? null : deepClone(components[component]);
}

/** Write/remove one component on a cloned entity (commands.md §8.10). */
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

/** §8.14: replaced top-level `content.game` names in canonical order. */
function gameConfigChangedFields(
  before: GameConfig | null,
  after: GameConfig | null,
): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return GAME_CONFIG_FIELDS.filter((f) => !deepEqual(b[f], a[f]));
}

/** The next revision for a content-only entry (commands.md §6.1 step 7). */
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
  scene: SceneDocument,
  content: ContentDocument | undefined,
  change: ChangeData,
  requestId: string,
): ApplyResult {
  // A `restore: null` removal deletes a record; deeper reference breakage is
  // caught by the gate, which reports `history_invalid` rather than a
  // result-scene error (§9.4 defensive).
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

/**
 * Apply a history entry's INVERSE (undo, §8.4/§9.1). `state` must be the
 * state AFTER the entry's forward command (the LIFO invariant). Returns the
 * applied result state + the change data in the applied (inverse) direction,
 * or a `history_invalid` error on defensive failure.
 */
function applyInverse(state: CommandState<SceneDocument>, entry: HistoryEntry): ApplyResult {
  const scene = state.scene;
  const inv = entry.inverse;
  const content = contentOf(state.content);

  if (inv.kind === 'delete') {
    // Undo of a createEntity/instantiatePrefab: subtree deletion at undo time.
    const closure = subtreeClosure(scene, inv.rootId);
    if (closure === null) return { ok: false, error: historyInvalid(entry.requestId) };
    const closureSet = new Set(closure);
    const nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
    const index = new Map(scene.entities.map((e, i) => [e.id, i]));
    const deletedIds = [...closure].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const change: DeleteEntityChange = { type: 'deleteEntity', rootId: inv.rootId, deletedIds };
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
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
    nextEntities[index] = newEntity as unknown as EntityV2;
    const change: SetTransformChange = {
      type: 'setTransform',
      id: inv.id,
      previous: deepClone(current.components.transform),
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
    const result = { ...scene, revision: scene.revision + 1, entities: ents };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (inv.kind === 'publishAsset') {
    const before = content.assets.find((a) => a.assetId === inv.assetId) ?? null;
    const after = inv.restore === null ? null : deepClone(inv.restore);
    const assets = sortedAssets([
      ...content.assets.filter((a) => a.assetId !== inv.assetId),
      ...(after === null ? [] : [after]),
    ]);
    const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
    // §8.5.1: an atomic animated reimport restores the previous FULL
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
      // CC-L-1 (Gate L): restore the FULL recorded previous component
      // (assetId, version, roles), not roles only — the record is rolled
      // back to the previous `currentVersion` in this same transaction, so
      // the old version binding is exactly what keeps the component a valid
      // binding (1 ≤ version ≤ currentVersion, project-model §23.3.6);
      // a roles-only restore would leave the NEW version recorded above the
      // rolled-back record (an invalid binding).
      components['modelAnimation'] = deepClone(anim.previous);
      const nextEntities = [...scene.entities];
      nextEntities[index] = { ...deepClone(current), components } as unknown as EntityV2;
      nextScene = { ...nextScene, entities: nextEntities };
    }
    const change: ChangeData = {
      type: 'publishAsset',
      // The mode records the FORWARD direction: a create is undone by removing
      // its record (`restore: null`); a reimport rolls one version back.
      mode: inv.restore === null ? 'create' : 'reimport',
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

  if (inv.kind === 'setGameConfig') {
    const before = (content.game ?? null) as GameConfig | null;
    const after = inv.restore === null ? null : deepClone(inv.restore);
    const nextContent: ContentDocument = { ...content, game: after };
    const change: SetGameConfigChange = {
      type: 'setGameConfig',
      previous: before,
      next: after,
      changedFields: gameConfigChangedFields(before, after),
    };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
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

  if (inv.kind === 'removePrefab') {
    // Undo of a createPrefab: remove the definition. By LIFO no later command
    // exists, so no instance can still reference it (§8.6.4).
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
    nextEntities[index] = { ...cloned, components } as unknown as EntityV2;
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
 * the declaration resolves (commands.md §5.3: `changedKeys` in declaration
 * order), else in the component's own key order.
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
 * Re-apply a history entry's FORWARD change (redo, §8.4) using the recorded
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

  if (f.type === 'createEntity') {
    if (scene.entities.some((e) => e.id === f.id)) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const nextEntities = [...scene.entities, deepClone(f.entity) as unknown as EntityV2];
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    const change: ChangeData = { type: 'createEntity', id: f.id, entity: deepClone(f.entity) };
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
    nextEntities[index] = newEntity as unknown as EntityV2;
    const change: SetTransformChange = {
      type: 'setTransform',
      id: f.id,
      previous: deepClone(current.components.transform),
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
    const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
    return finish(state, result, state.content, change, entry.requestId);
  }

  if (f.type === 'instantiatePrefab') {
    // Redo of an instantiation: re-insert the recorded entries at their
    // recorded indices with their recorded IDs — no ID re-scan, no new
    // allocation (§8.7.6).
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
    // (never re-capture, §8.6.4).
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
      // CC-L-1 (Gate L): redo re-applies the recorded FULL next component
      // (recorded-value rule, §9.1) — version and roles together, never a
      // roles-only re-point against whatever version the record now holds.
      components['modelAnimation'] = deepClone(f.animation.next);
      const nextEntities = [...scene.entities];
      nextEntities[index] = { ...deepClone(current), components } as unknown as EntityV2;
      nextScene = { ...nextScene, entities: nextEntities };
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

  if (f.type === 'setGameConfig') {
    const before = (content.game ?? null) as GameConfig | null;
    const after = f.next === null ? null : deepClone(f.next);
    const nextContent: ContentDocument = { ...content, game: after };
    const change: SetGameConfigChange = {
      type: 'setGameConfig',
      previous: before,
      next: after,
      changedFields: [...f.changedFields],
    };
    return finish(state, bumped(scene), nextContent, change, entry.requestId);
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
    nextEntities[index] = { ...cloned, components } as unknown as EntityV2;
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
 * Execute `undo` on the command state (§8.4/§9.1): requires `c > 0`,
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
 * Execute `redo` on the command state (§8.4/§9.1): requires `c < n`,
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
 * Record a fresh forward edit (§9.1 table): truncate the redo tail
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

/** Empty initial history (a fresh process starts here, §9.2). */
export function createHistory(): HistoryState {
  return { entries: [], cursor: 0, seq: 1 };
}
