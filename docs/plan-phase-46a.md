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
| 46a.5a | not started |
| 46a.5b | not started |
| 46a.6a | not started |
| 46a.6b | not started |
| 46a.7a | not started |
| 46a.7b | not started |
| 46a.8 | not started |
| 46a.9 | not started |
| 46a.10 | not started |
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
- 2026-11-02 (plan): M7 (cross-grid dependencies) stays the open contract gap recorded in spec §3.6, to be settled
  before 47a; nothing in 46a builds on structure grids.
