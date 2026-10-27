/**
 * Highlights on the surfaces that read the surface cache.
 *
 * The cache holds diffuse light only. A reading pixel's highlights stay per
 * pixel: point and spot lights through three's own light nodes, area lights
 * (which three never draws) here, with three's rectangle-light maths
 * (linearly transformed cosines, `LTC_Evaluate`): their specular term only,
 * since their diffuse light is the cache's.
 *
 * - **Which area lights.** The `AREA_HIGHLIGHT_LIGHTS` area lights that
 *   matter most at the eye (intensity over distance squared) each frame,
 *   written to uniforms the reading programs read unrolled (a loop over a
 *   uniform array indexed by its counter cost the village ~0.5 ms). Every
 *   area light still lights the cache; only the per-pixel highlight is held
 *   to that many. Glowing surfaces give none (reflections show them).
 * - **A line light** is drawn as a strip `LINE_HIGHLIGHT_METRES` wide along
 *   its length (LTC integrates polygons; a thin rectangle is the nearest
 *   one), its radiance its intensity over the strip's area: right along its
 *   facing, dimmer than the cache's isotropic line toward grazing.
 * - **Shadowing: the cache's visibility, as a ratio.** The cache's texel
 *   already holds the traced, soft-shadowed light of those lights. A pixel
 *   compares it with the unshadowed diffuse light the same lights give it
 *   here (the area lights' LTC form factor, the point and spot lights'
 *   per-pixel diffuse light): their ratio is the share of the lights the
 *   texel sees, and every highlight is scaled by it (the ratio estimator of
 *   Heitz et al., "Combining analytic direct illumination and stochastic
 *   shadows", 2018). No memory per light and no extra ray: one division a
 *   pixel. It is one share for all of them (a pixel in one lamp's shadow and
 *   another's light takes the mean) and it clamps at 1 where the cache holds
 *   light the pixel does not shade (glowing surfaces, lights past the
 *   per-pixel cap).
 *
 * A light's highlight and its unshadowed light here fade with the cache's
 * window over its reach, and past its reach a pixel skips it.
 *
 * Programs that read the cache build the area slots only while the scene
 * has area lights (`AreaHighlights.present`, part of the variant's key).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';

import type { N } from './effects-tsl';
import { lightReach, type CacheLight } from './surface-changes';
import { texelTexture } from './texel-texture-node';

const TSL: N = TSLTyped;
const { If, LTC_Evaluate, LTC_Uv, cameraViewMatrix, clamp, cross, dot, float, int, luminance, mat3, max, normalView, positionView, positionViewDirection, roughness, select, specularColorBlended, specularF90, uniform, uniformArray, vec3, vec4 } = TSL;

/** The area lights whose highlights a reading pixel draws (the rest light the cache, with no highlight). */
export const AREA_HIGHLIGHT_LIGHTS = 4;
/** The width a line light's highlight is drawn with (m). */
export const LINE_HIGHLIGHT_METRES = 0.02;
/** A glowing surface's cache lights carry this in their id (they give no highlight). */
export const GLOW_LIGHT_MARK = '#glow';
/** A slot's vec4s: centre + two-sided, half width + reach, half height, radiance. */
const SLOT_VEC4S = 4;
/** The albedo luminance below which a pixel's per-pixel diffuse light is not turned back into irradiance (it is all but nothing there). */
const DARK_ALBEDO = 0.02;

/** The area lights' highlight slots of one scene's reading programs. */
export class AreaHighlights {
  readonly slots = uniformArray(Array.from({ length: AREA_HIGHLIGHT_LIGHTS * SLOT_VEC4S }, () => new THREE.Vector4()), 'vec4');
  readonly count = uniform(0, 'int');
  /** Whether the scene has area lights: reading programs built now take the slots (part of their key). */
  present = false;
  private readonly picked: { l: CacheLight; w: number }[] = [];

  /** This frame's slots: the area lights that matter most at `eye`. */
  set(lights: readonly CacheLight[], eye: ArrayLike<number>): void {
    const picked = this.picked;
    picked.length = 0;
    let any = false;
    for (const l of lights) {
      if (l.kind !== 'area' || l.area === undefined || l.id.includes(GLOW_LIGHT_MARK)) continue;
      any = true;
      if (!l.on) continue;
      const d2 = (l.position[0]! - eye[0]!) ** 2 + (l.position[1]! - eye[1]!) ** 2 + (l.position[2]! - eye[2]!) ** 2;
      const w = (0.2126 * l.color[0]! + 0.7152 * l.color[1]! + 0.0722 * l.color[2]!) / Math.max(d2, 1);
      if (w > 0) picked.push({ l, w });
    }
    this.present = any;
    picked.sort((a, b) => b.w - a.w);
    const n = Math.min(picked.length, AREA_HIGHLIGHT_LIGHTS);
    const s = (this.slots as unknown as { array: THREE.Vector4[] }).array;
    for (let i = 0; i < n; i += 1) writeSlot(s, i * SLOT_VEC4S, picked[i]!.l);
    (this.count as unknown as { value: number }).value = n;
  }
}

/**
 * One light's slot: its centre, its half sides `u` and `v` turned so
 * `u × v` points against its facing (three's LTC, with its corners
 * `c ± u ± v`, lights the side `(p1 − p0) × (p3 − p0) = −4 u × v` faces),
 * and its radiance.
 */
function writeSlot(s: THREE.Vector4[], at: number, l: CacheLight): void {
  const a = l.area!;
  const f = l.direction;
  const u = [a.u[0]!, a.u[1]!, a.u[2]!];
  let v = [a.v[0]!, a.v[1]!, a.v[2]!];
  const lu = Math.hypot(u[0]!, u[1]!, u[2]!) || 1e-6;
  let lv = Math.hypot(v[0]!, v[1]!, v[2]!);
  // A line: a thin strip across it, in the plane its facing is the normal of.
  if (lv < 1e-6) {
    const c = [f[1]! * u[2]! - f[2]! * u[1]!, f[2]! * u[0]! - f[0]! * u[2]!, f[0]! * u[1]! - f[1]! * u[0]!];
    const lc = Math.hypot(c[0]!, c[1]!, c[2]!) || 1;
    lv = LINE_HIGHLIGHT_METRES / 2;
    v = c.map((x) => (x / lc) * lv);
  }
  const uxv = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  if (uxv[0]! * f[0]! + uxv[1]! * f[1]! + uxv[2]! * f[2]! > 0) v = v.map((x) => -x);
  // Radiance: the whole intensity along the facing over the emitting area.
  const area = 4 * lu * lv;
  s[at]!.set(l.position[0]!, l.position[1]!, l.position[2]!, a.twoSided ? 1 : 0);
  s[at + 1]!.set(u[0]!, u[1]!, u[2]!, lightReach(l));
  s[at + 2]!.set(v[0]!, v[1]!, v[2]!, 0);
  s[at + 3]!.set(l.color[0]! / area, l.color[1]! / area, l.color[2]! / area, 0);
}

let ltc: { one: N; two: N } | null = null;

/** three's LTC tables (64² each), made once a page. */
function ltcNodes(builder: N): { one: N; two: N } {
  if (ltc === null) {
    const lib = RectAreaLightTexturesLib.init() as unknown as Record<string, THREE.Texture>;
    const float32 = builder.isAvailable?.('float32Filterable') === true;
    ltc = { one: texelTexture(lib[float32 ? 'LTC_FLOAT_1' : 'LTC_HALF_1']!), two: texelTexture(lib[float32 ? 'LTC_FLOAT_2' : 'LTC_HALF_2']!) };
  }
  return ltc;
}

/** Whether a build shades highlights (three's physical lighting: standard, physical, graph and layered materials). */
export function buildsHighlights(builder: N): boolean {
  return builder.context?.lightingModel instanceof THREE.PhysicalLightingModel;
}

/**
 * The area lights' highlight at this pixel (Fresnel-weighted, unshadowed)
 * and their unshadowed diffuse light as irradiance ÷ π: three's
 * `directRectArea` with the specular and diffuse forms evaluated once a
 * light and the LTC tables read once for all of them.
 */
export function areaHighlightNodes(builder: N, h: AreaHighlights): { specular: N; irradiance: N } {
  const t = ltcNodes(builder);
  const Nn = normalView;
  const V = positionViewDirection;
  const P = positionView.toVar('tlAreaP');
  const uv = LTC_Uv({ N: Nn, V, roughness });
  const t1 = t.one.sample(uv).toVar('tlLtc1');
  const t2 = t.two.sample(uv).toVar('tlLtc2');
  const mInv = mat3(vec3(t1.x, 0, t1.y), vec3(0, 1, 0), vec3(t1.z, 0, t1.w)).toVar('tlLtcM');
  const one = mat3(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const spec = vec3(0).toVar('tlAreaSpec');
  const irr = vec3(0).toVar('tlAreaIrr');
  for (let i = 0; i < AREA_HIGHLIGHT_LIGHTS; i += 1) {
    If(h.count.greaterThan(int(i)), () => {
      const [s0, s1, s2, s3] = [0, 1, 2, 3].map((k) => h.slots.element(int(i * SLOT_VEC4S + k))) as [N, N, N, N];
      const c = cameraViewMatrix.mul(vec4(s0.xyz, 1)).xyz.toVar();
      const toC = P.sub(c);
      const d2 = dot(toC, toC).toVar();
      // Past its reach a light gives nothing (the cache's window, which its highlight follows too).
      If(d2.lessThan(s1.w.mul(s1.w)), () => {
        const u0 = cameraViewMatrix.mul(vec4(s1.xyz, 0)).xyz;
        const v = cameraViewMatrix.mul(vec4(s2.xyz, 0)).xyz;
        // A two-sided light turned toward the pixel's side (LTC lights one side).
        const flip = s0.w.greaterThan(0.5).and(dot(toC, cross(u0, v)).greaterThan(0));
        const u = select(flip, u0.negate(), u0);
        const p0 = c.add(u).sub(v);
        const p1 = c.sub(u).sub(v);
        const p2 = c.sub(u).add(v);
        const p3 = c.add(u).add(v);
        const w = clamp(float(1).sub(d2.div(s1.w.mul(s1.w)).pow(2)), float(0), float(1)).pow(2);
        const radiance = s3.xyz.mul(w);
        spec.addAssign(radiance.mul(LTC_Evaluate({ N: Nn, V, P, mInv, p0, p1, p2, p3 })));
        irr.addAssign(radiance.mul(LTC_Evaluate({ N: Nn, V, P, mInv: one, p0, p1, p2, p3 })));
      });
    });
  }
  // Stephen Hill's LTC Fresnel, as three's rect lights.
  const fresnel = specularColorBlended.mul(t2.x).add(specularF90.sub(specularColorBlended).mul(t2.y));
  return { specular: spec.mul(fresnel), irradiance: irr };
}

/**
 * The share of the lights a reading pixel shades per pixel that its cache
 * texel sees (0–1): the cache's irradiance (÷ π, the sun's share out) over
 * the same lights' unshadowed irradiance here — the area lights' and the
 * point and spot lights' (their diffuse light over the albedo).
 */
export function cacheVisibility(cacheIrradiance: N, areaIrradiance: N, localDiffuse: N, albedo: N): N {
  const a = luminance(albedo);
  const local = select(a.greaterThan(DARK_ALBEDO), luminance(localDiffuse).div(max(a, float(DARK_ALBEDO))), float(0));
  const unshadowed = luminance(areaIrradiance).add(local);
  return clamp(luminance(cacheIrradiance).div(max(unshadowed, float(1e-6))), float(0), float(1));
}
