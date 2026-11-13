# Phase 46f — Shared foundations

Status: **46f: planned 2026-11-13, not started** on branch `phase-45` (worktree `~/projects/thirdlight-p45`, base
dea68d37; main frozen at d4053cab). Planned from the owner's decisions of 2026-11-10 to 11-12
(`docs/decisions/owner-decisions.md`), `docs/research/duplication-audit.md` and
`docs/architecture/voxel-engine.md` §6. It comes before 46e (lighting): 46e's choice is made by GPU time, and
water, fog, vegetation and lighting all sit on what this phase builds.

## 1. Scope

Four foundations and a set of cheap merges; no new feature a player or designer would see beyond the profiler.

- **In:** a frame profiler with one budget table and one frame arbiter; a camera-following window helper and
  the interaction field; trees and ground cover in the culled-instance table; one undo for scene and voxels;
  the cheap merges of §6 (46f.5).
- **Out, with the phase that takes it:** derived fields, the world edit mode, the fill, the fog role, dressing
  rules (47b); open-region labelling, the grid walk, lighting (46e); regenerated structures and water bodies
  (47a); far-node channels (49); `VolumeShape`, one texture-set type, `setRecord`, form fields, the key-scope
  stack (with 47b and 51, when those files are open anyway); anything inside block layers, heightfield terrain
  or generated architecture (retired in 48).
- **Carried from 46d-c, not in scope unless an item touches them:** D594 (run-time edits do not reach the far
  field), D620 (full detail after a 150 m/s stop), D621 (a body under the coarse floor waits), D634 (hole
  frames at medium with fine bricks on), D644 (a full far-cache rebuild drops baked fine levels).

## 2. Owner requirements (quoted; REQUIREMENTS, never silently dropped)

- 2026-11-12: "I like the idea of having a very solid foundation that things are shared upon … make sure we are
  not duplicating work for different purposes."
- 2026-11-12: "yes, a single undo path for both the scene and voxels".
- 2026-11-11 (the profiler): "a dedicated frame time profiler that we build into the engine. I feel like that
  would be helpful like the unity profiler."
- 2026-11-11 (the budget): the frame budget table must cover "items, props, characters, gpu compute particle
  effects, lighting … game logic, path finding, and everything else we will have running on the main thread".
- 2026-11-12 (interaction): ground fog "should be interactible with the character … tie it like how we do
  vegetation bending for entities moving" — one mechanism for foliage, fog and water.
- 2026-11-10: WebGPU first; the low tier at 720p upscaled, capped at 30 Hz, is the target on the Iris Xe;
  measure at the cap, never uncapped; medium and high are unverified on this host.
- 2026-11-11: hobby pace: the quick, reversible route; gates by affected area.
- 2026-11-12: no steering mid-phase: a new idea goes to the decisions register and waits for the phase
  boundary unless something is broken.

## 3. three.js check

To do as the phase's first act (AGENTS.md): on 2026-11-13 `npm view three version` gave 0.187.0, the pinned
release; if that still holds there is nothing to assess. No update without the owner.

## 4. Baseline (measured by 46f.1 before it changes anything)

Low tier, WebGPU, 1280 × 720 at the 30 Hz cap, the 8 km world and the village class: the headroom meter's room
and pass shares; the coverage bench's hitches and settle at 60 and 150 m/s; the page-thread and
simulation-worker CPU a frame as far as today's stats give them (the gap the profiler closes); a scene with
stored trees and ground cover (the phase 40 meadow class) for 46f.3: draws, triangles, frame room. Fast gate
time and the per-area times.

## 5. Where things live (reuse first; never copy)

| Thing | Home | Reuse |
|---|---|---|
| Budget table per quality tier | `project-model` (`quality-levels.ts`) | the existing tier records; the 13 time-slice constants become entries |
| Spans, frame ring, arbiter | `runtime` (simulation side), `three-adapter` (page side), `@thirdlight/shared` for the span type | `engine-stats.ts`, `frame-stats.ts`, `perf-marks.ts`, `gpu-timing.ts`, `gpu-headroom.ts`, the `voxel-batch-stage` share model |
| Profiler panel and overlay | `editor`, `game-host` | `stats-overlay.ts`; `tl_diagnostics` for MCP |
| Window helper, interaction field, wind sampler | `three-adapter` | `wind-field.ts` (the pattern), `foliage-bend.ts` (replaced), the see-through subject list |
| Interactor component | `project-model` (schema, upgrade step renaming `foliageBend`), `commands` | component descriptors |
| Culled rows for copies and cover | `three-adapter` | `occlusion-instances.ts`, `attribute-instancing.ts`, `view-cull.ts`, `dither-fade.ts`; `copies-gpu.ts` and `cover-gpu.ts` are the ones moved |
| Level helper (screen size → level, hysteresis) | `@thirdlight/shared` | replaces the per-system copies as each is touched; voxel rings stay |
| Undo dispatch | `workspace` / `backend` (one user-facing undo, redo), `commands` | project `history.ts`, the voxel `UndoStore` |
| Job kinds on the voxel pool | `voxel` (`worker-pool.ts`, `job-queue.ts`) | cover, scatter and decal-clip workers become kinds |
| Region texture helper, buffer grow | `three-adapter` | `VoxelShaderGrids`, `tracer-gpu.ts` |
| Test support | `tests/support` | `tests/e2e/backend.ts`; names added to `tools/check-redefinitions.mjs` |

## 6. Items

| Item | Builds |
|---|---|
| 46f.0 | The three.js check (§3) and the baseline (§4), before any change. |
| 46f.1 | **Profiler, budget table, frame arbiter.** Named CPU spans on the page thread, the simulation worker and the job workers (a ring of recent frames each; workers post theirs with the tick); GPU pass shares, with the headroom meter called on demand for real room (D544: timestamps are not usable at the cap); counters (draws, triangles, instances, GPU and page memory, queues); one budget table per tier; the per-frame time-slice constants draw from one arbiter; spike capture (the long frame and what every thread was doing); an editor panel with a timeline and a frame breakdown, a Play/export overlay off by default, a capture file, a read through `tl_diagnostics`. May split a (spans, table, arbiter) / b (panel, overlay, MCP). |
| 46f.2 | **Window helper and the interaction field.** The helper generalised from `wind-field.ts`; the wind sampler public and read by GPU effects; a 256² field at 0.25 m (about 1 MB) that any entity with an interactor component stamps into (velocity in m/s, pressed amount, stamp foot height, top height), decayed and scrolled each frame; it replaces `foliage-bend.ts`'s four subjects in uniforms; foliage reads it (same bend look, any number of entities); fog and water read it later. Visual only: scripts do not read it. |
| 46f.3 | **Trees and ground cover into the culled-instance table.** `copies-gpu.ts` and `cover-gpu.ts` become rows of `occlusion-instances.ts` with level and thinning rank chosen in compute; one screen-size → level helper; `view-cull.ts` the one in-view ordering; `dither-fade.ts` for level changes; shadows keep the near-ring rule. Measured against §4's meadow class before and after. |
| 46f.4 | **One undo.** One user-facing undo and redo that dispatches to the project history or the voxel undo store by the last edit, in the editor and over MCP; redo for voxel edits; `expectedRevision` on voxel ops if it is cheap. |
| 46f.5 | **Cheap merges.** Cover, scatter and decal-clip workers as job kinds of the voxel `WorkerPool`; one region-texture helper (partial upload, grow by copy) and one buffer grow; one memory budget table and a resident-bytes report; `tests/support` replacing the `serveDir` copies and per-spec command helpers, guarded by the redefinition check; one `QUERY_OPS` list; pointer → ray through `SceneQueries`; stale headers (`store-v4.ts`, `project-v4.ts`, `play-content.ts`). May split by package. |
| 46f.6 | Close: the phase gate, the independent review, results, STATUS, the design page's §6 states. |

## 7. Progress

| Item | Status |
|---|---|
| 46f.0 | not started |
| 46f.1 | not started |
| 46f.2 | not started |
| 46f.3 | not started |
| 46f.4 | not started |
| 46f.5 | not started |
| 46f.6 | not started |

## 8. Results

(Each item's built / tested / measured / looked-at goes here, or in `docs/results-phase-46f.md` if this file
passes about 1,000 lines.)

## 9. Decision log

- 2026-11-13 (plan): the phase is planned from the owner-approved consolidation of 2026-11-12; item order is
  0 → 1 → 2 → 3 → 4 → 5 → 6, with 46f.4 and 46f.5 free to run beside the rendering items since they touch
  other packages (one writing session per worktree still holds).
- 2026-11-13 (plan, default chosen, owner to confirm): the interaction field is visual only; a game that needs
  "is the fog cleared here" asks for it as a later request.
- 2026-11-13 (plan, default chosen, owner to confirm): the profiler's GPU lane shows pass shares, not
  milliseconds, on hardware where timestamps follow the clock governor.

## 10. Open questions for the owner

(None at planning. Questions the phase raises are listed here, at most five, each with a default that stands
if unanswered.)
