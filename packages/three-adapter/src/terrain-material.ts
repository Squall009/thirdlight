/**
 * The terrain's shaders: the shared grid mesh placed per drawn node, raised
 * from the height texture array and morphed between levels in the vertex
 * stage (CDLOD, `terrain-quadtree.ts`), and the inputs a layered material
 * reads per pixel.
 *
 * Per vertex: the node (two instanced vec4: its corner in the terrain's
 * frame, its size in samples, its tile's texture layer; its corner in the
 * tile's samples and its level's morph range) places the grid; the height
 * at the unmorphed vertex (a sample: one texel) gives its distance to the
 * view's camera, which sets how far an odd vertex slides onto its even
 * neighbour (the next coarser level's grid); the height and normal there are
 * filtered by hand from four texels (16-bit steps put back together, so no
 * precision is lost). The normal and a tangent along +x go to three's
 * vertex normal and tangent, so a graph's normal maps light correctly; the
 * texture coordinates are metres in the terrain's frame (less whole
 * `WORLD_UV_PERIOD_METRES`, as block layers' are), +u along x, +v along z.
 *
 * Per pixel: the layer weights (a linear sample of the layer texture: layers
 * 0–2, the rest is layer 3) stand in for COLOR_0, which the layered template
 * reads as its paint; a cell marked as a hole is cut away (the mask, also in
 * the shadow pass).
 *
 * The camera position the morph reads is the view's for every pass of the
 * frame, so a shadow map holds the same shape as the view.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { WORLD_UV_PERIOD_METRES } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import type { GraphSurface } from './material-graph';
import { STEADY_SHAPE_KEY } from './shadow-casters';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, attribute, clamp, dot, float, floor, fract, int, ivec2, length, max, min, mix, modelWorldMatrix, normalLocal, normalize, positionGeometry, renderGroup, sqrt, tangentLocal, texture, textureLoad, uniform, varyingProperty, vec2, vec3, vec4 } = TSL;

/** The instanced attributes of a drawn node (`terrain-quadtree.ts`'s eight floats). */
export const TERRAIN_NODE_ATTRIBUTE = 'tlTerrainNode';
export const TERRAIN_SUB_ATTRIBUTE = 'tlTerrainSub';

/** The view camera's world position the morph reads (one for every terrain and pass of a frame). */
export const terrainEye: N = uniform(new THREE.Vector3()).setGroup(renderGroup);

/** One terrain's shape values (changing them needs no new program). */
export interface TerrainUniforms {
  /** Samples along a tile side. */
  readonly samples: N;
  /** Metres between samples. */
  readonly spacing: N;
  /** The height of step 0 and of one step (metres, the terrain's frame). */
  readonly low: N;
  readonly step: N;
  /** Quads along the grid mesh's side. */
  readonly grid: N;
}

export function terrainUniforms(): TerrainUniforms {
  return { samples: uniform(257), spacing: uniform(1), low: uniform(0), step: uniform(1), grid: uniform(16) };
}

/** The default look of a terrain without a graph material: its four drawn layers as plain colours (sRGB). */
export const TERRAIN_DEFAULT_COLOURS: readonly string[] = Object.freeze(['#6f8a4a', '#8a6f4f', '#8a8580', '#c8b98a']);

/** Decode a texel's 16-bit step (R high byte, G low byte). */
const stepOf = (t: N): N => floor(t.r.mul(255).add(0.5)).mul(256).add(floor(t.g.mul(255).add(0.5)));

/**
 * The surface a terrain page's materials compile against: its height and
 * layer texture arrays, its shape values, and `key` naming it (a page's
 * textures replaced by larger ones take a new key, so a new compile).
 */
export function terrainSurface(key: string, heights: THREE.DataArrayTexture, layers: THREE.DataArrayTexture, u: TerrainUniforms): GraphSurface {
  const vSample = varyingProperty('vec2', 'tlTerrainSample');
  const vLayer = varyingProperty('float', 'tlTerrainLayer');
  const vUv = varyingProperty('vec2', 'tlTerrainUv');
  const texel = (layer: N, x: N, z: N): N => textureLoad(heights, ivec2(x, z)).depth(layer);
  const position = Fn(() => {
    const node = attribute(TERRAIN_NODE_ATTRIBUTE, 'vec4');
    const sub = attribute(TERRAIN_SUB_ATTRIBUTE, 'vec4');
    const layer = int(node.w.add(0.5));
    const grid = positionGeometry.xz;
    const metres = node.z.mul(u.spacing);
    // The unmorphed vertex is on a sample: one texel gives its height, and its distance to the camera.
    const s0 = sub.xy.add(grid.mul(node.z));
    const h0 = u.low.add(stepOf(texel(layer, int(s0.x.add(0.5)), int(s0.y.add(0.5)))).mul(u.step));
    const world0 = modelWorldMatrix.mul(vec4(node.x.add(grid.x.mul(metres)), h0, node.y.add(grid.y.mul(metres)), 1)).xyz;
    const k = clamp(length(world0.sub(terrainEye)).sub(sub.z).mul(sub.w), 0, 1);
    // Odd grid vertices slide onto their even neighbour (the coarser level's grid) as k goes to 1.
    const odd = fract(grid.mul(u.grid.mul(0.5))).mul(float(2).div(u.grid));
    const gm = grid.sub(odd.mul(k));
    const sm = sub.xy.add(gm.mul(node.z));
    // Bilinear over the four samples around the morphed point.
    const last = u.samples.sub(1);
    const c = clamp(sm, vec2(0), vec2(last));
    const i0 = min(floor(c), vec2(last.sub(1)));
    const f = c.sub(i0);
    const x0 = int(i0.x);
    const z0 = int(i0.y);
    const t00 = texel(layer, x0, z0);
    const t10 = texel(layer, x0.add(1), z0);
    const t01 = texel(layer, x0, z0.add(1));
    const t11 = texel(layer, x0.add(1), z0.add(1));
    const step = mix(mix(stepOf(t00), stepOf(t10), f.x), mix(stepOf(t01), stepOf(t11), f.x), f.y);
    const nxz = mix(mix(t00.ba, t10.ba, f.x), mix(t01.ba, t11.ba, f.x), f.y).mul(2).sub(1);
    const n = normalize(vec3(nxz.x, sqrt(max(float(1).sub(dot(nxz, nxz)), 0.0001)), nxz.y));
    normalLocal.assign(n);
    // +x along the surface (perpendicular to the normal), as a block top's tangent.
    tangentLocal.assign(normalize(vec3(n.y, n.x.negate(), 0)));
    vSample.assign(sm);
    vLayer.assign(node.w);
    const period = float(WORLD_UV_PERIOD_METRES);
    vUv.assign(node.xy.sub(floor(node.xy.div(period)).mul(period)).add(gm.mul(metres)));
    return vec3(node.x.add(gm.x.mul(metres)), u.low.add(step.mul(u.step)), node.y.add(gm.y.mul(metres)));
  })();
  const pixelLayer = int(vLayer.add(0.5));
  const weights = Fn(() => {
    const w = texture(layers, vSample.add(0.5).div(u.samples)).depth(pixelLayer);
    return vec4(w.r, w.g, w.b, max(float(1).sub(w.r).sub(w.g).sub(w.b), 0));
  })();
  const cell = clamp(floor(vSample), vec2(0), vec2(u.samples.sub(2)));
  const mask = textureLoad(layers, ivec2(int(cell.x), int(cell.y))).depth(pixelLayer).a.lessThan(0.5);
  return {
    key,
    uv: () => vUv,
    vertexColor: (name) => (name === 'color' ? weights : null),
    position,
    mask,
  };
}

/** A terrain's look without a graph material: its drawn layers' default colours mixed by their weights. */
export function defaultTerrainMaterial(surface: GraphSurface): THREE.Material {
  const m = new MeshStandardNodeMaterial();
  const c = TERRAIN_DEFAULT_COLOURS.map((hex) => {
    const col = new THREE.Color(hex);
    return vec3(col.r, col.g, col.b);
  });
  const w = surface.vertexColor('color')!;
  m.colorNode = vec4(c[0]!.mul(w.x).add(c[1]!.mul(w.y)).add(c[2]!.mul(w.z)).add(c[3]!.mul(w.w)), 1);
  m.positionNode = surface.position;
  m.maskNode = surface.mask;
  m.roughness = 0.95;
  m.metalness = 0;
  m.name = 'terrain';
  m.userData[STEADY_SHAPE_KEY] = true;
  return m as unknown as THREE.Material;
}
