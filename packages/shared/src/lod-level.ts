/**
 * Which level of detail an object draws at, by the share of the screen it
 * covers, with hysteresis: one arithmetic for the CPU (placed models' LODs,
 * diagnostics, tests) and for shaders (a compute pass picking each stored
 * copy's level), written over {@link ScalarOps} so the two cannot drift.
 *
 * Units: an object's distance in level units (metres over the view's zoom and
 * the project's LOD bias) against each level's switch distance at scale 1 —
 * where the model's radius covers that level's screen size at the reference
 * field of view. A copy of scale `s` covers the same share at `s` times the
 * distance, so it reaches switch `k` at `switches[k] × s`: a screen size is
 * a distance over a size.
 *
 * Level `k` is drawn once switch `k` and every one before it are passed. A
 * level shown now switches back to the finer one only `hysteresis` (a share
 * of its switch distance) nearer than it switched, so an object standing at a
 * switch does not flicker between two levels.
 */
import { CPU_SCALAR_OPS, type ScalarOps } from './scalar-ops';

/** The level count so far and whether every switch so far was passed (1) or not (0), as numbers so a shader adds them. */
export interface LodLevelAcc<F> {
  readonly level: F;
  readonly open: F;
}

/** The margin switch `k` takes: the hysteresis while level `k` is the one shown (`current`), else none. */
export function lodSwitchMargin<F, B>(o: ScalarOps<F, B>, current: F, k: F, hysteresis: F): F {
  const apart = o.max(o.sub(current, k), o.sub(k, current));
  return o.select(o.lt(apart, o.n(0.5)), hysteresis, o.n(0));
}

/**
 * One switch: passed when `distance` is at least `switchAt` (the switch distance times the object's scale) less
 * its `margin` share. Start with `{ level: 0, open: 1 }` and step switches 1, 2, … in order.
 */
export function lodLevelStep<F, B>(o: ScalarOps<F, B>, acc: LodLevelAcc<F>, distance: F, switchAt: F, margin: F): LodLevelAcc<F> {
  const at = o.mul(switchAt, o.sub(o.n(1), margin));
  const passed = o.select(o.lt(distance, at), o.n(0), o.n(1));
  const open = o.mul(acc.open, passed);
  return { level: o.add(acc.level, open), open };
}

/**
 * The level an object `distance` level units away at scale `scale` draws at, among levels switching at
 * `switches` (level 0's entry, at 0, is not read); `current`: the level it draws now (-1: none yet, no
 * hysteresis), `hysteresis`: the project's share.
 */
export function lodLevelOf(switches: ArrayLike<number>, distance: number, scale: number, current = -1, hysteresis = 0): number {
  let acc: LodLevelAcc<number> = { level: 0, open: 1 };
  const o = CPU_SCALAR_OPS;
  for (let k = 1; k < switches.length && acc.open > 0; k += 1) acc = lodLevelStep(o, acc, distance, switches[k]! * scale, lodSwitchMargin(o, current, k, hysteresis));
  return acc.level;
}
