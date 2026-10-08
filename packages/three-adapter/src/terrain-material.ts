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
 * texture coordinates are metres from the terrain's texture origin (its
 * object, or the block layer it meets: `uvShift`, so both lay their textures
 * alike across the border) less whole `WORLD_UV_PERIOD_METRES`, as block
 * layers' are, +u along x, +v along z.
 *
 * Per pixel: the four channels' weights (a linear sample of the layer
 * texture: channels 0–2, the rest is channel 3) stand in for COLOR_0, which
 * the layered template reads as its paint; the nearest sample's layer
 * indices say which texture-array layer each of the template's four layer
 * slots reads there (`GraphSurface.arrayLayer`), so a terrain draws any
 * number of layers through four slots; a cell marked as a hole is cut away
 * (the mask, also in the shadow pass). The terrain's own reads per pixel are
 * three: the weights, the indices and the hole; the layered template's
 * twelve come on top (fifteen in all).
 *
 * A layer slot's settings (tiling, normal strength, height contrast and
 * offset: the template's vec4 per-layer parameters) are its layer's own: a
 * setting with values for layers past the fourth (`extraLayers`) keeps them
 * in a uniform array, and each slot picks its layer's (no texture read);
 * without them layer L takes the vector's component L % 4.
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
const { Fn, Loop, attribute, cameraViewMatrix, clamp, cos, dot, float, floor, fract, int, ivec2, length, max, min, mix, modelWorldMatrix, normalLocal, normalize, positionGeometry, renderGroup, select, sin, sqrt, tangentLocal, texture, textureLoad, uniform, uniformArray, varyingProperty, vec2, vec3, vec4 } = TSL;

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
  /** Metres the texture coordinates are shifted by (x, z): the object's place less its texture origin, within a period. */
  readonly uvShift: N;
}

export function terrainUniforms(): TerrainUniforms {
  return { samples: uniform(257), spacing: uniform(1), low: uniform(0), step: uniform(1), grid: uniform(16), uvShift: uniform(new THREE.Vector2()) };
}

/** The shift `uvShift` holds for a terrain at `origin` counting its texture coordinates from `uvOrigin` (x, z; absent: its own place). */
export function terrainUvShift(origin: readonly number[], uvOrigin: readonly number[] | undefined): [number, number] {
  if (uvOrigin === undefined) return [0, 0];
  const wrap = (v: number): number => v - Math.floor(v / WORLD_UV_PERIOD_METRES) * WORLD_UV_PERIOD_METRES;
  return [wrap((origin[0] ?? 0) - uvOrigin[0]!), wrap((origin[2] ?? 0) - uvOrigin[1]!)];
}

/** The default look of a terrain without a graph material: its four channels as plain colours (sRGB; layer L shows channel L % 4's). */
export const TERRAIN_DEFAULT_COLOURS: readonly string[] = Object.freeze(['#6f8a4a', '#8a6f4f', '#8a8580', '#c8b98a']);

/**
 * What a far-ground bake reads to measure a tile's horizon (`horizon`): the
 * texture layers of the tile and its eight neighbours on the page (3 × 3,
 * rows from −z, the tile's own in the middle; −1 where a neighbour is not on
 * the page: the march stays on the tile's edge there), the direction toward
 * the sun (world, unit) and how many samples a march reaches.
 */
export interface TerrainHorizonUniforms {
  readonly neighbours: N;
  readonly sun: N;
  readonly reach: N;
}

/** Horizontal directions a horizon is measured in for the sky's share (and one more toward the sun). */
export const TERRAIN_HORIZON_DIRECTIONS = 8;
/** Heights read along each direction (nearer ones closer together). */
export const TERRAIN_HORIZON_STEPS = 10;

/** A page's surface as the terrain's own materials read it too: a pixel's place in its tile (0-1, +u along x, +v along z) and its tile's texture layer. */
export interface TerrainSurface extends GraphSurface {
  readonly tileUv: N;
  readonly tileLayer: N;
  /**
   * The ground's horizon round a pixel, measured over the heights (a bake's
   * node, not a draw's: dozens of reads): x the share of the sky it sees
   * (one less the mean sine of the horizon's angle over
   * {@link TERRAIN_HORIZON_DIRECTIONS} directions, so a flat plain is 1 and
   * a valley's floor less), y whether the sun clears the horizon toward it
   * (1 lit, 0 behind the ground, soft over a few degrees).
   */
  horizon(h: TerrainHorizonUniforms): N;
}

/** Decode a texel's 16-bit step (R high byte, G low byte). */
const stepOf = (t: N): N => floor(t.r.mul(255).add(0.5)).mul(256).add(floor(t.g.mul(255).add(0.5)));

/**
 * The surface a terrain page's materials compile against: its height,
 * layer-weight and layer-index texture arrays, its shape values, and `key`
 * naming it (a page's textures replaced by larger ones take a new key, so a
 * new compile).
 */
export function terrainSurface(key: string, heights: THREE.DataArrayTexture, layers: THREE.DataArrayTexture, indices: THREE.DataArrayTexture, u: TerrainUniforms): TerrainSurface {
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
    vUv.assign(node.xy.sub(floor(node.xy.div(period)).mul(period)).add(gm.mul(metres)).add(u.uvShift));
    return vec3(node.x.add(gm.x.mul(metres)), u.low.add(step.mul(u.step)), node.y.add(gm.y.mul(metres)));
  })();
  const pixelLayer = int(vLayer.add(0.5));
  const weights = Fn(() => {
    const w = texture(layers, vSample.add(0.5).div(u.samples)).depth(pixelLayer);
    return vec4(w.r, w.g, w.b, max(float(1).sub(w.r).sub(w.g).sub(w.b), 0));
  })();
  const cell = clamp(floor(vSample), vec2(0), vec2(u.samples.sub(2)));
  const mask = textureLoad(layers, ivec2(int(cell.x), int(cell.y))).depth(pixelLayer).a.lessThan(0.5);
  // The nearest sample's layer per channel (the weight filtered in from a neighbour names the same layer there: see terrain-texels.ts).
  const near = clamp(floor(vSample.add(0.5)), vec2(0), vec2(u.samples.sub(1)));
  const ids = textureLoad(indices, ivec2(int(near.x), int(near.y))).depth(pixelLayer).mul(255).add(0.5).floor();
  const arrayLayer = (slot: N): N => {
    const s = floor(slot.add(0.5));
    const mapped = select(s.lessThan(0.5), ids.x, select(s.lessThan(1.5), ids.y, select(s.lessThan(2.5), ids.z, ids.w)));
    // A layer a graph reads past the four slots is its own.
    return select(s.lessThan(3.5), mapped, slot);
  };
  const perLayer = (value: N, extra: readonly number[]): N => {
    // Four layers' values a vec4 (uniform arrays pad each element to a vec4).
    const packed: THREE.Vector4[] = [];
    for (let i = 0; i < extra.length; i += 4) packed.push(new THREE.Vector4(extra[i] ?? 0, extra[i + 1] ?? 0, extra[i + 2] ?? 0, extra[i + 3] ?? 0));
    const values = uniformArray(packed, 'vec4');
    const count = float(extra.length);
    const slot = (k: number, own: N): N => {
      const past = ids[(['x', 'y', 'z', 'w'] as const)[k]!].sub(4);
      const el = values.element(int(clamp(floor(past.div(4)), 0, packed.length - 1)));
      const c = past.sub(floor(past.div(4)).mul(4));
      const v = select(c.lessThan(0.5), el.x, select(c.lessThan(1.5), el.y, select(c.lessThan(2.5), el.z, el.w)));
      // Layers 0-3 and those past the list take the vector's component (layer L is drawn through slot L % 4).
      return select(past.greaterThanEqual(0).and(past.lessThan(count)), v, own);
    };
    return vec4(slot(0, value.x), slot(1, value.y), slot(2, value.z), slot(3, value.w));
  };
  /** A height (metres, the terrain's frame) at a place in samples from this tile's min corner, read from the tile or the neighbour holding it. */
  const heightAtSample = (h: TerrainHorizonUniforms, s: N): N => {
    const n = u.samples.sub(1);
    const t = clamp(floor(s.div(n)), vec2(-1), vec2(1));
    const near = h.neighbours.element(int(t.y.add(1).mul(3).add(t.x.add(1))));
    const has = near.greaterThanEqual(0);
    const local = select(has, s.sub(t.mul(n)), clamp(s, vec2(0), vec2(n)));
    const at = clamp(floor(local.add(0.5)), vec2(0), vec2(n));
    const layer = int(select(has, near, float(pixelLayer)).add(0.5));
    return u.low.add(stepOf(texel(layer, int(at.x), int(at.y))).mul(u.step));
  };
  /**
   * The horizon measured as loops in the shader (unrolled, its dozens of reads would make a program that takes
   * long to build): per direction — the fixed ones, then one toward the sun — the steepest rise (tangent, at least
   * level) out to the reach, nearer reads closer together.
   */
  const horizon = (h: TerrainHorizonUniforms): N =>
    Fn(() => {
      const s0 = vSample;
      const h0 = heightAtSample(h, s0).toVar();
      const across = length(h.sun.xz);
      const toward = h.sun.xz.div(max(across, 1e-4));
      const open = float(0).toVar();
      const ridge = float(0).toVar();
      Loop({ start: int(0), end: int(TERRAIN_HORIZON_DIRECTIONS + 1), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const a = float(i).mul((2 * Math.PI) / TERRAIN_HORIZON_DIRECTIONS);
        const dir = select(i.lessThan(TERRAIN_HORIZON_DIRECTIONS), vec2(cos(a), sin(a)), toward).toVar();
        const best = float(0).toVar();
        Loop({ start: int(1), end: int(TERRAIN_HORIZON_STEPS + 1), type: 'int', condition: '<' }, ({ i: j }: { i: N }) => {
          const f = float(j).div(TERRAIN_HORIZON_STEPS);
          const d = max(h.reach.mul(f.mul(f)), 1);
          best.assign(max(best, heightAtSample(h, s0.add(dir.mul(d))).sub(h0).div(d.mul(u.spacing))));
        });
        // The sky above the horizon in a fixed slice: 1 − sin(angle); the last direction is the sun's.
        open.addAssign(select(i.lessThan(TERRAIN_HORIZON_DIRECTIONS), float(1).sub(best.div(sqrt(best.mul(best).add(1)))), float(0)));
        ridge.assign(select(i.lessThan(TERRAIN_HORIZON_DIRECTIONS), ridge, best));
      });
      const elevation = h.sun.y.div(max(across, 1e-4));
      // A sun straight overhead (no direction across) clears every horizon.
      const sun = select(across.lessThan(1e-3), float(1), clamp(elevation.sub(ridge).div(0.1).add(0.5), 0, 1));
      return vec2(open.div(TERRAIN_HORIZON_DIRECTIONS), sun);
    })();
  return {
    key,
    horizon,
    uv: () => vUv,
    vertexColor: (name) => (name === 'color' ? weights : null),
    position,
    mask,
    arrayLayer,
    perLayer,
    tileUv: vSample.div(u.samples.sub(1)),
    tileLayer: pixelLayer,
  };
}

/** WebGL 2 draws a target bottom-up: a macro texture baked there holds its rows from +z (1 there, 0 on WebGPU). */
export const terrainMacroFlip: N = uniform(0);

/**
 * A terrain's look past its macro distance: each tile's baked albedo and
 * world normal (`terrain-macro.ts`) instead of the layer stack — two texture
 * reads besides the hole — lit as the layered ground is (rough, not metal).
 * The bakes' horizon terms light it where nothing else does that far out:
 * the sky's share it sees darkens its ambient and probe light (as ambient
 * occlusion), and the sun behind the horizon shadows it (with the shadow
 * maps, where they reach).
 */
export function terrainMacroMaterial(surface: TerrainSurface, albedo: THREE.DataArrayTexture, normal: THREE.DataArrayTexture): THREE.Material {
  const m = new MeshStandardNodeMaterial();
  const uv = vec2(surface.tileUv.x, mix(surface.tileUv.y, float(1).sub(surface.tileUv.y), terrainMacroFlip));
  const a = texture(albedo, uv).depth(surface.tileLayer);
  const baked = texture(normal, uv).depth(surface.tileLayer);
  const n = normalize(baked.xyz.mul(2).sub(1));
  m.colorNode = vec4(a.rgb, 1);
  m.aoNode = a.a;
  (m as unknown as { receivedShadowNode: N }).receivedShadowNode = Fn(([shadow]: [N]) => shadow.mul(baked.a));
  // The baked normal is in world space; the material's normal is the view's.
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(n, 0)).xyz);
  m.positionNode = surface.position;
  m.maskNode = surface.mask;
  m.roughness = 0.9;
  m.metalness = 0;
  m.name = 'terrain-macro';
  m.userData[STEADY_SHAPE_KEY] = true;
  return m as unknown as THREE.Material;
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
