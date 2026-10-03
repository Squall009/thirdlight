/**
 * The Scene view's helper overlay — three.js, framework-free.
 *
 * It draws the projected helpers — collider outlines, the character
 * capsule, the component areas (mover paths, trigger/switch/collectible/
 * hitbox/patrol/audio ranges) — and the selected entity's descriptor
 * handles, whose drags it previews. It never sends anything itself: the
 * viewport commits a finished handle drag as one command.
 */

import * as THREE from 'three';
import { convexHull2 } from '@thirdlight/runtime';
import type { ProjectedEntity } from '../session/projection';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { capsuleDistance, capsuleShapeOf, outlinePoints, type SizeShape } from '../session/size-handles';
import { deletePoint, dragGrip, gripsOf, handleShapesOf, insertPoint, linesOf, type Grip, type HandleShape, type P3 } from '../session/handles';

/** A grip under the pointer (which handle shape of which entity, which grip). */
export interface HandleRef {
  entityId: string;
  shapeIndex: number;
  grip: string;
  role: Grip['role'];
}

/** The collider outline colour; the player's capsule uses it too. */
const COLLIDER_COLOR = 0x7cfc00;
const SIZE_HANDLE_COLOR = 0xffffff;

/** Gameplay block helpers (mover paths, trigger/switch/collectible/hitbox/patrol areas). */
const BLOCK_COLORS = { mover: 0xffa53a, trigger: 0x3ad7ff, switch: 0xff5a8c, audioSource: 0x7fe0a0, collectible: 0xf2c230, hitbox: 0xff6a3a, patrol: 0xb05aff, climbVolume: 0x5ad18c, gravity: 0x9aa3b2, cameraRegion: 0xd0d6e0 } as const;

/** Safe numeric read (positions are always 3-element). */
const N = (v: number | undefined): number => v ?? 0;

/**
 * The helper overlay. Owns a group in the viewport's scene; the viewport
 * asks it for a handle grip under the pointer first and calls `sync`
 * whenever the projection changes.
 */
export class HelperOverlay {
  private readonly camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private readonly root: THREE.Group;
  private selectedId: string | null = null;
  private readonly raycaster = new THREE.Raycaster();
  /** The gameplay block helpers, rebuilt on every sync. */
  private readonly blocks = new THREE.Group();
  /** Every collider's 2D outline (the Gizmos menu toggles them). */
  private readonly colliders = new THREE.Group();
  /** Collider outlines drawn (their merged line objects hold every one). */
  private colliderOutlines = 0;
  /**
   * The selection's colliders while the Gizmos menu's outlines are off: the
   * selected object's own (every shape of a compound) and its children's.
   */
  private readonly selectedColliders = new THREE.Group();
  /** Each collider's outline segments (world points), by object, kept for the selection's outlines. */
  private outlineOf = new Map<string, { points: number[]; oneWay: boolean }>();
  /** Whether every collider outline is shown (the Gizmos menu; off by default, the selection's still are). */
  private allColliders = false;
  /** The objects whose collider outlines the selection shows now. */
  private selectionOutlined: string[] = [];
  /** A model's `_COL` parts by asset and piece (null: none; absent: not read yet), for `{type: 'model'}` colliders. */
  private readonly modelParts = new Map<string, number[][][] | null>();
  private modelSource: ((assetId: string) => Promise<{ collisionParts(piece: string | null): number[][][] } | null>) | null = null;
  private onModelParts: () => void = () => undefined;
  /** The entities of the last sync (the handles read the selected one). */
  private entities: readonly ProjectedEntity[] = [];
  /** Each player's capsule (drawn with the collider outlines, clickable). */
  private readonly capsules = new Map<string, { shape: SizeShape; z: number }>();
  /** The selected entity's handle grips, its handle outlines and the drag preview. */
  private readonly sizeHandles = new THREE.Group();
  private readonly handleOutlines = new THREE.Group();
  private handleShapes: HandleShape[] = [];
  private handleFrames: THREE.Matrix4[] = [];
  private handleDrag: { shapeIndex: number; grip: string; shape: HandleShape; moved: boolean } | null = null;
  private handlePreview: THREE.Group | null = null;
  /** The descriptors (the handles come from them) and each entity's scene node (its frame). */
  private registry: DescriptorRegistry | null = null;
  private physicsDimension: 2 | 3 = 2;
  private nodeFor: (entityId: string) => THREE.Object3D | null = () => null;

  /** The Scene view replaced its canvas (another renderer backend). */
  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.root = new THREE.Group();
    this.root.name = 'helper-overlay';
    this.blocks.name = 'block-overlay';
    this.root.add(this.blocks);
    this.colliders.name = 'collider-outlines';
    this.colliders.visible = false;
    this.root.add(this.colliders);
    this.selectedColliders.name = 'collider-outlines-selected';
    this.root.add(this.selectedColliders);
    this.sizeHandles.name = 'size-handles';
    this.root.add(this.sizeHandles);
    this.handleOutlines.name = 'handle-outlines';
    this.root.add(this.handleOutlines);
    scene.add(this.root);
  }

  /** Select an entity (its descriptor handles are shown). */
  setSelected(id: string | null): void {
    this.selectedId = id;
    this.updateSizeHandles();
    this.updateSelectedColliders();
  }

  /**
   * Where a model's `_COL` parts are read from (a `{type: 'model'}` collider
   * is drawn as them once read; `changed` redraws the view then).
   */
  setModelSource(source: ((assetId: string) => Promise<{ collisionParts(piece: string | null): number[][][] } | null>) | null, changed: () => void): void {
    this.modelSource = source;
    this.onModelParts = changed;
  }

  /** A model collider's parts (null: none or not read yet — a read is started then). */
  private partsOf(e: ProjectedEntity): number[][][] | null {
    const model = e.components['model'] as { asset?: { assetId?: string }; piece?: string } | undefined;
    const assetId = model?.asset?.assetId;
    if (assetId === undefined) return null;
    const piece = model?.piece ?? null;
    const key = `${assetId}|${piece ?? ''}`;
    if (this.modelParts.has(key)) return this.modelParts.get(key) ?? null;
    if (this.modelSource === null) return null;
    this.modelParts.set(key, null);
    void this.modelSource(assetId).then((res) => {
      const parts = res?.collisionParts(piece) ?? [];
      if (parts.length === 0) return;
      this.modelParts.set(key, parts);
      this.sync(this.entities);
      this.onModelParts();
    }, () => undefined);
    return null;
  }

  /** The selection's collider outlines (the selected object's and its children's), drawn while the Gizmos menu's are off. */
  private updateSelectedColliders(): void {
    for (const c of [...this.selectedColliders.children]) {
      this.selectedColliders.remove(c);
      this.disposeGroup(c as THREE.Group);
    }
    this.selectionOutlined = [];
    if (this.selectedId === null) return;
    const children = new Map<string, string[]>();
    for (const e of this.entities) if (e.parentId !== null) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e.id]);
    const ids: string[] = [];
    const visit = (id: string, depth: number): void => {
      if (depth > 64) return;
      ids.push(id);
      for (const c of children.get(id) ?? []) visit(c, depth + 1);
    };
    visit(this.selectedId, 0);
    const points: number[] = [];
    for (const id of ids) {
      const o = this.outlineOf.get(id);
      if (o === undefined) continue;
      points.push(...o.points);
      this.selectionOutlined.push(id);
    }
    if (points.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const outline = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: COLLIDER_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
    outline.name = 'collider-outlines:selection';
    outline.renderOrder = 9;
    this.selectedColliders.add(outline);
    this.selectedColliders.visible = !this.allColliders;
  }

  /** The objects whose collider outlines are shown now (all of them with the Gizmos menu's on, else the selection's). */
  shownColliderOutlines(): string[] {
    return this.allColliders ? [...this.outlineOf.keys()] : [...this.selectionOutlined];
  }

  /** Sync the overlay from the projection (rebuilds the helpers and the selection's handles). */
  sync(entities: readonly ProjectedEntity[]): void {
    this.syncBlocks(entities);
    this.entities = entities;
    this.updateSizeHandles();
    this.updateSelectedColliders();
  }

  /**
   * The latest entities when nothing the overlay draws changed
   * (the Scene view's incremental sync): a later selection reads its handles
   * from the current objects without a rebuild.
   */
  setEntities(entities: readonly ProjectedEntity[]): void {
    this.entities = entities;
  }

  /**
   * A mover's path (a line through its stops, a dot per stop) and
   * the outline of each trigger, switch, collectible, hitbox and patrol area.
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
    // Every collider's outline on the game plane (box or polygon, turned about Z).
    // All outlines of one colour are one line-segment object (one draw call, not one per
    // collider); `userData.outlines` keeps each entity's range of vertices.
    this.colliderOutlines = 0;
    this.outlineOf = new Map();
    // World matrices: a collider on a child is where its parents put it (projected transforms are parent-relative).
    const byId = new Map(entities.map((x) => [x.id, x]));
    const worlds = new Map<string, THREE.Matrix4>();
    const worldOf = (x: ProjectedEntity, depth = 0): THREE.Matrix4 => {
      const hit = worlds.get(x.id);
      if (hit !== undefined) return hit;
      const own = new THREE.Matrix4().compose(new THREE.Vector3(N(x.position[0]), N(x.position[1]), N(x.position[2])), new THREE.Quaternion(N(x.rotation[0]), N(x.rotation[1]), N(x.rotation[2]), x.rotation[3] ?? 1), new THREE.Vector3(x.scale[0] ?? 1, x.scale[1] ?? 1, x.scale[2] ?? 1));
      const parent = x.parentId !== null ? byId.get(x.parentId) : undefined;
      const m = parent !== undefined && depth < 64 ? new THREE.Matrix4().multiplyMatrices(worldOf(parent, depth + 1), own) : own;
      worlds.set(x.id, m);
      return m;
    };
    const merged = { solid: { points: [] as number[], ranges: {} as Record<string, { start: number; count: number }> }, oneWay: { points: [] as number[], ranges: {} as Record<string, { start: number; count: number }> } };
    for (const e of entities) {
      const shape = (e.collider as { shape?: { type: string; hx?: number; hy?: number; vertices?: number[][] } } | undefined)?.shape;
      if (shape === undefined) continue;
      // A 3D shape (a box with its depth, a sphere, a capsule, a hull, a mesh) as a wire outline
      // with the object's whole transform (a 3D collider turns and scales with it), in the same merged lines.
      // A model shape is drawn as its `_COL` parts once they are read.
      const parts = shape.type === 'model' ? this.partsOf(e) : undefined;
      const oneWay = (e.collider as { oneWay?: boolean }).oneWay === true;
      const target = oneWay ? merged.oneWay : merged.solid;
      const start = target.points.length / 3;
      const world = worldOf(e);
      const local = shape.type === 'model' && this.physicsDimension !== 3 ? null : colliderSegments3D(shape, parts);
      if (local !== null) {
        pushMatrix(target.points, local, world);
      } else {
        // The 2D plane: the outline on the game plane (z at the plane, turned about Z with its object).
        const segments = colliderSegments2D(shape, parts);
        if (segments.length < 2) continue;
        const flat: number[] = [];
        for (const p of segments) flat.push(N(p[0]), N(p[1]), 0);
        pushMatrix(target.points, flat, world);
        for (let i = start * 3 + 2; i < target.points.length; i += 3) target.points[i] = 0.03;
      }
      target.ranges[e.id] = { start, count: target.points.length / 3 - start };
      this.outlineOf.set(e.id, { points: target.points.slice(start * 3), oneWay });
      this.colliderOutlines += 1;
    }
    for (const [kind, m] of Object.entries(merged)) {
      if (m.points.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(m.points, 3));
      const outline = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: kind === 'oneWay' ? 0x8fb573 : COLLIDER_COLOR, depthTest: false, transparent: true, opacity: 0.85 }));
      outline.name = `collider-outlines:${kind}`;
      outline.userData['outlines'] = m.ranges;
      outline.renderOrder = 9;
      this.colliders.add(outline);
    }
    // The player's capsule (its own, or the default one), in the collider colour.
    this.capsules.clear();
    for (const e of entities) {
      if (e.controller !== true) continue;
      const shape = capsuleShapeOf(e);
      if (shape === null) continue;
      const z = N(e.position[2]) + 0.03;
      const ring = outlinePoints(shape, 16);
      // The selection's outlines show it too (as segments).
      const segs: number[] = [];
      for (let i = 0; i + 1 < ring.length; i += 1) segs.push(ring[i]!.x, ring[i]!.y, z, ring[i + 1]!.x, ring[i + 1]!.y, z);
      this.outlineOf.set(e.id, { points: segs, oneWay: false });
      const outline = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ring.map((p) => new THREE.Vector3(p.x, p.y, z))),
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
      // A camera region's box (dashed; its handles when selected).
      const region = e.components['cameraRegion'] as { size?: number[] } | undefined;
      if (Array.isArray(region?.size)) {
        const box = rect(N(e.position[0]), N(e.position[1]), N(region.size[0]), N(region.size[1]), BLOCK_COLORS.cameraRegion);
        box.name = `camera-region:${e.id}`;
        this.blocks.add(box);
      }
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
        // A dot per stop (the selected mover's stops get grips from its path handle).
        const count = mover.waypoints.length + 1;
        for (let i = 0; i < count; i++) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: BLOCK_COLORS.mover, depthTest: false }));
          dot.position.copy(stops[i]!);
          dot.renderOrder = 11;
          this.blocks.add(dot);
        }
      }
      // A 3D trigger area (a box with its depth, a sphere, a capsule), turned with its object.
      const trig3 = triggerSegments3D(b.trigger);
      if (trig3 !== null) {
        const pts: number[] = [];
        pushTransformed(pts, trig3, e.position, e.rotation, [1, 1, 1]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const wire = new THREE.LineSegments(geometry, new THREE.LineDashedMaterial({ color: BLOCK_COLORS.trigger, dashSize: 0.2, gapSize: 0.1 })).computeLineDistances();
        wire.name = `trigger-3d:${e.id}`;
        this.blocks.add(wire);
      }
      // A circle trigger's outline (dashed, in the trigger colour).
      const trig = b.trigger as { shape?: string; radius?: number } | undefined;
      if (trig?.shape === 'circle' && typeof trig.radius === 'number') {
        const pts = outlinePoints({ kind: 'circle', center: { x, y }, half: { x: trig.radius, y: trig.radius } } as SizeShape, 24).map((p) => new THREE.Vector3(p.x, p.y, 0.02));
        const circle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: BLOCK_COLORS.trigger, dashSize: 0.2, gapSize: 0.1 })).computeLineDistances();
        circle.name = `trigger-circle:${e.id}`;
        this.blocks.add(circle);
      }
      for (const k of ['trigger', 'switch'] as const) {
        const size = (b[k] as { size?: number[] } | undefined)?.size;
        if (k === 'trigger' && trig3 !== null) continue;
        if (size !== undefined) this.blocks.add(rect(x, y, N(size[0]), N(size[1]), BLOCK_COLORS[k]));
      }
      // A collectible's area, a hitbox (box or circle) and an edge patroller's body, centred on the object.
      const coll = b.collectible as { size?: number[] } | undefined;
      if (coll !== undefined) this.blocks.add(rect(x, y, N(coll.size?.[0] ?? 1), N(coll.size?.[1] ?? coll.size?.[0] ?? 1), BLOCK_COLORS.collectible));
      const hit = b.hitbox as { shape?: string; size?: number[]; radius?: number } | undefined;
      if (hit !== undefined && hit.shape === 'sphere' && typeof hit.radius === 'number') {
        const pts = outlinePoints({ kind: 'circle', center: { x, y }, half: { x: hit.radius, y: hit.radius } } as SizeShape, 24).map((p) => new THREE.Vector3(p.x, p.y, 0.02));
        const circle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: BLOCK_COLORS.hitbox, dashSize: 0.2, gapSize: 0.1 })).computeLineDistances();
        circle.name = `hitbox-circle:${e.id}`;
        this.blocks.add(circle);
      } else if (hit?.size !== undefined) this.blocks.add(rect(x, y, N(hit.size[0]), N(hit.size[1]), BLOCK_COLORS.hitbox));
      const walker = b.patrol as { mode?: string; size?: number[] } | undefined;
      if (walker !== undefined && walker.mode === 'edges') this.blocks.add(rect(x, y, N(walker.size?.[0] ?? 1), N(walker.size?.[1] ?? walker.size?.[0] ?? 1), BLOCK_COLORS.patrol));
      // A climb volume's box and a gravity body's body.
      const climb = b.climbVolume as { size?: number[] } | undefined;
      if (climb?.size !== undefined) this.blocks.add(rect(x, y, N(climb.size[0]), N(climb.size[1]), BLOCK_COLORS.climbVolume));
      const fall = b.gravity as { size?: number[] } | undefined;
      if (fall !== undefined) this.blocks.add(rect(x, y, N(fall.size?.[0] ?? 1), N(fall.size?.[1] ?? fall.size?.[0] ?? 1), BLOCK_COLORS.gravity));
      // An audio source's hearing range along X (full volume in the inner quarter).
      const sound = b.audioSource as { range?: number } | undefined;
      if (sound?.range !== undefined) {
        this.blocks.add(rect(x, y, sound.range * 2, 0.4, BLOCK_COLORS.audioSource));
        this.blocks.add(rect(x, y, sound.range / 2, 0.4, BLOCK_COLORS.audioSource));
      }
    }
  }

  /** The drawn gameplay helpers (names of the mover paths), for tests. */
  blockHelpers(): { moverPaths: string[]; count: number; colliders: number; capsules: number; sizeHandles: number; collidersShown: string[] } {
    return {
      collidersShown: this.shownColliderOutlines(),
      moverPaths: this.blocks.children.filter((c) => c.name.startsWith('mover-path:')).map((c) => c.name.slice(11)),
      count: this.blocks.children.length,
      colliders: this.colliderOutlines + this.capsules.size,
      capsules: this.capsules.size,
      sizeHandles: this.sizeHandles.children.length,
    };
  }

  /** The Gizmos menu's collider outlines (off: only the selection's) and gameplay helpers. */
  setGizmos(g: { colliders: boolean; gameplay: boolean }): void {
    this.allColliders = g.colliders;
    this.colliders.visible = g.colliders;
    this.selectedColliders.visible = !g.colliders;
    this.blocks.visible = g.gameplay;
  }

  // ---- Descriptor-driven handles ---------------------------------

  /** The descriptors (handles come from them) and how to find an entity's scene node (its frame). */
  setHandleSources(registry: DescriptorRegistry | null, nodeFor: (entityId: string) => THREE.Object3D | null): void {
    this.registry = registry;
    this.nodeFor = nodeFor;
    this.updateSizeHandles();
  }

  /** The project's physics dimension (a handle of the other dimension is not shown). */
  setPhysicsDimension(dimension: 2 | 3): void {
    if (dimension === this.physicsDimension) return;
    this.physicsDimension = dimension;
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
    if (s.anchor !== undefined) {
      // On another object's world position plus an offset (a track camera's target).
      const at = this.anchorPosition(s.anchor.entityId) ?? new THREE.Vector3();
      return m.makeTranslation(at.x + s.anchor.offset.x, at.y + s.anchor.offset.y, at.z + s.anchor.offset.z);
    }
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

  /** An object's world position (its scene node, else its projected transform; null: not in the open scene). */
  private anchorPosition(entityId: string): THREE.Vector3 | null {
    const node = this.nodeFor(entityId);
    if (node !== null) {
      node.updateWorldMatrix(true, false);
      return new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    }
    const e = this.entities.find((x) => x.id === entityId);
    return e === undefined ? null : new THREE.Vector3(N(e.position[0]), N(e.position[1]), N(e.position[2]));
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
    // A handle anchored on an object that is not in the open scene is not shown.
    this.handleShapes = handleShapesOf(e, this.registry, this.physicsDimension).filter((sh) => sh.anchor === undefined || this.anchorPosition(sh.anchor.entityId) !== null);
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
   * The player whose capsule is under the pointer (where its outline is
   * drawn: every one with the collider outlines on, else the selection's):
   * `onOutline` when the pointer is on the outline itself (within a few
   * pixels), else inside it.
   */
  capsuleAt(clientX: number, clientY: number): { entityId: string; onOutline: boolean } | null {
    if (this.capsules.size === 0 || !this.aim(clientX, clientY)) return null;
    let best: { entityId: string; onOutline: boolean; d: number } | null = null;
    const rect = this.canvas.getBoundingClientRect();
    for (const [entityId, { shape, z }] of this.capsules) {
      if (!this.colliders.visible && !this.selectionOutlined.includes(entityId)) continue;
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
    this.disposeGroup(this.blocks);
    this.disposeGroup(this.colliders);
    this.disposeGroup(this.sizeHandles);
    this.disposeGroup(this.handleOutlines);
    this.clearHandlePreview();
    this.root.removeFromParent();
  }
}
// ---- 3D wire outlines (local segments as flat [x, y, z, x, y, z, ...] pairs) ----

const ringXZ = (out: number[], r: number, y: number, n = 32): void => {
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    out.push(r * Math.cos(a), y, r * Math.sin(a), r * Math.cos(b), y, r * Math.sin(b));
  }
};

/** A capsule standing along Y (radius, centre-segment half length): two rings and its outline in the XY and ZY planes. */
function capsuleSegments(out: number[], r: number, seg: number): void {
  ringXZ(out, r, seg);
  ringXZ(out, r, -seg);
  for (const plane of [0, 1]) {
    const P = (u: number, y: number): [number, number, number] => (plane === 0 ? [u, y, 0] : [0, y, u]);
    const n = 16;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI;
      const b = ((i + 1) / n) * Math.PI;
      out.push(...P(r * Math.cos(a), seg + r * Math.sin(a)), ...P(r * Math.cos(b), seg + r * Math.sin(b)));
      out.push(...P(r * Math.cos(a), -seg - r * Math.sin(a)), ...P(r * Math.cos(b), -seg - r * Math.sin(b)));
    }
    out.push(...P(r, -seg), ...P(r, seg), ...P(-r, -seg), ...P(-r, seg));
  }
}

function boxSegments(out: number[], hx: number, hy: number, hz: number): void {
  const c = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, b] of edges) out.push(c[a!]![0]! * hx, c[a!]![1]! * hy, c[a!]![2]! * hz, c[b!]![0]! * hx, c[b!]![1]! * hy, c[b!]![2]! * hz);
}

const hullCache = new Map<string, number[]>();

/** The edges of the convex hull of at most 64 points (faces found by the all-on-one-side test; cached per point list). */
function hullSegments(points: readonly (readonly number[])[]): number[] {
  const key = JSON.stringify(points);
  const cached = hullCache.get(key);
  if (cached !== undefined) return cached;
  const P = points.map((p) => [N(p[0]), N(p[1]), N(p[2])] as [number, number, number]);
  const n = Math.min(P.length, 64);
  const edges = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      for (let k = j + 1; k < n; k += 1) {
        const a = P[i]!;
        const u = [P[j]![0] - a[0], P[j]![1] - a[1], P[j]![2] - a[2]];
        const v = [P[k]![0] - a[0], P[k]![1] - a[1], P[k]![2] - a[2]];
        const nx = u[1]! * v[2]! - u[2]! * v[1]!;
        const ny = u[2]! * v[0]! - u[0]! * v[2]!;
        const nz = u[0]! * v[1]! - u[1]! * v[0]!;
        if (Math.hypot(nx, ny, nz) < 1e-9) continue;
        let pos = false;
        let neg = false;
        for (let m = 0; m < n && !(pos && neg); m += 1) {
          const d = nx * (P[m]![0] - a[0]) + ny * (P[m]![1] - a[1]) + nz * (P[m]![2] - a[2]);
          if (d > 1e-9) pos = true;
          else if (d < -1e-9) neg = true;
        }
        if (pos && neg) continue;
        edges.add(`${i},${j}`).add(`${j},${k}`).add(`${i},${k}`);
      }
    }
  }
  const out: number[] = [];
  for (const e of edges) {
    const [a, b] = e.split(',').map(Number);
    out.push(...P[a!]!, ...P[b!]!);
  }
  if (hullCache.size > 256) hullCache.clear();
  hullCache.set(key, out);
  return out;
}

/**
 * A 3D collider shape's wire outline in its object's frame (each shape at
 * its center and rotation, every shape of a compound, a model shape's
 * `_COL` hulls from `modelParts`), or null for a 2D-plane shape.
 */
export function colliderSegments3D(shape: { type: string; [k: string]: unknown }, modelParts?: readonly (readonly (readonly number[])[])[] | null): number[] | null {
  if (shape.type === 'model') {
    if (modelParts === undefined || modelParts === null) return null;
    return modelParts.flatMap((points) => hullSegments(points));
  }
  if (shape.type === 'compound') {
    const out: number[] = [];
    for (const part of (shape['shapes'] as { type: string; [k: string]: unknown }[] | undefined) ?? []) {
      const segs = colliderSegments3D(part);
      if (segs !== null) out.push(...segs);
    }
    return out.length > 0 ? out : null;
  }
  const local = primitiveSegments3D(shape);
  if (local === null) return null;
  const c = shape['center'] as number[] | undefined;
  const q = shape['rotation'] as number[] | undefined;
  if (c === undefined && q === undefined) return local;
  const out: number[] = [];
  pushTransformed(out, local, c ?? [0, 0, 0], q ?? [0, 0, 0, 1], [1, 1, 1]);
  return out;
}

/**
 * A 2D-plane collider shape's outline in its object's XY plane as segment
 * pairs [x, y] (each box or polygon at its center and turn about Z, every
 * shape of a compound, a model shape's parts as their XY hulls).
 */
export function colliderSegments2D(shape: { type: string; [k: string]: unknown }, modelParts?: readonly (readonly (readonly number[])[])[] | null): [number, number][] {
  const out: [number, number][] = [];
  const loop = (corners: readonly (readonly number[])[], c: readonly number[], q: readonly number[]): void => {
    const angle = 2 * Math.atan2(N(q[2]), N(q[3] ?? 1));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const at = (p: readonly number[]): [number, number] => [N(c[0]) + N(p[0]) * cos - N(p[1]) * sin, N(c[1]) + N(p[0]) * sin + N(p[1]) * cos];
    for (let i = 0; i < corners.length; i += 1) out.push(at(corners[i]!), at(corners[(i + 1) % corners.length]!));
  };
  const one = (s: { type: string; [k: string]: unknown }): void => {
    const c = (s['center'] as number[] | undefined) ?? [0, 0, 0];
    const q = (s['rotation'] as number[] | undefined) ?? [0, 0, 0, 1];
    if (s.type === 'box') loop([[-N(s['hx'] as number), -N(s['hy'] as number)], [N(s['hx'] as number), -N(s['hy'] as number)], [N(s['hx'] as number), N(s['hy'] as number)], [-N(s['hx'] as number), N(s['hy'] as number)]], c, q);
    else if (s.type === 'polygon') loop((s['vertices'] as number[][] | undefined) ?? [], c, q);
  };
  if (shape.type === 'model') for (const points of modelParts ?? []) loop(convexHull2(points.map((p) => [N(p[0]), N(p[1])] as [number, number])), [0, 0, 0], [0, 0, 0, 1]);
  else if (shape.type === 'compound') for (const part of (shape['shapes'] as { type: string; [k: string]: unknown }[] | undefined) ?? []) one(part);
  else one(shape);
  return out;
}

/** One primitive 3D shape's wire outline about its own centre, or null for a 2D-plane shape. */
function primitiveSegments3D(shape: { type: string; [k: string]: unknown }): number[] | null {
  const out: number[] = [];
  switch (shape.type) {
    case 'box':
      if (shape['hz'] === undefined) return null;
      boxSegments(out, N(shape['hx'] as number), N(shape['hy'] as number), N(shape['hz'] as number));
      return out;
    case 'sphere': {
      const r = N(shape['radius'] as number);
      ringXZ(out, r, 0);
      capsuleSegments(out, r, 0);
      return out;
    }
    case 'capsule': {
      const r = N(shape['radius'] as number);
      capsuleSegments(out, r, Math.max(0, N(shape['height'] as number) / 2 - r));
      return out;
    }
    case 'convex':
      return hullSegments((shape['points'] as number[][] | undefined) ?? []);
    case 'mesh': {
      const v = (shape['vertices'] as number[][] | undefined) ?? [];
      const seen = new Set<string>();
      for (const t of (shape['triangles'] as number[][] | undefined) ?? []) {
        for (const [a, b] of [[t[0]!, t[1]!], [t[1]!, t[2]!], [t[2]!, t[0]!]] as const) {
          const k = a < b ? `${a},${b}` : `${b},${a}`;
          if (seen.has(k) || v[a] === undefined || v[b] === undefined) continue;
          seen.add(k);
          out.push(N(v[a]![0]), N(v[a]![1]), N(v[a]![2]), N(v[b]![0]), N(v[b]![1]), N(v[b]![2]));
        }
      }
      return out;
    }
    default:
      return null;
  }
}

/** A 3D trigger area's wire outline (box with a depth, sphere, capsule), or null for a 2D-plane one. */
function triggerSegments3D(trigger: unknown): number[] | null {
  if (typeof trigger !== 'object' || trigger === null) return null;
  const t = trigger as { shape?: string; size?: number[]; radius?: number; height?: number };
  const out: number[] = [];
  if (t.shape === 'sphere') {
    ringXZ(out, N(t.radius), 0);
    capsuleSegments(out, N(t.radius), 0);
    return out;
  }
  if (t.shape === 'capsule') {
    capsuleSegments(out, N(t.radius), Math.max(0, N(t.height) / 2 - N(t.radius)));
    return out;
  }
  if ((t.shape === undefined || t.shape === 'box') && Array.isArray(t.size) && t.size.length === 3) {
    boxSegments(out, N(t.size[0]) / 2, N(t.size[1]) / 2, N(t.size[2]) / 2);
    return out;
  }
  return null;
}

/** Append local segments moved into the world by a matrix. */
function pushMatrix(out: number[], local: readonly number[], m: THREE.Matrix4): void {
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < local.length; i += 3) {
    v.set(local[i]!, local[i + 1]!, local[i + 2]!).applyMatrix4(m);
    out.push(v.x, v.y, v.z);
  }
}

/** Append local segments moved into the world by a position, rotation and scale. */
function pushTransformed(out: number[], local: readonly number[], position: readonly number[], rotation: readonly number[], scale: readonly number[]): void {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(N(position[0]), N(position[1]), N(position[2])), new THREE.Quaternion(N(rotation[0]), N(rotation[1]), N(rotation[2]), rotation[3] ?? 1), new THREE.Vector3(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1));
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < local.length; i += 3) {
    v.set(local[i]!, local[i + 1]!, local[i + 2]!).applyMatrix4(m);
    out.push(v.x, v.y, v.z);
  }
}
