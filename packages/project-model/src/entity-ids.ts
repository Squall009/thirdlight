/**
 * The entity ids the backend assigns.
 *
 * An assigned id is `<prefix>-N` with N written with at least
 * {@link ENTITY_ID_DIGITS} digits (`box-000001`), unique across the project
 * (every scene's ids are reserved). A project has as many scenes as it
 * needs, so N has no project bound: the smallest free number is at most one
 * more than the ids taken, and the search stops there (`id_exhaustion` stays
 * as a guard for a set that says every id is taken). Four-digit ids (`box-0001`) load and
 * stay as they are: an id is any string of the id syntax, and the width is
 * only how new ones are written.
 */

/** The fewest digits of an assigned id's number (`box-000001`). */
export const ENTITY_ID_DIGITS = 6;

/**
 * The largest number an assigned id takes. Past 999,999 the number simply
 * has more digits.
 */
export const ENTITY_ID_MAX = Number.MAX_SAFE_INTEGER;

/** The id `<prefix>-N` for the number `n` (at least six digits). */
export function entityIdAt(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(ENTITY_ID_DIGITS, '0')}`;
}

/**
 * The smallest free id `<prefix>-N` (N from 1) that `taken` does not hold,
 * or undefined when every N up to `taken.size + 1` (or {@link ENTITY_ID_MAX})
 * is taken, which a real set never is.
 */
export function nextFreeEntityIdOf(taken: { has(id: string): boolean; readonly size?: number }, prefix: string): string | undefined {
  const last = Math.min(ENTITY_ID_MAX, (taken.size ?? ENTITY_ID_MAX) + 1);
  for (let n = 1; n <= last; n += 1) {
    const id = entityIdAt(prefix, n);
    if (!taken.has(id)) return id;
  }
  return undefined;
}
