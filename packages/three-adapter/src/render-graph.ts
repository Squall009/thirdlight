/**
 * The three.js scene as a flat list of what is drawn.
 *
 * three.js walks its whole scene graph twice a frame (world matrices, then
 * the render list), so every Object3D in it costs time whether it draws or
 * not. Here the entities live in the engine's own data instead: their world
 * matrices in a `WorldMatrices` table, composed from the frame's interpolated
 * transforms; and the scene's children are only drawables — meshes,
 * instanced meshes, LODs and lights.
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
 * Entities with nothing to draw (logic-only objects, empty markers) have a
 * table row and no Object3D at all.
 */
import * as THREE from 'three';
import { WorldMatrices } from '@thirdlight/runtime';

/** Whether three draws an object itself (a mesh, line, points, sprite, an LOD switch or a light). */
export function isDrawable(o: THREE.Object3D): boolean {
  const d = o as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean; isLOD?: boolean; isLight?: boolean };
  return d.isMesh === true || d.isLine === true || d.isPoints === true || d.isSprite === true || d.isLOD === true || d.isLight === true;
}

/** One listed drawable of an entity. */
interface Part {
  readonly object: THREE.Object3D;
  /** The subtree it came from (the object added to the node). */
  readonly owner: THREE.Object3D;
  /** Its offset from the entity (null: animated, it follows its logical parent). */
  readonly offset: THREE.Matrix4 | null;
  /** What it had before it was listed (restored when it leaves). */
  readonly matrixAutoUpdate: boolean;
  readonly matrixWorldAutoUpdate: boolean;
  readonly visible: boolean;
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
  /** LOD switches and the level nodes below them that draw nothing themselves. */
  readonly lods: number;
  /** Anything else: groups and empty nodes (the target is none). */
  readonly containers: number;
  /** Entity nodes (outside the scene) and the drawables they listed in it. */
  readonly entities: number;
  readonly listed: number;
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

export class RenderGraph {
  /** Every realized entity's world matrix. */
  readonly world = new WorldMatrices();
  private readonly scene: THREE.Scene;
  private readonly animated: (entityId: string) => boolean;
  private readonly nodes = new Map<string, EntityNode>();
  private readonly parts = new Map<EntityNode, Part[]>();
  /** Drawables listed on their own (block chunks), with what they had before. */
  private readonly loose = new Map<THREE.Object3D, { matrixAutoUpdate: boolean; matrixWorldAutoUpdate: boolean }>();
  /** Nodes whose hierarchy is posed after the animation step. */
  private readonly posed = new Set<EntityNode>();
  /** Entities hidden by themselves or an ancestor. */
  private hidden: ReadonlySet<string> = new Set();
  /** Bumped when entities or their parts change (the hidden set is derived again). */
  revision = 0;
  /** A part was listed or unlisted since the last `setHidden`: every node's parts are set again. */
  private dirtyVisibility = false;

  constructor(scene: THREE.Scene, animated: (entityId: string) => boolean) {
    this.scene = scene;
    this.animated = animated;
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
      for (const p of [...(this.parts.get(node) ?? [])]) this.unlistPart(p);
      this.parts.delete(node);
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

  /** List `sub`'s top-most drawables (it was just added to `node`). */
  show(node: EntityNode, sub: THREE.Object3D): void {
    let animated = this.animated(node.entityId);
    if (!animated) sub.traverse((o) => void ((o as THREE.SkinnedMesh).isSkinnedMesh === true && (animated = true)));
    const list = this.parts.get(node) ?? [];
    this.parts.set(node, list);
    const visit = (o: THREE.Object3D): void => {
      if (!isDrawable(o)) {
        for (const c of o.children) visit(c);
        return;
      }
      let offset: THREE.Matrix4 | null = null;
      if (!animated) {
        offset = new THREE.Matrix4();
        for (let n: THREE.Object3D | null = o; n !== null && n !== node; n = n.parent) {
          if (n.matrixAutoUpdate) n.updateMatrix();
          offset.premultiply(n.matrix);
        }
      }
      const part: Part = { object: o, owner: sub, offset, matrixAutoUpdate: o.matrixAutoUpdate, matrixWorldAutoUpdate: o.matrixWorldAutoUpdate, visible: o.visible };
      if (offset !== null) {
        o.matrixAutoUpdate = false;
        o.matrixWorldAutoUpdate = false;
      }
      list.push(part);
      this.listObject(o);
    };
    visit(sub);
    if (animated) this.posed.add(node);
    this.place(node);
    this.revision += 1;
  }

  /** `sub` leaves `node`: its drawables leave the scene and get back what they had. */
  hide(node: EntityNode, sub: THREE.Object3D): void {
    const list = this.parts.get(node);
    if (list === undefined) return;
    const keep: Part[] = [];
    for (const p of list) {
      if (p.owner === sub) this.unlistPart(p);
      else keep.push(p);
    }
    this.parts.set(node, keep);
    if (keep.every((p) => p.offset !== null)) this.posed.delete(node);
    this.revision += 1;
  }

  /** List a drawable that places itself (its world matrix is already right and stays as it is). */
  listStatic(o: THREE.Object3D): void {
    if (this.loose.has(o)) return;
    this.loose.set(o, { matrixAutoUpdate: o.matrixAutoUpdate, matrixWorldAutoUpdate: o.matrixWorldAutoUpdate });
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
    this.listObject(o);
  }

  unlistStatic(o: THREE.Object3D): void {
    const was = this.loose.get(o);
    if (was === undefined) return;
    this.loose.delete(o);
    this.unlistObject(o);
    o.matrixAutoUpdate = was.matrixAutoUpdate;
    o.matrixWorldAutoUpdate = was.matrixWorldAutoUpdate;
  }

  /** Compose the world matrices and place every static drawable (after the transform sync). */
  update(): void {
    this.world.update();
    for (const node of this.nodes.values()) this.place(node);
  }

  /** Pose the animated hierarchies (after the animation step: their bones and drawables follow the mixer). */
  poseAnimated(): void {
    for (const node of this.posed) node.updateMatrixWorld(true);
  }

  /**
   * The entities hidden now (by the simulation): they and their children
   * are not drawn. Returns the set with the children included.
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
      // Lights are switched by the light selection (which leaves hidden ones off).
      for (const p of this.parts.get(node) ?? []) if ((p.object as THREE.Light).isLight !== true) p.object.visible = p.visible && !h;
    }
    this.dirtyVisibility = false;
    return out;
  }

  /** Whether an entity (or an ancestor) is hidden now. */
  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }

  /** The scene's Object3Ds by kind. */
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
    let listed = this.loose.size;
    for (const list of this.parts.values()) listed += list.length;
    return { objects, drawables, lights, bones, lods, containers, entities: this.nodes.size, listed };
  }

  /** Release everything (the scene is being disposed). */
  dispose(): void {
    for (const node of [...this.nodes.keys()]) this.removeEntity(node);
    for (const o of [...this.loose.keys()]) this.unlistStatic(o);
  }

  private place(node: EntityNode): void {
    const i = this.world.indexOf(node.entityId);
    if (i === undefined) return;
    node.matrix.fromArray(this.world.world, i * 16);
    node.matrixWorld.copy(node.matrix);
    for (const p of this.parts.get(node) ?? []) {
      if (p.offset !== null) p.object.matrixWorld.multiplyMatrices(node.matrixWorld, p.offset);
    }
  }

  private unlistPart(p: Part): void {
    this.unlistObject(p.object);
    p.object.matrixAutoUpdate = p.matrixAutoUpdate;
    p.object.matrixWorldAutoUpdate = p.matrixWorldAutoUpdate;
    if ((p.object as THREE.Light).isLight !== true) p.object.visible = p.visible;
    // A new part list may show it hidden or not: visibility is set again at the next `setHidden`.
    this.dirtyVisibility = true;
  }

  /**
   * In the scene's children without leaving its logical parent: three walks
   * `children` to draw and to update world matrices, and a listed object's
   * world matrix is either written here or composed from that parent.
   */
  private listObject(o: THREE.Object3D): void {
    if (this.scene.children.includes(o)) return;
    this.scene.children.push(o);
    this.dirtyVisibility = true;
  }

  private unlistObject(o: THREE.Object3D): void {
    const i = this.scene.children.indexOf(o);
    if (i >= 0) this.scene.children.splice(i, 1);
  }
}
