# Scripts and the step model

Your game's rules live in **scripts**: what a collected item is worth, when
a door opens, how an enemy chooses where to go, when a level is won. The
engine gives the building blocks (physics, input, triggers, health,
cameras, UI, saves); scripts decide what they mean.

## What a script is

A script (a *behavior* in the API) is TypeScript. Its entry file,
`src/index.ts`, default-exports an object with a `step(state, ctx)` function
and, if you like, callbacks such as `onEnable`, `onTriggerEnter`,
`onMessage` or `onUiEvent`. It may declare properties (numbers, switches,
text, choices, vectors, object and asset references) that each object
carrying it sets in the Inspector.

```ts
export default {
  step(state, ctx) {
    if (ctx.input.pressed('interact')) ctx.log('info', 'interact pressed');
  },
};
```

A script runs on every object that has a **Script** component naming it.
Scripts share code through **script libraries** (`import { f } from
'@lib/<id>'`). A **visual script** is a node graph that compiles to the
same kind of script.

Scripts are listed in **File → Project Settings… → Scripts** (**+ New
behavior**, **+ Visual script**) and edited in their own tab. **Publish**
compiles the source with the backend's pinned compiler and stores it as one
command. Each new source is acknowledged once before it is published:
scripts are trusted code with full access to the page they run in, not
sandboxed.
API: [`publishBehavior`](../reference/ops-detail.md#op-publishBehavior),
[`acknowledgeBehaviorTrust`](../reference/ops-detail.md#op-acknowledgeBehaviorTrust).

What a script can call is in the reference:
[the script API](../reference/script-api.md#script-spec) and
[the context `ctx`](../reference/script-api.md#ctx).

## The step

The game runs in **fixed steps**: 120 per second by default (the project
setting `fixed_step_hz`: 60, 120 or 240). Drawing happens at the display's
rate, blending each object between its last two steps.

In each step every script runs, in phases: first `intent`, then
`transform` for scripts that own the transforms of some objects.

- **Reading.** A script reads the world as it stands this step:
  [`ctx.world`](../reference/script-api.md#ctx-world) for positions,
  [`ctx.input`](../reference/script-api.md#ctx-input) for the input
  actions, [`ctx.physics`](../reference/script-api.md#ctx-physics) for rays
  and overlaps, and its own `state`.
- **Intents.** A script does not write the world directly. It commits
  **intents** with [`ctx.emit`](../reference/script-api.md#ctx-emit): move
  the player, jump, place an object it owns, respawn. The runtime checks
  each intent. A refused one (a bad value, the wrong phase, an object the
  script does not own, a second write of the same thing in one step)
  returns `false`, is logged once, and the game goes on.
- **Next step.** Most requests take effect at the next step boundary: a
  spawned prefab copy appears, a scene loads or unloads, a destroyed copy
  goes. Signals and messages are seen one step after they are sent.

## Determinism and replays

The same start and the same input give the same game, step for step. The
engine keeps this true, and your scripts must too:

- Input is sampled once per drawn frame and handed to the steps; scripts
  read named actions, never the keyboard.
- Random numbers come from [`ctx.random`](../reference/script-api.md#ctx-random),
  seeded from the project's `random_seed` setting, the script and the
  object. Never use `Math.random()` or the clock.
- Timers ([`ctx.timers`](../reference/script-api.md#ctx-timers)) count
  steps, not milliseconds.
- Sound and visual effects are presentation only; the simulation never
  reads them back. Asset loads never make a step wait: the answer arrives
  on a later step, the same one in a replay.

So a run can be **replayed**: restart it and feed the same input, and every
step comes out the same. Play-testing tools use this. They restart the run
(`tl_game_control` `replay`), drive the same input, and compare the run
digest in the game's observation (`run.digest`). Debug commands typed in
the in-game console travel with the input, so a replay repeats them too.

## The simulation worker

In Play and in an exported game the simulation (physics, gameplay and your
scripts) runs in a **worker**, a thread of its own. The page keeps input,
sound, the HUD and menus, saves and drawing. Each frame the page draws the
newest step the worker finished, so the picture is one frame behind the
simulation (about 17 ms at 60 frames per second). A slow script step then
never delays a frame.

Results are identical in the worker and on the page's main thread. The
project setting `sim_thread` (or `?threads=off` on the page's address)
runs the simulation on the main thread instead.

A full walk-through: [write a script and a shared library](../guides/scripts.md).
