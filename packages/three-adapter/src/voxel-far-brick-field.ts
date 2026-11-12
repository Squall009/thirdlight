/**
 * The far bricks' atlas as the shaders read it: one set of texture nodes
 * (the distances, the baked samples and the two page stores) that every far
 * program shares, following the atlas when a growth or a trim replaces a
 * texture, and the reads a hit is shaded from: the stored field, its
 * gradient (the surface's normal) and the baked colour and occlusion. The
 * march reads the field; the shade reads the gradient and the colour, once
 * a pixel where the far pass shades from its visibility target
 * (voxel-far-visibility.ts), once a fragment where the march shades itself.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, FAR_BRICK_AO_FLOOR, FAR_BRICK_GRADIENT_MIN, FAR_BRICK_NORMAL_SPAN_CELLS, FAR_BRICK_SKIRT_SLOPE } from '@thirdlight/voxel';

import type { N } from './effects-tsl';
import { texelTexture3D } from './texel-texture-node';
import type { VoxelShaderGrids } from './voxel-surface';

const TSL: N = TSLTyped;
const { abs, clamp, float, length, max, mix, normalize, select, sign, texture3D, uniform, vec3 } = TSL;

/** What of the atlas the texture nodes follow (voxel-far-bricks.ts `FarBrickAtlas`). */
export interface FarBrickStores {
  readonly distance: VoxelShaderGrids;
  readonly colours: VoxelShaderGrids;
  readonly pages: VoxelShaderGrids;
  readonly pageBounds: VoxelShaderGrids;
}

/** The atlas's texture nodes and the reads of a brick at a point (brick cells, 0–8 an axis inside it). */
export class FarBrickTextures {
  readonly distance: N;
  /** The baked samples: linear colour and occlusion, filtered so one read is the eight samples' blend. */
  readonly colours: N;
  readonly pages: N;
  readonly pageBounds: N;
  private readonly invSide = uniform(new THREE.Vector3(1, 1, 1));

  constructor(stores: FarBrickStores) {
    this.distance = texture3D(stores.distance.texture);
    this.colours = texture3D(stores.colours.texture);
    this.pages = texelTexture3D(stores.pages.texture);
    this.pageBounds = texelTexture3D(stores.pageBounds.texture);
    this.sides(stores.distance.texture);
    stores.distance.onTexture = (tex) => {
      (this.distance as unknown as { value: THREE.Texture }).value = tex;
      this.sides(tex);
    };
    stores.colours.onTexture = (tex) => {
      (this.colours as unknown as { value: THREE.Texture }).value = tex;
    };
    stores.pages.onTexture = (tex) => {
      (this.pages as unknown as { value: THREE.Texture }).value = tex;
    };
    stores.pageBounds.onTexture = (tex) => {
      (this.pageBounds as unknown as { value: THREE.Texture }).value = tex;
    };
  }

  private sides(tex: THREE.Data3DTexture): void {
    (this.invSide.value as THREE.Vector3).set(1 / tex.image.width, 1 / tex.image.height, 1 / tex.image.depth);
  }

  /** The stored distance (cells) at a point inside a brick at atlas region `region` (texels): one filtered read, the trilinear sample. */
  sampled(region: N, q: N): N {
    return this.distance.sample(region.add(q).add(0.5).mul(this.invSide)).level(float(0)).r.mul(2).sub(1).mul(DISTANCE_BRICK_BAND_VOXELS);
  }

  /** The field at a point of a brick (cells): its sample, and past the box its skirt (as `farBrickField`). */
  field(region: N, p: N): N {
    const q = inBrick(p);
    return this.sampled(region, q).add(length(p.sub(q)).mul(FAR_BRICK_SKIRT_SLOPE));
  }

  /**
   * The surface's normal at a hit (brick cells): the samples' gradient read inside the brick only (a skirt is shaded as
   * the surface it hangs from, as a far mesh's skirt takes its edge's normal), one-sided where the brick's side cuts the
   * step; where there is no gradient (deep under the surface, the samples clamped to the band) the face the ray
   * entered by (`facing`, a unit axis vector).
   */
  normal(region: N, p: N, facing: N): N {
    const axis = (e: N): N => {
      const a = inBrick(p.add(e));
      const b = inBrick(p.sub(e));
      return this.sampled(region, a).sub(this.sampled(region, b)).div(max(length(a.sub(b)), float(1e-3)));
    };
    const h = FAR_BRICK_NORMAL_SPAN_CELLS;
    const g = vec3(axis(vec3(h, 0, 0)), axis(vec3(0, h, 0)), axis(vec3(0, 0, h))).toVar();
    return select(length(g).greaterThan(FAR_BRICK_GRADIENT_MIN), normalize(g), facing);
  }

  /** One filtered read at a hit: the eight samples' colours and occlusions blended by its weights, the occlusion applied. */
  colour(region: N, p: N): N {
    const c = this.colours.sample(region.add(inBrick(p)).add(0.5).mul(this.invSide)).level(float(0));
    return c.rgb.mul(mix(float(FAR_BRICK_AO_FLOOR), float(1), c.a));
  }

  /**
   * A hit's normal and colour: as {@link normal} and {@link colour}, or, for a ray that started inside the solid and
   * never left it (`inside`), the ground's look seen from above (its baked colour, unoccluded, facing up), so a view
   * from under a coarse stand-in's surface reads as ground rather than as its cells' sides.
   */
  shade(region: N, p: N, facing: N, inside: N): { normal: N; colour: N } {
    // One read for both colours (a node used twice would be read twice).
    const c = this.colours.sample(region.add(inBrick(p)).add(0.5).mul(this.invSide)).level(float(0)).toVar();
    return {
      normal: select(inside, vec3(0, 1, 0), this.normal(region, p, facing)),
      colour: select(inside, c.rgb, c.rgb.mul(mix(float(FAR_BRICK_AO_FLOOR), float(1), c.a))),
    };
  }
}

/** The face code a hit carries when it is drawn as the ground's look from above ({@link FarBrickTextures.shade}). */
export const INSIDE_FACE_CODE = 7;

/** A point clamped into a brick's samples (cells). */
export function inBrick(p: N): N {
  return clamp(p, vec3(0), vec3(DISTANCE_BRICK_CELLS));
}

/** The face a ray entered a box by (from the per-axis entry distances `near`), as the unit normal facing the ray. */
export function entryFace(near: N, dir: N): N {
  const entryX = near.x.greaterThanEqual(near.y).and(near.x.greaterThanEqual(near.z));
  const entryY = entryX.not().and(near.y.greaterThanEqual(near.z));
  const entryZ = entryX.not().and(entryY.not());
  return vec3(select(entryX, sign(dir.x).negate(), float(0)), select(entryY, sign(dir.y).negate(), float(0)), select(entryZ, sign(dir.z).negate(), float(0)));
}

/** {@link entryFace} as a code 1–6 (axis × 2 + 1, +1 more when the face looks along the axis's positive side). */
export function entryFaceCode(face: N): N {
  const axis = select(abs(face.x).greaterThan(0.5), float(0), select(abs(face.y).greaterThan(0.5), float(1), float(2)));
  const positive = select(face.x.add(face.y).add(face.z).greaterThan(0), float(1), float(0));
  return axis.mul(2).add(1).add(positive);
}

/** A face code ({@link entryFaceCode}) back to its unit normal. */
export function faceOfCode(code: N): N {
  const c = code.sub(1);
  const axis = c.div(2).floor();
  const s = c.sub(axis.mul(2)).mul(2).sub(1);
  return vec3(select(axis.equal(0), s, float(0)), select(axis.equal(1), s, float(0)), select(axis.equal(2), s, float(0)));
}
