/**
 * Prefab authoring: make a prefab from the selection, choose one in the
 * project window, place a copy with overridden declared properties, delete a
 * definition.
 */
import { useCallback, useMemo, useState, type MutableRefObject } from 'react';
import type { ProjectedEntity } from '../../session/projection';
import { collectOverrides, newPrefabDraft, overrideDraftKey, planCreatePrefab, planInstantiatePrefab, type CaptureEntityView } from '../../session/prefab-authoring';
import { deriveOverrideTargets } from '../../session/property-controls';
import type { PropertyDeclaration } from '@thirdlight/project-model';
import { refusal, type ClientRef, type SetNotice, type UiError } from './commands';

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
  selectedIdRef: MutableRefObject<string | null>;
  declarations: Map<string, PropertyDeclaration>;
  runTypedCommand: (op: string, args: unknown, onError: (e: UiError) => void, withDetail?: boolean) => Promise<boolean>;
  setNotice: SetNotice;
}

export function usePrefabAuthoring(deps: PrefabAuthoringDeps) {
  const { clientRef, selectedIdRef, declarations, runTypedCommand, setNotice } = deps;
  const [selectedPrefabId, setSelectedPrefabId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<UiError | null>(null);
  const [prefabDeleteError, setPrefabDeleteError] = useState<string | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  // Bumped when a chosen definition has been read (its override targets come from it).
  const [definitionsRead, setDefinitionsRead] = useState(0);

  /** A prefab chosen in the project window: its Inspector places copies of it (the definition is read by id). */
  const choosePrefab = useCallback(
    (prefabId: string) => {
      setSelectedPrefabId(prefabId);
      setOverrideDrafts({});
      setCopyError(null);
      setPrefabDeleteError(null);
      void clientRef.current?.catalog.ensurePrefabs([prefabId]).then(() => setDefinitionsRead((n) => n + 1));
    },
    [clientRef],
  );

  const deletePrefab = useCallback(async (prefabId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const err = refusal(await c.command('deletePrefab', { prefabId }, c.projection.revision));
    setPrefabDeleteError(err);
    if (err === null) setSelectedPrefabId((cur) => (cur === prefabId ? null : cur));
  }, [clientRef]);

  /**
   * GameObject → Create prefab from selection (and the Hierarchy's context
   * menu): the selected object and its children become a new definition named
   * after the object (renamed later in the project window); the outcome is a
   * notice.
   */
  const createPrefabFromSelection = useCallback(async () => {
    const c = clientRef.current;
    const sourceEntityId = selectedIdRef.current;
    const sel = sourceEntityId !== null ? c?.projection.getEntity(sourceEntityId) : undefined;
    if (!c || sourceEntityId === null || sel === undefined) return setNotice('Create prefab: select an object first.');
    const draft = newPrefabDraft({ id: sel.id, name: sel.name }, c.prefabs.prefabIds);
    const scene = c.projection.listEntities();
    const plan = planCreatePrefab({
      prefabId: draft.prefabId,
      displayName: draft.displayName,
      sourceEntityId,
      scene: scene.map(toCaptureView),
      existingPrefabIds: c.prefabs.prefabIds,
      declarations: c.prefabs.declarationMap(),
      cameraId: scene.find((e) => e.kind === 'camera')?.id ?? null,
    });
    if (!plan.ok) return setNotice(`Create prefab: ${plan.error.message}`);
    let failure: UiError | null = null;
    const ok = await runTypedCommand('createPrefab', plan.command.args, (e) => (failure = e));
    if (!ok) return setNotice(`Create prefab: ${(failure as UiError | null)?.message ?? 'refused'}`);
    setSelectedPrefabId(plan.command.args.prefabId);
    setNotice(`Prefab “${plan.command.args.displayName}” created from ${sel.name ?? sel.id}.`);
  }, [clientRef, runTypedCommand, selectedIdRef, setNotice]);

  const overrideTargets = useMemo(() => {
    const c = clientRef.current;
    if (!c || !selectedPrefabId) return [];
    const definition = c.prefabs.getDefinition(selectedPrefabId);
    if (!definition) return [];
    return deriveOverrideTargets(definition, declarations);
    // definitionsRead: the definition may arrive after it was chosen.
  }, [clientRef, selectedPrefabId, declarations, definitionsRead]); // eslint-disable-line react-hooks/exhaustive-deps -- definitionsRead only re-reads the client's definitions

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
    selectedPrefabId, setSelectedPrefabId, choosePrefab, copyError, setCopyError, prefabDeleteError, overrideDrafts, setOverrideDrafts,
    deletePrefab, createPrefabFromSelection, overrideTargets, commitOverride, placeCopy,
  };
}

export type PrefabAuthoring = ReturnType<typeof usePrefabAuthoring>;
