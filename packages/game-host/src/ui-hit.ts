/**
 * The pointer's UI hit test as plain data — where a pointer
 * press goes to the UI instead of the game, so the simulation worker can test
 * a relayed pointer against the page's list (no DOM here).
 */

/**
 * One place a pointer press goes to the UI instead of the game (a button, a
 * text input, a modal document's backdrop, the engine pause panel's
 * buttons); lists are topmost first.
 */
export interface UiHitTarget {
  /** What a click activates (stable while the element is shown). */
  readonly key: string;
  /** [x, y, w, h] in fractions of the view (0,0 top left). */
  readonly rect: readonly [number, number, number, number];
}

/** The topmost target under (x, y) (fractions of the view), or null. */
export function hitUiTargets(targets: readonly UiHitTarget[], x: number, y: number): UiHitTarget | null {
  for (const t of targets) {
    const [rx, ry, rw, rh] = t.rect;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return t;
  }
  return null;
}
