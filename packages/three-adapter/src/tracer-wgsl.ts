/**
 * The tracer's compute shader: one thread per ray, the nearest hit through
 * every geometry kind of the packed scene (`tracer-scene.ts`). It is the
 * CPU twin's walk (`tracer-cpu.ts`) line for line, so the two answer alike;
 * the browser run (`tools/perf/tracer-run.ts`) holds them to each other.
 *
 * Bindings: 0 the dispatch's parameters (ray count, first ray), 1 the scene
 * words, 2 the rays (two vec4 each), 3 the hits (two vec4u each).
 */
import { CHUNK_WORDS, HEADER, LAYER_WORDS, TERRAIN_WORDS, TRACE_BLOCKS, TRACE_CHUNK, TRACE_STEPS, TRACE_TERRAIN, TRACE_UNFINISHED } from './tracer-scene';

/** Threads per workgroup (the spike's measured size on the Iris Xe). */
export const TRACER_WORKGROUP = 64;

const COMMON = /* wgsl */ `
struct Params { count: u32, base: u32, pad0: u32, pad1: u32 }
struct Hit { t: f32, n: vec3f, kind: u32, face: u32, obj: u32, a0: u32, a1: u32 }

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> S: array<u32>;
@group(0) @binding(2) var<storage, read> R: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> H: array<vec4u>;

const CHUNK = ${TRACE_CHUNK};
const CHUNK_WORDS = ${CHUNK_WORDS}u;
const BLOCK_STEPS = ${TRACE_STEPS.blocks}u;
const TERRAIN_STEPS = ${TRACE_STEPS.terrain}u;
const GRID_STEPS = ${TRACE_STEPS.grid}u;
const BRICK_STEPS = ${TRACE_STEPS.bricks}u;

fn sf(i: u32) -> f32 { return bitcast<f32>(S[i]); }
fn row(at: u32, r: u32) -> vec4f { let b = at + r * 4u; return vec4f(sf(b), sf(b + 1u), sf(b + 2u), sf(b + 3u)); }
fn mapPoint(at: u32, p: vec3f) -> vec3f {
  let q = vec4f(p, 1.0);
  return vec3f(dot(row(at, 0u), q), dot(row(at, 1u), q), dot(row(at, 2u), q));
}
fn mapDir(at: u32, d: vec3f) -> vec3f {
  return vec3f(dot(row(at, 0u).xyz, d), dot(row(at, 1u).xyz, d), dot(row(at, 2u).xyz, d));
}
fn worldNormal(at: u32, n: vec3f) -> vec3f {
  return normalize(row(at, 0u).xyz * n.x + row(at, 1u).xyz * n.y + row(at, 2u).xyz * n.z);
}
fn safeDir(d: vec3f) -> vec3f {
  return select(d, select(vec3f(-1e-7), vec3f(1e-7), d >= vec3f(0.0)), abs(d) < vec3f(1e-7));
}
fn argmin3(v: vec3f) -> u32 {
  if (v.x < v.y && v.x < v.z) { return 0u; }
  if (v.y < v.z) { return 1u; }
  return 2u;
}
fn packUnorm2(x: f32, y: f32) -> u32 {
  let q = vec2u(round(clamp(vec2f(x, y), vec2f(0.0), vec2f(1.0)) * 65535.0));
  return q.x | (q.y << 16u);
}
// Two-sided ray / triangle (Moller-Trumbore): the distance in [lo, hi], or -1.
fn rayTriangle(o: vec3f, d: vec3f, a: vec3f, b: vec3f, c: vec3f, lo: f32, hi: f32) -> f32 {
  let e1 = b - a;
  let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (abs(det) < 1e-12) { return -1.0; }
  let r = 1.0 / det;
  let s = o - a;
  let uu = dot(s, p) * r;
  if (uu < -1e-6 || uu > 1.0 + 1e-6) { return -1.0; }
  let q = cross(s, e1);
  let vv = dot(d, q) * r;
  if (vv < -1e-6 || uu + vv > 1.0 + 1e-6) { return -1.0; }
  let t = dot(e2, q) * r;
  if (t >= lo && t <= hi) { return t; }
  return -1.0;
}
`;

const BLOCKS = /* wgsl */ `
fn blockHit(layer: u32, at: u32, o: vec3f, d: vec3f, t: f32, axisIn: i32, cell: vec3i, D: vec3i, h: ptr<function, Hit>) {
  var axis = u32(max(axisIn, 0));
  if (axisIn < 0) { axis = argmin3(-abs(d)); }
  var dd = d;
  let sgn = select(1.0, -1.0, dd[axis] > 0.0);
  var n = vec3f(0.0);
  n[axis] = sgn;
  let p = o + d * t - vec3f(cell);
  var uv = vec2f(p.z, p.y);
  if (axis == 1u) { uv = vec2f(p.x, p.z); }
  if (axis == 2u) { uv = vec2f(p.x, p.y); }
  (*h).t = t;
  (*h).n = worldNormal(at, n);
  (*h).kind = ${TRACE_BLOCKS}u;
  (*h).face = axis * 2u + select(1u, 0u, sgn > 0.0);
  (*h).obj = layer;
  (*h).a0 = u32((cell.y * D.z + cell.z) * D.x + cell.x);
  (*h).a1 = packUnorm2(uv.x, uv.y);
}

fn traceLayer(layer: u32, at: u32, ro: vec3f, rd: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  let o = mapPoint(at, ro);
  let d = safeDir(mapDir(at, rd));
  let D = vec3i(i32(S[at + 12u]), i32(S[at + 13u]), i32(S[at + 14u]));
  let CD = vec3i(i32(S[at + 15u]), i32(S[at + 16u]), i32(S[at + 17u]));
  let table = S[at + 18u];
  let bits = S[at + 19u];
  let inv = 1.0 / d;
  var tEnter = tmin;
  var tExit = min((*h).t, *unf);
  var axis = -1;
  let ta = (vec3f(0.0) - o) * inv;
  let tb = (vec3f(D) - o) * inv;
  for (var k = 0; k < 3; k++) {
    let lo = min(ta[k], tb[k]);
    if (lo > tEnter) { tEnter = lo; axis = k; }
    tExit = min(tExit, max(ta[k], tb[k]));
  }
  if (!(tEnter < tExit)) { return; }
  let stp = vec3i(sign(d));
  let up = select(vec3f(0.0), vec3f(1.0), d > vec3f(0.0));
  var c = clamp(vec3i(floor((o + d * tEnter) / f32(CHUNK))), vec3i(0), CD - vec3i(1));
  var sideC = ((vec3f(c) + up) * f32(CHUNK) - o) * inv;
  let deltaC = abs(inv) * f32(CHUNK);
  var delta = abs(inv);
  var tc = tEnter;
  var steps = 0u;
  loop {
    let tcExit = min(min(sideC.x, sideC.y), min(sideC.z, tExit));
    let block = S[table + u32((c.y * CD.z + c.z) * CD.x + c.x)];
    var exit = argmin3(sideC);
    if (block != 0u) {
      let base = bits + (block - 1u) * CHUNK_WORDS;
      let lo = c * CHUNK;
      var cell = clamp(vec3i(floor(o + d * tc)), lo, min(lo + vec3i(CHUNK), D) - vec3i(1));
      var side = (vec3f(cell) + up - o) * inv;
      var t = tc;
      loop {
        let l = cell - lo;
        let bit = u32((l.y * CHUNK + l.z) * CHUNK + l.x);
        if (((S[base + (bit >> 5u)] >> (bit & 31u)) & 1u) != 0u) {
          blockHit(layer, at, o, d, t, axis, cell, D, h);
          return;
        }
        steps += 1u;
        if (steps >= BLOCK_STEPS) { *unf = min(*unf, t); return; }
        let a = argmin3(side);
        t = side[a];
        side[a] += delta[a];
        cell[a] += stp[a];
        axis = i32(a);
        if (t >= tExit) { return; }
        if (cell[a] < lo[a] || cell[a] >= lo[a] + CHUNK) { exit = a; break; }
      }
    }
    steps += 1u;
    if (steps >= BLOCK_STEPS) { *unf = min(*unf, tcExit); return; }
    let a = exit;
    tc = sideC[a];
    sideC[a] += deltaC[a];
    c[a] += stp[a];
    axis = i32(a);
    if (tc >= tExit || c[a] < 0 || c[a] >= CD[a]) { return; }
  }
}
`;

const TERRAIN = /* wgsl */ `
fn traceTerrain(index: u32, at: u32, ro: vec3f, rd: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  let o = mapPoint(at, ro);
  let d = safeDir(mapDir(at, rd));
  let NX = S[at + 12u];
  let NZ = S[at + 13u];
  let L = S[at + 14u];
  let HB = S[at + 15u];
  let PB = S[at + 16u];
  let top = L - 1u;
  let rootLo = sf(S[PB + top * 3u]);
  let rootHi = sf(S[PB + top * 3u] + 1u);
  if (rootLo > rootHi) { return; }
  let inv = 1.0 / d;
  let ta = (vec3f(0.0, rootLo, 0.0) - o) * inv;
  let tb = (vec3f(f32(NX), rootHi, f32(NZ)) - o) * inv;
  let t0 = min(ta, tb);
  let t1 = max(ta, tb);
  var t = max(tmin, max(t0.x, max(t0.y, t0.z)));
  let tEnd = min(min((*h).t, *unf), min(t1.x, min(t1.y, t1.z)));
  if (!(t < tEnd)) { return; }
  let sx = select(-1, 1, d.x > 0.0);
  let sz = select(-1, 1, d.z > 0.0);
  var level = top;
  var cx = 0;
  var cz = 0;
  for (var steps = 0u; ; steps++) {
    if (steps >= TERRAIN_STEPS) { *unf = min(*unf, t); return; }
    let cs = f32(1u << level);
    let nbx = f32(cx + select(0, 1, sx > 0)) * cs;
    let nbz = f32(cz + select(0, 1, sz > 0)) * cs;
    let tx = (nbx - o.x) * inv.x;
    let tz = (nbz - o.z) * inv.z;
    let tExit = min(min(tx, tz), tEnd);
    let lx = i32(S[PB + level * 3u + 1u]);
    let node = S[PB + level * 3u] + u32(cz * lx + cx) * 2u;
    let lo = sf(node);
    let hi = sf(node + 1u);
    let y0 = o.y + d.y * t;
    let y1 = o.y + d.y * tExit;
    if (max(y0, y1) < lo || min(y0, y1) > hi) {
      if (tExit >= tEnd) { return; }
      let moved = tExit > t;
      t = tExit;
      if (tx < tz) { cx += sx; } else { cz += sz; }
      let dz = i32(S[PB + level * 3u + 2u]);
      if (cx < 0 || cz < 0 || cx >= lx || cz >= dz) { return; }
      if (level < top && moved) {
        level += 1u;
        cx = cx >> 1u;
        cz = cz >> 1u;
      }
      continue;
    }
    if (level == 0u) {
      let sxN = NX + 1u;
      let i = HB + u32(cz) * sxN + u32(cx);
      let fx = f32(cx);
      let fz = f32(cz);
      let a = vec3f(fx, sf(i), fz);
      let b = vec3f(fx + 1.0, sf(i + 1u), fz);
      let c = vec3f(fx, sf(i + sxN), fz + 1.0);
      let e = vec3f(fx + 1.0, sf(i + sxN + 1u), fz + 1.0);
      let slack = 1e-5 * (1.0 + abs(tExit));
      let t1h = rayTriangle(o, d, a, b, c, t - slack, tExit + slack);
      let t2h = rayTriangle(o, d, e, c, b, t - slack, tExit + slack);
      var th = t1h;
      var first = true;
      if (t2h >= 0.0 && (th < 0.0 || t2h < th)) { th = t2h; first = false; }
      if (th >= 0.0 && th >= tmin) {
        var n = cross(b - a, c - a);
        if (!first) { n = cross(c - e, b - e); }
        if (n.y < 0.0) { n = -n; }
        let p = o + d * th;
        (*h).t = th;
        (*h).n = worldNormal(at, n);
        (*h).kind = ${TRACE_TERRAIN}u;
        (*h).face = 0u;
        (*h).obj = index;
        (*h).a0 = u32(cz) * NX + u32(cx);
        (*h).a1 = packUnorm2(p.x - fx, p.z - fz);
        return;
      }
      if (tExit >= tEnd) { return; }
      t = tExit;
      if (tx < tz) { cx += sx; } else { cz += sz; }
      if (cx < 0 || cz < 0 || cx >= i32(NX) || cz >= i32(NZ)) { return; }
      continue;
    }
    level -= 1u;
    let ccs = f32(1u << level);
    let ldx = i32(S[PB + level * 3u + 1u]);
    let ldz = i32(S[PB + level * 3u + 2u]);
    let px = o.x + d.x * t;
    let pz = o.z + d.z * t;
    cx = min(min(cx * 2 + 1, ldx - 1), max(cx * 2, i32(floor(px / ccs))));
    cz = min(min(cz * 2 + 1, ldz - 1), max(cz * 2, i32(floor(pz / ccs))));
  }
}
`;

const MAIN = /* wgsl */ `
@compute @workgroup_size(${TRACER_WORKGROUP})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.count) { return; }
  let i = P.base + g.x;
  let r0 = R[i * 2u];
  let r1 = R[i * 2u + 1u];
  let o = r0.xyz;
  let d = r1.xyz;
  let tmin = r0.w;
  var h = Hit(r1.w, vec3f(0.0), 0u, 0u, 0u, 0u, 0u);
  var unf = 3.4e38;
  let nb = S[${HEADER.blocks}u];
  for (var k = 0u; k < nb; k++) { traceLayer(k, S[${HEADER.blocks + 1}u] + k * ${LAYER_WORDS}u, o, d, tmin, &h, &unf); }
  let nt = S[${HEADER.terrain}u];
  for (var k = 0u; k < nt; k++) { traceTerrain(k, S[${HEADER.terrain + 1}u] + k * ${TERRAIN_WORDS}u, o, d, tmin, &h, &unf); }
  if (unf < h.t) { h = Hit(unf, vec3f(0.0), ${TRACE_UNFINISHED}u, 0u, 0u, 0u, 0u); }
  H[i * 2u] = vec4u(bitcast<u32>(h.t), bitcast<u32>(h.n.x), bitcast<u32>(h.n.y), bitcast<u32>(h.n.z));
  H[i * 2u + 1u] = vec4u(h.kind | (h.face << 8u), h.obj, h.a0, h.a1);
}
`;

/** The whole program. */
export const TRACER_WGSL = COMMON + BLOCKS + TERRAIN + MAIN;
