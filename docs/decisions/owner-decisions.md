# Owner decisions — the register

One line a decision, newest last, with where its detail lives. A decision made in a chat, a brief or a plan is
added here in the same commit; nothing is decided twice and nothing dropped is rebuilt. A change of direction in
the middle of a phase is recorded here and waits for the next phase boundary unless something is broken (owner,
2026-11-12: stop steering mid-phase so the engine becomes usable again). Earlier decisions are in the plans'
owner-requirement sections and `owner-defaults.md` (defaults the owner let stand).

## Decisions

| Date | Decision | Detail |
|---|---|---|
| 2026-10-28 | One 0.5 m voxel world replaces block layers, heightfield terrain and generated architecture; all of it on one branch; main frozen until the merge. | `plan-phase-45.md` §1 |
| 2026-11-01 | three.js is checked each phase; only the owner authorizes an update. | `AGENTS.md` |
| 2026-11-04 | Detail pieces only at edges, corners, ground contact and roofs; walls and floors are plain voxel faces. | `plan-phase-46c.md` |
| 2026-11-09 | The far field is ray-marched bricks; relief displacement off on every tier; height in the albedo's alpha. | `plan-phase-46d.md` §2, §6d |
| 2026-11-10 | WebGPU is the renderer; WebGL 2 a fallback with one smoke test, no new features, no parity (the fallback's check dropped 2026-11-25). | `AGENTS.md` |
| 2026-11-10 | Floor target: Intel Iris Xe, the low tier at 720p upscaled (render scale ~0.667, temporal upscale), capped at 30 Hz. Medium and high are unverified on this host. | `plan-phase-46d.md` §2 |
| 2026-11-11 | Minimum spec 8 GB RAM; low's budget about 4 GB (page + GPU). Budgets come from the hardware target, never from "today's use plus a margin". | `plan-phase-46d.md` 46d.23 |
| 2026-11-11 | Travel up to 150 m/s is judged by hitches (longest frame, frames over 100 ms) and the settle after a stop; nothing falls through. Full detail under a moving camera is not a criterion. | `briefs/streaming-rings-2026-11-11.md` |
| 2026-11-11 | Hobby project, nothing shipped: fast and reversible over ceremony. Games are on hold and may break until the voxel merge. Gates run by affected area. | `AGENTS.md` |
| 2026-11-12 | Brick bake level per voxel world: 2 m default, 1 m or 0.5 m; run-time compute builds only levels finer than the bake. Low = the detail ring + baked 0.5 m bricks, the read ring ending at the detail reach. | `briefs/bake-level-2026-11-12.md`, 46d.26 |
| 2026-11-12 | Voxels are the single source of truth: terrain, buildings, water, fog, materials and physics; vegetation rules derive from the voxel and its material id. | `architecture/voxel-engine.md` |
| 2026-11-12 | Water = liquid-role voxels. Fog = a new non-solid role, fill bits as density, material id as fog type. Both painted with the voxel brushes and one shared height-based fill. Splines are for roads, paths and rivers and write voxels. | `research/water.md`, `research/fog.md` |
| 2026-11-12 | One undo path for the scene and voxels. | `plan-phase-46f.md` 46f.4 |
| 2026-11-12 | Vegetation: rules from the material are the default; a hand-placed tree is an ordinary prop that rule plants keep clear of; density by material variations; two reserved voxel bits held, unspent, for a density value (switch to them if one material needs more than about three density variations). No per-plant exception list in the engine; plants a player fells are the game's saved state. | `research/vegetation.md` |
| 2026-11-12 | Editing terrain updates bodies of water, in the editor: "I want to be able to edit in the world tools and have the shoreline updated, not see a wall of water that I then have to refill with the water tools." Editor only for now; the foundation a later water simulation draws from. | `roadmap.md` 47a |
| 2026-11-12 | A short foundations phase (46f) before lighting, and the order 46f → 46e → 47a → 47b → 47c → 48 → 49 water → 50 vegetation → 51 fog → post stack. | `roadmap.md` |
| 2026-11-12 | The demo project comes in after the merge to main (48), as the stress scene with real art. | `roadmap.md` |
| 2026-11-14 | 46f's five defaults stand. 46e runs in two parts with a stop at the lighting storage choice; the A/B runs both stores on voxels on one scene (the surface cache ported, the light volume, and the cache near with the volume beyond). | `plan-phase-46f.md` §10, `plan-phase-46e.md` §9 |
| 2026-11-14 | The format spec may gain an add-only entry for three derived outputs, never stored: region labels, chunk face connectivity, sky columns (for 46e's lighting and regions). Nothing else in an approved spec changes. | `plan-phase-46e.md` §8 |
| 2026-11-16 | The lighting storage for voxel worlds is the voxel light volume. 46e-b's order: remove the cache's voxel port and the hybrid; every light type into the volume (per-brick lamp list in world space, spot cones, area lights, emissive materials); fix the observed defects on the update side; only then tune, on the town and a many-lamps scene; low tier 720p at the 30 Hz cap. Shadows and the sun field stay on at every tier. | `plan-phase-46e.md` §6, §9 |
| 2026-11-16 | Emissive light is a property of the voxel's material, never stored per voxel; the volume keeps it per cell as it keeps the bounce colour. The add-only material format entry is proposed for approval before it is built. | `plan-phase-46e.md` 46e.11 |
| 2026-11-17 | Emissive voxel materials (46e.11), approved with changes (relayed by the owner's other session): reuse `params.emissive` × `params.emissiveIntensity`; without a mask the surface draws glow × the material's colour texture and the volume uses glow × the material's mean colour; a glow mask affects only the drawn pixel, packed in a spare channel of a map already read (no new array, no 14th binding; none free = stop), the volume using the mask's mean computed by the engine; the mask's entry text goes to the owner before it is built; no far-field glow in 46e-b. | `briefs/proposal-46e.11-emissive.md` |
| 2026-11-18 | The glow mask in the ORM map's alpha is approved as proposed on acc46e-11 (relayed by the owner's other session): it affects only the drawn pixel; the volume uses the mask's mean, computed by the engine. Dark rooms: no default minimum brightness and no per-scene minimum. | `briefs/proposal-46e.11-emissive.md`, `plan-phase-46e.md` §10 |
| 2026-11-20 | 46e-b accepted; its five defaults stand: the relayed notes of 11-17 and 11-18 confirmed in person; the glow mask's volume rule as built (the mean of colour × mask); rooms under cut-away stay dark (no light let in, no minimum); the update's share stays 3.5 ms on low; the lower-rate read waits for the performance phase after 49. Every "default chosen, owner to confirm" of plan-46e §9 stands. | `archive/briefs/acceptance-46e-b.md`, `plan-phase-46e.md` §10 |
| 2026-11-20 | 47a's item list and order, its seven format entries F1–F7 and its five defaults are approved as proposed: D741 is 47a's last build item and the first cut; the lead chooses rotated buildings' light by the measurement; water is drawn near only until 49; a building leaves the ground alone; hand edits on a structure are dig, add and paint until 47b. | `plan-phase-47a.md` §6, §8, §10; `briefs/proposal-47a-formats.md` |
| 2026-11-25 | 47L accepted; its five questions answered. (1) "I couldn't care less about webgl2 at this point. The engine really isn't going to work on that moving forward so fix webgpu and remove the webgl2 check since it doesn't matter.": the wall-foot sun fix is restored and WebGL 2 is no longer checked or kept working (its smoke test archived; its code paths stay, unchecked). | `../archive/briefs/acceptance-47l.md`, `plan-phase-47l.md` §9 |
| 2026-11-25 | (2) "Since we are still under the current frame time add it to a performance recommendation list that we can revisit after 49.": light through partly covered cells stays on at every tier, low included; its cost and the phase's other measured costs go on the performance list for the pass after 49. | `perf-recommendations.md` |
| 2026-11-25 | (3) "This does look better and I don't think it will be as obvious in a real scene with textures and detail geometry.": the blotchy indirect light (D692) and the specks without the temporal upscale (D808) are accepted for now. | `plan-phase-47l.md` §9 |
| 2026-11-25 | (4) "Agreed.": a shut portal casts the sun's shadow over its opening whatever its model draws (the sun follows the portal's state, plan-47l §9's default). | `plan-phase-47l.md` §9 (47L.4) |
| 2026-11-25 | (5) "We have such a huge list of tests and defect rows. I think this needs a cleanup so it isn't so massive. Have we archived any of them? seems like we have a lot of flaky rows and I think that says more about the testing and criteria than it does the engine changes.": the closed defect rows are archived to `audit-closed.md`; the test suite and the open rows get a cleanup, its options measured for the lead. | `plan-phase-47l.md` §9 |
| 2026-11-26 | 47T accepted, all five defaults: 28 pictures and a phase run of about half an hour; the check stays at about 4 minutes; the list of what nothing checks any more; D825–D832 placed by 47b's plan; retiring systems untested until 48. | `briefs/acceptance-47t.md`, `plan-phase-47t.md` §8 |
| 2026-11-26 | 47b approved with its format entries G1–G6 (the `gas` role as value 10 of the existing role bits, its mip rule, the `gas` material use, edit command v3 with `flood`, `smooth`, `flatten`, `voxel.dressing` and the dressing asset, the derived list). 47b ends at ground cover. | `plan-phase-47b.md` §4, §8 |
| 2026-11-26 | Large static objects (trees, rocks, props) are stamped into the voxel data under a `prop` role: the near mesher skips those cells and the object's model is drawn; light, paths, collision and the far bricks read them; included in the bake. Its own phase, 47p, after 47b. Collision from the voxels, rough, is accepted for now; mesh colliders for a forest are measured later. A prop's far colour is its cells' material ids, as terrain's. | `plan-phase-47b.md` §8, `roadmap.md` |
| 2026-11-26 | A role traits table: consumers ask one table what a role does, so a role added later costs a row. | `plan-phase-47b.md` 47b.0 |
| 2026-11-26 | Overlays: props' voxels are a generated overlay over the base world, flattened at export; splines move onto it in 48; structure grids keep their own lattice. A general layer workflow for grids, props and splines is noted for after the merge. | `plan-phase-47b.md` §8, `roadmap.md` |
| 2026-11-26 | Draw rings, LOD stages and fades are a phase of their own after 51, tuned on the demo scene's assets. Until then: props turn to voxels where the bricks begin, ground cover ends at the detail ring. | `roadmap.md` |
| 2026-11-26 | The order sticks through 48 and the merge to main, the priority; nothing more is inserted before it; what comes up is noted for after the merge. The demo's scenes and rules wait for the merged version (its assets are made ahead). | `roadmap.md` |
| 2026-11-27 | The picture set is a baseline for deviation: what did not change from the previous set is left alone until the owner says something is wrong; the reader reports changes, not opinions of scenes it does not know. Lighting is revisited as a whole after the merge, once used in a real scene and seen in motion. Of 47b's pictures the owner's own findings: specks in many shots, and fog cubes that do not thin toward their edges (51's fog pass). | `pictures.md`, `roadmap.md` |
| 2026-11-27 | Wall-top fill is not an option: a roof always closes down onto the wall under it (the stepped-top choice of 2026-11-06 is withdrawn). `wallTopFill` is removed everywhere and the roof geometry keeps one path. Done after the merge. | `roadmap.md` (noted for after the merge), D829 |
| 2026-11-27 | Dressing is run-time placement only and never touches the voxel data: dressing plants receive light, force interaction and wind from the surrounding fields and contribute to none of them; nothing of them is written to a voxel layer. The one exception is optional shadow casting, off by default (screen-space occlusion on ground cover is the expected look). Dressings must be fast enough for a lush world round the camera. This withdraws "rule-placed large plants stamped alike" from 47p's line: what happens to the dressing's `large` class is asked in 47p's plan. | `roadmap.md` 47p |
| 2026-11-27 | The dressing's two classes differ by where they are placed (the owner, correcting the line above the same day): **cover** is run-time placement only and never touches voxels; **large** stays in the same dressing asset and is placed by its rules in the editor, at edit time, each plant stamped into the voxel data exactly as a hand-placed prop is (the `prop` role: light, paths, collision, far bricks). Stamping a turned prop by sampling its import-time stamp into the world's cells (a cell off at the edges, thin parts needing a rule) is accepted. | `roadmap.md` 47p |

## Dropped, superseded or deferred (do not rebuild without the owner's word)

| What | Status | Since |
|---|---|---|
| Voxel-mip meshes as the default far field | fallback behind a switch | 2026-11-09 |
| Rasterised bricks and the other brick variants | retired (in git) | 2026-11-10 |
| Both-renderer parity and two-renderer measurement rounds | dropped | 2026-11-10 |
| WebGL 2 as a checked fallback (its smoke test, `tests/e2e/webgl2-smoke.e2e.ts`) | dropped: archived, WebGL 2 no longer checked | 2026-11-25 |
| Relief displacement of the near mesh; GPU compute tessellation by distance | deferred to a later stage; code off behind a switch | 2026-11-09, 11-11 |
| Detail-piece LODs | deferred on purpose | 2026-11-11 |
| A memory ceiling set from that day's measurement | rejected | 2026-11-11 |
| Full-detail data under a flying camera as the 150 m/s criterion | replaced | 2026-11-11 |
| A whole-map bake of near meshes | rejected (storage); the bake level covers bricks | 2026-11-12 |
| Painted 2D world layers; fog splines and ribbons | not in the first version | 2026-11-12 |
| A separate baked 2 m surface set | not needed: the 2 m far cache holds it | 2026-11-12 |
| Plan 45 §8's water rendering and simulation (smooth mesher surface, cellular settle) | superseded by the water research; static first, bodies regenerate in the editor | 2026-11-12 |
| Froxel fog as the first fog step | reordered: the interactive ground fog first, froxels last | 2026-11-12 |
| Retiring the level 1–2 mesh rings | not yet: they stay for worlds baked to 2 m | 2026-11-13 (46d-c) |
| The surface cache on voxel surfaces (charts, face hashes, chart worker) and the hybrid of cache near, volume far | removed in 46e.9 after the A/B; the hybrid with the cache's texels near not measured | 2026-11-16 |
| A compute build of the clustered light lists | not in scope (the CPU build is 0.2–1.6 ms; the Iris Xe is GPU-bound) | 2026-11-16 |
| The kit's `wallTopFill` option and stepped gable tops under a roof | withdrawn by the owner; fill becomes the one path, removed after the merge | 2026-11-27 |
| Baking the light volume to disk | a possible later item; needs a format entry | 2026-11-16 |

## Format proposals waiting for the owner's note

Each is a hard stop when its phase arrives: a `gas` role (value 10) with shape as density and a mip rule like
liquid's, and a fill stroke kind in the edit command (both **approved 2026-11-26** as 47b's G1, G2 and G4; the
role, its mip rule, the `gas` material use G3 and the derived list's entries G6 **built 47b.2**); a
`prop` role, stamps voxelized from models and the overlay's files (47p); narrowed feeds for liquid edits (47a: approved as F7
2026-11-20, **built 47a.9**: `changeFeeds`, derived data 33); a liquid derived part per chunk (49: its plain first
form built with F7 in 47a.9, a part per derive section; 49 extends it); a medium channel (liquid and fog) on
far-cache nodes (49).

**47a's entries, proposed and approved 2026-11-20** (`briefs/proposal-47a-formats.md`; no longer waiting): F1 the
structure record; F2 a structure's grid (the manifest's grid list, the transform on the object, the anchor); F3
overrides (`TLVO` 2 from draft to used); F4 opening props and portal state; F5 spline sections that write voxels and
the record of what a world-grid structure replaced; F6 the water body record; F7 narrowed feeds for liquid edits
with a plain liquid part (the register's 47a line, and the first form of 49's liquid part).
