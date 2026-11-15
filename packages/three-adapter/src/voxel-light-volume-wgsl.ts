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
 *   nothing within its reach, each listed lamp in range whose walk to it
 *   meets nothing, and the volume's own light in the open cell in front of
 *   the face (so bounces build over updates).
 *
 * The estimate (π × the rays' mean radiance) is blended into the face's old
 * light with the brick's weight (1 / its updates), so a brick settles over
 * its first few updates.
 */
import { WALK_GPU_MAX_STEPS, voxelWalkWgsl } from './voxel-walk-wgsl';
import { VOLUME_ALBEDO_WIDTH, VOLUME_BRICK_TEXELS, VOLUME_BRICK_VOLUME, VOLUME_FACES, VOLUME_POOL_WIDTH, volumeWordsWgsl } from './voxel-light-volume-layout';
import { SH_Y0, SH_Y1 } from './surface-probes';

/** Threads a workgroup: one a cell of a brick. */
export const VOLUME_WORKGROUP = VOLUME_BRICK_VOLUME;
/** u32 words a listed brick takes (its brick and slot, its weight and update). */
export const VOLUME_LIST_WORDS = 8;
/** f32 words a listed lamp takes (place and range, colour and decay). */
export const VOLUME_LAMP_FLOATS = 8;
/** f32 words of the pass's parameters. */
export const VOLUME_PARAM_FLOATS = 48;

export const VOLUME_UPDATE_WGSL = /* wgsl */ `
struct Params {
  origin: vec4<i32>,
  dims: vec4<i32>,
  sun_dir: vec4<f32>,
  sun_rgb: vec4<f32>,
  sky: array<vec4<f32>, 4>,
  misc: vec4<f32>,
  levels: vec4<u32>,
  pad: array<vec4<f32>, 2>,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bricks: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> lamps: array<vec4<f32>>;
@group(0) @binding(5) var pool: texture_storage_2d<r32uint, read_write>;
@group(0) @binding(6) var index_tex: texture_2d<u32>;
@group(0) @binding(7) var albedo_tex: texture_2d<u32>;
${voxelWalkWgsl({ group: 0, table: 3, pages: 4 })}
${volumeWordsWgsl()}

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

/** The light on a surface at p facing n (unit, a face's) from the sun and the lamps, each behind its walk. */
fn direct_light(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  var e = vec3<f32>(0.0);
  let q = p + n * 0.01;
  let ns = dot(n, params.sun_dir.xyz);
  if (params.sun_dir.w > 0.5 && ns > 0.0 && volume_clear(q, params.sun_dir.xyz, params.sun_rgb.w)) {
    e = e + params.sun_rgb.xyz * ns;
  }
  let count = u32(params.misc.y);
  for (var k = 0u; k < count; k++) {
    let a = lamps[2u * k];
    let b = lamps[2u * k + 1u];
    let to = a.xyz - p;
    let d = length(to);
    if (d >= a.w || d < 1e-3) { continue; }
    let l = to / d;
    let nl = dot(n, l);
    if (nl <= 0.0) { continue; }
    // three's punctual falloff: 1 / d^decay, smoothed to 0 at the range.
    let r = d / a.w;
    let w = clamp(1.0 - r * r * r * r, 0.0, 1.0);
    let fall = w * w / max(pow(d, b.w), 0.01);
    if (!volume_clear(q, l, max(d - 0.3, 0.0))) { continue; }
    e = e + b.xyz * (fall * nl);
  }
  return e;
}

/** The radiance a ray from p along d sees: the sky past the reach, else the bounce of the surface it meets. */
fn ray_radiance(p: vec3<f32>, d: vec3<f32>) -> vec3<f32> {
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
  let e = direct_light(hp, n) + volume_light(air, face);
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
  let l = vec3<i32>(i32(lid & 3u), i32((lid >> 2u) & 3u), i32(lid >> 4u));
  let c = b.xyz * 4 + l;
  let at = pool_at(u32(b.w), lid, face);
  if (!volume_holds(c)) {
    textureStore(pool, at, vec4<u32>(0u));
    return;
  }
  let axis = face >> 1u;
  let sgn = select(1.0, -1.0, (face & 1u) == 1u);
  let t1 = (axis + 1u) % 3u;
  let t2 = (axis + 2u) % 3u;
  let origin = (vec3<f32>(c) + 0.5) * CELL_M;
  let rays = u32(params.dims.w);
  let h = hash3(c, face);
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
    sum = sum + ray_radiance(origin, normalize(d));
  }
  let est = sum * (PI / f32(max(rays, 1u)));
  let old = textureLoad(pool, at).x;
  let blend = bitcast<f32>(info.x);
  var v = est;
  if (old != 0u && blend < 1.0) { v = mix(volume_decode(old), est, blend); }
  textureStore(pool, at, vec4<u32>(volume_encode(v), 0u, 0u, 0u));
}
`;

/** Steps a walk of the update may take at most (the walk's own). */
export const VOLUME_WALK_STEPS = WALK_GPU_MAX_STEPS;
