/**
 * The occlusion queries' bookkeeping (WebGL 2), apart from the GPU: two
 * answers in a row hide a draw, the first that sees it shows it, an answer
 * too old is not trusted, a lost query breaks the run, a forgotten record
 * ignores the answers to queries drawn before, draws seen are asked every few
 * frames, and lateness is counted from the answers.
 */
import { describe, expect, it } from 'vitest';

import { OCCLUSION_QUERY_MAX_AGE_FRAMES, OCCLUSION_QUERY_SPREAD_FRAMES, occlusionCameraCut, occlusionQueryMargin, OCCLUSION_CUT_TURN_RAD } from '@thirdlight/runtime';

import { hiddenByAnswers, queryAnswered, queryAsked, queryDue, queryForget, QueryRecord } from './occlusion-queries-rule';

/** Ask `r` in `frame` and answer it at once (`hidden`: nothing of the box passed). */
function askAndAnswer(r: QueryRecord, frame: number, hidden: boolean): { late: boolean } {
  const seq = queryAsked(r);
  return queryAnswered(r, seq, frame, hidden, r.hidden);
}

describe('occlusion query bookkeeping', () => {
  it('hides a draw after two answers in a row that saw nothing, and shows it at the first that sees it', () => {
    const r = new QueryRecord(0);
    askAndAnswer(r, 1, true);
    expect(hiddenByAnswers(r, 2), 'one answer is not enough').toBe(false);
    askAndAnswer(r, 2, true);
    expect(hiddenByAnswers(r, 3)).toBe(true);
    askAndAnswer(r, 3, false);
    expect(hiddenByAnswers(r, 4)).toBe(false);
  });

  it('does not trust an answer older than the age bound', () => {
    const r = new QueryRecord(0);
    askAndAnswer(r, 1, true);
    askAndAnswer(r, 2, true);
    expect(hiddenByAnswers(r, 2 + OCCLUSION_QUERY_MAX_AGE_FRAMES)).toBe(true);
    expect(hiddenByAnswers(r, 3 + OCCLUSION_QUERY_MAX_AGE_FRAMES)).toBe(false);
  });

  it('a lost query (its box not drawn) breaks the run; answers out of order are ignored', () => {
    const r = new QueryRecord(0);
    askAndAnswer(r, 1, true);
    queryAsked(r); // lost: never answered
    askAndAnswer(r, 3, true);
    expect(hiddenByAnswers(r, 4), 'two hidden answers, but not in a row').toBe(false);
    askAndAnswer(r, 4, true);
    expect(hiddenByAnswers(r, 5)).toBe(true);
    // An answer older than the newest changes nothing.
    queryAnswered(r, 2, 2, false, false);
    expect(hiddenByAnswers(r, 5)).toBe(true);
  });

  it('a forgotten record ignores the answers to the queries drawn before it forgot', () => {
    const r = new QueryRecord(0);
    const a = queryAsked(r);
    const b = queryAsked(r);
    queryForget(r);
    queryAnswered(r, a, 1, true, false);
    queryAnswered(r, b, 2, true, false);
    expect(hiddenByAnswers(r, 3), 'the old view\'s answers hide nothing').toBe(false);
    askAndAnswer(r, 3, true);
    askAndAnswer(r, 4, true);
    expect(hiddenByAnswers(r, 5)).toBe(true);
  });

  it('asks a draw seen every few frames (spread by its place), a hidden or suspect one every frame', () => {
    const seen = Array.from({ length: OCCLUSION_QUERY_SPREAD_FRAMES }, (_, slot) => new QueryRecord(slot));
    for (const r of seen) askAndAnswer(r, 0, false);
    for (let f = 1; f <= OCCLUSION_QUERY_SPREAD_FRAMES * 3; f += 1) {
      // One of them a frame: each in its own frame of the spread.
      expect(seen.filter((r) => queryDue(r, f)).length).toBe(1);
    }
    const suspect = new QueryRecord(1);
    askAndAnswer(suspect, 0, true);
    for (let f = 1; f <= 5; f += 1) expect(queryDue(suspect, f)).toBe(true);
    expect(queryDue(new QueryRecord(1), 1), 'no answer yet').toBe(true);
  });

  it('counts a late frame when a hidden draw\'s query saw its box, and the run of them', () => {
    const r = new QueryRecord(0);
    askAndAnswer(r, 1, true);
    askAndAnswer(r, 2, true);
    r.hidden = hiddenByAnswers(r, 3);
    expect(r.hidden).toBe(true);
    // Drawn hidden in frames 3 and 4 while the box showed (the answers came late): two late frames in a run.
    const s3 = queryAsked(r);
    const s4 = queryAsked(r);
    expect(queryAnswered(r, s3, 3, false, true).late).toBe(true);
    expect(queryAnswered(r, s4, 4, false, true).late).toBe(true);
    expect(r.lateRun).toBe(2);
    r.hidden = hiddenByAnswers(r, 5);
    expect(r.hidden).toBe(false);
    expect(askAndAnswer(r, 5, false).late).toBe(false);
    expect(r.lateRun).toBe(0);
  });

  it('boxes grow with distance and with the camera\'s motion; a jump or a fast turn is a cut, a steady flight is not', () => {
    expect(occlusionQueryMargin(100, 0)).toBeGreaterThan(occlusionQueryMargin(10, 0));
    expect(occlusionQueryMargin(10, 0.5) - occlusionQueryMargin(10, 0)).toBeCloseTo(0.5 * (OCCLUSION_QUERY_MAX_AGE_FRAMES + 1));
    expect(occlusionCameraCut(0.4, 0.4, 1)).toBe(false);
    expect(occlusionCameraCut(5, 0.4, 1)).toBe(true);
    expect(occlusionCameraCut(0, 0, Math.cos(OCCLUSION_CUT_TURN_RAD * 0.5))).toBe(false);
    expect(occlusionCameraCut(0, 0, Math.cos(OCCLUSION_CUT_TURN_RAD * 1.5))).toBe(true);
  });
});
