# Phase 22 — Multithreading

Goal: move work with clean boundaries off the main thread — the game
simulation (runtime + physics) first, then optional off-thread rendering —
without concurrency hazards and without changing game results. Read
`docs/roadmap.md` (principles) first.

## 1. Where things stand and why this order

- The runtime is pure (no DOM, no three.js); physics is behind the
  `PhysicsPort` interface; the adapter reads interpolated transforms and a few
  views (hidden entities, animator poses, counters) per frame. The runtime
  calls physics synchronously inside each step, so moving physics alone to a
  worker would add a step of latency or a round trip per step: the whole
  simulation (runtime + physics + gameplay blocks + scripts) moves together.
- Asset decoding already uses workers (Draco/Basis).
- Rendering off-thread needs OffscreenCanvas and moves input/audio/DOM
  interplay; it is optional and comes after the simulation worker.

## 2. Decisions

- Determinism is the rule: the worker runs the same fixed steps; replays
  and the headless bot give identical results on and off the worker (a test
  pins it).
- Message passing by default (structured clone of compact typed arrays per
  frame: transforms, visibility, poses); SharedArrayBuffer ring buffers only
  where cross-origin isolation is available (COOP/COEP headers on the Play
  and export pages; the export must work without them — then the message
  path is used). Log what each page gets.
- Single-thread mode stays available (setting/URL flag) and is the fallback
  when workers are unavailable.

## 3. Work items

### 22.0 Simulation worker

- A worker entry (runtime + physics-rapier + behaviors + blocks) in the
  preview and export bundles; the main thread keeps input sampling (sent as
  action frames with step indices), audio (the worker sends audio requests),
  DOM menus/HUD (the worker sends flow/HUD state), and rendering (the worker
  sends per-frame state with the interpolation alpha).
- Game host split: a thin main-thread host and a worker host with the same
  observable behaviour (the `GameHost` surface, `observe`, `control`,
  MCP relay).
- Scene loading/unloading and spawn (14.1) cross the boundary as messages.
- Tests: identical replays on/off the worker; the Sprout bot and the blocks
  integration tests run in both modes; e2e Play and export in worker mode.

### 22.1 Editor-side workers

- Move heavy editor jobs off the main thread: the browser lightmap baker,
  thumbnail rendering (OffscreenCanvas), scatter generation, graph compile
  (materials, visual scripts), big projection diffs.

### 22.2 Optional render worker

- Spike: Play/export rendering in a worker with OffscreenCanvas
  (WebGPU/WebGL2 both), input forwarded; measure with the phase 21 harness.
  Adopt only if it wins on the benchmarks without breaking audio/input
  latency; otherwise document why not and keep the spike archived.

### 22.3 Physics details

- Rapier WASM in the worker, memory growth limits, disposal on unload; the
  physics query budget and overlap queries (9.9) unchanged.

### 22.4 Wrap-up

- Harness numbers before/after (phase 21) in §4; `docs/deployment.md`
  (threading mode, headers for SharedArrayBuffer, how to force single
  thread); STATUS row 22.

## 4. Progress

| Item | Status | Commits |
|---|---|---|
| 22.0 simulation worker | todo | |
| 22.1 editor workers | todo | |
| 22.2 render worker spike | todo | |
| 22.3 physics details | todo | |
| 22.4 wrap-up | todo | |

## 5. Results and decision log
