# Phase 19 — Visual scripting (blueprint-style graphs)

Goal: game logic can be written as node graphs in a centre tab, with events,
flow control, variables and calls into the same script API that TypeScript
behaviors use, compiled to the same behavior modules — so graphs and code
behave identically, are sandboxed and deterministic, and export the same
way. Read `docs/roadmap.md` (principles) first.

## 1. Decisions

- A visual script is a behavior whose source is a graph instead of
  TypeScript; the backend compiles it to the same module format (through
  generated TypeScript fed to `behavior-build`, or directly — log the
  choice), with the same limits, output scan and pins.
- Properties: variables marked public appear in the Inspector (15.4 rules);
  private ones don't.
- Deterministic execution: step-ordered events, no wall-clock, bounded loops
  (an iteration cap per step reported as a script error).

## 2. Work items

### 19.0 Data and compiler

- Graph data in the behavior record (`source.kind: 'graph'`), validation
  (node kinds, port types, exec-flow rules, no unbounded cycles), canonical
  form, commands through the phase 16 framework.
- Compiler: graph → module; source maps from generated code back to node ids
  so runtime errors point at nodes.

### 19.1 Node catalogue (generic)

- Events: on start, on step (per phase: intent/gameplay/transform), on
  signal, on trigger enter/exit (14.2), on collision/overlap query results,
  on input action pressed/released, on animator clip event, on timer (14.2),
  on custom event (send/receive between scripts).
- Flow: branch, sequence, for (bounded), for each (arrays, bounded), while
  (bounded), gate, do once, delay (step-counted), select/switch on enum,
  string, int.
- Data: variables (local, per-instance, public/private), get/set, arrays,
  maps (bounded), maths/logic/compare, vectors, random (seeded per run).
- API: every `ctx` surface — world/transform reads, pose/transform intents,
  control intents, signals, game counters/health/visibility, physics
  queries, animator, input, audio, save, scenes, timers, spawn/destroy
  (14.1), tags, log. Generated from the runtime's typings so new API shows
  up as nodes without hand-work.
- Macros/functions: user-defined functions (sub-graphs with inputs and
  outputs) inside a script and shared function libraries.

### 19.2 Editor

- The Graph tab: exec wires distinct from data wires, reroutes, comments,
  function tabs, variable list with visibility, compile errors on nodes.
- Debugging in Play: the running instance's active nodes highlight, wire
  values shown on hover, breakpoints pause the simulation (Play only — never
  the export), step once; watch list. Uses the Play relay; the editor never
  runs game code itself.

### 19.3 Tests and wrap-up

- Unit: compile each node kind; determinism (a graph and the equivalent
  TypeScript give the same replay). e2e: build "on trigger enter → open a
  door after 1 s, add a coin, play a sound" as a graph in the editor, Play
  it, export it; a breakpoint pauses Play on the node. Docs, STATUS row 19.

## 3. Progress

| Item | Status | Commits |
|---|---|---|
| 19.0 data and compiler | todo | |
| 19.1 node catalogue | todo | |
| 19.2 editor and debugging | todo | |
| 19.3 tests and wrap-up | todo | |

## 4. Decision log
