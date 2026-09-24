/**
 * Authoring viewport (packet 10) — imperative three.js, framework-free.
 *
 * The three.js scene graph, camera controls, and picking live OUTSIDE React
 * (decision 0001 §10: React never instantiates or mutates Object3Ds). The
 * viewport renders the browser's PROJECTION of the backend scene; it never
 * mutates the scene itself — scene mutation flows only through editing
 * commands (the client). A gizmo gesture previews transforms locally (the
 * Object3D moves under the drag) and the commit is ONE undoable command.
 *
 * Browser-only: uses the DOM (canvas, events) + WebGL via three.js.
 */

import {
  addBoxLightmapUv,
  createEnvironmentRenderer,
  lightmappedMaterial,
  lightmapTexture,
  refreshLightmappedMaterial,
  type BakeLightInput,
  type BakeMeshInput,
  type EnvironmentLike,
  type EnvironmentRenderer,
  type FogVolumeLike,
  type LightingBakeLike,
  type MaterialLibrary,
} from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { ProjectedEntity } from '../session/projection';
import { effectiveFlagsOf, type EffectiveEntityFlags } from '../session/hierarchy';
import { clampScale, SNAP_ROTATE_RAD, SNAP_SCALE, SNAP_TRANSLATE_M } from '../session/snapping';
import { ZoneOverlay, type SizeHandleRef, type ZoneTool } from './zone-overlay';
import { sizeEdit, type SizeShape } from '../session/size-handles';
import { fitSprite, iconKindFor, makeIconSprite, setSpriteSelected, type IconKind } from './icons';
import type { ModelInstances } from './model-instances';

export interface ViewportCallbacks {
  onPick: (entityId: string | null) => void;
  onGestureBegin: (entityId: string) => void;
  onGestureFrame: (entityId: string, transform: { position: number[]; rotation: number[]; scale: number[] }) => void;
  onGestureEnd: (entityId: string, transform: { position: number[]; rotation: number[]; scale: number[] }) => void;
  /**
   * M3 (packet 56): zone gesture routing. The overlay begins the gesture on
   * a consumed pointer down (create from the placement tool; move/resize
   * from a zone body / its resize handle); the frames carry the pointer's
   * game-plane WORLD hits (the App owns the pure ZoneGesture decisions and
   * the single commit command).
   */
  onZoneGestureBegin: (
    g: { kind: 'create'; tool: ZoneTool; anchor: { x: number; y: number } }
      | { kind: 'move'; entityId: string; anchor: { x: number; y: number } }
      | { kind: 'resize'; entityId: string; anchor: { x: number; y: number } },
  ) => void;
  onZoneGestureFrame: (hit: { x: number; y: number }) => void;
  onZoneGestureEnd: (hit: { x: number; y: number }) => void;
  onZoneGestureCancel: () => void;
  /** Phase 9.12: a mover waypoint handle was dragged and dropped (its new offset from the mover). */
  onWaypointMoved?: (entityId: string, index: number, offset: [number, number, number]) => void;
  /** Phase 14.0: a size handle was dragged and dropped — the component value to store (one setComponent). */
  onSizeHandleMoved?: (entityId: string, component: string, value: Record<string, unknown>) => void;
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
  private readonly renderer: THREE.WebGLRenderer;
  private readonly root: HTMLCanvasElement;
  private readonly meshes = new Map<string, THREE.Object3D>();
  private readonly cb: ViewportCallbacks;
  private selectedId: string | null = null;
  /** Phase 12: effective flags from the last sync (inactive = hidden, locked = not pickable/movable). */
  private hierarchyFlags: ReadonlyMap<string, EffectiveEntityFlags> = new Map();
  private folderIds = new Set<string>();
  private gizmoMode: GizmoMode = 'translate';
  /** The packet-27 model realization path (shared with the asset browser). */
  private models: ModelInstances | null = null;
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  /** M3 (packet 56): the imperative zone/spawn/cameraFollow overlay. */
  private readonly zones: ZoneOverlay;
  /** Phase 9.12: which helpers the Scene view draws (the Gizmos menu). */
  private gizmos = { icons: true, lights: true, colliders: true, gameplay: true };
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly snapping: () => boolean;
  private gizmoTargetId: string | null = null;
  /** A gizmo drag is in flight (between TransformControls mouseDown/mouseUp). */
  private draggingGizmo = false;
  /** Esc during a gizmo drag: the object is reset and the release commits nothing. */
  private gizmoCancelled = false;
  /** M3 (packet 56): a zone gesture is in flight (the overlay consumed the down). */
  private draggingZone = false;
  private downAt: { x: number; y: number } | null = null;
  private renderQueued = false;
  private readonly raycaster = new THREE.Raycaster();

  constructor(canvas: HTMLCanvasElement, cb: ViewportCallbacks, options: { snapping?: () => boolean } = {}) {
    this.root = canvas;
    this.cb = cb;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.scene.background = new THREE.Color(0x14161c);

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

    this.zones = new ZoneOverlay(this.scene, this.camera, canvas);

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
      this.cb.onGestureBegin(id);
    });
    this.gizmo.addEventListener('objectChange', () => {
      const id = this.gizmoTargetId;
      if (this.draggingGizmo && id && !this.gizmoCancelled) this.cb.onGestureFrame(id, this.readTarget());
    });
    this.gizmo.addEventListener('mouseUp', () => {
      const id = this.gizmoTargetId;
      const cancelled = this.gizmoCancelled;
      this.draggingGizmo = false;
      this.gizmoCancelled = false;
      if (id && !cancelled) this.cb.onGestureEnd(id, this.readTarget());
    });
    this.scene.add(this.gizmo.getHelper());

    this.camera.position.set(6, 5, 6);
    this.orbit.update();
    this.bindEvents();
    this.resize();
  }

  /** Install the model realization path (packet 27). */
  setModelInstances(models: ModelInstances | null): void {
    this.models = models;
  }

  // ---- Phase 9.6: lightmaps ----------------------------------------------------
  /** The last synced entities (the bake reads them). */
  private projected: readonly ProjectedEntity[] = [];
  private lightmapEntries = new Map<string, { bake: LightingBakeLike; atlas: string; scaleOffset: readonly number[] }>();
  private bakedLightIds = new Set<string>();
  private loadAtlas: ((assetId: string) => Promise<THREE.Texture | null>) | null = null;
  private atlasTextures = new Map<string, THREE.Texture | null | 'loading'>();
  /** Per entity: its lightmap texture and the lightmapped copy of each original material. */
  private lightmapCopies = new Map<string, { map: THREE.Texture; atlas: THREE.Texture; copies: Map<THREE.Material, THREE.Material | null> }>();
  private lightmapSwapped: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; copy: THREE.Material | THREE.Material[] }[] = [];

  /** The project's bakes (sceneId → bake); null clears them. */
  setLightmaps(bakes: Readonly<Record<string, LightingBakeLike>> | null, loadTexture: (assetId: string) => Promise<THREE.Texture | null>): void {
    this.unapplyLightmaps();
    for (const rec of this.lightmapCopies.values()) {
      rec.map.dispose();
      for (const c of rec.copies.values()) c?.dispose();
    }
    this.lightmapCopies.clear();
    this.lightmapEntries.clear();
    this.bakedLightIds.clear();
    for (const bake of Object.values(bakes ?? {})) {
      for (const id of bake.bakedLights) this.bakedLightIds.add(id);
      for (const e of bake.entries) {
        const atlas = bake.atlases[e.atlas];
        if (atlas === undefined) continue;
        this.lightmapEntries.set(e.entityId, { bake, atlas, scaleOffset: e.scaleOffset });
      }
    }
    // A re-bake publishes new versions of the same atlas assets: load them all again.
    for (const t of this.atlasTextures.values()) if (t !== null && t !== 'loading') t.dispose();
    this.atlasTextures.clear();
    this.loadAtlas = loadTexture;
    // The light set changes with the bakes (held lights leave realtime).
    for (const [id, have] of [...this.sceneLights]) {
      have.parent.remove(have.light);
      have.light.dispose();
      this.sceneLights.delete(id);
    }
    this.syncSceneLights(this.projected);
    this.applyLightmaps();
    this.render();
  }

  private unapplyLightmaps(): void {
    for (const s of this.lightmapSwapped) if (s.mesh.material === s.copy) s.mesh.material = s.original;
    this.lightmapSwapped = [];
  }

  /** Swap the lightmapped copies in (game lighting only); cheap when nothing changed. */
  private applyLightmaps(): void {
    if (this.lighting !== 'game' || this.lightmapEntries.size === 0) return;
    const ambientBaked = (bake: LightingBakeLike): boolean =>
      bake.bakedLights.some((id) => {
        const t = this.projected.find((e) => e.id === id)?.light?.type;
        return t === 'ambient' || t === 'hemisphere';
      });
    for (const [entityId, entry] of this.lightmapEntries) {
      const atlas = this.atlasTexture(entry.atlas);
      if (atlas === null) continue;
      const root = this.models?.instanceFor(entityId) ?? this.meshes.get(entityId) ?? null;
      if (root === null) continue;
      let rec = this.lightmapCopies.get(entityId);
      if (rec !== undefined && rec.atlas !== atlas) {
        rec.map.dispose();
        for (const c of rec.copies.values()) c?.dispose();
        rec = undefined;
      }
      if (rec === undefined) {
        rec = { map: lightmapTexture(atlas, entry.scaleOffset), atlas, copies: new Map() };
        this.lightmapCopies.set(entityId, rec);
      }
      const r = rec;
      const ignoreAmbient = ambientBaked(entry.bake);
      const visit = (o: THREE.Object3D): void => {
        // Another entity's node below this one keeps its own lightmap.
        const owner = (o as { entityId?: string }).entityId;
        if (o !== root && owner !== undefined && owner !== entityId) return;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh === true && mesh.geometry.getAttribute('uv1') !== undefined) {
          const original = mesh.material;
          const list = Array.isArray(original) ? original : [original];
          const copies = list.map((m) => {
            if (!r.copies.has(m)) r.copies.set(m, lightmappedMaterial(m, r.map, entry.bake.range, ignoreAmbient));
            const c = r.copies.get(m) ?? null;
            if (c !== null) refreshLightmappedMaterial(c, m);
            return c ?? m;
          });
          if (copies.some((c, i) => c !== list[i])) {
            const copy = Array.isArray(original) ? copies : copies[0]!;
            mesh.material = copy;
            this.lightmapSwapped.push({ mesh, original, copy });
          }
        }
        for (const c of o.children) visit(c);
      };
      visit(root);
    }
  }

  private atlasTexture(assetId: string): THREE.Texture | null {
    const have = this.atlasTextures.get(assetId);
    if (have === 'loading') return null;
    if (have !== undefined) return have;
    const load = this.loadAtlas;
    if (load === null) return null;
    this.atlasTextures.set(assetId, 'loading');
    void load(assetId)
      .catch(() => null)
      .then((t) => {
        if (this.atlasTextures.get(assetId) !== 'loading') {
          t?.dispose();
          return;
        }
        this.atlasTextures.set(assetId, t);
        this.unapplyLightmaps();
        this.applyLightmaps();
        this.requestRender();
      });
    return null;
  }

  /** A model instance arrived or left: its lightmap goes on (the viewport re-renders anyway). */
  refreshLightmaps(): void {
    this.unapplyLightmaps();
    this.applyLightmaps();
  }

  /**
   * What a bake of these entities needs, in world space: each static object's
   * meshes (with UV1: a lightmap target; without: a shadow caster only) and
   * the baked lights. Models use their most detailed level.
   */
  bakeInputs(entityIds: ReadonlySet<string>): {
    targets: { entityId: string; meshes: BakeMeshInput[]; area: number; box: { size: readonly number[]; scale: readonly number[] } | null }[];
    occluders: BakeMeshInput[];
    missingUv: string[];
    lights: (BakeLightInput & { entityId: string; mode: 'baked' | 'mixed' })[];
  } {
    this.unapplyLightmaps();
    this.scene.updateMatrixWorld(true);
    const targets: { entityId: string; meshes: BakeMeshInput[]; area: number; box: { size: readonly number[]; scale: readonly number[] } | null }[] = [];
    const occluders: BakeMeshInput[] = [];
    const missingUv: string[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const worldArea = (g: THREE.BufferGeometry, m: THREE.Matrix4): number => {
      const pos = g.getAttribute('position');
      const index = g.getIndex();
      const n = index !== null ? index.count : pos.count;
      let area = 0;
      for (let i = 0; i + 2 < n; i += 3) {
        const i0 = index !== null ? index.getX(i) : i;
        const i1 = index !== null ? index.getX(i + 1) : i + 1;
        const i2 = index !== null ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        area += b.sub(a).cross(c.sub(a)).length() / 2;
      }
      return area;
    };
    for (const e of this.projected) {
      if (!entityIds.has(e.id)) continue;
      const root = e.kind === 'model' ? this.models?.instanceFor(e.id) ?? null : e.kind === 'box' ? this.meshes.get(e.id) ?? null : null;
      if (root === null) continue;
      const meshes: BakeMeshInput[] = [];
      let noUv = false;
      let area = 0;
      const visit = (o: THREE.Object3D): void => {
        const owner = (o as { entityId?: string }).entityId;
        if (o !== root && owner !== undefined && owner !== e.id) return;
        // Only the most detailed level of a LOD takes part.
        if ((o as THREE.LOD).isLOD === true) {
          const first = (o as THREE.LOD).levels[0]?.object;
          if (first !== undefined) visit(first);
          return;
        }
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh === true && (mesh as THREE.SkinnedMesh).isSkinnedMesh !== true) {
          const m = { geometry: mesh.geometry, matrixWorld: mesh.matrixWorld.clone() };
          if (mesh.geometry.getAttribute('uv1') !== undefined) {
            meshes.push(m);
            area += worldArea(mesh.geometry, mesh.matrixWorld);
          } else {
            occluders.push(m);
            noUv = true;
          }
        }
        for (const ch of o.children) visit(ch);
      };
      visit(root);
      if (noUv && meshes.length === 0) missingUv.push(e.id);
      if (meshes.length > 0) targets.push({ entityId: e.id, meshes, area, box: e.kind === 'box' ? { size: e.box?.size ?? [1, 1, 1], scale: e.scale } : null });
    }
    const lights: (BakeLightInput & { entityId: string; mode: 'baked' | 'mixed' })[] = [];
    for (const e of this.projected) {
      const l = e.light;
      if (l === undefined || e.active === false || (l.mode !== 'baked' && l.mode !== 'mixed')) continue;
      const node = this.meshes.get(e.id);
      const p = new THREE.Vector3();
      node?.getWorldPosition(p);
      let direction = l.direction as readonly [number, number, number] | undefined;
      if (l.type === 'spot' && node !== undefined && l.direction !== undefined) {
        const d = new THREE.Vector3(...l.direction).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).normalize();
        direction = [d.x, d.y, d.z];
      }
      lights.push({
        entityId: e.id,
        mode: l.mode,
        type: l.type,
        color: l.color,
        intensity: l.intensity,
        position: [p.x, p.y, p.z],
        ...(direction !== undefined ? { direction } : {}),
        ...(l.range !== undefined ? { range: l.range } : {}),
        ...(l.decay !== undefined ? { decay: l.decay } : {}),
        ...(l.angle !== undefined ? { angle: l.angle } : {}),
        ...(l.penumbra !== undefined ? { penumbra: l.penumbra } : {}),
        ...(l.groundColor !== undefined ? { groundColor: l.groundColor } : {}),
      });
    }
    this.applyLightmaps();
    return { targets, occluders, missingUv, lights };
  }

  /**
   * Phase 9.5: "editor" lighting is a fixed key + fill; "game" lighting uses
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
    this.environment?.set(this.lighting === 'game' ? this.environmentValue : null);
    for (const l of this.editorLights) l.visible = this.lighting === 'editor';
    for (const { light } of this.sceneLights.values()) light.visible = this.lighting === 'game' && light.userData['tlActive'] !== false;
    this.render();
  }
  private syncSceneLights(entities: readonly ProjectedEntity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      const l = e.light;
      // Phase 9.6: a light a bake holds is not realtime (ambient/hemisphere stay for dynamic objects).
      if (l === undefined || (l.mode === 'baked' && l.type !== 'ambient' && l.type !== 'hemisphere' && this.bakedLightIds.has(e.id))) continue;
      seen.add(e.id);
      const key = JSON.stringify(l);
      const group = this.meshes.get(e.id);
      if (group === undefined) continue;
      let have = this.sceneLights.get(e.id);
      if (have !== undefined && have.key !== key) {
        have.parent.remove(have.light);
        if (have.light instanceof THREE.SpotLight || have.light instanceof THREE.DirectionalLight) have.parent.remove(have.light.target);
        have.light.dispose();
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
      }
      have.light.userData['tlActive'] = this.hierarchyFlags.get(e.id)?.active !== false;
    }
    for (const [id, have] of [...this.sceneLights]) {
      if (seen.has(id)) continue;
      have.parent.remove(have.light);
      have.light.dispose();
      this.sceneLights.delete(id);
    }
    // The sun of a procedural sky sits opposite the scene's directional light.
    const key = entities.find((e) => e.light?.type === 'directional' && e.light.direction !== undefined);
    this.environment?.setKeyLightDirection(key?.light?.direction ?? null);
    this.fogVolumeData = new Map(entities.filter((e) => e.fogVolume !== undefined).map((e) => [e.id, e.fogVolume!]));
    const lightingBefore = this.lighting;
    if (!this.lightingChosen) this.lighting = this.sceneLights.size > 0 ? 'game' : 'editor';
    if (lightingBefore !== this.lighting) this.applyLighting();
    else {
      for (const l of this.editorLights) l.visible = this.lighting === 'editor';
      for (const { light } of this.sceneLights.values()) light.visible = this.lighting === 'game' && light.userData['tlActive'] !== false;
    }
  }

  /** Phase 9.4: project materials on boxes (models get theirs through ModelInstances). */
  private materialLibrary: MaterialLibrary | null = null;
  private readonly boxMaterials = new Map<string, { key: string; undo: () => void }>();
  setMaterialLibrary(library: MaterialLibrary | null): void {
    this.materialLibrary = library;
  }

  private syncBoxMaterial(e: ProjectedEntity, obj: THREE.Object3D): void {
    const lib = this.materialLibrary;
    const mapping = e.kind === 'box' ? (e.materials ?? null) : null;
    const key = mapping === null ? '' : JSON.stringify(mapping);
    const have = this.boxMaterials.get(e.id);
    if (have !== undefined && have.key === key) return;
    have?.undo();
    this.boxMaterials.delete(e.id);
    if (lib === null || mapping === null) return;
    const mesh = obj.children.find((c) => (c as THREE.Mesh).isMesh && (c as { entityId?: string }).entityId === e.id);
    if (mesh === undefined) return;
    this.boxMaterials.set(e.id, { key, undo: lib.apply(mesh, mapping) });
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
   * Phase 14.0 ("Fit to model"): the bounding box of the models drawn for
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
    const step = this.snapping() ? SNAP_TRANSLATE_M : 0.001;
    const snap = (v: number): number => {
      const r = Math.round(v / step) * step;
      return Math.abs(r) < 1e-9 ? 0 : Number(r.toFixed(3));
    };
    return [snap(p.x), snap(p.y), snap(p.z)];
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

  /** Schedule one render on the next animation frame (coalesces bursts). */
  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      // Phase 14.0: where the size handles are on screen (tests drag them).
      this.root.setAttribute('data-size-handles', JSON.stringify(this.zones.sizeHandleClientPoints()));
      if (this.environment !== null && this.lighting === 'game') {
        this.environment.setFogVolumes(this.fogVolumesNow());
        this.environment.render(this.camera);
      } else this.renderer.render(this.scene, this.camera);
    });
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
    this.gizmo.setTranslationSnap(on ? SNAP_TRANSLATE_M : null);
    this.gizmo.setRotationSnap(on ? SNAP_ROTATE_RAD : null);
    this.gizmo.setScaleSnap(on ? SNAP_SCALE : null);
  }

  /** M3 (packet 56): arm/clear a zone placement tool (the panel's action). */
  setZoneTool(tool: ZoneTool | null): void {
    this.zones.setTool(tool);
  }

  /** M3 (packet 56): the live zone placement tool, when armed. */
  getZoneTool(): ZoneTool | null {
    return this.zones.activeTool;
  }

  /** M3 (packet 56): render/clear the zone gesture preview at a pose. */
  previewZonePose(pose: { position: [number, number, number]; size: [number, number] } | null, isSpawn = false, role?: 'hazard' | 'checkpoint' | 'goal' | 'exit'): void {
    this.zones.setPreviewPose(pose, isSpawn, role);
    this.render();
  }

  /** Cancel an in-flight gizmo gesture (Esc): revert, send nothing. */
  cancelGesture(): boolean {
    // M3 (packet 56): a zone gesture cancels through the overlay (the App
    // reverts its preview from `onZoneGestureCancel`; nothing is sent).
    if (this.draggingZone) {
      this.draggingZone = false;
      if (this.zones.cancel()) {
        this.cb.onZoneGestureCancel();
        this.render();
        return true;
      }
    }
    if (!this.draggingGizmo || this.gizmoCancelled) return false;
    this.gizmo.reset();
    this.gizmoCancelled = true;
    this.render();
    return true;
  }

  /** Sync the entity set from the projection (add/remove/update meshes). */
  syncEntities(entities: ProjectedEntity[]): void {
    // Phase 9.6: the original materials are in place while the rest of the sync runs.
    this.unapplyLightmaps();
    this.projected = entities;
    this.hierarchyFlags = effectiveFlagsOf(entities);
    this.folderIds = new Set(entities.filter((e) => e.kind === 'folder').map((e) => e.id));
    const seen = new Set<string>();
    for (const e of entities) {
      seen.add(e.id);
      // Model entities are realized by the packet-26/27 resource path; the
      // viewport holds a hidden placeholder so picking + the gizmo keep a
      // stable target while the GLB resolves asynchronously.
      let m = this.meshes.get(e.id);
      if (!m) {
        m = this.buildMesh(e);
        this.meshes.set(e.id, m);
        this.scene.add(m);
      } else if (!(this.draggingGizmo && e.id === this.gizmoTargetId)) {
        // A gizmo drag owns its target's transform until release.
        this.updateMesh(m, e);
      }
      this.syncBoxMaterial(e, m);
    }
    // Mirror the runtime scene graph: children hang under their parent node
    // (transforms are parent-relative, as in the play renderer).
    for (const e of entities) {
      const m = this.meshes.get(e.id);
      if (!m) continue;
      const parent = (e.parentId !== null ? this.meshes.get(e.parentId) : undefined) ?? this.scene;
      if (m.parent !== parent) parent.add(m);
    }
    // Remove meshes whose entities are gone.
    for (const [id, m] of this.meshes) {
      if (!seen.has(id)) {
        this.boxMaterials.get(id)?.undo();
        this.boxMaterials.delete(id);
        m.parent?.remove(m);
        this.disposeMesh(m);
        this.meshes.delete(id);
        if (this.selectedId === id) this.setSelected(null);
      }
    }
    this.models?.sync(entities);
    this.syncSceneLights(entities);
    // M3 (packet 56): the zone overlay syncs from the SAME projection pass
    // (phase 12: an inactive zone is hidden like any inactive object).
    this.zones.sync(entities.filter((e) => this.hierarchyFlags.get(e.id)?.active !== false));
    this.stampGizmoCounts();
    this.applyLightmaps();
    // A selection that became locked or a folder loses its gizmo.
    if (this.selectedId !== null && !this.draggingGizmo) this.setSelected(this.selectedId);
    this.render();
  }

  private buildMesh(e: ProjectedEntity): THREE.Object3D {
    const group = new THREE.Group();
    group.name = e.id;
    (group as { entityId?: string }).entityId = e.id;
    if (e.kind === 'folder') {
      // Phase 12: a folder is organisation only — an empty node at the origin
      // its children hang under (it has no transform of its own).
      this.updateMesh(group, e);
      return group;
    }
    if (e.kind === 'model') {
      // A whole-GLB placement is realized by the packet-26 resource path; the
      // placeholder only anchors picking/selection until the bytes resolve.
      // It carries the entity transform (the realized model hangs under it).
      this.updateMesh(group, e);
      return group;
    }
    if (e.kind === 'box') {
      // M3 (packet 57): an authored `surface` color previews on the box in the
      // editor viewport (the play renderer realizes the full material from the
      // same component; the editor shows the copied color only).
      const size = e.box?.size ?? [1, 1, 1];
      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      addBoxLightmapUv(geometry);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: boxColor(e) }));
      mesh.userData.boxSize = size.join(',');
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
      // Phase 9.5: a point light shows its reach, a spot light its cone.
      if ((e.light.type === 'point' || e.light.type === 'spot') && e.light.mode !== 'baked') {
        const g = lightGizmo(e);
        g.userData['gizmo'] = 'light';
        g.visible = this.gizmos.lights;
        group.add(g);
      }
      this.addIcon(group, e.id, iconKindFor(e));
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
      this.addIcon(group, e.id, 'camera');
    } else {
      // An empty entity: a spawn icon when it is a player spawn, an axis cross otherwise.
      this.addIcon(group, e.id, iconKindFor(e));
      // Phase 9.5: a fog volume shows its box.
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

  /** Phase 9.12: show or hide the Scene view's helpers (icons, light ranges, collider outlines, gameplay paths and areas). */
  setGizmos(next: Partial<{ icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean }>): void {
    this.gizmos = { ...this.gizmos, ...next };
    for (const s of this.sprites) s.visible = this.gizmos.icons;
    this.scene.traverse((o) => {
      if (o.userData['gizmo'] === 'light') o.visible = this.gizmos.lights;
    });
    this.zones.setGizmos({ colliders: this.gizmos.colliders, gameplay: this.gizmos.gameplay });
    this.stampGizmoCounts();
    this.requestRender();
  }

  /** Phase 9.12: the drawn helper counts on the view element (tests read them). */
  private stampGizmoCounts(): void {
    const c = this.zones.blockHelpers();
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

  /** Phase 9.12: an entity's icon follows what it is (a component added or removed). */
  private refreshIcon(obj: THREE.Object3D, e: ProjectedEntity): void {
    const old = obj.children.find((c) => c instanceof THREE.Sprite && c.userData['iconKind'] !== undefined) as THREE.Sprite | undefined;
    if (old === undefined) return;
    const kind = iconKindFor(e);
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
    // Phase 12: an inactive entity is hidden, and with it its subtree.
    obj.visible = e.active;
    this.refreshIcon(obj, e);
    obj.position.set(N(e.position[0]), N(e.position[1]), N(e.position[2]));
    obj.quaternion.set(N(e.rotation[0]), N(e.rotation[1]), N(e.rotation[2]), N(e.rotation[3]));
    obj.scale.set(N(e.scale[0]), N(e.scale[1]), N(e.scale[2]));
    // M3 (packet 57): the box previews its authored surface color (or the
    // default blue when the component is absent) — the highlight emissive is
    // untouched (it is a separate material property).
    for (const c of obj.children) {
      // Phase 9.5: a fog volume's box follows its size and colour.
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
      const own = (mesh.userData['__tlSourceMaterial'] ?? mesh.material) as THREE.MeshLambertMaterial;
      own.color.setHex(boxColor(e));
      const size = e.box?.size ?? [1, 1, 1];
      if (mesh.userData.boxSize !== size.join(',')) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
        addBoxLightmapUv(mesh.geometry);
        mesh.userData.boxSize = size.join(',');
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
      else if (mat) mat.dispose();
      for (const child of c.children) {
        if ((child as { entityId?: string }).entityId === own) visit(child);
      }
    };
    visit(obj);
  }

  /** Set the selected entity (drives the gizmo + the zone overlay handle). */
  setSelected(id: string | null, mode: GizmoMode = this.gizmoMode): void {
    this.selectedId = id;
    this.gizmoMode = mode;
    for (const [eid, m] of this.meshes) {
      this.setMeshHighlight(m, eid === id);
    }
    // Phase 12: no gizmo on a folder (no transform) or a locked entity.
    const movable = id !== null && !this.folderIds.has(id) && this.hierarchyFlags.get(id)?.locked !== true;
    const target = id && movable ? this.targetFor(id) : null;
    if (id && target) {
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      this.gizmo.setMode(mode);
      this.gizmoTargetId = id;
    } else {
      this.gizmo.detach();
      this.gizmoTargetId = null;
    }
    this.zones.setSelected(id);
    this.render();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.render();
  }

  private setMeshHighlight(obj: THREE.Object3D, on: boolean): void {
    obj.traverse((c) => {
      if (c instanceof THREE.Sprite) {
        setSpriteSelected(c, on, () => this.requestRender());
        return;
      }
      // Only the entity's own unshared meshes (a box's material): a model's
      // materials and project materials are shared by every placement.
      const mesh = c as THREE.Mesh;
      if ((mesh as { entityId?: string }).entityId === undefined || mesh.userData['__tlSourceMaterial'] !== undefined) return;
      const mat = mesh.material as THREE.MeshLambertMaterial | undefined;
      if (mat && 'emissive' in mat) {
        mat.emissive.setHex(on ? 0x2a4a80 : 0x000000);
      }
    });
  }

  /** The entity under a pointer position (client coords), or null. */
  pickAt(clientX: number, clientY: number): string | null {
    return this.pick(clientX, clientY);
  }

  /** Pick the entity under a pointer position (client coords in the canvas). */
  private pick(clientX: number, clientY: number): string | null {
    // Phase 14.0: the player's capsule outline selects the player (before
    // whatever model is drawn over it); inside the outline it does when
    // nothing else is hit.
    const capsule = this.zones.capsuleAt(clientX, clientY);
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
          // Phase 12: hidden or locked entities are not pickable (try the next hit).
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
    // Capture phase: the zone overlay routes before the orbit/gizmo controls.
    this.root.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.root.addEventListener('pointermove', this.onPointerMove, { capture: true });
    this.root.addEventListener('pointerup', this.onPointerUp, { capture: true });
    this.root.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('resize', this.onWindowResize);
  }

  private onContextMenu = (e: Event): void => e.preventDefault();
  private onWindowResize = (): void => this.resize();

  /** Phase 9.12: an in-flight waypoint handle drag (the last previewed offset). */
  private waypointDrag: { entityId: string; index: number; offset: [number, number, number] | null } | null = null;

  /** Phase 14.0: an in-flight size handle drag (the last previewed shape). */
  private sizeDrag: { ref: SizeHandleRef; shape: SizeShape | null } | null = null;

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
    // Phase 14.0: a size handle of the selected entity drags that size (one command on release).
    const sh = this.zones.activeTool === null ? this.zones.pickSizeHandle(e.clientX, e.clientY) : null;
    if (sh !== null) {
      e.stopImmediatePropagation();
      this.sizeDrag = { ref: sh, shape: null };
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      return;
    }
    // Phase 9.12: a mover's waypoint handle drags that waypoint (one command on release).
    const wp = this.zones.activeTool === null ? this.zones.pickWaypoint(e.clientX, e.clientY) : null;
    if (wp !== null) {
      e.stopImmediatePropagation();
      this.waypointDrag = { ...wp, offset: null };
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      return;
    }
    // M3 (packet 56): a consumed pointer down drives a zone gesture
    // (create/move/resize) and skips orbit/gizmo/pick.
    const zoneDown = this.zones.pointerDown(e.clientX, e.clientY);
    if (zoneDown.consumed) {
      e.stopImmediatePropagation();
      this.draggingZone = true;
      this.orbit.enabled = false;
      this.root.setPointerCapture(e.pointerId);
      const g = zoneDown.gesture;
      if (g.kind !== 'create') this.cb.onPick(g.entityId);
      this.cb.onZoneGestureBegin(g);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.sizeDrag !== null) {
      e.stopImmediatePropagation();
      const hit = this.zones.screenToGamePlane(e.clientX, e.clientY);
      if (hit !== null) {
        this.sizeDrag.shape = this.zones.previewSize(this.sizeDrag.ref, hit, this.snapping());
        this.requestRender();
      }
      return;
    }
    if (this.waypointDrag !== null) {
      e.stopImmediatePropagation();
      const hit = this.zones.screenToGamePlane(e.clientX, e.clientY);
      if (hit !== null) {
        const snap = (v: number): number => (this.snapping() ? Math.round(v / SNAP_TRANSLATE_M) * SNAP_TRANSLATE_M : v);
        this.waypointDrag.offset = this.zones.previewWaypoint(this.waypointDrag.entityId, this.waypointDrag.index, { x: snap(hit.x), y: snap(hit.y) });
        this.requestRender();
      }
      return;
    }
    if (this.draggingZone) {
      e.stopImmediatePropagation();
      // The frame carries the pointer's game-plane WORLD hit (zero commands
      // during the drag).
      const hit = this.zones.screenToGamePlane(e.clientX, e.clientY);
      if (hit) this.cb.onZoneGestureFrame(hit);
      return;
    }
    if (this.draggingGizmo) this.applySnapping();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const down = this.downAt;
    this.downAt = null;
    if (this.sizeDrag !== null) {
      e.stopImmediatePropagation();
      const drag = this.sizeDrag;
      this.sizeDrag = null;
      this.orbit.enabled = true;
      this.zones.endSizePreview();
      this.requestRender();
      if (drag.shape !== null) {
        const edit = sizeEdit(drag.shape);
        this.cb.onSizeHandleMoved?.(drag.ref.entityId, edit.component, edit.value);
      }
      return;
    }
    if (this.waypointDrag !== null) {
      e.stopImmediatePropagation();
      const drag = this.waypointDrag;
      this.waypointDrag = null;
      this.orbit.enabled = true;
      if (drag.offset !== null) this.cb.onWaypointMoved?.(drag.entityId, drag.index, drag.offset);
      return;
    }
    if (this.draggingZone) {
      e.stopImmediatePropagation();
      const hit = this.zones.screenToGamePlane(e.clientX, e.clientY);
      this.draggingZone = false;
      this.orbit.enabled = true;
      this.zones.pointerUp();
      if (hit) this.cb.onZoneGestureEnd(hit);
      return;
    }
    // A left click (no drag, not on a gizmo handle) picks or deselects.
    if (e.button !== 0 || down === null || this.draggingGizmo || this.gizmo.axis !== null) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    this.cb.onPick(this.pick(e.clientX, e.clientY));
  };

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
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.environment?.resize(w, h);
    this.requestRender();
  }

  /**
   * Phase 9.5: the project environment (sky, fog, fog volumes, post) in the
   * Scene view — with game lighting only (the editor rig shows the plain view).
   */
  private environment: EnvironmentRenderer | null = null;
  private environmentValue: EnvironmentLike | null = null;
  setEnvironment(value: EnvironmentLike | null, loadTexture: (assetId: string) => Promise<THREE.Texture | null>): void {
    this.environmentValue = value;
    if (this.environment === null) {
      this.environment = createEnvironmentRenderer(this.renderer, this.scene, { loadTexture, onChange: () => this.requestRender() });
      this.environment.resize(Math.max(1, this.root.clientWidth || this.root.width), Math.max(1, this.root.clientHeight || this.root.height));
    }
    this.environment.set(this.lighting === 'game' ? value : null);
    this.requestRender();
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
    for (const m of this.meshes.values()) {
      m.parent?.remove(m);
      this.disposeMesh(m);
    }
    this.meshes.clear();
    this.zones.dispose();
    this.root.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.root.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    this.root.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('resize', this.onWindowResize);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.disposeMesh(this.ground);
    this.renderer.dispose();
  }
}

/** Phase 9.5: the three.js light for an authored light (the editor's "game lighting"). */
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

/** Phase 9.5: a point light's reach (three circles) or a spot light's cone, as lines. */
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
