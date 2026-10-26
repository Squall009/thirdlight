# Timelines

Timelines sequence a cutscene or scripted event on a time ruler. Step by
step: [the timeline guide](../guides/timelines.md).

## Timelines (sequencer)

A **timeline** is project content (the project window: Create →
**Timeline**, double-click to open, delete from the Inspector; one undo step each) that sequences what a cutscene or a
scripted event does on a time ruler. It has a **duration**, **tracks** of
**keys** (a key with a duration is a clip) and **markers**. Tracks never name
objects: they name **slots**, and a play binds the slots to objects (each slot
may have a default object — used by the editor preview and when a play binds
nothing), so one timeline serves any actors.

**Track types** (the key fields in brackets):

- **Camera** — a key makes a virtual camera live from its time until the next
  key, over the game's priorities [camera slot or release, blend cut / linear
  / eased and blend time, rail progress from→to over the key's span]. At the
  end the track **releases** the view to the game's cameras (with its end
  blend) or **keeps** the last camera enabled.
- **Transform** — the target's position, rotation, scale, each channel eased
  between keys (from its first key on). A 3D character's body moves with it
  (a teleport each step: use a Character track to walk it); on a player
  character a rotation key turns its controller too, and on a plane a
  position key places it.
- **Character** — a player character (an object with a Character
  controller, free or on a plane): **place** it at a position from rest,
  **walk** it there with its own controller (its speed, acceleration,
  collisions, slopes and animator speed, as with the player's input; **run**
  at the run speed; it slows down near the mark and arrives within 0.1 m),
  **facing** (degrees about +Y, 0 faces +Z, 90 faces +X: where it faces once
  placed or arrived, or a turn now), **enabled** off / on (its controller: no input, no gravity). While
  the track plays the player's input (its climb input too) does not move
  the character, from the play's start to its end (the track's **input**
  box lets it). A turn on arrival gives way to the player's input once
  nothing holds the character. At the end a
  walk still under way carries on to its mark (the input stays held until
  it arrives); a walk that gets no closer for a second is blocked and ends
  there (a log line). A key reaches the character in the step after it
  fires (keys fire at the end of a step), and then has the last word over
  a script's own move of that character in that step. On a plane a
  walk goes along the plane (the mark's y is where the ground is), and
  under the arcade profile **run** changes nothing (it has one speed). Scripts do the same
  with [`ctx.character`](gameplay.md#scene-transitions-impulses-facing-camera-tracking-looks-and-event-sounds).
- **Animator** — set a parameter, fire a trigger, or go to a state (with a
  crossfade) on the target's animator.
- **Audio** — music change (crossfade; no asset: silence), give the music back,
  a stinger, an SFX (optional loop, length, position of a
  bound object). The track can give the music back when the timeline ends.
- **Dialogue** — run a dialogue node and wait for it (see [Dialogue](dialogue.md)).
- **Effect** — start a visual effect (at a bound object or a position, with
  parameters; a length stops it).
- **Activation** — show or hide the target.
- **Signal** — fire a signal (scripts see it one step later with
  `ctx.signals.on`; effects and movers start on it). **On skip** fire (the
  default) or drop.
- **Fade** — a full-screen colour over the view (opacity 0–1); **Letterbox** —
  black bars (each a share of the view height; the larger of the timeline's
  and the camera's is drawn). Both are cleared at the end unless **hold**.
- **Wait for input** — the timeline stops at the key until the input action
  is pressed (optional timeout).
- **Material** — a public graph-material parameter of the target (number,
  vector or colour, eased).
- **Material swap** — from the key on, the target's slots wear other
  project materials (`materials: { slot: materialId | null }`, `null` the
  authored one), as `set('materials', …)`; the material ships because the
  key names it, and shows once it has loaded. Skip applies the remaining
  keys in order.
- **Game mode** — switch the game mode (as `ctx.modes.switch`, with an optional camera blend); skip applies the last remaining mode key.
- **Environment** — switch to an environment preset (see [Environment presets](environment.md)).

Easing (linear, step, ease in, ease out, ease in-out) shapes the move from the
previous key to the key.

**Playing.** `ctx.timeline.play(id, { slot: entityId })` returns a handle (0
when refused: no such timeline, or 8 already playing); `pause`, `resume`,
`stop` (where it is, no end states; the sounds and effects it started stop),
`skip` (see below), `seek(handle, seconds)` (continuous tracks and cameras at
that time; keys in between do not fire), `state` (playing, paused, waiting,
ended), `time`, `isPlaying(id)`, `events()` (started, ended with reason
finished / skipped / stopped, marker — seen in the next step), `ended(handle)`
and `marker(name)`. A timeline can also play when a run starts (**Play when a
run starts**) or when a signal fires (**Play on signal**). Its **skip action**
(an input action) skips it while it plays.

**Skip** applies each track's end state at once: the last camera (cut), the
transforms, material values, fade and letterbox at the end, the remaining
animator parameter sets and state changes (triggers are dropped), the
remaining music changes (the music owner and track end as if played; stingers
and SFX are not played, the sounds it started stop), the remaining activation
keys, the remaining signals (unless a key says drop), the remaining character
keys (a walk becomes a placement on its mark, a walk under way lands there,
turns are at once); waits pass, pending dialogue does not run; markers after
the skip point are not reported. A stop leaves a character where it is,
gives it the player's input back and switches it on or off as it was before
the track first switched it (unless another timeline still playing has
switched it since). A timeline played on a character whose scene is still
loading waits for it; a loaded save ends every walk.

**Determinism.** Timelines run in the simulation step (after the scripts,
before the camera brain): time counts in fixed steps, a wait key reads the
step's input frame, and every change goes through the same channels scripts
use — so the simulation worker, the export and replays (skip and waits
included) give the same result.

**Editor.** Open a timeline in the editor window (it plays on its scene in the preview pane): the timeline's fields and
slots at the top, the track list beside the time ruler (zoom slider), keys
dragged along the ruler (one command per drag), a key inspector for the
selected key, **Add key at playhead**. Clicking or dragging the ruler scrubs:
the Scene view stays visible above the timeline and shows the bound objects
where the timeline puts them and the live camera's frustum at that time;
animator tracks show the state their keys lead to; a character track shows
the character on its keys' marks (a walk slides it there by the next key;
Play walks it at its own speed); sound, effects, signals and dialogue play in
Play only. A character key starts where the character stands (**Capture the
character's place** takes it again); a transform track on a character says
to use a Character track.

**Observing.** `tl_game_observe` / `window.__thirdlightObserve()` report
`timeline: { screen: { fade, opacity, letterbox }, playing: [{ handle,
timeline, time, state, wait }], events }` once a timeline played; the fade
element carries `data-tl-fade`.

**Engine limits.** 32 tracks, 256 keys per track, 16 slots, 64 markers,
600 s and 48 KiB of JSON per timeline (a timeline is saved in one 64 KiB
command), 8 playing at once; as many timelines as the project needs.
