/**
 * The input exercise's frames as the simulation takes them. A
 * frame's virtual gamepad needs the project's input bindings, which only the
 * page has, so it is read here, step by step in step order, before the frames
 * go to the simulation (the page's or the worker's): each step of a frame
 * with a pad becomes its own frame carrying the actions the pad drives (the
 * frame's own actions win by name) and the menu edges it gives. The pad
 * starts at rest and is at rest in every step whose frame has none (gaps
 * stay neutral). Frames without a pad pass through unchanged.
 */
import { continueFrame, type RelayTestFrame, type RelayUiEdgeName } from '@thirdlight/game-host';
import { createVirtualPad, type InputConfigLike, type VirtualPadInput } from '@thirdlight/input';
import type { ActionFrame } from '@thirdlight/runtime';

/** One frame as the bridge brings it (the relay parser upstream validated it). */
export interface IncomingRelayFrame {
  readonly stepOffset: number;
  readonly steps?: number;
  readonly actions?: ActionFrame['actions'];
  readonly pointer?: ActionFrame['pointer'];
  readonly gamepad?: VirtualPadInput;
  readonly ui?: readonly string[];
}

const plain = (f: IncomingRelayFrame): RelayTestFrame => ({
  stepOffset: f.stepOffset,
  ...(f.steps !== undefined && f.steps !== 1 ? { steps: f.steps } : {}),
  ...(f.actions !== undefined ? { actions: f.actions } : {}),
  ...(f.pointer !== undefined ? { pointer: f.pointer } : {}),
  ...(f.ui !== undefined && f.ui.length > 0 ? { ui: f.ui as readonly RelayUiEdgeName[] } : {}),
});

export function resolveRelayFrames(frames: readonly IncomingRelayFrame[], config: InputConfigLike, stepHz: number): RelayTestFrame[] {
  if (!frames.some((f) => f.gamepad !== undefined)) return frames.map(plain);
  const pad = createVirtualPad(config, 1000 / stepHz);
  const out: RelayTestFrame[] = [];
  let step = 0;
  for (const f of frames) {
    for (; step < f.stepOffset; step += 1) pad.step(null); // a gap: the pad at rest
    const steps = f.steps ?? 1;
    if (f.gamepad === undefined) {
      out.push(plain(f));
      for (let k = 0; k < steps; k += 1, step += 1) pad.step(null);
      continue;
    }
    const first: ActionFrame = { stepIndex: 0, ...(f.actions !== undefined ? { actions: f.actions } : {}), ...(f.pointer !== undefined ? { pointer: f.pointer } : {}) };
    const rest = continueFrame(first);
    for (let k = 0; k < steps; k += 1, step += 1) {
      const own = k === 0 ? first : rest;
      const r = pad.step(f.gamepad);
      const actions = { ...r.actions, ...(own.actions ?? {}) };
      const ui = [...(k === 0 ? (f.ui ?? []) : []), ...r.ui] as RelayUiEdgeName[];
      out.push({
        stepOffset: step,
        ...(Object.keys(actions).length > 0 ? { actions } : {}),
        ...(own.pointer !== undefined ? { pointer: own.pointer } : {}),
        ...(ui.length > 0 ? { ui } : {}),
      });
    }
  }
  return out;
}
