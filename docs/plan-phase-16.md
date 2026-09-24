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
| 16.0 centre workspace tabs | todo | |
| 16.1 graph framework | todo | |
| 16.2 Animator on the framework | todo | |
| 16.3 script editor tab | todo | |
| 16.4 wrap-up | todo | |

## 6. Decision log

- 2026-09-24 (16.1): rendering = one 2D canvas (grid, groups, comments, wires, nodes, culled to the view, redrawn once per change burst) + a DOM layer of focusable node/port elements for the nodes in view (none beyond 400 in view; the canvas still draws all) — measured with `tools/bench-graph-render.mjs` at 2000 nodes / 2000 wires in the pinned Chromium on this host (CPU raster, SwiftShader), median / p95 frame ms while panning+zooming: all in view canvas 16.7 / 16.8–33, SVG+DOM 33 / 2600–3150, canvas+DOM layer 16.7 / 33–67; ~100 in view: all three 16.7 / 16.7. SVG+DOM cannot hold 60 fps zoomed out; the canvas keeps it and the DOM layer adds focus, screen-reader labels and test hooks. In the editor the layer is moved by one CSS transform during a pan/zoom and rebuilt 60 ms after the view settles. The graph e2e loads a 2000-node graph and logs the per-step time (zoom ~70 ms, pan ~20–30 ms per step including Playwright's round trip on the CPU-rastered page).
- 2026-09-24 (16.1): the graph model lives in project-model (`graph.ts`: data types, kind definitions as data, structural validation, canonical form, op application with exact inverses) and the kinds in `GRAPH_KINDS` (`graph-kinds.ts`). The editor may import project-model types only (dependencies.md §4.1), so it gets the kinds from `queryGameConfig` (with the descriptors, `graphKinds`) and advances its copy from the change's ops with its own projection (`editor/src/graph/model.ts`), kept equal to the backend by `tests/graph-parity.test.ts`; diagnostics (the kind's rules as per-node errors/warnings) and the copy/paste/align/group builders are editor code over the kind data.
- 2026-09-24 (16.1): one generic command set: `graphEdit {owner: {kind, id}, ops}` (ops addNodes, removeNodes — takes its wires —, moveNodes — nodes, comments and groups —, setNodeData, setCollapsed, connect, disconnect, setReroutes, setGroups, removeGroups, setComments, removeComments; ≤ 512 per edit) applied atomically, validated against the owner's kind, one revision and one undo step; the change carries the applied ops and the undo the inverse ops (deltas, not whole graphs, so a move in a 2000-node graph is a small record). Clients choose item ids (so one edit can add nodes and wire them); ids are unique across a graph's nodes, edges, groups and comments. Refusals (unknown type/port/field, bad field value, incompatible port types, a second wire into a single input, a cycle in a kind without cycles, budgets) change nothing; diagnostics never refuse.
- 2026-09-24 (16.1): owners — graphs are stored inside the owning document; owner kinds are adapters in `commands/src/graph-ops.ts` (`GRAPH_OWNERS`). Chosen for now: a minimal generic `content.graphs[]` (v4, optional, absent when empty) of standalone graph documents `{graphId, kind, name, graph}` (owner kind `graph`, `setGraph`/`deleteGraph` with undo, ≤ 64), because the e2e must drive the real backend and a test-only owner could not be registered there. The animator (16.2), material (18), behavior (19) and effect (20) owners register next to it with the same op set. Standalone graphs are not exported (no runtime meaning yet).
- 2026-09-24 (16.1): the neutral test kind `test` ("Test graph": constants, toggle, vector, add, multiply, sum-all (multi input), scale, select (enum field), label (string field), one required output; types number/vector/boolean + wildcard any; conversions number→vector and boolean→number; no cycles; sink = output) is registered in `GRAPH_KINDS` like any kind so the framework is testable end to end; it is labelled as the framework's test kind in the Graphs list and the docs.
- 2026-09-24 (16.1): node positions are a node's top-left in graph units; the grid is 20 units (snapping and keyboard steps); a node is 180 wide, its height from its port rows and up to two field rows. Wire reroute points are stored on the edge (`reroutes`), not as reroute nodes. Groups are frames (`rect`) — membership is geometric: dragging a group's title moves the nodes and comments inside its frame in the same edit. Field values equal to the default are not stored.
- 2026-09-24 (16.1): host until 16.0 lands — a bottom-dock **Graphs** list opens a graph as a closable "Graph: <name>" centre tab beside Scene/Game (a minimal stand-in for 16.0's document tabs), and the right dock shows `GraphInspector` for the selection while that tab is active. `GraphEditor` is self-contained (`kind`, `owner`, `graph`, `onEdit(ops) → Promise<error | null>`, optional `onSelection`, `focus`), so 16.0/16.2 can host it in their tabs. The editor's clipboard is per graph kind in memory (pastes across tabs/graphs of one kind in the same page). Graph edits from one editor are sent one at a time (each after the previous one is applied locally) so a burst of gestures never races its own revision.
- 2026-09-24 (16.1): deferred — dynamic ports (a node whose ports depend on its data, e.g. a function call in phase 19) are not in the model yet: ports come from the node type only; the kind that needs them adds an optional per-node port list then.
