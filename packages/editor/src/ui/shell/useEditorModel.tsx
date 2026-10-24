/**
 * The editor's model: the session client and the Scene view (made once per
 * mount), the state the shell draws and every area's hook (`shell/*`,
 * `workspace/*`): Play and its preview bridge, the project's content and
 * settings, scene and Inspector edits, prefabs, blocks, bakes, scripts, the
 * documents' commands and selections, the dialogs and the menus. The Scene
 * view follows it (`useSceneViewSync`, `useSceneViewFollow`); the shell
 * (`EditorShell.tsx`) draws it.
 *
 * Browser-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { forgetToken, readEditorConfig } from '../../config';
import { useDockSizes } from '../layout';
import { SessionClient, type ClientUiState } from '../../session/client';
import type { ProjectedEntity } from '../../session/projection';
import { Gesture } from '../../session/gesture';
import { Viewport, type GizmoMode } from '../../viewport/viewport';
import { OCCLUSION_VIEW_DEFAULT, type OcclusionViewState } from '../../viewport/occlusion-view';
import { ModelFiles } from '../../viewport/model-files';
import { TileThumbnails } from '../../viewport/thumbnails';
import { type RendererInfo } from '@thirdlight/three-adapter';
import { decalPageTextureKey } from '../../session/decal-atlas';
import { type SceneHeaderView } from '../Hierarchy';
import { useUiPreviewAssets } from '../uidoc/useUiPreviewAssets';
import { useSelectionAcrossWindow, useWorkspace } from '../workspace/EditorWindow';
import { useProjectSettingsWindow } from '../settings/ProjectSettingsWindow';
import { activeDoc } from '../../session/editor-window';
import { DEFAULT_SNAP_SETTINGS, type SnapSettings } from '../../session/snapping';
import { useAssetFileCheck } from '../useAssetFileCheck';
import { useProjectContent } from './useProjectContent';
import { useProjectSettings } from './useProjectSettings';
import { usePlaySession } from './usePlaySession';
import { useDocumentState } from '../workspace/useDocumentState';
import { useDocumentCommands } from '../workspace/useDocumentCommands';
import { useEditorProblems } from './useEditorProblems';
import { useBlockLayers } from './useBlockLayers';
import { useTerrainTools } from './useTerrainTools';
import { useSceneEditing } from './useSceneEditing';
import { useEditorShortcuts } from './useEditorShortcuts';
import { useEditorDialogs } from './useEditorDialogs';
import { useCuePreview } from './useCuePreview';
import { useSceneViewLending } from './useSceneViewLending';
import { useEditMode } from '../editmode/useEditMode';
import { useEntityEditing } from './useEntityEditing';
import { usePrefabAuthoring } from './usePrefabAuthoring';
import { onPrefabStage, usePrefabStage } from './usePrefabStage';
import { useAssetsWindow } from './useAssetsWindow';
import { useItemActions } from '../project/useItemActions';
import { freeItemId, type ProjectItem } from '../../session/project-items';
import { useAssetActions } from './useAssetActions';
import { useLightingBake } from './useLightingBake';
import { useScripting } from './useScripting';
import { useAnimatorTools } from './useAnimatorTools';
import { useInstanceBrush } from '../instances/InstanceBrush';
import type { BottomTab } from './dock-tabs';
import { TOOL_WINDOWS, useToolWindows, type ToolWindowId } from '../tools/tool-windows';
import { defaultToolPlace } from '../tools/SceneToolWindows';
import { useDecalAtlas } from './useDecalAtlas';
import { useDecalTools } from './useDecalTools';
import { useVertexPaintTools } from './useVertexPaintTools';
import type { NoticeTone, ReportFailure, SetNotice } from './commands';
import { useKitEditor } from '../kit/useKitEditor';
import { useSceneViewSync } from './useSceneViewSync';
import { useEditorMount } from './useEditorMount';
import { useSceneViewFollow } from './useSceneViewFollow';
import { useEntityIndexes } from './useEntityIndexes';

export function useEditorModel() {
  const cfg = useRef(readEditorConfig());
  /** The Scene view's canvas is in this host (the Viewport replaces it on a renderer backend change). */
  const viewportHostRef = useRef<HTMLDivElement | null>(null);
  /** The Scene view's renderer (backend, state, reason) and the play's, from its observation. */
  const [sceneRenderer, setSceneRenderer] = useState<RendererInfo | null>(null);
  const clientRef = useRef<SessionClient | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

  /** Which screen stands in front of the editor (token form / picker), and why. */
  const [gate, setGate] = useState<{ kind: 'token' | 'projects'; message?: string } | null>(
    cfg.current.ok || cfg.current.needs === 'page' ? null : { kind: cfg.current.needs === 'token' ? 'token' : 'projects' },
  );
  /** The open scenes' objects (the Hierarchy's). */
  const [sceneEntities, setEntities] = useState<ProjectedEntity[]>([]);
  /** The transform a Scene-view gesture shows while it runs (the Inspector readout), until the change lands. */
  const [liveTransform, setLiveTransform] = useState<{ id: string; position: number[]; rotation: number[]; scale: number[] } | null>(null);
  /** The hierarchy selection (several ids) and its primary entity (inspector, gizmo). */
  const [selection, setSelection] = useState<{ ids: string[]; primary: string | null }>({ ids: [], primary: null });
  const selectedId = selection.primary;
  const setSelectedId = useCallback((id: string | null) => setSelection({ ids: id === null ? [] : [id], primary: id }), []);
  const [ui, setUi] = useState<ClientUiState>({ connection: 'idle', save: 'idle', error: null, conflict: null, revision: 0, undoDepth: 0, redoDepth: 0, external: null, problems: [] });
  /** A prefab opened on its own: its objects are drawn, picked and inspected beside the scenes' while its editor is open. */
  const prefabStage = usePrefabStage(clientRef, ui.revision);
  const openPrefabRef = useRef(prefabStage.stage);
  openPrefabRef.current = prefabStage.stage;
  const refreshStage = prefabStage.refresh;
  const stageEntities = prefabStage.stage?.entities;
  const entities = useMemo(() => (stageEntities === undefined ? sceneEntities : [...sceneEntities, ...stageEntities]), [sceneEntities, stageEntities]);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  /** The bottom dock's active panel. */
  const [bottomTab, setBottomTab] = useState<BottomTab>('assets');
  /** A search the project window is asked to show (the GameObject menu's "Prefab copy…"); `n` makes a repeat a new request. */
  const [projectSearch, setProjectSearch] = useState<{ text: string; n: number } | null>(null);
  /**
   * The centre's Scene/Game view and the editor window with its open items
   * (remembered per project in the layout storage).
   */
  const [workspace, workspaceDispatch] = useWorkspace(cfg.current.ok ? cfg.current.config.projectId : null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  /** The centre view: the editor scene or the running game. */
  const centerTab = workspace.view;
  /** Show the Scene or Game view, in front (the editor window steps aside). */
  /** The Project Settings window (over the editor and the editor window). */
  const settingsWindow = useProjectSettingsWindow(workspace);
  const closeSettings = settingsWindow.close;
  const setCenterTab = useCallback(
    (key: 'scene' | 'game') => {
      workspaceDispatch({ type: 'view', view: key });
      workspaceDispatch({ type: 'show', on: false });
      closeSettings();
    },
    [workspaceDispatch, closeSettings],
  );
  const windowOpen = activeDoc(workspace) !== null;
  // The Animator and Behaviors panels: the bottom dock and the editor window's tabs share these.
  const openDocument = (kind: string, id: string): void => workspaceDispatch({ type: 'open', doc: { kind, id } });
  const content = useProjectContent();
  const { materials, animators, effects, registry, prefabSummaries, behaviorViews, uiDocuments, uiThemes, receive: receiveContent } = content;
  const { sizes, splitter } = useDockSizes();
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** A dismissible message over the viewport (e.g. why Play failed). */
  const [notice, setNoticeText] = useState<string | null>(null);
  /** Whether the notice reports a failure or something done (shown in the error or the info style). */
  const [noticeTone, setNoticeTone] = useState<NoticeTone>('error');
  const setNotice: SetNotice = useCallback((message, tone = 'error') => {
    setNoticeText(message);
    setNoticeTone(tone);
  }, []);
  /** Report a failed edit where the user is looking. */
  const reportFailure: ReportFailure = useCallback((what, res) => {
    if (res.ok) return;
    const r = res.response as { code?: string; message?: string };
    setNotice(`${what} failed: ${r.message ?? r.code ?? 'unknown error'}`);
  }, [setNotice]);
  /** The editor's refresh, for the hooks made before it (a saved setting shows at once). */
  const refreshRef = useRef<() => void>(() => undefined);
  const projectSettings = useProjectSettings(clientRef, refreshRef);
  const { settings, modes, behaviorGroups, lightLayers, saveSchema, setGameplayError, receive: receiveSettings } = projectSettings;
  // The chunks each drawn instance set was split into (by entity id).
  const [instanceChunks, setInstanceChunks] = useState<Record<string, number>>({});
  /** The open scenes' headers and the closed scenes (a v4 project with scenes). */
  const [sceneHeaders, setSceneHeaders] = useState<SceneHeaderView[] | null>(null);
  const [closedScenes, setClosedScenes] = useState<{ sceneId: string; name: string }[]>([]);
  const playSession = usePlaySession(cfg, clientRef, modes.length, setGameplayError, setNotice);
  const { playing, setPlaying, playInfo, setPlayInfo, bridgeRef, playIframeRef, forwardRelayRef, playRenderer, playMode, play, stop, previewSrc } = playSession;

  // ---- Content browser + local snapping -------------------------
  /** Goes up when the catalog changed or records read by id arrived (views that read them draw again). */
  const [catalogTick, setCatalogTick] = useState(0);
  /** The asset tiles' pictures (from the import cache). */
  const [tileThumbnails, setTileThumbnails] = useState<TileThumbnails | null>(null);
  const docState = useDocumentState(clientRef, workspace, workspaceDispatch, content, catalogTick);
  const problems = useEditorProblems(clientRef, content, docState.visualProblems, catalogTick);
  /** The session client, for the panels below (the catalog and the summaries it read). */
  const [sessionClient, setSessionClient] = useState<SessionClient | null>(null);
  const assetSummary = useCallback((assetId: string) => clientRef.current?.content.getAsset(assetId), []);
  /** The selected copy of the selected instance set, and the instance brush. */
  const [selectedCopy, setSelectedCopy] = useState<number | null>(null);
  const instanceBrush = useInstanceBrush(selectedId);
  // The Scene view's helpers (Gizmos menu).
  // Collider outlines are off until asked for; the selection's are always drawn.
  const [gizmos, setGizmos] = useState({ icons: true, lights: true, colliders: false, gameplay: true, grid: true, probes: false });
  useEffect(() => viewportRef.current?.setGizmos(gizmos), [gizmos]);
  // Behind the Game view the Scene view draws nothing (Play is not paid for twice).
  useEffect(() => viewportRef.current?.setHidden(centerTab === 'game'), [centerTab]);
  // The Scene view plays the selected object's effect (edit mode; the Gizmos menu toggles it).
  const [effectPreview, setEffectPreview] = useState(false);
  // Occlusion culling in the Scene view (the View menu): on as Play culls, the culled draws' boxes, the depth pyramid.
  const [occlusionView, setOcclusionView] = useState<OcclusionViewState>(OCCLUSION_VIEW_DEFAULT);
  useEffect(() => viewportRef.current?.setOcclusionView(occlusionView), [occlusionView]);
  const [assetDropActive, setAssetDropActive] = useState(false);
  const [lightingMode, setLightingMode] = useState<'editor' | 'game'>('editor');
  const [seeThroughPreview, setSeeThroughPreview] = useState(false);
  const [snapping, setSnapping] = useState(true);
  // The snapping steps and cell-top snapping (editor settings per project, in this browser).
  const [snapSettings, setSnapSettingsState] = useState<SnapSettings>({ ...DEFAULT_SNAP_SETTINGS });
  /** Opens an object's edit mode (set once the edit mode's hook below is made; false: the object has none). */
  const enterEditModeRef = useRef<(entityId: string, kind?: string, activated?: boolean) => boolean>(() => false);
  // A new block layer opens in the block editor (one undo takes it away and closes the editor).
  const blocks = useBlockLayers({ clientRef, viewportRef, registry, cellTops: snapSettings.cellTops, reportFailure, setNotice, created: (id) => void (enterEditModeRef.current(id, 'blocks') || setSelectedId(id)) });
  const { setBlockEditor, blockHandlersRef, receive: receiveBlocks } = blocks;
  /** An edit mode shows (the default view's shortcuts stand aside). */
  const editModeShownRef = useRef(false);
  const terrainTools = useTerrainTools({ clientRef, viewportRef, reportFailure, setNotice, created: (id) => void (enterEditModeRef.current(id, 'terrain') || setSelectedId(id)) });
  const modelFilesRef = useRef<ModelFiles | null>(null);
  const shiftRef = useRef(false);
  const snappingRef = useRef(true);
  useEffect(() => {
    snappingRef.current = snapping;
  }, [snapping]);

  /** Models the scene view could not show (never silent). */
  const [viewFailures, setViewFailures] = useState<{ id: string; name: string; code: string; message: string }[]>([]);
  const sceneSync = useSceneViewSync({ clientRef, viewportRef, setEntities, setLiveTransform, setSceneHeaders, setClosedScenes, setUi, receiveContent, receiveSettings, receiveBlocks });
  const { refreshEntities, sendMaterials, materialLibraryRef, decalPagesRef, loadTextureRef, previewTextureRef } = sceneSync;
  refreshRef.current = refreshEntities;

  // ---- mount: create the client + viewport, connect -----------------------
  useEditorMount({
    cfg, clientRef, viewportRef, viewportHostRef, gestureRef, modelFilesRef, materialLibraryRef, loadTextureRef, previewTextureRef, workspaceRef, snappingRef, shiftRef, enterEditModeRef, gizmoMode,
    play: playSession, blocks, terrainTools, content,
    editCopies: () => editCopiesRef.current,
    forgetAssetPreview: () => assets.assetPreview.forget(),
    refreshEntities, setLiveTransform, setUi, setCenterTab, workspaceDispatch, setSessionClient, setSceneRenderer, setViewFailures, setInstanceChunks, setSelectedId, setSelectedCopy, setSnapSettingsState, setTileThumbnails, setCatalogTick, reportFailure, setNotice,
  });

  const { selectedIdRef, selectionRef, iconTable } = useSceneViewFollow({ clientRef, viewportRef, settings, seeThroughPreview, entities, selection, gizmoMode, instanceBrush, registry, setLightingMode, setSelectedCopy });
  const sameWindowTurn = useSelectionAcrossWindow(windowOpen, selection, setSelection, (id) => clientRef.current?.projection.getEntity(id) !== undefined);
  const selectLater = useCallback(() => {
    const pick = sameWindowTurn(setSelectedId);
    // An object made in an open prefab is drawn (and selectable) once the stage is read again.
    return (id: string | null): void => (openPrefabRef.current !== null && id !== null ? void refreshStage().then(() => pick(id)) : pick(id));
  }, [refreshStage, sameWindowTurn, setSelectedId]);
  // Drop selected ids whose entity is gone (deleted, undone).
  useEffect(() => {
    const present = new Set(entities.map((e) => e.id));
    if (selection.ids.every((id) => present.has(id))) return;
    const ids = selection.ids.filter((id) => present.has(id));
    setSelection({ ids, primary: selection.primary !== null && present.has(selection.primary) ? selection.primary : (ids.at(-1) ?? null) });
  }, [entities, selection]);

  // Shift+F11 toggles full screen (plain F11 belongs to the browser).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F11' || !e.shiftKey) return;
      e.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void document.documentElement.requestFullscreen().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The viewport canvas follows the stage element (dock splitters, tabs).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => viewportRef.current?.resize());
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const sceneView = useSceneViewLending(viewportHostRef, viewportRef);
  // While a prefab is open on its own, what the GameObject menu makes goes into the prefab: under its chosen object, else its root.
  const createParent = useCallback((): string | null => {
    const s = openPrefabRef.current;
    if (s === null) return null;
    const chosen = selectedIdRef.current;
    return chosen !== null && s.entities.some((e) => e.id === chosen) ? chosen : s.rootId;
  }, [selectedIdRef]);
  const sceneEditing = useSceneEditing({ clientRef, viewportRef, modelFilesRef, selectedIdRef, selectionRef, setSelectedId, selectLater, setSelectedCopy, setNotice, reportFailure, registry, refreshEntities, createParent });
  const { editCopiesRef, rename, move, sceneAction } = sceneEditing;
  useEditorShortcuts({ viewportRef, gestureRef, shiftRef, workspaceRef, editModeShownRef, selectedIdRef, setSelectedId, setGizmoMode, scene: sceneEditing });
  // An object's full-screen editor on the Scene view (terrain): set aside while the Scene view is not in front.
  const editMode = useEditMode({ entities, selection, setSelection, workspaceDispatch, closeSettings, sceneInFront: centerTab === 'scene' && !windowOpen && !settingsWindow.open });
  /** Open a prefab in the prefab editor (from the project window, a copy, the Inspector). */
  const { open: openStage, close: closeStage } = prefabStage;
  const enterMode = editMode.enter;
  const openPrefab = useCallback(
    async (prefabId: string): Promise<void> => {
      const rootId = await openStage(prefabId);
      if (rootId !== null) enterMode(rootId, 'prefab');
    },
    [openStage, enterMode],
  );
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;
  /**
   * A double-click (Hierarchy, Scene view) opens the object's editor; a prefab's copy with none opens its prefab
   * (a nested copy's, from inside a prefab).
   */
  const activate = useCallback(
    (entityId: string, kind?: string, activated = false, railMode?: string): boolean => {
      const e = entitiesRef.current.find((x) => x.id === entityId);
      const stagePrefab = prefabStage.stage?.prefabId;
      const onStage = onPrefabStage(e);
      if (!onStage && enterMode(entityId, kind, activated, railMode)) return true;
      const prefabId = activated ? e?.prefab?.prefabId : undefined;
      if (prefabId === undefined) return onStage;
      if (!onStage || prefabId !== stagePrefab) void openPrefab(prefabId);
      return true;
    },
    [enterMode, openPrefab, prefabStage.stage?.prefabId],
  );
  enterEditModeRef.current = activate;
  editModeShownRef.current = editMode.shown;
  // The stage is kept only while the prefab editor is open (leaving it, or opening another editor, closes it).
  const modeKind = editMode.state?.kind;
  useEffect(() => {
    if (modeKind !== 'prefab' && prefabStage.stage !== null) closeStage();
  }, [modeKind, prefabStage.stage, closeStage]);

  const dialogs = useEditorDialogs({ clientRef, play, createEntityAt: sceneEditing.createEntityAt });
  const resync = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    void c.fullResync().then(() => refreshEntities());
  }, [refreshEntities]);

  const cue = useCuePreview(clientRef);
  const entityEditing = useEntityEditing({ clientRef, viewportRef, modelFilesRef, refreshEntities, reportFailure, setNotice, registry, entities, selectedId });
  const prefab = usePrefabAuthoring({ clientRef, selectedIdRef, declarations: content.declarations, runTypedCommand: entityEditing.runTypedCommand, setNotice });
  /** An item chosen in the project window since the last selection: the Inspector shows it. */
  const [inspectedItem, setInspectedItem] = useState<ProjectItem | null>(null);
  useEffect(() => setInspectedItem(null), [selection]);
  const { choosePrefab } = prefab;
  const inspect = useCallback(
    (item: ProjectItem) => {
      setInspectedItem(item);
      if (item.kind === 'prefab') choosePrefab(item.id);
    },
    [choosePrefab],
  );
  /** The Window menu's floating tool windows over the Scene view. */
  const toolWindows = useToolWindows();
  const workareaRef = useRef<HTMLDivElement | null>(null);
  const showToolWindow = useCallback(
    (id: ToolWindowId) => {
      setCenterTab('scene');
      toolWindows.show(id, defaultToolPlace(workareaRef.current, stageRef.current, TOOL_WINDOWS.findIndex((t) => t.id === id)));
    },
    [setCenterTab, toolWindows],
  );
  // ---- Asset files in the game folder -------------
  // The file check (useAssetFileCheck.ts): moved and changed files, Problems rows.
  const fileCheck = useAssetFileCheck(clientRef, ui.connection);
  /** Models the scene view could not show (never silent). */

  const assets = useAssetsWindow({
    clientRef,
    modelFilesRef,
    refreshEntities,
    reportFailure,
    checkFiles: fileCheck.checkFiles,
    catalogTick,
    showAssets: () => setBottomTab('assets'),
    // What a double-click in the project window opens.
    openers: {
      openDocument: (kind, id) => workspaceDispatch({ type: 'open', doc: { kind, id } }),
      isVisualScript: (id) => behaviorViews.find((b) => b.behaviorId === id)?.graph !== undefined,
      openScene: (sceneId) => {
        void sceneAction({ kind: 'open', sceneId }).then(() => sceneAction({ kind: 'activate', sceneId }));
        setCenterTab('scene');
      },
      opensMaterialTab: (id) => {
        const m = materials.find((x) => x.materialId === id);
        return m !== undefined && (m.graph !== undefined || m.shader === 'trim');
      },
      openPrefab: (prefabId) => void openPrefab(prefabId),
      inspect,
      showEnvironment: () => showToolWindow('environment'),
    },
  });
  const assetActions = useAssetActions({
    clientRef,
    viewportRef,
    modelFilesRef,
    selectedAssetId: assets.selectedAssetId,
    selectedAssetIdRef: assets.selectedAssetIdRef,
    setSelectedAssetId: assets.setSelectedAssetId,
    setSelectedId,
    runTypedCommand: entityEditing.runTypedCommand,
    reportFailure,
  });
  const { dropAsset } = assetActions;
  const { filePicker, setFilePicker } = assets;
  const docCmds = useDocumentCommands({ clientRef, viewportRef, workspaceDispatch, setGraphFocus: docState.setGraphFocus });
  // The kit editor (its tab and the Inspector beside it share its state).
  const kitEditor = useKitEditor(clientRef, workspace, content.kits, ui.revision);
  const activeScene = sceneHeaders?.find((h) => h.active) ?? null;
  const bake = useLightingBake(clientRef, viewportRef, activeScene, refreshEntities, toolWindows.isOpen('lighting'), sceneRenderer?.api ?? null);
  const newMaterialId = useCallback((name: string) => freeItemId(name, 'material', (ids) => clientRef.current?.catalog.taken(ids, ['material']) ?? Promise.resolve(new Set<string>())), []);
  // The decal editor's selection, settings and commands (its tool is armed while the mode shows).
  const decalTools = useDecalTools({ clientRef, viewportRef, materials, sceneId: activeScene?.sceneId ?? null, newMaterialId, setNotice, reportFailure });
  // The decal atlas: the pages the build will make (the decal editor's drawer) and the composed ones the Scene view draws from.
  const decalWatch = useMemo(() => JSON.stringify([materials, entities.flatMap((e) => ((e.components['decal'] as { material?: string } | undefined)?.material ?? [])).sort(), catalogTick]), [materials, entities, catalogTick]);
  const preloadDecalPages = useCallback((ids: readonly string[]) => viewportRef.current?.preloadTextures(ids.map(decalPageTextureKey)) ?? null, []);
  const decalAtlas = useDecalAtlas({ clientRef, watch: decalWatch, preload: preloadDecalPages });
  useEffect(() => {
    decalPagesRef.current = decalAtlas.drawn;
    sendMaterials();
  }, [decalPagesRef, decalAtlas.drawn, sendMaterials]);
  // The vertex paint editor's brush wiring.
  const vertexPaint = useVertexPaintTools({ clientRef, viewportRef, setNotice });

  const scripting = useScripting({ clientRef, behaviorViews, scriptLibraries: content.scriptLibraries, refreshEntities, workspace, workspaceDispatch, openDocument, playInfo, trustEntries: content.trustEntries });

  // A rejected token is forgotten and asked for again; an unknown project
  // goes back to the picker.
  useEffect(() => {
    if (ui.connection !== 'disconnected' || !cfg.current.ok) return;
    const projectId = cfg.current.config.projectId;
    if (ui.error?.code === 'unauthorized') {
      forgetToken();
      setGate({ kind: 'token', message: 'The backend rejected the access token.' });
    } else if (ui.error?.code === 'project_not_found') {
      setGate({ kind: 'projects', message: `Project "${projectId}" does not exist on this backend.` });
    }
  }, [ui.connection, ui.error]);

  const animatorTools = useAnimatorTools({ clientRef, modelFilesRef, reportFailure, animators, openDocument, sendGraphEdit: docCmds.sendGraphEdit });
  const { modelNodesOf, modelSkinnedOf } = animatorTools;
  // New items, renames and deletes in the project window and the Inspector.
  const items = useItemActions({
    clientRef,
    content,
    workspaceDispatch,
    inspect,
    openDocument,
    onDeleted: (item) => setInspectedItem((cur) => (cur !== null && cur.kind === item.kind && cur.id === item.id ? null : cur)),
    chosenModel: () => {
      const id = assets.selectedAssetIdRef.current;
      return id !== null && clientRef.current?.content.getAsset(id)?.kind === 'model' ? id : null;
    },
    clipsOf: animatorTools.clipsOf,
  });

  const { selectedEntity, structureKey, hierarchyFlags, tagUsage, layerUsage, groupUsage, fieldContext } = useEntityIndexes({ clientRef, viewportRef, loadTextureRef, entities, selectedId, liveTransform, content, registry, settings: projectSettings, animator: animatorTools, effectPreview });

  // A hook, so before the early returns below: the UI preview reads the textures and fonts the UI names through the editor's authenticated asset path.
  const uiPreviewAssets = useUiPreviewAssets(clientRef, uiDocuments, uiThemes, catalogTick);

  return {
    activate, openPrefab, prefabStage, sceneEntities,
    activeScene, animatorTools, assetActions, assetDropActive, assetSummary, assets, bake, blockHandlersRef, blocks, bottomTab, centerTab, cfg, clientRef, closeSettings, closedScenes, content, cue, decalAtlas, decalTools, dialogs, docCmds, docState, dropAsset, editMode, effectPreview, entities, entityEditing, fieldContext, fileCheck, filePicker, gizmoMode, gizmos, groupUsage, hierarchyFlags, iconTable, inspect, inspectedItem, instanceBrush, instanceChunks, items, kitEditor, layerUsage, lightingMode, loadTextureRef, materials, modelFilesRef, modes, move, newMaterialId, notice, noticeTone, occlusionView, openDocument, play, playIframeRef, playInfo, playMode, playRenderer, playSession, playing, prefab, prefabSummaries, previewSrc, previewTextureRef, problems, projectSearch, projectSettings, registry, rename, reportFailure, resync, saveSchema, sceneAction, sceneEditing, sceneHeaders, sceneRenderer, sceneView, scripting, seeThroughPreview, selectedCopy, selectedEntity, selectedId, selection, sessionClient, setAssetDropActive, setBottomTab, setCenterTab, setEffectPreview, setFilePicker, setGizmoMode, setGizmos, setLightingMode, setNotice, setOcclusionView, setProjectSearch, setSeeThroughPreview, setSelectedCopy, setSelectedId, setSelection, setSnapSettingsState, setSnapping, settings, settingsWindow, showToolWindow, sizes, snapSettings, snapping, splitter, stageRef, stop, structureKey, tagUsage, terrainTools, tileThumbnails, toolWindows, ui, uiPreviewAssets, vertexPaint, viewFailures, viewportHostRef, viewportRef, windowOpen, workareaRef, workspace, workspaceDispatch, gate,
  };
}

export type EditorModel = ReturnType<typeof useEditorModel>;
