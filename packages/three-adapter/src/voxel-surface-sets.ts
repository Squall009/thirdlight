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
const { abs, dFdx, dFdy, float, floor, int, max, mix, mod, select, sqrt, step, texture, vec2, vec3 } = TSL;

/** The smallest tile a material record may name (metres): the table's tiles are read no smaller. */
const MIN_TILE_METRES = VOXEL_MATERIAL_LIMITS.tileMetresMin;

/** Above this upward share of its normal a construction face draws its floor set (below its negative, the ceiling set). */
const LEVEL_FACE_NORMAL_Y = 0.95;

/**
 * The neutral texels of the maps (RGBA bytes) a program samples before its arrays arrive, and a layerless material
 * reads: white albedo at height 1 (the surface: no relief, no crevice), a flat normal, the absent ORM (AO 1,
 * roughness 0.8, no metal).
 */
export const NEUTRAL_TEXELS = { albedo: [255, 255, 255, 255], normal: [128, 128, 255, 255], orm: [255, 204, 0, 0] } as const;

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
  hold: (a) => a.toVar(),
};

/** What the read needs of the surface: the three arrays' nodes, its table read and the material id's bits. */
export interface TextureSetSource {
  readonly maps: { readonly albedo: N; readonly normal: N; readonly orm: N };
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

/** Where a material's set is read at a point: its layer for the face, the projection's UVs and weights. */
interface SetProjection {
  readonly l: N;
  readonly built: N;
  readonly onBuilt: N;
  readonly has: N;
  readonly layer: N;
  readonly gt: N;
  /** Reads a map on the projection's three UVs (`level`: an explicit mip level; absent: the implicit one). */
  read(map: N, level?: N): [N, N, N];
  /** The three reads weighted by the projection (construction: the first alone; terrain: triplanar). */
  weighted(r: [N, N, N]): N;
  /** One read a map (`axis`): the largest axis as a one-hot vector (its triplanar weights); null: triplanar. */
  readonly axis: N | null;
}

/**
 * How many projections a material's set is read on: `blend`, a construction material on the grid and a terrain one
 * triplanar (three reads a map, weighted); `axis`, one read a map: the grid on construction (the same pixels as
 * `blend`), and on terrain only the projection of the normal's largest axis (no triplanar blend at the axes' seams).
 * Chosen per draw (`VoxelSurface.materialFor`), never per pixel.
 */
export type SetProjectionMode = 'blend' | 'axis';

function setProjection(src: TextureSetSource, m: N, at: TextureSetPoint, mode: SetProjectionMode = 'blend'): SetProjection {
  const { look, matMask } = src;
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
  if (mode === 'axis') {
    // One read: the grid's UV on construction, else the largest axis's. Its screen derivatives are taken from the
    // three continuous UVs and picked with it, so the mip level does not jump where the axis changes.
    const ax = abs(n);
    const isX = ax.x.greaterThanEqual(ax.y).and(ax.x.greaterThanEqual(ax.z)).toVar();
    const isY = isX.not().and(ax.y.greaterThanEqual(ax.z)).toVar();
    const pick = (x: N, y: N, z: N, g: N): N => select(onBuilt.greaterThan(0.5), g, select(isX, x, select(isY, y, z)));
    const ux = up(pt.zy).toVar();
    const uy = up(pt.xz).toVar();
    const uz = up(pt.xy).toVar();
    const ug = up(gt).toVar();
    const uv = pick(ux, uy, uz, ug).toVar();
    const gx = pick(dFdx(ux), dFdx(uy), dFdx(uz), dFdx(ug)).toVar();
    const gy = pick(dFdy(ux), dFdy(uy), dFdy(uz), dFdy(ug)).toVar();
    const one = vec3(select(isX, float(1), float(0)), select(isY, float(1), float(0)), select(isX.or(isY), float(0), float(1)));
    return {
      l,
      built,
      onBuilt,
      has,
      layer,
      gt,
      axis: one,
      read: (map, level) => {
        const t = texture(map, uv).depth(layer);
        const r = (level === undefined ? t.grad(gx, gy) : t.level(level)).toVar();
        return [r, r, r];
      },
      weighted: (r) => r[0],
    };
  }
  const uvs = [mix(up(pt.zy), up(gt), onBuilt).toVar(), up(pt.xz).toVar(), up(pt.xy).toVar()];
  const wx = mix(bn.x, float(1), onBuilt);
  const wy = bn.y.mul(onBuilt.oneMinus());
  const wz = bn.z.mul(onBuilt.oneMinus());
  return {
    axis: null,
    l,
    built,
    onBuilt,
    has,
    layer,
    gt,
    read: (map, level) => uvs.map((uv) => {
      const t = texture(map, uv).depth(layer);
      return (level === undefined ? t : t.level(level)).toVar();
    }) as [N, N, N],
    weighted: (r) => r[0].mul(wx).add(r[1].mul(wy)).add(r[2].mul(wz)),
  };
}

/**
 * A material's texture set at the pixel (`m`: the key material + construction · 2^materialBits): its layer for the
 * face (floor looking up, ceiling looking down, wall otherwise on construction; the wall's on terrain), each map read
 * on the material's projection, the normal map turned into the surface by that projection's frame, and the height
 * (0–1, 1 the surface) from the albedo's A, where the engine's texture sets keep it. Every sample is taken whether the
 * material has a layer or not (uniform control flow), the result picked after; without a layer the height is 1.
 */
export function textureSetAt(src: TextureSetSource, m: N, at: TextureSetPoint, mode: SetProjectionMode = 'blend'): { albedo: N; normal: N; orm: N; height: N } {
  const { maps } = src;
  const { n } = at;
  const { l, built, onBuilt, has, gt, read, weighted, axis } = setProjection(src, m, at, mode);
  // On one axis the read is turned by that axis's frame alone (its weight 1).
  const bn = axis ?? at.bn;
  const a = read(maps.albedo);
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
    height: select(has, weighted(a).a, float(1)),
  };
}

/**
 * A material's height alone (0–1, the albedo's A) at an explicit mip level: what the vertex stage displaces by
 * (it has no screen derivatives), read on the same layer and projection as the pixel's.
 */
export function textureHeightAt(src: TextureSetSource, m: N, at: TextureSetPoint, level: N, mode: SetProjectionMode = 'blend'): N {
  const { has, read, weighted } = setProjection(src, m, at, mode);
  return select(has, weighted(read(src.maps.albedo, level)).a, float(1));
}
