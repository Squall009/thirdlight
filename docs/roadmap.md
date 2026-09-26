# Thirdlight roadmap (phases 14–22)

Owner decisions, 2026-09-24. A session works these phases in order, from
top to bottom, without asking the owner: where a plan leaves a choice open,
take the plan's default (or the most generic sound choice), record it in
that phase plan's decision log, and move on. The owner reviews at the end.

## Principles (apply to every phase)

1. **Generic, never demo-shaped.** Every feature, component, field and
   default is designed for all potential projects (any genre: platformer,
   top-down, puzzle, 3D walker…), not for Sprout or Beacon Reach. A default
   is an engine default with a genre-neutral reason written next to it
   (e.g. "1.8 m: an adult human"), never a value fitted to the demo.
   Tests use neutral fixtures; only the opt-in Sprout tests
   (`tests/integration/sprout-meadows`, `tests/e2e/sprout-live.e2e.ts`) use
   the demo. Sprout is a consumer: its own values live in its own project
   data and scripts. When an existing default turns out to be demo-shaped,
   fix it and log it. This covers **API shape and dimensionality**, not only
   values: a port, library or data model that only works in 2D, on one axis
   or for one genre is demo-shaped even when every default is neutral
   (the 2D-only simulation found in 2026-09-26 was this; phase 23).
2. **Everything that affects the game is an object in the editor.** Any
   data the game reads can be seen, selected and edited in the editor —
   Inspector fields, and Scene-view handles for anything with a size, range,
   direction or path. No engine value a designer would tune stays a hidden
   constant: it becomes data with an engine default (engine *limits* that
   protect the runtime — budgets, caps — may stay constants, documented).
3. **One mutation path.** The backend owns project state; the editor, MCP
   and scripts-at-edit-time use the same commands (AGENTS.md).
4. **The runtime never imports editor code**, exports run without the
   editor, determinism and replays hold (a data default equal to the old
   constant keeps every recorded replay valid).
5. **Renderer target: WebGPU, with a WebGL2 fallback** (owner decision).
   Shading is authored once (three.js TSL/node materials) and runs on both.
6. **Observed, not claimed.** Visual/audio results are "owner look pending"
   unless observed in pixels by a test.

## Order

| Phase | Plan | What |
|---|---|---|
| 14 | `docs/plan-phase-14.md` | Character collider as data with Scene handles; phase 9 leftovers |
| 15 | `docs/plan-phase-15.md` | Everything editable: component descriptors, generic Inspector, handles for every sized/ranged field, tuning values as data, script property visibility (public/private) |
| 16 | `docs/plan-phase-16.md` | Graph editor framework; centre workspace tabs; Animator and the script editor move there |
| 17 | `docs/plan-phase-17.md` | Renderer: WebGPU with WebGL2 fallback (three WebGPURenderer + TSL) |
| 18 | `docs/plan-phase-18.md` | Material node graph (was planned as phase 13) |
| 19 | `docs/plan-phase-19.md` | Visual scripting (blueprint-style graphs compiled to behavior modules) |
| 20 | `docs/plan-phase-20.md` | Visual effects graph on GPU compute (CPU/WebGL2 fallback) |
| 21 | `docs/plan-phase-21.md` | Performance and memory pass |
| 22 | `docs/plan-phase-22.md` | Multithreading: simulation worker, optional render worker |
| 23 | `docs/plan-phase-23.md` | 3D game foundations: 3D physics and character controller, cameras, pointer and 3D queries, block layers, project UI, game modes, dialogue, sequencer, audio, saves (gap list from the Skyforge Tactics dogfooding project) |

Phase 13 (material node graph) moved to phase 18, after the renderer phase,
because the graph compiles to TSL (owner decision, 2026-09-24).

## How every phase is worked

The rules of `docs/plan-phase-9.md` §3 (including its **Traps**) and the
extra traps in `docs/plan-phase-14.md` §3 apply to every phase. In short:
items in order; schema/commands → runtime/adapter/host → editor → exporter
→ tests → docs; every editor change gets a Playwright test against a real
backend; green is tiered (2026-09-26, owner: a 50-minute gate per commit was
too slow): **per commit** `tools/gate.sh fast <the e2e files of the area
you changed>` (build, all of vitest, a smoke set, those files — a few
minutes); **per finished item, before its STATUS row says done**
`tools/gate.sh full` (every spec in both projects, the leak test included);
while fixing a failure `tools/gate.sh rerun` runs only what failed last
time. Commit to `main`, push, `sudo systemctl restart thirdlight`;
tick the phase plan's progress table and one or two lines in its
`docs/STATUS.md` row; decisions in the phase plan's decision log. Sprout:
commit there, never push. Never print the owner token.

Large items may be done by subagents in git worktrees (as in phase 9): the
main session reviews the diff, runs the full suites after merging, and only
then pushes and restarts.

A phase is done when its "done when" holds, its STATUS row says done
(owner look pending where visual/audible) and `docs/deployment.md` describes
what a user can now do. Then the next phase starts without waiting.
