# Owner defaults approved (phases 39–43)

Owner decision, 2026-10-26: the "default chosen, owner to confirm" entries left unanswered in the plans count as
**approved**. A change comes back as a new request when a game runs into one. This file lists the open ones of plans
39–43 (2026-10-21 to 2026-10-29), one line each; the full text is in each plan's decision log. The earlier defaults
(plans 17–38 and 41's first) were answered by the owner on 2026-10-22 (`docs/plan-phase-39b.md`, 39b.6). Defaults
logged in plan 44 and later are approved the same way unless the phase review raises them.

## Phase 39 — see-through ([decision log](../plan-phase-39.md#5-decision-log))

1. 39.2: circle radius 0.2 × view height (never under 0.75 × the subject's height), softness 0.4, depth margin 0.25 m, fade 0.25 s, max fade 0.75 (≤ 0.95).
2. 39.3: six flat `see_through*` project settings (absent: off); `ctx.camera.setSeeThrough` merges over them and is simulation state until a new run.
3. 39.4: a subject is drawn out of batches and merged cells while it is one (a draw or two), not excluded per instance.
4. 39.5: the editor preview's subject is the selection (drawn objects only), else the top-priority camera's target; the switch is not saved.
5. 39.6: `see_through` is the feature switch: on, Play and export prebuild every program with the mask; off costs nothing.
6. 39 review: with the setting on, the Scene view's see-through is on from load (its programs carry the mask).

## Phase 39b — consolidation ([decision log](../plan-phase-39b.md#5-decision-log))

1. 39b.1: unit limits apply to package sources and tools, not tests (tests keep the 2,000-line file limit); generated files unchecked.
2. 39b.2: `RuntimeInstance` keeps the public `Runtime` surface as one-line delegations (147 members, on the ratchet).
3. 39b.3 A: the scene adapter's parts share one small `AdapterState`; parts made in the old order (draw order unchanged).
4. 39b.3 B: backend parts take explicit deps; route order and method/auth check order kept; `makePlayRoutes` stays on the ratchet.
5. 39b.4 A: the session client keeps its surface by inheritance; `Viewport` keeps delegations (115 members); five unused methods dropped.
6. 39b.4 B: the GLB inspector splits per glTF area over a shared `GlbState`; `attachBrowserInput` returns a named source.
7. 39b.5: the fast gate's village check runs at the 60 Hz cap: fails on > 10 % missed refreshes or main-thread CPU > 60 % over baseline.
8. 39b.5: `tools/gate.sh full` prints its time beside the last green full gate's; no budget.
9. 39b.5: Escape in the project window clears its own choice first; `setSettings` rebases as a patch; a closing backend drops silent sockets after 2 s.
10. 39b.10b: a stored `occlusion_culling: 2` is kept; on WebGL 2 it culls nothing and Play reports `occlusion_culling_unavailable` once.
11. 39b.6b 1: no migration writes the old grey into trim materials (they brighten, with a Problems line); the object budget counts scene bytes.
12. 39b.6b 2a: the starter character has LOD0–2 although the art rule gives characters none.
13. 39b.6b 2b: the first Esc drops the tool, the next clears the selection, in every editor; the edit modes' project window is a docked Project panel.
14. 39b.6b 2c: `tl_inspect target="engine"` works without a project; light `importance` dropped; new projects get the physical sky.
15. 39b.6b 2d: the 3D starter's sky is the physical sky with sky lighting 0.1; its fog stays.
16. 39b.6b 2e: every new project takes sky lighting 0.1 from one constant; the physical sky's own default stays 1.
17. 39b.6e A: see-through true occluders: 6 boxes and 16 rays per subject, a piece reaches 16 cells, search again after 2 cm.
18. 39b.6e B: search again after 5 cm of movement or ½° of turn; the interior GPU target is missed (+1.43 ms, D305 open).
19. 39b.6b 3: GPU effect batches of 16,384 particles and at most 64 plays, buffers made whole on the first play.
20. 39b.6c B: kit models' trim data moves out of COLOR_0 at load (`vertexColors: 'trim'`), files untouched; old trim paint and terrain wetness kept as stated there.
21. 39b.6c A: stored grime becomes nothing (one Problems line); a trim material is one layer; sheets with other row layouts stay an error.
22. 39b.6d: furnished rooms without a building use stand-in blocks, not models, in the starter set, with a stated fallback order.
23. 39b.8: projects of schema 2–5 are refused, naming the git tag `upgrades-project-schema-2-to-5`; storage v3 still upgrades on open.
24. 39b.9: the editor, input and protocol get value access to pure project-model/commands subpaths instead of keeping copies.
25. 39b review: every 39b default above, the village gate thresholds and `MAX_LIVE_SPAWNED` 16,384 stand as written.

## Phase 39c — linked prefabs ([decision log](../plan-phase-39c.md#5-decision-log))

1. Plan: a prefab stays its own asset (Unity), not a scene (Godot).
2. 39c.1 A: overrides name parts by local-id paths; a part's scene id is the copy id plus an 11-character path hash.
3. 39c.1 A: objects added to a copy stay ordinary scene objects (`parentPart`); a stale override is skipped and reported.
4. 39c.1 B: the editor sees assembled objects; commands still address stored ones.
5. 39c.1 B: spawnable prefabs are flattened in Play and export.
6. 39c.3: migrated copies keep their objects' ids (`partIds`), so scripts, saves and references keep working.
7. 39c.3: a copy is linked only when it assembles exactly; otherwise it stays plain objects with a Problems line.
8. 39c.2: editing a part runs the ordinary commands and relinks; moves to another parent or scene are refused (`prefab_override_unsupported`).
9. 39c.2: revert keeps added objects; apply writes into the outermost prefab; `all` makes added objects parts.
10. 39c.2: unpack is complete (nested copies too); `updatePrefab` from a linked copy is "apply all"; cycles refused.
11. 39c.4: the prefab editor edits a stage copy no scene holds; the root's place, name and tags are refused there.
12. 39c.4: double-click opens a prefab (project window) or the prefab a copy's object came from.
13. 39c.5: the editor reads a copy's link with `queryEntity`; a variant's copy names the variant.
14. 39c.5: overridden fields get a prefab-colour bar and bold label; tiles show the first model's thumbnail; variants are named "<base> Variant".
15. 39c.6: a prefab holds what a scene object can, less block layers, instance sets, terrains, vertex paint and folders.
16. 39c.7: footprints follow what the scene shows; a prefab edit rewrites every copy's cells.
17. 39c.8: a prefab edit's change is one frame up to 1 MiB (~3,800 objects), else the editor resyncs.
18. 39c review: a destroyed spawned player leaves every list and the next player becomes the first; results carry `change.assembled` up to 64.

## Phase 40 — ground cover and wind ([decision log](../plan-phase-40.md#5-decision-log))

1. 40.0: cover grass budgets: 8 clumps/m² at LOD0 to 30 m, 2 clumps/m² at LOD1 to 80 m, nothing past; ~1.2M tris in view.
2. 40.1: the grass ships in the 3D starter's setup pack, placed nowhere; its colour is a separate texture asset.
3. 40.2 A: GPU cover keeps copies to 60 % of the reach and fades the rest; `densityStart` opts into distance thinning.
4. 40.2 B: a cover rule's `spacing` is approximated on the GPU (density within 15 % of the bake).
5. 40.2 B: no `blobShadow` under terrain cover (SSAO gives contact); stored scatter keeps blob shadows.
6. 40.2 B: `coverDistance` may reach 10 km; the CPU squares stop at 1 km.
7. 40.3: block-layer cover points are baked on the cover worker, never stored; sets let go 300 frames after leaving view.
8. 40.3: a cover point is 16 bytes, the GPU texture as is; points sorted by threshold.
9. 40.3: block-layer cover grows on every floor with open space over it (interiors too).
10. 40.3b: stored scatter and instance sets draw through the GPU copies renderer (48 bytes a copy, blocks of 64).
11. 40.3b: `shadowDistance` casts from shadow-only draws at the most detailed level.
12. 40.3 B: meshes take ground cover through an optional `scatter` on `model` and `architecture`, baked once the object rests.
13. 40.4: the gust pattern is a 128² value noise made in code, 20 m scale; a scene may name its own.
14. 40.4: wind zones are read from above and blend inward over `blend` m (2 m); a new zone changes nothing until set.
15. 40.4: the wind map is 64 texels of 4 m round the camera; zones that change direction flow like flow maps.
16. 40.4: foliage bends by wind × COLOR_0 R² × height × 0.12 per metre; existing foliage changes with its height.
17. 40.4: `ctx.environment.setWind` adds to the last change, blends over steps (≤ 16 at once), never retimes a sky blend.
18. 40.4b: clouds drift at the gust speed, 1 km up; coverage and density default 0.4; existing physical skies' clouds now drift.
19. 40.5: subjects bend grass through a `foliageBend` component (radius, strength 1, recovery 1 s); the rule's `bendAway` factor.
20. 40.6: the Scene view's wind preview is off by default and not saved.
21. 40.8: image-based lighting is read from a 256-texel cube copied from PMREM once per bake.
22. 40.8 B: block-layer chunks merge into static cells per 64 m square.
23. D316: the 3D starter uses SMAA instead of 4× MSAA; the engine default without a post stack stays MSAA.
24. D317: a draw made after load builds its program in a precompile that holds the present.
25. 40.7: the root colour is the terrain's macro albedo, terrain cover only.
26. 40 review: `setWind` drops shares under 1e-4 of the mix; clouds on (0.4) in every procedural sky, existing projects included.

## Phase 41 — one physics backend ([decision log](../plan-phase-41.md#5-decision-log))

1. 41.1: a plane is `{ axis: 'x' | 'z', origin }`; `ctx.character.setPlane(id, plane)` takes the id first.
2. 41.1: locking a child object snaps its body only; a script-set plane lasts until changed or the run restarts.
3. 41.2: a 2D shape's depth is the collider's `depth` (absent 1 m, ≤ 128 m); orientation from the authored plane only.
4. 41.2: one-way is decided by position (lowest point at or above the top, not moving up), along the collider's own +Y.
5. 41.3: the movement profile is `controller.profile`, `character` (default) or `arcade`.
6. 41.3: on a plane the arcade profile reads move x along the plane's right, whatever the camera.
7. 41.3 B: parity tolerances with the old 2D path: 1 cm events, 1.5 cm per step, ±1 step timings; stairs within 5 cm.
8. 41.3 B: under the arcade profile the 3D port climbs steps by the 2D rule (`autostepRide`).
9. 41.4: one `ctx.physics` surface by argument shape: `[x, y, z]` world queries, `{x, y}` on a plane.
10. 41.4: no gameplay-block data moves; switches work in 3D; box triggers test the capsule exactly.
11. 41.4b: "over loaded collision" is the body's ground column at each step boundary.
12. 41.4b: player characters, patrols and gravity bodies are suspended outside loaded collision; path movers never stop.
13. 41.5 A: a scene's default plane is inherited by bodies without their own `plane`.
14. 41.5 A: a game without its own input gets the side-view input when its first start scene has a plane; new empty projects are 3D.
15. 41.5 A: "stays until saved" notes per scene (`migratedFrom2D`), one Problems line per kind.
16. 41.5 B: the scene's plane is edited in Window → Scene settings; the gizmo locks bodies only; a side-view button.
17. 41.5 B: the 2D starter is authored for the one backend (1 m deep boxes, Z plane, arcade profile) and keeps its ids.
18. 41.6: the default input follows the start scene's plane; runtime keeps its `physics3d` names.
19. 41.6 fixes: every triangle-mesh collider fixes internal edges (one-sided); a standing character settles onto its skin.
20. 41.7: the pipe test is a perf class, not an e2e file; a switch passes with no missed refresh at the cap.
21. 41.7: the precompile builds every object of the scene, in view or not.
22. 41.8: the small/medium/script-heavy perf classes stay side-view layouts (numbers before 41.8 not comparable).
23. 41.10: the 2D upgrade acceptance used a throwaway copy of Sprout; an air sweep into a wall is retried without the wall part (D329).
24. 41 review: spline surfaces count as oriented meshes; scenery Problems kinds are one per kind.

## Phase 42 — unified lighting ([decision log](../plan-phase-42.md#5-decision-log))

1. §1: 42 absorbs the planned lighting phase except clustered lighting (became 43); static models without UV1 get surfels; moving objects receive light but add no bounce.
2. 42.0: corridor rect/line lights stood in by soft spots until `area` lights; the renderer requests no device limits.
3. 42.1: the medium tier's surface-cache budget is 64 MiB; work lists grouped by kind, facing and page; 32k texels a frame.
4. 42.2: the tracer is three-adapter's, one scene buffer; a block stops light when its type fills its cell.
5. 42.3: 256² rgba16float pages; 10 cm texels to 12 m, doubling with distance; budget `surfaceCacheMiB` 32/64/128.
6. 42.4: 64² texel work units, nearest first with ageing; lights mark units in reach; change thresholds stated there.
7. 42.5: `area` light conventions (faces local −Y, rect in XZ, candela along its facing, casts by default).
8. 42.6: cache texels hold direct light only; bounce from room probes (DDGI-style); probe placement rules.
9. 42.7a: a pixel finds its cache texel from world position and normal alone; read per mesh kind.
10. 42.7c: terrain traced as a clipmap round the eye (ring 0: 512 cells a side).
11. 42.7d: static model copies find their light by object slot, per pixel.
12. 42.7e: material variants copy the material's values each render call; one face hash per block layer.
13. 42.7b: area-light highlights per pixel only on cache-reading surfaces (three's LTC), the 4 that matter most.
14. 42.8: `reflections` quality setting off/medium/high, WebGPU only; fixed-step screen-space march.
15. 42.9: temporal upscaling is anti-aliasing kind `taau`; WebGL 2 keeps SMAA and FSR 1.
16. 42.9b: probe bricks of 4×4×4 at three levels (Unity APV style); placement rules per surface.
17. 42.9b done: probes placed again after a surface change (≤ 1 s), 1 ms a frame.
18. 42.10: the bake is the live system run in the editor's Scene view; saved at one level within 32 MiB.
19. 42.10b: what stops light in architecture; seeding rules; the saved header gains `lights`.
20. 42.11: a quality level names a lighting tier; one tier table; medium draws at render scale 0.667.
21. 42.12: lighting debug views in the Scene view's View menu; the Lighting window's preview is the Scene view's, not saved.
22. 42.12b: a room grid's probe inside geometry is dropped; a bake restarts every probe once the cache settles.
23. 42.13a: under TAAU a draw is refreshed as three does without motion plus one full refresh after each full one.
24. 42.13b: probe updates owe their GPU time to later frames' budgets; architecture pixels read one plane rectangle.
25. 42.16b: a ray out of steps resumes up to 3 times, then counts as blocked.
26. 42.16c: a re-bake deletes the previous bake's assets; with several scenes open a bake saves only its own.
27. 42.16d: a quality level's render scale yields to the project's own; at most 32 directional lights light the cache.
28. 42.16e: a static glowing box's mode is its `emissiveMode` (absent baked); a bake saves terrain as rings.

## Phase 43 — clustered lighting ([decision log](../plan-phase-43.md#4-decision-log))

1. 43.0b: local lights are one `ClusteredLights` node; a 16 × 9 × 24 froxel grid; textures grow under a 16 MiB budget, no per-cluster cap.
2. Lead: the 16-slot effect-light limit is lifted (effect lights join the clusters); the shadow atlas is 16-bit depth, 2,048/4,096/8,192 per tier.
3. 43.1a: record slot packing; a long list keeps one header texel; "nearest" ranks first.
4. 43.1b: lists hold every realized local light; the heat map replaces the lit result.
5. D398: data textures with `texelFetch` on both renderers (one path); lit programs get a 16-texture-unit budget.
6. 43.1c: a terrain page holds 128 tiles; contact shadows ride in the AO history; projected decals over budget for now (D399).
7. 43.2a: until the atlases, shadowed or cookied lights stay three's own; the 16-light selection no longer caps point and spot lights.
8. 43.2b: the LTC tables take a unit only while an area light exists; the cookie atlas shares that texture.
9. 43.3a: 16-bit atlas depth with stated bias; an R8 colour attachment beside it (12/48/192 MiB); spot records 6 texels.
10. 43.3b: point lights cast through six faces (all or none); area lights cast five; cookie atlas 2,048² RGBA16F while used.
11. 43.4: a furnishing set's Lights count is retired (every Light node gets its light) by a recorded schema-8 step.
12. 43.4c: a compressed cookie draws a frame or two after it is set; a dropped cookie atlas becomes one texel.
13. 43.4b (D399): decal pages are one linear UASTC array; screen histories shrink by two units.
14. 43.5a: froxel slices run from the nearest packed light's reach to the farthest's; black lights skip lighting.
15. 43.6b: shadow-atlas redraw order with a 3-frame wait limit; a program over the texture limit draws a plain lit fallback.
16. 43.6c: point/area lights dirtied by movers redraw only the faces movers touch; the lights perf class gets walkers.
