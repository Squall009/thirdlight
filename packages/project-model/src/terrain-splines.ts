/**
 * Splines as an input of a terrain's heights and paint, and as bands its
 * scatter keeps clear of.
 *
 * A terrain's heights are what was sculpted by hand (the tile's `base`,
 * or its `data` while nothing else changes it) with the inputs above it
 * applied in order: today the splines that carve, flatten, raise or paint
 * it. The combined tile is what is drawn, collides and ships (`data`); the
 * hand-sculpted one stays beside it, so moving a spline recomputes the
 * ground under it without losing any sculpting. Each input is a function of
 * the ground below it at one sample only, so recomputing a rectangle gives
 * the same bytes as recomputing everything.
 *
 * A spline reaches the samples within its half width plus its falloff of
 * the curve (across the ground). There it pulls the ground toward the
 * curve's height (less its offset and, toward the centre, its channel
 * depth; tilted by its roll), fully within the half width and fading out
 * over the falloff (smoothstep); a carve only lowers, a raise only raises.
 * Its paint is a layer amount by the same measure over its own width and
 * falloff, mixed over the material rules and under hand paint. Samples on a
 * block layer's cells are never changed: a road entering a block area stops
 * at its border.
 *
 * The curve is read as straight pieces about {@link TERRAIN_SPLINE_STEP}
 * metres long (or the sample spacing, if finer), each segment cut by its own
 * points alone, so moving one point leaves the pieces of the segments it does
 * not move as they were: each tile asks only the pieces whose band reaches
 * it, and each sample keeps the nearest piece.
 *
 * Pure and deterministic.
 */
import type { ScatterRect } from './scatter';
import { SPLINE_FALLOFF_DEFAULT, SPLINE_SCATTER_MARGIN_DEFAULT, type SplineComponent, type SplineScatterSettings, type SplineTerrainSettings } from './spline';
import { SplineCurve, type SplineFrame } from './spline-curve';
import { terrainHeightOf, terrainStepOf, terrainTileKey, type TerrainComponent } from './terrain';

/** Metres between the curve's pieces the terrain reads. */
export const TERRAIN_SPLINE_STEP = 1;
/** Metres of the grid the scatter bands are looked up by. */
const BAND_CELL = 32;

/** One spline as the terrain reads it (world curve, its settings). */
export interface TerrainSplineInput {
  readonly id: string;
  readonly order: number;
  readonly curve: SplineCurve;
  readonly terrain?: SplineTerrainSettings;
  readonly scatter?: SplineScatterSettings;
}

type SceneEntity = { readonly id: string; readonly components: Readonly<Record<string, unknown>> };

/**
 * The splines of a scene that shape terrain or keep scatter clear, in the
 * order they apply (lowest `order` first, then object id).
 */
export function terrainSplineInputs(entities: readonly SceneEntity[]): TerrainSplineInput[] {
  const out: TerrainSplineInput[] = [];
  for (const e of entities) {
    const s = e.components['spline'] as SplineComponent | undefined;
    if (s === undefined || (s.terrain === undefined && s.scatter === undefined) || !Array.isArray(s.points) || s.points.length < 2) continue;
    const p = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
    out.push({ id: e.id, order: s.terrain?.order ?? 0, curve: SplineCurve.of(s, p), ...(s.terrain !== undefined ? { terrain: s.terrain } : {}), ...(s.scatter !== undefined ? { scatter: s.scatter } : {}) });
  }
  out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Metres from the curve a spline's terrain change reaches (heights or paint; 0: none). */
export function terrainSplineReach(t: SplineTerrainSettings | undefined, maxWidth: number): number {
  if (t === undefined) return 0;
  const falloff = t.falloff ?? SPLINE_FALLOFF_DEFAULT;
  const heights = (t.shape ?? 'flatten') === 'none' ? 0 : maxWidth / 2 + falloff;
  const paint = t.paint === undefined ? 0 : (t.paint.width ?? maxWidth) / 2 + (t.paint.falloff ?? falloff);
  return Math.max(heights, paint);
}

/** Metres from the curve a spline keeps scatter clear (0: none). */
export function splineScatterReach(s: SplineScatterSettings | undefined, maxWidth: number): number {
  return s === undefined ? 0 : maxWidth / 2 + (s.margin ?? SPLINE_SCATTER_MARGIN_DEFAULT);
}

/** The world XZ box a spline's terrain change reaches (null: it changes no terrain). */
export function terrainSplineRect(input: Pick<TerrainSplineInput, 'curve' | 'terrain'>): ScatterRect | null {
  const r = terrainSplineReach(input.terrain, input.curve.maxWidth);
  if (r <= 0) return null;
  const b = input.curve.bounds;
  return [b[0] - r, b[2] - r, b[3] + r, b[5] + r];
}

/** The world XZ box a spline keeps scatter clear in (null: none). */
export function splineScatterRect(input: Pick<TerrainSplineInput, 'curve' | 'scatter'>): ScatterRect | null {
  const r = splineScatterReach(input.scatter, input.curve.maxWidth);
  if (r <= 0) return null;
  const b = input.curve.bounds;
  return [b[0] - r, b[2] - r, b[3] + r, b[5] + r];
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** The curve as straight pieces: each segment's own frames about `step` apart (unchanged segments give the same pieces). */
function piecesOf(curve: SplineCurve, step: number): SplineFrame[] {
  return curve.pieces(step);
}

/**
 * The nearest piece of a curve to each sample of a box, within `reach`
 * metres: per sample its signed distance across (right positive; NaN out of
 * reach), and the curve's height, width and roll there.
 */
export interface SplineRaster {
  readonly lat: Float32Array;
  readonly y: Float32Array;
  readonly width: Float32Array;
  readonly roll: Float32Array;
}

/**
 * Rasterize `frames` over a grid of `cols × rows` samples at world
 * (ox + (gx0 + i)·sp, oz + (gz0 + j)·sp), keeping the nearest piece within
 * `reach`. A sample's place comes from its global index, so a sample two
 * tiles share is measured to the same bits in both. Null: no sample in
 * reach.
 */
export function rasterizeSpline(frames: readonly SplineFrame[], reach: number, ox: number, oz: number, gx0: number, gz0: number, sp: number, cols: number, rows: number): SplineRaster | null {
  const n = cols * rows;
  const x0 = ox + gx0 * sp;
  const z0 = oz + gz0 * sp;
  let best: Float64Array | null = null;
  let lat: Float32Array | null = null;
  let y: Float32Array | null = null;
  let width: Float32Array | null = null;
  let roll: Float32Array | null = null;
  const xMax = x0 + (cols - 1) * sp;
  const zMax = z0 + (rows - 1) * sp;
  const r2 = reach * reach;
  for (let k = 0; k + 1 < frames.length; k++) {
    const a = frames[k]!;
    const b = frames[k + 1]!;
    const minX = Math.min(a.x, b.x) - reach;
    const maxX = Math.max(a.x, b.x) + reach;
    const minZ = Math.min(a.z, b.z) - reach;
    const maxZ = Math.max(a.z, b.z) + reach;
    if (maxX < x0 || minX > xMax || maxZ < z0 || minZ > zMax) continue;
    // One sample wider each way than the box: the distance test below decides, measured alike in every tile.
    const i0 = Math.max(0, Math.ceil((minX - x0) / sp) - 1);
    const i1 = Math.min(cols - 1, Math.floor((maxX - x0) / sp) + 1);
    const j0 = Math.max(0, Math.ceil((minZ - z0) / sp) - 1);
    const j1 = Math.min(rows - 1, Math.floor((maxZ - z0) / sp) + 1);
    if (i0 > i1 || j0 > j1) continue;
    if (best === null) {
      best = new Float64Array(n).fill(Infinity);
      lat = new Float32Array(n).fill(Number.NaN);
      y = new Float32Array(n);
      width = new Float32Array(n);
      roll = new Float32Array(n);
    }
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const e2 = ex * ex + ez * ez;
    // Across: the pieces' mean right vector, levelled (the side a sample lies on).
    let rx = a.rx + b.rx;
    let rz = a.rz + b.rz;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    for (let j = j0; j <= j1; j++) {
      const pz = oz + (gz0 + j) * sp;
      for (let i = i0; i <= i1; i++) {
        const px = ox + (gx0 + i) * sp;
        let f = e2 > 0 ? ((px - a.x) * ex + (pz - a.z) * ez) / e2 : 0;
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        const qx = a.x + ex * f;
        const qz = a.z + ez * f;
        const dx = px - qx;
        const dz = pz - qz;
        const d2 = dx * dx + dz * dz;
        const s = j * cols + i;
        if (d2 > r2 || d2 >= best![s]!) continue;
        best![s] = d2;
        const d = Math.sqrt(d2);
        lat![s] = dx * rx + dz * rz >= 0 ? d : -d;
        y![s] = a.y + (b.y - a.y) * f;
        width![s] = a.width + (b.width - a.width) * f;
        roll![s] = a.roll + (b.roll - a.roll) * f;
      }
    }
  }
  return lat === null ? null : { lat, y: y!, width: width!, roll: roll! };
}

/** A layer amount (0-1 per sample) one spline paints over a tile. */
export interface TerrainSplinePaint {
  readonly layer: number;
  readonly amount: Float32Array;
}

/**
 * The splines over one terrain: which tiles they reach, a tile's combined
 * heights from its hand-sculpted ones, and the paint they put over its
 * material rules. Rasters are made per tile when first asked and kept.
 */
export class TerrainSplineLayer {
  /** The inputs that change heights or paint, in order. */
  readonly inputs: readonly TerrainSplineInput[];
  private readonly n: number;
  private readonly sp: number;
  private readonly size: number;
  private readonly range: readonly number[];
  private readonly frames = new Map<string, SplineFrame[]>();
  private readonly rects: (ScatterRect | null)[];
  private readonly rasters = new Map<string, (SplineRaster | null)[]>();

  /**
   * `origin`: the terrain object's position. `blocked`: world (x, z) on a
   * block layer's cells, where no spline changes the terrain.
   */
  constructor(
    inputs: readonly TerrainSplineInput[],
    comp: Pick<TerrainComponent, 'tileSamples' | 'spacing' | 'heightRange'>,
    private readonly origin: readonly number[],
    private readonly blocked: ((x: number, z: number) => boolean) | null = null,
  ) {
    this.inputs = inputs.filter((i) => terrainSplineRect(i) !== null);
    this.n = comp.tileSamples - 1;
    this.sp = comp.spacing;
    this.size = this.n * this.sp;
    this.range = comp.heightRange;
    this.rects = this.inputs.map((i) => terrainSplineRect(i));
  }

  /** Whether any spline changes this terrain. */
  get empty(): boolean {
    return this.inputs.length === 0;
  }

  /** Whether a spline reaches tile (tx, tz). */
  reaches(tx: number, tz: number): boolean {
    const x0 = this.origin[0]! + tx * this.size;
    const z0 = this.origin[2]! + tz * this.size;
    return this.rects.some((r) => r !== null && r[0] <= x0 + this.size && r[2] >= x0 && r[1] <= z0 + this.size && r[3] >= z0);
  }

  private framesOf(k: number): SplineFrame[] {
    const input = this.inputs[k]!;
    let f = this.frames.get(input.id);
    if (f === undefined) this.frames.set(input.id, (f = piecesOf(input.curve, Math.min(TERRAIN_SPLINE_STEP, this.sp))));
    return f;
  }

  /** Each input's raster over tile (tx, tz) (null where it does not reach). */
  private rastersOf(tx: number, tz: number): (SplineRaster | null)[] {
    const key = terrainTileKey(tx, tz);
    let r = this.rasters.get(key);
    if (r !== undefined) return r;
    const S = this.n + 1;
    const x0 = this.origin[0]! + tx * this.size;
    const z0 = this.origin[2]! + tz * this.size;
    r = this.inputs.map((input, k) => {
      const rect = this.rects[k]!;
      if (rect[0] > x0 + this.size || rect[2] < x0 || rect[1] > z0 + this.size || rect[3] < z0) return null;
      return rasterizeSpline(this.framesOf(k), terrainSplineReach(input.terrain, input.curve.maxWidth), this.origin[0]!, this.origin[2]!, tx * this.n, tz * this.n, this.sp, S, S);
    });
    this.rasters.set(key, r);
    return r;
  }

  /** Whether a sample (index i of tile tx, tz) lies on a block layer's cells. */
  private isBlocked(tx: number, tz: number, i: number): boolean {
    if (this.blocked === null) return false;
    const S = this.n + 1;
    return this.blocked(this.origin[0]! + (tx * this.n + (i % S)) * this.sp, this.origin[2]! + (tz * this.n + Math.floor(i / S)) * this.sp);
  }

  /**
   * Tile (tx, tz)'s heights (16-bit steps) with the splines applied over
   * its hand-sculpted ones; the same array when nothing changes.
   */
  heights(tx: number, tz: number, authored: Uint16Array): Uint16Array {
    const rasters = this.rastersOf(tx, tz);
    let out: Uint16Array | null = null;
    const oy = this.origin[1]!;
    for (let k = 0; k < this.inputs.length; k++) {
      const r = rasters[k];
      const t = this.inputs[k]!.terrain!;
      const shape = t.shape ?? 'flatten';
      if (r === null || r === undefined || shape === 'none') continue;
      const falloff = t.falloff ?? SPLINE_FALLOFF_DEFAULT;
      const depth = t.depth ?? 0;
      const offset = t.offset ?? 0;
      const src: Uint16Array = out ?? authored;
      for (let i = 0; i < src.length; i++) {
        const lat = r.lat[i]!;
        if (Number.isNaN(lat)) continue;
        const d = Math.abs(lat);
        const hw = r.width[i]! / 2;
        const w = d <= hw ? 1 : falloff > 0 && d < hw + falloff ? smooth(1 - (d - hw) / falloff) : 0;
        if (w <= 0 || this.isBlocked(tx, tz, i)) continue;
        const across = Math.max(-hw, Math.min(hw, lat));
        const q = hw > 0 ? Math.min(1, d / hw) : 1;
        const roll = r.roll[i]!;
        const target = r.y[i]! - oy - offset - depth * (1 - q * q) + (roll !== 0 ? across * Math.tan((roll * Math.PI) / 180) : 0);
        const h = terrainHeightOf(this.range, src[i]!);
        if ((shape === 'carve' && target >= h) || (shape === 'raise' && target <= h)) continue;
        const step = terrainStepOf(this.range, h + (target - h) * w);
        if (step === src[i]) continue;
        if (out === null) out = authored.slice();
        out[i] = step;
      }
    }
    return out ?? authored;
  }

  /** The layer amounts the splines paint over tile (tx, tz), in order (null: none). */
  paint(tx: number, tz: number): TerrainSplinePaint[] | null {
    const rasters = this.rastersOf(tx, tz);
    let out: TerrainSplinePaint[] | null = null;
    for (let k = 0; k < this.inputs.length; k++) {
      const r = rasters[k];
      const t = this.inputs[k]!.terrain!;
      const p = t.paint;
      if (r === null || r === undefined || p === undefined) continue;
      const falloff = p.falloff ?? t.falloff ?? SPLINE_FALLOFF_DEFAULT;
      const strength = p.strength ?? 1;
      let amount: Float32Array | null = null;
      for (let i = 0; i < r.lat.length; i++) {
        const lat = r.lat[i]!;
        if (Number.isNaN(lat)) continue;
        const d = Math.abs(lat);
        const hw = (p.width ?? r.width[i]!) / 2;
        const a = d <= hw ? 1 : falloff > 0 && d < hw + falloff ? smooth(1 - (d - hw) / falloff) : 0;
        if (a <= 0 || this.isBlocked(tx, tz, i)) continue;
        amount ??= new Float32Array(r.lat.length);
        amount[i] = a * strength;
      }
      if (amount !== null) (out ??= []).push({ layer: p.layer, amount });
    }
    return out;
  }
}

/**
 * The bands splines keep scatter clear of, looked up by a grid of
 * {@link BAND_CELL}-metre cells: `cleared(x, z, rule)` says whether a
 * copy of `rule` may not stand at world (x, z).
 */
export class SplineScatterBands {
  private readonly cells = new Map<string, number[]>();
  private readonly pieces: { ax: number; az: number; bx: number; bz: number; wa: number; wb: number; margin: number; rules: ReadonlySet<string> | null }[] = [];

  constructor(inputs: readonly Pick<TerrainSplineInput, 'curve' | 'scatter'>[]) {
    for (const input of inputs) {
      const s = input.scatter;
      if (s === undefined) continue;
      const margin = s.margin ?? SPLINE_SCATTER_MARGIN_DEFAULT;
      const rules = s.rules !== undefined && s.rules.length > 0 ? new Set(s.rules) : null;
      const frames = piecesOf(input.curve, TERRAIN_SPLINE_STEP);
      for (let k = 0; k + 1 < frames.length; k++) {
        const a = frames[k]!;
        const b = frames[k + 1]!;
        const idx = this.pieces.length;
        this.pieces.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, wa: a.width / 2, wb: b.width / 2, margin, rules });
        const reach = Math.max(a.width, b.width) / 2 + margin;
        const cx0 = Math.floor((Math.min(a.x, b.x) - reach) / BAND_CELL);
        const cx1 = Math.floor((Math.max(a.x, b.x) + reach) / BAND_CELL);
        const cz0 = Math.floor((Math.min(a.z, b.z) - reach) / BAND_CELL);
        const cz1 = Math.floor((Math.max(a.z, b.z) + reach) / BAND_CELL);
        for (let cz = cz0; cz <= cz1; cz++)
          for (let cx = cx0; cx <= cx1; cx++) {
            const key = `${cx},${cz}`;
            const list = this.cells.get(key);
            if (list === undefined) this.cells.set(key, [idx]);
            else list.push(idx);
          }
      }
    }
  }

  get empty(): boolean {
    return this.pieces.length === 0;
  }

  cleared(x: number, z: number, rule: string): boolean {
    const list = this.cells.get(`${Math.floor(x / BAND_CELL)},${Math.floor(z / BAND_CELL)}`);
    if (list === undefined) return false;
    for (const idx of list) {
      const p = this.pieces[idx]!;
      if (p.rules !== null && !p.rules.has(rule)) continue;
      const ex = p.bx - p.ax;
      const ez = p.bz - p.az;
      const e2 = ex * ex + ez * ez;
      let f = e2 > 0 ? ((x - p.ax) * ex + (z - p.az) * ez) / e2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const r = p.wa + (p.wb - p.wa) * f + p.margin;
      const dx = x - (p.ax + ex * f);
      const dz = z - (p.az + ez * f);
      if (dx * dx + dz * dz <= r * r) return true;
    }
    return false;
  }
}
