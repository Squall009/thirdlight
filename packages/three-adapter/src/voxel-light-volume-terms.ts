/**
 * The light a spot's cone and an area light give a surface, as the voxel
 * light volume's update lights a ray's hit with them: written once over
 * `ScalarOps`, so the update's WGSL (`volumeLampTermsWgsl`, through
 * `wgslScalarWriter`) and the CPU reference the tests run are one
 * definition. The maths is the clustered per-pixel light's
 * (`cluster-lights.ts`, `cluster-area.ts`), which three's shader nodes draw;
 * a test holds the two equal against a line-by-line CPU copy of those nodes.
 *
 * - **A spot's cone**: three's `smoothstep(cos outer, cos inner, cos to the
 *   axis)`. Equal edges (no soft edge) are a step: WGSL leaves smoothstep
 *   undefined there, so the per-pixel light's own value at that one edge is
 *   the GPU's.
 * - **An area light's diffuse light** (rect, or a line as the strip
 *   `ClusterLights` gives it): the form the clustered loop uses for lighting
 *   models without a rectangle light of their own, three's LTC integral with
 *   the identity matrix (`LTC_Evaluate`: the four edges' vector form factor,
 *   clipped at the horizon by its sphere fit), lit on its facing side only
 *   unless two-sided, its radiance the colour over the emitting area, faded
 *   by the window toward its reach from its centre. Irradiance is π × colour
 *   × the returned factor, as `direct` receives it there (`π L F`), and the
 *   diffuse light of three's physical model (`L × albedo × F`) is the same.
 *   The vector sum is taken in world space: three's frame round the normal
 *   is mirrored (its second tangent is negated), so the normal's part of the
 *   sum changes sign there, and the view direction it is built from drops
 *   out.
 */
import type { ScalarOps } from '@thirdlight/shared';

import { wgslStepFn } from './voxel-walk-wgsl';

type V3<F> = readonly [F, F, F];

const add3 = <F, B>(o: ScalarOps<F, B>, a: V3<F>, b: V3<F>): V3<F> => [o.add(a[0], b[0]), o.add(a[1], b[1]), o.add(a[2], b[2])];
const sub3 = <F, B>(o: ScalarOps<F, B>, a: V3<F>, b: V3<F>): V3<F> => [o.sub(a[0], b[0]), o.sub(a[1], b[1]), o.sub(a[2], b[2])];
const scale3 = <F, B>(o: ScalarOps<F, B>, a: V3<F>, s: F): V3<F> => [o.mul(a[0], s), o.mul(a[1], s), o.mul(a[2], s)];
const dot3 = <F, B>(o: ScalarOps<F, B>, a: V3<F>, b: V3<F>): F => o.add(o.add(o.mul(a[0], b[0]), o.mul(a[1], b[1])), o.mul(a[2], b[2]));
const cross3 = <F, B>(o: ScalarOps<F, B>, a: V3<F>, b: V3<F>): V3<F> => [
  o.sub(o.mul(a[1], b[2]), o.mul(a[2], b[1])),
  o.sub(o.mul(a[2], b[0]), o.mul(a[0], b[2])),
  o.sub(o.mul(a[0], b[1]), o.mul(a[1], b[0])),
];
const clamp01 = <F, B>(o: ScalarOps<F, B>, x: F): F => o.min(o.max(x, o.n(0)), o.n(1));
const unit3 = <F, B>(o: ScalarOps<F, B>, a: V3<F>): V3<F> => scale3(o, a, o.div(o.n(1), o.sqrt(dot3(o, a, a))));

/** A spot's cone at a surface whose way to the light makes cos `cosToAxis` with the way back along its axis: 0 outside, 1 inside the inner cone. */
export function spotConeSteps<F, B>(o: ScalarOps<F, B>, cosToAxis: F, cosOuter: F, cosInner: F): F {
  const t = clamp01(o, o.div(o.sub(cosToAxis, cosOuter), o.max(o.sub(cosInner, cosOuter), o.n(1e-6))));
  return o.mul(o.mul(t, t), o.sub(o.n(3), o.mul(o.n(2), t)));
}

/** One edge's vector form factor (three's `LTC_EdgeVectorFormFactor`: a rational fit of θ / sin θ / 2π). */
function edgeSteps<F, B>(o: ScalarOps<F, B>, v1: V3<F>, v2: V3<F>): V3<F> {
  const x = dot3(o, v1, v2);
  const y = o.max(x, o.sub(o.n(0), x));
  const a = o.add(o.mul(o.add(o.mul(y, o.n(0.0145206)), o.n(0.4965155)), y), o.n(0.8543985));
  const b = o.add(o.mul(o.add(y, o.n(4.1616724)), y), o.n(3.417594));
  const v = o.div(a, b);
  const far = o.sub(o.div(o.n(0.5), o.sqrt(o.max(o.sub(o.n(1), o.mul(x, x)), o.n(1e-7)))), v);
  return scale3(o, cross3(o, v1, v2), o.select(o.lt(o.n(0), x), v, far));
}

/**
 * An area light's diffuse light on a surface at `p` facing `n` (unit), as a factor of its colour × intensity: the
 * irradiance is π × colour × this. `c` its centre, `u` and `v` its half sides (`u × v` along its facing, as
 * `ClusterLights` keeps them), `twoSided` 1 or 0, `reach` where its window ends.
 */
export function areaLightSteps<F, B>(o: ScalarOps<F, B>, p: V3<F>, n: V3<F>, c: V3<F>, u: V3<F>, v: V3<F>, twoSided: F, reach: F): F {
  const toLight = sub3(o, c, p);
  // As the clustered loop: v' = −v lights the facing; a two-sided light seen from behind keeps v.
  const behind = o.lt(o.n(0), dot3(o, toLight, cross3(o, u, v)));
  const flip = o.select(o.lt(o.n(0.5), twoSided), o.select(behind, o.n(1), o.n(-1)), o.n(-1));
  const w = scale3(o, v, flip);
  const p0 = sub3(o, add3(o, c, u), w);
  const p1 = sub3(o, sub3(o, c, u), w);
  const p2 = add3(o, sub3(o, c, u), w);
  const p3 = add3(o, add3(o, c, u), w);
  // three's back-side test: lit where (p1 − p0) × (p3 − p0) faces the point (on its plane too).
  const front = dot3(o, cross3(o, sub3(o, p1, p0), sub3(o, p3, p0)), sub3(o, p, p0));
  const k0 = unit3(o, sub3(o, p0, p));
  const k1 = unit3(o, sub3(o, p1, p));
  const k2 = unit3(o, sub3(o, p2, p));
  const k3 = unit3(o, sub3(o, p3, p));
  const f = add3(o, add3(o, edgeSteps(o, k0, k1), edgeSteps(o, k1, k2)), add3(o, edgeSteps(o, k2, k3), edgeSteps(o, k3, k0)));
  const l = o.sqrt(dot3(o, f, f));
  const fz = o.sub(o.n(0), dot3(o, f, n));
  const formFactor = o.max(o.div(o.add(o.mul(l, l), fz), o.add(l, o.n(1))), o.n(0));
  const d2 = dot3(o, toLight, toLight);
  const s = o.div(d2, o.mul(reach, reach));
  const win = clamp01(o, o.sub(o.n(1), o.mul(s, s)));
  const area = o.max(o.mul(o.n(4), o.mul(o.sqrt(dot3(o, u, u)), o.sqrt(dot3(o, v, v)))), o.n(1e-8));
  const lit = o.div(o.mul(formFactor, o.mul(win, win)), area);
  return o.select(o.lt(front, o.n(0)), o.n(0), lit);
}

const xyz = (name: string): V3<string> => [`${name}x`, `${name}y`, `${name}z`];

/** The spot's cone in WGSL: `volume_spot_cone(cos_to_axis, cos_outer, cos_inner) -> f32`. */
export function volumeSpotConeWgsl(): string {
  return wgslStepFn('volume_spot_cone', ['cos_to_axis', 'cos_outer', 'cos_inner'], 'f32', (w) => spotConeSteps(w.ops, 'cos_to_axis', 'cos_outer', 'cos_inner'));
}

/**
 * The terms in WGSL: {@link volumeSpotConeWgsl}'s and
 * `volume_area_light(p, n, c, u, v: vec3<f32>, two_sided, reach: f32) -> f32`.
 */
export function volumeLampTermsWgsl(): string {
  const areaArgs = ['p', 'n', 'c', 'u', 'v'].flatMap(xyz);
  return [
    volumeSpotConeWgsl(),
    wgslStepFn('volume_area_steps', [...areaArgs, 'two_sided', 'reach'], 'f32', (w) => areaLightSteps(w.ops, xyz('p'), xyz('n'), xyz('c'), xyz('u'), xyz('v'), 'two_sided', 'reach')),
    `fn volume_area_light(p: vec3<f32>, n: vec3<f32>, c: vec3<f32>, u: vec3<f32>, v: vec3<f32>, two_sided: f32, reach: f32) -> f32 {\n  return volume_area_steps(${['p', 'n', 'c', 'u', 'v'].flatMap((a) => [`${a}.x`, `${a}.y`, `${a}.z`]).join(', ')}, two_sided, reach);\n}`,
  ].join('\n\n');
}
