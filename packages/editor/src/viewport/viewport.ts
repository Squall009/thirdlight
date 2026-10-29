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
 * The class is the view's surface and its frame; the areas are parts behind
 * small host interfaces: the look (`viewport-look.ts`), the block layers
 * (`viewport-blocks.ts`), the camera overlays (`camera-overlay.ts`), where
 * things are and picking (`scene-queries.ts`), framing (`view-framing.ts`),
 * the gizmo (`selection-gizmo.ts`) and instance copies
 * (`copy-selection.ts`), pointer input (`view-pointer.ts`) and the frame's
 * reports (`view-marks.ts`).
 *
 * Browser-only: uses the DOM (canvas, events) + WebGPU/WebGL via three.js.
 */

import {
  batchingFromUrl,
  mergingFromUrl,
  shadowCacheFromUrl,
  createSceneAdapter,
  DEFAULT_RENDERER_PREFERENCE,
  markHostDrawing,
  occlusionFromUrl,
  occlusionPyramidFromUrl,
  portalsFromUrl,
  pageSearch,
  type EffectComponentLike,
  type EffectDefLike,
  type EnvironmentLike,
  type LightingBakeLike,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
  type SceneAdapter,
  type SurfaceBakeOptions,
  type SurfaceBakeOutcome,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { BlockType, DecalComponent, InstanceBrush, InstanceStroke } from '@thirdlight/project-model';
import * as THREE from 'three';
import type { ArchitectureGraphLike, SeeThroughSettings, OcclusionCulling, ArchitecturePreview, EnvironmentBlendView } from '@thirdlight/runtime';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeOrbitControls, releaseControlKeyListeners } from './controls';
import type { ProjectedEntity } from '../session/projection';
import { effectiveFlagsOf, type EffectiveEntityFlags } from '../session/hierarchy';
import type { DescriptorRegistry, PlaneLock } from '@thirdlight/project-model';
import { gizmoPlaneAxis } from '../session/scene-planes';
import { HelperOverlay } from './helper-overlay';
import { SeeThroughPreview } from './see-through-preview';
import type { CopyTransform } from '../session/instance-copies';
import { iconTableOf } from './icons';
import { planSync, removedIds, helperRelevant } from './sync-plan';
import type { BlockEditor, BlockEditorCallbacks } from './block-editor';
import type { TerrainEditor, TerrainEditorCallbacks } from './terrain-editor';
import { decalSurfaceOf, DECAL_PREVIEW_ID, type DecalArm, type DecalToolCallbacks } from './decal-tool';
import type { VertexPaintArm, VertexPaintToolCallbacks } from './vertex-paint-tool';
import type { BrushStore } from '../session/brush';
import { ViewportTools } from './tool-input';
import { SceneVisibility } from './scene-visibility';
import { ViewIsolationState, type ViewIsolation } from './view-isolation';
import { SceneSource } from './scene-source';
import { EntityOverlays } from './entity-overlays';
import type { SceneViewAssets } from './scene-assets';
import { EffectPreview } from './effect-preview';
import { SceneViewOcclusion, type OcclusionViewState } from './occlusion-view';
import type { FrameInsets } from './frame-view';
import { ViewportLook } from './viewport-look';
import { ViewportBlocks, type BlockLayersInput } from './viewport-blocks';
import { CameraOverlay, type TimelinePreview } from './camera-overlay';
import { SceneQueries, type CellTopSnap } from './scene-queries';
import { ViewFraming } from './view-framing';
import { CopySelection } from './copy-selection';
import { SelectionGizmo, type GizmoMode } from './selection-gizmo';
import { ViewPointer } from './view-pointer';
import { ViewMarks } from './view-marks';
import { ViewGround } from './view-ground';
import { SelectionOutline } from './selection-outline';
import { SceneViewLighting } from './lighting-view';

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

export { WORK_VIEW_SKY } from './view-framing';
export type { ViewIsolation } from './view-isolation';
export type { GizmoMode, GizmoTransform } from './selection-gizmo';

/** The Scene view's background where the project draws no sky. */
const SCENE_BACKGROUND = 0x14161c;

/** Which helpers the Scene view draws (the Gizmos menu). */
type Gizmos = { icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean; grid: boolean };

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
  /** The See-through preview (the view's own, never saved). */
  private readonly seeThrough = new SeeThroughPreview();
  /** Occlusion culling in this view: the View menu's switches, and what is never culled. */
  private readonly occlusion = new SceneViewOcclusion(() => this.adapter, () => this.root, occlusionFromUrl(pageSearch()));
  /** What occlusion culling leaves alone: the selection's subtree and the edited objects (made again when one changes). */
  private occlusionKept: { selected: string | null; projected: readonly ProjectedEntity[]; edited: ReadonlySet<string> | null; ids: ReadonlySet<string> } | null = null;
  private readonly entityOverlays: EntityOverlays;
  private selectedId: string | null = null;
  /** An edit mode's isolation: what is drawn and what can be hit while a mode is open. */
  private readonly isolation = new ViewIsolationState({
    subtreeIds: (id) => this.queries.subtreeIds(id),
    withComponent: (c) => this.projected.filter((e) => e.components[c] !== undefined).map((e) => e.id),
    drawOnly: (ids) => this.adapter.setIsolation?.(ids),
    showGround: (on) => this.ground.show(on && this.gizmos.grid),
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
  private readonly ground: ViewGround;
  /** The helper overlay: collider outlines, component areas, the selection's handles. */
  private readonly helpers: HelperOverlay;
  /** The Scene view's tools; pointer input reaches them before the gizmo and picking. */
  private readonly tools: ViewportTools;
  /** Which helpers the Scene view draws (the Gizmos menu). */
  private gizmos: Gizmos = { icons: true, lights: true, colliders: false, gameplay: true, grid: true };
  /** The lighting's debug views, pass-time overlay and preview (the View menu, the Lighting window: view only, nothing is saved). */
  readonly sceneLighting = new SceneViewLighting(() => this.adapter, () => this.root, () => this.requestRender());
  private readonly orbit: OrbitControls;
  private readonly gizmo: SelectionGizmo;
  private readonly snapping: () => boolean;
  private renderQueued = false;
  /** Out of sight behind the Game view: no frames, no per-frame work. */
  private readonly visibility = new SceneVisibility(
    () => this.requestRender(),
    (suspended) => this.root.setAttribute('data-suspended', String(suspended)),
  );
  /** The entity object each entity was last synced from (the projection is copy-on-write). */
  private readonly synced = new Map<string, ProjectedEntity>();
  private readonly outline = new SelectionOutline(this.overlay);
  /** The project's instance-set chunk size (sets without their own use it). */
  private instanceChunk: number | undefined = undefined;
  /** Snaps moved and dropped objects to block-layer cell tops (null: off). */
  private cellTopSnap: CellTopSnap | null = null;
  /** The last synced entities. */
  private projected: readonly ProjectedEntity[] = [];
  private readonly marks = new ViewMarks();
  private readonly look: ViewportLook;
  private readonly blocks = new ViewportBlocks({ adapter: () => this.adapter, requestRender: () => this.requestRender() });
  private readonly queries: SceneQueries;
  /** Framing, focus and the view's pose. */
  readonly framing: ViewFraming;
  private readonly cameras: CameraOverlay;
  private readonly copies: CopySelection;
  private readonly pointer: ViewPointer;

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
    this.look = new ViewportLook({ adapter: () => this.adapter, source: this.source, projected: () => this.projected, requestRender: () => this.requestRender() });
    this.overlay.name = 'scene-view-overlays';
    // The view's own drawing (grid, gizmo, outlines, handles, brush cursors) is never an occludee.
    markHostDrawing(this.overlay);
    this.entityOverlays = new EntityOverlays({ adapter: () => this.adapter, requestRender: () => this.requestRender() });
    // Before the adapter: content it reports while it is made reaches the selected copy (none yet).
    this.copies = new CopySelection({
      adapter: () => this.adapter,
      root: () => this.root,
      camera: this.camera,
      overlay: this.overlay,
      synced: this.synced,
      queries: () => this.queries,
      selectedId: () => this.selectedId,
      requestRender: () => this.requestRender(),
    });
    this.adapter = this.makeAdapter(canvas);
    this.ground = new ViewGround(this.overlay);
    this.helpers = new HelperOverlay(this.overlay, this.camera, canvas);
    // A `{type: 'model'}` collider is outlined as its model's `_COL` parts once they are read.
    this.helpers.setModelSource((assetId) => this.assets.files.prepared(assetId), () => (this.stampGizmoCounts(), this.requestRender()));
    this.snapping = options.snapping ?? (() => false);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.queries = new SceneQueries({
      adapter: () => this.adapter,
      root: () => this.root,
      camera: this.camera,
      overlay: this.overlay,
      synced: this.synced,
      projected: () => this.projected,
      flags: () => this.hierarchyFlags,
      isolation: this.isolation,
      helpers: this.helpers,
      focus: () => this.orbit.target,
      snapping: () => this.snapping(),
      cellTopSnap: () => this.cellTopSnap,
    });
    this.framing = new ViewFraming({ adapter: () => this.adapter, camera: this.camera, orbit: this.orbit, queries: this.queries, requestRender: () => this.requestRender() });
    this.cameras = new CameraOverlay({
      overlay: this.overlay,
      root: () => this.root,
      source: this.source,
      synced: this.synced,
      projected: () => this.projected,
      selectedId: () => this.selectedId,
      dragged: (id) => this.gizmo.holds(id),
      requestRender: () => this.requestRender(),
    });
    this.tools = this.makeTools(canvas);
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.addEventListener('change', () => this.requestRender());

    this.gizmo = new SelectionGizmo(canvas, {
      camera: this.camera,
      orbit: this.orbit,
      root: () => this.root,
      source: this.source,
      synced: this.synced,
      queries: this.queries,
      copies: this.copies,
      mode: () => this.gizmoMode,
      snapping: () => this.snapping(),
      cellTopSnap: () => this.cellTopSnap,
      gestureBegin: (id) => this.cb.onGestureBegin(id),
      gestureFrame: (id, t) => this.cb.onGestureFrame(id, t),
      gestureEnd: (id, t) => void this.cb.onGestureEnd(id, t),
      copyTransform: (id, index, t) => this.cb.onCopyTransform?.(id, index, t),
      requestRender: () => this.requestRender(),
    });
    this.overlay.add(this.gizmo.helper());
    this.pointer = new ViewPointer({
      root: () => this.root,
      tools: this.tools,
      gizmo: () => this.gizmo,
      isolation: this.isolation,
      selectedId: () => this.selectedId,
      synced: this.synced,
      queries: this.queries,
      copies: this.copies,
      picked: (id) => this.cb.onPick(id),
      copyPicked: (id, index) => this.cb.onCopyPick?.(id, index),
      doublePicked: (id) => this.cb.onDoublePick?.(id),
      resize: () => this.resize(),
    });

    this.camera.position.set(6, 5, 6);
    this.orbit.update();
    this.pointer.bind();
    this.resize();
  }

  /** The Scene view's tools, wired to the view (pointer input reaches them before the gizmo and picking). */
  private makeTools(canvas: HTMLCanvasElement): ViewportTools {
    const q = this.queries;
    const flags = (id: string): EffectiveEntityFlags | undefined => this.hierarchyFlags.get(id);
    return new ViewportTools({
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
        colliders: (exceptId) => q.colliderObjects(exceptId),
        blockRoot: () => this.adapter.blockLayers?.().root ?? null,
        blockLayers: () => this.blocks.surfaces.layers(),
      },
      brushStroke: (entityId, stroke) => this.cb.onBrushStroke?.(entityId, stroke) ?? Promise.resolve(false),
      decal: {
        overlay: this.overlay,
        camera: this.camera,
        canvas: () => this.root,
        surfaceAt: (x, y) => decalSurfaceOf(q.castScene(x, y, true), q.raycaster.ray, (o) => this.adapter.entityOf?.(o) ?? null, (id, wx, wz) => this.adapter.terrains?.()?.field(id)?.sample(wx, wz)?.normal ?? null),
        surfaceOnRay: (o, d, far) => decalSurfaceOf(q.castRay(o, d, far), q.raycaster.ray, (x) => this.adapter.entityOf?.(x) ?? null, (id, wx, wz) => this.adapter.terrains?.()?.field(id)?.sample(wx, wz)?.normal ?? null),
        decals: () => this.projected.filter((e) => e.components['decal'] !== undefined && flags(e.id)?.active !== false && flags(e.id)?.locked !== true).map((e) => ({ id: e.id, trs: { position: e.position, rotation: e.rotation, scale: e.scale }, decal: e.components['decal'] as DecalComponent })),
        parentWorld: (id) => {
          const p = this.synced.get(id)?.parentId ?? null;
          return p === null ? null : q.worldOf(p);
        },
        setPreview: (e) => (this.source.setExtra(e), this.adapter.sync?.()),
        previewTransform: (id, t) => (this.source.setOverride(id, t), this.requestRender()),
        previewDecal: (id, decal) => void this.previewComponent(id, 'decal', decal),
        worldOf: (id) => q.worldOf(id),
        clippedMesh: (id) => this.clippedDecalMesh(id),
        snapping: () => this.snapping(),
        requestRender: () => this.requestRender(),
      },
      paint: {
        overlay: this.overlay,
        camera: this.camera,
        canvas: () => this.root,
        hits: (x, y) => q.castScene(x, y),
        ownerOf: (o) => this.adapter.paintOwnerOf?.(o) ?? null,
        entity: (id) => (flags(id)?.active === false || flags(id)?.locked === true ? null : (this.synced.get(id) ?? null)),
        copyOf: (id, h) => (h.instanceId === undefined ? null : (this.adapter.instanceSet?.(id)?.copyOf(h.object, h.instanceId) ?? null)),
        preview: (id, t) => this.adapter.paintPreview?.(id, t.kind === 'copy' ? { copy: t.copy } : t.kind === 'path' ? { path: t.path, side: t.side } : {}) ?? null,
        drawn: (id) => q.drawnMeshes(id).length > 0 || (this.adapter.pickables?.() ?? []).some((o) => this.adapter.paintOwnerOf?.(o) === id),
        channelView: (c) => (this.adapter.paintChannelView?.(c), this.requestRender()),
        requestRender: () => this.requestRender(),
      },
    });
  }

  // ---- The scene adapter -------------------------------------------------
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
      // The project's LOD tuning, AO kind, occlusion culling and architecture styles as last set.
      ...this.look.adapterOptions(),
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
    });
    adapter.threeScene?.().add(this.overlay);
    this.entityOverlays.attachAll(adapter);
    // The Decal tool's preview is cut from a scene that is already there: its empty result is final at once.
    adapter.clippedDecalWaits?.(DECAL_PREVIEW_ID, false);
    return adapter;
  }

  /** A model, instance set, cookie or texture arrived on its own: draw again (and what follows it). */
  private contentArrived(): void {
    this.assets.report();
    // An instance buffer arrived — the selected copy's stand-in and box follow it.
    if (this.copies.selection !== null && !this.gizmo.dragging) this.copies.sync();
    this.outline.dirty = true;
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
    this.look.setLodTuning(tuning);
  }

  /** The project's ambient occlusion kind changed: a look's AO is drawn with it. */
  setAmbientOcclusion(kind: 'off' | 'ssao' | 'gtao'): void {
    this.look.setAmbientOcclusion(kind);
  }

  /** The project's occlusion culling setting changed: the view culls as Play does. */
  setOcclusionCulling(mode: OcclusionCulling): void {
    this.look.setOcclusionCulling(mode);
  }

  /** The See-through preview on or off, with the project's see-through settings (view only: nothing is saved). */
  setSeeThroughPreview(on: boolean, settings: Readonly<SeeThroughSettings>): void {
    this.seeThrough.set(on, settings);
    if (this.seeThrough.apply(this.adapter, this.selectedId, this.projected)) this.requestRender();
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
    const ids = new Set<string>(this.selectedId !== null ? this.queries.subtreeIds(this.selectedId) : []);
    for (const id of edited ?? []) ids.add(id);
    this.occlusionKept = { selected: this.selectedId, projected: this.projected, edited, ids };
    return ids;
  }

  /** A loaded instance buffer (the copies' transforms), if here. */
  instanceBuffer(digest: string): Float32Array | undefined {
    return this.adapter.instanceBuffer?.(digest);
  }

  /**
   * The project's block layers (their component, stored chunks and origin)
   * and block types; `revision` changes whenever cells, layers or types do.
   * They are drawn by the adapter's block view (the same merged chunk meshes Play and exports draw).
   */
  setBlockLayers(types: readonly BlockType[], layers: BlockLayersInput, revision: number): void {
    this.blocks.set(types, layers, revision);
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
  setCellTopSnap(fn: CellTopSnap | null): void {
    this.cellTopSnap = fn;
  }

  // ---- Lighting, lightmaps, environment ----------------------------------
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
    this.look.setArchitectureStyles(graphs);
  }

  /** A preset's slider being dragged (null: the stored values again); how many objects are made again. */
  previewArchitecture(preview: ArchitecturePreview | null): number {
    return this.look.previewArchitecture(preview);
  }

  /** The project's bakes (sceneId → bake); null clears them. They show with game lighting. */
  setLightmaps(bakes: Readonly<Record<string, LightingBakeLike>> | null): void {
    this.look.setLightmaps(bakes);
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
   * "Bake lighting": this view's live lighting run to settled (each step a
   * frame drawn here, whether or not anything else asks for one) and read
   * back. Refused without WebGPU.
   */
  bakeLighting(o: Omit<SurfaceBakeOptions, 'frame'>): Promise<SurfaceBakeOutcome> {
    const adapter = this.adapter;
    if (adapter.bakeLighting === undefined) return Promise.resolve({ ok: false, message: 'this view cannot bake lighting' });
    const frame = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          if (this.adapter === adapter) this.frame();
          resolve();
        });
      });
    return adapter.bakeLighting({ ...o, frame }).finally(() => this.requestRender());
  }

  /**
   * The Scene view's lighting: "editor" is a fixed key + fill rig, "game" the
   * scene's own lights, look and lightmaps (what Play shows). Automatic until
   * chosen: game lighting as soon as the scene has a light.
   */
  setLighting(mode: 'editor' | 'game'): void {
    this.look.setLighting(mode);
  }
  getLighting(): 'editor' | 'game' {
    return this.look.mode;
  }

  /** The project environment (sky, fog, fog volumes, post) in the Scene view — with game lighting only. */
  setEnvironment(value: EnvironmentLike | null): void {
    this.look.setEnvironment(value);
  }

  /**
   * Show an environment preset blend (weights by preset id; '' = the base
   * look) in the Scene view with game lighting: the look, and the scene
   * lights the presets set — the runtime's own blend maths (what Play draws).
   * Null: back to the authored look. `tagBits`: the project's tag registry
   * (name → bit) for presets that name lights by tag.
   */
  previewEnvironmentBlend(view: { weights: readonly (readonly [string, number])[]; overrides?: EnvironmentBlendView['overrides'] } | null, tagBits?: ReadonlyMap<string, number>): void {
    this.look.previewEnvironmentBlend(view, tagBits);
  }

  // ---- Virtual cameras and the timeline preview ----------------------------
  /**
   * The timeline tab's scrub preview — the bound objects at the timeline's
   * time and the live camera's frustum there. Presentation only: nothing is
   * written to the project; null restores the authored transforms.
   */
  setTimelinePreview(preview: TimelinePreview | null): void {
    this.cameras.setTimeline(preview);
  }

  // ---- Where things are ----------------------------------------------------
  /** For "Fit to model": the bounding box of the models drawn for an entity, relative to its world position (null: none loaded). */
  modelBounds(entityId: string): { min: number[]; max: number[] } | null {
    return this.queries.modelBounds(entityId);
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

  /** Where something dropped at a pointer position lands (the first visible surface, the ground plane, the focus point). */
  dropPoint(clientX: number, clientY: number): [number, number, number] {
    return this.queries.dropPoint(clientX, clientY);
  }

  /** Orbit around the entity (framing it from outside when the view would be inside what it draws). */
  focus(id: string): void {
    this.framing.focus(id);
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

  /** The entities whose helpers are drawn: the shown ones, only the edited ones in an edit mode. */
  private helperEntities(): ProjectedEntity[] {
    return this.projected.filter((e) => this.hierarchyFlags.get(e.id)?.active !== false && this.isolation.shows(e.id));
  }

  /** A key for the Scene view's armed tools (only those named, when given); true when one took it. */
  toolKey(e: KeyboardEvent, names?: readonly string[]): boolean {
    return this.tools.router.key(e, this.selectedId, names);
  }

  /** Frame an object from the current view direction: `localBox` (its own frame; a terrain's tiles and height range) or else the meshes it draws. */
  frameEntity(id: string, localBox?: { min: readonly number[]; max: readonly number[] }): boolean {
    return this.framing.frameEntity(id, localBox);
  }

  /** A working view of part of an object (an edit mode entered; `view-framing.ts`). True once settled. */
  frameWorkArea(id: string, localBox: { min: readonly number[]; max: readonly number[] }, keepIf: { min: readonly number[]; max: readonly number[] } | null = null): boolean {
    return this.framing.frameWorkArea(id, localBox, keepIf);
  }

  // ---- Frames ------------------------------------------------------------
  /** Schedule one render on the next animation frame (coalesces bursts). */
  requestRender(): void {
    if (!this.visibility.allows()) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    this.marks.wanted(this.root, true);
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.visibility.allows()) this.frame();
      // Nothing asked for the next frame (no fade, no precompile, no animation): the picture stays as drawn.
      if (!this.renderQueued) this.marks.wanted(this.root, false);
    });
  }

  private frame(): void {
    const adapter = this.adapter;
    const root = this.root;
    // The world as the adapter will draw it: the gizmo's frame, the selection outline, the copy box follow it.
    adapter.sync?.();
    if (!this.gizmo.dragging) this.gizmo.placeFrame(this.selectedId);
    if (this.outline.dirty || this.gizmo.dragging) this.updateSelectionOutline();
    // Where the handle grips are on screen (tests drag them); grips keep their screen size.
    this.helpers.scaleGrips();
    root.setAttribute('data-size-handles', JSON.stringify(this.helpers.sizeHandleClientPoints()));
    this.tools.frame();
    // The selected instance set's copies and the gizmo's X arrow on screen (tests click and drag them).
    const setId = this.selectedId !== null && this.synced.get(this.selectedId)?.instances !== undefined ? this.selectedId : null;
    root.setAttribute('data-instance-copies', setId === null ? '[]' : JSON.stringify(this.copies.clientPoints(setId)));
    root.setAttribute('data-gizmo-grab', JSON.stringify(this.gizmo.grab()));
    this.marks.pose(root, this.camera);
    const renderer = adapter.currentRenderer?.() ?? null;
    // The effect preview steps before the frame and keeps the view drawing while it plays.
    const playing = this.effects.step(renderer);
    // Animated materials (wind, water) tick with the frame (the adapter ticks them) and keep the view drawing;
    // nothing else draws unless something asked for a frame (render on demand).
    const animated = this.assets.materialLibrary.animated();
    const terrain = adapter.terrainDiagnostics?.() ?? null;
    this.marks.viewProjection(root, this.camera);
    this.occlusion.keep(this.keptFromOcclusion());
    const drawn = adapter.renderFrame();
    // The renderer starting or a precompile running skips the frame: ask again until one is drawn.
    if (!drawn.ok || adapter.frameSkipped?.() === true) {
      if (drawn.ok || drawn.error.code === 'render_context_lost') this.requestRender();
      return;
    }
    // The block layers drawn (once the project's layers were handed over; tests read them).
    const blocks = adapter.blockLayers?.();
    if (blocks !== undefined && this.blocks.handedOver) root.setAttribute('data-block-layers', JSON.stringify(blocks.diagnostics()));
    // The terrains drawn (tests read the tiles drawn and the nodes selected).
    if (terrain !== null) root.setAttribute('data-terrain', JSON.stringify(adapter.terrainDiagnostics?.() ?? terrain));
    else root.removeAttribute('data-terrain');
    this.tools.afterFrame();
    this.occlusion.afterFrame();
    this.sceneLighting.afterFrame();
    this.seeThrough.stamp(root, adapter);
    this.marks.drawn(root);
    // An edit mode's isolation: drawables hidden and swept at this frame (tests and the perf check read it).
    if (this.isolation.active) {
      const d = adapter.isolationDiagnostics?.();
      if (d !== undefined) root.setAttribute('data-isolated-draws', `${d.hidden} ${d.swept}`);
    }
    this.marks.counts(root, adapter);
    this.marks.failures(adapter, this.cb.onModelFailures);
    // The live light settles over frames (a lamp switched, a bake's light restored): drawn again until it has.
    if (playing || animated || this.occlusion.animating || this.sceneLighting.animating || adapter.lightSettling?.() === true) this.requestRender();
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
    this.pointer.unbindCanvas();
    this.effects.rendererGone();
    this.overlay.removeFromParent();
    // The old canvas is never drawn to again: the adapter frees its renderer (and its WebGL context).
    this.adapter.dispose();
    old.replaceWith(next);
    this.root = next;
    this.pointer.bindCanvas();
    this.orbit.disconnect();
    // The old canvas already left the page: its document keeps OrbitControls' key listeners otherwise.
    releaseControlKeyListeners(this.orbit);
    this.orbit.connect(next);
    this.gizmo.reconnect(next);
    this.helpers.setCanvas(next);
    this.rendererInfoNow = { requested: preference, source, backend: null, api: null, state: 'initialising', reason: 'choosing a backend', recoveries: 0 };
    this.adapter = this.makeAdapter(next);
    this.occlusion.apply();
    this.sceneLighting.apply();
    this.isolation.apply();
    this.seeThrough.apply(this.adapter, this.selectedId, this.projected, true);
    this.look.adapterReplaced();
    this.blocks.adapterReplaced();
    this.resize();
    this.cb.onRendererChange?.(this.rendererInfoNow);
  }

  /** Cancel an in-flight gizmo gesture (Esc): revert, send nothing. */
  cancelGesture(): boolean {
    // A tool's stroke or drag in flight is dropped (nothing is sent).
    if (this.tools.router.cancel()) return true;
    if (!this.gizmo.cancel()) return false;
    this.requestRender();
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
    const settling = this.gizmo.settling;
    for (const id of [...settling]) {
      if (!full && !changed.some((e) => e.id === id)) continue;
      settling.delete(id);
      if (!this.gizmo.holds(id) && !this.cameras.previews(id)) this.source.setOverride(id, null);
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
    this.look.applyLightingMode();
    this.cameras.syncCameras(entities);
    // The preview's subject follows a camera target or a selection that changed.
    this.seeThrough.apply(this.adapter, this.selectedId, entities);
    // A timeline scrub preview stays on top of the synced transforms.
    if (this.cameras.scrubbing) this.cameras.applyTimeline();
    // The helper overlay syncs from the SAME projection pass
    // (an inactive entity's helpers are hidden like the entity).
    // The selected entity's handles come from any of its sized components: its change re-syncs the overlay too.
    const shown = this.helperEntities();
    this.adapter.sync?.();
    if (helpers || structural || selectionTouched) this.helpers.sync(shown);
    else this.helpers.setEntities(shown);
    this.stampGizmoCounts();
    this.outline.dirty = true;
    // A selection that became locked or a folder loses its gizmo.
    if (this.selectedId !== null && !this.gizmo.dragging && (selectionTouched || structural)) this.setSelected(this.selectedId);
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    this.root.setAttribute('data-sync', JSON.stringify({ entities: entities.length, processed: changed.length, removed: removed.size, full, ms }));
    this.requestRender();
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
  setGizmos(next: Partial<Gizmos>): void {
    this.gizmos = { ...this.gizmos, ...next };
    this.entityOverlays.setGizmos({ icons: this.gizmos.icons, lights: this.gizmos.lights });
    this.helpers.setGizmos({ colliders: this.gizmos.colliders, gameplay: this.gizmos.gameplay });
    // The grid and its ground square, unless an edit mode hides the rest of the scene (`view-isolation.ts`).
    this.ground.show(this.gizmos.grid && !this.isolation.hidesRest);
    this.stampGizmoCounts();
    this.requestRender();
  }

  /** The drawn helper counts on the view element (tests read them). */
  private stampGizmoCounts(): void {
    const c = this.helpers.blockHelpers();
    this.root.setAttribute('data-collider-outlines', String(c.colliders));
    this.root.setAttribute('data-collider-outlines-shown', c.collidersShown.join(' '));
    this.root.setAttribute('data-mover-paths', String(c.moverPaths.length));
    this.root.setAttribute('data-capsule-outlines', String(c.capsules));
    this.root.setAttribute('data-gizmos', (['icons', 'lights', 'colliders', 'gameplay'] as const).filter((k) => this.gizmos[k]).join(' '));
    this.root.setAttribute('data-grid', String(this.gizmos.grid));
  }

  /** Set the selected entity (drives the gizmo, the selection outline and the selection's helper handles). */
  setSelected(id: string | null, mode: GizmoMode = this.gizmoMode): void {
    if (this.selectedId !== id) this.copies.clear();
    this.selectedId = id;
    this.gizmoMode = mode;
    this.entityOverlays.setSelected(id);
    this.outline.dirty = true;
    // A virtual camera's preview (where its rig puts it) shows while it is selected.
    this.cameras.showSelected();
    // A selected copy of an instance set takes the gizmo.
    this.copies.sync();
    // No gizmo on a folder (no transform) or a locked entity.
    const movable = id !== null && !this.folderIds.has(id) && this.hierarchyFlags.get(id)?.locked !== true && this.synced.has(id);
    const take = this.tools.router.anyArmed(id) || this.isolation.active ? null : { copy: this.copies.selection !== null && this.copies.placed, entity: movable };
    // A body on a plane (its own, or its scene's default) is moved in the plane and turned about its normal only.
    this.gizmo.aim(id, take, mode, gizmoPlaneAxis(id === null ? undefined : this.synced.get(id), this.helpers.planes));
    this.helpers.setSelected(id);
    this.seeThrough.apply(this.adapter, id, this.projected);
    this.stampGizmoCounts();
    this.requestRender();
  }

  /** An outline around the selection's drawn bounds (what the adapter draws for it: a box, a model, an instance set). */
  private updateSelectionOutline(): void {
    const id = this.selectedId;
    const box = id === null || this.hierarchyFlags.get(id)?.active === false || this.isolation.active ? null : this.queries.boundsOf([id], () => true);
    this.outline.update(this.root, id, box);
  }

  /** The entity under a pointer position (client coords), or null. */
  pickAt(clientX: number, clientY: number): string | null {
    return this.queries.pick(clientX, clientY);
  }

  // ---- Descriptors, the game's aspect, instance copies, model outlines ----

  /** The component descriptors: the handles and the objects' icons come from them. */
  setDescriptors(reg: DescriptorRegistry | null): void {
    this.helpers.setHandleSources(reg, (id) => this.queries.frameOf(id));
    this.entityOverlays.setIconTable(iconTableOf(reg), this.projected);
    this.requestRender();
  }

  /** Each scene's default plane: the colliders' outlines and the gizmo's plane lock follow them. */
  setScenePlanes(planes: ReadonlyMap<string, PlaneLock>): void {
    this.helpers.setScenePlanes(planes);
    this.setSelected(this.selectedId);
  }

  /** The project's lens (its camera settings): a virtual camera without its own uses it. */
  setViewLens(lens: { fovY: number; near: number; far: number }): void {
    if (this.cameras.setViewLens(lens)) this.requestRender();
  }

  /** The game view's aspect (width / height): the cameras' frustums use it. */
  setGameAspect(aspect: number): void {
    if (this.cameras.setGameAspect(aspect)) this.requestRender();
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

  /** Select one copy of the selected instance set (null: the whole set). */
  setSelectedCopy(index: number | null): void {
    this.copies.select(index);
    this.setSelected(this.selectedId);
  }

  getSelectedCopy(): { entityId: string; index: number } | null {
    return this.copies.selection;
  }

  /** For "collider from model outline": the models' vertices on the play plane in the collider's frame (null: none loaded). */
  modelOutline(entityId: string): { x: number; y: number }[] | null {
    return this.queries.modelOutline(entityId);
  }

  /** Frame every entity (the whole level) from the current view direction. */
  frameAll(entities: readonly ProjectedEntity[]): void {
    this.framing.frameAll(entities);
  }

  /** What covers the view's sides (an editor's open panels): frames fit and centre in the rest. */
  setFrameInsets(read: (() => FrameInsets) | null): void {
    this.framing.setInsets(read);
  }

  /** Whether the view shows `box` (world metres) sensibly: from outside and above it, looking down at it. */
  viewShows(box: { min: readonly number[]; max: readonly number[] }): boolean {
    return this.framing.viewShows(box);
  }

  /** Frame a box in world metres (`ground`: a terrain the box's heights are measured from). */
  frameBox(box: { min: readonly number[]; max: readonly number[] }, ground?: string): void {
    this.framing.frameBox(box, ground);
  }

  /** An object's box in world metres: `localBox` (its own frame) through its transform, else the meshes it draws (null: none). */
  worldBoxOf(id: string, localBox?: { min: readonly number[]; max: readonly number[] }): { min: number[]; max: number[] } | null {
    return this.framing.worldBoxOf(id, localBox);
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
    this.copies.dispose();
    this.outline.dispose();
    this.ground.dispose();
    this.entityOverlays.dispose();
    this.helpers.dispose();
    this.pointer.unbind();
    this.gizmo.dispose();
    disposeOrbitControls(this.orbit);
    this.sceneLighting.dispose();
    this.adapter.dispose();
  }
}
