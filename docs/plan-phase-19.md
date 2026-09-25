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
| 19.0 data and compiler | done 2026-09-25 | e99a7e8, 9cbccf1, 139f306 |
| 19.1 node catalogue | todo | |
| 19.2 editor and debugging | todo | |
| 19.3 tests and wrap-up | todo | |

## 4. Decision log

- 2026-09-25 (19.0): compile path = generated TypeScript fed to the one `behavior-build` compiler (`behavior-build/src/graph.ts`: graph → one `src/index.ts` in an ordinary source container) — why: one code path, so limits, output scan, engine pins, the trust gate per digest, publication and export recompilation are the TypeScript ones by construction. The generated file declares its properties in code (`export const properties`, 15.4), so the published declaration is derived from the graph's variables exactly like "code wins"; `requiredModules` and `ownedTransforms` are empty (no starter node moves anything; transform nodes and `@self` come with 19.1's catalogue).
- 2026-09-25 (19.0): data = `BehaviorRecord.graph` (v4 only, canonical, validated with the `behavior` kind; absent = not a visual script) — the editable source, edited with the generic `graphEdit` through the new `behavior` owner adapter (change = the ops, undo = the inverse ops; no record hook). The published `source` record gains `kind: "graph"` (absent = TypeScript; older records byte-identical), set from the manifest's new `sourceKind` which the compiler derives from the generator's first line (inside the digest-bound bytes). Editing never touches the published source; publishing regenerates from the stored graph. Why: a graph must be project data for the one mutation path, while a publication stays a digest-bound prepared record.
- 2026-09-25 (19.0): creating = `publishBehavior {mode: "declaration-create", graph}` (graph only at creation); a declaration-update of a visual script with a different declaration is refused (`behavior_declaration_mismatch`, reason `declared_in_graph`; a rename with the same declaration is allowed); a source publication keeps the graph. Why: its properties are its variables.
- 2026-09-25 (19.0): wiring rules are kind data checked by the generic validator: port types exec/number/boolean/string (+ `any`, see below), exec never converts; every exec output `single` (a Sequence has four outputs), exec inputs `multi`; `allowCycles: false` for the whole graph — data cycles are refused and exec loops exist only as a For node's body (no back wire needed). Semantic rules that depend on node data (variable names/uniqueness, 1–32 variables — a behavior declares 1–32 properties —, Get/Set naming a variable, Set's inline value parsing, required text arguments, an `any` port on an exec wire; unreached flow as a warning) are compile diagnostics with `nodeId` (`checkBehaviorGraph`), never edit refusals, because graphs pass through incomplete states. A graph with no variable does not compile ("declare at least one variable"); a new visual script starts with a public number variable "value".
- 2026-09-25 (19.0, after merging 18.0/18.1): variables use the framework's data-dependent ports — `var.get`/`var.set` value ports have `typeFrom: {field: "variable", lookup: "variable"}` resolved by `behaviorGraphContext(graph)` (the graph's own `var.<type>` declarations); the owner adapter gains an optional generic `contextOf(content, graph)` so an edit validates against its own result (declare + wire in one edit). The fallback type is the kind's wildcard `any` (only such ports use it) so renaming/deleting a variable never strands its wires; the compile check reports the unresolved Get/Set. Declarations stay one node type per value type (`var.number|boolean|string`) because a field's type is static (the default value field). Set's unwired value is a text field read as the variable's type. The editor repeats the lookup (`editor/src/session/behavior-graph.ts`, `tests/behavior-graph-parity.test.ts`).
- 2026-09-25 (19.0): the catalogue is data: core nodes (events, flow, maths, logic, log) and variable nodes are hand-written; API nodes are `BEHAVIOR_API_NODES` entries (`ctx` member path, optional segments read with `?.`, exec or data, typed arguments with inline defaults, result with its fallback) that both the kind and the compiler read — a new entry needs no compiler change, so 19.1 can generate the table from the runtime typings. Starter API nodes: Add to counter, Counter value, Emit signal, Signal received.
- 2026-09-25 (19.0): node ids in errors — compile: `lineNodes` maps each generated line to its node, so compiler diagnostics carry `nodeId`; run time: the generated code keeps the running node's id and tags errors with `nodeId` (+ `detail`), the behavior host copies it into its `BehaviorHostError` and the runtime into the fail-stop diagnostic entry (`DiagnosticErrorEntry.nodeId`, only for graph behaviors). Chosen over position source maps: stack positions of evaluated modules differ per browser; the tracked id is deterministic.
- 2026-09-25 (19.0): determinism — events run in the intent phase in a fixed order (On start nodes, then On step nodes; nodes of one kind by id), no clock or randomness in generated code, For bounded by 10 000 iterations per instance and step (`BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep`: far above per-step game logic, a runaway costs well under a frame) → a script error `behavior_step_failed` with `nodeId` and detail `iteration_cap`. Divide by 0 gives 0 (values stay finite). 256 nodes per visual script keep the generated file under the compiler's 64 KiB-per-file bound.
- 2026-09-25 (19.0): runtime change for all behaviors — at the start of every run (reset reasons `start` and `replay`) the behavior host disposes and re-instantiates each instance's state (same properties). Why: "On start" must run when a run starts (counters are reset then; before, code keyed to a script's first step ran during the settle steps and was wiped), and a replay should begin exactly like the first run. The Sprout play-through and every behavior test still pass.
- 2026-09-25 (19.0): the source route now sends the editor `mutation.applied` for its publication (it did not, for TypeScript sources either, so the editor's behavior list stayed stale until a resync). Graph publish = `POST …/content/behaviors/source {graph: true, …}` (the backend reads the stored graph, generates the bytes and runs the ordinary prepare + `publishBehavior`); `{check: true, graph: true, behaviorId}` compiles without writing and returns the digest the acknowledgment must cover (the generator is pure: same graph, same digest).
- 2026-09-25 (19.0): editor (minimal; 19.2 builds the real one) — Behaviors → "+ Visual script" (name → id), a `visual-script` document kind "Graph: <behavior>" = the generic GraphEditor with the behavior kind + a side panel (compile status after each change, problems with their node, Publish with the trust notice), the right-dock GraphInspector edits node fields; double-click opens a behavior with a graph as a Graph tab, others as a Script tab. Visual-script problems are not in the Problems tab yet (19.2).
- 2026-09-25 (run): 19.0 was built in parallel with phase 17.2–17.5 and 18.2–18.4 and merged first (it needs no renderer work).
