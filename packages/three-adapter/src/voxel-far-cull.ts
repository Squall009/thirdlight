/**
 * A far brick group's nodes as copies the GPU culls one by one (occlusion
 * culling's depth pyramid path, occlusion-instances.ts, WebGPU): rows of the
 * same culled-instance table as kit pieces and terrain nodes, no second
 * culling path.
 *
 * - **A node's 16 floats** are its instance data and its world box in one
 *   layout ({@link FAR_NODE_FLOATS}): its corner (metres from the group's
 *   corner) and cell size; its page's origin and its marched box's low
 *   corner packed in one float; from `COPY_BOX_FLOAT` its world box, the
 *   box's high corner packed in the low half's spare float. The draw's
 *   vertex stage reads the first twelve through the culled list when the GPU
 *   culls it (`culledCopyVec4`), its own instance attributes otherwise; the
 *   world box is the culler's only (the shader never reads it).
 * - **Tested in compute** as boxes, in the far draws' depth mapping
 *   (far-depth.ts), against the frustum's sides and this frame's pyramid:
 *   the groups are drawn after it (`AFTER_PYRAMID_KEY`), so the pyramid holds
 *   the near field and every other draw of the first pass, and a node behind
 *   them never reaches the fragment stage. Worth testing whatever its twelve
 *   triangles: a node's cost is its march.
 * - **Every pass but the view's** (none draws the far field now) and every
 *   renderer without the pyramid path (WebGL 2) draws every node from the
 *   draw's own attributes, as before.
 * - Nodes out of view stay resident: the culling only leaves them out of
 *   the frame's draw.
 */
import * as THREE from 'three';

import { CULLABLE_COPIES_KEY, CULLED_COPIES_ATTRIBUTE, INSTANCE_CULLER_KEY, type CullableCopies, type InstanceCullerHost, type InstanceIndirect, type InstanceViewDraw } from './attribute-instancing';
import { COPY_BOX_FLOAT, COPY_FLOATS } from './occlusion-instances-rule';
import { AFTER_PYRAMID_KEY, wantPyramidPath } from './occlusion-passes';
import type { FarCover } from './voxel-far-common';

/** Floats a far node takes in its group's instance buffer (the culler's copy layout). */
export const FAR_NODE_FLOATS = COPY_FLOATS;

/** Where a node's floats sit: corner + cell size, page + packed low corner, the world box from `COPY_BOX_FLOAT` (its spare float the packed high corner). */
export const FAR_NODE_CORNER_FLOAT = 0;
export const FAR_NODE_PAGE_FLOAT = 4;
export const FAR_NODE_LO_FLOAT = 7;
export const FAR_NODE_HI_FLOAT = COPY_BOX_FLOAT + 3;

/** The float the culled marker views (the world box's high half's spare float: never read through it). */
const MARKER_FLOAT = COPY_BOX_FLOAT + 7;

/** A marched box's corners are on quarter cells from −1 up: packed a byte an axis (x lowest), exact in a float. */
export const FAR_BOX_STEPS = 4;
export const FAR_BOX_FROM = -1;

/** A marched box corner (node cells, three axes) as one float: a byte an axis, quarter cells from −1. */
export function packFarBoxCorner(c: readonly number[]): number {
  let v = 0;
  for (let a = 2; a >= 0; a--) {
    const q = Math.round((c[a]! - FAR_BOX_FROM) * FAR_BOX_STEPS);
    if (q < 0 || q > 255) throw new RangeError(`far node box: corner ${c[a]} cells out of the packed range`);
    v = v * 256 + q;
  }
  return v;
}

/** {@link packFarBoxCorner} undone. */
export function unpackFarBoxCorner(v: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    out[a] = (v % 256) / FAR_BOX_STEPS + FAR_BOX_FROM;
    v = Math.floor(v / 256);
  }
  return out;
}

export class FarNodeCopies implements CullableCopies {
  indirect: InstanceIndirect | null = null;
  readonly boxes = true;
  readonly nested = true;
  readonly fragmentBound = true;
  readonly farDepth = true;
  private drawnOnce = false;
  private version = 0;
  private packedFor = -1;
  private readonly world = new Float64Array(16);
  private readonly spheres: Float32Array;
  private readonly order: Uint32Array;
  /** The nodes the culler copies, in their order (16 floats a place; a place's node is its slot). */
  private readonly drawn: Float32Array;
  private readonly view: InstanceViewDraw & { version: number; count: number };
  private coverVersion = -1;
  /** Nodes left out of the view's draw because the near field hides them whole. */
  covered = 0;

  constructor(
    readonly mesh: THREE.Mesh,
    /** The group's instance buffer (its nodes' {@link FAR_NODE_FLOATS} each). */
    private readonly buffer: THREE.InstancedInterleavedBuffer,
    /** Each node's box, metres from the group's corner (min xyz, max xyz). */
    private readonly local: Float32Array,
    readonly capacity: number,
    /** Where the near field hides the far field (a node wholly inside is never drawn by the view). */
    private readonly cover: Pick<FarCover, 'hides' | 'version'> | null = null,
  ) {
    this.spheres = new Float32Array(capacity * 4);
    this.order = new Uint32Array(capacity);
    this.drawn = new Float32Array(capacity * FAR_NODE_FLOATS);
    this.view = { version: 0, count: capacity, drawn: this.drawn, order: this.order, spheres: this.spheres };
    mesh.userData[CULLABLE_COPIES_KEY] = this;
    mesh.userData[AFTER_PYRAMID_KEY] = true;
  }

  /** Right before a draw (the group mesh's `onBeforeRender`): `view` is the view's draw. */
  beforeDraw(scene: THREE.Object3D, view: boolean): void {
    // The view's march is what the pyramid path saves: occlusion `auto` turns it on for the scene.
    if (view) wantPyramidPath(scene);
    // A culler on the GPU takes the draw before its first render object is made (its build reads nodes by list).
    if (this.indirect === null) (scene.userData[INSTANCE_CULLER_KEY] as InstanceCullerHost | undefined)?.adopt(this);
    this.drawnOnce = true;
    this.indirect?.draw(this.mesh.geometry as THREE.InstancedBufferGeometry, view);
  }

  viewDraw(): InstanceViewDraw | null {
    const m = this.mesh.matrixWorld.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      if (this.world[i] === m[i]) continue;
      this.world[i] = m[i]!;
      moved = true;
    }
    if (moved || (this.cover !== null && this.cover.version !== this.coverVersion)) this.version++;
    if (this.packedFor !== this.version) this.pack();
    this.view.version = this.version;
    return this.view;
  }

  markCulled(on: boolean): void {
    const g = this.mesh.geometry;
    if ((g.getAttribute(CULLED_COPIES_ATTRIBUTE) !== undefined) === on) return;
    if (on) g.setAttribute(CULLED_COPIES_ATTRIBUTE, new THREE.InterleavedBufferAttribute(this.buffer, 1, MARKER_FLOAT));
    else {
      g.deleteAttribute(CULLED_COPIES_ATTRIBUTE);
      (g as THREE.InstancedBufferGeometry & { indirect: unknown }).indirect = null;
    }
    // three keeps a render object's program until its material's version changes.
    if (this.drawnOnce) for (const mat of Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material]) mat.needsUpdate = true;
  }

  /** The group's draw is gone: the culler lets go. */
  dispose(): void {
    this.indirect?.release();
    this.indirect = null;
    if (this.mesh.userData[CULLABLE_COPIES_KEY] === this) delete this.mesh.userData[CULLABLE_COPIES_KEY];
  }

  /**
   * The nodes' world boxes into their floats (the culler's; the draw never reads them, so nothing is uploaded) and
   * their spheres; the nodes the near field hides whole go last, out of the view's count.
   */
  private pack(): void {
    this.packedFor = this.version;
    this.coverVersion = this.cover?.version ?? -1;
    const d = this.buffer.array as Float32Array;
    const w = this.world;
    const b = this.local;
    for (let p = 0; p < this.capacity; p++) {
      const o = p * FAR_NODE_FLOATS;
      let r2 = 0;
      const q = p * 6;
      const cx = (b[q]! + b[q + 3]!) / 2;
      const cy = (b[q + 1]! + b[q + 4]!) / 2;
      const cz = (b[q + 2]! + b[q + 5]!) / 2;
      const ex = (b[q + 3]! - b[q]!) / 2;
      const ey = (b[q + 4]! - b[q + 1]!) / 2;
      const ez = (b[q + 5]! - b[q + 2]!) / 2;
      // The box in the world: its centre moved, its half extents through the matrix's absolute values.
      for (let a = 0; a < 3; a++) {
        const cw = w[a]! * cx + w[4 + a]! * cy + w[8 + a]! * cz + w[12 + a]!;
        const ew = Math.abs(w[a]!) * ex + Math.abs(w[4 + a]!) * ey + Math.abs(w[8 + a]!) * ez;
        d[o + COPY_BOX_FLOAT + a] = cw - ew;
        d[o + COPY_BOX_FLOAT + 4 + a] = cw + ew;
        this.spheres[p * 4 + a] = cw;
        r2 += ew * ew;
      }
      this.spheres[p * 4 + 3] = Math.sqrt(r2);
    }
    // The view's order: shown nodes first (each place's node is its slot; the culler copies `drawn` by place).
    let n = 0;
    let last = this.capacity;
    for (let p = 0; p < this.capacity; p++) {
      const o = p * FAR_NODE_FLOATS + COPY_BOX_FLOAT;
      const hidden = this.cover !== null && this.cover.hides(d.subarray(o, o + 3), d.subarray(o + 4, o + 7));
      const place = hidden ? --last : n++;
      this.order[place] = p;
      this.drawn.set(d.subarray(p * FAR_NODE_FLOATS, (p + 1) * FAR_NODE_FLOATS), place * FAR_NODE_FLOATS);
    }
    this.covered = this.capacity - n;
    this.view.count = n;
  }
}
