/**
 * Changes to the scene as marks on the surface cache (`surface-relight.ts`).
 * Every change reaches the page through a few known paths, the editor's
 * commands and scripts alike; each is turned into the boxes whose light it
 * changes:
 *
 * - a light switched, recoloured, dimmed or moved: what it reaches, where it
 *   was and where it is;
 * - the sun (time of day, a preset): everything, but only once it has moved
 *   `SUN_STEP_RADIANS` or its colour changed `LIGHT_CHANGE_SHARE`, so a
 *   running day steps the sun instead of re-lighting every frame;
 * - static geometry changed (a block or terrain edit, live or scripted, an
 *   architecture object, a static object moved): the box itself and as far
 *   round it as bounced light reaches, the reach of every light that touches
 *   it (its shadows there changed), and its shadow's sweep away from the sun;
 * - a door opened or shut (the rooms changed): every light whose rooms
 *   changed, before and after.
 *
 * A light standing in rooms its open portals keep from the outside
 * (`surface-rooms.ts`) marks only the units those rooms touch.
 *
 * Pure (no three.js).
 */
import { DEFAULT_PROBE_SPACING, LIGHT_LAYERS_ALL } from '@thirdlight/project-model';

import type { SurfaceRelight } from './surface-relight';
import type { SurfaceRooms } from './surface-rooms';
import { bounceRayMetres } from './tracer-scene';

/** How far (radians) the sun turns before its light is computed again. */
export const SUN_STEP_RADIANS = (0.5 * Math.PI) / 180;
/** The share a light's colour × intensity changes by (any channel) before its reach is marked. */
export const LIGHT_CHANGE_SHARE = 0.02;
/** How far (m) a light moves before its reach is marked. */
export const LIGHT_MOVE_METRES = 0.01;
/** Irradiance (W/m², as the light's intensity counts it) below which a light no longer reaches: how far a light with no range is taken to light. */
export const LIGHT_REACH_FLOOR = 0.01;
/** The sun's elevation (sine) a shadow's sweep is taken at, at least: a sun on the horizon would sweep across the world. */
const SWEEP_MIN_SINE = 0.1;

/**
 * An area light's shape in world space: centred on the light's `position`,
 * `u` and `v` its half sides (a line has `v` zero), facing `direction`.
 */
export interface CacheLightArea {
  readonly u: readonly number[];
  readonly v: readonly number[];
  /** Emits on both sides (a one-sided light emits toward `direction` only). */
  readonly twoSided: boolean;
}

/** A light as the cache sees it: where it is, how far it reaches and what it gives. */
export interface CacheLight {
  readonly id: string;
  readonly kind: 'point' | 'spot' | 'directional' | 'area';
  readonly on: boolean;
  /** World position (point, spot). */
  readonly position: readonly number[];
  /** Unit direction toward the light (directional), the spot's axis, or the way an area light faces. */
  readonly direction: readonly number[];
  /** Linear colour × intensity (an area light: its whole intensity along its facing). */
  readonly color: readonly number[];
  /** Metres it reaches (0: no range; the falloff decides). */
  readonly range: number;
  /** The spot's cone (cos of the angle, penumbra); 0 for others. */
  readonly cone: number;
  readonly penumbra: number;
  /** An area light's shape (absent: not an area light). */
  readonly area?: CacheLightArea;
  /** Rays a texel casts toward it at cache level 0 (absent: its kind's count). */
  readonly rays?: number;
  /** Whether it casts shadows (absent: it does): a light without traces no shadow rays. */
  readonly shadows?: boolean;
  /** The light layers it lights and whose objects cast its shadow (bit masks; absent: every layer). */
  readonly lightMask?: number;
  readonly casterMask?: number;
  /** How the light's light is kept (absent: `realtime`): see `savedLights`. */
  readonly mode?: 'realtime' | 'baked' | 'mixed';
}

/**
 * The lights whose light goes into the saved result (the bake that WebGL 2
 * and the low tier draw, and that live tiers start from), per part: a
 * `baked` light's direct light and bounce, a `mixed` light's bounce only
 * (its direct light is drawn per pixel, with its shadows), a `realtime`
 * light nothing (it is lit live only). Live, every light lights the cache.
 */
export function savedLights(lights: readonly CacheLight[], part: 'direct' | 'bounce'): CacheLight[] {
  return lights.filter((l) => l.mode === 'baked' || (part === 'bounce' && l.mode === 'mixed'));
}


/** The sphere (m) a point or spot light's shadow rays aim over: three's lights have no size, a little softness reads as real. */
export const POINT_LIGHT_RADIUS = 0.05;

/** The sphere round a light's position its light leaves from (an area light's half diagonal; a point or spot light's shadow-ray sphere). */
export function lightRadius(l: CacheLight): number {
  if (l.area === undefined) return POINT_LIGHT_RADIUS;
  return Math.hypot(...[0, 1, 2].map((k) => Math.abs(l.area!.u[k] ?? 0) + Math.abs(l.area!.v[k] ?? 0)));
}

/** How far a point, spot or area light reaches: its range, else where it falls under `LIGHT_REACH_FLOOR` (an area light: from its edge). */
export function lightReach(l: CacheLight): number {
  const edge = l.area === undefined ? 0 : Math.hypot(...[0, 1, 2].map((k) => Math.abs(l.area!.u[k] ?? 0) + Math.abs(l.area!.v[k] ?? 0)));
  return lightReachOf(l.range, l.color) + edge;
}

/** How far a light of `range` (0: none) and linear colour × intensity `color` reaches from its centre or emitting surface. */
export function lightReachOf(range: number, color: ArrayLike<number>): number {
  if (range > 0) return range;
  const i = Math.max(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0);
  return Math.sqrt(Math.max(0, i) / LIGHT_REACH_FLOOR);
}

function vecMoved(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  for (let k = 0; k < 3; k += 1) if (Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)) >= LIGHT_MOVE_METRES) return true;
  return false;
}

function colourChanged(a: readonly number[], b: readonly number[]): boolean {
  for (let k = 0; k < 3; k += 1) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (Math.abs(x - y) > LIGHT_CHANGE_SHARE * Math.max(Math.abs(x), Math.abs(y), 1e-6)) return true;
  }
  return false;
}

function angle(a: readonly number[], b: readonly number[]): number {
  const d = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

/** Whether a light's light changed: switched, recoloured or dimmed, moved or turned (spots), its reach or cone changed. */
function lightChanged(was: CacheLight, now: CacheLight): boolean {
  if (was.on !== now.on || was.kind !== now.kind) return true;
  if (!now.on) return false;
  if (colourChanged(was.color, now.color)) return true;
  if (was.range !== now.range || was.cone !== now.cone || was.penumbra !== now.penumbra) return true;
  if ((was.shadows ?? true) !== (now.shadows ?? true) || (was.lightMask ?? LIGHT_LAYERS_ALL) !== (now.lightMask ?? LIGHT_LAYERS_ALL) || (was.casterMask ?? LIGHT_LAYERS_ALL) !== (now.casterMask ?? LIGHT_LAYERS_ALL)) return true;
  if ((was.area === undefined) !== (now.area === undefined) || was.area?.twoSided !== now.area?.twoSided) return true;
  if (vecMoved(was.area?.u, now.area?.u) || vecMoved(was.area?.v, now.area?.v)) return true;
  if (now.kind === 'directional') return angle(was.direction, now.direction) >= SUN_STEP_RADIANS;
  if (Math.hypot(now.position[0]! - was.position[0]!, now.position[1]! - was.position[1]!, now.position[2]! - was.position[2]!) >= LIGHT_MOVE_METRES) return true;
  return (now.kind === 'spot' || now.kind === 'area') && angle(was.direction, now.direction) >= SUN_STEP_RADIANS;
}

export class SurfaceChanges {
  /** The lights as last lit (a directional keeps the state its light was last computed for). */
  private lit = new Map<string, CacheLight>();
  private rooms: SurfaceRooms | null = null;

  constructor(private readonly relight: SurfaceRelight, private readonly probeSpacing = DEFAULT_PROBE_SPACING) {}

  /** The rooms now (null: none): the lights whose rooms changed are marked under the old rooms and the new. */
  setRooms(rooms: SurfaceRooms | null): void {
    const was = this.rooms;
    if (was === rooms) return;
    for (const l of this.lit.values()) {
      if (!l.on || l.kind === 'directional') continue;
      const before = JSON.stringify(was?.lightMarks(l.position, lightRadius(l)) ?? null);
      const after = JSON.stringify(rooms?.lightMarks(l.position, lightRadius(l)) ?? null);
      if (before === after) continue;
      this.markLight(l);
      this.rooms = rooms;
      this.markLight(l);
      this.rooms = was;
    }
    this.rooms = rooms;
  }

  /** The lights now (every frame; cheap when nothing changed). */
  setLights(lights: readonly CacheLight[]): void {
    const seen = new Set<string>();
    let all = false;
    for (const l of lights) {
      seen.add(l.id);
      const was = this.lit.get(l.id);
      if (was === undefined) {
        if (!l.on) {
          this.lit.set(l.id, l);
          continue;
        }
        if (l.kind === 'directional') all = true;
        else this.markLight(l);
        this.lit.set(l.id, l);
        continue;
      }
      if (!lightChanged(was, l)) continue;
      if (l.kind === 'directional' || was.kind === 'directional') all = true;
      else {
        if (was.on) this.markLight(was);
        if (l.on) this.markLight(l);
      }
      this.lit.set(l.id, l);
    }
    for (const [id, was] of [...this.lit]) {
      if (seen.has(id)) continue;
      this.lit.delete(id);
      if (!was.on) continue;
      if (was.kind === 'directional') all = true;
      else this.markLight(was);
    }
    if (all) this.relight.markAll();
  }

  /**
   * Units a bake's saved light was just put in (`only`), stale where their
   * saved light is not what the lights give now: the lights whose direct
   * light a bake does not save (`mixed`, `realtime`), and `baked` lights
   * added, changed or gone since the bake (`bake`: its lights as they were;
   * null: not known, every baked light counts as changed).
   */
  markSinceBake(bake: readonly CacheLight[] | null, only: ReadonlySet<string>): void {
    if (only.size === 0) return;
    const was = new Map((bake ?? []).filter((l) => l.mode === 'baked' && l.on).map((l) => [l.id, l]));
    const marks: CacheLight[] = [];
    for (const l of this.lit.values()) {
      if (!l.on) continue;
      const b = was.get(l.id);
      if (l.mode !== 'baked' || bake === null || b === undefined || lightChanged(b, l)) marks.push(l);
      if (b !== undefined && (l.mode !== 'baked' || lightChanged(b, l))) marks.push(b);
      was.delete(l.id);
    }
    // Saved but no longer lit as baked: where they lit.
    for (const b of was.values()) if (!this.lit.get(b.id)?.on || this.lit.get(b.id)?.mode !== 'baked') marks.push(b);
    for (const l of marks) {
      if (l.kind === 'directional') {
        this.relight.markUnits(only);
        return;
      }
      const rooms = this.rooms;
      const held = rooms?.lightMarks(l.position, lightRadius(l)) ?? null;
      this.relight.markSphere(l.position, lightReach(l), (u) => only.has(u.key) && (held === null || rooms!.marks(u.min, u.max, held)), true);
    }
  }

  /**
   * Where probes holding a bake's saved light are not lit as now (null: all
   * of them): the lights a bake's bounce leaves out (`realtime`), and
   * `baked` or `mixed` lights added, changed or gone since the bake.
   */
  probeMarksSinceBake(bake: readonly CacheLight[] | null): ({ min: number[]; max: number[] } | null)[] {
    const was = new Map((bake ?? []).filter((l) => l.on && (l.mode === 'baked' || l.mode === 'mixed')).map((l) => [l.id, l]));
    const marks: CacheLight[] = [];
    for (const l of this.lit.values()) {
      const b = was.get(l.id);
      was.delete(l.id);
      const saved = l.mode === 'baked' || l.mode === 'mixed';
      if (b !== undefined && (!l.on || !saved || lightChanged(b, l))) marks.push(b);
      if (l.on && (!saved || bake === null || b === undefined || lightChanged(b, l))) marks.push(l);
    }
    marks.push(...was.values());
    return marks.map((l) => {
      if (l.kind === 'directional') return null;
      const r = lightReach(l);
      return { min: l.position.map((v) => v - r), max: l.position.map((v) => v + r) };
    });
  }

  private markLight(l: CacheLight): void {
    const rooms = this.rooms;
    const marks = rooms?.lightMarks(l.position, lightRadius(l)) ?? null;
    this.relight.markSphere(l.position, lightReach(l), marks === null ? undefined : (u) => rooms!.marks(u.min, u.max, marks));
  }

  /**
   * Static geometry in this box changed: the box and bounced light's reach
   * round it, every light touching it (all it reaches), and its shadow's
   * sweep away from each sun down to `floorY`.
   */
  geometryChanged(min: readonly number[], max: readonly number[], floorY?: number): void {
    const r = bounceRayMetres(this.probeSpacing);
    this.relight.markBox(min.map((v) => v - r), max.map((v) => v + r));
    for (const l of this.lit.values()) {
      if (!l.on) continue;
      if (l.kind === 'directional') {
        const floor = Math.min(floorY ?? this.relight.bounds()?.min[1] ?? min[1]!, min[1]!);
        const sine = Math.max(SWEEP_MIN_SINE, l.direction[1] ?? 0);
        const len = (max[1]! - floor) / sine;
        const lo = [0, 1, 2].map((k) => Math.min(min[k]!, min[k]! - l.direction[k]! * len));
        const hi = [0, 1, 2].map((k) => Math.max(max[k]!, max[k]! - l.direction[k]! * len));
        this.relight.markBox(lo, hi);
        continue;
      }
      // A light whose reach touches the box: all it reaches (its shadows there changed).
      const r = lightReach(l);
      let d2 = 0;
      for (let k = 0; k < 3; k += 1) d2 += Math.max(min[k]! - l.position[k]!, 0, l.position[k]! - max[k]!) ** 2;
      if (d2 <= r * r) this.markLight(l);
    }
  }
}

/** Where surfaces' colours changed: a box round every change, or anywhere (`true`). */
export type ColourChanges = { readonly min: readonly number[]; readonly max: readonly number[] } | true;

/**
 * Where surfaces' colours changed since the probes last bounced them. The
 * probes there were marked at once (the change's light), but they read the
 * colours the materials wrote, which stay the old ones (a surface made again
 * has new places in the cache, holding what was drawn there before) until a
 * frame writes them again; once one has (`take`, then `mark` the frame
 * after), they are marked again. The scene coming in is such a change: its
 * first probes bounced a stand-in colour.
 */
export class SurfaceColourChanges {
  /** One box round every change (`true`: anywhere; null: nowhere). */
  private changes: ColourChanges | null = true;

  /** `ready`: every changed surface is made and listed (its place in the cache is where a frame's colours go). */
  constructor(private readonly probes: { markBox(min: readonly number[] | null, max: readonly number[] | null): void }, private readonly ready: () => boolean, private readonly probeSpacing = DEFAULT_PROBE_SPACING) {}

  /** Static geometry in this box changed: its colours, as far as the probes round it bounce light from it. */
  changed(min: readonly number[], max: readonly number[]): void {
    const had = this.changes;
    if (had === true) return;
    const r = bounceRayMetres(this.probeSpacing);
    const lo = min.map((v) => v - r);
    const hi = max.map((v) => v + r);
    this.changes = had === null ? { min: lo, max: hi } : { min: lo.map((v, k) => Math.min(v, had.min[k]!)), max: hi.map((v, k) => Math.max(v, had.max[k]!)) };
  }

  /** Colours changed anywhere (a material edited in place). */
  all(): void {
    this.changes = true;
  }

  /** Colours changed and the changed surfaces are made: a frame may write them now. */
  get waiting(): boolean {
    return this.changes !== null && this.ready();
  }

  /** The changes so far, taken (the caller has a frame write the colours, then marks them). */
  take(): ColourChanges | null {
    const c = this.changes;
    this.changes = null;
    return c;
  }

  /** The probes where colours changed bounce them again. */
  mark(changes: ColourChanges): void {
    if (changes === true) this.probes.markBox(null, null);
    else this.probes.markBox(changes.min, changes.max);
  }
}
