/**
 * Stored copies as rows of the culled-instance table, without a GPU: the
 * rules the copies' selection pass runs in compute (`copy-rows-select.ts`)
 * and the CPU reference its tests hold it to.
 *
 * A set of copies keeps its copies once in the table's pools; each frame one
 * compute pass looks at every copy and picks, for the view:
 *
 * - its level of detail, by the shared screen-size rule with the project's
 *   hysteresis (`@thirdlight/shared` `lodLevelStep`), remembered per copy;
 * - whether it is thinned out by distance (its rank against the falloff's
 *   share, `copyDensitySteps`);
 * - whether its sphere is in the frustum;
 *
 * and appends it to the list of each draw that draws it: its level's (in
 * view: from the front; out of view: from the back, for the shadow cameras),
 * the meshes outside every level's (unless past the cull size), and the
 * near-shadow list (within the rule's shadow distance). A copy that changed
 * level is also listed, for the view, in the level it left, until its
 * cross-fade is done: the two draws keep complementary pixels of one dither
 * (`dither-fade.ts`), so the switch shows no pop.
 *
 * Per copy the pass keeps one u32 of state: the level drawn, the level left
 * and the fade's progress.
 */
import { lodLevelOf } from '@thirdlight/shared';

import { copyDensityAt } from './copies-prepare';
import { coverShare, type CoverThinning } from './cover-placement';

/** Seconds a copy's switch between two levels is cross-faded over. */
export const COPY_LEVEL_FADE_S = 0.25;

/** The fade's remaining share is kept in 16 bits: a switch starts it here, 0 is a finished fade. */
export const COPY_FADE_FULL = 65535;

/** Floats a copy takes in the pools (as `COPY_FLOATS`): place and rank, turn, scale and paint slot, largest scale. */
export const COPY_ROW_FLOATS = 16;

/**
 * One copy's state packed in a u32, all zero when fresh (a place newly given to a set is zeroed): the level drawn
 * + 1 (bits 0–7; 0: none picked yet), the level left + 1 (8–15; 0: none) and the fade's remaining share (16–31).
 */
export function packCopyState(level: number, left: number, remaining: number): number {
  return (((level + 1) & 0xff) | (((left + 1) & 0xff) << 8) | ((Math.round(remaining) & 0xffff) << 16)) >>> 0;
}

/** A state's level drawn and level left (-1: none) and its fade's remaining share. */
export function unpackCopyState(s: number): { level: number; left: number; remaining: number } {
  return { level: (s & 0xff) - 1, left: ((s >>> 8) & 0xff) - 1, remaining: s >>> 16 };
}

/** The share of {@link COPY_FADE_FULL} a fade runs down by in `dt` seconds. */
export function copyFadeStep(dt: number): number {
  return Math.round((Math.max(0, dt) / COPY_LEVEL_FADE_S) * COPY_FADE_FULL);
}

/**
 * The state after a pick of level `target`: a first pick takes it at once; a new level starts a fade from the
 * one drawn; the same level runs the fade down by `step` (the level left is forgotten once it is done).
 */
export function nextCopyState(state: number, target: number, step: number): number {
  const was = unpackCopyState(state);
  let left = was.left;
  let remaining = was.remaining;
  if (was.level < 0) {
    left = -1;
    remaining = 0;
  } else if (target !== was.level) {
    left = was.level;
    remaining = COPY_FADE_FULL;
  } else remaining = Math.max(0, remaining - step);
  if (remaining === 0) left = -1;
  return packCopyState(target, left, remaining);
}

/** What a selection knows of its set and group for a frame (the CPU reference's input; the pass reads the same from its buffers). */
export interface CopySelection {
  /** Switch distances of the group's levels (level 0's first, at 0), in level units at scale 1. */
  readonly switches: readonly number[];
  /** The last level is the cull size (past it nothing is drawn). */
  readonly culls: boolean;
  /** Metres → level units (over the view's zoom and the LOD bias) and the project's hysteresis share. */
  readonly toDistance: number;
  readonly hysteresis: number;
  /** The set's largest world scale. */
  readonly worldScale: number;
  /** Thinning by distance: share 1 to `from`, down to `min` at `to` (level units at scale 1); null: none. */
  readonly density: { readonly from: number; readonly to: number; readonly min: number } | null;
  /** Ground cover's thinning by metres across the ground (`coverShare`; absent or null: none). */
  readonly cover?: CoverThinning | null;
  /** The near-shadow list's reach (metres; null: none). */
  readonly nearReach: number | null;
  /** The meshes outside every level are drawn by this selection (its first group's). */
  readonly ungrouped: boolean;
  /** Each level has draws of its own (false for a group none of whose meshes draws at a level). */
  readonly levels: readonly boolean[];
}

/** Where a copy is listed this frame: the levels' lists (front: the view sees it), the ungrouped list, the near list. */
export interface CopyListing {
  readonly state: number;
  /** [level, front] pairs: the level it draws now and, while it fades, the one it left (front only). */
  readonly levels: readonly (readonly [number, boolean])[];
  /** Listed in the ungrouped meshes' list (front: the view sees it); null: not listed. */
  readonly ungrouped: boolean | null;
  readonly near: boolean;
  /** Its level's fade for the view (0 … 1: how far it has come in; 1 done). */
  readonly fade: number;
}

/**
 * The CPU reference of one copy's pick: `metres` from the eye, its largest scale `scale` (before the world's),
 * thinning `rank`, whether the frustum holds its sphere, its state as kept, the seconds since the last pick, and
 * its metres from the eye across the ground (ground cover thins by them; absent: `metres`).
 */
export function selectCopy(sel: CopySelection, metres: number, scale: number, rank: number, inView: boolean, state: number, dt: number, across = metres): CopyListing {
  const s = scale * sel.worldScale;
  const d = metres * sel.toDistance;
  const target = lodLevelOf(sel.switches, d, s, unpackCopyState(state).level, sel.hysteresis);
  const next = nextCopyState(state, target, copyFadeStep(dt));
  const { level, left, remaining } = unpackCopyState(next);
  const cover = sel.cover ?? null;
  const share = cover !== null ? coverShare(cover, across) : sel.density !== null ? copyDensityAt(d, sel.density.from * s, sel.density.to * s, sel.density.min) : 1;
  const kept = s > 0 && (cover === null && sel.density === null ? true : rank < share);
  const last = sel.switches.length - 1;
  const culled = sel.culls && level === last;
  const levels: [number, boolean][] = [];
  if (kept && !culled && sel.levels[level] === true) levels.push([level, inView]);
  if (kept && inView && left >= 0 && left !== level && !(sel.culls && left === last) && sel.levels[left] === true) levels.push([left, true]);
  const ungrouped = sel.ungrouped && kept && !culled ? inView : null;
  const near = sel.nearReach !== null && kept && !culled && metres <= sel.nearReach;
  return { state: next, levels, ungrouped, near, fade: 1 - remaining / COPY_FADE_FULL };
}
