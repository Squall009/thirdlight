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
