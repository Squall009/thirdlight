# Game modes

**Goal:** two states of the running game — **Explore** (the character
walks, the HUD shows) and **Map** (the world holds still, a map document
shows, an overhead camera is live) — switched with one key and back,
without loading anything. Every setting:
[Game modes](../features/game-modes.md) and the
[modes reference](../reference/content-blocks-animators.md#content-modes).

A mode sets, together: the active **input maps**, a **camera** that is live
while it is, the **UI documents** shown, the **behavior groups** whose
scripts run, whether the pause is allowed (and its screen), the **time
scale** and whether **physics** runs or holds. The first mode is the one a
run starts in. A switch happens in one step and replays exactly.

## In the editor

1. Make the documents (`HUD`, `Map`) in the project window
   (**create ▾ → UI document**) and an overhead camera (**GameObject →
   Cameras → Camera**, rig *Fixed / look-at*, high above the level).
2. **File → Project Settings… → Game modes → add mode**:
   - `explore`: UI documents *HUD*.
   - `map`: UI documents *Map*; Camera *the overhead camera*; Physics
     *Hold*; Pause allowed off; under **Transition** a camera blend
     *eased* over 0.5 s.
   Order matters: the first mode is the start mode (↑ ↓ to move one).
3. An input action for the switch: **Project Settings → Input**, add an
   action `map` (button) with **+ key** M (see [the input guide](input.md)).
4. A script on a kept object switches:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export default {
     instantiate() {
       return {};
     },
     step(_state: object, ctx: BehaviorContext): void {
       if (!ctx.input.pressed('map')) return;
       ctx.modes.switch(ctx.modes.is('map') ? 'explore' : 'map');
     },
   };
   ```
   A UI button can switch too: its action `{do: "mode", mode: "explore"}`.
5. **▶ play**; M shows the map and the overhead shot, M again goes back.
   The Play toolbar shows the current mode; **Play from…** can start in
   any mode.

## Through the API

1. [`setModes`](../reference/ops-detail.md#op-setModes):
   `{"modes": [{"modeId": "explore", "name": "Explore", "ui": ["hud"]}, {"modeId": "map", "name": "Map", "ui": ["map"], "camera": "<overhead camera>", "physics": "hold", "pause": false, "enter": {"blend": "eased", "blendTime": 0.5}}]}`.
2. Behavior groups, when some scripts should pause in a mode:
   [`setBehaviorGroups`](../reference/ops-detail.md#op-setBehaviorGroups)
   `{"groups": ["world"]}`, a `behaviorGroup` component `{"group": "world"}` on those objects
   and `"groups": ["world"]` on the modes that run them.
3. Publish and attach the script as in [the script guide](scripts.md#through-the-api).
4. Play (`tl_play_start {mode: "map"}` starts in a mode) and observe:
   `mode {current, previous, physics, …}` and `ui.shown`. Send the action
   as test input, `{"stepOffset": 0, "actions": {"map": {"v": 1, "p": "pressed"}}}`,
   and observe again.

## Which to use

Define modes in the editor (the form shows every setting) or with
`setModes` when you generate them. Switch from scripts, which know the
game's state, or from a menu button's mode action.

## Pitfalls

- **Scripts without a behavior group tick in every mode** (Ungrouped
  behaviors: *Tick*). That is what lets one director switch modes; set
  *Pause* on a mode that must stop them.
- **Physics *Hold* holds the character, movers and triggers**, not the
  scripts.
- **Actions of maps a mode does not list read as released.** A mode that
  lists only `ui` stops the character.
- **A mode's camera wins over priorities only while the mode is.** Back in
  a mode without a camera, the priority rule picks the live camera again.
- **A mode is not a scene.** Nothing loads or unloads; use
  [`ctx.scenes`](game-flow.md) for that.

Related: [title, new game, restart and scene changes](game-flow.md),
[cameras](cameras.md).
