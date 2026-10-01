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
builds on the per-scene environment. Requests: the owner; Skyforge Tactics'
upgrade gaps E46–E51 (`engine-gaps.md` in its repo), rolled in by the owner
on 2026-10-01 and worked first (27.1–27.7); smooth block-layer normals
(E52) and an instance brush, from Skyforge's first playtest, added by the
owner on 2026-10-01 (27.18, 27.19).

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

## 2. Where things stand (checked at `dd3aa69c`, 2026-09-30, end of phase 26; re-checked against the code at `dec477b4`, 2026-10-01)

- **The bottom dock has 23 tabs** (`BOTTOM_TABS`, `editor/src/ui/App.tsx`):
  Assets, Materials, Environment, Lighting, Animator, Input, Prefabs,
  Behaviors, Gameplay, Tags, Saves, Media, Graphs, Effects, Dialogue,
  Timelines, Libraries, Console, UI, Game modes, Game shell, Blocks,
  Problems. The Window menu lists all 23 as well. The dock is about 30% of
  the screen height.
- **Per-item editors already exist as components** in a document-kind
  registry (`editor/src/ui/workspace/kinds.tsx`, 11 kinds): script, visual
  script, script library, graph, material, effect, dialogue, timeline,
  animator, UI document, UI theme (material functions are graphs; models
  are not a document kind). Today they open as centre tabs next to Scene
  and Game (`ui/workspace/WorkspaceTabs.tsx`, reducer in
  `session/workspace-tabs.ts`). The project window (26.13,
  `ui/project/ProjectWindow.tsx`) opens the right one on double-click
  (`ui/project/useProjectWindow.ts`, item → kind map in
  `session/project-items.ts` `documentOfItem`); a double-clicked asset
  (model, texture, audio) loads its preview in the Assets tab's side panel,
  a scene opens and becomes the editor's active scene, a prefab and an
  environment preset switch the dock to the Prefabs / Environment tab.
- **The project window lives inside the Assets tab** (`ui/AssetBrowser.tsx`):
  folders, tiles and search on the left, and a **side panel** for the chosen
  item — an asset's preview (`ui/assets/useAssetPreview.ts`), its options
  (audio load type and preload, `ui/AudioAssetOptions.tsx`, 26.6/26.12),
  address and labels (`ui/LoadableFields.tsx`), a resource's or scene's file.
  This side panel is a second inspector beside the right dock's Inspector;
  27.11/27.14/27.15 fold it into the one Inspector.
- **The graph, material, effect and animator editors show their selection in
  the right dock's Inspector** (`graph/GraphInspector.tsx`,
  `ui/animator/AnimatorInspector.tsx`); the timeline editor has its own key
  inspector. Preview renderers today: the material editor's
  (`viewport/material-preview.ts`), the effect editor's
  (`viewport/effect-preview.ts`, `ui/effect/EffectPreviewPane.tsx`), and
  `viewport/preview-stage.ts`, used by the Animator's live preview and the
  asset preview; each calls three-adapter `createRenderer`. The Animator
  preview already holds its model through the Scene view's resource manager
  (`runtime/src/resources.ts` `createResourceManager`, editor side
  `viewport/scene-assets.ts`, `viewport/model-instances.ts`; D78); 27.12's
  one preview pane does the same for every preview.
- **Settings panels are standalone components:** `GameplayPanel` (the
  settings registry, `project-model/src/content-settings.ts`, including its
  Rendering group with 26.12's `texture_budget_mb`), `InputPanel`,
  `TagsPanel`, `CollisionLayersPanel`, `SavesPanel`, `ModesPanel`,
  `ShellPanel`, `BehaviorPanel` (script trust and publication),
  `MediaPanel` (listen to an audio asset **and the project's event → sound
  table**). A modal `ui/Dialog.tsx` exists.
- **Selection-dependent tools in the dock:** Blocks (block-layer tools for
  the selected layer), Prefabs (make a prefab from the selection).
- **`App.tsx` is 4,838 lines**, past the 2,000-line rule. Phase 26 moved
  areas out as it touched them (5,159 → 4,838) but never below the line
  (D91). Every dock tab is a branch in it.
- **Environment:** one project-wide `EnvironmentConfig` in `content.json`
  (sky, fog, post, wind, quality) plus presets, each its own file (26.4:
  `assets/environment/<id>.envpreset.json` by default, `content.json`
  listing their order; `workspace/src/store-v4.ts`,
  `workspace/src/resource-files.ts`), that scripts blend to
  (`runtime/src/environment-director.ts`, simulation state, saved). Several
  scenes can be loaded at once (`ctx.scenes.load`, `runtime/src/scene-set.ts`);
  the runtime has no active scene yet, but the **editor already has one**
  (`session/client-core.ts` `activeScene`: new objects go to it; opening a
  scene from the project window activates it). An unused `LevelEnvironment`
  (sky, fog, post, wind) is left from the old level flow, only in
  `project-model/src/materials.ts`, its `index.ts` exports and
  `environment.test.ts`. **Lighting bakes are already per scene**
  (`LightingMap` in `project-model/src/lighting.ts`, keyed by scene id); the
  Lighting panel bakes the active scene.
- **Formats:** `project.json` is at schemaVersion 5
  (`PROJECT_SCHEMA_VERSION`, `project-model/src/upgrade-v24.ts`; 2–4 are
  upgraded on open, `workspace/src/service.ts`), so the bump is 5 → 6. Scene
  files are `<name>.scene.json` (scene document schemaVersion 4) anywhere in
  the game folder; a scene's environment goes in that document. Fixtures for
  the 26 upgrades: `fixtures/phase26/` (legacy-v4-*, legacy-v5-music).
- **One game page** for Play and the export (26.9 B,
  `game-host/src/game-page.ts`): the environment reaches both through the
  one scene adapter, so per-scene environment changes one path, not two.
- **Icons:** object icons are 256 px PNGs generated in phase 9
  (`tools/icons/generate-phase9-icons.sh`, `packages/editor/public/icons/`);
  the document kinds' icons are small SVGs inlined in `kinds.tsx`. The
  editors have no headers, toolbars or empty states of a common design;
  `editor.css` is 1,062 lines without shared tokens for spacing or colour.
- **Tests:** 74 of 144 e2e specs (`tests/e2e/*.e2e.ts`) select dock or
  centre tabs by name, 243 `getByRole('tab', …)` calls ("Assets" 52 times,
  "Scene" 37, "Materials" 18, "Behaviors" 14, "Lighting" 8, …). The shared
  helpers are in `tests/e2e/ui.ts` (`menu`, `menuItem`, `closeMenu`); 27.9's
  helpers go there. The scale bench (26.2): `tools/perf/scale-generate.ts`,
  `tools/perf/scale.ts`, `tests/e2e/scale-bench.e2e.ts`,
  `node tools/perf/run.mjs scale`.
- **Skyforge's upgrade gaps, read in the code** (E46–E51):
  - Screenshots (E46): `validateBridgePreviewToEditor`
    (`protocol/src/bridge.ts`) applies the general
    `BRIDGE_MESSAGE_MAX_BYTES` (65,536, `protocol/src/delivery.ts`) before
    the screenshot rule, while a screenshot answer may be up to
    `SCREENSHOT_DATA_URL_MAX` (1 MiB, `editor/src/preview/screenshot-answer.ts`;
    WS ack `WS_SCREENSHOT_ACK_MAX` 1.5 MiB). `postLocal`
    (`editor/src/preview/bridge.ts`) drops a message that fails local
    validation without a word, so every PNG over 64 KiB ends in a relay
    timeout. Tests passed on tiny PNGs.
  - Signals, trigger events and script messages (E51) turn over in
    `blocks.beforeStep` (`runtime/src/blocks.ts`), which the runtime skips
    while `modes.physicsHeld` (`runtime/src/runtime.ts`, plain and
    controller steps). The 2D plain step without physics
    (`stepPrimitivesOnly`) turns over only the primitives' events, so its
    messages and signals look frozen too (read, not yet tested).
  - Replay (E49): `host.control('replay')` (`game-host/src/host.ts`)
    queues a restart and answers; the backend relay times out after
    `relayTimeoutSeconds` (10 s, `backend/src/config.ts`). Not reproduced.
  - Missing files (E50): the Play build stops at the first
    `asset_source_missing` (`workspace/src/errors.ts`); the open and the
    file check (`backend/src/asset-files.ts`) do not list missing files.
  - Re-imports before Play (E47): the file check imports changed files
    again as commands; nothing names them outside undo history.
  - Textures inside GLBs (E48) are counted as model bytes
    (`resources.resident.model`), outside 26.12's texture budget and
    streaming.
  - Play diagnostics have no audio block (unlock state, what plays,
    skipped or late cues).
- **Open defects phase 27 touches** (`docs/audit-2026-09-22.md`, last
  D94): D91 (`App.tsx` size, 27.8); D93 (backend peaked at 7.2 GiB opening
  a large project, likely KTX2 encodes; 27.7's extraction encodes more
  KTX2 and must stay inside the service's memory cap); D88
  (resource-manager tests read the manager's own counters; 27.12's
  preview pane should be checked independently, e.g.
  renderer memory or a dispose spy); D71 (sampler texture copies; the
  preview pane must not add another copy per preview); D85 (material
  instance resolution copied into three-adapter; a material preview must
  use the one path); D64 (an unresolved asset reference stops the open;
  the project window cannot show "Missing" yet); D66 (resource file
  address/labels edited by hand); D52 (block-layer turned cells; 27.14 moves
  the Blocks tools, not the meshes). Waiting on the owner and unchanged:
  D83, D84, the revised targets, the boundary allowlist growth.

## 3. How Unity and Godot do it (checked against the official docs 2026-10-01)

- **Unity:** Edit → Project Settings is one window with categories (Audio,
  Graphics, Physics, Player, Quality, Tags and Layers, Time, …) and a search
  field ([Project Settings](https://docs.unity3d.com/Manual/comp-ManagerGroup.html)).
  The Lighting window (Window → Rendering → Lighting) shows the Lighting
  Settings asset assigned to the active scene, and its Environment tab the
  skybox, environment lighting and reflections "in the current scene"
  ([Lighting window](https://docs.unity3d.com/Manual/lighting-window.html)).
  With several scenes open, "Unity uses the rendering settings from the
  active scene", and a new active scene **replaces** the previous settings
  ([Multi-scene editing](https://docs.unity3d.com/Manual/setupmultiplescenes.html)).
  Shader Graph opens in its own window on double-clicking the asset, with a
  main preview and **its own Graph Inspector** inside that window
  ([Shader Graph window](https://docs.unity3d.com/Packages/com.unity.shadergraph@17.0/manual/Shader-Graph-Window.html));
  the Animator is its own window too. Correction to the draft: Unity does
  not share the main Inspector with Shader Graph; this phase's one shared
  Inspector is the owner's choice (§1), not Unity's.
- **Godot:** Project → Project Settings is one window with categories on
  the left and a Filter Settings search
  ([Project Settings](https://docs.godotengine.org/en/stable/tutorials/editor/project_settings.html)).
  Environment is a `WorldEnvironment` node that sets "the default
  Environment for the scene"; only one may be instantiated in a scene at a
  time ([WorldEnvironment](https://docs.godotengine.org/en/stable/classes/class_worldenvironment.html)).
  The bottom panel hosts the output/debugger, the animation editor, the
  audio mixer and more, folded until clicked
  ([First look at the editor](https://docs.godotengine.org/en/stable/getting_started/introduction/first_look_at_the_editor.html));
  the visual shader editor opens when a shader resource is clicked, with a
  material preview, and can be put in its own window
  ([Visual shaders](https://docs.godotengine.org/en/stable/tutorials/shaders/visual_shaders.html)).
  Correction to the draft: the Godot docs do not state that bottom-panel
  editors show only for the selected item; that is observed editor
  behaviour, not a documented rule.
- **For the upgrade gaps (checked 2026-10-01):** changed source files are
  re-imported without asking — Unity on regaining focus when Auto Refresh
  is on ([Refreshing the Asset Database](https://docs.unity3d.com/Manual/AssetDatabaseRefreshing.html)),
  Godot whenever a source file's checksum changes
  ([Import process](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/import_process.html)).
  Textures embedded in a model: Godot's glTF importer offers Discard,
  **Extract Textures** (its default, `gltf/embedded_image_handling` in
  the importer source), Embed as Basis Universal or Embed as Uncompressed
  ([Import configuration](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/import_configuration.html));
  Unity keeps them embedded by default with an **Extract Textures** button
  ([Materials tab](https://docs.unity3d.com/Manual/FBXImporter-Materials.html)).
  Missing files: both editors open a project with missing references and
  show them as warnings (Godot's dependency dialog, Unity's "Missing"
  fields and magenta error shader); that is observed editor behaviour, not
  found stated in one official page.

## 4. Items

Order: reconcile → Skyforge's upgrade gaps (E46, E51, E50, E47, E49, E48:
cheap and blocking first, the largest last) → split → test helpers →
per-scene environment → editor window → settings → window tools → dock →
look → acceptance. One format bump: `project.json` schemaVersion 6
(per-scene environment); a 5 is upgraded on open, replays included. Each
item keeps the gate green; every editor surface is tested with Playwright
against a real backend. The gap items (27.1–27.7) are generic engine
capabilities; Skyforge's names stay in the "requests" note. They come
before the `App.tsx` split (27.8, D91): none of them may grow `App.tsx` —
they report through the existing Problems feed, the Play start result and
diagnostics; if one must touch `App.tsx`, the change is wiring only and
moves at least as many lines out as it adds.

| Item | What |
|---|---|
| 27.0 | This plan, its rows in `docs/STATUS.md` and `docs/roadmap.md`, and the phase-26 review read. Check for a newer three.js release (a patch is taken in 27.1; a minor is planned as its own item). Confirm §3 against the official docs with links. Done 2026-10-01: three.js 0.186.1 (r186) is the latest release, nothing to take. |
| 27.1 | **Screenshots of real scenes answer.** The bridge's general message cap no longer applies to screenshot answers (they keep their own bound, defined once and shared by the preview, the bridge rule and the backend); a local bridge message refused by validation is never dropped silently — the sender gets the reason and the backend's waiting call answers with it instead of timing out. Done when: a test takes a screenshot of a large, noisy scene (PNG well over 64 KiB) in Play on both renderers, through HTTP and through MCP `tl_screenshot`, and gets the image; an over-bound answer returns a named reason, not `screenshot_timeout`. Requests: Skyforge E46. |
| 27.2 | **Signals, trigger events and script messages turn over every step**, whatever the mode's physics setting: a mode that holds physics holds only the controller, bodies, movers and triggers. Also the 2D plain scene without physics, if a test confirms it is broken. Play diagnostics gain a warning when a message queue refuses sends, and an **audio block**: unlock state, what plays (music, voices, cues), cues skipped or late and why. Done when: runtime tests send messages and signals between scripts in a physics-holding mode (3D and 2D, with and without physics) and receive them; an e2e Play reads the audio block over HTTP/MCP before and after unlock. Requests: Skyforge E51; owner (audio block, 2026-10-01). |
| 27.3 | **Missing asset files are listed, not discovered one by one.** Missing files show in Problems at open and after each file check (path, asset, who uses it); a Play that cannot start names every missing file in one refusal; Play starts with placeholders for missing assets outside the start scenes' draw set and lists them in the start result (decision log). Done when: a fixture project with several moved files opens with all listed in Problems (HTTP and the editor's Problems tab, Playwright), a Play refusal names all of them, and a Play whose missing files are outside the start scenes starts with them reported. Requests: Skyforge E50. |
| 27.4 | **Re-imports before Play are reported.** The pre-Play file check's re-imports add a Problems note and a `check` block in the Play start result naming each asset with its old and new digests (as the integrity check does). No "ask before re-import" setting (decision log). Done when: an e2e changes files on disk, starts Play over HTTP and MCP, and reads the named assets and digests in the start result and in Problems. Requests: Skyforge E47. |
| 27.5 | **The replay control call answers once the restart is applied**, with the new run's id, or says it is still pending. Reproduce first on the scale bench (`tools/perf/scale-generate.ts`) at full size; if the cause is the restart blocking the page past the relay timeout, answer when the restart is applied rather than raising the timeout. Done when: a replay on the bench through HTTP and MCP answers with the new run id, and a test that delays the restart past the relay timeout gets "pending", not `game_relay_timeout`. Requests: Skyforge E49. |
| 27.6 | **Textures inside models count (A).** Images embedded in GLB models are counted against the texture budget and reported under textures in Play diagnostics (resident bytes per model and in total), not only as model bytes. Measure on the scale bench with models that embed KTX2 and WebP images (before/after in the plan). Done when: an e2e Play on the bench reads the embedded textures in the texture totals over HTTP, and the budget's pressure reacts to them. Requests: Skyforge E48. |
| 27.7 | **Textures inside models stream (B).** A model import setting extracts a GLB's images into texture assets (KTX2 with mips, the 26.12 encoder and its 12 Mpix cap) that the model references, so they stream like any texture asset; on by default for new imports (Godot's default), and existing models switch on re-import with the setting (no silent change to a project on open). Embedded images that stay embedded remain counted (27.6). Done when: an e2e imports a GLB with embedded images, finds the texture assets in the project window, plays and sees them stream by mip under a small budget, both renderers; bench numbers before/after recorded. Mind D93 (backend memory while encoding). Requests: Skyforge E48. |
| 27.8 | **Split `App.tsx`** before anything grows it: the menus, the docks, each panel's wiring and the workspace host move into their own modules; `App.tsx` ends under 2,000 lines (D91). The Assets tab's side panel (`AssetBrowser.tsx`) and the project-window openers move with it. |
| 27.9 | **Test helpers first.** `openEditor(kind, name)`, `closeEditor()`, `openProjectSettings(section)`, `openWindow(name)`, `projectWindow()` in the e2e helpers (`tests/e2e/ui.ts`); the 74 specs that click tabs move to them while the layout is unchanged (the gate proves the move). The later items then change the helpers, not 74 specs. |
| 27.10 | **Per-scene environment.** Each scene file carries its environment (sky, fog, post, wind); quality moves to Project Settings (it is the player's setting). Presets stay project resources. With several scenes loaded, the **active scene's** environment applies (Unity's rule): the first start scene is active, `ctx.scenes.setActive(id)` changes it, and unloading the active scene makes the scene loaded with it active. A change of active scene blends through the environment director over the scene transition's fade, so saves and replays hold. `setEnvironment` takes a `sceneId` (MCP too). Upgrade: the project environment is copied into every scene; replays still match. A new scene starts from the engine defaults, or copies another scene's ("copy from"). `LevelEnvironment` is removed (`project-model/src/materials.ts` and its exports). Unity replaces the settings at once on a change of active scene; the blend is this engine's choice so a script-driven change can fade. Scene view, Play and export agree; both renderers; pixels checked in a two-scene Play. |
| 27.11 | **The editor window.** Double-click in the project window (and "Open" in the Inspector's reference fields) opens the item in a full window over the editor: the item's editor on the left, the one Inspector on the right, one split, remembered width. Several open items are tabs inside the window (the workspace reducer, Ctrl+Tab and layout storage move here). Close (Esc, ×) returns to the default view with the selection it had; undo, the change feed and MCP edits work while it is open. The centre keeps only Scene and Game. |
| 27.12 | **One preview pane.** One preview component above the Inspector, one renderer path, replacing the material and effect editors' own previews: material and effect on a shape, a model with its animator (animator and clips), a UI document at a chosen resolution, and a timeline or dialogue shown on its scene. Each editor says what to preview; none builds a renderer. Both renderers; pixels checked. |
| 27.13 | **Project Settings window** (File → Project Settings): a full window with sub-tabs — Gameplay, Input, Tags, Collision layers, Quality (the environment's quality block and the settings registry's Rendering group, which holds 26.12's texture budget), Audio (the event → sound table now in the Media tab), Saves, Game modes, Game shell, Scripts (trust and publication, from Behaviors). A search field filters the sub-tabs. The panels move as they are; no command changes. |
| 27.14 | **Window menu tools.** Lighting and Environment open from the Window menu as floating windows over the Scene view (not full windows: they preview in the Scene view), movable, remembered, with the scene they edit named at the top and a scene picker. Selection-dependent tools leave the dock for where the item is: Blocks' tools show in the Inspector when a block layer is selected; "Create prefab from selection" goes to the GameObject menu and the Hierarchy's context menu; Media's listening goes to the audio asset's Inspector (with its load type and preload fields, today in the Assets tab's side panel), its event → sound table to Project Settings → Audio. |
| 27.15 | **The dock.** The bottom dock holds the project window, Console and Problems; the other 20 tabs go. The Window menu stops listing them. Every kind stays reachable from the project window (filter by kind, 26.13). The Assets tab's side panel (preview, options, address, labels) is gone: the chosen item shows in the one Inspector. |
| 27.16 | **Icons and the look.** One icon registry (defined once) for every asset and resource kind and each editor's toolbar actions, generated with the Studio (`generate_image`, as phase 9's set) in one style with the object icons, shipped small (PNG or WebP at the sizes used, file sizes reported). Shared tokens in `editor.css` for spacing, colour and type. Each editor gets a header (icon, name, kind, folder), a toolbar, an empty state with its first actions, and graph nodes styled by category. Screenshots of every editor, before and after, for the owner; the look is **unverified until the owner has seen it**, and a round of owner changes is expected. |
| 27.17 | **Acceptance and docs.** Playwright: open each kind by double-click, edit, close, back to the default view; each Project Settings sub-tab; Lighting and Environment windows on two scenes; a two-scene Play switching environments; a v5 project upgrades and its replays match. By hand in a real browser: build a material, an effect and a timeline without the API. `docs/deployment.md`'s editor section and the MCP descriptions updated. `tools/gate.sh full` green. |
| 27.18 | **Smooth block-layer tops** (E52). A block layer gets a crease angle (`smoothAngle`, a block-layer field in the Inspector and MCP; the default keeps today's flat shading so existing scenes look the same). Tops that share an edge at the same height get averaged vertex normals across cells and across chunk edges (the mesher reads the whole grid); edges steeper than the angle (cliffs, walls) stay hard. Optional subdivided tops (`topSubdivision` 1 or 2: a 2×2 top per cell, the corner heights interpolated), so noise reads as rolling ground. Colliders keep their current shape. Scene view, Play and export agree; both renderers; pixels checked (no seam at a chunk edge, a hard edge at a cliff). |
| 27.19 | **Instance brush.** Instance sets get a paint brush in the Scene view beside today's rectangle fill: paint and erase on any collider surface (terrain, block-layer tops, models), radius, density per m², spacing, random scale, rotation and alignment to the surface normal, a seed. One stroke is one command and one undo; MCP gets the same op. The brush shows in the Inspector when an instance set is selected (with the block tools, 27.14). Copies keep 25.7d's chunking. Playwright: paint a stroke, undo, redo, reload. |

**Done when:**
- A screenshot of a large scene (PNG well over 64 KiB) answers in Play on
  both renderers, through HTTP and MCP; a refused bridge message answers
  with its reason instead of a timeout (27.1).
- Script messages, signals and trigger events arrive in a mode that holds
  physics, 2D and 3D; Play diagnostics show message-queue refusals and an
  audio block (27.2).
- Missing asset files are listed in Problems at open and after each file
  check; a Play refusal names every missing file (27.3).
- The Play start result and Problems name the assets re-imported before
  Play with old and new digests (27.4).
- The replay control call answers with the new run id, or "pending", never
  a relay timeout for a replay that happened (27.5).
- Textures inside GLB models count against the texture budget, and
  extracted ones stream by mip; bench numbers recorded (27.6, 27.7).
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
- A block layer with a crease angle shows smooth rolling tops and hard
  cliffs, with no seam at chunk edges, on both renderers (27.18).
- An instance set is painted and erased with a brush on terrain, one undo
  per stroke (27.19).
- `tools/gate.sh full` is green.

## 5. Progress

| Item | Status |
|---|---|
| 27.0 | done 2026-10-01: §2 re-checked against the code, §3 confirmed with links (two corrections), phase-26 review and open defects read (§2), three.js 0.186.1 is the latest (nothing to take); Skyforge E46–E51 planned as 27.1–27.7, layout items renumbered 27.8–27.17 |
| 27.1 | done 2026-10-01: screenshot answers keep their own bound (`SCREENSHOT_DATA_URL_MAX`, protocol, used by preview, bridge rule, WS ack bound and backend); a refused bridge message answers its relay with `bridge_message_refused` and the reason; e2e captures a ~280 KiB PNG over HTTP and MCP on WebGPU and WebGL 2 (D95) |
| 27.2 | done 2026-10-01: signals, trigger events, script messages (and the primitives' events) turn over every step whatever the mode's physics; the 2D step without scripts too (D96, D97); Play diagnostics carry `runtime.messageQueue` (refused sends with a warning) and an `audio` block (unlock state, what plays by bus, started, skipped by why, late, notes), read over HTTP and MCP before and after the unlock in a real browser |
| 27.3 | done 2026-10-01: missing asset files are listed in Problems at open and after each file check (path, asset, who uses it; paged, one log line per change; `GET problems/missing-files`, MCP `tl_diagnostics`); a Play or export refusal names every missing file (`missingFiles`); Play stands placeholders in (magenta box, checker texture, silence) for missing files no start scene draws and lists them in its result (`placeholders`); the Play button's refusal shows its reason (D98, D99) |
| 27.4 | done 2026-10-01: every file check (the editor's, before Play, before export) reports its re-imports: a Problems line per asset (`asset_reimported`, file, asset, version, old → new digest) and the Play start result's `check` (the check's report; `reimported` carries `reason`, `oldDigest`, `newDigest`); e2e over HTTP, MCP and the Problems tab (D100) |
| 27.5–27.17 | — |

## 6. Decision log

- 2026-09-30: this phase was added before scalable lighting (owner);
  lighting became phase 28, documentation 29, decals 30, occlusion 31.
- 2026-09-30: environment is per scene (owner). Defaults taken in drafting,
  open to the owner: the active scene's environment applies when several
  are loaded; Lighting and Environment are floating windows over the Scene
  view rather than full windows, because they preview in it; Blocks moves
  into the Inspector and prefab creation into the GameObject menu.
- 2026-10-01 (27.0): §2 re-checked against the code. Corrected: 11 document
  kinds (no model or material-function kind); 143 e2e specs, not 162; the
  project window sits in the Assets tab with its own side panel (asset
  preview, audio load type and preload, address, labels), a second inspector
  the layout items fold into the one Inspector; a third preview renderer
  (`preview-stage.ts`); `LevelEnvironment` is only in project-model; the
  editor already has an active scene; `project.json` is at schemaVersion 5
  (the 5 → 6 bump stands). Added the event → sound table (Media tab) to
  Project Settings → Audio, and the environment quality plus the settings
  registry's Rendering group to Quality.
- 2026-10-01 (27.0): three.js check: pinned 0.186.1 (`tools/check-deps.mjs`,
  `@types/three` 0.186.0) is the latest on npm and GitHub (r186,
  2026-09-24); no patch or minor to plan.
- 2026-10-01 (27.0): §3 confirmed with the Unity and Godot docs (links in
  §3). Two corrections: Shader Graph has its own Graph Inspector (the one
  shared Inspector is the owner's choice, not Unity's); the Godot docs do
  not document bottom-panel editors showing only for the selected item.
  Unity replaces an active scene's rendering settings at once; 27.3 keeps
  its blend over the transition's fade as a deliberate difference.
- 2026-10-01 (27.0, second pass): the owner rolled Skyforge's upgrade gaps
  E46–E51 into this phase, worked first. They became 27.1–27.7 (E46, E51,
  E50, E47, E49, E48 as A/B); the layout items were renumbered: old
  27.1–27.10 are now 27.8–27.17 (split 27.8, test helpers 27.9, per-scene
  environment 27.10, editor window 27.11, preview pane 27.12, Project
  Settings 27.13, window tools 27.14, dock 27.15, look 27.16, acceptance
  27.17). Entries above keep their old numbers ("27.3" in the line above is
  now 27.10).
- 2026-10-01 (27.0, second pass): the first pass's edits were checked
  against the code at `dec477b4` and stand; counts updated for the
  `batch-dispose` spec added with D92 (144 specs, 243 tab clicks). Added to
  §2: the E46–E51 code findings, the scale bench's files, D93 (backend
  memory while encoding; matters for 27.7), last D-number D94.
- 2026-10-01 (27.0): the gap items stay off `App.tsx` until the split
  (27.8, D91): they report through Problems, the Play start result and
  diagnostics; any unavoidable `App.tsx` touch is wiring only and moves out
  at least as many lines as it adds.
- 2026-10-01 (27.0): the Play diagnostics' audio block (unlock state, what
  plays, skipped or late cues; owner, who could not tell why a Play was
  silent) goes with 27.2, next to the message-queue warning.
- 2026-10-01 (27.0): missing files (27.3): Play starts with placeholders for
  missing assets outside the start scenes' draw set and lists them; a
  missing file the start scenes draw still refuses, naming every missing
  file at once. Unity and Godot open with warnings and placeholders; a start
  scene drawn with holes would mislead a playtest, so it refuses; the
  export keeps refusing any missing file.
- 2026-10-01 (27.0): re-imports before Play (27.4): no "ask before
  re-import" setting. Unity and Godot re-import changed files without asking
  (§3) and Play must match the files on disk; the re-imports are reported
  (Problems note, `check` block with old and new digests) instead.
- 2026-10-01 (27.4): the start result's `check` is the report of the check
  the Play ran or joined (a check already running is joined, not repeated);
  re-imports a check finished before the Play asked show in Problems only.
  The digests are the file's (a converted asset's original), what changed
  on disk. Problems gets one line per asset up to 8
  (`REIMPORT_PROBLEM_LINES`), then one line counting the rest, so a big
  re-import does not push the log's other entries out; the report lists all.
- 2026-10-01 (27.0): textures inside models (27.6/27.7): both options, in
  order — first count embedded images in the texture budget (cheap, covers
  existing projects), then an import setting that extracts a GLB's images
  into KTX2 texture assets, on by default for new imports (Godot's glTF
  default is Extract Textures; Unity offers Extract Textures). Existing
  models change only when re-imported with the setting, never on open.
- 2026-10-01: Skyforge's first playtest (`plan-playtest-fixes.md` in its
  repo) added two items here (owner): 27.18 smooth block-layer normals (E52)
  and 27.19 the instance brush. They are numbered after 27.17 so the items
  already under way keep their numbers; **27.17 (acceptance and the full
  gate) runs last, after 27.18 and 27.19**. The rest of that playtest's
  engine asks went where their code is: LOD bias, hysteresis and finer
  LOD for instance sets (E53) into 28.6, which already replaces the fixed
  LOD screen fractions; a scene-depth (depth-fade) material input into
  phase 30, which needs scene depth for projected decals. Its
  "32-portrait cap" is per speaker (`DIALOGUE_LIMITS.portraits` counts one
  speaker's expressions), not a project total, so nothing changes.
- 2026-10-01 (27.0): replay (27.5) is reproduced on the scale bench before
  any fix; the fix answers when the restart is applied (or "pending" with
  the new run id), it does not raise the relay timeout.
- 2026-10-01 (27.1): the screenshot bound is the protocol's
  `SCREENSHOT_DATA_URL_MAX` (1 MiB of data URL characters, the backend's old
  value; the bridge rule allowed 4 MiB, a bound nothing else accepted); the
  WS ack frame bound is derived from it. A message the bridge refuses to send
  is counted in the drop stats (`refused:<type>:<reason>`, in Play
  diagnostics' `frameDrops`); a refused relay request answers the editor's
  own handlers and a refused answer is replaced by an error answer, both
  `bridge_message_refused` with the reason; the editor also answers a relay
  whose answer from the trusted preview fails validation. A refused message
  with no waiting relay (load progress, ready) is only counted: answering it
  with `tl.error` would stop a Play over a progress report. Checked: without
  the validator change the new e2e gets 503 `bridge_message_refused`
  "message exceeds the 65536-byte bound" at once instead of a timeout.
- 2026-10-01 (27.2): a game mode's physics hold stops the controller, the
  bodies, movers, triggers, switches and the primitives' stepping (patrols,
  hitboxes); everything that is an event turns over regardless — signals,
  trigger events, script messages, the primitives' events and the
  signal-driven effect components (they are script-to-script, not
  physics). The 2D step without scripts was broken
  the same way (confirmed by a test, D97) and takes the same turnover.
  `runtime.ts` shrank while touched: its diagnostics reads moved to
  `runtime/src/diagnostics-reads.ts` (5,698 → 5,657 lines).
- 2026-10-01 (27.2): the message-queue warning is a Play diagnostics block
  (`runtime.messageQueue`: refused count, first and last step, the per-step
  limit, a warning sentence), present only once a send was refused so other
  frames keep their shape; it counts over the whole play (a restart keeps
  it). The per-step limit (256) is unchanged.
- 2026-10-01 (27.2): the audio block is always in Play diagnostics.
  `unlock.state` tells `locked` (no gesture yet; the old status said
  `blocked`/`autoplay_denied` for this) apart from `blocked` (the browser
  refused a gesture's resume, or no device); skipped sounds are counted by
  why (muted, locked, not_ready, decode_failed, not_registered, voice_cap,
  context_closed, stale_run) — a muted script play and the host's fallback
  `playSound` now note why instead of returning silently; lists stay
  bounded (8 sounds, 4 notes, 4 late outcomes) inside the 16 KiB frame.
- 2026-10-01 (27.3): a missing file is one the game folder no longer has
  (the current version's file, a converted asset's original), found by one
  stat per asset after each file check and each asset change; "who uses it"
  is the build's own dependency scan per scene, prefab, material, effect,
  animator, model material map and project-wide block. The start's draw set
  is the start scenes' (and a debug start's scene) dependencies plus the
  project-wide blocks'; a missing file in it, or one of a kind without a
  placeholder (fonts), refuses the Play naming every missing file in the
  build (`missingFiles`, the first file's code kept); the export refuses the
  same way. Placeholders (Unity's magenta, Godot's error texture): a magenta
  box the size of the model's recorded bounds, an 8 × 8 magenta and black
  checker, 0.1 s of silence, shipped under their own digests (the asset's
  material map, clips and streaming do not apply to them). The list pages with
  the asset list's bounds (50 / 128); the Problems log gets one line when the
  list changes, and "no files missing" when it empties.
