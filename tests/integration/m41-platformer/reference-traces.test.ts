/**
 * The reference traces: each case of `cases.ts` as the removed 2D platformer
 * controller ran it, kept as frozen data (the arcade profile of the 3D
 * controller is measured against these fixed numbers). The traces pin what
 * each case is about (`outcomes.ts`).
 */
import { describe } from 'vitest';

import { readTrace } from './cases';
import { expectOutcomes } from './outcomes';

describe('what the reference traces show', () => {
  expectOutcomes((id) => readTrace(id).rows);
});
