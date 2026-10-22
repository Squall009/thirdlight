/**
 * The browser binding's menu edges: the `ui` actions' keys (fed by the binding's key listener)
 * and the pad's D-pad, left stick, A, B and Start, handed out one edge per sample in arrival
 * order. A rebind that listens holds the pad's edges back until what it heard is released.
 */
import type { InputConfigLike } from './actions';
import { clipDeviceId } from './browser-pads';
import type { Rebind } from './browser-rebind';

/** One frame's menu edges. */
export interface UiSample {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  submit: boolean;
  cancel: boolean;
  pause: boolean;
}

export type UiKeys = { up: Set<string>; down: Set<string>; left: Set<string>; right: Set<string>; submit: Set<string>; cancel: Set<string>; pause: Set<string> };

/** The keys of the `ui` actions (navigate's composites give the directions). */
export function uiKeys(cfg: InputConfigLike): UiKeys {
  const out = { up: new Set<string>(), down: new Set<string>(), left: new Set<string>(), right: new Set<string>(), submit: new Set<string>(), cancel: new Set<string>(), pause: new Set<string>() };
  for (const a of cfg.actions) {
    for (const b of a.bindings as readonly { kind: string; code?: string; up?: string; down?: string; left?: string; right?: string; negative?: string; positive?: string }[]) {
      if (a.name === 'navigate') {
        if (b.kind === 'keys2d') {
          out.up.add(b.up!);
          out.down.add(b.down!);
          out.left.add(b.left!);
          out.right.add(b.right!);
        } else if (b.kind === 'keys1d') {
          out.left.add(b.negative!);
          out.right.add(b.positive!);
        }
      } else if ((a.name === 'submit' || a.name === 'cancel' || a.name === 'pause') && b.kind === 'key') {
        out[a.name as 'submit' | 'cancel' | 'pause'].add(b.code!);
      }
    }
  }
  return out;
}

export function createUiChannel(rebind: Rebind, usePad: (id: string) => void) {
  /** Menu edges in arrival order; `sample` hands out one per call (fast key bursts keep their order). */
  const uiQueue: (keyof UiSample)[] = [];
  const pushUi = (k: keyof UiSample): void => {
    if (uiQueue.length < 16) uiQueue.push(k);
  };
  let prevUiPad: boolean[] = [];

  /** The next menu edge; `poll` is the gamepad poll while pads can be read (null: none). */
  const sample = (poll: (() => ArrayLike<Gamepad | null>) | null): UiSample => {
    if (poll !== null) {
      try {
        const list = poll();
        const pad = Array.from(list).find((g) => g !== null && g.mapping === 'standard') ?? null;
        const now = pad === null ? [] : Array.from(pad.buttons, (b) => b?.pressed === true);
        // The pad counts as the device used last while a menu is open too; a rebind listens.
        if (pad !== null && (now.some((d) => d) || Array.from(pad.axes).some((v) => Math.abs(v ?? 0) > 0.5))) {
          usePad(clipDeviceId(pad.id));
        }
        if (rebind.listening()) {
          rebind.pollCapture(list);
          // What is held now waits for its release before the menus see it.
          const ax = pad === null ? [0, 0] : [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
          prevUiPad = [now[12] === true || ax[1]! < -0.6, now[13] === true || ax[1]! > 0.6, now[14] === true || ax[0]! < -0.6, now[15] === true || ax[0]! > 0.6, now[0] === true, now[1] === true, now[9] === true];
          return { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
        }
        if (rebind.listeningPad()) {
          // A pad rebinding takes the next fresh button press
          // (nothing else sees the pad meanwhile).
          prevUiPad = [];
          rebind.padStep(now, () => {
            // The chosen button is still down: the menus wait for its release.
            prevUiPad = [now[12] === true, now[13] === true, now[14] === true, now[15] === true, now[0] === true, now[1] === true, now[9] === true];
          });
          return { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
        }
        const ax = pad === null ? [0, 0] : [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
        const dirs = [ax[1]! < -0.6, ax[1]! > 0.6, ax[0]! < -0.6, ax[0]! > 0.6];
        const cur = [now[12] === true || dirs[0]!, now[13] === true || dirs[1]!, now[14] === true || dirs[2]!, now[15] === true || dirs[3]!, now[0] === true, now[1] === true, now[9] === true];
        const edge = (i: number): boolean => cur[i] === true && prevUiPad[i] !== true;
        (['up', 'down', 'left', 'right', 'submit', 'cancel', 'pause'] as const).forEach((k, i) => {
          if (edge(i)) pushUi(k);
        });
        prevUiPad = cur;
      } catch {
        // a failed poll reads as no pad
      }
    }
    const out: UiSample = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
    const next = uiQueue.shift();
    if (next !== undefined) out[next] = true;
    return out;
  };

  return { pushUi, sample };
}
