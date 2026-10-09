# Input

Named input actions, pointer input and 3D queries, collision layers, and
rebinding with glyphs. Step by step: [the input guide](../guides/input.md);
the fields: [the input document](../reference/content-blocks-environment.md#content-input).

## Input actions

The game reads named **actions**, not keys (File → Project Settings… → Input): `move`
(A/D, ←/→, D-pad, left stick), `jump` (Space, pad A), `attack` (J, pad X),
`interact` (E, pad Y), and for menus `pause` (Esc, Start), `submit` (Enter,
pad A), `cancel` (Backspace, pad B), `navigate` (arrows/WASD, stick). "+ key"
listens for the next key (an axis asks for two or four keys), "+ pad" for
the next gamepad button; × removes a binding; new actions can be added. The
first edit makes the controls the project's own; "Reset to defaults" goes
back. The character controller moves and jumps with the actions it names
(`moveAction`, `jumpAction`; defaults the `move` and `jump` bindings; each
player of a co-op game names its own):
their keys, and their pad buttons and stick axis (`jump`'s pad buttons,
`move`'s button pair and axis; a part with no pad binding of its kind keeps
the standard layout — A jumps, D-pad and left stick move). Players rebind
the pad on the game shell's Controls screen (see [The game shell](gameplay.md#the-game-shell-menus-and-hud-as-ui-documents)). Scripts read
`ctx.input.value(name)`, `.vector(name)`, `.pressed(name)`, `.held(name)`,
`.released(name)`; the actions are part of the recorded input, so replays
match. `ctx.input.anyPressed()` answers any key, mouse or pad button that
went down this step, bound to an action or not — `{device, code}` (device
`keyboard`, `mouse` or `gamepad`; code a key's `KeyboardEvent.code` such as
`KeyK`, `left`/`right`/`middle`, or `button0`…`button31` of any standard
pad) or null: a "press any key" prompt. MCP: `setInput {input}` through `tl_command`; `tl_input_exercise`
frames may carry `actions: {name: {v, p}}`.

## Pointer input and 3D queries

The mouse (or pen/touch) is part of the game's input.

**Pointer bindings.** In the **Input** window, **+ pointer** adds what fits
the action: a mouse button (left/right/middle) to a button or 1D axis, the
pointer's movement along x or y (up positive, percent of the view per step)
or the wheel (notches) to a 1D axis, the pointer's **position** (x, y 0–1
from the top left) or **movement** to a 2D axis. Movement and wheel are
amounts per step (a second step in the same frame sees 0). A binding of the
right button keeps the browser's context menu off the view; a wheel binding
keeps the wheel from scrolling the page.

**Cursor.** Each map has a **cursor** setting (free or locked; default free),
the project's own maps included. While a menu is open the ui map's setting
applies. During play, without game modes, the gameplay map's applies; with
modes, the first of the current mode's maps that sets one (ui after the
others). A script may
ask for another with `ctx.input.setCursor('free' | 'locked' | 'auto')`
(`auto` = the map's setting; a new run starts with none). Locked uses the
browser's pointer lock — browsers want a click in the view first, so the
game asks again on the next click — and the pointer then sits at the view's
centre (only its movement counts). The cursor is hidden while locked and
while a gamepad was used last; it shows again when the mouse moves.

**Scripts.** `ctx.input.pointer()` → `{ x, y, dx, dy, wheel, over, entered,
left, locked }` (null before the pointer is first seen);
`pointerPressed/Released/Held(button?)` (default left; a click between two
steps still presses). Pointer samples are part of the step's input, so a
replay (and `tl_input_exercise`, which takes an optional `pointer: { x, y,
dx?, dy?, wheel?, buttons?, pressed?, released?, over?, locked? }` per
frame — masks 1 left, 2 right, 4 middle) reproduces them; a frame without a
pointer keeps the last position and held buttons. Its `actions` are
passed through too.

**3D queries** (physics dimension 3): `ctx.physics.raycast3d(origin,
direction, maxDistance = 100, filter?)` → `{ entityId, point, normal,
distance }` or null; `overlapSphere(center, radius, filter?)`,
`overlapBox3d(center, half, rotation?, filter?)`, `overlapCapsule(center,
radius, height, rotation?, filter?)` → sorted ids (at most 64);
`pickAt(x, y, maxDistance = 1000, filter?)` casts the active camera's ray
through a screen point (the default pose's when no virtual camera is live;
`ctx.camera.screenToRay/worldToScreen` use the same view), `pickAtPointer`
through the pointer (null while it is off the view). A filter is `{ tags?,
layers?, exclude? }`. At most 1,024 queries a step for all scripts together
(then nothing; warned once in the play log). A 3D scene without a player
still has physics when it has colliders (they answer the queries).
Hover edges on objects are the script's own: compare this step's pick with
the last one.
A hit on a block layer names the layer (`entityId`) and carries `cell:
[x, y, z]` (`ctx.grid` coordinates), so `pickAtPointer` picks cells too.

**Collision layers.** **File → Project tags** also lists the project's
collision layers ("default" is implicit; up to 15 more). A collider's
**Collision layers** field lists the layers it is in (absent: "default");
queries see only the layers their filter names. Layers do not change what
collides with the player. A layer a collider still lists cannot be removed.
MCP: `setCollisionLayers {layers}`; collider `{ layers: [...] }`.

**Observing.** `tl_game_observe` (and `__thirdlightObserve()`) report
`pointer: { x, y, buttons, over, locked }`, `cursor: { mode, locked, hidden }`
and `hidden` (the objects scripts hid). Headless browsers may refuse pointer
lock; the `data-tl-pointer-lock` attribute on the game canvas shows whether
the browser granted it.

## Input rebinding and glyphs

- **Players rebind in the built-in settings screen**: every action is listed
  for keys/mouse and for the pad (composites one row per direction); choose
  a row, press the new key or button (Esc cancels, 10 s timeout). An input
  already used by another action of the same map is swapped. "Reset controls
  to defaults" restores the project's bindings. Changes are saved in the
  browser per player profile (`bindings:<profile>` in the game's storage
  namespace) and load at start.
- **Scripts** read `ctx.input.device()` / `usingGamepad()`, `bindings()`,
  `glyph(action)` (label, icon id, the project's image) and ask for
  `ctx.input.rebind(action, { index, part, device, policy: 'swap' | 'refuse' |
  'allow', cancelKey, timeout })`, `cancelRebind()`, `resetBindings(action?)`,
  `useBindingProfile(name)`; outcomes arrive in `rebindEvents()`. A game's own
  rebinding screen is built on these. Replays stay valid: the simulation only
  sees action values and the binding information travels in the recorded input.
- **Hold instead of tap**: a key, pad button or mouse button binding takes a
  `hold` time (seconds) in Project Settings → Input.
- **One pad**: a gamepad binding may name a pad (`pad`, its slot 0–3) — each
  player of a local co-op game on a pad of their own; absent: the pad used last.
- **Glyphs**: the engine has a neutral SVG icon set (key caps, face buttons by
  position, bumpers/triggers, D-pad, sticks, mouse buttons); pad labels follow
  the pad family (Xbox, PlayStation, Switch, generic) detected from the pad.
  Projects replace icons with their own textures in Project Settings → Input's Glyphs
  list (e.g. `xbox:pad-south`, `pad-south`, `key:Space`).
- Observation: Play observe and the export's `window.__thirdlightObserve()`
  report `inputBindings` (device used last, profile, listening, changed
  actions, each action's glyph).
- **Project UI** (UI documents): a button's engine action `rebind` (with
  `input`: the action, optional `device`, `index`, `part`, `policy`),
  `cancelRebind` or `resetBindings`; `{action:jump}` in a text shows the
  action's glyph for the device in use, in a dialogue line too (one
  character of its typewriter reveal); `$flow.input.actions` lists every
  action's key and pad labels for a settings document.
- Limits: 64 actions per project; 8 binding requests per step from scripts.
