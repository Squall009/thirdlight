/**
 * Glowing faces as emitters the light volume's cells aim at (next-event estimation), so a small glow is found by
 * every update instead of by the few rays that happen to meet it.
 *
 * Per kept level-0 brick, the glowing faces whose open cells lie in it, grouped by the way they face: each group one
 * rectangle in the volume's lamp table (`VOLUME_LAMP_FLOATS` words, a rect area light facing out of the solid, its
 * kind field marked {@link VOLUME_GLOW_EMITTER}), over the faces' bounding rectangle in their mean plane, its radiance
 * the faces' power spread over it (Σ L A / the rectangle's area: a strip, a block's face or a panel's part is exact,
 * an L of faces spreads its light over its box), listed by the bricks it reaches as any lamp. Its brick (the open
 * cells' level-0 brick, each axis modulo 256) rides the word a spot keeps its outer cone in.
 *
 * In the update a cell adds each emitter on its own brick's list (π L × the form factor to its face, exact: the
 * rectangle clipped to the face's horizon, as an emitter beside a cell often crosses it; behind a walk to a point of
 * the rectangle its sequence picks), and its rays leave out the glow they meet at an open cell of a brick
 * so listed: each glow is counted once, by its emitter where the list holds it and by the rays where it does not (a
 * list full of stronger lamps). A ray's hit is not lit by an emitter (a hit's light from a glow is the volume's own
 * light in its cell, which the emitters fill).
 */
import { CLUSTER_RECT } from './cluster-build';
import { VolumeColourCache, type VolumeChunkGrid } from './voxel-light-volume-colours';
import { VOLUME_BRICK_CELLS, VOLUME_GLOW_EMITTER, VOLUME_LAMP_FLOATS } from './voxel-light-volume-layout';

const EDGE = 32;
const SIDE = EDGE + 2;
const CELL_M = 0.5;
/** Each face of an open cell: the way to the solid cell across it, and the face index (+X, −X, +Y, −Y, +Z, −Z) of the emitter's facing (out of the solid, toward the open cell). */
const ACROSS: readonly (readonly [number, number, number, number])[] = [[1, 0, 0, 1], [-1, 0, 0, 0], [0, 1, 0, 3], [0, -1, 0, 2], [0, 0, 1, 5], [0, 0, -1, 4]];

/** A brick's key in an emitter's record: its level-0 brick, each axis modulo 256 (exact in an f32). */
export function volumeGlowBrickKey(bx: number, by: number, bz: number): number {
  return (bx & 255) | ((by & 255) << 8) | ((bz & 255) << 16);
}

/**
 * The emitters of level-0 brick (bx, by, bz) from the grid of the chunk holding it (`VOLUME_LAMP_FLOATS` words each;
 * none: an empty array). `reach`: metres past which an emitter lists no brick and lights no cell (its window).
 */
export function volumeBrickEmitters(bx: number, by: number, bz: number, grids: ReadonlyMap<string, VolumeChunkGrid>, colours: VolumeColourCache, reach: number): Float32Array {
  const c = [Math.floor((bx * VOLUME_BRICK_CELLS) / EDGE), Math.floor((by * VOLUME_BRICK_CELLS) / EDGE), Math.floor((bz * VOLUME_BRICK_CELLS) / EDGE)];
  const grid = grids.get(`${c[0]},${c[1]},${c[2]}`);
  if (grid === undefined || typeof grid === 'number') return new Float32Array(0);
  const at = (lx: number, ly: number, lz: number): number => grid[((lx + 1) * SIDE + (lz + 1)) * SIDE + (ly + 1)]!;
  // Per facing: the faces' power (rgb × area), their bounds across (cells), their plane (summed metres) and count.
  const groups = new Map<number, { p: number[]; lo: number[]; hi: number[]; plane: number; n: number }>();
  for (let z = 0; z < VOLUME_BRICK_CELLS; z++) for (let y = 0; y < VOLUME_BRICK_CELLS; y++) for (let x = 0; x < VOLUME_BRICK_CELLS; x++) {
    const w = [bx * VOLUME_BRICK_CELLS + x, by * VOLUME_BRICK_CELLS + y, bz * VOLUME_BRICK_CELLS + z];
    const l = [w[0]! - c[0]! * EDGE, w[1]! - c[1]! * EDGE, w[2]! - c[2]! * EDGE];
    if (at(l[0]!, l[1]!, l[2]!) !== 0) continue;
    for (const [dx, dy, dz, face] of ACROSS) {
      const e = at(l[0]! + dx, l[1]! + dy, l[2]! + dz);
      if (e === 0) continue;
      const g = colours.glow(e);
      if (g === null) continue;
      const axis = face >> 1;
      let k = groups.get(face);
      if (k === undefined) groups.set(face, (k = { p: [0, 0, 0], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], plane: 0, n: 0 }));
      for (let ch = 0; ch < 3; ch++) k.p[ch]! += g[ch]! * CELL_M * CELL_M;
      for (let a = 0; a < 3; a++) {
        k.lo[a] = Math.min(k.lo[a]!, w[a]!);
        k.hi[a] = Math.max(k.hi[a]!, w[a]!);
      }
      // The face lies between the open cell and the solid one.
      k.plane += (w[axis]! + ([dx, dy, dz][axis]! > 0 ? 1 : 0)) * CELL_M;
      k.n++;
    }
  }
  const out = new Float32Array(groups.size * VOLUME_LAMP_FLOATS);
  let i = 0;
  for (const [face, k] of groups) {
    const axis = face >> 1;
    const sgn = (face & 1) === 1 ? -1 : 1;
    const t1 = (axis + 1) % 3;
    const t2 = (axis + 2) % 3;
    const hu = ((k.hi[t1]! - k.lo[t1]! + 1) * CELL_M) / 2;
    const hv = ((k.hi[t2]! - k.lo[t2]! + 1) * CELL_M) / 2;
    const centre = [0, 0, 0];
    centre[axis] = k.plane / k.n;
    centre[t1] = (k.lo[t1]! * CELL_M + (k.hi[t1]! + 1) * CELL_M) / 2;
    centre[t2] = (k.lo[t2]! * CELL_M + (k.hi[t2]! + 1) * CELL_M) / 2;
    const o = i * VOLUME_LAMP_FLOATS;
    // The record as an area light's: place and reach; its power over the rectangle (the update's π × it × the form
    // factor over the area is π L F); its facing and kind; u and v (u × v along the facing: the lit side).
    out.set([centre[0]!, centre[1]!, centre[2]!, reach, k.p[0]!, k.p[1]!, k.p[2]!, 2], o);
    out[o + 8 + axis] = sgn;
    out[o + 11] = CLUSTER_RECT | VOLUME_GLOW_EMITTER;
    out[o + 12 + t1] = hu;
    out[o + 15] = volumeGlowBrickKey(bx, by, bz);
    out[o + 16 + t2] = sgn * hv;
    i++;
  }
  return out;
}

/**
 * The form factor from a point `p` with unit normal `n` to the rectangle centred at `c` with half sides `u`, `v` (lit
 * where u × v points: its back gives none), exact for a Lambertian receiver: the rectangle clipped to the plane
 * through `p` along `n`, then Σ θ_i (n · γ_i) / 2π over its edges (Lambert's polygon formula). The CPU twin of the
 * update's `glow_form_factor`.
 */
export function volumeGlowFormFactor(p: readonly number[], n: readonly number[], c: readonly number[], u: readonly number[], v: readonly number[]): number {
  const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const cross = (a: readonly number[], b: readonly number[]): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const rel = [0, 1, 2].map((k) => p[k]! - c[k]!);
  if (dot(cross(u, v), rel) <= 0) return 0;
  const q = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => [0, 1, 2].map((k) => c[k]! + u[k]! * a! + v[k]! * b! - p[k]!));
  const out: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const da = dot(n, a);
    const db = dot(n, b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * t));
    }
  }
  if (out.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    const b = out[(i + 1) % out.length]!;
    const la = Math.hypot(a[0]!, a[1]!, a[2]!);
    const lb = Math.hypot(b[0]!, b[1]!, b[2]!);
    if (la < 1e-9 || lb < 1e-9) continue;
    const an = a.map((x) => x / la);
    const bn = b.map((x) => x / lb);
    const cr = cross(an, bn);
    const l = Math.hypot(cr[0]!, cr[1]!, cr[2]!);
    if (l < 1e-9) continue;
    sum += Math.acos(Math.min(1, Math.max(-1, dot(an, bn)))) * (dot(cr, n) / l);
  }
  return Math.abs(sum) / (2 * Math.PI);
}

/** The update's `glow_form_factor` (WGSL; the CPU twin is {@link volumeGlowFormFactor}). */
export const VOLUME_GLOW_FORM_FACTOR_WGSL = /* wgsl */ `
fn glow_form_factor(p: vec3<f32>, n: vec3<f32>, c: vec3<f32>, u: vec3<f32>, v: vec3<f32>) -> f32 {
  if (dot(cross(u, v), p - c) <= 0.0) { return 0.0; }
  var q = array<vec3<f32>, 4>(c + u + v - p, c - u + v - p, c - u - v - p, c + u - v - p);
  var o: array<vec3<f32>, 5>;
  var m = 0u;
  for (var i = 0u; i < 4u; i++) {
    let a = q[i];
    let b = q[(i + 1u) % 4u];
    let da = dot(n, a);
    let db = dot(n, b);
    if (da >= 0.0) { o[m] = a; m = m + 1u; }
    if ((da >= 0.0) != (db >= 0.0)) { o[m] = a + (b - a) * (da / (da - db)); m = m + 1u; }
  }
  if (m < 3u) { return 0.0; }
  var sum = 0.0;
  for (var i = 0u; i < m; i++) {
    let a = o[i];
    let b = o[(i + 1u) % m];
    if (length(a) < 1e-9 || length(b) < 1e-9) { continue; }
    let an = normalize(a);
    let bn = normalize(b);
    let cr = cross(an, bn);
    let l = length(cr);
    if (l < 1e-9) { continue; }
    sum = sum + acos(clamp(dot(an, bn), -1.0, 1.0)) * dot(cr, n) / l;
  }
  return abs(sum) / (2.0 * 3.14159265);
}
`;
