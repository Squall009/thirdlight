# A cutscene with a timeline

**Goal:** a short intro each time play begins: the view fades in from
black under letterbox bars while a crate rises, then a signal tells your
scripts the intro is over. **Jump** skips it. Every track and key:
[Timelines](../features/timelines.md) and
[TimelineAsset](../reference/types-o-t.md#type-timeline-asset); the calls:
[`ctx.timeline`](../reference/script-api.md#ctx-timeline).

A timeline has a **duration**, **tracks** of **keys** and **markers**.
Tracks never name objects: they name **slots**, and each play binds the
slots to objects, so one timeline serves any actors. Tracks can cut
cameras, move objects, drive animators, play music and sounds, run
dialogue, start effects, show or hide objects, fire signals, fade, draw
letterbox bars, wait for input, change materials, switch game modes and
environment presets, and walk, place and turn player characters.

## In the editor

1. In the project window, **create ▾ → Timeline**, name it `Intro`;
   double-click opens it in the editor window. Set **Duration** 3 s,
   **Skip action** `jump`, and add a slot `crate` with the 2D starter's
   *Crate* as its default object.
2. Add tracks and keys (**Add key at playhead**; drag keys along the ruler;
   the key inspector edits the selected key):
   - **Fade**: at 0 s opacity 1, colour black; at 1 s opacity 0.
   - **Letterbox**: at 0 s and at 3 s, 0.12.
   - **Transform**, target `crate`: at 0 s its place; at 2.5 s 2 m higher,
     easing *ease in-out*.
   - **Signal**: at 3 s, `intro-done`.
3. Scrub the ruler: the Scene view shows the crate where the timeline puts
   it. Sound, effects, signals and dialogue play only in Play.
4. Play it from a script each time play begins:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export default {
     instantiate() {
       return {};
     },
     step(_state: object, ctx: BehaviorContext): void {
       if (ctx.modes.entered('play')) ctx.timeline.play('intro', { crate: 'box-0004' });
       if (ctx.signals.on('intro-done')) ctx.log('info', 'intro finished');
     },
   };
   ```
   Without modes, tick **Play when a run starts** on the timeline instead,
   or **Play on signal**.
5. **▶ play**.

## Through the API

1. [`setTimeline`](../reference/ops-detail.md#op-setTimeline):
   ```json
   {"timeline": {"timelineId": "intro", "name": "Intro", "duration": 3, "skipAction": "jump",
     "slots": [{"name": "crate", "entity": "box-0004"}],
     "tracks": [
       {"trackId": "fade", "type": "fade", "keys": [{"time": 0, "value": 1, "color": "#000000"}, {"time": 1, "value": 0}]},
       {"trackId": "bars", "type": "letterbox", "keys": [{"time": 0, "value": 0.12}, {"time": 3, "value": 0.12}]},
       {"trackId": "lift", "type": "transform", "target": "crate",
        "keys": [{"time": 0, "position": [-2, 0.5, 0]}, {"time": 2.5, "position": [-2, 2.5, 0], "easing": "easeInOut"}]},
       {"trackId": "done", "type": "signal", "keys": [{"time": 3, "name": "intro-done"}]}]}}
   ```
2. Publish and attach the script ([the script guide](scripts.md#through-the-api)).
3. Play and observe `timeline`: `screen {fade, opacity, letterbox}` and
   `playing [{handle, timeline, time, state}]` while it runs; when it ends
   the list is empty, the fade and bars are cleared, and the play log has
   your `intro finished` line.

## A cutscene that walks a character

**Goal:** in the 3D starter, when the game starts the player walks to a
mark away from the camera with its own controller (its speed, collisions
and walk animation), turns round to face the camera, and the player gets
control back. Every field: [Timelines: Character](../features/timelines.md#timelines-sequencer).

In the editor:

1. Create a timeline `Arrival` (3 s, **Play when a run starts**, **Skip
   action** `jump`) with a slot `hero` whose default object is the
   *Player*.
2. **New track type** *character*, **Add track**, target `hero`.
3. Playhead at 0 s, **Add key at playhead**: a **place** key where the
   player stands (the key takes its place; **Capture the character's
   place** takes it again after you move the player).
4. Playhead at 0.2 s, **Add key at playhead**, **Key mode** *walk*, **Key
   position** `-4, 0.91, -6`, **facing** `0` (degrees about +Y: 0 faces +Z,
   toward the starter's camera, once it arrives).
5. Scrub the ruler: the Scene view slides the player to the mark. Play
   walks it at its own speed; the preview does not.

Through the API, the same timeline
([`setTimeline`](../reference/ops-detail.md#op-setTimeline); `model-000001`
is the 3D starter's player, read yours with `tl_inspect`):

```json
{"timeline": {"timelineId": "arrival", "name": "Arrival", "duration": 3, "skipAction": "jump", "playOnStart": true,
  "slots": [{"name": "hero", "entity": "model-000001"}],
  "tracks": [
    {"trackId": "walk-in", "type": "character", "target": "hero",
     "keys": [{"time": 0, "mode": "place", "position": [0, 0.91, 0], "facing": 180},
              {"time": 0.2, "mode": "walk", "position": [-4, 0.91, -6], "facing": 0}]}]}}
```

Play it and observe `player` with `tl_game_observe`: the player walks,
stops within 0.1 m of the mark and turns. The player's own input does not
move it from the timeline's start to its end, and on until a walk still
under way has arrived (the track's **input** box, `playerInput: true`, lets
the player move it meanwhile). A
key `{"time": 1, "enabled": false}` switches the controller off (no input,
no gravity) and `{"enabled": true}` on again.

From a script, the same walk without a timeline: a director that sends the
player to a door and loads the next level once it is there.
[`ctx.character`](../reference/script-api.md#ctx-character) takes the
player's object last and defaults to the first player:

```ts
import type { BehaviorContext } from '@thirdlight/runtime';

const DOOR: [number, number, number] = [-4, 0.91, -6];

interface State { walk: number }

export default {
  instantiate(): State {
    return { walk: 0 };
  },
  step(state: State, ctx: BehaviorContext): void {
    if (ctx.phase !== 'intent') return;
    if (state.walk === 0) {
      if (ctx.signals.on('door-open')) state.walk = ctx.character.walkTo(DOOR, { facing: 0 });
      return;
    }
    const walk = ctx.character.walkState(state.walk);
    if (walk === 'walking') return;
    // Blocked (something stood in the way for a second): put it on the mark.
    if (walk === 'blocked') ctx.character.place(DOOR, 0);
    state.walk = 0;
    if (walk === 'arrived' || walk === 'blocked') ctx.scenes.load('level-2', { unload: ['level-1'] });
  },
};
```

## Which to use

Author timelines in the editor: the ruler, scrubbing and the Scene view
preview are how you judge timing. Use `setTimeline` to generate simple
sequences from data. Play them from scripts, which know when the moment
has come.

## Pitfalls

- **Slots, not objects.** A track's `target` is a slot name; bind the slot
  in the play call or give it a default object.
- **The bars are black.** Over a dark sky letterbox bars do not show; the
  `timeline.screen.letterbox` observation does.
- **Skip applies the end states** (the last camera, transforms, fades,
  remaining signals unless a key says drop); waits pass, pending dialogue
  does not run, stingers and sounds do not play.
- **Fade and letterbox clear at the end** unless the track has **hold**.
- **Signals are seen one step later** (`ctx.signals.on`).
- **8 timelines play at once**; a ninth `play` returns 0.
- **A character key reaches the character one step later.** Keys fire at
  the end of a step, so the character places, walks or turns in the next
  step. A cutscene's or script's walk has the last word over a script's
  own move of that character in the same step.
- **Walk a character with a Character track, not a Transform track.** A
  transform key teleports the body every step; a walk uses the
  controller, so the character collides, climbs slopes and animates.
- **A walk can be blocked.** One that gets no closer for a second ends
  where it is, with a log line (`walkState` says `blocked`); a walk still
  under way when the timeline ends carries on to its mark.
- **Skip lands walks on their marks; stop leaves the character where it
  is,** gives the player's input back and switches the character back on
  (or off) as it was before the track switched it.
- **On a plane** a walk goes along the plane (the mark's y is where the
  ground is), under the arcade profile `run` changes nothing (it has one
  speed), and on a Z plane a facing of 90 faces right, −90 left.

Related: [cameras](cameras.md), [dialogue](dialogue.md),
[game modes](game-modes.md).
