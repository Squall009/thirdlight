# Visual effects

Particle effects authored as node graphs: the effect tab, systems and
their blocks, the preview, playing effects on objects and from scripts, the
two executors and their caps, diagnostics. Step by step:
[the effects guide](../guides/effects.md). Every node:
[Particle system](../reference/graph-effect.md).

## The effect tab

Effects are particle systems authored as node graphs,
run by a WebGPU compute executor or a CPU fallback on WebGL 2 and
previewed in their tab. They are **visual only**: nothing in an
effect changes the game simulation, so recorded replays never depend on
them.

The project window's Create → **Effect**, named in place, makes one; it
opens in the editor window as an **Effect: <name>** tab (double-click it in
the project window to reopen it; rename it in the editor's header, delete it
from the Inspector — an effect an object still plays cannot be deleted). In
the tab:

- **Effect settings** (left): the cycle **duration** (bursts and the effect
  time refer to it), **loop** (off: spawning stops after one cycle and the
  effect ends when its particles are gone), the random **seed** (the same
  seed gives the same particles), and the culling **bounds** (a box around
  the origin). New effects: 2 s, looping, seed 1, a 4 m box 1 m above the
  origin.
- **Systems**: **+ System** adds a particle system (up to 16; they run in
  list order). Each has a name, **max particles** (its capacity, default
  1000; an executor may cap lower) and its **space** (local: the particles
  move with the object; world: they stay where they were born). The system
  tabs choose which graph is shown.
- **Exposed parameters**: float, vec3 or colour values the graphs read with
  **Parameter** nodes; public ones can be overridden per object (below),
  private ones are the effect's own.
- **The graph** of the shown system (the [graph editor](editor.md#graph-editing), with the effect
  catalogue). Every system has four fixed **context** nodes — **Spawn**,
  **Initialize**, **Update**, **Output** — and each runs a **chain**: wire
  the context's `then` to a block's `in`, that block's `then` to the next
  block's `in`, and so on; the chain order is the execution order. A chain
  only takes blocks of its context (a force cannot go into Initialize, a
  renderer only into Output); a block off every chain does nothing.
  - *Spawn*: Constant rate (per second, fractions carry over), Burst (count
    at a time of the cycle, repeated `cycles` times every `interval`
    seconds; 0 cycles = forever), Over distance (per metre the object
    moves), From event (particles born where another system's particles die,
    are born or collide; they may inherit its velocity and colour).
  - *Initialize*: positions (Point, Sphere, Box, Circle, Cone, Line, Mesh
    surface of a model asset — a shape also sets the direction that
    **Velocity from direction** uses), Velocity, Lifetime, Size, Colour,
    Colour from gradient, Rotation (angle and spin), Mass.
  - *Update*: Gravity (−9.81 m/s² by default), Drag, Wind (follows
    Environment → Wind and its gusts), Vortex, Turbulence (curl noise),
    Attractor; Collide with plane (bounce, friction, lifetime loss, kill),
    Collide with scene (depth buffer — **honoured only on WebGPU**, the CPU
    fallback ignores it); Size over life (a curve), Colour over life (a
    gradient), Speed limit over life (a curve); kills (behind a plane,
    inside/outside a sphere or box, when slower than a speed).
  - *Output*: Billboard (facing the camera, along the velocity or around a
    fixed axis; texture, flipbook over the life or at a frame rate,
    blending alpha/additive/premultiplied/multiply/opaque, soft particles,
    unlit/lit or a project material), Mesh particles (a model asset),
    Ribbon/trail (a strip through each particle's recent positions, or one
    ribbon joining the particles in birth order), Lights (a point light on
    up to 16 of the oldest particles).
  - Every number, vector and colour field of a block is also an input of
    the same name: a wire from a value node replaces the field — Float,
    Vector, Colour, Parameter, Random (fixed per particle), Random vector,
    Curve and Gradient (read at the particle's normalized age, the effect
    time or a random position), Particle attribute (position, velocity, age,
    size, colour, …), Effect time, and maths (add, subtract, multiply,
    divide, min, max, lerp, one minus, sine, length, normalize, combine,
    split). A float feeds a vector or a grey colour; a vector and a colour
    convert both ways.
- **Curves and gradients** are edited in the Inspector: a curve shows a plot
  (drag its keys) and a row per key (time 0–1, value; **+ key** adds one in
  the widest gap); a gradient shows a preview bar and a row per stop (time,
  colour, alpha; **+ stop**).
- **The preview** (right column) plays the effect in a looping
  view of its own — its own renderer (the editor's backend), the project
  environment (a dark backdrop when the project has none) and a grid at the
  effect's origin; drag to orbit, the view frames the effect's bounds. It
  uses the executor Play would use (WebGPU compute on the WebGPU backend
  when the graph allows it — else the CPU executor, with the reason in the
  status line — and the CPU executor on WebGL 2), and it follows every edit
  (graph, settings, parameters) at once, continuing from the time it
  showed.
  - *Timeline*: **▶/❚❚** plays or pauses, **⟲** restarts from the seed, the
    slider scrubs. Time runs in fixed 1/60 s steps, and a scrub
    re-simulates from the seed up to that time (the CPU executor re-runs the
    reference evaluator, WebGPU re-runs the compute passes), so the same
    time always shows the same particles and counters. At the **preview
    length** (default: two cycles of a looping effect, one cycle plus a
    second for a one-shot; up to 60 s) the preview starts over.
  - *Spawn counters*: per system, particles **spawned** since time 0 and
    **living** now (on WebGPU read back from the GPU a few times a second).
  - *Frame cost*: GPU time from timestamp queries where the device has
    them (the WebGPU executor's compute passes and the render passes);
    otherwise CPU time — the line says which (the CPU executor's
    simulation is always CPU time).
  - *Preview parameters*: a slider per float parameter (its min/max, else a
    range around its value), three per vector, a colour picker per colour
    — preview only, never saved (**reset** goes back to the effect's
    values; objects set theirs in the Inspector's Effect component).
  - The effect plays in the editor window's preview pane; closing the
    window disposes the pane's renderer, buffers and materials (one renderer
    for every preview while the window shows); the page's `data-tl-previews`
    attribute counts the pane's renderers opened, closed and released.

## Playing effects

Select an object, **+ Add component → Effect** and
pick the effect. **Play on start** (on by default) starts it with the scene;
the **Parameters** rows set this object's values for the effect's public
parameters (× goes back to the effect's value). **Play on signal** restarts
it whenever that signal is sent (a switch, trigger or script) and **Stop on
signal** stops its spawning (living particles finish) — turn Play on start
off for an effect that waits for its signal.

A project script plays an effect where a game event happens (no built-in
game component plays one). Scripts play and stop effects: `ctx.effects.play(effectId, {position?,
entityId?, params?})` returns a handle (0 when refused: a bad id or more
than 32 plays in one step) — with `entityId` the effect follows that object
and `position` is an offset from it, else `position` is a world point —
and `ctx.effects.stop(handle | entityId)` ends spawning. Visual scripts have
the same nodes (**Play effect**, **Stop effect**, category *Effects*; the
entity defaults to the script's own object). All of these are presentation
events: they are recorded in step order and played by the renderer, and the
game simulation never reads them back (replays do not depend on effects).

**Where effects play.** Play (the preview) and exported games draw every
effect of the project (the export's `manifest.json` carries them in
`effects`; their textures and models travel with the game). The **Scene
view** plays the selected object's effect while **Gizmos → Play selected
effects** is on (a finished one-shot starts again; off stops it); an edit of
the effect (in its tab or over MCP) shows there at once.

## Executors and caps

One graph, two executors:

- **WebGPU** (the renderer draws on WebGPU): the graph runs as TSL compute
  passes over storage buffers — per system an update pass and a spawn pass
  (the CPU counts births with the rate carry, bursts and distance; the GPU
  initialises them with the reference's random stream, so a particle
  starts and moves as the CPU reference would, to float precision — checked
  particle by particle in the tests); a free list of slots is the pool;
  alpha and premultiplied outputs are sorted back to front each frame on
  the GPU (bitonic sort, up to 65 536 slots per system; beyond that they
  draw unsorted). Caps: 262 144 particles per system, 1 048 576 over all
  playing effects, 64 playing effects.
- **CPU** (the WebGL 2 backend; on WebGPU also the effects with *From
  event* spawns, which tie systems together): the reference evaluator of
  `@thirdlight/effects` over typed arrays, drawn instanced, sorted back to
  front on the CPU. Lower caps: 4 096 particles per system, 16 384 over all
  playing effects, 64 playing effects.
- **Per system on WebGPU.** A system whose particles are used on the CPU —
  a *Lights* block, ribbons/trails, a *Mesh surface* shape, or more than
  four spawn blocks — is simulated on the CPU beside the effect's GPU
  systems, in the same step (same time, origin, parameters and random
  stream: it moves exactly as on the CPU executor), at the CPU caps. So a
  fire's flames and smoke stay on the GPU and only its light system runs on
  the CPU; nothing is read back from the GPU and the light is not a frame
  late. In such an effect, a system holding fewer than 512 particles
  (`GPU_MIN_PARTICLES`, three-adapter `effects-gpu.ts`) joins the CPU ones:
  measured on the Iris Xe, a GPU system costs 0.045–0.08 ms of main-thread
  dispatch a frame whatever its size, the CPU step 0.01 ms plus ~0.17 µs a
  particle. An effect left with no GPU system plays on the CPU executor
  alone. Each new play of an effect with GPU systems builds their compute
  passes (about 8 ms on its first frame; a finished play is pooled and
  reused).

A system's *max particles* is capped to its executor's cap; a play past the
total or the instance cap is refused (counted in the diagnostics). Point
lights: 16 shared by all effects, a fixed pool: when Play or an exported
game starts and one of its effects has a *Lights* block, all 16 are added
to the scene dark before the first frame, so the number of lights never
changes while it plays and no lit material recompiles (a game without
light-emitting effects carries none; an edit that adds the first *Lights*
block in the Scene view adds them then, once). Past 16 lit particles the
rest give no light. A *Lights* block has **Light layers (mask)** (bit n is
layer n + 1; 255, the default, every layer: its lights light only objects
in those layers, as a scene light's mask; 0 lights nothing and takes no
slot) and **Importance** (Auto, Per pixel or Per vertex, as a scene point
light's — see [Local lights per pixel or per vertex](lighting.md#local-lights-per-pixel-or-per-vertex)). A game whose effect
lights all light every layer at auto importance needs no extra programs;
one with a narrower mask or a forced importance builds the lit programs
with the test or range once, before its first frame. A frame longer than
1/30 s is split into up to four steps.
*Collide with scene (depth)* is honoured on WebGPU only (the depth of the
last frame the player drew); *Soft particles* fade against the scene depth
on WebGPU only. Output block inputs (a billboard's axis, soft distance, a
ribbon's width, a light's intensity and range) are read once per frame
(their field, or their wire in the spawn context), not per particle.
Effects outside their bounds box (around their origin) are not drawn (they
keep simulating).

## Diagnostics and the API

`tl_diagnostics` has `renderer.effects` — the executor
(`webgpu` | `cpu`), its caps, what plays and how many particles (GPU counts
are read back every half second), refused plays, effect ids no effect of
the game has, and per playing effect its executor (and why an effect runs
on the CPU on WebGPU) with each system's executor (`systems`: `webgpu` |
`cpu`, and why a system of a GPU effect runs on the CPU), the pool lights in use (`lights`) and in the scene
(`lightPool`: 16 or 0); `tl_game_observe` has a compact `effects` block. The
game canvas carries `data-tl-effects` (the executor), `data-tl-effects-playing`,
`data-tl-effects-particles` and `data-tl-effects-lights` (pool lights in use).

Every graph gesture is one `graphEdit {owner: {kind: "effect", id:
"<effectId>/<systemId>"}, ops}` (one undo step); `setEffect {effect}`
creates or replaces an effect (settings, parameters, systems with their
graphs — adding or removing a system is a `setEffect`), `deleteEffect
{effectId}`, `renameEffect {effectId, name}`; the component is
`setComponent "effect" {effectId, playOnStart?, params?, signal?,
stopSignal?}` (naming no effect of the project is refused, and so is
deleting an effect something names). The effects travel in `queryGameConfig` (`effects`) and
`tl_content_query target="game"`. Limits: 16 systems and 32
parameters per effect (as many effects as the project needs), 256 nodes per system graph, up to 1 048 576 max
particles per system (capped by the executor, see above).

The CPU reference semantics of every node live in the runtime-safe package
`@thirdlight/effects` (deterministic per seed; unit-tested); the CPU
executor runs it and the WebGPU executor mirrors it (three-adapter
`effects-gpu.ts`).
