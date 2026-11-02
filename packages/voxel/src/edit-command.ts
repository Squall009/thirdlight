/**
 * Voxel edit commands, format v1 DRAFT: one command is one stroke (a brush
 * drag, a box fill, a stamp, or a runtime set/dig of a few cells), so undo,
 * MCP, the editor and game sessions edit at a useful granularity and history
 * stays small.
 *
 * A command is plain JSON, rebuilt field by field by
 * {@link canonicalEditCommand} (unknown fields and versions refused), so it
 * can ride the existing command pipeline as an op's args. Its application
 * (edit-apply.ts) is deterministic: the same command on the same voxels gives
 * the same voxels in any JavaScript engine. For that, a command carries every
 * number it needs already resolved (a stamp's yaw as its cosine and sine, not
 * an angle), and application uses only +, −, ×, ÷, square root, floor and
 * round, which IEEE-754 defines exactly; no sin/cos/pow at apply time.
 *
 * Positions are in cells of the command's grid (the world grid, or a
 * structure's own grid), continuous: cell (x, y, z) spans [x, x + 1) on each
 * axis, so its centre is x + 0.5.
 */
import { cellInWorld } from './coords';
import { MATERIAL_ID_MAX, SHAPE_FULL, VOXEL_ROLE_COUNT, WETNESS_MAX } from './record';

/** The edit command format this build writes and reads. */
export const VOXEL_EDIT_VERSION = 2;

/**
 * What a stroke does to the cells it covers:
 * - `place` writes its voxel whatever was there;
 * - `add` writes only into air or liquid (and, when smooth, grows a cell of
 *   its own material), never replacing other solid voxels;
 * - `dig` removes (when smooth, lowers the density, emptying a cell to air);
 * - `paint` changes material, role and wetness of non-air cells and keeps
 *   their shape.
 */
export type EditMode = 'place' | 'add' | 'dig' | 'paint';
export const EDIT_MODES: readonly EditMode[] = Object.freeze(['place', 'add', 'dig', 'paint']);

/** The voxel a stroke writes: its shape comes from the stroke (full, or its coverage when smooth). */
export interface EditVoxel {
  readonly material: number;
  readonly role: number;
  readonly wetness: number;
}

/** A voxel written exactly, shape included (runtime set). */
export interface SetVoxel extends EditVoxel {
  readonly shape: number;
}

/**
 * Brush shapes; `size` is half extents in cells on x, y, z. A sphere's are
 * all its radius and a cylinder's x and z its radius: the canonical form
 * fills them in from size[0] (and size[1]), so one stroke has one payload.
 */
export type BrushShape = 'sphere' | 'box' | 'cylinder';
export const BRUSH_SHAPES: readonly BrushShape[] = Object.freeze(['sphere', 'box', 'cylinder']);

interface EditBase {
  readonly v: 2;
  /** The grid edited: 0 the world grid, else a structure's own grid. */
  readonly grid: number;
}

/** A brush stroke: one shape dragged through dab centres; a cell's coverage is the most any dab gives it. */
export interface BrushEdit extends EditBase {
  readonly kind: 'brush';
  readonly shape: BrushShape;
  readonly size: readonly [number, number, number];
  /** Dab centres, x y z flat, in cells (at least one dab). */
  readonly points: readonly number[];
  readonly mode: EditMode;
  /** Absent for `dig`. */
  readonly voxel?: EditVoxel;
  /** Partial density at the rim (add and dig only; projected materials). */
  readonly smooth: boolean;
}

/** A box of whole cells, both corners inclusive. */
export interface FillEdit extends EditBase {
  readonly kind: 'fill';
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly mode: EditMode;
  readonly voxel?: EditVoxel;
}

/**
 * A voxelized mesh placed with a transform: world = origin + scale × yaw(local),
 * yaw about the vertical axis given as [cos, sin] (resolved by the tool).
 * `stamp.hash` names the exact shape (stampShapeHash), so a changed stamp
 * asset is refused rather than silently giving different voxels.
 */
export interface StampEdit extends EditBase {
  readonly kind: 'stamp';
  readonly stamp: { readonly id: string; readonly hash: string };
  readonly origin: readonly [number, number, number];
  readonly yaw: readonly [number, number];
  readonly scale: number;
  readonly mode: EditMode;
  readonly voxel?: EditVoxel;
  readonly smooth: boolean;
}

/** Cells set exactly (the runtime's set: one command per gameplay action). */
export interface SetEdit extends EditBase {
  readonly kind: 'set';
  /** Cells, x y z flat, integers. */
  readonly cells: readonly number[];
  readonly voxel: SetVoxel;
}

/** Cells emptied (the runtime's dig). */
export interface DigEdit extends EditBase {
  readonly kind: 'dig';
  readonly cells: readonly number[];
}

export type VoxelEditCommand = BrushEdit | FillEdit | StampEdit | SetEdit | DigEdit;

/** A command the format refuses: `path` names the field (JSON pointer). */
export class EditCommandError extends Error {
  override readonly name = 'EditCommandError';
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

type Json = Record<string, unknown>;

function obj(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new EditCommandError(path, 'expected an object');
  return v as Json;
}

function only(o: Json, path: string, keys: readonly string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new EditCommandError(`${path}/${k}`, 'unknown field');
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new EditCommandError(path, `expected an integer in [${min}, ${max}]`);
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new EditCommandError(path, 'expected a finite number');
  // −0 and 0 must not give two payloads for one stroke.
  return v === 0 ? 0 : v;
}

function triple(v: unknown, path: string, each: (x: unknown, p: string) => number): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) throw new EditCommandError(path, 'expected [x, y, z]');
  return [each(v[0], `${path}/0`), each(v[1], `${path}/1`), each(v[2], `${path}/2`)];
}

function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !options.includes(v as T)) throw new EditCommandError(path, `expected one of ${options.join(', ')}`);
  return v as T;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new EditCommandError(path, 'expected true or false');
  return v;
}

function editVoxel(v: unknown, path: string): EditVoxel {
  const o = obj(v, path);
  only(o, path, ['material', 'role', 'wetness']);
  const material = int(o.material, `${path}/material`, 1, MATERIAL_ID_MAX);
  return { material, role: int(o.role, `${path}/role`, 0, VOXEL_ROLE_COUNT - 1), wetness: int(o.wetness, `${path}/wetness`, 0, WETNESS_MAX) };
}

function setVoxel(v: unknown, path: string): SetVoxel {
  const o = obj(v, path);
  only(o, path, ['material', 'role', 'shape', 'wetness']);
  const material = int(o.material, `${path}/material`, 0, MATERIAL_ID_MAX);
  // Air is one value, so two payloads never mean the same cells.
  if (material === 0) return { material: 0, role: int(o.role, `${path}/role`, 0, 0), shape: int(o.shape, `${path}/shape`, 0, 0), wetness: int(o.wetness, `${path}/wetness`, 0, 0) };
  return {
    material,
    role: int(o.role, `${path}/role`, 0, VOXEL_ROLE_COUNT - 1),
    shape: int(o.shape, `${path}/shape`, 1, SHAPE_FULL),
    wetness: int(o.wetness, `${path}/wetness`, 0, WETNESS_MAX),
  };
}

function modeVoxel(o: Json, path: string): { mode: EditMode; voxel?: EditVoxel } {
  const mode = oneOf(o.mode, `${path}/mode`, EDIT_MODES);
  if (mode === 'dig') {
    if (o.voxel !== undefined) throw new EditCommandError(`${path}/voxel`, 'a dig writes no voxel');
    return { mode };
  }
  return { mode, voxel: editVoxel(o.voxel, `${path}/voxel`) };
}

/**
 * A cell list in its canonical order: sorted by x, then z, then y (the
 * order chunk keys and cells inside a chunk use), each cell once. A set or
 * dig changes the same cells whatever order or repeats it was sent with,
 * so one stroke has one payload.
 */
function cellList(v: unknown, path: string): number[] {
  if (!Array.isArray(v) || v.length === 0 || v.length % 3 !== 0) throw new EditCommandError(path, 'expected x y z triples, at least one');
  const cells: [number, number, number][] = [];
  for (let i = 0; i < v.length; i += 3) {
    const x = int(v[i], `${path}/${i}`, -0x8000, 0x7fff);
    const y = int(v[i + 1], `${path}/${i + 1}`, -0x2000, 0x1fff);
    const z = int(v[i + 2], `${path}/${i + 2}`, -0x8000, 0x7fff);
    if (!cellInWorld(x, y, z)) throw new EditCommandError(`${path}/${i}`, 'cell outside the world');
    cells.push([x, y, z]);
  }
  cells.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const out: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k]!;
    const p = cells[k - 1];
    if (p !== undefined && p[0] === c[0] && p[1] === c[1] && p[2] === c[2]) continue;
    out.push(c[0], c[1], c[2]);
  }
  return out;
}

/** Stamp yaw: cos² + sin² must be 1 within this (a resolved rotation, not a scale). */
const YAW_TOLERANCE = 1e-9;

/**
 * The command rebuilt field by field, or {@link EditCommandError}. Bounds
 * outside the world are refused here (stamps once their shape is known, in
 * edit-apply.ts).
 */
export function canonicalEditCommand(input: unknown): VoxelEditCommand {
  const o = obj(input, '');
  if (o.v !== VOXEL_EDIT_VERSION) throw new EditCommandError('/v', `unknown edit command version ${String(o.v)}`);
  const grid = int(o.grid, '/grid', 0, 0xffffffff);
  const kind = oneOf(o.kind, '/kind', ['brush', 'fill', 'stamp', 'set', 'dig'] as const);
  let cmd: VoxelEditCommand;
  switch (kind) {
    case 'brush': {
      only(o, '', ['v', 'grid', 'kind', 'shape', 'size', 'points', 'mode', 'voxel', 'smooth']);
      const shape = oneOf(o.shape, '/shape', BRUSH_SHAPES);
      const given = triple(o.size, '/size', (x, p) => {
        const n = num(x, p);
        if (n < 0) throw new EditCommandError(p, 'a size is ≥ 0');
        return n;
      });
      const size: [number, number, number] = shape === 'sphere' ? [given[0], given[0], given[0]] : shape === 'cylinder' ? [given[0], given[1], given[0]] : given;
      if (!Array.isArray(o.points) || o.points.length === 0 || o.points.length % 3 !== 0) throw new EditCommandError('/points', 'expected x y z triples, at least one');
      const points = o.points.map((p, i) => num(p, `/points/${i}`));
      const mv = modeVoxel(o, '');
      cmd = { v: 2, grid, kind, shape, size, points, ...mv, smooth: bool(o.smooth, '/smooth') };
      break;
    }
    case 'fill': {
      only(o, '', ['v', 'grid', 'kind', 'min', 'max', 'mode', 'voxel']);
      const min = triple(o.min, '/min', (x, p) => int(x, p, -0x8000, 0x7fff));
      const max = triple(o.max, '/max', (x, p) => int(x, p, -0x8000, 0x7fff));
      if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) throw new EditCommandError('/max', 'max below min');
      if (!cellInWorld(...min) || !cellInWorld(...max)) throw new EditCommandError('/min', 'box outside the world');
      cmd = { v: 2, grid, kind, min, max, ...modeVoxel(o, '') };
      break;
    }
    case 'stamp': {
      only(o, '', ['v', 'grid', 'kind', 'stamp', 'origin', 'yaw', 'scale', 'mode', 'voxel', 'smooth']);
      const s = obj(o.stamp, '/stamp');
      only(s, '/stamp', ['id', 'hash']);
      if (typeof s.id !== 'string' || s.id.length === 0) throw new EditCommandError('/stamp/id', 'expected a stamp id');
      if (typeof s.hash !== 'string' || !/^[0-9a-f]{64}$/.test(s.hash)) throw new EditCommandError('/stamp/hash', 'expected the stamp shape hash (64 hex digits)');
      if (!Array.isArray(o.yaw) || o.yaw.length !== 2) throw new EditCommandError('/yaw', 'expected [cos, sin]');
      const yaw: [number, number] = [num(o.yaw[0], '/yaw/0'), num(o.yaw[1], '/yaw/1')];
      if (Math.abs(yaw[0] * yaw[0] + yaw[1] * yaw[1] - 1) > YAW_TOLERANCE) throw new EditCommandError('/yaw', 'cos² + sin² must be 1');
      const scale = num(o.scale, '/scale');
      if (scale <= 0) throw new EditCommandError('/scale', 'a scale is > 0');
      cmd = { v: 2, grid, kind, stamp: { id: s.id, hash: s.hash }, origin: triple(o.origin, '/origin', num), yaw, scale, ...modeVoxel(o, ''), smooth: bool(o.smooth, '/smooth') };
      break;
    }
    case 'set':
      only(o, '', ['v', 'grid', 'kind', 'cells', 'voxel']);
      cmd = { v: 2, grid, kind, cells: cellList(o.cells, '/cells'), voxel: setVoxel(o.voxel, '/voxel') };
      break;
    case 'dig':
      only(o, '', ['v', 'grid', 'kind', 'cells']);
      cmd = { v: 2, grid, kind, cells: cellList(o.cells, '/cells') };
      break;
  }
  if ((cmd.kind === 'brush' || cmd.kind === 'stamp') && cmd.smooth && cmd.mode !== 'add' && cmd.mode !== 'dig') throw new EditCommandError('/smooth', 'only add and dig strokes are smooth');
  return cmd;
}
