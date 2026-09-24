/**
 * `@thirdlight/input` — public surface (dependencies.md §3 `input` row:
 * `mapRawInput`, `attachBrowserInput`, `DEFAULT_KEYBOARD_MAP`,
 * `GAMEPAD_DEAD_ZONE`, `RawInputSnapshot`, `InputBindingOptions`; plus
 * `createStepInputSource`, the replayable test source the packet requires —
 * recorded as a bounded contract-change request C30-3 in the packet-30
 * handoff/evidence, since the accepted row does not list it yet).
 *
 * Packet 30 (docs/contracts/runtime.md §12.5.1–§12.5.8: the ActionFrame/sampling
 * text from `input.md` §2/§3/§6 at §12.5.1–§12.5.3, and the device-binding
 * `input.md` §4–§5 text at §12.5.4–§12.5.8 promoted by the Gate H repair,
 * C30-1): focused browser input becomes bounded, testable action frames.
 *
 * - **Pure layer** — `mapRawInput(snapshot, options)` maps one plain-data
 *   `RawInputSnapshot` to one quantized `ActionFrame` (keyboard A/D + arrows +
 *   Space; standard gamepad axis 0 / D-pad 14–15 / primary face button 0;
 *   0.2 radial dead zone with linear rescaling; deterministic keyboard →
 *   D-pad → stick arbitration with no summation; the press latch and jump
 *   phase chain computed on the OR across sources). No DOM, clock or state.
 * - **Browser layer** — `attachBrowserInput(target, options)` is the single
 *   explicit listener owner: it installs every listener, reduces DOM/gamepad
 *   objects to raw snapshots, and handles text-field suppression, focus
 *   loss/hidden tab/pagehide suspension with fresh activation, hot gamepad
 *   connect/disconnect and index reuse, and a structured unavailable state
 *   for a blocked/insecure/absent gamepad API. `detach()`/`dispose()` remove
 *   every listener and clear held state, idempotently.
 * - **Replay layer** — `createStepInputSource(steps)` is the injectable
 *   step-indexed source for tests/replays, separate from the browser
 *   attachment.
 *
 * Module ownership (dependencies.md §4.1/§4.3): imports `@thirdlight/runtime`
 * types only — no editor/protocol/backend/workspace/commands/three/
 * three-adapter/physics-rapier/platformer edge, no Node built-ins, no I/O.
 *
 * Packet 55 (delivery.md §4.1/§4.2): the bounded semantic menu-control
 * channel — `createMenuController` (pure) and the owner's additive
 * `sampleMenu()`/`markConfirmConsumed()` methods. No new dependency.
 */
export { attachBrowserInput, focusGameSurface, type UiSample } from './browser';
export {
  createMenuController,
  MENU_CONFIRM_CODES,
  MENU_GAMEPAD_CONFIRM_BUTTON,
  MENU_MUTE_CODE,
} from './menu';
export type { MenuConfirmDevice, MenuController, MenuSample } from './menu';
export { mapRawInput } from './mapping';
export { createStepInputSource, type StepInputStep } from './step-source';
export { DEFAULT_KEYBOARD_MAP, GAMEPAD_DEAD_ZONE } from './types';
export type { InputBindingOptions, RawInputSnapshot } from './types';
// Phase 9.8: named input actions.
export { actionKeys, createActionEvaluator, DEFAULT_INPUT_CONFIG, platformerKeys, type InputActionLike, type InputBindingLike, type InputConfigLike, type RawDeviceState } from './actions';
