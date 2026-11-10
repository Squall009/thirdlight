/**
 * What a voxel world's two far field draws share (voxel-far-mesh.ts draws
 * nodes as meshes, voxel-far-bricks.ts ray marches them as distance
 * bricks): the depth they write past the camera's far plane, and the near
 * cover that hides them where the near field draws. Both draws write the
 * same depth for the same distance, so meshes, bricks and the near field
 * sort against each other wherever they meet.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { NEAR_COVER_EDGE, NEAR_COVER_HIDDEN, VOXEL_SIZE_M, type ChunkGrid, type FloatingOrigin, type NearCoverWire } from '@thirdlight/voxel';

import type { N } from './effects-tsl';
import { farNdcDepthOf } from './far-depth';
import { texelTexture3D } from './texel-texture-node';

const TSL: N = TSLTyped;
const { Fn, abs, cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix, clamp, float, floor, int, ivec3, length, max, min, positionView, positionWorld, select, uniform, vec3, vec4 } = TSL;

/** The camera's own normalized depth (NDC z) of a distance `x` along the view axis (standard, reversed and either range alike). */
function cameraNdc(x: N): N {
  const A = cameraProjectionMatrix.element(2).z;
  const B = cameraProjectionMatrix.element(3).z;
  return A.negate().add(B.div(x));
}

/** A far draw's normalized depth (NDC z) of a point `viewZ` metres along the view axis (negative in front): far-depth.ts. */
export function farNdcDepth(viewZ: N): N {
  return farNdcDepthOf(viewZ, cameraProjectionMatrix.element(2).z, cameraProjectionMatrix.element(3).z, cameraFar);
}

/**
 * A far draw's clip position (its material's `vertexNode`): the camera's
 * projection with {@link farNdcDepth} as its depth, so a far vertex is never
 * clipped by the camera's far plane.
 */
export function farClipPosition(cover?: FarCover): N {
  return Fn(() => {
    const clip = cameraProjectionMatrix.mul(vec4(positionView, 1)).toVar();
    const viewZ = cover === undefined ? positionView.z : cover.behindNear(positionWorld, positionView.z);
    return vec4(clip.x, clip.y, farNdcDepth(viewZ).mul(clip.w), clip.w);
  })();
}

/**
 * {@link farNdcDepth} as a fragment's depth (window depth 0–1): WebGPU's NDC
 * depth is already 0–1, WebGL 2's runs −1–1 (told apart by the near plane's).
 */
export function farFragmentDepth(viewZ: N): N {
  const ndc = farNdcDepth(viewZ);
  return select(cameraNdc(cameraNear).lessThan(-0.5), ndc.mul(0.5).add(0.5), ndc);
}

/**
 * The near cover (where the near field draws, by storage chunk: hidden
 * inside, its edge ring apart): a small 3D texture and its corner and
 * size, which a far draw's fragments test their world position against.
 */
export class FarCover {
  private texture: THREE.Data3DTexture;
  /** One node for every draw that tests the cover (its texture follows the cover). */
  private readonly node: N;
  /** The cover's corner (world chunks). */
  private min: [number, number, number] = [0, 0, 0];
  private readonly at = uniform(new THREE.Vector3(0, 0, 0));
  private readonly size = uniform(new THREE.Vector3(1, 1, 1));
  /** The cover now: its corner and size (chunks), the chunks it hides the far field in, and its edge ring's. */
  state = { min: [0, 0, 0] as number[], size: [1, 1, 1] as number[], covered: 0, edge: 0 };
  /** The cover's chunks as sent (the CPU's copy, for {@link hides}). */
  private cells: Uint8Array = new Uint8Array(1);
  /** Changes when the cover or its place changes (what {@link hides} answers may have). */
  version = 0;

  constructor(
    private readonly grid: ChunkGrid,
    private readonly origin: FloatingOrigin,
  ) {
    this.texture = coverTexture(new Uint8Array(1), [1, 1, 1]);
    this.node = texelTexture3D(this.texture);
  }

  set(c: NearCoverWire): void {
    const old = this.texture;
    this.texture = coverTexture(c.cells, c.size);
    (this.node as unknown as { value: THREE.Texture }).value = this.texture;
    old.dispose();
    this.min = [c.min[0], c.min[1], c.min[2]];
    this.cells = c.cells;
    let covered = 0;
    let edge = 0;
    for (let i = 0; i < c.cells.length; i++) {
      if (c.cells[i] === NEAR_COVER_HIDDEN) covered++;
      else if (c.cells[i] === NEAR_COVER_EDGE) edge++;
    }
    this.state = { min: [...c.min], size: [...c.size], covered, edge };
    (this.size.value as THREE.Vector3).set(c.size[0], c.size[1], c.size[2]);
    this.place();
  }

  /** After a floating-origin re-base: the cover's corner again. */
  place(): void {
    const o = this.origin.origin;
    const e = this.grid.edge;
    (this.at.value as THREE.Vector3).set((this.min[0] * e - o.x) * VOXEL_SIZE_M, (this.min[1] * e - o.y) * VOXEL_SIZE_M, (this.min[2] * e - o.z) * VOXEL_SIZE_M);
    this.version++;
  }

  /**
   * Whether a world box (metres, min xyz and max xyz) lies wholly in chunks where the near field hides the far
   * field: every far fragment of a node in it would be discarded there (the CPU twin of {@link covered}).
   */
  hides(lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
    if (this.state.covered === 0) return false;
    const at = this.at.value as THREE.Vector3;
    const chunkM = this.grid.edge * VOXEL_SIZE_M;
    const size = this.state.size;
    const from = [0, 0, 0];
    const to = [0, 0, 0];
    const origin = [at.x, at.y, at.z];
    for (let a = 0; a < 3; a++) {
      from[a] = Math.floor((lo[a]! - origin[a]!) / chunkM);
      // A box ending on a chunk's face reaches no further.
      to[a] = Math.ceil((hi[a]! - origin[a]!) / chunkM) - 1;
      if (from[a]! < 0 || to[a]! >= size[a]! || to[a]! < from[a]!) return false;
    }
    for (let z = from[2]!; z <= to[2]!; z++) for (let y = from[1]!; y <= to[1]!; y++) for (let x = from[0]!; x <= to[0]!; x++) if (this.cells[x + size[0]! * (y + size[1]! * z)] !== NEAR_COVER_HIDDEN) return false;
    return true;
  }

  /** The cover's value at a world position (metres): 0 outside, ½ in the edge ring, 1 where the far field is hidden. */
  private value(world: N): N {
    const node = this.node;
    const chunkM = float(this.grid.edge * VOXEL_SIZE_M);
    const c = floor(world.sub(this.at).div(chunkM)).toVar();
    const inside = c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.z.greaterThanEqual(0)).and(c.x.lessThan(this.size.x)).and(c.y.lessThan(this.size.y)).and(c.z.lessThan(this.size.z));
    const at = clamp(c, vec3(0), this.size.sub(1));
    return select(inside, node.load(ivec3(int(at.x), int(at.y), int(at.z))).r, float(0));
  }

  /** Whether a world position (metres) lies where the near field hides the far field (a bool node). */
  covered(world: N): N {
    return this.value(world).greaterThan(0.75);
  }

  /**
   * A far point's view z (negative in front) for its depth: in the near field's edge ring, at least as far as the
   * near field's farthest corner from the camera, so every near fragment (no farther than that) is in front of
   * it and the far field shows there only through a gap, though its coarser surface may lie above the near one.
   */
  behindNear(world: N, viewZ: N): N {
    const chunkM = float(this.grid.edge * VOXEL_SIZE_M);
    const lo = this.at;
    const hi = this.at.add(this.size.mul(chunkM));
    const reach = length(max(abs(cameraPosition.sub(lo)), abs(cameraPosition.sub(hi))));
    const v = this.value(world);
    return select(v.greaterThan(0.25).and(v.lessThan(0.75)), min(viewZ, reach.negate()), viewZ);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function coverTexture(cells: Uint8Array, size: readonly [number, number, number]): THREE.Data3DTexture {
  // Read normalized (r8unorm): a hidden chunk is 1 (255), an edge chunk ½ (128).
  const t = new THREE.Data3DTexture(cells.map((c) => (c === NEAR_COVER_HIDDEN ? 255 : c === NEAR_COVER_EDGE ? 128 : 0)), size[0], size[1], size[2]);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
