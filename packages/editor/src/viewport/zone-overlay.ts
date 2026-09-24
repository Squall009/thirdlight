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
const BLOCK_COLORS = { mover: 0xffa53a, trigger: 0x3ad7ff, switch: 0xff5a8c, enemy: 0xb05aff, pickup: 0xf2c230 } as const;
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

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.root = new THREE.Group();
    this.root.name = 'zone-overlay';
    this.blocks.name = 'block-overlay';
    this.root.add(this.blocks);
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
        for (const s of stops) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: BLOCK_COLORS.mover, depthTest: false }));
          dot.position.copy(s);
          dot.renderOrder = 10;
          this.blocks.add(dot);
        }
      }
      for (const k of ['trigger', 'switch', 'enemy', 'pickup'] as const) {
        const size = (b[k] as { size?: number[] } | undefined)?.size;
        if (size !== undefined) this.blocks.add(rect(x, y, N(size[0]), N(size[1]), BLOCK_COLORS[k]));
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
  blockHelpers(): { moverPaths: string[]; count: number } {
    return { moverPaths: this.blocks.children.filter((c) => c.name.startsWith('mover-path:')).map((c) => c.name.slice(11)), count: this.blocks.children.length };
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