/**
 * What the probes' placement (`probe-bricks.ts`) reads of the static scene:
 * where its surfaces are (marks) and what is inside it (solid), from what
 * the tracer and the surface cache already hold — block layers' visible
 * faces (their charts) and cells, terrains' heights, generated
 * architecture's pieces and static models' distance-field bricks.
 *
 * Terrain is marked only near the eye, following the surface cache's
 * rings (`PROBE_TERRAIN_LEVELS`): a world of any size costs the same few
 * bricks of terrain probes.
 *
 * Pure (no three.js, no device).
 */
import { DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SIDE, distanceOfSample, type BlockCell, type DistanceBrickSet, type TerrainField } from '@thirdlight/runtime';

import { brickSide, latticeKey, runSteps, type ProbeMarks, type ProbeSolid, type Steps } from './probe-bricks';
import { FACE_PLANE_AXES, type BlockChunkCharts, type SurfaceBlockGrid } from './surface-cache-blocks';
import { terrainRingHalf } from './surface-cache-terrain';
import type { TraceArchitecture, TraceBox } from './tracer-objects';
import type { Affine } from './tracer-words';

/** Terrain near the eye: within surface cache ring `[0]`'s window its probes are of brick level `[1]`. */
export const PROBE_TERRAIN_LEVELS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 2],
];
/** Heights read per brick side when a terrain column is marked (at most; never finer than the terrain's own samples). */
const TERRAIN_SAMPLES_PER_BRICK = 32;

type V3 = readonly number[];

/** A block layer's chunk column with its charts made (a surface cache tile). */
export interface ProbeBlockTile {
  readonly grid: SurfaceBlockGrid;
  readonly origin: V3;
  readonly made: BlockChunkCharts | null;
}

/** A block column's faces as planes: each chart is one rectangle of coplanar faces. */
export function blockTileMarks(tile: ProbeBlockTile, marks: ProbeMarks): void {
  const made = tile.made;
  if (made === null) return;
  const { grid, origin } = tile;
  const cs = grid.cellSize;
  for (let c = 0; c < made.charts.length; c += 1) {
    const chart = made.charts[c]!;
    if (chart.kind !== 'area') continue;
    const face = made.frames[c * 4]!;
    const slice = made.frames[c * 4 + 1]!;
    const axis = face >> 1;
    const [pu, pv] = FACE_PLANE_AXES[axis]!;
    const min = [0, 0, 0];
    const max = [0, 0, 0];
    // A +axis face lies on its cell's far side.
    min[axis] = max[axis] = origin[axis]! + (slice + (face & 1 ? 0 : 1)) * cs[axis]!;
    min[pu] = origin[pu]! + made.frames[c * 4 + 2]! * cs[pu]!;
    max[pu] = min[pu]! + chart.w;
    min[pv] = origin[pv]! + made.frames[c * 4 + 3]! * cs[pv]!;
    max[pv] = min[pv]! + chart.h;
    marks.plane(min, max, axis, face & 1 ? -1 : 1, min[axis]!);
  }
}

/** A box's world bounds. */
function boxBounds(b: TraceBox): { min: number[]; max: number[] } {
  const [x, y, z, w] = [b.rotation[0] ?? 0, b.rotation[1] ?? 0, b.rotation[2] ?? 0, b.rotation[3] ?? 1];
  // |R| times the half extents: the rotated box's half size along each world axis.
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const h = [0, 1, 2].map((a) => Math.abs(r[a]![0]!) * b.half[0]! + Math.abs(r[a]![1]!) * b.half[1]! + Math.abs(r[a]![2]!) * b.half[2]!);
  return { min: [0, 1, 2].map((a) => b.center[a]! - h[a]!), max: [0, 1, 2].map((a) => b.center[a]! + h[a]!) };
}

/** Generated architecture's pieces: every box and flat piece wants the finest probes (walls meet floors, openings, trims). */
export function architectureMarks(pieces: TraceArchitecture, marks: ProbeMarks): void {
  for (const b of pieces.boxes) {
    const { min, max } = boxBounds(b);
    marks.mark(min, max, 0);
  }
  const t = pieces.triangles;
  for (let i = 0; i + 8 < t.length; i += 9) {
    const min = [0, 1, 2].map((a) => Math.min(t[i + a]!, t[i + 3 + a]!, t[i + 6 + a]!));
    const max = [0, 1, 2].map((a) => Math.max(t[i + a]!, t[i + 3 + a]!, t[i + 6 + a]!));
    marks.mark(min, max, 0);
  }
}

/** The square (x0, z0, x1, z1) terrain probes of PROBE_TERRAIN_LEVELS entry `k` cover round `centre` (x, z), `snap` the step the centre moves by. */
export function terrainProbeWindow(k: number, centre: readonly number[], snap: number): [number, number, number, number] {
  const half = terrainRingHalf(PROBE_TERRAIN_LEVELS[k]![0]) + snap / 2;
  return [centre[0]! - half, centre[1]! - half, centre[0]! + half, centre[1]! + half];
}

/**
 * A terrain's probes near the eye (`centre`: x, z, moving in steps of
 * `snap`): per level of `PROBE_TERRAIN_LEVELS`, each brick column of the
 * window over loaded ground is marked from the lowest to the highest height
 * under it.
 */
export function terrainMarks(field: Pick<TerrainField, 'heightAt' | 'spacing'>, centre: readonly number[], snap: number, marks: ProbeMarks): void {
  runSteps(terrainMarksSteps(field, centre, snap, marks));
}

/** `terrainMarks` in steps (a column of heights a step). */
export function* terrainMarksSteps(field: Pick<TerrainField, 'heightAt' | 'spacing'>, centre: readonly number[], snap: number, marks: ProbeMarks): Steps<void> {
  for (let k = 0; k < PROBE_TERRAIN_LEVELS.length; k += 1) {
    const level = PROBE_TERRAIN_LEVELS[k]![1];
    const [wx0, wz0, wx1, wz1] = terrainProbeWindow(k, centre, snap);
    const side = brickSide(marks.spacing, level);
    const step = Math.max(field.spacing, side / TERRAIN_SAMPLES_PER_BRICK);
    for (let bz = Math.floor(wz0 / side); bz * side < wz1; bz += 1) {
      for (let bx = Math.floor(wx0 / side); bx * side < wx1; bx += 1) {
        yield;
        let lo = Infinity;
        let hi = -Infinity;
        for (let z = bz * side; z <= (bz + 1) * side + 1e-6; z += step) {
          for (let x = bx * side; x <= (bx + 1) * side + 1e-6; x += step) {
            const h = field.heightAt(x, z);
            if (h === null) continue;
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        }
        if (lo <= hi) marks.column(level, bx, bz, lo, hi);
      }
    }
  }
}

/** A block layer as the solid test reads it. */
export interface ProbeSolidLayer {
  readonly grid: Pick<SurfaceBlockGrid, 'cellSize' | 'indexAt' | 'valueOf'>;
  readonly origin: V3;
  readonly opaque: (cell: BlockCell) => boolean;
}

/** A placed model piece: its world → local map, its field and its world box. */
export interface ProbeSolidModel {
  readonly worldToLocal: Affine;
  readonly set: DistanceBrickSet;
  readonly min: V3;
  readonly max: V3;
}

export interface ProbeSolidInput {
  readonly layers?: readonly ProbeSolidLayer[];
  readonly terrains?: readonly Pick<TerrainField, 'heightAt'>[];
  readonly arch?: readonly TraceArchitecture[];
  readonly models?: readonly ProbeSolidModel[];
}

/** Items by the cells (of `cell` metres) their boxes touch: a point tests only its cell's. */
class BoxHash<T> {
  private readonly cells = new Map<number, T[]>();
  constructor(private readonly cell: number) {}
  add(min: V3, max: V3, item: T): void {
    const c = this.cell;
    for (let z = Math.floor(min[2]! / c); z <= Math.floor(max[2]! / c); z += 1) {
      for (let y = Math.floor(min[1]! / c); y <= Math.floor(max[1]! / c); y += 1) {
        for (let x = Math.floor(min[0]! / c); x <= Math.floor(max[0]! / c); x += 1) {
          const k = latticeKey(x, y, z);
          const list = this.cells.get(k);
          if (list === undefined) this.cells.set(k, [item]);
          else list.push(item);
        }
      }
    }
  }
  at(p: V3): readonly T[] {
    if (this.cells.size === 0) return NONE;
    const c = this.cell;
    return this.cells.get(latticeKey(Math.floor(p[0]! / c), Math.floor(p[1]! / c), Math.floor(p[2]! / c))) ?? NONE;
  }
}
const NONE: readonly never[] = [];

function insideBox(b: TraceBox, p: V3): boolean {
  const [x, y, z, w] = [b.rotation[0] ?? 0, b.rotation[1] ?? 0, b.rotation[2] ?? 0, b.rotation[3] ?? 1];
  const v = [p[0]! - b.center[0]!, p[1]! - b.center[1]!, p[2]! - b.center[2]!];
  // The inverse rotation (the conjugate) of v: v + 2 q' × (q' × v + w v), q' = −q.
  const q = [-x, -y, -z];
  const c1 = [q[1]! * v[2]! - q[2]! * v[1]! + w * v[0]!, q[2]! * v[0]! - q[0]! * v[2]! + w * v[1]!, q[0]! * v[1]! - q[1]! * v[0]! + w * v[2]!];
  const l = [v[0]! + 2 * (q[1]! * c1[2]! - q[2]! * c1[1]!), v[1]! + 2 * (q[2]! * c1[0]! - q[0]! * c1[2]!), v[2]! + 2 * (q[0]! * c1[1]! - q[1]! * c1[0]!)];
  return Math.abs(l[0]!) < b.half[0]! && Math.abs(l[1]!) < b.half[1]! && Math.abs(l[2]!) < b.half[2]!;
}

/** Whether a model-local point is inside its field: the brick's own answer, else its nearest sample's sign. */
export function insideDistanceBricks(set: DistanceBrickSet, local: V3): boolean {
  const size = set.voxel * DISTANCE_BRICK_CELLS;
  const f = [0, 1, 2].map((a) => (local[a]! - set.min[a]!) / size);
  const b = f.map(Math.floor);
  if (b.some((v, a) => v < 0 || v >= set.dims[a]!)) return false;
  const blk = set.bricks[b[0]! + set.dims[0] * (b[1]! + set.dims[1] * b[2]!)]!;
  if (blk === DISTANCE_BRICK_INSIDE) return true;
  if (blk === DISTANCE_BRICK_OUTSIDE) return false;
  const s = f.map((v, a) => Math.min(DISTANCE_BRICK_CELLS, Math.max(0, Math.round((v - b[a]!) * DISTANCE_BRICK_CELLS))));
  const q = set.samples[blk * DISTANCE_BRICK_SIDE ** 3 + s[0]! + DISTANCE_BRICK_SIDE * (s[1]! + DISTANCE_BRICK_SIDE * s[2]!)]!;
  return distanceOfSample(q, set.band) < 0;
}

/**
 * Whether a point is inside the static geometry (an opaque block cell, under
 * a terrain, inside an architecture box or a model), and the ground's height
 * over it when only a terrain's ground holds it.
 */
export function probeSolid(input: ProbeSolidInput, hashCell: number): ProbeSolid {
  const memos = (input.layers ?? []).map(() => new Map<number, boolean>());
  const boxes = new BoxHash<TraceBox>(hashCell);
  for (const a of input.arch ?? []) for (const b of a.boxes) {
    const { min, max } = boxBounds(b);
    boxes.add(min, max, b);
  }
  const models = new BoxHash<ProbeSolidModel>(hashCell);
  for (const m of input.models ?? []) models.add(m.min, m.max, m);
  /** Inside a block, a box or a model. */
  const built = (p: V3): boolean => {
    const layers = input.layers ?? [];
    for (let i = 0; i < layers.length; i += 1) {
      const { grid, origin, opaque } = layers[i]!;
      const cs = grid.cellSize;
      const idx = grid.indexAt(Math.floor((p[0]! - origin[0]!) / cs[0]!), Math.floor((p[1]! - origin[1]!) / cs[1]!), Math.floor((p[2]! - origin[2]!) / cs[2]!));
      if (idx < 0) continue;
      const memo = memos[i]!;
      let o = memo.get(idx);
      if (o === undefined) memo.set(idx, (o = opaque(grid.valueOf(idx))));
      if (o) return true;
    }
    for (const b of boxes.at(p)) if (insideBox(b, p)) return true;
    for (const m of models.at(p)) {
      if (p[0]! < m.min[0]! || p[1]! < m.min[1]! || p[2]! < m.min[2]! || p[0]! > m.max[0]! || p[1]! > m.max[1]! || p[2]! > m.max[2]!) continue;
      const w = m.worldToLocal;
      const l = [0, 1, 2].map((r) => w[r * 4]! * p[0]! + w[r * 4 + 1]! * p[1]! + w[r * 4 + 2]! * p[2]! + w[r * 4 + 3]!);
      if (insideDistanceBricks(m.set, l)) return true;
    }
    return false;
  };
  /** The highest terrain ground over the point (null: none is). */
  const under = (p: V3): number | null => {
    let top: number | null = null;
    for (const t of input.terrains ?? []) {
      const h = t.heightAt(p[0]!, p[2]!);
      if (h !== null && p[1]! < h && (top === null || h > top)) top = h;
    }
    return top;
  };
  return {
    solid: (p) => built(p) || under(p) !== null,
    ground: (p) => (built(p) ? null : under(p)),
  };
}
