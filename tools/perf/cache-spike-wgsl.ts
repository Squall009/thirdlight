/**
 * The surface-cache spike's compute shader (cache-spike-run.ts): one thread
 * per cache texel lights it from the sun (rays over the sun's disc) and one
 * rectangle light (rays over its area), each ray traced through the block
 * grid (cell-by-cell DDA over the occupancy bits decoded from the layer's
 * binary chunks) and then the terrain (a march over the height tiles' max
 * pyramid). Block texels sit on their cell face (a slot of P × P texels; the
 * outer texels clamp to the face's edge, so filtering never reads past it);
 * terrain texels sit on the height grid.
 *
 * Throwaway quality: it measures what the design costs on the integrated
 * GPU, it is not the engine's tracer.
 */
export const CACHE_SPIKE_WGSL = /* wgsl */ `
struct Slot { origin: vec4f, du: vec4f, dv: vec4f, n: vec4f, tile: vec4u }

// U[0] sun dir (to the light), sun radius (rad)   U[1] sun irradiance rgb, sun rays
// U[2] rect centre, rect rays                      U[3] rect half-extent u, rect on
// U[4] rect half-extent v, -                       U[5] rect radiance rgb, rect range
// U[6] grid dims, P                                U[7] terrain origin, spacing
// U[8] terrain cells per side, levels, terrain texel (m), terrain texels per side
// U[9] terrain patch min x, z, item base, item count
// U[10] seed, slot margin, -, -
@group(0) @binding(0) var<uniform> U: array<vec4f, 11>;
@group(0) @binding(1) var<storage, read> occ: array<u32>;
@group(0) @binding(2) var<storage, read> slots: array<Slot>;
@group(0) @binding(3) var<storage, read> terr: array<f32>;
@group(0) @binding(4) var<storage, read> work: array<u32>;
@group(0) @binding(5) var blockCache: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var terrCache: texture_storage_2d<rgba16float, write>;

const PI = 3.14159265;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(s: ptr<function, u32>) -> f32 {
  *s = pcg(*s);
  return f32(*s) / 4294967296.0;
}

fn solid(c: vec3i, D: vec3i) -> bool {
  if (any(c < vec3i(0)) || any(c >= D)) { return false; }
  let i = u32((c.y * D.z + c.z) * D.x + c.x);
  return ((occ[i >> 5u] >> (i & 31u)) & 1u) != 0u;
}

fn safeDir(d: vec3f) -> vec3f {
  return select(d, select(vec3f(-1e-7), vec3f(1e-7), d >= vec3f(0.0)), abs(d) < vec3f(1e-7));
}

// Whether the block grid blocks the ray before tmax.
fn traceBlocks(o: vec3f, dIn: vec3f, tmax: f32) -> bool {
  let D = vec3i(U[6].xyz);
  let Df = U[6].xyz;
  let d = safeDir(dIn);
  let inv = 1.0 / d;
  let ta = (vec3f(0.0) - o) * inv;
  let tb = (Df - o) * inv;
  let t0 = min(ta, tb);
  let t1 = max(ta, tb);
  var t = max(max(t0.x, t0.y), max(t0.z, 0.0));
  let tEnd = min(min(t1.x, t1.y), min(t1.z, tmax));
  if (t >= tEnd) { return false; }
  var c = clamp(vec3i(floor(o + d * (t + 1e-4))), vec3i(0), D - vec3i(1));
  let stp = vec3i(sign(d));
  let delta = abs(inv);
  var side = (vec3f(c) + select(vec3f(0.0), vec3f(1.0), d > vec3f(0.0)) - o) * inv;
  for (var i = 0; i < 160; i++) {
    if (solid(c, D)) { return true; }
    if (side.x < side.y && side.x < side.z) { t = side.x; side.x += delta.x; c.x += stp.x; }
    else if (side.y < side.z) { t = side.y; side.y += delta.y; c.y += stp.y; }
    else { t = side.z; side.z += delta.z; c.z += stp.z; }
    if (t >= tEnd) { return false; }
  }
  return false;
}

fn pyramidOffset(l: u32) -> u32 {
  let n = u32(U[8].x);
  var off = (n + 1u) * (n + 1u);
  for (var k = 0u; k < l; k++) { let c = n >> k; off += c * c; }
  return off;
}
fn terrMax(l: u32, cell: vec2i) -> f32 {
  let c = i32(u32(U[8].x) >> l);
  let q = clamp(cell, vec2i(0), vec2i(c - 1));
  return terr[pyramidOffset(l) + u32(q.y * c + q.x)];
}
fn sampleH(ix: i32, iz: i32) -> f32 {
  let n = i32(U[8].x);
  return terr[u32(clamp(iz, 0, n) * (n + 1) + clamp(ix, 0, n))];
}
// Height at a point in sample units (bilinear).
fn heightAt(p: vec2f) -> f32 {
  let f = floor(p);
  let w = p - f;
  let i = vec2i(f);
  let a = mix(sampleH(i.x, i.y), sampleH(i.x + 1, i.y), w.x);
  let b = mix(sampleH(i.x, i.y + 1), sampleH(i.x + 1, i.y + 1), w.x);
  return mix(a, b, w.y);
}

// Whether the terrain blocks the ray before tmax: a march down and up the max pyramid.
fn traceTerrain(oW: vec3f, dW: vec3f, tmax: f32) -> bool {
  let sp = U[7].w;
  let n = U[8].x;
  let L = u32(U[8].y);
  let o = vec3f((oW.x - U[7].x) / sp, oW.y - U[7].y, (oW.z - U[7].z) / sp);
  let d = safeDir(vec3f(dW.x / sp, dW.y, dW.z / sp));
  let inv = 1.0 / d.xz;
  let ta = (vec2f(0.0) - o.xz) * inv;
  let tb = (vec2f(n) - o.xz) * inv;
  var t = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), 0.0);
  var tEnd = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), tmax);
  let top = terrMax(L, vec2i(0));
  // Above the highest point and climbing: nothing to hit.
  if (d.y >= 0.0) {
    if (o.y >= top) { return false; }
    tEnd = min(tEnd, (top - o.y) / d.y);
  }
  if (t >= tEnd) { return false; }
  var level = L;
  for (var i = 0; i < 128; i++) {
    if (t >= tEnd) { return false; }
    let p = o + d * t;
    let cs = f32(1u << level);
    let cell = floor(p.xz / cs);
    let nb = (cell + select(vec2f(0.0), vec2f(1.0), d.xz > vec2f(0.0))) * cs;
    let te = (nb - o.xz) * inv;
    let tExit = min(min(te.x, te.y), tEnd);
    let yExit = o.y + d.y * tExit;
    let hmax = terrMax(level, vec2i(cell));
    if (min(p.y, yExit) > hmax) {
      t = tExit + 1e-4;
      if (level < L) { level += 1u; }
      continue;
    }
    if (level == 0u) {
      if (p.y <= heightAt(p.xz) || yExit <= heightAt(o.xz + d.xz * tExit)) { return true; }
      t = tExit + 1e-4;
      continue;
    }
    level -= 1u;
  }
  return false;
}

fn blocked(o: vec3f, d: vec3f, tmax: f32) -> bool {
  return traceBlocks(o, d, tmax) || traceTerrain(o, d, tmax);
}

fn basis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(a, n));
  return mat3x3f(t, cross(n, t), n);
}

fn shade(p: vec3f, n: vec3f, seedIn: u32) -> vec3f {
  var seed = seedIn;
  var E = vec3f(0.0);
  let o = p + n * 0.003;
  // The sun: rays over its disc, stratified in rings.
  let sunRays = u32(U[1].w);
  let L = U[0].xyz;
  if (sunRays > 0u && dot(n, L) > -0.05) {
    let B = basis(L);
    let r = tan(U[0].w);
    var acc = 0.0;
    let j = rnd(&seed);
    for (var s = 0u; s < sunRays; s++) {
      let a = (f32(s) + j) / f32(sunRays);
      let rr = r * sqrt(fract(a * 7.0 + rnd(&seed) * 0.1));
      let ang = 2.0 * PI * fract(a + 0.618 * f32(s));
      let d = normalize(B * vec3f(rr * cos(ang), rr * sin(ang), 1.0));
      let nl = dot(n, d);
      if (nl > 0.0 && !blocked(o, d, 1e4)) { acc += nl; }
    }
    E += U[1].xyz * (acc / f32(sunRays));
  }
  // The rectangle light: stratified points over its area, one-sided (it shines along -(eu x ev)).
  let rectRays = u32(U[2].w);
  if (rectRays > 0u && U[3].w > 0.0) {
    let c = U[2].xyz;
    let eu = U[3].xyz;
    let ev = U[4].xyz;
    let ln = -normalize(cross(eu, ev));
    let area = 4.0 * length(eu) * length(ev);
    let range = U[5].w;
    if (length(c - p) < range && dot(n, c - p) > -1.0) {
      let side = u32(ceil(sqrt(f32(rectRays))));
      let jx = rnd(&seed);
      let jy = rnd(&seed);
      var acc = 0.0;
      for (var s = 0u; s < rectRays; s++) {
        let fx = (f32(s % side) + fract(jx + f32(s) * 0.37)) / f32(side);
        let fy = (f32(s / side) + fract(jy + f32(s) * 0.61)) / f32(side);
        let q = c + eu * (2.0 * fx - 1.0) + ev * (2.0 * fy - 1.0);
        let v = q - o;
        let d2 = dot(v, v);
        let dist = sqrt(d2);
        let w = v / dist;
        let cr = dot(n, w);
        let cl = dot(ln, -w);
        if (cr > 0.0 && cl > 0.0 && !traceBlocks(o, w, dist - 0.01)) { acc += cr * cl / max(d2, 0.01); }
      }
      E += U[5].xyz * area * acc / f32(rectRays);
    }
  }
  return E;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= u32(U[9].w)) { return; }
  let item = work[u32(U[9].z) + i];
  let seed = pcg(item ^ u32(U[10].x));
  if ((item & 0x80000000u) == 0u) {
    let P = u32(U[6].w);
    let slot = item / (P * P);
    let t = item % (P * P);
    let tx = t % P;
    let ty = t / P;
    let s = slots[slot];
    let M = U[10].y;
    let fu = clamp(((f32(tx) + 0.5) / f32(P) - M) / (1.0 - 2.0 * M), 0.0, 1.0);
    let fv = clamp(((f32(ty) + 0.5) / f32(P) - M) / (1.0 - 2.0 * M), 0.0, 1.0);
    let p = s.origin.xyz + s.du.xyz * fu + s.dv.xyz * fv;
    let E = shade(p, s.n.xyz, seed);
    textureStore(blockCache, vec2u(s.tile.x * P + tx, s.tile.y * P + ty), vec4f(E, 1.0));
  } else {
    let k = item & 0x7fffffffu;
    let W = u32(U[8].w);
    let tx = k % W;
    let tz = k / W;
    let texel = U[8].z;
    let sp = U[7].w;
    let wx = U[9].x + (f32(tx) + 0.5) * texel;
    let wz = U[9].y + (f32(tz) + 0.5) * texel;
    let lp = vec2f((wx - U[7].x) / sp, (wz - U[7].z) / sp);
    let h = heightAt(lp) + U[7].y;
    let e = 0.5;
    let hx = heightAt(lp + vec2f(e, 0.0)) - heightAt(lp - vec2f(e, 0.0));
    let hz = heightAt(lp + vec2f(0.0, e)) - heightAt(lp - vec2f(0.0, e));
    let n = normalize(vec3f(-hx, 2.0 * e * sp, -hz));
    let E = shade(vec3f(wx, h, wz), n, seed);
    textureStore(terrCache, vec2u(tx, tz), vec4f(E, 1.0));
  }
}
`;
