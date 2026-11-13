# Duplication audit — what is built twice, what would be, and the shared foundations (2026-11-12)

**Status: research input, frozen once its phase is planned. Not a plan.** Input to 46f (the cheap merges, the culled table, the budget arbiter) and to every later phase: name the shared foundation before building. What is decided is in `docs/decisions/owner-decisions.md`; what is true now in `docs/architecture/voxel-engine.md`.

Four read-only audits of branch `phase-45` (around c2b0933a): the editor, the runtime and renderer, the data
model / commands / tooling, and the planned phases. Method: file headers, greps and line counts; few function
bodies were read, nothing was run or measured, line figures are `wc -l`. For the owner; not sent to the voxel
session.

## 1. Verdict

- **The editor is mostly shared already.** Brush settings, cursor, hotkeys and panel; the preview renderer; the
  node-graph canvas; asset pickers; project undo; the edit-mode shell: one implementation each.
- **One scene realizer, one voxel streamer construction, one content closure for Play and export.**
- **The renderer and runtime carry the real duplication:** seven instancing paths, about eleven
  "distance → level" functions, eight residency schedulers, seven kinds of worker host, eleven atlas
  allocators, thirteen uncoordinated per-frame time slices (worst case about 44 ms), nine or more independent
  memory budgets.
- **About 15–18 k lines go with phase 48 anyway** (blocks, heightfield terrain, architecture). Do not merge
  anything inside them.
- **The larger risk is ahead:** water, fog, vegetation, voxel lighting and culling would each build their own
  derive, camera-following window, far-cache channel, fill and instance path unless eight foundations are
  designed once (section 3).

## 2. What exists more than once (survivors of phase 48 only)

| Capability | Copies | Keep | Effort |
|---|---|---|---|
| Instanced drawing | `instancing` trio, `attribute-instancing`, `batching` + `static-merge`, `copies-gpu`, `cover-gpu`, `voxel-piece-batches`, `effects-draw` | the compute culled-instance table (`occlusion-instances.ts`) over `attribute-instancing` columns. **`copies-gpu` (trees) and `cover-gpu` (ground cover) are the only instanced draws not in it** | L, before vegetation |
| "In view first, a prefix per pass" ordering | `view-cull.ts` plus re-done in copies, kit pieces, terrain | `view-cull.ts` | M |
| Distance → level | ~11 functions | one screen-size helper with hysteresis for meshes, copies, vegetation; voxel rings stay | M |
| Residency (ring, priority, byte budget, eviction) | two `world-stream`s, texture streaming, probes, surface cache, voxel streamer, far field, scene read-ahead | the voxel `stream-ring` + `job-queue` core | M |
| Worker hosts | voxel `WorkerPool`, block mesh pool, architecture's, terrain, cover, scatter, KTX2, sim | the voxel `WorkerPool`; cover, scatter, decal clip become job kinds | M |
| Frame time slices | 13 wall-clock constants, no arbiter | one arbiter owned by the profiler (the `voxel-batch-stage` share model) | S–M |
| Memory budgets | ≥ 9 | one table in project-model, one resident-bytes report | S |
| Atlases and allocators | 11 | one 2D quad/buddy allocator, the 3D `VoxelShaderGrids` store, `RangeAllocator` | M |
| Partial upload / grow by copy | 5 `writeTexture`/`texSubImage` pairs, a `grow()` copied twice | one region-texture helper | S |
| Surface shading maths | material graph's triplanar, height blend, dither, noise vs the voxel surface's | graph nodes call the voxel functions | S–M |
| Grid ray walks | tracer CPU/WGSL, see-through occluders, `grid-walk`, `pickCell`, far march | one occupancy walk in `@thirdlight/voxel` | M, inside 48 |
| Brush stroke gesture | terrain, block, vertex paint, instance brush, decal scatter | one `BrushStroke` helper, extracted from the two that survive | M |
| Pointer → ray | ~10 copies, 7 raycasters | `SceneQueries` | S |
| Move/size/turn grips | descriptor handles, terrain stamps, decals, room walls, gizmo | a planar-rect handle kind in `handles.ts` | M |
| Number and colour fields | 35 raw number inputs, 12 raw colour inputs | `NumberField`, a new `ColorField` | S–M |
| Key handling | 19 window keydown listeners | a key-scope stack | M |
| Volumes | fog volume, probe volume (unused), camera region, climb volume, trigger, hitbox, wind zone, colliders | one `VolumeShape`; delete `probeVolume` | M |
| Texture sets | `textures`, `voxel.surfaces`, layered slots | one texture-set type inside `MaterialDef` | M |
| Kits | `setKit`, `setVoxelKit`, block "kits" | `voxelKits`; drop the prefix after 48 | S |
| Undo | project history; voxel undo (no redo, own revision) | keep both stores, one Ctrl+Z that dispatches | M |
| Backend jobs | five worker wrappers, no shared progress | one job runner: id, progress, cancel | M |
| Upgrades | project schema steps, content storage, sidecar, manifest, ~10 voxel format numbers | `liftVersion` as the one mechanism; a one-page version register | S–M |
| Query op list | defined three times | one list in protocol | S |
| Test and bench helpers | `serveDir` in 42 specs, a local command helper in 124, two backend starters, four static servers | one `tests/support` module, guarded by the redefinition check | S–M |
| Voxel world page | its own renderer, camera, picker, HUD and undo beside the Scene view's voxel drawing | the page stays a bench; voxel editing is built once as a Scene view tool | M |

Op catalogue (96 ops): ~13 `setX`/`deleteX` pairs could be `setRecord` / `deleteRecord`; ~10 project singletons
could be one `setProjectBlock`. Traps for an agent: argument nouns disagree (`setAnimator {controller}` /
`deleteAnimator {controllerId}`), three ways to remove something, two ops patch while the rest replace, voxel
ops take no `expectedRevision` and have no redo.

**Leave alone:** worker vs single-thread Play; the CPU twins of GPU passes (test oracles); the two decal modes;
the two effect previews; UI, graph and timeline snapping; shadows; the content closure; `paint-brush.ts`; a
wholesale descriptor-driven validator rewrite; everything retiring in 48.

## 3. Eight foundations to design once, before the systems that need them

| # | Foundation | Consumers | Natural home |
|---|---|---|---|
| 1 | **Derived-field service** from voxels (`surfaceFields`: height, slope, material, role, sky, water, fog, spline distance), one arithmetic for worker, shader and tests | vegetation rules, water, fog, `ctx.voxels`, far placement | opening of 47b |
| 2 | **Open-region labelling** (a walk through connected non-solid cells) | rooms, cut-away "enclosed air", audio room size, stream priority, and the water/fog fill (which my three notes named three ways: `flood`, `fillVoxels`, P2) | 46e, reused by 47b |
| 3 | **Far-node side channels + one bake runner** | liquid, fog summary, canopy stamps, baked occlusion: each proposed its own far-cache bump | before 49, on 46d.26's runner |
| 4 | **Camera-following window helper** (from `wind-field.ts`) | wind, interaction field, water ripples and info, fog density and sim | with the interaction field |
| 5 | **Regenerated structures** (definition → voxels + overrides) | buildings (47a), river and road splines, water bodies | 47a |
| 6 | **One culled-instance table** with LOD and thinning rank | trees, cover, impostors, kit pieces | before vegetation |
| 7 | **Budget table + profiler + frame arbiter** | everything; 46e's lighting choice is decided by GPU ms | before 46e |
| 8 | **World edit mode on the existing brush kit**, with `BrushStroke` and voxel picking in `SceneQueries` | sculpt, material paint, liquid and fog fill, splines, rule preview | 47b |

## 4. Plan changes that remove duplication

- 47b's "scatter and rules", plan 45 §7a's deferred dressing and vegetation V3–V5 are one item. Resolve first:
  §7a says no persistent per-instance exceptions; the vegetation note keeps hand-placed and removed lists.
- The fill and river-as-structure move from water (49.3) into 47a/47b; 49 keeps the derive, shader, queries and
  buoyancy.
- 46e: start with the grid walk and region labelling; measure connectivity culling against the depth pyramid
  before building it (likely cut as a draw-culling path; keep rooms for light, cut-away and audio).
- 48a's `ctx.grid` wrapper depends on 46e's walk graph: say so in both.
- 47c's world map is the far field seen from above in the Scene view, not a new renderer.
- Independent now: the liquid shader, lit fog volumes in the fog node, impostor atlases.

## 5. Stale text that would mislead the next session

- `plan-phase-45.md`: §1/§1d (projected/modular split, paint overlays per vertex), §2 meshing and LOD table
  (piece LODs, mesh HLOD, "brick renderer experiment, not the plan"), §4/§7a detail-piece LODs and displacement,
  §5 far-field default meshes, §5c saved bake for WebGL 2, §8 water rendering and simulation, §9 one occupancy
  bitmask.
- `plan-phase-46d.md` §1 scope and §5 code homes (relief, both far fields, both renderers). Relief and mesh-far
  code is still present behind switches.
- `roadmap.md`: walk graph listed under 46d; the Future water bullet.
- `docs/research/voxel-vista-performance.md` §3 WebGL 2 workarounds, §4 steps 5–6.
- Headers: `store-v4.ts` says version 7, `project-v4.ts` says 3, `play-content.ts` names functions that are gone.

## 6. Still true from earlier consolidation audits

Room edits are computed only in the browser (G13): the 47a structure tool must be commands. Nothing has
retired yet, so both the old and voxel stacks are carried until 48b. 19 voxel-related format version constants
and 14 owner notes in the spec: a one-page register would help. `three-adapter/src` is 286 flat files.

## 7. Rough size of what could go (non-test lines, from file sizes)

With phase 48: 15–18 k. With WebGPU-first, if the fallback may degrade further: 3–5 k. By merging: 2–3 k.
