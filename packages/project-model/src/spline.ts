/**
 * The `spline` component: one generic curve through points, each with an
 * optional tangent, width and roll. What uses it reads the curve
 * (`spline-curve.ts`): scripts (`ctx.splines`, later camera rails and
 * movers), the terrain (a road or river carved, flattened and painted along
 * it, scatter kept clear of it), and the meshes and pieces made along it
 * (a road surface, a river's water, fences and walls).
 *
 * Points are offsets from the object's position, which is all that places
 * the curve (no rotation or scale), as a terrain and a block layer are
 * placed: what a spline carves and makes stays where the points say in the
 * world.
 *
 * Everything past the points is optional and absent means "not used": a
 * spline with only points changes nothing in the level.
 *
 * Pure.
 */
import type { ModelErrorV2 } from './errors';
import { TERRAIN_LAYER_MAX } from './terrain-sizes';
import { ID_RE } from './validate';
import { validateDecalLayerMask } from './decals';

/** The bounds of one spline's values (per request: the 64 KiB command bounds a spline's points first). */
export const SPLINE_LIMITS = Object.freeze({
  minPoints: 2,
  maxPoints: 4096,
  /** Metres either way for a point or a tangent. */
  coordinate: 100_000,
  /** Metres across. */
  widthMax: 1000,
  /** Degrees either way the cross-section turns about the curve. */
  rollMax: 89,
  /** Metres of falloff, depth, offset and margin. */
  distanceMax: 1000,
  profilePoints: 64,
  pieces: 16,
});

/** A point without a width of its own, and a spline without `width`, is this wide (m): a lane and its verges. */
export const SPLINE_WIDTH_DEFAULT = 4;
/** Metres past the half width over which a carve, flatten or paint fades out. */
export const SPLINE_FALLOFF_DEFAULT = 4;
/** Metres past the half width kept clear of scatter. */
export const SPLINE_SCATTER_MARGIN_DEFAULT = 1;
/** Metres between the cross-sections of a spline's mesh (its finest level). */
export const SPLINE_MESH_STEP_DEFAULT = 1;
/** Metres a surface mesh sits above its points (above ground the spline flattened to them). */
export const SPLINE_SURFACE_OFFSET_DEFAULT = 0.05;
/** A river's flow along the spline (m/s) and how far its foam reaches in from each bank (m). */
export const SPLINE_WATER_FLOW_DEFAULT = 1;
export const SPLINE_WATER_FOAM_DEFAULT = 1.5;
/** The material slot a spline's mesh wears (`materials: {"spline": id}` or `{"*": id}`). */
export const SPLINE_MATERIAL_SLOT = 'spline';

/** How the ground follows a spline: both ways, only down, only up, or not at all (paint only). */
export const SPLINE_TERRAIN_SHAPES = ['flatten', 'carve', 'raise', 'none'] as const;
export type SplineTerrainShape = (typeof SPLINE_TERRAIN_SHAPES)[number];
export const SPLINE_MESH_KINDS = ['surface', 'water'] as const;
export type SplineMeshKind = (typeof SPLINE_MESH_KINDS)[number];

export interface SplinePoint {
  /** Metres from the object's position. */
  at: [number, number, number];
  /** The curve's direction and pull here (metres per segment, as a Hermite tangent; absent: from the neighbours, a smooth Catmull-Rom curve). */
  tangent?: [number, number, number];
  /** Metres across here (absent: the spline's `width`). */
  width?: number;
  /** Degrees the cross-section turns about the curve here, right side up (absent: 0, level). */
  roll?: number;
}

export interface SplineTerrainSettings {
  /** How heights follow the spline (absent: flatten). */
  shape?: SplineTerrainShape;
  /** Metres past the half width the change fades over (absent: {@link SPLINE_FALLOFF_DEFAULT}). */
  falloff?: number;
  /** Metres below the points the centre line is cut (a river's channel, shallowing to the edges; absent: 0). */
  depth?: number;
  /** Metres below the points the whole width lies (a road's bed under its surface mesh; absent: 0). */
  offset?: number;
  /** Paint a material layer along it, over the material rules and under hand paint. */
  paint?: { layer: number; strength?: number; width?: number; falloff?: number };
  /** Splines apply lowest first (absent: 0; equal ones by object id). */
  order?: number;
}

export interface SplineScatterSettings {
  /** Metres past the half width kept clear (absent: {@link SPLINE_SCATTER_MARGIN_DEFAULT}). */
  margin?: number;
  /** Only these scatter rules are kept clear (absent: every rule). */
  rules?: string[];
}

export interface SplineMeshSettings {
  /** surface: the profile swept along (a road, a path, a wall); water: a river's surface carrying its flow and banks (absent: surface). */
  kind?: SplineMeshKind;
  /** The cross-section, left to right: [across, up], across in half widths (−1 the left edge, 1 the right), up in metres (absent: a flat strip). */
  profile?: [number, number][];
  /** Metres above the points (absent: {@link SPLINE_SURFACE_OFFSET_DEFAULT} for a surface, 0 for water). */
  offset?: number;
  /** Metres along the curve one texture repeat covers (absent: the spline's width). */
  tiling?: number;
  /** Metres between cross-sections at the finest level (absent: {@link SPLINE_MESH_STEP_DEFAULT}). */
  step?: number;
  /** Colliders from the mesh (absent: true for a surface, false for water). */
  collision?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** water: m/s along the curve (absent: {@link SPLINE_WATER_FLOW_DEFAULT}). */
  flow?: number;
  /** water: metres in from each bank the foam reaches (absent: {@link SPLINE_WATER_FOAM_DEFAULT}). */
  foam?: number;
}

export interface SplinePieceSettings {
  /** The model repeated along the curve (a fence segment, a post, a wall section). */
  asset: { assetId: string; piece?: string };
  /** Metres between pieces along the curve. */
  spacing: number;
  /** Metres from the start of the curve to the first piece (absent: 0). */
  start?: number;
  /** [across, up] metres from the curve (absent: on it). */
  offset?: [number, number];
  /** Degrees each piece turns about up beyond facing along the curve (absent: 0). */
  yaw?: number;
  /** Pieces stand upright (absent: true); false: they lean with the curve's slope and roll. */
  upright?: boolean;
  /** Pieces carry their model's `_COL` colliders (absent: true). */
  collide?: boolean;
  castShadow?: boolean;
}

export interface SplineComponent {
  points: SplinePoint[];
  /** The curve runs back from the last point to the first (absent: false). */
  closed?: boolean;
  /** Metres across where a point names none (absent: {@link SPLINE_WIDTH_DEFAULT}). */
  width?: number;
  /** Carve, flatten or raise the terrains it crosses, and paint them (absent: they are left as they are). */
  terrain?: SplineTerrainSettings;
  /** Keep the terrains' and block layers' scatter clear of it (absent: scatter is placed over it). */
  scatter?: SplineScatterSettings;
  /** A mesh along it (absent: none). */
  mesh?: SplineMeshSettings;
  /** Models repeated along it (absent: none). */
  pieces?: SplinePieceSettings[];
  /** SHA-256 of the mesh and pieces the project host made from the fields above (written by the host; absent: nothing made). */
  data?: string;
  /** The decal layers projected decals mark its mesh and pieces in, a bit mask (decals.ts; absent: every layer). */
  decalLayers?: number;
}

/** The component's fields in canonical order. */
export const SPLINE_FIELDS: readonly string[] = Object.freeze(['points', 'closed', 'width', 'terrain', 'scatter', 'mesh', 'pieces', 'data', 'decalLayers']);
const POINT_FIELDS = ['at', 'tangent', 'width', 'roll'];
const TERRAIN_FIELDS_ = ['shape', 'falloff', 'depth', 'offset', 'paint', 'order'];
const PAINT_FIELDS = ['layer', 'strength', 'width', 'falloff'];
const SCATTER_FIELDS = ['margin', 'rules'];
const MESH_FIELDS = ['kind', 'profile', 'offset', 'tiling', 'step', 'collision', 'castShadow', 'receiveShadow', 'flow', 'foam'];
const PIECE_FIELDS = ['asset', 'spacing', 'start', 'offset', 'yaw', 'upright', 'collide', 'castShadow'];
const DIGEST_RE = /^[0-9a-f]{64}$/;
const RULE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, lo: number, hi: number): boolean => finite(v) && v >= lo && v <= hi;
const vec = (v: unknown, n: number, lo: number, hi: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => within(x, lo, hi));

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

function only(v: Record<string, unknown>, keys: readonly string[], path: string, errors: ModelErrorV2[], what: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}"`, k);
}

function metres(v: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[], lo: number, hi: number, what: string): void {
  if (v[key] !== undefined && !within(v[key], lo, hi)) err(errors, 'field_value', `${path}/${key}`, `${key} is ${what}`, v[key]);
}

function bool(v: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[]): void {
  if (v[key] !== undefined && typeof v[key] !== 'boolean') err(errors, 'field_type', `${path}/${key}`, `${key} is true or false`, v[key]);
}

export function validateSplineComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const L = SPLINE_LIMITS;
  if (!isObj(value)) return err(errors, 'field_type', path, 'a spline is an object { points, closed?, width?, terrain?, scatter?, mesh?, pieces? }', value);
  only(value, SPLINE_FIELDS, path, errors, 'spline');
  const pts = value['points'];
  if (pts === undefined) err(errors, 'field_missing', `${path}/points`, 'points is required');
  else if (!Array.isArray(pts) || pts.length < L.minPoints || pts.length > L.maxPoints) err(errors, 'field_value', `${path}/points`, `points is a list of ${L.minPoints}-${L.maxPoints} points {at, tangent?, width?, roll?}`, Array.isArray(pts) ? pts.length : pts);
  else {
    pts.forEach((q, i) => {
      const p = `${path}/points/${i}`;
      if (!isObj(q)) return err(errors, 'field_type', p, 'a point is {at: [x, y, z], tangent?, width?, roll?}', q);
      only(q, POINT_FIELDS, p, errors, 'point');
      if (!vec(q['at'], 3, -L.coordinate, L.coordinate)) err(errors, 'field_value', `${p}/at`, `at is [x, y, z] metres from the object, within ±${L.coordinate}`, q['at']);
      if (q['tangent'] !== undefined && !vec(q['tangent'], 3, -L.coordinate, L.coordinate)) err(errors, 'field_value', `${p}/tangent`, `tangent is [x, y, z] metres, within ±${L.coordinate}`, q['tangent']);
      metres(q, 'width', p, errors, 0, L.widthMax, `0-${L.widthMax} metres`);
      metres(q, 'roll', p, errors, -L.rollMax, L.rollMax, `${-L.rollMax} to ${L.rollMax} degrees`);
    });
  }
  bool(value, 'closed', path, errors);
  if (value['closed'] === true && Array.isArray(pts) && pts.length < 3) err(errors, 'field_value', `${path}/closed`, 'a closed spline has at least 3 points', pts.length);
  metres(value, 'width', path, errors, 0, L.widthMax, `0-${L.widthMax} metres`);
  const t = value['terrain'];
  if (t !== undefined) {
    const p = `${path}/terrain`;
    if (!isObj(t)) err(errors, 'field_type', p, 'terrain is {shape?, falloff?, depth?, offset?, paint?, order?}', t);
    else {
      only(t, TERRAIN_FIELDS_, p, errors, 'terrain');
      if (t['shape'] !== undefined && !(SPLINE_TERRAIN_SHAPES as readonly unknown[]).includes(t['shape'])) err(errors, 'field_value', `${p}/shape`, `shape is ${SPLINE_TERRAIN_SHAPES.join(', ')}`, t['shape']);
      for (const k of ['falloff', 'depth', 'offset']) metres(t, k, p, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
      if (t['order'] !== undefined && !(Number.isInteger(t['order']) && Math.abs(t['order'] as number) <= 1_000_000)) err(errors, 'field_value', `${p}/order`, 'order is a whole number', t['order']);
      const paint = t['paint'];
      if (paint !== undefined) {
        const pp = `${p}/paint`;
        if (!isObj(paint)) err(errors, 'field_type', pp, 'paint is {layer, strength?, width?, falloff?}', paint);
        else {
          only(paint, PAINT_FIELDS, pp, errors, 'paint');
          if (!(Number.isInteger(paint['layer']) && (paint['layer'] as number) >= 0 && (paint['layer'] as number) <= TERRAIN_LAYER_MAX)) err(errors, 'field_value', `${pp}/layer`, `layer is the material layer painted, 0-${TERRAIN_LAYER_MAX}`, paint['layer']);
          metres(paint, 'strength', pp, errors, 0.01, 1, '0.01-1');
          metres(paint, 'width', pp, errors, 0, L.widthMax, `0-${L.widthMax} metres`);
          metres(paint, 'falloff', pp, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
        }
      }
    }
  }
  const sc = value['scatter'];
  if (sc !== undefined) {
    const p = `${path}/scatter`;
    if (!isObj(sc)) err(errors, 'field_type', p, 'scatter is {margin?, rules?}', sc);
    else {
      only(sc, SCATTER_FIELDS, p, errors, 'scatter');
      metres(sc, 'margin', p, errors, 0, L.distanceMax, `0-${L.distanceMax} metres`);
      const rules = sc['rules'];
      if (rules !== undefined && !(Array.isArray(rules) && rules.every((r) => typeof r === 'string' && RULE_ID_RE.test(r)))) err(errors, 'field_value', `${p}/rules`, 'rules is a list of scatter rule ids', rules);
    }
  }
  const m = value['mesh'];
  if (m !== undefined) {
    const p = `${path}/mesh`;
    if (!isObj(m)) err(errors, 'field_type', p, 'mesh is {kind?, profile?, offset?, tiling?, step?, collision?, castShadow?, receiveShadow?, flow?, foam?}', m);
    else {
      only(m, MESH_FIELDS, p, errors, 'mesh');
      if (m['kind'] !== undefined && !(SPLINE_MESH_KINDS as readonly unknown[]).includes(m['kind'])) err(errors, 'field_value', `${p}/kind`, `kind is ${SPLINE_MESH_KINDS.join(', ')}`, m['kind']);
      const prof = m['profile'];
      if (prof !== undefined && !(Array.isArray(prof) && prof.length >= 2 && prof.length <= L.profilePoints && prof.every((q) => vec(q, 2, -L.distanceMax, L.distanceMax)))) {
        err(errors, 'field_value', `${p}/profile`, `profile is 2-${L.profilePoints} points [across, up] (across in half widths, up in metres), left to right`, prof);
      }
      metres(m, 'offset', p, errors, -L.distanceMax, L.distanceMax, `metres within ±${L.distanceMax}`);
      metres(m, 'tiling', p, errors, 0.01, L.distanceMax, `0.01-${L.distanceMax} metres`);
      if (m['step'] !== undefined && !(finite(m['step']) && m['step'] >= 0.05 && m['step'] <= 100)) err(errors, 'field_value', `${p}/step`, 'step is 0.05-100 metres', m['step']);
      for (const k of ['collision', 'castShadow', 'receiveShadow']) bool(m, k, p, errors);
      metres(m, 'flow', p, errors, 0, 100, '0-100 m/s');
      metres(m, 'foam', p, errors, 0, L.widthMax, `0-${L.widthMax} metres`);
    }
  }
  const pieces = value['pieces'];
  if (pieces !== undefined) {
    if (!Array.isArray(pieces) || pieces.length > L.pieces) err(errors, 'field_value', `${path}/pieces`, `pieces is a list of at most ${L.pieces} {asset, spacing, …}`, pieces);
    else {
      pieces.forEach((q, i) => {
        const p = `${path}/pieces/${i}`;
        if (!isObj(q)) return err(errors, 'field_type', p, 'a piece is {asset: {assetId, piece?}, spacing, start?, offset?, yaw?, upright?, collide?, castShadow?}', q);
        only(q, PIECE_FIELDS, p, errors, 'piece');
        const a = q['asset'];
        if (!isObj(a)) err(errors, 'field_type', `${p}/asset`, 'asset is {assetId, piece?}: the model repeated', a);
        else {
          only(a, ['assetId', 'piece'], `${p}/asset`, errors, 'asset');
          if (typeof a['assetId'] !== 'string' || !ID_RE.test(a['assetId'])) err(errors, 'field_value', `${p}/asset/assetId`, 'assetId names the model repeated', a['assetId']);
          if (a['piece'] !== undefined && !(typeof a['piece'] === 'string' && a['piece'].length >= 1 && a['piece'].length <= 128)) err(errors, 'field_value', `${p}/asset/piece`, 'piece is 1-128 characters: a named piece of the file', a['piece']);
        }
        if (!(finite(q['spacing']) && q['spacing'] >= 0.05 && q['spacing'] <= L.distanceMax)) err(errors, 'field_value', `${p}/spacing`, `spacing is 0.05-${L.distanceMax} metres between pieces`, q['spacing']);
        metres(q, 'start', p, errors, 0, L.coordinate, `0-${L.coordinate} metres`);
        if (q['offset'] !== undefined && !vec(q['offset'], 2, -L.distanceMax, L.distanceMax)) err(errors, 'field_value', `${p}/offset`, `offset is [across, up] metres within ±${L.distanceMax}`, q['offset']);
        metres(q, 'yaw', p, errors, -360, 360, '-360 to 360 degrees');
        for (const k of ['upright', 'collide', 'castShadow']) bool(q, k, p, errors);
      });
    }
  }
  if (value['data'] !== undefined && (typeof value['data'] !== 'string' || !DIGEST_RE.test(value['data']))) err(errors, 'field_value', `${path}/data`, 'data is the SHA-256 of what the host made along the spline (64 lowercase hex)', value['data']);
  validateDecalLayerMask(value['decalLayers'], `${path}/decalLayers`, errors, 0);
}

const v3 = (v: readonly number[]): [number, number, number] => [v[0]!, v[1]!, v[2]!];
/** Only the fields present, in `keys` order. */
function pick<T extends object>(v: T, keys: readonly string[]): T {
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out as T;
}

/** The component in canonical form (fields and nested fields in order). */
export function canonicalSpline(c: SplineComponent): SplineComponent {
  const out: SplineComponent = {
    points: c.points.map((q) => pick({ at: v3(q.at), ...(q.tangent !== undefined ? { tangent: v3(q.tangent) } : {}), ...(q.width !== undefined ? { width: q.width } : {}), ...(q.roll !== undefined ? { roll: q.roll } : {}) }, POINT_FIELDS)),
  };
  if (c.closed !== undefined) out.closed = c.closed;
  if (c.width !== undefined) out.width = c.width;
  if (c.terrain !== undefined) {
    const t = pick(c.terrain, TERRAIN_FIELDS_);
    if (t.paint !== undefined) t.paint = pick(t.paint, PAINT_FIELDS);
    out.terrain = t;
  }
  if (c.scatter !== undefined) out.scatter = pick({ ...c.scatter, ...(c.scatter.rules !== undefined ? { rules: [...c.scatter.rules] } : {}) }, SCATTER_FIELDS);
  if (c.mesh !== undefined) out.mesh = pick({ ...c.mesh, ...(c.mesh.profile !== undefined ? { profile: c.mesh.profile.map((q) => [q[0], q[1]] as [number, number]) } : {}) }, MESH_FIELDS);
  if (c.pieces !== undefined) out.pieces = c.pieces.map((q) => pick({ ...q, asset: { assetId: q.asset.assetId, ...(q.asset.piece !== undefined ? { piece: q.asset.piece } : {}) }, ...(q.offset !== undefined ? { offset: [q.offset[0], q.offset[1]] as [number, number] } : {}) }, PIECE_FIELDS));
  if (c.data !== undefined) out.data = c.data;
  if (c.decalLayers !== undefined) out.decalLayers = c.decalLayers;
  return out;
}

/** Whether the host makes anything from the spline (a mesh or pieces): what `data` holds. */
export function splineMakesData(c: Pick<SplineComponent, 'mesh' | 'pieces'>): boolean {
  return c.mesh !== undefined || (c.pieces !== undefined && c.pieces.length > 0);
}

/** The model assets a spline's pieces repeat. */
export function splinePieceAssets(c: Pick<SplineComponent, 'pieces'> | undefined): string[] {
  return [...new Set((c?.pieces ?? []).map((p) => p.asset.assetId))];
}
