/**
 * A moving sun for the lighting benches, driven the way a game script drives a day: the look held as a mix of two
 * environment presets with `ctx.environment.blend(a, b, t)`, t moved every step from the simulation's steps. The
 * presets are bench data the light-shots bench writes into the project beside its noon and night looks: the same clear
 * sky and ambient as noon, the key light's direction stepped along a day's arc. Nothing in the engine knows of it.
 *
 * The arc: an equinox day at 40° latitude, from {@link DAY_ARC_DEG} hours' angle before noon to as far after it (the
 * sun 11° over the horizon at both ends, 50° at noon), one preset every {@link DAY_STEP_DEG}°. The direction between
 * two presets is their normalised blend (the environment's own rule), so a segment of 15° moves at a near even rate.
 * Past either end the sun turns back (a day that keeps moving, never a jump).
 *
 * Engine-owned test data for measuring, not a product feature.
 */

/** Hours' angle (degrees) of the arc's ends either side of noon, and the presets' spacing. */
export const DAY_ARC_DEG = 75;
export const DAY_STEP_DEG = 15;
/** Latitude (degrees) of the arc: noon's sun 50° up. */
const LATITUDE_DEG = 40;
/** Where a run's sun starts (hours' angle, degrees: mid-morning). */
export const DAY_START_DEG = -45;
/** The simulation's steps a second (the fixed step the benches' behaviours count). */
const STEPS_A_SECOND = 120;

/** The two day lengths measured: a game's (a 20-minute day: 0.3° a second) and a fast one (a 2-minute day: 3° a second). */
export const DAY_SPEEDS = Object.freeze({ slow: 360 / 1200, fast: 360 / 120 });
export type DaySpeed = keyof typeof DAY_SPEEDS;
/** The debug commands: a day started at {@link DAY_START_DEG} at each speed, and stopped where it is (the look held). */
export const DAY_COMMANDS = Object.freeze({ slow: 'day_slow', fast: 'day_fast', stop: 'day_stop' });

/** The light's direction (from the sun toward the ground, unit) at hours' angle `deg`. */
export function sunDirection(deg: number): [number, number, number] {
  const h = (deg * Math.PI) / 180;
  const p = (LATITUDE_DEG * Math.PI) / 180;
  // The sun's place: east (−x) in the morning, south-ish (−z) at noon, west (+x) in the evening.
  const s = [Math.sin(h), Math.cos(h) * Math.cos(p), -Math.cos(h) * Math.sin(p)];
  const n = Math.hypot(s[0]!, s[1]!, s[2]!);
  return [-s[0]! / n, -s[1]! / n, -s[2]! / n].map((v) => Number(v.toFixed(5))) as [number, number, number];
}

/** The sun's height over the horizon (degrees) at hours' angle `deg`. */
export function sunElevation(deg: number): number {
  return (-Math.asin(sunDirection(deg)[1]) * 180) / Math.PI;
}

/** The presets' ids, in order along the arc. */
export const DAY_PRESET_IDS: readonly string[] = Object.freeze(Array.from({ length: (2 * DAY_ARC_DEG) / DAY_STEP_DEG + 1 }, (_, k) => `bench-day-${k}`));

/** The day's presets: noon's look with the key light at each step of the arc. */
export function dayPresets(sky: Readonly<Record<string, unknown>>): Array<Record<string, unknown>> {
  return DAY_PRESET_IDS.map((presetId, k) => ({
    presetId,
    name: `Bench day ${k}`,
    sky,
    lights: [
      { type: 'directional', color: '#ffffff', intensity: 1.2, direction: sunDirection(-DAY_ARC_DEG + k * DAY_STEP_DEG) },
      { type: 'ambient', color: '#8090a8', intensity: 0.6 },
      { type: 'point', intensity: 0 },
    ],
  }));
}

/**
 * The hours' angle a day started at {@link DAY_START_DEG} has reached after `seconds` at `degPerS`, turning back at
 * the arc's ends; and the blend that shows it (the two presets and t between them).
 */
export function dayAt(seconds: number, degPerS: number): { deg: number; a: string; b: string; t: number } {
  const span = 2 * DAY_ARC_DEG;
  const run = (DAY_START_DEG + DAY_ARC_DEG + seconds * degPerS) % (2 * span);
  const u = run <= span ? run : 2 * span - run;
  const deg = -DAY_ARC_DEG + u;
  const k = Math.min(DAY_PRESET_IDS.length - 2, Math.floor(u / DAY_STEP_DEG));
  return { deg, a: DAY_PRESET_IDS[k]!, b: DAY_PRESET_IDS[k + 1]!, t: Math.min(1, (u - k * DAY_STEP_DEG) / DAY_STEP_DEG) };
}

/**
 * The day as behaviour code for the lighting camera (light-shots-cli.ts): declarations for the module's top and a
 * piece of its `intent` phase. A day command starts the sun at {@link DAY_START_DEG}; every step after sets the blend
 * from the steps since (the same arithmetic as {@link dayAt}); the stop command holds the look where it is. How far
 * along the arc the sun is (tenths of a degree from its morning end: the hours' angle + {@link DAY_ARC_DEG}) is kept as
 * the counter `day_u10`, so a bench can read where the sun is.
 */
export function dayBehaviour(): { head: string; intent: string } {
  return {
    head: `const DAY = ${JSON.stringify({ arc: DAY_ARC_DEG, step: DAY_STEP_DEG, start: DAY_START_DEG, ids: DAY_PRESET_IDS, speeds: DAY_SPEEDS, commands: DAY_COMMANDS, steps: STEPS_A_SECOND })};`,
    intent: `
      for (const [speed, command] of [['slow', DAY.commands.slow], ['fast', DAY.commands.fast]]) for (const _ of ctx.debug.command(command)) { s.day = { from: ctx.stepIndex, degPerS: DAY.speeds[speed] }; ctx.game.add('day_started', 1); }
      for (const _ of ctx.debug.command(DAY.commands.stop)) { s.day = null; ctx.game.add('day_stopped', 1); }
      if (s.day) {
        const span = 2 * DAY.arc;
        const run = (DAY.start + DAY.arc + ((ctx.stepIndex - s.day.from) / DAY.steps) * s.day.degPerS) % (2 * span);
        const u = run <= span ? run : 2 * span - run;
        const k = Math.min(DAY.ids.length - 2, Math.floor(u / DAY.step));
        ctx.environment?.blend(DAY.ids[k], DAY.ids[k + 1], Math.min(1, (u - k * DAY.step) / DAY.step));
        put('day_u10', Math.round(u * 10));
      }`,
  };
}
