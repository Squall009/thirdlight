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
 *   a copy on the GPU. Each node's brick table is a page of two more stores.
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
 *   lights like the meshes.
 * - **Depth.** The hit's own depth is written (the far draws' mapping,
 *   voxel-far-common.ts), so bricks, far meshes and the near field sort
 *   against each other per pixel; hits under the near cover are discarded,
 *   and in its edge ring put behind the near field.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial, NodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { bakeFarBrick, BRICK_HIT_VOXELS, FAR_BRICK_AO_FLOOR, FAR_BRICK_BAKED_BYTES, FAR_BRICK_GRADIENT_MIN, type FarPalette, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_BRICK_BLOCK_BYTES, FAR_BRICK_BOUNDS_BYTES, FAR_BRICK_LIP_CELLS, FAR_BRICK_SKIRT_SLOPE, FAR_BRICK_STEPS, farBrickCount, farNodeMarchedBox, VOXEL_SIZE_M, type FarBricks, type FarCellBox, type FarNodeDraw } from '@thirdlight/voxel';

import { cameraRelative, cameraRelativeModelView } from './camera-relative';
import type { N } from './effects-tsl';
import { texelTexture3D } from './texel-texture-node';
import { farClipPosition, farFragmentDepth, type FarCover } from './voxel-far-common';
import { farHalfOutput } from './voxel-far-half';
import { VoxelShaderGrids, type RegionTexels, type VoxelGridRenderer, type VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Break, Discard, Fn, If, Loop, abs, attribute, cameraPosition, cameraProjectionMatrix, clamp, float, floor, int, ivec3, length, max, min, mix, mod, modelWorldMatrix, modelWorldMatrixInverse, normalize, positionGeometry, property, round, screenSize, select, sign, texture3D, uniform, varying, vec3, vec4 } = TSL;

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
  addPage(renderer: VoxelGridRenderer, b: FarBricks, regions: readonly THREE.Vector3[]): THREE.Vector3 | null {
    if (regions.length === 0) return null;
    const n = b.bricks.length;
    const table = new Uint8Array(n * 4);
    const bounds = new Uint8Array(n * 4);
    const S = DISTANCE_BRICK_SIDE;
    for (let i = 0; i < n; i++) {
      const k = b.bricks[i]!;
      if (k < 0) continue;
      const r = regions[k]!;
      table.set([r.x / S, r.y / S, r.z / S, 255], i * 4);
      const q = k * FAR_BRICK_BOUNDS_BYTES;
      const bb = b.bounds;
      bounds.set([bb[q]! + 16 * bb[q + 3]!, bb[q + 1]! + 16 * bb[q + 4]!, bb[q + 2]! + 16 * bb[q + 5]!, b.blocks[k * FAR_BRICK_BLOCK_BYTES + 3]!], i * 4);
    }
    const at = this.pages.allocate(renderer);
    const twin = this.pageBounds.allocate(renderer);
    if (!at.equals(twin)) throw new Error('far brick atlas: the two page stores parted');
    this.pages.upload(renderer, at, table);
    this.pageBounds.upload(renderer, at, bounds);
    return at;
  }

  /** Gives a node's page back. */
  removePage(at: THREE.Vector3): void {
    this.pages.release(at);
    this.pageBounds.release(at);
  }

  /** Uploads a node's bricks, one region each (baked from `palette`); their regions (texel origins), in block order. */
  add(renderer: VoxelGridRenderer, b: FarBricks, palette: FarPalette | null = null): THREE.Vector3[] {
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

  private bake(renderer: VoxelGridRenderer, b: FarBricks, i: number, at: THREE.Vector3, palette: FarPalette | null): void {
    if (palette === null) this.scratch.fill(0);
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

  /** Textures replaced by a growth are disposed once no frame binds them. */
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

/** The node draws' per-instance attributes: the node's corner (metres from the group's corner) and cell size; its page's origin; its box (node cells). */
export const FAR_NODE_ATTRIBUTE = 'voxelFarNode';
export const FAR_NODE_PAGE_ATTRIBUTE = 'voxelFarNodePage';
export const FAR_NODE_LO_ATTRIBUTE = 'voxelFarNodeLo';
export const FAR_NODE_HI_ATTRIBUTE = 'voxelFarNodeHi';

/**
 * A brick group's draw as an instance a node (the node march): its corner and cell size, its page in the atlas's
 * page stores, and its box (the union of its stored bricks' marched boxes, node cells).
 */
export function farNodeGeometry(edge: number, g: { readonly level: number; readonly cell: readonly [number, number, number] }, nodes: readonly FarNodeDraw[], pages: (n: FarNodeDraw) => THREE.Vector3 | undefined): THREE.InstancedBufferGeometry {
  const drawn: Array<{ d: FarNodeDraw; page: THREE.Vector3; box: FarCellBox }> = [];
  for (const d of nodes) {
    const page = pages(d);
    const box = d.bricks !== undefined ? farNodeMarchedBox(d.bricks) : null;
    if (page !== undefined && box !== null) drawn.push({ d, page, box });
  }
  const inst = new Float32Array(drawn.length * 4);
  const page = new Float32Array(drawn.length * 4);
  const lo = new Float32Array(drawn.length * 3);
  const hi = new Float32Array(drawn.length * 3);
  const cellM = 2 ** g.level * VOXEL_SIZE_M;
  drawn.forEach(({ d, page: p, box }, k) => {
    inst.set([(d.nx * edge * 2 ** g.level - g.cell[0]) * VOXEL_SIZE_M, (d.ny * edge * 2 ** g.level - g.cell[1]) * VOXEL_SIZE_M, (d.nz * edge * 2 ** g.level - g.cell[2]) * VOXEL_SIZE_M, cellM], k * 4);
    page.set([p.x, p.y, p.z, 0], k * 4);
    lo.set(box.lo, k * 3);
    hi.set(box.hi, k * 3);
  });
  const geometry = unitBox();
  geometry.setAttribute(FAR_NODE_ATTRIBUTE, new THREE.InstancedBufferAttribute(inst, 4));
  geometry.setAttribute(FAR_NODE_PAGE_ATTRIBUTE, new THREE.InstancedBufferAttribute(page, 4));
  geometry.setAttribute(FAR_NODE_LO_ATTRIBUTE, new THREE.InstancedBufferAttribute(lo, 3));
  geometry.setAttribute(FAR_NODE_HI_ATTRIBUTE, new THREE.InstancedBufferAttribute(hi, 3));
  geometry.instanceCount = drawn.length;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geometry;
}

/**
 * The brick draws' material, one for every brick group: the node march, the
 * baked shading and the hit's depth, over the atlas.
 */
export class FarBrickMaterial {
  readonly material: MeshStandardNodeMaterial;
  private readonly distanceNode: N;
  /** The atlas's baked colours. */
  private readonly coloursNode: N;
  private readonly invSideU = uniform(new THREE.Vector3(1, 1, 1));

  /**
   * `nodeBricks`: bricks a side of a node (the march walks that many an axis). `half`: the program draws into
   * the half-resolution target (voxel-far-half.ts: colour, normal and depth packed, unlit) instead of the frame.
   */
  constructor(atlas: FarBrickAtlas, cover: FarCover, nodeBricks = 4, readonly half = false) {
    const m = cameraRelative(half ? (new NodeMaterial() as MeshStandardNodeMaterial) : new MeshStandardNodeMaterial());
    m.name = `voxel far bricks${half ? ' (half resolution)' : ''}`;
    m.metalness = 0;
    m.roughness = 1;
    m.side = THREE.BackSide;
    this.material = m;
    this.distanceNode = texture3D(atlas.distance.texture);
    this.coloursNode = texture3D(atlas.colours.texture);
    const pagesNode = texelTexture3D(atlas.pages.texture);
    const pageBoundsNode = texelTexture3D(atlas.pageBounds.texture);
    this.sides(atlas.distance.texture);
    atlas.distance.onTexture = (tex) => {
      (this.distanceNode as unknown as { value: THREE.Texture }).value = tex;
      this.sides(tex);
    };
    atlas.colours.onTexture = (tex) => {
      (this.coloursNode as unknown as { value: THREE.Texture }).value = tex;
    };
    atlas.pages.onTexture = (tex) => {
      (pagesNode as unknown as { value: THREE.Texture }).value = tex;
    };
    atlas.pageBounds.onTexture = (tex) => {
      (pageBoundsNode as unknown as { value: THREE.Texture }).value = tex;
    };
    const C = DISTANCE_BRICK_CELLS;
    const L = FAR_BRICK_LIP_CELLS;
    const invSide = this.invSideU;
    const distanceNode = this.distanceNode;
    const coloursNode = this.coloursNode;
    // The stored distance (cells) at a point inside a brick (cells 0–8 an axis) at atlas region `region`: one filtered read, the trilinear sample.
    const sampled = (region: N, q: N): N => distanceNode.sample(region.add(q).add(0.5).mul(invSide)).level(float(0)).r.mul(2).sub(1).mul(DISTANCE_BRICK_BAND_VOXELS);
    const inBrick = (p: N): N => clamp(p, vec3(0), vec3(C));
    // The field at a point of a brick (cells): its sample, and past the box its skirt (as `farBrickField`).
    const field = (region: N, p: N): N => {
      const q = inBrick(p);
      return sampled(region, q).add(length(p.sub(q)).mul(FAR_BRICK_SKIRT_SLOPE));
    };
    // The surface's normal at a hit: the samples' gradient read inside the brick only (a skirt is shaded as the surface
    // it hangs from, as a far mesh's skirt takes its edge's normal), one-sided where the brick's side cuts the step.
    const gradient = (region: N, p: N): N => {
      const axis = (e: N): N => {
        const a = inBrick(p.add(e));
        const b = inBrick(p.sub(e));
        return sampled(region, a).sub(sampled(region, b)).div(max(length(a.sub(b)), float(1e-3)));
      };
      return vec3(axis(vec3(0.5, 0, 0)), axis(vec3(0, 0.5, 0)), axis(vec3(0, 0, 0.5)));
    };
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
    // Radians a pixel covers at the screen's centre: how big a pixel is at a distance.
    const pixelAngle = float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y));
    // Cells a pixel covers a cell along the ray (the camera sits at t = 0 in the node's frame).
    const pixelCells = pixelAngle.mul(FAR_BRICK_HIT_PIXELS);

    /**
     * One brick's march over its box (brick cells, `lo`–`hi`) from where the ray enters it: as `marchBrickBox`, step
     * for step. Sets `hit` and leaves `t` at the hit, `near` the entry's per-axis distances (the face it entered by).
     */
    const marchBrick = (region: N, o: N, dir: N, inv: N, lo: N, hi: N, t: N, hit: N, near: N): void => {
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
          If(f.lessThan(max(float(BRICK_HIT_VOXELS), t.mul(pixelCells))), () => {
            hit.assign(1);
            Break();
          });
          If(t.greaterThanEqual(t1), () => {
            Break();
          });
          // The skirt's field grows faster than the distance: its steps are shortened to match.
          const q = clamp(p, vec3(0), vec3(C));
          const step = select(length(p.sub(q)).greaterThan(0), f.div(1 + FAR_BRICK_SKIRT_SLOPE), f);
          t.assign(min(t1, t.add(max(step, float(BRICK_MIN_STEP_VOXELS)))));
        });
      });
    };

    // The instance's frame: its corner (metres from the group's corner), cell size, box (cells) and its page.
    const inst = attribute(FAR_NODE_ATTRIBUTE, 'vec4');
    const corner = inst.xyz;
    const cellM = inst.w;
    const lo = attribute(FAR_NODE_LO_ATTRIBUTE, 'vec3');
    const hi = attribute(FAR_NODE_HI_ATTRIBUTE, 'vec3');
    const nodePage = varying(attribute(FAR_NODE_PAGE_ATTRIBUTE, 'vec4').xyz);
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
      {
        // The node's box, then its bricks in ray order (a DDA over the node's 4³ brick table, as `marchFarNode`).
        const ta = vLo.sub(o).mul(inv);
        const tb = vHi.sub(o).mul(inv);
        const tFar = max(ta, tb);
        const t0 = max(max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z)), float(0));
        const t1 = min(min(tFar.x, tFar.y), tFar.z).toVar();
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
            marchBrick(region, o.sub(brick), dir, inv, box.lo, box.hi, t, hit, near);
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
      // Deep under the surface (the samples clamped to the band) there is no gradient: a ray hits there only where a
      // node face shows its ground's side (a neighbour drawn at a coarser level lies lower), shaded as that face.
      const g = gradient(region, p).toVar();
      const entryX = near.x.greaterThanEqual(near.y).and(near.x.greaterThanEqual(near.z));
      const entryY = entryX.not().and(near.y.greaterThanEqual(near.z));
      const entryZ = entryX.not().and(entryY.not());
      const facing = vec3(select(entryX, sign(dir.x).negate(), float(0)), select(entryY, sign(dir.y).negate(), float(0)), select(entryZ, sign(dir.z).negate(), float(0)));
      const n = select(length(g).greaterThan(FAR_BRICK_GRADIENT_MIN), normalize(g), facing);
      hitNormal.assign(normalize(modelView.mul(vec4(n, 0)).xyz));
      // One filtered read: the eight samples' colours and occlusions blended by the hit's weights.
      const q = clamp(p, vec3(0), vec3(C));
      const c = coloursNode.sample(region.add(q).add(0.5).mul(invSide)).level(float(0));
      hitColour.assign(c.rgb.mul(mix(float(FAR_BRICK_AO_FLOOR), float(1), c.a)));
      const view = modelView.mul(vec4(local, 1));
      hitViewZ.assign(cover.behindNear(world, view.z));
      return farFragmentDepth(hitViewZ);
    })();
    m.colorNode = vec4(hitColour, 1);
    m.normalNode = hitNormal;
    if (half) m.outputNode = farHalfOutput(hitColour, hitNormal, hitViewZ);
    // The boxes reach past the camera's far plane: placed with the far depth, never clipped there (the fragment writes its own).
    m.vertexNode = farClipPosition();
  }

  private sides(tex: THREE.Data3DTexture): void {
    (this.invSideU.value as THREE.Vector3).set(1 / tex.image.width, 1 / tex.image.height, 1 / tex.image.depth);
  }

  dispose(): void {
    this.material.dispose();
  }
}
