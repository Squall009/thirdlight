/**
 * The Inspector's edits of the selected object: declared script properties,
 * components (edit, add, remove), colliders and capsules fitted to the model,
 * surface presets, material mappings and their parameter overrides. A typed
 * command that hits a revision conflict is re-read and sent once more.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProjectedEntity } from '../../session/projection';
import { recoverPrefabCommandFailure } from '../../session/prefab-authoring';
import { derivePropertyControls, parseControlInput, planSetBehaviorProperties } from '../../session/property-controls';
import { fitCapsule } from '../../session/size-handles';
import { maxPolygonCorners } from '../../session/handles';
import { boxFromBounds3D, boxFromOutline, polygonFromOutline } from '../../session/outline';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import type { ClientRef, ModelsRef, ReportFailure, SetNotice, UiError, ViewportRef } from './commands';

export interface EntityEditingDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  modelInstancesRef: ModelsRef;
  refreshEntities: () => void;
  reportFailure: ReportFailure;
  setNotice: SetNotice;
  registry: DescriptorRegistry | null;
  entities: ProjectedEntity[];
  selectedId: string | null;
}

export function useEntityEditing(deps: EntityEditingDeps) {
  const { clientRef, viewportRef, modelInstancesRef, refreshEntities, reportFailure, setNotice, registry, entities, selectedId } = deps;
  /** The material names of the selected object's model file (for the mapping editor). */
  const [selectedSourceMaterials, setSelectedSourceMaterials] = useState<string[]>([]);
  const [propertyError, setPropertyError] = useState<UiError | null>(null);
  const [componentError, setComponentError] = useState<UiError | null>(null);
  /** A surface preset (the Inspector's surface section) — one `applySurfacePreset`. */
  const applyPreset = useCallback(async (entityId: string, preset: string) => {
    const c = clientRef.current;
    if (!c) return;
    setComponentError(null);
    const res = await c.command('applySurfacePreset', { entityId, preset }, c.projection.revision);
    if (!res.ok) {
      const r = res.response as { code?: string; message?: string };
      setComponentError({ code: r.code ?? 'network', message: r.message ?? 'the preset was not applied' });
    }
  }, [clientRef]);

  /**
   * Issue one typed prefab/property command with the contract's client
   * recovery: a `revision_conflict` re-reads the state
   * and re-issues ONCE with a fresh requestId; a backend-rejected instance
   * limit or any other failure is surfaced with its exact bound (never
   * swallowed).
   */
  const runTypedCommand = useCallback(
    async (op: string, args: unknown, onError: (e: UiError) => void, withDetail = false): Promise<boolean> => {
      const c = clientRef.current;
      if (!c) return false;
      let reissues = 0;
      for (;;) {
        const res = await c.command(op, args, c.projection.revision);
        if (res.ok) return true;
        if (res.response.ok) {
          onError({ code: 'internal', message: 'unexpected success response for a failed command' });
          return false;
        }
        const r = res.response;
        const recovery = recoverPrefabCommandFailure(
          { code: r.code, message: r.message, currentRevision: r.currentRevision, limit: r.limit, current: r.current, max: r.max },
          { reissues },
        );
        if (recovery.kind === 'reissue') {
          reissues += 1;
          await c.fullResync();
          refreshEntities();
          continue;
        }
        // The Inspector says which rule refused the edit (the first detail).
        const detail = withDetail ? (r as { details?: { message?: string }[] }).details?.[0]?.message : undefined;
        onError({ code: r.code, message: detail !== undefined ? `${recovery.message} — ${detail}` : recovery.message });
        return false;
      }
    },
    [clientRef, refreshEntities],
  );
  const setEntityMaterials = useCallback(async (entityId: string, mapping: Record<string, string> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Materials', await c.setComponent(entityId, 'materials', mapping, c.projection.revision));
  }, [clientRef, reportFailure]);
  // An object's overrides of its graph materials' public parameters (one setComponent, whole value).
  const setEntityMaterialParams = useCallback(async (entityId: string, next: Record<string, Record<string, number | number[] | string>> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Material parameters', await c.setComponent(entityId, 'materialParams', next, c.projection.revision));
  }, [clientRef, reportFailure]);
  /**
   * One declared-property edit = one ordinary typed `setBehaviorProperties`
   * command. The whole declared values map is sent (omitted keys take their
   * declaration default), so editing one property never resets the others.
   */
  const editProperty = useCallback(
    async (entityId: string, key: string, raw: string) => {
      const c = clientRef.current;
      if (!c) return;
      const entity = c.projection.getEntity(entityId);
      if (!entity?.behaviorId) {
        setPropertyError({ code: 'behavior_reference_missing', message: `${entityId} carries no behavior component` });
        return;
      }
      const declaration = c.prefabs.getDeclaration(entity.behaviorId);
      if (!declaration) {
        setPropertyError({ code: 'behavior_not_found', message: `${entity.behaviorId} is not published in content.behaviors` });
        return;
      }
      const control = derivePropertyControls(declaration, entity.behaviorValues ?? {}).find((x) => x.key === key);
      if (!control) {
        setPropertyError({ code: 'property_unknown', message: `"${key}" is not declared by ${entity.behaviorId}` });
        return;
      }
      // Asset references are checked by the backend (the editor holds no whole catalog).
      const parsed = parseControlInput(control, raw, { entityIds: c.projection.listEntities().map((e) => e.id) });
      if (!parsed.ok) {
        setPropertyError({ code: parsed.error.code, message: parsed.error.message });
        return;
      }
      const plan = planSetBehaviorProperties(entityId, entity.behaviorId, declaration, entity.behaviorValues ?? {}, key, parsed.value);
      if (!plan.ok) {
        setPropertyError({ code: plan.error.code, message: plan.error.message });
        return;
      }
      setPropertyError(null);
      await runTypedCommand('setBehaviorProperties', plan.args, setPropertyError);
    },
    [clientRef, runTypedCommand],
  );

  /**
   * One Inspector component edit — a partial top-level value, or
   * null to remove the component — as one typed command (one undo step): the
   * script through `setBehaviorProperties`, everything else `setComponent`.
   */
  const editComponent = useCallback(
    async (entityId: string, component: string, patch: Record<string, unknown> | null) => {
      setComponentError(null);
      if (component === 'behavior') {
        if (patch !== null) return; // the script's values are edited property by property (editProperty)
        await runTypedCommand('setBehaviorProperties', { entityId, behaviorId: null }, setComponentError, true);
        return;
      }
      await runTypedCommand('setComponent', { entityId, component, value: patch }, setComponentError, true);
    },
    [runTypedCommand],
  );
  /** "+ Add component" (the descriptor's value, a preset, or the picked value) — one command. */
  const addComponentTo = useCallback(
    async (entityId: string, component: string, value: Record<string, unknown>) => {
      setComponentError(null);
      if (component === 'behavior') {
        await runTypedCommand('setBehaviorProperties', { entityId, behaviorId: value['behaviorId'], values: value['values'] ?? {} }, setComponentError, true);
        return;
      }
      await runTypedCommand('setComponent', { entityId, component, value }, setComponentError, true);
    },
    [runTypedCommand],
  );

  // "Fit to model" sizes the player's capsule to its models (one setComponent).
  const fitCapsuleToModel = useCallback(
    async (entityId: string) => {
      const bounds = viewportRef.current?.modelBounds(entityId) ?? null;
      const fit = bounds === null ? null : fitCapsule(bounds);
      if (fit === null) {
        setComponentError({ code: 'no_model', message: 'Fit to model needs a loaded model on this object or on its children.' });
        return;
      }
      await editComponent(entityId, 'controller', { capsule: fit });
    },
    [editComponent, viewportRef],
  );

  /**
   * A 3D project: a collider from the object's own model, made by the
   * backend from the model file (`colliderFromModel`, the same command MCP
   * sends) — a box around it (centred where it is), a convex hull or a
   * triangle mesh from its `_COL` node(s), else its LOD0 geometry, or a
   * compound of the `_COL` node's convex parts — in the object's frame (its
   * scale applies in physics).
   */
  const colliderFromModel3D = useCallback(
    async (entityId: string, kind: 'box' | 'convex' | 'mesh' | 'compound') => {
      const ok = await runTypedCommand('colliderFromModel', { entityId, kind }, setComponentError, true);
      if (ok) setNotice(`Collider: ${kind === 'box' ? 'box around the model' : kind === 'compound' ? "one hull per part of the model's _COL node" : `${kind === 'mesh' ? 'mesh' : 'convex hull'} from the model's _COL node (else its geometry)`}`);
    },
    [runTypedCommand, setNotice],
  );

  /** A collider from the model's outline on the play plane (a box, or a polygon of at most 8 corners). */
  const colliderFromModel = useCallback(
    async (entityId: string, kind: 'box' | 'polygon') => {
      const points = viewportRef.current?.modelOutline(entityId) ?? null;
      if (points === null) {
        setComponentError({ code: 'no_model', message: 'A collider from the model needs a loaded model on this object or on its children.' });
        return;
      }
      const made = kind === 'box' ? boxFromOutline(points) : polygonFromOutline(points, maxPolygonCorners(registry));
      if (!made.ok) {
        setComponentError({ code: 'no_outline', message: made.message });
        return;
      }
      if (made.note !== undefined) setNotice(`Collider: ${made.note}`);
      const has = clientRef.current?.projection.getEntity(entityId)?.components['collider'] !== undefined;
      if (has) await editComponent(entityId, 'collider', { shape: made.shape });
      else await addComponentTo(entityId, 'collider', { shape: made.shape });
    },
    [viewportRef, registry, setNotice, clientRef, editComponent, addComponentTo],
  );
  // The material names of the selected object's model file / the selected asset.
  const selectedForMaterials = entities.find((e) => e.id === selectedId) ?? null;
  const selectedModelKey = selectedForMaterials !== null ? `${selectedForMaterials.assetId ?? selectedForMaterials.instances?.assetId ?? ''}|${selectedForMaterials.piece ?? selectedForMaterials.instances?.piece ?? ''}` : '';
  useEffect(() => {
    const [assetId, piece] = selectedModelKey.split('|') as [string, string];
    const models = modelInstancesRef.current;
    if (assetId === '' || models === null) {
      setSelectedSourceMaterials([]);
      return;
    }
    let live = true;
    void models.prepared(assetId).then((r) => {
      if (live) setSelectedSourceMaterials(r === null ? [] : r.materialNames(piece === '' ? null : piece));
    });
    return () => {
      live = false;
    };
  }, [modelInstancesRef, selectedModelKey]);

  return {
    selectedSourceMaterials, propertyError, componentError, applyPreset, runTypedCommand, setEntityMaterials, setEntityMaterialParams,
    editProperty, editComponent, addComponentTo, fitCapsuleToModel, colliderFromModel3D, colliderFromModel,
  };
}

export type EntityEditing = ReturnType<typeof useEntityEditing>;
