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
  createEffectsPlayer,
  createSceneAdapter,
  DEFAULT_RENDERER_PREFERENCE,
  pageSearch,
  rendererMemory,
  type EffectComponentLike,
  type EffectDefLike,
  type EffectsPlayer,
  type EnvironmentLike,
  type LightingBakeLike,
  type MaterialLibrary,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
  type SceneAdapter,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { BlockChunk, BlockLayerComponent, BlockType, InstanceBrush, InstanceStroke } from '@thirdlight/project-model';
import * as THREE from 'three';
import { VIEW_LENS_DEFAULTS, type EnvironmentBlendView } from '@thirdlight/runtime';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeOrbitControls, releaseControlKeyListeners } from './controls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { ProjectedEntity } from '../session/projection';
import { effectiveFlagsOf, type EffectiveEntityFlags } from '../session/hierarchy';
import { clampScale, getSnapSettings } from '../session/snapping';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { HelperOverlay } from './helper-overlay';
import { commitValue, type HandleShape } from '../session/handles';
import { copyAt, type CopyTransform } from '../session/instance-copies';
import { BrushBlockSurfaces, InstanceBrushTool, type InstanceBrushMode } from './instance-brush';
import { iconTableOf } from './icons';
import { planSync, removedIds, helperRelevant } from './sync-plan';
import { BlockEditor, type BlockEditorCallbacks } from './block-editor';
import { virtualCameraPreviews } from './camera-previews';
import { gatherBakeInputs, type BakeInputs } from './bake-inputs';
import { SceneVisibility } from './scene-visibility';
import { SceneSource } from './scene-source';
import { EntityOverlays, OVERLAY_KEY } from './entity-overlays';
import type { SceneViewAssets } from './scene-assets';

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
}

const GROUND_SIZE = 20;
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

/** A pointer that moved less than this (px) between down and up is a click. */
const CLICK_SLOP_PX = 4;

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
  private readonly entityOverlays: EntityOverlays;
  private selectedId: string | null = null;
  /** Effective flags from the last sync (inactive = hidden, locked = not pickable/movable). */
  private hierarchyFlags: ReadonlyMap<string, EffectiveEntityFlags> = new Map();
  private folderIds = new Set<string>();
  private gizmoMode: GizmoMode = 'translate';
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  /** The helper overlay: collider outlines, component areas, the selection's handles. */
  private readonly helpers: HelperOverlay;
  /** Which helpers the Scene view draws (the Gizmos menu). */
  private gizmos = { icons: true, lights: true, colliders: false, gameplay: true, grid: true };
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
  /** Armed block tools own the left button: the selection (the layer they edit) gets no gizmo meanwhile. */
  private blockToolsArmed = false;
  /** The instance brush and the block layers it paints on. */
  private readonly brushSurfaces = new BrushBlockSurfaces();
  private readonly instanceBrush: InstanceBrushTool;
  /** The left button went down on a brush stroke (its release ends it, even one the brush gave up). */
  private brushPressed = false;
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
    this.entityOverlays = new EntityOverlays({ adapter: () => this.adapter, aspect: () => this.camera.aspect, requestRender: () => this.requestRender() });
    this.adapter = this.makeAdapter(canvas);
    this.raycaster.layers.enable(BATCHED_LAYER);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new THREE.MeshLambertMaterial({ color: 0x1c1f27, side: THREE.DoubleSide }));
    this.ground.rotation.x = -Math.PI / 2;
    this.overlay.add(this.ground);
    this.grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE, 0x333844, 0x23262f);
    this.overlay.add(this.grid);
    this.instanceBrush = new InstanceBrushTool(
      {
        scene: this.overlay,
        camera: this.camera,
        canvas: canvas,
        requestRender: () => this.requestRender(),
        colliders: (exceptId) => this.colliderObjects(exceptId),
        blockRoot: () => this.adapter.blockLayers?.().root ?? null,
        blockLayers: () => this.brushSurfaces.layers(),
        refused: (message) => this.cb.onHandleRefused?.(message),
      },
      (entityId, stroke) => this.cb.onBrushStroke?.(entityId, stroke) ?? Promise.resolve(false),
    );

    this.helpers = new HelperOverlay(this.overlay, this.camera, canvas);
    // A `{type: 'model'}` collider is outlined as its model's `_COL` parts once they are read.
    this.helpers.setModelSource((assetId) => this.assets.files.prepared(assetId), () => (this.stampGizmoCounts(), this.requestRender()));

    this.snapping = options.snapping ?? (() => false);

    this.orbit = new OrbitControls(this.camera, canvas);
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

  // ---- The scene adapter -------------------------------------------------
  /** The project environment, the bakes and the lighting mode as last set (a new adapter takes them). */
  private environmentValue: EnvironmentLike | null = null;
  private environmentSet = false;
  private bakes: Readonly<Record<string, LightingBakeLike>> | null = null;
  private lighting: { mode: 'editor' | 'game'; chosen: boolean } = { mode: 'editor', chosen: false };
  private envPreview: EnvironmentBlendView | null = null;
  private envPreviewTags: ReadonlyMap<string, number> | undefined;

  private makeAdapter(canvas: HTMLCanvasElement): SceneAdapter {
    const assets = this.assets;
    const adapter = createSceneAdapter(canvas, {
      runtime: this.source,
      // The authored scene comes in through the source's scene set; a v4 snapshot with scenes lets rows arrive as they are read.
      snapshot: { scene: { schemaVersion: 4, entities: [] }, scenes: [] } as never,
      resources: assets.resources,
      background: SCENE_BACKGROUND,
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
      models: assets.models,
      // Draco/Basis decoder files are served next to the editor page (dist/editor/decoders/).
      modelsLoader: createGltfLoaderPort({ decoderBase: './decoders/' }),
      materials: { library: assets.materialLibrary, defs: [], wind: null, loadTexture: assets.loadTexture },
      environment: { value: {}, loadTexture: assets.loadTexture },
      lights: { loadTexture: assets.loadTexture },
      lighting: { bakes: {}, loadTexture: assets.loadTexture },
    });
    adapter.threeScene?.().add(this.overlay);
    this.entityOverlays.attachAll(adapter);
    return adapter;
  }

  /** The adapter's world, environment, bakes and block layers follow the current state (a new adapter, a lighting mode). */
  private applyLook(): void {
    const game = this.lighting.mode === 'game';
    // The editor rig still draws at the project's quality level (low: no MSAA).
    const quality = this.environmentValue?.quality;
    this.adapter.setEnvironment?.(game ? this.environmentValue : quality !== undefined ? { quality } : null);
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
  setBlockLayers(types: readonly BlockType[], layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; hidden?: boolean }>, revision: number): void {
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
        const key = JSON.stringify(l.component);
        const prev = this.blockApplied.get(id);
        if (prev === undefined || prev.component !== key || !view.hasLayer(id)) view.setLayer(id, l.component, l.origin, { entityId: id, chunks: [...l.chunks.values()] });
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

  // ---- Block-layer editing ---------------------------------------------
  private blockEditorInst: BlockEditor | null = null;
  private orbitButtons: OrbitControls['mouseButtons'] | null = null;

  /** The block-layer editing tools (created on first use with the App's callbacks). */
  blockEditor(cb?: BlockEditorCallbacks): BlockEditor | null {
    if (this.blockEditorInst === null && cb !== undefined) {
      this.blockEditorInst = new BlockEditor(
        {
          scene: this.overlay,
          camera: this.camera,
          canvas: this.root,
          requestRender: () => this.requestRender(),
          view: () => this.adapter.blockLayers!(),
          armed: (on) => {
            this.blockToolsArmed = on;
            this.setSelected(this.selectedId);
          },
        },
        cb,
      );
    }
    return this.blockEditorInst;
  }

  /** Arm the block tools: a left drag paints (Alt+drag or the right button orbits), clicks pick no objects. */
  setBlockToolsActive(on: boolean): void {
    const ed = this.blockEditorInst;
    if (ed === null) return;
    ed.setActive(on);
    if (on && this.orbitButtons === null) {
      this.orbitButtons = { ...this.orbit.mouseButtons };
      this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    } else if (!on && this.orbitButtons !== null) {
      this.orbit.mouseButtons = this.orbitButtons;
      this.orbitButtons = null;
    }
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

  /** Every mesh an entity draws itself (not its overlays, not its children's), with current world matrices. */
  private drawnMeshes(id: string): THREE.Mesh[] {
    const node = this.adapter.entityObject?.(id) ?? null;
    if (node === null) return [];
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if (o.userData[OVERLAY_KEY] === true) return;
      if ((o as THREE.Mesh).isMesh === true) out.push(o as THREE.Mesh);
      for (const c of o.children) visit(c);
    };
    visit(node);
    return out;
  }

  private boundsOf(ids: readonly string[], include: (e: ProjectedEntity | undefined) => boolean): THREE.Box3 {
    const box = new THREE.Box3();
    const one = new THREE.Box3();
    for (const id of ids) {
      if (!include(this.synced.get(id))) continue;
      for (const mesh of this.drawnMeshes(id)) {
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

  /** Where the camera is looking (new entities spawn here). */
  focusPoint(): [number, number, number] {
    const t = this.orbit.target;
    return [t.x, t.y, t.z];
  }

  /** What a ray from the view hits among the drawn objects and the entities' overlays (nearest first). */
  private castScene(clientX: number, clientY: number): THREE.Intersection[] {
    const rect = this.root.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.adapter.sync?.();
    const scene = this.adapter.threeScene?.();
    if (scene === undefined) return [];
    // The drawables (those drawn through batches too; the batches' own meshes stand for objects picked themselves) — not the view's overlay group.
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

  /** Orbit around the entity's world position, keeping the view direction. */
  focus(id: string): void {
    this.adapter.sync?.();
    const m = this.worldOf(id);
    if (m === null) return;
    const world = new THREE.Vector3().setFromMatrixPosition(m);
    const offset = this.camera.position.clone().sub(this.orbit.target);
    this.orbit.target.copy(world);
    this.camera.position.copy(world).add(offset);
    this.orbit.update();
  }

  private render(): void {
    this.requestRender();
  }

  // ---- The edit-mode effect preview ------------------------------------
  private effectsPlayer: EffectsPlayer | null = null;
  private effectTarget: { id: string; component: EffectComponentLike } | null = null;
  private effectAttached: { id: string; obj: THREE.Object3D; key: string } | null = null;
  private effectRenderer: unknown = null;
  private effectLastNow: number | null = null;
  /** The material holders the preview asked the library for (released with the preview). */
  private effectHolders: { holders: Map<string, { mesh: THREE.Mesh; undo: () => void }>; placeholder: THREE.Material } | null = null;

  /** Release the edit-mode effect preview (player, library holders, placeholder). */
  private releaseEffectPreview(): void {
    this.effectsPlayer?.dispose();
    this.effectsPlayer = null;
    this.effectAttached = null;
    this.effectRenderer = null;
    this.effectTarget = null;
    const h = this.effectHolders;
    this.effectHolders = null;
    if (h !== null) {
      for (const { mesh, undo } of h.holders.values()) {
        undo();
        mesh.geometry.dispose();
      }
      h.holders.clear();
      h.placeholder.dispose();
    }
  }

  /**
   * Play the selected object's effect in the Scene view (the Gizmos menu's
   * toggle): the same player Play uses, on this view's renderer (WebGPU
   * compute or the CPU executor). A finished one-shot starts again. Off (or
   * no effect on the selection): nothing plays.
   */
  setEffectPreview(on: boolean, defs: readonly EffectDefLike[], target: { id: string; component: EffectComponentLike } | null, loadTexture: ((assetId: string) => Promise<THREE.Texture | null>) | null): void {
    if (!on) {
      this.releaseEffectPreview();
      this.root.setAttribute('data-effects', JSON.stringify({ preview: false }));
      this.requestRender();
      return;
    }
    if (this.effectsPlayer === null) {
      const lib = (): MaterialLibrary => this.assets.materialLibrary;
      const holders = new Map<string, { mesh: THREE.Mesh; undo: () => void }>();
      const placeholder = new THREE.MeshBasicMaterial();
      this.effectHolders = { holders, placeholder };
      this.effectsPlayer = createEffectsPlayer({
        // The particles are the view's own overlay (the game's effects play in Play).
        scene: this.overlay as never,
        defs,
        loadTexture: loadTexture ?? (async () => null),
        replayFinished: true,
        projectMaterial: (id) => {
          if (id === '') return null;
          let h = holders.get(id);
          if (h === undefined) {
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), placeholder);
            h = { mesh, undo: lib().apply(mesh, { '*': id }) };
            holders.set(id, h);
          }
          return h.mesh.material === placeholder ? null : (h.mesh.material as never);
        },
      });
    } else this.effectsPlayer.setDefs(defs);
    this.effectTarget = target;
    this.requestRender();
  }

  /** Attach the preview to the selected object (again when its node or component changed). */
  private syncEffectTarget(): void {
    const p = this.effectsPlayer;
    if (p === null) return;
    const t = this.effectTarget;
    const obj = t !== null ? (this.adapter.entityObject?.(t.id, true) ?? null) : null;
    const key = t !== null ? JSON.stringify(t.component) : '';
    const a = this.effectAttached;
    if (a !== null && (t === null || a.id !== t.id || a.obj !== obj || a.key !== key)) {
      p.detach(a.id);
      this.effectAttached = null;
    }
    if (t !== null && obj !== null && this.effectAttached === null) {
      // The preview plays whatever the component's start setting (a signal or script would start it in the game).
      p.attach(t.id, obj, { ...t.component, playOnStart: true }, true);
      this.effectAttached = { id: t.id, obj, key };
    }
  }

  /** One preview step before a frame is drawn; true while something plays (the view keeps drawing). */
  private stepEffects(renderer: unknown): boolean {
    const p = this.effectsPlayer;
    if (p === null || renderer === null) return false;
    if (this.effectRenderer !== renderer) {
      p.setRenderer(renderer as never, this.rendererInfoNow.api === 'webgpu' ? 'webgpu' : 'webgl2');
      this.effectRenderer = renderer;
      this.effectAttached = null;
    }
    this.syncEffectTarget();
    const now = performance.now();
    const dt = this.effectLastNow === null ? 0 : Math.max(0, (now - this.effectLastNow) / 1000);
    this.effectLastNow = now;
    p.update(dt, this.camera as never);
    const d = p.diagnostics();
    this.root.setAttribute('data-effects', JSON.stringify({ preview: true, executor: d.executor, playing: d.playing, particles: d.particles }));
    return p.active;
  }

  /** The Game view is in front (the view draws nothing meanwhile). */
  setHidden(on: boolean): void {
    this.visibility.setHidden(on);
  }

  /** The canvas is lent to a preview pane (seen whatever the centre view shows). */
  setLent(on: boolean): void {
    this.visibility.setLent(on);
  }

  // ---- Frames ------------------------------------------------------------
  /** The selection outline follows the selection's drawn bounds (moved, loaded, changed). */
  private outlineDirty = true;
  /** The model failures last reported (a change is reported again). */
  private failuresMark = '';
  /** The view's pose last stamped on the canvas. */
  private poseMark = '';

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
    const playing = this.stepEffects(renderer);
    // Animated materials (wind, water) tick with the frame (the adapter ticks them) and keep the view drawing;
    // nothing else draws unless something asked for a frame (render on demand).
    const animated = this.assets.materialLibrary.animated();
    // While the block tools are on, the view-projection matrix (tests map cells to the screen).
    if (this.blockEditorInst?.isActive() === true || this.instanceBrush.active(this.selectedId)) {
      this.camera.updateMatrixWorld();
      const vp = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      this.root.setAttribute('data-view-proj', JSON.stringify(vp.elements.map((v) => Math.round(v * 1e6) / 1e6)));
    }
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
    const f = adapter.lastFrame?.();
    this.root.setAttribute('data-frames', String(this.framesDrawn));
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
    if (playing || animated) this.requestRender();
    if (!playing) this.effectLastNow = null;
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
    this.releaseEffectRenderer();
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
    this.lookApplied = null;
    this.applyLightingMode();
    if (this.environmentSet) this.setEnvironment(this.environmentValue);
    this.blockRevision = -1;
    this.blockApplied.clear();
    if (this.blockInput !== null) this.setBlockLayers(this.blockInput.types, this.blockInput.layers, this.blockInput.revision);
    this.resize();
    this.cb.onRendererChange?.(this.rendererInfoNow);
  }

  /** The effect preview's executor is rebuilt on the next renderer. */
  private releaseEffectRenderer(): void {
    this.effectRenderer = null;
    this.effectAttached = null;
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
    // A block stroke in flight is dropped (nothing is sent).
    if (this.blockEditorInst?.cancel() === true) {
      this.orbit.enabled = true;
      return true;
    }
    // A handle drag or a brush stroke cancels with nothing stored.
    if (this.handleDragging) {
      this.handleDragging = false;
      this.orbit.enabled = true;
      this.helpers.cancelHandleDrag();
      this.render();
      return true;
    }
    if (this.instanceBrush.cancel()) {
      this.orbit.enabled = true;
      return true;
    }
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
    // Automatic lighting follows whether the scene has a light.
    this.applyLightingMode();
    this.syncVirtualCameraPreviews(entities);
    // A timeline scrub preview stays on top of the synced transforms.
    if (this.timelinePreview !== null) this.applyTimelinePreview();
    // The helper overlay syncs from the SAME projection pass
    // (an inactive entity's helpers are hidden like the entity).
    // The selected entity's handles come from any of its sized components: its change re-syncs the overlay too.
    const shown = entities.filter((e) => this.hierarchyFlags.get(e.id)?.active !== false);
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
  setGizmos(next: Partial<{ icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean; grid: boolean }>): void {
    this.gizmos = { ...this.gizmos, ...next };
    this.entityOverlays.setGizmos({ icons: this.gizmos.icons, lights: this.gizmos.lights });
    this.helpers.setGizmos({ colliders: this.gizmos.colliders, gameplay: this.gizmos.gameplay });
    this.grid.visible = this.gizmos.grid;
    this.ground.visible = this.gizmos.grid;
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
    const target = this.blockToolsArmed || this.instanceBrush.active(id) ? null : this.copySel !== null && this.copyProxy.parent !== null ? this.copyProxy : id && movable ? this.gizmoProxy : null;
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
    const box = id === null || this.hierarchyFlags.get(id)?.active === false ? null : this.boundsOf([id], () => true);
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
  }

  private unbindCanvasEvents(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.root.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    this.root.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    this.root.removeEventListener('pointerleave', this.onPointerLeave);
  }

  private onPointerLeave = (): void => this.instanceBrush.leave();

  private onContextMenu = (e: Event): void => e.preventDefault();
  private onWindowResize = (): void => this.resize();

  /** A handle drag is in flight (the overlay holds the previewed shape). */
  private handleDragging = false;

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
    // Armed block tools take the left button (the gizmo stands aside while they are armed).
    if (this.blockEditorInst?.isActive() === true && this.blockEditorInst.pointerDown(e)) {
      e.stopImmediatePropagation();
      this.downAt = null;
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      return;
    }
    // A handle grip of the selected entity: Alt+click deletes a corner/point, a drag edits (one command on release).
    const grip = this.helpers.pickHandle(e.clientX, e.clientY);
    if (grip !== null) {
      e.stopImmediatePropagation();
      // A press on a grip is never a click that picks (or deselects) what is under it.
      this.downAt = null;
      if (e.altKey && grip.role === 'vertex') {
        const del = this.helpers.deleteHandlePoint(grip);
        if (!del.ok) this.cb.onHandleRefused?.(del.message);
        else this.commitHandle(del.shape);
        return;
      }
      if (!this.helpers.beginHandleDrag(grip)) return;
      this.handleDragging = true;
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      this.requestRender();
      return;
    }
    // The instance brush paints or erases on the selected set (not while the gizmo is under the pointer).
    if (this.instanceBrush.active(this.selectedId) && !e.altKey && this.gizmo.axis === null && this.instanceBrush.begin(e.clientX, e.clientY)) {
      e.stopImmediatePropagation();
      this.brushPressed = true;
      this.downAt = null;
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      return;
    }
  };

  /** Store a handle shape (one setComponent), or say why it cannot be stored. */
  private commitHandle(shape: HandleShape): void {
    const edit = commitValue(shape);
    if (edit === null) return;
    if (!edit.ok) {
      this.cb.onHandleRefused?.(edit.message);
      return;
    }
    this.cb.onHandleEdit?.(shape.entityId, edit.component, edit.value);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.blockEditorInst?.isActive() === true && this.blockEditorInst.pointerMove(e)) {
      e.stopImmediatePropagation();
      return;
    }
    if (this.handleDragging) {
      e.stopImmediatePropagation();
      this.helpers.moveHandleDrag(e.clientX, e.clientY, this.snapping());
      this.requestRender();
      return;
    }
    if (this.instanceBrush.active(this.selectedId)) {
      this.instanceBrush.move(e.clientX, e.clientY);
      if (this.instanceBrush.stroking()) {
        e.stopImmediatePropagation();
        return;
      }
    }
    if (this.draggingGizmo) this.applySnapping();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.blockEditorInst !== null && this.blockEditorInst.pointerUp(e)) {
      e.stopImmediatePropagation();
      this.orbit.enabled = true;
      return;
    }
    const down = this.downAt;
    this.downAt = null;
    if (this.handleDragging) {
      e.stopImmediatePropagation();
      this.handleDragging = false;
      this.orbit.enabled = true;
      const shape = this.helpers.endHandleDrag();
      this.requestRender();
      if (shape !== null) this.commitHandle(shape);
      return;
    }
    if (this.brushPressed) {
      e.stopImmediatePropagation();
      this.brushPressed = false;
      this.orbit.enabled = true;
      this.instanceBrush.end(e.clientX, e.clientY);
      return;
    }
    // A left click (no drag, not on a gizmo handle) picks or deselects.
    if (e.button !== 0 || down === null || this.draggingGizmo || this.gizmo.axis !== null) return;
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

  /** The instance brush paints or erases on this set (null: off); the gizmo stands aside while it is on. */
  setInstanceBrush(entityId: string | null, mode: InstanceBrushMode, brush: InstanceBrush): void {
    this.instanceBrush.set(entityId, mode, brush);
    this.orbit.enabled = true;
    this.setSelected(this.selectedId);
  }

  /** Every instance-brush stroke sent so far has been answered. */
  instanceStrokesSettled(): Promise<unknown> {
    return this.instanceBrush.settled();
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
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(2, box.getSize(new THREE.Vector3()).length() / 2);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.far = Math.max(1000, distance * 10);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
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
    const aspect = w / h;
    const refit = Math.abs(aspect - this.camera.aspect) > 1e-6;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // Icons stay square on screen (the adapter sizes its canvas and renderer each frame).
    if (refit) this.entityOverlays.refit();
    this.requestRender();
  }

  dispose(): void {
    this.blockEditorInst?.dispose();
    this.blockEditorInst = null;
    this.releaseEffectPreview();
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
    this.instanceBrush.dispose();
    this.adapter.dispose();
  }
}
