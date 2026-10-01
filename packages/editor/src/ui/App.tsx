/**
 * Editor app root (React). Wires the session client
 * (backend transport), the imperative three.js viewport (framework-free), the
 * React panels, and the isolated play preview (separate-origin iframe + the
 * checked message bridge). React renders the panels + the canvas element; it
 * never instantiates or mutates Object3Ds (the viewport owns those).
 *
 * It also carries the prefab (copy) authoring path and the schema-driven
 * declared-property inspector. Every authoring decision is delegated to the
 * pure `session/*` modules; React renders controls and issues ordinary typed
 * commands through the same single client path.
 *
 * Browser-only.
 */
import * as THREE from 'three';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { forgetToken, readEditorConfig } from '../config';
import { ProjectsScreen, TokenForm } from './Projects';
import { resetLayout, useDockSizes } from './layout';
import { MenuBar, type Menu, type MenuEntry, type MenuItem } from './MenuBar';
import { Dialog } from './Dialog';
import { SessionClient, makeAssetId, type ClientUiState, type PlayStartResult } from '../session/client';
import { mergeDocumentEdit, mergeListEdit } from '../session/own-commands';
import type { MutationResponse } from '../session/envelope';
import { Projection, type ProjectedEntity } from '../session/projection';
import { draggedRoots, effectiveFlagsOf, subtreeOrder } from '../session/hierarchy';
import { scatterProblem, scatterTransforms } from '../session/instances';
import { TagsPanel } from './TagsPanel';
import { CollisionLayersPanel } from './CollisionLayersPanel';
import { ModesPanel } from './ModesPanel';
import { ShellPanel } from './ShellPanel';
import { SavesPanel } from './SavesPanel';
import {
  importFailed,
  initialImportState,
  publishArgsFromProposal,
  utcSecondTimestamp,
  type AssetImportState,
  type ImportTarget,
} from '../session/asset-browser';
import { ASSET_DRAG_TYPE, assetPlacementAvailable, parseAssetDrag, planAssetPlacement, planModelDrop, type AssetDragPayload, type PieceFacts } from '../session/placement';
import {
  collectOverrides,
  newPrefabDraft,
  overrideDraftKey,
  planCreatePrefab,
  planInstantiatePrefab,
  recoverPrefabCommandFailure,
  type CaptureEntityView,
} from '../session/prefab-authoring';
import {
  deriveOverrideTargets,
  derivePropertyControls,
  parseControlInput,
  planSetBehaviorProperties,
} from '../session/property-controls';
import { addEntries, collectSignals, createEntries, presetValue, withOtherScene } from '../session/descriptor-fields';
import type { FieldContext } from './DescriptorFields';
import type { PrefabSummaryView } from '../session/prefab-projection';
import type { BehaviorDeclarationView } from '../session/prefab-projection';
import {
  initialPublicationState,
  publicationFailed,
  published,
  sourceStaged,
  trustObserved,
  type BehaviorPublicationState,
} from '../session/behavior-publication';
import { Gesture, type Transform } from '../session/gesture';
import { fitCapsule } from '../session/size-handles';
import { maxPolygonCorners } from '../session/handles';
import { boxFromBounds3D, boxFromOutline, polygonFromOutline } from '../session/outline';
import { withAddedCopies, withCopy, withoutCopy, type CopyTransform } from '../session/instance-copies';
import { Viewport } from '../viewport/viewport';
import { iconTableOf } from '../viewport/icons';
import { ModelInstances } from '../viewport/model-instances';
import { createSceneViewAssets } from '../viewport/scene-assets';
import { extractedImagePictures, TileThumbnails } from '../viewport/thumbnails';
import { AnimatorMachine, type AnimatorControllerLike } from '@thirdlight/runtime';
import { BATCHING_URL_PARAM, batchingFromUrl, createAnimatorPlayer, setKtx2DecoderBase, layerEnvironment, pageSearch, rendererPreferenceFromUrl, RENDERER_URL_PARAM, resolveRendererPreference, type EnvironmentLike, type LightingBakeLike, type MaterialDefLike, type MaterialFunctionLike, type MaterialLibrary, type RendererInfo, type WindLike } from '@thirdlight/three-adapter';
import { editorRendererChoice, setEditorRendererChoice } from '../viewport/renderer-choice';
import type { TimelineAsset } from '@thirdlight/project-model';
import type { AnimatorController, DescriptorRegistry, EffectComponent, EffectDef, EnvironmentConfig, InputConfig, LightingBake, MaterialDef, ScriptLibrary, UiDocument, UiTheme, GameMode, EventCue, GameShell } from '@thirdlight/project-model';
import { PreviewStage } from '../viewport/preview-stage';
import { Bridge } from '../preview/bridge';
import { Hierarchy, type SceneAction, type SceneHeaderView } from './Hierarchy';
import { Inspector, type EntityFlag } from './Inspector';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { AssetBrowser } from './AssetBrowser';
import { useAssetPreview } from './assets/useAssetPreview';
import { useProjectWindow } from './project/useProjectWindow';
import { CatalogProvider, stringsIn } from './catalog/catalog-context';
import { indexKindsOfAssetField, MODEL_KINDS, RefPicker } from './catalog/RefPicker';
import { useSelectedAsset } from './assets/useSelectedAsset';
import { useUiPreviewAssets } from './uidoc/useUiPreviewAssets';
import { conversationsFrom } from '../session/dialogue-closure';
import { MATERIAL_DRAG_TYPE, MaterialMappingEditor, MaterialsPanel } from './MaterialsPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { LightingPanel } from './LightingPanel';
import { AnimatorPanel, type AnimatorPanelProps, type AnimatorPreview } from './AnimatorPanel';
import { AnimatorInspector } from './animator/AnimatorInspector';
import { ModelAssetOptions } from './ModelAssetOptions';
import { useLoadingNames } from './useLoadingNames';
import { InputPanel } from './InputPanel';
import { bakeIsStale, DEFAULT_BAKE_SETTINGS, runBlenderBake, runBrowserBake, type BakeSettings } from '../viewport/bake-run';
import { PrefabPanel } from './PrefabPanel';
import { BehaviorPanel, type BehaviorPanelProps } from './BehaviorPanel';
import { ActiveDocument, WorkspaceTabs, resetWorkspaces, useWorkspace } from './workspace/WorkspaceTabs';
import type { ScriptCheckResult, ScriptDraft, ScriptPublishOutcome } from './script/ScriptDocument';
import { publishScriptSource } from '../session/script-publish';
import type { WorkspaceHost } from './workspace/kinds';
import type { MaterialDocumentProps } from './material/MaterialDocument';
import { activeDoc, docKey } from '../session/workspace-tabs';
import type { DeclarationSave } from './DeclarationEditor';
import { PlayDebugView } from './PlayDebugView';
import { GameplayPanel, type GameplayBackendError } from './GameplayPanel';
import { BlocksPanel, type BlockLayerRow, type BlockPanelHandlers } from './BlocksPanel';
import type { BlockEditor } from '../viewport/block-editor';
import { BlockGrid } from '@thirdlight/runtime';
import type { BlockEdit, BlockFootprintComponent, BlockStamp, BlockType, CellField } from '@thirdlight/project-model';
import { footprintCells, footprintEdits, snapToCellTop, yawQuarterTurns, type PropLayer } from '../session/block-footprint';
import { DEFAULT_SNAP_SETTINGS, loadSnapSettings, saveSnapSettings, snapSettingError, type SnapSettings } from '../session/snapping';
import { MediaPanel } from './MediaPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { GraphInspector } from '../graph/GraphInspector';
import { EffectsPanel } from './effect/EffectsPanel';
import { DialoguePanel, freeDialogueId } from './dialogue/DialoguePanel';
import type { DialogueDocument as DialogueDoc, DialogueSettings, DialogueSpeaker, UiDocument as ProjectUiDocument, UiTheme as ProjectUiTheme } from '@thirdlight/project-model';
import { TimelinesPanel } from './timeline/TimelinesPanel';
import { newTimeline, type TimelinePreviewValue } from './timeline/TimelineDocument';
import { LibrariesPanel } from './script/LibrariesPanel';
import { ConsolePanel } from './ConsolePanel';
import type { SourceFocus, SourceLocation } from '../session/source-location';
import { UiPanel } from './uidoc/UiPanel';
import { newUiDocument, newUiTheme, uniqueDocId } from '../session/ui-edit';
import { savedDraft, type LibraryDraft, type LibrarySaveOutcome } from './script/LibraryDocument';
import { fitsOneRequest, libraryFilePatch, libraryStagePatches, newLibraryFiles, type LibraryStagePatch } from '../session/script-sources';
import { effectPortContext, shownSystem, type EffectDocumentProps } from './effect/EffectDocument';
import { newEffect, uniqueId } from '../session/effect-edit';
import type { VisualScriptCheckResult, VisualScriptProblem } from './script/VisualScriptDocument';
import type { DebugRequest, DebugResult } from '../preview/play-debug';
import { functionName as scriptFunctionName, splitScoped } from '../session/visual-debug';
import { behaviorPortContext, newBehaviorGraph } from '../session/behavior-graph';
import { GraphsPanel } from '../graph/GraphsPanel';
import { type GraphKindDef, type GraphOp } from '../graph/model';
import { editorWorkers } from '../workers/editor-workers';
import { graphIssuesOf, materialIssuesOf, type GraphIssue, type MaterialIssue } from '../workers/problems';
import { useWorkerJob } from '../workers/use-worker-job';
import { graphsPortContext, materialPortContext } from '../session/material-graph';
import type { GraphDocument, SaveSchema } from '@thirdlight/project-model';
import { ProjectFilePicker } from './ProjectFilePicker';
import { type SourceIssue } from '../session/asset-sources';
import { useAssetFileCheck } from './useAssetFileCheck';
import { waitFor } from './wait-for';
import { useAssetOptions } from './useAssetOptions';
import { useAssetImport } from './useAssetImport';
import { AssetFolders } from './AssetFolders';
import { createPreviewAudioOwner, type PreviewAudioOwner } from '../session/preview-audio';
import { SURFACE_PRESET_NAMES, validateMediaDrop, type AnimationRoleKey, type SurfacePresetName } from '../session/media';
import type { GizmoMode } from '../viewport/viewport';
import type { PropertyDeclaration } from '@thirdlight/project-model';

/** A bounded, actionable error the panels display. */
interface UiError {
  code: string;
  message: string;
}

/** The bounded backend error for a failed command (the panels explain it, never lose it). */

// KTX2 textures (and GLBs with KHR_texture_basisu) transcode with three's Basis files next to the editor page.
setKtx2DecoderBase('./decoders/');

function commandError(res: { response: MutationResponse }): GameplayBackendError {
  const r = res.response;
  if (r.ok) return { code: 'unexpected_response', message: 'unexpected response shape' };
  return { code: r.code, message: r.message ?? r.code };
}

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

interface PlayInfo {
  playSessionId: string;
  playBase: string | null;
  snapshot: unknown | null;
  snapshotId: string;
  revision: number;
  /** The immutable locator capability + build identity. */
  contentId: string | null;
  buildId: string | null;
  contentPath: string | null;
}

/** The first asset or index item of some kinds the catalog has read (a starting choice), if any. */
function firstOfKinds(c: SessionClient | null, kinds: readonly string[]): string | undefined {
  return c?.catalog.firstOf(kinds);
}

/** The Problems tab's graph diagnostics before the first worker result. */
const NO_GRAPH_ISSUES: readonly GraphIssue[] = [];
const NO_MATERIAL_ISSUES: readonly MaterialIssue[] = [];

/** The pickers' option per projected entity object (see fieldContextBase). */
const entityOptionCache = new WeakMap<ProjectedEntity, { id: string; name: string; sceneId?: string; components: string[] }>();

function EditorApp(): JSX.Element {
  const cfg = useRef(readEditorConfig());
  /** The Scene view's canvas is in this host (the Viewport replaces it on a renderer backend change). */
  const viewportHostRef = useRef<HTMLDivElement | null>(null);
  /** The page's ?renderer= flag (it overrides the project setting everywhere, Play included). */
  const urlRenderer = useRef(rendererPreferenceFromUrl(pageSearch()));
  /** The page's ?threads= flag (where Play runs its simulation), passed on to the play page. */
  const urlThreads = useRef(/[?&]threads=([A-Za-z0-9]{1,16})(?:[&#]|$)/.exec(pageSearch())?.[1] ?? null);
  /** The Scene view's renderer (backend, state, reason) and the play's, from its observation. */
  const [sceneRenderer, setSceneRenderer] = useState<RendererInfo | null>(null);
  const [playRenderer, setPlayRenderer] = useState<Record<string, unknown> | null>(null);
  const clientRef = useRef<SessionClient | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const playIframeRef = useRef<HTMLIFrameElement | null>(null);

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
  /**
   * The centre workspace — Scene, Game and the open document tabs
   * (remembered per project in the layout storage).
   */
  const [workspace, workspaceDispatch] = useWorkspace(cfg.current.ok ? cfg.current.config.projectId : null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  /** The centre view: the editor scene, the running game or a document. */
  const centerTab: 'scene' | 'game' | 'document' = workspace.active === 'scene' || workspace.active === 'game' ? workspace.active : 'document';
  const setCenterTab = useCallback((key: 'scene' | 'game') => workspaceDispatch({ type: 'activate', key }), [workspaceDispatch]);
  // Standalone graphs; each opens as a `graph` document tab.
  const [graphs, setGraphs] = useState<readonly GraphDocument[]>([]);
  const [graphKinds, setGraphKinds] = useState<Readonly<Record<string, GraphKindDef>>>({});
  /** False until the first projection is applied (remembered graph tabs must not close before). */
  const [graphsLoaded, setGraphsLoaded] = useState(false);
  const [graphSelection, setGraphSelection] = useState<readonly string[]>([]);
  const [graphFocus, setGraphFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [graphsError, setGraphsError] = useState<string | null>(null);
  const graphQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  /** The graph of the active centre tab (its inspector shows in the right dock). */
  const activeGraphId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'graph' ? d.id : null;
  })();
  const openGraph = activeGraphId !== null ? (graphs.find((g) => g.graphId === activeGraphId) ?? null) : null;
  // A different graph in front starts with an empty selection.
  useEffect(() => setGraphSelection([]), [activeGraphId]);
  // The visual script in front (a behavior with a graph), its selection and a focus request.
  // The selection with the graph it belongs to (owner id): a tab switch shows no stale selection.
  const [visualSelectionOf, setVisualSelectionOf] = useState<{ owner: string; ids: readonly string[] }>({ owner: '', ids: [] });
  // A focus request names its script (a Problems click may open another script's tab first).
  const [visualFocus, setVisualFocus] = useState<{ behaviorId?: string; id: string; nonce: number } | null>(null);
  const activeVisualId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'visual-script' ? d.id : null;
  })();
  // Per script — the graph in front ("" = event graph, else a function id), the latest
  // compile problems (the Problems tab), breakpoints (scoped node ids) and watched variables.
  const [visualTargets, setVisualTargets] = useState<Readonly<Record<string, string>>>({});
  const [visualProblems, setVisualProblems] = useState<Readonly<Record<string, readonly VisualScriptProblem[]>>>({});
  const [visualBreakpoints, setVisualBreakpoints] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [visualWatches, setVisualWatches] = useState<Readonly<Record<string, readonly string[]>>>({});
  const activeVisualTarget = activeVisualId !== null ? (visualTargets[activeVisualId] ?? '') : '';
  const onVisualTarget = useCallback((behaviorId: string, target: string) => setVisualTargets((m) => (m[behaviorId] === target ? m : { ...m, [behaviorId]: target })), []);
  const onVisualProblems = useCallback((behaviorId: string, problems: readonly VisualScriptProblem[]) => setVisualProblems((m) => ({ ...m, [behaviorId]: problems })), []);
  const activeVisualOwner = activeVisualId === null ? '' : activeVisualTarget === '' ? activeVisualId : `${activeVisualId}#${activeVisualTarget}`;
  const visualSelection = visualSelectionOf.owner === activeVisualOwner ? visualSelectionOf.ids : [];
  // The Animator tabs — which graph of each controller is shown
  // (an animator owner id: base layer, `@n` layer, `#state` blend tree), the
  // selection of the one in front (the Inspector shows it) and a focus request.
  const [animatorTargets, setAnimatorTargets] = useState<Readonly<Record<string, string>>>({});
  const [animatorSelection, setAnimatorSelection] = useState<{ ownerId: string; ids: readonly string[] }>({ ownerId: '', ids: [] });
  const [animatorFocus, setAnimatorFocus] = useState<{ id: string; nonce: number } | null>(null);
  const activeAnimatorId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'animator' ? d.id : null;
  })();
  useEffect(() => {
    setAnimatorSelection({ ownerId: '', ids: [] });
    setAnimatorFocus(null);
  }, [activeAnimatorId]);
  // Sub-graph calls (material functions) read their ports from the project's graphs.
  const graphsContext = useMemo(() => graphsPortContext(graphs, graphKinds), [graphs, graphKinds]);
  // The graph material of the active centre tab (its node inspector shows in the right dock).
  const [materialSelection, setMaterialSelection] = useState<readonly string[]>([]);
  const [materialFocus, setMaterialFocus] = useState<{ id: string; nonce: number; materialId?: string } | null>(null);
  const activeMaterialId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'material' ? d.id : null;
  })();
  useEffect(() => {
    setMaterialSelection([]);
    // A focus request for the tab being opened (a Problems click) survives the switch.
    setMaterialFocus((f) => (f !== null && f.materialId === activeMaterialId ? f : null));
  }, [activeMaterialId]);
  // The effect of the active centre tab (the selected node of its shown system shows in the right dock).
  const [effectSelection, setEffectSelection] = useState<readonly string[]>([]);
  const [effectFocus, setEffectFocus] = useState<{ id: string; nonce: number } | null>(null);
  const activeEffectId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'effect' ? d.id : null;
  })();
  useEffect(() => {
    setEffectSelection([]);
    setEffectFocus(null);
  }, [activeEffectId]);
  // The conversation of the active centre tab (its selected node shows in the right dock).
  const [dialogueSelection, setDialogueSelection] = useState<readonly string[]>([]);
  const [dialogueFocus, setDialogueFocus] = useState<{ id: string; nonce: number } | null>(null);
  const activeDialogueId = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'dialogue' ? d.id : null;
  })();
  useEffect(() => {
    setDialogueSelection([]);
    setDialogueFocus(null);
  }, [activeDialogueId]);
  // Every graph's problems (the kind's rules), for the Problems tab.
  // Computed in the editor worker (inline without one).
  const graphIssues = useWorkerJob('graphIssues', () => ({ graphs, kinds: graphKinds }), (i) => graphIssuesOf(i.graphs, i.kinds), NO_GRAPH_ISSUES, [graphs, graphKinds]);
  // A graph that went away (deleted here, by MCP or undone) closes its tab.
  useEffect(() => {
    if (!graphsLoaded) return;
    const ids = new Set(graphs.map((g) => g.graphId));
    for (const d of workspace.docs) if (d.kind === 'graph' && !ids.has(d.id)) workspaceDispatch({ type: 'close', key: docKey(d) });
  }, [graphsLoaded, graphs, workspace.docs, workspaceDispatch]);
  const { sizes, splitter } = useDockSizes();
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** A dismissible message over the viewport (e.g. why Play failed). */
  const [notice, setNotice] = useState<string | null>(null);
  /** The open modal (File → Export…, Help → Shortcuts / About). */
  const [dialog, setDialog] = useState<'export' | 'shortcuts' | 'about' | 'instances' | 'playFrom' | 'snapping' | null>(null);
  /** The "Play from…" form (a scene, script variables as JSON, a save slot). */
  const [playFromForm, setPlayFromForm] = useState({ sceneId: '', variables: '', saveSlot: '', mode: '', busy: false, error: null as string | null });
  /**
   * The scatter dialog's form (an instance set of one model).
   * A 20 × 20 m square (it was a 40 × 8 m side-scroller strip) —
   * no view direction assumed; 200 copies at 0.7–1.3× with a random turn read
   * as a natural scatter of props at any scale.
   */
  const [scatter, setScatter] = useState({ assetId: '', count: '200', width: '20', depth: '20', scaleMin: '0.7', scaleMax: '1.3', randomYaw: true, seed: '1', busy: false, error: null as string | null });
  const [exportState, setExportState] = useState<{ busy: boolean; result: { outputDir: string; revision: number; files: number } | null; error: string | null }>({ busy: false, result: null, error: null });
  const [playing, setPlaying] = useState(false);
  const [playInfo, setPlayInfo] = useState<PlayInfo | null>(null);
  /** Forwards a backend relay request to the running preview (latest play state). */
  const forwardRelayRef = useRef<(req: Record<string, unknown>) => void>(() => undefined);
  useEffect(() => {
    forwardRelayRef.current = (req) => {
      const b = bridgeRef.current;
      const client = clientRef.current;
      if (!client) return;
      const type = String(req.type);
      if (b === null || playInfo === null) {
        const error = { code: 'not_ready', message: 'no play preview is running in the editor' };
        if (type === 'input.request') client.sendRelayAck({ type: 'input.result', requestId: req.requestId, ok: false, error });
        else {
          const ackType = { 'screenshot.request': 'screenshot.ack', 'play.diagnostics.request': 'play.diagnostics.ack', 'game.control.request': 'game.control.ack', 'game.observe.request': 'game.observe.ack' }[type];
          if (ackType !== undefined) client.sendRelayAck({ type: ackType, relayId: req.relayId, ok: false, error });
        }
        return;
      }
      const psid = playInfo.playSessionId;
      if (type === 'screenshot.request') b.requestScreenshot(psid, String(req.relayId), typeof req.maxWidth === 'number' ? req.maxWidth : undefined);
      else if (type === 'play.diagnostics.request') b.requestDiagnostics(psid, String(req.relayId));
      else if (type === 'input.request') b.requestInput(psid, String(req.requestId), req.frames as never, req.restart === true, req.hold === true);
      else if (type === 'game.control.request') b.requestGameControl(psid, String(req.relayId), String(req.command), typeof req.sceneId === 'string' ? req.sceneId : undefined, typeof req.name === 'string' ? { name: req.name, args: (req.args ?? {}) as Record<string, unknown> } : undefined, typeof req.answerWithinMs === 'number' ? req.answerWithinMs : undefined);
      else if (type === 'game.observe.request') b.requestGameObserve(psid, String(req.relayId), typeof req.entityId === 'string' ? req.entityId : undefined);
    };
  }, [playInfo]);

  /**
   * One observation of the running Play with `entityId`'s script
   * property values (the Play debug view) — over the preview bridge, answered
   * by the preview from the running game; null when nothing answers in 2 s.
   */
  const observeEntity = useCallback(
    (entityId: string): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const b = bridgeRef.current;
        if (b === null || playInfo === null) {
          resolve(null);
          return;
        }
        let hex = '';
        for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
        const relayId = `relay-${hex}`;
        debugWaitersRef.current.set(relayId, resolve);
        b.requestGameObserve(playInfo.playSessionId, relayId, entityId);
        window.setTimeout(() => {
          if (debugWaitersRef.current.delete(relayId)) resolve(null);
        }, 2000);
      }),
    [playInfo],
  );

  /**
   * One poll of the visual-script debugger in the running Play —
   * over the preview bridge, answered by the preview from the running game
   * (the editor runs no game code); null when nothing answers in 2 s.
   */
  const debugPlay = useCallback(
    (req: DebugRequest): Promise<DebugResult | null> =>
      new Promise((resolve) => {
        const b = bridgeRef.current;
        if (b === null || playInfo === null) {
          resolve(null);
          return;
        }
        let hex = '';
        for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
        const relayId = `relay-${hex}`;
        debugWaitersRef.current.set(relayId, (r) => resolve(r as unknown as DebugResult | null));
        b.requestDebug(playInfo.playSessionId, relayId, req);
        window.setTimeout(() => {
          if (debugWaitersRef.current.delete(relayId)) resolve(null);
        }, 2000);
      }),
    [playInfo],
  );

  // The play's renderer (backend, state, reason) for the Play label, from its
  // diagnostics (every play has them; the observation needs a game).
  const playDiagnostics = useCallback(
    (): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const b = bridgeRef.current;
        if (b === null || playInfo === null) {
          resolve(null);
          return;
        }
        let hex = '';
        for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
        const relayId = `relay-${hex}`;
        debugWaitersRef.current.set(relayId, resolve);
        b.requestDiagnostics(playInfo.playSessionId, relayId);
        window.setTimeout(() => {
          if (debugWaitersRef.current.delete(relayId)) resolve(null);
        }, 2000);
      }),
    [playInfo],
  );
  useEffect(() => {
    if (!playing || playInfo === null) {
      setPlayRenderer(null);
      return;
    }
    let alive = true;
    const tick = async (): Promise<void> => {
      const d = await playDiagnostics();
      const r = (d?.['renderer'] as { renderer?: unknown } | null | undefined)?.renderer;
      if (alive && typeof r === 'object' && r !== null && !Array.isArray(r)) setPlayRenderer(r as Record<string, unknown>);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [playing, playInfo, playDiagnostics]);
  // ---- Gameplay authoring (game config / camera / settings) ------
  const [gameplayError, setGameplayError] = useState<GameplayBackendError | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  // The chunks each drawn instance set was split into (by entity id).
  const [instanceChunks, setInstanceChunks] = useState<Record<string, number>>({});
  /** The project tag registry and the last setTags error. */
  const [tags, setTags] = useState<{ bit: number; name: string }[]>([]);
  /** The open scenes' headers and the closed scenes (a v4 project with scenes). */
  const [sceneHeaders, setSceneHeaders] = useState<SceneHeaderView[] | null>(null);
  const [closedScenes, setClosedScenes] = useState<{ sceneId: string; name: string }[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  /** The named collision layers and the last setCollisionLayers error. */
  const [collisionLayers, setCollisionLayers] = useState<string[]>([]);
  /** The project save schema and the last setSaveSchema error. */
  const [saveSchema, setSaveSchema] = useState<SaveSchema | null>(null);
  const [saveSchemaError, setSaveSchemaError] = useState<string | null>(null);
  const [layersError, setLayersError] = useState<string | null>(null);
  /** The game modes, the behavior groups and the last setModes / setBehaviorGroups error. */
  const [modes, setModes] = useState<GameMode[]>([]);
  const [behaviorGroups, setBehaviorGroups] = useState<string[]>([]);
  const [modesError, setModesError] = useState<string | null>(null);
  /** The game shell and the last setShell error. */
  const [shell, setShell] = useState<GameShell | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  /** The event → cue table and the last setEventCues error. */
  const [eventCues, setEventCues] = useState<EventCue[]>([]);
  const [eventCuesError, setEventCuesError] = useState<string | null>(null);
  /** The running Play's current game mode (the toolbar shows it; null: none or not playing). */
  const [playMode, setPlayMode] = useState<{ current: string; name: string } | null>(null);
  // The running Play's game mode for the toolbar (from its diagnostics; a project with modes).
  useEffect(() => {
    if (!playing || playInfo === null || modes.length === 0) {
      setPlayMode(null);
      return;
    }
    let alive = true;
    const tick = async (): Promise<void> => {
      const d = await playDiagnostics();
      const m = d?.['mode'] as { current?: unknown; name?: unknown } | undefined;
      if (alive && m !== undefined && typeof m.current === 'string') setPlayMode((p) => (p !== null && p.current === m.current ? p : { current: m.current as string, name: typeof m.name === 'string' ? m.name : '' }));
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [playing, playInfo, playDiagnostics, modes.length]);

  // ---- Content browser + local snapping -------------------------
  /** Goes up when the catalog changed or records read by id arrived (views that read them draw again). */
  const [catalogTick, setCatalogTick] = useState(0);
  /** The asset tiles' pictures (from the import cache). */
  const [tileThumbnails, setTileThumbnails] = useState<TileThumbnails | null>(null);
  /** The session client, for the panels below (the catalog and the summaries it read). */
  const [sessionClient, setSessionClient] = useState<SessionClient | null>(null);
  const assetSummary = useCallback((assetId: string) => clientRef.current?.content.getAsset(assetId), []);
  const materialLibraryRef = useRef<MaterialLibrary | null>(null);
  const materialsKeyRef = useRef('');
  const environmentKeyRef = useRef('');
  const lightingKeyRef = useRef('');
  const loadTextureRef = useRef<((assetId: string) => Promise<THREE.Texture | null>) | null>(null);
  /** The project materials and the environment, for the panels. */
  const [materials, setMaterials] = useState<MaterialDef[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentConfig | null>(null);
  const [lighting, setLighting] = useState<Record<string, LightingBake>>({});
  // The animator controllers.
  const [animators, setAnimators] = useState<AnimatorController[]>([]);
  // The visual effects, the system each Effect tab shows, and the list's last refusal.
  const [effects, setEffects] = useState<readonly EffectDef[]>([]);
  const [effectSystems, setEffectSystems] = useState<Readonly<Record<string, string | null>>>({});
  const [effectError, setEffectError] = useState<string | null>(null);
  // Conversations, speakers, the dialogue settings, the project UI (the previewer draws with it) and the last refusal.
  const [dialogues, setDialogues] = useState<readonly DialogueDoc[]>([]);
  const [speakers, setSpeakers] = useState<readonly DialogueSpeaker[]>([]);
  const [dialogueSettings, setDialogueSettings] = useState<DialogueSettings | null>(null);
  const [projectUiDocs, setProjectUiDocs] = useState<readonly ProjectUiDocument[]>([]);
  const [projectUiThemes, setProjectUiThemes] = useState<readonly ProjectUiTheme[]>([]);
  const [dialogueError, setDialogueError] = useState<string | null>(null);
  // The conversations open in tabs are read by id; one the index no longer has closes its tab (after the first full state).
  useEffect(() => {
    const c = clientRef.current;
    const open = workspace.docs.filter((d) => d.kind === 'dialogue');
    if (!graphsLoaded || c === null || open.length === 0) return;
    let live = true;
    void c.catalog.ensureResources('dialogue', open.map((d) => d.id)).then(() => {
      if (!live) return;
      const held = new Set(c.getDialogues().map((d) => d.dialogueId));
      for (const d of open) if (!held.has(d.id) && c.catalog.resourceAbsent('dialogue', d.id)) workspaceDispatch({ type: 'close', key: docKey(d) });
    });
    return () => {
      live = false;
    };
  }, [graphsLoaded, dialogues, workspace.docs, workspaceDispatch, catalogTick]);
  // The timelines and the list's / tab's last refusal.
  const [timelines, setTimelines] = useState<readonly TimelineAsset[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  // The shared script libraries and the Libraries list's last refusal.
  const [scriptLibraries, setScriptLibraries] = useState<readonly ScriptLibrary[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  // The project UI documents and themes (the UI list and their tabs) and the last refusal.
  const [uiDocuments, setUiDocuments] = useState<readonly UiDocument[]>([]);
  const [uiThemes, setUiThemes] = useState<readonly UiTheme[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);
  // The component and content descriptors the Inspector is built from.
  const [registry, setRegistry] = useState<DescriptorRegistry | null>(null);
  /** The selected copy of the selected instance set, and the copy brush. */
  const [selectedCopy, setSelectedCopy] = useState<number | null>(null);
  const [brushOn, setBrushOn] = useState(false);
  const [animatorError, setAnimatorError] = useState<string | null>(null);
  // The input actions (null = the defaults).
  const [inputConfig, setInputConfig] = useState<InputConfig | null>(null);
  const [inputDefaults, setInputDefaults] = useState<InputConfig>({ actions: [] });
  const [inputError, setInputError] = useState<string | null>(null);
  // The note of the editor's own Play control (clearing the Play save).
  const [playSaveNote, setPlaySaveNote] = useState<string | null>(null);
  // The Scene view's helpers (Gizmos menu).
  const [gizmos, setGizmos] = useState({ icons: true, lights: true, colliders: true, gameplay: true });
  useEffect(() => viewportRef.current?.setGizmos(gizmos), [gizmos]);
  // The Scene view plays the selected object's effect (edit mode; the Gizmos menu toggles it).
  const [effectPreview, setEffectPreview] = useState(false);
  const localRelaysRef = useRef(new Set<string>());
  /** The editor's own observation requests (the Play debug view), by relay id. */
  const debugWaitersRef = useRef(new Map<string, (r: Record<string, unknown> | null) => void>());
  // The Lighting window (bake settings, a running bake, its outcome).
  const [bakeSettings, setBakeSettings] = useState<BakeSettings>(DEFAULT_BAKE_SETTINGS);
  const [bakeBusy, setBakeBusy] = useState<{ text: string; fraction: number } | null>(null);
  const [bakeMessage, setBakeMessage] = useState<string | null>(null);
  const [bakeHost, setBakeHost] = useState<string | null>('checking the bake host…');
  const bakeAbortRef = useRef<AbortController | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialError, setMaterialError] = useState<string | null>(null);
  /** The material names of the selected object's model file (for the mapping editor). */
  const [selectedSourceMaterials, setSelectedSourceMaterials] = useState<string[]>([]);
  const [assetDropActive, setAssetDropActive] = useState(false);
  const [lightingMode, setLightingMode] = useState<'editor' | 'game'>('editor');
  const [importState, setImportState] = useState<AssetImportState>(initialImportState);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [snapping, setSnapping] = useState(true);
  // The snapping steps and cell-top snapping (editor settings per project, in this browser).
  const [snapSettings, setSnapSettingsState] = useState<SnapSettings>({ ...DEFAULT_SNAP_SETTINGS });
  const [snapDraft, setSnapDraft] = useState<{ translateM: string; rotateDeg: string; scale: string; cellTops: boolean } | null>(null);
  // Block-layer editing (the Blocks panel and the Scene view's block tools).
  const [blockEditor, setBlockEditor] = useState<BlockEditor | null>(null);
  const [blockRows, setBlockRows] = useState<readonly BlockLayerRow[]>([]);
  const [blockTypes, setBlockTypes] = useState<readonly BlockType[]>([]);
  const [cellFields, setCellFields] = useState<readonly CellField[]>([]);
  const [blockStamps, setBlockStamps] = useState<readonly BlockStamp[]>([]);
  const [blockLayerId, setBlockLayerId] = useState<string | null>(null);
  const blockLayerIdRef = useRef<string | null>(null);
  blockLayerIdRef.current = blockLayerId;
  const blockHandlersRef = useRef<BlockPanelHandlers | null>(null);
  /** Each layer's cells as a grid (props snap to them and footprints read them), by the client's block revision. */
  const propGridsRef = useRef<{ revision: number; grids: Map<string, BlockGrid> }>({ revision: -1, grids: new Map() });
  const modelInstancesRef = useRef<ModelInstances | null>(null);
  const pendingProposalRef = useRef<{ proposal: Parameters<typeof publishArgsFromProposal>[0]; target: ImportTarget } | null>(null);
  // The media import context the panel shows between the
  // inspect and the publish — the kind the drop decided, the inspected clip
  // names (a model proposal) and the animated-reimport obligation.
  const mediaPendingRef = useRef<{ kind: 'model' | 'audio' | 'texture' | 'font'; clipNames: string[] | null; referencingEntityIds: string[] } | null>(null);
  const [reimportRoles, setReimportRoles] = useState<Record<AnimationRoleKey, string>>({ idle: '', run: '', airborne: '' });
  const [reimportEntity, setReimportEntity] = useState('');
  const importStateRef = useRef<AssetImportState>(initialImportState);
  const selectedAssetIdRef = useRef<string | null>(null);
  const shiftRef = useRef(false);
  const snappingRef = useRef(true);
  useEffect(() => {
    importStateRef.current = importState;
  }, [importState]);
  useEffect(() => {
    selectedAssetIdRef.current = selectedAssetId;
  }, [selectedAssetId]);
  const assetPreview = useAssetPreview({ clientRef, modelInstancesRef, selectedAssetId, onFailure: (e) => setImportState(importFailed(importStateRef.current, e)) });
  useEffect(() => {
    snappingRef.current = snapping;
  }, [snapping]);

  // ---- Prefab copies + declared-property controls ---------------
  const [prefabSummaries, setPrefabSummaries] = useState<PrefabSummaryView[]>([]);
  const [declarations, setDeclarations] = useState<Map<string, PropertyDeclaration>>(() => new Map());
  const [selectedPrefabId, setSelectedPrefabId] = useState<string | null>(null);
  const [captureName, setCaptureName] = useState('');
  const [captureError, setCaptureError] = useState<UiError | null>(null);
  const [copyError, setCopyError] = useState<UiError | null>(null);
  // Why the last asset / prefab delete was refused.
  const [assetDeleteError, setAssetDeleteError] = useState<string | null>(null);
  const [prefabDeleteError, setPrefabDeleteError] = useState<string | null>(null);
  const [placementError, setPlacementError] = useState<UiError | null>(null);
  const [propertyError, setPropertyError] = useState<UiError | null>(null);
  const [componentError, setComponentError] = useState<UiError | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  // Behavior publication workflow (trust, staging, publication).
  const [behaviorViews, setBehaviorViews] = useState<BehaviorDeclarationView[]>([]);
  // Visual scripts' compile problems (from the last check of each open script), for the Problems tab.
  const scriptIssues = useMemo(
    () =>
      Object.entries(visualProblems).flatMap(([behaviorId, list]) => {
        const b = behaviorViews.find((x) => x.behaviorId === behaviorId);
        if (b === undefined || b.graph === undefined) return [];
        return list.map((p, i) => {
          const s = p.nodeId !== undefined ? splitScoped(p.nodeId) : null;
          const fn = s !== null && s.target !== '' ? b.functions?.find((f) => f.functionId === s.target) : undefined;
          const g = s === null ? undefined : s.target === '' ? b.graph : fn?.graph;
          const kindDef = s !== null && s.target !== '' ? graphKinds['behavior-function'] : graphKinds['behavior'];
          const node = s !== null ? g?.nodes.find((n) => n.id === s.id) : undefined;
          const label = node !== undefined ? (kindDef?.nodes.find((d) => d.type === node.type)?.label ?? node.type) : null;
          return {
            key: `script:${behaviorId}:${i}`,
            graphId: behaviorId,
            graphName: `${b.displayName}${fn !== undefined ? ` › ${scriptFunctionName(fn)}` : ''}`,
            ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}),
            nodeLabel: label,
            severity: p.severity,
            message: p.message,
            behaviorId,
          };
        });
      }),
    [visualProblems, behaviorViews, graphKinds],
  );
  // Graph materials' problems (the kind's rules and the compiler's), for the Problems tab.
  // Computed in the editor worker (inline without one).
  // The textures the materials name, read by id: one not read yet counts as there (it is checked once read).
  const materialTextureIds = useMemo(() => {
    const c = clientRef.current;
    const ids = [...new Set(stringsIn(materials))];
    return ids.filter((id) => {
      const a = c?.content.getAsset(id);
      return a !== undefined ? a.kind === 'texture' : c === null || c === undefined || !c.catalog.assetAbsent(id);
    });
    // `catalogTick` stands for the summaries read since.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the summaries live in the client; the tick says they changed
  }, [materials, catalogTick]);
  useEffect(() => {
    void clientRef.current?.catalog.ensureAssets(stringsIn(materials));
  }, [materials, catalogTick]);
  const materialIssues = useWorkerJob(
    'materialIssues',
    () => ({ materials, graphs, kinds: graphKinds, textureIds: materialTextureIds }),
    (i) => materialIssuesOf(i.materials, i.graphs, i.kinds, i.textureIds),
    NO_MATERIAL_ISSUES,
    [materials, graphs, graphKinds, materialTextureIds],
  );
  const [selectedBehaviorId, setSelectedBehaviorId] = useState<string | null>(null);
  const [publication, setPublication] = useState<BehaviorPublicationState>(() => initialPublicationState());
  const [sourceDraft, setSourceDraft] = useState('');
  const [behaviorError, setBehaviorError] = useState<UiError | null>(null);
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
  }, [selectedId]);

  /** The environment the Scene view shows (the project's). */
  const applyEnvironmentView = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    const env = c.getEnvironment();
    const shown = layerEnvironment(env as unknown as (EnvironmentLike & { wind?: unknown }) | null, null);
    materialLibraryRef.current?.setWind(((shown as { wind?: WindLike } | null)?.wind ?? null) as WindLike | null);
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
    setPrefabSummaries(stable('prefabSummaries', c.prefabs.listSummaries()));
    setDeclarations(stable('declarations', c.prefabs.declarationMap()));
    setBehaviorViews(stable('behaviorViews', [...c.prefabs.listDeclarations()]));
    // The settings map converges from the client state (full
    // states + the applied change records — the backend stays the sole
    // authority).
    setRegistry(c.getDescriptors());
    setSettings(stable('settings', c.getSettings()));
    setTags(stable('tags', c.getTags()));
    setCollisionLayers(stable('collisionLayers', c.getCollisionLayers()));
    setModes(stable('modes', c.getModes()));
    setBehaviorGroups(stable('behaviorGroups', c.getBehaviorGroups()));
    setEventCues(stable('eventCues', c.getEventCues()));
    setShell(stable('shell', c.getShell()));
    setSaveSchema(stable('saveSchema', c.getSaveSchema()));
    const mats = stable('materials', c.getMaterials());
    const env = stable('environment', c.getEnvironment());
    setMaterials(mats);
    setEnvironment(env);
    // Graph materials compile to TSL in the Scene view too (the library recompiles only when a
    // graph's compile input changes — moving a node does not), with the material functions they call.
    const libFunctions = c.getGraphs().filter((g) => g.kind === 'material-function');
    const matsKey = JSON.stringify([mats, libFunctions]);
    if (matsKey !== materialsKeyRef.current) {
      materialsKeyRef.current = matsKey;
      materialLibraryRef.current?.setMaterials(mats as unknown as MaterialDefLike[], libFunctions as unknown as MaterialFunctionLike[]);
      // A material that animates (wind, water) keeps the Scene view drawing from this frame on.
      viewportRef.current?.requestRender();
    }
    // The project environment (wind included).
    applyEnvironmentView();
    setAnimators(stable('animators', c.getAnimators()));
    setEffects(c.getEffects());
    setDialogues(c.getDialogues());
    setSpeakers(c.getSpeakers());
    setDialogueSettings(c.getDialogueSettings());
    setProjectUiDocs(c.getUiDocuments());
    setProjectUiThemes(c.getUiThemes());
    setTimelines(c.getTimelines());
    setScriptLibraries(c.getScriptLibraries());
    setUiDocuments(c.getUiDocuments());
    setUiThemes(c.getUiThemes());
    setGraphs(c.getGraphs());
    setGraphKinds(c.getGraphKinds());
    // The graphs arrive with the content (the same full-state query).
    setGraphsLoaded(c.getContentLoaded());
    setInputConfig(stable('inputConfig', c.getInput()));
    setInputDefaults(stable('inputDefaults', c.getInputDefaults()));
    // The scenes' bakes (lightmaps in the Scene view with game lighting).
    const lit = c.getLighting();
    const lightingKey = JSON.stringify(lit);
    const lighting = stable('lighting', lit, lightingKey);
    setLighting(lighting);
    if (lightingKey !== lightingKeyRef.current && loadTextureRef.current !== null) {
      lightingKeyRef.current = lightingKey;
      viewportRef.current?.setLightmaps(lighting as unknown as Record<string, LightingBakeLike>);
    }
    // The block layers (cells, block types) at their entities' positions.
    const blockLayers = c.getBlockLayers();
    if (blockLayers.size > 0 || c.getBlockRevision() > 0) {
      const byId = new Map(c.projection.listEntities().map((e) => [e.id, e]));
      const layers = new Map([...blockLayers].filter(([id]) => byId.has(id)).map(([id, l]) => [id, { component: l.component, chunks: l.chunks, origin: byId.get(id)!.position }]));
      // An inactive layer object is not drawn.
      const flags = effectiveFlagsOf(c.projection.listEntities());
      for (const [id, l] of layers) (l as { hidden?: boolean }).hidden = flags.get(id)?.active === false;
      viewportRef.current?.setBlockLayers(c.getBlockTypes(), layers, c.getBlockRevision());
      // The Blocks panel's layer list and the Scene view's selected layer.
      const rows: BlockLayerRow[] = [...blockLayers]
        .filter(([id]) => byId.has(id))
        .map(([id, l]) => ({ entityId: id, name: byId.get(id)!.name ?? id, component: l.component, regions: l.regions, active: flags.get(id)?.active !== false, locked: flags.get(id)?.locked === true }));
      setBlockRows(stable('blockRows', rows));
      const sel = blockLayerIdRef.current;
      const l = sel !== null ? layers.get(sel) : undefined;
      const row = rows.find((r) => r.entityId === sel);
      viewportRef.current?.blockEditor()?.setLayer(l !== undefined && row !== undefined ? { entityId: sel!, component: l.component, origin: l.origin, chunks: l.chunks, regions: row.regions, locked: row.locked, hidden: !row.active } : null, c.getBlockRevision());
    } else setBlockRows(stable('blockRows', []));
    setBlockTypes(stable('blockTypes', c.getBlockTypes()));
    setCellFields(stable('cellFields', c.getCellFields()));
    setBlockStamps(stable('blockStamps', c.getBlockStamps()));
    viewportRef.current?.blockEditor()?.setContent(c.getBlockTypes(), c.getCellFields(), c.getBlockStamps());
    setUi((s) => (s.revision === c.projection.revision ? s : { ...s, revision: c.projection.revision }));
  }, [applyEnvironmentView, stable]);

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
        // Back to the Scene from the (now empty) Game tab; a document tab stays in front.
        if (workspaceRef.current.active === 'game') setCenterTab('scene');
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
          viewport.syncEntities(client.visibleEntities());
        };
        if (!g) return restore();
        g.setLocal(transform);
        const outcome = g.decideCommit();
        if (outcome.kind !== 'commit') return restore();
        const before = client.entityTransform(id);
        const res = await client.command('setTransform', { entityId: id, transform: outcome.command.args.transform }, outcome.command.expectedRevision);
        if (res.ok) {
          // A prop's block footprint follows it (its metadata leaves the old cells, lands on the new).
          void writeFootprintRef.current(id, before, outcome.command.args.transform as { position: number[]; rotation: number[] });
          return;
        }
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
      onBrushStroke: (entityId, points) => void editCopiesRef.current.add(entityId, points),
      onRendererChange: (info) => setSceneRenderer(info),
    }, { snapping: () => snappingRef.current && !shiftRef.current, renderer: initialRenderer });
    setSceneRenderer(viewport.rendererInfo());
    viewportRef.current = viewport;
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
    setSnapSettingsState(loadSnapSettings(typeof window !== 'undefined' ? window.localStorage : null, config.projectId));
    // One shared GLB realization path for placements + preview. The
    // resolver is the editor's authenticated byte read; the renderer never
    // receives the token.
    // Project materials (shared by boxes, models and instance sets).
    const sceneAssets = createSceneViewAssets({
      client,
      viewport,
      // What the Scene view holds from assets now (tests read it).
      onResources: (r) => viewportHostRef.current?.setAttribute('data-resources', JSON.stringify(r.resident)),
      onSetBuilt: (entityId, chunks) => setInstanceChunks((prev) => (prev[entityId] === chunks ? prev : { ...prev, [entityId]: chunks })),
      onFailuresChanged: (failures) =>
        setViewFailures([...failures].map(([id, f]) => ({ id, name: client.content.getAsset(id)?.displayName ?? id, code: f.code, message: f.message }))),
    });
    const { loadTexture: loadTextureAsset, materialLibrary, models } = sceneAssets;
    loadTextureRef.current = loadTextureAsset;
    // Spot light cookies, the environment and lightmaps: held in the Scene view's manager with its models and materials.
    viewport.setTextureSource(loadTextureAsset, sceneAssets.resources);
    materialLibraryRef.current = materialLibrary;
    viewport.setMaterialLibrary(materialLibrary);
    viewport.setModelInstances(models);
    modelInstancesRef.current = models;
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
        viewport.syncEntities(client.visibleEntities());
        // Conversations read by id (a tab opened, a preview's jumps).
        setDialogues(client.getDialogues());
      }
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
      sceneAssets.dispose();
      materialLibraryRef.current = null;
      viewport.dispose();
      modelInstancesRef.current = null;
      assetPreview.forget();
      clientRef.current = null;
      viewportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the viewport and session client are made once per mount
  }, []);

  // A changed project chunk size rebuilds the instance sets that use it.
  const instanceChunkSetting = settings?.['instance_chunk_m'];
  useEffect(() => {
    modelInstancesRef.current?.refreshSets();
  }, [instanceChunkSetting]);

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
    viewportRef.current?.syncEntities(entities, clientRef.current?.projection.takeDirty());
    const lit = viewportRef.current?.getLighting();
    if (lit !== undefined) setLightingMode(lit);
    if (!framedRef.current && entities.length > 0) {
      framedRef.current = true;
      viewportRef.current?.frameAll(entities);
    }
  }, [entities]);

  // Local snapping is a gesture option: default on, Shift disables it for the
  // gesture in flight (never persisted). Esc cancels the
  // gesture and sends nothing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') shiftRef.current = true;
      if (e.key === 'Escape' && viewportRef.current?.cancelGesture()) {
        gestureRef.current = null;
        return;
      }
      // Editor shortcuts — never while typing into a field.
      const t = e.target as HTMLElement | null;
      const typing = t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      // With a document tab in front, the scene's shortcuts (delete,
      // tools, frame, copy/paste) stay off; undo/redo remain global.
      const sceneHidden = activeDoc(workspaceRef.current) !== null;
      if (!typing && sceneHidden && (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        void (e.key.toLowerCase() === 'z' && !e.shiftKey ? undo() : redo());
        return;
      }
      if (!typing && !sceneHidden && blockHandlersRef.current?.onKey(e) === true) {
        e.preventDefault();
        return;
      }
      if (!typing && !sceneHidden) {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === 'z') {
          e.preventDefault();
          void (e.shiftKey ? redo() : undo());
          return;
        }
        if (mod && key === 'y') {
          e.preventDefault();
          void redo();
          return;
        }
        if (mod && (key === 'd' || key === 'c' || key === 'v')) {
          e.preventDefault();
          void (key === 'd' ? editRef.current.duplicate() : key === 'c' ? editRef.current.copySelection() : editRef.current.paste());
          return;
        }
        if (!mod && !e.altKey) {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            void del();
            return;
          }
          const mode = key === 'w' ? 'translate' : key === 'e' ? 'rotate' : key === 'r' ? 'scale' : null;
          if (mode !== null) {
            setGizmoMode(mode);
            return;
          }
          if (key === 'f' && selectedIdRef.current !== null) {
            viewportRef.current?.focus(selectedIdRef.current);
            return;
          }
          if (e.key === 'Escape' && selectedIdRef.current !== null) {
            setSelectedId(null);
            return;
          }
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') shiftRef.current = false;
    };
    const onBlur = (): void => {
      shiftRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- the key listeners are installed once; undo, redo, del and setSelectedId are stable callbacks declared further down

  // Selection → gizmo, and to the backend (tools can inspect the selection).
  useEffect(() => {
    viewportRef.current?.setSelected(selectedId, gizmoMode);
  }, [selectedId, gizmoMode]);
  // Another selection drops the selected copy and the brush.
  useEffect(() => {
    setSelectedCopy(null);
    setBrushOn(false);
  }, [selectedId]);
  useEffect(() => {
    viewportRef.current?.setBrush(brushOn ? selectedId : null);
  }, [brushOn, selectedId]);
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

  // ---- the isolated play preview (separate-origin iframe + bridge) --------
  useEffect(() => {
    if (!playInfo || !playInfo.playBase || playInfo.snapshot === null || !playing) return;
    const config = cfg.current;
    if (!config.ok) return;
    const iframe = playIframeRef.current;
    if (!iframe) return;
    const previewOrigin = config.config.previewOrigin;
    const bridge = new Bridge({
      direction: 'editor',
      expectedOrigin: previewOrigin,
      targetOrigin: previewOrigin,
      post: (data, target) => iframe.contentWindow?.postMessage(data, target),
      isTrustedSource: (s) => s === iframe.contentWindow,
    });
    bridgeRef.current = bridge;

    let snapshotSent = false;
    bridge.on('tl.handshake.ack', () => {
      if (snapshotSent) return;
      snapshotSent = true;
      if (playInfo.contentId !== null && playInfo.buildId !== null) {
        bridge.sendPlayContentExpect(playInfo.playSessionId, playInfo.contentId, playInfo.buildId);
      }
      bridge.sendSnapshot(playInfo.playSessionId, playInfo.snapshot);
    });
    bridge.on('tl.ready', (m) => {
      const r = m as { snapshotId?: string; revision?: number };
      setPlayInfo((p) => (p ? { ...p, snapshotId: r.snapshotId ?? p.snapshotId, revision: r.revision ?? p.revision } : p));
      // The editor presented the preview and
      // received its `tl.ready` → send the WS `play.preview.ready` exactly
      // once; the backend marks the play `presented`
      // (lifting the 15 s present-timeout).
      clientRef.current?.sendPlayPreviewReady(playInfo.playSessionId);
    });
    // Load progress keeps the backend's present timeout from firing while the preview still moves.
    bridge.on('tl.load.progress', () => {
      clientRef.current?.sendPlayPreviewProgress(playInfo.playSessionId);
    });
    bridge.on('tl.stopped', () => {
      setPlaying(false);
      setPlayInfo(null);
    });
    // The preview could not
    // start → relay it over WS (`play.preview.failed`);
    // the backend stops the play `preview_failed` (truthful + immediate, not
    // the 15 s present-timeout). The editor also surfaces the code locally.
    bridge.on('tl.error', (m) => {
      const r = m as { code?: string; message?: string; phase?: string };
      const failure = { code: r?.code ?? 'play_content_not_ready', message: r?.message ?? `preview failed${r?.phase ? ` (${r.phase})` : ''}` };
      setGameplayError(failure);
      setNotice(`Play failed: ${failure.message}`);
      void clientRef.current?.sendPlayPreviewFailed(playInfo.playSessionId, r?.code ?? 'play_content_not_ready', r?.message);
    });
    // Relay results: the preview's exact answer goes back to the backend.
    const ack = (frame: Record<string, unknown>): void => clientRef.current?.sendRelayAck(frame);
    const outcome = (r: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
      const out: Record<string, unknown> = { ok: r.ok };
      if (r.ok === true) for (const k of keys) if (r[k] !== undefined) out[k] = r[k];
      if (r.ok !== true) out.error = r.error;
      return out;
    };
    bridge.on('tl.screenshot.result', (m) => {
      const r = m as Record<string, unknown>;
      ack({ type: 'screenshot.ack', relayId: r.relayId, ...outcome(r, ['dataUrl', 'width', 'height']) });
    });
    bridge.on('tl.diagnostics.result', (m) => {
      const r = m as Record<string, unknown>;
      // The Play label's own diagnostics requests are not the backend's relays.
      const waiter = debugWaitersRef.current.get(String(r.relayId));
      if (waiter !== undefined) {
        debugWaitersRef.current.delete(String(r.relayId));
        waiter(r.ok === true && typeof r.diagnostics === 'object' && r.diagnostics !== null ? (r.diagnostics as Record<string, unknown>) : null);
        return;
      }
      ack({ type: 'play.diagnostics.ack', relayId: r.relayId, ...outcome(r, ['diagnostics']) });
    });
    bridge.on('tl.input.result', (m) => {
      const r = m as Record<string, unknown>;
      ack({ type: 'input.result', requestId: r.requestId, ...outcome(r, ['appliedFromStep', 'appliedToStep']) });
    });
    bridge.on('tl.game.control.result', (m) => {
      const r = m as Record<string, unknown>;
      // The editor's own requests (clear the Play save) are not the backend's relays.
      if (localRelaysRef.current.delete(String(r.relayId))) {
        setPlaySaveNote(r.ok === true ? 'The Play save was cleared (restart Play to start without it).' : 'Clearing the Play save failed.');
        return;
      }
      ack({ type: 'game.control.ack', relayId: r.relayId, ...outcome(r, ['result']) });
    });
    bridge.on('tl.game.observe.result', (m) => {
      const r = m as Record<string, unknown>;
      // The Play debug view's own observations are not the backend's relays.
      const waiter = debugWaitersRef.current.get(String(r.relayId));
      if (waiter !== undefined) {
        debugWaitersRef.current.delete(String(r.relayId));
        waiter(r.ok === true && typeof r.result === 'object' && r.result !== null ? (r.result as Record<string, unknown>) : null);
        return;
      }
      ack({ type: 'game.observe.ack', relayId: r.relayId, ...outcome(r, ['result']) });
    });
    // The visual-script debugger's polls (the editor's own; never a backend relay).
    bridge.on('tl.debug.result', (m) => {
      const r = m as Record<string, unknown>;
      const waiter = debugWaitersRef.current.get(String(r.relayId));
      if (waiter === undefined) return;
      debugWaitersRef.current.delete(String(r.relayId));
      waiter(r.ok === true && typeof r.result === 'object' && r.result !== null ? (r.result as Record<string, unknown>) : null);
    });

    const onLoad = (): void => {
      // The editor holds the retained play.started snapshot; on the
      // iframe load it runs the handshake, then sends the snapshot. The v2
      // handshake also carries the locator capability + build identity.
      bridge.beginHandshake(playInfo.playSessionId, false, playInfo.contentId ?? '', playInfo.buildId ?? '');
    };
    const onMsg = (ev: MessageEvent): void => {
      bridge.handleMessage({ origin: ev.origin, source: ev.source, data: ev.data });
    };
    iframe.addEventListener('load', onLoad);
    window.addEventListener('message', onMsg);
    // The preview may finish loading before this listener exists (the load
    // event is then missed): keep offering the handshake until it is acked.
    const retry = window.setInterval(() => {
      if (snapshotSent) window.clearInterval(retry);
      else onLoad();
    }, 300);
    return () => {
      window.clearInterval(retry);
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMsg);
      bridgeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the play bridge restarts only when the play session's identity changes
  }, [playing, playInfo?.playSessionId, playInfo?.playBase, playInfo?.snapshot, playInfo?.contentId, playInfo?.buildId]);

  // ---- toolbar actions (all delegated to the backend) ---------------------
  const newBox = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    // Spawn where the camera is looking (on the 0.25 m grid) so new boxes don't stack at the origin.
    const focus = viewportRef.current?.focusPoint() ?? [0, 0.5, 0];
    const position = focus.map((v) => Math.round(v * 4) / 4);
    const res = await c.command(
      'createEntity',
      { kind: 'box', parentId: null, name: `box-${Date.now() % 10000}`, transform: { position } },
      c.projection.revision,
    );
    if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
  }, [setSelectedId]);
  const del = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !selectedIdRef.current) return;
    // A selected copy of an instance set is deleted from its set (the object stays).
    const copy = viewportRef.current?.getSelectedCopy() ?? null;
    if (copy !== null) {
      await editCopiesRef.current.remove(copy.entityId, copy.index);
      return;
    }
    // Every selected subtree (one deleteEntity each; a child of a
    // selected entity goes with it).
    const ids = draggedRoots(c.projection.listEntities(), selectionRef.current.length > 0 ? selectionRef.current : [selectedIdRef.current]);
    for (const entityId of ids) {
      const res = await c.command('deleteEntity', { entityId }, c.projection.revision);
      if (!res.ok) break;
    }
    setSelectedId(null);
  }, [setSelectedId]);
  /** Report a failed edit where the user is looking. */
  const reportFailure = useCallback((what: string, res: Awaited<ReturnType<SessionClient['command']>>) => {
    if (res.ok) return;
    const r = res.response as { code?: string; message?: string };
    setNotice(`${what} failed: ${r.message ?? r.code ?? 'unknown error'}`);
  }, []);
  const rename = useCallback(async (entityId: string, name: string) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Rename', await c.command('updateEntity', { entityId, name }, c.projection.revision));
  }, [reportFailure]);

  // ---- GameObject menu: create at the point the camera looks at -----------
  // (Before the Scene view reports a focus point: [0, 0.5, 0], where a new 1 m
  // box rests on the ground plane — a unit, not a character size.)
  const createEntityAt = useCallback(
    async (what: string, args: Record<string, unknown>, position?: number[]) => {
      const c = clientRef.current;
      if (!c) return;
      const focus = viewportRef.current?.focusPoint() ?? [0, 0.5, 0];
      const at = position ?? focus.map((v) => Math.round(v * 4) / 4);
      const res = await c.command('createEntity', { parentId: null, transform: { position: at }, ...args }, c.projection.revision);
      if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
      else reportFailure(what, res);
    },
    [reportFailure, setSelectedId],
  );
  const createEmpty = useCallback(() => createEntityAt('Create empty', { kind: 'group', name: `entity-${Date.now() % 10000}` }), [createEntityAt]);
  // The camera and the lights are the descriptor's add value and
  // presets (one table for this menu and "+ Add component").
  const createCamera = useCallback(() => {
    const camera = presetValue(registry, 'camera');
    if (camera === null) return setNotice('Create camera failed: the component defaults have not arrived yet');
    const c = clientRef.current;
    if (!c) return;
    // 4 m in front of the point the Scene view looks at, facing it — the starter camera's framing of the origin.
    const focus = viewportRef.current?.focusPoint() ?? [0, 0.5, 0];
    const at = focus.map((v) => Math.round(v * 4) / 4);
    // createEntity does not add cameras (its component set is closed): an object, then its camera (a setComponent add).
    void (async () => {
      const made = await c.command('createEntity', { parentId: null, kind: 'group', name: 'Camera', transform: { position: [at[0]!, at[1]!, at[2]! + 4] } }, c.projection.revision);
      if (!made.ok || made.createdId === undefined) return reportFailure('Create camera', made);
      const res = await c.setComponent(made.createdId, 'camera', camera, c.projection.revision);
      if (!res.ok) {
        // Refused (a v4 project keeps exactly one camera in its start scenes): take the empty object away again.
        reportFailure('Create camera', res);
        await c.command('deleteEntity', { entityId: made.createdId }, c.projection.revision);
        return;
      }
      setSelectedId(made.createdId);
    })();
  }, [registry, reportFailure, setSelectedId]);
  const createLight = useCallback(
    (type: 'directional' | 'ambient' | 'point' | 'spot' | 'hemisphere') => {
      const name = `${type.charAt(0).toUpperCase()}${type.slice(1)} light`;
      const light = presetValue(registry, 'light', name);
      if (light === null) return setNotice(`Create ${type} light failed: the component defaults have not arrived yet`);
      return createEntityAt(`Create ${type} light`, { kind: 'group', name, components: { light } }, type === 'directional' ? [0, 10, 0] : type === 'ambient' || type === 'hemisphere' ? [0, 0, 0] : undefined);
    },
    [createEntityAt, registry],
  );

  /** The full values of the selection's subtrees (parents first), read from the backend. */
  const selectionValues = useCallback(async (): Promise<Record<string, unknown>[] | null> => {
    const c = clientRef.current;
    if (!c) return null;
    const ids = selectionRef.current.length > 0 ? selectionRef.current : selectedIdRef.current !== null ? [selectedIdRef.current] : [];
    if (ids.length === 0) return null;
    const order = subtreeOrder(c.projection.listEntities(), ids);
    const read = await Promise.all(order.map((id) => c.queryEntity(id)));
    const failed = read.find((r) => !r.ok);
    if (failed !== undefined && !failed.ok) {
      setNotice(`Copy failed: ${failed.error.message}`);
      return null;
    }
    return read.map((r) => (r as { entity: Record<string, unknown> }).entity);
  }, []);

  /** Edit → Duplicate (Ctrl+D): the whole selection with its children, 0.5 m to the right, one undo. */
  const duplicate = useCallback(async () => {
    const c = clientRef.current;
    const values = await selectionValues();
    if (!c || values === null) return;
    const sceneId = c.projection.listEntities().find((e) => e.id === values[0]?.['id'])?.sceneId;
    // The duplicated roots are named "<name> copy" (their children keep their names).
    const ids = new Set(values.map((v) => v['id']));
    const named = values.map((v) => (ids.has(v['parentId']) ? v : { ...v, name: `${String(v['name'] ?? v['id'])} copy`.slice(0, 128) }));
    const res = await c.command('pasteEntities', { entities: named, offset: [0.5, 0, 0], ...(sceneId !== undefined ? { sceneId } : {}) }, c.projection.revision);
    if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
    else reportFailure('Duplicate', res);
  }, [reportFailure, selectionValues, setSelectedId]);

  /** Edit → Copy (Ctrl+C): remember the selection's values (any scene). */
  const clipboardRef = useRef<Record<string, unknown>[] | null>(null);
  const copySelection = useCallback(async () => {
    const values = await selectionValues();
    if (values === null) return;
    clipboardRef.current = values;
    setNotice(`Copied ${values.length} object${values.length === 1 ? '' : 's'}`);
  }, [selectionValues]);

  /** Edit → Paste (Ctrl+V): into the active scene, inside the selected folder if one is selected. */
  const paste = useCallback(async () => {
    const c = clientRef.current;
    const values = clipboardRef.current;
    if (!c || values === null) return;
    const target = selectedIdRef.current !== null ? c.projection.listEntities().find((e) => e.id === selectedIdRef.current) : undefined;
    const parentId = target?.kind === 'folder' ? target.id : null;
    const res = await c.command('pasteEntities', { entities: values, parentId }, c.projection.revision);
    if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
    else reportFailure('Paste', res);
  }, [reportFailure, setSelectedId]);
  const editRef = useRef({ duplicate, copySelection, paste });
  editRef.current = { duplicate, copySelection, paste };

  /**
   * Edit an instance set's copies — the new copy list is
   * published through the buffer route (the one `tl_instance_buffer` uses)
   * and stored with one `setComponent instances` (one undo step).
   */
  const editCopies = async (entityId: string, what: string, make: (floats: Float32Array) => Float32Array | string): Promise<boolean> => {
    const c = clientRef.current;
    const inst = c?.projection.getEntity(entityId)?.instances;
    if (!c || inst === undefined) return false;
    const floats = modelInstancesRef.current?.instanceBuffer(inst.buffer) ?? (await c.instanceBufferBytes(inst.buffer).catch(() => null));
    if (floats === null) {
      setNotice(`${what} failed: the copies are not loaded yet`);
      return false;
    }
    const next = make(floats);
    if (typeof next === 'string') {
      setNotice(`${what}: ${next}`);
      return false;
    }
    const published = await c.publishInstanceBuffer(next);
    if (!published.ok) {
      setNotice(`${what} failed: ${published.error.message}`);
      return false;
    }
    const r = await c.setComponent(entityId, 'instances', { buffer: published.digest, count: published.count }, c.projection.revision);
    if (!r.ok && (r.response as { code?: string }).code === 'no_change') return true;
    reportFailure(what, r);
    return r.ok;
  };
  const editCopiesRef = useRef({
    transform: async (_e: string, _i: number, _t: CopyTransform): Promise<void> => undefined,
    add: async (_e: string, _p: [number, number, number][]): Promise<void> => undefined,
    remove: async (_e: string, _i: number): Promise<void> => undefined,
  });
  editCopiesRef.current = {
    transform: async (entityId, index, t) => {
      await editCopies(entityId, 'Move copy', (f) => withCopy(f, index, t));
    },
    add: async (entityId, points) => {
      await editCopies(entityId, 'Brush', (f) => withAddedCopies(f, points));
    },
    remove: async (entityId, index) => {
      const ok = await editCopies(entityId, 'Delete copy', (f) => withoutCopy(f, index) ?? 'an instance set keeps at least one copy (delete the object instead)');
      if (ok) {
        viewportRef.current?.setSelectedCopy(null);
        setSelectedCopy(null);
      }
    },
  };



  /** File → Export game…: the admin export route, then a zip download. */
  const exportGame = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setExportState({ busy: true, result: null, error: null });
    const r = await c.exportProject();
    if (r.ok) setExportState({ busy: false, result: { outputDir: r.outputDir, revision: r.revision, files: r.files }, error: null });
    else setExportState({ busy: false, result: null, error: r.error.message });
  }, []);
  const downloadExport = useCallback(async (dir: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const blob = await c.fetchExportZip(dir);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${dir.replace('@', '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setExportState((st) => ({ ...st, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);
  /** File entities (with their subtrees) under a parent, before a sibling or at the end. */
  const move = useCallback(async (entityIds: string[], parentId: string | null, beforeId: string | null) => {
    const c = clientRef.current;
    if (!c || entityIds.length === 0) return;
    const res = await c.command('moveEntities', { entityIds, parentId, ...(beforeId !== null ? { beforeId } : {}) }, c.projection.revision);
    // Dropping something where it already is changes nothing; not an error.
    if (!res.ok && (res.response as { code?: string }).code === 'no_change') return;
    reportFailure('Move', res);
  }, [reportFailure]);
  /** Scatter copies of one model into a new instance set at the point the camera looks at. */
  const createInstanceSet = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const opts = {
      count: Number(scatter.count),
      width: Number(scatter.width),
      depth: Number(scatter.depth),
      scaleMin: Number(scatter.scaleMin),
      scaleMax: Number(scatter.scaleMax),
      randomYaw: scatter.randomYaw,
      seed: Number(scatter.seed),
    };
    const problem = scatter.assetId === '' ? 'choose a model' : scatterProblem(opts);
    if (problem !== null) {
      setScatter((f) => ({ ...f, error: problem }));
      return;
    }
    setScatter((f) => ({ ...f, busy: true, error: null }));
    // The placements are computed in the editor worker (inline without one: the same function).
    let floats: Float32Array;
    try {
      floats = await editorWorkers().run('scatter', () => ({ input: opts }), { inline: () => scatterTransforms(opts) });
    } catch (e) {
      setScatter((f) => ({ ...f, busy: false, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    const published = await c.publishInstanceBuffer(floats);
    if (!published.ok) {
      setScatter((f) => ({ ...f, busy: false, error: published.error.message }));
      return;
    }
    const name = `${c.content.getAsset(scatter.assetId)?.displayName ?? 'Model'} ×${published.count}`;
    await createEntityAt('Instance set', { kind: 'group', name, components: { instances: { asset: { assetId: scatter.assetId }, buffer: published.digest, count: published.count } } });
    setScatter((f) => ({ ...f, busy: false }));
    setDialog(null);
  }, [scatter, createEntityAt]);
  /** The scene controls (headers, new/open) — index ops are commands, open/active are local. */
  const sceneAction = useCallback(async (action: SceneAction) => {
    const c = clientRef.current;
    if (!c) return;
    switch (action.kind) {
      case 'activate':
        c.setActiveScene(action.sceneId);
        return;
      case 'open':
        c.setSceneOpen(action.sceneId, true);
        return;
      case 'close':
        c.setSceneOpen(action.sceneId, false);
        return;
      case 'create': {
        const taken = new Set(c.projection.scenes.map((r) => r.name));
        let n = c.projection.scenes.length + 1;
        while (taken.has(`Scene ${n}`)) n += 1;
        const before = new Set(c.projection.scenes.map((r) => r.sceneId));
        const res = await c.command('createScene', { name: `Scene ${n}` }, c.projection.revision);
        reportFailure('New scene', res);
        if (res.ok) {
          // The index arrives with mutation.applied; activate the new scene once it is there.
          const created = await waitFor(() => c.projection.scenes.find((r) => !before.has(r.sceneId))?.sceneId ?? null);
          if (created !== null) c.setActiveScene(created);
        }
        return;
      }
      case 'rename':
        reportFailure('Rename scene', await c.command('renameScene', { sceneId: action.sceneId, name: action.name }, c.projection.revision));
        return;
      case 'delete':
        reportFailure('Delete scene', await c.command('deleteScene', { sceneId: action.sceneId }, c.projection.revision));
        return;
      case 'toggleStart': {
        const start = c.projection.startScenes;
        const next = start.includes(action.sceneId) ? start.filter((id) => id !== action.sceneId) : [...start, action.sceneId];
        if (next.length === 0) {
          setNotice('The game needs at least one start scene.');
          return;
        }
        reportFailure('Start scenes', await c.command('setStartScenes', { sceneIds: next }, c.projection.revision));
        return;
      }
    }
  }, [reportFailure]);
  /** Replace the tag registry (one setTags command). */
  const saveTags = useCallback(async (next: { bit?: number; name: string }[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setTags', { tags: next }, c.projection.revision);
    if (res.ok) setTagsError(null);
    else setTagsError((res.response as { message?: string }).message ?? 'the tags could not be saved');
  }, []);
  /** Replace the named collision layers (one setCollisionLayers command). */
  const saveCollisionLayers = useCallback(async (next: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setCollisionLayers', { layers: next }, c.projection.revision);
    if (res.ok) setLayersError(null);
    else setLayersError((res.response as { message?: string }).message ?? 'the collision layers could not be saved');
  }, []);
  /** Replace the game modes (one setModes command) or the behavior groups (one setBehaviorGroups). */
  const saveModes = useCallback(async (next: GameMode[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setModes', { modes: next }, c.projection.revision);
    if (res.ok) setModesError(null);
    else setModesError((res.response as { message?: string }).message ?? 'the game modes could not be saved');
  }, []);
  const saveBehaviorGroups = useCallback(async (next: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setBehaviorGroups', { groups: next }, c.projection.revision);
    if (res.ok) setModesError(null);
    else setModesError((res.response as { message?: string }).message ?? 'the behavior groups could not be saved');
  }, []);
  /**
   * Replace the game shell (one setShell command; null removes it). The
   * args are built at send time on top of the shell as it is then (an edit made while an earlier
   * one's result is still on its way keeps both).
   */
  const saveShell = useCallback(async (next: GameShell | null, base: GameShell | null) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { shell: GameShell | null } => ({ shell: next === null ? null : (mergeDocumentEdit(base, next, c.getShell()) ?? next) });
    const res = await c.command('setShell', build, c.projection.revision);
    if (res.ok) setShellError(null);
    else setShellError((res.response as { message?: string }).message ?? 'the game shell could not be saved');
  }, []);
  /** Replace the event → cue table (one setEventCues command; built at send time, row by row on the table as it is then). */
  const saveEventCues = useCallback(async (next: EventCue[], base: EventCue[]) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { cues: EventCue[] } => ({ cues: mergeListEdit(base, next, c.getEventCues()) });
    const res = await c.command('setEventCues', build, c.projection.revision);
    if (res.ok) setEventCuesError(null);
    else setEventCuesError((res.response as { message?: string }).message ?? 'the event sounds could not be saved');
  }, []);
  /** Replace the project save schema (one setSaveSchema command; null removes it). */
  const saveSaveSchema = useCallback(async (next: SaveSchema | null) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setSaveSchema', { schema: next }, c.projection.revision);
    if (res.ok) setSaveSchemaError(null);
    else setSaveSchemaError((res.response as { message?: string }).message ?? 'the save schema could not be saved');
  }, []);
  /** Set an entity's own tags, by name. */
  const setEntityTags = useCallback(async (entityId: string, names: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Set tags', await c.command('updateEntity', { entityId, tags: names }, c.projection.revision));
  }, [reportFailure]);
  /** Set one hierarchy flag (active / locked / static) on an entity. */
  const setFlag = useCallback(async (entityId: string, flag: EntityFlag, value: boolean) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure(`Set ${flag}`, await c.command('updateEntity', { entityId, [flag]: value }, c.projection.revision));
  }, [reportFailure]);
  // ---- Block layers -------------------------------------------------
  /** The block layers props sit on (their cells as grids, rebuilt when the client's cells change). */
  const propLayers = useCallback((only?: string): PropLayer[] => {
    const c = clientRef.current;
    if (!c) return [];
    const cache = propGridsRef.current;
    if (cache.revision !== c.getBlockRevision()) propGridsRef.current = { revision: c.getBlockRevision(), grids: new Map() };
    const grids = propGridsRef.current.grids;
    const out: PropLayer[] = [];
    for (const [id, l] of c.getBlockLayers()) {
      if (only !== undefined && id !== only) continue;
      const e = c.projection.getEntity(id);
      if (!e || e.active === false) continue;
      let g = grids.get(id);
      if (g === undefined) grids.set(id, (g = BlockGrid.from(l.component, { entityId: id, chunks: [...l.chunks.values()] })));
      const grid = g;
      out.push({ entityId: id, component: l.component, origin: e.position, columnTop: (x, z) => grid.columnTop(x, z) });
    }
    return out;
  }, []);
  /** Write a prop's block footprint: its fields leave the cells under `before` and land on those under `after` (one editBlocks per layer). */
  const writeFootprint = useCallback(async (entityId: string, before: { position: number[]; rotation: number[] } | null, after: { position: number[]; rotation: number[] }, fp?: BlockFootprintComponent) => {
    const c = clientRef.current;
    if (!c) return;
    const footprint = fp ?? ((c.projection.getEntity(entityId)?.components as { blockFootprint?: BlockFootprintComponent } | undefined)?.blockFootprint);
    if (footprint === undefined) return;
    for (const layer of propLayers(footprint.layer)) {
      const was = before === null ? [] : footprintCells(layer, before.position, before.rotation, footprint);
      const now = footprintCells(layer, after.position, after.rotation, footprint);
      const edits = footprintEdits(was, now, footprint.set);
      if (edits === null) continue;
      const r = await c.command('editBlocks', { entityId: layer.entityId, edits }, c.projection.revision);
      if (!r.ok && (r.response as { code?: string }).code !== 'no_change') reportFailure('Block footprint', r);
    }
  }, [propLayers, reportFailure]);
  const writeFootprintRef = useRef(writeFootprint);
  writeFootprintRef.current = writeFootprint;
  // Cell-top snapping: moved and dropped objects land on the block cells under them.
  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    v.setCellTopSnap(
      snapSettings.cellTops
        ? (entityId, position, rotation) => {
            const c = clientRef.current;
            if (!c) return null;
            if (entityId !== null && c.getBlockLayers().has(entityId)) return null;
            const fp = entityId !== null ? ((c.projection.getEntity(entityId)?.components as { blockFootprint?: BlockFootprintComponent } | undefined)?.blockFootprint) : undefined;
            return snapToCellTop(propLayers(fp?.layer), position, fp?.size, yawQuarterTurns(rotation));
          }
        : null,
    );
  }, [snapSettings.cellTops, propLayers, blockEditor]);
  const blockRun = useCallback(async (what: string, op: string, args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const r = await c.command(op, args, c.projection.revision);
    if (!r.ok && (r.response as { code?: string }).code === 'no_change') return false;
    reportFailure(what, r);
    return r.ok;
  }, [reportFailure]);
  const blockEdit = useCallback((what: string, entityId: string, edits: BlockEdit[]) => blockRun(what, 'editBlocks', { entityId, edits }), [blockRun]);
  const createBlockLayer = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const value = presetValue(registry, 'blockLayer');
    if (value === null) return setNotice('New block layer failed: the component defaults have not arrived yet');
    const res = await c.command('createEntity', { parentId: null, kind: 'group', name: 'Block layer', transform: { position: [0, 0, 0] } }, c.projection.revision);
    if (!res.ok || res.createdId === undefined) return reportFailure('New block layer', res);
    const id = res.createdId;
    reportFailure('New block layer', await c.command('setComponent', { entityId: id, component: 'blockLayer', value }, c.projection.revision));
    setBlockLayerId(id);
  }, [registry, reportFailure]);

  /** GameObject → Folder: inside the selected folder, else at the root. */
  const createFolder = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const sel = selectedIdRef.current !== null ? c.projection.getEntity(selectedIdRef.current) : undefined;
    const parentId = sel?.kind === 'folder' ? sel.id : null;
    const res = await c.command('createEntity', { kind: 'folder', name: 'Folder', parentId }, c.projection.revision);
    if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
    else reportFailure('Create folder', res);
  }, [reportFailure, setSelectedId]);
  const editTransform = useCallback(async (entityId: string, patch: { position?: number[]; rotation?: number[]; scale?: number[] }) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setTransform', { entityId, transform: patch }, c.projection.revision);
    if (!res.ok) refreshEntities();
    reportFailure('Transform edit', res);
  }, [reportFailure, refreshEntities]);
  const undo = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await c.command('undo', {}, c.projection.revision);
  }, []);
  const redo = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await c.command('redo', {}, c.projection.revision);
  }, []);
  const play = useCallback(async (start?: Parameters<SessionClient['playStart']>[1]) => {
    const c = clientRef.current;
    if (!c) return;
    // A refused start (missing files, a script that does not compile) says why; the Problems log keeps it.
    const r = await c.playStart(false, start).catch((e: unknown) => void setNotice(`Play refused: ${c.describeError(e).message}`));
    if (r === undefined) return;
    // The snapshot arrives via the retained play.started WS event; the iframe
    // is created once both playBase (HTTP) and snapshot (WS) are present.
    setPlayInfo((p) => ({
      playSessionId: r.playSessionId,
      playBase: r.playBase,
      snapshot: p?.snapshot ?? null,
      snapshotId: r.snapshotId,
      revision: r.revision,
      contentId: r.playContent?.contentId ?? null,
      buildId: r.playContent?.buildId ?? null,
      contentPath: r.playContent?.path ?? null,
    }));
  }, []);
  /**
   * "Play from…" — the same play start as the Play button with
   * start options (the backend resolves them; `tl_play_start` sends the same).
   */
  const playFrom = useCallback(async () => {
    const f = playFromForm;
    let variables: Record<string, unknown> | undefined;
    if (f.variables.trim() !== '') {
      try {
        const v = JSON.parse(f.variables) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
        variables = v as Record<string, unknown>;
      } catch {
        setPlayFromForm((x) => ({ ...x, error: 'Variables must be a JSON object, e.g. {"gold": 100}' }));
        return;
      }
    }
    const start = {
      ...(f.sceneId !== '' ? { sceneId: f.sceneId } : {}),
      ...(variables !== undefined ? { variables } : {}),
      ...(f.saveSlot !== '' ? { saveSlot: f.saveSlot } : {}),
      // The game mode the run starts in.
      ...(f.mode !== '' ? { mode: f.mode } : {}),
    };
    setPlayFromForm((x) => ({ ...x, busy: true, error: null }));
    try {
      await play(start);
      setPlayFromForm((x) => ({ ...x, busy: false }));
      setDialog(null);
    } catch (e) {
      const body = (e as { body?: { error?: { message?: unknown } } }).body;
      const message = typeof body?.error?.message === 'string' ? body.error.message : e instanceof Error ? e.message : 'Play could not start';
      setPlayFromForm((x) => ({ ...x, busy: false, error: message }));
    }
  }, [playFromForm, play]);
  const stop = useCallback(async () => {
    const c = clientRef.current;
    const b = bridgeRef.current;
    if (!c || !playInfo) return;
    b?.requestStop(playInfo.playSessionId);
    await c.playStop(playInfo.playSessionId);
  }, [playInfo]);

  const resync = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    void c.fullResync().then(() => refreshEntities());
  }, [refreshEntities]);

  // ---- Gameplay authoring actions (all delegated to the
  // backend through the ordinary command path; one command per action) ------

  const saveSettings = useCallback(
    async (settings: Record<string, number>) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const res = await c.setSettings(settings, c.projection.revision);
      if (res.ok) {
        refreshEntities();
        return;
      }
      setGameplayError(commandError(res));
    },
    [refreshEntities],
  );

  // ---- Media / lighting / animation authoring -----------------
  // The cue PREVIEW owner: one per session,
  // disposed on teardown; the panel renders its status + bounded diagnostics.
  const previewOwnerRef = useRef<PreviewAudioOwner | null>(null);
  if (previewOwnerRef.current === null) previewOwnerRef.current = createPreviewAudioOwner();
  // A state bump after each gesture/preview: the owner's status + diagnostics
  // are read fresh on the re-render it triggers (the value itself is ignored).
  const [, bumpPreview] = useState(0);
  useEffect(() => {
    return () => {
      void previewOwnerRef.current?.dispose();
    };
  }, []);

  const unlockPreview = useCallback(() => {
    void previewOwnerRef.current?.unlock().then(() => bumpPreview((n) => n + 1));
  }, [bumpPreview]);

  /** Register + preview one committed cue (bytes from the editor's content
   * read — the authoring token is that read's credential, never a resource). */
  const previewCue = useCallback(
    async (assetId: string) => {
      const c = clientRef.current;
      const owner = previewOwnerRef.current;
      if (!c || !owner) return;
      const version = c.content.currentVersion(assetId);
      if (version === null) return;
      try {
        const bytes = await c.assetByteResolver()({ assetId, version });
        owner.registerCue(assetId, bytes);
        owner.preview(assetId);
        bumpPreview((n) => n + 1);
      } catch {
        // A failed read is the ordinary network path; the panel stays usable.
      }
    },
    [bumpPreview],
  );

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
  }, []);

  // ---- Asset files in the game folder -------------
  // The file check (useAssetFileCheck.ts): moved and changed files, Problems rows.
  const fileCheck = useAssetFileCheck(clientRef, ui.connection);
  const [filePicker, setFilePicker] = useState<'create' | 'reimport' | null>(null);
  /** Models the scene view could not show (never silent). */
  const [viewFailures, setViewFailures] = useState<{ id: string; name: string; code: string; message: string }[]>([]);
  const loadProjectFiles = useCallback(
    (dir: string) =>
      clientRef.current !== null
        ? clientRef.current.listProjectFiles(dir)
        : Promise.resolve({ ok: false as const, error: { code: 'session_unavailable', message: 'not connected' } }),
    [],
  );

  const { importSettings, textureEncoding, reimportWithExtract, uploadFolder, setUploadFolder, importFile, importFromFolder, publish, reimportIssue, cancelImportFlow, discardImportFlow } = useAssetImport({
    clientRef,
    pendingProposalRef,
    mediaPendingRef,
    importStateRef,
    selectedAssetIdRef,
    setImportState,
    setSelectedAssetId,
    reimportRoles,
    setReimportRoles,
    reimportEntity,
    setReimportEntity,
    refreshEntities,
    checkFiles: fileCheck.checkFiles,
    showAssets: () => setBottomTab('assets'),
  });
  // The project window: its folder (new items and uploads go there), moves, and what a double-click opens.
  const projectWindow = useProjectWindow(clientRef, setUploadFolder, {
    openDocument: (kind, id) => workspaceDispatch({ type: 'open', doc: { kind, id } }),
    isVisualScript: (id) => behaviorViews.find((b) => b.behaviorId === id)?.graph !== undefined,
    openScene: (sceneId) => {
      void sceneAction({ kind: 'open', sceneId }).then(() => sceneAction({ kind: 'activate', sceneId }));
      setCenterTab('scene');
    },
    showPrefab: (id) => {
      setSelectedPrefabId(id);
      setBottomTab('prefabs');
    },
    showEnvironment: () => setBottomTab('environment'),
    previewAsset: (id) => {
      setSelectedAssetId(id);
      void assetPreview.load(id);
    },
  });

  // The Animator window's live preview — the controller's model in
  // its own small stage, posed every frame by the runtime's state machine.
  const previewAnimator = useCallback(async (controller: AnimatorController, canvas: HTMLCanvasElement): Promise<AnimatorPreview | string> => {
    const c = clientRef.current;
    const m = modelInstancesRef.current;
    if (!c || !m) return 'the editor is not ready';
    // The model the clips are for: the first clip's asset, or the rig of an animation-only asset.
    const clipAssets = new Set<string>();
    for (const g of [controller, ...(controller.layers ?? [])]) {
      for (const x of g.states) {
        if (x.motion.kind === 'clip') clipAssets.add(x.motion.clip.assetId);
        else if (x.motion.kind === 'blend1d') for (const k of x.motion.children) clipAssets.add(k.clip.assetId);
      }
    }
    const first = [...clipAssets][0];
    if (first === undefined) return 'give a state a clip first';
    const assetId = c.content.getAsset(first)?.clipsFor ?? first;
    // Clips of animation-only assets marked "clips for" this model, loaded before the preview starts.
    const foreign = new Map<string, readonly THREE.AnimationClip[]>();
    for (const id of clipAssets) {
      if (id === assetId || c.content.getAsset(id)?.clipsFor !== assetId) continue;
      const r = await m.prepared(id);
      if (r !== null) foreign.set(id, r.animationClips());
    }
    const v = c.content.resolveVersion(assetId);
    if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) return 'the model has no published version';
    const stage = new PreviewStage(canvas);
    const res = await m.previewAsset({ assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength }, stage.scene);
    if (!res.ok) {
      stage.dispose();
      return res.message;
    }
    stage.frame(res.session.root);
    const machine = new AnimatorMachine(controller as unknown as AnimatorControllerLike);
    const player = createAnimatorPlayer(res.session.root, res.session.animationClips, assetId, { clipsOf: (id) => foreign.get(id) ?? null });
    let last = performance.now();
    let raf = 0;
    let elapsed = 0;
    const tick = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      elapsed += dt;
      machine.step(dt);
      last = now;
      player.apply(machine.pose());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    let done = false;
    return {
      set: (name, value) => void machine.set(name, value),
      trigger: (name) => void machine.trigger(name),
      state: () => machine.stateName(),
      layerStates: () => Array.from({ length: machine.layerCount() }, (_, i) => machine.stateName(i)),
      // The preview plays at the speed a script would set (the same machine the game steps).
      setSpeed: (speed) => void machine.setSpeed(speed),
      elapsed: () => elapsed,
      clipTime: () => {
        const clips = machine.pose().clips;
        let best = clips[0];
        for (const c of clips) if (best === undefined || c.weight > best.weight) best = c;
        return best?.time ?? 0;
      },
      dispose: () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        player.dispose();
        if (m.previewSession() === res.session) m.clearPreview();
        stage.dispose();
      },
    };
  }, []);

  const placement = selectedAssetId !== null ? planAssetPlacement(selectedAssetId) : null;

  // ---- Prefab capture / copy / property edit ---------------------

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
    [refreshEntities],
  );

  const placeAsset = useCallback(async () => {
    const c = clientRef.current;
    const assetId = selectedAssetIdRef.current;
    if (!c || !assetId) return;
    // Named after the asset and placed where the camera is looking.
    const displayName = c.content.getAsset(assetId)?.displayName;
    const focus = viewportRef.current?.focusPoint() ?? [0, 0, 0];
    const command = planAssetPlacement(assetId, {
      ...(displayName !== undefined ? { name: displayName.slice(0, 128) } : {}),
      transform: { position: focus.map((v) => Math.round(v * 4) / 4) },
    });
    setPlacementError(null);
    await runTypedCommand('createEntity', command.args, setPlacementError);
  }, [runTypedCommand]);

  /**
   * Drop a model (or one piece) from the asset tiles: one createEntity — a
   * piece, a whole single-piece file, or a folder holding every piece of a
   * multi-piece file laid out in a row. `_COL` nodes become 2D colliders.
   */
  const dropAsset = useCallback(
    async (payload: AssetDragPayload, position: [number, number, number], parentId: string | null) => {
      const c = clientRef.current;
      const models = modelInstancesRef.current;
      if (!c || !models) return;
      const asset = c.content.getAsset(payload.assetId);
      if (asset === undefined || asset.kind !== 'model') return;
      setSelectedAssetId(payload.assetId);
      const resource = await models.prepared(payload.assetId);
      if (resource === null) {
        setPlacementError({ code: 'asset_unavailable', message: `${asset.displayName} could not be loaded` });
        return;
      }
      const box = (piece: string | null): PieceFacts['bounds'] => {
        const b = resource.bounds(piece);
        return b.isEmpty() ? null : { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
      };
      // In a 3D project a `_COL` node becomes a triangle-mesh collider (exact static geometry),
      // or a convex hull when it is too big for a mesh; the 2D plane keeps its outline polygon.
      const threeD = (clientRef.current?.getSettings() ?? {})['physics_dimension'] === 3;
      const collider3D = (piece: string | null): PieceFacts['collider'] => {
        for (const kind of ['mesh', 'convex'] as const) {
          const made = resource.collider3D(piece, kind);
          if (made.ok && made.source === 'collision') return { shape: made.shape };
          if (made.ok) return null;
        }
        return null;
      };
      const pieces: PieceFacts[] = resource.pieces().map((pc) => ({ name: pc.name, bounds: box(pc.name), collider: pc.hasCollider ? (threeD ? collider3D(pc.name) : resource.collider2D(pc.name)) : null, skinned: pc.skinned }));
      const { args } = planModelDrop({
        assetId: payload.assetId,
        displayName: asset.displayName,
        ...(payload.piece !== undefined ? { piece: payload.piece } : {}),
        pieces,
        wholeCollider: pieces.length === 1 ? (threeD ? collider3D(null) : resource.collider2D(null)) : null,
        position,
        parentId,
      });
      setPlacementError(null);
      const res = await c.command('createEntity', args, c.projection.revision);
      if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
      else if (!res.ok) setPlacementError({ code: (res.response as { code?: string }).code ?? 'command_failed', message: (res.response as { message?: string }).message ?? 'the model could not be placed' });
      reportFailure(`Place ${asset.displayName}`, res);
    },
    [reportFailure, setSelectedId],
  );

  // ---- Materials, their assignment, the environment ---------------
  const refusal = (res: Awaited<ReturnType<SessionClient['command']>>): string | null =>
    res.ok ? null : ((res.response as { message?: string; code?: string }).message ?? (res.response as { code?: string }).code ?? 'the edit was refused');
  // Edits made on `base` (what the panel showed) are re-applied onto the
  // document as it is at send time, so a quick second edit keeps the first (own-commands.ts).
  const saveMaterial = useCallback(async (material: MaterialDef, base: MaterialDef | null) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { material: MaterialDef } => ({ material: mergeDocumentEdit(base, material, c.getMaterials().find((m) => m.materialId === material.materialId) ?? null) ?? material });
    setMaterialError(refusal(await c.command('setMaterial', build, c.projection.revision)));
  }, []);
  const deleteMaterial = useCallback(async (materialId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const err = refusal(await c.command('deleteMaterial', { materialId }, c.projection.revision));
    setMaterialError(err);
    if (err === null) setSelectedMaterialId(null);
  }, []);
  const activeScene = sceneHeaders?.find((h) => h.active) ?? null;
  const bakePreview = useCallback(async () => {
    const c = clientRef.current;
    const v = viewportRef.current;
    if (!c || !v || activeScene === null) return;
    if (v.getLighting() !== 'game') v.setLighting('game');
    const abort = new AbortController();
    bakeAbortRef.current = abort;
    setBakeMessage(null);
    setBakeBusy({ text: 'preparing…', fraction: 0 });
    const r = await runBrowserBake({
      client: c,
      viewport: v,
      sceneId: activeScene.sceneId,
      sceneName: activeScene.name,
      settings: bakeSettings,
      onProgress: (text, fraction) => setBakeBusy({ text, fraction }),
      signal: abort.signal,
    });
    bakeAbortRef.current = null;
    setBakeBusy(null);
    if (!r.ok) setBakeMessage(`Bake failed: ${r.message}`);
    else {
      setBakeMessage(`Baked ${r.bake.entries.length} objects in ${(r.millis / 1000).toFixed(1)} s${r.where === 'worker' ? ' (in a worker)' : ''}${r.skipped.length > 0 ? `; ${r.skipped.length} static object(s) have no lightmap UV (UV1) and only cast shadows` : ''}.`);
      await c.fullResync();
      refreshEntities();
    }
  }, [activeScene, bakeSettings, refreshEntities]);
  const bakeFinal = useCallback(async () => {
    const c = clientRef.current;
    const v = viewportRef.current;
    if (!c || !v || activeScene === null) return;
    const abort = new AbortController();
    bakeAbortRef.current = abort;
    setBakeMessage(null);
    setBakeBusy({ text: 'preparing…', fraction: 0 });
    const r = await runBlenderBake({
      client: c,
      viewport: v,
      sceneId: activeScene.sceneId,
      sceneName: activeScene.name,
      settings: bakeSettings,
      onProgress: (text, fraction) => setBakeBusy({ text, fraction }),
      signal: abort.signal,
    });
    bakeAbortRef.current = null;
    setBakeBusy(null);
    if (!r.ok) setBakeMessage(`Final bake failed: ${r.message}`);
    else {
      setBakeMessage(
        `Final bake of ${r.bake.entries.length} objects done in ${(r.millis / 1000).toFixed(0)} s${r.device !== undefined ? ` (${r.device})` : ''}${r.skipped.length > 0 ? `; ${r.skipped.length} static object(s) have no lightmap UV (UV1) and only cast shadows` : ''}.`,
      );
      await c.fullResync();
      refreshEntities();
    }
  }, [activeScene, bakeSettings, refreshEntities]);
  const clearBake = useCallback(async () => {
    const c = clientRef.current;
    if (!c || activeScene === null) return;
    const err = refusal(await c.command('setLighting', { sceneId: activeScene.sceneId, lighting: null }, c.projection.revision));
    setBakeMessage(err === null ? 'The bake was cleared.' : `Clear failed: ${err}`);
  }, [activeScene]);
  useEffect(() => {
    if (bottomTab !== 'lighting') return;
    const c = clientRef.current;
    if (!c) return;
    void c.bakeHostStatus().then((st) => setBakeHost(st.ok ? null : st.message));
  }, [bottomTab]);
  const saveInput = useCallback(async (input: InputConfig | null) => {
    const c = clientRef.current;
    if (!c) return;
    setInputError(refusal(await c.command('setInput', { input }, c.projection.revision)));
  }, []);
  // Dialogue commands (one undo step each).
  const dialogueCommand = useCallback(async (op: 'setDialogue' | 'deleteDialogue' | 'setSpeaker' | 'deleteSpeaker' | 'setDialogueSettings', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setDialogueError(err);
    return err === null;
  }, []);
  // Effect commands (one undo step each).
  const effectCommand = useCallback(async (op: 'setEffect' | 'deleteEffect' | 'renameEffect', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setEffectError(err);
    return err === null;
  }, []);
  // Timeline commands (one undo step each; a key drag is one setTimeline).
  const timelineCommand = useCallback(async (op: 'setTimeline' | 'deleteTimeline', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setTimelineError(err);
    return err === null;
  }, []);
  // The timeline tab's scrub preview in the Scene view.
  const onTimelinePreview = useCallback((p: TimelinePreviewValue | null) => {
    viewportRef.current?.setTimelinePreview(p);
  }, []);
  // UI document/theme commands go out one at a time (each after the previous is applied
  // here), so a queued edit is always made on the latest stored value. Resolves with a refusal or null.
  const uiQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const uiCommand = useCallback((op: 'setUiDocument' | 'deleteUiDocument' | 'setUiTheme' | 'deleteUiTheme', args: Record<string, unknown>): Promise<string | null> => {
    const run = async (): Promise<string | null> => {
      const c = clientRef.current;
      if (!c) return 'not connected';
      const res = await c.command(op, args, c.projection.revision);
      if (res.ok) {
        for (let i = 0; i < 150 && c.projection.revision < res.revision; i++) await new Promise((r) => setTimeout(r, 20));
      }
      return refusal(res);
    };
    const next = uiQueueRef.current.then(run, run);
    uiQueueRef.current = next;
    return next;
  }, []);
  const createUiDocument = useCallback(
    async (name: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const uiDocumentId = uniqueDocId(name, c.getUiDocuments().map((d) => d.uiDocumentId), 'ui');
      const err = await uiCommand('setUiDocument', { document: newUiDocument(uiDocumentId, name) });
      setUiError(err);
      if (err === null) workspaceDispatch({ type: 'open', doc: { kind: 'ui-document', id: uiDocumentId } });
    },
    [uiCommand, workspaceDispatch],
  );
  const saveAnimator = useCallback(async (controller: AnimatorController) => {
    const c = clientRef.current;
    if (!c) return;
    setAnimatorError(refusal(await c.command('setAnimator', { controller }, c.projection.revision)));
  }, []);
  // Graph edits go out one at a time (each after the previous is
  // applied here), so a burst of gestures never races its own revision.
  const sendGraphEdit = useCallback((owner: { kind: string; id: string }, ops: GraphOp[]): Promise<string | null> => {
    const run = async (): Promise<string | null> => {
      const c = clientRef.current;
      if (!c) return 'not connected';
      const res = await c.command('graphEdit', { owner, ops }, c.projection.revision);
      if (res.ok) {
        for (let i = 0; i < 100 && c.projection.revision < res.revision; i++) await new Promise((r) => setTimeout(r, 20));
      }
      return refusal(res);
    };
    const p = graphQueueRef.current.then(run, run);
    graphQueueRef.current = p;
    return p;
  }, []);
  const graphDocCommand = useCallback(async (op: 'setGraph' | 'deleteGraph', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setGraphsError(err);
    return err === null;
  }, []);
  const showGraph = useCallback(
    (graphId: string, focusId?: string) => {
      workspaceDispatch({ type: 'open', doc: { kind: 'graph', id: graphId } });
      if (focusId !== undefined) setGraphFocus({ id: focusId, nonce: Date.now() });
    },
    [workspaceDispatch],
  );
  const deleteAnimator = useCallback(async (controllerId: string) => {
    const c = clientRef.current;
    if (!c) return;
    setAnimatorError(refusal(await c.command('deleteAnimator', { controllerId }, c.projection.revision)));
  }, []);
  const clipsOf = useCallback(async (assetId: string) => {
    const r = await modelInstancesRef.current?.prepared(assetId);
    return (r?.clips ?? []).map((x) => ({ name: x.name, duration: x.durationSeconds }));
  }, []);
  // A model's skeleton (the Animator's bone mask picker).
  // The node names of the models socket targets carry (the Inspector's node list), read once per version.
  const [modelNodeNames, setModelNodeNames] = useState<Readonly<Record<string, readonly string[] | 'failed'>>>({});
  const modelNodeLoads = useRef(new Set<string>());
  const modelNodesOf = useCallback(
    (assetId: string): readonly string[] | null | undefined => {
      const version = clientRef.current?.content.resolveVersion(assetId)?.version;
      if (version === undefined) return undefined;
      const key = `${assetId}@${version}`;
      const have = modelNodeNames[key];
      if (have === 'failed') return undefined;
      if (have !== undefined) return have;
      if (!modelNodeLoads.current.has(key)) {
        modelNodeLoads.current.add(key);
        void (modelInstancesRef.current?.nodeNames(assetId) ?? Promise.resolve(null)).then((names) => setModelNodeNames((m) => ({ ...m, [key]: names ?? 'failed' })));
      }
      return null;
    },
    [modelNodeNames],
  );
  const skeletonOf = useCallback(async (assetId: string) => {
    const r = await modelInstancesRef.current?.prepared(assetId);
    return r === null || r === undefined ? [] : r.skeleton().map((b) => ({ name: b.name, parent: b.parent, depth: b.depth }));
  }, []);
  // Mark an animation-only file as clips for another model's rig (null clears it).
  const setAssetClipsFor = useCallback(async (assetId: string, rig: string | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Clips for rig', await c.command('setAssetOptions', { assetId, clipsFor: rig }, c.projection.revision));
  }, [reportFailure]);
  /** The animated bones of `clipAssetId`'s clips that the rig `rigAssetId` does not have. */
  const missingBones = useCallback(async (clipAssetId: string, rigAssetId: string): Promise<string[] | null> => {
    const m = modelInstancesRef.current;
    if (!m) return null;
    const [clipsRes, rigRes] = await Promise.all([m.prepared(clipAssetId), m.prepared(rigAssetId)]);
    if (clipsRes === null || rigRes === null) return null;
    const have = new Set(rigRes.skeleton().map((b) => b.name));
    const wanted = new Set<string>();
    for (const clip of clipsRes.animationClips()) {
      for (const t of clip.tracks) {
        try {
          wanted.add(THREE.PropertyBinding.parseTrackName(t.name).nodeName);
        } catch {
          /* an unparsable track binds nothing */
        }
      }
    }
    return [...wanted].filter((n) => n !== '' && !have.has(n)).sort();
  }, []);
  const saveEnvironment = useCallback(async (env: EnvironmentConfig, base: EnvironmentConfig | null) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { environment: EnvironmentConfig } => ({ environment: mergeDocumentEdit(base, env, c.getEnvironment()) ?? env });
    setMaterialError(refusal(await c.command('setEnvironment', build, c.projection.revision)));
  }, []);
  const setEntityMaterials = useCallback(async (entityId: string, mapping: Record<string, string> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Materials', await c.setComponent(entityId, 'materials', mapping, c.projection.revision));
  }, [reportFailure]);
  // An object's overrides of its graph materials' public parameters (one setComponent, whole value).
  const setEntityMaterialParams = useCallback(async (entityId: string, next: Record<string, Record<string, number | number[] | string>> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Material parameters', await c.setComponent(entityId, 'materialParams', next, c.projection.revision));
  }, [reportFailure]);
  const assetOptions = useAssetOptions(clientRef, reportFailure);
  const loadingNames = useLoadingNames(clientRef);

  // Delete an asset / a prefab definition (the backend refuses while anything uses it; one undo restores).
  const deleteAsset = useCallback(async (assetId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('deleteAsset', { assetId }, c.projection.revision);
    const err = refusal(res);
    setAssetDeleteError(err);
    if (err === null) setSelectedAssetId((cur) => (cur === assetId ? null : cur));
  }, []);
  const deletePrefab = useCallback(async (prefabId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const err = refusal(await c.command('deletePrefab', { prefabId }, c.projection.revision));
    setPrefabDeleteError(err);
    if (err === null) setSelectedPrefabId((cur) => (cur === prefabId ? null : cur));
  }, []);

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
  }, [captureName, runTypedCommand]);

  const overrideTargets = useMemo(() => {
    const c = clientRef.current;
    if (!c || !selectedPrefabId) return [];
    const definition = c.prefabs.getDefinition(selectedPrefabId);
    if (!definition) return [];
    return deriveOverrideTargets(definition, declarations);
  }, [selectedPrefabId, declarations]);

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
    [overrideDrafts, runTypedCommand],
  );

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
    [runTypedCommand],
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
    [editComponent],
  );

  /**
   * A 3D project: a collider from the object's own model — a
   * box from its bounds (a convex hull of the corners when off-centre), a
   * convex hull or a triangle mesh from its `_COL` node(s), else its LOD0
   * geometry — in the object's frame (its scale applies in physics).
   */
  const colliderFromModel3D = useCallback(
    async (entityId: string, kind: 'box' | 'convex' | 'mesh') => {
      const model = clientRef.current?.projection.getEntity(entityId)?.components['model'] as { asset?: { assetId?: string }; piece?: string } | undefined;
      const assetId = model?.asset?.assetId;
      const resource = assetId !== undefined ? await modelInstancesRef.current?.prepared(assetId) : null;
      if (resource === null || resource === undefined) {
        setComponentError({ code: 'no_model', message: 'A 3D collider from the model needs a loaded model on this object.' });
        return;
      }
      const piece = model?.piece ?? null;
      let shape: Record<string, unknown>;
      let note: string | undefined;
      if (kind === 'box') {
        const b = resource.bounds(piece);
        const made = boxFromBounds3D(b.isEmpty() ? null : { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] });
        if (!made.ok) return setComponentError({ code: 'no_outline', message: made.message });
        shape = made.shape;
        note = made.note;
      } else {
        const made = resource.collider3D(piece, kind);
        if (!made.ok) return setComponentError({ code: 'no_outline', message: made.message });
        shape = made.shape;
        note = made.source === 'collision' ? `${kind === 'mesh' ? 'mesh' : 'convex hull'} from the model's collision node` : `${kind === 'mesh' ? 'mesh' : 'convex hull'} from the model's geometry (no _COL node)`;
      }
      if (note !== undefined) setNotice(`Collider: ${note}`);
      const has = clientRef.current?.projection.getEntity(entityId)?.components['collider'] !== undefined;
      if (has) await editComponent(entityId, 'collider', { shape });
      else await addComponentTo(entityId, 'collider', { shape });
    },
    [editComponent, addComponentTo],
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
    [editComponent, addComponentTo, registry],
  );

  /** Read the index again (lists and pickers read their pages again). */
  const refreshAssets = useCallback(() => {
    clientRef.current?.catalog.invalidate();
  }, []);

  // ---- Behavior publication workflow ----------------------------

  const stageBehaviorSource = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setBehaviorError(null);
    const bytes = new TextEncoder().encode(sourceDraft);
    try {
      JSON.parse(sourceDraft);
    } catch (e) {
      setPublication((s) =>
        publicationFailed(s, {
          code: 'behavior_source_invalid',
          message: `staged source is not JSON: ${String((e as Error).message).slice(0, 200)}`,
        }),
      );
      return;
    }
    const staged = await c.stageBehaviorSource(bytes);
    if (!staged.ok) {
      setPublication((s) => publicationFailed(s, staged.error));
      return;
    }
    setPublication((s) => sourceStaged(s, staged));
  }, [sourceDraft]);

  const acknowledgeDigest = useCallback(
    async (sourceDigest: string) => {
      const c = clientRef.current;
      if (!c) return;
      setBehaviorError(null);
      const res = await c.acknowledgeBehaviorTrust(sourceDigest, c.projection.revision);
      if (!res.ok) {
        const r = res.response;
        setPublication((s) =>
          publicationFailed(s, r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code }),
        );
        return;
      }
      // Optimistic convergence: the authoritative record arrives with the same
      // command's `mutation.applied` change; the observed set is also used.
      setPublication((s) => trustObserved(s, [...c.prefabs.listTrust(), { sourceDigest, acknowledgedRevision: res.revision }]));
      refreshEntities();
    },
    [refreshEntities],
  );

  const publishStagedSource = useCallback(async () => {
    const c = clientRef.current;
    const view = behaviorViews.find((b) => b.behaviorId === selectedBehaviorId);
    const staged = publication.staged;
    if (!c || !view || !staged) return;
    setBehaviorError(null);
    const res = await c.publishBehaviorSource(
      {
        behaviorId: view.behaviorId,
        displayName: view.displayName,
        declaration: view.declaration,
        sourceDigest: staged.digest,
        sourceByteLength: staged.byteLength,
        stageId: staged.stageId,
      },
      c.projection.revision,
    );
    if (!res.ok) {
      const r = res.response;
      setPublication((s) =>
        publicationFailed(s, r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code }),
      );
      return;
    }
    setPublication((s) => published(s, { revision: res.revision }));
    refreshEntities();
  }, [behaviorViews, selectedBehaviorId, publication, refreshEntities]);

  // ---- The script editor tab ------------------------------------

  /** Unpublished script edits per behavior (survive tab switches; not project data). */
  const scriptDrafts = useRef(new Map<string, ScriptDraft>()).current;

  const checkScript = useCallback(async (behaviorId: string, bytes: Uint8Array, declaration: PropertyDeclaration | null): Promise<ScriptCheckResult> => {
    const c = clientRef.current;
    if (!c) return { ok: false, error: { code: 'disconnected', message: 'not connected' } };
    return c.checkBehaviorSource(behaviorId, bytes, declaration);
  }, []);

  /**
   * Publish a script: stage the container, then — when its digest is not
   * acknowledged yet — ask first (`needs-ack`) or acknowledge it (the
   * ordinary `acknowledgeBehaviorTrust` command), then the ordinary source
   * route (compile + one `publishBehavior` command).
   */
  const publishScript = useCallback(
    async (behaviorId: string, bytes: Uint8Array, acknowledge: boolean): Promise<ScriptPublishOutcome> => {
      const c = clientRef.current;
      const view = behaviorViews.find((b) => b.behaviorId === behaviorId);
      if (!c || !view) return { kind: 'failed', message: 'the behavior is not available' };
      const out = await publishScriptSource(c, view, bytes, acknowledge, (digest, revision) => setPublication((s) => trustObserved(s, [...c.prefabs.listTrust(), { sourceDigest: digest, acknowledgedRevision: revision }])));
      if (out.kind === 'published') refreshEntities();
      return out;
    },
    [behaviorViews, refreshEntities],
  );

  // ---- Shared script libraries --------------------------------------

  /** Unsaved library edits per library (survive tab switches; not project data). */
  const libraryDrafts = useRef(new Map<string, LibraryDraft>()).current;
  /** The published scripts that import a library (their source pins it). */
  const libraryDependents = useCallback((libraryId: string): string[] => behaviorViews.filter((b) => b.source?.libraries?.some((p) => p.libraryId === libraryId) === true).map((b) => b.behaviorId), [behaviorViews]);
  const libraryCommand = useCallback(async (op: 'setScriptLibrary' | 'deleteScriptLibrary', args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const err = refusal(await c.command(op, args, c.projection.revision));
    setLibraryError(err);
    return err === null;
  }, []);
  /**
   * Save a library's changed files: one setScriptLibrary command (the backend
   * recompiles the scripts that import it in the same command). A library
   * digest those scripts would link that is not acknowledged yet asks first
   * (`needs-ack`) or is acknowledged (the ordinary acknowledgeBehaviorTrust
   * command) and the save retried.
   */
  /**
   * Stage these patches (several requests, nothing changes yet)
   * and commit them as one change: one revision, one undo, each script that
   * imports a changed library compiled once. A digest those scripts will
   * link that is not acknowledged yet asks first (the stage is dropped and
   * made again on the acknowledged retry).
   */
  const commitLibraryPatches = useCallback(
    async (patches: readonly LibraryStagePatch[], acknowledge: boolean): Promise<LibrarySaveOutcome> => {
      const c = clientRef.current;
      if (!c) return { kind: 'failed', message: 'not connected' };
      let stageId: string | undefined;
      for (const patch of patches) {
        const r = await c.stageScriptLibrary({ ...(stageId !== undefined ? { stageId } : {}), libraryId: patch.libraryId, files: patch.files });
        if (!r.ok) {
          if (stageId !== undefined) await c.stageScriptLibrary({ stageId, discard: true });
          return { kind: 'failed', message: `${r.error.code}: ${r.error.message}` };
        }
        stageId = r.stageId;
      }
      if (stageId === undefined) return { kind: 'failed', message: 'nothing to save' };
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await c.command('commitScriptLibraryStage', { stageId }, c.projection.revision);
        if (res.ok) {
          refreshEntities();
          return { kind: 'saved', revision: res.revision, recompiled: (res.libraryStage?.dependents ?? []).map((d) => d.behaviorId), patches: patches.length };
        }
        const r = res.response;
        if (!r.ok && r.code === 'behavior_trust_unacknowledged' && r.sourceDigest !== undefined) {
          if (!acknowledge) {
            await c.stageScriptLibrary({ stageId, discard: true });
            return { kind: 'needs-ack', digest: r.sourceDigest };
          }
          const digest = r.sourceDigest;
          const ack = await c.acknowledgeBehaviorTrust(digest, c.projection.revision);
          if (!ack.ok) {
            const a = ack.response;
            return { kind: 'failed', message: a.ok ? 'the acknowledgment was not recorded' : `${a.code}: ${a.message ?? a.code}` };
          }
          setPublication((st) => trustObserved(st, [...c.prefabs.listTrust(), { sourceDigest: digest, acknowledgedRevision: ack.revision }]));
          continue;
        }
        await c.stageScriptLibrary({ stageId, discard: true });
        return r.ok ? { kind: 'failed', message: 'the libraries were not saved' } : { kind: 'failed', message: `${r.code}: ${r.message ?? r.code}`, ...(r.diagnostics !== undefined ? { diagnostics: r.diagnostics } : {}) };
      }
      await c.stageScriptLibrary({ stageId, discard: true });
      return { kind: 'failed', message: 'the libraries were not saved (trust acknowledgments kept changing)' };
    },
    [refreshEntities],
  );

  const saveLibrary = useCallback(
    async (libraryId: string, files: { path: string; text: string | null }[], acknowledge: boolean): Promise<LibrarySaveOutcome> => {
      const c = clientRef.current;
      if (!c) return { kind: 'failed', message: 'not connected' };
      // A change larger than one request goes in several staged patches, committed once.
      if (!fitsOneRequest(files)) return commitLibraryPatches(libraryStagePatches(libraryId, files), acknowledge);
      const recompiled = libraryDependents(libraryId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await c.command('setScriptLibrary', { libraryId, files }, c.projection.revision);
        if (res.ok) {
          refreshEntities();
          return { kind: 'saved', revision: res.revision, recompiled };
        }
        const r = res.response;
        if (r.ok) return { kind: 'failed', message: 'the library was not saved' };
        if (r.code === 'behavior_trust_unacknowledged' && r.sourceDigest !== undefined) {
          if (!acknowledge) return { kind: 'needs-ack', digest: r.sourceDigest };
          const digest = r.sourceDigest;
          const ack = await c.acknowledgeBehaviorTrust(digest, c.projection.revision);
          if (!ack.ok) {
            const a = ack.response;
            return { kind: 'failed', message: a.ok ? 'the acknowledgment was not recorded' : `${a.code}: ${a.message ?? a.code}` };
          }
          setPublication((st) => trustObserved(st, [...c.prefabs.listTrust(), { sourceDigest: digest, acknowledgedRevision: ack.revision }]));
          continue;
        }
        return { kind: 'failed', message: `${r.code}: ${r.message ?? r.code}`, ...(r.diagnostics !== undefined ? { diagnostics: r.diagnostics } : {}) };
      }
      return { kind: 'failed', message: 'the library was not saved (trust acknowledgments kept changing)' };
    },
    [libraryDependents, refreshEntities, commitLibraryPatches],
  );

  /** A source position to show in a script or library tab (the Console's locations). */
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
  /** Bumped when a library draft becomes dirty or clean (the Libraries panel's "Save all"). */
  const [libraryDraftsVersion, setLibraryDraftsVersion] = useState(0);
  const onLibraryDraftChange = useCallback(() => setLibraryDraftsVersion((v) => v + 1), []);
  const [saveAllOutcome, setSaveAllOutcome] = useState<LibrarySaveOutcome | { kind: 'working' } | null>(null);
  /** The libraries with unsaved edits (their drafts differ from the stored files). */
  const dirtyLibraries = useMemo(
    () => scriptLibraries.filter((l) => libraryDrafts.get(l.libraryId)?.dirty === true).map((l) => l.libraryId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- libraryDrafts is a mutable map; libraryDraftsVersion signals its changes
    [scriptLibraries, libraryDraftsVersion],
  );
  /**
   * "Save all" — every library with unsaved edits staged in one
   * stage (several patches) and committed once: one revision, one undo, the
   * scripts that import any of them compiled once each.
   */
  const saveAllLibraries = useCallback(
    async (acknowledge: boolean): Promise<void> => {
      const patches: LibraryStagePatch[] = [];
      const saved: { libraryId: string; draft: LibraryDraft }[] = [];
      for (const lib of scriptLibraries) {
        const draft = libraryDrafts.get(lib.libraryId);
        if (draft?.dirty !== true) continue;
        const files = libraryFilePatch(lib.files, draft.files);
        if (files.length === 0) continue;
        patches.push(...libraryStagePatches(lib.libraryId, files));
        saved.push({ libraryId: lib.libraryId, draft });
      }
      if (patches.length === 0) return;
      setSaveAllOutcome({ kind: 'working' });
      const r = await commitLibraryPatches(patches, acknowledge);
      if (r.kind === 'saved') {
        for (const x of saved) libraryDrafts.set(x.libraryId, savedDraft(x.draft));
        setLibraryDraftsVersion((v) => v + 1);
      }
      setSaveAllOutcome(r);
    },
    [scriptLibraries, libraryDrafts, commitLibraryPatches],
  );

  /** The declaration editor's save — one ordinary publishBehavior command. */
  const saveDeclaration = useCallback(
    async (save: DeclarationSave): Promise<boolean> => {
      const c = clientRef.current;
      if (!c) return false;
      setBehaviorError(null);
      const res = await c.publishBehaviorDeclaration(save, c.projection.revision);
      if (!res.ok) {
        const r = res.response;
        setBehaviorError(r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code });
        return false;
      }
      setSelectedBehaviorId(save.behaviorId);
      refreshEntities();
      return true;
    },
    [refreshEntities],
  );

  // ---- Visual scripts ------------------------------------------------

  const checkVisualScript = useCallback(async (behaviorId: string): Promise<VisualScriptCheckResult> => {
    const c = clientRef.current;
    if (!c) return { ok: false, error: { code: 'disconnected', message: 'not connected' } };
    return c.checkBehaviorGraph(behaviorId);
  }, []);

  /**
   * Publish a visual script: compile the stored graph (its digest), ask for
   * or record the trust acknowledgment of a new digest, then the source route
   * with `graph: true` (the backend generates the same bytes and runs one
   * publishBehavior command).
   */
  const publishVisualScript = useCallback(
    async (behaviorId: string, acknowledge: boolean): Promise<ScriptPublishOutcome> => {
      const c = clientRef.current;
      const view = behaviorViews.find((b) => b.behaviorId === behaviorId);
      if (!c || !view) return { kind: 'failed', message: 'the behavior is not available' };
      const checked = await c.checkBehaviorGraph(behaviorId);
      if (!checked.ok) return { kind: 'failed', message: `${checked.error.code}: ${checked.error.message}` };
      if (!checked.compiled) return { kind: 'failed', message: checked.diagnostics[0]?.message ?? checked.code };
      let revision = c.projection.revision;
      if (!c.acknowledgedDigests().includes(checked.sourceDigest)) {
        if (!acknowledge) return { kind: 'needs-ack', digest: checked.sourceDigest };
        const ack = await c.acknowledgeBehaviorTrust(checked.sourceDigest, revision);
        if (!ack.ok) {
          const r = ack.response;
          return { kind: 'failed', message: r.ok ? 'the acknowledgment was not recorded' : `${r.code}: ${r.message ?? r.code}` };
        }
        revision = ack.revision;
        setPublication((st) => trustObserved(st, [...c.prefabs.listTrust(), { sourceDigest: checked.sourceDigest, acknowledgedRevision: ack.revision }]));
      }
      const res = await c.publishBehaviorGraph(behaviorId, view.displayName, revision);
      if (!res.ok) {
        if (res.code === 'behavior_trust_unacknowledged' && res.sourceDigest !== undefined) return { kind: 'needs-ack', digest: res.sourceDigest };
        return { kind: 'failed', message: `${res.code}: ${res.message}` };
      }
      refreshEntities();
      return { kind: 'published', revision: res.revision, digest: res.sourceDigest };
    },
    [behaviorViews, refreshEntities],
  );

  /**
   * A new visual script: a behavior created with a graph holding one On start
   * node (no variable needed — a behavior may declare no
   * property). One publishBehavior command.
   */
  const createVisualScript = useCallback(
    async (displayName: string): Promise<void> => {
      const c = clientRef.current;
      if (!c) return;
      const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'visual-script';
      let behaviorId = base;
      for (let i = 2; behaviorViews.some((b) => b.behaviorId === behaviorId); i++) behaviorId = `${base}-${i}`;
      setBehaviorError(null);
      const template = newBehaviorGraph();
      const res = await c.command('publishBehavior', { behaviorId, displayName, mode: 'declaration-create', declaration: template.declaration, graph: template.graph }, c.projection.revision);
      const err = refusal(res);
      if (err !== null) {
        setBehaviorError({ code: 'refused', message: err });
        return;
      }
      for (let i = 0; i < 100 && c.projection.revision < (res as { revision: number }).revision; i++) await new Promise((r) => setTimeout(r, 20));
      refreshEntities();
      workspaceDispatch({ type: 'open', doc: { kind: 'visual-script', id: behaviorId } });
    },
    [behaviorViews, refreshEntities, workspaceDispatch],
  );

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

  // The material names of the selected object's model file / the selected asset.
  // (before the early returns below: hooks must run on every render)
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
  }, [selectedModelKey]);
  // The chosen asset (its summary, and a model's pieces and material names, loaded when it is chosen).
  const selectedAsset = useSelectedAsset(clientRef, modelInstancesRef, selectedAssetId, catalogTick);
  const assetSourceMaterials = selectedAsset.sourceMaterials;

  // A script tab in front selects its behavior (the source
  // stage/acknowledge/publish flow acts on the selected behavior).
  const activeScript = (() => {
    const d = activeDoc(workspace);
    return d !== null && d.kind === 'script' ? d.id : null;
  })();
  useEffect(() => {
    if (activeScript !== null) setSelectedBehaviorId(activeScript);
  }, [activeScript]);

  // The Animator and Behaviors panels: the bottom dock and the centre document tabs share these.
  const openDocument = (kind: string, id: string): void => workspaceDispatch({ type: 'open', doc: { kind, id } });
  /** A script or library position (from the Console) opened in its code editor tab at the line. */
  const openSource = (loc: SourceLocation): void => {
    const id = loc.libraryId ?? loc.behaviorId;
    if (id === undefined) return;
    openDocument(loc.libraryId !== undefined ? 'script-library' : 'script', id);
    setSourceFocus({ id, path: loc.path, line: loc.line, column: loc.column, nonce: Date.now() });
  };
  const animatorProps: AnimatorPanelProps = {
    controllers: animators,
    clipsOf,
    skeletonOf,
    preview: previewAnimator,
    onSave: (controller) => void saveAnimator(controller),
    onDelete: (id) => void deleteAnimator(id),
    onOpen: (id) => openDocument('animator', id),
    error: animatorError,
  };
  const behaviorProps: BehaviorPanelProps = {
    behaviors: behaviorViews,
    selectedBehaviorId,
    publication,
    sourceDraft,
    activePlay: playInfo ? { snapshotId: playInfo.snapshotId, revision: playInfo.revision } : null,
    error: behaviorError,
    onSelect: (id) => {
      setSelectedBehaviorId(id);
      setBehaviorError(null);
    },
    onSourceDraft: setSourceDraft,
    onStage: () => void stageBehaviorSource(),
    onAcknowledge: (digest) => void acknowledgeDigest(digest),
    onPublishSource: () => void publishStagedSource(),
    onSaveDeclaration: saveDeclaration,
    // A visual script opens as a Graph tab, any other behavior as a Script tab.
    onOpen: (id) => openDocument(behaviorViews.find((b) => b.behaviorId === id)?.graph !== undefined ? 'visual-script' : 'script', id),
    onCreateVisualScript: (name) => void createVisualScript(name),
  };
  const animatorGraphEdit = (ownerId: string, ops: GraphOp[]): Promise<string | null> => sendGraphEdit({ kind: 'animator', id: ownerId }, ops);
  const activeVisual = activeVisualId !== null ? (behaviorViews.find((b) => b.behaviorId === activeVisualId) ?? null) : null;
  const workspaceHost: WorkspaceHost = {
    animator: animatorProps,
    animatorDocument: (controllerId) => ({
      controllerId,
      controllers: animators,
      clipsOf,
      skeletonOf,
      preview: previewAnimator,
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
      // The live preview (the project environment, its models, the editor's texture bytes).
      environment: environment as unknown as MaterialDocumentProps['environment'],
      loadTexture: (assetId) => loadTextureRef.current?.(assetId) ?? Promise.resolve(null),
      loadModel: async (assetId) => {
        const r = await modelInstancesRef.current?.prepared(assetId);
        const made = r?.createInstance();
        if (made === undefined || !made.ok) return null;
        return { root: made.instance.root, dispose: () => void made.instance.dispose() };
      },
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
      onRename: (effectId, name) => void effectCommand('renameEffect', { effectId, name }),
      onSelection: setEffectSelection,
      focus: effectFocus,
      error: effectError,
      // The preview pane (the project environment, the editor's texture bytes, its models).
      environment: environment as unknown as EffectDocumentProps['environment'],
      loadTexture: (assetId) => loadTextureRef.current?.(assetId) ?? Promise.resolve(null),
      loadModel: async (assetId) => {
        const r = await modelInstancesRef.current?.prepared(assetId);
        const made = r?.createInstance();
        return made !== undefined && made.ok ? made.instance.root : null;
      },
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
      onRename: (dialogueId, name) => void dialogueCommand('setDialogue', { dialogue: { dialogueId, name } }),
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
        mockStorageKey: `thirdlight.uimock.v1.${cfg.current.ok ? cfg.current.config.projectId : ''}`,
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
  };

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
      // A socket's node list comes from its target's model.
      modelNodes: (entityId: string) => {
        const e = allEntitiesMemo.find((x) => x.id === entityId);
        const assetId = (e?.components as { model?: { asset?: { assetId?: unknown } } } | undefined)?.model?.asset?.assetId;
        return typeof assetId === 'string' ? modelNodesOf(assetId) : undefined;
      },
    }),
    [allEntitiesMemo, projectScenes, materials, animators, behaviorViews, prefabSummaries, effects, registry, settings, modelNodesOf, behaviorGroups, modes],
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
  /** What the Inspector's pickers offer. */
  const allEntities = allEntitiesMemo;
  const fieldContext: FieldContext = fieldContextMemo;
  // The game block's pickers name objects in any scene.
  const { sceneId: _selectedScene, ...gameFieldContext } = fieldContext;
  // The play loads from its own content locator on the preview origin.
  // The editor page's ?renderer= flag is passed on to the play page (and ?batching=off; and ?threads=).
  const previewSrc =
    playInfo?.playBase && playInfo.contentId !== null && playInfo.contentPath !== null
      ? `${playInfo.playBase.replace(/\/$/, '')}${playInfo.contentPath}?play=${playInfo.playSessionId}&content=${playInfo.contentId}${urlRenderer.current !== null ? `&${RENDERER_URL_PARAM}=${urlRenderer.current}` : ''}${batchingFromUrl(pageSearch()) ? '' : `&${BATCHING_URL_PARAM}=off`}${urlThreads.current !== null ? `&threads=${urlThreads.current}` : ''}`
      : null;

  const v4Reason = 'gameplay components need a v4 project (scenes)';
  const hasCamera = entities.some((e) => e.kind === 'camera');
  // The scene allows one directional and one ambient light.
  const hasDirectional = entities.some((e) => e.light?.type === 'directional');
  const hasAmbient = entities.some((e) => e.light?.type === 'ambient');
  const lightReason = (type: string) => `the scene already has its ${type} light (one per scene)`;
  const selComponents = selectedComponents;
  const noSelection = selectedId === null;
  const need = 'select an entity in the hierarchy first';
  // A folder carries no components.
  const noComponentTarget = noSelection || selected?.kind === 'folder';
  const needObject = noSelection ? need : 'a folder has no components';
  /**
   * The GameObject menu's create entries come from the component
   * descriptors (`create`): top-level items, and one submenu per `menu` name
   * (an existing submenu of that name, such as Light, takes its entries).
   */
  const createMenu = ((): { top: MenuEntry[]; into: Map<string, MenuEntry[]> } => {
    const into = new Map<string, MenuEntry[]>();
    const top: MenuEntry[] = [];
    if (registry === null) return { top, into };
    const scenesAll = [...(sceneHeaders ?? []), ...closedScenes];
    const other = scenesAll.find((sc) => sc.sceneId !== (sceneHeaders?.find((h) => h.active)?.sceneId ?? null))?.sceneId ?? null;
    const own = new Set(['Light']);
    const order: string[] = [];
    for (const entry of createEntries(registry, { dimension: settings?.['physics_dimension'] === 3 ? 3 : 2 })) {
      const needsScene = entry.otherScene.length > 0;
      const reason = sceneHeaders === null ? v4Reason : needsScene && (scenesAll.length < 2 || other === null) ? 'it moves the character to another scene: the project needs a second scene' : null;
      const item: MenuItem = {
        label: entry.label,
        disabled: reason !== null,
        reason: reason ?? '',
        onSelect: () => void createEntityAt(`Create ${entry.label.toLowerCase()}`, needsScene && other !== null ? withOtherScene(entry, other) : entry.args),
      };
      if (entry.menu === null) {
        top.push(item);
        continue;
      }
      if (!into.has(entry.menu)) {
        into.set(entry.menu, []);
        if (!own.has(entry.menu)) order.push(entry.menu);
      }
      into.get(entry.menu)!.push(item);
    }
    for (const m of order) top.push({ label: m, items: into.get(m)! });
    return { top: top.length > 0 ? ['separator', ...top] : top, into };
  })();
  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New project…', onSelect: () => { window.location.search = ''; } },
        { label: 'Open project…', onSelect: () => { window.location.search = ''; } },
        'separator',
        { label: 'Export game…', onSelect: () => { setExportState({ busy: false, result: null, error: null }); setDialog('export'); } },
        'separator',
        { label: 'Project settings', onSelect: () => setBottomTab('gameplay') },
        { label: 'Project tags', onSelect: () => setBottomTab('tags') },
        { label: 'Reload from disk', onSelect: () => resync() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', disabled: ui.undoDepth === 0, reason: 'nothing to undo', onSelect: () => void undo() },
        { label: 'Redo', shortcut: 'Ctrl+Y', disabled: ui.redoDepth === 0, reason: 'nothing to redo', onSelect: () => void redo() },
        'separator',
        { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: noSelection, reason: need, onSelect: () => void duplicate() },
        { label: 'Copy', shortcut: 'Ctrl+C', disabled: noSelection, reason: need, onSelect: () => void copySelection() },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: clipboardRef.current === null, reason: 'copy something first', onSelect: () => void paste() },
        { label: 'Delete', shortcut: 'Del', disabled: noSelection, reason: need, onSelect: () => void del() },
        'separator',
        { label: `Snapping: ${snapping ? 'on' : 'off'}`, onSelect: () => setSnapping((v) => !v) },
        { label: 'Snapping settings…', onSelect: () => { setSnapDraft({ translateM: String(snapSettings.translateM), rotateDeg: String(snapSettings.rotateDeg), scale: String(snapSettings.scale), cellTops: snapSettings.cellTops }); setDialog('snapping'); } },
      ],
    },
    {
      label: 'GameObject',
      items: [
        { label: 'Folder', onSelect: () => void createFolder() },
        { label: 'Create empty', onSelect: () => void createEmpty() },
        { label: 'Box', onSelect: () => void newBox() },
        { label: 'Camera', disabled: hasCamera, reason: 'the scene already has its camera (one per scene)', onSelect: () => void createCamera() },
        { label: 'Light', items: [
          { label: 'Directional light', disabled: hasDirectional, reason: lightReason('directional'), onSelect: () => void createLight('directional') },
          { label: 'Ambient light', disabled: hasAmbient, reason: lightReason('ambient'), onSelect: () => void createLight('ambient') },
          { label: 'Point light', onSelect: () => void createLight('point') },
          { label: 'Spot light', onSelect: () => void createLight('spot') },
          { label: 'Hemisphere light', disabled: entities.some((e) => e.light?.type === 'hemisphere'), reason: 'the scene already has a hemisphere light', onSelect: () => void createLight('hemisphere') },
          ...(createMenu.into.get('Light') ?? []),
        ] },
        // The create entries of the component descriptors (a submenu of the same name gains its entries).
        ...createMenu.top,
        'separator',
        { label: 'Model from asset…', onSelect: () => setBottomTab('assets') },
        { label: 'Instance set…', onSelect: () => setDialog('instances') },
        { label: 'Prefab copy…', onSelect: () => setBottomTab('prefabs') },
      ],
    },
    {
      label: 'Component',
      // The same list as the Inspector's "+ Add component" (the descriptors):
      // one item per component, presets as a submenu, and why an item cannot be added.
      items: (() => {
        if (registry === null) return [{ label: 'Loading components…', disabled: true, reason: 'the component descriptions are not loaded yet', onSelect: () => undefined }];
        const entries = addEntries(registry, selComponents, { folder: selected?.kind === 'folder', dimension: settings?.['physics_dimension'] === 3 ? 3 : 2 });
        const out: MenuEntry[] = [];
        let category: string | null = null;
        for (const c of registry.components) {
          const mine = entries.filter((e) => e.component === c.name);
          if (mine.length === 0) continue;
          if (category !== null && category !== c.category) out.push('separator');
          category = c.category;
          const first = mine[0]!;
          const blocked = noComponentTarget ? needObject : first.reason;
          const pickReason = first.pick.length > 0 ? `choose its ${first.pick.map((p) => p.split('/').pop()).join(', ')} in the Inspector (+ Add component)` : null;
          const add = (value: unknown): void => {
            if (selectedId !== null) void addComponentTo(selectedId, c.name, value as Record<string, unknown>);
          };
          if (mine.length > 1) {
            const items: MenuEntry[] = mine.map((e) => ({ label: e.label.slice(c.label.length + 2), onSelect: () => add(e.value) }));
            // A collider from the model's outline.
            if (c.name === 'collider' && selectedId !== null) {
              const id = selectedId;
              // A 3D project makes 3D colliders from the model.
              if (settings?.['physics_dimension'] === 3) items.push({ label: 'Box from model', onSelect: () => void colliderFromModel3D(id, 'box') }, { label: 'Convex hull from model', onSelect: () => void colliderFromModel3D(id, 'convex') }, { label: 'Mesh from model', onSelect: () => void colliderFromModel3D(id, 'mesh') });
              else items.push({ label: 'Box from model', onSelect: () => void colliderFromModel(id, 'box') }, { label: 'Polygon from model outline', onSelect: () => void colliderFromModel(id, 'polygon') });
            }
            out.push({ label: c.label, disabled: blocked !== null, reason: blocked ?? '', items });
          } else {
            out.push({ label: c.label, disabled: blocked !== null || pickReason !== null, reason: blocked ?? pickReason ?? '', onSelect: () => add(first.value) });
          }
        }
        const removable = registry.components.filter((c) => selComponents.has(c.name) && c.name !== 'transform' && c.name !== 'prefab' && c.name !== 'folder');
        out.push('separator');
        out.push({ label: 'Remove', disabled: noSelection || removable.length === 0, reason: noSelection ? need : 'no removable components', items: removable.map((c) => ({ label: c.label, onSelect: () => selectedId !== null && void editComponent(selectedId, c.name, null) })) });
        return out;
      })(),
    },
    {
      label: 'Gizmos',
      items: [
        { label: `Icons: ${gizmos.icons ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, icons: !g.icons })) },
        { label: `Light ranges: ${gizmos.lights ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, lights: !g.lights })) },
        { label: `Collider outlines: ${gizmos.colliders ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, colliders: !g.colliders })) },
        { label: `Gameplay paths and areas: ${gizmos.gameplay ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, gameplay: !g.gameplay })) },
        { label: `Play selected effects: ${effectPreview ? 'on' : 'off'}`, onSelect: () => setEffectPreview((v) => !v) },
      ],
    },
    {
      label: 'Window',
      items: [
        { label: 'Scene', onSelect: () => setCenterTab('scene') },
        { label: 'Game', onSelect: () => setCenterTab('game') },
        { label: 'Next tab', shortcut: 'Ctrl+Tab', onSelect: () => workspaceDispatch({ type: 'cycle', dir: 1 }) },
        { label: 'Previous tab', shortcut: 'Ctrl+Shift+Tab', onSelect: () => workspaceDispatch({ type: 'cycle', dir: -1 }) },
        { label: workspace.maximized ? 'Restore docks' : 'Maximize centre area', onSelect: () => workspaceDispatch({ type: 'maximize' }) },
        'separator',
        ...BOTTOM_TABS.map<MenuEntry>((t) => ({ label: t.label, onSelect: () => setBottomTab(t.id) })),
        'separator',
        { label: 'Full screen', shortcut: 'Shift+F11', onSelect: () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); else void document.documentElement.requestFullscreen().catch(() => undefined); } },
        { label: 'Reset layout', onSelect: () => { resetLayout(); resetWorkspaces(); window.location.reload(); } },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard shortcuts', onSelect: () => setDialog('shortcuts') },
        { label: 'About Thirdlight', onSelect: () => setDialog('about') },
      ],
    },
  ];

  return (
    <CatalogProvider catalog={sessionClient?.catalog ?? null} asset={assetSummary}>
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
          setPlayFromForm((f) => ({ ...f, busy: false, error: null }));
          setDialog('playFrom');
        }}
        onStop={() => void stop()}
        {...(playMode !== null ? { playMode } : {})}
      />
      <div className={`tl-app__body${workspace.maximized ? ' is-maximized' : ''}`}>
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
          onMove={(ids, parentId, beforeId) => void move(ids, parentId, beforeId)}
          icons={iconTable}
          onAssetDrop={(asset, parentId, sceneId) => {
            if (sceneId !== null) clientRef.current?.setActiveScene(sceneId);
            const focus = viewportRef.current?.focusPoint() ?? [0, 0, 0];
            void dropAsset(asset, [Math.round(focus[0] * 4) / 4, Math.round(focus[1] * 4) / 4, Math.round(focus[2] * 4) / 4], parentId);
          }}
          {...(sceneHeaders !== null ? { scenes: sceneHeaders, closedScenes, onSceneAction: (a: SceneAction) => void sceneAction(a) } : {})}
        />
            </div>
            <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('left')} role="separator" aria-orientation="vertical" aria-label="Resize the hierarchy" />
            <div className="tl-app__center">
              <WorkspaceTabs state={workspace} dispatch={workspaceDispatch} host={workspaceHost} />
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
                void setEntityMaterials(target.id, { ...(target.materials ?? {}), '*': materialId });
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
          <ActiveDocument state={workspace} host={workspaceHost} />
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
          <div className="tl-dock tl-dock--bottom" style={{ height: sizes.bottom }}>
            <div className="tl-tabs" role="tablist">
              {BOTTOM_TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={bottomTab === t.id} className={`tl-tab${bottomTab === t.id ? ' is-active' : ''}`} onClick={() => setBottomTab(t.id)}>
                  {t.label}
                  {t.id === 'problems' && ui.problems.length + fileCheck.count + viewFailures.length + graphIssues.length + scriptIssues.length + materialIssues.length > 0 ? <span className="tl-tab__count">{ui.problems.length + fileCheck.count + viewFailures.length + graphIssues.length + scriptIssues.length + materialIssues.length}</span> : null}
                </button>
              ))}
            </div>
          {bottomTab === 'graphs' && (
            <GraphsPanel
              graphs={graphs}
              kinds={graphKinds}
              openId={activeGraphId}
              error={graphsError}
              onOpen={(id) => showGraph(id)}
              onCreate={(kind, name) => {
                const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'graph';
                let graphId = base;
                for (let i = 2; graphs.some((g) => g.graphId === graphId); i++) graphId = `${base}-${i}`;
                void graphDocCommand('setGraph', { graph: { graphId, kind, name, graph: { nodes: [], edges: [] } } }).then((ok) => ok && showGraph(graphId));
              }}
              onRename={(graphId, name) => {
                const g = graphs.find((x) => x.graphId === graphId);
                if (g !== undefined) void graphDocCommand('setGraph', { graph: { ...g, name } });
              }}
              onDelete={(graphId) => {
                void graphDocCommand('deleteGraph', { graphId }).then((ok) => {
                  if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'graph', id: graphId }) });
                });
              }}
            />
          )}
          {bottomTab === 'dialogue' && (
            <DialoguePanel
              dialogues={dialogues}
              speakers={speakers}
              settings={dialogueSettings}
              uiDocuments={projectUiDocs}
              uiThemes={projectUiThemes}
              openId={activeDialogueId}
              error={dialogueError}
              onOpen={(id) => openDocument('dialogue', id)}
              onCreate={(name) => {
                const c = clientRef.current;
                if (c === null) return;
                void freeDialogueId(name, async (ids) => new Set([...(await c.catalog.taken(ids, ['dialogue'])), ...dialogues.map((d) => d.dialogueId)])).then(
                  async (dialogueId) => (await dialogueCommand('setDialogue', { dialogue: { dialogueId, name } })) && openDocument('dialogue', dialogueId),
                  (e: unknown) => setDialogueError(`the new conversation's id could not be checked: ${e instanceof Error ? e.message : String(e)}`),
                );
              }}
              onRename={(dialogueId, name) => void dialogueCommand('setDialogue', { dialogue: { dialogueId, name } })}
              onDelete={(dialogueId) => {
                void dialogueCommand('deleteDialogue', { dialogueId }).then((ok) => {
                  if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'dialogue', id: dialogueId }) });
                });
              }}
              onSaveSpeaker={(speaker) => void dialogueCommand('setSpeaker', { speaker })}
              onDeleteSpeaker={(speakerId) => void dialogueCommand('deleteSpeaker', { speakerId })}
              onSaveSettings={(settings) => void dialogueCommand('setDialogueSettings', { settings })}
            />
          )}
          {bottomTab === 'effects' && (
            <EffectsPanel
              effects={effects}
              openId={activeEffectId}
              error={effectError}
              onOpen={(id) => openDocument('effect', id)}
              onCreate={(name) => {
                const effectId = uniqueId(name, effects.map((e) => e.effectId), 'effect');
                void effectCommand('setEffect', { effect: newEffect(effectId, name) }).then((ok) => ok && openDocument('effect', effectId));
              }}
              onRename={(effectId, name) => void effectCommand('renameEffect', { effectId, name })}
              onDelete={(effectId) => {
                void effectCommand('deleteEffect', { effectId }).then((ok) => {
                  if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'effect', id: effectId }) });
                });
              }}
            />
          )}
          {bottomTab === 'timelines' && (
            <TimelinesPanel
              timelines={timelines}
              openId={(() => {
                const d = activeDoc(workspace);
                return d !== null && d.kind === 'timeline' ? d.id : null;
              })()}
              error={timelineError}
              onOpen={(id) => openDocument('timeline', id)}
              onCreate={(name) => {
                const timelineId = uniqueId(name, timelines.map((t) => t.timelineId), 'timeline');
                void timelineCommand('setTimeline', { timeline: newTimeline(timelineId, name) }).then((ok) => ok && openDocument('timeline', timelineId));
              }}
              onDelete={(timelineId) => {
                void timelineCommand('deleteTimeline', { timelineId }).then((ok) => {
                  if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'timeline', id: timelineId }) });
                });
              }}
            />
          )}
          {bottomTab === 'console' && (
            <ConsolePanel
              playSessionId={playing && playInfo !== null ? playInfo.playSessionId : null}
              fetchDiagnostics={async (psid) => clientRef.current?.playDiagnostics(psid) ?? { ok: false, message: 'not connected' }}
              onOpenSource={openSource}
            />
          )}
          {bottomTab === 'libraries' && (
            <LibrariesPanel
              libraries={scriptLibraries}
              dependents={libraryDependents}
              openId={(() => {
                const d = activeDoc(workspace);
                return d !== null && d.kind === 'script-library' ? d.id : null;
              })()}
              error={libraryError}
              dirty={dirtyLibraries}
              saveAll={saveAllOutcome}
              onSaveAll={(acknowledge) => void saveAllLibraries(acknowledge)}
              onOpen={(id) => openDocument('script-library', id)}
              onCreate={(name) => {
                const libraryId = uniqueId(name, scriptLibraries.map((l) => l.libraryId), 'library');
                void libraryCommand('setScriptLibrary', { libraryId, name: name.slice(0, 64), files: newLibraryFiles(libraryId) }).then((ok) => ok && openDocument('script-library', libraryId));
              }}
              onRename={(libraryId, name) => void libraryCommand('setScriptLibrary', { libraryId, name })}
              onDelete={(libraryId) => {
                void libraryCommand('deleteScriptLibrary', { libraryId }).then((ok) => {
                  if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'script-library', id: libraryId }) });
                });
              }}
            />
          )}
          {bottomTab === 'blocks' && (
            <BlocksPanel
              editor={blockEditor}
              visible={bottomTab === 'blocks' && activeDoc(workspace) === null}
              layers={blockRows}
              layerId={blockLayerId}
              onLayer={(id) => {
                setBlockLayerId(id);
                blockLayerIdRef.current = id;
                refreshEntities();
              }}
              types={blockTypes}
              fields={cellFields}
              stamps={blockStamps}
              registry={registry}
              fieldContext={gameFieldContext}
              thumbnails={tileThumbnails}
              handlers={blockHandlersRef}
              run={blockRun}
              edit={blockEdit}
              onCreateLayer={() => void createBlockLayer()}
              onSetFlag={(id, flag, value) => void setFlag(id, flag, value)}
              onNotice={setNotice}
            />
          )}
          {bottomTab === 'problems' && (
            <ProblemsPanel
              graphIssues={[...graphIssues, ...scriptIssues, ...materialIssues]}
              onGraphIssue={(i) => {
                if (i.materialId !== undefined) {
                  // A graph material's problem opens its Material tab at the node.
                  if (i.nodeId !== undefined) setMaterialFocus({ id: i.nodeId, nonce: Date.now(), materialId: i.materialId });
                  openDocument('material', i.materialId);
                } else if (i.behaviorId !== undefined) {
                  // A visual script's problem opens its Graph tab at the node (its function's tab inside a function).
                  workspaceDispatch({ type: 'open', doc: { kind: 'visual-script', id: i.behaviorId } });
                  if (i.nodeId !== undefined) setVisualFocus({ behaviorId: i.behaviorId, id: i.nodeId, nonce: Date.now() });
                } else showGraph(i.graphId, i.nodeId);
              }}
              problems={ui.problems}
              viewFailures={viewFailures}
              fileCheck={fileCheck.checkable ? fileCheck : null}
              onReimport={(i) => void reimportIssue(i)}
            />
          )}
          {bottomTab === 'ui' && (
            <UiPanel
              documents={uiDocuments}
              themes={uiThemes}
              error={uiError}
              onOpenDocument={(id) => openDocument('ui-document', id)}
              onOpenTheme={(id) => openDocument('ui-theme', id)}
              onCreateDocument={(name) => void createUiDocument(name)}
              onCreateTheme={(name) => {
                const uiThemeId = uniqueDocId(name, uiThemes.map((t) => t.uiThemeId), 'theme');
                void uiCommand('setUiTheme', { theme: newUiTheme(uiThemeId, name) }).then((err) => {
                  setUiError(err);
                  if (err === null) openDocument('ui-theme', uiThemeId);
                });
              }}
              onRenameDocument={(id, name) => {
                const d = uiDocuments.find((x) => x.uiDocumentId === id);
                if (d !== undefined) void uiCommand('setUiDocument', { document: { ...d, name } }).then(setUiError);
              }}
              onRenameTheme={(id, name) => {
                const t = uiThemes.find((x) => x.uiThemeId === id);
                if (t !== undefined) void uiCommand('setUiTheme', { theme: { ...t, name } }).then(setUiError);
              }}
              onDeleteDocument={(id) =>
                void uiCommand('deleteUiDocument', { uiDocumentId: id }).then((err) => {
                  setUiError(err);
                  if (err === null) workspaceDispatch({ type: 'close', key: docKey({ kind: 'ui-document', id }) });
                })
              }
              onDeleteTheme={(id) =>
                void uiCommand('deleteUiTheme', { uiThemeId: id }).then((err) => {
                  setUiError(err);
                  if (err === null) workspaceDispatch({ type: 'close', key: docKey({ kind: 'ui-theme', id }) });
                })
              }
            />
          )}
          {bottomTab === 'assets' && (
            <AssetBrowser
              onNewUiDocument={() => void createUiDocument(`UI document ${uiDocuments.length + 1}`)}
              importState={importState}
              selectedAssetId={selectedAssetId}
              placementAvailable={placement !== null && assetPlacementAvailable()}
              placementMessage={placementError?.message ?? null}
              preview={assetPreview.view}
              onRefresh={() => void refreshAssets()}
              onSelect={(id) => {
                setSelectedAssetId(id);
                setAssetDeleteError(null);
              }}
              onImport={(f) => void importFile(f, 'create')}
              importSettings={importSettings}
              onPackTexture={async (req) => {
                const c = clientRef.current;
                if (c === null) return 'not connected';
                const res = await c.packTexture(req);
                if (!res.ok) return res.error.message;
                await c.fullResync();
                setSelectedAssetId(res.assetId);
                return null;
              }}
              onReimport={(f) => void importFile(f, 'reimport')}
              folderImport={fileCheck.checkable}
              onImportFromFolder={() => setFilePicker('create')}
              onReimportFromFolder={() => setFilePicker('reimport')}
              onPublish={() => void publish()}
              onCancel={() => void cancelImportFlow()}
              onDiscard={() => void discardImportFlow()}
              onPreview={(id) => void assetPreview.load(id)}
              previewCanvasRef={assetPreview.canvasRef}
              onPreviewPlay={assetPreview.play}
              onPreviewPause={assetPreview.pause}
              onPreviewScrub={assetPreview.scrub}
              onPlace={() => void placeAsset()}
              roleMapping={mediaPendingRef.current !== null && mediaPendingRef.current.referencingEntityIds.length > 0 ? { clipNames: mediaPendingRef.current.clipNames ?? [], referencingEntityIds: mediaPendingRef.current.referencingEntityIds } : null}
              roleEntity={reimportEntity}
              roleDraft={reimportRoles}
              onRoleEntityChange={setReimportEntity}
              onRoleDraftChange={setReimportRoles}
              thumbnails={tileThumbnails}
              pieces={selectedAsset.pieces}
              assetOptions={assetOptions}
              onDelete={(id) => void deleteAsset(id)}
              deleteError={assetDeleteError}
              importExtra={
                <AssetFolders
                  clientRef={clientRef}
                  uploadFolder={uploadFolder}
                  onUploadFolder={setUploadFolder}
                  newFolder={projectWindow.folder ?? ''}
                  ktx2={textureEncoding === 'none' ? undefined : textureEncoding}
                  load={loadProjectFiles}
                  onImported={() => void refreshAssets()}
                />
              }
              loading={loadingNames}
              folder={projectWindow.folder}
              onFolder={projectWindow.setFolder}
              onOpenItem={projectWindow.open}
              projectCommands={projectWindow.commands}
              sideExtra={
                selectedAssetId !== null && selectedAsset.summary?.kind === 'model' ? (
                  <ModelAssetOptions asset={selectedAsset.summary} materials={materials} sourceMaterials={assetSourceMaterials} missingBones={missingBones} onClipsFor={(rig) => void setAssetClipsFor(selectedAssetId, rig)} onMaterials={(mapping) => void assetOptions.setAssetMaterials(selectedAssetId, mapping)} onReimportExtract={(path, extract) => void reimportWithExtract(selectedAssetId, path, extract)} />
                ) : null
              }
            />
          )}
          {bottomTab === 'prefabs' && (
            <PrefabPanel
              selection={selected}
              definitions={prefabSummaries}
              selectedPrefabId={selectedPrefabId}
              targets={overrideTargets}
              captureDraft={captureIdRef.current && selectedId ? { prefabId: captureIdRef.current, displayName: captureName } : null}
              captureError={captureError}
              copyError={copyError}
              overrideCount={Object.keys(overrideDrafts).length}
              onCaptureName={setCaptureName}
              onCapture={() => void capturePrefab()}
              onSelect={(id) => {
                setSelectedPrefabId(id);
                setOverrideDrafts({});
                setCopyError(null);
              }}
              onPlaceCopy={(id) => void placeCopy(id)}
              onDelete={(id) => void deletePrefab(id)}
              deleteError={prefabDeleteError}
              onOverrideCommit={commitOverride}
            />
          )}
          {bottomTab === 'behaviors' && <BehaviorPanel {...behaviorProps} />}
          {bottomTab === 'gameplay' && (
            <GameplayPanel
              entities={entities}
              settings={settings}
              onSelectEntity={(id) => setSelection({ ids: [id], primary: id })}
              registry={registry}
              fieldContext={gameFieldContext}
              onSaveSettings={(s) => void saveSettings(s)}
              backendError={gameplayError}
            />
          )}
          {bottomTab === 'materials' && (
            <MaterialsPanel
              materials={materials}
              selectedId={selectedMaterialId}
              onSelect={setSelectedMaterialId}
              onSave={(m) => void saveMaterial(m, materials.find((x) => x.materialId === m.materialId) ?? null)}
              onDelete={(id) => void deleteMaterial(id)}
              error={materialError}
              onOpen={(id) => openDocument('material', id)}
            />
          )}
          {bottomTab === 'environment' && (
            <EnvironmentPanel
              environment={environment}
              onSave={(env) => void saveEnvironment(env, environment)}
              error={materialError}
              presets={{
                lights: entities.filter((e) => e.light !== undefined).map((e) => ({ id: e.id, type: e.light!.type, color: e.light!.color, intensity: e.light!.intensity, ...(e.light!.direction !== undefined ? { direction: e.light!.direction } : {}), ...(e.light!.groundColor !== undefined ? { groundColor: e.light!.groundColor } : {}) })),
                onPreview: (weights) => viewportRef.current?.previewEnvironmentBlend(weights === null ? null : { weights }, new Map((clientRef.current?.getTags() ?? []).map((t) => [t.name, t.bit]))),
              }}
            />
          )}
          {bottomTab === 'input' && <InputPanel input={inputConfig} defaults={inputDefaults} onSave={(i) => void saveInput(i)} error={inputError} />}
          {bottomTab === 'animator' && <AnimatorPanel {...animatorProps} />}
          {bottomTab === 'lighting' && (
            activeScene === null ? (
              <p className="tl-hint">Lighting bakes need a project with scenes (storage v4).</p>
            ) : (
              <LightingPanel
                sceneName={activeScene.name}
                bake={lighting[activeScene.sceneId] ?? null}
                stale={lighting[activeScene.sceneId] !== undefined && bakeIsStale(lighting[activeScene.sceneId]!, (clientRef.current?.projection.listEntities() ?? []).filter((e) => e.sceneId === activeScene.sceneId), (id) => clientRef.current?.getBlockLayers().get(id)?.chunks)}
                settings={bakeSettings}
                onSettings={setBakeSettings}
                busy={bakeBusy}
                finalUnavailable={bakeHost}
                message={bakeMessage}
                onBakePreview={() => void bakePreview()}
                onBakeFinal={() => void bakeFinal()}
                onCancel={() => bakeAbortRef.current?.abort()}
                onClear={() => void clearBake()}
              />
            )
          )}
          {bottomTab === 'shell' && <ShellPanel registry={registry} shell={shell} fieldContext={fieldContextMemo} error={shellError} onSetShell={(next, base) => void saveShell(next, base)} />}
          {bottomTab === 'modes' && (
            <ModesPanel
              registry={registry}
              modes={modes}
              groups={behaviorGroups}
              groupUsage={groupUsageMemo}
              fieldContext={fieldContextMemo}
              error={modesError}
              onSetModes={(next) => void saveModes(next)}
              onSetGroups={(next) => void saveBehaviorGroups(next)}
            />
          )}
          {bottomTab === 'tags' && (
            <TagsPanel
              tags={tags}
              usage={tagUsage}
              error={tagsError}
              onSetTags={(next) => void saveTags(next)}
            />
          )}
          {bottomTab === 'tags' && (
            <CollisionLayersPanel
              layers={collisionLayers}
              usage={layerUsageMemo}
              dimension={settings?.['physics_dimension'] === 3 ? 3 : 2}
              error={layersError}
              onSetLayers={(next) => void saveCollisionLayers(next)}
            />
          )}
          {bottomTab === 'saves' && (
            <SavesPanel
              schema={saveSchema}
              error={saveSchemaError}
              onSave={(next) => void saveSaveSchema(next)}
              note={playSaveNote}
              onClearPlaySave={
                playInfo !== null && bridgeRef.current !== null
                  ? () => {
                      let hex = '';
                      for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
                      const relayId = `relay-${hex}`;
                      localRelaysRef.current.add(relayId);
                      bridgeRef.current?.requestGameControl(playInfo.playSessionId, relayId, 'clearSave');
                    }
                  : null
              }
            />
          )}
          {bottomTab === 'media' && (
            <MediaPanel
              previewStatus={previewOwnerRef.current?.status() ?? { state: 'unsupported' }}
              previewDiagnostics={previewOwnerRef.current?.diagnostics() ?? []}
              onUnlockPreview={unlockPreview}
              onPreviewCue={(id) => void previewCue(id)}
              registry={registry}
              eventCues={eventCues}
              fieldContext={fieldContextMemo}
              eventCuesError={eventCuesError}
              onSetEventCues={(next, base) => void saveEventCues(next, base)}
            />
          )}
          </div>
        </div>
        <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('right')} role="separator" aria-orientation="vertical" aria-label="Resize the inspector" />
        <div className="tl-dock tl-dock--right" style={{ width: sizes.right }}>
        {activeAnimatorId !== null && animators.some((a) => a.controllerId === activeAnimatorId) ? (
          <div className="tl-inspector" aria-label="animator inspector">
            <div className="tl-panel__title">Inspector</div>
            <AnimatorInspector
              controller={animators.find((a) => a.controllerId === activeAnimatorId)!}
              ownerId={animatorSelection.ownerId !== '' ? animatorSelection.ownerId : (animatorTargets[activeAnimatorId] ?? activeAnimatorId)}
              ids={animatorSelection.ids}
              kinds={graphKinds}
              clipsOf={clipsOf}
              onGraphEdit={animatorGraphEdit}
              onSave={(controller) => void saveAnimator(controller)}
              onTarget={(ownerId) => {
                setAnimatorTargets((t) => ({ ...t, [activeAnimatorId]: ownerId }));
                setAnimatorSelection({ ownerId, ids: [] });
                setAnimatorFocus(null);
              }}
              onFocus={(id) => setAnimatorFocus({ id, nonce: Date.now() })}
            />
          </div>
        ) : activeVisual?.graph !== undefined && graphKinds['behavior'] !== undefined ? (
          <div className="tl-inspector" aria-label="visual script inspector">
            <div className="tl-panel__title">Inspector</div>
            {(() => {
              // The graph in front — the event graph or one of the script's functions.
              const fn = activeVisualTarget !== '' ? activeVisual.functions?.find((f) => f.functionId === activeVisualTarget) : undefined;
              const kindDef = fn !== undefined ? graphKinds['behavior-function'] : graphKinds['behavior'];
              const g = fn !== undefined ? fn.graph : activeVisual.graph!;
              if (kindDef === undefined || (activeVisualTarget !== '' && fn === undefined)) return null;
              const owner = fn !== undefined ? `${activeVisual.behaviorId}#${fn.functionId}` : activeVisual.behaviorId;
              return (
                <GraphInspector
                  key={owner}
                  kind={kindDef}
                  graph={g}
                  ids={visualSelection}
                  onEdit={(ops) => sendGraphEdit({ kind: 'behavior', id: owner }, ops)}
                  portContext={behaviorPortContext(g, { functions: activeVisual.functions, graphs, kinds: graphKinds, ...(fn !== undefined ? { script: activeVisual.graph! } : {}) })}
                  assetKinds={indexKindsOfAssetField}
                  // Calls pick their function by name: the script's functions, or the project's shared functions.
                  fieldOptions={(f, n) =>
                    f.key !== 'function' ? undefined : n.type === 'fn.call' ? (activeVisual.functions ?? []).map((x) => ({ id: x.functionId, label: scriptFunctionName(x) })) : n.type === 'fn.library' ? graphs.filter((x) => x.kind === 'behavior-library').map((x) => ({ id: x.graphId, label: x.name })) : undefined
                  }
                />
              );
            })()}
          </div>
        ) : openGraph !== null && graphKinds[openGraph.kind] !== undefined ? (
          <div className="tl-inspector">
            <div className="tl-panel__title">Inspector</div>
            <GraphInspector
              kind={graphKinds[openGraph.kind]!}
              graph={openGraph.graph}
              ids={graphSelection}
              onEdit={(ops) => sendGraphEdit({ kind: 'graph', id: openGraph.graphId }, ops)}
              portContext={graphsContext}
              assetKinds={indexKindsOfAssetField}
            />
          </div>
        ) : activeDialogueId !== null && graphKinds['dialogue'] !== undefined && dialogues.some((d) => d.dialogueId === activeDialogueId) ? (
          <div className="tl-inspector" aria-label="dialogue graph inspector">
            <div className="tl-panel__title">Inspector</div>
            {(() => {
              const d = dialogues.find((x) => x.dialogueId === activeDialogueId)!;
              return (
                <GraphInspector
                  kind={graphKinds['dialogue']!}
                  graph={d.graph}
                  ids={dialogueSelection}
                  onEdit={(ops) => sendGraphEdit({ kind: 'dialogue', id: d.dialogueId }, ops)}
                  // A voice clip is an audio asset of any length.
                  assetKinds={indexKindsOfAssetField}
                  empty={<div className="tl-inspector__empty">Select a node of “{d.name}”: a line (speaker, expression, text, voice), an option (text, condition, effects), a branch, a set, a signal…</div>}
                />
              );
            })()}
          </div>
        ) : activeEffectId !== null && graphKinds['effect'] !== undefined && effects.some((e) => e.effectId === activeEffectId && e.systems.length > 0) ? (
          <div className="tl-inspector" aria-label="effect graph inspector">
            <div className="tl-panel__title">Inspector</div>
            {(() => {
              const fx = effects.find((e) => e.effectId === activeEffectId)!;
              const sys = shownSystem(fx, effectSystems[fx.effectId] ?? null)!;
              return (
                <GraphInspector
                  kind={graphKinds['effect']!}
                  graph={sys.graph}
                  ids={effectSelection}
                  onEdit={(ops) => sendGraphEdit({ kind: 'effect', id: `${fx.effectId}/${sys.systemId}` }, ops)}
                  portContext={effectPortContext(fx.parameters)}
                  assetKinds={indexKindsOfAssetField}
                  empty={<div className="tl-inspector__empty">Select a node, wire, group or comment of “{sys.name}”.</div>}
                />
              );
            })()}
          </div>
        ) : activeMaterialId !== null && graphKinds['material'] !== undefined && materials.find((m) => m.materialId === activeMaterialId)?.graph !== undefined ? (
          <div className="tl-inspector" aria-label="material graph inspector">
            <div className="tl-panel__title">Inspector</div>
            {(() => {
              const m = materials.find((x) => x.materialId === activeMaterialId)!;
              return (
                <GraphInspector
                  kind={graphKinds['material']!}
                  graph={m.graph!}
                  ids={materialSelection}
                  onEdit={(ops) => sendGraphEdit({ kind: 'material', id: m.materialId }, ops)}
                  portContext={materialPortContext(m.parameters, graphs, graphKinds)}
                  assetKinds={indexKindsOfAssetField}
                  empty={<div className="tl-inspector__empty">Select a node, wire, group or comment of “{m.name}”.</div>}
                />
              );
            })()}
          </div>
        ) : (
        <Inspector
          entity={selected}
          gizmoMode={gizmoMode}
          onGizmoMode={setGizmoMode}
          declarations={declarations}
          prefabDisplayName={(prefabId) => prefabSummaries.find((d) => d.prefabId === prefabId)?.displayName ?? prefabId}
          propertyError={propertyError}
          componentError={componentError}
          onEditProperty={(entityId, key, raw) => void editProperty(entityId, key, raw)}
          registry={registry}
          fieldContext={fieldContext}
          onComponentEdit={(entityId, component, patch) => void editComponent(entityId, component, patch)}
          onAddComponent={(entityId, component, value) => void addComponentTo(entityId, component, value)}
          onFitCapsule={(entityId) => void fitCapsuleToModel(entityId)}
          capsuleOwner={(() => {
            // A child of the player collides with the player's capsule.
            let parent = selected?.parentId ?? null;
            for (let depth = 0; parent !== null && depth < 64; depth++) {
              const p = entities.find((e) => e.id === parent);
              if (p === undefined) break;
              if (p.controller === true) return p.name;
              parent = p.parentId;
            }
            return null;
          })()}
          onRename={(entityId, name) => void rename(entityId, name)}
          onEditTransform={(entityId, patch) => void editTransform(entityId, patch)}
          flags={selected !== null ? (hierarchyFlags.get(selected.id) ?? null) : null}
          entityName={(id) => entities.find((e) => e.id === id)?.name ?? id}
          selectionCount={selection.ids.length}
          onSetFlag={(entityId, flag, value) => void setFlag(entityId, flag, value)}
          tags={tags}
          onSetTags={(entityId, names) => void setEntityTags(entityId, names)}
          // Descriptor-keyed custom widgets — the material mapping knows the
          // model's own material names; a surface offers the built-in presets.
          alwaysShow={selected !== null && (selected.kind === 'model' || selected.kind === 'box' || selected.instances !== undefined) ? ['materials'] : []}
          addExtras={(() => {
            // "Add collider → box / polygon from model outline" (where a collider may be added).
            if (selected === null || registry === null || selected.components['collider'] !== undefined) return [];
            const entry = addEntries(registry, new Set(Object.keys(selected.components)), { dimension: settings?.['physics_dimension'] === 3 ? 3 : 2 }).find((x) => x.component === 'collider');
            const enabled = entry?.enabled === true;
            const reason = entry?.reason ?? null;
            return [
              ...(settings?.['physics_dimension'] === 3
                ? [
                    // A 3D project's colliders from the model.
                    { id: 'collider-box-model', label: 'Collider: Box from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'box') },
                    { id: 'collider-convex-model', label: 'Collider: Convex hull from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'convex') },
                    { id: 'collider-mesh-model', label: 'Collider: Mesh from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'mesh') },
                  ]
                : [
                    { id: 'collider-box-model', label: 'Collider: Box from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel(selected.id, 'box') },
                    { id: 'collider-polygon-model', label: 'Collider: Polygon from model outline', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel(selected.id, 'polygon') },
                  ]),
            ];
          })()}
          bodies={
            selected === null
              ? {}
              : {
                  materials: (
                    <MaterialMappingEditor
                      label="Materials"
                      sourceNames={selected.kind === 'box' ? [] : selectedSourceMaterials}
                      mapping={selected.materials ?? null}
                      materials={materials}
                      onChange={(mapping) => void setEntityMaterials(selected.id, mapping)}
                      overrides={{
                        value: (selected.components['materialParams'] as Record<string, Record<string, number | number[] | string>> | undefined) ?? null,
                        inherited: selected.assetId !== undefined ? (clientRef.current?.content.getAsset(selected.assetId)?.materials ?? null) : null,
                        onChange: (next) => void setEntityMaterialParams(selected.id, next),
                      }}
                    />
                  ),
                  // The overrides are edited in the Materials section above.
                  materialParams: <p className="tl-inspector__hint">Edited in the Materials section (per graph material, public parameters only).</p>,
                }
          }
          extensions={
            selected === null
              ? {}
              : {
                  // Write the footprint's metadata into the cells beneath, or land the object on the cell tops.
                  blockFootprint: (
                    <div className="tl-inspector__modes">
                      <button className="tl-btn tl-btn--small" title="Write the footprint's metadata into the block cells beneath the object" onClick={() => void writeFootprint(selected.id, null, { position: selected.position, rotation: selected.rotation })}>
                        Write to cells
                      </button>
                      <button
                        className="tl-btn tl-btn--small"
                        title="Move the object onto the top of the block cells under it"
                        onClick={() => {
                          const c = clientRef.current;
                          if (!c) return;
                          const fp = (selected.components as { blockFootprint?: BlockFootprintComponent }).blockFootprint;
                          const at = snapToCellTop(propLayers(fp?.layer), selected.position, fp?.size, yawQuarterTurns(selected.rotation));
                          if (at === null) return setNotice('Not over a block layer.');
                          const before = { position: selected.position, rotation: selected.rotation };
                          void c.command('setTransform', { entityId: selected.id, transform: { position: at } }, c.projection.revision).then((r) => {
                            if (r.ok) void writeFootprint(selected.id, before, { position: at, rotation: selected.rotation });
                            else if ((r.response as { code?: string }).code !== 'no_change') reportFailure('Snap to cell top', r);
                          });
                        }}
                      >
                        Snap to cell top
                      </button>
                    </div>
                  ),
                  // One copy of an instance set, and the copy brush.
                  instances: (
                    <div className="tl-inspector__copies" data-copy={selectedCopy ?? ''}>
                      {instanceChunks[selected.id] !== undefined && (
                        <p className="tl-inspector__hint" data-chunks={instanceChunks[selected.id]}>
                          Drawn in {instanceChunks[selected.id]} chunk{instanceChunks[selected.id] === 1 ? '' : 's'} of at most {String((selected.components['instances'] as { chunkSize?: number } | undefined)?.chunkSize ?? settings?.['instance_chunk_m'] ?? 32)} m, each hidden out of view and given its level of detail on its own.
                        </p>
                      )}
                      {selectedCopy !== null && (
                        <>
                          <p className="tl-inspector__hint">Copy {selectedCopy + 1} selected: move, turn or scale it with the gizmo (W/E/R); Del deletes it.</p>
                          <div className="tl-inspector__modes">
                            <button className="tl-btn" onClick={() => void editCopiesRef.current.remove(selected.id, selectedCopy)}>
                              Delete copy
                            </button>
                            <button
                              className="tl-btn"
                              onClick={() => {
                                viewportRef.current?.setSelectedCopy(null);
                                setSelectedCopy(null);
                              }}
                            >
                              Whole set
                            </button>
                          </div>
                        </>
                      )}
                      <button className="tl-btn" aria-pressed={brushOn} title="Click or drag in the Scene view to add copies (at least 1 m apart); each stroke is one undo step" onClick={() => setBrushOn((v) => !v)}>
                        {brushOn ? 'Brush: on' : 'Brush: add copies'}
                      </button>
                    </div>
                  ),
                  // A collider from the model's outline; how to edit a polygon in the Scene view.
                  collider: (
                    <>
                      {settings?.['physics_dimension'] === 3 ? (
                        // A 3D project's colliders from the model (its _COL node, else its geometry).
                        <div className="tl-inspector__modes">
                          <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'box')}>
                            Box from model
                          </button>
                          <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'convex')}>
                            Convex hull from model
                          </button>
                          <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'mesh')}>
                            Mesh from model
                          </button>
                        </div>
                      ) : (
                      <div className="tl-inspector__modes">
                        <button className="tl-btn" onClick={() => void colliderFromModel(selected.id, 'box')}>
                          Box from model
                        </button>
                        <button className="tl-btn" onClick={() => void colliderFromModel(selected.id, 'polygon')}>
                          Polygon from model outline
                        </button>
                      </div>
                      )}
                      {(selected.components['collider'] as { shape?: { type?: string } } | undefined)?.shape?.type === 'polygon' && (
                        <p className="tl-inspector__hint">Scene view: drag a corner; drag a small grey point to add a corner there; Alt+click a corner to delete it.</p>
                      )}
                    </>
                  ),
                  mover: <p className="tl-inspector__hint">Scene view: drag a point; drag a small grey point to add one there; Alt+click a point to delete it.</p>,
                  surface: (
                    <label className="tl-field">
                      <span className="tl-field__label">Preset</span>
                      <select className="tl-input" aria-label="surface preset" value="" onChange={(e) => e.target.value !== '' && void applyPreset(selected.id, e.target.value as SurfacePresetName)}>
                        <option value="">apply a preset…</option>
                        {SURFACE_PRESET_NAMES.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  ),
                }
          }
        />
        )}
        {playing && playInfo !== null && selected !== null && selected.behaviorId !== undefined && (
          <PlayDebugView entityId={selected.id} observe={observeEntity} />
        )}
        </div>
      </div>
      <StatusBar state={ui} onResync={resync} renderer={sceneRenderer} />
      {filePicker !== null && (
        <ProjectFilePicker
          title={filePicker === 'create' ? 'Import from project folder' : 'Reimport from project folder'}
          startDir="assets"
          load={loadProjectFiles}
          onClose={() => setFilePicker(null)}
          onPick={(entry) => {
            const mode = filePicker;
            setFilePicker(null);
            void importFromFolder(entry.path, mode, mode === 'reimport' ? selectedAssetIdRef.current : null);
          }}
        />
      )}
      {dialog === 'export' && (
        <Dialog title="Export game" onClose={() => setDialog(null)}>
          <p>Builds the current revision into a standalone web game: a folder of static files that runs from any web server without Thirdlight.</p>
          {exportState.result === null ? (
            <button className="tl-btn" disabled={exportState.busy} onClick={() => void exportGame()}>
              {exportState.busy ? 'Exporting…' : 'Export now'}
            </button>
          ) : (
            <div className="tl-dialog__result">
              <p>
                Exported revision {exportState.result.revision}: {exportState.result.files} files in <code>{exportState.result.outputDir}</code> under the server's export root.
              </p>
              <button className="tl-btn" onClick={() => void downloadExport(exportState.result!.outputDir)}>
                Download zip
              </button>
            </div>
          )}
          {exportState.error ? <p className="tl-connect__message">{exportState.error}</p> : null}
        </Dialog>
      )}
      {dialog === 'playFrom' && (
        <Dialog title="Play from…" onClose={() => setDialog(null)}>
          <p>Start Play somewhere other than the game's start: at a scene (with the start scenes, at its first spawn), with script variables (the values the scripts read with ctx.save from the first step), or from one of Play's project save slots (a project with a save schema). MCP's tl_play_start takes the same options.</p>
          <div className="tl-exit">
            <label className="tl-field">
              <span className="tl-field__label">Scene</span>
              <select className="tl-input" aria-label="play from scene" value={playFromForm.sceneId} onChange={(e) => setPlayFromForm((f) => ({ ...f, sceneId: e.target.value, error: null }))}>
                <option value="">— the game's start —</option>
                {[...(sceneHeaders ?? []), ...closedScenes].map((sc) => (
                  <option key={sc.sceneId} value={sc.sceneId}>
                    {sc.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="tl-field">
              <span className="tl-field__label">Variables (JSON object)</span>
              <textarea className="tl-input" aria-label="play from variables" rows={4} placeholder='{"gold": 100, "chapter": 2}' value={playFromForm.variables} onChange={(e) => setPlayFromForm((f) => ({ ...f, variables: e.target.value, error: null }))} />
            </label>
            {saveSchema !== null && (
              <label className="tl-field">
                <span className="tl-field__label">Save slot</span>
                <select className="tl-input" aria-label="play from save slot" value={playFromForm.saveSlot} onChange={(e) => setPlayFromForm((f) => ({ ...f, saveSlot: e.target.value, error: null }))}>
                  <option value="">— none —</option>
                  {Array.from({ length: Math.max(0, Math.min(99, saveSchema.slots)) }, (_, i) => String(i + 1)).map((n) => (
                    <option key={n} value={n}>
                      Slot {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {modes.length > 0 && (
              <label className="tl-field">
                <span className="tl-field__label">Game mode</span>
                <select className="tl-input" aria-label="play from game mode" value={playFromForm.mode} onChange={(e) => setPlayFromForm((f) => ({ ...f, mode: e.target.value, error: null }))}>
                  <option value="">— the start mode —</option>
                  {modes.map((m) => (
                    <option key={m.modeId} value={m.modeId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {playFromForm.error !== null && <p className="tl-dialog__error" role="alert">{playFromForm.error}</p>}
          <button className="tl-btn" disabled={playFromForm.busy || playing} onClick={() => void playFrom()}>
            {playFromForm.busy ? 'Starting…' : playing ? 'Stop Play first' : '▶ Play'}
          </button>
        </Dialog>
      )}
      {dialog === 'snapping' && snapDraft !== null && (
        <Dialog title="Snapping settings" onClose={() => setDialog(null)}>
          <div className="tl-snapform" aria-label="snapping settings">
            <p className="tl-note">Editor settings for this project in this browser (not project data). Shift held turns snapping off for one gesture.</p>
            {([['translateM', 'Move step (m)'], ['rotateDeg', 'Rotate step (°)'], ['scale', 'Scale step']] as const).map(([k, label]) => (
              <label key={k} className="tl-snapform__row">
                <span>{label}</span>
                <input aria-label={label} type="number" step="any" value={snapDraft[k]} onChange={(e) => setSnapDraft({ ...snapDraft, [k]: e.target.value })} />
                {snapSettingError(k, Number(snapDraft[k])) !== null && <span className="tl-prop__error">{snapSettingError(k, Number(snapDraft[k]))}</span>}
              </label>
            ))}
            <label className="tl-snapform__row">
              <input type="checkbox" aria-label="snap to cell tops" checked={snapDraft.cellTops} onChange={(e) => setSnapDraft({ ...snapDraft, cellTops: e.target.checked })} />
              <span>Snap objects to block cell tops (moved and dropped objects land on the block layer under them)</span>
            </label>
            <div className="tl-dialog__actions">
              <button className="tl-btn" onClick={() => setSnapDraft({ translateM: String(DEFAULT_SNAP_SETTINGS.translateM), rotateDeg: String(DEFAULT_SNAP_SETTINGS.rotateDeg), scale: String(DEFAULT_SNAP_SETTINGS.scale), cellTops: false })}>
                Defaults
              </button>
              <button
                className="tl-btn"
                disabled={(['translateM', 'rotateDeg', 'scale'] as const).some((k) => snapSettingError(k, Number(snapDraft[k])) !== null)}
                onClick={() => {
                  setSnapSettingsState(saveSnapSettings(window.localStorage, cfg.current.ok ? cfg.current.config.projectId : 'default', { translateM: Number(snapDraft.translateM), rotateDeg: Number(snapDraft.rotateDeg), scale: Number(snapDraft.scale), cellTops: snapDraft.cellTops }));
                  setDialog(null);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {dialog === 'shortcuts' && (
        <Dialog title="Keyboard shortcuts" onClose={() => setDialog(null)}>
          <table className="tl-shortcuts">
            <tbody>
              {[
                ['W / E / R', 'Move / rotate / scale tool'],
                ['F', 'Frame the selection'],
                ['Delete, Backspace', 'Delete the selection'],
                ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
                ['Shift+F11', 'Full screen'],
                ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous centre tab'],
                ['Middle-click a tab', 'Close a document tab'],
                ['Double-click a controller or behavior', 'Open it in a centre tab'],
                ['Shift (held)', 'Disable snapping for one gesture'],
                ['PageUp / PageDown, ] / [', 'Blocks: move the height slice'],
                ['Q', 'Blocks: turn the brush'],
                ['Alt+drag, right-drag', 'Blocks: orbit while the block tools are on'],
                ['Escape', 'Cancel a gesture / clear the selection / close a menu'],
                ['Double-click a name', 'Rename in the hierarchy'],
                ['Drag a row onto another', 'Reparent'],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td><kbd>{k}</kbd></td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog>
      )}
      {dialog === 'instances' && (
        <Dialog title="Instance set" onClose={() => setDialog(null)}>
          <p>Many copies of one model as a single object (drawn with instancing): good for foliage, rocks and other repeated detail. The copies are spread on the ground plane around the point the camera looks at.</p>
          <div className="tl-scatter">
            <label className="tl-field">
              <span className="tl-field__label">Model</span>
              <RefPicker aria="instance model" kinds={MODEL_KINDS} value={scatter.assetId} none="— select —" onPick={(id) => setScatter((f) => ({ ...f, assetId: id }))} />
            </label>
            {(
              [
                ['count', 'Copies'],
                ['width', 'Width (X, m)'],
                ['depth', 'Depth (Z, m)'],
                ['scaleMin', 'Min scale'],
                ['scaleMax', 'Max scale'],
                ['seed', 'Seed'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="tl-field">
                <span className="tl-field__label">{label}</span>
                <input className="tl-input" type="number" aria-label={label} value={scatter[key]} onChange={(e) => setScatter((f) => ({ ...f, [key]: e.target.value }))} />
              </label>
            ))}
            <label className="tl-field tl-field--inline">
              <input type="checkbox" checked={scatter.randomYaw} onChange={(e) => setScatter((f) => ({ ...f, randomYaw: e.target.checked }))} />
              <span className="tl-field__label">Random turn</span>
            </label>
          </div>
          {scatter.error !== null && <p className="tl-dialog__error" role="alert">{scatter.error}</p>}
          <button className="tl-btn" disabled={scatter.busy} onClick={() => void createInstanceSet()}>
            {scatter.busy ? 'Creating…' : 'Create instance set'}
          </button>
        </Dialog>
      )}
      {dialog === 'about' && (
        <Dialog title="About Thirdlight" onClose={() => setDialog(null)}>
          <p>Thirdlight engine 0.1.0 — a self-hosted browser game editor on three.js.</p>
          <p>Project: <code>{cfg.current.ok ? cfg.current.config.projectId : ''}</code> · revision {ui.revision}</p>
          <p>Backend: <code>{window.location.origin}</code></p>
        </Dialog>
      )}
    </div>
    </CatalogProvider>
  );
}

type BottomTab = 'blocks' | 'assets' | 'materials' | 'environment' | 'lighting' | 'animator' | 'input' | 'prefabs' | 'behaviors' | 'gameplay' | 'tags' | 'saves' | 'media' | 'graphs' | 'effects' | 'timelines' | 'dialogue' | 'libraries' | 'modes' | 'shell' | 'ui' | 'problems' | 'console';

const BOTTOM_TABS: ReadonlyArray<{ id: BottomTab; label: string }> = [
  { id: 'assets', label: 'Assets' },
  { id: 'materials', label: 'Materials' },
  { id: 'environment', label: 'Environment' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'animator', label: 'Animator' },
  { id: 'input', label: 'Input' },
  { id: 'prefabs', label: 'Prefabs' },
  { id: 'behaviors', label: 'Behaviors' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'tags', label: 'Tags' },
  // The project save schema.
  { id: 'saves', label: 'Saves' },
  { id: 'media', label: 'Media' },
  { id: 'graphs', label: 'Graphs' },
  // Visual effects.
  { id: 'effects', label: 'Effects' },
  // Conversations, speakers, dialogue settings.
  { id: 'dialogue', label: 'Dialogue' },
  // Timelines (sequencer).
  { id: 'timelines', label: 'Timelines' },
  // Shared script libraries.
  { id: 'libraries', label: 'Libraries' },
  // Play script logs and errors at their source locations.
  { id: 'console', label: 'Console' },
  // Project UI documents and themes.
  { id: 'ui', label: 'UI' },
  // Game modes and behavior groups.
  { id: 'modes', label: 'Game modes' },
  // The game shell (menus and HUD as UI documents, the scene list).
  { id: 'shell', label: 'Game shell' },
  // Block-layer editing.
  { id: 'blocks', label: 'Blocks' },
  { id: 'problems', label: 'Problems' },
];

export function mountEditor(): void {
  const el = document.getElementById('tl-root');
  if (!el) throw new Error('editor root element #tl-root not found');
  createRoot(el).render(<EditorApp />);
}