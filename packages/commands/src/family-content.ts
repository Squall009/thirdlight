/**
 * Catalog records and object components: assets, scripts and their trust,
 * properties, components (and the brushes that store one), settings, tags
 * and asset options. Each op's step and the undo and redo of what it records.
 */

import type { OpFamily } from './op-table-types';
import {
  applyAcknowledgeBehaviorTrust,
  applyPublishAsset,
  applyPublishBehavior,
  applySetBehaviorProperties,
  applySetComponent,
  applySetSettings,
  contentOf,
} from './content-ops';
import { applyDeleteAsset, applyDeleteBehavior, applyRevokeBehaviorTrust } from './delete-content-ops';
import { applySetAssetOptions } from './asset-options-ops';
import { applySetTags } from './tag-ops';
import { applyApplySurfacePreset } from './v3-ops';
import { applyPaintInstances } from './instance-stroke-ops';
import { applyPaintVertices } from './vertex-paint-ops';
import { applyColliderFromModel } from './collider-model-ops';
import { historyInvalid } from './errors';
import { behaviorChangedKeys, bumped, componentChangedFields, componentOrNull, finish, requireEntity, sortedAssets, sortedBehaviors, writeComponent } from './history-steps';
import { behaviorOf, componentsRecord, deepClone, type AnyEntity } from './ops';
import { deepEqual } from './properties';
import type { BehaviorComponent, EntityV3, TrustEntry } from '@thirdlight/project-model';
import type { ApplySurfacePresetChange, ChangeData, ContentDocument, SceneDocument } from './types';

export const contentFamily = {
  ops: {
    publishAsset: { apply: (input, args) => applyPublishAsset(input, args), records: [['publishAsset', 'publishAsset']] },
    publishBehavior: { apply: (input, args) => applyPublishBehavior(input, args), records: [['publishBehavior', 'publishBehavior']] },
    setBehaviorProperties: { apply: (input, args) => applySetBehaviorProperties(input, args), records: [['setBehaviorProperties', 'setBehaviorProperties']] },
    setComponent: { apply: (input, args) => applySetComponent(input, args), records: [['setComponent', 'setComponent']] },
    setSettings: { apply: (input, args) => applySetSettings(input, args), records: [['setSettings', 'setSettings']] },
    acknowledgeBehaviorTrust: { apply: (input, args) => applyAcknowledgeBehaviorTrust(input, args), records: [['acknowledgeBehaviorTrust', 'acknowledgeBehaviorTrust']] },
    // Remove a catalog record or a trust entry (refused while anything references it).
    deleteAsset: { apply: (input, args) => applyDeleteAsset(input, args), records: [['removeAsset', 'publishAsset']] },
    deleteBehavior: { apply: (input, args) => applyDeleteBehavior(input, args), records: [['publishBehavior', 'publishBehavior']] },
    revokeBehaviorTrust: { apply: (input, args) => applyRevokeBehaviorTrust(input, args), records: [['acknowledgeBehaviorTrust', 'acknowledgeBehaviorTrust']] },
    setAssetOptions: { apply: (input, args) => applySetAssetOptions(input, args), records: [['setAssetOptions', 'setAssetOptions']] },
    setTags: { apply: (input, args) => applySetTags(input, args), records: [['setTags', 'setTags']] },
    applySurfacePreset: { apply: (input, args) => applyApplySurfacePreset(input, args), records: [['applySurfacePreset', 'setComponent']] },
    // One brush stroke: the set's buffer the host planned and published, stored in one change (one undo).
    paintInstances: { apply: (input, args, state) => applyPaintInstances(input, args, state.preparedInstanceStroke), records: [['setComponent', 'setComponent']] },
    // One vertex paint stroke: the paint the host planned and published, stored in one change (one undo).
    paintVertices: { apply: (input, args, state) => applyPaintVertices(input, args, state.preparedVertexPaint), records: [['setComponent', 'setComponent']] },
    // The collider the host made from the object's model file, stored as one setComponent change (one undo).
    colliderFromModel: { apply: (input, args, state) => applyColliderFromModel(input, args, state.preparedModelCollider), records: [['setComponent', 'setComponent']] },
  },
  undo: {
    publishAsset: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
    publishBehavior: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
    setBehaviorProperties: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
    setComponent: (state, entry, inv) => {
      const scene = state.scene;
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
    },
    setAssetOptions: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = content.assets.find((a) => a.assetId === inv.assetId);
      if (before === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
      const after = deepClone(inv.restore);
      const assets = sortedAssets([...content.assets.filter((a) => a.assetId !== inv.assetId), after]);
      const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
      const change: ChangeData = { type: 'setAssetOptions', assetId: inv.assetId, previous: deepClone(before), next: deepClone(after) };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    setTags: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = deepClone(content.tags ?? []);
      const after = deepClone(inv.restore);
      const change: ChangeData = { type: 'setTags', previous: before, next: after };
      return finish(state, bumped(scene), { ...content, tags: after }, change, entry.requestId);
    },
    setSettings: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = deepClone(content.settings);
      const after = deepClone(inv.restore);
      const nextContent: ContentDocument = { ...content, settings: after };
      const changedKeys = Object.keys(after)
        .filter((k) => !deepEqual(after[k], before[k]))
        .sort();
      const change: ChangeData = { type: 'setSettings', previous: before, next: after, changedKeys };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    acknowledgeBehaviorTrust: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
  },
  redo: {
    removeAsset: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // Redo of a deleteAsset.
      if (!content.assets.some((a) => a.assetId === f.assetId)) return { ok: false, error: historyInvalid(entry.requestId) };
      const nextContent: ContentDocument = { ...content, assets: content.assets.filter((a) => a.assetId !== f.assetId) };
      const change: ChangeData = { type: 'removeAsset', assetId: f.assetId, previous: deepClone(f.previous) };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    publishAsset: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
    applySurfacePreset: (state, entry, f) => {
      const scene = state.scene;
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
    },
    publishBehavior: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
    setBehaviorProperties: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
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
    },
    setComponent: (state, entry, f) => {
      const scene = state.scene;
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
    },
    setAssetOptions: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = content.assets.find((a) => a.assetId === f.assetId);
      if (before === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
      const after = deepClone(f.next);
      const assets = sortedAssets([...content.assets.filter((a) => a.assetId !== f.assetId), after]);
      const nextContent: ContentDocument = { ...content, assets: assets as unknown as ContentDocument['assets'] };
      const change: ChangeData = { type: 'setAssetOptions', assetId: f.assetId, previous: deepClone(before), next: deepClone(after) };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    setTags: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = deepClone(content.tags ?? []);
      const after = deepClone(f.next);
      const change: ChangeData = { type: 'setTags', previous: before, next: after };
      return finish(state, bumped(scene), { ...content, tags: after }, change, entry.requestId);
    },
    setSettings: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = deepClone(content.settings);
      const after = deepClone(f.next);
      const nextContent: ContentDocument = { ...content, settings: after };
      const changedKeys = Object.keys(after)
        .filter((k) => !deepEqual(after[k], before[k]))
        .sort();
      const change: ChangeData = { type: 'setSettings', previous: before, next: after, changedKeys };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    acknowledgeBehaviorTrust: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const after = deepClone(f.next) as readonly TrustEntry[];
      const nextContent: ContentDocument = { ...content, behaviorTrust: { entries: [...after] } };
      const change: ChangeData = {
        type: 'acknowledgeBehaviorTrust',
        sourceDigest: f.sourceDigest,
        previous: deepClone(content.behaviorTrust.entries),
        next: after,
      };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
  },
} satisfies OpFamily;
