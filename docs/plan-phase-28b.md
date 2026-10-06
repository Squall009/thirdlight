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
| 28b.1 | done 2026-10-06: validator refuses x ≠ z, Inspector ties x and z (`same` on vec descriptors), sloped stretch-back removed; D52 closed. `perf blocks` before → after (p95 / worst ms): scene block change webgpu 17.5/18.3 → 17.5/19.7, webgl2 17.6/19.6 → 17.6/18.2; export grid writes webgpu 6.0/13.4 → 6.0/15.6, webgl2 8.4/232 → 8.9/231 (noise). Fast gate's village perf check RED on webgpu p50 (7.5 ms vs limit 7.26) — clean HEAD 0c04d623 measures 7.7 ms too, so it predates this item (baseline recorded before 28c.15). |
| 28b.2 | part A done 2026-10-06: the pack route takes KTX2 sources; whole UASTC layers alike are joined as stored (level digests and transcoded texels equal the sources', vitest + e2e), else transcoded (or their PNG read) and encoded once with `packedFrom.reencoded` per layer, shown by the pack dialog. 4 × 1024² UASTC: joined in 14 ms (187 KB) vs 26.9 s encoding the same from PNG (187 KB); 4 × 1024² ETC1S re-encoded from KTX2 8.7 s (494 KB; from PNG 10.1 s, 474 KB). Part B done 2026-10-06: a texture parameter's default or an instance's value may be a list of single-layer textures; the Scene view, preview, Play and export draw one array assembled by the backend and cached in the import cache by the layers' digests (export ships `slots-…` arrays, not the slot textures). 4 × 1024²: UASTC joined 14 ms, ETC1S encoded 8.6 s, cache hit 0.2 ms; an A/B one-slot swap assembles one array (12 ms / 9.6 s) = +5.6 MB resident instead of a second three-array set (+16.8 MB; computed at 1 B/texel with mips, not measured in a browser). Pixel e2e (slot 3 = layer 4's texture) green on WebGPU and WebGL 2. |
| 28b.3 | done 2026-10-06: `uv: 'model' \| 'world'` on block types and variants (Blocks panel form, MCP); box mapping per flat face in metres from the layer origin, vertices split per projection, 45° switch, tangents along +u; pieces without UVs take world ones. Pixel e2e (4 m ramp over 4 cells, no seam) green on WebGPU and WebGL 2. Mesh time per sloped smoothed chunk (blocks ground, Node) 22.0 → 21.2 ms stand-ins, 22.6 ms world + tangents; `perf blocks` p95/worst scene type change webgpu 17.5/18.2 → 17.6/20.6, webgl2 17.6/17.9 → 17.4/17.8; village p50 webgpu 6.3 → 6.2, webgl2 4.3 → 4.2 ms (noise). |
| 28b.4 | done 2026-10-06: per-layer tiling (m), normal strength, height contrast/offset as vec4 parameters of the template, a Layers table in the Material editor, Height blend `contrast`/`offset` inputs; old layered materials keep cell-unit repeat on non-1 m cells. Normal-map green was wrong on every engine surface (92 vs 169 brightness, both renderers): fixed in the decode and the mesher's tangents; pixel e2e green on WebGPU and WebGL 2. Village p50/p95 webgpu 6.3/7.8 → 6.3/7.9, webgl2 4.2/6.9 → 4.4/6.9 ms; `perf blocks` scene type change p95/worst webgpu 17.5/18.0 → 17.6/19.5, webgl2 17.6/17.9 → 17.4/18.3; export grid writes p95 webgpu 6.0 → 12.9, webgl2 8.2 → 11.3 ms (fewer frames sampled in that run; recheck). Recheck of grid writes (lead, alone on the host): p95 5.7 ms WebGPU, 7.6 ms WebGL 2 — the rise was noise. |
| 28b.5 | moved to 28c (28c.10) |
| 28b.6 | done 2026-10-06: the command layer writes a prop's footprint with whatever entity command places, moves, turns, re-sizes or deletes it (one revision, one undo step; the change names `footprints` chunks, clients re-read them); the editor's follow-up `editBlocks` is gone. `editBlocks` reports `rebased` for surface/sculpt edits. vitest (commands) + block-editor e2e (Ctrl+Z/Ctrl+Y of a gizmo move, MCP delete + editor undo). Village p50/p95 webgpu 6.3/7.8, webgl2 4.4/6.5 ms (no drawing change). |
| 28b.7 | — |

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
- 2026-10-06: village perf baseline re-recorded at `9a314cf6` because the
  host drifted, not the code: the baseline's own commit `d6197b3e` measures
  WebGPU p50 7.7 / 7.9 ms today (6.5–6.6 ms when recorded 2026-10-05), HEAD
  7.6 / 7.3 ms; `08aaeab7` itself went 6.0–6.4 → 7.5–8.1 ms between runs at
  ~02:00 with no code change; plain three.js page unchanged (6.2–6.5 ms).
  Baseline WebGPU p50/p95 6.6/8.1 → 7.5/9.4 ms, WebGL 2 4.1/6.8 → 4.2/6.8 ms.
  Default chosen, owner to confirm.
- 2026-10-06 (28b.2 A): `packedFrom.reencoded` is one boolean per layer
  beside `layers` (the plan's `layers[].reencoded` can't hold a field: a layer
  is its [R, G, B, A] list). True only for a layer read from texels
  transcoded out of a KTX2 with no lossless original; joined layers and
  layers from PNG/JPEG/WebP or a found PNG are false. The pack dialog now
  stays open after a pack to show this. Default chosen, owner to confirm.
- 2026-10-06 (28b.2 A): a join needs the sources' colour space to be the
  encoding's (sRGB for colour, linear for normal map / data); a joined colour
  array stays UASTC (not ETC1S). Only a PNG counts as a lossless original:
  the import's `convertedFrom` PNG with its recorded digest, or a PNG of the
  same name and size beside the KTX2 file. A join holds at most 256 MiB in
  its largest level (64 layers of 2048²); the encoder's 12 Mpix limit does
  not apply to it. Texture arrays and cube maps are refused as sources.
  Default chosen, owner to confirm.
- 2026-10-06 (28b.2 B): per-layer slots are the texture parameter's value
  itself (a list of ids in `default` or an instance's `values`), not a new
  field, so an A/B instance changes one slot; object overrides stay one
  texture. An empty slot takes the first filled slot's texture (an array
  needs every layer; the join stays possible). A slot is a plain texture,
  taken whole (an albedo + height slot holds the height in alpha; no
  per-slot channel repack). The array's encoding follows the graph (Normal
  map node → normal, linear Sample texture → data, else colour). Arrays live
  in the import cache (`texture-slots-1`, keyed by the layers' digests,
  encoding and encoder); the export names them `slots-<digest>`. The Scene
  view and preview fetch the same array through
  `POST …/content/textures/slots`. The editor may value-import
  `@thirdlight/project-model/texture-slots` (a new pure subpath in the
  boundary table). Default chosen, owner to confirm.
- 2026-10-06 (28b.3): world UVs are metres from the layer's origin (the min
  corner of cell 0), not absolute world: chunks are meshed layer-local and a
  layer only moves, so two layers whose origins differ by a non-multiple of a
  texture's repeat meet with an offset. Signs: every face shows the image
  upright and unmirrored from outside for textures as the engine loads them
  (flipY off, v = 0 the top row): tops u = x, v = z (image top toward −Z),
  bottoms u = x, v = −z, walls v = −y with u to the viewer's right (+X walls
  u = −z, −X u = z, +Z u = x, −Z u = −x). The old stand-in mapping (cells,
  v = +y, chosen per vertex normal) is replaced; at an exact 45° the top
  projection wins. A variant's `uv` overrides its type's; a type stores only
  `world`, a variant either value. Stand-ins are always world-mapped.
  Tangents are written only where they can be read: world-mapped model looks
  and stand-ins with a `materials` mapping (a plain coloured stand-in is
  Lambert, no map); model-mapped looks keep none (the shader derives the
  frame from the UVs, as before), also where a piece without UVs takes world
  ones. The tangent's handedness matches three.js's derived frame
  (cross(n, t) × w = +v), so a material lights the same with or without the
  attribute; the normal-map green convention stays 28b.4's check. Default
  chosen, owner to confirm.
- 2026-10-06 (28b.3): existing projects. Skyforge's block types are all
  model looks without `uv`, so they draw as before (unless a kit piece has
  no UVs: it now shows world-mapped texture instead of the texture's corner
  colour); Sprout has no block layers. A stand-in with a textured mapped
  material (none in either game; the engine's painted-terrain tests) now
  repeats per metre instead of per cell (the same on 1 m cells; twice as
  often on 2 m cells) and its walls' image is flipped upright. Stand-in
  layers mesh to the same positions, normals and indices byte for byte (the
  pinned digests without UVs match); only UVs changed. Accepted: default
  chosen, owner to confirm.
- 2026-10-06 (28b.4): per-layer settings are four vec4 parameters of the
  layered template (`layerTiling` metres per repeat, `layerNormalStrength`,
  `layerContrast`, `layerOffset`; one component per layer, every layer
  filled alike), not separate fields: a material is a graph, so instances,
  object overrides and scripts reach them like any parameter, and they are
  uniforms (twelve texture reads, as before). The Height blend node gets
  `contrast` and `offset` inputs (height' = (h − 0.5) × contrast + 0.5 +
  offset); unwired they change nothing, so older graphs compile to the same
  shader. The new template drops the shared `tiling` and `normalStrength`
  (`blendDepth` and `wetness` stay shared). A layered material made before
  keeps its stored graph (no rewrite): its shared values are what every
  layer uses, as before; the editor's Layers table shows only for materials
  with the vec4 parameters (no in-place upgrade; make a new one from the
  template). Default chosen, owner to confirm.
- 2026-10-06 (28b.4): old projects' repeat after 28b.3's metre UVs. A
  material whose graph is the old template's shape (UV0 × the `tiling`
  parameter, with a Height blend; `readsCellUv`) is flagged when compiled,
  and on a block layer whose cells are not 1 × 1 its stand-in chunks get
  their metre UVs divided back into cells (u by the cell width, v by the
  width on tops and by the cell height on walls, tops told apart by the
  vertex normal's main axis as the old mapping did); the metre UVs stay with
  the mesh and come back if the material changes. So the old `tiling` repeats
  per cell as before on 2 m cells and on 0.5 m-tall walls (vitest: one UV
  unit per cell on a 2 × 0.5 × 2 m layer). Not restored: the wall image's
  orientation (28b.3 turned it upright) and the 45° top/wall switch; any
  other material reading stand-in UVs (a hand-made graph, a standard
  material with a texture on stand-ins) repeats per metre now. On 1 m cells
  nothing changes. Skyforge's terrain builds its UVs from the world position,
  so it is unaffected. Default chosen, owner to confirm.
- 2026-10-06 (28b.4): normal-map green (E40). Measured before the fix with a
  normal map tilted toward the image's top (OpenGL / glTF convention, what
  the Texture Designer writes): every engine-made surface lit it from the
  wrong side on both renderers — painted terrain, a plain graph Normal map
  node and the standard shader on block cells (mesher tangents) and on boxes
  (frame derived from UVs): brightness from −Z/+Z 92/169 where 169/92 was
  right. Cause: textures load with flipY off (v = 0 the top row, as glTF),
  and three.js's derived frame has its bitangent along +v, down the image;
  28b.3's tangents copied that handedness. three's glTF loader turns
  normalScale.y around for meshes without tangents; the engine did not.
  Fixed in the decode, not in textures: the Normal map node multiplies y by
  a per-mesh sign (−1 where the mesh has no tangents; three builds a program
  per vertex layout), the standard / foliage / kit / water shaders build a
  material per tangent frame with normalScale.y negative where it is derived
  (as the glTF loader does; a model's own sign is no longer inherited), the
  mesher's tangents take glTF's handedness (bitangent up the image), and the
  kit template decodes through Normal map nodes. glTF models' own materials
  were and stay right. The shader-parity references stay as frozen: their
  synthetic bump maps store y negated so the same bumps light the same.
  Normal maps authored to look right under the old reading need their green
  turned around; Skyforge's painted terrain (E40) should be looked at again.
  Default chosen, owner to confirm.
- 2026-10-06 (28b.6): footprints are written by the command layer after
  any entity command, not by the editor: the step compares each
  `blockFootprint` prop's world position, rotation and component before and
  after the command, so a gizmo move, an MCP `setTransform`, moving the
  prop's parent, setting or changing the component, placing (paste,
  prefab) and deleting all move the footprint in the same revision and undo
  step. MCP moves now write footprints too (before, only the editor did).
  A prop moved to another scene leaves its cells; moving a layer moves no
  footprint. Clears run before writes, so a prop leaving cells another prop
  also covers clears the shared fields there (as before). A footprint whose
  field is outside the cell schema refuses the command that would write it
  (the error names the layer) instead of failing a second request later. A
  prop above the cells writes metadata-only cells where its base is, as the
  editor did. The history entry keeps each written layer's entry before and
  after (as `editBlocks` does); the change carries
  `footprints: [{entityId, chunks, regions}]` on any change type. The
  Inspector's "Write to cells" stays, to write the footprint again after the
  cells were edited by hand. `rebased` counts distinct columns whose top row
  differs after the command from before its first surface/sculpt edit; it is
  present only when the command had such an edit (0 included). Default
  chosen, owner to confirm.
