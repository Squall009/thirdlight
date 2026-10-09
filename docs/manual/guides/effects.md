# Effects

**Goal:** a looping shower of sparks on an object, made as a particle graph,
then played from a script where something happens. Every block, executor
and cap: [Visual effects](../features/effects.md); every node:
[Particle system nodes](../reference/graph-effect.md).

An effect is one or more **particle systems**. Each system's graph has four
fixed **context** nodes — Spawn, Initialize, Update, Output — and each
context runs a **chain** of blocks wired `then` → `in` in order. Effects are
visual only: the game simulation never reads them back.

## In the editor

1. In the project window, **create ▾ → Effect**, name it `Sparks`. It opens
   as an **Effect** tab; the preview plays it in a loop.
2. Pick a system tab (**+ System** adds one). In its graph:
   - Spawn chain: **Constant rate**, 60 per second.
   - Initialize chain: **Sphere** (radius 0.15), **Velocity** (min
     −1.2, 2.5, −1.2; max 1.2, 4.5, 1.2), **Lifetime** 0.6–1.2 s,
     **Size** 0.06–0.12 m, **Colour** orange.
   - Update chain: **Gravity**, then **Collide with plane** so sparks bounce
     on the floor.
   - Output chain: **Billboard**, blending **additive**.
   Drag a new block's `in` from the previous block's `then`; a block off
   every chain does nothing (the problems list says so).
3. Watch the preview's counters (spawned, living) and frame cost; scrub its
   timeline to check one moment.
4. Select an object, **+ Add component → Effect**, pick `Sparks`. **Play
   on start** is on; **Play on signal** / **Stop on signal** wait for a
   signal instead. **Gizmos → Play selected effects** plays it in the Scene
   view.
5. **▶ play**.

## Through the API

1. The effect ([`setEffect`](../reference/ops-detail.md#op-setEffect),
   [`EffectDef`](../reference/types-d-p.md#type-effect-def)) — one node of
   each context type, here with the type as its id:
   ```json
   {"effect": {"effectId": "sparks", "name": "Sparks", "duration": 2, "loop": true, "seed": 1,
    "bounds": {"center": [0, 1, 0], "size": [4, 4, 4]},
    "systems": [{"systemId": "main", "name": "Sparks", "maxParticles": 1000, "space": "world", "graph": {
      "nodes": [
        {"id": "spawn", "type": "spawn", "position": [0, 0]},
        {"id": "initialize", "type": "initialize", "position": [0, 200]},
        {"id": "update", "type": "update", "position": [0, 400]},
        {"id": "output", "type": "output", "position": [0, 600]},
        {"id": "rate", "type": "spawn.rate", "position": [200, 0], "data": {"rate": 60}},
        {"id": "pos", "type": "init.position.sphere", "position": [200, 200], "data": {"radius": 0.15}},
        {"id": "vel", "type": "init.velocity", "position": [400, 200], "data": {"min": [-1.2, 2.5, -1.2], "max": [1.2, 4.5, 1.2]}},
        {"id": "life", "type": "init.lifetime", "position": [600, 200], "data": {"min": 0.6, "max": 1.2}},
        {"id": "size", "type": "init.size", "position": [800, 200], "data": {"min": 0.06, "max": 0.12}},
        {"id": "col", "type": "init.color", "position": [1000, 200], "data": {"color": "#ffb030"}},
        {"id": "grav", "type": "update.gravity", "position": [200, 400]},
        {"id": "bb", "type": "output.billboard", "position": [200, 600], "data": {"blend": "additive"}}],
      "edges": [
        {"id": "e0", "from": {"node": "spawn", "port": "then"}, "to": {"node": "rate", "port": "in"}},
        {"id": "e1", "from": {"node": "initialize", "port": "then"}, "to": {"node": "pos", "port": "in"}},
        {"id": "e2", "from": {"node": "pos", "port": "then"}, "to": {"node": "vel", "port": "in"}},
        {"id": "e3", "from": {"node": "vel", "port": "then"}, "to": {"node": "life", "port": "in"}},
        {"id": "e4", "from": {"node": "life", "port": "then"}, "to": {"node": "size", "port": "in"}},
        {"id": "e5", "from": {"node": "size", "port": "then"}, "to": {"node": "col", "port": "in"}},
        {"id": "e6", "from": {"node": "update", "port": "then"}, "to": {"node": "grav", "port": "in"}},
        {"id": "e7", "from": {"node": "output", "port": "then"}, "to": {"node": "bb", "port": "in"}}]}}]}}
   ```
   Later edits of one system: [`graphEdit`](../reference/ops-detail.md#op-graphEdit)
   `{"owner": {"kind": "effect", "id": "sparks/main"}, "ops": [...]}`.
2. Play it on an object ([`effect`](../reference/components-rendering.md#component-effect)):
   `setComponent {"entityId": "<object>", "component": "effect", "value": {"effectId": "sparks"}}`.
3. Play and read the diagnostics' `renderer.effects`: the executor
   (`webgpu` or `cpu`), what plays, the particle count and `problems` (a
   block off its chain, a missing renderer). A screenshot shows the sparks.
4. From a script ([`ctx.effects`](../reference/script-api.md#ctx-effects)):
   `const h = ctx.effects.play('sparks', { entityId: ctx.entityId })`, and
   `ctx.effects.stop(h)` ends spawning.

## Which to use

Shape effects in the editor: the preview, its scrubbing and its counters
are how you judge a look and its cost. Use the API to copy an effect with
other parameters, or to generate variants. Play effects from components
when they belong to an object, and from scripts when a game event decides.

## Pitfalls

- **Particles pass through the floor** unless the Update chain has **Collide
  with plane** (or, on WebGPU only, **Collide with scene**).
- **The chain is the order.** A block that is not wired into its context's
  chain does nothing; the effect still plays and lists it in `problems`.
- **The two executors have different caps:** WebGPU 262,144 particles per
  system, the CPU fallback (WebGL 2, and some blocks on WebGPU) 4,096. A
  system's max particles is cut to its executor's cap.
- **Lit sparks cost lights.** A **Lights** block uses the shared pool of 16
  point lights; past 16 lit particles the rest give no light.
- **Effects never change the game.** Do not use them for gameplay; a replay
  does not depend on them.
- **An effect an object plays cannot be deleted** until the Effect
  component that names it is changed or removed.

Related: [material graphs](material-graphs.md) (a billboard may use a
project material), [scripts](scripts.md).
