/**
 * Editing a terrain's tiles: the sculpt brushes (raise, lower, smooth,
 * flatten, noise; a ramp between two points), layer paint and holes — the
 * cores the `editTerrain` command runs, the same ones the editor's preview
 * will run.
 *
 * Every brush works on the terrain's samples as one grid across its tiles: a
 * sample on a tile edge is stored in each tile that shares it and written in
 * all of them alike, so tiles never crack apart. Dabs use the brush falloff
 * of `paint-brush.ts` (by squared distance in metres); a dab reads the
 * heights as they were before it and writes 16-bit steps, so later dabs see
 * exactly what is stored. Squared distances, products and `Math.floor`
 * only (a linear falloff's square root is exact in IEEE arithmetic): the same
 * stroke gives the same tiles in every JavaScript engine.
 *
 * Pure and deterministic.
 */
import { brushFalloff, paintPoint, type BrushFalloff } from './paint-brush';
import { terrainFlatStep, terrainHeightOf, terrainStepOf, terrainTileKey, type TerrainComponent } from './terrain';
import { cloneTerrainTile, flatTerrainTile, setTerrainHole, writeSampleLayers, TERRAIN_PAINT_BYTES, TERRAIN_SAMPLE_LAYERS, type TerrainTile } from './terrain-tile';

export type TerrainSculptKind = 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise';
export const TERRAIN_SCULPT_KINDS: readonly TerrainSculptKind[] = ['raise', 'lower', 'smooth', 'flatten', 'noise'];

/**
 * Per-request bounds of one stroke (they protect a single request, like the
 * block edit bounds; nothing here caps a terrain): dabs, the brush, and the
 * samples all its dabs may cover together.
 */
export const TERRAIN_BRUSH_LIMITS = Object.freeze({ dabs: 1024, radiusMax: 2048, heightStrengthMax: 1000, noiseScaleMax: 10_000, samples: 16_777_216 });

/** The tiles of one terrain as a grid of samples, copied on first write. */
export class TerrainSamples {
  readonly n: number;
  readonly spacing: number;
  readonly range: readonly number[];
  private readonly tiles: Map<string, TerrainTile>;
  private readonly copied = new Set<string>();
  /** The tiles written so far ("x,z"). */
  readonly touched = new Set<string>();

  /** `tiles` holds every tile of the component the edit may read (a missing one is not there). */
  constructor(c: Pick<TerrainComponent, 'tileSamples' | 'spacing' | 'heightRange'>, tiles: ReadonlyMap<string, TerrainTile>) {
    this.n = c.tileSamples - 1;
    this.spacing = c.spacing;
    this.range = c.heightRange;
    this.tiles = new Map(tiles);
  }

  tile(tx: number, tz: number): TerrainTile | undefined {
    return this.tiles.get(terrainTileKey(tx, tz));
  }

  /** The tiles as they are now (written ones are copies). */
  all(): ReadonlyMap<string, TerrainTile> {
    return this.tiles;
  }

  /** Add a flat tile (an import or a conversion reaching past the grid). */
  addTile(tx: number, tz: number): TerrainTile {
    const key = terrainTileKey(tx, tz);
    const t = flatTerrainTile(this.n + 1, terrainFlatStep(this.range));
    this.tiles.set(key, t);
    this.copied.add(key);
    this.touched.add(key);
    return t;
  }

  /** A tile to write (copied the first time). */
  writable(tx: number, tz: number): TerrainTile | undefined {
    const key = terrainTileKey(tx, tz);
    const t = this.tiles.get(key);
    if (t === undefined) return undefined;
    this.touched.add(key);
    if (this.copied.has(key)) return t;
    const c = cloneTerrainTile(t);
    this.tiles.set(key, c);
    this.copied.add(key);
    return c;
  }

  /** The tile coordinates (one or, on edges, two) holding sample index `g` along an axis. */
  private owners(g: number): number[] {
    const t = Math.floor(g / this.n);
    return g - t * this.n === 0 ? [t, t - 1] : [t];
  }

  /** The stored step at global sample (gx, gz), or null where no tile holds it. */
  step(gx: number, gz: number): number | null {
    for (const tz of this.owners(gz))
      for (const tx of this.owners(gx)) {
        const t = this.tiles.get(terrainTileKey(tx, tz));
        if (t !== undefined) return t.heights[(gz - tz * this.n) * (this.n + 1) + (gx - tx * this.n)]!;
      }
    return null;
  }

  /** Write a step into every tile holding the sample. */
  setStep(gx: number, gz: number, step: number): void {
    for (const tz of this.owners(gz))
      for (const tx of this.owners(gx)) {
        const existing = this.tiles.get(terrainTileKey(tx, tz));
        if (existing === undefined) continue;
        const i = (gz - tz * this.n) * (this.n + 1) + (gx - tx * this.n);
        if (existing.heights[i] === step) continue;
        this.writable(tx, tz)!.heights[i] = step;
      }
  }

  /** Every tile holding the sample, with the sample's index in it (writable: copied). */
  holders(gx: number, gz: number, writable: boolean): { tile: TerrainTile; i: number }[] {
    const out: { tile: TerrainTile; i: number }[] = [];
    for (const tz of this.owners(gz))
      for (const tx of this.owners(gx)) {
        const t = writable ? this.writable(tx, tz) : this.tile(tx, tz);
        if (t !== undefined) out.push({ tile: t, i: (gz - tz * this.n) * (this.n + 1) + (gx - tx * this.n) });
      }
    return out;
  }

  /** The global sample range the tiles cover ([x0, z0, x1, z1] inclusive), or null with no tiles. */
  sampleBounds(): [number, number, number, number] | null {
    let b: [number, number, number, number] | null = null;
    for (const key of this.tiles.keys()) {
      const [tx, tz] = key.split(',').map(Number) as [number, number];
      const r: [number, number, number, number] = [tx * this.n, tz * this.n, (tx + 1) * this.n, (tz + 1) * this.n];
      b = b === null ? r : [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])];
    }
    return b;
  }

  heightOf(step: number): number {
    return terrainHeightOf(this.range, step);
  }

  stepOf(height: number): number {
    return terrainStepOf(this.range, height);
  }
}

/** One sculpt dab, in metres local to the terrain (x, z from its object's position, heights above its y). */
export interface TerrainSculptDab {
  kind: TerrainSculptKind;
  at: readonly [number, number];
  radius: number;
  /** raise, lower, noise: metres at the centre; smooth, flatten: the blend toward the target at the centre (0–1]. */
  strength: number;
  falloff: BrushFalloff;
  /** flatten: the height levelled to. */
  height?: number;
  /** noise: the size of its bumps (metres) and its seed. */
  scale?: number;
  seed?: number;
}

/** The global sample box a circle covers, clipped to `b` (null when empty). */
function sampleBox(s: TerrainSamples, cx: number, cz: number, r: number, b: readonly number[]): [number, number, number, number] | null {
  const sp = s.spacing;
  const x0 = Math.max(b[0]!, Math.ceil((cx - r) / sp));
  const x1 = Math.min(b[2]!, Math.floor((cx + r) / sp));
  const z0 = Math.max(b[1]!, Math.ceil((cz - r) / sp));
  const z1 = Math.min(b[3]!, Math.floor((cz + r) / sp));
  return x0 > x1 || z0 > z1 ? null : [x0, z0, x1, z1];
}

/** The noise hash's multipliers: x, z and seed lanes, then two mixing rounds (the editor's GPU preview hashes alike). */
export const TERRAIN_NOISE_HASH: readonly number[] = Object.freeze([0x27d4eb2d, 0x165667b1, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35]);
const [HX, HZ, HS, HM1, HM2] = TERRAIN_NOISE_HASH as [number, number, number, number, number];

/** A deterministic hash of a lattice point to [0, 1). */
function hash01(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, HX) ^ Math.imul(iz | 0, HZ) ^ Math.imul(seed | 0, HS);
  h = Math.imul(h ^ (h >>> 15), HM1);
  h = Math.imul(h ^ (h >>> 13), HM2);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise in [-1, 1] at (x, z) in units of its lattice (smoothstep between lattice points). */
export function terrainNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return (top + (bottom - top) * sz) * 2 - 1;
}

/** Apply one sculpt dab. Returns the samples it changed. */
export function sculptTerrain(s: TerrainSamples, dab: TerrainSculptDab): number {
  const bounds = s.sampleBounds();
  if (bounds === null) return 0;
  const [cx, cz] = dab.at;
  const box = sampleBox(s, cx, cz, dab.radius, bounds);
  if (box === null) return 0;
  const [x0, z0, x1, z1] = box;
  const sp = s.spacing;
  // The heights before the dab (one sample of margin for smoothing), NaN where no tile holds one.
  const m = dab.kind === 'smooth' ? 1 : 0;
  const w = x1 - x0 + 1 + 2 * m;
  const before = new Float64Array(w * (z1 - z0 + 1 + 2 * m));
  for (let z = z0 - m; z <= z1 + m; z++)
    for (let x = x0 - m; x <= x1 + m; x++) {
      const st = s.step(x, z);
      before[(z - z0 + m) * w + (x - x0 + m)] = st === null ? NaN : s.heightOf(st);
    }
  const at = (x: number, z: number): number => before[(z - z0 + m) * w + (x - x0 + m)]!;
  const blend = Math.min(1, dab.strength);
  const scale = dab.scale ?? 8 * sp;
  let changed = 0;
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const h = at(x, z);
      if (Number.isNaN(h)) continue;
      const dx = x * sp - cx;
      const dz = z * sp - cz;
      const f = brushFalloff(dx * dx + dz * dz, dab.radius, dab.falloff);
      if (f === 0) continue;
      let v = h;
      switch (dab.kind) {
        case 'raise':
          v = h + dab.strength * f;
          break;
        case 'lower':
          v = h - dab.strength * f;
          break;
        case 'flatten':
          v = h + blend * f * ((dab.height ?? h) - h);
          break;
        case 'noise':
          v = h + dab.strength * f * terrainNoise((x * sp) / scale, (z * sp) / scale, dab.seed ?? 0);
          break;
        case 'smooth': {
          let sum = 0;
          let k = 0;
          for (let b = -1; b <= 1; b++)
            for (let a = -1; a <= 1; a++) {
              const n = at(x + a, z + b);
              if (Number.isNaN(n)) continue;
              sum += n;
              k += 1;
            }
          v = h + blend * f * (sum / k - h);
          break;
        }
      }
      const step = s.stepOf(v);
      if (step === s.step(x, z)) continue;
      s.setStep(x, z, step);
      changed += 1;
    }
  return changed;
}

/** A ramp: the ground between two points (local metres, heights above the terrain's y) levelled onto the straight slope between them. */
export interface TerrainRamp {
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  /** Half the ramp's width (metres). */
  radius: number;
  /** The blend toward the slope at the middle (0–1]. */
  strength: number;
  falloff: BrushFalloff;
}

/** Apply a ramp. Returns the samples it changed. */
export function rampTerrain(s: TerrainSamples, ramp: TerrainRamp): number {
  const bounds = s.sampleBounds();
  if (bounds === null) return 0;
  const [ax, ay, az] = ramp.from;
  const [bx, by, bz] = ramp.to;
  const r = ramp.radius;
  const sp = s.spacing;
  const x0 = Math.max(bounds[0], Math.ceil((Math.min(ax, bx) - r) / sp));
  const x1 = Math.min(bounds[2], Math.floor((Math.max(ax, bx) + r) / sp));
  const z0 = Math.max(bounds[1], Math.ceil((Math.min(az, bz) - r) / sp));
  const z1 = Math.min(bounds[3], Math.floor((Math.max(az, bz) + r) / sp));
  const ux = bx - ax;
  const uz = bz - az;
  const len2 = ux * ux + uz * uz;
  const blend = Math.min(1, ramp.strength);
  let changed = 0;
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const st = s.step(x, z);
      if (st === null) continue;
      const px = x * sp - ax;
      const pz = z * sp - az;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * ux + pz * uz) / len2)) : 0;
      const dx = px - t * ux;
      const dz = pz - t * uz;
      const f = brushFalloff(dx * dx + dz * dz, r, ramp.falloff);
      if (f === 0) continue;
      const h = s.heightOf(st);
      const target = ay + t * (by - ay);
      const step = s.stepOf(h + blend * f * (target - h));
      if (step === st) continue;
      s.setStep(x, z, step);
      changed += 1;
    }
  return changed;
}

/** One paint dab: `layer` painted over the baked layers, or (`erase`) the hand paint taken back toward the baked layers. */
export interface TerrainPaintDab {
  at: readonly [number, number];
  radius: number;
  strength: number;
  falloff: BrushFalloff;
  layer: number;
  erase?: boolean;
}

const AMOUNT = 2 * TERRAIN_SAMPLE_LAYERS;

/**
 * Paint one sample's hand paint (`p[o …]`) by `t` (0–1): toward all `layer`
 * and a full amount, or (`erase`) the amount down toward none. Returns whether
 * a byte changed. The paint brush's own rules (`paintPoint`) move the weight,
 * over the sample's own layers plus the painted one.
 */
export function paintTerrainSample(p: Uint8Array, o: number, layer: number, t: number, erase: boolean): boolean {
  const before = p.slice(o, o + TERRAIN_PAINT_BYTES);
  if (erase) {
    const amount = new Uint8Array([p[o + AMOUNT]!]);
    paintPoint(amount, 0, { channels: 1, weights: 0 }, { channel: 0, erase: true }, t);
    p[o + AMOUNT] = amount[0]!;
    // No paint left: the sample's paint layers go too (one form per unpainted sample).
    if (amount[0] === 0) p.fill(0, o, o + AMOUNT);
  } else {
    const layers: number[] = [];
    const vals: number[] = [];
    if (p[o + AMOUNT]! > 0) {
      for (let k = 0; k < TERRAIN_SAMPLE_LAYERS; k++) {
        const w = p[o + TERRAIN_SAMPLE_LAYERS + k]!;
        if (w === 0) continue;
        layers.push(p[o + k]!);
        vals.push(w);
      }
    }
    if (!layers.includes(layer)) {
      layers.push(layer);
      vals.push(0);
    }
    const c = layers.indexOf(layer);
    const n = layers.length;
    const buf = new Uint8Array(n + 1);
    vals.forEach((v, k) => (buf[k] = v));
    buf[n] = p[o + AMOUNT]!;
    paintPoint(buf, 0, { channels: n + 1, weights: n }, { channel: c }, t);
    paintPoint(buf, 0, { channels: n + 1, weights: n }, { channel: n }, t);
    // A sample painted for the first time is all the painted layer (its weights started empty).
    if (buf.subarray(0, n).every((v) => v === 0)) buf[c] = 255;
    writeSampleLayers(p, o, layers, Array.from(buf.subarray(0, n)));
    p[o + AMOUNT] = buf[n]!;
  }
  for (let k = 0; k < TERRAIN_PAINT_BYTES; k++) if (p[o + k] !== before[k]) return true;
  return false;
}

/** Apply one paint dab. Returns the samples it changed. */
export function paintTerrain(s: TerrainSamples, dab: TerrainPaintDab): number {
  const bounds = s.sampleBounds();
  if (bounds === null) return 0;
  const box = sampleBox(s, dab.at[0], dab.at[1], dab.radius, bounds);
  if (box === null) return 0;
  const sp = s.spacing;
  let changed = 0;
  for (let z = box[1]; z <= box[3]; z++)
    for (let x = box[0]; x <= box[2]; x++) {
      const dx = x * sp - dab.at[0];
      const dz = z * sp - dab.at[1];
      const f = brushFalloff(dx * dx + dz * dz, dab.radius, dab.falloff);
      if (f === 0) continue;
      const held = s.holders(x, z, false);
      if (held.length === 0) continue;
      // Painted once (on the first holder) and copied to the others, which hold the same bytes.
      const first = held[0]!;
      const probe = new Uint8Array(TERRAIN_PAINT_BYTES);
      if (first.tile.paint !== null) probe.set(first.tile.paint.subarray(first.i * TERRAIN_PAINT_BYTES, (first.i + 1) * TERRAIN_PAINT_BYTES));
      if (!paintTerrainSample(probe, 0, dab.layer, dab.strength * f, dab.erase === true)) continue;
      for (const h of s.holders(x, z, true)) {
        h.tile.paint ??= new Uint8Array(TERRAIN_PAINT_BYTES * h.tile.heights.length);
        h.tile.paint.set(probe, h.i * TERRAIN_PAINT_BYTES);
      }
      changed += 1;
    }
  return changed;
}

/** One holes dab: the cells whose centres are within the radius cut out (or, `erase`, filled back). */
export interface TerrainHoleDab {
  at: readonly [number, number];
  radius: number;
  erase?: boolean;
}

/** Apply one holes dab. Returns the cells it changed. */
export function holeTerrain(s: TerrainSamples, dab: TerrainHoleDab): number {
  const sp = s.spacing;
  const [cx, cz] = dab.at;
  const r2 = dab.radius * dab.radius;
  const gx0 = Math.ceil((cx - dab.radius) / sp - 0.5);
  const gx1 = Math.floor((cx + dab.radius) / sp - 0.5);
  const gz0 = Math.ceil((cz - dab.radius) / sp - 0.5);
  const gz1 = Math.floor((cz + dab.radius) / sp - 0.5);
  let changed = 0;
  for (let gz = gz0; gz <= gz1; gz++)
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = (gx + 0.5) * sp - cx;
      const dz = (gz + 0.5) * sp - cz;
      if (dx * dx + dz * dz > r2) continue;
      const tx = Math.floor(gx / s.n);
      const tz = Math.floor(gz / s.n);
      const t = s.tile(tx, tz);
      if (t === undefined) continue;
      const lx = gx - tx * s.n;
      const lz = gz - tz * s.n;
      const want = dab.erase !== true;
      const holeNow = t.holes !== null && (t.holes[(lz * s.n + lx) >> 3]! & (1 << ((lz * s.n + lx) & 7))) !== 0;
      if (holeNow === want) continue;
      setTerrainHole(s.writable(tx, tz)!, lx, lz, want);
      changed += 1;
    }
  return changed;
}

/** How many samples a circle of `radius` metres covers at `spacing` (the stroke bound counts these). */
export function terrainDabSamples(radius: number, spacing: number): number {
  const r = radius / spacing + 1;
  return Math.ceil(4 * r * r);
}
