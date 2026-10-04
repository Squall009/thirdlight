# Phase 28b — Immediate block and texture fixes

Goal: fix what blocks Skyforge's block levels and its KTX2-only texture
flow today, before lighting (phase 29) and level building (phase 30) build
on top of it. Read `docs/roadmap.md` (principles 1, 1b and 7) first. Phase
28b starts after phase 28 (its full gate and independent review) and before
phase 29. Items are numbered `28b.N` because phase 28 already has an item
28.5.

Requests: Skyforge Tactics E79, E80 and the E40 differences
(`~/projects/skyforge-tactics/docs/engine-gaps.md`), defect D52, the phase-23
block leftovers, and the owner. The engine never reads the game repo; the ids
only trace a request back.

## 1. Owner decisions (2026-10-03)

- **Cells are square from above.** A block layer's `cellSize` must have
  x = z; only the height (y) may differ. Turning a block a quarter turn in a
  non-square cell can't fit the cell without distorting the look, and no grid
  game the engine targets needs it. This closes D52 by a rule instead of a
  mesher special case. Relaxing it later (with stretched turned looks) stays
  possible if a game ever asks.
- **No triplanar by default.** World-aligned block UVs use box mapping: one
  planar projection per face, one texture sample per layer.
- **Texture arrays must come from the KTX2 textures games already have.**
  Games are moving to KTX2-only textures (the Texture Designer exports KTX2);
  importing a PNG twice to feed the packer is not acceptable.
- **Performance targets are soft** (roadmap principle 7): measured and
  recorded with every item, a miss is a follow-up note, never a reason to
  throw an item away.

## 2. Where things stand (checked at `62999a04`, 2026-10-03)

- **Packing refuses KTX2.** `POST /content/textures/pack` reads PNG, JPEG or
  WebP sources and refuses a KTX2 one (`backend/src/content.ts:1382`).
  Importing a ready-made KTX2 array works (`asset-pipeline/src/images.ts:203`,
  `ktx2Info` accepts `layerCount ≥ 2`). The painted terrain material
  (`layeredMaterial`, `editor/src/session/material-graph.ts:411`) samples three
  arrays (albedo+height, normal, ORM), so changing one slot means packing a
  whole new set (+16.8 MB resident at 1024² per A/B trial, E79).
- **Block UVs.** The mesher has world-aligned planar UVs, in cell units, for
  colour stand-ins only (`project-model/src/block-mesh.ts:730`, `uvOf`). A
  model look always keeps its own UVs, and a piece without UVs gets (0, 0)
  (`three-adapter/src/block-layers.ts:181-192`). Kits with 0..1 UVs per cell
  show the same texture corner on every cell, and a texture larger than a
  cell seams at every cell edge (E80). Skyforge works around it with two
  shader graphs that rebuild box-projected UVs from the world position.
- **Layered material settings.** One `tiling`, `normalStrength` and
  `blendDepth` for all four layers (`material-graph.ts:417-444`), with tiling
  in UV units; no per-layer height contrast or offset. Skyforge suspects the
  Normal map node's green channel on painted terrain (E40, unverified).
- **Meshing.** `BlockLayerView.update()` (`three-adapter/src/block-layers.ts:326`)
  runs every frame but only re-meshes dirty chunks, synchronously on the main
  thread. That happens at load (every chunk), on an edit (the touched chunks
  and their neighbours), on a script's `ctx.grid` write in Play, and on a
  block-type change or a kit model finishing loading (the **whole layer**).
  A sloped 16 × 16 chunk takes about 55–100 ms (phase 27 bench), so the last
  two cause visible hitches in Play. Steady frames don't re-mesh.
- **Leftovers:** a prop footprint write is a second undo step, and deleting a
  prop doesn't clear its cells (phase 23 leftovers). A `surface` edit that
  re-bases a column doesn't say so (Skyforge E62 note).
- **D52:** a flat cell turned a quarter turn in a non-square cell is drawn and
  collides at its unturned size (`block-mesh.ts`, `classify`). `cellSize` is
  validated per axis only (`project-model/src/block-layers.ts:718-720`).
- three.js: `0.186.1` is pinned and is the latest release on npm
  (2026-10-03), so there is no update to take in 28b.0.

## 3. Items

Order: plan → square cells → texture packing → world UVs → layered material →
meshing off the frame → leftovers → acceptance. Additive optional fields
need no schema bump; the square-cell rule needs none either (no project has
non-square cells, and no data has to be preserved). Each item keeps the gate
green, has a Playwright test for any editor surface, and checks pixels on
both renderers where it changes drawing.

| Item | What |
|---|---|
| 28b.0 | This plan, its rows in `docs/STATUS.md` and `docs/roadmap.md`, the renumbering (docs → 31, decals → 32, occlusion → 33), and the three.js release check (none newer than r186.1). |
| 28b.1 | **Square cells** (D52). The block-layer validator refuses `cellSize` with x ≠ z (`field_value` naming both values and the rule); the Inspector's cell-size field edits x and z together; the mesher's non-square turned-cell handling goes (sloped cells' stretch-back included, now dead code). D52 closed in the audit as fixed by the rule. Unit test on the validator, an e2e on the Inspector field. |
| 28b.2 | **Texture arrays from KTX2 textures** (E79).<br>• Packing accepts KTX2 sources. When every layer of one role is UASTC with the same size, mip count and colour space, the layers are joined into one array **without re-encoding** (each mip level's zstd payload is decompressed, the layers concatenated, recompressed; texels unchanged, checked by a digest of the decoded levels).<br>• Otherwise (ETC1S, whose BasisLZ codebook is per file; a size or mip mismatch; a channel repack such as height into albedo's alpha) the layers are transcoded to RGBA in the KTX2 worker and encoded once. If the asset records a lossless source (`convertedFrom.sourcePath`, or a PNG of the same name beside it as 28.11 does), that source is used instead. The result says which layers were re-encoded (`packedFrom.layers[].reencoded`), and the editor's pack dialog shows it.<br>• **Per-layer slots:** the layered material may name single-layer texture assets per slot and role instead of whole arrays; Play and the export assemble the arrays from them (cached by the layers' digests), so an A/B trial changes one slot without a second array set. Prebuilt arrays keep working.<br>Tests: pack from UASTC KTX2 sources (bit-identical texels), from ETC1S (re-encoded, flagged), the per-slot material in Play on both renderers (pixels). |
| 28b.3 | **World-aligned UVs on block looks** (E80).<br>• A block type (and each variant) gets `uv: 'model' \| 'world'` (absent: `model`). `world` gives the look world-aligned UVs whatever its file holds; a model piece with no UVs takes the world fallback instead of (0, 0).<br>• Generated UVs are in **metres**, not cells, for stand-ins too (a 1 m texture spans 1 m on a 0.5 m-tall cell).<br>• **Box mapping**, chosen **per face** from the flat face normal (tops X/Z; walls facing ±X take Z/Y; walls facing ±Z take X/Y), vertices split where the projection changes, so no triangle mixes two projections. Sloped tops switch to the side projection past 45°.<br>• The mesher writes tangents per projection (tangent = +u in world space), so normal maps light correctly on every face.<br>• One texture sample per layer, as today; no triplanar.<br>Tests: unit tests on projections, seams across cells and the 45° switch; a pixel test where a 4 m texture runs across 4 cells without a seam, on both renderers. |
| 28b.4 | **Layered material, per layer.** Per-layer `tiling` (metres per repeat, now that UVs are metres), `normalStrength`, and height-blend `contrast` and `offset`, in place of the one shared value (old projects keep their look: the shared value fills each layer). **Normal-map green check:** a pixel test lights a known bump from a known side on painted terrain and on a plain material, on both renderers. If the Normal map node's tangent decode is wrong for flipY-off textures, it is fixed in the node, not in textures. |
| 28b.5 | *Moved to 28c (`docs/plan-phase-28c.md`, owner 2026-10-04); kept here for reference.* **Meshing off the frame.** Bulk re-meshing (layer load, a block-type change, a kit model finishing loading, a stream of runtime writes over a few chunks) runs in a mesh worker; the view keeps drawing the old chunk meshes until the new ones arrive, and swaps them in under a per-frame time slice. A small edit (a script's `ctx.grid` write touching a few chunks, an editor stroke preview) stays synchronous, so rendering, collision and queries still update in the same step (E8). Collision is untouched (the simulation already batches it per step). Diagnostics: chunks meshed per frame, worker queue length, longest main-thread mesh time. Soft target: no frame over 16.7 ms from meshing in the 29.1-style block class. |
| 28b.6 | **Block leftovers:**<br>• A prop's footprint write is part of the same undo step as the prop's move or placement.<br>• Deleting a prop clears the cells its footprint wrote.<br>• The `editBlocks` result carries a `rebased` count (columns whose top row moved under a `surface` or `sculpt` edit). |
| 28b.7 | **Acceptance.** Each item's acceptance as a test at its boundary; `docs/deployment.md` describes square cells, world UVs, per-layer settings, KTX2 packing and per-slot layers. |

**Done when:**
- A layered material built only from KTX2 texture assets (no PNG imported)
  renders painted blocks in Play and the export, on both renderers.
- A world-mapped block kit shows a texture running across cells with no
  seam, and normal maps light correctly on tops and walls (pixels; owner look
  pending).
- Loading a kit model or changing a block type in Play causes no frame over
  the soft target from meshing (recorded either way).
- `tools/gate.sh full` is green.

## 4. Progress

| Item | Status |
|---|---|
| 28b.0 | done 2026-10-03 |
| 28b.1–28b.7 | — |

## 5. Decision log

- 2026-10-03: planned with the owner while phase 28 finished. A separate
  phase rather than more phase-28 items, so phase 28 closes as reviewed and
  these fixes land before lighting and level building.
- 2026-10-03: D52 closed by requiring square cells (owner) rather than
  stretching turned flat looks.
- 2026-10-03: lossless joining applies to UASTC only. ETC1S layers from
  separate files can't be joined without re-encoding (BasisLZ shares one
  codebook per file), so they are re-encoded once and flagged.
- 2026-10-03: small runtime grid writes stay synchronous. E8 requires a
  destroyed bridge cell to update rendering, collision and queries in the same
  step; only bulk re-meshing moves to the worker.
