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
| 19.1 node catalogue | done 2026-09-25 | c1a254d, dbbc7d5 |
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
- 2026-09-25 (19.1): API nodes are GENERATED from the runtime typings — `tools/gen-behavior-graph-api.mjs` (a sibling of gen-behavior-api) walks `BehaviorContext` with the TS checker and writes `project-model/src/behavior-api.generated.ts` (`BEHAVIOR_API_NODES`: type `api.<ctx path>`, the `ctx` access steps, arguments, outputs); `tools/gen-behavior-graph-api.test.mjs` fails on drift. Namespaces become categories, methods and function-valued members call nodes, handle factories (`ctx.animator(id)`) one node per handle method, the `{kind}` union of `ctx.emit` one node per intent, data members getter nodes. Options objects are flattened, literal unions become choice fields, `unknown`/mixed primitives a "typed" port with a type field, `{x?,y?,z?}` a vector with an axes choice, nullable results a "found" output. Doc tags in the runtime typings steer it (`@graphNode label|skip reason`, `@graphPure`, `@graphDefault`, `@graphLabel`, `@graphAsset`, `@graphPhase`, `@graphType list`); untagged new API still becomes an exec node (always correct, a pure query just reads less conveniently). Skipped with a reason: `physics.stageCharacterMove` (controller phase only), `ctx.events` (the event nodes read it), `ctx.log` (the Log node). The runtime parameter `game.add(name, delta)` was renamed `amount` (a TS parameter name only) so 19.0 graphs keep their `amount` field. Why: one source of truth; the compiler emits every API node from its entry alone.
- 2026-09-25 (19.1): event phases — behaviors run only in the `intent` and `transform` phases (the host adds `transform` only for scripts with owned transforms; no `gameplay` phase for scripts), so every event node has a Phase field (intent default). Move/Pose object nodes are valid only when reached from transform events, control/respawn intents only from intent events (compile errors via `@graphPhase`); a transform event in a script that moves nothing is a warning. `ownedTransforms` are generated: a Move/Pose node with an empty entity → `@self`, a typed id → that id; a wired entity is a compile error (a script declares the objects it moves statically; per-object entity properties cannot be owned).
- 2026-09-25 (19.1): custom events = a new bounded runtime channel `ctx.messages` (send(name, value?, target?) / received(name)), not signals — why: signals carry no value and no target, and switches/doors listen to the same names. Like signals, a message is seen in the next step, in send order; at most 256 per step (`MAX_MESSAGES_PER_STEP`), values number/text ≤256/boolean, a new run clears them; kept in the gameplay blocks next to signals. TypeScript scripts get the same API (it is in the typings, so it is also a node).
- 2026-09-25 (19.1): execution model of the generated module — per step and phase: On start nodes first (first step of the run in that phase), then all other events and pending Delays by node id; events with several occurrences (trigger events, messages, overlapping entities) fire once each in runtime order; every firing gets a frame (outputs of exec nodes, local variables); data nodes are evaluated where read (a Random node read twice draws twice); the iteration cap (10 000) counts all loops of an instance per step across both phases; lists (1024) and maps (256) are values (nodes return new ones), over their cap a script error (`list_cap`/`map_cap`) naming the node. Random = mulberry32 seeded per object from its entity id at instantiate (state is re-instantiated each run), so every run and replay repeat the sequence — there is no run seed in `ctx` to vary it between runs (logged, generic, deterministic).
- 2026-09-25 (19.1): Delay = a timer `vs.delay.<n>` of the script (`ctx.timers.after`); a new arrival while waiting is ignored; the frame is kept, so values from before the Delay stay readable; the continuation runs in its phase at its node-id place. Delay is not in function graphs (a call returns within its step) and must be reached from one phase.
- 2026-09-25 (19.1): Switch has six fixed cases (+ default) — node ports are static data in the graph framework (only types can depend on data), so cases are fields case1..case6 and a longer switch chains Switches. "Switch on enum" = text mode (choice variables hold their text).
- 2026-09-25 (19.1): value types number, boolean, text, vector ([x,y,z]), list, map (+ the `any` of an unresolved Get/Set). Variable kinds: number, boolean, text, vector (vec3 property), entity (entityRef property; a text id at run time — its triggers are owned by the script), choice (enum property, comma-separated choices), list, map (never properties: private = per object, or local). Visibility gains `local` (not a property; one per event run / function call).
- 2026-09-25 (19.1): functions — in-script functions are `BehaviorRecord.functions` (`{functionId, graph}` sorted, kind `behavior-function`, owner id `<behaviorId>#<functionId>`); shared function libraries are standalone graphs of kind `behavior-library` (one graph per function, like material functions). Both use the 18.1 framework interface (`fn.input`/`fn.output` nodes → the call node's ports via `portsFrom`) and the context `graph` lookup; a function exists while its graph has nodes (the first graphEdit that adds nodes creates it, removing the last removes it) — why: no new op, undo/redo are the generic inverse ops. A script function reads/writes the script's variables (its own declarations are locals); a shared function sees only its inputs/locals. Call cycles are compile errors; a function or library change that breaks a caller's wires is refused naming the script. The shared functions a script calls are compiled into its source (part of the digest). A new call node picks the first function (function tabs: 19.2).
- 2026-09-25 (19.1): the 19.0 limitation "a visual script needs at least one variable" is gone: the declaration minimum was lowered from 1 to 0 everywhere it was checked (content validation, publishBehavior, compiler, code-declaration reader, runtime host, editor draft) — nothing needed at least one property; a new visual script starts with On start only. Tests that pinned the old refusal now pin acceptance.
- 2026-09-25 (19.1): the compiler escapes one character of any generated string literal ending in `from`/`import` or containing `import(`/`eval(`/`require(`/`Function(` (the behavior compiler's import scan reads them anywhere in a file, e.g. an output port named "from"); TypeScript authors hit the same scan by hand.
- 2026-09-25 (19.1): the 19.3 e2e is done here: `tests/e2e/visual-script.e2e.ts` builds "on trigger enter → Start timer → On timer → Set visible (this object) → Add to counter → Play sound" from the catalogue search, publishes and plays it (coin counted, door pixels gone). Not done here: the export of that graph and the breakpoint (19.2/19.3); the sound request is not observable headless (unverified).
- 2026-09-25 (19.1): the generated source is several files — `src/index.ts` (banner, properties, event dispatch), `src/graph-runtime.ts` (helpers) and `src/graph-nodes-<n>.ts` (node functions, ~40 KB each; each exports `install(N)` registering into a table the entry owns, so the files import only the helpers and no cycles) — why: a script at the 256-node budget generated ~80 KB, over the compiler's 64 KiB-per-file bound (19.0's one file would not fit the richer nodes); functions and shared functions share the same chunks; compile diagnostics map back to nodes per file (`lineNodes` per path). The output bound (128 KiB) and total source bound (256 KiB) stay the engine limits for very large scripts with many functions.
