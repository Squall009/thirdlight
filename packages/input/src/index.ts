/**
 * `@thirdlight/input` — public surface (dependencies.md `input` row:
 * `mapRawInput`, `attachBrowserInput`, `DEFAULT_KEYBOARD_MAP`,
 * `GAMEPAD_DEAD_ZONE`, `RawInputSnapshot`, `InputBindingOptions`; plus
 * `createStepInputSource`, the replayable test source).
 *
 * Focused browser input becomes bounded, testable action frames
 * (docs/contracts/runtime.md, the ActionFrame, sampling and device-binding
 * rules).
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
 * Module ownership: imports `@thirdlight/runtime`
 * types only — no editor/protocol/backend/workspace/commands/three/
 * three-adapter/physics-rapier/character edge, no Node built-ins, no I/O.
 *
 * The bounded semantic menu-control
 * channel — `createMenuController` (pure) and the owner's additive
 * `sampleMenu()`/`markConfirmConsumed()` methods. No new dependency.
 */
export { attachBrowserInput, focusGameSurface, type UiSample } from './browser';
// Listen-for-input rebinding and the frame's input entry.
export type { CaptureInputOptions, CapturedInput } from './browser';
export {
  createMenuController,
  MENU_CONFIRM_CODES,
  MENU_GAMEPAD_CONFIRM_BUTTON,
  MENU_MUTE_CODE,
} from './menu';
export type { MenuConfirmDevice, MenuController, MenuSample } from './menu';
export { mapRawInput, toActionFrame, type CharacterChannels } from './mapping';
export { createStepInputSource, type StepInputStep } from './step-source';
// A virtual standard gamepad read through the project's bindings (the input exercise relay).
export { createVirtualPad, VIRTUAL_PAD_AXES, VIRTUAL_PAD_BUTTON_DOWN, VIRTUAL_PAD_BUTTONS, type VirtualPadInput, type VirtualPadStep, type VirtualPadUiEdge } from './virtual-pad';
export { DEFAULT_KEYBOARD_MAP, GAMEPAD_DEAD_ZONE } from './types';
export type { InputBindingOptions, RawInputSnapshot } from './types';
// Named input actions.
export { actionKeys, createActionEvaluator, DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D, characterKeys, type InputActionLike, type InputBindingLike, type InputConfigLike, type RawDeviceState } from './actions';
// The character controller's pad controls (rebindable).
export { characterPad, readCharacterPad, STANDARD_CHARACTER_PAD, type CharacterPad } from './actions';
// Pointer bindings and the cursor (free/locked per map, a script's request, hidden while a gamepad drives).
export { bindsPointerButton, bindsWheel, cursorPresentation, type RawPointerState } from './actions';
