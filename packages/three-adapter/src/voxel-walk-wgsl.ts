/**
 * The occupancy walk in WGSL (`@thirdlight/voxel` occupancy-walk.ts on the
 * GPU), over the walk's blocks as the page mirrors them
 * (voxel-walk-gpu.ts: the table and the pages of `@thirdlight/voxel`
 * walk-pages.ts, as storage buffers).
 *
 * One definition: the crossing time, the first of three crossings and the
 * order of two crossings are written from the same `ScalarOps` steps the
 * CPU walk runs (walk-steps.ts, through `wgslScalarWriter`); the loop, the
 * box crossings and the lookups below are the CPU walk's, step for step,
 * and the page's check runs both on the same rays and compares every hit.
 *
 * A compute pass that walks rays includes {@link voxelWalkWgsl}'s text
 * (its bindings at the group and numbers it names) and calls
 * `voxel_walk(cell, frac, inv, max_t, stop, max_level)`:
 * - `cell` (vec3<i32>) the ray's first level-0 cell, `frac` (vec3<f32>,
 *   0 ≤ frac < 1) its place in it, `inv` (vec3<f32>) metres a level-0 cell
 *   along each axis (0.5 ÷ the direction's part; ±1e30 along an axis it
 *   does not move on; `voxel_walk_ray(origin_m, dir)` makes all three from
 *   a point and a direction), `max_t` metres, `stop` 0 solid / 1 light,
 *   `max_level` the coarsest level the table holds;
 * - it answers a `VoxelWalkHit`: `end` (0 past `max_t`, 1 hit, 2 left the
 *   world, 3 out of steps), `t` metres, `cell` the level-0 cell, `axis`
 *   the axis it entered by (−1: it started inside; the face's normal is
 *   −sign(inv) on that axis), `level`, `steps` and, for the light stop,
 *   `trans`: what the partly covered cells it crossed let on (the CPU walk's
 *   rule: a block's cover, 1 − step / 15 a cell entered by a face; spent
 *   under 1/256: a hit with 0).
 * Where no level knows a place the walk passes as through air (the far
 * field's bricks are not walked on the GPU yet).
 */
import { wgslScalarWriter } from '@thirdlight/shared';
import { WALK_BRICK_WORDS, WALK_CELL_WORDS, WALK_COVER_STEPS, WALK_EMPTY_KEY, WALK_INV_NONE, WALK_MAX_PROBES, WALK_PAGE_WORDS, WALK_SPENT, walkBeforeSteps, walkCrossSteps, walkFirstSteps } from '@thirdlight/voxel';

/** Steps a GPU walk takes at most (a block, a brick or a cell crossed is one). */
export const WALK_GPU_MAX_STEPS = 4096;

/** A step function as WGSL (every argument an `f32`): its `let`s from steps written over `ScalarOps` and the value it returns. */
export function wgslStepFn(name: string, args: readonly string[], ret: string, body: (w: ReturnType<typeof wgslScalarWriter>) => string): string {
  const w = wgslScalarWriter('v');
  const out = body(w);
  return `fn ${name}(${args.map((a) => `${a}: f32`).join(', ')}) -> ${ret} {\n  ${w.lines.join('\n  ')}\n  return ${out};\n}`;
}

/** The walk's shared steps in WGSL. */
export function walkStepsWgsl(): string {
  return [
    wgslStepFn('walk_cross', ['rel', 'frac', 'inv'], 'f32', (w) => walkCrossSteps(w.ops, 'rel', 'frac', 'inv')),
    wgslStepFn('walk_first', ['tx', 'ty', 'tz'], 'vec2<f32>', (w) => {
      const f = walkFirstSteps(w.ops, 'tx', 'ty', 'tz');
      return `vec2<f32>(${f.t}, ${f.axis})`;
    }),
    wgslStepFn('walk_before', ['ta', 'a', 'tb', 'b'], 'f32', (w) => walkBeforeSteps(w.ops, 'ta', 'a', 'tb', 'b')),
  ].join('\n\n');
}

/** Where the walk's two buffers are bound in the pass that includes it. */
export interface VoxelWalkBindings {
  readonly group: number;
  readonly table: number;
  readonly pages: number;
}

/** The walk's WGSL: its buffers, steps and `voxel_walk` (see the module's comment). */
export function voxelWalkWgsl(b: VoxelWalkBindings): string {
  return /* wgsl */ `
@group(${b.group}) @binding(${b.table}) var<storage, read> walk_table: array<vec4<u32>>;
@group(${b.group}) @binding(${b.pages}) var<storage, read> walk_pages: array<u32>;

const WALK_NONE: u32 = 0xffffffffu;
const WALK_EMPTY_KEY: u32 = ${WALK_EMPTY_KEY}u;
const WALK_MAX_PROBES: u32 = ${WALK_MAX_PROBES}u;
const WALK_PAGE_WORDS: u32 = ${WALK_PAGE_WORDS}u;
const WALK_BRICK_WORDS: u32 = ${WALK_BRICK_WORDS}u;
const WALK_CELL_WORDS: u32 = ${WALK_CELL_WORDS}u;
const WALK_MAX_STEPS: u32 = ${WALK_GPU_MAX_STEPS}u;
const WALK_COVER_STEPS: f32 = ${WALK_COVER_STEPS}.0;
const WALK_SPENT: f32 = ${WALK_SPENT};

struct VoxelWalkHit {
  end: u32,
  t: f32,
  cell: vec3<i32>,
  axis: i32,
  level: u32,
  steps: u32,
  trans: f32,
}

${walkStepsWgsl()}

fn walk_hash(k0: u32, k1: u32, mask: u32) -> u32 {
  var h = (k0 * 0x9e3779b1u) ^ (k1 * 0x85ebca77u);
  h = h ^ (h >> 15u);
  return h & mask;
}

/** A block's value and cover (its first page slot + 1, 0: none) in the table (WALK_NONE: not held). */
fn walk_entry(level: u32, b: vec3<i32>) -> vec2<u32> {
  let k0 = (u32(b.x + 32768) & 0xffffu) | ((u32(b.z + 32768) & 0xffffu) << 16u);
  let k1 = (u32(b.y + 32768) & 0xffffu) | (level << 16u);
  let mask = arrayLength(&walk_table) - 1u;
  var i = walk_hash(k0, k1, mask);
  for (var p = 0u; p < WALK_MAX_PROBES; p++) {
    let e = walk_table[i];
    if (e.y == WALK_EMPTY_KEY) { return vec2<u32>(WALK_NONE, 0u); }
    if (e.y == k1 && e.x == k0) { return e.zw; }
    i = (i + 1u) & mask;
  }
  return vec2<u32>(WALK_NONE, 0u);
}

/** A block's value in the table (WALK_NONE: not held). */
fn walk_value(level: u32, b: vec3<i32>) -> u32 {
  return walk_entry(level, b).x;
}

/** The coverage step (0 … 15) of cell ci of a block whose cover starts at word w. */
fn walk_cover_step(w: u32, ci: u32) -> u32 {
  return (walk_pages[w + WALK_BRICK_WORDS + (ci >> 3u)] >> ((ci & 7u) * 4u)) & 15u;
}

fn walk_bit(word: u32, i: u32) -> bool {
  return ((walk_pages[word + (i >> 5u)] >> (i & 31u)) & 1u) == 1u;
}

/** The time the ray crosses the face out of a cell of a level along an axis. */
fn walk_cross_out(o: vec3<i32>, frac: vec3<f32>, inv: vec3<f32>, s: vec3<i32>, a: u32, cell: i32, level: u32) -> f32 {
  let face = select(cell, cell + 1, s[a] > 0);
  return walk_cross(f32(face * (1 << level) - o[a]), frac[a], inv[a]);
}

/** How many of the faces out of cells start, start + s, … (at most "most" of them) the ray crosses along a before (t, axis). */
fn walk_crossed_before(o: vec3<i32>, frac: vec3<f32>, inv: vec3<f32>, s: vec3<i32>, a: u32, start: i32, most: i32, level: u32, t: f32, axis: f32) -> i32 {
  var lo = 0;
  var hi = most;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi + 1) >> 1u;
    if (walk_before(walk_cross_out(o, frac, inv, s, a, start + s[a] * (mid - 1), level), f32(a), t, axis) == 1.0) { lo = mid; } else { hi = mid - 1; }
  }
  return lo;
}

/** The level-0 cell just after the crossing (t, axis) into cell c of a level. */
fn walk_level_zero(o: vec3<i32>, frac: vec3<f32>, inv: vec3<f32>, s: vec3<i32>, c: vec3<i32>, level: u32, t: f32, axis: i32) -> vec3<i32> {
  if (level == 0u) { return c; }
  let span = 1 << level;
  var out = c;
  for (var a = 0u; a < 3u; a++) {
    let first = select((c[a] + 1) * span - 1, c[a] * span, s[a] > 0);
    if (i32(a) == axis) { out[a] = first; continue; }
    let start = select(min(first, o[a]), max(first, o[a]), s[a] > 0);
    let last = select(c[a] * span, (c[a] + 1) * span - 1, s[a] > 0);
    out[a] = start + s[a] * walk_crossed_before(o, frac, inv, s, a, start, abs(last - start), 0u, t, f32(axis));
  }
  return out;
}

fn walk_in_world(c: vec3<i32>) -> bool {
  return c.x >= -32768 && c.x <= 32767 && c.z >= -32768 && c.z <= 32767 && c.y >= -8192 && c.y <= 8191;
}

/** A ray from a point (metres) along a direction (unit): its first cell, place in it and metres a cell. */
fn voxel_walk_ray(origin_m: vec3<f32>, dir: vec3<f32>, cell: ptr<function, vec3<i32>>, frac: ptr<function, vec3<f32>>, inv: ptr<function, vec3<f32>>) {
  let p = origin_m / 0.5;
  let c = floor(p);
  *cell = vec3<i32>(c);
  *frac = clamp(p - c, vec3<f32>(0.0), vec3<f32>(0.99999994));
  for (var a = 0u; a < 3u; a++) {
    (*inv)[a] = select(0.5 / dir[a], ${WALK_INV_NONE.toExponential()}, abs(dir[a]) < 1e-20);
  }
}

fn voxel_walk(o: vec3<i32>, frac: vec3<f32>, inv: vec3<f32>, max_t: f32, stop: u32, max_level: u32) -> VoxelWalkHit {
  let s = vec3<i32>(select(1, -1, inv.x < 0.0), select(1, -1, inv.y < 0.0), select(1, -1, inv.z < 0.0));
  var level = 0u;
  var c = o;
  var b = o >> vec3<u32>(5u);
  var value = WALK_NONE;
  var cover = 0u;
  var t = 0.0;
  var axis = -1;
  var c0 = o;
  var trans = 1.0;
  // The finest level that knows the block holding c0.
  for (var l = 0u; l <= max_level; l++) {
    let cl = c0 >> vec3<u32>(l);
    let v = walk_entry(l, cl >> vec3<u32>(5u));
    if (v.x != WALK_NONE) { level = l; c = cl; b = cl >> vec3<u32>(5u); value = v.x; cover = v.y * stop; break; }
  }
  for (var steps = 1u; steps <= WALK_MAX_STEPS; steps++) {
    if (t > max_t) { return VoxelWalkHit(0u, t, c0, axis, level, steps, trans); }
    if (!walk_in_world(c0)) { return VoxelWalkHit(2u, t, c0, axis, level, steps, trans); }
    var box = 32;
    var shift = 5u;
    if (value != WALK_NONE) {
      let flag = (value >> (2u * stop)) & 3u;
      let local = c - b * 32;
      let bi = u32(((local.x >> 2u) * 8 + (local.z >> 2u)) * 8 + (local.y >> 2u));
      let ci = u32((local.x * 32 + local.z) * 32 + local.y);
      let page = (value >> 4u) * WALK_PAGE_WORDS;
      // A brick holding partly covered cells the light stop passes is walked cell by cell (the CPU walk's order).
      let cw = (cover - 1u) * WALK_PAGE_WORDS;
      let part = cover != 0u && flag != 1u && walk_bit(cw, bi);
      if (flag == 1u) { box = -1; }
      else if (part) {
        if (flag == 2u && walk_bit(page + 2u * WALK_BRICK_WORDS + stop * WALK_CELL_WORDS, ci)) { box = -1; }
        else { box = 1; shift = 0u; }
      }
      else if (flag == 0u && cover != 0u) { box = 4; shift = 2u; }
      else if (flag == 2u) {
        if (!walk_bit(page + stop * WALK_BRICK_WORDS, bi)) { box = 4; shift = 2u; }
        else if (walk_bit(page + 2u * WALK_BRICK_WORDS + stop * WALK_CELL_WORDS, ci)) { box = -1; }
        else { box = 1; shift = 0u; }
      }
      // A partly covered cell entered by a face takes its share of what the ray carries (the first cell is the ray's own).
      if (part && box == 1 && axis >= 0) {
        let q = walk_cover_step(cw, ci);
        if (q != 0u) {
          trans = trans * (1.0 - f32(q) / WALK_COVER_STEPS);
          if (trans < WALK_SPENT) {
            var spent = c;
            if (level > 0u) { spent = walk_level_zero(o, frac, inv, s, c, level, t, axis); }
            return VoxelWalkHit(1u, max(t, 0.0), spent, axis, level, steps, 0.0);
          }
        }
      }
    }
    if (box < 0) {
      var cell = c;
      if (level > 0u) { cell = select(walk_level_zero(o, frac, inv, s, c, level, t, axis), o, axis < 0); }
      return VoxelWalkHit(1u, max(t, 0.0), cell, axis, level, steps, trans);
    }
    // Leave the box: the crossing out of it first in ray order, and the cell after it on every axis.
    let lo = (c >> vec3<u32>(shift)) << vec3<u32>(shift);
    let hi = lo + vec3<i32>(box - 1);
    let m = select(lo, hi, s > vec3<i32>(0));
    let first = walk_first(walk_cross_out(o, frac, inv, s, 0u, m.x, level), walk_cross_out(o, frac, inv, s, 1u, m.y, level), walk_cross_out(o, frac, inv, s, 2u, m.z, level));
    let x = u32(first.y);
    for (var a = 0u; a < 3u; a++) {
      if (a == x) { continue; }
      let most = abs(m[a] - c[a]);
      if (most > 0) { c[a] = c[a] + s[a] * walk_crossed_before(o, frac, inv, s, a, c[a], most, level, first.x, first.y); }
    }
    c[x] = m[x] + s[x];
    t = first.x;
    axis = i32(x);
    if (all((c >> vec3<u32>(5u)) == b)) { continue; }
    c0 = walk_level_zero(o, frac, inv, s, c, level, t, axis);
    level = 0u;
    c = c0;
    b = c0 >> vec3<u32>(5u);
    value = WALK_NONE;
    cover = 0u;
    for (var l = 0u; l <= max_level; l++) {
      let cl = c0 >> vec3<u32>(l);
      let v = walk_entry(l, cl >> vec3<u32>(5u));
      if (v.x != WALK_NONE) { level = l; c = cl; b = cl >> vec3<u32>(5u); value = v.x; cover = v.y * stop; break; }
    }
  }
  return VoxelWalkHit(3u, t, c0, axis, level, WALK_MAX_STEPS, trans);
}
`;
}
