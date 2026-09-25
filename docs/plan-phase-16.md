# Phase 16 — Graph editor framework and centre workspace tabs

Goal: one node-graph editor framework shared by every graph in Thirdlight
(animator state machines now; materials, visual scripts and effects later),
and large editors open as tabs in the centre area next to Scene and Game,
taking over that space. The Animator and the script source editor move
there. Read `docs/roadmap.md` (principles) first.

## 1. Where things stand

- Centre area: `centerTab: 'scene' | 'game'` in `editor/src/ui/App.tsx`;
  the stage below assumes the viewport canvas or the Play iframe.
- Bottom dock: `BOTTOM_TABS` in `App.tsx` (Assets, Materials, Environment,
  Lighting, Animator, Input, Game flow, Prefabs, Behaviors, Gameplay, Tags,
  Media, Problems); sizes in `editor/src/ui/layout.ts`.
- The Animator (`editor/src/ui/AnimatorPanel.tsx`) is an SVG state graph in
  the bottom dock with a side inspector and a live preview canvas.
- Behaviors: TypeScript module sources ("source graph container", compiled by
  `packages/behavior-build` in the backend) edited as a raw JSON textarea.

## 2. Decisions (owner, 2026-09-24)

- Graph editors (animation state graph, material graph, effects graph,
  visual scripts) are tabs that take over the Scene/Game area; the Inspector
  on the right shows the selected node/edge; the bottom dock stays.
- The framework is generic: it knows nodes, typed ports, edges, groups,
  comments; each graph kind supplies its node catalogue and rules.

## 3. How to work

`docs/roadmap.md` → "How every phase is worked".

## 4. Work items

### 16.0 Centre workspace tabs

- The centre area holds Scene, Game and any number of document tabs
  (closable, reorderable, remembered per project in the layout storage):
  "Animator: <controller>", "Script: <behavior>", later "Material: …",
  "Effect: …", "Graph: …". Opening a document that is open focuses its tab.
  Scene and Game cannot be closed. Keyboard: Ctrl+Tab cycles.
- Maximize (hide docks) toggle for the centre area.
- Double-click an animator controller, behavior, material (later) in its
  list or asset tile opens its tab.
- e2e: open two document tabs, switch, close, reload keeps them.

### 16.1 Graph framework (`packages/editor/src/graph/`)

- Rendering: canvas or SVG + DOM overlay — choose for 2000 nodes at 60 fps
  in the editor (measure; log the choice). Pan (middle/space-drag), zoom to
  cursor, fit to selection, minimap, grid snapping.
- Model: nodes (id, kind, position, collapsed, ports from the kind's
  schema), typed ports (type compatibility table from the graph kind,
  implicit conversions shown), edges, reroute points, groups (frames with a
  title and colour), comments.
- Editing: box select, multi-drag, copy/cut/paste (also across tabs of the
  same kind), duplicate, delete, alignment, search-to-add (right click or
  Space: a filterable node catalogue with categories), drag from a port to
  empty space opens the catalogue filtered to compatible nodes.
- Every edit is a backend command on the owning document (one undo step per
  gesture; drags coalesce), so MCP and several clients see the same graph.
- Problems: per-node errors/warnings from the graph kind's validator shown on
  the node and in the Problems tab; click jumps to the node.
- Accessible: nodes and ports focusable, keyboard move, labels for tests.
- Unit tests for the model (connect rules, cycles where not allowed,
  copy/paste id remapping); e2e for the gestures on a test graph kind.

### 16.2 Animator on the framework

- The animator controller becomes a graph kind: state and blend-tree nodes,
  "Any State" and "Entry", transition edges (several per pair shown as one
  with a count), the side inspector moves to the right Inspector; the live
  preview (9.7 wrap-up) becomes a dockable preview pane inside the tab.
- Blend trees open as a sub-graph (breadcrumb navigation); layers from
  phase 14.6 are tabs inside the document.
- Data format unchanged except node positions/groups/comments (optional
  fields; old projects open with auto-layout).
- The bottom-dock Animator tab becomes a controller list that opens tabs.
- e2e: the existing `animator.e2e.ts` flows move to the tab and still pass.

### 16.3 Script editor tab

- A code editor tab for behavior sources: a pinned editor library
  (CodeMirror 6 preferred for size; pin exact versions, add to
  `tools/check-deps.mjs`, respect boundaries), TypeScript syntax, the
  behavior API typings for completion (generated from the runtime's
  `BehaviorContext` types into a `.d.ts` shipped with the editor),
  multi-file sources (the source graph container's files as a file list).
- Diagnostics from the backend compiler shown inline (compile on save and
  on a short idle debounce through the existing compile path).
- The declaration editor of 15.4 docks beside the code.
- e2e: edit a script, see a compile error inline, fix it, Play runs it.

### 16.4 Wrap-up

- `docs/deployment.md`: workspace tabs, graph editing gestures, the Animator
  and script tabs; STATUS row 16.

## 5. Progress

| Item | Status | Commits |
|---|---|---|
| 16.0 centre workspace tabs | done 2026-09-24 | 2eb1761 |
| 16.1 graph framework | done 2026-09-24 | 078d519, d6a13cf |
| 16.2 Animator on the framework | done 2026-09-25 | a0dc1db, 71db74b |
| 16.3 script editor tab | done 2026-09-24 | f152953 |
| 16.4 wrap-up | todo | |

## 6. Decision log

- 2026-09-24 (16.0): the tab model is a pure reducer (`editor/src/session/workspace-tabs.ts`, unit-tested); a document is `{kind, id}` and a document kind (`editor/src/ui/workspace/kinds.tsx`: label, icon, name, render) is all a later phase adds — plus a field on `WorkspaceHost` when its view needs app data. Why: the tab strip, storage, closing, reordering and Ctrl+Tab stay generic.
- 2026-09-24 (16.0): "remembered per project in the layout storage" = localStorage key `thirdlight.workspace.v1.<projectId>` (like the dock sizes and the hierarchy folders); unknown kinds and malformed entries are dropped on load; the Game tab is not restored as active (it is empty until Play); Reset layout clears every project's tabs. Why: layout is presentation, never project data.
- 2026-09-24 (16.0): documents render over the viewport (an opaque layer inside the stage, below notices); the canvas stays laid out so the viewport never resizes to zero, and only the active document is mounted (a tab switch resets transient view state such as the live preview). Why: simplest correct behaviour; 16.2 revisits the Animator's preview pane.
- 2026-09-24 (16.0): with a document in front the scene's keyboard shortcuts (Delete, W/E/R, F, copy/paste/duplicate) are off; undo/redo stay global. Why: a Delete aimed at the animator must not delete the hidden scene selection.
- 2026-09-24 (16.0): the Animator tab hosts the existing AnimatorPanel in document mode (one controller, no picker/create buttons; deleting the controller closes the tab); the dock Animator gains a controller list (double-click opens the tab) and "Open in tab". The Script tab hosts the existing Behaviors view in document mode (no list); while it is in front the app selects that behavior, because the stage/acknowledge/publish flow acts on the selected behavior. Why: real, working views now; 16.2/16.3 replace their insides.
- 2026-09-24 (16.0): Ctrl+Tab / Ctrl+Shift+Tab are handled in the capture phase, also while typing; Chrome delivers them to the page in Playwright but may keep them for its own tabs in a normal window (unverified by a person), so Window → Next/Previous tab exists too. Middle click closes a tab; the maximize state is remembered with the tabs.
- 2026-09-24 (16.0): the dock Animator's controller-name box is now keyed by the name too, so a rename made in the tab shows in the dock (it kept the old text before).
- 2026-09-24 (16.3): editor library CodeMirror 6, exact pins @codemirror/state 6.7.6, view 6.43.13, language 6.12.4, commands 6.11.1, autocomplete 6.20.3, lint 6.9.7, search 6.7.2, lang-javascript 6.2.5, @lezer/common 1.5.3, highlight 1.2.4, lr 1.4.10, javascript 1.5.5 (in `tools/check-deps.mjs` and the editor row of `tools/check-boundaries.mjs`; transitive style-mod/w3c-keyname/crelt/find-cluster-break are pinned by the lockfile). Why: modular, small, TS grammar included; Monaco is ~5x larger and wants workers.
- 2026-09-24 (16.3): bundle impact — the (unminified, per the pinned build options) editor bundle grows by ~1.25 MB (~5.5 MB → ~6.7 MB, +23%): CodeMirror/lezer ~1.08 MB, the script UI + generated typings ~0.17 MB. The preview bundle has no CodeMirror (checked: 0 occurrences), and the export bundle graph cannot reach editor code (exporter metafile check). Why: recorded as the plan asks.
- 2026-09-24 (16.3): no TypeScript language service in the browser (the `typescript` package would add ~9 MB). Completion walks a member table generated with the TS checker: `tools/gen-behavior-api.mjs` walks `@thirdlight/runtime`'s new exported `BehaviorContext` / `BehaviorSpec` / `BehaviorPrepareConfig` / `BehaviorInstanceInfo` and writes the checked-in `editor/src/ui/script/behavior-api.generated.ts` (the `.d.ts` text as `declare module '@thirdlight/runtime'`, shown read-only as `behavior-api.d.ts`, plus the member table); `tools/gen-behavior-api.test.mjs` fails when it drifts and type-checks a sample script against it. The behavior host's `ctx` object is now typed by `BehaviorContext`, so the typings cannot drift from what scripts receive. An identifier's type comes from its annotation (`x: BehaviorContext`) or the `ctx` convention. Why: real typings at no bundle cost; no semantic type errors (the backend compiler is esbuild, which does not type-check either) — logged, not faked.
- 2026-09-24 (16.3): compile on save / idle (700 ms) = the source route's new `check: true` mode (`POST …/content/behaviors/source {check, behaviorId, bytesBase64, declaration?}`): the same backend compiler instance, nothing written (no stage, blob, derived cache, revision, Problems entry), and no per-digest trust gate — the gate guards the runnable artifact of preparation/publication, and a check produces none. Compile failures now carry every esbuild error with path and 1-based line/column (was: the first error, position only in the text). `GET …/content/behaviors/:id/source` returns the published container (verified blob read). Why: diagnostics need a compile without a publication; no second compile path.
- 2026-09-24 (16.3): publishing from the tab = stage → (new digest: the trust notice, then `acknowledgeBehaviorTrust`) → the existing source route (one `publishBehavior`, one undo). The acknowledgment stays its own command and its own click. Why: the trust decision is per exact digest by contract; folding it into the publish would acknowledge silently.
- 2026-09-24 (16.3): unpublished edits live in an app-level in-memory map per behavior (kept across tab switches, lost on reload); a new behavior starts from a template that imports `BehaviorContext` (so `@thirdlight/runtime` is added to requiredModules automatically whenever a file imports from it) and uses the published JSON declaration, or declares one property in code when there is none (a behavior needs 1..32). File names follow the compiler's container grammar and are checked in the editor first. Owned transforms are edited beside the code. Why: the backend owns project data; a draft is not project data until published.
- 2026-09-24 (16.3): the Script tab no longer hosts BehaviorPanel in document mode; the bottom-dock Behaviors panel (list, raw JSON staging) is unchanged.
- 2026-09-24 (run): 16.3 was built in parallel with 16.1 and merged first (it only needs 16.0's tabs); items were started in order, only the merge order differs.
- 2026-09-24 (16.1): rendering = one 2D canvas (grid, groups, comments, wires, nodes, culled to the view, redrawn once per change burst) + a DOM layer of focusable node/port elements for the nodes in view (none beyond 400 in view; the canvas still draws all) — measured with `tools/bench-graph-render.mjs` at 2000 nodes / 2000 wires in the pinned Chromium on this host (CPU raster, SwiftShader), median / p95 frame ms while panning+zooming: all in view canvas 16.7 / 16.8–33, SVG+DOM 33 / 2600–3150, canvas+DOM layer 16.7 / 33–67; ~100 in view: all three 16.7 / 16.7. SVG+DOM cannot hold 60 fps zoomed out; the canvas keeps it and the DOM layer adds focus, screen-reader labels and test hooks. In the editor the layer is moved by one CSS transform during a pan/zoom and rebuilt 60 ms after the view settles. The graph e2e loads a 2000-node graph and logs the per-step time (zoom ~70 ms, pan ~20–30 ms per step including Playwright's round trip on the CPU-rastered page).
- 2026-09-24 (16.1): the graph model lives in project-model (`graph.ts`: data types, kind definitions as data, structural validation, canonical form, op application with exact inverses) and the kinds in `GRAPH_KINDS` (`graph-kinds.ts`). The editor may import project-model types only (dependencies.md §4.1), so it gets the kinds from `queryGameConfig` (with the descriptors, `graphKinds`) and advances its copy from the change's ops with its own projection (`editor/src/graph/model.ts`), kept equal to the backend by `tests/graph-parity.test.ts`; diagnostics (the kind's rules as per-node errors/warnings) and the copy/paste/align/group builders are editor code over the kind data.
- 2026-09-24 (16.1): one generic command set: `graphEdit {owner: {kind, id}, ops}` (ops addNodes, removeNodes — takes its wires —, moveNodes — nodes, comments and groups —, setNodeData, setCollapsed, connect, disconnect, setReroutes, setGroups, removeGroups, setComments, removeComments; ≤ 512 per edit) applied atomically, validated against the owner's kind, one revision and one undo step; the change carries the applied ops and the undo the inverse ops (deltas, not whole graphs, so a move in a 2000-node graph is a small record). Clients choose item ids (so one edit can add nodes and wire them); ids are unique across a graph's nodes, edges, groups and comments. Refusals (unknown type/port/field, bad field value, incompatible port types, a second wire into a single input, a cycle in a kind without cycles, budgets) change nothing; diagnostics never refuse.
- 2026-09-24 (16.1): owners — graphs are stored inside the owning document; owner kinds are adapters in `commands/src/graph-ops.ts` (`GRAPH_OWNERS`). Chosen for now: a minimal generic `content.graphs[]` (v4, optional, absent when empty) of standalone graph documents `{graphId, kind, name, graph}` (owner kind `graph`, `setGraph`/`deleteGraph` with undo, ≤ 64), because the e2e must drive the real backend and a test-only owner could not be registered there. The animator (16.2), material (18), behavior (19) and effect (20) owners register next to it with the same op set. Standalone graphs are not exported (no runtime meaning yet).
- 2026-09-24 (16.1): the neutral test kind `test` ("Test graph": constants, toggle, vector, add, multiply, sum-all (multi input), scale, select (enum field), label (string field), one required output; types number/vector/boolean + wildcard any; conversions number→vector and boolean→number; no cycles; sink = output) is registered in `GRAPH_KINDS` like any kind so the framework is testable end to end; it is labelled as the framework's test kind in the Graphs list and the docs.
- 2026-09-24 (16.1): node positions are a node's top-left in graph units; the grid is 20 units (snapping and keyboard steps); a node is 180 wide, its height from its port rows and up to two field rows. Wire reroute points are stored on the edge (`reroutes`), not as reroute nodes. Groups are frames (`rect`) — membership is geometric: dragging a group's title moves the nodes and comments inside its frame in the same edit. Field values equal to the default are not stored.
- 2026-09-24 (16.1): host until 16.0 lands — a bottom-dock **Graphs** list opens a graph as a closable "Graph: <name>" centre tab beside Scene/Game (a minimal stand-in for 16.0's document tabs), and the right dock shows `GraphInspector` for the selection while that tab is active. `GraphEditor` is self-contained (`kind`, `owner`, `graph`, `onEdit(ops) → Promise<error | null>`, optional `onSelection`, `focus`), so 16.0/16.2 can host it in their tabs. The editor's clipboard is per graph kind in memory (pastes across tabs/graphs of one kind in the same page). Graph edits from one editor are sent one at a time (each after the previous one is applied locally) so a burst of gestures never races its own revision.
- 2026-09-24 (16.1): deferred — dynamic ports (a node whose ports depend on its data, e.g. a function call in phase 19) are not in the model yet: ports come from the node type only; the kind that needs them adds an optional per-node port list then.
- 2026-09-24 (16.0+16.1 integration): 16.1's temporary "Graph: <name>" centre tab is replaced by a `graph` document kind in the 16.0 registry (`kinds.tsx`; `WorkspaceHost.graph` carries graphs, kinds, the queued `graphEdit` path, the selection callback and the Problems-jump focus). The right dock shows `GraphInspector` whenever the active tab is a graph whose kind is known. A graph tab closes when its graph is gone (deleted here, by MCP, or undone), but only after the first full state has loaded the graphs (the game-block query), so a remembered tab survives a reload. Graph tabs use an inline SVG node glyph as the tab icon (no bitmap icon fits).
- 2026-09-25 (16.2): the animator is owner kind `animator` in `GRAPH_OWNERS` (commands/src/graph-ops.ts) with three graph kinds in `GRAPH_KINDS`: `animator` (base layer), `animator-layer` (override layer: adds Empty state) and `animator-blend` (a blend tree's clips). Owner ids: `<controllerId>` base layer, `<controllerId>@<n>` layer n, `<controllerId>#<stateId>` blend tree. The graph is a view read from the controller and written back (project-model `animator-graph.ts`): ops are applied to the read graph with the generic `applyGraphOps`, validated against the kind, then mapped onto the controller and validated as a controller. Why: the data format stays the controller (the runtime is untouched) and there is one op set for every graph.
- 2026-09-25 (16.2): a `graphEdit` on an animator owner records the same change `setAnimator` does (`setAnimators` previous/next; undo restores the previous list) through a new optional adapter hook `record`; the envelope accepts `setAnimators` for a recorded `graphEdit`. Why: every client (the editor's projection, MCP) already follows controllers from that change, and undo/redo need no second path; the ops are not needed to advance a view that is re-read from the controller.
- 2026-09-25 (16.2): graph ids are derived, not stored: a state node's id is the state id (new nodes: the client's id must be a valid state id — the editor's factories give lower-case ids), the fixed nodes are `ENTRY`/`ANY`/`OUT`, the entry wire `ENTRY-WIRE`, a transition wire `T` + FNV-1a of `from>to` (collisions get `-n`), blend clips/wires `C<i>`/`W<i>` in threshold order. `GRAPH_ITEM_ID_RE` grew to 64 characters (the longest state id). The editor has its own copy of the read (`editor/src/graph/animator.ts`, project-model types only), kept equal by `tests/animator-graph-parity.test.ts`. Why: data format unchanged; ids stay stable across reads.
- 2026-09-25 (16.2): one wire per ordered state pair; its transitions (conditions, crossfade, exit time, interruption, priority order) stay controller data edited in the Inspector with `setAnimator` (generic graph edges have no data, and conditions are lists). Connecting a new pair adds one transition at exit time 1 with a 0.1 s crossfade (plays the source to its end, a short blend — the 9.7 panel's "Make transition" default); disconnecting removes the pair's transitions; a pair with several shows "×n" on the wire (new `edgeLabels` prop of GraphEditor). Why: several transitions per pair shown as one, as the plan says, without a second mutation path for structure.
- 2026-09-25 (16.2): state fields are node fields (name as the node's title via the new `titleField`, clip/asset/duration, speed, speedParameter, loop; blend parameter on the blend node; threshold/clip on blend clip nodes), so the Inspector edits them with `setNodeData` through `graphEdit`. A state added without a clip plays the controller's first clip; a new blend tree starts with two copies of it at 0 and 1 on the first float/int parameter (refused without one). A copied blend tree node pastes as a new blend tree with those defaults (its clips are not in the node). Why: all node data fits the generic field types; no demo-shaped defaults.
- 2026-09-25 (16.2): framework additions for the state machine, all generic: `GraphPortDef.single` (an output with one wire; a new wire replaces it — Entry), `GraphNodeDef.fixed` (exactly one per graph, not in the catalogue, not copied or deleted — Entry, Any State, Blend), `GraphNodeDef.titleField`, `GraphKindDef.owner` (kinds owned by a document are not standalone graphs: refused by `setGraph`, hidden in the Graphs list), GraphEditor props `edgeLabels`, `highlighted`, `newNodeData`, `onOpenNode`, a focusable handle at each wire's middle ("wire A → B", keyboard selection, tests; same DOM budget as nodes) and GraphInspector `extension`/`empty`.
- 2026-09-25 (16.2): optional editor-only layout in the controller: state `position` (existing; bound widened ±1e5 → ±1e6, the graph coordinate bound), blend child `position`, and `layout {entry?, any?, output?, groups?, comments?, collapsed?}` on the controller (base layer), each layer and each blend motion; validated and canonicalized in project-model; group/comment ids may not reuse a state id or a derived id. Any graph edit stores every node's position (the auto-layout is written on the first edit). Reroute points on transition wires are refused (nowhere to store them). The content closure strips `layout` and blend child positions (`animatorsForRuntime`): the game never reads them and comment text must not reach an export (the export scan). No descriptor for `layout` (presentation, edited by graph gestures, never an Inspector field). Why: "data format unchanged except optional node positions/groups/comments; old projects open with auto-layout".
- 2026-09-25 (16.2): auto-layout = columns 260 units apart by the BFS distance from the entry state over the transitions (unreached states in the last column), rows 130 apart in state order; Entry and Any State one column left of the leftmost state. The Platformer preset's positions were spread for the 180×90 nodes (180/440/700 × 30/190; the game ignores positions). Why: deterministic, the same in the backend and the editor.
- 2026-09-25 (16.2): UI: the tab (`ui/animator/AnimatorDocument.tsx`) = name/model/delete bar, layer tabs + Add layer, a breadcrumb when a blend tree is open, parameters and layer settings on the left, the GraphEditor, and the live preview as a pane docked right or bottom or hidden (localStorage `thirdlight.animatorPreviewDock.v1`; one place in the React tree, so re-docking keeps a running preview; the states it is in are outlined in the graph). The shown graph per controller and the selection live in App, so the right dock's `AnimatorInspector` (GraphInspector + extension) shows the selection; groups/comments use the generic forms. The bottom-dock Animator is now the controller list (model picker, New controller, New from clips: Platformer — a new controller opens its tab —, Open in tab / double-click / Enter, Delete). Shared pieces moved to `ui/animator/parts.tsx`. Clip events, parameters and layers keep their 9.7/14.6 editors (setAnimator).
