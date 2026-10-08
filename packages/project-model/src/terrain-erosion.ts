/**
 * Erosion of a heightfield: hydraulic (water droplets that pick up and drop
 * sediment as they run downhill, cutting channels and filling hollows) and
 * thermal (material sliding off slopes steeper than its angle of repose).
 *
 * Both work on a grid of heights in metres (`ErosionGrid`): the samples of
 * a rectangle of the terrain plus a margin round it, with NaN where no tile
 * holds a sample (an edge water runs off). Droplets start only inside the
 * rectangle; what they change in the margin is read but thrown away by the
 * caller, which fades the result into the ground round the rectangle.
 *
 * Deterministic: the droplets' starts come from a seeded generator, the
 * passes run in a fixed order, so the same grid and settings give the same
 * heights to the bit wherever it runs (the backend's worker thread or in
 * process).
 *
 * The hydraulic model is the particle method (H. Beyer, "Implementation of
 * a method for hydraulic erosion", 2015), worked in sample units (heights
 * divided by the spacing), so the settings mean the same at any spacing.
 *
 * Pure.
 */
import type { ModelErrorV2 } from './errors';

/** Hydraulic erosion's settings (absent fields take {@link HYDRAULIC_DEFAULTS}). */
export interface HydraulicErosion {
  /** Droplets per sample of the rectangle. */
  droplets?: number;
  /** How fast a droplet takes up ground it can carry (0–1]. */
  erosion?: number;
  /** How fast it drops what it carries past its capacity (0–1]. */
  deposition?: number;
  /** Sediment a droplet carries per unit of speed, water and slope. */
  capacity?: number;
  /** Water lost a step (0–0.5). */
  evaporation?: number;
  /** How much of its direction a droplet keeps against the slope [0–0.95]. */
  inertia?: number;
  /** Steps a droplet runs before it stops. */
  lifetime?: number;
  /** Samples round a droplet it erodes from (a wider radius cuts smoother channels). */
  radius?: number;
}

/** Thermal erosion's settings (absent fields take {@link THERMAL_DEFAULTS}). */
export interface ThermalErosion {
  /** Passes over the rectangle. */
  iterations?: number;
  /** The angle of repose (degrees): steeper slopes shed ground. */
  talus?: number;
  /** The share of the excess a pass moves (0–1]. */
  amount?: number;
}

/** One erosion run: hydraulic first, then thermal (either may be absent, not both). */
export interface ErosionSettings {
  hydraulic?: HydraulicErosion;
  thermal?: ThermalErosion;
  seed?: number;
}

export const HYDRAULIC_DEFAULTS: Readonly<Required<HydraulicErosion>> = Object.freeze({ droplets: 0.5, erosion: 0.3, deposition: 0.3, capacity: 4, evaporation: 0.01, inertia: 0.05, lifetime: 30, radius: 3 });
export const THERMAL_DEFAULTS: Readonly<Required<ThermalErosion>> = Object.freeze({ iterations: 40, talus: 35, amount: 0.5 });

/** Each setting's range ([min, max]; `open` mins exclude the bound). */
export const EROSION_LIMITS = Object.freeze({
  droplets: [0, 8],
  erosion: [0, 1],
  deposition: [0, 1],
  capacity: [0, 64],
  evaporation: [0, 0.5],
  inertia: [0, 0.95],
  lifetime: [1, 256],
  radius: [1, 8],
  iterations: [1, 1000],
  talus: [1, 89],
  amount: [0, 1],
} as const);

/** Fields whose minimum is excluded (zero would do nothing or divide by it). */
const OPEN_MIN: ReadonlySet<string> = new Set(['droplets', 'erosion', 'deposition', 'capacity', 'amount']);
/** Fields that are whole numbers. */
const WHOLE: ReadonlySet<string> = new Set(['lifetime', 'radius', 'iterations']);

/** Samples of fade at a rectangle's border (the result blended into the ground round it). */
export const EROSION_FADE_SAMPLES = 8;
/** Samples of margin read round the rectangle (droplets run on into it; its changes are dropped). */
export const EROSION_MARGIN_SAMPLES = 16;
/** A per-request bound on the samples one run erodes (2,049² — eight 257-sample tiles a side): not a terrain size. */
export const EROSION_MAX_SAMPLES = 2049 * 2049;

const GRAVITY = 4;
const MIN_CAPACITY = 0.01;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkFields(v: unknown, path: string, keys: readonly (keyof typeof EROSION_LIMITS)[], errors: ModelErrorV2[]): void {
  if (!isObj(v)) {
    errors.push({ code: 'field_type', path, message: `an object of ${keys.join(', ')} (each optional)`, found: v } as ModelErrorV2);
    return;
  }
  for (const k of Object.keys(v)) if (!(keys as readonly string[]).includes(k)) errors.push({ code: 'field_unexpected', path: `${path}/${k}`, message: `unknown erosion setting "${k}" (${keys.join(', ')})`, found: k } as ModelErrorV2);
  for (const k of keys) {
    const x = v[k];
    if (x === undefined) continue;
    const [lo, hi] = EROSION_LIMITS[k];
    const ok = finite(x) && (OPEN_MIN.has(k) ? x > lo : x >= lo) && x <= hi && (!WHOLE.has(k) || Number.isInteger(x));
    if (!ok) errors.push({ code: 'field_value', path: `${path}/${k}`, message: `${k} is ${WHOLE.has(k) ? 'a whole number ' : ''}${OPEN_MIN.has(k) ? 'over' : 'from'} ${lo} to ${hi}`, found: x } as ModelErrorV2);
  }
}

export function validateErosionSettings(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(v)) {
    errors.push({ code: 'field_type', path, message: 'erosion settings are {hydraulic?, thermal?, seed?}', found: v } as ModelErrorV2);
    return;
  }
  for (const k of Object.keys(v)) if (k !== 'hydraulic' && k !== 'thermal' && k !== 'seed') errors.push({ code: 'field_unexpected', path: `${path}/${k}`, message: `unknown erosion field "${k}" (hydraulic, thermal, seed)`, found: k } as ModelErrorV2);
  if (v['hydraulic'] === undefined && v['thermal'] === undefined) errors.push({ code: 'field_missing', path, message: 'erosion runs hydraulic, thermal or both: give at least one' } as ModelErrorV2);
  if (v['hydraulic'] !== undefined) checkFields(v['hydraulic'], `${path}/hydraulic`, ['droplets', 'erosion', 'deposition', 'capacity', 'evaporation', 'inertia', 'lifetime', 'radius'], errors);
  if (v['thermal'] !== undefined) checkFields(v['thermal'], `${path}/thermal`, ['iterations', 'talus', 'amount'], errors);
  if (v['seed'] !== undefined && !Number.isSafeInteger(v['seed'])) errors.push({ code: 'field_value', path: `${path}/seed`, message: 'seed is a whole number', found: v['seed'] } as ModelErrorV2);
}

/** Heights in metres over a box of samples (NaN: no sample there). */
export interface ErosionGrid {
  readonly cols: number;
  readonly rows: number;
  /** Metres between samples. */
  readonly spacing: number;
  readonly heights: Float64Array;
  /** The samples droplets start in ([i0, j0, i1, j1], inclusive). */
  readonly region: readonly [number, number, number, number];
}

/** A small seeded generator (mulberry32): the same starts on every run. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Erode the grid in place (hydraulic, then thermal). */
export function erodeGrid(g: ErosionGrid, s: ErosionSettings): void {
  if (s.hydraulic !== undefined) hydraulic(g, { ...HYDRAULIC_DEFAULTS, ...s.hydraulic }, s.seed ?? 0);
  if (s.thermal !== undefined) thermal(g, { ...THERMAL_DEFAULTS, ...s.thermal });
}

function hydraulic(g: ErosionGrid, p: Required<HydraulicErosion>, seed: number): void {
  const { cols, rows } = g;
  const h = g.heights;
  // Sample units: heights over the spacing, so a slope is rise over run.
  const k = 1 / g.spacing;
  for (let i = 0; i < h.length; i++) h[i] = h[i]! * k;
  // The erosion brush: offsets within the radius and their weights (summing to 1).
  const r = p.radius;
  const offX: number[] = [];
  const offZ: number[] = [];
  const wts: number[] = [];
  let sum = 0;
  for (let z = -r; z <= r; z++)
    for (let x = -r; x <= r; x++) {
      const d = Math.sqrt(x * x + z * z);
      if (d >= r) continue;
      offX.push(x);
      offZ.push(z);
      wts.push(1 - d / r);
      sum += 1 - d / r;
    }
  for (let i = 0; i < wts.length; i++) wts[i] = wts[i]! / sum;
  const [i0, j0, i1, j1] = g.region;
  const w = i1 - i0 + 1;
  const d = j1 - j0 + 1;
  const count = Math.round(p.droplets * w * d);
  const rnd = generator(seed);
  const ok = (x: number, z: number): boolean => x >= 0 && z >= 0 && x < cols - 1 && z < rows - 1;
  for (let n = 0; n < count; n++) {
    let x = i0 + rnd() * (w - 1);
    let z = j0 + rnd() * (d - 1);
    let dx = 0;
    let dz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let life = 0; life < p.lifetime; life++) {
      const nx = Math.floor(x);
      const nz = Math.floor(z);
      if (!ok(nx, nz)) break;
      const fx = x - nx;
      const fz = z - nz;
      const c = nz * cols + nx;
      const h00 = h[c]!;
      const h10 = h[c + 1]!;
      const h01 = h[c + cols]!;
      const h11 = h[c + cols + 1]!;
      if (Number.isNaN(h00 + h10 + h01 + h11)) break;
      const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
      const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const height = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
      dx = dx * p.inertia - gx * (1 - p.inertia);
      dz = dz * p.inertia - gz * (1 - p.inertia);
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-9) break;
      dx /= len;
      dz /= len;
      x += dx;
      z += dz;
      const mx = Math.floor(x);
      const mz = Math.floor(z);
      if (!ok(mx, mz)) break;
      const ex = x - mx;
      const ez = z - mz;
      const m = mz * cols + mx;
      const nh = h[m]! * (1 - ex) * (1 - ez) + h[m + 1]! * ex * (1 - ez) + h[m + cols]! * (1 - ex) * ez + h[m + cols + 1]! * ex * ez;
      if (Number.isNaN(nh)) break;
      const dh = nh - height;
      const capacity = Math.max(-dh * speed * water * p.capacity, MIN_CAPACITY);
      if (sediment > capacity || dh > 0) {
        // Uphill: fill the hollow behind (at most what it climbs); else drop the excess.
        const drop = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * p.deposition;
        sediment -= drop;
        h[c] = h00 + drop * (1 - fx) * (1 - fz);
        h[c + 1] = h10 + drop * fx * (1 - fz);
        h[c + cols] = h01 + drop * (1 - fx) * fz;
        h[c + cols + 1] = h11 + drop * fx * fz;
      } else {
        // Downhill with room: take ground from round the old place (never more than the drop, so no pits).
        const take = Math.min((capacity - sediment) * p.erosion, -dh);
        for (let b = 0; b < wts.length; b++) {
          const bx = nx + offX[b]!;
          const bz = nz + offZ[b]!;
          if (bx < 0 || bz < 0 || bx >= cols || bz >= rows) continue;
          const at = bz * cols + bx;
          const cur = h[at]!;
          if (Number.isNaN(cur)) continue;
          const amt = take * wts[b]!;
          h[at] = cur - amt;
          sediment += amt;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * GRAVITY));
      water *= 1 - p.evaporation;
    }
  }
  for (let i = 0; i < h.length; i++) h[i] = h[i]! * g.spacing;
}

function thermal(g: ErosionGrid, p: Required<ThermalErosion>): void {
  const { cols, rows } = g;
  const h = g.heights;
  // The steepest a neighbour may stand below (metres), straight and across.
  const t = Math.tan((p.talus * Math.PI) / 180) * g.spacing;
  const OX = [1, -1, 0, 0, 1, -1, 1, -1];
  const OZ = [0, 0, 1, -1, 1, 1, -1, -1];
  const LIM = [t, t, t, t, t * Math.SQRT2, t * Math.SQRT2, t * Math.SQRT2, t * Math.SQRT2];
  const OFF = OX.map((ox, k) => OZ[k]! * cols + ox);
  const ex = new Float64Array(8);
  const move = new Float64Array(h.length);
  // The passes cover the droplets' region and the margin round it (what slides out is dropped by the caller).
  for (let it = 0; it < p.iterations; it++) {
    move.fill(0);
    for (let z = 0; z < rows; z++) {
      const inZ = z > 0 && z < rows - 1;
      for (let x = 0; x < cols; x++) {
        const i = z * cols + x;
        const hi = h[i]!;
        if (Number.isNaN(hi)) continue;
        const inner = inZ && x > 0 && x < cols - 1;
        let total = 0;
        let most = 0;
        for (let k = 0; k < 8; k++) {
          ex[k] = 0;
          if (!inner) {
            const X = x + OX[k]!;
            const Z = z + OZ[k]!;
            if (X < 0 || Z < 0 || X >= cols || Z >= rows) continue;
          }
          // NaN neighbours (no tile) compare false and take nothing.
          const e = hi - h[i + OFF[k]!]! - LIM[k]!;
          if (e > 0) {
            ex[k] = e;
            total += e;
            if (e > most) most = e;
          }
        }
        if (total <= 0) continue;
        // Half the largest excess (so the two meet at the angle), shared by the lower neighbours by their excess.
        const out = p.amount * most * 0.5;
        move[i] = move[i]! - out;
        const share = out / total;
        for (let k = 0; k < 8; k++) if (ex[k]! > 0) move[i + OFF[k]!] = move[i + OFF[k]!]! + ex[k]! * share;
      }
    }
    for (let i = 0; i < h.length; i++) if (move[i] !== 0) h[i] = h[i]! + move[i]!;
  }
}
