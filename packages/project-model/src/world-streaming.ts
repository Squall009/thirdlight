/**
 * World streaming: which terrain tiles and block-layer chunks are loaded,
 * by distance from what the game is looking at (Unreal's World Partition
 * loading range, Unity's and Godot's hand-made tile rings).
 *
 * A terrain or a block layer streams when it carries `streaming`: rings of
 * metres around the camera (the page) and the simulation's sources (the
 * camera's place, its target and every character), measured across the
 * ground (x and z) to each tile's or chunk's square:
 * - `render`: drawn at full detail (a terrain's tiles past it are drawn from
 *   its overview, every tile at its coarsest level, which a build ships);
 * - `collision`: colliders built (absent: the render ring);
 * - `scatter`: stored scatter drawn (absent: the render ring);
 * - `live` (block layers): live blocks' objects in the game (absent: the
 *   collision ring).
 * A cell inside a ring is loaded; one loaded stays until it is `hysteresis`
 * metres past it (absent: a tenth of the ring), so a camera at a ring's edge
 * does not load and drop the same cells over and over.
 *
 * Absent, everything is loaded (as before streaming). What is resident is
 * bounded by memory, not by a count: the project's `streaming_budget_mb`
 * (cells kept past their ring are let go first when it is full; rings that
 * alone hold more are reported, never cut).
 *
 * Pure.
 */
import type { ModelErrorV2 } from './errors';

export interface StreamingRings {
  /** Metres within which tiles or chunks are drawn at full detail. */
  render: number;
  /** Metres within which they have colliders (absent: the render ring). */
  collision?: number;
  /** Metres within which their stored scatter is drawn (absent: the render ring). */
  scatter?: number;
  /** Metres within which a block layer's live blocks have their objects (absent: the collision ring). */
  live?: number;
  /** Metres a loaded tile or chunk may be past a ring before it goes (absent: a tenth of the ring). */
  hysteresis?: number;
}

/** A ring's radius and a hysteresis (metres). */
export const STREAMING_RADIUS_LIMITS = Object.freeze({ min: 1, max: 100_000 });
export const STREAMING_HYSTERESIS_LIMITS = Object.freeze({ min: 0, max: 10_000 });
/** A ring's hysteresis when none is set: this share of its radius. */
export const STREAMING_HYSTERESIS_SHARE = 0.1;

/** The fields of `streaming`, in canonical order. */
export const STREAMING_FIELDS = ['render', 'collision', 'scatter', 'live', 'hysteresis'] as const;

/**
 * The memory streamed world cells may take on the page (MiB): decoded
 * terrain tiles and their texture layers, block chunks' meshes. The default
 * holds the render rings of an 8 km landscape of 512 m tiles and a 1 km
 * block area many times over beside the texture budget on a laptop sharing
 * 8–16 GiB with its integrated GPU; a ring that holds more is reported.
 */
export const STREAMING_BUDGET_DEFAULT_MB = 768;
export const STREAMING_BUDGET_MIN_MB = 1;
export const STREAMING_BUDGET_MAX_MB = 65_536;

/** The project's streaming budget in bytes (the default when absent or not a number). */
export function streamingBudgetBytesOf(settings: Readonly<Record<string, unknown>> | undefined): number {
  const v = settings?.['streaming_budget_mb'];
  const mb = typeof v === 'number' && Number.isFinite(v) ? Math.min(STREAMING_BUDGET_MAX_MB, Math.max(STREAMING_BUDGET_MIN_MB, v)) : STREAMING_BUDGET_DEFAULT_MB;
  return Math.round(mb * 1024 * 1024);
}

/** One ring: its radius and how far past it a loaded cell may be (metres). */
export interface StreamRing {
  readonly radius: number;
  readonly hysteresis: number;
}

/** Every ring of a streamed terrain or layer, resolved. */
export interface ResolvedStreamingRings {
  readonly render: StreamRing;
  readonly collision: StreamRing;
  readonly scatter: StreamRing;
  readonly live: StreamRing;
}

const ringOf = (radius: number, hysteresis: number | undefined): StreamRing => ({ radius, hysteresis: hysteresis ?? radius * STREAMING_HYSTERESIS_SHARE });

/** A component's rings with their defaults filled in (null: it does not stream). */
export function resolveStreamingRings(s: StreamingRings | undefined): ResolvedStreamingRings | null {
  if (s === undefined) return null;
  const collision = s.collision ?? s.render;
  return Object.freeze({
    render: ringOf(s.render, s.hysteresis),
    collision: ringOf(collision, s.hysteresis),
    scatter: ringOf(s.scatter ?? s.render, s.hysteresis),
    live: ringOf(s.live ?? collision, s.hysteresis),
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check a component's `streaming` (`live`: a block layer's may name a live ring). */
export function validateStreamingRings(v: unknown, path: string, errors: ModelErrorV2[], live: boolean): void {
  if (v === undefined) return;
  if (!isObj(v)) {
    errors.push({ code: 'field_type', path, message: `streaming is {render, collision?, scatter?, ${live ? 'live?, ' : ''}hysteresis?} metres`, found: v } as ModelErrorV2);
    return;
  }
  for (const k of Object.keys(v)) {
    if (!(STREAMING_FIELDS as readonly string[]).includes(k) || (k === 'live' && !live)) errors.push({ code: 'field_unexpected', path: `${path}/${k}`, message: `unknown streaming field "${k}"`, found: k } as ModelErrorV2);
  }
  if (v['render'] === undefined) errors.push({ code: 'field_missing', path: `${path}/render`, message: 'streaming needs its render ring (metres)' } as ModelErrorV2);
  for (const k of ['render', 'collision', 'scatter', 'live'] as const) {
    const r = v[k];
    if (r !== undefined && !(finite(r) && r >= STREAMING_RADIUS_LIMITS.min && r <= STREAMING_RADIUS_LIMITS.max)) errors.push({ code: 'field_value', path: `${path}/${k}`, message: `a ring is ${STREAMING_RADIUS_LIMITS.min}-${STREAMING_RADIUS_LIMITS.max} metres`, found: r } as ModelErrorV2);
  }
  const h = v['hysteresis'];
  if (h !== undefined && !(finite(h) && h >= STREAMING_HYSTERESIS_LIMITS.min && h <= STREAMING_HYSTERESIS_LIMITS.max)) errors.push({ code: 'field_value', path: `${path}/hysteresis`, message: `hysteresis is ${STREAMING_HYSTERESIS_LIMITS.min}-${STREAMING_HYSTERESIS_LIMITS.max} metres`, found: h } as ModelErrorV2);
}

/** `streaming` in canonical form (fields in order; undefined stays undefined). */
export function canonicalStreamingRings(s: StreamingRings | undefined): StreamingRings | undefined {
  if (s === undefined) return undefined;
  const out: StreamingRings = { render: s.render };
  for (const k of ['collision', 'scatter', 'live', 'hysteresis'] as const) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

/** Metres across the ground from (px, pz) to the square [x0, x1] × [z0, z1] (0 inside). */
export function squareDistance(x0: number, z0: number, x1: number, z1: number, px: number, pz: number): number {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dz = Math.max(z0 - pz, 0, pz - z1);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Whether a cell `distance` metres away is in `ring` (a loaded one stays until it is past the hysteresis too). */
export function inStreamRing(distance: number, ring: StreamRing, loaded: boolean): boolean {
  return distance <= ring.radius || (loaded && distance <= ring.radius + ring.hysteresis);
}

/** The nearest of `points` ([x, y, z]; only x and z count) to a square, metres (Infinity: no points). */
export function nearestSquareDistance(x0: number, z0: number, x1: number, z1: number, points: readonly (readonly number[])[]): number {
  let d = Infinity;
  for (const p of points) d = Math.min(d, squareDistance(x0, z0, x1, z1, p[0]!, p[2]!));
  return d;
}
