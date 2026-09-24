/**
 * Imperative zone overlay (packet 56; authoring.md §A8 rows 6–10/12) —
 * three.js, framework-free.
 *
 * The overlay renders the projected gameplay values (zones as semi-transparent
 * rectangles on the z=0 game plane, spawn markers, the cameraFollow bounds),
 * routes pointer events (zone picking, placement-tool anchoring, resize-handle
 * hit-testing), and reports every pointer position as a game-plane WORLD hit
 * (the pointer ray ∩ the z=0 plane — the 2D side-view game lives in XY, z is
 * view depth). The DECISIONS live in the pure {@link ZoneGesture} (the App
 * owns it: it captures the base pose from the projection at gesture start,
 * feeds the world deltas, and issues the single commit command on release —
 * zero commands during the gesture, one on release, none on cancel). The
 * overlay previews the pose the App hands it (`setPreviewPose`); it never
 * sends anything itself.
 */

import * as THREE from 'three';
import type { ProjectedEntity } from '../session/projection';
import type { ZonePose } from '../session/zone-gesture';
import type { ZoneRole } from '../session/gameplay';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { capsuleDistance, capsuleShapeOf, outlinePoints, type SizeShape } from '../session/size-handles';
import { deletePoint, dragGrip, gripsOf, handleShapesOf, insertPoint, linesOf, type Grip, type HandleShape, type P3 } from '../session/handles';

/** Phase 15.2: a grip under the pointer (which handle shape of which entity, which grip). */
export interface HandleRef {
  entityId: string;
  shapeIndex: number;
  grip: string;
  role: Grip['role'];
}

/** The collider outline colour (phase 9.12); the player's capsule uses it too. */
const COLLIDER_COLOR = 0x7cfc00;
const SIZE_HANDLE_COLOR = 0xffffff;

export type ZoneTool = { kind: 'zone'; role: ZoneRole; safeSpawnId?: string } | { kind: 'spawn' };

/** A pointer position converted to the z=0 game plane (world x/y). */
export interface GamePlaneHit {
  x: number;
  y: number;
}

/** The overlay's answer to a pointer down. */
export type OverlayPointerDown =
  | {
      consumed: true;
      /** The gesture the overlay began (the App builds the ZoneGesture). */
      gesture: { kind: 'create'; tool: ZoneTool; anchor: GamePlaneHit }
        | { kind: 'move'; entityId: string; anchor: GamePlaneHit }
        | { kind: 'resize'; entityId: string; anchor: GamePlaneHit };
    }
  | { consumed: false };

const ZONE_COLORS: Record<ZoneRole, number> = {
  hazard: 0xd42a1e,
  checkpoint: 0x2fd47f,
  goal: 0x2f7fd4,
  exit: 0xc86bff,
};
const SPAWN_COLOR = 0xffc857;
/** Phase 9.9: gameplay block helpers (mover paths, trigger/switch/enemy/pickup areas). */
const BLOCK_COLORS = { mover: 0xffa53a, trigger: 0x3ad7ff, switch: 0xff5a8c, enemy: 0xb05aff, pickup: 0xf2c230, audioSource: 0x7fe0a0 } as const;
const CAMERA_FOLLOW_COLOR = 0x9aa7ff;
/** The z=0 game plane (the 2D side-view game coordinates are XY). */
const GAME_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/** Safe numeric read (positions are always 3-element). */
const N = (v: number | undefined): number => v ?? 0;

/**
 * The imperative zone overlay. Owns a group in the viewport's scene; the
 * viewport delegates pointer events to it FIRST (a consumed pointer down
 * drives a zone gesture and skips the orbit/pick path) and calls `sync`
 * whenever the projection changes.
 */
export class ZoneOverlay {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly root: THREE.Group;
  /** The live zone/spawn/bounds objects, keyed by entity id. */
  private readonly objects = new Map<string, THREE.Group>();
  /** The selected zone's resize handle (SE corner), when shown. */
  private resizeHandle: THREE.Mesh | null = null;
  /** The in-flight gesture preview mesh (created via `setPreviewPose`). */
  private previewMesh: THREE.Mesh | null = null;
  private selectedId: string | null = null;
  private tool: ZoneTool | null = null;
  /** Whether a gesture is in flight (pointer down consumed, not yet up/cancel). */
  managing = false;
  private readonly raycaster = new THREE.Raycaster();
  /** Phase 9.9: the gameplay block helpers, rebuilt on every sync. */
  private readonly blocks = new THREE.Group();
  /** Phase 9.12: every collider's 2D outline (the Gizmos menu toggles them). */
  private readonly colliders = new THREE.Group();
  /** Phase 14.0: the entities of the last sync (the handles read the selected one). */
  private entities: readonly ProjectedEntity[] = [];
  /** Phase 14.0: each player's capsule (drawn with the collider outlines, clickable). */
  private readonly capsules = new Map<string, { shape: SizeShape; z: number }>();
  /** Phase 15.2: the selected entity's handle grips, its handle outlines and the drag preview. */
  private readonly sizeHandles = new THREE.Group();
  private readonly handleOutlines = new THREE.Group();
  private handleShapes: HandleShape[] = [];
  private handleFrames: THREE.Matrix4[] = [];
  private handleDrag: { shapeIndex: number; grip: string; shape: HandleShape; moved: boolean } | null = null;
  private handlePreview: THREE.Group | null = null;
  /** Phase 15.2: the descriptors (the handles come from them) and each entity's scene node (its frame). */
  private registry: DescriptorRegistry | null = null;
  private nodeFor: (entityId: string) => THREE.Object3D | null = () => null;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.root = new THREE.Group();
    this.root.name = 'zone-overlay';
    this.blocks.name = 'block-overlay';
    this.root.add(this.blocks);
    this.colliders.name = 'collider-outlines';
    this.root.add(this.colliders);
    this.sizeHandles.name = 'size-handles';
    this.root.add(this.sizeHandles);
    this.handleOutlines.name = 'handle-outlines';
    this.root.add(this.handleOutlines);
    scene.add(this.root);
  }

  /** Arm a placement tool (the panel's "add zone/spawn" action). */
  setTool(tool: ZoneTool | null): void {
    this.tool = tool;
  }

  get activeTool(): ZoneTool | null {
    return this.tool;
  }

  /** Select a zone entity (shows the resize handle for zones). */
  setSelected(id: string | null): void {
    this.selectedId = id;
    this.updateResizeHandle();
    this.updateSizeHandles();
  }

  /**
   * The pointer position's game-plane hit (world x/y), or `null` when the
   * ray misses the plane (the App treats a miss as a no-op frame).
   */
  screenToGamePlane(clientX: number, clientY: number): GamePlaneHit | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(GAME_PLANE, hit)) return null;
    return { x: hit.x, y: hit.y };
  }

  /**
   * A pointer down. In placement mode the overlay always begins a `create`
   * gesture (the anchor is the plane hit, or the canvas center when the ray
   * misses). Otherwise it hit-tests the resize handle, then the zone bodies
   * (topmost first): a zone body begins a `move` gesture; the resize handle
   * begins a `resize` gesture. A non-zone pointer down is NOT consumed (the
   * viewport's orbit/pick path runs).
   */
  pointerDown(clientX: number, clientY: number): OverlayPointerDown {
    const hit = this.screenToGamePlane(clientX, clientY) ?? { x: 0, y: 0 };
    if (this.tool) {
      this.managing = true;
      return { consumed: true, gesture: { kind: 'create', tool: this.tool, anchor: hit } };
    }
    if (this.resizeHandle && this.hitTest(clientX, clientY, this.resizeHandle)) {
      const id = this.selectedId;
      if (id) {
        this.managing = true;
        return { consumed: true, gesture: { kind: 'resize', entityId: id, anchor: hit } };
      }
    }
    const zoneId = this.pickZone(clientX, clientY);
    if (zoneId) {
      this.managing = true;
      return { consumed: true, gesture: { kind: 'move', entityId: zoneId, anchor: hit } };
    }
    return { consumed: false };
  }

  /**
   * A pointer up. Ends the in-flight gesture (the App reads the last move
   * hit and decides the commit); the preview mesh is cleared.
   */
  pointerUp(): void {
    if (this.managing) {
      this.managing = false;
      this.setPreviewPose(null);
    }
  }

  /** Cancel the in-flight gesture (Esc): the App clears the preview + reverts. */
  cancel(): boolean {
    if (!this.managing) return false;
    this.managing = false;
    this.setPreviewPose(null);
    return true;
  }

  /**
   * Render (or clear) the gesture preview at a pose. The App feeds the
   * ZoneGesture's local preview each pointer move; `null` clears.
   */
  setPreviewPose(pose: ZonePose | null, isSpawn = false, role?: ZoneRole): void {
    if (this.previewMesh) {
      this.root.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      (this.previewMesh.material as THREE.Material).dispose();
      this.previewMesh = null;
    }
    if (!pose) return;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: isSpawn ? SPAWN_COLOR : role ? ZONE_COLORS[role] : 0xffffff,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.position.set(pose.position[0], pose.position[1], 0.02);
    mesh.scale.set(pose.size[0], pose.size[1], 1);
    this.root.add(mesh);
    this.previewMesh = mesh;
  }

  /** Sync the overlay from the projection (add/update/remove). */
  sync(entities: readonly ProjectedEntity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      if (e.gameZone === undefined && e.playerSpawn === undefined && e.cameraFollow === undefined) continue;
      seen.add(e.id);
      let g = this.objects.get(e.id);
      if (!g || this.kindSignature(e) !== (g as { __sig?: string }).__sig) {
        if (g) {
          this.root.remove(g);
          this.disposeGroup(g);
          this.objects.delete(e.id);
        }
        g = this.buildObject(e);
        (g as { __sig?: string }).__sig = this.kindSignature(e);
        this.objects.set(e.id, g);
        this.root.add(g);
      } else {
        this.updateObject(g, e);
      }
    }
    for (const [id, g] of this.objects) {
      if (!seen.has(id)) {
        this.root.remove(g);
        this.disposeGroup(g);
        this.objects.delete(id);
        if (this.selectedId === id) this.setSelected(null);
      }
    }
    this.updateResizeHandle();
    this.syncBlocks(entities);
    this.entities = entities;
    this.updateSizeHandles();
  }

  /**
   * Phase 9.9: a mover's path (a line through its stops, a dot per stop) and
   * the outline of each trigger, switch, enemy and sized pickup area.
   */
  private syncBlocks(entities: readonly ProjectedEntity[]): void {
    for (const c of [...this.blocks.children]) {
      this.blocks.remove(c);
      this.disposeGroup(c as THREE.Group);
    }
    for (const c of [...this.colliders.children]) {
      this.colliders.remove(c);
      this.disposeGroup(c as THREE.Group);
    }
    // Phase 9.12: every collider's outline on the game plane (box or polygon, turned about Z).
    for (const e of entities) {
      const shape = (e.collider as { shape?: { type: string; hx?: number; hy?: number; vertices?: number[][] } } | undefined)?.shape;
      if (shape === undefined) continue;
      const corners = shape.type === 'box' ? [[-N(shape.hx), -N(shape.hy)], [N(shape.hx), -N(shape.hy)], [N(shape.hx), N(shape.hy)], [-N(shape.hx), N(shape.hy)]] : (shape.vertices ?? []);
      if (corners.length < 2) continue;
      const q = e.rotation;
      const angle = 2 * Math.atan2(N(q[2]), N(q[3]));
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const pts = [...corners, corners[0]!].map(([a, b]) => new THREE.Vector3(N(e.position[0]) + N(a) * cos - N(b) * sin, N(e.position[1]) + N(a) * sin + N(b) * cos, 0.03));
      const oneWay = (e.collider as { oneWay?: boolean }).oneWay === true;
      const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: oneWay ? 0x8fb573 : COLLIDER_COLOR, depthTest: false, transparent: true, opacity: 0.85 }));
      outline.name = `collider-outline:${e.id}`;
      outline.renderOrder = 9;
      this.colliders.add(outline);
    }
    // Phase 14.0: the player's capsule (its own, or the default one), in the collider colour.
    this.capsules.clear();
    for (const e of entities) {
      if (e.controller !== true) continue;
      const shape = capsuleShapeOf(e);
      if (shape === null) continue;
      const z = N(e.position[2]) + 0.03;
      const outline = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(outlinePoints(shape, 16).map((p) => new THREE.Vector3(p.x, p.y, z))),
        new THREE.LineBasicMaterial({ color: COLLIDER_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      outline.name = `capsule-outline:${e.id}`;
      outline.renderOrder = 9;
      this.colliders.add(outline);
      this.capsules.set(e.id, { shape, z });
    }
    const rect = (x: number, y: number, w: number, h: number, color: number): THREE.Line => {
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new THREE.Vector3(x + (a! * w) / 2, y + (b! * h) / 2, 0.02));
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 0.2, gapSize: 0.1 })).computeLineDistances();
    };
    for (const e of entities) {
      const b = e.blocks;
      if (b === undefined) continue;
      const x = N(e.position[0]);
      const y = N(e.position[1]);
      const z = N(e.position[2]);
      const mover = b.mover as { waypoints?: number[][]; mode?: string } | undefined;
      if (mover?.waypoints !== undefined) {
        const stops = [[0, 0, 0], ...mover.waypoints].map((p) => new THREE.Vector3(x + N(p[0]), y + N(p[1]), z + N(p[2])));
        if (mover.mode === 'loop') stops.push(stops[0]!.clone());
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(stops), new THREE.LineBasicMaterial({ color: BLOCK_COLORS.mover, depthTest: false }));
        line.name = `mover-path:${e.id}`;
        line.renderOrder = 10;
        this.blocks.add(line);
        // A dot per stop (phase 15.2: the selected mover's stops get grips from its path handle).
        const count = mover.waypoints.length + 1;
        for (let i = 0; i < count; i++) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: BLOCK_COLORS.mover, depthTest: false }));
          dot.position.copy(stops[i]!);
          dot.renderOrder = 11;
          this.blocks.add(dot);
        }
      }
      // Phase 14.2: a circle trigger's outline (dashed, in the trigger colour).
      const trig = b.trigger as { shape?: string; radius?: number } | undefined;
      if (trig?.shape === 'circle' && typeof trig.radius === 'number') {
        const pts = outlinePoints({ kind: 'circle', center: { x, y }, half: { x: trig.radius, y: trig.radius } } as SizeShape, 24).map((p) => new THREE.Vector3(p.x, p.y, 0.02));
        const circle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: BLOCK_COLORS.trigger, dashSize: 0.2, gapSize: 0.1 })).computeLineDistances();
        circle.name = `trigger-circle:${e.id}`;
        this.blocks.add(circle);
      }
      for (const k of ['trigger', 'switch', 'enemy', 'pickup'] as const) {
        const size = (b[k] as { size?: number[] } | undefined)?.size;
        // An enemy's box stands on its position (its feet), as the runtime tests it (phase 14.0 fix).
        if (size !== undefined) this.blocks.add(rect(x, k === 'enemy' ? y + N(size[1]) / 2 : y, N(size[0]), N(size[1]), BLOCK_COLORS[k]));
      }
      // Phase 9.10: an audio source's hearing range along X (full volume in the inner quarter).
      const sound = b.audioSource as { range?: number } | undefined;
      if (sound?.range !== undefined) {
        this.blocks.add(rect(x, y, sound.range * 2, 0.4, BLOCK_COLORS.audioSource));
        this.blocks.add(rect(x, y, sound.range / 2, 0.4, BLOCK_COLORS.audioSource));
      }
      // Phase 15.2: an enemy's chase distance — the band it notices the player in (x ± chase, feet ± chase height).
      const enemy = b.enemy as { chase?: number; chaseHeight?: number } | undefined;
      if (enemy !== undefined && typeof enemy.chase === 'number' && enemy.chase > 0) {
        const hh = typeof enemy.chaseHeight === 'number' ? enemy.chaseHeight : 2;
        const band = rect(x, y, enemy.chase * 2, hh * 2, BLOCK_COLORS.enemy);
        band.name = `enemy-chase:${e.id}`;
        const mat = band.material as THREE.LineDashedMaterial;
        mat.transparent = true;
        mat.opacity = 0.5;
        this.blocks.add(band);
      }
      const range = (b.enemy as { range?: number[] } | undefined)?.range;
      if (range !== undefined) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x + N(range[0]), y, 0.02), new THREE.Vector3(x + N(range[1]), y, 0.02)]),
          new THREE.LineBasicMaterial({ color: BLOCK_COLORS.enemy }),
        );
        this.blocks.add(line);
      }
    }
  }

  /** Phase 9.9: the drawn gameplay helpers (names of the mover paths), for tests. */
  blockHelpers(): { moverPaths: string[]; count: number; colliders: number; capsules: number; sizeHandles: number; chaseBands: number } {
    return {
      moverPaths: this.blocks.children.filter((c) => c.name.startsWith('mover-path:')).map((c) => c.name.slice(11)),
      count: this.blocks.children.length,
      colliders: this.colliders.children.length,
      capsules: this.capsules.size,
      sizeHandles: this.sizeHandles.children.length,
      chaseBands: this.blocks.children.filter((c) => c.name.startsWith('enemy-chase:')).length,
    };
  }

  /** Phase 9.12: the Gizmos menu's collider outlines and gameplay helpers. */
  setGizmos(g: { colliders: boolean; gameplay: boolean }): void {
    this.colliders.visible = g.colliders;
    this.blocks.visible = g.gameplay;
  }

  // ---- Phase 15.2: descriptor-driven handles ---------------------------------

  /** The descriptors (handles come from them) and how to find an entity's scene node (its frame). */
  setHandleSources(registry: DescriptorRegistry | null, nodeFor: (entityId: string) => THREE.Object3D | null): void {
    this.registry = registry;
    this.nodeFor = nodeFor;
    this.updateSizeHandles();
  }

  /** The pointer ray for a client position (false when the canvas has no size). */
  private aim(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return true;
  }

  /** A handle's frame → world matrix: world, the object's position, + rotation about Z, + rotation, or its whole transform. */
  private frameMatrix(s: HandleShape): THREE.Matrix4 {
    const m = new THREE.Matrix4();
    if (s.frame === 'world') return m;
    const node = this.nodeFor(s.entityId);
    const e = this.entities.find((x) => x.id === s.entityId);
    const pos = new THREE.Vector3(N(e?.position[0]), N(e?.position[1]), N(e?.position[2]));
    const quat = new THREE.Quaternion(N(e?.rotation[0]), N(e?.rotation[1]), N(e?.rotation[2]), e?.rotation[3] ?? 1);
    const scale = new THREE.Vector3(1, 1, 1);
    if (node !== null) {
      node.updateWorldMatrix(true, false);
      node.matrixWorld.decompose(pos, quat, scale);
      if (s.frame === 'transform') return m.copy(node.matrixWorld);
    }
    if (s.frame === 'position') return m.makeTranslation(pos.x, pos.y, pos.z);
    if (s.frame === 'rotationZ') return m.makeRotationZ(new THREE.Euler().setFromQuaternion(quat, 'ZYX').z).setPosition(pos);
    return m.compose(pos, quat, new THREE.Vector3(1, 1, 1));
  }

  private toWorld(i: number, p: P3): THREE.Vector3 {
    return new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(this.handleFrames[i] ?? new THREE.Matrix4());
  }

  private linesObject(shape: HandleShape, frame: THREE.Matrix4, color: number, opacity: number): THREE.Group {
    const g = new THREE.Group();
    for (const line of linesOf(shape)) {
      const pts = line.map((p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(frame));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity }));
      l.renderOrder = 12;
      g.add(l);
    }
    return g;
  }

  /** Rebuild the selected entity's handles: a grip per draggable point, and each handle's outline. */
  private updateSizeHandles(): void {
    // A drag in flight keeps its shapes (their indices) until it ends.
    if (this.handleDrag !== null) return;
    for (const c of [...this.sizeHandles.children, ...this.handleOutlines.children]) {
      c.removeFromParent();
      this.disposeGroup(c as THREE.Group);
    }
    this.handleShapes = [];
    this.handleFrames = [];
    const e = this.selectedId === null ? undefined : this.entities.find((x) => x.id === this.selectedId);
    if (e === undefined || !e.active || e.locked) return;
    this.handleShapes = handleShapesOf(e, this.registry);
    this.handleFrames = this.handleShapes.map((s) => this.frameMatrix(s));
    this.handleShapes.forEach((shape, shapeIndex) => {
      this.handleOutlines.add(this.linesObject(shape, this.handleFrames[shapeIndex]!, SIZE_HANDLE_COLOR, 0.35));
      this.addGrips(shape, shapeIndex);
    });
    this.scaleGrips();
  }

  private addGrips(shape: HandleShape, shapeIndex: number): void {
    for (const g of gripsOf(shape)) {
      const insert = g.role === 'insert';
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: insert ? 0x9aa4b8 : SIZE_HANDLE_COLOR, depthTest: false, transparent: insert, opacity: insert ? 0.8 : 1 }));
      mesh.position.copy(this.toWorld(shapeIndex, g.at));
      mesh.renderOrder = 13;
      mesh.name = `handle:${shape.component}:${shape.kind}:${g.id}`;
      mesh.userData = { entityId: shape.entityId, shapeIndex, grip: g.id, role: g.role, size: insert ? 0.65 : 1 };
      this.sizeHandles.add(mesh);
    }
  }

  /** Grips keep about the same size on screen (roughly 1/50 of the view height across). */
  scaleGrips(): void {
    const cam = this.camera.position;
    const k = Math.tan((this.camera.fov * Math.PI) / 360) * 0.02;
    for (const m of this.sizeHandles.children) {
      const r = Math.max(0.02, m.position.distanceTo(cam) * k) * N(m.userData['size'] as number | undefined);
      m.scale.setScalar(r);
    }
  }

  /** The grip under the pointer, or null. */
  pickHandle(clientX: number, clientY: number): HandleRef | null {
    if (this.sizeHandles.children.length === 0 || !this.aim(clientX, clientY)) return null;
    this.scaleGrips();
    this.root.updateMatrixWorld(true);
    const hits = this.raycaster.intersectObjects(this.sizeHandles.children, false);
    // A corner or size grip wins over an "insert" grip behind it.
    const hit = hits.find((h) => h.object.userData['role'] !== 'insert') ?? hits[0];
    if (hit === undefined) return null;
    const d = hit.object.userData as { entityId: string; shapeIndex: number; grip: string; role: Grip['role'] };
    return { entityId: d.entityId, shapeIndex: d.shapeIndex, grip: d.grip, role: d.role };
  }

  /** Start dragging a grip (an "insert" grip first adds its new corner). */
  beginHandleDrag(ref: HandleRef): boolean {
    const shape = this.handleShapes[ref.shapeIndex];
    if (shape === undefined || shape.entityId !== ref.entityId) return false;
    if (ref.role === 'insert') {
      const made = insertPoint(shape, ref.grip);
      if (made === null) return false;
      this.handleDrag = { shapeIndex: ref.shapeIndex, grip: made.grip, shape: made.shape, moved: true };
      this.previewHandle();
      return true;
    }
    this.handleDrag = { shapeIndex: ref.shapeIndex, grip: ref.grip, shape, moved: false };
    return true;
  }

  /** The frame point for a pointer while dragging a grip of shape `i` (its plane, its axis or a camera-facing plane). */
  private framePoint(i: number, grip: Grip, clientX: number, clientY: number): P3 | null {
    if (!this.aim(clientX, clientY)) return null;
    const frame = this.handleFrames[i] ?? new THREE.Matrix4();
    const at = new THREE.Vector3(grip.at.x, grip.at.y, grip.at.z).applyMatrix4(frame);
    const ray = this.raycaster.ray;
    const out = new THREE.Vector3();
    if (grip.drag === 'axis' && grip.axis !== undefined) {
      const tip = new THREE.Vector3(grip.at.x + grip.axis.x, grip.at.y + grip.axis.y, grip.at.z + grip.axis.z).applyMatrix4(frame);
      const dir = tip.sub(at).normalize();
      ray.distanceSqToSegment(at.clone().addScaledVector(dir, -1e4), at.clone().addScaledVector(dir, 1e4), undefined, out);
    } else {
      const normal = grip.drag === 'plane' ? new THREE.Vector3(0, 0, 1).transformDirection(frame) : this.camera.getWorldDirection(new THREE.Vector3());
      if (ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at), out) === null) return null;
    }
    out.applyMatrix4(frame.clone().invert());
    return { x: out.x, y: out.y, z: out.z };
  }

  /** A pointer move during a handle drag: the previewed shape follows (snapped when `snap`). */
  moveHandleDrag(clientX: number, clientY: number, snap: boolean): void {
    const d = this.handleDrag;
    if (d === null) return;
    const grip = gripsOf(d.shape).find((g) => g.id === d.grip);
    if (grip === undefined) return;
    const p = this.framePoint(d.shapeIndex, grip, clientX, clientY);
    if (p === null) return;
    d.shape = dragGrip(d.shape, d.grip, p, snap);
    d.moved = true;
    this.previewHandle();
  }

  private previewHandle(): void {
    const d = this.handleDrag;
    this.clearHandlePreview();
    if (d === null) return;
    const frame = this.handleFrames[d.shapeIndex] ?? new THREE.Matrix4();
    this.handlePreview = this.linesObject(d.shape, frame, d.shape.error !== undefined ? 0xff4a4a : SIZE_HANDLE_COLOR, 1);
    this.root.add(this.handlePreview);
    // The dragged shape's grips follow.
    for (const c of [...this.sizeHandles.children]) {
      if ((c.userData as { shapeIndex: number }).shapeIndex !== d.shapeIndex) continue;
      c.removeFromParent();
      this.disposeGroup(c as THREE.Group);
    }
    this.addGrips(d.shape, d.shapeIndex);
    this.scaleGrips();
  }

  private clearHandlePreview(): void {
    if (this.handlePreview !== null) {
      this.handlePreview.removeFromParent();
      this.disposeGroup(this.handlePreview);
      this.handlePreview = null;
    }
  }

  /** End a handle drag: the shape to store (null: never moved). The stored value comes back through the next sync. */
  endHandleDrag(): HandleShape | null {
    const d = this.handleDrag;
    this.handleDrag = null;
    this.clearHandlePreview();
    this.updateSizeHandles();
    return d !== null && d.moved ? d.shape : null;
  }

  /** Cancel a handle drag (Esc): nothing is stored. */
  cancelHandleDrag(): boolean {
    if (this.handleDrag === null) return false;
    this.handleDrag = null;
    this.clearHandlePreview();
    this.updateSizeHandles();
    return true;
  }

  /** Delete the corner/point under a grip (Alt+click): the shape to store, or why not. */
  deleteHandlePoint(ref: HandleRef): { ok: true; shape: HandleShape } | { ok: false; message: string } {
    const shape = this.handleShapes[ref.shapeIndex];
    if (shape === undefined || shape.entityId !== ref.entityId) return { ok: false, message: 'nothing to delete here' };
    return deletePoint(shape, ref.grip);
  }

  /**
   * The player whose capsule is under the pointer (drawn only with the
   * collider outlines on): `onOutline` when the pointer is on the outline
   * itself (within a few pixels), else inside it.
   */
  capsuleAt(clientX: number, clientY: number): { entityId: string; onOutline: boolean } | null {
    if (!this.colliders.visible || this.capsules.size === 0 || !this.aim(clientX, clientY)) return null;
    let best: { entityId: string; onOutline: boolean; d: number } | null = null;
    const rect = this.canvas.getBoundingClientRect();
    for (const [entityId, { shape, z }] of this.capsules) {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), hit)) continue;
      // About 6 pixels at the capsule's distance.
      const tolerance = (6 * 2 * Math.tan((this.camera.fov * Math.PI) / 360) * hit.distanceTo(this.camera.position)) / Math.max(1, rect.height);
      const d = capsuleDistance(shape, { x: hit.x, y: hit.y });
      if (d > tolerance) continue;
      const onOutline = Math.abs(d) <= tolerance;
      if (best === null || (onOutline && !best.onOutline) || Math.abs(d) < best.d) best = { entityId, onOutline, d: Math.abs(d) };
    }
    return best === null ? null : { entityId: best.entityId, onOutline: best.onOutline };
  }

  /** The size handles' client positions (the Scene view stamps them for tests). */
  sizeHandleClientPoints(): { component: string; kind: string; handle: string; role: string; x: number; y: number }[] {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return [];
    this.camera.updateMatrixWorld();
    return this.sizeHandles.children.map((m) => {
      const v = m.position.clone().project(this.camera);
      const d = m.userData as { shapeIndex: number; grip: string; role: string };
      const shape = this.handleShapes[d.shapeIndex];
      return { component: shape?.component ?? '', kind: shape?.kind ?? '', handle: d.grip, role: d.role, x: Math.round(rect.left + ((v.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - v.y) / 2) * rect.height) };
    });
  }

  private kindSignature(e: ProjectedEntity): string {
    return `${e.gameZone !== undefined && e.gameZone.role}|${e.playerSpawn === true}|${e.cameraFollow !== undefined}`;
  }

  /** Pick the topmost zone under the pointer (zones only, not spawns/bounds). */
  private pickZone(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const pickables: THREE.Object3D[] = [];
    for (const g of this.objects.values()) {
      const m = g.children[1] ?? g.children[0];
      if (m instanceof THREE.Mesh && m.userData.role !== undefined) pickables.push(m);
    }
    const hits = this.raycaster.intersectObjects(pickables, false);
    if (hits.length === 0) return null;
    let o: THREE.Object3D | null = hits[0]!.object;
    while (o) {
      const id = (o as { entityId?: string }).entityId;
      if (id && this.objects.has(id)) return id;
      o = o.parent;
    }
    return null;
  }

  private hitTest(clientX: number, clientY: number, obj: THREE.Object3D): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObject(obj, false).length > 0;
  }

  private updateResizeHandle(): void {
    if (this.resizeHandle) {
      this.root.remove(this.resizeHandle);
      this.resizeHandle.geometry.dispose();
      (this.resizeHandle.material as THREE.Material).dispose();
      this.resizeHandle = null;
    }
    if (!this.selectedId) return;
    const g = this.objects.get(this.selectedId);
    const m = g?.children[1] as THREE.Mesh | undefined;
    if (!m || m.userData.role === undefined) return; // zones only
    const size = m.userData.size as [number, number];
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.2, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    handle.position.set(m.position.x + size[0] / 2, m.position.y + size[1] / 2, 0.03);
    this.root.add(handle);
    this.resizeHandle = handle;
  }

  private buildObject(e: ProjectedEntity): THREE.Group {
    const group = new THREE.Group();
    (group as { entityId?: string }).entityId = e.id;
    if (e.gameZone !== undefined) {
      const border = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: ZONE_COLORS[e.gameZone.role],
          wireframe: true,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
        }),
      );
      border.position.set(N(e.position[0]), N(e.position[1]), 0.005);
      border.scale.set(e.gameZone.size[0] * 1.02, e.gameZone.size[1] * 1.02, 1);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: ZONE_COLORS[e.gameZone.role],
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      mesh.position.set(N(e.position[0]), N(e.position[1]), 0.01);
      mesh.scale.set(e.gameZone.size[0], e.gameZone.size[1], 1);
      (mesh as { userData?: unknown }).userData = {
        size: [e.gameZone.size[0], e.gameZone.size[1]],
        role: e.gameZone.role,
      };
      group.add(border, mesh);
    }
    // (A player spawn is drawn by the viewport as an icon billboard.)
    if (e.cameraFollow?.bounds !== undefined) {
      const b = e.cameraFollow.bounds;
      const pts = [
        new THREE.Vector3(b.minX, b.minY, 0.01),
        new THREE.Vector3(b.maxX, b.minY, 0.01),
        new THREE.Vector3(b.maxX, b.maxY, 0.01),
        new THREE.Vector3(b.minX, b.maxY, 0.01),
        new THREE.Vector3(b.minX, b.minY, 0.01),
      ];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: CAMERA_FOLLOW_COLOR }),
      );
      group.add(line);
    }
    return group;
  }

  private updateObject(g: THREE.Group, e: ProjectedEntity): void {
    if (e.gameZone !== undefined) {
      const border = g.children[0] as THREE.Mesh;
      const m = g.children[1] as THREE.Mesh;
      border.position.set(N(e.position[0]), N(e.position[1]), 0.005);
      border.scale.set(e.gameZone.size[0] * 1.02, e.gameZone.size[1] * 1.02, 1);
      m.position.set(N(e.position[0]), N(e.position[1]), 0.01);
      m.scale.set(e.gameZone.size[0], e.gameZone.size[1], 1);
      (m as { userData?: unknown }).userData = {
        size: [e.gameZone.size[0], e.gameZone.size[1]],
        role: e.gameZone.role,
      };
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(ZONE_COLORS[e.gameZone.role]);
      (border.material as THREE.MeshBasicMaterial).color.setHex(ZONE_COLORS[e.gameZone.role]);
    }
    this.updateResizeHandle();
  }

  private disposeGroup(g: THREE.Group): void {
    g.traverse((c) => {
      const o = c as THREE.Mesh;
      if (o.geometry) o.geometry.dispose();
      const mat = (o as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
  }

  dispose(): void {
    for (const g of this.objects.values()) this.disposeGroup(g);
    this.disposeGroup(this.blocks);
    this.disposeGroup(this.colliders);
    this.disposeGroup(this.sizeHandles);
    this.disposeGroup(this.handleOutlines);
    this.clearHandlePreview();
    this.objects.clear();
    if (this.resizeHandle) {
      this.resizeHandle.geometry.dispose();
      (this.resizeHandle.material as THREE.Material).dispose();
      this.resizeHandle = null;
    }
    if (this.previewMesh) {
      this.previewMesh.geometry.dispose();
      (this.previewMesh.material as THREE.Material).dispose();
      this.previewMesh = null;
    }
    this.root.removeFromParent();
  }
}