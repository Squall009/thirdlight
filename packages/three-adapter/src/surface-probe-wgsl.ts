/**
 * The probe pass's shaders (`surface-probe-pass.ts`); `surface-probe-cpu.ts`
 * is their twin line for line (the same random turn per probe and update).
 *
 * - rays: one thread per ray: a probe's `PROBE_AXIS_RAYS` axis rays, then
 *   its `PROBE_SH_RAYS` directions (a spherical Fibonacci set turned at
 *   random); a probe in a room casts each only as far as the room's
 *   boundary (and `ROOM_EXIT_MARGIN` past it) unless it leaves by an open
 *   portal, no ray runs past a shut doorway, and a ray stopped so is held;
 * - (the tracer, closest hits, and the resolve pass find each hit's texel);
 * - gather: one workgroup per probe, one thread per direction: each ray's radiance — the sky where it
 *   met nothing, the room's own light off a held ray's wall, else
 *   `BOUNCE_ALBEDO` / π times the hit's irradiance (its cache texel's direct
 *   light and the probes' light there) — projected onto the first two SH
 *   bands, blended into the probe's record (`PROBE_BLEND_MIN` at least),
 *   with its back-face share and what its axis rays saw;
 * - commit: the updated records into the probes' own, after the gather (it
 *   reads the last update's light at its hits, whatever order the
 *   workgroups run in).
 *
 * Words (`W`): per probe of the update `PROBE_SLOT_WORDS` (its index, its
 * room, its position), the grids (`GRID_WORDS` each), the sky's four RGB
 * coefficients, the rooms (`surface-rooms.ts`).
 */
import { RESOLVE_PAGE, RESOLVE_RING } from './surface-resolve';
import { TERRAIN_RINGS_MAX, TERRAIN_RING_TEXELS } from './surface-cache-terrain';
import { SURFACE_PAGE_TEXELS } from './surface-cache-atlas';
import { ALBEDO_CELLS, ALBEDO_PAGE_STEP, ALBEDO_RING_STEP } from './surface-cache-lookup';
import { NO_ROOM, ROOM_EXIT_MARGIN, roomsWgsl } from './surface-rooms';
import { GRID_WORDS, PROBE_AXIS_RAYS, PROBE_RAYS, PROBE_SH_RAYS, SH_E0, SH_E1, SH_Y0, SH_Y1 } from './surface-probes';
import { PROBE_VALIDITY_THRESHOLD } from '@thirdlight/runtime';
import { TRACE_MISS, TRACE_UNFINISHED } from './tracer-scene';

export const PROBE_WORKGROUP = 64;
/** Words per probe of an update: its index, room and position. */
export const PROBE_SLOT_WORDS = 5;
/** Vec4s of a probe's record (`PROBE_FLOATS` / 4). */
export const PROBE_VEC4S = 6;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const COMMON = /* wgsl */ `
struct Params { slots: u32, rays: u32, grids: u32, gridAt: u32, skyAt: u32, roomsAt: u32, seed: u32, probes: u32, rayMax: f32, albedo: f32, lift: f32, blendMin: f32, albedoRingsAt: u32, pad1: u32, pad2: u32, pad3: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> W: array<u32>;
fn ww(i: u32) -> u32 { return W[i]; }
fn wf(i: u32) -> f32 { return bitcast<f32>(W[i]); }
fn wv(i: u32) -> vec3f { return vec3f(wf(i), wf(i + 1u), wf(i + 2u)); }
${roomsWgsl('ww', 'P.roomsAt')}
`;

export const PROBE_RAYS_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> R: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> M: array<u32>;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(s: ptr<function, u32>) -> f32 { *s = pcg(*s); return f32(*s) / 4294967296.0; }
// Direction k of a probe's update: an axis, or a Fibonacci direction turned by the probe's random turn this update.
fn probeRay(probe: u32, k: u32) -> vec3f {
  if (k < ${PROBE_AXIS_RAYS}u) {
    var a = vec3f(0.0);
    a[k >> 1u] = select(1.0, -1.0, (k & 1u) == 1u);
    return a;
  }
  let i = f32(k - ${PROBE_AXIS_RAYS}u);
  let z = 1.0 - (2.0 * i + 1.0) / ${PROBE_SH_RAYS}.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  // The angle kept within one turn: GPUs' sin and cos lose accuracy far from zero.
  let phi = fract(i * ${GOLDEN_ANGLE / (2 * Math.PI)}) * 6.2831853;
  let v = vec3f(r * cos(phi), z, r * sin(phi));
  var s = pcg(probe ^ (P.seed * 0x9e3779b9u));
  let u1 = rnd(&s);
  let u2 = rnd(&s) * 6.2831853;
  let u3 = rnd(&s) * 6.2831853;
  let q = vec4f(sqrt(1.0 - u1) * sin(u2), sqrt(1.0 - u1) * cos(u2), sqrt(u1) * sin(u3), sqrt(u1) * cos(u3));
  return normalize(v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v));
}

@compute @workgroup_size(${PROBE_WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.rays) { return; }
  let slot = g.x / ${PROBE_RAYS}u;
  let k = g.x % ${PROBE_RAYS}u;
  let at = slot * ${PROBE_SLOT_WORDS}u;
  let probe = W[at];
  let room = W[at + 1u];
  let o = wv(at + 2u);
  let d = probeRay(probe, k);
  var tmax = P.rayMax;
  var held = 0u;
  if (P.roomsAt != 0u) {
    if (room != ${NO_ROOM}u) {
      let e = roomExit(room, o, d);
      if (e >= 0.0 && e + ${ROOM_EXIT_MARGIN} < tmax) { tmax = e + ${ROOM_EXIT_MARGIN}; held = 1u; }
    }
    let door = closedPortal(o, d, tmax);
    if (door < tmax) { tmax = door; held = 1u; }
  }
  R[g.x * 2u] = vec4f(o, 0.0);
  R[g.x * 2u + 1u] = vec4f(d, tmax);
  M[g.x] = held;
}
`;

export const PROBE_GATHER_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(2) var<storage, read> PR: array<vec4f>;
@group(0) @binding(3) var<storage, read> R: array<vec4f>;
@group(0) @binding(4) var<storage, read> M: array<u32>;
@group(0) @binding(5) var<storage, read> H: array<vec4u>;
@group(0) @binding(6) var<storage, read> T: array<u32>;
@group(0) @binding(7) var<storage, read_write> O: array<vec4f>;
@group(0) @binding(8) var atlas: texture_2d_array<f32>;
@group(0) @binding(9) var rings: texture_2d_array<f32>;
@group(0) @binding(10) var<storage, read> ALB: array<u32>;

// Irradiance from first-order SH (band 0, then the y, z, x terms), as the probe lighting reads it.
fn shIrr(s0: vec4f, s1: vec4f, s2: vec4f, n: vec3f) -> vec3f {
  return ${SH_E0} * s0.xyz + ${SH_E1} * (vec3f(s0.w, s1.xy) * n.y + vec3f(s1.zw, s2.x) * n.z + s2.yzw * n.x);
}
fn sky(d: vec3f) -> vec3f {
  let a = P.skyAt;
  return max(vec3f(0.0), ${SH_Y0} * wv(a) + ${SH_Y1} * (wv(a + 3u) * d.y + wv(a + 6u) * d.z + wv(a + 9u) * d.x));
}
// The probes' irradiance at q facing n: the first grid within the lift of q (a room's only for a point in the room), q held inside it, trilinear by the probes' weights.
fn probesAt(qq: vec3f, n: vec3f) -> vec3f {
  for (var gi = 0u; gi < P.grids; gi++) {
    let at = P.gridAt + gi * ${GRID_WORDS}u;
    let mn = wv(at);
    let mx = wv(at + 3u);
    if (any(qq < mn - vec3f(P.lift)) || any(qq > mx + vec3f(P.lift))) { continue; }
    // Outside a room's grid only for a point in its room (not a doorway's far side).
    let room = W[at + 10u];
    if ((any(qq < mn) || any(qq > mx)) && room != ${NO_ROOM}u && (P.roomsAt == 0u || !roomHolds(room, qq))) { continue; }
    let q = clamp(qq, mn, mx);
    let res = vec3u(W[at + 6u], W[at + 7u], W[at + 8u]);
    let first = W[at + 9u];
    let span = max(mx - mn, vec3f(1e-6));
    let f = select(vec3f(0.0), (q - mn) / span * vec3f(res - 1u), res > vec3u(1u));
    let i0 = vec3u(clamp(floor(f), vec3f(0.0), vec3f(max(vec3i(res) - 2, vec3i(0)))));
    let t = select(vec3f(0.0), clamp(f - vec3f(i0), vec3f(0.0), vec3f(1.0)), res > vec3u(1u));
    var s0 = vec4f(0.0); var s1 = vec4f(0.0); var s2 = vec4f(0.0);
    var wsum = 0.0;
    for (var c = 0u; c < 8u; c++) {
      let o = vec3u(c & 1u, (c >> 1u) & 1u, (c >> 2u) & 1u);
      let ix = min(i0 + o, res - 1u);
      let tri = mix(1.0 - t.x, t.x, f32(o.x)) * mix(1.0 - t.y, t.y, f32(o.y)) * mix(1.0 - t.z, t.z, f32(o.z));
      let b = (first + ix.x + ix.y * res.x + ix.z * res.x * res.y) * ${PROBE_VEC4S}u;
      let info = PR[b + 3u];
      var w = select(select(1.0, 1.0 / 64.0, info.x > ${PROBE_VALIDITY_THRESHOLD}), 0.0, info.y < 1.0) * tri;
      if (w <= 0.0) { continue; }
      s0 += PR[b] * w; s1 += PR[b + 1u] * w; s2 += PR[b + 2u] * w;
      wsum += w;
    }
    if (wsum <= 0.0) { return vec3f(0.0); }
    return max(vec3f(0.0), shIrr(s0 / wsum, s1 / wsum, s2 / wsum, n));
  }
  return vec3f(0.0);
}
// A hit's direct light from its cache texel (none when its surface is not resident).
fn texelLight(r: u32) -> vec3f {
  let a = T[r * 2u];
  let b = T[r * 2u + 1u];
  let kind = a >> 30u;
  let xy = vec2i(i32(b & 0xffffu), i32(b >> 16u));
  if (kind == ${RESOLVE_PAGE}u) { return textureLoad(atlas, xy, i32(a & 0x3fffffffu), 0).rgb; }
  if (kind == ${RESOLVE_RING}u) { return textureLoad(rings, xy, i32(((a >> 3u) & 0x7ffffffu) * ${TERRAIN_RINGS_MAX}u + (a & 7u)), 0).rgb; }
  return vec3f(0.0);
}

// A hit's surface colour as the materials drawing it last put it in the cache (alpha 0: none drawn yet, the default).
fn texelAlbedo(r: u32) -> vec3f {
  let a = T[r * 2u];
  let b = T[r * 2u + 1u];
  let kind = a >> 30u;
  let x = b & 0xffffu;
  let y = b >> 16u;
  var w = 0xffffffffu;
  if (kind == ${RESOLVE_PAGE}u) { w = (a & 0x3fffffffu) * ${ALBEDO_CELLS}u + (y / ${ALBEDO_PAGE_STEP}u) * ${SURFACE_PAGE_TEXELS / ALBEDO_PAGE_STEP}u + x / ${ALBEDO_PAGE_STEP}u; }
  if (kind == ${RESOLVE_RING}u) { w = P.albedoRingsAt + (((a >> 3u) & 0x7ffffffu) * ${TERRAIN_RINGS_MAX}u + (a & 7u)) * ${ALBEDO_CELLS}u + (y / ${ALBEDO_RING_STEP}u) * ${TERRAIN_RING_TEXELS / ALBEDO_RING_STEP}u + x / ${ALBEDO_RING_STEP}u; }
  if (w >= arrayLength(&ALB)) { return vec3f(P.albedo); }
  let c = unpack4x8unorm(ALB[w]);
  return select(vec3f(P.albedo), c.rgb, c.a > 0.0);
}

// One ray's radiance toward the probe, and what it says of the probe's walls and validity.
struct RayLight { L: vec3f, t: f32, back: f32 }
fn rayLight(r: u32, o: vec3f, o0: vec4f, o1: vec4f, o2: vec4f) -> RayLight {
  let d = R[r * 2u + 1u].xyz;
  let h0 = H[r * 2u];
  let kind = H[r * 2u + 1u].x & 255u;
  var out = RayLight(vec3f(0.0), 0.0, 0.0);
  if (kind == ${TRACE_MISS}u || kind == ${TRACE_UNFINISHED}u) {
    if (M[r] == 1u) { out.L = P.albedo / 3.14159265 * max(vec3f(0.0), shIrr(o0, o1, o2, -d)); }
    else { out.L = sky(d); }
    return out;
  }
  out.t = bitcast<f32>(h0.x);
  let n = bitcast<vec3f>(h0.yzw);
  if (dot(n, d) > 0.0) { out.back = 1.0; return out; }
  let p = o + d * out.t;
  out.L = texelAlbedo(r) / 3.14159265 * (texelLight(r) + probesAt(p + n * P.lift, n));
  return out;
}

var<workgroup> SH: array<vec4f, ${PROBE_SH_RAYS * 3}>;
var<workgroup> BK: array<f32, ${PROBE_SH_RAYS}>;
var<workgroup> AX: array<f32, ${PROBE_AXIS_RAYS}>;

// One workgroup a probe, one thread a direction (the first threads also take the axis rays); the sums are reduced in the workgroup.
@compute @workgroup_size(${PROBE_SH_RAYS})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let slot = wg.x;
  let at = slot * ${PROBE_SLOT_WORDS}u;
  let probe = W[at];
  let o = wv(at + 2u);
  let base = probe * ${PROBE_VEC4S}u;
  let o0 = PR[base]; let o1 = PR[base + 1u]; let o2 = PR[base + 2u]; let info = PR[base + 3u];
  let k0 = slot * ${PROBE_RAYS}u;
  let r = k0 + ${PROBE_AXIS_RAYS}u + li;
  let d = R[r * 2u + 1u].xyz;
  let rl = rayLight(r, o, o0, o1, o2);
  let L = rl.L;
  // Coefficients in the record's order: band 0, then the y, z and x terms, RGB each.
  SH[li * 3u] = vec4f(L * ${SH_Y0}, L.x * ${SH_Y1} * d.y);
  SH[li * 3u + 1u] = vec4f(L.yz * (${SH_Y1} * d.y), L.xy * (${SH_Y1} * d.z));
  SH[li * 3u + 2u] = vec4f(L.z * ${SH_Y1} * d.z, L * (${SH_Y1} * d.x));
  BK[li] = rl.back;
  if (li < ${PROBE_AXIS_RAYS}u) { AX[li] = rayLight(k0 + li, o, o0, o1, o2).t; }
  workgroupBarrier();
  for (var step = ${PROBE_SH_RAYS / 2}u; step > 0u; step >>= 1u) {
    if (li < step) {
      SH[li * 3u] += SH[(li + step) * 3u];
      SH[li * 3u + 1u] += SH[(li + step) * 3u + 1u];
      SH[li * 3u + 2u] += SH[(li + step) * 3u + 2u];
      BK[li] += BK[li + step];
    }
    workgroupBarrier();
  }
  if (li != 0u) { return; }
  let w = 12.566371 / ${PROBE_SH_RAYS}.0;
  let a = max(1.0 / (info.y + 1.0), P.blendMin);
  let n0 = mix(o0, SH[0] * w, a);
  let n1 = mix(o1, SH[1] * w, a);
  let n2 = mix(o2, SH[2] * w, a);
  let n3 = vec4f(BK[0] / ${PROBE_SH_RAYS}.0, info.y + 1.0, 0.0, 0.0);
  let n4 = vec4f(AX[0], AX[1], AX[2], AX[3]);
  let n5 = vec4f(AX[4], AX[5], 0.0, 0.0);
  let ob = slot * ${PROBE_VEC4S}u;
  O[ob] = n0; O[ob + 1u] = n1; O[ob + 2u] = n2; O[ob + 3u] = n3; O[ob + 4u] = n4; O[ob + 5u] = n5;
}
`;

/** After the gather: the updated records into the probes' own (the gather reads only the last update's, as its CPU twin does). */
export const PROBE_COMMIT_WGSL = COMMON + /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> PR: array<vec4f>;
@group(0) @binding(3) var<storage, read> O: array<vec4f>;

@compute @workgroup_size(${PROBE_WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.slots * ${PROBE_VEC4S}u) { return; }
  let slot = g.x / ${PROBE_VEC4S}u;
  let k = g.x % ${PROBE_VEC4S}u;
  PR[W[slot * ${PROBE_SLOT_WORDS}u] * ${PROBE_VEC4S}u + k] = O[g.x];
}
`;
