/**
 * A terrain page's nodes as copies the GPU may cull one by one (occlusion
 * culling's depth pyramid path, occlusion-instances.ts): one draw a page
 * stays, the view's draw lists the nodes in view that the pyramid shows.
 *
 * The page's selection (terrain-quadtree.ts) puts the nodes in view first,
 * each with its box (its square over the tile's height bounds). The culler
 * copies each node's eight floats into the first half of a copy's sixteen in
 * its pools and its world box into the second (tested as a box: a node is
 * flat, its sphere would reach far above it), and the terrain's vertex stage
 * reads the node through the list (`culledCopyVec4`). A node's visibility from last frame is kept by
 * its place in the selection: when the selection changes, a place names
 * another node, which costs the first pass some of its draws (they move to
 * the second) but never a node seen in the finished frame.
 *
 * Kept out of terrain-view.ts, which makes one per page mesh (its near and
 * far ground) and tells it when its nodes were uploaded or its geometry made
 * anew.
 */
import * as THREE from 'three';

import { CULLABLE_COPIES_KEY, CULLED_COPIES_ATTRIBUTE, INSTANCE_CULLER_KEY, type CullableCopies, type InstanceCullerHost, type InstanceIndirect, type InstanceViewDraw } from './attribute-instancing';
import { COPY_BOX_FLOAT, COPY_FLOATS } from './occlusion-instances-rule';
import { TERRAIN_NODE_BOX_FLOATS, TERRAIN_NODE_FLOATS, type PageNodes } from './terrain-quadtree';
/** The node float the marker views (never read through it: the marker only names the build). */
const MARKER_FLOAT = TERRAIN_NODE_FLOATS - 1;

/** What a page's mesh draws its nodes with (the geometry and buffer are made anew when the nodes outgrow them). */
export interface NodeDrawTarget {
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly buffer: THREE.InstancedInterleavedBuffer;
}

export class TerrainNodeCopies implements CullableCopies {
  indirect: InstanceIndirect | null = null;
  readonly boxes = true;
  /** The geometry has render objects (a new mark builds its programs again). */
  private drawnOnce = false;
  private version = 0;
  private packedFor = -1;
  private drawn = new Float32Array(0);
  private order = new Uint32Array(0);
  private spheres = new Float32Array(0);
  private readonly world = new Float64Array(16);
  private readonly viewDrawn = { version: 0, count: 0, drawn: this.drawn, order: this.order, spheres: this.spheres };

  constructor(
    readonly mesh: THREE.Mesh,
    /** What the mesh draws its nodes with now. */
    private readonly drawing: () => NodeDrawTarget,
    private readonly nodes: PageNodes,
    /** Whether the nodes were selected for the current view (their leading `inView` are what it sees). */
    private readonly selectedForView: () => boolean,
  ) {
    mesh.userData[CULLABLE_COPIES_KEY] = this;
  }

  get capacity(): number {
    return this.drawing().buffer.count;
  }

  /** The nodes were uploaded (a new selection). */
  uploaded(): void {
    this.version += 1;
  }

  /** The geometry was made anew (more nodes than it held): the culler lets go and adopts it again, with its capacity. */
  renewed(): void {
    this.indirect?.release();
    this.indirect = null;
    this.drawnOnce = false;
    this.version += 1;
  }

  /** Right before a draw (the page mesh's `onBeforeRender`, after it set its count): `view` is the view's draw of its selected nodes. */
  beforeDraw(scene: THREE.Object3D | null | undefined, view: boolean): void {
    if (!this.drawnOnce) {
      // A culler on the GPU takes the draw before its first render object is made (its build reads nodes by list).
      (scene?.userData[INSTANCE_CULLER_KEY] as InstanceCullerHost | undefined)?.adopt(this);
      this.drawnOnce = true;
    }
    this.indirect?.draw(this.drawing().geometry, view);
  }

  viewDraw(): InstanceViewDraw | null {
    if (!this.selectedForView()) return null;
    const m = this.mesh.matrixWorld.elements;
    let moved = false;
    for (let i = 0; i < 16; i += 1) {
      if (this.world[i] === m[i]) continue;
      this.world[i] = m[i]!;
      moved = true;
    }
    if (moved) this.version += 1;
    if (this.packedFor !== this.version) this.pack();
    this.viewDrawn.version = this.version;
    this.viewDrawn.count = this.nodes.inView;
    return this.viewDrawn;
  }

  markCulled(on: boolean): void {
    const g = this.drawing().geometry;
    if ((g.getAttribute(CULLED_COPIES_ATTRIBUTE) !== undefined) === on) return;
    if (on) g.setAttribute(CULLED_COPIES_ATTRIBUTE, new THREE.InterleavedBufferAttribute(this.drawing().buffer, 1, MARKER_FLOAT));
    else {
      g.deleteAttribute(CULLED_COPIES_ATTRIBUTE);
      (g as THREE.InstancedBufferGeometry & { indirect: unknown }).indirect = null;
    }
    // three keeps a render object's program until its material's version changes.
    if (this.drawnOnce) for (const mat of Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material]) mat.needsUpdate = true;
  }

  /** The page is gone. */
  dispose(): void {
    this.indirect?.release();
    this.indirect = null;
    if (this.mesh.userData[CULLABLE_COPIES_KEY] === this) delete this.mesh.userData[CULLABLE_COPIES_KEY];
  }

  /** The nodes in view as the culler copies them: their floats in each copy's first half, their world boxes after them, their spheres, in their order. */
  private pack(): void {
    this.packedFor = this.version;
    const n = this.nodes.inView;
    if (this.drawn.length < n * COPY_FLOATS) {
      const size = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
      this.drawn = new Float32Array(size * COPY_FLOATS);
      this.spheres = new Float32Array(size * 4);
      this.order = new Uint32Array(size);
      for (let i = 0; i < size; i += 1) this.order[i] = i;
      this.viewDrawn.drawn = this.drawn;
      this.viewDrawn.spheres = this.spheres;
      this.viewDrawn.order = this.order;
    }
    const data = this.nodes.data;
    const boxes = this.nodes.boxes;
    const w = this.world;
    const B = TERRAIN_NODE_BOX_FLOATS;
    for (let p = 0; p < n; p += 1) {
      const o = p * COPY_FLOATS;
      for (let k = 0; k < TERRAIN_NODE_FLOATS; k += 1) this.drawn[o + k] = data[p * TERRAIN_NODE_FLOATS + k]!;
      // The box in the world: its centre moved, its half extents through the matrix's absolute values.
      let r2 = 0;
      const cx = (boxes[p * B]! + boxes[p * B + 3]!) / 2;
      const cy = (boxes[p * B + 1]! + boxes[p * B + 4]!) / 2;
      const cz = (boxes[p * B + 2]! + boxes[p * B + 5]!) / 2;
      const ex = (boxes[p * B + 3]! - boxes[p * B]!) / 2;
      const ey = (boxes[p * B + 4]! - boxes[p * B + 1]!) / 2;
      const ez = (boxes[p * B + 5]! - boxes[p * B + 2]!) / 2;
      for (let a = 0; a < 3; a += 1) {
        const c = w[a]! * cx + w[4 + a]! * cy + w[8 + a]! * cz + w[12 + a]!;
        const e = Math.abs(w[a]!) * ex + Math.abs(w[4 + a]!) * ey + Math.abs(w[8 + a]!) * ez;
        this.drawn[o + COPY_BOX_FLOAT + a] = c - e;
        this.drawn[o + COPY_BOX_FLOAT + 4 + a] = c + e;
        this.spheres[p * 4 + a] = c;
        r2 += e * e;
      }
      this.spheres[p * 4 + 3] = Math.sqrt(r2);
    }
  }
}
