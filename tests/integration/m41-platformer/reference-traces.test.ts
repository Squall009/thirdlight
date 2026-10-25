/**
 * The 2D platformer controller's reference traces: each case of `cases.ts`
 * run through the production game host on the 2D backend reproduces its
 * stored trace exactly (the traces are deterministic, so the arcade
 * profile of the 3D controller is measured against fixed numbers).
 * `TL_RECORD_TRACES=1` re-records them (only ever from the 2D controller).
 * The traces also pin what each case is about (`outcomes.ts`).
 */
import { describe, expect, it } from 'vitest';

import { CASES, readTrace, recordCase, traceFile, writeTrace } from './cases';
import { expectOutcomes } from './outcomes';

const RECORD = process.env['TL_RECORD_TRACES'] === '1';

describe('the 2D platformer controller reproduces its reference traces', () => {
  for (const c of CASES) {
    it(c.id, async () => {
      const { rows, errors } = await recordCase(c, 2);
      expect(errors).toEqual([]);
      if (RECORD) writeTrace(traceFile(c, rows));
      const stored = readTrace(c.id);
      expect(stored.rows.length).toBe(c.steps);
      const first = rows.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(stored.rows[i]));
      expect(first, `first differing step ${first}: ${JSON.stringify(rows[first])} vs ${JSON.stringify(stored.rows[first])}`).toBe(-1);
    }, 60_000);
  }
});

describe('what the reference traces show', () => {
  expectOutcomes((id) => readTrace(id).rows);
});
