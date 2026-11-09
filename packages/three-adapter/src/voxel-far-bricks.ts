/**
 * A voxel world's far field as ray-marched distance bricks
 * (`@thirdlight/voxel` far-bricks.ts): the second far draw mode, beside
 * the meshes of voxel-far-mesh.ts, which groups the nodes and owns the
 * draws; this module keeps the bricks on the GPU and makes a group's draw.
 *
 * - **Atlas.** Every drawn brick's 9³ samples are a region of one shared
 *   3D texture (the distances, r8, filtered, so one read is the trilinear
 *   sample) and of a twin (the material words, rg8, read texel by texel),
 *   the voxel surface's region store (`VoxelShaderGrids`): a node's bricks
 *   are uploaded alone when it arrives (`queue.writeTexture` on WebGPU,
 *   `texSubImage3D` on WebGL 2) and their regions given back when it goes;
 *   the atlas grows by a copy on the GPU.
 * - **Draw.** Every stored brick is one instance of a box (its own, grown on
 *   the node faces it lies on by the skirt's lip) carrying its corner and
 *   faces, its region and its cell size, all of a group in one instanced
 *   draw with one material for every group. The box's back faces are drawn
 *   (the camera may be inside one), and the fragment marches the camera's
 *   ray through the brick from where it enters the box (`marchFarBrick`,
 *   step for step: the same field, skirt, hit distance, shortest step and
 *   step count); a ray that leaves the box first is discarded, so the
 *   bricks behind it show.
 * - **Shading.** The normal is the samples' gradient at the hit (inside the
 *   brick: a skirt is shaded like the surface it hangs from), the colour
 *   the material table's far colour of the hit's nearest sample's material
 *   (as the far meshes' vertices), lit by the scene's lights like them.
 * - **Depth.** The hit's own depth is written (the far draws' mapping,
 *   voxel-far-common.ts), so bricks, far meshes and the near field sort
 *   against each other per pixel; hits under the near cover are discarded.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { BRICK_HIT_VOXELS, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_BRICK_BLOCK_BYTES, FAR_BRICK_LIP_CELLS, FAR_BRICK_SKIRT_SLOPE, FAR_BRICK_STEPS, farBrickCount, VOXEL_SIZE_M, type FarBricks, type FarNodeDraw } from '@thirdlight/voxel';

import { cameraRelative, cameraRelativeModelView } from './camera-relative';
import type { N } from './effects-tsl';
import { texelTexture3D } from './texel-texture-node';
import { farClipPosition, farFragmentDepth, type FarCover } from './voxel-far-common';
import { VoxelShaderGrids, type VoxelGridRenderer, type VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Break, Discard, Fn, If, Loop, abs, attribute, cameraPosition, clamp, float, floor, int, ivec3, length, max, min, mod, modelWorldMatrix, modelWorldMatrixInverse, normalize, positionGeometry, property, round, select, sign, texture3D, uniform, varying, vec3, vec4 } = TSL;

/** The brick draws' per-instance attribute: the brick's corner (metres from the group's corner) and its node-face bits. */
export const FAR_BRICK_ATTRIBUTE = 'voxelFarBrick';

/** The brick draws' second per-instance attribute: the brick's region in the atlas (texels) and its cell size (metres). */
export const FAR_BRICK_BLOCK_ATTRIBUTE = 'voxelFarBrickBlock';

/** The gradient (cells a cell) below which a hit's normal is the face it entered by: samples clamped to the band. */
const GRADIENT_MIN = 0.05;

/** The far bricks on the GPU: two region stores filled in step, a brick a region in each. */
export class FarBrickAtlas {
  readonly distance = new VoxelShaderGrids({ side: DISTANCE_BRICK_SIDE }, { format: THREE.RedFormat, bytes: 1, filter: THREE.LinearFilter });
  readonly looks = new VoxelShaderGrids({ side: DISTANCE_BRICK_SIDE });
  /** Bricks resident. */
  get count(): number {
    return this.distance.count;
  }

  get gpuBytes(): number {
    return this.distance.gpuBytes + this.looks.gpuBytes;
  }

  /** Uploads a node's bricks, one region each; their regions (texel origins), in block order. */
  add(renderer: VoxelGridRenderer, b: FarBricks): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const n = farBrickCount(b);
    for (let i = 0; i < n; i++) {
      const at = this.distance.allocate(renderer);
      const twin = this.looks.allocate(renderer);
      // Both stores hand out and grow alike, so a brick's two regions share an origin.
      if (!at.equals(twin)) throw new Error('far brick atlas: the two region stores parted');
      this.distance.upload(renderer, at, b.samples.subarray(i * DISTANCE_BRICK_SAMPLES, (i + 1) * DISTANCE_BRICK_SAMPLES));
      this.looks.upload(renderer, at, b.looks.subarray(i * DISTANCE_BRICK_SAMPLES, (i + 1) * DISTANCE_BRICK_SAMPLES));
      out.push(at);
    }
    return out;
  }

  /** Gives a node's regions back. */
  remove(regions: readonly THREE.Vector3[]): void {
    for (const r of regions) {
      this.distance.release(r);
      this.looks.release(r);
    }
  }

  /** Textures replaced by a growth are disposed once no frame binds them. */
  frame(): void {
    this.distance.frame();
    this.looks.frame();
  }

  dispose(): void {
    this.distance.dispose();
    this.looks.dispose();
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
 * A brick group's draw: an instance a brick of its nodes, each carrying its
 * corner (metres from the group's corner), node-face bits, atlas region and
 * cell size. `regions` gives each node's regions (the atlas holds them).
 */
export function farBrickGeometry(edge: number, g: { readonly level: number; readonly cell: readonly [number, number, number] }, nodes: readonly FarNodeDraw[], regions: (n: FarNodeDraw) => readonly THREE.Vector3[]): THREE.InstancedBufferGeometry {
  let count = 0;
  for (const d of nodes) if (d.bricks !== undefined) count += farBrickCount(d.bricks);
  const inst = new Float32Array(count * 4);
  const block = new Float32Array(count * 4);
  const cellM = 2 ** g.level * VOXEL_SIZE_M;
  const brickM = DISTANCE_BRICK_CELLS * cellM;
  let k = 0;
  for (const d of nodes) {
    const b = d.bricks;
    if (b === undefined) continue;
    const at = regions(d);
    // The node's corner, in metres from the group's corner.
    const ox = (d.nx * edge * 2 ** g.level - g.cell[0]) * VOXEL_SIZE_M;
    const oy = (d.ny * edge * 2 ** g.level - g.cell[1]) * VOXEL_SIZE_M;
    const oz = (d.nz * edge * 2 ** g.level - g.cell[2]) * VOXEL_SIZE_M;
    for (let i = 0; i < at.length; i++, k++) {
      const o = i * FAR_BRICK_BLOCK_BYTES;
      inst.set([ox + b.blocks[o]! * brickM, oy + b.blocks[o + 1]! * brickM, oz + b.blocks[o + 2]! * brickM, b.blocks[o + 3]!], k * 4);
      block.set([at[i]!.x, at[i]!.y, at[i]!.z, cellM], k * 4);
    }
  }
  const geometry = unitBox();
  geometry.setAttribute(FAR_BRICK_ATTRIBUTE, new THREE.InstancedBufferAttribute(inst, 4));
  geometry.setAttribute(FAR_BRICK_BLOCK_ATTRIBUTE, new THREE.InstancedBufferAttribute(block, 4));
  geometry.instanceCount = count;
  // Never culled by three (its frustum ends at the far plane): no bounds needed past what the GPU clips.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geometry;
}

/**
 * The brick draws' material, one for every brick group: the march, its
 * shading and its depth, over the atlas.
 */
export class FarBrickMaterial {
  readonly material: MeshStandardNodeMaterial;
  private readonly distanceNode: N;
  private readonly looksNode: N;
  private readonly invSideU = uniform(new THREE.Vector3(1, 1, 1));

  constructor(atlas: FarBrickAtlas, surface: VoxelSurface, cover: FarCover) {
    const m = cameraRelative(new MeshStandardNodeMaterial());
    m.name = 'voxel far bricks';
    m.metalness = 0;
    m.roughness = 1;
    m.side = THREE.BackSide;
    this.material = m;
    this.distanceNode = texture3D(atlas.distance.texture);
    this.looksNode = texelTexture3D(atlas.looks.texture);
    this.sides(atlas.distance.texture);
    atlas.distance.onTexture = (tex) => {
      (this.distanceNode as unknown as { value: THREE.Texture }).value = tex;
      this.sides(tex);
    };
    atlas.looks.onTexture = (tex) => {
      (this.looksNode as unknown as { value: THREE.Texture }).value = tex;
    };
    const C = DISTANCE_BRICK_CELLS;
    const L = FAR_BRICK_LIP_CELLS;
    const inst = attribute(FAR_BRICK_ATTRIBUTE, 'vec4');
    // The node-face bits as the box's growth on each side (cells).
    const bit = (b: number): N => mod(floor(inst.w.div(b)), 2);
    const lo = vec3(bit(1), bit(4), bit(16)).mul(-L);
    const hi = vec3(bit(2), bit(8), bit(32)).mul(L).add(C);
    const block = attribute(FAR_BRICK_BLOCK_ATTRIBUTE, 'vec4');
    const cellM = block.w;
    m.positionNode = inst.xyz.add(lo.add(positionGeometry.mul(hi.sub(lo))).mul(cellM));
    const vCellM = varying(cellM);
    const vCorner = varying(inst.xyz);
    const vLo = varying(lo);
    const vHi = varying(hi);
    const vLocal = varying(inst.xyz.add(lo.add(positionGeometry.mul(hi.sub(lo))).mul(cellM)));
    const vBlock = varying(block.xyz);
    const invSide = this.invSideU;
    const distanceNode = this.distanceNode;
    const looksNode = this.looksNode;
    // The stored distance (cells) at a point inside the brick (cells 0–8 an axis): one filtered read, the trilinear sample.
    const sampled = (q: N): N => distanceNode.sample(vBlock.add(q).add(0.5).mul(invSide)).level(float(0)).r.mul(2).sub(1).mul(DISTANCE_BRICK_BAND_VOXELS);
    const inBrick = (p: N): N => clamp(p, vec3(0), vec3(C));
    // The field at a point of the brick (cells): its sample, and past the box its skirt (as `farBrickField`).
    const field = (p: N): N => {
      const q = inBrick(p);
      return sampled(q).add(length(p.sub(q)).mul(FAR_BRICK_SKIRT_SLOPE));
    };
    // The surface's normal at a hit: the samples' gradient read inside the brick only (a skirt is shaded as the surface
    // it hangs from, as a far mesh's skirt takes its edge's normal), one-sided where the brick's side cuts the step.
    const gradient = (p: N): N => {
      const axis = (e: N): N => {
        const a = inBrick(p.add(e));
        const b = inBrick(p.sub(e));
        return sampled(a).sub(sampled(b)).div(max(length(a.sub(b)), float(1e-3)));
      };
      return vec3(axis(vec3(0.5, 0, 0)), axis(vec3(0, 0.5, 0)), axis(vec3(0, 0, 0.5)));
    };
    const safe = (c: N): N => select(abs(c).lessThan(1e-8), select(c.lessThan(0), float(-1e-8), float(1e-8)), c);
    // The draw's model-view (made in 64 bits on the CPU): the hit's view position and normal.
    const modelView: N = cameraRelativeModelView;
    const hitNormal = property('vec3', 'farBrickNormal');
    const hitColour = property('vec3', 'farBrickColour');
    m.depthNode = Fn(() => {
      const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
      const dir = normalize(vLocal.sub(camLocal)).toVar();
      const o = camLocal.sub(vCorner).div(vCellM).toVar();
      const inv = vec3(float(1).div(safe(dir.x)), float(1).div(safe(dir.y)), float(1).div(safe(dir.z))).toVar();
      const ta = vLo.sub(o).mul(inv);
      const tb = vHi.sub(o).mul(inv);
      const near = min(ta, tb).toVar();
      const far = max(ta, tb);
      const t1 = min(min(far.x, far.y), far.z).toVar();
      const t = max(max(max(near.x, near.y), near.z), float(0)).toVar();
      const hit = float(0).toVar();
      Loop(FAR_BRICK_STEPS, () => {
        const p = o.add(dir.mul(t)).toVar();
        const f = field(p).toVar();
        If(f.lessThan(BRICK_HIT_VOXELS), () => {
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
      If(hit.lessThan(0.5), () => {
        Discard();
      });
      const p = o.add(dir.mul(t)).toVar();
      const local = vCorner.add(p.mul(vCellM));
      If(cover.covered(modelWorldMatrix.mul(vec4(local, 1)).xyz), () => {
        Discard();
      });
      // Deep under the surface (the samples clamped to the band) there is no gradient: a ray hits there only where a
      // node face shows its ground's side (a neighbour drawn at a coarser level lies lower), shaded as that face.
      const g = gradient(p).toVar();
      const entryX = near.x.greaterThanEqual(near.y).and(near.x.greaterThanEqual(near.z));
      const entryY = entryX.not().and(near.y.greaterThanEqual(near.z));
      const entryZ = entryX.not().and(entryY.not());
      const facing = vec3(select(entryX, sign(dir.x).negate(), float(0)), select(entryY, sign(dir.y).negate(), float(0)), select(entryZ, sign(dir.z).negate(), float(0)));
      const n = select(length(g).greaterThan(GRADIENT_MIN), normalize(g), facing);
      hitNormal.assign(normalize(modelView.mul(vec4(n, 0)).xyz));
      // The nearest sample's material word: low byte, high byte.
      const at = vBlock.add(round(clamp(p, vec3(0), vec3(C))));
      const lw = looksNode.load(ivec3(int(at.x), int(at.y), int(at.z)));
      const word = round(lw.r.mul(255)).add(round(lw.g.mul(255)).mul(256));
      hitColour.assign(surface.farColour(mod(word, 4096), floor(word.div(4096))));
      const view = modelView.mul(vec4(local, 1));
      return farFragmentDepth(view.z);
    })();
    m.colorNode = vec4(hitColour, 1);
    m.normalNode = hitNormal;
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
