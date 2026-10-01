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
| 27.5 | done 2026-10-01: E49's timeout not reproduced (scale bench at full, 20 and 150 scenes loaded, worker and single thread: answers in ≤ 0.1 s / ≤ 0.55 s); a replay now answers once the new run began (`restart {applied, atStep}`, run id `<snapshot>#<run>`) or `pending` with the run id it will have when no step comes in time; observations carry the current run id; a game without scripts applies a restart at all (D101, D102); bench step `replay` (`--threads`, `--replays`, `--replay-scenes`) |
| 27.6 | done 2026-10-01: the images inside model files are counted against the texture budget (its `fixedBytes`, so streamed textures make room for them) and reported under the textures in Play diagnostics and observe (`textures.embedded`: images, bytes, models, the 8 largest by `<assetId>@<version>`) and under their models (`resident.model.textures`); the Scene view counts them with the same function (`data-resources`); bench numbers below the decision log entry; e2e `embedded-textures` (WebP and KTX2 inside bench spheres, both renderers; fails without the fix) (D103); the bench's new KTX2 models showed the Assets tab drawing no model thumbnails after one (D104, fixed) |
| 27.7 | done 2026-10-01: the model import setting "extract textures" (on for a new model; an existing one switches only when re-imported with it, from its inspector) takes a GLB's images out into texture assets in `<model>_textures/` (PNG/JPEG encoded to KTX2 with mips by what the material samples them as, KTX2/WebP as they are, one image a texture asset however many models carry it); the model is stored without them (one-pixel stand-ins, `convertedFrom: glb`) and names them in `textures`; Play, the export, the Scene view and model thumbnails draw them from the texture assets, streamed by mip; publish, folder import and the file check do it; e2e `extract-textures` (both renderers, the webgpu project too); bench below (D105; D106 found) |
| 27.8 | done 2026-10-01: `App.tsx` split, no behaviour change: 4,826 → 1,083 lines; each area's state and commands in a hook returning one object (`ui/shell/use*.ts`, `ui/workspace/useDocument*.ts`), the shell's pieces as components taking those objects (`BottomDock`, `AssetsTab`, `InspectorDock`, `EditorDialogs`), the menus as `editorMenus`, the document tabs' host as `workspaceHostOf`; fast gate with 38 editor-shell specs + the smoke set green (D91) |
| 27.9 | done 2026-10-01: `tests/e2e/ui.ts` opens tool windows (`openWindow`, `windowTab`, `expectWindowOpen`), the project window (`projectWindow`), settings sections (`openProjectSettings`), item editors (`openEditor` — to the front if open, else a double-click in the project window found by search — `closeEditor`, `editorTab`, `editorPane`, `expectEditorOpen`) and the Scene/Game views (`showView`, `viewTab`); 78 specs moved to them (the 74 counted plus four that only named editor panes), two fast gates with every moved spec green |
| 27.10 | done 2026-10-01: each scene file carries its look (`SceneV4.environment`: sky, fog, post, wind); `content.environment` keeps the default quality and the presets; `project.json` schemaVersion 6, a 5 upgraded on open (the project look copied into every scene; fixture `fixtures/phase27/legacy-v5-environment` upgraded, replayed and exported over HTTP); `setEnvironment {sceneId}` (MCP too), `createScene {environmentFrom}`, a deleted scene's look kept for undo; the runtime's active scene (`ctx.scenes.active/setActive`, a transition taking over the active scene's place makes its scene active over the fade) blends the looks as simulation state (page, worker, replay agree); Scene view, Play and export draw the active scene's look, checked in pixels in a two-scene Play and its export (D107) |
| 27.11 | done 2026-10-01: an item opens in the editor window over the editor (double-click in the project window, "Open" beside an Inspector reference): its editor left, the one Inspector right (the same `InspectorDock`, moved), one split with a remembered width; open items are its tabs (reorder, close, middle-click, Ctrl+Tab), remembered per project; Esc/× return to the default view with the selection it had; undo, the change feed and MCP edits reach the open editor; the centre keeps Scene and Game; e2e `editor-window` (DOM structure, geometry, selection, reload) |
| 27.12 | done 2026-10-01: one preview pane above the one Inspector in the editor window, one renderer for as long as the window shows: a material on a shape or model, an effect (timeline, counters, cost, preview parameters), a model with its animator; a timeline, a conversation and a UI document at the editor's resolution on their scene (the Scene view's canvas lent to the pane); editors say what to preview (`usePreview`), none builds a renderer; the material/effect/Animator/asset-stage renderers are gone, the timeline window is no longer see-through; e2e `preview-pane` (pixels on WebGPU, WebGL 2 and the webgpu project), the area's specs and the memory e2e (switching previews, both renderers) green; D109 found |
| 27.13 | done 2026-10-01: File → Project Settings… opens one full window over the editor (and over the editor window), sub-tabs Gameplay, Input, Tags, Collision layers, Quality, Saves, Game modes, Game shell, Scripts on the left with a search that filters them by name and by the settings they hold; the panels moved unchanged (same commands); Quality = the environment's quality level and the settings' Rendering group (texture budget); the moved tabs left the dock and the Window menu; e2e `project-settings` (each sub-tab's edit read back over HTTP, search, Esc/×, Scripts opening the editor window); look: owner look pending |
| 27.14 | done 2026-10-01: Window → Lighting and Window → Environment open floating windows over the Scene view (moved by the title bar, resized by the corner, place and open state remembered per browser; set aside by the Game view, the editor window and Project Settings), each naming the scene it edits with a scene picker (the active scene; picking opens and activates another, so the Scene view previews what the window edits); a block layer's tools are in its Inspector while it is selected (GameObject → Block layer; the move gizmo stands aside while they are armed); GameObject → Create prefab from selection and the Hierarchy's new context menu; an audio asset chosen in the project window shows in the Inspector (facts, load type, preload, listening); Project Settings → Audio holds the event sounds; the Lighting, Environment, Blocks and Media dock tabs are gone; e2e `window-tools` (two scenes, pixels, move/resize/reload); test backends no longer lose their ports (D110); look: owner look pending |
| 27.15 | done 2026-10-01: the bottom dock holds Project (the project window), Console and Problems; the Materials, Animator, Prefabs, Graphs, Effects, Dialogue, Timelines, Libraries and UI tabs are gone, and the Window menu lists the three; every kind is listed, made (Create menu: the "create" button or a right-click, named in place, in the folder shown), opened, renamed and deleted from the project window and the Inspector; the Assets side panel is gone: the chosen asset, material, prefab, resource or scene shows in the one Inspector (facts, options, preview, placing, address and labels); speakers and dialogue settings in Project Settings → Dialogue; libraries' "Save all" above each library's editor; e2e `project-items` (dock DOM, Window menu, creating and opening every kind, the Inspector, deletes); look: owner look pending |
| 27.16 | done 2026-10-01: one icon registry for every kind and every editor toolbar action, the art generated with the Studio in the phase-9 style and shipped as small WebPs (47 files, 105.7 KiB); `editor.css` spacing, type, radius and icon tokens; every item editor has a header (picture, name renamed in place, kind, folder), a toolbar of picture buttons and, while empty, an empty state with its first actions; graph nodes are coloured by category family; the timeline fills its window (D112); e2e `editor-chrome` (headers, toolbars, empty states acting, node header pixels, project-window pictures); before/after screenshots for the owner; look: owner look pending |
| 27.17 | done 2026-10-01 (before 27.18/27.19; the full gate is the main session's): D108 (an editor command after MCP edits waits for the change feed and is sent again), D109 (a late selection after the window closed is dropped), D111 (a screenshot waits for the first frame) fixed and their test syncs removed; D113 found and fixed (input exercises on a game without scripts); acceptance mapped to its specs in the decision log, new: every kind edited from its window back to the default view (`project-window`), a v5 project in the editor with matching replays (`project-upgrade`); a material, an effect and a timeline built through the UI only (`by-hand`, driven by a test; the owner's own try pending); `docs/deployment.md` (what you can do now, stale dock and tab wording) and the MCP descriptions updated |
| 27.18 | done 2026-10-01: a block layer's **Smoothing angle** (`smoothAngle`, degrees 0–180, Inspector and MCP; 0/absent = flat-shaded tops as before) averages the normals of tops meeting at the same height across cells and chunk edges (one ring of columns around the chunk is read; a corner cell re-meshes the diagonal chunk too), keeps edges sharper than the angle hard and never mixes walls in; **Top subdivision** (`topSubdivision` 2) draws sloped tops cut 2 × 2 with the inner heights blended from the corners; colliders and surface queries unchanged; a baked layer goes stale when either changes; e2e `smooth-tops` (Scene view, Play, export; pixels on auto, WebGL 2 and the webgpu project), unit `block-smooth`; default pictures before/after identical (0 differing pixels); mesher bench below the decision log entry |
| 27.19 | done 2026-10-01: an instance set's Inspector has the **instance brush** (Paint / Erase; radius, density per m², spacing, scale min/max, rotation, align to the surface normal, seed; kept per browser); a drag in the Scene view paints copies onto block layers (their colliders' shape) and objects with a collider (their drawn shape), straight down within two radii of the stroke, or erases them; one stroke = one `paintInstances` command and one undo, MCP the same op (without a surface the backend drops onto the scene's block layers); places from the seed (the same stroke gives the same copies, repainting adds none); the stroke's payload bounded once (`INSTANCE_BRUSH_LIMITS`: 256 dabs, 1,536 places), no count of the set's own; copies keep the set's chunking; e2e `instance-brush` (paint, undo, redo, the same stroke over MCP gives the same buffer, reload, erase, a model's cap, pixels in the Scene view and Play; MCP without surface, erase, undo, refusal), units; bench below the decision log entry |

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
- 2026-10-01 (27.5): E49 was reproduced on the scale bench, not on a copy
  of Skyforge; the timeout did not appear (D101 has the numbers), so the
  item answers when the restart is applied without claiming Skyforge's
  cause. A replay's answer waits for the new run up to the relay timeout less
  a margin (half of it: `replayAnswerWithinMs`, protocol; the backend sends
  it with the request), then answers `pending`. A first margin of 2 s timed
  out under a loaded fast gate (3 workers): the way back through the editor
  page took longer. The run id's
  epoch is the runtime's run count (every restart: the control, the pause
  panel, a script's `ctx.lifecycle.restart`, an input exercise's restart),
  so the backend's last-known run and `expectedRunId` follow it. Two replays
  queued before a step make one restart (the pending answers name the same
  run). A replay does not lift the engine pause (as before; the pause
  panel's restart does) — a paused game answers pending until it runs.
- 2026-10-01 (27.6): an image inside a model file stays the model's (read,
  kept and freed with it, part of its bytes under `resident.model`, which now
  also says `textures {count, bytes}`) and is counted again where the budget
  looks: the texture budget's fixed bytes, which streamed textures make room
  for. The two views overlap by design (the budget counts every texture,
  wherever it lives); nothing is resident twice. Images are counted once per
  image (`texture.source`: a loader's copies for another sampler share it).
  They do not stream (27.7 extracts them). Play diagnostics list the totals
  and the 8 models with the most (`EMBEDDED_TEXTURES_LISTED`, runtime) to keep
  the 16 KiB frame. The Scene view has no texture budget; it reports the same
  per-model counts (`objectResidentBytes`, three-adapter, used by Play and
  the view). The export runs the same game page.
- 2026-10-01 (27.6): bench generator version 8: every 10th model (200 at
  full) carries a 512² image inside, a KTX2 (ETC1S with mips, the engine's
  encoder) and a WebP (lossless, written by `tests/e2e/webp-make.ts`)
  alternately; the rest keep their 8 px PNG. Full preset, `files,open,play,walk`,
  GPU, WebGL 2, two runs each on the same generated project before (`69652e00`)
  and after:

  | | before | after |
  |---|---|---|
  | Play: click → first frame (ms) | 2,460 / 1,496 | 1,769 / 1,448 |
  | walk 50: model bytes, mean / max per scene | 1.45 / 1.74 MiB | 1.45 / 1.74 MiB (unchanged) |
  | walk 50: texture budget's resident bytes, mean / max | 0.92 / 0.94 MiB | 2.31 / 2.61 MiB |
  | walk 50: of those, inside models, max | not counted | 1.67 MiB (every scene has some) |
  | walk 50: scene load p50 (ms) | 155 / 158 | 165 / 158 |
  | after the walk: model, texture, embedded bytes | 0 | 0 |

  Play start is unchanged within the runs' spread (the first run after a
  build is the slow one either way). The models' bytes do not change; the
  budget now sees the 1.4 MiB a scene's model images average, which it did
  not before (Skyforge's 945 MB of model bytes is this case at full scale).
- 2026-10-01 (27.7): extraction follows Unity's and Godot's model: the
  model keeps its own materials and points their image slots at the texture
  assets (no project materials are made). The stored GLB is the file with
  each extracted image replaced by a one-pixel stand-in (white, a flat normal
  for a normal map), so it stays a valid self-contained GLB the import
  profile accepts; the loader draws a copy of the texture asset's texture
  (a streamed one's copy joins its stream) with the file's sampler and the
  slot's colour space. The record says `extractTextures: true` (the setting)
  and `textures {image index: assetId}` (the current version's); the
  version is converted from the GLB (`converter texture-extract 1.0`), so a
  cleared cache is made again from the file and a changed file is extracted
  again. Not a format change: two optional fields, as `streaming` was.
- 2026-10-01 (27.7): the texture files go next to the model, in
  `<model folder>/<model>_textures/`, named after the image (Godot puts them
  beside the scene; Unity asks for a folder). A PNG/JPEG is encoded to KTX2
  with mips — colour (ETC1S) for base colour, emissive, sheen and specular
  colour, normal (UASTC) for normal maps, data (UASTC linear) for the rest;
  an image sampled two ways gets the most exact. A KTX2 or WebP comes in as
  it is (no WebP decoder on the server), and an image over the encoder's 12
  Mpix cap as a plain image (it does not stream). An image some texture
  asset already holds with the same encoding is that asset: models sharing
  an image share one texture (the bench's 67 KTX2 models now share one).
  An image whose texture cannot be made stays inside the file, counted as
  27.6 counts it, and the result's `textureExtraction` says why. A model
  converted from FBX keeps its images (its GLB is Blender's). Seen in the
  gate: an extracted model whose GLB file went missing is still listed as
  missing but plays from its cached file (no placeholder), as its stored
  bytes are the import cache's; specs that count one file per model or need
  an image's exact pixels (noise) import with the setting off.
- 2026-10-01 (27.7): a new model's publish runs the textures' `importAssets`
  first, at the revision the publish was sent for, then the publish at the
  next one (two undo steps: undoing the model keeps the textures). A folder
  import puts the textures and the models in its one command. The default
  for new imports is one constant (`EXTRACT_TEXTURES_ON_NEW_IMPORT`,
  backend); the editor's Assets panel has the checkbox (on), and a model's
  inspector shows its setting and its textures with a "reimport" button when
  the setting is changed. Model thumbnails draw the extracted images from
  the textures' own tile pictures (small PNGs), so the editor worker never
  decodes their KTX2 (D104's open half is not met on this path).
- 2026-10-01 (27.7): bench generator version 9: the 200 models with a 512²
  image carry a KTX2 (the same image in each), a WebP and a PNG in turn.
  The new bench step `extract` re-imports them with the setting on, as the
  inspector does. Full preset, GPU, `files,open,play,walk` before and
  `files,open,extract,play,walk` after, two runs each on the same project:

  | | before | after |
  |---|---|---|
  | extract: 200 models (ms, p50 a model) | – | 82,974 / 81,634 (277 / 264) |
  | extract: textures made / an existing texture / kept inside | – | 134 / 66 / 0 |
  | backend RSS during the re-imports, sampled peak (MiB) | – | 1,390 / 990 (from 396) |
  | the same 200 re-imports without extraction (MiB) | 1,332 (from 359), 36,295 ms | – |
  | Play: click → first frame (ms) | 1,792 / 1,589 | 1,252 / 1,266 |
  | walk 50: model resident, most (KiB) | 2,805 | 75 |
  | walk 50: texture resident, most (KiB) | 960 | 3,669 |
  | walk 50: texture budget's resident bytes, mean / max (MiB) | 2.63 / 3.59 | 2.12 / 3.59 |
  | walk 50: of those inside models, max (MiB) | 2.67 | 0.01 (the 8 px PNGs of models not re-imported) |
  | walk 50: scene load p50 (ms) | 142 / 155 | 152 / 154 |

  D93: the encodes run one at a time on the encoder worker and add nothing
  the plain re-imports do not: the backend's peak comes from 200
  re-imports of an 18,000-asset catalog one after another (D106), not from
  KTX2 encoding.
- 2026-10-01 (27.8): `App.tsx` is split by area, not by size: each area
  (Play and its bridge, the project's content, the project settings, scene
  edits, Inspector edits, prefabs, blocks, bakes, scripts, the Animator, the
  documents' selections and commands, the project window, the dialogs) is a
  hook whose one returned object the shell's components take whole
  (`BottomDock`, `AssetsTab`, `InspectorDock` with `EntityInspector`,
  `EditorDialogs`, `editorMenus`, `workspaceHostOf`). The editor window, the
  Project Settings window, the window tools and the new dock (27.11–27.15)
  are built from those objects; `App.tsx` keeps the mount (client, Scene
  view), the projection refresh and the layout. The bottom dock's panels are
  still branches of one component (`BottomDock.tsx`) until 27.13–27.15 move
  them to their windows.
- 2026-10-01 (27.10): a scene's look is `{sky, fog, post, wind}` in its own
  file; the quality (the player's setting) and the presets (named looks laid
  over the active scene's) stay the project's. `setEnvironment` takes a look
  with `sceneId` and the project part without it; a look sent without a
  sceneId is refused saying where it goes (no "current scene" on the
  backend). A new scene starts from the engine defaults (no look, as a project
  that never set one; Godot's new scene has none) or copies one
  (`environmentFrom`; the editor's select beside "+ Scene", default the
  engine defaults). A v5 project's look goes into every scene so every scene
  looks as before; a v5 project without a look only rewrites `project.json`
  (no new revision).
- 2026-10-01 (27.10): the active scene follows Unity's rule (its look applies)
  and is simulation state in the environment director. The first start scene
  is active; `ctx.scenes.setActive(id, {blend, easing})` (a loaded scene;
  0–600 s) makes another; a transition that unloads the active scene makes its
  own scene active over its fade (the look blends while the view fades back
  in); a plain unload of the active scene makes the first scene still loaded
  active at once; with none loaded the look stays. Unity replaces the
  settings at once; the blend is this engine's deliberate difference. The
  blend resolves every preset over both scenes' looks, so a part one scene
  leaves out (its fog) thins away. The wind follows the active scene at once
  (it is a material input, not blended); effects keep the start scene's wind.
  Nothing new enters digests, observations or saves until the active scene
  first changes. A save restores its active scene only when that scene is
  loaded. A restart now resets the look (D107).
- 2026-10-01 (27.10): the editor shows the active scene's look in the Scene
  view and the material/effect previews, and today's Environment window
  edits the active scene's look (named at its top); 27.14 builds the Window
  menu's Environment window with a scene picker. The editor reads the looks
  with `queryProject {environments: true}` (opt-in: the rows stay small for
  every other caller, MCP `tl_inspect` too).
- 2026-10-01 (27.11): the editor window covers the editor's work area (the
  Hierarchy, the Scene/Game centre, the dock and the Inspector's dock) and
  leaves the menu bar, the toolbar and the status bar, so Play, undo and the
  menus stay in reach; the default view underneath keeps its state but is
  `inert`. The one Inspector is the same `InspectorDock`, rendered in the
  window's right side while it shows and in the dock otherwise (never both).
  Esc and × close the window and keep its tabs (remembered per project with
  the window's state and the split width), so the next item opened from the
  project window joins them; Window → Editor window brings them back; closing
  the last tab closes the window. Unity's separate windows close with their
  item; keeping the tabs is this editor's choice because the window covers
  the project window a second item is opened from. Ctrl+Tab cycles the
  window's tabs, and swaps Scene and Game without the window. Starting Play,
  Window → Scene/Game and a Window-menu tool window set the window aside.
  Closing returns the selection the default view had when the window opened
  (objects that still exist), whatever was selected meanwhile (a box made
  from the menu bar, say). An editor's own Esc (a wire being drawn, the node
  search) is taken first; a graph with nothing to cancel lets Esc close the
  window. "Open" stands beside an Inspector reference whose item opens in an
  editor (`RefPicker`, descriptor `ref` fields, the material mapping), doing
  what the project window's double-click does; asset references (textures,
  models) have none. Until 27.12's preview pane, a timeline's window is
  see-through above the timeline panel so its scrub preview in the Scene view
  stays visible.
- 2026-10-01 (27.12): the preview pane has one renderer for as long as the
  editor window shows (made when it opens, kept while its items are switched,
  released when it closes); a switch only swaps the subject (material,
  effect, model with its animator). The Assets tab's asset preview draws with
  the same `PreviewRenderer` until 27.15 moves it into the Inspector. The
  material preview keeps its own material library on that renderer (the one
  three-adapter compile path; GPU copies of shared textures per renderer, as
  before). What shows on its scene (a timeline at its playhead, a
  conversation, a UI document) is drawn by the Scene view itself: its canvas
  moves into the pane while such an item is in front and back when it leaves
  (no second renderer of the scene, no copy of it); input there does not
  reach the Scene view, and a timeline shows from the editor camera with its
  camera track's frustum, as the Scene view did. The timeline's see-through
  window is gone. The UI document pane shows the stored document at the
  editor's resolution (a drag shows when released) over the scene; the UI
  editor's editing surface stays in the editor (it is the editor, not a
  preview) and both draw with one UI layer path (`ui-layer-view`). The
  Animator preview runs as soon as its editor is in front (no Preview
  button, no dock choice). Unity's Shader Graph and Animator each keep their
  own preview; one shared pane is the owner's choice (§1).
- 2026-10-01 (27.12): previews are checked independently of their own
  bookkeeping (D88): the pane canvas publishes the renderer's live resource
  counts, and `<html data-tl-previews>` the counts of an empty stage after
  each switch (`idle`), which must not grow over switches (effect-editor) and
  the memory e2e's heap and GPU counts over 50 switches between an animator,
  a material, an effect and a timeline.
- 2026-10-01 (27.13): Project Settings is its own full window over the work
  area (z above the editor window, which stays under it, inert), not a
  document kind of the editor window: it has no Inspector and no item, like
  Unity's and Godot's. Sub-tabs on the left, search above them (Godot's
  filter); the search matches a sub-tab's name, a few words per sub-tab and,
  for Gameplay and Quality, the labels of the settings they hold (from the
  settings descriptor). The settings' Rendering group (renderer, depth,
  instance chunks, texture budget) shows only under Quality, the rest under
  Gameplay (`RENDERING_SETTINGS_GROUP`, project-model limits); the quality
  level left the Environment window. Tags and Collision layers are two
  sub-tabs (one dock tab before). Scripts holds the Behaviors panel whole
  (its list, new visual script, declaration, source, trust, publish); the
  Behaviors dock tab is gone and the e2e helper `openWindow('Behaviors')`
  opens Project Settings → Scripts. File → "Project tags" is gone (one
  "Project Settings…" item). Opening an item in the editor window, a tool
  window from the Window menu, the Scene/Game view or Play closes the
  settings window. Audio (the event → sound table) stays in the Media tab
  until 27.14 splits Media, then joins Project Settings as its own sub-tab.
- 2026-10-01 (27.14): Lighting and Environment are floating windows inside
  the work area, over the Scene view (Unity's Lighting window floats or
  docks; it is never a full window), shown while the Scene view is in front:
  the Game view, the editor window and Project Settings set them aside
  without closing them. They open side by side along the top of the Scene
  view; where each stands and whether it is open are remembered per browser
  like the dock sizes (Window → Reset layout forgets them). The scene they
  edit is the active scene (Unity's rule, and the one the Scene view draws),
  so the picker at their top makes the chosen scene active, opening it when
  it is closed: both windows always name the same scene, and an edit shows
  in the Scene view at once. A per-window scene that is not the active one
  would edit a look nobody sees; not taken.
- 2026-10-01 (27.14): a block layer's tools are its Inspector section's
  extension, shown while the layer is the selection (Godot's GridMap and
  Unity's terrain tools work the same way) and armed only while the
  Inspector is on the default view and the Scene view is in front; armed,
  they own the left button and the layer's move gizmo stands aside ("Edit
  cells" off brings it back). Choosing another layer in the tools selects
  it. A new layer comes from GameObject → Block layer (and "+ Layer" in the
  tools); both select it. "Create prefab from selection" names the prefab
  after the object without asking (renamed later, as Unity's dragged
  prefabs are) and reports through the notice line; the Hierarchy's context
  menu (right-click; the row is selected first when it is not part of the
  selection) offers it with Duplicate, Copy and Delete. The Prefabs tab keeps
  its list and "place copy" until 27.15. The Inspector shows an audio asset
  chosen in the project window until the next selection (Unity's Inspector
  shows whatever was chosen last); other asset kinds stay in the side panel
  until 27.15. The Media tab's sound list is gone (the project window lists
  sounds by kind). Project Settings → Audio is the event → sound table.
- 2026-10-01 (27.14): e2e helpers: `openWindow('Lighting'|'Environment')`
  opens the window from the Window menu and drags it over the right end of
  the bottom dock (specs read the Scene view's pixels with it open);
  `openWindow('Blocks')` selects the first block layer, and showing another
  dock tab or the project window deselects it (as showing another tab
  closed the Blocks tab); `openWindow('Media')` is Project Settings →
  Audio; `toolWindow`, `toolWindowScene`. Test backends pick their ports
  below the kernel's ephemeral range and retry a lost one (D110).
- 2026-10-01 (27.9): the helpers name what a person opens, not where it is:
  `openWindow(name)` for tools, `openProjectSettings(section)` for the
  settings that 27.13 moves, `openEditor(kind, name)` with the kind as the
  editor shows it ("Material", "Graph", "UI theme"). A click on the Scene
  tab that set an editor aside became `closeEditor()` (it ends on the Scene
  view, so it stays right once editors are full windows); only the view
  tests (`layout`) use `showView`. Opening from a domain panel (the
  Materials or Behaviors list) stays in specs that test that panel; where a
  spec only needed the item open it uses `openEditor`. The tab strip's own
  tests (`workspace-tabs`, the project window's double-click table) keep
  their direct selectors: 27.11 rewrites them with the window.
- 2026-10-01 (27.15): the dock keeps the project window (its tab named
  "Project", as Unity's), Console and Problems. Every list a removed tab
  showed is the project window filtered by kind (its kind menu writes the
  `t:`); every "New …" is its Create menu (Unity's Create menu; the "create"
  button above the list and a right-click on it), which asks for the name in
  place (Unity's in-place rename of a new asset) and makes the item in the
  folder shown, under an id from its name that no item of its kind has (looked
  up in the index, so it holds at any project size). The new item shows in
  the Inspector and opens in its editor where it has one. A right-click on an
  item opens or deletes it (one command, one undo; a refusal names the uses
  under the item in the Inspector). Graph material templates and graph kinds
  are Create submenus. A new animator controller plays the clips of the model
  chosen in the project window (else the project's first model), since a
  controller without a motion cannot be stored; "character locomotion" builds
  the states from the clip names as the Animator tab's button did.
- 2026-10-01 (27.15): the Inspector shows whatever the project window chose
  last until something is selected (Unity's rule, 27.14 for audio, now every
  kind): an asset's file, conversion, labels, address, texture facts and
  streaming, audio load settings and listening, a model's vertex colours,
  materials, clips, extracted textures and its preview, "place" and "delete";
  a shader material's or an instance's values (with "Convert to graph" and
  "+ new instance"), a graph material's summary with "Open graph"; a prefab's
  "place copy" with its initial overrides and "delete"; any other resource or
  scene its kind, file, name (a rename is one command), address and labels,
  "open" and "delete". A shader material and a prefab have no editor: a
  double-click (and "Open" beside an Inspector reference) shows them in the
  Inspector. An import shows its asset there. The lists' extra facts (a
  graph's node count, an effect's systems) are in their editors, not in the
  project window.
- 2026-10-01 (27.15): the speaker registry and the dialogue settings are
  project-wide, like Audio's event sounds: Project Settings → Dialogue. The
  libraries' "Save all" (one commit for every library with unsaved edits)
  stands above each library's editor. GameObject → "Model from asset…" and
  "Prefab copy…" show the project window searching `t:model` / `t:prefab`.
  e2e helpers: `createItem(page, entry | [submenu, entry], name)`,
  `chooseItem(page, kind, name or id)`; `windowTab('Assets')` is the Project
  tab.
- 2026-10-01 (27.16): one icon registry (`editor/src/session/item-icons.ts`):
  a picture per index kind (the asset kinds, the resource kinds, scenes),
  folders and visual scripts, and per toolbar action (the Scene view's move,
  rotate and scale too). The art is the Studio's (Qwen-Image, 256 px,
  transparent, the phase-9 prompt style; prompts, seeds and job ids in
  `tools/icons/editor-icons.tsv`); model, audio, prefab, behavior and the
  transform tools reuse the phase-9 object icons. Shipped as WebP cropped to
  what they draw: kinds 96 px (project tiles show them at ~50 CSS px), actions
  32 px (16 CSS px); 47 files, 105.7 KiB (`tools/icons/pack-editor-icons.mjs`
  prints each). The inline SVG tab glyphs and the project window's letter
  glyphs are gone.
- 2026-10-01 (27.16): every item editor has a header (picture, name, kind,
  folder from the index) above its own toolbar; the header's name field is
  the project window's rename (one command), so the editors' own name fields
  left their toolbars (a behavior keeps its name in its declaration; its
  header shows it without a field). Toolbars are rows of picture + name
  buttons (`ui/chrome/EditorChrome.tsx`); picture-only for the graph's align
  and distribute actions, as before. Empty states, with their first actions:
  a graph holding only the nodes its kind requires (an output, a Start), an
  effect without systems, a timeline without tracks, a UI document with only
  its root, a theme without styles. Scripts, libraries and animator
  controllers start with content and have none.
- 2026-10-01 (27.16): graph nodes are styled by their category's family
  (inputs, maths, logic, events, outputs, rendering, states, actions, notes;
  `graph/node-style.ts`): the canvas paints a node's header in the family's
  colour, a `--node-<family>` token in `editor.css` that the canvas reads, so
  the colour is defined once. The structural categories are named; anything
  else, such as a visual script's game API namespaces, is an action, so a new
  API namespace needs no entry. `editor.css` gained spacing, type, radius and
  icon-size scales beside its colour tokens; the new rules use them.
- 2026-10-01 (27.16): screenshots of every editor before and after, same
  views of the same generated Starter project (`editor-look.e2e.ts`, run with
  `TL_LOOK_DIR`), are in `~/.cache/thirdlight-phase27/look/` with a README
  pairing them. The look is unverified until the owner has seen them; a round
  of owner changes is expected.
- 2026-10-01 (27.17): the queued defects. D108: an editor command refused
  with `revision_conflict` because someone else edited first is not shown as a
  refusal: the client waits for the change feed to bring the backend's
  revision (`CHANGE_FEED_CATCH_UP_MS`, 3 s; past it the state is read again,
  as after a gap) and sends it once more against it, as a collaborative
  editor does (the user's edit wins over the tool's for the same field). A
  whole-document edit whose args were built from the older view is not resent
  (it would undo the tool's edit) and still shows the conflict; built at send
  time (`mergeDocumentEdit`) it is. D109: a selection a command makes when it
  answers belongs to the view it was asked from: asked under the editor
  window and answered after the window closed, it is dropped (closing restores
  the opening selection, as decided in 27.11). D111: `running` stays the
  simulation's state (a renderer is presentation, and the worker runs without
  one); the screenshot waits for the first drawn frame within half the relay
  timeout (the replay's `answerWithinMs`, now `relayAnswerWithinMs`, carried
  by the screenshot relay too) and answers `render_not_ready` past it. The
  test syncs that hid them are gone (editor-window's revision wait and
  wait-before-Esc, starter-capabilities' retry).
- 2026-10-01 (27.17): acceptance found D113 (an input exercise, so
  `tl_playtest`, on a game without scripts never answered: the plain step did
  not sample input); fixed (the plain step samples the input source).
- 2026-10-01 (27.17): this item ran before 27.18 and 27.19 (main session's
  order); their done-when lines stay open, and the full gate after them is
  the main session's.
- 2026-10-01 (27.18): **smooth tops.** `smoothAngle` follows Unity's
  model import "Smoothing Angle" (0–180°; Blender's auto-smooth is the same
  idea); absent or 0 is today's flat shading, so nothing changes until a
  layer sets it (stored only when above 0; `topSubdivision` only when 2;
  both values defined once, `BLOCK_SMOOTH_ANGLE_RANGE`,
  `BLOCK_TOP_SUBDIVISIONS`). A "top" is any up-facing triangle lying on its
  block's top surface, for stand-ins and model looks alike; its corners are
  welded by position (0.1 mm), so "the same height" is literal and a cliff or
  wall never averages in. Vertex normals are corner-angle weighted (a quad's
  triangulation does not tilt them); each point's tops are summed in a sorted
  order, so both chunks of an edge give bit-identical normals.
  `topSubdivision` 2 blends the inner heights bilinearly (rolling, not
  diamonds) and changes only the drawn surface: colliders, `ctx.grid`
  surface queries and brushes keep the corners' two triangles (they differ
  by at most a quarter of a top's twist at its centre). Side faces on the
  cell boundary and the base are not cut (the blend is linear along an
  edge). Lightmaps: either field puts a shading key into the chunk's layout
  digest, so a bake made before the change is drawn without its lightmap
  until baked again; the default digest is unchanged. Proof that existing
  scenes look the same: the mesher's output for a mixed fixture (every
  shape, slopes, a cliff, a pit, 2 × 2 chunks) hashed before the change and
  checked after (`block-smooth.test.ts`), and `smooth-tops`' default Scene
  view (1310 × 641) and Play (960 × 448) pictures from the old build and the
  new one: 0 differing pixels.
- 2026-10-01 (27.18) — mesher bench (`TL_PERF=1 tests/perf/block-layers.test.ts`,
  new case: 64 × 64 rolling sloped terrain, 0.5 m rows, 41,865 cells, 16
  chunks, stand-ins, median of 7 whole-layer meshes): before (old code)
  1,319 and 1,423 ms; after, the same default path 856–926 ms (the host was
  busier during the "before" runs — the code path is unchanged, the digest
  proves it), smoothed 1,137–1,163 ms (+25–30 % over flat in the same run;
  87,135 vertices instead of 118,116: smoothed tops share corners),
  subdivided 2 × 2 + smoothed 1,655 ms (+80 %; 79,136 triangles instead of
  46,300). Per 16 × 16 chunk: ~55 ms flat, ~70 ms smoothed, ~100 ms
  subdivided on this host (a stroke re-meshes 1–4 chunks).
- 2026-10-01 (27.19): **instance brush.** One op, `paintInstances {entityId,
  mode: paint|erase, dabs, brush, surface?}`, run in the backend that owns the
  state: the workspace reads the set's buffer, the command package plans the
  stroke (pure), the new buffer is published and stored as a `setComponent
  instances` change, so undo points back to the old buffer and a conflicting
  edit is rebased like any partial edit. Where copies may go does not depend
  on the dabs' overlap or order: world XZ is cut into cells of 1/density m²
  with one point each, jittered by a hash of the seed and the cell (integer
  arithmetic), and a stroke takes the points inside its dabs; so the same
  stroke gives the same copies and repainting with the same seed adds none
  (Unity's detail painting fills to a density in the same way; Godot has no
  built-in instance painter). Surfaces: copies drop straight down (as
  Unity's terrain detail and tree brushes do), within two radii
  (`INSTANCE_BRUSH_REACH`) above and below their dab; the editor finds the
  surface under every place (block layers through the colliders' surface
  query, objects with a collider through their drawn shape: the Scene view
  has no physics world) and sends it with the stroke; a caller without a
  view (MCP) gets the scene's block layers, the only colliders the backend
  can query without the models' geometry. Erase takes copies within the
  radius across and the reach up and down. Spacing is measured across the
  ground, against the set's copies and the new ones. One stroke carries up
  to 256 dabs and 1,536 places (`INSTANCE_BRUSH_LIMITS`, the worst case with
  millimetre numbers is under the 64 KiB command, a unit test checks it); a
  longer drag in the editor goes on as the next stroke (each one undo). The
  set keeps the model's 65,536-copy bound (phase 26's limits audit kept it:
  one buffer and one draw set); the brush adds no count of its own. The old
  click brush (upright copies 1 m apart, built in the editor and stored with
  `setComponent`) is replaced; single-copy editing stays.
- 2026-10-01 (27.19) — brush bench (`node tools/perf/run.mjs scale --preset
  full --steps open,commands,brush`, new step `brush`): a 128 × 128 block
  layer and a 50,000-copy set in the full-size project; strokes of 1,505
  places (~1,000 copies added each) with the editor's surface 161 ms p50
  (183 max) per command round trip, without a surface (the backend's
  block-layer drop) 150 ms, erase 104 ms, undo 136 ms, redo 143 ms; the
  scene edit in the same run 31 ms p50; backend 437 MiB resident after.
  In the editor (e2e, a small set): its surface pass 1–2 ms for 54 places,
  the command 20 ms.
- 2026-10-01 (27.17) — which test proves each "done when" line:
  - 27.1 screenshots: `screenshot.e2e.ts` ("a large, noisy scene's
    screenshot comes back whole over HTTP and MCP", per renderer; "a capture
    too large…", "a capture that fails…"; new: "a screenshot asked as soon as
    Play runs waits for the renderer's first frame").
  - 27.2 messages/signals/audio block: `tests/integration/m27-held-modes`
    (3D and 2D, with and without physics, page/worker/replay) and
    `play-audio-diagnostics.e2e.ts` (HTTP and MCP before and after unlock).
  - 27.3 missing files: `missing-files.e2e.ts` (Problems over HTTP and in the
    Problems tab, the refusal naming all, placeholders outside the start).
  - 27.4 re-imports: `play-reimports.e2e.ts` (HTTP, MCP, Problems tab).
  - 27.5 replay answer: `replay-answer.e2e.ts` (bench and Starter, both
    threading modes, HTTP and MCP, pending with the debugger holding).
  - 27.6/27.7 textures in models: `embedded-textures.e2e.ts`,
    `extract-textures.e2e.ts` (both renderers, webgpu project), bench numbers
    under the 27.6/27.7 entries above.
  - Default view (Scene/Game, Hierarchy, Inspector, dock of Project, Console,
    Problems): `project-items.e2e.ts` ("the bottom dock holds…"),
    `editor-window.e2e.ts` ("the default view keeps…"), and after every
    close in `project-window.e2e.ts`.
  - Every kind opens by double-click in a full window, edit, close, back to
    the default view: `project-window.e2e.ts` ("a double-click opens each
    kind…": material, timeline, UI document, UI theme, dialogue, effect,
    graph, animator and library renamed in their editor's header and read
    back, script; scene, prefab and shader material where they open);
    `editor-window.e2e.ts` (the window's geometry, the one Inspector, a
    script's declaration edit, Esc/× with the selection);
    `project-items.e2e.ts` (every kind made from the Create menu opens).
  - Each Project Settings sub-tab: `project-settings.e2e.ts` (Gameplay,
    Input, Tags, Collision layers, Quality, Saves, Game modes, Game shell,
    Scripts, each edit read back; search), `inspector.e2e.ts` (Audio's event
    sounds edited and read back), `window-tools.e2e.ts` (Audio's search),
    `project-items.e2e.ts` (Dialogue's speakers).
  - Lighting and Environment from the Window menu on two scenes:
    `window-tools.e2e.ts` ("Lighting and Environment float over the Scene
    view…; two scenes", pixels).
  - Two scenes with different skies and fog in the Scene view, Play and the
    export, both renderers: `scene-environment.e2e.ts` (both tests, per
    renderer variant and the webgpu project) and
    `tests/integration/m27-scene-environment`.
  - A version-5 project upgrades, replays match: `project-upgrade.e2e.ts`
    (new: opened in the editor, Problems, the Environment window on both
    scenes, the recorded command replayed, `tl_playtest` twice per threading
    mode with the same digests) and
    `packages/backend/src/format-upgrade.test.ts` (files, export).
  - By hand (a material, an effect and a timeline without the API):
    `by-hand.e2e.ts`, run with `TL_BY_HAND_DIR` (UI only; read back after a
    reload from the page); driven by a test, the owner's own try is pending.
  - The owner has looked at the new look: pending.
  - 27.18 smooth block-layer tops ("a block layer with a crease angle shows
    smooth rolling tops and hard cliffs, with no seam at chunk edges, on both
    renderers"): `smooth-tops.e2e.ts` (crease angle and subdivision set in the
    Inspector and read back over HTTP; brightness jumps across cell edges in
    the Scene view, Play and the export: faceted by default, none at the
    chunk edge or on the rolling ground with the angle, a hard crease at the
    steep slope; auto, WebGL 2 and the webgpu project) and
    `packages/project-model/src/block-smooth.test.ts` (identical normals on
    both sides of chunk edges and corners, walls and cliffs left out,
    crease kept, subdivided surface, collision unchanged, the default mesh
    byte for byte as before).
  - 27.19 instance brush ("an instance set is painted and erased with a
    brush on terrain, one undo per stroke"): `instance-brush.e2e.ts` (a
    stroke on a block-layer top and on a model's cap: one paintInstances,
    copies on the surface inside the stroke with the brush's scale and
    spacing; one undo, one redo; the same stroke over MCP gives the same
    buffer and repainting adds none; a reload; erase and its undo; the
    copies in the Scene view's and Play's pixels; the set's chunks; over MCP
    without a surface onto the block layer, erase, undo, a stroke too large
    refused), `packages/project-model/src/instance-brush.test.ts`,
    `packages/commands/src/instance-stroke-ops.test.ts`.
  - `tools/gate.sh full`: the main session's.
