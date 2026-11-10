/**
 * A voxel world's far bricks rasterized (`@thirdlight/voxel`
 * far-bricks-raster.ts): the same bricks as the ray-marched draw of
 * voxel-far-bricks.ts, each sample a cube, every cube face open to air one
 * instance of a square. No march and no depth written by the fragment: the
 * GPU's early depth test hides what lies behind, as for any mesh.
 *
 * - **Instance.** Three floats a face (exact integers): its cube's sample
 *   in the group's cells (x + 512 z; y + {@link FAR_FACE_Y_BIAS} + 8192 ×
 *   its kind byte: direction, skirt, clipped sides, + 8192 × 256 × the
 *   direction it is lit as) and its look word + 65536 × its occlusion. The draw's object is scaled by the level's cell,
 *   so positions stay small whole numbers (and halves): two faces sharing a
 *   corner compute it bit for bit alike, and the squares close without a
 *   crack.
 * - **Colour.** The material table's far colour of the look word (as the
 *   far meshes' vertices), darkened by the sample's baked occlusion, made in
 *   the vertex stage; lit by the scene's lights.
 * - **Depth and the near field.** The far draws' own depth
 *   (voxel-far-common.ts) from the vertex stage, so rasterized bricks, far
 *   meshes and the near field sort per pixel as before; a face whose cube
 *   lies in a chunk the near field draws is dropped in the vertex stage
 *   (its four corners moved off screen), so the fragment never discards.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { FAR_BRICK_AO_FLOOR, FAR_FACE_CLIP_SHIFT, FAR_FACE_SHADE_SHIFT, mipNodeKey, type FarNodeDraw, type FarRasterFaces } from '@thirdlight/voxel';

import { cameraRelative, cameraRelativeModelView } from './camera-relative';
import type { N } from './effects-tsl';
import { farClipPosition, type FarCover } from './voxel-far-common';
import type { VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Fn, attribute, float, floor, mix, mod, modelWorldMatrix, normalize, positionGeometry, select, varying, vec3, vec4 } = TSL;

/** The rasterized bricks' per-instance attribute (three floats a face, see the module's notes). */
export const FAR_FACE_ATTRIBUTE = 'voxelFarFace';

/** Bytes an instance takes. */
export const FAR_FACE_INSTANCE_BYTES = 12;

/** Added to a face's y (the group's cells) so it packs as a whole number from 0. */
export const FAR_FACE_Y_BIAS = 4096;

/** A group's cells an axis a face's x and z pack in (the group is 8 nodes of 32 cells, its far side included). */
const XZ_PACK = 512;
const Y_PACK = 8192;
const LOOK_PACK = 65536;
/** y (13 bits) and the kind byte below it, the shading direction above (3 bits: 24 in all). */
const SHADE_PACK = Y_PACK * 256;

/** The unit square (0–1 in x and y) a face instance places: 4 corners, 2 triangles counter-clockwise. */
function unitSquare(): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

/**
 * A brick group's draw as faces: every node's faces (`faces`, by node), in the group's cells (the mesh is scaled by
 * the level's cell). Throws if a face lies outside what the instance packs.
 */
export function farRasterGeometry(edge: number, g: { readonly level: number; readonly cell: readonly [number, number, number] }, nodes: readonly FarNodeDraw[], faces: (n: FarNodeDraw) => FarRasterFaces | undefined): THREE.InstancedBufferGeometry {
  let count = 0;
  for (const d of nodes) count += faces(d)?.count ?? 0;
  const inst = new Float32Array(count * 3);
  const s = 2 ** g.level;
  let k = 0;
  for (const d of nodes) {
    const f = faces(d);
    if (f === undefined) continue;
    const ox = d.nx * edge - g.cell[0] / s;
    const oy = d.ny * edge - g.cell[1] / s + FAR_FACE_Y_BIAS;
    const oz = d.nz * edge - g.cell[2] / s;
    if (ox < 0 || oz < 0 || ox + edge >= XZ_PACK || oy < 0 || oy + edge >= Y_PACK) throw new RangeError(`far raster: node ${mipNodeKey(d)} lies outside its group's packing`);
    for (let i = 0; i < f.count; i++, k++) {
      const c = i * 4;
      inst[k * 3] = ox + f.cells[c]! + XZ_PACK * (oz + f.cells[c + 2]!);
      inst[k * 3 + 1] = oy + f.cells[c + 1]! + Y_PACK * f.cells[c + 3]! + SHADE_PACK * (f.looks[i]! >>> FAR_FACE_SHADE_SHIFT);
      // The look (16 bits) and occlusion (8) fill a float's 24 exact bits; the shading direction (3) goes with y.
      inst[k * 3 + 2] = (f.looks[i]! & 0xffff) + LOOK_PACK * ((f.looks[i]! >>> 16) & 0xff);
    }
  }
  const geometry = unitSquare();
  geometry.setAttribute(FAR_FACE_ATTRIBUTE, new THREE.InstancedBufferAttribute(inst, 3));
  geometry.instanceCount = count;
  // Never culled by three (its frustum ends at the far plane): the GPU clips what lies off screen.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geometry;
}

/** The rasterized bricks' material, one for every group: a face a square, coloured, lit, with the far depth. */
export function farRasterMaterial(surface: VoxelSurface, cover: FarCover): MeshStandardNodeMaterial {
  const m = cameraRelative(new MeshStandardNodeMaterial());
  m.name = 'voxel far bricks (raster)';
  m.metalness = 0;
  m.roughness = 1;
  const f = attribute(FAR_FACE_ATTRIBUTE, 'vec3');
  const zc = floor(f.x.div(XZ_PACK));
  const xc = f.x.sub(zc.mul(XZ_PACK));
  const shade = floor(f.y.div(SHADE_PACK));
  const ky = f.y.sub(shade.mul(SHADE_PACK));
  const kind = floor(ky.div(Y_PACK));
  const yc = ky.sub(kind.mul(Y_PACK)).sub(FAR_FACE_Y_BIAS);
  const centre = vec3(xc, yc, zc);
  const dir = mod(kind, 8);
  const skirt = mod(floor(kind.div(8)), 2);
  const clip = floor(kind.div(2 ** FAR_FACE_CLIP_SHIFT));
  const bit = (b: number): N => mod(floor(clip.div(b)), 2);
  const axis = floor(dir.div(2));
  const plus = mod(dir, 2).greaterThan(0.5);
  const is = (a: number): N => select(axis.equal(a), float(1), float(0));
  // The face's axis and its two tangents, the axes after it (x → y → z): b × c = a, so (b, c) winds a + face outward.
  const ea = vec3(is(0), is(1), is(2));
  const eb = vec3(is(2), is(0), is(1));
  const ec = vec3(is(1), is(2), is(0));
  const sgn = select(plus, float(1), float(-1));
  // Each tangent's extent, half a cell short on a side clipped to the node's box.
  const lo0 = float(-0.5).add(bit(1).mul(0.5));
  const hi0 = float(0.5).sub(bit(2).mul(0.5));
  const lo1 = float(-0.5).add(bit(4).mul(0.5));
  const hi1 = float(0.5).sub(bit(8).mul(0.5));
  const q = positionGeometry;
  // A − face winds (c, b): its square's x runs along c.
  const alongB = mix(lo0, hi0, select(plus, q.x, q.y));
  const alongC = mix(lo1, hi1, select(plus, q.y, q.x));
  // A face between samples lies half a cell out of its cube; a skirt on the box face, at the cube's clipped side.
  const out = sgn.mul(select(skirt.greaterThan(0.5), float(0), float(0.5)));
  m.positionNode = centre.add(ea.mul(out)).add(eb.mul(alongB)).add(ec.mul(alongC));
  const look = mod(f.z, LOOK_PACK);
  const open = floor(f.z.div(LOOK_PACK)).div(255);
  const colour = varying(surface.farColour(mod(look, 4096), floor(look.div(4096))).mul(mix(float(FAR_BRICK_AO_FLOOR), float(1), open)));
  m.colorNode = vec4(colour, 1);
  const modelView: N = cameraRelativeModelView;
  // Lit as its shading direction (a face's own; a skirt's the surface's above it).
  const sAxis = floor(shade.div(2));
  const sOf = (a: number): N => select(sAxis.equal(a), float(1), float(0));
  const sNormal = vec3(sOf(0), sOf(1), sOf(2)).mul(select(mod(shade, 2).greaterThan(0.5), float(1), float(-1)));
  m.normalNode = varying(normalize(modelView.mul(vec4(sNormal, 0)).xyz));
  // A face whose cube the near field draws over goes off screen as a whole (z past the far side), never discarded.
  const covered = cover.covered(modelWorldMatrix.mul(vec4(centre, 1)).xyz);
  const clipPos = farClipPosition();
  m.vertexNode = Fn(() => select(covered, vec4(0, 0, 2, 1), clipPos))();
  return m;
}
