/**
 * Phase 23.9a: keyboard/gamepad focus navigation between the focusable
 * widgets of a UI document — explicit `nav` targets first, else spatial: the
 * nearest candidate whose centre lies in the pressed direction, scored by
 * the distance along the direction plus twice the sideways offset (so a
 * candidate straight ahead beats a nearer one far to the side). `next` /
 * `prev` step through document order (wrapping). Pure.
 */

export interface NavRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** The index of the candidate to move to from `current` (−1: stay). */
export function spatialPick(current: NavRect, candidates: readonly (NavRect | null)[], dir: NavDirection, skip: number): number {
  const cx = current.left + current.width / 2;
  const cy = current.top + current.height / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    const r = candidates[i];
    if (i === skip || r === null || r === undefined) continue;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let along: number;
    let side: number;
    switch (dir) {
      case 'up':
        along = -dy;
        side = Math.abs(dx);
        break;
      case 'down':
        along = dy;
        side = Math.abs(dx);
        break;
      case 'left':
        along = -dx;
        side = Math.abs(dy);
        break;
      case 'right':
        along = dx;
        side = Math.abs(dy);
        break;
    }
    if (along <= 0.5) continue;
    const score = along + 2 * side;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Without layout (no rects: a headless page), up/left step back and
 * down/right step forward in document order, wrapping.
 */
export function orderPick(count: number, current: number, dir: NavDirection | 'next' | 'prev'): number {
  if (count === 0) return -1;
  if (current < 0) return 0;
  const back = dir === 'up' || dir === 'left' || dir === 'prev';
  return (current + (back ? count - 1 : 1)) % count;
}
