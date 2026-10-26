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
 *   it (its shadows there changed), and its shadow's sweep away from the sun.
 *
 * Pure (no three.js).
 */
import { DEFAULT_PROBE_SPACING } from '@thirdlight/runtime';

import type { SurfaceRelight } from './surface-relight';
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

/** A light as the cache sees it: where it is, how far it reaches and what it gives. */
export interface CacheLight {
  readonly id: string;
  readonly kind: 'point' | 'spot' | 'directional';
  readonly on: boolean;
  /** World position (point, spot). */
  readonly position: readonly number[];
  /** Unit direction toward the light (directional), or the spot's axis. */
  readonly direction: readonly number[];
  /** Linear colour × intensity. */
  readonly color: readonly number[];
  /** Metres it reaches (0: no range; the falloff decides). */
  readonly range: number;
  /** The spot's cone (cos of the angle, penumbra); 0 for others. */
  readonly cone: number;
  readonly penumbra: number;
}

/** How far a point or spot light reaches: its range, else where it falls under `LIGHT_REACH_FLOOR`. */
export function lightReach(l: CacheLight): number {
  if (l.range > 0) return l.range;
  const i = Math.max(l.color[0] ?? 0, l.color[1] ?? 0, l.color[2] ?? 0);
  return Math.sqrt(Math.max(0, i) / LIGHT_REACH_FLOOR);
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
  if (now.kind === 'directional') return angle(was.direction, now.direction) >= SUN_STEP_RADIANS;
  if (Math.hypot(now.position[0]! - was.position[0]!, now.position[1]! - was.position[1]!, now.position[2]! - was.position[2]!) >= LIGHT_MOVE_METRES) return true;
  return now.kind === 'spot' && angle(was.direction, now.direction) >= SUN_STEP_RADIANS;
}

export class SurfaceChanges {
  /** The lights as last lit (a directional keeps the state its light was last computed for). */
  private lit = new Map<string, CacheLight>();

  constructor(private readonly relight: SurfaceRelight, private readonly probeSpacing = DEFAULT_PROBE_SPACING) {}

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

  private markLight(l: CacheLight): void {
    this.relight.markSphere(l.position, lightReach(l));
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
