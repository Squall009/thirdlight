# Phase 27 — Editor layout: full-window editors, Project Settings, per-scene environment

Goal: the default editor view is the Scene (or Game) view with the
Hierarchy, the Inspector and the project window, and nothing else. An item
is edited in a full window opened by double-clicking it, not in a strip at
the bottom of the screen. Project-wide settings live in one Project Settings
window; scene tools (Lighting, Environment) open from the Window menu. Each
scene has its own environment (sky, fog, post, wind). The graph, material,
effect and other editors look designed, so a person would rather use them
than the API. Read `docs/roadmap.md` (principles 1, 1b and 2) first.
Phase 27 starts after phase 26; scalable lighting (phase 28) follows and
builds on the per-scene environment. Requests: the owner.

## 1. Owner decisions (2026-09-30)

- **No tab for a thing that only shows something when an item of its kind
  is open.** Double-clicking a material, effect, graph, timeline, animator
  controller, dialogue, script, library, UI document or theme opens it in a
  **full window over the editor**. Closing it returns to the default view.
- **One split in that window:** the item's editor on the left, the
  Inspector on the right (the same Inspector the default view uses, not a
  copy per editor). Editors that preview share **one preview pane** above
  the Inspector, from one renderer path, instead of each writing its own.
- **Project settings are not tabs.** File → Project Settings opens a full
  window with sub-tabs (Gameplay, Input, Tags, Saves, …).
- **Lighting and Environment are scene settings, not project settings.**
  They open from the Window menu, next to File, and say which scene they
  apply to.
- **Environment is per scene.** Games have different skies and fog per
  scene; one project-wide environment doesn't fit.
- **Icons and a visual pass** for the graph, material, effect and other
  editors, which today look tacked on.
- This phase comes before scalable lighting (it is smaller, and lighting
  would otherwise add its settings to the old layout).

## 2. Where things stand (checked at `dd3aa69c`, 2026-09-30, end of phase 26)

- **The bottom dock has 23 tabs** (`BOTTOM_TABS`, `editor/src/ui/App.tsx`):
  Assets, Materials, Environment, Lighting, Animator, Input, Prefabs,
  Behaviors, Gameplay, Tags, Saves, Media, Graphs, Effects, Dialogue,
  Timelines, Libraries, Console, UI, Game modes, Game shell, Blocks,
  Problems. The Window menu lists all 23 as well. The dock is about 30% of
  the screen height.
- **Per-item editors already exist as components** in a document-kind
  registry (`ui/workspace/kinds.tsx`): model, script, visual script,
  library, graph, material, material function, effect, dialogue, timeline,
  animator, UI document, UI theme. Today they open as centre tabs next to
  Scene and Game (`ui/workspace/WorkspaceTabs.tsx`). The project window
  (26.13) opens the right one on double-click (`project/useProjectWindow.ts`).
- **The graph, material and animator editors show their selection in the
  right dock's Inspector** (`GraphInspector`); the timeline editor has its
  own key inspector. The material editor has its own preview renderer
  (`viewport/material-preview.ts`), the effect editor another
  (`viewport/effect-preview.ts`, `EffectPreviewPane.tsx`).
- **Settings panels are standalone components:** `GameplayPanel`,
  `InputPanel`, `TagsPanel`, `CollisionLayersPanel`, `SavesPanel`,
  `ModesPanel`, `ShellPanel`, `BehaviorPanel` (script trust and
  publication), `MediaPanel` (listen to sounds). A modal `Dialog.tsx` exists.
- **Selection-dependent tools in the dock:** Blocks (block-layer tools for
  the selected layer), Prefabs (make a prefab from the selection).
- **`App.tsx` is 4,838 lines**, past the 2,000-line rule. Phase 26 moved
  areas out as it touched them (5,159 → 4,838) but never below the line
  (D91). Every dock tab is a branch in it.
- **Environment:** one project-wide `EnvironmentConfig` in `content.json`
  (sky, fog, post, wind, quality) plus presets, each its own file (26.4),
  that scripts blend to (`runtime/src/environment-director.ts`, simulation
  state, saved). Several scenes can be loaded at once (`ctx.scenes.load`).
  An unused `LevelEnvironment` (sky, fog, post, wind "laid over the project
  environment") is left from the old level flow (`project-model/src/materials.ts`,
  `three-adapter/src/environment.ts`). **Lighting bakes are already per
  scene** (`LightingMap`, keyed by scene id); the Lighting panel bakes the
  active scene.
- **Icons:** object icons are 256 px PNGs generated in phase 9
  (`tools/icons/generate-phase9-icons.sh`, `packages/editor/public/icons/`);
  the document kinds' icons are small SVGs inlined in `kinds.tsx`. The
  editors have no headers, toolbars or empty states of a common design;
  `editor.css` is 1,062 lines without shared tokens for spacing or colour.
- **Tests:** 74 of 162 e2e specs select dock or centre tabs by name
  ("Assets" 52 times, "Scene" 37, "Materials" 18, "Behaviors" 14, …).

## 3. How Unity and Godot do it (to confirm with sources in 27.0)

- **Unity:** Edit → Project Settings is one window with categories (Input,
  Tags and Layers, Physics, Quality, Player, …). The Lighting window
  (Window → Rendering → Lighting) edits the active scene's lighting settings
  and environment (skybox, sun, fog) — per scene; with several scenes
  loaded, the active scene's apply. Editors like Shader Graph and Animator
  open as their own windows; the Inspector is shared.
- **Godot:** Project → Project Settings is one dialog. Environment is a
  `WorldEnvironment` node in a scene, so each scene carries its own. The
  bottom panel shows editors (Animation, Shader) only for the selected item.

## 4. Items

Order: reconcile → split → test helpers → per-scene environment → editor
window → settings → window tools → dock → look → acceptance. One format bump:
`project.json` schemaVersion 6 (per-scene environment); a 5 is upgraded on
open, replays included. Each item keeps the gate green; every editor surface
is tested with Playwright against a real backend.

| Item | What |
|---|---|
| 27.0 | This plan, its rows in `docs/STATUS.md` and `docs/roadmap.md`, and the phase-26 review read. Check for a newer three.js release (a patch is taken here; a minor is planned as its own item). Confirm §3 against the official docs with links. |
| 27.1 | **Split `App.tsx`** before anything grows it: the menus, the docks, each panel's wiring and the workspace host move into their own modules; `App.tsx` ends under 2,000 lines (D91). |
| 27.2 | **Test helpers first.** `openEditor(kind, name)`, `closeEditor()`, `openProjectSettings(section)`, `openWindow(name)`, `projectWindow()` in the e2e helpers; the 74 specs that click tabs move to them while the layout is unchanged (the gate proves the move). The later items then change the helpers, not 74 specs. |
| 27.3 | **Per-scene environment.** Each scene file carries its environment (sky, fog, post, wind); quality moves to Project Settings (it is the player's setting). Presets stay project resources. With several scenes loaded, the **active scene's** environment applies (Unity's rule): the first start scene is active, `ctx.scenes.setActive(id)` changes it, and unloading the active scene makes the scene loaded with it active. A change of active scene blends through the environment director over the scene transition's fade, so saves and replays hold. `setEnvironment` takes a `sceneId` (MCP too). Upgrade: the project environment is copied into every scene; replays still match. A new scene starts from the engine defaults, or copies another scene's ("copy from"). `LevelEnvironment` is removed. Scene view, Play and export agree; both renderers; pixels checked in a two-scene Play. |
| 27.4 | **The editor window.** Double-click in the project window (and "Open" in the Inspector's reference fields) opens the item in a full window over the editor: the item's editor on the left, the one Inspector on the right, one split, remembered width. Several open items are tabs inside the window (the workspace reducer, Ctrl+Tab and layout storage move here). Close (Esc, ×) returns to the default view with the selection it had; undo, the change feed and MCP edits work while it is open. The centre keeps only Scene and Game. |
| 27.5 | **One preview pane.** One preview component above the Inspector, one renderer path, replacing the material and effect editors' own previews: material and effect on a shape, a model with its animator (animator and clips), a UI document at a chosen resolution, and a timeline or dialogue shown on its scene. Each editor says what to preview; none builds a renderer. Both renderers; pixels checked. |
| 27.6 | **Project Settings window** (File → Project Settings): a full window with sub-tabs — Gameplay, Input, Tags, Collision layers, Quality (and the texture budget of 26.12), Saves, Game modes, Game shell, Scripts (trust and publication, from Behaviors). A search field filters the sub-tabs. The panels move as they are; no command changes. |
| 27.7 | **Window menu tools.** Lighting and Environment open from the Window menu as floating windows over the Scene view (not full windows: they preview in the Scene view), movable, remembered, with the scene they edit named at the top and a scene picker. Selection-dependent tools leave the dock for where the item is: Blocks' tools show in the Inspector when a block layer is selected; "Create prefab from selection" goes to the GameObject menu and the Hierarchy's context menu; Media's listening goes to the audio asset's Inspector. |
| 27.8 | **The dock.** The bottom dock holds the project window, Console and Problems; the other 20 tabs go. The Window menu stops listing them. Every kind stays reachable from the project window (filter by kind, 26.13). |
| 27.9 | **Icons and the look.** One icon registry (defined once) for every asset and resource kind and each editor's toolbar actions, generated with the Studio (`generate_image`, as phase 9's set) in one style with the object icons, shipped small (PNG or WebP at the sizes used, file sizes reported). Shared tokens in `editor.css` for spacing, colour and type. Each editor gets a header (icon, name, kind, folder), a toolbar, an empty state with its first actions, and graph nodes styled by category. Screenshots of every editor, before and after, for the owner; the look is **unverified until the owner has seen it**, and a round of owner changes is expected. |
| 27.10 | **Acceptance and docs.** Playwright: open each kind by double-click, edit, close, back to the default view; each Project Settings sub-tab; Lighting and Environment windows on two scenes; a two-scene Play switching environments; a v5 project upgrades and its replays match. By hand in a real browser: build a material, an effect and a timeline without the API. `docs/deployment.md`'s editor section and the MCP descriptions updated. `tools/gate.sh full` green. |

**Done when:**
- The default view shows the Scene or Game view, the Hierarchy, the
  Inspector and a dock with only the project window, Console and Problems.
- Every item kind opens by double-click in a full window with the editor on
  the left and the Inspector on the right, and closing it returns to the
  default view.
- Project Settings is one window; Lighting and Environment open from the
  Window menu and name their scene.
- Two scenes with different skies and fog each show their own in the Scene
  view, Play and the export, on both renderers.
- A version-5 project opens and upgrades; its replays still match.
- The owner has looked at the editors' new look.
- `tools/gate.sh full` is green.

## 5. Progress

| Item | Status |
|---|---|
| 27.0 | plan written 2026-09-30; the rest of 27.0 (three.js check, §3 sources, phase-26 review read) is open |
| 27.1–27.10 | — |

## 6. Decision log

- 2026-09-30: this phase was added before scalable lighting (owner);
  lighting became phase 28, documentation 29, decals 30, occlusion 31.
- 2026-09-30: environment is per scene (owner). Defaults taken in drafting,
  open to the owner: the active scene's environment applies when several
  are loaded; Lighting and Environment are floating windows over the Scene
  view rather than full windows, because they preview in it; Blocks moves
  into the Inspector and prefab creation into the GameObject menu.
