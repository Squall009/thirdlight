/**
 * The runtime-owned intent set of one step (what the modules asked to move,
 * jump, write and drive this step, with who wrote each), reused across steps.
 */
import type { JumpPhase } from './actions';
import type { IntentTransformWrite } from './intents';

/** One player controller's channels of a step, with who wrote each (null: none this step). */
export interface MutableControllerChannels {
  move: number | null;
  jump: JumpPhase | null;
  moveWriter: string | null;
  jumpWriter: string | null;
  moveY: number | null;
  characterMove: { x: number; z: number; run: boolean } | null;
  characterPlace: { x: number; y: number; z: number } | null;
  characterEnabled: boolean | null;
  characterWriters: Map<string, string>;
}

/** A further controller's empty channels. */
export function emptyControllerChannels(): MutableControllerChannels {
  return { move: null, jump: null, moveWriter: null, jumpWriter: null, moveY: null, characterMove: null, characterPlace: null, characterEnabled: null, characterWriters: new Map() };
}

/**
 * The runtime-owned mutable per-step intent set. Its own channels are the
 * first player controller's; `further` holds the other controllers' (made
 * when an intent names one, dropped at the next step).
 */
export interface MutableIntentSet extends MutableControllerChannels {
  stepIndex: number;
  move: number | null;
  jump: JumpPhase | null;
  moveWriter: string | null;
  jumpWriter: string | null;
  transformWrites: IntentTransformWrite[];
  /**
   * Committed channels per entity in this step: `axesTag * 64 +
   * mask` with position x/y/z = 1/2/4, rotation 8, scale 16; a value with an
   * older tag counts as none, so nothing is cleared per step.
   */
  axes: Map<string, number>;
  axesTag: number;
  /** Accepted intents committed in this step. */
  count: number;
  /** The committed control_move's second axis, and the character intents with their writers (null: none this step). */
  moveY: number | null;
  characterMove: { x: number; z: number; run: boolean } | null;
  characterPlace: { x: number; y: number; z: number } | null;
  characterEnabled: boolean | null;
  characterWriters: Map<string, string>;
  further: Map<string, MutableControllerChannels>;
}

export function emptyMutableIntents(stepIndex: number): MutableIntentSet {
  return {
    stepIndex,
    move: null,
    jump: null,
    moveWriter: null,
    jumpWriter: null,
    transformWrites: [],
    axes: new Map(),
    axesTag: 1,
    count: 0,
    moveY: null,
    characterMove: null,
    characterPlace: null,
    characterEnabled: null,
    characterWriters: new Map(),
    further: new Map(),
  };
}

export function resetMutableIntents(s: MutableIntentSet, stepIndex: number): void {
  s.stepIndex = stepIndex;
  s.move = null;
  s.jump = null;
  s.moveWriter = null;
  s.jumpWriter = null;
  s.transformWrites.length = 0;
  s.axesTag += 1;
  s.count = 0;
  s.moveY = null;
  s.characterMove = null;
  s.characterPlace = null;
  s.characterEnabled = null;
  if (s.characterWriters.size > 0) s.characterWriters.clear();
  if (s.further.size > 0) s.further.clear();
}
