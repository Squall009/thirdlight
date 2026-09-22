/**
 * The replayable step-indexed input source for tests/replays (packet 30
 * "separate injectable step-input source"; input.md §6's replay model
 * expressed over *raw* snapshots rather than pre-built frames).
 *
 * The engine-level frame-level replay source lives in `@thirdlight/runtime`
 * (`createRecordedActionSource`). This source is its raw-input counterpart:
 * it threads the exact same pure mapping state across the supplied steps, so
 * a recorded `(stepIndex, RawInputSnapshot)` sequence replays byte-identically
 * in the Node harness, the preview bundle and the export bundle — and it is
 * fully separate from the browser attachment (no DOM, no listeners).
 *
 * `sample(n)` is a pure lookup: the mapped frame for a supplied step index,
 * else the neutral frame for `n`. A missing index also ends the jump chain,
 * which is exactly how the 12-step settle pre-roll (steps 0–11) is
 * represented. `reset(reason)` is a no-op: a recorded sequence must never
 * silently change on focus events (input.md §6).
 */
import type { ActionFrame, ActionSource } from '@thirdlight/runtime';
import { mapRawStep, type StepState } from './mapping';
import type { RawInputSnapshot } from './types';

/** One replayable step: the raw snapshot the binding would have produced. */
export interface StepInputStep {
  /** Executed fixed-step index (strictly ascending across the array). */
  stepIndex: number;
  /** The raw device state at that step. */
  raw: RawInputSnapshot;
}

function neutral(stepIndex: number): ActionFrame {
  return { stepIndex, moveX: 0, jump: 'none' };
}

function isPlainSnapshot(value: unknown): value is RawInputSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the replayable raw-input step source. Construction is strict: every
 * entry must carry an integer `stepIndex ≥ 0` and a raw snapshot, and the
 * indexes must strictly ascend (duplicates or regressions throw), so a
 * fixture cannot silently sample one step twice. Construction is the only
 * place the mapping runs; `sample(n)` is a pure lookup.
 */
export function createStepInputSource(steps: readonly StepInputStep[]): ActionSource {
  if (!Array.isArray(steps)) {
    throw new Error('step input source: steps must be an array');
  }
  const frames = new Map<number, ActionFrame>();
  let previousState: StepState = { down: false, awaitingRelease: false };
  let previousIndex: number | null = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (typeof step !== 'object' || step === null) {
      throw new Error(`step input source: entry ${i} must be an object`);
    }
    const { stepIndex, raw } = step;
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new Error(`step input source: entry ${i} stepIndex must be an integer >= 0`);
    }
    if (!isPlainSnapshot(raw)) {
      throw new Error(`step input source: entry ${i} raw must be a snapshot object`);
    }
    if (previousIndex !== null && stepIndex <= previousIndex) {
      throw new Error(
        `step input source: entry ${i} stepIndex ${stepIndex} does not strictly ascend past ${previousIndex}`,
      );
    }
    const outcome = mapRawStep(raw, {
      stepIndex,
      previousJumpDown: previousState.down,
      jumpAwaitingRelease: previousState.awaitingRelease,
    });
    previousState = outcome.next;
    previousIndex = stepIndex;
    frames.set(stepIndex, Object.freeze({ ...outcome.frame }));
  }

  return Object.freeze({
    sample: (stepIndex: number): ActionFrame => frames.get(stepIndex) ?? neutral(stepIndex),
    reset: (): void => {
      /* recorded sequences must not silently change on focus events */
    },
  });
}
