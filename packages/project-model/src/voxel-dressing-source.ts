/**
 * The voxel source of the rule scatter core: a voxel grid's surfaces as a
 * `ScatterSurface` (scatter.ts), and from it the cover a chunk grows, the
 * species of the dressings its surface materials name, as the point sets
 * the ground-cover path draws (cover-points.ts).
 *
 * **One surface, every floor.** The surface is read from a box of cells
 * through the surface fields (`@thirdlight/voxel` surface-fields.ts): `at`
 * answers a column's highest surface, `under` each one below it in turn
 * (a storey's floor, a cave's floor), so a candidate is offered every floor
 * of its column and each floor is judged by its own fields.
 *
 * **Who grows where.** A surface grows a species when its cell's material
 * names the species' dressing (instance chains folded in, voxel-materials.ts
 * `voxelDressingIds`), no prop keeps the point clear, and the species'
 * conditions (the one arithmetic of dressing-rules.ts) give a share above 0.
 * A share under 1 keeps that share of the candidates, picked by a hash of
 * the candidate's own point and floor, so a plant's fate never depends on
 * which chunk asked. The core is told through the one condition it already
 * has for a source's own answer, the share of a material layer: layer
 * {@link GROWS_LAYER} is 1 where the species grows and 0 elsewhere.
 *
 * **A chunk's cover** ({@link voxelCoverPoints}) is made from the chunk's
 * column and the eight columns round it, whole (the box the surface fields
 * job reads, with the ring widened to a chunk): a candidate up to a cover
 * species' largest spacing outside the chunk is judged from the same cells
 * its own chunk judges it from, so neighbouring chunks agree on who keeps a
 * place and the same world gives the same points whatever order its chunks
 * are made in. A point belongs to the chunk that holds its surface's cell.
 * The work is a pure function of plain data, so it runs in a worker as it
 * runs on the page.
 *
 * The `large` class is stored and never placed here.
 *
 * Nothing is stored: the point sets are derived, made again when the
 * voxels, a dressing or a material's dressing change.
 *
 * Pure: no I/O, no three.js.
 */
import { seedCellHash } from '@thirdlight/shared';
import {
  clearedByProp,
  dressingRule,
  dressingShare,
  fillLevel,
  SHAPE_FULL,
  SURFACE_DISTANCE_CAP_M,
  surfaceFieldsCells,
  surfaceFieldsOf,
  surfaceNormal,
  surfacePointOut,
  surfaceRows,
  surfaceTable,
  valueMaterial,
  valueRole,
  valueShape,
  VOXEL_COVER_JOB,
  type DressingRule,
  type JobHandlers,
  type SurfaceCells,
  type SurfaceFieldsInput,
  type SurfacePoint,
  type SurfaceTable,
} from '@thirdlight/voxel';
import { bakeCoverPoints, COVER_POINT_FLOATS, type CoverPointSet } from './cover-points';
import { dressingSpeciesRule, namedDressings, type DressingDef, type DressingSpecies } from './dressing';
import { scatterRuleSeed, type ScatterGround, type ScatterRect, type ScatterRule, type ScatterSurface } from './scatter';
import { voxelDressingIds, type BindableMaterial } from './voxel-materials';

/** The material layer whose share the voxel surface answers with whether a species grows (1) or not (0). */
const GROWS_LAYER = 0;

/** The hash lane of the share's pick, apart from the lanes the scatter core draws a candidate's jitter, size and turn from. */
const SHARE_LANE = 0x5eed;

/** Steps a metre a candidate's point is told apart by in the share's pick (two candidates of one species are never this close). */
const SHARE_POINT_STEPS = 1024;

/** One dressing as a cover job reads it: its id and its species, as stored. */
export interface VoxelCoverDressing {
  readonly dressingId: string;
  readonly species: readonly DressingSpecies[];
}

/**
 * What a cover job is told of the project: the dressings some voxel
 * material names, and which one each voxel material id grows (pairs of a
 * voxel material id and an index into `dressings`). Plain data: it is sent
 * to a worker as it is.
 */
export interface VoxelCoverTable {
  readonly dressings: readonly VoxelCoverDressing[];
  readonly materials: readonly (readonly [number, number])[];
}

/** The cover table of a content block: every dressing a voxel material names, its own or its instance chain's. */
export function voxelCoverTable(content: { readonly materials?: readonly BindableMaterial[]; readonly dressings?: readonly DressingDef[] } | null | undefined): VoxelCoverTable {
  const dressings = namedDressings(content).map((d) => ({ dressingId: d.dressingId, species: d.species }));
  const index = new Map(dressings.map((d, i) => [d.dressingId, i]));
  const materials: [number, number][] = [];
  for (const [id, dressing] of voxelDressingIds(content?.materials ?? [])) {
    const i = index.get(dressing);
    if (i !== undefined) materials.push([id, i]);
  }
  materials.sort((a, b) => a[0] - b[0]);
  return { dressings, materials };
}

/** A box's surfaces with what was read of them so far: each surface's fields once, whichever species asks. */
export interface VoxelSurfaceReader {
  readonly table: SurfaceTable;
  /** A surface's fields (box column and row); `distances`: with the two distance fields. The object is the reader's: read it before the next call. */
  fields(x: number, z: number, row: number, distances: boolean): SurfacePoint;
  /** A surface's unit normal, into `out`. */
  normal(x: number, z: number, row: number, out: number[]): void;
}

/** A reader over a box of cells (its table made once). */
export function voxelSurfaceReader(cells: SurfaceCells): VoxelSurfaceReader {
  const table = surfaceTable(cells);
  const { sy, sz } = cells;
  const known = new Map<number, SurfacePoint>();
  const normals = new Map<number, [number, number, number]>();
  const scratch: number[] = [0, 0, 0];
  return {
    table,
    fields(x, z, row, distances) {
      const key = (x * sz + z) * sy + row;
      let p = known.get(key);
      if (p === undefined) {
        p = surfaceFieldsOf(table, x, z, row, distances, surfacePointOut());
        known.set(key, p);
      } else if (distances && Number.isNaN(p.materialEdge)) surfaceFieldsOf(table, x, z, row, true, p);
      return p;
    },
    normal(x, z, row, out) {
      const key = (x * sz + z) * sy + row;
      let n = normals.get(key);
      if (n === undefined) {
        surfaceNormal(table, x, z, row, scratch);
        n = [scratch[0]!, scratch[1]!, scratch[2]!];
        normals.set(key, n);
      }
      out[0] = n[0];
      out[1] = n[1];
      out[2] = n[2];
    },
  };
}

/** What makes a voxel surface one species' surface. */
export interface VoxelSpeciesSurface {
  /** The species' conditions, ready to check. */
  readonly rule: DressingRule;
  /** The seed of the species' share pick (the scatter rule's own seed: `scatterRuleSeed`). */
  readonly seed: number;
  /** Whether a surface cell's voxel material grows this species' dressing. */
  grows(material: number): boolean;
  /** Props' boxes rule plants keep clear of (`@thirdlight/voxel` `propClearances`; absent: none). */
  readonly clear?: Float32Array;
}

/**
 * A box of voxel cells as one species' scatter surface, in the grid's own
 * metres: every surface of a column in turn, layer {@link GROWS_LAYER}
 * saying whether the species grows on it.
 */
export function voxelScatterSurface(reader: VoxelSurfaceReader, species: VoxelSpeciesSurface): ScatterSurface {
  const t = reader.table;
  const { sx, sy, sz, ox, oy, oz, cellM, values } = t.cells;
  const n: number[] = [0, 1, 0];
  let grows = 0;
  const ground: ScatterGround = { x: 0, y: 0, z: 0, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: (layer) => (layer === GROWS_LAYER ? grows : 0) };
  const heightOf = (c: number, row: number): number => {
    const v = values[c * sy + row]!;
    return (oy + row + fillLevel(valueRole(v), valueShape(v)) / SHAPE_FULL) * cellM;
  };
  /** The ground of box surface (cx, cz, row) for the point (x, z). */
  const answer = (x: number, z: number, cx: number, cz: number, row: number): ScatterGround => {
    const c = cx * sz + cz;
    ground.x = x;
    ground.z = z;
    ground.y = heightOf(c, row);
    ground.slope = 0;
    ground.nx = 0;
    ground.ny = 1;
    ground.nz = 0;
    grows = 0;
    if (!species.grows(valueMaterial(values[c * sy + row]!)) || clearedByProp(species.clear, x, ground.y, z)) return ground;
    const p = reader.fields(cx, cz, row, species.rule.distances);
    const share = dressingShare(species.rule, p, x, z);
    // A share of the candidates, each picked by its own point and floor: the same pick from whichever chunk asks.
    if (share <= 0 || (share < 1 && seedCellHash(species.seed ^ Math.imul(oy + row, 0x9e3779b1), Math.round(x * SHARE_POINT_STEPS), Math.round(z * SHARE_POINT_STEPS), SHARE_LANE) / 4294967296 >= share)) return ground;
    reader.normal(cx, cz, row, n);
    ground.slope = p.slope;
    ground.nx = n[0]!;
    ground.ny = n[1]!;
    ground.nz = n[2]!;
    grows = 1;
    return ground;
  };
  const column = (x: number, z: number): [number, number] | null => {
    const cx = Math.floor(x / cellM) - ox;
    const cz = Math.floor(z / cellM) - oz;
    return cx < 0 || cz < 0 || cx >= sx || cz >= sz ? null : [cx, cz];
  };
  return {
    at(x, z) {
      const col = column(x, z);
      if (col === null) return null;
      const rows = surfaceRows(t, col[0], col[1]);
      return rows.length === 0 ? null : answer(x, z, col[0], col[1], rows[rows.length - 1]!);
    },
    under(x, z, y) {
      const col = column(x, z);
      if (col === null) return null;
      const rows = surfaceRows(t, col[0], col[1]);
      const c = col[0] * sz + col[1];
      for (let i = rows.length - 1; i >= 0; i--) if (heightOf(c, rows[i]!) < y) return answer(x, z, col[0], col[1], rows[i]!);
      return null;
    },
  };
}

/** The rule the core bakes a species by: its placement, and the one condition that asks the surface whether it grows. */
function bakedRule(rule: ScatterRule): ScatterRule {
  return { ...rule, layers: [{ layer: GROWS_LAYER, min: 1 }] };
}

/** A cover job: a chunk column's cells and the columns round it, and what grows on them. */
export interface VoxelCoverInput {
  /**
   * The chunk column and the eight round it, level 0, every chunk that holds
   * anything (the surface fields job's input: `surfaceFieldsInputOf`). A
   * column left out is read as air, so a chunk's cover is final only once
   * the columns round it are sent with it.
   */
  readonly fields: SurfaceFieldsInput;
  /** The chunk rows (cy, first and last) whose points are answered (absent: every row of the column). */
  readonly rows?: readonly [number, number];
  readonly table: VoxelCoverTable;
  /** Props' boxes rule plants keep clear of, in the grid's metres (`propClearances`; absent: none). */
  readonly clear?: Float32Array;
}

/** One species' points over a chunk column (or the rows asked of it). */
export interface VoxelCoverSet {
  /** The dressing and the species' place in its list. */
  readonly dressing: string;
  readonly species: number;
  /** The species as the ground-cover path draws it: its model, sizes, turn and lean. */
  readonly rule: ScatterRule;
  /** Its points, in the grid's own metres (the point-set path's form, cover-points.ts). */
  readonly points: CoverPointSet;
}

export interface VoxelCoverOutput {
  /** The species that grow something here, by dressing (the table's order), then by their place in its list. */
  readonly sets: VoxelCoverSet[];
}

/** The row of the surface a point of height `y` stands on (a surface's height lies in its row, above its floor). */
function surfaceRowOfHeight(y: number, cellM: number): number {
  return Math.ceil(y / cellM - 1e-6) - 1;
}

/** The points of a set whose surface lies in chunk rows `cy0 … cy1` (chunks of `edge` cells), in the set's order. */
function pointsInRows(set: CoverPointSet, cellM: number, edge: number, cy0: number, cy1: number): CoverPointSet {
  const kept: number[] = [];
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < set.count; i++) {
    const y = set.data[i * COVER_POINT_FLOATS + 1]!;
    const cy = Math.floor(surfaceRowOfHeight(y, cellM) / edge);
    if (cy < cy0 || cy > cy1) continue;
    kept.push(i);
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  if (kept.length === set.count) return set;
  const data = new Float32Array(kept.length * COVER_POINT_FLOATS);
  kept.forEach((i, k) => data.set(set.data.subarray(i * COVER_POINT_FLOATS, (i + 1) * COVER_POINT_FLOATS), k * COVER_POINT_FLOATS));
  return { x0: set.x0, z0: set.z0, w: set.w, d: set.d, low: kept.length > 0 ? low : 0, high: kept.length > 0 ? high : 0, count: kept.length, data };
}

/**
 * The cover of a chunk column from a box of its cells: each cover species
 * of the dressings its surfaces' materials name, over `rect` (the chunk's
 * footprint in the grid's metres). The box must reach a cover species'
 * largest spacing and the surface fields' distance reach past the rect for
 * the answer to be the one the neighbouring chunks agree with.
 */
export function voxelCoverOfCells(cells: SurfaceCells, rect: ScatterRect, table: VoxelCoverTable, clear?: Float32Array): VoxelCoverOutput {
  const sets: VoxelCoverSet[] = [];
  if (table.dressings.length === 0 || table.materials.length === 0) return { sets };
  const reader = voxelSurfaceReader(cells);
  const dressingOf = new Map(table.materials);
  table.dressings.forEach((d, di) => {
    d.species.forEach((s, si) => {
      // The large class is stored with the dressing and placed by nothing here.
      if (s.class !== 'cover') return;
      const rule = dressingSpeciesRule(s, si);
      const surface = voxelScatterSurface(reader, { rule: dressingRule(s.conditions), seed: scatterRuleSeed(rule), grows: (m) => dressingOf.get(m) === di, ...(clear !== undefined ? { clear } : {}) });
      const points = bakeCoverPoints(bakedRule(rule), surface, rect, [0, 0, 0]);
      if (points.count > 0) sets.push({ dressing: d.dressingId, species: si, rule, points });
    });
  });
  return { sets };
}

/**
 * The reach (m) past its chunk within which a cover job's answer is exact: a cover species' largest spacing and the
 * distance fields' search. Chunks of 32 cells hold it in the columns beside; on chunks of 16 cells a species with
 * both a spacing and a distance condition judges a neighbour across a chunk border from a shorter search.
 */
export const VOXEL_COVER_REACH_M = 2 * SURFACE_DISTANCE_CAP_M;

/**
 * A cover job: the cover points of the chunk column `input.fields` names
 * (the rows asked), from its cells and the eight columns round it. The same
 * bytes in a worker and in the calling thread.
 */
export function voxelCoverPoints(input: VoxelCoverInput, decompress: (b: Uint8Array) => Uint8Array = (b) => b): VoxelCoverOutput {
  const f = input.fields;
  if (f.level !== 0) throw new RangeError('voxel cover: cover is made from level-0 chunks');
  const e = f.edge;
  // The whole columns beside: a candidate a spacing outside the chunk has its own distance reach inside the box.
  const cells = surfaceFieldsCells(f, decompress, e);
  const side = e * cells.cellM;
  const out = voxelCoverOfCells(cells, [f.cx * side, f.cz * side, (f.cx + 1) * side, (f.cz + 1) * side], input.table, input.clear);
  if (input.rows === undefined) return out;
  const [cy0, cy1] = input.rows;
  const sets: VoxelCoverSet[] = [];
  for (const s of out.sets) {
    const points = pointsInRows(s.points, cells.cellM, e, cy0, cy1);
    if (points.count > 0) sets.push({ ...s, points });
  }
  return { sets };
}

/** The buffers of a cover job's answer, to hand it over from a worker. */
export function voxelCoverTransfer(out: VoxelCoverOutput): ArrayBuffer[] {
  return out.sets.map((s) => s.points.data.buffer as ArrayBuffer);
}


/**
 * The cover job as a worker entry serves it, beside the stream jobs (the
 * voxel package's handlers know nothing of dressings, so an entry adds
 * these to them).
 */
export function voxelCoverJobHandlers(opts: { readonly decompress: (b: Uint8Array) => Uint8Array }): JobHandlers {
  return {
    [VOXEL_COVER_JOB]: (input) => {
      const output = voxelCoverPoints(input as VoxelCoverInput, opts.decompress);
      return { output, transfer: voxelCoverTransfer(output) };
    },
  };
}

export { VOXEL_COVER_JOB };
