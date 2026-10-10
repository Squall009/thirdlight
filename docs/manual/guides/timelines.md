# A cutscene with a timeline

**Goal:** a short intro each time play begins: the view fades in from
black under letterbox bars while a crate rises, then a signal tells your
scripts the intro is over. **Jump** skips it. Every track and key:
[Timelines](../features/timelines.md) and
[TimelineAsset](../reference/types-p-u.md#type-timeline-asset); the calls:
[`ctx.timeline`](../reference/script-api.md#ctx-timeline).

A timeline has a **duration**, **tracks** of **keys** and **markers**.
Tracks never name objects: they name **slots**, and each play binds the
slots to objects, so one timeline serves any actors. Tracks can cut
cameras, move objects, drive animators, play music and sounds, run
dialogue, start effects, show or hide objects, fire signals, fade, draw
letterbox bars, wait for input, change materials, switch game modes and
environment presets.

## In the editor

1. In the project window, **create ▾ → Timeline**, name it `Intro`;
   double-click opens it in the editor window. Set **Duration** 3 s,
   **Skip action** `jump`, and add a slot `crate` with the Starter's
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

Related: [cameras](cameras.md), [dialogue](dialogue.md),
[game modes](game-modes.md).
