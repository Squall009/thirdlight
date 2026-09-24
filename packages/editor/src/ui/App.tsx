/**
 * Editor app root (React, decision 0001 §10). Wires the session client
 * (backend transport), the imperative three.js viewport (framework-free), the
 * React panels, and the isolated play preview (separate-origin iframe + the
 * checked §13.5 bridge). React renders the panels + the canvas element; it
 * never instantiates or mutates Object3Ds (the viewport owns those).
 *
 * Packet 28 adds the prefab (copy) authoring path and the schema-driven
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
import { MenuBar, type Menu, type MenuEntry } from './MenuBar';
import { Dialog } from './Dialog';
import { SessionClient, makeAssetId, type ClientUiState, type PlayStartResult } from '../session/client';
import type { MutationResponse } from '../session/envelope';
import { Projection, type ProjectedEntity } from '../session/projection';
import { draggedRoots, effectiveFlagsOf, subtreeOrder } from '../session/hierarchy';
import { scatterProblem, scatterTransforms } from '../session/instances';
import { TagsPanel } from './TagsPanel';
import type { AssetView } from '../session/content-projection';
import {
  importFailed,
  initialImportState,
  publishArgsFromProposal,
  utcSecondTimestamp,
  type AssetImportState,
  type AssetQueryState,
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
  parseColliderBox,
  parseControlInput,
  planAddController,
  planRemovePhysicsComponent,
  planSetBehaviorProperties,
  planSetCollider,
} from '../session/property-controls';
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
import { ZoneGesture, type ZoneCommit } from '../session/zone-gesture';
import { fitCapsule } from '../session/size-handles';
import {
  DEFAULT_ZONE_SIZE,
  planCreateSpawn,
  planCreateZone,
  planEditZone,
  type GameConfigLike,
  type ZoneRole,
} from '../session/gameplay';
import type { ZonePose } from '../session/zone-gesture';
import { Viewport } from '../viewport/viewport';
import type { ZoneTool } from '../viewport/zone-overlay';
import { ModelInstances, type AssetPreviewSession } from '../viewport/model-instances';
import { ThumbnailRenderer } from '../viewport/thumbnails';
import { AnimatorMachine, type AnimatorControllerLike } from '@thirdlight/runtime';
import { createAnimatorPlayer, createMaterialLibrary, type EnvironmentLike, type LightingBakeLike, type MaterialDefLike, type MaterialLibrary } from '@thirdlight/three-adapter';
import type { AnimatorController, EnvironmentConfig, GameFlow, InputConfig, LightingBake, MaterialDef } from '@thirdlight/project-model';
import { PreviewStage } from '../viewport/preview-stage';
import { Bridge } from '../preview/bridge';
import { Hierarchy, type SceneAction, type SceneHeaderView } from './Hierarchy';
import { Inspector } from './Inspector';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { AssetBrowser, thumbnailKey, type AssetPreviewView } from './AssetBrowser';
import { MATERIAL_DRAG_TYPE, MaterialMappingEditor, MaterialsPanel } from './MaterialsPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { LightingPanel } from './LightingPanel';
import { AnimatorPanel, type AnimatorPreview } from './AnimatorPanel';
import { ClipsForField } from './ClipsForField';
import { InputPanel } from './InputPanel';
import { FlowPanel } from './FlowPanel';
import { bakeIsStale, DEFAULT_BAKE_SETTINGS, runBlenderBake, runBrowserBake, type BakeSettings } from '../viewport/bake-run';
import { FogVolumeEditor, LightEditor } from './LightEditor';
import { BLOCK_DEFAULTS, BlocksEditor } from './BlocksEditor';
import { PrefabPanel } from './PrefabPanel';
import { BehaviorPanel } from './BehaviorPanel';
import { GameplayPanel, type GameplayBackendError } from './GameplayPanel';
import { MediaPanel } from './MediaPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { ProjectFilePicker } from './ProjectFilePicker';
import { sourceIssuesFrom, type SourceIssue } from '../session/asset-sources';
import { createPreviewAudioOwner, type PreviewAudioOwner } from '../session/preview-audio';
import { validateMediaDrop, type AnimationRoleKey } from '../session/media';
import type { GizmoMode } from '../viewport/viewport';
import type { PropertyDeclaration } from '@thirdlight/project-model';

/** A bounded, actionable error the panels display. */
interface UiError {
  code: string;
  message: string;
}

/** The bounded backend error for a failed command (the panels explain it, never lose it). */

/** Poll `get` each animation frame (up to ~2 s) until it yields a value (phase 12 c: a change arriving over the socket). */
function waitFor<T>(get: () => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = (): void => {
      const v = get();
      if (v !== null || performance.now() - started > 2000) resolve(v);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

function commandError(res: { response: MutationResponse }): GameplayBackendError {
  const r = res.response;
  if (r.ok) return { code: 'unexpected_response', message: 'unexpected response shape' };
  return { code: r.code, message: r.message ?? r.code };
}

/**
 * M3 (packet 56): issue a zone gesture's single commit command (the gesture
 * DECIDED it; this issues it + the bounded conflict rebase for a move).
 * Returns the outcome — the caller owns the UI state (error surfacing, tool
 * clearing, undo enablement).
 */
async function issueZoneCommand(
  client: SessionClient,
  gesture: ZoneGesture,
  command: ZoneCommit,
): Promise<{ ok: true } | { ok: false; error: GameplayBackendError }> {
  if (command.op === 'createEntity') {
    const res = await client.createGameEntity(command.args as unknown as Record<string, unknown>, gesture.expectedRevision);
    if (res.ok) return { ok: true };
    return { ok: false, error: commandError(res) };
  }
  if (command.op === 'setTransform') {
    const res = await client.command('setTransform', { entityId: command.entityId, transform: command.args.transform }, gesture.expectedRevision);
    if (res.ok) return { ok: true };
    if (res.response.ok === false && res.response.code === 'revision_conflict') {
      const retried = gesture.handleResult(
        { ok: false, code: 'revision_conflict', currentRevision: res.response.currentRevision ?? 0 },
        () => {
          const e = client.projection.getEntity(command.entityId);
          return e
            ? { position: [e.position[0] ?? 0, e.position[1] ?? 0, e.position[2] ?? 0], size: [e.gameZone?.size[0] ?? 1, e.gameZone?.size[1] ?? 1] }
            : { position: [0, 0, 0], size: [1, 1] };
        },
      );
      if (retried.kind === 'commit') {
        const cmd = retried.command;
        if (cmd.op !== 'setTransform') {
          return { ok: false, error: { code: 'unexpected_command', message: 'the zone gesture decided an unexpected command' } };
        }
        const r2 = await client.command('setTransform', { entityId: cmd.entityId, transform: cmd.args.transform }, gesture.expectedRevision);
        if (r2.ok) return { ok: true };
        return { ok: false, error: commandError(r2) };
      }
      if (retried.kind === 'conflict') {
        return {
          ok: false,
          error: { code: 'revision_conflict', message: `the zone moved while you were dragging (the scene is now at revision ${retried.conflict.currentRevision}) — the edit was not applied; try again` },
        };
      }
      return { ok: false, error: { code: 'revision_conflict', message: 'the zone edit was rebased but no change remained to apply' } };
    }
    return { ok: false, error: commandError(res) };
  }
  // resize: one `setComponent(gameZone, { size })`.
  const res = await client.setComponent(command.entityId, 'gameZone', command.args.value, gesture.expectedRevision);
  if (res.ok) return { ok: true };
  return { ok: false, error: commandError(res) };
}

/** The capture preflight view of one projected entity (packet 28). */
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
  /** Packet 35: the immutable locator capability + build identity. */
  contentId: string | null;
  buildId: string | null;
  contentPath: string | null;
}

function EditorApp(): JSX.Element {
  const cfg = useRef(readEditorConfig());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
  /** Phase 12: the hierarchy selection (several ids) and its primary entity (inspector, gizmo). */
  const [selection, setSelection] = useState<{ ids: string[]; primary: string | null }>({ ids: [], primary: null });
  const selectedId = selection.primary;
  const setSelectedId = useCallback((id: string | null) => setSelection({ ids: id === null ? [] : [id], primary: id }), []);
  const [ui, setUi] = useState<ClientUiState>({ connection: 'idle', save: 'idle', error: null, conflict: null, revision: 0, undoDepth: 0, redoDepth: 0, external: null, problems: [] });
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  /** The bottom dock's active panel. */
  const [bottomTab, setBottomTab] = useState<BottomTab>('assets');
  /** The centre view: the editor scene or the running game. */
  const [centerTab, setCenterTab] = useState<'scene' | 'game'>('scene');
  const { sizes, splitter } = useDockSizes();
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** A dismissible message over the viewport (e.g. why Play failed). */
  const [notice, setNotice] = useState<string | null>(null);
  /** The open modal (File → Export…, Help → Shortcuts / About). */
  const [dialog, setDialog] = useState<'export' | 'shortcuts' | 'about' | 'instances' | 'exit' | null>(null);
  /** Phase 12 (c): the exit-zone dialog (a new exit, or the zone being edited). */
  const [exitForm, setExitForm] = useState<{ entityId: string | null; load: string[]; unload: string[]; spawnId: string; error: string | null }>({ entityId: null, load: [], unload: [], spawnId: '', error: null });
  /** Phase 12 (c): the scatter dialog's form (an instance set of one model). */
  const [scatter, setScatter] = useState({ assetId: '', count: '200', width: '40', depth: '8', scaleMin: '0.7', scaleMax: '1.3', randomYaw: true, seed: '1', busy: false, error: null as string | null });
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
      else if (type === 'input.request') b.requestInput(psid, String(req.requestId), req.frames as never);
      else if (type === 'game.control.request') b.requestGameControl(psid, String(req.relayId), String(req.command), typeof req.sceneId === 'string' ? req.sceneId : undefined);
      else if (type === 'game.observe.request') b.requestGameObserve(psid, String(req.relayId));
    };
  }, [playInfo]);

  // ---- packet 56: M3 gameplay authoring (game config / zones / camera / settings) ---
  const [gameplayTool, setGameplayTool] = useState<ZoneTool | null>(null);
  const [gameplayError, setGameplayError] = useState<GameplayBackendError | null>(null);
  const [gameConfig, setGameConfig] = useState<GameConfigLike | null>(null);
  const [gameConfigLoaded, setGameConfigLoaded] = useState(false);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  /** Phase 12 (b): the project tag registry and the last setTags error. */
  const [tags, setTags] = useState<{ bit: number; name: string }[]>([]);
  /** Phase 12 (c): the open scenes' headers and the closed scenes (a v4 project with scenes). */
  const [sceneHeaders, setSceneHeaders] = useState<SceneHeaderView[] | null>(null);
  const [closedScenes, setClosedScenes] = useState<{ sceneId: string; name: string }[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const zoneGestureRef = useRef<{ gesture: ZoneGesture; anchor: { x: number; y: number }; tool: ZoneTool | null } | null>(null);

  // ---- packet 27: content browser + local snapping -------------------------
  const [assets, setAssets] = useState<AssetView[]>([]);
  /** Tile previews (`${assetId}|${piece}` → object URL) and each model file's pieces. */
  const [assetThumbs, setAssetThumbs] = useState<ReadonlyMap<string, string>>(new Map());
  const [assetPieces, setAssetPieces] = useState<ReadonlyMap<string, readonly { name: string }[]>>(new Map());
  const thumbnailsRef = useRef<ThumbnailRenderer | null>(null);
  const materialLibraryRef = useRef<MaterialLibrary | null>(null);
  const materialsKeyRef = useRef('');
  const environmentKeyRef = useRef('');
  const lightingKeyRef = useRef('');
  const loadTextureRef = useRef<((assetId: string) => Promise<THREE.Texture | null>) | null>(null);
  /** Phase 9.4: the project materials and the environment, for the panels. */
  const [materials, setMaterials] = useState<MaterialDef[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentConfig | null>(null);
  const [lighting, setLighting] = useState<Record<string, LightingBake>>({});
  // Phase 9.7: the animator controllers.
  const [animators, setAnimators] = useState<AnimatorController[]>([]);
  const [animatorError, setAnimatorError] = useState<string | null>(null);
  // Phase 9.8: the input actions (null = the defaults).
  const [inputConfig, setInputConfig] = useState<InputConfig | null>(null);
  const [inputDefaults, setInputDefaults] = useState<InputConfig>({ actions: [] });
  const [inputError, setInputError] = useState<string | null>(null);
  // Phase 9.10: the game flow (null = one level, as before).
  const [flow, setFlow] = useState<GameFlow | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowNote, setFlowNote] = useState<string | null>(null);
  // Phase 9.12: the Scene view's helpers (Gizmos menu).
  const [gizmos, setGizmos] = useState({ icons: true, lights: true, colliders: true, gameplay: true });
  useEffect(() => viewportRef.current?.setGizmos(gizmos), [gizmos]);
  const localRelaysRef = useRef(new Set<string>());
  // Phase 9.6: the Lighting window (bake settings, a running bake, its outcome).
  const [bakeSettings, setBakeSettings] = useState<BakeSettings>(DEFAULT_BAKE_SETTINGS);
  const [bakeBusy, setBakeBusy] = useState<{ text: string; fraction: number } | null>(null);
  const [bakeMessage, setBakeMessage] = useState<string | null>(null);
  const [bakeHost, setBakeHost] = useState<string | null>('checking the bake host…');
  const bakeAbortRef = useRef<AbortController | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialError, setMaterialError] = useState<string | null>(null);
  /** The material names of the selected object's model file (for the mapping editor). */
  const [selectedSourceMaterials, setSelectedSourceMaterials] = useState<string[]>([]);
  const [assetSourceMaterials, setAssetSourceMaterials] = useState<string[]>([]);
  /** Texture versions whose tile image was already fetched. */
  const textureTilesRef = useRef(new Set<string>());
  const [assetDropActive, setAssetDropActive] = useState(false);
  const [lightingMode, setLightingMode] = useState<'editor' | 'game'>('editor');
  const [assetQuery, setAssetQuery] = useState<AssetQueryState>({ total: 0, offset: 0, limit: 50, hasMore: false });
  const [importState, setImportState] = useState<AssetImportState>(initialImportState);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [assetPreview, setAssetPreview] = useState<AssetPreviewView | null>(null);
  const [snapping, setSnapping] = useState(true);
  const modelInstancesRef = useRef<ModelInstances | null>(null);
  const previewSessionRef = useRef<AssetPreviewSession | null>(null);
  const previewStageRef = useRef<PreviewStage | null>(null);
  const previewCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    previewStageRef.current?.dispose();
    previewStageRef.current = null;
    if (canvas === null) {
      modelInstancesRef.current?.clearPreview();
      previewSessionRef.current = null;
      setAssetPreview(null);
      return;
    }
    previewStageRef.current = new PreviewStage(canvas);
  }, []);
  const pendingProposalRef = useRef<{ proposal: Parameters<typeof publishArgsFromProposal>[0]; target: ImportTarget } | null>(null);
  // M3 (packet 57): the media import context the panel shows between the
  // inspect and the publish — the kind the drop decided, the inspected clip
  // names (a model proposal) and the §8.5.1 animated-reimport obligation.
  const mediaPendingRef = useRef<{ kind: 'model' | 'audio' | 'texture' | 'music'; clipNames: string[] | null; referencingEntityIds: string[] } | null>(null);
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
    setAssetPreview(null);
  }, [selectedAssetId]);
  useEffect(() => {
    snappingRef.current = snapping;
  }, [snapping]);

  // ---- packet 28: prefab copies + declared-property controls ---------------
  const [prefabSummaries, setPrefabSummaries] = useState<PrefabSummaryView[]>([]);
  const [declarations, setDeclarations] = useState<Map<string, PropertyDeclaration>>(() => new Map());
  const [selectedPrefabId, setSelectedPrefabId] = useState<string | null>(null);
  const [captureName, setCaptureName] = useState('');
  const [captureError, setCaptureError] = useState<UiError | null>(null);
  const [copyError, setCopyError] = useState<UiError | null>(null);
  const [placementError, setPlacementError] = useState<UiError | null>(null);
  const [propertyError, setPropertyError] = useState<UiError | null>(null);
  const [componentError, setComponentError] = useState<UiError | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  // Packet 34: behavior publication workflow (trust, staging, publication).
  const [behaviorViews, setBehaviorViews] = useState<BehaviorDeclarationView[]>([]);
  const [selectedBehaviorId, setSelectedBehaviorId] = useState<string | null>(null);
  const [publication, setPublication] = useState<BehaviorPublicationState>(() => initialPublicationState());
  const [sourceDraft, setSourceDraft] = useState('');
  const [behaviorError, setBehaviorError] = useState<UiError | null>(null);
  const [newBehaviorId, setNewBehaviorId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPropertyKey, setNewPropertyKey] = useState('speed');
  const [newPropertyDefault, setNewPropertyDefault] = useState('3.5');
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

  const refreshEntities = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    setEntities(c.visibleEntities());
    // Phase 12 (c): the scene headers (open scenes) and the closed scenes.
    const scenes = c.projection.scenes;
    if (scenes.length === 0) {
      setSceneHeaders(null);
      setClosedScenes([]);
    } else {
      const view = c.getSceneView();
      const counts = new Map<string, number>();
      for (const e of c.projection.listEntities()) if (e.sceneId !== undefined) counts.set(e.sceneId, (counts.get(e.sceneId) ?? 0) + 1);
      const start = new Set(c.projection.startScenes);
      setSceneHeaders(scenes.filter((r) => view.open.includes(r.sceneId)).map((r) => ({ sceneId: r.sceneId, name: r.name, start: start.has(r.sceneId), active: r.sceneId === view.active, entityCount: counts.get(r.sceneId) ?? 0 })));
      setClosedScenes(scenes.filter((r) => !view.open.includes(r.sceneId)).map((r) => ({ sceneId: r.sceneId, name: r.name })));
    }
    const assetList = c.content.listAssets();
    setAssets(assetList);
    setAssetQuery((q) => ({ ...q, total: Math.max(q.total, assetList.length) }));
    setPrefabSummaries(c.prefabs.listSummaries());
    setDeclarations(c.prefabs.declarationMap());
    setBehaviorViews([...c.prefabs.listDeclarations()]);
    // M3 (packet 56): the game block + settings map converge from the client
    // state (full states + the applied change records — the backend stays
    // the sole authority).
    setGameConfig(c.getGameConfig());
    setGameConfigLoaded(c.getGameConfigLoaded());
    setSettings(c.getSettings());
    setTags(c.getTags());
    const mats = c.getMaterials();
    const env = c.getEnvironment();
    setMaterials(mats);
    setEnvironment(env);
    const matsKey = JSON.stringify(mats);
    if (matsKey !== materialsKeyRef.current) {
      materialsKeyRef.current = matsKey;
      materialLibraryRef.current?.setMaterials(mats as unknown as MaterialDefLike[]);
    }
    materialLibraryRef.current?.setWind(env?.wind ?? null);
    const envKey = JSON.stringify(env);
    if (envKey !== environmentKeyRef.current && loadTextureRef.current !== null) {
      environmentKeyRef.current = envKey;
      viewportRef.current?.setEnvironment(env === null ? null : (env as unknown as EnvironmentLike), loadTextureRef.current);
    }
    setAnimators(c.getAnimators());
    setInputConfig(c.getInput());
    setInputDefaults(c.getInputDefaults());
    setFlow(c.getFlow());
    // Phase 9.6: the scenes' bakes (lightmaps in the Scene view with game lighting).
    const lighting = c.getLighting();
    setLighting(lighting);
    const lightingKey = JSON.stringify(lighting);
    if (lightingKey !== lightingKeyRef.current && loadTextureRef.current !== null) {
      lightingKeyRef.current = lightingKey;
      viewportRef.current?.setLightmaps(lighting as unknown as Record<string, LightingBakeLike>, loadTextureRef.current);
    }
    setUi((s) => ({ ...s, revision: c.projection.revision }));
  }, []);

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
        setCenterTab('scene');
        setPlayInfo(null);
        bridgeRef.current = null;
      },
      onRelayRequest: (req) => forwardRelayRef.current(req),
    });
    clientRef.current = client;

    const canvas = canvasRef.current!;
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
        setEntities((prev) => prev.map((e) => (e.id === id ? { ...e, position: t.position, rotation: t.rotation, scale: t.scale } : e)));
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
        const res = await client.command('setTransform', { entityId: id, transform: outcome.command.args.transform }, outcome.command.expectedRevision);
        if (res.ok) {
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
      // ---- M3 (packet 56): zone gesture routing --------------------------------
      // The overlay (viewport) reports the pointer's game-plane WORLD hits;
      // the pure ZoneGesture decides the single commit; the client issues it
      // (zero commands during the gesture, one on release, none on cancel).
      onZoneGestureBegin: (g) => {
        setGameplayError(null);
        if (g.kind === 'create') {
          const tool = g.tool;
          const role: ZoneRole = tool.kind === 'zone' ? tool.role : 'hazard';
          zoneGestureRef.current = {
            gesture: new ZoneGesture('create', client.projection.revision, { position: [g.anchor.x, g.anchor.y, 0], size: [1, 1] }, {
              role,
              ...(tool.kind === 'zone' && tool.safeSpawnId ? { safeSpawnId: tool.safeSpawnId } : {}),
            }),
            anchor: { x: g.anchor.x, y: g.anchor.y },
            tool,
          };
          return;
        }
        const e = client.projection.getEntity(g.entityId);
        if (!e) return;
        zoneGestureRef.current = {
          gesture: new ZoneGesture(
            g.kind,
            client.projection.revision,
            { position: [e.position[0] ?? 0, e.position[1] ?? 0, e.position[2] ?? 0], size: e.gameZone ? [e.gameZone.size[0], e.gameZone.size[1]] : [1, 1] },
            { entityId: g.entityId },
          ),
          anchor: { x: g.anchor.x, y: g.anchor.y },
          tool: null,
        };
      },
      onZoneGestureFrame: (hit) => {
        const zg = zoneGestureRef.current;
        if (!zg) return;
        const pose = zg.gesture.preview({ dx: hit.x - zg.anchor.x, dy: hit.y - zg.anchor.y });
        const isSpawn = zg.tool !== null && zg.tool.kind === 'spawn';
        const role = zg.tool !== null && zg.tool.kind === 'zone' ? zg.tool.role : undefined;
        viewportRef.current?.previewZonePose(pose, isSpawn, role);
      },
      onZoneGestureEnd: (hit) => {
        const zg = zoneGestureRef.current;
        if (!zg) return;
        zg.gesture.preview({ dx: hit.x - zg.anchor.x, dy: hit.y - zg.anchor.y });
        const outcome = zg.gesture.decideCommit();
        const tool = zg.tool;
        zoneGestureRef.current = null;
        if (outcome.kind !== 'commit') {
          // A finished (noop/cancelled) placement clears the one-shot tool.
          if (tool !== null) setGameplayTool(null);
          return;
        }
        // The spawn tool rides the same create gesture for position tracking;
        // the entity it creates is a spawn marker, not a zone (row 10).
        if (tool !== null && tool.kind === 'spawn' && outcome.command.op === 'createEntity') {
          const pos = outcome.command.args.transform.position;
          const args = planCreateSpawn([pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0]);
          void client.createGameEntity(args as unknown as Record<string, unknown>, zg.gesture.expectedRevision).then((res) => {
            if (res.ok) {
              setGameplayTool(null);
              refreshEntities();
              return;
            }
            setGameplayError(commandError(res));
          });
          return;
        }
        void issueZoneCommand(client, zg.gesture, outcome.command).then((r) => {
          if (r.ok) {
            if (tool !== null) setGameplayTool(null);
            refreshEntities();
            return;
          }
          setGameplayError(r.error);
        });
      },
      onZoneGestureCancel: () => {
        const zg = zoneGestureRef.current;
        if (zg) zg.gesture.cancel();
        zoneGestureRef.current = null;
        // The placement tool stays armed (Esc cancels the GESTURE, not the
        // tool — the user can try again; the panel's button disarms it).
      },
      // Phase 9.12: a dragged mover waypoint handle — one setComponent on release.
      onWaypointMoved: (entityId, index, offset) => {
        const c = clientRef.current;
        if (!c) return;
        const e = c.projection.listEntities().find((x) => x.id === entityId);
        const waypoints = (e?.blocks?.mover as { waypoints?: number[][] } | undefined)?.waypoints;
        if (waypoints === undefined || index < 1 || index > waypoints.length) return;
        const next = waypoints.map((w, i) => (i === index - 1 ? offset.map((v) => Math.round(v * 1000) / 1000) : w));
        void c.setComponent(entityId, 'mover', { waypoints: next }, c.projection.revision).then((r) => reportFailure('Mover path', r));
      },
      // Phase 14.0: a dragged size handle (capsule, area, box collider, fog volume) — one setComponent on release.
      onSizeHandleMoved: (entityId, component, value) => {
        const c = clientRef.current;
        if (!c) return;
        void c.setComponent(entityId, component, value, c.projection.revision).then((r) => {
          // A drag that ends where it began changes nothing: not an error.
          if (!r.ok && (r.response as { code?: string }).code === 'no_change') return;
          reportFailure(component === 'controller' ? 'Collision capsule' : 'Size', r);
        });
      },
    }, { snapping: () => snappingRef.current && !shiftRef.current });
    viewportRef.current = viewport;
    // Packet 27: one shared GLB realization path for placements + preview. The
    // resolver is the editor's authenticated byte read; the renderer never
    // receives the token (sessions.md §16.1).
    // Phase 9.4: project materials (shared by boxes, models and instance sets).
    const loadTextureAsset = async (assetId: string): Promise<THREE.Texture | null> => {
      const v = client.content.resolveVersion(assetId);
      if (v === null) return null;
      const bytes = await client.assetBytes(assetId, v.version);
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      t.needsUpdate = true;
      return t;
    };
    loadTextureRef.current = loadTextureAsset;
    const materialLibrary = createMaterialLibrary({
      loadTexture: loadTextureAsset,
      onChange: () => viewport.requestRender(),
    });
    materialLibraryRef.current = materialLibrary;
    viewport.setMaterialLibrary(materialLibrary);
    const models = new ModelInstances(viewport.scene, {
      resolve: client.assetByteResolver(),
      descriptorFor: (assetId) => {
        const v = client.content.resolveVersion(assetId);
        if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) return null;
        return { assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength };
      },
      onChanged: () => {
        viewport.refreshLightmaps();
        viewport.requestRender();
      },
      parentFor: (entityId) => viewport.objectFor(entityId),
      resolveBuffer: (digest) => client.instanceBufferBytes(digest),
      vertexColorsFor: (assetId) => (client.content.getAsset(assetId)?.vertexColors === 'tint' ? 'tint' : 'data'),
      materialLibrary,
      assetMaterialsFor: (assetId) => client.content.getAsset(assetId)?.materials ?? null,
      onFailuresChanged: (failures) =>
        setViewFailures([...failures].map(([id, f]) => ({ id, name: client.content.getAsset(id)?.displayName ?? id, code: f.code, message: f.message }))),
    });
    viewport.setModelInstances(models);
    modelInstancesRef.current = models;
    const thumbnails = new ThumbnailRenderer({
      read: (digest, piece) => client.thumbnail(digest, piece),
      store: (digest, piece, png) => client.storeThumbnail(digest, piece, png),
      prepared: (assetId) => models.prepared(assetId),
      vertexColorsFor: (assetId) => (client.content.getAsset(assetId)?.vertexColors === 'tint' ? 'tint' : 'data'),
    });
    thumbnailsRef.current = thumbnails;
    viewport.resize();
    void client.connect();
    refreshEntities();

    const onResize = (): void => viewport.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      client.dispose();
      thumbnails.dispose();
      thumbnailsRef.current = null;
      materialLibrary.dispose();
      materialLibraryRef.current = null;
      models.dispose();
      viewport.dispose();
      modelInstancesRef.current = null;
      previewSessionRef.current = null;
      clientRef.current = null;
      viewportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A ref mirror of selectedId for the viewport callbacks (stable closure).
  const selectedIdRef = useRef<string | null>(null);
  const selectionRef = useRef<string[]>([]);
  useEffect(() => {
    selectionRef.current = selection.ids;
  }, [selection]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // A ref mirror of the armed zone tool (stable-closure Esc handler, packet 56).
  const gameplayToolRef = useRef<ZoneTool | null>(null);
  useEffect(() => {
    gameplayToolRef.current = gameplayTool;
  }, [gameplayTool]);

  // Push the projection into the viewport (packet 27: placements must be
  // visible; the viewport renders the projection, never the reverse). The
  // first non-empty scene is framed so a large level is in view on open.
  // Model assets: load each file once to learn its pieces, and fetch (or
  // render and cache) a tile preview for the file and each of its pieces. A
  // changed asset option (vertex colours) rebuilds the placed instances.
  useEffect(() => {
    const c = clientRef.current;
    const models = modelInstancesRef.current;
    const thumbs = thumbnailsRef.current;
    if (!c || !models || !thumbs) return;
    viewportRef.current?.syncEntities(c.visibleEntities());
    let cancelled = false;
    for (const a of assets) {
      if (a.kind === 'texture') {
        // A texture's tile is the image itself (its own bytes, no render).
        const key = thumbnailKey(a.assetId, null);
        const v = c.content.resolveVersion(a.assetId);
        if (v === null || textureTilesRef.current.has(`${a.assetId}@${v.version}`)) continue;
        textureTilesRef.current.add(`${a.assetId}@${v.version}`);
        void c.assetBytes(a.assetId, v.version).then(
          (bytes) => {
            if (cancelled) return;
            const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
            setAssetThumbs((prev) => {
              const old = prev.get(key);
              if (old !== undefined) URL.revokeObjectURL(old);
              return new Map(prev).set(key, url);
            });
          },
          () => undefined,
        );
        continue;
      }
      if (a.kind !== 'model') continue;
      const digest = c.content.resolveVersion(a.assetId)?.sourceDigest ?? '';
      if (!/^[0-9a-f]{64}$/.test(digest)) continue;
      const show = (piece: string | null): void => {
        void thumbs.url(a.assetId, digest, piece).then((url) => {
          if (cancelled || url === null) return;
          setAssetThumbs((prev) => (prev.get(thumbnailKey(a.assetId, piece)) === url ? prev : new Map(prev).set(thumbnailKey(a.assetId, piece), url)));
        });
      };
      show(null);
      void models.prepared(a.assetId).then((resource) => {
        if (cancelled || resource === null) return;
        const pieces = resource.pieces().map((pc) => ({ name: pc.name }));
        setAssetPieces((prev) => new Map(prev).set(a.assetId, pieces));
        if (pieces.length >= 2) for (const pc of pieces) show(pc.name);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [assets]);

  // Phase 9.4: animated materials (wind, water) need frames while they are in view.
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = (): void => {
      const lib = materialLibraryRef.current;
      if (lib !== null && lib.animated()) {
        lib.tick((performance.now() - start) / 1000);
        viewportRef.current?.requestRender();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const framedRef = useRef(false);
  useEffect(() => {
    viewportRef.current?.syncEntities(entities);
    const lit = viewportRef.current?.getLighting();
    if (lit !== undefined) setLightingMode(lit);
    if (!framedRef.current && entities.length > 0) {
      framedRef.current = true;
      viewportRef.current?.frameAll(entities);
    }
  }, [entities]);

  // Local snapping is a gesture option: default on, Shift disables it for the
  // gesture in flight (never persisted — sessions.md §9). Esc cancels the
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
      if (!typing) {
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
          if (e.key === 'Escape' && gameplayToolRef.current === null && selectedIdRef.current !== null) {
            setSelectedId(null);
            return;
          }
        }
      }
      // M3 (packet 56): with no gesture in flight, Esc clears the armed zone
      // placement tool (nothing is sent either way).
      if (e.key === 'Escape' && gameplayToolRef.current !== null) {
        setGameplayTool(null);
        viewportRef.current?.setZoneTool(null);
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
  }, []);

  // Selection → gizmo, and to the backend (tools can inspect the selection).
  useEffect(() => {
    viewportRef.current?.setSelected(selectedId, gizmoMode);
  }, [selectedId, gizmoMode]);
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
      // M4 (packet 70, D-63-4 repair): the editor presented the preview and
      // received its `tl.ready` → send the WS `play.preview.ready` exactly
      // once (sessions.md §10.2); the backend marks the play `presented`
      // (lifting the 15 s present-timeout).
      clientRef.current?.sendPlayPreviewReady(playInfo.playSessionId);
    });
    bridge.on('tl.stopped', () => {
      setPlaying(false);
      setPlayInfo(null);
    });
    // M4 (packet 70, D-63-4 repair — failure side): the preview could not
    // start → relay it over WS (`play.preview.failed`, sessions.md §10.2);
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
      ack({ type: 'play.diagnostics.ack', relayId: r.relayId, ...outcome(r, ['diagnostics']) });
    });
    bridge.on('tl.input.result', (m) => {
      const r = m as Record<string, unknown>;
      ack({ type: 'input.result', requestId: r.requestId, ...outcome(r, ['appliedFromStep', 'appliedToStep']) });
    });
    bridge.on('tl.game.control.result', (m) => {
      const r = m as Record<string, unknown>;
      // Phase 9.11: the editor's own requests (clear the Play save) are not the backend's relays.
      if (localRelaysRef.current.delete(String(r.relayId))) {
        setFlowNote(r.ok === true ? 'The Play save was cleared (restart Play to see the title without Continue).' : 'Clearing the Play save failed.');
        return;
      }
      ack({ type: 'game.control.ack', relayId: r.relayId, ...outcome(r, ['result']) });
    });
    bridge.on('tl.game.observe.result', (m) => {
      const r = m as Record<string, unknown>;
      ack({ type: 'game.observe.ack', relayId: r.relayId, ...outcome(r, ['result']) });
    });

    const onLoad = (): void => {
      // §13.4: the editor holds the retained play.started snapshot; on the
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, []);
  const del = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !selectedIdRef.current) return;
    // Phase 12: every selected subtree (one deleteEntity each; a child of a
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
    [reportFailure],
  );
  const createEmpty = useCallback(() => createEntityAt('Create empty', { kind: 'group', name: `entity-${Date.now() % 10000}` }), [createEntityAt]);
  const createCamera = useCallback(
    () => createEntityAt('Create camera', { kind: 'group', name: 'Camera', components: { camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } }, [0, 4, 12]),
    [createEntityAt],
  );
  const createLight = useCallback(
    (type: 'directional' | 'ambient' | 'point' | 'spot' | 'hemisphere') =>
      createEntityAt(
        `Create ${type} light`,
        type === 'directional'
          ? { kind: 'group', name: 'Directional light', components: { light: { type, color: '#fff4e0', intensity: 1.6, direction: [0.4, -1, -0.6], castShadow: true } } }
          : type === 'ambient'
            ? { kind: 'group', name: 'Ambient light', components: { light: { type, color: '#8a94b0', intensity: 0.9 } } }
            : type === 'point'
              ? { kind: 'group', name: 'Point light', components: { light: { type, color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } } }
              : type === 'spot'
                ? { kind: 'group', name: 'Spot light', components: { light: { type, color: '#ffffff', intensity: 80, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0] } } }
                : { kind: 'group', name: 'Hemisphere light', components: { light: { type, color: '#bcd7ff', groundColor: '#5a4a38', intensity: 0.8 } } },
        type === 'directional' ? [0, 10, 0] : type === 'ambient' || type === 'hemisphere' ? [0, 0, 0] : undefined,
      ),
    [createEntityAt],
  );
  /** Phase 9.5: a fog volume edit (a partial value). */
  const saveFogVolume = useCallback(async (entityId: string, patch: Record<string, unknown>) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Fog volume', await c.setComponent(entityId, 'fogVolume', patch, c.projection.revision));
  }, [reportFailure]);
  /** Phase 9.5: a light edit (a partial value; null removes an optional field). */
  const saveLightPatch = useCallback(async (entityId: string, patch: Record<string, unknown>) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Light', await c.setComponent(entityId, 'light', patch, c.projection.revision));
  }, [reportFailure]);
  /** Phase 9.9: a gameplay component edit (a partial value; null removes the component). */
  const saveBlock = useCallback(async (entityId: string, component: string, value: Record<string, unknown> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure(component, await c.setComponent(entityId, component, value, c.projection.revision));
  }, [reportFailure]);
  const createSpawn = useCallback(() => createEntityAt('Create player spawn', { kind: 'group', name: 'Player spawn', components: { playerSpawn: {} } }), [createEntityAt]);

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
  }, [reportFailure, selectionValues]);

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
  }, [reportFailure]);
  const editRef = useRef({ duplicate, copySelection, paste });
  editRef.current = { duplicate, copySelection, paste };

  /** Component menu: set (or remove with null) one component on the selection. */
  const setComponentOnSelection = useCallback(
    async (component: string, value: unknown) => {
      const c = clientRef.current;
      const id = selectedIdRef.current;
      if (!c || !id) return;
      const res = await c.setComponent(id, component, value, c.projection.revision);
      if (!res.ok) reportFailure(value === null ? `Remove ${component}` : `Add ${component}`, res);
      else refreshEntities();
    },
    [reportFailure, refreshEntities],
  );

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
  /** Phase 12: file entities (with their subtrees) under a parent, before a sibling or at the end. */
  const move = useCallback(async (entityIds: string[], parentId: string | null, beforeId: string | null) => {
    const c = clientRef.current;
    if (!c || entityIds.length === 0) return;
    const res = await c.command('moveEntities', { entityIds, parentId, ...(beforeId !== null ? { beforeId } : {}) }, c.projection.revision);
    // Dropping something where it already is changes nothing; not an error.
    if (!res.ok && (res.response as { code?: string }).code === 'no_change') return;
    reportFailure('Move', res);
  }, [reportFailure]);
  /** Phase 12 (c): create or edit an exit zone (scenes to load/unload, the spawn to move the player to). */
  const saveExit = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    if (exitForm.load.length === 0 && exitForm.unload.length === 0) {
      setExitForm((f) => ({ ...f, error: 'choose at least one scene to load or unload' }));
      return;
    }
    const fields = { load: exitForm.load, unload: exitForm.unload };
    if (exitForm.entityId === null) {
      await createEntityAt('Exit zone', {
        kind: 'group',
        name: 'Exit',
        components: { gameZone: { role: 'exit', size: [2, 3], ...fields, ...(exitForm.spawnId !== '' ? { spawnId: exitForm.spawnId } : {}) } },
      });
      setDialog(null);
      return;
    }
    const res = await c.setComponent(exitForm.entityId, 'gameZone', { ...fields, spawnId: exitForm.spawnId !== '' ? exitForm.spawnId : null }, c.projection.revision);
    if (!res.ok) {
      setExitForm((f) => ({ ...f, error: (res.response as { message?: string }).message ?? 'the exit could not be saved' }));
      return;
    }
    setDialog(null);
  }, [exitForm, createEntityAt]);
  /** Phase 12 (c): scatter copies of one model into a new instance set at the point the camera looks at. */
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
    const published = await c.publishInstanceBuffer(scatterTransforms(opts));
    if (!published.ok) {
      setScatter((f) => ({ ...f, busy: false, error: published.error.message }));
      return;
    }
    const name = `${c.content.getAsset(scatter.assetId)?.displayName ?? 'Model'} ×${published.count}`;
    await createEntityAt('Instance set', { kind: 'group', name, components: { instances: { asset: { assetId: scatter.assetId }, buffer: published.digest, count: published.count } } });
    setScatter((f) => ({ ...f, busy: false }));
    setDialog(null);
  }, [scatter, createEntityAt]);
  /** Phase 12 (c): the scene controls (headers, new/open) — index ops are commands, open/active are local. */
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
  /** Phase 12 (b): replace the tag registry (one setTags command). */
  const saveTags = useCallback(async (next: { bit?: number; name: string }[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setTags', { tags: next }, c.projection.revision);
    if (res.ok) setTagsError(null);
    else setTagsError((res.response as { message?: string }).message ?? 'the tags could not be saved');
  }, []);
  /** Phase 12 (b): set an entity's own tags, by name. */
  const setEntityTags = useCallback(async (entityId: string, names: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Set tags', await c.command('updateEntity', { entityId, tags: names }, c.projection.revision));
  }, [reportFailure]);
  /** Phase 12: set one hierarchy flag (active / locked / static) on an entity. */
  const setFlag = useCallback(async (entityId: string, flag: 'active' | 'locked' | 'static', value: boolean) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure(`Set ${flag}`, await c.command('updateEntity', { entityId, [flag]: value }, c.projection.revision));
  }, [reportFailure]);
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
  const play = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const r = await c.playStart(false);
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

  // ---- packet 56: M3 gameplay authoring actions (all delegated to the
  // backend through the ordinary command path; one command per action) ------

  const armZoneTool = useCallback((tool: ZoneTool | null) => {
    setGameplayTool(tool);
    setGameplayError(null);
    viewportRef.current?.setZoneTool(tool);
  }, []);

  const saveGameConfig = useCallback(
    async (game: Record<string, unknown> | null) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const res = await c.setGameConfig(game, c.projection.revision);
      if (res.ok) {
        refreshEntities();
        return;
      }
      setGameplayError(commandError(res));
    },
    [refreshEntities],
  );

  const addZone = useCallback(
    async (role: ZoneRole, safeSpawnId: string | null) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const plan = planCreateZone({ role, size: DEFAULT_ZONE_SIZE[role], position: [0, 0, 0], safeSpawnId: safeSpawnId ?? undefined });
      if (!plan.ok) {
        setGameplayError({ code: plan.error.code, message: plan.error.message });
        return;
      }
      const res = await c.createGameEntity(plan.args as unknown as Record<string, unknown>, c.projection.revision);
      if (res.ok) {
        refreshEntities();
        return;
      }
      setGameplayError(commandError(res));
    },
    [refreshEntities],
  );

  const editZone = useCallback(
    async (entityId: string, next: { role?: ZoneRole; size?: [number, number]; safeSpawnId?: string }) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const zone = c.projection.getEntity(entityId)?.gameZone;
      if (!zone) return;
      const plan = planEditZone(entityId, zone, next);
      if (plan.kind === 'noop') return;
      // The steps are issued sequentially (the two-step checkpoint role
      // switch advances the revision between them); each step is one
      // undoable command.
      let rev = c.projection.revision;
      for (const step of plan.steps) {
        const res = await c.setComponent(step.args.entityId, step.args.component, step.args.value, rev);
        if (!res.ok) {
          setGameplayError(commandError(res));
          return;
        }
        rev = res.revision;
      }
      refreshEntities();
    },
    [refreshEntities],
  );

  const deleteZone = useCallback(
    async (entityId: string) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const res = await c.deleteEntityCommand(entityId, c.projection.revision);
      if (res.ok) {
        refreshEntities();
        return;
      }
      setGameplayError(commandError(res));
    },
    [refreshEntities],
  );

  const addSpawn = useCallback(
    async () => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const args = planCreateSpawn([0, 0, 0]);
      const res = await c.createGameEntity(args as unknown as Record<string, unknown>, c.projection.revision);
      if (res.ok) {
        refreshEntities();
        return;
      }
      setGameplayError(commandError(res));
    },
    [refreshEntities],
  );

  const deleteSpawn = useCallback(deleteZone, [deleteZone]);

  const saveCameraFollow = useCallback(
    async (entityId: string, value: Record<string, unknown> | null) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const res = await c.setComponent(entityId, 'cameraFollow', value, c.projection.revision);
      if (res.ok) {
        refreshEntities();
        return;
      }
      setGameplayError(commandError(res));
    },
    [refreshEntities],
  );

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

  // ---- packet 57: M3 media / lighting / animation authoring -----------------
  const [mediaError, setMediaError] = useState<GameplayBackendError | null>(null);
  // The cue PREVIEW owner (the packet's "injected owner"): one per session,
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

  const mediaCommandResult = useCallback((res: { ok: boolean; response?: { ok?: boolean; code?: string; message?: string } }, onOk: () => void): void => {
    if (res.ok) {
      onOk();
      return;
    }
    const r = res.response as { ok?: boolean; code?: string; message?: string } | undefined;
    setMediaError({ code: r?.code ?? 'network', message: r?.message ?? r?.code ?? 'the media command was rejected' });
  }, []);

  const saveCues = useCallback(
    async (args: { cues: Record<string, string | null> }) => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const res = await c.setGameConfig(args as Record<string, unknown>, c.projection.revision);
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  const addLight = useCallback(
    async (type: 'directional' | 'ambient') => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const light =
        type === 'directional'
          ? { type: 'directional', color: '#ffffff', intensity: 2, direction: [0.35, -1, 0.55], castShadow: false }
          : { type: 'ambient', color: '#ffffff', intensity: 0.5 };
      const res = await c.createGameEntity(
        {
          kind: 'group',
          name: type === 'directional' ? 'key-light' : 'fill-light',
          transform: { position: [0, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          components: { light },
        },
        c.projection.revision,
      );
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  const saveLight = useCallback(
    async (entityId: string, value: Record<string, unknown>) => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const res = await c.setComponent(entityId, 'light', value, c.projection.revision);
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  const saveSurface = useCallback(
    async (entityId: string, value: Record<string, unknown>) => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const res = await c.setComponent(entityId, 'surface', value, c.projection.revision);
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  const applyPreset = useCallback(
    async (entityId: string, preset: string) => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const res = await c.command('applySurfacePreset', { entityId, preset }, c.projection.revision);
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  const saveAnimation = useCallback(
    async (entityId: string, value: Record<string, unknown>) => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const res = await c.setComponent(entityId, 'modelAnimation', value, c.projection.revision);
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  const saveActivation = useCallback(
    async (entityId: string, value: Record<string, unknown>) => {
      const c = clientRef.current;
      if (!c) return;
      setMediaError(null);
      const res = await c.setComponent(entityId, 'gameZone', value, c.projection.revision);
      mediaCommandResult(res, () => {
        refreshEntities();
      });
    },
    [refreshEntities, mediaCommandResult],
  );

  // ---- phase 10: assets referenced in place in the game folder -------------
  // A folder project can import files where they are; Problems shows the ones
  // whose bytes changed since import. The check runs when the editor connects,
  // when the window gets focus back (e.g. after a Blender rebuild), after each
  // publish and on "check files"; Play and export verify on every read anyway.
  const [folderProject, setFolderProject] = useState(false);
  const [sourceIssues, setSourceIssues] = useState<SourceIssue[] | null>(null);
  const [checkingFiles, setCheckingFiles] = useState(false);
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
  const checkFiles = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setCheckingFiles(true);
    const r = await c.contentIntegrity();
    setCheckingFiles(false);
    if (!r.ok) return;
    const names = new Map(c.content.listAssets().map((a) => [a.assetId, a.displayName]));
    setSourceIssues(sourceIssuesFrom(r.entries, names));
  }, []);
  useEffect(() => {
    if (ui.connection !== 'connected') return;
    const c = clientRef.current;
    if (!c) return;
    let live = true;
    void c.listProjectFiles('').then((r) => {
      if (!live) return;
      setFolderProject(r.ok);
      if (r.ok) void checkFiles();
      else setSourceIssues(null);
    });
    return () => {
      live = false;
    };
  }, [ui.connection, checkFiles]);
  useEffect(() => {
    if (!folderProject) return;
    const onFocus = (): void => void checkFiles();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [folderProject, checkFiles]);

  /** After an inspect: remember the proposal and the §8.5.1 role-mapping obligation.
   * Returns whether the publish needs no role mapping. */
  const acceptProposal = useCallback((proposal: Parameters<typeof publishArgsFromProposal>[0], target: ImportTarget, kind: 'model' | 'audio' | 'texture' | 'music'): boolean => {
    const c = clientRef.current;
    if (!c) return false;
    pendingProposalRef.current = { proposal, target };
    const inspection = (proposal.proposal as { inspection?: { clipNames?: unknown } } | null)?.inspection;
    const clipNames = Array.isArray(inspection?.clipNames) ? (inspection.clipNames as unknown[]).filter((x): x is string => typeof x === 'string') : null;
    // §8.5.1: a model reimport whose asset is referenced by modelAnimation
    // components MUST carry the atomic `animation` — the panel collects the
    // new version's role bindings before the publish is enabled.
    const referencingEntityIds =
      kind === 'model' && target.mode === 'reimport'
        ? c.projection.listEntities().filter((e) => e.modelAnimation !== undefined && e.modelAnimation.assetId === target.assetId).map((e) => e.id)
        : [];
    mediaPendingRef.current = { kind, clipNames, referencingEntityIds };
    if (target.mode === 'reimport') {
      setReimportRoles({ idle: '', run: '', airborne: '' });
      setReimportEntity(referencingEntityIds[0] ?? '');
    }
    setSelectedAssetId(target.assetId);
    return referencingEntityIds.length === 0;
  }, []);

  const importFile = useCallback(async (file: File, mode: 'create' | 'reimport') => {
    const c = clientRef.current;
    if (!c) return;
    // M3 (packet 57): the extension decides the kind (`.glb` model / `.wav`
    // audio); an invalid drop creates no stage and no job.
    const candidate = validateMediaDrop(file.name, file.size);
    if (!candidate.ok) {
      setImportState(importFailed(initialImportState, candidate.error));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const target: ImportTarget =
      mode === 'reimport'
        ? { mode: 'reimport', assetId: selectedAssetIdRef.current, displayName: null }
        : { mode: 'create', assetId: makeAssetId(), displayName: candidate.displayName };
    const res = await c.uploadAsset(bytes, { target, displayName: candidate.displayName, kind: candidate.kind, onState: setImportState });
    if (res.ok) {
      acceptProposal(res.proposal, target, candidate.kind);
    } else {
      pendingProposalRef.current = null;
      mediaPendingRef.current = null;
    }
  }, [acceptProposal]);

  /** Import from the project folder: the file is inspected in place, never copied.
   * Returns whether the proposal can be published without a role mapping. */
  const importFromFolder = useCallback(async (path: string, mode: 'create' | 'reimport', assetId: string | null): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const candidate = validateMediaDrop(path.slice(path.lastIndexOf('/') + 1), 1);
    if (!candidate.ok) {
      setImportState(importFailed(initialImportState, candidate.error));
      return false;
    }
    const target: ImportTarget =
      mode === 'reimport' ? { mode: 'reimport', assetId, displayName: null } : { mode: 'create', assetId: makeAssetId(), displayName: candidate.displayName };
    const res = await c.importProjectFile(path, {
      target,
      kind: candidate.kind,
      displayName: candidate.displayName,
      onState: (st) => {
        importStateRef.current = st;
        setImportState(st);
      },
    });
    if (!res.ok) {
      pendingProposalRef.current = null;
      mediaPendingRef.current = null;
      return false;
    }
    return acceptProposal(res.proposal, target, candidate.kind);
  }, [acceptProposal]);

  /** M3 (packet 57): the §8.5.1 `animation` args for the pending reimport, or
   * `null` (a create / an audio reimport / a model reimport with no referencing
   * entities). `complete` reports whether the role draft is ready (all three
   * bindings named) — the publish is disabled until it is. */
  const animatedReimportArgs = useCallback((): { animation: { entityId: string; roles: unknown } | null; complete: boolean } => {
    const pending = pendingProposalRef.current;
    const media = mediaPendingRef.current;
    if (pending === null || media === null) return { animation: null, complete: true };
    if (pending.target.mode !== 'reimport' || media.kind !== 'model' || media.referencingEntityIds.length === 0) return { animation: null, complete: true };
    const clipNames = media.clipNames ?? [];
    const roles = {} as Record<string, { clipIndex: number; clipName: string } >;
    for (const k of ['idle', 'run', 'airborne'] as AnimationRoleKey[]) {
      const name = reimportRoles[k].trim();
      const idx = clipNames.indexOf(name);
      roles[k] = { clipIndex: idx >= 0 ? idx : 0, clipName: name };
    }
    const complete = (['idle', 'run', 'airborne'] as AnimationRoleKey[]).every((k) => reimportRoles[k].trim() !== '') && reimportEntity !== '' && media.referencingEntityIds.includes(reimportEntity);
    return { animation: complete ? { entityId: reimportEntity, roles } : null, complete };
  }, [reimportRoles, reimportEntity]);

  const publish = useCallback(async () => {
    const c = clientRef.current;
    const pending = pendingProposalRef.current;
    const media = mediaPendingRef.current;
    if (!c || !pending || !media) return;
    const animated = animatedReimportArgs();
    if (!animated.complete) return; // the panel keeps the publish disabled
    const args = publishArgsFromProposal(pending.proposal, pending.target, utcSecondTimestamp(), media.kind, animated.animation ?? undefined);
    if (!args.ok) {
      setImportState(importFailed(importStateRef.current, args.error));
      return;
    }
    let s = c.markPublishing(importStateRef.current);
    setImportState(s);
    // Exactly one publishAsset command; the catalog advances only through the
    // applied `mutation.applied` change (never a local write). A rejected
    // reimport (stale job, limits, role range/mismatch) preserves the old
    // version AND the old animation component (the command is all-or-nothing).
    const res = await c.command('publishAsset', args.args, c.projection.revision);
    if (res.ok) {
      s = c.markCommitted(s);
      setImportState(s);
      pendingProposalRef.current = null;
      mediaPendingRef.current = null;
      await c.fullResync();
      refreshEntities();
      if (args.args.sourcePath !== undefined || args.args.convertedFrom !== undefined) void checkFiles();
    } else {
      const response = res.response;
      setImportState(importFailed(s, response.ok === false ? { code: response.code, message: response.message ?? response.code } : { code: 'network', message: 'the command response was lost' }));
    }
  }, [refreshEntities, animatedReimportArgs, checkFiles]);

  /** Problems → Re-import: a new version from the same file, published at once
   * unless the asset's animation needs a role mapping (then the Assets tab asks). */
  const reimportIssue = useCallback(
    async (issue: SourceIssue) => {
      const ready = await importFromFolder(issue.sourcePath, 'reimport', issue.assetId);
      if (ready) await publish();
      else setBottomTab('assets');
    },
    [importFromFolder, publish],
  );

  const cancelImportFlow = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const s = c.cancelImport(importStateRef.current);
    setImportState(s);
    pendingProposalRef.current = null;
    mediaPendingRef.current = null;
    if (s.stageId) {
      try {
        await c.discardStage(s.stageId);
      } catch {
        /* the stage TTL bounds an abandoned stage */
      }
    }
  }, []);

  const discardImportFlow = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const stageId = importStateRef.current.stageId;
    setImportState(c.resetImport(importStateRef.current));
    pendingProposalRef.current = null;
    mediaPendingRef.current = null;
    if (stageId) {
      try {
        await c.discardStage(stageId);
      } catch {
        /* already discarded / expired */
      }
    }
  }, []);

  // Phase 9.7: the Animator window's live preview — the controller's model in
  // its own small stage, posed every frame by the runtime's state machine.
  const previewAnimator = useCallback(async (controller: AnimatorController, canvas: HTMLCanvasElement): Promise<AnimatorPreview | string> => {
    const c = clientRef.current;
    const m = modelInstancesRef.current;
    if (!c || !m) return 'the editor is not ready';
    // The model the clips are for: the first clip's asset, or the rig of an animation-only asset (phase 14.6).
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
    const tick = (now: number): void => {
      machine.step(Math.min(0.1, Math.max(0, (now - last) / 1000)));
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

  const loadPreview = useCallback(async (assetId: string) => {
    const c = clientRef.current;
    const m = modelInstancesRef.current;
    if (!c || !m) return;
    const v = c.content.resolveVersion(assetId);
    if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) {
      setImportState(importFailed(importStateRef.current, { code: 'asset_not_found', message: `no immutable version facts for ${assetId}` }));
      return;
    }
    const stage = previewStageRef.current;
    const res = await m.previewAsset(
      { assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength },
      stage?.scene,
    );
    if (res.ok) stage?.frame(res.session.root);
    if (!res.ok) {
      setImportState(importFailed(importStateRef.current, { code: res.code, message: res.message }));
      return;
    }
    previewSessionRef.current = res.session;
    setAssetPreview({ assetId, clips: res.session.clips, clipIndex: null, playing: false, timeSeconds: 0, durationSeconds: 0 });
  }, []);

  const publishPreviewState = useCallback(() => {
    const s = previewSessionRef.current?.controller.state();
    if (!s) return;
    setAssetPreview((p) => (p ? { ...p, playing: s.playing, clipIndex: s.clipIndex, timeSeconds: s.timeSeconds, durationSeconds: s.durationSeconds } : p));
  }, []);

  const previewPlay = useCallback(() => {
    const ctrl = previewSessionRef.current?.controller;
    if (!ctrl) return;
    ctrl.play();
    publishPreviewState();
  }, [publishPreviewState]);

  const previewPause = useCallback(() => {
    const ctrl = previewSessionRef.current?.controller;
    if (!ctrl) return;
    ctrl.pause();
    publishPreviewState();
  }, [publishPreviewState]);

  const previewScrub = useCallback(
    (seconds: number) => {
      const ctrl = previewSessionRef.current?.controller;
      if (!ctrl) return;
      ctrl.scrub(seconds);
      publishPreviewState();
    },
    [publishPreviewState],
  );

  // The host owns the preview frame loop (the controller installs none).
  useEffect(() => {
    if (!assetPreview?.playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      modelInstancesRef.current?.updatePreview(dt);
      publishPreviewState();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [assetPreview?.playing, publishPreviewState]);

  const placement = selectedAssetId !== null ? planAssetPlacement(selectedAssetId) : null;

  // ---- packet 28: prefab capture / copy / property edit ---------------------

  /**
   * Issue one typed prefab/property command with the contract's client
   * recovery (commands.md §5.5/§6.4): a `revision_conflict` re-reads the state
   * and re-issues ONCE with a fresh requestId; a backend-rejected instance
   * limit or any other failure is surfaced with its exact bound (never
   * swallowed).
   */
  const runTypedCommand = useCallback(
    async (op: string, args: unknown, onError: (e: UiError) => void): Promise<boolean> => {
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
        onError({ code: r.code, message: recovery.message });
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
    const displayName = c.content.listAssets().find((a) => a.assetId === assetId)?.displayName;
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
      const pieces: PieceFacts[] = resource.pieces().map((pc) => ({ name: pc.name, bounds: box(pc.name), collider: pc.hasCollider ? resource.collider2D(pc.name) : null, skinned: pc.skinned }));
      const { args } = planModelDrop({
        assetId: payload.assetId,
        displayName: asset.displayName,
        ...(payload.piece !== undefined ? { piece: payload.piece } : {}),
        pieces,
        wholeCollider: pieces.length === 1 ? resource.collider2D(null) : null,
        position,
        parentId,
      });
      setPlacementError(null);
      const res = await c.command('createEntity', args, c.projection.revision);
      if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
      else if (!res.ok) setPlacementError({ code: (res.response as { code?: string }).code ?? 'command_failed', message: (res.response as { message?: string }).message ?? 'the model could not be placed' });
      reportFailure(`Place ${asset.displayName}`, res);
    },
    [reportFailure],
  );

  // ---- phase 9.4: materials, their assignment, the environment ---------------
  const refusal = (res: Awaited<ReturnType<SessionClient['command']>>): string | null =>
    res.ok ? null : ((res.response as { message?: string; code?: string }).message ?? (res.response as { code?: string }).code ?? 'the edit was refused');
  const saveMaterial = useCallback(async (material: MaterialDef) => {
    const c = clientRef.current;
    if (!c) return;
    setMaterialError(refusal(await c.command('setMaterial', { material }, c.projection.revision)));
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
      setBakeMessage(`Baked ${r.bake.entries.length} objects in ${(r.millis / 1000).toFixed(1)} s${r.skipped.length > 0 ? `; ${r.skipped.length} static object(s) have no lightmap UV (UV1) and only cast shadows` : ''}.`);
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
  const saveFlow = useCallback(async (next: GameFlow | null) => {
    const c = clientRef.current;
    if (!c) return;
    setFlowError(refusal(await c.command('setFlow', { flow: next === null ? null : (JSON.parse(JSON.stringify(next)) as GameFlow) }, c.projection.revision)));
  }, []);
  const saveAnimator = useCallback(async (controller: AnimatorController) => {
    const c = clientRef.current;
    if (!c) return;
    setAnimatorError(refusal(await c.command('setAnimator', { controller }, c.projection.revision)));
  }, []);
  const deleteAnimator = useCallback(async (controllerId: string) => {
    const c = clientRef.current;
    if (!c) return;
    setAnimatorError(refusal(await c.command('deleteAnimator', { controllerId }, c.projection.revision)));
  }, []);
  const clipsOf = useCallback(async (assetId: string) => {
    const r = await modelInstancesRef.current?.prepared(assetId);
    return (r?.clips ?? []).map((x) => ({ name: x.name, duration: x.durationSeconds }));
  }, []);
  // Phase 14.6: a model's skeleton (the Animator's bone mask picker).
  const skeletonOf = useCallback(async (assetId: string) => {
    const r = await modelInstancesRef.current?.prepared(assetId);
    return r === null || r === undefined ? [] : r.skeleton().map((b) => ({ name: b.name, parent: b.parent, depth: b.depth }));
  }, []);
  // Phase 14.6: mark an animation-only file as clips for another model's rig (null clears it).
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
  const setEntityAnimator = useCallback(async (entityId: string, controller: string | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Animator', await c.setComponent(entityId, 'animator', controller === null ? null : { controller }, c.projection.revision));
  }, [reportFailure]);
  const saveEnvironment = useCallback(async (env: EnvironmentConfig) => {
    const c = clientRef.current;
    if (!c) return;
    setMaterialError(refusal(await c.command('setEnvironment', { environment: env }, c.projection.revision)));
  }, []);
  const setEntityMaterials = useCallback(async (entityId: string, mapping: Record<string, string> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Materials', await c.setComponent(entityId, 'materials', mapping, c.projection.revision));
  }, [reportFailure]);
  const setAssetMaterials = useCallback(async (assetId: string, mapping: Record<string, string> | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Default materials', await c.command('setAssetOptions', { assetId, materials: mapping }, c.projection.revision));
  }, [reportFailure]);

  const setVertexColors = useCallback(
    async (assetId: string, mode: 'data' | 'tint') => {
      const c = clientRef.current;
      if (!c) return;
      reportFailure('Vertex colours', await c.command('setAssetOptions', { assetId, vertexColors: mode }, c.projection.revision));
    },
    [reportFailure],
  );

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
      const definition = c.prefabs.getDefinition(prefabId) ?? null;
      const decls = c.prefabs.declarationMap();
      const targets = definition ? deriveOverrideTargets(definition, decls) : [];
      const entitiesNow = c.projection.listEntities();
      const refs = { entityIds: entitiesNow.map((e) => e.id), assetIds: c.content.listAssets().map((a) => a.assetId) };
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
        assetIds: refs.assetIds,
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
      const parsed = parseControlInput(control, raw, {
        entityIds: c.projection.listEntities().map((e) => e.id),
        assetIds: c.content.listAssets().map((a) => a.assetId),
      });
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

  /** Collider/controller authoring: one typed `setComponent` per action. */
  const addComponent = useCallback(
    async (entityId: string, component: 'collider' | 'controller') => {
      const c = clientRef.current;
      if (!c) return;
      const args =
        component === 'controller'
          ? planAddController(entityId)
          : planSetCollider(entityId, { type: 'box', hx: 1, hy: 1 });
      setComponentError(null);
      await runTypedCommand('setComponent', args, setComponentError);
    },
    [runTypedCommand],
  );

  const removeComponent = useCallback(
    async (entityId: string, component: 'collider' | 'controller') => {
      const c = clientRef.current;
      if (!c) return;
      setComponentError(null);
      await runTypedCommand('setComponent', planRemovePhysicsComponent(entityId, component), setComponentError);
    },
    [runTypedCommand],
  );

  // Phase 14.0: the player's collision capsule (Inspector fields, "Fit to model").
  const setCapsule = useCallback(
    async (entityId: string, capsule: { radius: number; height: number; offset?: [number, number] } | null) => {
      setComponentError(null);
      await runTypedCommand('setComponent', { entityId, component: 'controller', value: { capsule } }, setComponentError);
    },
    [runTypedCommand],
  );
  const fitCapsuleToModel = useCallback(
    async (entityId: string) => {
      const bounds = viewportRef.current?.modelBounds(entityId) ?? null;
      const fit = bounds === null ? null : fitCapsule(bounds);
      if (fit === null) {
        setComponentError({ code: 'no_model', message: 'Fit to model needs a loaded model on this object or on its children.' });
        return;
      }
      await setCapsule(entityId, fit);
    },
    [setCapsule],
  );

  const editColliderBox = useCallback(
    async (entityId: string, hxRaw: string, hyRaw: string) => {
      const c = clientRef.current;
      if (!c) return;
      const parsed = parseColliderBox(hxRaw, hyRaw);
      if (!parsed.ok) {
        setComponentError({ code: parsed.error.code, message: parsed.error.message });
        return;
      }
      setComponentError(null);
      await runTypedCommand('setComponent', planSetCollider(entityId, parsed.shape), setComponentError);
    },
    [runTypedCommand],
  );

  const refreshAssets = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const page = await c.loadAssetPage(assetQuery, {});
    setAssetQuery(page.state);
    setAssets(c.content.listAssets());
  }, [assetQuery]);

  // ---- packet 34: behavior publication workflow ----------------------------

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

  const createDeclaration = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setBehaviorError(null);
    const parsed = Number(newPropertyDefault);
    const declaration = {
      properties: [
        {
          key: newPropertyKey,
          label: newPropertyKey,
          type: 'number' as const,
          default: Number.isFinite(parsed) ? parsed : 0,
        },
      ],
    };
    const res = await c.publishBehaviorDeclaration(
      { behaviorId: newBehaviorId, displayName: newDisplayName || newBehaviorId, mode: 'declaration-create', declaration },
      c.projection.revision,
    );
    if (!res.ok) {
      const r = res.response;
      setBehaviorError(r.ok ? { code: 'internal', message: 'unexpected response' } : { code: r.code, message: r.message ?? r.code });
      return;
    }
    setSelectedBehaviorId(newBehaviorId);
    refreshEntities();
  }, [newBehaviorId, newDisplayName, newPropertyDefault, newPropertyKey, refreshEntities]);

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

  // Phase 9.4: the material names of the selected object's model file / the selected asset.
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
  useEffect(() => {
    const models = modelInstancesRef.current;
    const a = selectedAssetId !== null ? assets.find((x) => x.assetId === selectedAssetId) : undefined;
    if (a === undefined || a.kind !== 'model' || models === null) {
      setAssetSourceMaterials([]);
      return;
    }
    let live = true;
    void models.prepared(a.assetId).then((r) => {
      if (live) setAssetSourceMaterials(r === null ? [] : r.materialNames(null));
    });
    return () => {
      live = false;
    };
  }, [selectedAssetId, assets]);

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

  const selected = entities.find((e) => e.id === selectedId) ?? null;
  const hierarchyFlags = effectiveFlagsOf(entities);
  const tagUsage = new Map<number, number>();
  for (const e of entities) {
    for (let bit = 0; bit < 32; bit++) if ((e.tags & (1 << bit)) !== 0) tagUsage.set(bit, (tagUsage.get(bit) ?? 0) + 1);
  }
  /** The optional components the selection carries (the Component menu's add/remove state). */
  const selectedComponents = new Set<string>(
    selected === null
      ? []
      : ([
          ['collider', selected.collider !== undefined],
          ['controller', selected.controller === true],
          ['gameZone', selected.gameZone !== undefined],
          ['playerSpawn', selected.playerSpawn === true],
          ['cameraFollow', selected.cameraFollow !== undefined],
          ['light', selected.light !== undefined],
          ['surface', selected.surface !== undefined],
          ['modelAnimation', selected.modelAnimation !== undefined],
        ] as Array<[string, boolean]>)
          .filter(([, present]) => present)
          .map(([k]) => k),
  );
  // The play loads from its own content locator on the preview origin.
  const previewSrc =
    playInfo?.playBase && playInfo.contentId !== null && playInfo.contentPath !== null
      ? `${playInfo.playBase.replace(/\/$/, '')}${playInfo.contentPath}?play=${playInfo.playSessionId}&content=${playInfo.contentId}`
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
  // Phase 12: a folder carries no components.
  const noComponentTarget = noSelection || selected?.kind === 'folder';
  const needObject = noSelection ? need : 'a folder has no components';
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
          { label: 'Fog volume', onSelect: () => void createEntityAt('Create fog volume', { kind: 'group', name: 'Fog volume', components: { fogVolume: { size: [6, 3, 4], density: 0.25, color: '#dfe7ef', falloff: 0.5 } } }) },
          { label: 'Spot light', onSelect: () => void createLight('spot') },
          { label: 'Hemisphere light', disabled: entities.some((e) => e.light?.type === 'hemisphere'), reason: 'the scene already has a hemisphere light', onSelect: () => void createLight('hemisphere') },
        ] },
        'separator',
        { label: 'Player spawn', onSelect: () => void createSpawn() },
        { label: 'Zone', items: [
          { label: 'Hazard zone', onSelect: () => void addZone('hazard', null) },
          { label: 'Checkpoint zone', onSelect: () => void addZone('checkpoint', null) },
          { label: 'Goal zone', onSelect: () => void addZone('goal', null) },
          { label: 'Exit zone…', disabled: sceneHeaders === null, reason: 'exits load other scenes (a v4 project)', onSelect: () => {
            setExitForm({ entityId: null, load: [], unload: [], spawnId: '', error: null });
            setDialog('exit');
          } },
        ] },
        { label: 'Gameplay', items: [
          { label: 'Moving platform', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create moving platform', { kind: 'box', name: 'Moving platform', box: { size: [2, 0.4, 2], material: { color: '#c9a36a' } }, components: { collider: { shape: { type: 'box', hx: 1, hy: 0.2 } }, mover: BLOCK_DEFAULTS.mover } }) },
          { label: 'One-way platform', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create one-way platform', { kind: 'box', name: 'One-way platform', box: { size: [3, 0.2, 2], material: { color: '#8fb573' } }, components: { collider: { shape: { type: 'box', hx: 1.5, hy: 0.1 }, oneWay: true } } }) },
          { label: 'Switch', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create switch', { kind: 'box', name: 'Switch', box: { size: [0.6, 0.2, 0.6], material: { color: '#d9534f' } }, components: { switch: BLOCK_DEFAULTS.switch } }) },
          { label: 'Door (opens on "open")', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create door', { kind: 'box', name: 'Door', box: { size: [0.6, 3, 2], material: { color: '#7a5230' } }, components: { collider: { shape: { type: 'box', hx: 0.3, hy: 1.5 } }, mover: { waypoints: [[0, 3, 0]], speed: 3, mode: 'once', startOn: 'open' } } }) },
          { label: 'Coin', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create coin', { kind: 'box', name: 'Coin', box: { size: [0.4, 0.4, 0.1], material: { color: '#f2c230' } }, components: { pickup: BLOCK_DEFAULTS.pickup } }) },
          { label: 'Enemy', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create enemy', { kind: 'box', name: 'Enemy', box: { size: [0.8, 0.8, 0.8], material: { color: '#8e3fb0' } }, components: { enemy: BLOCK_DEFAULTS.enemy } }) },
          { label: 'Trigger', disabled: sceneHeaders === null, reason: v4Reason, onSelect: () => void createEntityAt('Create trigger', { kind: 'group', name: 'Trigger', components: { trigger: BLOCK_DEFAULTS.trigger } }) },
        ] },
        'separator',
        { label: 'Model from asset…', onSelect: () => setBottomTab('assets') },
        { label: 'Instance set…', onSelect: () => setDialog('instances') },
        { label: 'Prefab copy…', onSelect: () => setBottomTab('prefabs') },
      ],
    },
    {
      label: 'Component',
      items: [
        { label: 'Collider (box)', disabled: noComponentTarget || selComponents.has('collider'), reason: noComponentTarget ? needObject : 'already present', onSelect: () => selectedId && void addComponent(selectedId, 'collider') },
        { label: 'Player controller', disabled: noComponentTarget || selComponents.has('controller'), reason: noComponentTarget ? needObject : 'already present', onSelect: () => selectedId && void addComponent(selectedId, 'controller') },
        { label: 'Player spawn', disabled: noComponentTarget || selComponents.has('playerSpawn'), reason: noComponentTarget ? needObject : 'already present', onSelect: () => void setComponentOnSelection('playerSpawn', {}) },
        { label: 'Camera follow', disabled: noComponentTarget || selComponents.has('cameraFollow'), reason: noComponentTarget ? needObject : 'already present', onSelect: () => void setComponentOnSelection('cameraFollow', { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: -50, maxX: 50, minY: -10, maxY: 20 } }) },
        { label: 'Light', disabled: noComponentTarget || selComponents.has('light'), reason: noComponentTarget ? needObject : 'already present', items: [
          { label: 'Directional', disabled: hasDirectional, reason: lightReason('directional'), onSelect: () => void setComponentOnSelection('light', { type: 'directional', color: '#fff4e0', intensity: 1.6, direction: [0.4, -1, -0.6], castShadow: true }) },
          { label: 'Ambient', disabled: hasAmbient, reason: lightReason('ambient'), onSelect: () => void setComponentOnSelection('light', { type: 'ambient', color: '#8a94b0', intensity: 0.9 }) },
        ] },
        { label: 'Game zone', disabled: noComponentTarget || selComponents.has('gameZone'), reason: noComponentTarget ? needObject : 'already present', items: [
          { label: 'Hazard', onSelect: () => void setComponentOnSelection('gameZone', { role: 'hazard', size: [1, 1] }) },
          { label: 'Checkpoint', onSelect: () => void setComponentOnSelection('gameZone', { role: 'checkpoint', size: [1, 1] }) },
          { label: 'Goal', onSelect: () => void setComponentOnSelection('gameZone', { role: 'goal', size: [1, 1] }) },
        ] },
        'separator',
        { label: 'Remove', disabled: noSelection || selComponents.size === 0, reason: noSelection ? need : 'no removable components', items: [...selComponents].map((k) => ({ label: k, onSelect: () => void setComponentOnSelection(k, null) })) },
      ],
    },
    {
      label: 'Gizmos',
      items: [
        { label: `Icons: ${gizmos.icons ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, icons: !g.icons })) },
        { label: `Light ranges: ${gizmos.lights ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, lights: !g.lights })) },
        { label: `Collider outlines: ${gizmos.colliders ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, colliders: !g.colliders })) },
        { label: `Gameplay paths and areas: ${gizmos.gameplay ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, gameplay: !g.gameplay })) },
      ],
    },
    {
      label: 'Window',
      items: [
        { label: 'Scene', onSelect: () => setCenterTab('scene') },
        { label: 'Game', onSelect: () => setCenterTab('game') },
        'separator',
        ...BOTTOM_TABS.map<MenuEntry>((t) => ({ label: t.label, onSelect: () => setBottomTab(t.id) })),
        'separator',
        { label: 'Full screen', shortcut: 'Shift+F11', onSelect: () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); else void document.documentElement.requestFullscreen().catch(() => undefined); } },
        { label: 'Reset layout', onSelect: () => { resetLayout(); window.location.reload(); } },
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
        onStop={() => void stop()}
      />
      <div className="tl-app__body">
        <div className="tl-app__main">
          <div className="tl-app__row">
            <div className="tl-dock tl-dock--left" style={{ width: sizes.left }}>
            <Hierarchy
          entities={entities}
          flags={hierarchyFlags}
          projectId={cfg.current.config.projectId}
          selectedIds={selection.ids}
          primaryId={selection.primary}
          onSelect={(ids, primary) => setSelection({ ids, primary })}
          onRename={(id, name) => void rename(id, name)}
          onMove={(ids, parentId, beforeId) => void move(ids, parentId, beforeId)}
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
              <div className="tl-tabs tl-tabs--center" role="tablist">
                <button role="tab" aria-selected={centerTab === 'scene'} className={`tl-tab${centerTab === 'scene' ? ' is-active' : ''}`} onClick={() => setCenterTab('scene')}>
                  Scene
                </button>
                <button role="tab" aria-selected={centerTab === 'game'} className={`tl-tab${centerTab === 'game' ? ' is-active' : ''}`} onClick={() => setCenterTab('game')}>
                  Game
                </button>
              </div>
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
          <canvas ref={canvasRef} className="tl-viewport" />
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
              </div>
              <iframe
                ref={playIframeRef}
                className="tl-app__preview-frame"
                src={previewSrc}
                title="Thirdlight play preview"
                allow="gamepad"
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
                  {t.id === 'problems' && ui.problems.length + (sourceIssues?.length ?? 0) + viewFailures.length > 0 ? <span className="tl-tab__count">{ui.problems.length + (sourceIssues?.length ?? 0) + viewFailures.length}</span> : null}
                </button>
              ))}
            </div>
          {bottomTab === 'problems' && (
            <ProblemsPanel
              problems={ui.problems}
              viewFailures={viewFailures}
              sourceIssues={folderProject ? sourceIssues : null}
              checking={checkingFiles}
              onCheckFiles={() => void checkFiles()}
              onReimport={(i) => void reimportIssue(i)}
            />
          )}
          {bottomTab === 'assets' && (
            <AssetBrowser
              assets={assets}
              query={assetQuery}
              importState={importState}
              selectedAssetId={selectedAssetId}
              placementAvailable={placement !== null && assetPlacementAvailable()}
              placementMessage={placementError?.message ?? null}
              preview={assetPreview}
              onRefresh={() => void refreshAssets()}
              onSelect={setSelectedAssetId}
              onImport={(f) => void importFile(f, 'create')}
              onReimport={(f) => void importFile(f, 'reimport')}
              folderImport={folderProject}
              onImportFromFolder={() => setFilePicker('create')}
              onReimportFromFolder={() => setFilePicker('reimport')}
              onPublish={() => void publish()}
              onCancel={() => void cancelImportFlow()}
              onDiscard={() => void discardImportFlow()}
              onPreview={(id) => void loadPreview(id)}
              previewCanvasRef={previewCanvasRef}
              onPreviewPlay={previewPlay}
              onPreviewPause={previewPause}
              onPreviewScrub={previewScrub}
              onPlace={() => void placeAsset()}
              roleMapping={mediaPendingRef.current !== null && mediaPendingRef.current.referencingEntityIds.length > 0 ? { clipNames: mediaPendingRef.current.clipNames ?? [], referencingEntityIds: mediaPendingRef.current.referencingEntityIds } : null}
              roleEntity={reimportEntity}
              roleDraft={reimportRoles}
              onRoleEntityChange={setReimportEntity}
              onRoleDraftChange={setReimportRoles}
              thumbnails={assetThumbs}
              pieces={assetPieces}
              onVertexColors={(id, mode) => void setVertexColors(id, mode)}
              sideExtra={
                selectedAssetId !== null && assets.find((a) => a.assetId === selectedAssetId)?.kind === 'model' ? (
                  <>
                    <ClipsForField
                      assetId={selectedAssetId}
                      clipsFor={assets.find((a) => a.assetId === selectedAssetId)?.clipsFor ?? null}
                      rigs={assets.filter((a) => a.kind === 'model' && a.assetId !== selectedAssetId && a.clipsFor === undefined).map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
                      onChange={(rig) => void setAssetClipsFor(selectedAssetId, rig)}
                      missingBones={missingBones}
                    />
                    <MaterialMappingEditor
                      label="Default materials (every placement)"
                      sourceNames={assetSourceMaterials}
                      mapping={assets.find((a) => a.assetId === selectedAssetId)?.materials ?? null}
                      materials={materials}
                      onChange={(mapping) => void setAssetMaterials(selectedAssetId, mapping)}
                    />
                  </>
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
              onOverrideCommit={commitOverride}
            />
          )}
          {bottomTab === 'behaviors' && (
            <BehaviorPanel
              behaviors={behaviorViews}
              selectedBehaviorId={selectedBehaviorId}
              publication={publication}
              sourceDraft={sourceDraft}
              activePlay={playInfo ? { snapshotId: playInfo.snapshotId, revision: playInfo.revision } : null}
              error={behaviorError}
              newBehaviorId={newBehaviorId}
              newDisplayName={newDisplayName}
              newPropertyKey={newPropertyKey}
              newPropertyDefault={newPropertyDefault}
              onSelect={(id) => {
                setSelectedBehaviorId(id);
                setBehaviorError(null);
              }}
              onSourceDraft={setSourceDraft}
              onStage={() => void stageBehaviorSource()}
              onAcknowledge={(digest) => void acknowledgeDigest(digest)}
              onPublishSource={() => void publishStagedSource()}
              onNewBehaviorId={setNewBehaviorId}
              onNewDisplayName={setNewDisplayName}
              onNewPropertyKey={setNewPropertyKey}
              onNewPropertyDefault={setNewPropertyDefault}
              onCreateDeclaration={() => void createDeclaration()}
            />
          )}
          {bottomTab === 'gameplay' && (
            <GameplayPanel
              v4={sceneHeaders !== null}
              entities={entities}
              gameConfig={gameConfig}
              gameConfigLoaded={gameConfigLoaded}
              settings={settings}
              tool={gameplayTool}
              onArmTool={armZoneTool}
              onSaveGameConfig={(g) => void saveGameConfig(g)}
              onAddZone={(r, s) => void addZone(r, s)}
              onEditZone={(id, n) => void editZone(id, n)}
              onDeleteZone={(id) => void deleteZone(id)}
              onAddSpawn={() => void addSpawn()}
              onDeleteSpawn={(id) => void deleteSpawn(id)}
              onSaveCameraFollow={(id, v) => void saveCameraFollow(id, v)}
              onSaveSettings={(s) => void saveSettings(s)}
              backendError={gameplayError}
            />
          )}
          {bottomTab === 'materials' && (
            <MaterialsPanel
              materials={materials}
              textures={assets.filter((a) => a.kind === 'texture').map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
              selectedId={selectedMaterialId}
              onSelect={setSelectedMaterialId}
              onSave={(m) => void saveMaterial(m)}
              onDelete={(id) => void deleteMaterial(id)}
              error={materialError}
            />
          )}
          {bottomTab === 'environment' && (
            <EnvironmentPanel
              environment={environment}
              textures={assets.filter((a) => a.kind === 'texture').map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
              onSave={(env) => void saveEnvironment(env)}
              error={materialError}
            />
          )}
          {bottomTab === 'game' && (
            <FlowPanel
              flow={flow}
              scenes={[...(sceneHeaders ?? []).map((h) => ({ sceneId: h.sceneId, name: h.name, start: h.start, open: true })), ...closedScenes.map((cs) => ({ ...cs, start: false, open: false }))]}
              spawns={entities.filter((e) => e.playerSpawn === true).map((e) => ({ id: e.id, name: e.name, sceneId: e.sceneId ?? null }))}
              music={assets.filter((a) => a.kind === 'music').map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
              textures={assets.filter((a) => a.kind === 'texture').map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
              gameSpawnId={gameConfig?.spawnId ?? null}
              onSave={(next) => void saveFlow(next)}
              error={flowError}
              note={flowNote}
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
          {bottomTab === 'input' && <InputPanel input={inputConfig} defaults={inputDefaults} onSave={(i) => void saveInput(i)} error={inputError} />}
          {bottomTab === 'animator' && (
            <AnimatorPanel
              controllers={animators}
              models={assets.filter((a) => a.kind === 'model').map((a) => ({ assetId: a.assetId, displayName: a.displayName, ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}) }))}
              clipsOf={clipsOf}
              skeletonOf={skeletonOf}
              preview={previewAnimator}
              onSave={(controller) => void saveAnimator(controller)}
              onDelete={(id) => void deleteAnimator(id)}
              error={animatorError}
            />
          )}
          {bottomTab === 'lighting' && (
            activeScene === null ? (
              <p className="tl-hint">Lighting bakes need a project with scenes (storage v4).</p>
            ) : (
              <LightingPanel
                sceneName={activeScene.name}
                bake={lighting[activeScene.sceneId] ?? null}
                stale={lighting[activeScene.sceneId] !== undefined && bakeIsStale(lighting[activeScene.sceneId]!, (clientRef.current?.projection.listEntities() ?? []).filter((e) => e.sceneId === activeScene.sceneId))}
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
          {bottomTab === 'tags' && (
            <TagsPanel
              tags={tags}
              usage={tagUsage}
              error={tagsError}
              onSetTags={(next) => void saveTags(next)}
            />
          )}
          {bottomTab === 'media' && (
            <MediaPanel
              entities={entities}
              selected={selected}
              gameConfig={gameConfig}
              gameConfigLoaded={gameConfigLoaded}
              assets={assets}
              clipNames={
                selected !== null && selected.kind === 'model' && selected.assetId !== undefined
                  ? (assetPreview !== null && assetPreview.assetId === selected.assetId
                      ? assetPreview.clips.map((c) => c.name)
                      : mediaPendingRef.current !== null && pendingProposalRef.current?.target.assetId === selected.assetId
                        ? mediaPendingRef.current.clipNames
                        : null)
                  : null
              }
              backendError={mediaError}
              onDismissError={() => setMediaError(null)}
              onSaveCues={(args) => void saveCues(args as { cues: Record<string, string | null> })}
              onAddLight={(t) => void addLight(t)}
              onSaveLight={(id, v) => void saveLight(id, v as Record<string, unknown>)}
              onSaveSurface={(id, v) => void saveSurface(id, v as Record<string, unknown>)}
              onApplyPreset={(id, p) => void applyPreset(id, p)}
              onSaveAnimation={(id, v) => void saveAnimation(id, v as Record<string, unknown>)}
              onSaveActivation={(id, v) => void saveActivation(id, { activation: v })}
              previewStatus={previewOwnerRef.current?.status() ?? { state: 'unsupported' }}
              previewDiagnostics={previewOwnerRef.current?.diagnostics() ?? []}
              onUnlockPreview={unlockPreview}
              onPreviewCue={(id) => void previewCue(id)}
            />
          )}
          </div>
        </div>
        <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('right')} role="separator" aria-orientation="vertical" aria-label="Resize the inspector" />
        <div className="tl-dock tl-dock--right" style={{ width: sizes.right }}>
        <Inspector
          {...(sceneHeaders !== null
            ? {
                onEditExit: (entityId: string) => {
                  const z = clientRef.current?.projection.getEntity(entityId)?.gameZone;
                  setExitForm({ entityId, load: [...(z?.load ?? [])], unload: [...(z?.unload ?? [])], spawnId: z?.spawnId ?? '', error: null });
                  setDialog('exit');
                },
              }
            : {})}
          entity={selected}
          gizmoMode={gizmoMode}
          onGizmoMode={setGizmoMode}
          declarations={declarations}
          prefabDisplayName={(prefabId) => prefabSummaries.find((d) => d.prefabId === prefabId)?.displayName ?? prefabId}
          propertyError={propertyError}
          componentError={componentError}
          onEditProperty={(entityId, key, raw) => void editProperty(entityId, key, raw)}
          onAddComponent={(entityId, component) => void addComponent(entityId, component)}
          onRemoveComponent={(entityId, component) => void removeComponent(entityId, component)}
          onEditColliderBox={(entityId, hx, hy) => void editColliderBox(entityId, hx, hy)}
          onSetCapsule={(entityId, capsule) => void setCapsule(entityId, capsule)}
          onFitCapsule={(entityId) => void fitCapsuleToModel(entityId)}
          capsuleOwner={(() => {
            // Phase 14.0: a child of the player collides with the player's capsule.
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
          extra={
            <>
            {selected !== null && selected.fogVolume !== undefined ? (
              <FogVolumeEditor volume={selected.fogVolume} onSave={(patch) => void saveFogVolume(selected.id, patch)} />
            ) : selected !== null && selected.light !== undefined ? (
              <LightEditor light={selected.light} onSave={(patch) => void saveLightPatch(selected.id, patch)} />
            ) : selected !== null && (selected.kind === 'model' || selected.kind === 'box' || selected.instances !== undefined) ? (
              <>
                <MaterialMappingEditor
                  label="Materials"
                  sourceNames={selected.kind === 'box' ? [] : selectedSourceMaterials}
                  mapping={selected.materials ?? null}
                  materials={materials}
                  onChange={(mapping) => void setEntityMaterials(selected.id, mapping)}
                />
                {selected.kind === 'model' && (
                  <label className="tl-field">
                    <span className="tl-field__label">animator</span>
                    <select className="tl-input" aria-label="animator controller of the object" value={selected.animator?.controller ?? ''} onChange={(e) => void setEntityAnimator(selected.id, e.target.value === '' ? null : e.target.value)}>
                      <option value="">— none —</option>
                      {animators.map((a) => (
                        <option key={a.controllerId} value={a.controllerId}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ) : null}
            {selected !== null && selected.kind !== 'folder' && selected.kind !== 'camera' && selected.light === undefined && selected.fogVolume === undefined && sceneHeaders !== null && (
              <BlocksEditor
                blocks={selected.blocks ?? {}}
                collider={selected.collider}
                hazard={selected.gameZone?.role === 'hazard' ? selected.gameZone : null}
                onSave={(component, value) => void saveBlock(selected.id, component, value)}
                sounds={assets.filter((a) => a.kind === 'audio' || a.kind === 'music').map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
                cues={assets.filter((a) => a.kind === 'audio').map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
              />
            )}
            </>
          }
        />
        </div>
      </div>
      <StatusBar state={ui} onResync={resync} />
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
                ['Shift (held)', 'Disable snapping for one gesture'],
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
      {dialog === 'exit' && (
        <Dialog title={exitForm.entityId === null ? 'New exit zone' : 'Edit exit zone'} onClose={() => setDialog(null)}>
          <p>When the player enters the zone, these scenes load and unload; then the player can be moved to a spawn (in a scene that is loaded by then).</p>
          <div className="tl-exit">
            {(['load', 'unload'] as const).map((which) => (
              <fieldset key={which} className="tl-exit__scenes">
                <legend>{which === 'load' ? 'Load' : 'Unload'}</legend>
                {[...(sceneHeaders ?? []), ...closedScenes].map((sc) => (
                  <label key={sc.sceneId} className="tl-field tl-field--inline">
                    <input
                      type="checkbox"
                      aria-label={`${which} ${sc.name}`}
                      checked={exitForm[which].includes(sc.sceneId)}
                      onChange={(e) =>
                        setExitForm((f) => ({ ...f, error: null, [which]: e.target.checked ? [...f[which], sc.sceneId] : f[which].filter((id) => id !== sc.sceneId) }))
                      }
                    />
                    <span>{sc.name}</span>
                  </label>
                ))}
              </fieldset>
            ))}
            <label className="tl-field">
              <span className="tl-field__label">Move the player to</span>
              <select className="tl-input" aria-label="exit spawn" value={exitForm.spawnId} onChange={(e) => setExitForm((f) => ({ ...f, spawnId: e.target.value }))}>
                <option value="">— stay —</option>
                {(clientRef.current?.projection.listEntities() ?? []).filter((e) => e.playerSpawn === true).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.sceneId !== undefined ? ` (${[...(sceneHeaders ?? []), ...closedScenes].find((sc) => sc.sceneId === e.sceneId)?.name ?? e.sceneId})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {exitForm.error !== null && <p className="tl-dialog__error" role="alert">{exitForm.error}</p>}
          <button className="tl-btn" onClick={() => void saveExit()}>
            {exitForm.entityId === null ? 'Create exit zone' : 'Save exit'}
          </button>
        </Dialog>
      )}
      {dialog === 'instances' && (
        <Dialog title="Instance set" onClose={() => setDialog(null)}>
          <p>Many copies of one model as a single object (drawn with instancing): good for foliage, rocks and other repeated detail. The copies are spread on the ground plane around the point the camera looks at.</p>
          <div className="tl-scatter">
            <label className="tl-field">
              <span className="tl-field__label">Model</span>
              <select className="tl-input" aria-label="instance model" value={scatter.assetId} onChange={(e) => setScatter((f) => ({ ...f, assetId: e.target.value }))}>
                <option value="">— select —</option>
                {assets.filter((a) => a.kind === 'model').map((a) => (
                  <option key={a.assetId} value={a.assetId}>
                    {a.displayName}
                  </option>
                ))}
              </select>
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
  );
}

type BottomTab = 'assets' | 'materials' | 'environment' | 'lighting' | 'animator' | 'input' | 'game' | 'prefabs' | 'behaviors' | 'gameplay' | 'tags' | 'media' | 'problems';

const BOTTOM_TABS: ReadonlyArray<{ id: BottomTab; label: string }> = [
  { id: 'assets', label: 'Assets' },
  { id: 'materials', label: 'Materials' },
  { id: 'environment', label: 'Environment' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'animator', label: 'Animator' },
  { id: 'input', label: 'Input' },
  { id: 'game', label: 'Game flow' },
  { id: 'prefabs', label: 'Prefabs' },
  { id: 'behaviors', label: 'Behaviors' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'tags', label: 'Tags' },
  { id: 'media', label: 'Media' },
  { id: 'problems', label: 'Problems' },
];

export function mountEditor(): void {
  const el = document.getElementById('tl-root');
  if (!el) throw new Error('editor root element #tl-root not found');
  createRoot(el).render(<EditorApp />);
}