# Phase 46a — Voxel core runtime

Status: **46a: in progress (started 2026-11-02)** on branch `phase-45` (worktree `~/projects/thirdlight-p45`, base
aeb8114a; main frozen at d4053cab). Planned from `docs/plan-phase-45.md` §4 (46a), §5c, §6 results and the owner
decisions of 2026-11-02, against format spec v1 (APPROVED, `docs/architecture/voxel-format-spec.md`).

## 1. Scope

From plan-45 §4: the store from 45, `voxelAt`, `ctx.voxels` (get/set/dig, change events, the guaranteed update path),
streaming in runtime, editor and export, floating origin, per-chunk collision (Rapier churn measured), the occupancy
channel. The runtime streamer reads through the overlay (spec §2.3); 16³ derive sections and the atomic swap (45.10c)
carry over. **Remesh within a frame is the goal (R107, owner 2026-11-02):** the frames of every edit are recorded on
the Iris Xe at the 60 Hz cap; misses are recorded with their cause and go to the performance phase, never block.

Also in 46a: D432 (range reads under latency), D433 (voxel ops on the protocol, so MCP sends them), D434 (physics
memory and a collision ring), D440 (draw and collide per chunk over 16³ derives), D437 if cheap.

**Not in 46a:** the terrain mesher, its rule sets and dynamic LOD (46b; the reference surface nets and naive base
faces stay); kits, cases, role spec and trim layout (46c); the material model, texture arrays, HLOD and far field
(46d; the 45.10b slice shader stays); lighting, the tracer, culling and navigation (46e; the prop channel is derived
here, consumed there); structures and rotated grids (47a; **M7, cross-grid dependencies, stays the recorded open gap
before 47a, not built**); brushes, role painting and MCP voxel tools beyond D433's two ops (47b/47c); converters and
`ctx.grid` as a wrapper (48a); climate (spec §2.4, specified only). No format change is planned; if one turns out to
be needed it is a versioned add-only step with an owner note (spec §3.8).

## 2. three.js check

three 0.187.0 (released 2026-10-30) is still the newest on npm on 2026-11-02 (`npm view three`: 0.187.0, modified
2026-10-30). No newer release, so nothing to assess against `docs/three-upgrade-checklist.md`; no update (owner-only).

## 3. Baseline (phase 45, the numbers 46a reports against)

| What | Phase 45 number | Source |
|---|---|---|
| Slice at 720p, the 60 Hz cap, both renderers | orbit p95 16.7–16.8 ms, 0 missed of 1,799 ×3; 160 m flight 0 missed | plan-45 §6 45.9 |
| Edit (command) → visible p50 | 65 ms WebGPU / 81 ms WebGL 2 (45.7b: 65/65; 45.9: 65/64) | 45.7a table |
| Blast → swap shown, local, 16³ | terrain 1–4 m: next frame; 8 m: 2 frames; town big blasts 3–5 frames (main-thread replace 200–220 ms for 8 m) | 45.10c |
| render() CPU, one object a section | slice 1.4 (32³) → 4.2 ms (16³); town 3.6 → 13.8 ms (D440) | 45.10c, D440 |
| Collision | 448 bodies (794 colliders), 16.6 MB counted; Rapier WASM heap 126 MB cold → 172 MB after the flight, never shrinks (D434); add p50/p95 2.2/4.0 ms, remove 0.2/0.9 ms | 45.7b, 45.9 |
| Streaming under latency | +40 ms a response: near ring p50 761 / p95 1,148 of 1,344 chunks missing (D432); 64 KB gap + 8 reads: p95 54 at 9× bytes | 45.5b |
| Stream memory | 67 → 84 MB (45.9); 114 MB with shader grids (45.10b) of the low tier's 256 MiB | 45.9, 45.10b |
| GPU a frame, blend / flat | 7.1 / 3.1 ms WebGPU, 3.8 / 1.9 ms WebGL 2 | 45.10b |
| `tests/e2e/voxel-world.e2e.ts` | 22.5 s (9.9 + 5.3 + 7.3 s) | 45.10c fast gate |
| Full gate | 29 min, 8.0 GB peak (at 78f67fe8) | §6 row 45, §7 phase close |

## 4. Where things live (verified 2026-11-02)

- `@thirdlight/voxel` (pure): `voxel-streamer.ts` (takes a `PaletteStore`; no overlay yet), `voxel-overlay.ts`
  (built and tested, not wired), `stream-sections.ts` (16³ sections, atomic swap), `region-source.ts`
  (`ChunkSource`, `RegionByteSource`), `worker-pool.ts`, `floating-origin.ts`, `derived-collision.ts`,
  `prop-coverage.ts` (per-chunk channel + `lightCoverage`, tested in `tools/voxel-bench/derived.test.ts`, not wired).
- Slice page `packages/editor/src/voxel-world/` (`page.ts`, `chunk-meshes.ts` one object a section, `collision.ts`
  one body a section, `local-edits.ts`, `pending-edits.ts`, `probes.ts`, `voxel-worker.ts`); backend
  `packages/backend/src/voxel-routes.ts`; workspace `packages/workspace/src/voxel-worlds.ts` (`VOXEL_WORLD_OPS`
  defined there; not in `ALL_COMMAND_OPS`, protocol `http.ts`, nor MCP's enum, `mcp-adapter/src/tools.ts`).
- Runtime: `ctx` is assembled in `packages/runtime/src/script-context.ts` (`ctx.grid` from `RuntimeGrid`,
  `ctx.scenes`); runtime depends on project-model and shared only (`tools/check-boundaries.mjs`), so `ctx.voxels`
  needs a boundary change (runtime → voxel) in its own commit.
- **The simulation runs in a worker by default** (`game-host/src/threading.ts`, `sim-worker.ts`), physics
  (physics-rapier, `heightfield` shape already in `port3d.ts`, `physicsMemoryBytes3D`) with it; the page renders.
- Export: buffers by digest through `bufferResolver` (`game-host/src/scene-catalog.ts`: whole verified files
  `content/sha256/<digest>`, no ranges); workers shipped as `js/*.js` (`exporter/src/export-bootstrap.ts`); bundle
  scan `exporter/src/scan.ts`.

## 5. Items

Order per AGENTS.md: commands/schema → runtime/adapter/host → editor → exporter → tests → docs. Each item is one agent,
~1–2 h, fast gate green. Browser checks extend `tests/e2e/voxel-world.e2e.ts` only (no new e2e file); the rest is
vitest at real boundaries (real workers, region files on disk, real backend over HTTP, real Rapier). Every perf
number: Iris Xe, 1280×720, 60 Hz cap, both renderers, ≤ 3 rounds, `uptime` recorded.

| Item | Builds | Tested at | Measures | Done when / closes |
|---|---|---|---|---|
| 46a.1 | **Voxel ops on the one command path (D433).** `VOXEL_WORLD_OPS` defined once in `commands/src/mutation-ops.ts` (workspace, protocol and MCP import it); `ALL_COMMAND_OPS` and `tl_command`'s enum list `editVoxels`/`undoVoxels`, routed to the workspace's voxel worlds as today; a `voxelsChanged` event (world, revision, chunks, box, parts) on the editor's WS feed. | `tests/integration/voxel-world/voxel-world.test.ts` (real backend: an edit sent as MCP sends it = the page's; a second client gets the event); MCP adapter test against a real backend | — | MCP digs and undoes through `tl_command`; D433 fixed |
| 46a.2 | **Schema: `voxelWorld` component** (world name, load/unload ring, collision radius, section edge default 16, saved-fields mask default `DEFAULT_SAVED_FIELDS`) and an add-only **`affectsLighting`** flag on placed props (spec §3.7 prop channel); canonicalizers field by field; descriptors for the inspector. | project-model vitest (canonical round trip keeps every field, refusals); `setComponent` through the backend (integration) | — | fields survive save/reload; no schema bump unless the version rules demand one (then an add-only step + owner note) |
| 46a.3 | **The streamer reads through the overlay** (spec §2.3): base chunks land in the store, runtime edits go to a `VoxelOverlay`; payloads, aprons and `voxelAt` read overlay-then-base; overlay entries survive unload/reload, counted in the budget; feeds mask decides parts (material/wetness → shader data only); `saveChunks(saved)`; engine default section edge 16. | `tools/voxel-bench/stream.test.ts` (real workers, region files): every derive = fresh derive of the merged view; unload/reload keeps a dig; wetness paint 0 mesh derives; save keeps only saved fields | overlay bytes per changed cell, edit → swap ms (Node) | equal-to-oracle in workers; base never written |
| 46a.4 | **Range reads under latency (D432):** reads batched per region column with a gap between the two (default 16 KB), more reads in flight where the server speaks HTTP/2, prefetch along the focus's motion (`region-source.ts`, streamer reads). | `stream.test.ts` (request count/bytes against the oracle); `run.mjs stream-page` +40 ms | near holes p50/p95 of 1,344, requests/s, MB fetched vs 11.8 MB localhost, both renderers at 80 m/s | near ring p95 ≤ 54 at +40 ms with ≤ 2× bytes: D432 fixed; otherwise numbers + cause, D432 stays open |
| 46a.5a | **Per-chunk join of 16³ sections (pure, D440 draw half):** one surface buffer pair and one 34³ shader grid a chunk assembled from its sections' results at swap time; a swap names the chunks to replace. | vitest: joined buffers = sections' triangles (counts, positions), crack-free seams test of 45.6 on joined chunks, joined grid = whole-chunk derive | join µs a chunk p50/p95 | equal to the 32³ derive's surfaces and grid |
| 46a.5b | **Adapter chunk view:** `three-adapter/src/voxel-chunk-view.ts` (the page's `chunk-meshes.ts` moved into the adapter so play, export and editor share it): one object a chunk, replaced per swap, floating-origin re-base of draws; the slice page uses it. | `voxel-surface.test.ts`/new adapter vitest; e2e `voxel-world.e2e.ts` blasts still one frame, one swap | render() CPU slice/town vs 4.2 / 13.8 ms; `run.mjs slice --phase blast` frames and main ms (town 8 m vs 200–220 ms) | numbers recorded; D440 draw half fixed when render CPU ≤ the 32³ figures (1.4 / 3.6 ms) ±10 % |
| 46a.6a | **Collision shapes per chunk:** joined sections → one body a chunk; a chunk whose collision is ground only and a height function (no overhang, no boxes) becomes a `heightfield`, else trimesh + boxes (`derived-collision.ts`). | `tools/voxel-bench/collision.test.ts` (real Rapier): drops and sweeps on heightfield = trimesh within 1 cm; overhang chunk stays trimesh | bytes a body heightfield vs trimesh; share of chunks as heightfields (slice, hilly) | D440 collision half fixed |
| 46a.6b | **Collision ring and physics budget (D434):** bodies only within a collision radius of the world's foci (default 48 m horizontal / 24 m vertical, hysteresis, farthest-first removal), physics bytes counted as a part in the one stream budget (`physicsMemoryBytes3D` deltas, a per-body estimate where absent). | `collision.test.ts` + `stream.test.ts` (ring add/remove with a moving focus, budget eviction) | Rapier heap cold / after 160 m flight vs 126 / 172 MB; bodies; add/remove p50/p95 during the flight (churn) | physics inside the budget, heap growth bounded over the flight: D434 fixed (else numbers + cause) |
| 46a.7a | **World host + `ctx.voxels` in the runtime** (boundary commit first: runtime → voxel). Host per `voxelWorld` component (scene load/unload), focus from the component's entity or the camera; `ctx.voxels.get` (`voxelAt` through the overlay; non-resident = `null`, never air), `set`, `dig`, `paint` (material/wetness: shader data only) as stroke commands, `isResident`/`whenResident`, change events after the swap; **guaranteed update path:** an edit in a step is read at once, its mesh, collider and shader data change in one swap. Pool and chunk source injected (ports). | vitest with the real streamer, Node workers (`stream-worker-node.ts`), region files on disk and the real Rapier port: script dig → reads air in the same step, collider gone after the swap, event once | step ms of a 4 m dig; edit → swap ms | API documented in the typings; reference regenerated (`node tools/gen-reference.mjs`) |
| 46a.7b | **Play wiring (game-host):** the world lives with the simulation (worker or single); derive workers started from the sim worker; Play's chunk source = the range route with 46a.4's reads; each swap's per-chunk buffers + grids posted to the page in one transferred message and drawn by the 46a.5b view; colliders in the sim's physics. | e2e `voxel-world.e2e.ts`: Play a test project with a `voxelWorld`, a script digs, pixels change (png.ts), a character falls into the pit, both renderers | edit → visible frames in Play (sim → page hop), sim step ms | Play streams, draws and collides; frames recorded |
| 46a.7c | **Play far out + e2e trim (D444):** Play's voxel draws precise kilometres from the origin (the floating origin's rule for the game view, decided in the item); the Play e2e digs on a readiness signal instead of a fixed 5 s wait. | `voxel-chunk-view.test.ts` (8 km chunk: vertex error, programs); e2e `voxel-world.e2e.ts` Play at 8 km, both renderers | vertex error at 8 km; voxel-world.e2e time vs 36.4 s | D444 closed or what is left recorded |
| 46a.8 | **Saves and the saved-fields mask:** `ctx.voxels.setSavedFields`, `save()` (save file v2 of the overlay) and `restore(bytes, onMismatch)`; the game stores the bytes in its own save (how `ctx.saves` holds binary is checked here; if it cannot, a D-row). | vitest round trip through the host; e2e: Play, dig + wet, save, restart, restore → hole kept, wetness gone | save bytes for 10 / 100 digs | game-owned save round trip on both renderers |
| 46a.9 | **Occupancy (prop lighting) channel in the host:** for props with `affectsLighting`, a `PropShape` from the prop's collider or oriented bounds; per-chunk channel (`propCoverageChunk`) rebuilt on chunk load and prop place/move, joined by `lightCoverage`, counted in the budget, never saved; read via `ctx.voxels.coverageAt` (consumers are 46e). Not rebuilt: what 45.6 built. | vitest: moving a prop rebuilds only the chunks it left and entered; equal to a fresh build; nothing in saves or files | rebuild µs a prop move; channel bytes in the slice ring | channel live in Play |
| 46a.10 | **Editor:** the Scene view draws the world of a `voxelWorld` component through the 46a.5b view (streamed around the editor camera, no collision) and refreshes on `voxelsChanged`; the slice page uses the shared host pieces. D437 if it fits (ambient/hemisphere changes seen by `SkyProbe`). | e2e `voxel-world.e2e.ts`: an edit through the command route shows in the Scene view without reload | Scene view render CPU with the world vs without | world visible and refreshing in the editor; D437 fixed or left open |
| 46a.11 | **Export:** referenced worlds' listed region files as content-addressed buffers (whole files, verified by digest, read through the content closure; no fetch, no URLs), a buffer `RegionByteSource`, the voxel worker bundle `js/voxel-worker.js`; the bundle scan passes. | exporter vitest (closure lists the files, scan); e2e `voxel-world.e2e.ts`: export, served statically with the backend stopped, world draws, a script dig shows | export size added per km² of the test world; cold fill in the export | export plays the world offline |
| 46a.12 | **Measurement and acceptance:** blast frames (R107: 1/2/4/8 m, terrain and town, local and command), render CPU per chunk, physics memory and churn on a flight, streaming at +40 ms, edit → visible in Play and export, both renderers at 720p at the cap; report → `~/.cache/thirdlight-phase46/acceptance/46a`. | staging (`tools/staging.sh`), `run.mjs slice` phases, the e2e hooks | everything in §3, before → after | numbers + causes of misses recorded, pictures looked at |
| 46a.13 | **Docs:** manual pages for voxel worlds and `ctx.voxels` (`docs/manual`), the migration note (`ctx.grid` unchanged until 48a), spec §2.3/§3.6 "not built" lines updated (no format change), `tools/manual-links.test.mjs` green. | docs check, manual links test | — | pages match the built API |
| 46a.14 | **Close (lead):** full gate once (detached), independent review, fixes, acceptance by eye on staging, STATUS row. | full gate | gate time and peak vs 29 min / 8.0 GB; voxel e2e time vs 22.5 s | review in the decision log; owner look pending |

## 6. Progress

| Item | Status |
|---|---|
| 46a.1 | done 59173236: `VOXEL_WORLD_OPS` once in commands; route op list + `tl_command` enum take editVoxels/undoVoxels (no expectedRevision); `voxelsChanged` on the editor feed; reference op pages. Integration: MCP stroke = page's answer and file tags, feed once per change. Fast gate green 11 min; voxel-world.e2e 22.5 → 21.0 s. D433 fixed. |
| 46a.2 | done e48969c5 (+ boundary 1bf03832): `voxelWorld` {world, ring, collision, sectionEdge, savedFields}, metres, unset = voxel defaults (192/224, 96/128, 48/24 m, 16, material/role/shape); model `affectsLighting`; additive on schema 8. Vitest + backend setComponent/restart test. Fast gate green 11 min, 4.9 GB; voxel-world.e2e 21.0 s, inspector.e2e 15.4 s. |
| 46a.3 | done 6ab7d6cb: streamer reads through `VoxelOverlay` (base never written; payloads, aprons, `voxelAt`, worker edits); overrides outlive unload, counted in the budget; `saveChunks(saved)`, `clearOverlay`; default sections 16. stream.test: dig 8 / 4 m 27 section derives, paints 0 mesh derives; ~9.7 B a changed cell. fast gate green 12 min; voxel-world.e2e 21.0 → 21.1 s. |
| 46a.4 | done c93ae33b: reads in whole columns + row neighbours to the hysteresis, 16 KB gap, 8 reads, held decodes, ring kept 1 s ahead of motion. stream-page +40 ms, 80 m/s, both renderers ×3: near holes 0 (was p50 761 / p95 1,148), ~39 req/s, 16.1–16.5 MB (1.4× of 11.8). D432 fixed. Fast gate green 11 min; voxel-world.e2e 21.1 → 26.7 s (load 7–8). |
| 46a.5a | done 23e5e1ee: `joinSections` (chunk-join.ts) joins a chunk's 16³ results into one ground + base surface, instances and a 34³ grid equal to the whole-chunk derive; swaps name their chunks, `chunk` events, `joinedChunk` on demand. Join p50/p95 slice 285/587 µs, town 312/686 µs (grid ~90 %). Fast gate green 12 min; voxel-world.e2e 26.7 → 19.8 s (load 9 → 2). |
| 46a.5b | done e317f7b0 (+ 9d22034d boundary, 87c50d84): adapter `VoxelChunkView`, one draw a chunk from joined sections, grid entries straight to upload; page uses it. render() CPU 16³ slice 1.4–1.6 / town 4.0 ms (was 4.2 / 13.8; same-hour 32³ 1.6 / 3.9–4.0): D440 draw half fixed. Town 8 m blast main ~180–220 ms (bodies a section, 46a.6a). D441 fixed, D442 open. voxel-world.e2e 19.8 → 21.3 s. |
| 46a.6a | done 325206fc, 70176c6b: one Rapier body a 32³ chunk from its joined 16³ sections, built from the draw's join in the same task and frame; ground alone, facing up, within 5 mm of a lattice heightfield → heightfield. Share slice/hilly 0 %, town 24 %; 4.3 vs 37.5 KB a body. Town 8 m blast main 50–104 ms (was 180–220). D440 fixed, D443 opened. voxel-world.e2e 21.3 → 19.0 s. |
| 46a.6b | done df6e67b0: `CollisionRing` (voxel): bodies only within 48/24 m of the foci (box distance, 8 m hysteresis, in nearest first in 4 ms, out farthest first), each the chunk's `collision` part at Rapier's heap estimate. Heap cold / after 4 flights: slice 14 / 19.4 MB (was 131 / 172; 53–58 bodies of 493), town 6–7 / 14.6 MB (was 174). D434 fixed. voxel-world.e2e 19.0 → 17.3 s. |
| 46a.7a | done 327a806b (+ d6744249 boundary, 6dccf2b9): `RuntimeVoxels` + `VoxelWorldHost` a `voxelWorld`, ports injected; `ctx.voxels` get (null off-ring), set/dig/paint read at once, body/mesh/shader in one swap, `changes`, `whenResident` → `waits`. Node 4 m dig: step 3.5–6.1 ms (first 17–19), edit → change 8–16 ms. Fast gate green; voxel-world.e2e 17.3 → 17.7 s. |
| 46a.7b | done 41f8fb70 (+ 0d309961, 4cfafdf1): world runs with the sim (worker, or page), Play reads the locator's range route, derive workers started in the sim worker; one transferred batch a streamer task drawn by `VoxelWorldDraws`; bodies wait for voxel collision. Edit → screen 16–17 ms (1 / 2 frames) worker / single. voxel-world.e2e 17.7 → 36.4 s. D444 opened, D445 fixed. |
| 46a.7c | done 73ea05cf: voxel surface and pieces placed with a 64-bit camera-relative model-view per draw (no re-base needed): 8 km vertex error 1.3 µm vs 0.56 mm; Play e2e plays the world 8 km out on both renderers. Dig on a debug command, not a 5 s wait: voxel-world.e2e 36.4 → 24.5 s. D444 fixed, D446 opened (other objects far out). |
| 46a.8 | done eb0dc688: `ctx.voxels.setSavedFields`, `save()` (save file v2, answered later as bytes + base64 text), `restore(bytes\|text, 'save'\|'base')` into the overlay, never the base (unloaded chunks' entries land with them), mismatches reported. Save of 10 / 100 1 m digs: 1.8 / 17.7 KB. Play e2e saves, restarts, restores (both renderers). voxel-world.e2e 24.5 → 26.6 s. D447 opened. |
| 46a.9 | done b6dcb2c6: `PropLightChannel` per resident chunk, built on load; a step's prop changes rebuild only chunks left/entered; budget part; shapes from colliders else model bounds; `ctx.voxels.coverageAt`. Move 1.8–2.0 ms p50; slice ring 0/4.5/13.5 MB at 0/100/1,600 lit props. D448 opened. Fast gate green (rerun); voxel-world.e2e 26.6 → 32.0 s, no e2e change, load 6–9. |
| 46a.10 | done f4f530a4 (+ f305e979 boundary): Scene view streams a `voxelWorld` world round its orbit target in a worker (Play's batches, `VoxelWorldDraws`), reads `voxelsChanged`; command-route dig shown without reload (e2e, pictures looked at). render() CPU 2.1–2.9 / 0.5–0.6 ms p50 with / without (225 chunks). D449 fixed, D437 open. voxel-world.e2e 32.0 → 38.6 s. |
| 46a.11 | not started |
| 46a.12 | not started |
| 46a.13 | not started |
| 46a.14 | not started |

## 7. Results

(Filled per item: numbers, rounds, uptime, report paths.)

**46a.1** (59173236). No perf item. `tests/integration/voxel-world/voxel-world.test.ts` gained one test on a second
world (`feed`), so the first world's revision counts stay: the real MCP adapter (in-memory transport) and a registered
editor WebSocket against a real backend; MCP's dig answers the page's cells, chunks, box, parts and file tags exactly
(same bytes written), its undo restores the world, a resent request id answers once and sends no event, every applied
change arrives once as `voxelsChanged` with its origin (null for the page's origin-less sends, mcp, browser). Fast gate
(gate-fast-20261102-202435): GREEN, 11 min, 4.8 GB peak; `voxel-world.e2e.ts` 22.5 → 21.0 s (10.0 + 5.3 + 5.7 s; no e2e
change); vitest `scan-bounded-log.test.ts` timed out once and passed alone (D418 watch, noted).

**46a.3** (6ab7d6cb). `VoxelStreamer` keeps the base in its store (written only by loads and refreshes) and runtime
edits in `streamer.overlay`; derive jobs read a view of the overlay over the base (`stream-sections.ts` `DeriveView`;
`stream-overlay.ts`: a chunk with overrides is sent as the base's arrays copied with only its overridden cells
written; `chunkForm` says `stored` for such a chunk so aprons read it cell by cell). `editInWorker` sends merged
chunks and keeps the cells that differ from the base. Overrides are not chunk content: an edited chunk is not dirty,
unloads like any other and gets its overrides back on reload; `bytes.overlay` is in the budget total and never
evicted. `saveChunks(saved = DEFAULT_SAVED_FIELDS)` (async) gives save entries against the files' base, reading the
base of a chunk that left from the source again (worker `load`), entries taken in one task; `clearOverlay()` drops all
and rebuilds the cells that change back in one swap group. Engine default `sectionEdge` = `DEFAULT_SECTION_EDGE` (16)
with assembly rules whose radius fits, else the chunk edge; the slice page imports the constant.
Test (`stream.test.ts`, 4 real workers, region files on disk, 16³ sections, focus at the ground): base equal to the
files after every edit; every section near the edits equal to a fresh in-thread derive of the streamer's own merged
view and of an independently edited oracle, before and after a trip away (every edited chunk unloaded) and back;
saves equal away and back; the only-rained chunk gives no entry with the default mask and one with wetness saved.
Numbers (Node, in-test; load average ~7–8 from other users of the host):

| Edit | Cells | Chunks | Section derives (mesh) | Shader-only derives | Edit → swap ms | Overlay after (cells / chunks / bytes) |
|---|---|---|---|---|---|---|
| dig 1.5 m at a 4-chunk corner | 100 | 4 | 8 | 0 | 28–36 | 100 / 4 / 768 |
| dig 4 m | 1,296 | 2 | 27 | 0 | 25–33 | 1,396 / 5 / 13,632 |
| material paint 7×3×7 | 147 | 1 | 0 | 4 | 3.7–6.3 | 1,543 / 5 / 14,976 |
| wetness paint, same cells | 147 | 1 | 0 | 4 | 2.2–2.3 | 1,543 / 5 / 14,976 |
| rain, one cell | 1 | 1 | 0 | 1 | 1.6–2.0 | 1,544 / 6 / 15,024 |

Overlay arrays: 6 B a changed cell at full capacity, 9.7 B measured (capacity doubles), about 2.5 KB a changed chunk
here. The first dig's swap includes worker warm-up. Fast gate (gate-fast-20261102-212251): RED on load timeouts
(`stream.test.ts` 16³ test and the new test at vitest's 5 s, D418, D311) → the new scenario test gets its own 30 s
timeout (4 s alone); rerun RED on D417 (`start.e2e.ts` stop exit 1), rerun GREEN (perf at the cap 0 missed both
renderers). Final fast gate after bounding `clearOverlay`'s rebuild to the overridden cells (gate-fast-20261102-214254): GREEN,
12 min, 4.8 GB peak, perf at the cap 0 missed on both renderers.
`voxel-world.e2e.ts` 21.0 → 21.1 s in the final gate (10.2 + 5.2 + 5.7 s; 26.1 s in the first rerun before
`clearOverlay` was bounded, 22.1 s alone at load average 7.5): the commands path is unchanged; local edits now go
to the overlay and `reread` clears it. No stored format changed (staging slice world not regenerated).

**46a.4** (c93ae33b). Reads (`stream-reads.ts`, `voxel-streamer.ts`, `region-source.ts`): the read list is built
column by column around the focus and a lead point (velocity smoothed over 0.25 s, 1 s ahead, capped at the near
radius; a jump resets it), a column's chunks together, columns nearest the lead point first; a batch (64 chunks) ends
between columns and adds the neighbouring columns along the source's `rowAxis` (z for region files: `lx * side + lz`)
as far as the ring's hysteresis (2 columns), so ground about to be reached comes in the same range; chunks stay while
inside the unload bounds of the focus or the lead point; `REGION_READ_GAP_BYTES` 16 KB (was 4 KB);
`DEFAULT_STREAM_READS` 8 (was 4); a read stored chunk waits for pool room (`held`) instead of reads stopping at the
pool's room counted over air and uniform chunks too. Vitest: `stream.test.ts` ring at a region corner with a 4-job
pool queue: 69 stored chunks in 38 columns read in 8 chunk requests (one a chunk: 69), 238 KB fetched of 188 KB,
equal to the oracle, no re-reads; `stream-core.test.ts` read order = the ring, columns whole and in order, lead side
first, lead 98–100 % of 1 s of steady motion, jump and pause reset.
Browser (`run.mjs stream-page --rounds 3 --speeds 80 --no-trace`, hilly 2 × 2 km world regenerated into
`~/.cache/thirdlight-phase46/work/46a.4/`, Chrome 151, Iris Xe, 1280×720 at the 60 Hz cap, 4 workers; 2026-11-02
22:08–22:20, load 2.8 / 5.6 / 9.7 at the rounds' starts, uptime 10 days 5 h). Report
`~/.cache/thirdlight-phase46/work/46a.4/stream-page/stream-page.md` (scratch).

| Run (3 rounds) | Frame p95 / missed | Main ms a frame | update ms p50 / p95 | Range requests (/s) / p50 / p95 ms / MB | Near holes p50 / p95 / max (of 1,344) | Stream MB |
|---|---|---|---|---|---|---|
| 45.5b WebGPU 80, localhost | 16.67 / ≤ 1 | 2.83–2.89 | 1.68–1.75 / 2.40 | 7,290 (122) / 11 / 21 / 11.8 | 0 | 10.3 |
| 45.5b WebGPU 80, +40 ms | 16.67 / 0 | 1.55 | 0.04 / 2.29 | 3,179 (53) / 280 / 737 / 6.6 | 761 / 1,148 / – | 7.7 |
| WebGPU 80, localhost | 16.67 / 0, 1, 0 | 3.09–3.26 | 2.07–2.11 / 2.43–2.49 | 2,345–2,362 (39) / 5.4–5.6 / 11–12 / 16.1–16.4 | 0 / 0 / 0 | 13.1–13.2 |
| WebGL 2 80, localhost | 16.67 / 1, 1, 0 | 3.04–4.35 | 2.08–2.22 / 2.46–3.08 | 2,338–2,363 (39) / 5.2–7.4 / 10–19 / 16.1–16.5 | 0 / 0 / 0 | 13.1–13.2 |
| WebGPU 80, +40 ms | 16.67 / 1, 1, 0 | 2.65–4.34 | 1.33–2.17 / 2.98–4.41 | 2,337–2,351 (39) / 85–87 / 214–220 / 16.3–16.5 | 0 / 0 / 0 | 13.0 |
| WebGL 2 80, +40 ms | 16.67 / 0, 1, 0 | 2.51–3.66 | 1.18–2.11 / 2.70–4.12 | 2,346–2,363 (39) / 85–86 / 212–220 / 16.1–16.4 | 0 / 0 / 0 | 13.0 |

- **D432 fixed:** 0 chunks missing within 96 m at +40 ms on both renderers in all 3 rounds, at 1.4× the bytes of the
  45.5b localhost figure (16.1–16.5 vs 11.8 MB; the 64 KB gap's 106 MB was 9×). Requests per second fell 3× even on
  localhost (122 → 39 a second), so about 4 stored chunks a request instead of 1.4.
- **Costs:** the ring holds the lead point's crescent and the row neighbours: 5,964 resident chunks (was 5,436),
  stream 13.0–13.2 MB (was 10.3) of 256 MiB; more bytes because the row neighbours and the crescent are read before
  the ring needs them, and at the loop's corners some are dropped before the ring reaches them. `update()` p50 1.7 → 2.1 ms, p95
  2.4 → 2.4–4.4 ms (derive aprons for the larger ring, capped at 2 ms, and rebuilding the read list when the lead
  point crosses a chunk); main thread 2.8 → 2.5–4.4 ms a frame. Missed frames: ≤ 1 a run as in 45.5b (the first draw
  after the cold fill; one 50 ms frame in round 2 WebGL 2 +40 ms at load 5.6). Cold fill 1.3–2.1 s localhost,
  1.9 s at +40 ms.
- Fast gate (gate-fast-20261102-222621): GREEN, 11 min, 4.3 GB peak, village perf at the cap 0 missed on both
  renderers; vitest `scan-bounded-log.test.ts` timed out once and passed alone (D418 watch). `voxel-world.e2e.ts`
  21.1 → 26.7 s (12.3 + 6.8 + 7.6 s; the assembly-proof test 10.2 → 12.3 s) with the host at load 7–8 from other
  users; not isolated whether the load or the larger ring (crescent + row neighbours) costs it (unverified).
- Not measured: HTTP/2 (the bench server speaks HTTP/1.1; Chrome then holds six connections a host, which the
  8 reads keep busy); other speeds; the slice page on staging (it streams from the backend's range route on
  localhost with the same defaults).

**46a.5a** (23e5e1ee). `chunk-join.ts` (`joinSections`, `joinSurfaces`, `joinInstances`, `joinShader`): a chunk's
section results joined into one ground and one base surface buffer (concatenated in section id order, positions moved
to the chunk's corner by whole cell steps, indices offset), one instance list and one 34³ shader grid (each grid
cell from the section holding it, palette rebuilt in grid order). The streamer: `joinedChunk(cx, cy, cz)` joins each
section's newest committed result (a section waiting in an open group gives the result drawn before it), timed into
`streamer.joinUs`; `SwapReport.chunks` names the storage chunks a swap replaces, and a `chunk` event (`shaderOnly`
when only shader data changed) goes out for every chunk whose sections took new results in one task, just before
the `swap` (or after one job's answer while streaming). The slice page still draws per section and ignores `chunk`.
Tests: `derived.test.ts` (16³ and 8³, hilly, town and the wall-beam-banister scene: triangles with positions and
normals, instances and `encodeShader` bytes equal to the whole-chunk derive; the 45.6 seam test on joined chunks,
every inner edge two triangles across section and chunk faces; a broken grid copy fails it, checked once by hand);
`stream.test.ts` (4 real workers, region files: joins after the cold fill and of every chunk a 16³ and 8³ blast's
swap names equal whole-chunk derives of the oracle; the swap's `chunks` = the chunks of its sections, each announced
once before it; a dig announces geometry, a paint shader only).
Join cost (`node tools/voxel-bench/run.mjs join`, Node 22, i5-12600H, in-thread derives, 16³, 3 joins a chunk, the
first reported as cold; 2026-11-02 22:50, load 9.9 / 7.2 / 6.4, uptime 10 d 6.4 h; report
`~/.cache/thirdlight-phase46/work/46a.5a/join.md`, scratch):

| World | Chunks joined (all with a grid) | Join µs p50 / p95 / max | Cold p50 / p95 | Cold surfaces / grid µs p50 | Extra vertices | Mismatches |
|---|---|---|---|---|---|---|
| slice (±192 cells of the scene) | 324 | 285 / 587 / 3,171 | 300 / 575 | 23 / 277 | +6.1 % | 0 |
| town (256 m) | 834 | 312 / 686 / 2,983 | 328 / 704 | 26 / 292 | +1.2 % | 0 |

- About nine tenths of a join is the shader grid (expand 8 section grids, copy, palette pass, pack); the surfaces
  are 23–26 µs. The renderer expands the packed grid again to upload it, so 46a.5b can take the joined u16 cells
  directly and skip a pack and an expand. A big town blast replacing 8–18 chunks costs ~3–6 ms of joins on the
  main thread against the 200–220 ms of replacing 48–64 per-section objects measured in 45.10c.
- Fast gate (gate-fast-20261102-225350): GREEN, 12 min, 4.3 GB peak, village perf at the cap 0 missed on both
  renderers. `voxel-world.e2e.ts` 26.7 → 19.8 s (9.0 + 5.2 + 5.6 s; no e2e change; load 9.1 at the start, 2.4 at
  the end, uptime 10 d 6.5 h): 46a.4's 26.7 s was host load, not the larger ring.

**46a.5b** (9d22034d boundary: three-adapter → voxel; e317f7b0 view; 87c50d84 e2e/bench; 564a0625 D441). The slice
page's per-section meshes moved into `three-adapter/src/voxel-chunk-view.ts`: `VoxelChunkView` draws one group a 32³
storage chunk (ground and base in one mesh, so one surface draw; one instanced mesh a piece family), matrices made
when placed and after a re-base (`matrixAutoUpdate` off); `feedVoxelChunkView` joins a chunk on each `chunk` event
(`streamer.joinedChunk(cx, cy, cz, times, cells)`: the shader grid's entries written straight into the view's upload
array, `joinShaderCells`, no palette pack and expand; the solid test reads the sections' palettes), replaces its draw
(only the grid on `shaderOnly`), removes it on `unloaded` and counts its bytes as the chunk's `mesh` part. Colliders
stay per section (46a.6a). The blast hook reports `replacedChunks`; the e2e checks they are the swap's chunks, in
the same frame and swap as the sections' bodies (my first check, chunks < sections, was wrong: a corner of eight
chunks has one section in each). Tests: `voxel-chunk-view.test.ts` (16³ joins of a sloped ground + wall + beam +
banister scene: one surface mesh with the whole-chunk derive's triangles, its pieces, the grid uploaded with the
whole-chunk entries or the solid entry passed; a paint uploads only the grid; a 600 m re-base re-places every chunk;
the feed replaces chunks in the announcing task). A grid copy broken on purpose failed it (checked once by hand).
Blast benchmark (`run.mjs slice --phase blast --sections 16,32 --repeats 2 --seconds 10`, staging, headless Chrome,
Iris Xe, 1280×720 at the 60 Hz cap, 4 workers, one round; 23:33–23:37, load 1.6–2.0, uptime 10 d 7.1 h; report
`~/.cache/thirdlight-phase46/work/46a.5b/blast/`, scratch). Orbit render() CPU p50 / p95, ms:

| World | 45.10c 32³ (a section an object) | 45.10c 16³ | 16³ chunk view | 32³ chunk view, same hour | Drawn (was 32³) |
|---|---|---|---|---|---|
| slice WebGPU / WebGL 2 | 1.4 / 1.3 | 4.2 / 4.2 | 1.6 / 1.4 (p95 2.4 / 2.2) | 1.6 / 1.6 | 493 (448) |
| town WebGPU / WebGL 2 | 3.6 / 3.5 | 13.8 / 13.3 | 4.0 / 4.0 (p95 4.5 / 4.7) | 3.9 / 4.0 | 950 (912) |

- **D440 draw half fixed**: at 16³ the render CPU equals the same-hour 32³ run (both one object a chunk); against
  the 45.10c figures +0–14 %, with 4–10 % more chunks drawn (46a.4's ring keeps the lead point's crescent) and the
  browser's 0.1 ms timer. Orbit 0 missed frames on both renderers and worlds.
- **Blasts, 16³ local** (frames edit → shown; main = apron/payload ms + page build ms): terrain 1–4 m 1 frame, 8 m 2
  (main 22–40 ms); town 1–4 m 1 frame (was 1–2) with build ~40 ms, town corner 8 m 2–3 frames (was 3), main
  ~205–230 ms (was 220), middle 8 m 3 (was 4–5), ~195 ms. Every blast's own swap atomic (bodies and draws,
  one frame); in 3 of 4 terrain runs the first recorded blast's window also caught the whole world re-derived after
  the warm-up's `reread` (D442, open, cause not isolated). The town 8 m main thread is the 48–64 per-section Rapier bodies: at 32³ (8–18 bodies) the same blast
  builds in 45–98 ms through the same view, so it goes with D440's collision half (46a.6a). First blast of a page
  pays 90–310 ms once (first use).
- Edit → visible (measure phase, commands, 10 dabs): 47–65 ms WebGPU, 48–65 ms WebGL 2 (was 65 / 64).
- Pictures looked at: `measure/before-webgpu.png` (ground, wall, beam, banister rail and posts) and
  `measure/after-webgl2.png` (dabs and pits in the ground and wall, pieces) draw as before; WebGPU after and WebGL 2
  before not opened.
- Fast gate (gate-fast-20261102-232008): RED on the wrong e2e check above, fixed; rerun (gate-rerun-20261102-233055)
  GREEN, village perf at the cap 0 missed on both renderers. `voxel-world.e2e.ts` 19.8 → 21.3 s (8.9 + 6.1 + 6.3 s;
  load 4.3 at the start, uptime 10 d 6.9 h).
- D441 fixed (564a0625): the 16³/8³ sections test's swap wait calls `update()` each turn; passes alone (3.7 s) and in
  the file.

**46a.6a** (325206fc, 70176c6b). Bodies per storage chunk: `joinSections`/`joinSectionsForDraw` also join the
sections' collision boxes (`joinCollision`: moved to the chunk, full-cell merges first; not merged again across
section faces), the chunk view's replaced report hands the page the join it drew from, and the page's
`VoxelCollision` builds one body a chunk from it in the same task (`?heightfields=0` keeps all ground as meshes);
an unloaded chunk's body goes with its draw. `collisionGeometry` takes any `{edge, collision, ground}` and makes the
ground a heightfield (`ground-heightfield.ts`) when the chunk has no boxes, no triangle faces down, every lattice
node of the footprint lies under one height of the chunk's own ground (a face whose nodes lie under the neighbour's
shared vertices starts one node in; the triangles not wholly over the field stay a mesh) and the largest vertical
distance between field and triangles, checked at every vertex of their overlay, is ≤ 5 mm. The port splits a cell
the other way, so the field is handed over turned a quarter about +y. The e2e blast check now counts bodies a chunk:
the swap's chunks' bodies and draws replaced in one frame and one swap.
Tests (`collision.test.ts`, real derive + real Rapier 0.12.0): the scene's drops and sweeps (ground, wall top, beam,
rail, between posts, the pit) now on joined 16³ sections; a bumpy lattice ground (every cell bent across its
diagonal; once with a face's nodes under no triangle, the strip a mesh): thin rays < 1 mm and capsule drops < 1 cm
from the mesh; the town (lots 1–5): every heightfield equals the whole-chunk derive's, rays, slanted sphere sweeps
and drops over and across 5+ heightfield chunks within 1 cm of the meshes; a ledge (faces down), ground leaving the
chunk's top (uncovered) and a wall (boxes) stay meshes. Sphere sweeps on a bumpy heightfield do not agree (D443).
Node bench (`run.mjs collision`, 16³ joined, all bodies into one real Rapier world a test world; 2026-11-03 00:00
and 00:17, load 3–5, uptime 10 d 7.6 h; report `~/.cache/thirdlight-phase46/work/46a.6a/collision-{hf,mesh}.md`):

| World | Bodies | Heightfields (face strip) | Meshes: why | KB a body to physics: hf / same as mesh | WASM heap: all meshes → with heightfields |
|---|---|---|---|---|---|
| slice (±192 cells of the scene) | 324 | 0 | facing 144, deviation 103, uncovered 73, boxes 4 | – / 37.5 | 88 MB (279 KB a body) |
| hilly (±192 cells) | 327 | 0 | facing 144, deviation 104, uncovered 79 | – / 37.5 | 88 MB (275 KB a body) |
| town (256 m) | 834 | 197 (28) | facing 287, boxes 229, uncovered 63, deviation 30, layers 28 | 4.3 / 37.5 | 192 → 140 MB (236 → 172 KB a body) |

- **Why so few heightfields:** the surface nets put a vertex off the cell-corner lattice wherever a contour crosses
  a sample layer, so every slope lies 1.0–2.6 cm from a lattice heightfield (over the 5 mm tolerance); "facing" is
  mostly the world's ground bottom at −128 cells; "uncovered" is ground leaving a chunk through its top or bottom.
  Only level ground (the town's lots and streets) qualifies. A first version took the level ground bottom as a
  heightfield (it collides from above) and counted 44 % on the slice; 70176c6b refuses ground facing down.
- **Blast** (`run.mjs slice --phase blast --sections 16 --repeats 2 --seconds 10`, staging, headless Chrome, Iris Xe,
  1280×720 at the 60 Hz cap, 4 workers; terrain 00:14–00:15 load 2.0, town 00:18–00:19 load 5.3 → 3.3 (second round
  after the facing fix), uptime 10 d 7.8 h; report `~/.cache/thirdlight-phase46/work/46a.6a/blast{,2}/`, scratch).
  Page main-thread build ms (draws + bodies) and frames edit → shown, both renderers:

| Blast | 46a.5b (a body a section) | Now (a body a chunk) |
|---|---|---|
| town corner 8 m (8 chunks) | ~205–230 ms, 2–3 frames | 50–54 ms, 2–3 frames (local), 4–5 (command) |
| town middle 8 m (18 chunks) | ~195 ms, 3 frames | 85–104 ms, 2–3 frames (longest frame 67–100 ms) |
| town 1 m corner / middle | build ~40 ms | 46–79 / 6–11 ms, 1 frame |
| terrain 8 m corner / middle | 2 frames, main 22–40 ms | 13–15 / 26–28 ms, 2 frames, 0 missed |

  The town's per-body cost is its boxes: 46,105 colliders in 950 bodies (each box is a collider of the compound),
  ~6 ms a house chunk; 8 corner chunks cost ~46 ms even for a 1 m dab (1 missed frame). Every blast's bodies and
  draws: one frame, one swap. Orbit 0 missed, render() CPU slice 1.4–1.5 / town 3.7–3.9 ms p50.
- **Rapier heap (for D434, 46a.6b):** page after the cold fill: slice 131 MB (493 bodies, 883 colliders, 0
  heightfields, 18.5 MB handed to physics), town 174 MB (950 bodies, 197 heightfields, 23.7 MB handed). The town's
  stream total reached 249.6 of 256 MiB (derived parts 247 MB) at the cold fill.
- D442 seen again on the terrain world (both renderers): the first local blast after the warm-up's `reread` caught
  486–520 chunks replaced over ~37 frames in swaps 2–3; the town and later blasts did not.
- Fast gate (gate-fast-20261103-000056, then gate-fast-20261103-001935 after the fix): GREEN, 11 min, 4.4 / 4.3 GB
  peak, village perf at the cap 0 missed on both renderers. `voxel-world.e2e.ts` 21.3 → 19.1 / 19.0 s (8.6 + 4.9 +
  5.5 s; load 4.5 at the start, uptime 10 d 7.8 h).

**46a.6b** (df6e67b0). `collision-ring.ts` (`CollisionRing`, pure): a resident chunk gets a body while its box is
nearer than the collision radius (horizontal) and height (vertical) to a focus, and keeps it until past those plus
`COLLISION_RING_HYSTERESIS_CELLS` (16, 8 m) for every focus. Inside the ring the body follows the draw (`changed`
from the `chunk` event, same task, so an edit's swap stays atomic for bodies); `update()` removes leavers farthest
first, then adds resident entrants nearest first within `COLLISION_ADD_MS_PER_UPDATE` (4 ms, at least one body a
call); `unloaded` drops the body with the chunk. Each body is the chunk's `collision` part (`COLLISION_PART`): the
geometry the page keeps for re-bases plus `estimateStaticBodyBytes3D` (physics-rapier `memory3d.ts`: 0.9 KB a body,
0.7 KB a primitive, mesh 1.3 KB + 140 B a triangle, heightfield 1 KB + 5 B a node, hull 0.75 KB + 230 B a point).
The page keeps the ring around its target (`PageCollisionRing`; `?collisionRing=0` gives every resident chunk a body).
Tests: `memory3d.test.ts` (estimate within 0.8–1.25× of the real heap's growth over 8 MB batches of meshes,
heightfields, box compounds and hulls; six remove/re-add rounds grow it at most once); `collision.test.ts` (in-memory
hilly strip, real Rapier: every body within the keep bounds, every chunk within the add bounds with geometry has one,
parts = ring = port bytes, removals farthest first, ±4 m across a chunk edge adds and removes nothing, three 416 m
round trips: ≤ 33 bodies at once (23 first), 896 adds, heap after trip 3 within 2 pages of trip 1; a capsule lands
by the focus and falls 100 m behind it); `stream.test.ts` (real workers, region files, real Rapier: a focus moving
64 m, all bodies off takes exactly their bytes off the budget, a dig's ring chunks replaced in its swap's task,
evictions at a quarter and below the ring's own bytes take bodies with their chunks, budget held). That last test
found the streamer announces `unloaded` before it forgets the chunk, so clearing the part there subtracted it twice
(after evictions the bodies' 7.3 MB exceeded the whole derived total of 2.9 MB); the ring now leaves an unloaded chunk's parts to the streamer.
Flight (`run.mjs slice --phase fly`, staging, headless Chrome, Iris Xe, 1280×720 at the 60 Hz cap, 4 workers; slice at
0,103,−32, town at 256,0,256; 2026-11-03 00:54–01:10, load 4.5–11 from other users, uptime 10 d 8.5 h; reports
`~/.cache/thirdlight-phase46/work/46a.6b/fly{,2}/`, scratch):

| Run | Bodies cold → after | Counted (MB) | Rapier heap cold → after each trip (MB) | Add ms p50 / p95 | Remove ms p50 / p95 | Ring update ms p50 / p95 | Frames missed |
|---|---|---|---|---|---|---|---|
| 45.9 slice, a body a section | 448 | 16.6 (geometry) | 126 → 172 | 2.2 / 4.0 | 0.2 / 0.9 | – | 0 |
| slice WebGPU / WebGL 2, ring | 53 → 58 | 15.2 → 17.4 | 14.6 → 19.9 / 14.6 → 20.0 | 2.9 / 4.8, 2.2 / 4.6 | 0.1 / 0.2 | 3.8 / 6.1, 2.7 / 5.7 | 0 / 0 |
| slice WebGPU, ring, 4 trips | 53 → 58 | 15.2 → 17.4 | 14.1 → 18.9, 19.3, 19.4, 19.4 | 3.0 / 4.5 | 0.1 / 0.2 | 3.7 / 5.7 | 1 (33 ms) |
| slice WebGPU, every chunk (same hour) | 493 → 517 | 157 → 174 | 131 → 152 | 2.3 / 4.1 | 0.1 / 0.3 | – | 2 |
| town WebGPU / WebGL 2, ring (46a.6a: 950 bodies, 174 MB) | 77 → 87 | 7.0 → 7.7 | 6.4 → 15.0 / 7.1 → 14.7 | 1.2 / 4.1, 1.2 / 3.9 | 0.9 / 1.4, 0.8 / 1.3 | 4.0 / 7.8, 3.5 / 8.2 | 0 / 0 |
| town WebGPU, ring, 4 trips | 73 → 87 | 6.4 → 7.7 | 5.8 → 14.6, 14.6, 14.6, 14.6 | 1.2 / 3.8 | 0.8 / 1.3 | 3.6 / 7.3 | 2 (33 ms) |

- **D434 fixed:** bodies are bounded by the ring (53–87 instead of 448–950), counted in the budget at their heap
  cost, and the heap stops growing after the first trip (slice 19.4 MB after trips 3 and 4, town 14.6 MB after each).
  The estimate agrees with the heap: slice cold 13.4 MB estimated above the 1.2 MB of an empty world, 12.8 MB measured.
  Stream total with bodies: slice 127 MB, town 235 MB of 256 MiB; every chunk with a body counted fills the slice's
  budget to 265 MB (eviction would start).
- **Not counted:** the heap's high-water above the live bodies (slice ~5 MB, town ~8 MB: freed bodies' room kept
  for the next ones and the larger arena), bounded by the ring, not by the budget.
- Ring update p95 5.7–8.2 ms is one body over the 4 ms slice (one is always added); the town's box compounds
  (8,504 colliders in 87 bodies) cost 0.8–0.9 ms a removal. Missed frames: 0 on single trips; 1–2 frames of 33 ms in
  the 4-trip runs (load 9–11).
- Fast gate (gate-fast-20261103-011044): GREEN, 11 min, 5.3 GB peak, village perf at the cap 0 missed on both
  renderers. `voxel-world.e2e.ts` 19.0 → 17.3 s (8.0 + 4.5 + 4.8 s; load 6.7 at the start, uptime 10 d 8.7 h; no e2e
  change: the scene's blasts and drops lie inside the ring around the camera's target).

**46a.7a** (d6744249 boundary: runtime → voxel; 327a806b host and `ctx.voxels`; 6dccf2b9 graph API). `voxel-worlds.ts`
(`RuntimeVoxels`, owned by `RuntimeEntities`: an object with `voxelWorld` brings its world on attach, the last one
leaving disposes it) and `voxel-world-host.ts` (`VoxelWorldHost`: streamer with `PLACEHOLDER_RULES`, the component's
ring/collision/section edge in cells, `CollisionRing` over `PortBodies` in the runtime's physics port, world
coordinates). Ports injected through `instantiateRuntime({ voxels: { open(world) } })` → `{grid, source, pool,
budgetBytes?, close?}`; without them worlds read null. `ctx.voxels` (`voxel-api.ts`, metres): `get`, `set`, `dig`,
`paint`, `isResident`, `whenResident` (answered in `waits`), `changes`, `worlds()`, `world(name)`. Edits are exact
`set`/`dig` commands on the region's cells, applied on the step's thread; `paint` is one set per resulting voxel, all
in one task (one swap, one change). Chunk body parts moved to `collisionBodyParts` (voxel; the page uses it);
`PhysicsPort3D.staticBodyBytes?` (Rapier: `estimateStaticBodyBytes3D`).
Test `tools/voxel-bench/world-host.test.ts` (real runtime, hilly 128 m region files on disk, 2 `worker_threads`
workers a world, real Rapier port): resident wait answered; far `get` null and `dig` refused `not_resident`; a 4 m dig
reads air in the same step, the body under it unchanged until the swap and ≥ 2.5 m lower after it, the change reported
once with chunk boxes inside the rules' reach including the dug chunk; a `set` reads back at once; wetness paint reads
at once, reported `shaderOnly`, collider count and ground unchanged; world b (scene loaded later, same files) reads
none of a's changes and a none of b's; unloading b closes its pool and source, removes its bodies (body count back),
answers its wait `false`; `dispose` closes a. Node numbers (i5-12600H, load ~3, uptime 10 d 9.2 h, 2 runs):

| 4 m dig (radius 2 m, ~270 cells) | Step ms (overlay apply + edit job build) | Edit → change seen by the next step |
|---|---|---|
| first edit of the run | 16.6–18.7 | 41–66 ms |
| next three | 3.5–6.1 | 7.6–16.3 ms |

The first edit pays JIT and worker warm-up; the step cost is mostly building the rebuilt sections' aprons and
payloads on the step's thread (`editDeriveMsPerUpdate`, 8 ms cap). No browser or Play wiring (46a.7b).
Fast gate (gate-fast-20261103-014523, + voxel-world, scene-loads, script-api, play-export e2e): RED in vitest on two
stale expectations this item made wrong (`tests/m2-physics/physics-boundary.test.ts` listed runtime's dependencies
without the new voxel edge; `tools/gen-behavior-graph-api` could not type the region calls), fixed in 6dccf2b9;
rerun (gate-rerun-20261103-015632) GREEN, 4 min, 4.4 GB peak, village perf at the cap 0 missed on both renderers.
`voxel-world.e2e.ts` 17.3 → 17.7 s (8.1 + 4.6 + 5.0 s; no e2e change; load 4.8 at the end, uptime 10 d 9.6 h).
Once, in an ad-hoc parallel vitest run, `stream.test.ts` 'rebuilds every derived result within R …' failed and
passed alone and in two later runs (load, not reproduced; the full gate's first vitest pass had it green).

**46a.7b** (0d309961 boundary: game-host → voxel; 41f8fb70 Play wiring; 4cfafdf1 D445). Where things are: `@thirdlight/voxel` `chunk-batch.ts` (`ChunkDrawBatcher`: a world's `chunk`,
`unloaded` and `swap` events of one streamer task collected and sent at the task's end (a microtask) as one
`ChunkDrawBatch`: per chunk `draw` (ground, base, pieces, grid entries or the solid entry), `shader` (a chunk already
sent whose shader data alone changed) or `remove`, plus the swaps' measures; buffers made by the join, so a worker
transfers them (`chunkDrawBatchTransfer`; whole-chunk sections' own buffers are copied first); `MESH_PART` defined
here). `game-host/voxel-play.ts` (`presentVoxelWorlds`) wraps the play's world ports: the runtime's host hands each
world's streamer to the connection's new `present` hook, which starts the batcher. The sim worker (`voxelPorts(root)`
dep, init `voxels.root`) posts `{ t: 'voxels', batch }` with the transfer list; the page answers `voxels.drawn` with
each drawn chunk's GPU bytes (the chunk's mesh part of the world's budget, where the world runs). In single-thread
mode the page's own runtime gets the same wrapped ports and the batches go straight to the draws.
`three-adapter/voxel-world-draws.ts` (`VoxelWorldDraws`, game page): a 46a.5b `VoxelChunkView` a world under the
adapter's scene, each batch applied in the task it arrives in (queued until the renderer can draw), grid textures
retired and frame times kept by an animation-frame loop while a world is drawn; `window.__tlVoxelPlay` (stats, edits).
Play's source (`editor/preview/voxel-ports.ts`): the preview origin's new routes `/play-content/<contentId>/voxels/<world>`
(manifest, files) and `…/regions/<file>` (range), allowed by the play's locator like its other files (no token on that
origin; `voxel-routes.ts` `reads`), with 46a.4's batched reads (`editor/voxel-world/range-reads.ts`, shared with the
slice page), a pool of module workers a world (`voxel-worker.js`, new in the play build, started next to the sim
worker's script). Collision: the 46a.7a ring in the sim's physics, unchanged; new: bodies wait over a voxel column whose
bodies are not in (`BodySuspension` asks `RuntimeVoxels.loadedAt`: the world open and every chunk of the column within
the ring's add bounds in the ring with its derive arrived, `CollisionRing.columnSettled`), so a character placed on a
world that is still streaming no longer falls through it. `startGamePage` moved the input exercise's input to
`relayedInput` (529 → 500 lines).
Tests: `tools/voxel-bench/world-host.test.ts` (real runtime, region files, Node workers, real Rapier, through
`presentVoxelWorlds` with each batch structured-cloned with its transfer list): after the ring filled, every drawn
chunk the page would hold equals a fresh `joinedChunk` (surfaces, pieces, grid entries); a dig's swap arrives in
exactly one batch with every chunk it names; the page's bytes land as the mesh part; the world's close tells the page.
`tests/e2e/voxel-world.e2e.ts` + 2 tests: Play of the e2e project with a `voxelWorld` (the slice), a fixed camera, a
character and a script that digs a 1.75 m ball under it 5 s after `whenResident`: the character waits over unloaded
ground, then stands on the pad; the pit shows (pixels changed, png.ts), the character falls > 1 m, on WebGPU with the
sim in its worker and on WebGL 2 with `?threads=off`. Pictures looked at: WebGPU before and after (ground, wall,
banister, the pit), WebGL 2 after.
Edit → screen (`__tlVoxelPlay.edits`, e2e run, headless Chrome on the host's GPU, editor Game view ~670×250, not at a
720p cap; one dig of 2 sections in 1 chunk; ad-hoc run 02:27 at load ~2 / the gate rerun 02:44 at load ~5):

| Mode | Edit → swap (sim) | Hop sim → page | Apply on the page | Edit → first frame drawn after | Frames |
|---|---|---|---|---|---|
| WebGPU, sim worker | 6.8 / 10.4 ms | 0.2 / 0.2 ms | 0.8 / 0.8 ms | 17.1 / 16.4 ms | 1 / 1 |
| WebGL 2, single thread | 8.9 / 7.9 ms | 0 / 0 | 0.7 / 0.8 ms | 15.9 / 16.9 ms | 2 / 2 |
| slice page (46a.5b), local blast 1–4 m | – | – | – | next frame | 1 |

Sim step: the worker's tick round trip (step + messages) averaged 3.4 / 6.1 ms, max 66 / 90 ms (the world's open and
cold fill); not split per step (46a.12 measures at the cap). Streaming in Play: 194–219 chunks drawn, 571–652 batches
over the cold fill. The WebGL 2 page's 2 frames: the dig's batch arrived after that frame had begun (the page's own
simulation steps inside the frame), so it shows in the next one; not looked into further.
Fast gate (gate-fast-20261103-023043, + voxel-world, sim-worker, relay-input, character-3d e2e): RED in vitest on D445
(a stale catalogue test from 46a.7a, hidden by its rerun of only the failed files), fixed in 4cfafdf1; rerun
(gate-rerun-20261103-024032) GREEN, 4 min, 4.1 GB peak, 42 e2e passed, village perf at the cap 0 missed on both
renderers. `voxel-world.e2e.ts` 17.7 → 36.4 s (9.2 + 5.2 + 6.1 + 8.1 + 7.8 s; load 5.3, uptime 10 d 10.3 h): the two Play
tests add 15.9 s, about 5 s each of it the script's wait before the dig (time for the "before" picture), which a later
item extending these tests can shorten.

**46a.7c** (73ea05cf). **Far worlds in Play (D444).** three's node materials make the view-space position on the GPU
from the camera's view matrix and the object's world matrix, each rounded to 32 bits first (`mediumpModelViewMatrix`),
so a voxel view re-based alone would gain nothing: its chunks' world matrices are made in 64 bits in JavaScript already,
and the camera's large position is still subtracted in 32 bits. The voxel surface and piece materials now take a
model-view made per draw in 64 bits (`three-adapter/camera-relative.ts`: `camera.matrixWorldInverse ×
object.matrixWorld` in an object-update uniform, given through the material's context the way three's own
`highPrecision` does it, so three's observer refreshes those draws every frame), the camera being the origin of every
draw: nothing is re-based as it travels, and Play's views keep their origin at 0. First built by replacing
`setupPositionView`: the plain Lambert piece material then has no node property, three's observer never refreshed its
draws, and after a page reload the slice page's rail and posts kept the first frame's matrix and vanished (the gate's
reload picture check caught it, 1,021 pixels on both renderers); the context form refreshes them, and the vitest now
checks it. Test (`voxel-chunk-view.test.ts`): a chunk 512 chunks (8,192 m) out with the camera beside it: both
programs read the 64-bit matrix (no `cameraViewMatrix × model` in the vertex stage), every 7th surface vertex lands
within 1.3 µm of its exact 64-bit camera-space position, against 0.56 mm for the default GPU product (removing the
call from the surface fails the test). E2E: Play now plays the slice world written 8 km out on x and z
(`writeSliceWorld(…, shiftChunks)`), on both renderers: draws (194 chunks), the character waits, stands and falls
into the pit in world-coordinate physics (Rapier f32 at 8 km held it), pixels change; pictures looked at (WebGPU
before, WebGL 2 after: ground, wall, banister, the pit). Jitter with a moving camera not looked at on screen
(unverified; the camera is fixed). Left for other objects far out: D446.
**E2E trim.** The script digs on a debug command the test sends after its "before" picture (`play/<id>/control`
`debugCommand dig`), the ground resident (`whenResident` answered) and the character standing, instead of 600 steps
(5 s) after residency. Fast gate (gate-fast-20261103-025959): RED on the piece refresh above; after the fix
(gate-fast-20261103-031529) GREEN, 11 min, 4.3 GB peak, village perf at the cap 0 missed on both renderers.
`voxel-world.e2e.ts` 36.4 → 24.5 s (7.9 + 4.4 + 4.9 + 3.8 + 3.5 s; the Play tests 8.1 + 7.8 → 3.8 + 3.5 s; load 5.0 at
the end, uptime 10 d 11.0 h): the whole of 46a.7b's dig wait won back; the rest of the growth since 46a.7a's 17.7 s is
the two Play tests' own streaming and checks.

**46a.8** (eb0dc688). **Restore into the overlay.** `VoxelStreamer.setSave`/`putSaveEntry` (which wrote a save's
entries into the base store as chunks loaded, through the worker's `apply-save`) are replaced by `restoreSave(entries,
onMismatch)`: the overlay is cleared and each entry of the world's grid goes into it; a resident chunk's entry is laid
over it at once (`PendingRestore.apply` in `stream-overlay.ts`: the base hash from the store's chunk, then only the
player's cells written into the overlay, `applySaveChunk(…, false)`: on the base it was made against that is the saved
chunk whole) and the cells it changed are rebuilt in one group with the dropped overrides; any other entry waits
(counted in `bytes.overlay`, written again unchanged by a `saveChunks` made meanwhile) and is laid over its chunk in
`land`, before the chunk is resident, so no read sees the base without it. The base store stays the files' content,
so a save made after a restore hashes the shipped chunks. The worker job `apply-save` stays (spec §3.6) but the
streamer no longer uses it. **`ctx.voxels`** (world and top level): `setSavedFields(fields)` (the component's
`savedFields` until set; a new run resets it; false for an unknown field), `save()` → an id answered in
`ctx.voxels.saves` at a later step (`{save, world, ok, bytes, text, chunks, message?}`: save file v2, not compressed,
`text` its base64 for a save document), `restore(bytes | text, 'save' | 'base')` → `{ok, edit, chunks}` or a refusal
(`invalid`: another world's save, a broken one, bad text or choice; `not_resident`: the world not open yet), reported
as a change after its swap; each mismatched chunk once in `ctx.voxels.mismatches` (`{world, chunk, kept}`). The
connection gives the world's id (`VoxelWorldConnection.worldId`, from the manifest in Play).
Tests: `stream.test.ts` (4 real workers, region files on disk, derives on): restored before its chunk loads (waits, in
the budget, saved again unchanged), then the base equals the files, the overlay over it equals the oracle with the
entry laid over it, only the player's cells are overrides, every derive equals the truth's, saved again the same
entry; restored after (a game edit dropped, read at once, its group swaps, same checks); a changed base with `base`
(reported, the files stand, saves nothing) and `save` (reported, the player's cells, saved against the files now).
`world-host.test.ts` (real runtime, Node workers, region files, real Rapier): dig + rain, saved (bytes = text, the
default fields), every field saved is bigger; a restart reads the files again (body back on the ground), the restore
reads the pit air and the rim dry in the same step, the body drops after its swap, saved again the same bytes; another
world's save, a truncated one, bad text and a bad choice refused, nothing changed; world b opened from a scene loaded
later restores while nothing is resident (reads null) and reads the pit air once it lands; entries with changed base
hashes reported once each, `base` keeps the files, `save` the hole. Save sizes (default fields, 1 m balls at the
ground, each at its own spot of a 10 × 10 grid 4.8 m apart; Node, load ~3): 10 digs 1,848 B in 4 chunks (2,464
chars as text), 100 digs 17,707 B in 17 chunks (23,612 chars); uncompressed (the runtime has no zstd compressor; the
spec's zstd figure is 0.3–0.5 MB after 1,000 strokes).
E2E (`voxel-world.e2e.ts` Play, both renderers): after the dig the script wets the ground beside the pit (reads 7),
saves (`text` into the game's save document, slot 1, `setSaveSchema` one slot), the game restarts (`replay`: the pit
filled, the character on the pad again, pixels changed), the script loads the slot and restores: pit air, wetness 0
(`get`), the character falls again, pixels changed > 500. Pictures looked at: WebGPU restarted and restored (pit
back), WebGL 2 restored. The wet patch itself was not photographed (wetness gone is the script's read; unverified by
eye). Fast gate (gate-fast-20261103-034607): GREEN, 11 min, 4.5 GB peak, village perf at the cap 0 missed on both
renderers; vitest `stream.test.ts` 'times out a slow job …' (worker pool, untouched) failed once and passed alone
(load ~4.8). `voxel-world.e2e.ts` 24.5 → 26.6 s (7.6 + 4.4 + 4.9 + 5.0 + 4.7 s; the Play tests 3.8 + 3.5 → 5.0 + 4.7
s; load 3.8 at the start, uptime 10 d 11.3 h).

**46a.9** (b6dcb2c6). **Prop lighting channel in the host.** `@thirdlight/voxel` `prop-channel.ts` (`PropLightChannel`,
`PROP_COVERAGE_PART`): per resident chunk the 45.6 `propCoverageChunk` bytes of the props over it (null: none), built on
the chunk's `loaded`, dropped on `unloaded` (a refresh in place keeps it); `apply` places, moves and removes props
together and rebuilds each chunk any of them left or entered once, the chunk's props in first-placed order (so a
rebuild equals a fresh build); each build is the chunk's `propCoverage` budget part (32 KB a covered 32³ chunk, 0
uncovered). `prop-coverage.ts` gains `lightCoverageAt` (one cell of `lightCoverage`) and exports `propBounds`; the
streamer's `derivedOf(…, drawn)` gives a section's committed result while a rebuild is pending. Runtime:
`prop-light-shape.ts` (`propLightShape`): the object's collider as the physics port resolves it (world scale, full
rotation; boxes, spheres, capsules, cylinders exact, hulls and meshes as the box around their points in their own
frame, compounds and `_COL` parts per part), else the model's recorded bounds as a turned box (a piece without a
collider: nothing, its file's bounds would stamp the kit), wrapped as a `PropShape` whose inside test does the turn, so
the 45.6 voxelizer is unchanged. `RuntimeVoxels` keeps the objects whose model has `affectsLighting`, compares each
one's world transform at every step's start and stamps the changed ones into every loaded world in one `apply`
(`VoxelWorldHost.stampProps`); a lit prop with neither shape is warned once. `ctx.voxels.coverageAt(x, y, z)` (world
and top level, graph node "Light coverage at"): 0 … 1, the section's drawn construction coverage joined with the
channel, null off the ring or before the section's first result. Nothing renders from it (46e). Play runs the same
host in the simulation (46a.7b), so the channel is built there too; not checked in a browser run (nothing reads it yet).
Tests: `derived.test.ts` (pure channel, 32 resident chunks: a crate placed before its chunks load builds nothing, then
on load; a 20 m move rebuilds exactly the 4 chunks left + 2 entered; moved out of the ring only the left ones;
overlap and removal; every resident chunk equal to `propCoverageChunk` of the list after each change and its budget
part its byte length; refresh keeps, unload drops, reload rebuilds); `world-host.test.ts` (real runtime, region files,
Node workers, real Rapier): a turned box-collider rock, a tree by its model bounds (scale 1.5) and an unmarked pebble;
every cell of their chunks read through `coverageAt` by the script equals the drawn construction joined with a fresh
`propCoverageChunk` of independently written shapes (yaw + scale form); the rock moved 20 m by its script rebuilds
exactly the chunks it left and entered; the save after the move equals the one before, the overlay bytes and every
region file's checksum are unchanged; the focus 100 m away unloads the props' chunks and back rebuilds them, equal again.
Removing the left chunks from a move's rebuild fails both tests (checked once by hand). Numbers (Node, i5-12600H,
04:18, load 4.4–5.5, uptime 10 d 11.9 h; scratch `~/.cache/thirdlight-phase46/work/46a.9/ring.ts`):

| What | Number |
|---|---|
| one move of a 3 m canopy (1–4 chunks rebuilt), in-test | p50 1.8–2.0 ms, p95 2.0–2.5 ms |
| one place, 100 / 400 / 1,600 lit props over the slice ring (6,776 chunks, half 3 m canopies, half 2.6 × 1.8 × 1.4 m rocks) | p50 1.7 / 1.8 / 3.2 ms, p95 3.6 / 4.1 / 11.5 ms |
| the same props arriving in one step (one build a chunk) | 95 / 401 / 1,540 ms |
| channel bytes in the slice ring, 0 / 100 / 400 / 1,600 lit props | 0 / 4.5 / 10.6 / 13.5 MB (0 / 143 / 338 / 432 covered chunks, 32 KB each) + ~0.6 MB of chunk entries |

The cost is the 45.6 voxelizer itself (64 inside tests a cell, ~0.7–1 ms a 3 m canopy) times every prop over each
touched chunk; a whole scene of lit props placed in one step into a loaded ring stalls that step (D448, for the
performance phase / 46e). The channel bytes are dense (32 KB a covered chunk); the sparse form the light coverage
uses (45.6: 0.5–4.3 KB a chunk) would cut them when 46e reads it. Fast gate (gate-fast-20261103-042136): RED in vitest on the catalogue test's `ctx.voxels` stand-in lacking
`coverageAt` (as D445), fixed; rerun (gate-rerun-20261103-043109) GREEN, 4 min, 3.9 GB peak (first run 5.1 GB), village
perf at the cap 0 missed on both renderers. `voxel-world.e2e.ts` 26.6 → 32.0 s (8.0 + 5.4 + 6.8 + 5.7 + 6.1 s) with no
e2e change, load 6–9 during the run (8.8 at its start), uptime 10 d 12.1 h: host load, not this item (nothing in the
e2e path changed but a per-step transform check that finds no lit props).

**46a.10** (f305e979 boundary: editor → project-model `voxel-world` subpath as a value; f4f530a4 Scene view). The Scene
view draws the worlds its open scenes' `voxelWorld` objects name (`editor/viewport/scene-voxels.ts`): a world's first
object gives its settings (`resolveVoxelWorld`, as the runtime), opened, streamed and derived in one module worker
(`voxel-world/scene-voxels-worker.ts`, built as `dist/editor/voxel-view-worker.js`; it starts the world's derive
workers, `voxel-worker.js`) around the orbit target (sent when it moves half a metre), each streamer task's draws posted
as one transferred batch (`ChunkDrawBatcher`) and drawn by Play's `VoxelWorldDraws` in the adapter's scene (world
coordinates, the 64-bit camera-relative draws of 46a.7c), a frame asked for after each batch (`applied`). No bodies.
The feed's `voxelsChanged` goes to the worker: the next revision re-reads its chunks in one swap group, a gap reads the
world again whole. A renderer switch starts the draws again in the new adapter's scene and streams the worlds again.
`data-voxels` (drawn chunks, worker states, problems) and `data-render-ms` (render() CPU p50/p95 of each 30 frames) on
the view. Shared pieces: `worldStreamer`/`worldStreamRing` (voxel: a world's streamer from metres, now also the runtime
host's), `RangeWorld` (`voxel-world/range-world.ts`: manifest, listed files, range source, worker pool, `applyChange`,
`readAgain`; the voxel world page, Play's ports and the Scene view's worker open worlds through it).
Found and fixed on the way (D449): `settle()` hung when only worker-less derive work was left (a world of air round the
focus: Play's 8 km world as the editor sees it at the origin); it now updates again after 4 ms at the latest.
E2E (`voxel-world.e2e.ts`, + 1 test, WebGPU): a group at the slice scene, F to orbit it, a still picture (bare grid);
`setComponent voxelWorld {world: 'slice'}` over the command route, the world streams in (225 chunks drawn, worker
settled) with no reload, pixels changed > 20,000; an `editVoxels` 3 m dig sent as MCP sends it, revision + 1 reaches the
worker, the chunks drawn again, pixels changed > 500, page not reloaded; the object deleted, the world's draws go.
Pictures looked at: bare, world (ground, wall, beam, banister rail and posts) and dug (the pit through ground and wall)
on WebGPU; the same test run once ad hoc on WebGL 2 (dug picture looked at: the same pit). Not in the gate on WebGL 2.
Render CPU (the e2e's 60-frame orbit, editor Scene view ~670×280 CSS px in headless Chrome on the Iris Xe, not at a 720p
cap; 225 chunks, 467 k triangles, 24 pieces; 05:00–05:30, load 4–8, uptime 10 d 12.5 h):

| Run | render() CPU p50 / p95 with the world | without (the object deleted) |
|---|---|---|
| WebGPU, ad hoc | 2.3 / 3.6 ms | 0.6 / 0.8 ms |
| WebGL 2, ad hoc | 2.1 / 3.4 ms | 0.5 / 0.8 ms |
| WebGPU, ad hoc after the D449 fix | 2.9 / 4.5 ms | 0.6 / 0.8 ms |

About 1.6–2.3 ms a frame for 225 chunk draws (one surface draw a chunk plus pieces), in line with the slice page's
1.4–1.6 ms for its ~490 chunks at the cap (46a.5b) given the host load; the main thread does no streaming or deriving
(the worker), only batch applies (one per streamer task while streaming). Cold fill to settled not timed separately
(the e2e's poll passes within its first seconds). Fast gate (gate-fast-20261103-045422): RED in vitest on
`scan-bounded-log.test.ts` (D418 watch, timed out also alone at load 10); rerun (gate-rerun-20261103-050453) RED in e2e on
this test's own check (after the object went it expected no world at all, but Play's 8 km world, made by the Play tests
earlier in the file, stays open: it never settled — D449); after the fix (gate-fast-20261103-051853) GREEN, 13 min, 5.4
GB peak, village perf at the cap 0 missed on both renderers (main thread 8.84 / 6.26 ms against limits 9.02 / 7.84,
load 7–8). `voxel-world.e2e.ts` 32.0 → 38.6 s (9.1 + 5.0 + 5.7 + 5.4 + 5.5 + 7.9 s; the existing five 32.0 → 30.7 s, the
new test 7.9 s; load 6.7–8.6, uptime 10 d 13.1 h); `rendering.e2e.ts` 133.8 s. D437 left open (SkyProbe's ambient and
hemisphere checks are unrelated to the voxel draws; not cheap to fold in here).

**46a.2** (1bf03832 boundary, e48969c5 schema). No perf item. `voxelWorld {world, ring?, collision?, sectionEdge?,
savedFields?}` (metres; unset = the voxel defaults, resolved by `resolveVoxelWorld`: load 192/224 m across, 96/128 m
up/down, collision 48/24 m, 16-cell sections, saved material/role/shape) and the model flag `affectsLighting`; additive
on schema 8, no bump. New owners in `@thirdlight/voxel`: `DEFAULT_SECTION_EDGE`, `DEFAULT_COLLISION_RING` (cells),
`VOXEL_WORLD_NAME_RE` (moved from the workspace). Tests: `project-model/src/voxel-world.test.ts` (refusals, scene
validator + canonical bytes keep every field in order, a second pass the same bytes, defaults from the voxel
constants, prefab refused, affectsLighting kept/absent/refused), the descriptor registry probes, and one
`voxel-world.test.ts` integration test (real backend: createEntity + setComponent over HTTP, five refusals change
nothing, null resets a field, scene file on disk, same after a restart). Descriptor JSON +3.4 KB (budget 361,200).
Fast gate (gate-fast-20261102-205602): GREEN, 11 min, 4.9 GB peak; `voxel-world.e2e.ts` 21.0 s (9.9 + 5.4 + 5.7 s, no
e2e change), `inspector.e2e.ts` 15.4 s (8.2 + 4.6 + 2.6 s); village perf at the cap 0 missed on both renderers.

## 8. Decision log

- 2026-11-02 (plan, default chosen, owner to confirm): **the voxel world lives with the simulation** (the sim worker
  by default, the page in single-thread mode): store, overlay, streamer, derive workers (started from the sim worker;
  Chrome and Edge support workers inside workers) and collision. The page only draws what each swap posts (one
  transferred message a swap). One authoritative store; scripts read synchronously. Cost: one sim → page hop per swap,
  measured in 46a.7b against R107.
- 2026-11-02 (plan, default chosen, owner to confirm): **a `voxelWorld` component on a scene entity** names the world
  and its settings; the world streams while that scene is loaded (`ctx.scenes.load/unload` is the one way to change
  levels). Add-only; no project-schema bump unless the version rules require one.
- 2026-11-02 (plan, default chosen, owner to confirm): **script edits go to the overlay only**; the editor keeps writing
  base files through `editVoxels`. Reads of a non-resident cell return `null`, never air. `ctx.voxels` takes world
  metres; cell math stays inside.
- 2026-11-02 (plan, default chosen, owner to confirm): **voxel saves are game-owned bytes** (`ctx.voxels.save()` /
  `restore()`, save file v2 with the game's saved-fields mask); no engine save section, consistent with the kept-object
  rule.
- 2026-11-02 (plan, default chosen, owner to confirm): **collision ring** 48 m horizontal / 24 m vertical around the
  world's foci, with hysteresis; heightfields where a chunk's collision is a height function; physics bytes counted
  in the one stream budget. Physics stays in world coordinates in 46a (Rapier f32 ≈ 1 mm steps at 10 km); the floating
  origin re-bases draws. A physics re-base is built only if a far test shows jitter (then a D-row).
- 2026-11-02 (plan, default chosen, owner to confirm): **exports ship whole region files** as content-addressed
  buffers (the closure reads whole verified files, no ranges; a 256 m tile is ~0.2–0.4 MB at the measured 430–580 MB
  per 10 km); Play and the editor read by range from the backend.
- 2026-11-02 (plan, default chosen, owner to confirm): **voxel undo stays per world in the backend**, not in the
  project's history; open clients learn of edits through `voxelsChanged`. Per-chunk undo at world scale is 47c's.
- 2026-11-02 (plan, default chosen, owner to confirm): **draw and collide per chunk over 16³ derives** (one object and
  one body a 32³ chunk, joined at swap); batching beyond that (e.g. one draw for many chunks) only if 46a.5b's numbers
  ask for it. D432 defaults: 16 KB coalescing gap, column batches, prefetch 1 s ahead of the focus's motion.
- 2026-11-02 (46a.1, default chosen, owner to confirm): **voxel world ops take no `expectedRevision`** (a world keeps
  its own revision; MCP neither requires nor sends the project's); they are listed beside `MUTATION_OPS`
  (`VOXEL_WORLD_OPS`), not in it, since the project pipeline never applies them. `voxelsChanged` goes to the project's
  registered editor session (the one the WS feed serves), for every origin including the sender's own (it can tell by
  `requestId`); a repeated request id sends nothing. The voxel command now refuses a malformed `origin` with the
  project pipeline's own parser. Reference: op pages from the workspace's `VoxelWorldOpArgs` union.
- 2026-11-02 (46a.2, default chosen, owner to confirm): **`voxelWorld` stores metres and only what the author set**;
  absent settings follow the voxel package's defaults (so a later default change reaches every world). Saved fields are
  a list of field names (`['material','role','shape']` by default), not a bit mask, in the file and the Inspector.
  An unload distance below its load distance resolves to the load distance (no refusal: the descriptor checks are per
  field). Not allowed in prefabs (a world streams per scene). One world per object; two objects naming the same world
  in a scene are not refused yet (the host in 46a.7a decides). **`affectsLighting` is on models only, absent = off**
  (spec: on for large static props, off for small ones and scatter; no size-based automatic default).
- 2026-11-02 (46a.3, default chosen, owner to confirm): **runtime edits never make a chunk dirty**: the streamer's
  `edit`/`editInWorker` write only the overlay, so the tracker's dirty/hold rules now guard only writers of base
  files that share the tracker; an edited chunk unloads like any other and its overrides wait in the overlay
  (counted in the budget, never evicted). The overlay has no per-project cap; a game that changes a great deal fills
  the budget and streaming then keeps a smaller ring (eviction stops short), as for any part.
- 2026-11-02 (46a.3, default chosen, owner to confirm): **`saveChunks` reads a departed chunk's base from the
  world's files again** (one worker `load` per stored chunk) rather than keeping its base bytes in memory after
  unload: a save costs reads, play costs nothing. A base that cannot be read rejects the save (never saved against a
  wrong base). Entries are taken in one task after the reads, so no edit lands half in a save.
- 2026-11-02 (46a.3): an overridden chunk is sent to workers as the base's arrays with only its overridden cells
  written (main thread: one copy plus one write a changed cell), and reads as `stored` for aprons (cell-by-cell reads
  of its strips) even when the merge is uniform: correct, slightly more apron bytes. `setSave` still applies a save's
  entries into the base store as chunks load (as built in 45); 46a.8 moves restore onto the overlay so the base stays
  the files' content and save hashes stay against the shipped base.
- 2026-11-02 (46a.3): the slice page's local edits (a game's runtime edits) are in the overlay; its `reread` hook
  clears the overlay (a quit) instead of reading files again; the page's section default is the engine's
  `DEFAULT_SECTION_EDGE`.
- 2026-11-02 (46a.2): project-model may import `@thirdlight/voxel` (own boundary commit 1bf03832; voxel joins the export
  engine packages), so the component's defaults are the voxel constants, never copies.
- 2026-11-02 (46a.4, default chosen, owner to confirm): **read defaults**: 16 KB coalescing gap
  (`REGION_READ_GAP_BYTES`, region-file.ts), 8 reads in flight (`DEFAULT_STREAM_READS`) for every server (HTTP/2 not
  detected or measured; 8 batches keep HTTP/1.1's six connections busy), prefetch 1 s (`STREAM_PREFETCH_SECONDS`,
  capped at the near radius; a step past the near radius or faster than one a frame is a jump, not motion), batches
  of whole columns plus the neighbours along the source's row axis as far as the ring's hysteresis. The ring is kept
  around the focus and the lead point (load and unload), so a moving focus holds ~10 % more chunks.
- 2026-11-02 (46a.4): read order changed from 3D distance shells to columns by horizontal distance (to the lead
  point), the focus height first inside a column: the near lane and the near-ring measure are horizontal, and a
  column is one byte range. Chunks far above or below a near column now come before nearer-in-3D chunks of the next
  column; most of them are air or uniform (no bytes, no worker).
- 2026-11-02 (46a.5a, default chosen, owner to confirm): **joined chunks are built on demand and not kept**: a
  `chunk` event names the chunk, the drawing side asks `joinedChunk` and uploads; the streamer keeps only the section
  results (an edit re-derives some sections and the join needs the rest), so a joined copy in memory would double
  the derived bytes for nothing the GPU does not already hold. Vertices on faces between sections are **not welded**
  (+1.2 % town, +6.1 % slice vertices; triangles and positions equal the whole-chunk derive bit for bit): welding
  would cost a hash lookup a vertex on the main thread and the 46b mesher replaces these buffers anyway.
- 2026-11-02 (46a.5a): `stream.test.ts`'s 16³/8³ sections test hangs when run alone (`-t sections`, also at
  4036a3c2): its wait for the blast's swap only yields tasks and never calls `update()`, so it relies on the edit's
  own job sends finding pool room, which depends on the tests before it; in the file it passes (7.1 s, now with its
  own 30 s timeout: two cold fills plus whole-chunk oracle derives went past vitest's 5 s at load 9–11). Not fixed here.
- 2026-11-02 (46a.5b, default chosen, owner to confirm): **three-adapter may import `@thirdlight/voxel`** (own
  boundary commit 9d22034d), so the chunk view reads the format's vertex, instance and grid layouts from their one
  definition. The view draws a chunk's ground and base as one mesh (one material) and keeps piece stand-ins per
  chunk and family; `streamer.joinedChunk` takes an optional cell array (an overload, not a new member: the
  streamer class is at the 80-member limit). A chunk is re-joined on every `chunk` event, including while streaming
  (one per job answer).
- 2026-11-03 (46a.6a, default chosen, owner to confirm): **a voxel chunk's ground collides as a heightfield only when
  it stands for the ground within 5 mm** (`GROUND_HEIGHTFIELD_TOLERANCE_M`, vertical, checked exactly at every vertex
  of the overlay of field and triangles), has no boxes (a wall or beam keeps the chunk a mesh) and nothing faces down;
  a face whose nodes lie under the neighbour's shared vertices starts the field one node in, those triangles a mesh.
  The field is handed to the port turned a quarter about +y (the port splits cells (+x, min z)–(min x, +z), the
  voxel ground (min x, min z)–(+x, +z)). Joined boxes are not merged again across section faces.
- 2026-11-03 (46a.6a, for 46b): **heightfields need lattice ground.** With the surface nets no slice or hilly chunk
  qualifies (slopes 1.0–2.6 cm off the lattice, 22–24 % of ground chunks leave through a chunk's top or bottom);
  only level ground does (town 24 %). Proposal: where 46b's terrain mesher's ground is a height function it puts one
  vertex a column on the cell-corner lattice, and heightfields span a chunk column (or patches, as terrain tiles
  do), keeping the goal: cheap physics for ordinary ground (172 vs 236 KB of Rapier heap a body in the town). Before
  sloped heightfields ship, D443 (Rapier's heightfield sphere casts) is re-checked.
- 2026-11-03 (46a.6a): the chunk-body builder stays in the page (`voxel-world/collision.ts`): the geometry
  (`collisionGeometry`, `groundHeightfield`, `joinCollision`) is pure and in `@thirdlight/voxel`; what is left is
  ~60 lines of port glue (compound parts, the field's quarter turn, add/remove/re-base). 46a.7b moves that glue next
  to the simulation's physics for Play, where bodies are built from the sim's own join (the page only draws).
- 2026-11-03 (46a.6b, default chosen, owner to confirm): **the collision ring is measured to the chunk's box**
  (strictly nearer than the radius: everything that close is solid, whatever the chunk edge), keeps bodies 8 m past
  the bounds (`COLLISION_RING_HYSTERESIS_CELLS`), adds entrants nearest first within 4 ms an update with at least one
  body a call (`COLLISION_ADD_MS_PER_UPDATE`), and removes leavers at once, farthest first (memory first; a removal
  is 0.1–0.9 ms). Foci are a list: the page passes its camera target; 46a.7a's host passes the world's focus and its
  characters.
- 2026-11-03 (46a.6b, default chosen, owner to confirm): **a body's budget part is an estimate of Rapier's heap for
  its shape** (`estimateStaticBodyBytes3D`, owned by physics-rapier, held to 0.8–1.25× of the real heap by a test) plus
  the geometry kept on the JS side. `physicsMemoryBytes3D` deltas are not used per body: the heap grows in 64 KiB
  pages, never shrinks and reuses freed bodies' bytes, so a delta is 0 for most adds and a page for some. The heap's
  high-water above the live bodies (5–8 MB here) is not in the budget; the ring bounds it.
- 2026-11-03 (46a.6b): the streamer emits `unloaded` while the chunk is still listed, so a consumer that clears its
  part there subtracts it a second time; consumers leave an unloaded chunk's parts to the streamer (the ring does;
  the chunk view never cleared its `mesh` part). 46a.7b moves `PageCollisionRing`'s glue next to the sim's physics.
- 2026-11-03 (46a.7a, default chosen, owner to confirm): **one host a world name**, made by the first `voxelWorld`
  object to arrive and disposed when the last leaves; a second object naming a loaded world joins it with the first's
  settings (a warning when they differ); a scene reload disposes and reopens (the game's changes go). **Ports give a
  pool a world** (closed with it) and a budget a world (default the low tier's 256 MiB; two worlds do not share one).
  The world's cell 0 is at the world origin: the object's transform places only the focus.
- 2026-11-03 (46a.7a, default chosen, owner to confirm): **focus** = where a live camera looks (its target, else the
  camera), else the first object naming the world; bodies around the focus and every player controller. Physics in
  world coordinates (as planned); collider ids `voxel:<world>:cx,cy,cz`.
- 2026-11-03 (46a.7a, default chosen, owner to confirm): **`ctx.voxels` regions** are a point, a box (every cell it
  touches) or a ball (every cell whose centre is inside), metres; `set`/`dig` are exact `set`/`dig` commands over the
  cells (whole cells; smooth digs and brushes stay 47b's); `set` of air or shape 0 is a dig; `paint` changes only
  material/wetness and keeps each cell's role and shape, as one exact set per resulting voxel applied in one task;
  top-level calls act on the first world loaded, `world(name)` the others. A new run (restart) clears the overlay.
- 2026-11-03 (46a.7a): **`whenResident` cannot return a promise**: script hooks are synchronous and the ctx guard
  refuses a call after the hook (a `.then` included). Replacement keeping the goal: it returns a wait id answered in
  `ctx.voxels.waits` at a later step's start (`resident` true, or false when the world unloads first), for that step
  only, like the other step events. `changes` likewise: each swapped edit once, at the next step, with its chunks'
  boxes and `shaderOnly`; streaming swaps are not reported.
- 2026-11-03 (46a.7a): the visual-script generator cannot type a region or a nullable world handle, so `set`, `dig`,
  `paint`, `isResident`, `whenResident` and `world` are skipped as graph nodes with that reason (reads are nodes);
  graph inputs for regions can come with 47b's brushes.
- 2026-11-03 (46a.7b, default chosen, owner to confirm): **Play reads voxel worlds on the preview origin under the
  play's locator** (`/play-content/<contentId>/voxels/…`, the live files, by range): the play page and its workers have
  no token, and the locator already is the permission for the play's other files; it stops working when the locator
  expires. The world's derive workers are module workers started by the simulation worker (by the page in single-thread
  mode), one pool a world (`defaultVoxelWorkers`, 1–4).
- 2026-11-03 (46a.7b, default chosen, owner to confirm): **one batch a streamer task**, sent at the task's end: a swap's
  chunks always share a message (the edit stays atomic for draws); streaming answers go out as they come (one message a
  job answer). A chunk is joined once for the draw by the batcher and once more by the collision ring when it is inside
  the ring (the ring is the host's own listener): ~0.3 ms a chunk on the simulation's thread, left for 46a.12 to weigh.
- 2026-11-03 (46a.7b, default chosen, owner to confirm): **a body waits over voxel ground not streamed in yet**, as over
  terrain tiles (one rule, `body-suspension.ts`): over a column in a loaded world, until every chunk of it within the
  collision ring has its derived body; a column no focus reaches is not ready. A world that cannot open holds nothing up.
- 2026-11-03 (46a.7b): nothing of the page's collision glue had to move: Play's bodies are 46a.7a's `PortBodies` in the
  simulation's physics port, and `PageCollisionRing` stays the slice page's. The new `unloaded` listeners (the batcher,
  the host's derived set) clear no budget part (46a.6b's note).
- 2026-11-03 (46a.7b): Play draws voxel chunks in the scene's world coordinates (no floating origin in the game view;
  D444); the plan's "floating origin re-bases draws" holds for the slice page and the editor, not Play yet.
- 2026-11-03 (46a.7c, default chosen, owner to confirm): **far out, Play's voxel draws are placed relative to the
  camera in 64 bits per draw** (a per-material model-view, three's own high-precision path), not by a 1 km re-base of
  the game view: three's node materials subtract the camera's position on the GPU in 32 bits, so only a whole-view
  re-base (camera and every object) would help, and the game view's systems keep their own world matrices
  (`scene.matrixWorldAutoUpdate` is off; render graph nodes, batches, static merge, instancing, terrain) and world-space
  uniforms (fog, probes, terrain and decal projections, wind, cover), each of which would have to take the origin. The
  camera-relative matrix is stronger than a re-base (the origin is the camera at every frame, nothing to move) and
  costs one 4×4 product a draw for the voxel draws only. Everything else in a far game view keeps three's default
  (D446); physics stays in world coordinates (plan); `FloatingOrigin` stays the slice page's and the physics side's tool.
- 2026-11-03 (46a.7c): the Play e2e's dig is a script debug command the test sends once its "before" picture is taken
  (the game's own way for tools to drive a play), so the test waits on the world's residency and the character's
  landing, not a fixed time; the world it plays is the slice world written 8 km out (the near world is the slice
  page's, in the other tests).
- 2026-11-03 (46a.8, default chosen, owner to confirm): **`save()` answers at a later step**, not at once: a save
  reads the base of edited chunks that left again (46a.3's decision: a save costs reads, play costs nothing), and
  hooks are synchronous, so the bytes come in `ctx.voxels.saves` like `waits`. A save is **not compressed** (no zstd
  compressor in the browser; fzstd only decompresses); `restore` refuses a compressed save. The game's save
  document holds JSON only (D447), so the answer carries the bytes and the same as base64 text, and `restore` takes
  either.
- 2026-11-03 (46a.8, default chosen, owner to confirm): **`restore` replaces the game's changes** (the overlay is
  cleared first) and needs the world open (`not_resident` before; `whenResident` tells). **The mismatch choice is a
  value given with the restore** (`'save'`: the player's cells over the new files; `'base'`: the files), not a
  callback per chunk: a chunk that loads later is decided outside any hook, where a script function cannot run;
  every mismatched chunk is reported in `mismatches`, so a game that wants another outcome there edits it. No
  default: the game always names its choice. The `report` mode of the streamer's old `setSave` is gone (reporting
  is always on).
- 2026-11-03 (46a.8, default chosen, owner to confirm): **the saved fields are per run**: `setSavedFields` lasts
  until the next restart (the component's `savedFields` again), like the overlay itself.
- 2026-11-03 (46a.9, default chosen, owner to confirm): **a lit prop's light shape is its collider, else its model's
  recorded bounds** (the phase-42 distance-field bricks are not at runtime: no brick data reaches the snapshot, so
  they would mean a new asset path; the plan's eventual source stays them). Primitives are exact; hulls, meshes and
  `_COL` parts stand as the box around their points in their own frame (over-covers a turned or concave hull a
  little); a model piece without a collider stamps nothing (its file's bounds would stamp the whole kit). Full
  rotation and non-uniform scale are taken in the shape's own inside test, so `propCoverageChunk` and `PropShape`
  stay as 45.6 built them.
- 2026-11-03 (46a.9, default chosen, owner to confirm): **moves are found by comparing each lit prop's world
  transform at every step's start** (no transform-change feed exists; a few hundred props cost a compose each a
  step), and **a step's changes are applied together** (each touched chunk rebuilt once). A whole chunk is rebuilt
  from all its props, not patched: 1 − (1 − a)(1 − b) rounded per byte cannot be undone exactly, and a rebuild equals a
  fresh build by construction. Every lit prop stamps every loaded world (each world's cell 0 is the world origin).
- 2026-11-03 (46a.9, default chosen, owner to confirm): **`ctx.voxels.coverageAt` reads the drawn derive result**
  (the committed one, also while an edit's rebuild is pending), so it agrees with what is drawn and collided; it is
  0 … 1 (bytes / 255), null off the ring or before the section's first result.
- 2026-11-03 (46a.10, default chosen, owner to confirm): **the Scene view streams voxel worlds in a worker of the
  editor page** (the world's streamer, its derive workers, the joins and batches there; the page only applies batches
  through Play's `VoxelWorldDraws`), focused on the orbit target (the point the view looks at, as Play's camera
  target), with the world object's own ring; no collision. The worker reads the backend's range route with the
  editor's token (same origin). All open scenes' worlds are drawn, each world once (its first object's settings, as
  the runtime). A world is read again whole when a `voxelsChanged` revision is missed. Worlds keep streaming while
  the Scene view is hidden behind the Game view (the worker settles and idles once the ring is in).
- 2026-11-03 (46a.10): the slice page keeps its own main-thread streamer and per-section measuring hooks; it shares the
  world opening (`RangeWorld`) and the change handling with Play and the editor, not the draw path (its chunk view is
  fed in-thread, `feedVoxelChunkView`), since its hooks read the streamer synchronously.
- 2026-11-02 (plan): M7 (cross-grid dependencies) stays the open contract gap recorded in spec §3.6, to be settled
  before 47a; nothing in 46a builds on structure grids.
