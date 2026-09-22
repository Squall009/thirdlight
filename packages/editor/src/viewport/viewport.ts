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

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { ProjectedEntity } from '../session/projection';
import { clampScale, SNAP_ROTATE_RAD, SNAP_SCALE, SNAP_TRANSLATE_M } from '../session/snapping';
import { ZoneOverlay, type ZoneTool } from './zone-overlay';
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
  private gizmoMode: GizmoMode = 'translate';
  /** The packet-27 model realization path (shared with the asset browser). */
  private models: ModelInstances | null = null;
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  /** M3 (packet 56): the imperative zone/spawn/cameraFollow overlay. */
  private readonly zones: ZoneOverlay;
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
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.6));

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

  /** The Object3D a gizmo/selection targets: the entity's node in the scene graph. */
  private targetFor(id: string): THREE.Object3D | null {
    return this.meshes.get(id) ?? null;
  }

  /** The entity's scene-graph node (model instances attach under it). */
  objectFor(id: string): THREE.Object3D | null {
    return this.meshes.get(id) ?? null;
  }

  /** Where the camera is looking (new entities spawn here). */
  focusPoint(): [number, number, number] {
    const t = this.orbit.target;
    return [t.x, t.y, t.z];
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
      this.renderer.render(this.scene, this.camera);
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
  previewZonePose(pose: { position: [number, number, number]; size: [number, number] } | null, isSpawn = false, role?: 'hazard' | 'checkpoint' | 'goal'): void {
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
        m.parent?.remove(m);
        this.disposeMesh(m);
        this.meshes.delete(id);
        if (this.selectedId === id) this.setSelected(null);
      }
    }
    this.models?.sync(entities);
    // M3 (packet 56): the zone overlay syncs from the SAME projection pass.
    this.zones.sync(entities);
    this.render();
  }

  private buildMesh(e: ProjectedEntity): THREE.Object3D {
    const group = new THREE.Group();
    group.name = e.id;
    (group as { entityId?: string }).entityId = e.id;
    if (e.kind === 'model') {
      // A whole-GLB placement is realized by the packet-26 resource path; the
      // placeholder only anchors picking/selection until the bytes resolve.
      return group;
    }
    if (e.kind === 'box') {
      // M3 (packet 57): an authored `surface` color previews on the box in the
      // editor viewport (the play renderer realizes the full material from the
      // same component; the editor shows the copied color only).
      const size = e.box?.size ?? [1, 1, 1];
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size[0], size[1], size[2]),
        new THREE.MeshLambertMaterial({ color: boxColor(e) }),
      );
      mesh.userData.boxSize = size.join(',');
      mesh.name = e.id;
      (mesh as { entityId?: string }).entityId = e.id;
      group.add(mesh);
    } else if (e.light !== undefined) {
      // M3 (packet 57): a light entity previews as a directional arrow (a line
      // along `direction`) or a small sphere (ambient).
      if (e.light.type === 'directional' && e.light.direction !== undefined) {
        const d = e.light.direction;
        const len = 2;
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(d[0] * len, d[1] * len, d[2] * len),
        ]);
        const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xffe08a }));
        line.name = e.id;
        (line as { entityId?: string }).entityId = e.id;
        (line as { userData?: unknown }).userData = { lightKind: 'directional' };
        group.add(line);
      } else {
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(0.18, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xffe08a }),
        );
        sphere.name = e.id;
        (sphere as { entityId?: string }).entityId = e.id;
        (sphere as { userData?: unknown }).userData = { lightKind: 'ambient' };
        group.add(sphere);
      }
    } else {
      // Cameras render as a small frustum marker (non-pickable body + label cone).
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 0.7, 12),
        new THREE.MeshBasicMaterial({ color: 0xffc857 }),
      );
      cone.rotation.x = Math.PI / 2;
      cone.name = e.id;
      (cone as { entityId?: string }).entityId = e.id;
      group.add(cone);
    }
    this.updateMesh(group, e);
    return group;
  }

  private updateMesh(obj: THREE.Object3D, e: ProjectedEntity): void {
    obj.position.set(N(e.position[0]), N(e.position[1]), N(e.position[2]));
    obj.quaternion.set(N(e.rotation[0]), N(e.rotation[1]), N(e.rotation[2]), N(e.rotation[3]));
    obj.scale.set(N(e.scale[0]), N(e.scale[1]), N(e.scale[2]));
    // M3 (packet 57): the box previews its authored surface color (or the
    // default blue when the component is absent) — the highlight emissive is
    // untouched (it is a separate material property).
    for (const c of obj.children) {
      const mesh = c as THREE.Mesh;
      if (e.kind !== 'box' || !(mesh instanceof THREE.Mesh) || mesh.userData.lightKind !== undefined) continue;
      (mesh.material as THREE.MeshLambertMaterial).color.setHex(boxColor(e));
      const size = e.box?.size ?? [1, 1, 1];
      if (mesh.userData.boxSize !== size.join(',')) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
        mesh.userData.boxSize = size.join(',');
      }
    }
  }

  /** Dispose the node's own geometry/materials (not other entities or model instances under it). */
  private disposeMesh(obj: THREE.Object3D): void {
    const own = (obj as { entityId?: string }).entityId;
    const visit = (c: THREE.Object3D): void => {
      const mesh = c as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
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
    const target = id ? this.targetFor(id) : null;
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
      const mesh = c as THREE.Mesh;
      const mat = mesh.material as THREE.MeshLambertMaterial | undefined;
      if (mat && 'emissive' in mat) {
        mat.emissive.setHex(on ? 0x2a4a80 : 0x000000);
      }
    });
  }

  /** Pick the entity under a pointer position (client coords in the canvas). */
  private pick(clientX: number, clientY: number): string | null {
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
        if (id && this.meshes.has(id)) return id;
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

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
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
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.requestRender();
  }

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