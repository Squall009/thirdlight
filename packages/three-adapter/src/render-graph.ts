/**
 * The three.js scene as a flat list of what is drawn.
 *
 * three.js walks its whole scene graph twice a frame (world matrices, then
 * the render list), so every Object3D in it costs time whether it draws or
 * not. Here the entities live in the engine's own data instead: their world
 * matrices in a `WorldMatrices` table, composed from the frame's interpolated
 * transforms; and the scene's children are only drawables — meshes,
 * instanced meshes and lights.
 *
 * An entity that shows something gets one `EntityNode`, which is never in
 * the scene: its matrix is the entity's world matrix, and what it shows (a
 * box mesh, a light, a model's file hierarchy, an instance set) hangs below
 * it as before, so material, look, lightmap and animation code keeps walking
 * the same subtrees. When a subtree is added to a node its top-most
 * drawables are listed in the scene directly, with their `.parent` left as
 * the logical one:
 *
 * - static subtrees (the usual case): the drawable's offset from the entity
 *   (the file hierarchy's matrices multiplied together) is baked once, its
 *   own matrix updates are switched off, and each frame its world matrix is
 *   the entity's world times that offset;
 * - animated subtrees (an animator, a `modelAnimation`, a skinned mesh): the
 *   mixer moves nodes inside the hierarchy, so after the animation step the
 *   node's hierarchy is posed in place (`poseAnimated`) and the listed
 *   drawables follow their logical parents. Bones stay in the hierarchy:
 *   skinning reads their world matrices, not their place in the scene.
 *
 * Only what moved is placed again: the table composes only the rows whose
 * transform changed (and their descendants), and only those entities'
 * drawables get a new world matrix — an idle static scene writes none. The
 * batcher hears of those writes, and of what enters and leaves the scene,
 * from here (`setMembership`), so it never walks the scene itself.
 *
 * Levels of detail: a `THREE.LOD` is data here, never in the scene. Each one
 * gets a switch that picks its level from the camera every frame (three's
 * rule, `lod-switch.ts`) and lists only that level's drawables; the other
 * levels stay attached to nothing three walks.
 *
 * Groups inside a static model file below a mesh (a node with child nodes)
 * would come into the scene with the mesh, so their offset is baked into
 * them and they hang beside the mesh instead, while the subtree is shown.
 *
 * Entities with nothing to draw (logic-only objects, empty markers) have a
 * table row and no Object3D at all.
 *
 * The cached static shadow map (`cached-shadow.ts`) hears from here when a
 * static caster enters or leaves the scene or is moved (`onStaticChange`),
 * and the parts of animated hierarchies are marked as moving casters.
 *
 * A listed drawable the batcher draws through an instanced batch or a merged
 * static cell is parked: it stays listed (the batcher keeps it as a member,
 * picking still finds it through `pickables`) but leaves the scene's
 * children, so three's per-pass walks (matrices, the render list of the view
 * and of every shadow map) skip it.
 */
import * as THREE from 'three';
import { WorldMatrices } from '@thirdlight/runtime';

import type { BatchMembership } from './batching';
import { LOD_LEVEL_KEY, LOD_OWNER_KEY, pickLodLevel } from './lod-switch';
import { isStaticCaster, MOVING_CASTER_KEY } from './shadow-casters';

/** Whether three draws an object itself (a mesh, line, points, sprite or a light). */
export function isDrawable(o: THREE.Object3D): boolean {
  const d = o as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean; isLight?: boolean };
  return d.isMesh === true || d.isLine === true || d.isPoints === true || d.isSprite === true || d.isLight === true;
}

/** A LOD level a part is drawn in. */
interface Gate {
  readonly sw: LodSwitch;
  readonly level: number;
}

/** One drawable of an entity (or of a loose object). */
function setAuto(o: THREE.Object3D, matrix: boolean, world: boolean): void {
  o.matrixAutoUpdate = matrix;
  o.matrixWorldAutoUpdate = world;
}

interface Part {
  readonly object: THREE.Object3D;
  /** The subtree it came from (the object added to the node, or listed loose). */
  readonly owner: THREE.Object3D;
  /** Its offset from the entity (null: animated, it follows its logical parent; or loose, placed by its owner). */
  readonly offset: THREE.Matrix4 | null;
  /** The LOD levels it belongs to: it is in the scene only while each of them is the one drawn. */
  readonly gates: readonly Gate[];
  /** In the scene now. */
  listed: boolean;
  /** Its entity (or an ancestor) is hidden by the simulation: out of the scene. */
  hidden: boolean;
  /** What it had before it was listed (restored when it leaves). */
  readonly matrixAutoUpdate: boolean;
  readonly matrixWorldAutoUpdate: boolean;
  /** Posed with its animated hierarchy: its matrices update only inside `poseAnimated`. */
  readonly posed: boolean;
}

/** A LOD kept as data: the level it draws, and the parts below it. */
interface LodSwitch {
  readonly lod: THREE.LOD;
  readonly owner: THREE.Object3D;
  /** The LOD's offset from the entity (null: its matrixWorld is kept right by the hierarchy or its owner). */
  readonly offset: THREE.Matrix4 | null;
  /** The level drawn (-1: none picked yet). */
  active: number;
  readonly parts: Part[];
}

/** A node moved out from below a mesh (its offset baked), put back when the subtree leaves. */
interface Hoist {
  readonly object: THREE.Object3D;
  readonly from: THREE.Object3D;
  readonly owner: THREE.Object3D;
  readonly matrix: THREE.Matrix4;
  readonly matrixAutoUpdate: boolean;
}

/** The parts, switches and moved nodes of one entity node (or one loose object). */
interface Holding {
  parts: Part[];
  switches: LodSwitch[];
  hoists: Hoist[];
}

/** Matrices written in the last frame. */
export interface MatrixWrites {
  /** Entity world matrices composed (rows whose transform changed, with their descendants). */
  readonly entities: number;
  /** Drawables given a new world matrix from their entity's. */
  readonly drawables: number;
  /** Drawables of animated hierarchies posed after the animation step. */
  readonly posed: number;
}

/** The Object3Ds of the scene by kind (the scene itself not counted). */
export interface SceneGraphCounts {
  /** Every Object3D under the scene. */
  readonly objects: number;
  /** Meshes, lines, points and sprites (instanced, batched and skinned included). */
  readonly drawables: number;
  /** Lights and their targets. */
  readonly lights: number;
  readonly bones: number;
  /** LOD switches and the level nodes below them that draw nothing themselves (the target is none). */
  readonly lods: number;
  /** Anything else: groups and empty nodes (the target is none). */
  readonly containers: number;
  /** Entity nodes (outside the scene) and the drawables they listed in it. */
  readonly entities: number;
  readonly listed: number;
  /** LODs switched outside the scene, and their drawables not attached now (other levels). */
  readonly lodSwitches: number;
  readonly unattached: number;
  /** Matrices written in the last frame, and since the scene was made. */
  readonly matrixWrites: MatrixWrites;
  readonly matrixWritesTotal: number;
}

/** An entity's node: its world matrix, the logical parent of what it shows (never in the scene). */
export class EntityNode extends THREE.Object3D {
  readonly entityId: string;
  private readonly graph: RenderGraph;

  constructor(entityId: string, graph: RenderGraph) {
    super();
    this.entityId = entityId;
    this.graph = graph;
    this.name = `entity:${entityId}`;
    this.matrixAutoUpdate = false;
  }

  override add(...objects: THREE.Object3D[]): this {
    super.add(...objects);
    for (const o of objects) if (o.parent === this) this.graph.show(this, o);
    return this;
  }

  override remove(...objects: THREE.Object3D[]): this {
    for (const o of objects) if (o.parent === this) this.graph.hide(this, o);
    return super.remove(...objects);
  }
}

const emptyHolding = (): Holding => ({ parts: [], switches: [], hoists: [] });

export class RenderGraph {
  /** Every realized entity's world matrix. */
  readonly world = new WorldMatrices();
  private readonly scene: THREE.Scene;
  private readonly animated: (entityId: string) => boolean;
  private readonly nodes = new Map<string, EntityNode>();
  private readonly held = new Map<EntityNode, Holding>();
  /** Objects listed on their own (block chunks): placed by their owner, never moved here. */
  private readonly loose = new Map<THREE.Object3D, Holding>();
  /** Every LOD switch (entity and loose ones). */
  private readonly switches = new Set<LodSwitch>();
  /** Nodes whose hierarchy is posed after the animation step. */
  private readonly posed = new Set<EntityNode>();
  /** What is in the scene's children through this graph (with a hint of where). */
  private readonly inScene = new Map<THREE.Object3D, number>();
  /** Listed drawables drawn through a batch: out of the scene's children. */
  private readonly parked = new Set<THREE.Object3D>();
  /** Entities hidden by themselves or an ancestor. */
  private hidden: ReadonlySet<string> = new Set();
  /** Bumped when entities or their parts change (the hidden set is derived again). */
  revision = 0;
  /** A part was added or left since the last `setHidden`: every node's parts are set again. */
  private dirtyVisibility = false;
  private writes: MatrixWrites = { entities: 0, drawables: 0, posed: 0 };
  private writesTotal = 0;
  private placedNow = 0;
  private readonly camPos = new THREE.Vector3();
  /** The camera position and zoom the LOD levels were last picked at, and whether a LOD moved or came since. */
  private readonly lodCam = new THREE.Vector3(Number.NaN, 0, 0);
  private lodZoom = Number.NaN;
  private lodsDirty = true;
  /** LODs of animated hierarchies posed since the last pick (the camera still: only they can change level). */
  private readonly movedSwitches = new Set<LodSwitch>();
  /** Told when a static shadow caster enters or leaves the scene (with it: where it stands) or moves (null: anywhere). */
  private staticChanged: ((where: THREE.Object3D | null) => void) | null = null;
  /** Told what enters and leaves the scene and whose matrix was written (the batcher regroups only on those). */
  private membership: BatchMembership | null = null;

  constructor(scene: THREE.Scene, animated: (entityId: string) => boolean) {
    this.scene = scene;
    this.animated = animated;
  }

  /**
   * Call `fn` whenever a static shadow caster enters or leaves the scene (with the object: its world matrix is
   * where it stands) or its matrix is written (null: it may have been anywhere before).
   */
  onStaticChange(fn: ((where: THREE.Object3D | null) => void) | null): void {
    this.staticChanged = fn;
  }

  /** Tell `m` about every listed drawable from now on (and the ones listed already). */
  setMembership(m: BatchMembership | null): void {
    this.membership = m;
    if (m !== null) for (const o of this.inScene.keys()) m.listed(o);
  }

  /**
   * A listed drawable is drawn through a batch (`on`) or on its own again:
   * it leaves the scene's children or comes back. Nothing for an object not
   * listed (or already there).
   */
  park(o: THREE.Object3D, on: boolean): void {
    if (on) {
      if (!this.inScene.has(o)) return;
      this.detach(o);
      this.parked.add(o);
      return;
    }
    if (!this.parked.delete(o)) return;
    this.inScene.set(o, this.scene.children.length);
    this.scene.children.push(o);
  }

  /** What a ray picks among: the scene's children and the parked drawables (drawn through batches, picked themselves). */
  pickables(): THREE.Object3D[] {
    return this.parked.size === 0 ? [...this.scene.children] : [...this.scene.children, ...this.parked];
  }

  /** The parked drawables (a scene dump reads them with the scene). */
  parkedObjects(): ReadonlySet<THREE.Object3D> {
    return this.parked;
  }

  /** Add an entity's row (its local transform starts at identity). */
  addEntity(id: string, parentId: string | null): void {
    this.world.add(id, parentId);
    this.revision += 1;
  }

  /** Remove an entity: its drawables leave the scene; its node (if any) is returned for disposal. */
  removeEntity(id: string): EntityNode | undefined {
    const node = this.nodes.get(id);
    if (node !== undefined) {
      const h = this.held.get(node);
      if (h !== undefined) this.release(h, null);
      this.held.delete(node);
      this.posed.delete(node);
      this.nodes.delete(id);
    }
    this.world.remove(id);
    this.revision += 1;
    return node;
  }

  /** The entity's node, or undefined when it shows nothing. */
  node(id: string): EntityNode | undefined {
    return this.nodes.get(id);
  }

  /** The entity's node, made when it has none yet (undefined when the entity is not realized). */
  nodeFor(id: string): EntityNode | undefined {
    let node = this.nodes.get(id);
    if (node === undefined && this.world.has(id)) {
      node = new EntityNode(id, this);
      this.nodes.set(id, node);
      this.place(node);
    }
    return node;
  }

  /** Take in `sub` (it was just added to `node`): its drawables, its LODs, the nodes below its meshes. */
  show(node: EntityNode, sub: THREE.Object3D): void {
    let animated = this.animated(node.entityId);
    if (!animated) sub.traverse((o) => void ((o as THREE.SkinnedMesh).isSkinnedMesh === true && (animated = true)));
    let h = this.held.get(node);
    if (h === undefined) {
      h = emptyHolding();
      this.held.set(node, h);
    }
    this.collect(h, sub, node, animated);
    if (animated) this.posed.add(node);
    this.place(node);
    this.revision += 1;
  }

  /** `sub` leaves `node`: its drawables leave the scene and get back what they had. */
  hide(node: EntityNode, sub: THREE.Object3D): void {
    const h = this.held.get(node);
    if (h === undefined) return;
    this.release(h, sub);
    if (h.parts.every((p) => p.offset !== null)) this.posed.delete(node);
    this.revision += 1;
  }

  /** List an object that places itself (its world matrices are already right and stay as they are). */
  listStatic(o: THREE.Object3D): void {
    if (this.loose.has(o)) return;
    const h = emptyHolding();
    this.loose.set(o, h);
    this.collect(h, o, null, false);
  }

  unlistStatic(o: THREE.Object3D): void {
    const h = this.loose.get(o);
    if (h === undefined) return;
    this.loose.delete(o);
    this.release(h, null);
  }

  /** Compose the world matrices that changed and place the static drawables of those entities (after the transform sync). */
  update(): void {
    this.world.update();
    this.placedNow = 0;
    const n = this.world.changedCount;
    for (let k = 0; k < n; k += 1) {
      const node = this.nodes.get(this.world.changedId(k));
      if (node !== undefined) this.place(node);
    }
    this.writes = { entities: n, drawables: this.placedNow, posed: 0 };
    this.writesTotal += n + this.placedNow;
  }

  /** Pose the animated hierarchies (after the animation step: their bones and drawables follow the mixer). */
  poseAnimated(): void {
    let posed = 0;
    for (const node of this.posed) {
      const h = this.held.get(node);
      // Its parts compose here only (see `collect`): on for this walk, off again after it.
      if (h !== undefined) for (const p of h.parts) if (p.posed) setAuto(p.object, p.matrixAutoUpdate, p.matrixWorldAutoUpdate);
      node.updateMatrixWorld(true);
      if (h !== undefined) for (const p of h.parts) if (p.posed) setAuto(p.object, false, false);
      if (h === undefined) continue;
      // Only these LODs moved: the next pick looks at them alone while the camera stays.
      for (const sw of h.switches) this.movedSwitches.add(sw);
      const parts = h.parts;
      posed += parts.length;
      if (this.membership !== null) for (const p of parts) if (p.listed) this.membership.moved(p.object);
    }
    if (posed > 0) {
      this.writes = { ...this.writes, posed };
      this.writesTotal += posed;
    }
  }

  /**
   * Pick every LOD's level from the camera and attach only that level's
   * drawables (before anything walks the scene: the batcher, the draw).
   */
  updateLods(camera: THREE.Camera): void {
    if (this.switches.size === 0) return;
    camera.updateMatrixWorld();
    const cam = this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const zoom = (camera as THREE.PerspectiveCamera).zoom ?? 1;
    // A still camera: only the LODs that moved (posed this frame) can change level; the others stay.
    const still = !this.lodsDirty && cam.equals(this.lodCam) && zoom === this.lodZoom;
    const which: Iterable<LodSwitch> = still ? this.movedSwitches : this.switches;
    this.lodsDirty = false;
    this.lodCam.copy(cam);
    this.lodZoom = zoom;
    for (const sw of which) {
      const e = sw.lod.matrixWorld.elements;
      // sqrt of the sum, not Math.hypot (several times slower in V8, over every LOD each frame the camera moves).
      const dx = cam.x - e[12]!;
      const dy = cam.y - e[13]!;
      const dz = cam.z - e[14]!;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) / zoom;
      const level = pickLodLevel(sw.lod.levels, distance, sw.active);
      if (level === sw.active) continue;
      sw.active = level;
      sw.lod.userData[LOD_LEVEL_KEY] = level;
      for (const p of sw.parts) this.gate(p);
    }
    this.movedSwitches.clear();
  }

  /**
   * The entities hidden now (by the simulation): they and their children
   * are not drawn (their drawables leave the scene). Returns the set with
   * the children included.
   */
  setHidden(own: ReadonlySet<string>): ReadonlySet<string> {
    const out = new Set<string>();
    if (own.size > 0) {
      const memo = new Map<string, boolean>();
      const hiddenUp = (id: string, depth: number): boolean => {
        const known = memo.get(id);
        if (known !== undefined) return known;
        let h = own.has(id);
        if (!h && depth < 64) {
          const parent = this.world.parentOf(id);
          if (parent !== null && parent !== undefined) h = hiddenUp(parent, depth + 1);
        }
        memo.set(id, h);
        return h;
      };
      for (const id of own) out.add(id);
      for (const id of this.nodes.keys()) if (hiddenUp(id, 0)) out.add(id);
    }
    const before = this.hidden;
    this.hidden = out;
    for (const [id, node] of this.nodes) {
      const h = out.has(id);
      if (h === before.has(id) && !this.dirtyVisibility) continue;
      // Hidden drawables leave the scene; lights are switched by the light selection (which leaves hidden ones off).
      for (const p of this.held.get(node)?.parts ?? []) {
        if ((p.object as THREE.Light).isLight === true) continue;
        p.hidden = h;
        this.gate(p);
      }
    }
    this.dirtyVisibility = false;
    return out;
  }

  /** Whether an entity (or an ancestor) is hidden now. */
  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }

  /** The scene's Object3Ds by kind, and the matrices written. */
  counts(): SceneGraphCounts {
    let objects = 0;
    let drawables = 0;
    let lights = 0;
    let bones = 0;
    let lods = 0;
    let containers = 0;
    const walk = (o: THREE.Object3D, underLod: boolean, light: THREE.Object3D | null): void => {
      objects += 1;
      const d = o as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean; isLOD?: boolean; isLight?: boolean; isBone?: boolean };
      if (d.isMesh === true || d.isLine === true || d.isPoints === true || d.isSprite === true) drawables += 1;
      else if (d.isLight === true || (light !== null && (light as THREE.SpotLight).target === o)) lights += 1;
      else if (d.isBone === true) bones += 1;
      else if (d.isLOD === true || underLod) lods += 1;
      else containers += 1;
      for (const c of o.children) walk(c, underLod || d.isLOD === true, d.isLight === true ? o : null);
    };
    for (const c of this.scene.children) walk(c, false, null);
    let listed = 0;
    let unattached = 0;
    const tally = (h: Holding): void => {
      for (const p of h.parts) {
        if (p.listed) listed += 1;
        else unattached += 1;
      }
    };
    for (const h of this.held.values()) tally(h);
    for (const h of this.loose.values()) tally(h);
    return { objects, drawables, lights, bones, lods, containers, entities: this.nodes.size, listed, lodSwitches: this.switches.size, unattached, matrixWrites: this.writes, matrixWritesTotal: this.writesTotal };
  }

  /** Release everything (the scene is being disposed). */
  dispose(): void {
    for (const node of [...this.nodes.keys()]) this.removeEntity(node);
    for (const o of [...this.loose.keys()]) this.unlistStatic(o);
  }

  /**
   * Walk `sub`: every drawable becomes a part (top-most ones; a static
   * mesh's child nodes are moved beside it first), every LOD a switch whose
   * levels gate the parts below them. `node` null: a loose object, whose
   * matrices are already right.
   */
  private collect(h: Holding, sub: THREE.Object3D, node: EntityNode | null, animated: boolean): void {
    const baked = node !== null && !animated;
    const offsetOf = (o: THREE.Object3D): THREE.Matrix4 => {
      const offset = new THREE.Matrix4();
      for (let n: THREE.Object3D | null = o; n !== null && n !== node; n = n.parent) {
        if (n.matrixAutoUpdate) n.updateMatrix();
        offset.premultiply(n.matrix);
      }
      return offset;
    };
    const visit = (o: THREE.Object3D, gates: readonly Gate[]): void => {
      const lod = o as THREE.LOD;
      if (lod.isLOD === true) {
        const sw: LodSwitch = { lod, owner: sub, offset: baked ? offsetOf(lod) : null, active: -1, parts: [] };
        h.switches.push(sw);
        this.switches.add(sw);
        this.lodsDirty = true;
        // Children that are not levels are drawn always (three draws every child of a LOD it shows).
        const levelObjects = new Set(lod.levels.map((l) => l.object));
        const others = lod.children.filter((c) => !levelObjects.has(c));
        lod.levels.forEach((l, i) => visit(l.object, [...gates, { sw, level: i }]));
        for (const c of others) visit(c, gates);
        return;
      }
      if (!isDrawable(o)) {
        for (const c of [...o.children]) visit(c, gates);
        return;
      }
      const offset = baked ? offsetOf(o) : null;
      const posed = node !== null && offset === null;
      const part: Part = { object: o, owner: sub, offset, gates, listed: false, hidden: false, matrixAutoUpdate: o.matrixAutoUpdate, matrixWorldAutoUpdate: o.matrixWorldAutoUpdate, posed };
      // Placed (static, loose) or posed by its hierarchy (animated): either way the scene's own matrix walks
      // (the renderer's, the batcher's, the texture streamer's) have nothing to compose for it. A posed part
      // left to them was composed again on every walk (Skyforge's village: ~170 character parts, 1–2 walks a frame).
      o.matrixAutoUpdate = false;
      o.matrixWorldAutoUpdate = false;
      // Posed by its hierarchy every frame: its shadow is drawn every frame, never cached.
      if (node !== null && animated) o.userData[MOVING_CASTER_KEY] = true;
      h.parts.push(part);
      for (const g of gates) g.sw.parts.push(part);
      const nearest = gates[gates.length - 1];
      if (nearest !== undefined) o.traverse((x) => void (x.userData[LOD_OWNER_KEY] = nearest.sw.lod));
      this.dirtyVisibility = true;
      this.gate(part);
      // A static mesh's child nodes would come into the scene with it: they hang beside it, their offset baked.
      if (baked && o.children.length > 0 && (o as THREE.Light).isLight !== true && o.parent !== null && o.parent !== node) {
        const parent = o.parent;
        for (const c of [...o.children]) {
          if (c.matrixAutoUpdate) c.updateMatrix();
          h.hoists.push({ object: c, from: o, owner: sub, matrix: c.matrix.clone(), matrixAutoUpdate: c.matrixAutoUpdate });
          o.remove(c);
          c.matrix.premultiply(o.matrix);
          c.matrixAutoUpdate = false;
          parent.add(c);
          visit(c, gates);
        }
      }
    };
    visit(sub, []);
  }

  /** Let go of what came from `owner` (null: everything): parts leave the scene, moved nodes go back. */
  private release(h: Holding, owner: THREE.Object3D | null): void {
    const mine = (x: { owner: THREE.Object3D }): boolean => owner === null || x.owner === owner;
    const keepParts: Part[] = [];
    for (const p of h.parts) {
      if (!mine(p)) {
        keepParts.push(p);
        continue;
      }
      if (p.listed) this.unlistObject(p.object);
      p.listed = false;
      // Gone for good from what this graph holds (a merged copy of it goes too).
      this.membership?.dropped(p.object);
      if (p.gates.length > 0) p.object.traverse((x) => void delete x.userData[LOD_OWNER_KEY]);
      delete p.object.userData[MOVING_CASTER_KEY];
      p.object.matrixAutoUpdate = p.matrixAutoUpdate;
      p.object.matrixWorldAutoUpdate = p.matrixWorldAutoUpdate;
    }
    h.parts = keepParts;
    const keepSwitches: LodSwitch[] = [];
    for (const sw of h.switches) {
      if (!mine(sw)) {
        keepSwitches.push(sw);
        continue;
      }
      this.switches.delete(sw);
      this.movedSwitches.delete(sw);
      delete sw.lod.userData[LOD_LEVEL_KEY];
    }
    h.switches = keepSwitches;
    const keepHoists: Hoist[] = [];
    for (const m of h.hoists) {
      if (!mine(m)) {
        keepHoists.push(m);
        continue;
      }
      m.object.removeFromParent();
      m.object.matrix.copy(m.matrix);
      m.object.matrixAutoUpdate = m.matrixAutoUpdate;
      m.from.add(m.object);
    }
    h.hoists = keepHoists;
    // A new part list may show it hidden or not: visibility is set again at the next `setHidden`.
    this.dirtyVisibility = true;
  }

  /** In the scene or not, as its LOD levels and the hidden entities say. */
  private gate(p: Part): void {
    let on = !p.hidden;
    for (const g of p.gates) {
      if (g.sw.active !== g.level) {
        on = false;
        break;
      }
    }
    if (on === p.listed) return;
    p.listed = on;
    if (on) this.listObject(p.object);
    else this.unlistObject(p.object);
  }

  private place(node: EntityNode): void {
    const i = this.world.indexOf(node.entityId);
    if (i === undefined) return;
    node.matrix.fromArray(this.world.world, i * 16);
    node.matrixWorld.copy(node.matrix);
    const h = this.held.get(node);
    if (h === undefined) return;
    for (const p of h.parts) {
      if (p.offset === null) continue;
      p.object.matrixWorld.multiplyMatrices(node.matrixWorld, p.offset);
      this.placedNow += 1;
      if (p.listed) {
        this.membership?.moved(p.object);
        this.noteStatic(p.object, true);
      }
    }
    for (const sw of h.switches) {
      if (sw.offset === null) continue;
      sw.lod.matrixWorld.multiplyMatrices(node.matrixWorld, sw.offset);
      this.lodsDirty = true;
    }
  }

  /**
   * In the scene's children without leaving its logical parent: three walks
   * `children` to draw and to update world matrices, and a listed object's
   * world matrix is either written here or composed from that parent.
   */
  private listObject(o: THREE.Object3D): void {
    if (this.inScene.has(o) || this.parked.has(o)) return;
    this.inScene.set(o, this.scene.children.length);
    this.scene.children.push(o);
    this.membership?.listed(o);
    this.noteStatic(o);
  }

  private unlistObject(o: THREE.Object3D): void {
    if (this.parked.delete(o)) {
      this.membership?.unlisted(o);
      this.noteStatic(o);
      return;
    }
    if (!this.inScene.has(o)) return;
    this.detach(o);
    this.membership?.unlisted(o);
    this.noteStatic(o);
  }

  /** A static shadow caster changed what the static shadow map shows: where it stands, or (`moved`) anywhere. */
  private noteStatic(o: THREE.Object3D, moved = false): void {
    if (this.staticChanged !== null && isStaticCaster(o)) this.staticChanged(moved ? null : o);
  }

  /** Out of the scene's children (no longer in `inScene`). */
  private detach(o: THREE.Object3D): void {
    const hint = this.inScene.get(o);
    if (hint === undefined) return;
    this.inScene.delete(o);
    const children = this.scene.children;
    const i = children[hint] === o ? hint : children.indexOf(o);
    if (i < 0) return;
    // The last child takes its place (no shift of every later child); its hint follows it.
    const last = children.pop()!;
    if (last !== o) {
      children[i] = last;
      if (this.inScene.has(last)) this.inScene.set(last, i);
    }
  }
}
