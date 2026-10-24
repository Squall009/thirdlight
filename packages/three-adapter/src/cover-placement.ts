/**
 * Ground cover on the GPU: where its copies go, decided per copy from
 * numbers the GPU has (`cover-gpu.ts` runs the same arithmetic in its vertex
 * stage; this module is that arithmetic on the CPU, which plans the draws and
 * is the reference the tests hold the shader's maths to).
 *
 * A cover rule's reach is cut into rings round the view's eye at the
 * model's own level switches, so each ring draws one level of the model,
 * and from where the copies start to thin, each ring reaching √2 times as
 * far as the one before. A ring lays a square grid of candidate cells over the
 * ground at the density its inner edge needs, grouped into square patches
 * (a few hundred candidates each) that never straddle a terrain tile. The
 * patches of a ring in view are listed in a small texture each frame (their
 * first cell and their tile's texture layer); one instanced draw per ring
 * and mesh draws every candidate of every listed patch. A candidate's
 * place, turn, size and whether it is kept come from a hash of its global
 * cell and the rule's seed, and from the terrain's height and layer
 * texels: no copy is stored, and nothing per frame grows with their number.
 *
 * Thinning: every copy is kept until the last 40 % of the reach, over which
 * they fade to nothing, never below the rule's `densityMin` (as the cover
 * made on the CPU thins). A rule with `densityStart` (a screen size, as the
 * stored scatter's falloff) keeps every copy only out to where its model
 * covers that size, and past it a share falling as the square of distance
 * (the copies a pixel sees stay about the same). A candidate is kept where its random
 * threshold is below the share, so copies leave one by one as the eye goes
 * away (no popping).
 *
 * Pure.
 */
import { copyRotation, ruleNoise, ruleRangeAt, type ScatterRule } from '@thirdlight/runtime';

/** Where a rule's copies begin to fade out at the end of their reach, as a share of it. */
export const COVER_FADE_START = 0.6;
/** Candidates a patch is cut to hold (about: whole cells, a tile divided evenly). */
export const COVER_PATCH_CANDIDATES = 512;
/** A ring's patches across its diameter at most (larger patches far out, where copies are sparse). */
export const COVER_RING_PATCHES_ACROSS = 48;
/** A ring past the first reaches this many times as far as its inner edge (more rings: less shading of candidates thinned away). */
export const COVER_RING_GROWTH = Math.SQRT2;
/** Cuts closer than this share of their distance to the one before are left out (no sliver of a ring). */
const COVER_RING_MIN_SHARE = 0.1;
/** A surface steeper than this (normal Y) takes no copy (a wall), as the stored scatter's. */
export const COVER_MIN_NORMAL_Y = 0.05;
/** Random lanes a candidate reads: jitter x, jitter z, scale, turn, keep. */
export const COVER_LANES = Object.freeze({ jx: 0, jz: 1, scale: 2, yaw: 3, keep: 4 });
/** Lanes a ring's candidates use (ring k reads lanes from k times this): rings never share their numbers. */
const LANES_PER_RING = 8;

/**
 * The integer hash every candidate's numbers come from (as the brushes',
 * `brushHash`), its top 24 bits as a share in [0, 1): a float holds them
 * exactly, so the shader's answer is this one's to the bit.
 */
export function coverRandom(seed: number, ix: number, iz: number, lane: number): number {
  let h = (seed | 0) ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(lane + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** `t` eased (smoothstep), clamped to [0, 1]. */
const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** How a rule's copies thin with distance (metres from the eye across the ground). */
export interface CoverThinning {
  /** Every candidate kept out to here. */
  readonly full: number;
  /** None past here. */
  readonly reach: number;
  /** The least share kept short of the reach. */
  readonly min: number;
}

/** The share of candidates kept at distance `d`. */
export function coverShare(t: CoverThinning, d: number): number {
  if (d >= t.reach) return 0;
  const screen = d <= t.full ? 1 : (t.full / d) ** 2;
  const from = t.reach * COVER_FADE_START;
  const fade = 1 - ease((d - from) / (t.reach - from));
  return Math.max(t.min, screen * fade);
}

/** The model's levels as cover draws them: the first LOD's switch distances (level l from `distances[l]`, metres at scale 1), whether its last level is "nothing", and its radius. */
export interface CoverModelLevels {
  readonly distances: readonly number[];
  readonly culls: boolean;
  readonly radius: number;
}

/** One ring of a rule's cover: what one draw per mesh draws. */
export interface CoverRing {
  readonly inner: number;
  readonly outer: number;
  /** The model level it draws. */
  readonly level: number;
  /** Its share at the inner edge (the most it keeps): the grid's density is the rule's times this. */
  readonly gridShare: number;
  /** Patch side (m; a tile holds a whole number of them), candidate cells along it, and per patch. */
  readonly patch: number;
  readonly side: number;
  readonly perPatch: number;
  /** Patches a view can list at most (the patch texture's size). */
  readonly maxPatches: number;
  /** Its first random lane. */
  readonly lanes: number;
}

export interface CoverPlan {
  readonly thinning: CoverThinning;
  readonly rings: readonly CoverRing[];
}

/** The level a model shows at distance `d` (its switch distances already in metres). */
function levelAt(distances: readonly number[], d: number): number {
  let level = 0;
  for (let l = 1; l < distances.length; l++) if (d >= distances[l]!) level = l;
  return level;
}

/**
 * Plan a rule's rings: `reach` its cover distance (m), `tile` the terrain
 * tile's side (m), `bias` the LOD bias the model's switches are scaled by,
 * `screenFull` the distance its `densityStart` screen size sets (absent:
 * none).
 */
export function planCover(rule: Pick<ScatterRule, 'density' | 'densityMin' | 'scale'>, reach: number, model: CoverModelLevels, tile: number, bias = 1, screenFull?: number): CoverPlan {
  const sc = rule.scale ?? [1, 1];
  const size = (sc[0] + sc[1]) / 2;
  // Switch distances in metres for a copy of the rule's mean size.
  let switches = model.distances.map((d) => d * bias * size);
  let end = reach;
  if (model.culls && switches.length > 1) {
    end = Math.min(end, switches[switches.length - 1]!);
    switches = switches.slice(0, -1);
  }
  // Every candidate kept to the fade unless the rule's `densityStart` thins them by screen size from nearer.
  const full = Math.min(end, screenFull ?? end);
  const thinning: CoverThinning = { full: Math.max(full, 1e-3), reach: end, min: Math.min(1, Math.max(0, rule.densityMin ?? 0)) };
  // The model's switches cut the rings first; then cuts growing from where copies start to thin, unless one is close.
  const cuts: number[] = [0, end, ...switches.filter((d) => d > 0 && d < end)];
  const near = (c: number): boolean => cuts.some((k) => Math.abs(k - c) <= COVER_RING_MIN_SHARE * c);
  for (let d = Math.min(thinning.full, end * COVER_FADE_START); d < end; d *= COVER_RING_GROWTH) if (!near(d)) cuts.push(d);
  const sorted: number[] = [];
  for (const c of [...new Set(cuts)].sort((a, b) => a - b)) {
    const last = sorted[sorted.length - 1];
    if (last === undefined || c - last > COVER_RING_MIN_SHARE * c) sorted.push(c);
    else if (c === end && last > 0) sorted[sorted.length - 1] = end;
  }
  const rings: CoverRing[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    const inner = sorted[k]!;
    const outer = sorted[k + 1]!;
    const gridShare = coverShare(thinning, inner);
    const density = rule.density * gridShare;
    if (density <= 0) continue;
    const want = Math.max(Math.sqrt(COVER_PATCH_CANDIDATES / density), (2 * outer) / COVER_RING_PATCHES_ACROSS);
    const patch = tile / Math.max(1, Math.round(tile / want));
    const side = Math.max(1, Math.round(patch * Math.sqrt(density)));
    const across = Math.ceil((2 * outer) / patch) + 1;
    rings.push({ inner, outer, level: levelAt(switches, inner), gridShare, patch, side, perPatch: side * side, maxPatches: across * across, lanes: rings.length * LANES_PER_RING });
  }
  return { thinning, rings };
}

/** One listed patch: its first candidate cell (global, the ring's grid) and its tile's texture layer. */
export interface CoverPatch {
  gx: number;
  gz: number;
  layer: number;
}

/** A tile a patch lies on: its texture page and layer (-1: not drawn yet), and the heights' range under the patch (metres, the terrain's frame). */
export interface CoverTileRef {
  readonly page: number;
  readonly layer: number;
  readonly low: number;
  readonly high: number;
}

/**
 * The patches of `ring` round `eye` (x, z in the terrain's frame) that meet
 * its annulus, lie on a drawn tile and pass `visible` (a sphere in the
 * terrain's frame: centre x, y, z and radius), by page. `tileAt(tx, tz)`
 * names the tile and the heights under a box of it (tile-local); `tile` is
 * its side (m); `rise` how far a copy stands above the ground (m).
 */
export function listCoverPatches(ring: CoverRing, eye: readonly [number, number], tile: number, rise: number, tileAt: (tx: number, tz: number, x0: number, z0: number, x1: number, z1: number) => CoverTileRef | undefined, visible: (x: number, y: number, z: number, r: number) => boolean, out: Map<number, CoverPatch[]>): void {
  const P = ring.patch;
  const per = Math.round(tile / P);
  const R = ring.outer;
  const [cx, cz] = eye;
  for (let pz = Math.floor((cz - R) / P); pz <= Math.floor((cz + R) / P); pz++) {
    for (let px = Math.floor((cx - R) / P); px <= Math.floor((cx + R) / P); px++) {
      const x0 = px * P;
      const z0 = pz * P;
      const nx = Math.max(x0, Math.min(cx, x0 + P)) - cx;
      const nz = Math.max(z0, Math.min(cz, z0 + P)) - cz;
      const fx = Math.max(Math.abs(x0 - cx), Math.abs(x0 + P - cx));
      const fz = Math.max(Math.abs(z0 - cz), Math.abs(z0 + P - cz));
      if (nx * nx + nz * nz >= R * R || fx * fx + fz * fz < ring.inner * ring.inner) continue;
      const tx = Math.floor(px / per);
      const tz = Math.floor(pz / per);
      const t = tileAt(tx, tz, x0 - tx * tile, z0 - tz * tile, x0 + P - tx * tile, z0 + P - tz * tile);
      if (t === undefined || t.layer < 0) continue;
      const half = (t.high - t.low) / 2 + rise;
      if (!visible(x0 + P / 2, (t.low + t.high) / 2 + rise / 2, z0 + P / 2, Math.sqrt((P * P) / 2 + half * half))) continue;
      let list = out.get(t.page);
      if (list === undefined) out.set(t.page, (list = []));
      list.push({ gx: px * ring.side, gz: pz * ring.side, layer: t.layer });
    }
  }
}

/** The constants a rule's candidates read (the shader's are compiled in). */
export interface CoverRuleConsts {
  readonly seed: number;
  readonly density: number;
  readonly scale: readonly [number, number];
  readonly yaw: number;
  readonly align: number;
  readonly sink: number;
  readonly rule: Pick<ScatterRule, 'height' | 'slope' | 'noise' | 'layers'>;
}

/** A tile's texels as the GPU holds them (RGBA8, `terrain-texels.ts`), its samples a side, and the terrain's shape. */
export interface CoverTexels {
  readonly samples: number;
  readonly spacing: number;
  /** Height of step 0 and of one step (m). */
  readonly low: number;
  readonly step: number;
  readonly heights: Uint8Array;
  readonly layers: Uint8Array;
  readonly indices: Uint8Array;
}

/** One candidate's answer (the terrain's frame; `y` the ground less the sink). */
export interface CoverCandidate {
  x: number;
  y: number;
  z: number;
  /** The ground's normal, slope (degrees) and how well the conditions hold (0–1). */
  normal: [number, number, number];
  slope: number;
  conditions: number;
  scale: number;
  /** The turn (x, y, z, w). */
  rotation: [number, number, number, number];
  /** Drawn: in the ring, on ground, not a wall, and its threshold under the share. */
  kept: boolean;
}

/**
 * Candidate `i` of a listed patch as the shader decides it: `origin` the
 * terrain object's world position (heights and noise read world metres),
 * `eye` the view's eye in the terrain's frame (x, z), `tileX`/`tileZ` the
 * tile's min corner (the terrain's frame).
 */
export function coverCandidate(i: number, patch: CoverPatch, ring: CoverRing, thinning: CoverThinning, c: CoverRuleConsts, tex: CoverTexels, tileX: number, tileZ: number, origin: readonly number[], eye: readonly [number, number]): CoverCandidate {
  const side = ring.side;
  const gx = patch.gx + (i % side);
  const gz = patch.gz + Math.floor(i / side);
  const r = (lane: number): number => coverRandom(c.seed, gx, gz, ring.lanes + lane);
  const cell = ring.patch / side;
  const x = (gx + r(COVER_LANES.jx)) * cell;
  const z = (gz + r(COVER_LANES.jz)) * cell;
  // The tile's samples: the cell under the point and where in it (as the colliders' triangles).
  const n = tex.samples - 1;
  const u = Math.min(Math.max((x - tileX) / tex.spacing, 0), n);
  const v = Math.min(Math.max((z - tileZ) / tex.spacing, 0), n);
  const ix = Math.min(Math.floor(u), n - 1);
  const iz = Math.min(Math.floor(v), n - 1);
  const fx = u - ix;
  const fz = v - iz;
  const at = (dx: number, dz: number): number => ((iz + dz) * tex.samples + ix + dx) * 4;
  const step = (o: number): number => tex.heights[o]! * 256 + tex.heights[o + 1]!;
  const h00 = step(at(0, 0));
  const h10 = step(at(1, 0));
  const h01 = step(at(0, 1));
  const h11 = step(at(1, 1));
  const s = fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  const ground = tex.low + s * tex.step;
  // The normal: the four samples' filtered.
  const nAt = (o: number, k: number): number => (tex.heights[o + k]! / 255) * 2 - 1;
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  const bil = (k: number): number => mix(mix(nAt(at(0, 0), k), nAt(at(1, 0), k), fx), mix(nAt(at(0, 1), k), nAt(at(1, 1), k), fx), fz);
  const nx0 = bil(2);
  const nz0 = bil(3);
  const ny0 = Math.sqrt(Math.max(1 - nx0 * nx0 - nz0 * nz0, 0.0001));
  const len = Math.hypot(nx0, ny0, nz0);
  const normal: [number, number, number] = [nx0 / len, ny0 / len, nz0 / len];
  const slope = (Math.acos(Math.min(1, normal[1])) * 180) / Math.PI;
  // The nearest sample's layer shares; the hole of the cell under the point.
  const near = (Math.min(Math.floor(v + 0.5), n) * tex.samples + Math.min(Math.floor(u + 0.5), n)) * 4;
  const hole = tex.layers[at(0, 0) + 3]! >= 128;
  const w = [tex.layers[near]! / 255, tex.layers[near + 1]! / 255, tex.layers[near + 2]! / 255];
  const weights = [w[0]!, w[1]!, w[2]!, Math.max(1 - w[0]! - w[1]! - w[2]!, 0)];
  const share = (layer: number): number => {
    let sum = 0;
    for (let k = 0; k < 4; k++) if (tex.indices[near + k] === layer) sum += weights[k]!;
    return sum;
  };
  const wy = origin[1]! + ground;
  let f = 1;
  const rule = c.rule;
  if (rule.height !== undefined) f *= ruleRangeAt(rule.height, wy);
  if (rule.slope !== undefined) f *= ruleRangeAt(rule.slope, slope);
  if (rule.noise !== undefined) {
    const k = rule.noise.scale;
    f *= ruleRangeAt(rule.noise, ruleNoise((origin[0]! + x) / k, wy / k, (origin[2]! + z) / k, rule.noise.seed ?? 0));
  }
  for (const l of rule.layers ?? []) f *= ruleRangeAt(l, share(l.layer));
  const d = Math.hypot(x - eye[0], z - eye[1]);
  const inRing = d >= ring.inner && d < ring.outer;
  const odds = (f * coverShare(thinning, d)) / ring.gridShare;
  const kept = inRing && !hole && normal[1] > COVER_MIN_NORMAL_Y && r(COVER_LANES.keep) < odds;
  const scale = c.scale[0] + r(COVER_LANES.scale) * (c.scale[1] - c.scale[0]);
  const rotation = copyRotation(normal[0], normal[1], normal[2], c.align, r(COVER_LANES.yaw) * c.yaw) as [number, number, number, number];
  return { x, y: ground - c.sink, z, normal, slope, conditions: f, scale, rotation, kept };
}

/** Whether a cover rule can be drawn on the GPU (what it reads, the shader reads): no spacing, cavity, regions or blob shadows. */
export function coverOnGpu(rule: ScatterRule): boolean {
  return (rule.spacing ?? 0) <= 0 && rule.cavity === undefined && (rule.exclude ?? []).length === 0 && rule.blobShadow === undefined && rule.blocks === undefined && rule.meta === undefined;
}
