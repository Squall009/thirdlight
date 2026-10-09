# Input and rebinding

**Goal:** a new action `dash` on Left Shift and a pad button, a script
that reads it, a pointer click, and a **Rebind** button so players choose
their own key. Everything about input:
[Input](../features/input.md); the fields:
[the input document](../reference/content-blocks-environment.md#content-input);
the calls: [`ctx.input`](../reference/script-api.md#ctx-input).

Your game reads named **actions**, never keys. Each action has a type
(button, 1D axis, 2D axis), a map (`gameplay`, `ui` or one of yours) and up
to 8 bindings: keys, pad buttons and axes, the mouse. Because scripts see
only action values, replays and recorded test input stay valid whatever
the bindings are.

## In the editor

1. **File → Project Settings… → Input.** The list starts with the
   engine's defaults: `move`, `jump`, `attack`, `interact` (gameplay) and
   `pause`, `submit`, `cancel`, `navigate` (ui). Your first edit makes the
   controls the project's own; **Reset to defaults** goes back.
2. Add an action `dash`, type *button*, map *gameplay*. **+ key** and press
   Left Shift; **+ pad** and press the pad's B/Circle button. A binding
   can take a **hold** time (hold instead of tap) or name one **pad**.
3. A script reads it:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export default {
     instantiate() {
       return {};
     },
     step(_state: object, ctx: BehaviorContext): void {
       if (ctx.input.pressed('dash')) ctx.character.impulse([6, 0, 0]);
       // What the HUD shows for the action on the device in use ("Left Shift", a pad icon…).
       ctx.ui.set('dashGlyph', ctx.input.glyph('dash')?.label ?? '');
       if (ctx.input.pointerPressed()) ctx.ui.set('clicks', Number(ctx.ui.get('clicks') ?? 0) + 1);
     },
   };
   ```
   `value`, `vector`, `held` and `released` read the other kinds;
   `ctx.input.pointer()` gives the pointer's place (0–1 from the top left).
4. **Rebinding.** On your pause or controls document add a button with
   the engine action `rebind`, input `dash`, device *keyboardMouse*: the
   game listens for the next key (Esc cancels, 10 s timeout); a key another
   action of the same map uses is swapped. Or use the game shell's built-in
   **Controls** screen. Players' choices are kept in their browser.
   Scripts can do the same with `ctx.input.rebind('dash', {device, policy})`
   and read the outcome in `ctx.input.rebindEvents()`.
5. **▶ play**, press Left Shift.

## Through the API

1. [`setInput`](../reference/ops-detail.md#op-setInput) replaces the whole
   list. Start from `inputDefaults` in the answer of the `queryGameConfig`
   query (`{"op": "queryGameConfig", "projectId": "…", "args": {}}` on the
   commands route) and add yours:
   `{"input": {"actions": [ …the defaults…, {"name": "dash", "type": "button", "map": "gameplay", "bindings": [{"kind": "key", "code": "ShiftLeft"}, {"kind": "gamepadButton", "button": 1}]}]}}`.
2. Publish and attach the script ([the script guide](scripts.md#through-the-api)).
3. Play and drive it with `tl_input_exercise` frames:
   `{"stepOffset": 0, "actions": {"dash": {"v": 1, "p": "pressed"}}}`, a
   held axis `{"stepOffset": 0, "steps": 60, "actions": {"move": {"v": -1, "p": "none"}}}`,
   a click `{"stepOffset": 70, "pointer": {"x": 0.25, "y": 0.5, "buttons": 1, "pressed": 1}}`
   then `{"stepOffset": 72, "pointer": {"x": 0.25, "y": 0.5, "buttons": 0, "released": 1}}`.
   `tl_game_observe` shows `pointer`, `inputBindings` (the device in use,
   each action's glyph, `listening` while a rebind waits) and your
   `ui.values`.

## Which to use

Define actions in the editor: **+ key** and **+ pad** listen for the real
input. Use `setInput` to share one control set between projects. Test with
`tl_input_exercise`: it is exact and replays the same every time.

## Pitfalls

- **`setInput` replaces every action.** Send the defaults you keep: the
  character controller reads the actions it names (`move`, `jump` unless
  you name others).
- **A test frame's action needs `p`** (`"none"`, `"pressed"` or
  `"released"`); `{"v": -1}` alone does nothing.
- **Actions of a map the current game mode does not list read as
  released** (see [game modes](game-modes.md)). A focused document with
  `actionMap: "ui"` stops the character while a menu is open.
- **Pointer picks in 3D need 3D physics.** `ctx.physics.pickAtPointer` and
  the other 3D queries work in projects whose physics is 3D; the Starter's
  is the 2D plane (Project Settings → Gameplay → Physics).
- **A rebind listens to the real device.** Test input cannot answer it;
  `inputBindings.listening` shows it is waiting.
- **64 actions per project**, 8 rebind requests per step from scripts.

Related: [local co-op players](co-op.md), [UI documents](ui-documents.md).
