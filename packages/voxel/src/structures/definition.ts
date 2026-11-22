/**
 * A building's definition: what a designer sets on a structure, and the one
 * place its fields are checked and rebuilt.
 *
 * The record is the structure component's minus its world and grid (they
 * say where the voxels go, not what they are). It is defined here, in the voxel
 * package, because the generator reads it and project-model, which may
 * import this package (not the other way round), stores it.
 *
 * **Coordinates.** Every number of a definition is in cells of the
 * structure's own grid, as they are: footprint point (x, z) is the lattice
 * corner between cells, a polygon covers the cells whose middles lie inside
 * it, and y = 0 is the ground floor's row (the slab one stands on). Storeys
 * stack up from it, the foundation goes down below it. Nothing translates
 * between a definition and its grid, so no change of the definition (an
 * overhang, a foundation's depth, a wing on any side) moves a cell, and a
 * stored override keeps its place.
 *
 * Openings sit on a polygon's edge (edge k runs from point k to point k + 1,
 * the last back to the first), `at` cells along it from its start, on a
 * storey, `sill` cells over that storey's floor. A stair climbs from storey
 * `from` to the next, two cells wide, its first step at `at`, rising one
 * cell a cell toward `facing`.
 *
 * No counts are capped: polygons, openings and stairs are lists.
 */
import { MATERIAL_ID_MAX } from '../record';
import { WORLD_CELL_MAX_XZ, WORLD_CELL_MIN_XZ } from '../coords';

export type RoofShape = 'flat' | 'gable' | 'hip';
export const ROOF_SHAPES: readonly RoofShape[] = Object.freeze(['flat', 'gable', 'hip']);

/** The axis a gable's ridge runs along. */
export type RoofAxis = 'x' | 'z';
export const ROOF_AXES: readonly RoofAxis[] = Object.freeze(['x', 'z']);

/** Which way a stair climbs. */
export type StairFacing = '+x' | '-x' | '+z' | '-z';
export const STAIR_FACINGS: readonly StairFacing[] = Object.freeze(['+x', '-x', '+z', '-z']);

/** A stair's width across its climb, in cells (1 m): the flight covers `at` and the next cell toward +x (climbing along z) or +z (along x). */
export const STAIR_WIDTH_CELLS = 2;

/** What a new structure starts with where the designer has not said: a 3 m storey (a 2.5 m room under a floor), a 1 m foundation, a 0.5 m overhang. */
export const STRUCTURE_DEFAULTS = Object.freeze({ storeyHeight: 6, foundationDepth: 2, overhang: 1 });

export interface FootprintPolygon {
  readonly id: string;
  /** Corners in cells, [x, z]; edges run along x or z, closed back to the first. */
  readonly points: readonly (readonly [number, number])[];
}

export interface StructureRoof {
  readonly shape: RoofShape;
  /** Cells the roof reaches past the walls on every side. */
  readonly overhang: number;
  /** The ridge's direction (a gable's; kept for every shape so a change of shape keeps it). */
  readonly axis: RoofAxis;
}

/** One voxel material a part. Openings take the wall's. */
export interface StructureMaterials {
  readonly wall: number;
  readonly floor: number;
  readonly roof: number;
  readonly foundation: number;
  readonly stair: number;
}

export interface StructureOpening {
  readonly id: string;
  /** The polygon whose edge it is on. */
  readonly polygon: string;
  /** Edge k of that polygon: point k to point k + 1. */
  readonly edge: number;
  readonly storey: number;
  /** Cells from the edge's start to the opening's first cell. */
  readonly at: number;
  readonly width: number;
  readonly height: number;
  /** Cells between the storey's floor and the opening's bottom (0: a door). */
  readonly sill: number;
  /** The prop that fills it (a door, a window), when one is chosen. */
  readonly prop?: string;
}

export interface StructureStair {
  readonly id: string;
  /** The polygon it stands in. */
  readonly polygon: string;
  /** The storey it climbs from (to the next). */
  readonly from: number;
  /** The first step's cell, [x, z]. */
  readonly at: readonly [number, number];
  readonly facing: StairFacing;
}

export interface StructureDefinition {
  readonly footprint: readonly FootprintPolygon[];
  readonly storeys: number;
  /** Cells a storey, floor slab included. */
  readonly storeyHeight: number;
  /** Cells of foundation below the ground floor's row. */
  readonly foundationDepth: number;
  readonly roof: StructureRoof;
  readonly materials: StructureMaterials;
  readonly openings: readonly StructureOpening[];
  readonly stairs: readonly StructureStair[];
  /** The generator's version that last wrote the voxels (not a pin: a newer engine regenerates). */
  readonly generator: number;
}

/** A definition the structure refuses: `path` names the field (JSON pointer), the message says what to change. */
export class StructureDefinitionError extends Error {
  override readonly name = 'StructureDefinitionError';
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

type Json = Record<string, unknown>;

function obj(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new StructureDefinitionError(path, 'expected an object');
  return v as Json;
}

function only(o: Json, path: string, keys: readonly string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new StructureDefinitionError(`${path}/${k}`, `unknown field (a structure has ${keys.join(', ')})`);
}

function int(v: unknown, path: string, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new StructureDefinitionError(path, `${what} is a whole number from ${min} to ${max}`);
  return v;
}

function id(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new StructureDefinitionError(path, 'expected a name (a non-empty string)');
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !options.includes(v as T)) throw new StructureDefinitionError(path, `expected one of ${options.join(', ')}`);
  return v as T;
}

function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new StructureDefinitionError(path, 'expected a list');
  return v;
}

const BIG = 1 << 20;

/** Whether two closed axis-aligned segments share a point. */
function segmentsMeet(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): boolean {
  const [ax0, az0, ax1, az1] = a;
  const [bx0, bz0, bx1, bz1] = b;
  return Math.max(Math.min(ax0, ax1), Math.min(bx0, bx1)) <= Math.min(Math.max(ax0, ax1), Math.max(bx0, bx1)) && Math.max(Math.min(az0, az1), Math.min(bz0, bz1)) <= Math.min(Math.max(az0, az1), Math.max(bz0, bz1));
}

function polygon(v: unknown, path: string): FootprintPolygon {
  const o = obj(v, path);
  only(o, path, ['id', 'points']);
  const pts = list(o.points, `${path}/points`).map((p, k): [number, number] => {
    const at = `${path}/points/${k}`;
    if (!Array.isArray(p) || p.length !== 2) throw new StructureDefinitionError(at, 'a point is [x, z] in cells');
    return [int(p[0], `${at}/0`, WORLD_CELL_MIN_XZ, WORLD_CELL_MAX_XZ, 'x'), int(p[1], `${at}/1`, WORLD_CELL_MIN_XZ, WORLD_CELL_MAX_XZ, 'z')];
  });
  const n = pts.length;
  if (n < 4) throw new StructureDefinitionError(`${path}/points`, `a polygon has at least 4 corners (it has ${n})`);
  const edges: [number, number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = pts[k]!;
    const b = pts[(k + 1) % n]!;
    const along = (a[0] !== b[0] ? 1 : 0) + (a[1] !== b[1] ? 1 : 0);
    if (along === 0) throw new StructureDefinitionError(`${path}/points/${(k + 1) % n}`, `point ${(k + 1) % n} repeats point ${k} (${a.join(', ')}): remove it`);
    if (along === 2) throw new StructureDefinitionError(`${path}/points/${(k + 1) % n}`, `the edge from point ${k} (${a.join(', ')}) to point ${(k + 1) % n} (${b.join(', ')}) is diagonal: walls run along x or z (a turned wall is a second structure at another yaw)`);
    edges.push([a[0], a[1], b[0], b[1]]);
  }
  for (let k = 0; k < n; k++) {
    const e = edges[k]!;
    const f = edges[(k + 1) % n]!;
    if ((e[0] === e[2]) === (f[0] === f[2])) throw new StructureDefinitionError(`${path}/points/${(k + 1) % n}`, `point ${(k + 1) % n} (${f[0]}, ${f[1]}) lies on a straight run (its two edges both run along ${e[0] === e[2] ? 'z' : 'x'}): remove it`);
  }
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segmentsMeet(edges[i]!, edges[j]!)) throw new StructureDefinitionError(`${path}/points`, `edges ${i} and ${j} of the polygon cross or touch: an outline must not cross itself (use a second polygon for a wing or a courtyard's side)`);
  }
  return { id: id(o.id, `${path}/id`), points: pts };
}

function opening(v: unknown, path: string): StructureOpening {
  const o = obj(v, path);
  only(o, path, ['id', 'polygon', 'edge', 'storey', 'at', 'width', 'height', 'sill', 'prop']);
  const out: StructureOpening = {
    id: id(o.id, `${path}/id`),
    polygon: id(o.polygon, `${path}/polygon`),
    edge: int(o.edge, `${path}/edge`, 0, BIG, 'an edge'),
    storey: int(o.storey, `${path}/storey`, 0, BIG, 'a storey'),
    at: int(o.at, `${path}/at`, 0, BIG, 'a place along the edge'),
    width: int(o.width, `${path}/width`, 1, BIG, 'a width'),
    height: int(o.height, `${path}/height`, 1, BIG, 'a height'),
    sill: int(o.sill, `${path}/sill`, 0, BIG, 'a sill'),
  };
  return o.prop === undefined ? out : { ...out, prop: id(o.prop, `${path}/prop`) };
}

function stair(v: unknown, path: string): StructureStair {
  const o = obj(v, path);
  only(o, path, ['id', 'polygon', 'from', 'at', 'facing']);
  const at = o.at;
  if (!Array.isArray(at) || at.length !== 2) throw new StructureDefinitionError(`${path}/at`, 'the first step is [x, z] in cells');
  return {
    id: id(o.id, `${path}/id`),
    polygon: id(o.polygon, `${path}/polygon`),
    from: int(o.from, `${path}/from`, 0, BIG, 'a storey'),
    at: [int(at[0], `${path}/at/0`, WORLD_CELL_MIN_XZ, WORLD_CELL_MAX_XZ, 'x'), int(at[1], `${path}/at/1`, WORLD_CELL_MIN_XZ, WORLD_CELL_MAX_XZ, 'z')],
    facing: oneOf(o.facing, `${path}/facing`, STAIR_FACINGS),
  };
}

function unique(items: readonly { id: string }[], path: string, what: string): void {
  const seen = new Set<string>();
  items.forEach((it, k) => {
    if (seen.has(it.id)) throw new StructureDefinitionError(`${path}/${k}/id`, `two ${what} are named "${it.id}": names must differ`);
    seen.add(it.id);
  });
}

/**
 * A definition rebuilt field by field with its fields' own checks (types,
 * ranges, names, each polygon's outline); what needs the plan (openings on
 * an outside wall, stairs inside the plan) is checked by the building
 * generator's {@link canonicalStructureDefinition}.
 */
export function parseStructureDefinition(input: unknown): StructureDefinition {
  const o = obj(input, '');
  only(o, '', ['footprint', 'storeys', 'storeyHeight', 'foundationDepth', 'roof', 'materials', 'openings', 'stairs', 'generator']);
  const footprint = list(o.footprint, '/footprint').map((p, k) => polygon(p, `/footprint/${k}`));
  if (footprint.length === 0) throw new StructureDefinitionError('/footprint', 'a structure needs at least one polygon');
  unique(footprint, '/footprint', 'polygons');
  const r = obj(o.roof, '/roof');
  only(r, '/roof', ['shape', 'overhang', 'axis']);
  const roof: StructureRoof = { shape: oneOf(r.shape, '/roof/shape', ROOF_SHAPES), overhang: int(r.overhang, '/roof/overhang', 0, BIG, 'an overhang'), axis: oneOf(r.axis, '/roof/axis', ROOF_AXES) };
  const m = obj(o.materials, '/materials');
  only(m, '/materials', ['wall', 'floor', 'roof', 'foundation', 'stair']);
  const mat = (k: keyof StructureMaterials): number => int(m[k], `/materials/${k}`, 1, MATERIAL_ID_MAX, `a voxel material id (${k})`);
  const materials: StructureMaterials = { wall: mat('wall'), floor: mat('floor'), roof: mat('roof'), foundation: mat('foundation'), stair: mat('stair') };
  const openings = list(o.openings, '/openings').map((p, k) => opening(p, `/openings/${k}`));
  unique(openings, '/openings', 'openings');
  const stairs = list(o.stairs, '/stairs').map((p, k) => stair(p, `/stairs/${k}`));
  unique(stairs, '/stairs', 'stairs');
  return {
    footprint,
    storeys: int(o.storeys, '/storeys', 1, BIG, 'storeys'),
    storeyHeight: int(o.storeyHeight, '/storeyHeight', 2, BIG, 'a storey height in cells'),
    foundationDepth: int(o.foundationDepth, '/foundationDepth', 0, BIG, 'a foundation depth in cells'),
    roof,
    materials,
    openings,
    stairs,
    generator: int(o.generator, '/generator', 1, BIG, "the generator's version"),
  };
}

/** The same definition moved by whole cells on x and z (footprint, stairs; openings sit on edges and move with them). */
export function translateDefinition(def: StructureDefinition, dx: number, dz: number): StructureDefinition {
  return {
    ...def,
    footprint: def.footprint.map((p) => ({ id: p.id, points: p.points.map(([x, z]) => [x + dx, z + dz] as [number, number]) })),
    stairs: def.stairs.map((s) => ({ ...s, at: [s.at[0] + dx, s.at[1] + dz] as [number, number] })),
  };
}
