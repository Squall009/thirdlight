/**
 * Phase 25.7a: the entity ids the backend assigns.
 *
 * An assigned id is `<prefix>-N` with N written with at least
 * {@link ENTITY_ID_DIGITS} digits (`box-000001`), unique across the project
 * (every scene's ids are reserved). N runs up to {@link ENTITY_ID_MAX}, the
 * most entities a project can hold (64 scenes × 16,384 entities), so ids of
 * one prefix cannot run out before the entity limits refuse a creation
 * (`id_exhaustion` stays as a guard). Ids assigned before phase 25.7 have
 * four digits (`box-0001`, at most 9,999 per prefix); they still load and
 * stay as they are: an id is any string of the id syntax, and the width is
 * only how new ones are written.
 */

/** The fewest digits of an assigned id's number (`box-000001`). */
export const ENTITY_ID_DIGITS = 6;

/**
 * The largest number an assigned id takes: the project's entity capacity,
 * `MAX_SCENES` (64) × `MAX_ENTITIES_V4` (16,384) = 1,048,576 (a unit test
 * checks the product). Past 999,999 the number simply has seven digits.
 */
export const ENTITY_ID_MAX = 1_048_576;

/** The id `<prefix>-N` for the number `n` (at least six digits). */
export function entityIdAt(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(ENTITY_ID_DIGITS, '0')}`;
}

/**
 * The smallest free id `<prefix>-N` (N from 1) that `taken` does not hold,
 * or undefined when every N up to {@link ENTITY_ID_MAX} is taken.
 */
export function nextFreeEntityIdOf(taken: { has(id: string): boolean }, prefix: string): string | undefined {
  for (let n = 1; n <= ENTITY_ID_MAX; n += 1) {
    const id = entityIdAt(prefix, n);
    if (!taken.has(id)) return id;
  }
  return undefined;
}
