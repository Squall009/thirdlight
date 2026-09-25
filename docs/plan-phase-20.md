# Phase 20 — Visual effects graph on GPU compute

Goal: particle and visual effects are authored as node graphs in a centre
tab (phase 16) and simulated on the GPU with WebGPU compute (phase 17),
with a fallback on WebGL2 (a CPU simulation with the same graph semantics,
lower caps). Effects are components, triggered from gameplay and scripts.
Read `docs/roadmap.md` (principles) first.

## 1. Decisions

- Effect simulation is visual only: it never feeds back into the
  deterministic game simulation (so replays do not depend on the GPU).
  Spawning is driven by deterministic game events; the particle state itself
  may differ between machines.
- One graph semantics, two executors: WebGPU compute (TSL compute nodes,
  storage buffers) and a CPU fallback for WebGL2 with a documented lower
  particle cap; the chosen executor and caps are in diagnostics.

## 2. Work items

### 20.0 Data

- `content.effects[]`: an effect = systems, each a graph with contexts
  (spawn: rate, burst, over distance; initialize; update; output/render) and
  exposed parameters (15.4 visibility rules), bounds, max particles,
  simulation space (local/world), duration/loop, seed. Component `effect`
  on entities: effect id, play on start, parameter overrides. Commands.

### 20.1 Node catalogue (generic)

- Spawn: constant rate, bursts, spawn over distance, from events.
- Initialize/update: position shapes (point, sphere, box, circle, cone,
  mesh surface of a model asset, line), velocity, lifetime, size, colour,
  rotation, mass; forces (gravity, drag, wind (global wind), vortex,
  turbulence/curl noise, attractor), collisions (plane, depth buffer on
  WebGPU; none on the fallback), age-based curves and gradients (curve and
  gradient editors as node inputs), kill conditions.
- Output: billboards (camera-facing, velocity-aligned, fixed axis), mesh
  particles (a model asset), ribbons/trails, lights (limited); flipbook
  texture animation; blending modes; soft particles; lit/unlit via a
  material graph (phase 18) or built-in particle materials.
- Events between systems (on death → spawn in another system).

### 20.2 Runtime

- WebGPU executor: compute passes per system, storage buffers, indirect
  draw; GPU sorting for transparency where needed; pooling and caps.
- CPU executor (WebGL2): the same graph evaluated on the CPU (typed arrays),
  instanced rendering; lower caps.
- Triggers: `effect` component play on start / on signal; scripts
  `ctx.effects.play(id, {position, params})`, `.stop`; gameplay hooks
  (pickup collected, enemy defeated, checkpoint, hit) may name an effect
  (generic fields, not demo-specific).

### 20.3 Editor

- The Effect tab: graph per system, a looping preview pane with a timeline
  (play/pause/scrub/restart), spawn counters and GPU time; the Scene view
  plays selected effects in edit mode (toggle).

### 20.4 Tests and wrap-up

- Unit: graph validation, CPU executor maths; e2e: build a burst effect,
  attach it to a pickup's "collected" hook, see particles in Play and the
  export (pixel checks on the fallback here; WebGPU per 17.0's test decision).
  Docs, STATUS row 20.

## 3. Progress

| Item | Status | Commits |
|---|---|---|
| 20.0 data | done 2026-09-25 | 7a00184 |
| 20.1 node catalogue | done 2026-09-25 | 7a00184 |
| 20.2 runtime executors | todo | |
| 20.3 editor | todo | |
| 20.4 tests and wrap-up | todo | |

## 4. Decision log

- 2026-09-25 (20.0): contexts ↔ graph kinds — **one graph per system** (kind `effect`, owner kind `effect`, owner id `<effectId>/<systemId>`) holding the four contexts as fixed nodes (Spawn, Initialize, Update, Output, ids = their types), each running a **chain**: the context's `then` → a block's `in`, its `then` → the next block (every flow input and output takes one wire, so a chain is linear and its order is the execution order, like a visual script's exec wires). Each context has its own flow port type (`spawn`, `init`, `update`, `render`), so the generic validator refuses a block in the wrong context (a force in Initialize, a renderer in Spawn) at edit time. Why: one graph per system is what 20.3 shows ("graph per system"), value nodes are shared across a system's contexts, and no framework change was needed for ordering (position-ordered stacks would change meaning when a node is moved). The four context nodes are created with the system; a block off every chain does nothing (a diagnostic).
- 2026-09-25 (20.0): data — `content.effects[]` (v4, optional, absent when empty; canonical: by effectId, systems in list order = evaluation order) = `{effectId, name, duration (0.01–3600 s, one cycle), loop, seed (0–2^32−1), bounds {center, size} (culling box, effect space), parameters? (float|vec3|color, 15.4 visibility, ≤ 32), systems (≤ 16) [{systemId, name, maxParticles (1–2^20), space local|world, graph}]}`. Duration/loop/seed/bounds/parameters are per effect (one origin, one cycle, one culling box); capacity and space per system (VFX-style: a spark system may be world space while its glow is local). All but `parameters` are required in the record (a new record type: no replay to keep). Engine defaults (`EFFECT_DEFAULTS`, genre-neutral reasons in the code): 2 s loop, seed 1, a 4 m box 1 m above the origin, 1000 particles, local space. Limits: 128 effects, 256 nodes per system graph.
- 2026-09-25 (20.0): commands — `setEffect {effect}` (create or replace; adding/removing/renaming a system and every setting is a `setEffect`), `deleteEffect {effectId}` (the resulting-state check refuses it while an `effect` component names the effect, like materials) and `renameEffect {effectId, name}`; all record one change `setEffect {effectId, previous, next}` (null = none) and undo by restoring `previous`. Graph edits are the generic `graphEdit` on owner kind `effect` (change = the ops, undo = the inverse ops, no record hook; the effect's parameters type the Parameter nodes through `effectGraphContext`). Registered in commands (types, validate-request, apply, history), workspace envelope, protocol m3, MCP tool text; `queryGameConfig` returns `effects`.
- 2026-09-25 (20.0): component `effect` `{effectId, playOnStart? (absent = true: a placed fire or fountain runs by itself; true is omitted from the canonical form), params? {<public key>: number | [x,y,z] | "#rrggbb"} (empty allowed and dropped, so resetting the last override works)}` on any entity (no partner component), in the prefab vocabulary; appended last to `V4_REGISTRY`. Shape in the scene/prefab validators; the project rule (names a project effect, only public parameters, values fit) runs in `composeV4` after every command, like `materialParams`. Descriptors: ref target `effect`, `typedBy: 'effectParameter'`; the Inspector's generic map widget shows one row per public parameter of the chosen effect (× resets), like the animator's starting values.
- 2026-09-25 (20.1): catalogue (data, `project-model/src/effect-graph-kinds.ts`): block parameters are node fields and every number / 3-vector / colour field is also an input port **of the same id** (a wire replaces the field; per particle in Initialize/Update/Output, once per step in Spawn) — fields marked `fixed` in the builder (enums, flags, structural counts such as cycles, segments, frames or max lights, assets, curves, gradients) have no port. Value types `float`, `vec3`, `color` (linear RGBA) with implicit conversions float→vec3 (splat), float→colour (grey, alpha 1), vec3→colour (alpha 1), colour→vec3 (RGB). Value nodes: Float, Vector, Colour, Parameter (typeFrom lookup), Random (fixed per particle), Random vector, Curve / Gradient (read at the normalized age — in Spawn the effect time —, the effect time or a random position), Particle attribute (typeFrom map), Effect time, maths (add … split, `auto` widths like the material kind; unwired inputs read their port default: 0, or 1 for a factor). Scene-depth collision is its own block (`update.collide.depth`, honoured only by the WebGPU executor; the CPU evaluator ignores it and says so in its diagnostics). Lights are limited to ≤ 16 per renderer, on the oldest living particles. "Lit/unlit via a material graph or built-in particle materials" = a Shading field `unlit|lit|material` plus a `material` id field; whether that material exists is checked by the renderer in 20.2 (the graph field is a plain id so a deleted material degrades, not refuses).
- 2026-09-25 (20.1): framework (generic, minimal): two field types in `graph.ts` — `curve` = keys `[t0, v0, t1, v1, …]` (2–16 keys, t 0–1 ascending, values within the field's min/max; linear between keys, clamped outside) and `gradient` = stops `[t, r, g, b, a, …]` (1–8 stops, every number 0–1, t ascending; colours are sRGB as picked, alpha linear). Both are plain `number[]` GraphValues (no value-type change, canonical form unchanged). Editor widgets (`editor/src/graph/CurveFields.tsx`, used by GraphInspector for any kind): a plot with draggable keys plus key rows / "+ key"; a preview bar plus stop rows / "+ stop". No other framework change.
- 2026-09-25 (20.1): semantic problems are diagnostics, never refusals (unlike the material's "declare the parameter first"): a Parameter naming no parameter reads 0 (error), a block off every chain, a From event naming no system, an attribute read in Spawn, no renderer, no Lifetime (1 s). Why: MCP and the editor build graphs through incomplete states (a new Parameter node has an empty key).
- 2026-09-25 (20.1): CPU reference semantics live in a **new runtime-safe package `@thirdlight/effects`** (boundary: project-model only, like the runtime; no three.js, no Node builtins) — not in the deterministic runtime (effects are visual only and must never couple to the simulation or replays) and not in three-adapter (it may import only the runtime, not project-model's kind data, and the executors of 20.2 — WebGPU and CPU — should share one reference). Added to `tools/check-boundaries.mjs` (UNITS + edge row) and the lockfile's workspace entries; a checkout needs the `node_modules/@thirdlight/effects → ../../packages/effects` link (`npm install` creates it).
- 2026-09-25 (20.1): evaluator semantics (`EffectInstance`, typed arrays, packed living particles, swap-remove): per step and per system in order — update (age; death at lifetime; size/colour restart from their initial values; non-post Update blocks in chain order; p += v·dt; spin; then collisions and kills in chain order), then spawn (rate with carried fraction + 1e-9 so 60 × 10/60 is exactly 10; bursts at `time + k·interval` within each cycle; per metre moved, spread along the path; events), new particles run Initialize and are drawn at their birth state. Shapes **add** an offset to the base position (origin, or the source particle of an event) and set the direction; velocity blocks **add** to the base velocity (zero, or the inherited share). Forces: gravity is mass-independent, the others accelerate by F/m; drag is exact exponential; wind approaches the global wind velocity exponentially, using the foliage shader's gust wave (strength + gust × (0.5 + 0.5 sin(2π f t − 0.08 x (1 + 3 turbulence)))); turbulence is the curl of three seeded Perlin potentials (divergence-free, tested). Events carry world position/velocity/colour and reach later systems in the same step, earlier ones (and the system itself) the next step. World space: block positions/directions are effect space, transformed by the current origin; kill boxes test in effect space. Randomness: hashes of (seed, system index, particle serial, node id) — same effect, seed and steps give bit-identical particles; `restart()` replays them. Output maths (flipbook frame/rect, billboard axes, light selection, ribbon order) and per-particle trail history are in the package for 20.2.
- 2026-09-25 (20.0, editor minimal): bottom dock **Effects** (create by name → id, rename, delete, open) and an **Effect: <name>** document kind: settings, system tabs + "+ System" (four contexts), system settings, exposed parameters, the GraphEditor of the shown system (which system each tab shows is App state, so the right dock's GraphInspector follows it) and a note that the preview arrives with 20.3 after the 20.2 executors. Effects are not in the runtime closure/manifest yet (20.2); the `effect` component travels in scenes and is ignored by the runtime until then.
- 2026-09-25 (run): 20.0/20.1 were built in parallel with phases 17–19 and merged early; they touch no renderer code (effects are drawn from 20.2).
- 2026-09-25 (20.0 fix): the effect-graph e2e's wrong-context wire (Burst `then` → Billboard `in`) never reached the connect check: a text selection left in the page (range from a port button to the graph status text) made the next press on a port start a native drag of it, and the browser's `pointercancel` dropped the wire gesture silently, so the status kept the previous "connected". Fix in the generic GraphEditor (all graph kinds): the stage is `user-select: none` (popups/rename fields excepted), a press on it clears any page selection, native `dragstart` inside the stage is refused, a new wire gesture clears the old status and a cancelled one says so. Also: a node added from the search catalogue (not by a wire drop) goes to the nearest free grid spot around the click, 40 units clear of existing nodes (`freePlace`; ties go right, then down, the reading order of every graph kind; only if nothing within 40 grid steps is free it goes right past everything — a first version that always went right pushed a visual-script node out of view), so its ports never sit on another node's ports; a wire dropped on a node body connects to its first port that takes it without replacing a wire (else the first that takes it), or reports why none fits (`planDropOnNode`), instead of opening the catalogue. Pinned by `tests/graph-editor-placement.test.ts` and the e2e (a whole-page selection before the drag; drops on block bodies).
