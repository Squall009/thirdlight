/**
 * Phase 14.3: score rules (`content.flow.score`) in the game host. A level's
 * score is the points per unit of each scored run counter plus a time bonus
 * (points per second under a target time, rounded down) given when the level
 * is complete. The score is host-side only: it never changes the simulation,
 * so replays and determinism are untouched.
 */

/** The score rules as the host reads them (validated by the model). */
export interface ScoreRulesLike {
  readonly points?: Readonly<Record<string, number>>;
  readonly timeBonus?: { readonly targetSeconds: number; readonly perSecond: number };
}

/** The points the run counters are worth (counters without a rule score nothing). */
export function counterPoints(rules: ScoreRulesLike, counters: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [name, per] of Object.entries(rules.points ?? {})) {
    const n = Object.prototype.hasOwnProperty.call(counters, name) ? counters[name]! : 0;
    if (Number.isFinite(n)) total += n * per;
  }
  return Math.round(total);
}

/** The time bonus for a level completed in `seconds` (0 without a rule or over the target). */
export function timeBonus(rules: ScoreRulesLike, seconds: number): number {
  const b = rules.timeBonus;
  if (b === undefined || !Number.isFinite(seconds)) return 0;
  return Math.floor(Math.max(0, b.targetSeconds - seconds) * b.perSecond);
}

/** A completed level's score: its counters' points plus the time bonus. */
export function levelScore(rules: ScoreRulesLike, counters: Readonly<Record<string, number>>, seconds: number): { points: number; bonus: number; score: number } {
  const points = counterPoints(rules, counters);
  const bonus = timeBonus(rules, seconds);
  return { points, bonus, score: points + bonus };
}
