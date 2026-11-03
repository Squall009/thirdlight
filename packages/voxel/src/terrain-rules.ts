/**
 * The terrain rule set: what kind of ground feature each exposed ground
 * cell is part of (gentle ground, a steep bank, a cliff, a terrace lip, an
 * overhang, a cave roof, a one-cell wall, a one-cell spike), read from its
 * neighbourhood by thresholds, so the terrain mesher can place vertices and
 * split normals by feature instead of rounding every crease off.
 *
 * It composes with a construction rule set into one {@link AssemblyRuleSet}:
 * one evaluation per job, one radius (the larger of the two), one apron and
 * one invalidation reach, so a world never runs two passes over the same
 * cells. The feature sits in the high nibble of a ground cell's class byte
 * (ground cells carry no run bits), only inside the derive job like every
 * assembly class: nothing is stored, and consumers that mask the class
 * ({@link CLASS_MASK}) see plain ground.
 *
 * What the rules read, all within {@link TERRAIN_RULES_RADIUS} cells:
 * - *solid*: a cell of a non-open role filled to the surface threshold
 *   ({@link SURFACE_ISO}); a wall standing on the ground covers it like
 *   ground does.
 * - *column fill*: the summed fill (0 … 1 a cell, from the 4-bit shape) of
 *   a column over the 2R + 1 cells level with the cell. Differences between
 *   columns are the ground's rise per cell to a fraction of a cell, so a 1:20
 *   slope reads as 0.05 although its solid cells step; a drop past the window
 *   reads as more than R cells.
 * - *exposure*: which of the six face neighbours are not solid. Only solid
 *   ground cells with an exposed face get a feature; buried and partly
 *   filled cells stay {@link TERRAIN_FEATURE.none}.
 *
 * Features are local by design: inside a ledge wider than the radius, its
 * underside reads as a ceiling (a cave roof) and only its lip as an
 * overhang, because nothing within reach tells the two apart.
 */
import { ASSEMBLY_CLASS, CLASS_MASK, OPEN_ROLE, PLACEHOLDER_RULES, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { SURFACE_ISO } from './derived-mesh';
import { DENSITY_FULL, ROLE_MASK, ROLE_SHIFT } from './record';

/** Ground feature classes (the high nibble of a ground cell's class byte). */
export const TERRAIN_FEATURE = Object.freeze({
  /** Not an exposed solid ground cell (buried, partly filled, or not ground). */
  none: 0,
  /** Ground rising less than {@link TERRAIN_THRESHOLDS.steepSlope} a cell. */
  gentle: 1,
  /** A bank between the steep and the cliff slope. */
  steep: 2,
  /** A face rising at least {@link TERRAIN_THRESHOLDS.cliffSlope} a cell, or the top edge of a drop deeper than a terrace riser. */
  cliff: 3,
  /** The top edge of a riser of a terrace: flat ground behind it, a drop of up to {@link TERRAIN_THRESHOLDS.riseMax} cells, flat ground in front. */
  terraceLip: 4,
  /** Open below, where the mass ends within reach with open space above its edge (a ledge's lip, a cave mouth). */
  overhang: 5,
  /** Open below with solid ground all around it within reach: a ceiling. */
  caveRoof: 6,
  /** Open on both sides along one axis: a wall, sheet or fin one cell thick. */
  thin: 7,
  /** Open on both sides along two or three axes: a one-cell column, bar or tip. */
  spike: 8,
});

/** Bit position of the ground feature in a resolved cell byte. */
export const TERRAIN_FEATURE_SHIFT = 4;

/** How far the terrain rules read (Chebyshev, cells): a riser of two cells and the treads either side of it fit. */
export const TERRAIN_RULES_RADIUS = 2;

/**
 * The classification thresholds, in cells of rise per cell of run (slopes)
 * or cells (rises), on the column fill above.
 */
export const TERRAIN_THRESHOLDS = Object.freeze({
  /** Rise per cell from which ground is steep (1:2, about 27°); also the most a terrace tread may rise and stay flat. */
  steepSlope: 0.5,
  /** Rise per cell from which a face is a cliff (2:1, about 63°). */
  cliffSlope: 2,
  /** The least drop at a top edge that is a terrace riser (half a cell: less is ordinary ground). */
  riseMin: 0.5,
  /** The most drop that is a terrace riser (two cells and half a cell of fill): deeper is a cliff's top edge. */
  riseMax: 2.5,
});

/** The ground feature of a resolved cell byte ({@link TERRAIN_FEATURE.none} for any class but ground). */
export function terrainFeatureOf(resolved: number): number {
  return (resolved & CLASS_MASK) === ASSEMBLY_CLASS.ground ? resolved >> TERRAIN_FEATURE_SHIFT : TERRAIN_FEATURE.none;
}

/** Per thread, by neighbourhood size: the fill of every cell, and solid bits per column. */
const fills = new Map<number, Uint8Array>();
const masks = new Map<number, Int32Array>();

function scratch<T>(cache: Map<number, T>, len: number, make: (len: number) => T): T {
  let a = cache.get(len);
  if (a === undefined) {
    a = make(len);
    cache.set(len, a);
  }
  return a;
}

/** The fill (0 … 255, 0 for open roles: what the terrain rules count as solid) of every cell of a neighbourhood. */
function fillOf(n: Neighbourhood): Uint8Array {
  const len = n.values.length;
  const fill = scratch(fills, len, (l) => new Uint8Array(l));
  // Read as int32: values past 2^31 would be heap numbers in the loop; the role bits are the same either way.
  const vals = new Int32Array(n.values.buffer, n.values.byteOffset, len);
  const shapes = n.shapes;
  for (let j = 0; j < len; j++) fill[j] = OPEN_ROLE[(vals[j]! >> ROLE_SHIFT) & ROLE_MASK] === 1 ? 0 : shapes[j]!;
  return fill;
}

/** Column fill (cells) of the column through padded cell `j`: its summed fill over the 2R + 1 cells level with it. */
function columnFill(fill: Uint8Array, j: number): number {
  let sum = 0;
  for (let dy = -TERRAIN_RULES_RADIUS; dy <= TERRAIN_RULES_RADIUS; dy++) sum += fill[j + dy]!;
  return sum / DENSITY_FULL;
}

/** Cells of a column handled per pass of solid bits: with a cell below and above, 30 bits of an int32. */
const BIT_BLOCK = 28;

/**
 * False when no ground cell of the box can be exposed: the box holds no
 * solid ground, or the whole neighbourhood is one value (deep ground, open
 * sky). Most sections of a world are one of the two, and skip the fill pass.
 */
function mayHaveExposedGround(n: Neighbourhood, lo: number, hi: number, out: Uint8Array): boolean {
  const s = n.side;
  let ground = false;
  for (let x = lo; x < hi && !ground; x++) for (let z = lo; z < hi && !ground; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      if (out[row + y] === ASSEMBLY_CLASS.ground && n.shapes[row + y]! >= SURFACE_ISO) {
        ground = true;
        break;
      }
    }
  }
  if (!ground) return false;
  const vals = n.values;
  const v0 = vals[0]!;
  for (let j = 1; j < vals.length; j++) if (vals[j] !== v0) return true;
  return false;
}

/**
 * The ground feature of an exposed solid cell `i` of a neighbourhood of
 * side `s` given its fill ({@link fillOf}) and which faces are open. Reads
 * cells within {@link TERRAIN_RULES_RADIUS} of it.
 */
function exposedFeature(fill: Uint8Array, s: number, i: number, xm: boolean, xp: boolean, zm: boolean, zp: boolean, below: boolean, above: boolean): number {
  const SX = s * s;
  const SZ = s;
  const R = TERRAIN_RULES_RADIUS;
  const T = TERRAIN_THRESHOLDS;
  const side = xm || xp || zm || zp;
  const thinAxes = (xm && xp ? 1 : 0) + (zm && zp ? 1 : 0) + (below && above ? 1 : 0);
  if (thinAxes >= 2) return TERRAIN_FEATURE.spike;
  if (thinAxes === 1) return TERRAIN_FEATURE.thin;
  if (below) {
    // A ceiling whose mass ends within reach, with open space above the end, is a lip over open ground.
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      if (dx === 0 && dz === 0) continue;
      const j = i + dx * SX + dz * SZ;
      let dy = 0;
      while (dy <= R && fill[j + dy]! < SURFACE_ISO) dy++;
      if (dy > R) return TERRAIN_FEATURE.overhang;
    }
    return TERRAIN_FEATURE.caveRoof;
  }
  const t0 = columnFill(fill, i);
  if (above && side) {
    // A top edge: a riser of a terrace when the ground is flat behind and in front of the drop, a cliff's top past it.
    let lip = false;
    for (let d = 0; d < 4; d++) {
      if (!(d === 0 ? xm : d === 1 ? xp : d === 2 ? zm : zp)) continue;
      const step = d < 2 ? SX : SZ;
      const dir = (d & 1) === 0 ? -step : step;
      const front = columnFill(fill, i + dir);
      const drop = t0 - front;
      if (drop > T.riseMax) return TERRAIN_FEATURE.cliff;
      if (drop >= T.riseMin && Math.abs(columnFill(fill, i - dir) - t0) < T.steepSlope && Math.abs(columnFill(fill, i + 2 * dir) - front) < T.steepSlope) lip = true;
    }
    if (lip) return TERRAIN_FEATURE.terraceLip;
  }
  // The rise per cell: across the cell where a face is exposed sideways; on top-only ground, the flatter of the two
  // sides, so ground at a crease (a cliff's foot, a tread before a riser) is its own flat ground.
  const xl = columnFill(fill, i - SX);
  const xr = columnFill(fill, i + SX);
  const zl = columnFill(fill, i - SZ);
  const zr = columnFill(fill, i + SZ);
  const gx = side ? (xr - xl) / 2 : Math.min(Math.abs(xr - t0), Math.abs(t0 - xl));
  const gz = side ? (zr - zl) / 2 : Math.min(Math.abs(zr - t0), Math.abs(t0 - zl));
  // Squared (Math.hypot is slow in the hot loop).
  const slope2 = gx * gx + gz * gz;
  if (slope2 >= T.cliffSlope * T.cliffSlope) return TERRAIN_FEATURE.cliff;
  if (slope2 >= T.steepSlope * T.steepSlope) return TERRAIN_FEATURE.steep;
  return TERRAIN_FEATURE.gentle;
}

/**
 * A construction rule set with the terrain features added: the construction
 * rules resolve every cell, then each ground cell gets its feature. Its
 * radius is the larger of the two; its id and version name the pair, so a
 * change to either part takes a new version here.
 */
export function withTerrainFeatures(construction: AssemblyRuleSet, id: string, version: number): AssemblyRuleSet {
  return Object.freeze({
    id,
    version,
    radius: Math.max(construction.radius, TERRAIN_RULES_RADIUS),
    resolve(n: Neighbourhood, lo: number, hi: number, out: Uint8Array): void {
      construction.resolve(n, lo, hi, out);
      if (!mayHaveExposedGround(n, lo, hi, out)) return;
      const fill = fillOf(n);
      const s = n.side;
      // Exposed solid cells found a column at a time: bit k of a column's mask is the cell base + k solid, so a cell
      // is covered when it and its six neighbours' bits are set.
      const w = hi - lo + 2;
      const m = scratch(masks, w * w, (l) => new Int32Array(l));
      for (let y0 = lo; y0 < hi; y0 += BIT_BLOCK) {
        const y1 = Math.min(hi, y0 + BIT_BLOCK);
        const base = y0 - 1;
        const bits = y1 - y0 + 2;
        for (let x = 0; x < w; x++) for (let z = 0; z < w; z++) {
          const col = ((x + lo - 1) * s + (z + lo - 1)) * s + base;
          let mask = 0;
          for (let k = 0; k < bits; k++) if (fill[col + k]! >= SURFACE_ISO) mask |= 1 << k;
          m[x * w + z] = mask;
        }
        const inner = ((1 << (bits - 1)) - 1) & ~1;
        for (let x = 1; x < w - 1; x++) for (let z = 1; z < w - 1; z++) {
          const c = x * w + z;
          const mc = m[c]!;
          const mxm = m[c - w]!;
          const mxp = m[c + w]!;
          const mzm = m[c - 1]!;
          const mzp = m[c + 1]!;
          let exposed = mc & ~((mc << 1) & (mc >>> 1) & mxm & mxp & mzm & mzp) & inner;
          while (exposed !== 0) {
            const k = 31 - Math.clz32(exposed & -exposed);
            exposed &= exposed - 1;
            const i = ((x + lo - 1) * s + (z + lo - 1)) * s + base + k;
            if (out[i] !== ASSEMBLY_CLASS.ground) continue;
            const bit = 1 << k;
            const f = exposedFeature(fill, s, i, (mxm & bit) === 0, (mxp & bit) === 0, (mzm & bit) === 0, (mzp & bit) === 0, (mc & (bit >>> 1)) === 0, (mc & (bit << 1)) === 0);
            out[i] = ASSEMBLY_CLASS.ground | (f << TERRAIN_FEATURE_SHIFT);
          }
        }
      }
    },
  });
}

/**
 * The world rule set: the placeholder construction rules with the terrain
 * features. Version 1 is placeholder rules version 2 with the first terrain
 * thresholds.
 */
export const TERRAIN_RULES: AssemblyRuleSet = withTerrainFeatures(PLACEHOLDER_RULES, 'terrain', 1);
