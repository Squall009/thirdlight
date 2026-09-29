/**
 * Phase 25.15: a virtual standard gamepad for tests and tools — the relay's
 * `gamepad` frames read through the project's input bindings (the action
 * evaluator a real pad feeds), plus the menu edges a real pad gives (D-pad or
 * left stick past 0.6: up/down/left/right, A: submit, B: cancel, start:
 * pause). Pure: one call per simulation step, in step order.
 */
import type { ActionValue } from '@thirdlight/runtime';
import { createActionEvaluator, type InputConfigLike } from './actions';

/** The standard layout's button and axis counts. */
export const VIRTUAL_PAD_BUTTONS = 17;
export const VIRTUAL_PAD_AXES = 4;
/** A button counts as down at this value or more (triggers are analogue). */
export const VIRTUAL_PAD_BUTTON_DOWN = 0.5;
/** The stick deflection that is a menu direction (as a real pad's). */
const UI_STICK = 0.6;

/** One step's pad: button values 0–1 by standard index, axes −1..1 (missing: at rest). */
export interface VirtualPadInput {
  readonly buttons?: readonly number[];
  readonly axes?: readonly number[];
}

export type VirtualPadUiEdge = 'up' | 'down' | 'left' | 'right' | 'submit' | 'cancel' | 'pause';

export interface VirtualPadStep {
  /** Every action the pad drives this step (only the ones with a value or an edge). */
  readonly actions: Readonly<Record<string, ActionValue>>;
  /** The menu edges the pad gives this step (a fresh press). */
  readonly ui: readonly VirtualPadUiEdge[];
}

/**
 * Read a virtual pad step by step. `stepMs` is the step's length (hold
 * bindings count held time with it). The pad starts at rest.
 */
export function createVirtualPad(config: InputConfigLike, stepMs: number): { step(pad: VirtualPadInput | null): VirtualPadStep } {
  const evaluator = createActionEvaluator(config);
  let n = 0;
  let prevUi: boolean[] = [];
  return {
    step(pad: VirtualPadInput | null): VirtualPadStep {
      const buttons = Array.from({ length: VIRTUAL_PAD_BUTTONS }, (_, i) => (pad?.buttons?.[i] ?? 0) >= VIRTUAL_PAD_BUTTON_DOWN);
      const axes = Array.from({ length: VIRTUAL_PAD_AXES }, (_, i) => pad?.axes?.[i] ?? 0);
      const all = evaluator.sample({ keys: new Set(), pressedKeys: new Set(), gamepad: { buttons, axes }, pointer: null, now: n * stepMs });
      n += 1;
      const actions: Record<string, ActionValue> = {};
      for (const [name, a] of Object.entries(all)) if (a.v !== 0 || (a.x ?? 0) !== 0 || (a.y ?? 0) !== 0 || a.p !== 'none') actions[name] = a;
      const cur = [buttons[12] === true || axes[1]! < -UI_STICK, buttons[13] === true || axes[1]! > UI_STICK, buttons[14] === true || axes[0]! < -UI_STICK, buttons[15] === true || axes[0]! > UI_STICK, buttons[0] === true, buttons[1] === true, buttons[9] === true];
      const names: VirtualPadUiEdge[] = ['up', 'down', 'left', 'right', 'submit', 'cancel', 'pause'];
      const ui = names.filter((_, i) => cur[i] === true && prevUi[i] !== true);
      prevUi = cur;
      return { actions, ui };
    },
  };
}
