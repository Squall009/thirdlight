/**
 * The voxel light volume's update in WGSL (voxel-light-volume.ts runs it):
 * one invocation a cell and face of each brick listed. A cell that does not
 * hold light (solid, or open with nothing solid across a face) writes 0. One
 * that does casts `rays` rays over the face's hemisphere (cosine-weighted,
 * each update a new set) by the occupancy walk (`voxel_walk`, stop `light`):
 *
 * - a ray that meets nothing within the reach sees the sky (the radiance the
 *   live probes see: the scene's environment and the ambient and hemisphere
 *   lights the volume holds, as first-order SH);
 * - a ray that meets a surface sees its bounce: the colour of the cells
 *   there (`albedo`, the materials' colours a brick's cells border) times
 *   the light on it: the sun if a walk toward the sun from there meets
 *   nothing within its reach, each lamp in range on the list of the brick
 *   holding the open cell in front of the face whose walk to it meets
 *   nothing, and the volume's own light in that cell (so bounces build over
 *   updates). Past the level-0 window (or where its brick has no slot yet)
 *   the finest coarse brick holding that cell with a slot lists the lamps;
 *   a hit no kept brick of any level holds loops over the whole table.
 *   A lamp lights the hit as the clustered per-pixel light does
 *   (voxel-light-volume-terms.ts): a point or spot light by three's falloff,
 *   a spot within its cone only (its cookie is not read); an area light
 *   (rect or line) by its diffuse form factor, on its facing side unless
 *   two-sided, its walk toward a point on it that the ray's own sequence
 *   picks, so its shadow softens over a face's updates.
 *
 * The estimate (π × the rays' mean radiance) is blended into the face's old
 * light with the brick's weight (1 / its updates), so a brick settles over
 * its first few updates. A face's rays over its updates are consecutive
 * points of one low-discrepancy sequence (the brick's own count of rays
 * cast), so its first settle's rays cover the hemisphere evenly.
 *
 * A brick of a coarse level (1, 2 or 4 m cells) is updated the same way
 * from its cells' centres; such a cell holds light wherever it is open
 * (no level-0 cell in it stops light), and its rays' bounces read the
 * level-0 cells at their hits.
 */
import { WALK_GPU_MAX_STEPS, voxelWalkWgsl } from './voxel-walk-wgsl';
import { VOLUME_ALBEDO_WIDTH, VOLUME_BRICK_M, VOLUME_BRICK_TEXELS, VOLUME_BRICK_VOLUME, VOLUME_FACES, VOLUME_INDEX_ROW_BASE, VOLUME_INDEX_WIDTH, VOLUME_LEVEL_WINDOWS, VOLUME_LEVELS, VOLUME_LAMP_LIST_ENTRIES, VOLUME_LAMP_LIST_WORDS, VOLUME_LAMP_VEC4S, VOLUME_POOL_WIDTH, volumeWordsWgsl } from './voxel-light-volume-layout';
import { SH_Y0, SH_Y1 } from './surface-probes';
import { CLUSTER_RECT, CLUSTER_SPOT, CLUSTER_TWO_SIDED } from './cluster-build';
import { volumeLampTermsWgsl } from './voxel-light-volume-terms';

/** Threads a workgroup: one a cell of a brick. */
export const VOLUME_WORKGROUP = VOLUME_BRICK_VOLUME;
/** u32 words a listed brick takes (its brick and slot, its weight and update). */
export const VOLUME_LIST_WORDS = 8;
/** f32 words of the pass's parameters. */
export const VOLUME_PARAM_FLOATS = 52;
/** Where in them the coarse levels' window corners start (a vec4 of i32 each, levels 1 … 3). */
export const VOLUME_PARAM_COARSE = 40;

export const VOLUME_UPDATE_WGSL = /* wgsl */ `
struct Params {
  origin: vec4<i32>,
  dims: vec4<i32>,
  sun_dir: vec4<f32>,
  sun_rgb: vec4<f32>,
  sky: array<vec4<f32>, 4>,
  misc: vec4<f32>,
  levels: vec4<u32>,
  coarse: array<vec4<i32>, ${VOLUME_LEVELS - 1}>,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bricks: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> lamps: array<vec4<f32>>;
@group(0) @binding(5) var pool: texture_storage_2d<r32uint, read_write>;
@group(0) @binding(6) var index_tex: texture_2d<u32>;
@group(0) @binding(7) var albedo_tex: texture_2d<u32>;
@group(0) @binding(8) var<storage, read> lamp_lists: array<u32>;
@group(0) @binding(9) var<storage, read> lamp_slots: array<u32>;
${voxelWalkWgsl({ group: 0, table: 3, pages: 4 })}
${volumeWordsWgsl()}
${volumeLampTermsWgsl()}

const PI: f32 = 3.14159265;
const CELL_M: f32 = 0.5;

/** The walk's light stop at a level-0 cell: false where no block is known (open air, as the walk passes it). */
fn volume_solid(c: vec3<i32>) -> bool {
  let v = walk_value(0u, c >> vec3<u32>(5u));
  if (v == WALK_NONE) { return false; }
  let flag = (v >> 2u) & 3u;
  if (flag == 1u) { return true; }
  if (flag != 2u) { return false; }
  let l = c - (c >> vec3<u32>(5u)) * 32;
  let page = (v >> 4u) * WALK_PAGE_WORDS;
  return walk_bit(page + 2u * WALK_BRICK_WORDS + WALK_CELL_WORDS, u32((l.x * 32 + l.z) * 32 + l.y));
}

fn volume_holds(c: vec3<i32>) -> bool {
  if (volume_solid(c)) { return false; }
  return volume_solid(c + vec3<i32>(1, 0, 0)) || volume_solid(c - vec3<i32>(1, 0, 0)) || volume_solid(c + vec3<i32>(0, 1, 0)) || volume_solid(c - vec3<i32>(0, 1, 0)) || volume_solid(c + vec3<i32>(0, 0, 1)) || volume_solid(c - vec3<i32>(0, 0, 1));
}

/** Whether cell cc of a coarse level stops light: some level-0 cell inside it does (the CPU twin is volumeCoarseSolid). */
fn volume_coarse_solid(level: u32, cc: vec3<i32>) -> bool {
  let n = 1 << level;
  let f = cc * n;
  let v = walk_value(0u, f >> vec3<u32>(5u));
  if (v == WALK_NONE) { return false; }
  let flag = (v >> 2u) & 3u;
  if (flag == 1u) { return true; }
  if (flag != 2u) { return false; }
  let l = f - (f >> vec3<u32>(5u)) * 32;
  let page = (v >> 4u) * WALK_PAGE_WORDS;
  if (n >= 4) {
    let m = n / 4;
    let b = l / 4;
    for (var i = 0; i < m; i++) { for (var k = 0; k < m; k++) { for (var j = 0; j < m; j++) {
      if (walk_bit(page + WALK_BRICK_WORDS, u32(((b.x + i) * 8 + b.z + k) * 8 + b.y + j))) { return true; }
    } } }
    return false;
  }
  for (var i = 0; i < n; i++) { for (var k = 0; k < n; k++) { for (var j = 0; j < n; j++) {
    if (walk_bit(page + 2u * WALK_BRICK_WORDS + WALK_CELL_WORDS, u32(((l.x + i) * 32 + l.z + k) * 32 + l.y + j))) { return true; }
  } } }
  return false;
}

/** The slot + 1 of the brick holding cell c (0: none resident there). */
fn volume_slot(c: vec3<i32>) -> u32 {
  let b = c >> vec3<u32>(2u);
  let o = params.origin.xyz;
  let d = params.dims.xyz;
  if (any(b < o) || any(b >= o + d)) { return 0u; }
  let s = ((b % d) + d) % d;
  return textureLoad(index_tex, vec2<i32>(s.x + d.x * s.z, s.y), 0).x;
}

fn volume_local(c: vec3<i32>) -> u32 {
  let l = c - (c >> vec3<u32>(2u)) * 4;
  return u32(l.x + 4 * (l.y + 4 * l.z));
}

fn pool_at(slot: u32, cell: u32, face: u32) -> vec2<i32> {
  let i = slot * ${VOLUME_BRICK_TEXELS}u + cell * ${VOLUME_FACES}u + face;
  return vec2<i32>(i32(i % ${VOLUME_POOL_WIDTH}u), i32(i / ${VOLUME_POOL_WIDTH}u));
}

/** The light the volume holds at face f of open cell c (0 where none is held). */
fn volume_light(c: vec3<i32>, f: u32) -> vec3<f32> {
  let s = volume_slot(c);
  if (s == 0u) { return vec3<f32>(0.0); }
  let w = textureLoad(pool, pool_at(s - 1u, volume_local(c), f)).x;
  return volume_decode(w);
}

/** The colour of the solid cells open cell c borders (the default grey where no brick holds it). */
fn volume_albedo(c: vec3<i32>) -> vec3<f32> {
  let s = volume_slot(c);
  if (s == 0u) { return vec3<f32>(params.misc.z); }
  let i = (s - 1u) * ${VOLUME_BRICK_VOLUME}u + volume_local(c);
  let w = textureLoad(albedo_tex, vec2<i32>(i32(i % ${VOLUME_ALBEDO_WIDTH}u), i32(i / ${VOLUME_ALBEDO_WIDTH}u)), 0).x;
  if (w == 0u) { return vec3<f32>(params.misc.z); }
  return unpack4x8unorm(w).rgb;
}

fn sky_radiance(d: vec3<f32>) -> vec3<f32> {
  let s = params.sky;
  return max(s[0].xyz * ${SH_Y0} + (s[1].xyz * d.y + s[2].xyz * d.z + s[3].xyz * d.x) * ${SH_Y1}, vec3<f32>(0.0));
}

/** Whether a walk from p along d meets nothing that stops light within max_t metres. */
fn volume_clear(p: vec3<f32>, d: vec3<f32>, max_t: f32) -> bool {
  var cell: vec3<i32>;
  var frac: vec3<f32>;
  var inv: vec3<f32>;
  voxel_walk_ray(p, d, &cell, &frac, &inv);
  let h = voxel_walk(cell, frac, inv, max_t, 1u, params.levels.x);
  return h.end != 1u;
}

/** The slot + 1 of the brick of \`level\` holding level-0 cell c in the lists' window index (0: none there). */
fn lamp_slot_of(c: vec3<i32>, level: u32, o: vec3<i32>, d: vec3<i32>, row: u32) -> u32 {
  let b = c >> vec3<u32>(2u + level);
  if (any(b < o) || any(b >= o + d)) { return 0u; }
  let s = ((b % d) + d) % d;
  return lamp_slots[(row + u32(s.y)) * ${VOLUME_INDEX_WIDTH}u + u32(s.x + d.x * s.z)];
}

/**
 * Where the lamp list lighting a hit whose open cell is c starts (its slot's words), or -1: the list of the level-0
 * brick holding c when that brick is in its window with a slot, else the finest coarse level's brick holding c that
 * has one (the CPU reference is volumeLampListBrick). The lists' own window index, written as a brick takes and gives
 * up a slot (the pool's index is written only after its first update).
 */
fn lamp_list_at(c: vec3<i32>) -> i32 {
  var v = lamp_slot_of(c, 0u, params.origin.xyz, params.dims.xyz, 0u);
${Array.from({ length: VOLUME_LEVELS - 1 }, (_, k) => k + 1).map((l) => `  if (v == 0u) { v = lamp_slot_of(c, ${l}u, params.coarse[${l - 1}].xyz, vec3<i32>(${VOLUME_LEVEL_WINDOWS[l]!.join(', ')}), ${VOLUME_INDEX_ROW_BASE[l]}u); }`).join('\n')}
  if (v == 0u) { return -1; }
  return i32((v - 1u) * ${VOLUME_LAMP_LIST_WORDS}u);
}

/**
 * The light on a surface at p facing n (unit, a face's) from the sun and the lamps, each behind its walk: the lamps
 * listed for the brick holding open cell air (the cell in front of the face), every lamp of the table where no kept
 * brick holds it (\`params.misc.y\` lamps). xi (in [0, 1)²) picks the point of an area light its walk goes to.
 */
fn direct_light(p: vec3<f32>, n: vec3<f32>, air: vec3<i32>, xi: vec2<f32>) -> vec3<f32> {
  var e = vec3<f32>(0.0);
  let q = p + n * 0.01;
  let ns = dot(n, params.sun_dir.xyz);
  if (params.sun_dir.w > 0.5 && ns > 0.0 && volume_clear(q, params.sun_dir.xyz, params.sun_rgb.w)) {
    e = e + params.sun_rgb.xyz * ns;
  }
  // A hit no kept brick of any level holds (past the windows, a brick not kept or waiting for a slot): the whole table.
  let at = lamp_list_at(air);
  let whole = at < 0;
  let base = select(u32(at), 0u, whole);
  let count = select(lamp_lists[base], u32(params.misc.y), whole);
  for (var k = 0u; k < count; k++) {
    let li = select(lamp_lists[base + 2u + k], k, whole);
    let a = lamps[${VOLUME_LAMP_VEC4S}u * li];
    let b = lamps[${VOLUME_LAMP_VEC4S}u * li + 1u];
    let c = lamps[${VOLUME_LAMP_VEC4S}u * li + 2u];
    let to = a.xyz - p;
    let d = length(to);
    if (d >= a.w) { continue; }
    let field = u32(c.w);
    if ((field & 3u) >= ${CLUSTER_RECT}u) {
      // An area light: its diffuse light at the hit, then the walk toward one point of it.
      let su = lamps[${VOLUME_LAMP_VEC4S}u * li + 3u].xyz;
      let sv = lamps[${VOLUME_LAMP_VEC4S}u * li + 4u].xyz;
      let f = volume_area_light(p, n, a.xyz, su, sv, select(0.0, 1.0, (field & ${CLUSTER_TWO_SIDED}u) != 0u), a.w);
      if (f <= 0.0) { continue; }
      let s = a.xyz + su * (2.0 * xi.x - 1.0) + sv * (2.0 * xi.y - 1.0) - q;
      let ds = length(s);
      if (ds > 1e-3 && !volume_clear(q, s / ds, max(ds - 0.3, 0.0))) { continue; }
      e = e + b.xyz * (PI * f);
      continue;
    }
    if (d < 1e-3) { continue; }
    let l = to / d;
    let nl = dot(n, l);
    if (nl <= 0.0) { continue; }
    // three's punctual falloff: 1 / d^decay, smoothed to 0 at the range.
    let r = d / a.w;
    let w = clamp(1.0 - r * r * r * r, 0.0, 1.0);
    var fall = w * w / max(pow(d, b.w), 0.01);
    if ((field & 3u) == ${CLUSTER_SPOT}u) {
      // Its cone, as the per-pixel light's (axis in c, cos outer and inner in the last words of the next two).
      fall = fall * volume_spot_cone(dot(l, -c.xyz), lamps[${VOLUME_LAMP_VEC4S}u * li + 3u].w, lamps[${VOLUME_LAMP_VEC4S}u * li + 4u].w);
      if (fall <= 0.0) { continue; }
    }
    if (!volume_clear(q, l, max(d - 0.3, 0.0))) { continue; }
    e = e + b.xyz * (fall * nl);
  }
  return e;
}

/** The radiance a ray from p along d sees: the sky past the reach, else the bounce of the surface it meets (xi: direct_light's). */
fn ray_radiance(p: vec3<f32>, d: vec3<f32>, xi: vec2<f32>) -> vec3<f32> {
  var cell: vec3<i32>;
  var frac: vec3<f32>;
  var inv: vec3<f32>;
  voxel_walk_ray(p, d, &cell, &frac, &inv);
  let h = voxel_walk(cell, frac, inv, params.misc.x, 1u, params.levels.x);
  if (h.end == 0u || h.end == 2u) { return sky_radiance(d); }
  if (h.end != 1u || h.axis < 0) { return vec3<f32>(0.0); }
  let a = u32(h.axis);
  var n = vec3<f32>(0.0);
  n[a] = select(1.0, -1.0, d[a] > 0.0);
  var toward = vec3<i32>(0);
  toward[a] = select(1, -1, d[a] > 0.0);
  let air = h.cell + toward;
  let hp = p + d * h.t;
  let face = a * 2u + select(0u, 1u, n[a] < 0.0);
  let e = direct_light(hp, n, air, xi) + volume_light(air, face);
  return volume_albedo(air) * e / PI;
}

fn hash3(c: vec3<i32>, f: u32) -> u32 {
  var h = (bitcast<u32>(c.x) * 0x9e3779b1u) ^ (bitcast<u32>(c.y) * 0x85ebca77u) ^ (bitcast<u32>(c.z) * 0xc2b2ae3du) ^ (f * 0x27d4eb2fu);
  h = h ^ (h >> 15u);
  h = h * 0x2c1b3c6du;
  return h ^ (h >> 12u);
}

@compute @workgroup_size(${VOLUME_WORKGROUP})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  if (i32(wid.x) >= params.origin.w) { return; }
  let b = bricks[2u * wid.x];
  let info = bricks[2u * wid.x + 1u];
  let face = wid.y;
  let level = u32(info.z);
  let l = vec3<i32>(i32(lid & 3u), i32((lid >> 2u) & 3u), i32(lid >> 4u));
  let c = b.xyz * 4 + l;
  let at = pool_at(u32(b.w), lid, face);
  var holds = false;
  if (level == 0u) { holds = volume_holds(c); } else { holds = !volume_coarse_solid(level, c); }
  if (!holds) {
    textureStore(pool, at, vec4<u32>(0u));
    return;
  }
  let axis = face >> 1u;
  let sgn = select(1.0, -1.0, (face & 1u) == 1u);
  let t1 = (axis + 1u) % 3u;
  let t2 = (axis + 2u) % 3u;
  let origin = (vec3<f32>(c) + 0.5) * (CELL_M * f32(1 << level));
  let rays = u32(params.dims.w);
  let h = hash3(c, face + 8u * level);
  let j = vec2<f32>(f32(h & 0xffffu), f32(h >> 16u)) / 65536.0;
  var sum = vec3<f32>(0.0);
  for (var r = 0u; r < rays; r++) {
    let k = f32(u32(info.y) * rays + r);
    let u = fract(j + k * vec2<f32>(0.7548776662, 0.5698402910));
    let rr = sqrt(u.x);
    let th = 2.0 * PI * u.y;
    var d = vec3<f32>(0.0);
    d[axis] = sgn * sqrt(max(1.0 - u.x, 0.0));
    d[t1] = rr * cos(th);
    d[t2] = rr * sin(th);
    // The ray's area-light point: the same sequence turned and offset, so it covers a light over a face's updates.
    sum = sum + ray_radiance(origin, normalize(d), fract(u.yx + vec2<f32>(0.3819660113, 0.6180339887)));
  }
  let est = sum * (PI / f32(max(rays, 1u)));
  let old = textureLoad(pool, at).x;
  let blend = bitcast<f32>(info.x);
  var v = est;
  if (old != 0u && blend < 1.0) { v = mix(volume_decode(old), est, blend); }
  textureStore(pool, at, vec4<u32>(volume_encode(v), 0u, 0u, 0u));
}
`;

/** Threads a workgroup of the lamp lists' build and count. */
export const VOLUME_LAMP_LIST_WORKGROUP = 64;
/** u32 words of the lists' build parameters (jobs, lamps, slots, pad). */
export const VOLUME_LAMP_LIST_PARAM_WORDS = 4;
/** u32 words of the lists' counts: bricks listing a lamp, lamps listed, the most lamps reaching one brick, bricks over, lamps dropped. */
export const VOLUME_LAMP_LIST_STAT_WORDS = 8;

/**
 * The lamp lists' build (entry point `build`): one invocation a job, a job a brick and its slot (x, y, z, and the
 * slot with the brick's level over its low 24 bits), or a slot to clear (w = −1 − slot). It tests every lamp of the table against the brick's box (its reach
 * sphere meets the box), keeps the `VOLUME_LAMP_LIST_ENTRIES` that are strongest while more reach it (the weakest
 * goes, the latest of equals), and writes them by index with the count listed and the count reaching it. The CPU
 * reference is `volumeBrickLamps`. The count (entry point `count`): every slot's list summed into the counts the
 * volume's diagnostics show (bricks over, lamps dropped), one invocation a slot.
 */
export const VOLUME_LAMP_LIST_WGSL = /* wgsl */ `
struct ListParams {
  jobs: u32,
  lamps: u32,
  slots: u32,
  pad: u32,
}
@group(0) @binding(0) var<uniform> lp: ListParams;
@group(0) @binding(1) var<storage, read> jobs: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> lamps: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> lists: array<u32>;
@group(0) @binding(4) var<storage, read_write> counts: array<atomic<u32>>;

const ENTRIES: u32 = ${VOLUME_LAMP_LIST_ENTRIES}u;
const WORDS: u32 = ${VOLUME_LAMP_LIST_WORDS}u;
const BRICK_M: f32 = ${VOLUME_BRICK_M.toFixed(1)};

/** The CPU twin is volumeLampStrength. */
fn lamp_strength(a: vec4<f32>, b: vec4<f32>, d: f32) -> f32 {
  let t = d / a.w;
  let w = clamp(1.0 - t * t * t * t, 0.0, 1.0);
  return max(b.x, max(b.y, b.z)) * w * w / max(pow(max(d, 0.1), b.w), 0.01);
}

@compute @workgroup_size(${VOLUME_LAMP_LIST_WORKGROUP})
fn build(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lp.jobs) { return; }
  let job = jobs[gid.x];
  if (job.w < 0) {
    let base = u32(-job.w - 1) * WORDS;
    lists[base] = 0u;
    lists[base + 1u] = 0u;
    return;
  }
  let base = (u32(job.w) & 0xffffffu) * WORDS;
  let size = BRICK_M * f32(1u << (u32(job.w) >> 24u));
  let lo = vec3<f32>(job.xyz) * size;
  let hi = lo + vec3<f32>(size);
  var ids: array<u32, ${VOLUME_LAMP_LIST_ENTRIES}>;
  var sc: array<f32, ${VOLUME_LAMP_LIST_ENTRIES}>;
  var n = 0u;
  var total = 0u;
  for (var i = 0u; i < lp.lamps; i++) {
    let a = lamps[${VOLUME_LAMP_VEC4S}u * i];
    let g = max(max(lo - a.xyz, a.xyz - hi), vec3<f32>(0.0));
    let d2 = dot(g, g);
    if (!(d2 < a.w * a.w)) { continue; }
    total = total + 1u;
    let s = lamp_strength(a, lamps[${VOLUME_LAMP_VEC4S}u * i + 1u], sqrt(d2));
    if (n < ENTRIES) {
      ids[n] = i;
      sc[n] = s;
      n = n + 1u;
      continue;
    }
    var w = 0u;
    for (var k = 1u; k < ENTRIES; k++) {
      if (sc[k] < sc[w] || (sc[k] == sc[w] && ids[k] > ids[w])) { w = k; }
    }
    if (s > sc[w]) {
      ids[w] = i;
      sc[w] = s;
    }
  }
  // By index, as the CPU's rule lists them.
  for (var k = 1u; k < n; k++) {
    let v = ids[k];
    var j = k;
    while (j > 0u && ids[j - 1u] > v) {
      ids[j] = ids[j - 1u];
      j = j - 1u;
    }
    ids[j] = v;
  }
  lists[base] = n;
  lists[base + 1u] = total;
  for (var k = 0u; k < n; k++) { lists[base + 2u + k] = ids[k]; }
}

@compute @workgroup_size(${VOLUME_LAMP_LIST_WORKGROUP})
fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lp.slots) { return; }
  let base = gid.x * WORDS;
  let n = lists[base];
  let total = lists[base + 1u];
  if (total == 0u) { return; }
  atomicAdd(&counts[0], 1u);
  atomicAdd(&counts[1], n);
  atomicMax(&counts[2], total);
  if (total > n) {
    atomicAdd(&counts[3], 1u);
    atomicAdd(&counts[4], total - n);
  }
}
`;

/** Steps a walk of the update may take at most (the walk's own). */
export const VOLUME_WALK_STEPS = WALK_GPU_MAX_STEPS;
