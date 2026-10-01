/**
 * Prefab authoring: capture the selection as a prefab, place a copy with
 * overridden declared properties, delete a definition.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ProjectedEntity } from '../../session/projection';
import { collectOverrides, newPrefabDraft, overrideDraftKey, planCreatePrefab, planInstantiatePrefab, type CaptureEntityView } from '../../session/prefab-authoring';
import { deriveOverrideTargets } from '../../session/property-controls';
import type { PropertyDeclaration } from '@thirdlight/project-model';
import { refusal, type ClientRef, type UiError } from './commands';

/** The capture preflight view of one projected entity. */
function toCaptureView(e: ProjectedEntity): CaptureEntityView {
  return {
    id: e.id,
    parentId: e.parentId,
    camera: e.kind === 'camera',
    prefab: e.prefab ?? null,
    behavior: e.behaviorId ? { behaviorId: e.behaviorId, values: e.behaviorValues ?? {} } : null,
  };
}

export interface PrefabAuthoringDeps {
  clientRef: ClientRef;
  selectedId: string | null;
  selectedIdRef: MutableRefObject<string | null>;
  declarations: Map<string, PropertyDeclaration>;
  runTypedCommand: (op: string, args: unknown, onError: (e: UiError) => void, withDetail?: boolean) => Promise<boolean>;
}

export function usePrefabAuthoring(deps: PrefabAuthoringDeps) {
  const { clientRef, selectedId, selectedIdRef, declarations, runTypedCommand } = deps;
  const [selectedPrefabId, setSelectedPrefabId] = useState<string | null>(null);
  const [captureName, setCaptureName] = useState('');
  const [captureError, setCaptureError] = useState<UiError | null>(null);
  const [copyError, setCopyError] = useState<UiError | null>(null);
  const [prefabDeleteError, setPrefabDeleteError] = useState<string | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  // The generated prefabId for the current selection (stable while selected).
  const captureIdRef = useRef<string | null>(null);

  /**
   * A fresh capture draft whenever the selection changes. The draft is a local
   * form value; the prefabId is generated once per selection so typing a name
   * does not churn it.
   */
  useEffect(() => {
    const c = clientRef.current;
    const sel = selectedId ? (c?.projection.getEntity(selectedId) ?? null) : null;
    if (!c || !sel) {
      captureIdRef.current = null;
      setCaptureName('');
      setCaptureError(null);
      return;
    }
    const draft = newPrefabDraft({ id: sel.id, name: sel.name }, c.prefabs.prefabIds);
    captureIdRef.current = draft.prefabId;
    setCaptureName(draft.displayName);
    setCaptureError(null);
  }, [clientRef, selectedId]);
  const deletePrefab = useCallback(async (prefabId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const err = refusal(await c.command('deletePrefab', { prefabId }, c.projection.revision));
    setPrefabDeleteError(err);
    if (err === null) setSelectedPrefabId((cur) => (cur === prefabId ? null : cur));
  }, [clientRef]);

  const capturePrefab = useCallback(async () => {
    const c = clientRef.current;
    const sourceEntityId = selectedIdRef.current;
    const prefabId = captureIdRef.current;
    if (!c || !sourceEntityId || !prefabId) return;
    const scene = c.projection.listEntities();
    const plan = planCreatePrefab({
      prefabId,
      displayName: captureName,
      sourceEntityId,
      scene: scene.map(toCaptureView),
      existingPrefabIds: c.prefabs.prefabIds,
      declarations: c.prefabs.declarationMap(),
      cameraId: scene.find((e) => e.kind === 'camera')?.id ?? null,
    });
    if (!plan.ok) {
      setCaptureError({ code: plan.error.code, message: plan.error.message });
      return;
    }
    setCaptureError(null);
    const ok = await runTypedCommand('createPrefab', plan.command.args, setCaptureError);
    if (ok) setSelectedPrefabId(plan.command.args.prefabId);
  }, [captureName, clientRef, runTypedCommand, selectedIdRef]);

  const overrideTargets = useMemo(() => {
    const c = clientRef.current;
    if (!c || !selectedPrefabId) return [];
    const definition = c.prefabs.getDefinition(selectedPrefabId);
    if (!definition) return [];
    return deriveOverrideTargets(definition, declarations);
  }, [clientRef, selectedPrefabId, declarations]);

  const commitOverride = useCallback((localId: string, key: string, raw: string) => {
    setOverrideDrafts((prev) => ({ ...prev, [overrideDraftKey(localId, key)]: raw }));
  }, []);

  const placeCopy = useCallback(
    async (prefabId: string) => {
      const c = clientRef.current;
      if (!c) return;
      // The definition is read by id (the editor reads definitions when they are used).
      await c.catalog.ensurePrefabs([prefabId]);
      const definition = c.prefabs.getDefinition(prefabId) ?? null;
      const decls = c.prefabs.declarationMap();
      const targets = definition ? deriveOverrideTargets(definition, decls) : [];
      const entitiesNow = c.projection.listEntities();
      // Asset references are checked by the backend (the editor holds no whole catalog).
      const refs = { entityIds: entitiesNow.map((e) => e.id) };
      const collected = collectOverrides(targets, new Map(Object.entries(overrideDrafts)), refs);
      if (!collected.ok) {
        setCopyError({ code: collected.error.code, message: collected.error.message });
        return;
      }
      const plan = planInstantiatePrefab({
        prefabId,
        definition,
        declarations: decls,
        parentId: null,
        sceneEntityIds: refs.entityIds,
        sceneEntityCount: entitiesNow.length,
        parentDepth: 0,
        overrides: collected.overrides,
      });
      if (!plan.ok) {
        setCopyError({ code: plan.error.code, message: plan.error.message });
        return;
      }
      setCopyError(null);
      const ok = await runTypedCommand('instantiatePrefab', plan.command.args, setCopyError);
      if (ok) setOverrideDrafts({});
    },
    [clientRef, overrideDrafts, runTypedCommand],
  );

  return {
    selectedPrefabId, setSelectedPrefabId, captureName, setCaptureName, captureError, copyError, setCopyError, prefabDeleteError, overrideDrafts, setOverrideDrafts,
    captureIdRef, deletePrefab, capturePrefab, overrideTargets, commitOverride, placeCopy,
  };
}

export type PrefabAuthoring = ReturnType<typeof usePrefabAuthoring>;
