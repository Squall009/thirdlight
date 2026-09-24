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
| 16.1 graph framework | todo | |
| 16.2 Animator on the framework | todo | |
| 16.3 script editor tab | todo | |
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
