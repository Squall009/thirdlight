/**
 * Area lights (rect and line) in the light clusters' loop: three's
 * rectangle-light maths (linearly transformed cosines), on every lit
 * object, moving or reading the surface cache.
 *
 * - **Lighting models with their own rectangle light** (three's physical
 *   model: standard, physical, graph PBR and layered materials) get the
 *   light through their `directRectArea`, as three's `RectAreaLightNode`
 *   calls it: specular and diffuse (and clearcoat) from the same corners.
 * - **The others** (Lambert, Phong, custom-lit graphs) have no rectangle
 *   light: they get it through `direct` as its exact form factor (the LTC
 *   integral with the identity matrix, clipped at the horizon) toward the
 *   rectangle's centre, so their diffuse light is the area light's.
 * - **A line light** is a strip `LINE_HIGHLIGHT_METRES` wide along its
 *   length (the record's `v`), its radiance its intensity over the strip's
 *   area, as the surface cache's highlights drew it.
 * - **Falloff**: the surface cache's window over the light's reach from its
 *   centre, so a moving object and a cache-lit wall next to it get the same
 *   light.
 * - **The tables**: three's two LTC tables side by side in ONE half-float
 *   texture (one texture unit, `texture-units.ts`), read at level 0 (the loop
 *   is non-uniform control flow, where WGSL allows no implicit derivatives).
 *   While a spot projects a cookie they are the first tile of the cookie
 *   atlas (`cookie-atlas.ts`): the reads scale into the share they take.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';

import type { ClusterNodes } from './cluster-gpu';
import type { N } from './effects-tsl';

const TSL: N = TSLTyped;
const { LTC_Evaluate, clamp, cross, dot, float, mat3, max, normalView, positionView, positionViewDirection, select, vec2 } = TSL;

/** Texels a side of each of three's LTC tables (side by side: the tables take twice this across). */
export const LTC_SIZE = 64;

let tables: THREE.DataTexture | null = null;

/** three's two LTC tables as one texture's half floats, row by row: table 1 on the left half, table 2 on the right. */
export function ltcTablesData(): Uint16Array {
  return ltcTablesTexture().image.data as Uint16Array;
}

/** three's two LTC tables (half floats, filterable on every backend) as one texture: table 1 on the left half, table 2 on the right. */
export function ltcTablesTexture(): THREE.DataTexture {
  if (tables !== null) return tables;
  const lib = RectAreaLightTexturesLib.init() as unknown as Record<string, THREE.DataTexture>;
  const one = lib['LTC_HALF_1']!.image.data as Uint16Array;
  const two = lib['LTC_HALF_2']!.image.data as Uint16Array;
  const row = LTC_SIZE * 4;
  const data = new Uint16Array(2 * row * LTC_SIZE);
  for (let y = 0; y < LTC_SIZE; y += 1) {
    data.set(one.subarray(y * row, (y + 1) * row), y * 2 * row);
    data.set(two.subarray(y * row, (y + 1) * row), y * 2 * row + row);
  }
  const t = new THREE.DataTexture(data, 2 * LTC_SIZE, LTC_SIZE, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  tables = t;
  return t;
}

/** The two tables as three's `directRectArea` reads them from the lights' tables texture (`sample(uv)`; `LTC_Uv` keeps uv a half texel inside a table, so neither bleeds into the other). */
export function ltcNodes(t: ClusterNodes): { one: { sample(uv: N): N }; two: { sample(uv: N): N } } {
  const share = t.tablesShare;
  return {
    one: { sample: (uv: N) => t.tables.sample(vec2(uv.x.mul(0.5), uv.y).mul(share)).level(float(0)) },
    two: { sample: (uv: N) => t.tables.sample(vec2(uv.x.mul(0.5).add(0.5), uv.y).mul(share)).level(float(0)) },
  };
}

/** Whether a lighting model draws rectangle lights itself (three's base model's `directRectArea` draws nothing). */
export function drawsRectArea(model: unknown): boolean {
  const f = (model as { directRectArea?: unknown } | null)?.directRectArea;
  return typeof f === 'function' && f !== THREE.LightingModel.prototype.directRectArea;
}

/** One listed area light at this pixel. */
export interface AreaLightArgs {
  readonly builder: N;
  readonly ltc: ReturnType<typeof ltcNodes>;
  /** Its centre (view), reach, linear colour × intensity, half sides (view; `u × v` along its facing), and two-sided flag (bool node). */
  readonly centre: N;
  readonly reach: N;
  readonly colour: N;
  readonly u: N;
  readonly v: N;
  readonly twoSided: N;
  /** From the pixel to the centre, and its length. */
  readonly toLight: N;
  readonly distance: N;
  /** A factor on the light (its layer test), or null. */
  readonly gate: N | null;
  readonly reflectedLight: { directDiffuse: N; directSpecular: N };
}

/** Shade one area light into `reflectedLight` with the build's own lighting model. */
export function shadeAreaLight(a: AreaLightArgs): void {
  const { builder, u } = a;
  const model = builder.context.lightingModel;
  // three's LTC lights the side (p1 − p0) × (p3 − p0) = −4 u × v' faces: v' = −v lights the facing; a two-sided
  // light seen from behind keeps v.
  const back = a.twoSided.and(dot(a.toLight, cross(u, a.v)).greaterThan(0));
  const v = select(back, a.v, a.v.negate()).toVar();
  const d2 = a.distance.mul(a.distance);
  const r2 = a.reach.mul(a.reach);
  const window = clamp(float(1).sub(d2.div(r2).pow(2)), float(0), float(1)).pow(2);
  // Radiance: the whole intensity along the facing over the emitting area.
  const area = u.length().mul(a.v.length()).mul(4).max(1e-8);
  let radiance = a.colour.mul(window).div(area);
  if (a.gate !== null) radiance = radiance.mul(a.gate);
  const radianceVar = radiance.toVar();
  if (drawsRectArea(model)) {
    model.directRectArea({ lightColor: radianceVar, lightPosition: a.centre, halfWidth: u, halfHeight: v, reflectedLight: a.reflectedLight, ltc_1: a.ltc.one, ltc_2: a.ltc.two, lightNode: { light: {}, shadowNode: null } }, builder);
    return;
  }
  const c = a.centre;
  const p0 = c.add(u).sub(v);
  const p1 = c.sub(u).sub(v);
  const p2 = c.sub(u).add(v);
  const p3 = c.add(u).add(v);
  const formFactor = LTC_Evaluate({ N: normalView, V: positionViewDirection, P: positionView, mInv: mat3(1, 0, 0, 0, 1, 0, 0, 0, 1), p0, p1, p2, p3 }).x;
  const direction = a.toLight.div(a.distance.max(1e-6)).toVar();
  // `direct` takes irradiance as colour × N·L: the form factor's irradiance (π L F) over the centre's N·L.
  const nDotL = max(dot(normalView, direction), float(0.05));
  model.direct(
    {
      lightDirection: direction,
      lightColor: radianceVar.mul(formFactor.mul(Math.PI).div(nDotL)),
      lightNode: { light: {}, shadowNode: null },
      reflectedLight: a.reflectedLight,
    },
    builder,
  );
}
