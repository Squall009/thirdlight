# Phase 31 — Documentation and AI onboarding

Goal: a person can learn Thirdlight and build a game from the documentation
alone, in the editor or through the API. An AI agent in a game's folder learns
what the running engine offers from the engine itself, not from reading the
engine repo. Phase 31 starts after phase 30 (level building).

## 1. Where things stand (checked 2026-09-28)

- **Editor reach.** The editor sends all 62 command ops, so no op is API-only.
  The remaining gaps are elsewhere:
  - The API has no ops to delete prefabs, behaviors or assets. Phase 25
    covers assets and prefabs (25.7c); behaviors are covered in 31.1.
  - No panel shows or revokes script trust.
  - No one has built a level, prefab or material graph by hand yet. Only
    the Playwright tests have driven those panels.
- **User documentation.** `docs/deployment.md` is 3,473 lines in one file.
  Sections were appended phase by phase, and it mixes server setup, feature
  references and change history. It says what each feature is, not how to
  build a game or which way is recommended.
- **How an AI learns the engine today:**
  - MCP tool descriptions. The `tl_command` description alone is about
    40 KB of hand-written text, loaded into every session and prone to
    drifting from the code.
  - `tl_content_query target="game" includeDescriptors`, about 120 KB.
  - Game agents reading the engine repo's source and `docs/STATUS.md`
    directly. This leaks the engine/game boundary and only works on this
    machine.

  The MCP server sends no instructions, and it has no documentation lookup
  or resources.

## 2. Owner decisions (2026-09-28)

- The manual has one source. People read it as pages. Agents read the same
  pages through MCP and through a short skill that points into them.
- **MCP answers "what exists".** It always matches the running build. The
  reference comes from the code, so it can't drift.
- **The skill answers "how to work".** It holds the workflow, the
  recommended patterns and the pitfalls. It lists no ops or fields; for
  those it points at MCP. The engine ships it, and the project tool installs
  it into each game folder.
- **The dogfood project is the acceptance test.** A small game is built by
  hand in the editor, following only the manual. Every place it gets stuck
  is a documentation gap or an editor gap, and is fixed or listed.

## 3. Items

| Item | What |
|---|---|
| 31.0 | This plan, and its rows in `docs/STATUS.md` and `docs/roadmap.md`. |
| 31.1 | **Editor reach, the rest.**<br>• A `deleteBehavior` op, refused while anything references the behavior.<br>• A trust panel that lists acknowledged sources and can revoke them.<br>• A test that fails when a new op has no editor sender, and names it. It reads the op list from the validator and the editor's `client.command` call sites. |
| 31.2 | **Generated reference** (`docs/manual/reference/`, built by a tool and kept current by a test that regenerates it and diffs):<br>• components and their fields: type, unit, range, default, tooltip and Scene handle, from the descriptors<br>• the content documents (shell, eventCues, save schema, block types), with the descriptors extended where they are missing today<br>• every command op with its request shape, from the validator<br>• the script API: `ctx.*` with its doc comments, reusing `tools/gen-behavior-api.mjs`<br>• visual-script and material-graph nodes, from their catalogues<br>• engine limits and defaults |
| 31.3 | **Manual: getting started and concepts** (`docs/manual/`):<br>• install, the first project from the starter template, the first Play, the first export<br>• concepts: projects and scenes, objects and components, prefabs, assets, scripts and the step model (intents, determinism, replays), the game shell, 2D vs 3D |
| 31.4 | **Manual: how-to guides**, one per task. Each guide gives the editor path and the API path, and says which is recommended and why:<br>• build a level with block layers<br>• build terrain: sculpting, rule materials, rule scatter and splines, and a block area on terrain<br>• dress a scene with instance sets<br>• make and spawn a prefab<br>• write a script and a shared library<br>• visual scripts<br>• material graphs<br>• effects<br>• the animator<br>• cameras<br>• a HUD and menus with UI documents<br>• dialogue<br>• a cutscene with a timeline<br>• game modes<br>• saves<br>• input and rebinding<br>• audio<br>• lighting and baking<br>• play-testing with the headless runner (25.17)<br>• export<br>Also a "which tool for which job" page (block layers vs instance sets vs entities; scripts vs visual scripts) and a limits page. |
| 31.5 | **`deployment.md` goes back to running the server**: requirements, service, proxy, token, backup, the MCP connection. Feature sections move to the manual. Phase notes and change history stay in the plans. |
| 31.6 | **MCP onboarding:**<br>• server instructions: start with the getting-started topic, and look up an op or component before using it<br>• a `tl_docs {topic?}` tool (or MCP resources) that returns the manual and the generated reference from the running build<br>• tool descriptions shortened to a summary plus a pointer into `tl_docs`<br>• `tl_inspect target="engine"`: version and build (from 25.18), so an agent knows which manual it is reading |
| 31.7 | **The skill:**<br>• `skills/thirdlight/SKILL.md` in the engine repo, stamped with the engine version.<br>• Its content: the workflow (build scripts vs editor), the recommended patterns, game rules living in project scripts (principle 1b), play-testing, and common traps.<br>• `tools/project.mjs` installs or updates it into `<game>/.claude/skills/thirdlight/`.<br>• `check` warns when the installed copy is older than the pinned engine.<br>• The starter template ships with it. |
| 31.8 | **Dogfood.** A new project from the starter template is built **by hand in the editor, following only the manual**: a small 3D level made with block layers, a prefab, a material graph, a script with a shared library, a HUD, a title screen, a save and an export. No API calls, and no reading of engine source. Every stuck point is logged in the decision log and fixed in the manual or the editor, or listed as a follow-up. The owner does this pass, or watches it. |

**Done when:**
- The reference regenerates with no diff, and the op-reach test passes.
- Every how-to guide has been followed once, start to finish, on the
  starter template.
- An agent in a fresh game folder builds and play-tests a small scene using
  only `tl_docs` and the installed skill, without reading any engine repo
  file.
- The dogfood project is done, with its findings resolved or listed.
- `tools/gate.sh full` is green.

## 4. Progress

| Item | Status |
|---|---|
| 31.0 | done 2026-09-28 |
| 31.1 | done 2026-10-09: `deleteBehavior` (refused while an object in any scene or a prefab carries the script; one undo), Project Settings → Script trust (list read at load via `queryBehaviors includeTrust`, `revokeBehaviorTrust` refused while a published script uses the source or library version), `tests/editor-op-reach.test.ts` (78 ops; 2 API-only by design). `deleteAsset`/`deletePrefab` (25.7c) verified present. |
| 31.2 | done 2026-10-09: `docs/manual/reference/` (62 files, pages ≤ 48 KB, anchored sections, `index.json` topic → page and section) built by `node tools/gen-reference.mjs` from the descriptors, `ValidatedOpArgs`, the runtime's `BehaviorContext`, `GRAPH_KINDS` and the packages' exported limits; `tools/gen-reference.test.mjs` fails naming the stale page. JSON-valued fields gained a `shape` (their declared type). A refused command no longer shows "save: error". |
| 31.3 | done 2026-10-09: `docs/manual/index.md` (contents), `getting-started/` (install, first project, first Play, first export: editor path and API path), `concepts/` (11 pages), `guides/` (28 planned stubs with their file names for 31.4), `features/index.md` (the deployment.md section → page plan for 31.5); `tools/manual-links.test.mjs` checks every relative link and anchor (deployment.md included) and that no page is orphaned. Followed for real on a capped scratch backend: editor (picker → Starter → Crate edit and undo → Play, walk and jump → File → Export game… → zip) and API (templates, create, queryProject/setTransform/conflict/undo, play/observe/screenshot/stop with the headless editor, export, zip, `project.mjs create/export`); the export ran from `python3 -m http.server`, not from `file://`. Fixed on the way: two Inspector hints pointing at the old bottom-dock tabs, the shell's pause descriptor (Resume only); D220 logged. |
| 31.4 | part A done 2026-10-09: guides which-tool, block-layers, terrain, instance-sets, generated-architecture, lighting, environment, trim-sheets, performance, limits (editor and API path, recommendation, pitfalls). Followed by API on a capped scratch backend from the Starter template (every guide's commands sent, Play observed by headless screenshots and diagnostics: blocks, terrain with rules/scatter/road/courtyard, instance brush, rooms and a building restyled by a derived preset, height fog and sky, quality-level switch, stats overlay, streaming rings, a limit refusal); editor spot-checked by a capped Playwright drive (block tools, terrain tools, instance brush and Environment window shown; **Bake probes** run in the Lighting window, 1,512 probes, loaded in Play). Editor paths otherwise read, not driven; not run: `ctx.environment`/`ctx.grid.setArchitecturePreset` script calls, the trim padding check (no texture), terrain collision. 31.5 share: blocks, terrain, architecture, streaming, instance-sets, lighting, environment, rendering, performance, tuning moved to `docs/manual/features/` (114 deployment headings before = 83 left + 31 moved, none lost; deployment.md 7,245 → 4,443 lines). D221; fixed a doubled "the" in the Inspector's add-component reason. |
| 31.4 | part B done 2026-10-09: guides prefabs, material-graphs, effects, animator, cameras, scripts (a library with JSON data), visual-scripts, audio. Followed by API on a capped scratch backend from the Starter template, Play checked by headless screenshots, observations and diagnostics: a prefab placed twice and spawned/destroyed by a script, a library change recompiling its script, a graph material with an object override and an instance, a particle effect on an object, a controller switching Idle/Run under test input, a follow and an overview camera switched by a script, a visual script counting jumps, a looping audio source and a script sound (a capped Playwright Play after one click: loop playing, blips started; not heard). Editor spot-checked by Playwright: the corrected trust notice in Project Settings → Scripts, the scripts list, the project window's Create menu; the editor steps are otherwise read from the code, not driven. 31.5 share: editor, assets, animation, material-graphs (with trim sheets), visual-scripts, effects, scripting, physics, audio, debugging moved (83 deployment headings before = 38 left + 45 moved, none lost; 4,443 → 1,722 lines; the backup and Blender-host notes stayed in Deployment). Fixed on the way: an effect graph sent over the API with context nodes not named after their type did nothing (chains are now found by type); D220, D221 closed; D222 (8 source stages an hour), D223 (no MCP publish of TypeScript) logged. Deployment anchors still linked from the manual: `cameras-virtual-cameras`, `the-view-cameras-and-kept-objects`, `projects`, `projects-in-a-games-own-folder`, `migration-notes`. |
| 31.4 | part C done 2026-10-09 — 31.4 done: guides game-flow (a director on a kept object, title and play modes, Restart level by `ctx.scenes.reload`, Quit to title by unload and a mode switch), game-modes, saves, input (rebinding, pointer), co-op, ui-documents, dialogue, timelines, playtesting, export. Followed by API on a capped scratch backend from the Starter (every guide's commands sent; Play observed with headless screenshots, observations and diagnostics: title → New game loads the level with no run restart, an item collected and put back by Restart level, Quit to title, a save to slot 1 and a Play from it restoring `ctx.save` and the level, a dash action, a second player on its own actions, a pointer click, a rebind listening, the intro timeline's fade, bars and lift and its signal, a two-option conversation setting a variable, `tools/playtest.mjs` 2 runs × worker and single thread, the export served by `python3 -m http.server` and played with real Enter and A keys in a capped Playwright Chromium). Editor spot-checked by Playwright: Project Settings → Game shell, Game modes, Saves, Input and Dialogue show the settings the API wrote; the editor steps are otherwise read, not driven; not run: behavior groups, mode cameras and fades, time scale, the 3D pointer queries (the Starter is 2D), a rebind answered by a real key, the dialogue box by eye beyond one screenshot, sound. Fixed on the way: D222 (published source stages give way to new uploads; 10 publications in a row over HTTP), timeline handles and conversation numbers restart from 1 with a run (restarted runs reached other digests), the shell descriptor and panel text (no "new game" engine action, "make them in the project window"); D224 (observe says running after a script error), D225 (a second player breaks restarted-run determinism) logged. |
| 31.5 | done 2026-10-09: `deployment.md` keeps running the server — requirements (with Blender for FBX and the bake host, which part A had meant to keep and lost), start, the service, reverse proxy, owner token, MCP setup with the headless editor, backup and restore (folder projects included), upgrade, verification — and points to the manual (1,722 → 256 lines). The rest moved to `features/`: projects (the "What you can do now" subsections as current-state text), scenes-and-cameras (the scene-preparation paragraphs of the MCP section with them), gameplay, input, saves, timelines, ui, game-modes, dialogue, migration and a new play-tools page (what the MCP play tools do). Heading inventory: 37 deployment headings before = 10 left + 27 moved, none lost; `features/index.md` rows all done. Links fixed: the manual's six deployment anchors, source comments naming deployment.md sections, the reference regenerated; no other repo file linked a deployment anchor. |
| 31.6 | done 2026-10-09: server `instructions` (start at `getting-started/first-project`, look ops/components up in `tl_docs`, one mutation path); `tl_docs {topic?, query?, part?}` over `GET /api/v1/docs` (contents, page, `page#anchor` section to the next heading of its level, reference topic, link-form topic, search; ≤ 20,000 characters an answer, `next` names the next part); full tool texts moved to `packages/mcp-adapter/src/tool-docs.ts` and printed by the generator as `reference/mcp-tools-*.md` (`tool.<name>`, 36 `tool.tl_command.<area>` topics); `tl_inspect engine` adds `manual {dir, pages, topics}`; `tl_script_publish` (TypeScript `files` or `graph: true`, `check`) through the editor's source route, which now takes `container: {files}` (the route moved to `behavior-source-routes.ts`; D223 closed). Description sizes (characters) before → after: tl_command 75,694 → 689, tl_game_observe 5,235 → 344, tl_content_query 4,193 → 543, tl_diagnostics 3,779 → 380, tl_input_exercise 3,270 → 357, tl_content_upload 3,163 → 467, tl_game_control 2,841 → 347, tl_play_start 2,286 → 284, tl_playtest 1,768 → 298, tl_inspect 1,029 → 424, tl_instance_buffer 897 → 266, tl_screenshot 738 → 204, tl_content_job 196, tl_sessions 54, tl_play_stop 49 unchanged; new tl_docs 556, tl_script_publish 432; all 105,192 → 5,890 (tools/list 121 KB → 23 KB). The no-loss list: all 549 sentences of the old tl_command text and the 14 other texts whole are on the MCP tools pages (checked by script against the old descriptions; `tool-docs.test.ts` and `tools/reference/pages-tools.test.mjs` keep it so). Tests: `backend/src/docs.test.ts`, `mcp-adapter/src/onboarding.test.ts` (real client + capped real backend), `tests/e2e/mcp.e2e.ts` (instructions, tl_docs from dist/docs, visual script published with `tl_script_publish`). |
| 31.7–31.8 | — |

## 5. Decision log

- 2026-09-28: the skill carries no op or field lists. Only the running
  engine's MCP answers "what exists", so a game folder pinned to an older or
  newer engine never reads a stale catalogue.
- 2026-09-28: documentation comes after phase 25 (owner). Phase 25 items
  still update `deployment.md` as they land. 29.5 then moves those sections
  into the manual.
- 2026-09-28: this plan was phase 26; it became phase 27 when the owner put
  asset scale and streaming (`docs/plan-phase-26.md`) ahead of it, so the
  manual documents the engine without per-project asset caps. The limits page
  (29.4) describes the per-file sizes and runtime memory budgets phase 26
  leaves.
- 2026-09-29: renumbered again, 27 → 28: scalable lighting (Skyforge E45,
  owner) is phase 27, so the manual also describes the lighting after it.
- 2026-09-30: renumbered again, 28 → 29: the editor layout (owner) is phase
  27 and lighting 28, so the manual describes the new editor layout and the
  lighting after both.
- 2026-10-02: renumbered again, 29 → 30: the second batch of game requests
  (`docs/plan-phase-28.md`, owner) is phase 28 and lighting 29. The manual
  documents keep-loaded objects, `ctx.scenes.reload` and the game-built new
  game and restart (no engine run restart), and lists the deprecated
  `restartLevel` / `newGame` actions only in the migration notes. 30.1 also
  shows a model's triangles per LOD in the Inspector (Skyforge E18).
- 2026-10-03: renumbered again, 30 → 31: level building (blocks completed,
  terrain, the handoff; `docs/plan-phase-30.md`, owner) is phase 30, so the
  manual documents both. 31.4 gains a terrain guide.
- 2026-10-09 (31.1): §1's "the editor sends all 62 command ops" no longer
  held: there are 78 ops, and the editor sends all but `importResources`
  (issued by the backend's file check, which the editor starts) and
  `createEntities` (bulk creation for build scripts and agents; the editor
  makes objects one at a time). Both are on the op-reach test's API-only
  list with these reasons — default chosen, owner to confirm.
- 2026-10-09 (31.1): revoking trust is refused while a published script was
  built from that source or against that library version (rather than
  allowed with the script left running): every published source stays
  acknowledged, and a revocation means "ask me again next time". Delete or
  republish the script first — default chosen, owner to confirm. A
  behavior's uses are its `behavior` components only (scenes, prefabs and
  so live block types): no script call takes a behavior id, so unlike
  assets and prefabs a string literal in a script does not block the delete.
- 2026-10-09 (31.2): every content block already had a descriptor (the
  descriptors test refuses a block without one), so "extend the descriptors
  where missing" became: JSON-valued fields whose shape was only prose
  (scatter and material rules, architecture elements, outlines and
  buildings, block-type looks, terrain tiles and layers, the save settings
  document, the readOnly document lists) name their declared type in a new
  descriptor `shape` field, and the reference prints those declarations.
  They stay JSON in the Inspector; turning them into structured fields would
  change the editors — default chosen, owner to confirm.
- 2026-10-09 (31.2): reference layout — one page per area (objects,
  components by category, content blocks, scene environment, UI documents,
  ops, types, script API, one page per graph kind, limits per package),
  split past 48 KB; topics `component.<name>`, `content.<key>`, `op.<op>`,
  `type.<Name>`, `ctx.<member>`, `script-type.<Name>`, `graph.<kind>`,
  `node.<kind>.<type>`, `limit.<NAME>` for 31.6's lookup. Limits are the
  exported constants named `MAX_…`, `…_LIMITS`, `…_DEFAULT(S)`, `…_CAP`,
  `…_BUDGET` of seven packages, each under the file that defines it. The
  framework's `test` graph kind is left out; a node several kinds share
  (visual scripts, functions, libraries) is documented once and linked —
  default chosen, owner to confirm.
- 2026-10-09 (31.3): the manual's layout — `getting-started/`, `concepts/`, `guides/` (31.4: one page per task, the file names fixed now as stubs marked *planned*: the plan's list plus generated architecture, trim sheets, environment, game flow, co-op and performance, which the brief adds), `features/` (31.5: one page per feature area, the full descriptions moved out of `deployment.md`; `features/index.md` maps each deployment section to its page) and `reference/` (generated). Links into `deployment.md` are anchors the link test checks, so 31.5 moving a section fails the test until the links follow — default chosen, owner to confirm.
- 2026-10-09 (31.2): a refused command (an answer, not a lost edit) leaves
  the status bar at "save: saved" with the refusal's code beside it; a
  revision conflict and a lost answer still show "save: error". The visual
  script catalogue listed Random twice (core and `ctx.random`); now once.
- 2026-10-09 (31.4 part A): the moved feature pages keep every fact and setting but drop phase tags and history ("since 25.21", "until 28c.15" became "older engines…"); game names became "a game's"; per-feature measurements that lived in plan tables now point at `docs/plan-phase-30.md` §6; host-specific setup (the bake workstation) stays in Deployment. `setEnvironment` replacing the whole named document, `editTerrain bake` lists replacing their list, an `edges` box filling its inside and an API `paintInstances` landing only on block layers are documented as pitfalls, not changed — default chosen, owner to confirm.
- 2026-10-09 (31.4 part B): Test and debug entry points became `features/debugging.md` with its render-setting sections (frame-rate cap, ambient occlusion, render scale, dynamic resolution, quality levels) kept beside it rather than split into another page; the backup paragraph and the host's Blender path that sat inside the FBX section stayed in Deployment. The script trust notice is defined once, in the editor (the exporter's copy was unused), worded for both simulation threads. The scripts guide documents TypeScript publication over HTTP (stage, `content/behaviors/source`, acknowledge, publish) because MCP has none yet (D223) — default chosen, owner to confirm.
- 2026-10-09 (31.4 part C): the game-flow guide builds the title as a game mode (title: the title document, physics held; play: the HUD), not the shell's Title screen: the shell title shows only at the first start, and its `open` title action is the deprecated run restart (now said in the migration notes). Pause-menu buttons raise a UI event and `resume` together, because nothing steps under a paused shell screen. The MCP section's tool behaviour went to a new `features/play-tools.md`; the headless editor's host setup stayed in Deployment. A published stage is kept for a lost-answer retry and removed only when a new upload needs its room (rather than at once) — default chosen, owner to confirm.
- 2026-10-09 (31.6): the backend serves the manual (`GET /api/v1/docs`; the MCP process has no file access): `npm run build` copies `docs/manual/` and `docs/deployment.md` to `dist/docs/`, and the backend reads that copy once at start (else the checkout's `docs/`), so `tl_docs` describes the build that runs even after a pull or a rebuild until the restart; `tl_inspect engine` says which (`manual.dir`). Nothing of it is in an exported game. The full tool texts stay in code (the adapter's `tool-docs.ts`, limits interpolated from their owners) and the reference generator prints them, rather than being rewritten into hand pages: nothing is lost and they cannot drift from the build. Descriptions ≤ 1,200 characters each and 9,000 together (`tool-docs.test.ts`). Script code over MCP is a separate tool (`tl_script_publish`) sending the editor's source route with a new `container: {files}` body the backend canonicalises (sources up to the 1 MiB request bound; bigger ones stage as before); `tl_docs` needs a resolved project like the other tools — default chosen, owner to confirm.
