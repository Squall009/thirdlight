/**
 * The resolve pass: one thread per traced hit finds the cache texel its
 * light is in, from the table `surface-resolve.ts` packs. It is
 * `resolveHitCpu` line for line; the browser run (`tools/perf/tracer-run.ts`)
 * holds the two to each other.
 *
 * Bindings: 0 the dispatch's parameters (hit count, first hit), 1 the
 * table, 2 the tracer's hits (two vec4u each), 3 the texels (a vec2u each).
 */
import { ARCH_R_WORDS, CHART_WORDS, COMP_WORDS, EMPTY_SLOT, HASH_WORDS, LAYER_R_WORDS, MODEL_R_WORDS, RESOLVE_PAGE, RESOLVE_RING, TERRAIN_R_WORDS } from './surface-resolve';
import { SURFACE_CHART_METRES } from './surface-cache-atlas';
import { TRACE_ARCH, TRACE_BLOCKS, TRACE_BRICKS, TRACE_TERRAIN } from './tracer-scene';

/** Threads per workgroup. */
export const RESOLVE_WORKGROUP = 64;

export const RESOLVE_WGSL = /* wgsl */ `
struct Params { count: u32, base: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> T: array<u32>;
@group(0) @binding(2) var<storage, read> H: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> X: array<vec2u>;

const CHART_METRES = ${SURFACE_CHART_METRES};
const NONE = vec2u(0u, 0u);

fn tf(i: u32) -> f32 { return bitcast<f32>(T[i]); }
fn ti(i: u32) -> i32 { return bitcast<i32>(T[i]); }

fn facingOf(n: vec3f) -> u32 {
  let a = abs(n);
  var axis = 2u;
  if (a.x >= a.y && a.x >= a.z) { axis = 0u; } else if (a.y >= a.z) { axis = 1u; }
  return axis * 2u + select(0u, 1u, n[axis] < 0.0);
}

fn surfelHash(c: vec3i, facing: u32, cap: u32) -> u32 {
  let h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u) ^ (facing * 0x9e3779b1u);
  return h & (cap - 1u);
}

fn planeAxes(axis: u32) -> vec2u {
  if (axis == 0u) { return vec2u(2u, 1u); }
  if (axis == 1u) { return vec2u(0u, 2u); }
  return vec2u(0u, 1u);
}

// An area chart's texel at (u, v) metres, or a surfel chart's texel 'index' (−1: an area point).
fn chartTexel(at: u32, uu: f32, vv: f32, index: i32) -> vec2u {
  let page = T[at];
  let x0 = T[at + 1u] & 0xffffu;
  let y0 = T[at + 1u] >> 16u;
  let dims = T[at + 2u];
  var x = 0u;
  var y = 0u;
  if ((dims & 0x80000000u) != 0u) {
    let pw = dims & 0xfffu;
    let ph = (dims >> 12u) & 0xfffu;
    if (index < 0 || u32(index) >= pw * ph) { return NONE; }
    x = x0 + u32(index) % pw;
    y = y0 + u32(index) / pw;
  } else {
    if (index >= 0) { return NONE; }
    let iw = i32(dims & 0xffffu);
    let ih = i32(dims >> 16u);
    x = x0 + u32(clamp(i32(floor((uu / tf(at + 3u)) * f32(iw))), 0, iw - 1));
    y = y0 + u32(clamp(i32(floor((vv / tf(at + 4u)) * f32(ih))), 0, ih - 1));
  }
  return vec2u((${RESOLVE_PAGE}u << 30u) | page, x | (y << 16u));
}

fn resolveBlocks(obj: u32, face: u32, a0: u32, fu: f32, fv: f32) -> vec2u {
  if (obj >= T[0]) { return NONE; }
  let at = T[1] + obj * ${LAYER_R_WORDS}u;
  let mn = vec3i(ti(at), ti(at + 1u), ti(at + 2u));
  let dx = T[at + 3u];
  let dz = T[at + 5u];
  let cell = vec3i(i32(a0 % dx), i32(a0 / (dx * dz)), i32((a0 / dx) % dz)) + mn;
  let cx = i32(floor(f32(cell.x) / 16.0));
  let cz = i32(floor(f32(cell.z) / 16.0));
  let col = vec2i(cx - ti(at + 9u), cz - ti(at + 10u));
  if (col.x < 0 || col.y < 0 || u32(col.x) >= T[at + 11u] || u32(col.y) >= T[at + 12u]) { return NONE; }
  let rec = T[T[at + 13u] + u32(col.y) * T[at + 11u] + u32(col.x)];
  if (rec == 0u) { return NONE; }
  let key = u32((((cell.y - mn.y) * 16 + (cell.z - cz * 16)) * 16 + (cell.x - cx * 16)) * 6) + face;
  var lo = 0i;
  var hi = i32(T[rec]) - 1;
  let keys = T[rec + 1u];
  loop {
    if (lo > hi) { break; }
    let mid = (lo + hi) >> 1u;
    let k = T[keys + u32(mid) * 2u];
    if (k == key) {
      let e = T[keys + u32(mid) * 2u + 1u];
      let ax = planeAxes(face >> 1u);
      let uu = (f32(e & 255u) + fu) * tf(at + 6u + ax.x);
      let vv = (f32((e >> 8u) & 255u) + fv) * tf(at + 6u + ax.y);
      return chartTexel(T[rec + 2u] + (e >> 16u) * ${CHART_WORDS}u, uu, vv, -1);
    }
    if (k < key) { lo = mid + 1; } else { hi = mid - 1; }
  }
  return NONE;
}

fn resolveTerrain(obj: u32, a0: u32, fu: f32, fv: f32) -> vec2u {
  if (obj >= T[2]) { return NONE; }
  let at = T[3] + obj * ${TERRAIN_R_WORDS}u;
  let nx = T[at];
  let s = tf(at + 3u);
  let lx = (f32(ti(at + 1u)) + f32(a0 % nx) + fu) * s;
  let lz = (f32(ti(at + 2u)) + f32(a0 / nx) + fv) * s;
  let x = tf(at + 4u) * lx + tf(at + 5u) * lz + tf(at + 6u);
  let z = tf(at + 7u) * lx + tf(at + 8u) * lz + tf(at + 9u);
  for (var k = 0u; k < T[at + 10u]; k++) {
    let r = at + 12u + k * 4u;
    if (abs(x - tf(r)) > tf(r + 2u) || abs(z - tf(r + 1u)) > tf(r + 2u)) { continue; }
    let t = tf(r + 3u);
    let wx = u32(((i32(floor(x / t)) % 512) + 512) % 512);
    let wz = u32(((i32(floor(z / t)) % 512) + 512) % 512);
    return vec2u((${RESOLVE_RING}u << 30u) | (T[at + 11u] << 3u) | k, wx | (wz << 16u));
  }
  return NONE;
}

fn resolveArch(obj: u32, face: u32, fu: f32, fv: f32) -> vec2u {
  var o = 0u;
  var piece = 0u;
  var p = vec3f(0.0);
  if (obj < T[6]) {
    o = T[T[7] + obj];
    let m = T[8] + obj * 12u;
    let axis = face >> 1u;
    let ax = planeAxes(axis);
    var q = vec3f(0.0);
    q[axis] = select(1.0, -1.0, (face & 1u) != 0u);
    q[ax.x] = fu * 2.0 - 1.0;
    q[ax.y] = fv * 2.0 - 1.0;
    let q4 = vec4f(q, 1.0);
    p = vec3f(dot(vec4f(tf(m), tf(m + 1u), tf(m + 2u), tf(m + 3u)), q4), dot(vec4f(tf(m + 4u), tf(m + 5u), tf(m + 6u), tf(m + 7u)), q4), dot(vec4f(tf(m + 8u), tf(m + 9u), tf(m + 10u), tf(m + 11u)), q4));
    piece = (obj - T[T[5] + o * ${ARCH_R_WORDS}u]) * 6u + face;
  } else {
    let tri = obj - T[6];
    if (tri >= T[9]) { return NONE; }
    o = T[T[10] + tri];
    let c = T[11] + tri * 9u;
    let a = vec3f(tf(c), tf(c + 1u), tf(c + 2u));
    p = a + (vec3f(tf(c + 3u), tf(c + 4u), tf(c + 5u)) - a) * fu + (vec3f(tf(c + 6u), tf(c + 7u), tf(c + 8u)) - a) * fv;
    let rec = T[5] + o * ${ARCH_R_WORDS}u;
    piece = T[rec + 1u] * 6u + (tri - T[rec + 2u]);
  }
  let rec = T[5] + o * ${ARCH_R_WORDS}u;
  let charts = T[rec + 6u];
  if (charts == 0u) { return NONE; }
  let ci = ti(T[rec + 4u] + piece);
  if (ci < 0) { return NONE; }
  let c = T[rec + 5u] + u32(ci) * ${COMP_WORDS}u;
  let d = p - vec3f(tf(c), tf(c + 1u), tf(c + 2u));
  let uu = dot(d, vec3f(tf(c + 3u), tf(c + 4u), tf(c + 5u))) - tf(c + 9u);
  let vv = dot(d, vec3f(tf(c + 6u), tf(c + 7u), tf(c + 8u))) - tf(c + 10u);
  let nu = i32(T[c + 11u]);
  let nv = i32(T[c + 12u]);
  let ii = clamp(i32(floor(uu / CHART_METRES)), 0, nu - 1);
  let jj = clamp(i32(floor(vv / CHART_METRES)), 0, nv - 1);
  return chartTexel(charts + (T[c + 13u] + u32(jj * nu + ii)) * ${CHART_WORDS}u, max(0.0, uu - f32(ii) * CHART_METRES), max(0.0, vv - f32(jj) * CHART_METRES), -1);
}

fn resolveBricks(obj: u32, a0: u32, n: vec3f) -> vec2u {
  if (obj >= T[12]) { return NONE; }
  let at = T[13] + obj * ${MODEL_R_WORDS}u;
  let chart = T[at];
  if (chart == 0u) { return NONE; }
  let q = vec3f(f32(a0 & 2047u), f32((a0 >> 11u) & 2047u), f32((a0 >> 22u) & 1023u));
  let p = vec3f(tf(at + 1u), tf(at + 2u), tf(at + 3u)) + ((q + vec3f(0.5)) / vec3f(2048.0, 2048.0, 1024.0)) * vec3f(tf(at + 4u), tf(at + 5u), tf(at + 6u));
  let m = at + 7u;
  let ln = vec3f(dot(vec3f(tf(m), tf(m + 1u), tf(m + 2u)), n), dot(vec3f(tf(m + 3u), tf(m + 4u), tf(m + 5u)), n), dot(vec3f(tf(m + 6u), tf(m + 7u), tf(m + 8u)), n));
  let len = length(ln);
  let facing = facingOf(select(ln, ln / len, len > 0.0));
  let cell = tf(at + 16u);
  let hash = T[at + 17u];
  let cap = T[at + 18u];
  let pos = T[at + 19u];
  var best = -1;
  var bestD = 3.4e38;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let c = vec3i(floor((p + vec3f(f32(dx), f32(dy), f32(dz)) * cell) / cell));
        var s = surfelHash(c, facing, cap);
        for (var probe = 0u; probe < cap; probe++) {
          let sa = hash + s * ${HASH_WORDS}u;
          let tag = T[sa + 3u];
          if (tag == ${EMPTY_SLOT}u) { break; }
          if ((tag & 7u) == facing && ti(sa) == c.x && ti(sa + 1u) == c.y && ti(sa + 2u) == c.z) {
            let idx = tag >> 3u;
            let e = vec3f(tf(pos + idx * 3u), tf(pos + idx * 3u + 1u), tf(pos + idx * 3u + 2u)) - p;
            let dd = dot(e, e);
            if (dd < bestD) { bestD = dd; best = i32(idx); }
            break;
          }
          s = (s + 1u) & (cap - 1u);
        }
      }
    }
  }
  if (best < 0) { return NONE; }
  let uv = T[at + 20u];
  if (uv == 0u) { return chartTexel(chart, 0.0, 0.0, best); }
  return chartTexel(chart, tf(uv + u32(best) * 2u) * tf(chart + 3u), tf(uv + u32(best) * 2u + 1u) * tf(chart + 4u), -1);
}

@compute @workgroup_size(${RESOLVE_WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.count) { return; }
  let i = P.base + g.x;
  let h0 = H[i * 2u];
  let h1 = H[i * 2u + 1u];
  let kind = h1.x & 255u;
  let face = (h1.x >> 8u) & 255u;
  let fu = f32(h1.w & 0xffffu) / 65535.0;
  let fv = f32(h1.w >> 16u) / 65535.0;
  var out = NONE;
  if (kind == ${TRACE_BLOCKS}u) { out = resolveBlocks(h1.y, face, h1.z, fu, fv); }
  else if (kind == ${TRACE_TERRAIN}u) { out = resolveTerrain(h1.y, h1.z, fu, fv); }
  else if (kind == ${TRACE_ARCH}u) { out = resolveArch(h1.y, face, fu, fv); }
  else if (kind == ${TRACE_BRICKS}u) { out = resolveBricks(h1.y, h1.z, vec3f(bitcast<f32>(h0.y), bitcast<f32>(h0.z), bitcast<f32>(h0.w))); }
  X[i] = out;
}
`;
