/**
 * The fine far bricks' build on the GPU (voxel-fine-bricks.ts runs it): the
 * same bricks the CPU build (`@thirdlight/voxel` far-bricks-faces.ts
 * `farBricksFromBlock`) makes from the same cell block, in five passes over
 * one node.
 *
 * - **The field** (passes 1–3). The CPU build's exact distance from each
 *   node corner to the solid cells' spans and to the air's (a part-full cell
 *   a height laid from its fuller vertical neighbour), first along y per
 *   corner line, then the separable passes along x and z. The CPU runs the
 *   whole transform; here each pass looks only within the band (a few cells
 *   either way): a nearer span or offset than the band always lies inside
 *   that window, and a corner farther than the band stores the band either
 *   way, so the stored bytes are the same. A corner on the surface of whole
 *   cells is moved by ½ less their mean fill, as the CPU build does.
 * - **Which bricks** (pass 4). A brick is stored, outside or inside by the
 *   CPU build's rule (its samples' least and greatest, the solid cells it
 *   holds, a surface on its faces), with the cells a ray can hit in.
 * - **The samples** (pass 5). A stored brick's distance bytes, each sample's
 *   look (the vote of the shown cells round it: tops first, the CPU build's
 *   weights and order; at most {@link FINE_VOTE_WORDS} distinct words a
 *   sample, the CPU build counts them all) and its occlusion from the
 *   brick's own bytes (far-bricks-shade.ts `farBrickOcclusionAt`), written
 *   in rows a copy puts straight into the brick atlas's regions. The look
 *   word itself goes where a coarse brick keeps its baked colour (its low
 *   and high byte in red and green, the occlusion in alpha): the shade
 *   textures a fine hit from the words round it as the near surface does,
 *   and reads each word's far colour from the live material table, so a
 *   fine brick costs no byte more than a coarse one and follows a material
 *   record without a rebuild.
 *
 * Floats are 32-bit here where the CPU build reads 64-bit sums, so a sample
 * at a byte's rounding edge may land one byte off; `Math.round` is
 * `floor(x + 0.5)` here (WGSL's `round` takes halves to even).
 */
import { BRICK_HIT_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SIDE, FAR_BRICK_GRADIENT_MIN, FAR_BRICK_NORMAL_SPAN_CELLS, FAR_BRICK_SKIRT_SLOPE } from '@thirdlight/voxel';

/** Threads a workgroup of the field and look passes. */
export const FINE_WORKGROUP = 64;

/** Distinct look words a sample's vote keeps (a footprint of 2 × 4 × 2 node cells holds few materials). */
export const FINE_VOTE_WORDS = 8;

/** Bricks a node holds (4³ at the 32-cell edge). */
export const FINE_NODE_BRICKS = 64;

/** Corners a side of a node (its 32 cells and the far edge). */
export const FINE_CORNERS = 33;

/** Brick rows a 256-byte copy row holds: distances (9 bytes a row, laid 12 apart) and look words with occlusion (36). */
export const FINE_DIST_PER_ROW = 21;
export const FINE_COLOUR_PER_ROW = 7;

/** Bytes a copy row takes (WebGPU's buffer-to-texture rows are 256-byte aligned). */
export const FINE_ROW_BYTES = 256;

/** Rows a brick's samples take in a copy (9 × 9). */
export const FINE_BRICK_ROWS = DISTANCE_BRICK_SIDE * DISTANCE_BRICK_SIDE;

/** u32 words of the staged distances (every brick of a node) and of the staged looks that follow them. */
export const FINE_DIST_WORDS = Math.ceil(FINE_NODE_BRICKS / FINE_DIST_PER_ROW) * FINE_BRICK_ROWS * (FINE_ROW_BYTES / 4);
export const FINE_COLOUR_WORDS = Math.ceil(FINE_NODE_BRICKS / FINE_COLOUR_PER_ROW) * FINE_BRICK_ROWS * (FINE_ROW_BYTES / 4);

/** u32 words a brick's entry in the build's brick list takes (kind, its hit cells, its node faces, unused). */
export const FINE_META_WORDS = 4;

/** A brick's kind in the brick list. */
export const FINE_KIND = { outside: 0, inside: 1, stored: 2 } as const;

/** u32 words of the uniform block ({@link fineParams}). */
export const FINE_PARAM_WORDS = 32;

/** Floats of the scratch buffer for a block of `n` cells a side: the y pass, the x pass and the corner field. */
export function fineScratchFloats(n: number): { readonly ys: number; readonly xs: number; readonly field: number; readonly total: number } {
  const m = n + 1;
  const C = FINE_CORNERS;
  const ys = 2 * C * m * m;
  const xs = 2 * C * m * C;
  const field = C * C * C;
  return { ys, xs, field, total: ys + xs + field };
}

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export const FINE_BRICKS_WGSL = /* wgsl */ `
struct Params {
  n: u32, A: u32, S: u32, m: u32,
  W: u32, R: u32, xsOff: u32, fieldOff: u32,
  dens: array<vec4<f32>, 4>,
  colourOff: u32, p1: u32, p2: u32, p3: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> cells: array<u32>;
@group(0) @binding(2) var<storage, read> words: array<u32>;
@group(0) @binding(3) var<storage, read_write> scratch: array<f32>;
@group(0) @binding(4) var<storage, read_write> bricks: array<u32>;
@group(0) @binding(5) var<storage, read_write> staged: array<u32>;

const NONE: f32 = 1e12;
const C: u32 = ${FINE_CORNERS}u;
const BAND: f32 = ${f(DISTANCE_BRICK_BAND_VOXELS)};
const HIT: f32 = ${f(BRICK_HIT_VOXELS)};
const BC: u32 = ${DISTANCE_BRICK_CELLS}u;
const BS: u32 = ${DISTANCE_BRICK_SIDE}u;
const SLOPE: f32 = ${f(FAR_BRICK_SKIRT_SLOPE)};
const SPAN: f32 = ${f(FAR_BRICK_NORMAL_SPAN_CELLS)};
const GRAD_MIN: f32 = ${f(FAR_BRICK_GRADIENT_MIN)};
const ROW_WORDS: u32 = ${FINE_ROW_BYTES / 4}u;
const DIST_PER_ROW: u32 = ${FINE_DIST_PER_ROW}u;
const COLOUR_PER_ROW: u32 = ${FINE_COLOUR_PER_ROW}u;
const ROWS: u32 = ${FINE_BRICK_ROWS}u;
const VOTES: u32 = ${FINE_VOTE_WORDS}u;

fn cellAt(i: u32) -> u32 {
  let w = cells[i >> 1u];
  return select(w & 0xffffu, w >> 16u, (i & 1u) == 1u);
}
fn densAt(i: u32) -> f32 {
  let k = cellAt(i) & 15u;
  return P.dens[k >> 2u][k & 3u];
}
fn solidAt(i: u32) -> bool { return densAt(i) >= 0.5; }
fn ci(x: u32, y: u32, z: u32) -> u32 { return (z * P.n + y) * P.n + x; }
fn fieldAt(cx: u32, cy: u32, cz: u32) -> f32 { return scratch[P.fieldOff + (cz * C + cy) * C + cx]; }

// Pass 1: along y. A corner line (x, z) at node corner row cy: the nearest solid span and air span below and above.
@compute @workgroup_size(${FINE_WORKGROUP})
fn ypass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = P.m;
  let t = gid.x;
  if (t >= m * m * C) { return; }
  let x = t % m;
  let z = (t / m) % m;
  let cy = t / (m * m);
  let Y = cy * P.S + P.A;
  let n = i32(P.n);
  var belowS = -1e30; var aboveS = 1e30; var belowA = -1e30; var aboveA = 1e30;
  let y0 = max(i32(Y) - i32(P.W), 0);
  let y1 = min(i32(Y) + i32(P.W), n);
  for (var y = y0; y < y1; y++) {
    var ls = 1e30; var hs = -1e30; var la = 1e30; var ha = -1e30;
    for (var dz = -1; dz <= 0; dz++) {
      let cz = i32(z) + dz;
      if (cz < 0 || cz >= n) { continue; }
      for (var dx = -1; dx <= 0; dx++) {
        let cx = i32(x) + dx;
        if (cx < 0 || cx >= n) { continue; }
        let i = ci(u32(cx), u32(y), u32(cz));
        let d = densAt(i);
        if (d <= 0.0) {
          la = min(la, 0.0); ha = max(ha, 1.0);
        } else if (d >= 1.0) {
          ls = min(ls, 0.0); hs = max(hs, 1.0);
        } else {
          let above = select(0.0, densAt(i + P.n), y < n - 1);
          let below = select(0.0, densAt(i - P.n), y > 0);
          if (above > below) {
            ls = min(ls, 1.0 - d); hs = max(hs, 1.0); la = min(la, 0.0); ha = max(ha, 1.0 - d);
          } else {
            ls = min(ls, 0.0); hs = max(hs, d); la = min(la, d); ha = max(ha, 1.0);
          }
        }
      }
    }
    let fy = f32(y);
    if (u32(y) < Y) {
      if (hs > -1e29) { belowS = max(belowS, fy + hs); }
      if (ha > -1e29) { belowA = max(belowA, fy + ha); }
    } else {
      if (ls < 1e29) { aboveS = min(aboveS, fy + ls); }
      if (la < 1e29) { aboveA = min(aboveA, fy + la); }
    }
  }
  let fY = f32(Y);
  let dS = min(fY - belowS, aboveS - fY);
  let dA = min(fY - belowA, aboveA - fY);
  let at = (cy * m + z) * m + x;
  scratch[at] = select(NONE, dS * dS, dS < 1e29);
  scratch[C * m * m + at] = select(NONE, dA * dA, dA < 1e29);
}

// Pass 2: along x, at the node's corner columns only (the z pass reads nothing else).
@compute @workgroup_size(${FINE_WORKGROUP})
fn xpass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = P.m;
  let t = gid.x;
  if (t >= 2u * C * m * C) { return; }
  let cx = t % C;
  let z = (t / C) % m;
  let cy = (t / (C * m)) % C;
  let sel = t / (C * m * C);
  let X = i32(cx * P.S + P.A);
  let row = ((sel * C + cy) * m + z) * m;
  var best = NONE;
  let R = i32(P.R);
  for (var j = -R; j <= R; j++) {
    let x = X + j;
    if (x < 0 || x >= i32(m)) { continue; }
    best = min(best, scratch[row + u32(x)] + f32(j * j));
  }
  scratch[P.xsOff + ((sel * C + cy) * m + z) * C + cx] = best;
}

// Pass 3: along z, then the corner's signed distance (node cells).
@compute @workgroup_size(${FINE_WORKGROUP})
fn zpass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = P.m;
  let t = gid.x;
  if (t >= C * C * C) { return; }
  let cx = t % C;
  let cy = (t / C) % C;
  let cz = t / (C * C);
  let Z = i32(cz * P.S + P.A);
  let R = i32(P.R);
  var toS = NONE; var toA = NONE;
  for (var l = -R; l <= R; l++) {
    let z = Z + l;
    if (z < 0 || z >= i32(m)) { continue; }
    let o = f32(l * l);
    toS = min(toS, scratch[P.xsOff + ((0u * C + cy) * m + u32(z)) * C + cx] + o);
    toA = min(toA, scratch[P.xsOff + ((1u * C + cy) * m + u32(z)) * C + cx] + o);
  }
  let out = sqrt(toS);
  let inside = sqrt(toA);
  let S = f32(P.S);
  var v = select(-inside, out, out > 0.0) / S;
  if (out == 0.0 && inside == 0.0) {
    let i = ci(cx * P.S + P.A - 1u, cy * P.S + P.A - 1u, cz * P.S + P.A - 1u);
    let n = P.n;
    let n2 = n * n;
    var sum = 0.0;
    var whole = true;
    for (var k = 0u; k < 8u; k++) {
      let d = densAt(i + (k & 1u) + select(0u, n, (k & 2u) != 0u) + select(0u, n2, (k & 4u) != 0u));
      sum += d;
      if (d > 0.0 && d < 1.0) { whole = false; }
    }
    if (whole) { v = (0.5 - sum / 8.0) / S; }
  }
  scratch[P.fieldOff + t] = v;
}

var<workgroup> wLo: array<f32, ${FINE_WORKGROUP}>;
var<workgroup> wHi: array<f32, ${FINE_WORKGROUP}>;
var<workgroup> wHeld: array<u32, ${FINE_WORKGROUP}>;
var<workgroup> wFace: array<u32, ${FINE_WORKGROUP}>;
var<workgroup> wBox: array<vec3<i32>, ${FINE_WORKGROUP * 2}>;

// Pass 4: a workgroup a brick decides whether it is stored, and where its surface can be hit.
@compute @workgroup_size(${FINE_WORKGROUP})
fn classify(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let b = wid.x;
  let bx = b % 4u; let by = (b / 4u) % 4u; let bz = b / 16u;
  let faces = select(0u, 1u, bx == 0u) | select(0u, 2u, bx == 3u) | select(0u, 4u, by == 0u) | select(0u, 8u, by == 3u) | select(0u, 16u, bz == 0u) | select(0u, 32u, bz == 3u);
  let sideFaces = (faces & (1u | 2u | 16u | 32u)) != 0u;
  var lo = 1e30; var hi = -1e30; var onFace = 0u;
  for (var k = li; k < BS * BS * BS; k += ${FINE_WORKGROUP}u) {
    let sx = k % BS; let sy = (k / BS) % BS; let sz = k / (BS * BS);
    let v = fieldAt(bx * BC + sx, by * BC + sy, bz * BC + sz);
    lo = min(lo, v); hi = max(hi, v);
    let edge = sx == 0u || sx == BS - 1u || sy == 0u || sy == BS - 1u || sz == 0u || sz == BS - 1u;
    if (edge && v > -HIT) { onFace = 1u; }
  }
  let F = BC * P.S;
  var held = 0u;
  for (var k = li; k < F * F * F; k += ${FINE_WORKGROUP}u) {
    let x = k % F; let y = (k / F) % F; let z = k / (F * F);
    if (solidAt(ci(bx * F + x + P.A, by * F + y + P.A, bz * F + z + P.A))) { held++; }
  }
  var bLo = vec3<i32>(i32(BC)); var bHi = vec3<i32>(0);
  for (var k = li; k < BC * BC * BC; k += ${FINE_WORKGROUP}u) {
    let x = k % BC; let y = (k / BC) % BC; let z = k / (BC * BC);
    var cLo = 1e30; var cHi = -1e30;
    for (var q = 0u; q < 8u; q++) {
      let d = fieldAt(bx * BC + x + (q & 1u), by * BC + y + ((q >> 1u) & 1u), bz * BC + z + ((q >> 2u) & 1u));
      cLo = min(cLo, d); cHi = max(cHi, d);
    }
    if (cLo >= HIT || (cHi <= -HIT && !sideFaces)) { continue; }
    bLo = min(bLo, vec3<i32>(i32(x), i32(y), i32(z)));
    bHi = max(bHi, vec3<i32>(i32(x) + 1, i32(y) + 1, i32(z) + 1));
  }
  wLo[li] = lo; wHi[li] = hi; wHeld[li] = held; wFace[li] = onFace;
  wBox[li * 2u] = bLo; wBox[li * 2u + 1u] = bHi;
  workgroupBarrier();
  if (li != 0u) { return; }
  var aLo = 1e30; var aHi = -1e30; var aHeld = 0u; var aFace = 0u;
  var boxLo = vec3<i32>(i32(BC)); var boxHi = vec3<i32>(0);
  for (var k = 0u; k < ${FINE_WORKGROUP}u; k++) {
    aLo = min(aLo, wLo[k]); aHi = max(aHi, wHi[k]); aHeld += wHeld[k]; aFace = aFace | wFace[k];
    boxLo = min(boxLo, wBox[k * 2u]); boxHi = max(boxHi, wBox[k * 2u + 1u]);
  }
  var kind = ${FINE_KIND.stored}u;
  if (aLo > 0.0 || (aHeld == 0u && aLo >= 0.0)) {
    kind = ${FINE_KIND.outside}u;
  } else if (aHi < 0.0 || (aHeld == F * F * F && aHi <= 0.0 && aLo < 0.0 && aFace == 0u)) {
    kind = ${FINE_KIND.inside}u;
  }
  if (boxHi.x <= boxLo.x) { boxLo = vec3<i32>(0); boxHi = vec3<i32>(i32(BC)); }
  let packed = u32(boxLo.x) | (u32(boxLo.y) << 4u) | (u32(boxLo.z) << 8u) | (u32(boxHi.x) << 12u) | (u32(boxHi.y) << 16u) | (u32(boxHi.z) << 20u);
  bricks[b * 4u] = kind;
  bricks[b * 4u + 1u] = packed;
  bricks[b * 4u + 2u] = faces;
}

fn byteOf(v: f32) -> f32 {
  let u = clamp(v / BAND, -1.0, 1.0);
  return floor((u * 0.5 + 0.5) * 255.0 + 0.5);
}
fn distOfByte(q: f32) -> f32 { return ((q / 255.0) * 2.0 - 1.0) * BAND; }

var<workgroup> wKind: u32;
var<workgroup> wLook: array<i32, ${DISTANCE_BRICK_SIDE ** 3}>;
var<workgroup> wByte: array<f32, ${DISTANCE_BRICK_SIDE ** 3}>;

fn sampleByte(s: vec3<u32>) -> f32 { return wByte[(s.z * BS + s.y) * BS + s.x]; }
// The trilinear distance at a point of the brick (cells, clamped), as the GPU's filtered read of its bytes.
fn sampleAt(p0: vec3<f32>) -> f32 {
  let p = clamp(p0, vec3<f32>(0.0), vec3<f32>(f32(BC)));
  let i = min(vec3<u32>(floor(p)), vec3<u32>(BC - 1u));
  let fr = p - vec3<f32>(i);
  let a = mix(sampleByte(i), sampleByte(i + vec3<u32>(1u, 0u, 0u)), fr.x);
  let b2 = mix(sampleByte(i + vec3<u32>(0u, 1u, 0u)), sampleByte(i + vec3<u32>(1u, 1u, 0u)), fr.x);
  let c = mix(sampleByte(i + vec3<u32>(0u, 0u, 1u)), sampleByte(i + vec3<u32>(1u, 0u, 1u)), fr.x);
  let d = mix(sampleByte(i + vec3<u32>(0u, 1u, 1u)), sampleByte(i + vec3<u32>(1u, 1u, 1u)), fr.x);
  return distOfByte(mix(mix(a, b2, fr.y), mix(c, d, fr.y), fr.z));
}
fn fieldOut(p: vec3<f32>) -> f32 {
  let q = clamp(p, vec3<f32>(0.0), vec3<f32>(f32(BC)));
  return sampleAt(q) + SLOPE * length(p - q);
}

// A shown cell's vote: 2 a top, 1 a solid cell beside a non-solid one, 0 hidden or empty.
fn shownAt(i: u32) -> u32 {
  if (densAt(i) == 0.0) { return 0u; }
  if (densAt(i + P.n) == 0.0) { return 2u; }
  if (!solidAt(i)) { return 0u; }
  let n2 = P.n * P.n;
  if (!solidAt(i + P.n) || !solidAt(i - P.n) || !solidAt(i + 1u) || !solidAt(i - 1u) || !solidAt(i + n2) || !solidAt(i - n2)) { return 1u; }
  return 0u;
}

// The look of node corner (cx, cy, cz): the CPU build's vote over the finer cells round it; -1 when none shows.
fn lookAt(cx: u32, cy: u32, cz: u32) -> i32 {
  var vw: array<u32, ${FINE_VOTE_WORDS}>;
  var vc: array<u32, ${FINE_VOTE_WORDS}>;
  var count = 0u;
  let S = P.S;
  let x0 = cx * S + P.A - S; let y0 = cy * S + P.A - S; let z0 = cz * S + P.A - S;
  for (var z = z0; z < z0 + 2u * S; z++) {
    for (var y = y0 - S; y < y0 + 3u * S; y++) {
      for (var x = x0; x < x0 + 2u * S; x++) {
        let i = ci(x, y, z);
        let sh = shownAt(i);
        let outer = y < y0 || y >= y0 + 2u * S;
        var w = 0u;
        if (outer) { w = select(0u, ${1 << 10}u, sh == 2u); } else { w = select(select(0u, 1u, sh == 1u), ${1 << 20}u, sh == 2u); }
        if (w == 0u) { continue; }
        let word = words[cellAt(i) >> 4u];
        var found = false;
        for (var k = 0u; k < count; k++) {
          if (vw[k] == word) { vc[k] += w; found = true; break; }
        }
        if (!found && count < VOTES) { vw[count] = word; vc[count] = w; count++; }
      }
    }
  }
  var best = -1;
  var bestW = 0u;
  for (var k = 0u; k < count; k++) {
    if (vc[k] > bestW) { bestW = vc[k]; best = i32(vw[k]); }
  }
  return best;
}

// Pass 5: a workgroup a stored brick, a thread a row of samples: distances, looks and occlusion, staged for the copy.
@compute @workgroup_size(${DISTANCE_BRICK_SIDE * DISTANCE_BRICK_SIDE})
fn bake(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let b = wid.x;
  if (li == 0u) { wKind = bricks[b * 4u]; }
  let kind = workgroupUniformLoad(&wKind);
  if (kind != ${FINE_KIND.stored}u) { return; }
  let bx = b % 4u; let by = (b / 4u) % 4u; let bz = b / 16u;
  let sy = li % BS; let sz = li / BS;
  for (var sx = 0u; sx < BS; sx++) {
    let k = (sz * BS + sy) * BS + sx;
    wByte[k] = byteOf(fieldAt(bx * BC + sx, by * BC + sy, bz * BC + sz));
    wLook[k] = lookAt(bx * BC + sx, by * BC + sy, bz * BC + sz);
  }
  workgroupBarrier();
  // Distances: 9 bytes of the row in three words, the brick's slot 12 bytes wide in its copy row.
  let dRow = ((b / DIST_PER_ROW) * ROWS + sz * BS + sy) * ROW_WORDS + (b % DIST_PER_ROW) * 3u;
  for (var w = 0u; w < 3u; w++) {
    var word = 0u;
    for (var q = 0u; q < 4u; q++) {
      let sx = w * 4u + q;
      if (sx < BS) { word = word | (u32(sampleByte(vec3<u32>(sx, sy, sz))) << (q * 8u)); }
    }
    staged[dRow + w] = word;
  }
  let cRow = P.colourOff + ((b / COLOUR_PER_ROW) * ROWS + sz * BS + sy) * ROW_WORDS + (b % COLOUR_PER_ROW) * BS;
  for (var sx = 0u; sx < BS; sx++) {
    let k = (sz * BS + sy) * BS + sx;
    var look = wLook[k];
    // No shown cell in reach: the CPU build carries the last sample's look before it; here within the brick.
    if (look < 0) {
      for (var j = i32(k) - 1; j >= 0 && look < 0; j--) { look = wLook[j]; }
      for (var j = k + 1u; j < BS * BS * BS && look < 0; j++) { look = wLook[j]; }
      look = max(look, 0);
    }
    let p = vec3<f32>(f32(sx), f32(sy), f32(sz));
    var g = vec3<f32>(0.0);
    for (var a = 0u; a < 3u; a++) {
      var e = vec3<f32>(0.0);
      e[a] = SPAN;
      let pa = clamp(p + e, vec3<f32>(0.0), vec3<f32>(f32(BC)));
      let pb = clamp(p - e, vec3<f32>(0.0), vec3<f32>(f32(BC)));
      g[a] = (sampleAt(pa) - sampleAt(pb)) / max(length(pa - pb), 1e-3);
    }
    let len = length(g);
    let nrm = select(vec3<f32>(0.0, 1.0, 0.0), g / len, len > GRAD_MIN);
    let a1 = clamp(fieldOut(p + nrm), 0.0, 1.0);
    let a2 = clamp(fieldOut(p + 2.0 * nrm) / 2.0, 0.0, 1.0);
    let ao = u32(floor((a1 + a2) / 2.0 * 255.0 + 0.5));
    staged[cRow + sx] = (u32(look) & 0xffffu) | (ao << 24u);
  }
}
`;

/** The uniform block for a block of `n` cells a side at a build scale (u32 words; densities as floats in place). */
export function fineParams(n: number, scale: number, apron: number, densities: Float32Array): Uint32Array {
  const out = new Uint32Array(FINE_PARAM_WORDS);
  const floats = new Float32Array(out.buffer);
  const s = fineScratchFloats(n);
  // Windows a little wider than the band at the finer spacing: a nearer span or offset always lies inside them.
  const W = (DISTANCE_BRICK_BAND_VOXELS + 1) * scale + 1;
  const R = DISTANCE_BRICK_BAND_VOXELS * scale + 1;
  out.set([n, apron, scale, n + 1, W, R, s.ys, s.ys + s.xs], 0);
  floats.set(densities.subarray(0, 16), 8);
  out[24] = FINE_DIST_WORDS;
  return out;
}
