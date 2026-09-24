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
| 20.0 data | todo | |
| 20.1 node catalogue | todo | |
| 20.2 runtime executors | todo | |
| 20.3 editor | todo | |
| 20.4 tests and wrap-up | todo | |

## 4. Decision log
