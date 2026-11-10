/**
 * The realistic style of the far world: the drainage's eroded mountains
 * (far-drainage.ts) read with a cubic, then detail that follows the ground:
 * gullies running down the slopes, winding escarpments and crags where it is
 * steep, river channels cut along the drainage's network with floodplains
 * where they run gently, rock outcrops with overhangs, boulders and scree at
 * the feet of steep ground, a few natural arches, and half-metre roughness at
 * the surface. Materials come from slope, height, curvature, the rivers and
 * noise, so their borders wander (grass, soil, gravel, rock, sand on the
 * river banks, snow on the high peaks).
 *
 * Every value is a function of the seed, the world's size and the cell's
 * position, so region columns written apart meet exactly. Engine-owned test
 * data (see far-world.ts), not a product feature.
 */
import { fractalNoise01, latticeHash, valueNoise01 } from '@thirdlight/shared';
import { localIndex, VOXEL_ROLE, type ChunkGrid, type DenseChunk } from '@thirdlight/voxel';
import { CoarseField, MAT, shapeByte, smoothstep } from './world-kit';
import { farDrainage, MEANDER, riverReaches, risenAt, sampleCubic, sampleLinear, type FarDrainage, type RiverReach } from './far-drainage';

/** The world's base (cells): 64 m under the valley floors. */
export const LANDSCAPE_BASE = -128;
/** Gullies: wavelengths (cells) and their height as a share of the wavelength. */
const GULLY_WAVES = [72, 30, 13] as const;
const GULLY_DEPTH = 0.07;
/** Escarpments: the noise's scale (cells), the step's height range (cells) and its sharpness (noise units). */
const SCARP_SCALE = 1700;
const SCARP_MIN = 30;
const SCARP_MAX = 110;
const SCARP_WIDTH = 0.006;
/** Crags on steep ground: height (cells) and scale (cells). */
const CRAG = 30;
const CRAG_SCALE = 110;
/** Rolling ground (cells) everywhere outside the town's flat. */
const ROLLING = 14;
/** Outcrops: how far (cells) rock pushes in and out of the surface where it is bare. */
const OUTCROP = 6;
/** Boulders: the lattice (cells) they sit on, at most one a lattice cell, and their largest radius (cells). */
const BOULDER_GRID = 12;
const BOULDER_MAX = 4.5;
/** Arches: the lattice (cells), the share of lattice cells that hold one, the largest span radius and rib (cells). */
const ARCH_GRID = 1024;
const ARCH_SHARE = 0.16;
const ARCH_SPAN = 36;
const ARCH_RIB = 7;
/** Snow from this height (cells, ~1.1 km), wandering with the noise. */
const SNOW_LINE = 2200;

/** A boulder: centre (cells), radius and its vertical squash. */
interface Boulder {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly squash: number;
}

/** An arch: a ring standing on the ground, centre, span radius, rib radius and the direction it spans. */
interface Arch {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly span: number;
  readonly rib: number;
  readonly cos: number;
  readonly sin: number;
}

/** What a column of the ground looked like when its height was made (for its materials). */
interface ColumnLook {
  /** Channel: −1 none, else its distance from the channel's middle over its half width. */
  river: number;
  /** In a floodplain (0 … 1). */
  plain: number;
  /** At the foot of steep ground (0 … 1). */
  scree: number;
}

const cubic = new Float64Array(3);

/** The realistic landscape of one world (seed and size): heights, materials and the features that are not a height. */
export class FarLandscape {
  readonly drainage: FarDrainage;
  private readonly arches: Arch[] = [];
  private readonly reaches: RiverReach[] = [];

  constructor(
    readonly half: number,
    readonly seed: number,
  ) {
    this.drainage = farDrainage(half, seed);
    this.placeArches();
  }

  /** The escarpment noise at (x, z): domain-warped so the scarps wind. */
  private scarpNoise(x: number, z: number): number {
    const s = this.seed;
    const wx = x + 500 * (valueNoise01(x / 900, z / 900, s + 51) - 0.5);
    const wz = z + 500 * (valueNoise01(x / 900, z / 900, s + 52) - 0.5);
    return fractalNoise01(wx / SCARP_SCALE, wz / SCARP_SCALE, 3, s + 53);
  }

  /** Where escarpments may stand (0 … 1): the massifs' flanks, fading along their length. */
  private scarpMask(x: number, z: number, massif: number): number {
    return smoothstep(0.08, 0.3, massif) * (1 - smoothstep(0.75, 0.95, massif)) * smoothstep(0.45, 0.6, valueNoise01(x / 2300, z / 2300, this.seed + 54));
  }

  /**
   * The ground's height (cells) at column (x, z) before its half-metre
   * roughness, and what made it (for its look). `look` may be null.
   */
  heightAt(x: number, z: number, look: ColumnLook | null, reaches: readonly RiverReach[] | null): number {
    const risen = risenAt(x, z);
    if (risen === 0) {
      if (look !== null) {
        look.river = -1;
        look.plain = 0;
        look.scree = 0;
      }
      return 0;
    }
    const d = this.drainage;
    const s = this.seed;
    sampleCubic(d, d.height, x, z, cubic);
    let h = cubic[0]!;
    let gx = cubic[1]!;
    let gz = cubic[2]!;
    const slope0 = Math.hypot(gx, gz);
    const massif = sampleLinear(d, d.massif, x, z);
    // Gullies: ridges and furrows running down the slope, each finer set following the slope the coarser left.
    const gullyAmp = smoothstep(0.06, 0.45, slope0);
    if (gullyAmp > 0) {
      for (let o = 0; o < GULLY_WAVES.length; o++) {
        const L = GULLY_WAVES[o]!;
        const g = Math.hypot(gx, gz);
        if (g < 1e-6) break;
        const px = -gz / g;
        const pz = gx / g;
        const ci = Math.floor(x / L);
        const cj = Math.floor(z / L);
        let sum = 0;
        let dsum = 0;
        let wsum = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const hsh = latticeHash(ci + a, cj + b, s + 60 + o);
          const cx = (ci + a + (hsh & 0xffff) / 65536) * L;
          const cz = (cj + b + (hsh >>> 16) / 65536) * L;
          const dx = x - cx;
          const dz = z - cz;
          const r2 = (dx * dx + dz * dz) / (L * L * 2.25);
          if (r2 >= 1) continue;
          const w = (1 - r2) * (1 - r2);
          const phase = ((dx * px + dz * pz) / L) * 2 * Math.PI;
          sum += w * Math.cos(phase);
          dsum += w * -Math.sin(phase) * ((2 * Math.PI) / L);
          wsum += w;
        }
        if (wsum <= 0) continue;
        const amp = GULLY_DEPTH * L * gullyAmp * (o === 0 ? 1 : 0.8);
        // Furrows narrower than ridges: water cuts V-shaped gullies between rounded spurs.
        const v = sum / wsum;
        h += amp * (v > 0 ? v * 0.7 : v * 1.2);
        gx += ((amp * dsum) / wsum) * px * 0.5;
        gz += ((amp * dsum) / wsum) * pz * 0.5;
      }
    }
    // Crags: ridged knobs that steepen what is already steep.
    const cragAmp = smoothstep(0.55, 1.1, slope0);
    if (cragAmp > 0) {
      const n = 1 - Math.abs(2 * fractalNoise01(x / CRAG_SCALE, z / CRAG_SCALE, 3, s + 70) - 1);
      h += CRAG * cragAmp * (n * n - 0.35);
    }
    // Escarpments: one winding step of varying height where the mask allows.
    let scree = 0;
    const sm = this.scarpMask(x, z, massif);
    if (sm > 0) {
      const e = this.scarpNoise(x, z);
      const height = SCARP_MIN + (SCARP_MAX - SCARP_MIN) * valueNoise01(x / 1300, z / 1300, s + 55);
      const width = SCARP_WIDTH * (0.6 + 0.8 * valueNoise01(x / 400, z / 400, s + 56));
      h += sm * height * (smoothstep(0.5 - width, 0.5 + width, e) - 0.5);
      // The scarp's foot (its low side, a little out): talus.
      scree = Math.max(scree, sm * smoothstep(0.5 - 8 * width, 0.5 - 2 * width, e) * (1 - smoothstep(0.5 - width, 0.5, e)));
    }
    h += ROLLING * (fractalNoise01(x / 600, z / 600, 3, s + 2) - 0.5);
    // Rivers: a channel along each reach, a flat floodplain beside the gentle ones.
    let river = -1;
    let plain = 0;
    if (reaches !== null && reaches.length > 0) {
      // The channels meander round the reaches' straight lines.
      const mx = x + MEANDER * (fractalNoise01(x / 140, z / 140, 2, s + 80) - 0.5);
      const mz = z + MEANDER * (fractalNoise01(x / 140, z / 140, 2, s + 81) - 0.5);
      let best = Infinity;
      let floor = Infinity;
      for (const r of reaches) {
        const vx = r.bx - r.ax;
        const vz = r.bz - r.az;
        const len2 = vx * vx + vz * vz;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((mx - r.ax) * vx + (mz - r.az) * vz) / len2)) : 0;
        const dist = Math.hypot(mx - r.ax - vx * t, mz - r.az - vz * t);
        if (dist > r.plain + r.half + 24) continue;
        const bank = r.ha + (r.hb - r.ha) * t;
        // The floodplain: the ground levelled to just over the bank's height, blended out past its edge.
        const p = 1 - smoothstep(r.half + r.plain * 0.6, r.half + r.plain + 24, dist);
        if (p > plain) plain = p;
        // Only ground a little over the bank is levelled: valley sides stand as they are, no cut along the plain's edge.
        const low = 1 - smoothstep(6, 36, h - bank);
        const levelled = h + (bank + 1.5 - h) * p * low;
        // The channel: a rounded cut under the bank.
        const c = 1 - smoothstep(r.half * 0.5, r.half + 3, dist);
        const cut = levelled + (bank - r.depth - levelled) * c;
        if (cut < floor) floor = cut;
        const rel = dist / r.half;
        if (rel < best) best = rel;
      }
      if (floor < h) h = floor;
      if (best < 1.6) river = best;
    }
    if (look !== null) {
      look.river = river;
      look.plain = plain;
      // Below crags: moderate ground with steep ground just above it.
      if (slope0 > 0.25 && slope0 < 0.9) {
        // The gradient points uphill: read the ground 15 m up the slope.
        sampleCubic(d, d.height, x + (gx / slope0) * 30, z + (gz / slope0) * 30, cubic);
        const up = Math.hypot(cubic[1]!, cubic[2]!);
        scree = Math.max(scree, smoothstep(0.75, 1.15, up) * smoothstep(0.25, 0.45, slope0));
      }
      look.scree = scree * (river >= 0 ? 0 : 1);
    }
    return risen * h;
  }

  /** The half-metre roughness (cells) of a column with `rough` 0 (grass) … 1 (bare rock). */
  roughness(x: number, z: number, rough: number): number {
    const n = fractalNoise01(x / 9, z / 9, 3, this.seed + 90) - 0.5;
    return n * (0.5 + 2.6 * rough) * risenAt(x, z);
  }

  private placeArches(): void {
    const s = this.seed;
    const n = Math.ceil(this.half / ARCH_GRID);
    for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
      const hsh = latticeHash(i, j, s + 100);
      if (hsh / 4294967296 >= ARCH_SHARE) continue;
      const hx = latticeHash(i, j, s + 101) / 4294967296;
      const hz = latticeHash(i, j, s + 102) / 4294967296;
      const x = (i + 0.2 + 0.6 * hx) * ARCH_GRID;
      const z = (j + 0.2 + 0.6 * hz) * ARCH_GRID;
      if (Math.abs(x) > this.half - 200 || Math.abs(z) > this.half - 200 || risenAt(x, z) < 0.9) continue;
      sampleCubic(this.drainage, this.drainage.height, x, z, cubic);
      const slope = Math.hypot(cubic[1]!, cubic[2]!);
      if (slope < 0.1 || slope > 0.8) continue;
      const size = 0.5 + 0.5 * (latticeHash(i, j, s + 103) / 4294967296);
      const span = ARCH_SPAN * size;
      // Spanning across the slope, so both feet stand at about the same height.
      const a = Math.atan2(cubic[2]!, cubic[1]!) + Math.PI / 2;
      const ground = this.heightAt(x, z, null, null);
      this.arches.push({ x, y: ground - 0.15 * span, z, span, rib: ARCH_RIB * (0.6 + 0.4 * size), cos: Math.cos(a), sin: Math.sin(a) });
    }
  }

  /** The arches (for reports and tests). */
  get archCount(): number {
    return this.arches.length;
  }

  /**
   * Fills the chunk column at (x0, z0) chunk by chunk: `plan` once a column,
   * then `fill` for each chunk the plan's span says may hold ground.
   */
  plan(grid: ChunkGrid, x0: number, z0: number): LandscapeColumn {
    return new LandscapeColumn(this, grid, x0, z0, this.arches, this.reaches);
  }
}

/** One chunk column of the landscape: its columns' heights, looks, boulders and arches, then its chunks' cells. */
export class LandscapeColumn {
  readonly surface: Float32Array;
  private readonly top: Uint16Array;
  private readonly soil: Uint8Array;
  private readonly wet: Uint8Array;
  private readonly outcrop: Float32Array;
  private readonly boulders: Boulder[] = [];
  private readonly arches: Arch[];
  private readonly warp: CoarseField;
  /** Lowest cell that may not be solid rock, and highest that may be solid (cells). */
  readonly low: number;
  readonly high: number;
  private readonly any3d: boolean;

  constructor(
    private readonly land: FarLandscape,
    private readonly grid: ChunkGrid,
    private readonly x0: number,
    private readonly z0: number,
    allArches: readonly Arch[],
    reaches: RiverReach[],
  ) {
    const e = grid.edge;
    const seed = land.seed;
    const n = e + 2;
    riverReaches(land.drainage, x0 - 1, z0 - 1, x0 + e + 1, z0 + e + 1, reaches);
    const mid = new Float32Array(n * n);
    const looks: ColumnLook[] = [];
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const look: ColumnLook = { river: -1, plain: 0, scree: 0 };
      mid[a * n + b] = land.heightAt(x0 + a - 1, z0 + b - 1, look, reaches);
      looks.push(look);
    }
    this.surface = new Float32Array(e * e);
    this.top = new Uint16Array(e * e);
    this.soil = new Uint8Array(e * e);
    this.wet = new Uint8Array(e * e);
    this.outcrop = new Float32Array(e * e);
    let low = Infinity;
    let high = -Infinity;
    let any3d = false;
    for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
      const x = x0 + lx;
      const z = z0 + lz;
      const at = (dx: number, dz: number): number => mid[(lx + 1 + dx) * n + (lz + 1 + dz)]!;
      const h0 = at(0, 0);
      const slope = Math.hypot(at(1, 0) - at(-1, 0), at(0, 1) - at(0, -1)) / 2;
      const curve = at(1, 0) + at(-1, 0) + at(0, 1) + at(0, -1) - 4 * h0;
      const look = looks[(lx + 1) * n + (lz + 1)]!;
      const n1 = valueNoise01(x / 64, z / 64, seed + 41);
      // Borders wander at 11 m and 32 m: patches of a few metres read as speckle, not as ground, from any distance.
      const n2 = valueNoise01(x / 22, z / 22, seed + 42);
      const k = lx * e + lz;
      // Bare rock past a slope that wanders with the noise and drops with height; sharp ridges (convex) bare sooner.
      const rockAt = 1.2 + 0.5 * (n1 - 0.5) + 0.3 * (n2 - 0.5) - 0.45 * smoothstep(1400, 2800, h0) + Math.max(-0.25, Math.min(0.15, curve * 0.6));
      const rock = smoothstep(rockAt - 0.25, rockAt + 0.15, slope);
      let top: number = MAT.grass;
      let soil = 2 + Math.round(4 * n1);
      let wet = 0;
      const snowAt = SNOW_LINE + 320 * (n1 - 0.5) + 140 * (n2 - 0.5);
      if (look.river >= 0 && look.river < 1) {
        top = MAT.gravel;
        wet = 5;
        soil = 2;
      } else if (look.river >= 0 && look.river < 1.25 + 0.5 * n2) {
        top = n1 > 0.45 ? MAT.sand : MAT.soil;
        wet = 3;
      } else if (slope > rockAt) {
        top = MAT.rock;
        soil = 0;
      } else if (h0 > snowAt && slope < rockAt + 0.05) {
        top = MAT.snow;
        soil = 0;
      } else if (look.scree > 0.3 + 0.35 * (n2 - 0.5) + 0.4 * (n1 - 0.5)) {
        top = MAT.gravel;
        soil = 1;
      } else if (slope > rockAt - 0.25 + 0.2 * (n2 - 0.5)) {
        top = MAT.soil;
        soil = 1;
      } else if (h0 > 1900 + 400 * (n1 - 0.5) && n2 > 0.75 - (h0 - 1900) / 1600) {
        top = MAT.gravel;
        soil = 1;
      } else if (look.plain > 0.5 && n1 + 0.2 * (n2 - 0.5) < 0.38) {
        top = MAT.sand;
        wet = 1;
      } else if (curve > 0.35 && n2 < 0.45) {
        // Hollows collect fine soil and water: bare damp earth.
        top = MAT.soil;
        wet = 1;
      }
      // Roughness follows the slope's bareness and the scree smoothly (a step at a material border would be a seam).
      const h = h0 + this.land.roughness(x, z, Math.max(rock, 0.6 * look.scree));
      this.surface[k] = h;
      this.top[k] = top;
      this.soil[k] = soil;
      this.wet[k] = wet;
      const o = top === MAT.rock ? OUTCROP * (0.4 + 0.6 * rock) : 0;
      this.outcrop[k] = o;
      if (o > 0) any3d = true;
      low = Math.min(low, h - o - 2);
      high = Math.max(high, h + o + 1);
    }
    // Boulders on the lattice cells round the chunk column, more where the ground is scree.
    for (let gi = Math.floor((x0 - BOULDER_MAX) / BOULDER_GRID); gi <= Math.floor((x0 + e + BOULDER_MAX) / BOULDER_GRID); gi++) {
      for (let gj = Math.floor((z0 - BOULDER_MAX) / BOULDER_GRID); gj <= Math.floor((z0 + e + BOULDER_MAX) / BOULDER_GRID); gj++) {
        const h1 = latticeHash(gi, gj, seed + 110);
        const bx = (gi + (h1 & 0xffff) / 65536) * BOULDER_GRID;
        const bz = (gj + (h1 >>> 16) / 65536) * BOULDER_GRID;
        if (risenAt(bx, bz) < 0.6) continue;
        const look: ColumnLook = { river: -1, plain: 0, scree: 0 };
        const gh = land.heightAt(bx, bz, look, reaches);
        if (look.river >= 0 && look.river < 1.2) continue;
        const chance = 0.015 + 0.55 * look.scree;
        if (latticeHash(gi, gj, seed + 111) / 4294967296 >= chance) continue;
        const r = 1 + (BOULDER_MAX - 1) * (latticeHash(gi, gj, seed + 112) / 4294967296) ** 1.5;
        const squash = 0.6 + 0.35 * (latticeHash(gi, gj, seed + 113) / 4294967296);
        // Sunk a third into the ground it rests on.
        const y = gh - 0.35 * r * squash;
        this.boulders.push({ x: bx, y, z: bz, r, squash });
        high = Math.max(high, y + r * squash + 1);
        any3d = true;
      }
    }
    this.arches = allArches.filter((a) => Math.abs(a.x - (x0 + e / 2)) < a.span + a.rib + e && Math.abs(a.z - (z0 + e / 2)) < a.span + a.rib + e);
    for (const a of this.arches) {
      high = Math.max(high, a.y + a.span + a.rib + 1);
      any3d = true;
    }
    this.low = low;
    this.high = high;
    this.any3d = any3d;
    this.warp = new CoarseField(grid, 2);
  }

  /** Writes the chunk at height y0 into `out`; whether it holds anything. */
  fill(out: DenseChunk, y0: number): boolean {
    const { grid, x0, z0 } = this;
    const e = grid.edge;
    const seed = this.land.seed;
    const near3d = this.any3d && y0 + e >= this.low && y0 <= this.high;
    if (near3d) this.warp.sample(x0, y0, z0, (x, y, z) => (fractalNoise01(x / 11, z / 11, 2, seed + 120, y / 9) - 0.5) * 2);
    let any = false;
    for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) {
      const k = lx * e + lz;
      const h = this.surface[k]!;
      const o = this.outcrop[k]!;
      const top = this.top[k]!;
      const soil = this.soil[k]!;
      const x = x0 + lx + 0.5;
      const z = z0 + lz + 0.5;
      for (let ly = 0; ly < e; ly++) {
        const y = y0 + ly;
        const i = localIndex(grid, lx, ly, lz);
        const depth = h - (y + 0.5);
        let fill = y < LANDSCAPE_BASE ? 0 : Math.min(1, Math.max(0, (o > 0 && near3d ? depth + o * this.warp.at(lx, ly, lz) : depth) + 0.5));
        let feature = false;
        if (near3d && y >= LANDSCAPE_BASE) {
          const cy = y + 0.5;
          for (const b of this.boulders) {
            const dx = x - b.x;
            const dz = z - b.z;
            const dy = (cy - b.y) / b.squash;
            if (Math.abs(dx) > b.r + 1 || Math.abs(dz) > b.r + 1) continue;
            const f = Math.min(1, Math.max(0, b.r - Math.hypot(dx, dy, dz) + 0.5));
            if (f > fill) {
              fill = f;
              feature = true;
            }
          }
          for (const a of this.arches) {
            const dx = x - a.x;
            const dz = z - a.z;
            const u = dx * a.cos + dz * a.sin;
            const w = -dx * a.sin + dz * a.cos;
            const v = cy - a.y;
            if (v < -0.2 * a.span) continue;
            const q = Math.hypot(u, v) - a.span;
            const f = Math.min(1, Math.max(0, a.rib - Math.hypot(q, w * 1.3) + 0.5));
            if (f > fill) {
              fill = f;
              feature = true;
            }
          }
        }
        if (fill <= 0) {
          out.material[i] = 0;
          out.role[i] = 0;
          out.shape[i] = 0;
          out.wetness[i] = 0;
          continue;
        }
        // Rock where a feature or an outcrop stands proud of the ground; else the column's layers by depth.
        const layered = depth >= 0 && !feature;
        out.material[i] = !layered ? (feature || o > 0 ? MAT.rock : top) : depth < 1 ? top : depth < 1 + soil ? MAT.soil : MAT.rock;
        out.role[i] = VOXEL_ROLE.terrain;
        out.shape[i] = shapeByte(fill);
        out.wetness[i] = layered && depth < 2 ? this.wet[k]! : 0;
        any = true;
      }
    }
    return any;
  }
}
