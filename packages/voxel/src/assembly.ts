/**
 * The shared assembly evaluation: one pass that reads the authoritative
 * voxels around a chunk and resolves, per cell, what the arrangement is
 * (a wall body, ground, a beam, a rail, liquid). Every derived consumer
 * (render surfaces and detail instances, collision, navigation, light
 * occupancy) reads these resolved classes, never the raw voxels alone, so
 * an open rail is a rail for all of them at once and none of them has to
 * repeat the rules.
 *
 * Stored voxels carry only coarse intent (material, role, shape,
 * wetness); beams and rails are not stored anywhere. They are read
 * from the arrangement by a rule set, which is pluggable and versioned and
 * declares how far it looks (its radius R, Chebyshev, in cells). A derived
 * result names the rule set and version it came from, and a job that
 * evaluates a chunk needs the cells up to R beyond the chunk plus the
 * consumers' reach (one cell: a face, a support, a run neighbour) beyond
 * that, so its apron is R + {@link CONSUMER_REACH} deep.
 *
 * Nothing about how the voxels were written (a structure tool or a
 * runtime brush) reaches the evaluation: the same voxels give the same
 * classes.
 */
import { APRON_STRIPS, checkApron, type Apron } from './apron';
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { denseValue } from './cell-delta';
import type { EdgeMasks } from './edge-cases';
import type { CaseCatalogueDef } from './kit-cases';
import type { PieceTable } from './piece-table';
import { valueDensity, valueRole, VOXEL_ROLE } from './record';

/** Resolved classes (the low 4 bits of a resolved cell byte). */
export const ASSEMBLY_CLASS = Object.freeze({
  /** Air (or nothing that occupies the cell). */
  empty: 0,
  /** A modular body: a wall, floor or roof cell drawn by the base surface, a full box for collision. */
  wall: 1,
  /** Projected ground: drawn by the smooth surface from its density. */
  ground: 2,
  /** A thin member one cell out of a wall with air above and below. */
  beam: 3,
  /** A low, thin, exposed run on a floor or ground: a banister, rail, fence or its post. */
  rail: 4,
  /** Liquid (meshed and simulated by the liquid systems, not here). */
  liquid: 5,
});

/** Mask of the class in a resolved cell byte. */
export const CLASS_MASK = 0x0f;
/** Resolved-cell bit: the feature runs along x. */
export const RUN_X = 0x10;
/** Resolved-cell bit: the feature runs along z (both bits: a post, thin both ways). */
export const RUN_Z = 0x20;

/** Cells beyond the chunk a consumer reads resolved classes of (a neighbour's face, a support below, a run neighbour). */
export const CONSUMER_REACH = 1;

/**
 * The cells around one chunk, as plain arrays over a padded cube of side
 * `side` = edge + 2·pad (pad = rule radius + consumer reach), index
 * (x·side + z)·side + y, y fastest, chunk cell l at padded l + pad.
 */
export interface Neighbourhood {
  readonly edge: number;
  readonly pad: number;
  readonly side: number;
  /** Voxel values (record.ts). */
  readonly values: Uint32Array;
  /**
   * Density per cell, 0 … 255 (the value's fill on the consumers' scale,
   * {@link valueDensity}): a construction cell's shape is its integrity, so
   * it reads full at any integrity; the value keeps the integrity itself.
   */
  readonly shapes: Uint8Array;
}

/** A pluggable, versioned assembly rule set. */
export interface AssemblyRuleSet {
  readonly id: string;
  readonly version: number;
  /** How far (Chebyshev, cells) a rule reads from the cell it resolves. */
  readonly radius: number;
  /**
   * Resolves every cell of the box [lo, hi) (padded coordinates, the same
   * bounds on all three axes) into `out` (same indexing as the
   * neighbourhood). Reads only cells within `radius` of the cell resolved.
   */
  resolve(n: Neighbourhood, lo: number, hi: number, out: Uint8Array): void;
  /**
   * Optional: the detail case of every cell of the same box into `out` (a
   * u16 a cell beside the class byte, same indexing: kit-cases.ts's packed
   * case, or its NO_CASE), for a node of chunk-tree level `level` (0: a
   * chunk). Like classes, cases live only inside the derive job. Reads only
   * cells within `radius`. Returns the cells given a case. A set without it
   * gives no cell a case (kit-rules.ts `evaluateCases`).
   */
  resolveCases?(n: Neighbourhood, lo: number, hi: number, level: number, out: Uint16Array): number;
  /**
   * Optional, beside `resolveCases`: per case index, the case's declared
   * shape and base (case-forms.ts form bytes without the transform), which
   * every consumer reads in place of the class for a cell with a case.
   */
  readonly caseForms?: Uint8Array;
  /** Optional, beside `resolveCases`: the case catalogue its case indices number (what a kit piece table is built against). */
  readonly catalogue?: CaseCatalogueDef;
  /**
   * Optional: the edge and corner pieces (edge-cases.ts masks) every cell of
   * the box [lo, hi) owns, for a node of chunk-tree level `level`. Reads
   * only cells within `radius`. Returns the cells owning a piece. A set
   * without it places no edge piece. `table` decides which damaged cells
   * are holes (their kits' damage stages; null or absent: the engine's).
   */
  resolveEdges?(n: Neighbourhood, lo: number, hi: number, level: number, out: EdgeMasks, table?: PieceTable | null): number;
}

/** What a derived result records about the rules it came from. */
export interface AssemblyRulesRef {
  readonly id: string;
  readonly version: number;
  readonly radius: number;
}

/** The apron depth a derive job needs for a rule set: its radius plus the consumers' reach. */
export function jobRadius(rules: { readonly radius: number }): number {
  return rules.radius + CONSUMER_REACH;
}

/** A neighbourhood for an edge and pad (arrays allocated, all air). */
export function createNeighbourhood(edge: number, pad: number): Neighbourhood {
  const side = edge + 2 * pad;
  const n = side * side * side;
  return { edge, pad, side, values: new Uint32Array(n), shapes: new Uint8Array(n) };
}

/** Bands of an apron strip index: x, z, y (0 below, 1 inside, 2 above), in the apron's strip order. */
const STRIP_BANDS: Array<[number, number, number]> = [];
for (let bx = 0; bx < 3; bx++) for (let bz = 0; bz < 3; bz++) for (let by = 0; by < 3; by++) if (!(bx === 1 && by === 1 && bz === 1)) STRIP_BANDS.push([bx, bz, by]);

/**
 * Fills a neighbourhood from a chunk's cells (null: air) and its apron,
 * which must be exactly `pad` deep. The chunk's cells land in the middle,
 * each strip in its slab.
 */
export function fillNeighbourhood(n: Neighbourhood, grid: ChunkGrid, chunk: DenseChunk | null, apron: Apron): void {
  const e = grid.edge;
  const p = n.pad;
  const s = n.side;
  if (n.edge !== e || apron.edge !== e || apron.radius !== p) throw new RangeError(`neighbourhood: edge ${n.edge}/${apron.edge} vs ${e}, apron ${apron.radius} deep for a pad of ${p}`);
  checkApron(apron);
  const vals = n.values;
  const shapes = n.shapes;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const row = ((x + p) * s + (z + p)) * s + p;
    if (chunk === null) {
      vals.fill(0, row, row + e);
      shapes.fill(0, row, row + e);
      continue;
    }
    const src = ((x << grid.shift) | z) << grid.shift;
    for (let y = 0; y < e; y++) {
      const v = denseValue(chunk, src + y);
      vals[row + y] = v;
      shapes[row + y] = valueDensity(v);
    }
  }
  const start = (b: number): number => (b === 0 ? 0 : b === 1 ? p : p + e);
  const size = (b: number): number => (b === 1 ? e : p);
  for (let k = 0; k < APRON_STRIPS; k++) {
    const [bx, bz, by] = STRIP_BANDS[k]!;
    const x0 = start(bx);
    const z0 = start(bz);
    const y0 = start(by);
    const sx = size(bx);
    const sz = size(bz);
    const sy = size(by);
    if (sx === 0 || sy === 0 || sz === 0) continue;
    if (apron.dense[k] === 0) {
      const value = apron.uniform[k]!;
      const shape = valueDensity(value);
      for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
        const row = ((x0 + x) * s + (z0 + z)) * s + y0;
        vals.fill(value, row, row + sy);
        shapes.fill(shape, row, row + sy);
      }
      continue;
    }
    let i = apron.offsets[k]!;
    for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
      const row = ((x0 + x) * s + (z0 + z)) * s + y0;
      for (let y = 0; y < sy; y++, i++) {
        const v = apron.values[i]!;
        vals[row + y] = v;
        shapes[row + y] = valueDensity(v);
      }
    }
  }
}

/**
 * The placeholder rule set: just enough cases to prove the contract (a
 * wall, a beam, a banister and its posts, a fence), not the case
 * catalogue, which belongs to the role spec.
 *
 * Roles group as: *built* (wall, floor, foundation, stair, pillar), the
 * cells the rules read beams and rails from; roof; terrain; liquid; and
 * *open* (air, liquid, opening: an opening is a gap whose door or window
 * is a kit piece, not a body).
 *
 * - **beam**: a built cell with open cells above and below, a wall
 *   body (three built cells stacked) on one horizontal side and an
 *   open cell on the opposite side. It runs across that side's axis.
 * - **rail**: a *thin* built cell (open on both sides along x or
 *   along z) with an open cell above, standing on a support (a solid cell
 *   that is not itself thin: a floor, ground), on a post that stands on a
 *   support, or across one open cell from a support (a rail between
 *   posts). A **post** (rail class, thin both ways) stands on a support
 *   under such a rail cell. Anything stacked on the rail makes the run a
 *   wall: extending a banister upward turns it into one.
 * - any other built or roof cell is a **wall**; terrain is **ground**;
 *   liquid is **liquid**; an opening is **empty**.
 *
 * Beams and rails are classes only (counted, read by tests and benchmarks):
 * every consumer draws, collides and lights their cells as plain voxels,
 * like walls (case-forms.ts `classForm`); no piece replaces them.
 *
 * Reads stay within 2 cells (Chebyshev) of the cell resolved.
 */
export const PLACEHOLDER_RULES: AssemblyRuleSet = Object.freeze({
  id: 'placeholder',
  version: 2,
  radius: 2,
  resolve(n: Neighbourhood, lo: number, hi: number, out: Uint8Array): void {
    const s = n.side;
    const SX = s * s;
    const SZ = s;
    const vals = n.values;
    const role = (i: number): number => valueRole(vals[i]!);
    const open = (i: number): boolean => OPEN_ROLE[role(i)] === 1;
    const construction = (i: number): boolean => BUILT_ROLE[role(i)] === 1;
    const thinX = (i: number): boolean => open(i - SX) && open(i + SX);
    const thinZ = (i: number): boolean => open(i - SZ) && open(i + SZ);
    const thin = (i: number): boolean => construction(i) && (thinX(i) || thinZ(i));
    const wallBody = (i: number): boolean => construction(i) && construction(i - 1) && construction(i + 1);
    const support = (i: number): boolean => !open(i) && !thin(i);
    const post = (i: number): boolean => construction(i) && thinX(i) && thinZ(i) && support(i - 1);
    for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) {
      const i = (x * s + z) * s + y;
      const c = role(i);
      if (c === VOXEL_ROLE.air || c === VOXEL_ROLE.opening) {
        out[i] = ASSEMBLY_CLASS.empty;
        continue;
      }
      if (c === VOXEL_ROLE.terrain) {
        out[i] = ASSEMBLY_CLASS.ground;
        continue;
      }
      if (c === VOXEL_ROLE.liquid) {
        out[i] = ASSEMBLY_CLASS.liquid;
        continue;
      }
      if (BUILT_ROLE[c] !== 1) {
        out[i] = ASSEMBLY_CLASS.wall;
        continue;
      }
      if (open(i - 1) && open(i + 1)) {
        // Beam: a wall body on one side, open on the other; it runs across that axis.
        if ((wallBody(i + SZ) && open(i - SZ)) || (wallBody(i - SZ) && open(i + SZ))) {
          out[i] = ASSEMBLY_CLASS.beam | RUN_X;
          continue;
        }
        if ((wallBody(i + SX) && open(i - SX)) || (wallBody(i - SX) && open(i + SX))) {
          out[i] = ASSEMBLY_CLASS.beam | RUN_Z;
          continue;
        }
      }
      const tx = thinX(i);
      const tz = thinZ(i);
      if (tx || tz) {
        const top = open(i + 1);
        // A rail's top cell stands on a support, on a post on a support, or spans one open cell (between posts).
        const rail = top && (support(i - 1) || post(i - 1) || (open(i - 1) && support(i - 2)));
        // A post: thin both ways, on a support, under a rail's top cell.
        const isPost = tx && tz && !top && support(i - 1) && thin(i + 1) && open(i + 2);
        if (rail || isPost) {
          // Thin across x: the run goes along z; thin across z: along x; both: a post.
          out[i] = ASSEMBLY_CLASS.rail | (tz ? RUN_X : 0) | (tx ? RUN_Z : 0);
          continue;
        }
      }
      out[i] = ASSEMBLY_CLASS.wall;
    }
  },
});

/** Per role: 1 when the placeholder rules read beams and rails from it. */
const BUILT_ROLE = roleTable([VOXEL_ROLE.wall, VOXEL_ROLE.floor, VOXEL_ROLE.foundation, VOXEL_ROLE.stair, VOXEL_ROLE.pillar]);
/** Per role: 1 when the assembly rules treat the cell as open (air, liquid, an opening): nothing stands on it or against it. */
export const OPEN_ROLE = roleTable([VOXEL_ROLE.air, VOXEL_ROLE.liquid, VOXEL_ROLE.opening]);

function roleTable(roles: readonly number[]): Uint8Array {
  const t = new Uint8Array(16);
  for (const r of roles) t[r] = 1;
  return t;
}

/** A rule set's reference (what a derived result records). */
export function rulesRef(rules: AssemblyRuleSet): AssemblyRulesRef {
  return { id: rules.id, version: rules.version, radius: rules.radius };
}

/**
 * The one assembly evaluation of a chunk: resolves the chunk's cells and a
 * margin of {@link CONSUMER_REACH} around them (what consumers read) into
 * `out` (neighbourhood-indexed; cells outside that box are left as they
 * are). The neighbourhood's pad must be the rule radius + the reach.
 */
export function evaluateAssembly(n: Neighbourhood, rules: AssemblyRuleSet, out: Uint8Array): void {
  if (n.pad !== jobRadius(rules)) throw new RangeError(`neighbourhood pad ${n.pad} for rules of radius ${rules.radius} (needs ${jobRadius(rules)})`);
  if (out.length !== n.values.length) throw new RangeError('resolved cells: wrong length');
  rules.resolve(n, n.pad - CONSUMER_REACH, n.pad + n.edge + CONSUMER_REACH, out);
}
