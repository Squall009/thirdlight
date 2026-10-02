/**
 * The one rule for a run counter's name (`ctx.game.add`, a collectible's
 * `counter`, the counters a save's `components` section carries). Every
 * writer and the save loader check the same rule, so a counter a script can
 * make is a counter a save can bring back.
 */

/** A letter or _, then up to 31 letters, digits or _. */
export const COUNTER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** The rule in words (for refusals and Problems lines). */
export const COUNTER_NAME_RULE = 'a counter name is a letter or _, then up to 31 letters, digits or _';

export function isCounterName(name: unknown): name is string {
  return typeof name === 'string' && COUNTER_NAME_RE.test(name);
}
