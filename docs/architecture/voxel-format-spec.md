# Voxel world formats — spec v1

Status: **v1 — APPROVED by the owner on 2026-11-02**, as revised after the owner's review (45.10a: value v2, masks, overlay, climate; 45.10b: mesh format v2, shader data, blending in the shader; 45.10c: derive sections and atomic swaps, R107–R110; R111–R112). Later changes are add-only versions through the upgrade registries.

Phase 45 drafted this spec ([plan](../plan-phase-45.md) §3). It describes the code on branch `phase-45`
(`packages/voxel/src`, `@thirdlight/voxel`) as it stands, byte for byte where something is a byte format. The
numbers come from the plan's results subsections (45.1 to 45.9). Anything the plan calls unverified is unverified
here too. Where this file and the code disagree, the code is what runs, and the disagreement is listed in §7.
The requirement list lives in [voxel-format-requirements.md](voxel-format-requirements.md); R-, O- and Q-ids
refer to it.

---

## 1. Summary for the owner

### What is stored

The world is a grid of 0.5 m voxels. Each voxel is **one 32-bit value** (owner 2026-11-02, §2.2):

- a **material** (12 bits, 4,096 a world; 0 means air);
- a **role** (4 bits): air, terrain, liquid, wall, floor, roof, foundation, stair, pillar or opening;
- a **shape**: 16 fill levels (4 bits), inside the value for every voxel;
- a **wetness** (3 bits), which only changes shading;
- 9 **reserved** bits (0; the shoreline liquid level, O15, is the first candidate).

There is no orientation. Beams, banisters, posts and the other architectural details are **not stored**. They are
worked out from how the voxels sit next to each other, every time the world is rebuilt (§3.7). Water is ordinary
voxels with the liquid role. Temperature and humidity are a coarse climate field per region, not in the voxel (§2.4).

- **Chunks.** Voxels are grouped into cubes of 32 × 32 × 32 (16 m), called chunks.
- **One value per voxel, one palette per chunk.** A chunk keeps a palette of the values it uses; a partly full
  cell is an entry of its own.
- **Simple chunks cost almost nothing.** A chunk that is all air is not stored at all. A chunk that is one value
  everywhere (deep rock, a solid wall) costs 12 bytes on disk.
- **Region files.** On disk, chunks are grouped into region files of 256 m stacked cubes (owner). A world grows
  tile by tile.
- **Authored base, runtime overlay.** Shipped files hold the full value; a running game keeps its changes in an
  overlay of the same values (§2.3). **Saves hold only player changes**, of the fields the game marks saved (default:
  all but wetness), each chunk compared against the shipped world. A building's hand edits are kept apart from the
  voxels it generates, as overrides.
- **Which outputs a change touches.** Shape and role drive meshes, collision, navigation and light; material and
  wetness only the shader data (§2.2), so rain or a repaint re-derives nothing but that: meshes carry no material,
  and the surface shader blends the materials it reads from the shader data (§3.7, 45.10b).
- **Never stored.** Meshes, collision, the walk-graph input, light occupancy, shader data, the low-detail far-field
  levels (mips) and prop light coverage are always rebuilt and never stored.

### How big

All test worlds are synthetic, engine-owned and swept whole (value v2, 45.10a; the v1 draft's numbers in brackets).
The "on disk" column is the zstd chunk bodies.

| Test world | On disk | In memory, if all loaded | Notes |
|---|---|---|---|
| plain ground, 256 m | 2.3 MB/km² (4.5) | 1.6 MB (2.1) | ground 64 m deep |
| hilly, 2 × 2 km | 6.0 MB/km² (6.9) | 172 MB = 43 MB/km² (163) | 77 % of chunks uniform |
| town, 256 m (+11 rotated houses) | 2.2 MB/km² (2.3) | 2.0 MB (2.0) | walls, floors, roofs, banisters, beams |
| caves, 256 m | 50 MB/km² (58) | 13.5 MB (15.4) | 3D overhangs, tunnels and caverns |
| vertical, 256 m × 2 km tall | 157 MB/km² (192) | 45.5 MB (55.1) | a mountain, deep caverns and a 300 m tower |

- **Memory.** 0.04–0.24 bytes a voxel. The plan's target was about 4 bytes.
- **Folding the shape into the value** grows the palettes (plain 3.0 → 7.5 entries a mixed chunk, hilly 4.1 →
  13.6, caves 3.9 → 20.4) and drops the density bytes: zstd bytes fall 2–48 %; memory falls 2–24 % except on hilly
  ground (+6 %: wider brick ids where the slope meets air). Wetness and 3-bit shapes: plan **45.10a value v2**.
- **A whole 10 × 10 km world** of plain to hilly ground projected (v1) to **430–580 MB** in 1,600 tiles; v2 bodies
  are 13 % smaller on hilly ground. Mountains, caves and dense towns raise that. No 10 km world was built.
- **Git.** A scripted hour of heavy editing (1,200 strokes) grows the packed history by 0.13–0.22 MB (v1), because
  git stores each new file version as a small delta. **No Git LFS is needed.**

### How fast

The measurements ran on this host (i5-12600H, Iris Xe), in Node or headless Chrome. Most were taken on the v1 draft; the value v2 re-run of
the storage harness (plan **45.10a value v2**) decodes a chunk 11–21 % faster in Node (74–330 µs), encodes 3–6 %
faster, and keeps random `voxelAt` at 33–121 ns and stroke costs within ±12 %. The low-tier budget is the
budget the streaming core uses for the Iris Xe floor.

**Reading a voxel**
- `voxelAt` at a random spot: 35–111 ns.
- Reading along a column: 13–22 ns a voxel.

**Editing**
- One voxel: 2.7–5.6 µs as a command.
- A 4 m brush dab: 68–102 µs.
- A 16 m box fill: about 5–5.7 ms.
- Undo memory: 22 bytes for one voxel, 1.5 KB for a 4 m dab, 45–60 KB for a 16 m fill. Undo history is limited
  by a 64 MiB memory budget, not by a step count, and spills to disk beyond it.
- Saves stay small: **303–497 KB** after 1,000 heavy strokes, the cells each entry changed included. Writing one
  takes 8–11 ms, reading one 14–19 ms.

**Decoding a stored chunk in a browser worker**
- zstd: 4–53 µs (fzstd).
- Palette decode: 46–190 µs.
- In the streaming page the whole job took 75 µs of zstd plus 290–315 µs of decode (median).

**Streaming** (Chrome, Iris Xe, 720p at the 60 Hz cap, both renderers, the hilly world over HTTP range requests on
localhost)
- Frame time p95 16.67 ms.
- At most one missed frame in 3,600: the first draw.
- No chunk was missing within 96 m at 40 and 80 m/s.
- The loaded ring used 9–10 MB of the 256 MiB low-tier budget.
- **D432 (fixed in 46a):** with 40 ms of added network latency the near ring emptied. Fewer, wider reads (whole
  columns and their row neighbours, a 16 KB gap, 8 reads) and prefetching 1 s along the motion keep it full at
  80 m/s on both renderers, at 1.4× the localhost bytes.

**Rebuilding derived data**
- 0.5–3.4 ms a chunk (median, Node, reference mesher).
- The shared assembly step is about 0.2 ms of that.
- **Per section (45.10c, owner 2026-11-02):** the derive unit is a 16³ section of a 32³ chunk (§3.6); one edit's
  sections swap in together, meshes and colliders in the same frame. In the slice page (Iris Xe, 720p at the cap):
  a local 1–4 m blast on terrain shows the next frame, 8 m the frame after; the reference mesher takes 0.1–0.2 ms a
  section (p50; p95 0.6–0.8). Big blasts in the town take 3–5 frames, the page's per-section objects and bodies
  (D440).

### What was rejected, and why

| Option | Why it lost (measured) |
|---|---|
| Plain bit-packed palette in memory | 1.7–3.1× the memory of 4³ bricks |
| Bricks as the on-disk body | zstd output 3–36 % larger than the packed body |
| Vertical run-length per column | Memory: +4–62 % on plain, hilly and caves (−13–19 % in town and vertical). Strokes: 1.4–3.7× slower. On disk: 2–47 % larger after zstd and 2–28 % larger after lz4 |
| One palette per field | 1.2–1.6× the memory, 1.1–1.7× the zstd bytes |
| 16³ chunks | 7.5× the chunk count and 1.2–3.2× the bytes on disk. Its one win: 3–5× fewer cells re-meshed per edit |
| lz4 | 1.2–1.8× the bytes, to save 3–31 µs a chunk |
| Per-chunk deflate in the browser | 160–190 µs a chunk just to start the stream |
| zstd dictionary | Saves at most 2.4 %, and the browser decoder cannot use one |
| One zstd stream per region file | Saves only 1.8–2.3 % on hilly ground, and loses reading single chunks |
| 512 m tiles | A save rewrites 4× as much (1.45 MB instead of 363 KB for one voxel); loose git growth is 3× |
| Git LFS | Stores every version whole, with no deltas: 7–22 MB an hour, kept forever |

### Plan decisions that did not pan out (replacements accepted by the owner, 2026-11-02)

Under the plan's rule, these were **not dropped**: each kept its goal through a replacement, and the owner
accepted all four on 2026-11-02 (D432 stays open for 46a's tuning).

1. **R18, vertical run-length per column → bit-packing plus a general compressor (zstd).**
   - *Goal kept:* plain ground costs about what a height map costs. It is 4.3 MB/km² either way.
   - *Why the change:* runs cost as much memory or more and make strokes slower (table above).
   - *Cost of the replacement:* none measured. Runs stay possible only where no compressor runs, and they lose
     there too.
   - **Accepted (owner 2026-11-02).**
2. **R50, full-height region columns → stacked 256 m cubes.**
   - *Goal kept:* no height limit, and small commits.
   - *Why the change:* on the 2 km tall world a column file is 12.3 MB, and a one-voxel save rewrites all of it.
     With stacked cubes it rewrites 1.47 MB, and files stay under 2.7 MB.
   - *Cost of the replacement:* twice the files where ground crosses a stack boundary (hilly world: 64 → 128
     files), and +0.1 % bytes.
   - Both layouts are in the format; the code uses stacked.
   - **Accepted (owner 2026-11-02).**
3. **R79, one shared occupancy bitmask for every system → one assembly evaluation, then a separate output per
   consumer.**
   - *Goal kept:* cheap, exact grid queries per chunk.
   - *Why the change:* a beam or a rail must block movement but not light or sight, and must not be stood on. One
     bitmask cannot say that.
   - *The replacement:* separate outputs for rendering, light, navigation and collision.
   - *Cost:* 0.5–4.3 KB of light, 0.8–3.7 KB of navigation and 0.6–2.6 KB of occupancy a chunk, instead of one 4 KB
     mask, plus about 0.5 ms a chunk.
   - **Accepted (owner 2026-11-02).**
4. **R66, streaming exports by HTTP range with the default read settings → batched, wider reads with prefetching
   along the motion** (D432).
   - *Goal kept:* exports stream on demand.
   - *Why the change:* 4 reads in flight with a 4 KB gap empty the near ring at 40 ms latency. A 64 KB gap fills it,
     but fetches 9× the bytes.
   - *The replacement:* not a format change; the region table already allows any range. Built in 46a (D432 fixed:
     0 near-ring holes at +40 ms, 1.4× the bytes).
   - **Accepted (owner 2026-11-02).**

**Not failures, for completeness.** §7a revised these by direction, not because a measurement failed:
- R12 and R13 (per-cell roles, rules only in the tools) became inferred architecture;
- R11's "role" became a stored coarse category, and in v2 (owner 2026-11-02) a stored role again (§2.2);
- R83 (an edit rebuilds only its own chunk) became a dependency radius;
- R86, R87 and R88 are kit and mesh topics for 46b/46c.

The brick ray-marched far field was moved to 46c by the owner (2026-10-28; 46d since the renumbering of 2026-11-02); it was not tried in 45.

### What the owner decided (2026-11-02), and what is still open

**Decided:** the four replacements above; the value v2 (§2.2) with the role set, no orientation and 12-bit
materials; one value everywhere with an authored base and a runtime overlay, the feeds mask and the game's
saved-fields mask (§2.3); material blending in the shader (45.10b), fed by the derived shader data (§3.7); climate as
a coarse per-region field (§2.4); the game decides how a re-exported base affects saves (H1/H2 as built); the world
layout and scale, the editing rules (including `world_changed` refuse-after-reload) and the remaining §5 defaults.

**Decided 2026-11-02 for the phases after 45 (R107–R110):** remesh within a frame (derive sections, atomic swap,
reads at once; built in 45.10c), a terrain mesher sub-phase before kits (46b), dynamic LOD over voxel mips (46b),
lighting chosen performance first (46e).

**Open, and not part of v1 yet:**
- dependencies across grids (M7): the job contract's keys, aprons and invalidation are per grid (§3.6 open contract
  gap, with the planned design, before 47a);
- shoreline cells that are both ground and water (O15): the first candidate for the reserved bits;
- a sparse GPU form of the shader data (§3.7: 3–6× smaller than the dense grids, one more read per corner),
  measured but not built.

---

## 2. Coordinates, bounds and the voxel record

### 2.1 Coordinates (`coords.ts`)

- **Voxel size.** `VOXEL_SIZE_M = 0.5` m, the same in the world grid and in every structure grid. It is defined
  once.
- **Integer cells.** Every address is an integer cell, never metres.
  - x and z: −32,768 … 32,767 (±16.4 km).
  - y: −8,192 … 8,191 (±4.1 km).
  - A 10 km world fits centred or cornered. A 2 km tall world fits anywhere around y = 0 with as much headroom
    again.
- **No world base or height in the format.** A world's extent is simply the chunks it has; empty sky and depth
  cost nothing.
- **Chunks.** The chunk edge is 32 cells (16 m). The code also takes 16, used only for measurement.
  - A cell's chunk is `cell >> 5`; its place inside the chunk is `cell & 31`, which rounds towards −∞.
  - **Local index:** `(lx · E + lz) · E + ly`. y is fastest, so a vertical column is contiguous in memory.
- **Chunk key.** `((cx − minX) · spanXZ + (cz − minZ)) · spanY + (cy − minY)`, an exact integer below 2^35. Keys
  sort by x, then z, then y.
- **Regions.** A region is 512 cells (256 m) a side. The code also takes 1,024 for comparison.
  - Column layout: index (rx, rz).
  - Stacked layout: index (rx, ry, rz), with 16 chunks (256 m) a stack, aligned at y = 0.
- **Structure grids.** Each structure has its own grid with a numeric grid id (≥ 1; the world grid is 0). It uses
  the same cell bounds and the same chunk and region math in its own local frame. The transform (position and yaw)
  is not stored in voxel files; it belongs to the structure record (47a).
- **Floating origin (§3.6).** Authoritative positions stay integer cells and 64-bit metres. Only 32-bit consumers
  (the GPU, physics) work relative to a moving origin.

### 2.2 The voxel value, v2 (owner 2026-11-02; `record.ts`)

Every voxel is **one 32-bit value**. Palettes, aprons, cell deltas, region uniform entries, saves, overrides and the
runtime overlay all hold whole values, so reading or writing a voxel is one 32-bit load or store.

| Bits | Field | Values | Notes |
|---|---|---|---|
| 0–11 | material | 0 = air, 1–4,095 (`MATERIAL_ID_MAX`) | 4,096 ids a world: a format width, not a count cap on anything else (O12, owner). The id refers to the material record (46d) |
| 12–15 | role | see the role table; 10 assigned, 16 at most | Unassigned values are refused by every writer and reader (`VOXEL_ROLE_COUNT`) |
| 16–19 | shape | 0 empty … 15 full (`SHAPE_FULL`) | 16 levels, stored for every voxel inside the value: the fill for terrain, the fill level for liquid, the **integrity** for construction roles (wall, floor, roof, foundation, stair, pillar: 15 intact, lower a damage stage, air broken; owner 2026-11-04, no new bits; §3.7 *Kits*). Derived consumers read it on a 0–255 scale (`shapeDensity` = shape × 17) |
| 20–22 | wetness | 0 dry … 7 (`WETNESS_MAX`) | Feeds the shader data only. Authored in base files, set at runtime in the overlay. The shader darkens albedo, lowers roughness and fills in normals as it rises (R111; the 45.10b slice shader only darkens) |
| 23–31 | reserved | must be 0 | 9 bits. A value with any set is refused everywhere raw values are read. O15 (shoreline / liquid level in a ground cell) is the first candidate |

**Roles** (`VOXEL_ROLE`; what a stored voxel is for):

| Value | Role | Placeholder rules (§3.7) |
|---|---|---|
| 0 | air | open, empty |
| 1 | terrain | ground |
| 2 | liquid | open, liquid |
| 3 | wall | built |
| 4 | floor | built |
| 5 | roof | wall class |
| 6 | foundation | built |
| 7 | stair | built |
| 8 | pillar | built |
| 9 | opening | open, empty (the door or window is a kit piece) |

Beams, banisters, posts, soffits and mouldings are **not roles**: the assembly rules infer them from the
arrangement, every time (§3.7). The role set is what the stored value says about intent (Q-a, owner); what each role
means to a case is 46c's catalogue.

**Orientation is not stored** (O8 closed). A structure's grid carries its rotation (§1e, 47a); a stamp is rotated
before it is voxelized (its command carries yaw and scale, §3.3); everything finer comes from the arrangement.

- **Air is one value.** Material 0 means air, and the whole value is then 0. Writers clear the other fields (the
  store's `setVoxel`, the cell delta, the commands, `valueOf`), and every reader refuses a material-0 value with any
  other bit set.
- **Every field is checked** before it is packed (`checkVoxel`, the codec's `checkField`) and every raw value after
  it is read (`checkRecordValue`): a role past the assigned set, a reserved bit, or air that is not 0 is refused. A
  refused region table refuses the file, so its chunks are reported damaged.
- **Record value form 2** (`RECORD_VALUE_FORM`, `checkValueForm`). Every format that stores raw values outside the
  chunk codec names the form it holds: the region file (header byte 10), the undo record (byte 7), the save (byte 8)
  and the structure overrides (byte 6). Form 2 is the u32 above. Form 1 (the draft 23/4/5 value with the shape beside
  it) was never approved and is refused. A later per-voxel field takes reserved bits inside form 2's u32 and is read
  through the format versions that write it; a new form is needed only if the value outgrows 32 bits. Forms that only
  cross threads inside one build (the chunk wire, aprons, job messages) are never persisted and carry no form.
- **What it costs.** Before → after on all five test worlds: plan **45.10a value v2** (memory, bytes per voxel,
  palette sizes, zstd size, encode/decode and edit costs; 3 vs 4 shape bits; wetness none / authored patches / a
  rain pattern) and §1.
- **Q-a contract (owner).** The stored intent the derived-data pipeline needs is role plus material plus shape. The
  placeholder rules read only the role; the geometry consumers add the shape; only the shader data reads material
  (and wetness), and the surface shader blends from it (45.10b). A house written by its generator and the same voxels written as runtime `fill` or `set`
  commands derive to identical bytes (`derived.test.ts`, `voxel-world.e2e.ts`).

#### The feeds mask: which derived outputs a field drives (`FIELD_FEEDS`, `DERIVED_PART`)

| Field | Feeds | So a change of only this field … |
|---|---|---|
| shape | mesh, collision, nav, light occupancy | rebuilds every result within the rules' radius (§3.7 dependency) |
| role | mesh, collision, nav, light occupancy, shader data (derived v17: the construction bit) | the same |
| material | shader data | rebuilds the shader data of the chunks within the shader border (1 cell) of the changed cells, and nothing else |
| wetness | shader data | the same |

- Every applied edit reports the fields that changed in any cell (`EditOutcome.fields`, a `PLANE_BIT` mask; the
  worker's `edit` job too). `fieldsFeed(fields)` turns it into the derived parts that are stale; the command
  route answers them (`parts`, an undo the parts of the edit it takes back), and `VoxelStreamer.refresh(chunks,
  box, parts)` / its own edits derive only those: for a shader-only change the shader data of every chunk within
  `SHADER_BORDER_CELLS` (1) of the cell box, the changed chunks and the neighbours whose border holds a changed
  cell (`derive` job with `parts: shader`, an apron 1 deep). `fieldsFeed(fields)` is the whole rule: no output but
  the shader data holds a material (45.10b: vertices, detail instances and collision boxes carry none), so the
  build derives exactly what the table says.
- **Kits (46c.6b, owner to confirm):** with voxel kits bound to materials, wetness and a material paint within one
  kit stay shader data alone; a material paint moving cells to another kit's pieces also derives whole the sections
  holding the painted cells ([kit page](voxel-kit-format.md) *Pieces*, `EditOutcome.materialSwaps`). Kits are per material type (§1), so
  that geometry change is by design: the one exception to this table.
- Tested in real workers on region files on disk (`stream.test.ts`): a wetness-only paint over 4 chunks and a
  material-only paint of one cell on two chunk faces (one chunk changed, 4 shader derives, 3 of them neighbours
  with no changed cell): 0 full derives (no mesh, collision, nav or light), every result equal to a fresh full
  derive, the neighbour's border holding the painted cell. In Node (`derived.test.ts`): a material and wetness
  paint of a wall and of ground leaves every derived byte but the shader data equal, and changes shader data only
  within the border. On the command route (`voxel-world.test.ts`): material-only and wetness-only answers and their
  undos name the shader data alone. In the slice page on both renderers (`voxel-world.e2e.ts`): a material paint
  and a wetness paint of the wall change the picture with 0 meshes built and only shader derives.

### 2.3 Base plus runtime overlay, and the saved-fields mask (owner 2026-11-02; `voxel-overlay.ts`, `save-file.ts`)

**One value everywhere.** Authored base files (region files, §3.2) hold the full value: an author can paint
wetness into the world. At runtime the base is never written:

- **The overlay** (`VoxelOverlay`) holds every runtime change as the cell's new value over the base store, per chunk
  as two sorted arrays (u16 cells, u32 values: 6 bytes a changed cell). Reads look in the overlay, then the base;
  writing a cell back to its base value removes its override. It takes stroke commands like any store
  (`applyEdit`), so the one mutation path is unchanged. Reads and writes are one value each.
- **On quit** the overlay is dropped (`clear`). What survives is what the game saves.
- **The saved-fields mask** (`DEFAULT_SAVED_FIELDS`, chosen by the game): which fields of a runtime change a save
  keeps. Default: material, role and shape; **wetness is not saved** (weather sets it again). A save keeps, per cell,
  the saved fields of the overlay's value merged onto the base value (`savedValue`; air is whole: a dug cell stays air
  when material is saved). A chunk whose kept values equal the base gives no entry: rain alone saves nothing.
- **Through the save format** (`VoxelOverlay.saveChunks`, `saveChunkOf(…, saved)`, §3.5): the merged chunk becomes an
  ordinary save entry, so the changed-cell masks (H1) and the base hashes (H2) work as before: on a re-exported base
  only the player's cells land, every other cell is the new base's (tested: a dig over rain keeps the 27 dug cells
  and no rain; on a re-export two cells higher the hole stays and the new ground stands around it;
  `voxel-overlay.test.ts`).
- **The editor's authoring path** writes base files as before (`editVoxels` on the command route rewrites region
  files); it does not use the overlay.
- **The streamer reads through it** (`VoxelStreamer.overlay`; plan 46a.3): base chunks land in the store, which no
  runtime edit writes; `edit`/`editInWorker` write the overlay; `voxelAt`, derive payloads (`stream-overlay.ts`: the
  base's arrays copied, the overridden cells written) and aprons read overlay-then-base. Overrides outlive their
  chunk's unload (an edited chunk is not dirty and unloads like any other), count in the stream budget (`bytes.overlay`,
  never evicted), and `VoxelStreamer.saveChunks(saved)` writes the entries above, reading the base of a chunk that
  left from the world's files again; `clearOverlay` drops them (quit). A game's save is restored into the overlay
  too (`VoxelStreamer.restoreSave`, plan 46a.8): the overlay is cleared, a loaded chunk's entry is laid over it at
  once (only the player's cells become overrides), any other waits (counted in the overlay's bytes, and written
  again as it was by a save made meanwhile) and lands with its chunk before the chunk is resident; a base mismatch
  is decided by the game's choice (`save` / `base`) and reported. The base store is never written, so a later
  save's base hashes are of the shipped chunks. Scripts reach it as `ctx.voxels.setSavedFields`, `save()` (save
  file v2 bytes, uncompressed, answered at a later step) and `restore(bytes, onMismatch)`. Tested in real workers
  on region files (`stream.test.ts`, `world-host.test.ts`). Not built yet: an overlay kept in shared memory for
  workers.

### 2.4 Climate field (owner 2026-11-02; specified, not built)

Temperature and humidity are **not in the voxel value**. They are a coarse field per region, interpolated, authored,
and overridable at runtime by the same base plus overlay rules as the voxels.

- **Grid.** One sample every 8 m (16 cells) on x, y and z, aligned at cell 0, so a 256 m stacked region cube (§3.2)
  holds 32 × 32 × 32 samples. A sample stands at the corner of its 16-cell block; values between are trilinear.
  The sample spacing is a format constant (16 cells; defined once in `record.ts` when built) so no per-voxel memory is spent and a whole
  region's field is 32 KB per channel at a byte a sample.
- **Channels.** Two u8 channels per sample: temperature (0–255 mapped linearly to −40 … +60 °C, 0.39 °C a step) and
  humidity (0–255 = 0–100 %). A world names the mapping in its manifest (`climate: { temperature: [min, max] }`) so
  another range needs no format change.
- **Storage.** A region's field is an optional section of its stacked region file, after the chunk data, named in the
  header's reserved u32 at offset 56 (its byte offset; 0 = no climate section, the region uses the world's default
  values from the manifest). Section: u8 version (1), u8 channels (2), u16 reserved (0), u32 CRC-32 of the samples,
  then the samples channel by channel, x, z, y order (y fastest), zstd-compressed as one frame. A uniform channel is
  stored as one sample with a flag (bit 0 of the reserved u16 per channel). Column region files have no climate
  section (stacked cubes are the owner's layout).
- **Association.** A sample belongs to the region cube containing its cell; samples on a region's upper faces are
  read from the neighbouring region (as voxel aprons are), so interpolation across a region face needs the
  neighbour's first slab, which the streamer already has resident.
- **Runtime override.** The overlay model of §2.3 applies per sample: a runtime change is held as the sample's new
  value over the base; a game's saved-fields choice applies per channel (default: climate overrides are not saved;
  a game that runs seasons saves them). Saves store changed samples as (sample index u16, value u8) per region and
  channel, with the base region's climate CRC as the base hash.
- **Derived use.** The shader and weather systems read the interpolated field; nothing in the voxel derive chain
  reads it, so a climate change re-derives nothing of the voxels (its own feeds entry: shader data only).
- Not built: writer, reader, interpolation, overrides and saves. Its numbers are estimates (32 KB a region per
  channel raw, far less after zstd for smooth fields), not measured.

---

## 3. The spec, by area

### 3.1 Chunk store

**Memory form** (`palette-store.ts`, `palette-chunk.ts`, `brick-layout.ts`, `chunk-index.ts`). This is not a file format; it is the measured pick, a DRAFT.

**Chunk index.** An open-addressing table keyed by (column, y): `ChunkIndex`, about 15–20 ns a lookup. A chunk in
the index is one of three things:
- **absent:** all air;
- **one value:** the chunk is that voxel everywhere (any fill level: a chunk of half-full cells is one value too).
  It costs 8 B;
- **a palette chunk:** a value palette and sparse bricks, as described below.

**Value palette.** Each palette entry is one whole voxel value (§2.2), shape and wetness included: a partly full
cell is an entry of its own, so there is no separate density list.
- Entries are reference-counted.
- Entry ids are packed at 0, 1, 2, 4, 8 or 16 bits (`packedWidth`), so no id ever straddles two 32-bit words.
- The palette is narrowed only when its live entries fit half the width and fill a quarter of it, or when one entry
  is left. This hysteresis is about memory only and never shows in the bytes.

**Sparse 4³ bricks.** A 32³ chunk is 8³ bricks of 64 cells each.
- A brick whose cells all use one entry is just that id (u16).
- A mixed brick keeps its 64 ids, bit-packed at the palette width, in a slot pool.
- One mask bit per brick says which of the two it is.
- An edit that makes a brick uniform again folds it back.
- Brick b holds the cells of `brickOrder`: bricks numbered x, z, y, and cells inside a brick x, z, y, with y
  fastest.

**Reading.** `voxelAt(x, y, z)` is the one read path (R21):
- an absent chunk reads as air;
- a uniform chunk is answered from its index entry;
- otherwise one packed read and one palette lookup.

**On the wire** (`chunk-wire.ts`). A chunk crosses threads as its own arrays, transferred, never copied:
- the palette values and their cell counts;
- the brick, mask, pool and free-slot arrays.

The payload form is `air`, `uniform` (a value) or `stored` (edge plus arrays). It has no version of its own, since
both ends run the same build; the job message is versioned instead. It is checked on adoption: a damaged payload is
refused and the store is left unchanged.

#### Chunk codec v2 — bytes at rest (`palette-codec.ts`)

Little-endian. "Planes held" is a bit mask: 1 material, 2 role, 4 shape, 8 wetness.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 2 | magic `VC` (0x56 0x43) |
| 2 | 1 | codec version = 2 (an older one is lifted through `CHUNK_CODEC_UPGRADES`, a newer one refused; the draft version 1 has no step and is refused) |
| 3 | 1 | flags: bits 0–3 planes held · bit 4 edge 32 (else 16) · bits 5–6 body (0 uniform, 1 bit-packed; 2 column runs and 3 bricks are measurement bodies) · bit 7 one palette per field (measurement only; else one record palette) |
| 4 | 4 | CRC-32 of every byte from offset 8 to the end |
| 8 | … | body |

**World data has one encoding.** All planes held, one record palette, a uniform or a packed body, at the grid's
chunk edge. Its flags are:
- `0x1F` for a uniform body (`0x0F` at edge 16);
- `0x3F` for a packed body (`0x2F` at edge 16).

Every world reader (`decodePaletteImage`, `readPaletteHeader`, the world store, region files, saves, undo
records) refuses any other flags as "a measurement encoding". The measurement options of 45.2 (column runs,
bricks at rest, one palette per field, dropped planes) share the header and are written and read only by the bench
entry (`palette-codec-measure.ts`: `encodeMeasuredImage`, `decodeMeasuredImage`), which writes world bytes byte for
byte as the world codec does (tested), so the harness can measure them again.

**Uniform body (5 bytes; 13 bytes with the header).** u16 material, u8 role, u8 shape, u8 wetness. Any fill
level: a chunk of one partly full value is a uniform body.

**Packed body, value palette:**
1. u16 entry count − 1.
2. The material of every entry (u16 each), then the role of every entry (u8 each), then the shape (u8 each), then
   the wetness (u8 each). Each field is its own plane, so the compressor sees runs of like values (R20). Reserved
   bits are not stored; they are 0 in every value.
3. The cells' entry ids in local-index order, at width w = `packedWidth(count)`:
   - w = 0: nothing;
   - w = 1, 2 or 4: 8 / w cells a byte, least significant first;
   - w = 8: u8 per cell;
   - w = 16: u16 per cell.

**Canonical bytes (R51).** The encoder always produces these, and the decoder refuses anything else:
- entries are numbered by first appearance in cell order;
- no entry is unused or repeated;
- a chunk of one entry is a uniform body, never a packed one;
- air is one value: an entry or a uniform voxel of material 0 has every other field 0;
- every field holds a value within its width, and the role an assigned one (0–9);
- no bytes follow the body;
- no padding or flag bits are set past the end.

So one chunk's content has exactly one byte string, whatever edits led to it, and every byte string the world
decoder accepts is the one its content encodes to (crafted bytes tested, `format-rules.test.ts`). The bench entry
also refuses a mixed brick holding a single id (body 3).

**Versions (R3).** `CHUNK_CODEC_UPGRADES` holds the codec's upgrade steps, keyed by the version each lifts from and
only ever added to; v2 has none (the registry is frozen and empty; the draft v1 is not lifted: the owner replaced
its record, nothing was ever shipped in it, and the one v1 world, the staging slice, was written again). A step takes a whole chunk's bytes of its version
and returns the same content's bytes of the next version, header and CRC included. Every world reader lifts older
bytes through the steps before reading them (`liftChunkBytes`), so a codec v2 keeps reading every v1 file without a
rewrite; a version with no step, or newer than this build's, is refused, and a step that does not land on the next
version is refused. The mechanism is tested with a test-only older version and its step.

**General compressor.** **zstd level 3 per chunk** when a stored chunk goes into a region file (zstd 19 is proposed
for exports, which are derived). Browser workers decode it with **fzstd 0.1.1**, a pinned dev dependency that
passes the export scan.

#### Measured (value v2, 45.10a; 32³, bricks in memory, packed + zstd 3 at rest)

| World | Memory | zstd body MB/km² | voxelAt random / coherent ns | Single edit µs | Node encode / decode µs a chunk |
|---|---|---|---|---|---|
| plain | 1.6 MB (2.1) | 2.33 (4.48) | 35 (39) | 0.09 (0.09) | 84 / 147 (89 / 167) |
| hilly | 172 MB (163) | 5.98 (6.91) | 33 (31) | 0.11 (0.11) | 60 / 74 (64 / 92) |
| town | 2.0 MB (2.0) | 2.24 (2.28) | 36 (36) | 0.11 (0.10) | 106 / 147 (111 / 181) |
| caves | 13.5 MB (15.4) | 50.2 (57.6) | 121 (144) | 0.18 (0.14) | 265 / 330 (275 / 417) |
| vertical | 45.5 MB (55.1) | 157 (192) | 61 (80) | 0.13 (0.17) | 155 / 193 (162 / 239) |

In brackets: the v1 draft (u24 material, density bytes beside the palette) measured the same hour by the same
harness (plan **45.10a value v2**, which also has 3-bit shapes and wetness patterns).

Every sweep compared every chunk, a 1-in-37 sample of `voxelAt` reads, every fourth decode, and 200 k edits plus
1,500 strokes against the dense oracle, at both chunk edges on every world. All were equal.

### 3.2 Region file v2 (`region-file.ts`; magic `TLVR`)

One region file holds one tile of one grid of one world: a 256 m column or a 256 m stacked cube. The file is pure
bytes; the compressor is passed in. Little-endian.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVR` |
| 4 | 1 | region format version = 2 (an older one is lifted through `REGION_UPGRADES`, a newer one refused; the draft version 1 is refused) |
| 5 | 1 | layout: 0 full-height column, 1 stacked cube |
| 6 | 1 | chunk edge in cells (16 or 32) |
| 7 | 1 | chunk codec version the file was written with (up to this build's; chunks of an older version are lifted on read) |
| 8 | 1 | compressor of stored chunks: 0 none, 1 zstd |
| 9 | 1 | side: chunks along each side of the region (16 for 256 m at 32³) |
| 10 | 1 | record value form of the uniform entries (§2.2; 2) |
| 11 | 1 | reserved, 0 |
| 12 | 16 | world id |
| 28 | 4 | grid id (u32; 0 = world grid) |
| 32 | 4 × 3 | rx, ry, rz (i32; ry = 0 in a column) |
| 44 | 4 | entry count |
| 48 | 4 | data bytes (stored chunks back to back) |
| 52 | 4 | CRC-32 of the table |
| 56 | 4 | reserved, 0 |
| 60 | 4 | CRC-32 of bytes 0–59 |
| 64 | 12 × n | table |
| … | data bytes | stored chunks in table order |

**Table entry (12 bytes):**
- u16 column word:
  - bits 0–13: lx · side + lz;
  - bit 14: stored raw, without the compressor;
  - bit 15: uniform.
- i16 chunk y (the grid's chunk index).
- Two u32:
  - a uniform chunk: its voxel value (§2.2), then 0;
  - a stored chunk: its byte length, then the CRC-32 of the stored bytes.

**Rules:**
- **Absent and uniform chunks.** All-air chunks are absent. A uniform chunk lives only in its table entry, so it
  takes 12 bytes. Inside its own zstd frame it would grow from 14 bytes to 23.
- **Raw chunks.** A chunk is stored raw only when zstd does not make it smaller. That is a pure function of the
  bytes, so files stay canonical.
- **Offsets.** A stored chunk's offset is the sum of the lengths before it, so it is never stored twice.
- **Canonical files.**
  - entries sorted by column, then y;
  - no duplicate entry and no air entry;
  - no gap and no trailing byte;
  - reserved fields zero;
  - no time stored anywhere.

  Equal content gives equal bytes whatever the edit order (tested).
  - *Caveat:* a zstd frame depends on the zstd build. The writer re-packs only edited chunks and copies the frames
    of the others, so a zstd upgrade changes only what is edited afterwards.
- **What the reader refuses.** Any of these refuses the whole file (`RegionFileError`):
  - bad magic, a newer or unliftable version, an unknown layout or compressor, a chunk codec version newer than
    this build's;
  - a file of another tile than the reader expects (R5): every reader passes what it expects (`RegionExpect`:
    world id, grid id, layout, chunk edge, footprint and the region index its file name gives; `expect` is a
    required argument of `RegionIndex.parse`, `openRegion` and `damagedRegionChunks`), and a mismatch names the
    field, what the file holds and what was expected. `RegionChunkSource`, the backend's world and the shipped
    world a save is made against all check every file they open; a file copied into the wrong world or folder is
    never read as this one's voxels;
  - a record value form newer than this build's, or a uniform entry whose value the format does not hold (§2.2);
  - an edge other than 16 or 32, or a footprint other than 512 or 1,024 cells;
  - a stack index in a column file;
  - set reserved bytes, or a damaged header or table CRC;
  - entries out of order or repeated, or an entry outside its stack;
  - lengths that do not add up.
- **Damage (R4).** A stored chunk whose CRC fails, or whose bytes are missing, comes back as
  `{kind: 'damaged', cx, cy, cz, reason}`, never as air. `damagedRegionChunks` scans a whole file. A file the reader
  refuses (another tile, a damaged header) reports every chunk asked of it as damaged with the reason.
- **Versions (R3).** `REGION_UPGRADES` holds the region file's upgrade steps, keyed by the version each lifts from
  and only ever added to; v2 has none. A step lifts a file's header and table to the next version and says where its
  version's table ends (`indexEnd`, from the first 64 bytes); the stored chunks are not touched and keep their own
  codec version. Readers lift the index (`liftRegionIndex`) and read chunks by range from the file as it is, from
  where its table ends (`RegionIndex.dataStart`). Tested with a test-only older version of 16-byte entries.
- **World-scoped key (R5).** World id plus grid id plus chunk coordinates, held once per file.
- **Partial reads (R52).** `openRegion` reads the header and the table in one 32 KB request when they fit (tables
  up to about 2,700 entries), otherwise in two. `readRegionChunks` then reads:
  - absent chunks as air;
  - uniform chunks from the table;
  - stored chunks by range requests, coalesced across gaps up to 4 KB by default.
- **File names.** `r.<x>.<z>.vxr` for a column, `r.<x>.<y>.<z>.vxr` for a stack (`regionFileName`,
  `parseRegionFileName`). The world grid's files sit in one folder, each structure grid's in a folder named by its
  grid id.
- **Writes.** A file is replaced atomically through the workspace's durable write: a temporary file, fsync, rename,
  fsync of the folder, a read-back, and a refusal if the file is not what this process last saw.

#### World manifest, format 2 (`world.json`; `voxel-worlds.ts`)

A world is a folder holding `world.json` and its grids' folders (`grid-0/` for the world grid). The manifest is
JSON with two-space indents and a closing newline, in this field order: `format` (2), `worldId` (32 hex digits, the id its region files carry), `edge`
(16 or 32), `layout` (`stacked` or `column`), `footprint` (512 or 1,024 cells), `regions` (the world grid's region
file names, sorted, each once) and `revision` (moves by one with every applied change). Unknown fields are refused.

- **Which regions exist (R4).** A region the manifest does not list is all air. A listed region that is missing,
  unreadable or of another tile is damaged: the backend reports it (`region_damaged`, 409, on the range route;
  `etag: null` in the world's file list), the chunk source reports its chunks damaged, edits into it are refused
  (`chunk_not_loaded`), and the shipped world a game save is made against (`openShippedWorld`, which reads the
  manifest) throws for its chunks, so no save entry is made or checked against air standing in for it. It stays
  listed until it is repaired, so a lost tile never passes as empty sky. A stray file the manifest does not list is
  never read: every world reader takes the manifest's list (`RegionWorld.open`, `ShippedWorld`).
- **Write order.** A command's dirty region files and the next manifest are one staged write: each file's new
  bytes are written and flushed to a temp file beside it (same folder, same disk), then every target is checked
  to hold what the backend last saw there, and only then are the temp files renamed over them, the manifest last.
  A failed write replaces nothing, and the backend puts memory and undo history back (an edit is taken back, a
  failed undo is re-applied as an edit and stays undoable): `write_failed`. A rename failing midway is reported
  as `write_partial`, naming the files that hold the change and those that do not; memory keeps the change and the
  next save that succeeds writes the rest. A region that became all air is deleted only after the manifest no
  longer lists it. A crash between the renames leaves either an unlisted new file (read as air, the revision not
  advanced) or nothing listed that is missing.
- **Files changed by someone else (R53; a git checkout or pull, a restore).** The backend keeps the stamp (inode,
  size, change times) of the manifest and of every listed region file as it last read or wrote them, checks them
  before every command and before serving the manifest or a region file, and reads the world again when one's
  bytes changed (a moved stamp with the same bytes is no change). Its undo history, which describes the old files,
  is dropped. A command meeting the change, found by the stamps or by the staged write's check, is refused
  (`world_changed`, 409, "changed on disk, reloaded") after the reload, never applied blind: the client reads what
  changed, then sends the edit again (default chosen, owner to confirm). A released, taken-over or unregistered
  project's worlds are closed and read again on next use.
- **Versions.** A newer format is refused. Format 1 (45.7a) had no `regions`; its upgrade step lists the world
  grid's region files found in the folder when it is lifted, the most an old world can say.

**Measured (45.3)**
- **Size:** hilly 4 km² is 64 column files (128 stacked), 23.1 MB; header plus table are 5.8 % of it.
- **Read times** (disk / HTTP on loopback):
  - one chunk with its table cached: 0.018 ms / 0.41 ms;
  - a 3 × 3 × 3 neighbourhood: 3 coalesced requests, 0.08 ms / 0.54 ms.
- **One-voxel save:** rewrites 363 KB (256 m column) or 351 KB (stacked). On the 2 km tall world: 12.3 MB as a
  column, 1.47 MB stacked.

### 3.3 Edits: stroke command v2 (`edit-command.ts`, `edit-apply.ts`)

**One command is one stroke**, in plain JSON. It rides the existing command envelope as an op's arguments (R6, R56).

**Canonical form.** `canonicalEditCommand` rebuilds the command field by field and refuses:
- an unknown field;
- an unknown version (`v` must be 2; the draft v1 with category and orientation is refused);
- an out-of-range value;
- −0 (normalised to 0).

Common fields: `v: 2`, `grid` (u32; 0 is the world grid), `kind`.

| kind | Fields |
|---|---|
| `brush` | `shape` (sphere / box / cylinder) · `size` [x, y, z] half extents in cells (a sphere's are all filled in from x; a cylinder's x and z from x) · `points` (flat x y z dab centres in cells, at least one) · `mode` · `voxel` (absent for dig) · `smooth` |
| `fill` | `min`, `max` (integer cells, both inclusive) · `mode` · `voxel` |
| `stamp` | `stamp` {`id`, `hash` (64 hex digits)} · `origin` [x, y, z] · `yaw` [cos, sin] (cos² + sin² = 1 within 1e−9) · `scale` > 0 · `mode` · `voxel` · `smooth` |
| `set` | `cells` (flat integer x y z; canonical order below) · `voxel` {material, role, shape, wetness} (material 0 means air, all other fields 0; otherwise shape 1–15) |
| `dig` | `cells` (canonical order below) |

- **Cell lists.** `canonicalEditCommand` sorts a `set` or `dig` cell list by x, then z, then y (the order chunk keys
  and cells inside a chunk use) and keeps each cell once, so the same cells give one payload whatever order or
  repeats they were sent with (tested).

- **Modes.**
  - `place`: write the voxel whatever was there.
  - `add`: write only into air or liquid; a smooth add also grows the shape of a cell of the same material.
  - `dig`: remove; a smooth dig lowers the shape, and an empty cell becomes air.
  - `paint`: change material, role and wetness of non-air cells and keep their shape (a paint of only a new wetness
    changes the wetness field alone: its answer's parts are the shader data, §2.2).
- **Smooth.** Only `add` and `dig` may be smooth.
- **Edit voxel** (`brush`, `fill`, `stamp`): {material 1–4,095, role 0–9, wetness 0–7} (§2.2); the shape comes
  from the stroke.
- **Coverage.**
  - A brush cell is covered by the depth of its centre inside the dab shape, plus half a cell, clamped to 0–1.
    With several dabs, the largest coverage wins.
  - A hard stroke takes a cell at coverage ≥ 0.5.
  - A smooth stroke writes shape = `max(1, round(cov · 15))` at the rim.
  - A stamp samples its shape's nearest cell under the cell centre, mapped back through scale and yaw; its coverage
    bytes stay 0–255 (the stamp's own resolution) and become a fill level on write.
- **Determinism.** A cell's new voxel depends only on its old voxel and the command. The arithmetic uses only +, −,
  ×, ÷, √, floor and round, which IEEE-754 defines exactly. Tested in Node across the store and the dense oracle;
  another JavaScript engine is unverified.
- **All or nothing.** These refusals happen before the first write: `grid_unknown`, `chunk_not_loaded`,
  `stamp_unknown`, `stamp_changed`, `outside_world`, `over_budget`.
- **Work bound (`over_budget`).** One command's worst-case undo record must fit the undo budget (§3.4): the chunks
  it can touch × the worst case of one chunk (`chunkWorstUndoBytes`: 15 + cells × 6 bytes, 196,623 B at 32³)
  ≤ `UNDO_MEMORY_BUDGET_BYTES`, so at most 341 chunks of 32³ (2,729 of 16³) at 64 MiB. The chunks are counted from
  the command alone before any cell is visited: a box's chunks for a fill or stamp, listed cells' chunks for set
  and dig, and for a brush the union of its dabs' chunks (a long thin drag counts the chunks it reaches, not its
  bounding box). A world-sized fill or a 2 km sphere is refused at once; the memory and time of one command are
  bounded with it. A budget, not a count: the same bytes fit more chunks of a smaller edge.
- **No change.** A command that changes nothing reports 0 cells; the command layer refuses it as `no_change`.
- **Answers.** The backend answers an applied command with the changed chunks, its cell box (`box`: the cells
  the command can change, from `editBounds`) and the derived parts it makes stale (`parts`, from the fields that
  changed, §2.2). An undo answers the box and parts of the edit it takes back. A client derives again only those
  parts: the results within the rules' radius of the box, or only the changed chunks' shader data (Q-c).
- **Stamp shape.** A stamp is a box of 0.5 m cells with one coverage byte each, indexed `(x · sz + z) · sy + y`.
  Its hash is the SHA-256 (hex) of the three sizes (u16 LE each) followed by the coverage bytes.
- **Size bound.** A long drag must fit the command pipeline's 64 KB request bound, about 2,000 dabs. Thinning the
  dabs to a spacing is the tool's job (proposal for 47b).

### 3.4 Undo record v2 (`undo-store.ts`; magic `TLVU`) and budget

An undo record holds, for every chunk the command changed, what that chunk was before. It holds whichever of two
forms is smaller:
- a **cell delta**: the changed cells' old voxels, at 6 bytes a cell;
- the chunk's whole **before-image**: its canonical codec bytes. An absent chunk costs 0 bytes and a uniform one 13.

An image is encoded only once the delta outgrows the smallest image, which is 4 KB at 32³.

- **Redo** re-applies the command. It is deterministic and works last-in, first-out.
- **The undo step is a new revision** (the command model's inverse), never a rewind.

**Cell delta bytes** (`cell-delta.ts`): n × u16 local cells (ascending), then n × u32 voxel values (0 for air;
value form 2, shape inside). Writing all cells, then all values lets the compressor find runs. The reader refuses a
value the format does not hold (§2.2).

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVU` |
| 4 | 1 | version = 2 |
| 5 | 1 | chunk edge |
| 6 | 1 | chunk codec version |
| 7 | 1 | record value form of its deltas (§2.2; 2) |
| 8 | 4 | chunk count |
| 12 | … | per chunk: u32 grid, i16 cx, i16 cy, i16 cz, u8 kind (0 delta, 1 image, 2 absent), u32 length, payload |
| end − 4 | 4 | CRC-32 of everything before it |

- **Budget.** `UNDO_MEMORY_BUDGET_BYTES` = 64 MiB **per open world** (the backend keeps one undo store for each
  world it has open, so a process with several open worlds holds up to 64 MiB for each), a memory budget with no
  step count (R7). Beyond it, the oldest records spill to an `UndoSpill`: files in the backend, IndexedDB in a
  browser. The IndexedDB spill is not built yet. One command's worst-case record must fit it too (§3.3, work bound).
- **Ordering.** Calls run in order, so a put during a spill write cannot spill a record twice.

**Measured (45.4, draft v1 bytes):** 22 B for one voxel, 95–103 B for a 1 m dab, 1.5–1.6 KB for a 4 m dab, 45–60 KB
for a 16 m fill. 64 MiB holds about 43 k 4 m dabs, or 1.1–1.5 k 16 m fills. v2 deltas are 6 bytes a cell instead of
7, so delta records shrink by a seventh; image records by the codec v2 change (plan **45.10a value v2**).

### 3.5 Save file v2 (`save-file.ts`; magic `TLVS`) and structure overrides v2 (`structure-overrides.ts`; magic `TLVO`)

**Save:**
- **Edits only (R59).** A save holds only the chunks that differ from the shipped world. A chunk changed and then
  changed back has no entry.
- **Saved fields (§2.3).** An entry holds the chunk as the game keeps it: the fields the game marks saved (default
  all but wetness) from the runtime value, the rest from the base (`saveChunkOf(…, saved)`, `persistedCells`). A
  change of unsaved fields alone (rain) makes no entry.
- **The player's cells, always.** Every entry records which cells the player changed: a cell delta lists them; a
  whole-chunk entry (the chunk as it is now: an image, one voxel, or all air) carries a **changed-cell mask** beside
  it. The writer keeps whichever payload is smaller (the delta on a tie); the choice never changes what loading
  does.
- **Base hash (R60).** Each entry carries a **base hash**: the first 16 bytes of the SHA-256 of the shipped chunk's
  content in the **base form**. An all-air base hashes as no bytes.
- **The base form is frozen: the chunk codec version 2 canonical bytes of the content** (§3.1, header included),
  whatever codec version the chunk is stored in (`BASE_FORM_CODEC_VERSION` = 2; it moved from 1 with the value v2,
  before any save existed). Bytes already of version 2 are
  hashed as they are (the world decoder accepts only canonical bytes, so they are the one byte string of their
  content); bytes of any other version are decoded and written in the base form first (`baseContentHash`). A later
  codec keeps a version 2 writer for this. So neither recompressing a world nor a codec upgrade looks like a changed
  world. If a later value holds content version 2 cannot write (a field in the reserved bits, §2.2), the base form
  gains an extension then; such content was never the base of an older save, so no older hash can match it wrongly. Tested
  with a frozen hash of a fixed chunk, the same content through a test-only older codec version, and through a
  test-only newer layout read back to its content.

**Header (44 bytes):**

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVS` |
| 4 | 1 | save version = 2 (the draft version 1 is refused) |
| 5 | 1 | chunk edge |
| 6 | 1 | chunk codec version (up to this build's; older images are lifted when decoded) |
| 7 | 1 | compressor: 0 none, 1 zstd (the whole body is one stream) |
| 8 | 1 | record value form of its deltas and uniform payloads (§2.2; 2) |
| 9 | 3 | reserved, 0 |
| 12 | 16 | world id |
| 28 | 4 | entry count |
| 32 | 4 | body length as stored |
| 36 | 4 | CRC-32 of the body as stored |
| 40 | 4 | CRC-32 of bytes 0–39 |

**Body entries** (after decompression), sorted by grid id, then chunk key. Each has a 31-byte header:
- u32 grid;
- i16 cx, i16 cy, i16 cz;
- the 16-byte base hash;
- u8 kind: 0 delta, 1 image, 2 uniform, 3 air;
- u32 payload length;

then the payload:
- delta: the cell delta bytes (§3.4), holding the changed cells' values *now*;
- image, uniform, air: first the changed-cell mask, cells per chunk ÷ 8 bytes (4,096 at 32³; cell i is bit i mod 8
  of byte ⌊i / 8⌋; at least one bit set), then:
  - image: canonical codec bytes (a uniform body is refused here);
  - uniform: a u32 voxel value, never 0;
  - air: nothing.

The bytes are canonical: equal saves give equal bytes.

**Save rules:**
- **World (R5).** A save belongs to one world: `readSave` and `applySave` take the world's id and refuse a save made
  for another before anything is written.
- **Versions (R3).** A version newer than this build is refused. An older version is lifted through `SAVE_UPGRADES`:
  append-only steps on the decoded save, from `SAVE_FIRST_VERSION` = 2 (the draft v1 is refused). v2 has no steps;
  the mechanism is tested with a test step.
- **Base mismatch (R60).** When the base hash differs from the shipped chunk's, the mismatch is reported, and the
  game chooses per chunk:
  - `save`: the player's cells land on the new base, cell by cell (a delta's cells, or the masked cells of a
    whole-chunk entry); every cell the player did not change is the new base's. Tested: a player digs a 16-cell
    cube (a whole-chunk entry), the re-export moves a wall into that chunk through the hole's edge; with `save` the
    wall stands where the player did not dig, the hole stays, every other cell is the new base.
  - `base`: the entry is dropped.

  On a matching base a whole-chunk entry is written whole (the same result). The worker job's `apply-save` can also
  `report` without applying anything.

**Measured (45.4, then 45.8a; draft v1 bytes, v2 in plan **45.10a value v2**):** after 1,000 mixed strokes, saves are 497 KB (hilly), 303 KB (town) and
493 KB (caves): +7–18 % over the 452 / 256 / 461 KB of saves without the changed cells (45.7d). With every entry a
delta instead (the other encoding that keeps the changed cells) the same saves are 801 / 682 / 773 KB, so the
smaller of the two stays. Writing takes 8–11 ms, reading 14–19 ms. The base hash costs 61–69 µs a chunk when the
bytes are already in the base form (as every chunk is today; 60–82 µs before) and 309–343 µs through a decode
(what a later codec pays), in plain JavaScript (plan **45.8a review fixes**).

**Structure overrides.** These are a structure's hand edits over the voxels it generates. They are stored with the
structure record in the project, never in region files or exports (R33, R35).

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | magic `TLVO` |
| 4 | 1 | version = 2 (the draft version 1 is refused) |
| 5 | 1 | chunk edge |
| 6 | 1 | record value form of its values (§2.2; 2) |
| 7 | 1 | reserved, 0 |
| 8 | 4 | grid id |
| 12 | 4 | chunk count |
| 16 | … | per chunk, in key order: i16 cx, i16 cy, i16 cz, u32 n, then n × u16 cells (ascending), n × u32 base values, n × u32 values (10 B a cell) |
| end − 4 | 4 | CRC-32 |

**Fit rule after regenerating (R33, R34).** For each override, compare it with what the generator now makes:
- **absorbed:** the generator now makes the override's voxel itself. The override is dropped.
- **kept:** the newly generated voxel is the same kind as the override's base (both air, or both solid with the same
  role). The override is written, and its base becomes the newly generated voxel.
- **misfit:** anything else. It is reported and not written.

This was tested on a test room grown from 6 to 8 m, not on a generator. A rule for every structure kind is 47a's.

**Overrides versions.** Overrides live as long as the project, so they upgrade like saves: a newer version is
refused, and `OVERRIDE_UPGRADES` holds append-only steps on decoded overrides from `OVERRIDE_FIRST_VERSION` = 2
(empty and frozen at v2; tested with a test-only step). The reader refuses values the format does not hold.

### 3.6 Streaming and job contract v1 (`stream-job.ts`, `apron.ts`, `dirty-tracker.ts`, `job-queue.ts`, `worker-pool.ts`, `stream-ring.ts`, `voxel-streamer.ts`, `floating-origin.ts`)

**Messages.**
- A request is `{v: 1, id, kind, input}`.
- A reply is `{v, id, ok: true, output, workerUs}` or `{v, id, ok: false, code, message, workerUs}`.
- Error codes: `version`, `unknown_kind`, `refused`, `failed`.
- A worker refuses any other `v`.
- A reply to an id that is no longer live (cancelled, timed out, its chunk unloaded) is ignored. The tracker refuses
  such a result as `expired`, `superseded` or `unknown_job`.

**Job kinds:**

| Kind | Input → output |
|---|---|
| `load` | stored chunk bytes (`{stored, raw}` or `{uniform}`), optional hash → the chunk payload, its base hash, decompress and decode µs |
| `apply-save` | the base chunk (stored or null), expected hash, save content as its kind and payload bytes (§3.5), `onMismatch` (`save` / `base` / `report`) → the payload now, mismatch, applied, the base hash now |
| `edit` | a canonical command, copies of every chunk it can touch, its stamps (hash recomputed in the worker) → the changed chunks, cell count, the undo record (`TLVU` bytes), the fields that changed (§2.2) |
| `derive` | the chunk payload, radius R, an apron R deep, optional assembly rules {id, version, radius}, optional `parts` (default all), optional `sections` {edge 8 / 16 / 32, ids} → derived data (§3.7), or the exposure placeholder when no rules are named; `parts` = shader alone: the chunk's shader data from the chunk and an apron of the shader border (R = `SHADER_BORDER_CELLS`, 1), no assembly evaluation; with `sections`, one result a named section (`SectionResult`: id, hash, derived data or shader data, evaluate / mesh / consumer µs) |

**Sections (owner 2026-11-02, R107; 45.10c).** 32³ stays the storage chunk; what a derive job builds is a
**section** of 8, 16 or 32 cells inside it (`sectionGrid`, `VoxelStreamerOptions.sectionEdge`; default
`DEFAULT_SECTION_EDGE` **16** with assembly rules whose radius fits a section, else the chunk edge; chosen by the
blast measurements, plan **45.10c**).
- *Ids.* Section id = (sx · n + sz) · n + sy with n = 32 / S (the cells' x, z, y order); section keys and bounds use
  the chunk key math on the section grid (`CellGrid`).
- *Job input.* A job names some sections of one chunk and carries the chunk's payload and the chunk's apron (R
  deep, exactly as for a whole-chunk derive). The worker fills the chunk's neighbourhood once, cuts each section's
  own neighbourhood (its cells and the same pad) out of it and derives that as a cube of edge S. A 32³ section is
  the chunk's derive, byte for byte. An edit touching fewer chunks than there are workers splits each chunk's
  sections over the pool; otherwise, and for loads, one job a chunk.
- *Results* are per section: positions, boxes, instances and nav cells are relative to the section's corner, the
  shader data covers the section plus its 1-cell border (side S + 2). `deriveSectionFromStore` derives a section
  in-thread from `voxelAt` reads alone, the oracle the workers' results are tested against (`stream.test.ts`).
- *Staleness* is per section: each section has an input stamp that moves with any change within R of it (an edit,
  a neighbour landing, a refreshed chunk), and a result is kept only while its section's stamp is the one the job
  was sent with; a change elsewhere in the same chunk no longer throws a result away. Chunk stamps still guard
  loads, edits in workers and saves.

**Atomic swap (R107).** Every section one edit makes stale joins the edit's **group** (`edit()` and `refresh()`
return its id). New results of a group are held; the old results — and so the meshes and colliders built from
them — stay until every section of the group has its new result and every chunk a refresh is reading again has
landed. Then all of them are committed in one task and one `swap` event (`SwapReport`: groups, sections, jobs,
worker µs, main-thread ms, mesher µs per section, ms from the edit) closes the group, so a renderer and a physics
world replace them between the same two frames: no frame shows part of an edit. An edit meeting a group still
open merges into it (both swap together). A section that cannot be derived now (a neighbour chunk unknown) or
whose job is refused leaves the group; a chunk unloaded takes its sections out. **Reads see an edit at once:**
`voxelAt` reads the overlay, which the edit wrote before anything is rebuilt (the local path, §2.3); on the editor's
command path the store changes when the refreshed chunk lands, before the swap. An edit's jobs are sent in the
same call (an edit lane budget of 8 ms main thread, `editDeriveMsPerUpdate`), not at the next update.

**Per-chunk join (D440, `chunk-join.ts`).** Derive work stays per section; what is drawn is per storage chunk. The
`swap` report also names the storage chunks it replaces (`chunks`), and every chunk whose sections took new results
in one task (a swap, or one job's answer while streaming) gets one `chunk` event (`shaderOnly` when only shader data
changed) just before the `swap`. `joinedChunk(cx, cy, cz)` then joins the sections' newest results on the drawing
thread: one ground and one base surface (section buffers concatenated, positions moved to the chunk's corner by whole
cell steps, indices offset; vertices on faces between sections not welded, so the ground's triangles equal a
whole-chunk derive's with 1–6 % more vertices; the base merges faces inside each section only, so its triangles
differ from a whole-chunk derive's while covering the same faces once each with no T-junction, v6), one instance list, and one shader grid of side 34 whose bytes equal the
whole-chunk derive's (`encodeShader`). Nothing is kept: the join is rebuilt from the section results when asked.
Measured (Node, 16³, plan-46a 46a.5a): 0.28–0.31 ms p50 / 0.59–0.69 ms p95 a drawn chunk, nine tenths of it the grid.

**Lanes.** `edit` before `near` before `far` before `mip` (the chunk tree's nodes, built from level 0, so they never
hold it back); within a lane by distance², then by arrival. The queue is an indexed
heap with back-pressure: `maxQueued`, `room()`, and `queue_full` when full.

**Staleness (R67).** Ids and input stamps come from the `DirtyTracker`, from one counter that never repeats.
- A chunk's input stamp moves when it is edited or (re)loaded; a derive section's own stamp moves when anything
  within R of it changes and the change feeds geometry (a material or wetness change: within the shader border,
  and only the shader data is rebuilt, §2.2).
- A job snapshots the stamps of every chunk it reads. Its result is accepted only while all of them still match and
  the job has not expired.
- **Saves are jobs too:**
  - one live save job per file;
  - a save commits only the versions it snapshotted;
  - an expired job's late commit is refused;
  - a chunk that is dirty or held by a live save is never unloaded or evicted.

**Aprons (R69).** A job sees its chunk's neighbours as 26 thin strips, R cells deep:
- 6 face slabs, 12 edge bars and 8 corner cubes;
- strips ordered by their bands (x, z, y), each band 0 below the chunk, 1 inside, 2 above, skipping the centre.

Each strip is either one voxel value (its neighbour is absent or uniform), or its cells as u32 values (shape
inside), in x, z, y order.
- **R is a parameter of every job,** 0 ≤ R ≤ 32. It is never a constant.
- `dependentChunks(box, R)` names every chunk within R of an edit: 8 at a corner, 27 for a box over a chunk.
- Measured at R = 2 (45.5a, draft v1 with a shape byte beside each value): 13 KB median, 57 KB p95 a job, against
  69 KB for a dense apron. v2 strips are 4 bytes a stored cell instead of 5.

**Residency (R64, R7).**
- **The ring** (`DEFAULT_STREAM_RING`, in cells; a default only, every world sets its own, 46c.16a):
  - load 384 horizontally and 192 above and below (192 m / 96 m);
  - unload past 448 / 256 (224 m / 128 m), which gives hysteresis;
  - the near lane within 192 (96 m; a work-queue split, kept for any ring no wider than its load radius).
- **Rings configurable (owner 2026-11-05; 46c.16a; no stored format change).** Every distance (load, collision,
  level 0 = the detail-piece ring, level 1) is the `voxelWorld` component's (project schema 8, add-only optional
  `quality` map per quality level id: `scale` or own distances, canonicalized field by field), scaled by the quality
  level (`voxelRings`, else its tier's `VOXEL_RING_SCALES`: √(tier budget / medium budget), low 0.71, medium 1, high 1.41),
  with the tier's stream budget; changed at runtime by scripts (`ctx.voxels.setRings`) and by the reported quality
  level, applied without a reload: `VoxelStreamer.setRing` re-plans the load ring and the mip rings (`mipRingsFor`:
  each kept level to the load radius), `StreamLod.setRings` chooses again (one swap), `CollisionRing.setBounds`.
- **One byte budget per tier** (`VOXEL_STREAM_BUDGET_BYTES`): low 256 MiB, medium 512 MiB, high 1 GiB, the world's
  at its quality level's tier (the host's, else low, until the page reports one). It counts:
  - the store's arrays;
  - the runtime overlay's arrays (§2.3; counted, never evicted);
  - 96 B of bookkeeping per resident chunk, air included;
  - every derived part registered per chunk;
  - the chunk tree's nodes (`bytes.mips`: node cells, derived results, 96 B each, the seams, and the page's GPU
    bytes of every node and seam it draws, reported back as one sum after each batch), which leave with their chunks;
  - the open region tables;
  - each chunk body's physics cost (its `collision` part: the physics heap's estimate for its shape plus the
    geometry kept for re-bases, D434).
- **The collision ring** (`DEFAULT_COLLISION_RING`, `collision-ring.ts`): resident chunks have physics bodies only
  while their box is within 96 cells horizontally and 48 vertically of a focus (48 m / 24 m), kept to 16 cells (8 m)
  past that; the stream ring around it is only drawn. Not a format.
- **Over budget:** clean chunks are evicted farthest first (ties: least recently wanted) down to 95 % of the
  budget. Loading stops short of the nearest evicted distance until the total is below 85 %.
- **Main thread:** apron building is capped at 2 ms an update.
- **Workers keep no world state.**
  - Settings: pool size, queue bound and timeouts. The bench used 4 workers, 256 queued, a 5 s timeout, and a hung
    worker replaced after 4 × the timeout.
  - Engine default for the pool size (built in 46a, `defaultVoxelWorkers`; one pool a world wherever it streams):
    `min(4, hardwareConcurrency − 2)`, at least 1.

**Floating origin (R62, R63).**
- **When:** the origin re-bases when the focus is more than 1,000 m from it on any axis.
- **Where to:** the focus, snapped to the grid's chunk edge (`FloatingOrigin` takes the grid; 32 cells, 16 m, at
  32³), so chunk-local data keeps whole offsets at any edge.
- **Who is told:** listeners run inside `update`, before the frame uses any position, and subtract the shift from
  every 32-bit position.

  Measured: < 0.1 mm error at 9.9 km and ±2 km relative to the origin, against 0.49 mm in absolute float32
  positions.

**Export delivery (R66).**
- `RegionChunkSource` reads chunks through any byte source: a file, `fetch` with Range, or the export's content
  closure.
- It keeps a bounded number of open tables and coalesces ranges per region.
- It is given the world id and grid id, and checks every file it opens against them and the tile its name gives
  (§3.2): a file of another world or grid reports its chunks damaged.
- Which files exist is the world's to say (§3.2 manifest): a region the world does not list reads as all air; a
  listed file that is gone or fails to open reports its chunks as damaged.
- As built (46a.11, no format change): an export ships each named world's listed region files whole (about 4–6 MB
  per km² for the test world), as content files checked by digest when read, with no backend and no range reads; an
  export is refused if a named world is missing or has a missing or damaged region file.

**Open contract gap: dependencies across grids (review M7; for the owner before 47a).** Aprons, dependency and
invalidation keys (`dependentChunks`, tracker stamps) and derived results are all per grid: a job names one grid's
chunk and sees only that grid's cells. §1e needs a structure grid's pieces to end in caps where it meets another
grid or the terrain, and a rail can stand on world-grid ground, so a derive will read another grid's occupancy and
an edit in one grid must invalidate results in another. v1 cannot express that; it was not added in 45 because
it needs the rotated structure grids (47a) to be tested honestly. Planned design (proposed):
- **keys:** every chunk key, input stamp and dependency in the job contract becomes (grid id, chunk) (today's
  keys are grid 0's);
- **cross-grid apron:** a derive names, besides its own apron, read-only *occupancy strips* of other grids: for
  each grid whose bounds come within R of the chunk, the cells of that grid within R, resampled into this grid's
  frame by the grids' transform (occupancy and role only, not the full value);
- **invalidation:** an edit's cell box, moved into every other grid's frame (its world-space box, rounded out),
  marks that grid's results within R of it stale (`dependentChunks` per grid);
- **staleness:** a result accepted only while the stamps of every chunk it read, in every grid, still match.
Cost to measure in 47a: the resampling per job and the extra strips' bytes.

**Measured:**
- **Node, 45.5a:** 87–173 stored chunks/s decoded; worker jobs 0.66 ms median.
- **Chrome, 45.5b:** frame p95 16.67 ms at 40 and 80 m/s on both renderers; `update()` p95 2.3–2.4 ms; ring 9–10 MB.
- **The miss:** D432, at +40 ms latency.

### 3.7 Derived data v22 — never committed, never saved (`assembly.ts`, `terrain-rules.ts`, `kit-rules.ts`, `kit-case-catalogue.ts`, `edge-cases.ts`, `case-forms.ts`, `piece-table.ts`, `piece-placement.ts`, `derived-data.ts`, `derive-pieces.ts`, `derived-mesh.ts`, `terrain-mesher.ts`, `roof-mesher.ts`, `base-surface.ts`, `derived-shader.ts`, `derive-assembly.ts`, `voxel-mips.ts`, `mip-derive.ts`, `lod-seam.ts`, `lod-select.ts`, `stream-mips.ts`, `stream-seams.ts`, `stream-lod.ts`, `ground-heightfield.ts`, `prop-coverage.ts`; the surface shader: three-adapter `voxel-surface.ts`, `voxel-surface-projection.ts`)

Everything in this section is rebuilt from the voxels, in workers, by the `derive` job. **None of it goes into a
region file, a save, git or an export (R54, R95).** `encodeDerived` gives canonical bytes, but only to compare and
hash results; they are never stored.

**Assembly evaluation contract (Q-b, R75).**
- A derive job gathers its chunk and its apron into one padded block of side E + 2·pad, where
  pad = rules.radius + `CONSUMER_REACH` (1).
- A pluggable rule set `AssemblyRuleSet {id, version, radius, resolve}` resolves every cell of the chunk, plus a
  one-cell margin, into a class byte:
  - bits 0–3: the class: 0 empty, 1 wall, 2 ground, 3 beam, 4 rail, 5 liquid;
  - bit 4: the feature runs along x;
  - bit 5: the feature runs along z;
  - both bits set: a post.
- Classes live only inside the job.
- A rule set may add a **case pass** (`resolveCases`, optional): the detail case of every cell of the same box, a
  u16 a cell beside the class byte (case index × 8 + fold transform, `NO_CASE` 0xffff for a cell with none;
  `kit-cases.ts`). Cases, like classes, live only inside the job: they are never stored, transferred or encoded,
  and no world format changes for them. `evaluateCases` runs it (a set without one gives no cell a case).
- **Placeholder rules v2** (`placeholder`, version 2, R = 2) read only the role (§2.2): beams, rails and posts are
  read from the built roles (wall, floor, foundation, stair, pillar), roof is a wall, an opening is open and empty,
  everything else built is a wall. Version 1 read the draft category (construction, roof). Since derived 22 every
  consumer draws a beam or rail class as a plain voxel (beams and banisters left the voxel phases, owner
  2026-11-05/06); the classes stay only as the placeholder's output.
- **Radius conformance (every rule set).** A rule set's `radius` is its own claim, and a rule reading further would
  read past the job's apron (air, or another row's cells) with no error. `ruleRadiusMismatches(store, rules,
  chunks)` evaluates each chunk with the job's pad (R + 1) and with 3 cells more and lists every cell the
  consumers read that differs. A test runs it for every registered rule set (`registeredAssemblyRules`) on random
  worlds at both chunk edges (with every detail role dabbed in), comparing each cell's class **and case**; the kit
  rules pass it. A rule (or a case pass) reading 3 cells while declaring 2 is caught (tested), a mismatch naming its
  `part` (`class` or `case`).

**Consumer tables (v11, `case-forms.ts`).** One evaluation feeds every consumer. Each cell the consumers read gets a
**form** in the job (a byte, never stored): its case's declared coarse **shape** and **base** where it has a case
(the catalogue declares them per case, R77: never read from a piece mesh, so a kit cannot change gameplay shapes and
every kit of a material type collides the same), else the form its class stands for (wall, beam, rail → box, a plain
voxel since derived 22; empty, liquid → none). Shapes are one box in 1/16 cell in the case's own orientation (front +z,
run x, up +y), turned by the case's transform: `box` 0–16³; `panel` a thin upright sheet along the run (z 6–10);
`bar` a horizontal member along the run (y, z 3–13); `post` a thin upright bar (x, z 6–10); `none`. Bases: `keep`
(the base surface draws the cell: shape box, or none) and `suppress` (nothing drawn, the cell hides no neighbour's
face: a piece replaces it; a level without pieces draws it as a body). A catalogue pairing them otherwise is refused
(`caseFormProblem`). Every case of the edge catalogue (v2) is keep/box; no case uses `panel`, `bar` or `post` since
the beam and banister cases left it (derived 22). (The superseded draft's `slab` shape and `reshape` base, used only by its
soffit, went with it in the 46c revision R3c; no derived byte of the world's rule set changed.)

| Form | Render solid | Collision | Nav blocks / stands on | Light coverage |
|---|---|---|---|---|
| box (walls, floors, roofs …) | yes | full box (merged) | yes / yes | 255 |
| panel (no case since 22) | no (piece) | its box | yes / no | 64 |
| bar (no case since 22) | no (piece) | its box | yes / no | 100 |
| post (no case since 22) | no (piece) | its box | yes / no | 16 |
| none (air, liquid, openings) | no | none (liquid: 49) | no / no | 0 |
| ground (terrain, by class) | density ≥ 128 | the ground surface: heightfield patches where it is a lattice, else triangles (level 0 only) | density ≥ 128 | its density |

Light coverage is the shape's share of the cell (`LIGHT_COVERAGE`); a cell supports standing when its shape covers
its whole top face. A uniform body region (one class and shape over the chunk and its margin) takes the short path
only when every cell's form is the box once its case is resolved (a margin cell's case may read open cells past the
region).

**Outputs per chunk.** A result records `v` (derived format version 22, `DERIVED_FORMAT_VERSION`), its rules {id, version, radius} and its
edge. Only the shader data reads a voxel's material or wetness; every other output is a function of role and
shape (v3, 45.10b: v2's material table and the material slots of vertices, instances and boxes are gone).
- **occupancy (R82):**
  - a chunk flag: 0 empty, 1 solid, 2 mixed;
  - 2 bits per 4³ brick, four bricks a byte, low bits first, bricks ordered (bx · n + bz) · n + by;
  - a bit a cell (local index) only when the chunk is mixed.
- **light:** one coverage byte when the chunk is uniform. Otherwise:
  - a bit for every fully covering cell;
  - the partial cells as u16 cells plus u8 coverages, in cell order.
- **collision (R105):**
  - boxes as 6 × u16 (min x, y, z, max x, y, z) in 1/16 cell steps from the chunk corner, no material (wall runs
    merge across materials; a physics material, where a game needs one, comes from the cell's shader data entry);
  - full-cell merges first (`fullBoxes` of them), then the partial shapes;
  - the ground surface buffer is the trimesh;
  - `ramps`: the roof planes as a triangle mesh (v15), in place of the plane cells' boxes.
- **nav (R100):**
  - a blocking flag (empty / solid / mixed), and a bit a cell when mixed;
  - the standable cells (free, on a supporting cell) as u16 cells, plus a u8 clearance each: free cells upward up to
    4 (2 m), with bit 0x80 meaning the free run continues into the chunk above.
- **surface buffers:** two per chunk, the projected ground and the modular base (the voxel faces plus the roof
  mesher's planes, v15). The base surface is not emitted under a suppressed base (a damage hole).
- **detail instances:** see below.
- **shader data** (`derived-shader.ts`): the material and wetness grid the surface shader blends from (owner
  2026-11-02: blending in the shader). It covers the chunk and a border of `SHADER_BORDER_CELLS` = 1 cell of its
  neighbours (side 34 at 32³), so a pixel at a chunk face blends with the next chunk's cells from its own grid and
  no seam shows. Cells in grid order `(x · 34 + z) · 34 + y`, grid cell g = chunk cell g − 1. Held as a palette of
  u16 entries `material | wetness << 12 | construction << 15` (air 0; construction: the cell's role is a
  construction role, derived v17) and every cell's entry id packed at the palette's width (0, 1, 2,
  4, 8 or 16 bits, 32 / width ids a u32 word, the last word padded with 0). A grid of one entry stores no ids. It
  reads the chunk and its border only, so a material or wetness change re-derives the shader data within the
  border of the change and nothing else (§2.2 feeds); `encodeShader` (side, width, count, palette, ids) is its
  canonical bytes for hashes.

**Surface vertex, mesh format v2** (stride 12 bytes, `SURFACE_VERTEX_BYTES`; v1 was 20, or 24 past 256 materials a
chunk):

| Offset | Format | Field |
|---|---|---|
| 0 | `uint16x4` | position in 1/1024 cell from one cell below the chunk corner; w: crack strength (low byte, derived v25), owner offset x and z (high byte, 4 bits each; derived v27) |
| 8 | `snorm8x4` | normal; w: 0, or owner offset y (7 bits) over a set bit 0 (derived v27) |

- **Owner offset** (derived v27, owner 2026-11-06 D519: no blend across the wall–roof seam; `derived-mesh.ts`
  `writeSurfaceExtras` / `surfaceOwnerOf`): a face that shows one cell's material alone carries, in quarter cells,
  the offset from each vertex to a point a quarter cell inside that cell (x, z −7 … 7, y −63 … 63); interpolated
  across a triangle it lands every pixel in that cell, so the shader reads it alone (material, wetness) and blends
  nothing. A merged face (derived v28: a roof row, D525) names its row: the offset is 0 along the row, so each pixel
  lands in the row's cell it lies over (pixels exactly on the row's end edges may read the cell past it). The roof
  mesher's polygons name theirs (a plane cell its top, underside and the sides above its underside; a supported
  cell's floor and its sides below its underside the body under it); a body's face whose shader read reaches a plane
  cell (its layer and the one in front, 3 × 3; v27: any face of a body with one among the 26) names the cell a quarter
  cell behind it. Merges never depend on a material. Still no material on a vertex.

- A vertex carries no material and no weight (owner 2026-11-02): the shader finds the materials around each pixel
  in the shader data, so a material or wetness change rebuilds no mesh and a blend is the same on any mesh that
  covers the surface (any later mesh level of detail).
- Indices are u16 below 65,536 vertices, otherwise u32.
- Triangles are counter-clockwise seen from outside.
- **No cracks between chunks.** A boundary vertex is a function of samples within the job's pad, quantised as
  integer steps in world cells, so both chunks (and both sections) compute the same bits. A sample edge belongs to
  the chunk of its lower sample, so no triangle is drawn twice.
- **Ground and base producers:** the terrain mesher and the base surface, below in *Terrain rule set, mesher,
  base surface, levels, seams and LOD selection*.

**Detail instance (12 bytes from v23; 8 bytes v12–v22):**
- u8 x, y, z: the cell inside the chunk;
- u8: bits 0–1 quarter turns about +y, bits 2–3 the placement (`INSTANCE_PLACE`), bits 4–7 flags (0x10
  `replacesBase`, 0x40 `half`: drawn over the half of its run on its case's +x side, `pieceHalfRun`, v19; 0x20
  `shallow` (v24): a roof-edge piece of a 1:2 roof, pitched by the renderer onto the 1:2 plane (`roofPitch`), 0x80
  `high` with it: the plane is its pair's high cell; 0x20 was `low`, drawn at low detail, until v21);
- u16 piece, **kit-local** (`piece-table.ts`, v22): the index of a filled slot of the kit the cell's material names,
  0-based in catalogue case order; no engine default piece, and a material no kit binds lists none;
- u16 variant word: bits 0–14 which of the slot's meshes it draws (v22), bit 15 the mirror (a verge rising toward its
  own −x, v18; mirror first, then the quarter turns);
- u32 dressing word (v23, `dressingWord`): bits 0–4 the cell whose material (so whose kit) draws the piece, as its 3³
  block index round the instance's cell + 14 mod 27 (0: its own cell; edge-cases.ts `slotDressing`: where roles
  meet, the higher of roof > wall > pillar > stair > floor > foundation; winners of two kits leave the slot bare),
  bits 5–10 the cell's faces the piece is cut flush at toward an opening (bit 2a the −a face, 2a + 1 the +a face;
  the renderer cuts the mesh 1/128 cell inside them, `cutFlush`), bits 11–31 written 0. The material is read from the
  shader data (border included). The stride stays a multiple of four, as a GPU instance buffer
  needs. What the hosts draw for each is in *Kits: edges, roofs and damage* ([kit page](voxel-kit-format.md)).

**Shader data on the GPU and the surface shader (45.10b; three-adapter `voxel-surface.ts`).** One renderer path:
the engine's node materials (`MeshStandardNodeMaterial`), the same program on WebGPU and WebGL 2, no feature of one
backend only.
- **Layout (default chosen by measurement, owner to confirm).** Dense: each drawn chunk whose grid holds two or
  more solid entries gets a 34³ region of one GPU-only 3D texture, `rg8unorm`, two bytes a cell (the entry's low
  byte, then its high byte: material low 8 bits, material high 4 bits | wetness << 4), 78,608 B a region. Texel
  (x, y, z) of a region is grid cell (y, z, x), so the grid's memory order is the texture's and a grid uploads as it
  is. A chunk whose grid holds one solid entry (air aside) needs no region: its objects pass the entry instead (a
  surface there blends to that entry wherever it is). A region is uploaded alone (`queue.writeTexture`; WebGL 2
  `texSubImage3D` through three's copy), no CPU copy of the texture is kept, and the texture grows by a quarter
  along its shortest axis by a GPU copy (edge at most 2,048 texels: 216 k regions).
- **Per object:** the region's origin and the one-entry fallback (a vec4), the chunk corner's cell modulo 1,024
  (the texture phase), and the corner in metres modulo 512·√2 m and 512·√5 m (the 45° and the 1:2 slope phase,
  for V up a roof plane; a normal whose vertical part is over 1.5 times its horizontal part reads the 1:2 one, v24):
  uniforms of the object, so a floating-origin shift never moves a texture.
- **Blend.** A pixel moves a quarter of a level-0 cell (`SHADER_READ_DEPTH_CELLS`, 0.125 m at every level) into
  the surface along its normal (a face between a solid and an air cell reads the solid cell), clamps to the grid and reads the 8 cell centres around it. Each corner's weight is,
  per axis, a ramp of the blend distance across the face between two cells (`clamp((f − ½) / d + ½)`, d the
  distance in cells; a setting, default 0.25 m, 0.05–0.5 m seen), air left out. The two heaviest materials are
  kept, looked up in a material table (colour, test pattern) and mixed by their weights; wetness, averaged the same
  way, darkens the colour (× 1 − ½·w/7) and lowers the roughness (0.85 → 0.3). A pixel whose blend weights find
  no solid cell (a roof plane runs up to a cell above each tread of its stair, through air) takes the solid of the
  8 with the largest plain trilinear weight (D503); grey only with no solid among the 8.
- **Projection (derived v17).** An entry's bit 15 (`SHADER_CONSTRUCTION_BIT`) says the cell's role is a
  construction role. Terrain: triplanar in world metres, one repeat `TERRAIN_TILE_METRES` (2 m). Construction:
  mapped from the build grid in metres (`voxel-surface-projection.ts` `gridUv`), one repeat
  `CONSTRUCTION_TILE_METRES` (4 m: owner 2026-11-04, one full-size wall) both ways: on a wall U along it (to the
  right seen from outside), V = world height; on a floor U = x, V = −z (a ceiling x, z); on a sloped face (a roof
  plane) U level along the slope, V the distance up it (the slope phase), so a band is parallel to the eave. So a
  band of a construction texture sits at the same height on every wall and floor, across chunk faces and levels.
  The material table carries both repeats per material (defaults above; each must divide the 512 m phase). The
  slice page's `?bands=1` draws construction with a band test texture (a line every 0.5 m, thick red at 0 m and
  blue at 2 m of the tile, a tick every 1 m, the metre written above each whole-metre line).
- **Reads a pixel (counted in the program three builds, WGSL and GLSL, `voxel-surface.test.ts`):** 18: 8 grid
  texels + 4 material table texels (look and repeats, 2 materials) + 6 pattern samples (2 materials × 3 planes; a
  construction material takes one plane); three's BRDF table adds 1 for the standard material; `?bands=1` adds 2
  band samples and a texture unit. Texture units: 3 (grid, table, pattern array) + 1 (BRDF), leaving the light
  path's 3 within the lit programs' 16.
  Every implicit-derivative sample sits in the program's top-level flow (WGSL refuses one in a branch that varies
  per pixel; tested).
- **Alternatives measured (derive bench, Node, five worlds):** the packed palette form the result keeps is 2.6–6.1
  KB a chunk (7–12 KB a drawn chunk); a dense region is 78.6 KB; a sparse form (a 9³ table of u16 brick entries plus
  128 B for every 4³ brick of two or more entries) would be 12.6–26.8 KB a region (3–6× smaller) for one more
  table read per corner (8 more a pixel). Not built: proposed for when grid memory matters (46a/46d).

**Measured (45.10b).** Derive bench before → after (same hour, `run.mjs derive`, five worlds): vertex 20 → 12 B;
surface buffers (vertices + indices) per chunk −26 % (plain, hilly, caves, vertical) and −33 % (town); derived
bytes per chunk town 38.5 → 30.9 KB, caves 72.0 → 60.0 KB, vertical 33.1 → 28.1 KB, hilly 12.0 → 11.3 KB, plain
15.3 → 15.3 KB (the bordered shader grid grew what the vertices saved); mesh µs per chunk 5–43 % less. Collision
in town 183 → 186 B a chunk (12-byte boxes without a slot, wall runs merged across materials: 13.1 → 15.5 boxes).
Grids needed: 27–56 % of drawn chunks in the five worlds, 518 of 525 in the slice ring (grass over soil within one
cell). The slice on staging, 720p at the 60 Hz cap (plan **45.10b**): frame p95 16.7–16.8 ms, 0 missed of 1,799 on
both renderers; GPU time per frame (timestamps; the page's one pass is the voxel scene) blend / one flat colour
7.1 / 3.1 ms WebGPU, 3.8 / 1.9 ms WebGL 2; grids 519 regions, 50.3 MB of texture (40.8 MB used), 0.1 / 0.2 ms p50 /
p95 to expand and upload one; a material or wetness paint over a chunk corner: 0 meshes built, 20 grids uploaded,
visible in 48–71 ms.

**Dependency and invalidation (Q-c).**
- A job's apron is R + 1 deep: 3 for the placeholder.
- A worker refuses a job naming a rule set, version or radius it does not have.
- The streamer derives with one rule set; a rules upgrade means a new streamer that rebuilds everything, never mixed
  results.
- Tested:
  - a corner edit rebuilds exactly the 8 chunks around it;
  - an edit 3 cells under a chunk boundary changes the chunk above;
  - 16 random edits leave every result in a 32-chunk window equal to a fresh derive.

#### Terrain rule set, mesher, base surface, levels, seams and LOD selection (as built in 46b; derived v3 → v9)

This subsection is the whole terrain and level-of-detail path as built (R108, R109), in the order a world takes it:
the rules classify, the mesher and the base surface build a chunk's surfaces, the downsample builds coarser levels,
the same derive meshes them, seams join two levels, the selection picks what is drawn, and the view draws it.
**No stored format changed in 46b.** Chunk codec, region file, manifest, stroke command, undo record, save and
overrides are as approved in v1; every output here is derived in workers and never stored, so each change of its
meaning stepped `DERIVED_FORMAT_VERSION` (9 at the end of 46b, 10 since 46c.3, 11 since 46c.5, 12 since 46c.6; the history and owner notes are at the end of this subsection),
nothing was upgraded and no world had to be regenerated. The one authored addition is the scene setting
`voxelWorld.levels` (project schema 8, an optional field added canonicalized field by field), not a voxel format.

**Terrain rule set (`terrain-rules.ts`, `rule-registry.ts`).**
- `TERRAIN_RULES` (id `terrain`, version 1) = `withTerrainFeatures(PLACEHOLDER_RULES, 'terrain', 1)`: the
  placeholder construction rules and the ground features in **one** `AssemblyRuleSet`, one evaluation a job,
  radius the larger of the two (`TERRAIN_RULES_RADIUS` = 2), so the job's pad stays 3 and aprons and invalidation
  are unchanged. `WORLD_RULES` was `TERRAIN_RULES` through 46b; from 46c it is the kit rule set ([kit page](voxel-kit-format.md)), which
  resolves the same classes. `PLACEHOLDER_RULES` stays registered for tests; under it the mesher places
  creases as plain nets.
- Every solid (non-open role, fill at or above the surface threshold) ground cell with an exposed face gets a
  feature in the high nibble of its class byte (`TERRAIN_FEATURE_SHIFT` 4; every consumer masks the class, so the
  other outputs' bytes are unchanged): `gentle`, `steep`, `cliff`, `terraceLip`, `overhang`, `caveRoof`, `thin`,
  `spike` (`TERRAIN_FEATURE`; `none` for buried, partly filled and non-ground cells). Order: spike (open both sides
  along two or more axes) → thin (one axis) → open below: overhang if the mass ends within 2 cells with open cells
  above its end, else cave roof → open above and on a side: cliff if the drop over the 5 cells level with the cell
  exceeds 2.5 cells, terrace lip if it is 0.5–2.5 with flat ground behind and in front → else by the rise a cell:
  ≥ 2 cliff, ≥ 0.5 steep, else gentle (`TERRAIN_THRESHOLDS`; terraces are read along x and z only).
- Features are local (radius 2): a ledge wider than that reads as a cave roof underneath except the 2 cells behind
  its front. The mesher treats both as downward faces. Features live only in the job, like every class.
- **Conformance:** `ruleRadiusMismatches` passes for every registered set on random assembly and random terrain
  worlds at 16 and 32 (`derived.test.ts`), and every hard case of the `features` world is classified as named.
- Thresholds stay in cells at every level (a level-2 terrace lip is a step of 0.5–2.5 two-metre cells): the radius,
  apron and conformance stay one contract, and what a level cannot hold leaves through the downsample.
- Cost: evaluation ~92–116 µs a 16³ ground section p50 (Node), against 38–45 for the placeholder rules alone.

**Ground: the terrain mesher (`terrain-mesher.ts`, `terrainSurface`).** It replaced the naive surface nets
(`groundSurface`, v3), which live on in the bench (`tools/voxel-bench/mesher-candidates.ts`, `reference`) as the
goldens' "before"; it was picked over plain nets, column-lattice nets alone, dual contouring alone and marching cubes
by measurement on the hard cases and five worlds (plan-46b 46b.3a).
- **Placement (v4; straight steps v6).** Surface nets over the terrain cells' density, one vertex
  a dual cube, placed by the terrain rules' features: a cube touching a cliff or terrace-lip cell whose four sample
  columns are a straight step (two columns a side, each a height function over the lattice window or wholly full or
  empty there; v6) takes the lattice point at the higher column top between its two sample centres (the step's
  edge, or its foot when only the lower top lies there: the 4-bit fill is a height, so the step's face stands on
  the cell boundary); any other such cube takes the dual-contouring point of its edge crossings (QEF, pulled 0.05
  toward their mean, inside the cube); a cube whose
  four sample columns are each a height function over `LATTICE_WINDOW` (2) cells either side takes the column
  lattice point (the cube's centre x/z, a cell corner, at the columns' mean fill height), shared by every cube of
  that column stack, so the quads between them collapse; any other cube the mean of its crossings. Non-lattice
  vertices stay one step inside their cube and off its centre line, so only lattice vertices are ever shared and
  a chunk's joined sections are its whole derive, triangle for triangle. **Reach:** the mesher reads voxels
  `TERRAIN_MESHER_REACH` (3) cells above and below the chunk and classes one cell round it, within the job's pad
  (R + 1 = 3), so invalidation is unchanged; a narrower pad is refused, and a test meshes random terrain with the
  job's pad and 3 cells more and gets the same bytes. With rules that set no features (placeholder), creases are
  placed as plain nets.
- **Ground normals (v5).** A column-lattice vertex takes the slope of the column heights round it: over the 4 × 4
  columns (weights 1, 3, 3, 1 each way) when each is a height function over the two cells either side of the cell
  boundary nearest the vertex's height (a window that follows the vertex, not the cube, so every cube, section and
  chunk gives it the same normal), else over its cube's four. One cell's slope of 4-bit fills rounds by up to 1/30
  cell a column and banded 1:5 slopes by up to 6°; the wider slope keeps them within 2°. Other vertices take their
  cube's sample gradient. **Creases split:** a vertex whose cube touches a cliff, terrace-lip, overhang, thin or
  spike cell, whose inside corners are not one half of the cube and whose crossing edges each have a whole cell or
  a whole air cell at one end (an edge or corner of the voxels, not a smooth surface slanting through them) is a
  crease vertex; each quad whose face turns more than `CREASE_SPLIT_DEG` (10°) from the vertex's gradient takes a
  copy of the vertex carrying the face's normal (Newell's, from the quad's four placed positions, so every section
  and chunk gets the same copies; copies with equal snorm8 normals are one vertex). One position can therefore
  appear in several vertices; consumers that weld (collision: Rapier merges duplicate vertices) are unaffected.
  Gentle and steep ground never split.

**Base surface (v6, `base-surface.ts`).** The exposed faces of wall-class cells, coplanar faces of one direction
merged inside the job's section into rectangles (greedy, row by row a layer), whatever their materials (vertices
carry none). No T-junctions: a rectangle's edge also takes every lattice point where another rectangle of the
section has a corner, and on the section's faces every lattice point (the neighbour merges on its own); merges
never cross a section face. The ground and detail pieces share no edge with the base, so they set no vertex on
it. A rectangle fans from a corner whose two edges have no extra point, else from its centre. Joined sections
and a whole-chunk derive then cover the same faces once each, crack-free, in different triangles (tested on
the town and a closed shell). In 46c the base keeps every flat face (no piece stands on one), the roof mesher's
planes are appended to it (v15) and damage holes draw no faces (v16; v25 by the kit's stages), in the same layout.

**Voxel mips (R84, R85; downsample v9).**
- A level-L node has the chunk's form: 32³ cells of 0.5 m × 2^L (`mipCellMetres`), using the same store, codec and
  mesher input. Mips are derived, never stored.
- Its shape is the share of the node cell that is solid: the rounded mean of the 8 children's fill levels (0–15),
  counting only solid roles (air, liquid and openings add nothing). So a fill means the same at every level and
  the terrain mesher's surface sits where the solid volume is.
- Its role goes by priority, `MIP_ROLE_PRIORITY`: wall, foundation, pillar, floor, stair, roof, terrain. Bodies
  drawn as whole cells (every solid role but terrain) hold the node cell when their cells are at least 4 of the 8,
  or when at least `MIP_SHEET_CELLS` (2) of them lie in a sheet: `MIP_SHEET_NEIGHBOURS` (6) bodies among the
  cell's 26 neighbours (a neighbour outside the node is read as its mirror through the cell). Cells count, not
  their fill (derived 9): a body is drawn whole whatever its fill. So a one-cell wall, floor or 45° roof stays a
  closed shell at every level, thickened to the level's cell, and a line of cells (post, rail, fence) leaves the
  level. The node cell takes the first body role among those cells. Terrain holds it with any fill.
- With no solid role, the cell is liquid when its liquid cells' share rounds to at least 1 (the shape is then that
  share), else air.
  (Derived 31 adds narrow openings closing and wider ones kept as openings, and the far cache keeps levels 2 and
  up of the mips as a derived cache: [voxel-render-spec.md](voxel-render-spec.md) §4.)
- Its material is the one its surface shows (derived 8). Among the counted cells nearest the surface it takes the
  material of the most cells (ties: the larger summed fill, then the lower id). Nearest means, best first: partly
  filled or beside an open cell; beside a partly filled cell; beside the node's side (not read there); buried. So
  grass one cell thick over earth stays grass at every level. A liquid parent takes its dominant liquid. Wetness
  comes from the first such cell of that material.
- `MipStaleSet` marks the ancestors of every changed chunk; they are rebuilt lowest first.
- There is no paint layer (O16 closed by the owner): colour comes from the material and the shader.

**Deriving a node (46b.6a, `mip-derive.ts`).** A level-L node derives through the chunk derive unchanged
(`deriveWithApron`, `deriveSectionsWithApron` with `level`): its cells and an apron of the same level's
neighbouring nodes, the same rule set (`WORLD_RULES`), the same terrain mesher, base surface and consumers. The
rules' thresholds and reach, the mesher's lattice and crease rules and the shader border stay in cells: a node's
terrace lip is a step of 0.5–2.5 of its own cells. Tested: a node's bytes equal a chunk derive of the same cells
except the level.
- The result records `level`. Every position, box, cell index and the 34³ shader grid (the node's cells plus one
  node cell round it, each its downsampled material and wetness) are in the level's cells. A vertex at p steps
  lies at ((n · E − 1) · steps + p) / steps cells of the level, × `mipCellMetres(L)` metres.
- The surface shader's blend distance is set in metres. Per level it is converted with `mipCellMetres`, so a blend
  is equally wide at every level. The converting is done by the chunk view (46b.8b).
- `groundHeightfield` takes the level's cell size, so a node's lattice ground collides or measures as a heightfield
  at every level.
- `MipTree` builds nodes on demand from a level-0 store (benches and tests); the streamer builds them in workers.

**Mips at runtime (46b.6b, `stream-mips.ts`).** With rules, the streamer keeps nodes of the levels in its mip rings
(`DEFAULT_MIP_RINGS`: level 1 and level 2 to 384 cells, horizontal box distance; results kept 16 cells past; level 1 reaches
the load ring to stand in where level-2 nodes are not complete, 46b.8a).
- Cells: a `mip` job downsamples a node from its 8 children (level 1: resident chunks with the overlay laid over the
  base; above: the level below's complete nodes). A child not known counts as air and the node records the octants
  it was built from; it is complete when all 8 were known. Cells of every node over resident chunks are kept.
- Derive: a `derive` job with `level` for a complete node in its ring once the octants of its 26 neighbours that face
  it are known (the apron, R ≤ half a node deep, lies only in those). A node over chunks not all resident is never
  derived or drawn from guessed cells.
- Staleness: a level-0 change marks every ancestor stale (`MipStaleSet`, rebuilt lowest first once the children are
  settled) and moves the derive stamp of the nodes within R of the change at each level (the box scaled by 2^L): a
  dig inside a node re-derives its ancestors only. A chunk leaving drops its ancestors' results at once.
- Edits swap whole: every node an edit (or a refresh, or a restored or cleared overlay) makes stale that is shown
  (drawn, or read by a drawn seam) joins the edit's level-0 group (a shown node meeting another open group merges
  them). Every stale node's jobs go in the `edit` lane (a shown one ahead of the edit's level-0 rebuilds). The new
  results of the shown nodes are held, the old ones drawn, until every one has its new result; they and the seams
  reading them or the edit's chunks go in with the level-0 swap, in its task (`SwapReport.nodes`). Nodes not shown
  join no group and go in as they land, so edits meeting only under nodes nobody draws swap on their own.
- Measured (Node, slice ring, default rings, 4 workers): 330 level-1 and 13 level-2 nodes derived, 6.4 MB of mips
  (1.6 MB cells) against 25.4 MB for level 0; worker µs a node p50/p95 downsample 2,600/7,100, derive 1,600/9,700.
- Measured (Node, hard cases): levels 1 and 2 are closed, and every surface lies within the level's cell of the
  true one. Triangles are 22–25 % of the level below. Features of at least the level's cell stay.

**Seams between levels (`lod-seam.ts`, `buildFaceSeam`; `stream-seams.ts`, `StreamSeams`).** Picked by measurement
over the finer side's stitch strip, skirts and skirts with flaps (plan-46b 46b.7a): the **coarser** side's
transition strip with flaps.
- One coarse node face's seam is built (job kind `seam`, in a worker, pure) from the node's derived surfaces, its 8
  same-level neighbours beside the face and the finer surfaces against the face and beside it (the 4 finer nodes,
  or the level-0 chunks' sections within a cell of the plane), all read in a window of the face ±
  `SEAM_RIM_CELLS` (4 finer cells).
- Every coarse boundary vertex moves to the nearer end of its nearest finer boundary edge, so every seam vertex is
  exactly a vertex of one of the two meshes. The coarse triangles touching a moved vertex (the node's and its
  neighbours') are drawn again by the seam with it moved; the originals stay drawn (a band up to a coarse cell wide
  drawn twice, nearly coplanar, shaded the same). The fill between the moved coarse boundary and the finer one is
  fanned; flaps one coarse cell deep go under coarse edges whose ends land on different boundary chains or the wrong
  way round, and under finer edges no strip reached.
- **Level 0 is never touched:** no level-0 vertex moves, so the drawn level-0 mesh, its heightfield and its collider
  stay one. The coarse node's own mesh is not changed either (a node's mesh never depends on its neighbours' levels).
- Output: pieces, one per finer node against the face, three vertices a triangle, positions in the finer level's
  steps from that node's corner less `SEAM_PIECE_PAD_CELLS` (8) on every axis (a whole face and its rim do not fit
  u16 steps); `seamBytes`. Seams count in `bytes.mips`.
- **When rebuilt (atomic where something is replaced):** a mip node's new result is held until the seams reading it
  are rebuilt from it (its `node` event and their `seams` event in one task); an edit's section group swaps only once
  the seams reading its chunks or its shown nodes are rebuilt from their held results (the nodes' `node` events and
  the `seams` event just before the `swap`); a
  level change builds every face it adds before it goes in (below). Seams whose inputs arrive while streaming in are
  built as their jobs come back (there is no old seam to keep).
- Measured (28 two-level patches: 11 hard cases, hilly, caves, town, at L0|L1 and L1|L2; 2.8 M rays): crack rays
  79,268 without seams → 0 in every patch but one cave saddle (358 rays at one place, **D462**: two cavities that
  level 0 and level 1 connect in a different order; a strip matching boundary chains cannot join them; proposed fix
  a strip meshed from voxel samples). +23–55 triangles a fine node face (caves 76 / 139), worker µs a face p50 62.

**LOD selection and the level rings (`lod-select.ts`, `chooseLevels`; `stream-lod.ts`, `StreamLod`).**
- Per top-level node over the unload bounds, a node of level L ≥ 1 splits while its horizontal box distance from
  the nearest focus is under `radii[L − 1]` (+ the hysteresis once split). Defaults `DEFAULT_LEVEL_RINGS`
  (`stream-ring.ts`): radii 128 / 256 cells (level 0 to 64 m, level 1 to 128 m, level 2 past it), hysteresis 16
  cells (8 m). The foci are the stream focus and every collision focus (characters, passed by the runtime host).
- Only ready nodes are drawn (a node: a result, `null` included; a chunk: every section has had one). A node wanted
  split whose children are not all ready stays whole; a node wanted whole that is not ready is drawn as its
  children, a finer level standing in only to one node of the next level past its own ring. Then 2 : 1: a node
  facing nodes two or more levels finer is split while its children are ready; what cannot be mended is counted
  (`unbalanced`), never hidden. `DrawnLevels` is the `LevelSelection` the seams read (`faceLevels`).
- **A swap:** the streamer chooses again after the focus moved a cell, a node or chunk became ready or left, or the
  rings changed; a choice that differs becomes the seams' selection and goes in only once every face it adds is
  built: one `seams` event, then one `levels` event (`reason: 'swap'`) in the same task, so the old level stays drawn
  until the new one is complete. One swap builds at a time. A drawn node that loses its result leaves at once
  (`reason: 'lost'`).
- **The `levels` setting:** `voxelWorld.levels { level0?, level1? }` in metres (1–100,000, unknown fields refused,
  `level1` below `level0` taken as it), scaled by the quality level (*Residency* above); `worldLevelRings` turns it
  into cells and widens level 0 to the collision radius + its 8 m hysteresis, so a chunk with a collider is always
  drawn at level 0. Level 0 is also the detail-piece ring (pieces are drawn at level 0 only).
- **Mip rings:** `mipRingsFor(ring)` keeps levels 1 and 2 derived to the load ring (`DEFAULT_MIP_RINGS`: 384 cells
  for the default ring; a ring change moves them), results kept
  `MIP_RING_HYSTERESIS_CELLS` (16) past it. A level-2 node is complete only where the chunks round it are
  resident, about 100 m out in the 192 m load ring, so by default level 2 is never drawn and level 1 stands in from
  128 m to where its nodes end (~160 m).
- Measured (Node, slice world, default rings, 160 m flight at ~33 m/s): 72 swaps, 23 level changes, choice → swap
  ms p50 0.5 / p95 4.5 / max 118; streamer update p50 0.78 / p95 2.6 ms. A ±6-cell jitter round a ring flips nothing.

**Drawing the levels (three-adapter `chunk-batch.ts`, `voxel-chunk-view.ts`, `voxel-surface.ts`).** The batcher
sends only what the selection draws; a level swap and its seams leave in one batch and are applied between two
frames (one apply path, `applyChunkDrawBatch`, for the slice page, Play, the Scene view and exports). One draw a
node, placed at its corner (level-0 cells × 2^L) and scaled by `mipCellMetres(L)`; seams one object a face, shaded
from the coarse node's grid. **Shader data per level:** each node's 34³ grid is its own (the surface's material,
above); each object passes its grid's cell size (`cellMetres`); the blend distance is a metres setting divided by
the cell in the shader, the read depth `SHADER_READ_DEPTH_CELLS` is a quarter of a level-0 cell (0.125 m) at every
level, and triplanar patterns stay in level-0 cells, so a material and its blend look the same at every level
(columns showing another material than level 0: hills 0 / 0.005 %, hard cases 0.007 / 0.09 % at L1 / L2). Picking
takes level 0 only. Measured on staging (1280 × 720, 60 Hz cap): triangles drawn slice 0.81 → 0.31 M, town 1.96 →
0.80 M; render() CPU slice 1.4–1.5, town 3.0–3.2 ms. Miss, cause not traced: WebGPU GPU time +1.6–1.7 ms in oblique
views with the levels (equal from above and on WebGL 2).

**Pieces per level (46b.9, derived 9; two detail states since derived 21, owner 2026-11-05; `levelDrawsPieces`).**
Only a chunk (level 0, the near ring) lists pieces. Level 1 and coarser list none: their edges are plain square
voxel faces, and the base surface draws the cells the rules call beams and rails as bodies (at every level since
derived 22). Collision, navigation and light read the class, not the level. The renderer draws a piece with its
kit slot's mesh (three-adapter `VoxelPieceMeshes`); an empty slot draws nothing. (Derived 9–20 listed level-1 pieces with a `low` flag drawn by a
kit's low mesh.)

**Collision stays at level 0, ground as heightfield patches (`ground-heightfield.ts`, `groundHeightfieldPatches`;
`derived-collision.ts`, `collisionGeometry`).** Only level-0 chunks inside the collision ring have bodies; a node,
a seam or a stand-in never collides. The column-lattice ground of a chunk is read once: cells within 5 mm of a
lattice heightfield with no riser on an edge and no air under solid (overhang, arch, cave roof stay triangles) are
covered by rectangles (greedy), and a rectangle of at least `MIN_HEIGHTFIELD_PATCH_CELLS` (16) becomes a heightfield
in the chunk's one body, the rest triangles (`'level'` keeps the older level-only rule, `false` none). Sloped
heightfields are on because the physics port sweeps them a cell at a time (`physics-rapier` `sweep3d.ts`; Rapier
0.20's own heightfield cast landed late, D443, fixed). Measured: ground chunks with fields slice / hilly 53 / 54 %,
town 42 %; the slice flight's physics heap 16.4 → 2.4 MiB; a slanted sweep 21 → 86 µs p50.

**Limits as built (open, for the owner).**
- D462: the cave saddle hole at an L0|L1 seam (above).
- D463: the load box is 192 m across but only ±96 m up and down, and coarser levels stand in only one node past
  their ring, so the top and bottom 32 m of the box are drawn only within 96 m: terrain rising more than ~64 m above
  the camera loses its top beyond ~96 m, and level 2 is never drawn in the default ring.
- R107's frame budget: evaluation + mesh 207–307 µs a 16³ ground section p50 (Node; mesh alone ~110, caves ~190)
  against 0.1–0.2 ms: the rules' evaluation (~100 µs) is the cause.

**Measured (Node, hard cases and worlds).** Hard cases at level 0: every case closed, every probe kept, slope mean
error 2.7 → 0.4 cm (1:20), terrace lips within 1/30 cell of the true edge, slope normals within 2°, creases kept
(40–64°). Triangles, naive → as built: slice window 0.66 → 0.59 M (−11 %), town 2.87 M (45.10c) → 1.62 M; levels 1 and 2 each
22–27 % of the level below (slice 1.05 M → 262 k → 66 k; town 1.62 M → 386 k → 106 k with houses kept). Mesher µs a
section: see the limits above.

#### Kits: edges, roofs and damage — moved

The kits section (as built in 46c and its revision; derived v10 → v28: edges, roofs, damage, pieces, the piece
table, drawing and the kit check) moved unchanged to [kit page](voxel-kit-format.md) (46d.2, D496; owner note: a split, no content or
version changed). Rendering and material additions of 46d go to [voxel-render-spec.md](voxel-render-spec.md).

#### Derived version history, chunk-tree flags, prop lighting

**Derived version history (v2 → v22).** Every step: nothing stored, nothing to upgrade, no world regenerated (the
slice and town write construction at 15; the staging project's log and stone kits are imported again after v19 and v22,
`run.mjs kits`); a worker refuses a result of another version (`DERIVED_FORMAT_VERSION` + the rules' id, version
and radius). Every owner note is "default chosen, owner to confirm" unless it names the owner's decision.

| Step | Item | What changed | Layout | Owner note |
|---|---|---|---|---|
| 2 → 3 | 45.10b | no material in vertices, instances and boxes; shader data grid (§7, 45.10b) | 12-byte vertex | owner 2026-11-02 (blending in the shader) |
| 3 → 4 | 46b.3b | the terrain mesher places the ground's vertices | unchanged | below |
| 4 → 5 | 46b.4 | ground normals: lattice slope over 4 × 4 columns; crease vertices split | unchanged (a position may repeat) | below |
| 5 → 6 | 46b.5 | a straight step's crease on the lattice (D461); base faces merged per section | unchanged | below |
| 6 → 7 | 46b.6a | a result records its level; downsample by solid share and role priority | `level` in the canonical bytes | below |
| 7 → 8 | 46b.8c | a mip cell wears the material its surface shows; shader reads 0.125 m deep (D464) | unchanged | below |
| 8 → 9 | 46b.9 | pieces per level (`low` at level 1, none past it); mip bodies hold a cell by cells (D465) | unchanged | below |
| 9 → 10 | 46c.3 | the case pass in the job (`kits` v1); cases never stored | unchanged | cases live only in the job, like classes; outputs equal the terrain rules' where no cell has a case |
| 10 → 11 | 46c.5 | collision, nav and light from each case's declared form | unchanged | a kit cannot change gameplay shapes by its art (R77) |
| 11 → 12 | 46c.6 | piece u16 kit-local, reserved u16 = variant word (hash of cell + kit seed, bit 15 mirror) | still 8 B | variants never reshuffle under edits elsewhere |
| 12 → 13 | 46c.6b | no material in a case (same-material bit only where a rule reads it, D478) | unchanged | a same-kit paint stays shader data |
| 13 → 14 | 46c R1 | construction shape = integrity: every consumer reads a construction cell of any integrity as whole; a construction mip parent is 15; terrain and liquid unchanged | unchanged | **owner 2026-11-04** (damage uses the shape field, no new bits); mip parents intact a default |
| 14 → 15 | 46c R2 | roof mesher: plane cells drawn as planes in the base surface, `collision.ramps`; roof words | ramps in the canonical bytes (vertex count a header flag) | **owner 2026-11-04** (roofs get their own mesher) and **2026-10-27** (slopes collide as ramps); the rules a default |
| 15 → 16 | 46c R3 | pieces on edges, corners, roof edges, beams/banisters and debris only; `WORLD_RULES` = `edges` v3; placement bits | still 8 B | **owner 2026-11-04** (detail only where faces meet; debris from integrity) |
| 16 → 17 | 46c R4 | shader entry bit 15 = the cell's role is construction; role feeds the shader data | entry u16 unchanged | **owner 2026-11-04** (4 × 4 m tile on the build grid); the bit a default |
| 17 → 18 | 46c R5 | a verge before the rise mirrored (D506); `centred` also half a cell down | still 8 B | default |
| 18 → 19 | 46c R6b | coarse levels re-lay sloped roofs (`relayRoofs`, D510/D501); `half` flag on an apex's ridge and hips (D511) | still 8 B | default |
| 19 → 20 | 46c R9b | the re-laid roof takes the coarse cells of bodies it covers (gable end walls, walls under eaves; D513/D514) | still 8 B | default |
| 20 → 21 | 46c.16a | two detail states: level 1 lists no pieces (the `low` flag gone, its bit written 0), its beam and rail cells drawn as bodies; no case past level 0 | still 8 B | **owner 2026-11-05** (pieces in the near ring only, no low meshes) |
| 22 → 23 | 46c.16c | 12-byte instance: the dressing word (dressing cell, flush faces); mixed corners take a corner piece (`MIXED_CORNER`, rules `edges` v5); no piece inside an opening | 12 B | **owner 2026-11-05/06** (A3/F1 role order, F2 two materials bare, A11 mixed corners, B7 flush at openings) |
| 21 → 22 | 46c.16b | kits are slots: piece u16 = a kit's filled-slot index (no default pieces), variant bits 0–14 = the slot's mesh, hashed with the project seed; no beam or banister case, beam and rail cells plain voxels | still 8 B | **owner 2026-11-05/06** (kits are slots, beams/banisters out, no default kit, per-project seed, per-kit jitter) |
| 24 → 25 | 46c.16e | three damage stages a kit (piece table 4, rules `edges` v7, catalogue `edges-draft` v3): stage 1 a cracked body with its edges, the crack strength in position w; stages 2–3 a hole drawing no piece of its own (`debris` cases and `replacesBase` gone) whose neighbour faces carry the stage's damage pieces with a scatter index (dressing bits 11–14); a damaged cell's light coverage its integrity's share | 12 B | **owner 2026-11-05/06** (A9 revised three stages a kit, G1 default split and crack overlay, F4 solid until air but light by integrity, C10 strokes whole) |
| 23 → 24 | 46c.16d | 1:2 roofs drawn as planes (roof words read two cells round, quarter-cell geometry), their roof-edge pieces flagged `shallow` / `high` (0x20 / 0x80) and pitched by the renderer; a roof over a body or over one air cell over a body closes down onto the body (rules `edges` v6: no edge piece round that air cell); coarse levels re-lay 1:2 roofs at 1:2 | 12 B | **owner 2026-11-05/06** (A7 1:2 roofs, A8 ramps, F3 one mesh pitched, C4 parallel underside, wall tops cut, C7 coarse re-lay); one slope a roof a default |
| 25 → 26 | 46c.16h | the roof follows the kit's damage stages: a roof cell drawn whole by its kit (cracked, or an integrity in no stage) stays a plane cell, its planes carrying the crack strength in position w; a cracked body under a roof still carries it (D521) | 12 B | **owner 2026-11-05/06** (G1 stage 1 drawn whole with the overlay, a kit leaving a stage out draws intact, C4 wall tops cut) |
| 26 → 27 | 46c.16j | wall and roof apart (D519): the roof mesher's polygons and the faces of bodies next to a plane cell carry an owner offset (position w high byte, normal w) naming the one cell they show, unmerged across cells; the closing geometry names the wall; the shader reads that cell alone. A roof closes onto the walls only where its kit's `wallTopFill` (piece table 5) asks; else stepped wall tops | 12 B, add-only bits | **owner 2026-11-06** (acc46c-r2 D519/O2: no blend across the seam, the free normal.w byte; follow-up: wall-top fill a roof-kit setting, default off) |
| 27 → 28 | 46c.16k | roof polygons merge across cells again (D525: rows along the level line, supported floors, side pieces; by geometry and crack, never material), a merged polygon's owner offsets 0 along its row; a body's face owned only where its read reaches a plane cell | layout unchanged | **owner 2026-11-06** (performance first; D519 kept: wall and roof never blend) |
| 28 → 29 | 46d.5a | the relief part a derived output: a level-0 section in the relief ring carries its ground and base subdivided n steps a cell with a crease byte a vertex, edges toward plain sections whole; outside the canonical bytes ([render spec §3](voxel-render-spec.md#3-relief-part)) | canonical bytes v28's | default (46d.1b verdict) |
| 29 → 30 | 46d.6c | a body's faces next to a plane cell merge with its other faces by geometry and crack alone (D526): the rectangle holding an owned face is owned whole (each pixel its own body cell, unblended), owned rectangles of a direction share vertices | layout unchanged | default chosen, owner to confirm (D519 kept: no wall face reads a plane cell) |
| 30 → 31 | 46d.7a | the downsample at every level ≥ 1 closes an opening narrower than two parent cells in the body round it, and a parent of opening cells only is an opening (no door/window "legs" at level 1); a new derived store, the far cache (format 1, never committed; [render spec §4](voxel-render-spec.md#4-far-field-data)) | layout unchanged; level-0 results v30's | default chosen, owner to confirm |

The owner notes of 3 → 9, as each step recorded them:

**Derived data 3 → 4 (46b.3b, owner note: default chosen, owner to confirm).** The layout is unchanged (12-byte
vertices, u16/u32 indices); the meaning of the ground's vertex positions changed (the terrain mesher's placement,
§3.7, instead of the mean of the crossings), so the version steps and a v3 result is never taken for a v4 one.
Derived data is never stored, so there is nothing to upgrade: everything is derived again. The streamed worlds
(slice page, Play, the Scene view) derive with `WORLD_RULES` = the terrain rules (`terrain` v1, R 2). No stored
format changed.

**Derived data 4 → 5 (46b.4, owner note: default chosen, owner to confirm).** The layout is unchanged; the meaning of
the ground's normals changed (lattice vertices' wider slope, split crease vertices: a position may appear in more
than one vertex, each with its face's normal), so the version steps. Nothing is stored, nothing to upgrade, no world
regenerated.

**Derived data 5 → 6 (46b.5, owner note: default chosen, owner to confirm).** The layout is unchanged; the meaning of
the ground's crease vertices changed: a straight step's edge (a terrace lip, a cliff's top, a step's foot) is
placed on the column lattice at the column's top, where the QEF of the interpolated density put it up to a third of
a cell low and in front of the face (D461); and the base surface's coplanar faces are merged inside a section (a
triangle may span many faces; a whole-chunk derive and its joined sections cover the same faces in different
triangles). Nothing is stored, nothing to upgrade, no world regenerated.

**Derived data 6 → 7 (46b.6a, owner note: default chosen, owner to confirm).** A result records its chunk-tree
level (0: a chunk; L: a mip node, every position and size in the node's cells), and the canonical bytes carry it,
so a node is never taken for a chunk with the same cells. The mip downsample's meaning changed:
- the shape is the share of solid (open roles add nothing);
- the role goes by priority, with whole-cell bodies needing half the node cell;
- the material is dominant among the cells that count.
Before, the shape counted liquid and openings, and the role came from the dominant material's first cell. Mips
are never stored, so there is nothing to upgrade and no world is regenerated.

**Derived data 7 → 8 (46b.8c, owner note: default chosen, owner to confirm).** The layout is unchanged; a mip
node's material changed meaning: the material its surface shows (the cells nearest the surface), not the dominant
one, which let earth under a one-cell grass skin win at levels 1 and 2 (D464). The surface shader reads a fixed
0.125 m into the surface at every level instead of a quarter of the level's cell. Nothing is stored, nothing to
upgrade, no world regenerated.

**Derived data 8 → 9 (46b.9, owner note: default chosen, owner to confirm).** The layout is unchanged; two meanings
changed. A level-1 node's detail instances carry the `low` flag and coarser nodes list none, their beam and rail
cells drawn by the base surface. A mip node's bodies hold a node cell by their cells (half of the 8, or two in a
sheet), not by their fill: before, a one-cell house shell lost its stepped roof at level 1 and its walls at level 2
(D465). Nothing is stored, nothing to upgrade, no world regenerated.

**Chunk-tree flags (R82, `ChunkTreeFlags`).** Every tree node has a solid / empty / mixed flag (`OCCUPANCY`), so
culling, rays and the far field skip whole empty or solid subtrees without reading voxels.
- Level 0 is a chunk: its derived occupancy flag. A chunk never given one (absent: air) is empty.
- A node above is empty when all 8 children are, solid when all 8 are, and mixed otherwise.
- A chunk whose flag changes marks its ancestors stale (the same `MipStaleSet`); a read refreshes stale nodes first,
  lowest level first, so a flag read is never stale. `refresh()` names the nodes whose flag changed.
- Tested against every node recomputed from fresh derives, before and after an edit that digs a cave into a solid
  node and fills it again (only the edit's dependent chunks derived again).

**Prop lighting channel (R93–R96).**
- Per chunk: one coverage byte a cell, or null when no prop covers the chunk.
- Rebuilt from the prop list when a chunk loads or a prop is placed or moved: 4³ sample points per host cell, tested
  inside the prop's frame (inverse yaw and scale).
- Overlaps combine as `255 − round((255 − a)(255 − b) / 255)`, and this channel joins the construction's light
  coverage the same way.
- It is never part of the world voxels and never written to a file.

**Measured (45.6, Node).**
- Derive time: 0.5–3.4 ms a chunk (median); the evaluation is about 0.2 ms of that.
- Derived bytes: 11–69 KB a chunk (mean).
- Light: 0.5–4.3 KB a chunk, against 3.5–19 KB dense.
- Town collision: 183 B a chunk; 19 wall cells a box.
- The estimated ring at 192 m on hilly ground is about 38 MB of derived data. That figure is extrapolated from the
  window, not measured in the streamer.

### 3.8 Versions and upgrades (R3)

| Format | Magic / field | Version | An unknown version | Upgrade path |
|---|---|---|---|---|
| Chunk codec | `VC` | 2 | a newer one refused | `CHUNK_CODEC_UPGRADES`, add-only, keyed by the version lifted from (v2 has none) |
| Region file | `TLVR` | 2 (+ codec version byte) | a newer one refused | `REGION_UPGRADES` (header and table; chunks by the codec's steps), add-only (v2 has none) |
| World manifest | `world.json` `format` | 2 | a newer one refused | step 1 → 2 lists the region files found (§3.2) |
| Edit command | `v` | 2 | refused | none yet |
| Undo record | `TLVU` | 2 | refused | not needed (session data) |
| Save | `TLVS` | 2 | a newer one refused | `SAVE_UPGRADES`, append-only (v2 has none) |
| Structure overrides | `TLVO` | 2 | a newer one refused | `OVERRIDE_UPGRADES`, append-only (v2 has none) |
| Record value form | byte in `TLVR`, `TLVU`, `TLVS`, `TLVO` | 2 | any other refused | new fields take reserved bits (§2.2) |
| Job message | `v` | 1 | refused | not needed (same build both ends) |
| Derived data | `DERIVED_FORMAT_VERSION` + rules ref | 31 | refused | rebuilt, never upgraded |
| Far cache ([render spec §4](voxel-render-spec.md#4-far-field-data)) | `far.json` `format` | 2 (reads 1 and 2) | built again | add-only step 1 → 2: format 2 adds the nodes' baked bricks (`bricks`, `B<level>/`); a format-1 cache reads as one without them (a page builds its bricks), the backend builds it again; rebuilt when its world's revision or its bricks' build differs |
| Kit piece table | `PIECE_TABLE_FORMAT` (u16, first in its bytes) | 5 | refused | rebuilt from the kits, never stored |
| Voxel kit record ([kit page](voxel-kit-format.md) §3.9, final) | `kitFormat` | 1 | any other refused whole | add-only fields (v1 has none to lift) |

**Derived data 3 → 9 (46b), 9 → 28 (46c and its revision) and 28 → 31 (46d):** the steps and their owner notes are in §3.7, *Derived version history* (one table); 46d's owner notes are on the [render spec](voxel-render-spec.md). Kits, edges, roofs and damage changed no stored format.

**Far cache 1 → 2 (46d.18, add-only):** format 2 = format 1 + the nodes' baked bricks (`far.json` `bricks`, folders
`B<level>/`); a format-1 manifest reads as format 2 without them, nothing is rewritten. The owner note (vista step 2
and the edit design, 2026-11-10, quoted) and the layout are in the [render spec](voxel-render-spec.md) §4, *Baked
bricks*. Default chosen, owner to confirm (plan 46d §9).

**Value v2 (owner 2026-11-02) moved these versions:** chunk codec 1 → 2, region file 1 → 2, edit command 1 → 2,
undo record 1 → 2, save 1 → 2, overrides 1 → 2, record value form 1 → 2, derived data 1 → 2, placeholder rules
1 → 2. Every v1 was an unapproved draft with nothing shipped in it; v1 bytes are refused, with no upgrade step (§7,
45.10a).

### 3.9 Voxel kit record, format 1 — moved

Moved unchanged to [kit page](voxel-kit-format.md) §3.9 (46d.2, D496).

---

## 4. Requirement traceability

Every R-id from [voxel-format-requirements.md](voxel-format-requirements.md), mapped to where this spec serves it.

**Evidence** names the plan's results subsection and the tests:
- `tools/voxel-bench/`: `harness`, `worlds`, `region`, `edits`, `stream`, `derived` (`.test.ts`);
- `packages/voxel/src/`: `stream-core`, `palette-store`, `brick-layout`, `coords`, `dense-store` (`.test.ts`).

**Status:**
- *served*: built and measured as a DRAFT;
- *partly*: built in part;
- *replaced*: an owner choice;
- *superseded*: by §7a;
- *later*: not yet served, with the sub-phase that serves it.

| R-id | Spec | Evidence | Status |
|---|---|---|---|
| R1 | §1 replacements, §5, §7 | decision log, "for the owner" entries (45.2a, 45.2b, 45.3, 45.5b, 45.6); owner 2026-11-02 | served; replacements accepted by the owner |
| R2 | status line | owner review 2026-11-02 (45.10a) | revised as the owner asked; approval of the revised draft pending |
| R3 | §3.1, §3.2, §3.8 | `format-rules.test.ts` (codec and region steps, newer refused), `region.test.ts`, `edits.test.ts` (save upgrade step) | served (45.7d: codec, region and manifest steps) |
| R4 | §3.2 damage and manifest, §3.4 | 45.3, 45.4, 45.7d; `region.test.ts`, `edits.test.ts` (repair, carry-over), `voxel-world.test.ts` (a listed region gone is damaged) | served |
| R5 | §3.1 header, §3.2 world id / grid id, §3.5 save world | 45.2a, 45.3, 45.7d; `format-rules.test.ts`, `edits.test.ts` | served (45.7d: every reader checks the tile it expects) |
| R6 | §3.3 one apply | 45.4; `edits.test.ts` | served at format level; command op wiring in 46a/47c |
| R7 | §3.4, §3.6 budgets, §2.2 material width | 45.4, 45.5a, 45.7d | served (material ids 23 bits, a format width; owner to confirm) |
| R8 | — (the format has no generator) | test worlds are bench-only | served |
| R9 | §2.1 | `coords.test.ts` | served |
| R10 | all | — | later: 48 retires the old systems |
| R11 | §2.2 | 45.1, 45.2a (plane costs), 45.10a (value v2 before → after) | served: the value v2 (owner 2026-11-02) |
| R12, R13 | §3.7 (classes are derived, not stored) | 45.6; `derived.test.ts` | superseded (§7a) |
| R14 | §2.2 role + shape; §3.7 terrain rule set | 46b.2 (terrain features from role and shape; `derived.test.ts`) | partly: terrain slope cases built in 46b; roof and stair cases in 46c (the stored role tells roof, stair and terrain apart; no orientation) |
| R15–R17 | §3.1 | 45.2a, 45.2b; `palette-store.test.ts`, `brick-layout.test.ts` | served |
| R18 | §1 replacement 1 | 45.2a, 45.2b | replaced (owner accepted 2026-11-02) |
| R19 | §2.2, §3.1 | 45.2a | served |
| R20 | §3.1 planes, zstd 3 | 45.2a, 45.2b codecs | served (record palette, planes at rest) |
| R21 | §3.1 `voxelAt` | 45.1, 45.2a; `harness.test.ts` (dense oracle) | served |
| R22 | §2.1 (32³) | 45.2b | served |
| R23 | — | — | superseded by R15–R20 |
| R24, R25 | §2.2 liquid role + fill level | 45.1 worlds (lakes, ponds, cave water) | served |
| R26 | §2.2 reserved bits | — | later: shoreline O15 in 49 (first candidate for the reserved bits) |
| R27, R28 | §2.2 material (12 bits) | 45.10a | partly: id width set by the owner (4,096 a world); the material model is 46d's |
| R29 | §3.3 stamp | 45.4; `edits.test.ts` | served (voxelizing at import is 47b) |
| R30–R32 | §2.1 grid ids | — | later: 47a structure records |
| R33, R34 | §3.5 TLVO, fit rule | 45.4; `edits.test.ts` | served; the regenerate-all step is 47a |
| R35 | §3.5 (overrides not in region files) | 45.4 | served |
| R36–R39 | §2.1, §3.2 grid id, own folder | 45.3; `region.test.ts` | partly: streaming per grid untested (46a); transform 47a |
| R40 | §3.7 per grid | — | later: 46a/46e |
| R41, R42 | — | — | later: 49 (sea level is world metadata) |
| R43 | §3.3 commands | — | later: 47a |
| R44 | §3.7 prop channel only | 45.6 | served |
| R45 | — | — | later: openings in 46c/47a, portals in 46e |
| R46–R48 | §3.2 | 45.3 | served |
| R49 | §2.1 bounds | 45.1 vertical world, 45.3 | served |
| R50 | §1 replacement 2 | 45.3 | replaced (owner accepted 2026-11-02) |
| R51 | §3.1, §3.2 canonical bytes, §3.3 cell lists | 45.3, 45.7d; `region.test.ts` (equal bytes by edit order), `format-rules.test.ts` (crafted bytes refused) | served (caveat: zstd build, §3.2) |
| R52 | §3.2 ranges | 45.3; `region.test.ts` (HTTP range) | served |
| R53 | §1 git | 45.3 repo growth | served (no LFS) |
| R54 | §3.7 | 45.6 | served |
| R55 | §1 sizes | 45.3 projection | served (projection; no 10 km world built) |
| R56, R57 | §3.3, §3.4 | 45.4 | served; room op 47a, copy/paste 47c |
| R58 | §3.3, §3.6, §3.7 | 45.4–45.6; slice 45.7a (§6) | partly: physics, nav graph and light in 46a/46e |
| R59, R60 | §3.5 TLVS | 45.4; `edits.test.ts`, `stream.test.ts` (apply on load, mismatch) | served |
| R61 | — | — | later: 49 (O18) |
| R62, R63 | §2.1, §3.6 floating origin | 45.5a; `stream-core.test.ts` (precision) | served |
| R64 | §3.6 budget | 45.5a, 45.5b | served for voxels + derived; colliders, light, textures in 46 |
| R65 | — | — | later: 47c |
| R66 | §3.6 export delivery | 45.5b | partly: wider reads + prefetch accepted by the owner, D432 tuning and the browser cache in 46a |
| R67–R69 | §3.6 | 45.5a, 45.5b; `stream-core.test.ts`, `stream.test.ts` | served |
| R70 | package rule | 45.1b; `stream.test.ts` (worker bundle passes the export scan) | served (default, owner to confirm) |
| R71 | — | — | later: deferred scatter |
| R72 | §3.7 | 45.6 (worker = main thread, deterministic) | served |
| R73, R74 | §3.7 terrain mesher, base surface, roof mesher, [kit page](voxel-kit-format.md) *Kits: edges, roofs and damage* | 45.6, 46b.3b–46b.5, 46c R1–R6b | served (catalogue `edges-draft` v3, 17 slots, role spec v1): every flat face from the voxels, roofs as planes, pieces only on edges, corners, roof edges and the faces round damage holes; D482 open |
| R75–R77 | [kit page](voxel-kit-format.md) rule set `edges` v3; §3.7 consumer tables (forms) | 45.6, 46c.5, 46c R1–R3; `derived.test.ts`, `case-forms.test.ts`, `collision.test.ts`, `kit-house.test.ts`; slice proof 45.7 (§6) | served: one evaluation (classes, cases, edges, roof words, forms); consumers from forms and voxels, roofs collide as ramps; D497, D502 (pass costs) open |
| R78, R80 | — | — | superseded by R77 |
| R79 | §1 replacement 3 | 45.6 | replaced (owner accepted 2026-11-02) |
| R81 | §3.7 render solid (density ≥ 128) | 45.6 | served |
| R82 | §3.7 occupancy, chunk-tree flags | 45.6, 45.7d; `derived.test.ts` | served (chunk, brick and tree-node flags) |
| R83 | §3.7 dependency | 45.6 | superseded by Q-c |
| R84, R85 | §3.7 mips | 45.6; `derived.test.ts` | served (no paint layer, O16 closed) |
| R86 | [kit page](voxel-kit-format.md) edge pieces | 45.6, 46c.4, 46c R3, 46c.16b | served: edges one instance a lattice edge, no merged runs; beams/banisters moved out of the voxel phases by the owner (2026-11-05/06), run sections removed; D485 (draws) open |
| R87 | [kit page](voxel-kit-format.md) §3.9 `trimLayout` / `sheetLayout` (optional), slot rotation, kit check T1–T7, T9, T10 | 46c.8, 46c R3b, R5, R7, 46c.16b, 46c.16k | served: trim optional per kit, U along an edge's world axis (the mesh axis its slot rotation turns onto it); texture layout v1 (owner 2026-11-06); D507 fixed |
| R88, R89, R111 | [render spec](voxel-render-spec.md) §3 relief part, §2 wetness, §5 trace | 46d.1a–46d.6d | served in 46d (relief ring, plain collision; wetness R111); per-tier relief verdict awaits the owner |
| R90 | §3.7 levels (pieces at L0 only); [kit page](voxel-kit-format.md) levels (`relayRoofs`) | 46b.9, 46c.6, 46c R6b, 46c.16a; `kit-pieces.test.ts`, `roof-mesher.test.ts` | served as revised (owner 2026-11-05: two detail states): pieces at L0, flat voxels from L1, no low meshes; coarse roofs re-laid; D479 open |
| R91 | §3.7 surface vertex v2, shader data on the GPU | 45.6, 45.10b; `voxel-surface.test.ts`, `voxel-world.e2e.ts` | replaced (owner 2026-11-02): vertices carry no material; the shader blends from the shader data |
| R92 | §3.7 shader data, surface shader | 45.10a, 45.10b; `derived.test.ts`, `stream.test.ts` | served: blending in the shader, triplanar in world space for terrain, construction from the build grid in metres (4 m repeat, 46c R4); no paint layer (O16 closed) |
| R93–R96 | §3.7 prop channel | 45.6; `derived.test.ts` | served |
| R97–R99 | — | — | later: 46e |
| R100 | §3.7 nav | 45.6 | partly: the walk graph is 46e |
| R101, R102 | §2.2 role | — | later: 46e/47b/47c (roles stored, owner 2026-11-02) |
| R103 | §3.7 light coverage | — | later: 46e / camera |
| R104 | — | — | later: 46e (O19) |
| R105 | §3.7 collision | 45.6 | partly: Rapier churn in 46a |
| R106 | — | — | later: 48a |
| R107 | §3.6 sections, atomic swap; §3.7 seams (an edit's swap waits for its seams) | 45.10c, 46a.12, 46b.7b; `stream.test.ts`, `voxel-world.e2e.ts`, plan **45.10c** (blast benchmark) | partly: local 1–4 m blasts the next frame, 8 m 2–3 frames (46a.12); the mesher misses its 0.1–0.2 ms budget (207–307 µs a 16³ section with the rules; the edge passes 204 / 345 µs and the roof mesher 193 / 418 µs p50 / p95 in 46c R6, D497, D502); a damage (integrity) edit re-derives the sections within R in one swap; an edit in the level-1 ring swaps whole with its drawn nodes, 1–4 frames locally (1–4 m), 2–5 at 8 m (46b.11c) (requirements §5) |
| R108 | §3.7 terrain rule set, terrain mesher | 46b.1–46b.5, 46b.10; `mesh-cases.test.ts` (the `features` hard-case world, goldens), `derived.test.ts` (conformance), `collision.test.ts` | served: rules with radius 2 and conformance, the hard cases closed with every probe kept; D463 (tall far terrain) open |
| R109 | §3.7 terrain, levels, seams and LOD selection | 46b.6a–46b.9; `mesh-cases.test.ts`, `derived.test.ts`, `stream.test.ts`, `lod-select.test.ts`, `level-materials.test.ts`, `voxel-chunk-view.test.ts`, `voxel-world.e2e.ts` | served with limits: rings, seams, one blend, pieces at level 0 only (46c.16a); D462 (a cave saddle) and D463 (level 2 not drawn, tall far terrain) open |
| R110 | — | — | later: 46e |
| R112 | §3.7 projection (4 m grid tile), [kit page](voxel-kit-format.md) §3.9 `trimLayout`, [render spec](voxel-render-spec.md) §2 | 46c R4, R7, 46d.4a | served: faces and roofs grid-mapped (construction 4 m, terrain 2 m) from wall / floor / ceiling texture arrays, trim only for pieces that opt in; texture layout v1 |

**Not served yet, and where each goes:**
- **46a:** R10 (with 48), R30–R32, R40, R43, R45 and R65, together with 47a/47c.
- **46a / 46d:** R66 browser cache, R105 Rapier churn.
- **46b / 46c:** R14 (R73, R74, R86, R87, R90 served in 46c with the v1 edge catalogue; R88, R89 served in 46d).
- **46d:** R27 and R28 served (material record, 46d.3a; [render spec](voxel-render-spec.md) §1, §5).
- **46e:** R97–R101, R103, R104 and R110.
- **46b.11 / performance phase:** R107's remaining frames and the mesher budget; D462, D463 for R108/R109.
- **48a:** R106.
- **49:** R26, R41, R42 and R61.

---

## 5. Defaults chosen, owner to confirm

There are 44 such entries in the plan's decision log (§7). One line each, grouped by area. **Owner 2026-11-02:
every remaining default below is accepted** (the world layout and scale, the editing rules including
`world_changed` refuse-after-reload, and the rest); entries 6, 8, 38, 39 and 44 are replaced by the value v2
(§2.2), entry 3's decoder stands. M7, D433 and D434 stay later work.

**Process and tooling**
1. Staging backend: `tools/staging.sh`, a transient unit on 127.0.0.1:4180/4181, its own data root, a 6 GB cap (45.0).
2. Voxel code lives in `packages/voxel` (`@thirdlight/voxel`), pure; Node tooling sits in `tools/voxel-bench/` (45.1b).
3. fzstd 0.1.1 is pinned and is the proposed worker decoder (it ships in the editor bundle; 45.2b). lz4js was measured and dropped (45.8b).
4. The browser streaming page reads from the bench's own range server, not staging (45.5b).

**Coordinates and record**
5. Integer cells: x, z ±32,768 and y ±8,192; chunk key below 2^35, y fastest inside a chunk (45.1b).
6. ~~`VoxelRecord` fields and widths, category set, orientation~~ → owner 2026-11-02: the value v2 (material 12, role 4, shape 4, wetness 3, 9 reserved; no orientation; §2.2).
7. Vertical bounds are the coordinate bounds; the format stores no world base or height; stacks are aligned at y = 0 (45.3).

**Chunk store and codec**
8. ~~Only surface voxels store a density byte~~ → owner 2026-11-02: the shape (16 fill levels) is inside every value (§2.2).
9. Palette ids at 0/1/2/4/8/16 bits; a uniform chunk is one number in the index; palettes narrow with hysteresis (45.2a).
10. The 45.2 pick: record palette, 4³ bricks in memory, packed body + zstd 3 at rest (zstd 19 for exports), 32³ (45.2b).

**Region files and git**
11. Region file v1 layout: 64-byte header, sorted 12-byte entries, uniform chunks inline, canonical bytes (45.3).
12. 256 m tiles stay (512 m: 4× rewrite per save) (45.3).
13. Structure grids use the same container: own folder per grid id; the transform is not in voxel files (45.3).
14. No Git LFS; run `git gc` after saves/commits (45.3).

**Edits, undo and saves**
15. Stroke command v1: one command per stroke, plain JSON, one deterministic apply (45.4).
16. Undo is the before-state per changed chunk; a 64 MiB memory budget spills to disk; redo re-applies (45.4).
17. Save v1: changed chunks only, 16-byte base hash, one zstd stream, append-only upgrades, the game picks on a mismatch (45.4); every entry keeps the player's changed cells (45.8a, item 42).
18. Structure overrides: a per-cell delta stored with the structure record; absorbed / kept / misfit (45.4).
19. The caller orders repair sources; an unrepaired chunk stays unloaded and is carried over verbatim (45.4).
20. Dirty tracking: per-chunk versions, snapshot commits, one save job per file, late commits refused (45.4).

**Streaming**
21. Job contract v1: four kinds, lanes edit > near > far, input-stamp staleness, R per job, chunks moved as memory arrays (45.5a).
22. One streaming budget per tier (256 / 512 / 1024 MiB); the default ring is 192 m and ±96 m (45.5a).
23. Eviction farthest first among clean chunks down to 95 %, resuming below 85 %; dirty chunks are never evicted (45.5a).
24. Floating origin re-bases past 1,000 m per axis, snapped to the grid's chunk edge (16 m at 32³), with synchronous listeners (45.5a, 45.7d).
25. Workers keep no world state; pool size, queue bound and timeouts are settings (45.5a).
26. Pool size `min(4, hardwareConcurrency − 2)`, at least 1 (45.5b).

**Derived data**
27. Derived data v1: one versioned assembly evaluation, consumer tables, pluggable rule sets (45.6).
28. Apron depth = the rules' radius + 1; results record their rules; one rule set per streamer (45.6).
29. Light coverage as bits + a partial list (bricks if 46e's tracer needs O(1) access); placeholder coverages (45.6).
30. Collision input as boxes in 1/16 cell + the ground trimesh; nav input as blocking bits + standable cells (45.6).
31. ~~Mesh buffers: 20-byte vertices with material slots~~ → owner 2026-11-02 (45.10b): 12-byte vertices (position, normal), no material; u16/u32 indices, two surfaces, 8-byte instances with `replacesBase` and a reserved u16.
32. Voxel mips: a node has the chunk's form; fill the share of solid, role by priority (bodies by cells: half the parent or two sheet cells, 46b.9), the surface's material (46b.8c); stale ancestors rebuilt lowest first (45.6); a node derives through the chunk derive and records its level (46b.6a); pieces at level 0 only, none coarser (46b.9, two detail states 46c.16a).
33. Prop lighting channel: a coverage byte a cell, rebuilt from the prop list, never saved (45.6).

**Format gaps closed (45.7d)**
34. Readers name the tile they expect; another world, grid, layout, edge, footprint or region is refused (45.7d).
35. Codec and region upgrade steps: add-only registries keyed by the version lifted from; region steps lift the
    index only (45.7d).
36. World data has one encoding; the measurement encodings are read only by the bench entry (45.7d).
37. Set/dig cell lists in x, z, y order, each cell once (45.7d).
38. ~~Material ids 23 bits~~ → owner 2026-11-02: 12 bits, 4,096 a world, u16 at rest (§2.2).
39. ~~Orientation, one of 24 rotations~~ → owner 2026-11-02: not stored (§2.2).
40. The world manifest lists its region files; a listed one that cannot be read is damaged, an unlisted one air
    (45.7d).
41. Chunk-tree flags from the chunks' derived occupancy; undo answers carry their edit's box (45.7d).

**Review fixes (45.8a)**
42. Every save entry records the player's changed cells (a delta, or a whole-chunk form plus a changed-cell mask,
    the smaller); `save` on a changed base writes only those cells (45.8a).
43. The base hash covers the base form, frozen as the chunk codec v1 canonical bytes of the content, whatever codec
    version stores it (45.8a).
44. Raw values carry a record value form in region, undo, save and override bytes (45.8a); owner 2026-11-02: form
    2 is the value v2, O16 needs no bits (no paint layer), O15 is the first candidate for the reserved bits.

**Sections and swaps (45.10c, after the owner's review; owner to confirm)**
45. Derive sections of 16³ in the slice page (the streamer's default stays the chunk edge until 46a sets it); 8³ rejected.
46. A section job carries its chunk's payload and apron; an edit's sections split over the workers only while it
    touches fewer chunks than workers; an edit's jobs go out at once within 8 ms of main thread.
47. One group per edit or refresh; held results swap in one task; an edit meeting an open group merges into it; a
    section that cannot be derived now leaves the group.

---

## 6. Slice and assembly proof (45.7a/b, 45.9)

What the formats did end to end on the staging backend (the branch's `dist/`, own port and data root, engine-owned
test worlds), in headless Chrome on the Iris Xe (the low tier) at 1280×720 and the display's 60 Hz cap, on WebGPU and
on WebGL 2. Sources: plan **45.7a thin slice**, **45.7b collision and assembly proof**, **45.9 acceptance**; the
acceptance pictures and reports are in `~/.cache/thirdlight-phase45/acceptance/` (README for the owner). Everything
below is measured or seen in screenshots that were looked at; what was not is listed under limits.

**The slice.** The test world is the hilly generator's 512 m square with a wall, a beam one cell out behind it and a
banister (rail on posts) on a levelled pad, written as 8 stacked region files (1.5 MB, 6,900 stored chunks). The page
`/voxel-world.html` reads the world's manifest, then chunk bytes by HTTP range from the region route; 4 module
workers decode (fzstd) and derive (placeholder rules, R 2, apron 3); the main thread meshes, draws through the
engine's renderer factory and builds one static Rapier body per derived chunk. Edits are stroke commands
(`editVoxels`, `undoVoxels`) on the command route; the page never applies an edit itself, it re-reads the chunks the
answer names and re-derives the chunks within R + 1 of the answer's cell box.

| Measured (45.9, 3 rounds a renderer; 45.7a/b agree) | WebGPU | WebGL 2 |
|---|---|---|
| 30 s orbit, frame p50 / p95 / max, missed | 16.7 / 16.7 / 16.8 ms, 0 of 1,799 ×3 | 16.7 / 16.7–16.8 / 16.8 ms, 0 of 1,799 ×3 |
| 160 m flight out and back (12 m/s, 27 s) | 16.7 / 16.7–16.8 / 16.8 ms, 0 of 1,619–1,620 ×3 | 16.7 / 16.7–16.8 / 16.8 ms, 0 of 1,619 ×3 |
| render() CPU p50 / p95 | 1.2 / 1.5 ms | 1.0 / 1.4 ms |
| Cold fill (ring read, decoded, derived, meshed, collided) | 2.35–2.48 s | 2.38–2.46 s |
| Edit → answer / → collider replaced / → visible, p50 (max), 18 edits | 13 (25) / 40 (54) / 65 (73) ms | 11 (21) / 39 (49) / 64 (71) ms |
| Derive job per chunk p50 / p95 | 0.8 / 4.7–4.9 ms | 0.8 / 4.7–5.0 ms |
| Streaming memory (low tier budget 256 MiB) | 67 MB cold, 84 MB after flight and edits | same |
| JS heap | 133 MB cold, 166–186 MB at the end | 125 MB cold, 168–191 MB at the end |
| Rapier WASM heap (outside the budget, D434) | 126 MB cold, 172 MB after one flight | same |

- The answer is mostly the save: apply 0.2–0.4 ms p50, region file rewrite with the manifest 8.7–9.3 ms p50.
  Collision: 448 bodies (791 colliders, 16.6 MB of geometry, counted in the budget) cold; body add p50 2.0–2.2,
  p95 3.5–4.0 ms; the flight added 372 and removed 282 bodies. Physics results equal on both renderers (0.01 cell).
- **Save and reload:** a fresh page, and a fresh page after a staging stop/start, read revision 20 from the files;
  the voxels under every edit and the derived hashes of the 27 chunks around the scene equal what the edited page had.
- **Files changed behind the backend** (the world folder replaced by an older copy while a page is open): the next
  command is refused `world_changed`; the page reads every resident chunk again and says so in its status line, and
  the edit sent again applies on the checked-out world (both renderers; before the fix the page kept the old world
  and then showed a mix: D438, fixed).

**Wall to beam/banister as neighbouring voxels change** (runtime `set`/`dig` commands, no structure data):
- *Stored intent survives the codec and save round trips:* after the banister is grown, a fresh page from the files
  derives the 5×5×5-chunk window to the same hashes and reads the cells as timber/construction (e2e).
- *Outputs express the cases, per consumer* (`cellOutputs` of the derived chunk): a rail cell is piece rail,
  partial collision box, light 51, nav blocking and not standable on top, 0 base faces; after `set` of the 12 cells in
  the gaps and over the rail (across the x chunk face) it is no piece, full box, light 255, standable on top, 2 base
  faces, and a swept ball stops at its face (z 8.30) instead of passing between the posts to the wall (1.30). `dig` of
  the two wall cells behind the beam (wall chunk, both sides of x 0) turns the beam cells in front (the next chunk in
  z, with no edited cell) into wall stubs (full box, 255); `set` of the stone gives the beam back.
- *Invalidation across chunk faces:* every command re-derived exactly the chunks within R + 1 of its cell box (2 for
  the banister, 4 for the beam cut, 1 for a pit; an undo the same chunks as its edit); after every stage 0 of 125
  derived chunks differed from a fresh derive. Proven in the slice for mesh, collision, nav and light; voxel mips and
  chunk-tree flags in vitest only (`derived.test.ts`), since the page builds neither.
- *Equivalent runtime input gives the same result:* digging the generator's banister and setting the same cells again
  gives every derived hash of the generator's world and byte-identical region files (SHA-256 tags); the same
  arrangement reached by other commands in another order gives the same files and results (45.8b, vitest).
- *Collision follows the edits:* capsules rest on the ground (0.02 cells), wall top (8.02), beam and rail (3.02); a
  capsule dropped over a pit dug after the bodies were built falls in (−2.67), and rests at 0.02 after the undo.

**Limits observed** (placeholder rules and meshes; 46c's catalogue and 46b's mesher replace them):
- Thin stone columns left between dig holes resolve as posts and draw as timber post pieces; a beam that loses its
  wall becomes a floating wall stub (no orphan case); a cut banister end resolves as a timber block; banister and
  fence corners resolve as wall.
- Base surfaces are a quad per exposed cube face; beam, rail and post pieces are stand-in boxes; the ground is the
  reference surface nets, unmerged (0.90 M triangles for the ring cold, 1.13 M after a flight). No materials,
  textures or lighting work.
- Collision bodies cover every derived chunk in the ring (no collision ring); ground is always a trimesh; dropped
  bodies are capsule characters and swept spheres, not free rigid bodies. Rapier's heap is outside the budget and
  never shrinks (D434).
- The proof runs on the world grid only (no rotated structure grid; cross-grid dependencies are the open gap in
  §3.6). Measured on the Iris Xe only (high tier unmeasured), on localhost only (network latency: D432). Voxel
  commands are not on MCP (D433); other open pages do not see an edit (no live feed); undo is per open world, outside
  the project's history.

---

## 7. Gaps found between the code and the plan text

The 45.7 spec item found these gaps; 45.7d closed all ten in code, with tests, and this spec now describes the
code as it runs. Each entry says what changed.

- **G1 — vertex stride. Closed in 45.7d (documented).** A surface vertex is 20 bytes with u8 material slots and 24
  when the chunk's material table has more than 256 slots (`surfaceStride`, §3.7); §5 default 31 said so (45.10b: 12 bytes, no slots). No
  code change.
- **G2 — world id never checked. Closed in 45.7d.** Every reader names the tile it expects: `RegionIndex.parse`,
  `openRegion` and `damagedRegionChunks` take `{expect}` (world id, grid id, layout, chunk edge, footprint, region
  index) and refuse another with a `RegionFileError` naming the field; `RegionChunkSource` takes the world and grid
  id and checks every file it opens (its chunks are then reported damaged, never read); the backend's world checks
  each listed file against its manifest and file name; `readSave` and `applySave` take the world id and refuse
  another world's save before writing anything (§3.2, §3.5). Tests: `format-rules.test.ts`, `edits.test.ts`.
- **G3 — no upgrade path outside saves. Closed in 45.7d.** `CHUNK_CODEC_UPGRADES` and `REGION_UPGRADES` are
  add-only registries keyed by the version a step lifts from (both empty and frozen at v1); every world reader lifts
  older chunk bytes (`liftChunkBytes`) and older region indexes (`liftRegionIndex`, reading chunks by range from the
  file as it is) and refuses a newer version or one without a step; region and save headers accept chunk codec
  versions 1 to this build's. Proved with test-only "version 0" formats and their steps (§3.1, §3.2, §3.8).
- **G4 — canonical form only partly enforced on read. Closed in 45.7d.** The world decoder refuses a packed body
  of one entry without densities (a uniform body) and air with any other field or a density flag, so every byte
  string it accepts is the one its content encodes to (crafted bytes tested, §3.1).
- **G5 — measurement-only options inside codec v1. Closed in 45.7d.** World readers accept only uniform and packed
  record-palette bodies with all planes; column runs, bricks at rest, per-field palettes and dropped planes moved to
  the bench entry (`palette-codec-measure.ts`), which still reads and writes them for re-measurement. World bytes did
  not change (the bench entry writes them byte for byte, tested), so no measured number moved.
- **G6 — `set`/`dig` cell lists not canonical. Closed in 45.7d.** `canonicalEditCommand` sorts them by x, z, y and
  keeps each cell once (§3.3).
- **G7 — material, orientation and category values. Closed in 45.7d (defaults chosen, owner to confirm); superseded by the value v2 (owner 2026-11-02, §2.2).**
  - *Material id space (O12, R27).* The record keeps one 32-bit value: material 23 bits, category 4, orientation
    5 (§2.2), so a world names up to 8,388,607 materials, a format width rather than a small count, at no cost per
    cell or in memory. At rest the material plane is u24: +1 byte a palette entry. A full 32-bit material field was
    measured too: the 48-bit record value it needs makes a cell delta 9 bytes instead of 7 and an apron or
    assembly-block cell 8 bytes instead of 4. Numbers in the plan (**45.7d format gaps**).
  - *Orientation.* One of the 24 axis-aligned rotations (0–23, 0 the identity, `orientationMatrix`), others
    refused; PROVISIONAL until 46c's role and case catalogue.
  - *Category.* Values 5 and up are refused by every writer and reader.
- **G8 — a missing region file read as sky. Closed in 45.7d.** The world manifest (format 2) lists its region
  files: an unlisted region is air, a listed one that is missing or unreadable is damaged (409 `region_damaged`
  on the route, chunks reported damaged, edits refused), and a file becoming all air is deleted only after the
  manifest stops listing it (§3.2). Tested through the real route.
- **G9 — fixed origin snap. Closed in 45.7d.** `FloatingOrigin` takes the grid and snaps to its chunk edge
  (`ORIGIN_SNAP_CELLS` is gone, §3.6).
- **G10 — tree-node flags not built. Closed in 45.7d.** `ChunkTreeFlags` keeps solid/empty/mixed flags for every
  chunk-tree node from the chunks' derived occupancy, ancestors marked stale on change and refreshed lowest first
  before any read (§3.7).

Also closed in 45.7d: an undo answer names the box of the edit it takes back, so a client derives again only the
chunks within the rules' radius of it (1–4 in the slice) instead of 27 around each changed chunk (§3.3).

### Changed after the independent review (45.8a)

The review (H1–H3, M2, L3–L5) found these; the bytes of version 1 changed in place, since v1 is an unapproved
draft (no version number moved).
- **H1 — saves keep the player's cells.** Before, an entry was a cell delta or the whole chunk now, whichever was
  smaller, and a whole-chunk entry kept on a re-exported base overwrote cells the player never touched. Now every
  whole-chunk payload starts with a changed-cell mask, and `save` on a changed base writes only the player's cells
  (§3.5). Bytes: image, uniform and air payloads grow by the mask (4,096 B at 32³ before compression).
- **H2 — the base hash does not depend on the codec version.** It covers the base form, frozen as codec v1's
  canonical bytes of the content (§3.5). Today's hashes are unchanged (they already were of v1 bytes).
- **H3 — record value forms.** The region file's byte 10, the undo record's byte 7 and the overrides' byte 6
  (reserved before) and the save's byte 8 name the record value form (§2.2). The save header grew from 40 to 44
  bytes (the world id moved to offset 12); the others cost nothing. Every region file's bytes changed (byte 10).
- **M2 — every world reader names the tile and takes the manifest's list.** `expect` is required by the region
  readers; `RegionWorld.open` and `ShippedWorld` take the manifest's region list; the shipped world a save is made
  against throws for a listed region that is missing or of another world instead of reading air (§3.2).
- **L3** stored values are checked in region tables, saves, cell deltas and overrides (§2.2). **L5** overrides
  have an upgrade registry (§3.5). **L4** `record.ts` says what is still provisional: category set and orientation
  meaning, not the widths.

### Changed after the independent review (45.8b)

The review's M3–M7, L1, L2, L6 and L8 (no byte of any format changed; the staging slice world stands):
- **M3 — one command's work is bounded by a memory budget.** Refused as `over_budget` before any cell is visited
  when its worst-case undo record could pass `UNDO_MEMORY_BUDGET_BYTES` (§3.3 work bound). Tested on the real
  command route: a world-sized fill and a 2 km sphere are refused at once; normal strokes are unaffected.
- **M4 — open worlds do not go stale.** File stamps are checked before every command and read; files changed by
  someone else make the backend read the world again, and the command meeting the change is refused with
  `world_changed`; released, taken-over and unregistered projects' worlds are closed (§3.2 manifest). Tested by
  writing region files and the manifest behind a running backend (a checkout): no restart needed.
- **M5 — a failed write leaves files, memory and history consistent.** Region files and the manifest are one staged
  write; a failed undo is re-applied as an edit; a rename failing midway is reported precisely (§3.2). Tested with
  write, rename and foreign-change failures injected at one step.
- **M6 — rule radius conformance** for every rule set (§3.7), and a stronger Q-a check: one arrangement reached by
  different commands in another order (fills, brush, set, dig and paint across both chunk faces) gives equal
  derived results and byte-identical region files.
- **M7 — dependencies across grids** are recorded as an open contract gap with the planned design (§3.6), not
  built (default chosen, owner to confirm).
- **L8** the undo budget is per open world (§3.4).

### Changed after the owner's review (45.10a, owner 2026-11-02)

The owner approved the replacements and the defaults and changed the voxel record. The bytes of every format holding
voxel values changed, and their versions moved (§3.8); v1 was an unapproved draft, its bytes are refused and the
staging slice world was written again.
- **Value v2 (§2.2).** One u32: material 12, role 4, shape 4 (16 fill levels), wetness 3, 9 reserved. The shape
  inside the value replaces the density byte of surface voxels: no density flags, density lists, density bytes in
  the codec, shape bytes beside aprons, cell deltas (7 → 6 B a cell) or overrides (12 → 10 B a cell). Orientation is
  dropped. The role (air, terrain, liquid, wall, floor, roof, foundation, stair, pillar, opening) replaces the
  category; the placeholder rules v2 read it and the 45.7/45.9 proof holds.
- **Feeds and saved-fields masks (§2.2, §2.3).** Shape and role feed mesh, collision, nav and light occupancy;
  material and wetness the shader data only (with the material-slot caveat until 45.10b). Saves keep the fields the
  game marks saved (default all but wetness) merged onto the base; the runtime overlay holds changes as whole values.
- **Shader data (§3.7)** is a derived output: the per-chunk material and wetness grid.
- **Climate (§2.4)** is specified as a coarse per-region field outside the voxel value; not built.

### Changed after the owner's review (45.10b, owner 2026-11-02: blending in the shader)

- **Mesh format v2 (§3.7).** Surface vertices are 12 bytes (position, normal); v1's four material slots and weights
  are gone, with the result's material table and the material slots of detail instances (now a reserved u16) and
  collision boxes. Derived data 2 → 3. A material change feeds the shader data alone, as the feeds table says:
  `MATERIAL_SLOT_PARTS` and `stalePartsOf` are gone, `fieldsFeed` is the rule.
- **Shader data (§3.7)** covers the chunk and a 1-cell border of its neighbours (34³), so blends cross chunk faces;
  a material or wetness change re-derives the shader data of the chunks within that border (an apron 1 deep, §3.6).
- **Surface shader (§3.7)**: dense 34³ `rg8unorm` regions of one GPU-only 3D texture; 8-corner blend over a set
  distance, the two heaviest materials, wetness darkening; triplanar; 16 reads a pixel; both renderers.
- **Accepted:** R18 → packing + zstd, R50 → stacked 256 m cubes, R79 → per-consumer outputs from one assembly
  evaluation, R66 → fewer, wider range reads + prefetch (D432 stays open for 46a's tuning); the game decides how a
  re-exported base affects saves (H1/H2 as built); the world layout and scale, the editing rules and the remaining
  §5 defaults. M7, D433 and D434 stay later work.

### Changed after the owner's review (45.10c, owner 2026-11-02: remesh within a frame)

- **Derive sections (§3.6).** The derive job may name sections (8, 16 or 32 cells) of its chunk and returns one
  result each, positions relative to the section's corner, shader data over the section and its border (side
  S + 2). Staleness is per section. No stored byte changed: sections are derived data, never saved.
- **Atomic swap (§3.6).** One group per edit or refresh; results held until the whole group has them, then one
  `swap`; an edit meeting an open group merges into it; reads see the edit at once.
- **Requirements R107–R110** (remesh within a frame, terrain mesher, dynamic LOD, lighting performance first) and
  the renumbered sub-phases: 46b terrain mesher and LOD, 46c kits and cases, 46d rendering and materials, 46e
  lighting, culling and navigation.
