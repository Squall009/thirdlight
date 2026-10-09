# Visual scripts

Scripts written as node graphs: the editor tab, events, flow, data,
variables, functions and shared functions, publishing, and debugging in
Play. Step by step: [the visual script guide](../guides/visual-scripts.md).
Every node: [Visual script](../reference/graph-behavior-1.md).

## The visual script tab

A behavior can be written as a node graph instead of TypeScript. File → Project Settings… → **Scripts**: type a name next to **+ Visual script**
and press it; the new behavior opens in the editor window as a **Graph: <name>** tab (the
[graph editor](editor.md#graph-editing), with the visual-script catalogue) holding an **On
start** node (a script needs no variable: a behavior may declare no
property). Double-click a visual script's tile (it says "visual script") to
open it again. Right click (or Space, or **+ Node**) opens the catalogue
with its search; the Inspector on the right edits the selected node's
fields.

The tab has three parts:

- **Graph tabs** along the top: **Event graph** (the script's events) and
  one **ƒ** tab per function of the script. **+ Function** asks for a name
  and creates the function with its **Function start** node; double-click a
  function's tab to rename it (the name of its Function start; calls keep
  pointing at it); **×** deletes it (refused while a Call function uses its
  ports). A problem or a breakpoint inside a function opens its tab.
- **Left: Variables** of the graph in front (inside a function: its local
  variables) — the name, the type (Number, Boolean, Text, Vector, Entity,
  Choice, List, Map) and the visibility (public / private / local; lists
  and maps are private or local) are edited in place, each change one
  undoable edit (renaming also renames the Get/Set nodes of that graph that
  name it). **+ Variable** adds one, **×** deletes it, **edit** selects its
  node (the Inspector edits its default, label, group and tooltip), **watch**
  puts it on the debugger's watch list. Drag a variable by its **≡** onto
  the graph and pick **Get** or **Set** for a Get/Set variable node there.
  Below: the project's **shared functions** (click one to open it in its
  own Graph tab) and **+ Shared function**.
- **Right:** the compile status, the problems, **Publish** and the
  **debugger** (below).

Exec wires (the flow: which node runs next) are drawn thick with arrows
pointing along the flow; data wires are thinner and coloured by type.
Reroute points (double-click a wire), comments and groups work as in every
graph. Compile problems show as a badge on their node, in the list beside
the graph and in the bottom dock's **Problems** tab ("script error"/"script
warning"; a click opens the script's Graph tab at the node).

- **Events** start the flow along the white **exec** wires. Each event has
  a **Phase**: *intent* (decide: counters, timers, signals, control) or
  *transform* (move objects — it runs only in scripts that move something).
  **On start** (the first step of every run: a new game or a replay starts
  with fresh script state), **On step**, **On signal**, **On trigger**
  (enter or exit of a trigger the script owns: on its object, below it, or
  named by one of its entity variables), **On overlap** / **On raycast** (a
  query around the object every step: an entity starts or stops
  overlapping/being hit, or each step), **On input** (an input action
  pressed, released or held), **On animator event** (a clip event), **On
  timer** (one of the script's timers fired), **On message** (a message
  another script sent). Each step the On start nodes run first, then every
  other event in a fixed order; an event with several occurrences in a step
  runs once per occurrence.
- **Flow:** each exec output takes one wire (a **Sequence** has four
  outputs, run top to bottom); an exec input takes any number. **Branch**,
  **For** (first..last), **For each** (the items of a list), **While** (the
  condition is read again before each round), **Gate** (enter/open/close/
  toggle), **Do once** (with reset), **Delay** (continues after the given
  seconds, counted in fixed steps; values from before it are kept),
  **Switch** (text or whole number: its **Cases** field is a comma-separated
  list — one exec output per case, up to 32, plus default; an empty case
  never matches), **Select**
  (a or b). A script may run at most 10 000 loop iterations per step (all
  loops, functions included) — more stops the play with a script error
  naming the loop node.
- **Data:** coloured wires carry numbers, true/false, text, vectors (x, y,
  z), lists and maps (a number or true/false feeds a text input as text,
  true/false feeds a number as 1/0, a number feeds a vector as (n, n, n), a
  vector feeds text as "x, y, z"). An input without a wire uses the value
  set on the node. Graphs have no cycles: repetition happens only inside
  the loop nodes. Constants, maths (incl. modulo, power, min/max, rounding,
  clamp, lerp, sine/cosine/angle in degrees), logic, text, vectors, lists
  (at most 1024 items) and maps (text keys, at most 256 entries) — list and
  map nodes never change a value, they give a new one (store it with Set
  variable) — and **Random** number / integer / chance: each object draws
  from its own sequence, which starts again with every run, so a replay
  repeats it exactly.
- **Script API:** every call and value a TypeScript script reaches on `ctx`
  is a node — game counters, health and visibility, signals, messages,
  timers, physics queries (raycast, overlap, character result), tags, world
  transforms, scenes, input actions, animators, sounds, the save, spawning
  prefabs and removing spawned objects, the intents (control move/jump,
  respawn, **Move object** and **Pose object**) and values such as This
  object, Step index and the settings. They are generated from the runtime's
  typings (new script API appears as nodes without hand work). An empty
  entity means **this object**; **Play sound** picks from the project's
  audio. **Move object** / **Pose object** run in the transform phase only:
  with an empty entity the script moves its own object (it owns "@self");
  a typed entity id is owned by the script (at most 16 objects).
- **Messages:** **Send message** (name, a number/text/true-false value,
  optionally one target entity) reaches **On message** of every script (or
  the target's) in the next step; at most 256 messages per step. TypeScript
  scripts use the same `ctx.messages.send` / `received`.
- **Variables:** Number, Boolean, Text, Vector, Entity (an entity id; as a
  property it is picked in the Inspector), Choice (one of listed texts),
  List and Map variable nodes; the name is the property key (lower case,
  a-z, 0-9, _). **Public** variables are the script's properties — shown
  and set per object in the Inspector; **private** ones are per object and
  start at their default; **local** ones live for one event run (lists and
  maps are private or local). **Get variable** / **Set variable** name a
  variable; their value port takes its type (a Get naming no variable is
  grey and connects to anything until fixed). The script's properties come
  only from its public and private variables (at most 32).
- **Functions:** a script can have functions — graphs with a **Function
  start**, **Input** nodes and **Output** nodes (name and type); **Call
  function** runs one: its ports are the function's Inputs and Outputs (read
  when the function's flow has finished). Variables declared in a function
  are local to one call; a function may use the script's variables.
  **Shared functions** are graphs of kind "behavior-library" in the
  project's graph list, called from any script with **Call shared
  function** (they see only their own inputs and locals). Functions may not
  call each other in a cycle. A new Call function picks the script's first
  function; its **Function** field (and a Call shared function's) is a
  list of the functions by name.
- **Check and publish:** a moment after each change the backend compiles
  the script with its functions and the shared functions it calls (to
  TypeScript, with the same compiler, limits, output scan and engine pins as
  a TypeScript script; the shared functions' code is part of the published
  digest); problems are listed beside the graph with their node (click one
  to frame it) — e.g. an empty counter name, a Get naming no variable, a
  Move object reached from an intent event, a node no event reaches (a
  warning). **Publish** shows the trust notice for a new digest, then
  publishes (one `publishBehavior`, one undo step); Play and exports run the
  published script, which the stored source record marks `kind: "graph"`.
  Editing the graph (or a shared function) never changes the published
  script until you publish again.
- **Errors in Play:** a script error from a visual script names the node
  that was running (`nodeId` in the play diagnostics and `tl_diagnostics`;
  `fn:<function>/<node>` or `lib:<graph>/<node>` inside a function).

## Debugging visual scripts in Play

While Play runs, the Graph tab's **Debug (Play)** panel watches one
object's instance of the script: pick it under **Object** (the object
selected in the scene is picked when it carries the script). The editor
never runs game code: four times a second it asks the running Play over
the preview relay.

- **Active nodes:** the nodes that ran in the last half second light up
  (gold outline), and exec wires between them glow.
- **Wire values:** hover a data wire to see the last value that moved along
  it (numbers to 3 decimals, vectors "x, y, z", lists and maps by size and
  first items).
- **Breakpoints:** select nodes and press **F9** (or **● Breakpoint** in the
  graph toolbar) — a red dot. When a node with a breakpoint runs, Play
  pauses right after that step (the same step at any frame rate); the
  paused node gets a green outline and a ▶, the panel says "Paused at step
  N on <node> (<object>)" and the wire values and the watch list show that
  step. **Step once** runs exactly one step and pauses again; **Resume**
  lets the game run on; **Pause** holds it at the next step boundary. The
  breakpoint list under the buttons jumps to a node (click) or removes it
  (×). Breakpoints stay while the editor page is open (they are not project
  data). Closing the tab resumes a paused game.
- **Watch:** the variables ticked "watch" with their values (per-object
  variables, and the last value of a local).
- **What runs:** Play builds each published visual script as a *debug
  build* — the same graph, compiled by the same compiler, that also records
  its trace (at most 256 node entries per step), wire values and locals —
  but only while the graph still generates exactly the published source;
  after unpublished edits Play runs the published script without debugging
  and the panel says to publish and restart Play. Exports never contain
  debug builds or breakpoints: an exported game runs the published module
  byte for byte. A pause never changes what the game computes (the same
  steps run with the same input, only later).
- **MCP:** `tl_game_observe` shows `debug {paused, stepIndex, breakpoints,
  hit {behaviorId, entityId, nodeId}}` while the editor debugs or the game is
  held; `tl_game_control` takes `debugPause`, `debugResume` and `debugStep`.
  Breakpoints are set in the editor only.

## Through the API

Every graph gesture is one `graphEdit {owner: {kind: "behavior", id:
behaviorId}, ops}` command (one undo step; MCP edits appear in the open tab).
A script's function is owner id `"<behaviorId>#<functionId>"` (kind
`behavior-function`): the first edit that adds nodes to a new id creates the
function, removing its last node removes it. Shared functions are `setGraph
{graph: {graphId, kind: "behavior-library", name, graph}}` and `graphEdit
{owner: {kind: "graph", id}}` (a change that breaks a script calling it is
refused, naming the script). MCP creates a script with `publishBehavior
{mode: "declaration-create", …, graph: {nodes, edges}}`; publishing is
`tl_script_publish {behaviorId, graph: true, displayName, expectedRevision}`
(over HTTP `POST /api/v1/projects/<id>/content/behaviors/source {graph: true,
behaviorId, displayName, expectedRevision, requestId}`; `check: true` with
`graph: true` compiles without publishing and returns the `sourceDigest`;
a new digest must be acknowledged first with `acknowledgeBehaviorTrust
{sourceDigest}`, the same step the editor's trust notice takes). The
published record (`tl_content_query target="behaviors" behaviorId
includeDeclaration: true`) shows `source.kind: "graph"`; attach the script
with `setBehaviorProperties` and play it with `tl_play_start` like any
behavior. Limits: 256 nodes per graph and 32 functions per script (its
variables are bounded only by the declaration's 32 KiB, see
[Script properties](scripting.md#script-properties-public-and-private)); Delay
nodes use timers named `vs.delay.<n>`.

**Exports:** an exported game runs a visual script exactly like a
TypeScript one — the published module is part of the export (a
`behaviors/<digest>.js` file) and runs from a plain static server with no
editor backend; debugging exists in Play only.
