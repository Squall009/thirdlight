/**
 * Which mip levels of the streamed textures fit the texture budget (Unity's
 * mipmap streaming budget, Unreal's streaming pool).
 *
 * Every streamed texture keeps its mip tail. Above that, levels are handed
 * out by need: the texture drawn the furthest below the detail its size on
 * screen asks for gets its next level first (ties: the larger on screen),
 * one level at a time, while the budget holds. Levels already resident
 * that nothing needs now (the camera moved away, the object left the view)
 * stay as long as the budget has room, the most recently needed first; when
 * it is full they are the first to go, and the least-needed texture drops
 * first. Pure: the streamer applies the plan (drops at once, loads one
 * level at a time).
 */

/** One streamed texture as the plan sees it. Levels count from 0 (the largest). */
export interface MipCandidate {
  readonly id: string;
  /** Bytes of one copy of each level (index = level). */
  readonly levelBytes: readonly number[];
  /** The first mip-tail level: the tail (this level to the smallest) is always resident. */
  readonly tail: number;
  /** The largest level resident now. */
  readonly resident: number;
  /** The largest level its size on screen asks for (`tail` when it is not seen). */
  readonly wanted: number;
  /** GPU copies drawn (each user that samples it differently has its own). */
  readonly copies: number;
  /** How much it is needed: its size on screen now, else how recently it was seen (larger: more). */
  readonly weight: number;
}

/** Bytes of a texture resident down to `level` (every level from it to the smallest, all copies). */
export function residentBytes(c: Pick<MipCandidate, 'levelBytes' | 'copies'>, level: number): number {
  let n = 0;
  for (let l = Math.max(0, level); l < c.levelBytes.length; l++) n += c.levelBytes[l]!;
  return n * Math.max(1, c.copies);
}

export interface MipPlan {
  /** The largest level each texture should hold (by id). */
  readonly target: ReadonlyMap<string, number>;
  /** Bytes of the plan: `fixedBytes` and every streamed texture at its target. */
  readonly bytes: number;
  /** The tails and `fixedBytes` alone exceed the budget (nothing streamed can be above its tail). */
  readonly over: boolean;
}

const byNeed = (a: MipCandidate, b: MipCandidate): number => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The plan for `candidates` under `budgetBytes`, of which `fixedBytes` are
 * textures that do not stream (counted, never dropped).
 */
export function planMipLevels(candidates: readonly MipCandidate[], budgetBytes: number, fixedBytes = 0): MipPlan {
  const target = new Map<string, number>();
  let used = fixedBytes;
  for (const c of candidates) {
    target.set(c.id, c.tail);
    used += residentBytes(c, c.tail);
  }
  const over = used > budgetBytes;
  const cost = (c: MipCandidate, level: number): number => c.levelBytes[level]! * Math.max(1, c.copies);
  // Needed levels, in rounds: the textures furthest below what they need first.
  const blocked = new Set<string>();
  for (;;) {
    let deficit = 0;
    for (const c of candidates) if (!blocked.has(c.id)) deficit = Math.max(deficit, target.get(c.id)! - Math.max(0, c.wanted));
    if (deficit <= 0) break;
    const round = candidates.filter((c) => !blocked.has(c.id) && target.get(c.id)! - Math.max(0, c.wanted) === deficit).sort(byNeed);
    for (const c of round) {
      const next = target.get(c.id)! - 1;
      const n = cost(c, next);
      if (used + n > budgetBytes) {
        // A larger level costs more still: this texture gets nothing more.
        blocked.add(c.id);
        continue;
      }
      used += n;
      target.set(c.id, next);
    }
  }
  // Levels resident beyond the need are kept while there is room, the most needed texture first.
  for (const c of [...candidates].sort(byNeed)) {
    let t = target.get(c.id)!;
    while (t > c.resident) {
      const n = cost(c, t - 1);
      if (used + n > budgetBytes) break;
      used += n;
      t -= 1;
    }
    target.set(c.id, t);
  }
  return { target, bytes: used, over };
}
