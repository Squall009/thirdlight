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
| 2026-11-10 | WebGPU is the renderer; WebGL 2 a fallback with one smoke test, no new features, no parity. | `AGENTS.md` |
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

## Dropped, superseded or deferred (do not rebuild without the owner's word)

| What | Status | Since |
|---|---|---|
| Voxel-mip meshes as the default far field | fallback behind a switch | 2026-11-09 |
| Rasterised bricks and the other brick variants | retired (in git) | 2026-11-10 |
| Both-renderer parity and two-renderer measurement rounds | dropped | 2026-11-10 |
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

## Format proposals waiting for the owner's note

Each is a hard stop when its phase arrives: a `gas` role (value 10) with shape as density and a mip rule like
liquid's (47b); a fill stroke kind in the edit command (47b); narrowed feeds for liquid edits (47a); a liquid
derived part per chunk (49); a medium channel (liquid and fog) on far-cache nodes (49).
