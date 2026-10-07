/**
 * Material rules — one rule system that paints terrain and block layers
 * alike from what their surfaces share.
 *
 * A rule names a material layer and the conditions under which it covers
 * the surface: height, slope, cavity, a noise mask, how much of another
 * layer the rules before it left, which way the face looks (top or wall),
 * and for block layers the block type and cell metadata. Each condition is
 * a range with a smooth fade outside it, so rules blend instead of cutting
 * hard edges. Rules apply in order like a layer stack: a rule's share
 * (`strength` × every condition) takes that much of every layer so far and
 * gives it to its own layer; where no rule applies the surface is layer 0.
 *
 * Both sources describe a point the same way ({@link SurfacePoint}): world
 * metres, the slope in degrees, the cavity measured by the source (terrain
 * from its samples, a block layer from its tops), whether it is a wall. So
 * one rule list paints a block area and the terrain round it alike, and a
 * noise mask in world space carries on across the seam.
 *
 * Rules are baked, never evaluated per frame: into a terrain tile's baked
 * weights by its edits (`terrain-rules.ts`), into a block chunk's vertex
 * colours when the chunk is meshed (`block-paint-mesh.ts`). Hand paint is
 * kept apart from them and shown over them, so baking again never loses it.
 *
 * Pure and deterministic: the noise is a lattice hash with products and
 * `Math.floor` only, every other condition plain arithmetic.
 */
import type { ModelErrorV2 } from './errors';
import type { CellMetaValue } from './block-layers';

/** A condition's range: 1 within [min, max] (an absent end is open), fading to 0 over `fade` beyond each end. */
export interface RuleRange {
  min?: number;
  max?: number;
  /** How far past an end the condition fades out (the range's unit; absent or 0: a hard edge). */
  fade?: number;
}

export interface SurfaceRule {
  /** The material layer it paints (block layers: 0-3, the four their paint carries). */
  layer: number;
  /** How much of its layer it gives where every condition holds (0-1; absent: 1). */
  strength?: number;
  /** Only tops or only walls (a face whose box-mapping projection is sideways; terrain is all tops); absent: both. */
  face?: 'top' | 'wall';
  /** World height (metres). */
  height?: RuleRange;
  /** Slope from level (degrees: 0 flat, 90 a wall). */
  slope?: RuleRange;
  /** Cavity (metres): how far the ground `radius` metres around lies above the point — positive in hollows, negative on ridges. */
  cavity?: RuleRange & { radius?: number };
  /** A noise mask (0-1) over world space, its bumps `scale` metres apart. */
  noise?: RuleRange & { scale: number; seed?: number };
  /** The share (0-1) the rules before this one left to `layer` ("where rock is below 0.3"). */
  weight?: RuleRange & { layer: number };
  /** Block layers only: the block types it paints (terrain never matches a rule that names them). */
  blocks?: string[];
  /** Block layers only: cell metadata the cell must hold (its own value or its block type's). */
  meta?: Record<string, CellMetaValue>;
}

/** The layers a rule may name (one byte per layer index, as terrain tiles store them). */
export const SURFACE_RULE_LAYER_MAX = 255;
/** The layers a block layer's paint carries (its vertex colours' four weights). */
export const SURFACE_RULE_BLOCK_LAYERS = 4;
/** Metres a cavity is measured over when a rule names none. */
export const SURFACE_RULE_CAVITY_RADIUS = 2;
/** Bounds of the values a rule holds (dimensions of a value, not counts). */
export const SURFACE_RULE_LIMITS = Object.freeze({ value: 100_000, cavityRadiusMax: 64, noiseScaleMin: 0.01, noiseScaleMax: 100_000 });
/** The rule fields in canonical order. */
export const SURFACE_RULE_FIELDS: readonly string[] = Object.freeze(['layer', 'strength', 'face', 'height', 'slope', 'cavity', 'noise', 'weight', 'blocks', 'meta']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

/** Validate a rule list; `blocks`: a block layer's (layers 0-3, block conditions allowed). */
export function validateSurfaceRules(value: unknown, path: string, errors: ModelErrorV2[], blocks: boolean): void {
  if (!Array.isArray(value)) {
    err(errors, 'field_type', path, 'rules are a list of {layer, strength?, face?, height?, slope?, cavity?, noise?, weight?, blocks?, meta?}', value);
    return;
  }
  const layerMax = blocks ? SURFACE_RULE_BLOCK_LAYERS - 1 : SURFACE_RULE_LAYER_MAX;
  const L = SURFACE_RULE_LIMITS;
  value.forEach((r, i) => {
    const p = `${path}/${i}`;
    if (!isObj(r)) return err(errors, 'field_type', p, 'a rule is an object {layer, …conditions}', r);
    for (const k of Object.keys(r)) if (!SURFACE_RULE_FIELDS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown rule field "${k}"`, k);
    const layer = r['layer'];
    if (!(Number.isInteger(layer) && (layer as number) >= 0 && (layer as number) <= layerMax)) err(errors, 'field_value', `${p}/layer`, blocks ? `layer is 0-${layerMax} (a block layer's paint carries four layers)` : `layer is 0-${layerMax}`, layer);
    const s = r['strength'];
    if (s !== undefined && !(finite(s) && s >= 0 && s <= 1)) err(errors, 'field_value', `${p}/strength`, 'strength is 0-1', s);
    if (r['face'] !== undefined && r['face'] !== 'top' && r['face'] !== 'wall') err(errors, 'field_value', `${p}/face`, 'face is top or wall (absent: both)', r['face']);
    const range = (key: string, extra: (o: Record<string, unknown>, q: string) => void = () => undefined, keys: readonly string[] = []): void => {
      const v = r[key];
      if (v === undefined) return;
      const q = `${p}/${key}`;
      if (!isObj(v)) return err(errors, 'field_type', q, `${key} is {min?, max?, fade?${keys.map((k) => `, ${k}`).join('')}}`, v);
      for (const k of Object.keys(v)) if (!['min', 'max', 'fade', ...keys].includes(k)) err(errors, 'field_unexpected', `${q}/${k}`, `unknown ${key} field "${k}"`, k);
      for (const k of ['min', 'max'] as const) if (v[k] !== undefined && !(finite(v[k]) && Math.abs(v[k] as number) <= L.value)) err(errors, 'field_value', `${q}/${k}`, `${k} is a number within ±${L.value}`, v[k]);
      if (finite(v['min']) && finite(v['max']) && (v['min'] as number) > (v['max'] as number)) err(errors, 'field_value', q, `${key}: min is at most max`, v);
      if (v['fade'] !== undefined && !(finite(v['fade']) && v['fade'] >= 0 && v['fade'] <= L.value)) err(errors, 'field_value', `${q}/fade`, `fade is 0-${L.value}`, v['fade']);
      extra(v, q);
    };
    range('height');
    range('slope');
    range('cavity', (v, q) => {
      if (v['radius'] !== undefined && !(finite(v['radius']) && v['radius'] > 0 && v['radius'] <= L.cavityRadiusMax)) err(errors, 'field_value', `${q}/radius`, `radius is metres in (0, ${L.cavityRadiusMax}]`, v['radius']);
    }, ['radius']);
    range('noise', (v, q) => {
      if (!(finite(v['scale']) && v['scale'] >= L.noiseScaleMin && v['scale'] <= L.noiseScaleMax)) err(errors, 'field_value', `${q}/scale`, `scale is metres, ${L.noiseScaleMin}-${L.noiseScaleMax}`, v['scale']);
      if (v['seed'] !== undefined && !Number.isSafeInteger(v['seed'])) err(errors, 'field_value', `${q}/seed`, 'seed is a whole number', v['seed']);
    }, ['scale', 'seed']);
    range('weight', (v, q) => {
      if (!(Number.isInteger(v['layer']) && (v['layer'] as number) >= 0 && (v['layer'] as number) <= layerMax)) err(errors, 'field_value', `${q}/layer`, `layer is 0-${layerMax}`, v['layer']);
    }, ['layer']);
    if (r['blocks'] !== undefined) {
      if (!blocks) err(errors, 'field_unexpected', `${p}/blocks`, 'blocks are a block layer\'s condition (a terrain has no block types)', r['blocks']);
      else if (!(Array.isArray(r['blocks']) && r['blocks'].every((b) => typeof b === 'string' && b.length >= 1 && b.length <= 64))) err(errors, 'field_value', `${p}/blocks`, 'blocks is a list of block type ids', r['blocks']);
    }
    if (r['meta'] !== undefined) {
      if (!blocks) err(errors, 'field_unexpected', `${p}/meta`, 'meta is a block layer\'s condition (a terrain has no cells)', r['meta']);
      else if (!(isObj(r['meta']) && Object.values(r['meta']).every((m) => typeof m === 'boolean' || typeof m === 'string' || finite(m)))) err(errors, 'field_value', `${p}/meta`, 'meta is {field key: value} (true/false, a number or a string)', r['meta']);
    }
  });
}

/** Rules in canonical form (fields in order, defaults left out). */
export function canonicalSurfaceRules(rules: readonly SurfaceRule[]): SurfaceRule[] {
  const range = <T extends RuleRange>(v: T | undefined, extra: (keyof T)[] = []): T | undefined => {
    if (v === undefined) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of ['min', 'max', ...extra] as string[]) if ((v as Record<string, unknown>)[k] !== undefined) out[k] = (v as Record<string, unknown>)[k];
    if (v.fade !== undefined && v.fade > 0) out['fade'] = v.fade;
    return out as T;
  };
  return rules.map((r) => {
    const out: SurfaceRule = { layer: r.layer };
    if (r.strength !== undefined && r.strength !== 1) out.strength = r.strength;
    if (r.face !== undefined) out.face = r.face;
    const height = range(r.height);
    if (height !== undefined) out.height = height;
    const slope = range(r.slope);
    if (slope !== undefined) out.slope = slope;
    const cavity = range(r.cavity, ['radius']);
    if (cavity !== undefined) out.cavity = cavity;
    const noise = range(r.noise, ['scale', 'seed']);
    if (noise !== undefined) out.noise = noise;
    const weight = range(r.weight, ['layer']);
    if (weight !== undefined) out.weight = weight;
    if (r.blocks !== undefined) out.blocks = [...r.blocks];
    if (r.meta !== undefined) out.meta = { ...r.meta };
    return out;
  });
}

/** One surface point as the rules read it (world metres). */
export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  /** Degrees from level (0 flat, 90 a wall, 180 a ceiling). */
  slope: number;
  /** The face's projection is sideways (a block wall). */
  wall: boolean;
  /** Metres the ground `radius` around lies above the point (asked only when a rule reads it). */
  cavity(radius: number): number;
  /** Block layers: the cell's block type (absent: terrain, or not known). */
  block?: string;
  /** Block layers: a metadata field of the cell (its own, else its block type's). */
  meta?(key: string): CellMetaValue | undefined;
}

/** Sort the first `n` layers strongest first, equal weights by lower layer (insertion sort: a handful of layers). */
function sortLayers(layers: number[], weights: number[], n: number): void {
  for (let i = 1; i < n; i++) {
    const l = layers[i]!;
    const wt = weights[i]!;
    let j = i - 1;
    while (j >= 0 && (weights[j]! < wt || (weights[j] === wt && layers[j]! > l))) {
      layers[j + 1] = layers[j]!;
      weights[j + 1] = weights[j]!;
      j -= 1;
    }
    layers[j + 1] = l;
    weights[j + 1] = wt;
  }
}

/** `t` eased (smoothstep), clamped to [0, 1]. */
function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** A range condition's value at `v` (see {@link RuleRange}). */
export function ruleRangeAt(r: RuleRange, v: number): number {
  const fade = r.fade ?? 0;
  let k = 1;
  if (r.min !== undefined && v < r.min) k = fade > 0 ? ease(1 - (r.min - v) / fade) : 0;
  if (r.max !== undefined && v > r.max) k *= fade > 0 ? ease(1 - (v - r.max) / fade) : 0;
  return k;
}

/** The noise hash's multipliers: x, y, z and seed lanes, then two mixing rounds. */
const H = [0x27d4eb2d, 0x1b873593, 0x165667b1, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35] as const;

function hash01(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, H[0]) ^ Math.imul(iy | 0, H[1]) ^ Math.imul(iz | 0, H[2]) ^ Math.imul(seed | 0, H[3]);
  h = Math.imul(h ^ (h >>> 15), H[4]);
  h = Math.imul(h ^ (h >>> 13), H[5]);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise in [0, 1) at a point in units of its lattice (smoothstep between lattice points). */
export function ruleNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const plane = (yy: number): number =>
    lerp(lerp(hash01(ix, yy, iz, seed), hash01(ix + 1, yy, iz, seed), sx), lerp(hash01(ix, yy, iz + 1, seed), hash01(ix + 1, yy, iz + 1, seed), sx), sz);
  return lerp(plane(iy), plane(iy + 1), sy);
}

/**
 * A rule list ready to evaluate many points: the scratch weights it reuses
 * and what its rules read (a source skips measuring what no rule reads).
 */
export class SurfaceRuleSet {
  readonly rules: readonly SurfaceRule[];
  /** Some rule reads the cavity / the cell (block type or metadata). */
  readonly readsCavity: boolean;
  readonly readsCell: boolean;
  /** The farthest a rule's cavity reaches (metres; 0: none). */
  readonly reach: number;
  private readonly blockSets: (Set<string> | null)[];
  private readonly w = new Float64Array(SURFACE_RULE_LAYER_MAX + 1);
  /** The layers holding weight at the current point (the first `activeCount`). */
  private readonly active = new Int32Array(SURFACE_RULE_LAYER_MAX + 1);
  private activeCount = 0;
  /** The cavities measured at the current point, by radius (the first `cavityCount`; rules name a few radii). */
  private readonly cavityRadii = new Float64Array(8);
  private readonly cavityValues = new Float64Array(8);
  private cavityCount = 0;

  constructor(rules: readonly SurfaceRule[]) {
    this.rules = rules;
    this.readsCavity = rules.some((r) => r.cavity !== undefined);
    this.readsCell = rules.some((r) => r.blocks !== undefined || r.meta !== undefined);
    this.reach = Math.max(0, ...rules.map((r) => (r.cavity !== undefined ? (r.cavity.radius ?? SURFACE_RULE_CAVITY_RADIUS) : 0)));
    this.blockSets = rules.map((r) => (r.blocks !== undefined ? new Set(r.blocks) : null));
  }

  /**
   * The layers at a point: `layers[i]` holds `weights[i]` for i below the
   * count returned (bytes summing to 255, strongest first, equal ones by
   * lower layer, no zeros); entries past it are left as they were.
   */
  evaluate(p: SurfacePoint, layers: number[], weights: number[]): number {
    const w = this.w;
    const active = this.active;
    for (let a = 0; a < this.activeCount; a++) w[active[a]!] = 0;
    w[0] = 1;
    active[0] = 0;
    this.activeCount = 1;
    this.cavityCount = 0;
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i]!;
      let f = r.strength ?? 1;
      if (f <= 0) continue;
      if (r.face !== undefined && (r.face === 'wall') !== p.wall) continue;
      const set = this.blockSets[i]!;
      if (set !== null && (p.block === undefined || !set.has(p.block))) continue;
      if (r.meta !== undefined) {
        let ok = p.meta !== undefined;
        for (const k in r.meta) if (ok && p.meta!(k) !== r.meta[k]) ok = false;
        if (!ok) continue;
      }
      if (r.height !== undefined) f *= ruleRangeAt(r.height, p.y);
      if (f > 0 && r.slope !== undefined) f *= ruleRangeAt(r.slope, p.slope);
      if (f > 0 && r.cavity !== undefined) {
        const radius = r.cavity.radius ?? SURFACE_RULE_CAVITY_RADIUS;
        let at = -1;
        for (let k = 0; k < this.cavityCount; k++) if (this.cavityRadii[k] === radius) at = k;
        const c = at >= 0 ? this.cavityValues[at]! : p.cavity(radius);
        if (at < 0 && this.cavityCount < this.cavityRadii.length) {
          this.cavityRadii[this.cavityCount] = radius;
          this.cavityValues[this.cavityCount++] = c;
        }
        f *= ruleRangeAt(r.cavity, c);
      }
      if (f > 0 && r.noise !== undefined) f *= ruleRangeAt(r.noise, ruleNoise(p.x / r.noise.scale, p.y / r.noise.scale, p.z / r.noise.scale, r.noise.seed ?? 0));
      if (f > 0 && r.weight !== undefined) f *= ruleRangeAt(r.weight, w[r.weight.layer]!);
      if (f <= 0) continue;
      if (f > 1) f = 1;
      let seen = false;
      for (let a = 0; a < this.activeCount; a++) {
        w[active[a]!]! *= 1 - f;
        if (active[a] === r.layer) seen = true;
      }
      if (!seen) active[this.activeCount++] = r.layer;
      w[r.layer]! += f;
    }
    // Bytes summing to 255: rounded, the remainder to the strongest; strongest first, equal ones by lower layer.
    let n = 0;
    let sum = 0;
    for (let a = 0; a < this.activeCount; a++) {
      const l = active[a]!;
      const q = Math.round(w[l]! * 255);
      if (q <= 0) continue;
      layers[n] = l;
      weights[n] = q;
      sum += q;
      n += 1;
    }
    if (n === 0) {
      layers[0] = 0;
      weights[0] = 255;
      return 1;
    }
    sortLayers(layers, weights, n);
    weights[0]! += 255 - sum;
    // The remainder can reorder the first two (one byte at most).
    sortLayers(layers, weights, n);
    return n;
  }
}
