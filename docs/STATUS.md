# Thirdlight — Status

Updated 2026-10-30. Current phase: **44, consolidation** (`docs/plan-phase-44.md`); next 44b (camera), then the
voxel world, 45–49 (`docs/plan-phase-45.md`). Order and future work: `docs/roadmap.md`. Goal and scope:
`docs/architecture/charter.md`. Work rules: `AGENTS.md`. Each phase's items, numbers and decisions are in its plan;
this file holds one row per phase, two lines at most.

Defects: `docs/audit-2026-09-22.md` (D-numbers below). On 2026-10-30: 119 open (M 31, L 88; no C or H), 19 watch;
266 fixed, 13 superseded, 3 won't fix.

Done: an item works in a real browser and has an automated test at the boundary it fixes (Playwright for the editor).
Visual and audible results no test observes in pixels are marked "owner look pending": that is the normal done state.
The owner reviews by building in the game folders; a problem comes back as a game request or a D-row.

## Phases

| Phase | Goal | Status |
|---|---|---|
| 0 | Commit the work, archive the packet process, reset the docs | done 2026-09-22 |
| 1 | The M1 authoring loop works in a real browser (D1, D4–D8, D14) | done 2026-09-22 |
| 2 | One current schema; every feature reachable through the product (D2, D3, D9, D22–D26) | done 2026-09-22 |
| 3 | The charter's first-release editor features (D15, D16, D27) | done 2026-09-22; multi-select, duplicate and reorder came in 7 and 12 |
| 4 | Beacon Reach playable in editor and export (D10–D13, D20, D28–D30) | done 2026-09-22; Beacon Reach removed in 24 |
| 5 | MCP parity with charter §7 (D18) | done 2026-09-22 |
| 6 | Real M4: templates, independent project, one-command start, backup (D17, D19) | done 2026-09-22 |
| 7, 7b | Unity-like editor layout (docks, menu bar, tiles); theme, logo, icons | done 2026-09-23; layout redone in 27 |
| 8 | Debt: one schema version, `backend.ts` split, no test code in production, unused deps gone (D21) | done 2026-09-24 (`9825bf7c` removed the v1/v2 model) |
| 9 | Towards a real platformer: materials, lighting, baking, rigs, input, physics, game flow, audio — `docs/plan-phase-9.md` | done 2026-09-24 |
| 10 | Projects in the game's own repo (registry, `thirdlight.json` marker, MCP finds the project from its folder) | done 2026-09-23 |
| 11 | Play without the owner's browser (headless Chromium session for MCP) | done 2026-09-24 (as 9.2) |
| 12 | Foundations: folder objects and multi-select, tags, additive scenes | done 2026-09-24 |
| 13 | Material node graph | moved to 18 |
| 14 | Platformer toolset: collider as data with handles, spawn/timers/sensors — `docs/plan-phase-14.md` | done 2026-09-24 |
| 15 | Everything editable: descriptors, generic Inspector, handles, tuning values as data — `docs/plan-phase-15.md` | done 2026-09-24 |
| 16 | Graph editor framework, centre workspace tabs, Animator and script editor — `docs/plan-phase-16.md` | done 2026-09-25 |
| 17 | Renderer: WebGPU with a WebGL 2 fallback, shading in TSL — `docs/plan-phase-17.md` | done 2026-09-25 |
| 18 | Material node graph — `docs/plan-phase-18.md` | done 2026-09-25 |
| 19 | Visual scripting compiled to behavior modules — `docs/plan-phase-19.md` | done 2026-09-25 |
| 20 | Visual effects graph on GPU compute, CPU fallback — `docs/plan-phase-20.md` | done 2026-09-25 |
| 21 | Performance and memory pass, budgets and a harness — `docs/plan-phase-21.md` | done 2026-09-26 |
| 22 | Multithreading: simulation worker, editor workers (render worker not adopted) — `docs/plan-phase-22.md` | done 2026-09-26 |
| 23 | 3D game foundations: 3D physics and controller, cameras, block layers, UI, modes, dialogue, saves — `docs/plan-phase-23.md` | done 2026-09-27 |
| 24 | Engine/game separation: generic capabilities only, genre layer and Beacon Reach removed — `docs/plan-phase-24.md` | done 2026-09-28 |
| 25 | Sprout and Skyforge requests as generic capabilities (TL-*, E18–E40) — `docs/plan-phase-25.md` | done 2026-09-29 |
| 26 | Asset scale and streaming: asset database, no count caps, refcounted loading — `docs/plan-phase-26.md` | done 2026-09-30; open D64, D71, D85–D88 |
| 27 | Editor layout: full-window editors, one Inspector, Project Settings window, icons — `docs/plan-phase-27.md` | done 2026-10-02; open D106, D119 |
| 28 | Sprout and Skyforge requests, second batch (scene reload, keep-loaded objects, UI, animation) — `docs/plan-phase-28.md` | done 2026-10-03; open D138, D146 |
| 28c | Performance baseline: draw only what is seen, simulation one frame behind, frame cap — `docs/plan-phase-28c.md` | done 2026-10-06; open D160, D161, D164–D170 |
| 28b | Block and texture fixes: square cells, KTX2 texture arrays, world UVs — `docs/plan-phase-28b.md` | done 2026-10-06; open D172–D178, D180 |
| 29 | Scalable lighting: probes, cached shadows, light layers, render scale, quality levels — `docs/plan-phase-29.md` | done 2026-10-07; open D185–D190 |
| 30 | Level building: blocks, CDLOD terrain, rules and scatter, splines, streaming, generated architecture — `docs/plan-phase-30.md` | done 2026-10-09; open D197, D202, D205, D207–D217 |
| 31 | Documentation and AI onboarding: the manual, generated reference, `tl_docs`, agent skill — `docs/plan-phase-31.md` | done 2026-10-10; open D230–D233 |
| 32 | Decals and vertex paint — `docs/plan-phase-32.md` | done 2026-10-11; open D236, D239, D242–D245 |
| 33 | Occlusion culling (Hi-Z + indirect draws on WebGPU, queries on WebGL 2; off by default, D282) — `docs/plan-phase-33.md` | done 2026-10-18; open D282–D286, D288 |
| 34 | Level editors: full-screen edit modes, one brush kit, terrain editor — `docs/plan-phase-34.md` | done 2026-10-12; open D254 |
| 35 | One layered surface material, vertex paint editor, decal editor and atlas — `docs/plan-phase-35.md` | done 2026-10-13; open D261, D262, D265, D267; watch D266 |
| 36 | Block editor, kits as one item, Basic Kit, trim sheet spec, 3D starter template — `docs/plan-phase-36.md` | done 2026-10-13; open D269, D271; watch D273 |
| 37 | Level editor polish: Navigate tool, docked panels, no white blocks while encoding — `docs/plan-phase-37.md` | done 2026-10-17; open D275, D276, D278, D280; watch D277 |
| 38 | Sprout, Skyforge and Temporal requests, third batch; `ctx.scenes.load`/`unload` — `docs/plan-phase-38.md` | done 2026-10-21 |
| 39 | See-through around subjects — `docs/plan-phase-39.md` | done 2026-10-22; open D297, D299 |
| 39b | Consolidation: unit-size rule, roots split, defect statuses, owner decisions applied — `docs/plan-phase-39b.md` | done 2026-10-24; open D305 |
| 39c | Linked prefabs: overrides, edit mode, nesting, variants, schema 8 — `docs/plan-phase-39c.md` | done 2026-10-24; open D308, D310 |
| 40 | GPU ground cover on any surface, wind with zones — `docs/plan-phase-40.md` | done 2026-10-25; open D212, D313; watch D319, D320 |
| 41 | One physics backend: Rapier 3D, 2D as a switchable plane — `docs/plan-phase-41.md` | done 2026-10-26; open D328; watch D331 |
| 42 | Unified lighting: surface radiance cache, `area` lights, room probes, TAAU, one bake — `docs/plan-phase-42.md` | done 2026-10-28; open D339 |
| 43 | Clustered forward lighting, shared shadow atlas, 16-light cap lifted — `docs/plan-phase-43.md` | done 2026-10-30; open D400, D405 |
| 44 | Consolidation from the global audit (G1–G22) and a docs reset — `docs/plan-phase-44.md` | in progress: 44.0–44.8b done |
| 44b | Camera: occlusion modes per camera, adaptive exposure | planned 2026-10-28 (owner draft), after 44 |
| 45–49 | Voxel world: formats (45), core (46a–d), structures and tools (47a–c), migration and merge (48a–c), water (49) — `docs/plan-phase-45.md` | planned 2026-10-28; on a branch, after 44b |
| — | Engine verdict (owner request) — `docs/verdict-2026-10-04.md` | 2026-10-04: keep; the owner resumed feature phases with 28b; open D153, D156 |

Phases 0–43 are owner look pending where visual or audible (see above). A row's open D-rows are the ones it named;
the defect list holds the rest.

## Notes

- Tests: `npm test` (unit/integration), `npm run build && npm run test:e2e` (Playwright, real backend + Chromium);
  gates: `tools/gate.sh` (AGENTS.md).
- Run it: `npm start` (`docs/deployment.md`). One owner token (`~/thirdlight/owner-token`) for the browser, MCP and
  admin routes. The service runs process-level inside the Proxmox LXC (`docs/environment.md`); no containers.
- Project data: game folders registered in the data root (`/home/dadmin/thirdlight/projects/`).
