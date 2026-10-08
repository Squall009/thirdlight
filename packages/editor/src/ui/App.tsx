/**
 * Editor app root (React). Makes the session client (backend transport) and
 * the imperative three.js viewport (framework-free) once per mount, keeps the
 * Scene view in step with the projection, and lays out the shell: menus,
 * toolbar, hierarchy, the centre (Scene and Game views), the bottom dock, the
 * Inspector, the editor window over them (an opened item's editor beside the
 * same Inspector) and the dialogs. React renders the panels + the
 * canvas element; it never instantiates or mutates Object3Ds (the viewport
 * owns those).
 *
 * Each area's state and commands live in its own module (`shell/*`,
 * `workspace/*`): Play and its preview bridge, the project's content and
 * settings, scene and Inspector edits, prefabs, blocks, bakes, scripts, the
 * documents' commands and selections, the dialogs and the menus. Every
 * authoring decision is delegated to the pure `session/*` modules; React
 * renders controls and issues ordinary typed commands through the same single
 * client path.
 *
 * Browser-only.
 */
import * as THREE from 'three';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { forgetToken, readEditorConfig } from '../config';
import { ProjectsScreen, TokenForm } from './Projects';
import { useDockSizes } from './layout';
import { MenuBar } from './MenuBar';
import { SessionClient, type ClientUiState, type PlayStartResult } from '../session/client';
import type { ProjectedEntity } from '../session/projection';
import { effectiveFlagsOf } from '../session/hierarchy';
import { ASSET_DRAG_TYPE, parseAssetDrag } from '../session/placement';
import { collectSignals } from '../session/descriptor-fields';
import type { FieldContext } from './DescriptorFields';
import { Gesture } from '../session/gesture';
import { Viewport, type GizmoMode } from '../viewport/viewport';
import { iconTableOf } from '../viewport/icons';
import { ModelFiles } from '../viewport/model-files';
import { createSceneViewAssets } from '../viewport/scene-assets';
import { extractedImagePictures, TileThumbnails } from '../viewport/thumbnails';
import { setKtx2DecoderBase, pageSearch, resolveRendererPreference, type EnvironmentLike, type LightingBakeLike, type MaterialDefLike, type MaterialFunctionLike, type MaterialLibrary, type RendererInfo, type WindLike } from '@thirdlight/three-adapter';
import { editorRendererChoice, setEditorRendererChoice } from '../viewport/renderer-choice';
import type { EffectComponent, MaterialDef } from '@thirdlight/project-model';
import { lodTuningOf, renderSettingsOf } from '@thirdlight/project-model/limits';
import { withSlotTextureKeys } from '../session/texture-slots';
import { ARCHITECTURE_PRESET_KIND, ARCHITECTURE_STYLE_KIND, viewLensOf } from '@thirdlight/runtime';
import { Hierarchy, type SceneAction, type SceneHeaderView } from './Hierarchy';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { CatalogProvider } from './catalog/catalog-context';
import { ItemOpenerProvider } from './catalog/item-opener';
import { useUiPreviewAssets } from './uidoc/useUiPreviewAssets';
import { MATERIAL_DRAG_TYPE } from './material/MaterialInspector';
import { CentreTabs, EditorWindow, useSelectionAcrossWindow, useWorkspace } from './workspace/EditorWindow';
import { ProjectSettingsWindow, useProjectSettingsWindow } from './settings/ProjectSettingsWindow';
import { activeDoc } from '../session/editor-window';
import { DEFAULT_SNAP_SETTINGS, loadSnapSettings, type SnapSettings } from '../session/snapping';
import { ProjectFilePicker } from './ProjectFilePicker';
import { useAssetFileCheck } from './useAssetFileCheck';
import { useProjectContent } from './shell/useProjectContent';
import { useProjectSettings } from './shell/useProjectSettings';
import { usePlaySession } from './shell/usePlaySession';
import { useDocumentState } from './workspace/useDocumentState';
import { useDocumentCommands } from './workspace/useDocumentCommands';
import { workspaceHostOf } from './workspace/workspace-host';
import { useEditorProblems } from './shell/useEditorProblems';
import { useBlockLayers } from './shell/useBlockLayers';
import { useTerrainTools } from './shell/useTerrainTools';
import { useSceneEditing } from './shell/useSceneEditing';
import { useEditorShortcuts } from './shell/useEditorShortcuts';
import { useEditorDialogs } from './shell/useEditorDialogs';
import { EditorDialogs } from './shell/EditorDialogs';
import { useCuePreview } from './shell/useCuePreview';
import { useSceneViewLending } from './shell/useSceneViewLending';
import { useEntityEditing } from './shell/useEntityEditing';
import { usePrefabAuthoring } from './shell/usePrefabAuthoring';
import { useAssetsWindow } from './shell/useAssetsWindow';
import { useItemActions } from './project/useItemActions';
import type { ProjectItem } from '../session/project-items';
import { useAssetActions } from './shell/useAssetActions';
import { useLightingBake } from './shell/useLightingBake';
import { useScripting } from './shell/useScripting';
import { withSceneViewInteriors } from '../session/building-interiors';
import { useAnimatorTools } from './shell/useAnimatorTools';
import { editorMenus, hierarchyContextMenu } from './shell/menus';
import { BottomDock } from './shell/BottomDock';
import { InspectorDock } from './shell/InspectorDock';
import { useInstanceBrush } from './instances/InstanceBrush';
import type { BottomTab } from './shell/dock-tabs';
import { TOOL_WINDOWS, useToolWindows, type ToolWindowId } from './tools/tool-windows';
import { defaultToolPlace, SceneToolWindows } from './tools/SceneToolWindows';
import type { ReportFailure } from './shell/commands';

// KTX2 textures (and GLBs with KHR_texture_basisu) transcode with three's Basis files next to the editor page.
setKtx2DecoderBase('./decoders/');

/** The first asset or index item of some kinds the catalog has read (a starting choice), if any. */
function firstOfKinds(c: SessionClient | null, kinds: readonly string[]): string | undefined {
  return c?.catalog.firstOf(kinds);
}

/** What the Scene view draws: the open scenes' objects and the interiors buildings make into them. */
function sceneViewEntities(c: SessionClient, visible: readonly ProjectedEntity[] = c.visibleEntities()): ProjectedEntity[] {
  return withSceneViewInteriors(visible, c.projection.listEntities(), new Set(c.getSceneView().open)) as ProjectedEntity[];
}

/** The pickers' option per projected entity object (see fieldContextBase). */
const entityOptionCache = new WeakMap<ProjectedEntity, { id: string; name: string; sceneId?: string; components: string[] }>();

function EditorApp(): JSX.Element {
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
  const [entities, setEntities] = useState<ProjectedEntity[]>([]);
  /** The transform a Scene-view gesture shows while it runs (the Inspector readout), until the change lands. */
  const [liveTransform, setLiveTransform] = useState<{ id: string; position: number[]; rotation: number[]; scale: number[] } | null>(null);
  /** The hierarchy selection (several ids) and its primary entity (inspector, gizmo). */
  const [selection, setSelection] = useState<{ ids: string[]; primary: string | null }>({ ids: [], primary: null });
  const selectedId = selection.primary;
  const setSelectedId = useCallback((id: string | null) => setSelection({ ids: id === null ? [] : [id], primary: id }), []);
  const [ui, setUi] = useState<ClientUiState>({ connection: 'idle', save: 'idle', error: null, conflict: null, revision: 0, undoDepth: 0, redoDepth: 0, external: null, problems: [] });
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
  const [notice, setNotice] = useState<string | null>(null);
  /** Report a failed edit where the user is looking. */
  const reportFailure: ReportFailure = useCallback((what, res) => {
    if (res.ok) return;
    const r = res.response as { code?: string; message?: string };
    setNotice(`${what} failed: ${r.message ?? r.code ?? 'unknown error'}`);
  }, []);
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
  const materialLibraryRef = useRef<MaterialLibrary | null>(null);
  const materialsKeyRef = useRef('');
  const environmentKeyRef = useRef('');
  const lightingKeyRef = useRef('');
  const architectureKeyRef = useRef('');
  const loadTextureRef = useRef<((assetId: string) => Promise<THREE.Texture | null>) | null>(null);
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
  const [assetDropActive, setAssetDropActive] = useState(false);
  const [lightingMode, setLightingMode] = useState<'editor' | 'game'>('editor');
  const [snapping, setSnapping] = useState(true);
  // The snapping steps and cell-top snapping (editor settings per project, in this browser).
  const [snapSettings, setSnapSettingsState] = useState<SnapSettings>({ ...DEFAULT_SNAP_SETTINGS });
  const blocks = useBlockLayers({ clientRef, viewportRef, registry, cellTops: snapSettings.cellTops, reportFailure, setNotice, selectedId, select: setSelectedId });
  const { setBlockEditor, blockHandlersRef, receive: receiveBlocks } = blocks;
  const terrainTools = useTerrainTools({ clientRef, viewportRef, reportFailure, setNotice, select: setSelectedId });
  const modelFilesRef = useRef<ModelFiles | null>(null);
  const shiftRef = useRef(false);
  const snappingRef = useRef(true);
  useEffect(() => {
    snappingRef.current = snapping;
  }, [snapping]);

  /** The environment the Scene view shows: the active scene's look with the project's quality and presets. */
  const applyEnvironmentView = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    const shown = c.getShownEnvironment() as unknown as (EnvironmentLike & { wind?: unknown }) | null;
    materialLibraryRef.current?.setWind(((shown as { wind?: WindLike } | null)?.wind ?? null) as WindLike | null);
    materialLibraryRef.current?.setWetness((shown as { wetness?: number } | null)?.wetness ?? 0);
    const envKey = JSON.stringify(shown);
    if (envKey !== environmentKeyRef.current && loadTextureRef.current !== null) {
      environmentKeyRef.current = envKey;
      viewportRef.current?.setEnvironment(shown === null ? null : (shown as EnvironmentLike));
    }
  }, []);

  // A refresh after every applied change must not hand React new
  // objects for what did not change — every panel keyed on them would redraw
  // (and effects such as the asset thumbnails and the Scene view sync would
  // rerun). A slice keeps its previous object while its content is the same.
  const stableRef = useRef(new Map<string, { key: string; value: unknown }>());
  const stable = useCallback(<T,>(slot: string, value: T, key: string = JSON.stringify(value instanceof Map ? [...value] : value) ?? 'undefined'): T => {
    const prev = stableRef.current.get(slot);
    if (prev !== undefined && prev.key === key) return prev.value as T;
    stableRef.current.set(slot, { key, value });
    return value;
  }, []);
  const refreshEntities = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    // The projection hands out the same array until an entity changes.
    setEntities(c.visibleEntities());
    setLiveTransform(null);
    // The scene headers (open scenes) and the closed scenes.
    const scenes = c.projection.scenes;
    if (scenes.length === 0) {
      setSceneHeaders(null);
      setClosedScenes(stable('closedScenes', []));
    } else {
      const view = c.getSceneView();
      const counts = new Map<string, number>();
      for (const e of c.projection.listEntities()) if (e.sceneId !== undefined) counts.set(e.sceneId, (counts.get(e.sceneId) ?? 0) + 1);
      const start = new Set(c.projection.startScenes);
      setSceneHeaders(stable('sceneHeaders', scenes.filter((r) => view.open.includes(r.sceneId)).map((r) => ({ sceneId: r.sceneId, name: r.name, start: start.has(r.sceneId), active: r.sceneId === view.active, entityCount: counts.get(r.sceneId) ?? 0 }))));
      setClosedScenes(stable('closedScenes', scenes.filter((r) => !view.open.includes(r.sceneId)).map((r) => ({ sceneId: r.sceneId, name: r.name }))));
    }
    const { materials: mats, lighting, lightingKey } = receiveContent(c, stable);
    receiveSettings(c, stable);
    // Graph materials compile to TSL in the Scene view too (the library recompiles only when a
    // graph's compile input changes — moving a node does not), with the material functions they call.
    const libFunctions = c.getGraphs().filter((g) => g.kind === 'material-function');
    const matsKey = JSON.stringify([mats, libFunctions]);
    if (matsKey !== materialsKeyRef.current) {
      materialsKeyRef.current = matsKey;
      // A material's per-layer texture slots draw as the array the backend assembles from them.
      materialLibraryRef.current?.setMaterials(withSlotTextureKeys(mats as unknown as MaterialDef[]) as unknown as MaterialDefLike[], libFunctions as unknown as MaterialFunctionLike[]);
      // A material that animates (wind, water) keeps the Scene view drawing from this frame on.
      viewportRef.current?.requestRender();
    }
    // Generated architecture's styles and presets: outlines are made again where their elements changed.
    const archGraphs = c.getGraphs().filter((g) => g.kind === ARCHITECTURE_STYLE_KIND || g.kind === ARCHITECTURE_PRESET_KIND);
    const archKey = JSON.stringify(archGraphs);
    if (archKey !== architectureKeyRef.current) {
      architectureKeyRef.current = archKey;
      viewportRef.current?.setArchitectureStyles(archGraphs);
    }
    // The project environment (wind included).
    applyEnvironmentView();
    // The scenes' bakes (lightmaps in the Scene view with game lighting).
    if (lightingKey !== lightingKeyRef.current && loadTextureRef.current !== null) {
      lightingKeyRef.current = lightingKey;
      viewportRef.current?.setLightmaps(lighting as unknown as Record<string, LightingBakeLike>);
    }
    receiveBlocks(c, stable);
    setUi((s) => (s.revision === c.projection.revision ? s : { ...s, revision: c.projection.revision }));
  }, [applyEnvironmentView, stable, receiveContent, receiveSettings, receiveBlocks]);
  refreshRef.current = refreshEntities;

  // ---- mount: create the client + viewport, connect -----------------------
  useEffect(() => {
    if (!cfg.current.ok) return;
    const config = cfg.current.config;
    const client = new SessionClient(config, {
      onState: (s) => setUi(s),
      onSceneChanged: () => refreshEntities(),
      onPlayStarted: (r: PlayStartResult & { snapshot: unknown }) => {
        setPlaying(true);
        setCenterTab('game');
        setPlayInfo((p) => ({
          playSessionId: r.playSessionId,
          playBase: r.playBase,
          snapshot: r.snapshot,
          snapshotId: r.snapshotId,
          revision: r.revision,
          contentId: r.playContent?.contentId ?? p?.contentId ?? null,
          buildId: r.playContent?.buildId ?? p?.buildId ?? null,
          contentPath: r.playContent?.path ?? p?.contentPath ?? null,
        }));
      },
      onPlayStopRequested: (playSessionId) => {
        bridgeRef.current?.requestStop(playSessionId);
      },
      onPlayStopped: () => {
        setPlaying(false);
        // Back to the Scene from the (now empty) Game view; an editor window stays in front.
        if (workspaceRef.current.view === 'game') workspaceDispatch({ type: 'view', view: 'scene' });
        setPlayInfo(null);
        bridgeRef.current = null;
      },
      onRelayRequest: (req) => forwardRelayRef.current(req),
    });
    clientRef.current = client;
    setSessionClient(client);

    // The Viewport owns its canvas (a renderer backend change swaps it for a fresh one).
    const canvas = document.createElement('canvas');
    canvas.className = 'tl-viewport';
    viewportHostRef.current!.replaceChildren(canvas);
    const initialRenderer = resolveRendererPreference({ url: pageSearch() });
    setEditorRendererChoice(initialRenderer);
    // What the Scene view loads from assets (models, textures, project materials), in one resource manager:
    // its adapter draws the placements from it, the editor's panels read the same files through it.
    // The resolver is the editor's authenticated byte read; the renderer never receives the token.
    // A placement's file that failed and the editor's own reads that failed, together in Problems.
    let viewFailed: ReadonlyMap<string, { code: string; message: string }> = new Map();
    let filesFailed: ReadonlyMap<string, { code: string; message: string }> = new Map();
    const showFailures = (): void => setViewFailures([...new Map([...filesFailed, ...viewFailed])].map(([id, f]) => ({ id, name: client.content.getAsset(id)?.displayName ?? id, code: f.code, message: f.message })));
    const sceneAssets = createSceneViewAssets({
      client,
      changed: () => viewportRef.current?.materialsChanged(),
      // What the Scene view holds from assets now (tests read it).
      onResources: (r) => viewportHostRef.current?.setAttribute('data-resources', JSON.stringify(r.resident)),
      onSetBuilt: (entityId, chunks) => setInstanceChunks((prev) => (prev[entityId] === chunks ? prev : { ...prev, [entityId]: chunks })),
      onFailuresChanged: (failures) => {
        filesFailed = new Map(failures);
        showFailures();
      },
    });
    const viewport = new Viewport(canvas, {
      onPick: (id) => {
        setSelectedId(id);
        viewport.setSelected(id, gizmoMode);
      },
      onGestureBegin: (id) => {
        const base = client.entityTransform(id);
        gestureRef.current = base ? new Gesture(id, client.projection.revision, base) : null;
      },
      onGestureFrame: (id, t) => {
        // The viewport already moved the Object3D (local preview, no traffic);
        // mirror the live transform into the inspector readout.
        // Only the readout changes (the entity list keeps its identity, so nothing else redraws).
        setLiveTransform({ id, position: t.position, rotation: t.rotation, scale: t.scale });
      },
      onGestureEnd: async (id, transform) => {
        const g = gestureRef.current;
        gestureRef.current = null;
        // Any outcome other than an accepted commit restores the projection
        // (an accepted commit arrives as mutation.applied and refreshes it).
        const restore = (): void => {
          refreshEntities();
          viewport.syncEntities(sceneViewEntities(client));
        };
        if (!g) return restore();
        g.setLocal(transform);
        const outcome = g.decideCommit();
        if (outcome.kind !== 'commit') return restore();
        // A prop's block footprint follows it in the same command (the backend writes it).
        const res = await client.command('setTransform', { entityId: id, transform: outcome.command.args.transform }, outcome.command.expectedRevision);
        if (res.ok) return;
        if (res.response.ok === false && res.response.code === 'revision_conflict') {
          // Bounded auto-rebase (≤ 1) via the gesture; if it still conflicts,
          // the conflict is surfaced in the status bar (explained, not lost).
          const retried = g.handleResult(
            { ok: false, code: 'revision_conflict', currentRevision: res.response.currentRevision ?? 0 },
            () => client.entityTransform(id) ?? transform,
          );
          if (retried.kind === 'commit') {
            const r2 = await client.command('setTransform', { entityId: id, transform: retried.command.args.transform }, retried.command.expectedRevision);
            if (r2.ok) {
              return;
            }
          }
        }
        restore();
      },
      // A dragged handle (any descriptor handle: sizes, radii, capsules, ranges, cones,
      // directions, paths, polygon corners) — one setComponent on release, one undo step.
      onHandleEdit: (entityId, component, value) => {
        const c = clientRef.current;
        if (!c) return;
        void c.setComponent(entityId, component, value, c.projection.revision).then((r) => {
          // A drag that ends where it began changes nothing: not an error.
          if (!r.ok && (r.response as { code?: string }).code === 'no_change') return;
          reportFailure(component === 'controller' ? 'Collision capsule' : 'Handle edit', r);
        });
      },
      onHandleRefused: (message) => setNotice(`Not stored: ${message}`),
      // One copy of an instance set.
      onCopyPick: (_entityId, index) => {
        viewportRef.current?.setSelectedCopy(index);
        setSelectedCopy(index);
      },
      onCopyTransform: (entityId, index, t) => void editCopiesRef.current.transform(entityId, index, t),
      onBrushStroke: (entityId, stroke) => editCopiesRef.current.paint(entityId, stroke),
      onRendererChange: (info) => setSceneRenderer(info),
      onModelFailures: (failures) => {
        viewFailed = failures;
        showFailures();
      },
    }, { assets: sceneAssets, snapping: () => snappingRef.current && !shiftRef.current, renderer: initialRenderer });
    setSceneRenderer(viewport.rendererInfo());
    viewportRef.current = viewport;
    viewport.setHidden(workspaceRef.current.view === 'game');
    // The block tools (a stroke is one editBlocks, sent on release).
    const blockEd = viewport.blockEditor({
      onCommit: async (entityId, edits) => {
        const r = await client.command('editBlocks', { entityId, edits }, client.projection.revision);
        if (!r.ok && (r.response as { code?: string }).code === 'no_change') return false;
        if (!r.ok) setNotice(`Block edit failed: ${(r.response as { message?: string }).message ?? (r.response as { code?: string }).code ?? 'unknown error'}`);
        else blockHandlersRef.current?.onCommitted(entityId, edits);
        return r.ok;
      },
      onPick: (cell) => blockHandlersRef.current?.onPick(cell),
      onSelect: (box) => blockHandlersRef.current?.onSelect(box),
      onHover: (at, cell) => blockHandlersRef.current?.onHover(at, cell),
      onRefused: (message) => setNotice(message),
    });
    setBlockEditor(blockEd);
    // The terrain tools (a stroke is one editTerrain, previewed on the GPU, sent on release).
    terrainTools.makeTerrainEditor(client);
    setSnapSettingsState(loadSnapSettings(typeof window !== 'undefined' ? window.localStorage : null, config.projectId));
    const { loadTexture: loadTextureAsset, materialLibrary, files } = sceneAssets;
    loadTextureRef.current = loadTextureAsset;
    materialLibraryRef.current = materialLibrary;
    modelFilesRef.current = files;
    const thumbnails = new TileThumbnails({
      read: (digest, piece, make) => client.thumbnail(digest, piece, make),
      store: (digest, piece, png) => client.storeThumbnail(digest, piece, png),
      modelBytes: (assetId, version) => client.assetBytes(assetId, version),
      vertexColorsFor: (assetId) => (client.content.getAsset(assetId)?.vertexColors === 'tint' ? 'tint' : 'data'),
      renderer: () => editorRendererChoice(),
      extractedImages: (assetId) => extractedImagePictures(client, assetId),
    });
    setTileThumbnails(thumbnails);
    // Records read by id arrived (a model the Scene view waited for) or the catalog changed: draw again.
    let loadedSeen = client.catalog.loaded;
    const unsubscribe = client.catalog.subscribe(() => {
      setCatalogTick((t) => t + 1);
      if (client.catalog.loaded !== loadedSeen) {
        loadedSeen = client.catalog.loaded;
        viewport.syncEntities(sceneViewEntities(client));
        // Conversations read by id (a tab opened, a preview's jumps).
        content.setDialogues(client.getDialogues());
      }
      // An asset's facts changed (a reimport, its vertex colours or default materials): its placements are drawn again.
      viewport.assetsChanged();
    });
    viewport.resize();
    void client.connect();
    refreshEntities();

    const onResize = (): void => viewport.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      unsubscribe();
      setSessionClient(null);
      client.dispose();
      thumbnails.dispose();
      setTileThumbnails(null);
      // The view first: its adapter lets go of what it holds in the assets' manager.
      viewport.dispose();
      sceneAssets.dispose();
      materialLibraryRef.current = null;
      modelFilesRef.current = null;
      assets.assetPreview.forget();
      clientRef.current = null;
      viewportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the viewport and session client are made once per mount
  }, []);

  // A changed project chunk size rebuilds the instance sets that use it.
  const instanceChunkSetting = settings?.['instance_chunk_m'];
  useEffect(() => {
    viewportRef.current?.setInstanceChunkSize(typeof instanceChunkSetting === 'number' && instanceChunkSetting > 0 ? instanceChunkSetting : undefined);
  }, [instanceChunkSetting]);

  // The project's LOD bias and hysteresis: the Scene view picks levels as Play does.
  const lodBiasSetting = settings?.['lod_bias'];
  const lodHysteresisSetting = settings?.['lod_hysteresis'];
  useEffect(() => {
    viewportRef.current?.setLodTuning(lodTuningOf({ lod_bias: lodBiasSetting, lod_hysteresis: lodHysteresisSetting }));
  }, [lodBiasSetting, lodHysteresisSetting]);

  // The project's ambient occlusion kind: the Scene view draws a look's AO as Play does (render scale and dynamic
  // resolution are Play's and the export's: the Scene view stays at full resolution).
  const aoSetting = settings?.['ambient_occlusion'];
  useEffect(() => {
    viewportRef.current?.setAmbientOcclusion(renderSettingsOf({ ambient_occlusion: aoSetting }).ambientOcclusion);
  }, [aoSetting]);

  // The project's render_backend setting (under the page's ?renderer= flag) picks the
  // Scene view's backend and the one previews and thumbnails create their renderer with.
  const renderBackendSetting = settings?.['render_backend'];
  useEffect(() => {
    const choice = resolveRendererPreference({ url: pageSearch(), setting: renderBackendSetting });
    setEditorRendererChoice(choice);
    viewportRef.current?.setRendererChoice(choice.preference, choice.source);
  }, [renderBackendSetting]);

  // A ref mirror of selectedId for the viewport callbacks (stable closure).
  const selectedIdRef = useRef<string | null>(null);
  const selectionRef = useRef<string[]>([]);
  useEffect(() => {
    selectionRef.current = selection.ids;
  }, [selection]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Push the projection into the viewport (placements must be
  // visible; the viewport renders the projection, never the reverse). The
  // first non-empty scene is framed so a large level is in view on open.
  // Animated materials (wind, water) need frames while they are in view:
  // the Scene view ticks them with its own frames and keeps drawing only while one is animated
  // (render on demand: no animation-frame loop while nothing changes).

  const framedRef = useRef(false);
  useEffect(() => {
    // Only what changed since the last sync (the projection's dirty ids; a hydrate syncs all).
    const c = clientRef.current;
    viewportRef.current?.syncEntities(c !== null ? sceneViewEntities(c, entities) : entities, c?.projection.takeDirty());
    const lit = viewportRef.current?.getLighting();
    if (lit !== undefined) setLightingMode(lit);
    if (!framedRef.current && entities.length > 0) {
      framedRef.current = true;
      viewportRef.current?.frameAll(entities);
    }
  }, [entities]);

  // Selection → gizmo, and to the backend (tools can inspect the selection).
  useEffect(() => {
    viewportRef.current?.setSelected(selectedId, gizmoMode);
  }, [selectedId, gizmoMode]);
  // Another selection drops the selected copy (and the brush's mode, in its hook).
  useEffect(() => {
    setSelectedCopy(null);
  }, [selectedId]);
  useEffect(() => {
    viewportRef.current?.setInstanceBrush(instanceBrush.mode !== 'off' ? selectedId : null, instanceBrush.mode === 'erase' ? 'erase' : 'paint', instanceBrush.brush);
  }, [instanceBrush.mode, instanceBrush.brush, selectedId]);
  // The descriptors drive the Scene-view handles.
  useEffect(() => {
    viewportRef.current?.setDescriptors(registry);
  }, [registry]);
  // The hierarchy's row icons come from the descriptors too.
  const iconTable = useMemo(() => iconTableOf(registry), [registry]);
  // Handles of one physics dimension (a 3D character's heights) follow the project's.
  const physicsDimension = settings?.['physics_dimension'] === 3 ? 3 : 2;
  useEffect(() => {
    viewportRef.current?.setPhysicsDimension(physicsDimension);
  }, [physicsDimension]);
  // The cameras without a lens of their own use the project's (its camera settings), in the Scene view as in Play.
  const lensKey = JSON.stringify(viewLensOf(settings));
  useEffect(() => {
    viewportRef.current?.setViewLens(JSON.parse(lensKey) as { fovY: number; near: number; far: number });
  }, [lensKey]);
  // The cameras' frustums use the game view's aspect: the preview while it plays, else the window (an export fills it).
  useEffect(() => {
    const update = (): void => {
      const frame = document.querySelector('iframe.tl-app__preview-frame');
      const r = frame?.getBoundingClientRect();
      viewportRef.current?.setGameAspect(r !== undefined && r.width > 0 && r.height > 0 ? r.width / r.height : window.innerWidth / Math.max(1, window.innerHeight));
    };
    update();
    window.addEventListener('resize', update);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.removeEventListener('resize', update);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    clientRef.current?.setSelection(selection.ids);
  }, [selection]);
  const sameWindowTurn = useSelectionAcrossWindow(windowOpen, selection, setSelection, (id) => clientRef.current?.projection.getEntity(id) !== undefined);
  const selectLater = useCallback(() => sameWindowTurn(setSelectedId), [sameWindowTurn, setSelectedId]);
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
  const sceneEditing = useSceneEditing({ clientRef, viewportRef, modelFilesRef, selectedIdRef, selectionRef, setSelectedId, selectLater, setSelectedCopy, setNotice, reportFailure, registry, refreshEntities });
  const { editCopiesRef, rename, move, sceneAction } = sceneEditing;
  useEditorShortcuts({ viewportRef, gestureRef, shiftRef, workspaceRef, blockHandlersRef, selectedIdRef, setSelectedId, setGizmoMode, scene: sceneEditing });

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
  const [viewFailures, setViewFailures] = useState<{ id: string; name: string; code: string; message: string }[]>([]);

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
      isGraphMaterial: (id) => materials.find((m) => m.materialId === id)?.graph !== undefined,
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
  const activeScene = sceneHeaders?.find((h) => h.active) ?? null;
  const bake = useLightingBake(clientRef, viewportRef, activeScene, refreshEntities, toolWindows.isOpen('lighting'), sceneRenderer?.api ?? null);

  const scripting = useScripting({ clientRef, behaviorViews, scriptLibraries: content.scriptLibraries, refreshEntities, workspace, workspaceDispatch, openDocument, playInfo });

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
  const { modelNodesOf } = animatorTools;
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

  // What every render derived from all entities is memoised on
  // the entity list (the same array until an entity changes), so a selection,
  // a panel toggle or a gesture frame does not walk 16k entities.
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
  const hierarchyFlagsMemo = useMemo(() => effectiveFlagsOf(entities), [structureKey, entities.length]);
  const tagUsageMemo = useMemo(() => {
    const usage = new Map<number, number>();
    for (const e of entities) {
      if (e.tags === 0) continue;
      for (let bit = 0; bit < 32; bit++) if ((e.tags & (1 << bit)) !== 0) usage.set(bit, (usage.get(bit) ?? 0) + 1);
    }
    return usage;
  }, [entities]);
  /** How many colliders list each collision layer ("default": those listing none). */
  const layerUsageMemo = useMemo(() => {
    const usage = new Map<string, number>();
    for (const e of entities) {
      if (e.collider === undefined) continue;
      const layers = (e.collider as { layers?: unknown }).layers;
      for (const name of Array.isArray(layers) ? (layers as string[]) : ['default']) usage.set(name, (usage.get(name) ?? 0) + 1);
    }
    return usage;
  }, [entities]);
  const allEntitiesMemo = clientRef.current?.projection.listEntities() ?? entities;
  const projectScenes = clientRef.current?.projection.scenes;
  const fieldContextBase = useMemo(
    () => ({
      // The first asset or index item of some kinds (a starting choice), when it is known.
      firstOf: (kinds: readonly string[]) => firstOfKinds(clientRef.current, kinds),
      entities: allEntitiesMemo.map((e) => {
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
      signals: registry === null ? [] : collectSignals(registry, allEntitiesMemo.map((e) => e.components)),
      // An animator's starting values are edited from its controller's parameters.
      animatorParameters: Object.fromEntries(animators.map((a) => [a.controllerId, a.parameters])),
      // The "+ Add component" presets follow the project's physics dimension.
      physicsDimension: settings?.['physics_dimension'] === 3 ? (3 as const) : (2 as const),
      // The light layer masks' checkboxes carry the project's layer names.
      lightLayerNames: lightLayers,
      // A socket's node list comes from its target's model.
      modelNodes: (entityId: string) => {
        const e = allEntitiesMemo.find((x) => x.id === entityId);
        const assetId = (e?.components as { model?: { asset?: { assetId?: unknown } } } | undefined)?.model?.asset?.assetId;
        return typeof assetId === 'string' ? modelNodesOf(assetId) : undefined;
      },
    }),
    [allEntitiesMemo, projectScenes, materials, animators, behaviorViews, prefabSummaries, effects, registry, settings, modelNodesOf, behaviorGroups, modes, lightLayers],
  );
  /** How many objects carry each behavior group. */
  const groupUsageMemo = useMemo(() => {
    const usage = new Map<string, number>();
    for (const e of allEntitiesMemo) {
      const g = (e.components as { behaviorGroup?: { group?: unknown } }).behaviorGroup?.group;
      if (typeof g === 'string') usage.set(g, (usage.get(g) ?? 0) + 1);
    }
    return usage;
  }, [allEntitiesMemo]);
  const selectedSceneId = selectedEntity?.sceneId;
  const fieldContextMemo: FieldContext = useMemo(
    () => ({ ...fieldContextBase, ...(selectedSceneId !== undefined ? { sceneId: selectedSceneId } : {}) }),
    [fieldContextBase, selectedSceneId],
  );

  // A hook, so before the early returns below: the UI preview reads the textures and fonts the UI names through the editor's authenticated asset path.
  const uiPreviewAssets = useUiPreviewAssets(clientRef, uiDocuments, uiThemes, catalogTick);

  if (gate?.kind === 'token' || (gate?.kind === 'projects' && !cfg.current.ok && cfg.current.needs === 'token')) {
    return <TokenForm message={gate.message} />;
  }
  if (gate?.kind === 'projects') {
    const token = cfg.current.ok ? cfg.current.config.authoringToken : cfg.current.needs === 'project' ? cfg.current.token : '';
    return <ProjectsScreen token={token} message={gate.message} />;
  }

  if (!cfg.current.ok) {
    return (
      <div className="tl-config-error">
        <h1>Thirdlight editor</h1>
        <p>Could not start:</p>
        <pre>{cfg.current.needs === 'page' ? cfg.current.message : 'no project selected'}</pre>
      </div>
    );
  }

  const selected = selectedEntity;
  const hierarchyFlags = hierarchyFlagsMemo;
  const tagUsage = tagUsageMemo;
  /** The components the selection carries (the Component menu's add/remove state). */
  const selectedComponents = new Set<string>(selected === null ? [] : Object.keys(selected.components));
  const fieldContext: FieldContext = fieldContextMemo;
  // The game block's pickers name objects in any scene.
  const { sceneId: _selectedScene, ...gameFieldContext } = fieldContext;
  const workspaceHost = workspaceHostOf({
    clientRef,
    modelFilesRef,
    loadTextureRef,
    projectId: cfg.current.config.projectId,
    content,
    settings: projectSettings,
    docState,
    docCmds,
    scripting,
    animator: animatorTools,
    debugPlay: playSession.debugPlay,
    entities,
    selectedId,
    gameFieldContext,
    uiPreviewAssets,
    openDocument,
    workspaceDispatch,
    sceneView,
    items,
  });

  const menus = editorMenus({
    registry,
    settings,
    sceneHeaders,
    closedScenes,
    entities,
    selected,
    selectedId,
    selectedComponents,
    ui,
    snapping,
    setSnapping,
    snapSettings,
    gizmos,
    setGizmos,
    effectPreview,
    setEffectPreview,
    workspace,
    workspaceDispatch,
    setCenterTab,
    // A tool window shows in the default view, so the settings window closes for it.
    setBottomTab: (tab: BottomTab) => {
      closeSettings();
      setBottomTab(tab);
    },
    showProject: (text: string) => {
      closeSettings();
      workspaceDispatch({ type: 'show', on: false });
      setBottomTab('assets');
      setProjectSearch((cur) => ({ text, n: (cur?.n ?? 0) + 1 }));
    },
    openProjectSettings: () => settingsWindow.show(),
    showToolWindow,
    createPrefabFromSelection: () => void prefab.createPrefabFromSelection(),
    createBlockLayer: () => void blocks.createBlockLayer(),
    createTerrain: () => void terrainTools.createTerrain(),
    resync,
    scene: sceneEditing,
    entity: entityEditing,
    dialogs,
  });

  /** The one Inspector, on the right dock or on the editor window's right side. */
  const inspector = (placement: 'dock' | 'window'): JSX.Element => (
    <InspectorDock
      placement={placement}
      width={placement === 'dock' ? sizes.right : sizes.window}
      clientRef={clientRef}
      viewportRef={viewportRef}
      content={content}
      settings={projectSettings}
      docState={docState}
      docCmds={docCmds}
      animator={animatorTools}
      entity={entityEditing}
      scene={sceneEditing}
      blocks={blocks}
      terrain={terrainTools}
      play={playSession}
      entities={entities}
      selected={selected}
      selection={selection}
      hierarchyFlags={hierarchyFlags}
      fieldContext={fieldContext}
      gizmoMode={gizmoMode}
      setGizmoMode={setGizmoMode}
      instanceChunks={instanceChunks}
      selectedCopy={selectedCopy}
      setSelectedCopy={setSelectedCopy}
      instanceBrush={instanceBrush}
      reportFailure={reportFailure}
      setNotice={setNotice}
      inspectedItem={inspectedItem}
      inspect={inspect}
      openDocument={openDocument}
      items={items}
      cue={cue}
      assets={assets}
      assetActions={assetActions}
      prefab={prefab}
      tileThumbnails={tileThumbnails}
      select={setSelectedId}
      sceneInFront={centerTab === 'scene'}
    />
  );

  return (
    <CatalogProvider catalog={sessionClient?.catalog ?? null} asset={assetSummary}>
    <ItemOpenerProvider opener={assets.itemOpener}>
    <div className="tl-app">
      <MenuBar menus={menus} />
      <Toolbar
        projectId={cfg.current.config.projectId}
        onProjects={() => { window.location.search = ''; }}
        gizmoMode={gizmoMode}
        onGizmoMode={setGizmoMode}
        playing={playing}
        snapping={snapping}
        onToggleSnapping={() => setSnapping((v) => !v)}
        lighting={lightingMode}
        onToggleLighting={() => {
          const next = lightingMode === 'game' ? 'editor' : 'game';
          viewportRef.current?.setLighting(next);
          setLightingMode(next);
        }}
        onPlay={() => void play()}
        onPlayFrom={() => {
          dialogs.setPlayFromForm((f) => ({ ...f, busy: false, error: null }));
          dialogs.setDialog('playFrom');
        }}
        onStop={() => void stop()}
        {...(playMode !== null ? { playMode } : {})}
      />
      <div className="tl-app__workarea" ref={workareaRef}>
      {/* Under the editor window the default view keeps its state but takes no input. */}
      <div className={`tl-app__body${workspace.maximized ? ' is-maximized' : ''}`} inert={windowOpen || settingsWindow.open}>
        <div className="tl-app__main">
          <div className="tl-app__row">
            <div className="tl-dock tl-dock--left" style={{ width: sizes.left }}>
            <Hierarchy
          entities={entities}
          structureKey={structureKey}
          flags={hierarchyFlags}
          projectId={cfg.current.config.projectId}
          selectedIds={selection.ids}
          primaryId={selection.primary}
          onSelect={(ids, primary) => setSelection({ ids, primary })}
          onRename={(id, name) => void rename(id, name)}
          onMove={(ids, parentId, beforeId, sceneId) => void move(ids, parentId, beforeId, sceneId)}
          icons={iconTable}
          onAssetDrop={(asset, parentId, sceneId) => {
            if (sceneId !== null) clientRef.current?.setActiveScene(sceneId);
            const focus = viewportRef.current?.focusPoint() ?? [0, 0, 0];
            void dropAsset(asset, [Math.round(focus[0] * 4) / 4, Math.round(focus[1] * 4) / 4, Math.round(focus[2] * 4) / 4], parentId);
          }}
          {...(sceneHeaders !== null ? { scenes: sceneHeaders, closedScenes, onSceneAction: (a: SceneAction) => void sceneAction(a) } : {})}
          contextMenu={() => hierarchyContextMenu(sceneEditing, () => void prefab.createPrefabFromSelection())}
        />
            </div>
            <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('left')} role="separator" aria-orientation="vertical" aria-label="Resize the hierarchy" />
            <div className="tl-app__center">
              <CentreTabs state={workspace} dispatch={workspaceDispatch} />
        <div
          className={assetDropActive ? 'tl-app__stage is-asset-drop' : 'tl-app__stage'}
          ref={stageRef}
          onDragOver={(ev) => {
            if (centerTab === 'scene' && ev.dataTransfer.types.includes(MATERIAL_DRAG_TYPE)) {
              ev.preventDefault();
              ev.dataTransfer.dropEffect = 'copy';
              return;
            }
            if (centerTab !== 'scene' || !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
            if (!assetDropActive) setAssetDropActive(true);
          }}
          onDragLeave={(ev) => {
            if (ev.currentTarget === ev.target || !ev.currentTarget.contains(ev.relatedTarget as Node | null)) setAssetDropActive(false);
          }}
          onDrop={(ev) => {
            setAssetDropActive(false);
            if (centerTab === 'scene' && ev.dataTransfer.types.includes(MATERIAL_DRAG_TYPE)) {
              // A material dropped on an object: it uses it for all of its materials.
              ev.preventDefault();
              const materialId = ev.dataTransfer.getData(MATERIAL_DRAG_TYPE);
              const id = viewportRef.current?.pickAt(ev.clientX, ev.clientY) ?? null;
              const target = id !== null ? clientRef.current?.projection.getEntity(id) : undefined;
              if (target !== undefined && (target.kind === 'model' || target.kind === 'box' || target.instances !== undefined)) {
                void entityEditing.setEntityMaterials(target.id, { ...(target.materials ?? {}), '*': materialId });
                setSelectedId(target.id);
              } else setNotice('Drop a material on a model or a box.');
              return;
            }
            if (centerTab !== 'scene' || !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
            ev.preventDefault();
            const payload = parseAssetDrag(ev.dataTransfer.getData(ASSET_DRAG_TYPE));
            const at = viewportRef.current?.dropPoint(ev.clientX, ev.clientY);
            if (payload !== null && at !== undefined) void dropAsset(payload, at, null);
          }}
        >
          <div ref={viewportHostRef} className="tl-viewport-host" />
          {centerTab === 'game' && !playing && (
            <div className="tl-app__game-empty">Press ▶ play to run the game here.</div>
          )}
          {ui.external !== null && (
            <div className="tl-notice tl-notice--external" role="alert">
              <span>
                The project files changed on disk. Editing is paused.
                {ui.external.valid === false ? ` The disk version is invalid (${ui.external.errorCount ?? '?'} problems) and cannot be loaded.` : ''}
              </span>
              <button
                className="tl-btn tl-btn--small"
                disabled={ui.external.valid === false}
                onClick={() => void clientRef.current?.resolveExternal('accept').then((r) => { if (!r.ok) setNotice(`Load failed: ${r.error.message}`); })}
              >
                load disk version
              </button>
              <button
                className="tl-btn tl-btn--small"
                onClick={() => void clientRef.current?.resolveExternal('discard').then((r) => { if (!r.ok) setNotice(`Discard failed: ${r.error.message}`); })}
              >
                keep editor version
              </button>
            </div>
          )}
          {notice !== null && (
            <div className="tl-notice" role="alert">
              <span>{notice}</span>
              <button className="tl-btn tl-btn--small" onClick={() => setNotice(null)}>
                dismiss
              </button>
            </div>
          )}
          {playing && previewSrc && (
            <div className={`tl-app__preview${centerTab === 'game' ? '' : ' tl-app__preview--hidden'}`}>
              <div className="tl-app__preview-label">
                <span>
                  play {playInfo?.snapshotId ?? ''} @ r{playInfo?.revision ?? 0}
                </span>
                {playRenderer !== null && (
                  <span className="tl-app__preview-renderer" data-render-backend={String(playRenderer['backend'] ?? 'pending')} title={String(playRenderer['reason'] ?? '')}>
                    renderer {String(playRenderer['backend'] ?? 'pending')} ({String(playRenderer['state'] ?? '')}) — {String(playRenderer['reason'] ?? '')}
                  </span>
                )}
              </div>
              <iframe
                ref={playIframeRef}
                className="tl-app__preview-frame"
                src={previewSrc}
                title="Thirdlight play preview"
                allow="gamepad; cross-origin-isolated"
              />
            </div>
          )}
        </div>
            </div>
          </div>
          <div className="tl-splitter tl-splitter--h" onPointerDown={splitter('bottom')} role="separator" aria-orientation="horizontal" aria-label="Resize the bottom panel" />
          <BottomDock
            tab={bottomTab}
            onTab={setBottomTab}
            height={sizes.bottom}
            clientRef={clientRef}
            docState={docState}
            docCmds={docCmds}
            scripting={scripting}
            play={playSession}
            problems={problems}
            problemLog={ui.problems}
            viewFailures={viewFailures}
            fileCheck={fileCheck}
            reimportIssue={assets.reimportIssue}
            assetsTab={{
              clientRef,
              assets,
              actions: assetActions,
              folderImport: fileCheck.checkable,
              tileThumbnails,
              inspect,
              items,
              search: projectSearch,
            }}
            workspaceDispatch={workspaceDispatch}
            openDocument={openDocument}
          />
        </div>
        <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('right')} role="separator" aria-orientation="vertical" aria-label="Resize the inspector" />
        {windowOpen ? <div className="tl-dock" style={{ width: sizes.right }} /> : inspector('dock')}
      </div>
      {/* Scene settings float over the Scene view while it is in front (the editor window, Project Settings and the Game view set them aside). */}
      {centerTab === 'scene' && !windowOpen && !settingsWindow.open && (
        <SceneToolWindows
          tools={toolWindows}
          area={workareaRef}
          clientRef={clientRef}
          viewportRef={viewportRef}
          content={content}
          docCmds={docCmds}
          bake={bake}
          entities={entities}
          sceneHeaders={sceneHeaders}
          activateScene={(sceneId) => void sceneAction({ kind: 'activate', sceneId })}
        />
      )}
      {/* The settings window covers the editor window too; what is under it takes no input. */}
      <div className="tl-app__layer" inert={settingsWindow.open}>
        <EditorWindow state={workspace} dispatch={workspaceDispatch} host={workspaceHost} inspector={windowOpen ? inspector('window') : null} onSplitter={splitter('window')} />
      </div>
      <ProjectSettingsWindow
        state={settingsWindow}
        settings={projectSettings}
        content={content}
        docCmds={docCmds}
        scripting={scripting}
        play={playSession}
        entities={entities}
        setSelection={setSelection}
        fieldContext={fieldContextMemo}
        gameFieldContext={gameFieldContext}
        tagUsage={tagUsage}
        layerUsage={layerUsageMemo}
        groupUsage={groupUsageMemo}
      />
      </div>
      <StatusBar state={ui} onResync={resync} renderer={sceneRenderer} />
      {filePicker !== null && (
        <ProjectFilePicker
          title={filePicker === 'create' ? 'Import from project folder' : 'Reimport from project folder'}
          startDir="assets"
          load={assets.loadProjectFiles}
          onClose={() => setFilePicker(null)}
          onPick={(entry) => {
            const mode = filePicker;
            setFilePicker(null);
            void assets.importFromFolder(entry.path, mode, mode === 'reimport' ? assets.selectedAssetIdRef.current : null);
          }}
        />
      )}
      <EditorDialogs
        dialogs={dialogs}
        cfg={cfg}
        revision={ui.revision}
        sceneHeaders={sceneHeaders}
        closedScenes={closedScenes}
        saveSchema={saveSchema}
        modes={modes}
        playing={playing}
        setSnapSettingsState={setSnapSettingsState}
      />
    </div>
    </ItemOpenerProvider>
    </CatalogProvider>
  );
}

export function mountEditor(): void {
  const el = document.getElementById('tl-root');
  if (!el) throw new Error('editor root element #tl-root not found');
  createRoot(el).render(<EditorApp />);
}