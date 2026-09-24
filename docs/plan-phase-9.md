# Phase 9 plan — towards a real platformer (overnight run)

Written 2026-09-24 after the owner answered every open question. A fresh
session can follow this file from top to bottom **without asking the owner
anything**: the answers are in §2, the order is in §4, the rules are in §3.
When something is still ambiguous, pick the option closest to Unity's
behaviour and to `~/projects/sprout/CLAUDE.md`, write the choice into §6
(decision log) and carry on.

Read first: `AGENTS.md`, `docs/STATUS.md`, `docs/architecture/charter.md`
(§3 scope), this file, and the auto-memory index. `archive/` is history only.

## 1. Where things stand (2026-09-24)

- Phases 0–8 (8 partly), 10 and 12 (a)(b)(c) are done; see `docs/STATUS.md`.
- Item 9.0 below (the owner's import bug list) is done in this session; see
  its row.
- The service runs on this LXC (`sudo systemctl restart thirdlight` after a
  rebuild); the owner edits Sprout in `~/projects/sprout` through it.

Inventory of what exists (so nothing is rebuilt by accident):

| Area | Exists | Missing |
|---|---|---|
| Materials | `surface` row on boxes (`types-v3.ts`), glTF materials as imported, `KHR_materials_*` accepted | material/texture assets, custom shaders, wind, surface on models |
| Lights | one directional + one ambient per start set, one PCF shadow profile (`three-adapter/src/lighting.ts`) | point/spot/hemisphere, baking, lightmaps |
| Rendering | plain `WebGLRenderer`, solid background | tone mapping, post, fog, sky, environment |
| Animation | rigid node clips, fixed idle/run/airborne role controller (`three-adapter/src/animation.ts`) | skins (rejected: `animation_skin_unsupported`), state machines, script API |
| Input | hard-coded keys A/D/arrows/Space + standard gamepad (`packages/input`) | data-driven actions, rebinding, editor window |
| Scripts | `ctx.tags/scenes/world/physics/intents` (move, jump, position, respawn) | spawn/destroy, rotation/scale, audio, UI, timers, raycasts, signals, save |
| Game loop | zones hazard/checkpoint/goal/exit, deaths, title/replay HUD | lives, health, score, pickups, pause, menus, level list, game over |
| Physics | Rapier 2D, static box/convex polygons (≤ 8 verts), one kinematic capsule | kinematic movers, one-way platforms, sensors, several characters |
| Audio | WAV one-shot cues (5 kinds), 8 voices | music, loops, buses, positional, script audio |
| Save | none in exported games | everything |
| Export | `export-m3.ts`; forbidden-text scan `exporter/src/scan.ts` | containers for textures/music |

## 2. Owner decisions (2026-09-24) — do not re-ask

Import fixes (done in 9.0):
- A multi-piece GLB expands into one tile per piece; dragging the whole file
  makes a folder with one child per piece laid out in a row; pieces share the
  loaded materials/textures.
- `<piece>_LOD0..n` = real LOD switching in editor, Play and export;
  `<piece>_COL` = never drawn, becomes the piece's collider.
- COLOR_0 is shader data by default; an asset option `vertexColors: tint`
  restores the glTF tint.
- Asset thumbnails live in the data-root cache (`<dataRoot>/cache/thumbnails`),
  never in the game repo.

Scope and permissions for the overnight run:
- May restart the service after green commits.
- May change and commit in `~/projects/sprout` (follow its `CLAUDE.md`: every
  file in `assets/` comes from a script in `art/scripts/`).
- May use the Qwen-Image GPU on the workstation (`~/projects/qwenimage`,
  `python3 gpumode.py image`, back with `python3 gpumode.py llm`). The owner
  does not want reminders about GPU mode.
- Heavy Blender jobs (light bakes, long renders) run on the **RTX 5090
  workstation** over SSH (`ssh 10.0.10.145`, Blender at
  `/opt/blender/5.2.2/blender`, 16 cores; OptiX when ≥ 4 GB VRAM are free,
  else CPU), not on this LXC. Small scripted Blender work (authoring clips,
  exporting a GLB) may run locally (`bpipe`/`blender` on the LXC).
- Include: phase 11 (headless Play for MCP), the rest of phase 8 (remove
  v1/v2 model code, regenerate `fixtures/commands` in v3/v4 — owner approved),
  and the phase-3 leftovers (duplicate a multi-selection, copy/paste between
  scenes).

Feature decisions:
- Animation: skinned rig import + clips + an **Animator** (state machine with
  parameters, transitions, crossfades, 1D blend trees, clip events, script
  API, preview). **No** keyframe timeline, **no** retargeting.
- Author real game-ready clips for Sprout (idle, run, jump, fall, land) and
  the boar (walk, charge, plus idle/hurt/defeat as needed) with Blender scripts
  in the Sprout repo, and use them in the demo level.
- Light baking: **both** — an in-browser progressive GPU baker for quick
  previews and a Blender Cycles bake (workstation) for final quality.
- Materials: a Unity-style **material inspector with shader types now**; a
  node graph **later** (add a planned phase row for it, do not build it).
- Rendering: core post stack (tone mapping AgX/ACES/Neutral, exposure, bloom,
  colour grading incl. optional LUT, vignette, FXAA/SMAA), **plus SSAO and depth
  of field** (off by default, per quality level), fog incl. fog volumes.
- Sky: a **physically based generated sky by default** (sun direction drives
  the key light and the environment lighting), **overridable** with the
  owner's own sky textures (equirect or six-face cubemap). Also generate a few
  starter panoramas with Qwen-Image.
- Game-loop built-ins (all four): menus + level flow (title, pause, level
  complete → next, game over, settings with volume/rebinding/quality);
  health + lives (damage, knockback, invulnerability, checkpoint respawn, game
  over at 0); collectibles + score (pickups, HUD counters, per-level totals into
  the save); enemies + moving things (patrol/chase, stomp to defeat, contact
  damage; moving platforms, doors, switches, one-way platforms).
- The owner's original phase-9 list also asks for: a save system, a skybox
  editor, a material editor with global wind, fog volumes, an input editor
  window, and better scene placeholders with transparent icons from Qwen-Image.

## 3. How to work (rules for the run)

1. Work the items of §4 in order. Each item is one or more commits; keep each
   commit coherent and green.
2. For each item: short design note in §6 if you had to choose → schema and
   commands (project-model, commands, workspace envelope lists, protocol op
   lists, MCP tool text) → runtime/three-adapter/game-host → editor UI →
   exporter → tests → docs.
3. Tests: unit tests next to the code; **every editor/UI change gets a
   Playwright test** driving the real page against a real backend
   (`tests/e2e/*.e2e.ts`, pattern: `tests/e2e/model-pieces.e2e.ts`). Pixels are
   checked with `tests/e2e/png.ts`. Play is checked in the preview iframe; export
   is checked served statically with the backend stopped
   (`tests/e2e/play-export.e2e.ts`).
4. Green means: `npm run build` prints the literal line `build: done` (a
   failing boundary check prints `FAIL`, not `error`), `npx vitest run` passes,
   and the e2e files you touched pass. Run the full `npx playwright test` at
   least after every lettered item (write its log **outside** `test-results/`:
   Playwright wipes that folder on start).
5. Then: commit to `main` with a clear message, `git push origin main`,
   rebuild if needed and `sudo systemctl restart thirdlight`, update the item's
   row in `docs/STATUS.md` (one or two lines) and tick the item in §5 with the
   date and commit.
6. Never write handoff files, gate reviews or evidence dumps. Never claim a
   visual/audio result you did not observe: Playwright screenshots count as
   observed pixels; "looks right to a person" is always "owner look pending".
7. Game art (Sprout) must be game-ready: triangle budget, LODs, baked normals,
   no hidden geometry, collision, compressed textures. Report triangle counts,
   LODs, texture sizes and file size in the commit message of any asset.
8. If an item is blocked (e.g. the workstation is off), record why in §6, do
   the next item, and come back to it.

### Traps (from earlier sessions)

- The shell exports `NODE_ENV=production`: `npm ci` silently drops dev deps.
  Use `NODE_ENV=development npm ci --include=dev`. Add dependencies only with
  exact versions and add their pins to `tools/check-deps.mjs`.
- `/tmp` is RAM (tmpfs). Keep scratch small and delete it; big scratch goes
  under `~/.cache/thirdlight-*`.
- Package boundaries are enforced by `tools/check-boundaries.mjs`: a new
  `three/examples/jsm/...` module must be added to the three-adapter allowlist
  there (with a comment); Node builtins are refused in some packages' tests
  (backend tests may use `node:fs`/`node:path`, not `node:os`/`node:zlib`).
- The export bundle is scanned for forbidden text (`exporter/src/scan.ts`):
  no `fetch(` (except `./snapshot.json`), `node:`, `process.`, `__dirname`,
  `http://`, `https://`, `file://`, `XMLHttpRequest`, `WebSocket`, `/api/v1/`,
  `/mcp`. Minified object keys count: `{ node: x }` becomes `node:x` and fails.
  Runtime code gets every byte through the content closure, never a URL.
  New content kinds (textures, music) need a container check in
  `exporter/src/export-content-scan.ts`.
- New ops must be registered in: `commands/src/types.ts` (op unions, change
  and inverse types), `validate-request.ts` (OPS, EXPECT text, dispatch),
  `apply.ts`, `history.ts` (undo and redo), `index.ts` exports,
  `workspace/src/envelope.ts` (result ops, change keys, op→change map),
  `protocol/src/m3.ts` (op and change lists), `mcp-adapter/src/tools.ts`
  (op enum + description), and the editor projections
  (`session/projection.ts`, `session/content-projection.ts`).
- Canonicalizers in project-model rebuild objects field by field: a new
  optional field must be added there too or it is silently dropped.
- `git rm` was blocked by the auto-mode classifier before: archive with
  `git mv` into `archive/` instead.
- Exports must be written outside `<dataRoot>/projects`.

## 4. Work items, in order

Every item lists **data**, **runtime**, **editor**, **MCP/export** and
**done when**. Limits are suggestions sized for a 2.5D platformer; keep them
explicit in validators.

### 9.0 Import fixes (owner bug list) — done 2026-09-24

Multi-piece GLBs (pieces by `<piece>_LOD<n>`/`<piece>_COL` naming, a folder
per whole-file drop with the pieces in a row, one undo), real LOD switching
(`THREE.LOD`, 8 % / 3 % screen-height thresholds), `_COL` → convex 2D collider
(≤ 8 vertices), COLOR_0 as data unless `setAssetOptions {vertexColors:
"tint"}`, drag from asset tiles into the Scene view and hierarchy folders,
rendered tile thumbnails cached in the data root, skinned clones via
`SkeletonUtils.clone`. e2e `model-pieces`. Owner look pending (drag Sprout's
foliage and kit files in).

Follow-ups to keep in mind (fold into later items):
- LOD thresholds are fixed; add a per-asset `lodBias` to `setAssetOptions` in
  9.3 if Sprout foliage switches too early at the gameplay camera distance.
- Thumbnails are keyed by digest only; after a vertex-colour or material
  change they may show the old look — re-render when the asset options change
  (key by digest + options hash) in 9.3.

### 9.1 Phase-3 leftovers: multi-selection duplicate, copy/paste across scenes

- Duplicate (Ctrl+D) duplicates every selected root with its subtree in one
  command (extend `createEntity {children}` to nested children, or a new
  `duplicateEntities {entityIds, offset}` op with undo); new ids, same scene.
- Copy/paste (Ctrl+C / Ctrl+V): the editor keeps a clipboard of entity values
  (subtrees); paste creates them in the **active** scene (so it works across
  scenes) at the view focus, as one command. References inside the copy
  (spawn ids of checkpoints, exit zones) are remapped when they point inside
  the copy, left as-is otherwise (a dangling reference is refused by the
  validator — show the error).
- Done when: e2e duplicates a 3-object selection with one undo, copies from
  scene A and pastes into scene B.

### 9.2 Phase 11: headless Play for MCP

- The backend (or the MCP adapter) starts its own Chromium through
  `playwright-core` (already a dev dep via `@playwright/test`; make it a pinned
  runtime dependency of the backend only, never of the runtime bundle) when an
  MCP `tl_play_start` arrives and no editor browser is connected. It opens the
  preview page for the play session with the same isolation as the editor's
  iframe. A connected owner browser still takes priority.
- Reuse the LXC library setup from `tests/e2e/browser-env.mjs`
  (LD_LIBRARY_PATH with the borrowed libs, SwiftShader WebGL); make the path a
  backend config option (`--browser-libs`, env `THIRDLIGHT_BROWSER_LIBS`) and
  document it in `docs/deployment.md`.
- `tl_screenshot`, `tl_input_exercise`, `tl_game_observe`, `tl_play_stop` work
  against the headless session; it shuts down after an idle timeout (5 min) and
  on `tl_play_stop`.
- Done when: `tests/e2e/mcp.e2e.ts` gains a test that plays, screenshots and
  drives the game with **no** editor page open. From here on, use headless
  Play through MCP to look at your own work in Sprout.

### 9.3 Phase 8 rest: one schema version

- Remove the v1/v2 model code from project-model, commands, workspace and
  runtime (list in the phase-8 row of `docs/STATUS.md`; archive with `git mv`
  under `archive/removed-v1-v2/`). Only v4 storage remains loadable; v3
  projects keep upgrading on open (`project-v4.ts` migration stays).
- Regenerate the `fixtures/commands` contract corpus (scenarios 01–09) in v4
  with the tools in `fixtures/commands/tools/`, keeping every scenario's
  intent (retry, reused request id, stale revision, no partial writes, mixed
  undo/redo, crash before/after replace, external modification, second
  backend). Update the tests that read them.
- Time box: if this grows beyond one long session of work, stop after the
  runtime/commands part, record it in §6 and continue with 9.4; return at the
  end.
- Done when: build + all tests green; grep finds no `schemaVersion: 2` paths
  outside `archive/` and migration code.

### 9.4 Textures, materials and the material inspector (with global wind)

Data:
- New asset kinds: `texture` (PNG, JPEG, WebP, KTX2; ≤ 4096², colour space
  sRGB/linear declared at import; inspector checks headers and size) and
  `material` (a JSON asset stored like a source blob with `kind: material`, or
  a `content.materials[]` block — prefer a content block: materials are small
  and edited often; each edit is a command with undo).
- A material: `{materialId, name, shader, params, textures}`.
  Shader types (closed set, each with a declared parameter schema):
  - `standard` — PBR: baseColor, map, normalMap, roughness/metalness (+ORM
    map), emissive, alpha mode (opaque/cutout/blend), double-sided, UV
    tiling/offset.
  - `foliage` — standard + wind driven by COLOR_0 as documented in Sprout's
    `CLAUDE.md` (R bend weight root→tip, G phase, B flutter, A thinness for a
    cheap subsurface term); double-sided without back-face normal flip;
    per-material wind response (bend strength, flutter strength, flutter
    frequency).
  - `kit` — standard + `uv0.x += worldX / uPeriod` (period 4 m default) so
    the detail atlas flows across joins, macro normal on UV1 blended over the
    detail normal (whiteout), glTF occlusion on UV1 (the Sprout kit manifest
    describes both).
  - `unlit` — colour/texture, optional vertex tint.
  - `water` — scrolling normal maps, fresnel, depth colour; simple, no SSR.
- Global wind (project settings, `content.environment.wind`): direction (XZ),
  strength, gust strength/frequency, turbulence; editable, animated in the
  editor view and in Play/export by one shared uniform block.
- Assignment: `components.materials` on model entities (glTF material name →
  materialId; absent = the file's own material) and on boxes (replaces
  `surface`; keep `surface` working); an asset-level default mapping
  (`setAssetOptions {materials: {...}}`) so every placement of Sprout's
  foliage uses the foliage material without per-entity work.
Runtime: `onBeforeCompile` on `MeshStandardMaterial`/`MeshPhysicalMaterial`
  (keep three's lighting, shadows and fog); shared uniforms (time, wind);
  materials built once per (materialId, mesh kind) and shared; instanced sets
  supported (per-instance world X for the kit shader comes from the instance
  matrix).
Editor: a Materials tab (tile grid with rendered sphere/plane previews in the
  thumbnail cache), a material inspector (shader type dropdown + parameter
  controls + texture slots accepting texture tiles by drag), drag a material
  onto an object/piece in the Scene view to assign it, a global wind section in
  project settings.
Export: textures in the content closure with a container check; material and
  environment blocks in the snapshot/manifest (buildId covers them).
Done when: e2e imports a texture, creates a foliage material, assigns it to a
  multi-piece asset, sees the vertices move between two screenshots (wind) in
  the editor and in Play, and exports. Assign Sprout's foliage and kit
  materials in the Sprout project (commit there).
Later (planned only): add a STATUS row "13 — material node graph" (not built).

### 9.5 Lights, environment, sky, fog and post-processing

Lights:
- Light types `point`, `spot`, `hemisphere` added to `directional`/`ambient`;
  fields `range`, `decay`, `angle`, `penumbra`, `castShadow`, `mode:
  realtime|baked|mixed` (baked lights only feed 9.6). Limits: ≤ 8 realtime
  point/spot lights per loaded scene set, ≤ 2 shadow-casting (warn in
  Problems beyond that), ≤ 64 baked lights.
- Viewport shows the authored lights (a "scene lighting" toggle like Unity),
  gizmos for range spheres and spot cones.
Environment (`content.environment` + per-scene override `scene.environment`):
- Sky: `procedural` (default; three's `Sky` addon — Preetham, with turbidity,
  rayleigh, mie, sun elevation/azimuth; the sun direction drives the
  directional key light when "sun linked" is on), `gradient` (top/horizon/
  bottom colours), `texture` (equirect texture asset or six texture assets for
  a cubemap). The sky is rendered to a PMREM environment map for image-based
  lighting (`environmentIntensity`), regenerated only when the sky changes.
- Fog: `none|linear|exp2` scene fog plus **fog volumes**: a `fogVolume`
  component (box size, density, colour, falloff at the edges, height
  gradient) rendered in the post pass from depth (analytic ray–box distance ×
  density), ≤ 16 per scene.
- Post stack (three's `EffectComposer` addons: `RenderPass`, `GTAOPass` for
  SSAO, `UnrealBloomPass`, `BokehPass` for DOF, `SMAAPass`/FXAA, `OutputPass`
  for tone mapping + sRGB, `LUTPass`, a small custom colour-grading pass for
  contrast/saturation/lift-gamma-gain and vignette, and the fog-volume pass).
  Tone mapping AgX default; exposure. SSAO and DOF off by default.
- Quality levels `low|medium|high` (project default + player setting from
  9.10 menus): shadows map size, post passes allowed, pixel ratio cap.
  Capability fallback: if WebGL2 float targets are missing, disable the
  affected passes and record a diagnostic; gameplay never breaks.
Editor: an **Environment window** ("skybox editor"): sky mode, parameters with
  a live preview in the Scene view, texture slots (drag texture tiles), fog
  settings, post stack toggles and sliders, quality level preview. Scene view
  toggle between "editor lighting" and "game lighting" (default game).
Qwen skies: generate 3–4 equirect panoramas (e.g. "clear morning meadow sky",
  "golden hour", "overcast", "night") at 2048×1024 with Qwen-Image
  (`~/projects/qwenimage/client.py`), make the seam wrap (blend the left/right
  edges), store them in Sprout under `assets/env/sky/` via a script in
  `art/scripts/env/`, import them as texture assets. The procedural sky stays
  the default.
Export: new addons pass the bundle scan; their shaders contain no forbidden
  text (check `THREE_RECORD` counts in `scan.ts` if three internals add URLs).
Done when: e2e switches sky modes (pixel colour of the upper viewport
  changes), toggles bloom (bright pixels spread), enables a fog volume (pixels
  inside get the fog colour), and Play/export show the same. Owner look
  pending.

### 9.6 Light baking (browser preview + Blender Cycles final)

Common data:
- Entities marked `static` with a model/box take part. Lightmap UVs: use UV1
  when the mesh has one (Sprout kits do: unique per piece), else the Blender
  path auto-unwraps (Smart UV Project on a copy) and the browser path skips
  the mesh with a Problems note.
- Result: `content.bakes[]` or a per-scene `lighting` block: `{bakeId,
  createdAt, quality, atlases: [texture asset ids], entries: [{entityId,
  atlas, scaleOffset:[sx,sy,ox,oy]}], lights: hash, statics: hash}`. When a
  static entity or baked light changes, the bake is marked stale (Problems
  entry, still used until rebaked or cleared).
- Runtime: `lightMap` on the entity's material clone, `lightMap.channel = 1`,
  per-entity scale/offset through a uniform added in `onBeforeCompile` (or a
  texture transform). Baked lights are not realtime; mixed lights keep direct
  realtime lighting + baked indirect.
Browser baker: three's `ProgressiveLightMap` approach (accumulate shadowed
  light from jittered light positions into UV1 render targets) running in the
  editor tab; "Bake preview" button with progress/cancel; result uploaded as
  PNG (RGBM or 16-bit PNG) texture assets through the normal content routes.
Blender baker (final): a backend job that
  1. writes a bake package: every static mesh's GLB piece + transform, baked
     lights, sky/environment settings, lightmap resolution per entity (texel
     density setting, default 16 px/m for kits);
  2. copies it to the workstation (`scp` as `dadmin`), runs
     `/opt/blender/5.2.2/blender -b --python <engine>/tools/bake/cycles_bake.py`
     (the script is part of this repo; OptiX if ≥ 4 GB VRAM free, else CPU);
  3. packs per-entity lightmaps into ≤ 2048² atlases (denoised with OIDN),
     copies them back and publishes them as texture assets + the bake block in
     one command.
  Config: `THIRDLIGHT_BAKE_HOST`, `THIRDLIGHT_BAKE_BLENDER`, SSH key of the
  service user; without a bake host the button explains how to configure it.
Editor: a Lighting window (bake mode, texel density, samples, bounce count,
  "Bake preview (browser)", "Bake final (Blender)", progress, clear bake,
  stale warning).
Done when: unit tests for the atlas packing and stale detection; e2e runs the
  browser bake on a two-box scene and sees the baked shadow in Play; the
  Blender path is exercised with a fake bake host in tests and **once for real**
  on the workstation with a Sprout test scene (record timing in §6).

### 9.7 Rig import and animation (Animator)

Import:
- Accept skins (`JOINTS_0`/`WEIGHTS_0`, ≤ 4 influences, ≤ 128 joints per skin,
  ≤ 4 skins per file), morph targets (≤ 32), and animated skinned models; clip
  limits raised to ≤ 64 clips, ≤ 120 s, ≤ 256 channels, ≤ 500k keyframes (keep
  them in `asset-pipeline/src/limits.ts`).
- Animation-only GLBs (clips for an existing rig, matched by bone names) are
  imported as `animation` assets referencing their rig asset; a mismatch
  (missing bones) is an import error listing the bones.
Data:
- `animatorController` content block/asset: parameters (`float|int|bool|
  trigger` with defaults), layers (base layer; an optional second override
  layer with a bone mask), states (`clip` = `{assetId, clipName}` or a 1D
  blend tree `{parameter, children: [{threshold, clip}]}`, speed, loop,
  speed parameter), transitions (from state or Any State → state, conditions
  on parameters, duration, exit time, interruption none/source), entry state,
  clip events `{clip, time, name}`.
- `animator` component on a model entity: `{controller: id, parameters?:
  initial overrides}`. The current `modelAnimation` idle/run/airborne profile
  becomes a built-in controller ("Platformer basic") and its data migrates to
  it on open (keep reading the old component until 9.3 has removed old
  paths).
Runtime: one mixer per entity; the controller advances in the render loop
  from parameters committed by the simulation step (deterministic state in the
  runtime, presentation in three-adapter); the player's controller gets
  `speed`, `grounded`, `velocityY`, `landed` parameters automatically from the
  platformer. Scripts: `ctx.animator(entityId).set(name, value)`,
  `.trigger(name)`, `.state()`; clip events arrive as `ctx.events` in the next
  step. No root motion.
Editor: an **Animator window**: a node graph of states (drag to move, right
  click to add state/blend tree/transition), parameter list, transition and
  state inspectors, live preview in the asset preview canvas with parameter
  sliders; clip preview for skinned models (play/pause/scrub already exists —
  extend to skins).
Sprout clips (owner approved): in `~/projects/sprout/art/scripts/characters/`
  write scripted Blender actions for Sprout (idle, run, jump, fall, land —
  chibi proportions, 1 m tall, 2.5 m jump) and the boar (idle, walk, charge,
  hurt, defeat), export them into the character GLBs (or animation GLBs next
  to them), render review frames into `art/review/<asset>/`, commit. Keep the
  game-ready rules and report tris/LODs/textures/file size.
MCP: controller ops through `tl_command`; `tl_game_observe` reports the
  current animator states of observed entities.
Done when: unit tests for the controller state machine (transitions,
  conditions, exit time, blend weights, events); e2e imports a skinned test
  GLB (generated in the test like `multi-piece-glb.ts`, with 2 bones and 2
  clips), builds a controller in the Animator window, and sees the pose change
  in Play when a parameter changes; Sprout's player runs its clips in Play.

### 9.8 Input actions and the Input window

- `content.input`: action maps (`gameplay`, `ui`), actions (`button`,
  `axis1d`, `axis2d`), bindings (keyboard key codes, mouse buttons, gamepad
  standard-mapping buttons/axes, composites like WASD → 2D), processors
  (dead zone, invert, scale). Defaults reproduce today's keys and add
  `attack`, `interact`, `pause` (Esc / Start), `submit`, `cancel`, `navigate`.
- Runtime: `ActionFrame` carries every action's value/phase per fixed step
  (deterministic, recorded for replay); the platformer reads `move`/`jump`
  from it; scripts read `ctx.input.value('attack')`, `.pressed()`,
  `.released()`.
- Rebinding at runtime (9.10 settings screen) stored in the save (9.11).
- Editor: an **Input window** (action maps, actions, bindings; "listen" button
  to capture a key/button; gamepad connected indicator).
- MCP: `tl_input_exercise` accepts named actions.
- Done when: e2e rebinds jump to `KeyW` in the Input window and the player
  jumps with W in Play; a gamepad-free test covers composites via synthetic
  events.

### 9.9 Physics and gameplay building blocks

Physics (`physics-rapier`, `platformer`):
- Kinematic bodies (`kinematicPositionBased`) for movers; the character is
  carried by the platform it stands on (platform velocity added before
  `computeColliderMovement`).
- One-way platforms (a collider flag; the character passes from below and
  from the sides, lands from above; drop-through with down + jump).
- Sensors (trigger shapes, box/circle/polygon) reported as enter/stay/exit to
  scripts and built-ins.
- Several characters: the player plus up to 64 NPC characters (enemies), each
  a capsule with its own controller; they collide with the world, not with
  each other by default.
- Script queries: `ctx.physics.raycast(origin, dir, maxDist, mask)`,
  `overlapBox`, `overlapCircle` (bounded per step).
Components (data + runtime + inspector + gizmos):
- `mover`: waypoints (local offsets), speed, loop/ping-pong/once, wait per
  point, easing, start on signal or at load.
- `switch`: lever/button/pressure plate (interact action or stand-on), emits
  a signal; `door` = a mover that opens on a signal.
- `health`: max, start, invulnerability seconds, knockback; `damage` on
  hazard zones (amount; 0 = instant death as today).
- `pickup`: kind (coin, gem, heart, extra life, key, custom), value, sensor
  shape, respawn rule (never / on death), collect cue; collected ids per
  level are remembered (9.11).
- `enemy`: patrol (between two points or until a ledge/wall), chase (in
  range), speed, contact damage, stompable (bounce the player), health,
  defeat effect (squash + fade), uses the Animator parameters `speed`,
  `attacking`, `hurt`, `defeated`.
- Signals: `ctx.signals.emit(name)`, `ctx.signals.on(name)`; switches, doors,
  movers and scripts share them.
Script API growth (with limits and tests): rotation/scale intents,
  set active/visible, spawn a prefab at a position, destroy spawned entities,
  timers, play audio (9.10), read run state (health, lives, score, counters),
  signals, raycasts.
Done when: unit tests per component in runtime; e2e builds a small level
  (mover, one-way platform, switch + door, pickups, an enemy) via the editor
  and plays it through Play with `tl_input_exercise`/keyboard: the player rides
  the mover, stomps the enemy, collects coins (HUD counter), opens the door.

### 9.10 Game flow, menus, HUD and audio

- Game flow in `content.game`: an ordered `levels` list (each a start scene
  set + name), a title scene (background), lives (start, max), score rules,
  "level complete" on goal → next level; game over at 0 lives → retry level /
  title; credits optional.
- Runtime UI (game-host, DOM overlay, keyboard/gamepad navigable through the
  `ui` action map): title screen (continue / new game / settings / quit to
  title), pause menu (resume, restart level, settings, quit to title), level
  complete (counts, time, best), game over, settings (music/sfx volume,
  quality level, key rebinding list from 9.8). A project `ui` block sets
  font, colours and an optional logo texture.
- HUD: hearts/health, lives, coin/score counters, level name, optional timer;
  layout chosen from a few presets.
- Audio: music assets (OGG Vorbis/Opus and MP3 besides WAV; container checks
  for export), per-level music with crossfade, looping ambience, buses
  (master/music/sfx/ui) with volumes from settings, `audioSource` component
  (2D positional falloff along X), `ctx.audio.play(assetId, opts)`.
- Editor: a Game window (levels list, lives/score rules, menu texts, UI
  theme, music per level) instead of scattering these over tabs.
- Done when: e2e plays two short levels in a row through the title screen,
  loses all lives on purpose (game over screen), pauses and changes the music
  volume (audio node gain observed), and the export does the same served
  statically.

### 9.11 Save system

- Exported games and Play save to `localStorage` under a key per project +
  build lineage (Play uses a separate namespace; the Game window has "clear
  Play save"). Three slots + an autosave; JSON, versioned, ≤ 64 KB per slot,
  checksummed; a corrupt slot is reported and ignored.
- Saved: current level, checkpoint, lives/health, counters and collected
  pickup ids per level, best time/score per level, settings (volumes,
  bindings, quality).
- Autosave on checkpoint, level complete and settings change; load from the
  title screen; `ctx.save.get/set(key, value)` for scripts (namespaced,
  bounded).
- Done when: e2e collects a coin, reaches a checkpoint, reloads the exported
  page and continues at the checkpoint with the coin still collected.

### 9.12 Placeholders, icons and gizmos

- New transparent icons with Qwen-Image for: point light, spot light,
  hemisphere light, audio source, pickup, enemy, mover, switch, door, sensor,
  fog volume, sky/environment (generate at 512², clean the alpha fringe with
  `tools/png-alpha-clean.py`, store in `packages/editor/public/icons`).
- Gizmos: light range spheres and spot cones, fog volume boxes, mover paths
  with waypoint handles (draggable, one command per drag), enemy patrol
  ranges, sensor shapes, and **2D collider outlines** for every collider
  (makes the kit `_COL` polygons visible), toggled from a Gizmos menu.
- Done when: e2e checks the icons load and a collider outline is drawn.

### 9.13 Sprout demo: two playable meadow levels

- In `~/projects/sprout`: import the kit, foliage, characters (with clips)
  and skies; assign materials (kit, foliage with wind); build "Meadow 1" and
  "Meadow 2" with the kit (1 m grid, side view), foliage scatter via instance
  sets, coins, hearts, a checkpoint, moving platforms, one-way ledges, a
  switch + door, 2–4 boars, an exit to the next level; environment (sky,
  fog, post), a final Blender bake; title screen and music (generate or
  leave silent if no music asset exists — never invent audio files without a
  script that makes them).
- Play both levels start to finish through headless Play (9.2) and in an
  export served statically; record the playthrough facts (time, deaths) in
  §6. Commit in Sprout. Owner look pending.

### 9.14 Wrap-up

- `docs/STATUS.md`: one row per finished item (short), phase 9 marked done
  with "owner look pending" where visual; add row 13 (material node graph,
  planned).
- `docs/deployment.md`: bake host and headless browser settings.
- Update the auto-memory phase-state file.

## 5. Progress (tick as you go)

| Item | State | Commit(s) |
|---|---|---|
| 9.0 import fixes | done 2026-09-24 | 1c9edcd, idle thumbnails fix |
| 9.1 multi-select leftovers | done 2026-09-24 | pasteEntities (see git log) |
| 9.2 headless Play (phase 11) | done 2026-09-24 | see git log "Phase 11" |
| 9.3 one schema version (phase 8 rest) | done 2026-09-24: runtime part; corpus in v4 (step A); v1/v2 model code removed from project-model/commands/workspace, only v4 loads, v3 upgrades on open (step B; v4 gaps found in §6) | see git log "9.3" |
| 9.4 textures, materials, wind | done 2026-09-24 (Sprout assignment moves to 9.13) | 6d85730, 5e0e231, see git log "9.4c" |
| 9.5 lights, environment, sky, fog, post | done 2026-09-24 (owner look pending) | d0c1dee (9.5a), see git log "9.5b"; Sprout 17f8758 (skies, not pushed) |
| 9.6 light baking | done 2026-09-24 (owner look pending) | see git log "9.6"; Sprout kit bake on the 5090: 9 pieces, 512 samples, OptiX, 4.4 s round trip |
| 9.7 rigs + Animator + Sprout clips | done 2026-09-24 (owner look pending; gaps in §6) | see git log "9.7"; Sprout 33e92d9 (clips, not pushed) |
| 9.8 input actions + Input window | done 2026-09-24 (owner look pending) | see git log "9.7/9.8" |
| 9.9 physics + gameplay building blocks | done 2026-09-24 (owner look pending; gaps in §6) | see git log "9.9" |
| 9.10 game flow, menus, HUD, audio | done 2026-09-24 (owner look pending; gaps in §6) | see git log "9.10" |
| 9.11 save system | done 2026-09-24 | see git log "9.11" |
| 9.12 placeholders, icons, gizmos | done 2026-09-24 (owner look pending) | see git log "9.12" |
| 9.13 Sprout demo levels | done 2026-09-24 (owner look pending) | see git log "9.13"; Sprout 10e0b5a + level-script static pieces (not pushed) |
| 9.14 wrap-up | done 2026-09-24 | STATUS rows, row 13; deployment.md already had the bake host and headless browser settings |

## 6. Decision log

Add one dated line per decision taken during the run (what, why).

- 2026-09-24: pieces are derived from node names at load time (three-adapter
  `pieces.ts`), not stored in the asset record — no reimport needed and editor,
  Play and export agree by construction.
- 2026-09-24: a whole-file drop of a multi-piece model is one `createEntity`
  of a folder with `children` (≤ 256), so one undo removes it.
- 2026-09-24: a skinned whole-file drop gets no static collider from its
  `_COL` (a character is not a wall); pieces and static props do.
- 2026-09-24 (9.1): one op `pasteEntities {entities, parentId?, offset?}`
  serves Duplicate (keeps parents, +0.5 m X, roots named "<name> copy") and
  Copy/Paste (active scene, into the selected folder, same positions). The
  clipboard holds full entity values read with `queryEntity`, so it works
  across scenes. Deleting a folder that holds a checkpoint and its own safe
  spawn is no longer refused (the reference goes away with it).
- 2026-09-24 (9.2): the headless editor is the normal editor page opened by
  the backend (`playwright-core`, pinned 1.62.1, external to the bundle) on the
  public authoring origin with `?headless=1`; its session is labelled
  `headless` and evicted when the owner's browser establishes. On by default
  from the process entry (env), off for embedded/test backends unless
  configured.
- 2026-09-24 (9.3): deferred to after 9.13 under the time-box rule: it touches
  ~20 source files, ~25 test files and the whole v1 contract corpus, and
  changes nothing the owner can see; the feature items go first. New work
  targets v4 only and leaves the old paths alone.
- 2026-09-24 (9.4): materials and the environment travel to Play/export in
  the manifest only (bound by the buildId, read by both bootstraps); the
  simulation never needs them, so the runtime snapshot is unchanged. The
  kit shader shifts UV0 by the object's (or instance's) origin X, not per
  vertex — the Sprout manifest says "per piece/instance". Selection highlight
  and the checkpoint glow no longer write into shared materials (the
  highlight skipped model meshes before too: it used to tint every placement
  of an asset and wipe its emissive). Assigning Sprout's kit/foliage
  materials is done with the demo levels (9.13), where the kit and its macro
  normal texture get imported anyway.
- 2026-09-24 (9.5): the fog-volume "height gradient" and a per-scene
  environment override are not built; the override moves to 9.10 with levels.
  Grading is brightness/contrast/saturation/tint plus a LUT strip and vignette
  in one custom pass (no lift/gamma/gain, no separate LUTPass). Point/spot
  limits are 16 per scene (schema), not a Problems warning at 8 realtime / 2
  shadow casters. Qwen puts the horizon low in its panoramas, so the Sprout
  sky script records each horizon and remaps it to the middle row; the lower
  half is a flat ground colour. The skies are committed in Sprout but not
  pushed (pushing Sprout was not permitted); they get imported with 9.13.
- 2026-09-24 (9.6): bakes live in `content.lighting[sceneId]` (the plan
  allowed it; no scene-file field), with `bakedLights` (the lights a bake
  holds). A baked light stays realtime until a bake holds it (then it is
  not realtime); baked ambient/hemisphere lights stay realtime for dynamic
  objects and lightmapped surfaces ignore them. Meshes without UV1 are not
  auto-unwrapped (the runtime could not map them): they only cast shadows
  and the bake message counts them; boxes get a generated UV1. Each object's
  UV1 bounding box (not the unit square) maps onto its rectangle, so kit
  pieces sharing one UV1 atlas keep their resolution. Both bakers start in
  the editor: the browser builds the Blender package from the meshes it has
  loaded, the backend only ships it (ssh/scp) and returns PNGs, and the
  editor publishes the atlases like the preview (so N+1 undo steps, not
  one). The Cycles script lives in the backend bundle
  (`cycles-bake-script.ts`), not `tools/bake/`. Bounce light uses a neutral
  80 % grey, not the objects' colours; point/spot `range` cut-offs are not
  modelled in Cycles. Lightmaps are 8-bit sRGB PNG scaled by `range`
  (default 4), with anisotropic filtering (grazing side-view cameras).
  A stale bake is shown in the Lighting window (not as a Problems entry).
  Found on the way: the editor dropped tags/materials/environment after a
  reload (`queryGameConfig` returned only the game block) — fixed.
- 2026-09-24 (9.7): the animator runs in the runtime's fixed step (pure
  state machine, `runtime/src/animator.ts`) and the renderer only poses
  (action time + weight per clip, no mixer time), so Play and replays match
  and clip events reach scripts (`ctx.events`). Poses are read with a
  separate `runtime.animatorPoses()` (the frozen GameView shape is untouched).
  Clip durations live in the controller (the editor fills them from the
  file) because the runtime never loads GLBs. Not built (left for the
  wrap-up if time allows): the second override layer with a bone mask,
  animation-only GLBs (clips for another rig), the migration of the old
  `modelAnimation` idle/run/airborne profile into a built-in controller
  (the old component keeps working). (Added in the wrap-up: the import caps
  for skins — joints ≤ 128, ≤ 4 skins, ≤ 32 morph targets — and a live
  preview in the Animator window: the controller on its model in its own
  small canvas, parameters as sliders/checkboxes/trigger buttons, not
  saved; e2e `animator`.) Only clips of the entity's own model
  play (a controller naming another asset's clip is skipped at runtime).
  A skinned character exported as one rig node (Sprout) is one piece named
  after that node; place it as a whole file. Characters do not turn to face
  their movement yet (9.9/9.13). The Sprout clips were authored by a
  helper agent in Sprout (IK legs; feet match the ground at ~1 m/s run).
- 2026-09-24 (9.8): named actions ride in the `ActionFrame` as an optional
  `actions` map (values + phases per step, so replays match); `moveX`/`jump`
  stay for the platformer and come from the `move`/`jump` keyboard bindings
  (the platformer's gamepad controls stay the M2 standard ones — rebinding a
  pad button changes `ctx.input`, not the platformer). The editor and the
  Play preview may not import project-model values, so the input package
  keeps a copy of the defaults (a parity test pins it) and `queryGameConfig`
  returns `inputDefaults`. Runtime rebinding for players (a settings screen)
  and storing it in saves move to 9.10/9.11.
- 2026-09-24 (9.9): the blocks live in the runtime (`runtime/src/blocks.ts`,
  one `GameplayBlocks` per run) and run inside the fixed step: movers
  advance before the controller, the player's move gets the platform's
  motion (carry) or a push out of a mover that moves into it, Rapier
  kinematic bodies take the new poses after the character sweep; overlaps
  (triggers, switches, pickups, enemies, damage) are box tests after
  physics. While grounded, the physics port now reports the surface right
  under the feet as the support normal (a lift's upward sweep otherwise
  only touched corners, which read as slopes). Enemies are kinematic boxes
  that patrol with raycasts, not capsule characters. Added in the wrap-up:
  enemy `chase` (toward a player in range, within its patrol limits, sets
  the Animator's `attacking`), a squash-then-vanish defeat, `health.start`
  and `knockback`, a pickup `cue` (an audio asset, played through the sfx
  bus) and a trigger `exitSignal`. Still not built: sensor stay events and
  shapes other than boxes, `overlapBox/Circle` for scripts, and the extra
  script intents (rotation/scale, set active, spawn/destroy, timers). Known limit: a player spawn inside a
  one-way platform counts as blocked. Blocks need v4 projects.
- 2026-09-24 (9.10): the game flow is a new optional content block
  `content.flow` (not a `content.game` field: game fields are all required
  and versioned). Levels switch inside one runtime (`runtime.startLevel`:
  the level's scenes become the loaded and start set, then a fresh run at
  its spawn), so a replay restarts the current level; every level must load
  the player's and the camera's scene. Lives, menus and music live in the
  game host (the simulation stays unaware of them); pause stops the steps
  while frames keep rendering. Menus are DOM built with textContent only;
  their styles use a constructed stylesheet because the Play page's CSP
  refuses inline <style>. Music is its own asset kind (the ≤ 2 s mono WAV
  cue rules stay). Player settings are in memory until 9.11 saves them.
  Audio sources are 2D loops whose gain follows the player's X distance
  (no stereo panning); `ctx.audio.play` plays audio (cue) assets through
  the sfx bus after the step. Not built: score rules (counters are the
  score), a separate ambience list per level (use audio sources), a
  UI-sounds bus, gamepad rebinding in the settings screen (keys only), and
  a title background scene other than level 1's start (the title shows the
  game as it stands).
- 2026-09-24 (9.11): saves live in the game host (a storage port; the
  wrappers pass localStorage, namespaced `thirdlight-play:<projectId>` in
  Play and `thirdlight:<projectId>` in an export — not per build, so a
  rebuilt game keeps its saves). A load is a level start with a restore:
  the fresh run starts at the saved checkpoint's safe spawn, then the
  collected pickups, defeated enemies, counters, health and script values
  are put back. The checksum is FNV-1a (it detects damage, it is not a
  signature). Per-level memory (collected, best time) is saved but not
  applied when a level is replayed from the start.
- 2026-09-24 (9.12): icons were generated at 256² (the size of the
  existing set, not 512²) with one shared flat-icon prompt
  (tools/icons/generate-phase9-icons.sh, seed 42; the sky icon seed 7
  without a sky background). Light ranges, spot cones, fog boxes, enemy
  ranges and trigger/switch areas already existed; 9.12 added collider
  outlines, waypoint handles and the Gizmos menu. Sensor shapes other than
  boxes do not exist yet, so none are drawn.
- 2026-09-24 (9.13): the levels are built by a script in Sprout
  (`art/scripts/levels/meadow_levels_build.mjs`) through the HTTP command
  API — the same commands as the editor and MCP; a rerun clears and rebuilds
  them. Playthrough facts (headless: real game host, Rapier and the saved
  scenes, driven by a raycasting bot in
  `tests/integration/sprout-meadows`): Meadow 1 15.1 s, 0 deaths; Meadow 2
  22.0 s, 2 deaths (boars); title → both levels → end screen. The export
  served statically starts at the title and plays Meadow 1 (screenshots);
  headless Play on this server renders on the CPU (~4.5 fps), so it only
  checks that Meadow 1 runs. Found and fixed on the way: a texture sky was
  upside down (WebGL ignores flipY for an ImageBitmap; the sky now goes
  through a canvas), a gate rising beside the player was a physics port
  error (the kinematic move is now allowed slack), scene commands and a
  historical checkpoint's spawn broke reloading from retry records.
  Known limits: a player pushing into a rising gate gets lifted and wedged
  (the gates open fast and sit apart from the switch); the player capsule
  is the engine's 1.8 m while Sprout is ~1 m tall; boars are kinematic
  boxes without a defeat animation. Final Blender bakes of both levels on
  the 5090 (from the Lighting window, `sprout-live.e2e.ts` with
  TL_SPROUT_BAKE): Meadow 1 105 static kit pieces in 53 s, Meadow 2 104 in
  65 s, one lightmap each; the level script marks every non-moving kit piece
  static. Also fixed: an edit that changes nothing in a v4 project was not
  refused as `no_change` (the canonical serializer had no v4 branch).
- 2026-09-24 (9.3, returned to after 9.13): time-boxed. Done: the runtime
  plays only v3/v4 snapshot scenes (v1/v2 are `snapshot_invalid`), its
  types are v3/v4 only, and every runtime/adapter/platformer test scene is
  v4. Left, because it hangs on rewriting the v1 `fixtures/commands`
  generator (~1,300 lines, 85 files) in v4: the v1/v2 arms in commands
  (`gateResultState`), the v1/v2 envelopes and migrations in workspace, new
  projects still built from an M1 default scene then upgraded, and the
  v1/v2 scene validators in project-model (v3/v4 reuse many of their
  component validators, so they move rather than go). Nothing of this is
  reachable from the product; a plain grep for `schemaVersion: 2` can never
  reach zero because the v4 manifest is `schemaVersion: 2`.
- 2026-09-24 (9.3 step A): the `fixtures/commands` corpus is storage v4
  (116 files; the v1 corpus and the v1 envelope test are archived under
  `archive/removed-v1-v2/`). The generator's own model reproduces a real
  service-created project byte for byte; all nine scenarios are replayed
  through the real service (06/07 for the first time). Replaying them on v4
  found four workspace bugs, fixed with it: the reclaim of a dead owner
  (§6.4) loaded only v1–v3 envelopes, so a v4 project stayed
  `stale_ownership` after its backend crashed; leftover temps of v4 files
  were neither cleaned at open nor counted by the scan; the v4 discard
  overwrote a second, never-snapshotted foreign write; and a v4 load
  reported raw model codes (`field_type`, `quaternion_invalid`) as the
  `project_unavailable` reason instead of `scene_invalid` /
  `content_invalid` / `manifest_invalid`. Pinned as-is: a replayed v4 ack
  has no `sceneId` (records keep the §5.1 payload). The two v1-only tests
  left (op gate, M1 captureContentView) seed a v1 project from the
  package's own builders until step B removes the v1/v2 code.
- 2026-09-24 (9.3 step B): the v1/v2 (M1/M2) scene and storage code is gone
  from project-model (M1 scene validators, the v2 scene validator —
  `scene-v2.ts` is now `components.ts` with the component rules v3/v4 reuse —,
  `validateProjectV2` (its cross-block checks moved into `project-v3.ts`),
  `migrate.ts`, `migrateSceneV3`, the v2 content validator and capture
  branch), commands (only v3/v4 scenes; `gateResultScene` and the v1/v2
  gate arms removed) and workspace (v1/v2 envelopes, the migration copy
  operators, `captureContentView`, the `storageV4` flag and the whole legacy
  single-envelope session path). The v3 envelope is only read, for the
  upgrade on open. New projects (plain, template, folder) are written as v4
  directly, byte-identical to the old create-then-upgrade result (no
  `migrated-v3` copy); the scan completes an interrupted v4 creation. A v1/v2
  project on disk is refused with `project_unavailable { reason:
  "storage_version_unsupported" }` and a hint, files untouched (it still
  gets an ownership claim, like any blocked project). Removed code and the
  tests that only covered it are under `archive/removed-v1-v2/`; the rest of
  the tests were ported to v4. Porting the legacy regression tests to v4
  found v4 gaps, left as they are (v4 behaviour kept exactly): an
  `unreadable`/`snapshot_failed` pause is never re-read, so accept/discard
  stay refused until a restart (and report `external_change_evidence_missing`
  for an unreadable file); a `new-undurable` discard reports success; a
  `new-undurable` records-clearing write still releases; a foreign owner seen
  while releasing is reported `write_failed` instead of `ownership_conflict`;
  `store-v4.ts` `checkFileKeys` does not escape JSON-pointer segments; a
  replayed v4 ack has no `sceneId`; `instantiatePrefab` keeps the 1024-entity
  cap in v4 scenes (create/paste allow 16384).
