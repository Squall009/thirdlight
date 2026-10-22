# Phase 39 — See-through around subjects

Status: planned 2026-10-21.

Goal: anything between the camera and a subject (a player, a unit) dithers
away in a soft circle around that subject. The rest of the scene stays drawn,
so rooms, doorways and paths stay readable. This is the "occluder fade" or
x-ray of isometric and third-person games. It is a camera-level rendering
feature that works on every kind of object: block layers, architecture,
models, scatter, terrain. It is not a block cut-away mode. Read
`docs/roadmap.md` (principles 1 and 1b) first.

Source: Temporal G7 (`~/projects/temporal/docs/engine-gaps.md`, 2026-10-21).
Temporal wants a fade centred on its player for interiors seen from the follow
camera, because whole-zone cut-aways hide doorways. Temporal asked for a block
cut-away mode. The engine builds the general feature instead, and the request
is answered by it.

## 1. Owner decisions (2026-10-21)

- **Dither, never fully invisible.** The circle thins what is in front to a
  dither with a maximum fade below 1 (default 0.75, set per project). Doors,
  walls and props in front stay visible as a see-through pattern instead of
  vanishing.
- **A list of subjects.** The default subject is the active camera's target,
  but any number of objects can be subjects at once, up to the GPU-side array
  size (§2).
- **Only above the subject.** A pixel fades only if it is closer to the camera
  than the subject AND higher than half the subject's height above its feet.
  Floors, ground and anything low around a subject never fade.
- **Multi-floor levels work.** A character on the stairs fades the floor above
  them, but never the floor they stand on or the floors below. Both are
  acceptance cases.
- **Everything takes part by default.** Every drawn object can fade, so a tree
  or prop nobody marked doesn't block the view. Objects opt out with
  `seeThrough: false`. A subject never fades itself or its children.

## 2. Design

- **One dither-fade node.** The block cut-away already fades meshes with a
  per-pixel dither ANDed into the material's `maskNode`
  (`three-adapter/src/block-cutaway-view.ts`, `keepNode` / `makeFadeVariant`).
  It works for every node material kind (standard, trim, layered surface,
  graph, terrain, skinned, instanced, decals) and adds no program per value.
  That code moves into one shared module. The cut-away and see-through both
  use it, and later fades (LOD crossfade, distance fade) can too.
- **The see-through mask**, evaluated in the fragment stage of every material
  that takes part:
  - for each subject: its screen position, its view depth and its feet height
    (world up), all per-frame uniforms set once per view
    (`uniform().onRenderUpdate`, like `effect-lights.ts`);
  - a pixel's fade is the largest over the subjects of: the soft circle (a
    radius and softness as a fraction of the view height, scaled with distance
    so the circle covers the subject's body at any zoom) × [pixel view depth <
    subject view depth − margin] × [pixel world height > feet + half the subject's height];
  - fade = min(that, max fade); the fade eases in and out over time per
    subject (the cut-away's `CUTAWAY_FADE_SECONDS` style; one constant).
- **Array size.** Subjects are a fixed-size uniform array: a GPU constraint,
  not a content cap. It is defined once (default 4 per view). Asking for more
  keeps the nearest to the camera and logs one Problems line.
- **The height rule is one rule everywhere** (owner, 2026-10-21). Nothing
  below half the subject's height above its feet ever fades. For a character
  that is half its controller's height; for other subjects, half their
  bounds. Things on or near the floor stay solid on every storey, in a side
  view and in 3D. The rule doesn't depend on the scene, a plane or the project
  kind.
- **Opt-out:** a `seeThrough` render flag on models, boxes, block layers (per
  layer), architecture, terrain and scatter rules, default true. It is a
  per-object uniform like `lightLayers`, so no program variants per object.
  Batching and merged statics keep objects with `seeThrough: false` apart from
  the rest, as they do for light layers.
- **Shadows** are unaffected: a faded wall still casts its shadow.
- **Control:**
  - project settings (Rendering → See-through): on/off, radius, softness, max
    fade, depth margin, fade time;
  - script: `ctx.camera.setSeeThrough({enabled?, subjects?, radius?, …})` to
    change it at runtime (indoors, cutscenes); `subjects: null` goes back to
    the camera's target;
  - a timeline key isn't planned (a script call covers cutscenes).
- **Cut-aways stay** for hiding whole zones (roofs, upper storeys). The two
  combine.

## 3. Items

**E2E budget (D253):** no new e2e file and no net added e2e time. Shader and
mask maths get vitest checks (TSL node built and evaluated on the CPU reference
where possible). The editor surface is one step in an existing e2e file.

| Item | What |
|---|---|
| 39.0 | **Release checks** (three.js, Rapier), as every phase. |
| 39.1 | **One dither-fade module.** Move the cut-away's dither, variant cache and precompile into one shared module, and switch the cut-away to it. No visual change: the cut-away's existing e2e and screenshots must match. |
| 39.2 | **The see-through mask** (§2) in every material kind, with per-view subject uniforms, the per-object opt-out, subjects excluded from their own fade, and batching keys. Every material that takes part gets the mask through the shared module at creation (precompiled), not a copy mesh: no extra draws. |
| 39.3 | **Settings and API:** project settings, `ctx.camera.setSeeThrough`, the `seeThrough` flag in the Inspector for each object kind, typings, graph node, MCP docs. Additive on schema 7. |
| 39.4 | **Correctness cases** (vitest on the mask maths + a browser check): a wall between camera and subject fades inside the circle only; a wall behind the subject never fades; the floor around the subject never fades; **multi-floor**: a character on the stairs between storeys fades the storey slab above them, not the one under them, and walking up flips which slab fades; two subjects in one view; a subject that is itself in front of another subject; a side-view foreground prop near the floor stays solid. |
| 39.5 | **Editor:** a See-through preview toggle in the Scene view (with the selected object, or the camera target, as the subject), so level builders see the effect while editing. One step in an existing editor e2e. |
| 39.6 | **Performance:** measure on the village and an interior class (a multi-storey building) on both renderers at 1080p on the Iris Xe. Target: ≤ 0.3 ms GPU frame time added with 4 subjects, no added draws, no added programs after warm-up. |
| 39.7 | **The manual:** a see-through section in the camera and rendering pages, the cut-away page's "combine with see-through" note, and a how-to for interiors (follow camera + see-through + roof cut-away). |
| 39.8 | **Acceptance.** In a real browser on both renderers at 1920×1080: the Temporal-style interior (a follow camera over a two-storey building, a player walking through rooms and up the stairs) and an open scene with trees between camera and player. Screenshots to `~/.cache/thirdlight-phase39/acceptance`; owner look pending. Full gate, then the phase review. |
| 39.9 | **Review fixes.** |

**Done when:**
- Walls, props and trees between the camera and any subject dither (never
  vanish) in a soft circle around it.
- Floors at and below the subject's feet never fade, including on stairs
  between storeys.
- Every object takes part unless it opts out.
- It costs ≤ 0.3 ms GPU and no extra draws.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| 39.0 | Done 2026-10-22: three.js 0.186.1 is still the latest on npm (no update; `@types/three` 0.186.0 likewise). Rapier 0.21.0 (2026-09-25) is out; the pinned 0.20.0 stays (a minor release, nothing in phase 39 needs it; phase 41's one-backend move is where to plan it). |
| 39.1 | Done 2026-10-22: `three-adapter/src/dither-fade.ts` holds the dither (one shared threshold, `ditherKeep(fade)`, `objectFade(key)`), `andMask` (ANDs a keep term into a material's `maskNode` at creation, keeping its own: what 39.2 uses, no copies, no per-value programs), node-material copies of classic materials, the `FadeVariants` cache (one per source, remade on a version change, disposed with the last holder) and `fadeCopy` (the fade copy and the precompile probe); the cut-away uses it (502 → 410 lines). Vitest `dither-fade.test.ts`: the cut-away variants' WGSL on 16 material kinds equals digests recorded before the move; two fades share one threshold in one discard (`t ≥ a && t ≥ b`); fade values share one program. e2e unchanged and green: `block-layers` 15.6 → 15.7 s (the dithered roof's pixel counts while fading 40 20 10 4 before, 43 21 10 5 0 after), `block-editor` 9.0 → 9.1 s. Fast gate: build, lint, vitest 746 files, e2e 32/32; village perf missed twice on WebGPU (7.2 / 7.5 ms > 6.16), A/B against `25994ae3` equal (WebGPU B 7.2 / 6.5 / 7.3, A 7.2 / 7.6 / 7.6 ms; WebGL 2 4.5–4.8 both): host state (D290). `tools/gate.sh` takes `TL_VITEST_WORKERS` (the fast gate OOMed in vitest under 5G and 6G caps; 4 workers peak 4.3 GB). |
| 39.2 | Done 2026-10-22: `three-adapter/src/see-through.ts`: a view arms its renderer through `renderer.contextNode` (part of every draw's program key) and one `NodeMaterial.setupDiffuseColor` step ANDs the mask (shared dither) into every node material at build: standard, trim, layered surface, graph, terrain, skinned, instanced, decals and classic materials alike; no copies, no draws, no program per object or value; unarmed renderers build byte-identical WGSL (recorded digests); shadow pass, colourless and no-depth-test draws never take it. Per view: `SEE_THROUGH_SUBJECTS` (4) slots of render-group uniforms (centre, radii, depth limit, half-height plane, eased fade; other cameras see none), nearest kept + one `see_through_subjects` Problem; per draw: subject bits (`seeThrough: false` → none, a subject and its children drop their own). Flag on box/model/instances/block layer/terrain/architecture/scatter rules; batch and merge keys split on it. Settings/defaults in project-model `see-through.ts`; hook for 39.3: adapter option `seeThrough`, `adapter.seeThrough().set({…, subjects})`, `diagnostics.seeThrough`, page flag `?seethrough=on`. Vitest `see-through.test.ts` (20: CPU reference incl. stairs/ortho/two subjects, view slots/easing/exclusion, WGSL). Looked at in the block-layers export with `?seethrough=on` on both renderers: the post in front of the player dithers above half its height, its shadow stays. No e2e touched (`block-layers` 16.0 s, `block-editor` 9.3 s in the gate). Fast gate green: vitest 747 files, e2e 32/32, village WebGPU p50 5.7 ms (base 5.6), WebGL 2 4.6 ms (4.4), both under limit. |
| 39.3 | Done 2026-10-22: six Rendering settings (`see_through` 0/1 off by default, radius, softness, max fade, depth margin, fade time; project-model `SEE_THROUGH_SETTING_KEYS`, `seeThroughSettingsOfProject`) reach Play and the export through the game page; `ctx.camera.setSeeThrough({enabled?, subjects?, …})` (runtime `see-through-control.ts`) rides with the resolved view (`CameraViewInfo.seeThrough`, step digest) to the adapter, which layers host settings < script < `?seethrough` pin; `seeThrough` on box, model, instances, block layer, terrain, architecture (interiors inherit it) and scatter rules (schema, canonical forms, Inspector descriptors, scatter rule card toggle), graph node "Set see-through", MCP settings text, reference regenerated. Vitest: real backend over HTTP/WS (`see-through-settings.test.ts`: settings and flags set, refused, reopened, carried into Play), page vs worker runtime (`m23-camera/see-through.test.ts`: digests and views equal step for step), adapter layering. e2e: one step in `project-settings` 4.2 → 3.8 s; `block-layers` 15.8 s. Fast gate green: vitest 749 files, e2e 32/32, village WebGPU p50 5.7 ms (base 5.6), WebGL 2 4.7 ms (4.4). |
| 39.4 | Done 2026-10-22: vitest `see-through.test.ts` 20 → 25 (walking up flips the faded slab to the next storey's; a view's own packs and per-draw bits through the CPU reference for two subjects and a subject in front of another; a subject in a batch or merged cell leaves it while it is one, a mesh loaded under it later follows, it rejoins after; both fail without the fix). Fix: subjects draw out of batches and merged cells (`SUBJECT_DRAW_KEY`, refusal `see-through subject`, `SeeThroughView.beforeBatch`). Browser: a capped ad-hoc export run on both renderers at 1920×1080, six stages looked at (wall in front dithers inside the circle down to the half-height line, wall behind/floor/low crate solid; stairs: the slab above fades, then the next one up; two subjects; a subject fading for one behind it; a side view's low crate solid, pillar cut at half height); a hero batchable with five identical boxes stays solid. Best shots in `acceptance/39.4-*`. Stacked faded layers share the dither, so what is faded behind a faded layer is hidden by its kept pixels (by design: never more than the max fade). No e2e touched (`block-layers` 15.3 s, `batch-dispose` 10.2 s). Fast gate: vitest 749 files, e2e 32/32; village WebGL 2 p50 4.9 ms > 4.84 once, rerun green (4.7 ms; WebGPU 5.7 ms). |
| 39.5 | Done 2026-10-22: the toolbar's **see-through** switch (beside light, so it stays in reach in the full-screen edit modes) previews see-through in the Scene view with the project's settings round the selection, else the live camera's target (editor `viewport/see-through-preview.ts`; view only, nothing stored; the canvas's `data-see-through` stamps the adapter's diagnostics). Vitest `see-through-preview.test.ts` (subject choice). e2e: one step in `scene-view-parity` (a screen between camera and cube, part of the parity scene: preview on dithers 10.9 % of the view's middle; the selection takes over; off/on inside the decal editor; project revision unchanged) 5.6 → 8.2 s (auto; standalone the step adds ~2 s per variant). Looked at on WebGPU: `acceptance/39.5-scene-view-preview-webgpu.png`. Fast gate green: vitest 750 files, e2e 32/32, village WebGPU p50 5.6 ms (base 5.6), WebGL 2 4.7 ms (4.4). |
| 39.6 | Done 2026-10-22 (interior GPU target missed: D297): `tools/perf/see-through-run.ts` (`--see-through 4` on `village` and `level`: a script names the 4 objects nearest the line of sight, `?seethrough=on` runs it on, a Space press switches it on mid-run) and `--storeys 2` for the interior class (rooms stacked, open doorways upstairs, 3 stairs, 800 props, seen from above like a follow camera). Iris Xe, 1920×1080, 60 Hz cap, 4 subjects, GPU from timestamps (WebGPU; WebGL 2 has none: GPU-process ms a frame): village +0.0 ms (unarmed 9.2–9.7, on 8.7–9.5; WebGL 2 GPU process 5.0–5.5 both); interior **+1.2 ms** (11.17 → 12.38, three rounds; WebGL 2 GPU process 3.8 → 3.7). Draws +0 both (the village's subjects are skinned figures; the interior's props drew the same count), programs +0, p95 16.7–16.8 ms and 0 missed on every run, off or on, as the unarmed pages. Switch on mid-run: was a 483 ms frozen picture (13 programs rebuilt); now 0 missed, longest 16.8 ms, 0 programs, first fade 40–60 ms after the key. Fixes: games build their programs with the mask from the first frame (`prebuild`, skipped per draw while nothing fades: +0.1 ms idle on the interior, 0 on the village); one packed uniform array (three cost WebGL 2's GPU process +1.3 ms a frame with see-through merely armed); the slots unrolled with constant indices (a dynamic index cost 3.2 ms); each slot's circle only for pixels in front and above, and per draw only the subjects its bounds reach (`mayFade`); interior 3.85 → 1.2 ms. The perf probe counted a frame's GPU timestamps twice when three skipped a resolve (all passes ×2): fixed. Vitest: `see-through.test.ts` 25 → 28 (prebuilt arming, `mayFade` never rules out a fading point, narrowed bits), `tests/perf/level.test.ts` +1 (two storeys expand cleanly). No e2e touched (`block-layers` 15.7 s, `scene-view-parity` auto 9.2 s, `project-settings` 3.7 s). Fast gate green: vitest 750 files, e2e 33/33, village WebGPU p50 5.7 ms (base 5.6), WebGL 2 4.6 ms (4.4). Follow-up: the project setting decides the prebuild (on: built at load, a script switch rebuilds nothing, 0 missed; off: nothing built, a script turning it on rebuilds through the precompile gate, longest frame 383–800 ms, 1–2 missed, and one `see_through_rebuild` Problem); a screen box round the circles is tested first. Interior WebGPU: setting off → on +0.98 ms (11.17 → 12.15), of which setting on idle +0.27, the mask in the circles ~0.4, the revealed rooms ~0.3 (D297 stays open); village no measurable cost (noise ±1 ms); WebGL 2 GPU process ±0.2 ms; draws +0, programs +0, p95 ≤ 16.8, 0 missed with the setting on. Vitest `see-through.test.ts` 30 (box holds every fading pixel, the rebuild Problem). |
| 39.7 | Done 2026-10-22: `features/rendering.md` § See-through (what fades and the half-height rule, dither never gone and the shared pattern, subjects and `SEE_THROUGH_SUBJECTS`, opt-out per object kind, the six settings, `ctx.camera.setSeeThrough`, the setting decides the prebuild and `see_through_rebuild`, the editor preview, `?seethrough`, costs incl. D297); `scenes-and-cameras.md` lines consolidated into a pointer; cut-aways' "combine with see-through" in `blocks.md` and the block-layers guide; new guide `guides/interiors.md` (follow camera + roof cut-away + see-through, an indoors-only script, API path), linked from the index, which-tool and the cameras guide; `SEE_THROUGH_SUBJECTS` row in the performance constants table. The guide's script is unrun (docs only). Docs tests 20/20, build green. |
| 39.8 | Browser acceptance done, owner look pending; full gate + review by lead. Two throwaway projects from the 3D starter, exported and played in Chromium on the Iris Xe at 1920×1080 on WebGPU and WebGL 2, the player walked by held keys: a two-storey block-layer house built by the interiors guide (two rooms a storey, doorways, Basic Kit stairs, roof region cut away, plane at the upper walls' row, see-through on, the guide's indoors-only script on the player, type-checked through the publish route) and a grove of 41 low-poly tree models. Looked at on both renderers: downstairs the wall in front and the floor above dither in the circle, the wall below half height, the table and the floor solid; on the stairs the slab above dithers, the steps under the feet solid; upstairs the roof is cut, the floor solid, the wall in front and a tall pillar dithered, a low bench solid; trees in front dither, trunks below half height and shadows stay; the script switches see-through off outside, on inside. No see-through defect found. Guide fixed (layer height, full-block upper floor, stairs need step-up 0.55, plane at the floor's own row opens the ground storey). Shots: `acceptance/39.8-*` (10). |
| 39.9 | Done 2026-10-22: review H1 and M1–M7 fixed. H1: subjects are entities in the render graph's hierarchy (`RenderGraph.subtreeNodes`/`worldMatrixOf`, `seeThroughEntitiesOf`): a controller root whose model is a child entity is a subject (its capsule, else what its descendants draw), its model and held item never fade for it; M2: slots are chosen before the batches group, only slot holders leave batches/cells; M1: architecture's shadow, decal-layer and see-through flags go onto built meshes at once (`flagMesh`, re-listed); M3: an `_OCC` stand-in that see-through may thin fills no depth; M4: the shader and its CPU reference are one set of steps (`fadeSteps` over TSL or number ops); M5: the Scene view is on round no one from load when the project's setting is on (the switch builds nothing), and a found bug fixed: a still draw of a classic material never uploaded its subject bits after its first frame (three refreshes such a draw's own uniforms only for materials with nodes; an armed draw is now refreshed in the frames its bits change), which left the preview blank with the setting on; M7: one field list, setting keys from `SEE_THROUGH_SETTING_KEYS`, the fade time and range are the cut-away's; Lows 1, 2, 4, 6, 7, 10, 13, 15, 16. Vitest: see-through 30 → 36 (real render graph: prefab hero + child model + held item, prefab root, re-parent; slot holders only; a still draw refreshed when its bits change; steps unrolled per slot), architecture +1, occluders +1, preview +1, m23 camera +2 calls. e2e `scene-view-parity` 8.4 / 8.5 → 5.6 s in the gate (5.3 / 5.4 s alone, auto / WebGL 2; phase start 5.6; selection and edit-mode steps to vitest, settle shots 1000 → 400 ms, fade 0), `project-settings` 4.1 s (phase start 4.2): phase net −0.1 s. Fast gates green (village WebGL 2 p50 4.9 ms > 4.84 once, rerun 4.7 ms; WebGPU 5.6–5.7 ms). Re-measured with `tools/perf/see-through-run.ts` at the 60 Hz cap, 1920×1080, Iris Xe, 4 subjects (off → setting on idle → on): interior (`--storeys 2`) WebGPU GPU 11.19 → 11.49 → 12.21 ms (+1.02; 39.6: +0.98), main thread 3.66 → 3.57 → 3.77 ms, WebGL 2 main 3.06 → 3.08 → 3.20 ms; village WebGPU GPU 9.49 → 7.75 → 8.40 ms (noise ±1.7 ms run to run: an earlier run read 8.45 → 8.32 → 9.69), main thread 4.53 → 4.72 → 4.63 ms, WebGL 2 4.33 → 4.42 → 4.58 ms; draws +0, programs +0, p95 ≤ 16.8 ms, 0 missed everywhere. A first version refreshed every armed classic draw every frame: village main thread +0.45–0.55 ms (5.00 / 5.13 WebGPU), fixed by refreshing only on a bits change. |

## 5. Decision log

- 2026-10-21: Planned from Temporal G7. The owner chose dither with a maximum
  fade below 1, a subject list, fading only above the subject's feet,
  multi-floor correctness, and everything taking part by default.
- 2026-10-21 (owner, decision session): the height rule is "nothing below half
  the subject's height fades", the same everywhere. It replaces the "2D vs 3D
  project" default (P39-1).
- 2026-10-22 (39.1): every dither fade compares with one screen-space
  threshold, so fades ANDed into one mask (cut-away, see-through, later LOD
  or distance fades) thin a pixel as the largest of them, never more. The
  cut-away keeps its copy-with-variant path (its cut mesh keeps casting into
  the cached static shadow map with its own material); see-through ANDs its
  term into each material when the material is made (`andMask`).
- 2026-10-22 (39.2): the see-through term goes in where three builds a
  program (one `setupDiffuseColor` step for renderers a view armed through
  `renderer.contextNode`), not by `andMask` per material at creation: that
  reaches classic materials three converts itself and every material made
  anywhere, keeps it out of the shadow pass (three's shadow pass reuses
  `maskNode`) and leaves unarmed renderers' programs untouched. Arming builds
  each program once more (precompiled ahead); turning it off at run time
  keeps the renderer armed (no rebuild back and forth).
- 2026-10-22 (39.2), default chosen, owner to confirm: the circle's radius
  is `radius` × the view height at the subject's distance but never less
  than 0.75 × the subject's height (it covers the body when zoomed in);
  `softness` is the share of the radius that is soft (not a view-height
  share); defaults radius 0.2, softness 0.4, depth margin 0.25 m, fade time
  0.25 s, max fade 0.75 (clamped to ≤ 0.95); a subject's height is its
  controller capsule's, else its meshes' bounds; the circle centres on the
  middle of its body.
- 2026-10-22 (39.2): a subject's own exclusion is per draw: a subject drawn
  inside a batch or merged cell (not skinned, static) is not excluded from
  its own fade (39.4 checks whether that needs a batching refusal).
- 2026-10-22 (39.3), default chosen, owner to confirm: the project settings
  are six flat keys in the Rendering group (`see_through` 0/1, absent off, so
  no game changes look on an update; `see_through_radius`, `_softness`,
  `_max_fade`, `_depth_margin_m`, `_fade_s`, absent: the defaults above).
  `ctx.camera.setSeeThrough` merges each call over the project's settings
  (numbers clamped, a wrong argument changes nothing and returns false); its
  state is simulation state carried with the resolved view
  (`CameraViewInfo.seeThrough`, absent until a script calls, in the step
  digest once set) and lasts until a new run (scene loads keep it). An empty
  `subjects` list means the camera's target like `null` (what an unwired
  graph input gives). The page's `?seethrough=on|off` pins on/off over the
  project, the host and scripts.
- 2026-10-22 (39.4), default chosen, owner to confirm: a subject is drawn out of batches and merged cells
  while it is one (a batch refusal, `see-through subject`; marked before the
  batches are grouped each frame, given back once its fade has gone), rather
  than told apart per instance or per merged vertex: subjects are few and
  usually move, so it costs a draw or two, where per-instance exclusion
  would give every batch and cell an attribute and every program a branch.
- 2026-10-22 (39.5), default chosen, owner to confirm: the preview's subject
  is the selection when it is a box, a model, a character or an object with
  drawn children (a prefab's root); a light, a camera, a folder, a block
  layer, terrain, instances, architecture or a decal is never one, and then
  the subject is the target of the enabled virtual camera with the highest
  priority (the first on a tie); none: nothing fades. The switch lives on the
  toolbar beside light (the edit modes keep the toolbar), starts off on each
  page load and is never saved. Edit modes select nothing, so there the
  camera's target is the subject.
- 2026-10-22 (39.6), default chosen, owner to confirm (replaces the first
  39.6 default, which prebuilt in every game page): the project setting
  `see_through` is the feature switch, as in Unity. On, Play and the export
  build every program with the mask at load (`prebuild`; a draw no subject can
  reach skips it on a per-draw uniform), and a game that wants it only in
  places turns it off from a script at the start (the fade's easing hides
  that): later switches rebuild nothing. Off, nothing is built and nothing is
  paid; a script that turns it on anyway rebuilds every program then, through
  the precompile gate (the picture holds, about half a second on the
  interior), and Problems says once `see_through_rebuild` with the fix (turn
  on Rendering → See-through). A rebuild in the background while the old
  programs keep drawing was not possible here: three keys a draw's render
  object by object, material and target, not by the renderer's context, so
  arming makes every render object be made again rather than adding a second
  program beside the first (it would need a twin of the scene pass's target
  to compile into). `?seethrough=off` builds without it. The editor's Scene
  view still arms when its preview turns on.
- 2026-10-22 (39.6): the interior's +1.0 ms with 4 subjects is over the soft
  0.3 ms target (D297, left open after one bounded attempt, the screen box):
  ~0.27 ms the armed programs idle, ~0.4 ms the mask in the circles, ~0.3 ms
  the rooms the circles reveal; the village's open view costs nothing
  measurable.
- 2026-10-22, phase gate: `full --both-renderers` at `bc7edff0`: GREEN, e2e 389 passed, 1 failed then
  passed alone (`painted-terrain` WebGL 2, watch D298), 27 min (phase 38: 26 min; e2e 22.1 min, peak
  6.0 GB). The phase's e2e growth (+2.8 s a variant in `scene-view-parity` from 39.5, −0.3 s in
  `project-settings`) is cut by 39.9 to a net −0.1 s against the phase start.
- 2026-10-22, phase review (fresh agent, `~/.cache/thirdlight-phase39/review.md`): 1 High, 7 Medium,
  18 Low. **High:** entity children were never excluded and a subject drawing nothing itself (a
  controller root with a child model, the usual prefab shape; the preview's prefab root) did nothing.
  **Medium:** toggling architecture's `seeThrough` (and its shadow and decal flags) needed a reload;
  every named subject left its batch, not only the 4 in slots; occlusion stand-ins filled depth behind
  a dithered wall; the shader was never checked against its CPU reference; the editor preview rebuilt
  every program on first use; the e2e budget grew; constants and lists were written more than once.
  All fixed in 39.9 (`9fef44de`, `30661479`), with Lows 1, 2, 4, 6, 7, 10, 13, 15, 16; the rest are D299. Found
  while fixing M5 and fixed: a still draw of a classic material (a box) uploaded its subject bits only
  on its first frame, so what was drawn before see-through had a subject never faded (in games too,
  wherever such a draw stood still). Rule checks: no per-project caps, no history comments, boundaries
  kept (the adapter reads runtime's exports), `adapter.ts` 1,952 and `viewport.ts` 1,955 lines (net
  0), `runtime.ts` 3,988. Default chosen, owner to confirm: with the project's setting on, the Scene
  view's see-through is on from load round no one (its programs carry the mask: idle cost measured in
  a game 0 on the village, 0.27 ms on the interior class; in the editor unmeasured), and switching the preview off keeps it armed (no
  second hold). Owner's eyes: everything in the review's list (the dither look, the half-height line,
  stairs, trees, AO noise in the circle, D297's interior cost).
