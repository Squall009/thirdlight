/**
 * A voxel surface material's texture set as the surface shader reads it
 * (`voxel-surface.ts`): the layer for the face, each map read on the
 * material's projection, the normal map turned into the surface by that
 * projection's frame. Kept apart from the shader's blend so each stays a
 * readable unit.
 */
import * as TSLTyped from 'three/tsl';

import { VOXEL_MATERIAL_LIMITS } from '@thirdlight/project-model';

import type { N } from './effects-tsl';
import { gridFrame, tileUv, type ProjectionOps } from './voxel-surface-projection';

const TSL: N = TSLTyped;
const { abs, float, floor, int, max, mix, mod, select, sqrt, step, texture, vec2, vec3 } = TSL;

/** The smallest tile a material record may name (metres): the table's tiles are read no smaller. */
const MIN_TILE_METRES = VOXEL_MATERIAL_LIMITS.tileMetresMin;

/** Above this upward share of its normal a construction face draws its floor set (below its negative, the ceiling set). */
const LEVEL_FACE_NORMAL_Y = 0.95;

/**
 * The neutral texels of the maps (RGBA bytes) a program samples before its arrays arrive, and a layerless material
 * reads: white albedo at height 1, a flat normal, the absent ORM (AO 1, roughness 0.8, no metal).
 */
export const NEUTRAL_TEXELS = { albedoHeight: [255, 255, 255, 255], normal: [128, 128, 255, 255], orm: [255, 204, 0, 0] } as const;

/** The projection's scalar operations on shader nodes. */
export const NODE_OPS: ProjectionOps<N, N> = {
  num: (v) => float(v),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  abs: (a) => abs(a),
  max: (a, b) => max(a, b),
  sqrt: (a) => sqrt(a),
  less: (a, b) => a.lessThan(b),
  pick: (c, a, b) => select(c, a, b),
};

/** What the read needs of the surface: the three arrays' nodes, its table read and the material id's bits. */
export interface TextureSetSource {
  readonly maps: { readonly albedoHeight: N; readonly normal: N; readonly orm: N };
  /** The table texel of a material id in a block (0 look, 1 tiles, 3 layers). */
  look(id: N, block: number): N;
  readonly matMask: number;
  /** The band test texture (on: construction draws its flat colour under the bands, as in the pattern program). */
  readonly bands?: N | null;
}

/** Where the pixel is: its unit normal, world metres from the phase, the grid's (U, V) in metres, the triplanar weights. */
export interface TextureSetPoint {
  readonly n: N;
  readonly p: N;
  readonly gu: N;
  readonly gv: N;
  readonly bn: N;
}

/**
 * A material's texture set at the pixel (`m`: the key material + construction · 2^materialBits): its layer for the
 * face (floor looking up, ceiling looking down, wall otherwise on construction; the wall's on terrain), each map read
 * on the material's projection, the normal map turned into the surface by that projection's frame. Every sample is
 * taken whether the material has a layer or not (uniform control flow), the result picked after.
 */
export function textureSetAt(src: TextureSetSource, m: N, at: TextureSetPoint): { albedo: N; normal: N; orm: N } {
  const { maps, look, matMask } = src;
  const { n, p, gu, gv, bn } = at;
  const id = mod(m, matMask);
  const l = look(id, 0).toVar();
  const tiles = look(id, 1).toVar();
  const ls = look(id, 3).toVar();
  const built = m.greaterThanEqual(matMask);
  // The projection picked by arithmetic, not a branch: three builds a node first met inside a branch into that branch
  // alone, and the uv and frame are read again outside it (the band, the weights).
  const onBuilt = step(float(matMask), m).toVar();
  const picked = select(built.and(n.y.greaterThan(LEVEL_FACE_NORMAL_Y)), ls.y, select(built.and(n.y.lessThan(-LEVEL_FACE_NORMAL_Y)), ls.z, ls.x)).toVar();
  const has = picked.greaterThan(-0.5);
  const layer = int(floor(max(picked, 0).add(0.5)));
  const pt = p.div(max(tiles.y, MIN_TILE_METRES));
  const gt = vec2(...tileUv(NODE_OPS, [gu, gv], max(tiles.x, MIN_TILE_METRES)));
  // An image's first row is its top (KTX2, no flip on upload): V up reads it bottom to top, so a texture stands
  // upright on a wall and its bottom edge lies on the grid's 0 m line.
  const up = (uv: N): N => vec2(uv.x, uv.y.negate());
  const uvs = [mix(up(pt.zy), up(gt), onBuilt).toVar(), up(pt.xz).toVar(), up(pt.xy).toVar()];
  const read = (map: N): [N, N, N] => uvs.map((uv) => texture(map, uv).depth(layer).toVar()) as [N, N, N];
  const wx = mix(bn.x, float(1), onBuilt);
  const wy = bn.y.mul(onBuilt.oneMinus());
  const wz = bn.z.mul(onBuilt.oneMinus());
  const weighted = (r: [N, N, N]): N => r[0].mul(wx).add(r[1].mul(wy)).add(r[2].mul(wz));
  const a = read(maps.albedoHeight);
  const t = read(maps.normal).map((x) => x.xyz.mul(2).sub(1)) as [N, N, N];
  const o = read(maps.orm);
  // The grid projection: tangent U, bitangent V (voxel-surface-projection.ts), the face normal.
  const frame = gridFrame(NODE_OPS, [n.x, n.y, n.z]);
  const onGrid = vec3(...frame.u).mul(t[0].x).add(vec3(...frame.v).mul(t[0].y)).add(n.mul(t[0].z));
  // Three axes: X reads (z, y), Y (x, z), Z (x, y); each map's normal turned by its axis's frame, then weighted.
  const side = (c: N): N => select(c.lessThan(0), float(-1), float(1));
  const onAxes = vec3(t[0].z.mul(side(n.x)), t[0].y, t[0].x).mul(bn.x).add(vec3(t[1].x, t[1].z.mul(side(n.y)), t[1].y).mul(bn.y)).add(vec3(t[2].x, t[2].y, t[2].z.mul(side(n.z))).mul(bn.z));
  const textured = select(has, weighted(a).rgb.mul(l.rgb), l.rgb);
  // Into a variable first: the pick below is a branch, and a sample inside it would vary per pixel.
  const band = src.bands == null ? null : texture(src.bands, gt).toVar();
  return {
    albedo: band === null ? textured : select(built, mix(l.rgb, band.rgb, band.a), textured),
    normal: select(has, mix(onAxes, onGrid, onBuilt).normalize(), n),
    orm: select(has, weighted(o).xyz, vec3(NEUTRAL_TEXELS.orm[0] / 255, NEUTRAL_TEXELS.orm[1] / 255, NEUTRAL_TEXELS.orm[2] / 255)),
  };
}
