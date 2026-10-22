/**
 * What every render derives from all entities, memoised on the entity list
 * (the same array until an entity changes), so a selection, a panel toggle or
 * a gesture frame does not walk 16k entities: the selected entity (with a
 * running gesture's transform), the hierarchy flags (recomputed with the
 * tree's shape only), the tag, collision layer and behavior group usage, and
 * the pickers' field context. The edit-mode effect preview follows the
 * selection's effect.
 */
import type * as THREE from 'three';
import { useEffect, useMemo, type MutableRefObject } from 'react';
import type { DescriptorRegistry, EffectComponent } from '@thirdlight/project-model';
import type { SessionClient } from '../../session/client';
import type { ProjectedEntity } from '../../session/projection';
import { effectiveFlagsOf } from '../../session/hierarchy';
import { collectSignals } from '../../session/descriptor-fields';
import type { FieldContext } from '../DescriptorFields';
import type { ClientRef, ViewportRef } from './commands';
import type { useProjectContent } from './useProjectContent';
import type { useProjectSettings } from './useProjectSettings';
import type { useAnimatorTools } from './useAnimatorTools';

/** The first asset or index item of some kinds the catalog has read (a starting choice), if any. */
function firstOfKinds(c: SessionClient | null, kinds: readonly string[]): string | undefined {
  return c?.catalog.firstOf(kinds);
}

/** The pickers' option per projected entity object (see fieldContextBase). */
const entityOptionCache = new WeakMap<ProjectedEntity, { id: string; name: string; sceneId?: string; components: string[] }>();

type Content = ReturnType<typeof useProjectContent>;
type Settings = ReturnType<typeof useProjectSettings>;

export interface EntityIndexesDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  loadTextureRef: MutableRefObject<((assetId: string) => Promise<THREE.Texture | null>) | null>;
  entities: ProjectedEntity[];
  selectedId: string | null;
  liveTransform: { id: string; position: number[]; rotation: number[]; scale: number[] } | null;
  content: Pick<Content, 'materials' | 'animators' | 'effects' | 'behaviorViews' | 'prefabSummaries'>;
  registry: DescriptorRegistry | null;
  settings: Pick<Settings, 'settings' | 'behaviorGroups' | 'modes' | 'lightLayers'>;
  animator: Pick<ReturnType<typeof useAnimatorTools>, 'modelNodesOf' | 'modelSkinnedOf'>;
  effectPreview: boolean;
}

export function useEntityIndexes(deps: EntityIndexesDeps) {
  const { clientRef, viewportRef, loadTextureRef, entities, selectedId, liveTransform, registry, effectPreview } = deps;
  const { materials, animators, effects, behaviorViews, prefabSummaries } = deps.content;
  const { settings, behaviorGroups, modes, lightLayers } = deps.settings;
  const { modelNodesOf, modelSkinnedOf } = deps.animator;
  const selectedEntity = useMemo(() => {
    const base = selectedId === null ? null : (entities.find((e) => e.id === selectedId) ?? null);
    if (base === null || liveTransform === null || liveTransform.id !== base.id) return base;
    const t = { position: liveTransform.position, rotation: liveTransform.rotation, scale: liveTransform.scale };
    return { ...base, ...t, components: base.components['transform'] !== undefined ? { ...base.components, transform: t } : base.components };
  }, [entities, selectedId, liveTransform]);
  // The tree's shape (entities added or removed, parents, order, names, flags, kinds) and the open scenes.
  // The edit-mode effect preview follows the toggle, the selection's effect component and the effects.
  const selectedEffect = selectedEntity !== null ? (selectedEntity.components['effect'] as EffectComponent | undefined) : undefined;
  const selectedEffectKey = selectedEffect !== undefined && selectedEntity !== null ? `${selectedEntity.id}|${JSON.stringify(selectedEffect)}` : '';
  useEffect(() => {
    const target = selectedEffect !== undefined && selectedEntity !== null ? { id: selectedEntity.id, component: selectedEffect } : null;
    viewportRef.current?.setEffectPreview(effectPreview, effects as never, target, loadTextureRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the selected effect is keyed by selectedEffectKey so unrelated entity edits don't rebuild the preview
  }, [effectPreview, effects, selectedEffectKey]);
  const structureKey = `${clientRef.current?.projection.structureVersion ?? 0}|${clientRef.current?.getSceneView().open.join(',') ?? ''}`;
  // Flags depend on parents and own flags only: recomputed with the shape, not on every transform edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- flags depend on the shape (structureKey), not on transform edits
  const hierarchyFlags = useMemo(() => effectiveFlagsOf(entities), [structureKey, entities.length]);
  const tagUsage = useMemo(() => {
    const usage = new Map<number, number>();
    for (const e of entities) {
      if (e.tags === 0) continue;
      for (let bit = 0; bit < 32; bit++) if ((e.tags & (1 << bit)) !== 0) usage.set(bit, (usage.get(bit) ?? 0) + 1);
    }
    return usage;
  }, [entities]);
  /** How many colliders list each collision layer ("default": those listing none). */
  const layerUsage = useMemo(() => {
    const usage = new Map<string, number>();
    for (const e of entities) {
      if (e.collider === undefined) continue;
      const layers = (e.collider as { layers?: unknown }).layers;
      for (const name of Array.isArray(layers) ? (layers as string[]) : ['default']) usage.set(name, (usage.get(name) ?? 0) + 1);
    }
    return usage;
  }, [entities]);
  const allEntities = clientRef.current?.projection.listEntities() ?? entities;
  const projectScenes = clientRef.current?.projection.scenes;
  const fieldContextBase = useMemo(
    () => ({
      // The first asset or index item of some kinds (a starting choice), when it is known.
      firstOf: (kinds: readonly string[]) => firstOfKinds(clientRef.current, kinds),
      entities: allEntities.map((e) => {
        // One option object per entity object (copy-on-write: kept until the entity changes).
        let o = entityOptionCache.get(e);
        if (o === undefined) {
          o = { id: e.id, name: e.name, ...(e.sceneId !== undefined ? { sceneId: e.sceneId } : {}), components: Object.keys(e.components) };
          entityOptionCache.set(e, o);
        }
        return o;
      }),
      scenes: projectScenes ?? [],
      refs: {
        material: materials.map((m) => ({ id: m.materialId, name: m.name })),
        animator: animators.map((a) => ({ id: a.controllerId, name: a.name })),
        behavior: behaviorViews.map((b) => ({ id: b.behaviorId, name: b.displayName })),
        prefab: prefabSummaries.map((p) => ({ id: p.prefabId, name: p.displayName })),
        effect: effects.map((e) => ({ id: e.effectId, name: e.name })),
        // What a game mode names (UI documents, behavior groups, input maps, modes).
        uiDocument: (clientRef.current?.getUiDocuments() ?? []).map((d) => ({ id: d.uiDocumentId, name: d.name })),
        behaviorGroup: behaviorGroups.map((g) => ({ id: g, name: g })),
        inputMap: ['gameplay', 'ui', ...(clientRef.current?.getInput()?.maps ?? [])].map((m) => ({ id: m, name: m })),
        mode: modes.map((m) => ({ id: m.modeId, name: m.name })),
      },
      // An object's effect overrides are edited from its effect's public parameters.
      effectParameters: Object.fromEntries(effects.map((e) => [e.effectId, (e.parameters ?? []).filter((x) => x.visibility !== 'private')])),
      signals: registry === null ? [] : collectSignals(registry, allEntities.map((e) => e.components)),
      // An animator's starting values are edited from its controller's parameters.
      animatorParameters: Object.fromEntries(animators.map((a) => [a.controllerId, a.parameters])),
      // The "+ Add component" presets follow the project's physics dimension.
      physicsDimension: settings?.['physics_dimension'] === 3 ? (3 as const) : (2 as const),
      // The light layer masks' checkboxes carry the project's layer names.
      lightLayerNames: lightLayers,
      // A socket's node list comes from its target's model.
      modelNodes: (entityId: string) => {
        const e = allEntities.find((x) => x.id === entityId);
        const assetId = (e?.components as { model?: { asset?: { assetId?: unknown } } } | undefined)?.model?.asset?.assetId;
        return typeof assetId === 'string' ? modelNodesOf(assetId) : undefined;
      },
      // A skinned model's absent decal layers are none (its file says whether it is).
      modelSkinned: (entityId: string) => {
        const e = allEntities.find((x) => x.id === entityId);
        const assetId = (e?.components as { model?: { asset?: { assetId?: unknown } } } | undefined)?.model?.asset?.assetId;
        return typeof assetId === 'string' ? modelSkinnedOf(assetId) : undefined;
      },
    }),
    [clientRef, allEntities, projectScenes, materials, animators, behaviorViews, prefabSummaries, effects, registry, settings, modelNodesOf, modelSkinnedOf, behaviorGroups, modes, lightLayers],
  );
  /** How many objects carry each behavior group. */
  const groupUsage = useMemo(() => {
    const usage = new Map<string, number>();
    for (const e of allEntities) {
      const g = (e.components as { behaviorGroup?: { group?: unknown } }).behaviorGroup?.group;
      if (typeof g === 'string') usage.set(g, (usage.get(g) ?? 0) + 1);
    }
    return usage;
  }, [allEntities]);
  const selectedSceneId = selectedEntity?.sceneId;
  const fieldContext: FieldContext = useMemo(
    () => ({ ...fieldContextBase, ...(selectedSceneId !== undefined ? { sceneId: selectedSceneId } : {}) }),
    [fieldContextBase, selectedSceneId],
  );
  return { selectedEntity, structureKey, hierarchyFlags, tagUsage, layerUsage, groupUsage, fieldContext };
}
