/**
 * A voxel world's far field as ray-marched distance bricks
 * (`@thirdlight/voxel` far-bricks.ts), the far field's draw (the meshes of
 * voxel-far-mesh.ts are its fallback; that module groups the nodes and owns
 * the draws); this module keeps the bricks on the GPU and makes a group's
 * draw.
 *
 * - **Atlas.** Every drawn brick's 9³ samples are a region of one shared
 *   3D texture (the distances, r8, filtered, so one read is the trilinear
 *   sample) and of a twin (each sample's baked colour and occlusion, RGBA8,
 *   filtered, so one read is the eight samples' blend), the voxel surface's
 *   region store (`VoxelShaderGrids`): a node's bricks are uploaded alone
 *   when it arrives (`queue.writeTexture` on WebGPU, `texSubImage3D` on
 *   WebGL 2) and their regions given back when it goes; the atlas grows by
 *   a copy on the GPU and gives back what its released bricks left at its
 *   end ({@link VoxelShaderGrids.trim}). Each node's brick table is a page of two more stores.
 * - **Draw.** A node is one instance of its stored bricks' marched boxes'
 *   union, all of a group in one instanced draw with one material for every
 *   group. The box's back faces are drawn (the camera may be inside one),
 *   and the fragment walks the node's brick table in ray order (a DDA over
 *   its 4³ bricks, `marchFarNode`), marching each stored brick over its own
 *   box (the build's bounds, grown by the skirt's lip on the node faces it
 *   lies on; `marchBrickBox`, step for step: the same field, skirt, hit
 *   distance, shortest step and step count) and stepping over the rest: one
 *   fragment a node a pixel. A ray that leaves the node first is discarded,
 *   so the nodes behind it show.
 * - **Shading.** The normal is the samples' gradient at the hit (inside the
 *   brick: a skirt is shaded like the surface it hangs from), the colour
 *   and occlusion one filtered read of the baked samples, lit by the scene's
 *   lights like the meshes (voxel-far-brick-field.ts). On WebGPU the march
 *   writes only the hit (its brick, place and depth) into a visibility
 *   target and one full-screen draw shades every far pixel once from it
 *   (voxel-far-visibility.ts); elsewhere each fragment shades its own hit.
 * - **Depth.** The hit's own depth is written (the far draws' mapping,
 *   voxel-far-common.ts), so bricks, far meshes and the near field sort
 *   against each other per pixel; hits under the near cover are discarded,
 *   and in its edge ring put behind the near field.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial, NodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { bakeFarBrick, bakeFineFarBrick, farBrickOctant, BRICK_HIT_VOXELS, FAR_DEEP_CELLS, FAR_FINE_DEEP_CELLS, FAR_INSIDE_LOOK_M, FAR_BRICK_BAKED_BYTES, type FarPalette, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_BRICK_BLOCK_BYTES, FAR_BRICK_BOUNDS_BYTES, FAR_BRICK_LIP_CELLS, FAR_BRICK_SKIRT_SLOPE, FAR_BRICK_STEPS, farBrickCount, farNodeMarchedBox, VOXEL_SIZE_M, type FarBricks, type FarCellBox, type FarNodeDraw } from '@thirdlight/voxel';

import { culledCopyVec4, culledDepthAt } from './attribute-instancing';
import { cameraRelative, cameraRelativeModelView } from './camera-relative';
import type { N } from './effects-tsl';
import { entryFace, entryFaceCode, INSIDE_FACE_CODE, type FarBrickTextures } from './voxel-far-brick-field';
import { farClipPosition, farFragmentDepth, type FarCover } from './voxel-far-common';
import { COPY_BOX_FLOAT, HIDDEN_DEPTH_MARGIN } from './occlusion-instances-rule';
import { declareVertexReach } from './vertex-reach';
import { FAR_BOX_FROM, FAR_BOX_STEPS, FAR_NODE_CORNER_FLOAT, FAR_NODE_FLOATS, FAR_NODE_HI_FLOAT, FAR_NODE_LO_FLOAT, FAR_NODE_PAGE_FLOAT, packFarBoxCorner } from './voxel-far-cull';
import { FAR_FINE_CELL_M_BELOW, type FarFineShade } from './voxel-far-fine-shade';
import { farVisibilityMaterial, farVisibilityOutput } from './voxel-far-visibility';
import { VoxelShaderGrids, type RegionTexels, type VoxelGridRenderer, type VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Break, Discard, Fn, If, Loop, abs, cameraPosition, cameraProjectionMatrix, clamp, float, floor, int, ivec3, length, max, min, mod, modelWorldMatrix, modelWorldMatrixInverse, normalize, positionGeometry, property, round, screenCoordinate, screenSize, select, varying, vec3, vec4 } = TSL;

/** A packed box corner (voxel-far-cull.ts) in node cells. */
function unpackCorner(v: N): N {
  const byte = (k: number): N => mod(floor(v.div(256 ** k)), 256).div(FAR_BOX_STEPS).add(FAR_BOX_FROM);
  return vec3(byte(0), byte(1), byte(2));
}

/** A hit's distance from the surface may be this share of the pixel it covers: no step finer than the pixel shows. */
export const FAR_BRICK_HIT_PIXELS = 0.5;


/**
 * The far bricks on the GPU: the distances and, beside them in step, each
 * sample's baked colour and occlusion (from the palette), a brick a region
 * in each store; and each node's brick table, a page in two more stores.
 */
export class FarBrickAtlas {
  readonly distance = new VoxelShaderGrids({ side: DISTANCE_BRICK_SIDE }, { format: THREE.RedFormat, bytes: 1, filter: THREE.LinearFilter });
  /** The baked samples: linear colour and occlusion, filtered so one read is the eight samples' blend. */
  readonly colours = new VoxelShaderGrids({ side: DISTANCE_BRICK_SIDE }, { format: THREE.RGBAFormat, bytes: 4, filter: THREE.LinearFilter });
  /**
   * Each node's brick table for the node march, a region of a node's bricks a side: a stored brick's region (in
   * regions, RGB) and 255 in A, else 0; and beside it the brick's bounds (low + 16 × high a byte an axis) and its node
   * faces.
   */
  readonly pages: VoxelShaderGrids;
  readonly pageBounds: VoxelShaderGrids;
  private readonly scratch = new Uint8Array(DISTANCE_BRICK_SAMPLES * FAR_BRICK_BAKED_BYTES);

  constructor(nodeBricks = 4) {
    const page: RegionTexels = { format: THREE.RGBAFormat, bytes: 4, filter: THREE.NearestFilter };
    this.pages = new VoxelShaderGrids({ side: nodeBricks }, page);
    this.pageBounds = new VoxelShaderGrids({ side: nodeBricks }, page);
  }

  /** Bricks resident. */
  get count(): number {
    return this.distance.count;
  }

  get gpuBytes(): number {
    return this.distance.gpuBytes + this.colours.gpuBytes + this.pages.gpuBytes + this.pageBounds.gpuBytes;
  }

  /** A node's brick table (its bricks' regions as {@link add} gave them); its page's origin (null: no brick stored). */
  addPage(renderer: VoxelGridRenderer, b: FarBricks, regions: readonly THREE.Vector3[], octants = 0): THREE.Vector3 | null {
    if (regions.length === 0) return null;
    const at = this.pages.allocate(renderer);
    const twin = this.pageBounds.allocate(renderer);
    if (!at.equals(twin)) throw new Error('far brick atlas: the two page stores parted');
    this.writePage(renderer, at, b, regions, octants);
    return at;
  }

  /**
   * A node's brick table written again with the bricks of the octants set in `octants` (bit x + 2y + 4z of the
   * node's halves) left out: finer nodes draw there, and the march passes through as through air.
   */
  writePage(renderer: VoxelGridRenderer, at: THREE.Vector3, b: FarBricks, regions: readonly THREE.Vector3[], octants: number): void {
    const n = b.bricks.length;
    const table = new Uint8Array(n * 4);
    const bounds = new Uint8Array(n * 4);
    const S = DISTANCE_BRICK_SIDE;
    for (let i = 0; i < n; i++) {
      const k = b.bricks[i]!;
      if (k < 0) continue;
      if (octants !== 0 && (octants >> farBrickOctant(i, b.side)) & 1) continue;
      const r = regions[k]!;
      table.set([r.x / S, r.y / S, r.z / S, 255], i * 4);
      const q = k * FAR_BRICK_BOUNDS_BYTES;
      const bb = b.bounds;
      bounds.set([bb[q]! + 16 * bb[q + 3]!, bb[q + 1]! + 16 * bb[q + 4]!, bb[q + 2]! + 16 * bb[q + 5]!, b.blocks[k * FAR_BRICK_BLOCK_BYTES + 3]!], i * 4);
    }
    this.pages.upload(renderer, at, table);
    this.pageBounds.upload(renderer, at, bounds);
  }

  /** Gives a node's page back. */
  removePage(at: THREE.Vector3): void {
    this.pages.release(at);
    this.pageBounds.release(at);
  }

  /**
   * Uploads a node's bricks, one region each (baked from `palette`; `'words'`: a fine node's, its samples' look words as
   * the GPU build writes them); their regions (texel origins), in block order.
   */
  add(renderer: VoxelGridRenderer, b: FarBricks, palette: FarPalette | null | 'words' = null): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const n = farBrickCount(b);
    for (let i = 0; i < n; i++) {
      const at = this.distance.allocate(renderer);
      const twin = this.colours.allocate(renderer);
      // Both stores hand out and grow alike, so a brick's two regions share an origin.
      if (!at.equals(twin)) throw new Error('far brick atlas: the two region stores parted');
      this.distance.upload(renderer, at, b.samples.subarray(i * DISTANCE_BRICK_SAMPLES, (i + 1) * DISTANCE_BRICK_SAMPLES));
      this.bake(renderer, b, i, at, palette);
      out.push(at);
    }
    return out;
  }

  /** A node's baked samples again from a new palette (its regions as {@link add} gave them). */
  recolour(renderer: VoxelGridRenderer, b: FarBricks, regions: readonly THREE.Vector3[], palette: FarPalette): void {
    for (let i = 0; i < regions.length; i++) this.bake(renderer, b, i, regions[i]!, palette);
  }

  private bake(renderer: VoxelGridRenderer, b: FarBricks, i: number, at: THREE.Vector3, palette: FarPalette | null | 'words'): void {
    if (palette === null) this.scratch.fill(0);
    else if (palette === 'words') bakeFineFarBrick(b, i, this.scratch);
    else bakeFarBrick(b, i, palette, this.scratch);
    this.colours.upload(renderer, at, this.scratch);
  }

  /** Gives a node's regions back. */
  remove(regions: readonly THREE.Vector3[]): void {
    for (const r of regions) {
      this.distance.release(r);
      this.colours.release(r);
    }
  }

  /**
   * Gives back the atlas's space its released bricks and pages left at its end (the stores in step: they hand out
   * and give back alike). True when a store shrank.
   */
  trim(renderer: VoxelGridRenderer): boolean {
    const bricks = this.distance.trim(renderer);
    if (this.colours.trim(renderer) !== bricks || this.colours.capacity !== this.distance.capacity) throw new Error('far brick atlas: the two region stores parted');
    const pages = this.pages.trim(renderer);
    if (this.pageBounds.trim(renderer) !== pages || this.pageBounds.capacity !== this.pages.capacity) throw new Error('far brick atlas: the two page stores parted');
    return bricks || pages;
  }

  /** Textures replaced by a growth or a trim are disposed once no frame binds them. */
  frame(): void {
    this.distance.frame();
    this.colours.frame();
    this.pages.frame();
    this.pageBounds.frame();
  }

  dispose(): void {
    this.distance.dispose();
    this.colours.dispose();
    this.pages.dispose();
    this.pageBounds.dispose();
  }
}

/** The unit box (0–1) a brick instance scales: 8 corners, 12 triangles wound outward. */
function unitBox(): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const p = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    p[i * 3] = i & 1;
    p[i * 3 + 1] = (i >> 1) & 1;
    p[i * 3 + 2] = (i >> 2) & 1;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  // −x, +x, −y, +y, −z, +z faces (outward, counter-clockwise from outside).
  geo.setIndex([0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6]);
  return geo;
}

/**
 * The node draws' per-instance vec4s (views of one buffer, voxel-far-cull.ts's layout): the node's corner (metres
 * from the group's corner) and cell size; its page's origin and its box's packed low corner (node cells); its world
 * box's low half (the culler's) and the box's packed high corner.
 */
export const FAR_NODE_ATTRIBUTE = 'voxelFarNode';
export const FAR_NODE_PAGE_ATTRIBUTE = 'voxelFarNodePage';
export const FAR_NODE_BOX_ATTRIBUTE = 'voxelFarNodeBox';

/** A brick group's draw and the culler's view of its nodes. */
export interface FarNodeDraws {
  readonly geometry: THREE.InstancedBufferGeometry;
  /** The nodes' {@link FAR_NODE_FLOATS} each. */
  readonly buffer: THREE.InstancedInterleavedBuffer;
  /** Each node's box, metres from the group's corner (min xyz, max xyz). */
  readonly boxes: Float32Array;
  readonly count: number;
}

/**
 * A brick group's draw as an instance a node (the node march): its corner and cell size, its page in the atlas's
 * page stores, and its box (the union of its stored bricks' marched boxes, node cells).
 */
export function farNodeGeometry(edge: number, g: { readonly level: number; readonly cell: readonly [number, number, number] }, nodes: readonly FarNodeDraw[], pages: (n: FarNodeDraw) => THREE.Vector3 | undefined): FarNodeDraws {
  const drawn: Array<{ d: FarNodeDraw; page: THREE.Vector3; box: FarCellBox }> = [];
  for (const d of nodes) {
    const page = pages(d);
    const box = d.bricks !== undefined ? farNodeMarchedBox(d.bricks) : null;
    if (page !== undefined && box !== null) drawn.push({ d, page, box });
  }
  const data = new Float32Array(Math.max(1, drawn.length) * FAR_NODE_FLOATS);
  const boxes = new Float32Array(drawn.length * 6);
  const cellM = 2 ** g.level * VOXEL_SIZE_M;
  drawn.forEach(({ d, page: p, box }, k) => {
    const o = k * FAR_NODE_FLOATS;
    const corner = [(d.nx * edge * 2 ** g.level - g.cell[0]) * VOXEL_SIZE_M, (d.ny * edge * 2 ** g.level - g.cell[1]) * VOXEL_SIZE_M, (d.nz * edge * 2 ** g.level - g.cell[2]) * VOXEL_SIZE_M];
    data.set([corner[0]!, corner[1]!, corner[2]!, cellM], o + FAR_NODE_CORNER_FLOAT);
    data.set([p.x, p.y, p.z], o + FAR_NODE_PAGE_FLOAT);
    data[o + FAR_NODE_LO_FLOAT] = packFarBoxCorner(box.lo);
    data[o + FAR_NODE_HI_FLOAT] = packFarBoxCorner(box.hi);
    for (let a = 0; a < 3; a++) {
      boxes[k * 6 + a] = corner[a]! + box.lo[a]! * cellM;
      boxes[k * 6 + 3 + a] = corner[a]! + box.hi[a]! * cellM;
    }
  });
  const geometry = unitBox();
  // Static usage: written once (a group's nodes change by a new draw).
  const buffer = new THREE.InstancedInterleavedBuffer(data, FAR_NODE_FLOATS, 1);
  geometry.setAttribute(FAR_NODE_ATTRIBUTE, new THREE.InterleavedBufferAttribute(buffer, 4, FAR_NODE_CORNER_FLOAT));
  geometry.setAttribute(FAR_NODE_PAGE_ATTRIBUTE, new THREE.InterleavedBufferAttribute(buffer, 4, FAR_NODE_PAGE_FLOAT));
  geometry.setAttribute(FAR_NODE_BOX_ATTRIBUTE, new THREE.InterleavedBufferAttribute(buffer, 4, COPY_BOX_FLOAT));
  geometry.instanceCount = drawn.length;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return { geometry, buffer, boxes, count: drawn.length };
}

/**
 * What a brick draw writes: `lit` its hit shaded and lit in the frame (the march shades each fragment), `visibility` the visibility target's
 * texel (voxel-far-visibility.ts: the hit's brick, place, depth and entry face; shaded once a pixel after).
 */
export type FarBrickOutput = 'lit' | 'visibility';

/**
 * The brick draws' material, one for every brick group: the node march, the
 * baked shading and the hit's depth, over the atlas.
 */
export class FarBrickMaterial {
  readonly material: NodeMaterial;

  /** `nodeBricks`: bricks a side of a node (the march walks that many an axis); `fine` shades fine bricks' hits (their samples hold look words). */
  constructor(textures: FarBrickTextures, cover: FarCover, fine: FarFineShade, nodeBricks = 4, readonly output: FarBrickOutput = 'lit') {
    const lit = output === 'lit';
    const m = cameraRelative(lit ? new MeshStandardNodeMaterial() : (farVisibilityMaterial() as MeshStandardNodeMaterial));
    m.name = `voxel far bricks${lit ? '' : ' (visibility)'}`;
    m.metalness = 0;
    m.roughness = 1;
    m.side = THREE.BackSide;
    // Its vertices stay inside each node's box (the culler's): the box's own corners, placed by the instance.
    declareVertexReach(m, () => 0);
    this.material = m;
    const pagesNode = textures.pages;
    const pageBoundsNode = textures.pageBounds;
    const C = DISTANCE_BRICK_CELLS;
    const L = FAR_BRICK_LIP_CELLS;
    const field = (region: N, p: N): N => textures.field(region, p);
    const safe = (c: N): N => select(abs(c).lessThan(1e-8), select(c.lessThan(0), float(-1e-8), float(1e-8)), c);
    // A box's growth by the lip on the node faces a brick lies on (`faces` the face bits), where its bounds reach them.
    const lipped = (bLo: N, bHi: N, faces: N): { lo: N; hi: N } => {
      const bit = (b: number): N => mod(floor(faces.div(b)), 2);
      const atLo = vec3(select(bLo.x.lessThan(0.5), float(1), float(0)), select(bLo.y.lessThan(0.5), float(1), float(0)), select(bLo.z.lessThan(0.5), float(1), float(0)));
      const atHi = vec3(select(bHi.x.greaterThan(C - 0.5), float(1), float(0)), select(bHi.y.greaterThan(C - 0.5), float(1), float(0)), select(bHi.z.greaterThan(C - 0.5), float(1), float(0)));
      return { lo: bLo.sub(vec3(bit(1), bit(4), bit(16)).mul(atLo).mul(L)), hi: bHi.add(vec3(bit(2), bit(8), bit(32)).mul(atHi).mul(L)) };
    };
    // The draw's model-view (made in 64 bits on the CPU): the hit's view position and normal.
    const modelView: N = cameraRelativeModelView;
    const hitNormal = property('vec3', 'farBrickNormal');
    const hitColour = property('vec3', 'farBrickColour');
    const hitViewZ = property('float', 'farBrickViewZ');
    const hitPayload = property('vec4', 'farBrickTexel');
    // Radians a pixel covers at the screen's centre: how big a pixel is at a distance.
    const pixelAngle = float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y));
    // Cells a pixel covers a cell along the ray (the camera sits at t = 0 in the node's frame).
    const pixelCells = pixelAngle.mul(FAR_BRICK_HIT_PIXELS);

    /**
     * One brick's march over its box (brick cells, `lo`–`hi`) from where the ray enters it: as `marchBrickBox`, step
     * for step. Sets `hit` and leaves `t` at the hit, `near` the entry's per-axis distances (the face it entered by).
     * With the eye inside the node's box (`eyeIn`), a ray whose first sample lies inside the solid (the eye inside a
     * coarse stand-in, under its surface) is not hit until it has left that solid (`inside` until then; `seen` once
     * its first sample is taken), so the stand-in is not seen from inside; `first` keeps where it began. From outside
     * the box a ray entering a side under the surface meets the side, as before: it is the step to a neighbour drawn
     * lower, seen from beside it (passing through it would show the sky where the hill is).
     */
    const marchBrick = (region: N, o: N, dir: N, inv: N, lo: N, hi: N, t: N, hit: N, near: N, inside: N, seen: N, first: N, eyeIn: N): void => {
      const ta = lo.sub(o).mul(inv);
      const tb = hi.sub(o).mul(inv);
      near.assign(min(ta, tb));
      const far = max(ta, tb);
      const t1 = min(min(far.x, far.y), far.z).toVar();
      t.assign(max(max(max(near.x, near.y), near.z), float(0)));
      If(t.lessThanEqual(t1), () => {
        Loop(FAR_BRICK_STEPS, () => {
          const p = o.add(dir.mul(t)).toVar();
          const f = field(region, p).toVar();
          const solid = f.lessThan(max(float(BRICK_HIT_VOXELS), t.mul(pixelCells))).toVar();
          If(seen.lessThan(0.5), () => {
            seen.assign(1);
            If(solid.and(eyeIn), () => {
              inside.assign(1);
              first.assign(t);
            });
          });
          If(inside.greaterThan(0.5).and(solid.not()), () => {
            inside.assign(0);
          });
          If(solid.and(inside.lessThan(0.5)), () => {
            hit.assign(1);
            Break();
          });
          If(t.greaterThanEqual(t1), () => {
            Break();
          });
          // The skirt's field grows faster than the distance: its steps are shortened to match. Inside the solid the
          // distance to its surface is the field's negative.
          const q = clamp(p, vec3(0), vec3(C));
          const d = select(inside.greaterThan(0.5), f.negate(), f);
          const step = select(length(p.sub(q)).greaterThan(0), d.div(1 + FAR_BRICK_SKIRT_SLOPE), d);
          t.assign(min(t1, t.add(max(step, float(BRICK_MIN_STEP_VOXELS)))));
        });
      });
    };

    // The instance's frame: its corner (metres from the group's corner), cell size, box (cells) and its page, read
    // through the culled list where the GPU culls the draw.
    const inst = culledCopyVec4(FAR_NODE_ATTRIBUTE, FAR_NODE_CORNER_FLOAT / 4);
    const pageLo = culledCopyVec4(FAR_NODE_PAGE_ATTRIBUTE, FAR_NODE_PAGE_FLOAT / 4);
    const corner = inst.xyz;
    const cellM = inst.w;
    const lo = unpackCorner(pageLo.w);
    const hi = unpackCorner(culledCopyVec4(FAR_NODE_BOX_ATTRIBUTE, COPY_BOX_FLOAT / 4).w);
    const nodePage = varying(pageLo.xyz);
    m.positionNode = corner.add(lo.add(positionGeometry.mul(hi.sub(lo))).mul(cellM));
    const vCellM = varying(cellM);
    const vCorner = varying(corner);
    const vLo = varying(lo);
    const vHi = varying(hi);
    const vLocal = varying(corner.add(lo.add(positionGeometry.mul(hi.sub(lo))).mul(cellM)));
    m.depthNode = Fn(() => {
      const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
      const dir = normalize(vLocal.sub(camLocal)).toVar();
      // The camera in the instance's cells.
      const o = camLocal.sub(vCorner).div(vCellM).toVar();
      const inv = vec3(float(1).div(safe(dir.x)), float(1).div(safe(dir.y)), float(1).div(safe(dir.z))).toVar();
      const hit = float(0).toVar();
      const t = float(0).toVar();
      const near = vec3(0).toVar();
      // The hit's brick: its atlas region and its corner in the instance's cells.
      const region = vec3(0).toVar();
      const brick = vec3(0).toVar();
      // A ray that starts inside the solid: whether it still is, whether its first sample is taken, where it began
      // (t, its brick and region, its entry face).
      const inside = float(0).toVar();
      const seen = float(0).toVar();
      const firstT = float(0).toVar();
      const firstRegion = vec3(0).toVar();
      const firstBrick = vec3(0).toVar();
      const firstNear = vec3(0).toVar();
      {
        // The node's box, then its bricks in ray order (a DDA over the node's 4³ brick table, as `marchFarNode`).
        const ta = vLo.sub(o).mul(inv);
        const tb = vHi.sub(o).mul(inv);
        const tFar = max(ta, tb);
        const entryT = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z));
        const t0 = max(entryT, float(0));
        // The eye inside the node's box: the box's entry lies behind it.
        const eyeIn = entryT.lessThanEqual(0);
        const t1 = min(min(tFar.x, tFar.y), tFar.z).toVar();
        // Where the GPU culls the draw it is drawn after the pyramid of everything drawn before it (the near field):
        // a ray whose entry into the node's box lies behind that already, meets nothing in front of it, so it is
        // discarded before its march (its hits are farther along the ray, their depths larger).
        const before = culledDepthAt(screenCoordinate);
        If(before.y.greaterThan(0.5), () => {
          const entry = modelView.mul(vec4(vCorner.add(o.add(dir.mul(t0)).mul(vCellM)), 1));
          If(farFragmentDepth(entry.z).mul(before.z).greaterThan(before.x.add(HIDDEN_DEPTH_MARGIN)), () => {
            Discard();
          });
        });
        const side = float(nodeBricks);
        const cell = clamp(floor(o.add(dir.mul(t0)).div(C)), vec3(0), vec3(side.sub(1))).toVar();
        const stepV = vec3(select(dir.x.lessThan(0), float(-1), float(1)), select(dir.y.lessThan(0), float(-1), float(1)), select(dir.z.lessThan(0), float(-1), float(1))).toVar();
        const tMax = cell.add(max(stepV, vec3(0))).mul(C).sub(o).mul(inv).toVar();
        const tDelta = abs(inv.mul(C)).toVar();
        const page = nodePage;
        Loop(3 * nodeBricks, () => {
          const at = page.add(cell);
          const entry = pagesNode.load(ivec3(int(at.x), int(at.y), int(at.z))).toVar();
          If(entry.a.greaterThan(0.5), () => {
            const bounds = pageBoundsNode.load(ivec3(int(at.x), int(at.y), int(at.z)));
            const b = round(bounds.mul(255)).toVar();
            const box = lipped(vec3(mod(b.x, 16), mod(b.y, 16), mod(b.z, 16)), vec3(floor(b.x.div(16)), floor(b.y.div(16)), floor(b.z.div(16))), b.w);
            region.assign(round(entry.rgb.mul(255)).mul(DISTANCE_BRICK_SIDE));
            brick.assign(cell.mul(C));
            const was = seen.toVar();
            marchBrick(region, o.sub(brick), dir, inv, box.lo, box.hi, t, hit, near, inside, seen, firstT, eyeIn);
            If(was.lessThan(0.5).and(inside.greaterThan(0.5)), () => {
              firstRegion.assign(region);
              firstBrick.assign(brick);
              firstNear.assign(near);
            });
          });
          If(hit.greaterThan(0.5), () => {
            Break();
          });
          const tn = min(min(tMax.x, tMax.y), tMax.z);
          If(tn.greaterThanEqual(t1), () => {
            Break();
          });
          If(tMax.x.lessThanEqual(tn), () => {
            cell.x.addAssign(stepV.x);
            tMax.x.addAssign(tDelta.x);
          })
            .ElseIf(tMax.y.lessThanEqual(tn), () => {
              cell.y.addAssign(stepV.y);
              tMax.y.addAssign(tDelta.y);
            })
            .Else(() => {
              cell.z.addAssign(stepV.z);
              tMax.z.addAssign(tDelta.z);
            });
          If(cell.x.lessThan(0).or(cell.y.lessThan(0)).or(cell.z.lessThan(0)).or(cell.x.greaterThan(side.sub(0.5))).or(cell.y.greaterThan(side.sub(0.5))).or(cell.z.greaterThan(side.sub(0.5))), () => {
            Break();
          });
        });
      }
      // Never out of the solid it started in: hit where it began, shaded as the ground's look from above (no hole, no
      // view of the stand-in's cells from inside).
      const insideHit = hit.lessThan(0.5).and(inside.greaterThan(0.5)).toVar();
      If(insideHit, () => {
        hit.assign(1);
        t.assign(firstT);
        region.assign(firstRegion);
        brick.assign(firstBrick);
        near.assign(firstNear);
      });
      If(hit.lessThan(0.5), () => {
        Discard();
      });
      // The hit in its brick's cells, and in the group's metres.
      const p = o.sub(brick).add(dir.mul(t)).toVar();
      const local = vCorner.add(brick.add(p).mul(vCellM));
      const world = modelWorldMatrix.mul(vec4(local, 1)).xyz.toVar();
      If(cover.covered(world), () => {
        Discard();
      });
      const face = entryFace(near, dir);
      const view = modelView.mul(vec4(local, 1));
      // A fine node's bricks (built on the GPU) hold look words where a coarse node's hold colours.
      const isFine = vCellM.lessThan(FAR_FINE_CELL_M_BELOW);
      // A hit deep in the solid near the eye: a stand-in's side entered under its surface, seen from beside it while
      // hugging the ground. Drawn as the ground's look, not as the side's cells (whose unstored bricks show as recesses).
      // On a fine node at any distance: there a side entered under the surface is only ever the seam where a fine
      // neighbour (level 1 beside level 0) lies a cell or so lower, and drawn as its face it is a dark dashed line.
      const deep = field(region, p).lessThan(select(isFine, float(-FAR_FINE_DEEP_CELLS), float(-FAR_DEEP_CELLS)));
      const look = insideHit.or(deep.and(view.z.greaterThan(-FAR_INSIDE_LOOK_M).or(isFine)));
      if (output === 'visibility') {
        hitPayload.assign(farVisibilityOutput(region, p, view.z, select(look, float(INSIDE_FACE_CODE), entryFaceCode(face)), select(isFine, float(1), float(0))));
        return farFragmentDepth(cover.behindNear(world, view.z));
      }
      // Deep under the surface (the samples clamped to the band) there is no gradient: a ray hits there only where a
      // node face shows its ground's side (a neighbour drawn at a coarser level lies lower), shaded as that face.
      const shaded = textures.shade(region, p, face, look);
      hitNormal.assign(normalize(modelView.mul(vec4(shaded.normal, 0)).xyz));
      hitColour.assign(shaded.colour);
      // Here a fine hit takes its palette's colour (the visibility pass's shade textures it); only its fragments read it.
      If(isFine, () => {
        hitColour.assign(fine.palette(region, p, look));
      });
      hitViewZ.assign(cover.behindNear(world, view.z));
      return farFragmentDepth(hitViewZ);
    })();
    if (output === 'visibility') {
      m.outputNode = hitPayload;
    } else {
      m.colorNode = vec4(hitColour, 1);
      m.normalNode = hitNormal;
    }
    // The boxes reach past the camera's far plane: placed with the far depth, never clipped there (the fragment writes its own).
    m.vertexNode = farClipPosition();
  }

  dispose(): void {
    this.material.dispose();
  }
}
