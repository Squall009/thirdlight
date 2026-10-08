/**
 * Probe grids: baked indirect light at points of a regular grid, which every
 * 3D object samples between the probes.
 *
 * A scene's probes are baked from its static objects and its baked/mixed
 * lights. Where they go:
 * - each `probeVolume` component (a box around its entity, axis-aligned in
 *   world space) gets its own grids at its own spacing (or the bake's);
 * - a scene without probe volumes gets grids over the bounds of its static
 *   objects, placed automatically.
 * Probes are `spacing` apart horizontally; near the ground (the bottom of
 * the volume, `PROBE_GROUND_BAND` spacings high) they are twice as dense
 * vertically, where characters walk and the light changes fastest. Large
 * volumes are split into tiles of at most `PROBE_TILE_INTERVALS` probe
 * intervals per axis; neighbouring tiles share their boundary plane, so a
 * point is in one tile (or on a shared face, where both tiles hold the same
 * probes). No count cap: a bigger scene simply has more tiles, and the bake
 * reports their memory.
 *
 * The baked result is `content.lighting[sceneId].probes`: per tile its box,
 * its probe counts and a texture asset holding the probes (the bake's
 * artifact, a 16-bit PNG whose samples are half floats: per probe
 * `PROBE_TEXELS` RGBA texels — the nine L2 spherical-harmonic RGB
 * coefficients of the radiance the probe sees, packed as three.js's
 * `LightProbeGrid` atlas packs them, with the probe's validity in the seventh
 * texel's alpha (`PROBE_SH_TEXELS`), then its walls: per axis, whether a
 * surface cuts the edge to the next probe along it (1 or 0) and where (the
 * cut's share of the edge, times the cut flag), x and y in one texel, z in
 * the next — so the hardware filter interpolates the four edges of a cell
 * around any point).
 */
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';
import type { Vec3 } from './types';
import { SKY_ROTATION_MAX } from './materials';

/** Default horizontal distance between probes (meters). */
export const DEFAULT_PROBE_SPACING = 2;
/** The spacings a bake or a volume may ask for (meters). */
export const PROBE_SPACING_MIN = 0.25;
export const PROBE_SPACING_MAX = 32;
/** The ground band's height, in horizontal spacings; inside it probes are `PROBE_GROUND_DENSITY` times denser vertically. */
export const PROBE_GROUND_BAND = 2;
export const PROBE_GROUND_DENSITY = 2;
/** Most probe intervals along one axis of one tile (a tile is one 3D texture and one artifact file). */
export const PROBE_TILE_INTERVALS = 64;
/** Default extra bounce passes of a probe bake. */
export const DEFAULT_PROBE_BOUNCES = 2;
export const MAX_PROBE_BOUNCES = 8;
/**
 * A probe that sees back faces in more than this share of its directions is
 * inside geometry: invalid. It is moved out along the free direction (a
 * virtual offset) or filled from its valid neighbours (dilation).
 */
export const PROBE_VALIDITY_THRESHOLD = 0.25;
/** RGBA texels per probe holding its light: 27 SH values and the validity. */
export const PROBE_SH_TEXELS = 7;
/** RGBA texels per probe in a probe artifact: its light, then its walls. */
export const PROBE_TEXELS = 9;
/**
 * RGBA half-float texels a probe takes in the GPU texture the materials
 * sample (the adapter's probe lighting packs it): its first-order light and
 * weight in four, its walls in two.
 */
export const PROBE_GPU_TEXELS = 6;
/** Probes per row of a probe artifact (its width is this times `PROBE_TEXELS` texels, under the texture edge limit). */
export const PROBE_ARTIFACT_ROW_PROBES = 448;
/** Padding slices at both ends of each of the seven sub-volumes of a probe tile's 3D texture (three.js's atlas layout). */
export const PROBE_ATLAS_PADDING = 1;
/** Validity values a probe artifact stores in its last alpha. */
export const PROBE_VALID = 1;
export const PROBE_MOVED = 0.5;
export const PROBE_FILLED = 0;

/** A tile: its world box and its probes per axis (probes sit on the box's corners and every spacing between). */
export interface ProbeGridBox {
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
}

export interface ProbeGridRecord extends ProbeGridBox {
  /** The texture asset holding this tile's probes. */
  asset: string;
}

export interface ProbeBake {
  /** ISO-8601 time of the bake. */
  createdAt: string;
  /** The horizontal spacing the bake used where no volume set its own (the scene's probe spacing for the next bake). */
  spacing: number;
  bounces: number;
  grids: ProbeGridRecord[];
  /** Probes baked in all tiles; of those, moved out of geometry and filled from neighbours. */
  probes: number;
  moved: number;
  filled: number;
  /** GPU memory of the tiles' 3D textures (bytes). */
  gpuBytes: number;
  /** Hashes of the baked/mixed lights and the static objects at bake time (stale check). */
  lightsHash: string;
  staticsHash: string;
  /** The texture sky's turn the probes saw (degrees; absent: 0): another turn makes them stale. */
  skyRotation?: number;
}

/** The `probeVolume` component: a box of probes around the entity (its position is the centre). */
export interface ProbeVolumeComponent {
  size: Vec3;
  /** Horizontal spacing inside this volume (absent: the bake's). */
  spacing?: number;
}

/** A volume as the placement reads it: world box (axis-aligned) and its own spacing. */
export interface ProbeVolumeBox {
  min: readonly number[];
  max: readonly number[];
  spacing?: number;
}

/** The probes of one tile. */
export function probeCount(g: { resolution: readonly number[] }): number {
  return g.resolution[0]! * g.resolution[1]! * g.resolution[2]!;
}

/** A tile's share of the GPU texture (bytes): RGBA half floats, a padded sub-volume along z per GPU texel. */
export function probeGridGpuBytes(g: { resolution: readonly number[] }): number {
  const [nx, ny, nz] = g.resolution as Vec3;
  return nx * ny * PROBE_GPU_TEXELS * (nz + 2 * PROBE_ATLAS_PADDING) * 8;
}

/** A tile's artifact image size (pixels). */
export function probeArtifactSize(probes: number): { width: number; height: number } {
  const perRow = Math.min(probes, PROBE_ARTIFACT_ROW_PROBES);
  return { width: perRow * PROBE_TEXELS, height: Math.ceil(probes / PROBE_ARTIFACT_ROW_PROBES) };
}

/** Split [lo, hi] into intervals of `step` (at least one), then into runs of at most `PROBE_TILE_INTERVALS`: the probe planes of each run. */
function axisRuns(lo: number, hi: number, step: number): { lo: number; hi: number; probes: number }[] {
  const intervals = Math.max(1, Math.ceil((hi - lo) / step - 1e-6));
  // Centred on the range: the probes keep their spacing exactly, the outer ones a little outside.
  const start = (lo + hi) / 2 - (intervals * step) / 2;
  const runs: { lo: number; hi: number; probes: number }[] = [];
  for (let i = 0; i < intervals; i += PROBE_TILE_INTERVALS) {
    const n = Math.min(PROBE_TILE_INTERVALS, intervals - i);
    runs.push({ lo: start + i * step, hi: start + (i + n) * step, probes: n + 1 });
  }
  return runs;
}

/** The vertical runs of a box: the ground band at the finer spacing, the rest above at the horizontal one. */
function verticalRuns(lo: number, hi: number, spacing: number): { lo: number; hi: number; probes: number }[] {
  const fine = spacing / PROBE_GROUND_DENSITY;
  const band = PROBE_GROUND_BAND * spacing;
  if (hi - lo <= band + 1e-6) {
    // All of it is near the ground: fine layers from the bottom up.
    const intervals = Math.max(1, Math.ceil((hi - lo) / fine - 1e-6));
    return axisRuns(lo, lo + intervals * fine, fine);
  }
  const top = lo + band;
  const above = Math.max(1, Math.ceil((hi - top) / spacing - 1e-6));
  // The ground band's top plane is the upper part's bottom plane (shared, like any tile boundary).
  return [...axisRuns(lo, top, fine), ...axisRuns(top, top + above * spacing, spacing)];
}

/** The step at most `step` that divides [lo, hi] into whole intervals (the probes on its ends exactly). */
function fitted(lo: number, hi: number, step: number): number {
  return (hi - lo) / Math.max(1, Math.ceil((hi - lo) / step - 1e-6));
}

/**
 * Tiles over one box at one horizontal spacing. `exact`: the outer probes on
 * the box's faces (the spacing shrunk to fit), not a little outside it — a
 * room's probes stay inside its walls.
 */
export function probeTilesOver(min: readonly number[], max: readonly number[], spacing: number, exact = false): ProbeGridBox[] {
  const s = Math.min(PROBE_SPACING_MAX, Math.max(PROBE_SPACING_MIN, spacing));
  const xs = axisRuns(min[0]!, max[0]!, exact ? fitted(min[0]!, max[0]!, s) : s);
  const zs = axisRuns(min[2]!, max[2]!, exact ? fitted(min[2]!, max[2]!, s) : s);
  // A room no higher than the ground band: fine layers fitted from its floor to its top.
  const fine = s / PROBE_GROUND_DENSITY;
  const ys = exact && max[1]! - min[1]! <= PROBE_GROUND_BAND * s + 1e-6 ? axisRuns(min[1]!, max[1]!, fitted(min[1]!, max[1]!, fine)) : verticalRuns(min[1]!, max[1]!, s);
  const out: ProbeGridBox[] = [];
  for (const y of ys) for (const z of zs) for (const x of xs) out.push({ min: [x.lo, y.lo, z.lo], max: [x.hi, y.hi, z.hi], resolution: [x.probes, y.probes, z.probes] });
  return out;
}

/**
 * Metres a room's probe volume keeps from its walls, floor and top: its
 * outer probes stand in the room's air, not in the walls (where they would
 * be moved or filled).
 */
export const ROOM_PROBE_INSET = 0.25;

/**
 * Where a scene's probes go: each volume's tiles, or (no volumes) tiles over
 * the static objects' bounds, raised half a spacing above their top so the
 * tops of roofs and walls have probes over them. Null bounds and no volumes:
 * nothing to bake.
 *
 * Rooms of generated architecture (`rooms`: their boxes, inset by
 * {@link ROOM_PROBE_INSET}) each get tiles of their own, listed first: a
 * point in a room reads its room's probes (the first tile holding a point
 * wins), which see that room only, so no light reaches it from the probes
 * of the room behind its wall.
 */
export function placeProbeGrids(staticBounds: { min: readonly number[]; max: readonly number[] } | null, spacing: number, volumes: readonly ProbeVolumeBox[] = [], rooms: readonly ProbeVolumeBox[] = []): ProbeGridBox[] {
  const own = rooms.flatMap((r) => probeTilesOver(r.min, r.max, r.spacing ?? spacing, true));
  if (volumes.length > 0) return [...own, ...volumes.flatMap((v) => probeTilesOver(v.min, v.max, v.spacing ?? spacing))];
  if (staticBounds === null) return own;
  const top = [staticBounds.max[0]!, staticBounds.max[1]! + spacing / 2, staticBounds.max[2]!];
  return [...own, ...probeTilesOver(staticBounds.min, top, spacing)];
}

// ---- Validation ------------------------------------------------------------------------

const HASH_RE = /^[0-9a-f]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** World coordinates a probe box may reach (meters): the block layers' reach and more. */
const MAX_PROBE_COORD = 1_000_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
const finite = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const intIn = (v: unknown, lo: number, hi: number): boolean => finite(v, lo, hi) && Number.isInteger(v);
const vec3In = (v: unknown, lo: number, hi: number): boolean => Array.isArray(v) && v.length === 3 && v.every((n) => finite(n, lo, hi));

const PROBE_BAKE_FIELDS = ['createdAt', 'spacing', 'bounces', 'grids', 'probes', 'moved', 'filled', 'gpuBytes', 'lightsHash', 'staticsHash'];
/** Optional fields of a probe bake. */
const PROBE_BAKE_OPTIONAL = ['skyRotation'];
const GRID_FIELDS = ['min', 'max', 'resolution', 'asset'];

/** `lighting[sceneId].probes` (structure and ranges; the assets' kinds are checked with the content). */
export function validateProbeBake(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'probes is an object', value);
    return;
  }
  for (const k of Object.keys(value)) if (!PROBE_BAKE_FIELDS.includes(k) && !PROBE_BAKE_OPTIONAL.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown probes field "${k}"`, k);
  for (const k of PROBE_BAKE_FIELDS) if (value[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `"${k}" is required`);
  const v = value;
  if (v['createdAt'] !== undefined && (typeof v['createdAt'] !== 'string' || !ISO_RE.test(v['createdAt']))) err(errors, 'field_value', `${path}/createdAt`, 'createdAt is an ISO-8601 UTC time', v['createdAt']);
  if (v['spacing'] !== undefined && !finite(v['spacing'], PROBE_SPACING_MIN, PROBE_SPACING_MAX)) err(errors, 'field_value', `${path}/spacing`, `spacing is a number in [${PROBE_SPACING_MIN}, ${PROBE_SPACING_MAX}]`, v['spacing']);
  if (v['bounces'] !== undefined && !intIn(v['bounces'], 0, MAX_PROBE_BOUNCES)) err(errors, 'field_value', `${path}/bounces`, `bounces is an integer in [0, ${MAX_PROBE_BOUNCES}]`, v['bounces']);
  for (const k of ['probes', 'moved', 'filled', 'gpuBytes']) if (v[k] !== undefined && !intIn(v[k], 0, Number.MAX_SAFE_INTEGER)) err(errors, 'field_value', `${path}/${k}`, `${k} is a non-negative integer`, v[k]);
  for (const k of ['lightsHash', 'staticsHash']) if (v[k] !== undefined && (typeof v[k] !== 'string' || !HASH_RE.test(v[k] as string))) err(errors, 'field_value', `${path}/${k}`, `${k} is 16 lowercase hex digits`, v[k]);
  if (v['skyRotation'] !== undefined && !finite(v['skyRotation'], -SKY_ROTATION_MAX, SKY_ROTATION_MAX)) err(errors, 'field_value', `${path}/skyRotation`, `skyRotation is degrees in [${-SKY_ROTATION_MAX}, ${SKY_ROTATION_MAX}]`, v['skyRotation']);
  const grids = v['grids'];
  if (grids === undefined) return;
  if (!Array.isArray(grids) || grids.length < 1) {
    err(errors, 'field_value', `${path}/grids`, 'grids is a non-empty list of probe tiles', grids);
    return;
  }
  grids.forEach((g, i) => {
    const p = `${path}/grids/${i}`;
    if (!isPlainObject(g)) {
      err(errors, 'field_type', p, 'a probe tile is an object', g);
      return;
    }
    for (const k of Object.keys(g)) if (!GRID_FIELDS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown probe tile field "${k}"`, k);
    if (!vec3In(g['min'], -MAX_PROBE_COORD, MAX_PROBE_COORD)) err(errors, 'field_value', `${p}/min`, 'min is [x, y, z] in meters', g['min']);
    if (!vec3In(g['max'], -MAX_PROBE_COORD, MAX_PROBE_COORD)) err(errors, 'field_value', `${p}/max`, 'max is [x, y, z] in meters', g['max']);
    else if (Array.isArray(g['min']) && (g['max'] as number[]).some((m, j) => !(m > ((g['min'] as number[])[j] as number)))) err(errors, 'field_value', `${p}/max`, 'max is above min on every axis', g['max']);
    const r = g['resolution'];
    if (!(Array.isArray(r) && r.length === 3 && r.every((n) => intIn(n, 2, PROBE_TILE_INTERVALS + 1)))) err(errors, 'field_value', `${p}/resolution`, `resolution is [nx, ny, nz], each 2–${PROBE_TILE_INTERVALS + 1} probes`, r);
    if (typeof g['asset'] !== 'string' || !ID_RE.test(g['asset'])) err(errors, 'field_value', `${p}/asset`, 'asset is a texture asset id', g['asset']);
  });
}

export function canonicalProbeBake(b: ProbeBake): ProbeBake {
  const v3 = (a: readonly number[]): Vec3 => [a[0]!, a[1]!, a[2]!];
  return {
    createdAt: b.createdAt,
    spacing: b.spacing,
    bounces: b.bounces,
    grids: b.grids.map((g) => ({ min: v3(g.min), max: v3(g.max), resolution: v3(g.resolution), asset: g.asset })),
    probes: b.probes,
    moved: b.moved,
    filled: b.filled,
    gpuBytes: b.gpuBytes,
    lightsHash: b.lightsHash,
    staticsHash: b.staticsHash,
    ...(b.skyRotation !== undefined ? { skyRotation: b.skyRotation } : {}),
  };
}

export function validateProbeVolumeComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a probe volume is an object { size, spacing? }', value);
    return;
  }
  for (const k of Object.keys(value)) if (k !== 'size' && k !== 'spacing') err(errors, 'field_unexpected', `${path}/${k}`, `unknown probe volume field "${k}"`, k);
  const size = value['size'];
  if (!(Array.isArray(size) && size.length === 3 && size.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100_000))) err(errors, 'field_value', `${path}/size`, 'size is [x, y, z] in meters, each 0 < v <= 100000', size);
  if (value['spacing'] !== undefined && !finite(value['spacing'], PROBE_SPACING_MIN, PROBE_SPACING_MAX)) err(errors, 'field_value', `${path}/spacing`, `spacing is a number in [${PROBE_SPACING_MIN}, ${PROBE_SPACING_MAX}] meters`, value['spacing']);
}

export function canonicalProbeVolume(v: ProbeVolumeComponent): ProbeVolumeComponent {
  return { size: [v.size[0], v.size[1], v.size[2]], ...(v.spacing !== undefined ? { spacing: v.spacing } : {}) };
}
