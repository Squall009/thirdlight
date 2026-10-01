/**
 * The workspace host: what every document tab (and the Animator and
 * Behaviors panels, which share it) reads and calls — the documents, their
 * selections and focus requests, and the commands that edit them.
 */
import * as THREE from 'three';
import type { ProjectedEntity } from '../../session/projection';
import type { FieldContext } from '../DescriptorFields';
import { useUiPreviewAssets } from '../uidoc/useUiPreviewAssets';
import { conversationsFrom } from '../../session/dialogue-closure';
import type { WorkspaceHost } from './kinds';
import { docKey, type WorkspaceAction } from '../../session/editor-window';
import type { PreviewDeps } from '../preview/use-subject';
import type { DebugRequest, DebugResult } from '../../preview/play-debug';
import type { Dispatch, MutableRefObject } from 'react';
import type { ClientRef, ModelsRef } from '../shell/commands';
import type { ProjectContent } from '../shell/useProjectContent';
import type { ProjectSettings } from '../shell/useProjectSettings';
import type { DocumentState } from './useDocumentState';
import type { DocumentCommands } from './useDocumentCommands';
import type { Scripting } from '../shell/useScripting';
import type { AnimatorTools } from '../shell/useAnimatorTools';

export interface WorkspaceHostInput {
  clientRef: ClientRef;
  modelInstancesRef: ModelsRef;
  loadTextureRef: MutableRefObject<((assetId: string) => Promise<THREE.Texture | null>) | null>;
  /** The project (it keys the UI previewer's mock values in this browser). */
  projectId: string;
  content: ProjectContent;
  settings: Pick<ProjectSettings, 'inputConfig' | 'inputDefaults' | 'modes'>;
  docState: DocumentState;
  docCmds: DocumentCommands;
  scripting: Scripting;
  animator: AnimatorTools;
  debugPlay: (req: DebugRequest) => Promise<DebugResult | null>;
  entities: ProjectedEntity[];
  selectedId: string | null;
  gameFieldContext: Omit<FieldContext, 'sceneId'>;
  uiPreviewAssets: ReturnType<typeof useUiPreviewAssets>;
  openDocument: (kind: string, id: string) => void;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  /** The Scene view lent to the preview pane (what is shown on its scene). */
  sceneView: PreviewDeps['sceneView'];
  /** Renaming an item (the editor header's name). */
  items: WorkspaceHost['items'];
}

export function workspaceHostOf(input: WorkspaceHostInput): WorkspaceHost {
  const { clientRef, modelInstancesRef, loadTextureRef, entities, selectedId, gameFieldContext, uiPreviewAssets, openDocument, workspaceDispatch, debugPlay } = input;
  const { animators, dialogueSettings, dialogues, effects, shownEnvironment, graphKinds, graphs, materials, projectUiDocs, projectUiThemes, registry, scriptLibraries, speakers, timelines, uiDocuments, uiThemes } = input.content;
  const { inputConfig, inputDefaults, modes } = input.settings;
  const { activeVisualId, animatorFocus, animatorTargets, dialogueFocus, dialogueSelection, effectFocus, effectSystems, graphFocus, graphsContext, materialFocus, onVisualProblems, onVisualTarget } = input.docState;
  const { setAnimatorFocus, setAnimatorSelection, setAnimatorTargets, setDialogueSelection, setEffectSelection, setEffectSystems, setGraphSelection, setMaterialSelection } = input.docState;
  const { setVisualBreakpoints, setVisualFocus, setVisualSelectionOf, setVisualWatches, visualBreakpoints, visualFocus, visualTargets, visualWatches } = input.docState;
  const { dialogueCommand, dialogueError, effectCommand, effectError, graphDocCommand, materialError, onTimelinePreview, saveMaterial, sendGraphEdit, setUiError, showGraph, timelineCommand, timelineError, uiCommand, uiError } = input.docCmds;
  const { behaviorError, behaviorProps, checkScript, checkVisualScript, libraryDrafts, libraryDraftsVersion, onLibraryDraftChange, publishScript, publishVisualScript, saveDeclaration, saveLibrary, scriptDrafts, sourceFocus } = input.scripting;
  const { animatorError, animatorGraphEdit, animatorProps, deleteAnimator, previewAnimator, saveAnimator } = input.animator;
  const { clipsOf, skeletonOf } = input.animator;
  const workspaceHost: WorkspaceHost = {
    animator: animatorProps,
    animatorDocument: (controllerId) => ({
      controllerId,
      controllers: animators,
      clipsOf,
      skeletonOf,
      onSave: (controller) => void saveAnimator(controller),
      onDelete: (id) => void deleteAnimator(id),
      error: animatorError,
      kinds: graphKinds,
      target: animatorTargets[controllerId] ?? controllerId,
      onTarget: (ownerId) => {
        setAnimatorTargets((t) => ({ ...t, [controllerId]: ownerId }));
        setAnimatorSelection({ ownerId, ids: [] });
        setAnimatorFocus(null);
      },
      onGraphEdit: animatorGraphEdit,
      onSelection: (ownerId, ids) => setAnimatorSelection({ ownerId, ids }),
      focus: animatorFocus,
    }),
    behavior: behaviorProps,
    script: {
      drafts: scriptDrafts,
      declarationError: behaviorError,
      activePlay: behaviorProps.activePlay,
      onSaveDeclaration: saveDeclaration,
      loadSource: async (behaviorId) => clientRef.current?.behaviorSource(behaviorId) ?? { ok: false, error: { code: 'disconnected', message: 'not connected' } },
      check: checkScript,
      publish: publishScript,
      focus: sourceFocus,
    },
    library: {
      libraries: scriptLibraries,
      drafts: libraryDrafts,
      activePlay: behaviorProps.activePlay,
      check: async (libraryId, files) => clientRef.current?.checkScriptLibrary(libraryId, files) ?? { ok: false, error: { code: 'disconnected', message: 'not connected' } },
      save: saveLibrary,
      onDraftChange: onLibraryDraftChange,
      draftsVersion: libraryDraftsVersion,
      focus: sourceFocus,
      saveAll: { dirty: input.scripting.dirtyLibraries, outcome: input.scripting.saveAllOutcome, onSaveAll: (acknowledge) => void input.scripting.saveAllLibraries(acknowledge) },
    },
    graph: {
      graphs,
      kinds: graphKinds,
      onEdit: (graphId, ops) => sendGraphEdit({ kind: 'graph', id: graphId }, ops),
      onSelection: setGraphSelection,
      focus: graphFocus,
      portContext: graphsContext,
    },
    material: {
      materials,
      kinds: graphKinds,
      graphs,
      onEdit: (materialId, ops) => sendGraphEdit({ kind: 'material', id: materialId }, ops),
      onSave: (m) => void saveMaterial(m, materials.find((x) => x.materialId === m.materialId) ?? null),
      onSelection: setMaterialSelection,
      focus: materialFocus,
      error: materialError,
    },
    effect: {
      effects,
      kinds: graphKinds,
      systemOf: (effectId) => effectSystems[effectId] ?? null,
      onSystem: (effectId, systemId) => {
        setEffectSystems((m) => ({ ...m, [effectId]: systemId }));
        setEffectSelection([]);
      },
      onEdit: (ownerId, ops) => sendGraphEdit({ kind: 'effect', id: ownerId }, ops),
      onSave: (effect) => void effectCommand('setEffect', { effect }),
      onSelection: setEffectSelection,
      focus: effectFocus,
      error: effectError,
    },
    // The preview pane's subjects: the active scene's look, the editor's texture bytes and its models.
    preview: {
      environment: shownEnvironment as unknown as PreviewDeps['environment'],
      loadTexture: (assetId) => loadTextureRef.current?.(assetId) ?? Promise.resolve(null),
      loadModel: async (assetId) => {
        const r = await modelInstancesRef.current?.prepared(assetId);
        const made = r?.createInstance();
        if (made === undefined || !made.ok) return null;
        return { root: made.instance.root, dispose: () => void made.instance.dispose() };
      },
      loadEffectModel: async (assetId) => {
        const r = await modelInstancesRef.current?.prepared(assetId);
        const made = r?.createInstance();
        return made !== undefined && made.ok ? made.instance.root : null;
      },
      startAnimator: previewAnimator,
      sceneView: input.sceneView,
    },
    dialogue: {
      dialogues,
      speakers,
      settings: dialogueSettings,
      uiDocuments: projectUiDocs,
      uiThemes: projectUiThemes,
      kinds: graphKinds,
      // The facts of the assets a conversation names (read by id), and each file when it is needed.
      assets: async (ids) => {
        const c = clientRef.current;
        if (c === null) return [];
        await c.catalog.ensureAssets(ids);
        return ids.flatMap((id) => {
          const a = c.content.getAsset(id);
          return a === undefined ? [] : [{ assetId: a.assetId, kind: a.kind, version: a.currentVersion, ...(a.audio !== undefined ? { durationMs: a.audio.durationMs } : {}) }];
        });
      },
      conversations: (dialogueId) => conversationsFrom(clientRef.current, dialogueId),
      readAsset: (assetId, version) => {
        const c = clientRef.current;
        return c !== null ? c.assetBytes(assetId, version) : Promise.reject(new Error('not connected'));
      },
      onEdit: (dialogueId, ops) => sendGraphEdit({ kind: 'dialogue', id: dialogueId }, ops),
      onSelection: setDialogueSelection,
      selection: dialogueSelection,
      focus: dialogueFocus,
      error: dialogueError,
    },
    visualScript: {
      kind: graphKinds['behavior'],
      graphs,
      kinds: graphKinds,
      activePlay: behaviorProps.activePlay,
      onEdit: (ownerId, ops) => sendGraphEdit({ kind: 'behavior', id: ownerId }, ops),
      onSelection: (ids, owner) => setVisualSelectionOf({ owner, ids }),
      focus: visualFocus,
      onFocus: (id) => setVisualFocus({ ...(activeVisualId !== null ? { behaviorId: activeVisualId } : {}), id, nonce: Date.now() }),
      check: checkVisualScript,
      publish: publishVisualScript,
      targets: visualTargets,
      onTarget: onVisualTarget,
      onProblems: onVisualProblems,
      breakpoints: visualBreakpoints,
      onBreakpoints: (behaviorId, ids) => setVisualBreakpoints((m) => ({ ...m, [behaviorId]: ids })),
      watches: visualWatches,
      onWatches: (behaviorId, names) => setVisualWatches((m) => ({ ...m, [behaviorId]: names })),
      carriers: (behaviorId) => entities.filter((e) => e.behaviorId === behaviorId).map((e) => ({ id: e.id, name: e.name })),
      selectedEntityId: selectedId,
      debugRequest: debugPlay,
      onOpenGraph: (graphId) => showGraph(graphId),
      onCreateSharedFunction: async (name) => {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shared-function';
        let graphId = base;
        for (let i = 2; graphs.some((g) => g.graphId === graphId); i++) graphId = `${base}-${i}`;
        const ok = await graphDocCommand('setGraph', { graph: { graphId, kind: 'behavior-library', name, graph: { nodes: [{ id: 'start', type: 'fn.entry', position: [0, 0], data: { name } }], edges: [] } } });
        return ok ? graphId : null;
      },
    },
    timeline: {
      timelines,
      entities: clientRef.current?.projection.listEntities() ?? entities,
      effects: effects.map((e) => ({ id: e.effectId, name: e.name })),
      actions: (inputConfig ?? inputDefaults).actions.map((a) => a.name),
      animators,
      error: timelineError,
      onSave: (timeline) => timelineCommand('setTimeline', { timeline }),
      onPreview: onTimelinePreview,
      modes: modes.map((m) => m.modeId),
    },
    ui: {
      documents: uiDocuments,
      themes: uiThemes,
      document: (uiDocumentId) => ({
        uiDocumentId,
        documents: uiDocuments,
        themes: uiThemes,
        descriptors: registry?.ui ?? null,
        current: (id) => clientRef.current?.getUiDocuments().find((d) => d.uiDocumentId === id) ?? null,
        onSave: (document) => uiCommand('setUiDocument', { document }),
        onSaveTheme: (theme) => uiCommand('setUiTheme', { theme }),
        onOpenTheme: (id) => openDocument('ui-theme', id),
        entities: gameFieldContext.entities.map((e) => ({ id: e.id, name: e.name })),
        fieldContext: gameFieldContext,
        assets: uiPreviewAssets,
        mockStorageKey: `thirdlight.uimock.v1.${input.projectId}`,
      }),
      theme: (uiThemeId) => ({
        uiThemeId,
        themes: uiThemes,
        documents: uiDocuments,
        descriptors: registry?.ui ?? null,
        onSave: (theme) => uiCommand('setUiTheme', { theme }),
        onOpenDocument: (id) => openDocument('ui-document', id),
        fieldContext: gameFieldContext,
        error: uiError,
        onError: setUiError,
      }),
    },
    close: (doc) => workspaceDispatch({ type: 'close', key: docKey(doc) }),
    items: input.items,
  };
  return workspaceHost;
}
