/**
 * `@thirdlight/input` — public surface.
 *
 * Focused browser input becomes bounded, testable action frames
 * (docs/contracts/runtime.md, the ActionFrame, sampling and device-binding
 * rules).
 *
 * - **Actions** — `createActionEvaluator(config)` maps plain device state to
 *   the project's named actions (`move` and `jump` are actions like any
 *   other): bindings never add up (the largest magnitude wins), stick dead
 *   zones, `invert`/`scale`, hold bindings and the pressed/held/released
 *   phase chain.
 * - **Browser layer** — `attachBrowserInput(target, options)` is the single
 *   explicit listener owner: it installs every listener, reduces DOM/gamepad
 *   objects to device state for the evaluator, and handles text-field
 *   suppression, focus loss/hidden tab/pagehide suspension with fresh
 *   activation, hot gamepad connect/disconnect and index reuse, and a
 *   structured unavailable state for a blocked/insecure/absent gamepad API.
 *   `detach()`/`dispose()` remove every listener and clear held state,
 *   idempotently.
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
// A virtual standard gamepad read through the project's bindings (the input exercise relay).
export { createVirtualPad, VIRTUAL_PAD_AXES, VIRTUAL_PAD_BUTTON_DOWN, VIRTUAL_PAD_BUTTONS, type VirtualPadInput, type VirtualPadStep, type VirtualPadUiEdge } from './virtual-pad';
export { GAMEPAD_DEAD_ZONE } from './types';
export type { InputBindingOptions } from './types';
// Named input actions.
export { actionKeys, createActionEvaluator, DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D, type InputActionLike, type InputBindingLike, type InputConfigLike, type RawDeviceState } from './actions';
// Pointer bindings and the cursor (free/locked per map, a script's request, hidden while a gamepad drives).
export { bindsPointerButton, bindsWheel, cursorPresentation, type RawPointerState } from './actions';
