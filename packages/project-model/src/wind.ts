/**
 * Wind: one field per scene. The scene's look holds the global wind
 * (`SceneEnvironment.wind`); `windZone` components override any of its
 * values inside a box or a sphere and blend into it over their edge.
 *
 * The field is read top-down: a zone is its footprint on the ground (its
 * height is ignored), and the gust pattern is a noise texture scrolled over
 * the world along the wind. The renderer bakes the global value and the
 * zones round the view into a small map (`fillWindMap`, the same maths as
 * `windAt`, which is the reference); shaders read the map and the noise.
 * Nothing caps the zones: a zone costs map texels, not a shader slot.
 *
 * Pure data and maths (the format, the validators, the blend).
 */
import type { ModelErrorV2 } from './errors';
import type { WindConfig, WindOctave } from './materials';
import { ID_RE } from './validate';
import { isPlainObject } from '@thirdlight/shared';

/** The bounds of the wind's values (validation, the editor's sliders). */
export const WIND_LIMITS = Object.freeze({
  strengthMax: 10,
  gustMax: 10,
  gustFrequencyMax: 10,
  speedMax: 100,
  scaleMin: 0.5,
  scaleMax: 10000,
  octaveScaleMin: 0.05,
  octaveScaleMax: 4,
  octaveSpeedMax: 8,
  zoneSizeMax: 100000,
  blendMax: 10000,
  priorityMin: -1000,
  priorityMax: 1000,
});

/**
 * Defaults of the optional values. A 20 m pattern is a field's gust size;
 * the second layer is about a quarter of it and a little faster, at a ratio
 * that is not a whole number so the two never line up.
 */
export const WIND_DEFAULTS = Object.freeze({
  scale: 20,
  octave: Object.freeze({ scale: 0.27, speed: 1.6 }) as Readonly<WindOctave>,
  zoneBlend: 2,
  zonePriority: 0,
  /** A box zone's size and a sphere zone's radius when absent: a clearing. */
  zoneSize: Object.freeze([20, 10, 20]) as readonly [number, number, number],
  zoneRadius: 10,
});

export const WIND_ZONE_SHAPES = ['box', 'sphere'] as const;
export type WindZoneShape = (typeof WIND_ZONE_SHAPES)[number];

/** The `windZone` component: a box or sphere around the object that overrides the scene's wind. */
export interface WindZoneComponent {
  shape: WindZoneShape;
  /** A box's width, height and depth (the object's scale applies; absent: {@link WIND_DEFAULTS}). */
  size?: [number, number, number];
  /** A sphere's radius (the object's largest scale applies; absent: {@link WIND_DEFAULTS}). */
  radius?: number;
  /** Metres inside its edge over which it fades in from the wind around it (absent: {@link WIND_DEFAULTS}). */
  blend?: number;
  /** Where zones overlap, the higher priority is laid over the lower (absent: 0). */
  priority?: number;
  /** Overrides (absent: the wind around it). */
  direction?: [number, number];
  strength?: number;
  gust?: number;
  turbulence?: number;
  speed?: number;
  scale?: number;
}

/** The component's fields in canonical order. */
export const WIND_ZONE_FIELDS: readonly string[] = Object.freeze(['shape', 'size', 'radius', 'blend', 'priority', 'direction', 'strength', 'gust', 'turbulence', 'speed', 'scale']);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const directionOk = (d: unknown): boolean => Array.isArray(d) && d.length === 2 && d.every((x) => finite(x, -1, 1)) && !(d[0] === 0 && d[1] === 0);

/** The ranges of the numbers a wind and a zone share. */
const SHARED_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  strength: [0, WIND_LIMITS.strengthMax],
  gust: [0, WIND_LIMITS.gustMax],
  turbulence: [0, 1],
  speed: [0, WIND_LIMITS.speedMax],
  scale: [WIND_LIMITS.scaleMin, WIND_LIMITS.scaleMax],
};

const WIND_FIELDS = ['direction', 'strength', 'gust', 'gustFrequency', 'turbulence', 'noise', 'speed', 'scale', 'octave'];

/** A scene's (global) wind. */
export function validateWind(w: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(w)) return err(errors, 'field_type', path, 'wind is an object', w);
  if (!directionOk(w['direction'])) err(errors, 'field_value', `${path}/direction`, 'direction is [x, z], each in [-1, 1], not both 0', w['direction']);
  const required: Record<string, readonly [number, number]> = { strength: SHARED_RANGES['strength']!, gust: SHARED_RANGES['gust']!, gustFrequency: [0, WIND_LIMITS.gustFrequencyMax], turbulence: [0, 1] };
  for (const [k, [lo, hi]] of Object.entries(required)) if (!finite(w[k], lo, hi)) err(errors, 'field_value', `${path}/${k}`, `${k} must be a number in [${lo}, ${hi}]`, w[k]);
  for (const k of ['speed', 'scale'] as const) {
    const [lo, hi] = SHARED_RANGES[k]!;
    if (w[k] !== undefined && !finite(w[k], lo, hi)) err(errors, 'field_value', `${path}/${k}`, `${k} must be a number in [${lo}, ${hi}]`, w[k]);
  }
  const noise = w['noise'];
  if (noise !== undefined && (typeof noise !== 'string' || !ID_RE.test(noise))) err(errors, 'id_invalid', `${path}/noise`, 'noise names a texture asset (its id)', noise);
  const o = w['octave'];
  if (o !== undefined) {
    if (!isPlainObject(o)) err(errors, 'field_type', `${path}/octave`, 'octave is { scale, speed } (shares of the wind\'s scale and speed)', o);
    else {
      if (!finite(o['scale'], WIND_LIMITS.octaveScaleMin, WIND_LIMITS.octaveScaleMax)) err(errors, 'field_value', `${path}/octave/scale`, `the octave's scale is a share ${WIND_LIMITS.octaveScaleMin}–${WIND_LIMITS.octaveScaleMax} of the wind's`, o['scale']);
      if (!finite(o['speed'], 0, WIND_LIMITS.octaveSpeedMax)) err(errors, 'field_value', `${path}/octave/speed`, `the octave's speed is a share 0–${WIND_LIMITS.octaveSpeedMax} of the wind's`, o['speed']);
      for (const k of Object.keys(o)) if (k !== 'scale' && k !== 'speed') err(errors, 'field_unexpected', `${path}/octave/${k}`, `unknown octave field "${k}" (scale, speed)`, k);
    }
  }
  for (const k of Object.keys(w)) if (!WIND_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown wind field "${k}"`, k);
}

/** A wind in its stored form (fixed field order, optional fields only when set). */
export function canonicalWind(w: WindConfig): WindConfig {
  return {
    direction: [w.direction[0], w.direction[1]],
    strength: w.strength,
    gust: w.gust,
    gustFrequency: w.gustFrequency,
    turbulence: w.turbulence,
    ...(w.noise !== undefined ? { noise: w.noise } : {}),
    ...(w.speed !== undefined ? { speed: w.speed } : {}),
    ...(w.scale !== undefined ? { scale: w.scale } : {}),
    ...(w.octave !== undefined ? { octave: { scale: w.octave.scale, speed: w.octave.speed } } : {}),
  };
}

export function validateWindZoneComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const L = WIND_LIMITS;
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a wind zone is an object { shape, size? (box), radius? (sphere), blend?, priority?, direction?, strength?, gust?, turbulence?, speed?, scale? }', value);
  for (const k of Object.keys(value)) if (!WIND_ZONE_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown wind zone field "${k}" (${WIND_ZONE_FIELDS.join(', ')})`, k);
  const shape = value['shape'];
  if (!(WIND_ZONE_SHAPES as readonly unknown[]).includes(shape)) err(errors, shape === undefined ? 'field_missing' : 'field_value', `${path}/shape`, `shape is one of ${WIND_ZONE_SHAPES.join(', ')}`, shape);
  const size = value['size'];
  if (size !== undefined && !(Array.isArray(size) && size.length === 3 && size.every((n) => finite(n, 0, L.zoneSizeMax) && n > 0))) err(errors, 'field_value', `${path}/size`, `size is [width, height, depth] in metres, each 0 < v <= ${L.zoneSizeMax}`, size);
  const radius = value['radius'];
  if (radius !== undefined && !(finite(radius, 0, L.zoneSizeMax) && radius > 0)) err(errors, 'field_value', `${path}/radius`, `radius is metres, 0 < v <= ${L.zoneSizeMax}`, radius);
  if (value['blend'] !== undefined && !finite(value['blend'], 0, L.blendMax)) err(errors, 'field_value', `${path}/blend`, `blend is metres, 0–${L.blendMax}`, value['blend']);
  const priority = value['priority'];
  if (priority !== undefined && !(finite(priority, L.priorityMin, L.priorityMax) && Number.isInteger(priority))) err(errors, 'field_value', `${path}/priority`, `priority is an integer ${L.priorityMin}–${L.priorityMax}`, priority);
  if (value['direction'] !== undefined && !directionOk(value['direction'])) err(errors, 'field_value', `${path}/direction`, 'direction is [x, z], each in [-1, 1], not both 0', value['direction']);
  for (const [k, [lo, hi]] of Object.entries(SHARED_RANGES)) if (value[k] !== undefined && !finite(value[k], lo, hi)) err(errors, 'field_value', `${path}/${k}`, `${k} must be a number in [${lo}, ${hi}]`, value[k]);
}

export function canonicalWindZone(c: WindZoneComponent): WindZoneComponent {
  const out: Record<string, unknown> = {};
  for (const k of WIND_ZONE_FIELDS) {
    const v = (c as unknown as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = Array.isArray(v) ? [...(v as number[])] : v;
  }
  return out as unknown as WindZoneComponent;
}

// ---- the field ----

/** The wind at a point, every value given. */
export interface WindValues {
  /** Direction (unit, [x, z]). */
  dirX: number;
  dirZ: number;
  strength: number;
  gust: number;
  turbulence: number;
  /** Metres per second the pattern travels. */
  speed: number;
  /** Metres the pattern spans. */
  scale: number;
}

/** The wind at a point and how far zones changed where its pattern goes (0: the global pattern exactly; 1: a zone's own). */
export interface WindPoint extends WindValues {
  /** The largest weight of a zone that changes the pattern's direction, speed or size here (0–1). */
  deviation: number;
}

/** A global wind's values (its direction made unit, the optional values filled in). */
export function windValues(w: WindConfig): WindValues {
  const len = Math.hypot(w.direction[0], w.direction[1]);
  const scale = w.scale ?? WIND_DEFAULTS.scale;
  return {
    dirX: len > 0 ? w.direction[0] / len : 1,
    dirZ: len > 0 ? w.direction[1] / len : 0,
    strength: w.strength,
    gust: w.gust,
    turbulence: w.turbulence,
    speed: w.speed ?? w.gustFrequency * scale,
    scale,
  };
}

/** A zone placed in the world, ready to weigh points. */
export interface PlacedWindZone {
  readonly shape: WindZoneShape;
  /** Centre on the ground. */
  readonly x: number;
  readonly z: number;
  /** The box's local x axis on the ground (unit). */
  readonly ax: number;
  readonly az: number;
  /** A box's half width and depth along its axes (world metres). */
  readonly halfX: number;
  readonly halfZ: number;
  /** A sphere's radius (world metres). */
  readonly radius: number;
  readonly blend: number;
  readonly priority: number;
  /** Ties in priority: the lower key first (the entity id: the same order everywhere). */
  readonly key: string;
  readonly set: Partial<WindValues>;
  /** It changes the direction, the speed or the size of the pattern. */
  readonly moves: boolean;
}

/**
 * A zone at its object's world matrix (column-major, 16 numbers). A box
 * turns with the object about up; a sphere takes the largest scale.
 */
export function placeWindZone(c: WindZoneComponent, key: string, m: ArrayLike<number>): PlacedWindZone {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const g = Math.hypot(m[0]!, m[2]!);
  const set: Partial<WindValues> = {};
  if (c.direction !== undefined) {
    const len = Math.hypot(c.direction[0], c.direction[1]);
    set.dirX = c.direction[0] / len;
    set.dirZ = c.direction[1] / len;
  }
  for (const k of ['strength', 'gust', 'turbulence', 'speed', 'scale'] as const) if (c[k] !== undefined) set[k] = c[k];
  const size = c.size ?? WIND_DEFAULTS.zoneSize;
  return {
    shape: c.shape,
    x: m[12]!,
    z: m[14]!,
    ax: g > 1e-9 ? m[0]! / g : 1,
    az: g > 1e-9 ? m[2]! / g : 0,
    halfX: (size[0] / 2) * sx,
    halfZ: (size[2] / 2) * sz,
    radius: (c.radius ?? WIND_DEFAULTS.zoneRadius) * Math.max(sx, sy, sz),
    blend: c.blend ?? WIND_DEFAULTS.zoneBlend,
    priority: c.priority ?? WIND_DEFAULTS.zonePriority,
    key,
    set,
    moves: c.direction !== undefined || c.speed !== undefined || c.scale !== undefined,
  };
}

/** Zones in the order they are laid on: priority, then key. */
export function orderWindZones<T extends Pick<PlacedWindZone, 'priority' | 'key'>>(zones: readonly T[]): T[] {
  return [...zones].sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** How far inside its edge a point is (metres; negative outside). */
function depthInside(z: PlacedWindZone, x: number, y: number): number {
  const dx = x - z.x;
  const dz = y - z.z;
  if (z.shape === 'sphere') return z.radius - Math.hypot(dx, dz);
  const lx = dx * z.ax + dz * z.az;
  const lz = -dx * z.az + dz * z.ax;
  return Math.min(z.halfX - Math.abs(lx), z.halfZ - Math.abs(lz));
}

/** A zone's weight at a point (0 outside; rising smoothly to 1 over `blend` metres inside its edge). */
export function windZoneWeight(z: PlacedWindZone, x: number, y: number): number {
  const d = depthInside(z, x, y);
  if (d <= 0) return 0;
  if (z.blend <= 0 || d >= z.blend) return 1;
  const t = d / z.blend;
  return t * t * (3 - 2 * t);
}

/** The ground rectangle a zone reaches: [minX, minZ, maxX, maxZ]. */
export function windZoneBounds(z: PlacedWindZone): [number, number, number, number] {
  if (z.shape === 'sphere') return [z.x - z.radius, z.z - z.radius, z.x + z.radius, z.z + z.radius];
  const ex = Math.abs(z.ax) * z.halfX + Math.abs(z.az) * z.halfZ;
  const ez = Math.abs(z.az) * z.halfX + Math.abs(z.ax) * z.halfZ;
  return [z.x - ex, z.z - ez, z.x + ex, z.z + ez];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Lay one zone over the values at a point with weight `w` (the direction is left as blended, not made unit). */
function layZone(v: WindPoint, z: PlacedWindZone, w: number): void {
  const s = z.set;
  if (s.dirX !== undefined) {
    v.dirX = lerp(v.dirX, s.dirX, w);
    v.dirZ = lerp(v.dirZ, s.dirZ!, w);
  }
  if (s.strength !== undefined) v.strength = lerp(v.strength, s.strength, w);
  if (s.gust !== undefined) v.gust = lerp(v.gust, s.gust, w);
  if (s.turbulence !== undefined) v.turbulence = lerp(v.turbulence, s.turbulence, w);
  if (s.speed !== undefined) v.speed = lerp(v.speed, s.speed, w);
  if (s.scale !== undefined) v.scale = lerp(v.scale, s.scale, w);
  if (z.moves && w > v.deviation) v.deviation = w;
}

/** Make the blended direction unit (opposite winds that cancel keep the global one). */
function settleDirection(v: WindPoint, global: WindValues): void {
  const len = Math.hypot(v.dirX, v.dirZ);
  if (len > 1e-4) {
    v.dirX /= len;
    v.dirZ /= len;
  } else {
    v.dirX = global.dirX;
    v.dirZ = global.dirZ;
  }
}

/** The wind at a ground point: the global wind with every zone laid over it in order (`ordered`: {@link orderWindZones}). The reference the map is checked against. */
export function windAt(global: WindValues, ordered: readonly PlacedWindZone[], x: number, y: number): WindPoint {
  const v: WindPoint = { ...global, deviation: 0 };
  for (const z of ordered) {
    const w = windZoneWeight(z, x, y);
    if (w > 0) layZone(v, z, w);
  }
  settleDirection(v, global);
  return v;
}

/** Floats a map texel holds: [dirX, dirZ, strength, gust] then [speed, scale, turbulence, deviation]. */
export const WIND_MAP_CHANNELS = 8;

/**
 * Fill a wind map: `n` × `n` texels of `texel` metres from (`x0`, `z0`), each
 * the wind at its centre ({@link windAt}), into `out` (`n²` × 8 floats, row by
 * row along x, rows along z). Each zone touches only the texels it reaches.
 */
export function fillWindMap(out: Float32Array, global: WindValues, ordered: readonly PlacedWindZone[], x0: number, z0: number, texel: number, n: number): void {
  const v: WindPoint = { ...global, deviation: 0 };
  for (let i = 0; i < n * n; i += 1) write(out, i, global, 0);
  const touched = new Uint8Array(n * n);
  for (const z of ordered) {
    const [ax, az, bx, bz] = windZoneBounds(z);
    const i0 = Math.max(0, Math.floor((ax - x0) / texel - 0.5));
    const i1 = Math.min(n - 1, Math.ceil((bx - x0) / texel - 0.5));
    const j0 = Math.max(0, Math.floor((az - z0) / texel - 0.5));
    const j1 = Math.min(n - 1, Math.ceil((bz - z0) / texel - 0.5));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const w = windZoneWeight(z, x0 + (i + 0.5) * texel, z0 + (j + 0.5) * texel);
        if (w <= 0) continue;
        const k = j * n + i;
        read(out, k, v);
        layZone(v, z, w);
        write(out, k, v, v.deviation);
        touched[k] = 1;
      }
    }
  }
  for (let k = 0; k < n * n; k += 1) {
    if (touched[k] === 0) continue;
    read(out, k, v);
    settleDirection(v, global);
    write(out, k, v, v.deviation);
  }
}

function write(out: Float32Array, k: number, v: WindValues, deviation: number): void {
  const o = k * WIND_MAP_CHANNELS;
  out[o] = v.dirX;
  out[o + 1] = v.dirZ;
  out[o + 2] = v.strength;
  out[o + 3] = v.gust;
  out[o + 4] = v.speed;
  out[o + 5] = v.scale;
  out[o + 6] = v.turbulence;
  out[o + 7] = deviation;
}

function read(src: Float32Array, k: number, v: WindPoint): void {
  const o = k * WIND_MAP_CHANNELS;
  v.dirX = src[o]!;
  v.dirZ = src[o + 1]!;
  v.strength = src[o + 2]!;
  v.gust = src[o + 3]!;
  v.speed = src[o + 4]!;
  v.scale = src[o + 5]!;
  v.turbulence = src[o + 6]!;
  v.deviation = src[o + 7]!;
}
