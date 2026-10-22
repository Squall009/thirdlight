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
