# Title, new game, restart and scene changes

**Goal:** a title screen with **New game**, a level in its own scene, and
a pause menu with **Restart level** and **Quit to title** — all built by
your game, with no engine restart. Why the engine leaves this to you:
[Game flow belongs to your game](../concepts/game-flow.md). Everything
about scenes and kept objects:
[Scenes and cameras](../features/scenes-and-cameras.md).

The pieces:

- The **Main** scene (a start scene) holds what lives for the whole game:
  the player, the camera and a **Director** object, all **Keep loaded**.
- **Level 1** is its own scene. The game loads, reloads and unloads it.
- Two [game modes](game-modes.md): **Title** (shows the title document,
  physics held) and **Play** (shows the HUD).
- A **director** script answers the buttons' UI events.

## In the editor

1. **The level.** In the Hierarchy, **+ Scene**, name it `Level 1`. Click
   its header to make it active, and build the level there (for example a
   box with a **Collectible** that adds to the counter `items`). Leave the
   ★ (start set) on **Main** only.
2. **The director.** Click the **Main** header, **GameObject → Create
   empty**, name it `Director`, and tick **Keep loaded** in the Inspector.
   The Starter's player and camera are kept already (the Hierarchy marks
   them **K**).
3. **The documents.** In the project window, **create ▾ → UI document**
   three times: `Title` (a full-screen panel with a **New game** button),
   `HUD` (a text `Items {$flow.counters.items}`) and `Pause` (buttons
   **Resume**, **Restart level**, **Quit to title**). Give each button its
   **On click** action:
   - New game: event `new-game`.
   - Resume: engine action `resume`.
   - Restart level: event `restart-level`, then engine action `resume`.
   - Quit to title: event `quit-to-title`, then engine action `resume`.

   Set **Modal** and **First focus** on Title and Pause, so the keyboard
   and pad reach their buttons. See [the UI documents guide](ui-documents.md).
4. **The modes.** **File → Project Settings… → Game modes**: **add mode**
   `title` (UI documents: Title; Physics: Hold; Pause allowed off), then
   `play` (UI documents: HUD). The first mode is the start mode.
5. **The pause screen.** **Project Settings → Game shell**: **add game
   shell** (the Starter has none), **+ add** under **Screens**, then
   **Pause**: `Pause`. Leave **Title** at *none* (the title is a mode here).
6. **The director script.** **Project Settings → Scripts → + New behavior**
   `director`, then in its Script tab:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   const LEVEL = 'level-1';

   export default {
     instantiate() {
       return {};
     },
     step(_state: object, ctx: BehaviorContext): void {
       if (ctx.ui.event('new-game')) {
         // A new run, built by the game: reset what it keeps, load the level, place the player, play.
         ctx.game.add('items', -ctx.game.counter('items'));
         if (ctx.scenes.status(LEVEL) === 'unloaded') ctx.scenes.load(LEVEL);
         else ctx.scenes.reload(LEVEL);
         ctx.lifecycle.respawn();
         ctx.modes.switch('play');
       }
       if (ctx.ui.event('restart-level')) {
         // The scene as authored, plus what the game resets itself.
         ctx.scenes.reload(LEVEL);
         ctx.game.add('items', -ctx.game.counter('items'));
         ctx.lifecycle.respawn();
       }
       if (ctx.ui.event('quit-to-title')) {
         ctx.scenes.unload(LEVEL);
         ctx.modes.switch('title');
       }
     },
   };
   ```
   Use the scene id the Hierarchy shows for your level. **Publish**, then
   select **Director**, **+ Add component → Script** and pick `director`.
7. **▶ play.** The title shows; Enter starts the level with the HUD; Esc
   opens the pause menu.

## Through the API

1. The level ([`createScene`](../reference/ops-detail.md#op-createScene)):
   `{"name": "Level 1", "sceneId": "level-1"}`, then its objects with
   [`createEntity`](../reference/ops-detail.md#op-createEntity) and
   `"sceneId": "level-1"`, for example
   `{"sceneId": "level-1", "kind": "box", "name": "Item", "transform": {"position": [1.8, 0.91, 0]}, "box": {"size": [0.4, 0.4, 0.4]}, "components": {"collectible": {"counter": "items"}}}`.
   The answer names the new object in `createdId`.
2. The director: `{"sceneId": "scene-main", "kind": "group", "name": "Director", "keepLoaded": true}`
   (or [`updateEntity`](../reference/ops-detail.md#op-updateEntity)
   `{"entityId": "…", "keepLoaded": true}` on an existing object).
3. The documents ([`setUiDocument`](../reference/ops-detail.md#op-setUiDocument)),
   for example the title:
   ```json
   {"document": {"uiDocumentId": "title", "name": "Title", "modal": true, "initialFocus": "new-game",
     "root": {"type": "panel", "anchor": [0, 0], "pivot": [0, 0], "stretch": "both", "css": {"background": "#1d3557"},
       "children": [{"type": "button", "id": "new-game", "anchor": [0.5, 0.7], "pivot": [0.5, 0.5], "size": [220, 56],
         "text": "New game", "onClick": {"do": "event", "name": "new-game"}}]}}}
   ```
   A button with two actions takes a list:
   `"onClick": [{"do": "event", "name": "restart-level"}, {"do": "engine", "action": "resume"}]`.
4. The modes ([`setModes`](../reference/ops-detail.md#op-setModes)):
   `{"modes": [{"modeId": "title", "name": "Title", "ui": ["title"], "physics": "hold", "pause": false}, {"modeId": "play", "name": "Play", "ui": ["hud"]}]}`,
   and the pause screen ([`setShell`](../reference/ops-detail.md#op-setShell)):
   `{"shell": {"screens": {"pause": "pause"}}}`.
5. Publish the script ([the script guide](scripts.md#through-the-api)) and
   attach it with [`setBehaviorProperties`](../reference/ops-detail.md#op-setBehaviorProperties)
   `{"entityId": "<director>", "behaviorId": "director", "values": {}}`.
6. Play and check each step with `tl_input_exercise` and `tl_game_observe`:
   a frame `{"stepOffset": 0, "ui": ["submit"]}` presses the focused
   button. After New game, `mode.current` is `play` and `scenes.loaded`
   lists `level-1`; after collecting, `counters.items` is 1 and the item's
   id is in `hidden`; after Restart level the item is back and the counter
   0; after Quit to title `level-1` is gone and the mode is `title`. The
   run id (`runId`, `…#0`) never changes: nothing restarted.

## Which to use

Build the scenes and documents in the editor, where you see them. The
director is code either way. Use the API to set up many levels the same
way, and to check the flow in a play-test (the
[headless runner](playtesting.md) plays it start to finish).

## Pitfalls

- **One script per object.** An object has one Script component; adding
  another script replaces it. Put each script on its own kept object.
- **`reloadScene` does not move a kept player.** It puts the scene back as
  authored, but the kept player stays where it is (unless the scene is in
  the shell's scene list: then it arrives at that entry's spawn). Respawn
  it yourself, as the director does.
- **`reloadScene` leaves a menu open.** The engine action changes nothing
  on screen; list `resume` after it on a pause-menu button.
- **The shell's Title screen is for the first start only.** The `open`
  engine action with the title screen, `quitToTitle` and `newGame` restart
  the whole run (deprecated, one Problems line each; see the
  [migration notes](../features/migration.md#the-run-restart-and-the-engines-new-game-deprecated)).
  Show your title as a mode or a UI document instead.
- **Under a paused shell screen nothing steps.** A UI event raised from the
  shell's title or pause screen reaches scripts only once the game runs:
  add `resume`, or set the screen's **While shown** to *Scripts run*.
- **Counters and `ctx.save` survive a reload.** Reset what your game keeps
  itself.
- **The player cannot leave with its scene unless it is not kept.** Keep the
  player in a start scene and keep it loaded.

Related: [game modes](game-modes.md), [saves](saves.md),
[UI documents](ui-documents.md).
