/**
 * The light pass's shaders (`surface-light-pass.ts`), over the frame words
 * `surface-light-frame.ts` packs; `surface-light-cpu.ts` is their twin line
 * for line (the same random sequence per ray, so the two agree).
 *
 * - rays: one thread per ray: the ray's light (one of the slice's suns, or
 *   the slice's k-th light by its ray count), a point on it (the sun's
 *   disc, a small sphere round a point or spot light, an area light's
 *   rectangle or line) and the ray toward it, with the light's shadow
 *   caster mask; a light that casts no shadow gets a ray of length 0;
 * - gather: one thread per texel: each light's share over its rays
 *   (visible ones), into the texel's irradiance; a light held to rooms
 *   (`surface-rooms.ts`) adds nothing to a texel outside them.
 *
 * A texel's alpha says it was lit and how much of its light is the drawn
 * suns': 1 + their share (per sun max(n·l, 0) × the share of its rays that
 * reached it, weighted by its part of their summed luminance), 0 for a
 * texel with no surface. Materials draw directional lights per pixel (a
 * shadow map is sharper than a texel), so they take the drawn suns' summed
 * colour × that share back out of the texel's light (`SURFACE_TEXEL_LIT`).
 */
import { AREA_CONE, AREA_LINE, LIGHT_SHADOWS, LIGHT_WORDS, POINT_LIGHT_RADIUS, RAY_BIAS, SLICE_WORDS, SUN_DISC_RADIANS, SUN_WORDS } from './surface-light-frame';
import { NO_ROOM, roomsWgsl } from './surface-rooms';
import { TRACE_MISS } from './tracer-scene';

export const LIGHT_WORKGROUP = 64;
/** A lit texel's alpha before the sun's share is added (an unlit texel's is 0, so a filtered lookup's alpha, held to 1, says how much of it is lit). */
export const SURFACE_TEXEL_LIT = 1;

const COMMON = /* wgsl */ `
struct Params { texels: u32, rays: u32, slices: u32, seed: u32, lights: u32, sunAt: u32, roomsAt: u32, suns: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> F: array<u32>;
@group(0) @binding(2) var<storage, read> PT: array<f32>;
fn ff(i: u32) -> f32 { return bitcast<f32>(F[i]); }
fn fv(i: u32) -> vec3f { return vec3f(ff(i), ff(i + 1u), ff(i + 2u)); }
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(s: ptr<function, u32>) -> f32 { *s = pcg(*s); return f32(*s) / 4294967296.0; }
fn raySeed(r: u32) -> u32 { return pcg(r ^ (P.seed * 0x9e3779b9u)); }
// The slice holding item 'i' by the slice table's word 'w' (its first texel: 0, its first ray: 2).
fn sliceOf(i: u32, w: u32) -> u32 {
  var lo = 0u;
  var hi = P.slices - 1u;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi + 1u) >> 1u;
    if (F[mid * ${SLICE_WORDS}u + w] <= i) { lo = mid; } else { hi = mid - 1u; }
  }
  return lo;
}
fn pointOf(t: u32) -> vec3f { return vec3f(PT[t * 6u], PT[t * 6u + 1u], PT[t * 6u + 2u]); }
fn normalOf(t: u32) -> vec3f { return vec3f(PT[t * 6u + 3u], PT[t * 6u + 4u], PT[t * 6u + 5u]); }
fn lightAt(j: u32) -> u32 { return P.sunAt + P.suns * ${SUN_WORDS}u + j * ${LIGHT_WORDS}u; }
fn sunAt(i: u32) -> u32 { return P.sunAt + i * ${SUN_WORDS}u; }
fn raysOf(at: u32, level: u32) -> u32 { return max(1u, (F[at + 19u] & 255u) >> level); }
fn basis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(n, a));
  return mat3x3f(t, cross(n, t), n);
}
// A point on a local light for ray k of its n (its random numbers from the ray's seed): an area light's
// rays each in their own cell of its shape (n, a power of two, cut into sx × sy), so a few rays cover it evenly.
fn lightPoint(at: u32, k: u32, n: u32, seed: ptr<function, u32>) -> vec3f {
  let c = fv(at);
  if (ff(at + 7u) == ${AREA_CONE}.0) {
    let sx = 1u << ((firstLeadingBit(max(n, 1u)) + 1u) >> 1u);
    let sy = (n + sx - 1u) / sx;
    let a = (f32(k % sx) + rnd(seed)) / f32(sx) * 2.0 - 1.0;
    let b = (f32(k / sx) + rnd(seed)) / f32(sy) * 2.0 - 1.0;
    return c + fv(at + 12u) * a + fv(at + 16u) * b;
  }
  let u = vec3f(rnd(seed), rnd(seed), rnd(seed)) * 2.0 - 1.0;
  return c + normalize(u + vec3f(1e-6)) * ${POINT_LIGHT_RADIUS} * pow(rnd(seed), 0.3333);
}
`;

export const LIGHT_RAYS_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> R: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> M: array<u32>;

@compute @workgroup_size(${LIGHT_WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.rays) { return; }
  let s = sliceOf(g.x, 2u) * ${SLICE_WORDS}u;
  let local = g.x - F[s + 2u];
  let rpt = F[s + 3u];
  let t = F[s] + local / rpt;
  var k = local % rpt;
  let n = normalOf(t);
  let o = pointOf(t) + n * ${RAY_BIAS};
  var seed = raySeed(g.x);
  var d = vec3f(0.0, 1.0, 0.0);
  var tmax = 0.0;
  var mask = 0xffu;
  let sunRays = F[s + 6u];
  let level = F[s + 7u];
  if (dot(n, n) > 0.0) {
    // The slice's suns first (sunRays each, in bit order), then its lights.
    var sun = 0xffffffffu;
    var bits = F[s + 10u];
    loop {
      if (bits == 0u) { break; }
      let i = firstTrailingBit(bits);
      bits &= bits - 1u;
      if (k < sunRays) { sun = i; break; }
      k -= sunRays;
    }
    if (sun != 0xffffffffu) {
      let at = sunAt(sun);
      let sd = fv(at);
      // Each ray its own sector of the disc.
      let a = (f32(k) + rnd(&seed)) / f32(sunRays) * 6.2831853;
      let q = ${SUN_DISC_RADIANS} * sqrt(rnd(&seed));
      let b = basis(sd);
      d = normalize(sd + (b[0] * cos(a) + b[1] * sin(a)) * q);
      if (dot(d, n) > 0.0 && F[at + 7u] != 0u) { tmax = 1e4; }
      mask = F[at + 3u];
    } else {
      for (var i = 0u; i < F[s + 5u]; i++) {
        let at = lightAt(F[F[s + 4u] + i]);
        let rj = raysOf(at, level);
        if (k >= rj) { k -= rj; continue; }
        let e = lightPoint(at, k, rj, &seed);
        let v = e - o;
        let len = length(v);
        d = v / max(len, 1e-6);
        let margin = select(${POINT_LIGHT_RADIUS}, ${RAY_BIAS}, ff(at + 7u) == ${AREA_CONE}.0);
        if (dot(d, n) > 0.0 && len < ff(at + 3u) && (F[at + 19u] & ${LIGHT_SHADOWS}u) != 0u) { tmax = max(0.0, len - margin); }
        mask = (F[at + 19u] >> 16u) & 0xffu;
        break;
      }
    }
  }
  R[g.x * 2u] = vec4f(o, 0.0);
  R[g.x * 2u + 1u] = vec4f(d, tmax);
  M[g.x] = mask;
}
`;

export const LIGHT_GATHER_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(3) var<storage, read> H: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> E: array<vec4f>;
fn fw(i: u32) -> u32 { return F[i]; }
${roomsWgsl('fw', 'P.roomsAt')}
// Whether light record 'at' may light a texel in room 'room' (a light held to no rooms lights all).
fn lightsRoom(at: u32, room: u32) -> bool {
  let n = F[at + 21u];
  if (n == 0u) { return true; }
  for (var q = 0u; q < n; q++) { if (F[F[at + 20u] + q] == room) { return true; } }
  return false;
}

// Only a ray that met nothing reaches the light: one still out of steps after its resumes may have a wall ahead, so it counts as blocked.
fn visible(r: u32) -> f32 { let k = H[r * 2u + 1u].x & 255u; return select(0.0, 1.0, k == ${TRACE_MISS}u); }

// three's punctual falloff: inverse square, windowed to the light's reach.
fn window(d2: f32, reach: f32) -> f32 { let w = clamp(1.0 - pow(d2 / (reach * reach), 2.0), 0.0, 1.0); return w * w; }

@compute @workgroup_size(${LIGHT_WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.texels) { return; }
  let s = sliceOf(g.x, 0u) * ${SLICE_WORDS}u;
  let rpt = F[s + 3u];
  let r0 = F[s + 2u] + (g.x - F[s]) * rpt;
  let n = normalOf(g.x);
  let p = pointOf(g.x);
  let level = F[s + 7u];
  var e = vec3f(0.0);
  var sun = 0.0;
  if (dot(n, n) > 0.0) {
    var k = 0u;
    let sunRays = F[s + 6u];
    var bits = F[s + 10u];
    loop {
      if (bits == 0u) { break; }
      let at = sunAt(firstTrailingBit(bits));
      bits &= bits - 1u;
      var v = 0.0;
      for (var i = 0u; i < sunRays; i++) { v += visible(r0 + k + i); }
      k += sunRays;
      let lit = max(0.0, dot(n, fv(at))) * v / f32(sunRays);
      e += fv(at + 4u) * lit;
      // The drawn suns' luminance share (word 8: this sun's weight), taken back out where materials draw them.
      sun += ff(at + 8u) * lit;
    }
    // The texel's room, found once the first light held to rooms asks.
    var room = ${NO_ROOM - 1}u;
    for (var j = 0u; j < F[s + 5u]; j++) {
      let at = lightAt(F[F[s + 4u] + j]);
      let rj = raysOf(at, level);
      let reach = ff(at + 3u);
      if (F[at + 21u] != 0u) {
        if (room == ${NO_ROOM - 1}u) { room = texelRoom(F[s + 8u], F[s + 9u], p, n); }
        if (!lightsRoom(at, room)) { k += rj; continue; }
      }
      if (ff(at + 7u) == ${AREA_CONE}.0) {
        // Each ray's own point on the light: its share of the light's intensity there.
        let facing = fv(at + 8u);
        let two = ff(at + 11u) > 0.5;
        let line = F[at + 15u] == ${AREA_LINE}u;
        var sum = 0.0;
        for (var i = 0u; i < rj; i++) {
          var seed = raySeed(r0 + k + i);
          let lp = lightPoint(at, i, rj, &seed);
          let lv = lp - p;
          let d2 = max(dot(lv, lv), 1e-4);
          let l = lv * inverseSqrt(d2);
          let ce = dot(facing, -l);
          var emit = select(max(ce, 0.0), abs(ce), two);
          if (line) { emit = select(select(0.0, 1.0, ce > 0.0), 1.0, two); }
          sum += max(0.0, dot(n, l)) * emit * window(d2, reach) / d2 * visible(r0 + k + i);
        }
        e += fv(at + 4u) * sum / f32(rj);
      } else {
        var v = 0.0;
        for (var i = 0u; i < rj; i++) { v += visible(r0 + k + i); }
        let lv = fv(at) - p;
        let d2 = max(dot(lv, lv), 1e-4);
        let l = lv * inverseSqrt(d2);
        var cone = 1.0;
        if (ff(at + 7u) > -2.0) { cone = smoothstep(ff(at + 7u), ff(at + 11u), dot(-l, fv(at + 8u))); }
        e += fv(at + 4u) * max(0.0, dot(n, l)) * window(d2, reach) / d2 * cone * v / f32(rj);
      }
      k += rj;
    }
  }
  E[g.x] = vec4f(e, select(0.0, ${SURFACE_TEXEL_LIT.toFixed(1)} + sun, dot(n, n) > 0.0));
}
`;
