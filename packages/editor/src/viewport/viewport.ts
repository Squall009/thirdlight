/**
 * Authoring viewport — imperative three.js, framework-free.
 *
 * The three.js scene graph, camera controls, and picking live OUTSIDE React
 * (React never instantiates or mutates Object3Ds). The
 * viewport renders the browser's PROJECTION of the backend scene; it never
 * mutates the scene itself — scene mutation flows only through editing
 * commands (the client). A gizmo gesture previews transforms locally (the
 * Object3D moves under the drag) and the commit is ONE undoable command.
 *
 * Browser-only: uses the DOM (canvas, events) + WebGL via three.js.
 */

import {
  addBoxLightmapUv,
  BATCH_KEY,
  BATCHED_LAYER,
  batchingFromUrl,
  createAutoBatcher,
  createEffectsPlayer,
  createEnvironmentRenderer,
  createRenderer,
  disposeObjectTree,
  rendererMemory,
  DEFAULT_RENDERER_PREFERENCE,
  pageSearch,
  SELECTION_HIGHLIGHT_EMISSIVE,
  setSelectionHighlight,
  unitBoxGeometry,
  type AutoBatcher,
  type EffectComponentLike,
  type EffectDefLike,
  type EffectsPlayer,
  type EnvironmentLike,
  type EnvironmentRenderer,
  type FogVolumeLike,
  type LightingBakeLike,
  type MaterialLibrary,
  type RendererHandle,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
  BlockLayerView,
  blockLookFromObject,
  type BlockModelLook,
  selectSceneLights,
  type SceneLightKind,
} from '@thirdlight/three-adapter';
import type { BlockChunk, BlockLayerComponent, BlockType } from '@thirdlight/project-model';
import * as THREE from 'three';
import { blendEnvironment, blendLight, type CameraPose, CameraBrain, type EnvironmentBlendView, type EnvironmentLightValues } from '@thirdlight/runtime';
import type { EnvironmentPreset } from '@thirdlight/project-model';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeOrbitControls, releaseControlKeyListeners } from './controls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { ProjectedEntity } from '../session/projection';
import { effectiveFlagsOf, type EffectiveEntityFlags } from '../session/hierarchy';
import { clampScale, getSnapSettings } from '../session/snapping';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { HelperOverlay } from './helper-overlay';
import { commitValue, type HandleShape } from '../session/handles';
import { BRUSH_SPACING_M, copyAt, type CopyTransform } from '../session/instance-copies';
import { fitSprite, iconKindFor, iconTableOf, makeIconSprite, setSpriteSelected, type IconKind, type IconTable } from './icons';
import { materialOverridesOf, type ModelInstances } from './model-instances';
import { planSync, removedIds, helperRelevant } from './sync-plan';
import { BlockEditor, type BlockEditorCallbacks } from './block-editor';
import { SceneLightmaps } from './scene-lightmaps';
import { gatherBakeInputs, type BakeInputs } from './bake-inputs';

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
  /** A brush stroke on the selected instance set — new copies at these points (the set's local space). */
  onBrushStroke?: (entityId: string, points: [number, number, number][]) => void;
  /** The Scene view's renderer changed state (initialising, ready, lost, replaced). */
  onRendererChange?: (info: RendererInfo) => void;
}

const GROUND_SIZE = 20;

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface GizmoTransform {
  position: number[];
  rotation: number[];
  scale: number[];
}

/** A pointer that moved less than this (px) between down and up is a click. */
const CLICK_SLOP_PX = 4;

/** Safe numeric component read (transforms are always 3/4-element). */
const N = (v: number | undefined): number => v ?? 0;

/** The box color the play renderer uses: the surface color, else the box material color. */
/**
 * What an entity's own helpers are built from — its kind, its
 * light (type, direction, range, cone, mode) and whether it has a fog volume
 * or is a spawn. A change rebuilds them (sizes and colours update in place).
 */
function buildKeyOf(e: ProjectedEntity, aspect: number): string {
  const l = e.light;
  // The camera's frustum (fovY/near/far and the game's aspect) and a spawn's facing (its yaw) shape the helpers too.
  const camera = e.kind === 'camera' ? [e.components['camera'] ?? null, aspect] : null;
  const facing = e.playerSpawn === true ? ((e.components['playerSpawn'] as { yaw?: number } | undefined)?.yaw ?? null) : null;
  return JSON.stringify([e.kind, l === undefined ? null : [l.type, l.direction ?? null, l.range ?? null, l.angle ?? null, l.mode ?? null], e.fogVolume !== undefined, e.playerSpawn === true, camera, facing]);
}

/** The game's aspect before the Scene view is told one (16:9, the common screen shape). */
const DEFAULT_GAME_ASPECT = 16 / 9;

function boxColor(e: ProjectedEntity): number {
  const hex = e.surface?.color ?? e.box?.color ?? '#cccccc';
  return parseInt(hex.slice(1), 16);
}

/**
 * The authoring viewport. Owns a single three.js Scene/Camera/Renderer and a
 * set of entity meshes synced from the projection. Selection + gizmo gestures
 * are driven by pointer events; the commit is handed to the caller (the
 * client) as one command.
 */
export class Viewport {
  readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** The renderer (the three-adapter factory's); replaced with the canvas on a backend change. */
  private rendererHandle: RendererHandle;
  private rendererChoice: { preference: RendererPreference; source: RendererPreferenceSource };
  /** The renderer generation the environment renderer was built for. */
  private environmentGeneration = 0;
  private root: HTMLCanvasElement;
  private readonly meshes = new Map<string, THREE.Object3D>();
  private readonly cb: ViewportCallbacks;
  private selectedId: string | null = null;
  /** Effective flags from the last sync (inactive = hidden, locked = not pickable/movable). */
  private hierarchyFlags: ReadonlyMap<string, EffectiveEntityFlags> = new Map();
  private folderIds = new Set<string>();
  private gizmoMode: GizmoMode = 'translate';
  /** The model realization path (shared with the asset browser). */
  private models: ModelInstances | null = null;
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  /** The helper overlay: collider outlines, component areas, the selection's handles. */
  private readonly helpers: HelperOverlay;
  /** Which helpers the Scene view draws (the Gizmos menu). */
  private gizmos = { icons: true, lights: true, colliders: true, gameplay: true };
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly snapping: () => boolean;
  private gizmoTargetId: string | null = null;
  /** A gizmo drag is in flight (between TransformControls mouseDown/mouseUp). */
  private draggingGizmo = false;
  /** Esc during a gizmo drag: the object is reset and the release commits nothing. */
  private gizmoCancelled = false;
  private downAt: { x: number; y: number } | null = null;
  private renderQueued = false;
  private readonly raycaster = new THREE.Raycaster();
  /**
   * Repeated boxes and model pieces drawn instanced. Their own
   * meshes stay in the graph for picking, the gizmo and bounds (on the
   * batched layer, which the raycaster enables).
   */
  private readonly batcher: AutoBatcher;
  /** The unit box every box is drawn through when batched. */
  private readonly unitBox = unitBoxGeometry(addBoxLightmapUv);
  /** Box materials shared by colour and selection (counted). */
  private readonly boxLooks = new Map<string, { material: THREE.MeshLambertMaterial; refs: number }>();
  /** The entity object each node was last synced from (the projection is copy-on-write). */
  private readonly synced = new Map<string, ProjectedEntity>();
  /** Frames drawn (render on demand: none while nothing changes). */
  private framesDrawn = 0;
  /** The entity whose meshes carry the selection highlight. */
  private highlightedId: string | null = null;
  /** When animated materials started (their clock). */
  private readonly clockStart = performance.now();

  constructor(canvas: HTMLCanvasElement, cb: ViewportCallbacks, options: { snapping?: () => boolean; renderer?: { preference: RendererPreference; source: RendererPreferenceSource } } = {}) {
    this.root = canvas;
    this.cb = cb;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.rendererChoice = options.renderer ?? { preference: DEFAULT_RENDERER_PREFERENCE, source: 'default' };
    this.rendererHandle = this.makeRenderer(canvas);
    this.scene.background = new THREE.Color(0x14161c);
    this.batcher = createAutoBatcher(this.scene);
    // Its update (before every frame) walks the graph for the world matrices: the renderer's own pass is left out.
    this.scene.matrixWorldAutoUpdate = false;
    // `?batching=off` on the editor page: every object drawn on its own (a diagnostic comparison).
    this.batcher.setEnabled(batchingFromUrl(pageSearch()));
    this.raycaster.layers.enable(BATCHED_LAYER);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      new THREE.MeshLambertMaterial({ color: 0x1c1f27, side: THREE.DoubleSide }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE, 0x333844, 0x23262f);
    this.scene.add(this.grid);

    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(5, 10, 7);
    this.scene.add(key);
    const fill = new THREE.AmbientLight(0x8899bb, 0.6);
    this.scene.add(fill);
    this.editorLights.push(key, fill);

    this.helpers = new HelperOverlay(this.scene, this.camera, canvas);

    this.snapping = options.snapping ?? (() => false);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.addEventListener('change', () => this.requestRender());

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
        this.models?.previewCopy(this.copySel.entityId, this.copySel.index, [...t.position, ...t.rotation, ...t.scale]);
        this.updateCopyHighlight();
        return;
      }
      // A moved object lands on the cell tops under it (translate gestures).
      if (this.cellTopSnap !== null && this.gizmoMode === 'translate' && this.gizmo.object !== undefined) {
        const o = this.gizmo.object;
        const at = this.cellTopSnap(id, [o.position.x, o.position.y, o.position.z], [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]);
        if (at !== null) {
          o.position.set(at[0], at[1], at[2]);
          o.updateMatrixWorld(true);
        }
      }
      this.cb.onGestureFrame(id, this.readTarget());
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
      if (id && !cancelled) void this.cb.onGestureEnd(id, this.readTarget());
    });
    this.scene.add(this.gizmo.getHelper());

    this.camera.position.set(6, 5, 6);
    this.orbit.update();
    this.bindEvents();
    this.resize();
  }

  /** Install the model realization path. */
  setModelInstances(models: ModelInstances | null): void {
    this.models = models;
  }

  // ---- Block layers --------------------------------------------------
  /** The block layers (the same merged chunk meshes Play and exports draw). */
  private blockView: BlockLayerView | null = null;
  private blockRevision = -1;
  private blockLooks = new Map<string, BlockModelLook | null | 'loading'>();
  /** A chunk with lightmap UVs was rebuilt: the lightmaps go on again before the next draw. */
  private blockLightmapsDirty = false;

  private ensureBlockView(): BlockLayerView {
    if (this.blockView !== null) return this.blockView;
    const view = new BlockLayerView({
      modelLook: (assetId, piece, onReady) => {
        const key = `${assetId}|${piece ?? ''}`;
        const hit = this.blockLooks.get(key);
        if (hit === 'loading') return null;
        if (hit !== undefined) return hit;
        this.blockLooks.set(key, 'loading');
        void this.models?.prepared(assetId).then((res) => {
          if (res === null) {
            this.blockLooks.set(key, null);
            return;
          }
          const made = res.createInstance(piece !== undefined ? { piece } : {});
          this.blockLooks.set(key, made.ok ? blockLookFromObject(made.instance.root) : null);
          onReady();
          this.requestRender();
        });
        return null;
      },
      applyMaterials: (mesh, type) => {
        const lib = this.materialLibrary;
        if (lib !== null && type.materials !== undefined && Object.keys(type.materials).length > 0) lib.apply(mesh, type.materials, null);
      },
      // Baked block layers: their chunks carry lightmap UVs; a rebuilt chunk takes its lightmap again.
      lightmapped: (id) => this.lightmaps.hasChunks(id),
      chunkBuilt: () => {
        this.blockLightmapsDirty = true;
      },
    });
    this.scene.add(view.root);
    this.blockView = view;
    return view;
  }

  /**
   * The project's block layers (their component, stored chunks and origin)
   * and block types; `revision` changes whenever cells, layers or types do.
   */
  setBlockLayers(types: readonly BlockType[], layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; hidden?: boolean }>, revision: number): void {
    const view = this.ensureBlockView();
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
    for (const [id, l] of layers) {
      const g = view.root.getObjectByName(`block-layer:${id}`);
      if (g !== undefined) g.visible = l.hidden !== true;
    }
    this.requestRender();
  }

  /** The chunk objects each layer was last drawn from (edits hand over only the changed ones). */
  private blockApplied = new Map<string, { component: string; chunks: Map<string, BlockChunk> }>();

  // ---- Block-layer editing ---------------------------------------------
  private blockEditorInst: BlockEditor | null = null;
  private orbitButtons: OrbitControls['mouseButtons'] | null = null;

  /** The block-layer editing tools (created on first use with the App's callbacks). */
  blockEditor(cb?: BlockEditorCallbacks): BlockEditor | null {
    if (this.blockEditorInst === null && cb !== undefined) {
      this.blockEditorInst = new BlockEditor({ scene: this.scene, camera: this.camera, canvas: this.root, requestRender: () => this.requestRender(), view: () => this.ensureBlockView() }, cb);
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

  /** Block-layer draw statistics (tests read them). */
  blockStats(): { layers: number; chunks: number; meshes: number; triangles: number } {
    return this.blockView?.diagnostics() ?? { layers: 0, chunks: 0, meshes: 0, triangles: 0 };
  }
  // ---- Lightmaps ----------------------------------------------------
  /** The last synced entities (the bake reads them). */
  private projected: readonly ProjectedEntity[] = [];
  /** The bakes shown on the baked objects and block-layer chunks (game lighting). */
  private readonly lightmaps = new SceneLightmaps({
    projected: () => this.projected,
    rootOf: (id) => this.models?.instanceFor(id) ?? this.meshes.get(id) ?? null,
    gameLighting: () => this.lighting === 'game',
    blockView: () => this.blockView,
    requestRender: () => this.requestRender(),
  });

  /** The project's bakes (sceneId → bake); null clears them. */
  setLightmaps(bakes: Readonly<Record<string, LightingBakeLike>> | null, loadTexture: (assetId: string) => Promise<THREE.Texture | null>): void {
    this.lightmaps.set(bakes, loadTexture);
    // Baked block layers draw their chunks with lightmap UVs from now on.
    if (this.blockView !== null) for (const id of this.blockView.layerIds()) this.blockView.setLightmapUv(id, this.lightmaps.hasChunks(id));
    // The light set changes with the bakes (held lights leave realtime).
    for (const [id, have] of [...this.sceneLights]) {
      this.dropSceneLight(have);
      this.sceneLights.delete(id);
    }
    this.syncSceneLights(this.projected);
    this.lightmaps.apply();
    this.render();
  }

  private unapplyLightmaps(): void {
    this.lightmaps.unapply();
  }

  private applyLightmaps(): void {
    this.lightmaps.apply();
  }

  /** A model instance arrived or left: its lightmap goes on (the viewport re-renders anyway). */
  refreshLightmaps(): void {
    this.unapplyLightmaps();
    this.applyLightmaps();
    // An instance buffer arrived — the selected copy's stand-in and box follow it.
    if (this.copySel !== null && !this.draggingGizmo) this.syncCopyProxy();
  }

  /**
   * What a bake of these entities needs, in world space: each static object's
   * meshes (with UV1: a lightmap target; without: a shadow caster only) and
   * the baked lights. Models use their most detailed level.
   */
  bakeInputs(entityIds: ReadonlySet<string>): BakeInputs {
    this.unapplyLightmaps();
    const inputs = gatherBakeInputs(
      {
        scene: this.scene,
        projected: this.projected,
        rootOf: (e) => (e.kind === 'model' ? (this.models?.instanceFor(e.id) ?? null) : e.kind === 'box' ? (this.meshes.get(e.id) ?? null) : null),
        nodeOf: (id) => this.meshes.get(id),
        blockView: this.blockView,
      },
      entityIds,
    );
    this.applyLightmaps();
    return inputs;
  }

  /**
   * "editor" lighting is a fixed key + fill; "game" lighting uses
   * the scene's own lights (what Play shows). Automatic until chosen: game
   * lighting as soon as the scene has a light.
   */
  private readonly editorLights: THREE.Light[] = [];
  private lighting: 'editor' | 'game' = 'editor';
  private lightingChosen = false;
  private readonly sceneLights = new Map<string, { key: string; light: THREE.Light; parent: THREE.Object3D }>();
  setLighting(mode: 'editor' | 'game'): void {
    this.lighting = mode;
    this.lightingChosen = true;
    this.applyLighting();
  }
  getLighting(): 'editor' | 'game' {
    return this.lighting;
  }
  private applyLighting(): void {
    this.unapplyLightmaps();
    this.applyLightmaps();
    this.environment?.setBlend(null);
    this.environment?.set(this.lighting === 'game' ? this.environmentValue : null);
    this.applyEnvironmentPreview();
    this.environment?.setQuality(this.editorQuality());
    for (const l of this.editorLights) l.visible = this.lighting === 'editor';
    for (const { light } of this.sceneLights.values()) light.visible = this.lighting === 'game' && light.userData['tlActive'] !== false && light.userData['tlSwitchedOn'] !== false;
    this.render();
  }
  /** The project's texture loader (spot light cookies; null until the editor set it). */
  private textureSource: ((assetId: string) => Promise<THREE.Texture | null>) | null = null;
  setTextureSource(loadTexture: ((assetId: string) => Promise<THREE.Texture | null>) | null): void {
    this.textureSource = loadTexture;
  }
  /** Drop a scene light (its cookie texture is the viewport's). */
  private dropSceneLight(have: { light: THREE.Light; parent: THREE.Object3D }): void {
    have.parent.remove(have.light);
    if (have.light instanceof THREE.SpotLight || have.light instanceof THREE.DirectionalLight) have.parent.remove(have.light.target);
    if (have.light instanceof THREE.SpotLight && have.light.map !== null) {
      have.light.map.dispose();
      have.light.map = null;
    }
    have.light.dispose();
  }
  /** A spot light's cookie, drawn in the Scene view as in Play (three's SpotLight.map). */
  private loadCookie(light: THREE.SpotLight, assetId: string): void {
    const load = this.textureSource;
    if (load === null) return;
    void load(assetId).then(
      (tex) => {
        if (tex === null) return;
        const live = [...this.sceneLights.values()].some((h) => h.light === light);
        if (!live) {
          tex.dispose();
          return;
        }
        tex.flipY = false; // as the game decodes it
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        light.map = tex;
        this.requestRender();
      },
      () => undefined,
    );
  }
  private syncSceneLights(entities: readonly ProjectedEntity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      const l = e.light;
      // A light a bake holds is not realtime (ambient/hemisphere stay for dynamic objects).
      if (l === undefined || (l.mode === 'baked' && l.type !== 'ambient' && l.type !== 'hemisphere' && this.lightmaps.bakedLightIds.has(e.id))) continue;
      seen.add(e.id);
      const key = JSON.stringify(l);
      const group = this.meshes.get(e.id);
      if (group === undefined) continue;
      let have = this.sceneLights.get(e.id);
      if (have !== undefined && have.key !== key) {
        this.dropSceneLight(have);
        this.sceneLights.delete(e.id);
        have = undefined;
      }
      if (have === undefined) {
        const made = makeSceneLight(l);
        // Directional/ambient/hemisphere lights ignore the entity transform (as in Play); point/spot follow it.
        const parent = l.type === 'point' || l.type === 'spot' ? group : this.scene;
        parent.add(made);
        if (made instanceof THREE.SpotLight || made instanceof THREE.DirectionalLight) parent.add(made.target);
        have = { key, light: made, parent };
        this.sceneLights.set(e.id, have);
        if (made instanceof THREE.SpotLight && l.type === 'spot' && l.cookie !== undefined) this.loadCookie(made, l.cookie);
      }
      have.light.userData['tlActive'] = this.hierarchyFlags.get(e.id)?.active !== false;
    }
    for (const [id, have] of [...this.sceneLights]) {
      if (seen.has(id)) continue;
      this.dropSceneLight(have);
      this.sceneLights.delete(id);
    }
    // With several scenes open, the lights Play would have on with them loaded in that order
    // (the last open scene's directional, ambient and hemisphere light; point and spot lights within the budget).
    const sceneRank = new Map<string, number>();
    for (const e of entities) if (e.sceneId !== undefined && !sceneRank.has(e.sceneId)) sceneRank.set(e.sceneId, sceneRank.size);
    const byId = new Map(entities.map((e) => [e.id, e]));
    let order = 0;
    const picked = selectSceneLights([...this.sceneLights].map(([id]) => {
      const e = byId.get(id);
      return { id, kind: (e?.light?.type ?? 'point') as SceneLightKind, rank: e?.sceneId !== undefined ? (sceneRank.get(e.sceneId) ?? -1) : -1, order: order++ };
    }));
    for (const [id, have] of this.sceneLights) have.light.userData['tlSwitchedOn'] = picked.active.has(id);
    // A preset preview applies to the lights as they are now.
    this.lightTags = new Map(entities.filter((e) => e.light !== undefined).map((e) => [e.id, e.tags]));
    if (this.envPreview !== null) this.applyEnvironmentPreview();
    // The sun of a procedural sky sits opposite the scene's directional light.
    const key = (picked.directional !== null ? byId.get(picked.directional) : undefined) ?? entities.find((e) => e.light?.type === 'directional' && e.light.direction !== undefined);
    this.keyLightDirection = key?.light?.direction ?? null;
    this.environment?.setKeyLightDirection(this.keyLightDirection);
    this.fogVolumeData = new Map(entities.filter((e) => e.fogVolume !== undefined).map((e) => [e.id, e.fogVolume!]));
    const lightingBefore = this.lighting;
    if (!this.lightingChosen) this.lighting = this.sceneLights.size > 0 ? 'game' : 'editor';
    if (lightingBefore !== this.lighting) this.applyLighting();
    else {
      for (const l of this.editorLights) l.visible = this.lighting === 'editor';
      for (const { light } of this.sceneLights.values()) light.visible = this.lighting === 'game' && light.userData['tlActive'] !== false && light.userData['tlSwitchedOn'] !== false;
    }
  }

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
    const cams = entities.filter((e) => e.components['virtualCamera'] !== undefined);
    if (cams.length > 0) {
      if (this.vcamPreviews.parent === null) {
        this.vcamPreviews.name = 'virtual-camera-previews';
        this.scene.add(this.vcamPreviews);
      }
      const sceneCam = entities.find((e) => e.kind === 'camera')?.components['camera'] as { fovY?: number; near?: number; far?: number } | undefined;
      const brain = new CameraBrain(120, { fovY: sceneCam?.fovY ?? 60, near: sceneCam?.near ?? 0.1, far: sceneCam?.far ?? 100 });
      brain.add(entities.map((e) => ({ id: e.id, components: e.components })));
      const byId = new Map(entities.map((e) => [e.id, e]));
      const world = {
        worldOf: (id: string, p: number[], r: number[]): boolean => {
          const e = byId.get(id);
          if (e === undefined) return false;
          const m = new THREE.Matrix4();
          for (let cur: ProjectedEntity | undefined = e, depth = 0; cur !== undefined && depth < 64; cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined, depth += 1) {
            const local = new THREE.Matrix4().compose(new THREE.Vector3(N(cur.position[0]), N(cur.position[1]), N(cur.position[2])), new THREE.Quaternion(N(cur.rotation[0]), N(cur.rotation[1]), N(cur.rotation[2]), cur.rotation[3] ?? 1), new THREE.Vector3(cur.scale[0] ?? 1, cur.scale[1] ?? 1, cur.scale[2] ?? 1));
            m.premultiply(local);
          }
          const pos = new THREE.Vector3();
          const rot = new THREE.Quaternion();
          m.decompose(pos, rot, new THREE.Vector3());
          p[0] = pos.x;
          p[1] = pos.y;
          p[2] = pos.z;
          r[0] = rot.x;
          r[1] = rot.y;
          r[2] = rot.z;
          r[3] = rot.w;
          return true;
        },
      };
      for (const e of cams) {
        const pose = brain.previewPose(e.id, world);
        if (pose === null) continue;
        const vc = e.components['virtualCamera'] as { rig?: string; distance?: number };
        const reach = vc.rig === 'follow' || vc.rig === 'orbitPoint' || vc.rig === 'topDown' ? (vc.distance ?? 5) : 3;
        const lines = virtualCameraFrustum(e.id, pose, this.gameAspect, reach);
        lines.visible = this.selectedId === e.id;
        this.vcamPreviews.add(lines);
      }
    }
    this.showVirtualCameraPreview();
  }
  /**
   * The timeline tab's scrub preview — the bound objects at the
   * timeline's time (the runtime's own evaluation, `evaluateTimelineAt`) and
   * the live camera's frustum there (the camera brain's rig maths, with the
   * key's rail progress). Presentation only: nothing is written to the
   * project; null restores the authored transforms. `data-timeline-preview`
   * reports what is drawn (the objects' positions read back from the scene).
   */
  private timelinePreview: { time: number; transforms: ReadonlyMap<string, { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] }>; camera: { entityId: string; progress: number | null } | null } | null = null;
  private readonly timelinePreviewed = new Set<string>();
  private timelineFrustum: THREE.LineSegments | null = null;
  setTimelinePreview(preview: { time: number; transforms: ReadonlyMap<string, { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] }>; camera: { entityId: string; progress: number | null } | null } | null): void {
    this.timelinePreview = preview;
    this.applyTimelinePreview();
  }
  private applyTimelinePreview(): void {
    for (const id of this.timelinePreviewed) {
      const m = this.meshes.get(id);
      const e = this.synced.get(id);
      if (m !== undefined && e !== undefined && !(this.draggingGizmo && id === this.gizmoTargetId)) {
        m.position.set(N(e.position[0]), N(e.position[1]), N(e.position[2]));
        m.quaternion.set(N(e.rotation[0]), N(e.rotation[1]), N(e.rotation[2]), N(e.rotation[3]));
        m.scale.set(N(e.scale[0]), N(e.scale[1]), N(e.scale[2]));
      }
    }
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
      const m = this.meshes.get(id);
      if (m === undefined) continue;
      if (pose.position !== undefined) m.position.set(N(pose.position[0]), N(pose.position[1]), N(pose.position[2]));
      if (pose.rotation !== undefined) m.quaternion.set(N(pose.rotation[0]), N(pose.rotation[1]), N(pose.rotation[2]), N(pose.rotation[3]));
      if (pose.scale !== undefined) m.scale.set(N(pose.scale[0]), N(pose.scale[1]), N(pose.scale[2]));
      this.timelinePreviewed.add(id);
      shown[id] = [m.position.x, m.position.y, m.position.z];
    }
    let camera: unknown = null;
    if (p.camera !== null && this.projected.some((e) => e.id === p.camera!.entityId && e.components['virtualCamera'] !== undefined)) {
      const entities = this.projected;
      const sceneCam = entities.find((e) => e.kind === 'camera')?.components['camera'] as { fovY?: number; near?: number; far?: number } | undefined;
      const brain = new CameraBrain(120, { fovY: sceneCam?.fovY ?? 60, near: sceneCam?.near ?? 0.1, far: sceneCam?.far ?? 100 });
      brain.add(entities.map((e) => ({ id: e.id, components: e.components })));
      if (p.camera.progress !== null) brain.set(p.camera.entityId, { progress: p.camera.progress });
      const byId = new Map(entities.map((e) => [e.id, e]));
      const world = {
        worldOf: (id: string, out: number[], rot: number[]): boolean => {
          const e = byId.get(id);
          if (e === undefined) return false;
          const m = new THREE.Matrix4();
          for (let cur: ProjectedEntity | undefined = e, depth = 0; cur !== undefined && depth < 64; cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined, depth += 1) {
            // A previewed object is where the timeline puts it.
            const pv = p.transforms.get(cur.id);
            const pos = pv?.position ?? cur.position;
            const q = pv?.rotation ?? cur.rotation;
            const sc = pv?.scale ?? cur.scale;
            m.premultiply(new THREE.Matrix4().compose(new THREE.Vector3(N(pos[0]), N(pos[1]), N(pos[2])), new THREE.Quaternion(N(q[0]), N(q[1]), N(q[2]), q[3] ?? 1), new THREE.Vector3(sc[0] ?? 1, sc[1] ?? 1, sc[2] ?? 1)));
          }
          const v = new THREE.Vector3();
          const r = new THREE.Quaternion();
          m.decompose(v, r, new THREE.Vector3());
          out[0] = v.x;
          out[1] = v.y;
          out[2] = v.z;
          rot[0] = r.x;
          rot[1] = r.y;
          rot[2] = r.z;
          rot[3] = r.w;
          return true;
        },
      };
      const pose = brain.previewPose(p.camera.entityId, world);
      if (pose !== null) {
        const vc = byId.get(p.camera.entityId)?.components['virtualCamera'] as { rig?: string; distance?: number } | undefined;
        const reach = vc?.rig === 'follow' || vc?.rig === 'orbitPoint' || vc?.rig === 'topDown' ? (vc.distance ?? 5) : 3;
        this.timelineFrustum = virtualCameraFrustum(p.camera.entityId, pose, this.gameAspect, reach);
        this.timelineFrustum.name = `timeline-camera:${p.camera.entityId}`;
        this.scene.add(this.timelineFrustum);
        camera = { id: p.camera.entityId, position: [...pose.position], rotation: [...pose.rotation] };
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

  /** Project materials on boxes (models get theirs through ModelInstances). */
  private materialLibrary: MaterialLibrary | null = null;
  private readonly boxMaterials = new Map<string, { key: string; undo: () => void }>();
  setMaterialLibrary(library: MaterialLibrary | null): void {
    this.materialLibrary = library;
  }

  private syncBoxMaterial(e: ProjectedEntity, obj: THREE.Object3D): void {
    const lib = this.materialLibrary;
    const mapping = e.kind === 'box' ? (e.materials ?? null) : null;
    // The object's values for its graph materials' public parameters.
    const overrides = materialOverridesOf(e);
    const key = mapping === null ? '' : JSON.stringify([mapping, overrides]);
    const have = this.boxMaterials.get(e.id);
    if (have !== undefined && have.key === key) return;
    have?.undo();
    this.boxMaterials.delete(e.id);
    if (lib === null || mapping === null) return;
    const mesh = obj.children.find((c) => (c as THREE.Mesh).isMesh && (c as { entityId?: string }).entityId === e.id);
    if (mesh === undefined) return;
    this.boxMaterials.set(e.id, { key, undo: lib.apply(mesh, mapping, overrides) });
  }

  /** The Object3D a gizmo/selection targets: the entity's node in the scene graph. */
  private targetFor(id: string): THREE.Object3D | null {
    return this.meshes.get(id) ?? null;
  }

  /** The entity's scene-graph node (model instances attach under it). */
  objectFor(id: string): THREE.Object3D | null {
    return this.meshes.get(id) ?? null;
  }

  /**
   * For "Fit to model": the bounding box of the models drawn for
   * an entity — its own model and its children's — relative to the entity's
   * world position, or null when none is loaded.
   */
  modelBounds(entityId: string): { min: number[]; max: number[] } | null {
    const node = this.meshes.get(entityId);
    if (node === undefined || this.models === null) return null;
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const visit = (o: THREE.Object3D): void => {
      const id = (o as { entityId?: string }).entityId;
      if (id !== undefined && this.meshes.get(id) === o) {
        const holder = this.models!.instanceFor(id);
        if (holder) box.expandByObject(holder, true);
      }
      for (const c of o.children) visit(c);
    };
    visit(node);
    if (box.isEmpty()) return null;
    const at = node.getWorldPosition(new THREE.Vector3());
    return { min: [box.min.x - at.x, box.min.y - at.y, box.min.z - at.z], max: [box.max.x - at.x, box.max.y - at.y, box.max.z - at.z] };
  }

  /** Where the camera is looking (new entities spawn here). */
  focusPoint(): [number, number, number] {
    const t = this.orbit.target;
    return [t.x, t.y, t.z];
  }

  /**
   * Where something dropped at a pointer position lands: the first visible
   * surface under the pointer, else the ground plane (y = 0), else the focus
   * point. Snapped to the translate step when snapping is on.
   */
  dropPoint(clientX: number, clientY: number): [number, number, number] {
    const rect = this.root.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const [id, m] of this.meshes) {
      if (m.visible) targets.push(m);
      const holder = this.models?.instanceFor(id);
      if (holder) targets.push(holder);
    }
    let point: THREE.Vector3 | null = null;
    for (const h of this.raycaster.intersectObjects(targets, true)) {
      if (h.object.visible && (h.object as THREE.Mesh).isMesh) {
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
    const obj = this.meshes.get(id);
    if (!obj) return;
    const world = obj.getWorldPosition(new THREE.Vector3());
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
      const lib = (): MaterialLibrary | null => this.materialLibrary;
      const holders = new Map<string, { mesh: THREE.Mesh; undo: () => void }>();
      const placeholder = new THREE.MeshBasicMaterial();
      this.effectHolders = { holders, placeholder };
      this.effectsPlayer = createEffectsPlayer({
        scene: this.scene as never,
        defs,
        loadTexture: loadTexture ?? (async () => null),
        replayFinished: true,
        projectMaterial: (id) => {
          const l = lib();
          if (l === null || id === '') return null;
          let h = holders.get(id);
          if (h === undefined) {
            const mesh = new THREE.Mesh(new THREE.BufferGeometry(), placeholder);
            h = { mesh, undo: l.apply(mesh, { '*': id }) };
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
    const obj = t !== null ? (this.meshes.get(t.id) ?? null) : null;
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
    if (p === null) return false;
    if (this.effectRenderer !== renderer) {
      p.setRenderer(renderer as never, this.rendererHandle.info().api === 'webgpu' ? 'webgpu' : 'webgl2');
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

  /** Schedule one render on the next animation frame (coalesces bursts). */
  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      // Where the handle grips are on screen (tests drag them); grips keep their screen size.
      this.helpers.scaleGrips();
      this.root.setAttribute('data-size-handles', JSON.stringify(this.helpers.sizeHandleClientPoints()));
      // The selected instance set's copies and the gizmo's X arrow on screen (tests click and drag them).
      const setId = this.selectedId !== null && this.projected.find((x) => x.id === this.selectedId)?.instances !== undefined ? this.selectedId : null;
      this.root.setAttribute('data-instance-copies', setId === null ? '[]' : JSON.stringify(this.copyClientPoints(setId)));
      this.root.setAttribute('data-gizmo-grab', JSON.stringify(this.gizmoGrab()));
      // WebGPURenderer initialises asynchronously (the handle asks for a frame when ready).
      const renderer = this.rendererHandle.ready() ? this.rendererHandle.current() : null;
      if (renderer === null) return;
      // The effect preview steps before the frame and keeps the view drawing while it plays.
      const playing = this.stepEffects(renderer);
      // Animated materials (wind, water) tick with the frame and keep the view drawing;
      // nothing else draws unless something asked for a frame (render on demand).
      const lib = this.materialLibrary;
      const animated = lib !== null && lib.animated();
      if (animated) lib!.tick((performance.now() - this.clockStart) / 1000);
      // While the block tools are on, the view-projection matrix (tests map cells to the screen).
      if (this.blockEditorInst?.isActive() === true) {
        this.camera.updateMatrixWorld();
        const vp = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.root.setAttribute('data-view-proj', JSON.stringify(vp.elements.map((v) => Math.round(v * 1e6) / 1e6)));
      }
      // Re-mesh the block chunks that changed (before the draw).
      if (this.blockView !== null) {
        this.blockView.update();
        if (this.blockLightmapsDirty) {
          this.blockLightmapsDirty = false;
          this.unapplyLightmaps();
          this.applyLightmaps();
        }
        this.root.setAttribute('data-block-layers', JSON.stringify(this.blockView.diagnostics()));
      }
      this.batcher.update(this.camera);
      const info = renderer.info.render;
      const drawsBefore = info.drawCalls;
      const trianglesBefore = info.triangles;
      const environment = this.ensureEnvironment();
      // The editor rig also draws at the project's quality level (low: no MSAA).
      const throughEnvironment = environment !== null && (this.lighting === 'game' || this.editorQuality() !== null);
      if (throughEnvironment) {
        environment.setFogVolumes(this.fogVolumesNow());
        environment.render(this.camera);
      } else renderer.render(this.scene, this.camera);
      this.framesDrawn += 1;
      const b = this.batcher.diagnostics();
      this.root.setAttribute('data-frames', String(this.framesDrawn));
      // The renderer's live resource counts after the frame (the leak tests read them).
      this.root.setAttribute('data-memory', JSON.stringify(rendererMemory(renderer)));
      this.root.setAttribute('data-draw-calls', String(Math.max(0, info.drawCalls - drawsBefore)));
      this.root.setAttribute('data-triangles', String(Math.max(0, info.triangles - trianglesBefore)));
      this.root.setAttribute('data-batches', `${b.groups} ${b.batched} ${b.single}`);
      this.root.setAttribute('data-msaa', String(throughEnvironment ? environment!.samples() : renderer.samples));
      if (playing || animated) this.requestRender();
      if (!playing) this.effectLastNow = null;
    });
  }

  // ---- The renderer backend --------------------------------------------
  private makeRenderer(canvas: HTMLCanvasElement): RendererHandle {
    const handle = createRenderer({
      canvas,
      preference: this.rendererChoice.preference,
      source: this.rendererChoice.source,
      antialias: true,
      alpha: true,
      // Transparent where nothing is drawn (the scene background covers the view).
      clearColor: 0x000000,
      clearAlpha: 0,
    });
    handle.onChange(() => {
      if (this.rendererHandle !== handle) return;
      if (handle.ready()) this.resize();
      this.cb.onRendererChange?.(handle.info());
    });
    return handle;
  }

  /** The Scene view's renderer choice (backend, state, reason). */
  rendererInfo(): RendererInfo {
    return this.rendererHandle.info();
  }

  /**
   * Draw with another backend. A canvas keeps the context type it
   * was first given (WebGL or WebGPU), so the canvas is replaced by a fresh
   * one in the same place, with the same attributes and listeners.
   */
  setRendererChoice(preference: RendererPreference, source: RendererPreferenceSource): void {
    if (preference === this.rendererChoice.preference) {
      this.rendererChoice = { preference, source };
      return;
    }
    // Every backend is WebGPURenderer with node materials: the materials stay.
    this.rendererChoice = { preference, source };
    const old = this.root;
    const next = document.createElement('canvas');
    for (const a of [...old.attributes]) if (!a.name.startsWith('data-tl-renderer')) next.setAttribute(a.name, a.value);
    this.unbindCanvasEvents();
    this.environment?.dispose();
    this.environment = null;
    // The old canvas is never drawn to again: its WebGL context goes now (the WebGPU device is destroyed either way).
    this.rendererHandle.dispose({ loseContext: true });
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
    this.rendererHandle = this.makeRenderer(next);
    this.resize();
    this.cb.onRendererChange?.(this.rendererHandle.info());
  }

  /** The environment renderer for the current renderer (rebuilt when the renderer was replaced). */
  private ensureEnvironment(): EnvironmentRenderer | null {
    const renderer = this.rendererHandle.current();
    if (this.environmentSource === null || renderer === null) return null;
    if (this.environment !== null && this.environmentGeneration === this.rendererHandle.generation()) return this.environment;
    this.environment?.dispose();
    this.environmentGeneration = this.rendererHandle.generation();
    const env = createEnvironmentRenderer(renderer, this.scene, { loadTexture: this.environmentSource, onChange: () => this.requestRender() });
    env.resize(Math.max(1, this.root.clientWidth || this.root.width), Math.max(1, this.root.clientHeight || this.root.height));
    env.setKeyLightDirection(this.keyLightDirection);
    env.set(this.lighting === 'game' ? this.environmentValue : null);
    env.setQuality(this.editorQuality());
    this.environment = env;
    // A preset preview carries over to a new renderer.
    if (this.envPreview !== null) this.applyEnvironmentPreview();
    return env;
  }

  // ---- Environment preset preview --------------------------------------------
  /** The preset blend the Scene view previews (null: the authored look). */
  private envPreview: EnvironmentBlendView | null = null;
  private envPreviewTags = new Map<string, number>();
  private lightTags = new Map<string, number>();
  private envLightsTouched = false;
  /**
   * Show an environment preset blend (weights by preset id; '' = the base
   * look) in the Scene view with game lighting: the look, and the scene
   * lights the presets set — the runtime's own blend maths (what Play draws).
   * Null: back to the authored look. `tagBits`: the project's tag registry
   * (name → bit) for presets that name lights by tag.
   */
  previewEnvironmentBlend(view: { weights: readonly (readonly [string, number])[]; overrides?: EnvironmentBlendView['overrides'] } | null, tagBits?: ReadonlyMap<string, number>): void {
    this.envPreview = view === null ? null : { weights: view.weights, overrides: view.overrides ?? {}, target: null, progress: 1 };
    if (tagBits !== undefined) this.envPreviewTags = new Map([...tagBits].map(([k, v]) => [k.toLowerCase(), v]));
    this.applyEnvironmentPreview();
    this.requestRender();
  }
  /** The previewed blend (tests, the panel). */
  environmentPreview(): EnvironmentBlendView | null {
    return this.envPreview;
  }
  private applyEnvironmentPreview(): void {
    const view = this.envPreview;
    const presets = new Map(((this.environmentValue?.presets ?? []) as unknown as readonly EnvironmentPreset[]).map((p) => [p.presetId, p]));
    const base = (this.environmentValue ?? {}) as Parameters<typeof blendEnvironment>[0];
    if (view === null || this.lighting !== 'game') this.environment?.setBlend(null);
    else this.environment?.setBlend(blendEnvironment(base, presets, view) as never);
    // The lights: blended values, or back to what the scene authored.
    if (view === null && !this.envLightsTouched) return;
    this.envLightsTouched = view !== null;
    for (const [id, have] of this.sceneLights) {
      const l = JSON.parse(have.key) as { type: string; color: string; intensity: number; direction?: number[]; groundColor?: string };
      const d = l.direction ?? (l.type === 'spot' || l.type === 'directional' ? [0, -1, 0] : undefined);
      const authored: EnvironmentLightValues = { color: l.color, intensity: l.intensity, ...(d !== undefined ? { direction: [d[0]!, d[1]!, d[2]!] as [number, number, number] } : {}), ...(l.type === 'hemisphere' ? { groundColor: l.groundColor ?? '#444444' } : {}) };
      const v = view === null ? authored : blendLight(authored, { id, tags: this.lightTags.get(id) ?? 0, type: l.type }, this.envPreviewTags, base, presets, view);
      have.light.color.set(v.color);
      have.light.intensity = v.intensity;
      if (v.groundColor !== undefined && have.light instanceof THREE.HemisphereLight) have.light.groundColor.set(v.groundColor);
      if (v.direction !== undefined) {
        const [x, y, z] = v.direction;
        if (have.light instanceof THREE.SpotLight) have.light.target.position.set(x, y, z);
        else if (have.light instanceof THREE.DirectionalLight) have.light.position.set(-x * 20, -y * 20, -z * 20);
      }
    }
  }

  private readTarget(): GizmoTransform {
    const t = this.gizmo.object;
    if (!t) return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
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
    if (this.brushStroke !== null) {
      this.orbit.enabled = true;
      this.endBrush(true);
      return true;
    }
    if (!this.draggingGizmo || this.gizmoCancelled) return false;
    this.gizmo.reset();
    this.gizmoCancelled = true;
    this.render();
    return true;
  }

  /**
   * Sync the entity set from the projection (add/remove/update meshes).
   *
   * incremental. With `dirty` (the projection's `takeDirty()`)
   * only the entities it names — plus any whose projected object changed
   * since the last sync (the projection is copy-on-write) and the ones added
   * or removed — are rebuilt; the hierarchy flags, the helper overlay and the
   * selection are re-derived only when something they read changed. Without
   * it (or `dirty.all`), everything is synced as before. `data-sync` on the
   * view element says what the last sync did.
   */
  syncEntities(entities: ProjectedEntity[], dirty?: { readonly all: boolean; readonly ids: ReadonlySet<string> }): void {
    const t0 = performance.now();
    // The original materials are in place while the rest of the sync runs.
    this.unapplyLightmaps();
    this.projected = entities;
    const plan = planSync(entities, this.synced, dirty, this.selectedId);
    const { full, changed, selectionTouched } = plan;
    let { structural, helpers } = plan;
    if (structural) {
      this.hierarchyFlags = effectiveFlagsOf(entities);
      this.folderIds = new Set(entities.filter((e) => e.kind === 'folder').map((e) => e.id));
    }
    for (const e of changed) {
      // Model entities are realized by the shared resource path; the
      // viewport holds a hidden placeholder so picking + the gizmo keep a
      // stable target while the GLB resolves asynchronously.
      let m = this.meshes.get(e.id);
      if (!m) {
        m = this.buildMesh(e);
        this.meshes.set(e.id, m);
        this.scene.add(m);
      } else if (m.userData['tlBuildKey'] !== buildKeyOf(e, this.gameAspect)) {
        // A component added or removed in the Inspector (a box, a
        // camera, a light, a fog volume…) redraws the entity's own helpers;
        // children and a realized model under the node stay where they are.
        this.redecorate(m as THREE.Group, e);
      } else if (!(this.draggingGizmo && e.id === this.gizmoTargetId)) {
        // A gizmo drag owns its target's transform until release.
        this.updateMesh(m, e);
      }
      this.syncBoxMaterial(e, m);
      this.synced.set(e.id, e);
    }
    // Mirror the runtime scene graph: children hang under their parent node
    // (transforms are parent-relative, as in the play renderer).
    for (const e of changed) {
      const m = this.meshes.get(e.id);
      if (!m) continue;
      const parent = (e.parentId !== null ? this.meshes.get(e.parentId) : undefined) ?? this.scene;
      if (m.parent !== parent) parent.add(m);
    }
    // Remove meshes whose entities are gone (after the adds the nodes equal the entities unless some left).
    const removed = new Set(removedIds(entities, this.meshes.keys(), this.meshes.size, full));
    if (removed.size > 0) {
      const seen = new Set(entities.map((e) => e.id));
      for (const id of removed) {
        const m = this.meshes.get(id)!;
        if (helperRelevant(this.synced.get(id))) helpers = true;
        // Nodes of entities that stay go back to the scene (a later sync of theirs re-parents them).
        for (const c of [...m.children]) {
          const cid = (c as { entityId?: string }).entityId;
          if (cid !== undefined && cid !== id && seen.has(cid) && this.meshes.get(cid) === c) this.scene.attach(c);
        }
        this.boxMaterials.get(id)?.undo();
        this.boxMaterials.delete(id);
        m.parent?.remove(m);
        this.disposeMesh(m);
        this.meshes.delete(id);
        this.synced.delete(id);
        if (this.highlightedId === id) this.highlightedId = null;
        if (this.selectedId === id) this.setSelected(null);
      }
      if (!structural) {
        structural = true;
        this.hierarchyFlags = effectiveFlagsOf(entities);
        this.folderIds = new Set(entities.filter((e) => e.kind === 'folder').map((e) => e.id));
      }
    }
    this.models?.sync(entities, full ? undefined : { changed: new Set(changed.map((e) => e.id)), removed });
    this.syncSceneLights(entities);
    this.syncVirtualCameraPreviews(entities);
    // A timeline scrub preview stays on top of the synced transforms.
    if (this.timelinePreview !== null) this.applyTimelinePreview();
    // The helper overlay syncs from the SAME projection pass
    // (an inactive entity's helpers are hidden like the entity).
    // The selected entity's handles come from any of its sized components: its change re-syncs the overlay too.
    const shown = entities.filter((e) => this.hierarchyFlags.get(e.id)?.active !== false);
    if (helpers || structural || selectionTouched) this.helpers.sync(shown);
    else this.helpers.setEntities(shown);
    this.stampGizmoCounts();
    this.applyLightmaps();
    // A selection that became locked or a folder loses its gizmo.
    if (this.selectedId !== null && !this.draggingGizmo && (selectionTouched || structural)) this.setSelected(this.selectedId);
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    this.root.setAttribute('data-sync', JSON.stringify({ entities: entities.length, processed: changed.length, removed: removed.size, full, ms }));
    this.render();
  }

  private buildMesh(e: ProjectedEntity): THREE.Object3D {
    const group = new THREE.Group();
    group.name = e.id;
    (group as { entityId?: string }).entityId = e.id;
    this.decorate(group, e);
    return group;
  }

  /** Drop the node's own helpers (marked when built) and build them for what the entity is now. */
  private redecorate(group: THREE.Group, e: ProjectedEntity): void {
    this.boxMaterials.get(e.id)?.undo();
    this.boxMaterials.delete(e.id);
    for (const c of [...group.children]) {
      if (c.userData['tlOwn'] !== true) continue;
      group.remove(c);
      this.disposeMesh(c);
    }
    this.decorate(group, e);
    if (this.selectedId === e.id) this.setSelected(e.id);
  }

  /** The entity's own helpers (a box mesh, icons, gizmos), marked as its own. */
  private decorate(group: THREE.Group, e: ProjectedEntity): void {
    const before = new Set(group.children);
    this.decorateInner(group, e);
    for (const c of group.children) if (!before.has(c)) c.userData['tlOwn'] = true;
    group.userData['tlBuildKey'] = buildKeyOf(e, this.gameAspect);
  }

  private decorateInner(group: THREE.Group, e: ProjectedEntity): THREE.Object3D {
    if (e.kind === 'folder') {
      // A folder is organisation only — an empty node at the origin
      // its children hang under (it has no transform of its own).
      this.updateMesh(group, e);
      return group;
    }
    if (e.kind === 'model') {
      // A whole-GLB placement is realized by the shared resource path; the
      // placeholder only anchors picking/selection until the bytes resolve.
      // It carries the entity transform (the realized model hangs under it).
      this.updateMesh(group, e);
      return group;
    }
    if (e.kind === 'box') {
      // An authored `surface` color previews on the box in the
      // editor viewport (the play renderer realizes the full material from the
      // same component; the editor shows the copied color only).
      const size = e.box?.size ?? [1, 1, 1];
      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      addBoxLightmapUv(geometry);
      // Boxes of one colour share a material (the selected one wears the highlighted twin),
      // and are drawn through the unit box scaled by their size when batched.
      const mesh = new THREE.Mesh(geometry, this.takeBoxLook(boxColor(e), this.selectedId === e.id));
      mesh.userData.boxSize = size.join(',');
      mesh.userData[BATCH_KEY] = { geometry: this.unitBox, scale: [size[0], size[1], size[2]] };
      mesh.name = e.id;
      (mesh as { entityId?: string }).entityId = e.id;
      group.add(mesh);
    } else if (e.light !== undefined) {
      // A light is an icon billboard; a directional light also shows its direction.
      if (e.light.type === 'directional' && e.light.direction !== undefined) {
        const d = e.light.direction;
        const len = 2;
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(d[0] * len, d[1] * len, d[2] * len),
        ]);
        const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xffe27a }));
        line.name = e.id;
        (line as { entityId?: string }).entityId = e.id;
        (line as { userData?: unknown }).userData = { lightKind: 'directional' };
        group.add(line);
      }
      // A point light shows its reach, a spot light its cone.
      if ((e.light.type === 'point' || e.light.type === 'spot') && e.light.mode !== 'baked') {
        const g = lightGizmo(e);
        g.userData['gizmo'] = 'light';
        g.visible = this.gizmos.lights;
        group.add(g);
      }
      this.addIcon(group, e.id, iconKindFor(e, this.iconTable));
    } else if (e.kind === 'camera') {
      // A camera is an icon billboard plus a small wire frustum showing where it looks (-Z).
      const w = 0.42;
      const h = 0.28;
      const z = -0.9;
      const o = new THREE.Vector3(0, 0, 0);
      const c = [new THREE.Vector3(-w, -h, z), new THREE.Vector3(w, -h, z), new THREE.Vector3(w, h, z), new THREE.Vector3(-w, h, z)];
      const pts = [o, c[0]!, o, c[1]!, o, c[2]!, o, c[3]!, c[0]!, c[1]!, c[1]!, c[2]!, c[2]!, c[3]!, c[3]!, c[0]!];
      const frustum = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf2b544 }));
      frustum.name = e.id;
      (frustum as { entityId?: string }).entityId = e.id;
      group.add(frustum);
      // The real frustum (its fovY, near, far and the game's aspect), shown while the camera is selected.
      const real = cameraFrustum(e, this.gameAspect);
      real.visible = this.selectedId === e.id;
      group.add(real);
      this.addIcon(group, e.id, 'camera');
    } else {
      // An empty entity: a spawn icon when it is a player spawn, an axis cross otherwise.
      this.addIcon(group, e.id, iconKindFor(e, this.iconTable));
      // A spawn's facing, as an arrow (its yaw, degrees about +Y, 0 = +Z).
      const yaw = e.playerSpawn === true ? (e.components['playerSpawn'] as { yaw?: number } | undefined)?.yaw : undefined;
      if (typeof yaw === 'number') {
        const r = (yaw * Math.PI) / 180;
        const dir = new THREE.Vector3(Math.sin(r), 0, Math.cos(r));
        const side = new THREE.Vector3(dir.z, 0, -dir.x);
        const tip = dir.clone().multiplyScalar(0.8);
        const back = dir.clone().multiplyScalar(0.55);
        const up = new THREE.Vector3(0, 0.18, 0);
        const arrow = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), tip, tip, back.clone().add(up), tip, back.clone().sub(up), tip, back.clone().addScaledVector(side, 0.18), tip, back.clone().addScaledVector(side, -0.18)]),
          new THREE.LineBasicMaterial({ color: 0xffc857, depthTest: false }),
        );
        arrow.name = `spawn-yaw:${yaw}`;
        arrow.renderOrder = 10;
        group.add(arrow);
      }
      // A fog volume shows its box.
      if (e.fogVolume !== undefined) {
        const box = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(e.fogVolume.size[0], e.fogVolume.size[1], e.fogVolume.size[2])),
          new THREE.LineBasicMaterial({ color: new THREE.Color(e.fogVolume.color), transparent: true, opacity: 0.7 }),
        );
        box.name = e.id;
        (box as { entityId?: string }).entityId = e.id;
        box.userData = { fogVolumeSize: e.fogVolume.size.join(',') };
        group.add(box);
      }
    }
    this.updateMesh(group, e);
    return group;
  }

  /** Show or hide the Scene view's helpers (icons, light ranges, collider outlines, gameplay paths and areas). */
  setGizmos(next: Partial<{ icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean }>): void {
    this.gizmos = { ...this.gizmos, ...next };
    for (const s of this.sprites) s.visible = this.gizmos.icons;
    this.scene.traverse((o) => {
      if (o.userData['gizmo'] === 'light') o.visible = this.gizmos.lights;
    });
    this.helpers.setGizmos({ colliders: this.gizmos.colliders, gameplay: this.gizmos.gameplay });
    this.stampGizmoCounts();
    this.requestRender();
  }

  /** The drawn helper counts on the view element (tests read them). */
  private stampGizmoCounts(): void {
    const c = this.helpers.blockHelpers();
    this.root.setAttribute('data-collider-outlines', String(c.colliders));
    this.root.setAttribute('data-mover-paths', String(c.moverPaths.length));
    this.root.setAttribute('data-capsule-outlines', String(c.capsules));
    this.root.setAttribute('data-gizmos', (Object.keys(this.gizmos) as (keyof typeof this.gizmos)[]).filter((k) => this.gizmos[k]).join(' '));
  }

  /** The icon billboards (kept square on screen across resizes). */
  private readonly sprites = new Set<THREE.Sprite>();

  private addIcon(group: THREE.Group, entityId: string, kind: IconKind): void {
    const sprite = makeIconSprite(kind, () => this.requestRender());
    sprite.name = entityId;
    (sprite as { entityId?: string }).entityId = entityId;
    sprite.userData['iconKind'] = kind;
    sprite.visible = this.gizmos.icons;
    fitSprite(sprite, this.camera.aspect);
    this.sprites.add(sprite);
    group.add(sprite);
  }

  /** An entity's icon follows what it is (a component added or removed). */
  private refreshIcon(obj: THREE.Object3D, e: ProjectedEntity): void {
    const old = obj.children.find((c) => c instanceof THREE.Sprite && c.userData['iconKind'] !== undefined) as THREE.Sprite | undefined;
    if (old === undefined) return;
    const kind = iconKindFor(e, this.iconTable);
    if (old.userData['iconKind'] === kind) return;
    obj.remove(old);
    this.sprites.delete(old);
    old.material.dispose();
    this.addIcon(obj as THREE.Group, e.id, kind);
    if (this.selectedId === e.id) {
      const fresh = obj.children.find((c) => c instanceof THREE.Sprite && c.userData['iconKind'] === kind) as THREE.Sprite | undefined;
      if (fresh !== undefined) setSpriteSelected(fresh, true);
    }
  }

  private updateMesh(obj: THREE.Object3D, e: ProjectedEntity): void {
    // An inactive entity is hidden, and with it its subtree.
    obj.visible = e.active;
    this.refreshIcon(obj, e);
    obj.position.set(N(e.position[0]), N(e.position[1]), N(e.position[2]));
    obj.quaternion.set(N(e.rotation[0]), N(e.rotation[1]), N(e.rotation[2]), N(e.rotation[3]));
    obj.scale.set(N(e.scale[0]), N(e.scale[1]), N(e.scale[2]));
    // The box previews its authored surface color (or the
    // default blue when the component is absent) — the highlight emissive is
    // untouched (it is a separate material property).
    for (const c of obj.children) {
      // A fog volume's box follows its size and colour.
      if (c.userData['fogVolumeSize'] !== undefined && e.fogVolume !== undefined) {
        const lines = c as THREE.LineSegments;
        if (c.userData['fogVolumeSize'] !== e.fogVolume.size.join(',')) {
          lines.geometry.dispose();
          lines.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(e.fogVolume.size[0], e.fogVolume.size[1], e.fogVolume.size[2]));
          c.userData['fogVolumeSize'] = e.fogVolume.size.join(',');
        }
        (lines.material as THREE.LineBasicMaterial).color.set(e.fogVolume.color);
        continue;
      }
      const mesh = c as THREE.Mesh;
      if (e.kind !== 'box' || !(mesh instanceof THREE.Mesh) || mesh.userData.lightKind !== undefined) continue;
      this.setBoxLook(mesh, boxColor(e));
      const size = e.box?.size ?? [1, 1, 1];
      if (mesh.userData.boxSize !== size.join(',')) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
        addBoxLightmapUv(mesh.geometry);
        mesh.userData.boxSize = size.join(',');
        mesh.userData[BATCH_KEY] = { geometry: this.unitBox, scale: [size[0], size[1], size[2]] };
      }
    }
  }

  /** Dispose the node's own geometry/materials (not other entities or model instances under it). */
  private disposeMesh(obj: THREE.Object3D): void {
    const own = (obj as { entityId?: string }).entityId;
    const visit = (c: THREE.Object3D): void => {
      if (c instanceof THREE.Sprite) {
        this.sprites.delete(c);
        (c.material as THREE.Material).dispose(); // the icon textures are shared and kept
        return;
      }
      const mesh = c as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      // A project material is the library's; the mesh's own is kept aside while it is assigned.
      const mat = (mesh.userData?.['__tlSourceMaterial'] ?? (mesh as { material?: THREE.Material | THREE.Material[] }).material) as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      // A shared box material is released (freed with its last box).
      else if (mat !== undefined && mat.userData['tlBoxLook'] !== undefined) this.releaseBoxLook(mat);
      else if (mat) mat.dispose();
      for (const child of c.children) {
        if ((child as { entityId?: string }).entityId === own) visit(child);
      }
    };
    visit(obj);
    // The nodes themselves — the renderer keeps an object's render objects (pipeline,
    // bindings, uniforms) while its material stays (a project material, a shared box look).
    disposeObjectTree(obj, { skip: (c) => (c as { entityId?: string }).entityId !== own });
  }

  /** Set the selected entity (drives the gizmo + the selection's helper handles). */
  setSelected(id: string | null, mode: GizmoMode = this.gizmoMode): void {
    if (this.selectedId !== id) this.copySel = null;
    this.selectedId = id;
    this.gizmoMode = mode;
    // Only the previous and the new selection change (not every node). Lightmapped
    // copies come off while a box swaps to its highlighted material.
    this.unapplyLightmaps();
    const mark = (eid: string | null, on: boolean): void => {
      const m = eid === null ? undefined : this.meshes.get(eid);
      if (m === undefined) return;
      this.setMeshHighlight(m, on);
      // A camera's real frustum shows while it is selected.
      for (const c of m.children) if (c.userData['cameraFrustum'] !== undefined) c.visible = on;
    };
    if (this.highlightedId !== id) mark(this.highlightedId, false);
    mark(id, true);
    this.highlightedId = id;
    this.applyLightmaps();
    const frustum = id === null ? undefined : this.meshes.get(id)?.children.find((c) => c.userData['cameraFrustum'] !== undefined);
    this.root.setAttribute('data-camera-frustum', frustum === undefined ? '' : JSON.stringify(frustum.userData['cameraFrustum']));
    // A virtual camera's preview (where its rig puts it) shows while it is selected.
    this.showVirtualCameraPreview();
    // A selected copy of an instance set takes the gizmo.
    this.syncCopyProxy();
    // No gizmo on a folder (no transform) or a locked entity.
    const movable = id !== null && !this.folderIds.has(id) && this.hierarchyFlags.get(id)?.locked !== true;
    const target = this.copySel !== null && this.copyProxy.parent !== null ? this.copyProxy : id && movable ? this.targetFor(id) : null;
    if (id && target) {
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      this.gizmo.setMode(mode);
      this.gizmoTargetId = id;
    } else {
      this.gizmo.detach();
      this.gizmoTargetId = null;
    }
    this.helpers.setSelected(id);
    this.render();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.render();
  }

  /** The shared box material for a colour (highlighted: the selection tint), counted. */
  private takeBoxLook(color: number, highlighted: boolean): THREE.MeshLambertMaterial {
    const key = `${color}|${highlighted ? 1 : 0}`;
    let rec = this.boxLooks.get(key);
    if (rec === undefined) {
      const material = new THREE.MeshLambertMaterial({ color, emissive: highlighted ? SELECTION_HIGHLIGHT_EMISSIVE : 0x000000 });
      material.userData['tlBoxLook'] = { color, highlighted, key };
      rec = { material, refs: 0 };
      this.boxLooks.set(key, rec);
    }
    rec.refs += 1;
    return rec.material;
  }

  private releaseBoxLook(material: THREE.Material): void {
    const key = (material.userData['tlBoxLook'] as { key: string } | undefined)?.key;
    const rec = key === undefined ? undefined : this.boxLooks.get(key);
    if (rec === undefined || rec.material !== material) return;
    rec.refs -= 1;
    if (rec.refs > 0) return;
    this.boxLooks.delete(key!);
    material.dispose();
  }

  /**
   * Put a box on the shared material for its colour and selection. With a
   * project material on, the kept-aside own material is swapped (the library restores it).
   */
  private setBoxLook(mesh: THREE.Mesh, color: number, highlight?: boolean): void {
    const data = mesh.userData as Record<string, unknown>;
    const own = (data['__tlSourceMaterial'] ?? mesh.material) as THREE.Material;
    const look = own.userData?.['tlBoxLook'] as { color: number; highlighted: boolean } | undefined;
    // Not on a box look (a lightmapped copy is on while lightmaps are applied): left alone.
    if (look === undefined) return;
    const highlighted = highlight ?? look.highlighted;
    if (look.color === color && look.highlighted === highlighted) return;
    const next = this.takeBoxLook(color, highlighted);
    if (data['__tlSourceMaterial'] !== undefined) data['__tlSourceMaterial'] = next;
    else mesh.material = next;
    this.releaseBoxLook(own);
  }

  private setMeshHighlight(obj: THREE.Object3D, on: boolean): void {
    // The entity's own helpers only — a child entity's node below it keeps its own
    // state (the full pass this replaced ended the same way: each node was set for its own id).
    const visit = (c: THREE.Object3D): void => {
      const owner = (c as { entityId?: string }).entityId;
      if (c !== obj && owner !== undefined && this.meshes.get(owner) === c) return;
      this.highlightOne(c, on);
      for (const child of c.children) visit(child);
    };
    visit(obj);
  }

  private highlightOne(c: THREE.Object3D, on: boolean): void {
    {
      if (c instanceof THREE.Sprite) {
        setSpriteSelected(c, on, () => this.requestRender());
        return;
      }
      // Only the entity's own meshes (a box's material): a model's
      // materials and project materials are shared by every placement.
      const mesh = c as THREE.Mesh;
      if ((mesh as { entityId?: string }).entityId === undefined || mesh.userData['__tlSourceMaterial'] !== undefined) return;
      // A box swaps to the highlighted twin of its shared material.
      const look = (mesh.material as THREE.Material | undefined)?.userData?.['tlBoxLook'] as { color: number } | undefined;
      if (look !== undefined) this.setBoxLook(mesh, look.color, on);
      else setSelectionHighlight(mesh.material, on);
    }
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
    const rect = this.root.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const pickables: THREE.Object3D[] = [];
    for (const m of this.meshes.values()) if (m.visible) pickables.push(m);
    if (this.models) {
      for (const id of this.meshes.keys()) {
        const holder = this.models.instanceFor(id);
        if (holder) pickables.push(holder);
      }
    }
    const hits = this.raycaster.intersectObjects(pickables, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const id = (o as { entityId?: string }).entityId;
        if (id && this.meshes.has(id)) {
          // Hidden or locked entities are not pickable (try the next hit).
          const f = this.hierarchyFlags.get(id);
          if (f === undefined || (f.active && !f.locked)) return id;
          break;
        }
        o = o.parent;
      }
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
  }

  private unbindCanvasEvents(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.root.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    this.root.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    this.root.removeEventListener('contextmenu', this.onContextMenu);
  }

  private onContextMenu = (e: Event): void => e.preventDefault();
  private onWindowResize = (): void => this.resize();

  /** A handle drag is in flight (the overlay holds the previewed shape). */
  private handleDragging = false;

  /** An in-flight brush stroke on an instance set (world points, their preview dots). */
  private brushStroke: { entityId: string; points: THREE.Vector3[]; dots: THREE.Group } | null = null;

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
    // Armed block tools take the left button (not over a gizmo handle).
    if (this.blockEditorInst?.isActive() === true && this.gizmo.axis === null && this.blockEditorInst.pointerDown(e)) {
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
    // The brush paints copies onto the selected instance set (not while the gizmo is under the pointer).
    if (this.brush !== null && this.brush === this.selectedId && this.gizmo.axis === null) {
      e.stopImmediatePropagation();
      const dots = new THREE.Group();
      this.scene.add(dots);
      this.brushStroke = { entityId: this.brush, points: [], dots };
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      this.brushAt(e.clientX, e.clientY);
      return;
    }
  };

  /** Add a brush point (the surface under the pointer), at least the brush spacing from the others. */
  private brushAt(clientX: number, clientY: number): void {
    const s = this.brushStroke;
    if (s === null) return;
    const [x, y, z] = this.dropPoint(clientX, clientY);
    const p = new THREE.Vector3(x, y, z);
    if (s.points.some((q) => q.distanceTo(p) < BRUSH_SPACING_M)) return;
    s.points.push(p);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0x7fe0a0, depthTest: false }));
    dot.position.copy(p);
    dot.renderOrder = 12;
    s.dots.add(dot);
    this.requestRender();
  }

  private endBrush(cancel: boolean): void {
    const s = this.brushStroke;
    this.brushStroke = null;
    if (s === null) return;
    s.dots.removeFromParent();
    s.dots.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh === true) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    this.requestRender();
    const node = this.meshes.get(s.entityId);
    if (cancel || node === undefined || s.points.length === 0) return;
    node.updateWorldMatrix(true, false);
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    this.cb.onBrushStroke?.(s.entityId, s.points.map((p) => {
      const l = node.worldToLocal(p.clone());
      return [round(l.x), round(l.y), round(l.z)] as [number, number, number];
    }));
  }

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
    if (this.brushStroke !== null) {
      e.stopImmediatePropagation();
      this.brushAt(e.clientX, e.clientY);
      return;
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
    if (this.brushStroke !== null) {
      e.stopImmediatePropagation();
      this.orbit.enabled = true;
      this.endBrush(false);
      return;
    }
    // A left click (no drag, not on a gizmo handle) picks or deselects.
    if (e.button !== 0 || down === null || this.draggingGizmo || this.gizmo.axis !== null) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    // With an instance set selected, a click on one of its copies selects that copy.
    const sel = this.selectedId;
    if (sel !== null && this.projected.find((x) => x.id === sel)?.instances !== undefined) {
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
  /** Which component shows which icon (from the descriptors). */
  private iconTable: IconTable = [];
  private brush: string | null = null;
  private copySel: { entityId: string; index: number } | null = null;
  private readonly copyProxy = new THREE.Object3D();
  private copyHighlight: THREE.Box3Helper | null = null;

  /** The component descriptors: the handles and the objects' icons come from them. */
  setDescriptors(reg: DescriptorRegistry | null): void {
    this.helpers.setHandleSources(reg, (id) => this.meshes.get(id) ?? null);
    this.iconTable = iconTableOf(reg);
    for (const e of this.projected) {
      const m = this.meshes.get(e.id);
      if (m !== undefined) this.refreshIcon(m, e);
    }
    this.requestRender();
  }

  /** The project's physics dimension (handles of the other dimension are not shown). */
  setPhysicsDimension(dimension: 2 | 3): void {
    this.helpers.setPhysicsDimension(dimension);
    this.requestRender();
  }

  /** The game view's aspect (width / height): the cameras' frustums use it. */
  setGameAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0 || Math.abs(aspect - this.gameAspect) < 1e-3) return;
    this.gameAspect = aspect;
    for (const e of this.projected) {
      const m = this.meshes.get(e.id);
      if (e.kind === 'camera' && m !== undefined) this.redecorate(m as THREE.Group, e);
    }
    this.requestRender();
  }

  /** The brush paints copies onto this instance set (null: off). */
  setBrush(entityId: string | null): void {
    this.brush = entityId;
    if (entityId === null && this.brushStroke !== null) this.endBrush(true);
    this.root.setAttribute('data-brush', entityId ?? '');
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

  /** Put the gizmo's stand-in on the selected copy (from the stored buffer; `reset` also redraws the copy there). */
  private syncCopyProxy(reset = false): void {
    const sel = this.copySel;
    const e = sel === null ? undefined : this.projected.find((x) => x.id === sel.entityId);
    if (sel !== null && (e?.instances === undefined || sel.index >= e.instances.count)) this.copySel = null;
    const now = this.copySel;
    const node = now === null ? undefined : this.meshes.get(now.entityId);
    if (now === null || node === undefined) {
      this.copyProxy.removeFromParent();
      this.updateCopyHighlight();
      return;
    }
    // A buffer still loading keeps the stand-in where it is (the drag left it at the stored transform).
    const floats = e?.instances !== undefined ? this.models?.instanceBuffer(e.instances.buffer) : undefined;
    const t = floats === undefined ? null : copyAt(floats, now.index);
    if (this.copyProxy.parent !== node) node.add(this.copyProxy);
    if (t !== null) {
      this.copyProxy.position.set(...t.position);
      this.copyProxy.quaternion.set(...t.rotation);
      this.copyProxy.scale.set(...t.scale);
      if (reset) this.models?.previewCopy(now.entityId, now.index, [...t.position, ...t.rotation, ...t.scale]);
    }
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
    const set = this.models?.instanceSet(sel.entityId) ?? null;
    set?.group.updateWorldMatrix(true, true);
    const box = set?.copyBox(sel.index) ?? null;
    if (box === null) return;
    this.copyHighlight = new THREE.Box3Helper(box, 0xffe27a);
    this.copyHighlight.raycast = () => undefined;
    this.scene.add(this.copyHighlight);
  }

  /** The copy of an instance set under the pointer, or null. */
  private pickCopy(clientX: number, clientY: number, entityId: string): number | null {
    const meshes = this.models?.instanceSetMeshes(entityId) ?? [];
    if (meshes.length === 0) return null;
    const rect = this.root.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    this.scene.updateMatrixWorld(true);
    const set = this.models?.instanceSet(entityId) ?? null;
    for (const h of this.raycaster.intersectObjects([...meshes], false)) {
      if (h.instanceId === undefined) continue;
      const copy = set?.copyOf(h.object, h.instanceId) ?? null;
      if (copy !== null) return copy;
    }
    return null;
  }

  /** Where the copies of an instance set are on screen (the middle of each drawn copy; tests click them). */
  copyClientPoints(entityId: string): { index: number; x: number; y: number }[] {
    const set = this.models?.instanceSet(entityId) ?? null;
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
    const node = this.meshes.get(entityId);
    if (node === undefined || this.models === null) return null;
    this.scene.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    node.matrixWorld.decompose(pos, quat, new THREE.Vector3());
    const angle = new THREE.Euler().setFromQuaternion(quat, 'ZYX').z;
    const toFrame = new THREE.Matrix4().makeRotationZ(angle).setPosition(pos).invert();
    const out: { x: number; y: number }[] = [];
    const v = new THREE.Vector3();
    const addMesh = (mesh: THREE.Mesh): void => {
      const attr = mesh.geometry.getAttribute('position');
      if (attr === undefined) return;
      const m = new THREE.Matrix4().multiplyMatrices(toFrame, mesh.matrixWorld);
      // At most ~50k points per mesh (the hull only needs the extremes).
      const stride = Math.max(1, Math.ceil(attr.count / 50_000));
      for (let i = 0; i < attr.count; i += stride) {
        v.fromBufferAttribute(attr, i).applyMatrix4(m);
        out.push({ x: v.x, y: v.y });
      }
    };
    const visit = (o: THREE.Object3D): void => {
      const id = (o as { entityId?: string }).entityId;
      if (id !== undefined && this.meshes.get(id) === o) {
        this.models!.instanceFor(id)?.traverse((c) => {
          if ((c as THREE.Mesh).isMesh === true && c.visible) addMesh(c as THREE.Mesh);
        });
      }
      for (const c of o.children) visit(c);
    };
    visit(node);
    return out.length === 0 ? null : out;
  }

  /** Frame every entity (the whole level) from the current view direction. */
  frameAll(entities: readonly ProjectedEntity[]): void {
    const box = new THREE.Box3();
    for (const e of entities) {
      if (e.kind !== 'box' && e.kind !== 'model') continue; // lights/cameras are markers, not content
      const m = this.meshes.get(e.id);
      if (m) box.expandByPoint(m.getWorldPosition(new THREE.Vector3()));
      if (m && e.kind === 'box') box.expandByObject(m);
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const sp of this.sprites) fitSprite(sp, this.camera.aspect);
    const renderer = this.rendererHandle.current();
    renderer?.setSize(w, h, false);
    renderer?.setPixelRatio(window.devicePixelRatio);
    this.environment?.resize(w, h);
    this.requestRender();
  }

  /**
   * The project environment (sky, fog, fog volumes, post) in the
   * Scene view — with game lighting only (the editor rig shows the plain view).
   */
  private environment: EnvironmentRenderer | null = null;
  private environmentValue: EnvironmentLike | null = null;
  /** The scene's directional light direction (the procedural sky's sun). */
  private keyLightDirection: readonly [number, number, number] | null = null;
  /** The texture loader of the environment (null until an environment was set). */
  private environmentSource: ((assetId: string) => Promise<THREE.Texture | null>) | null = null;
  setEnvironment(value: EnvironmentLike | null, loadTexture: (assetId: string) => Promise<THREE.Texture | null>): void {
    this.environmentValue = value;
    this.environmentSource = loadTexture;
    // Built for the current renderer (null while WebGPURenderer initialises; the first frame builds it).
    const env = this.ensureEnvironment();
    env?.set(this.lighting === 'game' ? value : null);
    env?.setQuality(this.editorQuality());
    // A previewed blend follows edited presets.
    if (this.envPreview !== null) this.applyEnvironmentPreview();
    this.requestRender();
  }
  /**
   * With the editor rig (no project look) the Scene view still
   * draws at the project's quality level — MSAA is the level's choice (low:
   * none); null in game lighting (the environment's own level applies) or
   * when the project sets none.
   */
  private editorQuality(): 'low' | 'medium' | 'high' | null {
    return this.lighting === 'editor' ? (this.environmentValue?.quality ?? null) : null;
  }

  private fogVolumesNow(): FogVolumeLike[] {
    const out: FogVolumeLike[] = [];
    const p = new THREE.Vector3();
    for (const [id, fv] of this.fogVolumeData) {
      const obj = this.meshes.get(id);
      if (obj === undefined || this.hierarchyFlags.get(id)?.active === false) continue;
      obj.getWorldPosition(p);
      out.push({ center: [p.x, p.y, p.z], size: fv.size, density: fv.density, color: fv.color, ...(fv.falloff !== undefined ? { falloff: fv.falloff } : {}), ...(fv.heightFalloff !== undefined ? { heightFalloff: fv.heightFalloff } : {}) });
    }
    return out;
  }
  private fogVolumeData = new Map<string, NonNullable<ProjectedEntity['fogVolume']>>();

  dispose(): void {
    this.blockEditorInst?.dispose();
    this.blockEditorInst = null;
    this.releaseEffectPreview();
    this.lightmaps.dispose();
    for (const { light, parent } of this.sceneLights.values()) {
      parent.remove(light);
      light.dispose();
    }
    this.sceneLights.clear();
    this.copyHighlight?.removeFromParent();
    this.copyHighlight?.dispose();
    this.copyHighlight = null;
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    for (const m of this.meshes.values()) {
      m.parent?.remove(m);
      this.disposeMesh(m);
    }
    this.meshes.clear();
    this.helpers.dispose();
    this.unbindCanvasEvents();
    window.removeEventListener('resize', this.onWindowResize);
    this.gizmo.detach();
    this.gizmo.dispose();
    disposeOrbitControls(this.orbit);
    this.disposeMesh(this.ground);
    this.environment?.dispose();
    this.environment = null;
    this.rendererHandle.dispose();
    this.batcher.dispose();
    this.unitBox.dispose();
    for (const rec of this.boxLooks.values()) rec.material.dispose();
    this.boxLooks.clear();
  }
}

/** The three.js light for an authored light (the editor's "game lighting"). */
function makeSceneLight(l: NonNullable<ProjectedEntity['light']>): THREE.Light {
  const colour = new THREE.Color(l.color);
  switch (l.type) {
    case 'ambient':
      return new THREE.AmbientLight(colour, l.intensity);
    case 'hemisphere':
      return new THREE.HemisphereLight(colour, new THREE.Color(l.groundColor ?? '#444444'), l.intensity);
    case 'point':
      return new THREE.PointLight(colour, l.intensity, l.range ?? 0, l.decay ?? 2);
    case 'spot': {
      const s = new THREE.SpotLight(colour, l.intensity, l.range ?? 0, THREE.MathUtils.degToRad(l.angle ?? 30), l.penumbra ?? 0.2, l.decay ?? 2);
      // At its entity's origin (three starts a SpotLight at (0, 1, 0)), shining along `direction`.
      s.position.set(0, 0, 0);
      const d = l.direction ?? [0, -1, 0];
      s.target.position.set(d[0], d[1], d[2]);
      return s;
    }
    default: {
      const d = l.direction ?? [0, -1, 0];
      const dl = new THREE.DirectionalLight(colour, l.intensity);
      dl.position.set(-d[0] * 20, -d[1] * 20, -d[2] * 20);
      return dl;
    }
  }
}

/**
 * A virtual camera's preview in world space — the frustum where
 * its rig puts it (drawn out to the pivot it looks at, at most its far plane)
 * and a line to that pivot.
 */
function virtualCameraFrustum(id: string, pose: CameraPose, aspect: number, reach: number): THREE.LineSegments {
  const fov = (pose.fovY * Math.PI) / 180;
  const q = new THREE.Quaternion(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  const eye = new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]);
  const d = Math.max(0.5, Math.min(pose.far, reach));
  const h = Math.tan(fov / 2) * d;
  const w = h * aspect;
  const corner = (x: number, y: number): THREE.Vector3 => new THREE.Vector3(x, y, -d).applyQuaternion(q).add(eye);
  const c = [corner(-w, -h), corner(w, -h), corner(w, h), corner(-w, h)];
  const centre = new THREE.Vector3(0, 0, -d).applyQuaternion(q).add(eye);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pts.push(eye, c[i]!, c[i]!, c[(i + 1) % 4]!);
  pts.push(eye, centre);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.85, depthTest: false }));
  lines.name = `virtual-camera-frustum:${id}`;
  lines.userData['virtualCameraFrustum'] = { id, position: [...pose.position], rotation: [...pose.rotation], fovY: pose.fovY, aspect };
  lines.renderOrder = 10;
  lines.raycast = () => undefined;
  return lines;
}

/**
 * A camera's real frustum in its own space (it looks down −Z):
 * the near and far rectangles and the edges from the eye, from its fovY,
 * near and far and the game's aspect.
 */
function cameraFrustum(e: ProjectedEntity, aspect: number): THREE.LineSegments {
  const c = (e.components['camera'] ?? {}) as { fovY?: number; near?: number; far?: number };
  const fov = ((c.fovY ?? 60) * Math.PI) / 180;
  const near = c.near ?? 0.1;
  const far = c.far ?? 100;
  const rectAt = (d: number): THREE.Vector3[] => {
    const h = Math.tan(fov / 2) * d;
    const w = h * aspect;
    return [new THREE.Vector3(-w, -h, -d), new THREE.Vector3(w, -h, -d), new THREE.Vector3(w, h, -d), new THREE.Vector3(-w, h, -d)];
  };
  const n = rectAt(near);
  const f = rectAt(far);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pts.push(n[i]!, n[(i + 1) % 4]!, f[i]!, f[(i + 1) % 4]!, new THREE.Vector3(0, 0, 0), f[i]!);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf2b544, transparent: true, opacity: 0.6 }));
  lines.name = `camera-frustum:${e.id}`;
  lines.userData['cameraFrustum'] = { fovY: c.fovY ?? 60, near, far, aspect };
  // Drawn only: its long lines never take a click meant for what is behind them.
  lines.raycast = () => undefined;
  return lines;
}

/** A point light's reach (three circles) or a spot light's cone, as lines. */
function lightGizmo(e: ProjectedEntity): THREE.LineSegments {
  const l = e.light!;
  const pts: THREE.Vector3[] = [];
  const reach = l.range !== undefined && l.range > 0 ? l.range : 3;
  if (l.type === 'point') {
    const n = 32;
    for (const axis of [0, 1, 2]) {
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2;
        const b = ((i + 1) / n) * Math.PI * 2;
        const at = (t: number): THREE.Vector3 => (axis === 0 ? new THREE.Vector3(0, Math.cos(t), Math.sin(t)) : axis === 1 ? new THREE.Vector3(Math.cos(t), 0, Math.sin(t)) : new THREE.Vector3(Math.cos(t), Math.sin(t), 0)).multiplyScalar(reach);
        pts.push(at(a), at(b));
      }
    }
  } else {
    const d = new THREE.Vector3(...(l.direction ?? [0, -1, 0])).normalize();
    const half = THREE.MathUtils.degToRad(l.angle ?? 30);
    const r = Math.tan(half) * reach;
    const side = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(d, side).normalize();
    const v = new THREE.Vector3().crossVectors(d, u).normalize();
    const centre = d.clone().multiplyScalar(reach);
    const n = 24;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const b = ((i + 1) / n) * Math.PI * 2;
      const p = (t: number): THREE.Vector3 => centre.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r);
      pts.push(p(a), p(b));
      if (i % 6 === 0) pts.push(new THREE.Vector3(0, 0, 0), p(a));
    }
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.55 }));
  lines.name = e.id;
  (lines as { entityId?: string }).entityId = e.id;
  lines.userData = { lightKind: l.type };
  return lines;
}
