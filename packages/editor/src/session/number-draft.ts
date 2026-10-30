/**
 * How a number field reads its draft: one rule for every commit-on-Enter
 * number box (`NumberField`).
 *
 * Pure: no DOM.
 */

export interface NumberDraftRules {
  min?: number;
  max?: number;
  /** A number outside [min, max]: pulled to the nearest end, or refused (the default). */
  outOfRange?: 'clamp' | 'reject';
  /** An empty box means "none" (`null`) instead of a refusal. */
  optional?: boolean;
}

/** The number a draft commits, `null` for an empty optional box, or `undefined` when the draft is refused. */
export function numberDraft(text: string, rules: NumberDraftRules): number | null | undefined {
  const t = text.trim();
  if (t === '') return rules.optional === true ? null : undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  const lo = rules.min ?? -Infinity;
  const hi = rules.max ?? Infinity;
  if (n >= lo && n <= hi) return n;
  return rules.outOfRange === 'clamp' ? Math.min(hi, Math.max(lo, n)) : undefined;
}
