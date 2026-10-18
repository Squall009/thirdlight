/**
 * The bookkeeping of occlusion queries (WebGL 2), apart from the GPU: when a
 * draw's box is asked, which answers it is hidden by, and what counts as late.
 *
 * A query is drawn in a frame and answered a frame or more later (WebGL 2
 * never answers in the frame that drew it). So every answer is about a past
 * view, and the rules keep that conservative:
 *
 * - a draw is hidden only after two answers in a row (two consecutive
 *   queries of its box, none lost between them) said nothing of the box was
 *   seen, the newer one at most {@link OCCLUSION_QUERY_MAX_AGE_FRAMES} old;
 *   it is shown at the first answer that saw any of it, and whenever its
 *   newest answer grows older than that;
 * - a draw hidden, or hidden at its last answer, is asked every frame; one
 *   seen is asked again every {@link OCCLUSION_QUERY_SPREAD_FRAMES} frames
 *   (spread by its place, so the queries of a frame stay few);
 * - a query whose box three did not draw (its program still building) is
 *   lost: no answer, and the run of answers starts again.
 *
 * Lateness is measured from the answers too: a draw hidden in the frame its
 * box was seen (that frame's query answered "seen") was drawn late in that
 * frame. The box is larger than the draw, so this is an upper bound of the
 * frames that differ from a frame without culling.
 */
import { OCCLUSION_QUERY_MAX_AGE_FRAMES, OCCLUSION_QUERY_SPREAD_FRAMES } from '@thirdlight/runtime';

/** One draw's queries: what was asked and answered. */
export class QueryRecord {
  /** Queries asked so far (the last one's number). */
  asked = 0;
  /** The newest answer: its query's number and frame, and whether it saw nothing (-1: none yet). */
  lastSeq = -1;
  lastFrame = -1;
  lastHidden = false;
  /** The answer before it. */
  prevSeq = -1;
  prevHidden = false;
  /** Hidden from the view now. */
  hidden = false;
  /** Frames in a row it was hidden while its box was seen, the current run (see the module's lateness). */
  lateRun = 0;

  constructor(
    /** Its place among the draws asked (spreads the queries of draws seen over the frames). */
    readonly slot: number,
  ) {}
}

/** Whether `r` is asked in `frame`: every frame while hidden or hidden at its last answer, else every few frames. */
export function queryDue(r: QueryRecord, frame: number): boolean {
  if (r.hidden || r.lastHidden || r.lastFrame < 0) return true;
  return (frame + r.slot) % OCCLUSION_QUERY_SPREAD_FRAMES === 0;
}

/** A query of `r` drawn now: its number (the answer names it). */
export function queryAsked(r: QueryRecord): number {
  r.asked += 1;
  return r.asked;
}

/** What one answer did to the lateness counts. */
export interface AnswerEffect {
  /** The draw was hidden in the frame whose query saw its box: that frame was late. */
  readonly late: boolean;
}

/**
 * The answer to query `seq` of `r`, drawn in `frame`: `hidden` when nothing
 * of the box passed the depth test; `wasHidden`: whether the draw was hidden
 * in that frame. Answers come in order; an older one than the newest is
 * ignored.
 */
export function queryAnswered(r: QueryRecord, seq: number, frame: number, hidden: boolean, wasHidden: boolean): AnswerEffect {
  if (seq <= r.lastSeq) return { late: false };
  r.prevSeq = r.lastSeq;
  r.prevHidden = r.lastHidden;
  r.lastSeq = seq;
  r.lastFrame = frame;
  r.lastHidden = hidden;
  const late = wasHidden && !hidden;
  r.lateRun = late ? r.lateRun + 1 : 0;
  return { late };
}

/** Whether `r` is hidden in `frame` by its answers (two in a row saw nothing, the newer one recent enough). */
export function hiddenByAnswers(r: QueryRecord, frame: number): boolean {
  return r.lastHidden && r.prevHidden && r.lastSeq === r.prevSeq + 1 && frame - r.lastFrame <= OCCLUSION_QUERY_MAX_AGE_FRAMES;
}

/**
 * Forget every answer of `r` (a camera cut, the eye inside its box, out of
 * view): drawn until two new ones hide it. The answers to queries already
 * drawn are about the old view and are ignored when they come.
 */
export function queryForget(r: QueryRecord): void {
  r.lastSeq = r.asked;
  r.prevSeq = -1;
  r.lastFrame = -1;
  r.lastHidden = false;
  r.prevHidden = false;
  r.hidden = false;
  r.lateRun = 0;
}
