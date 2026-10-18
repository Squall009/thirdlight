/**
 * Authoring viewport — imperative three.js, framework-free.
 *
 * The Scene view draws through the same scene adapter as Play and exports
 * (`createSceneAdapter`): the same drawables, lights and shadows, materials,
 * lightmaps, LOD switch, batching, block layers, instance sets and
 * environment. What it hands the adapter is the authored scene
 * (`SceneSource`, standing in for the runtime): the projection's entities
 * as documents, their authored transforms, and this view's camera.
 *
 * The viewport owns only what the game does not draw: the grid, the gizmo,
 * the handles and helper outlines, icons, light ranges, camera frustums,
 * brush previews and the selection outline (an overlay group in the
 * adapter's scene, and per-entity overlays riding on the entities' nodes).
 *
 * React never instantiates or mutates Object3Ds. The viewport renders the
 * browser's PROJECTION of the backend scene and never mutates the scene
 * itself — scene mutation flows only through editing commands (the client).
 * A gizmo gesture previews the transform locally (the entity drawn where the
 * drag has it) and the commit is ONE undoable command.
 *
 * Browser-only: uses the DOM (canvas, events) + WebGPU/WebGL via three.js.
 */

import {
  BATCHED_LAYER,
  batchingFromUrl,
  mergingFromUrl,
  shadowCacheFromUrl,
  createProbeDebugView,
  createSceneAdapter,
  DEFAULT_RENDERER_PREFERENCE,
  drawOwner,
  markHostDrawing,
  occlusionFromUrl,
  occlusionPyramidFromUrl,
  portalsFromUrl,
  pageSearch,
  rendererMemory,
  type EffectComponentLike,
  type EffectDefLike,
  type EnvironmentLike,
  type LightingBakeLike,
  type ProbeDebugView,
  type ProbeLighting,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
  type SceneAdapter,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { BlockChunk, BlockLayerComponent, BlockRegion, BlockType, DecalComponent, InstanceBrush, InstanceStroke } from '@thirdlight/project-model';
import * as THREE from 'three';
import { AMBIENT_OCCLUSION_DEFAULT, VIEW_LENS_DEFAULTS, type ArchitectureGraphLike, type OcclusionCulling, type ArchitecturePreview, type EnvironmentBlendView } from '@thirdlight/runtime';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeOrbitControls, releaseControlKeyListeners } from './controls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { ProjectedEntity } from '../session/projection';
import { effectiveFlagsOf, type EffectiveEntityFlags } from '../session/hierarchy';
import { clampScale, getSnapSettings } from '../session/snapping';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { HelperOverlay } from './helper-overlay';
import { copyAt, type CopyTransform } from '../session/instance-copies';
import { BrushBlockSurfaces } from './instance-brush';
import { iconTableOf } from './icons';
import { planSync, removedIds, helperRelevant } from './sync-plan';
import type { BlockEditor, BlockEditorCallbacks } from './block-editor';
import type { TerrainEditor, TerrainEditorCallbacks } from './terrain-editor';
import { decalSurfaceOf, DECAL_PREVIEW_ID, type DecalArm, type DecalToolCallbacks } from './decal-tool';
import type { VertexPaintArm, VertexPaintToolCallbacks } from './vertex-paint-tool';
import type { BrushStore } from '../session/brush';
import { CLICK_SLOP_PX, ViewportTools } from './tool-input';
import { virtualCameraPreviews } from './camera-previews';
import { gatherBakeInputs, gatherBakeLights, type BakeInputs } from './bake-inputs';
import type { ProbeBakeHost } from './probe-bake-inputs';
import { SceneVisibility } from './scene-visibility';
import { ViewIsolationState, type ViewIsolation } from './view-isolation';
import { SceneSource } from './scene-source';
import { EntityOverlays, OVERLAY_KEY } from './entity-overlays';
import type { SceneViewAssets } from './scene-assets';
import { EffectPreview } from './effect-preview';
import { SceneViewOcclusion, type OcclusionViewState } from './occlusion-view';
import { ENTRY_LEVEL_DEG, framePose, insideBox, NO_INSETS, viewPitchDeg, viewShowsBox, type FrameInsets } from './frame-view';

export interface ViewportCallbacks {
  onPick: (entityId: string | null) => void;
  onGestureBegin: (entityId: string) => void;
  onGestureFrame: (entityId: string, transform: { position: number[]; rotation: number[]; scale: number[] }) => void;
  onGestureEnd: (entityId: string, transform: { position: number[]; rotation: number[]; scale: number[] }) => void | Promise<void>;
  /**
   * A descriptor handle (waypoint, size, outline corner, …) was dragged
   * and dropped, or a corner deleted — the component value to store (one
   * setComponent, one undo step).
   */
  onHandleEdit?: (entityId: string, component: string, value: Record<string, unknown>) => void;
  /** A handle edit that cannot be stored (a concave polygon, the last corners) — nothing is sent. */
  onHandleRefused?: (message: string) => void;
  /** One copy of the selected instance set was clicked (null: none). */
  onCopyPick?: (entityId: string, index: number | null) => void;
  /** The selected copy was moved, turned or scaled with the gizmo (its new local transform). */
  onCopyTransform?: (entityId: string, index: number, t: CopyTransform) => void;
  /** An instance-brush stroke on the selected set (one `paintInstances`); resolves true when stored. */
  onBrushStroke?: (entityId: string, stroke: InstanceStroke) => Promise<boolean>;
  /** The Scene view's renderer changed state (initialising, ready, lost, replaced). */
  onRendererChange?: (info: RendererInfo) => void;
  /** The placements' model files that failed to load or build (the editor shows them in Problems). */
  onModelFailures?: (failures: ReadonlyMap<string, { code: string; message: string }>) => void;
  /** An object was double-clicked (no tool armed, no edit mode open): its edit mode, if it has one, opens. */
  onDoublePick?: (entityId: string) => void;
}

/**
 * The share of the view's height a working view (an edit mode entered) keeps
 * above the horizon: it looks down obliquely, so relief reads, with the sky
 * in the top of the picture (about 20° down with the editor's 50° lens).
 */
export const WORK_VIEW_SKY = 0.12;

export type { ViewIsolation } from './view-isolation';

const GROUND_SIZE = 20;
/** How far (m) the grid and its ground square sit under y = 0: clear of a floor there, too little to read as a gap. */
const GROUND_DROP = 0.01;
/** The Scene view's background where the project draws no sky. */
const SCENE_BACKGROUND = 0x14161c;
/** The selection outline's colour. */
const SELECTION_OUTLINE = 0x6ea8ff;

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface GizmoTransform {
  position: number[];
  rotation: number[];
  scale: number[];
}

/** The game's aspect before the Scene view is told one (16:9, the common screen shape). */
const DEFAULT_GAME_ASPECT = 16 / 9;

/**
 * An object outside the scene whose world matrix is set by hand: the parent
 * frame of the gizmo's and the copy gizmo's stand-ins, and an entity's frame
 * for the handles and the bake.
 */
function frameObject(): THREE.Object3D {
  const o = new THREE.Object3D();
  o.matrixAutoUpdate = false;
  o.matrixWorldAutoUpdate = false;
  return o;
}

/**
 * The authoring viewport. Owns the camera, controls and overlays, and the
 * scene adapter that draws the projection. Selection + gizmo gestures are
 * driven by pointer events; the commit is handed to the caller (the client)
 * as one command.
 */
export class Viewport {
  private readonly camera: THREE.PerspectiveCamera;
  private rendererChoice: { preference: RendererPreference; source: RendererPreferenceSource };
  private rendererInfoNow: RendererInfo;
  private root: HTMLCanvasElement;
  private readonly cb: ViewportCallbacks;
  private readonly assets: SceneViewAssets;
  /** The authored scene as the adapter reads it. */
  private readonly source: SceneSource;
  /** The adapter drawing this view (replaced with the canvas on a backend change). */
  private adapter: SceneAdapter;
  /** Everything the viewport draws itself, in the adapter's scene. */
  private readonly overlay = new THREE.Group();
  /** Occlusion culling in this view: the View menu's switches, and what is never culled. */
  private readonly occlusion = new SceneViewOcclusion(() => this.adapter, () => this.root, occlusionFromUrl(pageSearch()));
  /** What occlusion culling leaves alone: the selection's subtree and the edited objects (made again when one changes). */
  private occlusionKept: { selected: string | null; projected: readonly ProjectedEntity[]; edited: ReadonlySet<string> | null; ids: ReadonlySet<string> } | null = null;
  private readonly entityOverlays: EntityOverlays;
  private selectedId: string | null = null;
  /** An edit mode's isolation: what is drawn and what can be hit while a mode is open. */
  private readonly isolation = new ViewIsolationState({
    subtreeIds: (id) => this.subtreeIds(id),
    withComponent: (c) => this.projected.filter((e) => e.components[c] !== undefined).map((e) => e.id),
    drawOnly: (ids) => this.adapter.setIsolation?.(ids),
    showGround: (on) => {
      this.grid.visible = on && this.gizmos.grid;
      this.ground.visible = this.grid.visible;
    },
    editing: (ids, all) => {
      this.entityOverlays.setEditing(ids, all);
      this.helpers.sync(this.helperEntities());
    },
    publish: (state) => this.root.setAttribute('data-isolation', state),
    requestRender: () => this.requestRender(),
  });
  /** Effective flags from the last sync (inactive = hidden, locked = not pickable/movable). */
  private hierarchyFlags: ReadonlyMap<string, EffectiveEntityFlags> = new Map();
  private folderIds = new Set<string>();
  private gizmoMode: GizmoMode = 'translate';
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  /** The helper overlay: collider outlines, component areas, the selection's handles. */
  private readonly helpers: HelperOverlay;
  /** The Scene view's tools; pointer input reaches them before the gizmo and picking. */
  private readonly tools: ViewportTools;
  /** Which helpers the Scene view draws (the Gizmos menu). */
  private gizmos = { icons: true, lights: true, colliders: false, gameplay: true, grid: true, probes: false };
  /** The probe debug view while the Gizmos menu shows it (over the probe light it was made for). */
  private probeDebug: { light: ProbeLighting; view: ProbeDebugView } | null = null;
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly snapping: () => boolean;
  private gizmoTargetId: string | null = null;
  /** The gizmo moves this stand-in; its parent frame is the selection's parent's world matrix, so its pose is the local transform. */
  private readonly gizmoFrame = frameObject();
  private readonly gizmoProxy = new THREE.Object3D();
  /** A gizmo drag is in flight (between TransformControls mouseDown/mouseUp). */
  private draggingGizmo = false;
  /** Esc during a gizmo drag: the object is reset and the release commits nothing. */
  private gizmoCancelled = false;
  /** Released drags whose entity is drawn where the drag left it until the projection has the result. */
  private readonly settling = new Set<string>();
  private downAt: { x: number; y: number } | null = null;
  private renderQueued = false;
  /** Out of sight behind the Game view: no frames, no per-frame work. */
  private readonly visibility = new SceneVisibility(
    () => this.requestRender(),
    (suspended) => this.root.setAttribute('data-suspended', String(suspended)),
  );
  private readonly raycaster = new THREE.Raycaster();
  /** The entity object each entity was last synced from (the projection is copy-on-write). */
  private readonly synced = new Map<string, ProjectedEntity>();
  /** Frames drawn (render on demand: none while nothing changes). */
  private framesDrawn = 0;
  /** The block layers the instance brush paints on. */
  private readonly brushSurfaces = new BrushBlockSurfaces();
  /** The outline around the selection's drawn bounds. */
  private selectionOutline: THREE.Box3Helper | null = null;

  constructor(canvas: HTMLCanvasElement, cb: ViewportCallbacks, options: { assets: SceneViewAssets; snapping?: () => boolean; renderer?: { preference: RendererPreference; source: RendererPreferenceSource } }) {
    this.root = canvas;
    this.cb = cb;
    this.assets = options.assets;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.rendererChoice = options.renderer ?? { preference: DEFAULT_RENDERER_PREFERENCE, source: 'default' };
    this.rendererInfoNow = { requested: this.rendererChoice.preference, source: this.rendererChoice.source, backend: null, api: null, state: 'initialising', reason: 'choosing a backend', recoveries: 0 };
    this.source = new SceneSource({
      assetKey: (assetId) => this.assets.assetKey(assetId),
      instanceChunkSize: () => this.instanceChunk,
    });
    this.source.setCamera(this.camera);
    this.overlay.name = 'scene-view-overlays';
    // The view's own drawing (grid, gizmo, outlines, handles, brush cursors) is never an occludee.
    markHostDrawing(this.overlay);
    this.entityOverlays = new EntityOverlays({ adapter: () => this.adapter, requestRender: () => this.requestRender() });
    this.adapter = this.makeAdapter(canvas);
    this.raycaster.layers.enable(BATCHED_LAYER);

    // A level's floor most often lies at y = 0: the dark ground square and the grid sit just under it (and the square is
    // pushed back in depth) so they never z-fight a floor there in dark streaks; where nothing is built they show as before.
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new THREE.MeshLambertMaterial({ color: 0x1c1f27, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -GROUND_DROP;
    this.overlay.add(this.ground);
    this.grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE, 0x333844, 0x23262f);
    this.grid.position.y = -GROUND_DROP;
    this.overlay.add(this.grid);
    this.helpers = new HelperOverlay(this.overlay, this.camera, canvas);
    // A `{type: 'model'}` collider is outlined as its model's `_COL` parts once they are read.
    this.helpers.setModelSource((assetId) => this.assets.files.prepared(assetId), () => (this.stampGizmoCounts(), this.requestRender()));
    this.snapping = options.snapping ?? (() => false);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.tools = new ViewportTools({
      overlay: this.overlay,
      camera: this.camera,
      orbit: this.orbit,
      helpers: this.helpers,
      canvas: () => this.root,
      selectedId: () => this.selectedId,
      reselect: () => this.setSelected(this.selectedId),
      gizmoAxis: () => this.gizmo.axis,
      snapping: () => this.snapping(),
      requestRender: () => this.requestRender(),
      blockView: () => this.adapter.blockLayers!(),
      terrains: () => this.adapter.terrains?.() ?? null,
      handleEdit: (id, component, value) => this.cb.onHandleEdit?.(id, component, value),
      refused: (m) => this.cb.onHandleRefused?.(m),
      brush: {
        scene: this.overlay,
        camera: this.camera,
        canvas: canvas,
        requestRender: () => this.requestRender(),
        colliders: (exceptId) => this.colliderObjects(exceptId),
        blockRoot: () => this.adapter.blockLayers?.().root ?? null,
        blockLayers: () => this.brushSurfaces.layers(),
      },
      brushStroke: (entityId, stroke) => this.cb.onBrushStroke?.(entityId, stroke) ?? Promise.resolve(false),
      decal: {
        overlay: this.overlay,
        camera: this.camera,
        canvas: () => this.root,
        surfaceAt: (x, y) => decalSurfaceOf(this.castScene(x, y, true), this.raycaster.ray, (o) => this.adapter.entityOf?.(o) ?? null, (id, wx, wz) => this.adapter.terrains?.()?.field(id)?.sample(wx, wz)?.normal ?? null),
        surfaceOnRay: (o, d, far) => decalSurfaceOf(this.castRay(o, d, far), this.raycaster.ray, (x) => this.adapter.entityOf?.(x) ?? null, (id, wx, wz) => this.adapter.terrains?.()?.field(id)?.sample(wx, wz)?.normal ?? null),
        decals: () => this.projected.filter((e) => e.components['decal'] !== undefined && this.hierarchyFlags.get(e.id)?.active !== false && this.hierarchyFlags.get(e.id)?.locked !== true).map((e) => ({ id: e.id, trs: { position: e.position, rotation: e.rotation, scale: e.scale }, decal: e.components['decal'] as DecalComponent })),
        parentWorld: (id) => {
          const p = this.synced.get(id)?.parentId ?? null;
          return p === null ? null : this.worldOf(p);
        },
        setPreview: (e) => (this.source.setExtra(e), this.adapter.sync?.()),
        previewTransform: (id, t) => (this.source.setOverride(id, t), this.requestRender()),
        previewDecal: (id, decal) => void this.previewComponent(id, 'decal', decal),
        worldOf: (id) => this.worldOf(id),
        clippedMesh: (id) => this.clippedDecalMesh(id),
        snapping: () => this.snapping(),
        requestRender: () => this.requestRender(),
      },
      paint: {
        overlay: this.overlay,
        camera: this.camera,
        canvas: () => this.root,
        hits: (x, y) => this.castScene(x, y),
        ownerOf: (o) => this.adapter.paintOwnerOf?.(o) ?? null,
        entity: (id) => (this.hierarchyFlags.get(id)?.active === false || this.hierarchyFlags.get(id)?.locked === true ? null : (this.synced.get(id) ?? null)),
        copyOf: (id, h) => (h.instanceId === undefined ? null : (this.adapter.instanceSet?.(id)?.copyOf(h.object, h.instanceId) ?? null)),
        preview: (id, t) => this.adapter.paintPreview?.(id, t.kind === 'copy' ? { copy: t.copy } : t.kind === 'path' ? { path: t.path, side: t.side } : {}) ?? null,
        drawn: (id) => this.drawnMeshes(id).length > 0 || (this.adapter.pickables?.() ?? []).some((o) => this.adapter.paintOwnerOf?.(o) === id),
        channelView: (c) => (this.adapter.paintChannelView?.(c), this.requestRender()),
        requestRender: () => this.requestRender(),
      },
    });
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.addEventListener('change', () => this.requestRender());

    this.gizmoFrame.add(this.gizmoProxy);
    this.copyFrame.add(this.copyProxy);
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener('mouseDown', () => {
      const id = this.gizmoTargetId;
      if (!id) return;
      this.draggingGizmo = true;
      this.gizmoCancelled = false;
      this.applySnapping();
      // A copy of an instance set previews locally; its release stores one buffer.
      if (this.gizmo.object === this.copyProxy) return;
      this.cb.onGestureBegin(id);
    });
    this.gizmo.addEventListener('objectChange', () => {
      const id = this.gizmoTargetId;
      if (!this.draggingGizmo || !id || this.gizmoCancelled) return;
      if (this.gizmo.object === this.copyProxy && this.copySel !== null) {
        const t = this.readCopyProxy();
        this.previewCopy(this.copySel.entityId, this.copySel.index, [...t.position, ...t.rotation, ...t.scale]);
        this.updateCopyHighlight();
        return;
      }
      // A moved object lands on the cell tops under it (translate gestures).
      if (this.cellTopSnap !== null && this.gizmoMode === 'translate') {
        const o = this.gizmoProxy;
        const at = this.cellTopSnap(id, [o.position.x, o.position.y, o.position.z], [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]);
        if (at !== null) {
          o.position.set(at[0], at[1], at[2]);
          o.updateMatrixWorld(true);
        }
      }
      // The entity is drawn where the drag has it (the adapter places it from this local transform).
      const t = this.readTarget();
      this.source.setOverride(id, t);
      this.cb.onGestureFrame(id, t);
    });
    this.gizmo.addEventListener('mouseUp', () => {
      const id = this.gizmoTargetId;
      const cancelled = this.gizmoCancelled;
      this.draggingGizmo = false;
      this.gizmoCancelled = false;
      if (this.gizmo.object === this.copyProxy && this.copySel !== null) {
        const sel = this.copySel;
        if (cancelled) this.syncCopyProxy(true);
        else this.cb.onCopyTransform?.(sel.entityId, sel.index, this.readCopyProxy());
        return;
      }
      if (!id) return;
      if (cancelled) {
        this.source.setOverride(id, null);
        this.requestRender();
        return;
      }
      // Drawn where the drag left it until the projection has the stored transform (or the gesture is undone).
      this.settling.add(id);
      void this.cb.onGestureEnd(id, this.readTarget());
    });
    this.overlay.add(this.gizmo.getHelper());

    this.camera.position.set(6, 5, 6);
    this.orbit.update();
    this.bindEvents();
    this.resize();
  }

  /** The project's instance-set chunk size (sets without their own use it). */
  private instanceChunk: number | undefined = undefined;
  /** The project's LOD bias and hysteresis (null: the defaults), kept for an adapter made again. */
  private lodTuning: { bias: number; hysteresis: number } | null = null;
  private aoKind: 'off' | 'ssao' | 'gtao' = AMBIENT_OCCLUSION_DEFAULT;
  /** The project's occlusion culling (null: not set, the default). */
  private occlusionCulling: OcclusionCulling | null = null;

  // ---- The scene adapter -------------------------------------------------
  /** The project environment, the bakes and the lighting mode as last set (a new adapter takes them). */
  private environmentValue: EnvironmentLike | null = null;
  private environmentSet = false;
  private bakes: Readonly<Record<string, LightingBakeLike>> | null = null;
  /** Generated architecture's style and preset graphs (kept for a new adapter). */
  private archStyles: readonly ArchitectureGraphLike[] | null = null;
  private lighting: { mode: 'editor' | 'game'; chosen: boolean } = { mode: 'editor', chosen: false };
  private envPreview: EnvironmentBlendView | null = null;
  private envPreviewTags: ReadonlyMap<string, number> | undefined;

  private makeAdapter(canvas: HTMLCanvasElement): SceneAdapter {
    const assets = this.assets;
    const adapter = createSceneAdapter(canvas, {
      runtime: this.source,
      // Block chunks mesh off the frame in workers next to the editor page (`mesh-worker.js`).
      meshWorkerUrl: new URL('mesh-worker.js', document.baseURI).href,
      // The authored scene comes in through the source's scene set; a v4 snapshot with scenes lets rows arrive as they are read.
      snapshot: { scene: { schemaVersion: 4, entities: [] }, scenes: [] } as never,
      resources: assets.resources,
      background: SCENE_BACKGROUND,
      ...(this.lodTuning !== null ? { lod: this.lodTuning } : {}),
      // The project's AO kind; full resolution whatever the quality level's render scale (the Scene view is for editing).
      render: { ambientOcclusion: this.aoKind, fixedScale: true, ...(this.occlusionCulling !== null ? { occlusionCulling: this.occlusionCulling } : {}) },
      // Occlusion culling as Play culls; `?occlusion=` and `?portals=off` on the editor page compare, as in Play.
      occlusion: occlusionFromUrl(pageSearch()),
      occlusionPyramid: occlusionPyramidFromUrl(pageSearch()),
      portals: portalsFromUrl(pageSearch()),
      onChange: () => this.contentArrived(),
      renderer: {
        ...this.rendererChoice,
        onChange: (info) => {
          if (this.adapter !== adapter) return;
          this.rendererInfoNow = info;
          if (info.state === 'ready') this.resize();
          this.cb.onRendererChange?.(info);
        },
      },
      // `?batching=off` on the editor page: every object drawn on its own (a diagnostic comparison).
      batching: batchingFromUrl(pageSearch()),
      // Static objects merged in the background (drawn alone until their cell is built); `?merging=off` compares.
      merging: mergingFromUrl(pageSearch()) ? 'background' : 'off',
      // The sun's static casters cached in their own shadow map; `?shadowcache=off` compares.
      shadowCache: shadowCacheFromUrl(pageSearch()),
      models: assets.models,
      // Draco/Basis decoder files are served next to the editor page (dist/editor/decoders/).
      modelsLoader: createGltfLoaderPort({ decoderBase: './decoders/' }),
      materials: { library: assets.materialLibrary, defs: [], wind: null, loadTexture: assets.loadTexture },
      environment: { value: {}, loadTexture: assets.loadTexture },
      lights: { loadTexture: assets.loadTexture },
      lighting: { bakes: {}, loadTexture: assets.loadTexture, loadBytes: assets.loadBytes },
      ...(this.archStyles !== null ? { architectureStyles: this.archStyles } : {}),
    });
    adapter.threeScene?.().add(this.overlay);
    this.entityOverlays.attachAll(adapter);
    // The Decal tool's preview is cut from a scene that is already there: its empty result is final at once.
    adapter.clippedDecalWaits?.(DECAL_PREVIEW_ID, false);
    return adapter;
  }

  /** The adapter's world, environment, bakes and block layers follow the current state (a new adapter, a lighting mode). */
  private applyLook(): void {
    const game = this.lighting.mode === 'game';
    // The editor rig still draws at the project's quality level (the engine's low: no MSAA).
    const quality = this.environmentValue?.quality;
    const qualityLevels = this.environmentValue?.qualityLevels;
    this.adapter.setEnvironment?.(game ? this.environmentValue : quality !== undefined || qualityLevels !== undefined ? { ...(quality !== undefined ? { quality } : {}), ...(qualityLevels !== undefined ? { qualityLevels } : {}) } : null);
    this.adapter.setBakes?.(game ? this.bakes : null);
    this.adapter.previewEnvironmentBlend?.(game ? this.envPreview : null, this.envPreviewTags);
  }

  /** A model, instance set, cookie or texture arrived on its own: draw again (and what follows it). */
  private contentArrived(): void {
    this.assets.report();
    // An instance buffer arrived — the selected copy's stand-in and box follow it.
    if (this.copySel !== null && !this.draggingGizmo) this.syncCopyProxy();
    this.outlineDirty = true;
    this.requestRender();
  }

  /** Something the project's materials draw changed in place (a texture arrived): lightmapped copies follow it. */
  materialsChanged(): void {
    this.adapter.materialsChanged?.();
    this.requestRender();
  }

  /** Asset facts changed (a reimport, an asset's vertex colours or default materials): the objects showing them are realized again. */
  assetsChanged(): void {
    this.source.sync(this.projected, null);
    this.requestRender();
  }

  /** The project's instance-set chunk size changed: the sets that use it are built again. */
  setInstanceChunkSize(meters: number | undefined): void {
    if (meters === this.instanceChunk) return;
    this.instanceChunk = meters;
    this.source.sync(this.projected, null);
    this.requestRender();
  }

  /** The project's LOD bias and hysteresis changed: every level of detail is picked again with them. */
  setLodTuning(tuning: { bias: number; hysteresis: number }): void {
    if (this.lodTuning !== null && this.lodTuning.bias === tuning.bias && this.lodTuning.hysteresis === tuning.hysteresis) return;
    this.lodTuning = tuning;
    this.adapter.setLodTuning?.(tuning);
    this.requestRender();
  }

  /** The project's ambient occlusion kind changed: a look's AO is drawn with it. */
  setAmbientOcclusion(kind: 'off' | 'ssao' | 'gtao'): void {
    if (kind === this.aoKind) return;
    this.aoKind = kind;
    this.adapter.setRenderSettings?.({ ambientOcclusion: kind }, 'project');
    this.requestRender();
  }

  /** The project's occlusion culling setting changed: the view culls as Play does. */
  setOcclusionCulling(mode: OcclusionCulling): void {
    if (mode === this.occlusionCulling) return;
    this.occlusionCulling = mode;
    this.adapter.setRenderSettings?.({ occlusionCulling: mode }, 'project');
    this.requestRender();
  }

  /** The View menu's occlusion switches (culling on or off here, the culled boxes, the depth pyramid). */
  setOcclusionView(state: OcclusionViewState): void {
    if (this.occlusion.set(state)) this.requestRender();
  }

  /** The selection's subtree and the edited objects: never culled. */
  private keptFromOcclusion(): ReadonlySet<string> {
    const edited = this.isolation.ids;
    const k = this.occlusionKept;
    if (k !== null && k.selected === this.selectedId && k.projected === this.projected && k.edited === edited) return k.ids;
    const ids = new Set<string>(this.selectedId !== null ? this.subtreeIds(this.selectedId) : []);
    for (const id of edited ?? []) ids.add(id);
    this.occlusionKept = { selected: this.selectedId, projected: this.projected, edited, ids };
    return ids;
  }

  /** A loaded instance buffer (the copies' transforms), if here. */
  instanceBuffer(digest: string): Float32Array | undefined {
    return this.adapter.instanceBuffer?.(digest);
  }

  // ---- Block layers --------------------------------------------------
  /** The layers last handed over (a new adapter gets them again). */
  private blockInput: { types: readonly BlockType[]; layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; hidden?: boolean }>; revision: number } | null = null;
  private blockRevision = -1;
  /** The chunk objects each layer was last drawn from (edits hand over only the changed ones). */
  private blockApplied = new Map<string, { component: string; chunks: Map<string, BlockChunk> }>();

  /**
   * The project's block layers (their component, stored chunks and origin)
   * and block types; `revision` changes whenever cells, layers or types do.
   * They are drawn by the adapter's block view (the same merged chunk meshes Play and exports draw).
   */
  setBlockLayers(types: readonly BlockType[], layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; regions?: readonly BlockRegion[]; hidden?: boolean }>, revision: number): void {
    this.blockInput = { types, layers, revision };
    const view = this.adapter.blockLayers?.();
    if (view === undefined) return;
    this.brushSurfaces.update(types, layers, revision);
    if (revision !== this.blockRevision) {
      this.blockRevision = revision;
      view.setTypes(types);
      for (const id of view.layerIds()) {
        if (layers.has(id)) continue;
        view.removeLayer(id);
        this.blockApplied.delete(id);
      }
      for (const [id, l] of layers) {
        // Only the chunks whose stored object changed are handed over (an edit re-meshes
        // the chunks it touched, not the layer; a previewed stroke's chunks then compare equal).
        // A layer with cut-aways is split by its regions: a region edit meshes it again.
        const key = JSON.stringify(l.component) + (l.component.cutaway !== undefined ? JSON.stringify(l.regions ?? []) : '');
        const prev = this.blockApplied.get(id);
        if (prev === undefined || prev.component !== key || !view.hasLayer(id)) view.setLayer(id, l.component, l.origin, { entityId: id, chunks: [...l.chunks.values()], ...(l.regions !== undefined && l.regions.length > 0 ? { regions: l.regions.map((r) => ({ regionId: r.regionId, boxes: r.boxes.map((b) => [...b]) })) } : {}) });
        else {
          const changed: { cx: number; cz: number; chunk: BlockChunk | null }[] = [];
          for (const [k, c] of l.chunks) if (prev.chunks.get(k) !== c) changed.push({ cx: c.cx, cz: c.cz, chunk: c });
          for (const k of prev.chunks.keys()) {
            if (l.chunks.has(k)) continue;
            const [cx, cz] = k.split(',').map(Number) as [number, number];
            changed.push({ cx, cz, chunk: null });
          }
          if (changed.length > 0) view.replaceChunks(id, changed);
          view.setOrigin(id, l.origin);
        }
        this.blockApplied.set(id, { component: key, chunks: new Map(l.chunks) });
      }
    } else {
      for (const [id, l] of layers) view.setOrigin(id, l.origin);
    }
    // A hidden layer object (inactive) is not drawn.
    for (const [id, l] of layers) view.setHidden(id, l.hidden === true);
    this.requestRender();
  }

  // ---- Scene-view tools ------------------------------------------------
  /** The block-layer editing tools (created on first use with the App's callbacks). */
  blockEditor(cb?: BlockEditorCallbacks): BlockEditor | null {
    return this.tools.blockEditor(cb);
  }

  /** The terrain tools (created on first use with the App's callbacks). */
  terrainEditor(cb?: TerrainEditorCallbacks): TerrainEditor | null {
    return this.tools.terrainEditor(cb);
  }

  /**
   * Snap moved and dropped objects to block-layer cell tops (null:
   * off). The function maps an object's world position to the snapped one
   * (null: not over a layer).
   */
  setCellTopSnap(fn: ((entityId: string | null, position: readonly number[], rotation: readonly number[]) => [number, number, number] | null) | null): void {
    this.cellTopSnap = fn;
  }

  private cellTopSnap: ((entityId: string | null, position: readonly number[], rotation: readonly number[]) => [number, number, number] | null) | null = null;

  // ---- Lighting, lightmaps, environment ----------------------------------
  /** The last synced entities. */
  private projected: readonly ProjectedEntity[] = [];

  /** The project's bakes (sceneId → bake); null clears them. They show with game lighting. */
  /**
   * Draw an object with one component as given, without storing it (a room's
   * wall being dragged): the adapter takes the patched document as an edit
   * (generated architecture makes only the chunks that changed); null draws
   * it as the projection has it.
   */
  previewComponent(entityId: string, component: string, value: unknown): boolean {
    const i = this.projected.findIndex((e) => e.id === entityId);
    if (i < 0) return false;
    const e = this.projected[i]!;
    const next = value === null ? e : ({ ...e, components: { ...e.components, [component]: value } } as ProjectedEntity);
    this.source.sync(
      this.projected.map((x, k) => (k === i ? next : x)),
      [next],
    );
    this.adapter.sync?.();
    this.requestRender();
    return true;
  }

  /** The project's architecture style and preset graphs changed: outlines are made again where their elements changed. */
  setArchitectureStyles(graphs: readonly ArchitectureGraphLike[]): void {
    this.archStyles = graphs;
    this.adapter.setArchitectureStyles?.(graphs);
    this.requestRender();
  }

  /** A preset's slider being dragged (null: the stored values again); how many objects are made again. */
  previewArchitecture(preview: ArchitecturePreview | null): number {
    const n = this.adapter.previewArchitecture?.(preview) ?? 0;
    this.requestRender();
    return n;
  }

  setLightmaps(bakes: Readonly<Record<string, LightingBakeLike>> | null): void {
    this.bakes = bakes;
    if (this.lighting.mode === 'game') this.adapter.setBakes?.(bakes);
    this.requestRender();
  }

  /**
   * What a bake of these entities needs, in world space: each static object's
   * meshes (with UV1: a lightmap target; without: a shadow caster only) and
   * the baked lights. Models use their most detailed level.
   */
  bakeInputs(entityIds: ReadonlySet<string>): BakeInputs {
    this.adapter.sync?.();
    return gatherBakeInputs(
      {
        projected: this.projected,
        rootOf: (e) => (e.kind === 'model' || e.kind === 'box' ? (this.adapter.entityObject?.(e.id) ?? null) : null),
        nodeOf: (id) => this.frameOf(id) ?? undefined,
        blockView: this.adapter.blockLayers?.() ?? null,
      },
      entityIds,
    );
  }

  /** A texture asset as this view decodes it (the sky's image for "align the sky's sun"). */
  loadTexture(assetId: string): Promise<THREE.Texture | null> {
    return this.assets.loadTexture(assetId);
  }

  /** Decode textures ahead of the materials that will draw them, held until `release` (null: the library cannot). */
  preloadTextures(keys: readonly string[]): { readonly ready: Promise<void>; release(): void } | null {
    return this.assets.materialLibrary.preloadTextures?.(keys) ?? null;
  }

  /**
   * What the probe bake draws with: this view's renderer and its scene (the
   * sky), the baked lights, and the hooks that gather the static objects and
   * probe volumes (world matrices current).
   */
  probeBakeContext(): { host: ProbeBakeHost; lights: BakeInputs['lights']; renderer: unknown; scene: THREE.Scene | null } {
    this.adapter.sync?.();
    const host: ProbeBakeHost = {
      projected: this.projected,
      rootOf: (e) => (e.kind === 'model' || e.kind === 'box' ? (this.adapter.entityObject?.(e.id) ?? null) : null),
      blockView: this.adapter.blockLayers?.() ?? null,
      architecture: this.adapter.architectureBake?.() ?? null,
      worldMatrix: (id, out) => this.adapter.worldMatrix?.(id, out) === true,
    };
    return { host, lights: gatherBakeLights({ projected: this.projected, nodeOf: (id) => this.frameOf(id) ?? undefined }), renderer: this.adapter.currentRenderer?.() ?? null, scene: this.adapter.threeScene?.() ?? null };
  }

  /**
   * The Scene view's lighting: "editor" is a fixed key + fill rig, "game" the
   * scene's own lights, look and lightmaps (what Play shows). Automatic until
   * chosen: game lighting as soon as the scene has a light.
   */
  setLighting(mode: 'editor' | 'game'): void {
    this.lighting = { mode, chosen: true };
    this.applyLightingMode();
  }
  getLighting(): 'editor' | 'game' {
    return this.lighting.mode;
  }

  private applyLightingMode(): void {
    if (!this.lighting.chosen) this.lighting.mode = this.projected.some((e) => e.light !== undefined) ? 'game' : 'editor';
    const rig = this.lighting.mode === 'editor';
    if (rig === this.source.rigOn && this.lookApplied === this.lighting.mode) return;
    this.lookApplied = this.lighting.mode;
    this.source.setRig(rig, this.projected);
    this.applyLook();
    this.requestRender();
  }
  private lookApplied: 'editor' | 'game' | null = null;

  /** The project environment (sky, fog, fog volumes, post) in the Scene view — with game lighting only. */
  setEnvironment(value: EnvironmentLike | null): void {
    this.environmentValue = value;
    this.environmentSet = true;
    const quality = value?.quality;
    this.adapter.setEnvironment?.(this.lighting.mode === 'game' ? value : quality !== undefined ? { quality } : null);
    this.requestRender();
  }

  /**
   * Show an environment preset blend (weights by preset id; '' = the base
   * look) in the Scene view with game lighting: the look, and the scene
   * lights the presets set — the runtime's own blend maths (what Play draws).
   * Null: back to the authored look. `tagBits`: the project's tag registry
   * (name → bit) for presets that name lights by tag.
   */
  previewEnvironmentBlend(view: { weights: readonly (readonly [string, number])[]; overrides?: EnvironmentBlendView['overrides'] } | null, tagBits?: ReadonlyMap<string, number>): void {
    this.envPreview = view === null ? null : { weights: view.weights, overrides: view.overrides ?? {}, target: null, progress: 1 };
    if (tagBits !== undefined) this.envPreviewTags = tagBits;
    this.adapter.previewEnvironmentBlend?.(this.lighting.mode === 'game' ? this.envPreview : null, this.envPreviewTags);
    this.requestRender();
  }
  /** The previewed blend (tests, the panel). */
  environmentPreview(): EnvironmentBlendView | null {
    return this.envPreview;
  }

  // ---- Virtual cameras and the timeline preview ----------------------------
  /**
   * Every virtual camera's preview, rebuilt from the authored data
   * on each sync with the runtime's own rig maths (the camera brain) — the
   * pose Play starts it at, before input moves it.
   */
  private readonly vcamPreviews = new THREE.Group();
  private syncVirtualCameraPreviews(entities: readonly ProjectedEntity[]): void {
    for (const c of [...this.vcamPreviews.children]) {
      this.vcamPreviews.remove(c);
      (c as THREE.LineSegments).geometry.dispose();
      ((c as THREE.LineSegments).material as THREE.Material).dispose();
    }
    const previews = virtualCameraPreviews(entities, this.gameAspect, this.viewLens);
    if (previews.length > 0 && this.vcamPreviews.parent === null) {
      this.vcamPreviews.name = 'virtual-camera-previews';
      this.overlay.add(this.vcamPreviews);
    }
    for (const v of previews) {
      v.lines.visible = this.selectedId === v.id;
      this.vcamPreviews.add(v.lines);
    }
    this.showVirtualCameraPreview();
  }
  /**
   * The timeline tab's scrub preview — the bound objects at the
   * timeline's time (the runtime's own evaluation, `evaluateTimelineAt`) and
   * the live camera's frustum there (the camera brain's rig maths, with the
   * key's rail progress). Presentation only: nothing is written to the
   * project; null restores the authored transforms. `data-timeline-preview`
   * reports what is drawn (the objects' local positions as drawn).
   */
  private timelinePreview: { time: number; transforms: ReadonlyMap<string, { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] }>; camera: { entityId: string; progress: number | null } | null } | null = null;
  private readonly timelinePreviewed = new Set<string>();
  private timelineFrustum: THREE.LineSegments | null = null;
  setTimelinePreview(preview: { time: number; transforms: ReadonlyMap<string, { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] }>; camera: { entityId: string; progress: number | null } | null } | null): void {
    this.timelinePreview = preview;
    this.applyTimelinePreview();
  }
  private applyTimelinePreview(): void {
    for (const id of this.timelinePreviewed) if (!(this.draggingGizmo && id === this.gizmoTargetId)) this.source.setOverride(id, null);
    this.timelinePreviewed.clear();
    if (this.timelineFrustum !== null) {
      this.timelineFrustum.removeFromParent();
      this.timelineFrustum.geometry.dispose();
      (this.timelineFrustum.material as THREE.Material).dispose();
      this.timelineFrustum = null;
    }
    const p = this.timelinePreview;
    if (p === null) {
      this.root.setAttribute('data-timeline-preview', '');
      this.requestRender();
      return;
    }
    const shown: Record<string, number[]> = {};
    for (const [id, pose] of p.transforms) {
      const base = this.synced.get(id);
      if (base === undefined) continue;
      const t = { position: pose.position ?? base.position, rotation: pose.rotation ?? base.rotation, scale: pose.scale ?? base.scale };
      this.source.setOverride(id, t);
      this.timelinePreviewed.add(id);
      shown[id] = [t.position[0] ?? 0, t.position[1] ?? 0, t.position[2] ?? 0];
    }
    let camera: unknown = null;
    if (p.camera !== null) {
      const v = virtualCameraPreviews(this.projected, this.gameAspect, this.viewLens, p.camera, p.transforms)[0];
      if (v !== undefined) {
        this.timelineFrustum = v.lines;
        this.timelineFrustum.name = `timeline-camera:${v.id}`;
        this.overlay.add(this.timelineFrustum);
        camera = { id: v.id, position: [...v.pose.position], rotation: [...v.pose.rotation] };
      }
    }
    this.root.setAttribute('data-timeline-preview', JSON.stringify({ time: Math.round(p.time * 1000) / 1000, transforms: shown, camera }));
    this.requestRender();
  }

  private showVirtualCameraPreview(): void {
    let shown: unknown = null;
    for (const c of this.vcamPreviews.children) {
      const on = c.userData['virtualCameraFrustum']?.id === this.selectedId;
      c.visible = on;
      if (on) shown = c.userData['virtualCameraFrustum'];
    }
    this.root.setAttribute('data-virtual-camera', shown === null ? '' : JSON.stringify(shown));
  }

  // ---- Where things are ----------------------------------------------------
  /** An entity's world matrix (composed by the adapter), or null when it is not drawn here. */
  private worldOf(id: string): THREE.Matrix4 | null {
    const m = new THREE.Matrix4();
    return this.adapter.worldMatrix?.(id, m) === true ? m : null;
  }

  /** An object standing at an entity's world matrix (handles and the bake read frames from it). */
  private frameOf(id: string): THREE.Object3D | null {
    const m = this.worldOf(id);
    if (m === null) return null;
    const o = frameObject();
    o.matrix.copy(m);
    o.matrixWorld.copy(m);
    return o;
  }

  /** An entity and the ones below it (bounds and outlines of a model built from parts). */
  private subtreeIds(rootId: string): string[] {
    const kids = new Map<string, string[]>();
    for (const e of this.projected) {
      if (e.parentId === null) continue;
      let list = kids.get(e.parentId);
      if (list === undefined) kids.set(e.parentId, (list = []));
      list.push(e.id);
    }
    const out: string[] = [];
    const walk = (id: string, depth: number): void => {
      out.push(id);
      if (depth < 64) for (const c of kids.get(id) ?? []) walk(c, depth + 1);
    };
    walk(rootId, 0);
    return out;
  }

  /**
   * Every mesh an entity draws itself (not its overlays, not its children's), with current world matrices. `paths`:
   * with what it generates outside its node too (a building's or a spline's chunks carry its id, not its node).
   */
  private drawnMeshes(id: string, paths = false): THREE.Mesh[] {
    const node = this.adapter.entityObject?.(id) ?? null;
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if (o.userData[OVERLAY_KEY] === true) return;
      if ((o as THREE.Mesh).isMesh === true) out.push(o as THREE.Mesh);
      for (const c of o.children) visit(c);
    };
    if (node !== null) visit(node);
    if (paths) for (const o of this.adapter.pickables?.() ?? []) if (o !== node && o !== this.overlay && this.adapter.paintOwnerOf?.(o) === id) visit(o);
    return out;
  }

  private boundsOf(ids: readonly string[], include: (e: ProjectedEntity | undefined) => boolean): THREE.Box3 {
    const box = new THREE.Box3();
    const one = new THREE.Box3();
    for (const id of ids) {
      if (!include(this.synced.get(id))) continue;
      for (const mesh of this.drawnMeshes(id, true)) {
        if (mesh.userData['tlBatch'] === true) continue;
        mesh.updateWorldMatrix(true, false);
        one.makeEmpty().expandByObject(mesh, false);
        box.union(one);
      }
    }
    return box;
  }

  /**
   * For "Fit to model": the bounding box of the models drawn for
   * an entity — its own model and its children's — relative to the entity's
   * world position, or null when none is loaded.
   */
  modelBounds(entityId: string): { min: number[]; max: number[] } | null {
    this.adapter.sync?.();
    const world = this.worldOf(entityId);
    if (world === null) return null;
    const box = this.boundsOf(this.subtreeIds(entityId), (e) => e?.kind === 'model');
    if (box.isEmpty()) return null;
    const at = new THREE.Vector3().setFromMatrixPosition(world);
    return { min: [box.min.x - at.x, box.min.y - at.y, box.min.z - at.z], max: [box.max.x - at.x, box.max.y - at.y, box.max.z - at.z] };
  }

  /** A clipped decal's mesh as the Scene view draws it, in its object's space (null: none yet): what "Bake to model" writes. */
  clippedDecalMesh(entityId: string): THREE.Mesh | null {
    return this.adapter.clippedDecalMesh?.(entityId) ?? null;
  }

  /** Where the camera is looking (new entities spawn here). */
  focusPoint(): [number, number, number] {
    const t = this.orbit.target;
    return [t.x, t.y, t.z];
  }

  /** What a ray from the view hits among the drawn objects and the entities' overlays (nearest first); `all`: what an edit mode cannot pick too (a decal is placed on any surface). */
  private castScene(clientX: number, clientY: number, all = false): THREE.Intersection[] {
    const rect = this.root.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.castTargets();
    if (all) return hits;
    // In an edit mode only the edited objects are hit (the rest, shown as context or not, is never picked or painted).
    const entityOf = (o: THREE.Object3D): string | null => this.adapter.entityOf?.(o) ?? null;
    return this.isolation.hits(hits, (o) => drawOwner(o, entityOf));
  }

  /** What a ray from a world point hits within `far` metres among the drawn objects (nearest first; a decal scatter's drop). */
  private castRay(origin: readonly number[], dir: readonly number[], far: number): THREE.Intersection[] {
    this.raycaster.set(new THREE.Vector3(origin[0], origin[1], origin[2]), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
    this.raycaster.far = far;
    const hits = this.castTargets();
    this.raycaster.far = Infinity;
    return hits;
  }

  /** The raycaster's hits among the drawables (those drawn through batches too; the batches' own meshes stand for objects picked themselves) — not the view's overlay group. */
  private castTargets(): THREE.Intersection[] {
    this.adapter.sync?.();
    const scene = this.adapter.threeScene?.();
    if (scene === undefined) return [];
    const targets = (this.adapter.pickables?.() ?? scene.children).filter((o) => o !== this.overlay && o.userData['tlBatch'] !== true);
    return this.raycaster.intersectObjects(targets, true).filter((h) => h.object.visible);
  }

  /**
   * Where something dropped at a pointer position lands: the first visible
   * surface under the pointer, else the ground plane (y = 0), else the focus
   * point. Snapped to the translate step when snapping is on.
   */
  dropPoint(clientX: number, clientY: number): [number, number, number] {
    let point: THREE.Vector3 | null = null;
    for (const h of this.castScene(clientX, clientY)) {
      if ((h.object as THREE.Mesh).isMesh === true) {
        point = h.point.clone();
        break;
      }
    }
    if (point === null) point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    const p = point ?? this.orbit.target.clone();
    const step = this.snapping() ? getSnapSettings().translateM : 0.001;
    const snap = (v: number): number => {
      const r = Math.round(v / step) * step;
      return Math.abs(r) < 1e-9 ? 0 : Number(r.toFixed(3));
    };
    const snapped: [number, number, number] = [snap(p.x), snap(p.y), snap(p.z)];
    // Onto the cell top under the drop point.
    return this.cellTopSnap?.(null, snapped, [0, 0, 0, 1]) ?? snapped;
  }

  /**
   * Orbit around the entity's world position, keeping the view direction and
   * distance — unless that puts the camera inside what the entity draws (a
   * building's walls): then the view frames it from outside. A terrain is
   * ground, not walls: a view low over it is inside its box but sees it, so F
   * orbits it.
   */
  focus(id: string): void {
    this.adapter.sync?.();
    const m = this.worldOf(id);
    if (m === null) return;
    const world = new THREE.Vector3().setFromMatrixPosition(m);
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const box = this.boundsOf(this.subtreeIds(id), () => true);
    const ground = this.adapter.terrains?.()?.field(id) != null;
    if (!ground && !box.isEmpty() && insideBox(world.clone().add(offset).toArray(), { min: box.min.toArray(), max: box.max.toArray() }, this.camera.near)) {
      this.fitBox(box);
      return;
    }
    this.orbit.target.copy(world);
    this.camera.position.copy(world).add(offset);
    this.orbit.update();
  }

  private render(): void {
    this.requestRender();
  }

  // ---- The edit-mode effect preview ------------------------------------
  private readonly effects = new EffectPreview({
    overlay: this.overlay,
    camera: () => this.camera,
    canvas: () => this.root,
    adapter: () => this.adapter,
    materialLibrary: () => this.assets.materialLibrary,
    api: () => this.rendererInfoNow.api,
    requestRender: () => this.requestRender(),
  });

  /**
   * Play the selected object's effect in the Scene view (the Gizmos menu's
   * toggle): the same player Play uses, on this view's renderer (WebGPU
   * compute or the CPU executor). A finished one-shot starts again. Off (or
   * no effect on the selection): nothing plays.
   */
  setEffectPreview(on: boolean, defs: readonly EffectDefLike[], target: { id: string; component: EffectComponentLike } | null, loadTexture: ((assetId: string) => Promise<THREE.Texture | null>) | null): void {
    this.effects.set(on, defs, target, loadTexture);
  }

  /** The Game view is in front (the view draws nothing meanwhile). */
  setHidden(on: boolean): void {
    this.visibility.setHidden(on);
  }

  /** The canvas is lent to a preview pane or an edit mode (seen whatever the centre view shows). */
  setLent(on: boolean): void {
    this.visibility.setLent(on);
  }

  /**
   * An edit mode's isolation (null: none, `view-isolation.ts`): what is
   * drawn and hit meanwhile; the gizmo, the selection outline and the other
   * objects' helpers stand aside.
   */
  setIsolation(iso: ViewIsolation | null): void {
    if (!this.isolation.set(iso)) return;
    this.setSelected(this.selectedId);
  }

  /** The grid and its ground square, unless an edit mode hides the rest of the scene (`view-isolation.ts`). */
  private syncGround(): void {
    this.grid.visible = this.gizmos.grid && !this.isolation.hidesRest;
    this.ground.visible = this.grid.visible;
  }

  /** The entities whose helpers are drawn: the shown ones, only the edited ones in an edit mode. */
  private helperEntities(): ProjectedEntity[] {
    return this.projected.filter((e) => this.hierarchyFlags.get(e.id)?.active !== false && this.isolation.shows(e.id));
  }

  /** A key for the Scene view's armed tools (only those named, when given); true when one took it. */
  toolKey(e: KeyboardEvent, names?: readonly string[]): boolean {
    return this.tools.router.key(e, this.selectedId, names);
  }

  /**
   * Frame an object from the current view direction: `localBox` (its own
   * frame; a terrain's tiles and height range) or else the meshes it draws.
   */
  frameEntity(id: string, localBox?: { min: readonly number[]; max: readonly number[] }): boolean {
    this.adapter.sync?.();
    const world = this.worldOf(id);
    if (world === null) return false;
    let box: THREE.Box3;
    if (localBox !== undefined) {
      box = new THREE.Box3(new THREE.Vector3(...(localBox.min as [number, number, number])), new THREE.Vector3(...(localBox.max as [number, number, number]))).applyMatrix4(world);
    } else box = this.boundsOf(this.subtreeIds(id), () => true);
    if (box.isEmpty()) {
      this.focus(id);
      return true;
    }
    this.fitBox(box);
    return true;
  }

  /**
   * A working view of part of an object (an edit mode entered): looking down
   * from the present heading, the horizon {@link WORK_VIEW_SKY} of the view
   * below its top, onto the middle of
   * `localBox` (its own frame) — on the ground there when the object is a
   * terrain — near enough that the box's width fills the view. With
   * `keepIf` (the object's whole box, its own frame) a view already aimed
   * inside its footprint is left as it is: the user framed what to work on.
   * True once settled (false: the object is not drawn yet).
   */
  frameWorkArea(id: string, localBox: { min: readonly number[]; max: readonly number[] }, keepIf: { min: readonly number[]; max: readonly number[] } | null = null): boolean {
    this.adapter.sync?.();
    const world = this.worldOf(id);
    if (world === null) return false;
    const boxOf = (b: { min: readonly number[]; max: readonly number[] }): THREE.Box3 => new THREE.Box3(new THREE.Vector3(...(b.min as [number, number, number])), new THREE.Vector3(...(b.max as [number, number, number]))).applyMatrix4(world);
    const box = boxOf(localBox);
    const center = box.getCenter(new THREE.Vector3());
    const ground = this.adapter.terrains?.()?.field(id)?.heightAt(center.x, center.z);
    if (typeof ground === 'number' && Number.isFinite(ground)) center.y = ground;
    const span = Math.max(2, box.max.x - box.min.x, box.max.z - box.min.z);
    const heading = this.camera.position.clone().sub(this.orbit.target).setY(0);
    if (heading.lengthSq() < 1e-6) heading.set(0, 0, 1);
    heading.normalize();
    const half = Math.tan((this.camera.fov * Math.PI) / 360);
    const pitch = Math.atan((1 - 2 * WORK_VIEW_SKY) * half);
    const distance = span / 2 / half;
    if (keepIf !== null) {
      const whole = boxOf(keepIf);
      const t = this.orbit.target;
      const margin = 1;
      const aimed = t.x >= whole.min.x - margin && t.x <= whole.max.x + margin && t.z >= whole.min.z - margin && t.z <= whole.max.z + margin;
      if (aimed && viewPitchDeg(this.camera.position.toArray(), t.toArray()) >= ENTRY_LEVEL_DEG) return true;
    }
    const dir = heading.multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.far = Math.max(1000, distance * 10);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.requestRender();
    return true;
  }

  // ---- Frames ------------------------------------------------------------
  /** The selection outline follows the selection's drawn bounds (moved, loaded, changed). */
  private outlineDirty = true;
  /** The model failures last reported (a change is reported again). */
  private failuresMark = '';
  /** The view's pose last stamped on the canvas. */
  private poseMark = '';
  /** The view-projection matrix last stamped on the canvas. */
  private viewProjMark = '';

  /** Schedule one render on the next animation frame (coalesces bursts). */
  requestRender(): void {
    if (!this.visibility.allows()) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.visibility.allows()) return;
      this.frame();
    });
  }

  private frame(): void {
    const adapter = this.adapter;
    // The world as the adapter will draw it: the gizmo's frame, the selection outline, the copy box follow it.
    adapter.sync?.();
    if (!this.draggingGizmo) this.placeGizmoFrame();
    if (this.outlineDirty || this.draggingGizmo) this.updateSelectionOutline();
    // Where the handle grips are on screen (tests drag them); grips keep their screen size.
    this.helpers.scaleGrips();
    this.root.setAttribute('data-size-handles', JSON.stringify(this.helpers.sizeHandleClientPoints()));
    this.tools.frame();
    // The selected instance set's copies and the gizmo's X arrow on screen (tests click and drag them).
    const setId = this.selectedId !== null && this.synced.get(this.selectedId)?.instances !== undefined ? this.selectedId : null;
    this.root.setAttribute('data-instance-copies', setId === null ? '[]' : JSON.stringify(this.copyClientPoints(setId)));
    this.root.setAttribute('data-gizmo-grab', JSON.stringify(this.gizmoGrab()));
    // The view's pose and lens (a test frames a game camera the same way).
    const c = this.camera;
    const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
    const pose = JSON.stringify({ position: c.position.toArray().map(r6), rotation: c.quaternion.toArray().map(r6), fovY: c.fov, near: c.near, far: c.far });
    if (pose !== this.poseMark) {
      this.poseMark = pose;
      this.root.setAttribute('data-view-camera', pose);
    }
    const renderer = adapter.currentRenderer?.() ?? null;
    // The effect preview steps before the frame and keeps the view drawing while it plays.
    const playing = this.effects.step(renderer);
    // Animated materials (wind, water) tick with the frame (the adapter ticks them) and keep the view drawing;
    // nothing else draws unless something asked for a frame (render on demand).
    const animated = this.assets.materialLibrary.animated();
    const terrain = adapter.terrainDiagnostics?.() ?? null;
    // The view-projection matrix when it changes (tests map cells and world points to the screen).
    this.camera.updateMatrixWorld();
    const viewProj = JSON.stringify(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements.map((v) => Math.round(v * 1e6) / 1e6));
    if (viewProj !== this.viewProjMark) {
      this.viewProjMark = viewProj;
      this.root.setAttribute('data-view-proj', viewProj);
    }
    this.followProbeDebug(adapter);
    this.occlusion.keep(this.keptFromOcclusion());
    const drawn = adapter.renderFrame();
    // The renderer starting or a precompile running skips the frame: ask again until one is drawn.
    if (!drawn.ok || adapter.frameSkipped?.() === true) {
      if (drawn.ok || drawn.error.code === 'render_context_lost') this.requestRender();
      return;
    }
    this.framesDrawn += 1;
    // The block layers drawn (once the project's layers were handed over; tests read them).
    const blocks = adapter.blockLayers?.();
    if (blocks !== undefined && this.blockInput !== null) this.root.setAttribute('data-block-layers', JSON.stringify(blocks.diagnostics()));
    // The terrains drawn (tests read the tiles drawn and the nodes selected).
    if (terrain !== null) this.root.setAttribute('data-terrain', JSON.stringify(adapter.terrainDiagnostics?.() ?? terrain));
    else this.root.removeAttribute('data-terrain');
    this.tools.afterFrame();
    this.occlusion.afterFrame();
    const f = adapter.lastFrame?.();
    this.root.setAttribute('data-frames', String(this.framesDrawn));
    // An edit mode's isolation: drawables hidden and swept at this frame (tests and the perf check read it).
    if (this.isolation.active) {
      const d = adapter.isolationDiagnostics?.();
      if (d !== undefined) this.root.setAttribute('data-isolated-draws', `${d.hidden} ${d.swept}`);
    }
    // The renderer's live resource counts after the frame (the leak tests read them).
    const live = adapter.currentRenderer?.() ?? null;
    if (live !== null) this.root.setAttribute('data-memory', JSON.stringify(rendererMemory(live)));
    if (f !== undefined) {
      this.root.setAttribute('data-draw-calls', String(f.drawCalls));
      this.root.setAttribute('data-triangles', String(f.triangles));
      const b = f.batching ?? { groups: 0, batched: 0, single: 0 };
      this.root.setAttribute('data-batches', `${b.groups} ${b.batched} ${b.single}`);
      // Static batching: merged cells drawn, objects drawn through them, cells still building.
      const m = f.batching?.merging;
      this.root.setAttribute('data-merged', m === undefined ? '' : `${m.cells} ${m.merged} ${m.pending}`);
      this.root.setAttribute('data-msaa', String(f.samples));
    }
    const failures = adapter.modelFailures?.() ?? new Map();
    const mark = JSON.stringify([...failures]);
    if (mark !== this.failuresMark) {
      this.failuresMark = mark;
      this.cb.onModelFailures?.(failures);
    }
    if (playing || animated || this.occlusion.animating) this.requestRender();
    if (!playing) this.effects.idle();
  }

  // ---- The renderer backend --------------------------------------------
  /** The Scene view's renderer choice (backend, state, reason). */
  rendererInfo(): RendererInfo {
    return this.rendererInfoNow;
  }

  /**
   * Draw with another backend. A canvas keeps the context type it
   * was first given (WebGL or WebGPU), so the canvas is replaced by a fresh
   * one in the same place, with the same attributes and listeners, and the
   * adapter with it (the files and textures stay in the view's resource manager).
   */
  setRendererChoice(preference: RendererPreference, source: RendererPreferenceSource): void {
    if (preference === this.rendererChoice.preference) {
      this.rendererChoice = { preference, source };
      return;
    }
    this.rendererChoice = { preference, source };
    const old = this.root;
    const next = document.createElement('canvas');
    for (const a of [...old.attributes]) if (!a.name.startsWith('data-tl-renderer')) next.setAttribute(a.name, a.value);
    this.unbindCanvasEvents();
    this.effects.rendererGone();
    this.overlay.removeFromParent();
    // The old canvas is never drawn to again: the adapter frees its renderer (and its WebGL context).
    this.adapter.dispose();
    old.replaceWith(next);
    this.root = next;
    this.bindCanvasEvents();
    this.orbit.disconnect();
    // The old canvas already left the page: its document keeps OrbitControls' key listeners otherwise.
    releaseControlKeyListeners(this.orbit);
    this.orbit.connect(next);
    this.gizmo.disconnect();
    this.gizmo.connect(next);
    this.helpers.setCanvas(next);
    this.rendererInfoNow = { requested: preference, source, backend: null, api: null, state: 'initialising', reason: 'choosing a backend', recoveries: 0 };
    this.adapter = this.makeAdapter(next);
    this.occlusion.apply();
    this.isolation.apply();
    this.lookApplied = null;
    this.applyLightingMode();
    if (this.environmentSet) this.setEnvironment(this.environmentValue);
    this.blockRevision = -1;
    this.blockApplied.clear();
    if (this.blockInput !== null) this.setBlockLayers(this.blockInput.types, this.blockInput.layers, this.blockInput.revision);
    this.resize();
    this.cb.onRendererChange?.(this.rendererInfoNow);
  }

  private readTarget(): GizmoTransform {
    const t = this.gizmoProxy;
    return {
      position: [t.position.x, t.position.y, t.position.z],
      rotation: [t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w],
      scale: [clampScale(t.scale.x), clampScale(t.scale.y), clampScale(t.scale.z)],
    };
  }

  /** Grid snapping for the current drag (default on; Shift disables it). */
  private applySnapping(): void {
    const on = this.snapping();
    const s = getSnapSettings();
    this.gizmo.setTranslationSnap(on ? s.translateM : null);
    this.gizmo.setRotationSnap(on ? (s.rotateDeg * Math.PI) / 180 : null);
    this.gizmo.setScaleSnap(on ? s.scale : null);
    // The step in force (tests read it).
    this.root.setAttribute('data-snap-step', on ? String(s.translateM) : '');
  }

  /** Cancel an in-flight gizmo gesture (Esc): revert, send nothing. */
  cancelGesture(): boolean {
    // A tool's stroke or drag in flight is dropped (nothing is sent).
    if (this.tools.router.cancel()) return true;
    if (!this.draggingGizmo || this.gizmoCancelled) return false;
    this.gizmo.reset();
    this.gizmoCancelled = true;
    if (this.gizmoTargetId !== null && this.gizmo.object === this.gizmoProxy) this.source.setOverride(this.gizmoTargetId, null);
    this.render();
    return true;
  }

  /**
   * Sync the entity set from the projection.
   *
   * incremental. With `dirty` (the projection's `takeDirty()`)
   * only the entities it names — plus any whose projected object changed
   * since the last sync (the projection is copy-on-write) and the ones added
   * or removed — are handed to the adapter; the hierarchy flags, the helper
   * overlay and the selection are re-derived only when something they read
   * changed. Without it (or `dirty.all`), everything is synced as before.
   * `data-sync` on the view element says what the last sync did.
   */
  syncEntities(entities: ProjectedEntity[], dirty?: { readonly all: boolean; readonly ids: ReadonlySet<string> }): void {
    const t0 = performance.now();
    this.projected = entities;
    const plan = planSync(entities, this.synced, dirty, this.selectedId);
    const { full, changed, selectionTouched } = plan;
    let { structural, helpers } = plan;
    if (structural) this.deriveFlags(entities);
    // A released drag stops overriding once the projection has its outcome (stored, refused, or a full restore).
    for (const id of [...this.settling]) {
      if (!full && !changed.some((e) => e.id === id)) continue;
      this.settling.delete(id);
      if (!(this.draggingGizmo && id === this.gizmoTargetId) && !this.timelinePreviewed.has(id)) this.source.setOverride(id, null);
    }
    for (const e of changed) {
      this.entityOverlays.sync(e);
      this.synced.set(e.id, e);
    }
    // Entities that are gone (after the adds the synced set equals the entities unless some left).
    const removed = new Set(removedIds(entities, this.synced.keys(), this.synced.size, full));
    if (removed.size > 0) {
      for (const id of removed) {
        if (helperRelevant(this.synced.get(id))) helpers = true;
        this.entityOverlays.remove(id);
        this.synced.delete(id);
        if (this.selectedId === id) this.setSelected(null);
      }
      if (!structural) {
        structural = true;
        this.deriveFlags(entities);
      }
    }
    this.source.sync(entities, full ? null : changed);
    if (structural) this.isolation.follow();
    // Automatic lighting follows whether the scene has a light.
    this.applyLightingMode();
    this.syncVirtualCameraPreviews(entities);
    // A timeline scrub preview stays on top of the synced transforms.
    if (this.timelinePreview !== null) this.applyTimelinePreview();
    // The helper overlay syncs from the SAME projection pass
    // (an inactive entity's helpers are hidden like the entity).
    // The selected entity's handles come from any of its sized components: its change re-syncs the overlay too.
    const shown = this.helperEntities();
    this.adapter.sync?.();
    if (helpers || structural || selectionTouched) this.helpers.sync(shown);
    else this.helpers.setEntities(shown);
    this.stampGizmoCounts();
    this.outlineDirty = true;
    // A selection that became locked or a folder loses its gizmo.
    if (this.selectedId !== null && !this.draggingGizmo && (selectionTouched || structural)) this.setSelected(this.selectedId);
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    this.root.setAttribute('data-sync', JSON.stringify({ entities: entities.length, processed: changed.length, removed: removed.size, full, ms }));
    this.render();
  }

  /** The hierarchy flags, the folders and the hidden (inactive) objects. */
  private deriveFlags(entities: readonly ProjectedEntity[]): void {
    this.hierarchyFlags = effectiveFlagsOf(entities);
    this.folderIds = new Set(entities.filter((e) => e.kind === 'folder').map((e) => e.id));
    const hidden = new Set<string>();
    const statics = new Set<string>();
    for (const [id, f] of this.hierarchyFlags) {
      if (!f.active) hidden.add(id);
      // An object kept loaded across scenes is never merged into a scene's cells (as in Play).
      else if (f.static && !f.keepLoaded) statics.add(id);
    }
    this.source.setHidden(hidden);
    this.source.setStatic(statics);
  }

  /** Show or hide the Scene view's helpers (icons, light ranges, collider outlines, gameplay paths and areas, the grid). */
  setGizmos(next: Partial<{ icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean; grid: boolean; probes: boolean }>): void {
    this.gizmos = { ...this.gizmos, ...next };
    this.entityOverlays.setGizmos({ icons: this.gizmos.icons, lights: this.gizmos.lights });
    this.helpers.setGizmos({ colliders: this.gizmos.colliders, gameplay: this.gizmos.gameplay });
    this.syncGround();
    this.stampGizmoCounts();
    this.requestRender();
  }

  /** The probe debug view follows the adapter's probe light (it comes with a bake and goes with it) while shown. */
  private followProbeDebug(adapter: SceneAdapter): void {
    const light = this.gizmos.probes ? (adapter.probeLighting?.() ?? null) : null;
    if (this.probeDebug !== null && this.probeDebug.light !== light) {
      this.probeDebug.view.dispose();
      this.probeDebug = null;
    }
    if (light !== null && this.probeDebug === null) {
      this.probeDebug = { light, view: createProbeDebugView(light) };
      this.overlay.add(this.probeDebug.view.object);
    }
    this.probeDebug?.view.update();
    // Probes drawn, and of those the ones inside geometry (moved or filled; tests read them).
    const shown = `${this.probeDebug?.view.count() ?? 0} ${this.probeDebug?.view.invalid() ?? 0}`;
    if (this.root.getAttribute('data-probe-spheres') !== shown) this.root.setAttribute('data-probe-spheres', shown);
  }

  /** The drawn helper counts on the view element (tests read them). */
  private stampGizmoCounts(): void {
    const c = this.helpers.blockHelpers();
    this.root.setAttribute('data-collider-outlines', String(c.colliders));
    this.root.setAttribute('data-collider-outlines-shown', c.collidersShown.join(' '));
    this.root.setAttribute('data-mover-paths', String(c.moverPaths.length));
    this.root.setAttribute('data-capsule-outlines', String(c.capsules));
    this.root.setAttribute('data-gizmos', (['icons', 'lights', 'colliders', 'gameplay', 'probes'] as const).filter((k) => this.gizmos[k]).join(' '));
    this.root.setAttribute('data-grid', String(this.gizmos.grid));
  }

  /** Set the selected entity (drives the gizmo, the selection outline and the selection's helper handles). */
  setSelected(id: string | null, mode: GizmoMode = this.gizmoMode): void {
    if (this.selectedId !== id) this.copySel = null;
    this.selectedId = id;
    this.gizmoMode = mode;
    this.entityOverlays.setSelected(id);
    this.outlineDirty = true;
    // A virtual camera's preview (where its rig puts it) shows while it is selected.
    this.showVirtualCameraPreview();
    // A selected copy of an instance set takes the gizmo.
    this.syncCopyProxy();
    // No gizmo on a folder (no transform) or a locked entity.
    const movable = id !== null && !this.folderIds.has(id) && this.hierarchyFlags.get(id)?.locked !== true && this.synced.has(id);
    const target = this.tools.router.anyArmed(id) || this.isolation.active ? null : this.copySel !== null && this.copyProxy.parent !== null ? this.copyProxy : id && movable ? this.gizmoProxy : null;
    if (id && target) {
      if (!this.draggingGizmo) this.placeGizmoFrame();
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      this.gizmo.setMode(mode);
      this.gizmoTargetId = id;
    } else {
      this.gizmo.detach();
      this.gizmoTargetId = null;
    }
    this.helpers.setSelected(id);
    this.stampGizmoCounts();
    this.render();
  }

  /** The gizmo's stand-in at the selection's local transform, in its parent's world frame. */
  private placeGizmoFrame(): void {
    const id = this.selectedId;
    if (id === null) return;
    const e = this.synced.get(id);
    const parent = e?.parentId !== null && e?.parentId !== undefined ? this.worldOf(e.parentId) : null;
    this.gizmoFrame.matrix.copy(parent ?? new THREE.Matrix4());
    this.gizmoFrame.matrixWorld.copy(this.gizmoFrame.matrix);
    const t = this.source.localOf(id);
    if (t !== null) {
      this.gizmoProxy.position.set(t.position[0] ?? 0, t.position[1] ?? 0, t.position[2] ?? 0);
      this.gizmoProxy.quaternion.set(t.rotation[0] ?? 0, t.rotation[1] ?? 0, t.rotation[2] ?? 0, t.rotation[3] ?? 1);
      this.gizmoProxy.scale.set(t.scale[0] ?? 1, t.scale[1] ?? 1, t.scale[2] ?? 1);
    }
    this.gizmoProxy.updateMatrixWorld(true);
  }

  /** An outline around the selection's drawn bounds (what the adapter draws for it: a box, a model, an instance set). */
  private updateSelectionOutline(): void {
    this.outlineDirty = false;
    this.selectionOutline?.removeFromParent();
    this.selectionOutline?.dispose();
    this.selectionOutline = null;
    const id = this.selectedId;
    const box = id === null || this.hierarchyFlags.get(id)?.active === false || this.isolation.active ? null : this.boundsOf([id], () => true);
    // Which entity wears the outline (tests read it).
    this.root.setAttribute('data-selection-outline', box === null || box.isEmpty() ? '' : id!);
    if (box === null || box.isEmpty()) return;
    this.selectionOutline = new THREE.Box3Helper(box, SELECTION_OUTLINE);
    this.selectionOutline.name = `selection:${id}`;
    this.selectionOutline.raycast = () => undefined;
    this.overlay.add(this.selectionOutline);
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.render();
  }

  /** The entity under a pointer position (client coords), or null. */
  pickAt(clientX: number, clientY: number): string | null {
    return this.pick(clientX, clientY);
  }

  /** Pick the entity under a pointer position (client coords in the canvas). */
  private pick(clientX: number, clientY: number): string | null {
    // The player's capsule outline selects the player (before
    // whatever model is drawn over it); inside the outline it does when
    // nothing else is hit.
    const capsule = this.helpers.capsuleAt(clientX, clientY);
    const capsuleId = capsule !== null && (this.hierarchyFlags.get(capsule.entityId) === undefined || (this.hierarchyFlags.get(capsule.entityId)!.active && !this.hierarchyFlags.get(capsule.entityId)!.locked)) ? capsule.entityId : null;
    if (capsuleId !== null && capsule!.onOutline) return capsuleId;
    const hit = this.pickMesh(clientX, clientY);
    return hit ?? capsuleId;
  }

  private pickMesh(clientX: number, clientY: number): string | null {
    for (const h of this.castScene(clientX, clientY)) {
      // The drawable's entity (its logical parents up to the entity's node in the adapter).
      const id = this.adapter.entityOf?.(h.object) ?? null;
      if (id === null || !this.synced.has(id)) continue;
      // Hidden or locked entities are not pickable (try the next hit).
      const f = this.hierarchyFlags.get(id);
      if (f === undefined || (f.active && !f.locked)) return id;
    }
    return null;
  }

  private bindEvents(): void {
    this.bindCanvasEvents();
    window.addEventListener('resize', this.onWindowResize);
  }

  private bindCanvasEvents(): void {
    // Capture phase: the handle grips route before the orbit/gizmo controls.
    this.root.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.root.addEventListener('pointermove', this.onPointerMove, { capture: true });
    this.root.addEventListener('pointerup', this.onPointerUp, { capture: true });
    this.root.addEventListener('contextmenu', this.onContextMenu);
    this.root.addEventListener('pointerleave', this.onPointerLeave);
    this.root.addEventListener('dblclick', this.onDoubleClick);
  }

  private unbindCanvasEvents(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.root.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    this.root.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    this.root.removeEventListener('pointerleave', this.onPointerLeave);
    this.root.removeEventListener('dblclick', this.onDoubleClick);
  }

  private onPointerLeave = (): void => this.tools.router.leave();

  private onContextMenu = (e: Event): void => e.preventDefault();

  /** A double-click on an object opens its edit mode (never while a tool owns the clicks or a mode is open). */
  private onDoubleClick = (e: MouseEvent): void => {
    if (e.button !== 0 || this.isolation.active || this.tools.router.anyArmed(this.selectedId)) return;
    const id = this.pick(e.clientX, e.clientY);
    if (id !== null) this.cb.onDoublePick?.(id);
  };
  private onWindowResize = (): void => this.resize();

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
    // A press a tool takes is never a click that picks (or deselects) what is under it.
    if (this.tools.router.pointerDown(e)) this.downAt = null;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.tools.router.pointerMove(e)) return;
    if (this.draggingGizmo) this.applySnapping();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const down = this.downAt;
    this.downAt = null;
    // A tool's gesture ends (its press never reached the orbit controls), or a tool acts on the click.
    if (this.tools.router.pointerUp(e)) return;
    // A left click (no drag, not on a gizmo handle) picks or deselects; in an edit mode its tools own the clicks.
    if (e.button !== 0 || down === null || this.draggingGizmo || this.gizmo.axis !== null || this.isolation.active) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    // With an instance set selected, a click on one of its copies selects that copy.
    const sel = this.selectedId;
    if (sel !== null && this.synced.get(sel)?.instances !== undefined) {
      const copy = this.pickCopy(e.clientX, e.clientY, sel);
      if (copy !== null) {
        this.cb.onCopyPick?.(sel, copy);
        return;
      }
    }
    this.cb.onPick(this.pick(e.clientX, e.clientY));
  };

  // ---- Descriptors, the game's aspect, instance copies, model outlines ----

  private gameAspect = DEFAULT_GAME_ASPECT;
  /** The project's lens (its camera settings; the engine defaults until the project's arrive). */
  private viewLens: { fovY: number; near: number; far: number } = { ...VIEW_LENS_DEFAULTS };
  private copySel: { entityId: string; index: number } | null = null;
  /** The copy gizmo's stand-in; its parent frame is the set's world matrix (copies are in its local frame). */
  private readonly copyFrame = frameObject();
  private readonly copyProxy = new THREE.Object3D();
  private copyHighlight: THREE.Box3Helper | null = null;

  /** The component descriptors: the handles and the objects' icons come from them. */
  setDescriptors(reg: DescriptorRegistry | null): void {
    this.helpers.setHandleSources(reg, (id) => this.frameOf(id));
    this.entityOverlays.setIconTable(iconTableOf(reg), this.projected);
    this.requestRender();
  }

  /** The project's physics dimension (handles of the other dimension are not shown). */
  setPhysicsDimension(dimension: 2 | 3): void {
    this.helpers.setPhysicsDimension(dimension);
    this.requestRender();
  }

  /** The project's lens (its camera settings): a virtual camera without its own uses it. */
  setViewLens(lens: { fovY: number; near: number; far: number }): void {
    if (this.viewLens.fovY === lens.fovY && this.viewLens.near === lens.near && this.viewLens.far === lens.far) return;
    this.viewLens = { ...lens };
    this.syncVirtualCameraPreviews(this.projected);
    this.requestRender();
  }

  /** The game view's aspect (width / height): the cameras' frustums use it. */
  setGameAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0 || Math.abs(aspect - this.gameAspect) < 1e-3) return;
    this.gameAspect = aspect;
    this.syncVirtualCameraPreviews(this.projected);
    this.requestRender();
  }

  /** The instance brush paints or erases copies of this set (null: off); the gizmo stands aside while it is on. */
  setInstanceBrush(entityId: string | null, store: BrushStore | null, brush: InstanceBrush): void {
    this.tools.setInstanceBrush(entityId, store, brush);
  }

  /** The decal editor's tool armed (null: off), its edits sent through `cb`. */
  setDecalTool(arm: DecalArm | null, cb: DecalToolCallbacks | null): void {
    this.tools.setDecalTool(arm, cb);
  }

  /** The vertex paint brush armed on an object, its strokes sent through `cb` (null: off; the gizmo stands aside while it is on). */
  setVertexPaintTool(arm: VertexPaintArm | null, cb: VertexPaintToolCallbacks | null): void {
    this.tools.setVertexPaintTool(arm, cb);
  }

  /** Every instance-brush stroke sent so far has been answered. */
  instanceStrokesSettled(): Promise<unknown> {
    return this.tools.brush.settled();
  }

  /** The drawn objects that collide (shown and switched on; instance sets and `exceptId` left out): what the brush paints on besides block layers. */
  private colliderObjects(exceptId: string): THREE.Object3D[] {
    this.adapter.sync?.();
    const out: THREE.Object3D[] = [];
    for (const e of this.projected) {
      if (e.collider === undefined || e.instances !== undefined || e.id === exceptId || this.hierarchyFlags.get(e.id)?.active === false) continue;
      const node = this.adapter.entityObject?.(e.id) ?? null;
      if (node !== null) out.push(node);
    }
    return out;
  }

  /** Select one copy of the selected instance set (null: the whole set). */
  setSelectedCopy(index: number | null): void {
    this.copySel = index === null || this.selectedId === null ? null : { entityId: this.selectedId, index };
    this.setSelected(this.selectedId);
  }

  getSelectedCopy(): { entityId: string; index: number } | null {
    return this.copySel;
  }

  private readCopyProxy(): CopyTransform {
    const p = this.copyProxy;
    return { position: [p.position.x, p.position.y, p.position.z], rotation: [p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w], scale: [clampScale(p.scale.x), clampScale(p.scale.y), clampScale(p.scale.z)] };
  }

  /** Preview one copy at a transform while it is dragged (the stored buffer is untouched). */
  private previewCopy(entityId: string, index: number, transform: readonly number[]): void {
    this.adapter.instanceSet?.(entityId)?.setCopy(index, transform);
    this.requestRender();
  }

  /** Put the gizmo's stand-in on the selected copy (from the stored buffer; `reset` also redraws the copy there). */
  private syncCopyProxy(reset = false): void {
    const sel = this.copySel;
    const e = sel === null ? undefined : this.synced.get(sel.entityId);
    if (sel !== null && (e?.instances === undefined || sel.index >= e.instances.count)) this.copySel = null;
    const now = this.copySel;
    const world = now === null ? null : this.worldOf(now.entityId);
    if (now === null || world === null) {
      this.copyProxy.removeFromParent();
      this.updateCopyHighlight();
      return;
    }
    // A buffer still loading keeps the stand-in where it is (the drag left it at the stored transform).
    const floats = e?.instances !== undefined ? this.instanceBuffer(e.instances.buffer) : undefined;
    const t = floats === undefined ? null : copyAt(floats, now.index);
    this.copyFrame.matrix.copy(world);
    this.copyFrame.matrixWorld.copy(world);
    if (this.copyProxy.parent !== this.copyFrame) this.copyFrame.add(this.copyProxy);
    if (t !== null) {
      this.copyProxy.position.set(...t.position);
      this.copyProxy.quaternion.set(...t.rotation);
      this.copyProxy.scale.set(...t.scale);
      if (reset) this.previewCopy(now.entityId, now.index, [...t.position, ...t.rotation, ...t.scale]);
    }
    this.copyProxy.updateMatrixWorld(true);
    this.updateCopyHighlight();
  }

  /** A box around the selected copy (and its index on the view element, for tests). */
  private updateCopyHighlight(): void {
    this.copyHighlight?.removeFromParent();
    this.copyHighlight?.dispose();
    this.copyHighlight = null;
    const sel = this.copySel;
    this.root.setAttribute('data-instance-copy', sel === null ? '' : String(sel.index));
    if (sel === null) return;
    // The set is drawn in chunks; it finds the copy's own bounds.
    const set = this.adapter.instanceSet?.(sel.entityId) ?? null;
    set?.group.updateWorldMatrix(true, true);
    const box = set?.copyBox(sel.index) ?? null;
    if (box === null) return;
    this.copyHighlight = new THREE.Box3Helper(box, 0xffe27a);
    this.copyHighlight.raycast = () => undefined;
    this.overlay.add(this.copyHighlight);
  }

  /** The copy of an instance set under the pointer, or null. */
  private pickCopy(clientX: number, clientY: number, entityId: string): number | null {
    const set = this.adapter.instanceSet?.(entityId) ?? null;
    const meshes = set?.meshes ?? [];
    if (set === null || meshes.length === 0) return null;
    const rect = this.root.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    this.adapter.sync?.();
    for (const h of this.raycaster.intersectObjects([...meshes], false)) {
      if (h.instanceId === undefined) continue;
      const copy = set.copyOf(h.object, h.instanceId);
      if (copy !== null) return copy;
    }
    return null;
  }

  /** Where the copies of an instance set are on screen (the middle of each drawn copy; tests click them). */
  copyClientPoints(entityId: string): { index: number; x: number; y: number }[] {
    const set = this.adapter.instanceSet?.(entityId) ?? null;
    if (set === null) return [];
    const rect = this.root.getBoundingClientRect();
    set.group.updateWorldMatrix(true, true);
    const out: { index: number; x: number; y: number }[] = [];
    const centre = new THREE.Vector3();
    for (let i = 0; i < Math.min(64, set.count); i++) {
      const box = set.copyBox(i);
      if (box === null) continue;
      const v = box.getCenter(centre).project(this.camera);
      out.push({ index: i, x: Math.round(rect.left + ((v.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - v.y) / 2) * rect.height) });
    }
    return out;
  }

  /** The gizmo's centre and a point on its X arrow, on screen (null: no gizmo). */
  private gizmoGrab(): { x: number; y: number; ax: number; ay: number } | null {
    const target = this.gizmo.object;
    if (target === undefined || this.gizmoTargetId === null) return null;
    const rect = this.root.getBoundingClientRect();
    const at = target.getWorldPosition(new THREE.Vector3());
    // TransformControls' own size: distance × min(1.9 tan(fov/2), 7) × size / 4; its arrows run about 0.5 of that.
    const factor = (at.distanceTo(this.camera.position) * Math.min(1.9 * Math.tan((Math.PI * this.camera.fov) / 360), 7) * 0.9) / 4;
    const toScreen = (v: THREE.Vector3): { x: number; y: number } => {
      const p = v.clone().project(this.camera);
      return { x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height) };
    };
    const c = toScreen(at);
    const a = toScreen(at.clone().add(new THREE.Vector3(0.3 * factor, 0, 0)));
    return { x: c.x, y: c.y, ax: a.x, ay: a.y };
  }

  /**
   * For "collider from model outline": the vertices of the models
   * drawn for an entity (its own and its children's), on the play plane
   * relative to its origin with its rotation about Z undone (the collider's
   * frame), or null when no model is loaded.
   */
  modelOutline(entityId: string): { x: number; y: number }[] | null {
    this.adapter.sync?.();
    const world = this.worldOf(entityId);
    if (world === null) return null;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    world.decompose(pos, quat, new THREE.Vector3());
    const angle = new THREE.Euler().setFromQuaternion(quat, 'ZYX').z;
    const toFrame = new THREE.Matrix4().makeRotationZ(angle).setPosition(pos).invert();
    const out: { x: number; y: number }[] = [];
    const v = new THREE.Vector3();
    for (const id of this.subtreeIds(entityId)) {
      if (this.synced.get(id)?.kind !== 'model') continue;
      for (const mesh of this.drawnMeshes(id)) {
        const attr = mesh.geometry.getAttribute('position');
        if (attr === undefined) continue;
        mesh.updateWorldMatrix(true, false);
        const m = new THREE.Matrix4().multiplyMatrices(toFrame, mesh.matrixWorld);
        // At most ~50k points per mesh (the hull only needs the extremes).
        const stride = Math.max(1, Math.ceil(attr.count / 50_000));
        for (let i = 0; i < attr.count; i += stride) {
          v.fromBufferAttribute(attr, i).applyMatrix4(m);
          out.push({ x: v.x, y: v.y });
        }
      }
    }
    return out.length === 0 ? null : out;
  }

  /** Frame every entity (the whole level) from the current view direction. */
  frameAll(entities: readonly ProjectedEntity[]): void {
    this.adapter.sync?.();
    const box = new THREE.Box3();
    const at = new THREE.Vector3();
    for (const e of entities) {
      if (e.kind !== 'box' && e.kind !== 'model') continue; // lights/cameras are markers, not content
      const m = this.worldOf(e.id);
      if (m !== null) box.expandByPoint(at.setFromMatrixPosition(m));
      if (e.kind === 'box') box.union(this.boundsOf([e.id], () => true));
    }
    if (box.isEmpty()) return;
    this.fitBox(box);
  }

  /** What covers the view's sides (an editor's open panels): frames fit and centre in the rest. */
  private frameInsets: (() => FrameInsets) | null = null;
  setFrameInsets(read: (() => FrameInsets) | null): void {
    this.frameInsets = read;
  }

  /** Whether the view shows `box` (world metres) sensibly: from outside and above it, looking down at it (`viewShowsBox`). */
  viewShows(box: { min: readonly number[]; max: readonly number[] }): boolean {
    return viewShowsBox({ min: box.min as [number, number, number], max: box.max as [number, number, number] }, this.camera.position.toArray(), this.orbit.target.toArray(), this.camera.fov, this.camera.aspect);
  }

  /** The camera outside `box`, looking at it whole in the part of the view the panels leave (`framePose`: the view's heading, a pitch looking down). */
  private fitBox(box: THREE.Box3): void {
    const pose = framePose({ min: box.min.toArray(), max: box.max.toArray() }, this.camera.position.toArray(), this.orbit.target.toArray(), this.camera.fov, this.camera.aspect, this.frameInsets?.() ?? NO_INSETS);
    this.orbit.target.set(...pose.target);
    this.camera.position.set(...pose.position);
    this.camera.far = Math.max(1000, pose.distance * 10);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.requestRender();
  }

  /**
   * Frame a box in world metres (an editor's selection: a room, a building,
   * decals, a stamp). `ground`: a terrain object whose ground under the box's
   * centre the box's heights are measured from.
   */
  frameBox(box: { min: readonly number[]; max: readonly number[] }, ground?: string): void {
    const b = new THREE.Box3(new THREE.Vector3(...(box.min as [number, number, number])), new THREE.Vector3(...(box.max as [number, number, number])));
    const c = b.getCenter(new THREE.Vector3());
    const y = ground === undefined ? undefined : this.adapter.terrains?.()?.field(ground)?.heightAt(c.x, c.z);
    if (typeof y === 'number' && Number.isFinite(y)) b.translate(new THREE.Vector3(0, y, 0));
    this.fitBox(b);
  }

  /** An object's box in world metres: `localBox` (its own frame) through its transform, else the meshes it draws (null: none). */
  worldBoxOf(id: string, localBox?: { min: readonly number[]; max: readonly number[] }): { min: number[]; max: number[] } | null {
    const world = this.worldOf(id);
    if (world === null) return null;
    const box = localBox !== undefined ? new THREE.Box3(new THREE.Vector3(...(localBox.min as [number, number, number])), new THREE.Vector3(...(localBox.max as [number, number, number]))).applyMatrix4(world) : this.boundsOf(this.subtreeIds(id), () => true);
    return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
  }

  /** Fit the camera to the current content (called on resync). */
  frameScene(): void {
    this.orbit.target.set(0, 0.5, 0);
    this.camera.position.set(6, 5, 6);
    this.orbit.update();
  }

  resize(): void {
    const w = Math.max(1, this.root.clientWidth || this.root.width);
    const h = Math.max(1, this.root.clientHeight || this.root.height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  dispose(): void {
    this.tools.dispose();
    this.effects.release();
    this.copyHighlight?.removeFromParent();
    this.copyHighlight?.dispose();
    this.copyHighlight = null;
    this.selectionOutline?.dispose();
    this.selectionOutline = null;
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.entityOverlays.dispose();
    this.helpers.dispose();
    this.unbindCanvasEvents();
    window.removeEventListener('resize', this.onWindowResize);
    this.gizmo.detach();
    this.gizmo.dispose();
    disposeOrbitControls(this.orbit);
    this.adapter.dispose();
  }
}
