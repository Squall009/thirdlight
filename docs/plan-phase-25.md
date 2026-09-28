# Phase 25 — Requests from Sprout and Skyforge Tactics

Goal: close the engine gaps the two game projects reported, as generic
capabilities. Read `docs/roadmap.md` (principles 1 and 1b) first. Phase 25
starts after phase 24 is finished; nothing here is added to phase 24.

Sources, checked against main at `6cb394a` (2026-09-28):
- Sprout: `~/projects/sprout/docs/thirdlight_requests.md` (ids TL-1 … TL-22)
- Skyforge Tactics: `~/projects/skyforge-tactics/docs/engine-gaps.md`
  (ids E1 … E40)

The engine never reads either repo. The ids are only here so a request can
be traced back to the game that raised it.

## 1. Owner decisions (2026-09-28)

- **Everything goes in phase 25.** Phase 24 is not extended. The id space
  and the manifest cap wait for this phase rather than for 24.8's schema
  bump.
- **Lights belong to scenes.** Any scene may hold any light kind. At most
  one directional light is active at a time. Spot lights get cookies;
  directional lights don't.
- **The scripting model (E38)** is taken in the shape of §3: shared
  libraries, generic component reads, writes only to fields marked writable,
  callbacks, and source-mapped errors. Ownership is relaxed but not dropped.
  Fully dropping ownership is revisited only if a real game hits the limit.
- **Play-testing:** the engine ships a generic headless runner. A genre bot,
  such as Sprout's platformer bot, is game code and stays in the game's repo.
- **Entity ids:** wider global ids. Ids scoped per scene are revisited only
  if a real game hits the wider limit.

## 2. Closed without engine work

| Request | Why |
|---|---|
| E1–E17 | Done in phase 23. The leftovers that are still open are items 25.20 and 25.21. |
| TL-1 | Done: project UI HUD documents and `content.shell.hud`. |
| TL-1 addendum (`preset: 'none'`) | With `content.shell` no built-in HUD is drawn and the status line is opt-in. The flow HUD presets are deleted in 24.7. |
| TL-5 (enemy APIs) | This is a game rule. It is now covered by `health`, `patrol` and `hitbox` (24.4a–d). The generic remainder is in 25.13. |
| TL-9 (`completeLevel`, cutscene flow entries) | This is a game rule. It is now covered by `trigger.sceneTransition` and the shell's scene list (24.4e, 24.4j). The remainder is in 25.10. |
| TL-10 (death, respawn and checkpoint events) | These are game rules. Generic `damaged` and `died` events and trigger enter/exit events already exist. |
| TL-18, level-start path | That start path is deleted with the flow in 24.7. The remaining check is in 25.17. |
| TL questions 1 and 2 | Q1: automatic instancing exists (21.3). Q2: a mover carries whatever stands on it, whatever the collider shape. Sideways pushing on polygon colliders is checked in 25.4's tests. |

## 3. The scripting model (items 25.8–25.10)

Today every engine system has its own script service on `ctx` (about 35:
`health`, `patrol`, `look`, `camera`, `materials`, `sockets`, …). Writes are
intents applied at the end of the step. A behavior moves only the transforms
it declares in `ownedTransforms`; physics bodies and the camera can't be
claimed. Any property without a service needs a new engine API, which is
where most of the games' new requests come from.

Phase 25 adds one generic path next to the services:

1. **Shared libraries.** Libraries are compiled once, minified and tree
   shaken, and loaded as shared runtime modules. Behaviors link to them
   instead of bundling them. The determinism pins cover the linked output.
   This fixes E34 and E33.
2. **`ctx.entity(ref).get(component)`**: a read-only snapshot of any
   component, taken from the step-start state. Only fields the component
   descriptors mark as script-readable are exposed. The descriptors are
   versioned with the schema, so a field rename is a schema change and not
   a silent break.
3. **`ctx.entity(ref).set(component, patch)`**: a queued write, applied at
   the end of the step in a fixed order like intents today. Only fields that
   the descriptors mark `runtimeWritable` are accepted. Each such field has
   defined runtime behavior and its own test. Fields the engine treats as
   fixed at run time are not writable: static batching, baked lightmaps,
   static colliders, instancing, and assets that need loading. A write to any
   other field is refused with a problem naming the field.
4. **Relaxed ownership.** Any script may write the transform of an object
   that is neither a physics body nor the camera. Two writes to the same
   object in one step are resolved in script order, and the conflict is
   reported in diagnostics. Physics bodies keep dedicated intents
   (`character_place`, and the 2D place in 25.10).
5. **Callbacks** on the behavior spec: `onTriggerEnter/Exit`, `onContact`,
   `onMessage`, `onUiEvent`, `onAnimatorEvent`, and
   `onEnable/onDisable/onDestroy`. They are dispatched inside the step in a
   fixed order, on top of the event lists that already exist, which stay.
   Replays stay identical.
6. **Typed references.** `entityRef` properties become the normal way to wire
   objects, and prefab-local references work in spawned copies. `find(name)`
   stays.
7. **Source-mapped errors.** The editor shows the project's own sources, and
   error and log locations map back to the source files.

Services that act rather than set a field (`health.damage`,
`character.impulse`, `audio.play`, dialogue, timelines) stay. They carry
rules (events, clamping, physics) that a raw write can't. The generic path
replaces future "let scripts change field X" APIs, not the existing
services.

## 4. Items

Order: bugs → limits → scene lighting → scripting → movement → tools →
rendering and terrain. Each item keeps the gate green and has tests at the
boundary it changes (Playwright for any editor surface).

| Item | What | Requests |
|---|---|---|
| 25.0 | This plan, and its row in `docs/STATUS.md` and `docs/roadmap.md`. | — |
| **Bugs** | | |
| 25.1 | One exported manifest key list, used by project-model, the preview and both exporter paths. The order differs today (`manifest-v2.ts:133` vs `preview-m3.ts:409`, `export-m3.ts:511`, `export-bootstrap-m3.ts:169`), so Play fails whenever `modes` is present together with timelines, eventCues or shell. Add a test that builds, verifies and exports a manifest with every optional key present. | TL-15 |
| 25.2 | Screenshots always answer. The preview handler sends `screenshot_failed` with the reason whenever capture throws (`preview-m3.ts:921`). Add a WebGPU capture path (render and read back in the same task, or read a render target). Check that image textures upload in headless WebGPU. | TL-14, E24 |
| 25.3 | Environment blends are cheap. A new `t` updates fog, exposure and light uniforms; the environment map is re-baked only when its sky inputs change past a threshold (`three-adapter/src/environment.ts:419`). Acceptance: a new `t` every step at 120 Hz drops no steps once loaded. | TL-21 |
| 25.4 | 2D internal edges. The 2D character doesn't ground on or hang at internal edges between static colliders that share a face. Stacked or tiled colliders behave like one surface. | TL-20 |
| 25.5 | Scripts see a timeline's `ended` event. Reproduce first with a script-level test, main thread and sim worker, then fix. Add a play-end reason. A play that ends before it is presented records why (e.g. "the project reloaded"), and observe and diagnostics report it instead of a bare `play_not_found`. | TL-17, E26 |
| 25.6 | Small fixes:<br>• glTF `extras` are accepted and ignored on materials and every other object.<br>• The import scan says when a hit is in a comment or string, and gives the line.<br>• A `createEntity` refusal for a `setComponent`-only component says so.<br>• `input.cursor` accepts every map in `input.maps`. | E19, E21, E23, E25 |
| **Limits** | | |
| 25.7 | Scale limits:<br>a. **Entity ids:** wider global ids (`<kind>-N`, at least 6 digits) in `ops.ts`, `prefab-ops.ts` and `paste-ops.ts`. Old four-digit ids still load. The limit is documented.<br>b. **Manifest:** buffers, materials, material functions, libraries, dialogue and UI documents move out of the capped manifest into their own content files, listed by digest. Unused materials are left out.<br>c. **Assets:** the audio cap is raised to 64 (or becomes a byte budget, whichever the limits doc makes consistent). `deleteAsset` and `deletePrefab`, each refused while anything references it.<br>d. **Instance sets** are also chunked by spatial extent (a project default, overridable per set), so each chunk is culled and LOD'd locally.<br>e. **Bulk building:** `createEntity` accepts `static`, `active`, `locked` and `tags`. A `createEntities` batch is one revision and one undo step. | TL-12, E37, TL-19, E35, TL-22, TL-4 |
| **Scene lighting** | | |
| 25.8 | Lights belong to scenes. Every light kind (directional, ambient, hemisphere, point, spot) may sit in any scene. The start-scene rule is removed from the model (`project-v4.ts:142-177`) and from the runtime (`runtime.ts:4888`).<br>• Each scene holds at most one directional light.<br>• With scenes loaded on top of each other, the most recently loaded scene's directional light is active and the others are switched off, not added. When that scene unloads, the previous one comes back. Ambient and hemisphere lights follow the same rule.<br>• Point and spot lights from all loaded scenes count against the local-light budget.<br>• **Spot light cookies:** a texture on a spot light (three.js `SpotLight.map`, r186), in both renderers, with an Inspector field and a Scene-view preview. The WebGPU path is checked against the three.js docs first. Directional lights get no cookie.<br>Acceptance: a level scene with 12 point lights loads and they light it, and two scenes with different directional light colours switch correctly on load and unload. | TL-13, owner |
| **Scripting** | | |
| 25.9 | Shared libraries (§3.1), staged library edits (several patches, one commit, dependents compiled once) and source-mapped errors (§3.7). | E34, E33, E38 |
| 25.10 | Generic component access, relaxed ownership and typed references (§3.2–3.4, §3.6). First writable fields:<br>• light intensity, colour and range<br>• object `active`, with no rendering, collision, triggers or ticking while inactive<br>• `visible`<br>• the mover's speed and `active` flag<br>• material parameters<br>Also: a 2D `player_place` intent with velocity reset (reuses the `sceneTransition` placement), and `ctx.shell.nextScene()`. | E38, TL-6, TL-11c, TL-2, TL-9 |
| 25.11 | Callbacks (§3.5). | E38 |
| **Movement** | | |
| 25.12 | Mover signals: `stopOn`, `reverseOn` and `toggleOn`, and a `gravity` easing (constant acceleration). | TL-8 |
| 25.13 | Character controller: climb volumes (up/down input moves along them, jump leaves), and optional wall slide and wall jump. Both are off by default, in 2D and 3D. Gravity for bodies that aren't characters. `patrol` in 2D moves along any axis. | TL-7, TL-5 |
| 25.14 | `track` camera rig: camera regions (bounds, dead zone and distance per region, blended on enter) and vertical look-ahead. | TL-11a/b |
| **Tools and tests** | | |
| 25.15 | Relay input:<br>• run-length frames (`steps: n`)<br>• test frames drive the UI (pause, submit, cancel, navigate, and pointer clicks through the UI hit test)<br>• `pointer().overUi`<br>• element rectangles in `tl_game_observe`<br>• a virtual standard gamepad<br>The tool descriptions say gaps are neutral. | E22, TL-16, E27, E28 |
| 25.16 | `replay` and `start` on scene-mode projects, and a per-step digest in the observation for comparing a run with its replay. | E36 |
| 25.17 | A generic headless play-test runner: a CLI plus an MCP/API route taking a project folder, a scene, an input script or a project-supplied driver script, and an observation spec. It returns JSON. No genre bot ships with the engine. Also check that start `variables` apply on scene-mode and shell starts. | TL-3, TL-18 |
| 25.18 | An engine-info route and `tl_inspect target="engine"`: commit, build time, start time, and whether `dist/` is newer than the running process. The backend runs `materialGraphProblems` on set and load, and reports the problems in `tl_diagnostics` and `tl_content_query target="materials"`. | E20, E31 |
| **Rendering and terrain** | | |
| 25.19 | Materials and textures: material instances (an asset- or block-type-level mapping to a material plus parameter values), KTX2 texture assets, and KTX2 encoding on import (colour ETC1S, normals UASTC, with mipmaps). | E29, E30 |
| 25.20 | Block layers: sloped terrain (corner heights, slope and wall meshing, `ctx.grid` surface queries, height and smooth brushes, a `maxSlope` setting); lightmaps and chunk LOD on block layers (phase 23 leftovers). | E39, E8 |
| 25.21 | A painted terrain material: 4 height-blended PBR slots packed into 3 compressed texture arrays, paint and wetness stored with the layer, and an editor Paint mode. Needs 25.19 and 25.20. | E40 |
| 25.22 | Small UI and content items: a bindable `startAngle` and `size` on UI widgets, and an art-factory import route. The route reads a job's export, not the art-factory repo. | E32, E18 |

**Done when:**
- Every item above is done with its tests, and `tools/gate.sh full` is green.
- A new starter project can use in one scene: per-scene lights with a spot
  cookie, a script that reads and writes a light through `ctx.entity`, a
  shared library imported by two behaviors, a callback, and a mover toggled
  by signals. A Playwright test drives this through the editor.
- Each game's request doc can mark its items answered. That is a game-side
  edit made on the owner's say, not an engine item.

## 5. Progress

| Item | Status |
|---|---|
| 25.0 | done 2026-09-28 |
| 25.1–25.22 | — |

## 6. Decision log

- 2026-09-28: the owner put every request in phase 25 and none in phase 24.
  Wider ids and the manifest split therefore don't ride on 24.8's schema
  bump. They get their own schema bump in 25.7.
- 2026-09-28: when scenes are loaded on top of each other, the most recently
  loaded scene's directional light wins (owner). Ambient and hemisphere
  lights follow the same rule so that a scene's lighting is one unit.
- 2026-09-28: the scripting model is taken without dropping ownership
  (owner). The reason is that physics bodies and the camera belong to their
  systems, and writing them directly bypasses collision. Relaxed ownership
  covers the common case (a director moving units).
- 2026-09-28: Sprout's platformer bot stays in Sprout (principle 1b). The
  engine runner only runs input and scripts and returns observations.
