/**
 * The tracer shader's object sections, the CPU twin's walk
 * (`tracer-cpu-objects.ts`) line for line: a DDA over a uniform grid of
 * architecture pieces or model instances, a slab test per box, a triangle
 * test per flat piece, and sphere tracing through a model's bricks.
 */
import { DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SIDE } from '@thirdlight/runtime';

import { BRICK_HIT_VOXELS, BRICK_MIN_STEP_VOXELS } from './tracer-cpu-objects';
import { ARCH_BOX, BLOCK_WORDS } from './tracer-objects';
import { HEADER, TRACE_ARCH, TRACE_BRICKS } from './tracer-scene';

export const TRACER_OBJECTS_WGSL = /* wgsl */ `
const ARCH_ITEMS = 0u;
const MODEL_ITEMS = 1u;
const BRICK_CELLS = ${DISTANCE_BRICK_CELLS}.0;
const BRICK_SIDE = ${DISTANCE_BRICK_SIDE}u;
const BLOCK_WORDS = ${BLOCK_WORDS}u;

fn testArchItem(item: u32, at: u32, ro: vec3f, rd: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  let best = min((*h).t, *unf);
  if (S[at] == ${ARCH_BOX}u) {
    let o = mapPoint(at + 1u, ro);
    let d = safeDir(mapDir(at + 1u, rd));
    let ta = (vec3f(-1.0) - o) / d;
    let tb = (vec3f(1.0) - o) / d;
    let lo = min(ta, tb);
    let hi = max(ta, tb);
    var axis = 0u;
    var tNear = lo.x;
    if (lo.y > tNear) { tNear = lo.y; axis = 1u; }
    if (lo.z > tNear) { tNear = lo.z; axis = 2u; }
    let tFar = min(hi.x, min(hi.y, hi.z));
    if (!(tNear <= tFar) || tFar < tmin) { return; }
    let t = max(tNear, tmin);
    if (t >= best) { return; }
    var dd = d;
    var n = vec3f(0.0);
    n[axis] = select(1.0, -1.0, dd[axis] > 0.0);
    let p = o + d * t;
    var uv = vec2f(p.z, p.y);
    if (axis == 1u) { uv = vec2f(p.x, p.z); }
    if (axis == 2u) { uv = vec2f(p.x, p.y); }
    (*h).t = t;
    (*h).n = worldNormal(at + 1u, n);
    (*h).kind = ${TRACE_ARCH}u;
    (*h).face = axis * 2u + select(1u, 0u, n[axis] > 0.0);
    (*h).obj = item;
    (*h).a0 = 0u;
    (*h).a1 = packUnorm2((uv.x + 1.0) * 0.5, (uv.y + 1.0) * 0.5);
    return;
  }
  let a = vec3f(sf(at + 1u), sf(at + 2u), sf(at + 3u));
  let b = vec3f(sf(at + 4u), sf(at + 5u), sf(at + 6u));
  let c = vec3f(sf(at + 7u), sf(at + 8u), sf(at + 9u));
  let t = rayTriangle(ro, rd, a, b, c, tmin, best);
  if (t < 0.0 || t >= best) { return; }
  let e1 = b - a;
  let e2 = c - a;
  let p = ro + rd * t - a;
  let d00 = dot(e1, e1);
  let d01 = dot(e1, e2);
  let d11 = dot(e2, e2);
  let d20 = dot(p, e1);
  let d21 = dot(p, e2);
  var den = d00 * d11 - d01 * d01;
  if (den == 0.0) { den = 1.0; }
  (*h).t = t;
  (*h).n = normalize(cross(e1, e2));
  (*h).kind = ${TRACE_ARCH}u;
  (*h).face = 0u;
  (*h).obj = item;
  (*h).a0 = 0u;
  (*h).a1 = packUnorm2((d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den);
}

fn brickSample(samples: u32, blk: u32, x: u32, y: u32, z: u32, band: f32) -> f32 {
  let i = (z * BRICK_SIDE + y) * BRICK_SIDE + x;
  let q = (S[samples + blk * BLOCK_WORDS + (i >> 2u)] >> ((i & 3u) * 8u)) & 255u;
  return (f32(q) / 255.0 * 2.0 - 1.0) * band;
}

fn brickDistance(samples: u32, blk: u32, pIn: vec3f, band: f32) -> f32 {
  let q = clamp(pIn, vec3f(0.0), vec3f(BRICK_CELLS - 1e-4));
  let i = vec3u(floor(q));
  let w = q - floor(q);
  let c000 = brickSample(samples, blk, i.x, i.y, i.z, band);
  let c100 = brickSample(samples, blk, i.x + 1u, i.y, i.z, band);
  let c010 = brickSample(samples, blk, i.x, i.y + 1u, i.z, band);
  let c110 = brickSample(samples, blk, i.x + 1u, i.y + 1u, i.z, band);
  let c001 = brickSample(samples, blk, i.x, i.y, i.z + 1u, band);
  let c101 = brickSample(samples, blk, i.x + 1u, i.y, i.z + 1u, band);
  let c011 = brickSample(samples, blk, i.x, i.y + 1u, i.z + 1u, band);
  let c111 = brickSample(samples, blk, i.x + 1u, i.y + 1u, i.z + 1u, band);
  let x00 = mix(c000, c100, w.x);
  let x10 = mix(c010, c110, w.x);
  let x01 = mix(c001, c101, w.x);
  let x11 = mix(c011, c111, w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

fn localAddress(p: vec3f, D: vec3f) -> u32 {
  let q = vec3u(clamp(floor(p / D * vec3f(2048.0, 2048.0, 1024.0)), vec3f(0.0), vec3f(2047.0, 2047.0, 1023.0)));
  return q.x | (q.y << 11u) | (q.z << 22u);
}

fn testInstance(item: u32, at: u32, ro: vec3f, rd: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  let rec = S[at + 12u];
  let ol = mapPoint(at, ro);
  let dl = mapDir(at, rd);
  let lo = vec3f(sf(rec), sf(rec + 1u), sf(rec + 2u));
  let voxel = sf(rec + 3u);
  let band = sf(rec + 4u);
  let D = vec3i(i32(S[rec + 5u]), i32(S[rec + 6u]), i32(S[rec + 7u]));
  let table = S[rec + 8u];
  let samples = S[rec + 9u];
  let size = voxel * BRICK_CELLS;
  let speed = length(dl);
  let ob = (ol - lo) / size;
  let d = safeDir(dl / size);
  let inv = 1.0 / d;
  var t = tmin;
  var tEnd = min((*h).t, *unf);
  var axis = 0u;
  let ta = (vec3f(0.0) - ob) * inv;
  let tb = (vec3f(D) - ob) * inv;
  for (var k = 0u; k < 3u; k++) {
    let near = min(ta[k], tb[k]);
    if (near > t) { t = near; axis = k; }
    tEnd = min(tEnd, max(ta[k], tb[k]));
  }
  if (!(t < tEnd)) { return; }
  let stp = vec3i(sign(d));
  var c = clamp(vec3i(floor(ob + d * t)), vec3i(0), D - vec3i(1));
  var side = (vec3f(c) + select(vec3f(0.0), vec3f(1.0), d > vec3f(0.0)) - ob) * inv;
  var delta = abs(inv);
  let hitEps = ${BRICK_HIT_VOXELS} * voxel;
  let minStep = ${BRICK_MIN_STEP_VOXELS} * voxel / speed;
  var steps = 0u;
  loop {
    let bExit = min(min(side.x, side.y), min(side.z, tEnd));
    let blk = bitcast<i32>(S[table + u32((c.z * D.y + c.y) * D.x + c.x)]);
    if (blk == ${DISTANCE_BRICK_INSIDE}) {
      var dd = d;
      var n = vec3f(0.0);
      n[axis] = select(1.0, -1.0, dd[axis] > 0.0);
      (*h).t = t;
      (*h).n = worldNormal(at, n);
      (*h).kind = ${TRACE_BRICKS}u;
      (*h).face = 0u;
      (*h).obj = item;
      (*h).a0 = localAddress(ob + d * t, vec3f(D));
      (*h).a1 = S[rec + 10u];
      return;
    }
    if (blk != ${DISTANCE_BRICK_OUTSIDE}) {
      var ts = t;
      loop {
        if (ts >= bExit) { break; }
        steps += 1u;
        if (steps >= BRICK_STEPS) { *unf = min(*unf, ts); return; }
        let p = (ob + d * ts - vec3f(c)) * BRICK_CELLS;
        let dist = brickDistance(samples, u32(blk), p, band);
        if (dist < hitEps) {
          let ex = vec3f(0.5, 0.0, 0.0);
          let ey = vec3f(0.0, 0.5, 0.0);
          let ez = vec3f(0.0, 0.0, 0.5);
          let g = vec3f(
            brickDistance(samples, u32(blk), p + ex, band) - brickDistance(samples, u32(blk), p - ex, band),
            brickDistance(samples, u32(blk), p + ey, band) - brickDistance(samples, u32(blk), p - ey, band),
            brickDistance(samples, u32(blk), p + ez, band) - brickDistance(samples, u32(blk), p - ez, band));
          (*h).t = ts;
          (*h).n = worldNormal(at, g);
          (*h).kind = ${TRACE_BRICKS}u;
          (*h).face = 0u;
          (*h).obj = item;
          (*h).a0 = localAddress(ob + d * ts, vec3f(D));
          (*h).a1 = S[rec + 10u];
          return;
        }
        ts += max(dist / speed, minStep);
      }
    }
    steps += 1u;
    if (steps >= BRICK_STEPS) { *unf = min(*unf, bExit); return; }
    let a = argmin3(side);
    t = side[a];
    side[a] += delta[a];
    c[a] += stp[a];
    axis = a;
    if (t >= tEnd || c[a] < 0 || c[a] >= D[a]) { return; }
  }
}

fn walkGrid(kind: u32, g: u32, o: vec3f, d0: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  let lo = vec3f(sf(g), sf(g + 1u), sf(g + 2u));
  let cs = sf(g + 3u);
  let D = vec3i(i32(S[g + 4u]), i32(S[g + 5u]), i32(S[g + 6u]));
  let starts = S[g + 7u];
  let list = S[g + 8u];
  let items = S[g + 9u];
  let stride = S[g + 11u];
  let d = safeDir(d0);
  let oc = (o - lo) / cs;
  let inv = cs / d;
  var t = tmin;
  var tEnd = min((*h).t, *unf);
  let ta = (vec3f(0.0) - oc) * inv;
  let tb = (vec3f(D) - oc) * inv;
  let t0 = min(ta, tb);
  let t1 = max(ta, tb);
  t = max(t, max(t0.x, max(t0.y, t0.z)));
  tEnd = min(tEnd, min(t1.x, min(t1.y, t1.z)));
  if (!(t < tEnd)) { return; }
  let stp = vec3i(sign(d));
  var c = clamp(vec3i(floor(oc + d / cs * t)), vec3i(0), D - vec3i(1));
  var side = (vec3f(c) + select(vec3f(0.0), vec3f(1.0), d > vec3f(0.0)) - oc) * inv;
  var delta = abs(inv);
  for (var steps = 0u; steps < GRID_STEPS; steps++) {
    let cell = u32((c.z * D.y + c.y) * D.x + c.x);
    let cellExit = min(side.x, min(side.y, side.z));
    for (var k = S[starts + cell]; k < S[starts + cell + 1u]; k++) {
      let item = S[list + k];
      if (kind == ARCH_ITEMS) { testArchItem(item, items + item * stride, o, d0, tmin, h, unf); }
      else { testInstance(item, items + item * stride, o, d0, tmin, h, unf); }
    }
    if (min((*h).t, *unf) <= cellExit) { return; }
    let a = argmin3(side);
    t = side[a];
    side[a] += delta[a];
    c[a] += stp[a];
    if (t >= tEnd || c[a] < 0 || c[a] >= D[a]) { return; }
  }
  *unf = min(*unf, t);
}

fn traceArch(o: vec3f, d: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  if (S[${HEADER.arch}u] > 0u) { walkGrid(ARCH_ITEMS, S[${HEADER.arch + 1}u], o, d, tmin, h, unf); }
}

fn traceBricks(o: vec3f, d: vec3f, tmin: f32, h: ptr<function, Hit>, unf: ptr<function, f32>) {
  if (S[${HEADER.bricks}u] > 0u) { walkGrid(MODEL_ITEMS, S[${HEADER.bricks + 1}u], o, d, tmin, h, unf); }
}
`;
