/**
 * The world mode's fill tools and fog brush, as arithmetic: what a click
 * and a drag of the Scene view's voxel brush tool become when the tool is
 * armed with a fill (`viewport/voxel-fill-gesture.ts`) or a fog brush.
 *
 * Nothing here is a command of its own. It builds what the existing
 * commands take:
 * - **fog to a level** and **drain**: one `editVoxels` `flood` stroke from
 *   the open cell at the pick, to the level the drag set, with a gas (or
 *   air, which drains), a reach and a fade;
 * - **water**: one `createEntity` of a `waterBody` object at the seed, so
 *   the lake follows later ground edits (a liquid is never flooded by a
 *   one-off stroke from here);
 * - **a road, path or river**: one `createEntity` of a `spline` object whose
 *   `voxels` section is preset, handed to the spline's own point handles;
 * - **fog paint and erase**: the brush has no form that writes a gas at a
 *   chosen density into open cells only, or empties gas cells only (`add`
 *   takes a liquid's cells and writes full density; `dig` takes ground). So
 *   the stroke is sent as the cells themselves: the cells under its dabs are
 *   read first, and a `set` names the open ones (air, or a gas) with the gas
 *   at the density, a `dig` the gas ones. Ground, built cells, openings and
 *   liquids are never in the list;
 * - **fog smooth**: the brush's `smooth` with the gas as its `voxel`.
 *
 * Pure.
 */
import { chunkGrid, editChunks, EditRefused, canonicalEditCommand, isGasRole, recordValue, SHAPE_FULL, valueRole, VOXEL_EDIT_VERSION, VOXEL_ROLE, VOXEL_SIZE_M, type BrushShape, type ChunkEdge } from '@thirdlight/voxel';

import { CELL_NOT_LOADED } from '../voxel-world/scene-voxels-wire';
import type { FloodLeakPlace } from './envelope';
import type { VoxelCell } from './voxel-brush';

/** What a fill gesture makes: fog to a level, the media under a level drained, a water body, a spline. */
export type VoxelFillKind = 'fog' | 'drain' | 'water' | 'spline';

export type SplineStartKind = 'road' | 'path' | 'river';

/** A level lands on quarter metres (half a cell): fine enough for a shore, coarse enough to hit the same level twice. */
export const FILL_LEVEL_STEP_M = VOXEL_SIZE_M / 2;

/** A place where a refused flood left its bound, as the backend names it (metres in the scene). */
export type FloodLeak = FloodLeakPlace;

/** The open cell a fill starts from: the cell in front of the face the pointer met (the cell itself when the ray began inside it). */
export function seedCell(cell: VoxelCell, normal: VoxelCell): [number, number, number] {
  return [cell[0] + normal[0], cell[1] + normal[1], cell[2] + normal[2]];
}

/** A cell's middle in the grid's metres. */
export function cellMiddleM(c: VoxelCell): [number, number, number] {
  return [(c[0] + 0.5) * VOXEL_SIZE_M, (c[1] + 0.5) * VOXEL_SIZE_M, (c[2] + 0.5) * VOXEL_SIZE_M];
}

/** A level on its step (metres). */
export function snapLevelM(m: number): number {
  const v = Math.round(m / FILL_LEVEL_STEP_M) * FILL_LEVEL_STEP_M;
  return v === 0 ? 0 : v;
}

/**
 * Metres a pixel of the view spans at `distanceM` from the eye (a
 * perspective camera's vertical field of view in degrees, the view's height
 * in pixels): what a vertical drag of the pointer moves a level by.
 */
export function metresPerPixel(fovDeg: number, viewHeightPx: number, distanceM: number): number {
  return (2 * distanceM * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewHeightPx);
}

/** The level a drag gives: the level it began at, raised by the pointer's way up the screen (pixels) at the seed's distance. */
export function draggedLevelM(startM: number, upPx: number, perPixelM: number): number {
  return snapLevelM(startM + upPx * perPixelM);
}

/** A flood as the tool sends it. */
export interface FloodStroke {
  readonly grid: number;
  readonly seed: VoxelCell;
  /** The level, metres in the grid. */
  readonly levelM: number;
  /** The gas written (its voxel material id); null: air, which drains. */
  readonly gas: number | null;
  /** How far the fill may spread from the seed, metres. */
  readonly reachM: number;
  /** A gas: the metres under the level over which its density falls to none (0: full density up to the level). */
  readonly fadeM: number;
}

/** The fill's one `editVoxels` command: a v3 `flood` (lengths in cells, the fade in metres). */
export function floodCommand(s: FloodStroke): Record<string, unknown> {
  return {
    v: VOXEL_EDIT_VERSION,
    grid: s.grid,
    kind: 'flood',
    seed: [s.seed[0], s.seed[1], s.seed[2]],
    level: s.levelM / VOXEL_SIZE_M,
    value: s.gas === null ? { material: 0, role: 0 } : { material: s.gas, role: VOXEL_ROLE.gas },
    reach: Math.max(0, Math.round(s.reachM / VOXEL_SIZE_M)),
    ...(s.gas !== null && s.fadeM > 0 ? { fade: s.fadeM } : {}),
  };
}

/**
 * The widest reach one flood may have, in metres, on a world of `edge`
 * cells a chunk: a flood counts its whole reach against the work one stroke
 * may take, so the bound is the command's own (asked of `editChunks`, never
 * a number kept here). Found for a fill a chunk deep from a chunk's corner,
 * the worst place for it; whole metres.
 */
export function floodReachBoundM(edge: ChunkEdge = 32): number {
  const grid = chunkGrid(edge);
  const fits = (reachCells: number): boolean => {
    try {
      editChunks(grid, canonicalEditCommand({ v: VOXEL_EDIT_VERSION, grid: 0, kind: 'flood', seed: [0, 0, 0], level: edge, value: { material: 1, role: VOXEL_ROLE.gas }, reach: reachCells }));
      return true;
    } catch (e) {
      if (e instanceof EditRefused) return false;
      throw e;
    }
  };
  let lo = 1;
  let hi = 4096;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return Math.floor(lo * VOXEL_SIZE_M);
}

/** What the status line says of a refused flood's leaks. */
export function leakMessage(what: string, leaks: readonly FloodLeak[]): string {
  const first = leaks[0];
  const where = first === undefined ? '' : `, first at (${first.at.map((v) => v.toFixed(1)).join(', ')}) m`;
  const how = first?.kind === 'world' ? 'out of the world' : 'past its reach';
  return `${what} leaks ${how} at ${leaks.length} place${leaks.length === 1 ? '' : 's'}${where}: nothing was written. Close the gap, lower the level or shorten the reach (the red marks show where).`;
}

// ---- water and splines: objects made by the existing create command -----------------------------

/** A water body made at a click: `createEntity`'s args (the object stands in its seed cell's middle; the reach is the component's default). */
export function waterBodyCreate(o: { sceneId: string | null; world: string; seed: VoxelCell; levelM: number; material: number; name?: string }): Record<string, unknown> {
  return {
    ...(o.sceneId !== null ? { sceneId: o.sceneId } : {}),
    parentId: null,
    kind: 'group',
    name: o.name ?? 'Water',
    transform: { position: cellMiddleM(o.seed) },
    components: { waterBody: { world: o.world, level: o.levelM, material: o.material } },
  };
}

/** A spline's `voxels` section as it starts. */
export interface SplineStartVoxels {
  readonly kind: SplineStartKind;
  readonly material: number;
  readonly bed?: { readonly material: number; readonly depth: number };
}

/** What a new voxel section starts as: a road or path of `solid` on a metre of bed, a river of `liquid` (null: no such material). */
export function splineStartVoxels(kind: SplineStartKind, solid: number | null, liquid: number | null): SplineStartVoxels | null {
  const m = kind === 'river' ? liquid : solid;
  if (m === null) return null;
  return kind === 'river' ? { kind, material: m } : { kind, material: m, bed: { material: m, depth: 1 } };
}

/** Metres across a spline starts with: a lane, a footpath, a stream. */
export const SPLINE_START_WIDTH_M: Readonly<Record<SplineStartKind, number>> = Object.freeze({ road: 4, path: 1.5, river: 4 });

/** A first stretch shorter than this is a click, not a drag: nothing to lay a road along. */
export const SPLINE_START_MIN_M = 1;

const round3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/**
 * A spline started by a drag from `from` to `to` (metres in the scene):
 * `createEntity`'s args for an object at `from` whose two points are the
 * drag's ends and whose `voxels` section is preset. Null: the drag is too
 * short to be a stretch.
 */
export function splineCreate(o: { sceneId: string | null; from: readonly [number, number, number]; to: readonly [number, number, number]; voxels: SplineStartVoxels }): Record<string, unknown> | null {
  const d = [o.to[0] - o.from[0], o.to[1] - o.from[1], o.to[2] - o.from[2]] as const;
  if (Math.hypot(d[0], d[2]) < SPLINE_START_MIN_M) return null;
  const name = o.voxels.kind === 'road' ? 'Road' : o.voxels.kind === 'path' ? 'Path' : 'River';
  return {
    ...(o.sceneId !== null ? { sceneId: o.sceneId } : {}),
    parentId: null,
    kind: 'group',
    name,
    transform: { position: [round3(o.from[0]), round3(o.from[1]), round3(o.from[2])] },
    components: { spline: { points: [{ at: [0, 0, 0] }, { at: [round3(d[0]), round3(d[1]), round3(d[2])] }], width: SPLINE_START_WIDTH_M[o.voxels.kind], voxels: o.voxels } },
  };
}

// ---- the fog brush ---------------------------------------------------------------------------

/** The fog brush's strokes that name their cells. */
export type FogCellsKind = 'fog' | 'fog-erase';

/** A box of cells, both corners inclusive. */
export interface CellBoxRead {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The cells a stroke's dabs can cover: what is read before a fog stroke is sent. */
export function dabsBox(cells: readonly VoxelCell[], across: number): CellBoxRead | null {
  if (cells.length === 0) return null;
  const r = (across - 1) / 2;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, c[a]! - r);
      max[a] = Math.max(max[a]!, c[a]! + r);
    }
  }
  return { min, max };
}

/** Whether a cell `dx`, `dy`, `dz` cells from a dab's cell lies in the brush (its middle inside the shape). */
function inBrush(shape: BrushShape, half: number, dx: number, dy: number, dz: number): boolean {
  if (shape === 'box') return true;
  if (shape === 'cylinder') return dx * dx + dz * dz <= half * half;
  return dx * dx + dy * dy + dz * dz <= half * half;
}

/**
 * The cells a fog stroke names, x y z flat, each once: under its dabs, of
 * the values read (`values`: the box's record values, x outermost, then z,
 * then y; `CELL_NOT_LOADED` where the view holds none), those the
 * stroke may change. Fog is painted into air and into gas (not already at
 * `value`); it is erased from gas. Everything else, and what is not loaded,
 * is left out.
 */
export function fogCells(o: { kind: FogCellsKind; shape: BrushShape; across: number; dabs: readonly VoxelCell[]; box: CellBoxRead; values: ArrayLike<number>; value: number }): number[] {
  const { box, values } = o;
  const sy = box.max[1] - box.min[1] + 1;
  const sz = box.max[2] - box.min[2] + 1;
  const half = o.across / 2;
  const r = (o.across - 1) / 2;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const c of o.dabs) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -r; dy <= r; dy++) {
          if (!inBrush(o.shape, half, dx, dy, dz)) continue;
          const x = c[0] + dx;
          const y = c[1] + dy;
          const z = c[2] + dz;
          if (x < box.min[0] || x > box.max[0] || y < box.min[1] || y > box.max[1] || z < box.min[2] || z > box.max[2]) continue;
          const i = ((x - box.min[0]) * sz + (z - box.min[2])) * sy + (y - box.min[1]);
          if (seen.has(i)) continue;
          seen.add(i);
          const v = values[i]! >>> 0;
          if (v === CELL_NOT_LOADED) continue;
          const gas = v !== 0 && isGasRole(valueRole(v));
          if (o.kind === 'fog-erase' ? !gas : (v !== 0 && !gas) || v === o.value) continue;
          out.push(x, y, z);
        }
      }
    }
  }
  return out;
}

/** A gas cell's record value at a density (1 … the shape's full level). */
export function gasValue(material: number, density: number): number {
  return recordValue(material, VOXEL_ROLE.gas, fogDensity(density), 0);
}

/** A density setting as the cell holds it: a whole level from 1 (the thinnest fog a cell can hold) to full. */
export function fogDensity(density: number): number {
  return Math.max(1, Math.min(SHAPE_FULL, Math.round(density)));
}

/**
 * A fog stroke as one `editVoxels` command over the cells it names (null:
 * none to change): painted fog is a `set` of the gas at the density, dry;
 * erased fog a `dig` of the cells.
 */
export function fogCellsCommand(o: { grid: number; kind: FogCellsKind; cells: readonly number[]; material: number; density: number }): Record<string, unknown> | null {
  if (o.cells.length === 0) return null;
  if (o.kind === 'fog-erase') return { v: VOXEL_EDIT_VERSION, grid: o.grid, kind: 'dig', cells: [...o.cells] };
  return { v: VOXEL_EDIT_VERSION, grid: o.grid, kind: 'set', cells: [...o.cells], voxel: { material: o.material, role: VOXEL_ROLE.gas, wetness: 0, shape: fogDensity(o.density) } };
}
